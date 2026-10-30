// Utilidades compartidas por las validaciones de los laboratorios.
import type { CheckCtx } from '../checks';
import type { Resource } from '../../../engine/types';
import { vmNetworkInfo } from '../../../engine/providers/compute';
import { resolveSetting } from '../../../engine/services/web';
import { inboundAllowed } from '../../../engine/providers/network';

export const T = {
  vm: 'Microsoft.Compute/virtualMachines',
  storage: 'Microsoft.Storage/storageAccounts',
  vnet: 'Microsoft.Network/virtualNetworks',
  nsg: 'Microsoft.Network/networkSecurityGroups',
  pip: 'Microsoft.Network/publicIPAddresses',
  nic: 'Microsoft.Network/networkInterfaces',
  site: 'Microsoft.Web/sites',
  slot: 'Microsoft.Web/sites/slots',
  plan: 'Microsoft.Web/serverfarms',
  kv: 'Microsoft.KeyVault/vaults',
  sqlServer: 'Microsoft.Sql/servers',
  sqlDb: 'Microsoft.Sql/servers/databases',
  acr: 'Microsoft.ContainerRegistry/registries',
  aks: 'Microsoft.ContainerService/managedClusters',
  aci: 'Microsoft.ContainerInstance/containerGroups',
  law: 'Microsoft.OperationalInsights/workspaces',
  alert: 'Microsoft.Insights/metricAlerts',
  ag: 'Microsoft.Insights/actionGroups',
  dns: 'Microsoft.Network/dnsZones',
  sb: 'Microsoft.ServiceBus/namespaces',
};

/** Paso "existe el grupo de recursos X (en la región Y)". */
export function rgCheck(c: CheckCtx, name: string, location?: string): boolean | string {
  const g = c.rg(name);
  if (!g) return `Todavía no existe el grupo de recursos "${name}".`;
  if (location && g.location !== location) return `El grupo "${name}" está en ${g.location}; debe estar en ${location}.`;
  return true;
}

/** IP pública de una VM, si tiene. */
export function vmIp(c: CheckCtx, vm: Resource): string | undefined {
  return vmNetworkInfo(vm, c.s).publicIp;
}

/** ¿El tráfico entrante de Internet al puerto llega a la NIC de la VM (NSG de subred y de NIC)? */
export function vmPortOpen(c: CheckCtx, vm: Resource, port: number): boolean {
  const net = vmNetworkInfo(vm, c.s);
  if (!net.nic) return false;
  return inboundAllowed(net.nic, port, 'Tcp', '8.8.8.8', c.s).allowed;
}

/** Busca el último comando curl ejecutado que cumpla el patrón y repite la petición para comprobarla. */
export function lastCurlUrl(c: CheckCtx, re: RegExp): string | null {
  const cmds = c.cmds(['shell']).filter((x) => /^curl\b/.test(x.cmd) && re.test(x.cmd)).reverse();
  for (const x of cmds) {
    const m = /(https?:\/\/[^\s'"]+)/.exec(x.cmd.replace(/\\&/g, '&'));
    if (m) return m[1];
  }
  return null;
}

/** ¿Alguna configuración de la app es una referencia de Key Vault que se resuelve? */
export function kvRefResolved(site: Resource): boolean {
  const list: { name: string; value: string }[] = site.properties.siteConfig?.appSettings ?? [];
  return list.some((x) => String(x.value).startsWith('@Microsoft.KeyVault') && resolveSetting(site, x.value).resolved);
}

/**
 * ¿La conexión de servicio está limitada a un grupo de recursos? Vale tanto el ámbito de una conexión automática
 * como una entidad de servicio (conexión manual) cuyos roles estén todos dentro del grupo.
 */
export function scLimitedTo(c: CheckCtx, sc: { scope?: string; servicePrincipalObjectId?: string }, rg: string): boolean {
  const rgScope = `/resourcegroups/${rg.toLowerCase()}`;
  if (sc.scope?.toLowerCase().includes(rgScope)) return true;
  const roles = c.s.roleAssignments.filter((a) => a.principalId === sc.servicePrincipalObjectId);
  return roles.length > 0 && roles.every((a) => a.scope.toLowerCase().includes(rgScope));
}

export function siteUrl(site: Resource) {
  return `https://${site.properties.defaultHostName}`;
}

export function tablesOf(db: Resource): Record<string, { columns: any[]; rows: any[][] }> {
  return db.data?.tables ?? {};
}

export function findTable(db: Resource, name: string) {
  const t = tablesOf(db);
  const k = Object.keys(t).find((x) => x.toLowerCase() === name.toLowerCase() || x.toLowerCase() === `dbo.${name.toLowerCase()}`);
  return k ? t[k] : undefined;
}
