// Compilador Bicep -> plantilla ARM JSON (subconjunto amplio del lenguaje).

export class BicepError extends Error {
  constructor(public line: number, public col: number, public code: string, msg: string) {
    super(msg);
  }
}

type Tok = { t: 'nl' | 'id' | 'num' | 'str' | 'mstr' | 'p'; v: string; line: number; col: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (t: Tok['t'], v: string, l = line, c = col) => out.push({ t, v, line: l, col: c });
  const adv = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\r') {
      adv();
      continue;
    }
    if (c === '\n') {
      if (out.length && out[out.length - 1].t !== 'nl') push('nl', '\n');
      adv();
      continue;
    }
    if (c === ' ' || c === '\t') {
      adv();
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') adv();
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      adv(2);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) adv();
      adv(2);
      continue;
    }
    if (src.startsWith("'''", i)) {
      const l = line;
      const cc = col;
      adv(3);
      const start = i;
      while (i < src.length && !src.startsWith("'''", i)) adv();
      if (i >= src.length) throw new BicepError(l, cc, 'BCP002', 'The multi-line string at this location is not terminated.');
      push('mstr', src.slice(start, i).replace(/^\r?\n/, ''), l, cc);
      adv(3);
      continue;
    }
    if (c === "'") {
      const l = line;
      const cc = col;
      adv();
      let raw = '';
      let depth = 0;
      while (i < src.length) {
        if (src[i] === '\\') {
          raw += src[i] + src[i + 1];
          adv(2);
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          depth++;
          raw += '${';
          adv(2);
          continue;
        }
        if (depth > 0 && src[i] === '}') {
          depth--;
          raw += '}';
          adv();
          continue;
        }
        if (depth > 0 && src[i] === "'") {
          // cadena anidada dentro de la interpolación
          raw += "'";
          adv();
          while (i < src.length && src[i] !== "'") {
            raw += src[i];
            adv();
          }
          raw += "'";
          adv();
          continue;
        }
        if (src[i] === "'" && depth === 0) break;
        if (src[i] === '\n') throw new BicepError(l, cc, 'BCP004', 'The string at this location is not terminated due to an unexpected new line character.');
        raw += src[i];
        adv();
      }
      if (i >= src.length) throw new BicepError(l, cc, 'BCP004', 'The string at this location is not terminated.');
      adv();
      push('str', raw, l, cc);
      continue;
    }
    if (/\d/.test(c)) {
      const l = line;
      const cc = col;
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      push('num', src.slice(i, j), l, cc);
      adv(j - i);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const l = line;
      const cc = col;
      let j = i;
      while (j < src.length && /[\w]/.test(src[j])) j++;
      push('id', src.slice(i, j), l, cc);
      adv(j - i);
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['==', '!=', '=~', '!~', '<=', '>=', '&&', '||', '??', '?.', '::'].includes(two) && three !== '...') {
      push('p', two);
      adv(2);
      continue;
    }
    if ('{}[](),:.?!=<>+-*/%@|'.includes(c)) {
      push('p', c);
      adv();
      continue;
    }
    throw new BicepError(line, col, 'BCP001', `The following token is not recognized: "${c}".`);
  }
  push('nl', '\n');
  return out;
}

// ---------------------------------------------------------------- AST

export type BExpr =
  | { k: 'str'; parts: (string | BExpr)[] }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'id'; name: string; line: number; col: number }
  | { k: 'obj'; props: { key: string; value: BExpr }[] }
  | { k: 'arr'; items: BExpr[] }
  | { k: 'member'; obj: BExpr; name: string }
  | { k: 'index'; obj: BExpr; idx: BExpr }
  | { k: 'call'; fn: string; args: BExpr[]; target?: BExpr }
  | { k: 'un'; op: string; a: BExpr }
  | { k: 'bin'; op: string; a: BExpr; b: BExpr }
  | { k: 'tern'; c: BExpr; a: BExpr; b: BExpr }
  | { k: 'for'; item: string; index?: string; source: BExpr; body: BExpr }
  | { k: 'if'; cond: BExpr; body: BExpr };

interface Decorator {
  name: string;
  args: BExpr[];
}

type Stmt =
  | { k: 'param'; name: string; type: string; decorators: Decorator[]; def?: BExpr; line: number }
  | { k: 'var'; name: string; value: BExpr; line: number }
  | { k: 'resource'; symbol: string; type: string; api: string; existing: boolean; body: BExpr; decorators: Decorator[]; line: number }
  | { k: 'output'; name: string; type: string; value: BExpr; line: number }
  | { k: 'targetScope'; value: BExpr; line: number };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  next() {
    return this.toks[this.i++];
  }
  err(msg: string, code = 'BCP007', t = this.peek()): never {
    throw new BicepError(t?.line ?? 0, t?.col ?? 0, code, msg);
  }
  isP(v: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.t === 'p' && t.v === v;
  }
  isId(v?: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.t === 'id' && (v === undefined || t.v === v);
  }
  expectP(v: string) {
    if (!this.isP(v)) this.err(`Expected the "${v}" character at this location.`, 'BCP018');
    return this.next();
  }
  expectId(): Tok {
    if (!this.isId()) this.err('Expected an identifier at this location.', 'BCP017');
    return this.next();
  }
  skipNl() {
    while (this.peek()?.t === 'nl') this.i++;
  }
  program(): Stmt[] {
    const out: Stmt[] = [];
    let decorators: Decorator[] = [];
    this.skipNl();
    while (this.i < this.toks.length) {
      this.skipNl();
      if (this.i >= this.toks.length) break;
      const t = this.peek();
      if (this.isP('@')) {
        this.next();
        const name = this.expectId().v;
        let args: BExpr[] = [];
        if (this.isP('(')) args = this.args();
        decorators.push({ name, args });
        continue;
      }
      if (t.t !== 'id') this.err(`This declaration type is not recognized. Specify a metadata, parameter, variable, resource, or output declaration.`, 'BCP007');
      switch (t.v) {
        case 'targetScope': {
          this.next();
          this.expectP('=');
          out.push({ k: 'targetScope', value: this.expr(), line: t.line });
          break;
        }
        case 'param': {
          this.next();
          const name = this.expectId().v;
          const type = this.typeExpr();
          let def: BExpr | undefined;
          if (this.isP('=')) {
            this.next();
            def = this.expr();
          }
          out.push({ k: 'param', name, type, decorators, def, line: t.line });
          decorators = [];
          break;
        }
        case 'var': {
          this.next();
          const name = this.expectId().v;
          this.expectP('=');
          out.push({ k: 'var', name, value: this.expr(), line: t.line });
          decorators = [];
          break;
        }
        case 'resource': {
          this.next();
          const symbol = this.expectId().v;
          const ts = this.next();
          if (!ts || ts.t !== 'str') this.err('Expected a resource type string. Specify a valid resource type of format "<types>@<apiVersion>".', 'BCP029', ts);
          const [type, api] = ts.v.split('@');
          if (!api) this.err(`The resource type "${ts.v}" is not valid. Specify a valid resource type of format "<types>@<apiVersion>".`, 'BCP029', ts);
          let existing = false;
          if (this.isId('existing')) {
            this.next();
            existing = true;
          }
          this.expectP('=');
          let body: BExpr;
          if (this.isId('if')) {
            this.next();
            this.expectP('(');
            const cond = this.expr();
            this.expectP(')');
            body = { k: 'if', cond, body: this.objectLit() };
          } else if (this.isP('[') && this.isId('for', 1)) body = this.primary();
          else body = this.objectLit();
          out.push({ k: 'resource', symbol, type, api, existing, body, decorators, line: t.line });
          decorators = [];
          break;
        }
        case 'output': {
          this.next();
          const name = this.expectId().v;
          const type = this.typeExpr();
          this.expectP('=');
          out.push({ k: 'output', name, type, value: this.expr(), line: t.line });
          decorators = [];
          break;
        }
        case 'module':
          this.err('Los módulos (module) todavía no están soportados por el simulador. Pon los recursos en un único fichero.', 'SIM001');
          break;
        case 'metadata':
        case 'import':
        case 'type':
        case 'func':
          while (this.peek() && this.peek().t !== 'nl') this.next();
          break;
        default:
          this.err(`This declaration type is not recognized: "${t.v}". Specify a metadata, parameter, variable, resource, or output declaration.`, 'BCP007');
      }
      if (this.peek() && this.peek().t !== 'nl') this.err('Expected a new line character at this location.', 'BCP019');
    }
    return out;
  }
  typeExpr(): string {
    const t = this.expectId().v;
    if (this.isP('[') && this.isP(']', 1)) {
      this.next();
      this.next();
      return 'array';
    }
    return t;
  }
  args(): BExpr[] {
    this.expectP('(');
    const out: BExpr[] = [];
    this.skipNl();
    while (!this.isP(')')) {
      out.push(this.expr());
      this.skipNl();
      if (this.isP(',')) {
        this.next();
        this.skipNl();
      } else if (!this.isP(')')) this.err('Expected the ")" character at this location.', 'BCP018');
    }
    this.next();
    return out;
  }
  objectLit(): BExpr {
    if (!this.isP('{')) this.err('Expected the "{" character at this location.', 'BCP018');
    return this.primary();
  }
  expr(): BExpr {
    const c = this.or();
    if (this.isP('?')) {
      this.next();
      this.skipNl();
      const a = this.expr();
      this.skipNl();
      this.expectP(':');
      this.skipNl();
      const b = this.expr();
      return { k: 'tern', c, a, b };
    }
    return c;
  }
  or(): BExpr {
    let a = this.coalesce();
    while (this.isP('||')) {
      this.next();
      a = { k: 'bin', op: '||', a, b: this.coalesce() };
    }
    return a;
  }
  coalesce(): BExpr {
    let a = this.and();
    while (this.isP('??')) {
      this.next();
      a = { k: 'bin', op: '??', a, b: this.and() };
    }
    return a;
  }
  and(): BExpr {
    let a = this.eq();
    while (this.isP('&&')) {
      this.next();
      a = { k: 'bin', op: '&&', a, b: this.eq() };
    }
    return a;
  }
  eq(): BExpr {
    let a = this.rel();
    while (['==', '!=', '=~', '!~'].some((o) => this.isP(o))) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.rel() };
    }
    return a;
  }
  rel(): BExpr {
    let a = this.add();
    while (['<', '>', '<=', '>='].some((o) => this.isP(o))) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.add() };
    }
    return a;
  }
  add(): BExpr {
    let a = this.mul();
    while (this.isP('+') || this.isP('-')) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.mul() };
    }
    return a;
  }
  mul(): BExpr {
    let a = this.unary();
    while (this.isP('*') || this.isP('/') || this.isP('%')) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  unary(): BExpr {
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
  postfix(): BExpr {
    let e = this.primary();
    for (;;) {
      if (this.isP('.') || this.isP('?.')) {
        this.next();
        const name = this.expectId().v;
        if (this.isP('(')) e = { k: 'call', fn: name, args: this.args(), target: e };
        else e = { k: 'member', obj: e, name };
      } else if (this.isP('[') && !this.isId('for', 1)) {
        this.next();
        const idx = this.expr();
        this.expectP(']');
        e = { k: 'index', obj: e, idx };
      } else if (this.isP('::')) {
        this.next();
        e = { k: 'member', obj: e, name: this.expectId().v };
      } else break;
    }
    return e;
  }
  primary(): BExpr {
    const t = this.next();
    if (!t) this.err('Unexpected end of file.', 'BCP009');
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'mstr') return { k: 'str', parts: [t.v] };
    if (t.t === 'str') return this.interp(t);
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'null' };
      if (this.isP('(')) return { k: 'call', fn: t.v, args: this.args() };
      return { k: 'id', name: t.v, line: t.line, col: t.col };
    }
    if (t.t === 'p' && t.v === '(') {
      this.skipNl();
      const e = this.expr();
      this.skipNl();
      this.expectP(')');
      return e;
    }
    if (t.t === 'p' && t.v === '{') {
      const props: { key: string; value: BExpr }[] = [];
      this.skipNl();
      while (!this.isP('}')) {
        const kt = this.next();
        if (!kt || (kt.t !== 'id' && kt.t !== 'str')) this.err('Expected a property name at this location.', 'BCP022', kt);
        this.expectP(':');
        const value = this.expr();
        props.push({ key: kt.t === 'str' ? kt.v : kt.v, value });
        if (this.isP(',')) this.next();
        if (!this.isP('}') && this.peek()?.t !== 'nl') this.err('Expected a new line character at this location.', 'BCP019');
        this.skipNl();
      }
      this.next();
      return { k: 'obj', props };
    }
    if (t.t === 'p' && t.v === '[') {
      if (this.isId('for')) {
        this.next();
        let item: string;
        let index: string | undefined;
        if (this.isP('(')) {
          this.next();
          item = this.expectId().v;
          this.expectP(',');
          index = this.expectId().v;
          this.expectP(')');
        } else item = this.expectId().v;
        if (!this.isId('in')) this.err('Expected the "in" keyword at this location.', 'BCP136');
        this.next();
        const source = this.expr();
        this.expectP(':');
        this.skipNl();
        let body: BExpr;
        if (this.isId('if')) {
          this.next();
          this.expectP('(');
          const cond = this.expr();
          this.expectP(')');
          body = { k: 'if', cond, body: this.expr() };
        } else body = this.expr();
        this.skipNl();
        this.expectP(']');
        return { k: 'for', item, index, source, body };
      }
      const items: BExpr[] = [];
      this.skipNl();
      while (!this.isP(']')) {
        items.push(this.expr());
        if (this.isP(',')) this.next();
        this.skipNl();
      }
      this.next();
      return { k: 'arr', items };
    }
    this.err(`Unexpected token "${t.v}". Expected an expression.`, 'BCP009', t);
  }
  interp(t: Tok): BExpr {
    const raw = t.v;
    const parts: (string | BExpr)[] = [];
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        i++;
        continue;
      }
      if (c === '$' && raw[i + 1] === '{') {
        if (cur) parts.push(cur);
        cur = '';
        let depth = 1;
        let j = i + 2;
        while (j < raw.length && depth > 0) {
          if (raw[j] === "'") {
            j++;
            while (j < raw.length && raw[j] !== "'") j++;
          } else if (raw[j] === '{') depth++;
          else if (raw[j] === '}') depth--;
          if (depth > 0) j++;
        }
        const inner = raw.slice(i + 2, j);
        const sub = new Parser(tokenize(inner).filter((x) => x.t !== 'nl').map((x) => ({ ...x, line: t.line })));
        parts.push(sub.expr());
        i = j;
        continue;
      }
      cur += c;
    }
    if (cur || !parts.length) parts.push(cur);
    return { k: 'str', parts };
  }
}

// ---------------------------------------------------------------- transpilación

interface ResInfo {
  symbol: string;
  type: string;
  api: string;
  existing: boolean;
  nameExpr: BExpr;
  parent?: string;
  loop?: boolean;
}

interface Scope {
  params: Set<string>;
  vars: Set<string>;
  resources: Map<string, ResInfo>;
  loop?: { item: string; index?: string; source: BExpr };
  deps?: Set<string>;
}

function q(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

function isConst(e: BExpr): boolean {
  switch (e.k) {
    case 'num':
    case 'bool':
    case 'null':
      return true;
    case 'str':
      return e.parts.every((p) => typeof p === 'string');
    case 'obj':
      return e.props.every((p) => isConst(p.value));
    case 'arr':
      return e.items.every(isConst);
  }
  return false;
}

function constVal(e: BExpr): any {
  switch (e.k) {
    case 'num':
      return e.v;
    case 'bool':
      return e.v;
    case 'null':
      return null;
    case 'str':
      return (e.parts as string[]).join('');
    case 'obj':
      return Object.fromEntries(e.props.map((p) => [p.key, constVal(p.value)]));
    case 'arr':
      return e.items.map(constVal);
  }
  return null;
}

function resourceIdExpr(r: ResInfo, sc: Scope): string {
  const names = nameSegments(r, sc);
  return `resourceId(${q(r.type)}, ${names.join(', ')})`;
}

function nameSegments(r: ResInfo, sc: Scope): string[] {
  if (r.parent) {
    const p = sc.resources.get(r.parent)!;
    return [...nameSegments(p, sc), te(r.nameExpr, sc)];
  }
  const segs = r.type.split('/').length - 1;
  if (segs > 1) return Array.from({ length: segs }, (_, i) => `split(${te(r.nameExpr, sc)}, '/')[${i}]`);
  return [te(r.nameExpr, sc)];
}

function fullName(r: ResInfo, sc: Scope): string {
  if (r.parent) return `format('{0}/{1}', ${fullName(sc.resources.get(r.parent)!, sc)}, ${te(r.nameExpr, sc)})`;
  return te(r.nameExpr, sc);
}

/** Expresión ARM (sin corchetes) para una expresión Bicep. */
function te(e: BExpr, sc: Scope): string {
  switch (e.k) {
    case 'num':
      return String(e.v);
    case 'bool':
      return e.v ? 'true()' : 'false()';
    case 'null':
      return 'null()';
    case 'str': {
      if (e.parts.every((p) => typeof p === 'string')) return q((e.parts as string[]).join(''));
      let fmt = '';
      const args: string[] = [];
      for (const p of e.parts) {
        if (typeof p === 'string') fmt += p.replace(/\{/g, '{{').replace(/\}/g, '}}');
        else {
          fmt += `{${args.length}}`;
          args.push(te(p, sc));
        }
      }
      return `format(${q(fmt)}, ${args.join(', ')})`;
    }
    case 'id': {
      if (sc.loop && e.name === sc.loop.item) return `${te(sc.loop.source, { ...sc, loop: undefined })}[copyIndex()]`;
      if (sc.loop && e.name === sc.loop.index) return 'copyIndex()';
      if (sc.params.has(e.name)) return `parameters(${q(e.name)})`;
      if (sc.vars.has(e.name)) return `variables(${q(e.name)})`;
      const r = sc.resources.get(e.name);
      if (r) {
        if (!r.existing) sc.deps?.add(e.name);
        return resourceIdExpr(r, sc);
      }
      throw new BicepError(e.line, e.col, 'BCP057', `The name "${e.name}" does not exist in the current context.`);
    }
    case 'member': {
      // accesos a símbolos de recurso
      const chain: string[] = [];
      let base: BExpr = e;
      while (base.k === 'member') {
        chain.unshift(base.name);
        base = base.obj;
      }
      if (base.k === 'id' && sc.resources.has(base.name) && !(sc.loop && (base.name === sc.loop.item || base.name === sc.loop.index))) {
        const r = sc.resources.get(base.name)!;
        if (!r.existing) sc.deps?.add(base.name);
        const [first, ...rest] = chain;
        const tail = rest.map((x) => `.${x}`).join('');
        switch (first) {
          case 'id':
            return resourceIdExpr(r, sc) + tail;
          case 'name':
            return (r.parent ? te(r.nameExpr, sc) : fullName(r, sc)) + tail;
          case 'type':
            return q(r.type) + tail;
          case 'apiVersion':
            return q(r.api) + tail;
          case 'properties':
            return `reference(${resourceIdExpr(r, sc)}, ${q(r.api)})${tail}`;
          default:
            return `reference(${resourceIdExpr(r, sc)}, ${q(r.api)}, 'Full').${first}${tail}`;
        }
      }
      return `${te(e.obj, sc)}.${e.name}`;
    }
    case 'index':
      return `${te(e.obj, sc)}[${te(e.idx, sc)}]`;
    case 'call': {
      if (e.target) {
        if (e.target.k === 'id' && sc.resources.has(e.target.name)) {
          const r = sc.resources.get(e.target.name)!;
          if (!r.existing) sc.deps?.add(e.target.name);
          return `${e.fn}(${resourceIdExpr(r, sc)}, ${q(r.api)}${e.args.length ? ', ' + e.args.map((a) => te(a, sc)).join(', ') : ''})`;
        }
        if (e.target.k === 'id' && (e.target.name === 'az' || e.target.name === 'sys')) return `${e.fn}(${e.args.map((a) => te(a, sc)).join(', ')})`;
        throw new BicepError(0, 0, 'BCP109', `Function "${e.fn}" cannot be called on this expression.`);
      }
      return `${e.fn}(${e.args.map((a) => te(a, sc)).join(', ')})`;
    }
    case 'un':
      return e.op === '!' ? `not(${te(e.a, sc)})` : `sub(0, ${te(e.a, sc)})`;
    case 'bin': {
      const a = te(e.a, sc);
      const b = te(e.b, sc);
      switch (e.op) {
        case '==':
          return `equals(${a}, ${b})`;
        case '!=':
          return `not(equals(${a}, ${b}))`;
        case '=~':
          return `equals(toLower(${a}), toLower(${b}))`;
        case '!~':
          return `not(equals(toLower(${a}), toLower(${b})))`;
        case '<':
          return `less(${a}, ${b})`;
        case '>':
          return `greater(${a}, ${b})`;
        case '<=':
          return `lessOrEquals(${a}, ${b})`;
        case '>=':
          return `greaterOrEquals(${a}, ${b})`;
        case '&&':
          return `and(${a}, ${b})`;
        case '||':
          return `or(${a}, ${b})`;
        case '??':
          return `coalesce(${a}, ${b})`;
        case '+':
          return `add(${a}, ${b})`;
        case '-':
          return `sub(${a}, ${b})`;
        case '*':
          return `mul(${a}, ${b})`;
        case '/':
          return `div(${a}, ${b})`;
        case '%':
          return `mod(${a}, ${b})`;
      }
      throw new BicepError(0, 0, 'BCP045', `Operator "${e.op}" is not supported.`);
    }
    case 'tern':
      return `if(${te(e.c, sc)}, ${te(e.a, sc)}, ${te(e.b, sc)})`;
    case 'obj':
      return `createObject(${e.props.map((p) => `${q(p.key)}, ${te(p.value, sc)}`).join(', ')})`;
    case 'arr':
      return `createArray(${e.items.map((x) => te(x, sc)).join(', ')})`;
    case 'for':
      throw new BicepError(0, 0, 'BCP138', 'For-expressions are only supported as resource bodies in the simulator.');
    case 'if':
      return te(e.body, sc);
  }
}

/** Valor JSON (literal o cadena "[expr]") para una expresión Bicep. */
function tv(e: BExpr, sc: Scope): any {
  if (isConst(e)) {
    const v = constVal(e);
    if (typeof v === 'string' && v.startsWith('[')) return '[' + v;
    return v;
  }
  if (e.k === 'obj') return Object.fromEntries(e.props.map((p) => [p.key, tv(p.value, sc)]));
  if (e.k === 'arr') return e.items.map((x) => tv(x, sc));
  return `[${te(e, sc)}]`;
}

const TYPE_MAP: Record<string, string> = { string: 'string', int: 'int', bool: 'bool', object: 'object', array: 'array' };

export interface BicepCompileResult {
  template: any;
  warnings: string[];
}

export function compileBicep(src: string): BicepCompileResult {
  const stmts = new Parser(tokenize(src)).program();
  const warnings: string[] = [];
  const sc: Scope = { params: new Set(), vars: new Set(), resources: new Map() };
  for (const s of stmts) {
    if (s.k === 'param') sc.params.add(s.name);
    if (s.k === 'var') sc.vars.add(s.name);
    if (s.k === 'resource') {
      let body = s.body;
      let loop = false;
      if (body.k === 'for') {
        loop = true;
        body = body.body.k === 'if' ? body.body.body : body.body;
      }
      if (body.k === 'if') body = body.body;
      if (body.k !== 'obj') throw new BicepError(s.line, 1, 'BCP018', 'Expected a resource body object.');
      const nameProp = body.props.find((p) => p.key === 'name');
      if (!nameProp) throw new BicepError(s.line, 1, 'BCP035', `The specified "resource" declaration is missing the following required properties: "name".`);
      const parentProp = body.props.find((p) => p.key === 'parent');
      sc.resources.set(s.symbol, { symbol: s.symbol, type: s.type, api: s.api, existing: s.existing, nameExpr: nameProp.value, parent: parentProp?.value.k === 'id' ? parentProp.value.name : undefined, loop });
    }
  }
  const template: any = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    metadata: { _generator: { name: 'bicep', version: '0.30.23.60470', templateHash: String(src.length * 2654435761 % 4294967296) } },
    parameters: {} as Record<string, any>,
    variables: {} as Record<string, any>,
    resources: [] as any[],
    outputs: {} as Record<string, any>,
  };
  for (const s of stmts) {
    if (s.k === 'targetScope') {
      const v = isConst(s.value) ? constVal(s.value) : '';
      if (v !== 'resourceGroup') throw new BicepError(s.line, 1, 'SIM002', `El simulador sólo admite targetScope = 'resourceGroup' (encontrado '${v}').`);
    }
    if (s.k === 'param') {
      const secure = s.decorators.some((d) => d.name === 'secure');
      const type = TYPE_MAP[s.type];
      if (!type) throw new BicepError(s.line, 1, 'BCP302', `The name "${s.type}" is not a valid type. Specify one of the following types: "array", "bool", "int", "object", "string".`);
      const p: any = { type: secure ? (type === 'object' ? 'secureObject' : 'securestring') : type };
      for (const d of s.decorators) {
        const arg = d.args[0];
        if (d.name === 'allowed' && arg) p.allowedValues = constVal(arg);
        if (d.name === 'minLength' && arg) p.minLength = constVal(arg);
        if (d.name === 'maxLength' && arg) p.maxLength = constVal(arg);
        if (d.name === 'minValue' && arg) p.minValue = constVal(arg);
        if (d.name === 'maxValue' && arg) p.maxValue = constVal(arg);
        if (d.name === 'description' && arg) p.metadata = { description: constVal(arg) };
      }
      if (s.def) p.defaultValue = tv(s.def, sc);
      template.parameters[s.name] = p;
    }
    if (s.k === 'var') template.variables[s.name] = tv(s.value, sc);
  }
  for (const s of stmts) {
    if (s.k !== 'resource' || s.existing) continue;
    const info = sc.resources.get(s.symbol)!;
    let body = s.body;
    let condition: BExpr | undefined;
    let loop: Scope['loop'];
    if (body.k === 'for') {
      loop = { item: body.item, index: body.index, source: body.source };
      body = body.body;
    }
    if (body.k === 'if') {
      condition = body.cond;
      body = body.body;
    }
    if (body.k !== 'obj') throw new BicepError(s.line, 1, 'BCP018', 'Expected a resource body object.');
    const deps = new Set<string>();
    const rsc: Scope = { ...sc, loop, deps };
    const out: any = { type: s.type, apiVersion: s.api, name: `[${fullName(info, rsc)}]` };
    if (isConst(info.nameExpr) && !info.parent) out.name = constVal(info.nameExpr);
    if (condition) out.condition = tv(condition, rsc);
    if (loop) out.copy = { name: s.symbol, count: `[length(${te(loop.source, { ...sc })})]` };
    for (const p of body.props) {
      if (p.key === 'name' || p.key === 'parent') continue;
      if (p.key === 'dependsOn') {
        if (p.value.k === 'arr') for (const it of p.value.items) if (it.k === 'id' && sc.resources.has(it.name)) deps.add(it.name);
        continue;
      }
      if (p.key === 'scope') {
        if (p.value.k === 'id' && sc.resources.has(p.value.name)) {
          const target = sc.resources.get(p.value.name)!;
          out.scope = `[${resourceIdExpr(target, rsc)}]`;
          if (!target.existing) deps.add(p.value.name);
        } else if (p.value.k === 'call' && p.value.fn === 'resourceGroup') {
          /* ámbito del grupo de recursos actual */
        } else out.scope = tv(p.value, rsc);
        continue;
      }
      out[p.key] = tv(p.value, rsc);
    }
    if (info.parent) deps.add(info.parent);
    deps.delete(s.symbol);
    const dependsOn = [...deps].filter((d) => !sc.resources.get(d)!.existing).map((d) => {
      const r = sc.resources.get(d)!;
      return r.loop ? d : `[${resourceIdExpr(r, sc)}]`;
    });
    if (dependsOn.length) out.dependsOn = dependsOn;
    template.resources.push(out);
  }
  for (const s of stmts) {
    if (s.k !== 'output') continue;
    const type = TYPE_MAP[s.type] ?? 'string';
    template.outputs[s.name] = { type, value: tv(s.value, sc) };
  }
  for (const [name, p] of Object.entries<any>(template.parameters)) {
    const used = JSON.stringify(template).split(`parameters('${name}')`).length > 1;
    if (!used) warnings.push(`Warning no-unused-params: Parameter "${name}" is declared but never used. [https://aka.ms/bicep/linter/no-unused-params]`);
    void p;
  }
  for (const [name] of Object.entries<any>(template.variables)) {
    if (JSON.stringify(template).split(`variables('${name}')`).length <= 1) warnings.push(`Warning no-unused-vars: Variable "${name}" is declared but never used. [https://aka.ms/bicep/linter/no-unused-vars]`);
  }
  return { template, warnings };
}

export function formatBicepError(file: string, e: unknown): string {
  if (e instanceof BicepError) return `${file}(${e.line},${e.col}) : Error ${e.code}: ${e.message}`;
  return `${file} : Error: ${(e as Error)?.message ?? String(e)}`;
}
