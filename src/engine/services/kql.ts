// Motor KQL (Kusto Query Language) simplificado para Log Analytics.

export type KType = 'datetime' | 'string' | 'long' | 'real' | 'bool' | 'timespan' | 'dynamic';

export interface KqlColumn {
  name: string;
  type: KType;
}

export interface KqlTable {
  columns: KqlColumn[];
  rows: Record<string, any>[];
}

export interface KqlResult {
  columns: KqlColumn[];
  rows: any[][];
  render?: string;
}

export class KqlError extends Error {}

// ---------------------------------------------------------------- tokenizer

type Tok = { t: 'id' | 'num' | 'str' | 'op' | 'span'; v: string; n?: number };

const SPAN_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000 };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw new KqlError(`Literal de cadena sin cerrar cerca de: ${src.slice(i, i + 20)}`);
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      const num = Number(src.slice(i, j));
      const unit = /^(ms|min|s|m|h|d)\b/.exec(src.slice(j));
      if (unit) {
        out.push({ t: 'span', v: src.slice(i, j + unit[1].length), n: num * SPAN_UNITS[unit[1]] });
        i = j + unit[1].length;
      } else {
        out.push({ t: 'num', v: src.slice(i, j), n: num });
        i = j;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$-]/.test(src[j])) {
        if (src[j] === '-' && !/^(project-away|project-rename|project-keep|mv-expand|make-series)/.test(src.slice(i))) break;
        j++;
      }
      if (src.slice(i, j) === 'in' && src[j] === '~') j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '!' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < src.length && /[\w_]/.test(src[j])) j++;
      out.push({ t: 'op', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '=~', '!~', '<=', '>=', '<>'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('()[],.<>=+-*/%|'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new KqlError(`Carácter inesperado '${c}' en la consulta.`);
  }
  return out;
}

// ---------------------------------------------------------------- AST de expresiones

type Expr =
  | { k: 'lit'; v: any; type: KType }
  | { k: 'col'; name: string }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'un'; op: string; a: Expr }
  | { k: 'call'; fn: string; args: Expr[] }
  | { k: 'list'; items: Expr[] }
  | { k: 'member'; obj: Expr; key: Expr };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  eof() {
    return this.i >= this.toks.length;
  }
  next() {
    return this.toks[this.i++];
  }
  isOp(v: string) {
    const t = this.peek();
    return t && t.t === 'op' && t.v === v;
  }
  isId(v: string) {
    const t = this.peek();
    return t && t.t === 'id' && t.v.toLowerCase() === v;
  }
  expectOp(v: string) {
    const t = this.next();
    if (!t || t.t !== 'op' || t.v !== v) throw new KqlError(`Se esperaba '${v}' y se encontró '${t?.v ?? 'fin de consulta'}'.`);
  }
  expr(): Expr {
    return this.or();
  }
  or(): Expr {
    let a = this.and();
    while (this.isId('or')) {
      this.next();
      a = { k: 'bin', op: 'or', a, b: this.and() };
    }
    return a;
  }
  and(): Expr {
    let a = this.cmp();
    while (this.isId('and')) {
      this.next();
      a = { k: 'bin', op: 'and', a, b: this.cmp() };
    }
    return a;
  }
  cmp(): Expr {
    const a = this.add();
    const t = this.peek();
    if (!t) return a;
    const strOps = ['contains', 'contains_cs', 'has', 'has_cs', 'startswith', 'endswith', 'in', 'matches', 'between', 'in~', 'has_any'];
    if (t.t === 'op' && ['==', '!=', '=~', '!~', '<', '<=', '>', '>=', '<>', '='].includes(t.v)) {
      this.next();
      return { k: 'bin', op: t.v === '=' ? '==' : t.v === '<>' ? '!=' : t.v, a, b: this.add() };
    }
    if ((t.t === 'id' && strOps.includes(t.v.toLowerCase())) || (t.t === 'op' && t.v.startsWith('!') && t.v.length > 1)) {
      this.next();
      const op = t.v.toLowerCase();
      if (op === 'matches') {
        if (!this.isId('regex')) throw new KqlError("Se esperaba 'matches regex'.");
        this.next();
        return { k: 'bin', op: 'matches', a, b: this.add() };
      }
      if (op === 'in' || op === '!in' || op === 'between' || op === 'has_any') {
        this.expectOp('(');
        const items: Expr[] = [];
        if (op === 'between') {
          items.push(this.add());
          this.expectOp('.');
          this.expectOp('.');
          items.push(this.add());
        } else {
          while (!this.isOp(')')) {
            items.push(this.expr());
            if (this.isOp(',')) this.next();
          }
        }
        this.expectOp(')');
        return { k: 'bin', op, a, b: { k: 'list', items } };
      }
      return { k: 'bin', op, a, b: this.add() };
    }
    return a;
  }
  add(): Expr {
    let a = this.mul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.mul() };
    }
    return a;
  }
  mul(): Expr {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      a = { k: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  unary(): Expr {
    if (this.isOp('-')) {
      this.next();
      return { k: 'un', op: '-', a: this.unary() };
    }
    if (this.isId('not') && this.peek(1)?.v === '(') {
      this.next();
      this.expectOp('(');
      const e = this.expr();
      this.expectOp(')');
      return { k: 'un', op: 'not', a: e };
    }
    return this.postfix();
  }
  /** Acceso a propiedades de columnas dinámicas: properties.hardwareProfile.vmSize, tags['entorno']. */
  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp('.') && this.peek(1)?.t === 'id') {
        this.next();
        e = { k: 'member', obj: e, key: { k: 'lit', v: this.next().v, type: 'string' } };
      } else if (this.isOp('[')) {
        this.next();
        const key = this.expr();
        this.expectOp(']');
        e = { k: 'member', obj: e, key };
      } else return e;
    }
  }
  primary(): Expr {
    const t = this.next();
    if (!t) throw new KqlError('Expresión incompleta.');
    if (t.t === 'num') return { k: 'lit', v: t.n, type: Number.isInteger(t.n) ? 'long' : 'real' };
    if (t.t === 'span') return { k: 'lit', v: t.n, type: 'timespan' };
    if (t.t === 'str') return { k: 'lit', v: t.v, type: 'string' };
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'id') {
      const low = t.v.toLowerCase();
      if (low === 'true' || low === 'false') return { k: 'lit', v: low === 'true', type: 'bool' };
      if (low === 'datetime' && this.isOp('(')) {
        this.next();
        let raw = '';
        while (!this.isOp(')') && !this.eof()) raw += this.next().v;
        this.expectOp(')');
        const d = Date.parse(raw.replace(/(\d{4})-(\d{2})-(\d{2})(\d{2}):/, '$1-$2-$3T$4:'));
        if (isNaN(d)) throw new KqlError(`Fecha no válida: datetime(${raw})`);
        return { k: 'lit', v: d, type: 'datetime' };
      }
      if (this.isOp('(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.isOp(')')) {
          if (this.isOp('*')) {
            this.next();
            continue;
          }
          args.push(this.expr());
          if (this.isOp(',')) this.next();
          else if (!this.isOp(')')) throw new KqlError(`Se esperaba ',' o ')' en la llamada a ${t.v}().`);
        }
        this.expectOp(')');
        return { k: 'call', fn: low, args };
      }
      return { k: 'col', name: t.v };
    }
    throw new KqlError(`Token inesperado '${t.v}'.`);
  }
}

// ---------------------------------------------------------------- evaluación

function truthy(v: any) {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
}

function cmpVals(a: any, b: any): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function evalE(e: Expr, row: Record<string, any>, types: Record<string, KType>): any {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'list':
      return e.items.map((x) => evalE(x, row, types));
    case 'member': {
      let obj = evalE(e.obj, row, types);
      if (typeof obj === 'string' && /^[[{]/.test(obj)) {
        try {
          obj = JSON.parse(obj);
        } catch {
          return null;
        }
      }
      if (obj === null || obj === undefined || typeof obj !== 'object') return null;
      const key = evalE(e.key, row, types);
      const v = (obj as any)[key];
      return v === undefined ? null : v;
    }
    case 'col': {
      if (!(e.name in types)) throw new KqlError(`No se pudo resolver la expresión escalar '${e.name}'. Columnas disponibles: ${Object.keys(types).join(', ')}`);
      return row[e.name];
    }
    case 'un': {
      const v = evalE(e.a, row, types);
      return e.op === '-' ? -v : !truthy(v);
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalE(e.a, row, types)) && truthy(evalE(e.b, row, types));
      if (e.op === 'or') return truthy(evalE(e.a, row, types)) || truthy(evalE(e.b, row, types));
      const a = evalE(e.a, row, types);
      const b = evalE(e.b, row, types);
      const sa = String(a ?? '');
      const sb = String(b ?? '');
      switch (e.op) {
        case '==':
          return a === b || (typeof a !== typeof b && String(a) === String(b));
        case '!=':
          return !(a === b || String(a) === String(b));
        case '=~':
          return sa.toLowerCase() === sb.toLowerCase();
        case '!~':
          return sa.toLowerCase() !== sb.toLowerCase();
        case '<':
          return cmpVals(a, b) < 0;
        case '<=':
          return cmpVals(a, b) <= 0;
        case '>':
          return cmpVals(a, b) > 0;
        case '>=':
          return cmpVals(a, b) >= 0;
        case '+':
          return typeof a === 'number' && typeof b === 'number' ? a + b : sa + sb;
        case '-':
          return Number(a) - Number(b);
        case '*':
          return Number(a) * Number(b);
        case '/':
          return Number(a) / Number(b);
        case '%':
          return Number(a) % Number(b);
        case 'contains':
          return sa.toLowerCase().includes(sb.toLowerCase());
        case '!contains':
          return !sa.toLowerCase().includes(sb.toLowerCase());
        case 'contains_cs':
          return sa.includes(sb);
        case 'has':
          return new RegExp(`(^|[^A-Za-z0-9])${sb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(sa);
        case '!has':
          return !new RegExp(`(^|[^A-Za-z0-9])${sb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(sa);
        case 'has_cs':
          return sa.includes(sb);
        case 'startswith':
          return sa.toLowerCase().startsWith(sb.toLowerCase());
        case '!startswith':
          return !sa.toLowerCase().startsWith(sb.toLowerCase());
        case 'endswith':
          return sa.toLowerCase().endsWith(sb.toLowerCase());
        case '!endswith':
          return !sa.toLowerCase().endsWith(sb.toLowerCase());
        case 'in':
          return (b as any[]).some((x) => x === a || String(x) === String(a));
        case '!in':
          return !(b as any[]).some((x) => x === a || String(x) === String(a));
        case 'in~':
          return (b as any[]).some((x) => String(x).toLowerCase() === sa.toLowerCase());
        case 'has_any':
          return (b as any[]).some((x) => sa.toLowerCase().includes(String(x).toLowerCase()));
        case 'between':
          return cmpVals(a, (b as any[])[0]) >= 0 && cmpVals(a, (b as any[])[1]) <= 0;
        case 'matches':
          return new RegExp(sb).test(sa);
      }
      throw new KqlError(`Operador no soportado: ${e.op}`);
    }
    case 'call': {
      const args = e.args.map((x) => evalE(x, row, types));
      switch (e.fn) {
        case 'ago':
          return Date.now() - Number(args[0]);
        case 'now':
          return Date.now() + Number(args[0] ?? 0);
        case 'bin':
        case 'floor':
          return Math.floor(Number(args[0]) / Number(args[1])) * Number(args[1]);
        case 'startofday': {
          const d = new Date(args[0]);
          d.setUTCHours(0, 0, 0, 0);
          return d.getTime();
        }
        case 'tolower':
          return String(args[0] ?? '').toLowerCase();
        case 'toupper':
          return String(args[0] ?? '').toUpperCase();
        case 'strlen':
          return String(args[0] ?? '').length;
        case 'tostring':
          return args[0] === null || args[0] === undefined ? '' : typeof args[0] === 'object' ? JSON.stringify(args[0]) : String(args[0]);
        case 'toint':
        case 'tolong':
          return Math.trunc(Number(args[0]));
        case 'todouble':
        case 'toreal':
          return Number(args[0]);
        case 'round':
          return Number(Number(args[0]).toFixed(Number(args[1] ?? 0)));
        case 'iff':
        case 'iif':
          return truthy(args[0]) ? args[1] : args[2];
        case 'isempty':
          return args[0] === null || args[0] === undefined || args[0] === '';
        case 'isnotempty':
          return !(args[0] === null || args[0] === undefined || args[0] === '');
        case 'isnull':
          return args[0] === null || args[0] === undefined;
        case 'isnotnull':
          return !(args[0] === null || args[0] === undefined);
        case 'strcat':
          return args.map((a) => (a === null || a === undefined ? '' : String(a))).join('');
        case 'substring':
          return String(args[0] ?? '').substr(Number(args[1]), args[2] === undefined ? undefined : Number(args[2]));
        case 'split':
          return String(args[0] ?? '').split(String(args[1]));
        case 'extract': {
          const m = new RegExp(String(args[0])).exec(String(args[2] ?? ''));
          return m ? m[Number(args[1])] ?? '' : '';
        }
        case 'coalesce':
          return args.find((a) => a !== null && a !== undefined && a !== '') ?? null;
        case 'datetime_diff':
          return Math.round((Number(args[1]) - Number(args[2])) / (SPAN_UNITS[String(args[0]).charAt(0)] ?? 1000));
        case 'format_datetime':
          return new Date(args[0]).toISOString();
        case 'hourofday':
          return new Date(args[0]).getUTCHours();
        case 'abs':
          return Math.abs(Number(args[0]));
      }
      throw new KqlError(`Función desconocida: ${e.fn}()`);
    }
  }
}

function inferType(e: Expr, types: Record<string, KType>): KType {
  if (e.k === 'lit') return e.type;
  if (e.k === 'col') return types[e.name] ?? 'string';
  if (e.k === 'member') return 'dynamic';
  if (e.k === 'call') {
    if (['ago', 'now', 'startofday'].includes(e.fn)) return 'datetime';
    if (e.fn === 'bin' || e.fn === 'floor') return inferType(e.args[0], types);
    if (['strlen', 'toint', 'tolong', 'hourofday', 'datetime_diff'].includes(e.fn)) return 'long';
    if (['todouble', 'toreal', 'round', 'abs'].includes(e.fn)) return 'real';
    if (['isempty', 'isnotempty', 'isnull', 'isnotnull'].includes(e.fn)) return 'bool';
    if (e.fn === 'iff' || e.fn === 'iif') return inferType(e.args[1], types);
    return 'string';
  }
  if (e.k === 'bin') {
    if (['+', '-', '*', '/', '%'].includes(e.op)) {
      const ta = inferType(e.a, types);
      return ta === 'datetime' ? 'datetime' : ta === 'string' ? 'string' : 'real';
    }
    return 'bool';
  }
  return 'string';
}

function exprName(e: Expr): string {
  if (e.k === 'col') return e.name;
  if (e.k === 'call') return e.args[0] ? `${e.fn}_${exprName(e.args[0])}` : `${e.fn}_`;
  // Como en Kusto: properties.hardwareProfile.vmSize se proyecta como properties_hardwareProfile_vmSize.
  if (e.k === 'member') return `${exprName(e.obj)}_${e.key.k === 'lit' ? e.key.v : 'Column1'}`;
  return 'Column1';
}

// ---------------------------------------------------------------- pipeline

function splitPipes(q: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (quote) {
      cur += c;
      if (c === quote && q[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Assign {
  name: string;
  expr: Expr;
}

function parseAssignList(p: Parser, stopAtBy = false): Assign[] {
  const out: Assign[] = [];
  while (!p.eof()) {
    if (stopAtBy && p.isId('by')) break;
    let name: string | null = null;
    if (p.peek()?.t === 'id' && p.peek(1)?.t === 'op' && p.peek(1)?.v === '=') {
      name = p.next().v;
      p.next();
    }
    const expr = p.expr();
    out.push({ name: name ?? exprName(expr), expr });
    if (p.isOp(',')) p.next();
    else break;
  }
  return out;
}

const AGGS = new Set(['count', 'countif', 'dcount', 'sum', 'avg', 'min', 'max', 'percentile', 'make_list', 'make_set', 'any', 'take_any', 'arg_max', 'stdev', 'avgif', 'sumif']);

function aggregate(fn: string, args: Expr[], rows: Record<string, any>[], types: Record<string, KType>): any {
  const vals = () => rows.map((r) => evalE(args[0], r, types)).filter((v) => v !== null && v !== undefined && v !== '');
  switch (fn) {
    case 'count':
      return rows.length;
    case 'countif':
      return rows.filter((r) => truthy(evalE(args[0], r, types))).length;
    case 'dcount':
      return new Set(vals().map(String)).size;
    case 'sum':
      return vals().reduce((a: number, b: any) => a + Number(b), 0);
    case 'sumif':
      return rows.filter((r) => truthy(evalE(args[1], r, types))).reduce((a, r) => a + Number(evalE(args[0], r, types)), 0);
    case 'avg': {
      const v = vals();
      return v.length ? v.reduce((a: number, b: any) => a + Number(b), 0) / v.length : null;
    }
    case 'avgif': {
      const v = rows.filter((r) => truthy(evalE(args[1], r, types))).map((r) => Number(evalE(args[0], r, types)));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    }
    case 'min':
      return vals().reduce((a: any, b: any) => (a === undefined || cmpVals(b, a) < 0 ? b : a), undefined) ?? null;
    case 'max':
      return vals().reduce((a: any, b: any) => (a === undefined || cmpVals(b, a) > 0 ? b : a), undefined) ?? null;
    case 'percentile': {
      const v = vals().map(Number).sort((a, b) => a - b);
      const p = Number(evalE(args[1], {}, types));
      return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null;
    }
    case 'stdev': {
      const v = vals().map(Number);
      const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1));
    }
    case 'make_list':
      return vals();
    case 'make_set':
      return [...new Set(vals().map(String))];
    case 'any':
    case 'take_any':
      return rows.length ? evalE(args[0], rows[0], types) : null;
  }
  throw new KqlError(`Función de agregación desconocida: ${fn}()`);
}

export function runKql(query: string, getTable: (name: string) => KqlTable | undefined): KqlResult {
  const stages = splitPipes(query.trim().replace(/;\s*$/, ''));
  if (!stages.length) throw new KqlError('La consulta está vacía.');
  const first = stages[0].trim();
  let columns: KqlColumn[];
  let rows: Record<string, any>[];
  let render: string | undefined;
  const union = /^union\s+(.+)$/i.exec(first);
  if (union) {
    const names = union[1].split(',').map((x) => x.trim());
    columns = [];
    rows = [];
    for (const n of names) {
      const t = getTable(n);
      if (!t) throw new KqlError(`No se pudo resolver la tabla o expresión '${n}'.`);
      for (const c of t.columns) if (!columns.some((x) => x.name === c.name)) columns.push(c);
      rows.push(...t.rows.map((r) => ({ ...r, Type: n })));
    }
  } else if (/^print\s+/i.test(first)) {
    const p = new Parser(tokenize(first.replace(/^print\s+/i, '')));
    const assigns = parseAssignList(p);
    columns = assigns.map((a) => ({ name: a.name === 'Column1' ? 'print_0' : a.name, type: inferType(a.expr, {}) }));
    rows = [Object.fromEntries(assigns.map((a, i) => [columns[i].name, evalE(a.expr, {}, {})]))];
  } else {
    const t = getTable(first);
    if (!t) throw new KqlError(`No se pudo resolver la tabla o expresión '${first}'. Comprueba el nombre de la tabla y que el recurso envía datos a esta área de trabajo.`);
    columns = [...t.columns];
    rows = t.rows.map((r) => ({ ...r }));
  }
  for (const stage of stages.slice(1)) {
    const m = /^([\w-]+)\s*([\s\S]*)$/.exec(stage);
    if (!m) throw new KqlError(`Operador no válido: ${stage}`);
    const op = m[1].toLowerCase();
    const rest = m[2];
    const types: Record<string, KType> = Object.fromEntries(columns.map((c) => [c.name, c.type]));
    const p = new Parser(tokenize(rest));
    switch (op) {
      case 'where':
      case 'filter': {
        const e = p.expr();
        rows = rows.filter((r) => truthy(evalE(e, r, types)));
        break;
      }
      case 'project': {
        const as = parseAssignList(p);
        const newCols = as.map((a) => ({ name: a.name, type: inferType(a.expr, types) }));
        rows = rows.map((r) => Object.fromEntries(as.map((a) => [a.name, evalE(a.expr, r, types)])));
        columns = newCols;
        break;
      }
      case 'project-away': {
        const names = rest.split(',').map((x) => x.trim());
        columns = columns.filter((c) => !names.includes(c.name));
        break;
      }
      case 'project-rename': {
        const as = parseAssignList(p);
        for (const a of as) {
          if (a.expr.k !== 'col') continue;
          const from = (a.expr as any).name;
          columns = columns.map((c) => (c.name === from ? { ...c, name: a.name } : c));
          rows = rows.map((r) => {
            const { [from]: v, ...others } = r;
            return { ...others, [a.name]: v };
          });
        }
        break;
      }
      case 'extend': {
        const as = parseAssignList(p);
        for (const a of as) {
          const type = inferType(a.expr, types);
          rows = rows.map((r) => ({ ...r, [a.name]: evalE(a.expr, r, types) }));
          if (!columns.some((c) => c.name === a.name)) columns.push({ name: a.name, type });
          types[a.name] = type;
        }
        break;
      }
      case 'take':
      case 'limit': {
        rows = rows.slice(0, Number(rest.trim()));
        break;
      }
      case 'count': {
        rows = [{ Count: rows.length }];
        columns = [{ name: 'Count', type: 'long' }];
        break;
      }
      case 'order':
      case 'sort': {
        if (!p.isId('by')) throw new KqlError(`Se esperaba '${op} by'.`);
        p.next();
        const keys: { e: Expr; desc: boolean }[] = [];
        while (!p.eof()) {
          const e = p.expr();
          let desc = true;
          if (p.isId('asc')) {
            p.next();
            desc = false;
          } else if (p.isId('desc')) p.next();
          keys.push({ e, desc });
          if (p.isOp(',')) p.next();
          else break;
        }
        rows = [...rows].sort((a, b) => {
          for (const k of keys) {
            const c = cmpVals(evalE(k.e, a, types), evalE(k.e, b, types));
            if (c !== 0) return k.desc ? -c : c;
          }
          return 0;
        });
        break;
      }
      case 'top': {
        const nTok = p.next();
        const n = Number(nTok?.n ?? nTok?.v);
        if (!p.isId('by')) throw new KqlError("Se esperaba 'top N by columna'.");
        p.next();
        const e = p.expr();
        let desc = true;
        if (p.isId('asc')) {
          p.next();
          desc = false;
        } else if (p.isId('desc')) p.next();
        rows = [...rows].sort((a, b) => (desc ? -1 : 1) * cmpVals(evalE(e, a, types), evalE(e, b, types))).slice(0, n);
        break;
      }
      case 'distinct': {
        const names = rest.split(',').map((x) => x.trim()).filter(Boolean);
        const seen = new Set<string>();
        const out: Record<string, any>[] = [];
        for (const r of rows) {
          const key = JSON.stringify(names.map((n) => r[n]));
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(Object.fromEntries(names.map((n) => [n, r[n]])));
        }
        rows = out;
        columns = names.map((n) => columns.find((c) => c.name === n) ?? { name: n, type: 'string' });
        break;
      }
      case 'summarize': {
        const aggs = parseAssignList(p, true);
        let by: Assign[] = [];
        if (p.isId('by')) {
          p.next();
          by = parseAssignList(p);
        }
        for (const a of aggs) {
          if (a.expr.k !== 'call' || !AGGS.has(a.expr.fn)) throw new KqlError(`'summarize' espera funciones de agregación (count, avg, sum, max, min, dcount...). Encontrado: ${a.name}`);
          if (a.name.startsWith(`${a.expr.fn}_`) && a.expr.fn === 'count' && !a.expr.args.length) a.name = 'count_';
        }
        const groups = new Map<string, { keys: any[]; rows: Record<string, any>[] }>();
        for (const r of rows) {
          const keys = by.map((b) => evalE(b.expr, r, types));
          const k = JSON.stringify(keys);
          if (!groups.has(k)) groups.set(k, { keys, rows: [] });
          groups.get(k)!.rows.push(r);
        }
        if (!by.length && !groups.size) groups.set('[]', { keys: [], rows: [] });
        const out: Record<string, any>[] = [];
        for (const g of groups.values()) {
          const row: Record<string, any> = {};
          by.forEach((b, i) => (row[b.name] = g.keys[i]));
          for (const a of aggs) {
            const call = a.expr as Extract<Expr, { k: 'call' }>;
            row[a.name] = aggregate(call.fn, call.args, g.rows, types);
          }
          out.push(row);
        }
        columns = [
          ...by.map((b) => ({ name: b.name, type: inferType(b.expr, types) })),
          ...aggs.map((a) => {
            const fn = (a.expr as any).fn as string;
            const type: KType = ['count', 'countif', 'dcount'].includes(fn) ? 'long' : ['make_list', 'make_set'].includes(fn) ? 'dynamic' : ['min', 'max', 'any', 'take_any'].includes(fn) ? inferType((a.expr as any).args[0], types) : 'real';
            return { name: a.name, type };
          }),
        ];
        rows = out;
        break;
      }
      case 'render': {
        render = rest.trim().split(/\s+/)[0];
        break;
      }
      case 'search': {
        const term = rest.trim().replace(/^["']|["']$/g, '').toLowerCase();
        rows = rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(term)));
        break;
      }
      default:
        throw new KqlError(`Operador de consulta no soportado por el simulador: '${op}'. Soportados: where, project, project-away, project-rename, extend, summarize, order by, sort by, top, take, limit, count, distinct, render, search.`);
    }
  }
  return { columns, rows: rows.map((r) => columns.map((c) => r[c.name] ?? null)), render };
}

export function formatKqlValue(v: any, type: KType): string {
  if (v === null || v === undefined) return '';
  if (type === 'datetime' && typeof v === 'number') return new Date(v).toISOString().replace('.000Z', 'Z');
  if (type === 'timespan' && typeof v === 'number') {
    const s = Math.floor(v / 1000);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  if (type === 'real' && typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
