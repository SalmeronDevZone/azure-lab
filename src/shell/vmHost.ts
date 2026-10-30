// Punto de enlace tardío para ejecutar scripts dentro del SO invitado de una VM (evita dependencias circulares).
import type { Resource } from '../engine/types';

export interface GuestRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Runner = (vm: Resource, script: string, asRoot: boolean) => Promise<GuestRunResult>;

let runner: Runner | null = null;

export function setGuestRunner(r: Runner) {
  runner = r;
}

export async function runInGuest(vm: Resource, script: string, asRoot = true): Promise<GuestRunResult> {
  if (!runner) return { stdout: '', stderr: 'guest runner not initialized', code: 1 };
  return runner(vm, script, asRoot);
}

// Fábrica de sesiones interactivas en la VM (ssh).
export interface VmSessionRequest {
  vm: Resource;
  user: string;
  asRoot: boolean;
}

type SessionFactory = (req: VmSessionRequest, parent: any) => any;
let sessionFactory: SessionFactory | null = null;

export function setVmSessionFactory(f: SessionFactory) {
  sessionFactory = f;
}

export function createVmSession(req: VmSessionRequest, parent: any): any {
  if (!sessionFactory) throw new Error('VM session factory not initialized');
  return sessionFactory(req, parent);
}
