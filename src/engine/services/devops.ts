// Azure DevOps simulado: proyectos, Azure Repos, pull requests, pipelines, entornos y conexiones de servicio.
import { load } from 'js-yaml';
import type { DevOpsEnvironment, DevOpsProject, DevOpsRepo, GitCommit, Pipeline, PipelineRun, PrincipalRef, PullRequest, ServiceConnection, WorkItem } from '../types';
import { getState, changed, bus } from '../store';
import { ArmError } from '../errors';
import { ciEq, guid, nowIso, shortHash } from '../util';
import { createSpForRbac, createRoleAssignment, findSp } from './identity';
import { findResource, notify } from '../arm';
import { SAMPLE_FILES } from '../seedFiles';

export const DEVOPS_HOST = 'dev.azure.com';

export function org() {
  return getState().devops.organization;
}

export function orgUrl() {
  return `https://${DEVOPS_HOST}/${org()}`;
}

export function repoUrl(project: DevOpsProject, repo: DevOpsRepo) {
  return `https://${org()}@${DEVOPS_HOST}/${org()}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repo.name)}`;
}

export function findProject(nameOrId: string): DevOpsProject | undefined {
  return getState().devops.projects.find((p) => ciEq(p.name, nameOrId) || p.id === nameOrId);
}

export function getProject(nameOrId: string | undefined): DevOpsProject {
  if (!nameOrId) throw new ArmError('DevOpsError', 'TF400813: Project name is required. Usa --project o az devops configure --defaults project=<nombre>.', 400);
  const p = findProject(nameOrId);
  if (!p) throw new ArmError('DevOpsError', `TF200016: The following project does not exist: ${nameOrId}. Verify that the name of the project is correct and that the project exists on the specified Azure DevOps Server.`, 404);
  return p;
}

export function findRepo(project: DevOpsProject, nameOrId: string): DevOpsRepo | undefined {
  return project.repos.find((r) => ciEq(r.name, nameOrId) || r.id === nameOrId);
}

export function getRepo(project: DevOpsProject, nameOrId: string): DevOpsRepo {
  const r = findRepo(project, nameOrId);
  if (!r) throw new ArmError('DevOpsError', `TF401019: The Git repository with name or identifier ${nameOrId} does not exist or you do not have permissions for the operation you are attempting.`, 404);
  return r;
}

/** Interpreta una URL de Azure Repos. */
export function parseRepoUrl(url: string): { project: DevOpsProject; repo: DevOpsRepo } | null {
  const m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(url) ?? /([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  if (!ciEq(decodeURIComponent(m[1]), org())) return null;
  const project = findProject(decodeURIComponent(m[2]));
  if (!project) return null;
  const repo = findRepo(project, decodeURIComponent(m[3]).replace(/\.git$/, ''));
  if (!repo) return null;
  return { project, repo };
}

// ---------------------------------------------------------------- proyectos y repos

export function createProject(name: string, description = '', by: string): DevOpsProject {
  const s = getState();
  if (!/^[^\\/:*?"<>|;#$+,{}%&\t]{1,64}$/.test(name) || name.startsWith('_') || name.endsWith('.')) throw new ArmError('DevOpsError', `VS402932: The project name '${name}' contains invalid characters.`, 400);
  if (findProject(name)) throw new ArmError('DevOpsError', `TF200019: The following project already exists on the Azure DevOps Server: ${name}.`, 409);
  const p: DevOpsProject = {
    id: guid(),
    name,
    description,
    createdAt: nowIso(),
    repos: [{ id: guid(), name, defaultBranch: 'main', branches: {}, commits: {}, policies: null }],
    pipelines: [],
    runs: [],
    serviceConnections: [],
    environments: [],
    variableGroups: [],
    pullRequests: [],
    workItems: [],
  };
  s.devops.projects.push(p);
  changed();
  void by;
  return p;
}

export function deleteProject(nameOrId: string) {
  const s = getState();
  const p = getProject(nameOrId);
  s.devops.projects = s.devops.projects.filter((x) => x !== p);
  changed();
}

export function createRepo(project: DevOpsProject, name: string): DevOpsRepo {
  if (findRepo(project, name)) throw new ArmError('DevOpsError', `TF400948: A Git repository with the name ${name} already exists.`, 409);
  const r: DevOpsRepo = { id: guid(), name, defaultBranch: 'main', branches: {}, commits: {}, policies: null };
  project.repos.push(r);
  changed();
  return r;
}

export function commitId(seed: string): string {
  return shortHash(seed + Math.random() + Date.now(), 40);
}

export function makeCommit(repo: DevOpsRepo, tree: Record<string, string>, message: string, author: string, parents: string[]): GitCommit {
  const c: GitCommit = { id: commitId(message + author), message, author, date: nowIso(), parents, tree: { ...tree } };
  repo.commits[c.id] = c;
  return c;
}

export const TEMPLATES: Record<string, { label: string; files: Record<string, string> }> = {
  'app-node': { label: 'App Node.js + Dockerfile + pipeline', files: prefixed('samples/app-node/') },
  'web-estatica': { label: 'Web estática HTML', files: prefixed('samples/web-estatica/') },
  'iac-bicep': { label: 'Infraestructura como código (Bicep)', files: prefixed('samples/bicep/') },
  'iac-terraform': { label: 'Infraestructura como código (Terraform)', files: prefixed('samples/terraform/') },
};

function prefixed(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(SAMPLE_FILES)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

export function importTemplate(project: DevOpsProject, repo: DevOpsRepo, templateOrUrl: string, by: string) {
  if (Object.keys(repo.branches).length) throw new ArmError('DevOpsError', 'TF400826: Import is only supported into an empty repository.', 409);
  const key = Object.keys(TEMPLATES).find((k) => templateOrUrl.toLowerCase().includes(k)) ?? null;
  if (!key) throw new ArmError('DevOpsError', `Repositorio de origen no encontrado: ${templateOrUrl}. En el simulador puedes importar: ${Object.keys(TEMPLATES).map((k) => `https://github.com/azure-lab/${k}`).join(', ')}`, 404);
  const c = makeCommit(repo, TEMPLATES[key].files, `Importado desde ${templateOrUrl}`, by, []);
  repo.branches.main = c.id;
  changed();
  void project;
  return c;
}

export function isAncestor(repo: DevOpsRepo, ancestor: string, descendant: string, extraCommits: Record<string, GitCommit> = {}): boolean {
  const all = { ...repo.commits, ...extraCommits };
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of all[id]?.parents ?? []) stack.push(p);
  }
  return false;
}

export interface PushResult {
  ok: boolean;
  message: string;
  triggered: PipelineRun[];
}

/** ¿La rama tiene directivas que obligan a usar pull requests? */
export function branchProtected(repo: DevOpsRepo, branch: string): boolean {
  const pol = repo.policies;
  return !!pol && branch === repo.defaultBranch && (pol.minReviewers > 0 || !!pol.buildValidationPipelineId || !!pol.requireLinkedWorkItem);
}

// ---------------------------------------------------------------- elementos de trabajo vinculados

/** Ids de elementos de trabajo mencionados como #12 o AB#12 (sólo los que existen en el proyecto). */
export function mentionedWorkItems(project: DevOpsProject, text: string): number[] {
  const ids = new Set<number>();
  for (const m of text.matchAll(/(?:^|[^\w&/])(?:AB)?#(\d+)\b/g)) {
    const id = Number(m[1]);
    if (project.workItems.some((w) => w.id === id)) ids.add(id);
  }
  return [...ids];
}

function addLink(wi: WorkItem, link: NonNullable<WorkItem['links']>[number]) {
  wi.links = [...(wi.links ?? []).filter((l) => !(l.kind === link.kind && l.id === link.id)), link];
}

/** Vincula commits que mencionan elementos de trabajo (#12) al subirlos, como Azure Repos. */
function linkCommits(project: DevOpsProject, repo: DevOpsRepo, commits: GitCommit[]) {
  for (const c of commits) {
    for (const id of mentionedWorkItems(project, c.message)) {
      addLink(project.workItems.find((w) => w.id === id)!, { kind: 'commit', id: c.id, title: c.message.split('\n')[0], repo: repo.name });
    }
  }
}

/** Vincula elementos de trabajo a una pull request. */
export function linkWorkItems(project: DevOpsProject, pr: PullRequest, ids: number[]) {
  const repo = project.repos.find((r) => r.id === pr.repoId);
  for (const id of ids) {
    const wi = project.workItems.find((w) => w.id === Number(id));
    if (!wi) throw new ArmError('DevOpsError', `TF401232: Work item ${id} does not exist, or you do not have permissions to read it.`, 404);
    pr.workItems = [...new Set([...(pr.workItems ?? []), wi.id])];
    addLink(wi, { kind: 'pr', id: String(pr.id), title: pr.title, repo: repo?.name });
  }
  changed();
}

export function unlinkWorkItem(project: DevOpsProject, pr: PullRequest, id: number) {
  pr.workItems = (pr.workItems ?? []).filter((x) => x !== id);
  const wi = project.workItems.find((w) => w.id === id);
  if (wi) wi.links = (wi.links ?? []).filter((l) => !(l.kind === 'pr' && l.id === String(pr.id)));
  changed();
}

/** Commits de una rama que todavía no están en otra (lo que aporta una pull request). */
export function commitsAhead(repo: DevOpsRepo, source: string, target: string): GitCommit[] {
  const tgt = repo.branches[target];
  const out: GitCommit[] = [];
  const seen = new Set<string>();
  const queue = [repo.branches[source]];
  while (queue.length && out.length < 200) {
    const id = queue.shift()!;
    if (!id || seen.has(id) || (tgt && isAncestor(repo, id, tgt))) continue;
    seen.add(id);
    const c = repo.commits[id];
    if (!c) continue;
    out.push(c);
    queue.push(...c.parents);
  }
  return out;
}

/** Recibe un push (git push) sobre una rama. */
export function receivePush(project: DevOpsProject, repo: DevOpsRepo, branch: string, commits: Record<string, GitCommit>, head: string, force: boolean, by: string): PushResult {
  const cur = repo.branches[branch];
  if (cur === head) return { ok: true, message: 'Everything up-to-date', triggered: [] };
  if (branchProtected(repo, branch)) {
    return { ok: false, message: `! [remote rejected] ${branch} -> ${branch} (TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.)`, triggered: [] };
  }
  if (cur && !force && !isAncestor(repo, cur, head, commits)) {
    return { ok: false, message: `! [rejected]        ${branch} -> ${branch} (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.`, triggered: [] };
  }
  const fresh = Object.values(commits).filter((c) => !repo.commits[c.id]);
  Object.assign(repo.commits, commits);
  repo.branches[branch] = head;
  linkCommits(project, repo, fresh);
  changed();
  const triggered = triggerCi(project, repo, branch, head, by, cur);
  return { ok: true, message: cur ? `   ${cur.slice(0, 7)}..${head.slice(0, 7)}  ${branch} -> ${branch}` : ` * [new branch]      ${branch} -> ${branch}`, triggered };
}

export function filesAt(repo: DevOpsRepo, ref: string): Record<string, string> {
  const id = repo.branches[ref] ?? ref;
  return repo.commits[id]?.tree ?? {};
}

export function commitFile(project: DevOpsProject, repo: DevOpsRepo, branch: string, path: string, content: string | null, message: string, by: string): GitCommit {
  if (branchProtected(repo, branch)) {
    throw new ArmError('DevOpsError', 'TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.', 403);
  }
  const head = repo.branches[branch];
  const tree = { ...(head ? repo.commits[head].tree : {}) };
  if (content === null) delete tree[path];
  else tree[path] = content;
  const c = makeCommit(repo, tree, message, by, head ? [head] : []);
  repo.branches[branch] = c.id;
  linkCommits(project, repo, [c]);
  changed();
  triggerCi(project, repo, branch, c.id, by, head);
  return c;
}

export function createBranch(repo: DevOpsRepo, name: string, from: string) {
  if (repo.branches[name]) throw new ArmError('DevOpsError', `TF401028: The reference 'refs/heads/${name}' has already been updated by another client, so you cannot update it.`, 409);
  const id = repo.branches[from] ?? from;
  if (!repo.commits[id]) throw new ArmError('DevOpsError', `Branch or commit '${from}' not found.`, 404);
  repo.branches[name] = id;
  changed();
}

// ---------------------------------------------------------------- pipelines

export interface ParsedTrigger {
  branches: string[];
  exclude: string[];
  paths: string[];
  none: boolean;
}

export function parseTrigger(yamlText: string): ParsedTrigger {
  let doc: any;
  try {
    doc = load(yamlText) ?? {};
  } catch {
    return { branches: [], exclude: [], paths: [], none: true };
  }
  const t = doc.trigger;
  if (t === undefined) return { branches: ['*'], exclude: [], paths: [], none: false };
  if (t === 'none' || t === false) return { branches: [], exclude: [], paths: [], none: true };
  if (Array.isArray(t)) return { branches: t.map(String), exclude: [], paths: [], none: false };
  if (typeof t === 'string') return { branches: [t], exclude: [], paths: [], none: false };
  return { branches: (t.branches?.include ?? ['*']).map(String), exclude: (t.branches?.exclude ?? []).map(String), paths: (t.paths?.include ?? []).map(String), none: false };
}

function branchMatches(patterns: string[], branch: string): boolean {
  return patterns.some((p) => {
    const pat = p.replace(/^refs\/heads\//, '');
    if (pat === '*') return true;
    return new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(branch);
  });
}

let runStarter: ((project: DevOpsProject, run: PipelineRun) => void) | null = null;

export function setRunStarter(fn: (project: DevOpsProject, run: PipelineRun) => void) {
  runStarter = fn;
}

function changedFiles(repo: DevOpsRepo, from: string | undefined, to: string): string[] {
  const a = from ? repo.commits[from]?.tree ?? {} : {};
  const b = repo.commits[to]?.tree ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}

export function triggerCi(project: DevOpsProject, repo: DevOpsRepo, branch: string, commit: string, by: string, previous?: string): PipelineRun[] {
  const out: PipelineRun[] = [];
  for (const pl of project.pipelines.filter((p) => p.repoId === repo.id)) {
    const yamlText = repo.commits[commit]?.tree[pl.yamlPath];
    if (yamlText === undefined) continue;
    const t = parseTrigger(yamlText);
    if (t.none || !branchMatches(t.branches, branch) || branchMatches(t.exclude, branch)) continue;
    if (t.paths.length) {
      const files = changedFiles(repo, previous, commit);
      if (!files.some((f) => t.paths.some((p) => f.startsWith(p.replace(/\*+$/, '').replace(/\/$/, ''))))) continue;
    }
    out.push(queueRun(project, pl, branch, 'individualCI', by));
  }
  return out;
}

export function createPipeline(project: DevOpsProject, name: string, repo: DevOpsRepo, yamlPath: string, branch?: string): Pipeline {
  if (project.pipelines.some((p) => ciEq(p.name, name))) throw new ArmError('DevOpsError', `A pipeline with the name '${name}' already exists.`, 409);
  const path = yamlPath.replace(/^\//, '');
  const tree = filesAt(repo, branch ?? repo.defaultBranch);
  if (tree[path] === undefined) {
    throw new ArmError('DevOpsError', `The file /${path} could not be found in the repository ${repo.name} on branch ${branch ?? repo.defaultBranch}. Sube primero el YAML del pipeline al repositorio (git add, commit y push).`, 404);
  }
  try {
    load(tree[path]);
  } catch (e: any) {
    throw new ArmError('DevOpsError', `/${path}: ${e?.message?.split('\n')[0] ?? 'YAML inválido'}`, 400);
  }
  const p: Pipeline = { id: String(project.pipelines.length + 1 + Math.floor(Math.random() * 3)), name, repoId: repo.id, yamlPath: path, createdAt: nowIso(), variables: {} };
  while (project.pipelines.some((x) => x.id === p.id)) p.id = String(Number(p.id) + 1);
  project.pipelines.push(p);
  changed();
  return p;
}

export function queueRun(project: DevOpsProject, pl: Pipeline, branch: string, reason: PipelineRun['reason'], by: string, variables: Record<string, string> = {}): PipelineRun {
  const s = getState();
  const repo = project.repos.find((r) => r.id === pl.repoId)!;
  const commit = repo.branches[branch] ?? repo.branches[repo.defaultBranch];
  if (!commit) throw new ArmError('DevOpsError', `Branch '${branch}' not found in repository ${repo.name}.`, 404);
  s.devops.runCounter++;
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const sameDay = project.runs.filter((r) => r.buildNumber.startsWith(ymd)).length + 1;
  const run: PipelineRun = {
    id: String(s.devops.runCounter),
    number: s.devops.runCounter,
    pipelineId: pl.id,
    pipelineName: pl.name,
    buildNumber: `${ymd}.${sameDay}`,
    status: 'queued',
    reason,
    sourceBranch: `refs/heads/${branch}`,
    sourceVersion: commit,
    commitMessage: repo.commits[commit]?.message ?? '',
    queuedAt: nowIso(),
    stages: [],
    artifacts: {},
    requestedBy: by,
    variables,
  };
  project.runs.unshift(run);
  if (project.runs.length > 60) project.runs = project.runs.slice(0, 60);
  changed();
  bus.emit('devops:run', { project: project.name, run: run.id });
  if (runStarter) setTimeout(() => runStarter!(project, run), 50);
  return run;
}

export function findRun(project: DevOpsProject, id: string): PipelineRun {
  const r = project.runs.find((x) => x.id === String(id));
  if (!r) throw new ArmError('DevOpsError', `Run ${id} not found.`, 404);
  return r;
}

export function approveStage(project: DevOpsProject, runId: string, stageId: string, approve: boolean, by: string) {
  const run = findRun(project, runId);
  const st = run.stages.find((x) => x.id === stageId || x.name === stageId);
  if (!st?.approval || st.approval.status !== 'pending') throw new ArmError('DevOpsError', 'No hay ninguna aprobación pendiente para esa fase.', 400);
  st.approval.status = approve ? 'approved' : 'rejected';
  st.approval.by = by;
  changed();
}

/**
 * "Volver a ejecutar las fases con errores": la misma ejecución (mismo commit, variables y artefactos ya publicados)
 * repite sólo las fases fallidas, canceladas u omitidas; las correctas se conservan.
 */
export function rerunFailedStages(project: DevOpsProject, runId: string): PipelineRun {
  const run = findRun(project, runId);
  if (run.status !== 'failed' && run.status !== 'canceled') throw new ArmError('DevOpsError', 'Sólo se pueden repetir las fases de una ejecución con errores o cancelada.', 400);
  const redo = run.stages.filter((s) => s.status === 'failed' || s.status === 'canceled' || s.status === 'skipped');
  if (!redo.length) throw new ArmError('DevOpsError', 'La ejecución no tiene fases con errores que repetir.', 400);
  for (const s of redo) {
    s.status = 'notStarted';
    s.approval = null;
    for (const j of s.jobs) {
      j.status = 'notStarted';
      j.steps = [];
    }
  }
  run.status = 'queued';
  run.error = undefined;
  run.finishedAt = undefined;
  run.attempt = (run.attempt ?? 1) + 1;
  changed();
  bus.emit('devops:run', { project: project.name, run: run.id });
  if (runStarter) setTimeout(() => runStarter!(project, run), 50);
  return run;
}

export function cancelRun(project: DevOpsProject, runId: string) {
  const run = findRun(project, runId);
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = 'canceled';
  run.finishedAt = nowIso();
  changed();
}

// ---------------------------------------------------------------- pull requests

export function createPullRequest(project: DevOpsProject, repo: DevOpsRepo, source: string, target: string, title: string, description: string, by: string, workItems: number[] = []): PullRequest {
  for (const id of workItems) if (!project.workItems.some((w) => w.id === Number(id))) throw new ArmError('DevOpsError', `TF401232: Work item ${id} does not exist, or you do not have permissions to read it.`, 404);
  if (!repo.branches[source]) throw new ArmError('DevOpsError', `TF401398: The pull request cannot be activated because the source and/or the target branch no longer exists. (rama '${source}')`, 400);
  if (!repo.branches[target]) throw new ArmError('DevOpsError', `Target branch '${target}' not found.`, 404);
  if (repo.branches[source] === repo.branches[target]) throw new ArmError('DevOpsError', 'TF401179: The source and target branches have no differences.', 400);
  if (project.pullRequests.some((p) => p.repoId === repo.id && p.source === source && p.target === target && p.status === 'active')) throw new ArmError('DevOpsError', 'TF401179: An active pull request for the source and target branch already exists.', 409);
  const s = getState();
  s.devops.prCounter++;
  const pr: PullRequest = { id: s.devops.prCounter, repoId: repo.id, title, description, source, target, status: 'active', createdBy: by, createdAt: nowIso(), approvals: [], buildStatus: 'none' };
  project.pullRequests.unshift(pr);
  // Elementos indicados explícitamente y los mencionados (#12) en el título, la descripción o los commits de la rama.
  const mentioned = [title, description, ...commitsAhead(repo, source, target).map((c) => c.message)].flatMap((t) => mentionedWorkItems(project, t));
  const ids = [...new Set([...workItems.map(Number), ...mentioned])];
  if (ids.length) linkWorkItems(project, pr, ids);
  if (repo.policies?.buildValidationPipelineId) {
    const pl = project.pipelines.find((p) => p.id === repo.policies!.buildValidationPipelineId);
    if (pl) {
      const run = queueRun(project, pl, source, 'pullRequest', by, { 'System.PullRequest.PullRequestId': String(pr.id), 'System.PullRequest.TargetBranch': `refs/heads/${target}` });
      pr.buildStatus = 'running';
      pr.buildRunId = run.id;
    }
  }
  changed();
  return pr;
}

export function prPolicyStatus(project: DevOpsProject, pr: PullRequest): { ok: boolean; reasons: string[] } {
  const repo = project.repos.find((r) => r.id === pr.repoId)!;
  const reasons: string[] = [];
  const pol = pr.target === repo.defaultBranch ? repo.policies : null;
  if (pol?.minReviewers) {
    const n = pr.approvals.filter((a) => a !== pr.createdBy || pol.minReviewers === 0).length;
    const all = pr.approvals.length;
    if (all < pol.minReviewers) reasons.push(`Se necesitan ${pol.minReviewers} aprobaciones (hay ${all}).`);
    void n;
  }
  if (pol?.buildValidationPipelineId) {
    const run = pr.buildRunId ? project.runs.find((r) => r.id === pr.buildRunId) : undefined;
    if (!run || run.status !== 'succeeded') reasons.push(`La compilación de validación debe terminar correctamente (estado: ${run?.status ?? 'sin ejecutar'}).`);
  }
  if (pol?.requireLinkedWorkItem && !(pr.workItems ?? []).length) reasons.push('Debe haber al menos un elemento de trabajo vinculado (menciona #id en la descripción o vincúlalo en la pull request).');
  return { ok: !reasons.length, reasons };
}

export function completePullRequest(project: DevOpsProject, prId: number, by: string, squash = false, transitionWorkItems = false): PullRequest {
  const pr = project.pullRequests.find((p) => p.id === prId);
  if (!pr) throw new ArmError('DevOpsError', `Pull request ${prId} not found.`, 404);
  if (pr.status !== 'active') throw new ArmError('DevOpsError', `Pull request ${prId} is not active.`, 400);
  const st = prPolicyStatus(project, pr);
  if (!st.ok) throw new ArmError('DevOpsError', `TF401027: The pull request cannot be completed because required policies are not satisfied: ${st.reasons.join(' ')}`, 403);
  const repo = project.repos.find((r) => r.id === pr.repoId)!;
  const src = repo.branches[pr.source];
  const tgt = repo.branches[pr.target];
  const merged = { ...repo.commits[tgt].tree, ...repo.commits[src].tree };
  for (const k of Object.keys(repo.commits[tgt].tree)) if (!(k in repo.commits[src].tree) && isAncestor(repo, tgt, src)) delete merged[k];
  const c = makeCommit(repo, merged, squash ? `${pr.title} (#${pr.id})` : `Merged PR ${pr.id}: ${pr.title}`, by, squash ? [tgt] : [tgt, src]);
  repo.branches[pr.target] = c.id;
  pr.status = 'completed';
  pr.mergeCommit = c.id;
  for (const id of pr.workItems ?? []) {
    const wi = project.workItems.find((w) => w.id === id);
    if (!wi) continue;
    addLink(wi, { kind: 'commit', id: c.id, title: c.message.split('\n')[0], repo: repo.name });
    if (transitionWorkItems && wi.state !== 'Closed') wi.state = wi.type === 'User Story' || wi.type === 'Epic' ? 'Resolved' : 'Closed';
  }
  changed();
  triggerCi(project, repo, pr.target, c.id, by, tgt);
  return pr;
}

// ---------------------------------------------------------------- conexiones de servicio, entornos y variables

export function createAzureRmConnection(project: DevOpsProject, input: { name: string; scope: string; subscriptionId: string; automatic: boolean; appId?: string; secret?: string; role?: string }, admin: PrincipalRef): ServiceConnection {
  if (project.serviceConnections.some((c) => ciEq(c.name, input.name))) throw new ArmError('DevOpsError', `A service connection with name '${input.name}' already exists.`, 409);
  let appId = input.appId;
  let objectId: string | undefined;
  if (input.automatic) {
    const r = createSpForRbac(`${org()}-${project.name}-${guid().slice(0, 8)}`, input.role ?? 'Contributor', [input.scope], admin);
    appId = r.appId;
    objectId = r.sp.id;
  } else {
    const sp = appId ? findSp(appId) : undefined;
    if (!sp) throw new ArmError('DevOpsError', `Failed to obtain the Json Web Token(JWT) using service principal client ID. Exception Message: AADSTS700016: Application with identifier '${appId}' was not found in the directory.`, 400);
    if (!input.secret || !sp.secrets.includes(input.secret)) throw new ArmError('DevOpsError', `Failed to obtain the Json Web Token(JWT) using service principal client ID. Exception Message: AADSTS7000215: Invalid client secret provided.`, 400);
    objectId = sp.id;
  }
  const sc: ServiceConnection = { id: guid(), name: input.name, type: 'azurerm', authScheme: input.automatic ? 'WorkloadIdentityFederation' : 'ServicePrincipal', servicePrincipalAppId: appId, servicePrincipalObjectId: objectId, subscriptionId: input.subscriptionId, scope: input.scope, createdAt: nowIso(), isReady: true };
  project.serviceConnections.push(sc);
  changed();
  return sc;
}

export function createAcrConnection(project: DevOpsProject, name: string, registryId: string, admin: PrincipalRef): ServiceConnection {
  if (project.serviceConnections.some((c) => ciEq(c.name, name))) throw new ArmError('DevOpsError', `A service connection with name '${name}' already exists.`, 409);
  const reg = findResource(registryId);
  if (!reg) throw new ArmError('DevOpsError', 'Container registry not found.', 404);
  const r = createSpForRbac(`${org()}-${project.name}-acr-${guid().slice(0, 6)}`, undefined, [], admin);
  createRoleAssignment({ assignee: r.sp.id, role: 'AcrPush', scope: reg.id }, admin);
  const sc: ServiceConnection = { id: guid(), name, type: 'dockerregistry', authScheme: 'ServicePrincipal', servicePrincipalAppId: r.appId, servicePrincipalObjectId: r.sp.id, registryId: reg.id, createdAt: nowIso(), isReady: true };
  project.serviceConnections.push(sc);
  changed();
  return sc;
}

export function createKubernetesConnection(project: DevOpsProject, name: string, clusterId: string, admin: PrincipalRef): ServiceConnection {
  if (project.serviceConnections.some((c) => ciEq(c.name, name))) throw new ArmError('DevOpsError', `A service connection with name '${name}' already exists.`, 409);
  const cl = findResource(clusterId);
  if (!cl) throw new ArmError('DevOpsError', 'Cluster not found.', 404);
  const r = createSpForRbac(`${org()}-${project.name}-k8s-${guid().slice(0, 6)}`, undefined, [], admin);
  createRoleAssignment({ assignee: r.sp.id, role: 'Azure Kubernetes Service Cluster User Role', scope: cl.id }, admin);
  const sc: ServiceConnection = { id: guid(), name, type: 'kubernetes', authScheme: 'Kubeconfig', servicePrincipalAppId: r.appId, servicePrincipalObjectId: r.sp.id, clusterId: cl.id, createdAt: nowIso(), isReady: true };
  project.serviceConnections.push(sc);
  changed();
  return sc;
}

export function createEnvironment(project: DevOpsProject, name: string, requireApproval: boolean, approvers: string[]): DevOpsEnvironment {
  let env = project.environments.find((e) => ciEq(e.name, name));
  if (!env) {
    env = { id: String(project.environments.length + 1), name, approvers, requireApproval, deployments: [] };
    project.environments.push(env);
  } else {
    env.requireApproval = requireApproval;
    env.approvers = approvers;
  }
  changed();
  return env;
}

export function createWorkItem(project: DevOpsProject, type: WorkItem['type'], title: string, assignedTo?: string): WorkItem {
  const s = getState();
  s.devops.workItemCounter++;
  const wi: WorkItem = { id: s.devops.workItemCounter, type, title, state: 'New', assignedTo, createdAt: nowIso() };
  project.workItems.push(wi);
  changed();
  return wi;
}

export function notifyRunFinished(project: DevOpsProject, run: PipelineRun) {
  const s = getState();
  const ok = run.status === 'succeeded';
  notify({ title: `Pipeline ${run.pipelineName} #${run.buildNumber}: ${ok ? 'correcto' : run.status === 'canceled' ? 'cancelado' : 'con errores'}`, message: `${project.name} · ${run.sourceBranch.replace('refs/heads/', '')} · ${run.commitMessage.split('\n')[0]}`, level: ok ? 'success' : 'error', link: `/devops/${encodeURIComponent(project.name)}/pipelines/runs/${run.id}` });
  s.emails.unshift({ id: guid(), to: s.me.upn, subject: `[Build ${ok ? 'succeeded' : 'failed'}] ${project.name}/${run.pipelineName} - ${run.buildNumber}`, body: `El pipeline ${run.pipelineName} ha terminado con estado "${run.status}".\nRama: ${run.sourceBranch}\nCommit: ${run.sourceVersion.slice(0, 8)} ${run.commitMessage}\nSolicitado por: ${run.requestedBy}`, time: nowIso(), read: false });
  changed();
}
