// Estructura del portal: barra superior, búsqueda global, menú lateral, notificaciones, ajustes y avisos.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCloud, navigate, resourceHref, rgHref, useRoute } from '../hooks';
import { setUi, useUi, closePane } from '../uiStore';
import { Icon, ServiceIcon } from '../components/Icons';
import { confirmDialog, initials, Checkbox, Radio } from '../components/common';
import { SERVICES, serviceHref, serviceForType } from './services';
import { getProvider, providerLabel } from '../../engine/registry';
import { changed, getState, resetCloud, replaceState, flushSave } from '../../engine/store';
import { flushRemote, isRemote, readKey } from '../../engine/persistence';
import { relTime } from '../../engine/util';
import { academyProgress, resetAcademy, replaceProgress } from '../academy/progress';

// ---------------------------------------------------------------- búsqueda global

function GlobalSearch() {
  const s = useCloud();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, []);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [] as { group: string; label: string; sub: string; icon: string; href: string }[];
    const svc = SERVICES.filter((x) => (x.label + ' ' + (x.keywords ?? '')).toLowerCase().includes(t))
      .slice(0, 6)
      .map((x) => ({ group: 'Servicios', label: x.label, sub: x.category, icon: x.icon, href: serviceHref(x) }));
    const rgs = s.resourceGroups
      .filter((g) => g.name.toLowerCase().includes(t))
      .slice(0, 5)
      .map((g) => ({ group: 'Grupos de recursos', label: g.name, sub: 'Grupo de recursos', icon: 'rg', href: rgHref(g.subscriptionId, g.name) }));
    const res = s.resources
      .filter((r) => !getProvider(r.type)?.hidden && r.name.toLowerCase().includes(t))
      .slice(0, 8)
      .map((r) => ({ group: 'Recursos', label: r.name, sub: providerLabel(r.type), icon: getProvider(r.type)?.icon ?? 'all', href: resourceHref(r.id) }));
    const users = s.users
      .filter((u) => (u.displayName + u.userPrincipalName).toLowerCase().includes(t))
      .slice(0, 4)
      .map((u) => ({ group: 'Microsoft Entra ID', label: u.displayName, sub: u.userPrincipalName, icon: 'identity', href: '#/entra/users' }));
    const docs = 'documentación ayuda academia lección ejercicio'.includes(t) ? [{ group: 'Academia', label: 'Abrir la Academia', sub: 'Aprendizaje', icon: 'academy', href: '#/academy' }] : [];
    return [...svc, ...res, ...rgs, ...users, ...docs];
  }, [q, s.resources.length, s.resourceGroups.length, s.users.length]);
  const go = (href: string) => {
    setOpen(false);
    setQ('');
    navigate(href);
  };
  let lastGroup = '';
  return (
    <div className="topbar-search" ref={ref}>
      <Icon name="search" className="icon" size={14} />
      <input
        placeholder="Buscar recursos, servicios y documentos (G+/)"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setSel(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel(Math.min(sel + 1, results.length - 1));
          if (e.key === 'ArrowUp') setSel(Math.max(sel - 1, 0));
          if (e.key === 'Enter' && results[sel]) go(results[sel].href);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && q.trim() ? (
        <div className="search-results">
          {!results.length ? <div className="muted" style={{ padding: '10px 14px' }}>No se encontraron resultados para "{q}".</div> : null}
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? <h5>{r.group}</h5> : null;
            lastGroup = r.group;
            return (
              <div key={i}>
                {head}
                <div className={`search-item${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={() => go(r.href)}>
                  <ServiceIcon name={r.icon} />
                  <span>{r.label}</span>
                  <span className="sub">{r.sub}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- barra superior

export function TopBar() {
  const s = useCloud();
  const u = useUi();
  const unread = s.notifications.filter((n) => !n.read).length;
  const unreadMail = s.emails.filter((m) => !m.read).length;
  const prog = academyProgress();
  return (
    <div className="topbar">
      <button className="topbar-btn" onClick={() => setUi({ navCollapsed: !u.navCollapsed })} title="Mostrar u ocultar el menú del portal">
        <Icon name="menu" />
      </button>
      <a className="brand" href="#/" style={{ textDecoration: 'none' }}>
        Microsoft Azure <small>· Azure Lab</small>
      </a>
      <button className="topbar-btn academy-btn" onClick={() => navigate('/academy')} title="Academia: niveles y ejercicios guiados">
        🎓 Academia <span style={{ opacity: 0.8, fontWeight: 400 }}>· {prog.xp} XP</span>
      </button>
      <GlobalSearch />
      <button className={`topbar-btn${u.shellOpen ? ' active' : ''}`} onClick={() => setUi({ shellOpen: !u.shellOpen })} title="Cloud Shell">
        <Icon name="shell" />
      </button>
      <button className="topbar-btn" onClick={() => navigate('/devops')} title="Azure DevOps">
        <ServiceIcon name="devops" size={16} />
      </button>
      <button className="topbar-btn" onClick={() => navigate('/mail')} title="Correo (simulado)">
        <Icon name="info" style={{ display: 'none' }} />
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
          <path d="M2 4h16v12H2zm1.4 1.7v8.9h13.2V5.7L10 10.6zM4.2 5.4 10 9.2l5.8-3.8z" />
        </svg>
        {unreadMail ? <span className="badge">{unreadMail}</span> : null}
      </button>
      <button className={`topbar-btn${u.notificationsOpen ? ' active' : ''}`} onClick={() => setUi({ notificationsOpen: !u.notificationsOpen, settingsOpen: false, accountOpen: false })} title="Notificaciones">
        <Icon name="bell" />
        {unread ? <span className="badge">{unread}</span> : null}
      </button>
      <button className={`topbar-btn${u.settingsOpen ? ' active' : ''}`} onClick={() => setUi({ settingsOpen: !u.settingsOpen, notificationsOpen: false, accountOpen: false })} title="Configuración">
        <Icon name="gear" />
      </button>
      <button className="topbar-btn" onClick={() => navigate('/academy/guide')} title="Ayuda y guía">
        <Icon name="help" />
      </button>
      <button className={`topbar-btn${u.accountOpen ? ' active' : ''}`} onClick={() => setUi({ accountOpen: !u.accountOpen, notificationsOpen: false, settingsOpen: false })} title={s.me.upn}>
        <span className="topbar-account">
          <span>{s.me.upn}</span>
          <small>{s.tenant.displayName}</small>
        </span>
        <span className="avatar">{initials(s.me.displayName)}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- menú lateral

const NAV: ({ id: string; label: string; icon: string; href: string } | 'sep' | { title: string })[] = [
  { id: 'home', label: 'Inicio', icon: 'all', href: '#/' },
  { id: 'academy', label: 'Academia', icon: 'academy', href: '#/academy' },
  { id: 'services', label: 'Todos los servicios', icon: 'all', href: '#/services' },
  'sep',
  { title: 'Favoritos' },
  { id: 'resources', label: 'Todos los recursos', icon: 'all', href: '#/resources' },
  { id: 'groups', label: 'Grupos de recursos', icon: 'rg', href: '#/groups' },
  { id: 'vm', label: 'Máquinas virtuales', icon: 'vm', href: '#/browse/' + encodeURIComponent('Microsoft.Compute/virtualMachines') },
  { id: 'webapp', label: 'App Services', icon: 'webapp', href: '#/browse/' + encodeURIComponent('Microsoft.Web/sites') },
  { id: 'storage', label: 'Cuentas de almacenamiento', icon: 'storage', href: '#/browse/' + encodeURIComponent('Microsoft.Storage/storageAccounts') },
  { id: 'sql', label: 'Bases de datos SQL', icon: 'sqldb', href: '#/browse/' + encodeURIComponent('Microsoft.Sql/servers/databases') },
  { id: 'vnet', label: 'Redes virtuales', icon: 'vnet', href: '#/browse/' + encodeURIComponent('Microsoft.Network/virtualNetworks') },
  { id: 'aks', label: 'Kubernetes', icon: 'aks', href: '#/browse/' + encodeURIComponent('Microsoft.ContainerService/managedClusters') },
  { id: 'acr', label: 'Registros de contenedor', icon: 'acr', href: '#/browse/' + encodeURIComponent('Microsoft.ContainerRegistry/registries') },
  { id: 'kv', label: 'Almacenes de claves', icon: 'keyvault', href: '#/browse/' + encodeURIComponent('Microsoft.KeyVault/vaults') },
  'sep',
  { id: 'entra', label: 'Microsoft Entra ID', icon: 'entra', href: '#/entra' },
  { id: 'monitor', label: 'Monitor', icon: 'monitor', href: '#/monitor' },
  { id: 'cost', label: 'Cost Management', icon: 'cost', href: '#/cost' },
  { id: 'advisor', label: 'Advisor', icon: 'advisor', href: '#/advisor' },
  { id: 'policy', label: 'Directiva', icon: 'policy', href: '#/policy' },
  { id: 'subs', label: 'Suscripciones', icon: 'subscription', href: '#/subscriptions' },
  'sep',
  { id: 'devops', label: 'Azure DevOps', icon: 'devops', href: '#/devops' },
];

export function SideNav() {
  const u = useUi();
  const route = useRoute();
  const cur = '#' + route.path;
  return (
    <nav className={`sidenav${u.navCollapsed ? ' collapsed' : ''}`}>
      {NAV.map((n, i) => {
        if (n === 'sep') return <div key={i} className="sidenav-sep" />;
        if ('title' in n) return <div key={i} className="sidenav-title">{n.title}</div>;
        const active = n.href === '#/' ? cur === '#/' : cur.startsWith(n.href);
        return (
          <a key={n.id} href={n.href} className={`sidenav-item${active ? ' active' : ''}`} title={n.label}>
            <ServiceIcon name={n.icon} />
            <span className="label">{n.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------- notificaciones

export function NotificationsFlyout() {
  const s = useCloud();
  const u = useUi();
  useEffect(() => {
    if (!u.notificationsOpen) return;
    const t = setTimeout(() => {
      let any = false;
      for (const n of getState().notifications)
        if (!n.read && n.level !== 'progress') {
          n.read = true;
          any = true;
        }
      if (any) changed();
    }, 1500);
    return () => clearTimeout(t);
  }, [u.notificationsOpen, s.notifications.length]);
  if (!u.notificationsOpen) return null;
  const icon = (l: string) => (l === 'success' ? <Icon name="success" style={{ color: 'var(--success)' }} /> : l === 'error' ? <Icon name="error" style={{ color: 'var(--danger-icon)' }} /> : l === 'warning' ? <Icon name="warn" style={{ color: 'var(--warning-icon)' }} /> : l === 'progress' ? <span className="spinner" /> : <Icon name="info" style={{ color: 'var(--accent)' }} />);
  return (
    <div className="flyout">
      <div className="flyout-head">
        <h3>Notificaciones</h3>
        <button
          className="btn small"
          onClick={() => {
            getState().notifications = getState().notifications.filter((n) => n.level === 'progress');
            changed();
          }}
        >
          Descartar todo
        </button>
        <button className="close-x" onClick={() => setUi({ notificationsOpen: false })}>
          <Icon name="close" />
        </button>
      </div>
      <div className="flyout-body">
        {!s.notifications.length ? <div className="empty">No hay notificaciones nuevas.</div> : null}
        {s.notifications.slice(0, 60).map((n) => (
          <div key={n.id} className={`notif${n.read ? '' : ' unread'}`}>
            {icon(n.level)}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="t">{n.title}</div>
              <div className="m">{n.message}</div>
              <div className="time">
                {relTime(n.time)}
                {n.link ? (
                  <>
                    {' · '}
                    <a
                      onClick={() => {
                        setUi({ notificationsOpen: false });
                        navigate(n.link!.startsWith('#') ? n.link! : n.link!);
                      }}
                    >
                      Ir al recurso
                    </a>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- configuración

export function SettingsFlyout() {
  const s = useCloud();
  const u = useUi();
  const fileRef = useRef<HTMLInputElement>(null);
  if (!u.settingsOpen) return null;
  const set = (patch: Partial<typeof s.settings>) => {
    Object.assign(getState().settings, patch);
    changed();
  };
  const exportState = () => {
    flushSave();
    const blob = new Blob([JSON.stringify({ cloud: getState(), academy: readKey('azlab:academy:v1') }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `azure-lab-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  return (
    <div className="flyout">
      <div className="flyout-head">
        <h3>Configuración del simulador</h3>
        <button className="close-x" onClick={() => setUi({ settingsOpen: false })}>
          <Icon name="close" />
        </button>
      </div>
      <div className="flyout-body" style={{ padding: '8px 18px 24px' }}>
        <div className="section-title">Apariencia</div>
        <Radio
          value={s.settings.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'light', label: 'Claro' },
            { value: 'dark', label: 'Oscuro' },
          ]}
        />
        <div className="section-title">Velocidad de aprovisionamiento</div>
        <Radio
          value={s.settings.speed}
          onChange={(v) => set({ speed: v })}
          options={[
            { value: 'instant', label: 'Instantánea', help: 'Los recursos se crean al momento.' },
            { value: 'fast', label: 'Rápida (recomendada)', help: 'Unos segundos, para ver los estados intermedios.' },
            { value: 'realistic', label: 'Realista', help: 'Tiempos más parecidos a Azure (una VM tarda más que un grupo de recursos).' },
          ]}
        />
        <div className="section-title">Academia</div>
        <Checkbox checked={s.settings.freeMode} onChange={(v) => set({ freeMode: v })} label="Modo libre: desbloquear todos los niveles" />
        <div className="help muted small" style={{ marginBottom: 10 }}>
          Por defecto, cada nivel se desbloquea al completar los ejercicios del anterior.
        </div>
        <button
          className="btn"
          onClick={async () => {
            if (await confirmDialog({ title: 'Reiniciar el progreso de la Academia', message: 'Se borrarán tu XP, los ejercicios completados y las respuestas de los cuestionarios. La nube simulada no cambia.', confirmText: 'Reiniciar progreso', danger: true })) resetAcademy();
          }}
        >
          Reiniciar progreso de la Academia
        </button>
        <div className="section-title">Datos</div>
        <p className="muted small">
          {isRemote() ? (
            <>
              Tu nube y tu progreso se guardan en el servidor del contenedor (volumen <span className="mono">/data</span>): los verás desde cualquier navegador que abra esta dirección. Puedes exportar una copia de seguridad.
            </>
          ) : (
            'Todo se guarda en el almacenamiento local de este navegador. Puedes exportar una copia de seguridad.'
          )}
        </p>
        <div className="btn-row">
          <button className="btn" onClick={exportState}>
            <Icon name="download" /> Exportar
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> Importar
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                if (!data.cloud?.schema) throw new Error('Formato no válido');
                replaceState(data.cloud);
                if (data.academy) replaceProgress(data.academy);
                flushSave();
                await flushRemote();
                location.reload();
              } catch (err: any) {
                alert('No se pudo importar: ' + (err?.message ?? err));
              }
            }}
          />
        </div>
        <div className="section-title" style={{ color: 'var(--danger)' }}>
          Zona de peligro
        </div>
        <p className="muted small">Restablecer la nube elimina todos los recursos, usuarios, proyectos de DevOps y ficheros de Cloud Shell, y vuelve al estado inicial. El progreso de la Academia se conserva.</p>
        <button
          className="btn danger"
          onClick={async () => {
            if (await confirmDialog({ title: 'Restablecer la nube simulada', message: 'Se borrará todo el contenido de tu nube simulada.', confirmText: 'Restablecer', danger: true, requireText: 'RESTABLECER' })) {
              resetCloud();
              setUi({ settingsOpen: false });
              navigate('/');
              await flushRemote();
              location.reload();
            }
          }}
        >
          Restablecer la nube
        </button>
      </div>
    </div>
  );
}

export function AccountMenu() {
  const s = useCloud();
  const u = useUi();
  if (!u.accountOpen) return null;
  return (
    <div className="menu" style={{ position: 'fixed', top: 40, right: 0, width: 320, padding: 16 }} onMouseLeave={() => setUi({ accountOpen: false })}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="avatar" style={{ width: 48, height: 48, fontSize: 18 }}>
          {initials(s.me.displayName)}
        </span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{s.me.displayName}</div>
          <div className="muted small">{s.me.upn}</div>
          <div className="muted small">Directorio: {s.tenant.displayName}</div>
        </div>
      </div>
      <button onClick={() => (setUi({ accountOpen: false }), navigate('/entra'))}>Ver cuenta en Microsoft Entra ID</button>
      <button onClick={() => (setUi({ accountOpen: false }), navigate('/subscriptions'))}>Mis suscripciones</button>
      <button onClick={() => (setUi({ accountOpen: false }), navigate('/academy'))}>Mi progreso en la Academia</button>
    </div>
  );
}

// ---------------------------------------------------------------- avisos y panel de contexto

export function Toasts() {
  const u = useUi();
  return (
    <div className="toasts">
      {u.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <Icon name={t.level === 'success' ? 'success' : t.level === 'error' ? 'error' : t.level === 'warning' ? 'warn' : 'info'} style={{ color: t.level === 'success' ? 'var(--success)' : t.level === 'error' ? 'var(--danger-icon)' : t.level === 'warning' ? 'var(--warning-icon)' : 'var(--accent)', marginTop: 2 }} />
          <div style={{ minWidth: 0 }}>
            <div className="t">{t.title}</div>
            {t.message ? <div className="m">{t.message}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PaneHost() {
  const u = useUi();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && getUiPane()) closePane();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  if (!u.pane) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closePane()}>
      <div className="pane" style={u.pane.width ? { width: u.pane.width } : undefined}>
        <div className="pane-head">
          <div style={{ flex: 1 }}>
            <h2>{u.pane.title}</h2>
            {u.pane.subtitle ? <div className="muted small">{u.pane.subtitle}</div> : null}
          </div>
          <button className="close-x" onClick={closePane}>
            <Icon name="close" />
          </button>
        </div>
        {u.pane.render()}
      </div>
    </div>
  );
}

function getUiPane() {
  return document.querySelector('.pane');
}

export function serviceIconForType(type: string) {
  return getProvider(type)?.icon ?? serviceForType(type)?.icon ?? 'all';
}
