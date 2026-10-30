// Controlador del terminal de Cloud Shell: sesiones (Cloud Shell, ssh, sudo -i), edición de línea,
// historial, autocompletado y preguntas interactivas.
import { Screen } from './screen';
import { ExitSignal, isIncomplete, type Session, type SessionUI, type ShellIO } from '../../shell/interp';
import { createCloudShellSession, loadBashrc } from '../../shell/sessions';
import { allAzCommands, azGroups } from '../../shell/az/framework';
import { getState, changed, bus } from '../../engine/store';
import { guid } from '../../engine/util';
import { setUi } from '../uiStore';
import { navigate } from '../hooks';

const BUILTINS = ['cd', 'pwd', 'export', 'unset', 'set', 'source', 'exit', 'alias', 'unalias', 'type', 'read', 'eval', 'history', 'declare', 'local', 'test', 'true', 'false', 'clear', 'bash', 'sh'];
const KUBECTL_SUB = ['get', 'describe', 'apply', 'create', 'delete', 'logs', 'exec', 'expose', 'scale', 'rollout', 'set', 'run', 'config', 'cluster-info', 'top', 'version', 'label', 'autoscale', 'port-forward', 'explain', 'edit'];
const GIT_SUB = ['init', 'clone', 'status', 'add', 'commit', 'push', 'pull', 'fetch', 'log', 'branch', 'checkout', 'switch', 'merge', 'remote', 'diff', 'config', 'reset', 'restore', 'rm', 'mv', 'tag', 'show', 'stash'];
const DOCKER_SUB = ['build', 'run', 'ps', 'images', 'pull', 'push', 'tag', 'login', 'logout', 'stop', 'start', 'rm', 'rmi', 'logs', 'exec', 'inspect', 'version', 'info'];
const TF_SUB = ['init', 'validate', 'plan', 'apply', 'destroy', 'fmt', 'output', 'show', 'state', 'import', 'version', 'console', 'refresh', 'providers', 'workspace'];

export interface PromptReq {
  q: string;
  secret: boolean;
  resolve: (s: string) => void;
}

export class TerminalController {
  screen = new Screen();
  stack: Session[] = [];
  input = '';
  cursor = 0;
  pending = '';
  running = false;
  abort: AbortController | null = null;
  promptReq: PromptReq | null = null;
  started = false;
  private histIdx = -1;
  private draft = '';
  private queue: string[] = [];
  private listeners = new Set<() => void>();
  version = 0;

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  emit() {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  get sess(): Session | undefined {
    return this.stack[this.stack.length - 1];
  }

  write(s: string) {
    this.screen.write(s);
    this.emit();
  }

  ui: SessionUI = {
    clear: () => {
      this.screen.clear();
      this.emit();
    },
    openEditor: (path: string) => {
      setUi({ editor: { path } });
    },
    openUrl: (url: string) => openUrl(url),
    enterSession: (child: Session, banner?: string) => {
      this.stack.push(child);
      if (banner) this.write(banner.endsWith('\n') ? banner : banner + '\n');
      this.emit();
    },
    exitSession: () => {
      if (this.stack.length > 1) this.stack.pop();
      this.emit();
    },
  };

  async start() {
    if (this.started) return;
    this.started = true;
    this.write('\x1b[33mRequesting a Cloud Shell.\x1b[0m\x1b[32mSucceeded.\x1b[0m\r\n');
    this.write('\x1b[33mConnecting terminal...\x1b[0m\r\n\r\n');
    await new Promise((r) => setTimeout(r, 250));
    this.write('Welcome to Azure Cloud Shell\r\n\r\n');
    this.write('Type "\x1b[1maz\x1b[0m" to use Azure CLI\r\n');
    this.write('Type "\x1b[1mhelp\x1b[0m" to learn about Cloud Shell\r\n\r\n');
    this.write('\x1b[2mAzure Lab: simulador local. Tus ficheros de $HOME se conservan entre sesiones (en ~/samples tienes ejemplos para los laboratorios).\x1b[0m\r\n\r\n');
    const sess = createCloudShellSession(this.ui);
    this.stack = [sess];
    const io = this.io(new AbortController());
    await loadBashrc(sess, io);
    this.emit();
    this.flushQueue();
  }

  restart() {
    this.abort?.abort();
    this.started = false;
    this.stack = [];
    this.pending = '';
    this.input = '';
    this.cursor = 0;
    this.promptReq = null;
    this.running = false;
    this.screen.clear();
    void this.start();
  }

  private io(abort: AbortController): ShellIO {
    return {
      stdin: null,
      out: (s) => this.write(s),
      err: (s) => this.write(s),
      isTTY: true,
      signal: abort.signal,
      prompt: (q, o) => this.ask(q, !!o?.secret),
    };
  }

  ask(q: string, secret: boolean): Promise<string> {
    return new Promise((resolve) => {
      this.promptReq = { q, secret, resolve };
      this.input = '';
      this.cursor = 0;
      this.emit();
    });
  }

  promptText(): string {
    if (this.promptReq) return this.promptReq.q;
    if (this.pending) return '> ';
    return this.sess?.prompt() ?? '';
  }

  /** Ejecuta un comando como si el estudiante lo hubiera escrito. */
  runCommand(cmd: string) {
    setUi({ shellOpen: true });
    // Mientras la sesión arranca o hay un comando en curso, se encola (start() y exec() vacían la cola).
    if (!this.started || !this.sess || this.running) {
      this.queue.push(cmd);
      if (!this.started) void this.start();
      return;
    }
    this.input = cmd;
    this.cursor = cmd.length;
    void this.submit();
  }

  /** Escribe texto en la línea de entrada sin ejecutarlo. */
  typeCommand(cmd: string) {
    setUi({ shellOpen: true });
    if (!this.started || !this.sess) {
      this.typeAfterQueue(cmd);
      if (!this.started) void this.start();
      return;
    }
    this.input = cmd;
    this.cursor = cmd.length;
    this.emit();
  }

  private afterQueue: string | null = null;

  /** Deja un texto escrito en la línea de entrada cuando termine la cola de comandos. */
  typeAfterQueue(s: string) {
    if (this.started && this.sess && !this.running && !this.queue.length) this.setInput(s);
    else this.afterQueue = s;
  }

  private flushQueue() {
    if (this.running) return;
    if (!this.queue.length) {
      if (this.afterQueue !== null) {
        const s = this.afterQueue;
        this.afterQueue = null;
        this.setInput(s);
      }
      return;
    }
    const next = this.queue.shift()!;
    this.input = next;
    this.cursor = next.length;
    void this.submit();
  }

  async submit() {
    if (this.promptReq) {
      const r = this.promptReq;
      const shown = r.secret ? '' : this.input;
      this.write(`${r.q}${shown}\r\n`);
      this.promptReq = null;
      const v = this.input;
      this.input = '';
      this.cursor = 0;
      this.emit();
      r.resolve(v);
      return;
    }
    if (this.running || !this.sess) return;
    const line = this.input;
    this.write(`${this.promptText()}${line}\r\n`);
    this.input = '';
    this.cursor = 0;
    this.histIdx = -1;
    const src = this.pending ? `${this.pending}\n${line}` : line;
    if (isIncomplete(src)) {
      this.pending = src;
      this.emit();
      return;
    }
    this.pending = '';
    if (!src.trim()) {
      this.emit();
      return;
    }
    const sess = this.sess;
    const h = sess.history;
    if (src.trim() && h[h.length - 1] !== src) h.push(src);
    if (h.length > 500) h.splice(0, h.length - 400);
    await this.exec(sess, src);
  }

  private async exec(sess: Session, src: string) {
    this.running = true;
    const abort = new AbortController();
    this.abort = abort;
    this.emit();
    // La línea completa (con tuberías, variables...) también se registra para las validaciones de la Academia.
    const entry = { id: guid(), cmd: src, ts: Date.now(), ok: true, source: 'typed' as const, principal: sess.az.principal?.name };
    getState().cli.commandLog.push(entry);
    try {
      const code = await sess.run(src, this.io(abort));
      entry.ok = code === 0;
    } catch (e) {
      if (e instanceof ExitSignal) this.onExit(sess);
      else {
        this.write(`\x1b[31mError interno del simulador: ${(e as Error)?.message ?? e}\x1b[0m\r\n`);
        console.error(e);
      }
    } finally {
      this.running = false;
      this.abort = null;
      const root = this.stack[0];
      if (root && root.kind === 'cloudshell') {
        getState().cli.cwd = root.cwd;
        changed();
      }
      bus.emit('shell:command', { cmd: src });
      this.emit();
      this.flushQueue();
    }
  }

  private onExit(sess: Session) {
    const idx = this.stack.indexOf(sess);
    if (idx > 0) {
      const parent = this.stack[idx - 1];
      this.stack.splice(idx);
      this.write('logout\r\n');
      if (parent.kind === 'cloudshell' && sess.kind === 'vm') this.write(`Connection to ${sess.host} closed.\r\n`);
      return;
    }
    this.write('exit\r\n\r\n\x1b[33mLa sesión de Cloud Shell ha terminado. Iniciando una sesión nueva...\x1b[0m\r\n\r\n');
    const fresh = createCloudShellSession(this.ui);
    this.stack = [fresh];
  }

  interrupt() {
    if (this.promptReq) {
      const r = this.promptReq;
      this.promptReq = null;
      this.write(`${r.q}^C\r\n`);
      this.input = '';
      this.cursor = 0;
      this.abort?.abort();
      r.resolve('');
      this.emit();
      return;
    }
    if (this.running) {
      this.abort?.abort();
      return;
    }
    this.write(`${this.promptText()}${this.input}^C\r\n`);
    this.input = '';
    this.cursor = 0;
    this.pending = '';
    this.emit();
  }

  historyMove(dir: -1 | 1) {
    const h = this.sess?.history ?? [];
    if (!h.length) return;
    if (this.histIdx === -1) {
      if (dir === 1) return;
      this.draft = this.input;
      this.histIdx = h.length - 1;
    } else {
      this.histIdx += dir;
      if (this.histIdx >= h.length) {
        this.histIdx = -1;
        this.input = this.draft;
        this.cursor = this.input.length;
        this.emit();
        return;
      }
      if (this.histIdx < 0) this.histIdx = 0;
    }
    this.input = h[this.histIdx];
    this.cursor = this.input.length;
    this.emit();
  }

  setInput(v: string, cursor = v.length) {
    this.input = v;
    this.cursor = Math.max(0, Math.min(cursor, v.length));
    this.emit();
  }

  // ---------------------------------------------------------------- autocompletado

  complete() {
    const sess = this.sess;
    if (!sess || this.promptReq) return;
    const before = this.input.slice(0, this.cursor);
    const after = this.input.slice(this.cursor);
    const m = /(\S*)$/.exec(before)!;
    const cur = m[1];
    const head = before.slice(0, before.length - cur.length);
    const words = head.trim() ? head.trim().split(/\s+/) : [];
    const segStart = Math.max(head.lastIndexOf('|'), head.lastIndexOf('&&'), head.lastIndexOf(';'));
    const cmdWords = segStart >= 0 ? head.slice(segStart + 1).trim().split(/\s+/).filter(Boolean) : words;
    let candidates: string[] = [];
    let isPath = false;
    if (cmdWords.length === 0 && !cur.includes('/')) {
      candidates = [...new Set([...Object.keys(sess.commands), ...BUILTINS, ...Object.keys(sess.functions), ...Object.keys(sess.aliases)])];
    } else if (cmdWords[0] === 'az') {
      const tokens = cmdWords.slice(1).filter((w) => !w.startsWith('-'));
      const path = tokens.join(' ');
      if (cur.startsWith('-')) {
        const cmd = allAzCommands().find((c) => c.path === path);
        candidates = [...(cmd?.args.flatMap((a) => a.opts.filter((o) => o.startsWith('--'))) ?? []), '--output', '--query', '--help', '--subscription', '--only-show-errors'];
      } else if (!cmdWords.slice(1).some((w) => w.startsWith('-'))) {
        const names = new Set<string>();
        const prefix = path ? path + ' ' : '';
        for (const g of azGroups().keys()) if (g.startsWith(prefix)) names.add(g.slice(prefix.length).split(' ')[0]);
        for (const c of allAzCommands()) if (c.path.startsWith(prefix)) names.add(c.path.slice(prefix.length).split(' ')[0]);
        candidates = [...names].filter(Boolean);
      }
    } else if ((cmdWords[0] === 'kubectl' || cmdWords[0] === 'k') && cmdWords.length === 1) candidates = KUBECTL_SUB;
    else if (cmdWords[0] === 'git' && cmdWords.length === 1) candidates = GIT_SUB;
    else if (cmdWords[0] === 'docker' && cmdWords.length === 1) candidates = DOCKER_SUB;
    else if ((cmdWords[0] === 'terraform' || cmdWords[0] === 'tf') && cmdWords.length === 1) candidates = TF_SUB;
    if (!candidates.length) {
      isPath = true;
      const slash = cur.lastIndexOf('/');
      const dirPart = slash >= 0 ? cur.slice(0, slash + 1) : '';
      const base = slash >= 0 ? cur.slice(slash + 1) : cur;
      const abs = sess.resolve(dirPart || '.');
      try {
        candidates = sess.fs
          .list(abs)
          .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
          .map((e) => dirPart + e.name + (e.node.t === 'd' ? '/' : ''));
      } catch {
        candidates = [];
      }
    }
    const matches = candidates.filter((c) => c.startsWith(cur)).sort();
    if (!matches.length) return;
    if (matches.length === 1) {
      const m0 = matches[0];
      const add = isPath && m0.endsWith('/') ? '' : ' ';
      this.setInput(head + m0 + add + after, (head + m0 + add).length);
      return;
    }
    let common = matches[0];
    for (const x of matches) while (!x.startsWith(common)) common = common.slice(0, -1);
    if (common.length > cur.length) {
      this.setInput(head + common + after, (head + common).length);
      return;
    }
    const shown = matches.map((x) => (isPath ? x.slice(x.lastIndexOf('/', x.length - 2) + 1) : x));
    this.write(`${this.promptText()}${this.input}\r\n${columns(shown)}\r\n`);
  }

  upload(name: string, content: string) {
    const sess = this.stack[0];
    if (!sess) return;
    const path = `${sess.home}/${name}`;
    sess.fs.writeFile(path, content);
    this.write(`\r\n\x1b[32mFichero subido: ${path}\x1b[0m\r\n`);
  }
}

function columns(items: string[]): string {
  const w = Math.max(...items.map((x) => x.length)) + 2;
  const per = Math.max(1, Math.floor(100 / w));
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per).map((x) => x.padEnd(w)).join('').trimEnd());
  return rows.join('\r\n');
}

/** Abre una URL: rutas internas (#/...), Azure DevOps y el portal se navegan; el resto se abre en el navegador simulado. */
export function openUrl(url: string) {
  if (url.startsWith('#')) {
    navigate(url);
    return;
  }
  const ado = /^https?:\/\/dev\.azure\.com\/[^/]+\/?([^?#]*)/i.exec(url);
  if (ado) {
    const rest = ado[1]
      .split('/')
      .filter(Boolean)
      .map((x) => decodeURIComponent(x));
    navigate(rest.length ? `/devops/${encodeURIComponent(rest[0])}` : '/devops');
    return;
  }
  if (/^https?:\/\/portal\.azure\.com/i.test(url)) {
    navigate('/');
    return;
  }
  setUi((u) => ({ browser: { url, history: [...(u.browser?.history ?? []), url] } }));
}

export const terminal = new TerminalController();
