// Runtime de aplicaciones simulado: interpreta (de forma limitada y segura) el código desplegado
// para responder a peticiones HTTP como lo haría la app real.
import { PUBLIC_IMAGES } from '../catalog';

export interface AppPackage {
  files: Record<string, string>;
  publicImage?: string | null;
  env?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
}

const NODE_BUILTINS = new Set(['fs', 'path', 'http', 'https', 'os', 'url', 'util', 'crypto', 'events', 'stream', 'child_process', 'process', 'assert', 'zlib', 'querystring', 'net', 'dns', 'buffer', 'timers']);

export function detectKind(files: Record<string, string>): 'node' | 'python' | 'static' | 'dotnet' | 'unknown' {
  const names = Object.keys(files);
  if (names.includes('package.json') || names.some((n) => /^(server|app|index)\.js$/.test(n))) return 'node';
  if (names.some((n) => /^(app|main|application)\.py$/.test(n)) || names.includes('requirements.txt')) return 'python';
  if (names.some((n) => n.endsWith('.csproj'))) return 'dotnet';
  if (names.some((n) => n.endsWith('.html'))) return 'static';
  return 'unknown';
}

function nodeEntry(files: Record<string, string>): string | undefined {
  try {
    const pkg = JSON.parse(files['package.json'] ?? '{}');
    if (pkg.main && files[pkg.main]) return pkg.main;
    const start: string | undefined = pkg.scripts?.start;
    const m = start ? /node\s+([\w./-]+\.js)/.exec(start) : null;
    if (m && files[m[1]]) return m[1];
  } catch {
    /* package.json inválido */
  }
  return ['server.js', 'app.js', 'index.js'].find((f) => files[f]);
}

/** Lee un fichero .env (CLAVE=valor, comentarios con #, comillas opcionales, "export" opcional). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** ¿El código carga dotenv? (require('dotenv').config() o require('dotenv/config')) */
function usesDotenv(files: Record<string, string>): boolean {
  const entry = nodeEntry(files);
  const src = entry ? files[entry] ?? '' : '';
  return /require\(\s*['"]dotenv['"]\s*\)\s*\.config\(/.test(src) || /require\(\s*['"]dotenv\/config['"]\s*\)/.test(src) || /import\s+['"]dotenv\/config['"]/.test(src);
}

/** Variables que dotenv cargaría del .env incluido en el paquete ({} si el código no usa dotenv o no hay .env). */
export function dotenvVars(files: Record<string, string>): Record<string, string> {
  if (files['.env'] === undefined || detectKind(files) !== 'node' || !usesDotenv(files)) return {};
  return parseDotenv(files['.env']);
}

/**
 * Entorno real del proceso: el .env (si dotenv lo carga) tiene la prioridad más baja; dotenv nunca sobrescribe
 * variables que ya existen, así que las App Settings y las del contenedor siempre ganan.
 */
export function effectiveEnv(pkg: AppPackage, extra: Record<string, string> = {}): Record<string, string> {
  return { ...dotenvVars(pkg.files), ...(pkg.env ?? {}), ...extra };
}

/** Error de arranque de la app (módulo inexistente, package.json roto...). null si arranca. */
export function appStartError(pkg: AppPackage): string | null {
  if (pkg.publicImage) return null;
  const files = pkg.files;
  const kind = detectKind(files);
  if (kind === 'node') {
    let deps: Record<string, string> = {};
    if (files['package.json']) {
      try {
        const j = JSON.parse(files['package.json']);
        deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
      } catch (e) {
        return `npm ERR! code EJSONPARSE\nnpm ERR! JSON.parse Failed to parse package.json: ${(e as Error).message}`;
      }
    }
    const entry = nodeEntry(files);
    if (!entry) return "Error: Cannot find module '/home/site/wwwroot/server.js'";
    const src = files[entry];
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const mod = m[1];
      if (mod.startsWith('.') || NODE_BUILTINS.has(mod) || mod.startsWith('node:')) continue;
      // 'dotenv/config' pertenece al paquete 'dotenv'; '@scope/pkg/x' al paquete '@scope/pkg'.
      const name = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
      if (!deps[name]) return `Error: Cannot find module '${mod}'\nRequire stack:\n- /home/site/wwwroot/${entry}\n(¿Falta "${mod}" en las dependencias de package.json?)`;
    }
    if (/\bthrow new Error\(/.test(src.split('app.get')[0] ?? '')) {
      const em = /throw new Error\(\s*(['"`])(.*?)\1/.exec(src);
      return `Error: ${em?.[2] ?? 'Unhandled error at startup'}`;
    }
  }
  return null;
}

/** Puerto en el que escucha la app. */
export function appListenPort(pkg: AppPackage): number {
  if (pkg.publicImage) {
    const info = PUBLIC_IMAGES[pkg.publicImage];
    return info?.port ?? 80;
  }
  const env = effectiveEnv(pkg);
  if (env.PORT && /^\d+$/.test(env.PORT)) return Number(env.PORT);
  const kind = detectKind(pkg.files);
  if (kind === 'node') {
    const entry = nodeEntry(pkg.files);
    const src = entry ? pkg.files[entry] : '';
    const m = /process\.env\.PORT\s*\|\|\s*(\d+)/.exec(src) ?? /\.listen\(\s*(\d+)/.exec(src);
    return m ? Number(m[1]) : 3000;
  }
  if (kind === 'python') {
    const src = Object.entries(pkg.files).find(([n]) => n.endsWith('.py'))?.[1] ?? '';
    const m = /port\s*=\s*(\d+)/.exec(src);
    return m ? Number(m[1]) : 8000;
  }
  return 80;
}

export function startupLog(pkg: AppPackage): string[] {
  if (pkg.publicImage) {
    if (pkg.publicImage === 'nginx') return ['/docker-entrypoint.sh: Configuration complete; ready for start up', `${new Date().toISOString()} [notice] 1#1: nginx/1.27.2`, `${new Date().toISOString()} [notice] 1#1: start worker processes`];
    return [`Iniciando ${pkg.publicImage}...`];
  }
  const err = appStartError(pkg);
  if (err) return err.split('\n');
  const kind = detectKind(pkg.files);
  const port = appListenPort(pkg);
  if (kind === 'node') {
    const entry = nodeEntry(pkg.files) ?? 'server.js';
    const src = pkg.files[entry] ?? '';
    const m = /console\.log\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/.exec(src);
    const vars = { port: String(port) } as Record<string, string>;
    const line = m ? evalExpr(m[1], vars, effectiveEnv(pkg)) : `Servidor escuchando en el puerto ${port}`;
    // dotenv 17 anuncia cuántas variables ha inyectado desde el .env.
    const dot = usesDotenv(pkg.files) && pkg.files['.env'] !== undefined ? [`[dotenv@17.2.3] injecting env (${Object.keys(parseDotenv(pkg.files['.env'])).length}) from .env`] : [];
    return [`> node ${entry}`, ...dot, String(line ?? '')];
  }
  if (kind === 'python') return [`[INFO] Starting gunicorn 23.0.0`, `[INFO] Listening at: http://0.0.0.0:${port}`, '[INFO] Booting worker with pid: 7'];
  return [];
}

// ---------------------------------------------------------------- mini evaluador de expresiones JS/Python

function findClosing(src: string, openIdx: number, open = '(', close = ')'): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          i = findClosing(src, i + 1, '{', '}');
        }
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(expr: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < expr.length && expr[j] !== q) {
        if (expr[j] === '\\') j++;
        j++;
      }
      cur += expr.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (depth === 0 && expr.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function unescapeStr(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"`\\])/g, '$1');
}

export function evalExpr(expr: string, vars: Record<string, any>, env: Record<string, string>): any {
  let e = expr.trim();
  if (!e) return undefined;
  if (e.startsWith('(') && findClosing(e, 0) === e.length - 1) return evalExpr(e.slice(1, -1), vars, env);
  const ors = splitTopLevel(e, '||');
  if (ors.length > 1) {
    for (const part of ors) {
      const v = evalExpr(part, vars, env);
      if (v) return v;
    }
    return evalExpr(ors[ors.length - 1], vars, env);
  }
  const pyOr = splitTopLevel(e, ' or ');
  if (pyOr.length > 1) {
    for (const part of pyOr) {
      const v = evalExpr(part, vars, env);
      if (v) return v;
    }
    return undefined;
  }
  const plus = splitTopLevel(e, '+');
  if (plus.length > 1) return plus.map((p) => evalExpr(p, vars, env)).map((v) => (v === undefined ? 'undefined' : String(v))).join('');
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  if (e === 'true' || e === 'True') return true;
  if (e === 'false' || e === 'False') return false;
  if (e === 'null' || e === 'None' || e === 'undefined') return undefined;
  const q = e[0];
  if ((q === '"' || q === "'") && e.endsWith(q)) return unescapeStr(e.slice(1, -1));
  if (q === '`' && e.endsWith('`')) {
    const body = e.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '$' && body[i + 1] === '{') {
        const end = findClosing(body, i + 1, '{', '}');
        const inner = body.slice(i + 2, end);
        const v = evalExpr(inner, vars, env);
        out += v === undefined ? 'undefined' : String(v);
        i = end;
      } else if (body[i] === '\\') {
        out += body[i + 1] === 'n' ? '\n' : body[i + 1];
        i++;
      } else out += body[i];
    }
    return out;
  }
  // f-strings de Python
  if (/^f(['"])/.test(e) && e.endsWith(e[1])) {
    const body = e.slice(2, -1);
    return body.replace(/\{([^}]+)\}/g, (_, inner) => {
      const v = evalExpr(inner, vars, env);
      return v === undefined ? 'None' : String(v);
    });
  }
  let m = /^process\.env\.(\w+)$/.exec(e) ?? /^process\.env\[\s*['"](\w+)['"]\s*\]$/.exec(e);
  if (m) return env[m[1]];
  m = /^os\.environ\.get\(\s*['"](\w+)['"]\s*(?:,\s*(.+))?\)$/.exec(e) ?? /^os\.getenv\(\s*['"](\w+)['"]\s*(?:,\s*(.+))?\)$/.exec(e);
  if (m) return env[m[1]] ?? (m[2] ? evalExpr(m[2], vars, env) : undefined);
  m = /^os\.environ\[\s*['"](\w+)['"]\s*\]$/.exec(e);
  if (m) return env[m[1]];
  if (e.startsWith('{') && e.endsWith('}')) {
    const obj: Record<string, any> = {};
    for (const pair of splitTopLevel(e.slice(1, -1), ',')) {
      if (!pair) continue;
      const idx = pair.indexOf(':');
      if (idx < 0) {
        obj[pair] = vars[pair];
        continue;
      }
      const k = pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
      obj[k] = evalExpr(pair.slice(idx + 1), vars, env);
    }
    return obj;
  }
  if (e.startsWith('[') && e.endsWith(']')) return splitTopLevel(e.slice(1, -1), ',').filter(Boolean).map((x) => evalExpr(x, vars, env));
  m = /^new Date\(\)\.toISOString\(\)$/.exec(e) ?? /^datetime\.now\(\)\.isoformat\(\)$/.exec(e);
  if (m) return new Date().toISOString();
  m = /^os\.hostname\(\)$/.exec(e) ?? /^socket\.gethostname\(\)$/.exec(e);
  if (m) return env.HOSTNAME ?? 'app-host';
  m = /^jsonify\((.*)\)$/s.exec(e);
  if (m) return evalExpr(m[1], vars, env);
  m = /^([A-Za-z_$][\w$]*)(?:\.(\w+))?$/.exec(e);
  if (m) {
    const base = vars[m[1]];
    return m[2] ? base?.[m[2]] : base;
  }
  return undefined;
}

function collectNodeVars(src: string, env: Record<string, string>): Record<string, any> {
  const vars: Record<string, any> = {};
  const re = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rhs = m[2].trim();
    if (/require\(|express\(\)|=>|function/.test(rhs)) continue;
    vars[m[1]] = evalExpr(rhs.replace(/;$/, ''), vars, env);
  }
  return vars;
}

interface Route {
  method: string;
  path: string;
  body: string;
}

function nodeRoutes(src: string): Route[] {
  const routes: Route[] = [];
  const re = /\b(?:app|router)\.(get|post|all|put|delete)\(\s*(['"`])([^'"`]+)\2\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index);
    const close = findClosing(src, open);
    routes.push({ method: m[1].toUpperCase(), path: m[3], body: src.slice(m.index, close > 0 ? close : undefined) });
  }
  return routes;
}

function routeMatches(pattern: string, path: string): boolean {
  if (pattern === '*' || pattern === '/*') return true;
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*') + '/?$');
  return re.test(path);
}

function renderNode(pkg: AppPackage, path: string, env: Record<string, string>): HttpResponse {
  const entry = nodeEntry(pkg.files)!;
  const src = pkg.files[entry];
  const vars = collectNodeVars(src, env);
  vars.port = appListenPort(pkg);
  // express.static('public')
  const st = /express\.static\(\s*['"]([^'"]+)['"]/.exec(src);
  if (st) {
    const dir = st[1].replace(/^\.\//, '').replace(/\/$/, '');
    const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
    const f = pkg.files[`${dir}/${rel}`];
    if (f !== undefined) return { status: 200, body: f, contentType: rel.endsWith('.html') ? 'text/html' : 'text/plain' };
  }
  for (const r of nodeRoutes(src)) {
    if (!['GET', 'ALL'].includes(r.method) || !routeMatches(r.path, path)) continue;
    const call = /res\.(?:status\((\d+)\)\.)?(send|json|end|sendStatus)\(/.exec(r.body);
    if (!call) continue;
    const open = r.body.indexOf('(', call.index + call[0].length - 1);
    const close = findClosing(r.body, open);
    const arg = r.body.slice(open + 1, close);
    const status = call[1] ? Number(call[1]) : call[2] === 'sendStatus' ? Number(arg) : 200;
    const local = { ...vars, ...collectNodeVars(r.body, env), req: { path } };
    const value = evalExpr(arg, local, env);
    if (call[2] === 'json' || (value && typeof value === 'object')) return { status, body: JSON.stringify(value), contentType: 'application/json' };
    return { status, body: value === undefined ? '' : String(value), contentType: 'text/html; charset=utf-8' };
  }
  return { status: 404, body: `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Error</title></head>\n<body><pre>Cannot GET ${path}</pre></body>\n</html>`, contentType: 'text/html' };
}

function renderPython(pkg: AppPackage, path: string, env: Record<string, string>): HttpResponse {
  const [, src] = Object.entries(pkg.files).find(([n]) => /^(app|main|application)\.py$/.test(n)) ?? ['', ''];
  const vars: Record<string, any> = {};
  const vre = /^([A-Za-z_]\w*)\s*=\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = vre.exec(src))) {
    if (/Flask\(|FastAPI\(|def |lambda/.test(m[2])) continue;
    vars[m[1]] = evalExpr(m[2], vars, env);
  }
  const rre = /@app\.(?:route|get)\(\s*['"]([^'"]+)['"][^)]*\)\s*\n\s*(?:async\s+)?def\s+\w+\([^)]*\):([\s\S]*?)(?=\n@|\nif __name__|$)/g;
  while ((m = rre.exec(src))) {
    if (!routeMatches(m[1].replace(/<[^>]+>/g, ':p'), path)) continue;
    const ret = /return\s+(.+)/.exec(m[2]);
    const value = ret ? evalExpr(ret[1].trim(), vars, env) : '';
    if (value && typeof value === 'object') return { status: 200, body: JSON.stringify(value), contentType: 'application/json' };
    return { status: 200, body: String(value ?? ''), contentType: 'text/html; charset=utf-8' };
  }
  return { status: 404, body: '<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server.</p>', contentType: 'text/html' };
}

function renderStatic(files: Record<string, string>, path: string, notFoundDoc?: string | null): HttpResponse {
  let rel = decodeURIComponent(path.split('?')[0]).replace(/^\//, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (files[rel] !== undefined) return { status: 200, body: files[rel], contentType: contentTypeOf(rel) };
  if (files[rel + '/index.html'] !== undefined) return { status: 200, body: files[rel + '/index.html'], contentType: 'text/html' };
  if (notFoundDoc && files[notFoundDoc] !== undefined) return { status: 404, body: files[notFoundDoc], contentType: 'text/html' };
  return { status: 404, body: '<h1>404 Not Found</h1>', contentType: 'text/html' };
}

export function contentTypeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', xml: 'application/xml', zip: 'application/zip' };
  return map[ext ?? ''] ?? 'application/octet-stream';
}

/** Responde una petición HTTP GET contra un paquete de aplicación. */
export function renderApp(pkg: AppPackage, path: string, env: Record<string, string> = {}): HttpResponse {
  const fullEnv = effectiveEnv(pkg, env);
  if (pkg.publicImage) {
    const info = PUBLIC_IMAGES[pkg.publicImage];
    if (!info) return { status: 502, body: 'Bad Gateway', contentType: 'text/plain' };
    if (path !== '/' && path !== '/index.html') return { status: 404, body: '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx/1.27.2</center></body></html>', contentType: 'text/html' };
    return { status: 200, body: info.response, contentType: 'text/html' };
  }
  const err = appStartError(pkg);
  if (err) return { status: 503, body: ':( Application Error\nSi eres el propietario de la aplicación, revisa los registros (log stream).', contentType: 'text/html', headers: { 'x-sim-error': err } };
  const kind = detectKind(pkg.files);
  if (kind === 'node') return renderNode(pkg, path, fullEnv);
  if (kind === 'python') return renderPython(pkg, path, fullEnv);
  if (kind === 'dotnet') return { status: 200, body: '<h1>Hello, World!</h1><p>ASP.NET Core en Azure</p>', contentType: 'text/html' };
  return renderStatic(pkg.files, path);
}

export function renderStaticSite(files: Record<string, string>, path: string, notFoundDoc?: string | null): HttpResponse {
  return renderStatic(files, path, notFoundDoc);
}

/** Pruebas unitarias simuladas: interpreta "node test.js" buscando aserciones de tipo includes(). */
export function runNodeTests(files: Record<string, string>, script: string): { ok: boolean; output: string[] } {
  const src = files[script];
  if (src === undefined) return { ok: false, output: [`node:internal/modules/cjs/loader:1228`, `  throw err;`, `Error: Cannot find module '/home/vsts/work/1/s/${script}'`] };
  const out: string[] = [];
  const target = /readFileSync\(\s*['"]([^'"]+)['"]/.exec(src)?.[1];
  const targetSrc = target ? files[target.replace(/^\.\//, '')] ?? '' : '';
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cond = /if\s*\(\s*(!?)\s*\w+\.includes\(\s*(['"`])(.*?)\2\s*\)\s*\)/.exec(line);
    if (cond) {
      const negated = cond[1] === '!';
      const has = targetSrc.includes(cond[3]);
      const triggered = negated ? !has : has;
      // Busca el bloque del if
      let j = i;
      const block: string[] = [];
      while (j < lines.length && !lines[j].includes('}')) block.push(lines[j++]);
      if (j < lines.length) block.push(lines[j]);
      if (triggered) {
        for (const b of block) {
          const em = /console\.(?:error|log)\(\s*(['"`])(.*?)\1/.exec(b);
          if (em) out.push(em[2]);
          if (/process\.exit\(\s*[1-9]/.test(b) || /throw /.test(b)) return { ok: false, output: out };
        }
      }
      i = j;
      continue;
    }
    const assertM = /assert(?:\.ok)?\(\s*\w+\.includes\(\s*(['"`])(.*?)\1\s*\)/.exec(line);
    if (assertM && !targetSrc.includes(assertM[2])) {
      out.push(`AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value`);
      return { ok: false, output: out };
    }
    const log = /^\s*console\.log\(\s*(['"`])(.*?)\1\s*\)/.exec(line);
    if (log) out.push(log[2]);
    if (/^\s*process\.exit\(\s*[1-9]/.test(line)) return { ok: false, output: out };
  }
  return { ok: true, output: out };
}
