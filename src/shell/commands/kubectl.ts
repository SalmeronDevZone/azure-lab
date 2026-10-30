// kubectl simulado contra los clústeres AKS del simulador.
import { loadAll, dump } from 'js-yaml';
import type { CommandDef, CmdCtx } from '../interp';
import type { Resource } from '../../engine/types';
import { C, delay, eprintln, hint, parseFlags, println, table } from './util';
import { getState, changed, speedFactor } from '../../engine/store';
import { ciEq } from '../../engine/util';
import { parseKubeconfig, setCurrentContext, setContextNamespace } from '../../engine/services/kubeconfig';
import {
  allClusters, applyObject, clusterRunning, createDeployment, deleteObject, exposeDeployment, findDeployment, kubeOf, kubeletPrincipal, podAge, podLogs, podReady,
  refreshKube, resolveImage, rolloutUndo, scaleDeployment, setImage, meta, type KPod, type KubeState,
} from '../../engine/services/kube';
import { renderApp, appListenPort } from '../../engine/services/appRuntime';

const CLIENT_VERSION = 'v1.32.6';

interface KCtx {
  cluster: Resource;
  ns: string;
  allNs: boolean;
  contextName: string;
}

function kubeconfigPath(ctx: CmdCtx): string {
  return ctx.sess.env.KUBECONFIG ? ctx.sess.resolve(ctx.sess.env.KUBECONFIG.split(':')[0]) : `${ctx.sess.home}/.kube/config`;
}

function readConfig(ctx: CmdCtx) {
  const p = kubeconfigPath(ctx);
  return parseKubeconfig(ctx.sess.fs.isFile(p) ? ctx.sess.fs.readFile(p) : undefined);
}

const CONN_REFUSED = `E1026 10:00:00.000000    4242 memcache.go:265] couldn't get current server API group list: Get "http://localhost:8080/api?timeout=32s": dial tcp 127.0.0.1:8080: connect: connection refused\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?`;

function resolveContext(ctx: CmdCtx, nsFlag?: string, allNs = false, contextFlag?: string): KCtx | null {
  const cfg = readConfig(ctx);
  if (!cfg || !cfg.contexts.length) {
    eprintln(ctx.io, CONN_REFUSED);
    hint(ctx.io, 'kubectl no tiene ningún clúster configurado. Ejecuta: az aks get-credentials -g <grupo> -n <clúster>');
    return null;
  }
  const name = contextFlag ?? cfg.current;
  const kc = cfg.contexts.find((c) => c.name === name);
  if (!kc) {
    eprintln(ctx.io, `error: context "${name}" does not exist`);
    return null;
  }
  const host = kc.server.replace(/^https:\/\//, '').replace(/:\d+$/, '');
  const cluster = allClusters().find((c) => ciEq(c.properties.fqdn, host));
  if (!cluster || !clusterRunning(cluster)) {
    eprintln(ctx.io, `Unable to connect to the server: dial tcp: lookup ${host}${cluster ? ': i/o timeout' : ': no such host'}`);
    if (cluster) hint(ctx.io, `El clúster "${cluster.name}" está detenido. Inícialo con: az aks start -g ${cluster.resourceGroup} -n ${cluster.name}`);
    else hint(ctx.io, 'El clúster de este contexto ya no existe. Revisa "kubectl config get-contexts" o vuelve a ejecutar az aks get-credentials.');
    return null;
  }
  refreshKube(cluster);
  return { cluster, ns: nsFlag ?? kc.namespace ?? 'default', allNs, contextName: name };
}

const ALIASES: Record<string, string> = {
  po: 'pods', pod: 'pods', pods: 'pods',
  deploy: 'deployments', deployment: 'deployments', deployments: 'deployments', 'deployment.apps': 'deployments',
  rs: 'replicasets', replicaset: 'replicasets', replicasets: 'replicasets',
  svc: 'services', service: 'services', services: 'services',
  no: 'nodes', node: 'nodes', nodes: 'nodes',
  ns: 'namespaces', namespace: 'namespaces', namespaces: 'namespaces',
  cm: 'configmaps', configmap: 'configmaps', configmaps: 'configmaps',
  secret: 'secrets', secrets: 'secrets',
  ev: 'events', event: 'events', events: 'events',
  hpa: 'hpa', horizontalpodautoscaler: 'hpa', horizontalpodautoscalers: 'hpa',
  ing: 'ingresses', ingress: 'ingresses', ingresses: 'ingresses',
  ep: 'endpoints', endpoints: 'endpoints',
  all: 'all',
};

function nsFilter<T extends { meta: { namespace: string } }>(list: T[], k: KCtx): T[] {
  return k.allNs ? list : list.filter((x) => x.meta.namespace === k.ns);
}

function labelMatch(labels: Record<string, string>, sel?: string): boolean {
  if (!sel) return true;
  return sel.split(',').every((pair) => {
    const neg = pair.includes('!=');
    const [k, v] = pair.split(/!?=/);
    if (v === undefined) return k in labels;
    return neg ? labels[k] !== v : labels[k] === v;
  });
}

function svcPorts(s: KubeState['services'][number]) {
  return s.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`).join(',');
}

function podObj(p: KPod, cluster: Resource) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: p.meta.name, namespace: p.meta.namespace, labels: p.meta.labels, uid: p.meta.uid, creationTimestamp: p.meta.creationTimestamp, ownerReferences: p.owner?.name ? [{ kind: p.owner.kind, name: p.owner.name }] : [] },
    spec: { containers: p.containers.map((c) => ({ name: c.name, image: c.image, ports: c.ports, env: c.env })), nodeName: p.node },
    status: { phase: p.status === 'Running' ? 'Running' : p.status === 'Completed' ? 'Succeeded' : 'Pending', podIP: p.ip, hostIP: p.node ? '10.224.0.4' : undefined, containerStatuses: p.containers.map((c) => ({ name: c.name, image: c.image, ready: p.status === 'Running', restartCount: p.restarts, state: p.status === 'Running' ? { running: { startedAt: p.meta.creationTimestamp } } : { waiting: { reason: p.status, message: p.pullError } } })) },
  };
}

function deployObj(d: KubeState['deployments'][number], k: KubeState) {
  const pods = k.pods.filter((p) => p.meta.namespace === d.meta.namespace && Object.entries(d.selector).every(([a, b]) => p.meta.labels[a] === b) && p.status !== 'Terminating');
  const ready = pods.filter((p) => p.status === 'Running').length;
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: d.meta.name, namespace: d.meta.namespace, labels: d.meta.labels, annotations: { 'deployment.kubernetes.io/revision': String(d.revision), ...d.meta.annotations }, creationTimestamp: d.meta.creationTimestamp }, spec: { replicas: d.replicas, selector: { matchLabels: d.selector }, template: { metadata: { labels: d.template.labels }, spec: { containers: d.template.containers } } }, status: { replicas: pods.length, readyReplicas: ready, availableReplicas: ready, updatedReplicas: pods.length } };
}

function svcObj(s: KubeState['services'][number]) {
  return { apiVersion: 'v1', kind: 'Service', metadata: { name: s.meta.name, namespace: s.meta.namespace, labels: s.meta.labels, creationTimestamp: s.meta.creationTimestamp }, spec: { type: s.type, clusterIP: s.clusterIP, selector: s.selector, ports: s.ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.targetPort, nodePort: p.nodePort, protocol: p.protocol })) }, status: { loadBalancer: s.externalIP ? { ingress: [{ ip: s.externalIP }] } : {} } };
}

function jsonpath(obj: any, expr: string): string {
  const inner = expr.replace(/^\{|\}$/g, '').trim();
  const parts = inner.replace(/^\./, '').split(/\.(?![^[]*\])/);
  let cur: any[] = [obj];
  for (const part of parts) {
    if (!part) continue;
    const m = /^([^[]*)(?:\[(\*|\d+|\?\(.*\))\])?$/.exec(part);
    if (!m) return '';
    const [, key, idx] = m;
    cur = cur.flatMap((c) => {
      let v = key ? c?.[key] : c;
      if (idx === undefined) return [v];
      if (!Array.isArray(v)) return [];
      if (idx === '*') return v;
      return [v[Number(idx)]];
    });
  }
  return cur.filter((x) => x !== undefined && x !== null).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
}

function outputObjects(ctx: CmdCtx, objs: any[], output: string, single: boolean) {
  const value = single ? objs[0] : { apiVersion: 'v1', items: objs, kind: 'List', metadata: { resourceVersion: '' } };
  if (output === 'yaml') println(ctx.io, dump(value, { lineWidth: 200, noRefs: true } as any).trimEnd());
  else if (output === 'json') println(ctx.io, JSON.stringify(value, null, 4));
  else if (output === 'name') objs.forEach((o) => println(ctx.io, `${o.kind.toLowerCase()}${o.kind === 'Deployment' ? '.apps' : ''}/${o.metadata.name}`));
  else if (output.startsWith('jsonpath=')) println(ctx.io, jsonpath(value, output.slice(9).replace(/^'|'$/g, '')));
}

function getRows(kind: string, k: KCtx, opts: { wide: boolean; selector?: string; showLabels: boolean; name?: string }): string[][] | null {
  const kube = kubeOf(k.cluster);
  const nsCol = k.allNs ? ['NAMESPACE'] : [];
  const nsVal = (ns: string) => (k.allNs ? [ns] : []);
  const pick = <T extends { meta: { name: string; labels: Record<string, string> } }>(list: T[]) => list.filter((x) => (!opts.name || x.meta.name === opts.name) && labelMatch(x.meta.labels, opts.selector));
  switch (kind) {
    case 'pods': {
      const pods = pick(nsFilter(kube.pods, k));
      const head = [...nsCol, 'NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(opts.wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : []), ...(opts.showLabels ? ['LABELS'] : [])];
      return [head, ...pods.map((p) => [...nsVal(p.meta.namespace), p.meta.name, podReady(p), statusColor(p.status), String(p.restarts), podAge(p.meta.creationTimestamp), ...(opts.wide ? [p.ip ?? '<none>', p.node ?? '<none>', '<none>', '<none>'] : []), ...(opts.showLabels ? [Object.entries(p.meta.labels).map(([a, b]) => `${a}=${b}`).join(',')] : [])])];
    }
    case 'deployments': {
      const list = pick(nsFilter(kube.deployments, k));
      return [[...nsCol, 'NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(opts.wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])], ...list.map((d) => {
        const o = deployObj(d, kube);
        return [...nsVal(d.meta.namespace), d.meta.name, `${o.status.readyReplicas}/${d.replicas}`, String(Math.min(o.status.updatedReplicas, d.replicas)), String(o.status.availableReplicas), podAge(d.meta.creationTimestamp), ...(opts.wide ? [d.template.containers.map((c) => c.name).join(','), d.template.containers.map((c) => c.image).join(','), Object.entries(d.selector).map(([a, b]) => `${a}=${b}`).join(',')] : [])];
      })];
    }
    case 'replicasets':
      return [[...nsCol, 'NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'], ...pick(nsFilter(kube.replicasets, k)).map((r) => {
        const pods = kube.pods.filter((p) => p.owner?.name === r.meta.name && p.status !== 'Terminating');
        return [...nsVal(r.meta.namespace), r.meta.name, String(r.replicas), String(pods.length), String(pods.filter((p) => p.status === 'Running').length), podAge(r.meta.creationTimestamp)];
      })];
    case 'services':
      return [[...nsCol, 'NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(opts.wide ? ['SELECTOR'] : [])], ...pick(nsFilter(kube.services, k)).map((s) => [...nsVal(s.meta.namespace), s.meta.name, s.type, s.clusterIP, s.type === 'LoadBalancer' ? s.externalIP ?? '<pending>' : '<none>', svcPorts(s), podAge(s.meta.creationTimestamp), ...(opts.wide ? [Object.entries(s.selector).map(([a, b]) => `${a}=${b}`).join(',') || '<none>'] : [])])];
    case 'nodes':
      return [['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(opts.wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : [])], ...kube.nodes.filter((n) => !opts.name || n.name === opts.name).map((n) => [n.name, n.status, '<none>', podAge(n.created), `v${n.version}`, ...(opts.wide ? [n.internalIP, '<none>', 'Ubuntu 22.04.5 LTS', '5.15.0-1073-azure', 'containerd://1.7.22-1'] : [])])];
    case 'namespaces':
      return [['NAME', 'STATUS', 'AGE'], ...kube.namespaces.filter((n) => !opts.name || n.name === opts.name).map((n) => [n.name, n.status, podAge(n.created)])];
    case 'configmaps':
      return [[...nsCol, 'NAME', 'DATA', 'AGE'], ...[{ meta: meta('kube-root-ca.crt', k.ns), data: { 'ca.crt': '' } }, ...pick(nsFilter(kube.configmaps, k))].map((c) => [...nsVal(c.meta.namespace), c.meta.name, String(Object.keys(c.data).length), podAge(c.meta.creationTimestamp)])];
    case 'secrets':
      return [[...nsCol, 'NAME', 'TYPE', 'DATA', 'AGE'], ...pick(nsFilter(kube.secrets, k)).map((c) => [...nsVal(c.meta.namespace), c.meta.name, c.type ?? 'Opaque', String(Object.keys(c.data).length), podAge(c.meta.creationTimestamp)])];
    case 'events':
      return [[...nsCol, 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...kube.events.filter((e) => k.allNs || true).slice(-40).map((e) => [...nsVal('default'), podAge(e.time), e.type === 'Warning' ? C.yellow(e.type) : e.type, e.reason, e.object, e.message.length > 120 ? e.message.slice(0, 117) + '...' : e.message])];
    case 'hpa':
      return [[...nsCol, 'NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'], ...pick(nsFilter(kube.hpas, k)).map((h) => {
        const d = kube.deployments.find((x) => x.meta.name === h.target);
        return [...nsVal(h.meta.namespace), h.meta.name, `Deployment/${h.target}`, `cpu: ${Math.floor(Math.random() * 20 + 5)}%/${h.cpu}%`, String(h.min), String(h.max), String(d?.replicas ?? 0), podAge(h.meta.creationTimestamp)];
      })];
    case 'ingresses':
      return [[...nsCol, 'NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'], ...pick(nsFilter(kube.ingresses, k)).map((i) => [...nsVal(i.meta.namespace), i.meta.name, 'webapprouting.kubernetes.azure.com', (i.rules ?? []).map((r: any) => r.host ?? '*').join(','), '', '80', podAge(i.meta.creationTimestamp)])];
    case 'endpoints':
      return [[...nsCol, 'NAME', 'ENDPOINTS', 'AGE'], ...pick(nsFilter(kube.services, k)).map((s) => {
        const eps = kube.pods.filter((p) => p.meta.namespace === s.meta.namespace && p.status === 'Running' && Object.keys(s.selector).length && Object.entries(s.selector).every(([a, b]) => p.meta.labels[a] === b));
        return [...nsVal(s.meta.namespace), s.meta.name, eps.length ? eps.map((p) => `${p.ip}:${s.ports[0]?.targetPort}`).join(',') : '<none>', podAge(s.meta.creationTimestamp)];
      })];
  }
  return null;
}

function statusColor(s: string) {
  if (['ErrImagePull', 'ImagePullBackOff', 'CrashLoopBackOff', 'Error'].includes(s)) return C.red(s);
  if (['Pending', 'ContainerCreating', 'Terminating'].includes(s)) return C.yellow(s);
  return s;
}

async function cmdGet(ctx: CmdCtx, args: string[], k: KCtx, flags: Set<string>, opts: Record<string, string>): Promise<number> {
  const output = opts.o ?? opts.output ?? '';
  const selector = opts.l ?? opts.selector;
  const kinds: { kind: string; name?: string }[] = [];
  for (const a of args) {
    if (a.includes('/')) {
      const [t, n] = a.split('/');
      kinds.push({ kind: ALIASES[t.toLowerCase()] ?? t, name: n });
    } else if (ALIASES[a.toLowerCase()] || kinds.length === 0) {
      for (const t of a.split(',')) kinds.push({ kind: ALIASES[t.toLowerCase()] ?? t });
    } else kinds[kinds.length - 1].name = a;
  }
  if (!kinds.length) {
    eprintln(ctx.io, 'You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
    return 1;
  }
  const render = () => {
    const outLines: string[] = [];
    let found = 0;
    const expanded: { kind: string; name?: string }[] = kinds.flatMap((x) => (x.kind === 'all' ? ['pods', 'services', 'deployments', 'replicasets'].map((t) => ({ kind: t })) : [x]));
    for (const it of expanded) {
      if (output && output !== 'wide') continue;
      const rows = getRows(it.kind, k, { wide: output === 'wide', selector, showLabels: flags.has('show-labels'), name: it.name });
      if (!rows) {
        eprintln(ctx.io, `error: the server doesn't have a resource type "${it.kind}"`);
        return { code: 1, text: '' };
      }
      if (rows.length <= 1) {
        if (it.name) {
          eprintln(ctx.io, `Error from server (NotFound): ${it.kind === 'deployments' ? 'deployments.apps' : it.kind} "${it.name}" not found`);
          return { code: 1, text: '' };
        }
        continue;
      }
      found++;
      if (kinds[0].kind === 'all') {
        const prefix = { pods: 'pod/', services: 'service/', deployments: 'deployment.apps/', replicasets: 'replicaset.apps/' }[it.kind]!;
        const nameIdx = k.allNs ? 1 : 0;
        rows.slice(1).forEach((r) => (r[nameIdx] = prefix + r[nameIdx]));
      }
      if (outLines.length) outLines.push('');
      outLines.push(table(rows, 3));
    }
    if (!found && !output) outLines.push(k.allNs ? 'No resources found' : `No resources found in ${k.ns} namespace.`);
    return { code: 0, text: outLines.join('\n') };
  };
  if (output && output !== 'wide') {
    const kube = kubeOf(k.cluster);
    const objs: any[] = [];
    for (const it of kinds) {
      if (it.kind === 'pods') objs.push(...nsFilter(kube.pods, k).filter((p) => (!it.name || p.meta.name === it.name) && labelMatch(p.meta.labels, selector)).map((p) => podObj(p, k.cluster)));
      else if (it.kind === 'deployments') objs.push(...nsFilter(kube.deployments, k).filter((d) => !it.name || d.meta.name === it.name).map((d) => deployObj(d, kube)));
      else if (it.kind === 'services') objs.push(...nsFilter(kube.services, k).filter((s) => !it.name || s.meta.name === it.name).map(svcObj));
      else if (it.kind === 'nodes') objs.push(...kube.nodes.filter((n) => !it.name || n.name === it.name).map((n) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name: n.name, labels: { 'kubernetes.azure.com/agentpool': n.pool, 'kubernetes.io/os': 'linux' } }, status: { addresses: [{ type: 'InternalIP', address: n.internalIP }], nodeInfo: { kubeletVersion: `v${n.version}`, osImage: 'Ubuntu 22.04.5 LTS' }, conditions: [{ type: 'Ready', status: 'True' }] } })));
      else if (it.kind === 'namespaces') objs.push(...kube.namespaces.filter((n) => !it.name || n.name === it.name).map((n) => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: n.name }, status: { phase: n.status } })));
      else if (it.kind === 'configmaps' || it.kind === 'secrets') objs.push(...nsFilter(it.kind === 'configmaps' ? kube.configmaps : kube.secrets, k).filter((c) => !it.name || c.meta.name === it.name).map((c) => ({ apiVersion: 'v1', kind: it.kind === 'configmaps' ? 'ConfigMap' : 'Secret', metadata: { name: c.meta.name, namespace: c.meta.namespace }, data: it.kind === 'secrets' ? Object.fromEntries(Object.entries(c.data).map(([a, b]) => [a, btoa(b)])) : c.data, type: c.type })));
    }
    const single = kinds.length === 1 && !!kinds[0].name;
    if (single && !objs.length) {
      eprintln(ctx.io, `Error from server (NotFound): ${kinds[0].kind} "${kinds[0].name}" not found`);
      return 1;
    }
    outputObjects(ctx, objs, output, single);
    return 0;
  }
  const r = render();
  if (r.code) return r.code;
  println(ctx.io, r.text);
  if (flags.has('w') || flags.has('watch')) {
    let prev = r.text.split('\n');
    for (;;) {
      await delay(1000, ctx.io);
      refreshKube(k.cluster);
      const nxt = render().text.split('\n');
      for (const line of nxt.slice(1)) if (!prev.includes(line)) println(ctx.io, line);
      prev = nxt;
    }
  }
  return 0;
}

function describe(ctx: CmdCtx, kind: string, name: string | undefined, k: KCtx): number {
  const kube = kubeOf(k.cluster);
  const lines: string[] = [];
  const evs = (obj: string) => {
    const list = kube.events.filter((e) => e.object === obj).slice(-12);
    lines.push('Events:');
    if (!list.length) lines.push('  <none>');
    else {
      lines.push('  Type     Reason     Age   From               Message');
      lines.push('  ----     ------     ----  ----               -------');
      for (const e of list) lines.push(`  ${e.type.padEnd(8)} ${e.reason.padEnd(10)} ${podAge(e.time).padEnd(5)} ${e.from.padEnd(18)} ${e.count > 1 ? `(x${e.count}) ` : ''}${e.message}`);
    }
  };
  if (kind === 'pods') {
    const pods = nsFilter(kube.pods, k).filter((p) => !name || p.meta.name === name || p.meta.name.startsWith(name));
    if (!pods.length) {
      eprintln(ctx.io, `Error from server (NotFound): pods "${name}" not found`);
      return 1;
    }
    for (const p of pods) {
      const c = p.containers[0];
      lines.push(`Name:             ${p.meta.name}`, `Namespace:        ${p.meta.namespace}`, `Priority:         0`, `Service Account:  default`, `Node:             ${p.node ? `${p.node}/10.224.0.4` : '<none>'}`, `Start Time:       ${new Date(p.createdAt).toUTCString()}`, `Labels:           ${Object.entries(p.meta.labels).map(([a, b]) => `${a}=${b}`).join('\n                  ')}`, `Status:           ${p.status === 'Running' ? 'Running' : 'Pending'}`, `IP:               ${p.ip ?? ''}`, `Controlled By:    ${p.owner?.name ? `ReplicaSet/${p.owner.name}` : '<none>'}`, `Containers:`, `  ${c.name}:`, `    Image:          ${c.image}`, `    Port:           ${c.ports?.[0]?.containerPort ? `${c.ports[0].containerPort}/TCP` : '<none>'}`, `    State:          ${p.status === 'Running' ? 'Running' : 'Waiting'}`, ...(p.status !== 'Running' ? [`      Reason:       ${p.status}`] : []), `    Ready:          ${p.status === 'Running'}`, `    Restart Count:  ${p.restarts}`, `    Environment:${(c.env ?? []).length ? '\n' + (c.env ?? []).map((e) => `      ${e.name}:  ${e.value ?? '<set from ref>'}`).join('\n') : '    <none>'}`, `Conditions:`, `  Type              Status`, `  Ready             ${p.status === 'Running' ? 'True' : 'False'}`, `QoS Class:         BestEffort`);
      evs(`pod/${p.meta.name}`);
      lines.push('');
    }
  } else if (kind === 'deployments') {
    const d = nsFilter(kube.deployments, k).find((x) => x.meta.name === name);
    if (!d) {
      eprintln(ctx.io, `Error from server (NotFound): deployments.apps "${name}" not found`);
      return 1;
    }
    const o = deployObj(d, kube);
    const rsList = kube.replicasets.filter((r) => r.owner === d.meta.name);
    lines.push(`Name:                   ${d.meta.name}`, `Namespace:              ${d.meta.namespace}`, `CreationTimestamp:      ${new Date(d.meta.creationTimestamp).toUTCString()}`, `Labels:                 ${Object.entries(d.meta.labels).map(([a, b]) => `${a}=${b}`).join(',') || '<none>'}`, `Annotations:            deployment.kubernetes.io/revision: ${d.revision}`, `Selector:               ${Object.entries(d.selector).map(([a, b]) => `${a}=${b}`).join(',')}`, `Replicas:               ${d.replicas} desired | ${o.status.updatedReplicas} updated | ${o.status.replicas} total | ${o.status.availableReplicas} available | ${o.status.replicas - o.status.availableReplicas} unavailable`, `StrategyType:           RollingUpdate`, `RollingUpdateStrategy:  25% max unavailable, 25% max surge`, `Pod Template:`, `  Labels:  ${Object.entries(d.template.labels).map(([a, b]) => `${a}=${b}`).join(',')}`, `  Containers:`, ...d.template.containers.flatMap((c) => [`   ${c.name}:`, `    Image:        ${c.image}`, `    Port:         ${c.ports?.[0]?.containerPort ?? '<none>'}/TCP`]), `OldReplicaSets:  ${rsList.slice(0, -1).map((r) => `${r.meta.name} (${kube.pods.filter((p) => p.owner?.name === r.meta.name).length}/${r.replicas} replicas created)`).join(', ') || '<none>'}`, `NewReplicaSet:   ${rsList[rsList.length - 1]?.meta.name ?? '<none>'} (${o.status.replicas}/${d.replicas} replicas created)`);
    lines.push('Events:', '  Type    Reason             Age   From                   Message', '  ----    ------             ----  ----                   -------', ...rsList.map((r) => `  Normal  ScalingReplicaSet  ${podAge(r.meta.creationTimestamp).padEnd(5)} deployment-controller  Scaled up replica set ${r.meta.name} to ${r.replicas}`));
  } else if (kind === 'services') {
    const s = nsFilter(kube.services, k).find((x) => x.meta.name === name);
    if (!s) {
      eprintln(ctx.io, `Error from server (NotFound): services "${name}" not found`);
      return 1;
    }
    const eps = kube.pods.filter((p) => p.meta.namespace === s.meta.namespace && p.status === 'Running' && Object.keys(s.selector).length && Object.entries(s.selector).every(([a, b]) => p.meta.labels[a] === b));
    lines.push(`Name:                     ${s.meta.name}`, `Namespace:                ${s.meta.namespace}`, `Selector:                 ${Object.entries(s.selector).map(([a, b]) => `${a}=${b}`).join(',') || '<none>'}`, `Type:                     ${s.type}`, `IP:                       ${s.clusterIP}`, ...(s.type === 'LoadBalancer' ? [`LoadBalancer Ingress:     ${s.externalIP ?? ''}`] : []), ...s.ports.flatMap((p) => [`Port:                     <unset>  ${p.port}/${p.protocol}`, `TargetPort:               ${p.targetPort}/${p.protocol}`, ...(p.nodePort ? [`NodePort:                 <unset>  ${p.nodePort}/${p.protocol}`] : [])]), `Endpoints:                ${eps.map((p) => `${p.ip}:${s.ports[0]?.targetPort}`).join(',') || '<none>'}`, `Session Affinity:         None`, `Events:`, s.type === 'LoadBalancer' ? `  Normal  EnsuringLoadBalancer  ${podAge(s.meta.creationTimestamp)}  service-controller  Ensuring load balancer${s.externalIP ? `\n  Normal  EnsuredLoadBalancer   ${podAge(s.meta.creationTimestamp)}  service-controller  Ensured load balancer` : ''}` : '  <none>');
  } else if (kind === 'nodes') {
    const n = kube.nodes.find((x) => x.name === name) ?? kube.nodes[0];
    if (!n) {
      eprintln(ctx.io, 'No resources found');
      return 1;
    }
    const podsOn = kube.pods.filter((p) => p.node === n.name);
    lines.push(`Name:               ${n.name}`, `Roles:              <none>`, `Labels:             agentpool=${n.pool}`, `                    kubernetes.io/os=linux`, `                    node.kubernetes.io/instance-type=Standard_D2s_v5`, `Conditions:`, `  Type             Status`, `  Ready            True`, `Addresses:`, `  InternalIP:  ${n.internalIP}`, `  Hostname:    ${n.name}`, `Capacity:`, `  cpu:                ${n.cpu}`, `  memory:             ${n.memoryGi * 1024 * 1024}Ki`, `  pods:               250`, `System Info:`, `  Kernel Version:             5.15.0-1073-azure`, `  OS Image:                   Ubuntu 22.04.5 LTS`, `  Container Runtime Version:  containerd://1.7.22-1`, `  Kubelet Version:            v${n.version}`, `Non-terminated Pods:          (${podsOn.length} in total)`, ...podsOn.map((p) => `  ${p.meta.namespace.padEnd(14)} ${p.meta.name}`));
  } else {
    eprintln(ctx.io, `error: describe no está implementado para "${kind}" en el simulador (prueba pods, deployments, services o nodes).`);
    return 1;
  }
  println(ctx.io, lines.join('\n'));
  return 0;
}

function readManifests(ctx: CmdCtx, files: string[]): any[] | null {
  const docs: any[] = [];
  for (const f of files) {
    let texts: { name: string; text: string }[] = [];
    if (f === '-') texts = [{ name: 'stdin', text: ctx.io.stdin ?? '' }];
    else {
      const abs = ctx.sess.resolve(f);
      if (ctx.sess.fs.isDir(abs)) texts = Object.entries(ctx.sess.fs.snapshot(abs)).filter(([n]) => /\.(ya?ml|json)$/.test(n)).map(([n, t]) => ({ name: `${f}/${n}`, text: t }));
      else {
        try {
          texts = [{ name: f, text: ctx.sess.fs.readFile(abs) }];
        } catch {
          eprintln(ctx.io, `error: the path "${f}" does not exist`);
          return null;
        }
      }
    }
    for (const t of texts) {
      try {
        if (t.name.endsWith('.json')) docs.push(JSON.parse(t.text));
        else for (const d of loadAll(t.text)) if (d) docs.push(d);
      } catch (e: any) {
        eprintln(ctx.io, `error: error parsing ${t.name}: error converting YAML to JSON: ${String(e?.message ?? e).split('\n')[0]}`);
        return null;
      }
    }
  }
  return docs.flatMap((d) => (d.kind === 'List' ? d.items ?? [] : [d]));
}

async function rolloutStatus(ctx: CmdCtx, k: KCtx, name: string, timeoutSec: number): Promise<number> {
  const kube = kubeOf(k.cluster);
  const start = Date.now();
  let lastMsg = '';
  for (;;) {
    refreshKube(k.cluster);
    const d = kube.deployments.find((x) => x.meta.name === name && x.meta.namespace === k.ns);
    if (!d) {
      eprintln(ctx.io, `Error from server (NotFound): deployments.apps "${name}" not found`);
      return 1;
    }
    const newest = kube.replicasets.filter((r) => r.owner === d.meta.name).sort((a, b) => b.revision - a.revision)[0];
    const newPods = kube.pods.filter((p) => p.owner?.name === newest?.meta.name && p.status !== 'Terminating');
    const ready = newPods.filter((p) => p.status === 'Running').length;
    const oldLeft = kube.pods.filter((p) => p.owner?.name && p.owner.name !== newest?.meta.name && kube.replicasets.some((r) => r.meta.name === p.owner!.name && r.owner === d.meta.name)).length;
    if (ready >= d.replicas && !oldLeft) {
      println(ctx.io, `deployment "${name}" successfully rolled out`);
      return 0;
    }
    const msg = oldLeft && ready >= d.replicas ? `Waiting for deployment "${name}" rollout to finish: ${oldLeft} old replicas are pending termination...` : `Waiting for deployment "${name}" rollout to finish: ${ready} of ${d.replicas} updated replicas are available...`;
    if (msg !== lastMsg) println(ctx.io, msg);
    lastMsg = msg;
    if ((Date.now() - start) / 1000 > timeoutSec * Math.max(0.2, speedFactor() || 0.2)) {
      eprintln(ctx.io, `error: deployment "${name}" exceeded its progress deadline`);
      const bad = newPods.find((p) => ['ErrImagePull', 'ImagePullBackOff', 'CrashLoopBackOff'].includes(p.status));
      if (bad) hint(ctx.io, `El pod ${bad.meta.name} está en ${bad.status}. Revisa "kubectl describe pod ${bad.meta.name}" (eventos) o "kubectl logs".`);
      return 1;
    }
    await delay(800, ctx.io);
  }
}

function findPodByRef(kube: KubeState, ref: string, k: KCtx): KPod | undefined {
  if (ref.includes('/')) {
    const [t, n] = ref.split('/');
    const kind = ALIASES[t] ?? t;
    if (kind === 'deployments') {
      const d = kube.deployments.find((x) => x.meta.name === n && x.meta.namespace === k.ns);
      return d ? kube.pods.find((p) => p.meta.namespace === k.ns && Object.entries(d.selector).every(([a, b]) => p.meta.labels[a] === b) && p.status === 'Running') ?? kube.pods.find((p) => Object.entries(d.selector).every(([a, b]) => p.meta.labels[a] === b)) : undefined;
    }
    ref = n;
  }
  return kube.pods.find((p) => p.meta.name === ref && (k.allNs || p.meta.namespace === k.ns));
}

/** Ejecuta kubectl contra un clúster concreto (az aks command invoke, tareas de pipeline). */
export async function runKubectlAgainst(cluster: Resource, args: string[], ctx: CmdCtx, defaultNs = 'default'): Promise<number> {
  refreshKube(cluster);
  return kubectlMain(['kubectl', ...args], ctx, { cluster, ns: defaultNs, allNs: false, contextName: cluster.name });
}

async function kubectlMain(argv: string[], ctx: CmdCtx, fixed?: KCtx): Promise<number> {
  const raw = argv.slice(1);
  const { flags, opts, rest } = parseFlags(raw, ['n', 'namespace', 'o', 'output', 'l', 'selector', 'f', 'filename', 'replicas', 'image', 'port', 'target-port', 'type', 'name', 'context', 'c', 'container', 'tail', 'timeout', 'to-revision', 'cpu-percent', 'min', 'max', 'from-literal', 'restart', 'record', 'env', 'kubeconfig', 'since', 'protocol', 'dry-run', 'overrides']);
  const sub = rest[0];
  const args = rest.slice(1);
  const nsFlag = opts.n ?? opts.namespace;
  const allNs = flags.has('A') || flags.has('all-namespaces');
  if (!sub || sub === 'help' || flags.has('help')) {
    println(ctx.io, 'kubectl controls the Kubernetes cluster manager.\n\nBasic Commands:\n  create, expose, run, set, get, explain, edit, delete\n\nDeploy Commands:\n  rollout, scale, autoscale\n\nCluster Management Commands:\n  cluster-info, top, describe, logs, exec\n\nAdvanced Commands:\n  apply\n\nSettings Commands:\n  label, config, version');
    return 0;
  }
  if (sub === 'version') {
    println(ctx.io, `Client Version: ${CLIENT_VERSION}\nKustomize Version: v5.5.0`);
    if (flags.has('client')) return 0;
    const k = fixed ?? resolveContext(ctx, nsFlag, allNs, opts.context);
    if (!k) return 1;
    println(ctx.io, `Server Version: v${k.cluster.properties.kubernetesVersion}`);
    return 0;
  }
  if (sub === 'config') {
    const p = kubeconfigPath(ctx);
    const cfg = readConfig(ctx);
    const op = args[0];
    if (op === 'view') {
      if (!cfg) println(ctx.io, 'apiVersion: v1\nclusters: null\ncontexts: null\ncurrent-context: ""\nkind: Config\npreferences: {}\nusers: null');
      else println(ctx.io, ctx.sess.fs.readFile(p).replace(/(client-key-data|client-certificate-data|token): .*/g, '$1: DATA+OMITTED').replace(/certificate-authority-data: .*/g, 'certificate-authority-data: DATA+OMITTED').trimEnd());
      return 0;
    }
    if (op === 'current-context') {
      if (!cfg?.current) {
        eprintln(ctx.io, 'error: current-context is not set');
        return 1;
      }
      println(ctx.io, cfg.current);
      return 0;
    }
    if (op === 'get-contexts') {
      println(ctx.io, table([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ...(cfg?.contexts ?? []).map((c) => [c.name === cfg!.current ? '*' : '', c.name, c.cluster, c.user, c.namespace ?? ''])], 3));
      return 0;
    }
    if (op === 'use-context') {
      if (!cfg?.contexts.some((c) => c.name === args[1])) {
        eprintln(ctx.io, `error: no context exists with the name: "${args[1]}"`);
        return 1;
      }
      ctx.sess.fs.writeFile(p, setCurrentContext(ctx.sess.fs.readFile(p), args[1]));
      println(ctx.io, `Switched to context "${args[1]}".`);
      changed();
      return 0;
    }
    if (op === 'set-context') {
      const nsOpt = raw.find((x) => x.startsWith('--namespace='))?.slice(12) ?? nsFlag;
      const target = flags.has('current') ? cfg?.current : args[1];
      if (!cfg || !target || !nsOpt) {
        eprintln(ctx.io, 'error: usa: kubectl config set-context --current --namespace=<ns>');
        return 1;
      }
      ctx.sess.fs.writeFile(p, setContextNamespace(ctx.sess.fs.readFile(p), target, nsOpt));
      println(ctx.io, `Context "${target}" modified.`);
      return 0;
    }
    if (op === 'delete-context') {
      println(ctx.io, `deleted context ${args[1]} from ${p}`);
      return 0;
    }
    eprintln(ctx.io, `error: unknown command "${op ?? ''}" for "kubectl config"`);
    return 1;
  }
  if (sub === 'api-resources') {
    println(ctx.io, table([['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], ['configmaps', 'cm', 'v1', 'true', 'ConfigMap'], ['events', 'ev', 'v1', 'true', 'Event'], ['namespaces', 'ns', 'v1', 'false', 'Namespace'], ['nodes', 'no', 'v1', 'false', 'Node'], ['pods', 'po', 'v1', 'true', 'Pod'], ['secrets', '', 'v1', 'true', 'Secret'], ['services', 'svc', 'v1', 'true', 'Service'], ['deployments', 'deploy', 'apps/v1', 'true', 'Deployment'], ['replicasets', 'rs', 'apps/v1', 'true', 'ReplicaSet'], ['horizontalpodautoscalers', 'hpa', 'autoscaling/v2', 'true', 'HorizontalPodAutoscaler'], ['ingresses', 'ing', 'networking.k8s.io/v1', 'true', 'Ingress']], 3));
    return 0;
  }
  const k = fixed ? { ...fixed, ns: nsFlag ?? fixed.ns, allNs } : resolveContext(ctx, nsFlag, allNs, opts.context);
  if (!k) return 1;
  const cluster = k.cluster;
  const kube = kubeOf(cluster);
  const fail = (e: unknown) => {
    eprintln(ctx.io, (e as Error).message);
    return 1;
  };
  switch (sub) {
    case 'cluster-info':
      println(ctx.io, `${C.green('Kubernetes control plane')} is running at ${C.yellow(`https://${cluster.properties.fqdn}:443`)}\n${C.green('CoreDNS')} is running at ${C.yellow(`https://${cluster.properties.fqdn}:443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy`)}\n${C.green('Metrics-server')} is running at ${C.yellow(`https://${cluster.properties.fqdn}:443/api/v1/namespaces/kube-system/services/https:metrics-server:/proxy`)}\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.`);
      return 0;
    case 'get':
      return cmdGet(ctx, args, k, flags, opts);
    case 'describe': {
      let [t, n] = args;
      if (t?.includes('/')) [t, n] = t.split('/');
      return describe(ctx, ALIASES[t?.toLowerCase() ?? ''] ?? t, n, k);
    }
    case 'apply':
    case 'create': {
      const files: string[] = [];
      for (let i = 0; i < raw.length; i++) if (raw[i] === '-f' || raw[i] === '--filename') files.push(raw[++i]);
      if (sub === 'create' && !files.length) {
        const what = args[0];
        try {
          if (what === 'deployment') {
            const img = opts.image;
            if (!img) {
              eprintln(ctx.io, 'error: required flag(s) "image" not set');
              return 1;
            }
            createDeployment(cluster, args[1], img, Number(opts.replicas ?? 1), k.ns, opts.port ? Number(opts.port) : undefined);
            println(ctx.io, `deployment.apps/${args[1]} created`);
            return 0;
          }
          if (what === 'namespace' || what === 'ns') {
            const r = applyObject(cluster, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: args[1] } });
            if (r.action === 'unchanged') {
              eprintln(ctx.io, `Error from server (AlreadyExists): namespaces "${args[1]}" already exists`);
              return 1;
            }
            println(ctx.io, `namespace/${args[1]} created`);
            return 0;
          }
          if (what === 'configmap' || what === 'cm' || what === 'secret') {
            const isSecret = what === 'secret';
            const nm = isSecret ? args[2] : args[1];
            const data: Record<string, string> = {};
            for (let i = 0; i < raw.length; i++) if (raw[i].startsWith('--from-literal')) {
              const v = raw[i].includes('=') && raw[i].indexOf('=') < 15 ? raw[i].slice(raw[i].indexOf('=') + 1) : raw[++i];
              const eq = v.indexOf('=');
              data[v.slice(0, eq)] = v.slice(eq + 1);
            }
            applyObject(cluster, { apiVersion: 'v1', kind: isSecret ? 'Secret' : 'ConfigMap', metadata: { name: nm, namespace: k.ns }, ...(isSecret ? { stringData: data } : { data }) }, k.ns);
            println(ctx.io, `${isSecret ? 'secret' : 'configmap'}/${nm} created`);
            return 0;
          }
        } catch (e) {
          return fail(e);
        }
        eprintln(ctx.io, `error: must specify one of -f and -k (o un tipo: deployment, namespace, configmap, secret)`);
        return 1;
      }
      if (!files.length) {
        eprintln(ctx.io, 'error: must specify one of -f and -k');
        return 1;
      }
      const docs = readManifests(ctx, files);
      if (!docs) return 1;
      let code = 0;
      for (const d of docs) {
        try {
          if (d.kind && !['Namespace'].includes(d.kind) && d.metadata && !d.metadata.namespace) d.metadata.namespace = k.ns;
          const r = applyObject(cluster, d, k.ns);
          if (sub === 'create' && r.action !== 'created') {
            eprintln(ctx.io, `Error from server (AlreadyExists): error when creating "${files[0]}": ${r.kind}s "${r.name}" already exists`);
            code = 1;
          } else println(ctx.io, `${r.kind}/${r.name} ${r.action}`);
        } catch (e) {
          code = fail(e);
        }
      }
      return code;
    }
    case 'delete': {
      const files: string[] = [];
      for (let i = 0; i < raw.length; i++) if (raw[i] === '-f' || raw[i] === '--filename') files.push(raw[++i]);
      try {
        if (files.length) {
          const docs = readManifests(ctx, files);
          if (!docs) return 1;
          for (const d of docs) println(ctx.io, deleteObject(cluster, d.kind, d.metadata?.name, d.metadata?.namespace ?? k.ns));
          return 0;
        }
        let [t, ...names] = args;
        if (t?.includes('/')) {
          names = [t.split('/')[1]];
          t = t.split('/')[0];
        }
        if (!t) {
          eprintln(ctx.io, 'error: You must provide one or more resources by argument or filename.');
          return 1;
        }
        if (flags.has('all')) names = (ALIASES[t] === 'pods' ? kube.pods : ALIASES[t] === 'deployments' ? kube.deployments : ALIASES[t] === 'services' ? kube.services : []).filter((x: any) => x.meta.namespace === k.ns && x.meta.name !== 'kubernetes').map((x: any) => x.meta.name);
        for (const n of names) println(ctx.io, deleteObject(cluster, t, n, k.ns));
        return 0;
      } catch (e) {
        return fail(e);
      }
    }
    case 'scale': {
      let target = args[0];
      if (target && !target.includes('/') && args[1]) target = `${target}/${args[1]}`;
      const [, name] = (target ?? '').split('/');
      if (!opts.replicas) {
        eprintln(ctx.io, 'error: required flag(s) "replicas" not set');
        return 1;
      }
      try {
        scaleDeployment(cluster, name, Number(opts.replicas), k.ns);
        println(ctx.io, `deployment.apps/${name} scaled`);
        return 0;
      } catch (e) {
        return fail(e);
      }
    }
    case 'expose': {
      let target = args[0];
      if (target && !target.includes('/') && args[1]) target = `${target}/${args[1]}`;
      const [, name] = (target ?? '').split('/');
      if (!opts.port) {
        eprintln(ctx.io, 'error: couldn\'t find port via --port flag or introspection\nSee \'kubectl expose -h\' for help and examples');
        return 1;
      }
      try {
        const r = exposeDeployment(cluster, name, (opts.type ?? 'ClusterIP') as any, Number(opts.port), opts['target-port'] ? Number(opts['target-port']) : undefined, k.ns, opts.name);
        println(ctx.io, `service/${r.name} exposed`);
        return 0;
      } catch (e) {
        return fail(e);
      }
    }
    case 'set': {
      if (args[0] !== 'image') {
        eprintln(ctx.io, `error: el simulador sólo soporta "kubectl set image"`);
        return 1;
      }
      const [, target, ...pairs] = args;
      const name = target.split('/')[1] ?? target;
      try {
        for (const pr of pairs) {
          const [c, img] = pr.split('=');
          setImage(cluster, name, c, img, k.ns);
        }
        println(ctx.io, `deployment.apps/${name} image updated`);
        return 0;
      } catch (e) {
        return fail(e);
      }
    }
    case 'rollout': {
      const [op, t, maybe] = args;
      const name = (t?.includes('/') ? t.split('/')[1] : maybe) ?? '';
      try {
        if (op === 'status') return rolloutStatus(ctx, k, name, Number(String(opts.timeout ?? '120').replace(/s$/, '')));
        const d = findDeployment(kube, name, k.ns);
        if (op === 'history') {
          println(ctx.io, `deployment.apps/${name} \nREVISION  CHANGE-CAUSE\n${d.history.map((h) => `${String(h.revision).padEnd(10)}${h.changeCause}`).join('\n')}`);
          return 0;
        }
        if (op === 'undo') {
          rolloutUndo(cluster, name, k.ns, opts['to-revision'] ? Number(opts['to-revision']) : undefined);
          println(ctx.io, `deployment.apps/${name} rolled back`);
          return 0;
        }
        if (op === 'restart') {
          d.template = { ...d.template, labels: { ...d.template.labels }, containers: d.template.containers.map((c) => ({ ...c, env: [...(c.env ?? []).filter((e) => e.name !== 'RESTARTED_AT'), { name: 'RESTARTED_AT', value: new Date().toISOString() }] })) };
          changed();
          refreshKube(cluster);
          println(ctx.io, `deployment.apps/${name} restarted`);
          return 0;
        }
      } catch (e) {
        return fail(e);
      }
      eprintln(ctx.io, `error: unknown command "${op}" for "kubectl rollout"`);
      return 1;
    }
    case 'logs': {
      const ref = args[0];
      const pod = ref ? findPodByRef(kube, ref, k) : undefined;
      if (!pod) {
        eprintln(ctx.io, `error: error from server (NotFound): pods "${ref}" not found in namespace "${k.ns}"`);
        return 1;
      }
      let lines = podLogs(cluster, pod);
      if (opts.tail) lines = lines.slice(-Number(opts.tail));
      const err = lines.length === 1 && lines[0].startsWith('Error from server');
      (err ? eprintln : println)(ctx.io, lines.join('\n'));
      if (flags.has('f')) {
        let seen = lines.length;
        for (;;) {
          await delay(1000, ctx.io);
          const now = podLogs(cluster, pod);
          for (; seen < now.length; seen++) println(ctx.io, now[seen]);
        }
      }
      return err ? 1 : 0;
    }
    case 'exec': {
      const dash = raw.indexOf('--');
      const podRef = args.find((a) => !a.startsWith('-') && a !== '--');
      const cmd = dash >= 0 ? raw.slice(dash + 1) : args.slice(1);
      const pod = podRef ? findPodByRef(kube, podRef, k) : undefined;
      if (!pod) {
        eprintln(ctx.io, `Error from server (NotFound): pods "${podRef}" not found`);
        return 1;
      }
      if (pod.status !== 'Running') {
        eprintln(ctx.io, `error: unable to upgrade connection: container not found ("${pod.containers[0].name}")`);
        return 1;
      }
      const res = resolveImage(pod.containers[0].image, kubeletPrincipal(cluster));
      const env: Record<string, string> = { HOSTNAME: pod.meta.name, KUBERNETES_SERVICE_HOST: '10.0.0.1', ...(res.pkg?.env ?? {}) };
      for (const e of pod.containers[0].env ?? []) if (e.value !== undefined) env[e.name] = e.value;
      const c0 = cmd[0];
      if (!c0 || /^(ba)?sh$|\/bin\/(ba)?sh$/.test(c0)) {
        println(ctx.io, C.dim('(El shell interactivo dentro del pod no está disponible; ejecuta comandos concretos: env, ls, cat, curl http://<servicio>)'));
        return 0;
      }
      if (c0 === 'env' || c0 === 'printenv') println(ctx.io, Object.entries(env).map(([a, b]) => `${a}=${b}`).join('\n'));
      else if (c0 === 'hostname') println(ctx.io, pod.meta.name);
      else if (c0 === 'ls') println(ctx.io, Object.keys(res.pkg?.files ?? {}).join('\n'));
      else if (c0 === 'cat') println(ctx.io, res.pkg?.files[(cmd[1] ?? '').replace(/^\/app\//, '')] ?? `cat: ${cmd[1]}: No such file or directory`);
      else if (c0 === 'curl' || c0 === 'wget') {
        const url = cmd.find((x, i) => i > 0 && !x.startsWith('-')) ?? '';
        const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
        if (!m) return 1;
        const host = m[1].split('.')[0];
        const ns = m[1].split('.')[1] ?? pod.meta.namespace;
        const svc = kube.services.find((s) => s.meta.name === host && s.meta.namespace === ns);
        if (!svc) {
          eprintln(ctx.io, `curl: (6) Could not resolve host: ${m[1]}`);
          return 6;
        }
        const port = Number(m[2] ?? 80);
        const p = svc.ports.find((x) => x.port === port);
        const target = kube.pods.find((x) => x.meta.namespace === svc.meta.namespace && x.status === 'Running' && Object.keys(svc.selector).length && Object.entries(svc.selector).every(([a, b]) => x.meta.labels[a] === b));
        if (!p || !target) {
          eprintln(ctx.io, `curl: (7) Failed to connect to ${m[1]} port ${port}: Connection refused`);
          return 7;
        }
        const tres = resolveImage(target.containers[0].image, kubeletPrincipal(cluster));
        if (!tres.ok || appListenPort(tres.pkg!) !== p.targetPort) {
          eprintln(ctx.io, `curl: (7) Failed to connect to ${m[1]} port ${port}: Connection refused`);
          return 7;
        }
        println(ctx.io, renderApp(tres.pkg!, m[3] ?? '/', {}).body);
      } else println(ctx.io, C.dim(`(exec ${cmd.join(' ')}: simulado)`));
      return 0;
    }
    case 'top': {
      const what = ALIASES[args[0] ?? ''] ?? args[0];
      if (what === 'nodes') {
        println(ctx.io, table([['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], ...kube.nodes.map((n) => {
          const pods = kube.pods.filter((p) => p.node === n.name && p.status === 'Running').length;
          return [n.name, `${120 + pods * 15}m`, `${Math.round(((120 + pods * 15) / 2000) * 100)}%`, `${1800 + pods * 90}Mi`, `${Math.round(((1800 + pods * 90) / 8192) * 100)}%`];
        })], 3));
        return 0;
      }
      if (what === 'pods') {
        println(ctx.io, table([['NAME', 'CPU(cores)', 'MEMORY(bytes)'], ...nsFilter(kube.pods, k).filter((p) => p.status === 'Running').map((p) => [p.meta.name, `${p.system ? 3 : 1 + (p.meta.name.length % 4)}m`, `${p.system ? 22 : 38 + (p.meta.name.length % 12)}Mi`])], 3));
        return 0;
      }
      eprintln(ctx.io, 'error: usa "kubectl top nodes" o "kubectl top pods"');
      return 1;
    }
    case 'autoscale': {
      const name = (args[0]?.includes('/') ? args[0].split('/')[1] : args[1]) ?? '';
      try {
        findDeployment(kube, name, k.ns);
        applyObject(cluster, { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name, namespace: k.ns }, spec: { scaleTargetRef: { kind: 'Deployment', name }, minReplicas: Number(opts.min ?? 1), maxReplicas: Number(opts.max ?? 5), targetCPUUtilizationPercentage: Number(opts['cpu-percent'] ?? 80) } }, k.ns);
        println(ctx.io, `horizontalpodautoscaler.autoscaling/${name} autoscaled`);
        return 0;
      } catch (e) {
        return fail(e);
      }
    }
    case 'run': {
      const name = args[0];
      if (!opts.image) {
        eprintln(ctx.io, 'error: required flag(s) "image" not set');
        return 1;
      }
      try {
        const r = applyObject(cluster, { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: k.ns, labels: { run: name } }, spec: { containers: [{ name, image: opts.image, ports: opts.port ? [{ containerPort: Number(opts.port) }] : [] }] } }, k.ns);
        if (r.action === 'unchanged') {
          eprintln(ctx.io, `Error from server (AlreadyExists): pods "${name}" already exists`);
          return 1;
        }
        println(ctx.io, `pod/${name} created`);
        return 0;
      } catch (e) {
        return fail(e);
      }
    }
    case 'label':
    case 'annotate': {
      const [t, n, ...pairs] = args[0]?.includes('/') ? [args[0].split('/')[0], args[0].split('/')[1], ...args.slice(1)] : args;
      const kind = ALIASES[t] ?? t;
      const list: any[] = kind === 'pods' ? kube.pods : kind === 'deployments' ? kube.deployments : kind === 'services' ? kube.services : [];
      const obj = list.find((x) => x.meta.name === n && x.meta.namespace === k.ns);
      if (!obj) {
        eprintln(ctx.io, `Error from server (NotFound): ${kind} "${n}" not found`);
        return 1;
      }
      for (const pr of pairs) {
        const target = sub === 'label' ? obj.meta.labels : obj.meta.annotations;
        if (pr.endsWith('-')) delete target[pr.slice(0, -1)];
        else {
          const [a, b] = pr.split('=');
          target[a] = b;
        }
      }
      changed();
      println(ctx.io, `${kind === 'deployments' ? 'deployment.apps' : kind.slice(0, -1)}/${n} ${sub === 'label' ? 'labeled' : 'annotated'}`);
      return 0;
    }
    case 'port-forward':
      println(ctx.io, `Forwarding from 127.0.0.1:${(args[1] ?? '8080:80').split(':')[0]} -> ${(args[1] ?? '8080:80').split(':')[1] ?? ''}`);
      hint(ctx.io, 'port-forward bloquearía el terminal; en el simulador usa un Service de tipo LoadBalancer o "kubectl exec <pod> -- curl http://<servicio>".');
      return 0;
    case 'edit':
      eprintln(ctx.io, 'error: kubectl edit no está disponible; edita el YAML con "code fichero.yaml" y aplícalo con "kubectl apply -f".');
      return 1;
    case 'explain':
      println(ctx.io, `KIND:       ${args[0]}\nDESCRIPTION:\n  (consulta https://kubernetes.io/docs/reference/kubernetes-api/)`);
      return 0;
    case 'wait':
      return rolloutStatus(ctx, k, (args[0] ?? '').split('/')[1] ?? args[0], 120);
  }
  eprintln(ctx.io, `error: unknown command "${sub}" for "kubectl"\n\nDid you mean this?\n\t${['get', 'apply', 'describe', 'logs', 'delete'].find((x) => x[0] === sub[0]) ?? 'get'}`);
  return 1;
}

const kubectl: CommandDef = {
  summary: 'Cliente de Kubernetes',
  fn: (argv, ctx) => kubectlMain(argv, ctx),
};

export const KUBECTL_COMMANDS: Record<string, CommandDef> = { kubectl, k: kubectl };

export function _kubeUnused() {
  return getState;
}
