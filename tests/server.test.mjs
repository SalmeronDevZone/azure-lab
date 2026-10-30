// Pruebas del servidor del contenedor (server/server.mjs): sirve la app y guarda la nube en disco.
// En JavaScript, como el propio servidor: el proyecto no instala los tipos de Node para TypeScript.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/server.mjs';

let root, dist, data, server, base;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'azlab-server-'));
  dist = join(root, 'dist');
  data = join(root, 'data');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(data);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Azure Lab</title>');
  await writeFile(join(dist, 'assets', 'app-1a2b.js'), 'console.log(1)');
  await writeFile(join(root, 'secreto.txt'), 'no deberías verme');
  server = createApp({ distDir: dist, dataDir: data });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  await rm(root, { recursive: true, force: true });
});

const KEY = encodeURIComponent('azlab:cloud:v1');

describe('Servidor de Azure Lab', () => {
  it('sirve la app, con caché larga sólo para los assets con hash', async () => {
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const js = await fetch(base + '/assets/app-1a2b.js');
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(base + '/no-existe.js')).status).toBe(404);
  });

  it('no deja salir de dist/ con rutas ../', async () => {
    // fetch normaliza "../" antes de enviar; con %2f (barra codificada) llega tal cual al servidor.
    for (const p of ['/../secreto.txt', '/..%2fsecreto.txt', '/assets/..%2f..%2fsecreto.txt']) {
      const r = await fetch(base + p);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('no deberías');
    }
  });

  it('responde al healthcheck', async () => {
    const r = await fetch(base + '/api/health');
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  it('sin datos devuelve un estado vacío que la app reconoce', async () => {
    const r = await fetch(base + '/api/state');
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ server: 'azure-lab', keys: {}, revs: {} });
  });

  it('guarda la nube en el volumen y la devuelve con su revisión', async () => {
    const nube = JSON.stringify({ schema: 1, me: { upn: 'ana@contoso.com' } });
    const put = await fetch(`${base}/api/state/${KEY}`, { method: 'PUT', body: nube });
    expect(put.status).toBe(200);
    const { rev } = await put.json();
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(await readFile(join(data, 'nube.json'), 'utf8')).toBe(nube);
    // Escritura atómica: no queda el temporal.
    expect(await readdir(data)).toEqual(['nube.json']);
    const got = await (await fetch(base + '/api/state')).json();
    expect(got.keys['azlab:cloud:v1']).toBe(nube);
    expect(got.revs['azlab:cloud:v1']).toBe(rev);
  });

  it('rechaza claves desconocidas, JSON roto y métodos que no tocan', async () => {
    expect((await fetch(`${base}/api/state/${encodeURIComponent('../../etc/passwd')}`, { method: 'PUT', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/state/toString`, { method: 'PUT', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/state/${KEY}`, { method: 'PUT', body: '{roto' })).status).toBe(400);
    expect((await fetch(`${base}/api/state/${KEY}`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(base + '/', { method: 'POST', body: 'x' })).status).toBe(405);
    // Lo guardado antes sigue intacto.
    expect(JSON.parse(await readFile(join(data, 'nube.json'), 'utf8')).schema).toBe(1);
  });

  it('las escrituras seguidas no se pisan: gana la última', async () => {
    const puts = [1, 2, 3, 4, 5].map((n) => fetch(`${base}/api/state/${KEY}`, { method: 'PUT', body: JSON.stringify({ n }) }));
    await Promise.all(puts);
    await server.flush();
    const final = JSON.parse(await readFile(join(data, 'nube.json'), 'utf8'));
    expect([1, 2, 3, 4, 5]).toContain(final.n);
    expect(await readdir(data)).toEqual(['nube.json']);
  });
});
