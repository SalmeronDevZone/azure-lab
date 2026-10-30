// Plano de datos de Azure Storage: contenedores, blobs, SAS, sitio web estático, recursos compartidos y colas.
import type { CloudState, PrincipalRef, Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, hasPermission, recordEvent } from '../arm';
import { ciEq, fnv1a, guid, nowIso, shortHash, cidrContainsIp, isValidIp } from '../util';
import { CLOUD_SHELL_IP } from '../providers/network';
import { contentTypeOf } from './appRuntime';

export const T_STORAGE = 'Microsoft.Storage/storageAccounts';

export type StorageAuth =
  | { mode: 'key'; explicitKey?: string }
  | { mode: 'login' }
  | { mode: 'sas'; token: string }
  | { mode: 'anonymous' };

export interface BlobItem {
  content: string;
  size: number;
  contentType: string;
  tier: 'Hot' | 'Cool' | 'Cold' | 'Archive';
  lastModified: string;
  created: string;
  etag: string;
  metadata: Record<string, string>;
}

export interface ContainerItem {
  name: string;
  publicAccess: 'off' | 'blob' | 'container';
  lastModified: string;
  etag: string;
  metadata: Record<string, string>;
  blobs: Record<string, BlobItem>;
}

export function findAccount(name: string, s: CloudState = getState()): Resource {
  const acct = s.resources.find((r) => ciEq(r.type, T_STORAGE) && ciEq(r.name, name));
  if (!acct) {
    throw new ArmError('StorageAccountNotFound', `The storage account '${name}' could not be found. (Comprueba el nombre con: az storage account list -o table)`, 404);
  }
  if (acct.properties.provisioningState !== 'Succeeded') throw new ArmError('StorageAccountNotReady', `The storage account '${name}' is still being provisioned.`, 409);
  return acct;
}

function etag(): string {
  return `"0x8DC${shortHash(guid(), 11).toUpperCase()}"`;
}

const DATA_ACTIONS: Record<string, string> = {
  read: 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read',
  write: 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write',
  delete: 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete',
  list: 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read',
};

function networkAllows(acct: Resource, ip = CLOUD_SHELL_IP): boolean {
  if (acct.properties.publicNetworkAccess === 'Disabled') return false;
  const rules = acct.properties.networkRuleSet;
  if (!rules || rules.defaultAction !== 'Deny') return true;
  return (rules.ipRules ?? []).some((r: any) => {
    const v = r.value ?? r.ipAddressOrRange ?? r;
    return String(v).includes('/') ? cidrContainsIp(v, ip) : isValidIp(v) && v === ip;
  });
}

/** Comprueba la autorización de plano de datos para una operación sobre blobs/contenedores. */
export function checkBlobAccess(acct: Resource, auth: StorageAuth, op: 'read' | 'write' | 'delete' | 'list', principal: PrincipalRef | null, container?: string) {
  if (!networkAllows(acct)) {
    throw new ArmError('AuthorizationFailure', 'This request is not authorized to perform this operation.', 403, 'El firewall de la cuenta de almacenamiento (Redes) bloquea tu IP. Añade la IP del Cloud Shell a las reglas o permite el acceso desde todas las redes.');
  }
  if (auth.mode === 'login') {
    if (!hasPermission(principal, DATA_ACTIONS[op], acct.id, true)) {
      throw new ArmError(
        'AuthorizationPermissionMismatch',
        `You do not have the required permissions needed to perform this operation.\nDepending on your operation, you may need to be assigned one of the following roles:\n    "Storage Blob Data Owner"\n    "Storage Blob Data Contributor"\n    "Storage Blob Data Reader"\n    "Storage Queue Data Contributor"\n    "Storage Queue Data Reader"\n    "Storage Table Data Contributor"\n    "Storage Table Data Reader"\n\nIf you want to use the old authentication method and allow querying for the right account key, please use the "--auth-mode" parameter and "key" value.`,
        403,
        'Con --auth-mode login se usa tu identidad de Entra ID: necesitas un rol de datos (p. ej. "Storage Blob Data Contributor") aunque seas Owner.',
      );
    }
    return;
  }
  if (auth.mode === 'key') {
    if (acct.properties.allowSharedKeyAccess === false) {
      throw new ArmError('KeyBasedAuthenticationNotPermitted', 'Key based authentication is not permitted on this storage account.', 403, 'La cuenta tiene deshabilitado el acceso con clave compartida: usa --auth-mode login con un rol de datos.');
    }
    if (auth.explicitKey) {
      if (!(acct.data?.keys ?? []).some((k: any) => k.value === auth.explicitKey)) {
        throw new ArmError('AuthenticationFailed', 'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.', 403, 'La clave de cuenta no es válida (¿la has rotado?).');
      }
      return;
    }
    authorize(principal, 'Microsoft.Storage/storageAccounts/listkeys/action', acct.id);
    return;
  }
  if (auth.mode === 'sas') {
    validateSas(acct, auth.token, op, container);
    return;
  }
  // anónimo
  const c: ContainerItem | undefined = container ? acct.data?.containers?.[container] : undefined;
  const pub = acct.properties.allowBlobPublicAccess && c && c.publicAccess !== 'off';
  if (!pub || op !== 'read' && op !== 'list' || (op === 'list' && c?.publicAccess !== 'container')) {
    if (!acct.properties.allowBlobPublicAccess && c && c.publicAccess !== 'off') {
      throw new ArmError('PublicAccessNotPermitted', 'Public access is not permitted on this storage account.', 409);
    }
    throw new ArmError('ResourceNotFound', 'The specified resource does not exist.', 404, 'El contenedor es privado: usa una SAS, --auth-mode login o habilita el acceso anónimo (nivel "blob").');
  }
}

// ---------------------------------------------------------------- SAS

export function generateSas(acct: Resource, opts: { permissions: string; expiry: string; container?: string; blob?: string; httpsOnly?: boolean; resourceTypes?: string; services?: string }): string {
  const expiry = new Date(opts.expiry);
  if (isNaN(expiry.getTime())) throw new ArmError('InvalidArgumentValue', `Expiry date '${opts.expiry}' is not valid. Use format: YYYY-MM-DDTHH:MMZ`);
  const sr = opts.blob ? 'b' : opts.container ? 'c' : undefined;
  const params: Record<string, string> = {
    se: opts.expiry,
    sp: opts.permissions,
    sv: '2022-11-02',
  };
  if (opts.httpsOnly !== false) params.spr = 'https';
  if (sr) params.sr = sr;
  if (!sr) {
    params.ss = opts.services ?? 'b';
    params.srt = opts.resourceTypes ?? 'sco';
  }
  const key = acct.data?.keys?.[0]?.value ?? '';
  const target = `${acct.name}/${opts.container ?? ''}/${opts.blob ?? ''}`;
  const sig = encodeURIComponent(btoaSafe(shortHash(key + target + JSON.stringify(params), 43)) + '=');
  const qs = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const token = `${qs}&sig=${sig}`;
  acct.data!.sas = [...(acct.data!.sas ?? []), { token, target, keyHash: fnv1a(key), params }].slice(-30);
  changed();
  return token;
}

function btoaSafe(s: string) {
  try {
    return btoa(s);
  } catch {
    return s;
  }
}

export function validateSas(acct: Resource, token: string, op: string, container?: string) {
  const clean = token.replace(/^\?/, '');
  const entry = (acct.data?.sas ?? []).find((x: any) => x.token === clean);
  if (!entry) throw new ArmError('AuthenticationFailed', 'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.', 403);
  const currentKeys = (acct.data?.keys ?? []).map((k: any) => fnv1a(k.value));
  if (!currentKeys.includes(entry.keyHash) || fnv1a(acct.data?.keys?.[0]?.value ?? '') !== entry.keyHash) {
    throw new ArmError('AuthenticationFailed', 'Signature did not match. String to sign used was ... (la clave con la que se firmó la SAS ya no es válida).', 403, 'Rotar una clave de cuenta invalida todas las SAS firmadas con ella.');
  }
  if (new Date(entry.params.se).getTime() < Date.now()) throw new ArmError('AuthenticationFailed', 'Signed expiry time [' + entry.params.se + '] must be after signed start time. (La SAS ha caducado.)', 403);
  const need = op === 'read' ? 'r' : op === 'list' ? 'l' : op === 'write' ? 'w' : 'd';
  if (!entry.params.sp.includes(need)) throw new ArmError('AuthorizationPermissionMismatch', `This request is not authorized to perform this operation using this permission. (La SAS sólo concede '${entry.params.sp}')`, 403);
  const [, tc] = entry.target.split('/');
  if (tc && container && tc !== container) throw new ArmError('AuthorizationResourceTypeMismatch', 'This request is not authorized to perform this operation using this resource type.', 403);
}

// ---------------------------------------------------------------- contenedores

const CONTAINER_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function containersOf(acct: Resource): Record<string, ContainerItem> {
  if (!acct.data) acct.data = {};
  if (!acct.data.containers) acct.data.containers = {};
  return acct.data.containers;
}

export function createContainer(accountName: string, name: string, publicAccess: 'off' | 'blob' | 'container', auth: StorageAuth, principal: PrincipalRef | null): { created: boolean } {
  const acct = findAccount(accountName);
  if (!CONTAINER_RE.test(name) && name !== '$web' && name !== '$root') {
    throw new ArmError('InvalidResourceName', 'The specifed resource name contains invalid characters. (Nombres de contenedor: 3-63 caracteres, minúsculas, números y guiones; sin guiones consecutivos.)', 400);
  }
  checkBlobAccess(acct, auth, 'write', principal);
  if (publicAccess !== 'off' && !acct.properties.allowBlobPublicAccess) {
    throw new ArmError('PublicAccessNotPermitted', 'Public access is not permitted on this storage account.', 409, 'Activa "Permitir el acceso anónimo a blobs" en la configuración de la cuenta (allowBlobPublicAccess) antes de crear contenedores públicos.');
  }
  const cs = containersOf(acct);
  if (cs[name]) return { created: false };
  cs[name] = { name, publicAccess, lastModified: nowIso(), etag: etag(), metadata: {}, blobs: {} };
  recordEvent({ kind: 'blobOp', resourceId: acct.id, detail: `PutContainer ${name}`, status: 201, caller: principal?.name });
  changed();
  return { created: true };
}

export function deleteContainer(accountName: string, name: string, auth: StorageAuth, principal: PrincipalRef | null): { deleted: boolean } {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, auth, 'delete', principal);
  const cs = containersOf(acct);
  if (!cs[name]) return { deleted: false };
  delete cs[name];
  if (name === '$web') acct.data!.staticWebsite = { ...acct.data!.staticWebsite, enabled: acct.data!.staticWebsite?.enabled };
  changed();
  return { deleted: true };
}

export function setContainerPublicAccess(accountName: string, name: string, publicAccess: 'off' | 'blob' | 'container', auth: StorageAuth, principal: PrincipalRef | null) {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, auth, 'write', principal);
  const c = containersOf(acct)[name];
  if (!c) throw new ArmError('ContainerNotFound', 'The specified container does not exist.', 404);
  if (publicAccess !== 'off' && !acct.properties.allowBlobPublicAccess) throw new ArmError('PublicAccessNotPermitted', 'Public access is not permitted on this storage account.', 409);
  c.publicAccess = publicAccess;
  c.lastModified = nowIso();
  changed();
  return c;
}

export function getContainer(acct: Resource, name: string): ContainerItem {
  const c = containersOf(acct)[name];
  if (!c) throw new ArmError('ContainerNotFound', 'The specified container does not exist.', 404, `Crea el contenedor primero: az storage container create --account-name ${acct.name} --name ${name}`);
  return c;
}

export function containerJson(c: ContainerItem) {
  return {
    deleted: null,
    encryptionScope: { defaultEncryptionScope: '$account-encryption-key', preventEncryptionScopeOverride: false },
    immutableStorageWithVersioningEnabled: false,
    metadata: Object.keys(c.metadata).length ? c.metadata : null,
    name: c.name,
    properties: {
      etag: c.etag,
      hasImmutabilityPolicy: false,
      hasLegalHold: false,
      lastModified: c.lastModified,
      lease: { duration: null, state: 'available', status: 'unlocked' },
      publicAccess: c.publicAccess === 'off' ? null : c.publicAccess,
    },
    version: null,
  };
}

// ---------------------------------------------------------------- blobs

export function uploadBlob(
  accountName: string,
  container: string,
  name: string,
  content: string,
  opts: { auth: StorageAuth; principal: PrincipalRef | null; overwrite?: boolean; contentType?: string; tier?: string },
) {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, opts.auth, 'write', opts.principal, container);
  const c = getContainer(acct, container);
  if (c.blobs[name] && !opts.overwrite) {
    throw new ArmError('BlobAlreadyExists', 'The specified blob already exists.\nRequestId:' + guid(), 409, 'Añade --overwrite para reemplazar el blob existente.');
  }
  const tier = (opts.tier ?? acct.properties.accessTier ?? 'Hot') as BlobItem['tier'];
  const now = nowIso();
  const b: BlobItem = {
    content,
    size: new TextEncoder().encode(content).length,
    contentType: opts.contentType ?? contentTypeOf(name),
    tier,
    lastModified: now,
    created: c.blobs[name]?.created ?? now,
    etag: etag(),
    metadata: {},
  };
  c.blobs[name] = b;
  recordEvent({ kind: 'blobOp', resourceId: acct.id, detail: `PutBlob ${container}/${name}`, status: 201, caller: opts.principal?.name });
  changed();
  return {
    client_request_id: guid(),
    content_md5: null,
    date: now,
    encryption_key_sha256: null,
    encryption_scope: null,
    etag: b.etag,
    lastModified: now,
    request_id: guid(),
    request_server_encrypted: true,
    version: '2022-11-02',
    version_id: null,
  };
}

export function blobJson(container: string, name: string, b: BlobItem) {
  return {
    container,
    content: '',
    deleted: false,
    encryptedMetadata: null,
    encryptionKeySha256: null,
    encryptionScope: null,
    hasLegalHold: null,
    hasVersionsOnly: null,
    immutabilityPolicy: { expiryTime: null, policyMode: null },
    isAppendBlobSealed: null,
    isCurrentVersion: null,
    lastAccessedOn: null,
    metadata: Object.keys(b.metadata).length ? b.metadata : {},
    name,
    objectReplicationDestinationPolicy: null,
    objectReplicationSourceProperties: [],
    properties: {
      appendBlobCommittedBlockCount: null,
      blobTier: b.tier,
      blobTierChangeTime: null,
      blobTierInferred: false,
      blobType: 'BlockBlob',
      contentLength: b.size,
      contentRange: null,
      contentSettings: { cacheControl: null, contentDisposition: null, contentEncoding: null, contentLanguage: null, contentMd5: null, contentType: b.contentType },
      copy: { completionTime: null, destinationSnapshot: null, id: null, incrementalCopy: null, progress: null, source: null, status: null, statusDescription: null },
      creationTime: b.created,
      deletedTime: null,
      etag: b.etag,
      lastModified: b.lastModified,
      lease: { duration: null, state: 'available', status: 'unlocked' },
      pageBlobSequenceNumber: null,
      pageRanges: null,
      rehydrationStatus: null,
      remainingRetentionDays: null,
      serverEncrypted: true,
    },
    rehydratePriority: null,
    requestServerEncrypted: null,
    snapshot: null,
    tagCount: null,
    tags: null,
    versionId: null,
  };
}

export function listBlobs(accountName: string, container: string, auth: StorageAuth, principal: PrincipalRef | null, prefix?: string) {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, auth, 'list', principal, container);
  const c = getContainer(acct, container);
  recordEvent({ kind: 'blobOp', resourceId: acct.id, detail: `ListBlobs ${container}`, status: 200, caller: principal?.name });
  return Object.entries(c.blobs)
    .filter(([n]) => !prefix || n.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, b]) => blobJson(container, n, b));
}

export function downloadBlob(accountName: string, container: string, name: string, auth: StorageAuth, principal: PrincipalRef | null): BlobItem {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, auth, 'read', principal, container);
  const c = getContainer(acct, container);
  const b = c.blobs[name];
  if (!b) throw new ArmError('BlobNotFound', 'The specified blob does not exist.\nRequestId:' + guid(), 404);
  if (b.tier === 'Archive') {
    throw new ArmError('BlobArchived', 'This operation is not permitted on an archived blob.', 409, 'Los blobs en nivel Archive deben rehidratarse (cambiar a Hot/Cool) antes de poder leerse; tarda horas en la vida real.');
  }
  recordEvent({ kind: 'blobOp', resourceId: acct.id, detail: `GetBlob ${container}/${name}`, status: 200, caller: principal?.name });
  return b;
}

export function deleteBlob(accountName: string, container: string, name: string, auth: StorageAuth, principal: PrincipalRef | null) {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, auth, 'delete', principal, container);
  const c = getContainer(acct, container);
  if (!c.blobs[name]) throw new ArmError('BlobNotFound', 'The specified blob does not exist.', 404);
  delete c.blobs[name];
  recordEvent({ kind: 'blobOp', resourceId: acct.id, detail: `DeleteBlob ${container}/${name}`, status: 202, caller: principal?.name });
  changed();
}

export function setBlobTier(accountName: string, container: string, name: string, tier: string, auth: StorageAuth, principal: PrincipalRef | null) {
  const acct = findAccount(accountName);
  checkBlobAccess(acct, auth, 'write', principal, container);
  const c = getContainer(acct, container);
  const b = c.blobs[name];
  if (!b) throw new ArmError('BlobNotFound', 'The specified blob does not exist.', 404);
  const t = ['Hot', 'Cool', 'Cold', 'Archive'].find((x) => ciEq(x, tier));
  if (!t) throw new ArmError('InvalidHeaderValue', `The value '${tier}' for the tier is not valid. Allowed: Hot, Cool, Cold, Archive.`);
  b.tier = t as BlobItem['tier'];
  b.lastModified = nowIso();
  changed();
}

// ---------------------------------------------------------------- claves

export function listKeys(acct: Resource, principal: PrincipalRef | null) {
  authorize(principal, 'Microsoft.Storage/storageAccounts/listkeys/action', acct.id);
  return (acct.data?.keys ?? []).map((k: any) => ({ creationTime: k.creationTime, keyName: k.keyName, permissions: 'FULL', value: k.value }));
}

export function renewKey(acct: Resource, keyName: 'key1' | 'key2' | 'primary' | 'secondary', principal: PrincipalRef | null) {
  authorize(principal, 'Microsoft.Storage/storageAccounts/regeneratekey/action', acct.id);
  const kn = keyName === 'primary' ? 'key1' : keyName === 'secondary' ? 'key2' : keyName;
  const k = (acct.data?.keys ?? []).find((x: any) => x.keyName === kn);
  if (!k) throw new ArmError('InvalidKeyName', `Invalid key name '${keyName}'. Allowed: primary, secondary.`);
  k.value = btoaSafe(shortHash(guid() + Date.now(), 64)).slice(0, 86) + '==';
  k.creationTime = nowIso();
  changed();
  return listKeys(acct, principal);
}

export function connectionString(acct: Resource, principal: PrincipalRef | null): string {
  const keys = listKeys(acct, principal);
  return `DefaultEndpointsProtocol=https;EndpointSuffix=core.windows.net;AccountName=${acct.name};AccountKey=${keys[0].value};BlobEndpoint=https://${acct.name}.blob.core.windows.net/;FileEndpoint=https://${acct.name}.file.core.windows.net/;QueueEndpoint=https://${acct.name}.queue.core.windows.net/;TableEndpoint=https://${acct.name}.table.core.windows.net/`;
}

export function parseConnectionString(cs: string): { account?: string; key?: string } {
  const out: Record<string, string> = {};
  for (const part of cs.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return { account: out.accountname, key: out.accountkey };
}

// ---------------------------------------------------------------- sitio web estático

export function enableStaticWebsite(accountName: string, index: string | undefined, error404: string | undefined, principal: PrincipalRef | null, enabled = true) {
  const acct = findAccount(accountName);
  authorize(principal, 'Microsoft.Storage/storageAccounts/write', acct.id);
  if (acct.kind !== 'StorageV2' && acct.kind !== 'BlockBlobStorage') {
    throw new ArmError('FeatureNotSupportedForAccount', 'Static website hosting is only supported for StorageV2 and BlockBlobStorage accounts.', 400);
  }
  acct.data!.staticWebsite = { enabled, indexDocument: index ?? 'index.html', errorDocument404Path: error404 ?? null };
  const cs = containersOf(acct);
  if (enabled && !cs['$web']) cs['$web'] = { name: '$web', publicAccess: 'off', lastModified: nowIso(), etag: etag(), metadata: {}, blobs: {} };
  changed();
  return acct.data!.staticWebsite;
}

// ---------------------------------------------------------------- recursos compartidos de archivos y colas

export function createShare(accountName: string, name: string, quota: number, principal: PrincipalRef | null) {
  const acct = findAccount(accountName);
  authorize(principal, 'Microsoft.Storage/storageAccounts/listkeys/action', acct.id);
  if (!CONTAINER_RE.test(name)) throw new ArmError('InvalidResourceName', 'The specifed resource name contains invalid characters.');
  acct.data!.shares = acct.data!.shares ?? {};
  if (acct.data!.shares[name]) return { created: false };
  acct.data!.shares[name] = { name, quota: quota || 5120, files: {}, lastModified: nowIso() };
  changed();
  return { created: true };
}

export function createQueue(accountName: string, name: string, principal: PrincipalRef | null) {
  const acct = findAccount(accountName);
  authorize(principal, 'Microsoft.Storage/storageAccounts/listkeys/action', acct.id);
  if (!CONTAINER_RE.test(name)) throw new ArmError('InvalidResourceName', 'The specifed resource name contains invalid characters.');
  acct.data!.queues = acct.data!.queues ?? {};
  if (acct.data!.queues[name]) return { created: false };
  acct.data!.queues[name] = { name, messages: [] };
  changed();
  return { created: true };
}

export function putQueueMessage(accountName: string, queue: string, content: string, principal: PrincipalRef | null) {
  const acct = findAccount(accountName);
  authorize(principal, 'Microsoft.Storage/storageAccounts/listkeys/action', acct.id);
  const q = acct.data?.queues?.[queue];
  if (!q) throw new ArmError('QueueNotFound', 'The specified queue does not exist.', 404);
  const msg = { id: guid(), content, insertionTime: nowIso(), expirationTime: new Date(Date.now() + 7 * 86400000).toISOString(), dequeueCount: 0, popReceipt: shortHash(guid(), 12) };
  q.messages.push(msg);
  changed();
  return msg;
}
