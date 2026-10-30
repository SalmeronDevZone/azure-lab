// Operaciones de App Service: estado, configuración, despliegues, ranuras y tráfico HTTP.
import type { PrincipalRef, Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, checkLocks, findResource, logActivity, notFound, provisionDelay } from '../arm';
import { ciEq, guid, nowIso, sleep } from '../util';
import { planOf, slotsOf } from '../providers/web';
import { appStartError, detectKind, renderApp, startupLog, type HttpResponse } from './appRuntime';
import { identityPrincipalIds } from '../providers/identity';
import { kvCanRead, findVault } from './keyvault';

export function getSite(id: string): Resource {
  const site = findResource(id);
  if (!site || !(ciEq(site.type, 'Microsoft.Web/sites') || ciEq(site.type, 'Microsoft.Web/sites/slots'))) throw notFound(id);
  return site;
}

export function findSiteByHost(host: string): Resource | undefined {
  const h = host.toLowerCase();
  return getState().resources.find((r) => (ciEq(r.type, 'Microsoft.Web/sites') || ciEq(r.type, 'Microsoft.Web/sites/slots')) && (r.properties.hostNames ?? []).some((x: string) => x.toLowerCase() === h));
}

function siteLog(site: Resource, line: string) {
  site.data!.logs = [...(site.data!.logs ?? []), `${new Date().toISOString()}  ${line}`].slice(-300);
}

export async function setSiteState(id: string, state: 'Running' | 'Stopped' | 'Restart', principal: PrincipalRef | null) {
  const s = getState();
  const site = getSite(id);
  const action = state === 'Running' ? 'start/action' : state === 'Stopped' ? 'stop/action' : 'restart/action';
  authorize(principal, `${site.type}/${action}`, site.id);
  checkLocks(site.id, 'write', s);
  if (state === 'Restart') {
    siteLog(site, 'Container restart requested');
    await sleep(provisionDelay(1200));
    site.properties.state = 'Running';
    siteLog(site, 'Site started');
  } else {
    site.properties.state = state;
    siteLog(site, state === 'Running' ? 'Site started' : 'Site stopped');
  }
  logActivity({ operationNameValue: `${site.type}/${action}`, operationName: state === 'Running' ? 'Iniciar aplicación web' : state === 'Stopped' ? 'Detener aplicación web' : 'Reiniciar aplicación web', status: 'Succeeded', resourceId: site.id, subscriptionId: site.subscriptionId, caller: principal?.name });
  changed();
}

export function appSettingsList(site: Resource) {
  const sticky: string[] = site.data?.stickySettings ?? [];
  return (site.properties.siteConfig?.appSettings ?? []).map((x: any) => ({ name: x.name, slotSetting: sticky.includes(x.name), value: x.value }));
}

export function setAppSettings(id: string, settings: Record<string, string>, slotSettings: Record<string, string>, principal: PrincipalRef | null) {
  const s = getState();
  const site = getSite(id);
  authorize(principal, `${site.type}/config/write`, site.id);
  checkLocks(site.id, 'write', s);
  const list: { name: string; value: string }[] = [...(site.properties.siteConfig.appSettings ?? [])];
  const all = { ...settings, ...slotSettings };
  for (const [k, v] of Object.entries(all)) {
    const i = list.findIndex((x) => x.name === k);
    if (i >= 0) list[i] = { name: k, value: v };
    else list.push({ name: k, value: v });
  }
  site.properties.siteConfig.appSettings = list;
  site.data!.stickySettings = [...new Set([...(site.data!.stickySettings ?? []), ...Object.keys(slotSettings)])];
  siteLog(site, `App settings updated: ${Object.keys(all).join(', ')} (la aplicación se reinicia)`);
  logActivity({ operationNameValue: `${site.type}/config/write`, operationName: 'Actualizar configuración de la aplicación', status: 'Succeeded', resourceId: site.id, subscriptionId: site.subscriptionId, caller: principal?.name });
  changed();
  return appSettingsList(site);
}

export function deleteAppSettings(id: string, names: string[], principal: PrincipalRef | null) {
  const s = getState();
  const site = getSite(id);
  authorize(principal, `${site.type}/config/write`, site.id);
  checkLocks(site.id, 'write', s);
  site.properties.siteConfig.appSettings = (site.properties.siteConfig.appSettings ?? []).filter((x: any) => !names.includes(x.name));
  site.data!.stickySettings = (site.data!.stickySettings ?? []).filter((x: string) => !names.includes(x));
  changed();
  return appSettingsList(site);
}

export function setSiteConfig(id: string, cfg: Record<string, any>, principal: PrincipalRef | null) {
  const s = getState();
  const site = getSite(id);
  authorize(principal, `${site.type}/config/write`, site.id);
  checkLocks(site.id, 'write', s);
  const plan = planOf(site, s);
  if (cfg.alwaysOn === true && plan?.sku?.tier === 'Free') {
    throw new ArmError('Conflict', 'There was a conflict. AlwaysOn cannot be set for this site as the plan does not allow it.', 409);
  }
  Object.assign(site.properties.siteConfig, cfg);
  logActivity({ operationNameValue: `${site.type}/config/write`, operationName: 'Actualizar configuración general', status: 'Succeeded', resourceId: site.id, subscriptionId: site.subscriptionId, caller: principal?.name });
  changed();
  return site.properties.siteConfig;
}

export interface DeployResult {
  id: string;
  status: number;
  message: string;
  complete: boolean;
  active: boolean;
  author: string;
  deployer: string;
  received_time: string;
  start_time: string;
  end_time: string;
  site_name: string;
}

export async function deployContent(id: string, files: Record<string, string>, opts: { principal: PrincipalRef | null; deployer: string; message?: string; kind?: string }): Promise<DeployResult> {
  const s = getState();
  const site = getSite(id);
  authorize(opts.principal, `${site.type}/publish/action`, site.id);
  checkLocks(site.id, 'write', s);
  const start = nowIso();
  const kind = detectKind(files);
  const runtime: string = site.properties.siteConfig?.linuxFxVersion ?? '';
  if (kind === 'node' && runtime && !runtime.toUpperCase().startsWith('NODE')) siteLog(site, `ADVERTENCIA: se ha desplegado una app Node.js en un runtime ${runtime}`);
  if (kind === 'python' && runtime && !runtime.toUpperCase().startsWith('PYTHON')) siteLog(site, `ADVERTENCIA: se ha desplegado una app Python en un runtime ${runtime}`);
  siteLog(site, `Deployment started by ${opts.deployer}`);
  if (files['package.json']) siteLog(site, 'Oryx: detected Node.js app, running npm install --production');
  if (files['requirements.txt']) siteLog(site, 'Oryx: detected Python app, running pip install -r requirements.txt');
  await sleep(provisionDelay(1800));
  const prev = site.data!.content ?? { version: 0 };
  site.data!.content = { files: { ...files }, version: (prev.version ?? 0) + 1, deployedAt: nowIso(), by: opts.deployer, kind };
  const err = appStartError({ files, env: envFor(site) });
  for (const l of startupLog({ files, env: envFor(site) })) siteLog(site, l);
  if (err) siteLog(site, 'Container exited with error. Site will return 503 until the issue is fixed.');
  const depId = guid().replace(/-/g, '');
  const result: DeployResult = {
    id: depId,
    status: 4,
    message: opts.message ?? 'Created via a push deployment',
    complete: true,
    active: true,
    author: 'N/A',
    deployer: opts.deployer,
    received_time: start,
    start_time: start,
    end_time: nowIso(),
    site_name: site.name,
  };
  site.data!.deployments = [result, ...(site.data!.deployments ?? []).map((d: any) => ({ ...d, active: false }))].slice(0, 20);
  logActivity({ operationNameValue: `${site.type}/publish/action`, operationName: 'Publicar contenido (despliegue)', status: 'Succeeded', resourceId: site.id, subscriptionId: site.subscriptionId, caller: opts.principal?.name });
  changed();
  return result;
}

export async function swapSlots(siteId: string, slot: string, target: string, principal: PrincipalRef | null) {
  const s = getState();
  const site = getSite(siteId);
  authorize(principal, 'Microsoft.Web/sites/slots/slotsswap/action', site.id);
  checkLocks(site.id, 'write', s);
  const get = (name: string) => (ciEq(name, 'production') ? site : slotsOf(site, s).find((x) => ciEq(x.name.split('/')[1], name)));
  const a = get(slot);
  const b = get(target);
  if (!a) throw new ArmError('NotFound', `The slot '${slot}' was not found for site '${site.name}'.`, 404);
  if (!b) throw new ArmError('NotFound', `The slot '${target}' was not found for site '${site.name}'.`, 404);
  if (a === b) throw new ArmError('BadRequest', 'Source and target slots must be different.');
  await sleep(provisionDelay(2500));
  // intercambiar contenido y configuración no "pegajosa" (sticky)
  const tmp = a.data!.content;
  a.data!.content = b.data!.content;
  b.data!.content = tmp;
  const stickyA: string[] = a.data!.stickySettings ?? [];
  const stickyB: string[] = b.data!.stickySettings ?? [];
  const aSet: any[] = a.properties.siteConfig.appSettings ?? [];
  const bSet: any[] = b.properties.siteConfig.appSettings ?? [];
  const aKeep = aSet.filter((x) => stickyA.includes(x.name));
  const bKeep = bSet.filter((x) => stickyB.includes(x.name));
  const aMove = aSet.filter((x) => !stickyA.includes(x.name));
  const bMove = bSet.filter((x) => !stickyB.includes(x.name));
  a.properties.siteConfig.appSettings = [...aKeep, ...bMove.filter((x) => !aKeep.some((k) => k.name === x.name))];
  b.properties.siteConfig.appSettings = [...bKeep, ...aMove.filter((x) => !bKeep.some((k) => k.name === x.name))];
  const fx = a.properties.siteConfig.linuxFxVersion;
  a.properties.siteConfig.linuxFxVersion = b.properties.siteConfig.linuxFxVersion;
  b.properties.siteConfig.linuxFxVersion = fx;
  site.properties.slotSwapStatus = { timestampUtc: nowIso(), sourceSlotName: slot, destinationSlotName: target };
  siteLog(site, `Swap completed: ${slot} <-> ${target}`);
  logActivity({ operationNameValue: 'Microsoft.Web/sites/slots/slotsswap/action', operationName: `Intercambiar ranuras (${slot} ↔ ${target})`, status: 'Succeeded', resourceId: site.id, subscriptionId: site.subscriptionId, caller: principal?.name });
  changed();
}

/** Resuelve referencias de Key Vault en la configuración usando la identidad administrada de la app. */
export function resolveSetting(site: Resource, value: string): { value: string; resolved: boolean; error?: string } {
  const m = /^@Microsoft\.KeyVault\((.*)\)$/i.exec(value?.trim() ?? '');
  if (!m) return { value, resolved: true };
  const inner = m[1];
  let vaultName: string | undefined;
  let secretName: string | undefined;
  const uri = /SecretUri=https:\/\/([^.]+)\.vault\.azure\.net\/secrets\/([^/;)]+)/i.exec(inner);
  if (uri) {
    vaultName = uri[1];
    secretName = uri[2];
  } else {
    vaultName = /VaultName=([^;]+)/i.exec(inner)?.[1];
    secretName = /SecretName=([^;]+)/i.exec(inner)?.[1];
  }
  if (!vaultName || !secretName) return { value, resolved: false, error: 'Formato de referencia no válido' };
  const s = getState();
  const vault = findVault(vaultName, s);
  if (!vault) return { value, resolved: false, error: `Almacén "${vaultName}" no encontrado` };
  const ids = identityPrincipalIds(site);
  if (!ids.length) return { value, resolved: false, error: 'MSINotEnabled: la aplicación no tiene identidad administrada' };
  const ok = ids.some((oid) => kvCanRead(vault, { type: 'ServicePrincipal', objectId: oid, name: oid, displayName: site.name }, s));
  if (!ok) return { value, resolved: false, error: 'AccessToKeyVaultDenied: la identidad de la app no tiene permiso para leer secretos' };
  const sec = vault.data?.secrets?.[secretName];
  if (!sec || sec.deleted) return { value, resolved: false, error: `SecretNotFound: ${secretName}` };
  const v = sec.versions[sec.versions.length - 1];
  s.events.push({ t: Date.now(), kind: 'secretGet', resourceId: vault.id, caller: site.name, status: 200, detail: secretName });
  return { value: v.value, resolved: true };
}

export function envFor(site: Resource): Record<string, string> {
  const env: Record<string, string> = {
    WEBSITE_SITE_NAME: site.name.split('/')[0],
    WEBSITE_HOSTNAME: site.properties.defaultHostName,
    WEBSITE_RESOURCE_GROUP: site.resourceGroup,
    PORT: '8080',
    HOSTNAME: `${site.name.replace('/', '-')}-${site.id.length % 9}`,
  };
  for (const x of site.properties.siteConfig?.appSettings ?? []) env[x.name] = resolveSetting(site, x.value).value;
  return env;
}

const DEFAULT_PAGE = (name: string) =>
  `<!DOCTYPE html><html><head><title>Microsoft Azure App Service - Welcome</title></head><body><h1>Your web app is running and waiting for your content</h1><p>${name} está lista. Despliega tu código con <code>az webapp deploy</code>, desde un pipeline o con Git.</p></body></html>`;

export function siteHttp(site: Resource, path: string, https: boolean): HttpResponse {
  const s = getState();
  const started = performance.now?.() ?? Date.now();
  let res: HttpResponse;
  if (!https && site.properties.httpsOnly) {
    res = { status: 301, body: '', contentType: 'text/html', headers: { Location: `https://${site.properties.defaultHostName}${path}` } };
  } else if (site.properties.state !== 'Running') {
    res = { status: 403, body: '<h1>Error 403 - This web app is stopped.</h1><p>The web app you have attempted to reach is currently stopped and does not accept any requests.</p>', contentType: 'text/html' };
  } else if (site.properties.publicNetworkAccess === 'Disabled') {
    res = { status: 403, body: '<h1>Error 403 - Forbidden</h1><p>The web app you have attempted to reach has blocked your access.</p>', contentType: 'text/html' };
  } else {
    const content = site.data?.content;
    if (!content?.version) res = { status: 200, body: DEFAULT_PAGE(site.name), contentType: 'text/html' };
    else {
      const env = envFor(site);
      const pkg = { files: content.files ?? {}, env, publicImage: content.publicImage ?? null };
      const err = appStartError(pkg);
      if (err) {
        res = { status: 503, body: ':( Application Error\nIf you are the application administrator, you can access the diagnostic resources.', contentType: 'text/html' };
        siteLog(site, err.split('\n')[0]);
      } else res = renderApp(pkg, path, env);
    }
  }
  const dur = Math.round(20 + Math.random() * 80 + ((performance.now?.() ?? Date.now()) - started));
  s.events.push({ t: Date.now(), kind: 'http', resourceId: site.id, status: res.status, path, durationMs: dur, detail: https ? 'https' : 'http' });
  siteLog(site, `${https ? 'HTTPS' : 'HTTP'} GET ${path} ${res.status} ${dur}ms`);
  changed();
  return res;
}

export function setHttpsOnly(id: string, value: boolean, principal: PrincipalRef | null) {
  const site = getSite(id);
  authorize(principal, `${site.type}/write`, site.id);
  checkLocks(site.id, 'write');
  site.properties.httpsOnly = value;
  changed();
}
