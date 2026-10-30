// az ad / role / identity.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { allRoleDefinitions, deleteResource, putResource } from '../../../engine/arm';
import { ciEq, guid } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import {
  addAppSecret, addGroupMember, createAppRegistration, createCustomRole, createGroup, createRoleAssignment, createSpForRbac, createUser, deleteApp, deleteGroup,
  deleteRoleAssignments, deleteUser, ensureSpForApp, findApp, findGroup, findRoleDefinition, findSp, findUser, isDirectoryAdmin, listRoleAssignments,
  removeGroupMember, resolvePrincipal, roleAssignmentJson,
} from '../../../engine/services/identity';
import type { EntraGroup, EntraUser, ServicePrincipal } from '../../../engine/types';

group('ad', 'Administra entidades de Microsoft Entra ID (antes Azure AD).');
group('ad user', 'Administra usuarios.');
group('ad group', 'Administra grupos.');
group('ad group member', 'Administra miembros de grupos.');
group('ad sp', 'Administra entidades de servicio.');
group('ad sp credential', 'Administra las credenciales de una entidad de servicio.');
group('ad app', 'Administra registros de aplicaciones.');
group('ad app federated-credential', 'Credenciales federadas (OIDC / identidad de carga de trabajo).');
group('ad signed-in-user', 'Información del usuario que ha iniciado sesión.');
group('role', 'Administra el control de acceso basado en rol (RBAC) de Azure.');
group('role assignment', 'Administra asignaciones de roles.');
group('role definition', 'Administra definiciones de roles.');
group('identity', 'Administra identidades administradas asignadas por el usuario.');

const userJson = (u: EntraUser) => ({ '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity', businessPhones: [], displayName: u.displayName, givenName: null, id: u.id, jobTitle: u.jobTitle ?? null, mail: u.mail ?? null, mobilePhone: null, officeLocation: null, preferredLanguage: null, surname: null, userPrincipalName: u.userPrincipalName });
const groupJson = (g: EntraGroup) => ({ createdDateTime: g.createdAt, description: g.description ?? null, displayName: g.displayName, id: g.id, mail: null, mailEnabled: false, mailNickname: g.mailNickname, securityEnabled: g.securityEnabled, groupTypes: [], visibility: null });
const spJson = (sp: ServicePrincipal) => ({ accountEnabled: true, alternativeNames: sp.alternativeNames ?? [], appDisplayName: sp.servicePrincipalType === 'Application' ? sp.displayName : null, appId: sp.appId, appOwnerOrganizationId: getState().tenant.id, displayName: sp.displayName, id: sp.id, servicePrincipalNames: [sp.appId], servicePrincipalType: sp.servicePrincipalType, signInAudience: 'AzureADMyOrg' });

function requireAdmin(ctx: AzCtx) {
  if (!isDirectoryAdmin(ctx.principal)) {
    throw new ArmError('Authorization_RequestDenied', 'Insufficient privileges to complete the operation.', 403, 'Las operaciones de Microsoft Entra requieren un rol de directorio (p. ej. Administrador de usuarios). Tu sesión actual no lo tiene.');
  }
}

register({
  path: 'ad user create',
  summary: 'Crea un usuario de Microsoft Entra ID.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Nombre para mostrar.', required: true }, { name: 'upn', opts: ['--user-principal-name'], help: 'UPN, p. ej. ana@<tu-dominio>.onmicrosoft.com', required: true }, { name: 'password', opts: ['--password'], help: 'Contraseña (8+ caracteres, 3 categorías).', required: true }, { name: 'force_change', opts: ['--force-change-password-next-sign-in'], help: 'Obliga a cambiar la contraseña.', type: 'bool' }, { name: 'mail_nickname', opts: ['--mail-nickname'], help: 'Alias de correo.' }, { name: 'job_title', opts: ['--job-title'], help: 'Puesto.', hidden: true }, { name: 'department', opts: ['--department'], help: 'Departamento.', hidden: true }],
  examples: [{ title: 'Crear un usuario.', cmd: 'az ad user create --display-name "Ana García" --user-principal-name ana@$(az ad signed-in-user show --query userPrincipalName -o tsv | cut -d@ -f2) --password "Lab-P@ssw0rd-2026"' }],
  table: (u: any) => ({ DisplayName: u.displayName, UserPrincipalName: u.userPrincipalName, Id: u.id }),
  run(a, ctx) {
    return userJson(createUser({ displayName: a.display_name, userPrincipalName: a.upn, password: a.password, jobTitle: a.job_title, department: a.department }, ctx.principal));
  },
});

register({
  path: 'ad user list',
  summary: 'Lista los usuarios.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Filtra por nombre para mostrar (prefijo).' }, { name: 'upn', opts: ['--upn'], help: 'Filtra por UPN.' }, { name: 'filter', opts: ['--filter'], help: 'Filtro OData.' }],
  table: (r: any[]) => r.map((u) => ({ DisplayName: u.displayName, UserPrincipalName: u.userPrincipalName, Id: u.id })),
  run(a) {
    return getState()
      .users.filter((u) => (!a.display_name || u.displayName.toLowerCase().startsWith(String(a.display_name).toLowerCase())) && (!a.upn || ciEq(u.userPrincipalName, a.upn)))
      .map(userJson);
  },
});

register({
  path: 'ad user show',
  summary: 'Muestra un usuario.',
  args: [{ name: 'id', opts: ['--id'], help: 'Object ID o UPN.', required: true }],
  run(a) {
    const u = findUser(a.id);
    if (!u) throw new ArmError('Request_ResourceNotFound', `Resource '${a.id}' does not exist or one of its queried reference-property objects are not present.`, 404);
    return userJson(u);
  },
});

register({
  path: 'ad user update',
  summary: 'Actualiza un usuario.',
  args: [{ name: 'id', opts: ['--id'], help: 'Object ID o UPN.', required: true }, { name: 'display_name', opts: ['--display-name'], help: 'Nombre para mostrar.' }, { name: 'password', opts: ['--password'], help: 'Nueva contraseña.' }, { name: 'account_enabled', opts: ['--account-enabled'], help: 'Cuenta habilitada.', type: 'bool' }],
  run(a, ctx) {
    requireAdmin(ctx);
    const u = findUser(a.id);
    if (!u) throw new ArmError('Request_ResourceNotFound', `Resource '${a.id}' does not exist.`, 404);
    if (a.display_name) u.displayName = a.display_name;
    if (a.password) u.password = a.password;
    if (a.account_enabled !== undefined) u.accountEnabled = a.account_enabled;
    changed();
    return undefined;
  },
});

register({
  path: 'ad user delete',
  summary: 'Elimina un usuario.',
  args: [{ name: 'id', opts: ['--id'], help: 'Object ID o UPN.', required: true }],
  run(a, ctx) {
    deleteUser(a.id, ctx.principal);
    return undefined;
  },
});

register({
  path: 'ad user get-member-groups',
  summary: 'Grupos a los que pertenece un usuario.',
  args: [{ name: 'id', opts: ['--id'], help: 'Object ID o UPN.', required: true }],
  run(a) {
    const u = findUser(a.id);
    if (!u) throw new ArmError('Request_ResourceNotFound', `Resource '${a.id}' does not exist.`, 404);
    return getState().groups.filter((g) => g.members.includes(u.id)).map((g) => ({ displayName: g.displayName, id: g.id }));
  },
});

register({
  path: 'ad signed-in-user show',
  summary: 'Muestra el usuario que ha iniciado sesión.',
  args: [],
  run(_a, ctx) {
    if (ctx.principal.type !== 'User') throw new ArmError('CliError', '/me request is only valid with delegated authentication flow.', 1, 'Has iniciado sesión con una entidad de servicio: usa "az ad sp show --id <appId>".');
    return userJson(getState().users.find((u) => u.id === ctx.principal.objectId)!);
  },
});

// ---------------------------------------------------------------- grupos

register({
  path: 'ad group create',
  summary: 'Crea un grupo de seguridad.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Nombre para mostrar.', required: true }, { name: 'mail_nickname', opts: ['--mail-nickname'], help: 'Alias (sin espacios).', required: true }, { name: 'description', opts: ['--description'], help: 'Descripción.' }],
  table: (g: any) => ({ DisplayName: g.displayName, MailNickname: g.mailNickname, Id: g.id }),
  run(a, ctx) {
    return groupJson(createGroup({ displayName: a.display_name, mailNickname: a.mail_nickname, description: a.description }, ctx.principal));
  },
});

register({
  path: 'ad group list',
  summary: 'Lista los grupos.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Filtra por nombre.' }, { name: 'filter', opts: ['--filter'], help: 'Filtro OData.' }],
  table: (r: any[]) => r.map((g) => ({ DisplayName: g.displayName, MailNickname: g.mailNickname, Id: g.id })),
  run(a) {
    return getState().groups.filter((g) => !a.display_name || g.displayName.toLowerCase().startsWith(String(a.display_name).toLowerCase())).map(groupJson);
  },
});

register({
  path: 'ad group show',
  summary: 'Muestra un grupo.',
  args: [{ name: 'group', opts: ['--group', '-g'], help: 'Nombre u Object ID.', required: true }],
  run(a) {
    const g = findGroup(a.group);
    if (!g) throw new ArmError('Request_ResourceNotFound', `Group '${a.group}' not found.`, 404);
    return groupJson(g);
  },
});

register({
  path: 'ad group delete',
  summary: 'Elimina un grupo.',
  args: [{ name: 'group', opts: ['--group', '-g'], help: 'Nombre u Object ID.', required: true }],
  run(a, ctx) {
    deleteGroup(a.group, ctx.principal);
    return undefined;
  },
});

register({
  path: 'ad group member add',
  summary: 'Añade un miembro a un grupo.',
  args: [{ name: 'group', opts: ['--group', '-g'], help: 'Nombre u Object ID del grupo.', required: true }, { name: 'member_id', opts: ['--member-id'], help: 'Object ID del miembro (usuario, grupo o entidad de servicio).', required: true }],
  examples: [{ title: 'Añadir un usuario a un grupo.', cmd: 'az ad group member add -g devs --member-id $(az ad user show --id ana@contoso.onmicrosoft.com --query id -o tsv)' }],
  run(a, ctx) {
    addGroupMember(a.group, a.member_id, ctx.principal);
    return undefined;
  },
});

register({
  path: 'ad group member remove',
  summary: 'Quita un miembro de un grupo.',
  args: [{ name: 'group', opts: ['--group', '-g'], help: 'Grupo.', required: true }, { name: 'member_id', opts: ['--member-id'], help: 'Object ID del miembro.', required: true }],
  run(a, ctx) {
    removeGroupMember(a.group, a.member_id, ctx.principal);
    return undefined;
  },
});

register({
  path: 'ad group member list',
  summary: 'Lista los miembros de un grupo.',
  args: [{ name: 'group', opts: ['--group', '-g'], help: 'Grupo.', required: true }],
  table: (r: any[]) => r.map((m) => ({ DisplayName: m.displayName, Type: m['@odata.type'], Id: m.id })),
  run(a) {
    const g = findGroup(a.group);
    if (!g) throw new ArmError('Request_ResourceNotFound', `Group '${a.group}' not found.`, 404);
    const s = getState();
    return g.members.map((id) => {
      const u = s.users.find((x) => x.id === id);
      if (u) return { '@odata.type': '#microsoft.graph.user', ...userJson(u) };
      const sp = s.servicePrincipals.find((x) => x.id === id);
      if (sp) return { '@odata.type': '#microsoft.graph.servicePrincipal', ...spJson(sp) };
      const gg = s.groups.find((x) => x.id === id);
      return { '@odata.type': '#microsoft.graph.group', id, displayName: gg?.displayName ?? id };
    });
  },
});

register({
  path: 'ad group member check',
  summary: 'Comprueba si un objeto es miembro de un grupo.',
  args: [{ name: 'group', opts: ['--group', '-g'], help: 'Grupo.', required: true }, { name: 'member_id', opts: ['--member-id'], help: 'Object ID.', required: true }],
  run(a) {
    const g = findGroup(a.group);
    return { value: !!g?.members.includes(a.member_id) };
  },
});

// ---------------------------------------------------------------- entidades de servicio y apps

register({
  path: 'ad sp create-for-rbac',
  summary: 'Crea una entidad de servicio (con secreto) y, opcionalmente, le asigna un rol. Muy usado en CI/CD.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre para mostrar.' }, { name: 'role', opts: ['--role'], help: 'Rol a asignar (requiere --scopes).' }, { name: 'scopes', opts: ['--scopes'], help: 'Ámbitos del rol.', type: 'list' }, { name: 'years', opts: ['--years'], help: 'Años de validez del secreto.', type: 'int' }, { name: 'json_auth', opts: ['--json-auth', '--sdk-auth'], help: 'Salida en el formato JSON de las acciones de GitHub (azure/login).', type: 'bool' }],
  examples: [{ title: 'SP con rol Contributor en un grupo de recursos.', cmd: 'az ad sp create-for-rbac --name sp-pipeline --role Contributor --scopes /subscriptions/<sub>/resourceGroups/rg-lab' }],
  run(a, ctx) {
    const name = a.name ?? `azure-cli-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    const r = createSpForRbac(name, a.role, a.scopes ?? [], ctx.principal);
    if (a.role) ctx.io.err(`Creating '${a.role}' role assignment under scope '${(a.scopes ?? []).join(', ')}'\n`);
    ctx.warn('The output includes credentials that you must protect. Be sure that you do not include these credentials in your code or check the credentials into your source control. For more information, see https://aka.ms/azadsp-cli');
    if (a.json_auth) return { clientId: r.appId, clientSecret: r.password, subscriptionId: ctx.subscriptionId, tenantId: r.tenant, activeDirectoryEndpointUrl: 'https://login.microsoftonline.com', resourceManagerEndpointUrl: 'https://management.azure.com/' };
    return { appId: r.appId, displayName: r.displayName, password: r.password, tenant: r.tenant };
  },
});

register({
  path: 'ad sp list',
  summary: 'Lista entidades de servicio.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Filtra por nombre.' }, { name: 'all', opts: ['--all'], help: 'Lista todas (incluidas las identidades administradas).', type: 'bool' }, { name: 'show_mine', opts: ['--show-mine'], help: 'Sólo las mías.', type: 'bool' }],
  table: (r: any[]) => r.map((s) => ({ DisplayName: s.displayName, Id: s.id, AppId: s.appId, CreatedDateTime: s.createdDateTime, Type: s.servicePrincipalType })),
  run(a, ctx) {
    if (!a.display_name && !a.all && !a.show_mine) ctx.warn('The result is not complete. You can still use \'--all\' to get all of them with long latency expected, or provide a filter through command arguments');
    return getState().servicePrincipals.filter((s) => (!a.display_name || s.displayName.toLowerCase().startsWith(String(a.display_name).toLowerCase())) && (a.all || a.display_name || s.servicePrincipalType === 'Application')).map((s) => ({ ...spJson(s), createdDateTime: s.createdAt }));
  },
});

register({
  path: 'ad sp show',
  summary: 'Muestra una entidad de servicio.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId, Object ID o nombre.', required: true }],
  run(a) {
    const sp = findSp(a.id);
    if (!sp) throw new ArmError('Request_ResourceNotFound', `Service principal '${a.id}' doesn't exist`, 404);
    return spJson(sp);
  },
});

register({
  path: 'ad sp create',
  summary: 'Crea la entidad de servicio de un registro de aplicación existente.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId del registro de aplicación.', required: true }],
  run(a, ctx) {
    requireAdmin(ctx);
    const app = findApp(a.id);
    if (!app) throw new ArmError('Request_ResourceNotFound', `Application '${a.id}' not found.`, 404);
    const sp = ensureSpForApp(app);
    changed();
    return spJson(sp);
  },
});

register({
  path: 'ad sp delete',
  summary: 'Elimina una entidad de servicio (y su registro de aplicación).',
  args: [{ name: 'id', opts: ['--id'], help: 'appId u Object ID.', required: true }],
  run(a, ctx) {
    const sp = findSp(a.id);
    if (!sp) throw new ArmError('Request_ResourceNotFound', `Service principal '${a.id}' doesn't exist`, 404);
    deleteApp(sp.appId, ctx.principal);
    return undefined;
  },
});

register({
  path: 'ad sp credential reset',
  summary: 'Genera un secreto nuevo para una entidad de servicio.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId.', required: true }, { name: 'append', opts: ['--append'], help: 'Mantiene los secretos existentes.', type: 'bool' }, { name: 'years', opts: ['--years'], help: 'Años.', type: 'int' }, { name: 'display_name', opts: ['--display-name'], help: 'Nombre del secreto.' }],
  run(a, ctx) {
    requireAdmin(ctx);
    const sp = findSp(a.id);
    const app = sp ? findApp(sp.appId) : undefined;
    if (!sp || !app) throw new ArmError('Request_ResourceNotFound', `Service principal '${a.id}' doesn't exist`, 404);
    if (!a.append) {
      sp.secrets = [];
      app.passwordCredentials = [];
    }
    const pwd = addAppSecret(app, a.display_name ?? 'rbac', a.years ?? 1);
    ctx.warn('The output includes credentials that you must protect.');
    return { appId: sp.appId, password: pwd, tenant: getState().tenant.id };
  },
});

register({
  path: 'ad app create',
  summary: 'Crea un registro de aplicación.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Nombre para mostrar.', required: true }, { name: 'sign_in_audience', opts: ['--sign-in-audience'], help: 'Audiencia.' }],
  run(a, ctx) {
    const app = createAppRegistration(a.display_name, ctx.principal);
    return { appId: app.appId, displayName: app.displayName, id: app.id, passwordCredentials: [], signInAudience: 'AzureADMyOrg', createdDateTime: app.createdAt };
  },
});

register({
  path: 'ad app list',
  summary: 'Lista los registros de aplicación.',
  args: [{ name: 'display_name', opts: ['--display-name'], help: 'Filtra por nombre.' }, { name: 'all', opts: ['--all'], help: 'Todas.', type: 'bool' }],
  table: (r: any[]) => r.map((x) => ({ DisplayName: x.displayName, Id: x.id, AppId: x.appId, CreatedDateTime: x.createdDateTime })),
  run(a) {
    return getState().apps.filter((x) => !a.display_name || x.displayName.toLowerCase().startsWith(String(a.display_name).toLowerCase())).map((x) => ({ appId: x.appId, displayName: x.displayName, id: x.id, createdDateTime: x.createdAt, passwordCredentials: x.passwordCredentials }));
  },
});

register({
  path: 'ad app show',
  summary: 'Muestra un registro de aplicación.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId u Object ID.', required: true }],
  run(a) {
    const x = findApp(a.id);
    if (!x) throw new ArmError('Request_ResourceNotFound', `Application '${a.id}' doesn't exist`, 404);
    return { appId: x.appId, displayName: x.displayName, id: x.id, createdDateTime: x.createdAt, passwordCredentials: x.passwordCredentials, federatedCredentials: x.federatedCredentials };
  },
});

register({
  path: 'ad app delete',
  summary: 'Elimina un registro de aplicación.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId u Object ID.', required: true }],
  run(a, ctx) {
    deleteApp(a.id, ctx.principal);
    return undefined;
  },
});

register({
  path: 'ad app credential reset',
  summary: 'Genera un secreto de cliente para un registro de aplicación.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId.', required: true }, { name: 'append', opts: ['--append'], help: 'Mantiene los existentes.', type: 'bool' }, { name: 'display_name', opts: ['--display-name'], help: 'Nombre.' }],
  run(a, ctx) {
    requireAdmin(ctx);
    const app = findApp(a.id);
    if (!app) throw new ArmError('Request_ResourceNotFound', `Application '${a.id}' doesn't exist`, 404);
    return { appId: app.appId, password: addAppSecret(app, a.display_name ?? 'rbac'), tenant: getState().tenant.id };
  },
});

register({
  path: 'ad app federated-credential create',
  summary: 'Crea una credencial federada (OIDC) para usar el registro de aplicación sin secretos.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId.', required: true }, { name: 'parameters', opts: ['--parameters'], help: 'JSON con name, issuer, subject y audiences (o @fichero).', type: 'json', required: true }],
  run(a, ctx) {
    requireAdmin(ctx);
    const app = findApp(a.id);
    if (!app) throw new ArmError('Request_ResourceNotFound', `Application '${a.id}' doesn't exist`, 404);
    const p = a.parameters;
    if (!p.name || !p.issuer || !p.subject) throw cliError('El JSON debe incluir name, issuer y subject.');
    app.federatedCredentials = [...app.federatedCredentials.filter((f) => f.name !== p.name), { name: p.name, issuer: p.issuer, subject: p.subject }];
    changed();
    return { audiences: p.audiences ?? ['api://AzureADTokenExchange'], description: p.description ?? null, id: guid(), issuer: p.issuer, name: p.name, subject: p.subject };
  },
});

register({
  path: 'ad app federated-credential list',
  summary: 'Lista las credenciales federadas.',
  args: [{ name: 'id', opts: ['--id'], help: 'appId.', required: true }],
  run(a) {
    const app = findApp(a.id);
    if (!app) throw new ArmError('Request_ResourceNotFound', `Application '${a.id}' doesn't exist`, 404);
    return app.federatedCredentials.map((f) => ({ ...f, audiences: ['api://AzureADTokenExchange'] }));
  },
});

// ---------------------------------------------------------------- role

const raTable = (r: any[]) => (Array.isArray(r) ? r : [r]).map((x: any) => ({ Principal: x.principalName, Role: x.roleDefinitionName, Scope: x.scope }));

function raScope(a: Args, ctx: AzCtx): string | undefined {
  if (a.scope) return a.scope;
  if (a.resource_group) return requireRg(ctx, a.resource_group).id;
  return undefined;
}

register({
  path: 'role assignment create',
  summary: 'Asigna un rol a un usuario, grupo o entidad de servicio en un ámbito.',
  args: [{ name: 'assignee', opts: ['--assignee'], help: 'UPN, appId, nombre o Object ID.' }, { name: 'assignee_object_id', opts: ['--assignee-object-id'], help: 'Object ID del principal (evita búsquedas en Graph).' }, { name: 'assignee_principal_type', opts: ['--assignee-principal-type'], help: 'Tipo de principal.', choices: ['User', 'Group', 'ServicePrincipal', 'ForeignGroup'] }, { name: 'role', opts: ['--role'], help: 'Nombre o ID del rol, p. ej. "Reader".', required: true }, { name: 'scope', opts: ['--scope'], help: 'Ámbito: /subscriptions/<id>[/resourceGroups/<rg>[/providers/...]].' }, A.rg(false), { name: 'description', opts: ['--description'], help: 'Descripción.' }],
  examples: [
    { title: 'Lector en un grupo de recursos.', cmd: 'az role assignment create --assignee ana@contoso.onmicrosoft.com --role Reader -g rg-lab' },
    { title: 'AcrPull para la identidad de AKS.', cmd: 'az role assignment create --assignee-object-id <objectId> --assignee-principal-type ServicePrincipal --role AcrPull --scope <acrId>' },
  ],
  table: raTable,
  run(a, ctx) {
    const who = a.assignee_object_id ?? a.assignee;
    if (!who) throw cliError('usage error: --assignee STRING | --assignee-object-id GUID', undefined, true);
    let scope = raScope(a, ctx);
    if (!scope) {
      scope = `/subscriptions/${ctx.subscriptionId}`;
    }
    return roleAssignmentJson(createRoleAssignment({ assignee: who, role: a.role, scope }, ctx.principal));
  },
});

register({
  path: 'role assignment list',
  summary: 'Lista asignaciones de roles.',
  args: [{ name: 'assignee', opts: ['--assignee'], help: 'Filtra por principal.' }, { name: 'role', opts: ['--role'], help: 'Filtra por rol.' }, { name: 'scope', opts: ['--scope'], help: 'Filtra por ámbito.' }, A.rg(false), { name: 'all', opts: ['--all'], help: 'Muestra todas las asignaciones de la suscripción y sus hijos.', type: 'bool' }, { name: 'include_inherited', opts: ['--include-inherited'], help: 'Incluye las heredadas de ámbitos superiores.', type: 'bool' }, { name: 'include_groups', opts: ['--include-groups'], help: 'Incluye las asignadas a grupos del principal.', type: 'bool' }],
  table: raTable,
  run(a, ctx) {
    const scope = raScope(a, ctx);
    let list = listRoleAssignments({ assignee: a.assignee, role: a.role, scope, includeInherited: a.include_inherited, all: a.all });
    if (a.assignee && a.include_groups) {
      const p = resolvePrincipal(a.assignee);
      if (p) {
        const groups = getState().groups.filter((g) => g.members.includes(p.id)).map((g) => g.id);
        list = [...list, ...getState().roleAssignments.filter((r) => groups.includes(r.principalId))];
      }
    }
    if (a.all) list = getState().roleAssignments.filter((r) => r.scope.toLowerCase().startsWith(`/subscriptions/${ctx.subscriptionId}`.toLowerCase()) && list.includes(r));
    return list.map(roleAssignmentJson);
  },
});

register({
  path: 'role assignment delete',
  summary: 'Elimina asignaciones de roles.',
  args: [{ name: 'assignee', opts: ['--assignee'], help: 'Principal.' }, { name: 'role', opts: ['--role'], help: 'Rol.' }, { name: 'scope', opts: ['--scope'], help: 'Ámbito.' }, A.rg(false), A.ids(), A.yes()],
  run(a, ctx) {
    if (!a.assignee && !a.role && !a.scope && !a.resource_group && !a.ids?.length) {
      throw cliError('Please provide at least one of these arguments: --assignee, --role, --scope, --resource-group or --ids', undefined, true);
    }
    const removed = deleteRoleAssignments({ assignee: a.assignee, role: a.role, scope: raScope(a, ctx), ids: a.ids }, ctx.principal);
    if (!removed.length) ctx.warn('No matched assignments were found to delete');
    return undefined;
  },
});

register({
  path: 'role definition list',
  summary: 'Lista definiciones de roles.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Filtra por nombre del rol.' }, { name: 'custom_role_only', opts: ['--custom-role-only'], help: 'Sólo roles personalizados.', type: 'bool' }, { name: 'scope', opts: ['--scope'], help: 'Ámbito.' }],
  table: (r: any[]) => r.map((d) => ({ Name: d.roleName, Type: d.roleType, Description: d.description })),
  run(a) {
    return allRoleDefinitions()
      .filter((d) => (!a.name || ciEq(d.roleName, a.name) || ciEq(d.name, a.name)) && (!a.custom_role_only || d.roleType === 'CustomRole'))
      .map((d) => ({ assignableScopes: d.assignableScopes, description: d.description, id: d.id, name: d.name, permissions: d.permissions, roleName: d.roleName, roleType: d.roleType, type: 'Microsoft.Authorization/roleDefinitions' }));
  },
});

register({
  path: 'role definition create',
  summary: 'Crea un rol personalizado a partir de un JSON.',
  args: [{ name: 'role_definition', opts: ['--role-definition'], help: 'JSON o @fichero con Name, Description, Actions, NotActions, DataActions, AssignableScopes.', type: 'json', required: true }],
  examples: [{ title: 'Rol para operar VMs.', cmd: 'az role definition create --role-definition @operador-vm.json' }],
  run(a, ctx) {
    const d = createCustomRole(a.role_definition, ctx.principal);
    return { assignableScopes: d.assignableScopes, description: d.description, id: d.id, name: d.name, permissions: d.permissions, roleName: d.roleName, roleType: d.roleType, type: 'Microsoft.Authorization/roleDefinitions' };
  },
});

register({
  path: 'role definition delete',
  summary: 'Elimina un rol personalizado.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre del rol.', required: true }],
  run(a) {
    const d = findRoleDefinition(a.name);
    if (!d || d.roleType !== 'CustomRole') throw new ArmError('RoleDefinitionDoesNotExist', `Role '${a.name}' doesn't exist or is a built-in role.`, 404);
    const s = getState();
    if (s.roleAssignments.some((r) => r.roleDefinitionName === d.roleName)) throw new ArmError('RoleDefinitionHasAssignments', 'There are existing role assignments referencing role (code: RoleDefinitionHasAssignments).', 409);
    s.customRoles = s.customRoles.filter((r) => r !== d);
    changed();
    return undefined;
  },
});

// ---------------------------------------------------------------- identity

register({
  path: 'identity create',
  summary: 'Crea una identidad administrada asignada por el usuario.',
  args: [A.rg(), A.name('Nombre de la identidad.'), A.location(), A.tags()],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    return flat(await putResource({ type: 'Microsoft.ManagedIdentity/userAssignedIdentities', name: a.name, location: a.location, tags: a.tags, properties: {} }, rg.name, op(ctx)));
  },
});

register({
  path: 'identity list',
  summary: 'Lista las identidades administradas.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((i) => ({ Name: i.name, ResourceGroup: i.resourceGroup, Location: i.location, ClientId: i.clientId, PrincipalId: i.principalId })),
  run: (a, ctx) => listInSub(ctx, 'Microsoft.ManagedIdentity/userAssignedIdentities', a.resource_group).map((r) => flat(r)),
});

register({
  path: 'identity show',
  summary: 'Muestra una identidad administrada.',
  args: [A.rg(false), A.name('Nombre.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, 'Microsoft.ManagedIdentity/userAssignedIdentities')),
});

register({
  path: 'identity delete',
  summary: 'Elimina una identidad administrada.',
  args: [A.rg(false), A.name('Nombre.', false), A.ids()],
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, 'Microsoft.ManagedIdentity/userAssignedIdentities').id, op(ctx));
    return undefined;
  },
});
