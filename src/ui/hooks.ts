// Hooks de React: suscripción a la nube simulada y enrutado por hash.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState, getVersion, subscribe } from '../engine/store';
import type { CloudState } from '../engine/types';

export function useCloud(): CloudState {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getState();
}

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
  const [path, qs = ''] = raw.split('?');
  const clean = path || '/';
  return { path: clean, parts: clean.split('/').filter(Boolean).map((p) => decodeURIComponent(p)), query: new URLSearchParams(qs) };
}

let current = parseHash();
const routeListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parseHash();
    for (const l of [...routeListeners]) l();
  });
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      routeListeners.add(l);
      return () => routeListeners.delete(l);
    },
    () => current,
    () => current,
  );
}

/** Sólo para pruebas: fija la ruta actual sin pasar por location.hash. */
export function setRouteForTests(hash: string) {
  const [path, qs = ''] = hash.replace(/^#/, '').split('?');
  const clean = path || '/';
  current = { path: clean, parts: clean.split('/').filter(Boolean).map((p) => decodeURIComponent(p)), query: new URLSearchParams(qs) };
  for (const l of [...routeListeners]) l();
}

export function navigate(path: string) {
  const target = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : '/' + path}`;
  if (location.hash === target) return;
  location.hash = target;
}

/** Ruta del blade de un recurso (el id se codifica en un solo segmento). */
export function resourceHref(id: string, section?: string) {
  return `#/resource/${encodeURIComponent(id)}${section ? `/${section}` : ''}`;
}

export function rgHref(subscriptionId: string, name: string, section?: string) {
  return resourceHref(`/subscriptions/${subscriptionId}/resourceGroups/${name}`, section);
}

/** Fuerza un re-render periódico (para tiempos relativos y estados que avanzan con el reloj). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* nada */
      }
    },
  ];
}
