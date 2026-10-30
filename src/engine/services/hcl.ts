// Parser y evaluador de HCL (HashiCorp Configuration Language) para el Terraform simulado.

export class HclError extends Error {
  constructor(public file: string, public line: number, public summary: string, public detail: string) {
    super(`${summary}: ${detail}`);
  }
}

type Tok = { t: 'nl' | 'id' | 'num' | 'str' | 'heredoc' | 'p'; v: string; line: number; raw?: string };

function tokenize(src: string, file: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const push = (t: Tok['t'], v: string, l = line) => out.push({ t, v, line: l });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      if (out.length && out[out.length - 1].t !== 'nl') push('nl', '\n');
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      const m = /^<<(-?)([A-Za-z_]\w*)\r?\n/.exec(src.slice(i));
      if (m) {
        const l = line;
        i += m[0].length;
        line++;
        const lines: string[] = [];
        for (;;) {
          const end = src.indexOf('\n', i);
          const ln = src.slice(i, end < 0 ? undefined : end).replace(/\r$/, '');
          i = end < 0 ? src.length : end + 1;
          line++;
          if (ln.trim() === m[2]) break;
          lines.push(ln);
          if (end < 0) throw new HclError(file, l, 'Unterminated template string', `The heredoc marker "${m[2]}" was not closed.`);
        }
        let body = lines;
        if (m[1] === '-') {
          const ind = Math.min(...body.filter((x) => x.trim()).map((x) => x.match(/^\s*/)![0].length));
          body = body.map((x) => x.slice(isFinite(ind) ? ind : 0));
        }
        push('heredoc', body.join('\n') + '\n', l);
        push('nl', '\n');
        continue;
      }
    }
    if (c === '"') {
      const l = line;
      let j = i + 1;
      let raw = '';
      let depth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') {
          raw += ch + src[j + 1];
          j += 2;
          continue;
        }
        if ((ch === '$' || ch === '%') && src[j + 1] === '{') {
          depth++;
          raw += ch + '{';
          j += 2;
          continue;
        }
        if (depth > 0 && ch === '"') {
          // cadena dentro de la interpolación
          raw += ch;
          j++;
          while (j < src.length && src[j] !== '"') {
            if (src[j] === '\\') {
              raw += src[j];
              j++;
            }
            raw += src[j];
            j++;
          }
          raw += '"';
          j++;
          continue;
        }
        if (depth > 0 && ch === '}') {
          depth--;
          raw += ch;
          j++;
          continue;
        }
        if (ch === '"' && depth === 0) break;
        if (ch === '\n') throw new HclError(file, l, 'Invalid multi-line string', 'Quoted strings may not be split over multiple lines. To produce a multi-line string, either use the \\n escape to represent a newline character or use the "heredoc" multi-line template syntax.');
        raw += ch;
        j++;
      }
      if (j >= src.length) throw new HclError(file, l, 'Unterminated template string', 'No closing marker was found for the string.');
      push('str', raw, l);
      i = j + 1;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.eE]/.test(src[j])) j++;
      push('num', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w-]/.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '=>', '...'].includes(two) || src.slice(i, i + 3) === '...') {
      const v = src.slice(i, i + 3) === '...' ? '...' : two;
      push('p', v);
      i += v.length;
      continue;
    }
    if ('{}[](),=.:?!<>+-*/%'.includes(c)) {
      push('p', c);
      i++;
      continue;
    }
    throw new HclError(file, line, 'Invalid character', `The "${c}" character is not valid. Expressions and identifiers may only contain letters, digits, underscores, dashes, and periods.`);
  }
  push('nl', '\n');
  return out;
}

export type HExpr =
  | { k: 'lit'; v: any }
  | { k: 'tpl'; parts: (string | HExpr)[] }
  | { k: 'trav'; root: string; steps: ({ attr: string } | { idx: HExpr } | { splat: true })[]; line: number }
  | { k: 'list'; items: HExpr[] }
  | { k: 'obj'; items: { key: HExpr; value: HExpr }[] }
  | { k: 'call'; fn: string; args: HExpr[]; expand?: boolean }
  | { k: 'bin'; op: string; a: HExpr; b: HExpr }
  | { k: 'un'; op: string; a: HExpr }
  | { k: 'cond'; c: HExpr; a: HExpr; b: HExpr }
  | { k: 'for'; key?: string; val: string; coll: HExpr; out: HExpr; outKey?: HExpr; cond?: HExpr; isObj: boolean }
  | { k: 'get'; obj: HExpr; steps: ({ attr: string } | { idx: HExpr })[] };

export interface HAttr {
  expr: HExpr;
  line: number;
}

export interface HBlock {
  type: string;
  labels: string[];
  body: HBody;
  line: number;
  file: string;
}

export interface HBody {
  attrs: Record<string, HAttr>;
  blocks: HBlock[];
}

class Parser {
  i = 0;
  constructor(private toks: Tok[], private file: string) {}
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  next() {
    return this.toks[this.i++];
  }
  err(summary: string, detail: string, t = this.peek()): never {
    throw new HclError(this.file, t?.line ?? 0, summary, detail);
  }
  isP(v: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.t === 'p' && t.v === v;
  }
  skipNl() {
    while (this.peek()?.t === 'nl') this.i++;
  }
  body(end?: string): HBody {
    const b: HBody = { attrs: {}, blocks: [] };
    for (;;) {
      this.skipNl();
      const t = this.peek();
      if (!t) {
        if (end) this.err('Unclosed configuration block', `There is no closing brace for this block before the end of the file.`);
        break;
      }
      if (end && t.t === 'p' && t.v === end) {
        this.next();
        break;
      }
      if (t.t !== 'id') this.err('Argument or block definition required', 'An argument or block definition is required here.');
      const name = this.next().v;
      if (this.isP('=')) {
        this.next();
        if (b.attrs[name]) this.err('Attribute redefined', `The argument "${name}" was already set. Each argument may be set only once.`, t);
        b.attrs[name] = { expr: this.expr(), line: t.line };
        if (this.peek() && this.peek().t !== 'nl' && !(end && this.isP(end))) this.err('Missing newline after argument', 'An argument definition must end with a newline.');
        continue;
      }
      const labels: string[] = [];
      while (this.peek()?.t === 'str' || this.peek()?.t === 'id') labels.push(this.next().v);
      if (!this.isP('{')) this.err('Invalid block definition', 'Either a quoted string block label or an opening brace ("{") is expected here.');
      this.next();
      b.blocks.push({ type: name, labels, body: this.body('}'), line: t.line, file: this.file });
    }
    return b;
  }
  expr(): HExpr {
    const c = this.or();
    if (this.isP('?')) {
      this.next();
      this.skipNl();
      const a = this.expr();
      this.skipNl();
      if (!this.isP(':')) this.err('Missing false expression in conditional', 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.');
      this.next();
      this.skipNl();
      return { k: 'cond', c, a, b: this.expr() };
    }
    return c;
  }
  bin(sub: () => HExpr, ops: string[]): HExpr {
    let a = sub();
    while (ops.some((o) => this.isP(o))) {
      const op = this.next().v;
      this.skipNl();
      a = { k: 'bin', op, a, b: sub() };
    }
    return a;
  }
  or(): HExpr {
    return this.bin(() => this.and(), ['||']);
  }
  and(): HExpr {
    return this.bin(() => this.eq(), ['&&']);
  }
  eq(): HExpr {
    return this.bin(() => this.rel(), ['==', '!=']);
  }
  rel(): HExpr {
    return this.bin(() => this.add(), ['<', '>', '<=', '>=']);
  }
  add(): HExpr {
    return this.bin(() => this.mul(), ['+', '-']);
  }
  mul(): HExpr {
    return this.bin(() => this.unary(), ['*', '/', '%']);
  }
  unary(): HExpr {
    if (this.isP('!')) {
      this.next();
      return { k: 'un', op: '!', a: this.unary() };
    }
    if (this.isP('-')) {
      this.next();
      return { k: 'un', op: '-', a: this.unary() };
    }
    return this.postfix();
  }
  postfix(): HExpr {
    let e = this.primary();
    const steps: ({ attr: string } | { idx: HExpr })[] = [];
    for (;;) {
      if (this.isP('.')) {
        this.next();
        const t = this.next();
        if (t.t === 'num') steps.push({ idx: { k: 'lit', v: Number(t.v) } });
        else if (t.t === 'p' && t.v === '*') steps.push({ attr: '*' });
        else steps.push({ attr: t.v });
      } else if (this.isP('[')) {
        this.next();
        if (this.isP('*')) {
          this.next();
          this.next();
          steps.push({ attr: '*' });
          continue;
        }
        const idx = this.expr();
        if (!this.isP(']')) this.err('Missing close bracket on index', 'The index operator must end with a closing bracket ("]").');
        this.next();
        steps.push({ idx });
      } else break;
    }
    if (!steps.length) return e;
    if (e.k === 'trav') return { ...e, steps: [...e.steps, ...steps] };
    return { k: 'get', obj: e, steps };
  }
  primary(): HExpr {
    const t = this.next();
    if (!t) this.err('Invalid expression', 'Expected the start of an expression, but found the end of the file.');
    if (t.t === 'num') return { k: 'lit', v: Number(t.v) };
    if (t.t === 'str') return this.template(t.v, t.line);
    if (t.t === 'heredoc') return this.template(t.v, t.line, true);
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (this.isP('(')) {
        this.next();
        const args: HExpr[] = [];
        let expand = false;
        this.skipNl();
        while (!this.isP(')')) {
          args.push(this.expr());
          if (this.isP('...')) {
            this.next();
            expand = true;
          }
          this.skipNl();
          if (this.isP(',')) {
            this.next();
            this.skipNl();
          } else if (!this.isP(')')) this.err('Missing argument separator', 'A comma is required to separate each function argument from the next.');
        }
        this.next();
        return { k: 'call', fn: t.v, args, expand };
      }
      return { k: 'trav', root: t.v, steps: [], line: t.line };
    }
    if (t.t === 'p' && t.v === '(') {
      this.skipNl();
      const e = this.expr();
      this.skipNl();
      if (!this.isP(')')) this.err('Unbalanced parentheses', 'Expected a closing parenthesis to terminate the expression.');
      this.next();
      return e;
    }
    if (t.t === 'p' && t.v === '[') {
      this.skipNl();
      if (this.peek()?.t === 'id' && this.peek()?.v === 'for') return this.forExpr(false);
      const items: HExpr[] = [];
      while (!this.isP(']')) {
        items.push(this.expr());
        this.skipNl();
        if (this.isP(',')) {
          this.next();
          this.skipNl();
        } else if (!this.isP(']')) this.err('Missing item separator', 'Expected a comma to mark the beginning of the next item.');
      }
      this.next();
      return { k: 'list', items };
    }
    if (t.t === 'p' && t.v === '{') {
      this.skipNl();
      if (this.peek()?.t === 'id' && this.peek()?.v === 'for') return this.forExpr(true);
      const items: { key: HExpr; value: HExpr }[] = [];
      while (!this.isP('}')) {
        const kt = this.peek();
        let key: HExpr;
        if (kt.t === 'id' && (this.isP('=', 1) || this.isP(':', 1))) {
          this.next();
          key = { k: 'lit', v: kt.v };
        } else key = this.expr();
        if (!this.isP('=') && !this.isP(':')) this.err('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value.');
        this.next();
        this.skipNl();
        items.push({ key, value: this.expr() });
        if (this.isP(',')) this.next();
        this.skipNl();
      }
      this.next();
      return { k: 'obj', items };
    }
    this.err('Invalid expression', `Expected the start of an expression, but found "${t.v}".`, t);
  }
  forExpr(isObj: boolean): HExpr {
    this.next();
    let key: string | undefined;
    let val = this.next().v;
    if (this.isP(',')) {
      this.next();
      key = val;
      val = this.next().v;
    }
    if (this.peek()?.v !== 'in') this.err('Invalid for expression', 'Expected "in" keyword.');
    this.next();
    const coll = this.expr();
    if (!this.isP(':')) this.err('Invalid for expression', 'Expected ":" after the collection expression.');
    this.next();
    this.skipNl();
    let outKey: HExpr | undefined;
    let out = this.expr();
    if (isObj && this.isP('=>')) {
      this.next();
      outKey = out;
      out = this.expr();
    }
    let cond: HExpr | undefined;
    this.skipNl();
    if (this.peek()?.v === 'if') {
      this.next();
      cond = this.expr();
    }
    this.skipNl();
    this.next();
    return { k: 'for', key, val, coll, out, outKey, cond, isObj };
  }
  template(raw: string, line: number, heredoc = false): HExpr {
    const parts: (string | HExpr)[] = [];
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\' && !heredoc) {
        const n = raw[i + 1];
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '"' ? '"' : n === '\\' ? '\\' : '\\' + n;
        i++;
        continue;
      }
      if (c === '$' && raw[i + 1] === '$' && raw[i + 2] === '{') {
        cur += '${';
        i += 2;
        continue;
      }
      if (c === '$' && raw[i + 1] === '{') {
        if (cur) parts.push(cur);
        cur = '';
        let depth = 1;
        let j = i + 2;
        while (j < raw.length && depth > 0) {
          if (raw[j] === '"') {
            j++;
            while (j < raw.length && raw[j] !== '"') j++;
          } else if (raw[j] === '{') depth++;
          else if (raw[j] === '}') depth--;
          if (depth > 0) j++;
        }
        const inner = raw.slice(i + 2, j).replace(/^~|~$/g, '');
        const p = new Parser(tokenize(inner, this.file).filter((x) => x.t !== 'nl').map((x) => ({ ...x, line })), this.file);
        parts.push(p.expr());
        i = j;
        continue;
      }
      cur += c;
    }
    if (cur || !parts.length) parts.push(cur);
    if (parts.length === 1 && typeof parts[0] === 'string') return { k: 'lit', v: parts[0] };
    return { k: 'tpl', parts };
  }
}

export function parseHcl(src: string, file: string): HBody {
  return new Parser(tokenize(src, file), file).body();
}

// ---------------------------------------------------------------- evaluación

export const UNKNOWN: any = Object.freeze({ __unknown: true, toString: () => '(known after apply)' });
export const isUnknown = (v: any) => v === UNKNOWN || (v && typeof v === 'object' && v.__unknown === true);

function anyUnknown(v: any): boolean {
  if (isUnknown(v)) return true;
  if (Array.isArray(v)) return v.some(anyUnknown);
  if (v && typeof v === 'object') return Object.values(v).some(anyUnknown);
  return false;
}

export interface EvalScope {
  lookup(root: string, steps: { attr?: string; idx?: any }[], line: number): any;
  readFile?(path: string): string;
  locals?: Record<string, any>;
}

function cidrsubnet(prefix: string, newbits: number, netnum: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(prefix);
  if (!m) throw new Error(`invalid CIDR address: ${prefix}`);
  const base = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
  const bits = +m[5];
  const nb = bits + newbits;
  if (nb > 32) throw new Error(`insufficient address space to extend prefix of ${bits} by ${newbits}`);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const net = ((base & mask) >>> 0) + netnum * 2 ** (32 - nb);
  return `${[net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.')}/${nb}`;
}

function sha1ish(s: string): string {
  let h1 = 0x811c9dc5;
  let out = '';
  for (let r = 0; r < 5; r++) {
    for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193 + r);
    out += (h1 >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

const FUNCS: Record<string, (args: any[], sc: EvalScope) => any> = {
  lower: ([s]) => String(s).toLowerCase(),
  upper: ([s]) => String(s).toUpperCase(),
  title: ([s]) => String(s).replace(/\b\w/g, (c) => c.toUpperCase()),
  trimspace: ([s]) => String(s).trim(),
  trim: ([s, c]) => String(s).replace(new RegExp(`^[${c}]+|[${c}]+$`, 'g'), ''),
  format: ([f, ...rest]) => {
    let i = 0;
    return String(f).replace(/%%|%[-0-9.]*[sdvqf]/g, (m) => (m === '%%' ? '%' : m.endsWith('q') ? JSON.stringify(rest[i++]) : String(rest[i++])));
  },
  join: ([sep, list]) => (list as any[]).join(sep),
  split: ([sep, s]) => String(s).split(sep),
  replace: ([s, a, b]) => (String(a).startsWith('/') && String(a).endsWith('/') ? String(s).replace(new RegExp(String(a).slice(1, -1), 'g'), b) : String(s).split(a).join(b)),
  substr: ([s, off, len]) => String(s).substr(off, len < 0 ? undefined : len),
  length: ([v]) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : String(v).length),
  concat: (args) => args.flat(),
  merge: (args) => Object.assign({}, ...args),
  lookup: ([m, k, d]) => (m && k in m ? m[k] : d),
  element: ([l, i]) => l[i % l.length],
  contains: ([l, v]) => (l as any[]).includes(v),
  keys: ([m]) => Object.keys(m).sort(),
  values: ([m]) => Object.keys(m).sort().map((k) => m[k]),
  coalesce: (args) => args.find((a) => a !== null && a !== undefined && a !== ''),
  min: (args) => Math.min(...args.flat()),
  max: (args) => Math.max(...args.flat()),
  abs: ([n]) => Math.abs(n),
  ceil: ([n]) => Math.ceil(n),
  floor: ([n]) => Math.floor(n),
  tostring: ([v]) => (v === null ? null : String(v)),
  tonumber: ([v]) => Number(v),
  tobool: ([v]) => v === true || v === 'true',
  tolist: ([v]) => [...v],
  toset: ([v]) => [...new Set(v)],
  tomap: ([v]) => ({ ...v }),
  flatten: ([v]) => (v as any[]).flat(Infinity),
  distinct: ([v]) => [...new Set(v)],
  range: (a) => {
    const [start, end, step] = a.length === 1 ? [0, a[0], 1] : [a[0], a[1], a[2] ?? 1];
    const out = [];
    for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
    return out;
  },
  cidrsubnet: ([p, nb, nn]) => cidrsubnet(p, nb, nn),
  cidrhost: ([p, n]) => {
    const net = cidrsubnet(p, 0, 0).split('/')[0].split('.').map(Number);
    const v = ((net[0] << 24) >>> 0) + (net[1] << 16) + (net[2] << 8) + net[3] + n;
    return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
  },
  jsonencode: ([v]) => JSON.stringify(v),
  jsondecode: ([s]) => JSON.parse(s),
  base64encode: ([s]) => btoa(unescape(encodeURIComponent(String(s)))),
  base64decode: ([s]) => decodeURIComponent(escape(atob(String(s)))),
  sha1: ([s]) => sha1ish(String(s)),
  md5: ([s]) => sha1ish(String(s)).slice(0, 32),
  uuid: () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : '00000000-0000-4000-8000-000000000000'),
  timestamp: () => new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  file: ([p], sc) => {
    if (!sc.readFile) throw new Error('file() no disponible');
    return sc.readFile(p);
  },
  templatefile: ([p, vars], sc) => {
    const txt = sc.readFile ? sc.readFile(p) : '';
    return txt.replace(/\$\{\s*(\w+)\s*\}/g, (_, k) => String(vars?.[k] ?? ''));
  },
  try: (args) => args.find((a) => a !== undefined && !isUnknown(a)),
  can: ([v]) => v !== undefined,
  startswith: ([s, p]) => String(s).startsWith(p),
  endswith: ([s, p]) => String(s).endsWith(p),
  regex: ([re, s]) => (new RegExp(re).exec(s) ?? [''])[0],
  one: ([l]) => (l?.length ? l[0] : null),
  sort: ([l]) => [...l].sort(),
  reverse: ([l]) => [...l].reverse(),
  zipmap: ([k, v]) => Object.fromEntries((k as any[]).map((x, i) => [x, v[i]])),
  index: ([l, v]) => (l as any[]).indexOf(v),
  sum: ([l]) => (l as number[]).reduce((a, b) => a + b, 0),
};

export function evalHcl(e: HExpr, sc: EvalScope): any {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'tpl': {
      const vals = e.parts.map((p) => (typeof p === 'string' ? p : evalHcl(p, sc)));
      if (vals.some(anyUnknown)) return UNKNOWN;
      if (e.parts.length === 1 && typeof e.parts[0] !== 'string') return vals[0];
      return vals.map((v) => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join('');
    }
    case 'trav': {
      const steps = e.steps.map((s) => ('idx' in s ? { idx: evalHcl(s.idx, sc) } : 'attr' in s ? { attr: s.attr } : { attr: '*' }));
      return sc.lookup(e.root, steps, e.line);
    }
    case 'get': {
      let v = evalHcl(e.obj, sc);
      for (const s of e.steps) {
        if (isUnknown(v)) return UNKNOWN;
        v = 'idx' in s ? v?.[evalHcl(s.idx, sc)] : v?.[s.attr];
      }
      return v;
    }
    case 'list':
      return e.items.map((x) => evalHcl(x, sc));
    case 'obj': {
      const o: Record<string, any> = {};
      for (const it of e.items) {
        const k = it.key.k === 'trav' && !it.key.steps.length ? it.key.root : evalHcl(it.key, sc);
        o[String(k)] = evalHcl(it.value, sc);
      }
      return o;
    }
    case 'call': {
      const fn = FUNCS[e.fn];
      if (!fn) throw new Error(`Call to unknown function: There is no function named "${e.fn}".`);
      let args = e.args.map((a) => evalHcl(a, sc));
      if (e.expand && args.length) args = [...args.slice(0, -1), ...(args[args.length - 1] as any[])];
      if (e.fn !== 'try' && e.fn !== 'coalesce' && args.some(anyUnknown)) return UNKNOWN;
      return fn(args, sc);
    }
    case 'un': {
      const a = evalHcl(e.a, sc);
      if (isUnknown(a)) return UNKNOWN;
      return e.op === '!' ? !a : -a;
    }
    case 'bin': {
      const a = evalHcl(e.a, sc);
      const b = evalHcl(e.b, sc);
      if (isUnknown(a) || isUnknown(b)) return UNKNOWN;
      switch (e.op) {
        case '==':
          return JSON.stringify(a) === JSON.stringify(b);
        case '!=':
          return JSON.stringify(a) !== JSON.stringify(b);
        case '<':
          return a < b;
        case '>':
          return a > b;
        case '<=':
          return a <= b;
        case '>=':
          return a >= b;
        case '&&':
          return a && b;
        case '||':
          return a || b;
        case '+':
          return Number(a) + Number(b);
        case '-':
          return Number(a) - Number(b);
        case '*':
          return Number(a) * Number(b);
        case '/':
          return Number(a) / Number(b);
        case '%':
          return Number(a) % Number(b);
      }
      return undefined;
    }
    case 'cond': {
      const c = evalHcl(e.c, sc);
      if (isUnknown(c)) return UNKNOWN;
      return c ? evalHcl(e.a, sc) : evalHcl(e.b, sc);
    }
    case 'for': {
      const coll = evalHcl(e.coll, sc);
      if (isUnknown(coll)) return UNKNOWN;
      const entries: [any, any][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries(coll ?? {});
      const outList: any[] = [];
      const outObj: Record<string, any> = {};
      for (const [k, v] of entries) {
        const inner: EvalScope = {
          ...sc,
          lookup: (root, steps, line) => {
            if (root === e.val) return applySteps(v, steps);
            if (e.key && root === e.key) return applySteps(k, steps);
            return sc.lookup(root, steps, line);
          },
        };
        if (e.cond && !evalHcl(e.cond, inner)) continue;
        if (e.isObj) outObj[String(evalHcl(e.outKey!, inner))] = evalHcl(e.out, inner);
        else outList.push(evalHcl(e.out, inner));
      }
      return e.isObj ? outObj : outList;
    }
  }
}

export function applySteps(v: any, steps: { attr?: string; idx?: any }[]): any {
  let cur = v;
  for (const s of steps) {
    if (isUnknown(cur)) return UNKNOWN;
    if (cur === null || cur === undefined) return undefined;
    if (s.attr === '*') {
      if (!Array.isArray(cur)) cur = [cur];
      continue;
    }
    if (Array.isArray(cur) && s.attr !== undefined && isNaN(Number(s.attr))) {
      const attr = s.attr;
      cur = cur.map((x) => x?.[attr]);
      continue;
    }
    cur = s.attr !== undefined ? cur[s.attr] : cur[s.idx];
  }
  return cur;
}

/** Recoge las referencias (raíces de traversals) de una expresión, para el grafo de dependencias. */
export function collectRefs(e: HExpr, out: string[] = []): string[] {
  switch (e.k) {
    case 'trav': {
      const parts = [e.root, ...e.steps.map((s) => ('attr' in s ? s.attr : '[]'))];
      out.push(parts.join('.'));
      for (const s of e.steps) if ('idx' in s) collectRefs(s.idx, out);
      break;
    }
    case 'tpl':
      e.parts.forEach((p) => typeof p !== 'string' && collectRefs(p, out));
      break;
    case 'list':
      e.items.forEach((x) => collectRefs(x, out));
      break;
    case 'obj':
      e.items.forEach((x) => {
        collectRefs(x.key, out);
        collectRefs(x.value, out);
      });
      break;
    case 'call':
      e.args.forEach((x) => collectRefs(x, out));
      break;
    case 'bin':
      collectRefs(e.a, out);
      collectRefs(e.b, out);
      break;
    case 'un':
      collectRefs(e.a, out);
      break;
    case 'cond':
      collectRefs(e.c, out);
      collectRefs(e.a, out);
      collectRefs(e.b, out);
      break;
    case 'for':
      collectRefs(e.coll, out);
      break;
    case 'get':
      collectRefs(e.obj, out);
      break;
  }
  return out;
}

export function bodyRefs(b: HBody, out: string[] = []): string[] {
  for (const a of Object.values(b.attrs)) collectRefs(a.expr, out);
  for (const bl of b.blocks) bodyRefs(bl.body, out);
  return out;
}
