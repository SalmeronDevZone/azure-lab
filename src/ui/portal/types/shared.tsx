// Tipos y piezas compartidas por los blades específicos de cada tipo de recurso.
import { useState, type FC, type ReactNode } from 'react';
import type { Resource } from '../../../engine/types';
import type { CmdItem } from '../../components/common';
import { Select } from '../../components/common';
import { LineChart } from '../../components/charts';
import { metricSeries, metricsFor } from '../../../engine/services/monitor';
import { useCloud, useTick } from '../../hooks';

export interface TypeSection {
  id: string;
  label: string;
  icon: string;
  group: string;
  Comp: FC<{ r: Resource }>;
}

export interface TypeBlade {
  commands?: (r: Resource) => CmdItem[];
  Overview?: FC<{ r: Resource }>;
  sections?: TypeSection[];
  cli?: (r: Resource) => { label: string; cmd: string }[];
}

/** Argumentos comunes -g/-n para los comandos de un recurso. */
export const gn = (r: Resource) => ['-g', r.resourceGroup, '-n', r.name];

export function MetricsSection({ r }: { r: Resource }) {
  useCloud();
  useTick(5000);
  const defs = metricsFor(r.type);
  const [metric, setMetric] = useState(defs[0]?.name ?? '');
  const [range, setRange] = useState('60');
  if (!defs.length) return <div className="muted">Este tipo de recurso no publica métricas en el simulador.</div>;
  const def = defs.find((d) => d.name === metric) ?? defs[0];
  const minutes = Number(range);
  const step = minutes <= 60 ? 60000 : minutes <= 360 ? 300000 : 900000;
  const pts = metricSeries(r, def.name, minutes, step);
  return (
    <>
      <div className="list-toolbar">
        <div style={{ width: 280 }}>
          <Select value={def.name} onChange={setMetric} options={defs.map((d) => ({ value: d.name, label: `${d.label} (${d.aggregation})` }))} />
        </div>
        <div style={{ width: 180 }}>
          <Select
            value={range}
            onChange={setRange}
            options={[
              { value: '30', label: 'Últimos 30 minutos' },
              { value: '60', label: 'Última hora' },
              { value: '360', label: 'Últimas 6 horas' },
              { value: '1440', label: 'Últimas 24 horas' },
            ]}
          />
        </div>
      </div>
      <div className="card">
        <h3>
          {def.label} <span className="muted small">· {def.name}</span>
        </h3>
        <LineChart points={pts} unit={def.unit} />
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        Las métricas se calculan a partir de la actividad real en el simulador (peticiones HTTP, carga de CPU con stress, estado de energía...). Puedes crear alertas sobre ellas en Monitor.
      </p>
    </>
  );
}

export function Props({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="table-wrap" style={{ maxWidth: 820 }}>
      <table className="grid">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 240, color: 'var(--text-2)' }}>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
