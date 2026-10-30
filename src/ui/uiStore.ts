// Estado de la interfaz (no forma parte de la nube simulada): paneles abiertos, avisos, preferencias locales.
import { useSyncExternalStore, type ReactNode } from 'react';

export interface Toast {
  id: number;
  title: string;
  message?: string;
  level: 'info' | 'success' | 'error' | 'warning';
}

export interface ContextPane {
  title: string;
  subtitle?: string;
  render: () => ReactNode;
  width?: number;
}

export interface UiState {
  shellOpen: boolean;
  shellHeight: number;
  shellMax: boolean;
  editor: { path: string } | null;
  browser: { url: string; history: string[] } | null;
  toasts: Toast[];
  pane: ContextPane | null;
  notificationsOpen: boolean;
  settingsOpen: boolean;
  accountOpen: boolean;
  navCollapsed: boolean;
  labCollapsed: boolean;
  fontSize: number;
}

const PREFS_KEY = 'azlab:ui:v1';

function loadPrefs(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const prefs = typeof localStorage !== 'undefined' ? loadPrefs() : {};

let ui: UiState = {
  shellOpen: false,
  shellHeight: prefs.shellHeight ?? 340,
  shellMax: false,
  editor: null,
  browser: null,
  toasts: [],
  pane: null,
  notificationsOpen: false,
  settingsOpen: false,
  accountOpen: false,
  navCollapsed: prefs.navCollapsed ?? false,
  labCollapsed: prefs.labCollapsed ?? false,
  fontSize: prefs.fontSize ?? 14,
};

let ver = 0;
const listeners = new Set<() => void>();

export function getUi() {
  return ui;
}

export function setUi(patch: Partial<UiState> | ((u: UiState) => Partial<UiState>)) {
  const p = typeof patch === 'function' ? patch(ui) : patch;
  ui = { ...ui, ...p };
  ver++;
  if ('shellHeight' in p || 'navCollapsed' in p || 'labCollapsed' in p || 'fontSize' in p) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ shellHeight: ui.shellHeight, navCollapsed: ui.navCollapsed, labCollapsed: ui.labCollapsed, fontSize: ui.fontSize }));
    } catch {
      /* sin almacenamiento */
    }
  }
  for (const l of [...listeners]) l();
}

export function useUi(): UiState {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ver,
    () => ver,
  );
  return ui;
}

let toastId = 0;

export function toast(title: string, level: Toast['level'] = 'info', message?: string) {
  const t: Toast = { id: ++toastId, title, message, level };
  setUi((u) => ({ toasts: [...u.toasts.slice(-3), t] }));
  setTimeout(() => setUi((u) => ({ toasts: u.toasts.filter((x) => x.id !== t.id) })), level === 'error' ? 9000 : 5000);
}

export function openPane(p: ContextPane) {
  setUi({ pane: p, notificationsOpen: false, settingsOpen: false, accountOpen: false });
}

export function closePane() {
  setUi({ pane: null });
}

export function openShell() {
  setUi({ shellOpen: true });
}
