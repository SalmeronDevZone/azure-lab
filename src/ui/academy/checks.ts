// Contexto de validación de los ejercicios: consultas sobre la nube simulada, los comandos ejecutados,
// los ficheros de Cloud Shell y Azure DevOps.
import type { CloudState, CommandLogEntry, DevOpsProject, Resource, ResourceGroup } from '../../engine/types';
import { getState, homeDir } from '../../engine/store';
import { httpGet, type FetchResult } from '../../engine/services/net';
import { VFS } from '../../shell/fs';
import { listRoleAssignments } from '../../engine/services/identity';
import { vmPowerState } from '../../engine/providers/compute';
import { kubeOf } from '../../engine/services/kube';

export class CheckCtx {
  s: CloudState;
  since: number;
  private fsCache: VFS | null = null;

  constructor(since: number, s: CloudState = getState()) {
    this.s = s;
    this.since = since;
  }

  get sub() {
    return this.s.currentSubscriptionId;
  }

  get me() {
    return this.s.me;
  }

  // ---------------------------------------------------------------- comandos

  /** Comandos registrados (shell, portal, pipelines, VM) desde que empezó el ejercicio. */
  cmds(source?: CommandLogEntry['source'] | CommandLogEntry['source'][]): CommandLogEntry[] {
    const src = source ? (Array.isArray(source) ? source : [source]) : null;
    return this.s.cli.commandLog.filter((c) => c.ts >= this.since && (!src || src.includes(c.source)));
  }

  /**
   * ¿Se ejecutó correctamente en Cloud Shell un comando que cumple el patrón? Se comprueban tanto los comandos
   * individuales como la línea completa tecleada (tuberías, VAR=$(...), scripts...).
   */
  ran(re: RegExp, opts: { source?: CommandLogEntry['source'] | CommandLogEntry['source'][]; ok?: boolean } = {}): boolean {
    return this.cmds(opts.source ?? ['shell', 'typed']).some((c) => re.test(c.cmd) && (opts.ok === false || c.ok));
  }

  /** ¿Se ejecutó (aunque fallara) un comando que cumple el patrón? */
  tried(re: RegExp): boolean {
    return this.cmds(['shell', 'typed', 'vm']).some((c) => re.test(c.cmd));
  }

  /** ¿Falló un comando que cumple el patrón? */
  failed(re: RegExp): boolean {
    return this.cmds(['shell', 'typed']).some((c) => re.test(c.cmd) && !c.ok);
  }

  ranAny(re: RegExp): boolean {
    return this.cmds(['shell', 'vm', 'typed']).some((c) => re.test(c.cmd));
  }

  // ---------------------------------------------------------------- recursos

  rg(name: string | RegExp): ResourceGroup | undefined {
    return this.s.resourceGroups.find((g) => (typeof name === 'string' ? g.name.toLowerCase() === name.toLowerCase() : name.test(g.name)) && g.provisioningState !== 'Deleting');
  }

  rgs(): ResourceGroup[] {
    return this.s.resourceGroups;
  }

  res(type: string, pred: (r: Resource) => boolean = () => true): Resource[] {
    return this.s.resources.filter((r) => r.type.toLowerCase() === type.toLowerCase() && r.properties.provisioningState !== 'Creating' && pred(r));
  }

  one(type: string, pred?: (r: Resource) => boolean): Resource | undefined {
    return this.res(type, pred)[0];
  }

  inRg(rg: string) {
    return (r: Resource) => r.resourceGroup.toLowerCase() === rg.toLowerCase();
  }

  vm(rg: string, name?: string) {
    return this.one('Microsoft.Compute/virtualMachines', (r) => this.inRg(rg)(r) && (!name || r.name.toLowerCase() === name.toLowerCase()));
  }

  powerState(vm: Resource) {
    return vmPowerState(vm);
  }

  site(rg: string, name?: string) {
    return this.one('Microsoft.Web/sites', (r) => this.inRg(rg)(r) && (!name || r.name.toLowerCase() === name.toLowerCase()));
  }

  storage(rg: string) {
    return this.one('Microsoft.Storage/storageAccounts', this.inRg(rg));
  }

  /** Asignaciones de rol de un principal (objectId, UPN, appId o nombre), opcionalmente filtrando rol/ámbito. */
  hasRole(assignee: string, role: string, scopeContains?: string): boolean {
    return listRoleAssignments({ assignee, all: true }, this.s).some((a) => a.roleDefinitionName.toLowerCase() === role.toLowerCase() && (!scopeContains || a.scope.toLowerCase().includes(scopeContains.toLowerCase())));
  }

  roleAssignments(pred: (a: CloudState['roleAssignments'][number]) => boolean) {
    return this.s.roleAssignments.filter(pred);
  }

  kube(cluster: Resource) {
    return kubeOf(cluster);
  }

  // ---------------------------------------------------------------- red y HTTP

  http(url: string): FetchResult {
    try {
      return httpGet(url);
    } catch {
      return { ok: false, error: 'error' };
    }
  }

  httpOk(url: string, contains?: string | RegExp): boolean {
    const r = this.http(url);
    if (!r.ok || !r.status || r.status >= 400) return false;
    if (!contains) return true;
    return typeof contains === 'string' ? (r.body ?? '').includes(contains) : contains.test(r.body ?? '');
  }

  // ---------------------------------------------------------------- ficheros de Cloud Shell

  get home() {
    return homeDir(this.s);
  }

  private fs(): VFS {
    if (!this.fsCache) this.fsCache = new VFS(this.s.fs);
    return this.fsCache;
  }

  file(path: string): string | null {
    const abs = path.startsWith('/') ? path : `${this.home}/${path.replace(/^~\//, '')}`;
    try {
      return this.fs().isFile(abs) ? this.fs().readFile(abs) : null;
    } catch {
      return null;
    }
  }

  dir(path: string): boolean {
    const abs = path.startsWith('/') ? path : `${this.home}/${path.replace(/^~\//, '')}`;
    return this.fs().isDir(abs);
  }

  // ---------------------------------------------------------------- Azure DevOps

  project(name?: string): DevOpsProject | undefined {
    return this.s.devops.projects.find((p) => !name || p.name.toLowerCase() === name.toLowerCase());
  }

  projects(): DevOpsProject[] {
    return this.s.devops.projects;
  }
}
