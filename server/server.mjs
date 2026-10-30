// Servidor de Azure Lab para Docker: sirve la app compilada (dist/) y guarda tu nube en disco (DATA_DIR).
// Sólo usa módulos de Node, sin dependencias. Arranque local: npm run build && npm start
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Qué se guarda y en qué fichero del volumen.
const FILES = { 'azlab:cloud:v1': 'nube.json', 'azlab:academy:v1': 'academia.json' };
const MAX_BODY = 50 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const revOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const type = isJson ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : typeof body === 'string' ? { 'content-type': 'text/plain; charset=utf-8' } : {};
  res.writeHead(status, { 'x-content-type-options': 'nosniff', ...type, ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? fail(Object.assign(new Error('Los datos superan 50 MB'), { status: 413 })) : ok(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', fail);
  });
}

export function createApp(opts) {
  const distDir = resolve(opts.distDir);
  const dataDir = resolve(opts.dataDir);
  const writes = new Map(); // fichero -> última escritura en curso (se encadenan para no pisarse)

  /** Escritura atómica: primero a un temporal y luego se renombra, así nunca queda un JSON a medias. */
  function save(file, text) {
    const path = join(dataDir, file);
    const prev = writes.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
      await writeFile(`${path}.tmp`, text, 'utf8');
      await rename(`${path}.tmp`, path);
    });
    writes.set(file, next.catch(() => {}));
    return next;
  }

  async function api(req, res, path, raw) {
    if (path === '/api/health') return send(res, 200, { status: 'ok' });
    if (path === '/api/state' && req.method === 'GET') {
      const keys = {};
      const revs = {};
      for (const [key, file] of Object.entries(FILES)) {
        const text = await readText(join(dataDir, file));
        if (text !== null) {
          keys[key] = text;
          revs[key] = revOf(text);
        }
      }
      return send(res, 200, { server: 'azure-lab', keys, revs });
    }
    // La clave se busca en la ruta sin descodificar: una "/" codificada (%2F) no parte la ruta.
    const m = /^\/api\/state\/([^/]+)$/.exec(raw);
    if (m && req.method === 'PUT') {
      const key = decodeURIComponent(m[1]);
      const file = Object.hasOwn(FILES, key) ? FILES[key] : null;
      if (!file) return send(res, 404, { error: 'Clave desconocida' });
      const text = await readBody(req);
      try {
        JSON.parse(text);
      } catch {
        return send(res, 400, { error: 'El cuerpo no es JSON válido' });
      }
      await save(file, text);
      return send(res, 200, { rev: revOf(text) });
    }
    return send(res, path.startsWith('/api/state') ? 405 : 404, { error: 'No encontrado' });
  }

  async function files(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido', { allow: 'GET, HEAD' });
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const full = resolve(distDir, rel);
    // Nada fuera de dist/ (rutas con ../).
    if (full !== distDir && !full.startsWith(distDir + sep)) return send(res, 404, 'No encontrado');
    let info;
    try {
      info = await stat(full);
    } catch {
      return send(res, 404, 'No encontrado');
    }
    if (!info.isFile()) return send(res, 404, 'No encontrado');
    // Los ficheros de assets/ llevan un hash en el nombre: pueden guardarse en caché para siempre.
    const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream';
    const body = req.method === 'HEAD' ? '' : await readFile(full);
    send(res, 200, body, { 'content-type': type, 'cache-control': cache, 'content-length': String(info.size) });
  }

  const server = createServer(async (req, res) => {
    try {
      const raw = new URL(req.url ?? '/', 'http://localhost').pathname;
      let path;
      try {
        path = decodeURIComponent(raw);
      } catch {
        return send(res, 400, 'Ruta no válida');
      }
      if (path.startsWith('/api/')) await api(req, res, path, raw);
      else await files(req, res, path);
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : 'Error interno' });
      else res.destroy();
    }
  });
  /** Espera a que terminen las escrituras en curso (para apagar sin perder datos). */
  server.flush = () => Promise.all(writes.values());
  return server;
}

// Arranque directo (node server/server.mjs). Al importarlo, en las pruebas, no arranca nada.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distDir = resolve(process.env.DIST_DIR ?? join(here, '..', 'dist'));
  const dataDir = resolve(process.env.DATA_DIR ?? join(here, '..', 'data'));
  const port = Number(process.env.PORT ?? 8080);
  await mkdir(dataDir, { recursive: true });
  const server = createApp({ distDir, dataDir });
  // En Docker éste es el puerto de dentro del contenedor; desde tu PC entras por el que publique docker-compose.yml.
  server.listen(port, '0.0.0.0', () => console.log(`Azure Lab escuchando en el puerto ${port} · datos en ${dataDir}`));
  // docker stop envía SIGTERM: se termina lo que se estaba guardando y se sale (sin esperar los 10 s del apagado forzoso).
  const stop = async (signal) => {
    console.log(`${signal} recibido: guardando y apagando...`);
    server.close();
    await server.flush();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
