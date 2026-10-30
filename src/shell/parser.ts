// Parser de un subconjunto amplio de bash.

export class IncompleteInput extends Error {
  constructor(public expecting = '') {
    super('incomplete input');
  }
}

export class ParseError extends Error {}

export type WordPart =
  | { t: 'lit'; v: string; q: 0 | 1 | 2 }
  | { t: 'var'; name: string; q: 0 | 2; op?: string; arg?: Word; arg2?: Word }
  | { t: 'cmd'; src: string; q: 0 | 2 }
  | { t: 'arith'; src: string; q: 0 | 2 }
  | { t: 'tilde'; user: string };

export type Word = WordPart[];

export interface Redirect {
  fd: number; // -1 = stdout y stderr
  op: '>' | '>>' | '<' | '>&' | '<<' | '<<<';
  target?: Word;
  dupFd?: number;
  heredoc?: { body: string; expand: boolean; strip: boolean; delim: string };
}

export interface SimpleCmd {
  k: 'simple';
  assigns: { name: string; value: Word; append: boolean; array?: Word[] }[];
  words: Word[];
  redirects: Redirect[];
  text: string;
}
export interface ForCmd {
  k: 'for';
  v: string;
  items: Word[] | null;
  body: List;
  redirects: Redirect[];
}
export interface WhileCmd {
  k: 'while' | 'until';
  cond: List;
  body: List;
  redirects: Redirect[];
}
export interface IfCmd {
  k: 'if';
  clauses: { cond: List; body: List }[];
  elseBody: List | null;
  redirects: Redirect[];
}
export interface GroupCmd {
  k: 'group' | 'subshell';
  body: List;
  redirects: Redirect[];
}
export interface FuncDef {
  k: 'func';
  name: string;
  body: Command;
}
export interface CaseCmd {
  k: 'case';
  word: Word;
  items: { patterns: Word[]; body: List }[];
  redirects: Redirect[];
}
export type Command = SimpleCmd | ForCmd | WhileCmd | IfCmd | GroupCmd | FuncDef | CaseCmd;
export interface Pipeline {
  cmds: Command[];
  negate: boolean;
}
export interface AndOr {
  first: Pipeline;
  rest: { op: '&&' | '||'; p: Pipeline }[];
  bg: boolean;
}
export type List = AndOr[];

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '{', '}', '!']);
const WORD_END = /[ \t\n;&|()<>]/;

export function parseScript(src: string): List {
  const p = new ShParser(src);
  const list = p.parseList([]);
  p.skipSeparators();
  if (p.pending.length) throw new IncompleteInput('heredoc');
  if (!p.eof()) {
    const c = p.peek();
    throw new ParseError(`bash: syntax error near unexpected token \`${c === '\n' ? 'newline' : p.src.slice(p.i, p.i + 4).split(/\s/)[0]}'`);
  }
  return list;
}

class ShParser {
  i = 0;
  pending: Redirect[] = [];
  constructor(public src: string) {}

  eof() {
    return this.i >= this.src.length;
  }
  peek(o = 0) {
    return this.src[this.i + o];
  }
  startsWith(s: string) {
    return this.src.startsWith(s, this.i);
  }

  skipWs() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '\\' && this.peek(1) === '\n') {
        this.i += 2;
        continue;
      }
      if (c === '#') {
        while (!this.eof() && this.peek() !== '\n') this.i++;
        continue;
      }
      break;
    }
  }

  consumeNewline() {
    this.i++;
    if (this.pending.length) this.readHeredocs();
  }

  skipSeparators(allowSemicolon = true) {
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '\n') {
        this.consumeNewline();
        continue;
      }
      if (allowSemicolon && c === ';' && this.peek(1) !== ';') {
        this.i++;
        continue;
      }
      break;
    }
  }

  skipNewlines() {
    for (;;) {
      this.skipWs();
      if (this.peek() === '\n') {
        this.consumeNewline();
        continue;
      }
      break;
    }
  }

  readHeredocs() {
    const list = this.pending;
    this.pending = [];
    for (const r of list) {
      const h = r.heredoc!;
      const lines: string[] = [];
      for (;;) {
        if (this.eof()) throw new IncompleteInput('heredoc');
        const end = this.src.indexOf('\n', this.i);
        const line = this.src.slice(this.i, end < 0 ? undefined : end);
        this.i = end < 0 ? this.src.length : end + 1;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp.replace(/\r$/, '') === h.delim) break;
        lines.push(h.strip ? line.replace(/^\t+/, '') : line);
        if (end < 0) throw new IncompleteInput('heredoc');
      }
      h.body = lines.length ? lines.join('\n') + '\n' : '';
    }
  }

  peekReserved(): string | null {
    this.skipWs();
    const c = this.peek();
    if ((c === '{' || c === '}' || c === '!') && (this.i + 1 >= this.src.length || /[\s;]/.test(this.peek(1)))) return c;
    let j = this.i;
    while (j < this.src.length && !/[\s;&|()<>"'`$\\]/.test(this.src[j])) j++;
    const w = this.src.slice(this.i, j);
    if (j < this.src.length && /["'`$\\]/.test(this.src[j])) return null;
    return RESERVED.has(w) ? w : null;
  }

  expectReserved(w: string) {
    this.skipSeparators();
    if (this.eof()) throw new IncompleteInput(w);
    const r = this.peekReserved();
    if (r !== w) throw new ParseError(`bash: syntax error near unexpected token \`${this.src.slice(this.i).split(/\s/)[0] || 'newline'}' (se esperaba '${w}')`);
    this.i += w.length;
  }

  parseList(terms: string[]): List {
    const items: List = [];
    for (;;) {
      this.skipSeparators();
      if (this.eof()) break;
      const c = this.peek();
      if (c === ')' ) break;
      if (c === ';' && this.peek(1) === ';' && terms.includes(';;')) break;
      const rw = this.peekReserved();
      if (rw && terms.includes(rw)) break;
      if (rw && ['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}'].includes(rw) && !terms.includes(rw)) {
        throw new ParseError(`bash: syntax error near unexpected token \`${rw}'`);
      }
      const ao = this.parseAndOr();
      this.skipWs();
      if (this.peek() === '&' && this.peek(1) !== '&') {
        this.i++;
        ao.bg = true;
      }
      items.push(ao);
      this.skipWs();
      const n = this.peek();
      if (!this.eof() && n !== '\n' && n !== ';' && n !== ')' && !(n === '&')) {
        const r2 = this.peekReserved();
        if (!(r2 && terms.includes(r2))) throw new ParseError(`bash: syntax error near unexpected token \`${this.src.slice(this.i).split(/\s/)[0]}'`);
      }
    }
    return items;
  }

  parseAndOr(): AndOr {
    const first = this.parsePipeline();
    const rest: AndOr['rest'] = [];
    for (;;) {
      this.skipWs();
      if (this.startsWith('&&') || this.startsWith('||')) {
        const op = this.src.slice(this.i, this.i + 2) as '&&' | '||';
        this.i += 2;
        this.skipNewlines();
        if (this.eof()) throw new IncompleteInput(op);
        rest.push({ op, p: this.parsePipeline() });
      } else break;
    }
    return { first, rest, bg: false };
  }

  parsePipeline(): Pipeline {
    this.skipWs();
    let negate = false;
    if (this.peekReserved() === '!') {
      this.i++;
      negate = true;
    }
    const cmds = [this.parseCommand()];
    for (;;) {
      this.skipWs();
      if (this.peek() === '|' && this.peek(1) !== '|') {
        this.i++;
        if (this.peek() === '&') this.i++;
        this.skipNewlines();
        if (this.eof()) throw new IncompleteInput('|');
        cmds.push(this.parseCommand());
      } else break;
    }
    return { cmds, negate };
  }

  parseCommand(): Command {
    this.skipWs();
    if (this.eof()) throw new IncompleteInput('command');
    const rw = this.peekReserved();
    switch (rw) {
      case 'if':
        return this.parseIf();
      case 'for':
        return this.parseFor();
      case 'while':
      case 'until':
        return this.parseWhile(rw);
      case 'case':
        return this.parseCase();
      case '{': {
        this.i++;
        const body = this.parseList(['}']);
        this.expectReserved('}');
        return { k: 'group', body, redirects: this.parseRedirectsTail() };
      }
      case 'function': {
        this.i += 'function'.length;
        this.skipWs();
        const name = this.readName();
        this.skipWs();
        if (this.startsWith('()')) this.i += 2;
        this.skipNewlines();
        return { k: 'func', name, body: this.parseCommand() };
      }
    }
    if (this.startsWith('((')) {
      const start = this.i;
      const end = this.src.indexOf('))', this.i + 2);
      if (end < 0) throw new IncompleteInput('))');
      const expr = this.src.slice(this.i + 2, end);
      this.i = end + 2;
      return { k: 'simple', assigns: [], words: [[{ t: 'lit', v: '((', q: 0 }], [{ t: 'lit', v: expr, q: 1 }]], redirects: [], text: this.src.slice(start, this.i) };
    }
    if (this.peek() === '(') {
      this.i++;
      const body = this.parseList([]);
      this.skipSeparators();
      if (this.eof()) throw new IncompleteInput(')');
      if (this.peek() !== ')') throw new ParseError("bash: syntax error: expected ')'");
      this.i++;
      return { k: 'subshell', body, redirects: this.parseRedirectsTail() };
    }
    const fm = /^([A-Za-z_][\w-]*)\s*\(\s*\)/.exec(this.src.slice(this.i));
    if (fm) {
      this.i += fm[0].length;
      this.skipNewlines();
      return { k: 'func', name: fm[1], body: this.parseCommand() };
    }
    return this.parseSimple();
  }

  readName(): string {
    const m = /^[A-Za-z_][\w-]*/.exec(this.src.slice(this.i));
    if (!m) throw new ParseError('bash: syntax error: invalid name');
    this.i += m[0].length;
    return m[0];
  }

  parseRedirectsTail(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      this.skipWs();
      const r = this.tryRedirect();
      if (!r) break;
      out.push(r);
    }
    return out;
  }

  parseIf(): IfCmd {
    this.i += 2;
    const clauses: IfCmd['clauses'] = [];
    const cond = this.parseList(['then']);
    this.expectReserved('then');
    const body = this.parseList(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    let elseBody: List | null = null;
    for (;;) {
      this.skipSeparators();
      if (this.eof()) throw new IncompleteInput('fi');
      const rw = this.peekReserved();
      if (rw === 'elif') {
        this.i += 4;
        const c = this.parseList(['then']);
        this.expectReserved('then');
        clauses.push({ cond: c, body: this.parseList(['elif', 'else', 'fi']) });
        continue;
      }
      if (rw === 'else') {
        this.i += 4;
        elseBody = this.parseList(['fi']);
      }
      break;
    }
    this.expectReserved('fi');
    return { k: 'if', clauses, elseBody, redirects: this.parseRedirectsTail() };
  }

  parseFor(): ForCmd {
    this.i += 3;
    this.skipWs();
    const v = this.readName();
    this.skipWs();
    let items: Word[] | null = null;
    if (this.peekReserved() === 'in') {
      this.i += 2;
      items = [];
      for (;;) {
        this.skipWs();
        const c = this.peek();
        if (this.eof() || c === ';' || c === '\n') break;
        const w = this.readWord();
        if (!w) break;
        items.push(w);
      }
    }
    this.skipSeparators();
    this.expectReserved('do');
    const body = this.parseList(['done']);
    this.expectReserved('done');
    return { k: 'for', v, items, body, redirects: this.parseRedirectsTail() };
  }

  parseWhile(kind: 'while' | 'until'): WhileCmd {
    this.i += kind.length;
    const cond = this.parseList(['do']);
    this.expectReserved('do');
    const body = this.parseList(['done']);
    this.expectReserved('done');
    return { k: kind, cond, body, redirects: this.parseRedirectsTail() };
  }

  parseCase(): CaseCmd {
    this.i += 4;
    this.skipWs();
    const word = this.readWord();
    if (!word) throw new ParseError('bash: syntax error near `case\'');
    this.skipNewlines();
    if (this.peekReserved() !== 'in') throw new ParseError("bash: syntax error: expected 'in'");
    this.i += 2;
    const items: CaseCmd['items'] = [];
    for (;;) {
      this.skipSeparators(false);
      if (this.eof()) throw new IncompleteInput('esac');
      if (this.peekReserved() === 'esac') {
        this.i += 4;
        break;
      }
      if (this.peek() === '(') this.i++;
      const patterns: Word[] = [];
      for (;;) {
        this.skipWs();
        const w = this.readWord();
        if (!w) throw new ParseError('bash: syntax error in case pattern');
        patterns.push(w);
        this.skipWs();
        if (this.peek() === '|') {
          this.i++;
          continue;
        }
        break;
      }
      if (this.peek() !== ')') throw new ParseError("bash: syntax error: expected ')' in case");
      this.i++;
      const body = this.parseList(['esac', ';;']);
      this.skipWs();
      if (this.startsWith(';;')) this.i += 2;
      items.push({ patterns, body });
    }
    return { k: 'case', word, items, redirects: this.parseRedirectsTail() };
  }

  parseSimple(): SimpleCmd {
    const start = this.i;
    const cmd: SimpleCmd = { k: 'simple', assigns: [], words: [], redirects: [], text: '' };
    for (;;) {
      this.skipWs();
      if (this.eof()) break;
      const c = this.peek();
      if (c === '\n' || c === ';' || c === ')' || (c === '&' && !this.startsWith('&>')) || c === '|') break;
      const r = this.tryRedirect();
      if (r) {
        cmd.redirects.push(r);
        continue;
      }
      if (cmd.words.length === 1 && cmd.words[0].length === 1 && cmd.words[0][0].t === 'lit' && cmd.words[0][0].v === '[[' && cmd.words[0][0].q === 0) {
        // [[ ... ]]: los operadores son palabras normales
        for (;;) {
          this.skipWs();
          if (this.eof()) throw new IncompleteInput(']]');
          const two = this.src.slice(this.i, this.i + 2);
          if (two === '&&' || two === '||') {
            cmd.words.push([{ t: 'lit', v: two, q: 0 }]);
            this.i += 2;
            continue;
          }
          const ch = this.peek();
          if (ch === '<' || ch === '>' || ch === '(' || ch === ')') {
            cmd.words.push([{ t: 'lit', v: ch, q: 0 }]);
            this.i++;
            continue;
          }
          if (ch === '\n') throw new ParseError('bash: syntax error: unexpected newline in [[');
          const w = this.readWord();
          if (!w) break;
          cmd.words.push(w);
          if (w.length === 1 && w[0].t === 'lit' && w[0].v === ']]') break;
        }
        continue;
      }
      if (cmd.words.length === 0) {
        const am = /^([A-Za-z_]\w*)(\+?)=/.exec(this.src.slice(this.i));
        if (am) {
          this.i += am[0].length;
          if (this.peek() === '(') {
            this.i++;
            const arr: Word[] = [];
            for (;;) {
              this.skipNewlines();
              if (this.eof()) throw new IncompleteInput(')');
              if (this.peek() === ')') {
                this.i++;
                break;
              }
              const w = this.readWord();
              if (!w) throw new ParseError('bash: syntax error in array assignment');
              arr.push(w);
            }
            cmd.assigns.push({ name: am[1], value: [], append: am[2] === '+', array: arr });
            continue;
          }
          const value = this.readWord() ?? [];
          cmd.assigns.push({ name: am[1], value, append: am[2] === '+' });
          continue;
        }
      }
      const w = this.readWord();
      if (!w) {
        throw new ParseError(`bash: syntax error near unexpected token \`${c}'`);
      }
      cmd.words.push(w);
    }
    cmd.text = this.src.slice(start, this.i).trim();
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirects.length) {
      if (this.eof()) throw new IncompleteInput('command');
      throw new ParseError(`bash: syntax error near unexpected token \`${this.peek() === '\n' ? 'newline' : this.peek()}'`);
    }
    return cmd;
  }

  tryRedirect(): Redirect | null {
    const rest = this.src.slice(this.i, this.i + 5);
    let m = /^(&>>|&>)/.exec(rest);
    if (m) {
      this.i += m[1].length;
      this.skipWs();
      const target = this.readWord();
      if (!target) throw new ParseError('bash: syntax error near unexpected token `newline\'');
      return { fd: -1, op: m[1] === '&>>' ? '>>' : '>', target };
    }
    m = /^(\d?)(>>|>&|>\||>|<<<|<<-|<<|<&|<)/.exec(rest);
    if (!m) return null;
    this.i += m[0].length;
    const op = m[2];
    const fd = m[1] ? Number(m[1]) : op.startsWith('<') ? 0 : 1;
    this.skipWs();
    if (op === '>&' || op === '<&') {
      const dm = /^(\d+|-)/.exec(this.src.slice(this.i));
      if (dm) {
        this.i += dm[0].length;
        return { fd, op: '>&', dupFd: dm[1] === '-' ? -1 : Number(dm[1]) };
      }
      const target = this.readWord();
      return { fd: -1, op: '>', target: target ?? [] };
    }
    if (op === '<<' || op === '<<-') {
      const w = this.readWord();
      if (!w) throw new ParseError('bash: syntax error near unexpected token `newline\'');
      const quoted = w.some((p) => p.t === 'lit' && p.q !== 0);
      const delim = w.map((p) => (p.t === 'lit' ? p.v : p.t === 'var' ? '$' + p.name : '')).join('');
      const r: Redirect = { fd, op: '<<', heredoc: { body: '', expand: !quoted, strip: op === '<<-', delim } };
      this.pending.push(r);
      return r;
    }
    const target = this.readWord();
    if (!target) throw new ParseError('bash: syntax error near unexpected token `newline\'');
    return { fd, op: (op === '>|' ? '>' : op === '<<<' ? '<<<' : op) as Redirect['op'], target };
  }

  findClose(start: number, open: string, close: string): number {
    let depth = 0;
    for (let j = start; j < this.src.length; j++) {
      const c = this.src[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === "'") {
        const e = this.src.indexOf("'", j + 1);
        if (e < 0) return -1;
        j = e;
        continue;
      }
      if (c === '"') {
        j++;
        while (j < this.src.length && this.src[j] !== '"') {
          if (this.src[j] === '\\') j++;
          j++;
        }
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  readDollar(q: 0 | 2): WordPart {
    this.i++;
    const c = this.peek();
    if (c === '(' && this.peek(1) === '(') {
      const end = this.src.indexOf('))', this.i + 2);
      if (end < 0) throw new IncompleteInput('))');
      const src = this.src.slice(this.i + 2, end);
      this.i = end + 2;
      return { t: 'arith', src, q };
    }
    if (c === '(') {
      const end = this.findClose(this.i, '(', ')');
      if (end < 0) throw new IncompleteInput(')');
      const src = this.src.slice(this.i + 1, end);
      this.i = end + 1;
      return { t: 'cmd', src, q };
    }
    if (c === '{') {
      const end = this.findClose(this.i, '{', '}');
      if (end < 0) throw new IncompleteInput('}');
      const inner = this.src.slice(this.i + 1, end);
      this.i = end + 1;
      return parseBraceParam(inner, q);
    }
    if (c && /[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(this.src.slice(this.i))!;
      this.i += m[0].length;
      return { t: 'var', name: m[0], q };
    }
    if (c && /[0-9?$#@*!-]/.test(c)) {
      this.i++;
      return { t: 'var', name: c, q };
    }
    return { t: 'lit', v: '$', q };
  }

  readDouble(): WordPart[] {
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ t: 'lit', v: lit, q: 2 });
      lit = '';
    };
    for (;;) {
      if (this.eof()) throw new IncompleteInput('"');
      const c = this.peek();
      if (c === '"') {
        this.i++;
        break;
      }
      if (c === '\\') {
        const n = this.peek(1);
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if ('$`"\\'.includes(n)) {
          lit += n;
          this.i += 2;
          continue;
        }
        lit += c;
        this.i++;
        continue;
      }
      if (c === '$') {
        flush();
        parts.push(this.readDollar(2));
        continue;
      }
      if (c === '`') {
        flush();
        parts.push({ t: 'cmd', src: this.readBacktick(), q: 2 });
        continue;
      }
      lit += c;
      this.i++;
    }
    flush();
    if (!parts.length) parts.push({ t: 'lit', v: '', q: 2 });
    return parts;
  }

  readBacktick(): string {
    const end = this.src.indexOf('`', this.i + 1);
    if (end < 0) throw new IncompleteInput('`');
    const s = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    return s;
  }

  readWord(): Word | null {
    const parts: WordPart[] = [];
    let lit = '';
    const startI = this.i;
    const flush = () => {
      if (lit) parts.push({ t: 'lit', v: lit, q: 0 });
      lit = '';
    };
    while (!this.eof()) {
      const c = this.peek();
      if (WORD_END.test(c)) break;
      if (c === '\\') {
        const n = this.peek(1);
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if (n === undefined) {
          this.i++;
          break;
        }
        flush();
        parts.push({ t: 'lit', v: n, q: 1 });
        this.i += 2;
        continue;
      }
      if (c === "'") {
        flush();
        const end = this.src.indexOf("'", this.i + 1);
        if (end < 0) throw new IncompleteInput("'");
        parts.push({ t: 'lit', v: this.src.slice(this.i + 1, end), q: 1 });
        this.i = end + 1;
        continue;
      }
      if (c === '"') {
        flush();
        this.i++;
        parts.push(...this.readDouble());
        continue;
      }
      if (c === '$') {
        flush();
        if (this.peek(1) === "'") {
          // $'...' con escapes ANSI-C
          const end = this.src.indexOf("'", this.i + 2);
          if (end < 0) throw new IncompleteInput("'");
          const raw = this.src.slice(this.i + 2, end);
          parts.push({ t: 'lit', v: raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\'), q: 1 });
          this.i = end + 1;
          continue;
        }
        parts.push(this.readDollar(0));
        continue;
      }
      if (c === '`') {
        flush();
        parts.push({ t: 'cmd', src: this.readBacktick(), q: 0 });
        continue;
      }
      if (c === '~' && this.i === startI) {
        const m = /^~([A-Za-z0-9_-]*)/.exec(this.src.slice(this.i))!;
        const after = this.src[this.i + m[0].length];
        if (after === undefined || after === '/' || WORD_END.test(after) || after === ':') {
          parts.push({ t: 'tilde', user: m[1] });
          this.i += m[0].length;
          continue;
        }
      }
      lit += c;
      this.i++;
    }
    flush();
    return parts.length ? parts : null;
  }
}

/** Parsea el contenido de ${...}. */
function parseBraceParam(inner: string, q: 0 | 2): WordPart {
  if (inner.startsWith('#') && inner.length > 1) return { t: 'var', name: inner.slice(1), q, op: '#len' };
  if (inner.startsWith('!')) return { t: 'var', name: inner.slice(1), q, op: 'indirect' };
  const m = /^([A-Za-z_]\w*|[0-9?$#@*!-])(\[[^\]]+\])?(.*)$/s.exec(inner);
  if (!m) return { t: 'lit', v: '${' + inner + '}', q };
  const name = m[1] + (m[2] ?? '');
  const rest = m[3];
  if (!rest) return { t: 'var', name, q };
  const ops = [':-', ':=', ':+', ':?', '-', '=', '+', '?', '%%', '%', '##', '#', '//', '/', ',,', '^^', ',', '^', ':'];
  for (const op of ops) {
    if (rest.startsWith(op)) {
      const arg = rest.slice(op.length);
      if (op === '/' || op === '//') {
        const idx = arg.indexOf('/');
        const pat = idx >= 0 ? arg.slice(0, idx) : arg;
        const rep = idx >= 0 ? arg.slice(idx + 1) : '';
        return { t: 'var', name, q, op, arg: parseInnerWord(pat), arg2: parseInnerWord(rep) };
      }
      if (op === ':') {
        const [off, len] = arg.split(':');
        return { t: 'var', name, q, op: 'substr', arg: parseInnerWord(off), arg2: len !== undefined ? parseInnerWord(len) : undefined };
      }
      return { t: 'var', name, q, op, arg: parseInnerWord(arg) };
    }
  }
  return { t: 'lit', v: '${' + inner + '}', q };
}

/** Convierte el texto de un argumento de expansión en partes de palabra (como si estuviera entre comillas dobles). */
export function parseInnerWord(text: string): Word {
  const p = new ShParser(text + '"');
  return (p as any).readDouble();
}
