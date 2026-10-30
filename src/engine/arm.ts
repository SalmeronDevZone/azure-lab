// Motor de Azure Resource Manager simulado: RBAC, bloqueos, directivas, aprovisionamiento y registro de actividad.
import type {
  ActivityLogEntry,
  CloudState,
  Lock,
  Permission,
  PortalNotification,
  PrincipalRef,
  Resource,
  ResourceGroup,
  RoleDefinition,
  SimEvent,
  Subscription,
  Tags,
} from './types';
import { ArmError } from './errors';
import { getState, mutate, changed, speedFactor, portalPrincipal, bus } from './store';
import { getProvider, type ArmInput, type BuildCtx } from './registry';
import { isWithinScope, normScope, parseResourceId, resourceId, rgId } from './ids';
import { BUILTIN_ROLES, GLOBALLY_TAKEN, LOCATIONS, POLICY_DEFINITIONS, findLocation, type PolicyDefinitionInfo } from './catalog';
import { ciEq, guid, globMatch, nowIso, sleep } from './util';

export interface OpOpts {
  principal?: PrincipalRef | null;
  subscriptionId?: string;
  noWait?: boolean;
  source?: 'portal' | 'cli' | 'pipeline' | 'terraform' | 'arm';
  skipAuth?: boolean;
  delayMs?: number;
  correlationId?: string;
}

// ---------------------------------------------------------------- búsquedas

export function currentSubscription(s: CloudState = getState()): Subscription {
  return s.subscriptions.find((x) => x.id === s.currentSubscriptionId) ?? s.subscriptions[0];
}

export function findSubscription(idOrName: string, s: CloudState = getState()): Subscription | undefined {
  return s.subscriptions.find((x) => ciEq(x.id, idOrName) || ciEq(x.displayName, idOrName));
}

export function findRg(subscriptionId: string, name: string, s: CloudState = getState()): ResourceGroup | undefined {
  return s.resourceGroups.find((g) => g.subscriptionId === subscriptionId && ciEq(g.name, name));
}

export function findResource(id: string, s: CloudState = getState()): Resource | undefined {
  const n = normScope(id);
  return s.resources.find((r) => normScope(r.id) === n);
}

export function findByName(type: string, name: string, rg?: string, subscriptionId?: string, s: CloudState = getState()): Resource | undefined {
  return s.resources.find(
    (r) =>
      ciEq(r.type, type) &&
      ciEq(r.name, name) &&
      (!rg || ciEq(r.resourceGroup, rg)) &&
      (!subscriptionId || r.subscriptionId === subscriptionId),
  );
}

export function listResources(filter: { type?: string; rg?: string; subscriptionId?: string } = {}, s: CloudState = getState()): Resource[] {
  return s.resources.filter(
    (r) =>
      (!filter.type || ciEq(r.type, filter.type)) &&
      (!filter.rg || ciEq(r.resourceGroup, filter.rg)) &&
      (!filter.subscriptionId || r.subscriptionId === filter.subscriptionId),
  );
}

export function childResources(parent: Resource, childType?: string, s: CloudState = getState()): Resource[] {
  return s.resources.filter((r) => r.id !== parent.id && isWithinScope(r.id, parent.id) && (!childType || ciEq(r.type, childType)));
}

// ---------------------------------------------------------------- RBAC

export function allRoleDefinitions(s: CloudState = getState()): RoleDefinition[] {
  return [...BUILTIN_ROLES, ...s.customRoles];
}

export function roleDefinitionFor(roleDefinitionId: string, s: CloudState = getState()): RoleDefinition | undefined {
  const guidPart = roleDefinitionId.split('/').pop()!.toLowerCase();
  return allRoleDefinitions(s).find((r) => r.name.toLowerCase() === guidPart);
}

export function groupIdsOf(objectId: string, s: CloudState = getState()): string[] {
  const direct = s.groups.filter((g) => g.members.includes(objectId)).map((g) => g.id);
  // un nivel de anidamiento de grupos
  const nested = s.groups.filter((g) => g.members.some((m) => direct.includes(m))).map((g) => g.id);
  return [...new Set([...direct, ...nested])];
}

export function effectivePermissions(principal: PrincipalRef, scope: string, s: CloudState = getState()): Permission[] {
  const ids = new Set([principal.objectId, ...groupIdsOf(principal.objectId, s)]);
  const out: Permission[] = [];
  for (const a of s.roleAssignments) {
    if (!ids.has(a.principalId)) continue;
    if (!isWithinScope(scope, a.scope)) continue;
    const def = roleDefinitionFor(a.roleDefinitionId, s);
    if (def) out.push(...def.permissions);
  }
  return out;
}

function actionAllowed(perms: Permission[], action: string, data: boolean): boolean {
  for (const p of perms) {
    const allow = data ? p.dataActions : p.actions;
    const deny = data ? p.notDataActions : p.notActions;
    if (allow.some((pat) => globMatch(pat, action)) && !deny.some((pat) => globMatch(pat, action))) return true;
  }
  return false;
}

export function hasPermission(principal: PrincipalRef | null | undefined, action: string, scope: string, data = false, s: CloudState = getState()): boolean {
  if (!principal) return false;
  return actionAllowed(effectivePermissions(principal, scope, s), action, data);
}

export function authorize(principal: PrincipalRef | null | undefined, action: string, scope: string, data = false) {
  if (!principal) {
    throw new ArmError('AuthenticationFailed', 'Please run \'az login\' to setup account.', 401);
  }
  if (!hasPermission(principal, action, scope, data)) {
    if (data) {
      throw new ArmError(
        'AuthorizationPermissionMismatch',
        `This request is not authorized to perform this operation using this permission. Caller '${principal.name}' (objectId ${principal.objectId}) needs data action '${action}' on scope '${scope}'.`,
        403,
        'Las acciones de plano de datos (DataActions) requieren roles específicos como "Storage Blob Data Contributor" o "Key Vault Secrets Officer". Ser Owner no basta.',
      );
    }
    throw new ArmError(
      'AuthorizationFailed',
      `The client '${principal.name}' with object id '${principal.objectId}' does not have authorization to perform action '${action}' over scope '${scope}' or the scope is invalid. If access was recently granted, please refresh your credentials.`,
      403,
      'Revisa las asignaciones de roles (az role assignment list --assignee ...) del principal en ese ámbito.',
    );
  }
}

export function canRead(principal: PrincipalRef | null | undefined, scope: string): boolean {
  return hasPermission(principal, 'Microsoft.Resources/subscriptions/resourceGroups/read', scope) || hasPermission(principal, '*/read', scope);
}

// ---------------------------------------------------------------- Bloqueos

export function locksAffecting(targetId: string, s: CloudState = getState()): Lock[] {
  return s.locks.filter((l) => isWithinScope(targetId, l.scope));
}

export function checkLocks(targetId: string, op: 'write' | 'delete', s: CloudState = getState(), includeChildren = false) {
  let locks = locksAffecting(targetId, s);
  if (includeChildren) locks = [...locks, ...s.locks.filter((l) => isWithinScope(l.scope, targetId) && !locks.includes(l))];
  const relevant = op === 'delete' ? locks : locks.filter((l) => l.level === 'ReadOnly');
  if (relevant.length) {
    const scopes = [...new Set(relevant.map((l) => l.scope))].join(',');
    throw new ArmError(
      'ScopeLocked',
      `The scope '${targetId}' cannot perform ${op} operation because following scope(s) are locked: '${scopes}'. Please remove the lock and try again.`,
      409,
      `Hay un bloqueo ${relevant.map((l) => `"${l.name}" (${l.level})`).join(', ')}. Elimínalo con "az lock delete" o desde Bloqueos en el portal si realmente quieres continuar.`,
    );
  }
}

// ---------------------------------------------------------------- Azure Policy

export interface PolicyTarget {
  kind: 'rg' | 'resource';
  id: string;
  name: string;
  type: string;
  location: string;
  tags: Tags;
  sku?: any;
  properties?: any;
  rgTags?: Tags;
}

function param(assignmentParams: Record<string, { value: any }>, key: string): any {
  return assignmentParams?.[key]?.value;
}

function hasTag(tags: Tags, name: string) {
  return Object.keys(tags ?? {}).some((k) => ciEq(k, name));
}

export function policyViolated(def: PolicyDefinitionInfo, params: Record<string, { value: any }>, t: PolicyTarget): boolean {
  const list = (key: string) => ((param(params, key) as string[]) ?? []).map((x) => String(x).toLowerCase());
  switch (def.rule) {
    case 'allowedLocations':
      return t.kind === 'resource' && t.location !== 'global' && !list('listOfAllowedLocations').includes(t.location.toLowerCase());
    case 'allowedLocationsRg':
      return t.kind === 'rg' && !list('listOfAllowedLocations').includes(t.location.toLowerCase());
    case 'requireTag':
      return t.kind === 'resource' && !hasTag(t.tags, param(params, 'tagName'));
    case 'requireTagRg':
      return t.kind === 'rg' && !hasTag(t.tags, param(params, 'tagName'));
    case 'inheritTag': {
      const tag = param(params, 'tagName');
      return t.kind === 'resource' && !hasTag(t.tags, tag) && hasTag(t.rgTags ?? {}, tag);
    }
    case 'allowedVmSkus':
      return t.kind === 'resource' && ciEq(t.type, 'Microsoft.Compute/virtualMachines') && !list('listOfAllowedSKUs').includes(String(t.properties?.hardwareProfile?.vmSize ?? '').toLowerCase());
    case 'notAllowedTypes':
      return t.kind === 'resource' && list('listOfResourceTypesNotAllowed').includes(t.type.toLowerCase());
    case 'allowedStorageSkus':
      return t.kind === 'resource' && ciEq(t.type, 'Microsoft.Storage/storageAccounts') && !list('listOfAllowedSKUs').includes(String(t.sku?.name ?? '').toLowerCase());
    case 'secureTransfer':
      return t.kind === 'resource' && ciEq(t.type, 'Microsoft.Storage/storageAccounts') && t.properties?.supportsHttpsTrafficOnly === false;
    case 'noPublicBlob':
      return t.kind === 'resource' && ciEq(t.type, 'Microsoft.Storage/storageAccounts') && t.properties?.allowBlobPublicAccess === true;
    case 'kvPurgeProtection':
      return t.kind === 'resource' && ciEq(t.type, 'Microsoft.KeyVault/vaults') && !t.properties?.enablePurgeProtection;
  }
  return false;
}

export function evaluatePolicies(t: PolicyTarget, s: CloudState = getState()) {
  const result: { deny?: { assignmentName: string; assignmentId: string; def: PolicyDefinitionInfo }; modifyTags: Tags; audits: string[] } = { modifyTags: {}, audits: [] };
  for (const a of s.policyAssignments) {
    if (!isWithinScope(t.id, a.scope)) continue;
    const def = POLICY_DEFINITIONS.find((d) => a.policyDefinitionId.toLowerCase().endsWith(d.name));
    if (!def) continue;
    if (!policyViolated(def, a.parameters, t)) continue;
    if (def.effect === 'Deny' && a.enforcementMode === 'Default') {
      result.deny = result.deny ?? { assignmentName: a.name, assignmentId: a.id, def };
    } else if (def.effect === 'Modify' && a.enforcementMode === 'Default') {
      const tag = param(a.parameters, 'tagName');
      const rgKey = Object.keys(t.rgTags ?? {}).find((k) => ciEq(k, tag));
      if (rgKey) result.modifyTags[tag] = t.rgTags![rgKey];
    } else {
      result.audits.push(a.name);
    }
  }
  return result;
}

function throwPolicyDenied(name: string, deny: NonNullable<ReturnType<typeof evaluatePolicies>['deny']>, t: PolicyTarget, principal: PrincipalRef, subscriptionId: string): never {
  logActivity({
    operationNameValue: `${t.type}/write`,
    operationName: `Denegado por Azure Policy: ${deny.def.displayName}`,
    status: 'Failed',
    resourceId: t.id,
    subscriptionId,
    caller: principal.name,
    level: 'Error',
    category: 'Policy',
    message: `Asignación: ${deny.assignmentName}`,
  });
  const ident = JSON.stringify([
    {
      policyAssignment: { name: deny.assignmentName, id: deny.assignmentId },
      policyDefinition: { name: deny.def.displayName, id: `/providers/Microsoft.Authorization/policyDefinitions/${deny.def.name}` },
    },
  ]);
  throw new ArmError(
    'RequestDisallowedByPolicy',
    `Resource '${name}' was disallowed by policy. Policy identifiers: '${ident}'.`,
    403,
    `La directiva "${deny.def.displayName}" asignada en este ámbito bloquea la operación. Revisa Directivas > Asignaciones.`,
  );
}

// ---------------------------------------------------------------- Registro de actividad, notificaciones, eventos

export function logActivity(e: Partial<ActivityLogEntry> & { operationNameValue: string; resourceId: string; status: ActivityLogEntry['status']; subscriptionId: string }) {
  const s = getState();
  const parsed = parseResourceId(e.resourceId);
  const entry: ActivityLogEntry = {
    id: guid(),
    time: nowIso(),
    operationName: e.operationName ?? e.operationNameValue,
    caller: e.caller ?? s.me.upn,
    level: e.level ?? (e.status === 'Failed' ? 'Error' : 'Informational'),
    category: e.category ?? 'Administrative',
    resourceGroup: e.resourceGroup ?? parsed.resourceGroup,
    resourceType: e.resourceType ?? parsed.type ?? 'Microsoft.Resources/resourceGroups',
    correlationId: e.correlationId ?? guid(),
    ...e,
  } as ActivityLogEntry;
  s.activityLog.push(entry);
  changed();
  return entry;
}

export function notify(n: Omit<PortalNotification, 'id' | 'time' | 'read'> & { id?: string }): PortalNotification {
  const s = getState();
  const existing = n.id ? s.notifications.find((x) => x.id === n.id) : undefined;
  if (existing) {
    Object.assign(existing, n, { time: nowIso(), read: false });
    changed();
    bus.emit('notification', existing);
    return existing;
  }
  const full: PortalNotification = { id: n.id ?? guid(), time: nowIso(), read: false, ...n };
  s.notifications.unshift(full);
  changed();
  bus.emit('notification', full);
  return full;
}

export function recordEvent(e: Omit<SimEvent, 't'> & { t?: number }) {
  const s = getState();
  s.events.push({ t: Date.now(), ...e });
  changed();
}

export function provisionDelay(baseMs: number): number {
  return Math.round(baseMs * speedFactor());
}

// ---------------------------------------------------------------- Validación de nombres y ubicaciones

export function validateLocation(loc: string | undefined, forType: string): string {
  const l = findLocation(loc);
  if (!l) {
    throw new ArmError(
      'LocationNotAvailableForResourceType',
      `The provided location '${loc}' is not available for resource type '${forType}'. List of available regions for the resource type is '${LOCATIONS.map((x) => x.name).join(',')}'.`,
      400,
    );
  }
  return l.name;
}

const RG_NAME_RE = /^[-\w._()]{1,90}$/;

// ---------------------------------------------------------------- Grupos de recursos

export function createResourceGroup(name: string, location: string, tags: Tags | undefined, opts: OpOpts = {}): ResourceGroup {
  const s = getState();
  const sub = opts.subscriptionId ?? s.currentSubscriptionId;
  const principal = opts.principal === undefined ? portalPrincipal() : opts.principal;
  if (!name || !RG_NAME_RE.test(name) || name.endsWith('.')) {
    throw new ArmError(
      'InvalidResourceGroupName',
      'Resource group names only allow alphanumeric characters, periods, underscores, hyphens and parenthesis and cannot end in a period.',
    );
  }
  const loc = findLocation(location);
  if (!loc) {
    throw new ArmError('LocationNotAvailableForResourceGroup', `The provided location '${location}' is not available for resource group. List of available regions is '${LOCATIONS.map((l) => l.name).join(',')}'.`);
  }
  const id = rgId(sub, name);
  if (!opts.skipAuth) authorize(principal, 'Microsoft.Resources/subscriptions/resourceGroups/write', id);
  const existing = findRg(sub, name, s);
  if (existing) {
    if (existing.location !== loc.name) {
      throw new ArmError('InvalidResourceGroupLocation', `Invalid resource group location '${loc.name}'. The Resource group already exists in location '${existing.location}'.`, 409);
    }
    checkLocks(existing.id, 'write');
    if (tags) existing.tags = { ...tags };
    logActivity({ operationNameValue: 'Microsoft.Resources/subscriptions/resourceGroups/write', operationName: 'Actualizar grupo de recursos', status: 'Succeeded', resourceId: existing.id, subscriptionId: sub, caller: principal!.name, resourceGroup: name });
    changed();
    return existing;
  }
  const finalTags = { ...(tags ?? {}) };
  const ev = evaluatePolicies({ kind: 'rg', id, name, type: 'Microsoft.Resources/resourceGroups', location: loc.name, tags: finalTags }, s);
  if (ev.deny) throwPolicyDenied(name, ev.deny, { kind: 'rg', id, name, type: 'Microsoft.Resources/subscriptions/resourceGroups', location: loc.name, tags: finalTags }, principal!, sub);
  const rg: ResourceGroup = { id, name, location: loc.name, tags: finalTags, subscriptionId: sub, managedBy: null, provisioningState: 'Succeeded', createdAt: nowIso() };
  mutate((st) => st.resourceGroups.push(rg));
  logActivity({ operationNameValue: 'Microsoft.Resources/subscriptions/resourceGroups/write', operationName: 'Crear o actualizar grupo de recursos', status: 'Succeeded', resourceId: id, subscriptionId: sub, caller: principal!.name, resourceGroup: name });
  return rg;
}

export function updateResourceGroupTags(name: string, tags: Tags, opts: OpOpts = {}): ResourceGroup {
  const s = getState();
  const sub = opts.subscriptionId ?? s.currentSubscriptionId;
  const principal = opts.principal === undefined ? portalPrincipal() : opts.principal;
  const rg = findRg(sub, name, s);
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${name}' could not be found.`, 404);
  authorize(principal, 'Microsoft.Resources/subscriptions/resourceGroups/write', rg.id);
  checkLocks(rg.id, 'write');
  const ev = evaluatePolicies({ kind: 'rg', id: rg.id, name, type: 'Microsoft.Resources/resourceGroups', location: rg.location, tags }, s);
  if (ev.deny) throwPolicyDenied(name, ev.deny, { kind: 'rg', id: rg.id, name, type: 'Microsoft.Resources/subscriptions/resourceGroups', location: rg.location, tags }, principal!, sub);
  rg.tags = { ...tags };
  logActivity({ operationNameValue: 'Microsoft.Resources/subscriptions/resourceGroups/write', operationName: 'Actualizar etiquetas del grupo de recursos', status: 'Succeeded', resourceId: rg.id, subscriptionId: sub, caller: principal!.name, resourceGroup: name });
  changed();
  return rg;
}

export async function deleteResourceGroup(name: string, opts: OpOpts = {}): Promise<void> {
  const s = getState();
  const sub = opts.subscriptionId ?? s.currentSubscriptionId;
  const principal = opts.principal === undefined ? portalPrincipal() : opts.principal;
  const rg = findRg(sub, name, s);
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${name}' could not be found.`, 404);
  if (rg.provisioningState === 'Deleting') return;
  authorize(principal, 'Microsoft.Resources/subscriptions/resourceGroups/delete', rg.id);
  checkLocks(rg.id, 'delete', s, true);
  if (rg.managedBy && findResource(rg.managedBy, s)) {
    throw new ArmError(
      'DenyAssignmentAuthorizationFailed',
      `The client '${principal!.name}' has permission to perform action 'Microsoft.Resources/subscriptions/resourceGroups/delete' on scope '${rg.id}'; however, the access is denied because of the deny assignment with name 'Managed resource group deny assignment' and Id '${guid()}' at scope '${rg.id}'.`,
      403,
      'Este grupo de recursos lo administra otro recurso (por ejemplo un clúster AKS). Elimina el recurso propietario y el grupo se borrará solo.',
    );
  }
  const corr = opts.correlationId ?? guid();
  rg.provisioningState = 'Deleting';
  const inside = listResources({ rg: rg.name, subscriptionId: sub }, s);
  inside.forEach((r) => (r.properties.provisioningState = 'Deleting'));
  logActivity({ operationNameValue: 'Microsoft.Resources/subscriptions/resourceGroups/delete', operationName: 'Eliminar grupo de recursos', status: 'Started', resourceId: rg.id, subscriptionId: sub, caller: principal!.name, correlationId: corr });
  changed();
  const finish = async () => {
    const st = getState();
    const resources = listResources({ rg: rg.name, subscriptionId: sub }, st);
    for (const r of resources) {
      getProvider(r.type)?.onDelete?.(r, st);
      markCostDeleted(r, st);
    }
    // grupos administrados (p. ej. MC_ de AKS)
    const managed = st.resourceGroups.filter((g) => g.managedBy && resources.some((r) => ciEq(r.id, g.managedBy!)));
    st.resources = st.resources.filter((r) => !(r.subscriptionId === sub && ciEq(r.resourceGroup, rg.name)));
    st.resourceGroups = st.resourceGroups.filter((g) => g !== rg);
    cleanupScope(rg.id, st);
    for (const m of managed) {
      st.resources.filter((r) => r.subscriptionId === m.subscriptionId && ciEq(r.resourceGroup, m.name)).forEach((r) => markCostDeleted(r, st));
      st.resources = st.resources.filter((r) => !(r.subscriptionId === m.subscriptionId && ciEq(r.resourceGroup, m.name)));
      st.resourceGroups = st.resourceGroups.filter((g) => g !== m);
      cleanupScope(m.id, st);
    }
    logActivity({ operationNameValue: 'Microsoft.Resources/subscriptions/resourceGroups/delete', operationName: 'Eliminar grupo de recursos', status: 'Succeeded', resourceId: rg.id, subscriptionId: sub, caller: principal!.name, correlationId: corr });
    changed();
  };
  const delay = opts.delayMs ?? provisionDelay(1500 + inside.length * 400);
  if (opts.noWait) {
    setTimeout(finish, delay);
    return;
  }
  await sleep(delay);
  await finish();
}

function cleanupScope(scope: string, s: CloudState) {
  s.locks = s.locks.filter((l) => !isWithinScope(l.scope, scope));
  s.roleAssignments = s.roleAssignments.filter((a) => !isWithinScope(a.scope, scope));
  s.policyAssignments = s.policyAssignments.filter((a) => !isWithinScope(a.scope, scope));
  s.diagnosticSettings = s.diagnosticSettings.filter((d) => !isWithinScope(d.resourceUri, scope));
  s.deployments = s.deployments.filter((d) => !isWithinScope(rgId(d.subscriptionId, d.resourceGroup), scope));
  s.recent = s.recent.filter((id) => !isWithinScope(id, scope));
}

function markCostDeleted(r: Resource, s: CloudState) {
  const c = s.costs[r.id.toLowerCase()];
  if (c) c.deleted = true;
}

// ---------------------------------------------------------------- Recursos

export async function putResource(input: ArmInput, rgName: string, opts: OpOpts = {}): Promise<Resource> {
  const s = getState();
  const sub = opts.subscriptionId ?? s.currentSubscriptionId;
  const principal = opts.principal === undefined ? portalPrincipal() : opts.principal;
  if (!principal) throw new ArmError('AuthenticationFailed', "Please run 'az login' to setup account.", 401);
  const rg = findRg(sub, rgName, s);
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${rgName}' could not be found.`, 404);
  if (rg.provisioningState === 'Deleting') {
    throw new ArmError('ResourceGroupBeingDeleted', `The resource group '${rgName}' is in deprovisioning state and cannot perform this operation.`, 409);
  }
  const provider = getProvider(input.type);
  if (!provider) {
    throw new ArmError('NoRegisteredProviderFound', `No registered resource provider found for type '${input.type}'. (El simulador todavía no soporta este tipo de recurso.)`, 400);
  }
  if (!input.name || !String(input.name).trim()) throw new ArmError('InvalidResourceName', 'The resource name cannot be empty.');
  const name = String(input.name);
  const shortName = name.split('/').pop()!;
  if (provider.nameRule && !provider.nameRule.test(shortName)) {
    throw new ArmError('InvalidResourceName', provider.nameRule.message.replace('{name}', shortName));
  }
  const id = resourceId(sub, rg.name, provider.type, name);
  const existing = findResource(id, s);
  if (existing && existing.properties.provisioningState === 'Deleting') {
    throw new ArmError('Conflict', `The resource '${name}' is being deleted.`, 409);
  }
  if (!opts.skipAuth) authorize(principal, `${provider.type}/write`, id);
  checkLocks(id, 'write', s);

  if (provider.parentType) {
    const parentId = id.split('/').slice(0, -2).join('/');
    if (!findResource(parentId, s)) {
      throw new ArmError('ParentResourceNotFound', `Can not perform requested operation on nested resource. Parent resource '${name.split('/').slice(0, -1).join('/')}' not found.`, 404);
    }
  }

  if (provider.global && !existing) {
    const lower = shortName.toLowerCase();
    const takenByOther = GLOBALLY_TAKEN.has(lower);
    const takenHere = s.resources.some((r) => ciEq(r.type, provider.type) && ciEq(r.name, name) && r.id.toLowerCase() !== id.toLowerCase());
    const softDeleted = ciEq(provider.type, 'Microsoft.KeyVault/vaults') && s.deletedVaults.some((v) => ciEq(v.name, name));
    if (softDeleted) {
      throw new ArmError(
        'ConflictError',
        `A vault with the same name already exists in deleted state. You need to either recover or purge existing key vault. Follow this link https://go.microsoft.com/fwlink/?linkid=2149745 for more information on soft delete.`,
        409,
        'El almacén está en estado de eliminación temporal (soft delete). Usa "az keyvault recover" o "az keyvault purge".',
      );
    }
    if (takenByOther || takenHere) {
      throw new ArmError(provider.global.code, provider.global.message(shortName), 409, 'Este tipo de recurso necesita un nombre único en todo Azure (forma parte de un nombre DNS). Añade un sufijo, por ejemplo tus iniciales y un número.');
    }
  }

  let location = input.location ?? existing?.location ?? rg.location;
  if (provider.locationless || ciEq(location, 'global')) location = provider.locationless ? (input.location ?? 'global') : 'global';
  else location = validateLocation(location, provider.type);

  const ctx: BuildCtx = { state: s, principal, subscriptionId: sub, resourceGroup: rg, id, existing };
  const res = provider.build({ ...input, type: provider.type, name, location }, ctx);

  if (!provider.hidden) {
    const target: PolicyTarget = { kind: 'resource', id, name, type: provider.type, location: res.location, tags: res.tags, sku: res.sku, properties: res.properties, rgTags: rg.tags };
    const ev = evaluatePolicies(target, s);
    if (ev.deny) throwPolicyDenied(name, ev.deny, target, principal, sub);
    if (Object.keys(ev.modifyTags).length) res.tags = { ...res.tags, ...ev.modifyTags };
  }

  const corr = opts.correlationId ?? guid();
  res.properties.provisioningState = existing ? 'Updating' : 'Creating';
  mutate((st) => {
    const idx = st.resources.findIndex((r) => r.id.toLowerCase() === id.toLowerCase());
    if (idx >= 0) st.resources[idx] = res;
    else st.resources.push(res);
  });
  const opName = `${existing ? 'Actualizar' : 'Crear'} ${provider.label.toLowerCase()}`;
  logActivity({ operationNameValue: `${provider.type}/write`, operationName: opName, status: 'Started', resourceId: id, subscriptionId: sub, caller: principal.name, correlationId: corr });

  const delay = opts.delayMs ?? provisionDelay(provider.provisionMs * (existing ? 0.35 : 1));
  const finish = () => {
    const cur = findResource(id);
    if (!cur || cur !== res || cur.properties.provisioningState === 'Deleting') return;
    cur.properties.provisioningState = 'Succeeded';
    try {
      provider.afterProvision?.(cur, ctx);
    } catch (e) {
      console.error(e);
    }
    logActivity({ operationNameValue: `${provider.type}/write`, operationName: opName, status: 'Succeeded', resourceId: id, subscriptionId: sub, caller: principal.name, correlationId: corr });
    changed();
  };
  if (opts.noWait) {
    setTimeout(finish, delay);
    return res;
  }
  await sleep(delay);
  finish();
  return res;
}

/** Crea un recurso dependiente de forma inmediata (sin RBAC/directivas), p. ej. el disco del SO de una VM. */
export function createImmediate(input: ArmInput, rgName: string, subscriptionId: string, principal?: PrincipalRef): Resource {
  const s = getState();
  const rg = findRg(subscriptionId, rgName, s);
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${rgName}' could not be found.`, 404);
  const provider = getProvider(input.type);
  if (!provider) throw new ArmError('NoRegisteredProviderFound', `Tipo no soportado: ${input.type}`);
  const id = resourceId(subscriptionId, rg.name, provider.type, input.name);
  const existing = findResource(id, s);
  const ctx: BuildCtx = { state: s, principal: principal ?? portalPrincipal(), subscriptionId, resourceGroup: rg, id, existing };
  const res = provider.build({ ...input, type: provider.type, location: input.location ?? rg.location }, ctx);
  res.properties.provisioningState = 'Succeeded';
  const idx = s.resources.findIndex((r) => r.id.toLowerCase() === id.toLowerCase());
  if (idx >= 0) s.resources[idx] = res;
  else s.resources.push(res);
  provider.afterProvision?.(res, ctx);
  changed();
  return res;
}

/** Actualización síncrona de propiedades (operaciones rápidas como etiquetas o configuración). */
export function patchResource(id: string, fn: (r: Resource) => void, opts: OpOpts & { action?: string; opName?: string } = {}): Resource {
  const s = getState();
  const r = findResource(id, s);
  if (!r) throw notFound(id);
  const principal = opts.principal === undefined ? portalPrincipal() : opts.principal;
  if (!opts.skipAuth) authorize(principal, opts.action ?? `${r.type}/write`, r.id);
  if (!opts.action || opts.action.endsWith('/write')) checkLocks(r.id, 'write', s);
  fn(r);
  const provider = getProvider(r.type);
  if (provider && !provider.hidden) {
    const rg = findRg(r.subscriptionId, r.resourceGroup, s);
    const ev = evaluatePolicies({ kind: 'resource', id: r.id, name: r.name, type: r.type, location: r.location, tags: r.tags, sku: r.sku, properties: r.properties, rgTags: rg?.tags }, s);
    if (ev.deny) throwPolicyDenied(r.name, ev.deny, { kind: 'resource', id: r.id, name: r.name, type: r.type, location: r.location, tags: r.tags }, principal!, r.subscriptionId);
  }
  logActivity({
    operationNameValue: opts.action ?? `${r.type}/write`,
    operationName: opts.opName ?? `Actualizar ${getProvider(r.type)?.label.toLowerCase() ?? 'recurso'}`,
    status: 'Succeeded',
    resourceId: r.id,
    subscriptionId: r.subscriptionId,
    caller: principal?.name,
  });
  changed();
  return r;
}

export function notFound(id: string): ArmError {
  const p = parseResourceId(id);
  return new ArmError(
    'ResourceNotFound',
    `The Resource '${p.type ?? ''}/${p.name ?? id}' under resource group '${p.resourceGroup ?? ''}' was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix`,
    404,
  );
}

export async function deleteResource(id: string, opts: OpOpts = {}): Promise<void> {
  const s = getState();
  const res = findResource(id, s);
  if (!res) throw notFound(id);
  const principal = opts.principal === undefined ? portalPrincipal() : opts.principal;
  if (!opts.skipAuth) authorize(principal, `${res.type}/delete`, res.id);
  checkLocks(res.id, 'delete', s, true);
  const provider = getProvider(res.type);
  provider?.beforeDelete?.(res, s);
  const corr = opts.correlationId ?? guid();
  res.properties.provisioningState = 'Deleting';
  const opName = `Eliminar ${provider?.label.toLowerCase() ?? 'recurso'}`;
  logActivity({ operationNameValue: `${res.type}/delete`, operationName: opName, status: 'Started', resourceId: res.id, subscriptionId: res.subscriptionId, caller: principal?.name, correlationId: corr });
  changed();
  const finish = () => {
    const st = getState();
    removeResourceNow(res, st);
    logActivity({ operationNameValue: `${res.type}/delete`, operationName: opName, status: 'Succeeded', resourceId: res.id, subscriptionId: res.subscriptionId, caller: principal?.name, correlationId: corr });
    changed();
  };
  const delay = opts.delayMs ?? provisionDelay((provider?.provisionMs ?? 1000) * 0.5);
  if (opts.noWait) {
    setTimeout(finish, delay);
    return;
  }
  await sleep(delay);
  finish();
}

/** Elimina un recurso y sus hijos inmediatamente (sin comprobaciones). */
export function removeResourceNow(res: Resource, s: CloudState = getState()) {
  const provider = getProvider(res.type);
  provider?.onDelete?.(res, s);
  const doomed = s.resources.filter((r) => isWithinScope(r.id, res.id));
  doomed.forEach((r) => markCostDeleted(r, s));
  s.resources = s.resources.filter((r) => !doomed.includes(r));
  cleanupScope(res.id, s);
  changed();
}

// ---------------------------------------------------------------- Serialización

export function tagsOut(t: Tags | undefined): Tags | null {
  return t && Object.keys(t).length ? { ...t } : null;
}

export function rgToJson(rg: ResourceGroup) {
  return {
    id: rg.id,
    location: rg.location,
    managedBy: rg.managedBy ?? null,
    name: rg.name,
    properties: { provisioningState: rg.provisioningState },
    tags: tagsOut(rg.tags),
    type: 'Microsoft.Resources/resourceGroups',
  };
}

function cleanProps(p: Record<string, any>, r?: Resource) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (!k.startsWith('_')) out[k] = v;
  if (r) {
    try {
      Object.assign(out, getProvider(r.type)?.decorate?.(r, getState()) ?? {});
    } catch (e) {
      console.error(e);
    }
  }
  return out;
}

/** Vista ARM genérica (az resource show / exportar plantilla). */
export function resourceToArm(r: Resource) {
  const out: any = { id: r.id, name: r.name, type: r.type, location: r.location, tags: tagsOut(r.tags) };
  if (r.kind) out.kind = r.kind;
  if (r.sku) out.sku = r.sku;
  if (r.identity) out.identity = r.identity;
  if (r.zones?.length) out.zones = r.zones;
  if (r.managedBy) out.managedBy = r.managedBy;
  out.properties = cleanProps(r.properties, r);
  out.resourceGroup = r.resourceGroup;
  return out;
}

/** Vista "aplanada" que devuelven la mayoría de comandos específicos de az. */
export function resourceToFlat(r: Resource, extra: Record<string, any> = {}) {
  const out: any = {
    ...cleanProps(r.properties, r),
    id: r.id,
    name: r.name,
    type: r.type,
    location: r.location,
    resourceGroup: r.resourceGroup,
    tags: r.tags ?? {},
  };
  if (r.kind !== undefined) out.kind = r.kind;
  if (r.sku) out.sku = r.sku;
  out.identity = r.identity ?? null;
  if (r.zones) out.zones = r.zones;
  return { ...out, ...extra };
}

export function resourceListItem(r: Resource) {
  return {
    changedTime: r.createdAt,
    createdTime: r.createdAt,
    extendedLocation: null,
    id: r.id,
    identity: r.identity ?? null,
    kind: r.kind ?? null,
    location: r.location,
    managedBy: r.managedBy ?? null,
    name: r.name,
    plan: null,
    properties: null,
    provisioningState: r.properties.provisioningState,
    resourceGroup: r.resourceGroup,
    sku: r.sku ?? null,
    tags: tagsOut(r.tags),
    type: r.type,
  };
}

export function monthlyCost(r: Resource, s: CloudState = getState()): number {
  try {
    return getProvider(r.type)?.monthlyCost?.(r, s) ?? 0;
  } catch {
    return 0;
  }
}

export function touchRecent(id: string) {
  const s = getState();
  s.recent = [id, ...s.recent.filter((x) => x !== id)].slice(0, 12);
  changed();
}

export function subscriptionScope(s: CloudState = getState()) {
  return `/subscriptions/${s.currentSubscriptionId}`;
}
