// Operaciones sobre subredes, reglas de NSG y emparejamientos de VNet.
import type { PrincipalRef, Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, checkLocks, findResource, logActivity, notFound } from '../arm';
import { ciEq, cidrOverlap, intToIp, parseCidr } from '../util';
import { nicsInSubnet, normalizeSecurityRule, validateRuleSet, validateVnetLayout } from '../providers/network';

function getVnet(id: string): Resource {
  const v = findResource(id);
  if (!v || !ciEq(v.type, 'Microsoft.Network/virtualNetworks')) throw notFound(id);
  return v;
}

function getNsg(id: string): Resource {
  const v = findResource(id);
  if (!v || !ciEq(v.type, 'Microsoft.Network/networkSecurityGroups')) throw notFound(id);
  return v;
}

export function upsertSubnet(vnetId: string, input: { name: string; addressPrefix?: string; nsgId?: string | null; serviceEndpoints?: string[]; delegations?: any[] }, principal: PrincipalRef | null) {
  const s = getState();
  const vnet = getVnet(vnetId);
  authorize(principal, 'Microsoft.Network/virtualNetworks/subnets/write', `${vnet.id}/subnets/${input.name}`);
  checkLocks(vnet.id, 'write', s);
  const subnets: any[] = [...(vnet.properties.subnets ?? [])];
  const idx = subnets.findIndex((x) => ciEq(x.name, input.name));
  const prev = idx >= 0 ? subnets[idx] : undefined;
  const prefix = input.addressPrefix ?? prev?.properties.addressPrefix;
  if (!prefix) throw new ArmError('InvalidRequestFormat', `Subnet '${input.name}' requires an address prefix (--address-prefixes).`);
  const c = parseCidr(prefix);
  if (!c) throw new ArmError('InvalidAddressPrefixFormat', `Address prefix ${prefix} of resource ${vnet.id}/subnets/${input.name} is not formatted correctly. It should follow CIDR notation, for example 10.0.0.0/24.`);
  if (c.bits > 29) throw new ArmError('NetcfgInvalidSubnet', `Subnet ${input.name} is not valid. The smallest supported subnet is /29.`);
  if (prev && prev.properties.addressPrefix !== `${intToIp(c.base)}/${c.bits}` && nicsInSubnet(prev.id, s).length) {
    throw new ArmError('InUseSubnetCannotBeUpdated', `Subnet ${input.name} is in use and its address prefix cannot be updated. Remove the network interfaces from the subnet first.`);
  }
  let nsgRef = prev?.properties.networkSecurityGroup;
  if (input.nsgId === null || input.nsgId === '') nsgRef = undefined;
  else if (input.nsgId) {
    const nsg = s.resources.find((r) => ciEq(r.type, 'Microsoft.Network/networkSecurityGroups') && (ciEq(r.id, input.nsgId!) || (ciEq(r.name, input.nsgId!) && ciEq(r.resourceGroup, vnet.resourceGroup))));
    if (!nsg) throw new ArmError('NotFound', `Network security group '${input.nsgId}' was not found.`, 404);
    if (!ciEq(nsg.location, vnet.location)) throw new ArmError('InvalidResourceReference', `Network security group ${nsg.id} is in location ${nsg.location} but the virtual network is in ${vnet.location}. The NSG must be in the same region.`);
    nsgRef = { id: nsg.id };
  }
  const sn = {
    name: input.name,
    id: `${vnet.id}/subnets/${input.name}`,
    type: 'Microsoft.Network/virtualNetworks/subnets',
    properties: {
      ...(prev?.properties ?? {}),
      addressPrefix: `${intToIp(c.base)}/${c.bits}`,
      networkSecurityGroup: nsgRef,
      serviceEndpoints: input.serviceEndpoints ? input.serviceEndpoints.map((x) => ({ service: x, locations: [vnet.location] })) : prev?.properties.serviceEndpoints ?? [],
      delegations: input.delegations ?? prev?.properties.delegations ?? [],
      privateEndpointNetworkPolicies: prev?.properties.privateEndpointNetworkPolicies ?? 'Disabled',
      privateLinkServiceNetworkPolicies: prev?.properties.privateLinkServiceNetworkPolicies ?? 'Enabled',
      provisioningState: 'Succeeded',
    },
  };
  if (idx >= 0) subnets[idx] = sn;
  else subnets.push(sn);
  validateVnetLayout(vnet.name, vnet.properties.addressSpace.addressPrefixes, subnets);
  vnet.properties.subnets = subnets;
  logActivity({ operationNameValue: 'Microsoft.Network/virtualNetworks/subnets/write', operationName: `${prev ? 'Actualizar' : 'Crear'} subred ${input.name}`, status: 'Succeeded', resourceId: sn.id, subscriptionId: vnet.subscriptionId, caller: principal?.name });
  changed();
  return sn;
}

export function deleteSubnet(vnetId: string, name: string, principal: PrincipalRef | null) {
  const s = getState();
  const vnet = getVnet(vnetId);
  const sn = (vnet.properties.subnets ?? []).find((x: any) => ciEq(x.name, name));
  if (!sn) throw new ArmError('NotFound', `Subnet '${name}' not found in virtual network '${vnet.name}'.`, 404);
  authorize(principal, 'Microsoft.Network/virtualNetworks/subnets/delete', sn.id);
  checkLocks(vnet.id, 'delete', s);
  const nics = nicsInSubnet(sn.id, s);
  if (nics.length) {
    throw new ArmError('InUseSubnetCannotBeDeleted', `Subnet ${name} is in use by ${nics[0].id}/ipConfigurations/ipconfig1 and cannot be deleted. In order to delete the subnet, delete all the resources within the subnet. See aka.ms/deletesubnet.`, 400);
  }
  vnet.properties.subnets = vnet.properties.subnets.filter((x: any) => x !== sn);
  logActivity({ operationNameValue: 'Microsoft.Network/virtualNetworks/subnets/delete', operationName: `Eliminar subred ${name}`, status: 'Succeeded', resourceId: sn.id, subscriptionId: vnet.subscriptionId, caller: principal?.name });
  changed();
}

export function upsertNsgRule(nsgId: string, raw: any, principal: PrincipalRef | null) {
  const s = getState();
  const nsg = getNsg(nsgId);
  authorize(principal, 'Microsoft.Network/networkSecurityGroups/securityRules/write', `${nsg.id}/securityRules/${raw.name}`);
  checkLocks(nsg.id, 'write', s);
  const rule = normalizeSecurityRule(nsg.id, raw);
  const rules = (nsg.properties.securityRules ?? []).filter((r: any) => !ciEq(r.name, rule.name));
  const next = [...rules, rule];
  validateRuleSet(next);
  nsg.properties.securityRules = next;
  logActivity({ operationNameValue: 'Microsoft.Network/networkSecurityGroups/securityRules/write', operationName: `Crear o actualizar regla de seguridad ${rule.name}`, status: 'Succeeded', resourceId: rule.id, subscriptionId: nsg.subscriptionId, caller: principal?.name });
  changed();
  return rule;
}

export function deleteNsgRule(nsgId: string, name: string, principal: PrincipalRef | null) {
  const s = getState();
  const nsg = getNsg(nsgId);
  const rule = (nsg.properties.securityRules ?? []).find((r: any) => ciEq(r.name, name));
  if (!rule) throw new ArmError('NotFound', `Security rule '${name}' not found in network security group '${nsg.name}'.`, 404);
  authorize(principal, 'Microsoft.Network/networkSecurityGroups/securityRules/delete', rule.id);
  checkLocks(nsg.id, 'delete', s);
  nsg.properties.securityRules = nsg.properties.securityRules.filter((r: any) => r !== rule);
  logActivity({ operationNameValue: 'Microsoft.Network/networkSecurityGroups/securityRules/delete', operationName: `Eliminar regla de seguridad ${name}`, status: 'Succeeded', resourceId: rule.id, subscriptionId: nsg.subscriptionId, caller: principal?.name });
  changed();
}

export function createPeering(vnetId: string, name: string, remoteVnetId: string, opts: { allowVnetAccess?: boolean; allowForwardedTraffic?: boolean; allowGatewayTransit?: boolean; useRemoteGateways?: boolean }, principal: PrincipalRef | null) {
  const s = getState();
  const vnet = getVnet(vnetId);
  const remote = s.resources.find((r) => ciEq(r.type, 'Microsoft.Network/virtualNetworks') && (ciEq(r.id, remoteVnetId) || (ciEq(r.name, remoteVnetId) && ciEq(r.resourceGroup, vnet.resourceGroup))));
  if (!remote) throw new ArmError('NotFound', `Remote virtual network '${remoteVnetId}' was not found.`, 404, 'Usa el nombre (si está en el mismo grupo de recursos) o el ID completo de la red remota.');
  authorize(principal, 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings/write', `${vnet.id}/virtualNetworkPeerings/${name}`);
  checkLocks(vnet.id, 'write', s);
  if (remote.id === vnet.id) throw new ArmError('InvalidPeering', 'A virtual network cannot be peered with itself.');
  for (const a of vnet.properties.addressSpace.addressPrefixes) {
    for (const b of remote.properties.addressSpace.addressPrefixes) {
      if (cidrOverlap(a, b)) {
        throw new ArmError('VnetAddressSpacesOverlap', `Cannot create or update peering ${name}. Virtual networks ${vnet.id} and ${remote.id} cannot be peered because their address spaces overlap. Overlapping address prefixes: ${a}, ${b}`, 400, 'Los espacios de direcciones de las redes emparejadas no pueden solaparse: planifica rangos distintos (p. ej. 10.1.0.0/16 y 10.2.0.0/16).');
      }
    }
  }
  const peerings: any[] = [...(vnet.properties.virtualNetworkPeerings ?? [])].filter((p) => !ciEq(p.name, name));
  const back = (remote.properties.virtualNetworkPeerings ?? []).find((p: any) => ciEq(p.properties.remoteVirtualNetwork?.id, vnet.id));
  const state = back ? 'Connected' : 'Initiated';
  const p = {
    name,
    id: `${vnet.id}/virtualNetworkPeerings/${name}`,
    type: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings',
    properties: {
      remoteVirtualNetwork: { id: remote.id, resourceGroup: remote.resourceGroup },
      remoteAddressSpace: { addressPrefixes: remote.properties.addressSpace.addressPrefixes },
      allowVirtualNetworkAccess: opts.allowVnetAccess ?? true,
      allowForwardedTraffic: opts.allowForwardedTraffic ?? false,
      allowGatewayTransit: opts.allowGatewayTransit ?? false,
      useRemoteGateways: opts.useRemoteGateways ?? false,
      peeringState: state,
      peeringSyncLevel: 'FullyInSync',
      provisioningState: 'Succeeded',
    },
  };
  peerings.push(p);
  vnet.properties.virtualNetworkPeerings = peerings;
  if (back) back.properties.peeringState = 'Connected';
  logActivity({ operationNameValue: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings/write', operationName: `Crear emparejamiento ${name} (${state})`, status: 'Succeeded', resourceId: p.id, subscriptionId: vnet.subscriptionId, caller: principal?.name });
  changed();
  return p;
}

export function deletePeering(vnetId: string, name: string, principal: PrincipalRef | null) {
  const s = getState();
  const vnet = getVnet(vnetId);
  const p = (vnet.properties.virtualNetworkPeerings ?? []).find((x: any) => ciEq(x.name, name));
  if (!p) throw new ArmError('NotFound', `Peering '${name}' not found.`, 404);
  authorize(principal, 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings/delete', p.id);
  checkLocks(vnet.id, 'delete', s);
  vnet.properties.virtualNetworkPeerings = vnet.properties.virtualNetworkPeerings.filter((x: any) => x !== p);
  const remote = findResource(p.properties.remoteVirtualNetwork.id);
  const back = remote?.properties.virtualNetworkPeerings?.find((x: any) => ciEq(x.properties.remoteVirtualNetwork?.id, vnet.id));
  if (back) back.properties.peeringState = 'Disconnected';
  changed();
}

export function setNicNsg(nicId: string, nsgId: string | null, principal: PrincipalRef | null) {
  const s = getState();
  const nic = findResource(nicId);
  if (!nic) throw notFound(nicId);
  authorize(principal, 'Microsoft.Network/networkInterfaces/write', nic.id);
  checkLocks(nic.id, 'write', s);
  if (nsgId) {
    const nsg = s.resources.find((r) => ciEq(r.type, 'Microsoft.Network/networkSecurityGroups') && (ciEq(r.id, nsgId) || (ciEq(r.name, nsgId) && ciEq(r.resourceGroup, nic.resourceGroup))));
    if (!nsg) throw new ArmError('NotFound', `Network security group '${nsgId}' not found.`, 404);
    nic.properties.networkSecurityGroup = { id: nsg.id };
  } else nic.properties.networkSecurityGroup = undefined;
  changed();
  return nic;
}
