// Operaciones de máquinas virtuales: energía, tamaño, puertos y vista de instancia.
import type { CloudState, FsDir, PrincipalRef, Resource } from '../types';
import { sendEmail } from './monitor';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, checkLocks, createImmediate, findResource, logActivity, notFound, provisionDelay } from '../arm';
import { findVmSize } from '../catalog';
import { ciEq, guid, nowIso, sleep } from '../util';
import { vmNic, vmPowerState, powerStateCode } from '../providers/compute';
import { normalizeSecurityRule, validateRuleSet } from '../providers/network';

export type PowerAction = 'start' | 'stop' | 'deallocate' | 'restart';

const ACTIONS: Record<PowerAction, { action: string; during: string; final: string; label: string; ms: number }> = {
  start: { action: 'start/action', during: 'starting', final: 'running', label: 'Iniciar máquina virtual', ms: 2500 },
  stop: { action: 'powerOff/action', during: 'stopping', final: 'stopped', label: 'Apagar máquina virtual', ms: 2000 },
  deallocate: { action: 'deallocate/action', during: 'deallocating', final: 'deallocated', label: 'Desasignar máquina virtual', ms: 3000 },
  restart: { action: 'restart/action', during: 'restarting', final: 'running', label: 'Reiniciar máquina virtual', ms: 2500 },
};

export function getVm(id: string): Resource {
  const vm = findResource(id);
  if (!vm || !ciEq(vm.type, 'Microsoft.Compute/virtualMachines')) throw notFound(id);
  return vm;
}

export async function vmPower(id: string, op: PowerAction, opts: { principal: PrincipalRef | null; noWait?: boolean }): Promise<void> {
  const s = getState();
  const vm = getVm(id);
  const def = ACTIONS[op];
  authorize(opts.principal, `Microsoft.Compute/virtualMachines/${def.action}`, vm.id);
  checkLocks(vm.id, 'write', s);
  const current = vmPowerState(vm);
  if (vm.properties.provisioningState !== 'Succeeded') {
    throw new ArmError('OperationNotAllowed', `Operation '${op}' is not allowed on VM '${vm.name}' since the VM is in provisioning state '${vm.properties.provisioningState}'.`, 409);
  }
  if (op === 'restart' && current !== 'running') {
    throw new ArmError('OperationNotAllowed', `Operation 'restart' is not allowed on VM '${vm.name}' since the VM is not running. Please start the VM first.`, 409);
  }
  if ((op === 'start' && current === 'running') || (op === 'stop' && current === 'stopped') || (op === 'deallocate' && current === 'deallocated')) return;
  const corr = guid();
  vm.data!.powerState = def.during;
  logActivity({ operationNameValue: `Microsoft.Compute/virtualMachines/${def.action}`, operationName: def.label, status: 'Started', resourceId: vm.id, subscriptionId: vm.subscriptionId, caller: opts.principal?.name, correlationId: corr });
  changed();
  const finish = () => {
    const cur = findResource(id);
    if (!cur) return;
    cur.data!.powerState = def.final;
    cur.data!.powerLog = [...(cur.data!.powerLog ?? []), { t: Date.now(), state: def.final }].slice(-60);
    if (def.final === 'running') {
      cur.data!.bootTime = nowIso();
      cur.data!.stressUntil = 0;
    }
    logActivity({ operationNameValue: `Microsoft.Compute/virtualMachines/${def.action}`, operationName: def.label, status: 'Succeeded', resourceId: vm.id, subscriptionId: vm.subscriptionId, caller: opts.principal?.name, correlationId: corr });
    changed();
  };
  const delay = provisionDelay(def.ms);
  if (opts.noWait) {
    setTimeout(finish, delay);
    return;
  }
  await sleep(delay);
  finish();
}

/**
 * Apagado automático diario (Microsoft.DevTestLab/schedules): a la hora programada (UTC) desasigna la VM si está en
 * ejecución. Como el programador real, no recupera ejecuciones perdidas: sólo actúa en los 10 minutos posteriores.
 */
export function enforceAutoShutdown(s: CloudState = getState(), now = new Date()) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = now.toISOString().slice(0, 10);
  for (const vm of s.resources) {
    const cfg = vm.data?.autoShutdown;
    if (!cfg?.time || !ciEq(vm.type, 'Microsoft.Compute/virtualMachines') || cfg.lastRun === today) continue;
    const at = Number(String(cfg.time).slice(0, 2)) * 60 + Number(String(cfg.time).slice(2));
    if (mins < at || mins - at >= 10) continue;
    cfg.lastRun = today;
    if (vmPowerState(vm) === 'running') {
      vm.data!.powerState = 'deallocated';
      vm.data!.powerLog = [...(vm.data!.powerLog ?? []), { t: Date.now(), state: 'deallocated' }].slice(-60);
      logActivity({ operationNameValue: 'Microsoft.Compute/virtualMachines/deallocate/action', operationName: 'Desasignar máquina virtual (apagado automático)', status: 'Succeeded', resourceId: vm.id, subscriptionId: vm.subscriptionId, caller: 'Microsoft.DevTestLab/schedules', correlationId: guid() });
      if (cfg.email) sendEmail(cfg.email, `Apagado automático de ${vm.name}`, `La máquina virtual ${vm.name} (grupo ${vm.resourceGroup}) se ha desasignado a las ${String(cfg.time).slice(0, 2)}:${String(cfg.time).slice(2)} UTC según su programación de apagado automático.\n\nMientras esté desasignada no genera coste de proceso. Para volver a usarla: az vm start -g ${vm.resourceGroup} -n ${vm.name}`);
    }
    changed();
  }
}

export async function resizeVm(id: string, size: string, principal: PrincipalRef | null): Promise<Resource> {
  const s = getState();
  const vm = getVm(id);
  const info = findVmSize(size);
  if (!info) throw new ArmError('InvalidParameter', `The value ${size} provided for the VM size is not valid.`);
  authorize(principal, 'Microsoft.Compute/virtualMachines/write', vm.id);
  checkLocks(vm.id, 'write', s);
  const { evaluatePolicies, findRg } = await import('../arm');
  const rg = findRg(vm.subscriptionId, vm.resourceGroup, s);
  const ev = evaluatePolicies({ kind: 'resource', id: vm.id, name: vm.name, type: vm.type, location: vm.location, tags: vm.tags, properties: { hardwareProfile: { vmSize: info.name } }, rgTags: rg?.tags }, s);
  if (ev.deny) {
    throw new ArmError('RequestDisallowedByPolicy', `Resource '${vm.name}' was disallowed by policy. Policy identifiers: '[{"policyAssignment":{"name":"${ev.deny.assignmentName}"},"policyDefinition":{"name":"${ev.deny.def.displayName}"}}]'.`, 403);
  }
  const wasRunning = vmPowerState(vm) === 'running';
  vm.properties.hardwareProfile.vmSize = info.name;
  if (wasRunning) vm.data!.powerState = 'restarting';
  logActivity({ operationNameValue: 'Microsoft.Compute/virtualMachines/write', operationName: `Cambiar tamaño a ${info.name}`, status: 'Succeeded', resourceId: vm.id, subscriptionId: vm.subscriptionId, caller: principal?.name });
  changed();
  if (wasRunning) {
    await sleep(provisionDelay(2500));
    vm.data!.powerState = 'running';
    vm.data!.bootTime = nowIso();
    changed();
  }
  return vm;
}

/** Abre un puerto en el NSG de la NIC de la VM (crea el NSG si no existe), como "az vm open-port". */
export function openPort(id: string, port: string, priority: number, principal: PrincipalRef | null): Resource {
  const s = getState();
  const vm = getVm(id);
  const nic = vmNic(vm, s);
  if (!nic) throw new ArmError('NotFound', 'The VM has no network interface.', 404);
  let nsg = nic.properties.networkSecurityGroup?.id ? findResource(nic.properties.networkSecurityGroup.id) : undefined;
  authorize(principal, 'Microsoft.Network/networkSecurityGroups/write', nsg?.id ?? `/subscriptions/${vm.subscriptionId}/resourceGroups/${vm.resourceGroup}`);
  if (!nsg) {
    nsg = createImmediate({ type: 'Microsoft.Network/networkSecurityGroups', name: `${vm.name}NSG`, location: vm.location, properties: { securityRules: [] } }, vm.resourceGroup, vm.subscriptionId, principal ?? undefined);
    nic.properties.networkSecurityGroup = { id: nsg.id };
  }
  checkLocks(nsg.id, 'write', s);
  const ruleName = port === '*' ? 'open-port-all' : `open-port-${port.replace(/,/g, '_')}`;
  const rules = (nsg.properties.securityRules ?? []).filter((r: any) => r.name !== ruleName);
  const rule = normalizeSecurityRule(nsg.id, { name: ruleName, properties: { priority, direction: 'Inbound', access: 'Allow', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRanges: port.split(',') } });
  const next = [...rules, rule];
  validateRuleSet(next);
  nsg.properties.securityRules = next;
  logActivity({ operationNameValue: 'Microsoft.Network/networkSecurityGroups/securityRules/write', operationName: `Crear regla de seguridad ${ruleName}`, status: 'Succeeded', resourceId: `${nsg.id}/securityRules/${ruleName}`, subscriptionId: vm.subscriptionId, caller: principal?.name });
  changed();
  return nsg;
}

export function instanceView(vm: Resource) {
  const ps = vmPowerState(vm);
  return {
    bootDiagnostics: null,
    computerName: vm.properties.osProfile?.computerName,
    disks: [{ name: vm.properties.storageProfile?.osDisk?.name, statuses: [{ code: 'ProvisioningState/succeeded', displayStatus: 'Provisioning succeeded', level: 'Info', time: vm.properties.timeCreated }] }],
    hyperVGeneration: 'V2',
    osName: vm.data?.osType === 'Linux' ? 'ubuntu' : 'Windows Server 2022 Datacenter',
    osVersion: vm.data?.osType === 'Linux' ? '22.04' : '10.0.20348',
    statuses: [
      { code: `ProvisioningState/${String(vm.properties.provisioningState).toLowerCase()}`, displayStatus: 'Provisioning succeeded', level: 'Info', time: vm.properties.timeCreated },
      { code: `PowerState/${ps}`, displayStatus: powerStateCode(ps), level: 'Info' },
    ],
    vmAgent: { vmAgentVersion: '2.11.1.12', statuses: [{ code: 'ProvisioningState/succeeded', displayStatus: ps === 'running' ? 'Ready' : 'Not Ready', level: 'Info', message: 'Guest Agent is running' }] },
  };
}

/** Sistema de ficheros del SO invitado (inicialización perezosa). */
export function guestFs(vm: Resource): FsDir {
  if (!vm.data) vm.data = {};
  if (!vm.data.fs) {
    const user = vm.properties.osProfile?.adminUsername ?? 'azureuser';
    const now = Date.now();
    const dir = (c: Record<string, any> = {}): FsDir => ({ t: 'd', c, mt: now });
    const file = (d: string) => ({ t: 'f' as const, d, mt: now });
    const image = vm.data.image;
    vm.data.fs = dir({
      home: dir({ [user]: dir({ '.bashrc': file('# ~/.bashrc\nexport PS1="\\u@\\h:\\w\\$ "\n') }) }),
      etc: dir({
        'os-release': file(`PRETTY_NAME="${image?.distro ?? 'Ubuntu 22.04.5 LTS'}"\nNAME="${(image?.distro ?? 'Ubuntu').split(' ')[0]}"\nVERSION_ID="${(image?.distro ?? '22.04').match(/\d+(\.\d+)?/)?.[0] ?? '22.04'}"\nID=${(image?.distro ?? 'ubuntu').split(' ')[0].toLowerCase()}\n`),
        hostname: file(`${vm.properties.osProfile?.computerName ?? vm.name}\n`),
      }),
      var: dir({ log: dir({ syslog: file('') }), www: dir() }),
      tmp: dir(),
      opt: dir(),
    });
  }
  return vm.data.fs as FsDir;
}

export function vmCpuStress(vm: Resource, seconds: number) {
  const from = Date.now();
  vm.data!.stressUntil = from + seconds * 1000;
  vm.data!.stressLog = [...(vm.data!.stressLog ?? []), { from, to: from + seconds * 1000 }].slice(-20);
  changed();
}
