// Microsoft Entra ID simulado: usuarios, grupos, registros de aplicaciones, entidades de servicio y RBAC.
import type { AppRegistration, CloudState, EntraGroup, EntraUser, PrincipalRef, PrincipalType, RoleAssignment, RoleDefinition, ServicePrincipal } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { allRoleDefinitions, authorize, findRg, findResource, logActivity } from '../arm';
import { isWithinScope, normScope, parseResourceId } from '../ids';
import { ciEq, fakePassword, guid, nowIso } from '../util';

export function isDirectoryAdmin(p: PrincipalRef | null | undefined, s: CloudState = getState()): boolean {
  return !!p && p.type === 'User' && p.objectId === s.me.objectId;
}

function requireDirectoryAdmin(p: PrincipalRef | null | undefined) {
  if (!isDirectoryAdmin(p)) {
    throw new ArmError(
      'Authorization_RequestDenied',
      'Insufficient privileges to complete the operation.',
      403,
      'Gestionar el directorio (usuarios, grupos, aplicaciones) requiere un rol de Microsoft Entra como "Administrador de usuarios"; los roles RBAC de Azure no sirven para esto.',
    );
  }
}

export function passwordOkEntra(pw: string): boolean {
  if (!pw || pw.length < 8 || pw.length > 256) return false;
  let n = 0;
  if (/[A-Z]/.test(pw)) n++;
  if (/[a-z]/.test(pw)) n++;
  if (/\d/.test(pw)) n++;
  if (/[^A-Za-z0-9]/.test(pw)) n++;
  return n >= 3;
}

export function findUser(idOrUpn: string, s: CloudState = getState()): EntraUser | undefined {
  return s.users.find((u) => u.id === idOrUpn || ciEq(u.userPrincipalName, idOrUpn) || ciEq(u.displayName, idOrUpn));
}

export function findGroup(idOrName: string, s: CloudState = getState()): EntraGroup | undefined {
  return s.groups.find((g) => g.id === idOrName || ciEq(g.displayName, idOrName) || ciEq(g.mailNickname, idOrName));
}

export function findSp(idOrAppIdOrName: string, s: CloudState = getState()): ServicePrincipal | undefined {
  return s.servicePrincipals.find((p) => p.id === idOrAppIdOrName || p.appId === idOrAppIdOrName || ciEq(p.displayName, idOrAppIdOrName));
}

export function findApp(idOrAppIdOrName: string, s: CloudState = getState()): AppRegistration | undefined {
  return s.apps.find((a) => a.id === idOrAppIdOrName || a.appId === idOrAppIdOrName || ciEq(a.displayName, idOrAppIdOrName));
}

export function createUser(input: { displayName: string; userPrincipalName: string; password: string; jobTitle?: string; department?: string }, principal: PrincipalRef | null): EntraUser {
  requireDirectoryAdmin(principal);
  const s = getState();
  const upn = input.userPrincipalName;
  const domain = upn.split('@')[1];
  if (!upn.includes('@') || !ciEq(domain, s.tenant.domain)) {
    throw new ArmError('Request_BadRequest', `Property userPrincipalName is invalid. The domain portion of the userPrincipalName property is invalid. You must use one of the verified domain names in your organization: ${s.tenant.domain}.`, 400);
  }
  if (findUser(upn, s)) throw new ArmError('Request_BadRequest', 'Another object with the same value for property userPrincipalName already exists.', 400);
  if (!passwordOkEntra(input.password)) {
    throw new ArmError('Request_BadRequest', 'The specified password does not comply with password complexity requirements. Please provide a different password.', 400);
  }
  const u: EntraUser = {
    id: guid(),
    displayName: input.displayName,
    userPrincipalName: upn,
    mail: null,
    password: input.password,
    accountEnabled: true,
    jobTitle: input.jobTitle ?? null,
    department: input.department ?? null,
    userType: 'Member',
    createdAt: nowIso(),
  };
  s.users.push(u);
  changed();
  return u;
}

export function deleteUser(idOrUpn: string, principal: PrincipalRef | null) {
  requireDirectoryAdmin(principal);
  const s = getState();
  const u = findUser(idOrUpn, s);
  if (!u) throw new ArmError('Request_ResourceNotFound', `Resource '${idOrUpn}' does not exist or one of its queried reference-property objects are not present.`, 404);
  if (u.id === s.me.objectId) throw new ArmError('Request_BadRequest', 'No puedes eliminar tu propia cuenta de administrador.', 400);
  s.users = s.users.filter((x) => x !== u);
  s.roleAssignments = s.roleAssignments.filter((a) => a.principalId !== u.id);
  for (const g of s.groups) g.members = g.members.filter((m) => m !== u.id);
  changed();
}

export function createGroup(input: { displayName: string; mailNickname: string; description?: string }, principal: PrincipalRef | null): EntraGroup {
  requireDirectoryAdmin(principal);
  const s = getState();
  if (!input.displayName) throw new ArmError('Request_BadRequest', 'Property displayName is required.');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.mailNickname)) throw new ArmError('Request_BadRequest', 'Property mailNickname contains invalid characters.');
  const g: EntraGroup = { id: guid(), displayName: input.displayName, mailNickname: input.mailNickname, description: input.description ?? null, members: [], securityEnabled: true, createdAt: nowIso() };
  s.groups.push(g);
  changed();
  return g;
}

export function deleteGroup(idOrName: string, principal: PrincipalRef | null) {
  requireDirectoryAdmin(principal);
  const s = getState();
  const g = findGroup(idOrName, s);
  if (!g) throw new ArmError('Request_ResourceNotFound', `Group '${idOrName}' not found.`, 404);
  s.groups = s.groups.filter((x) => x !== g);
  s.roleAssignments = s.roleAssignments.filter((a) => a.principalId !== g.id);
  changed();
}

export function addGroupMember(groupIdOrName: string, memberId: string, principal: PrincipalRef | null) {
  requireDirectoryAdmin(principal);
  const s = getState();
  const g = findGroup(groupIdOrName, s);
  if (!g) throw new ArmError('Request_ResourceNotFound', `Group '${groupIdOrName}' not found.`, 404);
  const p = resolvePrincipal(memberId, s);
  if (!p) throw new ArmError('Request_ResourceNotFound', `Resource '${memberId}' does not exist or one of its queried reference-property objects are not present.`, 404);
  if (g.members.includes(p.id)) throw new ArmError('Request_BadRequest', 'One or more added object references already exist for the following modified properties: \'members\'.', 400);
  g.members.push(p.id);
  changed();
}

export function removeGroupMember(groupIdOrName: string, memberId: string, principal: PrincipalRef | null) {
  requireDirectoryAdmin(principal);
  const s = getState();
  const g = findGroup(groupIdOrName, s);
  if (!g) throw new ArmError('Request_ResourceNotFound', `Group '${groupIdOrName}' not found.`, 404);
  const p = resolvePrincipal(memberId, s);
  g.members = g.members.filter((m) => m !== (p?.id ?? memberId));
  changed();
}

export interface ResolvedPrincipal {
  id: string;
  type: PrincipalType;
  displayName: string;
  name: string;
}

export function resolvePrincipal(any: string, s: CloudState = getState()): ResolvedPrincipal | undefined {
  const u = findUser(any, s);
  if (u) return { id: u.id, type: 'User', displayName: u.displayName, name: u.userPrincipalName };
  const g = findGroup(any, s);
  if (g) return { id: g.id, type: 'Group', displayName: g.displayName, name: g.displayName };
  const sp = findSp(any, s);
  if (sp) return { id: sp.id, type: 'ServicePrincipal', displayName: sp.displayName, name: sp.appId };
  return undefined;
}

export function createAppRegistration(displayName: string, principal: PrincipalRef | null): AppRegistration {
  requireDirectoryAdmin(principal);
  const s = getState();
  const app: AppRegistration = { id: guid(), appId: guid(), displayName, createdAt: nowIso(), passwordCredentials: [], federatedCredentials: [] };
  s.apps.push(app);
  changed();
  return app;
}

export function ensureSpForApp(app: AppRegistration, s: CloudState = getState()): ServicePrincipal {
  let sp = s.servicePrincipals.find((p) => p.appId === app.appId);
  if (!sp) {
    sp = { id: guid(), appId: app.appId, displayName: app.displayName, servicePrincipalType: 'Application', secrets: [], createdAt: nowIso() };
    s.servicePrincipals.push(sp);
  }
  return sp;
}

export function addAppSecret(app: AppRegistration, displayName = 'rbac', years = 1): string {
  const s = getState();
  const sp = ensureSpForApp(app, s);
  const secret = fakePassword(app.appId + Date.now() + Math.random());
  sp.secrets.push(secret);
  app.passwordCredentials.push({ keyId: guid(), displayName, hint: secret.slice(0, 3), endDateTime: new Date(Date.now() + years * 365 * 86400000).toISOString() });
  changed();
  return secret;
}

export function createSpForRbac(name: string, role: string | undefined, scopes: string[], principal: PrincipalRef | null) {
  requireDirectoryAdmin(principal);
  const s = getState();
  let app = findApp(name, s);
  if (!app) app = createAppRegistration(name, principal);
  const sp = ensureSpForApp(app, s);
  const password = addAppSecret(app);
  if (role) {
    if (!scopes.length) throw new ArmError('InvalidArgument', 'usage error: --scopes is required when --role is specified');
    for (const scope of scopes) {
      try {
        createRoleAssignment({ assignee: sp.id, role, scope }, principal);
      } catch (e) {
        if (!(e instanceof ArmError && e.code === 'RoleAssignmentExists')) throw e;
      }
    }
  }
  changed();
  return { appId: app.appId, displayName: app.displayName, password, tenant: s.tenant.id, sp };
}

export function deleteApp(idOrAppId: string, principal: PrincipalRef | null) {
  requireDirectoryAdmin(principal);
  const s = getState();
  const app = findApp(idOrAppId, s);
  if (!app) throw new ArmError('Request_ResourceNotFound', `Application '${idOrAppId}' not found.`, 404);
  s.apps = s.apps.filter((a) => a !== app);
  const sp = s.servicePrincipals.find((p) => p.appId === app.appId);
  if (sp) {
    s.servicePrincipals = s.servicePrincipals.filter((p) => p !== sp);
    s.roleAssignments = s.roleAssignments.filter((a) => a.principalId !== sp.id);
  }
  changed();
}

// ---------------------------------------------------------------- RBAC

export function findRoleDefinition(nameOrId: string, s: CloudState = getState()): RoleDefinition | undefined {
  const v = nameOrId.toLowerCase();
  return allRoleDefinitions(s).find((r) => r.roleName.toLowerCase() === v || r.name.toLowerCase() === v || r.id.toLowerCase() === v || r.id.toLowerCase().endsWith('/' + v));
}

export function scopeExists(scope: string, s: CloudState = getState()): boolean {
  const n = normScope(scope);
  if (n === '/') return true;
  const p = parseResourceId(scope);
  if (!p.subscriptionId || !s.subscriptions.some((x) => ciEq(x.id, p.subscriptionId))) return false;
  if (!p.resourceGroup) return /^\/subscriptions\/[^/]+$/.test(n);
  if (!p.type) return !!findRg(p.subscriptionId, p.resourceGroup, s);
  return !!findResource(scope, s);
}

export function createRoleAssignment(input: { assignee: string; role: string; scope: string; principalType?: PrincipalType }, principal: PrincipalRef | null): RoleAssignment {
  const s = getState();
  const scope = input.scope.replace(/\/+$/, '');
  if (!scopeExists(scope, s)) {
    const p = parseResourceId(scope);
    if (p.resourceGroup && !p.type) throw new ArmError('ResourceGroupNotFound', `Resource group '${p.resourceGroup}' could not be found.`, 404);
    throw new ArmError('InvalidScope', `The scope '${scope}' is not valid or the resource doesn't exist.`, 400);
  }
  authorize(principal, 'Microsoft.Authorization/roleAssignments/write', scope);
  const role = findRoleDefinition(input.role, s);
  if (!role) throw new ArmError('RoleNotFound', `Role '${input.role}' doesn't exist.`, 404, 'Lista los roles con: az role definition list --query "[].roleName" -o tsv');
  const target = resolvePrincipal(input.assignee, s);
  if (!target) {
    throw new ArmError('PrincipalNotFound', `Cannot find user or service principal in graph database for '${input.assignee}'. If the assignee is an appId, make sure the corresponding service principal is created with 'az ad sp create --id ${input.assignee}'.`, 404);
  }
  const canonicalScope = canonicalizeScope(scope, s);
  if (s.roleAssignments.some((a) => a.principalId === target.id && ciEq(a.scope, canonicalScope) && a.roleDefinitionName === role.roleName)) {
    throw new ArmError('RoleAssignmentExists', 'The role assignment already exists.', 409);
  }
  const sub = parseResourceId(canonicalScope).subscriptionId ?? s.currentSubscriptionId;
  const name = guid();
  const ra: RoleAssignment = {
    id: `${canonicalScope === '/' ? '' : canonicalScope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    name,
    principalId: target.id,
    principalType: target.type,
    principalName: target.name,
    roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${role.name}`,
    roleDefinitionName: role.roleName,
    scope: canonicalScope,
    createdOn: nowIso(),
    createdBy: principal?.name ?? 'Sistema',
  };
  s.roleAssignments.push(ra);
  logActivity({ operationNameValue: 'Microsoft.Authorization/roleAssignments/write', operationName: `Crear asignación de rol (${role.roleName} → ${target.displayName})`, status: 'Succeeded', resourceId: ra.id, subscriptionId: sub, caller: principal?.name, category: 'Administrative' });
  changed();
  return ra;
}

export function canonicalizeScope(scope: string, s: CloudState = getState()): string {
  const p = parseResourceId(scope);
  if (p.type) return findResource(scope, s)?.id ?? scope;
  if (p.resourceGroup) {
    const rg = findRg(p.subscriptionId!, p.resourceGroup, s);
    return rg?.id ?? scope;
  }
  return scope.replace(/\/+$/, '') || '/';
}

export function deleteRoleAssignments(filter: { assignee?: string; role?: string; scope?: string; ids?: string[] }, principal: PrincipalRef | null): RoleAssignment[] {
  const s = getState();
  let list = s.roleAssignments;
  if (filter.ids?.length) list = list.filter((a) => filter.ids!.some((id) => ciEq(id, a.id)));
  else {
    if (filter.assignee) {
      const p = resolvePrincipal(filter.assignee, s);
      list = list.filter((a) => a.principalId === (p?.id ?? filter.assignee));
    }
    if (filter.role) {
      const r = findRoleDefinition(filter.role, s);
      list = list.filter((a) => a.roleDefinitionName === (r?.roleName ?? filter.role));
    }
    if (filter.scope) list = list.filter((a) => ciEq(a.scope, filter.scope!.replace(/\/+$/, '')));
  }
  for (const a of list) authorize(principal, 'Microsoft.Authorization/roleAssignments/delete', a.scope);
  if (list.some((a) => a.principalId === s.me.objectId && a.roleDefinitionName === 'Owner' && /^\/subscriptions\/[^/]+$/i.test(a.scope))) {
    throw new ArmError('CannotDeleteOwnOwner', 'El simulador no permite eliminar tu propia asignación de Owner en la suscripción (te quedarías sin acceso).', 400);
  }
  s.roleAssignments = s.roleAssignments.filter((a) => !list.includes(a));
  for (const a of list) {
    logActivity({ operationNameValue: 'Microsoft.Authorization/roleAssignments/delete', operationName: `Eliminar asignación de rol (${a.roleDefinitionName})`, status: 'Succeeded', resourceId: a.id, subscriptionId: parseResourceId(a.scope).subscriptionId ?? s.currentSubscriptionId, caller: principal?.name });
  }
  changed();
  return list;
}

export function listRoleAssignments(filter: { assignee?: string; scope?: string; includeInherited?: boolean; role?: string; all?: boolean } = {}, s: CloudState = getState()): RoleAssignment[] {
  let list = s.roleAssignments;
  if (filter.assignee) {
    const p = resolvePrincipal(filter.assignee, s);
    const ids = p ? [p.id] : [filter.assignee];
    list = list.filter((a) => ids.includes(a.principalId));
  }
  if (filter.role) {
    const r = findRoleDefinition(filter.role, s);
    list = list.filter((a) => a.roleDefinitionName === (r?.roleName ?? filter.role));
  }
  if (filter.scope) {
    const sc = filter.scope;
    list = list.filter((a) => ciEq(a.scope, sc.replace(/\/+$/, '')) || (filter.includeInherited && isWithinScope(sc, a.scope)));
  } else if (!filter.all && !filter.assignee) {
    const subScope = `/subscriptions/${s.currentSubscriptionId}`;
    list = list.filter((a) => ciEq(a.scope, subScope));
  }
  return list;
}

export function roleAssignmentJson(a: RoleAssignment) {
  return {
    condition: null,
    conditionVersion: null,
    createdBy: a.createdBy,
    createdOn: a.createdOn,
    delegatedManagedIdentityResourceId: null,
    description: null,
    id: a.id,
    name: a.name,
    principalId: a.principalId,
    principalName: a.principalName,
    principalType: a.principalType,
    resourceGroup: parseResourceId(a.scope).resourceGroup,
    roleDefinitionId: a.roleDefinitionId,
    roleDefinitionName: a.roleDefinitionName,
    scope: a.scope,
    type: 'Microsoft.Authorization/roleAssignments',
    updatedBy: a.createdBy,
    updatedOn: a.createdOn,
  };
}

export function createCustomRole(def: any, principal: PrincipalRef | null): RoleDefinition {
  const s = getState();
  const name = def.Name ?? def.name ?? def.roleName;
  if (!name) throw new ArmError('InvalidRoleDefinition', 'The role definition must have a Name.');
  const scopes: string[] = def.AssignableScopes ?? def.assignableScopes ?? [];
  if (!scopes.length) throw new ArmError('InvalidRoleDefinition', 'The role definition must have at least one assignable scope.');
  for (const sc of scopes) authorize(principal, 'Microsoft.Authorization/roleDefinitions/write', sc);
  if (findRoleDefinition(name, s)) throw new ArmError('RoleDefinitionWithSameNameExists', `A custom role with the same name '${name}' already exists in this directory.`, 409);
  const id = guid();
  const rd: RoleDefinition = {
    id: `/subscriptions/${s.currentSubscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${id}`,
    name: id,
    roleName: name,
    description: def.Description ?? def.description ?? '',
    roleType: 'CustomRole',
    permissions: [
      {
        actions: def.Actions ?? def.actions ?? [],
        notActions: def.NotActions ?? def.notActions ?? [],
        dataActions: def.DataActions ?? def.dataActions ?? [],
        notDataActions: def.NotDataActions ?? def.notDataActions ?? [],
      },
    ],
    assignableScopes: scopes,
  };
  s.customRoles.push(rd);
  changed();
  return rd;
}

export function principalRefForUser(u: EntraUser): PrincipalRef {
  return { type: 'User', objectId: u.id, name: u.userPrincipalName, displayName: u.displayName };
}

export function principalRefForSp(sp: ServicePrincipal): PrincipalRef {
  return { type: 'ServicePrincipal', objectId: sp.id, name: sp.appId, displayName: sp.displayName };
}

export function principalDisplay(id: string, s: CloudState = getState()): { name: string; type: string } {
  const u = s.users.find((x) => x.id === id);
  if (u) return { name: u.displayName, type: 'Usuario' };
  const g = s.groups.find((x) => x.id === id);
  if (g) return { name: g.displayName, type: 'Grupo' };
  const sp = s.servicePrincipals.find((x) => x.id === id);
  if (sp) return { name: sp.displayName, type: sp.servicePrincipalType === 'ManagedIdentity' ? 'Identidad administrada' : 'Aplicación' };
  return { name: id, type: 'Desconocido' };
}
