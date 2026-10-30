// Páginas del portal: inicio, todos los servicios, listas de recursos, grupos de recursos y suscripciones.
import { useMemo, useState } from 'react';
import { useCloud, navigate, resourceHref, rgHref, useRoute } from '../hooks';
import { ServiceIcon, Icon } from '../components/Icons';
import { CommandBar, DataTable, Empty, confirmDialog, Select } from '../components/common';
import { Crumbs } from './blade';
import { SERVICES, serviceHref, CREATE_FOR_TYPE, type ServiceDef } from './services';
import { getProvider, providerLabel } from '../../engine/registry';
import { monthlyCost, findResource } from '../../engine/arm';
import { formatMoney, relTime } from '../../engine/util';
import { portalAction } from '../portalCli';
import { setUi } from '../uiStore';
import { academyProgress, currentStop } from '../academy/progress';
import { vmPowerLabel } from './types/compute';
import { forecastMonthly, totalCost } from '../../engine/services/cost';

const HOME_TILES = ['vm', 'webapp', 'storage', 'sqldb', 'aks', 'acr', 'kv', 'vnet', 'monitor', 'devops'];

export function Home() {
  const s = useCloud();
  const prog = academyProgress();
  const stop = currentStop();
  const recent = s.recent.map((id) => findResource(id)).filter((r): r is NonNullable<typeof r> => !!r).slice(0, 8);
  return (
    <div className="page">
      <h1 style={{ fontSize: 20, margin: '4px 0 16px' }}>Servicios de Azure</h1>
      <div className="tiles" style={{ marginBottom: 22 }}>
        <a className="tile" href="#/services">
          <span style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)' }}>
            <Icon name="add" size={30} />
          </span>
          Crear un recurso
        </a>
        {HOME_TILES.map((id) => {
          const sv = SERVICES.find((x) => x.id === id)!;
          return (
            <a key={id} className="tile" href={serviceHref(sv)}>
              <ServiceIcon name={sv.icon} size={36} />
              {sv.label}
            </a>
          );
        })}
        <a className="tile" href="#/services">
          <span style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)' }}>
            <Icon name="chevron" size={26} />
          </span>
          Más servicios
        </a>
      </div>

      <div className="card elev" style={{ marginBottom: 22, display: 'flex', gap: 20, alignItems: 'center', background: 'linear-gradient(110deg, var(--xp-soft), var(--accent-soft))', border: 0 }}>
        <ServiceIcon name="academy" size={52} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{stop ? `Continúa tu ruta: ${stop.levelTitle}` : '¡Has completado la ruta de la Academia!'}</div>
          <div className="muted">
            {stop ? (
              <>
                Siguiente: <b>{stop.title}</b> · Rango actual: {prog.rank.icon} {prog.rank.name} · {prog.xp} XP
              </>
            ) : (
              'Eres un auténtico DevOps. Sigue practicando en el portal y en Cloud Shell.'
            )}
          </div>
          <div className="progress xp" style={{ marginTop: 8, maxWidth: 420 }}>
            <div style={{ width: `${prog.percent}%` }} />
          </div>
        </div>
        <button className="btn primary" onClick={() => navigate(stop?.href ?? '/academy')}>
          {stop ? 'Continuar' : 'Ver la Academia'}
        </button>
      </div>

      <div className="grid2">
        <div>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Recursos recientes</h2>
          {recent.length ? (
            <DataTable
              rows={recent}
              rowKey={(r) => r.id}
              columns={[
                { key: 'n', title: 'Nombre', render: (r) => <a href={resourceHref(r.id)} className="row" style={{ gap: 8 }}><ServiceIcon name={getProvider(r.type)?.icon ?? 'all'} />{r.name}</a> },
                { key: 't', title: 'Tipo', render: (r) => providerLabel(r.type) },
              ]}
            />
          ) : (
            <div className="card muted">Aún no has abierto ningún recurso. Empieza creando un grupo de recursos o sigue el nivel 1 de la Academia.</div>
          )}
        </div>
        <div>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Navegar</h2>
          <div className="card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              ['subscription', 'Suscripciones', '#/subscriptions'],
              ['rg', 'Grupos de recursos', '#/groups'],
              ['all', 'Todos los recursos', '#/resources'],
              ['entra', 'Microsoft Entra ID', '#/entra'],
              ['cost', 'Cost Management', '#/cost'],
              ['policy', 'Directiva', '#/policy'],
            ].map(([icon, label, href]) => (
              <a key={href} href={href} className="row" style={{ gap: 10 }}>
                <ServiceIcon name={icon} size={22} />
                {label}
              </a>
            ))}
          </div>
          <h2 style={{ fontSize: 16, margin: '18px 0 10px' }}>Herramientas</h2>
          <div className="card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <a onClick={() => setUi({ shellOpen: true })} className="row" style={{ gap: 10 }}>
              <ServiceIcon name="shell" size={22} />
              Cloud Shell
            </a>
            <a href="#/devops" className="row" style={{ gap: 10 }}>
              <ServiceIcon name="devops" size={22} />
              Azure DevOps
            </a>
            <a href="#/monitor" className="row" style={{ gap: 10 }}>
              <ServiceIcon name="monitor" size={22} />
              Monitor
            </a>
            <a href="#/cost" className="row" style={{ gap: 10 }}>
              <ServiceIcon name="cost" size={22} />
              Coste: {formatMoney(totalCost(s))} (previsión {formatMoney(forecastMonthly(s))}/mes)
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AllServices() {
  const route = useRoute();
  const [q, setQ] = useState('');
  const rg = route.query.get('rg');
  const cats = useMemo(() => {
    const m = new Map<string, ServiceDef[]>();
    for (const sv of SERVICES.filter((x) => (x.label + ' ' + (x.keywords ?? '') + ' ' + (x.description ?? '')).toLowerCase().includes(q.toLowerCase()))) {
      if (!m.has(sv.category)) m.set(sv.category, []);
      m.get(sv.category)!.push(sv);
    }
    return [...m.entries()];
  }, [q]);
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Todos los servicios' }]} />
      <div className="page-head">
        <h1>Todos los servicios</h1>
      </div>
      <input className="input" style={{ maxWidth: 420, marginBottom: 18 }} placeholder="Filtrar servicios" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {cats.map(([cat, list]) => (
        <div key={cat} style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>{cat}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {list.map((sv) => (
              <div key={sv.id} className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <ServiceIcon name={sv.icon} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={serviceHref(sv)} style={{ fontWeight: 600 }}>
                    {sv.label}
                  </a>
                  <div className="muted small">{sv.description}</div>
                  {sv.create ? (
                    <a className="small" href={`#/create/${sv.create}${rg ? `?rg=${encodeURIComponent(rg)}` : ''}`}>
                      + Crear
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResourceList({ title, type, icon }: { title: string; type?: string; icon: string }) {
  const s = useCloud();
  const [q, setQ] = useState('');
  const [sub, setSub] = useState('all');
  const [sel, setSel] = useState<string[]>([]);
  const list = s.resources.filter((r) => !getProvider(r.type)?.hidden && (!type || r.type.toLowerCase() === type.toLowerCase()) && (sub === 'all' || r.subscriptionId === sub) && (r.name + r.resourceGroup).toLowerCase().includes(q.toLowerCase()));
  const create = type ? CREATE_FOR_TYPE[type.toLowerCase()] : undefined;
  const del = async () => {
    if (!(await confirmDialog({ title: 'Eliminar recursos', message: `¿Eliminar ${sel.length} recurso(s)? Esta acción no se puede deshacer.`, confirmText: 'Eliminar', danger: true }))) return;
    for (const id of sel) {
      const r = findResource(id);
      if (r) await portalAction(`Eliminar ${r.name}`, ['resource', 'delete', '--ids', id], { subscription: r.subscriptionId, quiet: true });
    }
    setSel([]);
  };
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: title }]} />
      <div className="page-head">
        <ServiceIcon name={icon} size={34} />
        <div>
          <h1>{title}</h1>
          <div className="subtitle">{s.tenant.displayName}</div>
        </div>
      </div>
      <CommandBar
        items={[
          { label: 'Crear', icon: 'add', onClick: () => navigate(create ? `/create/${create}` : '/services') },
          { label: 'Eliminar', icon: 'delete', disabled: !sel.length, onClick: del },
        ]}
      />
      <div className="list-toolbar">
        <input className="input" placeholder="Filtrar por cualquier campo..." value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ width: 260 }}>
          <Select value={sub} onChange={setSub} options={[{ value: 'all', label: 'Suscripción: todas' }, ...s.subscriptions.map((x) => ({ value: x.id, label: x.displayName }))]} />
        </div>
        <span className="muted">{list.length} registros</span>
      </div>
      <DataTable
        rows={list}
        rowKey={(r) => r.id}
        selectable
        selected={sel}
        onSelect={setSel}
        columns={[
          { key: 'n', title: 'Nombre', sort: (r) => r.name, render: (r) => <a href={resourceHref(r.id)} className="row" style={{ gap: 8 }}><ServiceIcon name={getProvider(r.type)?.icon ?? 'all'} />{r.name}</a> },
          ...(type ? [] : [{ key: 't', title: 'Tipo', sort: (r: any) => providerLabel(r.type), render: (r: any) => providerLabel(r.type) }]),
          { key: 'g', title: 'Grupo de recursos', sort: (r) => r.resourceGroup, render: (r) => <a href={rgHref(r.subscriptionId, r.resourceGroup)}>{r.resourceGroup}</a> },
          { key: 'l', title: 'Ubicación', sort: (r) => r.location, render: (r) => r.location },
          { key: 's', title: 'Suscripción', render: (r) => s.subscriptions.find((x) => x.id === r.subscriptionId)?.displayName ?? r.subscriptionId },
          { key: 'st', title: 'Estado', render: (r) => (r.properties.provisioningState && r.properties.provisioningState !== 'Succeeded' ? <span className="pill warn">{r.properties.provisioningState}</span> : vmPowerLabel(r) ?? getProvider(r.type)?.status?.(r) ?? '') },
          { key: 'c', title: 'Coste/mes', render: (r) => formatMoney(monthlyCost(r, s)), sort: (r) => monthlyCost(r, s) },
        ]}
        empty={
          <Empty icon={<ServiceIcon name={icon} size={64} />} title={`No hay ${title.toLowerCase()} para mostrar`}>
            {create ? (
              <>
                <p>Crea uno desde el portal o con Azure CLI en Cloud Shell.</p>
                <button className="btn primary" onClick={() => navigate(`/create/${create}`)}>
                  Crear
                </button>
              </>
            ) : null}
          </Empty>
        }
      />
    </div>
  );
}

export function AllResources() {
  return <ResourceList title="Todos los recursos" icon="all" />;
}

export function BrowseType({ type }: { type: string }) {
  const prov = getProvider(type);
  const sv = SERVICES.find((x) => x.type?.toLowerCase() === type.toLowerCase());
  return <ResourceList title={sv?.label ?? prov?.labelPlural ?? type} type={prov?.type ?? type} icon={prov?.icon ?? sv?.icon ?? 'all'} />;
}

export function ResourceGroups() {
  const s = useCloud();
  const [q, setQ] = useState('');
  const list = s.resourceGroups.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Grupos de recursos' }]} />
      <div className="page-head">
        <ServiceIcon name="rg" size={34} />
        <div>
          <h1>Grupos de recursos</h1>
          <div className="subtitle">{s.tenant.displayName}</div>
        </div>
      </div>
      <CommandBar items={[{ label: 'Crear', icon: 'add', onClick: () => navigate('/create/rg') }]} />
      <div className="list-toolbar">
        <input className="input" placeholder="Filtrar por nombre..." value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">{list.length} registros</span>
      </div>
      <DataTable
        rows={list}
        rowKey={(g) => g.id}
        columns={[
          { key: 'n', title: 'Nombre', sort: (g) => g.name, render: (g) => <a href={rgHref(g.subscriptionId, g.name)} className="row" style={{ gap: 8 }}><ServiceIcon name="rg" />{g.name}</a> },
          { key: 's', title: 'Suscripción', render: (g) => s.subscriptions.find((x) => x.id === g.subscriptionId)?.displayName },
          { key: 'l', title: 'Ubicación', sort: (g) => g.location, render: (g) => g.location },
          { key: 'r', title: 'Recursos', render: (g) => s.resources.filter((r) => r.subscriptionId === g.subscriptionId && r.resourceGroup.toLowerCase() === g.name.toLowerCase() && !getProvider(r.type)?.hidden).length },
          { key: 'e', title: 'Estado', render: (g) => (g.provisioningState === 'Deleting' ? <span className="pill warn">Eliminando</span> : '') },
          { key: 'c', title: 'Creado', render: (g) => relTime(g.createdAt) },
        ]}
        empty={
          <Empty icon={<ServiceIcon name="rg" size={64} />} title="No hay grupos de recursos para mostrar">
            <p>Un grupo de recursos es un contenedor que agrupa los recursos de una solución. Crea el primero.</p>
            <button className="btn primary" onClick={() => navigate('/create/rg')}>
              Crear grupo de recursos
            </button>
          </Empty>
        }
      />
    </div>
  );
}

export function Subscriptions() {
  const s = useCloud();
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Suscripciones' }]} />
      <div className="page-head">
        <ServiceIcon name="subscription" size={34} />
        <h1>Suscripciones</h1>
      </div>
      <DataTable
        rows={s.subscriptions}
        rowKey={(x) => x.id}
        columns={[
          { key: 'n', title: 'Nombre de la suscripción', render: (x) => <a href={resourceHref(`/subscriptions/${x.id}`)}>{x.displayName}</a> },
          { key: 'i', title: 'Id. de suscripción', render: (x) => <span className="mono small">{x.id}</span> },
          { key: 'r', title: 'Mi rol', render: () => 'Propietario' },
          { key: 'c', title: 'Coste actual', render: (x) => formatMoney(totalCost(s, x.id)) },
          { key: 'd', title: '', render: (x) => (s.currentSubscriptionId === x.id ? <span className="pill info">Predeterminada</span> : null) },
        ]}
      />
    </div>
  );
}
