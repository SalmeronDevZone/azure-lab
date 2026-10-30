// Formateadores de salida de Azure CLI (json, jsonc, table, tsv, yaml, none).
import { dump } from 'js-yaml';

export function colorJson(v: any, color: boolean): string {
  const text = JSON.stringify(v, null, 2);
  if (!color || text === undefined) return text ?? '';
  return text.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, lit, num) => {
    if (str) return colon ? `\x1b[94m${str}\x1b[0m${colon}` : `\x1b[32m${str}\x1b[0m`;
    if (lit) return `\x1b[33m${lit}\x1b[0m`;
    if (num) return `\x1b[36m${num}\x1b[0m`;
    return m;
  });
}

function isScalar(v: any) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function scalarStr(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

function headerName(k: string): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}

export function formatTable(v: any): string {
  if (v === null || v === undefined) return '';
  let rows: any[] = Array.isArray(v) ? v : [v];
  if (!rows.length) return '';
  if (rows.every(isScalar)) {
    const vals = rows.map(scalarStr);
    const w = Math.max(6, ...vals.map((x) => x.length));
    return ['Result', '-'.repeat(w), ...vals].join('\n');
  }
  rows = rows.filter((r) => r && typeof r === 'object');
  const cols: string[] = [];
  for (const r of rows) for (const [k, val] of Object.entries(r)) if (isScalar(val) && !cols.includes(k)) cols.push(k);
  if (!cols.length) return '';
  const data = rows.map((r) => cols.map((c) => scalarStr(r[c])));
  const heads = cols.map(headerName);
  const widths = cols.map((_, i) => Math.max(heads[i].length, ...data.map((d) => d[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(heads), widths.map((w) => '-'.repeat(w)).join('  '), ...data.map(line)].join('\n');
}

export function formatTsv(v: any): string {
  if (v === null || v === undefined) return '';
  const rowOf = (x: any): string => {
    if (isScalar(x)) return scalarStr(x);
    if (Array.isArray(x)) return x.map((y) => (isScalar(y) ? scalarStr(y) : '')).join('\t');
    return Object.values(x)
      .filter(isScalar)
      .map(scalarStr)
      .join('\t');
  };
  if (Array.isArray(v)) return v.map(rowOf).join('\n');
  return rowOf(v);
}

export function formatOutput(v: any, format: string, color: boolean): string {
  switch (format) {
    case 'none':
      return '';
    case 'table':
      return formatTable(v);
    case 'tsv':
      return formatTsv(v);
    case 'yaml':
    case 'yamlc':
      return v === undefined ? '' : dump(v, { noRefs: true, lineWidth: 200 } as any).trimEnd();
    case 'jsonc':
      return colorJson(v, true);
    default:
      return colorJson(v, color);
  }
}
