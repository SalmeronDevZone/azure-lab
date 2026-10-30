// az vm / disk.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { authorize, createImmediate, deleteResource, findResource, patchResource, putResource } from '../../../engine/arm';
import { resourceId } from '../../../engine/ids';
import { VM_IMAGES, VM_SIZES, findVmImage, findVmSize, findLocation } from '../../../engine/catalog';
import { ciEq, guid, nowIso, shortHash } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { vmNetworkInfo, vmPowerState, powerStateCode, vmNic } from '../../../engine/providers/compute';
import { instanceView, openPort, resizeVm, vmPower, type PowerAction } from '../../../engine/services/compute';
import { runInGuest } from '../../vmHost';
import { resolveIdentity } from '../../../engine/providers/identity';
import { createRoleAssignment } from '../../../engine/services/identity';

const T_VM = 'Microsoft.Compute/virtualMachines';
const T_DISK = 'Microsoft.Compute/disks';

group('vm', 'Administra máquinas virtuales Linux o Windows.');
group('vm run-command', 'Ejecuta scripts dentro de la VM sin necesidad de SSH.');
group('vm extension', 'Administra extensiones de VM.');
group('vm image', 'Información sobre imágenes de VM.');
group('vm identity', 'Administra la identidad administrada de la VM.');
group('vm disk', 'Administra los discos de datos de la VM.');
group('vm user', 'Administra usuarios de la VM.');
group('disk', 'Administra discos administrados.');

function vmSummary(vm: any) {
  const s = getState();
  const n = vmNetworkInfo(vm, s);
  return {
    fqdns: n.fqdn ?? '',
    id: vm.id,
    location: vm.location,
    macAddress: vmNic(vm, s)?.properties.macAddress ?? '',
    powerState: powerStateCode(vmPowerState(vm)),
    privateIpAddress: n.privateIp ?? '',
    publicIpAddress: n.publicIp ?? '',
    resourceGroup: vm.resourceGroup,
    zones: (vm.zones ?? []).join(','),
  };
}

function vmDetails(vm: any) {
  const s = getState();
  const n = vmNetworkInfo(vm, s);
  return flat(vm, { powerState: powerStateCode(vmPowerState(vm)), publicIps: n.publicIp ?? '', privateIps: n.privateIp ?? '', fqdns: n.fqdn ?? '', macAddresses: vmNic(vm, s)?.properties.macAddress ?? '' });
}

const vmTable = (r: any) =>
  (Array.isArray(r) ? r : [r]).map((v: any) => {
    const row: any = { Name: v.name, ResourceGroup: v.resourceGroup };
    if (v.powerState !== undefined) {
      row.PowerState = v.powerState;
      row.PublicIps = v.publicIps;
      row.Fqdns = v.fqdns;
    }
    row.Location = v.location;
    row.Zones = (v.zones ?? []).join(',');
    return row;
  });

function sshPubKey(ctx: AzCtx, generate: boolean, explicit?: string[]): string | null {
  if (explicit?.length) {
    const v = explicit[0];
    if (v.startsWith('ssh-')) return v;
    try {
      return ctx.sess.fs.readFile(ctx.sess.resolve(v)).trim();
    } catch {
      throw cliError(`An RSA key file or key value must be supplied to SSH Key Value. ${v} no existe.`);
    }
  }
  const pubPath = `${ctx.sess.home}/.ssh/id_rsa.pub`;
  if (ctx.sess.fs.isFile(pubPath)) return ctx.sess.fs.readFile(pubPath).trim();
  if (!generate) return null;
  ctx.sess.fs.mkdir(`${ctx.sess.home}/.ssh`, true);
  const material = shortHash(guid() + Date.now(), 372);
  const pub = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ${btoa(material).slice(0, 360)} ${ctx.sess.user}@cc-${shortHash(ctx.sess.user, 8)}`;
  ctx.sess.fs.writeFile(`${ctx.sess.home}/.ssh/id_rsa`, `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(material + 'private').match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`);
  ctx.sess.fs.writeFile(pubPath, pub + '\n');
  ctx.io.err(`SSH key files '${ctx.sess.home}/.ssh/id_rsa' and '${ctx.sess.home}/.ssh/id_rsa.pub' have been generated under ~/.ssh to allow SSH access to the VM. If using machines without permanent storage, back up your keys to a safe location.\n`);
  return pub;
}

register({
  path: 'vm create',
  summary: 'Crea una máquina virtual (y, si hace falta, su red, NSG, IP pública e interfaz de red).',
  args: [
    A.rg(),
    A.name('Nombre de la máquina virtual.'),
    { name: 'image', opts: ['--image'], help: `Imagen: alias (${VM_IMAGES.map((i) => i.alias).join(', ')}) o URN publicador:oferta:sku:versión.` },
    { name: 'size', opts: ['--size'], help: 'Tamaño de la VM. Ver `az vm list-sizes -l <region>`.', default: 'Standard_DS1_v2' },
    A.location(),
    { name: 'admin_username', opts: ['--admin-username'], help: 'Usuario administrador.' },
    { name: 'admin_password', opts: ['--admin-password'], help: 'Contraseña (obligatoria en Windows o con --authentication-type password).' },
    { name: 'authentication_type', opts: ['--authentication-type'], help: 'Tipo de autenticación.', choices: ['ssh', 'password', 'all'] },
    { name: 'generate_ssh_keys', opts: ['--generate-ssh-keys'], help: 'Genera claves SSH en ~/.ssh si no existen.', type: 'bool' },
    { name: 'ssh_key_values', opts: ['--ssh-key-values', '--ssh-key-value'], help: 'Claves públicas SSH o rutas a ficheros.', type: 'list' },
    { name: 'vnet_name', opts: ['--vnet-name'], help: 'Nombre de la red virtual (se crea si no existe).' },
    { name: 'subnet', opts: ['--subnet'], help: 'Nombre o ID de la subred.' },
    { name: 'vnet_address_prefix', opts: ['--vnet-address-prefix'], help: 'Prefijo de la red nueva.', default: '10.0.0.0/16' },
    { name: 'subnet_address_prefix', opts: ['--subnet-address-prefix'], help: 'Prefijo de la subred nueva.', default: '10.0.0.0/24' },
    { name: 'nsg', opts: ['--nsg'], help: 'Nombre o ID del NSG ("" para no usar ninguno).' },
    { name: 'nsg_rule', opts: ['--nsg-rule'], help: 'Regla de entrada por defecto del NSG nuevo.', choices: ['SSH', 'RDP', 'NONE'] },
    { name: 'public_ip_address', opts: ['--public-ip-address'], help: 'Nombre de la IP pública ("" para no crear ninguna).' },
    { name: 'public_ip_sku', opts: ['--public-ip-sku'], help: 'SKU de la IP pública.', choices: ['Basic', 'Standard'], default: 'Standard' },
    { name: 'public_ip_dns', opts: ['--public-ip-address-dns-name'], help: 'Etiqueta DNS de la IP pública.' },
    { name: 'nics', opts: ['--nics'], help: 'NICs existentes (nombres o IDs).', type: 'list' },
    { name: 'storage_sku', opts: ['--storage-sku'], help: 'SKU del disco del SO.', choices: ['Standard_LRS', 'StandardSSD_LRS', 'Premium_LRS', 'Premium_ZRS', 'StandardSSD_ZRS'] },
    { name: 'os_disk_size_gb', opts: ['--os-disk-size-gb'], help: 'Tamaño del disco del SO.', type: 'int' },
    { name: 'os_disk_delete_option', opts: ['--os-disk-delete-option'], help: 'Qué hacer con el disco al eliminar la VM.', choices: ['Delete', 'Detach'] },
    { name: 'zone', opts: ['--zone', '-z'], help: 'Zona de disponibilidad.' },
    { name: 'assign_identity', opts: ['--assign-identity'], help: 'Asigna la identidad administrada del sistema ([system]).', type: 'list' },
    { name: 'role', opts: ['--role'], help: 'Rol para la identidad (con --scope).' },
    { name: 'scope', opts: ['--scope'], help: 'Ámbito del rol de la identidad.' },
    { name: 'custom_data', opts: ['--custom-data'], help: 'Script de cloud-init (ruta o texto).' },
    { name: 'priority', opts: ['--priority'], help: 'Prioridad.', choices: ['Regular', 'Low', 'Spot'] },
    { name: 'security_type', opts: ['--security-type'], help: 'Tipo de seguridad.', choices: ['TrustedLaunch', 'Standard', 'ConfidentialVM'] },
    A.tags(),
    A.noWait(),
  ],
  examples: [
    { title: 'VM Ubuntu con claves SSH.', cmd: 'az vm create -g rg-lab -n vm-web --image Ubuntu2204 --size Standard_B1s --admin-username azureuser --generate-ssh-keys' },
    { title: 'VM en una subred existente y sin IP pública.', cmd: 'az vm create -g rg-lab -n vm-app --image Ubuntu2404 --vnet-name vnet-lab --subnet snet-app --public-ip-address "" --generate-ssh-keys' },
    { title: 'VM Windows.', cmd: 'az vm create -g rg-lab -n vmwin --image Win2022Datacenter --admin-username azureuser --admin-password "P@ssw0rd-Lab2026!"' },
  ],
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    if (!a.image) throw cliError('usage error: --image IMAGE | --attach-os-disk DISK', undefined, true);
    const image = findVmImage(a.image);
    if (!image) {
      throw cliError(`Invalid image "${a.image}". Use a valid image URN, custom image name, custom image id, VHD blob URI, or pick an image from [${VM_IMAGES.map((i) => `'${i.alias}'`).join(', ')}].\nSee vm create -h for more information on specifying an image.`, 'El alias antiguo "UbuntuLTS" ya no existe: usa Ubuntu2204 o Ubuntu2404.');
    }
    const size = findVmSize(a.size);
    if (!size) throw new ArmError('InvalidParameter', `The value ${a.size} provided for the VM size is not valid. The valid sizes in the current region are: ${VM_SIZES.map((x) => x.name).join(',')}.`);
    const location = findLocation(a.location ?? rg.location)?.name ?? rg.location;
    const user = a.admin_username ?? ctx.sess.user;
    const windows = image.os === 'Windows';
    let authType = a.authentication_type ?? (windows ? 'password' : a.admin_password ? 'password' : 'ssh');
    if (windows && authType === 'ssh') throw cliError('SSH not supported for Windows VMs.');
    let password = a.admin_password;
    if ((authType === 'password' || authType === 'all') && !password) {
      if (!ctx.io.prompt || !ctx.io.isTTY) throw cliError('Please specify password in non-interactive mode.');
      password = await ctx.io.prompt('Admin Password: ', { secret: true });
      const confirm = await ctx.io.prompt('Confirm Admin Password: ', { secret: true });
      if (password !== confirm) throw cliError('Passwords do not match.');
    }
    let pub: string | null = null;
    if (!windows && (authType === 'ssh' || authType === 'all')) {
      pub = sshPubKey(ctx, !!a.generate_ssh_keys, a.ssh_key_values);
      if (!pub) throw cliError("An RSA key file or key value must be supplied to SSH Key Value. You can use --generate-ssh-keys to let CLI generate one for you", 'Añade --generate-ssh-keys (creará ~/.ssh/id_rsa) o usa --admin-password con --authentication-type password.');
    }
    if (a.public_ip_sku === 'Basic') throw new ArmError('BasicSkuPublicIpRetired', 'Basic SKU public IP addresses were retired on September 30, 2025. Use --public-ip-sku Standard.', 400);
    const o = { ...op(ctx), noWait: false };
    let nicIds: string[];
    if (a.nics?.length) {
      nicIds = (a.nics as string[]).map((n) => (n.startsWith('/') ? n : resourceId(ctx.subscriptionId, rg.name, 'Microsoft.Network/networkInterfaces', n)));
      for (const id of nicIds) if (!findResource(id)) throw new ArmError('NotFound', `Network interface '${id}' not found.`, 404);
    } else {
      // Red y subred
      let subnetId: string;
      if (a.subnet && String(a.subnet).startsWith('/')) subnetId = a.subnet;
      else {
        const vnetName = a.vnet_name ?? `${a.name}VNET`;
        const subnetName = a.subnet ?? `${a.name}Subnet`;
        const vnetId = resourceId(ctx.subscriptionId, rg.name, 'Microsoft.Network/virtualNetworks', vnetName);
        const vnet = findResource(vnetId);
        if (!vnet) {
          await putResource({ type: 'Microsoft.Network/virtualNetworks', name: vnetName, location, tags: a.tags, properties: { addressSpace: { addressPrefixes: [a.vnet_address_prefix] }, subnets: [{ name: subnetName, properties: { addressPrefix: a.subnet_address_prefix } }] } }, rg.name, o);
        } else if (!(vnet.properties.subnets ?? []).some((s: any) => ciEq(s.name, subnetName))) {
          const { upsertSubnet } = await import('../../../engine/services/networkOps');
          upsertSubnet(vnet.id, { name: subnetName, addressPrefix: a.subnet_address_prefix }, ctx.principal);
        }
        subnetId = `${vnetId}/subnets/${subnetName}`;
      }
      // NSG
      let nsgId: string | undefined;
      const tasks: Promise<any>[] = [];
      if (a.nsg !== '') {
        if (a.nsg && String(a.nsg).startsWith('/')) nsgId = a.nsg;
        else {
          const nsgName = a.nsg ?? `${a.name}NSG`;
          nsgId = resourceId(ctx.subscriptionId, rg.name, 'Microsoft.Network/networkSecurityGroups', nsgName);
          if (!findResource(nsgId)) {
            const ruleKind = a.nsg_rule ?? (windows ? 'RDP' : 'SSH');
            const rules = ruleKind === 'NONE' ? [] : [{ name: ruleKind === 'RDP' ? 'rdp' : 'default-allow-ssh', properties: { priority: 1000, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: ruleKind === 'RDP' ? '3389' : '22' } }];
            tasks.push(putResource({ type: 'Microsoft.Network/networkSecurityGroups', name: nsgName, location, tags: a.tags, properties: { securityRules: rules } }, rg.name, o));
          }
        }
      }
      let pipId: string | undefined;
      if (a.public_ip_address !== '') {
        const pipName = a.public_ip_address ?? `${a.name}PublicIP`;
        pipId = resourceId(ctx.subscriptionId, rg.name, 'Microsoft.Network/publicIPAddresses', pipName);
        if (!findResource(pipId)) tasks.push(putResource({ type: 'Microsoft.Network/publicIPAddresses', name: pipName, location, tags: a.tags, sku: { name: 'Standard' }, zones: a.zone ? [a.zone] : undefined, properties: { publicIPAllocationMethod: 'Static', dnsSettings: a.public_ip_dns ? { domainNameLabel: a.public_ip_dns } : undefined } }, rg.name, o));
      }
      await Promise.all(tasks);
      const nic = await putResource({ type: 'Microsoft.Network/networkInterfaces', name: `${a.name}VMNic`, location, tags: a.tags, properties: { ipConfigurations: [{ name: `ipconfig${a.name}`, properties: { subnet: { id: subnetId }, publicIPAddress: pipId ? { id: pipId } : undefined } }], networkSecurityGroup: nsgId ? { id: nsgId } : undefined } }, rg.name, o);
      nicIds = [nic.id];
    }
    let customData = a.custom_data;
    if (customData && !customData.includes('\n')) {
      try {
        customData = ctx.sess.fs.readFile(ctx.sess.resolve(customData));
      } catch {
        /* texto literal */
      }
    }
    const vm = await putResource(
      {
        type: T_VM,
        name: a.name,
        location,
        tags: a.tags,
        zones: a.zone ? [a.zone] : undefined,
        identity: a.assign_identity ? { type: 'SystemAssigned' } : undefined,
        properties: {
          hardwareProfile: { vmSize: size.name },
          storageProfile: { imageReference: { publisher: image.publisher, offer: image.offer, sku: image.sku, version: 'latest' }, osDisk: { managedDisk: { storageAccountType: a.storage_sku }, diskSizeGB: a.os_disk_size_gb, deleteOption: a.os_disk_delete_option ?? 'Delete' } },
          osProfile: { adminUsername: user, adminPassword: password, computerName: a.name, linuxConfiguration: windows ? undefined : { disablePasswordAuthentication: authType === 'ssh', ssh: pub ? { publicKeys: [{ path: `/home/${user}/.ssh/authorized_keys`, keyData: pub }] } : undefined } },
          networkProfile: { networkInterfaces: nicIds.map((id) => ({ id })) },
          priority: a.priority,
          securityProfile: a.security_type === 'Standard' ? {} : undefined,
        },
      },
      rg.name,
      { ...op(ctx, a) },
    );
    if (vm.identity && !vm.identity.principalId) vm.identity = resolveIdentity(getState(), { type: 'SystemAssigned' }, undefined, vm.name, vm.id);
    if (a.assign_identity && a.role && a.scope && vm.identity?.principalId) createRoleAssignment({ assignee: vm.identity.principalId, role: a.role, scope: a.scope }, ctx.principal);
    if (customData) {
      vm.data!.cloudInit = customData;
      const script = customData.replace(/^#cloud-config[\s\S]*?runcmd:\s*\n/m, '').split('\n').map((l: string) => l.replace(/^\s*-\s*/, '')).join('\n');
      runInGuest(vm, script.startsWith('#!') ? script : customData.startsWith('#!') ? customData : script, true).catch(() => undefined);
    }
    if (a.no_wait) return undefined;
    return vmSummary(vm);
  },
});

register({
  path: 'vm list',
  summary: 'Lista las máquinas virtuales.',
  args: [A.rg(false), { name: 'show_details', opts: ['--show-details', '-d'], help: 'Incluye estado de energía, IPs y FQDN (más lento).', type: 'bool' }],
  table: vmTable,
  run: (a, ctx) => listInSub(ctx, T_VM, a.resource_group).map((v) => (a.show_details ? vmDetails(v) : flat(v))),
});

register({
  path: 'vm show',
  summary: 'Obtiene los detalles de una VM.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), { name: 'show_details', opts: ['--show-details', '-d'], help: 'Incluye estado de energía e IPs.', type: 'bool' }],
  table: vmTable,
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    return a.show_details ? vmDetails(vm) : flat(vm);
  },
});

function powerCmd(action: PowerAction, summary: string, warn?: string) {
  register({
    path: `vm ${action}`,
    summary,
    args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), A.noWait(), ...(action === 'stop' ? [{ name: 'skip_shutdown', opts: ['--skip-shutdown'], help: 'Apaga sin cerrar el SO.', type: 'bool' as const }] : [])],
    longRunning: true,
    async run(a, ctx) {
      const ids = a.ids?.length ? a.ids : [getRes(ctx, a, T_VM).id];
      if (warn) ctx.warn(warn);
      for (const id of ids) await vmPower(id, action, { principal: ctx.principal, noWait: a.no_wait });
      return undefined;
    },
  });
}

powerCmd('start', 'Inicia una VM detenida.');
powerCmd('stop', 'Apaga una VM (sigue facturando el proceso: usa deallocate para dejar de pagar).', 'Being powered off but still billed for compute. Use \'az vm deallocate\' to stop billing. (Una VM detenida pero no desasignada SIGUE facturando el proceso.)');
powerCmd('deallocate', 'Desasigna una VM: libera el hardware y deja de facturar el proceso.');
powerCmd('restart', 'Reinicia una VM.');

register({
  path: 'vm delete',
  summary: 'Elimina una VM (la NIC, la IP pública, el NSG y la red NO se eliminan).',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), A.yes(), A.noWait(), { name: 'force_deletion', opts: ['--force-deletion'], help: 'Forzar.', type: 'bool' }],
  confirm: 'Are you sure you want to perform this operation?',
  longRunning: true,
  async run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    await deleteResource(vm.id, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'vm resize',
  summary: 'Cambia el tamaño de una VM (se reinicia si está en ejecución).',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), { name: 'size', opts: ['--size'], help: 'Nuevo tamaño.', required: true }, A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    return flat(await resizeVm(vm.id, a.size, ctx.principal));
  },
});

register({
  path: 'vm list-sizes',
  summary: 'Lista los tamaños de VM disponibles en una región.',
  args: [{ ...A.location(true) }],
  table: (r: any[]) => r.map((s) => ({ MaxDataDiskCount: s.maxDataDiskCount, MemoryInMb: s.memoryInMB, Name: s.name, NumberOfCores: s.numberOfCores, OsDiskSizeInMb: s.osDiskSizeInMB, ResourceDiskSizeInMb: s.resourceDiskSizeInMB })),
  run: () => VM_SIZES.map((s) => ({ maxDataDiskCount: s.maxDataDisks, memoryInMB: s.memoryGB * 1024, name: s.name, numberOfCores: s.vCPUs, osDiskSizeInMB: 1047552, resourceDiskSizeInMB: s.vCPUs * 8192 })),
});

register({
  path: 'vm list-skus',
  summary: 'Lista los SKUs de VM (con precios aproximados del simulador).',
  args: [A.location(), { name: 'size', opts: ['--size', '-s'], help: 'Filtra por tamaño.' }],
  table: (r: any[]) => r.map((s) => ({ ResourceType: 'virtualMachines', Locations: s.locations[0], Name: s.name, Zones: '1,2,3', vCPUs: s.vCPUs, MemoryGB: s.memoryGB, PricePerHourUSD: s.pricePerHour })),
  run(a) {
    return VM_SIZES.filter((s) => !a.size || s.name.toLowerCase().includes(String(a.size).toLowerCase())).map((s) => ({ name: s.name, locations: [a.location ?? 'westeurope'], vCPUs: s.vCPUs, memoryGB: s.memoryGB, pricePerHour: s.pricePerHour, family: s.family }));
  },
});

register({
  path: 'vm list-ip-addresses',
  summary: 'Lista las direcciones IP de las VMs.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids()],
  table: (r: any[]) => r.map((x) => ({ VirtualMachine: x.virtualMachine.name, PublicIPAddresses: x.virtualMachine.network.publicIpAddresses.map((p: any) => p.ipAddress).join(','), PrivateIPAddresses: x.virtualMachine.network.privateIpAddresses.join(',') })),
  run(a, ctx) {
    const vms = a.name || a.ids?.length ? [getRes(ctx, a, T_VM)] : listInSub(ctx, T_VM, a.resource_group);
    const s = getState();
    return vms.map((vm) => {
      const n = vmNetworkInfo(vm, s);
      return { virtualMachine: { name: vm.name, network: { privateIpAddresses: n.privateIp ? [n.privateIp] : [], publicIpAddresses: n.pip ? [{ id: n.pip.id, ipAddress: n.publicIp, ipAllocationMethod: 'Static', name: n.pip.name, resourceGroup: n.pip.resourceGroup, zone: null }] : [] }, resourceGroup: vm.resourceGroup } };
    });
  },
});

register({
  path: 'vm open-port',
  summary: 'Abre un puerto de entrada en el NSG de la interfaz de red de la VM.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), { name: 'port', opts: ['--port'], help: 'Puerto o rango (80, 8000-8100, * o lista separada por comas).', required: true }, { name: 'priority', opts: ['--priority'], help: 'Prioridad de la regla.', type: 'int', default: 900 }],
  examples: [{ title: 'Abrir el puerto 80.', cmd: 'az vm open-port -g rg-lab -n vm-web --port 80' }],
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    return flat(openPort(vm.id, String(a.port), a.priority, ctx.principal));
  },
});

register({
  path: 'vm get-instance-view',
  summary: 'Obtiene la vista de instancia (estado de energía, agente...) de una VM.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids()],
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    return { ...flat(vm), instanceView: instanceView(vm) };
  },
});

register({
  path: 'vm run-command invoke',
  summary: 'Ejecuta un script dentro de la VM a través del agente de VM (sin SSH).',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), { name: 'command_id', opts: ['--command-id'], help: 'RunShellScript (Linux) o RunPowerShellScript (Windows).', required: true }, { name: 'scripts', opts: ['--scripts'], help: 'Líneas de script (o @fichero).', type: 'list' }, { name: 'parameters', opts: ['--parameters'], help: 'Parámetros nombre=valor.', type: 'list' }],
  examples: [{ title: 'Instalar nginx en una VM Linux.', cmd: 'az vm run-command invoke -g rg-lab -n vm-web --command-id RunShellScript --scripts "sudo apt-get update && sudo apt-get install -y nginx"' }],
  longRunning: true,
  async run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    authorize(ctx.principal, 'Microsoft.Compute/virtualMachines/runCommand/action', vm.id);
    if (vmPowerState(vm) !== 'running') throw new ArmError('Conflict', `The operation 'RunCommand' is not allowed on VM '${vm.name}' because the VM is not running (estado: ${vmPowerState(vm)}).`, 409);
    let lines: string[] = a.scripts ?? [];
    if (lines.length === 1 && lines[0].startsWith('@')) lines = [ctx.readFileArg(lines[0].slice(1))];
    const script = lines.join('\n');
    const windows = vm.data?.osType === 'Windows';
    if (windows !== (a.command_id === 'RunPowerShellScript')) {
      throw new ArmError('BadRequest', `The command id '${a.command_id}' is not supported for ${windows ? 'Windows' : 'Linux'} VMs. Use ${windows ? 'RunPowerShellScript' : 'RunShellScript'}.`);
    }
    const r = await runInGuest(vm, script, true);
    return { value: [{ code: 'ProvisioningState/succeeded', displayStatus: 'Provisioning succeeded', level: 'Info', message: `Enable succeeded: \n[stdout]\n${r.stdout}\n[stderr]\n${r.stderr}`, time: null }] };
  },
});

register({
  path: 'vm image list',
  summary: 'Lista las imágenes de VM disponibles (alias populares).',
  args: [{ name: 'all', opts: ['--all'], help: 'Lista todas.', type: 'bool' }, { name: 'publisher', opts: ['--publisher', '-p'], help: 'Publicador.' }, { name: 'offer', opts: ['--offer', '-f'], help: 'Oferta.' }, A.location()],
  table: (r: any[]) => r.map((i) => ({ Architecture: i.architecture, Offer: i.offer, Publisher: i.publisher, Sku: i.sku, Urn: i.urn, UrnAlias: i.urnAlias, Version: i.version })),
  run(a) {
    return VM_IMAGES.filter((i) => (!a.publisher || ciEq(i.publisher, a.publisher)) && (!a.offer || i.offer.toLowerCase().includes(String(a.offer).toLowerCase()))).map((i) => ({ architecture: 'x64', offer: i.offer, publisher: i.publisher, sku: i.sku, urn: i.urn, urnAlias: i.alias, version: 'latest' }));
  },
});

register({
  path: 'vm extension set',
  summary: 'Instala o actualiza una extensión de VM (p. ej. CustomScript o el agente de Azure Monitor).',
  args: [A.rg(), { name: 'vm_name', opts: ['--vm-name'], help: 'Nombre de la VM.', required: true }, A.name('Nombre de la extensión (p. ej. CustomScript, AzureMonitorLinuxAgent).'), { name: 'publisher', opts: ['--publisher'], help: 'Publicador (p. ej. Microsoft.Azure.Extensions, Microsoft.Azure.Monitor).', required: true }, { name: 'version', opts: ['--version'], help: 'Versión.' }, { name: 'settings', opts: ['--settings'], help: 'Configuración JSON o @fichero.', type: 'json' }, { name: 'protected_settings', opts: ['--protected-settings'], help: 'Configuración protegida JSON.', type: 'json' }, A.noWait()],
  examples: [{ title: 'Ejecutar un script con CustomScript.', cmd: `az vm extension set -g rg-lab --vm-name vm-web -n CustomScript --publisher Microsoft.Azure.Extensions --settings '{"commandToExecute":"apt-get install -y nginx"}'` }],
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const vm = findResource(resourceId(ctx.subscriptionId, rg.name, T_VM, a.vm_name));
    if (!vm) throw new ArmError('ResourceNotFound', `The Resource 'Microsoft.Compute/virtualMachines/${a.vm_name}' under resource group '${rg.name}' was not found.`, 404);
    const settings = { ...(a.settings ?? {}) };
    const ext = await putResource({ type: 'Microsoft.Compute/virtualMachines/extensions', name: `${vm.name}/${a.name}`, location: vm.location, properties: { publisher: a.publisher, type: a.name, typeHandlerVersion: a.version ?? '2.1', settings } }, rg.name, op(ctx, a));
    const cmd = settings.commandToExecute ?? a.protected_settings?.commandToExecute;
    if (/customscript/i.test(a.name) && cmd) {
      const r = await runInGuest(vm, cmd, true);
      ext.properties.instanceView = { name: a.name, statuses: [{ code: 'ProvisioningState/succeeded', message: `Enable succeeded: \n[stdout]\n${r.stdout}\n[stderr]\n${r.stderr}` }] };
    }
    if (/AzureMonitor|OmsAgent|MicrosoftMonitoringAgent/i.test(a.name)) {
      vm.data!.monitoringSince = Date.now();
      const ws = settings.workspaceId ? getState().resources.find((r) => ciEq(r.type, 'Microsoft.OperationalInsights/workspaces') && (ciEq(r.properties.customerId, settings.workspaceId) || ciEq(r.id, settings.workspaceId))) : undefined;
      if (ws) vm.data!.monitoringWorkspace = ws.id;
      else ctx.warn('El agente está instalado, pero sin "workspaceId" en --settings no enviará datos a ningún área de trabajo (en Azure real se usa una regla de recopilación de datos, DCR).');
    }
    changed();
    return flat(ext);
  },
});

register({
  path: 'vm extension list',
  summary: 'Lista las extensiones de una VM.',
  args: [A.rg(), { name: 'vm_name', opts: ['--vm-name'], help: 'Nombre de la VM.', required: true }],
  table: (r: any[]) => r.map((e) => ({ Name: e.name.split('/').pop(), ProvisioningState: e.provisioningState, Publisher: e.publisher, Version: e.typeHandlerVersion, AutoUpgradeMinorVersion: e.autoUpgradeMinorVersion })),
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const id = resourceId(ctx.subscriptionId, rg.name, T_VM, a.vm_name);
    return getState().resources.filter((r) => ciEq(r.type, 'Microsoft.Compute/virtualMachines/extensions') && r.id.toLowerCase().startsWith(id.toLowerCase() + '/')).map((r) => flat(r));
  },
});

register({
  path: 'vm identity assign',
  summary: 'Habilita la identidad administrada (asignada por el sistema) de la VM.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), { name: 'role', opts: ['--role'], help: 'Rol a asignar a la identidad.' }, { name: 'scope', opts: ['--scope'], help: 'Ámbito del rol.' }],
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    patchResource(vm.id, (r) => (r.identity = resolveIdentity(getState(), { type: 'SystemAssigned' }, r.identity, r.name, r.id)), { principal: ctx.principal, opName: 'Asignar identidad administrada' });
    if (a.role && a.scope) createRoleAssignment({ assignee: vm.identity!.principalId!, role: a.role, scope: a.scope }, ctx.principal);
    return { principalId: vm.identity!.principalId, tenantId: vm.identity!.tenantId, type: 'SystemAssigned', userAssignedIdentities: null };
  },
});

register({
  path: 'vm identity show',
  summary: 'Muestra la identidad administrada de la VM.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids()],
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    return vm.identity ?? undefined;
  },
});

register({
  path: 'vm disk attach',
  summary: 'Conecta un disco de datos (existente o nuevo) a una VM.',
  args: [A.rg(), { name: 'vm_name', opts: ['--vm-name'], help: 'Nombre de la VM.', required: true }, A.name('Nombre o ID del disco.'), { name: 'new', opts: ['--new'], help: 'Crea un disco nuevo.', type: 'bool' }, { name: 'size_gb', opts: ['--size-gb', '-z'], help: 'Tamaño del disco nuevo.', type: 'int' }, { name: 'sku', opts: ['--sku'], help: 'SKU del disco nuevo.', choices: ['Standard_LRS', 'StandardSSD_LRS', 'Premium_LRS'], default: 'Premium_LRS' }, { name: 'lun', opts: ['--lun'], help: 'LUN.', type: 'int' }],
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const vm = findResource(resourceId(ctx.subscriptionId, rg.name, T_VM, a.vm_name));
    if (!vm) throw new ArmError('ResourceNotFound', `VM '${a.vm_name}' not found.`, 404);
    let disk = a.name.startsWith('/') ? findResource(a.name) : findResource(resourceId(ctx.subscriptionId, rg.name, T_DISK, a.name));
    if (a.new) {
      if (!a.size_gb) throw cliError('usage error: --size-gb is required to create a new disk', undefined, true);
      disk = await putResource({ type: T_DISK, name: a.name, location: vm.location, sku: { name: a.sku }, properties: { diskSizeGB: a.size_gb, creationData: { createOption: 'Empty' } } }, rg.name, op(ctx));
    }
    if (!disk) throw new ArmError('ResourceNotFound', `Disk '${a.name}' not found.`, 404);
    if (disk.managedBy && !ciEq(disk.managedBy, vm.id)) throw new ArmError('OperationNotAllowed', `Disk ${disk.name} is already attached to VM ${disk.managedBy}.`, 409);
    const dd = vm.properties.storageProfile.dataDisks ?? [];
    if (dd.length >= (findVmSize(vm.properties.hardwareProfile.vmSize)?.maxDataDisks ?? 2)) throw new ArmError('OperationNotAllowed', `The maximum number of data disks allowed to be attached to a VM of this size is ${findVmSize(vm.properties.hardwareProfile.vmSize)?.maxDataDisks}.`, 409);
    patchResource(vm.id, (r) => r.properties.storageProfile.dataDisks.push({ lun: a.lun ?? dd.length, name: disk!.name, createOption: 'Attach', caching: 'None', managedDisk: { id: disk!.id, storageAccountType: disk!.sku?.name }, diskSizeGB: disk!.properties.diskSizeGB }), { principal: ctx.principal, opName: 'Conectar disco de datos' });
    disk.managedBy = vm.id;
    disk.properties.diskState = 'Attached';
    changed();
    return undefined;
  },
});

register({
  path: 'vm disk detach',
  summary: 'Desconecta un disco de datos de una VM.',
  args: [A.rg(), { name: 'vm_name', opts: ['--vm-name'], help: 'Nombre de la VM.', required: true }, A.name('Nombre del disco.')],
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const vm = findResource(resourceId(ctx.subscriptionId, rg.name, T_VM, a.vm_name));
    if (!vm) throw new ArmError('ResourceNotFound', `VM '${a.vm_name}' not found.`, 404);
    const d = (vm.properties.storageProfile.dataDisks ?? []).find((x: any) => ciEq(x.name, a.name));
    if (!d) throw new ArmError('NotFound', `Data disk '${a.name}' is not attached to VM '${vm.name}'.`, 404);
    patchResource(vm.id, (r) => (r.properties.storageProfile.dataDisks = r.properties.storageProfile.dataDisks.filter((x: any) => x !== d)), { principal: ctx.principal, opName: 'Desconectar disco de datos' });
    const disk = findResource(d.managedDisk.id);
    if (disk) {
      disk.managedBy = undefined;
      disk.properties.diskState = 'Unattached';
    }
    changed();
    return undefined;
  },
});

register({
  path: 'vm user update',
  summary: 'Restablece la contraseña o la clave SSH de un usuario de la VM.',
  args: [A.rg(false), A.name('Nombre de la VM.', false), A.ids(), { name: 'username', opts: ['--username', '-u'], help: 'Usuario.', required: true }, { name: 'password', opts: ['--password', '-p'], help: 'Nueva contraseña.' }, { name: 'ssh_key_value', opts: ['--ssh-key-value'], help: 'Nueva clave pública SSH.' }],
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    authorize(ctx.principal, 'Microsoft.Compute/virtualMachines/extensions/write', vm.id);
    if (a.password) vm.data!.adminPassword = a.password;
    if (a.ssh_key_value) {
      const key = a.ssh_key_value.startsWith('ssh-') ? a.ssh_key_value : ctx.sess.fs.readFile(ctx.sess.resolve(a.ssh_key_value)).trim();
      vm.properties.osProfile.linuxConfiguration = { ...vm.properties.osProfile.linuxConfiguration, ssh: { publicKeys: [{ path: `/home/${a.username}/.ssh/authorized_keys`, keyData: key }] } };
    }
    if (a.password && vm.properties.osProfile.linuxConfiguration) vm.properties.osProfile.linuxConfiguration.disablePasswordAuthentication = false;
    changed();
    return undefined;
  },
});

register({
  path: 'vm auto-shutdown',
  summary: 'Programa el apagado automático diario de una VM (ahorro de costes).',
  args: [A.rg(), A.name('Nombre de la VM.'), { name: 'time', opts: ['--time'], help: 'Hora UTC en formato HHMM, p. ej. 1900.' }, { name: 'off', opts: ['--off'], help: 'Desactiva el apagado automático.', type: 'bool' }, { name: 'email', opts: ['--email'], help: 'Correo de notificación.' }],
  run(a, ctx) {
    const vm = getRes(ctx, a, T_VM);
    if (!a.off && !/^\d{4}$/.test(a.time ?? '')) throw cliError('usage error: --time HHMM | --off', undefined, true);
    vm.data!.autoShutdown = a.off ? null : { time: a.time, email: a.email ?? null, timeZone: 'UTC' };
    changed();
    if (a.off) return undefined;
    return { dailyRecurrence: { time: a.time }, id: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${vm.resourceGroup}/providers/microsoft.devtestlab/schedules/shutdown-computevm-${vm.name}`, location: vm.location, name: `shutdown-computevm-${vm.name}`, notificationSettings: { emailRecipient: a.email ?? null, status: a.email ? 'Enabled' : 'Disabled', timeInMinutes: 30 }, status: 'Enabled', targetResourceId: vm.id, taskType: 'ComputeVmShutdownTask', timeZoneId: 'UTC' };
  },
});

// ---------------------------------------------------------------- disk

register({
  path: 'disk create',
  summary: 'Crea un disco administrado.',
  args: [A.rg(), A.name('Nombre del disco.'), A.location(), { name: 'size_gb', opts: ['--size-gb', '-z'], help: 'Tamaño en GiB.', type: 'int', required: true }, A.sku('SKU del disco.', ['Standard_LRS', 'StandardSSD_LRS', 'Premium_LRS', 'Premium_ZRS', 'StandardSSD_ZRS'], 'Premium_LRS'), A.tags()],
  table: (d: any) => ({ Name: d.name, ResourceGroup: d.resourceGroup, Location: d.location, SizeGb: d.diskSizeGB, Sku: d.sku?.name, DiskState: d.diskState }),
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const d = await putResource({ type: T_DISK, name: a.name, location: a.location, tags: a.tags, sku: { name: a.sku }, properties: { diskSizeGB: a.size_gb, creationData: { createOption: 'Empty' } } }, rg.name, op(ctx));
    return flat(d);
  },
});

register({
  path: 'disk list',
  summary: 'Lista los discos administrados.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((d) => ({ Name: d.name, ResourceGroup: d.resourceGroup, Location: d.location, Zones: '', Sku: d.sku?.name, SizeGb: d.diskSizeGB, ProvisioningState: d.provisioningState, DiskState: d.diskState })),
  run: (a, ctx) => listInSub(ctx, T_DISK, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'disk show',
  summary: 'Muestra un disco.',
  args: [A.rg(false), A.name('Nombre del disco.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, T_DISK)),
});

register({
  path: 'disk update',
  summary: 'Actualiza un disco (ampliar tamaño o cambiar SKU).',
  args: [A.rg(false), A.name('Nombre del disco.', false), A.ids(), { name: 'size_gb', opts: ['--size-gb', '-z'], help: 'Nuevo tamaño (sólo ampliar).', type: 'int' }, { name: 'sku', opts: ['--sku'], help: 'Nuevo SKU.' }],
  async run(a, ctx) {
    const d = getRes(ctx, a, T_DISK);
    return flat(await putResource({ type: T_DISK, name: d.name, location: d.location, tags: d.tags, sku: a.sku ? { name: a.sku } : d.sku, properties: { ...d.properties, diskSizeGB: a.size_gb ?? d.properties.diskSizeGB } }, d.resourceGroup, op(ctx)));
  },
});

register({
  path: 'disk delete',
  summary: 'Elimina un disco.',
  args: [A.rg(false), A.name('Nombre del disco.', false), A.ids(), A.yes(), A.noWait()],
  confirm: 'Are you sure you want to perform this operation?',
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_DISK).id, op(ctx, a));
    return undefined;
  },
});

export function _unused() {
  return { createImmediate, nowIso };
}
