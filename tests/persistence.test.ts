// Pruebas de la persistencia: navegador sólo (npm run dev) o navegador + servidor del contenedor (Docker).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const CLOUD = 'azlab:cloud:v1';

class FakeStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** Un servidor de Azure Lab de mentira: guarda lo que recibe y numera las revisiones. */
function fakeServer(initial: Record<string, string> = {}) {
  const keys = { ...initial };
  const revs: Record<string, string> = Object.fromEntries(Object.keys(initial).map((k) => [k, 'r0']));
  let n = 0;
  const srv = {
    keys,
    revs,
    puts: [] as string[],
    down: false,
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      if (srv.down) throw new TypeError('fetch failed');
      if (url === 'api/state') return Response.json({ server: 'azure-lab', keys, revs });
      const key = decodeURIComponent(url.replace('api/state/', ''));
      keys[key] = init!.body as string;
      revs[key] = `r${++n}`;
      srv.puts.push(key);
      return Response.json({ rev: revs[key] });
    }),
  };
  return srv;
}

let ls: FakeStorage;
const load = () => import('../src/engine/persistence');

beforeEach(() => {
  vi.resetModules();
  ls = new FakeStorage();
  vi.stubGlobal('localStorage', ls);
});
afterEach(() => vi.unstubAllGlobals());

describe('Persistencia sin servidor (npm run dev)', () => {
  it('si /api/state devuelve HTML (Vite) todo se queda en el navegador', async () => {
    const f = vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', f);
    const p = await load();
    await p.hydrate();
    expect(p.isRemote()).toBe(false);
    p.writeKey(CLOUD, '{"a":1}');
    await p.flushRemote();
    expect(ls.getItem(CLOUD)).toBe('{"a":1}');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('si no hay nadie escuchando, también', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const p = await load();
    await p.hydrate();
    expect(p.isRemote()).toBe(false);
    expect(p.canPersist()).toBe(true);
  });
});

describe('Persistencia con el servidor del contenedor', () => {
  it('los datos del servidor mandan sobre los del navegador', async () => {
    const srv = fakeServer({ [CLOUD]: '{"de":"servidor"}' });
    vi.stubGlobal('fetch', srv.fetch);
    ls.setItem(CLOUD, '{"de":"navegador"}');
    const p = await load();
    await p.hydrate();
    expect(p.isRemote()).toBe(true);
    expect(p.readKey(CLOUD)).toBe('{"de":"servidor"}');
    expect(ls.getItem(CLOUD)).toBe('{"de":"servidor"}');
    expect(ls.getItem(`azlab:base:${CLOUD}`)).toBe('r0');
  });

  it('la primera vez sube lo que ya había en el navegador', async () => {
    const srv = fakeServer();
    vi.stubGlobal('fetch', srv.fetch);
    ls.setItem(CLOUD, '{"mi":"nube"}');
    const p = await load();
    await p.hydrate();
    await p.flushRemote();
    expect(srv.keys[CLOUD]).toBe('{"mi":"nube"}');
  });

  it('cada guardado se sube y deja de estar pendiente', async () => {
    const srv = fakeServer({ [CLOUD]: '{}' });
    vi.stubGlobal('fetch', srv.fetch);
    const p = await load();
    await p.hydrate();
    p.writeKey(CLOUD, '{"v":1}');
    p.writeKey(CLOUD, '{"v":2}');
    expect(ls.getItem(`azlab:pending:${CLOUD}`)).toBe('1');
    await p.flushRemote();
    expect(srv.keys[CLOUD]).toBe('{"v":2}');
    expect(srv.puts).toEqual([CLOUD]); // los dos cambios seguidos viajan en una sola subida
    expect(ls.getItem(`azlab:pending:${CLOUD}`)).toBeNull();
    expect(ls.getItem(`azlab:base:${CLOUD}`)).toBe(srv.revs[CLOUD]);
  });

  it('las preferencias de pantalla no se suben', async () => {
    const srv = fakeServer();
    vi.stubGlobal('fetch', srv.fetch);
    const p = await load();
    await p.hydrate();
    p.writeKey('azlab:ui:v1', '{"fontSize":14}');
    await p.flushRemote();
    expect(srv.puts).toEqual([]);
    expect(ls.getItem('azlab:ui:v1')).toBe('{"fontSize":14}');
  });

  it('si el servidor no responde, el cambio queda pendiente y se reintenta', async () => {
    const srv = fakeServer({ [CLOUD]: '{}' });
    vi.stubGlobal('fetch', srv.fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await load();
    await p.hydrate();
    srv.down = true;
    p.writeKey(CLOUD, '{"v":"offline"}');
    await p.flushRemote();
    expect(srv.keys[CLOUD]).toBe('{}');
    expect(ls.getItem(`azlab:pending:${CLOUD}`)).toBe('1');
    srv.down = false;
    await p.flushRemote();
    expect(srv.keys[CLOUD]).toBe('{"v":"offline"}');
    expect(ls.getItem(`azlab:pending:${CLOUD}`)).toBeNull();
  });

  it('recupera un cambio que no llegó a subir al cerrar la pestaña...', async () => {
    // La sesión anterior partía de r0 y dejó un cambio pendiente; nadie más ha guardado desde entonces.
    const srv = fakeServer({ [CLOUD]: '{"v":"viejo"}' });
    vi.stubGlobal('fetch', srv.fetch);
    ls.setItem(CLOUD, '{"v":"ultimo cambio"}');
    ls.setItem(`azlab:pending:${CLOUD}`, '1');
    ls.setItem(`azlab:base:${CLOUD}`, 'r0');
    const p = await load();
    await p.hydrate();
    expect(p.readKey(CLOUD)).toBe('{"v":"ultimo cambio"}');
    await p.flushRemote();
    expect(srv.keys[CLOUD]).toBe('{"v":"ultimo cambio"}');
  });

  it('...pero no pisa lo que guardaste después desde otro dispositivo', async () => {
    const srv = fakeServer({ [CLOUD]: '{"v":"desde el movil"}' });
    srv.revs[CLOUD] = 'r7'; // el servidor ya no está en la revisión de la que partía este navegador
    vi.stubGlobal('fetch', srv.fetch);
    ls.setItem(CLOUD, '{"v":"pendiente del PC"}');
    ls.setItem(`azlab:pending:${CLOUD}`, '1');
    ls.setItem(`azlab:base:${CLOUD}`, 'r0');
    const p = await load();
    await p.hydrate();
    await p.flushRemote();
    expect(p.readKey(CLOUD)).toBe('{"v":"desde el movil"}');
    expect(srv.puts).toEqual([]);
    expect(ls.getItem(`azlab:pending:${CLOUD}`)).toBeNull();
  });
});
