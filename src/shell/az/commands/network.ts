// az network vnet / subnet / peering / nsg / public-ip / nic / lb / watcher.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { deleteResource, findResource, patchResource, putResource } from '../../../engine/arm';
import { resourceId } from '../../../engine/ids';
import { ciEq, cidrContainsIp, isValidIp, parseCidr, intToIp } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg, refId } from '../helpers';
import { upsertSubnet, deleteSubnet, upsertNsgRule, deleteNsgRule, createPeering, deletePeering, setNicNsg } from '../../../engine/services/networkOps';
import { evaluateNsg, findSubnet, nicsInSubnet, ruleValues } from '../../../engine/providers/network';
import { vmNic } from '../../../engine/providers/compute';

const T_VNET = 'Microsoft.Network/virtualNetworks';
const T_NSG = 'Microsoft.Network/networkSecurityGroups';
const T_PIP = 'Microsoft.Network/publicIPAddresses';
const T_NIC = 'Microsoft.Network/networkInterfaces';
const T_LB = 'Microsoft.Network/loadBalancers';

group('network', 'Administra recursos de red de Azure.');
group('network vnet', 'Administra redes virtuales de Azure.');
group('network vnet subnet', 'Administra subredes de una red virtual.');
group('network vnet peering', 'Administra emparejamientos entre redes virtuales.');
group('network nsg', 'Administra grupos de seguridad de red (NSG).');
group('network nsg rule', 'Administra reglas de seguridad de un NSG.');
group('network public-ip', 'Administra direcciones IP públicas.');
group('network nic', 'Administra interfaces de red.');
group('network lb', 'Administra equilibradores de carga.');
group('network watcher', 'Herramientas de diagnóstico de red (Network Watcher).');

const vnetTable = (r: any) => (Array.isArray(r) ? r : [r.newVNet ?? r]).map((v: any) => ({ Name: v.name, ResourceGroup: v.resourceGroup, Location: v.location, NumSubnets: v.subnets?.length ?? 0, Prefixes: (v.addressSpace?.addressPrefixes ?? []).join(', '), DnsServers: (v.dhcpOptions?.dnsServers ?? []).join(', '), DDOSProtection: v.enableDdosProtection ?? false }));

// ---------------------------------------------------------------- vnet

register({
  path: 'network vnet create',
  summary: 'Crea una red virtual, opcionalmente con una subred.',
  args: [
    A.rg(),
    A.name('Nombre de la red virtual.'),
    A.location(),
    { name: 'address_prefixes', opts: ['--address-prefixes', '--address-prefix'], help: 'Espacio de direcciones en CIDR, separado por espacios. Por defecto 10.0.0.0/16.', type: 'list' },
    { name: 'subnet_name', opts: ['--subnet-name'], help: 'Nombre de una subred que se crea junto a la red.' },
    { name: 'subnet_prefixes', opts: ['--subnet-prefixes', '--subnet-prefix'], help: 'Prefijo CIDR de la subred. Por defecto 10.0.0.0/24.', type: 'list' },
    { name: 'nsg', opts: ['--network-security-group', '--nsg'], help: 'NSG (nombre o ID) para la subred inicial.' },
    { name: 'dns_servers', opts: ['--dns-servers'], help: 'Servidores DNS personalizados.', type: 'list' },
    A.tags(),
  ],
  examples: [{ title: 'Red con una subred.', cmd: 'az network vnet create -g rg-lab -n vnet-lab --address-prefix 10.0.0.0/16 --subnet-name snet-web --subnet-prefix 10.0.1.0/24' }],
  table: vnetTable,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const prefixes = a.address_prefixes ?? ['10.0.0.0/16'];
    const subnets = a.subnet_name ? [{ name: a.subnet_name, properties: { addressPrefix: a.subnet_prefixes?.[0] ?? '10.0.0.0/24', networkSecurityGroup: a.nsg ? { id: refId(ctx, a.nsg, T_NSG, rg.name) } : undefined } }] : [];
    const r = await putResource({ type: T_VNET, name: a.name, location: a.location, tags: a.tags, properties: { addressSpace: { addressPrefixes: prefixes }, subnets, dhcpOptions: { dnsServers: a.dns_servers ?? [] } } }, rg.name, op(ctx));
    return { newVNet: flat(r) };
  },
});

register({
  path: 'network vnet list',
  summary: 'Lista las redes virtuales.',
  args: [A.rg(false)],
  table: vnetTable,
  run: (a, ctx) => listInSub(ctx, T_VNET, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'network vnet show',
  summary: 'Obtiene los detalles de una red virtual.',
  args: [A.rg(false), A.name('Nombre de la red virtual.', false), A.ids()],
  table: vnetTable,
  run: (a, ctx) => flat(getRes(ctx, a, T_VNET)),
});

register({
  path: 'network vnet update',
  summary: 'Actualiza una red virtual (espacio de direcciones, DNS, etiquetas).',
  args: [A.rg(false), A.name('Nombre de la red virtual.', false), A.ids(), { name: 'address_prefixes', opts: ['--address-prefixes'], help: 'Nuevo espacio de direcciones.', type: 'list' }, { name: 'dns_servers', opts: ['--dns-servers'], help: 'Servidores DNS.', type: 'list' }, A.tags()],
  async run(a, ctx) {
    const v = getRes(ctx, a, T_VNET);
    const r = await putResource({ type: T_VNET, name: v.name, location: v.location, tags: a.tags ?? v.tags, properties: { ...v.properties, addressSpace: { addressPrefixes: a.address_prefixes ?? v.properties.addressSpace.addressPrefixes }, dhcpOptions: { dnsServers: a.dns_servers ?? v.properties.dhcpOptions?.dnsServers ?? [] } } }, v.resourceGroup, op(ctx));
    return flat(r);
  },
});

register({
  path: 'network vnet delete',
  summary: 'Elimina una red virtual.',
  args: [A.rg(false), A.name('Nombre de la red virtual.', false), A.ids(), A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_VNET).id, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'network vnet check-ip-address',
  summary: 'Comprueba si una IP privada está disponible en la red virtual.',
  args: [A.rg(), A.name('Nombre de la red virtual.'), { name: 'ip_address', opts: ['--ip-address'], help: 'IP privada a comprobar.', required: true }],
  run(a, ctx) {
    const v = getRes(ctx, a, T_VNET);
    if (!isValidIp(a.ip_address)) throw cliError(`'${a.ip_address}' is not a valid IP address.`);
    const used = new Set<string>();
    for (const sn of v.properties.subnets ?? []) for (const n of nicsInSubnet(sn.id)) used.add(n.properties.ipConfigurations?.[0]?.properties?.privateIPAddress);
    const sn = (v.properties.subnets ?? []).find((x: any) => cidrContainsIp(x.properties.addressPrefix, a.ip_address));
    if (!sn) return { available: false, availableIPAddresses: [] };
    const c = parseCidr(sn.properties.addressPrefix)!;
    const reserved = new Set([0, 1, 2, 3, c.size - 1].map((i) => intToIp(c.base + i)));
    const available = !used.has(a.ip_address) && !reserved.has(a.ip_address);
    const alt: string[] = [];
    for (let i = 4; i < c.size - 1 && alt.length < 5; i++) {
      const ip = intToIp(c.base + i);
      if (!used.has(ip)) alt.push(ip);
    }
    return available ? { available: true } : { available: false, availableIPAddresses: alt };
  },
});

// ---------------------------------------------------------------- subnet

const subnetTable = (r: any) => (Array.isArray(r) ? r : [r]).map((s: any) => ({ Name: s.name, ResourceGroup: s.resourceGroup, AddressPrefix: s.addressPrefix, PrivateEndpointNetworkPolicies: s.privateEndpointNetworkPolicies, ProvisioningState: s.provisioningState }));

function subnetJson(vnet: any, sn: any) {
  return { ...sn.properties, id: sn.id, name: sn.name, resourceGroup: vnet.resourceGroup, type: sn.type, ipConfigurations: nicsInSubnet(sn.id).map((n) => ({ id: `${n.id}/ipConfigurations/ipconfig1`, resourceGroup: n.resourceGroup })) };
}

function vnetArg(ctx: AzCtx, a: Args) {
  const rg = requireRg(ctx, a.resource_group);
  const v = findResource(resourceId(ctx.subscriptionId, rg.name, T_VNET, a.vnet_name));
  if (!v) throw new ArmError('ResourceNotFound', `The Resource 'Microsoft.Network/virtualNetworks/${a.vnet_name}' under resource group '${rg.name}' was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix`, 404);
  return v;
}

const vnetNameArg = { name: 'vnet_name', opts: ['--vnet-name'], help: 'Nombre de la red virtual.', required: true };

register({
  path: 'network vnet subnet create',
  summary: 'Crea una subred y la asocia a una red virtual existente.',
  args: [A.rg(), vnetNameArg, A.name('Nombre de la subred.'), { name: 'address_prefixes', opts: ['--address-prefixes', '--address-prefix'], help: 'Prefijo CIDR de la subred (debe estar dentro del espacio de la VNet y no solaparse).', type: 'list', required: true }, { name: 'nsg', opts: ['--network-security-group', '--nsg'], help: 'NSG (nombre o ID) que se asocia a la subred.' }, { name: 'service_endpoints', opts: ['--service-endpoints'], help: 'Puntos de conexión de servicio, p. ej. Microsoft.Storage.', type: 'list' }],
  examples: [{ title: 'Crear una subred con NSG.', cmd: 'az network vnet subnet create -g rg-lab --vnet-name vnet-lab -n snet-app --address-prefixes 10.0.2.0/24 --nsg nsg-app' }],
  table: subnetTable,
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    const sn = upsertSubnet(v.id, { name: a.name, addressPrefix: a.address_prefixes[0], nsgId: a.nsg ? refId(ctx, a.nsg, T_NSG, v.resourceGroup) : undefined, serviceEndpoints: a.service_endpoints }, ctx.principal);
    return subnetJson(v, sn);
  },
});

register({
  path: 'network vnet subnet update',
  summary: 'Actualiza una subred (prefijo, NSG, puntos de conexión).',
  args: [A.rg(), vnetNameArg, A.name('Nombre de la subred.'), { name: 'address_prefixes', opts: ['--address-prefixes', '--address-prefix'], help: 'Nuevo prefijo.', type: 'list' }, { name: 'nsg', opts: ['--network-security-group', '--nsg'], help: 'NSG a asociar ("" para quitarlo).' }, { name: 'remove', opts: ['--remove'], help: 'Quita una propiedad, p. ej. networkSecurityGroup.' }, { name: 'service_endpoints', opts: ['--service-endpoints'], help: 'Puntos de conexión de servicio.', type: 'list' }],
  table: subnetTable,
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    const existing = (v.properties.subnets ?? []).find((x: any) => ciEq(x.name, a.name));
    if (!existing) throw new ArmError('NotFound', `Subnet '${a.name}' not found.`, 404);
    let nsgId: string | null | undefined = undefined;
    if (a.nsg === '' || a.remove === 'networkSecurityGroup') nsgId = null;
    else if (a.nsg) nsgId = refId(ctx, a.nsg, T_NSG, v.resourceGroup);
    const sn = upsertSubnet(v.id, { name: a.name, addressPrefix: a.address_prefixes?.[0], nsgId, serviceEndpoints: a.service_endpoints }, ctx.principal);
    return subnetJson(v, sn);
  },
});

register({
  path: 'network vnet subnet list',
  summary: 'Lista las subredes de una red virtual.',
  args: [A.rg(), vnetNameArg],
  table: subnetTable,
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    return (v.properties.subnets ?? []).map((sn: any) => subnetJson(v, sn));
  },
});

register({
  path: 'network vnet subnet show',
  summary: 'Muestra una subred.',
  args: [A.rg(), vnetNameArg, A.name('Nombre de la subred.')],
  table: subnetTable,
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    const sn = (v.properties.subnets ?? []).find((x: any) => ciEq(x.name, a.name));
    if (!sn) throw new ArmError('NotFound', `Resource ${v.id}/subnets/${a.name} not found.`, 404);
    return subnetJson(v, sn);
  },
});

register({
  path: 'network vnet subnet delete',
  summary: 'Elimina una subred.',
  args: [A.rg(), vnetNameArg, A.name('Nombre de la subred.')],
  run(a, ctx) {
    deleteSubnet(vnetArg(ctx, a).id, a.name, ctx.principal);
    return undefined;
  },
});

// ---------------------------------------------------------------- peering

register({
  path: 'network vnet peering create',
  summary: 'Crea un emparejamiento entre dos redes virtuales (hay que crearlo en ambos sentidos).',
  args: [A.rg(), A.name('Nombre del emparejamiento.'), vnetNameArg, { name: 'remote_vnet', opts: ['--remote-vnet'], help: 'Nombre (mismo grupo) o ID de la red remota.', required: true }, { name: 'allow_vnet_access', opts: ['--allow-vnet-access'], help: 'Permite el acceso desde la red remota.', type: 'bool' }, { name: 'allow_forwarded_traffic', opts: ['--allow-forwarded-traffic'], help: 'Permite el tráfico reenviado.', type: 'bool' }, { name: 'allow_gateway_transit', opts: ['--allow-gateway-transit'], help: 'Permite el tránsito por gateway.', type: 'bool' }, { name: 'use_remote_gateways', opts: ['--use-remote-gateways'], help: 'Usa los gateways remotos.', type: 'bool' }],
  examples: [{ title: 'Emparejar hub y spoke (ejecutar en los dos sentidos).', cmd: 'az network vnet peering create -g rg-lab -n hub-a-spoke --vnet-name vnet-hub --remote-vnet vnet-spoke --allow-vnet-access' }],
  table: (p: any) => ({ Name: p.name, PeeringState: p.peeringState, AllowVirtualNetworkAccess: p.allowVirtualNetworkAccess, ResourceGroup: p.resourceGroup }),
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    const p = createPeering(v.id, a.name, refId(ctx, a.remote_vnet, T_VNET, v.resourceGroup)!, { allowVnetAccess: a.allow_vnet_access ?? true, allowForwardedTraffic: a.allow_forwarded_traffic, allowGatewayTransit: a.allow_gateway_transit, useRemoteGateways: a.use_remote_gateways }, ctx.principal);
    if (p.properties.peeringState === 'Initiated') ctx.warn('El emparejamiento está en estado "Initiated": crea también el emparejamiento en la red remota para que pase a "Connected".');
    return { ...p.properties, id: p.id, name: p.name, resourceGroup: v.resourceGroup, type: p.type };
  },
});

register({
  path: 'network vnet peering list',
  summary: 'Lista los emparejamientos de una red virtual.',
  args: [A.rg(), vnetNameArg],
  table: (r: any[]) => r.map((p) => ({ Name: p.name, PeeringState: p.peeringState, RemoteVnet: p.remoteVirtualNetwork?.id?.split('/').pop(), AllowVirtualNetworkAccess: p.allowVirtualNetworkAccess })),
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    return (v.properties.virtualNetworkPeerings ?? []).map((p: any) => ({ ...p.properties, id: p.id, name: p.name, resourceGroup: v.resourceGroup, type: p.type }));
  },
});

register({
  path: 'network vnet peering show',
  summary: 'Muestra un emparejamiento.',
  args: [A.rg(), vnetNameArg, A.name('Nombre del emparejamiento.')],
  run(a, ctx) {
    const v = vnetArg(ctx, a);
    const p = (v.properties.virtualNetworkPeerings ?? []).find((x: any) => ciEq(x.name, a.name));
    if (!p) throw new ArmError('NotFound', `Peering '${a.name}' not found.`, 404);
    return { ...p.properties, id: p.id, name: p.name, resourceGroup: v.resourceGroup, type: p.type };
  },
});

register({
  path: 'network vnet peering delete',
  summary: 'Elimina un emparejamiento.',
  args: [A.rg(), vnetNameArg, A.name('Nombre del emparejamiento.')],
  run(a, ctx) {
    deletePeering(vnetArg(ctx, a).id, a.name, ctx.principal);
    return undefined;
  },
});

// ---------------------------------------------------------------- nsg

register({
  path: 'network nsg create',
  summary: 'Crea un grupo de seguridad de red.',
  args: [A.rg(), A.name('Nombre del NSG.'), A.location(), A.tags()],
  table: (r: any) => ({ Name: r.NewNSG.name, ResourceGroup: r.NewNSG.resourceGroup, Location: r.NewNSG.location }),
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const r = await putResource({ type: T_NSG, name: a.name, location: a.location, tags: a.tags, properties: { securityRules: [] } }, rg.name, op(ctx));
    return { NewNSG: flat(r) };
  },
});

register({
  path: 'network nsg list',
  summary: 'Lista los grupos de seguridad de red.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((n) => ({ Name: n.name, ResourceGroup: n.resourceGroup, Location: n.location, ProvisioningState: n.provisioningState })),
  run: (a, ctx) => listInSub(ctx, T_NSG, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'network nsg show',
  summary: 'Muestra un NSG.',
  args: [A.rg(false), A.name('Nombre del NSG.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, T_NSG)),
});

register({
  path: 'network nsg delete',
  summary: 'Elimina un NSG.',
  args: [A.rg(false), A.name('Nombre del NSG.', false), A.ids(), A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_NSG).id, op(ctx, a));
    return undefined;
  },
});

const ruleTable = (r: any) =>
  (Array.isArray(r) ? r : [r]).map((x: any) => ({
    Name: x.name,
    ResourceGroup: x.resourceGroup,
    Priority: x.priority,
    SourcePortRanges: (x.sourcePortRanges?.length ? x.sourcePortRanges : [x.sourcePortRange]).join(' '),
    SourceAddressPrefixes: (x.sourceAddressPrefixes?.length ? x.sourceAddressPrefixes : [x.sourceAddressPrefix]).join(' '),
    SourceASG: 'None',
    Access: x.access,
    Protocol: x.protocol,
    Direction: x.direction,
    DestinationPortRanges: (x.destinationPortRanges?.length ? x.destinationPortRanges : [x.destinationPortRange]).join(' '),
    DestinationAddressPrefixes: (x.destinationAddressPrefixes?.length ? x.destinationAddressPrefixes : [x.destinationAddressPrefix]).join(' '),
    DestinationASG: 'None',
  }));

function nsgArg(ctx: AzCtx, a: Args) {
  const rg = requireRg(ctx, a.resource_group);
  const n = findResource(resourceId(ctx.subscriptionId, rg.name, T_NSG, a.nsg_name));
  if (!n) throw new ArmError('ResourceNotFound', `The Resource 'Microsoft.Network/networkSecurityGroups/${a.nsg_name}' under resource group '${rg.name}' was not found.`, 404);
  return n;
}

const nsgNameArg = { name: 'nsg_name', opts: ['--nsg-name'], help: 'Nombre del NSG.', required: true };
const ruleArgs = [
  { name: 'priority', opts: ['--priority'], help: 'Prioridad (100-4096). Menor número = se evalúa antes.', type: 'int' as const },
  { name: 'direction', opts: ['--direction'], help: 'Dirección del tráfico.', choices: ['Inbound', 'Outbound'] },
  { name: 'access', opts: ['--access'], help: 'Permitir o denegar.', choices: ['Allow', 'Deny'] },
  { name: 'protocol', opts: ['--protocol'], help: 'Protocolo de red.', choices: ['Tcp', 'Udp', 'Icmp', 'Esp', 'Ah', '*'] },
  { name: 'source_address_prefixes', opts: ['--source-address-prefixes'], help: 'Prefijos de origen: CIDR, IP, * o etiquetas (Internet, VirtualNetwork, AzureLoadBalancer).', type: 'list' as const },
  { name: 'source_port_ranges', opts: ['--source-port-ranges'], help: 'Puertos de origen (normalmente *).', type: 'list' as const },
  { name: 'destination_address_prefixes', opts: ['--destination-address-prefixes'], help: 'Prefijos de destino.', type: 'list' as const },
  { name: 'destination_port_ranges', opts: ['--destination-port-ranges'], help: 'Puertos de destino, p. ej. 80 443 o 8000-8080.', type: 'list' as const },
  { name: 'description', opts: ['--description'], help: 'Descripción.' },
];

function ruleJson(nsg: any, r: any) {
  return { ...r.properties, id: r.id, name: r.name, resourceGroup: nsg.resourceGroup, type: r.type };
}

register({
  path: 'network nsg rule create',
  summary: 'Crea una regla de seguridad en un NSG.',
  args: [A.rg(), nsgNameArg, A.name('Nombre de la regla.'), ...ruleArgs.map((x) => (x.name === 'priority' ? { ...x, required: true } : x))],
  examples: [
    { title: 'Permitir HTTP desde Internet.', cmd: 'az network nsg rule create -g rg-lab --nsg-name nsg-web -n allow-http --priority 100 --destination-port-ranges 80 --access Allow --protocol Tcp' },
    { title: 'Permitir SSH sólo desde tu IP.', cmd: 'az network nsg rule create -g rg-lab --nsg-name nsg-web -n allow-ssh --priority 110 --source-address-prefixes $(curl -s ifconfig.me) --destination-port-ranges 22 --protocol Tcp' },
  ],
  table: ruleTable,
  run(a, ctx) {
    const nsg = nsgArg(ctx, a);
    const r = upsertNsgRule(nsg.id, { name: a.name, properties: { priority: a.priority, direction: a.direction ?? 'Inbound', access: a.access ?? 'Allow', protocol: a.protocol ?? '*', sourceAddressPrefixes: a.source_address_prefixes ?? ['*'], sourcePortRanges: a.source_port_ranges ?? ['*'], destinationAddressPrefixes: a.destination_address_prefixes ?? ['*'], destinationPortRanges: a.destination_port_ranges ?? ['80'], description: a.description } }, ctx.principal);
    return ruleJson(nsg, r);
  },
});

register({
  path: 'network nsg rule update',
  summary: 'Actualiza una regla de seguridad.',
  args: [A.rg(), nsgNameArg, A.name('Nombre de la regla.'), ...ruleArgs],
  table: ruleTable,
  run(a, ctx) {
    const nsg = nsgArg(ctx, a);
    const cur = (nsg.properties.securityRules ?? []).find((x: any) => ciEq(x.name, a.name));
    if (!cur) throw new ArmError('NotFound', `Security rule '${a.name}' not found.`, 404);
    const p = cur.properties;
    const r = upsertNsgRule(nsg.id, {
      name: a.name,
      properties: {
        priority: a.priority ?? p.priority,
        direction: a.direction ?? p.direction,
        access: a.access ?? p.access,
        protocol: a.protocol ?? p.protocol,
        sourceAddressPrefixes: a.source_address_prefixes ?? ruleValues(cur, 'sourceAddressPrefix'),
        sourcePortRanges: a.source_port_ranges ?? ruleValues(cur, 'sourcePortRange'),
        destinationAddressPrefixes: a.destination_address_prefixes ?? ruleValues(cur, 'destinationAddressPrefix'),
        destinationPortRanges: a.destination_port_ranges ?? ruleValues(cur, 'destinationPortRange'),
        description: a.description ?? p.description,
      },
    }, ctx.principal);
    return ruleJson(nsg, r);
  },
});

register({
  path: 'network nsg rule list',
  summary: 'Lista las reglas de un NSG.',
  args: [A.rg(), nsgNameArg, { name: 'include_default', opts: ['--include-default'], help: 'Incluye las reglas predeterminadas.', type: 'bool' }],
  table: ruleTable,
  run(a, ctx) {
    const nsg = nsgArg(ctx, a);
    const rules = [...(nsg.properties.securityRules ?? []), ...(a.include_default ? nsg.properties.defaultSecurityRules ?? [] : [])];
    return rules.map((r: any) => ruleJson(nsg, r));
  },
});

register({
  path: 'network nsg rule show',
  summary: 'Muestra una regla de seguridad.',
  args: [A.rg(), nsgNameArg, A.name('Nombre de la regla.')],
  table: ruleTable,
  run(a, ctx) {
    const nsg = nsgArg(ctx, a);
    const r = (nsg.properties.securityRules ?? []).find((x: any) => ciEq(x.name, a.name));
    if (!r) throw new ArmError('NotFound', `Security rule '${a.name}' not found.`, 404);
    return ruleJson(nsg, r);
  },
});

register({
  path: 'network nsg rule delete',
  summary: 'Elimina una regla de seguridad.',
  args: [A.rg(), nsgNameArg, A.name('Nombre de la regla.')],
  run(a, ctx) {
    deleteNsgRule(nsgArg(ctx, a).id, a.name, ctx.principal);
    return undefined;
  },
});

// ---------------------------------------------------------------- public ip

register({
  path: 'network public-ip create',
  summary: 'Crea una dirección IP pública.',
  args: [A.rg(), A.name('Nombre de la IP pública.'), A.location(), A.sku('SKU de la IP pública (Basic se retiró en septiembre de 2025).', ['Basic', 'Standard'], 'Standard'), { name: 'allocation_method', opts: ['--allocation-method'], help: 'Método de asignación.', choices: ['Static', 'Dynamic'] }, { name: 'dns_name', opts: ['--dns-name'], help: 'Etiqueta DNS: <etiqueta>.<region>.cloudapp.azure.com' }, { name: 'zone', opts: ['--zone', '-z'], help: 'Zonas de disponibilidad.', type: 'list' }, A.tags()],
  table: (r: any) => ({ Name: r.publicIp.name, IpAddress: r.publicIp.ipAddress, Sku: r.publicIp.sku?.name, Fqdn: r.publicIp.dnsSettings?.fqdn ?? '' }),
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const r = await putResource({ type: T_PIP, name: a.name, location: a.location, tags: a.tags, sku: { name: a.sku }, zones: a.zone, properties: { publicIPAllocationMethod: a.allocation_method ?? 'Static', dnsSettings: a.dns_name ? { domainNameLabel: a.dns_name } : undefined } }, rg.name, op(ctx));
    return { publicIp: flat(r) };
  },
});

register({
  path: 'network public-ip list',
  summary: 'Lista las IP públicas.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((p) => ({ Name: p.name, ResourceGroup: p.resourceGroup, Location: p.location, Zones: (p.zones ?? []).join(','), Address: p.ipAddress, IdleTimeoutInMinutes: p.idleTimeoutInMinutes, ProvisioningState: p.provisioningState })),
  run: (a, ctx) => listInSub(ctx, T_PIP, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'network public-ip show',
  summary: 'Muestra una IP pública.',
  args: [A.rg(false), A.name('Nombre de la IP pública.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, T_PIP)),
});

register({
  path: 'network public-ip update',
  summary: 'Actualiza una IP pública.',
  args: [A.rg(false), A.name('Nombre de la IP pública.', false), A.ids(), { name: 'dns_name', opts: ['--dns-name'], help: 'Etiqueta DNS.' }, A.tags()],
  async run(a, ctx) {
    const p = getRes(ctx, a, T_PIP);
    const r = await putResource({ type: T_PIP, name: p.name, location: p.location, tags: a.tags ?? p.tags, sku: p.sku, properties: { ...p.properties, dnsSettings: a.dns_name !== undefined ? (a.dns_name ? { domainNameLabel: a.dns_name } : undefined) : p.properties.dnsSettings } }, p.resourceGroup, op(ctx));
    return flat(r);
  },
});

register({
  path: 'network public-ip delete',
  summary: 'Elimina una IP pública.',
  args: [A.rg(false), A.name('Nombre de la IP pública.', false), A.ids(), A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_PIP).id, op(ctx, a));
    return undefined;
  },
});

// ---------------------------------------------------------------- nic

register({
  path: 'network nic create',
  summary: 'Crea una interfaz de red.',
  args: [A.rg(), A.name('Nombre de la NIC.'), A.location(), { name: 'vnet_name', opts: ['--vnet-name'], help: 'Red virtual (si --subnet es un nombre).' }, { name: 'subnet', opts: ['--subnet'], help: 'Nombre o ID de la subred.', required: true }, { name: 'public_ip_address', opts: ['--public-ip-address'], help: 'Nombre o ID de una IP pública.' }, { name: 'nsg', opts: ['--network-security-group'], help: 'Nombre o ID de un NSG.' }, { name: 'private_ip_address', opts: ['--private-ip-address'], help: 'IP privada estática.' }, A.tags()],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const subnetId = a.subnet.startsWith('/') ? a.subnet : `${resourceId(ctx.subscriptionId, rg.name, T_VNET, a.vnet_name ?? '')}/subnets/${a.subnet}`;
    if (!a.subnet.startsWith('/') && !a.vnet_name) throw cliError('usage error: --subnet NAME --vnet-name NAME | --subnet ID', undefined, true);
    const r = await putResource({ type: T_NIC, name: a.name, location: a.location, tags: a.tags, properties: { ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: subnetId }, publicIPAddress: a.public_ip_address ? { id: refId(ctx, a.public_ip_address, T_PIP, rg.name) } : undefined, privateIPAddress: a.private_ip_address, privateIPAllocationMethod: a.private_ip_address ? 'Static' : 'Dynamic' } }], networkSecurityGroup: a.nsg ? { id: refId(ctx, a.nsg, T_NSG, rg.name) } : undefined } }, rg.name, op(ctx));
    return { NewNIC: flat(r) };
  },
});

register({
  path: 'network nic list',
  summary: 'Lista las interfaces de red.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((n) => ({ Name: n.name, ResourceGroup: n.resourceGroup, Location: n.location, MacAddress: n.macAddress, Primary: n.primary, ProvisioningState: n.provisioningState })),
  run: (a, ctx) => listInSub(ctx, T_NIC, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'network nic show',
  summary: 'Muestra una interfaz de red.',
  args: [A.rg(false), A.name('Nombre de la NIC.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, T_NIC)),
});

register({
  path: 'network nic update',
  summary: 'Actualiza una interfaz de red (p. ej. su NSG).',
  args: [A.rg(false), A.name('Nombre de la NIC.', false), A.ids(), { name: 'nsg', opts: ['--network-security-group'], help: 'NSG a asociar ("" para quitarlo).' }, A.tags()],
  run(a, ctx) {
    const nic = getRes(ctx, a, T_NIC);
    if (a.nsg !== undefined) setNicNsg(nic.id, a.nsg ? refId(ctx, a.nsg, T_NSG, nic.resourceGroup)! : null, ctx.principal);
    if (a.tags) patchResource(nic.id, (r) => (r.tags = a.tags), { principal: ctx.principal });
    return flat(nic);
  },
});

register({
  path: 'network nic delete',
  summary: 'Elimina una interfaz de red.',
  args: [A.rg(false), A.name('Nombre de la NIC.', false), A.ids(), A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_NIC).id, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'network nic list-effective-nsg',
  summary: 'Muestra las reglas de seguridad efectivas aplicadas a una NIC (subred + NIC).',
  args: [A.rg(), A.name('Nombre de la NIC.')],
  run(a, ctx) {
    const nic = getRes(ctx, a, T_NIC);
    const s = getState();
    const sn = findSubnet(nic.properties.ipConfigurations?.[0]?.properties?.subnet?.id ?? '');
    const ids = [sn?.subnet.properties.networkSecurityGroup?.id, nic.properties.networkSecurityGroup?.id].filter(Boolean);
    return {
      value: ids.map((id) => {
        const nsg = s.resources.find((r) => ciEq(r.id, id));
        const assoc = ciEq(id, nic.properties.networkSecurityGroup?.id) ? { networkInterface: { id: nic.id } } : { subnet: { id: sn!.subnet.id } };
        return {
          association: assoc,
          effectiveSecurityRules: [...(nsg?.properties.securityRules ?? []).map((r: any) => ({ ...r, name: `securityRules/${r.name}` })), ...(nsg?.properties.defaultSecurityRules ?? []).map((r: any) => ({ ...r, name: `defaultSecurityRules/${r.name}` }))].map((r: any) => ({
            access: r.properties.access,
            destinationAddressPrefix: ruleValues(r, 'destinationAddressPrefix').join(','),
            destinationPortRange: ruleValues(r, 'destinationPortRange').join(','),
            direction: r.properties.direction,
            name: r.name,
            priority: r.properties.priority,
            protocol: r.properties.protocol === '*' ? 'All' : r.properties.protocol,
            sourceAddressPrefix: ruleValues(r, 'sourceAddressPrefix').join(','),
            sourcePortRange: ruleValues(r, 'sourcePortRange').join(','),
          })),
          networkSecurityGroup: { id, resourceGroup: nsg?.resourceGroup },
        };
      }),
    };
  },
});

register({
  path: 'network nic ip-config address-pool add',
  summary: 'Añade la configuración IP de una NIC a un grupo de back-end de un equilibrador de carga.',
  args: [A.rg(), { name: 'nic_name', opts: ['--nic-name'], help: 'Nombre de la NIC.', required: true }, { name: 'ip_config_name', opts: ['--ip-config-name', '-n'], help: 'Nombre de la configuración IP (normalmente ipconfig1).', required: true }, { name: 'lb_name', opts: ['--lb-name'], help: 'Nombre del equilibrador de carga.' }, { name: 'address_pool', opts: ['--address-pool'], help: 'Nombre o ID del grupo de back-end.', required: true }],
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const nic = findResource(resourceId(ctx.subscriptionId, rg.name, T_NIC, a.nic_name));
    if (!nic) throw new ArmError('ResourceNotFound', `Network interface '${a.nic_name}' not found.`, 404);
    const poolId = a.address_pool.startsWith('/') ? a.address_pool : `${resourceId(ctx.subscriptionId, rg.name, T_LB, a.lb_name ?? '')}/backendAddressPools/${a.address_pool}`;
    const lb = findResource(poolId.split('/backendAddressPools/')[0]);
    if (!lb || !(lb.properties.backendAddressPools ?? []).some((p: any) => ciEq(p.id, poolId))) throw new ArmError('NotFound', `Backend address pool '${a.address_pool}' not found.`, 404);
    patchResource(nic.id, (r) => {
      const ic = r.properties.ipConfigurations[0].properties;
      ic.loadBalancerBackendAddressPools = [...(ic.loadBalancerBackendAddressPools ?? []).filter((p: any) => !ciEq(p.id, poolId)), { id: poolId }];
    }, { principal: ctx.principal, opName: 'Añadir NIC al grupo de back-end' });
    const ic = nic.properties.ipConfigurations[0];
    return { ...ic.properties, id: ic.id, name: ic.name, resourceGroup: nic.resourceGroup };
  },
});

// ---------------------------------------------------------------- load balancer

function lbArg(ctx: AzCtx, a: Args) {
  const rg = requireRg(ctx, a.resource_group);
  const lb = findResource(resourceId(ctx.subscriptionId, rg.name, T_LB, a.lb_name ?? a.name));
  if (!lb) throw new ArmError('ResourceNotFound', `The Resource 'Microsoft.Network/loadBalancers/${a.lb_name ?? a.name}' under resource group '${rg.name}' was not found.`, 404);
  return lb;
}

register({
  path: 'network lb create',
  summary: 'Crea un equilibrador de carga Standard.',
  args: [A.rg(), A.name('Nombre del equilibrador.'), A.location(), A.sku('SKU.', ['Basic', 'Standard', 'Gateway'], 'Standard'), { name: 'public_ip_address', opts: ['--public-ip-address'], help: 'Nombre o ID de la IP pública del front-end (se crea si no existe).' }, { name: 'frontend_ip_name', opts: ['--frontend-ip-name'], help: 'Nombre de la configuración de front-end.', default: 'LoadBalancerFrontEnd' }, { name: 'backend_pool_name', opts: ['--backend-pool-name'], help: 'Nombre del grupo de back-end.', default: `bepool` }, A.tags()],
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    if (a.sku === 'Basic') throw new ArmError('BasicSkuLoadBalancerRetired', 'Basic SKU load balancers were retired on September 30, 2025. Use the Standard SKU.', 400);
    let pipId = a.public_ip_address ? refId(ctx, a.public_ip_address, T_PIP, rg.name)! : undefined;
    if (pipId && !findResource(pipId)) {
      const pip = await putResource({ type: T_PIP, name: pipId.split('/').pop()!, location: a.location ?? rg.location, sku: { name: 'Standard' }, properties: {} }, rg.name, op(ctx));
      pipId = pip.id;
    }
    const lbId = resourceId(ctx.subscriptionId, rg.name, T_LB, a.name);
    const r = await putResource({ type: T_LB, name: a.name, location: a.location, tags: a.tags, sku: { name: 'Standard' }, properties: { frontendIPConfigurations: [{ name: a.frontend_ip_name, properties: { publicIPAddress: pipId ? { id: pipId } : undefined } }], backendAddressPools: [{ name: a.backend_pool_name, properties: {} }], loadBalancingRules: [], probes: [] } }, rg.name, op(ctx));
    void lbId;
    return { loadBalancer: flat(r) };
  },
});

register({
  path: 'network lb list',
  summary: 'Lista los equilibradores de carga.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, ResourceGroup: x.resourceGroup, Location: x.location, ProvisioningState: x.provisioningState })),
  run: (a, ctx) => listInSub(ctx, T_LB, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'network lb show',
  summary: 'Muestra un equilibrador de carga.',
  args: [A.rg(false), A.name('Nombre del equilibrador.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, T_LB)),
});

register({
  path: 'network lb delete',
  summary: 'Elimina un equilibrador de carga.',
  args: [A.rg(false), A.name('Nombre del equilibrador.', false), A.ids()],
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_LB).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'network lb probe create',
  summary: 'Crea un sondeo de estado.',
  args: [A.rg(), { name: 'lb_name', opts: ['--lb-name'], help: 'Equilibrador.', required: true }, A.name('Nombre del sondeo.'), { name: 'protocol', opts: ['--protocol'], help: 'Protocolo.', choices: ['Http', 'Tcp', 'Https'], required: true }, { name: 'port', opts: ['--port'], help: 'Puerto.', type: 'int', required: true }, { name: 'path', opts: ['--path'], help: 'Ruta (HTTP).' }, { name: 'interval', opts: ['--interval'], help: 'Intervalo en segundos.', type: 'int', default: 15 }],
  run(a, ctx) {
    const lb = lbArg(ctx, a);
    const probe = { name: a.name, id: `${lb.id}/probes/${a.name}`, properties: { protocol: a.protocol, port: a.port, requestPath: a.path ?? (a.protocol !== 'Tcp' ? '/' : undefined), intervalInSeconds: a.interval, numberOfProbes: 1, probeThreshold: 1 } };
    patchResource(lb.id, (r) => (r.properties.probes = [...(r.properties.probes ?? []).filter((p: any) => !ciEq(p.name, a.name)), probe]), { principal: ctx.principal, opName: 'Crear sondeo de estado' });
    return { ...probe.properties, id: probe.id, name: probe.name, resourceGroup: lb.resourceGroup };
  },
});

register({
  path: 'network lb rule create',
  summary: 'Crea una regla de equilibrio de carga.',
  args: [A.rg(), { name: 'lb_name', opts: ['--lb-name'], help: 'Equilibrador.', required: true }, A.name('Nombre de la regla.'), { name: 'protocol', opts: ['--protocol'], help: 'Protocolo.', choices: ['Tcp', 'Udp', 'All'], required: true }, { name: 'frontend_port', opts: ['--frontend-port'], help: 'Puerto de front-end.', type: 'int', required: true }, { name: 'backend_port', opts: ['--backend-port'], help: 'Puerto de back-end.', type: 'int', required: true }, { name: 'frontend_ip_name', opts: ['--frontend-ip-name', '--frontend-ip'], help: 'Front-end.' }, { name: 'backend_pool_name', opts: ['--backend-pool-name'], help: 'Grupo de back-end.' }, { name: 'probe_name', opts: ['--probe-name', '--probe'], help: 'Sondeo de estado.' }, { name: 'disable_outbound_snat', opts: ['--disable-outbound-snat'], help: 'Deshabilita SNAT de salida.', type: 'bool' }],
  run(a, ctx) {
    const lb = lbArg(ctx, a);
    const fe = a.frontend_ip_name ?? lb.properties.frontendIPConfigurations?.[0]?.name;
    const be = a.backend_pool_name ?? lb.properties.backendAddressPools?.[0]?.name;
    if (a.probe_name && !(lb.properties.probes ?? []).some((p: any) => ciEq(p.name, a.probe_name))) throw new ArmError('NotFound', `Probe '${a.probe_name}' not found.`, 404);
    const rule = { name: a.name, id: `${lb.id}/loadBalancingRules/${a.name}`, properties: { protocol: a.protocol, frontendPort: a.frontend_port, backendPort: a.backend_port, frontendIPConfiguration: { id: `${lb.id}/frontendIPConfigurations/${fe}` }, backendAddressPool: { id: `${lb.id}/backendAddressPools/${be}` }, probe: a.probe_name ? { id: `${lb.id}/probes/${a.probe_name}` } : undefined, idleTimeoutInMinutes: 4, enableFloatingIP: false, loadDistribution: 'Default', disableOutboundSnat: !!a.disable_outbound_snat } };
    patchResource(lb.id, (r) => (r.properties.loadBalancingRules = [...(r.properties.loadBalancingRules ?? []).filter((x: any) => !ciEq(x.name, a.name)), rule]), { principal: ctx.principal, opName: 'Crear regla de equilibrio de carga' });
    return { ...rule.properties, id: rule.id, name: rule.name, resourceGroup: lb.resourceGroup };
  },
});

register({
  path: 'network lb address-pool list',
  summary: 'Lista los grupos de back-end.',
  args: [A.rg(), { name: 'lb_name', opts: ['--lb-name'], help: 'Equilibrador.', required: true }],
  run(a, ctx) {
    const lb = lbArg(ctx, a);
    const s = getState();
    return (lb.properties.backendAddressPools ?? []).map((p: any) => ({ id: p.id, name: p.name, resourceGroup: lb.resourceGroup, backendIPConfigurations: s.resources.filter((n) => ciEq(n.type, T_NIC) && (n.properties.ipConfigurations?.[0]?.properties?.loadBalancerBackendAddressPools ?? []).some((x: any) => ciEq(x.id, p.id))).map((n) => ({ id: `${n.id}/ipConfigurations/ipconfig1`, resourceGroup: n.resourceGroup })) }));
  },
});

// ---------------------------------------------------------------- network watcher

register({
  path: 'network watcher test-ip-flow',
  summary: 'Comprueba si el tráfico hacia o desde una VM está permitido o denegado por las reglas de NSG (verificación de flujo IP).',
  args: [A.rg(false), { name: 'vm', opts: ['--vm'], help: 'Nombre o ID de la VM.', required: true }, { name: 'direction', opts: ['--direction'], help: 'Dirección.', choices: ['Inbound', 'Outbound'], required: true }, { name: 'protocol', opts: ['--protocol'], help: 'Protocolo.', choices: ['TCP', 'UDP'], required: true }, { name: 'local', opts: ['--local'], help: 'IP:puerto local (de la VM).', required: true }, { name: 'remote', opts: ['--remote'], help: 'IP:puerto remoto.', required: true }, { name: 'nic', opts: ['--nic'], help: 'NIC de la VM.' }],
  examples: [{ title: '¿Puede llegar HTTP desde Internet a la VM?', cmd: 'az network watcher test-ip-flow -g rg-lab --vm vm-web --direction Inbound --protocol TCP --local 10.0.1.4:80 --remote 20.1.2.3:60000' }],
  run(a, ctx) {
    const s = getState();
    const vm = a.vm.startsWith('/') ? findResource(a.vm) : s.resources.find((r) => ciEq(r.type, 'Microsoft.Compute/virtualMachines') && ciEq(r.name, a.vm) && (!a.resource_group || ciEq(r.resourceGroup, a.resource_group)));
    if (!vm) throw new ArmError('ResourceNotFound', `Virtual machine '${a.vm}' not found.`, 404);
    const nic = vmNic(vm, s);
    if (!nic) throw new ArmError('NotFound', 'The VM has no NIC.', 404);
    const [, lport] = String(a.local).split(':');
    const [rip] = String(a.remote).split(':');
    const sn = findSubnet(nic.properties.ipConfigurations?.[0]?.properties?.subnet?.id ?? '');
    const ids = [sn?.subnet.properties.networkSecurityGroup?.id, nic.properties.networkSecurityGroup?.id].filter(Boolean) as string[];
    if (!ids.length) return { access: a.direction === 'Inbound' ? 'Allow' : 'Allow', ruleName: 'Ningún NSG asociado (con IP pública Standard el tráfico entrante sigue bloqueado por defecto)' };
    const proto = a.protocol === 'UDP' ? 'Udp' : 'Tcp';
    const internal = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(rip);
    for (const id of ids) {
      const nsg = s.resources.find((r) => ciEq(r.id, id))!;
      if (a.direction === 'Outbound') {
        const rules = [...(nsg.properties.securityRules ?? []), ...(nsg.properties.defaultSecurityRules ?? [])].filter((r: any) => r.properties.direction === 'Outbound').sort((x: any, y: any) => x.properties.priority - y.properties.priority);
        const hit = rules[0];
        return { access: hit?.properties.access ?? 'Allow', ruleName: `${(nsg.properties.securityRules ?? []).includes(hit) ? 'securityRules' : 'defaultSecurityRules'}/${hit?.name}` };
      }
      const d = evaluateNsg(nsg, Number(lport), proto, rip, internal ? 'VirtualNetwork' : 'Internet', 'nic');
      if (!d.allowed) return { access: 'Deny', ruleName: `${(nsg.properties.securityRules ?? []).some((r: any) => r.name === d.rule) ? 'securityRules' : 'defaultSecurityRules'}/${d.rule}` };
      if (id === ids[ids.length - 1]) return { access: 'Allow', ruleName: `${(nsg.properties.securityRules ?? []).some((r: any) => r.name === d.rule) ? 'securityRules' : 'defaultSecurityRules'}/${d.rule}` };
    }
    return { access: 'Allow', ruleName: '' };
  },
});

register({
  path: 'network watcher configure',
  summary: 'Habilita Network Watcher en una región.',
  args: [A.rg(), { name: 'locations', opts: ['--locations', '-l'], help: 'Regiones.', type: 'list', required: true }, { name: 'enabled', opts: ['--enabled'], help: 'Habilitado.', type: 'bool' }],
  run(a, ctx) {
    return (a.locations as string[]).map((l) => ({ id: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${a.resource_group}/providers/Microsoft.Network/networkWatchers/NetworkWatcher_${l}`, location: l, name: `NetworkWatcher_${l}`, provisioningState: 'Succeeded', resourceGroup: a.resource_group, type: 'Microsoft.Network/networkWatchers' }));
  },
});

export function _changedNetwork() {
  changed();
}
