// Microsoft.ContainerRegistry, Microsoft.ContainerInstance y Microsoft.ContainerService (AKS).
import type { CloudState, Resource } from '../types';
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { ACR_SKUS, K8S_DEFAULT_VERSION, K8S_VERSIONS, findVmSize, normalizeImageName } from '../catalog';
import { ciEq, fakePassword, fnv1a, guid, nowIso, randomPublicIp, shortHash } from '../util';
import { cleanupIdentity, createManagedIdentitySp, removePrincipal, resolveIdentity } from './identity';
import { emptyKube, kubeOf, resolveImage, syncNodes } from '../services/kube';
import { changed } from '../store';

export const T_ACR = 'Microsoft.ContainerRegistry/registries';
export const T_ACI = 'Microsoft.ContainerInstance/containerGroups';
export const T_AKS = 'Microsoft.ContainerService/managedClusters';

registerProvider({
  type: T_ACR,
  label: 'Registro de contenedor',
  labelPlural: 'Registros de contenedor',
  icon: 'acr',
  category: 'Contenedores',
  description: 'Registro privado de imágenes de contenedor (Docker/OCI).',
  provisionMs: 2500,
  global: { code: 'AlreadyInUse', message: (n) => `The registry DNS name ${n.toLowerCase()}.azurecr.io is already in use. You can check if the name is already claimed using following API: https://docs.microsoft.com/en-us/rest/api/containerregistry/registries/checknameavailability` },
  nameRule: { test: (n) => /^[a-zA-Z0-9]{5,50}$/.test(n), message: "Registry name '{name}' is invalid: must be alphanumeric (sin guiones) and between 5 and 50 characters." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const sku = input.sku?.name ?? ex?.sku?.name ?? 'Basic';
    if (!ACR_SKUS[sku]) throw new ArmError('InvalidSku', `The SKU '${sku}' is not valid. Allowed values: ${Object.keys(ACR_SKUS).join(', ')}.`);
    const r = baseResource(input, ctx);
    r.sku = { name: sku, tier: sku };
    r.properties = {
      loginServer: `${input.name.toLowerCase()}.azurecr.io`,
      creationDate: ex?.properties.creationDate ?? nowIso(),
      adminUserEnabled: p.adminUserEnabled ?? ex?.properties.adminUserEnabled ?? false,
      publicNetworkAccess: p.publicNetworkAccess ?? ex?.properties.publicNetworkAccess ?? 'Enabled',
      zoneRedundancy: 'Disabled',
      anonymousPullEnabled: p.anonymousPullEnabled ?? ex?.properties.anonymousPullEnabled ?? false,
      dataEndpointEnabled: false,
      networkRuleBypassOptions: 'AzureServices',
      policies: { retentionPolicy: { days: 7, status: 'disabled' }, trustPolicy: { status: 'disabled', type: 'Notary' }, quarantinePolicy: { status: 'disabled' } },
      encryption: { status: 'disabled' },
    };
    r.data = {
      ...(r.data ?? {}),
      repos: r.data?.repos ?? {},
      passwords: r.data?.passwords ?? [
        { name: 'password', value: fakePassword(ctx.id + 'p1') },
        { name: 'password2', value: fakePassword(ctx.id + 'p2') },
      ],
    };
    return r;
  },
  essentials(res) {
    const repos = Object.keys(res.data?.repos ?? {}).length;
    return [
      ['Servidor de inicio de sesión', res.properties.loginServer],
      ['SKU', ACR_SKUS[res.sku?.name ?? 'Basic']?.label ?? res.sku?.name ?? ''],
      ['Usuario administrador', res.properties.adminUserEnabled ? 'Habilitado' : 'Deshabilitado'],
      ['Repositorios', String(repos)],
    ];
  },
  monthlyCost: (res) => ACR_SKUS[res.sku?.name ?? 'Basic']?.monthly ?? 5,
});

registerProvider({
  type: T_ACI,
  label: 'Instancia de contenedor',
  labelPlural: 'Instancias de contenedor',
  icon: 'aci',
  category: 'Contenedores',
  description: 'Ejecuta contenedores bajo demanda sin administrar servidores.',
  provisionMs: 3500,
  nameRule: { test: (n) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n), message: "Container group name '{name}' is invalid: use lowercase letters, numbers and '-' (1-63)." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const containers = (p.containers ?? ex?.properties.containers ?? []).map((c: any) => {
      const cp = c.properties ?? c;
      return {
        name: c.name,
        properties: {
          image: cp.image,
          command: cp.command ?? [],
          ports: (cp.ports ?? []).map((x: any) => ({ port: Number(x.port), protocol: x.protocol ?? 'TCP' })),
          environmentVariables: cp.environmentVariables ?? [],
          resources: { requests: { cpu: Number(cp.resources?.requests?.cpu ?? 1), memoryInGB: Number(cp.resources?.requests?.memoryInGB ?? 1.5) } },
          instanceView: { currentState: { state: 'Running', startTime: nowIso(), detailStatus: '' }, restartCount: 0, events: [] },
        },
      };
    });
    if (!containers.length) throw new ArmError('InvalidContainerGroup', 'A container group must have at least one container.');
    const creds = (p.imageRegistryCredentials ?? []).map((c: any) => ({ server: c.server, username: c.username, password: c.password }));
    const pkgs: Record<string, any> = {};
    if (!ex) {
      for (const c of containers) {
        const { registry } = normalizeImageName(c.properties.image);
        const cred = registry ? creds.find((x: any) => ciEq(x.server, registry)) : undefined;
        const identityPuller = p.imageRegistryCredentials?.some((x: any) => x.identity) && input.identity?.userAssignedIdentities ? null : null;
        const res = resolveImage(c.properties.image, identityPuller, ctx.state, cred ? { username: cred.username, password: cred.password } : null);
        if (!res.ok) {
          throw new ArmError(
            'InaccessibleImage',
            `The image '${c.properties.image}' in container group '${input.name}' is not accessible. Please check the image and registry credential.`,
            400,
            registry?.endsWith('.azurecr.io')
              ? 'Para imágenes de ACR pasa --registry-login-server, --registry-username y --registry-password (usuario administrador o una entidad de servicio con AcrPull).'
              : 'Comprueba que la imagen existe y que el nombre y la etiqueta son correctos.',
          );
        }
        pkgs[c.name] = res.pkg;
      }
    }
    const ipIn = p.ipAddress ?? ex?.properties.ipAddress;
    let ipAddress: any;
    if (ipIn) {
      const label = ipIn.dnsNameLabel;
      if (label && !ex) {
        const taken = ctx.state.resources.some((r) => ciEq(r.type, T_ACI) && ciEq(r.location, input.location) && ciEq(r.properties.ipAddress?.dnsNameLabel, label));
        if (taken) throw new ArmError('DnsNameLabelAlreadyInUse', `The DNS name label '${label}' is already in use in region '${input.location}'.`, 409);
      }
      ipAddress = {
        type: ipIn.type ?? 'Public',
        ip: ex?.properties.ipAddress?.ip ?? randomPublicIp(ctx.id + 'aci'),
        ports: ipIn.ports ?? containers.flatMap((c: any) => c.properties.ports),
        dnsNameLabel: label,
        fqdn: label ? `${label}.${input.location}.azurecontainer.io` : undefined,
      };
    }
    const r = baseResource(input, ctx);
    r.identity = resolveIdentity(ctx.state, input.identity, ex?.identity, input.name, ctx.id);
    r.properties = {
      containers,
      osType: p.osType ?? ex?.properties.osType ?? 'Linux',
      restartPolicy: p.restartPolicy ?? ex?.properties.restartPolicy ?? 'Always',
      ipAddress,
      imageRegistryCredentials: creds.map((c: any) => ({ server: c.server, username: c.username })),
      sku: 'Standard',
      instanceView: { state: 'Running', events: [] },
    };
    r.data = { ...(r.data ?? {}), pkgs: ex?.data?.pkgs ?? pkgs, state: ex?.data?.state ?? 'Running', startTime: ex?.data?.startTime ?? nowIso() };
    return r;
  },
  onDelete: (res, s) => cleanupIdentity(res, s),
  status(res) {
    return res.data?.state === 'Stopped' ? 'Detenido' : 'En ejecución';
  },
  essentials(res) {
    const c = res.properties.containers?.[0]?.properties;
    return [
      ['Estado', res.data?.state === 'Stopped' ? 'Detenido' : 'En ejecución'],
      ['Imagen', c?.image ?? '-'],
      ['Dirección IP', res.properties.ipAddress?.ip ?? 'Privada / ninguna'],
      ['FQDN', res.properties.ipAddress?.fqdn ?? '-'],
      ['Puertos', (res.properties.ipAddress?.ports ?? []).map((p: any) => p.port).join(', ') || '-'],
      ['Tipo de SO', res.properties.osType],
    ];
  },
  monthlyCost(res) {
    if (res.data?.state === 'Stopped') return 0;
    const req = res.properties.containers?.reduce((acc: { cpu: number; mem: number }, c: any) => ({ cpu: acc.cpu + (c.properties.resources?.requests?.cpu ?? 1), mem: acc.mem + (c.properties.resources?.requests?.memoryInGB ?? 1.5) }), { cpu: 0, mem: 0 }) ?? { cpu: 1, mem: 1.5 };
    return req.cpu * 35.5 + req.mem * 3.9;
  },
});

function normalizePool(p: any, version: string, idx: number) {
  const name = String(p.name ?? `nodepool${idx + 1}`);
  if (!/^[a-z][a-z0-9]{0,11}$/.test(name)) throw new ArmError('InvalidParameter', `Agent pool name '${name}' is invalid: must start with a lowercase letter, contain only lowercase letters and numbers and be at most 12 characters.`);
  const count = Number(p.count ?? 3);
  const mode = p.mode ?? (idx === 0 ? 'System' : 'User');
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new ArmError('InvalidParameter', `The count for agent pool '${name}' must be between 0 and 1000.`);
  if (mode === 'System' && count < 1) throw new ArmError('InvalidParameter', `System agent pool '${name}' must have at least 1 node.`, 400, 'Los grupos de nodos de sistema necesitan al menos un nodo; usa "az aks stop" para parar el clúster.');
  const size = p.vmSize ?? 'Standard_D2s_v5';
  const sizeInfo = findVmSize(size);
  if (!sizeInfo) throw new ArmError('InvalidParameter', `The VM size of ${size} is not allowed in your subscription in location.`);
  if (sizeInfo.vCPUs < 2 && mode === 'System') throw new ArmError('InvalidParameter', `The VM SKU chosen for this cluster ${size} does not have enough CPU/memory to run as an AKS node. System node pools require at least 2 vCPUs and 4 GiB of memory.`);
  if (p.enableAutoScaling && (p.minCount === undefined || p.maxCount === undefined)) throw new ArmError('InvalidParameter', 'minCount and maxCount are required when autoscaling is enabled.');
  return {
    name,
    count,
    vmSize: sizeInfo.name,
    osDiskSizeGB: p.osDiskSizeGB ?? 128,
    osDiskType: 'Managed',
    kubeletDiskType: 'OS',
    maxPods: p.maxPods ?? 250,
    type: 'VirtualMachineScaleSets',
    enableAutoScaling: !!p.enableAutoScaling,
    minCount: p.enableAutoScaling ? Number(p.minCount) : null,
    maxCount: p.enableAutoScaling ? Number(p.maxCount) : null,
    mode,
    osType: 'Linux',
    osSKU: 'Ubuntu',
    orchestratorVersion: version,
    currentOrchestratorVersion: version,
    nodeImageVersion: 'AKSUbuntu-2204gen2containerd-202410.09.0',
    powerState: { code: p.powerState?.code ?? 'Running' },
    provisioningState: 'Succeeded',
    enableNodePublicIP: false,
  };
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function ensureNodeResourceGroup(cluster: Resource, s: CloudState) {
  const nodeRg = cluster.properties.nodeResourceGroup;
  let rg = s.resourceGroups.find((g) => g.subscriptionId === cluster.subscriptionId && ciEq(g.name, nodeRg));
  if (!rg) {
    rg = {
      id: `/subscriptions/${cluster.subscriptionId}/resourceGroups/${nodeRg}`,
      name: nodeRg,
      location: cluster.location,
      tags: { 'aks-managed-cluster-name': cluster.name, 'aks-managed-cluster-rg': cluster.resourceGroup },
      subscriptionId: cluster.subscriptionId,
      managedBy: cluster.id,
      provisioningState: 'Succeeded',
      createdAt: nowIso(),
    };
    s.resourceGroups.push(rg);
  }
  const h = String(fnv1a(cluster.id) % 100000000).padStart(8, '0');
  const mk = (type: string, name: string, extra: Partial<Resource>) => {
    const id = `${rg!.id}/providers/${type}/${name}`;
    let r = s.resources.find((x) => ciEq(x.id, id));
    if (!r) {
      r = { id, name, type, subscriptionId: cluster.subscriptionId, resourceGroup: nodeRg, location: cluster.location, tags: { 'aks-managed-createOperationID': guid() }, properties: { provisioningState: 'Succeeded' }, data: {}, createdAt: nowIso(), createdBy: 'AKS' };
      s.resources.push(r);
    }
    Object.assign(r, extra, { properties: { ...r.properties, ...(extra.properties ?? {}) } });
    return r;
  };
  const kubelet = cluster.properties.identityProfile.kubeletidentity;
  mk('Microsoft.ManagedIdentity/userAssignedIdentities', `${cluster.name}-agentpool`, { properties: { tenantId: s.tenant.id, principalId: kubelet.objectId, clientId: kubelet.clientId } });
  mk('Microsoft.Network/virtualNetworks', `aks-vnet-${h}`, {
    properties: {
      addressSpace: { addressPrefixes: ['10.224.0.0/12'] },
      subnets: [{ name: 'aks-subnet', id: `${rg.id}/providers/Microsoft.Network/virtualNetworks/aks-vnet-${h}/subnets/aks-subnet`, type: 'Microsoft.Network/virtualNetworks/subnets', properties: { addressPrefix: '10.224.0.0/16', provisioningState: 'Succeeded', serviceEndpoints: [], delegations: [] } }],
      virtualNetworkPeerings: [],
      dhcpOptions: { dnsServers: [] },
    },
  });
  mk('Microsoft.Network/networkSecurityGroups', `aks-agentpool-${h}-nsg`, { properties: { securityRules: [], defaultSecurityRules: [] } });
  const outPip = mk('Microsoft.Network/publicIPAddresses', shortHash(cluster.id + 'out', 8) + '-' + shortHash(cluster.id + 'out2', 4) + '-' + shortHash(cluster.id + 'out3', 4) + '-' + shortHash(cluster.id + 'out4', 12), {
    sku: { name: 'Standard', tier: 'Regional' },
    properties: { ipAddress: randomPublicIp(cluster.id + 'outbound'), publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' },
  });
  mk('Microsoft.Network/loadBalancers', 'kubernetes', {
    sku: { name: 'Standard', tier: 'Regional' },
    properties: { frontendIPConfigurations: [{ name: 'outbound', id: `${rg.id}/providers/Microsoft.Network/loadBalancers/kubernetes/frontendIPConfigurations/outbound`, properties: { publicIPAddress: { id: outPip.id } } }], backendAddressPools: [{ name: 'kubernetes', id: '', properties: {} }], loadBalancingRules: [], probes: [], inboundNatRules: [], outboundRules: [] },
  });
  for (const p of cluster.properties.agentPoolProfiles) {
    mk('Microsoft.Compute/virtualMachineScaleSets', `aks-${p.name}-${h}-vmss`, {
      sku: { name: p.vmSize, tier: 'Standard', capacity: p.count },
      properties: { orchestrationMode: 'Uniform', upgradePolicy: { mode: 'Manual' }, virtualMachineProfile: {}, overprovision: false },
      data: { stopped: cluster.properties.powerState?.code === 'Stopped' },
    });
  }
  // eliminar VMSS de grupos de nodos borrados
  const valid = cluster.properties.agentPoolProfiles.map((p: any) => `aks-${p.name}-${h}-vmss`.toLowerCase());
  s.resources = s.resources.filter((r) => !(ciEq(r.resourceGroup, nodeRg) && ciEq(r.type, 'Microsoft.Compute/virtualMachineScaleSets') && !valid.includes(r.name.toLowerCase())));
}

registerProvider({
  type: T_AKS,
  label: 'Servicio de Kubernetes',
  labelPlural: 'Servicios de Kubernetes',
  icon: 'aks',
  category: 'Contenedores',
  description: 'Kubernetes administrado (AKS): el plano de control lo gestiona Azure.',
  provisionMs: 7000,
  nameRule: { test: (n) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(n), message: "Managed cluster name '{name}' is invalid (1-63 caracteres: letras, números, '_' y '-')." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const s = ctx.state;
    const version = p.kubernetesVersion ?? ex?.properties.kubernetesVersion ?? K8S_DEFAULT_VERSION;
    if (!K8S_VERSIONS.includes(version)) {
      throw new ArmError('K8sVersionNotSupported', `Version ${version} is not supported in this region. Please use [az aks get-versions] command to get the supported version list in this region. Supported: ${K8S_VERSIONS.join(', ')}.`);
    }
    if (ex && cmpVersion(version, ex.properties.kubernetesVersion) < 0) {
      throw new ArmError('NotAllowedOperation', `Downgrading kubernetes version ${ex.properties.kubernetesVersion} to ${version} is not allowed.`);
    }
    const pools = (p.agentPoolProfiles ?? ex?.properties.agentPoolProfiles ?? [{ name: 'nodepool1', count: 3, vmSize: 'Standard_D2s_v5', mode: 'System' }]).map((x: any, i: number) => normalizePool(x, version, i));
    if (!pools.some((x: any) => x.mode === 'System')) throw new ArmError('InvalidParameter', 'A managed cluster must have at least one System agent pool.');
    const names = new Set<string>();
    for (const pl of pools) {
      if (names.has(pl.name)) throw new ArmError('InvalidParameter', `Agent pool name '${pl.name}' is duplicated.`);
      names.add(pl.name);
    }
    const dnsPrefix = p.dnsPrefix ?? ex?.properties.dnsPrefix ?? `${input.name}-${ctx.resourceGroup.name}-${ctx.subscriptionId.slice(0, 6)}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 54);
    const nodeRg = ex?.properties.nodeResourceGroup ?? p.nodeResourceGroup ?? `MC_${ctx.resourceGroup.name}_${input.name}_${input.location}`;
    const r = baseResource(input, ctx);
    r.identity = resolveIdentity(s, input.identity ?? ex?.identity ?? { type: 'SystemAssigned' }, ex?.identity, input.name, ctx.id);
    let kubelet = ex?.properties.identityProfile?.kubeletidentity;
    if (!kubelet) {
      const sp = createManagedIdentitySp(s, `${input.name}-agentpool`, `/subscriptions/${ctx.subscriptionId}/resourcegroups/${nodeRg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${input.name}-agentpool`, true);
      kubelet = { resourceId: `/subscriptions/${ctx.subscriptionId}/resourcegroups/${nodeRg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${input.name}-agentpool`, clientId: sp.appId, objectId: sp.id };
    }
    const fqdn = ex?.properties.fqdn ?? `${dnsPrefix.toLowerCase()}-${shortHash(ctx.id, 8)}.hcp.${input.location}.azmk8s.io`;
    r.sku = input.sku ?? ex?.sku ?? { name: 'Base', tier: 'Free' };
    r.properties = {
      kubernetesVersion: version,
      currentKubernetesVersion: version,
      dnsPrefix,
      fqdn,
      azurePortalFQDN: fqdn.replace('.hcp.', '.portal.hcp.'),
      agentPoolProfiles: pools,
      nodeResourceGroup: nodeRg,
      enableRBAC: true,
      supportPlan: 'KubernetesOfficial',
      networkProfile: {
        networkPlugin: p.networkProfile?.networkPlugin ?? ex?.properties.networkProfile?.networkPlugin ?? 'azure',
        networkPluginMode: 'overlay',
        networkPolicy: p.networkProfile?.networkPolicy ?? ex?.properties.networkProfile?.networkPolicy ?? 'none',
        networkDataplane: 'azure',
        loadBalancerSku: 'standard',
        podCidr: '10.244.0.0/16',
        serviceCidr: '10.0.0.0/16',
        dnsServiceIP: '10.0.0.10',
        outboundType: 'loadBalancer',
      },
      addonProfiles: p.addonProfiles ?? ex?.properties.addonProfiles ?? {},
      identityProfile: { kubeletidentity: kubelet },
      powerState: ex?.properties.powerState ?? { code: 'Running' },
      oidcIssuerProfile: { enabled: p.oidcIssuerProfile?.enabled ?? ex?.properties.oidcIssuerProfile?.enabled ?? false },
      securityProfile: p.securityProfile ?? ex?.properties.securityProfile ?? {},
      autoUpgradeProfile: { upgradeChannel: 'none', nodeOSUpgradeChannel: 'NodeImage' },
      maxAgentPools: 100,
      linuxProfile: { adminUsername: 'azureuser', ssh: { publicKeys: [{ keyData: 'ssh-rsa AAAA... generated' }] } },
      servicePrincipalProfile: { clientId: 'msi' },
    };
    const k = ex?.data?.k8s ?? emptyKube();
    r.data = { ...(r.data ?? {}), k8s: k };
    return r;
  },
  afterProvision(res, ctx) {
    const k = kubeOf(res);
    syncNodes(k, res.id, res.properties.agentPoolProfiles, res.properties.kubernetesVersion, res.properties.powerState?.code !== 'Stopped');
    ensureNodeResourceGroup(res, ctx.state);
    changed();
  },
  onDelete(res, s) {
    const nodeRg = res.properties.nodeResourceGroup;
    s.resources = s.resources.filter((r) => !(r.subscriptionId === res.subscriptionId && ciEq(r.resourceGroup, nodeRg)));
    s.resourceGroups = s.resourceGroups.filter((g) => !(g.subscriptionId === res.subscriptionId && ciEq(g.name, nodeRg)));
    const kubeletId = res.properties.identityProfile?.kubeletidentity?.objectId;
    if (kubeletId) removePrincipal(s, kubeletId);
    cleanupIdentity(res, s);
    if (s.cli.kubeContext && ciEq(s.cli.kubeContext, res.name)) s.cli.kubeContext = null;
  },
  status(res) {
    if (res.properties.provisioningState !== 'Succeeded') return res.properties.provisioningState;
    return res.properties.powerState?.code === 'Stopped' ? 'Detenido' : 'Correcto';
  },
  essentials(res, s) {
    const nodes = res.properties.agentPoolProfiles.reduce((acc: number, p: any) => acc + (p.count ?? 0), 0);
    const acrs = s.resources.filter((r) => ciEq(r.type, T_ACR) && s.roleAssignments.some((a) => a.principalId === res.properties.identityProfile?.kubeletidentity?.objectId && ciEq(a.scope, r.id)));
    return [
      ['Estado', res.properties.powerState?.code === 'Stopped' ? 'Detenido' : 'En ejecución'],
      ['Versión de Kubernetes', res.properties.kubernetesVersion],
      ['Nodos', `${nodes} (${res.properties.agentPoolProfiles.length} grupos de nodos)`],
      ['Servidor de API', res.properties.fqdn],
      ['Grupo de recursos de la infraestructura', { text: res.properties.nodeResourceGroup, link: `/subscriptions/${res.subscriptionId}/resourceGroups/${res.properties.nodeResourceGroup}` }],
      ['Red', `Azure CNI Overlay (${res.properties.networkProfile.networkPlugin})`],
      ['Registros conectados (AcrPull)', acrs.length ? acrs.map((a) => a.name).join(', ') : 'Ninguno'],
      ['Supervisión', res.properties.addonProfiles?.omsagent?.enabled ? 'Container Insights habilitado' : 'Deshabilitada'],
    ];
  },
  monthlyCost(res) {
    return res.sku?.tier === 'Standard' ? 73 : 0;
  },
});
