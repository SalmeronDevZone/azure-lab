// az sql / keyvault.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { deleteResource, findResource, putResource } from '../../../engine/arm';
import { resourceId } from '../../../engine/ids';
import { SQL_OBJECTIVES, GLOBALLY_TAKEN } from '../../../engine/catalog';
import { ciEq } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { databasesOf, firewallRulesOf } from '../../../engine/providers/sql';
import {
  deleteSecret, getSecret, getVault, listDeletedSecrets, listSecretVersions, listSecrets, purgeSecret, purgeVault, recoverSecret, recoverVault, setAccessPolicy, setSecret,
} from '../../../engine/services/keyvault';
import { resolvePrincipal } from '../../../engine/services/identity';

const T_SQL = 'Microsoft.Sql/servers';
const T_DB = 'Microsoft.Sql/servers/databases';
const T_FW = 'Microsoft.Sql/servers/firewallRules';
const T_KV = 'Microsoft.KeyVault/vaults';

group('sql', 'Administra Azure SQL Database.');
group('sql server', 'Administra servidores lógicos de SQL.');
group('sql server firewall-rule', 'Administra reglas de firewall del servidor.');
group('sql db', 'Administra bases de datos.');
group('keyvault', 'Administra almacenes de claves (Key Vault).');
group('keyvault secret', 'Administra secretos.');

function serverArg(ctx: AzCtx, a: Args) {
  const rg = requireRg(ctx, a.resource_group);
  const s = findResource(resourceId(ctx.subscriptionId, rg.name, T_SQL, a.server));
  if (!s) throw new ArmError('ResourceNotFound', `The Resource 'Microsoft.Sql/servers/${a.server}' under resource group '${rg.name}' was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix`, 404);
  return s;
}

const serverOpt = { name: 'server', opts: ['--server', '-s'], help: 'Nombre del servidor SQL.', required: true };

register({
  path: 'sql server create',
  summary: 'Crea un servidor lógico de Azure SQL.',
  args: [A.rg(), A.name('Nombre del servidor (será <nombre>.database.windows.net).'), A.location(), { name: 'admin_user', opts: ['--admin-user', '-u'], help: 'Usuario administrador (no puede ser admin, sa, root...).' }, { name: 'admin_password', opts: ['--admin-password', '-p'], help: 'Contraseña del administrador (8-128 caracteres, 3 categorías).' }, { name: 'enable_public_network', opts: ['--enable-public-network', '-e'], help: 'Acceso de red pública.', type: 'bool' }, { name: 'minimal_tls_version', opts: ['--minimal-tls-version'], help: 'TLS mínimo.', choices: ['1.0', '1.1', '1.2', '1.3'] }, { name: 'enable_ad_only_auth', opts: ['--enable-ad-only-auth'], help: 'Sólo autenticación de Entra ID.', type: 'bool' }, A.tags()],
  examples: [{ title: 'Crear un servidor.', cmd: 'az sql server create -g rg-lab -n sql-lab-ana -l westeurope -u sqladmin -p "Str0ng-P@ss-2026"' }],
  table: (s: any) => ({ Name: s.name, ResourceGroup: s.resourceGroup, Location: s.location, FullyQualifiedDomainName: s.fullyQualifiedDomainName, State: s.state }),
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    if (a.enable_ad_only_auth) throw cliError('La autenticación sólo de Entra ID no está soportada en el simulador; usa usuario y contraseña de SQL.');
    if (!a.admin_user || !a.admin_password) throw cliError('usage error: --admin-user and --admin-password are required (o --enable-ad-only-auth).', undefined, true);
    const r = await putResource({ type: T_SQL, name: a.name, location: a.location, tags: a.tags, properties: { administratorLogin: a.admin_user, administratorLoginPassword: a.admin_password, publicNetworkAccess: a.enable_public_network === false ? 'Disabled' : 'Enabled', minimalTlsVersion: a.minimal_tls_version } }, rg.name, op(ctx));
    return flat(r);
  },
});

register({
  path: 'sql server list',
  summary: 'Lista los servidores SQL.',
  args: [A.rg(false)],
  table: (r: any[]) => r.map((s) => ({ Name: s.name, ResourceGroup: s.resourceGroup, Location: s.location, FullyQualifiedDomainName: s.fullyQualifiedDomainName })),
  run: (a, ctx) => listInSub(ctx, T_SQL, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'sql server show',
  summary: 'Muestra un servidor SQL.',
  args: [A.rg(false), A.name('Nombre del servidor.', false), A.ids()],
  run: (a, ctx) => flat(getRes(ctx, a, T_SQL)),
});

register({
  path: 'sql server update',
  summary: 'Actualiza un servidor (contraseña, acceso público, TLS).',
  args: [A.rg(false), A.name('Nombre del servidor.', false), A.ids(), { name: 'admin_password', opts: ['--admin-password', '-p'], help: 'Nueva contraseña.' }, { name: 'enable_public_network', opts: ['--enable-public-network', '-e'], help: 'Acceso de red pública.', type: 'bool' }, { name: 'minimal_tls_version', opts: ['--minimal-tls-version'], help: 'TLS mínimo.' }],
  async run(a, ctx) {
    const s = getRes(ctx, a, T_SQL);
    const r = await putResource({ type: T_SQL, name: s.name, location: s.location, tags: s.tags, properties: { ...s.properties, administratorLoginPassword: a.admin_password, publicNetworkAccess: a.enable_public_network === undefined ? s.properties.publicNetworkAccess : a.enable_public_network ? 'Enabled' : 'Disabled', minimalTlsVersion: a.minimal_tls_version ?? s.properties.minimalTlsVersion } }, s.resourceGroup, op(ctx));
    return flat(r);
  },
});

register({
  path: 'sql server delete',
  summary: 'Elimina un servidor SQL y todas sus bases de datos.',
  args: [A.rg(false), A.name('Nombre del servidor.', false), A.ids(), A.yes()],
  confirm: 'Are you sure you want to perform this operation?',
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_SQL).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'sql server firewall-rule create',
  summary: 'Crea una regla de firewall del servidor (rango de IPs permitido).',
  args: [A.rg(), serverOpt, A.name('Nombre de la regla.'), { name: 'start_ip_address', opts: ['--start-ip-address'], help: 'IP inicial. 0.0.0.0 + 0.0.0.0 permite los servicios de Azure.', required: true }, { name: 'end_ip_address', opts: ['--end-ip-address'], help: 'IP final.', required: true }],
  examples: [{ title: 'Permitir tu IP actual.', cmd: 'MIIP=$(curl -s ifconfig.me); az sql server firewall-rule create -g rg-lab -s sql-lab -n mi-ip --start-ip-address $MIIP --end-ip-address $MIIP' }],
  table: (r: any) => ({ Name: r.name, StartIpAddress: r.startIpAddress, EndIpAddress: r.endIpAddress, ResourceGroup: r.resourceGroup }),
  async run(a, ctx) {
    const s = serverArg(ctx, a);
    const r = await putResource({ type: T_FW, name: `${s.name}/${a.name}`, location: s.location, properties: { startIpAddress: a.start_ip_address, endIpAddress: a.end_ip_address } }, s.resourceGroup, op(ctx));
    return { ...flat(r), name: a.name };
  },
});

register({
  path: 'sql server firewall-rule list',
  summary: 'Lista las reglas de firewall del servidor.',
  args: [A.rg(), serverOpt],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, StartIpAddress: x.startIpAddress, EndIpAddress: x.endIpAddress, ResourceGroup: x.resourceGroup })),
  run(a, ctx) {
    const s = serverArg(ctx, a);
    return firewallRulesOf(s, getState().resources).map((r) => ({ ...flat(r), name: r.name.split('/')[1] }));
  },
});

register({
  path: 'sql server firewall-rule delete',
  summary: 'Elimina una regla de firewall.',
  args: [A.rg(), serverOpt, A.name('Nombre de la regla.')],
  async run(a, ctx) {
    const s = serverArg(ctx, a);
    await deleteResource(resourceId(ctx.subscriptionId, s.resourceGroup, T_FW, `${s.name}/${a.name}`), op(ctx));
    return undefined;
  },
});

register({
  path: 'sql db create',
  summary: 'Crea una base de datos.',
  args: [A.rg(), serverOpt, A.name('Nombre de la base de datos.'), { name: 'service_objective', opts: ['--service-objective', '--service-level-objective'], help: `Objetivo de servicio: ${Object.keys(SQL_OBJECTIVES).join(', ')}.` }, { name: 'edition', opts: ['--edition', '--tier', '-e'], help: 'Edición: Basic, Standard, Premium, GeneralPurpose, BusinessCritical.' }, { name: 'family', opts: ['--family', '-f'], help: 'Generación de hardware (Gen5).' }, { name: 'capacity', opts: ['--capacity', '-c'], help: 'vCores o DTU.', type: 'int' }, { name: 'compute_model', opts: ['--compute-model'], help: 'Modelo de proceso.', choices: ['Provisioned', 'Serverless'] }, { name: 'max_size', opts: ['--max-size'], help: 'Tamaño máximo, p. ej. 2GB.' }, { name: 'zone_redundant', opts: ['--zone-redundant', '-z'], help: 'Redundancia de zona.', type: 'bool' }, A.tags()],
  examples: [{ title: 'Base de datos Basic (barata para pruebas).', cmd: 'az sql db create -g rg-lab -s sql-lab-ana -n appdb --service-objective Basic' }],
  table: (d: any) => ({ Name: d.name, ResourceGroup: d.resourceGroup, Location: d.location, Sku: d.sku?.name, Status: d.status, MaxSizeBytes: d.maxSizeBytes }),
  longRunning: true,
  async run(a, ctx) {
    const s = serverArg(ctx, a);
    let objective = a.service_objective;
    if (!objective) {
      const ed = String(a.edition ?? 'GeneralPurpose').toLowerCase();
      if (ed === 'basic') objective = 'Basic';
      else if (ed === 'standard') objective = 'S0';
      else if (ed === 'premium') objective = 'P1';
      else if (ed === 'businesscritical') objective = `BC_Gen5_${a.capacity ?? 2}`;
      else objective = a.compute_model === 'Provisioned' ? `GP_Gen5_${a.capacity ?? 2}` : `GP_S_Gen5_${a.capacity ?? 2}`;
    }
    const maxBytes = a.max_size ? Number(String(a.max_size).replace(/GB$/i, '')) * 1024 ** 3 : undefined;
    const r = await putResource({ type: T_DB, name: `${s.name}/${a.name}`, location: s.location, tags: a.tags, sku: { name: objective }, properties: { maxSizeBytes: maxBytes, zoneRedundant: a.zone_redundant } }, s.resourceGroup, op(ctx));
    return { ...flat(r), name: a.name };
  },
});

register({
  path: 'sql db list',
  summary: 'Lista las bases de datos de un servidor.',
  args: [A.rg(), serverOpt],
  table: (r: any[]) => r.map((d) => ({ Name: d.name, ResourceGroup: d.resourceGroup, Location: d.location, Sku: d.sku?.name, Status: d.status })),
  run(a, ctx) {
    const s = serverArg(ctx, a);
    return [{ name: 'master', resourceGroup: s.resourceGroup, location: s.location, sku: { name: 'System', tier: 'System' }, status: 'Online', kind: 'v12.0,system', id: `${s.id}/databases/master` }, ...databasesOf(s, getState().resources).map((d) => ({ ...flat(d), name: d.name.split('/')[1] }))];
  },
});

register({
  path: 'sql db show',
  summary: 'Muestra una base de datos.',
  args: [A.rg(), serverOpt, A.name('Nombre de la base de datos.')],
  run(a, ctx) {
    const s = serverArg(ctx, a);
    const d = findResource(resourceId(ctx.subscriptionId, s.resourceGroup, T_DB, `${s.name}/${a.name}`));
    if (!d) throw new ArmError('ResourceNotFound', `The requested resource of type 'Microsoft.Sql/servers/databases' with name '${a.name}' was not found.`, 404);
    return { ...flat(d), name: a.name };
  },
});

register({
  path: 'sql db update',
  summary: 'Cambia el nivel de servicio de una base de datos.',
  args: [A.rg(), serverOpt, A.name('Nombre de la base de datos.'), { name: 'service_objective', opts: ['--service-objective'], help: 'Nuevo objetivo de servicio.' }, A.tags()],
  async run(a, ctx) {
    const s = serverArg(ctx, a);
    const d = findResource(resourceId(ctx.subscriptionId, s.resourceGroup, T_DB, `${s.name}/${a.name}`));
    if (!d) throw new ArmError('ResourceNotFound', `Database '${a.name}' not found.`, 404);
    const r = await putResource({ type: T_DB, name: d.name, location: d.location, tags: a.tags ?? d.tags, sku: { name: a.service_objective ?? d.sku!.name }, properties: { ...d.properties } }, d.resourceGroup, op(ctx));
    return { ...flat(r), name: a.name };
  },
});

register({
  path: 'sql db delete',
  summary: 'Elimina una base de datos.',
  args: [A.rg(), serverOpt, A.name('Nombre de la base de datos.'), A.yes()],
  confirm: 'Are you sure you want to perform this operation?',
  async run(a, ctx) {
    const s = serverArg(ctx, a);
    await deleteResource(resourceId(ctx.subscriptionId, s.resourceGroup, T_DB, `${s.name}/${a.name}`), op(ctx));
    return undefined;
  },
});

register({
  path: 'sql db show-connection-string',
  summary: 'Genera la cadena de conexión para un cliente.',
  noLogin: true,
  args: [{ name: 'client', opts: ['--client', '-c'], help: 'Cliente.', required: true, choices: ['ado.net', 'jdbc', 'odbc', 'php', 'php_pdo', 'sqlcmd'] }, { name: 'name', opts: ['--name', '-n'], help: 'Base de datos.' }, { name: 'server', opts: ['--server', '-s'], help: 'Servidor.' }, { name: 'auth_type', opts: ['--auth-type', '-a'], help: 'Tipo de autenticación.', choices: ['SqlPassword', 'ADPassword', 'ADIntegrated'] }],
  run(a) {
    const srv = a.server ?? '<servername>';
    const db = a.name ?? '<databasename>';
    const m: Record<string, string> = {
      'ado.net': `Server=tcp:${srv}.database.windows.net,1433;Database=${db};User ID=<username>;Password=<password>;Encrypt=true;Connection Timeout=30;`,
      jdbc: `jdbc:sqlserver://${srv}.database.windows.net:1433;database=${db};user=<username>@${srv};password=<password>;encrypt=true;trustServerCertificate=false;hostNameInCertificate=*.database.windows.net;loginTimeout=30;`,
      odbc: `Driver={ODBC Driver 18 for SQL Server};Server=tcp:${srv}.database.windows.net,1433;Database=${db};Uid=<username>;Pwd=<password>;Encrypt=yes;TrustServerCertificate=no;Connection Timeout=30;`,
      php: `$connectionOptions = array("UID"=>"<username>@${srv}", "PWD"=>"<password>", "Database"=>${db}, "LoginTimeout" => 30, "Encrypt" => 1, "TrustServerCertificate" => 0); $serverName = "tcp:${srv}.database.windows.net,1433"; $conn = sqlsrv_connect($serverName, $connectionOptions);`,
      php_pdo: `$conn = new PDO("sqlsrv:server = tcp:${srv}.database.windows.net,1433; Database = ${db}; LoginTimeout = 30; Encrypt = 1; TrustServerCertificate = 0;", "<username>", "<password>");`,
      sqlcmd: `sqlcmd -S tcp:${srv}.database.windows.net,1433 -d ${db} -U <username> -P <password> -N -l 30`,
    };
    return m[a.client];
  },
});

// ---------------------------------------------------------------- keyvault

const kvTable = (r: any) => (Array.isArray(r) ? r : [r]).map((v: any) => ({ Location: v.location, Name: v.name, ResourceGroup: v.resourceGroup }));

register({
  path: 'keyvault create',
  summary: 'Crea un almacén de claves.',
  args: [A.rg(), A.name('Nombre del almacén (3-24 caracteres, único en Azure).'), A.location(), A.sku('Plan.', ['standard', 'premium'], 'standard'), { name: 'enable_rbac_authorization', opts: ['--enable-rbac-authorization'], help: 'Usa Azure RBAC para el plano de datos (por defecto true). Con false se usan directivas de acceso.', type: 'bool' }, { name: 'enable_purge_protection', opts: ['--enable-purge-protection'], help: 'Protección de purga (irreversible).', type: 'bool' }, { name: 'retention_days', opts: ['--retention-days'], help: 'Días de retención de eliminación temporal (7-90).', type: 'int' }, { name: 'public_network_access', opts: ['--public-network-access'], help: 'Acceso de red pública.', choices: ['Enabled', 'Disabled'] }, { name: 'enabled_for_template_deployment', opts: ['--enabled-for-template-deployment'], help: 'Permite a ARM leer secretos.', type: 'bool' }, A.tags()],
  examples: [{ title: 'Almacén con RBAC.', cmd: 'az keyvault create -g rg-lab -n kv-lab-ana -l westeurope' }],
  table: kvTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const rbac = a.enable_rbac_authorization ?? true;
    const r = await putResource({ type: T_KV, name: a.name, location: a.location, tags: a.tags, properties: { sku: { family: 'A', name: a.sku }, enableRbacAuthorization: rbac, enablePurgeProtection: a.enable_purge_protection ? true : null, softDeleteRetentionInDays: a.retention_days, publicNetworkAccess: a.public_network_access, enabledForTemplateDeployment: a.enabled_for_template_deployment, accessPolicies: rbac ? [] : [{ tenantId: getState().tenant.id, objectId: ctx.principal.objectId, permissions: { secrets: ['get', 'list', 'set', 'delete', 'backup', 'restore', 'recover', 'purge'], keys: ['get', 'list', 'create', 'delete'], certificates: ['get', 'list', 'create', 'delete'], storage: [] } }] } }, rg.name, op(ctx));
    if (rbac) ctx.warn('El almacén usa el modelo de permisos RBAC: para crear o leer secretos necesitas un rol de datos como "Key Vault Secrets Officer" o "Key Vault Administrator" (ser Owner no es suficiente).');
    return flat(r);
  },
});

register({
  path: 'keyvault list',
  summary: 'Lista los almacenes de claves.',
  args: [A.rg(false), { name: 'resource_type', opts: ['--resource-type'], help: 'Tipo (vault).' }],
  table: kvTable,
  run: (a, ctx) => listInSub(ctx, T_KV, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'keyvault show',
  summary: 'Muestra un almacén de claves.',
  args: [A.rg(false), A.name('Nombre del almacén.', false), A.ids()],
  table: kvTable,
  run(a, ctx) {
    if (!a.resource_group && a.name && !a.ids?.length) {
      const v = getState().resources.find((r) => ciEq(r.type, T_KV) && ciEq(r.name, a.name) && r.subscriptionId === ctx.subscriptionId);
      if (!v) throw new ArmError('ResourceNotFound', `The Vault '${a.name}' not found within subscription.`, 404);
      return flat(v);
    }
    return flat(getRes(ctx, a, T_KV));
  },
});

register({
  path: 'keyvault update',
  summary: 'Actualiza un almacén de claves.',
  args: [A.rg(false), A.name('Nombre del almacén.', false), A.ids(), { name: 'enable_rbac_authorization', opts: ['--enable-rbac-authorization'], help: 'Modelo RBAC.', type: 'bool' }, { name: 'enable_purge_protection', opts: ['--enable-purge-protection'], help: 'Protección de purga.', type: 'bool' }, { name: 'public_network_access', opts: ['--public-network-access'], help: 'Acceso público.', choices: ['Enabled', 'Disabled'] }, { name: 'default_action', opts: ['--default-action'], help: 'Acción predeterminada de red.', choices: ['Allow', 'Deny'] }],
  async run(a, ctx) {
    const v = a.resource_group || a.ids?.length ? getRes(ctx, a, T_KV) : getVault(a.name);
    const p = v.properties;
    const r = await putResource({ type: T_KV, name: v.name, location: v.location, tags: v.tags, properties: { ...p, enableRbacAuthorization: a.enable_rbac_authorization ?? p.enableRbacAuthorization, enablePurgeProtection: a.enable_purge_protection ?? p.enablePurgeProtection, publicNetworkAccess: a.public_network_access ?? p.publicNetworkAccess, networkAcls: a.default_action ? { ...p.networkAcls, defaultAction: a.default_action } : p.networkAcls } }, v.resourceGroup, op(ctx));
    return flat(r);
  },
});

register({
  path: 'keyvault delete',
  summary: 'Elimina un almacén (queda en eliminación temporal y se puede recuperar).',
  args: [A.rg(false), A.name('Nombre del almacén.', false), A.ids()],
  async run(a, ctx) {
    const v = a.resource_group || a.ids?.length ? getRes(ctx, a, T_KV) : getVault(a.name);
    await deleteResource(v.id, op(ctx));
    ctx.warn(`Key Vault "${v.name}" is in soft-deleted state and can be recovered with 'az keyvault recover -n ${v.name}' during the retention period (${v.properties.softDeleteRetentionInDays} days).`);
    return undefined;
  },
});

register({
  path: 'keyvault list-deleted',
  summary: 'Lista los almacenes en eliminación temporal.',
  args: [{ name: 'resource_type', opts: ['--resource-type'], help: 'Tipo.' }],
  table: (r: any[]) => r.map((v) => ({ Name: v.name, Location: v.properties.location, DeletionDate: v.properties.deletionDate, ScheduledPurgeDate: v.properties.scheduledPurgeDate })),
  run() {
    return getState().deletedVaults.map((v) => ({ id: v.id, name: v.name, properties: { deletionDate: v.deletionDate, location: v.location, purgeProtectionEnabled: !!v.resource.properties.enablePurgeProtection, scheduledPurgeDate: v.scheduledPurgeDate, vaultId: v.resource.id }, type: 'Microsoft.KeyVault/deletedVaults' }));
  },
});

register({
  path: 'keyvault recover',
  summary: 'Recupera un almacén eliminado temporalmente.',
  args: [A.name('Nombre del almacén.'), A.location()],
  longRunning: true,
  run(a, ctx) {
    return flat(recoverVault(a.name, ctx.principal));
  },
});

register({
  path: 'keyvault purge',
  summary: 'Purga (elimina definitivamente) un almacén eliminado temporalmente.',
  args: [A.name('Nombre del almacén.'), A.location(), A.noWait()],
  longRunning: true,
  run(a, ctx) {
    purgeVault(a.name, ctx.principal);
    return undefined;
  },
});

register({
  path: 'keyvault set-policy',
  summary: 'Concede permisos mediante una directiva de acceso (sólo almacenes sin RBAC).',
  args: [A.name('Nombre del almacén.'), A.rg(false), { name: 'object_id', opts: ['--object-id'], help: 'Object ID del principal.' }, { name: 'upn', opts: ['--upn'], help: 'UPN del usuario.' }, { name: 'spn', opts: ['--spn'], help: 'appId de la entidad de servicio.' }, { name: 'secret_permissions', opts: ['--secret-permissions'], help: 'Permisos de secretos: all, get, list, set, delete, recover, purge, backup, restore.', type: 'list' }, { name: 'key_permissions', opts: ['--key-permissions'], help: 'Permisos de claves.', type: 'list' }, { name: 'certificate_permissions', opts: ['--certificate-permissions'], help: 'Permisos de certificados.', type: 'list' }],
  run(a, ctx) {
    const who = a.object_id ?? a.upn ?? a.spn;
    if (!who) throw cliError('usage error: --object-id ID | --upn UPN | --spn NAME', undefined, true);
    const p = resolvePrincipal(who);
    if (!p) throw new ArmError('CliError', `Unable to find user with upn '${who}'`, 1);
    return flat(setAccessPolicy(a.name, p.id, (a.secret_permissions ?? []).map((x: string) => x.toLowerCase()), ctx.principal));
  },
});

register({
  path: 'keyvault delete-policy',
  summary: 'Elimina una directiva de acceso.',
  args: [A.name('Nombre del almacén.'), A.rg(false), { name: 'object_id', opts: ['--object-id'], help: 'Object ID.' }, { name: 'upn', opts: ['--upn'], help: 'UPN.' }, { name: 'spn', opts: ['--spn'], help: 'appId.' }],
  run(a, ctx) {
    const v = getVault(a.name);
    const p = resolvePrincipal(a.object_id ?? a.upn ?? a.spn ?? '');
    v.properties.accessPolicies = (v.properties.accessPolicies ?? []).filter((x: any) => x.objectId !== p?.id);
    changed();
    return flat(v);
  },
});

const vaultName = { name: 'vault_name', opts: ['--vault-name'], help: 'Nombre del almacén.', required: true };
const secretTable = (r: any) => (Array.isArray(r) ? r : [r]).map((s: any) => ({ Name: s.name, Id: s.id, ContentType: s.contentType ?? '', Enabled: s.attributes?.enabled }));

register({
  path: 'keyvault secret set',
  summary: 'Crea o actualiza un secreto (cada actualización crea una versión nueva).',
  args: [vaultName, A.name('Nombre del secreto (letras, números y guiones).'), { name: 'value', opts: ['--value'], help: 'Valor del secreto.' }, { name: 'file', opts: ['--file', '-f'], help: 'Lee el valor de un fichero.' }, { name: 'content_type', opts: ['--content-type'], help: 'Tipo de contenido.' }, { name: 'expires', opts: ['--expires'], help: 'Caducidad (UTC).' }, A.tags()],
  examples: [{ title: 'Guardar una contraseña.', cmd: 'az keyvault secret set --vault-name kv-lab-ana -n db-password --value "S3cr3t0!"' }],
  run(a, ctx) {
    let value = a.value;
    if (value === undefined && a.file) value = ctx.sess.fs.readFile(ctx.sess.resolve(a.file));
    if (value === undefined) throw cliError('usage error: --value VALUE | --file PATH', undefined, true);
    return setSecret(a.vault_name, a.name, String(value), { principal: ctx.principal, contentType: a.content_type, expires: a.expires, tags: a.tags });
  },
});

register({
  path: 'keyvault secret show',
  summary: 'Obtiene un secreto (incluido su valor).',
  args: [{ ...vaultName, required: false }, A.name('Nombre del secreto.', false), { name: 'version', opts: ['--version', '-v'], help: 'Versión.' }, { name: 'id', opts: ['--id'], help: 'Identificador completo del secreto.' }],
  examples: [{ title: 'Obtener sólo el valor.', cmd: 'az keyvault secret show --vault-name kv-lab-ana -n db-password --query value -o tsv' }],
  run(a, ctx) {
    let vault = a.vault_name;
    let name = a.name;
    let version = a.version;
    if (a.id) {
      const m = /^https:\/\/([^.]+)\.vault\.azure\.net\/secrets\/([^/]+)(?:\/([^/]+))?/.exec(a.id);
      if (!m) throw cliError('Invalid secret id.');
      [, vault, name, version] = m;
    }
    if (!vault || !name) throw cliError('usage error: --id ID | --vault-name VAULT --name NAME', undefined, true);
    return getSecret(vault, name, { principal: ctx.principal, version });
  },
});

register({
  path: 'keyvault secret list',
  summary: 'Lista los secretos (sin sus valores).',
  args: [vaultName, { name: 'include_managed', opts: ['--include-managed'], help: 'Incluye secretos administrados.', type: 'bool' }],
  table: secretTable,
  run: (a, ctx) => listSecrets(a.vault_name, ctx.principal),
});

register({
  path: 'keyvault secret list-versions',
  summary: 'Lista las versiones de un secreto.',
  args: [vaultName, A.name('Nombre del secreto.')],
  run: (a, ctx) => listSecretVersions(a.vault_name, a.name, ctx.principal),
});

register({
  path: 'keyvault secret delete',
  summary: 'Elimina un secreto (eliminación temporal).',
  args: [vaultName, A.name('Nombre del secreto.')],
  run: (a, ctx) => deleteSecret(a.vault_name, a.name, ctx.principal),
});

register({
  path: 'keyvault secret list-deleted',
  summary: 'Lista los secretos eliminados temporalmente.',
  args: [vaultName],
  run: (a, ctx) => listDeletedSecrets(a.vault_name, ctx.principal),
});

register({
  path: 'keyvault secret recover',
  summary: 'Recupera un secreto eliminado temporalmente.',
  args: [vaultName, A.name('Nombre del secreto.')],
  run: (a, ctx) => recoverSecret(a.vault_name, a.name, ctx.principal),
});

register({
  path: 'keyvault secret purge',
  summary: 'Purga definitivamente un secreto eliminado.',
  args: [vaultName, A.name('Nombre del secreto.')],
  run(a, ctx) {
    purgeSecret(a.vault_name, a.name, ctx.principal);
    return undefined;
  },
});

register({
  path: 'keyvault secret download',
  summary: 'Descarga el valor de un secreto a un fichero.',
  args: [vaultName, A.name('Nombre del secreto.'), { name: 'file', opts: ['--file', '-f'], help: 'Fichero de destino.', required: true }],
  run(a, ctx) {
    const s = getSecret(a.vault_name, a.name, { principal: ctx.principal });
    ctx.sess.fs.writeFile(ctx.sess.resolve(a.file), (s as any).value);
    return undefined;
  },
});

export function _dataUnused() {
  return GLOBALLY_TAKEN;
}
