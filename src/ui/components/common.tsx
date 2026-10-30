// Componentes reutilizables del portal.
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from './Icons';
import { toast } from '../uiStore';

// ---------------------------------------------------------------- formularios

export function Field({ label, required, help, error, children, stack }: { label: ReactNode; required?: boolean; help?: ReactNode; error?: string | null; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`field${stack ? ' stack' : ''}`}>
      <label>
        {label}
        {required ? <span className="req">*</span> : null}
      </label>
      <div>
        {children}
        {error ? <div className="err">{error}</div> : help ? <div className="help">{help}</div> : null}
      </div>
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, invalid, mono, type = 'text', autoFocus, onEnter, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; invalid?: boolean; mono?: boolean; type?: string; autoFocus?: boolean; onEnter?: () => void; disabled?: boolean }) {
  return (
    <input
      className={`input${invalid ? ' invalid' : ''}${mono ? ' mono' : ''}`}
      value={value}
      type={type}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) onEnter();
      }}
    />
  );
}

export function Select({ value, onChange, options, disabled }: { value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[]; disabled?: boolean }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Radio<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; help?: ReactNode }[] }) {
  return (
    <div>
      {options.map((o) => (
        <label key={o.value} className="radio">
          <input type="radio" checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            {o.label}
            {o.help ? <div className="help muted small">{o.help}</div> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tablas

export interface Column<T> {
  key: string;
  title: ReactNode;
  render?: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  width?: number | string;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelect,
  empty,
  onRowClick,
  maxHeight,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  selectable?: boolean;
  selected?: string[];
  onSelect?: (keys: string[]) => void;
  empty?: ReactNode;
  onRowClick?: (r: T) => void;
  maxHeight?: number;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [asc, setAsc] = useState(true);
  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const s = [...rows].sort((a, b) => {
      const x = col.sort!(a);
      const y = col.sort!(b);
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es');
    });
    return asc ? s : s.reverse();
  }, [rows, sortKey, asc, columns]);
  const sel = selected ?? [];
  const allKeys = rows.map(rowKey);
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="grid">
        <thead>
          <tr>
            {selectable ? (
              <th className="check">
                <input type="checkbox" checked={allKeys.length > 0 && allKeys.every((k) => sel.includes(k))} onChange={(e) => onSelect?.(e.target.checked ? allKeys : [])} />
              </th>
            ) : null}
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={c.sort ? 'sortable' : undefined}
                onClick={() => {
                  if (!c.sort) return;
                  if (sortKey === c.key) setAsc(!asc);
                  else {
                    setSortKey(c.key);
                    setAsc(true);
                  }
                }}
              >
                {c.title}
                {sortKey === c.key ? (asc ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={sel.includes(k) ? 'selected' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>
                {selectable ? (
                  <td className="check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={sel.includes(k)} onChange={(e) => onSelect?.(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))} />
                  </td>
                ) : null}
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.render ? c.render(r) : String((r as any)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length ? <div className="empty">{empty ?? 'No hay elementos para mostrar.'}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- navegación y estructura

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: ReactNode; count?: number }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={t.id === active ? 'active' : undefined} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined ? <span className="num">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface CmdItem {
  label: string;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  sep?: boolean;
}

export function CommandBar({ items }: { items: CmdItem[] }) {
  return (
    <div className="cmdbar">
      {items.map((it, i) =>
        it.sep ? (
          <span key={i} className="sep" />
        ) : (
          <button key={i} onClick={it.onClick} disabled={it.disabled} title={it.title}>
            {it.icon ? <Icon name={it.icon} /> : null}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function Callout({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'bad' | 'ok'; title?: ReactNode; children?: ReactNode }) {
  const icon = kind === 'warn' ? 'warn' : kind === 'bad' ? 'error' : kind === 'ok' ? 'success' : 'info';
  const color = kind === 'warn' ? 'var(--warning-icon)' : kind === 'bad' ? 'var(--danger-icon)' : kind === 'ok' ? 'var(--success)' : 'var(--accent)';
  return (
    <div className={`callout ${kind}`}>
      <Icon name={icon} style={{ color, marginTop: 2 }} />
      <div className="body">
        {title ? <div style={{ fontWeight: 600 }}>{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="spinner" />
      {label ? <span className="muted">{label}</span> : null}
    </span>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="big">{title}</div>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- estados

// El orden importa: se comprueban primero las claves negativas más específicas ("deshabilitado" antes que "habilitado").
const STATUS_CLASS: Record<string, string> = {
  deshabilitad: 'bad',
  desconectad: 'bad',
  inactiv: 'bad',
  detenid: 'bad',
  desasignad: 'bad',
  ejecuci: 'ok',
  correcto: 'ok',
  disponible: 'ok',
  conectad: 'ok',
  habilitad: 'ok',
  activ: 'ok',
  creando: 'info',
  actualizando: 'info',
  iniciando: 'info',
  eliminando: 'warn',
  deteniendo: 'warn',
  running: 'ok',
  succeeded: 'ok',
  ready: 'ok',
  available: 'ok',
  enabled: 'ok',
  active: 'ok',
  healthy: 'ok',
  online: 'ok',
  completed: 'ok',
  approved: 'ok',
  compliant: 'ok',
  stopped: 'bad',
  failed: 'bad',
  deallocated: 'bad',
  disabled: 'bad',
  error: 'bad',
  rejected: 'bad',
  noncompliant: 'bad',
  creating: 'info',
  updating: 'info',
  deleting: 'warn',
  starting: 'info',
  stopping: 'warn',
  deallocating: 'warn',
  pending: 'warn',
  waiting: 'warn',
  queued: 'info',
  inprogress: 'info',
  accepted: 'info',
};

export function statusKind(s: string): string {
  const k = s.toLowerCase().replace(/[^a-z]/g, '');
  for (const [key, v] of Object.entries(STATUS_CLASS)) if (k.includes(key)) return v;
  return '';
}

export function StatusPill({ status }: { status: string }) {
  const k = statusKind(status);
  return (
    <span className={`pill ${k}`}>
      <span className={`dot ${k}`} />
      {status}
    </span>
  );
}

// ---------------------------------------------------------------- código y JSON

function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*"(\s*:)?|\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(json))) {
    if (m.index > last) out.push(json.slice(last, m.index));
    const tok = m[0];
    const cls = tok.startsWith('"') ? (m[2] ? 'json-key' : 'json-str') : /true|false|null/.test(tok) ? 'json-bool' : 'json-num';
    out.push(
      <span key={i++} className={cls}>
        {tok}
      </span>,
    );
    last = m.index + tok.length;
  }
  out.push(json.slice(last));
  return out;
}

export function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text);
    toast('Copiado en el portapapeles', 'success');
  } catch {
    toast('No se pudo copiar', 'error');
  }
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <button className="btn small" onClick={() => copyText(text)} title="Copiar en el portapapeles">
      <Icon name="copy" size={14} />
      {label ?? null}
    </button>
  );
}

export function JsonView({ value, maxHeight }: { value: any; maxHeight?: number }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <div className="code" style={maxHeight ? { maxHeight } : undefined}>
      <span className="copy">
        <CopyButton text={text} />
      </span>
      {highlightJson(text)}
    </div>
  );
}

export function CodeBlock({ code, maxHeight, wrap }: { code: string; maxHeight?: number; wrap?: boolean }) {
  return (
    <div className={`code${wrap ? ' wrap' : ''}`} style={maxHeight ? { maxHeight } : undefined}>
      <span className="copy">
        <CopyButton text={code} />
      </span>
      {code}
    </div>
  );
}

export function CliBox({ cmd, onRun }: { cmd: string; onRun?: () => void }) {
  return (
    <div className="cli-box">
      <span className="prompt">$ </span>
      {cmd}
      <span style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
        {onRun ? (
          <button className="run-btn" style={{ position: 'static' }} onClick={onRun}>
            Ejecutar en Cloud Shell
          </button>
        ) : null}
        <button className="run-btn" style={{ position: 'static' }} onClick={() => copyText(cmd)}>
          Copiar
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- modales y confirmaciones

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay full" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="close-x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmReq {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  requireText?: string;
  resolve: (v: boolean) => void;
}

let confirmReq: ConfirmReq | null = null;
let confirmVer = 0;
const confirmListeners = new Set<() => void>();

function setConfirm(r: ConfirmReq | null) {
  confirmReq = r;
  confirmVer++;
  confirmListeners.forEach((l) => l());
}

/** Diálogo de confirmación (devuelve una promesa). requireText obliga a escribir un texto (como al eliminar un grupo de recursos). */
export function confirmDialog(o: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => setConfirm({ ...o, resolve }));
}

export function ConfirmHost() {
  useSyncExternalStore(
    (l) => {
      confirmListeners.add(l);
      return () => confirmListeners.delete(l);
    },
    () => confirmVer,
    () => confirmVer,
  );
  const [typed, setTyped] = useState('');
  const r = confirmReq;
  useEffect(() => setTyped(''), [r]);
  if (!r) return null;
  const done = (v: boolean) => {
    setConfirm(null);
    r.resolve(v);
  };
  const okEnabled = !r.requireText || typed === r.requireText;
  return (
    <Modal
      title={r.title}
      onClose={() => done(false)}
      footer={
        <>
          <button className={`btn ${r.danger ? 'danger' : 'primary'}`} disabled={!okEnabled} onClick={() => done(true)}>
            {r.confirmText ?? 'Aceptar'}
          </button>
          <button className="btn" onClick={() => done(false)}>
            Cancelar
          </button>
        </>
      }
    >
      <div style={{ marginBottom: 12 }}>{r.message}</div>
      {r.requireText ? (
        <Field stack label={<>Escriba <b>{r.requireText}</b> para confirmar:</>}>
          <TextInput value={typed} onChange={setTyped} autoFocus onEnter={() => okEnabled && done(true)} />
        </Field>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------- utilidades

export function TagsView({ tags }: { tags: Record<string, string> | undefined }) {
  const e = Object.entries(tags ?? {});
  if (!e.length) return <span className="muted">—</span>;
  return (
    <span>
      {e.map(([k, v]) => (
        <span key={k} className="tag">
          {k}: {v}
        </span>
      ))}
    </span>
  );
}

export function KeyValueEditor({ value, onChange, keyLabel = 'Nombre', valueLabel = 'Valor' }: { value: [string, string][]; onChange: (v: [string, string][]) => void; keyLabel?: string; valueLabel?: string }) {
  const rows = [...value, ['', ''] as [string, string]];
  return (
    <div>
      <div className="row muted small" style={{ marginBottom: 4 }}>
        <span style={{ flex: 1 }}>{keyLabel}</span>
        <span style={{ flex: 1 }}>{valueLabel}</span>
        <span style={{ width: 32 }} />
      </div>
      {rows.map(([k, v], i) => (
        <div key={i} className="row" style={{ marginBottom: 6, gap: 8 }}>
          <input
            className="input"
            value={k}
            placeholder={i === value.length ? keyLabel : ''}
            onChange={(e) => {
              const n = [...value];
              if (i === value.length) n.push([e.target.value, '']);
              else n[i] = [e.target.value, v];
              onChange(n);
            }}
          />
          <input
            className="input"
            value={v}
            placeholder={i === value.length ? valueLabel : ''}
            onChange={(e) => {
              const n = [...value];
              if (i === value.length) n.push(['', e.target.value]);
              else n[i] = [k, e.target.value];
              onChange(n);
            }}
          />
          <button className="close-x" disabled={i === value.length} onClick={() => onChange(value.filter((_, j) => j !== i))} title="Quitar">
            <Icon name="delete" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '?'
  );
}
