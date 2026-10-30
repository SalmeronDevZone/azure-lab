// Microsoft.Insights / Microsoft.OperationalInsights: Log Analytics, Application Insights, alertas y escalado automático.
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { METRIC_CATALOG } from '../catalog';
import { ciEq, guid, nowIso } from '../util';

registerProvider({
  type: 'Microsoft.OperationalInsights/workspaces',
  label: 'Área de trabajo de Log Analytics',
  labelPlural: 'Áreas de trabajo de Log Analytics',
  icon: 'loganalytics',
  category: 'Supervisión',
  description: 'Almacén central de registros consultable con KQL.',
  provisionMs: 2500,
  nameRule: { test: (n) => /^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$/.test(n), message: "Workspace name '{name}' is invalid (4-63 caracteres: letras, números y guiones)." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const retention = Number(p.retentionInDays ?? ex?.properties.retentionInDays ?? 30);
    if (retention < 30 || retention > 730) throw new ArmError('InvalidParameter', 'retentionInDays must be between 30 and 730.');
    const r = baseResource(input, ctx);
    r.properties = {
      customerId: ex?.properties.customerId ?? guid(),
      sku: { name: p.sku?.name ?? ex?.properties.sku?.name ?? 'PerGB2018' },
      retentionInDays: retention,
      workspaceCapping: { dailyQuotaGb: p.workspaceCapping?.dailyQuotaGb ?? -1 },
      publicNetworkAccessForIngestion: 'Enabled',
      publicNetworkAccessForQuery: 'Enabled',
      features: { enableLogAccessUsingOnlyResourcePermissions: true },
      createdDate: ex?.properties.createdDate ?? nowIso(),
    };
    return r;
  },
  essentials(res) {
    return [
      ['Id. del área de trabajo', res.properties.customerId],
      ['Plan de tarifa', 'Pago por GB (2018)'],
      ['Retención', `${res.properties.retentionInDays} días`],
    ];
  },
  monthlyCost: () => 2.3,
});

registerProvider({
  type: 'Microsoft.Insights/components',
  label: 'Application Insights',
  labelPlural: 'Application Insights',
  icon: 'appinsights',
  category: 'Supervisión',
  description: 'APM: telemetría, solicitudes, errores y dependencias de tus aplicaciones.',
  provisionMs: 2000,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const ikey = ex?.properties.InstrumentationKey ?? guid();
    const appId = ex?.properties.AppId ?? guid();
    const ws = p.WorkspaceResourceId ?? ex?.properties.WorkspaceResourceId ?? null;
    if (ws && !ctx.state.resources.some((r) => ciEq(r.id, ws))) throw new ArmError('BadRequest', `Workspace '${ws}' not found.`, 404);
    const r = baseResource(input, ctx);
    r.kind = input.kind ?? ex?.kind ?? 'web';
    r.properties = {
      ApplicationId: input.name,
      AppId: appId,
      Application_Type: p.Application_Type ?? 'web',
      InstrumentationKey: ikey,
      ConnectionString: `InstrumentationKey=${ikey};IngestionEndpoint=https://${input.location}-5.in.applicationinsights.azure.com/;LiveEndpoint=https://${input.location}.livediagnostics.monitor.azure.com/;ApplicationId=${appId}`,
      WorkspaceResourceId: ws,
      IngestionMode: 'LogAnalytics',
      RetentionInDays: 90,
      publicNetworkAccessForIngestion: 'Enabled',
      publicNetworkAccessForQuery: 'Enabled',
      CreationDate: ex?.properties.CreationDate ?? nowIso(),
    };
    return r;
  },
  essentials(res, s) {
    const ws = res.properties.WorkspaceResourceId ? s.resources.find((r) => ciEq(r.id, res.properties.WorkspaceResourceId)) : undefined;
    return [
      ['Clave de instrumentación', res.properties.InstrumentationKey],
      ['Cadena de conexión', res.properties.ConnectionString.slice(0, 60) + '…'],
      ['Área de trabajo', ws ? { text: ws.name, link: ws.id } : 'Clásico (sin área de trabajo)'],
    ];
  },
  monthlyCost: () => 0,
});

registerProvider({
  type: 'Microsoft.Insights/actionGroups',
  label: 'Grupo de acciones',
  labelPlural: 'Grupos de acciones',
  icon: 'actiongroup',
  category: 'Supervisión',
  description: 'Quién recibe las notificaciones de una alerta y cómo (correo, SMS, webhook...).',
  provisionMs: 900,
  locationless: true,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const short = p.groupShortName ?? ex?.properties.groupShortName ?? input.name.slice(0, 12);
    if (short.length > 12) throw new ArmError('BadRequest', `The short name '${short}' is too long. Maximum length is 12 characters.`);
    const r = baseResource({ ...input, location: 'Global' }, ctx);
    r.location = 'Global';
    r.properties = {
      groupShortName: short,
      enabled: p.enabled ?? ex?.properties.enabled ?? true,
      emailReceivers: (p.emailReceivers ?? ex?.properties.emailReceivers ?? []).map((e: any) => ({ name: e.name, emailAddress: e.emailAddress, useCommonAlertSchema: e.useCommonAlertSchema ?? true, status: 'Enabled' })),
      smsReceivers: p.smsReceivers ?? ex?.properties.smsReceivers ?? [],
      webhookReceivers: p.webhookReceivers ?? ex?.properties.webhookReceivers ?? [],
      armRoleReceivers: p.armRoleReceivers ?? ex?.properties.armRoleReceivers ?? [],
      azureAppPushReceivers: [],
      itsmReceivers: [],
      automationRunbookReceivers: [],
      voiceReceivers: [],
      logicAppReceivers: [],
      azureFunctionReceivers: [],
      eventHubReceivers: [],
    };
    return r;
  },
  essentials(res) {
    return [
      ['Nombre corto', res.properties.groupShortName],
      ['Correo electrónico', (res.properties.emailReceivers ?? []).map((e: any) => e.emailAddress).join(', ') || '-'],
      ['Estado', res.properties.enabled ? 'Habilitado' : 'Deshabilitado'],
    ];
  },
  monthlyCost: () => 0,
});

registerProvider({
  type: 'Microsoft.Insights/metricAlerts',
  label: 'Regla de alertas de métricas',
  labelPlural: 'Reglas de alertas',
  icon: 'alert',
  category: 'Supervisión',
  description: 'Evalúa métricas periódicamente y dispara acciones cuando se cumple una condición.',
  provisionMs: 900,
  locationless: true,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const scopes: string[] = p.scopes ?? ex?.properties.scopes ?? [];
    if (!scopes.length) throw new ArmError('BadRequest', 'At least one scope is required for a metric alert.');
    const targets = scopes.map((sc) => {
      const t = ctx.state.resources.find((r) => ciEq(r.id, sc));
      if (!t) throw new ArmError('ResourceNotFound', `The resource '${sc}' was not found.`, 404);
      return t;
    });
    const criteria = p.criteria ?? ex?.properties.criteria;
    const allOf: any[] = criteria?.allOf ?? [];
    if (!allOf.length) throw new ArmError('BadRequest', 'Alert criteria must contain at least one condition.');
    const metrics = METRIC_CATALOG[targets[0].type.toLowerCase()] ?? [];
    for (const c of allOf) {
      if (!metrics.some((m) => ciEq(m.name, c.metricName))) {
        throw new ArmError('BadRequest', `Couldn't find a metric named ${c.metricName}. Make sure the name is correct. Available metrics: ${metrics.map((m) => m.name).join(', ')}`);
      }
    }
    const sev = Number(p.severity ?? ex?.properties.severity ?? 2);
    if (sev < 0 || sev > 4) throw new ArmError('BadRequest', 'Severity must be between 0 and 4.');
    for (const a of p.actions ?? []) {
      if (!ctx.state.resources.some((r) => ciEq(r.id, a.actionGroupId))) throw new ArmError('ResourceNotFound', `Action group '${a.actionGroupId}' not found.`, 404);
    }
    const r = baseResource({ ...input, location: 'global' }, ctx);
    r.location = 'global';
    r.properties = {
      description: p.description ?? ex?.properties.description ?? '',
      severity: sev,
      enabled: p.enabled ?? ex?.properties.enabled ?? true,
      scopes: targets.map((t) => t.id),
      evaluationFrequency: p.evaluationFrequency ?? ex?.properties.evaluationFrequency ?? 'PT1M',
      windowSize: p.windowSize ?? ex?.properties.windowSize ?? 'PT5M',
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria',
        allOf: allOf.map((c, i) => ({
          name: c.name ?? `cond${i + 1}`,
          metricName: metrics.find((m) => ciEq(m.name, c.metricName))!.name,
          metricNamespace: targets[0].type,
          operator: c.operator ?? 'GreaterThan',
          threshold: Number(c.threshold),
          timeAggregation: c.timeAggregation ?? 'Average',
          criterionType: 'StaticThresholdCriterion',
          dimensions: [],
        })),
      },
      autoMitigate: p.autoMitigate ?? true,
      targetResourceType: targets[0].type,
      targetResourceRegion: targets[0].location,
      actions: (p.actions ?? ex?.properties.actions ?? []).map((a: any) => ({ actionGroupId: a.actionGroupId, webHookProperties: a.webHookProperties ?? {} })),
    };
    r.data = { ...(r.data ?? {}), lastState: r.data?.lastState ?? 'Resolved' };
    return r;
  },
  essentials(res, s) {
    const c = res.properties.criteria?.allOf?.[0];
    const target = s.resources.find((r) => ciEq(r.id, res.properties.scopes?.[0]));
    const opMap: Record<string, string> = { GreaterThan: '>', GreaterThanOrEqual: '>=', LessThan: '<', LessThanOrEqual: '<=', Equals: '=' };
    return [
      ['Recurso de destino', target ? { text: target.name, link: target.id } : '-'],
      ['Condición', c ? `${c.timeAggregation} ${c.metricName} ${opMap[c.operator] ?? c.operator} ${c.threshold}` : '-'],
      ['Gravedad', `Sev${res.properties.severity}`],
      ['Frecuencia / ventana', `${res.properties.evaluationFrequency} / ${res.properties.windowSize}`],
      ['Estado', res.properties.enabled ? 'Habilitada' : 'Deshabilitada'],
    ];
  },
  monthlyCost: () => 0.1,
});

registerProvider({
  type: 'Microsoft.Insights/autoscalesettings',
  label: 'Configuración de escalado automático',
  labelPlural: 'Configuraciones de escalado automático',
  icon: 'autoscale',
  category: 'Supervisión',
  provisionMs: 900,
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const target = p.targetResourceUri ?? ex?.properties.targetResourceUri;
    const t = ctx.state.resources.find((r) => ciEq(r.id, target));
    if (!t) throw new ArmError('ResourceNotFound', `Target resource '${target}' not found.`, 404);
    if (ciEq(t.type, 'Microsoft.Web/serverfarms') && !['Standard', 'PremiumV3', 'Premium', 'PremiumV2', 'ElasticPremium'].includes(t.sku?.tier ?? '')) {
      throw new ArmError('BadRequest', `Autoscale is not supported for the '${t.sku?.tier}' tier. Upgrade the App Service plan to Standard or higher.`, 400, 'El escalado automático requiere un plan Standard (S1) o superior.');
    }
    const r = baseResource(input, ctx);
    r.properties = {
      enabled: p.enabled ?? ex?.properties.enabled ?? true,
      targetResourceUri: t.id,
      profiles: p.profiles ?? ex?.properties.profiles ?? [],
      notifications: p.notifications ?? ex?.properties.notifications ?? [],
      name: input.name,
    };
    r.data = { ...(r.data ?? {}), lastScale: r.data?.lastScale ?? 0 };
    return r;
  },
  essentials(res, s) {
    const t = s.resources.find((r) => ciEq(r.id, res.properties.targetResourceUri));
    const prof = res.properties.profiles?.[0];
    return [
      ['Recurso de destino', t ? { text: t.name, link: t.id } : '-'],
      ['Instancias (mín/máx/predet.)', prof ? `${prof.capacity.minimum} / ${prof.capacity.maximum} / ${prof.capacity.default}` : '-'],
      ['Reglas', String(prof?.rules?.length ?? 0)],
    ];
  },
  monthlyCost: () => 0,
});
