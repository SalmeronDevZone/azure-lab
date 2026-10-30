// Utilidades comunes del motor de simulación.

export function guid(): string {
  if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
    return (crypto as any).randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Equivalente determinista a uniqueString() de ARM: 13 caracteres en minúscula. */
export function uniqueString(...parts: string[]): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const seed = parts.join('|').toLowerCase();
  let out = '';
  for (let i = 0; i < 13; i++) out += alphabet[fnv1a(seed + ':' + i) & 31];
  return out;
}

export function shortHash(str: string, len = 8): string {
  let out = '';
  let i = 0;
  while (out.length < len) out += fnv1a(str + ':' + i++).toString(16).padStart(8, '0');
  return out.slice(0, len);
}

/** PRNG determinista (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const nowIso = () => new Date().toISOString();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

export function deepClone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export function sortKeysDeep(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const k of Object.keys(v).sort((a, b) => a.localeCompare(b))) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

export function ciEq(a?: string | null, b?: string | null): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

export function closest(word: string, options: string[], maxDist = 3): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(word.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= maxDist ? best : undefined;
}

// ---------- IPs y CIDR ----------

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isValidIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

export interface Cidr {
  base: number;
  bits: number;
  size: number;
}

export function parseCidr(c: string): Cidr | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec((c ?? '').trim());
  if (!m) return null;
  const octs = m.slice(1, 5).map(Number);
  if (octs.some((o) => o > 255)) return null;
  const bits = Number(m[5]);
  if (bits > 32) return null;
  const ip = ipToInt(octs.join('.'));
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits, size: 2 ** (32 - bits) };
}

export function cidrContains(outer: string, inner: string): boolean {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (!o || !i) return false;
  return i.base >= o.base && i.base + i.size <= o.base + o.size;
}

export function cidrOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y) return false;
  return x.base < y.base + y.size && y.base < x.base + x.size;
}

export function cidrContainsIp(c: string, ip: string): boolean {
  const x = parseCidr(c);
  if (!x || !isValidIp(ip)) return false;
  const n = ipToInt(ip);
  return n >= x.base && n < x.base + x.size;
}

export function randomPublicIp(seed: string): string {
  const r = seededRandom(fnv1a(seed));
  const firsts = [20, 4, 13, 40, 51, 52, 98, 108, 172];
  const a = firsts[Math.floor(r() * firsts.length)];
  return `${a}.${1 + Math.floor(r() * 250)}.${1 + Math.floor(r() * 250)}.${1 + Math.floor(r() * 250)}`;
}

export function macFromSeed(seed: string): string {
  const h = shortHash(seed, 6).toUpperCase();
  return `00-0D-3A-${h.slice(0, 2)}-${h.slice(2, 4)}-${h.slice(4, 6)}`;
}

export function fakeKey(seed: string, len = 88): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const r = seededRandom(fnv1a(seed));
  let out = '';
  for (let i = 0; i < len - 2; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out + '==';
}

export function fakePassword(seed: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789~._-';
  const r = seededRandom(fnv1a(seed));
  let out = '';
  for (let i = 0; i < 40; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}

export function slugify(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 20) || 'usuario'
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
}

export function relTime(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'hace unos segundos';
  if (d < 3600) return `hace ${Math.floor(d / 60)} min`;
  if (d < 86400) return `hace ${Math.floor(d / 3600)} h`;
  return `hace ${Math.floor(d / 86400)} días`;
}

/** Hace match de un patrón con comodines * (case-insensitive). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$', 'i');
  return re.test(value);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseIsoDuration(d: string): number {
  // PT5M, PT1H, P1D -> minutos
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(d || '');
  if (!m) return 5;
  return (Number(m[1] || 0) * 1440) + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 60;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
