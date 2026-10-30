// Microsoft.Network: redes virtuales, subredes, NSG, IP públicas, interfaces de red y balanceadores.
import type { CloudState, Resource } from '../types';
import { registerProvider, baseResource, type ArmInput, type BuildCtx } from '../registry';
import { ArmError } from '../errors';
import { cidrContains, cidrOverlap, ciEq, guid, intToIp, ipToInt, macFromSeed, parseCidr, randomPublicIp } from '../util';
import { isWithinScope } from '../ids';
import { getState } from '../store';

const T_VNET = 'Microsoft.Network/virtualNetworks';
const T_NSG = 'Microsoft.Network/networkSecurityGroups';
const T_PIP = 'Microsoft.Network/publicIPAddresses';
const T_NIC = 'Microsoft.Network/networkInterfaces';
const T_LB = 'Microsoft.Network/loadBalancers';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,78}[a-zA-Z0-9_]$|^[a-zA-Z0-9]$/;
const nameRule = { test: (n: string) => NAME_RE.test(n), message: "The name '{name}' is invalid. It must begin with a letter or number, end with a letter, number or underscore, and may contain only letters, numbers, underscores, periods, or hyphens (máx. 80 caracteres)." };

// ---------------------------------------------------------------- helpers

export function findSubnet(subnetId: string, s: CloudState = getState()): { vnet: Resource; subnet: any } | undefined {
  const lower = subnetId.toLowerCase();
  for (const v of s.resources) {
    if (!ciEq(v.type, T_VNET)) continue;
    const sn = (v.properties.subnets ?? []).find((x: any) => x.id.toLowerCase() === lower);
    if (sn) return { vnet: v, subnet: sn };
  }
  return undefined;
}

export function nicsInSubnet(subnetId: string, s: CloudState = getState()): Resource[] {
  return s.resources.filter((r) => ciEq(r.type, T_NIC) && (r.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.subnet?.id, subnetId)));
}

export function allocatePrivateIp(subnetId: string, s: CloudState = getState(), exclude: string[] = []): string {
  const found = findSubnet(subnetId, s);
  if (!found) throw new ArmError('InvalidResourceReference', `Resource ${subnetId} referenced by resource was not found.`, 400);
  const c = parseCidr(found.subnet.properties.addressPrefix)!;
  const used = new Set<string>(exclude);
  for (const nic of nicsInSubnet(subnetId, s)) for (const ic of nic.properties.ipConfigurations ?? []) if (ic.properties?.privateIPAddress) used.add(ic.properties.privateIPAddress);
  for (const lb of s.resources.filter((r) => ciEq(r.type, T_LB))) for (const f of lb.properties.frontendIPConfigurations ?? []) if (f.properties?.privateIPAddress) used.add(f.properties.privateIPAddress);
  for (let i = 4; i < c.size - 1; i++) {
    const ip = intToIp(c.base + i);
    if (!used.has(ip)) return ip;
  }
  throw new ArmError('SubnetIsFull', `Subnet ${found.subnet.name} with address prefix ${found.subnet.properties.addressPrefix} does not have enough capacity for 1 IP addresses.`, 400);
}

export function defaultSecurityRules(nsgId: string) {
  const mk = (name: string, priority: number, direction: string, access: string, src: string, dst: string, description: string) => ({
    name,
    id: `${nsgId}/defaultSecurityRules/${name}`,
    type: 'Microsoft.Network/networkSecurityGroups/defaultSecurityRules',
    properties: {
      description,
      protocol: '*',
      sourcePortRange: '*',
      destinationPortRange: '*',
      sourceAddressPrefix: src,
      destinationAddressPrefix: dst,
      access,
      priority,
      direction,
      provisioningState: 'Succeeded',
      sourceAddressPrefixes: [],
      destinationAddressPrefixes: [],
      sourcePortRanges: [],
      destinationPortRanges: [],
    },
  });
  return [
    mk('AllowVnetInBound', 65000, 'Inbound', 'Allow', 'VirtualNetwork', 'VirtualNetwork', 'Allow inbound traffic from all VMs in VNET'),
    mk('AllowAzureLoadBalancerInBound', 65001, 'Inbound', 'Allow', 'AzureLoadBalancer', '*', 'Allow inbound traffic from azure load balancer'),
    mk('DenyAllInBound', 65500, 'Inbound', 'Deny', '*', '*', 'Deny all inbound traffic'),
    mk('AllowVnetOutBound', 65000, 'Outbound', 'Allow', 'VirtualNetwork', 'VirtualNetwork', 'Allow outbound traffic from all VMs to all VMs in VNET'),
    mk('AllowInternetOutBound', 65001, 'Outbound', 'Allow', '*', 'Internet', 'Allow outbound traffic from all VMs to Internet'),
    mk('DenyAllOutBound', 65500, 'Outbound', 'Deny', '*', '*', 'Deny all outbound traffic'),
  ];
}

const PORT_RE = /^(\*|\d{1,5}(-\d{1,5})?)$/;

function asList(v: any): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(/[\s,]+/)).filter(Boolean);
  return String(v).split(/[\s,]+/).filter(Boolean);
}

function validPort(p: string) {
  if (!PORT_RE.test(p)) return false;
  if (p === '*') return true;
  const [a, b] = p.split('-').map(Number);
  return a >= 0 && a <= 65535 && (b === undefined || (b >= a && b <= 65535));
}

export function normalizeSecurityRule(nsgId: string, raw: any) {
  const p = raw.properties ?? raw;
  const name = raw.name;
  if (!name) throw new ArmError('InvalidRequestFormat', 'Security rule name is required.');
  const priority = Number(p.priority);
  if (!Number.isInteger(priority) || priority < 100 || priority > 4096) {
    throw new ArmError('SecurityRuleInvalidPriority', `Security rule ${name} has invalid Priority. Value provided: ${p.priority}. Allowed range 100-4096.`);
  }
  const dir = ciEq(p.direction, 'Outbound') ? 'Outbound' : 'Inbound';
  const access = ciEq(p.access, 'Deny') ? 'Deny' : 'Allow';
  let protocol = String(p.protocol ?? '*');
  const protoMap: Record<string, string> = { tcp: 'Tcp', udp: 'Udp', icmp: 'Icmp', '*': '*', any: '*', esp: 'Esp', ah: 'Ah' };
  protocol = protoMap[protocol.toLowerCase()];
  if (!protocol) throw new ArmError('SecurityRuleInvalidProtocol', `Security rule ${name} has invalid Protocol '${p.protocol}'. Allowed values: Tcp, Udp, Icmp, Esp, Ah, *.`);
  const src = asList(p.sourceAddressPrefixes?.length ? p.sourceAddressPrefixes : p.sourceAddressPrefix ?? '*');
  const dst = asList(p.destinationAddressPrefixes?.length ? p.destinationAddressPrefixes : p.destinationAddressPrefix ?? '*');
  const sport = asList(p.sourcePortRanges?.length ? p.sourcePortRanges : p.sourcePortRange ?? '*');
  const dport = asList(p.destinationPortRanges?.length ? p.destinationPortRanges : p.destinationPortRange ?? '*');
  for (const port of [...sport, ...dport]) {
    if (!validPort(port)) throw new ArmError('SecurityRuleInvalidPortRange', `Security rule ${name} has invalid Port range. Value provided: ${port}. Value should be an integer OR integer range with '-' delimiter. Valid range 0-65535.`);
  }
  const one = (arr: string[]) => (arr.length === 1 ? arr[0] : null);
  const many = (arr: string[]) => (arr.length > 1 ? arr : []);
  return {
    name,
    id: `${nsgId}/securityRules/${name}`,
    type: 'Microsoft.Network/networkSecurityGroups/securityRules',
    properties: {
      description: p.description ?? null,
      protocol,
      sourcePortRange: one(sport),
      sourcePortRanges: many(sport),
      destinationPortRange: one(dport),
      destinationPortRanges: many(dport),
      sourceAddressPrefix: one(src),
      sourceAddressPrefixes: many(src),
      destinationAddressPrefix: one(dst),
      destinationAddressPrefixes: many(dst),
      access,
      priority,
      direction: dir,
      provisioningState: 'Succeeded',
    },
  };
}

export function validateRuleSet(rules: any[]) {
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (ciEq(a.name, b.name)) throw new ArmError('InvalidRequestFormat', `Duplicate security rule name ${a.name}.`);
      if (a.properties.priority === b.properties.priority && a.properties.direction === b.properties.direction) {
        throw new ArmError('SecurityRuleConflict', `Security rule ${b.name} conflicts with rule ${a.name}. Rules cannot have the same Priority and Direction. To learn more, see aka.ms/nsgrules.`);
      }
    }
  }
}

export function ruleValues(r: any, which: 'sourceAddressPrefix' | 'destinationAddressPrefix' | 'sourcePortRange' | 'destinationPortRange'): string[] {
  const p = r.properties;
  const plural = p[which + (which.endsWith('Range') ? 's' : 'es')];
  if (plural?.length) return plural;
  return p[which] ? [p[which]] : [];
}

function nsgAssociations(nsg: Resource, s: CloudState) {
  const subnets: { id: string }[] = [];
  for (const v of s.resources.filter((r) => ciEq(r.type, T_VNET))) {
    for (const sn of v.properties.subnets ?? []) if (ciEq(sn.properties?.networkSecurityGroup?.id, nsg.id)) subnets.push({ id: sn.id });
  }
  const nics = s.resources.filter((r) => ciEq(r.type, T_NIC) && ciEq(r.properties.networkSecurityGroup?.id, nsg.id)).map((r) => ({ id: r.id }));
  return { subnets, networkInterfaces: nics };
}

function normalizeSubnet(vnetId: string, raw: any, s: CloudState) {
  const p = raw.properties ?? raw;
  const name = raw.name;
  const prefix = p.addressPrefix ?? p.addressPrefixes?.[0];
  if (!name) throw new ArmError('InvalidRequestFormat', 'Subnet name is required.');
  if (!parseCidr(prefix)) throw new ArmError('InvalidAddressPrefixFormat', `Address prefix ${prefix} of resource ${vnetId}/subnets/${name} is not formatted correctly. It should follow CIDR notation, for example 10.0.0.0/24.`);
  const c = parseCidr(prefix)!;
  if (c.bits > 29) throw new ArmError('NetcfgInvalidSubnet', `Subnet ${name} is not valid in virtual network. Subnet prefix /${c.bits} is too small: the smallest supported subnet is /29.`);
  const nsgId = p.networkSecurityGroup?.id;
  if (nsgId && !s.resources.some((r) => ciEq(r.id, nsgId))) {
    throw new ArmError('InvalidResourceReference', `Resource ${nsgId} referenced by resource ${vnetId}/subnets/${name} was not found. Please make sure that the referenced resource exists, and that both resources are in the same region.`, 404);
  }
  return {
    name,
    id: `${vnetId}/subnets/${name}`,
    type: 'Microsoft.Network/virtualNetworks/subnets',
    properties: {
      addressPrefix: `${intToIp(c.base)}/${c.bits}`,
      networkSecurityGroup: nsgId ? { id: s.resources.find((r) => ciEq(r.id, nsgId))!.id } : undefined,
      routeTable: p.routeTable,
      serviceEndpoints: p.serviceEndpoints ?? [],
      delegations: p.delegations ?? [],
      privateEndpointNetworkPolicies: p.privateEndpointNetworkPolicies ?? 'Disabled',
      privateLinkServiceNetworkPolicies: p.privateLinkServiceNetworkPolicies ?? 'Enabled',
      defaultOutboundAccess: p.defaultOutboundAccess ?? false,
      provisioningState: 'Succeeded',
    },
  };
}

export function validateVnetLayout(vnetName: string, prefixes: string[], subnets: any[]) {
  for (const pr of prefixes) {
    if (!parseCidr(pr)) throw new ArmError('InvalidAddressPrefixFormat', `Address prefix ${pr} of virtual network ${vnetName} is not formatted correctly. It should follow CIDR notation, for example 10.0.0.0/16.`);
  }
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      if (cidrOverlap(prefixes[i], prefixes[j])) throw new ArmError('NetcfgInvalidAddressPrefix', `Address prefixes ${prefixes[i]} and ${prefixes[j]} of virtual network ${vnetName} overlap.`);
    }
  }
  for (const sn of subnets) {
    if (!prefixes.some((pr) => cidrContains(pr, sn.properties.addressPrefix))) {
      throw new ArmError('NetcfgSubnetRangeOutsideVnet', `Subnet '${sn.name}' is not valid because its IP address range is outside the IP address range of virtual network '${vnetName}'.`);
    }
  }
  for (let i = 0; i < subnets.length; i++) {
    for (let j = i + 1; j < subnets.length; j++) {
      if (ciEq(subnets[i].name, subnets[j].name)) throw new ArmError('InvalidRequestFormat', `Duplicate subnet name '${subnets[i].name}'.`);
      if (cidrOverlap(subnets[i].properties.addressPrefix, subnets[j].properties.addressPrefix)) {
        throw new ArmError('NetcfgSubnetRangesOverlap', `Subnet '${subnets[j].name}' is not valid in virtual network '${vnetName}' because its IP address range overlaps with that of an existing subnet '${subnets[i].name}'.`);
      }
    }
  }
}

// ---------------------------------------------------------------- Virtual networks

registerProvider({
  type: T_VNET,
  label: 'Red virtual',
  labelPlural: 'Redes virtuales',
  icon: 'vnet',
  category: 'Redes',
  description: 'Red privada aislada en Azure donde se comunican tus recursos.',
  provisionMs: 1800,
  nameRule: { test: (n) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_]$|^[a-zA-Z0-9]$/.test(n), message: "Virtual network name '{name}' is invalid (2-64 caracteres: letras, números, '_', '.', '-')." },
  build(input: ArmInput, ctx: BuildCtx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const prefixes: string[] = p.addressSpace?.addressPrefixes ?? ex?.properties.addressSpace?.addressPrefixes ?? ['10.0.0.0/16'];
    const rawSubnets: any[] = p.subnets ?? ex?.properties.subnets ?? [];
    const subnets = rawSubnets.map((sn) => normalizeSubnet(ctx.id, sn, ctx.state));
    validateVnetLayout(input.name, prefixes, subnets);
    if (ex) {
      // no se pueden eliminar subredes en uso
      for (const old of ex.properties.subnets ?? []) {
        if (!subnets.some((sn) => ciEq(sn.name, old.name)) && nicsInSubnet(old.id, ctx.state).length) {
          throw new ArmError('InUseSubnetCannotBeDeleted', `Subnet ${old.name} is in use by ${nicsInSubnet(old.id, ctx.state)[0].id}/ipConfigurations/ipconfig1 and cannot be deleted. In order to delete the subnet, delete all the resources within the subnet. See aka.ms/deletesubnet.`);
        }
      }
    }
    const r = baseResource(input, ctx);
    r.properties = {
      addressSpace: { addressPrefixes: prefixes },
      dhcpOptions: { dnsServers: p.dhcpOptions?.dnsServers ?? ex?.properties.dhcpOptions?.dnsServers ?? [] },
      subnets,
      virtualNetworkPeerings: ex?.properties.virtualNetworkPeerings ?? [],
      enableDdosProtection: p.enableDdosProtection ?? false,
      resourceGuid: ex?.properties.resourceGuid ?? guid(),
    };
    return r;
  },
  beforeDelete(res, s) {
    for (const sn of res.properties.subnets ?? []) {
      const nics = nicsInSubnet(sn.id, s);
      if (nics.length) {
        throw new ArmError(
          'InUseSubnetCannotBeDeleted',
          `Subnet ${sn.name} is in use by ${nics[0].id}/ipConfigurations/ipconfig1 and cannot be deleted. In order to delete the subnet, delete all the resources within the subnet. See aka.ms/deletesubnet.`,
          400,
          'Elimina antes las máquinas virtuales / interfaces de red conectadas a la red, o borra el grupo de recursos completo.',
        );
      }
    }
  },
  onDelete(res, s) {
    for (const v of s.resources.filter((r) => ciEq(r.type, T_VNET) && r.id !== res.id)) {
      for (const p of v.properties.virtualNetworkPeerings ?? []) {
        if (ciEq(p.properties.remoteVirtualNetwork?.id, res.id)) p.properties.peeringState = 'Disconnected';
      }
    }
  },
  decorate(res, s) {
    return {
      subnets: (res.properties.subnets ?? []).map((sn: any) => {
        const nics = nicsInSubnet(sn.id, s);
        return {
          ...sn,
          properties: {
            ...sn.properties,
            ipConfigurations: nics.length ? nics.map((n) => ({ id: `${n.id}/ipConfigurations/ipconfig1` })) : undefined,
          },
        };
      }),
    };
  },
  essentials(res) {
    return [
      ['Espacio de direcciones', (res.properties.addressSpace?.addressPrefixes ?? []).join(', ')],
      ['Servidores DNS', res.properties.dhcpOptions?.dnsServers?.length ? res.properties.dhcpOptions.dnsServers.join(', ') : 'Proporcionado por Azure'],
      ['Subredes', String(res.properties.subnets?.length ?? 0)],
      ['Emparejamientos', String(res.properties.virtualNetworkPeerings?.length ?? 0)],
    ];
  },
  monthlyCost: () => 0,
});

// ---------------------------------------------------------------- NSG

registerProvider({
  type: T_NSG,
  label: 'Grupo de seguridad de red',
  labelPlural: 'Grupos de seguridad de red',
  icon: 'nsg',
  category: 'Redes',
  description: 'Firewall de capa 4 con reglas de entrada y salida para subredes e interfaces.',
  provisionMs: 1200,
  nameRule,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const rules = (p.securityRules ?? ex?.properties.securityRules ?? []).map((r: any) => normalizeSecurityRule(ctx.id, r));
    validateRuleSet(rules);
    const r = baseResource(input, ctx);
    r.properties = {
      securityRules: rules,
      defaultSecurityRules: defaultSecurityRules(ctx.id),
      resourceGuid: ex?.properties.resourceGuid ?? guid(),
      flowLogs: [],
    };
    return r;
  },
  beforeDelete(res, s) {
    const a = nsgAssociations(res, s);
    const list = [...a.subnets, ...a.networkInterfaces].map((x) => x.id);
    if (list.length) {
      throw new ArmError(
        'InUseNetworkSecurityGroupCannotBeDeleted',
        `Network security group ${res.id} cannot be deleted because it is in use by the following resources: ${list.join(', ')}. In order to delete the Network security group, remove the association with the resource(s).`,
        400,
        'Desasocia primero el NSG de la subred o interfaz de red.',
      );
    }
  },
  decorate(res, s) {
    const a = nsgAssociations(res, s);
    return { subnets: a.subnets.length ? a.subnets : undefined, networkInterfaces: a.networkInterfaces.length ? a.networkInterfaces : undefined };
  },
  essentials(res, s) {
    const a = nsgAssociations(res, s);
    return [
      ['Reglas de seguridad personalizadas', `${(res.properties.securityRules ?? []).filter((r: any) => r.properties.direction === 'Inbound').length} de entrada, ${(res.properties.securityRules ?? []).filter((r: any) => r.properties.direction === 'Outbound').length} de salida`],
      ['Asociado a', `${a.subnets.length} subredes, ${a.networkInterfaces.length} interfaces de red`],
    ];
  },
  monthlyCost: () => 0,
});

// ---------------------------------------------------------------- Public IP

registerProvider({
  type: T_PIP,
  label: 'Dirección IP pública',
  labelPlural: 'Direcciones IP públicas',
  icon: 'pip',
  category: 'Redes',
  description: 'Dirección IP accesible desde Internet para VMs, balanceadores o gateways.',
  provisionMs: 1000,
  nameRule,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const skuName = input.sku?.name ?? ex?.sku?.name ?? 'Standard';
    if (ciEq(skuName, 'Basic')) {
      throw new ArmError('BasicSkuPublicIpRetired', 'Basic SKU public IP addresses were retired on September 30, 2025. Use the Standard SKU instead.', 400, 'Desde el 30/09/2025 sólo existen IP públicas Standard (siempre estáticas).');
    }
    const label = p.dnsSettings?.domainNameLabel ?? ex?.properties.dnsSettings?.domainNameLabel;
    if (label && !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(label)) {
      throw new ArmError('InvalidDomainNameLabel', `The domain name label ${label} is invalid. It must conform to the following regular expression: ^[a-z][a-z0-9-]{1,61}[a-z0-9]$.`);
    }
    if (label && !ex) {
      const taken = ctx.state.resources.some((r) => ciEq(r.type, T_PIP) && ciEq(r.location, input.location) && ciEq(r.properties.dnsSettings?.domainNameLabel, label));
      if (taken) throw new ArmError('DnsRecordInUse', `DNS record ${label}.${input.location}.cloudapp.azure.com is already used by another public IP.`, 409);
    }
    const r = baseResource(input, ctx);
    r.sku = { name: 'Standard', tier: input.sku?.tier ?? ex?.sku?.tier ?? 'Regional' };
    r.properties = {
      ipAddress: ex?.properties.ipAddress ?? randomPublicIp(ctx.id + Date.now()),
      publicIPAllocationMethod: 'Static',
      publicIPAddressVersion: p.publicIPAddressVersion ?? 'IPv4',
      idleTimeoutInMinutes: p.idleTimeoutInMinutes ?? 4,
      dnsSettings: label ? { domainNameLabel: label, fqdn: `${label}.${input.location}.cloudapp.azure.com` } : undefined,
      ipTags: [],
      resourceGuid: ex?.properties.resourceGuid ?? guid(),
      ddosSettings: { protectionMode: 'VirtualNetworkInherited' },
    };
    return r;
  },
  beforeDelete(res, s) {
    const nic = s.resources.find((r) => ciEq(r.type, T_NIC) && (r.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.publicIPAddress?.id, res.id)));
    const lb = s.resources.find((r) => ciEq(r.type, T_LB) && (r.properties.frontendIPConfigurations ?? []).some((c: any) => ciEq(c.properties?.publicIPAddress?.id, res.id)));
    const user = nic ? `${nic.id}/ipConfigurations/ipconfig1` : lb?.id;
    if (user) {
      throw new ArmError('PublicIPAddressCannotBeDeleted', `Public IP address ${res.id} can not be deleted since it is still allocated to resource ${user}. In order to delete the public IP, disassociate/detach the Public IP address from the resource.`, 400);
    }
  },
  decorate(res, s) {
    const nic = s.resources.find((r) => ciEq(r.type, T_NIC) && (r.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.publicIPAddress?.id, res.id)));
    return { ipConfiguration: nic ? { id: `${nic.id}/ipConfigurations/ipconfig1`, resourceGroup: nic.resourceGroup } : undefined };
  },
  essentials(res, s) {
    const nic = s.resources.find((r) => ciEq(r.type, T_NIC) && (r.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.publicIPAddress?.id, res.id)));
    return [
      ['Dirección IP', res.properties.ipAddress],
      ['SKU', res.sku?.name ?? 'Standard'],
      ['Nombre DNS', res.properties.dnsSettings?.fqdn ?? '-'],
      ['Asociado a', nic ? { text: nic.name, link: nic.id } : '-'],
    ];
  },
  monthlyCost: () => 3.65,
});

// ---------------------------------------------------------------- NIC

registerProvider({
  type: T_NIC,
  label: 'Interfaz de red',
  labelPlural: 'Interfaces de red',
  icon: 'nic',
  category: 'Redes',
  provisionMs: 800,
  nameRule,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const rawIc = (p.ipConfigurations ?? ex?.properties.ipConfigurations ?? [])[0];
    if (!rawIc) throw new ArmError('InvalidRequestFormat', 'A network interface must have at least one IP configuration.');
    const icp = rawIc.properties ?? rawIc;
    const subnetId = icp.subnet?.id;
    if (!subnetId || !findSubnet(subnetId, ctx.state)) {
      throw new ArmError('InvalidResourceReference', `Resource ${subnetId} referenced by resource ${ctx.id} was not found.`, 404);
    }
    const sn = findSubnet(subnetId, ctx.state)!;
    if (!ciEq(sn.vnet.location, input.location)) {
      throw new ArmError('InvalidResourceReference', `Subnet ${sn.subnet.name} is in location ${sn.vnet.location}, but the network interface is in ${input.location}. Resources must be in the same region.`);
    }
    const pipId = icp.publicIPAddress?.id;
    if (pipId) {
      const pip = ctx.state.resources.find((r) => ciEq(r.id, pipId));
      if (!pip) throw new ArmError('InvalidResourceReference', `Resource ${pipId} referenced by resource ${ctx.id} was not found.`, 404);
      const usedBy = ctx.state.resources.find((r) => ciEq(r.type, T_NIC) && r.id !== ctx.id && (r.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.publicIPAddress?.id, pipId)));
      if (usedBy) throw new ArmError('PublicIPAddressInUse', `Resource ${pipId} is already in use by ${usedBy.id}/ipConfigurations/ipconfig1.`, 400);
    }
    const nsgId = p.networkSecurityGroup?.id;
    if (nsgId && !ctx.state.resources.some((r) => ciEq(r.id, nsgId))) {
      throw new ArmError('InvalidResourceReference', `Resource ${nsgId} referenced by resource ${ctx.id} was not found.`, 404);
    }
    const prevIp = ex?.properties.ipConfigurations?.[0]?.properties?.privateIPAddress;
    const sameSubnet = ex && ciEq(ex.properties.ipConfigurations?.[0]?.properties?.subnet?.id, subnetId);
    const privateIp = icp.privateIPAddress ?? (sameSubnet ? prevIp : allocatePrivateIp(sn.subnet.id, ctx.state));
    const r = baseResource(input, ctx);
    r.properties = {
      ipConfigurations: [
        {
          name: rawIc.name ?? 'ipconfig1',
          id: `${ctx.id}/ipConfigurations/${rawIc.name ?? 'ipconfig1'}`,
          type: 'Microsoft.Network/networkInterfaces/ipConfigurations',
          properties: {
            privateIPAddress: privateIp,
            privateIPAllocationMethod: icp.privateIPAllocationMethod ?? 'Dynamic',
            privateIPAddressVersion: 'IPv4',
            subnet: { id: sn.subnet.id, resourceGroup: sn.vnet.resourceGroup },
            publicIPAddress: pipId ? { id: ctx.state.resources.find((x) => ciEq(x.id, pipId))!.id } : undefined,
            primary: true,
            provisioningState: 'Succeeded',
          },
        },
      ],
      networkSecurityGroup: nsgId ? { id: ctx.state.resources.find((x) => ciEq(x.id, nsgId))!.id } : undefined,
      virtualMachine: p.virtualMachine ?? ex?.properties.virtualMachine,
      macAddress: ex?.properties.macAddress ?? macFromSeed(ctx.id),
      enableAcceleratedNetworking: p.enableAcceleratedNetworking ?? false,
      enableIPForwarding: p.enableIPForwarding ?? false,
      primary: true,
      nicType: 'Standard',
      resourceGuid: ex?.properties.resourceGuid ?? guid(),
    };
    return r;
  },
  beforeDelete(res, s) {
    const vmId = res.properties.virtualMachine?.id;
    if (vmId && s.resources.some((r) => ciEq(r.id, vmId))) {
      throw new ArmError('NicInUse', `Network Interface ${res.id} is used by existing resource ${vmId}. In order to delete the network interface, it must be dissociated from the resource. To learn more, see aka.ms/deletenic.`, 400);
    }
  },
  essentials(res, s) {
    const ic = res.properties.ipConfigurations?.[0]?.properties ?? {};
    const pip = ic.publicIPAddress?.id ? s.resources.find((r) => ciEq(r.id, ic.publicIPAddress.id)) : undefined;
    const sn = ic.subnet?.id ? findSubnet(ic.subnet.id, s) : undefined;
    const vm = res.properties.virtualMachine?.id ? s.resources.find((r) => ciEq(r.id, res.properties.virtualMachine.id)) : undefined;
    const nsg = res.properties.networkSecurityGroup?.id ? s.resources.find((r) => ciEq(r.id, res.properties.networkSecurityGroup.id)) : undefined;
    return [
      ['IP privada', ic.privateIPAddress ?? '-'],
      ['IP pública', pip ? { text: pip.properties.ipAddress, link: pip.id } : '-'],
      ['Red/Subred', sn ? { text: `${sn.vnet.name}/${sn.subnet.name}`, link: sn.vnet.id } : '-'],
      ['Máquina virtual', vm ? { text: vm.name, link: vm.id } : '-'],
      ['NSG', nsg ? { text: nsg.name, link: nsg.id } : 'Ninguno'],
    ];
  },
  monthlyCost: () => 0,
});

// ---------------------------------------------------------------- Load balancer (básico, usado sobre todo por AKS)

registerProvider({
  type: T_LB,
  label: 'Equilibrador de carga',
  labelPlural: 'Equilibradores de carga',
  icon: 'lb',
  category: 'Redes',
  description: 'Distribuye tráfico TCP/UDP entre instancias de back-end.',
  provisionMs: 1500,
  nameRule,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const r = baseResource(input, ctx);
    r.sku = { name: 'Standard', tier: 'Regional' };
    const fe = (p.frontendIPConfigurations ?? ex?.properties.frontendIPConfigurations ?? []).map((f: any) => ({
      name: f.name,
      id: `${ctx.id}/frontendIPConfigurations/${f.name}`,
      properties: { ...(f.properties ?? {}) },
    }));
    r.properties = {
      frontendIPConfigurations: fe,
      backendAddressPools: (p.backendAddressPools ?? ex?.properties.backendAddressPools ?? []).map((b: any) => ({ name: b.name, id: `${ctx.id}/backendAddressPools/${b.name}`, properties: b.properties ?? {} })),
      loadBalancingRules: p.loadBalancingRules ?? ex?.properties.loadBalancingRules ?? [],
      probes: p.probes ?? ex?.properties.probes ?? [],
      inboundNatRules: p.inboundNatRules ?? ex?.properties.inboundNatRules ?? [],
      outboundRules: p.outboundRules ?? ex?.properties.outboundRules ?? [],
      resourceGuid: ex?.properties.resourceGuid ?? guid(),
    };
    return r;
  },
  essentials(res) {
    return [
      ['SKU', 'Standard'],
      ['Front-ends', String(res.properties.frontendIPConfigurations?.length ?? 0)],
      ['Reglas', String(res.properties.loadBalancingRules?.length ?? 0)],
    ];
  },
  monthlyCost: (res) => 18.25 + (res.properties.loadBalancingRules?.length ?? 0) * 7.3,
});

// ---------------------------------------------------------------- Evaluación de tráfico NSG (para curl/ssh simulados)

export const CLOUD_SHELL_IP = '20.31.118.42';

function addressMatches(prefix: string, sourceIp: string, sourceTag: 'Internet' | 'VirtualNetwork'): boolean {
  const p = prefix.trim();
  if (p === '*' || ciEq(p, 'Any')) return true;
  if (ciEq(p, 'Internet')) return sourceTag === 'Internet';
  if (ciEq(p, 'VirtualNetwork')) return sourceTag === 'VirtualNetwork';
  if (ciEq(p, 'AzureLoadBalancer')) return false;
  if (p.includes('/')) {
    const c = parseCidr(p);
    if (!c) return false;
    const n = ipToInt(sourceIp);
    return n >= c.base && n < c.base + c.size;
  }
  return p === sourceIp;
}

function portMatches(range: string, port: number): boolean {
  if (range === '*') return true;
  if (range.includes('-')) {
    const [a, b] = range.split('-').map(Number);
    return port >= a && port <= b;
  }
  return Number(range) === port;
}

export interface NsgDecision {
  allowed: boolean;
  nsg: Resource | null;
  rule: string;
  priority: number;
  stage: 'subnet' | 'nic';
}

export function evaluateNsg(nsg: Resource, port: number, protocol: 'Tcp' | 'Udp', sourceIp: string, sourceTag: 'Internet' | 'VirtualNetwork', stage: 'subnet' | 'nic'): NsgDecision {
  const rules = [...(nsg.properties.securityRules ?? []), ...(nsg.properties.defaultSecurityRules ?? [])]
    .filter((r: any) => r.properties.direction === 'Inbound')
    .sort((a: any, b: any) => a.properties.priority - b.properties.priority);
  for (const r of rules) {
    const pr = r.properties;
    if (pr.protocol !== '*' && !ciEq(pr.protocol, protocol)) continue;
    if (!ruleValues(r, 'sourceAddressPrefix').some((x) => addressMatches(x, sourceIp, sourceTag))) continue;
    if (!ruleValues(r, 'destinationPortRange').some((x) => portMatches(x, port))) continue;
    return { allowed: pr.access === 'Allow', nsg, rule: r.name, priority: pr.priority, stage };
  }
  return { allowed: false, nsg, rule: 'DenyAllInBound', priority: 65500, stage };
}

/** Evalúa si el tráfico entrante desde Internet puede llegar a una NIC por un puerto. */
export function inboundAllowed(nic: Resource, port: number, protocol: 'Tcp' | 'Udp' = 'Tcp', sourceIp = CLOUD_SHELL_IP, s: CloudState = getState()): { allowed: boolean; decisions: NsgDecision[]; reason: string } {
  const decisions: NsgDecision[] = [];
  const subnetId = nic.properties.ipConfigurations?.[0]?.properties?.subnet?.id;
  const sn = subnetId ? findSubnet(subnetId, s) : undefined;
  const subnetNsgId = sn?.subnet.properties.networkSecurityGroup?.id;
  const nicNsgId = nic.properties.networkSecurityGroup?.id;
  const subnetNsg = subnetNsgId ? s.resources.find((r) => ciEq(r.id, subnetNsgId)) : undefined;
  const nicNsg = nicNsgId ? s.resources.find((r) => ciEq(r.id, nicNsgId)) : undefined;
  if (!subnetNsg && !nicNsg) {
    // Con IP pública Standard, sin NSG el tráfico entrante está bloqueado por defecto (seguro por defecto).
    return { allowed: false, decisions, reason: 'La IP pública Standard es segura por defecto: sin un NSG que lo permita, todo el tráfico entrante se bloquea.' };
  }
  if (subnetNsg) {
    const d = evaluateNsg(subnetNsg, port, protocol, sourceIp, 'Internet', 'subnet');
    decisions.push(d);
    if (!d.allowed) return { allowed: false, decisions, reason: `Bloqueado por la regla "${d.rule}" (prioridad ${d.priority}) del NSG "${subnetNsg.name}" asociado a la subred.` };
  }
  if (nicNsg) {
    const d = evaluateNsg(nicNsg, port, protocol, sourceIp, 'Internet', 'nic');
    decisions.push(d);
    if (!d.allowed) return { allowed: false, decisions, reason: `Bloqueado por la regla "${d.rule}" (prioridad ${d.priority}) del NSG "${nicNsg.name}" asociado a la interfaz de red.` };
  }
  return { allowed: true, decisions, reason: `Permitido por ${decisions.map((d) => `"${d.rule}" (${d.nsg?.name})`).join(' y ')}.` };
}

export function vnetOfSubnetId(subnetId: string): string {
  return subnetId.split('/subnets/')[0];
}

export function peeringBetween(a: Resource, b: Resource): boolean {
  const ab = (a.properties.virtualNetworkPeerings ?? []).find((p: any) => ciEq(p.properties.remoteVirtualNetwork?.id, b.id));
  const ba = (b.properties.virtualNetworkPeerings ?? []).find((p: any) => ciEq(p.properties.remoteVirtualNetwork?.id, a.id));
  return !!ab && !!ba && ab.properties.peeringState === 'Connected';
}

export function isInScope(id: string, scope: string) {
  return isWithinScope(id, scope);
}
