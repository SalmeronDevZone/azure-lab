// Herramientas de desarrollo: zip, unzip, tar, jq, npm, node, python, pip, sqlcmd, terraform, help y stubs.
import type { CommandDef, CmdCtx } from '../interp';
import { makeZip, readZip, ZIP_MAGIC } from '../fs';
import { C, delay, eprintln, hint, parseFlags, println } from './util';
import { colorJson } from '../az/output';
import { appListenPort, runNodeTests, startupLog, detectKind } from '../../engine/services/appRuntime';
import { connect, execSql, formatSqlResults } from '../../engine/services/sql';
import { terraformCommand } from '../../engine/services/terraform';
import { getState, changed } from '../../engine/store';
import { ArmError } from '../../engine/errors';
import { globToRegex } from '../interp';

const TAR_MAGIC = '\u001f\u008bAZLAB-TAR:';

function collect(ctx: CmdCtx, items: string[], recursive: boolean, exclude: RegExp[], skipAbs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    const abs = ctx.sess.resolve(it);
    const node = ctx.sess.fs.getNode(abs);
    if (!node) continue;
    const base = it === '.' || it === './' ? '' : it.replace(/^\.\//, '').replace(/\/$/, '');
    if (node.t === 'f') {
      if (abs !== skipAbs) out[base] = node.d;
      continue;
    }
    if (!recursive) continue;
    for (const [rel, content] of Object.entries(ctx.sess.fs.snapshot(abs))) {
      const p = base ? `${base}/${rel}` : rel;
      if (`${abs}/${rel}` === skipAbs) continue;
      if (exclude.some((re) => re.test(p) || re.test(p.split('/')[0]))) continue;
      out[p] = content;
    }
  }
  return out;
}

const zip: CommandDef = {
  summary: 'Crea un archivo zip',
  fn(argv, ctx) {
    const args = argv.slice(1);
    let recursive = false;
    let quiet = false;
    const exclude: RegExp[] = [];
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-x') {
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) exclude.push(globToRegex(args[++i].replace(/^\.\//, '')));
      } else if (/^-[rqj9]+$/.test(a)) {
        if (a.includes('r')) recursive = true;
        if (a.includes('q')) quiet = true;
      } else pos.push(a);
    }
    if (pos.length < 2) {
      eprintln(ctx.io, 'zip error: Nothing to do! (try: zip -r app.zip .)');
      return 12;
    }
    let archive = pos[0];
    if (!archive.endsWith('.zip')) archive += '.zip';
    const absArchive = ctx.sess.resolve(archive);
    const files = collect(ctx, pos.slice(1), recursive, exclude, absArchive);
    if (!Object.keys(files).length) {
      eprintln(ctx.io, `\tzip warning: name not matched: ${pos.slice(1).join(' ')}\n\nzip error: Nothing to do! (${archive})`);
      return 12;
    }
    const existing = ctx.sess.fs.isFile(absArchive) ? readZip(ctx.sess.fs.readFile(absArchive)) ?? {} : {};
    const merged = { ...existing, ...files };
    ctx.sess.fs.writeFile(absArchive, makeZip(merged));
    if (!quiet) for (const f of Object.keys(files)) println(ctx.io, `  ${existing[f] !== undefined ? 'updating' : 'adding'}: ${f} (deflated ${30 + (f.length % 40)}%)`);
    return 0;
  },
};

const unzip: CommandDef = {
  summary: 'Extrae un archivo zip',
  fn(argv, ctx) {
    const { flags, opts, rest } = parseFlags(argv.slice(1), ['d']);
    const archive = rest[0];
    if (!archive) {
      eprintln(ctx.io, 'UnZip 6.00. Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]');
      return 10;
    }
    let content: string;
    try {
      content = ctx.sess.fs.readFile(ctx.sess.resolve(archive));
    } catch {
      eprintln(ctx.io, `unzip:  cannot find or open ${archive}, ${archive}.zip or ${archive}.ZIP.`);
      return 9;
    }
    const files = readZip(content);
    if (!files) {
      eprintln(ctx.io, `Archive:  ${archive}\n  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.`);
      return 9;
    }
    if (flags.has('l')) {
      println(ctx.io, `Archive:  ${archive}\n  Length      Date    Time    Name\n---------  ---------- -----   ----`);
      let total = 0;
      for (const [n, c] of Object.entries(files)) {
        total += c.length;
        println(ctx.io, `${String(c.length).padStart(9)}  ${new Date().toISOString().slice(0, 10)} ${new Date().toISOString().slice(11, 16)}   ${n}`);
      }
      println(ctx.io, `---------                     -------\n${String(total).padStart(9)}                     ${Object.keys(files).length} files`);
      return 0;
    }
    const dest = ctx.sess.resolve(opts.d ?? '.');
    if (!flags.has('q')) println(ctx.io, `Archive:  ${archive}`);
    for (const [n, c] of Object.entries(files)) {
      const p = `${dest}/${n}`;
      ctx.sess.fs.mkdir(p.split('/').slice(0, -1).join('/') || '/', true);
      ctx.sess.fs.writeFile(p, c);
      if (!flags.has('q')) println(ctx.io, `  inflating: ${opts.d ? `${opts.d}/` : ''}${n}`);
    }
    return 0;
  },
};

const tar: CommandDef = {
  summary: 'Empaqueta/extrae archivos tar',
  fn(argv, ctx) {
    const args = argv.slice(1);
    const mode = args[0]?.replace(/^-/, '') ?? '';
    let file = '';
    let dir = '.';
    const items: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '-C') dir = args[++i];
      else if (!file && mode.includes('f')) file = args[i];
      else items.push(args[i]);
    }
    if (!file) {
      eprintln(ctx.io, "tar: Refusing to read archive contents from terminal (missing -f option?)");
      return 2;
    }
    if (mode.includes('c')) {
      const abs = ctx.sess.resolve(file);
      const files = collect(ctx, items.length ? items : ['.'], true, [], abs);
      ctx.sess.fs.writeFile(abs, TAR_MAGIC + JSON.stringify(files));
      if (mode.includes('v')) for (const f of Object.keys(files)) println(ctx.io, f);
      return 0;
    }
    let content: string;
    try {
      content = ctx.sess.fs.readFile(ctx.sess.resolve(file));
    } catch {
      eprintln(ctx.io, `tar: ${file}: Cannot open: No such file or directory`);
      return 2;
    }
    if (!content.startsWith(TAR_MAGIC)) {
      eprintln(ctx.io, 'tar: This does not look like a tar archive');
      return 2;
    }
    const files: Record<string, string> = JSON.parse(content.slice(TAR_MAGIC.length));
    if (mode.includes('t')) {
      for (const f of Object.keys(files)) println(ctx.io, f);
      return 0;
    }
    const dest = ctx.sess.resolve(dir);
    for (const [n, c] of Object.entries(files)) {
      const p = `${dest}/${n}`;
      ctx.sess.fs.mkdir(p.split('/').slice(0, -1).join('/') || '/', true);
      ctx.sess.fs.writeFile(p, c);
      if (mode.includes('v')) println(ctx.io, n);
    }
    return 0;
  },
};

// ---------------------------------------------------------------- jq

type JqNode =
  | { k: 'id' }
  | { k: 'field'; name: string; opt?: boolean }
  | { k: 'index'; idx: JqNode }
  | { k: 'iter' }
  | { k: 'pipe'; a: JqNode; b: JqNode }
  | { k: 'comma'; a: JqNode; b: JqNode }
  | { k: 'lit'; v: any }
  | { k: 'bin'; op: string; a: JqNode; b: JqNode }
  | { k: 'call'; fn: string; args: JqNode[] }
  | { k: 'obj'; entries: { key: string | JqNode; value: JqNode | null }[] }
  | { k: 'arr'; body: JqNode | null }
  | { k: 'chain'; base: JqNode; steps: JqNode[] }
  | { k: 'slice'; from: number | null; to: number | null };

class JqError extends Error {}

function parseJq(src: string): JqNode {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peekStr = (s: string) => src.startsWith(s, i);
  function pipe(): JqNode {
    let a = comma();
    ws();
    while (src[i] === '|' && src[i + 1] !== '|') {
      i++;
      const b = comma();
      a = { k: 'pipe', a, b };
      ws();
    }
    return a;
  }
  function comma(): JqNode {
    let a = or();
    ws();
    while (src[i] === ',') {
      i++;
      a = { k: 'comma', a, b: or() };
      ws();
    }
    return a;
  }
  function or(): JqNode {
    let a = and();
    ws();
    while (peekStr('or ') || peekStr('//')) {
      const op = peekStr('//') ? '//' : 'or';
      i += op.length;
      a = { k: 'bin', op, a, b: and() };
      ws();
    }
    return a;
  }
  function and(): JqNode {
    let a = cmp();
    ws();
    while (peekStr('and ')) {
      i += 3;
      a = { k: 'bin', op: 'and', a, b: cmp() };
      ws();
    }
    return a;
  }
  function cmp(): JqNode {
    const a = add();
    ws();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (peekStr(op)) {
        i += op.length;
        return { k: 'bin', op, a, b: add() };
      }
    }
    return a;
  }
  function add(): JqNode {
    let a = postfix();
    ws();
    while ((src[i] === '+' || src[i] === '-') && !/\d/.test(src[i + 1] ?? '') || (src[i] === '+')) {
      const op = src[i++];
      a = { k: 'bin', op, a, b: postfix() };
      ws();
    }
    return a;
  }
  function steps(): JqNode[] {
    const out: JqNode[] = [];
    for (;;) {
      if (src[i] === '.' && /[A-Za-z_"]/.test(src[i + 1] ?? '')) {
        i++;
        out.push(fieldName());
      } else if (src[i] === '[') {
        i++;
        ws();
        if (src[i] === ']') {
          i++;
          out.push({ k: 'iter' });
        } else {
          const m = /^(-?\d*)\s*:\s*(-?\d*)/.exec(src.slice(i));
          if (m && src.slice(i).indexOf(']') >= m[0].length) {
            i += m[0].length;
            ws();
            i++;
            out.push({ k: 'slice', from: m[1] ? Number(m[1]) : null, to: m[2] ? Number(m[2]) : null });
          } else {
            const idx = pipe();
            ws();
            i++;
            out.push({ k: 'index', idx });
          }
        }
      } else break;
      if (src[i] === '?') i++;
    }
    return out;
  }
  function fieldName(): JqNode {
    if (src[i] === '"') {
      const end = src.indexOf('"', i + 1);
      const name = src.slice(i + 1, end);
      i = end + 1;
      return { k: 'field', name };
    }
    const m = /^[A-Za-z_][\w]*/.exec(src.slice(i))!;
    i += m[0].length;
    const opt = src[i] === '?';
    if (opt) i++;
    return { k: 'field', name: m[0], opt };
  }
  function postfix(): JqNode {
    const base = primary();
    const st = steps();
    return st.length ? { k: 'chain', base, steps: st } : base;
  }
  function primary(): JqNode {
    ws();
    const c = src[i];
    if (c === '.') {
      i++;
      if (/[A-Za-z_"]/.test(src[i] ?? '')) return { k: 'chain', base: { k: 'id' }, steps: [fieldName(), ...steps()] };
      return { k: 'id' };
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          s += src[i + 1] === 'n' ? '\n' : src[i + 1];
          i += 2;
          continue;
        }
        s += src[i++];
      }
      i++;
      return { k: 'lit', v: s };
    }
    if (/[-\d]/.test(c)) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      return { k: 'lit', v: Number(m[0]) };
    }
    if (c === '(') {
      i++;
      const e = pipe();
      ws();
      i++;
      return e;
    }
    if (c === '[') {
      i++;
      ws();
      if (src[i] === ']') {
        i++;
        return { k: 'arr', body: null };
      }
      const body = pipe();
      ws();
      i++;
      return { k: 'arr', body };
    }
    if (c === '{') {
      i++;
      const entries: { key: string | JqNode; value: JqNode | null }[] = [];
      ws();
      while (src[i] !== '}') {
        ws();
        let key: string | JqNode;
        if (src[i] === '"') {
          const end = src.indexOf('"', i + 1);
          key = src.slice(i + 1, end);
          i = end + 1;
        } else if (src[i] === '(') {
          i++;
          key = pipe();
          i++;
        } else {
          const m = /^[\w$]+/.exec(src.slice(i));
          if (!m) throw new JqError(`syntax error, unexpected '${src[i]}'`);
          key = m[0];
          i += m[0].length;
        }
        ws();
        let value: JqNode | null = null;
        if (src[i] === ':') {
          i++;
          value = or();
        }
        entries.push({ key, value });
        ws();
        if (src[i] === ',') i++;
        ws();
      }
      i++;
      return { k: 'obj', entries };
    }
    const m = /^[A-Za-z_][\w]*/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      if (['true', 'false', 'null'].includes(m[0])) return { k: 'lit', v: m[0] === 'null' ? null : m[0] === 'true' };
      const args: JqNode[] = [];
      if (src[i] === '(') {
        i++;
        for (;;) {
          args.push(pipe());
          ws();
          if (src[i] === ';') {
            i++;
            continue;
          }
          i++;
          break;
        }
      }
      return { k: 'call', fn: m[0], args };
    }
    throw new JqError(`syntax error, unexpected ${c ?? 'end of input'}`);
  }
  const e = pipe();
  ws();
  if (i < src.length) throw new JqError(`syntax error, unexpected ${src.slice(i, i + 10)}`);
  return e;
}

function truthy(v: any) {
  return v !== null && v !== false && v !== undefined;
}

function evalJq(n: JqNode, input: any): any[] {
  switch (n.k) {
    case 'id':
      return [input];
    case 'lit':
      return [n.v];
    case 'field':
      if (input === null || input === undefined) return [null];
      if (typeof input !== 'object' || Array.isArray(input)) {
        if (n.opt) return [];
        throw new JqError(`Cannot index ${Array.isArray(input) ? 'array' : typeof input} with "${n.name}"`);
      }
      return [input[n.name] ?? null];
    case 'iter':
      if (Array.isArray(input)) return input;
      if (input && typeof input === 'object') return Object.values(input);
      throw new JqError(`Cannot iterate over ${input === null ? 'null' : typeof input}`);
    case 'index':
      return evalJq(n.idx, input).map((ix) => (Array.isArray(input) ? input[ix < 0 ? input.length + ix : ix] ?? null : input?.[ix] ?? null));
    case 'slice': {
      const v = Array.isArray(input) || typeof input === 'string' ? input : [];
      return [v.slice(n.from ?? 0, n.to ?? undefined)];
    }
    case 'chain': {
      let cur = evalJq(n.base, input);
      for (const st of n.steps) cur = cur.flatMap((x) => evalJq(st, x));
      return cur;
    }
    case 'pipe':
      return evalJq(n.a, input).flatMap((x) => evalJq(n.b, x));
    case 'comma':
      return [...evalJq(n.a, input), ...evalJq(n.b, input)];
    case 'arr':
      return [n.body ? evalJq(n.body, input) : []];
    case 'obj': {
      let outs: Record<string, any>[] = [{}];
      for (const e of n.entries) {
        const keys = typeof e.key === 'string' ? [e.key] : evalJq(e.key, input).map(String);
        const vals = e.value ? evalJq(e.value, input) : [input?.[keys[0]] ?? null];
        const next: Record<string, any>[] = [];
        for (const o of outs) for (const k of keys) for (const v of vals) next.push({ ...o, [k]: v });
        outs = next;
      }
      return outs;
    }
    case 'bin': {
      if (n.op === '//') {
        const a = evalJq(n.a, input).filter(truthy);
        return a.length ? a : evalJq(n.b, input);
      }
      const as = evalJq(n.a, input);
      const bs = evalJq(n.b, input);
      const out: any[] = [];
      for (const a of as)
        for (const b of bs) {
          switch (n.op) {
            case '==':
              out.push(JSON.stringify(a) === JSON.stringify(b));
              break;
            case '!=':
              out.push(JSON.stringify(a) !== JSON.stringify(b));
              break;
            case '<':
              out.push(a < b);
              break;
            case '>':
              out.push(a > b);
              break;
            case '<=':
              out.push(a <= b);
              break;
            case '>=':
              out.push(a >= b);
              break;
            case 'and':
              out.push(truthy(a) && truthy(b));
              break;
            case 'or':
              out.push(truthy(a) || truthy(b));
              break;
            case '+':
              out.push(Array.isArray(a) ? [...a, ...b] : a && typeof a === 'object' ? { ...a, ...b } : a === null ? b : b === null ? a : a + b);
              break;
            case '-':
              out.push(Array.isArray(a) ? a.filter((x: any) => !b.includes(x)) : a - b);
              break;
          }
        }
      return out;
    }
    case 'call': {
      const arg = (k = 0) => n.args[k];
      switch (n.fn) {
        case 'length':
          return [input === null ? 0 : typeof input === 'object' ? Object.keys(input).length : String(input).length];
        case 'keys':
          return [Object.keys(input ?? {}).sort()];
        case 'values':
          return truthy(input) ? [input] : [];
        case 'has':
          return evalJq(arg(), input).map((k) => (Array.isArray(input) ? k < input.length : Object.prototype.hasOwnProperty.call(input ?? {}, k)));
        case 'select':
          return evalJq(arg(), input).some(truthy) ? [input] : [];
        case 'map':
          return [(Array.isArray(input) ? input : Object.values(input ?? {})).flatMap((x) => evalJq(arg(), x))];
        case 'to_entries':
          return [Object.entries(input ?? {}).map(([key, value]) => ({ key, value }))];
        case 'from_entries':
          return [Object.fromEntries((input ?? []).map((e: any) => [e.key ?? e.name, e.value]))];
        case 'first':
          return n.args.length ? evalJq(arg(), input).slice(0, 1) : [Array.isArray(input) ? input[0] ?? null : null];
        case 'last':
          return [Array.isArray(input) ? input[input.length - 1] ?? null : null];
        case 'sort':
          return [[...(input ?? [])].sort()];
        case 'sort_by':
          return [[...(input ?? [])].sort((a, b) => (evalJq(arg(), a)[0] > evalJq(arg(), b)[0] ? 1 : -1))];
        case 'unique':
          return [[...new Set((input ?? []).map((x: any) => JSON.stringify(x)))].map((x) => JSON.parse(x as string))];
        case 'add':
          return [(input ?? []).reduce((a: any, b: any) => (a === null ? b : typeof a === 'number' ? a + b : Array.isArray(a) ? [...a, ...b] : a + b), null)];
        case 'tostring':
          return [typeof input === 'string' ? input : JSON.stringify(input)];
        case 'tonumber':
          return [Number(input)];
        case 'ascii_downcase':
          return [String(input).toLowerCase()];
        case 'ascii_upcase':
          return [String(input).toUpperCase()];
        case 'contains':
          return evalJq(arg(), input).map((b) => (typeof input === 'string' ? input.includes(b) : JSON.stringify(input).includes(JSON.stringify(b).replace(/^\{|\}$/g, ''))));
        case 'startswith':
          return evalJq(arg(), input).map((b) => String(input).startsWith(b));
        case 'endswith':
          return evalJq(arg(), input).map((b) => String(input).endsWith(b));
        case 'test':
          return evalJq(arg(), input).map((b) => new RegExp(b).test(String(input)));
        case 'split':
          return evalJq(arg(), input).map((b) => String(input).split(b));
        case 'join':
          return evalJq(arg(), input).map((b) => (input ?? []).join(b));
        case 'not':
          return [!truthy(input)];
        case 'empty':
          return [];
        case 'type':
          return [input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input];
        case 'env':
          return [{}];
        case 'tojson':
          return [JSON.stringify(input)];
        case 'fromjson':
          return [JSON.parse(String(input))];
      }
      throw new JqError(`${n.fn}/${n.args.length} is not defined`);
    }
  }
}

const jq: CommandDef = {
  summary: 'Procesador de JSON',
  fn(argv, ctx) {
    const { flags, rest } = parseFlags(argv.slice(1), ['arg']);
    const filter = rest[0] ?? '.';
    const files = rest.slice(1);
    let text = ctx.io.stdin ?? '';
    if (files.length) {
      try {
        text = files.map((f) => ctx.sess.fs.readFile(ctx.sess.resolve(f))).join('\n');
      } catch {
        eprintln(ctx.io, `jq: error: Could not open ${files[0]}: No such file or directory`);
        return 2;
      }
    }
    let ast: JqNode;
    try {
      ast = parseJq(filter);
    } catch (e) {
      eprintln(ctx.io, `jq: error: ${(e as Error).message}\njq: 1 compile error`);
      return 3;
    }
    const docs: any[] = [];
    try {
      const trimmed = text.trim();
      if (flags.has('n')) docs.push(null);
      else if (trimmed) {
        try {
          docs.push(JSON.parse(trimmed));
        } catch {
          for (const line of trimmed.split('\n').filter(Boolean)) docs.push(JSON.parse(line));
        }
      }
    } catch (e) {
      eprintln(ctx.io, `jq: error (at <stdin>:1): Cannot parse JSON: ${(e as Error).message}`);
      return 2;
    }
    try {
      for (const d of docs) {
        for (const r of evalJq(ast, d)) {
          if ((flags.has('r') || flags.has('raw-output')) && typeof r === 'string') println(ctx.io, r);
          else if (flags.has('c') || flags.has('compact-output')) println(ctx.io, JSON.stringify(r));
          else println(ctx.io, colorJson(r, ctx.io.isTTY));
        }
      }
    } catch (e) {
      eprintln(ctx.io, `jq: error (at <stdin>:0): ${(e as Error).message}`);
      return 5;
    }
    return 0;
  },
};

// ---------------------------------------------------------------- npm / node / python

function readPkg(ctx: CmdCtx): any | null {
  try {
    return JSON.parse(ctx.sess.fs.readFile(ctx.sess.resolve('package.json')));
  } catch {
    return null;
  }
}

async function runScriptCmd(ctx: CmdCtx, name: string, script: string): Promise<number> {
  println(ctx.io, `\n> ${readPkg(ctx)?.name ?? 'app'}@${readPkg(ctx)?.version ?? '1.0.0'} ${name}\n> ${script}\n`);
  const nodeTest = /^node\s+([\w./-]+)$/.exec(script.trim());
  if (nodeTest) return nodeCmd.fn(['node', nodeTest[1]], ctx) as Promise<number>;
  return ctx.sess.run(script, ctx.io);
}

const npm: CommandDef = {
  summary: 'Gestor de paquetes de Node.js',
  async fn(argv, ctx) {
    const sub = argv[1];
    if (!sub || sub === '-v' || sub === '--version') {
      println(ctx.io, sub ? '10.9.0' : 'npm <command>\n\nUsage:\n\nnpm install        install all the dependencies in your project\nnpm test           run this project\'s tests\nnpm run <foo>      run the script named <foo>');
      return 0;
    }
    if (sub === 'init') {
      const name = ctx.sess.cwd.split('/').pop() || 'app';
      const pkg = { name, version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' };
      ctx.sess.fs.writeFile(ctx.sess.resolve('package.json'), JSON.stringify(pkg, null, 2) + '\n');
      println(ctx.io, `Wrote to ${ctx.sess.cwd}/package.json:\n\n${JSON.stringify(pkg, null, 2)}\n`);
      return 0;
    }
    const pkg = readPkg(ctx);
    if (['install', 'i', 'ci', 'add'].includes(sub)) {
      if (!pkg) {
        eprintln(ctx.io, `npm error code ENOENT\nnpm error syscall open\nnpm error path ${ctx.sess.cwd}/package.json\nnpm error errno -2\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${ctx.sess.cwd}/package.json'`);
        return 254;
      }
      // npm ci instala exactamente lo que dice package-lock.json: sin él, falla (por eso el lock se sube al repositorio).
      if (sub === 'ci' && !ctx.sess.fs.exists(ctx.sess.resolve('package-lock.json')) && !ctx.sess.fs.exists(ctx.sess.resolve('npm-shrinkwrap.json'))) {
        eprintln(ctx.io, 'npm error code EUSAGE\nnpm error\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or\nnpm error later to generate a package-lock.json file, then try again.\nnpm error\nnpm error Clean install a project\nnpm error\nnpm error Usage:\nnpm error npm ci');
        return 1;
      }
      const extra = argv.slice(2).filter((a) => !a.startsWith('-'));
      if (extra.length) {
        pkg.dependencies = { ...(pkg.dependencies ?? {}), ...Object.fromEntries(extra.map((e) => [e.split('@')[0], '^1.0.0'])) };
        ctx.sess.fs.writeFile(ctx.sess.resolve('package.json'), JSON.stringify(pkg, null, 2) + '\n');
      }
      await delay(400, ctx.io);
      const n = Object.keys(pkg.dependencies ?? {}).length * 32 + Object.keys(pkg.devDependencies ?? {}).length * 40 + 1;
      ctx.sess.fs.mkdir(ctx.sess.resolve('node_modules'), true);
      ctx.sess.fs.writeFile(ctx.sess.resolve('node_modules/.package-lock.json'), '{}');
      if (!ctx.sess.fs.exists(ctx.sess.resolve('package-lock.json'))) ctx.sess.fs.writeFile(ctx.sess.resolve('package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, requires: true }, null, 2));
      println(ctx.io, `\nadded ${n} packages, and audited ${n + 1} packages in 2s\n\n${Math.max(1, Math.floor(n / 10))} packages are looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities`);
      return 0;
    }
    if (sub === 'test' || sub === 't' || (sub === 'run' && argv[2] === 'test')) {
      const script = pkg?.scripts?.test;
      if (!script) {
        eprintln(ctx.io, 'npm error Missing script: "test"');
        return 1;
      }
      return runScriptCmd(ctx, 'test', script);
    }
    if (sub === 'run' || sub === 'run-script') {
      const name = argv[2];
      if (!name) {
        println(ctx.io, `Lifecycle scripts included in ${pkg?.name}:\n${Object.entries(pkg?.scripts ?? {}).map(([k, v]) => `  ${k}\n    ${v}`).join('\n')}`);
        return 0;
      }
      const script = pkg?.scripts?.[name];
      if (!script) {
        eprintln(ctx.io, `npm error Missing script: "${name}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run`);
        return 1;
      }
      if (name === 'start') return nodeServer(ctx);
      return runScriptCmd(ctx, name, script);
    }
    if (sub === 'start') return nodeServer(ctx);
    if (sub === 'audit') {
      println(ctx.io, 'found 0 vulnerabilities');
      return 0;
    }
    if (sub === 'ls' || sub === 'list') {
      println(ctx.io, `${pkg?.name}@${pkg?.version} ${ctx.sess.cwd}\n${Object.entries(pkg?.dependencies ?? {}).map(([k, v]) => `└── ${k}@${String(v).replace('^', '')}`).join('\n')}`);
      return 0;
    }
    println(ctx.io, C.dim(`(npm ${sub}: simulado)`));
    return 0;
  },
};

async function nodeServer(ctx: CmdCtx): Promise<number> {
  const files = ctx.sess.fs.snapshot(ctx.sess.cwd, (r) => r.startsWith('node_modules/'));
  for (const l of startupLog({ files, env: ctx.sess.env })) println(ctx.io, l);
  if (detectKind(files) === 'node' && !ctx.sess.fs.exists(ctx.sess.resolve('node_modules')) && Object.keys(readPkg(ctx)?.dependencies ?? {}).length) {
    eprintln(ctx.io, `node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module 'express'\n(Ejecuta "npm install" antes de arrancar la aplicación.)`);
    return 1;
  }
  hint(ctx.io, `La app quedaría escuchando en el puerto ${appListenPort({ files, env: ctx.sess.env })}. En el simulador, para probarla usa Docker (docker build + docker run -p) o despliégala en Azure.`);
  return 0;
}

const nodeCmd: CommandDef = {
  summary: 'Ejecuta JavaScript con Node.js',
  async fn(argv, ctx) {
    const a = argv[1];
    if (!a) {
      println(ctx.io, C.dim('(El REPL de Node no está disponible en el simulador.)'));
      return 0;
    }
    if (a === '-v' || a === '--version') {
      println(ctx.io, 'v20.18.0');
      return 0;
    }
    if (a === '-e' || a === '-p') {
      const code = argv[2] ?? '';
      const m = /console\.log\((.*)\)/.exec(code);
      const expr = (m ? m[1] : code).trim();
      const lit = /^(['"`])(.*)\1$/.exec(expr);
      if (lit) println(ctx.io, lit[2]);
      else if (/^[\d\s+\-*/().]+$/.test(expr)) println(ctx.io, String(Function(`return (${expr})`)()));
      else if (/^process\.version$/.test(expr)) println(ctx.io, 'v20.18.0');
      else println(ctx.io, C.dim('(el simulador sólo evalúa console.log de literales o aritmética simple)'));
      return 0;
    }
    const files = ctx.sess.fs.snapshot(ctx.sess.cwd, (r) => r.startsWith('node_modules/'));
    const rel = a.replace(/^\.\//, '');
    if (files[rel] === undefined) {
      eprintln(ctx.io, `node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '${ctx.sess.resolve(a)}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n\nNode.js v20.18.0`);
      return 1;
    }
    if (/test/i.test(rel) || /readFileSync/.test(files[rel])) {
      const r = runNodeTests(files, rel);
      for (const l of r.output) (r.ok ? println : eprintln)(ctx.io, l);
      return r.ok ? 0 : 1;
    }
    return nodeServer(ctx);
  },
};

const python: CommandDef = {
  summary: 'Intérprete de Python',
  async fn(argv, ctx) {
    const a = argv[1];
    if (a === '--version' || a === '-V') {
      println(ctx.io, 'Python 3.12.3');
      return 0;
    }
    if (a === '-m' && argv[2] === 'venv') {
      const dir = ctx.sess.resolve(argv[3] ?? '.venv');
      ctx.sess.fs.mkdir(`${dir}/bin`, true);
      ctx.sess.fs.writeFile(`${dir}/bin/activate`, '# activado (simulado)\nexport VIRTUAL_ENV=' + dir + '\n');
      return 0;
    }
    if (a === '-m' && argv[2] === 'pip') return pip.fn(['pip', ...argv.slice(3)], ctx) as Promise<number>;
    if (a === '-c') {
      const m = /print\((['"])(.*)\1\)/.exec(argv[2] ?? '');
      println(ctx.io, m ? m[2] : '');
      return 0;
    }
    if (!a) {
      println(ctx.io, C.dim('(El REPL de Python no está disponible en el simulador.)'));
      return 0;
    }
    const files = ctx.sess.fs.snapshot(ctx.sess.cwd);
    if (files[a.replace(/^\.\//, '')] === undefined) {
      eprintln(ctx.io, `python3: can't open file '${ctx.sess.resolve(a)}': [Errno 2] No such file or directory`);
      return 2;
    }
    for (const l of startupLog({ files, env: ctx.sess.env })) println(ctx.io, l);
    return 0;
  },
};

const pip: CommandDef = {
  summary: 'Gestor de paquetes de Python',
  async fn(argv, ctx) {
    if (argv[1] === 'install') {
      const reqIdx = argv.indexOf('-r');
      let pkgs = argv.slice(2).filter((x) => !x.startsWith('-'));
      if (reqIdx > 0) {
        try {
          pkgs = ctx.sess.fs.readFile(ctx.sess.resolve(argv[reqIdx + 1])).split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
        } catch {
          eprintln(ctx.io, `ERROR: Could not open requirements file: [Errno 2] No such file or directory: '${argv[reqIdx + 1]}'`);
          return 1;
        }
      }
      await delay(300, ctx.io);
      println(ctx.io, `Collecting ${pkgs.join('\nCollecting ')}\nInstalling collected packages: ${pkgs.map((p) => p.split(/[=<>]/)[0]).join(', ')}\nSuccessfully installed ${pkgs.map((p) => p.split(/[=<>]/)[0] + '-1.0.0').join(' ')}`);
      return 0;
    }
    if (argv[1] === '--version') {
      println(ctx.io, 'pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)');
      return 0;
    }
    if (argv[1] === 'freeze' || argv[1] === 'list') {
      println(ctx.io, 'flask==3.0.3\ngunicorn==23.0.0');
      return 0;
    }
    println(ctx.io, C.dim(`(pip ${argv[1] ?? ''}: simulado)`));
    return 0;
  },
};

// ---------------------------------------------------------------- sqlcmd

const sqlcmd: CommandDef = {
  summary: 'Cliente de línea de comandos de SQL Server / Azure SQL',
  async fn(argv, ctx) {
    const { opts, flags } = parseFlags(argv.slice(1), ['S', 'd', 'U', 'P', 'Q', 'q', 'i', 'l', 'G']);
    if (flags.has('?') || !opts.S) {
      println(ctx.io, 'Microsoft (R) SQL Server Command Line Tool Version 1.8.0\n\nusage: sqlcmd -S <servidor> -d <base de datos> -U <usuario> -P <contraseña> [-Q "consulta" | -i fichero.sql]');
      return opts.S ? 0 : 1;
    }
    let password = opts.P;
    if (password === undefined && ctx.io.prompt) password = await ctx.io.prompt('Password: ', { secret: true });
    let conn;
    try {
      conn = connect(opts.S.replace(/^tcp:/, '').replace(/,1433$/, ''), opts.d, opts.U ?? '', password ?? '');
    } catch (e) {
      if (e instanceof ArmError) {
        eprintln(ctx.io, e.message);
        if (e.tip) hint(ctx.io, e.tip);
        return 1;
      }
      throw e;
    }
    const runSql = (sql: string) => {
      try {
        const out = formatSqlResults(execSql(conn!, sql));
        if (out) println(ctx.io, out);
        return 0;
      } catch (e) {
        if (e instanceof ArmError) {
          eprintln(ctx.io, `Msg ${e.code}, Level 16, State 1, Server ${conn!.server.name}, Line 1\n${e.message}`);
          return 1;
        }
        throw e;
      }
    };
    if (opts.Q) return runSql(opts.Q);
    if (opts.i) {
      try {
        return runSql(ctx.sess.fs.readFile(ctx.sess.resolve(opts.i)));
      } catch {
        eprintln(ctx.io, `Sqlcmd: '${opts.i}': Invalid filename.`);
        return 1;
      }
    }
    if (!ctx.io.prompt) return 0;
    if (opts.q) runSql(opts.q);
    println(ctx.io, C.dim('(sqlcmd interactivo: escribe tus sentencias, "GO" para ejecutar y "exit" para salir)'));
    let buf: string[] = [];
    let n = 1;
    for (;;) {
      const line = (await ctx.io.prompt(`${n}> `)).trim();
      if (/^(exit|quit)$/i.test(line)) break;
      if (/^go$/i.test(line)) {
        if (buf.length) runSql(buf.join('\n'));
        buf = [];
        n = 1;
        continue;
      }
      buf.push(line);
      n++;
    }
    return 0;
  },
};

// ---------------------------------------------------------------- terraform

const terraform: CommandDef = {
  summary: 'Infraestructura como código con Terraform',
  async fn(argv, ctx) {
    const args = argv.slice(1).filter((a) => !a.startsWith('-chdir='));
    const chdir = argv.find((a) => a.startsWith('-chdir='))?.slice(7);
    const base = chdir ? ctx.sess.resolve(chdir) : ctx.sess.cwd;
    const fs = ctx.sess.fs;
    const io = {
      out: (s: string) => ctx.io.out(s + '\n'),
      err: (s: string) => ctx.io.err(s + '\n'),
      prompt: ctx.io.prompt ? (q: string) => ctx.io.prompt!(q) : undefined,
      files: {
        list: () => (fs.isDir(base) ? fs.list(base).filter((e) => e.node.t === 'f').map((e) => e.name) : []),
        read: (n: string) => {
          try {
            return fs.readFile(n.startsWith('/') ? n : `${base}/${n}`);
          } catch {
            return undefined;
          }
        },
        write: (n: string, c: string) => {
          const p = `${base}/${n}`;
          fs.mkdir(p.split('/').slice(0, -1).join('/'), true);
          fs.writeFile(p, c);
        },
        mkdir: (n: string) => fs.mkdir(`${base}/${n}`, true),
        exists: (n: string) => fs.exists(`${base}/${n}`),
        remove: (n: string) => {
          try {
            fs.rm(`${base}/${n}`, true);
          } catch {
            /* nada */
          }
        },
      },
      env: ctx.sess.env,
      cliPrincipal: ctx.sess.az.loggedIn ? ctx.sess.az.principal : null,
      cliSubscription: ctx.sess.az.subscriptionId,
      color: !argv.includes('-no-color') && ctx.io.isTTY,
    };
    const code = await terraformCommand(args, io);
    changed();
    return code;
  },
};

// ---------------------------------------------------------------- ayuda y stubs

const help: CommandDef = {
  summary: 'Muestra la ayuda del shell simulado',
  fn(_argv, ctx) {
    const sections: [string, string][] = [
      ['Azure', 'az (az --help, az <grupo> --help, az find "texto")'],
      ['Contenedores', 'docker, kubectl'],
      ['IaC', 'terraform, az deployment, az bicep'],
      ['Git y DevOps', 'git, az devops, az repos, az pipelines'],
      ['Red', 'curl, wget, ping, nslookup, dig, nc, ssh, scp, ssh-keygen'],
      ['Ficheros', 'ls, cd, pwd, cat, mkdir, rm, cp, mv, touch, tree, find, chmod, code/nano (editor)'],
      ['Texto', 'echo, printf, grep, sed, awk, cut, sort, uniq, wc, head, tail, tr, jq, tee, xargs'],
      ['Empaquetado', 'zip, unzip, tar'],
      ['Desarrollo', 'npm, node, python3, pip, sqlcmd'],
      ['Shell', 'variables, $(...), |, &&, ||, for, while, if, case, funciones, alias, history, source, export, set -e'],
    ];
    println(ctx.io, C.bold('Azure Lab · Cloud Shell simulado (bash)') + '\n');
    for (const [k, v] of sections) println(ctx.io, `  ${C.cyan(k.padEnd(14))} ${v}`);
    println(ctx.io, `\nAtajos: ↑/↓ historial · Tab autocompletar · Ctrl+C cancelar · Ctrl+L limpiar · Ctrl+A/E inicio/fin de línea`);
    println(ctx.io, `Los ejemplos de los laboratorios están en ${C.boldBlue('~/samples')}.`);
    return 0;
  },
};

const stub = (name: string, msg: string): CommandDef => ({ fn: (_a, ctx) => (eprintln(ctx.io, `${name}: ${msg}`), 127) });

const sudoCloud: CommandDef = {
  fn: (_a, ctx) => {
    eprintln(ctx.io, 'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.\nsudo: If sudo is running in a container, you may need to adjust the container configuration to disable the flag.');
    hint(ctx.io, 'En Cloud Shell no tienes privilegios de root. Para practicar administración de Linux, crea una VM y conéctate con ssh.');
    return 1;
  },
};

const aptCloud: CommandDef = {
  fn: (_a, ctx) => {
    eprintln(ctx.io, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
    hint(ctx.io, 'Cloud Shell ya trae las herramientas habituales (az, kubectl, terraform, docker...). Para instalar paquetes usa una VM.');
    return 100;
  },
};

const openCmd: CommandDef = {
  fn(argv, ctx) {
    if (!argv[1]) return 1;
    ctx.sess.ui.openUrl?.(argv[1]);
    return 0;
  },
};

export const DEV_COMMANDS: Record<string, CommandDef> = {
  zip,
  unzip,
  tar,
  jq,
  npm,
  npx: { fn: (argv, ctx) => (println(ctx.io, C.dim(`(npx ${argv.slice(1).join(' ')}: simulado)`)), 0) },
  node: nodeCmd,
  python,
  python3: python,
  pip,
  pip3: pip,
  sqlcmd,
  terraform,
  tf: terraform,
  help,
  sudo: sudoCloud,
  apt: aptCloud,
  'apt-get': aptCloud,
  open: openCmd,
  'xdg-open': openCmd,
  helm: stub('helm', 'no está disponible en el simulador (usa kubectl apply con manifiestos).'),
  pwsh: stub('pwsh', 'PowerShell no está disponible en este Cloud Shell simulado; usa bash y az.'),
  powershell: stub('powershell', 'PowerShell no está disponible en este Cloud Shell simulado; usa bash y az.'),
  dotnet: { fn: (argv, ctx) => (println(ctx.io, argv[1] === '--version' ? '8.0.403' : C.dim(`(dotnet ${argv.slice(1).join(' ')}: simulado)`)), 0) },
  java: { fn: (argv, ctx) => (println(ctx.io, 'openjdk version "17.0.12" 2024-07-16'), 0) },
  mvn: stub('mvn', 'Maven no está disponible en el simulador.'),
  go: { fn: (argv, ctx) => (println(ctx.io, argv[1] === 'version' ? 'go version go1.23.2 linux/amd64' : C.dim('(go: simulado)')), 0) },
  bicep: { fn: (argv, ctx) => ctx.sess.dispatch(['az', 'bicep', ...argv.slice(1)], ctx.io) },
};

export function zipMagic() {
  return ZIP_MAGIC;
}

export function _devUnused() {
  return getState;
}
