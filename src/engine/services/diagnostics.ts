// Configuración de diagnóstico: envía registros/métricas de un recurso a Log Analytics o Storage.
import type { DiagnosticSetting, PrincipalRef } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, findResource, logActivity, notFound } from '../arm';
import { ciEq, guid, nowIso } from '../util';

export const LOG_CATEGORIES: Record<string, string[]> = {
  'microsoft.web/sites': ['AppServiceHTTPLogs', 'AppServiceConsoleLogs', 'AppServiceAppLogs', 'AppServiceAuditLogs', 'AppServicePlatformLogs'],
  'microsoft.storage/storageaccounts': ['StorageRead', 'StorageWrite', 'StorageDelete'],
  'microsoft.keyvault/vaults': ['AuditEvent', 'AzurePolicyEvaluationDetails'],
  'microsoft.sql/servers/databases': ['SQLInsights', 'Errors', 'Timeouts', 'Deadlocks'],
  'microsoft.network/networksecuritygroups': ['NetworkSecurityGroupEvent', 'NetworkSecurityGroupRuleCounter'],
  'microsoft.containerservice/managedclusters': ['kube-apiserver', 'kube-audit', 'kube-controller-manager', 'cluster-autoscaler'],
  'microsoft.containerregistry/registries': ['ContainerRegistryRepositoryEvents', 'ContainerRegistryLoginEvents'],
  'microsoft.compute/virtualmachines': [],
};

export function createDiagnosticSetting(input: { name: string; resourceId: string; workspaceId?: string; storageAccountId?: string; logs?: { category?: string; categoryGroup?: string; enabled: boolean }[]; metrics?: { category: string; enabled: boolean }[] }, principal: PrincipalRef | null): DiagnosticSetting {
  const s = getState();
  const res = findResource(input.resourceId) ?? (input.resourceId.split('/').length === 3 ? null : undefined);
  const target = res ?? (/^\/subscriptions\/[^/]+$/i.test(input.resourceId) ? null : undefined);
  if (target === undefined) throw notFound(input.resourceId);
  authorize(principal, 'Microsoft.Insights/diagnosticSettings/write', input.resourceId);
  if (!input.workspaceId && !input.storageAccountId) throw new ArmError('BadRequest', 'At least one destination (workspace, storage account or event hub) must be specified.');
  let wsId: string | undefined;
  if (input.workspaceId) {
    const ws = s.resources.find((r) => ciEq(r.type, 'Microsoft.OperationalInsights/workspaces') && (ciEq(r.id, input.workspaceId!) || ciEq(r.name, input.workspaceId!) || ciEq(r.properties.customerId, input.workspaceId!)));
    if (!ws) throw new ArmError('ResourceNotFound', `Workspace '${input.workspaceId}' not found.`, 404);
    wsId = ws.id;
  }
  const type = (res?.type ?? '').toLowerCase();
  const allowed = LOG_CATEGORIES[type] ?? [];
  for (const l of input.logs ?? []) {
    if (l.category && allowed.length && !allowed.some((c) => ciEq(c, l.category))) {
      throw new ArmError('BadRequest', `Category '${l.category}' is not supported. Supported categories: ${allowed.join(', ')}.`);
    }
  }
  s.diagnosticSettings = s.diagnosticSettings.filter((d) => !(ciEq(d.resourceUri, input.resourceId) && ciEq(d.name, input.name)));
  const ds: DiagnosticSetting = {
    id: `${res?.id ?? input.resourceId}/providers/microsoft.insights/diagnosticSettings/${input.name}`,
    name: input.name,
    resourceUri: res?.id ?? input.resourceId,
    workspaceId: wsId,
    storageAccountId: input.storageAccountId,
    logs: input.logs?.length ? input.logs : allowed.length ? [{ categoryGroup: 'allLogs', enabled: true }] : [],
    metrics: input.metrics ?? [{ category: 'AllMetrics', enabled: true }],
    createdAt: nowIso(),
  };
  s.diagnosticSettings.push(ds);
  logActivity({ operationNameValue: 'Microsoft.Insights/diagnosticSettings/write', operationName: `Crear configuración de diagnóstico ${input.name}`, status: 'Succeeded', resourceId: ds.id, subscriptionId: res?.subscriptionId ?? s.currentSubscriptionId, caller: principal?.name });
  changed();
  return ds;
}

export function deleteDiagnosticSetting(resourceId: string, name: string, principal: PrincipalRef | null) {
  const s = getState();
  const ds = s.diagnosticSettings.find((d) => ciEq(d.resourceUri, resourceId) && ciEq(d.name, name));
  if (!ds) throw new ArmError('ResourceNotFound', `Diagnostic setting '${name}' not found.`, 404);
  authorize(principal, 'Microsoft.Insights/diagnosticSettings/delete', resourceId);
  s.diagnosticSettings = s.diagnosticSettings.filter((d) => d !== ds);
  changed();
}

export function diagnosticJson(d: DiagnosticSetting) {
  return {
    eventHubAuthorizationRuleId: null,
    eventHubName: null,
    id: d.id,
    logAnalyticsDestinationType: null,
    logs: d.logs.map((l) => ({ category: l.category ?? null, categoryGroup: l.categoryGroup ?? null, enabled: l.enabled, retentionPolicy: { days: 0, enabled: false } })),
    metrics: d.metrics.map((m) => ({ category: m.category, enabled: m.enabled, retentionPolicy: { days: 0, enabled: false } })),
    name: d.name,
    resourceGroup: d.resourceUri.split('/')[4],
    storageAccountId: d.storageAccountId ?? null,
    type: 'Microsoft.Insights/diagnosticSettings',
    workspaceId: d.workspaceId ?? null,
  };
}

export function newDiagName() {
  return `diag-${guid().slice(0, 6)}`;
}
