// Motor de Kubernetes simulado para clústeres AKS.
import type { CloudState, PrincipalRef, Resource } from '../types';
import { findPublicImage, normalizeImageName } from '../catalog';
import { ciEq, guid, nowIso, seededRandom, fnv1a, shortHash, randomPublicIp } from '../util';
import { hasPermission, createImmediate, findRg } from '../arm';
import { changed, getState, speedFactor } from '../store';
import { appListenPort, appStartError, renderApp, startupLog, type AppPackage, type HttpResponse } from './appRuntime';

export interface KMeta {
  name: string;
  namespace: string;
  uid: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  creationTimestamp: string;
}

export interface KContainer {
  name: string;
  image: string;
  ports?: { containerPort: number; protocol?: string }[];
  env?: { name: string; value?: string; valueFrom?: any }[];
  resources?: any;
}

export interface KNode {
  name: string;
  pool: string;
  status: 'Ready' | 'NotReady';
  version: string;
  internalIP: string;
  created: string;
  cpu: number;
  memoryGi: number;
}

export interface KDeployment {
  meta: KMeta;
  replicas: number;
  selector: Record<string, string>;
  template: { labels: Record<string, string>; containers: KContainer[] };
  revision: number;
  history: { revision: number; images: string; changeCause: string; templateHash: string; template: any }[];
}

export interface KReplicaSet {
  meta: KMeta;
  owner: string;
  hash: string;
  revision: number;
  replicas: number;
  template: { labels: Record<string, string>; containers: KContainer[] };
}

export type PodStatus = 'Pending' | 'ContainerCreating' | 'Running' | 'ErrImagePull' | 'ImagePullBackOff' | 'CrashLoopBackOff' | 'Terminating' | 'Completed' | 'Error';

export interface KEvent {
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  object: string;
  time: string;
  count: number;
  from: string;
}

export interface KPod {
  meta: KMeta;
  owner?: { kind: 'ReplicaSet' | 'None'; name: string };
  node: string | null;
  status: PodStatus;
  ip: string | null;
  containers: KContainer[];
  restarts: number;
  createdAt: number;
  nextTransition: number;
  system?: boolean;
  pullError?: string;
  deleteAt?: number;
  events: KEvent[];
}

export interface KService {
  meta: KMeta;
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  selector: Record<string, string>;
  ports: { name?: string; port: number; targetPort: number; nodePort?: number; protocol: string }[];
  clusterIP: string;
  externalIP: string | null;
  externalReadyAt?: number;
}

export interface KSimple {
  meta: KMeta;
  data: Record<string, string>;
  type?: string;
}

export interface KubeState {
  namespaces: { name: string; created: string; status: 'Active' | 'Terminating' }[];
  nodes: KNode[];
  deployments: KDeployment[];
  replicasets: KReplicaSet[];
  pods: KPod[];
  services: KService[];
  configmaps: KSimple[];
  secrets: KSimple[];
  hpas: { meta: KMeta; target: string; min: number; max: number; cpu: number }[];
  ingresses: { meta: KMeta; rules: any[] }[];
  events: KEvent[];
  ipCounter: number;
  svcCounter: number;
}

const ALNUM = 'bcdfghjklmnpqrstvwxz2456789';

function k8sSuffix(seed: string, len: number): string {
  const r = seededRandom(fnv1a(seed));
  let out = '';
  for (let i = 0; i < len; i++) out += ALNUM[Math.floor(r() * ALNUM.length)];
  return out;
}

export function meta(name: string, namespace = 'default', labels: Record<string, string> = {}, annotations: Record<string, string> = {}): KMeta {
  return { name, namespace, uid: guid(), labels: { ...labels }, annotations: { ...annotations }, creationTimestamp: nowIso() };
}

function t(ms: number) {
  return Date.now() + Math.round(ms * Math.max(speedFactor(), 0.15));
}

export function emptyKube(): KubeState {
  return {
    namespaces: ['default', 'kube-node-lease', 'kube-public', 'kube-system'].map((name) => ({ name, created: nowIso(), status: 'Active' as const })),
    nodes: [],
    deployments: [],
    replicasets: [],
    pods: [],
    services: [
      { meta: meta('kubernetes', 'default', { component: 'apiserver', provider: 'kubernetes' }), type: 'ClusterIP', selector: {}, ports: [{ name: 'https', port: 443, targetPort: 443, protocol: 'TCP' }], clusterIP: '10.0.0.1', externalIP: null },
      { meta: meta('kube-dns', 'kube-system', { 'k8s-app': 'kube-dns' }), type: 'ClusterIP', selector: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, targetPort: 53, protocol: 'UDP' }], clusterIP: '10.0.0.10', externalIP: null },
      { meta: meta('metrics-server', 'kube-system', { 'k8s-app': 'metrics-server' }), type: 'ClusterIP', selector: { 'k8s-app': 'metrics-server' }, ports: [{ port: 443, targetPort: 4443, protocol: 'TCP' }], clusterIP: '10.0.152.40', externalIP: null },
    ],
    configmaps: [],
    secrets: [],
    hpas: [],
    ingresses: [],
    events: [],
    ipCounter: 10,
    svcCounter: 20,
  };
}

/** Ajusta los nodos a los grupos de nodos del clúster y recrea los pods de sistema. */
export function syncNodes(k: KubeState, clusterId: string, pools: any[], version: string, running = true) {
  const desired: KNode[] = [];
  if (running) {
    for (const p of pools) {
      if (p.powerState?.code === 'Stopped') continue;
      const h = String(fnv1a(clusterId + p.name) % 100000000).padStart(8, '0');
      for (let i = 0; i < (p.count ?? 0); i++) {
        const name = `aks-${p.name}-${h}-vmss${i.toString(36).padStart(6, '0')}`;
        const prev = k.nodes.find((n) => n.name === name);
        desired.push(prev ? { ...prev, version } : { name, pool: p.name, status: 'Ready', version, internalIP: `10.224.0.${4 + desired.length}`, created: nowIso(), cpu: 2, memoryGi: 8 });
      }
    }
  }
  k.nodes = desired;
  // Pods de sistema
  k.pods = k.pods.filter((p) => !p.system);
  if (!desired.length) {
    for (const p of k.pods) {
      p.node = null;
      p.status = 'Pending';
      p.ip = null;
    }
    return;
  }
  const sys = (name: string, labels: Record<string, string>, node: string, image: string) =>
    ({
      meta: meta(name, 'kube-system', labels),
      owner: { kind: 'ReplicaSet', name: name.split('-').slice(0, -1).join('-') },
      node,
      status: 'Running',
      ip: `10.244.0.${(fnv1a(name) % 200) + 2}`,
      containers: [{ name: labels['k8s-app'] ?? name, image }],
      restarts: 0,
      createdAt: Date.now(),
      nextTransition: 0,
      system: true,
      events: [],
    }) as KPod;
  const n0 = desired[0].name;
  const n1 = desired[desired.length > 1 ? 1 : 0].name;
  const seed = clusterId;
  k.pods.push(
    sys(`coredns-${k8sSuffix(seed + 'cd', 10)}-${k8sSuffix(seed + 'cd1', 5)}`, { 'k8s-app': 'kube-dns' }, n0, 'mcr.microsoft.com/oss/kubernetes/coredns:v1.11.3-2'),
    sys(`coredns-${k8sSuffix(seed + 'cd', 10)}-${k8sSuffix(seed + 'cd2', 5)}`, { 'k8s-app': 'kube-dns' }, n1, 'mcr.microsoft.com/oss/kubernetes/coredns:v1.11.3-2'),
    sys(`coredns-autoscaler-${k8sSuffix(seed + 'ca', 10)}-${k8sSuffix(seed + 'ca1', 5)}`, { 'k8s-app': 'coredns-autoscaler' }, n0, 'mcr.microsoft.com/oss/kubernetes/autoscaler/cluster-proportional-autoscaler:v1.8.11'),
    sys(`konnectivity-agent-${k8sSuffix(seed + 'ka', 10)}-${k8sSuffix(seed + 'ka1', 5)}`, { app: 'konnectivity-agent' }, n0, 'mcr.microsoft.com/oss/kubernetes/apiserver-network-proxy/agent:v0.30.3'),
    sys(`metrics-server-${k8sSuffix(seed + 'ms', 10)}-${k8sSuffix(seed + 'ms1', 5)}`, { 'k8s-app': 'metrics-server' }, n1, 'mcr.microsoft.com/oss/kubernetes/metrics-server:v0.7.2'),
  );
  for (const n of desired) {
    k.pods.push(sys(`kube-proxy-${k8sSuffix(n.name + 'kp', 5)}`, { component: 'kube-proxy' }, n.name, 'mcr.microsoft.com/oss/kubernetes/kube-proxy:v' + version));
    k.pods.push(sys(`cloud-node-manager-${k8sSuffix(n.name + 'cnm', 5)}`, { component: 'cloud-node-manager' }, n.name, 'mcr.microsoft.com/oss/kubernetes/azure-cloud-node-manager:v1.31.1'));
    k.pods.push(sys(`azure-ip-masq-agent-${k8sSuffix(n.name + 'ipm', 5)}`, { 'k8s-app': 'azure-ip-masq-agent' }, n.name, 'mcr.microsoft.com/oss/kubernetes/ip-masq-agent:v2.5.0.12'));
  }
  // Pods de usuario sin nodo: reprogramar
  for (const p of k.pods.filter((x) => !x.system)) {
    if (!p.node || !desired.some((n) => n.name === p.node)) {
      p.node = desired[fnv1a(p.meta.name) % desired.length].name;
      if (p.status === 'Running') {
        p.status = 'ContainerCreating';
        p.nextTransition = t(2500);
      }
    }
  }
}

export function kubeOf(cluster: Resource): KubeState {
  if (!cluster.data) cluster.data = {};
  if (!cluster.data.k8s) cluster.data.k8s = emptyKube();
  return cluster.data.k8s as KubeState;
}

export function clusterRunning(cluster: Resource): boolean {
  return cluster.properties.powerState?.code !== 'Stopped' && cluster.properties.provisioningState === 'Succeeded';
}

export function kubeletPrincipal(cluster: Resource): PrincipalRef | null {
  const k = cluster.properties.identityProfile?.kubeletidentity;
  if (!k?.objectId) return null;
  return { type: 'ServicePrincipal', objectId: k.objectId, name: k.clientId, displayName: `${cluster.name}-agentpool` };
}

export function findRegistryByLoginServer(server: string, s: CloudState = getState()): Resource | undefined {
  return s.resources.find((r) => ciEq(r.type, 'Microsoft.ContainerRegistry/registries') && ciEq(r.properties.loginServer, server));
}

export interface ImageResolution {
  ok: boolean;
  pkg?: AppPackage;
  reason?: 'notfound' | 'unauthorized' | 'unknown';
  message?: string;
  size?: number;
}

/** Resuelve una imagen de contenedor para un consumidor (identidad) concreto. */
export function resolveImage(image: string, puller: PrincipalRef | null, s: CloudState = getState(), creds?: { username: string; password: string } | null): ImageResolution {
  const { repo, tag, registry } = normalizeImageName(image);
  if (registry && registry.endsWith('.azurecr.io')) {
    const reg = findRegistryByLoginServer(registry, s);
    if (!reg) return { ok: false, reason: 'unknown', message: `failed to resolve reference "${image}": failed to do request: Head "https://${registry}/v2/${repo}/manifests/${tag}": dial tcp: lookup ${registry}: no such host` };
    let authorized = false;
    if (creds) {
      const admin = reg.properties.adminUserEnabled && ciEq(creds.username, reg.name) && (reg.data?.passwords ?? []).some((p: any) => p.value === creds.password);
      const sp = s.servicePrincipals.find((x) => x.appId === creds.username && x.secrets.includes(creds.password));
      authorized = !!admin || (!!sp && hasPermission({ type: 'ServicePrincipal', objectId: sp.id, name: sp.appId, displayName: sp.displayName }, 'Microsoft.ContainerRegistry/registries/pull/read', reg.id, false, s));
    } else if (puller) {
      authorized = hasPermission(puller, 'Microsoft.ContainerRegistry/registries/pull/read', reg.id, false, s);
    }
    if (reg.properties.anonymousPullEnabled) authorized = true;
    if (!authorized) {
      return {
        ok: false,
        reason: 'unauthorized',
        message: `failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://${registry}/oauth2/token?scope=repository%3A${repo}%3Apull&service=${registry}: 401 Unauthorized`,
      };
    }
    const t = reg.data?.repos?.[repo]?.tags?.[tag];
    if (!t) return { ok: false, reason: 'notfound', message: `rpc error: code = NotFound desc = failed to pull and unpack image "${registry}/${repo}:${tag}": failed to resolve reference "${registry}/${repo}:${tag}": ${registry}/${repo}:${tag}: not found` };
    const pkg: AppPackage = t.publicImage && !Object.keys(t.files ?? {}).length ? { files: {}, publicImage: t.publicImage } : { files: t.files ?? {}, env: t.env ?? {} };
    return { ok: true, pkg, size: t.size };
  }
  const pub = findPublicImage(image);
  if (pub) return { ok: true, pkg: { files: {}, publicImage: pub.name }, size: pub.size };
  return {
    ok: false,
    reason: 'notfound',
    message: `rpc error: code = Unknown desc = failed to pull and unpack image "docker.io/library/${repo}:${tag}": failed to resolve reference "docker.io/library/${repo}:${tag}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`,
  };
}

function podEvent(k: KubeState, pod: KPod, type: KEvent['type'], reason: string, message: string, from = 'kubelet') {
  const obj = `pod/${pod.meta.name}`;
  const prev = pod.events.find((e) => e.reason === reason && e.message === message);
  if (prev) {
    prev.count++;
    prev.time = nowIso();
  } else pod.events.push({ type, reason, message, object: obj, time: nowIso(), count: 1, from });
  const prevGlobal = k.events.find((e) => e.object === obj && e.reason === reason && e.message === message);
  if (prevGlobal) {
    prevGlobal.count++;
    prevGlobal.time = nowIso();
  } else k.events.push({ type, reason, message, object: obj, time: nowIso(), count: 1, from });
  if (k.events.length > 300) k.events = k.events.slice(-200);
}

function newPod(k: KubeState, cluster: Resource, name: string, ns: string, labels: Record<string, string>, containers: KContainer[], owner?: KPod['owner']): KPod {
  const node = k.nodes.length ? k.nodes[fnv1a(name) % k.nodes.length].name : null;
  const pod: KPod = {
    meta: meta(name, ns, labels),
    owner,
    node,
    status: 'Pending',
    ip: null,
    containers: JSON.parse(JSON.stringify(containers)),
    restarts: 0,
    createdAt: Date.now(),
    nextTransition: t(600),
    events: [],
  };
  if (node) podEvent(k, pod, 'Normal', 'Scheduled', `Successfully assigned ${ns}/${name} to ${node}`, 'default-scheduler');
  else podEvent(k, pod, 'Warning', 'FailedScheduling', '0/0 nodes are available: no nodes available to schedule pods.', 'default-scheduler');
  k.pods.push(pod);
  void cluster;
  return pod;
}

function templateHash(template: any): string {
  return k8sSuffix(JSON.stringify(template), 10);
}

function labelsMatch(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector);
  return keys.length > 0 && keys.every((key) => labels[key] === selector[key]);
}

function envOf(c: KContainer, k: KubeState, ns: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of c.env ?? []) {
    if (e.value !== undefined) out[e.name] = String(e.value);
    else if (e.valueFrom?.configMapKeyRef) {
      const cm = k.configmaps.find((x) => x.meta.namespace === ns && x.meta.name === e.valueFrom.configMapKeyRef.name);
      if (cm) out[e.name] = cm.data[e.valueFrom.configMapKeyRef.key] ?? '';
    } else if (e.valueFrom?.secretKeyRef) {
      const sec = k.secrets.find((x) => x.meta.namespace === ns && x.meta.name === e.valueFrom.secretKeyRef.name);
      if (sec) out[e.name] = sec.data[e.valueFrom.secretKeyRef.key] ?? '';
    }
  }
  return out;
}

/** Hace avanzar el estado del clúster (pods, rollouts, IPs externas). Se llama antes de cada lectura. */
export function refreshKube(cluster: Resource, s: CloudState = getState()) {
  const k = kubeOf(cluster);
  const now = Date.now();
  let dirty = false;
  const puller = kubeletPrincipal(cluster);
  if (!clusterRunning(cluster)) return;
  // 1) reconciliar deployments -> replicasets -> pods
  for (const d of k.deployments) {
    const ns = d.meta.namespace;
    const hash = templateHash(d.template);
    let rs = k.replicasets.find((r) => r.owner === d.meta.name && r.meta.namespace === ns && r.hash === hash);
    if (!rs) {
      d.revision = (d.revision ?? 0) + 1;
      rs = { meta: meta(`${d.meta.name}-${hash}`, ns, { ...d.template.labels, 'pod-template-hash': hash }), owner: d.meta.name, hash, revision: d.revision, replicas: d.replicas, template: JSON.parse(JSON.stringify(d.template)) };
      k.replicasets.push(rs);
      d.history.push({ revision: d.revision, images: d.template.containers.map((c) => c.image).join(','), changeCause: d.meta.annotations['kubernetes.io/change-cause'] ?? '<none>', templateHash: hash, template: JSON.parse(JSON.stringify(d.template)) });
      dirty = true;
    }
    rs.revision = d.revision;
    rs.replicas = d.replicas;
    const mine = k.pods.filter((p) => p.owner?.name === rs!.meta.name && p.meta.namespace === ns && p.status !== 'Terminating');
    if (mine.length < d.replicas) {
      for (let i = mine.length; i < d.replicas; i++) {
        newPod(k, cluster, `${rs.meta.name}-${k8sSuffix(rs.meta.name + now + i + Math.random(), 5)}`, ns, { ...d.template.labels, 'pod-template-hash': hash }, d.template.containers, { kind: 'ReplicaSet', name: rs.meta.name });
      }
      dirty = true;
    } else if (mine.length > d.replicas) {
      for (const p of mine.slice(d.replicas)) {
        p.status = 'Terminating';
        p.deleteAt = t(1500);
      }
      dirty = true;
    }
    // escalar a cero los RS antiguos sólo cuando el nuevo está listo (rolling update)
    const ready = k.pods.filter((p) => p.owner?.name === rs!.meta.name && p.status === 'Running').length;
    for (const old of k.replicasets.filter((r) => r.owner === d.meta.name && r.meta.namespace === ns && r !== rs)) {
      const oldPods = k.pods.filter((p) => p.owner?.name === old.meta.name && p.status !== 'Terminating');
      if (ready >= d.replicas || d.replicas === 0) {
        old.replicas = 0;
        for (const p of oldPods) {
          p.status = 'Terminating';
          p.deleteAt = t(1500);
        }
        if (oldPods.length) dirty = true;
      }
    }
  }
  // 2) ciclo de vida de pods
  for (const pod of k.pods) {
    if (pod.system) continue;
    if (pod.status === 'Terminating') {
      if (pod.deleteAt && now >= pod.deleteAt) {
        pod.deleteAt = -1;
        dirty = true;
      }
      continue;
    }
    if (!pod.node) continue;
    if (now < pod.nextTransition) continue;
    const c = pod.containers[0];
    switch (pod.status) {
      case 'Pending':
        pod.status = 'ContainerCreating';
        pod.ip = `10.244.${Math.floor(k.ipCounter / 250)}.${(k.ipCounter++ % 250) + 2}`;
        podEvent(k, pod, 'Normal', 'Pulling', `Pulling image "${c.image}"`);
        pod.nextTransition = t(1800);
        dirty = true;
        break;
      case 'ContainerCreating':
      case 'ErrImagePull':
      case 'ImagePullBackOff': {
        const res = resolveImage(c.image, puller, s);
        if (!res.ok) {
          pod.pullError = res.message;
          if (pod.status === 'ContainerCreating') {
            pod.status = 'ErrImagePull';
            podEvent(k, pod, 'Warning', 'Failed', `Failed to pull image "${c.image}": ${res.message}`);
            podEvent(k, pod, 'Warning', 'Failed', 'Error: ErrImagePull');
            pod.nextTransition = t(3000);
          } else if (pod.status === 'ErrImagePull') {
            pod.status = 'ImagePullBackOff';
            podEvent(k, pod, 'Normal', 'BackOff', `Back-off pulling image "${c.image}"`);
            podEvent(k, pod, 'Warning', 'Failed', 'Error: ImagePullBackOff');
            pod.nextTransition = t(5000);
          } else {
            pod.status = 'ErrImagePull';
            podEvent(k, pod, 'Normal', 'Pulling', `Pulling image "${c.image}"`);
            pod.nextTransition = t(2500);
          }
          dirty = true;
          break;
        }
        pod.pullError = undefined;
        podEvent(k, pod, 'Normal', 'Pulled', `Successfully pulled image "${c.image}" in 2.13s. Image size: ${Math.round((res.size ?? 50) * 1048576)} bytes.`);
        podEvent(k, pod, 'Normal', 'Created', `Created container ${c.name}`);
        podEvent(k, pod, 'Normal', 'Started', `Started container ${c.name}`);
        const startErr = appStartError({ ...res.pkg!, env: { ...(res.pkg!.env ?? {}), ...envOf(c, k, pod.meta.namespace) } });
        if (startErr) {
          pod.status = 'CrashLoopBackOff';
          pod.restarts++;
          podEvent(k, pod, 'Warning', 'BackOff', `Back-off restarting failed container ${c.name} in pod ${pod.meta.name}`);
          pod.nextTransition = t(6000);
        } else {
          pod.status = 'Running';
        }
        dirty = true;
        break;
      }
      case 'CrashLoopBackOff': {
        pod.restarts++;
        const res = resolveImage(c.image, puller, s);
        const err = res.ok ? appStartError({ ...res.pkg!, env: envOf(c, k, pod.meta.namespace) }) : 'pull error';
        if (!err) pod.status = 'Running';
        pod.nextTransition = t(Math.min(30000, 4000 * pod.restarts));
        dirty = true;
        break;
      }
    }
  }
  const before = k.pods.length;
  k.pods = k.pods.filter((p) => p.deleteAt !== -1);
  if (k.pods.length !== before) dirty = true;
  // limpiar RS antiguos (dejar historial de revisiones)
  // 3) servicios LoadBalancer
  for (const svc of k.services) {
    if (svc.type !== 'LoadBalancer' || svc.externalIP) continue;
    if (svc.externalReadyAt && now >= svc.externalReadyAt) {
      const ip = randomPublicIp(cluster.id + svc.meta.uid);
      svc.externalIP = ip;
      try {
        const nodeRg = cluster.properties.nodeResourceGroup;
        if (findRg(cluster.subscriptionId, nodeRg, s)) {
          createImmediate({ type: 'Microsoft.Network/publicIPAddresses', name: `kubernetes-a${shortHash(svc.meta.uid, 31)}`, location: cluster.location, sku: { name: 'Standard' }, tags: { 'k8s-azure-service': `${svc.meta.namespace}/${svc.meta.name}`, 'k8s-azure-cluster-name': 'kubernetes' }, properties: {} }, nodeRg, cluster.subscriptionId);
          const pip = s.resources.find((r) => ciEq(r.resourceGroup, nodeRg) && r.tags['k8s-azure-service'] === `${svc.meta.namespace}/${svc.meta.name}`);
          if (pip) pip.properties.ipAddress = ip;
        }
      } catch {
        /* sin grupo de nodos */
      }
      dirty = true;
    }
  }
  if (dirty) changed();
}

export function allClusters(s: CloudState = getState()): Resource[] {
  return s.resources.filter((r) => ciEq(r.type, 'Microsoft.ContainerService/managedClusters'));
}

/** Avanza todos los clústeres (llamado por el reloj del simulador). */
export function tickKube(s: CloudState = getState()) {
  for (const c of allClusters(s)) refreshKube(c, s);
}

// ---------------------------------------------------------------- operaciones

export function ensureNamespace(k: KubeState, ns: string) {
  if (!k.namespaces.some((n) => n.name === ns)) throw new Error(`Error from server (NotFound): namespaces "${ns}" not found`);
}

export interface ApplyResult {
  kind: string;
  name: string;
  action: 'created' | 'configured' | 'unchanged';
}

function normContainers(list: any[]): KContainer[] {
  return (list ?? []).map((c) => ({
    name: String(c.name ?? 'app'),
    image: String(c.image ?? ''),
    ports: (c.ports ?? []).map((p: any) => ({ containerPort: Number(p.containerPort), protocol: p.protocol ?? 'TCP' })),
    env: (c.env ?? []).map((e: any) => ({ name: String(e.name), value: e.value !== undefined ? String(e.value) : undefined, valueFrom: e.valueFrom })),
    resources: c.resources,
  }));
}

export function applyObject(cluster: Resource, obj: any, defaultNs = 'default'): ApplyResult {
  const k = kubeOf(cluster);
  if (!obj || typeof obj !== 'object') throw new Error('error: error validating data: invalid object');
  const kind = String(obj.kind ?? '');
  const name = obj.metadata?.name;
  if (!kind) throw new Error('error: error validating data: kind not set');
  if (!name) throw new Error(`error: error validating data: ValidationError(${kind}.metadata): missing required field "name"`);
  const ns = obj.metadata?.namespace ?? defaultNs;
  const labels = obj.metadata?.labels ?? {};
  const annotations = obj.metadata?.annotations ?? {};
  const lower = kind.toLowerCase();
  if (lower !== 'namespace') ensureNamespace(k, ns);
  switch (lower) {
    case 'namespace': {
      if (k.namespaces.some((n) => n.name === name)) return { kind: 'namespace', name, action: 'unchanged' };
      k.namespaces.push({ name, created: nowIso(), status: 'Active' });
      changed();
      return { kind: 'namespace', name, action: 'created' };
    }
    case 'deployment': {
      const spec = obj.spec ?? {};
      const selector = spec.selector?.matchLabels ?? {};
      const tplLabels = spec.template?.metadata?.labels ?? {};
      if (!Object.keys(selector).length) throw new Error(`The Deployment "${name}" is invalid: spec.selector: Required value`);
      if (!labelsMatch(selector, tplLabels)) throw new Error(`The Deployment "${name}" is invalid: spec.template.metadata.labels: Invalid value: ${JSON.stringify(tplLabels)}: \`selector\` does not match template \`labels\``);
      const containers = normContainers(spec.template?.spec?.containers);
      if (!containers.length || containers.some((c) => !c.image)) throw new Error(`The Deployment "${name}" is invalid: spec.template.spec.containers[0].image: Required value`);
      const existing = k.deployments.find((d) => d.meta.name === name && d.meta.namespace === ns);
      const template = { labels: tplLabels, containers };
      const replicas = spec.replicas === undefined ? 1 : Number(spec.replicas);
      if (existing) {
        const same = JSON.stringify(existing.template) === JSON.stringify(template) && existing.replicas === replicas;
        if (JSON.stringify(existing.selector) !== JSON.stringify(selector)) throw new Error(`The Deployment "${name}" is invalid: spec.selector: Invalid value: field is immutable`);
        existing.template = template;
        existing.replicas = replicas;
        existing.meta.labels = labels;
        existing.meta.annotations = { ...existing.meta.annotations, ...annotations };
        changed();
        return { kind: 'deployment.apps', name, action: same ? 'unchanged' : 'configured' };
      }
      k.deployments.push({ meta: meta(name, ns, labels, annotations), replicas, selector, template, revision: 0, history: [] });
      changed();
      refreshKube(cluster);
      return { kind: 'deployment.apps', name, action: 'created' };
    }
    case 'service': {
      const spec = obj.spec ?? {};
      const type = (spec.type ?? 'ClusterIP') as KService['type'];
      if (!['ClusterIP', 'NodePort', 'LoadBalancer'].includes(type)) throw new Error(`The Service "${name}" is invalid: spec.type: Unsupported value: "${type}"`);
      const ports = (spec.ports ?? []).map((p: any) => ({ name: p.name, port: Number(p.port), targetPort: Number(p.targetPort ?? p.port), protocol: p.protocol ?? 'TCP', nodePort: type !== 'ClusterIP' ? 30000 + (fnv1a(name + p.port) % 2767) : undefined }));
      if (!ports.length) throw new Error(`The Service "${name}" is invalid: spec.ports: Required value`);
      const existing = k.services.find((sv) => sv.meta.name === name && sv.meta.namespace === ns);
      if (existing) {
        const same = existing.type === type && JSON.stringify(existing.ports) === JSON.stringify(ports) && JSON.stringify(existing.selector) === JSON.stringify(spec.selector ?? {});
        existing.selector = spec.selector ?? {};
        existing.ports = ports;
        if (existing.type !== type) {
          existing.type = type;
          existing.externalIP = null;
          existing.externalReadyAt = type === 'LoadBalancer' ? t(4000) : undefined;
        }
        changed();
        return { kind: 'service', name, action: same ? 'unchanged' : 'configured' };
      }
      k.services.push({ meta: meta(name, ns, labels, annotations), type, selector: spec.selector ?? {}, ports, clusterIP: `10.0.${Math.floor(k.svcCounter / 250)}.${(k.svcCounter++ % 250) + 2}`, externalIP: null, externalReadyAt: type === 'LoadBalancer' ? t(4000) : undefined });
      changed();
      return { kind: 'service', name, action: 'created' };
    }
    case 'configmap':
    case 'secret': {
      const list = lower === 'configmap' ? k.configmaps : k.secrets;
      let data: Record<string, string> = { ...(obj.data ?? {}) };
      if (lower === 'secret') {
        const decoded: Record<string, string> = {};
        for (const [key, v] of Object.entries(data)) {
          try {
            decoded[key] = atob(String(v));
          } catch {
            decoded[key] = String(v);
          }
        }
        data = { ...decoded, ...(obj.stringData ?? {}) };
      }
      const existing = list.find((x) => x.meta.name === name && x.meta.namespace === ns);
      if (existing) {
        const same = JSON.stringify(existing.data) === JSON.stringify(data);
        existing.data = data;
        changed();
        return { kind: lower, name, action: same ? 'unchanged' : 'configured' };
      }
      list.push({ meta: meta(name, ns, labels), data, type: obj.type ?? (lower === 'secret' ? 'Opaque' : undefined) });
      changed();
      return { kind: lower, name, action: 'created' };
    }
    case 'pod': {
      const containers = normContainers(obj.spec?.containers);
      if (k.pods.some((p) => p.meta.name === name && p.meta.namespace === ns)) return { kind: 'pod', name, action: 'unchanged' };
      newPod(k, cluster, name, ns, labels, containers, { kind: 'None', name: '' });
      changed();
      return { kind: 'pod', name, action: 'created' };
    }
    case 'horizontalpodautoscaler': {
      const spec = obj.spec ?? {};
      const target = spec.scaleTargetRef?.name;
      const cpu = spec.metrics?.[0]?.resource?.target?.averageUtilization ?? spec.targetCPUUtilizationPercentage ?? 80;
      k.hpas = k.hpas.filter((h) => !(h.meta.name === name && h.meta.namespace === ns));
      k.hpas.push({ meta: meta(name, ns), target, min: spec.minReplicas ?? 1, max: spec.maxReplicas ?? 5, cpu });
      changed();
      return { kind: 'horizontalpodautoscaler.autoscaling', name, action: 'created' };
    }
    case 'ingress': {
      k.ingresses = k.ingresses.filter((h) => !(h.meta.name === name && h.meta.namespace === ns));
      k.ingresses.push({ meta: meta(name, ns, labels), rules: obj.spec?.rules ?? [] });
      changed();
      return { kind: 'ingress.networking.k8s.io', name, action: 'created' };
    }
    default:
      throw new Error(`error: resource mapping not found for name: "${name}" namespace: "${ns}" from "manifest": no matches for kind "${kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first`);
  }
}

export function createDeployment(cluster: Resource, name: string, image: string, replicas = 1, ns = 'default', port?: number) {
  return applyObject(cluster, {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ns, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: image.split('/').pop()!.split(':')[0].replace(/[^a-z0-9-]/g, '-'), image, ports: port ? [{ containerPort: port }] : [] }] } } },
  });
}

export function findDeployment(k: KubeState, name: string, ns: string): KDeployment {
  const d = k.deployments.find((x) => x.meta.name === name && x.meta.namespace === ns);
  if (!d) throw new Error(`Error from server (NotFound): deployments.apps "${name}" not found`);
  return d;
}

export function scaleDeployment(cluster: Resource, name: string, replicas: number, ns = 'default') {
  const k = kubeOf(cluster);
  const d = findDeployment(k, name, ns);
  d.replicas = replicas;
  changed();
  refreshKube(cluster);
}

export function setImage(cluster: Resource, name: string, container: string, image: string, ns = 'default') {
  const k = kubeOf(cluster);
  const d = findDeployment(k, name, ns);
  const c = container === '*' ? d.template.containers[0] : d.template.containers.find((x) => x.name === container);
  if (!c) throw new Error(`error: unable to find container named "${container}"`);
  d.template = JSON.parse(JSON.stringify(d.template));
  (container === '*' ? d.template.containers : d.template.containers.filter((x) => x.name === container)).forEach((x) => (x.image = image));
  changed();
  refreshKube(cluster);
}

export function rolloutUndo(cluster: Resource, name: string, ns = 'default', toRevision?: number) {
  const k = kubeOf(cluster);
  const d = findDeployment(k, name, ns);
  if (d.history.length < 2 && !toRevision) throw new Error(`error: no rollout history found for deployment "${name}"`);
  const target = toRevision ? d.history.find((h) => h.revision === toRevision) : d.history[d.history.length - 2];
  if (!target) throw new Error(`error: unable to find specified revision ${toRevision} in history`);
  d.template = JSON.parse(JSON.stringify(target.template));
  // reutiliza el RS antiguo
  const rs = k.replicasets.find((r) => r.owner === name && r.meta.namespace === ns && r.hash === target.templateHash);
  if (rs) {
    d.revision += 1;
    rs.revision = d.revision;
    d.history = d.history.filter((h) => h.templateHash !== target.templateHash);
    d.history.push({ ...target, revision: d.revision });
  }
  changed();
  refreshKube(cluster);
}

export function deleteObject(cluster: Resource, kind: string, name: string, ns = 'default'): string {
  const k = kubeOf(cluster);
  const lk = kind.toLowerCase();
  const nf = (res: string) => new Error(`Error from server (NotFound): ${res} "${name}" not found`);
  if (['deployment', 'deployments', 'deploy', 'deployment.apps'].includes(lk)) {
    const d = k.deployments.find((x) => x.meta.name === name && x.meta.namespace === ns);
    if (!d) throw nf('deployments.apps');
    k.deployments = k.deployments.filter((x) => x !== d);
    const rsNames = k.replicasets.filter((r) => r.owner === name && r.meta.namespace === ns).map((r) => r.meta.name);
    k.replicasets = k.replicasets.filter((r) => !rsNames.includes(r.meta.name));
    for (const p of k.pods.filter((p) => p.owner && rsNames.includes(p.owner.name))) {
      p.status = 'Terminating';
      p.deleteAt = t(1500);
    }
    changed();
    return `deployment.apps "${name}" deleted`;
  }
  if (['service', 'services', 'svc'].includes(lk)) {
    const sv = k.services.find((x) => x.meta.name === name && x.meta.namespace === ns);
    if (!sv) throw nf('services');
    k.services = k.services.filter((x) => x !== sv);
    changed();
    return `service "${name}" deleted`;
  }
  if (['pod', 'pods', 'po'].includes(lk)) {
    const p = k.pods.find((x) => x.meta.name === name && x.meta.namespace === ns);
    if (!p) throw nf('pods');
    p.status = 'Terminating';
    p.deleteAt = t(1200);
    changed();
    return `pod "${name}" deleted`;
  }
  if (['namespace', 'namespaces', 'ns'].includes(lk)) {
    if (['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(name)) throw new Error(`Error from server (Forbidden): namespaces "${name}" is forbidden: this namespace may not be deleted`);
    if (!k.namespaces.some((n) => n.name === name)) throw nf('namespaces');
    k.namespaces = k.namespaces.filter((n) => n.name !== name);
    k.deployments = k.deployments.filter((x) => x.meta.namespace !== name);
    k.replicasets = k.replicasets.filter((x) => x.meta.namespace !== name);
    k.pods = k.pods.filter((x) => x.meta.namespace !== name);
    k.services = k.services.filter((x) => x.meta.namespace !== name);
    k.configmaps = k.configmaps.filter((x) => x.meta.namespace !== name);
    k.secrets = k.secrets.filter((x) => x.meta.namespace !== name);
    changed();
    return `namespace "${name}" deleted`;
  }
  if (['configmap', 'configmaps', 'cm', 'secret', 'secrets'].includes(lk)) {
    const isCm = lk.startsWith('c');
    const list = isCm ? k.configmaps : k.secrets;
    const item = list.find((x) => x.meta.name === name && x.meta.namespace === ns);
    if (!item) throw nf(isCm ? 'configmaps' : 'secrets');
    if (isCm) k.configmaps = k.configmaps.filter((x) => x !== item);
    else k.secrets = k.secrets.filter((x) => x !== item);
    changed();
    return `${isCm ? 'configmap' : 'secret'} "${name}" deleted`;
  }
  if (['hpa', 'horizontalpodautoscaler'].includes(lk)) {
    k.hpas = k.hpas.filter((h) => !(h.meta.name === name && h.meta.namespace === ns));
    changed();
    return `horizontalpodautoscaler.autoscaling "${name}" deleted`;
  }
  throw new Error(`error: the server doesn't have a resource type "${kind}"`);
}

export function exposeDeployment(cluster: Resource, name: string, type: KService['type'], port: number, targetPort: number | undefined, ns = 'default', svcName?: string) {
  const k = kubeOf(cluster);
  const d = findDeployment(k, name, ns);
  const tp = targetPort ?? d.template.containers[0]?.ports?.[0]?.containerPort ?? port;
  return applyObject(cluster, { apiVersion: 'v1', kind: 'Service', metadata: { name: svcName ?? name, namespace: ns, labels: d.meta.labels }, spec: { type, selector: d.selector, ports: [{ port, targetPort: tp, protocol: 'TCP' }] } });
}

export function podLogs(cluster: Resource, pod: KPod, s: CloudState = getState()): string[] {
  const k = kubeOf(cluster);
  if (pod.status === 'Pending' || pod.status === 'ContainerCreating') return [`Error from server (BadRequest): container "${pod.containers[0].name}" in pod "${pod.meta.name}" is waiting to start: ContainerCreating`];
  if (pod.status === 'ErrImagePull' || pod.status === 'ImagePullBackOff') return [`Error from server (BadRequest): container "${pod.containers[0].name}" in pod "${pod.meta.name}" is waiting to start: trying and failing to pull image`];
  if (pod.system) return [`I${new Date().toISOString()} 1 server.go:79] ${pod.containers[0].name} ready`];
  const res = resolveImage(pod.containers[0].image, kubeletPrincipal(cluster), s);
  if (!res.ok) return [];
  const pkg = { ...res.pkg!, env: { ...(res.pkg!.env ?? {}), ...envOf(pod.containers[0], k, pod.meta.namespace) } };
  const lines = startupLog(pkg);
  const hits = s.events.filter((e) => e.kind === 'k8s' && e.detail === pod.meta.name).slice(-20);
  for (const h of hits) lines.push(`${new Date(h.t).toISOString()} GET ${h.path ?? '/'} ${h.status}`);
  return lines;
}

/** Busca un servicio por IP externa y responde como lo haría el pod correspondiente. */
export function serviceHttp(ip: string, port: number, path: string, s: CloudState = getState()): { handled: boolean; response?: HttpResponse; error?: string } {
  for (const cluster of allClusters(s)) {
    const k = kubeOf(cluster);
    refreshKube(cluster, s);
    const svc = k.services.find((sv) => sv.externalIP === ip);
    if (!svc) continue;
    const p = svc.ports.find((x) => x.port === port);
    if (!p) return { handled: true, error: `curl: (28) Failed to connect to ${ip} port ${port} after 21039 ms: Timeout was reached` };
    if (!clusterRunning(cluster)) return { handled: true, error: `curl: (28) Failed to connect to ${ip} port ${port} after 21039 ms: Timeout was reached` };
    const pods = k.pods.filter((pod) => pod.meta.namespace === svc.meta.namespace && pod.status === 'Running' && labelsMatch(svc.selector, pod.meta.labels));
    if (!pods.length) return { handled: true, error: `curl: (52) Empty reply from server\n# El servicio no tiene endpoints listos: ningún pod en estado Running coincide con el selector ${JSON.stringify(svc.selector)}.` };
    const pod = pods[Math.floor(Math.random() * pods.length)];
    const c = pod.containers[0];
    const res = resolveImage(c.image, kubeletPrincipal(cluster), s);
    if (!res.ok) return { handled: true, error: 'curl: (52) Empty reply from server' };
    const env = { ...(res.pkg!.env ?? {}), ...envOf(c, k, pod.meta.namespace), HOSTNAME: pod.meta.name };
    const pkg = { ...res.pkg!, env };
    const listen = appListenPort(pkg);
    if (listen !== p.targetPort) {
      return { handled: true, error: `curl: (52) Empty reply from server\n# El servicio reenvía al puerto ${p.targetPort} del pod, pero la aplicación escucha en el ${listen}. Revisa targetPort.` };
    }
    const response = renderApp(pkg, path, env);
    s.events.push({ t: Date.now(), kind: 'k8s', resourceId: cluster.id, status: response.status, detail: pod.meta.name, path });
    changed();
    return { handled: true, response };
  }
  return { handled: false };
}

export function getClusterById(id: string, s: CloudState = getState()): Resource | undefined {
  return s.resources.find((r) => ciEq(r.id, id));
}

export function podAge(createdIso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(createdIso).getTime()) / 1000));
  if (secs < 120) return `${secs}s`;
  if (secs < 7200) return `${Math.floor(secs / 60)}m`;
  if (secs < 172800) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export function podReady(p: KPod): string {
  return `${p.status === 'Running' ? p.containers.length : 0}/${p.containers.length}`;
}
