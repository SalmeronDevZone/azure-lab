// Búfer de pantalla del terminal: interpreta las secuencias ANSI más habituales (colores, \r, borrado de línea).

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Cell {
  c: string;
  s: number;
}

const BASE = ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#3b78ff', '#881798', '#3a96dd', '#cccccc'];
const BRIGHT = ['#767676', '#e74856', '#16c60c', '#f9f1a5', '#5b8fff', '#b4009e', '#61d6d6', '#f2f2f2'];

function color256(n: number): string {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const l = 8 + (n - 232) * 10;
  return `rgb(${l},${l},${l})`;
}

const MAX_LINES = 5000;

export class Screen {
  lines: Cell[][] = [[]];
  row = 0;
  col = 0;
  styles: Style[] = [{}];
  private styleIds = new Map<string, number>([['{}', 0]]);
  private cur: Style = {};
  private curId = 0;
  private pendingEsc = '';
  version = 0;

  private styleId(s: Style): number {
    const key = JSON.stringify(s);
    let id = this.styleIds.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push({ ...s });
      this.styleIds.set(key, id);
    }
    return id;
  }

  clear() {
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.version++;
  }

  private line(): Cell[] {
    while (this.lines.length <= this.row) this.lines.push([]);
    return this.lines[this.row];
  }

  private newline() {
    this.row++;
    this.col = 0;
    this.line();
    if (this.lines.length > MAX_LINES) {
      const drop = this.lines.length - MAX_LINES;
      this.lines.splice(0, drop);
      this.row -= drop;
    }
  }

  private put(ch: string) {
    const l = this.line();
    while (l.length < this.col) l.push({ c: ' ', s: 0 });
    l[this.col] = { c: ch, s: this.curId };
    this.col++;
  }

  private sgr(params: number[]) {
    if (!params.length) params = [0];
    const s = { ...this.cur };
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        for (const k of Object.keys(s) as (keyof Style)[]) delete s[k];
      } else if (p === 1) s.bold = true;
      else if (p === 2) s.dim = true;
      else if (p === 3) s.italic = true;
      else if (p === 4) s.underline = true;
      else if (p === 7) s.inverse = true;
      else if (p === 22) {
        delete s.bold;
        delete s.dim;
      } else if (p === 23) delete s.italic;
      else if (p === 24) delete s.underline;
      else if (p === 27) delete s.inverse;
      else if (p >= 30 && p <= 37) s.fg = `b${p - 30}`;
      else if (p >= 90 && p <= 97) s.fg = BRIGHT[p - 90];
      else if (p === 39) delete s.fg;
      else if (p >= 40 && p <= 47) s.bg = BASE[p - 40];
      else if (p >= 100 && p <= 107) s.bg = BRIGHT[p - 100];
      else if (p === 49) delete s.bg;
      else if ((p === 38 || p === 48) && params[i + 1] === 5) {
        const c = color256(params[i + 2] ?? 7);
        if (p === 38) s.fg = c;
        else s.bg = c;
        i += 2;
      } else if ((p === 38 || p === 48) && params[i + 1] === 2) {
        const c = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        if (p === 38) s.fg = c;
        else s.bg = c;
        i += 4;
      }
    }
    this.cur = s;
    this.curId = this.styleId(s);
  }

  private csi(params: string, final: string) {
    const nums = params
      .replace(/^\?/, '')
      .split(';')
      .filter((x) => x !== '')
      .map(Number);
    const n = nums[0] ?? 1;
    switch (final) {
      case 'm':
        this.sgr(params === '' ? [] : nums);
        break;
      case 'K': {
        const l = this.line();
        const mode = nums[0] ?? 0;
        if (mode === 0) l.length = Math.min(l.length, this.col);
        else if (mode === 2) l.length = 0;
        else if (mode === 1) for (let i = 0; i < Math.min(this.col, l.length); i++) l[i] = { c: ' ', s: 0 };
        break;
      }
      case 'J':
        if ((nums[0] ?? 0) >= 2) this.clear();
        break;
      case 'A':
        this.row = Math.max(0, this.row - n);
        break;
      case 'B':
        this.row += n;
        this.line();
        break;
      case 'C':
        this.col += n;
        break;
      case 'D':
        this.col = Math.max(0, this.col - n);
        break;
      case 'G':
        this.col = Math.max(0, (nums[0] ?? 1) - 1);
        break;
      default:
        break;
    }
  }

  write(data: string) {
    let s = this.pendingEsc + data;
    this.pendingEsc = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x1b') {
        if (i + 1 >= s.length) {
          this.pendingEsc = s.slice(i);
          break;
        }
        const nx = s[i + 1];
        if (nx === '[') {
          let j = i + 2;
          while (j < s.length && /[0-9;?]/.test(s[j])) j++;
          if (j >= s.length) {
            this.pendingEsc = s.slice(i);
            break;
          }
          this.csi(s.slice(i + 2, j), s[j]);
          i = j;
          continue;
        }
        if (nx === ']') {
          const end = s.indexOf('\x07', i);
          if (end < 0) {
            this.pendingEsc = s.slice(i);
            break;
          }
          i = end;
          continue;
        }
        i++;
        continue;
      }
      if (ch === '\n') this.newline();
      else if (ch === '\r') this.col = 0;
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch === '\t') {
        const next = (Math.floor(this.col / 8) + 1) * 8;
        while (this.col < next) this.put(' ');
      } else if (ch === '\x07') {
        /* campana */
      } else this.put(ch);
    }
    s = '';
    this.version++;
  }

  /** Estilo CSS de un identificador de estilo. */
  css(id: number): { color?: string; background?: string; className: string } {
    const st = this.styles[id] ?? {};
    let fg = st.fg;
    if (fg?.startsWith('b')) {
      const idx = Number(fg.slice(1));
      fg = st.bold ? BRIGHT[idx] : BASE[idx];
    }
    let bg = st.bg;
    if (st.inverse) [fg, bg] = [bg ?? '#0c0c0c', fg ?? '#cccccc'];
    const cls = [st.bold ? 'ansi-bold' : '', st.dim ? 'ansi-dim' : '', st.italic ? 'ansi-italic' : '', st.underline ? 'ansi-underline' : ''].filter(Boolean).join(' ');
    return { color: fg, background: bg, className: cls };
  }

  /** Texto plano de toda la pantalla (para copiar). */
  text(): string {
    return this.lines.map((l) => l.map((c) => c.c).join('')).join('\n');
  }
}

/** Divide una línea en tramos de igual estilo. */
export function segments(line: Cell[]): { text: string; s: number }[] {
  const out: { text: string; s: number }[] = [];
  for (const cell of line) {
    const last = out[out.length - 1];
    if (last && last.s === cell.s) last.text += cell.c;
    else out.push({ text: cell.c, s: cell.s });
  }
  return out;
}
