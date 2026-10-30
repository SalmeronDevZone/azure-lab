// Blades de supervisión: Log Analytics (editor KQL), Application Insights, alertas, grupos de acciones e identidades.
import { useMemo, useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, resourceHref } from '../../hooks';
import { Callout, DataTable } from '../../components/common';
import { runKql, formatKqlValue, KqlError, type KqlResult } from '../../../engine/services/kql';
import { workspaceTables, findTable, linkedResources } from '../../../engine/services/monitor';
import { getState } from '../../../engine/store';
import { relTime } from '../../../engine/util';
import { Icon } from '../../components/Icons';
import type { TypeBlade } from './shared';
import { MetricsSection, Props } from './shared';

const SAMPLES: { label: string; q: string }[] = [
  { label: 'Últimas operaciones del registro de actividad', q: 'AzureActivity\n| where TimeGenerated > ago(1d)\n| project TimeGenerated, OperationNameValue, ActivityStatusValue, Caller\n| order by TimeGenerated desc\n| take 20' },
  { label: 'Operaciones por usuario', q: 'AzureActivity\n| summarize Operaciones = count() by Caller\n| order by Operaciones desc' },
  { label: 'Errores HTTP de App Service', q: 'AppServiceHTTPLogs\n| where ScStatus >= 400\n| summarize count() by ScStatus, CsUriStem\n| order by count_ desc' },
  { label: 'CPU media por VM (Perf)', q: 'Perf\n| where CounterName == "% Processor Time"\n| summarize avg(CounterValue) by Computer, bin(TimeGenerated, 5m)\n| order by TimeGenerated desc' },
  { label: 'Latido de los agentes', q: 'Heartbeat\n| summarize LastHeartbeat = max(TimeGenerated) by Computer' },
  { label: 'Accesos a Key Vault', q: 'AzureDiagnostics\n| where ResourceProvider == "MICROSOFT.KEYVAULT"\n| project TimeGenerated, OperationName, ResultSignature, CallerIPAddress, identity_claim_upn_s\n| take 50' },
];

export function KqlEditor({ ws }: { ws: Resource }) {
  useCloud();
  const [q, setQ] = useState(SAMPLES[0].q);
  const [res, setRes] = useState<KqlResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ms, setMs] = useState(0);
  const tables = useMemo(() => workspaceTables(ws, getState()), [ws.id, res]);
  const run = () => {
    const t0 = performance.now();
    try {
      const t = workspaceTables(ws, getState());
      setRes(runKql(q, (name) => findTable(t, name)));
      setErr(null);
    } catch (e: any) {
      setErr(e instanceof KqlError ? e.message : `Error: ${e?.message ?? e}`);
      setRes(null);
    }
    setMs(Math.round(performance.now() - t0));
  };
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ width: 230, flex: '0 0 230px' }}>
        <div className="muted small" style={{ fontWeight: 600, marginBottom: 6 }}>
          Tablas
        </div>
        {Object.entries(tables).map(([name, t]) => (
          <div key={name} className="row small" style={{ padding: '3px 0', cursor: 'pointer' }} onClick={() => setQ(`${name}\n| take 10`)} title="Insertar en el editor">
            <Icon name="file" size={13} style={{ color: 'var(--accent)' }} />
            <span>{name}</span>
            <span className="muted">({t.rows.length})</span>
          </div>
        ))}
        <div className="muted small" style={{ fontWeight: 600, margin: '14px 0 6px' }}>
          Consultas de ejemplo
        </div>
        {SAMPLES.map((s) => (
          <div key={s.label} className="small" style={{ padding: '3px 0' }}>
            <a onClick={() => setQ(s.q)}>{s.label}</a>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <textarea
          className="textarea"
          rows={8}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              run();
            }
          }}
        />
        <div className="btn-row" style={{ margin: '8px 0 12px' }}>
          <button className="btn primary" onClick={run}>
            ▶ Ejecutar
          </button>
          <span className="muted small">Mayús+Intro para ejecutar · {res ? `${res.rows.length} resultados · ${ms} ms` : ''}</span>
        </div>
        {err ? <Callout kind="bad" title="La consulta no es válida">{err}</Callout> : null}
        {res ? (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="grid">
              <thead>
                <tr>
                  {res.columns.map((c) => (
                    <th key={c.name}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {res.rows.slice(0, 500).map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td key={j} className="small" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {formatKqlValue(v, res.columns[j].type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!res.rows.length ? <div className="empty">No se encontraron resultados. ¿Has configurado la configuración de diagnóstico de tus recursos para enviar registros a esta área de trabajo?</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceSources({ r }: { r: Resource }) {
  const s = useCloud();
  const l = linkedResources(r, s);
  const diag = s.diagnosticSettings.filter((d) => d.workspaceId?.toLowerCase() === r.id.toLowerCase());
  return (
    <>
      <p>Orígenes de datos que envían información a esta área de trabajo. El registro de actividad de la suscripción está siempre disponible (tabla AzureActivity).</p>
      <DataTable
        rows={diag}
        rowKey={(d) => d.id}
        columns={[
          { key: 'n', title: 'Configuración de diagnóstico', render: (d) => d.name },
          { key: 'r', title: 'Recurso', render: (d) => <a href={resourceHref(d.resourceUri)}>{d.resourceUri.split('/').pop()}</a> },
          { key: 'c', title: 'Categorías', render: (d) => d.logs.filter((x) => x.enabled).map((x) => x.category ?? x.categoryGroup).join(', ') },
        ]}
        empty="Ningún recurso envía registros todavía. Crea una configuración de diagnóstico (Monitor > Configuración de diagnóstico)."
      />
      <p className="muted small" style={{ marginTop: 10 }}>
        VM con agente: {l.vms.length} · Clústeres AKS: {l.clusters.length} · Application Insights: {l.components.length}
      </p>
    </>
  );
}

function AlertInstances({ r }: { r: Resource }) {
  const s = useCloud();
  const list = s.alerts.filter((a) => a.ruleId.toLowerCase() === r.id.toLowerCase());
  return (
    <DataTable
      rows={list}
      rowKey={(a) => a.id}
      columns={[
        { key: 's', title: 'Estado', render: (a) => <span className={`pill ${a.state === 'Fired' ? 'bad' : 'ok'}`}>{a.state === 'Fired' ? 'Activada' : 'Resuelta'}</span> },
        { key: 'v', title: 'Valor', render: (a) => a.metricValue.toFixed(2) },
        { key: 'f', title: 'Activada', render: (a) => relTime(a.firedAt) },
        { key: 'r', title: 'Resuelta', render: (a) => (a.resolvedAt ? relTime(a.resolvedAt) : '—') },
      ]}
      empty="Esta regla no se ha activado todavía."
    />
  );
}

export const MONITOR_BLADES: Record<string, TypeBlade> = {
  'microsoft.operationalinsights/workspaces': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Id. del área de trabajo', <span className="mono small">{r.properties.customerId}</span>],
          ['Retención', `${r.properties.retentionInDays} días`],
          ['Plan de tarifa', r.properties.sku?.name],
        ]}
      />
    ),
    sections: [
      { id: 'logs', label: 'Registros', icon: 'code', group: 'General', Comp: ({ r }) => <KqlEditor ws={r} /> },
      { id: 'sources', label: 'Orígenes de datos', icon: 'link', group: 'Configuración', Comp: WorkspaceSources },
    ],
    cli: (r) => [{ label: 'Consultar con KQL desde la CLI', cmd: `az monitor log-analytics query -w ${r.properties.customerId} --analytics-query "AzureActivity | take 5" -o table` }],
  },
  'microsoft.insights/components': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Clave de instrumentación', <span className="mono small">{r.properties.InstrumentationKey}</span>],
          ['Cadena de conexión', <span className="mono small">{r.properties.ConnectionString}</span>],
          ['Área de trabajo', r.properties.WorkspaceResourceId ? <a href={resourceHref(r.properties.WorkspaceResourceId)}>{r.properties.WorkspaceResourceId.split('/').pop()}</a> : 'Clásico'],
        ]}
      />
    ),
    sections: [{ id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection }],
  },
  'microsoft.insights/metricalerts': {
    sections: [{ id: 'history', label: 'Historial de alertas', icon: 'activity', group: 'General', Comp: AlertInstances }],
  },
  'microsoft.managedidentity/userassignedidentities': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Id. de cliente', <span className="mono small">{r.properties.clientId}</span>],
          ['Id. de objeto (principal)', <span className="mono small">{r.properties.principalId}</span>],
          ['Inquilino', <span className="mono small">{r.properties.tenantId}</span>],
        ]}
      />
    ),
  },
};
