// Plano de datos de Azure Container Registry: repositorios, etiquetas, push/pull e importación.
import type { PrincipalRef, Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, hasPermission } from '../arm';
import { findPublicImage, normalizeImageName } from '../catalog';
import { ciEq, nowIso, shortHash } from '../util';

export const T_ACR = 'Microsoft.ContainerRegistry/registries';

export function findRegistry(nameOrServer: string): Resource | undefined {
  const v = nameOrServer.toLowerCase().replace(/\.azurecr\.io$/, '');
  return getState().resources.find((r) => ciEq(r.type, T_ACR) && ciEq(r.name, v));
}

export function getRegistry(nameOrServer: string): Resource {
  const r = findRegistry(nameOrServer);
  if (!r) {
    throw new ArmError('ResourceNotFound', `The resource with name '${nameOrServer}' and type '${T_ACR}' could not be found in subscription.`, 404);
  }
  return r;
}

export interface ImageContent {
  files: Record<string, string>;
  env?: Record<string, string>;
  exposed?: number;
  cmd?: string;
  size: number;
  base?: string;
}

export function canPush(reg: Resource, principal: PrincipalRef | null): boolean {
  return hasPermission(principal, 'Microsoft.ContainerRegistry/registries/push/write', reg.id);
}

export function pushImage(reg: Resource, repo: string, tag: string, img: ImageContent) {
  const repos = (reg.data!.repos ??= {});
  const r = (repos[repo] ??= { tags: {}, created: nowIso() });
  const digest = `sha256:${shortHash(JSON.stringify(img.files) + tag + Date.now(), 64)}`;
  r.tags[tag] = { digest, created: nowIso(), size: img.size, files: img.files, env: img.env ?? {}, exposed: img.exposed, cmd: img.cmd, base: img.base };
  r.lastUpdate = nowIso();
  changed();
  return digest;
}

export function listRepositories(reg: Resource, principal: PrincipalRef | null): string[] {
  if (!hasPermission(principal, 'Microsoft.ContainerRegistry/registries/pull/read', reg.id) && !hasPermission(principal, 'Microsoft.ContainerRegistry/registries/read', reg.id)) {
    authorize(principal, 'Microsoft.ContainerRegistry/registries/pull/read', reg.id);
  }
  return Object.keys(reg.data?.repos ?? {}).sort();
}

export function listTags(reg: Resource, repo: string, principal: PrincipalRef | null) {
  listRepositories(reg, principal);
  const r = reg.data?.repos?.[repo];
  if (!r) throw new ArmError('RepositoryNotFound', `repository ${repo} is not found.`, 404);
  return Object.entries<any>(r.tags).map(([name, t]) => ({ name, digest: t.digest, createdTime: t.created, lastUpdateTime: t.created, signed: false }));
}

export function deleteImage(reg: Resource, repo: string, tag: string | null, principal: PrincipalRef | null) {
  authorize(principal, 'Microsoft.ContainerRegistry/registries/delete', reg.id);
  const r = reg.data?.repos?.[repo];
  if (!r) throw new ArmError('RepositoryNotFound', `repository ${repo} is not found.`, 404);
  if (tag) {
    if (!r.tags[tag]) throw new ArmError('ManifestUnknown', `manifest tagged by "${tag}" is not found`, 404);
    delete r.tags[tag];
    if (!Object.keys(r.tags).length) delete reg.data!.repos[repo];
  } else delete reg.data!.repos[repo];
  changed();
}

export function importImage(reg: Resource, source: string, target: string, principal: PrincipalRef | null) {
  authorize(principal, 'Microsoft.ContainerRegistry/registries/importImage/action', reg.id);
  const pub = findPublicImage(source);
  let content: ImageContent;
  if (pub) content = { files: {}, size: pub.size, exposed: pub.port, base: pub.name };
  else {
    const { registry, repo, tag } = normalizeImageName(source);
    const src = registry ? findRegistry(registry) : undefined;
    const t = src?.data?.repos?.[repo]?.tags?.[tag];
    if (!t) throw new ArmError('InvalidParameters', `Image '${source}' not found or not accessible.`, 404);
    content = { files: t.files, env: t.env, exposed: t.exposed, size: t.size, base: t.base };
  }
  const { repo, tag } = normalizeImageName(target);
  const digest = pushImage(reg, repo, tag, content);
  if (pub) reg.data!.repos[repo].tags[tag].publicImage = pub.name;
  changed();
  return digest;
}
