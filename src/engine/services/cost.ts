// Cost Management simulado y Azure Advisor.
import type { Budget, CloudState, PrincipalRef, Resource } from '../types';
import { getState, changed, bus } from '../store';
import { ArmError } from '../errors';
import { authorize, monthlyCost, notify } from '../arm';
import { getProvider } from '../registry';
import { HOURS_PER_MONTH } from '../catalog';
import { ciEq, guid, nowIso } from '../util';
import { vmPowerState } from '../providers/compute';
import { ruleValues } from '../providers/network';
import { sitesOnPlan } from '../providers/web';
import { firewallRulesOf } from '../providers/sql';

/** 1 minuto real = 1 hora simulada. */
export const SIM_HOURS_PER_REAL_MS = 1 / 60000;

export function accrueCosts(s: CloudState = getState()) {
  const now = Date.now();
  const elapsed = Math.min(now - (s.costClock || now), 10 * 60000);
  s.costClock = now;
  if (elapsed <= 0) return;
  const simHours = elapsed * SIM_HOURS_PER_REAL_MS;
  for (const r of s.resources) {
    if (r.properties.provisioningState !== 'Succeeded') continue;
    const m = monthlyCost(r, s);
    if (m <= 0) continue;
    const key = r.id.toLowerCase();
    const entry = (s.costs[key] ??= { resourceId: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, amount: 0 });
    entry.amount += (m / HOURS_PER_MONTH) * simHours;
    entry.deleted = false;
  }
  checkBudgets(s);
  changed();
}

export function totalCost(s: CloudState = getState(), subscriptionId?: string): number {
  return Object.values(s.costs)
    .filter((c) => !subscriptionId || c.subscriptionId === subscriptionId)
    .reduce((a, c) => a + c.amount, 0);
}

export function forecastMonthly(s: CloudState = getState(), subscriptionId?: string): number {
  return s.resources.filter((r) => !subscriptionId || r.subscriptionId === subscriptionId).reduce((a, r) => a + monthlyCost(r, s), 0);
}

export function costByGroup(s: CloudState, key: 'resourceGroup' | 'type' | 'name', subscriptionId?: string) {
  const out: Record<string, number> = {};
  for (const c of Object.values(s.costs)) {
    if (subscriptionId && c.subscriptionId !== subscriptionId) continue;
    const k = key === 'type' ? getProvider(c.type)?.labelPlural ?? c.type : (c as any)[key];
    out[k] = (out[k] ?? 0) + c.amount;
  }
  return Object.entries(out)
    .map(([k, v]) => ({ key: k, amount: v }))
    .sort((a, b) => b.amount - a.amount);
}

export function createBudget(input: { name: string; amount: number; thresholds: number[]; contactEmails: string[]; scope?: string }, principal: PrincipalRef | null): Budget {
  const s = getState();
  const scope = input.scope ?? `/subscriptions/${s.currentSubscriptionId}`;
  authorize(principal, 'Microsoft.Consumption/budgets/write', scope);
  if (!(input.amount > 0)) throw new ArmError('InvalidBudget', 'The budget amount must be greater than 0.');
  if (!input.contactEmails.length) throw new ArmError('InvalidBudget', 'At least one contact email is required for budget notifications.');
  s.budgets = s.budgets.filter((b) => !(ciEq(b.name, input.name) && ciEq(b.scope, scope)));
  const b: Budget = { id: `${scope}/providers/Microsoft.Consumption/budgets/${input.name}`, name: input.name, amount: input.amount, scope, timeGrain: 'Monthly', thresholds: input.thresholds.length ? input.thresholds : [80, 100], contactEmails: input.contactEmails, notified: [], createdAt: nowIso() };
  s.budgets.push(b);
  changed();
  checkBudgets(s);
  return b;
}

export function checkBudgets(s: CloudState = getState()) {
  for (const b of s.budgets) {
    const sub = b.scope.split('/')[2];
    const spent = totalCost(s, sub);
    for (const th of b.thresholds) {
      if (b.notified.includes(th)) continue;
      if (spent >= (b.amount * th) / 100) {
        b.notified.push(th);
        notify({ title: `Presupuesto "${b.name}" al ${th}%`, message: `Gasto acumulado ${spent.toFixed(2)} $ de ${b.amount} $.`, level: th >= 100 ? 'error' : 'warning', link: '/cost' });
        for (const to of b.contactEmails) {
          s.emails.unshift({ id: guid(), to, subject: `Alerta de presupuesto: ${b.name} ha alcanzado el ${th}%`, body: `El gasto acumulado (${spent.toFixed(2)} $) ha superado el ${th}% del presupuesto de ${b.amount} $.\nÁmbito: ${b.scope}`, time: nowIso(), read: false });
          bus.emit('email', { to });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- Advisor

export interface Recommendation {
  id: string;
  category: 'Coste' | 'Seguridad' | 'Confiabilidad' | 'Excelencia operativa' | 'Rendimiento';
  impact: 'Alto' | 'Medio' | 'Bajo';
  resource: Resource;
  title: string;
  detail: string;
  fix: string;
  savings?: number;
}

export function advisorRecommendations(s: CloudState = getState()): Recommendation[] {
  const out: Recommendation[] = [];
  const add = (r: Resource, category: Recommendation['category'], impact: Recommendation['impact'], title: string, detail: string, fix: string, savings?: number) =>
    out.push({ id: `${r.id}|${title}`, category, impact, resource: r, title, detail, fix, savings });
  for (const r of s.resources) {
    const t = r.type.toLowerCase();
    if (r.resourceGroup.toUpperCase().startsWith('MC_')) continue;
    if (t === 'microsoft.compute/virtualmachines') {
      if (vmPowerState(r) === 'stopped') add(r, 'Coste', 'Alto', 'Desasigna las máquinas virtuales detenidas', 'La VM está detenida desde el sistema operativo pero no desasignada: sigues pagando el proceso.', `az vm deallocate -g ${r.resourceGroup} -n ${r.name}`, monthlyCost(r, s));
    }
    if (t === 'microsoft.compute/disks' && r.properties.diskState === 'Unattached') add(r, 'Coste', 'Medio', 'Elimina los discos no conectados', 'El disco no está conectado a ninguna VM y sigue generando coste.', `az disk delete -g ${r.resourceGroup} -n ${r.name}`, monthlyCost(r, s));
    if (t === 'microsoft.network/publicipaddresses' && !s.resources.some((n) => ciEq(n.type, 'Microsoft.Network/networkInterfaces') && (n.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.publicIPAddress?.id, r.id))) && !s.resources.some((lb) => ciEq(lb.type, 'Microsoft.Network/loadBalancers') && (lb.properties.frontendIPConfigurations ?? []).some((f: any) => ciEq(f.properties?.publicIPAddress?.id, r.id)))) {
      add(r, 'Coste', 'Bajo', 'Elimina las IP públicas no asociadas', 'Las IP públicas Standard se facturan aunque no estén en uso.', `az network public-ip delete -g ${r.resourceGroup} -n ${r.name}`, monthlyCost(r, s));
    }
    if (t === 'microsoft.web/serverfarms' && !sitesOnPlan(r, s).length && (r.sku?.tier ?? '') !== 'Free') add(r, 'Coste', 'Medio', 'Elimina los planes de App Service vacíos', 'El plan no tiene aplicaciones pero se factura por instancia.', `az appservice plan delete -g ${r.resourceGroup} -n ${r.name}`, monthlyCost(r, s));
    if (t === 'microsoft.network/networksecuritygroups') {
      for (const rule of r.properties.securityRules ?? []) {
        const p = rule.properties;
        if (p.direction !== 'Inbound' || p.access !== 'Allow') continue;
        const src = ruleValues(rule, 'sourceAddressPrefix');
        const ports = ruleValues(rule, 'destinationPortRange');
        const open = src.some((x: string) => ['*', 'internet', 'any', '0.0.0.0/0'].includes(x.toLowerCase()));
        const mgmt = ports.some((x: string) => x === '*' || x === '22' || x === '3389' || (x.includes('-') && Number(x.split('-')[0]) <= 22 && Number(x.split('-')[1]) >= 22));
        if (open && mgmt) add(r, 'Seguridad', 'Alto', 'Los puertos de administración no deben estar abiertos a Internet', `La regla "${rule.name}" permite SSH/RDP desde cualquier origen.`, 'Restringe el origen a tu IP, usa Azure Bastion o el acceso Just-In-Time.');
      }
    }
    if (t === 'microsoft.storage/storageaccounts') {
      if (r.properties.allowBlobPublicAccess) add(r, 'Seguridad', 'Medio', 'Deshabilita el acceso anónimo a blobs', 'La cuenta permite contenedores públicos.', `az storage account update -g ${r.resourceGroup} -n ${r.name} --allow-blob-public-access false`);
      if (!r.properties.supportsHttpsTrafficOnly) add(r, 'Seguridad', 'Alto', 'Habilita la transferencia segura (sólo HTTPS)', 'La cuenta acepta tráfico HTTP sin cifrar.', `az storage account update -g ${r.resourceGroup} -n ${r.name} --https-only true`);
      if (r.properties.minimumTlsVersion !== 'TLS1_2' && r.properties.minimumTlsVersion !== 'TLS1_3') add(r, 'Seguridad', 'Medio', 'Usa TLS 1.2 como versión mínima', 'Versiones antiguas de TLS son vulnerables.', `az storage account update -g ${r.resourceGroup} -n ${r.name} --min-tls-version TLS1_2`);
      if (/prod/i.test(r.tags?.entorno ?? r.tags?.environment ?? '') && /LRS$/.test(r.sku?.name ?? '')) add(r, 'Confiabilidad', 'Medio', 'Usa almacenamiento con redundancia de zona o geográfica en producción', 'LRS mantiene las copias en un solo centro de datos.', `az storage account update -g ${r.resourceGroup} -n ${r.name} --sku Standard_GRS`);
    }
    if (t === 'microsoft.keyvault/vaults' && !r.properties.enablePurgeProtection) add(r, 'Confiabilidad', 'Medio', 'Habilita la protección de purga en los almacenes de claves', 'Sin protección de purga, un secreto eliminado puede perderse definitivamente.', `az keyvault update -g ${r.resourceGroup} -n ${r.name} --enable-purge-protection true`);
    if (t === 'microsoft.web/sites') {
      if (!r.properties.httpsOnly) add(r, 'Seguridad', 'Medio', 'Las aplicaciones web sólo deben ser accesibles por HTTPS', 'La app acepta tráfico HTTP.', `az webapp update -g ${r.resourceGroup} -n ${r.name} --https-only true`);
      if (!(r.properties.siteConfig?.appSettings ?? []).some((x: any) => /APPLICATIONINSIGHTS_CONNECTION_STRING/.test(x.name))) add(r, 'Excelencia operativa', 'Bajo', 'Habilita Application Insights', 'Sin telemetría de aplicación es difícil diagnosticar errores y rendimiento.', 'Crea un recurso de Application Insights y configura APPLICATIONINSIGHTS_CONNECTION_STRING.');
      const plan = s.resources.find((p) => ciEq(p.id, r.properties.serverFarmId));
      if (plan && (plan.sku?.capacity ?? 1) < 2 && /prod/i.test(r.tags?.entorno ?? '')) add(r, 'Confiabilidad', 'Medio', 'Usa al menos 2 instancias en producción', 'Con una sola instancia no hay tolerancia a fallos.', `az appservice plan update -g ${plan.resourceGroup} -n ${plan.name} --number-of-workers 2`);
    }
    if (t === 'microsoft.sql/servers') {
      if (firewallRulesOf(r, s.resources).some((f) => f.properties.startIpAddress === '0.0.0.0' && f.properties.endIpAddress === '255.255.255.255')) add(r, 'Seguridad', 'Alto', 'Restringe las reglas de firewall de SQL', 'Una regla permite todo Internet (0.0.0.0-255.255.255.255).', 'Limita la regla a IPs concretas o usa puntos de conexión privados.');
    }
    if (t === 'microsoft.containerservice/managedclusters' && !r.properties.addonProfiles?.omsagent?.enabled) add(r, 'Excelencia operativa', 'Medio', 'Habilita Container Insights en AKS', 'Sin supervisión no tendrás registros ni métricas de los contenedores.', `az aks enable-addons -g ${r.resourceGroup} -n ${r.name} --addons monitoring --workspace-resource-id <id>`);
    if (!getProvider(r.type)?.hidden && !Object.keys(r.tags ?? {}).length && !r.managedBy && !ciEq(r.type, 'Microsoft.Compute/disks') && !ciEq(r.type, 'Microsoft.Network/networkInterfaces')) {
      add(r, 'Excelencia operativa', 'Bajo', 'Etiqueta los recursos', 'Las etiquetas (entorno, propietario, centro de coste) facilitan la gestión y el reparto de costes.', `az resource tag --ids ${r.id} --tags entorno=dev propietario=yo`);
    }
  }
  const rank = { Alto: 0, Medio: 1, Bajo: 2 } as const;
  return out.sort((a, b) => rank[a.impact] - rank[b.impact]);
}
