// Blade de un recurso, de un grupo de recursos o de una suscripción.
import { useState } from 'react';
import type { Resource, ResourceGroup, Subscription } from '../../engine/types';
import { useCloud, navigate, resourceHref, rgHref, useTick } from '../hooks';
import { BladeLayout, Essentials, ActivitySection, IamSection, TagsSection, LocksSection, JsonSection, CliHints, type MenuItem } from './blade';
import { typeBlade } from './types';
import { CommandBar, DataTable, JsonView, Callout, Empty, TagsView, confirmDialog, StatusPill, CodeBlock } from '../components/common';
import { ServiceIcon } from '../components/Icons';
import { portalAction } from '../portalCli';
import { openPane, toast } from '../uiStore';
import { getState, changed } from '../../engine/store';
import { getProvider, providerLabel } from '../../engine/registry';
import { findResource, monthlyCost, resourceToArm, touchRecent, rgToJson } from '../../engine/arm';
import { exportTemplate } from '../../engine/services/deployments';
import { formatDate, formatMoney, relTime } from '../../engine/util';
import { CREATE_FOR_TYPE } from './services';
import { vmPowerLabel } from './types/compute';
import { useEffect } from 'react';

const PROVISIONING_ES: Record<string, string> = { Succeeded: 'Correcto', Creating: 'Creando', Updating: 'Actualizando', Deleting: 'Eliminando', Failed: 'Error', Accepted: 'Aceptado', Canceled: 'Cancelado' };

export function provisioningLabel(state?: string) {
  return PROVISIONING_ES[state ?? 'Succeeded'] ?? state ?? 'Correcto';
}

function provisioningCallout(state?: string) {
  if (!state || state === 'Succeeded') return null;
  if (state === 'Failed') return <Callout kind="bad" title="Error de aprovisionamiento">El recurso está en estado Failed. Revisa el registro de actividad.</Callout>;
  return (
    <Callout kind="warn" title={state === 'Deleting' ? 'Eliminando...' : 'Implementación en curso...'}>
      Estado de aprovisionamiento: {state}. La página se actualizará automáticamente.
    </Callout>
  );
}

// ---------------------------------------------------------------- recurso

function ResourceView({ r, section }: { r: Resource; section: string }) {
  const s = useCloud();
  useTick(3000);
  const prov = getProvider(r.type);
  const tb = typeBlade(r.type);
  useEffect(() => touchRecent(r.id), [r.id]);
  const sub = s.subscriptions.find((x) => x.id === r.subscriptionId);
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Información general', icon: 'overview' },
    { id: 'activity', label: 'Registro de actividad', icon: 'activity' },
    { id: 'iam', label: 'Control de acceso (IAM)', icon: 'people' },
    { id: 'tags', label: 'Etiquetas', icon: 'tag' },
    ...(tb.sections ?? []).map((x) => ({ id: x.id, label: x.label, icon: x.icon, group: x.group })),
    { id: 'locks', label: 'Bloqueos', icon: 'lock', group: 'Configuración' },
    { id: 'export', label: 'Exportar plantilla', icon: 'braces', group: 'Automatización' },
    { id: 'json', label: 'Vista JSON', icon: 'json', group: 'Automatización' },
  ];
  const del = async () => {
    const ok = await confirmDialog({
      title: `Eliminar ${prov?.label?.toLowerCase() ?? 'recurso'}`,
      message: (
        <>
          ¿Seguro que quieres eliminar <b>{r.name}</b>? Esta acción no se puede deshacer.
          {r.type.toLowerCase() === 'microsoft.compute/virtualmachines' ? <p className="muted small">El disco del SO se eliminará con la VM. La interfaz de red y la IP pública permanecen en el grupo de recursos.</p> : null}
        </>
      ),
      confirmText: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    navigate(rgHref(r.subscriptionId, r.resourceGroup).slice(1));
    await portalAction(`Eliminar ${r.name}`, ['resource', 'delete', '--ids', r.id], { subscription: r.subscriptionId, success: `Se eliminó ${r.name}` });
  };
  const sec = tb.sections?.find((x) => x.id === section);
  let extra = section === 'overview' || !menu.some((m) => m.id === section) ? prov?.essentials?.(r, s) ?? [] : [];
  // Si el proveedor ya da un "Estado" más descriptivo, se usa en la columna izquierda y no se repite.
  const provStatus = extra.find(([k, v]) => k === 'Estado' && typeof v === 'string')?.[1] as string | undefined;
  extra = extra.filter(([k]) => k !== 'Estado');
  const statusText = vmPowerLabel(r) ?? provStatus ?? prov?.status?.(r) ?? provisioningLabel(r.properties.provisioningState);
  let body;
  if (section === 'overview' || !menu.some((m) => m.id === section)) {
    body = (
      <>
        <CommandBar items={[...(tb.commands?.(r) ?? []), { sep: true, label: '' }, { label: 'Eliminar', icon: 'delete', onClick: del }, { label: 'Actualizar', icon: 'refresh', onClick: () => navigate(resourceHref(r.id).slice(1)) }]} />
        {provisioningCallout(r.properties.provisioningState)}
        <Essentials
          left={[
            ['Grupo de recursos', { text: r.resourceGroup, link: `#/resource/${encodeURIComponent(`/subscriptions/${r.subscriptionId}/resourceGroups/${r.resourceGroup}`)}` }],
            ['Estado', <StatusPill status={statusText} />],
            ['Ubicación', r.location],
            ['Suscripción', { text: sub?.displayName ?? r.subscriptionId, link: `#/resource/${encodeURIComponent(`/subscriptions/${r.subscriptionId}`)}` }],
            ['Id. de suscripción', r.subscriptionId],
            ['Etiquetas', <TagsView tags={r.tags} />],
          ]}
          right={extra}
          onJson={() => openPane({ title: 'Vista JSON del recurso', width: 760, render: () => <div className="pane-body"><JsonView value={resourceToArm(r)} maxHeight={900} /></div> })}
        />
        {tb.Overview ? <tb.Overview r={r} /> : null}
        <CliHints cmds={[...(tb.cli?.(r) ?? []), { label: 'Ver el recurso completo en JSON', cmd: `az resource show --ids ${r.id}` }]} />
      </>
    );
  } else if (sec) body = <sec.Comp r={r} />;
  else if (section === 'activity') body = <ActivitySection scope={r.id} />;
  else if (section === 'iam') body = <IamSection scope={r.id} subscriptionId={r.subscriptionId} />;
  else if (section === 'tags') body = <TagsSection kind="resource" id={r.id} name={r.name} tags={r.tags} subscriptionId={r.subscriptionId} />;
  else if (section === 'locks') body = <LocksSection scope={r.id} subscriptionId={r.subscriptionId} />;
  else if (section === 'export') body = <ExportTemplate resources={[r]} />;
  else body = <JsonSection obj={resourceToArm(r)} />;
  return (
    <BladeLayout
      crumbs={[{ label: 'Inicio', href: '#/' }, { label: r.resourceGroup, href: rgHref(r.subscriptionId, r.resourceGroup) }, { label: r.name }]}
      icon={prov?.icon ?? 'all'}
      title={r.name}
      subtitle={providerLabel(r.type)}
      menu={menu}
      active={section}
      hrefFor={(id) => resourceHref(r.id, id === 'overview' ? undefined : id)}
    >
      {body}
    </BladeLayout>
  );
}

function ExportTemplate({ resources }: { resources: Resource[] }) {
  const tpl = exportTemplate(resources);
  const text = JSON.stringify(tpl, null, 2);
  return (
    <>
      <Callout>Plantilla ARM generada a partir del estado actual de los recursos. Puedes guardarla, ajustarla (parámetros) y volver a desplegarla con <code>az deployment group create</code>: es el primer paso hacia la infraestructura como código.</Callout>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button
          className="btn"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            a.download = 'template.json';
            a.click();
          }}
        >
          Descargar
        </button>
      </div>
      <JsonView value={tpl} maxHeight={640} />
    </>
  );
}

// ---------------------------------------------------------------- grupo de recursos

function RgOverview({ rg }: { rg: ResourceGroup }) {
  const s = useCloud();
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const list = s.resources.filter((r) => r.subscriptionId === rg.subscriptionId && r.resourceGroup.toLowerCase() === rg.name.toLowerCase() && !getProvider(r.type)?.hidden && r.name.toLowerCase().includes(q.toLowerCase()));
  const deps = s.deployments.filter((d) => d.subscriptionId === rg.subscriptionId && d.resourceGroup.toLowerCase() === rg.name.toLowerCase());
  const sub = s.subscriptions.find((x) => x.id === rg.subscriptionId);
  const delRg = async () => {
    const ok = await confirmDialog({
      title: 'Eliminar un grupo de recursos',
      message: (
        <>
          <Callout kind="bad">Se eliminarán el grupo de recursos <b>{rg.name}</b> y <b>todos</b> sus recursos ({list.length}). Esta acción no se puede deshacer.</Callout>
        </>
      ),
      confirmText: 'Eliminar',
      danger: true,
      requireText: rg.name,
    });
    if (!ok) return;
    navigate('/groups');
    await portalAction(`Eliminar el grupo de recursos ${rg.name}`, ['group', 'delete', '-n', rg.name, '--yes'], { subscription: rg.subscriptionId, success: `Se eliminó el grupo de recursos ${rg.name}` });
  };
  const delSel = async () => {
    if (!(await confirmDialog({ title: 'Eliminar recursos', message: `¿Eliminar ${sel.length} recurso(s)?`, confirmText: 'Eliminar', danger: true }))) return;
    await portalAction('Eliminar recursos', ['resource', 'delete', '--ids', ...sel], { subscription: rg.subscriptionId, success: `${sel.length} recurso(s) eliminado(s)` });
    setSel([]);
  };
  return (
    <>
      <CommandBar
        items={[
          { label: 'Crear', icon: 'add', onClick: () => navigate(`/services?rg=${encodeURIComponent(rg.name)}`) },
          { label: 'Eliminar grupo de recursos', icon: 'delete', onClick: delRg },
          { label: 'Eliminar', icon: 'delete', disabled: !sel.length, onClick: delSel },
          { label: 'Exportar plantilla', icon: 'braces', onClick: () => navigate(rgHref(rg.subscriptionId, rg.name, 'export').slice(1)) },
        ]}
      />
      {rg.provisioningState === 'Deleting' ? <Callout kind="warn">El grupo de recursos se está eliminando...</Callout> : null}
      <Essentials
        left={[
          ['Suscripción', { text: sub?.displayName ?? rg.subscriptionId, link: `#/resource/${encodeURIComponent(`/subscriptions/${rg.subscriptionId}`)}` }],
          ['Id. de suscripción', rg.subscriptionId],
          ['Etiquetas', <TagsView tags={rg.tags} />],
        ]}
        right={[
          ['Implementaciones', <a href={rgHref(rg.subscriptionId, rg.name, 'deployments')}>{deps.length ? `${deps.filter((d) => d.provisioningState === 'Succeeded').length} correctas` : 'Sin implementaciones'}</a>],
          ['Ubicación', rg.location],
          ['Administrado por', rg.managedBy ? <a href={resourceHref(rg.managedBy)}>{rg.managedBy.split('/').pop()}</a> : '—'],
        ]}
        onJson={() => openPane({ title: 'Vista JSON', render: () => <div className="pane-body"><JsonView value={rgToJson(rg)} /></div> })}
      />
      {rg.managedBy ? <Callout kind="warn">Este grupo lo administra otro recurso (por ejemplo, un clúster de AKS). No modifiques sus recursos directamente.</Callout> : null}
      <div className="list-toolbar">
        <input className="input" placeholder="Filtrar por nombre..." value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">
          Mostrando {list.length} registros. Coste estimado: {formatMoney(list.reduce((a, r) => a + monthlyCost(r, s), 0))}/mes
        </span>
      </div>
      <DataTable
        rows={list}
        rowKey={(r) => r.id}
        selectable
        selected={sel}
        onSelect={setSel}
        columns={[
          {
            key: 'n',
            title: 'Nombre',
            sort: (r) => r.name,
            render: (r) => (
              <a href={resourceHref(r.id)} className="row" style={{ gap: 8 }}>
                <ServiceIcon name={getProvider(r.type)?.icon ?? 'all'} />
                {r.name}
              </a>
            ),
          },
          { key: 't', title: 'Tipo', render: (r) => providerLabel(r.type), sort: (r) => providerLabel(r.type) },
          { key: 'l', title: 'Ubicación', render: (r) => r.location, sort: (r) => r.location },
          { key: 's', title: 'Estado', render: (r) => (r.properties.provisioningState && r.properties.provisioningState !== 'Succeeded' ? <span className="pill warn">{r.properties.provisioningState}</span> : vmPowerLabel(r) ?? '') },
        ]}
        empty={
          <Empty title="No hay recursos para mostrar">
            Crea recursos en este grupo desde el portal o con Azure CLI, por ejemplo: <code>az storage account create -g {rg.name} ...</code>
          </Empty>
        }
      />
      <CliHints
        cmds={[
          { label: 'Listar los recursos del grupo', cmd: `az resource list -g ${rg.name} -o table` },
          { label: 'Eliminar el grupo y todo su contenido', cmd: `az group delete -n ${rg.name} --yes --no-wait` },
        ]}
      />
    </>
  );
}

function Deployments({ rg }: { rg: ResourceGroup }) {
  const s = useCloud();
  const [sel, setSel] = useState<string | null>(null);
  const deps = s.deployments.filter((d) => d.subscriptionId === rg.subscriptionId && d.resourceGroup.toLowerCase() === rg.name.toLowerCase()).slice().reverse();
  const cur = deps.find((d) => d.id === sel);
  return (
    <>
      <p className="muted">Cada creación desde el portal, plantilla ARM, Bicep o pipeline queda registrada como una implementación del grupo de recursos.</p>
      <DataTable
        rows={deps}
        rowKey={(d) => d.id}
        onRowClick={(d) => setSel(d.id === sel ? null : d.id)}
        columns={[
          { key: 'n', title: 'Nombre de la implementación', render: (d) => <b>{d.name}</b> },
          { key: 's', title: 'Estado', render: (d) => <StatusPill status={d.provisioningState} /> },
          { key: 'o', title: 'Origen', render: (d) => d.source },
          { key: 't', title: 'Última modificación', render: (d) => relTime(d.timestamp) },
          { key: 'du', title: 'Duración', render: (d) => d.duration ?? '—' },
          { key: 'r', title: 'Recursos', render: (d) => d.outputResources.length },
        ]}
        empty="No hay implementaciones."
      />
      {cur ? (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>{cur.name}</h3>
          {cur.error ? <Callout kind="bad" title={cur.error.code}>{cur.error.message}</Callout> : null}
          <div className="grid2">
            <div>
              <h4>Recursos</h4>
              {cur.outputResources.map((o) => (
                <div key={o.id} className="small">
                  {findResource(o.id) ? <a href={resourceHref(o.id)}>{o.id.split('/').pop()}</a> : o.id.split('/').pop()}
                </div>
              ))}
            </div>
            <div>
              <h4>Salidas</h4>
              {Object.keys(cur.outputs ?? {}).length ? <JsonView value={cur.outputs} /> : <span className="muted">Sin salidas</span>}
            </div>
          </div>
          {cur.template ? (
            <>
              <h4 style={{ marginTop: 12 }}>Plantilla</h4>
              <CodeBlock code={JSON.stringify(cur.template, null, 2)} maxHeight={320} />
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function RgCost({ rg }: { rg: ResourceGroup }) {
  const s = useCloud();
  const list = s.resources.filter((r) => r.subscriptionId === rg.subscriptionId && r.resourceGroup.toLowerCase() === rg.name.toLowerCase());
  const rows = list.map((r) => ({ r, month: monthlyCost(r, s), acc: s.costs[r.id]?.amount ?? 0 })).sort((a, b) => b.month - a.month);
  return (
    <>
      <Callout>En el simulador, 1 minuto real equivale a 1 hora de facturación. Detén o elimina lo que no uses: así se aprende a controlar el gasto.</Callout>
      <DataTable
        rows={rows}
        rowKey={(x) => x.r.id}
        columns={[
          { key: 'n', title: 'Recurso', render: (x) => <a href={resourceHref(x.r.id)}>{x.r.name}</a> },
          { key: 't', title: 'Tipo', render: (x) => providerLabel(x.r.type) },
          { key: 'a', title: 'Coste acumulado', render: (x) => formatMoney(x.acc) },
          { key: 'm', title: 'Previsión mensual', render: (x) => formatMoney(x.month) },
        ]}
      />
    </>
  );
}

function RgView({ rg, section }: { rg: ResourceGroup; section: string }) {
  const s = useCloud();
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Información general', icon: 'overview' },
    { id: 'activity', label: 'Registro de actividad', icon: 'activity' },
    { id: 'iam', label: 'Control de acceso (IAM)', icon: 'people' },
    { id: 'tags', label: 'Etiquetas', icon: 'tag' },
    { id: 'deployments', label: 'Implementaciones', icon: 'rocket', group: 'Configuración' },
    { id: 'locks', label: 'Bloqueos', icon: 'lock', group: 'Configuración' },
    { id: 'cost', label: 'Análisis de costes', icon: 'chart', group: 'Cost Management' },
    { id: 'export', label: 'Exportar plantilla', icon: 'braces', group: 'Automatización' },
  ];
  let body;
  if (section === 'activity') body = <ActivitySection scope={rg.id} />;
  else if (section === 'iam') body = <IamSection scope={rg.id} subscriptionId={rg.subscriptionId} />;
  else if (section === 'tags') body = <TagsSection kind="rg" id={rg.id} name={rg.name} tags={rg.tags} subscriptionId={rg.subscriptionId} />;
  else if (section === 'deployments') body = <Deployments rg={rg} />;
  else if (section === 'locks') body = <LocksSection scope={rg.id} subscriptionId={rg.subscriptionId} />;
  else if (section === 'cost') body = <RgCost rg={rg} />;
  else if (section === 'export') body = <ExportTemplate resources={s.resources.filter((r) => r.subscriptionId === rg.subscriptionId && r.resourceGroup.toLowerCase() === rg.name.toLowerCase())} />;
  else body = <RgOverview rg={rg} />;
  return (
    <BladeLayout crumbs={[{ label: 'Inicio', href: '#/' }, { label: 'Grupos de recursos', href: '#/groups' }, { label: rg.name }]} icon="rg" title={rg.name} subtitle="Grupo de recursos" menu={menu} active={section} hrefFor={(id) => rgHref(rg.subscriptionId, rg.name, id === 'overview' ? undefined : id)}>
      {body}
    </BladeLayout>
  );
}

// ---------------------------------------------------------------- suscripción

function SubView({ sub, section }: { sub: Subscription; section: string }) {
  const s = useCloud();
  const scope = `/subscriptions/${sub.id}`;
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Información general', icon: 'overview' },
    { id: 'activity', label: 'Registro de actividad', icon: 'activity' },
    { id: 'iam', label: 'Control de acceso (IAM)', icon: 'people' },
    { id: 'groups', label: 'Grupos de recursos', icon: 'folder', group: 'Configuración' },
    { id: 'locks', label: 'Bloqueos', icon: 'lock', group: 'Configuración' },
  ];
  const rgs = s.resourceGroups.filter((g) => g.subscriptionId === sub.id);
  let body;
  if (section === 'activity') body = <ActivitySection scope={scope} />;
  else if (section === 'iam') body = <IamSection scope={scope} subscriptionId={sub.id} />;
  else if (section === 'locks') body = <LocksSection scope={scope} subscriptionId={sub.id} />;
  else if (section === 'groups')
    body = <DataTable rows={rgs} rowKey={(g) => g.id} columns={[{ key: 'n', title: 'Nombre', render: (g) => <a href={rgHref(g.subscriptionId, g.name)}>{g.name}</a> }, { key: 'l', title: 'Ubicación', render: (g) => g.location }]} empty="No hay grupos de recursos." />;
  else
    body = (
      <>
        <CommandBar
          items={[
            {
              label: 'Establecer como predeterminada',
              icon: 'check',
              disabled: s.currentSubscriptionId === sub.id,
              onClick: () => {
                // Afecta al portal (filtros, asistentes); Cloud Shell mantiene la suya (az account set).
                getState().currentSubscriptionId = sub.id;
                changed();
                toast(`${sub.displayName} es ahora la suscripción predeterminada del portal`, 'success', 'En Cloud Shell cámbiala con az account set --subscription "<nombre>".');
              },
            },
          ]}
        />
        <Essentials
          left={[
            ['Id. de suscripción', sub.id],
            ['Directorio', `${s.tenant.displayName} (${s.tenant.domain})`],
            ['Estado', sub.state === 'Enabled' ? 'Activa' : sub.state],
          ]}
          right={[
            ['Oferta', sub.offer],
            ['Grupos de recursos', String(rgs.length)],
            ['Recursos', String(s.resources.filter((r) => r.subscriptionId === sub.id).length)],
          ]}
        />
        <Callout>
          La suscripción es la unidad de facturación y un límite de administración: los roles y directivas asignados aquí se heredan en todos sus grupos de recursos y recursos.
        </Callout>
      </>
    );
  return (
    <BladeLayout crumbs={[{ label: 'Inicio', href: '#/' }, { label: 'Suscripciones', href: '#/subscriptions' }, { label: sub.displayName }]} icon="subscription" title={sub.displayName} subtitle="Suscripción" menu={menu} active={section} hrefFor={(id) => resourceHref(scope, id === 'overview' ? undefined : id)}>
      {body}
    </BladeLayout>
  );
}

export function ResourceRoute({ id, section }: { id: string; section: string }) {
  const s = useCloud();
  const m = /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?\/?$/i.exec(id);
  if (m && !m[2]) {
    const sub = s.subscriptions.find((x) => x.id.toLowerCase() === m[1].toLowerCase());
    if (sub) return <SubView sub={sub} section={section} />;
  }
  if (m && m[2]) {
    const rg = s.resourceGroups.find((g) => g.subscriptionId.toLowerCase() === m[1].toLowerCase() && g.name.toLowerCase() === m[2].toLowerCase());
    if (rg) return <RgView rg={rg} section={section} />;
  }
  const r = findResource(id);
  if (r) return <ResourceView r={r} section={section} />;
  return (
    <div className="page">
      <Empty title="No se encontró el recurso">
        El recurso <span className="mono">{id}</span> no existe o se ha eliminado. <a href="#/resources">Ver todos los recursos</a>
      </Empty>
    </div>
  );
}

export function createKindFor(type: string) {
  return CREATE_FOR_TYPE[type.toLowerCase()];
}
