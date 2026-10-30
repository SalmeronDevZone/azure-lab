// Plano de datos de Key Vault: secretos con RBAC o directivas de acceso, eliminación temporal y purga.
import type { CloudState, PrincipalRef, Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, checkLocks, groupIdsOf, hasPermission, logActivity, recordEvent } from '../arm';
import { ciEq, guid, nowIso, shortHash } from '../util';

export const T_KV = 'Microsoft.KeyVault/vaults';

export type KvOp = 'get' | 'list' | 'set' | 'delete' | 'recover' | 'purge';

const RBAC_ACTION: Record<KvOp, string> = {
  get: 'Microsoft.KeyVault/vaults/secrets/getSecret/action',
  list: 'Microsoft.KeyVault/vaults/secrets/readMetadata/action',
  set: 'Microsoft.KeyVault/vaults/secrets/setSecret/action',
  delete: 'Microsoft.KeyVault/vaults/secrets/delete',
  recover: 'Microsoft.KeyVault/vaults/secrets/recover/action',
  purge: 'Microsoft.KeyVault/vaults/secrets/purge/action',
};

export function findVault(name: string, s: CloudState = getState()): Resource | undefined {
  return s.resources.find((r) => ciEq(r.type, T_KV) && ciEq(r.name, name));
}

export function getVault(name: string, s: CloudState = getState()): Resource {
  const v = findVault(name, s);
  if (!v) {
    throw new ArmError('VaultNotFound', `The Vault '${name}' not found within subscription. (Si lo eliminaste, puede estar en estado de eliminación temporal: az keyvault list-deleted)`, 404);
  }
  return v;
}

function accessPolicyAllows(vault: Resource, p: PrincipalRef, op: KvOp, s: CloudState): boolean {
  const ids = [p.objectId, ...groupIdsOf(p.objectId, s)];
  const perm = op === 'set' ? 'set' : op;
  return (vault.properties.accessPolicies ?? []).some((ap: any) => ids.includes(ap.objectId) && (ap.permissions?.secrets ?? []).some((x: string) => ciEq(x, perm) || ciEq(x, 'all')));
}

export function kvAllowed(vault: Resource, p: PrincipalRef | null, op: KvOp, s: CloudState = getState()): boolean {
  if (!p) return false;
  if (vault.properties.enableRbacAuthorization) return hasPermission(p, RBAC_ACTION[op], `${vault.id}/secrets/x`, true, s);
  return accessPolicyAllows(vault, p, op, s);
}

export function kvCanRead(vault: Resource, p: PrincipalRef, s: CloudState = getState()): boolean {
  return kvAllowed(vault, p, 'get', s);
}

function deny(vault: Resource, p: PrincipalRef | null, op: KvOp, secret: string): never {
  const caller = p ? `appid=${p.type === 'ServicePrincipal' ? p.name : '04b07795-8ddb-461a-bbee-02f9e1bf7b46'};oid=${p.objectId};iss=https://sts.windows.net/${getState().tenant.id}/` : 'anonymous';
  if (vault.properties.enableRbacAuthorization) {
    throw new ArmError(
      'Forbidden',
      `Caller is not authorized to perform action on resource.\nIf role assignments, deny assignments or role definitions were changed recently, please observe propagation time.\nCaller: ${caller}\nAction: '${RBAC_ACTION[op]}'\nResource: '${vault.id.toLowerCase()}/secrets/${secret}'\nAssignment: (not found)\nDenyAssignmentId: null\nDecisionReason: null\nVault: ${vault.name};location=${vault.location}\n\nInner error: {\n    "code": "ForbiddenByRbac"\n}`,
      403,
      'El almacén usa el modelo RBAC: asigna "Key Vault Secrets Officer" (leer/escribir) o "Key Vault Secrets User" (sólo leer) a esa identidad en el ámbito del almacén. Ser Owner no da acceso a los secretos.',
    );
  }
  throw new ArmError(
    'Forbidden',
    `The user, group or application '${caller}' does not have secrets ${op} permission on key vault '${vault.name};location=${vault.location}'. For help resolving this issue, please see https://go.microsoft.com/fwlink/?linkid=2125287\nInner error: {\n    "code": "AccessDenied"\n}`,
    403,
    `El almacén usa directivas de acceso: añade una con "az keyvault set-policy --name ${vault.name} --object-id <id> --secret-permissions get list set".`,
  );
}

function checkAccess(vault: Resource, p: PrincipalRef | null, op: KvOp, secret: string) {
  if (vault.properties.publicNetworkAccess === 'Disabled' || vault.properties.networkAcls?.defaultAction === 'Deny') {
    throw new ArmError('ForbiddenByFirewall', `Client address is not authorized and caller is not a trusted service.\nClient address: 20.31.118.42\nCaller: oid=${p?.objectId}\nVault: ${vault.name};location=${vault.location}`, 403, 'El firewall del almacén bloquea tu IP.');
  }
  if (!kvAllowed(vault, p, op)) deny(vault, p, op, secret);
}

export function secretJson(vault: Resource, name: string, version: any, includeValue = true) {
  return {
    attributes: {
      created: version.created,
      enabled: version.enabled,
      expires: version.expires ?? null,
      notBefore: null,
      recoverableDays: vault.properties.softDeleteRetentionInDays ?? 90,
      recoveryLevel: vault.properties.enablePurgeProtection ? 'Recoverable' : 'Recoverable+Purgeable',
      updated: version.created,
    },
    contentType: version.contentType ?? null,
    id: `${vault.properties.vaultUri}secrets/${name}/${version.id}`,
    kid: null,
    managed: null,
    name,
    tags: version.tags ?? {},
    ...(includeValue ? { value: version.value } : {}),
  };
}

const SECRET_RE = /^[0-9a-zA-Z-]{1,127}$/;

export function setSecret(vaultName: string, name: string, value: string, opts: { principal: PrincipalRef | null; contentType?: string; expires?: string; tags?: Record<string, string> }) {
  const vault = getVault(vaultName);
  if (!SECRET_RE.test(name)) {
    throw new ArmError('BadParameter', `The request URI contains an invalid name: ${name}. Secret names may only contain alphanumeric characters and dashes.`, 400, 'Los nombres de secreto sólo admiten letras, números y guiones (no "_" ni ".").');
  }
  checkAccess(vault, opts.principal, 'set', name);
  const secrets = vault.data!.secrets as Record<string, any>;
  const sec = secrets[name];
  if (sec?.deleted) {
    throw new ArmError('Conflict', `Secret ${name} is currently in a deleted but recoverable state, and its name cannot be reused; in this state, the secret can only be recovered or purged.`, 409, 'Recupera el secreto (az keyvault secret recover) o púrgalo antes de reutilizar el nombre.');
  }
  const version = { id: shortHash(guid(), 32), value, created: nowIso(), enabled: true, contentType: opts.contentType ?? null, expires: opts.expires ?? null, tags: opts.tags ?? {} };
  if (sec) sec.versions.push(version);
  else secrets[name] = { versions: [version], deleted: null };
  recordEvent({ kind: 'secretGet', resourceId: vault.id, caller: opts.principal?.name, status: 200, detail: `SecretSet ${name}` });
  changed();
  return secretJson(vault, name, version);
}

export function getSecret(vaultName: string, name: string, opts: { principal: PrincipalRef | null; version?: string }) {
  const vault = getVault(vaultName);
  checkAccess(vault, opts.principal, 'get', name);
  const sec = vault.data!.secrets[name];
  if (!sec || sec.deleted) {
    recordEvent({ kind: 'secretGet', resourceId: vault.id, caller: opts.principal?.name, status: 404, detail: `SecretGet ${name}` });
    throw new ArmError('SecretNotFound', `A secret with (name/id) ${name} was not found in this key vault. If you recently deleted this secret you may be able to recover it using the correct recovery command. For help resolving this issue, please see https://go.microsoft.com/fwlink/?linkid=2125182`, 404);
  }
  const version = opts.version ? sec.versions.find((v: any) => v.id === opts.version) : sec.versions[sec.versions.length - 1];
  if (!version) throw new ArmError('SecretNotFound', `Secret version ${opts.version} not found.`, 404);
  if (!version.enabled) throw new ArmError('Forbidden', `Operation get is not allowed on a disabled secret.`, 403);
  recordEvent({ kind: 'secretGet', resourceId: vault.id, caller: opts.principal?.name, status: 200, detail: `SecretGet ${name}` });
  return secretJson(vault, name, version);
}

export function listSecrets(vaultName: string, principal: PrincipalRef | null) {
  const vault = getVault(vaultName);
  checkAccess(vault, principal, 'list', '*');
  return Object.entries<any>(vault.data!.secrets)
    .filter(([, v]) => !v.deleted)
    .map(([n, v]) => {
      const last = v.versions[v.versions.length - 1];
      const j: any = secretJson(vault, n, last, false);
      j.id = `${vault.properties.vaultUri}secrets/${n}`;
      return j;
    });
}

export function listSecretVersions(vaultName: string, name: string, principal: PrincipalRef | null) {
  const vault = getVault(vaultName);
  checkAccess(vault, principal, 'list', name);
  const sec = vault.data!.secrets[name];
  if (!sec) throw new ArmError('SecretNotFound', `A secret with (name/id) ${name} was not found in this key vault.`, 404);
  return sec.versions.map((v: any) => secretJson(vault, name, v, false));
}

export function deleteSecret(vaultName: string, name: string, principal: PrincipalRef | null) {
  const vault = getVault(vaultName);
  checkAccess(vault, principal, 'delete', name);
  const sec = vault.data!.secrets[name];
  if (!sec || sec.deleted) throw new ArmError('SecretNotFound', `A secret with (name/id) ${name} was not found in this key vault.`, 404);
  const days = vault.properties.softDeleteRetentionInDays ?? 90;
  sec.deleted = { deletedDate: nowIso(), scheduledPurgeDate: new Date(Date.now() + days * 86400000).toISOString() };
  changed();
  const last = sec.versions[sec.versions.length - 1];
  return { ...secretJson(vault, name, last, false), deletedDate: sec.deleted.deletedDate, recoveryId: `${vault.properties.vaultUri}deletedsecrets/${name}`, scheduledPurgeDate: sec.deleted.scheduledPurgeDate };
}

export function listDeletedSecrets(vaultName: string, principal: PrincipalRef | null) {
  const vault = getVault(vaultName);
  checkAccess(vault, principal, 'list', '*');
  return Object.entries<any>(vault.data!.secrets)
    .filter(([, v]) => v.deleted)
    .map(([n, v]) => ({ attributes: secretJson(vault, n, v.versions[v.versions.length - 1], false).attributes, deletedDate: v.deleted.deletedDate, id: `${vault.properties.vaultUri}secrets/${n}`, name: n, recoveryId: `${vault.properties.vaultUri}deletedsecrets/${n}`, scheduledPurgeDate: v.deleted.scheduledPurgeDate }));
}

export function recoverSecret(vaultName: string, name: string, principal: PrincipalRef | null) {
  const vault = getVault(vaultName);
  checkAccess(vault, principal, 'recover', name);
  const sec = vault.data!.secrets[name];
  if (!sec?.deleted) throw new ArmError('SecretNotFound', `Deleted Secret not found: ${name}`, 404);
  sec.deleted = null;
  changed();
  return secretJson(vault, name, sec.versions[sec.versions.length - 1], false);
}

export function purgeSecret(vaultName: string, name: string, principal: PrincipalRef | null) {
  const vault = getVault(vaultName);
  checkAccess(vault, principal, 'purge', name);
  if (vault.properties.enablePurgeProtection) {
    throw new ArmError('Forbidden', `Operation "purge" is not allowed because purge protection is enabled for this vault. Key Vault service will automatically purge it after the retention period has passed.`, 403);
  }
  const sec = vault.data!.secrets[name];
  if (!sec?.deleted) throw new ArmError('SecretNotFound', `Deleted Secret not found: ${name}`, 404);
  delete vault.data!.secrets[name];
  changed();
}

// ---------------------------------------------------------------- operaciones del almacén

export function setAccessPolicy(vaultName: string, objectId: string, secretPerms: string[], principal: PrincipalRef | null) {
  const s = getState();
  const vault = getVault(vaultName, s);
  authorize(principal, 'Microsoft.KeyVault/vaults/accessPolicies/write', vault.id);
  checkLocks(vault.id, 'write', s);
  if (vault.properties.enableRbacAuthorization) {
    throw new ArmError('BadRequest', 'Cannot set policies to a vault with \'--enable-rbac-authorization\' specified', 400, 'Este almacén usa RBAC: asigna roles de Key Vault en lugar de directivas de acceso.');
  }
  const list: any[] = vault.properties.accessPolicies ?? [];
  const existing = list.find((x) => x.objectId === objectId);
  if (existing) existing.permissions.secrets = [...new Set([...(existing.permissions.secrets ?? []), ...secretPerms])];
  else list.push({ tenantId: s.tenant.id, objectId, permissions: { secrets: secretPerms, keys: [], certificates: [], storage: [] } });
  vault.properties.accessPolicies = list;
  logActivity({ operationNameValue: 'Microsoft.KeyVault/vaults/accessPolicies/write', operationName: 'Actualizar directivas de acceso del almacén', status: 'Succeeded', resourceId: vault.id, subscriptionId: vault.subscriptionId, caller: principal?.name });
  changed();
  return vault;
}

export function recoverVault(name: string, principal: PrincipalRef | null): Resource {
  const s = getState();
  const dv = s.deletedVaults.find((v) => ciEq(v.name, name));
  if (!dv) throw new ArmError('DeletedVaultNotFound', `The specified deleted vault '${name}' was not found.`, 404);
  const rg = s.resourceGroups.find((g) => g.subscriptionId === dv.resource.subscriptionId && ciEq(g.name, dv.resource.resourceGroup));
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${dv.resource.resourceGroup}' could not be found. Recreate it before recovering the vault.`, 404);
  authorize(principal, 'Microsoft.KeyVault/vaults/write', dv.resource.id);
  s.deletedVaults = s.deletedVaults.filter((v) => v !== dv);
  s.resources.push(dv.resource);
  changed();
  return dv.resource;
}

export function purgeVault(name: string, principal: PrincipalRef | null) {
  const s = getState();
  const dv = s.deletedVaults.find((v) => ciEq(v.name, name));
  if (!dv) throw new ArmError('DeletedVaultNotFound', `The specified deleted vault '${name}' was not found.`, 404);
  authorize(principal, 'Microsoft.KeyVault/locations/deletedVaults/purge/action', `/subscriptions/${dv.resource.subscriptionId}`);
  if (dv.resource.properties.enablePurgeProtection) {
    throw new ArmError('Conflict', `Operation 'DeleteVault' is not allowed since purge protection is enabled. The vault will be purged automatically on ${dv.scheduledPurgeDate}.`, 409);
  }
  s.deletedVaults = s.deletedVaults.filter((v) => v !== dv);
  changed();
}
