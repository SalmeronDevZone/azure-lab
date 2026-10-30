// az monitor / consumption / advisor / costmanagement.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { authorize, deleteResource, findResource, putResource } from '../../../engine/arm';
import { resourceId } from '../../../engine/ids';
import { ciEq, nowIso, parseIsoDuration } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { metricSeries, metricsFor, workspaceTables, findTable, aggregateValues } from '../../../engine/services/monitor';
import { runKql, KqlError, formatKqlValue } from '../../../engine/services/kql';
import { createDiagnosticSetting, deleteDiagnosticSetting, diagnosticJson } from '../../../engine/services/diagnostics';
import { advisorRecommendations, createBudget, totalCost, forecastMonthly, costByGroup } from '../../../engine/services/cost';

const T_WS = 'Microsoft.OperationalInsights/workspaces';
const T_AI = 'Microsoft.Insights/components';
const T_AG = 'Microsoft.Insights/actionGroups';
const T_ALERT = 'Microsoft.Insights/metricAlerts';
const T_AS = 'Microsoft.Insights/autoscalesettings';

group('monitor', 'Administra Azure Monitor.');
group('monitor log-analytics', 'Administra Log Analytics.');
group('monitor log-analytics workspace', 'Áreas de trabajo de Log Analytics.');
group('monitor metrics', 'Consulta métricas.');
group('monitor metrics alert', 'Reglas de alertas de métricas.');
group('monitor action-group', 'Grupos de acciones.');
group('monitor activity-log', 'Registro de actividad.');
group('monitor diagnostic-settings', 'Configuración de diagnóstico.');
group('monitor app-insights', 'Application Insights.');
group('monitor app-insights component', 'Componentes de Application Insights.');
group('monitor autoscale', 'Escalado automático.');
group('monitor autoscale rule', 'Reglas de escalado automático.');
group('consumption', 'Consumo y presupuestos.');
group('consumption budget', 'Presupuestos.');
group('advisor', 'Azure Advisor.');
group('advisor recommendation', 'Recomendaciones de Advisor.');
group('costmanagement', 'Cost Management.');

function resourceArg(ctx: AzCtx, a: Args, key = 'resource'): any {
  const v = a[key];
  if (!v) throw cliError(`the following arguments are required: --${key}`, undefined, true);
  if (String(v).startsWith('/')) {
    const r = findResource(v);
    if (!r) throw new ArmError('ResourceNotFound', `The Resource '${v}' was not found.`, 404);
    return r;
  }
  const r = getState().resources.find((x) => ciEq(x.name, v) && x.subscriptionId === ctx.subscriptionId && (!a.resource_group || ciEq(x.resourceGroup, a.resource_group)) && (!a.resource_type || ciEq(x.type, a.resource_type) || ciEq(x.type.split('/').pop(), a.resource_type)));
  if (!r) throw new ArmError('ResourceNotFound', `Resource '${v}' not found. Usa el ID completo con --resource.`, 404);
  return r;
}

// ---------------------------------------------------------------- Log Analytics

register({
  path: 'monitor log-analytics workspace create',
  summary: 'Crea un área de trabajo de Log Analytics.',
  args: [A.rg(), { name: 'workspace_name', opts: ['--workspace-name', '-n'], help: 'Nombre del área de trabajo.', required: true }, A.location(), A.sku('SKU.', ['PerGB2018', 'Free', 'Standalone', 'CapacityReservation'], 'PerGB2018'), { name: 'retention_time', opts: ['--retention-time'], help: 'Días de retención (30-730).', type: 'int' }, A.tags()],
  table: (r: any) => ({ Name: r.name, ResourceGroup: r.resourceGroup, Location: r.location, CustomerId: r.customerId, RetentionInDays: r.retentionInDays }),
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    return flat(await putResource({ type: T_WS, name: a.workspace_name, location: a.location, tags: a.tags, properties: { sku: { name: a.sku }, retentionInDays: a.retention_time } }, rg.name, op(ctx)));
  },
});

register({
  path: 'monitor log-analytics workspace list',
  summary: 'Lista las áreas de trabajo.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((w) => ({ Name: w.name, ResourceGroup: w.resourceGroup, Location: w.location, CustomerId: w.customerId, RetentionInDays: w.retentionInDays })),
  run: (a, ctx) => listInSub(ctx, T_WS, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'monitor log-analytics workspace show',
  summary: 'Muestra un área de trabajo.',
  args: [A.rg(), { name: 'workspace_name', opts: ['--workspace-name', '-n'], help: 'Nombre.', required: true }],
  run: (a, ctx) => flat(getRes(ctx, { ...a, name: a.workspace_name }, T_WS)),
});

register({
  path: 'monitor log-analytics workspace delete',
  summary: 'Elimina un área de trabajo.',
  args: [A.rg(), { name: 'workspace_name', opts: ['--workspace-name', '-n'], help: 'Nombre.', required: true }, A.yes(), { name: 'force', opts: ['--force', '-f'], help: 'Forzar.', type: 'bool' }],
  confirm: 'Are you sure you want to perform this operation?',
  async run(a, ctx) {
    await deleteResource(getRes(ctx, { ...a, name: a.workspace_name }, T_WS).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'monitor log-analytics workspace get-shared-keys',
  summary: 'Obtiene las claves compartidas del área de trabajo.',
  args: [A.rg(), { name: 'workspace_name', opts: ['--workspace-name', '-n'], help: 'Nombre.', required: true }],
  run(a, ctx) {
    const ws = getRes(ctx, { ...a, name: a.workspace_name }, T_WS);
    authorize(ctx.principal, `${T_WS}/sharedKeys/action`, ws.id);
    return { primarySharedKey: btoa(ws.properties.customerId + 'p').slice(0, 86) + '==', secondarySharedKey: btoa(ws.properties.customerId + 's').slice(0, 86) + '==' };
  },
});

register({
  path: 'monitor log-analytics query',
  summary: 'Ejecuta una consulta KQL en un área de trabajo de Log Analytics.',
  args: [{ name: 'workspace', opts: ['--workspace', '-w'], help: 'Id. del área de trabajo (customerId) o nombre.', required: true }, { name: 'analytics_query', opts: ['--analytics-query'], help: 'Consulta KQL.', required: true }, { name: 'timespan', opts: ['--timespan', '-t'], help: 'Intervalo ISO 8601 (p. ej. PT1H).' }],
  examples: [{ title: 'Operaciones de escritura por grupo de recursos.', cmd: `az monitor log-analytics query -w <customerId> --analytics-query "AzureActivity | where OperationNameValue endswith 'WRITE' | summarize count() by ResourceGroup" -o table` }],
  run(a, ctx) {
    const ws = getState().resources.find((r) => ciEq(r.type, T_WS) && (ciEq(r.properties.customerId, a.workspace) || ciEq(r.name, a.workspace) || ciEq(r.id, a.workspace)));
    if (!ws) throw new ArmError('PathNotFoundError', `The requested path does not exist (workspace '${a.workspace}' not found).`, 404, 'Usa el customerId: az monitor log-analytics workspace show -g <rg> -n <nombre> --query customerId -o tsv');
    authorize(ctx.principal, 'Microsoft.OperationalInsights/workspaces/read', ws.id);
    const tables = workspaceTables(ws);
    let res;
    try {
      res = runKql(a.analytics_query, (n) => findTable(tables, n));
    } catch (e) {
      if (e instanceof KqlError) throw new ArmError('BadArgumentError', `The request had some invalid properties: ${e.message}`, 400);
      throw e;
    }
    if (a.timespan) {
      const mins = parseIsoDuration(a.timespan);
      const ti = res.columns.findIndex((c) => c.name === 'TimeGenerated');
      if (ti >= 0) res.rows = res.rows.filter((r) => Date.now() - Number(r[ti]) <= mins * 60000);
    }
    return res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c.name, formatKqlValue(r[i], c.type)])).valueOf()).map((o) => ({ ...o, TableName: 'PrimaryResult' }));
  },
});

// ---------------------------------------------------------------- métricas

register({
  path: 'monitor metrics list-definitions',
  summary: 'Lista las métricas disponibles para un recurso.',
  args: [{ name: 'resource', opts: ['--resource'], help: 'Nombre o ID del recurso.', required: true }, A.rg(false), { name: 'resource_type', opts: ['--resource-type'], help: 'Tipo de recurso.' }],
  table: (r: any[]) => r.map((m) => ({ Name: m.name.value, Unit: m.unit, Aggregation: m.primaryAggregationType, DisplayName: m.name.localizedValue })),
  run(a, ctx) {
    const r = resourceArg(ctx, a);
    return metricsFor(r.type).map((m) => ({ name: { value: m.name, localizedValue: m.label }, unit: m.unit, primaryAggregationType: m.aggregation, supportedAggregationTypes: ['Average', 'Count', 'Maximum', 'Minimum', 'Total'], resourceId: r.id }));
  },
});

register({
  path: 'monitor metrics list',
  summary: 'Obtiene los valores de las métricas de un recurso.',
  args: [{ name: 'resource', opts: ['--resource'], help: 'Nombre o ID del recurso.', required: true }, A.rg(false), { name: 'resource_type', opts: ['--resource-type'], help: 'Tipo.' }, { name: 'metrics', opts: ['--metrics', '--metric'], help: 'Nombres de métricas.', type: 'list' }, { name: 'interval', opts: ['--interval'], help: 'Granularidad (PT1M, PT5M, PT1H).', default: 'PT1M' }, { name: 'aggregation', opts: ['--aggregation'], help: 'Agregación.', type: 'list' }, { name: 'start_time', opts: ['--start-time'], help: 'Inicio.' }, { name: 'offset', opts: ['--offset'], help: 'Desplazamiento (1h, 30m).', default: '1h' }],
  examples: [{ title: 'CPU de una VM en la última hora.', cmd: 'az monitor metrics list --resource <vmId> --metric "Percentage CPU" --interval PT5M -o table' }],
  table: (r: any) => r.value.flatMap((m: any) => m.timeseries[0].data.map((d: any) => ({ Timestamp: d.timeStamp, Name: m.name.localizedValue, Average: d.average, Total: d.total, Maximum: d.maximum }))),
  run(a, ctx) {
    const r = resourceArg(ctx, a);
    const defs = metricsFor(r.type);
    const names: string[] = a.metrics ?? [defs[0]?.name].filter(Boolean);
    const stepMin = parseIsoDuration(a.interval);
    const off = /^(\d+)([hmd])$/.exec(a.offset ?? '1h');
    const minutes = off ? Number(off[1]) * (off[2] === 'h' ? 60 : off[2] === 'd' ? 1440 : 1) : 60;
    return {
      cost: 0,
      interval: a.interval,
      namespace: r.type,
      resourceregion: r.location,
      timespan: `${new Date(Date.now() - minutes * 60000).toISOString()}/${nowIso()}`,
      value: names.map((n) => {
        const def = defs.find((d) => ciEq(d.name, n));
        if (!def) throw new ArmError('BadRequest', `Failed to find metric configuration for provider: ${r.type.split('/')[0]}, resource Type: ${r.type.split('/').slice(1).join('/')}, metric: ${n}, Valid metrics: ${defs.map((d) => d.name).join(',')}`, 400);
        const pts = metricSeries(r, def.name, minutes, 60000);
        const data: any[] = [];
        for (let i = 0; i < pts.length; i += Math.max(1, stepMin)) {
          const chunk = pts.slice(i, i + Math.max(1, stepMin)).map((p) => p.v).filter((v): v is number => v !== null);
          data.push({ timeStamp: new Date(pts[i].t).toISOString(), average: chunk.length ? Math.round((aggregateValues(chunk, 'average') ?? 0) * 100) / 100 : null, total: chunk.length ? aggregateValues(chunk, 'total') : null, maximum: chunk.length ? Math.max(...chunk) : null, minimum: chunk.length ? Math.min(...chunk) : null, count: chunk.length });
        }
        return { displayDescription: def.label, errorCode: 'Success', id: `${r.id}/providers/Microsoft.Insights/metrics/${def.name}`, name: { localizedValue: def.label, value: def.name }, resourceGroup: r.resourceGroup, timeseries: [{ data, metadatavalues: [] }], type: 'Microsoft.Insights/metrics', unit: def.unit };
      }),
    };
  },
});

// ---------------------------------------------------------------- alertas y grupos de acciones

const OPS: Record<string, string> = { '>': 'GreaterThan', '>=': 'GreaterThanOrEqual', '<': 'LessThan', '<=': 'LessThanOrEqual', '=': 'Equals', '==': 'Equals' };

register({
  path: 'monitor action-group create',
  summary: 'Crea un grupo de acciones (destinatarios de las alertas).',
  args: [A.rg(), A.name('Nombre del grupo de acciones.'), { name: 'short_name', opts: ['--short-name'], help: 'Nombre corto (máx. 12).' }, { name: 'actions', opts: ['--action', '-a'], help: 'Acción: email <nombre> <correo>. Puedes repetir --action.', type: 'list' }, A.tags()],
  examples: [{ title: 'Grupo que envía un correo.', cmd: 'az monitor action-group create -g rg-lab -n ag-ops --short-name ops --action email admin ops@contoso.com' }],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const emails: any[] = [];
    const toks: string[] = a.actions ?? [];
    for (let i = 0; i < toks.length; i++) {
      if (ciEq(toks[i], 'email')) {
        emails.push({ name: toks[i + 1], emailAddress: toks[i + 2] });
        i += 2;
      }
    }
    return flat(await putResource({ type: T_AG, name: a.name, tags: a.tags, properties: { groupShortName: a.short_name ?? a.name.slice(0, 12), emailReceivers: emails } }, rg.name, op(ctx)));
  },
});

register({
  path: 'monitor action-group list',
  summary: 'Lista los grupos de acciones.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((g) => ({ Name: g.name, ShortName: g.groupShortName, Enabled: g.enabled, ResourceGroup: g.resourceGroup })),
  run: (a, ctx) => listInSub(ctx, T_AG, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'monitor action-group show',
  summary: 'Muestra un grupo de acciones.',
  args: [A.rg(), A.name('Nombre.')],
  run: (a, ctx) => flat(getRes(ctx, a, T_AG)),
});

register({
  path: 'monitor action-group delete',
  summary: 'Elimina un grupo de acciones.',
  args: [A.rg(), A.name('Nombre.')],
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_AG).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'monitor metrics alert create',
  summary: 'Crea una regla de alerta de métricas.',
  args: [A.rg(), A.name('Nombre de la regla.'), { name: 'scopes', opts: ['--scopes'], help: 'IDs de los recursos a vigilar.', type: 'list', required: true }, { name: 'condition', opts: ['--condition'], help: 'Condición: "avg Percentage CPU > 80" (agregación métrica operador umbral).', required: true }, { name: 'description', opts: ['--description'], help: 'Descripción.' }, { name: 'severity', opts: ['--severity'], help: 'Gravedad 0 (crítica) - 4 (detallada).', type: 'int', default: 2 }, { name: 'window_size', opts: ['--window-size'], help: 'Ventana de evaluación (5m, 15m, 1h).', default: '5m' }, { name: 'evaluation_frequency', opts: ['--evaluation-frequency'], help: 'Frecuencia (1m, 5m).', default: '1m' }, { name: 'action', opts: ['--action', '-a'], help: 'Grupos de acciones (nombre o ID).', type: 'list' }, { name: 'auto_mitigate', opts: ['--auto-mitigate'], help: 'Resolver automáticamente.', type: 'bool' }, { name: 'disabled', opts: ['--disabled'], help: 'Crear deshabilitada.', type: 'bool' }, A.tags()],
  examples: [{ title: 'Alerta de CPU alta.', cmd: 'az monitor metrics alert create -g rg-lab -n cpu-alta --scopes $(az vm show -g rg-lab -n vm-web --query id -o tsv) --condition "avg Percentage CPU > 80" --window-size 5m --evaluation-frequency 1m --action ag-ops' }],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const m = /^\s*(avg|average|min|minimum|max|maximum|total|sum|count)\s+(.+?)\s*(>=|<=|==|>|<|=)\s*(-?[\d.]+)\s*$/i.exec(a.condition);
    if (!m) throw cliError(`Invalid condition '${a.condition}'. Formato: "avg Percentage CPU > 80"`);
    const aggMap: Record<string, string> = { avg: 'Average', average: 'Average', min: 'Minimum', minimum: 'Minimum', max: 'Maximum', maximum: 'Maximum', total: 'Total', sum: 'Total', count: 'Count' };
    const toIso = (v: string) => (/^P/i.test(v) ? v.toUpperCase() : `PT${v.toUpperCase().replace(/(\d+)H/, '$1H').replace(/(\d+)M$/, '$1M')}`);
    const actions = (a.action ?? []).map((x: string) => ({ actionGroupId: x.startsWith('/') ? x : resourceId(ctx.subscriptionId, rg.name, T_AG, x) }));
    const r = await putResource({ type: T_ALERT, name: a.name, tags: a.tags, properties: { description: a.description ?? '', severity: a.severity, enabled: !a.disabled, scopes: a.scopes, evaluationFrequency: toIso(a.evaluation_frequency), windowSize: toIso(a.window_size), criteria: { allOf: [{ metricName: m[2].replace(/^["']|["']$/g, ''), operator: OPS[m[3]], threshold: Number(m[4]), timeAggregation: aggMap[m[1].toLowerCase()] }] }, autoMitigate: a.auto_mitigate ?? true, actions } }, rg.name, op(ctx));
    return flat(r);
  },
});

register({
  path: 'monitor metrics alert list',
  summary: 'Lista las reglas de alerta de métricas.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, Enabled: x.enabled, Severity: x.severity, ResourceGroup: x.resourceGroup, WindowSize: x.windowSize })),
  run: (a, ctx) => listInSub(ctx, T_ALERT, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'monitor metrics alert show',
  summary: 'Muestra una regla de alerta.',
  args: [A.rg(), A.name('Nombre.')],
  run: (a, ctx) => flat(getRes(ctx, a, T_ALERT)),
});

register({
  path: 'monitor metrics alert update',
  summary: 'Habilita/deshabilita o cambia una regla de alerta.',
  args: [A.rg(), A.name('Nombre.'), { name: 'enabled', opts: ['--enabled'], help: 'Habilitada.', type: 'bool' }, { name: 'severity', opts: ['--severity'], help: 'Gravedad.', type: 'int' }],
  async run(a, ctx) {
    const r = getRes(ctx, a, T_ALERT);
    return flat(await putResource({ type: T_ALERT, name: r.name, tags: r.tags, properties: { ...r.properties, enabled: a.enabled ?? r.properties.enabled, severity: a.severity ?? r.properties.severity } }, r.resourceGroup, op(ctx)));
  },
});

register({
  path: 'monitor metrics alert delete',
  summary: 'Elimina una regla de alerta.',
  args: [A.rg(), A.name('Nombre.')],
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_ALERT).id, op(ctx));
    return undefined;
  },
});

// ---------------------------------------------------------------- registro de actividad

register({
  path: 'monitor activity-log list',
  summary: 'Lista eventos del registro de actividad.',
  args: [A.rg(false), { name: 'resource_id', opts: ['--resource-id'], help: 'Filtra por recurso.' }, { name: 'caller', opts: ['--caller'], help: 'Filtra por autor.' }, { name: 'offset', opts: ['--offset'], help: 'Intervalo hacia atrás (1h, 6h, 7d).', default: '6h' }, { name: 'status', opts: ['--status'], help: 'Estado.' }, { name: 'max_events', opts: ['--max-events'], help: 'Máximo de eventos.', type: 'int', default: 50 }, { name: 'correlation_id', opts: ['--correlation-id'], help: 'Id. de correlación.' }],
  table: (r: any[]) => r.map((e) => ({ Timestamp: e.eventTimestamp, Caller: e.caller, Operation: e.operationName.localizedValue, Status: e.status.value, ResourceGroup: e.resourceGroupName })),
  run(a, ctx) {
    const off = /^(\d+)([hmd])$/.exec(a.offset);
    const ms = off ? Number(off[1]) * (off[2] === 'h' ? 3600000 : off[2] === 'd' ? 86400000 : 60000) : 6 * 3600000;
    return getState()
      .activityLog.filter((e) => e.subscriptionId === ctx.subscriptionId && Date.now() - new Date(e.time).getTime() <= ms && (!a.resource_group || ciEq(e.resourceGroup, a.resource_group)) && (!a.resource_id || e.resourceId.toLowerCase().startsWith(String(a.resource_id).toLowerCase())) && (!a.caller || ciEq(e.caller, a.caller)) && (!a.status || ciEq(e.status, a.status)) && (!a.correlation_id || e.correlationId === a.correlation_id))
      .slice(-a.max_events)
      .reverse()
      .map((e) => ({ caller: e.caller, category: { localizedValue: e.category, value: e.category }, correlationId: e.correlationId, eventTimestamp: e.time, id: `${e.resourceId}/events/${e.id}`, level: e.level, operationName: { localizedValue: e.operationName, value: e.operationNameValue }, resourceGroupName: e.resourceGroup, resourceId: e.resourceId, status: { localizedValue: e.status, value: e.status }, subscriptionId: e.subscriptionId, properties: e.message ? { message: e.message } : {} }));
  },
});

// ---------------------------------------------------------------- diagnostic settings

register({
  path: 'monitor diagnostic-settings create',
  summary: 'Envía los registros y métricas de un recurso a Log Analytics o a una cuenta de almacenamiento.',
  args: [A.name('Nombre de la configuración.'), { name: 'resource', opts: ['--resource'], help: 'ID del recurso.', required: true }, A.rg(false), { name: 'workspace', opts: ['--workspace'], help: 'ID o nombre del área de trabajo.' }, { name: 'storage_account', opts: ['--storage-account'], help: 'ID de la cuenta de almacenamiento.' }, { name: 'logs', opts: ['--logs'], help: 'JSON con las categorías, p. ej. \'[{"categoryGroup":"allLogs","enabled":true}]\'.', type: 'json' }, { name: 'metrics', opts: ['--metrics'], help: 'JSON de métricas, p. ej. \'[{"category":"AllMetrics","enabled":true}]\'.', type: 'json' }],
  examples: [{ title: 'Enviar registros de una web app a Log Analytics.', cmd: `az monitor diagnostic-settings create -n diag-app --resource <webAppId> --workspace <workspaceId> --logs '[{"category":"AppServiceHTTPLogs","enabled":true}]' --metrics '[{"category":"AllMetrics","enabled":true}]'` }],
  run(a, ctx) {
    const r = resourceArg(ctx, a);
    return diagnosticJson(createDiagnosticSetting({ name: a.name, resourceId: r.id, workspaceId: a.workspace, storageAccountId: a.storage_account, logs: a.logs, metrics: a.metrics }, ctx.principal));
  },
});

register({
  path: 'monitor diagnostic-settings list',
  summary: 'Lista la configuración de diagnóstico de un recurso.',
  args: [{ name: 'resource', opts: ['--resource'], help: 'ID del recurso.', required: true }, A.rg(false)],
  run(a, ctx) {
    const r = resourceArg(ctx, a);
    return getState().diagnosticSettings.filter((d) => ciEq(d.resourceUri, r.id)).map(diagnosticJson);
  },
});

register({
  path: 'monitor diagnostic-settings delete',
  summary: 'Elimina una configuración de diagnóstico.',
  args: [A.name('Nombre.'), { name: 'resource', opts: ['--resource'], help: 'ID del recurso.', required: true }, A.rg(false)],
  run(a, ctx) {
    deleteDiagnosticSetting(resourceArg(ctx, a).id, a.name, ctx.principal);
    return undefined;
  },
});

// ---------------------------------------------------------------- Application Insights

register({
  path: 'monitor app-insights component create',
  summary: 'Crea un recurso de Application Insights (basado en área de trabajo).',
  args: [{ name: 'app', opts: ['--app', '-a'], help: 'Nombre del componente.', required: true }, A.rg(), A.location(), { name: 'workspace', opts: ['--workspace'], help: 'ID o nombre del área de trabajo de Log Analytics.' }, { name: 'application_type', opts: ['--application-type'], help: 'Tipo.', default: 'web' }, { name: 'kind', opts: ['--kind', '-k'], help: 'Tipo.', default: 'web' }, A.tags()],
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    let ws = a.workspace;
    if (ws && !String(ws).startsWith('/')) ws = resourceId(ctx.subscriptionId, rg.name, T_WS, ws);
    if (!ws) ctx.warn('Application Insights clásico se retiró en 2024: indica --workspace para usar un recurso basado en área de trabajo.');
    const r = await putResource({ type: T_AI, name: a.app, location: a.location, tags: a.tags, kind: a.kind, properties: { Application_Type: a.application_type, WorkspaceResourceId: ws } }, rg.name, op(ctx));
    const f = flat(r);
    return { ...f, appId: r.properties.AppId, connectionString: r.properties.ConnectionString, instrumentationKey: r.properties.InstrumentationKey, workspaceResourceId: r.properties.WorkspaceResourceId };
  },
});

register({
  path: 'monitor app-insights component show',
  summary: 'Muestra un componente de Application Insights.',
  args: [{ name: 'app', opts: ['--app', '-a'], help: 'Nombre.', required: true }, A.rg()],
  run(a, ctx) {
    const r = getRes(ctx, { ...a, name: a.app }, T_AI);
    return { ...flat(r), connectionString: r.properties.ConnectionString, instrumentationKey: r.properties.InstrumentationKey };
  },
});

register({
  path: 'monitor app-insights component delete',
  summary: 'Elimina un componente de Application Insights.',
  args: [{ name: 'app', opts: ['--app', '-a'], help: 'Nombre.', required: true }, A.rg()],
  async run(a, ctx) {
    await deleteResource(getRes(ctx, { ...a, name: a.app }, T_AI).id, op(ctx));
    return undefined;
  },
});

// ---------------------------------------------------------------- autoscale

register({
  path: 'monitor autoscale create',
  summary: 'Crea una configuración de escalado automático para un plan de App Service o un VMSS.',
  args: [A.rg(), A.name('Nombre (por defecto, el del recurso).', false), { name: 'resource', opts: ['--resource'], help: 'Nombre o ID del recurso de destino.', required: true }, { name: 'resource_type', opts: ['--resource-type'], help: 'Tipo, p. ej. Microsoft.Web/serverfarms.' }, { name: 'min_count', opts: ['--min-count'], help: 'Mínimo de instancias.', type: 'int', required: true }, { name: 'max_count', opts: ['--max-count'], help: 'Máximo de instancias.', type: 'int', required: true }, { name: 'count', opts: ['--count'], help: 'Instancias por defecto.', type: 'int', required: true }, A.tags()],
  examples: [{ title: 'Autoescalado de un plan entre 1 y 5 instancias.', cmd: 'az monitor autoscale create -g rg-lab --resource asp-lab --resource-type Microsoft.Web/serverfarms --name autoscale-asp --min-count 1 --max-count 5 --count 1' }],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const target = resourceArg(ctx, a);
    const r = await putResource({ type: T_AS, name: a.name ?? target.name, location: target.location, tags: a.tags, properties: { targetResourceUri: target.id, enabled: true, profiles: [{ name: 'default', capacity: { minimum: String(a.min_count), maximum: String(a.max_count), default: String(a.count) }, rules: [] }] } }, rg.name, op(ctx));
    return flat(r);
  },
});

register({
  path: 'monitor autoscale rule create',
  summary: 'Añade una regla de escalado (p. ej. "CpuPercentage > 70 avg 5m" → scale out 1).',
  args: [A.rg(), { name: 'autoscale_name', opts: ['--autoscale-name'], help: 'Configuración de escalado.', required: true }, { name: 'condition', opts: ['--condition'], help: 'Condición: "CpuPercentage > 70 avg 5m".', required: true }, { name: 'scale', opts: ['--scale'], help: 'Acción: "out 1", "in 1", "to 3".', type: 'list', required: true }, { name: 'cooldown', opts: ['--cooldown'], help: 'Minutos de enfriamiento.', type: 'int', default: 5 }],
  examples: [{ title: 'Escalar hacia fuera con CPU alta.', cmd: 'az monitor autoscale rule create -g rg-lab --autoscale-name autoscale-asp --condition "CpuPercentage > 70 avg 5m" --scale out 1' }],
  run(a, ctx) {
    const as = getRes(ctx, { ...a, name: a.autoscale_name }, T_AS);
    const m = /^\s*(.+?)\s*(>=|<=|>|<|==)\s*(-?[\d.]+)\s*(avg|min|max|total|count)?\s*(\d+[mh])?\s*$/i.exec(a.condition);
    if (!m) throw cliError(`Invalid condition '${a.condition}'. Formato: "CpuPercentage > 70 avg 5m"`);
    const [dir, val] = a.scale as string[];
    const aggMap: Record<string, string> = { avg: 'Average', min: 'Minimum', max: 'Maximum', total: 'Total', count: 'Count' };
    const rule = {
      metricTrigger: { metricName: m[1], metricResourceUri: as.properties.targetResourceUri, operator: OPS[m[2]] ?? 'GreaterThan', threshold: Number(m[3]), timeAggregation: aggMap[(m[4] ?? 'avg').toLowerCase()], timeGrain: 'PT1M', timeWindow: `PT${(m[5] ?? '5m').toUpperCase()}`, statistic: 'Average' },
      scaleAction: { direction: dir === 'in' ? 'Decrease' : 'Increase', type: dir === 'to' ? 'ExactCount' : 'ChangeCount', value: String(val ?? 1), cooldown: `PT${a.cooldown}M` },
    };
    as.properties.profiles[0].rules.push(rule);
    changed();
    return rule;
  },
});

register({
  path: 'monitor autoscale show',
  summary: 'Muestra una configuración de escalado automático.',
  args: [A.rg(), A.name('Nombre.')],
  run: (a, ctx) => flat(getRes(ctx, a, T_AS)),
});

register({
  path: 'monitor autoscale list',
  summary: 'Lista las configuraciones de escalado automático.',
  args: [A.rg(false)],
  run: (a, ctx) => listInSub(ctx, T_AS, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'monitor autoscale delete',
  summary: 'Elimina una configuración de escalado automático.',
  args: [A.rg(), A.name('Nombre.')],
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_AS).id, op(ctx));
    return undefined;
  },
});

// ---------------------------------------------------------------- costes y Advisor

register({
  path: 'consumption budget create',
  summary: 'Crea un presupuesto con avisos por correo.',
  args: [{ name: 'budget_name', opts: ['--budget-name', '-n'], help: 'Nombre del presupuesto.', required: true }, { name: 'amount', opts: ['--amount'], help: 'Importe mensual (USD).', type: 'float', required: true }, { name: 'category', opts: ['--category'], help: 'Categoría.', choices: ['cost', 'usage'], default: 'cost' }, { name: 'time_grain', opts: ['--time-grain'], help: 'Periodo.', choices: ['monthly', 'quarterly', 'annually'], default: 'monthly' }, { name: 'start_date', opts: ['--start-date'], help: 'Inicio (YYYY-MM-DD).' }, { name: 'end_date', opts: ['--end-date'], help: 'Fin.' }, { name: 'thresholds', opts: ['--thresholds'], help: 'Porcentajes de aviso (p. ej. 50 80 100).', type: 'list' }, { name: 'contact_emails', opts: ['--contact-emails'], help: 'Correos.', type: 'list' }, A.rg(false)],
  run(a, ctx) {
    const b = createBudget({ name: a.budget_name, amount: a.amount, thresholds: (a.thresholds ?? ['80', '100']).map(Number), contactEmails: a.contact_emails ?? [ctx.principal.name], scope: a.resource_group ? requireRg(ctx, a.resource_group).id : undefined }, ctx.principal);
    return { amount: b.amount, category: 'Cost', currentSpend: { amount: totalCost(getState(), ctx.subscriptionId), unit: 'USD' }, id: b.id, name: b.name, notifications: Object.fromEntries(b.thresholds.map((t) => [`Actual_GreaterThan_${t}_Percent`, { contactEmails: b.contactEmails, enabled: true, operator: 'GreaterThan', threshold: t }])), timeGrain: 'Monthly', type: 'Microsoft.Consumption/budgets' };
  },
});

register({
  path: 'consumption budget list',
  summary: 'Lista los presupuestos.',
  args: [],
  table: (r: any[]) => r.map((b) => ({ Name: b.name, Amount: b.amount, CurrentSpend: b.currentSpend.amount.toFixed(2), TimeGrain: b.timeGrain })),
  run: (_a, ctx) => getState().budgets.map((b) => ({ amount: b.amount, currentSpend: { amount: totalCost(getState(), ctx.subscriptionId), unit: 'USD' }, id: b.id, name: b.name, timeGrain: b.timeGrain })),
});

register({
  path: 'consumption budget delete',
  summary: 'Elimina un presupuesto.',
  args: [{ name: 'budget_name', opts: ['--budget-name', '-n'], help: 'Nombre.', required: true }],
  run(a) {
    const s = getState();
    s.budgets = s.budgets.filter((b) => !ciEq(b.name, a.budget_name));
    changed();
    return undefined;
  },
});

register({
  path: 'consumption usage list',
  summary: 'Lista el consumo (coste simulado acumulado por recurso).',
  args: [{ name: 'top', opts: ['--top'], help: 'Número de registros.', type: 'int' }],
  table: (r: any[]) => r.map((x) => ({ InstanceName: x.instanceName, ConsumedService: x.consumedService, PretaxCost: x.pretaxCost, Currency: x.currency, ResourceGroup: x.resourceGroup })),
  run(a, ctx) {
    const rows = Object.values(getState().costs).filter((c) => c.subscriptionId === ctx.subscriptionId).sort((x, y) => y.amount - x.amount).map((c) => ({ consumedService: c.type.split('/')[0], currency: 'USD', instanceId: c.resourceId, instanceName: c.name, pretaxCost: c.amount.toFixed(4), resourceGroup: c.resourceGroup, usageStart: getState().createdAt }));
    return a.top ? rows.slice(0, a.top) : rows;
  },
});

register({
  path: 'costmanagement query',
  summary: 'Consulta de costes agregados (simulados).',
  args: [{ name: 'type', opts: ['--type'], help: 'Tipo.', default: 'ActualCost' }, { name: 'grouping', opts: ['--grouping'], help: 'Agrupación: ResourceGroup o ServiceName.', default: 'ResourceGroup' }],
  run(a, ctx) {
    const key = a.grouping === 'ServiceName' ? 'type' : 'resourceGroup';
    return { columns: [{ name: 'Cost', type: 'Number' }, { name: a.grouping, type: 'String' }, { name: 'Currency', type: 'String' }], rows: costByGroup(getState(), key, ctx.subscriptionId).map((x) => [Number(x.amount.toFixed(4)), x.key, 'USD']), forecastMonthly: Number(forecastMonthly(getState(), ctx.subscriptionId).toFixed(2)) };
  },
});

register({
  path: 'advisor recommendation list',
  summary: 'Lista las recomendaciones de Azure Advisor.',
  args: [{ name: 'category', opts: ['--category', '-c'], help: 'Categoría.', choices: ['Cost', 'Security', 'HighAvailability', 'Performance', 'OperationalExcellence'] }, A.rg(false)],
  table: (r: any[]) => r.map((x) => ({ Category: x.category, Impact: x.impact, Problem: x.shortDescription.problem, ImpactedValue: x.impactedValue })),
  run(a, ctx) {
    const map: Record<string, string> = { Coste: 'Cost', Seguridad: 'Security', Confiabilidad: 'HighAvailability', 'Excelencia operativa': 'OperationalExcellence', Rendimiento: 'Performance' };
    const impact: Record<string, string> = { Alto: 'High', Medio: 'Medium', Bajo: 'Low' };
    return advisorRecommendations()
      .filter((r) => r.resource.subscriptionId === ctx.subscriptionId && (!a.category || map[r.category] === a.category) && (!a.resource_group || ciEq(r.resource.resourceGroup, a.resource_group)))
      .map((r) => ({ category: map[r.category], id: `${r.resource.id}/providers/Microsoft.Advisor/recommendations/${r.title.length}`, impact: impact[r.impact], impactedField: r.resource.type, impactedValue: r.resource.name, resourceGroup: r.resource.resourceGroup, shortDescription: { problem: r.title, solution: r.fix }, extendedProperties: r.savings ? { savingsAmount: r.savings.toFixed(2), savingsCurrency: 'USD' } : {} }));
  },
});

export function _monitorUnused() {
  return findTable;
}
