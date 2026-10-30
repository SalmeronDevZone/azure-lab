// Motor de construcción de imágenes a partir de un Dockerfile (docker build, az acr build y tareas de pipeline).
import type { VFS } from '../fs';
import type { PrincipalRef } from '../../engine/types';
import { findPublicImage, normalizeImageName } from '../../engine/catalog';
import { findRegistryByLoginServer } from '../../engine/services/kube';
import { hasPermission } from '../../engine/arm';
import { getState } from '../../engine/store';
import { globToRegex } from '../interp';
import { shortHash } from '../../engine/util';

export interface BuiltImage {
  files: Record<string, string>;
  env: Record<string, string>;
  exposed?: number;
  cmd?: string;
  base: string;
  size: number;
  steps: string[];
  publicImage?: string | null;
}

export class BuildError extends Error {}

interface Stage {
  name?: string;
  base: string;
  workdir: string;
  files: Record<string, string>;
  env: Record<string, string>;
  exposed?: number;
  cmd?: string;
}

function parseDockerfile(text: string): { instr: string; args: string; line: number }[] {
  const out: { instr: string; args: string; line: number }[] = [];
  const lines = text.split('\n');
  let buf = '';
  let start = 0;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\r$/, '');
    if (!buf && (/^\s*#/.test(l) || !l.trim())) return;
    if (!buf) start = i + 1;
    if (l.endsWith('\\')) {
      buf += l.slice(0, -1) + ' ';
      return;
    }
    buf += l;
    const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(buf);
    if (m) out.push({ instr: m[1].toUpperCase(), args: m[2].trim(), line: start });
    buf = '';
  });
  return out;
}

function parseJsonOrShell(args: string): string {
  if (args.startsWith('[')) {
    try {
      return (JSON.parse(args) as string[]).join(' ');
    } catch {
      return args;
    }
  }
  return args;
}

function dockerIgnore(text: string | undefined): (rel: string) => boolean {
  const pats = (text ?? '').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  const res = pats.map((p) => ({ neg: p.startsWith('!'), re: globToRegex(p.replace(/^!/, '').replace(/\/$/, '').replace(/^\.\//, '')) }));
  return (rel: string) => {
    let ignored = false;
    for (const r of res) {
      const top = rel.split('/')[0];
      if (r.re.test(rel) || r.re.test(top)) ignored = !r.neg;
    }
    return ignored;
  };
}

export interface BuildOptions {
  fs: VFS;
  contextDir: string;
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  /** Identidad/credenciales para FROM de imágenes privadas en ACR. */
  acrLogins?: string[];
  principal?: PrincipalRef | null;
  onStep?: (line: string) => void;
}

export function buildImage(o: BuildOptions): BuiltImage {
  const dfPath = o.dockerfile ? (o.dockerfile.startsWith('/') ? o.dockerfile : `${o.contextDir}/${o.dockerfile}`) : `${o.contextDir}/Dockerfile`;
  let df: string;
  try {
    df = o.fs.readFile(dfPath);
  } catch {
    throw new BuildError(`ERROR: failed to solve: failed to read dockerfile: open ${dfPath.split('/').pop()}: no such file or directory`);
  }
  const ignore = dockerIgnore(o.fs.isFile(`${o.contextDir}/.dockerignore`) ? o.fs.readFile(`${o.contextDir}/.dockerignore`) : undefined);
  const context = o.fs.snapshot(o.contextDir, (rel) => ignore(rel) || rel.startsWith('.git/'));
  const instrs = parseDockerfile(df);
  if (!instrs.length || instrs[0].instr !== 'FROM' && !(instrs[0].instr === 'ARG' && instrs.some((x) => x.instr === 'FROM'))) {
    throw new BuildError('ERROR: failed to solve: dockerfile parse error: no build stage in current context (falta la instrucción FROM)');
  }
  const stages: Stage[] = [];
  let cur: Stage | null = null;
  const args: Record<string, string> = { ...(o.buildArgs ?? {}) };
  const steps: string[] = [];
  const expand = (s: string) => s.replace(/\$\{?(\w+)\}?/g, (m, k) => args[k] ?? cur?.env[k] ?? m);
  const total = instrs.filter((x) => x.instr !== 'ARG' || cur).length;
  let n = 0;
  for (const it of instrs) {
    const a = expand(it.args);
    switch (it.instr) {
      case 'ARG': {
        const [k, v] = a.split('=');
        if (!(k in args)) args[k] = v ?? '';
        if (!cur) continue;
        break;
      }
      case 'FROM': {
        const m = /^(\S+)(?:\s+AS\s+(\S+))?/i.exec(a)!;
        const image = m[1];
        const prev = stages.find((s) => s.name && s.name.toLowerCase() === image.toLowerCase());
        const { registry } = normalizeImageName(image);
        let files: Record<string, string> = {};
        if (prev) files = { ...prev.files };
        else if (registry?.endsWith('.azurecr.io')) {
          const reg = findRegistryByLoginServer(registry);
          if (!reg) throw new BuildError(`ERROR: failed to solve: ${image}: failed to resolve source metadata for ${image}: failed to do request: dial tcp: lookup ${registry}: no such host`);
          const logged = (o.acrLogins ?? []).some((x) => x.toLowerCase() === registry);
          if (!logged && !(o.principal && hasPermission(o.principal, 'Microsoft.ContainerRegistry/registries/pull/read', reg.id))) {
            throw new BuildError(`ERROR: failed to solve: ${image}: failed to resolve source metadata for ${image}: failed to authorize: failed to fetch anonymous token: unexpected status: 401 Unauthorized`);
          }
          const { repo, tag } = normalizeImageName(image);
          const t = reg.data?.repos?.[repo]?.tags?.[tag];
          if (!t) throw new BuildError(`ERROR: failed to solve: ${image}: ${image}: not found`);
          files = Object.fromEntries(Object.entries<string>(t.files ?? {}).map(([k, v]) => ['/' + k.replace(/^\//, ''), v]));
        } else if (!findPublicImage(image)) {
          throw new BuildError(`ERROR: failed to solve: ${image}: failed to resolve source metadata for docker.io/library/${image}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`);
        }
        cur = { name: m[2], base: prev ? prev.base : image, workdir: prev?.workdir ?? '/', files, env: { ...(prev?.env ?? {}) }, exposed: prev?.exposed, cmd: prev?.cmd };
        stages.push(cur);
        break;
      }
      case 'WORKDIR':
        cur!.workdir = a.startsWith('/') ? a : `${cur!.workdir.replace(/\/$/, '')}/${a}`;
        break;
      case 'COPY':
      case 'ADD': {
        const parts = a.split(/\s+/).filter(Boolean);
        let from: string | undefined;
        const clean = parts.filter((p) => {
          if (p.startsWith('--from=')) {
            from = p.slice(7);
            return false;
          }
          return !p.startsWith('--');
        });
        const dest = clean.pop() ?? '.';
        let srcStage: Stage | undefined;
        if (from) {
          srcStage = stages.find((st) => st.name?.toLowerCase() === from!.toLowerCase());
          if (!srcStage) throw new BuildError(`ERROR: failed to solve: invalid from flag value ${from}: stage not found`);
        }
        const absDest = dest.startsWith('/') ? normAbs(dest) : normAbs(`${cur!.workdir}/${dest}`);
        const destIsDir = dest.endsWith('/') || dest === '.' || dest === './' || clean.length > 1;
        for (const s0 of clean) {
          // claves de origen relativas al contexto, o absolutas si vienen de otra etapa
          const entries: [string, string][] = srcStage ? Object.entries(srcStage.files).map(([k, v]) => [k.replace(/^\//, ''), v]) : Object.entries(context);
          const pat = srcStage ? (s0.startsWith('/') ? normAbs(s0) : normAbs(`${srcStage.workdir}/${s0}`)).replace(/^\//, '') : s0.replace(/^\.\//, '').replace(/\/$/, '');
          let matched = 0;
          for (const [rel, content] of entries) {
            let tail: string | null = null;
            if (pat === '.' || pat === '') tail = rel;
            else if (/[*?]/.test(pat)) {
              if (globToRegex(pat).test(rel) || (!pat.includes('/') && globToRegex(pat).test(rel.split('/').pop()!) && !rel.includes('/'))) tail = rel.split('/').pop()!;
            } else if (rel === pat) tail = destIsDir ? rel.split('/').pop()! : '';
            else if (rel.startsWith(pat + '/')) tail = rel.slice(pat.length + 1);
            if (tail === null) continue;
            matched++;
            cur!.files[tail ? normAbs(`${absDest}/${tail}`) : absDest] = content;
          }
          if (!matched) {
            throw new BuildError(`ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref ${shortHash(s0, 12)}::${shortHash(s0 + 'x', 12)}: "/${pat}": not found
(El fichero "${s0}" no existe en el contexto de compilación o está excluido por .dockerignore.)`);
          }
        }
        break;
      }
      case 'RUN': {
        if (/npm (ci|install)/.test(a)) {
          let deps = 0;
          try {
            const pkg = JSON.parse(cur!.files[normAbs(`${cur!.workdir}/package.json`)] ?? '{}');
            deps = Object.keys(pkg.dependencies ?? {}).length;
          } catch {
            throw new BuildError(`ERROR: failed to solve: process "/bin/sh -c ${a}" did not complete successfully: exit code: 1\nnpm ERR! code EJSONPARSE`);
          }
          if (!cur!.files[normAbs(`${cur!.workdir}/package.json`)]) throw new BuildError(`ERROR: failed to solve: process "/bin/sh -c ${a}" did not complete successfully: exit code: 254\nnpm ERR! enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/app/package.json'\n(¿Has copiado package.json antes de ejecutar npm install?)`);
          o.onStep?.(`#${n + 1} added ${deps * 32 + 7} packages, and audited ${deps * 32 + 8} packages in 3s`);
        } else if (/pip install/.test(a)) o.onStep?.(`#${n + 1} Successfully installed flask-3.0.3 gunicorn-23.0.0`);
        else if (/exit 1|false$/.test(a)) throw new BuildError(`ERROR: failed to solve: process "/bin/sh -c ${a}" did not complete successfully: exit code: 1`);
        break;
      }
      case 'ENV': {
        const m = /^(\w+)=(.*)$/.exec(a) ?? /^(\w+)\s+(.*)$/.exec(a);
        if (m) {
          for (const pair of a.match(/(\w+)=("[^"]*"|\S+)/g) ?? [`${m[1]}=${m[2]}`]) {
            const eq = pair.indexOf('=');
            cur!.env[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^"|"$/g, '');
          }
        }
        break;
      }
      case 'EXPOSE':
        cur!.exposed = Number(a.split(/[\s/]/)[0]);
        break;
      case 'CMD':
      case 'ENTRYPOINT':
        cur!.cmd = parseJsonOrShell(a);
        break;
      case 'USER':
      case 'LABEL':
      case 'HEALTHCHECK':
      case 'VOLUME':
      case 'STOPSIGNAL':
      case 'SHELL':
      case 'ONBUILD':
        break;
      default:
        throw new BuildError(`ERROR: failed to solve: dockerfile parse error on line ${it.line}: unknown instruction: ${it.instr}`);
    }
    n++;
    const line = `[${Math.min(n, total)}/${total}] ${it.instr} ${it.args}`;
    steps.push(line);
    o.onStep?.(line);
  }
  const final = stages[stages.length - 1];
  const pub = findPublicImage(final.base);
  const size = Math.round(((pub?.size ?? 120) + Object.values(final.files).reduce((acc, f) => acc + f.length, 0) / 1048576) * 10) / 10;
  const wd = final.workdir.replace(/\/$/, '');
  const files: Record<string, string> = {};
  for (const [abs, content] of Object.entries(final.files)) {
    let rel = abs;
    const web = /^\/usr\/share\/nginx\/html\/|^\/usr\/local\/apache2\/htdocs\//.exec(abs);
    if (web) rel = abs.slice(web[0].length);
    else if (wd && wd !== '' && abs.startsWith(wd + '/')) rel = abs.slice(wd.length + 1);
    else rel = abs.replace(/^\//, '');
    files[rel] = content;
  }
  return {
    files,
    env: final.env,
    exposed: final.exposed,
    cmd: final.cmd,
    base: final.base,
    size,
    steps,
    publicImage: Object.keys(files).length ? null : pub?.name ?? null,
  };
}

function normAbs(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function imageId(seed: string): string {
  return shortHash(seed + Date.now(), 64);
}

export function nowState() {
  return getState();
}
