// az appservice plan / webapp / functionapp.
import { register, group, A, cliError, type Args, type AzCtx, type AzArg } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { authorize, createResourceGroup, deleteResource, findRg, findResource, patchResource, putResource } from '../../../engine/arm';
import { resourceId } from '../../../engine/ids';
import { APP_SERVICE_SKUS, WEB_RUNTIMES, findLocation, findRuntime } from '../../../engine/catalog';
import { ciEq, nowIso } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { appSettingsList, deleteAppSettings, deployContent, setAppSettings, setSiteConfig, setSiteState, swapSlots, getSite } from '../../../engine/services/web';
import { slotsOf } from '../../../engine/providers/web';
import { resolveIdentity } from '../../../engine/providers/identity';
import { createRoleAssignment } from '../../../engine/services/identity';
import { readZip } from '../../fs';
import { delay, hint } from '../../commands/util';
import { riskyFiles } from '../../../engine/fileRules';

const T_PLAN = 'Microsoft.Web/serverfarms';
const T_SITE = 'Microsoft.Web/sites';
const T_SLOT = 'Microsoft.Web/sites/slots';

group('appservice', 'Administra App Service.');
group('appservice plan', 'Administra planes de App Service.');
group('webapp', 'Administra aplicaciones web.');
group('webapp config', 'Configura una aplicación web.');
group('webapp config appsettings', 'Configuración de aplicación (variables de entorno).');
group('webapp config connection-string', 'Cadenas de conexión de la aplicación.');
group('webapp deployment', 'Administra implementaciones de aplicaciones web.');
group('webapp deployment slot', 'Administra ranuras de implementación.');
group('webapp deployment source', 'Administra el origen de implementación.');
group('webapp log', 'Administra los registros de la aplicación web.');
group('webapp identity', 'Administra la identidad administrada de la aplicación web.');
group('webapp traffic-routing', 'Enrutamiento de tráfico entre ranuras (pruebas en producción).');
group('functionapp', 'Administra aplicaciones de funciones (Azure Functions).');
group('functionapp config appsettings', 'Configuración de la aplicación de funciones.');
group('functionapp deployment source', 'Origen de implementación de la aplicación de funciones.');

const planTable = (r: any) => (Array.isArray(r) ? r : [r]).map((p: any) => ({ Name: p.name, Location: p.location, Status: p.status, ResourceGroup: p.resourceGroup, Sku: p.sku?.name, Instances: p.sku?.capacity, Kind: p.kind }));
const siteTable = (r: any) => (Array.isArray(r) ? r : [r]).map((s: any) => ({ Name: s.name, Location: s.location, State: s.state, ResourceGroup: s.resourceGroup, DefaultHostName: s.defaultHostName, AppServicePlan: String(s.serverFarmId ?? '').split('/').pop() }));

function siteJson(site: any) {
  const out = flat(site);
  if (out.siteConfig) out.siteConfig = { ...out.siteConfig, appSettings: null, connectionStrings: null };
  return out;
}

function planId(ctx: AzCtx, plan: string, rg: string): string {
  if (plan.startsWith('/')) return plan;
  const own = findResource(resourceId(ctx.subscriptionId, rg, T_PLAN, plan));
  if (own) return own.id;
  const any = getState().resources.find((r) => ciEq(r.type, T_PLAN) && ciEq(r.name, plan) && r.subscriptionId === ctx.subscriptionId);
  if (any) return any.id;
  throw new ArmError('ServerFarmNotFound', `The plan '${plan}' doesn't exist in the resource group '${rg}'.`, 404, 'Crea primero el plan: az appservice plan create -g <grupo> -n <plan> --sku B1 --is-linux');
}

/** Resuelve la app (o una de sus ranuras con --slot). */
function siteArg(ctx: AzCtx, a: Args, type = T_SITE) {
  const site = getRes(ctx, a, type);
  if (!a.slot || ciEq(a.slot, 'production')) return site;
  const slot = slotsOf(site, getState()).find((x) => ciEq(x.name.split('/')[1], a.slot));
  if (!slot) throw new ArmError('ResourceNotFound', `The Resource 'Microsoft.Web/sites/${site.name}/slots/${a.slot}' under resource group '${site.resourceGroup}' was not found.`, 404);
  return slot;
}

const slotArg: AzArg = { name: 'slot', opts: ['--slot', '-s'], help: 'Nombre de la ranura (por defecto, producción).' };
const siteArgs: AzArg[] = [A.rg(false), A.name('Nombre de la aplicación web.', false), A.ids()];

// ---------------------------------------------------------------- plan

register({
  path: 'appservice plan create',
  summary: 'Crea un plan de App Service.',
  args: [
    A.rg(),
    A.name('Nombre del plan.'),
    A.location(),
    A.sku('Plan de tarifa.', APP_SERVICE_SKUS.map((s) => s.name), 'B1'),
    { name: 'is_linux', opts: ['--is-linux'], help: 'Plan Linux (por defecto, Windows).', type: 'bool' },
    { name: 'number_of_workers', opts: ['--number-of-workers'], help: 'Número de instancias.', type: 'int' },
    { name: 'per_site_scaling', opts: ['--per-site-scaling'], help: 'Escalado por aplicación.', type: 'bool' },
    { name: 'zone_redundant', opts: ['--zone-redundant'], help: 'Redundancia de zona.', type: 'bool' },
    A.tags(),
  ],
  examples: [{ title: 'Plan Linux básico.', cmd: 'az appservice plan create -g rg-lab -n asp-lab --sku B1 --is-linux' }],
  table: planTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const r = await putResource({ type: T_PLAN, name: a.name, location: a.location, tags: a.tags, kind: a.is_linux ? 'linux' : 'app', sku: { name: a.sku, capacity: a.number_of_workers ?? 1 }, properties: { reserved: !!a.is_linux, perSiteScaling: a.per_site_scaling, zoneRedundant: a.zone_redundant } }, rg.name, op(ctx));
    return flat(r);
  },
});

register({
  path: 'appservice plan list',
  summary: 'Lista los planes de App Service.',
  args: [A.rg(false)],
  table: planTable,
  run: (a, ctx) => listInSub(ctx, T_PLAN, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'appservice plan show',
  summary: 'Muestra un plan de App Service.',
  args: [A.rg(false), A.name('Nombre del plan.', false), A.ids()],
  table: planTable,
  run: (a, ctx) => flat(getRes(ctx, a, T_PLAN)),
});

register({
  path: 'appservice plan update',
  summary: 'Escala un plan: verticalmente (--sku) u horizontalmente (--number-of-workers).',
  args: [A.rg(false), A.name('Nombre del plan.', false), A.ids(), { name: 'sku', opts: ['--sku'], help: 'Nuevo plan de tarifa (escalado vertical).' }, { name: 'number_of_workers', opts: ['--number-of-workers'], help: 'Número de instancias (escalado horizontal).', type: 'int' }, A.tags()],
  examples: [{ title: 'Escalar a S1 con 2 instancias.', cmd: 'az appservice plan update -g rg-lab -n asp-lab --sku S1 --number-of-workers 2' }],
  table: planTable,
  async run(a, ctx) {
    const p = getRes(ctx, a, T_PLAN);
    const r = await putResource({ type: T_PLAN, name: p.name, location: p.location, tags: a.tags ?? p.tags, kind: p.kind, sku: { name: a.sku ?? p.sku!.name, capacity: a.number_of_workers ?? p.sku!.capacity }, properties: { ...p.properties } }, p.resourceGroup, op(ctx));
    return flat(r);
  },
});

register({
  path: 'appservice plan delete',
  summary: 'Elimina un plan de App Service.',
  args: [A.rg(false), A.name('Nombre del plan.', false), A.ids(), A.yes()],
  confirm: 'Are you sure you want to delete the app service plan?',
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_PLAN).id, op(ctx));
    return undefined;
  },
});

// ---------------------------------------------------------------- webapp

register({
  path: 'webapp create',
  summary: 'Crea una aplicación web en un plan existente.',
  args: [
    A.rg(),
    A.name('Nombre de la app: será <nombre>.azurewebsites.net, único en todo Azure.'),
    { name: 'plan', opts: ['--plan', '-p'], help: 'Nombre o ID del plan de App Service.', required: true },
    { name: 'runtime', opts: ['--runtime', '-r'], help: 'Pila de runtime, p. ej. "NODE:20-lts", "PYTHON:3.12", "DOTNETCORE:8.0". Ver `az webapp list-runtimes`.' },
    { name: 'container_image', opts: ['--container-image-name', '--deployment-container-image-name', '-i'], help: 'Imagen de contenedor (p. ej. miacr.azurecr.io/app:v1).' },
    { name: 'assign_identity', opts: ['--assign-identity'], help: 'Asigna identidades ([system] o IDs).', type: 'list' },
    { name: 'role', opts: ['--role'], help: 'Rol para la identidad.' },
    { name: 'scope', opts: ['--scope'], help: 'Ámbito del rol.' },
    { name: 'https_only', opts: ['--https-only'], help: 'Redirige HTTP a HTTPS.', type: 'bool' },
    { name: 'deployment_local_git', opts: ['--deployment-local-git', '-l'], help: 'Habilita git local.', type: 'bool' },
    A.tags(),
  ],
  examples: [{ title: 'App Node 20 en un plan Linux.', cmd: 'az webapp create -g rg-lab -p asp-lab -n app-lab-ana123 --runtime "NODE:20-lts"' }],
  table: siteTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const pid = planId(ctx, a.plan, rg.name);
    const plan = findResource(pid)!;
    let fx: string | undefined;
    if (a.container_image) fx = `DOCKER|${a.container_image}`;
    else if (a.runtime) {
      const rt = findRuntime(a.runtime);
      if (!rt) throw cliError(`Linux Runtime '${a.runtime}' is not supported. Run 'az webapp list-runtimes --os-type linux' to cross check`, 'Formato: "NODE:20-lts", "PYTHON:3.12"...');
      if ((rt.os === 'linux') !== !!plan.properties.reserved) throw cliError(`The runtime '${a.runtime}' is not supported on a ${plan.properties.reserved ? 'Linux' : 'Windows'} plan.`);
      fx = rt.fx;
    } else if (plan.properties.reserved) ctx.warn('No se ha indicado --runtime: la app se crea sin pila de runtime (como en el CLI real, tendrás que configurarla después con "az webapp config set --linux-fx-version").');
    const existing = findResource(resourceId(ctx.subscriptionId, rg.name, T_SITE, a.name));
    if (existing) ctx.warn(`Webapp '${a.name}' already exists. The command will use the existing app's settings.`);
    const site = await putResource(
      {
        type: T_SITE,
        name: a.name,
        location: plan.location,
        tags: a.tags,
        kind: a.container_image ? 'app,linux,container' : undefined,
        identity: a.assign_identity ? { type: 'SystemAssigned' } : undefined,
        properties: { serverFarmId: pid, httpsOnly: a.https_only, siteConfig: { linuxFxVersion: fx } },
      },
      rg.name,
      op(ctx),
    );
    if (a.assign_identity && a.role && a.scope && site.identity?.principalId) createRoleAssignment({ assignee: site.identity.principalId, role: a.role, scope: a.scope }, ctx.principal);
    if (a.container_image) {
      const { resolveImage } = await import('../../../engine/services/kube');
      const r = resolveImage(a.container_image, site.identity?.principalId ? { type: 'ServicePrincipal', objectId: site.identity.principalId, name: '', displayName: site.name } : null, getState());
      if (r.ok) site.data!.content = { files: r.pkg!.files, version: 1, deployedAt: nowIso(), by: 'container', kind: 'container', publicImage: r.pkg!.publicImage };
      else site.data!.logs = [...(site.data!.logs ?? []), `${nowIso()}  ERROR - Pull image failed: ${r.message}`];
    }
    return { ...siteJson(site), ftpPublishingUrl: `ftps://waws-prod-am2-${a.name.length}.ftp.azurewebsites.windows.net/site/wwwroot` };
  },
});

register({
  path: 'webapp list',
  summary: 'Lista las aplicaciones web.',
  args: [A.rg(false)],
  table: siteTable,
  run: (a, ctx) => listInSub(ctx, T_SITE, a.resource_group).filter((s) => !String(s.kind).includes('functionapp')).map(siteJson),
});

register({
  path: 'webapp show',
  summary: 'Muestra una aplicación web.',
  args: [...siteArgs, slotArg],
  table: siteTable,
  run: (a, ctx) => siteJson(siteArg(ctx, a)),
});

register({
  path: 'webapp update',
  summary: 'Actualiza una aplicación web (HTTPS sólo, afinidad...).',
  args: [...siteArgs, slotArg, { name: 'https_only', opts: ['--https-only'], help: 'Redirige HTTP a HTTPS.', type: 'bool' }, { name: 'client_affinity_enabled', opts: ['--client-affinity-enabled'], help: 'Afinidad de sesión (ARR).', type: 'bool' }, A.tags()],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    patchResource(site.id, (r) => {
      if (a.https_only !== undefined) r.properties.httpsOnly = a.https_only;
      if (a.client_affinity_enabled !== undefined) r.properties.clientAffinityEnabled = a.client_affinity_enabled;
      if (a.tags) r.tags = a.tags;
    }, { principal: ctx.principal });
    return siteJson(site);
  },
});

register({
  path: 'webapp delete',
  summary: 'Elimina una aplicación web.',
  args: [...siteArgs, slotArg, { name: 'keep_empty_plan', opts: ['--keep-empty-plan'], help: 'Conserva el plan vacío.', type: 'bool' }],
  async run(a, ctx) {
    const site = siteArg(ctx, a);
    await deleteResource(site.id, op(ctx));
    return undefined;
  },
});

for (const [verb, state, summary] of [['start', 'Running', 'Inicia una aplicación web.'], ['stop', 'Stopped', 'Detiene una aplicación web.'], ['restart', 'Restart', 'Reinicia una aplicación web.']] as const) {
  register({
    path: `webapp ${verb}`,
    summary,
    args: [...siteArgs, slotArg],
    async run(a, ctx) {
      await setSiteState(siteArg(ctx, a).id, state, ctx.principal);
      return undefined;
    },
  });
}

register({
  path: 'webapp browse',
  summary: 'Abre la aplicación web en el navegador.',
  args: [...siteArgs, slotArg],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    const url = `https://${site.properties.defaultHostName}`;
    ctx.sess.ui.openUrl?.(url);
    ctx.io.err(`Abriendo ${url} en el navegador simulado...\n`);
    return undefined;
  },
});

register({
  path: 'webapp list-runtimes',
  summary: 'Lista las pilas de runtime disponibles.',
  noLogin: true,
  args: [{ name: 'os_type', opts: ['--os-type', '--os'], help: 'Sistema operativo.', choices: ['linux', 'windows'] }],
  run(a) {
    return WEB_RUNTIMES.filter((r) => !a.os_type || r.os === a.os_type).map((r) => r.id);
  },
});

// ---------------------------------------------------------------- config

register({
  path: 'webapp config appsettings set',
  summary: 'Establece la configuración de aplicación (variables de entorno). La app se reinicia.',
  args: [...siteArgs, slotArg, { name: 'settings', opts: ['--settings'], help: 'Pares CLAVE=VALOR separados por espacios.', type: 'kv' }, { name: 'slot_settings', opts: ['--slot-settings'], help: 'Pares CLAVE=VALOR "pegajosos" (no se intercambian en un swap).', type: 'kv' }],
  examples: [
    { title: 'Definir variables de entorno.', cmd: 'az webapp config appsettings set -g rg-lab -n app-lab --settings GREETING="Hola" APP_ENV=prod' },
    { title: 'Referencia a un secreto de Key Vault.', cmd: 'az webapp config appsettings set -g rg-lab -n app-lab --settings DB_PASSWORD="@Microsoft.KeyVault(SecretUri=https://kv-lab.vault.azure.net/secrets/db-password/)"' },
  ],
  run(a, ctx) {
    if (!a.settings && !a.slot_settings) throw cliError('usage error: --settings |--slot-settings', undefined, true);
    return setAppSettings(siteArg(ctx, a).id, a.settings ?? {}, a.slot_settings ?? {}, ctx.principal);
  },
});

register({
  path: 'webapp config appsettings list',
  summary: 'Muestra la configuración de aplicación.',
  args: [...siteArgs, slotArg],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, Value: x.value, SlotSetting: x.slotSetting })),
  run(a, ctx) {
    const site = siteArg(ctx, a);
    authorize(ctx.principal, `${site.type}/config/list/action`, site.id);
    return appSettingsList(site);
  },
});

register({
  path: 'webapp config appsettings delete',
  summary: 'Elimina valores de configuración.',
  args: [...siteArgs, slotArg, { name: 'setting_names', opts: ['--setting-names'], help: 'Nombres a eliminar.', type: 'list', required: true }],
  run(a, ctx) {
    return deleteAppSettings(siteArg(ctx, a).id, a.setting_names, ctx.principal);
  },
});

register({
  path: 'webapp config connection-string set',
  summary: 'Establece cadenas de conexión.',
  args: [...siteArgs, slotArg, { name: 'connection_string_type', opts: ['--connection-string-type', '-t'], help: 'Tipo.', choices: ['SQLAzure', 'SQLServer', 'MySql', 'PostgreSQL', 'Custom', 'RedisCache', 'DocDb', 'ServiceBus', 'EventHub', 'ApiHub', 'NotificationHub'], required: true }, { name: 'settings', opts: ['--settings'], help: 'Pares NOMBRE=CADENA.', type: 'kv', required: true }],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    patchResource(site.id, (r) => {
      const list: any[] = r.properties.siteConfig.connectionStrings ?? [];
      for (const [k, v] of Object.entries<string>(a.settings)) {
        const i = list.findIndex((x) => x.name === k);
        const entry = { name: k, connectionString: v, type: a.connection_string_type };
        if (i >= 0) list[i] = entry;
        else list.push(entry);
      }
      r.properties.siteConfig.connectionStrings = list;
    }, { principal: ctx.principal, action: `${site.type}/config/write`, opName: 'Actualizar cadenas de conexión' });
    return Object.fromEntries((site.properties.siteConfig.connectionStrings ?? []).map((c: any) => [c.name, { type: c.type, value: c.connectionString }]));
  },
});

register({
  path: 'webapp config connection-string list',
  summary: 'Lista las cadenas de conexión.',
  args: [...siteArgs, slotArg],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    return (site.properties.siteConfig.connectionStrings ?? []).map((c: any) => ({ name: c.name, slotSetting: false, type: c.type, value: c.connectionString }));
  },
});

register({
  path: 'webapp config set',
  summary: 'Configuración general: Always On, versión de runtime, TLS, comando de inicio, health check...',
  args: [
    ...siteArgs,
    slotArg,
    { name: 'always_on', opts: ['--always-on'], help: 'Mantiene la app cargada (no disponible en Free).', type: 'bool' },
    { name: 'linux_fx_version', opts: ['--linux-fx-version'], help: 'Runtime Linux, p. ej. "NODE|20-lts".' },
    { name: 'min_tls_version', opts: ['--min-tls-version'], help: 'TLS mínimo.', choices: ['1.0', '1.1', '1.2', '1.3'] },
    { name: 'http20_enabled', opts: ['--http20-enabled'], help: 'HTTP/2.', type: 'bool' },
    { name: 'ftps_state', opts: ['--ftps-state'], help: 'Estado FTPS.', choices: ['AllAllowed', 'FtpsOnly', 'Disabled'] },
    { name: 'startup_file', opts: ['--startup-file'], help: 'Comando de inicio.' },
    { name: 'health_check_path', opts: ['--generic-configurations', '--health-check-path'], help: 'Ruta de comprobación de estado.' },
    { name: 'number_of_workers', opts: ['--number-of-workers'], help: 'Instancias de esta app (con escalado por aplicación).', type: 'int' },
  ],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    const cfg: Record<string, any> = {};
    if (a.always_on !== undefined) cfg.alwaysOn = a.always_on;
    if (a.linux_fx_version) {
      const rt = findRuntime(a.linux_fx_version);
      if (!rt && !String(a.linux_fx_version).toUpperCase().startsWith('DOCKER|')) throw cliError(`Linux Runtime '${a.linux_fx_version}' is not supported.`);
      cfg.linuxFxVersion = rt?.fx ?? a.linux_fx_version;
    }
    if (a.min_tls_version) cfg.minTlsVersion = a.min_tls_version;
    if (a.http20_enabled !== undefined) cfg.http20Enabled = a.http20_enabled;
    if (a.ftps_state) cfg.ftpsState = a.ftps_state;
    if (a.startup_file !== undefined) cfg.appCommandLine = a.startup_file;
    if (a.health_check_path) cfg.healthCheckPath = String(a.health_check_path).replace(/^.*healthCheckPath["']?\s*[:=]\s*["']?/, '').replace(/["'}]/g, '');
    if (a.number_of_workers) cfg.numberOfWorkers = a.number_of_workers;
    const c = setSiteConfig(site.id, cfg, ctx.principal);
    return { ...c, appSettings: null, connectionStrings: null };
  },
});

register({
  path: 'webapp config show',
  summary: 'Muestra la configuración general.',
  args: [...siteArgs, slotArg],
  run(a, ctx) {
    const c = siteArg(ctx, a).properties.siteConfig;
    return { ...c, appSettings: null, connectionStrings: null };
  },
});

// ---------------------------------------------------------------- despliegue

function readPackage(ctx: AzCtx, src: string, type?: string): Record<string, string> {
  const abs = ctx.sess.resolve(src);
  if (ctx.sess.fs.isDir(abs)) return ctx.sess.fs.snapshot(abs, (rel) => rel.startsWith('.git/') || rel === '.git' || rel.startsWith('node_modules/'));
  let content: string;
  try {
    content = ctx.sess.fs.readFile(abs);
  } catch {
    throw cliError(`Either '${src}' is not a valid local file path or you do not have permissions to access it`);
  }
  const zip = readZip(content);
  if (zip) return zip;
  if (type === 'zip' || src.endsWith('.zip')) throw cliError(`'${src}' no es un fichero zip válido. Créalo con: zip -r app.zip .`);
  return { [src.split('/').pop()!]: content };
}

register({
  path: 'webapp deploy',
  summary: 'Despliega un paquete (zip, fichero estático...) en una aplicación web.',
  args: [...siteArgs, slotArg, { name: 'src_path', opts: ['--src-path'], help: 'Ruta del paquete (p. ej. app.zip).' }, { name: 'src_url', opts: ['--src-url'], help: 'URL del paquete (no soportado).', hidden: true }, { name: 'type', opts: ['--type'], help: 'Tipo de artefacto.', choices: ['zip', 'war', 'jar', 'ear', 'lib', 'startup', 'static'] }, { name: 'target_path', opts: ['--target-path'], help: 'Ruta de destino.' }, { name: 'restart', opts: ['--restart'], help: 'Reinicia tras desplegar.', type: 'bool' }, { name: 'async', opts: ['--async'], help: 'Asíncrono.', type: 'bool' }, { name: 'clean', opts: ['--clean'], help: 'Limpia el destino.', type: 'bool' }],
  examples: [{ title: 'Desplegar un zip.', cmd: 'cd ~/samples/app-node && zip -r app.zip . && az webapp deploy -g rg-lab -n app-lab --src-path app.zip --type zip' }],
  longRunning: true,
  async run(a, ctx) {
    if (!a.src_path) throw cliError('usage error: --src-path | --src-url', undefined, true);
    const site = siteArg(ctx, a);
    ctx.io.err('Initiating deployment\nDeploying from local path: ' + a.src_path + '\n');
    let files = readPackage(ctx, a.src_path, a.type);
    if (a.type === 'static') files = { ...(site.data?.content?.files ?? {}), [a.target_path ?? Object.keys(files)[0]]: Object.values(files)[0] };
    const r = await deployContent(site.id, files, { principal: ctx.principal, deployer: 'OneDeploy', message: 'OneDeploy' });
    ctx.io.err(`Polling the status of sync deployment. Start Time: ${r.start_time} UTC\nStatus: Build successful. Time: 4(s)\nStatus: Site started successfully. Time: 6(s)\nDeployment has completed successfully\nYou can visit your app at: https://${site.properties.defaultHostName}\n`);
    warnRiskyPackage(ctx, files);
    return r;
  },
});

/** Consejo del simulador (Azure no avisa): el paquete lleva ficheros que nunca deberían llegar a producción. */
function warnRiskyPackage(ctx: AzCtx, files: Record<string, string>) {
  const risky = riskyFiles(Object.keys(files)).filter((x) => x.kind === 'secreto');
  if (!risky.length) return;
  hint(ctx.io, `El paquete incluía ${risky.map((x) => `${x.path} (${x.why})`).join(', ')}. App Service no filtra nada: ahora está en /home/site/wwwroot. Excluye esos ficheros del zip (zip -r app.zip . -x ".env"), revisa el paquete con unzip -l y pon la configuración en App Settings o Key Vault. Guía completa: Academia → Guía de ficheros.`);
}

register({
  path: 'webapp deployment source config-zip',
  summary: 'Despliega un zip (Kudu ZipDeploy).',
  args: [...siteArgs, slotArg, { name: 'src', opts: ['--src'], help: 'Ruta del zip.', required: true }, { name: 'timeout', opts: ['--timeout', '-t'], help: 'Tiempo máximo.', type: 'int' }],
  longRunning: true,
  async run(a, ctx) {
    const site = siteArg(ctx, a);
    ctx.io.err(`Getting scm site credentials for zip deployment\nStarting zip deployment. This operation can take a while to complete ...\n`);
    const files = readPackage(ctx, a.src, 'zip');
    const r = await deployContent(site.id, files, { principal: ctx.principal, deployer: 'ZipDeploy', message: 'Created via a push deployment' });
    ctx.io.err(`Deployment endpoint responded with status code 202\n`);
    warnRiskyPackage(ctx, files);
    return r;
  },
});

register({
  path: 'webapp deployment list-publishing-profiles',
  summary: 'Obtiene los perfiles de publicación.',
  args: [...siteArgs, slotArg],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    authorize(ctx.principal, `${site.type}/publishxml/action`, site.id);
    return [{ profileName: `${site.name} - Web Deploy`, publishMethod: 'MSDeploy', publishUrl: `${site.name}.scm.azurewebsites.net:443`, userName: `$${site.name}`, userPWD: '***', destinationAppUrl: `https://${site.properties.defaultHostName}` }];
  },
});

register({
  path: 'webapp up',
  summary: 'Crea (si hace falta) grupo, plan y app, y despliega el directorio actual en un solo paso.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre de la app.' }, A.rg(false), { name: 'plan', opts: ['--plan', '-p'], help: 'Nombre del plan.' }, A.location(), { name: 'sku', opts: ['--sku'], help: 'Plan de tarifa.', default: 'B1' }, { name: 'runtime', opts: ['--runtime', '-r'], help: 'Runtime (se detecta si no se indica).' }, { name: 'os_type', opts: ['--os-type'], help: 'Sistema operativo.', choices: ['Linux', 'Windows'], default: 'Linux' }, { name: 'html', opts: ['--html'], help: 'Despliega como sitio estático HTML.', type: 'bool' }, { name: 'dryrun', opts: ['--dryrun'], help: 'Sólo muestra lo que haría.', type: 'bool' }],
  longRunning: true,
  async run(a, ctx) {
    const files = ctx.sess.fs.snapshot(ctx.sess.cwd, (rel) => rel.startsWith('.git') || rel.startsWith('node_modules/'));
    if (!Object.keys(files).length) throw cliError('Could not auto-detect the runtime stack of your app. Usa --runtime o ejecuta el comando dentro de la carpeta de tu proyecto.');
    let runtime = a.runtime;
    if (!runtime) runtime = files['package.json'] ? 'NODE:20-lts' : files['requirements.txt'] || Object.keys(files).some((f) => f.endsWith('.py')) ? 'PYTHON:3.12' : a.html || Object.keys(files).some((f) => f.endsWith('.html')) ? 'PHP:8.3' : undefined;
    if (!runtime) throw cliError('Could not auto-detect the runtime stack of your app.\nHINT: Test command `az webapp up --runtime "NODE:20-lts"` to specify the runtime.');
    const name = a.name ?? `${ctx.sess.user}-app-${Math.floor(Math.random() * 9000 + 1000)}`;
    const loc = findLocation(a.location ?? ctx.sess.az.defaults.location ?? 'westeurope')?.name ?? 'westeurope';
    const rgName = a.resource_group ?? `${ctx.sess.user}_rg_${a.os_type.toLowerCase()}_${loc}`;
    const planName = a.plan ?? `${ctx.sess.user}_asp_${a.os_type.toLowerCase()}_${loc}_${Math.floor(Math.random() * 9000 + 1000)}`;
    const summary = { URL: `http://${name}.azurewebsites.net`, appserviceplan: planName, location: loc, name, os: a.os_type, resourcegroup: rgName, runtime_version: runtime, runtime_version_detected: '-', sku: a.sku, src_path: `//${ctx.sess.cwd}` };
    if (a.dryrun) return summary;
    if (!findRg(ctx.subscriptionId, rgName)) {
      ctx.io.err(`Creating Resource group '${rgName}' ...\n`);
      createResourceGroup(rgName, loc, undefined, op(ctx));
    }
    let plan = findResource(resourceId(ctx.subscriptionId, rgName, T_PLAN, planName));
    if (!plan) {
      ctx.io.err(`Creating AppServicePlan '${planName}' ...\n`);
      plan = await putResource({ type: T_PLAN, name: planName, location: loc, kind: 'linux', sku: { name: a.sku }, properties: { reserved: a.os_type === 'Linux' } }, rgName, op(ctx));
    }
    let site = findResource(resourceId(ctx.subscriptionId, rgName, T_SITE, name));
    if (!site) {
      ctx.io.err(`Creating webapp '${name}' ...\n`);
      site = await putResource({ type: T_SITE, name, location: loc, properties: { serverFarmId: plan.id, siteConfig: { linuxFxVersion: findRuntime(runtime)?.fx } } }, rgName, op(ctx));
    }
    ctx.io.err(`Configuring default logging for the app, if not already enabled\nCreating zip with contents of dir ${ctx.sess.cwd} ...\nGetting scm site credentials for zip deployment\nStarting zip deployment. This operation can take a while to complete ...\n`);
    setAppSettings(site.id, { SCM_DO_BUILD_DURING_DEPLOYMENT: 'True' }, {}, ctx.principal);
    await deployContent(site.id, files, { principal: ctx.principal, deployer: 'ZipDeploy', message: 'az webapp up' });
    ctx.io.err(`Deployment endpoint responded with status code 202\nYou can launch the app at http://${name}.azurewebsites.net\nSetting 'az webapp up' default arguments for current directory. Manage defaults with 'az configure --scope local'\n`);
    ctx.sess.az.defaults.web = name;
    ctx.sess.az.defaults.group = rgName;
    ctx.sess.az.persist();
    return summary;
  },
});

// ---------------------------------------------------------------- ranuras

register({
  path: 'webapp deployment slot create',
  summary: 'Crea una ranura de implementación (requiere plan Standard o superior).',
  args: [...siteArgs, { name: 'slot', opts: ['--slot', '-s'], help: 'Nombre de la ranura, p. ej. staging.', required: true }, { name: 'configuration_source', opts: ['--configuration-source'], help: 'Copia la configuración de esta app o ranura.' }],
  examples: [{ title: 'Crear la ranura staging copiando la configuración.', cmd: 'az webapp deployment slot create -g rg-lab -n app-lab --slot staging --configuration-source app-lab' }],
  table: siteTable,
  longRunning: true,
  async run(a, ctx) {
    const site = getRes(ctx, a, T_SITE);
    const source = a.configuration_source ? (ciEq(a.configuration_source, site.name) ? site : slotsOf(site, getState()).find((x) => ciEq(x.name.split('/')[1], a.configuration_source))) : undefined;
    const settings = source ? (source.properties.siteConfig.appSettings ?? []).filter((x: any) => !(source.data?.stickySettings ?? []).includes(x.name)) : [];
    const slot = await putResource({ type: T_SLOT, name: `${site.name}/${a.slot}`, location: site.location, tags: site.tags, kind: site.kind, properties: { serverFarmId: site.properties.serverFarmId, siteConfig: { linuxFxVersion: site.properties.siteConfig.linuxFxVersion, appSettings: settings } } }, site.resourceGroup, op(ctx));
    return siteJson(slot);
  },
});

register({
  path: 'webapp deployment slot list',
  summary: 'Lista las ranuras de una app.',
  args: siteArgs,
  table: siteTable,
  run(a, ctx) {
    return slotsOf(getRes(ctx, a, T_SITE), getState()).map(siteJson);
  },
});

register({
  path: 'webapp deployment slot delete',
  summary: 'Elimina una ranura.',
  args: [...siteArgs, { name: 'slot', opts: ['--slot', '-s'], help: 'Ranura.', required: true }],
  async run(a, ctx) {
    await deleteResource(siteArg(ctx, a).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'webapp deployment slot swap',
  summary: 'Intercambia dos ranuras (p. ej. staging → producción) sin tiempo de inactividad.',
  args: [...siteArgs, { name: 'slot', opts: ['--slot', '-s'], help: 'Ranura de origen.', required: true }, { name: 'target_slot', opts: ['--target-slot'], help: 'Ranura de destino.', default: 'production' }, { name: 'action', opts: ['--action'], help: 'Acción.', choices: ['swap', 'preview', 'reset'], default: 'swap' }],
  examples: [{ title: 'Promocionar staging a producción.', cmd: 'az webapp deployment slot swap -g rg-lab -n app-lab --slot staging --target-slot production' }],
  longRunning: true,
  async run(a, ctx) {
    const site = getRes(ctx, a, T_SITE);
    if (a.action !== 'swap') {
      ctx.warn('El simulador realiza el intercambio directamente (preview/reset no implementados).');
    }
    await swapSlots(site.id, a.slot, a.target_slot, ctx.principal);
    return undefined;
  },
});

register({
  path: 'webapp traffic-routing set',
  summary: 'Envía un porcentaje del tráfico de producción a otras ranuras (pruebas en producción / canary).',
  args: [...siteArgs, { name: 'distribution', opts: ['--distribution', '-d'], help: 'Pares ranura=porcentaje, p. ej. staging=20.', type: 'kv', required: true }],
  run(a, ctx) {
    const site = getRes(ctx, a, T_SITE);
    const dist: Record<string, number> = {};
    for (const [k, v] of Object.entries<string>(a.distribution)) {
      if (!slotsOf(site, getState()).some((x) => ciEq(x.name.split('/')[1], k))) throw new ArmError('NotFound', `Slot '${k}' not found.`, 404);
      dist[k] = Number(v);
    }
    if (Object.values(dist).reduce((x, y) => x + y, 0) > 100) throw cliError('La suma de porcentajes no puede superar 100.');
    site.data!.routing = dist;
    changed();
    return Object.entries(dist).map(([name, reroutePercentage]) => ({ actionHostName: `${site.name}-${name}.azurewebsites.net`, name, reroutePercentage }));
  },
});

register({
  path: 'webapp traffic-routing clear',
  summary: 'Envía todo el tráfico a producción.',
  args: siteArgs,
  run(a, ctx) {
    const site = getRes(ctx, a, T_SITE);
    site.data!.routing = {};
    changed();
    return [];
  },
});

// ---------------------------------------------------------------- logs e identidad

register({
  path: 'webapp log tail',
  summary: 'Muestra en directo los registros de la aplicación (Ctrl+C para salir).',
  args: [...siteArgs, slotArg],
  async run(a, ctx) {
    const site = siteArg(ctx, a);
    authorize(ctx.principal, `${site.type}/read`, site.id);
    ctx.io.out(`${nowIso()}  Welcome, you are now connected to log-streaming service.\n`);
    let seen = Math.max(0, (site.data?.logs ?? []).length - 15);
    for (;;) {
      const logs: string[] = getSite(site.id).data?.logs ?? [];
      for (; seen < logs.length; seen++) ctx.io.out(logs[seen] + '\n');
      await delay(800, ctx.io);
    }
  },
});

register({
  path: 'webapp log config',
  summary: 'Configura el registro de la aplicación y del servidor web.',
  args: [...siteArgs, slotArg, { name: 'application_logging', opts: ['--application-logging'], help: 'Registro de aplicación.', choices: ['azureblobstorage', 'filesystem', 'off'] }, { name: 'web_server_logging', opts: ['--web-server-logging'], help: 'Registro del servidor web.', choices: ['filesystem', 'off'] }, { name: 'level', opts: ['--level'], help: 'Nivel.', choices: ['error', 'warning', 'information', 'verbose'] }, { name: 'docker_container_logging', opts: ['--docker-container-logging'], help: 'Registro de contenedor.', choices: ['filesystem', 'off'] }],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    site.data!.logConfig = { application: a.application_logging, webServer: a.web_server_logging, level: a.level };
    changed();
    return { applicationLogs: { fileSystem: { level: a.level ?? 'Information' } }, httpLogs: { fileSystem: { enabled: a.web_server_logging === 'filesystem', retentionInDays: 3, retentionInMb: 100 } }, id: `${site.id}/config/logs`, name: 'logs' };
  },
});

register({
  path: 'webapp identity assign',
  summary: 'Asigna una identidad administrada a la aplicación web.',
  args: [...siteArgs, slotArg, { name: 'role', opts: ['--role'], help: 'Rol a asignar.' }, { name: 'scope', opts: ['--scope'], help: 'Ámbito del rol.' }, { name: 'identities', opts: ['--identities'], help: 'Identidades ([system] o IDs de identidades asignadas por el usuario).', type: 'list' }],
  examples: [{ title: 'Habilitar la identidad y darle acceso a secretos de Key Vault.', cmd: 'az webapp identity assign -g rg-lab -n app-lab --role "Key Vault Secrets User" --scope $(az keyvault show -n kv-lab --query id -o tsv)' }],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    const userIds = (a.identities ?? []).filter((x: string) => x !== '[system]');
    patchResource(site.id, (r) => {
      const req: any = { type: userIds.length && (a.identities ?? []).includes('[system]') ? 'SystemAssigned, UserAssigned' : userIds.length ? 'UserAssigned' : 'SystemAssigned', userAssignedIdentities: Object.fromEntries(userIds.map((id: string) => [id, {}])) };
      r.identity = resolveIdentity(getState(), req, r.identity, r.name, r.id);
    }, { principal: ctx.principal, opName: 'Asignar identidad administrada' });
    if (a.role && a.scope && site.identity?.principalId) createRoleAssignment({ assignee: site.identity.principalId, role: a.role, scope: a.scope }, ctx.principal);
    return { principalId: site.identity?.principalId ?? null, tenantId: site.identity?.tenantId ?? null, type: site.identity?.type, userAssignedIdentities: site.identity?.userAssignedIdentities ?? null };
  },
});

register({
  path: 'webapp identity show',
  summary: 'Muestra la identidad administrada.',
  args: [...siteArgs, slotArg],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    return site.identity ? { principalId: site.identity.principalId ?? null, tenantId: site.identity.tenantId ?? null, type: site.identity.type, userAssignedIdentities: site.identity.userAssignedIdentities ?? null } : undefined;
  },
});

register({
  path: 'webapp identity remove',
  summary: 'Quita la identidad administrada.',
  args: [...siteArgs, slotArg],
  run(a, ctx) {
    const site = siteArg(ctx, a);
    patchResource(site.id, (r) => (r.identity = resolveIdentity(getState(), { type: 'None' }, r.identity, r.name, r.id)), { principal: ctx.principal });
    return undefined;
  },
});

// ---------------------------------------------------------------- functionapp

register({
  path: 'functionapp create',
  summary: 'Crea una aplicación de funciones.',
  args: [
    A.rg(),
    A.name('Nombre de la aplicación de funciones (único en Azure).'),
    { name: 'storage_account', opts: ['--storage-account', '-s'], help: 'Cuenta de almacenamiento (obligatoria para Functions).', required: true },
    { name: 'consumption_plan_location', opts: ['--consumption-plan-location', '-c'], help: 'Región del plan de consumo (se crea automáticamente).' },
    { name: 'flexconsumption_location', opts: ['--flexconsumption-location'], help: 'Región del plan Flex Consumption.' },
    { name: 'plan', opts: ['--plan', '-p'], help: 'Plan existente (Premium o dedicado).' },
    { name: 'runtime', opts: ['--runtime'], help: 'Runtime.', choices: ['node', 'python', 'dotnet-isolated', 'java', 'powershell', 'custom'] },
    { name: 'runtime_version', opts: ['--runtime-version'], help: 'Versión del runtime.' },
    { name: 'functions_version', opts: ['--functions-version'], help: 'Versión de Functions.', default: '4' },
    { name: 'os_type', opts: ['--os-type'], help: 'Sistema operativo.', choices: ['Linux', 'Windows'], default: 'Linux' },
    { name: 'assign_identity', opts: ['--assign-identity'], help: 'Asigna identidad.', type: 'list' },
    A.tags(),
  ],
  examples: [{ title: 'Function app de consumo en Node.', cmd: 'az functionapp create -g rg-lab -n func-lab-ana --storage-account stlabana --consumption-plan-location westeurope --runtime node --runtime-version 20 --functions-version 4' }],
  table: siteTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const st = getState().resources.find((r) => ciEq(r.type, 'Microsoft.Storage/storageAccounts') && ciEq(r.name, a.storage_account) && r.subscriptionId === ctx.subscriptionId);
    if (!st) throw new ArmError('ResourceNotFound', `Storage account '${a.storage_account}' not found.`, 404, 'Azure Functions necesita una cuenta de almacenamiento: créala antes con az storage account create.');
    let pid: string;
    const loc = a.consumption_plan_location ?? a.flexconsumption_location;
    if (a.plan) pid = planId(ctx, a.plan, rg.name);
    else if (loc) {
      const l = findLocation(loc);
      if (!l) throw cliError(`Location '${loc}' is invalid.`);
      const name = `${l.displayName.replace(/\s/g, '')}${a.os_type === 'Linux' ? 'Linux' : ''}DynamicPlan`;
      const existing = findResource(resourceId(ctx.subscriptionId, rg.name, T_PLAN, name));
      pid = existing?.id ?? (await putResource({ type: T_PLAN, name, location: l.name, kind: a.os_type === 'Linux' ? 'functionapp,linux' : 'functionapp', sku: { name: a.flexconsumption_location ? 'EP1' : 'Y1' }, properties: { reserved: a.os_type === 'Linux' } }, rg.name, op(ctx))).id;
    } else throw cliError('usage error: --plan NAME_OR_ID | --consumption-plan-location LOCATION | --flexconsumption-location LOCATION', undefined, true);
    const plan = findResource(pid)!;
    const rt = a.runtime ?? 'node';
    const fxMap: Record<string, string> = { node: `NODE|${a.runtime_version ?? '20'}`, python: `PYTHON|${a.runtime_version ?? '3.11'}`, 'dotnet-isolated': `DOTNET-ISOLATED|${a.runtime_version ?? '8.0'}`, java: `JAVA|${a.runtime_version ?? '17'}`, powershell: `POWERSHELL|${a.runtime_version ?? '7.4'}`, custom: '' };
    const key = st.data?.keys?.[0]?.value ?? '';
    const site = await putResource(
      {
        type: T_SITE,
        name: a.name,
        location: plan.location,
        tags: a.tags,
        kind: a.os_type === 'Linux' ? 'functionapp,linux' : 'functionapp',
        identity: a.assign_identity ? { type: 'SystemAssigned' } : undefined,
        properties: {
          serverFarmId: pid,
          siteConfig: {
            linuxFxVersion: '',
            alwaysOn: false,
            appSettings: [
              { name: 'FUNCTIONS_EXTENSION_VERSION', value: `~${a.functions_version}` },
              { name: 'FUNCTIONS_WORKER_RUNTIME', value: rt },
              { name: 'AzureWebJobsStorage', value: `DefaultEndpointsProtocol=https;EndpointSuffix=core.windows.net;AccountName=${st.name};AccountKey=${key}` },
            ],
          },
        },
      },
      rg.name,
      op(ctx),
    );
    site.data!.functionsRuntime = fxMap[rt];
    ctx.warn(`Application Insights "${a.name}" was not created automatically in the simulator. You can create it with: az monitor app-insights component create`);
    return siteJson(site);
  },
});

register({
  path: 'functionapp list',
  summary: 'Lista las aplicaciones de funciones.',
  args: [A.rg(false)],
  table: siteTable,
  run: (a, ctx) => listInSub(ctx, T_SITE, a.resource_group).filter((s) => String(s.kind).includes('functionapp')).map(siteJson),
});

register({
  path: 'functionapp show',
  summary: 'Muestra una aplicación de funciones.',
  args: siteArgs,
  run: (a, ctx) => siteJson(getRes(ctx, a, T_SITE)),
});

register({
  path: 'functionapp delete',
  summary: 'Elimina una aplicación de funciones.',
  args: siteArgs,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_SITE).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'functionapp config appsettings set',
  summary: 'Establece la configuración de la aplicación de funciones.',
  args: [...siteArgs, { name: 'settings', opts: ['--settings'], help: 'Pares CLAVE=VALOR.', type: 'kv', required: true }],
  run(a, ctx) {
    return setAppSettings(getRes(ctx, a, T_SITE).id, a.settings, {}, ctx.principal);
  },
});

register({
  path: 'functionapp config appsettings list',
  summary: 'Lista la configuración de la aplicación de funciones.',
  args: siteArgs,
  table: (r: any[]) => r.map((x) => ({ Name: x.name, Value: x.value, SlotSetting: x.slotSetting })),
  run: (a, ctx) => appSettingsList(getRes(ctx, a, T_SITE)),
});

register({
  path: 'functionapp deployment source config-zip',
  summary: 'Despliega un zip en la aplicación de funciones.',
  args: [...siteArgs, { name: 'src', opts: ['--src'], help: 'Ruta del zip.', required: true }, { name: 'build_remote', opts: ['--build-remote'], help: 'Compilación remota.', type: 'bool' }],
  longRunning: true,
  async run(a, ctx) {
    const site = getRes(ctx, a, T_SITE);
    return deployContent(site.id, readPackage(ctx, a.src, 'zip'), { principal: ctx.principal, deployer: 'ZipDeploy' });
  },
});

register({
  path: 'functionapp start',
  summary: 'Inicia la aplicación de funciones.',
  args: siteArgs,
  async run(a, ctx) {
    await setSiteState(getRes(ctx, a, T_SITE).id, 'Running', ctx.principal);
    return undefined;
  },
});

register({
  path: 'functionapp stop',
  summary: 'Detiene la aplicación de funciones.',
  args: siteArgs,
  async run(a, ctx) {
    await setSiteState(getRes(ctx, a, T_SITE).id, 'Stopped', ctx.principal);
    return undefined;
  },
});
