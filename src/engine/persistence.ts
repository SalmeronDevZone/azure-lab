// Persistencia de la nube y del progreso: siempre en el navegador (localStorage) y, si la app la sirve
// el contenedor Docker (server/server.mjs), también en su volumen /data, que es entonces la copia de referencia.

/** Claves que se guardan en el servidor. Las preferencias de pantalla se quedan en cada navegador. */
export const SYNCED_KEYS = ['azlab:cloud:v1', 'azlab:academy:v1'];

/** «Este navegador tiene un cambio que el servidor aún no ha recibido». */
const pendingMark = (key: string) => `azlab:pending:${key}`;
/** Revisión del servidor de la que parte la copia de este navegador. */
const baseMark = (key: string) => `azlab:base:${key}`;
const RETRY_MS = 5000;
const KEEPALIVE_MAX = 32 * 1024;

let remote = false;
const values = new Map<string, string>();
const queue = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let warned = false;

function local(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function setLocal(key: string, value: string | null) {
  try {
    if (value === null) local()?.removeItem(key);
    else local()?.setItem(key, value);
  } catch {
    /* sin sitio en el navegador: con servidor basta la copia en memoria */
  }
}

/** ¿Hay dónde guardar? (navegador o servidor). */
export function canPersist(): boolean {
  return remote || local() !== null;
}

/** ¿Los datos se guardan en el servidor del contenedor? */
export function isRemote(): boolean {
  return remote;
}

/**
 * Se llama una vez, antes de cargar la app. Si responde el servidor del contenedor, sus datos mandan.
 * Excepción: un cambio de este navegador que no llegó a subir (cerraste la pestaña a mitad) se recupera,
 * pero sólo si nadie ha guardado otra cosa desde entonces; si no, gana lo que ya está en el servidor.
 * Sin servidor (npm run dev, vite preview) no hace nada y todo sigue en el navegador.
 */
export async function hydrate(): Promise<void> {
  let body: any;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('api/state', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    // El servidor de desarrollo de Vite responde index.html a cualquier ruta: sólo vale un JSON nuestro.
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) return;
    body = await r.json();
  } catch {
    return;
  }
  if (body?.server !== 'azure-lab') return;
  remote = true;
  const ls = local();
  for (const key of SYNCED_KEYS) {
    const mine = ls?.getItem(key) ?? null;
    const theirs = typeof body.keys?.[key] === 'string' ? (body.keys[key] as string) : null;
    const rev: string | null = body.revs?.[key] ?? null;
    const unsent = mine !== null && !!ls?.getItem(pendingMark(key)) && ls?.getItem(baseMark(key)) === rev;
    if (mine !== null && (unsent || theirs === null)) {
      // Cambio local sin subir, o primera vez con servidor: sube lo de este navegador.
      values.set(key, mine);
      queue.set(key, mine);
    } else if (theirs !== null) {
      values.set(key, theirs);
      setLocal(key, theirs);
      setLocal(baseMark(key), rev);
      setLocal(pendingMark(key), null);
    }
  }
  if (queue.size) schedule(0);
}

export function readKey(key: string): string | null {
  if (values.has(key)) return values.get(key)!;
  try {
    return local()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Guarda en el navegador y, con servidor, programa la subida (agrupa los cambios seguidos). */
export function writeKey(key: string, value: string) {
  if (!remote || !SYNCED_KEYS.includes(key)) {
    local()?.setItem(key, value);
    return;
  }
  // Con servidor el límite del navegador (~5 MB) no importa: la copia buena está en el volumen.
  values.set(key, value);
  setLocal(key, value);
  setLocal(pendingMark(key), '1');
  queue.set(key, value);
  schedule(300);
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushRemote(), ms);
}

/** Sube ya lo pendiente. Espérala antes de recargar la página (importar, restablecer...). */
export async function flushRemote(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  while (inflight) await inflight;
  if (!remote || !queue.size) return;
  const batch = [...queue];
  queue.clear();
  inflight = (async () => {
    for (const [key, value] of batch) {
      try {
        const r = await fetch(`api/state/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: value,
          // keepalive deja terminar la petición aunque cierres la pestaña, pero sólo admite cuerpos pequeños.
          keepalive: value.length < KEEPALIVE_MAX,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { rev } = await r.json();
        warned = false;
        if (!queue.has(key)) {
          setLocal(baseMark(key), rev);
          setLocal(pendingMark(key), null);
        }
      } catch (e) {
        if (!warned) console.warn('No se pudo guardar en el servidor de Azure Lab; se reintentará', e);
        warned = true;
        if (!queue.has(key)) queue.set(key, value);
      }
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
  if (queue.size) schedule(RETRY_MS);
}
