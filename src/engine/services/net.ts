// Red simulada: resolución DNS y peticiones HTTP (lo que usa curl dentro del Cloud Shell, las VMs y los pipelines).
import type { CloudState, DockerContainer, Resource } from '../types';
import { getState, changed } from '../store';
import { ciEq, guid, isValidIp } from '../util';
import { findSiteByHost, siteHttp } from './web';
import { findAccount, validateSas, type ContainerItem } from './storage';
import { renderApp, renderStaticSite, type HttpResponse, appListenPort } from './appRuntime';
import { CLOUD_SHELL_IP, inboundAllowed, evaluateNsg, findSubnet, peeringBetween, vnetOfSubnetId } from '../providers/network';
import { vmNetworkInfo, vmPowerState } from '../providers/compute';
import { serviceHttp } from './kube';
import { guestFs } from './compute';
import { findPublicImage } from '../catalog';
import { lookupRecord } from '../providers/dns';

export interface FetchResult {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  hint?: string;
  resolvedIp?: string;
}

const fail = (error: string, hint?: string): FetchResult => ({ ok: false, error, hint });
const resp = (r: HttpResponse, extra: Record<string, string> = {}): FetchResult => ({ ok: true, status: r.status, body: r.body, headers: { 'Content-Type': r.contentType, ...(r.headers ?? {}), ...extra } });

function xmlError(code: string, message: string, status: number): FetchResult {
  return {
    ok: true,
    status,
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message}\nRequestId:${guid()}\nTime:${new Date().toISOString()}</Message></Error>`,
  };
}

export function parseUrl(raw: string): { scheme: string; host: string; port: number; path: string; query: string } | null {
  let u = raw.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
  try {
    const url = new URL(u);
    const scheme = url.protocol.replace(':', '');
    return { scheme, host: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : scheme === 'https' ? 443 : 80, path: decodeURIComponent(url.pathname || '/'), query: url.search.replace(/^\?/, '') };
  } catch {
    return null;
  }
}

/** Resolución DNS simulada (para nslookup / dig / curl). */
export function resolveDns(host: string, s: CloudState = getState(), depth = 0): { ip: string; cname?: string } | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isValidIp(h)) return { ip: h };
  if (h === 'localhost') return { ip: '127.0.0.1' };
  // Zonas de Azure DNS hospedadas en la nube simulada (registros A/AAAA/CNAME).
  const custom = lookupRecord(h);
  if (custom === 'nx') return null;
  if (custom) {
    if (custom.type !== 'CNAME') return { ip: custom.values[0] };
    const target = custom.values[0].replace(/\.$/, '').toLowerCase();
    const r = depth < 8 ? resolveDns(target, s, depth + 1) : null;
    return r ? { ip: r.ip, cname: target } : null;
  }
  const site = /\.azurewebsites\.net$/.test(h) ? findSiteByHost(h) : undefined;
  if (site) return { ip: site.properties.outboundIpAddresses?.split(',')[0] ?? '20.105.232.20', cname: `waws-prod-am2-${site.name.length}.sip.azurewebsites.windows.net` };
  let m = /^([a-z0-9]+)\.(blob|file|queue|table|dfs)\.core\.windows\.net$/.exec(h);
  if (m && s.resources.some((r) => ciEq(r.type, 'Microsoft.Storage/storageAccounts') && ciEq(r.name, m![1]))) return { ip: '20.60.' + (m[1].length % 200) + '.36', cname: `blob.ams07prdstr${m[1].length % 20}a.store.core.windows.net` };
  m = /^([a-z0-9]+)\.z\d+\.web\.core\.windows\.net$/.exec(h);
  if (m && s.resources.some((r) => ciEq(r.type, 'Microsoft.Storage/storageAccounts') && ciEq(r.name, m![1]))) return { ip: '20.209.' + (m[1].length % 200) + '.1' };
  const pip = s.resources.find((r) => ciEq(r.type, 'Microsoft.Network/publicIPAddresses') && ciEq(r.properties.dnsSettings?.fqdn, h));
  if (pip) return { ip: pip.properties.ipAddress };
  const aci = s.resources.find((r) => ciEq(r.type, 'Microsoft.ContainerInstance/containerGroups') && ciEq(r.properties.ipAddress?.fqdn, h));
  if (aci) return { ip: aci.properties.ipAddress.ip };
  m = /^([a-z0-9-]+)\.vault\.azure\.net$/.exec(h);
  if (m && s.resources.some((r) => ciEq(r.type, 'Microsoft.KeyVault/vaults') && ciEq(r.name, m![1]))) return { ip: '52.236.189.' + (m[1].length % 200), cname: `azkms-prod-weu-b.westeurope.cloudapp.azure.com` };
  m = /^([a-z0-9-]+)\.database\.windows\.net$/.exec(h);
  if (m && s.resources.some((r) => ciEq(r.type, 'Microsoft.Sql/servers') && ciEq(r.name, m![1]))) return { ip: '20.61.99.192', cname: `${m[1]}.privatelink.database.windows.net` };
  m = /^([a-z0-9]+)\.azurecr\.io$/.exec(h);
  if (m && s.resources.some((r) => ciEq(r.type, 'Microsoft.ContainerRegistry/registries') && ciEq(r.name, m![1]))) return { ip: '51.124.' + (m[1].length % 200) + '.9' };
  const aks = s.resources.find((r) => ciEq(r.type, 'Microsoft.ContainerService/managedClusters') && ciEq(r.properties.fqdn, h));
  if (aks) return { ip: '4.175.' + (aks.name.length % 200) + '.12' };
  if (['example.com', 'www.example.com', 'ifconfig.me', 'api.ipify.org', 'www.microsoft.com', 'microsoft.com', 'github.com', 'www.google.com', 'google.com', 'management.azure.com', 'login.microsoftonline.com', 'learn.microsoft.com', 'registry.npmjs.org', 'mcr.microsoft.com', 'dev.azure.com', 'aka.ms'].includes(h)) {
    return { ip: '93.184.215.' + (h.length % 200) };
  }
  return null;
}

function guestHttp(vm: Resource, port: number, path: string): FetchResult {
  const services = vm.data?.services ?? {};
  const web = services.nginx === 'active' ? 'nginx' : services.apache2 === 'active' ? 'apache2' : services.W3SVC === 'running' ? 'iis' : services.app === 'active' ? 'app' : null;
  if (port === 22 && (services.ssh === 'active' || vm.data?.osType === 'Linux')) return fail('curl: (1) Received HTTP/0.9 when not allowed');
  if (web === 'app' && port === (vm.data?.appPort ?? 3000)) {
    const files = vm.data?.appFiles ?? {};
    return resp(renderApp({ files, env: { HOSTNAME: vm.name } }, path));
  }
  if (!web || port !== 80) return fail(`curl: (7) Failed to connect to ${vmNetworkInfo(vm, getState()).publicIp ?? 'host'} port ${port} after 32 ms: Couldn't connect to server`, web ? undefined : 'La conexión llega a la VM pero ningún proceso escucha en ese puerto. ¿Has instalado e iniciado un servidor web (nginx/apache)?');
  const fs = guestFs(vm);
  const html = (fs.c.var as any)?.c?.www?.c?.html?.c;
  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
  const f = html?.[rel] ?? (path === '/' ? html?.['index.nginx-debian.html'] ?? html?.['index.html'] : undefined);
  if (web === 'iis') return resp({ status: 200, body: '<!DOCTYPE html><html><head><title>IIS Windows Server</title></head><body><img src="iisstart.png" alt="IIS"></body></html>', contentType: 'text/html' }, { Server: 'Microsoft-IIS/10.0' });
  if (!f || f.t !== 'f') return resp({ status: 404, body: `<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>${web === 'nginx' ? 'nginx/1.18.0 (Ubuntu)' : 'Apache/2.4.52 (Ubuntu)'}</center></body></html>`, contentType: 'text/html' });
  return resp({ status: 200, body: f.d, contentType: 'text/html' }, { Server: web === 'nginx' ? 'nginx/1.18.0 (Ubuntu)' : 'Apache/2.4.52 (Ubuntu)' });
}

function vmHttp(vm: Resource, port: number, path: string, from: { ip: string; tag: 'Internet' | 'VirtualNetwork'; vm?: Resource | null }): FetchResult {
  const s = getState();
  const ps = vmPowerState(vm);
  const target = vmNetworkInfo(vm, s);
  if (ps !== 'running') {
    return fail(`curl: (28) Failed to connect to ${target.publicIp ?? target.privateIp} port ${port} after 21046 ms: Timeout was reached`, `La VM "${vm.name}" no está en ejecución (${ps}).`);
  }
  if (!target.nic) return fail('curl: (28) Connection timed out');
  if (from.tag === 'Internet') {
    const d = inboundAllowed(target.nic, port, 'Tcp', from.ip, s);
    if (!d.allowed) return fail(`curl: (28) Failed to connect to ${target.publicIp} port ${port} after 21034 ms: Timeout was reached`, d.reason);
  } else {
    const subnetId = target.nic.properties.ipConfigurations?.[0]?.properties?.subnet?.id;
    const sn = subnetId ? findSubnet(subnetId, s) : undefined;
    const nsgIds = [sn?.subnet.properties.networkSecurityGroup?.id, target.nic.properties.networkSecurityGroup?.id].filter(Boolean) as string[];
    for (const id of nsgIds) {
      const nsg = s.resources.find((r) => ciEq(r.id, id));
      if (!nsg) continue;
      const d = evaluateNsg(nsg, port, 'Tcp', from.ip, 'VirtualNetwork', 'nic');
      if (!d.allowed) return fail(`curl: (28) Failed to connect to ${target.privateIp} port ${port} after 21034 ms: Timeout was reached`, `Bloqueado por la regla "${d.rule}" del NSG "${nsg.name}".`);
    }
  }
  return guestHttp(vm, port, path);
}

function vmByIp(ip: string, s: CloudState, privateOnly = false): Resource | undefined {
  return s.resources.find((r) => {
    if (!ciEq(r.type, 'Microsoft.Compute/virtualMachines')) return false;
    const n = vmNetworkInfo(r, s);
    return privateOnly ? n.privateIp === ip : n.publicIp === ip;
  });
}

function blobHttp(account: string, path: string, query: string): FetchResult {
  let acct: Resource;
  try {
    acct = findAccount(account);
  } catch {
    return fail(`curl: (6) Could not resolve host: ${account}.blob.core.windows.net`);
  }
  const parts = path.replace(/^\//, '').split('/');
  const container = parts.shift() ?? '';
  const blob = parts.join('/');
  const params = new URLSearchParams(query);
  const hasSas = params.has('sig');
  const c: ContainerItem | undefined = acct.data?.containers?.[container];
  if (!container) return xmlError('InvalidQueryParameterValue', 'Value for one of the query parameters specified in the request URI is invalid.', 400);
  if (hasSas) {
    try {
      validateSas(acct, query, blob ? 'read' : 'list', container);
    } catch (e: any) {
      return xmlError(e.code ?? 'AuthenticationFailed', e.message, 403);
    }
  } else {
    if (!c) return xmlError('ResourceNotFound', 'The specified resource does not exist.', 404);
    if (c.publicAccess !== 'off' && !acct.properties.allowBlobPublicAccess) return xmlError('PublicAccessNotPermitted', 'Public access is not permitted on this storage account.', 409);
    if (c.publicAccess === 'off' || (!blob && c.publicAccess !== 'container')) return xmlError('ResourceNotFound', 'The specified resource does not exist.', 404);
  }
  if (!c) return xmlError('ContainerNotFound', 'The specified container does not exist.', 404);
  if (!blob) {
    if (params.get('comp') !== 'list') return xmlError('InvalidQueryParameterValue', 'Value for one of the query parameters specified in the request URI is invalid.', 400);
    const items = Object.entries(c.blobs).map(([n, b]) => `<Blob><Name>${n}</Name><Properties><Content-Length>${b.size}</Content-Length><Content-Type>${b.contentType}</Content-Type><AccessTier>${b.tier}</AccessTier></Properties></Blob>`).join('');
    return { ok: true, status: 200, headers: { 'Content-Type': 'application/xml' }, body: `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ContainerName="${c.name}"><Blobs>${items}</Blobs></EnumerationResults>` };
  }
  const b = c.blobs[blob];
  if (!b) return xmlError('BlobNotFound', 'The specified blob does not exist.', 404);
  if (b.tier === 'Archive') return xmlError('BlobArchived', 'This operation is not permitted on an archived blob.', 409);
  s_event(acct, `GetBlob ${container}/${blob}`);
  return { ok: true, status: 200, headers: { 'Content-Type': b.contentType, 'x-ms-blob-type': 'BlockBlob', 'x-ms-access-tier': b.tier, ETag: b.etag }, body: b.content };
}

function s_event(acct: Resource, detail: string) {
  const s = getState();
  s.events.push({ t: Date.now(), kind: 'blobOp', resourceId: acct.id, status: 200, detail, caller: 'anonymous' });
  changed();
}

function staticSiteHttp(account: string, path: string): FetchResult {
  let acct: Resource;
  try {
    acct = findAccount(account);
  } catch {
    return fail(`curl: (6) Could not resolve host: ${account}.z6.web.core.windows.net`);
  }
  const sw = acct.data?.staticWebsite;
  if (!sw?.enabled) return { ok: true, status: 400, headers: { 'Content-Type': 'text/html' }, body: '<h1>The requested content does not exist.</h1><p>HttpStatusCode: 400</p><p>ErrorCode: WebsiteDisabled</p>' };
  const web: ContainerItem | undefined = acct.data?.containers?.['$web'];
  const files: Record<string, string> = {};
  for (const [n, b] of Object.entries(web?.blobs ?? {})) files[n] = b.content;
  const index = sw.indexDocument ?? 'index.html';
  const p = path === '/' || path.endsWith('/') ? path + index : path;
  const r = renderStaticSite(files, p, sw.errorDocument404Path);
  if (r.status === 404 && !sw.errorDocument404Path) return { ok: true, status: 404, headers: { 'Content-Type': 'text/html' }, body: '<h1>The requested content does not exist.</h1><p>HttpStatusCode: 404</p><p>ErrorCode: WebContentNotFound</p>' };
  s_event(acct, `GetWebContent $web${p}`);
  return resp(r);
}

function aciHttp(cg: Resource, port: number, path: string): FetchResult {
  if (cg.data?.state === 'Stopped') return fail(`curl: (28) Failed to connect to ${cg.properties.ipAddress?.ip} port ${port}: Timeout was reached`, 'El grupo de contenedores está detenido.');
  const ports = (cg.properties.ipAddress?.ports ?? []).map((p: any) => p.port);
  if (!ports.includes(port)) return fail(`curl: (28) Failed to connect to ${cg.properties.ipAddress?.ip} port ${port}: Timeout was reached`, `El grupo de contenedores sólo expone los puertos: ${ports.join(', ') || 'ninguno'}.`);
  const c = cg.properties.containers[0];
  const pkg = cg.data?.pkgs?.[c.name] ?? { files: {}, publicImage: findPublicImage(c.properties.image)?.name };
  const env: Record<string, string> = {};
  for (const e of c.properties.environmentVariables ?? []) env[e.name] = e.value ?? e.secureValue ?? '';
  const full = { ...pkg, env: { ...(pkg.env ?? {}), ...env, HOSTNAME: cg.name } };
  if (appListenPort(full) !== port) return fail(`curl: (52) Empty reply from server`, `La aplicación del contenedor escucha en el puerto ${appListenPort(full)}, no en el ${port}.`);
  return resp(renderApp(full, path, env));
}

function dockerHttp(port: number, path: string): FetchResult {
  const s = getState();
  const c: DockerContainer | undefined = s.docker.containers.find((x) => x.status === 'running' && x.ports.some((p) => p.host === port));
  if (!c) return fail(`curl: (7) Failed to connect to localhost port ${port} after 0 ms: Couldn't connect to server`);
  const img = s.docker.images.find((i) => `${i.repository}:${i.tag}` === c.image || i.id.startsWith(c.image));
  const mapping = c.ports.find((p) => p.host === port)!;
  const pub = findPublicImage(c.image);
  const pkg = img && Object.keys(img.files).length ? { files: img.files, env: { ...(img.env ?? {}), ...c.env } } : { files: {}, publicImage: pub?.name ?? img?.base ?? null, env: c.env };
  if (appListenPort(pkg as any) !== mapping.container) return fail('curl: (56) Recv failure: Connection reset by peer', `El contenedor publica el puerto ${mapping.container}, pero la app escucha en ${appListenPort(pkg as any)}.`);
  return resp(renderApp(pkg as any, path, c.env));
}

/** Realiza una petición HTTP GET simulada. */
export function httpGet(rawUrl: string, opts: { fromVm?: Resource | null } = {}): FetchResult {
  const s = getState();
  const u = parseUrl(rawUrl);
  if (!u) return fail(`curl: (3) URL using bad/illegal format or missing URL`);
  const { host, port, path, query, scheme } = u;
  const https = scheme === 'https';
  const sourceIp = opts.fromVm ? vmNetworkInfo(opts.fromVm, s).publicIp ?? '20.0.0.1' : CLOUD_SHELL_IP;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    if (opts.fromVm) return guestHttp(opts.fromVm, port, path);
    return dockerHttp(port, path);
  }
  if (host === 'ifconfig.me' || host === 'api.ipify.org' || host === 'icanhazip.com') return { ok: true, status: 200, headers: { 'Content-Type': 'text/plain' }, body: sourceIp };
  if (host === 'aka.ms') {
    if (/^\/InstallAzureCLIDeb\/?$/i.test(path)) return { ok: true, status: 200, headers: { 'Content-Type': 'text/x-sh' }, body: '#!/bin/bash\n# Instala Azure CLI en Debian/Ubuntu (versión simulada del script oficial)\napt-get update -qq\napt-get install -y azure-cli\n' };
    return { ok: true, status: 301, headers: { Location: 'https://learn.microsoft.com/' }, body: '' };
  }
  if (host === 'example.com' || host === 'www.example.com') return { ok: true, status: 200, headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p></body></html>' };
  if (host.endsWith('.scm.azurewebsites.net')) return { ok: true, status: 401, headers: { 'WWW-Authenticate': 'Basic realm="site"' }, body: '401 - Unauthorized: Access is denied due to invalid credentials.' };
  if (host.endsWith('.azurewebsites.net')) {
    let site = findSiteByHost(host);
    if (!site) return fail(`curl: (6) Could not resolve host: ${host}`);
    const routing: Record<string, number> = site.data?.routing ?? {};
    if (Object.keys(routing).length && ciEq(site.type, 'Microsoft.Web/sites')) {
      let roll = Math.random() * 100;
      for (const [slot, pct] of Object.entries(routing)) {
        roll -= pct;
        if (roll < 0) {
          const target = s.resources.find((r) => ciEq(r.type, 'Microsoft.Web/sites/slots') && ciEq(r.name, `${site!.name}/${slot}`));
          if (target) site = target;
          break;
        }
      }
    }
    return resp(siteHttp(site, path, https), { 'x-ms-routing-name': site.name.includes('/') ? site.name.split('/')[1] : 'self' });
  }
  let m = /^([a-z0-9]+)\.blob\.core\.windows\.net$/.exec(host);
  if (m) return blobHttp(m[1], path, query);
  m = /^([a-z0-9]+)\.z\d+\.web\.core\.windows\.net$/.exec(host);
  if (m) return staticSiteHttp(m[1], path);
  if (/\.vault\.azure\.net$/.test(host)) {
    if (!resolveDns(host, s)) return fail(`curl: (6) Could not resolve host: ${host}`);
    return { ok: true, status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer authorization="https://login.microsoftonline.com/..."' }, body: '{"error":{"code":"Unauthorized","message":"AKV10000: Request is missing a Bearer or PoP token."}}' };
  }
  if (/\.database\.windows\.net$/.test(host)) return fail('curl: (52) Empty reply from server', 'Azure SQL no habla HTTP: conecta con sqlcmd en el puerto 1433.');
  if (/\.azurecr\.io$/.test(host)) {
    if (!resolveDns(host, s)) return fail(`curl: (6) Could not resolve host: ${host}`);
    return { ok: true, status: 401, headers: { 'Content-Type': 'application/json' }, body: '{"errors":[{"code":"UNAUTHORIZED","message":"authentication required, visit https://aka.ms/acr/authorization for more information."}]}' };
  }
  if (host === 'management.azure.com') return { ok: true, status: 401, headers: { 'Content-Type': 'application/json' }, body: `{"error":{"code":"AuthenticationFailed","message":"Authentication failed. The 'Authorization' header is missing."}}` };
  const dns = resolveDns(host, s);
  if (!dns) return fail(`curl: (6) Could not resolve host: ${host}`);
  // Dominio personalizado (zona de Azure DNS) que apunta a una web app: sólo responde si está enlazado a la app.
  if (dns.cname && /\.azurewebsites\.net$/.test(dns.cname)) {
    const bound = findSiteByHost(host);
    if (bound) return resp(siteHttp(bound, path, https));
    return {
      ok: true,
      status: 404,
      headers: { 'Content-Type': 'text/html' },
      body: `<!doctype html><html><head><title>404 Web Site not found</title></head><body style="font-family:Segoe UI,sans-serif;padding:40px"><h1>404 Web Site not found.</h1><p>You may be seeing this error due to one of the reasons listed below:</p><ul><li>Custom domain has not been configured inside Azure. See how to map an existing domain to resolve this.</li><li>Client cache is still pointing the domain to old IP address. Clear the cache by running the command ipconfig/flushdns.</li></ul><p>💡 Enlaza el dominio con <code>az webapp config hostname add --webapp-name &lt;app&gt; -g &lt;grupo&gt; --hostname ${host}</code></p></body></html>`,
      hint: `El dominio ${host} apunta a App Service, pero no está enlazado a ninguna app (az webapp config hostname add).`,
    };
  }
  const ip = dns.ip;
  if (/\.azurecontainer\.io$/.test(host) || s.resources.some((r) => ciEq(r.type, 'Microsoft.ContainerInstance/containerGroups') && r.properties.ipAddress?.ip === ip)) {
    const cg = s.resources.find((r) => ciEq(r.type, 'Microsoft.ContainerInstance/containerGroups') && r.properties.ipAddress?.ip === ip);
    if (cg) return aciHttp(cg, port, path);
  }
  const svc = serviceHttp(ip, port, path, s);
  if (svc.handled) return svc.response ? resp(svc.response) : fail(svc.error!.split('\n')[0], svc.error!.split('\n').slice(1).join(' ').replace(/^# /, '') || undefined);
  const lbr = lbHttp(ip, port, path, sourceIp, s);
  if (lbr) return lbr;
  const vm = vmByIp(ip, s);
  if (vm) return vmHttp(vm, port, path, { ip: sourceIp, tag: 'Internet', vm: opts.fromVm });
  if (/^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(ip)) {
    const target = vmByIp(ip, s, true);
    if (target && opts.fromVm) {
      const a = vmNetworkInfo(opts.fromVm, s);
      const b = vmNetworkInfo(target, s);
      const sameVnet = a.vnet && b.vnet && a.vnet.id === b.vnet.id;
      const peered = a.vnet && b.vnet && peeringBetween(a.vnet, b.vnet);
      if (sameVnet || peered) return vmHttp(target, port, path, { ip: a.privateIp ?? '10.0.0.4', tag: 'VirtualNetwork', vm: opts.fromVm });
      return fail(`curl: (28) Failed to connect to ${ip} port ${port} after 21000 ms: Timeout was reached`, 'Las redes virtuales están aisladas: para comunicarlas necesitas un emparejamiento (peering) en ambos sentidos.');
    }
    return fail(`curl: (28) Failed to connect to ${ip} port ${port} after 21000 ms: Timeout was reached`, 'Las IP privadas sólo son accesibles desde dentro de la red virtual (o redes emparejadas/VPN).');
  }
  if (dns && /^93\.184\./.test(ip)) return { ok: true, status: 200, headers: { 'Content-Type': 'text/html' }, body: `<html><body><h1>${host}</h1></body></html>` };
  return fail(`curl: (28) Failed to connect to ${ip} port ${port} after 21000 ms: Timeout was reached`);
}

function lbHttp(ip: string, port: number, path: string, sourceIp: string, s: CloudState): FetchResult | null {
  const pip = s.resources.find((r) => ciEq(r.type, 'Microsoft.Network/publicIPAddresses') && r.properties.ipAddress === ip);
  if (!pip) return null;
  const lb = s.resources.find((r) => ciEq(r.type, 'Microsoft.Network/loadBalancers') && (r.properties.frontendIPConfigurations ?? []).some((f: any) => ciEq(f.properties?.publicIPAddress?.id, pip.id)) && !ciEq(r.name, 'kubernetes'));
  if (!lb) return null;
  const rule = (lb.properties.loadBalancingRules ?? []).find((r: any) => r.properties.frontendPort === port);
  if (!rule) return fail(`curl: (28) Failed to connect to ${ip} port ${port} after 21002 ms: Timeout was reached`, `El equilibrador "${lb.name}" no tiene ninguna regla para el puerto ${port}.`);
  const poolId = rule.properties.backendAddressPool?.id;
  const nics = s.resources.filter((r) => ciEq(r.type, 'Microsoft.Network/networkInterfaces') && (r.properties.ipConfigurations?.[0]?.properties?.loadBalancerBackendAddressPools ?? []).some((p: any) => ciEq(p.id, poolId)));
  const backends = nics.map((n) => s.resources.find((v) => ciEq(v.id, n.properties.virtualMachine?.id))).filter(Boolean) as Resource[];
  if (!backends.length) return fail(`curl: (28) Failed to connect to ${ip} port ${port}: Timeout was reached`, 'El grupo de back-end está vacío: añade las NIC de las VMs con "az network nic ip-config address-pool add".');
  const probe = (lb.properties.probes ?? []).find((p: any) => ciEq(p.id, rule.properties.probe?.id));
  const healthy = backends.filter((vm) => {
    if (vmPowerState(vm) !== 'running') return false;
    if (!probe) return true;
    const r = guestHttp(vm, probe.properties.port, probe.properties.requestPath ?? '/');
    return r.ok && (probe.properties.protocol === 'Tcp' || (r.status ?? 500) < 400);
  });
  if (!healthy.length) return fail(`curl: (28) Failed to connect to ${ip} port ${port}: Timeout was reached`, 'Ningún back-end está sano según el sondeo de estado (¿VMs detenidas o sin servidor web en el puerto del sondeo?).');
  const vm = healthy[Math.floor(Math.random() * healthy.length)];
  const nic = vmNetworkInfo(vm, s).nic!;
  const d = inboundAllowed(nic, rule.properties.backendPort, 'Tcp', sourceIp, s);
  if (!d.allowed) return fail(`curl: (28) Failed to connect to ${ip} port ${port}: Timeout was reached`, d.reason + ' (Con un equilibrador Standard, el NSG de los back-end debe permitir el tráfico de los clientes.)');
  const r = guestHttp(vm, rule.properties.backendPort, path);
  if (r.ok) r.headers = { ...(r.headers ?? {}), 'X-Backend-Server': vm.name };
  return r;
}

/** Sondeo TCP (nc -zv, telnet, ssh). */
export function tcpProbe(host: string, port: number, fromVm?: Resource | null): { state: 'open' | 'refused' | 'timeout' | 'unresolved'; ip?: string; hint?: string } {
  const s = getState();
  const dns = resolveDns(host, s);
  if (!dns) return { state: 'unresolved' };
  const ip = dns.ip;
  if (host.endsWith('.azurewebsites.net')) return port === 80 || port === 443 ? { state: 'open', ip } : { state: 'timeout', ip, hint: 'App Service sólo acepta los puertos 80 y 443.' };
  if (/\.(blob|file|queue|table|dfs)\.core\.windows\.net$|\.vault\.azure\.net$|\.azurecr\.io$/.test(host)) return port === 443 || port === 80 ? { state: 'open', ip } : { state: 'timeout', ip };
  if (host.endsWith('.database.windows.net')) {
    if (port !== 1433) return { state: 'timeout', ip };
    return { state: 'open', ip, hint: 'El puerto 1433 responde (la regla de firewall se valida al iniciar sesión).' };
  }
  const aci = s.resources.find((r) => ciEq(r.type, 'Microsoft.ContainerInstance/containerGroups') && r.properties.ipAddress?.ip === ip);
  if (aci) return (aci.properties.ipAddress.ports ?? []).some((p: any) => p.port === port) && aci.data?.state !== 'Stopped' ? { state: 'open', ip } : { state: 'timeout', ip };
  const vm = s.resources.find((r) => ciEq(r.type, 'Microsoft.Compute/virtualMachines') && (vmNetworkInfo(r, s).publicIp === ip || (!!fromVm && vmNetworkInfo(r, s).privateIp === ip)));
  if (vm) {
    if (vmPowerState(vm) !== 'running') return { state: 'timeout', ip, hint: `La VM "${vm.name}" no está en ejecución.` };
    const nic = vmNetworkInfo(vm, s).nic!;
    const priv = vmNetworkInfo(vm, s).privateIp === ip;
    if (!priv) {
      const d = inboundAllowed(nic, port, 'Tcp', fromVm ? vmNetworkInfo(fromVm, s).publicIp ?? '' : CLOUD_SHELL_IP, s);
      if (!d.allowed) return { state: 'timeout', ip, hint: d.reason };
    }
    const svc = vm.data?.services ?? {};
    const listening = (port === 22 && vm.data?.osType === 'Linux') || (port === 3389 && vm.data?.osType === 'Windows') || (port === 80 && (svc.nginx === 'active' || svc.apache2 === 'active' || svc.W3SVC === 'running')) || (svc.app === 'active' && port === (vm.data?.appPort ?? 3000));
    return listening ? { state: 'open', ip } : { state: 'refused', ip, hint: `La regla del NSG permite el puerto ${port}, pero ningún proceso escucha en él dentro de la VM.` };
  }
  if (/^93\.184\./.test(ip)) return port === 80 || port === 443 ? { state: 'open', ip } : { state: 'timeout', ip };
  return { state: 'timeout', ip };
}

export function vnetIdOfSubnet(subnetId: string) {
  return vnetOfSubnetId(subnetId);
}
