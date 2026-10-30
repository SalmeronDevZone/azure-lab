// Microsoft.Compute: máquinas virtuales, discos, extensiones y conjuntos de escalado.
import type { CloudState, Resource } from '../types';
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { DISK_SKUS, HOURS_PER_MONTH, VM_IMAGES, VM_SIZES, findVmSize } from '../catalog';
import { ciEq, guid, nowIso, shortHash } from '../util';
import { findSubnet } from './network';

const T_VM = 'Microsoft.Compute/virtualMachines';
const T_DISK = 'Microsoft.Compute/disks';
const T_NIC = 'Microsoft.Network/networkInterfaces';

const RESERVED_USERS = ['administrator', 'admin', 'user', 'user1', 'test', 'user2', 'test1', 'user3', 'admin1', '1', '123', 'a', 'actuser', 'adm', 'admin2', 'aspnet', 'backup', 'console', 'david', 'guest', 'john', 'owner', 'root', 'server', 'sql', 'support', 'support_388945a0', 'sys', 'test2', 'test3', 'user4', 'user5'];

export function passwordComplexEnough(pw: string, min: number, max: number): boolean {
  if (!pw || pw.length < min || pw.length > max) return false;
  let n = 0;
  if (/[A-Z]/.test(pw)) n++;
  if (/[a-z]/.test(pw)) n++;
  if (/\d/.test(pw)) n++;
  if (/[^A-Za-z0-9]/.test(pw)) n++;
  return n >= 3;
}

export function vmPowerState(vm: Resource): string {
  return vm.data?.powerState ?? 'running';
}

export function powerStateLabel(ps: string): string {
  const map: Record<string, string> = {
    running: 'En ejecución',
    stopped: 'Detenida',
    deallocated: 'Detenida (desasignada)',
    starting: 'Iniciándose',
    stopping: 'Deteniéndose',
    deallocating: 'Desasignándose',
    restarting: 'Reiniciándose',
  };
  return map[ps] ?? ps;
}

export function powerStateCode(ps: string): string {
  const map: Record<string, string> = {
    running: 'VM running',
    stopped: 'VM stopped',
    deallocated: 'VM deallocated',
    starting: 'VM starting',
    stopping: 'VM stopping',
    deallocating: 'VM deallocating',
    restarting: 'VM starting',
  };
  return map[ps] ?? ps;
}

export function vmNic(vm: Resource, s: CloudState): Resource | undefined {
  const id = vm.properties.networkProfile?.networkInterfaces?.[0]?.id;
  return id ? s.resources.find((r) => ciEq(r.id, id)) : undefined;
}

export function vmNetworkInfo(vm: Resource, s: CloudState) {
  const nic = vmNic(vm, s);
  const ic = nic?.properties.ipConfigurations?.[0]?.properties;
  const pip = ic?.publicIPAddress?.id ? s.resources.find((r) => ciEq(r.id, ic.publicIPAddress.id)) : undefined;
  const sn = ic?.subnet?.id ? findSubnet(ic.subnet.id, s) : undefined;
  return {
    nic,
    privateIp: ic?.privateIPAddress as string | undefined,
    publicIp: pip?.properties.ipAddress as string | undefined,
    pip,
    fqdn: pip?.properties.dnsSettings?.fqdn as string | undefined,
    vnet: sn?.vnet,
    subnet: sn?.subnet,
  };
}

function diskSkuForSize(size: string): string {
  return /^Standard_[A-Z]+\d+[a-z]*s/i.test(size) ? 'Premium_LRS' : 'StandardSSD_LRS';
}

registerProvider({
  type: T_VM,
  label: 'Máquina virtual',
  labelPlural: 'Máquinas virtuales',
  icon: 'vm',
  category: 'Proceso',
  description: 'Servidores Linux o Windows bajo demanda (IaaS).',
  provisionMs: 4500,
  nameRule: { test: (n) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_]$|^[a-zA-Z0-9]$/.test(n) && !/^\d+$/.test(n), message: "Virtual machine name '{name}' is invalid. It can contain only letters, numbers, '.', '_' and '-' (1-64 characters) and cannot be entirely numeric." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const size = p.hardwareProfile?.vmSize ?? ex?.properties.hardwareProfile?.vmSize ?? 'Standard_B1s';
    const sizeInfo = findVmSize(size);
    if (!sizeInfo) {
      throw new ArmError('InvalidParameter', `The value ${size} provided for the VM size is not valid. The valid sizes in the current region are: ${VM_SIZES.map((x) => x.name).join(',')}.`);
    }
    let storageProfile = ex?.properties.storageProfile;
    let osProfile = ex?.properties.osProfile;
    let osType = ex?.data?.osType;
    let imageInfo = ex?.data?.image;
    const data: Record<string, any> = { ...(ex?.data ?? {}) };
    if (!ex) {
      const ir = p.storageProfile?.imageReference ?? {};
      const image = VM_IMAGES.find((i) => ciEq(i.publisher, ir.publisher) && ciEq(i.offer, ir.offer) && ciEq(i.sku, ir.sku));
      if (!image) {
        throw new ArmError('PlatformImageNotFound', `The platform image '${ir.publisher}:${ir.offer}:${ir.sku}:${ir.version ?? 'latest'}' is not available. Verify that all fields in the storage profile are correct.`, 404);
      }
      osType = image.os;
      imageInfo = image;
      const op = p.osProfile ?? {};
      const user = String(op.adminUsername ?? '');
      if (!user) throw new ArmError('InvalidParameter', "Required parameter 'adminUsername' is missing (null).");
      if (RESERVED_USERS.includes(user.toLowerCase())) {
        throw new ArmError('InvalidParameter', 'The Admin Username specified is not allowed.', 400, `"${user}" es un nombre reservado. Usa por ejemplo "azureuser".`);
      }
      if (image.os === 'Windows' && user.length > 20) throw new ArmError('InvalidParameter', 'The Admin Username specified is too long (max 20 characters).');
      const usesPassword = image.os === 'Windows' || op.linuxConfiguration?.disablePasswordAuthentication === false;
      if (usesPassword) {
        const [min, max] = image.os === 'Windows' ? [12, 123] : [6, 72];
        if (!passwordComplexEnough(op.adminPassword ?? '', min, max)) {
          throw new ArmError(
            'InvalidParameter',
            `The supplied password must be between ${min}-${max} characters long and must satisfy at least 3 of password complexity requirements from the following: 1) Contains an uppercase character 2) Contains a lowercase character 3) Contains a numeric digit 4) Contains a special character 5) Control characters are not allowed`,
          );
        }
        data.adminPassword = op.adminPassword;
      }
      const computerName = op.computerName ?? input.name;
      if (image.os === 'Windows' && computerName.length > 15) {
        throw new ArmError('InvalidParameter', `Windows computer name cannot be more than 15 characters long, be entirely numeric, or contain the following characters: \` ~ ! @ # $ % ^ & * ( ) = + _ [ ] { } \\ | ; : . ' " , < > / ?.`, 400, 'Con Windows el nombre del equipo (por defecto el nombre de la VM) tiene un máximo de 15 caracteres.');
      }
      osProfile = {
        computerName,
        adminUsername: user,
        allowExtensionOperations: true,
        requireGuestProvisionSignal: true,
        secrets: [],
        linuxConfiguration:
          image.os === 'Linux'
            ? {
                disablePasswordAuthentication: !usesPassword,
                ssh: usesPassword ? undefined : { publicKeys: op.linuxConfiguration?.ssh?.publicKeys ?? [{ path: `/home/${user}/.ssh/authorized_keys`, keyData: `ssh-rsa AAAAB3NzaC1yc2E${shortHash(ctx.id, 40)} generated-by-azure` }] },
                provisionVMAgent: true,
                patchSettings: { assessmentMode: 'ImageDefault', patchMode: 'ImageDefault' },
              }
            : undefined,
        windowsConfiguration: image.os === 'Windows' ? { provisionVMAgent: true, enableAutomaticUpdates: true, patchSettings: { patchMode: 'AutomaticByOS', assessmentMode: 'ImageDefault' } } : undefined,
      };
      const osDisk = p.storageProfile?.osDisk ?? {};
      const diskName = osDisk.name ?? `${input.name}_OsDisk_1_${shortHash(ctx.id + 'os', 32)}`;
      const diskSku = osDisk.managedDisk?.storageAccountType ?? diskSkuForSize(size);
      if (!DISK_SKUS[diskSku]) throw new ArmError('InvalidParameter', `Storage account type '${diskSku}' is not supported. Supported values: ${Object.keys(DISK_SKUS).join(', ')}.`);
      storageProfile = {
        imageReference: { publisher: image.publisher, offer: image.offer, sku: image.sku, version: 'latest', exactVersion: image.os === 'Linux' ? '22.04.202410020' : '20348.2700.241004' },
        osDisk: {
          osType: image.os,
          name: diskName,
          createOption: 'FromImage',
          caching: 'ReadWrite',
          managedDisk: { storageAccountType: diskSku, id: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup.name}/providers/Microsoft.Compute/disks/${diskName}` },
          diskSizeGB: osDisk.diskSizeGB ?? (image.os === 'Windows' ? 127 : 30),
          deleteOption: osDisk.deleteOption ?? 'Delete',
        },
        dataDisks: [],
        diskControllerType: 'SCSI',
      };
      data.powerState = 'running';
      data.osType = image.os;
      data.image = image;
      data.packages = image.os === 'Linux' ? ['openssh-server', 'curl', 'walinuxagent'] : [];
      data.services = image.os === 'Linux' ? { ssh: 'active' } : { RDP: 'running', W3SVC: 'stopped' };
      data.files = {};
      data.bootTime = nowIso();
    } else if (p.storageProfile?.dataDisks) {
      storageProfile = { ...storageProfile, dataDisks: p.storageProfile.dataDisks };
    }
    const nics = p.networkProfile?.networkInterfaces ?? ex?.properties.networkProfile?.networkInterfaces ?? [];
    if (!nics.length) throw new ArmError('InvalidParameter', 'At least one network interface is required to create a virtual machine.');
    for (const n of nics) {
      const nic = ctx.state.resources.find((r) => ciEq(r.id, n.id));
      if (!nic) throw new ArmError('NotFound', `Resource ${n.id} not found.`, 404);
      if (!ciEq(nic.location, input.location)) throw new ArmError('InvalidParameter', `The network interface ${nic.name} is in location ${nic.location} but the VM is in ${input.location}.`);
      const owner = nic.properties.virtualMachine?.id;
      if (owner && !ciEq(owner, ctx.id) && ctx.state.resources.some((r) => ciEq(r.id, owner))) {
        throw new ArmError('NicInUse', `Network interface ${nic.id} is already attached to virtual machine ${owner}.`, 400);
      }
    }
    const r = baseResource(input, ctx);
    r.data = data;
    r.properties = {
      vmId: ex?.properties.vmId ?? guid(),
      hardwareProfile: { vmSize: sizeInfo.name },
      storageProfile,
      osProfile,
      networkProfile: { networkInterfaces: nics.map((n: any, i: number) => ({ id: ctx.state.resources.find((x) => ciEq(x.id, n.id))!.id, properties: { primary: i === 0, deleteOption: n.properties?.deleteOption ?? 'Detach' } })) },
      diagnosticsProfile: p.diagnosticsProfile ?? ex?.properties.diagnosticsProfile ?? { bootDiagnostics: { enabled: true } },
      securityProfile: p.securityProfile ?? ex?.properties.securityProfile ?? { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } },
      timeCreated: ex?.properties.timeCreated ?? nowIso(),
      priority: p.priority ?? ex?.properties.priority ?? 'Regular',
    };
    void osType;
    void imageInfo;
    return r;
  },
  afterProvision(res, ctx) {
    const s = ctx.state;
    for (const n of res.properties.networkProfile.networkInterfaces) {
      const nic = s.resources.find((r) => ciEq(r.id, n.id));
      if (nic) nic.properties.virtualMachine = { id: res.id };
    }
    const od = res.properties.storageProfile?.osDisk;
    if (od && !s.resources.some((r) => ciEq(r.id, od.managedDisk.id))) {
      const disk: Resource = {
        id: od.managedDisk.id,
        name: od.name,
        type: T_DISK,
        subscriptionId: res.subscriptionId,
        resourceGroup: res.resourceGroup,
        location: res.location,
        tags: {},
        sku: { name: od.managedDisk.storageAccountType, tier: od.managedDisk.storageAccountType.startsWith('Premium') ? 'Premium' : 'Standard' },
        managedBy: res.id,
        properties: {
          osType: od.osType,
          diskSizeGB: od.diskSizeGB,
          diskState: 'Attached',
          creationData: { createOption: 'FromImage', imageReference: { id: `/Subscriptions/${res.subscriptionId}/Providers/Microsoft.Compute/Locations/${res.location}/Publishers/${res.properties.storageProfile.imageReference.publisher}` } },
          timeCreated: nowIso(),
          provisioningState: 'Succeeded',
          networkAccessPolicy: 'AllowAll',
          publicNetworkAccess: 'Enabled',
          tier: od.diskSizeGB <= 32 ? 'P4' : 'P10',
        },
        data: {},
        createdAt: nowIso(),
        createdBy: res.createdBy,
      };
      s.resources.push(disk);
    }
  },
  onDelete(res, s) {
    for (const n of res.properties.networkProfile?.networkInterfaces ?? []) {
      const nic = s.resources.find((r) => ciEq(r.id, n.id));
      if (nic) nic.properties.virtualMachine = undefined;
    }
    const od = res.properties.storageProfile?.osDisk;
    if (od?.deleteOption === 'Delete') s.resources = s.resources.filter((r) => !ciEq(r.id, od.managedDisk?.id));
    else {
      const disk = s.resources.find((r) => ciEq(r.id, od?.managedDisk?.id));
      if (disk) {
        disk.managedBy = undefined;
        disk.properties.diskState = 'Unattached';
      }
    }
    for (const dd of res.properties.storageProfile?.dataDisks ?? []) {
      const disk = s.resources.find((r) => ciEq(r.id, dd.managedDisk?.id));
      if (disk) {
        disk.managedBy = undefined;
        disk.properties.diskState = 'Unattached';
      }
    }
  },
  status(res) {
    if (res.properties.provisioningState !== 'Succeeded') return res.properties.provisioningState;
    return powerStateLabel(vmPowerState(res));
  },
  essentials(res, s) {
    const net = vmNetworkInfo(res, s);
    const size = findVmSize(res.properties.hardwareProfile?.vmSize);
    return [
      ['Estado', powerStateLabel(vmPowerState(res))],
      ['Sistema operativo', `${res.data?.osType ?? ''} (${res.data?.image?.displayName ?? ''})`],
      ['Tamaño', size ? `${size.name} (${size.vCPUs} vcpu, ${size.memoryGB} GiB de memoria)` : res.properties.hardwareProfile?.vmSize],
      ['Dirección IP pública', net.pip ? { text: net.publicIp ?? '-', link: net.pip.id } : '-'],
      ['Dirección IP privada', net.privateIp ?? '-'],
      ['Red virtual/subred', net.vnet ? { text: `${net.vnet.name}/${net.subnet?.name}`, link: net.vnet.id } : '-'],
      ['Nombre DNS', net.fqdn ?? 'No configurado'],
      ['Usuario administrador', res.properties.osProfile?.adminUsername ?? '-'],
    ];
  },
  monthlyCost(res) {
    const size = findVmSize(res.properties.hardwareProfile?.vmSize);
    if (!size) return 0;
    const ps = vmPowerState(res);
    if (ps === 'deallocated' || ps === 'deallocating') return 0;
    const license = res.data?.osType === 'Windows' ? 0.046 * size.vCPUs : 0;
    return (size.pricePerHour + license) * HOURS_PER_MONTH;
  },
});

registerProvider({
  type: T_DISK,
  label: 'Disco',
  labelPlural: 'Discos',
  icon: 'disk',
  category: 'Proceso',
  description: 'Discos administrados para máquinas virtuales.',
  provisionMs: 1200,
  nameRule: { test: (n) => /^[a-zA-Z0-9_.-]{1,80}$/.test(n), message: "Disk name '{name}' is invalid (1-80 caracteres: letras, números, '_', '.', '-')." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const skuName = input.sku?.name ?? ex?.sku?.name ?? 'Premium_LRS';
    if (!DISK_SKUS[skuName]) throw new ArmError('InvalidParameter', `Disk sku '${skuName}' is not supported. Supported values: ${Object.keys(DISK_SKUS).join(', ')}.`);
    const size = Number(p.diskSizeGB ?? ex?.properties.diskSizeGB ?? 32);
    if (ex && size < ex.properties.diskSizeGB) throw new ArmError('BadRequest', `Disk size reduction is not supported. Requested size ${size} GB is smaller than current size ${ex.properties.diskSizeGB} GB.`);
    if (ex && size > ex.properties.diskSizeGB && ex.managedBy) {
      const vm = ctx.state.resources.find((r) => ciEq(r.id, ex.managedBy));
      if (vm && vmPowerState(vm) !== 'deallocated') {
        throw new ArmError('OperationNotAllowed', `Disk resizing is allowed only when creating a VM or when the VM is deallocated.`, 409, 'Desasigna la VM (az vm deallocate) antes de ampliar el disco.');
      }
    }
    const r = baseResource(input, ctx);
    r.sku = { name: skuName, tier: skuName.startsWith('Premium') ? 'Premium' : 'Standard' };
    r.managedBy = ex?.managedBy;
    r.properties = {
      osType: ex?.properties.osType,
      diskSizeGB: size,
      diskState: ex?.properties.diskState ?? 'Unattached',
      creationData: ex?.properties.creationData ?? { createOption: p.creationData?.createOption ?? 'Empty' },
      timeCreated: ex?.properties.timeCreated ?? nowIso(),
      networkAccessPolicy: 'AllowAll',
      publicNetworkAccess: 'Enabled',
      tier: size <= 32 ? 'P4' : size <= 64 ? 'P6' : size <= 128 ? 'P10' : 'P15',
    };
    return r;
  },
  beforeDelete(res, s) {
    if (res.managedBy && s.resources.some((r) => ciEq(r.id, res.managedBy))) {
      throw new ArmError('OperationNotAllowed', `Disk ${res.name} is attached to VM ${res.managedBy}.`, 409, 'Desconecta el disco de la VM antes de eliminarlo.');
    }
  },
  status(res) {
    return res.properties.diskState === 'Attached' ? 'Conectado' : 'No conectado';
  },
  essentials(res, s) {
    const vm = res.managedBy ? s.resources.find((r) => ciEq(r.id, res.managedBy)) : undefined;
    return [
      ['Estado del disco', res.properties.diskState === 'Attached' ? 'Conectado' : 'No conectado'],
      ['Tamaño', `${res.properties.diskSizeGB} GiB`],
      ['Tipo', DISK_SKUS[res.sku?.name ?? '']?.label ?? res.sku?.name ?? ''],
      ['Administrado por', vm ? { text: vm.name, link: vm.id } : '-'],
      ['Sistema operativo', res.properties.osType ?? '-'],
    ];
  },
  monthlyCost(res) {
    const info = DISK_SKUS[res.sku?.name ?? 'Premium_LRS'];
    return info.pricePer32GB * Math.max(1, Math.ceil((res.properties.diskSizeGB ?? 32) / 32));
  },
});

registerProvider({
  type: 'Microsoft.Compute/virtualMachines/extensions',
  label: 'Extensión de VM',
  labelPlural: 'Extensiones de VM',
  icon: 'vm',
  category: 'Proceso',
  provisionMs: 2500,
  hidden: true,
  parentType: T_VM,
  build(input, ctx) {
    const p = input.properties ?? {};
    const r = baseResource(input, ctx);
    r.properties = {
      publisher: p.publisher,
      type: p.type,
      typeHandlerVersion: p.typeHandlerVersion ?? '1.0',
      autoUpgradeMinorVersion: p.autoUpgradeMinorVersion ?? true,
      enableAutomaticUpgrade: p.enableAutomaticUpgrade ?? false,
      settings: p.settings ?? {},
    };
    return r;
  },
});

registerProvider({
  type: 'Microsoft.Compute/virtualMachineScaleSets',
  label: 'Conjunto de escalado de VM',
  labelPlural: 'Conjuntos de escalado de VM',
  icon: 'vmss',
  category: 'Proceso',
  description: 'Grupo de VMs idénticas con escalado automático.',
  provisionMs: 4000,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const r = baseResource(input, ctx);
    const size = input.sku?.name ?? ex?.sku?.name ?? 'Standard_D2s_v5';
    if (!findVmSize(size)) throw new ArmError('InvalidParameter', `The value ${size} provided for the VM size is not valid.`);
    r.sku = { name: size, tier: 'Standard', capacity: input.sku?.capacity ?? ex?.sku?.capacity ?? 2 };
    r.properties = {
      orchestrationMode: p.orchestrationMode ?? 'Uniform',
      upgradePolicy: p.upgradePolicy ?? { mode: 'Manual' },
      virtualMachineProfile: p.virtualMachineProfile ?? ex?.properties.virtualMachineProfile ?? {},
      overprovision: false,
      uniqueId: ex?.properties.uniqueId ?? guid(),
      timeCreated: ex?.properties.timeCreated ?? nowIso(),
    };
    return r;
  },
  essentials(res) {
    return [
      ['Tamaño', res.sku?.name ?? ''],
      ['Instancias', String(res.sku?.capacity ?? 0)],
      ['Modo de orquestación', res.properties.orchestrationMode],
    ];
  },
  monthlyCost(res) {
    if (res.data?.stopped) return 0;
    const size = findVmSize(res.sku?.name);
    return (size?.pricePerHour ?? 0) * HOURS_PER_MONTH * (res.sku?.capacity ?? 0);
  },
});

export { T_VM, T_DISK, T_NIC };
