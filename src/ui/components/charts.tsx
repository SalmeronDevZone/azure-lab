// Gráficas SVG ligeras (métricas y costes).
import { useMemo, useState } from 'react';

export interface Point {
  t: number;
  v: number | null;
}

function fmtValue(v: number, unit: string): string {
  if (unit === 'Percent') return `${v.toFixed(v < 10 ? 1 : 0)} %`;
  if (unit === 'Bytes') {
    if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
    if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${Math.round(v)} B`;
  }
  if (unit === 'Seconds') return `${v.toFixed(2)} s`;
  if (unit === 'Milliseconds') return `${Math.round(v)} ms`;
  if (unit === 'Money') return `$${v.toFixed(2)}`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)} k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export { fmtValue };

export function LineChart({ points, unit = 'Count', threshold, height = 240, color }: { points: Point[]; unit?: string; threshold?: number; height?: number; color?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = height;
  const pad = { l: 56, r: 16, t: 12, b: 26 };
  const vals = points.map((p) => p.v).filter((v): v is number => v !== null);
  const max = useMemo(() => {
    let m = Math.max(1, ...vals, threshold ?? 0);
    if (unit === 'Percent') m = Math.max(m, 100);
    const mag = 10 ** Math.floor(Math.log10(m));
    return Math.ceil((m * 1.1) / mag) * mag;
  }, [vals.join(','), threshold, unit]);
  if (!points.length) return null;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  let path = '';
  let area = '';
  let started = false;
  let firstX = 0;
  let lastX = 0;
  for (const p of points) {
    if (p.v === null) {
      started = false;
      continue;
    }
    const px = x(p.t);
    const py = y(p.v);
    path += `${started ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)} `;
    if (!area) firstX = px;
    area += `${area ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)} `;
    lastX = px;
    started = true;
  }
  const areaPath = area ? `${area} L${lastX},${y(0)} L${firstX},${y(0)} Z` : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + (t1 - t0) * f);
  const hp = hover !== null ? points[hover] : null;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      onMouseMove={(e) => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const rx = ((e.clientX - rect.left) / rect.width) * W;
        const idx = Math.round(((rx - pad.l) / (W - pad.l - pad.r)) * (points.length - 1));
        setHover(idx >= 0 && idx < points.length ? idx : null);
      }}
      onMouseLeave={() => setHover(null)}
    >
      {ticks.map((v, i) => (
        <g key={i}>
          <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end">
            {fmtValue(v, unit)}
          </text>
        </g>
      ))}
      {timeTicks.map((t, i) => (
        <text key={i} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
          {new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
        </text>
      ))}
      {areaPath ? <path className="area" d={areaPath} style={color ? { fill: color } : undefined} /> : null}
      <path className="line" d={path} style={color ? { stroke: color } : undefined} />
      {threshold !== undefined ? <line className="threshold" x1={pad.l} x2={W - pad.r} y1={y(threshold)} y2={y(threshold)} /> : null}
      {hp ? (
        <g>
          <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={H - pad.b} stroke="var(--text-3)" strokeDasharray="3 3" />
          {hp.v !== null ? <circle cx={x(hp.t)} cy={y(hp.v)} r={4} fill="var(--accent)" /> : null}
          <rect x={Math.min(x(hp.t) + 8, W - 170)} y={pad.t + 4} width={160} height={36} rx={3} fill="var(--surface)" stroke="var(--border)" />
          <text x={Math.min(x(hp.t) + 16, W - 162)} y={pad.t + 19} style={{ fill: 'var(--text)', fontWeight: 600 }}>
            {hp.v === null ? 'Sin datos' : fmtValue(hp.v, unit)}
          </text>
          <text x={Math.min(x(hp.t) + 16, W - 162)} y={pad.t + 33}>
            {new Date(hp.t).toLocaleTimeString('es-ES')}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

export function Bars({ rows, unit = 'Money' }: { rows: { label: string; value: number; href?: string }[]; unit?: string }) {
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>
            {r.href ? <a href={r.href}>{r.label}</a> : r.label}
          </span>
          <div style={{ background: 'var(--surface-2)', borderRadius: 2 }}>
            <div className="bar" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="mono" style={{ textAlign: 'right' }}>
            {fmtValue(r.value, unit)}
          </span>
        </div>
      ))}
      {!rows.length ? <div className="muted">Sin datos todavía.</div> : null}
    </div>
  );
}
