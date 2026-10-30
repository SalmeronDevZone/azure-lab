// Sistema de ficheros virtual (Cloud Shell, VMs y agentes de pipelines).
import type { FsDir, FsFile, FsNode } from '../engine/types';

export class FsError extends Error {
  constructor(public code: 'ENOENT' | 'EISDIR' | 'ENOTDIR' | 'EEXIST' | 'ENOTEMPTY' | 'EACCES' | 'EINVAL', public path: string) {
    super(
      {
        ENOENT: `No such file or directory`,
        EISDIR: `Is a directory`,
        ENOTDIR: `Not a directory`,
        EEXIST: `File exists`,
        ENOTEMPTY: `Directory not empty`,
        EACCES: `Permission denied`,
        EINVAL: `Invalid argument`,
      }[code],
    );
  }
}

export const ZIP_MAGIC = 'PK\u0003\u0004AZLAB-ZIP:';

export function makeZip(files: Record<string, string>): string {
  return ZIP_MAGIC + JSON.stringify(files);
}

export function readZip(content: string): Record<string, string> | null {
  if (!content.startsWith(ZIP_MAGIC)) return null;
  try {
    return JSON.parse(content.slice(ZIP_MAGIC.length));
  } catch {
    return null;
  }
}

export function isBinary(content: string): boolean {
  return content.startsWith('PK\u0003\u0004') || content.startsWith('\u001f\u008b');
}

export class VFS {
  constructor(public root: FsDir, private onChange?: () => void, public readOnlyPrefixes: string[] = []) {}

  private touch() {
    this.onChange?.();
  }

  normalize(cwd: string, path: string, home: string): string {
    let p = path;
    if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
    if (!p.startsWith('/')) p = (cwd.endsWith('/') ? cwd : cwd + '/') + p;
    const parts: string[] = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  getNode(abs: string): FsNode | undefined {
    if (abs === '/' || abs === '') return this.root;
    let cur: FsNode = this.root;
    for (const seg of abs.split('/').filter(Boolean)) {
      if (cur.t !== 'd') return undefined;
      const next: FsNode | undefined = cur.c[seg];
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  exists(abs: string) {
    return !!this.getNode(abs);
  }

  isDir(abs: string) {
    return this.getNode(abs)?.t === 'd';
  }

  isFile(abs: string) {
    return this.getNode(abs)?.t === 'f';
  }

  private parentOf(abs: string): { dir: FsDir; name: string } {
    const parts = abs.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new FsError('EINVAL', abs);
    const dirPath = '/' + parts.join('/');
    const dir = this.getNode(dirPath);
    if (!dir) throw new FsError('ENOENT', dirPath);
    if (dir.t !== 'd') throw new FsError('ENOTDIR', dirPath);
    return { dir, name };
  }

  private checkWritable(abs: string) {
    if (this.readOnlyPrefixes.some((p) => abs === p || abs.startsWith(p + '/'))) throw new FsError('EACCES', abs);
  }

  readFile(abs: string): string {
    const n = this.getNode(abs);
    if (!n) throw new FsError('ENOENT', abs);
    if (n.t === 'd') throw new FsError('EISDIR', abs);
    return n.d;
  }

  writeFile(abs: string, content: string, append = false) {
    this.checkWritable(abs);
    const { dir, name } = this.parentOf(abs);
    const ex = dir.c[name];
    if (ex && ex.t === 'd') throw new FsError('EISDIR', abs);
    const file: FsFile = { t: 'f', d: append && ex ? (ex as FsFile).d + content : content, mt: Date.now(), x: (ex as FsFile | undefined)?.x };
    dir.c[name] = file;
    dir.mt = Date.now();
    this.touch();
  }

  setExecutable(abs: string, x: boolean) {
    const n = this.getNode(abs);
    if (!n) throw new FsError('ENOENT', abs);
    if (n.t === 'f') n.x = x;
    this.touch();
  }

  mkdir(abs: string, recursive = false) {
    this.checkWritable(abs);
    if (recursive) {
      let cur = this.root;
      for (const seg of abs.split('/').filter(Boolean)) {
        const n = cur.c[seg];
        if (!n) {
          const d: FsDir = { t: 'd', c: {}, mt: Date.now() };
          cur.c[seg] = d;
          cur = d;
        } else if (n.t === 'd') cur = n;
        else throw new FsError('ENOTDIR', abs);
      }
      this.touch();
      return;
    }
    const { dir, name } = this.parentOf(abs);
    if (dir.c[name]) throw new FsError('EEXIST', abs);
    dir.c[name] = { t: 'd', c: {}, mt: Date.now() };
    this.touch();
  }

  rm(abs: string, recursive = false) {
    this.checkWritable(abs);
    const { dir, name } = this.parentOf(abs);
    const n = dir.c[name];
    if (!n) throw new FsError('ENOENT', abs);
    if (n.t === 'd' && !recursive) throw new FsError('EISDIR', abs);
    delete dir.c[name];
    this.touch();
  }

  rmdir(abs: string) {
    const n = this.getNode(abs);
    if (!n) throw new FsError('ENOENT', abs);
    if (n.t !== 'd') throw new FsError('ENOTDIR', abs);
    if (Object.keys(n.c).length) throw new FsError('ENOTEMPTY', abs);
    this.rm(abs, true);
  }

  list(abs: string): { name: string; node: FsNode }[] {
    const n = this.getNode(abs);
    if (!n) throw new FsError('ENOENT', abs);
    if (n.t !== 'd') return [{ name: abs.split('/').pop()!, node: n }];
    return Object.entries(n.c)
      .map(([name, node]) => ({ name, node }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  copy(src: string, dst: string, recursive = false) {
    const n = this.getNode(src);
    if (!n) throw new FsError('ENOENT', src);
    let target = dst;
    if (this.isDir(dst)) target = dst.replace(/\/$/, '') + '/' + src.split('/').pop();
    if (n.t === 'd') {
      if (!recursive) throw new FsError('EISDIR', src);
      this.mkdir(target, true);
      for (const { name } of this.list(src)) this.copy(`${src}/${name}`, `${target}/${name}`, true);
      return;
    }
    this.writeFile(target, n.d);
    if (n.x) this.setExecutable(target, true);
  }

  move(src: string, dst: string) {
    const n = this.getNode(src);
    if (!n) throw new FsError('ENOENT', src);
    let target = dst;
    if (this.isDir(dst)) target = dst.replace(/\/$/, '') + '/' + src.split('/').pop();
    this.checkWritable(target);
    const { dir, name } = this.parentOf(target);
    dir.c[name] = n;
    const p = this.parentOf(src);
    delete p.dir.c[p.name];
    this.touch();
  }

  /** Ficheros (rutas relativas) bajo un directorio. */
  snapshot(abs: string, ignore?: (rel: string) => boolean): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dirAbs: string, rel: string) => {
      for (const { name, node } of this.list(dirAbs)) {
        const r = rel ? `${rel}/${name}` : name;
        if (ignore?.(r)) continue;
        if (node.t === 'd') walk(`${dirAbs}/${name}`, r);
        else out[r] = node.d;
      }
    };
    const n = this.getNode(abs);
    if (!n) throw new FsError('ENOENT', abs);
    if (n.t === 'f') out[abs.split('/').pop()!] = n.d;
    else walk(abs === '/' ? '' : abs, '');
    return out;
  }

  writeTree(abs: string, files: Record<string, string>) {
    this.mkdir(abs, true);
    for (const [rel, content] of Object.entries(files)) {
      const p = `${abs}/${rel}`;
      this.mkdir(p.split('/').slice(0, -1).join('/') || '/', true);
      this.writeFile(p, content);
    }
  }

  glob(cwd: string, pattern: string, home: string): string[] {
    const abs = this.normalize(cwd, pattern, home);
    const parts = abs.split('/').filter(Boolean);
    let candidates = ['/'];
    for (const seg of parts) {
      const next: string[] = [];
      const hasWild = /[*?]/.test(seg) || /\[[^\]]+\]/.test(seg);
      const re = hasWild ? segmentRegex(seg) : null;
      for (const c of candidates) {
        const n = this.getNode(c);
        if (!n || n.t !== 'd') continue;
        if (!re) {
          if (n.c[seg]) next.push(`${c === '/' ? '' : c}/${seg}`);
          continue;
        }
        for (const name of Object.keys(n.c).sort()) {
          if (name.startsWith('.') && !seg.startsWith('.')) continue;
          if (re.test(name)) next.push(`${c === '/' ? '' : c}/${name}`);
        }
      }
      candidates = next;
    }
    return candidates;
  }
}

export function fsErrorText(cmd: string, path: string, e: unknown): string {
  if (e instanceof FsError) return `${cmd}: ${path}: ${e.message}`;
  return `${cmd}: ${(e as Error)?.message ?? e}`;
}

/** Convierte un segmento de glob (*, ?, [abc], [!abc]) en una expresión regular. */
function segmentRegex(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) {
        re += '\\[';
        continue;
      }
      let body = seg.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = end;
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
