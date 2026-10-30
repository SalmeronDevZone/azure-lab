// Aplicación raíz: enrutado por hash entre el portal, Azure DevOps y la Academia.
import { useEffect, useState } from 'react';
import { useCloud, useRoute, navigate } from './hooks';
import { setUi } from './uiStore';
import { TopBar, SideNav, NotificationsFlyout, SettingsFlyout, AccountMenu, Toasts, PaneHost } from './portal/Chrome';
import { Home, AllServices, AllResources, BrowseType, ResourceGroups, Subscriptions } from './portal/Pages';
import { ResourceRoute } from './portal/ResourceBlade';
import { CreateWizard } from './portal/Create';
import { EntraPage } from './portal/Entra';
import { MonitorPage, CostPage, AdvisorPage, PolicyPage, MailPage } from './portal/Ops';
import { GraphExplorerPage } from './portal/Graph';
import { DevOpsApp } from './devops/DevOpsApp';
import { AcademyRoute, LabPanel } from './academy/Academy';
import { CloudShell } from './terminal/CloudShell';
import { Editor, Browser } from './components/Overlays';
import { ConfirmHost, Field, TextInput, Radio } from './components/common';
import { ServiceIcon } from './components/Icons';
import { renameUser, getState, changed } from '../engine/store';

function Onboarding() {
  const s = useCloud();
  const [name, setName] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(s.settings.theme);
  const start = () => {
    const n = name.trim() || 'Estudiante';
    renameUser(n);
    getState().settings.theme = theme;
    changed();
    navigate('/academy');
  };
  return (
    <div className="onboarding">
      <div className="box">
        <div className="row" style={{ gap: 10 }}>
          <ServiceIcon name="academy" size={36} />
          <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>Azure Lab</span>
        </div>
        <h1>Tu Azure privado para aprender DevOps</h1>
        <p className="muted">
          Un simulador local de Azure con portal, Cloud Shell (Bash + Azure CLI, kubectl, Terraform, Git, Docker), Azure DevOps y una academia de 13 niveles con laboratorios que se validan solos. Todo se guarda en tu navegador: sin cuentas, sin costes, sin riesgos.
        </p>
        <Field stack label="¿Cómo te llamas?" help="Con tu nombre se crean tu usuario y tu inquilino (directorio) de Microsoft Entra ID simulados.">
          <TextInput value={name} onChange={setName} placeholder="Ana García" autoFocus onEnter={start} />
        </Field>
        <Field stack label="Tema">
          <Radio
            value={theme}
            onChange={(v) => {
              setTheme(v);
              document.documentElement.dataset.theme = v;
            }}
            options={[
              { value: 'light', label: 'Claro' },
              { value: 'dark', label: 'Oscuro' },
            ]}
          />
        </Field>
        <button className="btn primary" style={{ width: '100%', height: 40, marginTop: 8 }} onClick={start}>
          Empezar
        </button>
      </div>
    </div>
  );
}

function PortalPage() {
  const route = useRoute();
  const p = route.parts;
  switch (p[0]) {
    case undefined:
      return <Home />;
    case 'services':
      return <AllServices />;
    case 'resources':
      return <AllResources />;
    case 'groups':
      return <ResourceGroups />;
    case 'subscriptions':
      return <Subscriptions />;
    case 'browse':
      return <BrowseType type={p[1] ?? ''} />;
    case 'resource':
      return <ResourceRoute id={p[1] ?? ''} section={p[2] ?? 'overview'} />;
    case 'create':
      return <CreateWizard key={p[1] + route.query.toString()} id={p[1] ?? ''} />;
    case 'entra':
      return <EntraPage section={p[1] ?? 'overview'} />;
    case 'monitor':
      return <MonitorPage section={p[1] ?? 'overview'} />;
    case 'cost':
      return <CostPage section={p[1] ?? 'overview'} />;
    case 'advisor':
      return <AdvisorPage />;
    case 'policy':
      return <PolicyPage section={p[1] ?? 'overview'} />;
    case 'graph':
      return <GraphExplorerPage />;
    case 'mail':
      return <MailPage />;
    case 'academy':
      return <AcademyRoute />;
    default:
      return <Home />;
  }
}

export function App() {
  const s = useCloud();
  const route = useRoute();
  useEffect(() => {
    document.documentElement.dataset.theme = s.settings.theme;
  }, [s.settings.theme]);
  useEffect(() => {
    let g = false;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'g' || e.key === 'G') {
        g = true;
        setTimeout(() => (g = false), 800);
        return;
      }
      if (g && e.key === '/') {
        e.preventDefault();
        (document.querySelector('.topbar-search input') as HTMLInputElement | null)?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => {
    setUi({ pane: null, notificationsOpen: false, settingsOpen: false, accountOpen: false });
    document.querySelector('.app-content')?.scrollTo(0, 0);
  }, [route.path]);
  if (!s.settings.onboarded) return <Onboarding />;
  const devops = route.parts[0] === 'devops';
  return (
    <div className="app">
      {!devops ? <TopBar /> : null}
      <div className="app-main">
        {!devops ? <SideNav /> : null}
        <main className="app-content">{devops ? <DevOpsApp /> : <PortalPage />}</main>
      </div>
      <CloudShell />
      <NotificationsFlyout />
      <SettingsFlyout />
      <AccountMenu />
      <PaneHost />
      <ConfirmHost />
      <Editor />
      <Browser />
      <LabPanel />
      <Toasts />
    </div>
  );
}
