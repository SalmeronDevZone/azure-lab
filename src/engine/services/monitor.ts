// Azure Monitor simulado: métricas, alertas, escalado automático y tablas de Log Analytics.
import type { AlertInstance, CloudState, Resource } from '../types';
import { getState, changed, bus } from '../store';
import { logActivity, notify } from '../arm';
import { METRIC_CATALOG, findAppServiceSku } from '../catalog';
import { ciEq, fnv1a, guid, nowIso, parseIsoDuration, seededRandom } from '../util';
import { storageUsedBytes } from '../providers/storage';
import { kubeOf } from './kube';
import type { KqlColumn, KqlTable, KType } from './kql';

/** Compresión temporal de ventanas de alertas/escalado según la velocidad del simulador. */
export function timeCompression(s: CloudState = getState()): number {
  return s.settings.speed === 'realistic' ? 1 : s.settings.speed === 'instant' ? 30 : 6;
}

function noise(seed: string, t: number): number {
  return seededRandom(fnv1a(seed + ':' + Math.floor(t / 10000)))();
}

export function vmStateAt(vm: Resource, t: number): string {
  if (t < new Date(vm.createdAt).getTime()) return 'none';
  const log: { t: number; state: string }[] = vm.data?.powerLog ?? [];
  let st = 'running';
  for (const e of log) if (e.t <= t) st = e.state;
  if (t >= Date.now() - 1000) st = vm.data?.powerState ?? st;
  return st;
}

function stressedAt(vm: Resource, t: number): boolean {
  return (vm.data?.stressLog ?? []).some((x: any) => t >= x.from && t <= x.to);
}

function eventsIn(s: CloudState, kind: string, resourceId: string, from: number, to: number, pred?: (e: any) => boolean) {
  const rid = resourceId.toLowerCase();
  return s.events.filter((e) => e.kind === kind && e.t >= from && e.t < to && (e.resourceId ?? '').toLowerCase() === rid && (!pred || pred(e)));
}

/** Valor de una métrica en el intervalo [t, t+step). */
export function metricValue(res: Resource, metric: string, t: number, step: number, s: CloudState = getState()): number | null {
  const type = res.type.toLowerCase();
  if (t + step < new Date(res.createdAt).getTime()) return null;
  const n = noise(res.id + metric, t);
  switch (type) {
    case 'microsoft.compute/virtualmachines': {
      const st = vmStateAt(res, t + step / 2);
      if (st !== 'running' && st !== 'starting' && st !== 'restarting') return null;
      if (metric === 'Percentage CPU') return stressedAt(res, t + step / 2) ? 92 + n * 7 : 3 + n * 7;
      if (metric === 'Available Memory Bytes') return (0.55 + n * 0.1) * 1024 ** 3;
      return Math.round(40000 + n * 90000);
    }
    case 'microsoft.web/sites':
    case 'microsoft.web/sites/slots': {
      const ev = eventsIn(s, 'http', res.id, t, t + step);
      if (metric === 'Requests') return ev.length;
      if (metric === 'Http5xx') return ev.filter((e) => (e.status ?? 0) >= 500).length;
      if (metric === 'Http4xx') return ev.filter((e) => (e.status ?? 0) >= 400 && (e.status ?? 0) < 500).length;
      if (metric === 'AverageResponseTime') return ev.length ? ev.reduce((a, e) => a + (e.durationMs ?? 50), 0) / ev.length / 1000 : 0;
      if (metric === 'CpuTime') return ev.length * 0.02;
      return 0;
    }
    case 'microsoft.web/serverfarms': {
      const sites = s.resources.filter((r) => (ciEq(r.type, 'Microsoft.Web/sites') || ciEq(r.type, 'Microsoft.Web/sites/slots')) && ciEq(r.properties.serverFarmId, res.id));
      const reqs = sites.reduce((acc, site) => acc + eventsIn(s, 'http', site.id, t, t + step).length, 0);
      const perMin = (reqs * 60000) / step;
      const cap = Math.max(1, res.sku?.capacity ?? 1);
      const sku = findAppServiceSku(res.sku?.name);
      const capacityFactor = Math.max(0.5, sku?.cores ?? 1);
      if (metric === 'CpuPercentage') return Math.min(100, (6 + n * 6 + perMin * 0.9) / cap / capacityFactor);
      if (metric === 'MemoryPercentage') return Math.min(100, 35 + n * 8 + perMin * 0.1 / cap);
      return 0;
    }
    case 'microsoft.storage/storageaccounts': {
      if (metric === 'Transactions') return eventsIn(s, 'blobOp', res.id, t, t + step).length;
      if (metric === 'UsedCapacity') return storageUsedBytes(res);
      return 100;
    }
    case 'microsoft.sql/servers/databases': {
      const conns = eventsIn(s, 'sqlConn', res.id, t, t + step).length;
      if (metric === 'connection_successful') return conns;
      return Math.min(100, 1 + n * 4 + conns * 6);
    }
    case 'microsoft.containerservice/managedclusters': {
      if (res.properties.powerState?.code === 'Stopped') return null;
      const k = kubeOf(res);
      const running = k.pods.filter((p) => p.status === 'Running').length;
      if (metric === 'kube_pod_status_ready') return running;
      const hits = eventsIn(s, 'k8s', res.id, t, t + step).length;
      return Math.min(100, 8 + running * 1.5 + n * 6 + hits * 2);
    }
    case 'microsoft.keyvault/vaults':
      if (metric === 'ServiceApiHit') return eventsIn(s, 'secretGet', res.id, t, t + step).length;
      return 100;
    case 'microsoft.containerinstance/containergroups':
      if (res.data?.state === 'Stopped') return null;
      return metric === 'CpuUsage' ? 2 + n * 10 : 60 * 1024 ** 2 + n * 20 * 1024 ** 2;
  }
  return null;
}

export interface MetricPoint {
  t: number;
  v: number | null;
}

export function metricSeries(res: Resource, metric: string, minutes = 60, stepMs = 60000, s: CloudState = getState()): MetricPoint[] {
  const now = Date.now();
  const end = Math.floor(now / stepMs) * stepMs + stepMs;
  const start = end - minutes * 60000;
  const out: MetricPoint[] = [];
  for (let t = start; t < end; t += stepMs) out.push({ t, v: metricValue(res, metric, t, stepMs, s) });
  return out;
}

export function metricsFor(type: string) {
  const key = type.toLowerCase() === 'microsoft.web/sites/slots' ? 'microsoft.web/sites' : type.toLowerCase();
  return METRIC_CATALOG[key] ?? [];
}

export function aggregateValues(values: number[], agg: string): number | null {
  if (!values.length) return null;
  switch (agg.toLowerCase()) {
    case 'total':
    case 'count':
      return values.reduce((a, b) => a + b, 0);
    case 'maximum':
      return Math.max(...values);
    case 'minimum':
      return Math.min(...values);
    default:
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

function compare(v: number, op: string, th: number): boolean {
  switch (op) {
    case 'GreaterThan':
      return v > th;
    case 'GreaterThanOrEqual':
      return v >= th;
    case 'LessThan':
      return v < th;
    case 'LessThanOrEqual':
      return v <= th;
    case 'Equals':
      return v === th;
  }
  return false;
}

const OP_SYM: Record<string, string> = { GreaterThan: '>', GreaterThanOrEqual: '>=', LessThan: '<', LessThanOrEqual: '<=', Equals: '=' };

/** Valor agregado de una métrica sobre una ventana (comprimida según la velocidad). */
export function windowAggregate(res: Resource, metric: string, agg: string, windowIso: string, s: CloudState = getState()): number | null {
  const comp = timeCompression(s);
  const winMs = (parseIsoDuration(windowIso) * 60000) / comp;
  const step = Math.max(2000, Math.min(60000, winMs / 6));
  const now = Date.now();
  const vals: number[] = [];
  for (let t = now - winMs; t < now; t += step) {
    const v = metricValue(res, metric, t, step, s);
    if (v !== null) vals.push(agg.toLowerCase() === 'total' ? (v * 60000) / step / comp : v);
  }
  return aggregateValues(vals, agg);
}

export function sendEmail(to: string, subject: string, body: string) {
  const s = getState();
  s.emails.unshift({ id: guid(), to, subject, body, time: nowIso(), read: false });
  if (s.emails.length > 100) s.emails = s.emails.slice(0, 100);
  bus.emit('email', { to, subject });
}

export function evaluateAlerts(s: CloudState = getState()) {
  const rules = s.resources.filter((r) => ciEq(r.type, 'Microsoft.Insights/metricAlerts') && r.properties.enabled && r.properties.provisioningState === 'Succeeded');
  for (const rule of rules) {
    const target = s.resources.find((r) => ciEq(r.id, rule.properties.scopes?.[0]));
    if (!target) continue;
    const c = rule.properties.criteria?.allOf?.[0];
    if (!c) continue;
    const v = windowAggregate(target, c.metricName, c.timeAggregation, rule.properties.windowSize, s);
    if (v === null) continue;
    const fire = compare(v, c.operator, c.threshold);
    const state = rule.data?.lastState ?? 'Resolved';
    const condText = `${c.timeAggregation} ${c.metricName} ${OP_SYM[c.operator] ?? c.operator} ${c.threshold} (valor actual: ${Math.round(v * 100) / 100})`;
    if (fire && state !== 'Fired') {
      rule.data = { ...(rule.data ?? {}), lastState: 'Fired', lastFired: Date.now() };
      const inst: AlertInstance = { id: guid(), ruleId: rule.id, ruleName: rule.name, severity: rule.properties.severity, targetResource: target.id, description: rule.properties.description, firedAt: nowIso(), state: 'Fired', metricValue: v, condition: condText };
      s.alerts.unshift(inst);
      logActivity({ operationNameValue: 'Microsoft.Insights/metricAlerts/Activated/action', operationName: `Alerta activada: ${rule.name}`, status: 'Succeeded', resourceId: rule.id, subscriptionId: rule.subscriptionId, caller: 'Microsoft.Insights/alertRules', category: 'Alert', level: rule.properties.severity <= 1 ? 'Critical' : 'Warning' });
      notify({ title: `Alerta desencadenada (Sev${rule.properties.severity}): ${rule.name}`, message: `${target.name}: ${condText}`, level: 'warning', link: `/monitor/alerts` });
      for (const a of rule.properties.actions ?? []) {
        const ag = s.resources.find((r) => ciEq(r.id, a.actionGroupId));
        for (const er of ag?.properties.emailReceivers ?? []) {
          sendEmail(er.emailAddress, `Fired: Sev${rule.properties.severity} Azure Monitor Alert ${rule.name} on ${target.name}`, `Se ha activado la regla de alerta "${rule.name}".\n\nRecurso: ${target.id}\nCondición: ${condText}\nHora: ${new Date().toLocaleString('es-ES')}\nGrupo de acciones: ${ag!.name}`);
        }
      }
    } else if (!fire && state === 'Fired' && rule.properties.autoMitigate) {
      rule.data = { ...(rule.data ?? {}), lastState: 'Resolved' };
      const inst = s.alerts.find((x) => x.ruleId === rule.id && x.state === 'Fired');
      if (inst) {
        inst.state = 'Resolved';
        inst.resolvedAt = nowIso();
      }
      logActivity({ operationNameValue: 'Microsoft.Insights/metricAlerts/Resolved/action', operationName: `Alerta resuelta: ${rule.name}`, status: 'Succeeded', resourceId: rule.id, subscriptionId: rule.subscriptionId, caller: 'Microsoft.Insights/alertRules', category: 'Alert' });
      for (const a of rule.properties.actions ?? []) {
        const ag = s.resources.find((r) => ciEq(r.id, a.actionGroupId));
        for (const er of ag?.properties.emailReceivers ?? []) sendEmail(er.emailAddress, `Resolved: Sev${rule.properties.severity} Azure Monitor Alert ${rule.name} on ${target.name}`, `La alerta "${rule.name}" se ha resuelto automáticamente.\nCondición: ${condText}`);
      }
    }
  }
  changed();
}

export function evaluateAutoscale(s: CloudState = getState()) {
  const settings = s.resources.filter((r) => ciEq(r.type, 'Microsoft.Insights/autoscalesettings') && r.properties.enabled);
  for (const as of settings) {
    const target = s.resources.find((r) => ciEq(r.id, as.properties.targetResourceUri));
    if (!target) continue;
    const prof = as.properties.profiles?.[0];
    if (!prof) continue;
    const cap = target.sku?.capacity ?? 1;
    const comp = timeCompression(s);
    let next = cap;
    let reason = '';
    for (const rule of prof.rules ?? []) {
      const mt = rule.metricTrigger;
      const sa = rule.scaleAction;
      const metricRes = s.resources.find((r) => ciEq(r.id, mt.metricResourceUri ?? target.id)) ?? target;
      const v = windowAggregate(metricRes, mt.metricName, mt.timeAggregation ?? 'Average', mt.timeWindow ?? 'PT5M', s);
      if (v === null) continue;
      const cooldownMs = (parseIsoDuration(sa.cooldown ?? 'PT5M') * 60000) / comp;
      if (Date.now() - (as.data?.lastScale ?? 0) < cooldownMs) continue;
      if (compare(v, mt.operator, Number(mt.threshold))) {
        const delta = Number(sa.value ?? 1);
        const cand = sa.direction === 'Increase' ? cap + delta : cap - delta;
        next = Math.max(Number(prof.capacity.minimum), Math.min(Number(prof.capacity.maximum), cand));
        reason = `${mt.metricName} ${OP_SYM[mt.operator] ?? mt.operator} ${mt.threshold} (actual ${Math.round(v)})`;
        if (next !== cap) break;
      }
    }
    const min = Number(prof.capacity.minimum);
    if (cap < min) {
      next = min;
      reason = 'capacidad por debajo del mínimo';
    }
    if (next !== cap) {
      target.sku = { ...target.sku!, capacity: next };
      if (target.properties.numberOfWorkers !== undefined) target.properties.numberOfWorkers = next;
      as.data = { ...(as.data ?? {}), lastScale: Date.now() };
      const up = next > cap;
      logActivity({ operationNameValue: 'Microsoft.Insights/AutoscaleSettings/Scale' + (up ? 'up' : 'down') + '/Action', operationName: `Escalado automático ${up ? 'horizontal hacia fuera' : 'hacia dentro'}: ${cap} → ${next} instancias`, status: 'Succeeded', resourceId: as.id, subscriptionId: as.subscriptionId, caller: 'Microsoft.Insights/autoscaleSettings', category: 'Autoscale', message: reason });
      notify({ title: `Escalado automático: ${target.name}`, message: `${cap} → ${next} instancias (${reason})`, level: 'info' });
      changed();
    }
  }
}

// ---------------------------------------------------------------- Log Analytics

function cols(spec: Record<string, KType>): KqlColumn[] {
  return Object.entries(spec).map(([name, type]) => ({ name, type }));
}

export function linkedResources(ws: Resource, s: CloudState = getState()) {
  const diag = s.diagnosticSettings.filter((d) => ciEq(d.workspaceId, ws.id));
  const diagIds = new Set(diag.map((d) => d.resourceUri.toLowerCase()));
  const vms = s.resources.filter(
    (r) =>
      ciEq(r.type, 'Microsoft.Compute/virtualMachines') &&
      (ciEq(r.data?.monitoringWorkspace, ws.id) ||
        s.resources.some((e) => ciEq(e.type, 'Microsoft.Compute/virtualMachines/extensions') && e.id.toLowerCase().startsWith(r.id.toLowerCase() + '/') && (ciEq(e.properties.settings?.workspaceId, ws.properties.customerId) || ciEq(e.properties.settings?.workspaceId, ws.id)))),
  );
  const clusters = s.resources.filter((r) => ciEq(r.type, 'Microsoft.ContainerService/managedClusters') && r.properties.addonProfiles?.omsagent?.enabled && ciEq(r.properties.addonProfiles.omsagent.config?.logAnalyticsWorkspaceResourceID, ws.id));
  const components = s.resources.filter((r) => ciEq(r.type, 'Microsoft.Insights/components') && ciEq(r.properties.WorkspaceResourceId, ws.id));
  return { diag, diagIds, vms, clusters, components };
}

function iso(t: number) {
  return t;
}

export function workspaceTables(ws: Resource, s: CloudState = getState()): Record<string, KqlTable> {
  const out: Record<string, KqlTable> = {};
  const { diagIds, vms, clusters, components } = linkedResources(ws, s);
  const now = Date.now();
  const sub = ws.subscriptionId;

  out.AzureActivity = {
    columns: cols({ TimeGenerated: 'datetime', OperationNameValue: 'string', OperationName: 'string', ActivityStatusValue: 'string', Caller: 'string', ResourceGroup: 'string', ResourceProviderValue: 'string', _ResourceId: 'string', Level: 'string', CategoryValue: 'string', SubscriptionId: 'string', CorrelationId: 'string' }),
    rows: s.activityLog
      .filter((e) => e.subscriptionId === sub)
      .map((e) => ({
        TimeGenerated: new Date(e.time).getTime(),
        OperationNameValue: e.operationNameValue.toUpperCase(),
        OperationName: e.operationName,
        ActivityStatusValue: e.status === 'Succeeded' ? 'Success' : e.status === 'Started' ? 'Start' : e.status === 'Failed' ? 'Failure' : e.status,
        Caller: e.caller,
        ResourceGroup: (e.resourceGroup ?? '').toUpperCase(),
        ResourceProviderValue: (e.resourceType ?? '').split('/')[0].toUpperCase(),
        _ResourceId: e.resourceId.toLowerCase(),
        Level: e.level,
        CategoryValue: e.category,
        SubscriptionId: e.subscriptionId,
        CorrelationId: e.correlationId,
      })),
  };

  const hb: Record<string, any>[] = [];
  const perf: Record<string, any>[] = [];
  for (const vm of vms) {
    const since = Math.max(new Date(vm.createdAt).getTime(), vm.data?.monitoringSince ?? 0, now - 3 * 3600000);
    for (let t = Math.ceil(since / 60000) * 60000; t <= now; t += 60000) {
      const st = vmStateAt(vm, t);
      if (st !== 'running') continue;
      hb.push({ TimeGenerated: iso(t), Computer: vm.properties.osProfile?.computerName ?? vm.name, OSType: vm.data?.osType ?? 'Linux', Category: 'Azure Monitor Agent', Version: '1.33.2', ResourceGroup: vm.resourceGroup, _ResourceId: vm.id.toLowerCase(), ComputerIP: '20.31.118.42' });
      perf.push({ TimeGenerated: iso(t), Computer: vm.properties.osProfile?.computerName ?? vm.name, ObjectName: 'Processor', CounterName: '% Processor Time', InstanceName: '_Total', CounterValue: metricValue(vm, 'Percentage CPU', t, 60000, s) ?? 0, _ResourceId: vm.id.toLowerCase() });
      perf.push({ TimeGenerated: iso(t), Computer: vm.properties.osProfile?.computerName ?? vm.name, ObjectName: 'Memory', CounterName: 'Available MBytes', InstanceName: '', CounterValue: Math.round((metricValue(vm, 'Available Memory Bytes', t, 60000, s) ?? 0) / 1048576), _ResourceId: vm.id.toLowerCase() });
    }
  }
  out.Heartbeat = { columns: cols({ TimeGenerated: 'datetime', Computer: 'string', OSType: 'string', Category: 'string', Version: 'string', ResourceGroup: 'string', _ResourceId: 'string', ComputerIP: 'string' }), rows: hb };
  out.Perf = { columns: cols({ TimeGenerated: 'datetime', Computer: 'string', ObjectName: 'string', CounterName: 'string', InstanceName: 'string', CounterValue: 'real', _ResourceId: 'string' }), rows: perf };

  const httpLogs: Record<string, any>[] = [];
  const consoleLogs: Record<string, any>[] = [];
  for (const site of s.resources.filter((r) => (ciEq(r.type, 'Microsoft.Web/sites') || ciEq(r.type, 'Microsoft.Web/sites/slots')) && diagIds.has(r.id.toLowerCase()))) {
    for (const e of s.events.filter((x) => x.kind === 'http' && ciEq(x.resourceId, site.id))) {
      httpLogs.push({ TimeGenerated: e.t, CsMethod: 'GET', CsUriStem: e.path ?? '/', ScStatus: e.status ?? 200, TimeTaken: e.durationMs ?? 50, CsHost: site.properties.defaultHostName, UserAgent: 'curl/8.5.0', CIp: '20.31.118.42', _ResourceId: site.id.toLowerCase() });
    }
    for (const line of site.data?.logs ?? []) {
      const ts = Date.parse(line.slice(0, 24));
      consoleLogs.push({ TimeGenerated: isNaN(ts) ? now : ts, ResultDescription: line.slice(26), Level: /error|exit|fail/i.test(line) ? 'Error' : 'Informational', Host: site.name, _ResourceId: site.id.toLowerCase() });
    }
  }
  out.AppServiceHTTPLogs = { columns: cols({ TimeGenerated: 'datetime', CsMethod: 'string', CsUriStem: 'string', ScStatus: 'long', TimeTaken: 'long', CsHost: 'string', UserAgent: 'string', CIp: 'string', _ResourceId: 'string' }), rows: httpLogs };
  out.AppServiceConsoleLogs = { columns: cols({ TimeGenerated: 'datetime', ResultDescription: 'string', Level: 'string', Host: 'string', _ResourceId: 'string' }), rows: consoleLogs };

  const appReq: Record<string, any>[] = [];
  for (const comp of components) {
    const ikey = comp.properties.InstrumentationKey;
    const sites = s.resources.filter((r) => (ciEq(r.type, 'Microsoft.Web/sites') || ciEq(r.type, 'Microsoft.Web/sites/slots')) && (r.properties.siteConfig?.appSettings ?? []).some((x: any) => /APPLICATIONINSIGHTS_CONNECTION_STRING|APPINSIGHTS_INSTRUMENTATIONKEY/.test(x.name) && String(x.value).includes(ikey)));
    for (const site of sites) {
      for (const e of s.events.filter((x) => x.kind === 'http' && ciEq(x.resourceId, site.id))) {
        appReq.push({ TimeGenerated: e.t, Name: `GET ${e.path ?? '/'}`, Url: `https://${site.properties.defaultHostName}${e.path ?? '/'}`, ResultCode: String(e.status ?? 200), Success: (e.status ?? 200) < 400, DurationMs: e.durationMs ?? 50, AppRoleName: site.name, OperationId: guid().replace(/-/g, ''), _ResourceId: comp.id.toLowerCase() });
      }
    }
  }
  out.AppRequests = { columns: cols({ TimeGenerated: 'datetime', Name: 'string', Url: 'string', ResultCode: 'string', Success: 'bool', DurationMs: 'real', AppRoleName: 'string', OperationId: 'string', _ResourceId: 'string' }), rows: appReq };
  out.requests = out.AppRequests;

  const blobLogs: Record<string, any>[] = [];
  for (const st of s.resources.filter((r) => ciEq(r.type, 'Microsoft.Storage/storageAccounts') && diagIds.has(r.id.toLowerCase()))) {
    for (const e of s.events.filter((x) => x.kind === 'blobOp' && ciEq(x.resourceId, st.id))) {
      const [opName, uri] = (e.detail ?? '').split(' ');
      blobLogs.push({ TimeGenerated: e.t, AccountName: st.name, OperationName: opName, StatusCode: e.status ?? 200, StatusText: (e.status ?? 200) < 400 ? 'Success' : 'Error', Uri: `https://${st.name}.blob.core.windows.net/${uri ?? ''}`, AuthenticationType: 'AccountKey', RequesterUpn: e.caller ?? '', CallerIpAddress: '20.31.118.42', _ResourceId: st.id.toLowerCase() });
    }
  }
  out.StorageBlobLogs = { columns: cols({ TimeGenerated: 'datetime', AccountName: 'string', OperationName: 'string', StatusCode: 'long', StatusText: 'string', Uri: 'string', AuthenticationType: 'string', RequesterUpn: 'string', CallerIpAddress: 'string', _ResourceId: 'string' }), rows: blobLogs };

  const diagRows: Record<string, any>[] = [];
  for (const kv of s.resources.filter((r) => ciEq(r.type, 'Microsoft.KeyVault/vaults') && diagIds.has(r.id.toLowerCase()))) {
    for (const e of s.events.filter((x) => x.kind === 'secretGet' && ciEq(x.resourceId, kv.id))) {
      const [op, name] = (e.detail ?? 'SecretGet').split(' ');
      diagRows.push({ TimeGenerated: e.t, ResourceProvider: 'MICROSOFT.KEYVAULT', ResourceType: 'VAULTS', Category: 'AuditEvent', OperationName: op, ResultType: (e.status ?? 200) < 400 ? 'Success' : 'Forbidden', httpStatusCode_d: e.status ?? 200, id_s: `${kv.properties.vaultUri}secrets/${name ?? ''}`, identity_claim_upn_s: e.caller ?? '', CallerIPAddress: '20.31.118.42', Resource: kv.name.toUpperCase(), _ResourceId: kv.id.toLowerCase() });
    }
  }
  out.AzureDiagnostics = { columns: cols({ TimeGenerated: 'datetime', ResourceProvider: 'string', ResourceType: 'string', Category: 'string', OperationName: 'string', ResultType: 'string', httpStatusCode_d: 'real', id_s: 'string', identity_claim_upn_s: 'string', CallerIPAddress: 'string', Resource: 'string', _ResourceId: 'string' }), rows: diagRows };

  const podInv: Record<string, any>[] = [];
  const contLogs: Record<string, any>[] = [];
  const kevents: Record<string, any>[] = [];
  for (const c of clusters) {
    const k = kubeOf(c);
    for (const p of k.pods) {
      podInv.push({ TimeGenerated: now, ClusterName: c.name, Namespace: p.meta.namespace, Name: p.meta.name, PodStatus: p.status === 'Running' ? 'Running' : p.status === 'Pending' || p.status === 'ContainerCreating' ? 'Pending' : 'Failed', ContainerStatusReason: ['ErrImagePull', 'ImagePullBackOff', 'CrashLoopBackOff'].includes(p.status) ? p.status : '', PodRestartCount: p.restarts, Computer: p.node ?? '', ControllerName: p.owner?.name ?? '', _ResourceId: c.id.toLowerCase() });
    }
    for (const e of s.events.filter((x) => x.kind === 'k8s' && ciEq(x.resourceId, c.id))) {
      contLogs.push({ TimeGenerated: e.t, PodName: e.detail ?? '', PodNamespace: 'default', ContainerName: (e.detail ?? '').split('-')[0], LogMessage: `GET ${e.path ?? '/'} ${e.status}`, LogSource: 'stdout', _ResourceId: c.id.toLowerCase() });
    }
    for (const e of k.events) kevents.push({ TimeGenerated: Date.parse(e.time), ClusterName: c.name, Namespace: 'default', ObjectKind: 'Pod', Name: e.object.split('/')[1], Reason: e.reason, Message: e.message, KubeEventType: e.type, Count: e.count, _ResourceId: c.id.toLowerCase() });
  }
  out.KubePodInventory = { columns: cols({ TimeGenerated: 'datetime', ClusterName: 'string', Namespace: 'string', Name: 'string', PodStatus: 'string', ContainerStatusReason: 'string', PodRestartCount: 'long', Computer: 'string', ControllerName: 'string', _ResourceId: 'string' }), rows: podInv };
  out.ContainerLogV2 = { columns: cols({ TimeGenerated: 'datetime', PodName: 'string', PodNamespace: 'string', ContainerName: 'string', LogMessage: 'string', LogSource: 'string', _ResourceId: 'string' }), rows: contLogs };
  out.KubeEvents = { columns: cols({ TimeGenerated: 'datetime', ClusterName: 'string', Namespace: 'string', ObjectKind: 'string', Name: 'string', Reason: 'string', Message: 'string', KubeEventType: 'string', Count: 'long', _ResourceId: 'string' }), rows: kevents };

  const metrics: Record<string, any>[] = [];
  for (const d of s.diagnosticSettings.filter((x) => ciEq(x.workspaceId, ws.id) && x.metrics.some((m) => m.enabled))) {
    const r = s.resources.find((x) => ciEq(x.id, d.resourceUri));
    if (!r) continue;
    for (const m of metricsFor(r.type)) {
      for (const p of metricSeries(r, m.name, 60, 60000, s)) {
        if (p.v === null) continue;
        metrics.push({ TimeGenerated: p.t, ResourceId: r.id.toUpperCase(), Resource: r.name.toUpperCase(), MetricName: m.name, Average: p.v, Total: p.v, Maximum: p.v, Minimum: p.v, UnitName: m.unit, _ResourceId: r.id.toLowerCase() });
      }
    }
  }
  out.AzureMetrics = { columns: cols({ TimeGenerated: 'datetime', ResourceId: 'string', Resource: 'string', MetricName: 'string', Average: 'real', Total: 'real', Maximum: 'real', Minimum: 'real', UnitName: 'string', _ResourceId: 'string' }), rows: metrics };
  return out;
}

export function findTable(tables: Record<string, KqlTable>, name: string): KqlTable | undefined {
  const key = Object.keys(tables).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? tables[key] : undefined;
}
