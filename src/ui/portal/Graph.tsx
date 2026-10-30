// Explorador de Azure Resource Graph: consultas KQL sobre el inventario de recursos de todas las suscripciones.
import { useMemo, useState } from 'react';
import { useCloud, resourceHref } from '../hooks';
import { Crumbs } from './blade';
import { Callout, CliBox, Checkbox } from '../components/common';
import { Bars } from '../components/charts';
import { Icon, ServiceIcon } from '../components/Icons';
import { cliText } from '../portalCli';
import { terminal } from '../terminal/controller';
import { graphQuery, graphTables, GRAPH_SAMPLES } from '../../engine/services/resourceGraph';
import { formatKqlValue, KqlError, type KqlResult } from '../../engine/services/kql';
import { portalPrincipal } from '../../engine/store';
import { findResource } from '../../engine/arm';
import { recordPortalCommand } from '../../shell/sessions';

export function GraphExplorerPage() {
  const s = useCloud();
  const [q, setQ] = useState(GRAPH_SAMPLES[0].q);
  const [res, setRes] = useState<KqlResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ms, setMs] = useState(0);
  const [asJson, setAsJson] = useState(false);
  const tables = useMemo(() => graphTables(portalPrincipal()), [s]);
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of tables.Resources.rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tables]);
  const oneLine = q.replace(/\s*\n\s*/g, ' ').trim();
  const cmd = cliText(['graph', 'query', '-q', oneLine]);
  const run = () => {
    const t0 = performance.now();
    try {
      setRes(graphQuery(q, portalPrincipal(), { first: 1000 }).result);
      setErr(null);
      recordPortalCommand(cmd, true, portalPrincipal());
    } catch (e: any) {
      setErr(e instanceof KqlError ? e.message : `Error: ${e?.message ?? e}`);
      setRes(null);
      recordPortalCommand(cmd, false, portalPrincipal());
    }
    setMs(Math.round(performance.now() - t0));
  };
  const idCol = res?.columns.findIndex((c) => c.name === 'id') ?? -1;
  const nameCol = res?.columns.findIndex((c) => c.name === 'name') ?? -1;
  // Dos columnas con una numérica (p. ej. summarize count() by type): se puede dibujar.
  const numCol = res && res.columns.length === 2 ? res.columns.findIndex((c) => c.type === 'long' || c.type === 'real') : -1;
  const objects = res ? res.rows.map((row) => Object.fromEntries(res.columns.map((c, i) => [c.name, row[i]]))) : [];
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Explorador de Resource Graph' }]} />
      <div className="page-head">
        <ServiceIcon name="graph" size={34} />
        <div>
          <h1>Explorador de Resource Graph</h1>
          <div className="subtitle">Consulta con KQL el inventario de recursos de todas tus suscripciones (sólo ves lo que tienes permiso para leer)</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ width: 250, flex: '0 0 250px' }}>
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
            Tipos de recursos
          </div>
          <div style={{ maxHeight: 220, overflow: 'auto' }}>
            {types.map(([t, n]) => (
              <div key={t} className="small" style={{ padding: '2px 0', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t} onClick={() => setQ(`Resources\n| where type =~ '${t}'\n| project name, resourceGroup, location, properties`)}>
                {t} <span className="muted">({n})</span>
              </div>
            ))}
            {!types.length ? <div className="muted small">Todavía no tienes recursos.</div> : null}
          </div>
          <div className="muted small" style={{ fontWeight: 600, margin: '14px 0 6px' }}>
            Consultas de ejemplo
          </div>
          {GRAPH_SAMPLES.map((x) => (
            <div key={x.label} className="small" style={{ padding: '3px 0' }}>
              <a onClick={() => setQ(x.q)}>{x.label}</a>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <textarea
            className="textarea mono"
            rows={7}
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
              ▶ Ejecutar consulta
            </button>
            <Checkbox checked={asJson} onChange={setAsJson} label="Formato JSON" />
            <span className="muted small">Mayús+Intro para ejecutar{res ? ` · ${res.rows.length} resultados · ${ms} ms` : ''}</span>
          </div>
          <CliBox cmd={cmd} onRun={() => terminal.typeCommand(cmd)} />
          <div style={{ height: 12 }} />
          {err ? (
            <Callout kind="bad" title="La consulta no es válida">
              {err}
            </Callout>
          ) : null}
          {!res && !err ? (
            <Callout>
              Resource Graph indexa las propiedades de todos los recursos: es la forma rápida de responder preguntas como «¿qué VM no tienen etiqueta de coste?» o «¿cuántas cuentas de almacenamiento permiten acceso público?». Usa <span className="mono">=~</span> para comparar tipos sin distinguir mayúsculas y <span className="mono">properties.x.y</span> para entrar en el JSON.
            </Callout>
          ) : null}
          {res && numCol >= 0 && res.rows.length > 1 ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <Bars unit="Count" rows={res.rows.slice(0, 15).map((row) => ({ label: String(row[1 - numCol] ?? '(vacío)'), value: Number(row[numCol]) }))} />
            </div>
          ) : null}
          {res && asJson ? (
            <div className="code" style={{ maxHeight: 460 }}>
              {JSON.stringify(objects.slice(0, 200), null, 2)}
            </div>
          ) : res ? (
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
                      {row.map((v, j) => {
                        const text = formatKqlValue(v, res.columns[j].type);
                        const link = j === nameCol && idCol >= 0 && findResource(String(row[idCol])) ? resourceHref(String(row[idCol])) : j === idCol && findResource(String(v)) ? resourceHref(String(v)) : null;
                        return (
                          <td key={j} className="small" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }} title={text}>
                            {link ? <a href={link}>{text}</a> : text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!res.rows.length ? <div className="empty">La consulta no devolvió resultados.</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
