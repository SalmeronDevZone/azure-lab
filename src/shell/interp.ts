// Intérprete de bash simulado.
import { parseScript, IncompleteInput, ParseError, type AndOr, type Command, type List, type Redirect, type SimpleCmd, type Word } from './parser';
import { VFS, FsError } from './fs';
import type { PrincipalRef } from '../engine/types';
import { closest } from '../engine/util';

export class ExitSignal {
  constructor(public code: number) {}
}
class ReturnSignal {
  constructor(public code: number) {}
}
class BreakSignal {
  constructor(public n: number) {}
}
class ContinueSignal {
  constructor(public n: number) {}
}

export interface ShellIO {
  stdin: string | null;
  out(s: string): void;
  err(s: string): void;
  isTTY: boolean;
  prompt?(q: string, opts?: { secret?: boolean }): Promise<string>;
  signal: AbortSignal;
}

export interface CmdCtx {
  sess: Session;
  io: ShellIO;
}

export type CommandFn = (argv: string[], ctx: CmdCtx) => Promise<number> | number;

export interface CommandDef {
  fn: CommandFn;
  summary?: string;
}

export interface SessionUI {
  clear?(): void;
  openEditor?(path: string): void;
  openUrl?(url: string): void;
  enterSession?(child: Session, banner?: string): void;
  exitSession?(): void;
}

export interface AzState {
  loggedIn: boolean;
  principal: PrincipalRef | null;
  subscriptionId: string;
  defaults: Record<string, string>;
  acrLogins: string[];
  dockerLogins: string[];
  persist(): void;
}

export interface SessionOpts {
  kind: 'cloudshell' | 'agent' | 'vm';
  fs: VFS;
  home: string;
  user: string;
  host: string;
  cwd?: string;
  env?: Record<string, string>;
  commands: Record<string, CommandDef>;
  ui?: SessionUI;
  az: AzState;
  onCommand?(e: { cmd: string; argv: string[]; ok: boolean; code: number }): void;
  vmId?: string;
  isRoot?: boolean;
  history?: string[];
}

const SH_BUILTINS = new Set([
  'cd', 'pwd', 'export', 'unset', 'set', 'source', '.', 'exit', 'return', 'break', 'continue', 'shift', 'local', 'read', 'eval', 'alias', 'unalias',
  'type', 'command', 'exec', '[[', '[', 'test', '((', 'let', 'declare', 'typeset', 'readonly', 'true', 'false', ':', 'trap', 'wait', 'umask', 'history', 'hash', 'bash', 'sh', 'time',
]);

export class Session {
  kind: SessionOpts['kind'];
  fs: VFS;
  home: string;
  user: string;
  host: string;
  cwd: string;
  oldCwd: string;
  env: Record<string, string>;
  exported = new Set<string>();
  arrays: Record<string, string[]> = {};
  functions: Record<string, Command> = {};
  aliases: Record<string, string> = {};
  positional: string[] = [];
  lastExit = 0;
  opts = { errexit: false, xtrace: false, nounset: false, pipefail: false };
  commands: Record<string, CommandDef>;
  ui: SessionUI;
  az: AzState;
  onCommand?: SessionOpts['onCommand'];
  vmId?: string;
  isRoot: boolean;
  history: string[];
  startTime = Date.now();
  scriptName = 'bash';
  private condDepth = 0;
  private funcDepth = 0;
  private loopDepth = 0;

  constructor(o: SessionOpts) {
    this.kind = o.kind;
    this.fs = o.fs;
    this.home = o.home;
    this.user = o.user;
    this.host = o.host;
    this.cwd = o.cwd ?? o.home;
    this.oldCwd = this.cwd;
    this.commands = o.commands;
    this.ui = o.ui ?? {};
    this.az = o.az;
    this.onCommand = o.onCommand;
    this.vmId = o.vmId;
    this.isRoot = !!o.isRoot;
    this.history = o.history ?? [];
    this.env = {
      HOME: o.home,
      USER: o.user,
      LOGNAME: o.user,
      SHELL: '/bin/bash',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      HOSTNAME: o.host,
      ...(o.env ?? {}),
    };
    Object.keys(this.env).forEach((k) => this.exported.add(k));
  }

  resolve(path: string): string {
    return this.fs.normalize(this.cwd, path, this.home);
  }

  displayCwd(): string {
    if (this.cwd === this.home) return '~';
    if (this.cwd.startsWith(this.home + '/')) return '~' + this.cwd.slice(this.home.length);
    return this.cwd;
  }

  prompt(): string {
    if (this.kind === 'cloudshell') return `\x1b[32;1m${this.user}@Azure\x1b[0m:\x1b[34;1m${this.displayCwd()}\x1b[0m$ `;
    const sym = this.isRoot ? '#' : '$';
    return `\x1b[32;1m${this.isRoot ? 'root' : this.user}@${this.host}\x1b[0m:\x1b[34;1m${this.displayCwd()}\x1b[0m${sym} `;
  }

  /** Copia para subshell / script. */
  subshell(exportedOnly = false): Session {
    const s = new Session({ kind: this.kind, fs: this.fs, home: this.home, user: this.user, host: this.host, cwd: this.cwd, commands: this.commands, ui: this.ui, az: this.az, onCommand: this.onCommand, vmId: this.vmId, isRoot: this.isRoot, history: this.history });
    s.env = {};
    s.exported = new Set();
    for (const [k, v] of Object.entries(this.env)) {
      if (exportedOnly && !this.exported.has(k)) continue;
      s.env[k] = v;
      if (this.exported.has(k)) s.exported.add(k);
    }
    if (!exportedOnly) {
      s.functions = { ...this.functions };
      s.arrays = JSON.parse(JSON.stringify(this.arrays));
      s.aliases = { ...this.aliases };
    }
    s.opts = { ...this.opts };
    s.positional = [...this.positional];
    s.lastExit = this.lastExit;
    return s;
  }

  async run(script: string, io: ShellIO): Promise<number> {
    let list: List;
    try {
      list = parseScript(script);
    } catch (e) {
      if (e instanceof IncompleteInput) {
        io.err(`bash: syntax error: unexpected end of file\n`);
        return 2;
      }
      if (e instanceof ParseError) {
        io.err(e.message + '\n');
        return 2;
      }
      throw e;
    }
    try {
      this.lastExit = await this.execList(list, io);
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.lastExit = e.code;
        throw e;
      }
      if (e instanceof ReturnSignal) this.lastExit = e.code;
      else if (e instanceof BreakSignal || e instanceof ContinueSignal) {
        /* fuera de bucle: se ignora */
      } else if ((e as Error)?.message === 'aborted') {
        io.err('^C\n');
        this.lastExit = 130;
      } else throw e;
    }
    return this.lastExit;
  }

  /** Ejecuta un script capturando stdout. */
  async capture(script: string, io: ShellIO, sub = true): Promise<{ out: string; code: number }> {
    let buf = '';
    const cio: ShellIO = { ...io, stdin: null, out: (s) => (buf += s), isTTY: false };
    const target = sub ? this.subshell() : this;
    let code: number;
    try {
      code = await target.run(script, cio);
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code;
      else throw e;
    }
    this.lastExit = code;
    return { out: buf, code };
  }

  // ---------------------------------------------------------------- ejecución

  async execList(list: List, io: ShellIO): Promise<number> {
    let code = 0;
    for (const ao of list) {
      if (io.signal.aborted) throw new Error('aborted');
      code = await this.execAndOr(ao, io);
      this.lastExit = code;
    }
    return code;
  }

  async execAndOr(ao: AndOr, io: ShellIO): Promise<number> {
    const isChain = ao.rest.length > 0;
    if (isChain) this.condDepth++;
    let code: number;
    try {
      code = await this.execPipeline(ao.first, io, isChain);
      for (let k = 0; k < ao.rest.length; k++) {
        const r = ao.rest[k];
        const last = k === ao.rest.length - 1;
        if ((r.op === '&&' && code === 0) || (r.op === '||' && code !== 0)) {
          if (last) this.condDepth--;
          try {
            code = await this.execPipeline(r.p, io, !last);
          } finally {
            if (last) this.condDepth++;
          }
        }
      }
    } finally {
      if (isChain) this.condDepth--;
    }
    this.lastExit = code;
    if (code !== 0 && this.opts.errexit && this.condDepth === 0 && !isChain) throw new ExitSignal(code);
    return code;
  }

  async execPipeline(p: { cmds: Command[]; negate: boolean }, io: ShellIO, inCond: boolean): Promise<number> {
    if (p.negate) this.condDepth++;
    let code = 0;
    try {
      if (p.cmds.length === 1) code = await this.execCommand(p.cmds[0], io);
      else {
        let input = io.stdin;
        const codes: number[] = [];
        for (let k = 0; k < p.cmds.length; k++) {
          const last = k === p.cmds.length - 1;
          let buf = '';
          const pio: ShellIO = { ...io, stdin: input ?? '', out: last ? io.out : (s) => (buf += s), isTTY: last ? io.isTTY : false };
          this.condDepth++;
          try {
            codes.push(await this.execCommand(p.cmds[k], pio));
          } catch (e) {
            if (e instanceof ExitSignal) codes.push(e.code);
            else throw e;
          } finally {
            this.condDepth--;
          }
          input = buf;
        }
        code = this.opts.pipefail ? codes.reverse().find((c) => c !== 0) ?? 0 : codes[codes.length - 1];
      }
    } finally {
      if (p.negate) this.condDepth--;
    }
    if (p.negate) code = code === 0 ? 1 : 0;
    void inCond;
    return code;
  }

  async execCommand(cmd: Command, io: ShellIO): Promise<number> {
    switch (cmd.k) {
      case 'simple':
        return this.execSimple(cmd, io);
      case 'func':
        this.functions[cmd.name] = cmd.body;
        return 0;
      case 'group':
        return this.withRedirects(cmd.redirects, io, (rio) => this.execList(cmd.body, rio));
      case 'subshell':
        return this.withRedirects(cmd.redirects, io, async (rio) => {
          const sub = this.subshell();
          try {
            return await sub.execList(cmd.body, rio);
          } catch (e) {
            if (e instanceof ExitSignal) return e.code;
            throw e;
          }
        });
      case 'if':
        return this.withRedirects(cmd.redirects, io, async (rio) => {
          for (const cl of cmd.clauses) {
            this.condDepth++;
            let c: number;
            try {
              c = await this.execList(cl.cond, rio);
            } finally {
              this.condDepth--;
            }
            if (c === 0) return this.execList(cl.body, rio);
          }
          return cmd.elseBody ? this.execList(cmd.elseBody, rio) : 0;
        });
      case 'for':
        return this.withRedirects(cmd.redirects, io, async (rio) => {
          const items = cmd.items ? await this.expandWords(cmd.items, rio) : [...this.positional];
          let code = 0;
          this.loopDepth++;
          try {
            for (const it of items) {
              if (rio.signal.aborted) throw new Error('aborted');
              this.setVar(cmd.v, it);
              try {
                code = await this.execList(cmd.body, rio);
              } catch (e) {
                if (e instanceof BreakSignal) {
                  if (e.n > 1) throw new BreakSignal(e.n - 1);
                  break;
                }
                if (e instanceof ContinueSignal) {
                  if (e.n > 1) throw new ContinueSignal(e.n - 1);
                  continue;
                }
                throw e;
              }
            }
          } finally {
            this.loopDepth--;
          }
          return code;
        });
      case 'while':
      case 'until':
        return this.withRedirects(cmd.redirects, io, async (rio) => {
          let code = 0;
          let guard = 0;
          this.loopDepth++;
          try {
            for (;;) {
              if (rio.signal.aborted) throw new Error('aborted');
              if (++guard > 10000) {
                rio.err('bash: bucle detenido por el simulador tras 10000 iteraciones\n');
                break;
              }
              this.condDepth++;
              let c: number;
              try {
                c = await this.execList(cmd.cond, rio);
              } finally {
                this.condDepth--;
              }
              if ((cmd.k === 'while' && c !== 0) || (cmd.k === 'until' && c === 0)) break;
              try {
                code = await this.execList(cmd.body, rio);
              } catch (e) {
                if (e instanceof BreakSignal) {
                  if (e.n > 1) throw new BreakSignal(e.n - 1);
                  break;
                }
                if (e instanceof ContinueSignal) {
                  if (e.n > 1) throw new ContinueSignal(e.n - 1);
                  continue;
                }
                throw e;
              }
              await new Promise((r) => setTimeout(r, 0));
            }
          } finally {
            this.loopDepth--;
          }
          return code;
        });
      case 'case':
        return this.withRedirects(cmd.redirects, io, async (rio) => {
          const w = await this.expandWordStr(cmd.word, rio);
          for (const it of cmd.items) {
            for (const pw of it.patterns) {
              const pat = await this.expandWordStr(pw, rio);
              if (globToRegex(pat).test(w)) return this.execList(it.body, rio);
            }
          }
          return 0;
        });
    }
  }

  // ---------------------------------------------------------------- redirecciones

  async withRedirects(redirects: Redirect[], io: ShellIO, fn: (io: ShellIO) => Promise<number>): Promise<number> {
    if (!redirects.length) return fn(io);
    let outSink: (s: string) => void = io.out;
    let errSink: (s: string) => void = io.err;
    let stdin = io.stdin;
    let isTTY = io.isTTY;
    const files: { path: string; append: boolean; buf: string[] }[] = [];
    const fileSink = (path: string, append: boolean) => {
      if (path === '/dev/null') return () => undefined;
      if (path === '/dev/stdout') return io.out;
      if (path === '/dev/stderr') return io.err;
      const abs = this.resolve(path);
      if (this.fs.isDir(abs)) throw new Error(`bash: ${path}: Is a directory`);
      const parent = abs.split('/').slice(0, -1).join('/') || '/';
      if (!this.fs.isDir(parent)) throw new Error(`bash: ${path}: No such file or directory`);
      let f = files.find((x) => x.path === abs);
      if (!f) {
        f = { path: abs, append, buf: [] };
        files.push(f);
        if (!append) this.fs.writeFile(abs, '');
      }
      const ff = f;
      return (s: string) => ff.buf.push(s);
    };
    try {
      for (const r of redirects) {
        if (r.op === '>&') {
          if (r.fd === 2 && r.dupFd === 1) errSink = outSink;
          else if (r.fd === 1 && r.dupFd === 2) outSink = errSink;
          continue;
        }
        if (r.op === '<<') {
          stdin = r.heredoc!.expand ? await this.expandHeredoc(r.heredoc!.body, io) : r.heredoc!.body;
          continue;
        }
        const target = await this.expandWordStr(r.target ?? [], io);
        if (r.op === '<<<') {
          stdin = target + '\n';
          continue;
        }
        if (r.op === '<') {
          const abs = this.resolve(target);
          try {
            stdin = this.fs.readFile(abs);
          } catch (e) {
            io.err(`bash: ${target}: ${e instanceof FsError ? e.message : 'error'}\n`);
            return 1;
          }
          continue;
        }
        const sink = fileSink(target, r.op === '>>');
        if (r.fd === -1) {
          outSink = sink;
          errSink = sink;
        } else if (r.fd === 2) errSink = sink;
        else outSink = sink;
        if (r.fd !== 2) isTTY = false;
      }
    } catch (e) {
      io.err(((e as Error).message ?? String(e)) + '\n');
      return 1;
    }
    try {
      return await fn({ ...io, out: outSink, err: errSink, stdin, isTTY });
    } finally {
      for (const f of files) if (f.buf.length) this.fs.writeFile(f.path, f.buf.join(''), true);
    }
  }

  async expandHeredoc(body: string, io: ShellIO): Promise<string> {
    const { parseInnerWord } = await import('./parser');
    const w = parseInnerWord(body.replace(/"/g, '\\"'));
    return (await this.expandWord(w, io, false))[0] ?? '';
  }

  // ---------------------------------------------------------------- comandos simples

  async execSimple(cmd: SimpleCmd, io: ShellIO): Promise<number> {
    let argv = await this.expandWords(cmd.words, io);
    if (argv.length && this.aliases[argv[0]] && cmd.words[0].every((p) => p.t === 'lit' && p.q === 0)) {
      argv = [...this.aliases[argv[0]].split(/\s+/).filter(Boolean), ...argv.slice(1)];
    }
    const assigns: [string, string, boolean][] = [];
    for (const a of cmd.assigns) {
      if (a.array) {
        const vals = await this.expandWords(a.array, io);
        this.arrays[a.name] = a.append ? [...(this.arrays[a.name] ?? []), ...vals] : vals;
        continue;
      }
      assigns.push([a.name, await this.expandWordStr(a.value, io), a.append]);
    }
    if (!argv.length) {
      for (const [k, v, app] of assigns) this.setVar(k, app ? (this.env[k] ?? '') + v : v);
      if (cmd.redirects.length) return this.withRedirects(cmd.redirects, io, async () => 0);
      return this.lastExit === undefined ? 0 : 0;
    }
    const saved: [string, string | undefined, boolean][] = [];
    for (const [k, v] of assigns) {
      saved.push([k, this.env[k], this.exported.has(k)]);
      this.env[k] = v;
      this.exported.add(k);
    }
    try {
      return await this.withRedirects(cmd.redirects, io, async (rio) => {
        if (this.opts.xtrace) rio.err(`+ ${argv.map(shQuote).join(' ')}\n`);
        const code = await this.dispatch(argv, rio);
        return code;
      });
    } finally {
      for (const [k, v, exp] of saved) {
        if (v === undefined) delete this.env[k];
        else this.env[k] = v;
        if (!exp) this.exported.delete(k);
      }
    }
  }

  async dispatch(argv: string[], io: ShellIO): Promise<number> {
    const name = argv[0];
    const fn = this.functions[name];
    if (fn) {
      const savedPos = this.positional;
      this.positional = argv.slice(1);
      this.funcDepth++;
      try {
        return await this.execCommand(fn, io);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.code;
        throw e;
      } finally {
        this.funcDepth--;
        this.positional = savedPos;
      }
    }
    if (SH_BUILTINS.has(name)) return this.builtin(argv, io);
    if (name.includes('/')) return this.runScriptFile(argv, io, false);
    const def = this.commands[name];
    if (def) {
      let code: number;
      try {
        code = await def.fn(argv, { sess: this, io });
      } catch (e) {
        if (e instanceof ExitSignal || e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) throw e;
        if ((e as Error)?.message === 'aborted') throw e;
        io.err(`${name}: ${(e as Error)?.message ?? e}\n`);
        console.error(e);
        code = 1;
      }
      this.onCommand?.({ cmd: argv.map(shQuote).join(' '), argv, ok: code === 0, code });
      return code;
    }
    const suggestion = closest(name, [...Object.keys(this.commands), ...SH_BUILTINS], 2);
    io.err(`bash: ${name}: command not found\n`);
    if (suggestion && suggestion !== name) io.err(`\x1b[2m¿Querías decir "${suggestion}"?\x1b[0m\n`);
    this.onCommand?.({ cmd: argv.map(shQuote).join(' '), argv, ok: false, code: 127 });
    return 127;
  }

  async runScriptFile(argv: string[], io: ShellIO, viaInterpreter: boolean, inCurrent = false): Promise<number> {
    const path = argv[0];
    const abs = this.resolve(path);
    let src: string;
    try {
      src = this.fs.readFile(abs);
    } catch (e) {
      io.err(`bash: ${path}: ${e instanceof FsError ? e.message : 'error'}\n`);
      return 127;
    }
    const node = this.fs.getNode(abs);
    if (!viaInterpreter && node?.t === 'f' && !node.x) {
      io.err(`bash: ${path}: Permission denied\n\x1b[2m(Dale permisos de ejecución con "chmod +x ${path}" o ejecútalo con "bash ${path}")\x1b[0m\n`);
      return 126;
    }
    const target = inCurrent ? this : this.subshell(true);
    const savedPos = target.positional;
    const savedName = target.scriptName;
    target.positional = argv.slice(1);
    target.scriptName = path;
    try {
      return await target.run(src.replace(/^#!.*\n/, ''), io);
    } catch (e) {
      if (e instanceof ExitSignal) return e.code;
      throw e;
    } finally {
      if (inCurrent) {
        target.positional = savedPos;
        target.scriptName = savedName;
      }
    }
  }

  // ---------------------------------------------------------------- variables

  setVar(name: string, value: string) {
    if (['PWD'].includes(name)) return;
    this.env[name] = value;
  }

  getVar(name: string): string | undefined {
    switch (name) {
      case '?':
        return String(this.lastExit);
      case '$':
        return '4242';
      case '#':
        return String(this.positional.length);
      case '@':
      case '*':
        return this.positional.join(' ');
      case '0':
        return this.scriptName;
      case '!':
        return '4243';
      case '-':
        return 'hB';
      case 'RANDOM':
        return String(Math.floor(Math.random() * 32768));
      case 'PWD':
        return this.cwd;
      case 'OLDPWD':
        return this.oldCwd;
      case 'SECONDS':
        return String(Math.floor((Date.now() - this.startTime) / 1000));
      case 'UID':
        return this.isRoot ? '0' : '1000';
    }
    if (/^\d+$/.test(name)) return this.positional[Number(name) - 1];
    const am = /^(\w+)\[(.+)\]$/.exec(name);
    if (am) {
      const arr = this.arrays[am[1]];
      if (!arr) return am[2] === '0' ? this.env[am[1]] : undefined;
      if (am[2] === '@' || am[2] === '*') return arr.join(' ');
      return arr[Number(this.arith(am[2]))];
    }
    if (this.arrays[name]) return this.arrays[name][0];
    return this.env[name];
  }

  async expandParam(part: Extract<import('./parser').WordPart, { t: 'var' }>, io: ShellIO): Promise<string> {
    const name = part.name;
    let v = this.getVar(name);
    const arg = async () => (part.arg ? (await this.expandWord(part.arg, io, false))[0] ?? '' : '');
    switch (part.op) {
      case undefined:
        if (v === undefined && this.opts.nounset && !/^[?$#@*0!-]$/.test(name)) {
          io.err(`bash: ${name}: unbound variable\n`);
          throw new ExitSignal(1);
        }
        return v ?? '';
      case '#len': {
        const am = /^(\w+)\[[@*]\]$/.exec(name);
        if (am) return String(this.arrays[am[1]]?.length ?? 0);
        return String((v ?? '').length);
      }
      case 'indirect':
        return this.getVar(v ?? '') ?? '';
      case ':-':
        return v ? v : arg();
      case '-':
        return v !== undefined ? v : arg();
      case ':=':
        if (!v) {
          v = await arg();
          this.setVar(name, v);
        }
        return v;
      case '=':
        if (v === undefined) {
          v = await arg();
          this.setVar(name, v);
        }
        return v;
      case ':+':
        return v ? arg() : '';
      case '+':
        return v !== undefined ? arg() : '';
      case ':?':
      case '?':
        if (!v) {
          const msg = await arg();
          io.err(`bash: ${name}: ${msg || 'parameter null or not set'}\n`);
          throw new ExitSignal(1);
        }
        return v;
      case '%':
      case '%%': {
        const pat = globToRegexBody(await arg());
        const re = new RegExp(part.op === '%' ? `^(.*?)(?:${pat})$` : `^(.*?)(?:${pat})$`, 's');
        if (part.op === '%') {
          // sufijo más corto
          const s = v ?? '';
          for (let k = s.length; k >= 0; k--) if (new RegExp(`^(?:${pat})$`, 's').test(s.slice(k))) return s.slice(0, k);
          return s;
        }
        const m = re.exec(v ?? '');
        if (!m) return v ?? '';
        const s = v ?? '';
        for (let k = 0; k <= s.length; k++) if (new RegExp(`^(?:${pat})$`, 's').test(s.slice(k))) return s.slice(0, k);
        return s;
      }
      case '#':
      case '##': {
        const pat = globToRegexBody(await arg());
        const s = v ?? '';
        if (part.op === '#') {
          for (let k = 0; k <= s.length; k++) if (new RegExp(`^(?:${pat})$`, 's').test(s.slice(0, k))) return s.slice(k);
        } else {
          for (let k = s.length; k >= 0; k--) if (new RegExp(`^(?:${pat})$`, 's').test(s.slice(0, k))) return s.slice(k);
        }
        return s;
      }
      case '/':
      case '//': {
        const pat = globToRegexBody(await arg());
        const rep = part.arg2 ? (await this.expandWord(part.arg2, io, false))[0] ?? '' : '';
        return (v ?? '').replace(new RegExp(pat, part.op === '//' ? 'g' : ''), () => rep);
      }
      case ',,':
        return (v ?? '').toLowerCase();
      case '^^':
        return (v ?? '').toUpperCase();
      case ',':
        return (v ?? '').charAt(0).toLowerCase() + (v ?? '').slice(1);
      case '^':
        return (v ?? '').charAt(0).toUpperCase() + (v ?? '').slice(1);
      case 'substr': {
        const off = Number(this.arith(await arg()));
        const len = part.arg2 ? Number(this.arith((await this.expandWord(part.arg2, io, false))[0] ?? '0')) : undefined;
        const s = v ?? '';
        const start = off < 0 ? Math.max(0, s.length + off) : off;
        return len === undefined ? s.slice(start) : s.substr(start, len);
      }
    }
    return v ?? '';
  }

  // ---------------------------------------------------------------- expansión

  async expandWords(words: Word[], io: ShellIO): Promise<string[]> {
    const out: string[] = [];
    for (const w of words) out.push(...(await this.expandWord(w, io, true)));
    return out;
  }

  async expandWordStr(w: Word, io: ShellIO): Promise<string> {
    return (await this.expandWord(w, io, false)).join(' ');
  }

  async expandWord(w: Word, io: ShellIO, split: boolean): Promise<string[]> {
    if (w.length === 1 && w[0].t === 'var' && w[0].q === 2 && (w[0].name === '@' || /^\w+\[@\]$/.test(w[0].name)) && !w[0].op) {
      if (w[0].name === '@') return [...this.positional];
      const arr = this.arrays[w[0].name.split('[')[0]];
      return arr ? [...arr] : [];
    }
    const fields: { s: string; quoted: boolean; glob: boolean }[] = [];
    let cur = { s: '', quoted: false, glob: false, started: false };
    const pushCur = () => {
      if (cur.started) fields.push({ s: cur.s, quoted: cur.quoted, glob: cur.glob });
      cur = { s: '', quoted: false, glob: false, started: false };
    };
    for (const part of w) {
      if (part.t === 'lit') {
        cur.s += part.v;
        cur.started = true;
        if (part.q === 0) {
          if (/[*?[]/.test(part.v)) cur.glob = true;
        } else cur.quoted = true;
        continue;
      }
      if (part.t === 'tilde') {
        cur.s += part.user ? (part.user === 'root' ? '/root' : `/home/${part.user}`) : this.env.HOME ?? this.home;
        cur.started = true;
        continue;
      }
      let value: string;
      if (part.t === 'var') value = await this.expandParam(part, io);
      else if (part.t === 'cmd') {
        const r = await this.capture(part.src, io);
        value = r.out.replace(/\n+$/, '');
      } else value = String(this.arith(await this.expandArithText(part.src, io)));
      if (part.q === 2 || !split) {
        cur.s += value;
        cur.quoted = true;
        cur.started = true;
        continue;
      }
      if (value === '') continue;
      const segs = value.split(/[ \t\n]+/);
      if (/^[ \t\n]/.test(value) && cur.started) pushCur();
      const pieces = segs.filter((x, i) => x !== '' || (i > 0 && i < segs.length - 1));
      pieces.forEach((seg, i) => {
        if (i > 0) pushCur();
        cur.s += seg;
        cur.started = true;
        if (/[*?[]/.test(seg)) cur.glob = true;
      });
      if (/[ \t\n]$/.test(value)) pushCur();
    }
    pushCur();
    const out: string[] = [];
    for (const f of fields) {
      if (f.glob && !f.quoted && split) {
        const matches = this.fs.glob(this.cwd, f.s, this.home);
        if (matches.length) {
          const rel = !f.s.startsWith('/') && !f.s.startsWith('~');
          out.push(...matches.map((m) => (rel ? relPath(this.cwd, m) : m)));
          continue;
        }
      }
      out.push(f.s);
    }
    return out;
  }

  async expandArithText(src: string, io: ShellIO): Promise<string> {
    const { parseInnerWord } = await import('./parser');
    return (await this.expandWord(parseInnerWord(src.replace(/"/g, '\\"')), io, false))[0] ?? '';
  }

  /** Evaluador aritmético (( )). */
  arith(expr: string): number {
    const toks = expr.match(/\d+|[A-Za-z_]\w*|\*\*|\+\+|--|[=!<>]=|&&|\|\||[-+*/%()<>!=,?:]|\+=|-=|\*=|\/=/g) ?? [];
    let i = 0;
    const self = this;
    const val = (name: string) => Number(self.getVar(name) ?? 0) || 0;
    function primary(): number {
      const t = toks[i++];
      if (t === undefined) return 0;
      if (t === '(') {
        const v = ternary();
        i++;
        return v;
      }
      if (t === '-') return -primary();
      if (t === '+') return primary();
      if (t === '!') return primary() ? 0 : 1;
      if (t === '++' || t === '--') {
        const n = toks[i++];
        const v = val(n) + (t === '++' ? 1 : -1);
        self.setVar(n, String(v));
        return v;
      }
      if (/^\d+$/.test(t)) return Number(t);
      if (/^[A-Za-z_]/.test(t)) {
        const nx = toks[i];
        if (nx === '++' || nx === '--') {
          i++;
          const v = val(t);
          self.setVar(t, String(v + (nx === '++' ? 1 : -1)));
          return v;
        }
        if (nx === '=' || nx === '+=' || nx === '-=' || nx === '*=' || nx === '/=') {
          i++;
          const r = ternary();
          const cur = val(t);
          const v = nx === '=' ? r : nx === '+=' ? cur + r : nx === '-=' ? cur - r : nx === '*=' ? cur * r : Math.trunc(cur / r);
          self.setVar(t, String(v));
          return v;
        }
        return val(t);
      }
      return 0;
    }
    function pow(): number {
      const a = primary();
      if (toks[i] === '**') {
        i++;
        return a ** pow();
      }
      return a;
    }
    function mul(): number {
      let a = pow();
      while (['*', '/', '%'].includes(toks[i])) {
        const op = toks[i++];
        const b = pow();
        a = op === '*' ? a * b : op === '/' ? Math.trunc(a / b) : a % b;
      }
      return a;
    }
    function add(): number {
      let a = mul();
      while (toks[i] === '+' || toks[i] === '-') {
        const op = toks[i++];
        const b = mul();
        a = op === '+' ? a + b : a - b;
      }
      return a;
    }
    function rel(): number {
      let a = add();
      while (['<', '>', '<=', '>='].includes(toks[i])) {
        const op = toks[i++];
        const b = add();
        a = Number(op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b);
      }
      return a;
    }
    function eq(): number {
      let a = rel();
      while (toks[i] === '==' || toks[i] === '!=') {
        const op = toks[i++];
        const b = rel();
        a = Number(op === '==' ? a === b : a !== b);
      }
      return a;
    }
    function and(): number {
      let a = eq();
      while (toks[i] === '&&') {
        i++;
        const b = eq();
        a = Number(!!a && !!b);
      }
      return a;
    }
    function or(): number {
      let a = and();
      while (toks[i] === '||') {
        i++;
        const b = and();
        a = Number(!!a || !!b);
      }
      return a;
    }
    function ternary(): number {
      const c = or();
      if (toks[i] === '?') {
        i++;
        const a = ternary();
        i++;
        const b = ternary();
        return c ? a : b;
      }
      return c;
    }
    let r = 0;
    while (i < toks.length) {
      r = ternary();
      if (toks[i] === ',') i++;
      else break;
    }
    return r;
  }

  // ---------------------------------------------------------------- builtins de shell

  evalTest(args: string[], extended: boolean): boolean {
    let i = 0;
    const self = this;
    const fileTest = (op: string, p: string) => {
      const abs = self.resolve(p);
      const n = self.fs.getNode(abs);
      switch (op) {
        case '-e':
        case '-a':
          return !!n;
        case '-f':
          return n?.t === 'f';
        case '-d':
          return n?.t === 'd';
        case '-s':
          return n?.t === 'f' && n.d.length > 0;
        case '-r':
        case '-w':
          return !!n;
        case '-x':
          return n?.t === 'd' || (n?.t === 'f' && !!n.x);
      }
      return false;
    };
    function primary(): boolean {
      const t = args[i];
      if (t === '!') {
        i++;
        return !primary();
      }
      if (t === '(') {
        i++;
        const v = or();
        i++;
        return v;
      }
      if (['-z', '-n', '-e', '-f', '-d', '-s', '-r', '-w', '-x', '-v', '-a'].includes(t) && i + 1 < args.length && !['=', '==', '!=', '-eq', '-ne', '-lt', '-gt', '-le', '-ge', '=~'].includes(args[i + 1])) {
        i += 2;
        const v = args[i - 1];
        if (t === '-z') return v === '';
        if (t === '-n') return v !== '';
        if (t === '-v') return self.env[v] !== undefined;
        return fileTest(t, v);
      }
      const a = args[i++] ?? '';
      const op = args[i];
      if (['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-gt', '-le', '-ge', '=~'].includes(op)) {
        i++;
        const b = args[i++] ?? '';
        switch (op) {
          case '=':
          case '==':
            return extended ? globToRegex(b).test(a) : a === b;
          case '!=':
            return extended ? !globToRegex(b).test(a) : a !== b;
          case '<':
            return a < b;
          case '>':
            return a > b;
          case '=~': {
            try {
              const m = new RegExp(b).exec(a);
              if (m) self.arrays.BASH_REMATCH = [...m].map((x) => x ?? '');
              return !!m;
            } catch {
              return false;
            }
          }
          case '-eq':
            return Number(a) === Number(b);
          case '-ne':
            return Number(a) !== Number(b);
          case '-lt':
            return Number(a) < Number(b);
          case '-gt':
            return Number(a) > Number(b);
          case '-le':
            return Number(a) <= Number(b);
          case '-ge':
            return Number(a) >= Number(b);
        }
      }
      return a !== '';
    }
    function and(): boolean {
      let v = primary();
      while (args[i] === '&&' || args[i] === '-a') {
        i++;
        const b = primary();
        v = v && b;
      }
      return v;
    }
    function or(): boolean {
      let v = and();
      while (args[i] === '||' || args[i] === '-o') {
        i++;
        const b = and();
        v = v || b;
      }
      return v;
    }
    if (!args.length) return false;
    return or();
  }

  async builtin(argv: string[], io: ShellIO): Promise<number> {
    const [name, ...args] = argv;
    switch (name) {
      case 'true':
      case ':':
      case 'trap':
      case 'wait':
      case 'umask':
      case 'hash':
        return 0;
      case 'false':
        return 1;
      case 'cd': {
        let target = args[0] ?? this.env.HOME ?? this.home;
        if (target === '-') {
          target = this.oldCwd;
          io.out(target + '\n');
        }
        const abs = this.resolve(target);
        if (!this.fs.exists(abs)) {
          io.err(`bash: cd: ${args[0]}: No such file or directory\n`);
          return 1;
        }
        if (!this.fs.isDir(abs)) {
          io.err(`bash: cd: ${args[0]}: Not a directory\n`);
          return 1;
        }
        this.oldCwd = this.cwd;
        this.cwd = abs;
        this.env.PWD = abs;
        return 0;
      }
      case 'pwd':
        io.out(this.cwd + '\n');
        return 0;
      case 'export': {
        if (!args.length || args[0] === '-p') {
          for (const k of [...this.exported].sort()) io.out(`declare -x ${k}="${this.env[k] ?? ''}"\n`);
          return 0;
        }
        for (const a of args) {
          if (a === '-n') continue;
          const eq = a.indexOf('=');
          if (eq > 0) {
            this.env[a.slice(0, eq)] = a.slice(eq + 1);
            this.exported.add(a.slice(0, eq));
          } else this.exported.add(a);
        }
        return 0;
      }
      case 'readonly':
      case 'declare':
      case 'typeset':
      case 'local': {
        for (const a of args) {
          if (a.startsWith('-')) continue;
          const eq = a.indexOf('=');
          if (eq > 0) this.env[a.slice(0, eq)] = a.slice(eq + 1);
          else if (this.env[a] === undefined) this.env[a] = '';
          if (args.includes('-x')) this.exported.add(eq > 0 ? a.slice(0, eq) : a);
        }
        if (!args.filter((a) => !a.startsWith('-')).length && name === 'declare') for (const [k, v] of Object.entries(this.env).sort()) io.out(`${k}=${shQuote(v)}\n`);
        return 0;
      }
      case 'unset':
        for (const a of args) {
          if (a.startsWith('-')) continue;
          delete this.env[a];
          delete this.arrays[a];
          delete this.functions[a];
          this.exported.delete(a);
        }
        return 0;
      case 'set': {
        if (!args.length) {
          for (const [k, v] of Object.entries(this.env).sort()) io.out(`${k}=${shQuote(v)}\n`);
          return 0;
        }
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '--') {
            this.positional = args.slice(i + 1);
            break;
          }
          const on = a.startsWith('-');
          if (a === '-o' || a === '+o') {
            const opt = args[++i];
            if (opt === 'pipefail') this.opts.pipefail = on;
            if (opt === 'errexit') this.opts.errexit = on;
            if (opt === 'xtrace') this.opts.xtrace = on;
            if (opt === 'nounset') this.opts.nounset = on;
            continue;
          }
          if (/^[-+][euxo]+$/.test(a)) {
            for (const ch of a.slice(1)) {
              if (ch === 'e') this.opts.errexit = on;
              if (ch === 'x') this.opts.xtrace = on;
              if (ch === 'u') this.opts.nounset = on;
            }
            continue;
          }
          this.positional = args.slice(i);
          break;
        }
        return 0;
      }
      case 'shift': {
        const n = Number(args[0] ?? 1);
        this.positional = this.positional.slice(n);
        return 0;
      }
      case 'exit':
        throw new ExitSignal(args[0] !== undefined ? Number(args[0]) & 255 : this.lastExit);
      case 'return':
        if (!this.funcDepth) {
          io.err('bash: return: can only `return\' from a function or sourced script\n');
          return 1;
        }
        throw new ReturnSignal(args[0] !== undefined ? Number(args[0]) : this.lastExit);
      case 'break':
        if (!this.loopDepth) return 0;
        throw new BreakSignal(Number(args[0] ?? 1));
      case 'continue':
        if (!this.loopDepth) return 0;
        throw new ContinueSignal(Number(args[0] ?? 1));
      case 'source':
      case '.': {
        if (!args[0]) {
          io.err(`bash: ${name}: filename argument required\n`);
          return 2;
        }
        return this.runScriptFile(args, io, true, true);
      }
      case 'bash':
      case 'sh': {
        if (args[0] === '-c') return this.subshell().run(args[1] ?? '', io).catch((e) => (e instanceof ExitSignal ? e.code : Promise.reject(e)));
        if ((!args.length || args[0] === '-s' || args[0] === '-') && io.stdin !== null) {
          return this.subshell(true).run(io.stdin, { ...io, stdin: null }).catch((e) => (e instanceof ExitSignal ? e.code : Promise.reject(e)));
        }
        if (!args.length || args[0] === '-l' || args[0] === '-i') {
          io.out('\x1b[2m(Ya estás en una sesión de bash.)\x1b[0m\n');
          return 0;
        }
        const flags = args.filter((a) => /^-[ex]+$/.test(a));
        const rest = args.filter((a) => !/^-[ex]+$/.test(a));
        const sub = this.subshell(true);
        if (flags.some((f) => f.includes('x'))) sub.opts.xtrace = true;
        if (flags.some((f) => f.includes('e'))) sub.opts.errexit = true;
        return sub.runScriptFile(rest, io, true, true);
      }
      case 'eval':
        return this.run(args.join(' '), io);
      case 'exec':
        return args.length ? this.dispatch(args, io) : 0;
      case 'time': {
        const t0 = Date.now();
        const code = args.length ? await this.dispatch(args, io) : 0;
        const secs = ((Date.now() - t0) / 1000).toFixed(3);
        io.err(`\nreal\t0m${secs}s\nuser\t0m0.012s\nsys\t0m0.004s\n`);
        return code;
      }
      case 'read': {
        let prompt = '';
        let secret = false;
        const vars: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-p') prompt = args[++i] ?? '';
          else if (args[i] === '-s') secret = true;
          else if (args[i] === '-r' || args[i] === '-e') continue;
          else vars.push(args[i]);
        }
        let line: string | null = null;
        if (io.stdin !== null && io.stdin !== undefined) {
          const idx = io.stdin.indexOf('\n');
          if (io.stdin === '') line = null;
          else {
            line = idx >= 0 ? io.stdin.slice(0, idx) : io.stdin;
            io.stdin = idx >= 0 ? io.stdin.slice(idx + 1) : '';
          }
        } else if (io.prompt) line = await io.prompt(prompt, { secret });
        if (line === null) return 1;
        const names = vars.length ? vars : ['REPLY'];
        const parts = line.trim().split(/\s+/);
        names.forEach((n, i) => this.setVar(n, i === names.length - 1 ? parts.slice(i).join(' ') : parts[i] ?? ''));
        if (secret && io.isTTY) io.out('\n');
        return 0;
      }
      case 'alias': {
        if (!args.length) {
          for (const [k, v] of Object.entries(this.aliases)) io.out(`alias ${k}='${v}'\n`);
          return 0;
        }
        for (const a of args) {
          const eq = a.indexOf('=');
          if (eq > 0) this.aliases[a.slice(0, eq)] = a.slice(eq + 1);
          else if (this.aliases[a]) io.out(`alias ${a}='${this.aliases[a]}'\n`);
          else {
            io.err(`bash: alias: ${a}: not found\n`);
            return 1;
          }
        }
        return 0;
      }
      case 'unalias':
        for (const a of args) delete this.aliases[a];
        return 0;
      case 'type':
      case 'command': {
        const list = name === 'command' ? args.filter((a) => a !== '-v' && a !== '-V') : args;
        if (name === 'command' && !args.includes('-v') && !args.includes('-V')) return list.length ? this.dispatch(list, io) : 0;
        let code = 0;
        for (const a of list) {
          if (this.aliases[a]) io.out(name === 'type' ? `${a} is aliased to \`${this.aliases[a]}'\n` : `alias ${a}='${this.aliases[a]}'\n`);
          else if (this.functions[a]) io.out(name === 'type' ? `${a} is a function\n` : `${a}\n`);
          else if (SH_BUILTINS.has(a)) io.out(name === 'type' ? `${a} is a shell builtin\n` : `${a}\n`);
          else if (this.commands[a]) io.out(name === 'type' ? `${a} is /usr/bin/${a}\n` : `/usr/bin/${a}\n`);
          else {
            if (name === 'type') io.err(`bash: type: ${a}: not found\n`);
            code = 1;
          }
        }
        return code;
      }
      case 'test':
        return this.evalTest(args, false) ? 0 : 1;
      case '[': {
        if (args[args.length - 1] !== ']') {
          io.err("bash: [: missing `]'\n");
          return 2;
        }
        return this.evalTest(args.slice(0, -1), false) ? 0 : 1;
      }
      case '[[': {
        if (args[args.length - 1] !== ']]') {
          io.err("bash: syntax error: missing `]]'\n");
          return 2;
        }
        return this.evalTest(args.slice(0, -1), true) ? 0 : 1;
      }
      case '((':
      case 'let': {
        const expr = name === '((' ? await this.expandArithText(args[0] ?? '', io) : args.join(' ');
        return this.arith(expr) !== 0 ? 0 : 1;
      }
      case 'history': {
        if (args[0] === '-c') {
          this.history.length = 0;
          return 0;
        }
        const n = args[0] ? Number(args[0]) : this.history.length;
        const start = Math.max(0, this.history.length - n);
        this.history.slice(start).forEach((h, i) => io.out(`${String(start + i + 1).padStart(5)}  ${h}\n`));
        return 0;
      }
    }
    return 0;
  }
}

export function shQuote(s: string): string {
  if (s === '') return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function globToRegexBody(pat: string): string {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      const end = pat.indexOf(']', i + 1);
      if (end > 0) {
        out += '[' + pat.slice(i + 1, end).replace(/^!/, '^') + ']';
        i = end;
      } else out += '\\[';
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return out;
}

export function globToRegex(pat: string): RegExp {
  return new RegExp('^' + globToRegexBody(pat) + '$', 's');
}

export function relPath(cwd: string, abs: string): string {
  if (abs.startsWith(cwd === '/' ? '/' : cwd + '/')) return abs.slice(cwd === '/' ? 1 : cwd.length + 1);
  return abs;
}

export function isIncomplete(script: string): boolean {
  try {
    parseScript(script);
    return false;
  } catch (e) {
    return e instanceof IncompleteInput;
  }
}
