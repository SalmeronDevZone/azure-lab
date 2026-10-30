// Utilidades compartidas por los comandos del shell.
import type { CmdCtx, ShellIO } from '../interp';
import { FsError } from '../fs';

export const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  boldBlue: (s: string) => `\x1b[34;1m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[32;1m${s}\x1b[0m`,
};

export function println(io: ShellIO, s = '') {
  io.out(s + '\n');
}

export function eprintln(io: ShellIO, s = '') {
  io.err(s + '\n');
}

export function hint(io: ShellIO, s: string) {
  if (io.isTTY || true) io.err(C.dim(`💡 ${s}`) + '\n');
}

export interface ParsedFlags {
  flags: Set<string>;
  opts: Record<string, string>;
  rest: string[];
}

/**
 * Parser sencillo de opciones estilo GNU. `withValue` lista las opciones que reciben valor.
 * Agrupa banderas cortas (-la) y soporta --opcion=valor.
 */
export function parseFlags(args: string[], withValue: string[] = []): ParsedFlags {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) opts[name] = a.slice(eq + 1);
      else if (withValue.includes(name)) opts[name] = args[++i] ?? '';
      else flags.add(name);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      const chars = a.slice(1);
      for (let k = 0; k < chars.length; k++) {
        const ch = chars[k];
        if (withValue.includes(ch)) {
          const v = chars.slice(k + 1);
          opts[ch] = v || args[++i] || '';
          break;
        }
        flags.add(ch);
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, opts, rest };
}

export function readInput(ctx: CmdCtx, files: string[], cmd: string): { name: string; text: string }[] | null {
  if (!files.length || (files.length === 1 && files[0] === '-')) return [{ name: '(standard input)', text: ctx.io.stdin ?? '' }];
  const out: { name: string; text: string }[] = [];
  let ok = true;
  for (const f of files) {
    try {
      out.push({ name: f, text: ctx.sess.fs.readFile(ctx.sess.resolve(f)) });
    } catch (e) {
      eprintln(ctx.io, `${cmd}: ${f}: ${e instanceof FsError ? e.message : 'error'}`);
      ok = false;
    }
  }
  return ok || out.length ? out : null;
}

export function lines(text: string): string[] {
  if (!text) return [];
  const l = text.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

export async function delay(ms: number, io: ShellIO) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    io.signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

export function table(rows: string[][], gap = 2): string {
  if (!rows.length) return '';
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(w[i] - c.replace(/\x1b\[[0-9;]*m/g, '').length + gap))).join('')).join('\n');
}

export function strftime(fmt: string, d: Date, utc = false): string {
  const get = (m: string) => (utc ? (d as any)['getUTC' + m]() : (d as any)['get' + m]());
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return fmt.replace(/%([a-zA-Z%])/g, (_, c) => {
    switch (c) {
      case 'Y':
        return String(get('FullYear'));
      case 'm':
        return p(get('Month') + 1);
      case 'd':
        return p(get('Date'));
      case 'H':
        return p(get('Hours'));
      case 'M':
        return p(get('Minutes'));
      case 'S':
        return p(get('Seconds'));
      case 's':
        return String(Math.floor(d.getTime() / 1000));
      case 'a':
        return days[get('Day')];
      case 'b':
        return months[get('Month')];
      case 'y':
        return p(get('FullYear') % 100);
      case 'j':
        return p(Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000), 3);
      case 'Z':
        return utc ? 'UTC' : 'CET';
      case 'z':
        return utc ? '+0000' : '+0100';
      case 'F':
        return `${get('FullYear')}-${p(get('Month') + 1)}-${p(get('Date'))}`;
      case 'T':
        return `${p(get('Hours'))}:${p(get('Minutes'))}:${p(get('Seconds'))}`;
      case 'N':
        return p(d.getMilliseconds() * 1000000, 9);
      case '%':
        return '%';
    }
    return '%' + c;
  });
}

export function fmtSize(n: number, human: boolean): string {
  if (!human) return String(n);
  if (n < 1024) return String(n);
  if (n < 1024 ** 2) return (n / 1024).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + 'G';
}
