// az login / logout / account / configure / version / extension / find / rest.
import { register, group, cliError, type AzCtx, allAzCommands } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { LOCATIONS } from '../../../engine/catalog';
import { findRg, findResource, hasPermission, resourceToArm, rgToJson, resourceListItem } from '../../../engine/arm';
import { findSp, findUser, principalRefForSp, principalRefForUser } from '../../../engine/services/identity';
import { ciEq, guid, shortHash, sleep } from '../../../engine/util';
import { parseResourceId } from '../../../engine/ids';
import type { PrincipalRef } from '../../../engine/types';
import { identityPrincipalIds } from '../../../engine/providers/identity';

group('account', 'Administra las suscripciones de Azure.');
group('config', 'Administra la configuración de Azure CLI.');
group('extension', 'Administra las extensiones de Azure CLI.');

export function accessibleSubscriptions(p: PrincipalRef | null) {
  const s = getState();
  if (!p) return [];
  return s.subscriptions.filter((sub) => hasPermission(p, '*/read', `/subscriptions/${sub.id}`) || s.roleAssignments.some((a) => a.scope.toLowerCase().startsWith(`/subscriptions/${sub.id}`.toLowerCase()) && (a.principalId === p.objectId || s.groups.some((g) => g.id === a.principalId && g.members.includes(p.objectId)))));
}

export function subscriptionJson(subId: string, p: PrincipalRef | null, isDefault: boolean) {
  const s = getState();
  const sub = s.subscriptions.find((x) => x.id === subId)!;
  return {
    cloudName: 'AzureCloud',
    environmentName: 'AzureCloud',
    homeTenantId: s.tenant.id,
    id: sub.id,
    isDefault,
    managedByTenants: [],
    name: sub.displayName,
    state: sub.state,
    tenantDefaultDomain: s.tenant.domain,
    tenantDisplayName: s.tenant.displayName,
    tenantId: s.tenant.id,
    user: p ? { name: p.name, type: p.type === 'User' ? 'user' : 'servicePrincipal' } : null,
  };
}

const accountTable = (r: any) =>
  (Array.isArray(r) ? r : [r]).map((x: any) => ({ Name: x.name, CloudName: x.cloudName, SubscriptionId: x.id, TenantId: x.tenantId, State: x.state, IsDefault: x.isDefault }));

async function finishLogin(ctx: AzCtx, p: PrincipalRef, allowNoSub: boolean) {
  const subs = accessibleSubscriptions(p);
  if (!subs.length && !allowNoSub) {
    if (p.type === 'User') {
      throw new ArmError('CliError', `No subscriptions found for ${p.name}.`, 1, 'Ese usuario todavía no tiene ningún rol asignado en una suscripción (o grupo de recursos). Asígnale un rol o usa --allow-no-subscriptions.');
    }
    throw new ArmError('CliError', `No subscriptions found for ${p.name}.`, 1, 'La entidad de servicio no tiene ningún rol asignado. Usa "az role assignment create" o --allow-no-subscriptions.');
  }
  ctx.sess.az.loggedIn = true;
  ctx.sess.az.principal = p;
  if (subs.length && !subs.some((x) => x.id === ctx.sess.az.subscriptionId)) ctx.sess.az.subscriptionId = subs[0].id;
  ctx.sess.az.persist();
  getState().events.push({ t: Date.now(), kind: 'login', caller: p.name, detail: p.type });
  changed();
  return subs.map((sub) => subscriptionJson(sub.id, p, sub.id === ctx.sess.az.subscriptionId));
}

register({
  path: 'login',
  summary: 'Inicia sesión en Azure.',
  noLogin: true,
  args: [
    { name: 'username', opts: ['--username', '-u'], help: 'Nombre de usuario (UPN) o appId de la entidad de servicio.' },
    { name: 'password', opts: ['--password', '-p'], help: 'Contraseña o secreto de cliente.' },
    { name: 'tenant', opts: ['--tenant', '-t'], help: 'Inquilino (tenant) de Microsoft Entra.' },
    { name: 'service_principal', opts: ['--service-principal'], help: 'Inicia sesión con una entidad de servicio.', type: 'bool' },
    { name: 'identity', opts: ['--identity'], help: 'Inicia sesión con la identidad administrada del recurso (VM, contenedor...).', type: 'bool' },
    { name: 'use_device_code', opts: ['--use-device-code'], help: 'Usa el flujo de código de dispositivo.', type: 'bool' },
    { name: 'allow_no_subscriptions', opts: ['--allow-no-subscriptions'], help: 'Permite iniciar sesión sin suscripciones (acceso de nivel de inquilino).', type: 'bool' },
    { name: 'federated_token', opts: ['--federated-token'], help: 'Token federado (OIDC) para la autenticación con identidad de carga de trabajo.' },
  ],
  examples: [
    { title: 'Inicio de sesión interactivo (código de dispositivo).', cmd: 'az login' },
    { title: 'Inicio de sesión con usuario y contraseña.', cmd: 'az login -u ana@contoso.onmicrosoft.com -p <contraseña>' },
    { title: 'Inicio de sesión con una entidad de servicio.', cmd: 'az login --service-principal -u <appId> -p <secreto> --tenant <tenantId>' },
  ],
  async run(a, ctx) {
    const s = getState();
    if (a.identity) {
      const vm = ctx.sess.vmId ? findResource(ctx.sess.vmId) : undefined;
      const ids = vm ? identityPrincipalIds(vm) : [];
      if (!ids.length) throw new ArmError('CliError', 'Failed to connect to MSI. Please make sure MSI is configured correctly.\nGet Token request returned: <Response [400]>', 1, 'Sólo funciona dentro de un recurso con identidad administrada (por ejemplo, una VM con "az vm identity assign").');
      const sp = s.servicePrincipals.find((x) => x.id === ids[0])!;
      const subs = await finishLogin(ctx, { type: 'ServicePrincipal', objectId: sp.id, name: sp.appId, displayName: sp.displayName }, !!a.allow_no_subscriptions);
      return subs.map((x: any) => ({ ...x, user: { assignedIdentityInfo: 'MSI', name: 'systemAssignedIdentity', type: 'servicePrincipal' } }));
    }
    if (a.service_principal) {
      if (!a.username) throw cliError('usage error: --service-principal requires --username (appId)', undefined, true);
      if (a.tenant && !ciEq(a.tenant, s.tenant.id) && !ciEq(a.tenant, s.tenant.domain)) {
        throw new ArmError('CliError', `AADSTS90002: Tenant '${a.tenant}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`, 1);
      }
      const sp = findSp(a.username);
      if (!sp || sp.servicePrincipalType !== 'Application') {
        throw new ArmError('CliError', `AADSTS700016: Application with identifier '${a.username}' was not found in the directory '${s.tenant.displayName}'. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant.`, 1);
      }
      if (!a.federated_token && !sp.secrets.includes(a.password ?? '')) {
        throw new ArmError('CliError', `AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${sp.appId}'.`, 1);
      }
      return finishLogin(ctx, principalRefForSp(sp), !!a.allow_no_subscriptions);
    }
    if (a.username) {
      const u = findUser(a.username);
      if (!u) throw new ArmError('CliError', `AADSTS50034: The user account ${a.username} does not exist in the ${s.tenant.domain} directory. To sign into this application, the account must be added to the directory.`, 1);
      if (a.password === undefined && ctx.io.prompt) a.password = await ctx.io.prompt('Password: ', { secret: true });
      if (u.password !== a.password) throw new ArmError('CliError', 'AADSTS50126: Error validating credentials due to invalid username or password.', 1);
      if (!u.accountEnabled) throw new ArmError('CliError', 'AADSTS50057: The user account is disabled.', 1);
      ctx.warn('Starting September 1, 2025, MFA will be gradually enforced for Azure public cloud. The authentication with username and password in the command line is not supported with MFA. (En el simulador funciona para practicar RBAC.)');
      return finishLogin(ctx, principalRefForUser(u), !!a.allow_no_subscriptions);
    }
    // Inicio de sesión interactivo (simulado con código de dispositivo)
    if (ctx.sess.kind === 'cloudshell') ctx.warn("Cloud Shell is automatically authenticated under the initial account signed-in with. Run 'az login' only if you need to use a different account");
    const code = shortHash(guid(), 9).toUpperCase().replace(/[01]/g, 'A');
    ctx.warn(`To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ${code} to authenticate.`);
    await sleep(1200);
    const me = s.users.find((u) => u.id === s.me.objectId)!;
    const p = principalRefForUser(me);
    const subs = accessibleSubscriptions(p);
    ctx.io.err('\nRetrieving tenants and subscriptions for the selection...\n\n[Tenant and subscription selection]\n\n');
    const rows = subs.map((x, i) => `[${i + 1}]${x.id === (ctx.sess.az.subscriptionId || subs[0].id) ? ' *' : '  '}  ${x.displayName.padEnd(26)} ${x.id}  ${s.tenant.displayName}`);
    ctx.io.err(`No     Subscription name           Subscription ID                       Tenant\n-----  --------------------------  ------------------------------------  ------------------------\n${rows.join('\n')}\n\nThe default is marked with an *; the default tenant is '${s.tenant.displayName}' and subscription is '${(subs.find((x) => x.id === ctx.sess.az.subscriptionId) ?? subs[0]).displayName}' (${(subs.find((x) => x.id === ctx.sess.az.subscriptionId) ?? subs[0]).id}).\n\n`);
    if (ctx.io.prompt && ctx.io.isTTY) {
      const ans = (await ctx.io.prompt('Select a subscription and tenant (Type a number or Enter for no changes): ')).trim();
      const n = Number(ans);
      if (ans && n >= 1 && n <= subs.length) ctx.sess.az.subscriptionId = subs[n - 1].id;
    }
    await finishLogin(ctx, p, false);
    const sub = s.subscriptions.find((x) => x.id === ctx.sess.az.subscriptionId)!;
    ctx.io.err(`\nTenant: ${s.tenant.displayName}\nSubscription: ${sub.displayName} (${sub.id})\n\n[Announcements]\nWith the new Azure CLI login experience, you can select the subscription you want to use more easily. Learn more about it and its configuration at https://go.microsoft.com/fwlink/?linkid=2271236\n\n`);
    return undefined;
  },
});

register({
  path: 'logout',
  summary: 'Cierra la sesión para quitar el acceso a las suscripciones de Azure.',
  noLogin: true,
  args: [{ name: 'username', opts: ['--username'], help: 'Cuenta de la que cerrar sesión.' }],
  run(_a, ctx) {
    if (!ctx.sess.az.loggedIn) throw new ArmError('CliError', 'There are no active accounts.', 1);
    ctx.sess.az.loggedIn = false;
    ctx.sess.az.principal = null;
    ctx.sess.az.persist();
    if (ctx.sess.kind === 'cloudshell') ctx.warn('Has cerrado la sesión de Azure CLI en Cloud Shell. Ejecuta "az login" para volver a iniciarla.');
    return undefined;
  },
});

register({
  path: 'account show',
  summary: 'Obtiene los detalles de una suscripción.',
  args: [{ name: 'name', opts: ['--name', '-n', '--subscription', '-s'], help: 'Nombre o ID de la suscripción.' }],
  table: accountTable,
  run(a, ctx) {
    const s = getState();
    const sub = a.name ? s.subscriptions.find((x) => ciEq(x.id, a.name) || ciEq(x.displayName, a.name)) : s.subscriptions.find((x) => x.id === ctx.subscriptionId);
    if (!sub) throw new ArmError('CliError', `Subscription '${a.name}' not found. Check the spelling and casing and try again.`, 1);
    return subscriptionJson(sub.id, ctx.principal, sub.id === ctx.sess.az.subscriptionId);
  },
});

register({
  path: 'account list',
  summary: 'Obtiene una lista de suscripciones para la cuenta que ha iniciado sesión.',
  args: [
    { name: 'all', opts: ['--all'], help: 'Lista todas las suscripciones de todos los inquilinos.', type: 'bool' },
    { name: 'refresh', opts: ['--refresh'], help: 'Obtiene la lista actualizada del servidor.', type: 'bool' },
  ],
  table: accountTable,
  run(_a, ctx) {
    return accessibleSubscriptions(ctx.principal).map((sub) => subscriptionJson(sub.id, ctx.principal, sub.id === ctx.sess.az.subscriptionId));
  },
});

register({
  path: 'account set',
  summary: 'Establece una suscripción como suscripción activa actual.',
  args: [{ name: 'subscription', opts: ['--subscription', '-s', '--name', '-n'], help: 'Nombre o ID de la suscripción.', required: true }],
  examples: [{ title: 'Cambiar a la suscripción de producción.', cmd: 'az account set --subscription "Azure Lab - Producción"' }],
  run(a, ctx) {
    const subs = accessibleSubscriptions(ctx.principal);
    const sub = subs.find((x) => ciEq(x.id, a.subscription) || ciEq(x.displayName, a.subscription));
    if (!sub) throw new ArmError('CliError', `The subscription of '${a.subscription}' doesn't exist in cloud 'AzureCloud'.`, 1, 'Comprueba los nombres con: az account list -o table');
    ctx.sess.az.subscriptionId = sub.id;
    ctx.sess.az.persist();
    return undefined;
  },
});

register({
  path: 'account list-locations',
  summary: 'Lista las ubicaciones admitidas para la suscripción actual.',
  args: [],
  table: (r: any[]) => r.map((x) => ({ DisplayName: x.displayName, Name: x.name, RegionalDisplayName: x.regionalDisplayName })),
  run() {
    return LOCATIONS.map((l) => ({
      displayName: l.displayName,
      id: `/subscriptions/${getState().currentSubscriptionId}/locations/${l.name}`,
      metadata: { geography: l.geo, geographyGroup: l.geo, pairedRegion: l.paired ? [{ name: l.paired }] : [], physicalLocation: l.displayName, regionCategory: 'Recommended', regionType: 'Physical' },
      name: l.name,
      regionalDisplayName: `(${l.geo}) ${l.displayName}`,
      type: 'Region',
    }));
  },
});

register({
  path: 'account get-access-token',
  summary: 'Obtiene un token para las utilidades que acceden a Azure.',
  args: [
    { name: 'resource', opts: ['--resource'], help: 'URI del recurso de Azure para el que se pide el token.' },
    { name: 'scope', opts: ['--scope'], help: 'Ámbito AAD v2.' },
  ],
  run(_a, ctx) {
    const body = btoa(JSON.stringify({ aud: 'https://management.core.windows.net/', iss: `https://sts.windows.net/${getState().tenant.id}/`, oid: ctx.principal.objectId, upn: ctx.principal.name })).replace(/=+$/, '');
    return { accessToken: `eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.${body}.${shortHash(guid(), 43)}`, expiresOn: new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 26), expires_on: Math.floor(Date.now() / 1000) + 3600, subscription: ctx.subscriptionId, tenant: getState().tenant.id, tokenType: 'Bearer' };
  },
});

register({
  path: 'account tenant list',
  summary: 'Lista los inquilinos.',
  args: [],
  run() {
    const s = getState();
    return [{ defaultDomain: s.tenant.domain, displayName: s.tenant.displayName, id: `/tenants/${s.tenant.id}`, tenantId: s.tenant.id, tenantType: 'AAD' }];
  },
});

register({
  path: 'configure',
  summary: 'Administra la configuración de Azure CLI (valores predeterminados, formato de salida...).',
  noLogin: true,
  args: [
    { name: 'defaults', opts: ['--defaults', '-d'], help: 'Valores predeterminados separados por espacios: clave=valor. Claves comunes: group, location, web, vm, acr. Ej.: --defaults group=rg-lab location=westeurope', type: 'kv' },
    { name: 'list_defaults', opts: ['--list-defaults', '-l'], help: 'Lista los valores predeterminados.', type: 'bool' },
    { name: 'scope', opts: ['--scope'], help: 'Ámbito de los valores predeterminados.', choices: ['global', 'local'], default: 'global' },
  ],
  examples: [{ title: 'Configura el grupo de recursos y la ubicación por defecto.', cmd: 'az configure --defaults group=rg-lab location=westeurope' }],
  run(a, ctx) {
    if (a.list_defaults) return Object.entries(ctx.sess.az.defaults).filter(([k]) => k !== 'output').map(([name, value]) => ({ name, source: '/home/' + ctx.sess.user + '/.azure/config', value }));
    if (a.defaults) {
      for (const [k, v] of Object.entries<string>(a.defaults)) {
        if (v === '') delete ctx.sess.az.defaults[k];
        else ctx.sess.az.defaults[k] = v;
      }
      ctx.sess.az.persist();
      return undefined;
    }
    ctx.io.out('Welcome to the Azure CLI! This command will guide you through logging in and setting some default values.\n\nUsa: az configure --defaults group=<grupo> location=<region>\n');
    return undefined;
  },
});

register({
  path: 'config set',
  summary: 'Establece una configuración (p. ej. defaults.group=rg-lab o core.output=table).',
  noLogin: true,
  positional: 'kv',
  args: [{ name: 'kv', opts: ['--kv'], help: 'Pares sección.clave=valor', type: 'list', hidden: true }],
  run(a, ctx) {
    for (const pair of a.kv ?? []) {
      const [key, ...rest] = String(pair).split('=');
      const value = rest.join('=');
      const m = /^(defaults|core)\.(\w+)$/.exec(key);
      if (!m) throw cliError(`Clave de configuración no soportada por el simulador: ${key} (usa defaults.<clave> o core.output)`);
      const k = m[1] === 'core' && m[2] === 'output' ? 'output' : m[2];
      if (value === '') delete ctx.sess.az.defaults[k];
      else ctx.sess.az.defaults[k] = value;
    }
    ctx.sess.az.persist();
    return undefined;
  },
});

register({
  path: 'config get',
  summary: 'Muestra la configuración.',
  noLogin: true,
  positional: 'key',
  args: [{ name: 'key', opts: ['--key'], help: 'Clave', type: 'list', hidden: true }],
  run(_a, ctx) {
    const defaults = Object.entries(ctx.sess.az.defaults).filter(([k]) => k !== 'output').map(([name, value]) => ({ name, source: '/home/' + ctx.sess.user + '/.azure/config', value }));
    const core = ctx.sess.az.defaults.output ? [{ name: 'output', source: '/home/' + ctx.sess.user + '/.azure/config', value: ctx.sess.az.defaults.output }] : [];
    return { core, defaults };
  },
});

register({
  path: 'config unset',
  summary: 'Elimina una configuración.',
  noLogin: true,
  positional: 'key',
  args: [{ name: 'key', opts: ['--key'], help: 'Clave', type: 'list', hidden: true }],
  run(a, ctx) {
    for (const key of a.key ?? []) {
      const k = String(key).replace(/^defaults\./, '').replace(/^core\.output$/, 'output');
      delete ctx.sess.az.defaults[k];
    }
    ctx.sess.az.persist();
    return undefined;
  },
});

register({
  path: 'version',
  summary: 'Muestra las versiones de los módulos y extensiones de Azure CLI.',
  noLogin: true,
  args: [],
  run(_a, ctx) {
    const exts: Record<string, string> = {};
    for (const e of getState().cli.extensions ?? ['azure-devops']) exts[e] = e === 'azure-devops' ? '1.0.1' : '1.0.0';
    return { 'azure-cli': '2.67.0', 'azure-cli-core': '2.67.0', 'azure-cli-telemetry': '1.1.0', extensions: exts };
  },
});

register({
  path: 'extension add',
  summary: 'Añade una extensión.',
  noLogin: true,
  args: [
    { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la extensión.', required: true },
    { name: 'upgrade', opts: ['--upgrade'], help: 'Actualiza si ya existe.', type: 'bool' },
  ],
  run(a, ctx) {
    const s = getState();
    s.cli.extensions = [...new Set([...(s.cli.extensions ?? ['azure-devops']), a.name])];
    changed();
    ctx.io.err(`Extension '${a.name}' ${a.name === 'azure-devops' || a.name === 'containerapp' || a.name === 'application-insights' ? 'is already installed or was installed.' : 'installed (simulada).'}\n`);
    return undefined;
  },
});

register({
  path: 'extension list',
  summary: 'Lista las extensiones instaladas.',
  noLogin: true,
  args: [],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, Version: x.version, ExtensionType: x.extensionType })),
  run() {
    return (getState().cli.extensions ?? ['azure-devops']).map((n) => ({ experimental: false, extensionType: 'whl', name: n, path: `/home/user/.azure/cliextensions/${n}`, preview: false, version: n === 'azure-devops' ? '1.0.1' : '1.0.0' }));
  },
});

register({
  path: 'extension remove',
  summary: 'Quita una extensión.',
  noLogin: true,
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre de la extensión.', required: true }],
  run(a) {
    const s = getState();
    s.cli.extensions = (s.cli.extensions ?? []).filter((x) => x !== a.name);
    changed();
    return undefined;
  },
});

register({
  path: 'find',
  summary: 'Busca ejemplos y comandos de Azure CLI.',
  noLogin: true,
  positional: 'cli_term',
  args: [{ name: 'cli_term', opts: ['--term'], help: 'Término de búsqueda.', type: 'list' }],
  run(a, ctx) {
    const term = String((a.cli_term ?? []).join(' ') || '').toLowerCase();
    const words = term.replace(/^az\s+/, '').split(/\s+/).filter(Boolean);
    const hits = allAzCommands()
      .filter((c) => words.every((w) => c.path.includes(w) || c.summary.toLowerCase().includes(w)))
      .slice(0, 8);
    if (!hits.length) {
      ctx.io.out(`No se encontraron comandos para "${term}". Prueba con: az --help\n`);
      return undefined;
    }
    ctx.io.out(`Encontrados ${hits.length} comandos para "${term}":\n\n`);
    for (const h of hits) ctx.io.out(`az ${h.path}\n    ${h.summary}\n${h.examples?.[0] ? `    Ej.: ${h.examples[0].cmd}\n` : ''}\n`);
    return undefined;
  },
});

register({
  path: 'upgrade',
  summary: 'Actualiza Azure CLI y las extensiones.',
  noLogin: true,
  args: [{ name: 'yes', opts: ['--yes', '-y'], help: 'No pedir confirmación.', type: 'bool' }],
  run(_a, ctx) {
    ctx.io.err('Your current Azure CLI version is 2.67.0. Latest version available is 2.67.0.\nYou already have the latest azure-cli version: 2.67.0\n');
    return undefined;
  },
});

register({
  path: 'interactive',
  summary: 'Inicia el modo interactivo (no disponible en el simulador).',
  noLogin: true,
  args: [],
  run(_a, ctx) {
    ctx.io.err('El modo interactivo no está disponible en el simulador. Usa la autocompletación con Tab y "--help".\n');
    return undefined;
  },
});

register({
  path: 'rest',
  summary: 'Invoca una solicitud personalizada a la API REST de Azure Resource Manager.',
  args: [
    { name: 'method', opts: ['--method', '-m'], help: 'Método HTTP.', choices: ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'], default: 'get' },
    { name: 'url', opts: ['--url', '--uri', '-u'], help: 'URL de la solicitud. Admite el marcador {subscriptionId}.', required: true },
    { name: 'body', opts: ['--body', '-b'], help: 'Cuerpo de la solicitud.' },
  ],
  examples: [{ title: 'Obtener un grupo de recursos con la API REST.', cmd: 'az rest --method get --url "https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/rg-lab?api-version=2021-04-01"' }],
  run(a, ctx) {
    const s = getState();
    let url = String(a.url).replace('{subscriptionId}', ctx.subscriptionId);
    if (url.startsWith('/')) url = 'https://management.azure.com' + url;
    const m = /^https:\/\/management\.azure\.com(\/[^?]*)/.exec(url);
    if (!m) throw new ArmError('CliError', `Can't derive appropriate Azure AD resource from --url to acquire an access token. If access token is required, use --resource to specify the resource`, 1);
    if (a.method !== 'get') throw new ArmError('CliError', 'El simulador sólo admite peticiones GET con az rest.', 1);
    const path = m[1].replace(/\/$/, '');
    if (/^\/subscriptions\/[^/]+$/i.test(path)) return subscriptionJson(path.split('/')[2], ctx.principal, true);
    if (/^\/subscriptions\/[^/]+\/resourcegroups$/i.test(path)) return { value: s.resourceGroups.filter((g) => ciEq(g.subscriptionId, path.split('/')[2])).map(rgToJson) };
    if (/^\/subscriptions\/[^/]+\/resources$/i.test(path)) return { value: s.resources.filter((r) => ciEq(r.subscriptionId, path.split('/')[2])).map(resourceListItem) };
    const p = parseResourceId(path);
    if (p.resourceGroup && !p.type) {
      const rg = findRg(p.subscriptionId!, p.resourceGroup);
      if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${p.resourceGroup}' could not be found.`, 404);
      return rgToJson(rg);
    }
    const r = findResource(path);
    if (!r) throw new ArmError('ResourceNotFound', `The Resource '${p.type}/${p.name}' under resource group '${p.resourceGroup}' was not found.`, 404);
    return resourceToArm(r);
  },
});
