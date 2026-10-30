// Store central de la nube simulada: estado mutable + notificación a suscriptores + persistencia (persistence.ts).
import type { CloudState, PrincipalRef, Settings } from './types';
import { guid, slugify, nowIso } from './util';
import { SAMPLE_FILES, buildFsFromMap, addMissingFiles, LATER_SAMPLE_FILES } from './seedFiles';
import { canPersist, readKey, writeKey } from './persistence';

const STORAGE_KEY = 'azlab:cloud:v1';
export const SCHEMA_VERSION = 1;

export function homeDir(s: { me: { upn: string } }): string {
  return `/home/${s.me.upn.split('@')[0]}`;
}

export function createInitialState(displayName = 'Estudiante', prev?: Partial<Settings>): CloudState {
  const slug = slugify(displayName);
  const tenantId = guid();
  const domain = `${slug}lab.onmicrosoft.com`;
  const upn = `${slug}@${domain}`;
  const meId = guid();
  const subDev = guid();
  const subProd = guid();
  const home = `/home/${slug}`;
  const s: CloudState = {
    schema: SCHEMA_VERSION,
    createdAt: nowIso(),
    settings: {
      speed: prev?.speed ?? 'fast',
      theme: prev?.theme ?? 'light',
      freeMode: prev?.freeMode ?? false,
      userDisplayName: displayName,
      onboarded: prev?.onboarded ?? false,
    },
    tenant: { id: tenantId, domain, displayName: `Directorio de ${displayName}` },
    me: { objectId: meId, upn, displayName },
    subscriptions: [
      { id: subDev, displayName: 'Azure Lab - Desarrollo', state: 'Enabled', tenantId, offer: 'Pago por uso (simulado)' },
      { id: subProd, displayName: 'Azure Lab - Producción', state: 'Enabled', tenantId, offer: 'Pago por uso (simulado)' },
    ],
    currentSubscriptionId: subDev,
    resourceGroups: [],
    resources: [],
    activityLog: [],
    users: [
      {
        id: meId,
        displayName,
        userPrincipalName: upn,
        mail: null,
        password: 'P@ssw0rd-no-usada',
        accountEnabled: true,
        jobTitle: 'Ingeniero/a Cloud en formación',
        department: 'Plataforma',
        userType: 'Member',
        createdAt: nowIso(),
      },
    ],
    groups: [],
    apps: [],
    servicePrincipals: [],
    roleAssignments: [subDev, subProd].map((sub) => ({
      id: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleAssignments/${guid()}`,
      name: guid(),
      principalId: meId,
      principalType: 'User' as const,
      principalName: upn,
      roleDefinitionId: `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635`,
      roleDefinitionName: 'Owner',
      scope: `/subscriptions/${sub}`,
      createdOn: nowIso(),
      createdBy: 'Sistema',
    })),
    customRoles: [],
    locks: [],
    policyAssignments: [],
    deployments: [],
    deletedVaults: [],
    diagnosticSettings: [],
    budgets: [],
    notifications: [],
    alerts: [],
    emails: [],
    events: [],
    costs: {},
    costClock: Date.now(),
    cli: {
      loggedIn: true,
      principal: { type: 'User', objectId: meId, name: upn, displayName },
      defaults: {},
      history: [],
      commandLog: [],
      env: {},
      cwd: home,
      kubeContext: null,
      acrLogins: [],
      dockerLogins: [],
      knownHosts: [],
    },
    fs: buildFsFromMap(SAMPLE_FILES, home),
    docker: { images: [], containers: [] },
    gitLocal: {},
    devops: { organization: `${slug}-org`, projects: [], runCounter: 0, prCounter: 0, workItemCounter: 0 },
    recent: [],
  };
  return s;
}

function normalizeAfterLoad(s: CloudState) {
  // Las operaciones asíncronas no sobreviven a una recarga: se completan inmediatamente.
  for (const r of s.resources) {
    const ps = r.properties?.provisioningState;
    if (ps === 'Creating' || ps === 'Updating' || ps === 'Accepted') r.properties.provisioningState = 'Succeeded';
  }
  s.resources = s.resources.filter((r) => r.properties?.provisioningState !== 'Deleting');
  s.resourceGroups = s.resourceGroups.filter((g) => g.provisioningState !== 'Deleting');
  for (const d of s.deployments) if (d.provisioningState === 'Running' || d.provisioningState === 'Accepted') d.provisioningState = 'Succeeded';
  for (const p of s.devops.projects) {
    for (const run of p.runs) {
      if (run.status === 'running' || run.status === 'queued') {
        run.status = 'canceled';
        run.error = 'La ejecución se interrumpió al recargar el simulador.';
      }
    }
  }
  // Ejemplos añadidos en versiones posteriores (.gitignore, package-lock.json...).
  addMissingFiles(s.fs, homeDir(s), SAMPLE_FILES, LATER_SAMPLE_FILES);
}

function load(): CloudState | null {
  if (!canPersist()) return null;
  try {
    const raw = readKey(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CloudState;
    if (s.schema !== SCHEMA_VERSION) return null;
    normalizeAfterLoad(s);
    return s;
  } catch {
    return null;
  }
}

let state: CloudState = load() ?? createInitialState();
let version = 0;
const listeners = new Set<() => void>();
let notifyPending = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function getState(): CloudState {
  return state;
}

export function getVersion(): number {
  return version;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function save() {
  if (!canPersist()) return;
  try {
    // Recortar históricos para no crecer sin límite.
    if (state.events.length > 4000) state.events = state.events.slice(-3000);
    if (state.activityLog.length > 1500) state.activityLog = state.activityLog.slice(-1200);
    if (state.cli.commandLog.length > 800) state.cli.commandLog = state.cli.commandLog.slice(-600);
    if (state.cli.history.length > 500) state.cli.history = state.cli.history.slice(-400);
    if (state.notifications.length > 100) state.notifications = state.notifications.slice(0, 100);
    writeKey(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('No se pudo guardar el estado del simulador', e);
  }
}

export function flushSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  save();
}

/** Señala que el estado ha cambiado (agrupa notificaciones en un microtask). */
export function changed() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  if (notifyPending) return;
  notifyPending = true;
  queueMicrotask(() => {
    notifyPending = false;
    version++;
    for (const l of [...listeners]) l();
  });
}

export function mutate<T>(fn: (s: CloudState) => T): T {
  const r = fn(state);
  changed();
  return r;
}

export function replaceState(s: CloudState) {
  state = s;
  changed();
}

export function resetCloud() {
  const prev = state.settings;
  state = createInitialState(prev.userDisplayName, prev);
  flushSave();
  changed();
  bus.emit('cloud:reset', null);
}

export function renameUser(displayName: string) {
  const prev = state.settings;
  state = createInitialState(displayName, { ...prev, onboarded: true });
  flushSave();
  changed();
  bus.emit('cloud:reset', null);
}

export function speedFactor(): number {
  switch (state.settings.speed) {
    case 'instant':
      return 0;
    case 'realistic':
      return 2.5;
    default:
      return 1;
  }
}

export function portalPrincipal(): PrincipalRef {
  return { type: 'User', objectId: state.me.objectId, name: state.me.upn, displayName: state.me.displayName };
}

// ---------------- Bus de eventos de UI ----------------

type Handler = (payload: any) => void;
const handlers = new Map<string, Set<Handler>>();

export const bus = {
  on(evt: string, h: Handler) {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt)!.add(h);
    return () => {
      handlers.get(evt)?.delete(h);
    };
  },
  emit(evt: string, payload: any) {
    handlers.get(evt)?.forEach((h) => {
      try {
        h(payload);
      } catch (e) {
        console.error(e);
      }
    });
  },
};
