// Editor de código de Cloud Shell y navegador web simulado.
import { useEffect, useMemo, useRef, useState } from 'react';
import { setUi, useUi, toast } from '../uiStore';
import { terminal } from '../terminal/controller';
import { Icon } from './Icons';
import { httpGet } from '../../engine/services/net';
import type { VFS } from '../../shell/fs';

function editorFs(): { fs: VFS; home: string } | null {
  const s = terminal.sess ?? terminal.stack[0];
  return s ? { fs: s.fs, home: s.home } : null;
}

function Tree({ fs, dir, sel, onOpen }: { fs: VFS; dir: string; sel: string | null; onOpen: (p: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const render = (d: string, depth: number): React.ReactNode[] => {
    let entries: { name: string; node: any }[] = [];
    try {
      entries = fs.list(d).filter((e) => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.dockerignore' || e.name === '.bashrc');
    } catch {
      return [];
    }
    entries.sort((a, b) => (a.node.t === b.node.t ? a.name.localeCompare(b.name) : a.node.t === 'd' ? -1 : 1));
    return entries.flatMap((e) => {
      const p = `${d === '/' ? '' : d}/${e.name}`;
      const isDir = e.node.t === 'd';
      const row = (
        <div
          key={p}
          className={`node${sel === p ? ' sel' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (isDir ? setOpen({ ...open, [p]: !open[p] }) : onOpen(p))}
          title={p}
        >
          {isDir ? (open[p] ? '▾ ' : '▸ ') : '   '}
          {e.name}
        </div>
      );
      return isDir && open[p] ? [row, ...render(p, depth + 1)] : [row];
    });
  };
  return <div className="editor-tree">{render(dir, 0)}</div>;
}

export function Editor() {
  const u = useUi();
  const ctx = editorFs();
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const req = u.editor?.path ?? null;
  const root = useMemo(() => {
    if (!req) return '/';
    return req.endsWith('/') ? req.replace(/\/+$/, '') || '/' : req.split('/').slice(0, -1).join('/') || '/';
  }, [req]);

  useEffect(() => {
    if (!req || !ctx) return;
    if (req.endsWith('/')) {
      setPath(null);
      setText('');
      setSaved('');
      return;
    }
    let content = '';
    try {
      content = ctx.fs.isFile(req) ? ctx.fs.readFile(req) : '';
    } catch {
      content = '';
    }
    setPath(req);
    setText(content);
    setSaved(ctx.fs.isFile(req) ? content : '\u0000');
    setTimeout(() => taRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  if (!u.editor || !ctx) return null;
  const dirty = path !== null && text !== saved;

  const save = () => {
    if (!path) return;
    try {
      ctx.fs.mkdir(path.split('/').slice(0, -1).join('/') || '/', true);
      ctx.fs.writeFile(path, text);
      setSaved(text);
      toast(`Guardado: ${path.replace(ctx.home, '~')}`, 'success');
    } catch (e: any) {
      toast('No se pudo guardar', 'error', e?.message === 'EACCES' || e?.code === 'EACCES' ? 'Permiso denegado (usa sudo o guarda en tu directorio personal).' : String(e?.message ?? e));
    }
  };

  const close = () => {
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Cerrar de todos modos?')) return;
    setUi({ editor: null });
  };

  const openFile = (p: string) => {
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos?')) return;
    setUi({ editor: { path: p } });
  };

  const lines = text.split('\n').length;

  return (
    <div
      className="editor"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          save();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="editor-bar">
        <Icon name="braces" />
        <span className="name">{path ? path.replace(ctx.home, '~') + (dirty ? ' ●' : '') : root.replace(ctx.home, '~')}</span>
        <span className="spacer" />
        <span style={{ color: '#888', fontSize: 12, marginRight: 8 }}>Ctrl+S guardar · Ctrl+Q cerrar</span>
        <button onClick={save} disabled={!path}>
          Guardar
        </button>
        <button onClick={close}>Cerrar editor</button>
      </div>
      <div className="editor-main">
        <Tree fs={ctx.fs} dir={root} sel={path} onOpen={openFile} />
        {path ? (
          <div className="editor-code">
            <div className="editor-gutter">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
            <textarea
              ref={taRef}
              value={text}
              spellCheck={false}
              rows={Math.max(lines + 4, 30)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const s = el.selectionStart;
                  const next = text.slice(0, s) + '  ' + text.slice(el.selectionEnd);
                  setText(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = s + 2;
                  });
                }
              }}
            />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>Selecciona un fichero en el árbol de la izquierda.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- navegador

function errorPage(url: string, error: string, hint?: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><body style="font-family:Segoe UI,sans-serif;padding:60px;color:#202124;background:#fff">
<div style="font-size:60px">😕</div><h1 style="font-weight:400">No se puede acceder a este sitio</h1>
<p><b>${esc(url)}</b></p><p style="color:#5f6368">${esc(error)}</p>
${hint ? `<p style="background:#e8f0fe;padding:10px 14px;border-radius:6px">💡 ${esc(hint)}</p>` : ''}
<p style="color:#5f6368;font-size:13px">ERR_CONNECTION_TIMED_OUT</p></body></html>`;
}

export function Browser() {
  const u = useUi();
  const [addr, setAddr] = useState(u.browser?.url ?? '');
  const [nonce, setNonce] = useState(0);
  const url = u.browser?.url ?? '';
  useEffect(() => setAddr(url), [url]);
  const result = useMemo(() => (url ? httpGet(url.startsWith('http') ? url : `https://${url}`) : null), [url, nonce]);
  if (!u.browser || !result) return null;
  const ct = result.headers?.['Content-Type'] ?? '';
  let doc: string;
  if (!result.ok) doc = errorPage(url, result.error ?? 'Error de conexión', result.hint);
  else if (/html/i.test(ct) || /^\s*</.test(result.body ?? '')) doc = result.body ?? '';
  else doc = `<!doctype html><pre style="font-family:Consolas,monospace;white-space:pre-wrap;padding:12px">${(result.body ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  const go = (v: string) => {
    const full = /^https?:\/\//.test(v) ? v : `https://${v}`;
    setUi((x) => ({ browser: { url: full, history: [...(x.browser?.history ?? []), full] } }));
  };
  const back = () => {
    const h = u.browser!.history;
    if (h.length < 2) return;
    const nh = h.slice(0, -1);
    setUi({ browser: { url: nh[nh.length - 1], history: nh } });
  };
  return (
    <div className="overlay full" style={{ zIndex: 80 }} onMouseDown={(e) => e.target === e.currentTarget && setUi({ browser: null })}>
      <div className="browser">
        <div className="browser-bar">
          <button className="close-x" onClick={back} title="Atrás">
            <Icon name="back" />
          </button>
          <button className="close-x" onClick={() => setNonce(nonce + 1)} title="Recargar">
            <Icon name="refresh" />
          </button>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(addr)} />
          <span className="pill">{result.ok ? `HTTP ${result.status}` : 'Error'}</span>
          <button className="close-x" onClick={() => setUi({ browser: null })} title="Cerrar">
            <Icon name="close" />
          </button>
        </div>
        <iframe key={`${url}#${nonce}`} title="Navegador" sandbox="allow-scripts" srcDoc={doc} />
        <div className="status">Navegador simulado de Azure Lab · las peticiones se resuelven contra la nube simulada (DNS, NSG, App Service, Storage...)</div>
      </div>
    </div>
  );
}
