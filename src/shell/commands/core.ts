// Comandos de ficheros y texto (coreutils, grep, sed, awk...).
import type { CommandDef, CmdCtx } from '../interp';
import { FsError, isBinary } from '../fs';
import { C, eprintln, fmtSize, lines, parseFlags, println, readInput, strftime, delay } from './util';
import { relPath } from '../interp';
import { speedFactor } from '../../engine/store';

function err(ctx: CmdCtx, cmd: string, path: string, e: unknown) {
  eprintln(ctx.io, `${cmd}: ${path ? `cannot access '${path}': ` : ''}${e instanceof FsError ? e.message : (e as Error)?.message ?? e}`);
}

const echo: CommandDef = {
  summary: 'Muestra texto',
  fn(argv, { io }) {
    let args = argv.slice(1);
    let newline = true;
    let escapes = false;
    while (args.length && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes('n')) newline = false;
      if (args[0].includes('e')) escapes = true;
      args = args.slice(1);
    }
    let s = args.join(' ');
    if (escapes) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\e/g, '\x1b').replace(/\\033/g, '\x1b').replace(/\\\\/g, '\\');
    io.out(s + (newline ? '\n' : ''));
    return 0;
  },
};

const printf: CommandDef = {
  summary: 'Imprime con formato',
  fn(argv, { io }) {
    const fmt = (argv[1] ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    let args = argv.slice(2);
    let out = '';
    do {
      let used = 0;
      out += fmt.replace(/%(-?\d*)(\.\d+)?([sdfx%])/g, (_, w, prec, c) => {
        if (c === '%') return '%';
        const v = args[used++] ?? '';
        let s = c === 'd' ? String(Math.trunc(Number(v) || 0)) : c === 'f' ? (Number(v) || 0).toFixed(prec ? Number(prec.slice(1)) : 6) : c === 'x' ? (Number(v) || 0).toString(16) : v;
        const width = Number(w.replace('-', '')) || 0;
        if (width) s = w.startsWith('-') ? s.padEnd(width) : s.padStart(width);
        return s;
      });
      args = args.slice(used || args.length);
      if (!used) break;
    } while (args.length);
    io.out(out);
    return 0;
  },
};

const ls: CommandDef = {
  summary: 'Lista ficheros',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const all = flags.has('a') || flags.has('A');
    const long = flags.has('l');
    const human = flags.has('h');
    const one = flags.has('1') || !ctx.io.isTTY;
    const recursive = flags.has('R');
    const targets = rest.length ? rest : ['.'];
    let code = 0;
    const colorName = (name: string, node: any) => (node.t === 'd' ? C.boldBlue(name) : node.x ? C.boldGreen(name) : /\.(zip|tar\.gz|tgz)$/.test(name) ? `\x1b[31;1m${name}\x1b[0m` : name);
    const show = (abs: string, label: string | null) => {
      const node = ctx.sess.fs.getNode(abs);
      if (!node) {
        eprintln(ctx.io, `ls: cannot access '${label}': No such file or directory`);
        code = 2;
        return;
      }
      if (label !== null && (targets.length > 1 || recursive) && node.t === 'd') println(ctx.io, `${label}:`);
      let entries = node.t === 'd' ? ctx.sess.fs.list(abs) : [{ name: label ?? abs.split('/').pop()!, node }];
      if (!all) entries = entries.filter((e) => !e.name.startsWith('.'));
      if (flags.has('t')) entries.sort((a, b) => b.node.mt - a.node.mt);
      if (flags.has('a') && node.t === 'd') entries = [{ name: '.', node }, { name: '..', node }, ...entries];
      if (long) {
        if (node.t === 'd') println(ctx.io, `total ${entries.length * 4}`);
        for (const e of entries) {
          const size = e.node.t === 'd' ? 4096 : new TextEncoder().encode(e.node.d).length;
          const perm = e.node.t === 'd' ? 'drwxr-xr-x' : e.node.x ? '-rwxr-xr-x' : '-rw-r--r--';
          const d = new Date(e.node.mt);
          println(ctx.io, `${perm} 1 ${ctx.sess.user} ${ctx.sess.user} ${fmtSize(size, human).padStart(human ? 5 : 6)} ${strftime('%b %d %H:%M', d)} ${colorName(e.name, e.node)}`);
        }
      } else if (entries.length) {
        if (one) entries.forEach((e) => println(ctx.io, ctx.io.isTTY ? colorName(e.name, e.node) : e.name));
        else println(ctx.io, entries.map((e) => colorName(e.name, e.node)).join('  '));
      }
      if (recursive && node.t === 'd') {
        for (const e of entries.filter((x) => x.node.t === 'd' && x.name !== '.' && x.name !== '..')) {
          println(ctx.io);
          show(`${abs === '/' ? '' : abs}/${e.name}`, `${label ?? '.'}/${e.name}`);
        }
      }
    };
    targets.forEach((t, i) => {
      if (i > 0 && targets.length > 1) println(ctx.io);
      show(ctx.sess.resolve(t), targets.length > 1 || recursive ? t : t === '.' ? null : t);
    });
    return code;
  },
};

const cat: CommandDef = {
  summary: 'Muestra el contenido de ficheros',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const inputs = readInput(ctx, rest, 'cat');
    if (!inputs) return 1;
    let n = 1;
    for (const inp of inputs) {
      if (isBinary(inp.text)) {
        ctx.io.out(inp.text.slice(0, 4).replace(/[^\x20-\x7e]/g, '?') + '\u0000\u0000...\n');
        continue;
      }
      if (flags.has('n')) {
        ctx.io.out(lines(inp.text).map((l) => `${String(n++).padStart(6)}\t${l}`).join('\n') + '\n');
      } else ctx.io.out(inp.text);
    }
    return inputs.length === rest.length || !rest.length ? 0 : 1;
  },
};

const mkdir: CommandDef = {
  summary: 'Crea directorios',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    let code = 0;
    if (!rest.length) {
      eprintln(ctx.io, 'mkdir: missing operand');
      return 1;
    }
    for (const d of rest) {
      try {
        ctx.sess.fs.mkdir(ctx.sess.resolve(d), flags.has('p'));
      } catch (e) {
        eprintln(ctx.io, `mkdir: cannot create directory '${d}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

const rmdir: CommandDef = {
  fn(argv, ctx) {
    let code = 0;
    for (const d of argv.slice(1)) {
      try {
        ctx.sess.fs.rmdir(ctx.sess.resolve(d));
      } catch (e) {
        eprintln(ctx.io, `rmdir: failed to remove '${d}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

const rm: CommandDef = {
  summary: 'Elimina ficheros o directorios',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const rec = flags.has('r') || flags.has('R') || flags.has('recursive');
    const force = flags.has('f') || flags.has('force');
    let code = 0;
    if (!rest.length && !force) {
      eprintln(ctx.io, 'rm: missing operand');
      return 1;
    }
    for (const p of rest) {
      const abs = ctx.sess.resolve(p);
      if (abs === '/' || abs === ctx.sess.home) {
        eprintln(ctx.io, `rm: refusing to remove '${p}' (el simulador protege este directorio)`);
        code = 1;
        continue;
      }
      try {
        if (!ctx.sess.fs.exists(abs)) {
          if (!force) {
            eprintln(ctx.io, `rm: cannot remove '${p}': No such file or directory`);
            code = 1;
          }
          continue;
        }
        if (ctx.sess.fs.isDir(abs) && !rec) {
          eprintln(ctx.io, `rm: cannot remove '${p}': Is a directory`);
          code = 1;
          continue;
        }
        ctx.sess.fs.rm(abs, rec);
      } catch (e) {
        eprintln(ctx.io, `rm: cannot remove '${p}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

const touch: CommandDef = {
  summary: 'Crea un fichero vacío o actualiza su fecha',
  fn(argv, ctx) {
    let code = 0;
    for (const p of argv.slice(1).filter((a) => !a.startsWith('-'))) {
      const abs = ctx.sess.resolve(p);
      try {
        if (ctx.sess.fs.isFile(abs)) ctx.sess.fs.writeFile(abs, ctx.sess.fs.readFile(abs));
        else if (!ctx.sess.fs.exists(abs)) ctx.sess.fs.writeFile(abs, '');
      } catch (e) {
        eprintln(ctx.io, `touch: cannot touch '${p}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

const cp: CommandDef = {
  summary: 'Copia ficheros',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    if (rest.length < 2) {
      eprintln(ctx.io, `cp: missing destination file operand after '${rest[0] ?? ''}'`);
      return 1;
    }
    const dst = ctx.sess.resolve(rest[rest.length - 1]);
    let code = 0;
    for (const s of rest.slice(0, -1)) {
      try {
        ctx.sess.fs.copy(ctx.sess.resolve(s), dst, flags.has('r') || flags.has('R') || flags.has('a'));
      } catch (e) {
        if (e instanceof FsError && e.code === 'EISDIR') eprintln(ctx.io, `cp: -r not specified; omitting directory '${s}'`);
        else eprintln(ctx.io, `cp: cannot stat '${s}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

const mv: CommandDef = {
  summary: 'Mueve o renombra ficheros',
  fn(argv, ctx) {
    const { rest } = parseFlags(argv.slice(1));
    if (rest.length < 2) {
      eprintln(ctx.io, `mv: missing destination file operand after '${rest[0] ?? ''}'`);
      return 1;
    }
    const dst = ctx.sess.resolve(rest[rest.length - 1]);
    let code = 0;
    for (const s of rest.slice(0, -1)) {
      try {
        ctx.sess.fs.move(ctx.sess.resolve(s), dst);
      } catch (e) {
        eprintln(ctx.io, `mv: cannot move '${s}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

function headTail(which: 'head' | 'tail'): CommandDef {
  return {
    summary: which === 'head' ? 'Primeras líneas' : 'Últimas líneas',
    async fn(argv, ctx) {
      const args = argv.slice(1).map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
      const { flags, opts, rest } = parseFlags(args, ['n', 'c']);
      const n = Number(opts.n ?? 10);
      const inputs = readInput(ctx, rest, which);
      if (!inputs) return 1;
      for (const inp of inputs) {
        if (inputs.length > 1) println(ctx.io, `==> ${inp.name} <==`);
        const l = lines(inp.text);
        const sel = which === 'head' ? l.slice(0, n) : String(opts.n ?? '').startsWith('+') ? l.slice(Number(opts.n.slice(1)) - 1) : l.slice(Math.max(0, l.length - n));
        if (sel.length) ctx.io.out(sel.join('\n') + '\n');
      }
      if (which === 'tail' && flags.has('f')) {
        println(ctx.io, C.dim('(tail -f: esperando nuevas líneas, pulsa Ctrl+C para salir)'));
        for (;;) await delay(1000, ctx.io);
      }
      return 0;
    },
  };
}

const wc: CommandDef = {
  summary: 'Cuenta líneas, palabras y bytes',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const inputs = readInput(ctx, rest, 'wc');
    if (!inputs) return 1;
    for (const inp of inputs) {
      const l = (inp.text.match(/\n/g) ?? []).length;
      const w = inp.text.split(/\s+/).filter(Boolean).length;
      const c = new TextEncoder().encode(inp.text).length;
      const parts: string[] = [];
      const none = !flags.has('l') && !flags.has('w') && !flags.has('c') && !flags.has('m');
      if (flags.has('l') || none) parts.push(String(l));
      if (flags.has('w') || none) parts.push(String(w));
      if (flags.has('c') || flags.has('m') || none) parts.push(String(c));
      println(ctx.io, (parts.length > 1 ? parts.map((p) => p.padStart(7)).join(' ') : parts[0]) + (rest.length ? ` ${inp.name}` : ''));
    }
    return 0;
  },
};

const grep: CommandDef = {
  summary: 'Busca patrones en texto',
  fn(argv, ctx) {
    const { flags, opts, rest } = parseFlags(argv.slice(1), ['e', 'm', 'A', 'B', 'C']);
    let pattern = opts.e ?? rest.shift();
    if (pattern === undefined) {
      eprintln(ctx.io, 'Usage: grep [OPTION]... PATTERNS [FILE]...');
      return 2;
    }
    if (flags.has('F')) pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (!flags.has('E') && !flags.has('P')) pattern = pattern.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
    if (flags.has('w')) pattern = `\\b(?:${pattern})\\b`;
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags.has('i') ? 'i' : '');
    } catch {
      eprintln(ctx.io, `grep: Invalid regular expression`);
      return 2;
    }
    let files = rest;
    if (flags.has('r') || flags.has('R')) {
      const roots = files.length ? files : ['.'];
      files = [];
      for (const r of roots) {
        const abs = ctx.sess.resolve(r);
        if (ctx.sess.fs.isDir(abs)) for (const rel of Object.keys(ctx.sess.fs.snapshot(abs))) files.push(`${r === '.' ? '' : r.replace(/\/$/, '') + '/'}${rel}`);
        else files.push(r);
      }
    }
    const inputs = readInput(ctx, files, 'grep');
    if (!inputs) return 2;
    const multi = inputs.length > 1;
    let matched = 0;
    for (const inp of inputs) {
      let count = 0;
      const l = lines(inp.text);
      for (let i = 0; i < l.length; i++) {
        const hit = re.test(l[i]);
        if (hit === flags.has('v')) continue;
        count++;
        matched++;
        if (flags.has('q')) return 0;
        if (flags.has('l') || flags.has('c')) continue;
        const prefix = (multi ? C.magenta(inp.name) + C.cyan(':') : '') + (flags.has('n') ? C.green(String(i + 1)) + C.cyan(':') : '');
        if (flags.has('o') && !flags.has('v')) {
          const g = new RegExp(re.source, re.flags + 'g');
          for (const m of l[i].match(g) ?? []) println(ctx.io, prefix + (ctx.io.isTTY ? C.red(m) : m));
        } else println(ctx.io, prefix + (ctx.io.isTTY && !flags.has('v') ? l[i].replace(new RegExp(re.source, re.flags + 'g'), (m) => `\x1b[31;1m${m}\x1b[0m`) : l[i]));
        if (opts.m && count >= Number(opts.m)) break;
      }
      if (flags.has('l') && count) println(ctx.io, inp.name);
      if (flags.has('c')) println(ctx.io, (multi ? inp.name + ':' : '') + count);
    }
    return matched ? 0 : 1;
  },
};

const sort: CommandDef = {
  summary: 'Ordena líneas',
  fn(argv, ctx) {
    const { flags, opts, rest } = parseFlags(argv.slice(1), ['k', 't']);
    const inputs = readInput(ctx, rest, 'sort');
    if (!inputs) return 1;
    let l = inputs.flatMap((i) => lines(i.text));
    const key = (s: string) => {
      if (!opts.k) return s;
      const col = Number(opts.k.split(',')[0]) - 1;
      return (opts.t ? s.split(opts.t) : s.trim().split(/\s+/))[col] ?? '';
    };
    l.sort((a, b) => (flags.has('n') ? Number(key(a)) - Number(key(b)) : key(a).localeCompare(key(b))));
    if (flags.has('r')) l.reverse();
    if (flags.has('u')) l = [...new Set(l)];
    if (l.length) ctx.io.out(l.join('\n') + '\n');
    return 0;
  },
};

const uniq: CommandDef = {
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const inputs = readInput(ctx, rest, 'uniq');
    if (!inputs) return 1;
    const l = inputs.flatMap((i) => lines(i.text));
    const out: [string, number][] = [];
    for (const x of l) {
      if (out.length && out[out.length - 1][0] === x) out[out.length - 1][1]++;
      else out.push([x, 1]);
    }
    for (const [x, n] of out) {
      if (flags.has('d') && n < 2) continue;
      println(ctx.io, flags.has('c') ? `${String(n).padStart(7)} ${x}` : x);
    }
    return 0;
  },
};

const cut: CommandDef = {
  fn(argv, ctx) {
    const { opts, rest } = parseFlags(argv.slice(1), ['d', 'f', 'c']);
    const inputs = readInput(ctx, rest, 'cut');
    if (!inputs) return 1;
    const sel = (spec: string, len: number) => {
      const idx: number[] = [];
      for (const part of spec.split(',')) {
        const [a, b] = part.split('-');
        const from = a ? Number(a) : 1;
        const to = part.includes('-') ? (b ? Number(b) : len) : from;
        for (let i = from; i <= to; i++) idx.push(i - 1);
      }
      return idx;
    };
    for (const l of inputs.flatMap((i) => lines(i.text))) {
      if (opts.c) println(ctx.io, sel(opts.c, l.length).map((i) => l[i] ?? '').join(''));
      else {
        const d = opts.d ?? '\t';
        const parts = l.split(d);
        println(ctx.io, sel(opts.f ?? '1', parts.length).map((i) => parts[i]).filter((x) => x !== undefined).join(d));
      }
    }
    return 0;
  },
};

const tr: CommandDef = {
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const expand = (s: string) =>
      s
        .replace(/\[:upper:\]/g, 'A-Z')
        .replace(/\[:lower:\]/g, 'a-z')
        .replace(/\[:digit:\]/g, '0-9')
        .replace(/\[:space:\]/g, ' \t\n')
        .replace(/\\n/g, '\n')
        .replace(/(.)-(.)/g, (_, a, b) => {
          let o = '';
          for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) o += String.fromCharCode(c);
          return o;
        });
    const a = expand(rest[0] ?? '');
    const b = expand(rest[1] ?? '');
    let s = ctx.io.stdin ?? '';
    if (flags.has('d')) s = [...s].filter((ch) => !a.includes(ch)).join('');
    else s = [...s].map((ch) => (a.includes(ch) ? b[Math.min(a.indexOf(ch), b.length - 1)] ?? '' : ch)).join('');
    if (flags.has('s')) s = s.replace(new RegExp(`([${(b || a).replace(/[\]\\^-]/g, '\\$&')}])\\1+`, 'g'), '$1');
    ctx.io.out(s);
    return 0;
  },
};

function sedScript(script: string): ((line: string, n: number, total: number) => { out: string | null; print?: boolean })[] {
  const cmds: ((line: string, n: number, total: number) => { out: string | null; print?: boolean })[] = [];
  for (const raw of script.split(/;(?![^/]*\/[gIi]*$)|\n/).map((x) => x.trim()).filter(Boolean)) {
    let addr: ((l: string, n: number, total: number) => boolean) | null = null;
    let cmd = raw;
    const am = /^(\d+|\$)(?:,(\d+|\$))?/.exec(cmd) ?? /^\/((?:\\.|[^/])*)\//.exec(cmd);
    if (am) {
      if (am[0].startsWith('/')) {
        const re = new RegExp(am[1]);
        addr = (l) => re.test(l);
      } else {
        const a = am[1];
        const b = am[2];
        addr = (_l, n, total) => {
          const from = a === '$' ? total : Number(a);
          const to = b === undefined ? from : b === '$' ? total : Number(b);
          return n >= from && n <= to;
        };
      }
      cmd = cmd.slice(am[0].length).trim();
    }
    if (cmd.startsWith('s')) {
      const delim = cmd[1];
      const parts: string[] = [];
      let cur = '';
      for (let i = 2; i < cmd.length; i++) {
        if (cmd[i] === '\\' && cmd[i + 1] === delim) {
          cur += delim;
          i++;
          continue;
        }
        if (cmd[i] === delim) {
          parts.push(cur);
          cur = '';
          continue;
        }
        cur += cmd[i];
      }
      parts.push(cur);
      const [pat, rep, fl] = parts;
      const re = new RegExp(pat.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\+/g, '+'), (fl?.includes('g') ? 'g' : '') + (fl?.includes('I') || fl?.includes('i') ? 'i' : ''));
      const jsRep = rep.replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&');
      cmds.push((l, n, total) => (!addr || addr(l, n, total) ? { out: l.replace(re, jsRep), print: fl?.includes('p') } : { out: l }));
    } else if (cmd === 'd') cmds.push((l, n, total) => (!addr || addr(l, n, total) ? { out: null } : { out: l }));
    else if (cmd === 'p') cmds.push((l, n, total) => ({ out: l, print: !addr || addr(l, n, total) }));
    else throw new Error(`sed: -e expression #1, char 1: unknown command: \`${cmd[0]}'`);
  }
  return cmds;
}

const sed: CommandDef = {
  summary: 'Editor de flujo (s///, d, p)',
  fn(argv, ctx) {
    const args = argv.slice(1);
    const scripts: string[] = [];
    const files: string[] = [];
    let inPlace = false;
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-e') scripts.push(args[++i]);
      else if (a === '-i' || a.startsWith('-i')) inPlace = true;
      else if (a === '-n') quiet = true;
      else if (a === '-E' || a === '-r') continue;
      else if (!scripts.length && !a.startsWith('-')) scripts.push(a);
      else files.push(a);
    }
    let cmds: ReturnType<typeof sedScript>;
    try {
      cmds = sedScript(scripts.join('\n'));
    } catch (e) {
      eprintln(ctx.io, (e as Error).message);
      return 1;
    }
    const inputs = readInput(ctx, files, 'sed');
    if (!inputs) return 2;
    for (const inp of inputs) {
      const l = lines(inp.text);
      const out: string[] = [];
      l.forEach((line, idx) => {
        let cur: string | null = line;
        const extra: string[] = [];
        for (const c of cmds) {
          if (cur === null) break;
          const r = c(cur, idx + 1, l.length);
          cur = r.out;
          if (r.print && r.out !== null) extra.push(r.out);
        }
        out.push(...extra);
        if (cur !== null && !quiet) out.push(cur);
      });
      const text = out.length ? out.join('\n') + '\n' : '';
      if (inPlace && files.length) ctx.sess.fs.writeFile(ctx.sess.resolve(inp.name), text);
      else ctx.io.out(text);
    }
    return 0;
  },
};

/** awk mínimo: patrones simples, print, printf, acumuladores y END. */
const awk: CommandDef = {
  summary: 'Procesa texto por columnas',
  fn(argv, ctx) {
    const args = argv.slice(1);
    let fs: string | null = null;
    const vars: Record<string, any> = {};
    let prog: string | null = null;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-F') fs = args[++i];
      else if (a.startsWith('-F')) fs = a.slice(2);
      else if (a === '-v') {
        const [k, v] = args[++i].split('=');
        vars[k] = v;
      } else if (prog === null) prog = a;
      else files.push(a);
    }
    if (prog === null) {
      eprintln(ctx.io, "usage: awk [-F fs][-v var=value]['prog' | -f progfile][file ...]");
      return 2;
    }
    if (fs === '\\t') fs = '\t';
    const blocks: { pat: string; act: string }[] = [];
    const re = /\s*(BEGIN|END|\/(?:\\.|[^/])*\/|[^{]*?)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(prog))) {
      blocks.push({ pat: m[1].trim(), act: m[2].trim() });
      consumed = re.lastIndex;
    }
    if (!blocks.length || prog.slice(consumed).trim()) blocks.push({ pat: prog.slice(consumed).trim() || prog.trim(), act: 'print' });
    const inputs = readInput(ctx, files, 'awk');
    if (!inputs) return 2;
    let NR = 0;
    let fields: string[] = [];
    let line = '';
    const val = (expr: string): any => {
      const e = expr.trim();
      if (!e) return '';
      if (/^".*"$/.test(e)) return e.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
      if (e === 'NR') return NR;
      if (e === 'NF') return fields.length;
      if (e === '$0') return line;
      if (e === '$NF') return fields[fields.length - 1] ?? '';
      const fm = /^\$(\d+)$/.exec(e);
      if (fm) return Number(fm[1]) === 0 ? line : fields[Number(fm[1]) - 1] ?? '';
      const fm2 = /^\$\((.+)\)$/.exec(e);
      if (fm2) return fields[Number(val(fm2[1])) - 1] ?? '';
      const ar = /^(.+?)\s*([+\-*/])\s*(.+)$/.exec(e);
      if (ar && !/^".*"$/.test(e)) {
        const a = Number(val(ar[1]));
        const b = Number(val(ar[3]));
        return ar[2] === '+' ? a + b : ar[2] === '-' ? a - b : ar[2] === '*' ? a * b : a / b;
      }
      const fn = /^(toupper|tolower|length)\((.*)\)$/.exec(e);
      if (fn) {
        const v = String(val(fn[2] || '$0'));
        return fn[1] === 'toupper' ? v.toUpperCase() : fn[1] === 'tolower' ? v.toLowerCase() : v.length;
      }
      return vars[e] ?? '';
    };
    const concat = (expr: string): string => {
      const toks = expr.match(/"(?:\\.|[^"])*"|\$\([^)]*\)|\$\w+|[A-Za-z_]\w*\([^)]*\)|[^\s"]+/g) ?? [];
      return toks.map((t) => String(val(t))).join('');
    };
    const splitArgs = (s: string) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (const ch of s) {
        if (ch === '"') q = !q;
        if (ch === ',' && !q) {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      if (cur.trim()) out.push(cur);
      return out;
    };
    const cond = (pat: string): boolean => {
      if (!pat) return true;
      if (pat.startsWith('/') && pat.endsWith('/')) return new RegExp(pat.slice(1, -1)).test(line);
      const cm = /^(.+?)\s*(==|!=|>=|<=|>|<|~)\s*(.+)$/.exec(pat);
      if (cm) {
        const a = val(cm[1]);
        const bRaw = cm[3].trim();
        if (cm[2] === '~') return new RegExp(bRaw.replace(/^\/|\/$/g, '')).test(String(a));
        const b = val(bRaw);
        const [x, y] = typeof a === 'number' || typeof b === 'number' ? [Number(a), Number(b)] : [String(a), String(b)];
        return cm[2] === '==' ? x === y : cm[2] === '!=' ? x !== y : cm[2] === '>' ? x > y : cm[2] === '<' ? x < y : cm[2] === '>=' ? x >= y : x <= y;
      }
      return !!val(pat);
    };
    const run = (act: string) => {
      for (const stmt of act.split(/;|\n/).map((x) => x.trim()).filter(Boolean)) {
        let mm: RegExpExecArray | null;
        if (stmt === 'print') println(ctx.io, line);
        else if ((mm = /^print\s+(.*)$/.exec(stmt))) println(ctx.io, splitArgs(mm[1]).map((a) => concat(a.trim())).join(vars.OFS ?? ' '));
        else if ((mm = /^printf\s*\(?\s*(.*?)\)?$/.exec(stmt))) {
          const [fmt, ...rest] = splitArgs(mm[1]);
          let i = 0;
          ctx.io.out(String(val(fmt)).replace(/%(-?\d*)(\.\d+)?([sdf])/g, (_, w, p, c) => {
            const v = val(rest[i++] ?? '');
            let s = c === 'd' ? String(Math.trunc(Number(v))) : c === 'f' ? Number(v).toFixed(p ? Number(p.slice(1)) : 6) : String(v);
            const width = Number(String(w).replace('-', '')) || 0;
            if (width) s = String(w).startsWith('-') ? s.padEnd(width) : s.padStart(width);
            return s;
          }));
        } else if ((mm = /^(\w+)\s*(\+=|-=|=)\s*(.+)$/.exec(stmt))) {
          const v = val(mm[3]);
          vars[mm[1]] = mm[2] === '=' ? v : (Number(vars[mm[1]]) || 0) + (mm[2] === '+=' ? Number(v) : -Number(v));
        } else if ((mm = /^(\w+)(\+\+|--)$/.exec(stmt))) vars[mm[1]] = (Number(vars[mm[1]]) || 0) + (mm[2] === '++' ? 1 : -1);
      }
    };
    for (const b of blocks.filter((x) => x.pat === 'BEGIN')) run(b.act);
    for (const inp of inputs) {
      for (const l of lines(inp.text)) {
        NR++;
        line = l;
        fields = fs ? l.split(fs) : l.trim().split(/\s+/).filter(Boolean);
        for (const b of blocks) if (b.pat !== 'BEGIN' && b.pat !== 'END' && cond(b.pat)) run(b.act);
      }
    }
    for (const b of blocks.filter((x) => x.pat === 'END')) run(b.act);
    return 0;
  },
};

const tee: CommandDef = {
  summary: 'Copia la entrada a ficheros y a la salida',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const data = ctx.io.stdin ?? '';
    let code = 0;
    for (const f of rest) {
      try {
        ctx.sess.fs.writeFile(ctx.sess.resolve(f), data, flags.has('a'));
      } catch (e) {
        eprintln(ctx.io, `tee: ${f}: ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    ctx.io.out(data);
    return code;
  },
};

const xargs: CommandDef = {
  summary: 'Construye comandos a partir de la entrada',
  async fn(argv, ctx) {
    const { flags, opts, rest } = parseFlags(argv.slice(1), ['I', 'n']);
    const items = (ctx.io.stdin ?? '').split(/\s+/).filter(Boolean);
    const base = rest.length ? rest : ['echo'];
    let code = 0;
    if (opts.I) {
      for (const it of items) code = await ctx.sess.dispatch(base.map((a) => a.split(opts.I).join(it)), { ...ctx.io, stdin: null });
      return code;
    }
    const n = opts.n ? Number(opts.n) : items.length || 1;
    for (let i = 0; i < Math.max(items.length, flags.has('r') ? 0 : 1); i += n) {
      code = await ctx.sess.dispatch([...base, ...items.slice(i, i + n)], { ...ctx.io, stdin: null });
      if (!items.length) break;
    }
    return code;
  },
};

const find: CommandDef = {
  summary: 'Busca ficheros',
  fn(argv, ctx) {
    const args = argv.slice(1);
    const start = args[0] && !args[0].startsWith('-') ? args.shift()! : '.';
    let name: RegExp | null = null;
    let type: string | null = null;
    let maxdepth = Infinity;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name' || args[i] === '-iname') name = new RegExp('^' + args[++i].replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', args[i - 1] === '-iname' ? 'i' : '');
      else if (args[i] === '-type') type = args[++i];
      else if (args[i] === '-maxdepth') maxdepth = Number(args[++i]);
    }
    const abs = ctx.sess.resolve(start);
    if (!ctx.sess.fs.exists(abs)) {
      eprintln(ctx.io, `find: '${start}': No such file or directory`);
      return 1;
    }
    const walk = (p: string, disp: string, depth: number) => {
      const node = ctx.sess.fs.getNode(p)!;
      const base = disp.split('/').pop()!;
      if ((!type || (type === 'd' ? node.t === 'd' : node.t === 'f')) && (!name || name.test(base))) println(ctx.io, disp);
      if (node.t === 'd' && depth < maxdepth) for (const e of ctx.sess.fs.list(p)) walk(`${p === '/' ? '' : p}/${e.name}`, `${disp}/${e.name}`, depth + 1);
    };
    walk(abs, start, 0);
    return 0;
  },
};

const tree: CommandDef = {
  summary: 'Muestra el árbol de directorios',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1), ['L']);
    const root = rest[0] ?? '.';
    const abs = ctx.sess.resolve(root);
    if (!ctx.sess.fs.isDir(abs)) {
      eprintln(ctx.io, `${root} [error opening dir]`);
      return 2;
    }
    let dirs = 0;
    let files = 0;
    println(ctx.io, C.boldBlue(root));
    const walk = (p: string, prefix: string) => {
      const entries = ctx.sess.fs.list(p).filter((e) => flags.has('a') || !e.name.startsWith('.'));
      entries.forEach((e, i) => {
        const last = i === entries.length - 1;
        println(ctx.io, `${prefix}${last ? '└── ' : '├── '}${e.node.t === 'd' ? C.boldBlue(e.name) : e.name}`);
        if (e.node.t === 'd') {
          dirs++;
          walk(`${p}/${e.name}`, prefix + (last ? '    ' : '│   '));
        } else files++;
      });
    };
    walk(abs, '');
    println(ctx.io, `\n${dirs} directories, ${files} files`);
    return 0;
  },
};

const chmod: CommandDef = {
  summary: 'Cambia permisos',
  fn(argv, ctx) {
    const [mode, ...files] = argv.slice(1).filter((a) => a !== '-R');
    let code = 0;
    for (const f of files) {
      try {
        const x = mode.includes('+x') || /^[0-7]*[1357][0-7]*$/.test(mode) ? true : mode.includes('-x') ? false : undefined;
        if (x !== undefined) ctx.sess.fs.setExecutable(ctx.sess.resolve(f), x);
        else ctx.sess.fs.getNode(ctx.sess.resolve(f)) ?? (() => { throw new FsError('ENOENT', f); })();
      } catch (e) {
        eprintln(ctx.io, `chmod: cannot access '${f}': ${e instanceof FsError ? e.message : e}`);
        code = 1;
      }
    }
    return code;
  },
};

const basename: CommandDef = {
  fn(argv, { io }) {
    let b = (argv[1] ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
    if (argv[2] && b.endsWith(argv[2])) b = b.slice(0, -argv[2].length);
    println(io, b);
    return 0;
  },
};

const dirname: CommandDef = {
  fn(argv, { io }) {
    const p = (argv[1] ?? '').replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    println(io, i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i));
    return 0;
  },
};

const realpath: CommandDef = {
  fn(argv, ctx) {
    for (const a of argv.slice(1)) println(ctx.io, ctx.sess.resolve(a));
    return 0;
  },
};

const seq: CommandDef = {
  fn(argv, { io }) {
    const n = argv.slice(1).map(Number);
    const [a, step, b] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : [n[0], n[1], n[2]];
    const out: number[] = [];
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      out.push(i);
      if (out.length > 10000) break;
    }
    if (out.length) io.out(out.join('\n') + '\n');
    return 0;
  },
};

const date: CommandDef = {
  summary: 'Fecha y hora',
  fn(argv, { io }) {
    const utc = argv.includes('-u') || argv.includes('--utc');
    let dateArg: string | undefined;
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '-d' || argv[i] === '--date') dateArg = argv[++i];
      else if (argv[i].startsWith('--date=')) dateArg = argv[i].slice(7);
      else rest.push(argv[i]);
    }
    const fmt = rest.find((a) => a.startsWith('+'));
    const d = new Date();
    if (dateArg !== undefined) {
      const t = dateArg.trim().toLowerCase();
      const rel = /^([+-]?\d+)\s*(second|sec|minute|min|hour|day|week|month|year)s?(\s+ago)?$/.exec(t);
      const units: Record<string, number> = { second: 1e3, sec: 1e3, minute: 6e4, min: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
      if (t === 'now' || t === '') {
        /* ahora */
      } else if (t === 'tomorrow') d.setTime(d.getTime() + 864e5);
      else if (t === 'yesterday') d.setTime(d.getTime() - 864e5);
      else if (rel) d.setTime(d.getTime() + Number(rel[1]) * units[rel[2]] * (rel[3] ? -1 : 1));
      else if (!Number.isNaN(Date.parse(dateArg))) d.setTime(Date.parse(dateArg));
      else {
        eprintln(io, `date: invalid date '${dateArg}'`);
        return 1;
      }
    }
    if (argv.includes('-I') || argv.includes('--iso-8601')) {
      println(io, strftime('%F', d, utc));
      return 0;
    }
    println(io, fmt ? strftime(fmt.slice(1), d, utc) : strftime('%a %b %d %T %Z %Y', d, utc));
    return 0;
  },
};

const sleep: CommandDef = {
  summary: 'Espera N segundos',
  async fn(argv, { io }) {
    const raw = argv[1] ?? '1';
    const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(raw);
    if (!m) {
      eprintln(io, `sleep: invalid time interval '${raw}'`);
      return 1;
    }
    const secs = Number(m[1]) * (m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 1);
    await delay(Math.min(secs * 1000, 120000) * Math.max(0.05, speedFactor() || 0.05), io);
    return 0;
  },
};

const envCmd: CommandDef = {
  summary: 'Variables de entorno',
  async fn(argv, ctx) {
    if (argv.length > 1 && argv[0] === 'env') {
      const assigns: [string, string][] = [];
      let i = 1;
      for (; i < argv.length && /^\w+=/.test(argv[i]); i++) assigns.push([argv[i].split('=')[0], argv[i].slice(argv[i].indexOf('=') + 1)]);
      if (i < argv.length) {
        const saved = assigns.map(([k]) => [k, ctx.sess.env[k]] as const);
        assigns.forEach(([k, v]) => (ctx.sess.env[k] = v));
        try {
          return await ctx.sess.dispatch(argv.slice(i), ctx.io);
        } finally {
          saved.forEach(([k, v]) => (v === undefined ? delete ctx.sess.env[k] : (ctx.sess.env[k] = v)));
        }
      }
    }
    if (argv[0] === 'printenv' && argv[1]) {
      const v = ctx.sess.env[argv[1]];
      if (v === undefined) return 1;
      println(ctx.io, v);
      return 0;
    }
    for (const k of [...ctx.sess.exported].sort()) if (ctx.sess.env[k] !== undefined) println(ctx.io, `${k}=${ctx.sess.env[k]}`);
    return 0;
  },
};

const whoami: CommandDef = { fn: (_a, ctx) => (println(ctx.io, ctx.sess.isRoot ? 'root' : ctx.sess.user), 0) };
const hostname: CommandDef = {
  fn(argv, ctx) {
    if (argv[1] === '-I' || argv[1] === '-i') println(ctx.io, ctx.sess.kind === 'cloudshell' ? '10.0.0.5' : '10.0.0.4');
    else println(ctx.io, ctx.sess.host);
    return 0;
  },
};
const idCmd: CommandDef = {
  fn: (_a, ctx) => {
    const u = ctx.sess.isRoot ? 'root' : ctx.sess.user;
    const n = ctx.sess.isRoot ? 0 : 1000;
    println(ctx.io, `uid=${n}(${u}) gid=${n}(${u}) groups=${n}(${u})${ctx.sess.isRoot ? '' : ',27(sudo)'}`);
    return 0;
  },
};
const uname: CommandDef = {
  fn(argv, ctx) {
    if (argv.includes('-a')) println(ctx.io, `Linux ${ctx.sess.host} 6.5.0-1025-azure #26~22.04.1-Ubuntu SMP Thu Jul 11 22:33:04 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux`);
    else if (argv.includes('-r')) println(ctx.io, '6.5.0-1025-azure');
    else if (argv.includes('-m')) println(ctx.io, 'x86_64');
    else println(ctx.io, 'Linux');
    return 0;
  },
};

const clear: CommandDef = {
  summary: 'Limpia la pantalla',
  fn(_a, ctx) {
    ctx.sess.ui.clear?.();
    return 0;
  },
};

const editor: CommandDef = {
  summary: 'Abre el editor integrado',
  fn(argv, ctx) {
    const file = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!ctx.sess.ui.openEditor) {
      eprintln(ctx.io, `${argv[0]}: no hay un terminal interactivo disponible`);
      return 1;
    }
    if (!file) {
      ctx.sess.ui.openEditor(ctx.sess.cwd + '/');
      return 0;
    }
    const abs = ctx.sess.resolve(file);
    if (ctx.sess.fs.isDir(abs)) {
      ctx.sess.ui.openEditor(abs + '/');
      return 0;
    }
    const parent = abs.split('/').slice(0, -1).join('/') || '/';
    if (!ctx.sess.fs.isDir(parent)) {
      eprintln(ctx.io, `${argv[0]}: ${file}: el directorio no existe`);
      return 1;
    }
    ctx.sess.ui.openEditor(abs);
    if (argv[0] !== 'code') println(ctx.io, C.dim(`(Se ha abierto el editor integrado del simulador para ${file}; guarda con Ctrl+S)`));
    return 0;
  },
};

const less: CommandDef = { fn: (argv, ctx) => cat.fn(['cat', ...argv.slice(1).filter((a) => !a.startsWith('-'))], ctx) };

const base64: CommandDef = {
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const inputs = readInput(ctx, rest, 'base64');
    if (!inputs) return 1;
    const text = inputs.map((i) => i.text).join('');
    try {
      if (flags.has('d') || flags.has('decode')) ctx.io.out(decodeURIComponent(escape(atob(text.replace(/\s/g, '')))));
      else println(ctx.io, btoa(unescape(encodeURIComponent(text))).replace(/(.{76})/g, '$1\n'));
    } catch {
      eprintln(ctx.io, 'base64: invalid input');
      return 1;
    }
    return 0;
  },
};

const hashCmd = (algo: string, len: number): CommandDef => ({
  async fn(argv, ctx) {
    const inputs = readInput(ctx, argv.slice(1), algo);
    if (!inputs) return 1;
    for (const inp of inputs) {
      let h = '';
      let x = 0x811c9dc5;
      for (let r = 0; h.length < len; r++) {
        for (let i = 0; i < inp.text.length; i++) x = Math.imul(x ^ inp.text.charCodeAt(i), 0x01000193 + r);
        h += (x >>> 0).toString(16).padStart(8, '0');
      }
      println(ctx.io, `${h.slice(0, len)}  ${inp.name === '(standard input)' ? '-' : inp.name}`);
    }
    return 0;
  },
});

const diff: CommandDef = {
  fn(argv, ctx) {
    const [a, b] = argv.slice(1).filter((x) => !x.startsWith('-'));
    let ta: string, tb: string;
    try {
      ta = ctx.sess.fs.readFile(ctx.sess.resolve(a));
      tb = ctx.sess.fs.readFile(ctx.sess.resolve(b));
    } catch (e) {
      err(ctx, 'diff', '', e);
      return 2;
    }
    if (ta === tb) return 0;
    const la = lines(ta);
    const lb = lines(tb);
    println(ctx.io, `--- ${a}\n+++ ${b}`);
    const max = Math.max(la.length, lb.length);
    for (let i = 0; i < max; i++) {
      if (la[i] === lb[i]) continue;
      if (la[i] !== undefined) println(ctx.io, C.red(`-${la[i]}`));
      if (lb[i] !== undefined) println(ctx.io, C.green(`+${lb[i]}`));
    }
    return 1;
  },
};

const duCmd: CommandDef = {
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1));
    const target = rest[0] ?? '.';
    const abs = ctx.sess.resolve(target);
    try {
      const snap = ctx.sess.fs.snapshot(abs);
      const size = Object.values(snap).reduce((a, s) => a + s.length, 0) + 4096;
      println(ctx.io, `${fmtSize(size, flags.has('h'))}\t${target}`);
    } catch (e) {
      err(ctx, 'du', target, e);
      return 1;
    }
    return 0;
  },
};

const dfCmd: CommandDef = {
  fn(_a, ctx) {
    println(ctx.io, ['Filesystem      Size  Used Avail Use% Mounted on', 'overlay          48G   21G   27G  44% /', 'tmpfs            64M     0   64M   0% /dev', '/dev/sda1        48G   21G   27G  44% /etc/hosts', ctx.sess.kind === 'cloudshell' ? '//cs.file.core.windows.net/cs  5.0G  1.2M  5.0G   1% /home/' + ctx.sess.user + '/clouddrive' : '/dev/sdb1        16G   28K   15G   1% /mnt'].join('\n'));
    return 0;
  },
};

const fileCmd: CommandDef = {
  fn(argv, ctx) {
    for (const f of argv.slice(1)) {
      const abs = ctx.sess.resolve(f);
      const n = ctx.sess.fs.getNode(abs);
      if (!n) println(ctx.io, `${f}: cannot open \`${f}' (No such file or directory)`);
      else if (n.t === 'd') println(ctx.io, `${f}: directory`);
      else if (n.d.startsWith('PK')) println(ctx.io, `${f}: Zip archive data, at least v2.0 to extract`);
      else if (n.d.startsWith('#!/bin/bash') || n.d.startsWith('#!/usr/bin/env bash')) println(ctx.io, `${f}: Bourne-Again shell script, ASCII text executable`);
      else if (/^\s*[{[]/.test(n.d)) println(ctx.io, `${f}: JSON text data`);
      else println(ctx.io, `${f}: ${n.d ? 'ASCII text' : 'empty'}`);
    }
    return 0;
  },
};

const historyCmd: CommandDef = { fn: (argv, ctx) => ctx.sess.builtin(['history', ...argv.slice(1)], ctx.io) };

const ps: CommandDef = {
  fn(_a, ctx) {
    println(ctx.io, '    PID TTY          TIME CMD\n      1 pts/0    00:00:00 bash\n   4242 pts/0    00:00:00 ps');
    return 0;
  },
};

const free: CommandDef = {
  fn(argv, ctx) {
    const h = argv.includes('-h');
    println(ctx.io, h ? '               total        used        free      shared  buff/cache   available\nMem:           1.9Gi       812Mi       298Mi       4.0Mi       945Mi       1.0Gi\nSwap:             0B          0B          0B' : '               total        used        free      shared  buff/cache   available\nMem:         2017676      831540      305312        4096      967928     1053960\nSwap:              0           0           0');
    return 0;
  },
};

const uptime: CommandDef = {
  fn(_a, ctx) {
    const mins = Math.floor((Date.now() - ctx.sess.startTime) / 60000);
    println(ctx.io, ` ${strftime('%T', new Date())} up ${mins} min,  1 user,  load average: 0.08, 0.03, 0.01`);
    return 0;
  },
};

const yesNoop: CommandDef = { fn: () => 0 };

const man: CommandDef = {
  fn(argv, ctx) {
    const cmd = argv[1];
    if (!cmd) {
      println(ctx.io, 'What manual page do you want?\nFor example, try \'man man\'.');
      return 1;
    }
    println(ctx.io, C.dim(`(El simulador no incluye páginas man. Prueba "${cmd} --help" o "help".)`));
    return 0;
  },
};

export const CORE_COMMANDS: Record<string, CommandDef> = {
  echo,
  printf,
  ls,
  ll: { fn: (argv, ctx) => ls.fn(['ls', '-la', ...argv.slice(1)], ctx) },
  dir: ls,
  cat,
  mkdir,
  rmdir,
  rm,
  touch,
  cp,
  mv,
  head: headTail('head'),
  tail: headTail('tail'),
  wc,
  grep,
  egrep: { fn: (argv, ctx) => grep.fn(['grep', '-E', ...argv.slice(1)], ctx) },
  sort,
  uniq,
  cut,
  tr,
  sed,
  awk,
  tee,
  xargs,
  find,
  tree,
  chmod,
  chown: yesNoop,
  ln: { fn: (argv, ctx) => (eprintln(ctx.io, 'ln: los enlaces no están soportados en el simulador'), 1) },
  basename,
  dirname,
  realpath,
  readlink: realpath,
  seq,
  date,
  sleep,
  env: envCmd,
  printenv: envCmd,
  whoami,
  hostname,
  id: idCmd,
  uname,
  clear,
  reset: clear,
  code: editor,
  nano: editor,
  vi: editor,
  vim: editor,
  edit: editor,
  less,
  more: less,
  base64,
  md5sum: hashCmd('md5sum', 32),
  sha256sum: hashCmd('sha256sum', 64),
  sha1sum: hashCmd('sha1sum', 40),
  diff,
  du: duCmd,
  df: dfCmd,
  file: fileCmd,
  history: historyCmd,
  ps,
  free,
  uptime,
  man,
  sync: yesNoop,
  stty: yesNoop,
  tput: yesNoop,
  logout: { fn: (_a, ctx) => ctx.sess.builtin(['exit'], ctx.io) },
};

export function relativeTo(cwd: string, abs: string) {
  return relPath(cwd, abs);
}
