// Generación y fusión de ficheros kubeconfig (~/.kube/config) para clústeres AKS.
import { dump, load } from 'js-yaml';
import type { Resource } from '../types';
import { shortHash } from '../util';

export function kubeconfigObject(cluster: Resource, admin: boolean) {
  const user = admin ? `clusterAdmin_${cluster.resourceGroup}_${cluster.name}` : `clusterUser_${cluster.resourceGroup}_${cluster.name}`;
  const ctxName = admin ? `${cluster.name}-admin` : cluster.name;
  const b64 = (s: string) => btoa(s).replace(/=+$/, '');
  return {
    apiVersion: 'v1',
    clusters: [{ cluster: { 'certificate-authority-data': b64('-----BEGIN CERTIFICATE-----' + shortHash(cluster.id + 'ca', 48)), server: `https://${cluster.properties.fqdn}:443` }, name: cluster.name }],
    contexts: [{ context: { cluster: cluster.name, user }, name: ctxName }],
    'current-context': ctxName,
    kind: 'Config',
    preferences: {},
    users: [{ name: user, user: { 'client-certificate-data': b64('-----BEGIN CERTIFICATE-----' + shortHash(cluster.id + user, 48)), 'client-key-data': b64('-----BEGIN RSA PRIVATE KEY-----' + shortHash(cluster.id + 'key', 48)), token: shortHash(cluster.id + 'token' + user, 64) } }],
  };
}

export function kubeconfigFor(cluster: Resource, admin: boolean): string {
  return dump(kubeconfigObject(cluster, admin), { lineWidth: 200 } as any);
}

/** Fusiona un kubeconfig nuevo en uno existente (como hace az aks get-credentials). */
export function mergeKubeconfig(existing: string | undefined, cluster: Resource, admin: boolean, overwrite: boolean): { text: string; context: string; conflict?: string } {
  const add = kubeconfigObject(cluster, admin);
  let cur: any = { apiVersion: 'v1', clusters: [], contexts: [], 'current-context': '', kind: 'Config', preferences: {}, users: [] };
  if (existing?.trim()) {
    try {
      cur = load(existing) ?? cur;
    } catch {
      /* fichero corrupto: se reemplaza */
    }
  }
  for (const key of ['clusters', 'contexts', 'users'] as const) {
    cur[key] = cur[key] ?? [];
    for (const item of (add as any)[key]) {
      const idx = cur[key].findIndex((x: any) => x.name === item.name);
      if (idx >= 0) {
        if (!overwrite && key === 'contexts' && JSON.stringify(cur[key][idx]) !== JSON.stringify(item)) {
          return { text: existing ?? '', context: item.name, conflict: `A different object named ${item.name} already exists in your kubeconfig file.\nOverwrite? (y/n): ` };
        }
        cur[key][idx] = item;
      } else cur[key].push(item);
    }
  }
  cur['current-context'] = add['current-context'];
  return { text: dump(cur, { lineWidth: 200 } as any), context: add['current-context'] };
}

export interface KubeContext {
  name: string;
  cluster: string;
  user: string;
  server: string;
  namespace?: string;
}

export function parseKubeconfig(text: string | undefined): { current: string; contexts: KubeContext[] } | null {
  if (!text?.trim()) return null;
  try {
    const cfg: any = load(text);
    const contexts: KubeContext[] = (cfg?.contexts ?? []).map((c: any) => {
      const cl = (cfg.clusters ?? []).find((x: any) => x.name === c.context?.cluster);
      return { name: c.name, cluster: c.context?.cluster, user: c.context?.user, server: cl?.cluster?.server ?? '', namespace: c.context?.namespace };
    });
    return { current: cfg?.['current-context'] ?? '', contexts };
  } catch {
    return null;
  }
}

export function setCurrentContext(text: string, name: string): string {
  const cfg: any = load(text);
  cfg['current-context'] = name;
  return dump(cfg, { lineWidth: 200 } as any);
}

export function setContextNamespace(text: string, ctxName: string, ns: string): string {
  const cfg: any = load(text);
  const c = (cfg.contexts ?? []).find((x: any) => x.name === ctxName);
  if (c) c.context.namespace = ns;
  return dump(cfg, { lineWidth: 200 } as any);
}
