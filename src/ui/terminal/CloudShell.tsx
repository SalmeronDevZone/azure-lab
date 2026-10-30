// Panel de Cloud Shell acoplado en la parte inferior del portal.
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { terminal } from './controller';
import { segments, type Cell } from './screen';
import { setUi, useUi, toast } from '../uiStore';
import { Icon } from '../components/Icons';

function useTerminalVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const unsub = terminal.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setV(terminal.version);
      });
    });
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return v;
}

const Line = memo(function Line({ cells, rev }: { cells: Cell[]; rev: string }) {
  void rev;
  if (!cells.length) return <div className="term-line" />;
  return (
    <div className="term-line">
      {segments(cells).map((seg, i) => {
        const css = terminal.screen.css(seg.s);
        return (
          <span key={i} className={css.className || undefined} style={css.color || css.background ? { color: css.color, background: css.background } : undefined}>
            {seg.text}
          </span>
        );
      })}
    </div>
  );
});

const Output = memo(function Output({ version }: { version: number }) {
  void version;
  const lines = terminal.screen.lines;
  const start = Math.max(0, lines.length - 1 - 2000);
  const out = [];
  for (let i = start; i < lines.length - 1; i++) {
    const l = lines[i];
    out.push(<Line key={i} cells={l} rev={`${l.length}:${l.length ? l[l.length - 1].c + l[l.length - 1].s : ''}:${version}`} />);
  }
  return <>{out}</>;
});

function PromptSegments({ text }: { text: string }) {
  // El prompt puede llevar colores ANSI: se interpreta con un búfer temporal.
  const parts: { t: string; color?: string; bold?: boolean }[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let color: string | undefined;
  let bold = false;
  let m: RegExpExecArray | null;
  const map: Record<string, string> = { '31': '#e74856', '32': '#16c60c', '33': '#f9f1a5', '34': '#5b8fff', '35': '#b4009e', '36': '#61d6d6', '37': '#f2f2f2' };
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), color, bold });
    for (const p of m[1].split(';')) {
      if (p === '0' || p === '') {
        color = undefined;
        bold = false;
      } else if (p === '1') bold = true;
      else if (map[p]) color = map[p];
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: text.slice(last), color, bold });
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} style={{ color: p.color, fontWeight: p.bold ? 700 : undefined }}>
          {p.t}
        </span>
      ))}
    </>
  );
}

function InputLine({ focused }: { focused: boolean }) {
  useSyncExternalStore(
    (l) => terminal.subscribe(l),
    () => terminal.version,
    () => terminal.version,
  );
  const lines = terminal.screen.lines;
  const last = lines[lines.length - 1] ?? [];
  const showPrompt = !terminal.running || !!terminal.promptReq;
  const secret = terminal.promptReq?.secret;
  const input = secret ? '' : terminal.input;
  const cur = secret ? 0 : terminal.cursor;
  return (
    <div className="term-input-line">
      <span>
        {last.length ? <Line cells={last} rev={`${last.length}:${terminal.version}`} /> : null}
      </span>
      {showPrompt ? (
        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <PromptSegments text={terminal.promptText()} />
          {input.slice(0, cur)}
          <span className="term-cursor">{input[cur] ?? ' '}</span>
          {input.slice(cur + 1)}
        </span>
      ) : focused ? (
        <span className="term-cursor"> </span>
      ) : null}
    </div>
  );
}

export function CloudShell() {
  const u = useUi();
  const version = useTerminalVersion();
  const termRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [shellType, setShellType] = useState('bash');

  useEffect(() => {
    if (u.shellOpen && !terminal.started) void terminal.start();
    if (u.shellOpen) setTimeout(() => inputRef.current?.focus(), 30);
  }, [u.shellOpen]);

  useLayoutEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [version, u.shellOpen, u.shellHeight, u.shellMax]);

  if (!u.shellOpen) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = terminal;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') {
      e.preventDefault();
      void t.submit();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'c') {
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      t.interrupt();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      t.ui.clear?.();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (!t.input && !t.running) {
        t.setInput('exit');
        void t.submit();
      }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      t.setInput(t.input, 0);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      t.setInput(t.input, t.input.length);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      t.setInput(t.input.slice(t.cursor), 0);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      t.setInput(t.input.slice(0, t.cursor), t.cursor);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      const before = t.input.slice(0, t.cursor).replace(/\S+\s*$/, '');
      t.setInput(before + t.input.slice(t.cursor), before.length);
      return;
    }
    switch (e.key) {
      case 'Backspace':
        e.preventDefault();
        if (t.cursor > 0) t.setInput(t.input.slice(0, t.cursor - 1) + t.input.slice(t.cursor), t.cursor - 1);
        return;
      case 'Delete':
        e.preventDefault();
        t.setInput(t.input.slice(0, t.cursor) + t.input.slice(t.cursor + 1), t.cursor);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        t.setInput(t.input, t.cursor - 1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        t.setInput(t.input, t.cursor + 1);
        return;
      case 'Home':
        e.preventDefault();
        t.setInput(t.input, 0);
        return;
      case 'End':
        e.preventDefault();
        t.setInput(t.input, t.input.length);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!t.promptReq) t.historyMove(-1);
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (!t.promptReq) t.historyMove(1);
        return;
      case 'Tab':
        e.preventDefault();
        t.complete();
        return;
      default:
        break;
    }
  };

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const text = el.value;
    el.value = '';
    if (!text) return;
    insertText(text);
  };

  const insertText = (text: string) => {
    const t = terminal;
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    if (parts.length === 1) {
      t.setInput(t.input.slice(0, t.cursor) + text + t.input.slice(t.cursor), t.cursor + text.length);
      return;
    }
    // Como en bash: se ejecutan las líneas completas y la última (sin salto de línea) queda escrita.
    const trailing = parts.pop()!;
    const first = parts.shift()!;
    t.setInput(t.input.slice(0, t.cursor) + first + t.input.slice(t.cursor));
    void t.submit();
    for (const p of parts) t.runCommand(p);
    if (trailing) t.typeAfterQueue(trailing);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = u.shellHeight;
    const move = (ev: MouseEvent) => setUi({ shellHeight: Math.max(160, Math.min(window.innerHeight - 120, startH + (startY - ev.clientY))) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const download = () => {
    const sess = terminal.stack[0];
    if (!sess) return;
    const p = window.prompt('Ruta del fichero que quieres descargar (p. ej. ~/samples/README.md):', '~/');
    if (!p) return;
    try {
      const abs = sess.resolve(p);
      const content = sess.fs.readFile(abs);
      const blob = new Blob([content], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = abs.split('/').pop() ?? 'fichero';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast('No se encontró el fichero', 'error', p);
    }
  };

  return (
    <div className={`shell-dock${u.shellMax ? ' max' : ''}`} style={{ height: u.shellMax ? undefined : u.shellHeight }}>
      {!u.shellMax ? <div className="shell-resize" onMouseDown={startResize} title="Arrastra para cambiar el tamaño" /> : null}
      <div className="shell-bar">
        <select
          value={shellType}
          onChange={(e) => {
            if (e.target.value === 'pwsh') {
              toast('PowerShell no está disponible en el simulador', 'warning', 'Azure Lab sólo simula Bash. Todos los laboratorios usan Bash y Azure CLI.');
              setShellType('bash');
              return;
            }
            setShellType(e.target.value);
          }}
          title="Seleccionar entorno"
        >
          <option value="bash">Bash</option>
          <option value="pwsh">PowerShell</option>
        </select>
        <button onClick={() => terminal.restart()} title="Reiniciar Cloud Shell">
          <Icon name="restart" size={14} /> Reiniciar
        </button>
        <button onClick={() => fileRef.current?.click()} title="Cargar archivo en $HOME">
          <Icon name="upload" size={14} /> Cargar
        </button>
        <button onClick={download} title="Descargar archivo">
          <Icon name="download" size={14} /> Descargar
        </button>
        <button onClick={() => setUi({ editor: { path: (terminal.sess?.cwd ?? '~') + '/' } })} title="Abrir el editor">
          <Icon name="braces" size={14} /> Editor
        </button>
        <button onClick={() => setUi({ fontSize: Math.max(11, u.fontSize - 1) })} title="Reducir fuente">
          A−
        </button>
        <button onClick={() => setUi({ fontSize: Math.min(20, u.fontSize + 1) })} title="Aumentar fuente">
          A+
        </button>
        <span className="spacer" />
        <span className="small" style={{ color: '#9a9a9a', marginRight: 8 }}>
          {terminal.stack.length > 1 ? `Conectado a ${terminal.sess?.host}` : 'Cloud Shell (simulado)'}
        </span>
        <button onClick={() => setUi({ shellMax: !u.shellMax })} title={u.shellMax ? 'Restaurar' : 'Maximizar'}>
          <Icon name={u.shellMax ? 'minimize' : 'maximize'} size={14} />
        </button>
        <button onClick={() => setUi({ shellOpen: false, shellMax: false })} title="Cerrar (la sesión se mantiene)">
          <Icon name="close" size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const text = await f.text();
            terminal.upload(f.name, text);
            e.target.value = '';
          }}
        />
      </div>
      <div
        ref={termRef}
        className={`term${focused ? ' focused' : ''}`}
        style={{ fontSize: u.fontSize }}
        onMouseUp={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        <Output version={version} />
        <InputLine focused={focused} />
        <textarea
          ref={inputRef}
          className="term-input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onPaste={(e) => {
            e.preventDefault();
            insertText(e.clipboardData.getData('text'));
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
    </div>
  );
}
