// Monitor, Cost Management, Advisor, Directiva (Policy) y el correo simulado.
import { useState } from 'react';
import { useCloud, useTick, resourceHref, rgHref, navigate } from '../hooks';
import { openPane, closePane } from '../uiStore';
import { BladeLayout, ActivitySection, Crumbs, type MenuItem } from './blade';
import { Callout, CliBox, CommandBar, DataTable, Field, Select, TextInput, Checkbox, confirmDialog, useAsync, Empty } from '../components/common';
import { LineChart, Bars } from '../components/charts';
import { ServiceIcon } from '../components/Icons';
import { portalAction, cliText } from '../portalCli';
import { KqlEditor } from './types/monitor';
import { metricSeries, metricsFor } from '../../engine/services/monitor';
import { LOG_CATEGORIES } from '../../engine/services/diagnostics';
import { advisorRecommendations, costByGroup, forecastMonthly, totalCost } from '../../engine/services/cost';
import { complianceReport } from '../../engine/services/governance';
import { POLICY_DEFINITIONS, LOCATIONS } from '../../engine/catalog';
import { getProvider, providerLabel } from '../../engine/registry';
import { changed, getState } from '../../engine/store';
import { formatDate, formatMoney, relTime } from '../../engine/util';

// ---------------------------------------------------------------- Monitor

function MetricsExplorer() {
  const s = useCloud();
  useTick(5000);
  const candidates = s.resources.filter((r) => metricsFor(r.type).length);
  const [rid, setRid] = useState(candidates[0]?.id ?? '');
  const r = candidates.find((x) => x.id === rid);
  const defs = r ? metricsFor(r.type) : [];
  const [metric, setMetric] = useState('');
  const def = defs.find((d) => d.name === metric) ?? defs[0];
  if (!candidates.length) return <Empty title="No hay recursos con métricas">Crea una VM, una App Service o una cuenta de almacenamiento para ver sus métricas.</Empty>;
  return (
    <>
      <div className="list-toolbar">
        <div style={{ width: 320 }}>
          <Select value={rid} onChange={(v) => { setRid(v); setMetric(''); }} options={candidates.map((x) => ({ value: x.id, label: `${x.name} (${providerLabel(x.type)})` }))} />
        </div>
        <div style={{ width: 280 }}>
          <Select value={def?.name ?? ''} onChange={setMetric} options={defs.map((d) => ({ value: d.name, label: `${d.label} · ${d.aggregation}` }))} />
        </div>
      </div>
      {r && def ? (
        <div className="card">
          <h3>
            {def.label} de {r.name}
          </h3>
          <LineChart points={metricSeries(r, def.name, 60, 60000)} unit={def.unit} />
        </div>
      ) : null}
      <Callout>Las métricas son valores numéricos que se recogen a intervalos regulares (sin coste ni configuración). Para registros detallados necesitas configuración de diagnóstico y un área de trabajo de Log Analytics.</Callout>
    </>
  );
}

function NewAlertRule() {
  const s = useCloud();
  const candidates = s.resources.filter((r) => metricsFor(r.type).length);
  const groups = s.resources.filter((r) => r.type === 'Microsoft.Insights/actionGroups');
  const [rid, setRid] = useState(candidates[0]?.id ?? '');
  const r = candidates.find((x) => x.id === rid);
  const defs = r ? metricsFor(r.type) : [];
  const [metric, setMetric] = useState(defs[0]?.name ?? '');
  const [agg, setAgg] = useState('avg');
  const [op, setOp] = useState('>');
  const [threshold, setThreshold] = useState('80');
  const [name, setName] = useState('alerta-cpu-alta');
  const [sev, setSev] = useState('2');
  const [ag, setAg] = useState(groups[0]?.id ?? '');
  const { busy, run } = useAsync();
  const m = defs.find((d) => d.name === metric) ?? defs[0];
  const args = r ? ['monitor', 'metrics', 'alert', 'create', '-g', r.resourceGroup, '-n', name, '--scopes', r.id, '--condition', `${agg} ${m?.name} ${op} ${threshold}`, '--window-size', '5m', '--evaluation-frequency', '1m', '--severity', sev, ...(ag ? ['--action', ag] : [])] : [];
  return (
    <>
      <div className="pane-body">
        <Field label="Recurso" required>
          <Select value={rid} onChange={(v) => { setRid(v); setMetric(''); }} options={candidates.map((x) => ({ value: x.id, label: `${x.name} (${providerLabel(x.type)})` }))} />
        </Field>
        <Field label="Señal (métrica)" required>
          <Select value={m?.name ?? ''} onChange={setMetric} options={defs.map((d) => ({ value: d.name, label: d.label }))} />
        </Field>
        <div className="row" style={{ gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Field label="Agregación">
              <Select value={agg} onChange={setAgg} options={[{ value: 'avg', label: 'Promedio' }, { value: 'max', label: 'Máximo' }, { value: 'min', label: 'Mínimo' }, { value: 'total', label: 'Total' }, { value: 'count', label: 'Recuento' }]} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Operador">
              <Select value={op} onChange={setOp} options={['>', '>=', '<', '<=']} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Umbral">
              <TextInput value={threshold} onChange={setThreshold} />
            </Field>
          </div>
        </div>
        <Field label="Grupo de acciones" help="Qué hacer cuando se active (enviar correo, webhook...).">
          <Select value={ag} onChange={setAg} options={[{ value: '', label: 'Ninguno' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
        </Field>
        <Field label="Gravedad">
          <Select value={sev} onChange={setSev} options={[{ value: '0', label: '0 - Crítica' }, { value: '1', label: '1 - Error' }, { value: '2', label: '2 - Advertencia' }, { value: '3', label: '3 - Informativa' }, { value: '4', label: '4 - Detallada' }]} />
        </Field>
        <Field label="Nombre de la regla" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        {r ? <CliBox cmd={cliText(args)} /> : null}
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !r || !name} onClick={() => run(async () => (await portalAction('Crear regla de alertas', args, { subscription: r!.subscriptionId, success: `Regla ${name} creada` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function NewActionGroup() {
  const s = useCloud();
  const [rg, setRg] = useState(s.resourceGroups[0]?.name ?? '');
  const [name, setName] = useState('ag-operaciones');
  const [email, setEmail] = useState(s.me.upn);
  const { busy, run } = useAsync();
  const g = s.resourceGroups.find((x) => x.name === rg);
  const args = ['monitor', 'action-group', 'create', '-g', rg, '-n', name, '--short-name', name.slice(0, 12), '--action', 'email', 'admin', email];
  return (
    <>
      <div className="pane-body">
        <Field label="Grupo de recursos" required>
          <Select value={rg} onChange={setRg} options={s.resourceGroups.map((x) => x.name)} />
        </Field>
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Correo electrónico" help="Los correos llegan a la bandeja simulada (icono de sobre en la barra superior).">
          <TextInput value={email} onChange={setEmail} />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !rg || !name} onClick={() => run(async () => (await portalAction('Crear grupo de acciones', args, { subscription: g?.subscriptionId, success: `Grupo de acciones ${name} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function Alerts() {
  const s = useCloud();
  useTick(3000);
  const rules = s.resources.filter((r) => r.type === 'Microsoft.Insights/metricAlerts');
  const groups = s.resources.filter((r) => r.type === 'Microsoft.Insights/actionGroups');
  const fired = s.alerts.filter((a) => a.state === 'Fired');
  return (
    <>
      <CommandBar
        items={[
          { label: 'Crear regla de alertas', icon: 'add', onClick: () => openPane({ title: 'Crear una regla de alertas', render: () => <NewAlertRule /> }) },
          { label: 'Grupo de acciones', icon: 'add', onClick: () => openPane({ title: 'Crear un grupo de acciones', render: () => <NewActionGroup /> }) },
        ]}
      />
      <div className="grid3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="muted small">Alertas activas</div>
          <div style={{ fontSize: 28, fontWeight: 600, color: fired.length ? 'var(--danger)' : undefined }}>{fired.length}</div>
        </div>
        <div className="card">
          <div className="muted small">Reglas de alertas</div>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{rules.length}</div>
        </div>
        <div className="card">
          <div className="muted small">Grupos de acciones</div>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{groups.length}</div>
        </div>
      </div>
      <h3 className="section-title">Alertas</h3>
      <DataTable
        rows={s.alerts.slice().reverse()}
        rowKey={(a) => a.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (a) => <b>{a.ruleName}</b> },
          { key: 'sev', title: 'Gravedad', render: (a) => `Sev${a.severity}` },
          { key: 's', title: 'Estado', render: (a) => <span className={`pill ${a.state === 'Fired' ? 'bad' : 'ok'}`}>{a.state === 'Fired' ? 'Activada' : 'Resuelta'}</span> },
          { key: 'c', title: 'Condición', render: (a) => <span className="small">{a.condition}</span> },
          { key: 'r', title: 'Recurso', render: (a) => <a href={resourceHref(a.targetResource)}>{a.targetResource.split('/').pop()}</a> },
          { key: 't', title: 'Hora de activación', render: (a) => relTime(a.firedAt) },
        ]}
        empty="No se ha activado ninguna alerta. Prueba a crear una regla de CPU > 80 y genera carga con stress en una VM."
      />
      <h3 className="section-title">Reglas de alertas</h3>
      <DataTable
        rows={rules}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (r) => <a href={resourceHref(r.id)}>{r.name}</a> },
          { key: 'c', title: 'Condición', render: (r) => { const c = r.properties.criteria?.allOf?.[0]; return c ? `${c.timeAggregation} ${c.metricName} ${c.operator} ${c.threshold}` : ''; } },
          { key: 't', title: 'Destino', render: (r) => String(r.properties.scopes?.[0] ?? '').split('/').pop() },
          { key: 'e', title: 'Estado', render: (r) => (r.properties.enabled ? 'Habilitada' : 'Deshabilitada') },
        ]}
        empty="No hay reglas de alertas."
      />
    </>
  );
}

function Logs() {
  const s = useCloud();
  const ws = s.resources.filter((r) => r.type === 'Microsoft.OperationalInsights/workspaces');
  const [id, setId] = useState(ws[0]?.id ?? '');
  const cur = ws.find((w) => w.id === id) ?? ws[0];
  if (!cur)
    return (
      <Empty title="No tienes ningún área de trabajo de Log Analytics">
        <p>Los registros se consultan con KQL dentro de un área de trabajo.</p>
        <button className="btn primary" onClick={() => navigate('/create/law')}>
          Crear área de trabajo
        </button>
      </Empty>
    );
  return (
    <>
      <div style={{ width: 320, marginBottom: 12 }}>
        <Select value={cur.id} onChange={setId} options={ws.map((w) => ({ value: w.id, label: `Ámbito: ${w.name}` }))} />
      </div>
      <KqlEditor ws={cur} />
    </>
  );
}

function NewDiagnostic({ resourceId }: { resourceId: string }) {
  const s = useCloud();
  const r = s.resources.find((x) => x.id === resourceId)!;
  const cats = LOG_CATEGORIES[r.type.toLowerCase()] ?? [];
  const ws = s.resources.filter((x) => x.type === 'Microsoft.OperationalInsights/workspaces');
  const [name, setName] = useState(`diag-${r.name}`.slice(0, 60));
  const [sel, setSel] = useState<string[]>(cats);
  const [metrics, setMetrics] = useState(true);
  const [w, setW] = useState(ws[0]?.id ?? '');
  const { busy, run } = useAsync();
  const args = ['monitor', 'diagnostic-settings', 'create', '-n', name, '--resource', r.id, '--workspace', w, '--logs', JSON.stringify(sel.map((c) => ({ category: c, enabled: true }))), ...(metrics ? ['--metrics', JSON.stringify([{ category: 'AllMetrics', enabled: true }])] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Registros">
          {cats.map((c) => (
            <Checkbox key={c} checked={sel.includes(c)} onChange={(v) => setSel(v ? [...sel, c] : sel.filter((x) => x !== c))} label={c} />
          ))}
          <Checkbox checked={metrics} onChange={setMetrics} label="AllMetrics" />
        </Field>
        <Field label="Enviar al área de trabajo de Log Analytics" required>
          <Select value={w} onChange={setW} options={[{ value: '', label: 'Selecciona...' }, ...ws.map((x) => ({ value: x.id, label: x.name }))]} />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !w || !name} onClick={() => run(async () => (await portalAction('Crear configuración de diagnóstico', args, { subscription: r.subscriptionId, success: 'Configuración de diagnóstico guardada' })) && closePane())}>
          Guardar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function Diagnostics() {
  const s = useCloud();
  const list = s.resources.filter((r) => LOG_CATEGORIES[r.type.toLowerCase()]);
  return (
    <>
      <Callout>La configuración de diagnóstico envía los registros de un recurso (peticiones HTTP, auditoría de Key Vault...) a Log Analytics para consultarlos con KQL y crear alertas.</Callout>
      <DataTable
        rows={list}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', title: 'Recurso', render: (r) => <a href={resourceHref(r.id)}>{r.name}</a> },
          { key: 't', title: 'Tipo', render: (r) => providerLabel(r.type) },
          { key: 'g', title: 'Grupo de recursos', render: (r) => r.resourceGroup },
          { key: 'd', title: 'Diagnóstico', render: (r) => { const d = s.diagnosticSettings.filter((x) => x.resourceUri.toLowerCase() === r.id.toLowerCase()); return d.length ? <span className="pill ok">Habilitado ({d.map((x) => x.name).join(', ')})</span> : <span className="pill">Deshabilitado</span>; } },
          { key: 'x', title: '', render: (r) => <button className="btn small" onClick={() => openPane({ title: 'Configuración de diagnóstico', subtitle: r.name, render: () => <NewDiagnostic resourceId={r.id} /> })}>Agregar configuración</button> },
        ]}
        empty="No hay recursos que admitan registros de diagnóstico."
      />
    </>
  );
}

function MonitorOverview() {
  const s = useCloud();
  return (
    <>
      <p>Azure Monitor recoge y analiza la telemetría de tus recursos: <b>métricas</b> (números a intervalos), <b>registros</b> (eventos consultables con KQL) y <b>alertas</b> que te avisan cuando algo va mal.</p>
      <div className="grid3">
        {[
          ['metrics', 'Métricas', 'chart', 'Gráficos de CPU, peticiones, latencia...'],
          ['alerts', 'Alertas', 'alert', `${s.alerts.filter((a) => a.state === 'Fired').length} activas`],
          ['logs', 'Registros', 'loganalytics', 'Consultas KQL sobre Log Analytics'],
          ['activity', 'Registro de actividad', 'monitor', 'Operaciones de administración'],
          ['diagnostics', 'Configuración de diagnóstico', 'policy', 'Enviar registros a Log Analytics'],
        ].map(([id, label, icon, desc]) => (
          <a key={id} className="card" href={`#/monitor/${id}`} style={{ display: 'flex', gap: 12, color: 'var(--text)', textDecoration: 'none' }}>
            <ServiceIcon name={icon} size={30} />
            <div>
              <b>{label}</b>
              <div className="muted small">{desc}</div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

export function MonitorPage({ section }: { section: string }) {
  const s = useCloud();
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Información general', icon: 'overview' },
    { id: 'activity', label: 'Registro de actividad', icon: 'activity' },
    { id: 'alerts', label: 'Alertas', icon: 'warn' },
    { id: 'metrics', label: 'Métricas', icon: 'chart' },
    { id: 'logs', label: 'Registros', icon: 'code' },
    { id: 'diagnostics', label: 'Configuración de diagnóstico', icon: 'settings2', group: 'Configuración' },
  ];
  const body =
    section === 'activity' ? <ActivitySection scope={`/subscriptions/${s.currentSubscriptionId}`} /> : section === 'alerts' ? <Alerts /> : section === 'metrics' ? <MetricsExplorer /> : section === 'logs' ? <Logs /> : section === 'diagnostics' ? <Diagnostics /> : <MonitorOverview />;
  return (
    <BladeLayout crumbs={[{ label: 'Inicio', href: '#/' }, { label: 'Monitor' }]} icon="monitor" title="Monitor" subtitle="Supervisión de Azure" menu={menu} active={section || 'overview'} hrefFor={(id) => `#/monitor${id === 'overview' ? '' : '/' + id}`}>
      {body}
    </BladeLayout>
  );
}

// ---------------------------------------------------------------- Cost Management

function NewBudget() {
  const s = useCloud();
  const [name, setName] = useState('presupuesto-lab');
  const [amount, setAmount] = useState('20');
  const [email, setEmail] = useState(s.me.upn);
  const { busy, run } = useAsync();
  const start = new Date();
  const args = ['consumption', 'budget', 'create', '-n', name, '--amount', amount, '--category', 'cost', '--time-grain', 'monthly', '--start-date', `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`, '--end-date', `${start.getFullYear() + 1}-12-31`, '--thresholds', '50', '80', '100', '--contact-emails', email];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Importe (USD/mes)" required>
          <TextInput value={amount} onChange={setAmount} />
        </Field>
        <Field label="Correo para las alertas">
          <TextInput value={email} onChange={setEmail} />
        </Field>
        <Callout>Recibirás un correo al alcanzar el 50 %, 80 % y 100 % del presupuesto. Un presupuesto <b>no detiene</b> los recursos: sólo avisa.</Callout>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name || !Number(amount)} onClick={() => run(async () => (await portalAction('Crear presupuesto', args, { success: `Presupuesto ${name} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

export function CostPage({ section }: { section: string }) {
  const s = useCloud();
  useTick(5000);
  const [by, setBy] = useState<'resourceGroup' | 'type' | 'name'>('resourceGroup');
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Análisis de costes', icon: 'chart' },
    { id: 'budgets', label: 'Presupuestos', icon: 'cost' },
  ];
  const groups = costByGroup(s, by, s.currentSubscriptionId);
  const rows = groups.map((g) => ({ label: g.key, value: g.amount, href: by === 'resourceGroup' ? rgHref(s.currentSubscriptionId, g.key) : undefined })).slice(0, 15);
  const body =
    section === 'budgets' ? (
      <>
        <CommandBar items={[{ label: 'Agregar', icon: 'add', onClick: () => openPane({ title: 'Crear presupuesto', render: () => <NewBudget /> }) }]} />
        <DataTable
          rows={s.budgets}
          rowKey={(b) => b.id}
          columns={[
            { key: 'n', title: 'Nombre', render: (b) => <b>{b.name}</b> },
            { key: 'a', title: 'Importe', render: (b) => formatMoney(b.amount) },
            { key: 'c', title: 'Gasto actual', render: () => formatMoney(totalCost(s, s.currentSubscriptionId)) },
            { key: 'p', title: 'Progreso', render: (b) => { const pct = Math.min(100, (totalCost(s, s.currentSubscriptionId) / b.amount) * 100); return <div style={{ width: 160 }}><div className="progress"><div style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--danger-icon)' : pct >= 80 ? 'var(--warning-icon)' : undefined }} /></div><span className="small muted">{pct.toFixed(0)} %</span></div>; } },
            { key: 't', title: 'Umbrales', render: (b) => b.thresholds.map((t) => `${t}%`).join(', ') },
          ]}
          empty="No hay presupuestos. Crea uno para recibir avisos de gasto."
        />
      </>
    ) : (
      <>
        <div className="grid3" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="muted small">Coste acumulado (suscripción actual)</div>
            <div style={{ fontSize: 26, fontWeight: 600 }}>{formatMoney(totalCost(s, s.currentSubscriptionId))}</div>
          </div>
          <div className="card">
            <div className="muted small">Previsión mensual de los recursos actuales</div>
            <div style={{ fontSize: 26, fontWeight: 600 }}>{formatMoney(forecastMonthly(s, s.currentSubscriptionId))}</div>
          </div>
          <div className="card">
            <div className="muted small">Presupuestos</div>
            <div style={{ fontSize: 26, fontWeight: 600 }}>{s.budgets.length}</div>
          </div>
        </div>
        <div className="list-toolbar">
          <span>Agrupar por</span>
          <div style={{ width: 220 }}>
            <Select value={by} onChange={(v) => setBy(v as any)} options={[{ value: 'resourceGroup', label: 'Grupo de recursos' }, { value: 'type', label: 'Tipo de servicio' }, { value: 'name', label: 'Recurso' }]} />
          </div>
        </div>
        <div className="card">
          <Bars rows={rows} />
        </div>
        <Callout>
          Simulación de facturación: 1 minuto real = 1 hora de uso. Las VM detenidas (desasignadas) sólo pagan el disco; App Service paga el plan aunque la app esté parada; los recursos eliminados dejan de costar.
        </Callout>
      </>
    );
  return (
    <BladeLayout crumbs={[{ label: 'Inicio', href: '#/' }, { label: 'Cost Management' }]} icon="cost" title="Cost Management" subtitle={s.subscriptions.find((x) => x.id === s.currentSubscriptionId)?.displayName ?? ''} menu={menu} active={section || 'overview'} hrefFor={(id) => `#/cost${id === 'overview' ? '' : '/' + id}`}>
      {body}
    </BladeLayout>
  );
}

// ---------------------------------------------------------------- Advisor

export function AdvisorPage() {
  const s = useCloud();
  const recs = advisorRecommendations(s);
  const cats = ['Coste', 'Seguridad', 'Confiabilidad', 'Excelencia operativa', 'Rendimiento'] as const;
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Advisor' }]} />
      <div className="page-head">
        <ServiceIcon name="advisor" size={34} />
        <div>
          <h1>Advisor</h1>
          <div className="subtitle">Recomendaciones personalizadas según tus recursos (Well-Architected Framework)</div>
        </div>
      </div>
      <div className="grid3" style={{ marginBottom: 16, gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
        {cats.map((c) => (
          <div key={c} className="card">
            <div className="muted small">{c}</div>
            <div style={{ fontSize: 24, fontWeight: 600 }}>{recs.filter((r) => r.category === c).length}</div>
          </div>
        ))}
      </div>
      <DataTable
        rows={recs}
        rowKey={(r) => r.id}
        columns={[
          { key: 'i', title: 'Impacto', render: (r) => <span className={`pill ${r.impact === 'Alto' ? 'bad' : r.impact === 'Medio' ? 'warn' : ''}`}>{r.impact}</span> },
          { key: 'c', title: 'Categoría', render: (r) => r.category },
          { key: 't', title: 'Recomendación', render: (r) => <div><b>{r.title}</b><div className="muted small">{r.detail}</div></div> },
          { key: 'r', title: 'Recurso', render: (r) => <a href={resourceHref(r.resource.id)}>{r.resource.name}</a> },
          { key: 'f', title: 'Cómo solucionarlo', render: (r) => <span className="mono small">{r.fix}</span> },
          { key: 's', title: 'Ahorro/mes', render: (r) => (r.savings ? formatMoney(r.savings) : '') },
        ]}
        empty="¡Todo en orden! No hay recomendaciones para tus recursos actuales."
      />
    </div>
  );
}

// ---------------------------------------------------------------- Directiva (Policy)

function AssignPolicy() {
  const s = useCloud();
  const [def, setDef] = useState(POLICY_DEFINITIONS[0].name);
  const [scopeKind, setScopeKind] = useState('rg');
  const [rg, setRg] = useState(s.resourceGroups.find((g) => g.subscriptionId === s.currentSubscriptionId)?.name ?? '');
  const [param, setParam] = useState('');
  const [mode, setMode] = useState('Default');
  const [name, setName] = useState('');
  const { busy, run } = useAsync();
  const d = POLICY_DEFINITIONS.find((x) => x.name === def)!;
  const pkey = Object.keys(d.parameters ?? {})[0];
  const ptype = pkey ? d.parameters[pkey].type : null;
  const scope = scopeKind === 'sub' ? `/subscriptions/${s.currentSubscriptionId}` : `/subscriptions/${s.currentSubscriptionId}/resourceGroups/${rg}`;
  const pval = ptype === 'Array' ? param.split(',').map((x) => x.trim()).filter(Boolean) : param;
  const args = ['policy', 'assignment', 'create', '-n', name || d.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60), '--display-name', d.displayName, '--policy', d.name, '--scope', scope, '--enforcement-mode', mode, ...(pkey ? ['--params', JSON.stringify({ [pkey]: { value: pval } })] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Definición de directiva" required>
          <Select value={def} onChange={setDef} options={POLICY_DEFINITIONS.map((x) => ({ value: x.name, label: `${x.displayName} (${x.effect})` }))} />
        </Field>
        <p className="muted small">{d.description}</p>
        <Field label="Ámbito">
          <Select value={scopeKind} onChange={setScopeKind} options={[{ value: 'rg', label: 'Grupo de recursos' }, { value: 'sub', label: 'Suscripción completa' }]} />
        </Field>
        {scopeKind === 'rg' ? (
          <Field label="Grupo de recursos">
            <Select value={rg} onChange={setRg} options={s.resourceGroups.filter((g) => g.subscriptionId === s.currentSubscriptionId).map((g) => g.name)} />
          </Field>
        ) : null}
        {pkey ? (
          <Field label={d.parameters[pkey].displayName} required help={ptype === 'Array' ? `Separados por comas. Ej.: ${pkey.toLowerCase().includes('location') ? LOCATIONS.slice(0, 2).map((l) => l.name).join(', ') : 'Standard_B1s, Standard_B2s'}` : d.parameters[pkey].description}>
            <TextInput value={param} onChange={setParam} />
          </Field>
        ) : null}
        <Field label="Aplicación de directivas">
          <Select value={mode} onChange={setMode} options={[{ value: 'Default', label: 'Habilitado (aplica el efecto)' }, { value: 'DoNotEnforce', label: 'Deshabilitado (sólo evaluar)' }]} />
        </Field>
        <Field label="Nombre de la asignación">
          <TextInput value={name} onChange={setName} />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || (!!pkey && !param) || (scopeKind === 'rg' && !rg)} onClick={() => run(async () => (await portalAction('Asignar directiva', args, { success: `Directiva "${d.displayName}" asignada` })) && closePane())}>
          Asignar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

export function PolicyPage({ section }: { section: string }) {
  const s = useCloud();
  const report = complianceReport();
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Cumplimiento', icon: 'overview' },
    { id: 'assignments', label: 'Asignaciones', icon: 'policy' },
    { id: 'definitions', label: 'Definiciones', icon: 'book' },
  ];
  const nonCompliant = report.reduce((a, r) => a + r.nonCompliant.length, 0);
  let body;
  if (section === 'definitions')
    body = <DataTable rows={POLICY_DEFINITIONS} rowKey={(d) => d.name} columns={[{ key: 'n', title: 'Nombre', render: (d) => <b>{d.displayName}</b> }, { key: 'c', title: 'Categoría', render: (d) => d.category }, { key: 'e', title: 'Efecto', render: (d) => d.effect }, { key: 'd', title: 'Descripción', render: (d) => <span className="muted small">{d.description}</span> }]} />;
  else if (section === 'assignments')
    body = (
      <>
        <CommandBar items={[{ label: 'Asignar directiva', icon: 'add', onClick: () => openPane({ title: 'Asignar directiva', render: () => <AssignPolicy /> }) }]} />
        <DataTable
          rows={s.policyAssignments}
          rowKey={(a) => a.id}
          columns={[
            { key: 'n', title: 'Nombre', render: (a) => <b>{a.displayName}</b> },
            { key: 's', title: 'Ámbito', render: (a) => <span className="small">{a.scope.split('/').slice(-2).join('/')}</span> },
            { key: 'm', title: 'Aplicación', render: (a) => (a.enforcementMode === 'Default' ? 'Habilitada' : 'Deshabilitada') },
            { key: 'p', title: 'Parámetros', render: (a) => <span className="mono small">{JSON.stringify(Object.fromEntries(Object.entries(a.parameters).map(([k, v]) => [k, v.value])))}</span> },
            { key: 'x', title: '', render: (a) => <button className="btn small" onClick={async () => (await confirmDialog({ title: 'Eliminar asignación', message: `¿Eliminar ${a.displayName}?`, confirmText: 'Eliminar', danger: true })) && portalAction('Eliminar asignación', ['policy', 'assignment', 'delete', '-n', a.name, '--scope', a.scope], { success: 'Asignación eliminada' })}>Eliminar</button> },
          ]}
          empty="No hay directivas asignadas."
        />
      </>
    );
  else
    body = (
      <>
        <div className="grid3" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="muted small">Asignaciones</div>
            <div style={{ fontSize: 26, fontWeight: 600 }}>{report.length}</div>
          </div>
          <div className="card">
            <div className="muted small">Recursos no compatibles</div>
            <div style={{ fontSize: 26, fontWeight: 600, color: nonCompliant ? 'var(--danger)' : undefined }}>{nonCompliant}</div>
          </div>
          <div className="card">
            <div className="muted small">Estado</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{report.length ? (nonCompliant ? 'Con incumplimientos' : 'Compatible') : 'Sin directivas'}</div>
          </div>
        </div>
        <Callout>Azure Policy evalúa los recursos frente a reglas. Con efecto <b>Deny</b> impide crear recursos no conformes (error RequestDisallowedByPolicy); con <b>Audit</b> sólo los marca; con <b>Modify</b> los corrige (p. ej. añade etiquetas).</Callout>
        <DataTable
          rows={report}
          rowKey={(r) => r.assignment.id}
          columns={[
            { key: 'n', title: 'Asignación', render: (r) => <b>{r.assignment.displayName}</b> },
            { key: 'e', title: 'Efecto', render: (r) => r.def.effect },
            { key: 'c', title: 'Compatibles', render: (r) => r.compliant.length },
            { key: 'nc', title: 'No compatibles', render: (r) => (r.nonCompliant.length ? <span className="pill bad">{r.nonCompliant.length}</span> : 0) },
            { key: 'l', title: 'Recursos no compatibles', render: (r) => <span className="small">{r.nonCompliant.map((x) => x.split('/').pop()).join(', ')}</span> },
          ]}
          empty="Asigna una directiva para ver su cumplimiento."
        />
      </>
    );
  return (
    <BladeLayout crumbs={[{ label: 'Inicio', href: '#/' }, { label: 'Directiva' }]} icon="policy" title="Directiva" subtitle="Azure Policy" menu={menu} active={section || 'overview'} hrefFor={(id) => `#/policy${id === 'overview' ? '' : '/' + id}`}>
      {body}
    </BladeLayout>
  );
}

// ---------------------------------------------------------------- correo

export function MailPage() {
  const s = useCloud();
  const [sel, setSel] = useState<string | null>(s.emails[0]?.id ?? null);
  const cur = s.emails.find((m) => m.id === sel);
  if (cur && !cur.read) {
    cur.read = true;
    queueMicrotask(changed);
  }
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Correo' }]} />
      <div className="page-head">
        <ServiceIcon name="mail" size={34} />
        <div>
          <h1>Bandeja de entrada</h1>
          <div className="subtitle">{s.me.upn} · aquí llegan los correos de alertas, presupuestos y pipelines</div>
        </div>
        <span className="spacer" />
        <button
          className="btn"
          disabled={!s.emails.length}
          onClick={() => {
            getState().emails = [];
            changed();
          }}
        >
          Vaciar
        </button>
      </div>
      {!s.emails.length ? (
        <Empty icon={<ServiceIcon name="mail" size={64} />} title="No hay correos">
          Configura un grupo de acciones con tu correo en Monitor, un presupuesto en Cost Management o ejecuta un pipeline.
        </Empty>
      ) : (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div className="file-tree" style={{ width: 380, flex: '0 0 380px', maxHeight: '70vh', overflow: 'auto' }}>
            {s.emails.map((m) => (
              <div key={m.id} className="file-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, background: m.id === sel ? 'var(--selected)' : undefined }} onClick={() => setSel(m.id)}>
                <span style={{ fontWeight: m.read ? 400 : 700 }}>{m.subject}</span>
                <span className="muted small">{formatDate(m.time)}</span>
              </div>
            ))}
          </div>
          {cur ? (
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ fontSize: 16 }}>{cur.subject}</h3>
              <div className="muted small" style={{ marginBottom: 12 }}>
                De: Microsoft Azure &lt;azure-noreply@microsoft.com&gt; · Para: {cur.to} · {formatDate(cur.time)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{cur.body}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export const _ops = { getProvider };
