// Blades de contenedores: Container Registry, Kubernetes Service (AKS) e instancias de contenedor.
import { useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, useTick, resourceHref, rgHref } from '../../hooks';
import { Callout, CliBox, CodeBlock, CommandBar, CopyButton, DataTable, Checkbox, StatusPill, confirmDialog, useAsync } from '../../components/common';
import { portalAction } from '../../portalCli';
import { kubeOf, clusterRunning, podAge, podReady, podLogs } from '../../../engine/services/kube';
import { K8S_VERSIONS } from '../../../engine/catalog';
import { formatBytes, relTime } from '../../../engine/util';
import { terminal, openUrl } from '../../terminal/controller';
import type { TypeBlade } from './shared';
import { MetricsSection, Props, gn } from './shared';

// ---------------------------------------------------------------- ACR

function Repositories({ r }: { r: Resource }) {
  useCloud();
  const repos = Object.entries<any>(r.data?.repos ?? {});
  const [open, setOpen] = useState<string | null>(null);
  const cur = open ? r.data?.repos?.[open] : null;
  if (cur && open) {
    const tags = Object.entries<any>(cur.tags ?? {});
    return (
      <>
        <div className="row" style={{ marginBottom: 10 }}>
          <a onClick={() => setOpen(null)}>← Repositorios</a>
          <span className="muted">/ {open}</span>
        </div>
        <DataTable
          rows={tags}
          rowKey={([t]) => t}
          columns={[
            { key: 't', title: 'Etiqueta', render: ([t]) => <b>{t}</b> },
            { key: 'd', title: 'Digest', render: ([, v]) => <span className="mono small">{String(v.digest).slice(0, 19)}…</span> },
            { key: 's', title: 'Tamaño', render: ([, v]) => formatBytes((v.size ?? 0) * 1048576) },
            { key: 'c', title: 'Creada', render: ([, v]) => relTime(v.created) },
            { key: 'p', title: 'Comando pull', render: ([t]) => <span className="row" style={{ gap: 6 }}><span className="mono small">docker pull {r.properties.loginServer}/{open}:{t}</span><CopyButton text={`docker pull ${r.properties.loginServer}/${open}:${t}`} /></span> },
            {
              key: 'x',
              title: '',
              render: ([t]) => (
                <button
                  className="btn small"
                  onClick={async () => {
                    if (await confirmDialog({ title: 'Eliminar etiqueta', message: `¿Eliminar ${open}:${t}?`, confirmText: 'Eliminar', danger: true })) await portalAction('Eliminar imagen', ['acr', 'repository', 'delete', '-n', r.name, '--image', `${open}:${t}`, '--yes'], { subscription: r.subscriptionId, success: 'Imagen eliminada' });
                  }}
                >
                  Eliminar
                </button>
              ),
            },
          ]}
        />
      </>
    );
  }
  return (
    <>
      <p className="muted">Sube imágenes con <code>az acr build</code> (compila en la nube, sin Docker local) o con <code>docker push</code> tras <code>az acr login</code>.</p>
      <DataTable
        rows={repos}
        rowKey={([n]) => n}
        columns={[
          { key: 'n', title: 'Repositorio', render: ([n]) => <a onClick={() => setOpen(n)}>{n}</a> },
          { key: 't', title: 'Etiquetas', render: ([, v]) => Object.keys(v.tags ?? {}).join(', ') },
          { key: 'u', title: 'Última actualización', render: ([, v]) => relTime(v.lastUpdate ?? v.created) },
        ]}
        empty="El registro está vacío."
      />
      <div style={{ marginTop: 14 }}>
        <CliBox cmd={`cd ~/samples/app-node && az acr build -r ${r.name} -t app-node:v1 .`} onRun={() => terminal.typeCommand(`cd ~/samples/app-node && az acr build -r ${r.name} -t app-node:v1 .`)} />
      </div>
    </>
  );
}

function AcrKeys({ r }: { r: Resource }) {
  useCloud();
  const admin = !!r.properties.adminUserEnabled;
  const [show, setShow] = useState(false);
  const pw: { name: string; value: string }[] = r.data?.passwords ?? [];
  return (
    <>
      <Callout kind="warn">El usuario administrador es una credencial compartida con permisos totales. Para producción, usa identidades (Entra ID) y roles como AcrPull/AcrPush. Para AKS, adjunta el registro con <code>az aks update --attach-acr</code>.</Callout>
      <Props
        rows={[
          ['Servidor de inicio de sesión', <span className="row" style={{ gap: 6 }}><span className="mono">{r.properties.loginServer}</span><CopyButton text={r.properties.loginServer} /></span>],
          ['Usuario administrador', <Checkbox checked={admin} onChange={(v) => portalAction('Usuario administrador', ['acr', 'update', '-n', r.name, '--admin-enabled', String(v)], { subscription: r.subscriptionId, success: v ? 'Usuario administrador habilitado' : 'Usuario administrador deshabilitado' })} label={admin ? 'Habilitado' : 'Deshabilitado'} />],
          ...(admin ? ([['Nombre de usuario', <span className="mono">{r.name}</span>]] as [string, any][]) : []),
          ...(admin ? pw.map((p) => [p.name, <span className="row" style={{ gap: 6 }}><span className="mono">{show ? p.value : '••••••••••••'}</span><CopyButton text={p.value} /></span>] as [string, any]) : []),
        ]}
      />
      {admin ? (
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => setShow(!show)}>
          {show ? 'Ocultar' : 'Mostrar'} contraseñas
        </button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- AKS

function Workloads({ r }: { r: Resource }) {
  useCloud();
  useTick(2000);
  const k = kubeOf(r);
  const [tab, setTab] = useState<'deploy' | 'pods'>('deploy');
  const [logs, setLogs] = useState<{ pod: string; lines: string[] } | null>(null);
  if (!clusterRunning(r)) return <Callout kind="warn">El clúster está detenido: inicia el clúster para ver las cargas de trabajo.</Callout>;
  const pods = k.pods.filter((p) => !p.system);
  return (
    <>
      <div className="tabs">
        <button className={tab === 'deploy' ? 'active' : ''} onClick={() => setTab('deploy')}>
          Implementaciones <span className="num">{k.deployments.length}</span>
        </button>
        <button className={tab === 'pods' ? 'active' : ''} onClick={() => setTab('pods')}>
          Pods <span className="num">{pods.length}</span>
        </button>
      </div>
      {tab === 'deploy' ? (
        <DataTable
          rows={k.deployments}
          rowKey={(d) => d.meta.namespace + '/' + d.meta.name}
          columns={[
            { key: 'n', title: 'Nombre', render: (d) => <b>{d.meta.name}</b> },
            { key: 'ns', title: 'Espacio de nombres', render: (d) => d.meta.namespace },
            { key: 'r', title: 'Listos', render: (d) => `${k.pods.filter((p) => p.owner?.name.startsWith(d.meta.name + '-') && p.status === 'Running').length}/${d.replicas}` },
            { key: 'i', title: 'Imagen', render: (d) => <span className="mono small">{d.template.containers.map((c) => c.image).join(', ')}</span> },
            { key: 'rev', title: 'Revisión', render: (d) => d.revision },
          ]}
          empty="No hay implementaciones. Despliega con kubectl apply -f deployment.yaml."
        />
      ) : (
        <DataTable
          rows={pods}
          rowKey={(p) => p.meta.namespace + '/' + p.meta.name}
          columns={[
            { key: 'n', title: 'Nombre', render: (p) => <span className="mono small">{p.meta.name}</span> },
            { key: 'r', title: 'Listo', render: (p) => podReady(p) },
            { key: 's', title: 'Estado', render: (p) => <span className={`pill ${p.status === 'Running' ? 'ok' : /Err|BackOff|Error/.test(p.status) ? 'bad' : 'warn'}`}>{p.status}</span> },
            { key: 'rs', title: 'Reinicios', render: (p) => p.restarts },
            { key: 'node', title: 'Nodo', render: (p) => <span className="small">{p.node ?? '<none>'}</span> },
            { key: 'ip', title: 'IP del pod', render: (p) => <span className="mono small">{p.ip ?? '—'}</span> },
            { key: 'a', title: 'Antigüedad', render: (p) => podAge(new Date(p.createdAt).toISOString()) },
            { key: 'l', title: '', render: (p) => <button className="btn small" onClick={() => setLogs({ pod: p.meta.name, lines: podLogs(r, p) })}>Registros</button> },
          ]}
          empty="No hay pods."
        />
      )}
      {pods.some((p) => /ImagePull|ErrImage/.test(p.status)) ? (
        <Callout kind="bad" title="Hay pods que no pueden descargar su imagen">
          {pods.find((p) => p.pullError)?.pullError}
          <div style={{ marginTop: 6 }}>Si la imagen está en un ACR privado, el clúster necesita el rol AcrPull: <code>az aks update -g {r.resourceGroup} -n {r.name} --attach-acr &lt;registro&gt;</code></div>
        </Callout>
      ) : null}
      {logs ? (
        <div style={{ marginTop: 14 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>Registros de {logs.pod}</h3>
            <span className="spacer" />
            <button className="btn small" onClick={() => setLogs(null)}>
              Cerrar
            </button>
          </div>
          <CodeBlock code={logs.lines.join('\n') || '(sin registros)'} maxHeight={320} />
        </div>
      ) : null}
    </>
  );
}

function Services({ r }: { r: Resource }) {
  useCloud();
  useTick(2000);
  const k = kubeOf(r);
  return (
    <DataTable
      rows={k.services}
      rowKey={(x) => x.meta.namespace + '/' + x.meta.name}
      columns={[
        { key: 'n', title: 'Nombre', render: (x) => <b>{x.meta.name}</b> },
        { key: 'ns', title: 'Espacio de nombres', render: (x) => x.meta.namespace },
        { key: 't', title: 'Tipo', render: (x) => x.type },
        { key: 'ci', title: 'IP del clúster', render: (x) => <span className="mono small">{x.clusterIP}</span> },
        { key: 'e', title: 'IP externa', render: (x) => (x.type === 'LoadBalancer' ? x.externalIP ? <a onClick={() => openUrl(`http://${x.externalIP}:${x.ports[0]?.port ?? 80}`)}>{x.externalIP}</a> : <span className="pill warn">&lt;pending&gt;</span> : '—') },
        { key: 'p', title: 'Puertos', render: (x) => x.ports.map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(', ') },
      ]}
      empty="No hay servicios."
    />
  );
}

function NodePools({ r }: { r: Resource }) {
  useCloud();
  const pools: any[] = r.properties.agentPoolProfiles ?? [];
  const k = kubeOf(r);
  const [counts, setCounts] = useState<Record<string, string>>(Object.fromEntries(pools.map((p) => [p.name, String(p.count)])));
  const { busy, run } = useAsync();
  return (
    <>
      <DataTable
        rows={pools}
        rowKey={(p) => p.name}
        columns={[
          { key: 'n', title: 'Grupo de nodos', render: (p) => <b>{p.name}</b> },
          { key: 'm', title: 'Modo', render: (p) => p.mode ?? 'System' },
          { key: 's', title: 'Tamaño de nodo', render: (p) => p.vmSize },
          { key: 'v', title: 'Versión', render: (p) => p.orchestratorVersion ?? r.properties.kubernetesVersion },
          { key: 'c', title: 'Nodos', render: (p) => <input className="input" style={{ width: 70 }} value={counts[p.name] ?? ''} onChange={(e) => setCounts({ ...counts, [p.name]: e.target.value })} /> },
          { key: 'x', title: '', render: (p) => <button className="btn small" disabled={busy || String(p.count) === counts[p.name]} onClick={() => run(() => portalAction('Escalar grupo de nodos', ['aks', 'nodepool', 'scale', '-g', r.resourceGroup, '--cluster-name', r.name, '-n', p.name, '--node-count', counts[p.name]], { subscription: r.subscriptionId, success: `Grupo ${p.name} escalado a ${counts[p.name]} nodos` }))}>Escalar</button> },
        ]}
      />
      <h3 className="section-title">Nodos</h3>
      <DataTable rows={k.nodes} rowKey={(n) => n.name} columns={[{ key: 'n', title: 'Nombre', render: (n) => <span className="mono small">{n.name}</span> }, { key: 's', title: 'Estado', render: (n) => <span className={`pill ${n.status === 'Ready' ? 'ok' : 'bad'}`}>{n.status}</span> }, { key: 'v', title: 'Versión', render: (n) => n.version }, { key: 'ip', title: 'IP interna', render: (n) => <span className="mono small">{n.internalIP}</span> }]} empty="No hay nodos (¿clúster detenido?)." />
    </>
  );
}

function ClusterConfig({ r }: { r: Resource }) {
  useCloud();
  const cur = r.properties.kubernetesVersion;
  const newer = K8S_VERSIONS.filter((v) => v.localeCompare(cur, undefined, { numeric: true }) > 0);
  return (
    <>
      <Props rows={[['Versión de Kubernetes', cur], ['Actualizaciones disponibles', newer.join(', ') || 'Ninguna']]} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        {newer.slice(0, 1).map((v) => (
          <button
            key={v}
            className="btn primary"
            onClick={async () => {
              if (await confirmDialog({ title: `Actualizar a ${v}`, message: 'Los nodos se actualizarán de uno en uno (cordon/drain). Sólo se puede subir una versión menor cada vez.', confirmText: 'Actualizar' }))
                await portalAction('Actualizar Kubernetes', ['aks', 'upgrade', ...gn(r), '-k', v, '--yes'], { subscription: r.subscriptionId, success: `Clúster actualizado a ${v}` });
            }}
          >
            Actualizar a {v}
          </button>
        ))}
      </div>
    </>
  );
}

function AksConnect({ r }: { r: Resource }) {
  const cmds = [`az aks get-credentials -g ${r.resourceGroup} -n ${r.name}`, 'kubectl get nodes', 'kubectl get deployments --all-namespaces=true'];
  return (
    <>
      <p>Conéctate al clúster desde Cloud Shell: descarga las credenciales (kubeconfig) y usa kubectl.</p>
      {cmds.map((c) => (
        <div key={c} style={{ marginBottom: 8 }}>
          <CliBox cmd={c} onRun={() => terminal.runCommand(c)} />
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- ACI

function AciContainers({ r }: { r: Resource }) {
  useCloud();
  const cs: any[] = r.properties.containers ?? [];
  const logs: string[] = r.data?.logs ?? [];
  return (
    <>
      <DataTable
        rows={cs}
        rowKey={(c) => c.name}
        columns={[
          { key: 'n', title: 'Nombre', render: (c) => <b>{c.name}</b> },
          { key: 'i', title: 'Imagen', render: (c) => <span className="mono small">{c.properties.image}</span> },
          { key: 's', title: 'Estado', render: (c) => <StatusPill status={c.properties.instanceView?.currentState?.state ?? r.properties.instanceView?.state ?? '—'} /> },
          { key: 'r', title: 'Recursos', render: (c) => `${c.properties.resources?.requests?.cpu ?? 1} CPU · ${c.properties.resources?.requests?.memoryInGB ?? 1.5} GB` },
        ]}
      />
      <h3 className="section-title">Registros</h3>
      <CodeBlock code={logs.join('\n') || '(sin registros)'} maxHeight={320} />
    </>
  );
}

export const CONTAINER_BLADES: Record<string, TypeBlade> = {
  'microsoft.containerregistry/registries': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Servidor de inicio de sesión', <span className="mono">{r.properties.loginServer}</span>],
          ['SKU', r.sku?.name],
          ['Repositorios', String(Object.keys(r.data?.repos ?? {}).length)],
          ['Usuario administrador', r.properties.adminUserEnabled ? 'Habilitado' : 'Deshabilitado'],
        ]}
      />
    ),
    sections: [
      { id: 'repos', label: 'Repositorios', icon: 'folder', group: 'Servicios', Comp: Repositories },
      { id: 'keys', label: 'Claves de acceso', icon: 'key', group: 'Configuración', Comp: AcrKeys },
    ],
    cli: (r) => [
      { label: 'Compilar y subir una imagen sin Docker local', cmd: `az acr build -r ${r.name} -t app-node:v1 .` },
      { label: 'Listar repositorios', cmd: `az acr repository list -n ${r.name} -o table` },
    ],
  },
  'microsoft.containerservice/managedclusters': {
    commands: (r) => {
      const running = clusterRunning(r);
      return [
        { label: 'Conectar', icon: 'terminal', onClick: () => (location.hash = resourceHref(r.id, 'connect')) },
        { label: running ? 'Detener' : 'Iniciar', icon: running ? 'stop' : 'play', onClick: () => portalAction(running ? 'Detener clúster' : 'Iniciar clúster', ['aks', running ? 'stop' : 'start', ...gn(r)], { subscription: r.subscriptionId, success: running ? 'Clúster detenido (no se cobran los nodos)' : 'Clúster iniciado' }) },
      ];
    },
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Estado de energía', clusterRunning(r) ? <span className="pill ok">En ejecución</span> : <span className="pill bad">Detenido</span>],
          ['Versión de Kubernetes', r.properties.kubernetesVersion],
          ['Servidor de API', <span className="mono small">{r.properties.fqdn}</span>],
          ['Nodos', String((r.properties.agentPoolProfiles ?? []).reduce((a: number, p: any) => a + (p.count ?? 0), 0))],
          ['Grupo de recursos de nodos', <a href={rgHref(r.subscriptionId, r.properties.nodeResourceGroup)}>{r.properties.nodeResourceGroup}</a>],
          ['Red', r.properties.networkProfile?.networkPlugin ?? 'azure'],
        ]}
      />
    ),
    sections: [
      { id: 'connect', label: 'Conectar', icon: 'terminal', group: 'Recursos de Kubernetes', Comp: AksConnect },
      { id: 'workloads', label: 'Cargas de trabajo', icon: 'overview', group: 'Recursos de Kubernetes', Comp: Workloads },
      { id: 'services', label: 'Servicios y entradas', icon: 'network', group: 'Recursos de Kubernetes', Comp: Services },
      { id: 'nodepools', label: 'Grupos de nodos', icon: 'vmss', group: 'Configuración', Comp: NodePools },
      { id: 'config', label: 'Configuración del clúster', icon: 'settings2', group: 'Configuración', Comp: ClusterConfig },
      { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
    ],
    cli: (r) => [
      { label: 'Obtener credenciales para kubectl', cmd: `az aks get-credentials -g ${r.resourceGroup} -n ${r.name}` },
      { label: 'Permitir que el clúster descargue imágenes de tu ACR', cmd: `az aks update -g ${r.resourceGroup} -n ${r.name} --attach-acr <nombre-acr>` },
    ],
  },
  'microsoft.containerinstance/containergroups': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Estado', <StatusPill status={r.properties.instanceView?.state ?? r.properties.provisioningState} />],
          ['Dirección IP', r.properties.ipAddress?.ip ? <a onClick={() => openUrl(`http://${r.properties.ipAddress.fqdn ?? r.properties.ipAddress.ip}:${r.properties.ipAddress.ports?.[0]?.port ?? 80}`)}>{r.properties.ipAddress.ip}</a> : '—'],
          ['FQDN', r.properties.ipAddress?.fqdn ?? '—'],
          ['Tipo de sistema operativo', r.properties.osType],
          ['Contenedores', String((r.properties.containers ?? []).length)],
        ]}
      />
    ),
    sections: [{ id: 'containers', label: 'Contenedores', icon: 'aci', group: 'Configuración', Comp: AciContainers }],
    cli: (r) => [{ label: 'Ver los registros', cmd: `az container logs ${gn(r).join(' ')}` }],
  },
};
