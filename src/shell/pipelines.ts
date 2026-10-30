// Ejecutor de Azure Pipelines: interpreta el YAML y ejecuta fases, jobs y pasos en agentes hospedados simulados.
import { dump, load, loadAll } from 'js-yaml';
import type { DevOpsProject, FsDir, Pipeline, PipelineRun, PrincipalRef, Resource, RunJob, RunStage, RunStatus, RunStep, ServiceConnection } from '../engine/types';
import { getState, changed, speedFactor } from '../engine/store';
import { setRunStarter, notifyRunFinished, createEnvironment, orgUrl } from '../engine/services/devops';
import { findSp, principalRefForSp } from '../engine/services/identity';
import { canRead, findResource, hasPermission, notify } from '../engine/arm';
import { deployContent, setAppSettings, setSiteConfig, setSiteState, swapSlots } from '../engine/services/web';
import { canPush, pushImage } from '../engine/services/acr';
import { getSecret, listSecrets } from '../engine/services/keyvault';
import { clusterRunning } from '../engine/services/kube';
import { VFS, makeZip, readZip } from './fs';
import { ExitSignal, type Session, type ShellIO } from './interp';
import { createAgentSession } from './sessions';
import { buildImage, BuildError } from './commands/dockerBuild';
import { runKubectlAgainst } from './commands/kubectl';
import { ciEq, guid, nowIso, sleep } from '../engine/util';

const WORK = '/home/vsts/work';
const W = `${WORK}/1`;
const TEMP = `${WORK}/_temp`;
const AGENT_VERSION = '4.252.0';
const FINAL: RunStatus[] = ['succeeded', 'failed', 'canceled', 'skipped', 'succeededWithIssues'];

class PipelineError extends Error {}
class TaskError extends Error {}

// ---------------------------------------------------------------- modelo normalizado

interface Var {
  name: string;
  value: string;
  isSecret: boolean;
}
type VarMap = Map<string, Var>;

interface NStep {
  kind: 'script' | 'task' | 'checkout' | 'publish' | 'download';
  task: string;
  version: string;
  script?: string;
  inputs: Record<string, any>;
  env: Record<string, string>;
  displayName: string;
  name?: string;
  condition?: string;
  continueOnError: boolean;
  enabled: boolean;
  workingDirectory?: string;
  failOnStderr: boolean;
  implicit?: boolean;
}

interface NJob {
  name: string;
  displayName: string;
  deployment: boolean;
  environment?: string;
  pool: { vmImage?: string; name?: string } | null;
  dependsOn: string[];
  condition?: string;
  variables: Var[];
  steps: NStep[];
}

interface NStage {
  name: string;
  displayName: string;
  dependsOn: string[] | null;
  condition?: string;
  variables: Var[];
  jobs: NJob[];
}

interface Plan {
  variables: Var[];
  parameters: Record<string, any>;
  stages: NStage[];
}

const str = (x: any): string => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
const asList = (x: any): string[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x.map(String) : [String(x)]);

function setVar(m: VarMap, v: Var) {
  m.set(v.name.toLowerCase(), v);
}

function parseVariables(v: any, project: DevOpsProject, where: string): Var[] {
  const out: Var[] = [];
  if (!v) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== 'object') continue;
      if ('group' in item) {
        const g = project.variableGroups.find((x) => ciEq(x.name, str(item.group)));
        if (!g) throw new PipelineError(`Variable group ${item.group} could not be found. The variable group does not exist or has not been authorized for use. For authorization details, refer to https://aka.ms/yamlauthz.`);
        for (const [k, x] of Object.entries(g.variables)) out.push({ name: k, value: x.value, isSecret: x.isSecret });
      } else if ('template' in item) throw new PipelineError(`${where}: el simulador no admite plantillas de variables (template: ${item.template}).`);
      else if ('name' in item) out.push({ name: str(item.name), value: str(item.value), isSecret: false });
    }
    return out;
  }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) out.push({ name: k, value: str(x), isSecret: false });
  return out;
}

function normPool(p: any): NJob['pool'] {
  if (p === undefined || p === null) return null;
  if (typeof p === 'string') return { name: p };
  return { vmImage: p.vmImage ? str(p.vmImage) : undefined, name: p.name ? str(p.name) : undefined };
}

function mapStr(o: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) out[k] = str(v);
  return out;
}

function normStep(s: any, i: number, jobName: string): NStep {
  if (!s || typeof s !== 'object') throw new PipelineError(`Job ${jobName}: el paso ${i + 1} no es válido.`);
  if ('template' in s) throw new PipelineError(`Job ${jobName}: el simulador no admite plantillas de pasos (template: ${s.template}).`);
  const base = {
    inputs: {} as Record<string, any>,
    env: mapStr(s.env),
    name: s.name ? str(s.name) : undefined,
    condition: s.condition !== undefined ? str(s.condition) : undefined,
    continueOnError: s.continueOnError === true || s.continueOnError === 'true',
    enabled: s.enabled !== false,
    workingDirectory: s.workingDirectory ? str(s.workingDirectory) : undefined,
    failOnStderr: s.failOnStderr === true || s.failOnStderr === 'true',
    version: '',
  };
  const dn = s.displayName ? str(s.displayName) : undefined;
  if ('script' in s) return { ...base, kind: 'script', task: 'CmdLine', script: str(s.script), displayName: dn ?? 'CmdLine' };
  if ('bash' in s) return { ...base, kind: 'script', task: 'Bash', script: str(s.bash), displayName: dn ?? 'Bash' };
  if ('pwsh' in s || 'powershell' in s) return { ...base, kind: 'script', task: 'PowerShell', script: str(s.pwsh ?? s.powershell), displayName: dn ?? 'PowerShell' };
  if ('checkout' in s) return { ...base, kind: 'checkout', task: 'Checkout', inputs: { repository: str(s.checkout) }, displayName: dn ?? '' };
  if ('publish' in s) return { ...base, kind: 'publish', task: 'PublishPipelineArtifact', inputs: { targetPath: str(s.publish), artifact: s.artifact ?? s.artifactName }, displayName: dn ?? 'Publish Pipeline Artifact' };
  if ('download' in s) return { ...base, kind: 'download', task: 'DownloadPipelineArtifact', inputs: { source: str(s.download), artifact: s.artifact, patterns: s.patterns, path: s.path }, displayName: dn ?? (s.artifact ? `Download Artifact - ${s.artifact}` : 'Download Artifact') };
  if ('task' in s) {
    const [name, version = ''] = str(s.task).split('@');
    return { ...base, kind: 'task', task: name.trim(), version: version.trim(), inputs: { ...(s.inputs ?? {}) }, displayName: dn ?? name.trim() };
  }
  throw new PipelineError(`Job ${jobName}: paso no reconocido (${Object.keys(s).join(', ')}). Usa script, bash, task, checkout, publish o download.`);
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normJob(j: any, idx: number, total: number, project: DevOpsProject, defaultPool: NJob['pool']): NJob {
  if (!j || typeof j !== 'object') throw new PipelineError(`El job ${idx + 1} no es válido.`);
  if ('template' in j) throw new PipelineError(`El simulador no admite plantillas de jobs (template: ${j.template}).`);
  const deployment = 'deployment' in j;
  const name = str(deployment ? j.deployment : j.job ?? (total > 1 ? `Job${idx + 1}` : 'Job'));
  if (!NAME_RE.test(name)) throw new PipelineError(`Job ${name} has an invalid name. Valid names may only contain alphanumeric characters and '_' and may not start with a number.`);
  let rawSteps: any[] = [];
  let environment: string | undefined;
  if (deployment) {
    environment = str(typeof j.environment === 'object' && j.environment ? j.environment.name : j.environment).split('.')[0];
    if (!environment) throw new PipelineError(`Job ${name}: un deployment job necesita la propiedad environment.`);
    const strat = j.strategy ?? {};
    const kind = Object.keys(strat)[0];
    if (!kind) throw new PipelineError(`Job ${name}: falta strategy (por ejemplo strategy: runOnce: deploy: steps: ...).`);
    const sd = strat[kind] ?? {};
    for (const hook of ['preDeploy', 'deploy', 'routeTraffic', 'postRouteTraffic']) rawSteps.push(...(sd[hook]?.steps ?? []));
    for (const s of sd.on?.success?.steps ?? []) rawSteps.push({ condition: 'succeeded()', ...s });
    for (const s of sd.on?.failure?.steps ?? []) rawSteps.push({ condition: 'failed()', ...s });
  } else rawSteps = j.steps ?? [];
  if (!Array.isArray(rawSteps) || !rawSteps.length) throw new PipelineError(`Job ${name}: el job no tiene pasos (steps).`);
  const steps = rawSteps.map((s, i) => normStep(s, i, name));
  if (!deployment && !steps.some((s) => s.kind === 'checkout')) steps.unshift({ ...normStep({ checkout: 'self' }, 0, name), implicit: true });
  if (deployment && !steps.some((s) => s.kind === 'download')) steps.unshift({ ...normStep({ download: 'current' }, 0, name), implicit: true });
  return {
    name,
    displayName: j.displayName ? str(j.displayName) : name,
    deployment,
    environment,
    pool: normPool(j.pool) ?? defaultPool,
    dependsOn: asList(j.dependsOn),
    condition: j.condition !== undefined ? str(j.condition) : undefined,
    variables: parseVariables(j.variables, project, `Job ${name}`),
    steps: steps.filter((s) => s.enabled && !(s.kind === 'checkout' && s.inputs.repository === 'none') && !(s.kind === 'download' && s.inputs.source === 'none')),
  };
}

function normalize(doc: any, project: DevOpsProject): Plan {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PipelineError('El fichero YAML está vacío o no es un objeto.');
  if (doc.extends) throw new PipelineError('El simulador no admite extends: (plantillas de pipeline).');
  if (doc.resources?.repositories?.length) throw new PipelineError('El simulador no admite repositorios adicionales en resources.');
  const defaultPool = normPool(doc.pool);
  let stages: any[];
  if (doc.stages) stages = doc.stages;
  else if (doc.jobs) stages = [{ stage: '__default', jobs: doc.jobs }];
  else if (doc.steps) stages = [{ stage: '__default', jobs: [{ job: 'Job', steps: doc.steps }] }];
  else throw new PipelineError('El pipeline no define stages, jobs ni steps.');
  if (!Array.isArray(stages) || !stages.length) throw new PipelineError('stages debe ser una lista con al menos una fase.');
  const seen = new Set<string>();
  const out: NStage[] = stages.map((st: any, si: number) => {
    if (!st || typeof st !== 'object') throw new PipelineError(`La fase ${si + 1} no es válida.`);
    if ('template' in st) throw new PipelineError(`El simulador no admite plantillas de fases (template: ${st.template}).`);
    const name = str(st.stage ?? `Stage${si + 1}`);
    if (name !== '__default' && !NAME_RE.test(name)) throw new PipelineError(`Stage ${name} has an invalid name. Valid names may only contain alphanumeric characters and '_' and may not start with a number.`);
    if (seen.has(name.toLowerCase())) throw new PipelineError(`Stage ${name} is defined more than once.`);
    seen.add(name.toLowerCase());
    const jobs = st.jobs ?? [];
    if (!Array.isArray(jobs) || !jobs.length) throw new PipelineError(`Stage ${name} must contain at least one job with no dependencies.`);
    const nj = jobs.map((j: any, i: number) => normJob(j, i, jobs.length, project, normPool(st.pool) ?? defaultPool));
    const jn = new Set(nj.map((j: NJob) => j.name.toLowerCase()));
    for (const j of nj) for (const d of j.dependsOn) if (!jn.has(d.toLowerCase())) throw new PipelineError(`Job ${j.name} depends on unknown job ${d}.`);
    return {
      name,
      displayName: st.displayName ? str(st.displayName) : name === '__default' ? 'Pipeline' : name,
      dependsOn: st.dependsOn === undefined ? null : asList(st.dependsOn),
      condition: st.condition !== undefined ? str(st.condition) : undefined,
      variables: parseVariables(st.variables, project, `Stage ${name}`),
      jobs: nj,
    };
  });
  for (const st of out) for (const d of st.dependsOn ?? []) if (!seen.has(d.toLowerCase())) throw new PipelineError(`Stage ${st.name} depends on unknown stage ${d}.`);
  return { variables: parseVariables(doc.variables, project, 'Pipeline'), parameters: {}, stages: out };
}

// ---------------------------------------------------------------- expresiones (condiciones y ${{ }})

type ENode = { k: 'lit'; v: any } | { k: 'call'; name: string; args: ENode[] } | { k: 'ref'; path: string[] };

interface ExprCtx {
  variables: VarMap;
  parameters?: Record<string, any>;
  dependencies?: Record<string, string>;
  status?: { mode: 'step'; failed: boolean; canceled: boolean } | { mode: 'deps'; results: Record<string, string>; canceled: boolean };
  /** Variables de bucle de ${{ each x in ... }}. */
  locals?: Record<string, any>;
}

function tokenizeExpr(src: string): { t: string; v: string }[] {
  const out: { t: string; v: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let v = '';
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          v += "'";
          i += 2;
          continue;
        }
        if (src[i] === "'") break;
        v += src[i++];
      }
      if (src[i] !== "'") throw new PipelineError(`Unexpected end of expression: ${src}`);
      i++;
      out.push({ t: 'str', v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let v = c;
      i++;
      while (i < src.length && /[0-9.]/.test(src[i])) v += src[i++];
      out.push({ t: 'num', v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let v = '';
      while (i < src.length && /[A-Za-z0-9_\-]/.test(src[i])) v += src[i++];
      out.push({ t: 'id', v });
      continue;
    }
    if ('(),[].'.includes(c)) {
      out.push({ t: 'p', v: c });
      i++;
      continue;
    }
    throw new PipelineError(`Unexpected symbol: '${c}'. Located at position ${i + 1} within expression: ${src}.`);
  }
  return out;
}

function parseExpr(src: string): ENode {
  const toks = tokenizeExpr(src);
  let p = 0;
  const peek = () => toks[p];
  const expect = (v: string) => {
    if (toks[p]?.v !== v) throw new PipelineError(`Expected '${v}' in expression: ${src}`);
    p++;
  };
  const node = (): ENode => {
    const t = toks[p++];
    if (!t) throw new PipelineError(`Unexpected end of expression: ${src}`);
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'num') return { k: 'lit', v: Number(t.v) };
    if (t.t === 'id') {
      const low = t.v.toLowerCase();
      if (low === 'true') return { k: 'lit', v: true };
      if (low === 'false') return { k: 'lit', v: false };
      if (low === 'null') return { k: 'lit', v: null };
      if (peek()?.v === '(') {
        p++;
        const args: ENode[] = [];
        if (peek()?.v !== ')') {
          for (;;) {
            args.push(node());
            if (peek()?.v === ',') {
              p++;
              continue;
            }
            break;
          }
        }
        expect(')');
        return { k: 'call', name: low, args };
      }
      const path = [t.v];
      for (;;) {
        if (peek()?.v === '.') {
          p++;
          const n = toks[p++];
          if (!n || n.t !== 'id') throw new PipelineError(`Unexpected symbol in expression: ${src}`);
          path.push(n.v);
        } else if (peek()?.v === '[') {
          p++;
          const n = toks[p++];
          if (!n || (n.t !== 'str' && n.t !== 'num')) throw new PipelineError(`Unexpected symbol in expression: ${src}`);
          path.push(n.v);
          expect(']');
        } else break;
      }
      return { k: 'ref', path };
    }
    throw new PipelineError(`Unexpected symbol: '${t.v}' within expression: ${src}`);
  };
  const n = node();
  if (p < toks.length) throw new PipelineError(`Unexpected symbol: '${toks[p].v}' within expression: ${src}`);
  return n;
}

function truthy(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v);
  return s !== '' && s.toLowerCase() !== 'false';
}

function exprStr(v: any): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  return str(v);
}

function looseEq(a: any, b: any): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  return exprStr(a).toLowerCase() === exprStr(b).toLowerCase();
}

function evalNode(n: ENode, c: ExprCtx): any {
  if (n.k === 'lit') return n.v;
  if (n.k === 'ref') {
    const [root, ...rest] = n.path;
    if (c.locals && root in c.locals) {
      let cur: any = c.locals[root];
      for (const k of rest) cur = cur?.[k];
      return cur ?? null;
    }
    const r = root.toLowerCase();
    if (r === 'variables') return c.variables.get(rest.join('.').toLowerCase())?.value ?? null;
    if (r === 'parameters') {
      let cur: any = c.parameters ?? {};
      for (const k of rest) cur = cur?.[k];
      return cur ?? null;
    }
    if (r === 'dependencies' || r === 'stagedependencies') {
      const dep = c.dependencies?.[rest[0]?.toLowerCase() ?? ''];
      return rest[1]?.toLowerCase() === 'result' ? dep ?? null : null;
    }
    throw new PipelineError(`Unrecognized value: '${n.path.join('.')}'. Located within expression. Puedes usar variables['nombre'], parameters.nombre o funciones como eq(), and(), succeeded().`);
  }
  const a = (i: number) => evalNode(n.args[i], c);
  const st = c.status;
  const depOk = (names: string[]) => {
    if (!st || st.mode !== 'deps') return true;
    const keys = names.length ? names.map((x) => x.toLowerCase()) : Object.keys(st.results);
    return keys.every((k) => ['Succeeded', 'SucceededWithIssues'].includes(st.results[k]));
  };
  switch (n.name) {
    case 'and':
      return n.args.every((_, i) => truthy(a(i)));
    case 'or':
      return n.args.some((_, i) => truthy(a(i)));
    case 'not':
      return !truthy(a(0));
    case 'xor':
      return truthy(a(0)) !== truthy(a(1));
    case 'eq':
      return looseEq(a(0), a(1));
    case 'ne':
      return !looseEq(a(0), a(1));
    case 'gt':
      return Number(a(0)) > Number(a(1));
    case 'ge':
      return Number(a(0)) >= Number(a(1));
    case 'lt':
      return Number(a(0)) < Number(a(1));
    case 'le':
      return Number(a(0)) <= Number(a(1));
    case 'contains':
      return exprStr(a(0)).toLowerCase().includes(exprStr(a(1)).toLowerCase());
    case 'startswith':
      return exprStr(a(0)).toLowerCase().startsWith(exprStr(a(1)).toLowerCase());
    case 'endswith':
      return exprStr(a(0)).toLowerCase().endsWith(exprStr(a(1)).toLowerCase());
    case 'in':
      return n.args.slice(1).some((_, i) => looseEq(a(0), a(i + 1)));
    case 'notin':
      return !n.args.slice(1).some((_, i) => looseEq(a(0), a(i + 1)));
    case 'containsvalue': {
      const col = a(0);
      return Array.isArray(col) ? col.some((x) => looseEq(x, a(1))) : col && typeof col === 'object' ? Object.values(col).some((x) => looseEq(x, a(1))) : false;
    }
    case 'lower':
      return exprStr(a(0)).toLowerCase();
    case 'upper':
      return exprStr(a(0)).toUpperCase();
    case 'replace':
      return exprStr(a(0)).split(exprStr(a(1))).join(exprStr(a(2)));
    case 'length': {
      const v = a(0);
      return Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : exprStr(v).length;
    }
    case 'join': {
      const v = a(1);
      return Array.isArray(v) ? v.map(exprStr).join(exprStr(a(0))) : exprStr(v);
    }
    case 'coalesce':
      for (let i = 0; i < n.args.length; i++) {
        const v = a(i);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    case 'iif':
      return truthy(a(0)) ? a(1) : a(2);
    case 'format': {
      const fmt = exprStr(a(0));
      return fmt.replace(/\{(\d+)\}/g, (_m, d) => exprStr(a(Number(d) + 1)));
    }
    case 'always':
      return true;
    case 'canceled':
      return !!st?.canceled;
    case 'succeeded':
      if (!st) return true;
      if (st.mode === 'step') return !st.failed && !st.canceled;
      return !st.canceled && depOk(n.args.map((_, i) => exprStr(a(i))));
    case 'failed':
      if (!st) return false;
      if (st.mode === 'step') return st.failed && !st.canceled;
      {
        const names = n.args.length ? n.args.map((_, i) => exprStr(a(i)).toLowerCase()) : Object.keys(st.results);
        return !st.canceled && names.some((k) => st.results[k] === 'Failed');
      }
    case 'succeededorfailed':
      return !st?.canceled;
    default:
      throw new PipelineError(`Unrecognized function: '${n.name}'. Funciones disponibles en el simulador: and, or, not, eq, ne, gt, lt, contains, startsWith, endsWith, in, notIn, coalesce, format, lower, upper, succeeded, failed, always, canceled, succeededOrFailed.`);
  }
}

function evalExpr(src: string, c: ExprCtx): any {
  const s = src.trim().replace(/^\$\[\s*([\s\S]*)\]$/, '$1').replace(/^\$\{\{\s*([\s\S]*)\}\}$/, '$1');
  return evalNode(parseExpr(s), c);
}

const DIRECTIVE_RE = /^\$\{\{\s*(if|elseif|else|each)\b\s*([\s\S]*?)\s*\}\}$/;

/** Colección de un ${{ each x in expr }}: listas tal cual; objetos como pares { key, value }. */
function eachItems(expr: string, c: ExprCtx): { name: string; items: any[] } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/.exec(expr);
  if (!m) throw new PipelineError(`Expresión each no válida: '${expr}'. Usa \${{ each elemento in parameters.lista }}.`);
  const col = evalExpr(m[2], c);
  const items = Array.isArray(col) ? col : col && typeof col === 'object' ? Object.entries(col).map(([key, value]) => ({ key, value })) : [];
  return { name: m[1], items };
}

/**
 * Expande expresiones de plantilla ${{ }}: valores, inserciones condicionales (if / elseif / else) y bucles (each).
 * Una expresión que devuelve una lista dentro de otra lista se inserta "aplanada", como en Azure Pipelines.
 */
function expandTemplateExpr(v: any, c: ExprCtx): any {
  if (typeof v === 'string') {
    const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(v.trim());
    if (whole && !/\}\}[\s\S]*\$\{\{/.test(v.trim())) return evalExpr(whole[1], c);
    return v.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, e) => exprStr(evalExpr(e, c)));
  }
  if (Array.isArray(v)) {
    const out: any[] = [];
    const push = (val: any, flatten: boolean) => (flatten && Array.isArray(val) ? out.push(...val) : out.push(val));
    let chain: boolean | null = null;
    for (const item of v) {
      const keys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [];
      const d = keys.length === 1 ? DIRECTIVE_RE.exec(keys[0]) : null;
      if (d) {
        const body = item[keys[0]];
        if (d[1] === 'each') {
          chain = null;
          const { name, items } = eachItems(d[2], c);
          for (const it of items) push(expandTemplateExpr(body, { ...c, locals: { ...c.locals, [name]: it } }), true);
          continue;
        }
        const take: boolean = d[1] === 'if' ? truthy(evalExpr(d[2], c)) : chain === false && (d[1] === 'else' || truthy(evalExpr(d[2], c)));
        if (take) push(expandTemplateExpr(body, c), true);
        chain = d[1] === 'else' ? null : d[1] === 'if' ? take : chain || take;
        continue;
      }
      chain = null;
      push(expandTemplateExpr(item, c), typeof item === 'string' && /^\s*\$\{\{[\s\S]*\}\}\s*$/.test(item));
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    let chain: boolean | null = null;
    for (const [k, x] of Object.entries(v)) {
      const d = DIRECTIVE_RE.exec(k);
      if (d) {
        if (d[1] === 'each') {
          chain = null;
          const { name, items } = eachItems(d[2], c);
          for (const it of items) Object.assign(out, expandTemplateExpr(x, { ...c, locals: { ...c.locals, [name]: it } }));
          continue;
        }
        const take: boolean = d[1] === 'if' ? truthy(evalExpr(d[2], c)) : chain === false && (d[1] === 'else' || truthy(evalExpr(d[2], c)));
        if (take) Object.assign(out, expandTemplateExpr(x, c));
        chain = d[1] === 'else' ? null : d[1] === 'if' ? take : chain || take;
        continue;
      }
      chain = null;
      out[expandTemplateExpr(k, c)] = expandTemplateExpr(x, c);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- plantillas (template: y extends:)

type TplKind = 'stages' | 'jobs' | 'steps' | 'variables';
const KIND_ES: Record<TplKind, string> = { stages: 'fases', jobs: 'jobs', steps: 'pasos', variables: 'variables' };

interface TplCtx {
  tree: Record<string, string>;
  variables: VarMap;
  repo: string;
  branch: string;
  version: string;
  count: number;
  /** Plantillas usadas (ruta → nº de veces), para mostrarlas en la ejecución. */
  used: Record<string, number>;
}

/** Ruta de una plantilla relativa al fichero que la referencia (o absoluta desde la raíz del repositorio). */
export function resolveTemplatePath(ref: string, from: string): string {
  const [p, repo] = ref.split('@');
  if (repo && repo.trim() !== 'self') throw new PipelineError(`/${from}: el simulador sólo admite plantillas del propio repositorio (${ref}). Copia la plantilla en este repositorio o usa @self.`);
  const raw = p.trim();
  const parts = raw.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of raw.replace(/^\/+/, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function coerceParam(v: any, type: string | undefined, name: string, file: string): any {
  const t = String(type ?? 'string').toLowerCase();
  if (t === 'boolean') {
    if (typeof v === 'boolean') return v;
    if (/^(true|false)$/i.test(String(v).trim())) return String(v).trim().toLowerCase() === 'true';
    throw new PipelineError(`${file}: The '${name}' parameter value '${str(v)}' is not a valid Boolean.`);
  }
  if (t === 'number') {
    const n = Number(v);
    if (v === '' || Number.isNaN(n)) throw new PipelineError(`${file}: The '${name}' parameter value '${str(v)}' is not a valid number.`);
    return n;
  }
  if (t === 'string') return typeof v === 'object' && v !== null ? v : str(v);
  return v;
}

/** Calcula los valores de los parámetros de una plantilla (o del pipeline) y los valida como Azure Pipelines. */
function resolveParams(declared: any, provided: Record<string, any> | undefined, file: string, strict = true): Record<string, any> {
  const given: Record<string, any> = provided && typeof provided === 'object' ? { ...provided } : {};
  const out: Record<string, any> = {};
  if (Array.isArray(declared)) {
    for (const d of declared) {
      if (!d || typeof d !== 'object' || !d.name) continue;
      const name = String(d.name);
      let v = name in given ? given[name] : d.default;
      delete given[name];
      if (v === undefined || v === null) throw new PipelineError(`${file}: A value for the '${name}' parameter must be provided.`);
      v = coerceParam(v, d.type, name, file);
      if (Array.isArray(d.values) && d.values.length && !d.values.some((x: any) => looseEq(x, v))) throw new PipelineError(`${file}: The '${name}' parameter value '${str(v)}' is not a valid value. Valores permitidos: ${d.values.map(str).join(', ')}.`);
      out[name] = v;
    }
  } else if (declared && typeof declared === 'object') {
    // Sintaxis antigua: parameters: { nombre: valorPorDefecto }
    for (const [k, def] of Object.entries(declared)) {
      out[k] = k in given ? given[k] : def;
      delete given[k];
    }
  }
  const extra = Object.keys(given);
  if (strict && extra.length) throw new PipelineError(`${file}: Unexpected parameter '${extra[0]}'.`);
  return out;
}

function loadTemplate(ref: any, from: string, tc: TplCtx, depth: number): { path: string; doc: any } {
  if (depth > 20) throw new PipelineError(`/${from}: las plantillas están anidadas demasiado (máximo 20 niveles). ¿Una plantilla se incluye a sí misma?`);
  if (++tc.count > 100) throw new PipelineError('Se ha superado el máximo de 100 referencias a plantillas en un pipeline.');
  const path = resolveTemplatePath(str(ref), from);
  const text = tc.tree[path];
  if (text === undefined) throw new PipelineError(`/${from}: File /${path} not found in repository ${tc.repo} branch ${tc.branch} version ${tc.version}.`);
  tc.used[path] = (tc.used[path] ?? 0) + 1;
  let doc: any;
  try {
    doc = load(text);
  } catch (e: any) {
    throw new PipelineError(`/${path}: ${String(e?.message ?? e).split('\n')[0]}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PipelineError(`/${path}: la plantilla está vacía o no es un objeto YAML.`);
  return { path, doc };
}

function expandTemplateRef(item: any, kind: TplKind, from: string, tc: TplCtx, depth: number): any[] {
  const { path, doc } = loadTemplate(item.template, from, tc, depth);
  const params = resolveParams(doc.parameters, item.parameters, `/${path}`);
  const expanded = expandTemplateExpr({ ...doc, parameters: undefined }, { variables: tc.variables, parameters: params });
  let list = expanded[kind];
  if (kind === 'variables' && list && typeof list === 'object' && !Array.isArray(list)) list = Object.entries(list).map(([name, value]) => ({ name, value }));
  if (!Array.isArray(list)) {
    const present = (['stages', 'jobs', 'steps', 'variables'] as TplKind[]).filter((k) => expanded[k] !== undefined);
    throw new PipelineError(`/${path}: se esperaba una plantilla de ${KIND_ES[kind]} (clave "${kind}:")${present.length ? `, pero la plantilla define ${present.map((k) => `"${k}:"`).join(', ')}` : ''}.`);
  }
  return walkList(list, kind, path, tc, depth + 1);
}

function walkList(list: any, kind: TplKind, from: string, tc: TplCtx, depth: number): any {
  if (!Array.isArray(list)) return list;
  const out: any[] = [];
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item) && 'template' in item) out.push(...expandTemplateRef(item, kind, from, tc, depth));
    else out.push(kind === 'stages' ? walkStage(item, from, tc, depth) : kind === 'jobs' ? walkJob(item, from, tc, depth) : item);
  }
  return out;
}

function walkJob(j: any, from: string, tc: TplCtx, depth: number): any {
  if (!j || typeof j !== 'object') return j;
  const out = { ...j };
  if (Array.isArray(out.variables)) out.variables = walkList(out.variables, 'variables', from, tc, depth);
  if (Array.isArray(out.steps)) out.steps = walkList(out.steps, 'steps', from, tc, depth);
  if (out.strategy && typeof out.strategy === 'object') {
    out.strategy = Object.fromEntries(
      Object.entries<any>(out.strategy).map(([k, sd]) => {
        if (!sd || typeof sd !== 'object') return [k, sd];
        const nsd = { ...sd };
        for (const hook of ['preDeploy', 'deploy', 'routeTraffic', 'postRouteTraffic']) if (Array.isArray(nsd[hook]?.steps)) nsd[hook] = { ...nsd[hook], steps: walkList(nsd[hook].steps, 'steps', from, tc, depth) };
        if (nsd.on && typeof nsd.on === 'object') {
          nsd.on = { ...nsd.on };
          for (const w of ['success', 'failure']) if (Array.isArray(nsd.on[w]?.steps)) nsd.on[w] = { ...nsd.on[w], steps: walkList(nsd.on[w].steps, 'steps', from, tc, depth) };
        }
        return [k, nsd];
      }),
    );
  }
  return out;
}

function walkStage(st: any, from: string, tc: TplCtx, depth: number): any {
  if (!st || typeof st !== 'object') return st;
  const out = { ...st };
  if (Array.isArray(out.variables)) out.variables = walkList(out.variables, 'variables', from, tc, depth);
  if (Array.isArray(out.jobs)) out.jobs = walkList(out.jobs, 'jobs', from, tc, depth);
  return out;
}

const varList = (v: any): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([name, value]) => ({ name, value })) : []);

/** Sustituye extends: y todas las referencias template: por su contenido expandido. */
function resolveTemplates(doc: any, from: string, tc: TplCtx): any {
  let out = { ...doc };
  if (out.extends) {
    const ext = out.extends;
    if (!ext || typeof ext !== 'object' || !ext.template) throw new PipelineError(`/${from}: extends necesita una propiedad template.`);
    const { path, doc: tdoc } = loadTemplate(ext.template, from, tc, 0);
    const params = resolveParams(tdoc.parameters, ext.parameters, `/${path}`);
    const expanded = expandTemplateExpr({ ...tdoc, parameters: undefined }, { variables: tc.variables, parameters: params });
    if (!expanded.stages && !expanded.jobs && !expanded.steps) throw new PipelineError(`/${path}: una plantilla para extends debe definir stages, jobs o steps.`);
    const variables = out.variables || expanded.variables ? [...varList(out.variables), ...varList(expanded.variables)] : undefined;
    out = { ...out, extends: undefined, stages: expanded.stages, jobs: expanded.jobs, steps: expanded.steps, pool: expanded.pool ?? out.pool, variables };
    const inner = resolveTemplates({ ...out, variables: undefined }, path, tc);
    return { ...inner, variables: Array.isArray(variables) ? walkList(variables, 'variables', from, tc, 1) : variables };
  }
  if (Array.isArray(out.variables)) out.variables = walkList(out.variables, 'variables', from, tc, 0);
  if (Array.isArray(out.stages)) out.stages = walkList(out.stages, 'stages', from, tc, 0);
  if (Array.isArray(out.jobs)) out.jobs = walkList(out.jobs, 'jobs', from, tc, 0);
  if (Array.isArray(out.steps)) out.steps = walkList(out.steps, 'steps', from, tc, 0);
  return out;
}

interface CompileOpts {
  project: DevOpsProject;
  tree: Record<string, string>;
  yamlPath: string;
  repo: string;
  branch: string;
  version: string;
  /** Valores de los parámetros en tiempo de ejecución (texto, como llegan del formulario o de --parameters). */
  provided: Record<string, any>;
  sys: Record<string, string>;
}

/** De YAML (ya cargado) a plan ejecutable: parámetros, ${{ }}, plantillas y normalización. */
function compileDoc(doc: any, o: CompileOpts): { plan: Plan; parameters: Record<string, any>; templates: Record<string, number>; yaml: string } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PipelineError('El fichero YAML está vacío o no es un objeto.');
  const params = resolveParams(doc.parameters, o.provided, `/${o.yamlPath}`);
  const pre: VarMap = new Map();
  for (const [k, v] of Object.entries(o.sys)) setVar(pre, { name: k, value: v, isSecret: false });
  const tc: TplCtx = { tree: o.tree, variables: pre, repo: o.repo, branch: `refs/heads/${o.branch}`, version: o.version, count: 0, used: {} };
  // Las variables de la raíz (incluidas las de plantillas) ya se pueden usar en ${{ variables.x }}.
  let rootVars = doc.variables;
  if (Array.isArray(rootVars)) rootVars = walkList(expandTemplateExpr(rootVars, { variables: pre, parameters: params }), 'variables', o.yamlPath, tc, 0);
  for (const v of parseVariables(rootVars, o.project, 'Pipeline')) setVar(pre, v);
  const expanded = expandTemplateExpr({ ...doc, parameters: undefined, variables: undefined }, { variables: pre, parameters: params });
  const resolved = resolveTemplates({ ...expanded, variables: rootVars }, o.yamlPath, tc);
  const plan = normalize(resolved, o.project);
  plan.parameters = params;
  const clean = JSON.parse(JSON.stringify(resolved));
  return { plan, parameters: params, templates: tc.used, yaml: dump(clean, { lineWidth: 140, noRefs: true }) };
}

/**
 * Valida un pipeline sin ejecutarlo (botón "Validar" del editor y "Descargar YAML completo").
 * Lanza un Error con el mismo mensaje que mostraría la ejecución si el YAML o sus plantillas no son válidos.
 */
export function compilePipeline(project: DevOpsProject, repoName: string, branch: string, yamlPath: string, opts: { text?: string; parameters?: Record<string, any> } = {}): CompiledPipeline {
  const repo = project.repos.find((r) => ciEq(r.name, repoName));
  if (!repo) throw new Error(`Repository ${repoName} not found.`);
  const version = repo.branches[branch];
  const tree = { ...(repo.commits[version]?.tree ?? {}) };
  if (opts.text !== undefined) tree[yamlPath] = opts.text;
  const text = tree[yamlPath];
  if (text === undefined) throw new Error(`File /${yamlPath} not found in repository ${repo.name} branch refs/heads/${branch}.`);
  let doc: any;
  try {
    doc = load(text);
  } catch (e: any) {
    throw new Error(`/${yamlPath}: ${String(e?.message ?? e).split('\n')[0]}`);
  }
  const sys: Record<string, string> = { 'Build.SourceBranch': `refs/heads/${branch}`, 'Build.SourceBranchName': branch, 'Build.Reason': 'Manual', 'Build.Repository.Name': repo.name, 'System.TeamProject': project.name };
  try {
    const c = compileDoc(doc, { project, tree, yamlPath, repo: repo.name, branch, version: version ?? '', provided: opts.parameters ?? {}, sys });
    return { yaml: c.yaml, parameters: c.parameters, templates: c.templates, stages: c.plan.stages.map((s) => ({ name: s.name, displayName: s.displayName, jobs: s.jobs.map((j) => ({ name: j.name, displayName: j.displayName, steps: j.steps.filter((x) => !x.implicit).map((x) => x.displayName || x.task) })) })) };
  } catch (e: any) {
    throw new Error(e?.message ?? String(e));
  }
}

export interface CompiledPipeline {
  /** YAML final con plantillas y expresiones ${{ }} ya resueltas (como "Descargar YAML completo" de Azure DevOps). */
  yaml: string;
  parameters: Record<string, any>;
  templates: Record<string, number>;
  stages: { name: string; displayName: string; jobs: { name: string; displayName: string; steps: string[] }[] }[];
}

/** Parámetros en tiempo de ejecución declarados en la raíz del YAML (para el panel "Ejecutar pipeline"). */
export function pipelineParameters(yamlText: string): { name: string; displayName?: string; type: string; default?: any; values?: any[] }[] {
  try {
    const doc: any = load(yamlText);
    if (!Array.isArray(doc?.parameters)) return [];
    return doc.parameters.filter((p: any) => p && p.name).map((p: any) => ({ name: String(p.name), displayName: p.displayName ? String(p.displayName) : undefined, type: String(p.type ?? 'string'), default: p.default, values: Array.isArray(p.values) ? p.values : undefined }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- macros $(var)

function expandMacros(s: string, vars: VarMap): string {
  let out = s;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/\$\(([A-Za-z0-9_.\-]+)\)/g, (m, name: string) => vars.get(name.toLowerCase())?.value ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}

function expandDeep(v: any, vars: VarMap): any {
  if (typeof v === 'string') return expandMacros(v, vars);
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x, vars)]));
  return v;
}

const envName = (n: string) => n.replace(/[.\s]/g, '_').toUpperCase();

// ---------------------------------------------------------------- contexto de ejecución

interface RunCtx {
  project: DevOpsProject;
  run: PipelineRun;
  pipeline: Pipeline;
  plan: Plan;
  tree: Record<string, string>;
  repoName: string;
  abort: AbortController;
  secrets: Set<string>;
}

interface JobCtx {
  rc: RunCtx;
  stage: RunStage;
  job: RunJob;
  nj: NJob;
  fs: VFS;
  sess: Session;
  vars: VarMap;
  envKeys: string[];
  failed: boolean;
  issues: boolean;
  built: Map<string, { img: ReturnType<typeof buildImage>; tags: string[] }>;
}

function pause(ms: number, rc: RunCtx) {
  return sleep(Math.round(ms * speedFactor()), rc.abort.signal).catch(() => undefined);
}

function systemVars(rc: RunCtx): Record<string, string> {
  const { run, project } = rc;
  return {
    'Build.BuildId': run.id,
    'Build.BuildNumber': run.buildNumber,
    'Build.BuildUri': `vstfs:///Build/Build/${run.id}`,
    'Build.DefinitionName': run.pipelineName,
    'Build.DefinitionId': run.pipelineId,
    'Build.SourceBranch': run.sourceBranch,
    'Build.SourceBranchName': run.sourceBranch.split('/').pop() ?? '',
    'Build.SourceVersion': run.sourceVersion,
    'Build.SourceVersionMessage': run.commitMessage.split('\n')[0],
    'Build.Repository.Name': rc.repoName,
    'Build.Repository.Provider': 'TfsGit',
    'Build.Repository.Uri': `${orgUrl()}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(rc.repoName)}`,
    'Build.Reason': { manual: 'Manual', individualCI: 'IndividualCI', pullRequest: 'PullRequest' }[run.reason],
    'Build.RequestedFor': run.requestedBy,
    'Build.QueuedBy': run.requestedBy,
    'Build.SourcesDirectory': `${W}/s`,
    'Build.ArtifactStagingDirectory': `${W}/a`,
    'Build.StagingDirectory': `${W}/a`,
    'Build.BinariesDirectory': `${W}/b`,
    'System.DefaultWorkingDirectory': `${W}/s`,
    'System.ArtifactsDirectory': `${W}/a`,
    'System.TeamProject': project.name,
    'System.TeamProjectId': project.id,
    'System.CollectionUri': `${orgUrl()}/`,
    'System.TeamFoundationCollectionUri': `${orgUrl()}/`,
    'System.DefinitionId': run.pipelineId,
    'System.JobAttempt': '1',
    'System.HostType': 'build',
    'Pipeline.Workspace': W,
    'Agent.BuildDirectory': W,
    'Agent.TempDirectory': TEMP,
    'Agent.WorkFolder': WORK,
    'Agent.OS': 'Linux',
    'Agent.OSArchitecture': 'X64',
    'Agent.ToolsDirectory': '/opt/hostedtoolcache',
    'Common.TestResultsDirectory': `${W}/TestResults`,
  };
}

function jobVars(rc: RunCtx, ns: NStage, nj: NJob): VarMap {
  const m: VarMap = new Map();
  for (const [k, v] of Object.entries(systemVars(rc))) setVar(m, { name: k, value: v, isSecret: false });
  for (const [k, v] of Object.entries(rc.pipeline.variables)) setVar(m, { name: k, value: v.value, isSecret: v.isSecret });
  for (const v of [...rc.plan.variables, ...ns.variables, ...nj.variables]) setVar(m, { ...v });
  for (const [k, v] of Object.entries(rc.run.variables)) setVar(m, { name: k, value: v, isSecret: false });
  setVar(m, { name: 'System.StageName', value: ns.name, isSecret: false });
  setVar(m, { name: 'System.StageDisplayName', value: ns.displayName, isSecret: false });
  setVar(m, { name: 'System.JobName', value: nj.name, isSecret: false });
  setVar(m, { name: 'System.JobDisplayName', value: nj.displayName, isSecret: false });
  setVar(m, { name: 'Agent.JobName', value: nj.displayName, isSecret: false });
  if (nj.environment) setVar(m, { name: 'Environment.Name', value: nj.environment, isSecret: false });
  for (const v of m.values()) if (v.isSecret && v.value) rc.secrets.add(v.value);
  return m;
}

function staticVars(rc: RunCtx): VarMap {
  const m: VarMap = new Map();
  for (const [k, v] of Object.entries(systemVars(rc))) setVar(m, { name: k, value: v, isSecret: false });
  for (const [k, v] of Object.entries(rc.pipeline.variables)) setVar(m, { name: k, value: v.value, isSecret: v.isSecret });
  for (const v of rc.plan.variables) setVar(m, { ...v });
  for (const [k, v] of Object.entries(rc.run.variables)) setVar(m, { name: k, value: v, isSecret: false });
  return m;
}

const resultOf = (s: RunStatus | undefined): string =>
  s === 'succeeded' ? 'Succeeded' : s === 'succeededWithIssues' ? 'SucceededWithIssues' : s === 'failed' ? 'Failed' : s === 'canceled' ? 'Canceled' : s === 'skipped' ? 'Skipped' : 'NotStarted';

// ---------------------------------------------------------------- registro de logs

class StepLog {
  private buf = '';
  stderrSeen = false;
  forcedResult: 'Failed' | 'SucceededWithIssues' | null = null;
  constructor(private step: RunStep, private jc: JobCtx) {}

  private mask(s: string) {
    let out = s;
    for (const sec of this.jc.rc.secrets) if (sec.length >= 2) out = out.split(sec).join('***');
    return out;
  }

  line(raw: string) {
    let l = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (l.includes('\r')) l = l.split('\r').filter(Boolean).pop() ?? '';
    const vso = /##vso\[([\w.]+)([^\]]*)\](.*)$/.exec(l);
    if (vso) {
      this.vso(vso[1].toLowerCase(), vso[2].trim(), vso[3]);
      return;
    }
    if (this.step.log.length < 3000) this.step.log.push(this.mask(l));
    else if (this.step.log.length === 3000) this.step.log.push('... (log truncado)');
    changed();
  }

  write = (s: string) => {
    this.buf += s;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    for (const p of parts) this.line(p);
  };

  err = (s: string) => {
    if (s.trim()) this.stderrSeen = true;
    this.write(s);
  };

  flush() {
    if (this.buf) this.line(this.buf);
    this.buf = '';
  }

  cmd(s: string) {
    this.line(`##[command]${s}`);
  }

  error(s: string) {
    for (const l of s.split('\n')) this.line(`##[error]${l}`);
  }

  warning(s: string) {
    this.line(`##[warning]${s}`);
  }

  private vso(cmd: string, propsRaw: string, value: string) {
    const props: Record<string, string> = {};
    for (const kv of propsRaw.split(';').map((x) => x.trim()).filter(Boolean)) {
      const i = kv.indexOf('=');
      if (i > 0) props[kv.slice(0, i).toLowerCase()] = kv.slice(i + 1);
    }
    if (cmd === 'task.setvariable' && props.variable) {
      const secret = props.issecret === 'true';
      setVar(this.jc.vars, { name: props.variable, value, isSecret: secret });
      if (props.isoutput === 'true' && this.step.name) setVar(this.jc.vars, { name: `${this.step.name}.${props.variable}`, value, isSecret: secret });
      if (secret && value) this.jc.rc.secrets.add(value);
      return;
    }
    if (cmd === 'task.logissue') {
      this.line(`##[${props.type === 'warning' ? 'warning' : 'error'}]${value}`);
      return;
    }
    if (cmd === 'task.complete') {
      const r = (props.result ?? '').toLowerCase();
      this.forcedResult = r === 'failed' ? 'Failed' : r.startsWith('succeededwithissues') ? 'SucceededWithIssues' : null;
      return;
    }
    if (cmd === 'build.updatebuildnumber' && value) {
      this.jc.rc.run.buildNumber = value;
      changed();
      return;
    }
    if (cmd === 'build.addbuildtag') return;
    if (cmd === 'task.prependpath') return;
  }
}

// ---------------------------------------------------------------- utilidades de ficheros

function globRegex(pat: string): RegExp {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function walk(fs: VFS, dir: string): { rel: string; dir: boolean }[] {
  const out: { rel: string; dir: boolean }[] = [];
  const rec = (abs: string, rel: string) => {
    for (const e of fs.list(abs)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push({ rel: r, dir: e.node.t === 'd' });
      if (e.node.t === 'd') rec(`${abs}/${e.name}`, r);
    }
  };
  if (fs.isDir(dir)) rec(dir, '');
  return out;
}

/** Resuelve un patrón (absoluto o relativo a base) a rutas absolutas existentes. */
function findMatches(fs: VFS, pattern: string, base: string, opts: { files?: boolean; dirs?: boolean } = { files: true, dirs: true }): string[] {
  const abs = pattern.startsWith('/') ? pattern : `${base}/${pattern}`;
  const norm = fs.normalize('/', abs, '/home/vsts');
  if (!/[*?]/.test(norm)) return fs.exists(norm) ? [norm] : [];
  const segs = norm.split('/');
  const firstWild = segs.findIndex((s) => /[*?]/.test(s));
  const root = segs.slice(0, firstWild).join('/') || '/';
  const rest = segs.slice(firstWild).join('/');
  const re = globRegex(rest);
  return walk(fs, root)
    .filter((e) => (e.dir ? opts.dirs : opts.files) && re.test(e.rel))
    .map((e) => `${root === '/' ? '' : root}/${e.rel}`);
}

function matchesContents(rel: string, patterns: string[]): boolean {
  let ok = false;
  for (const p of patterns) {
    const neg = p.startsWith('!');
    const re = globRegex(neg ? p.slice(1) : p);
    if (re.test(rel)) ok = !neg;
  }
  return ok;
}

const lines = (s: any): string[] => str(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const bool = (v: any, def = false): boolean => (v === undefined || v === null || v === '' ? def : v === true || String(v).toLowerCase() === 'true');

/** Divide argumentos al estilo de la línea de comandos (respeta comillas). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let has = false;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** "-clave valor -otra 'valor con espacios'" → { clave: valor, ... } */
function parseOverrides(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = splitArgs(s);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('-') && parts[i].length > 1) {
      const k = parts[i].slice(1);
      const v = parts[i + 1] !== undefined && !/^-[A-Za-z_]/.test(parts[i + 1]) ? parts[++i] : '';
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- tareas

interface TaskCtx {
  jc: JobCtx;
  step: NStep;
  inputs: Record<string, any>;
  log: StepLog;
  io: ShellIO;
}

type TaskImpl = (t: TaskCtx) => Promise<number> | number;

function inp(t: TaskCtx, names: string | string[], def?: string): string | undefined {
  for (const n of Array.isArray(names) ? names : [names]) {
    const k = Object.keys(t.inputs).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined && t.inputs[k] !== undefined && t.inputs[k] !== null && t.inputs[k] !== '') return str(t.inputs[k]);
  }
  return def;
}

function req(t: TaskCtx, names: string | string[]): string {
  const v = inp(t, names);
  if (v === undefined) throw new TaskError(`Input required: ${Array.isArray(names) ? names[0] : names}`);
  return v;
}

function vget(t: TaskCtx, name: string) {
  return t.jc.vars.get(name.toLowerCase())?.value ?? '';
}

function resolvePath(t: TaskCtx, p: string) {
  return t.jc.fs.normalize(vget(t, 'System.DefaultWorkingDirectory'), p, '/home/vsts');
}

const SC_INPUTS: Record<string, string[]> = {
  azurerm: ['azureSubscription', 'connectedServiceNameARM', 'ConnectedServiceName', 'azureResourceManagerConnection', 'azureSubscriptionEndpoint', 'azureSubscriptionConnection', 'backendServiceArm', 'environmentServiceNameAzureRM', 'environmentServiceName'],
  dockerregistry: ['containerRegistry', 'dockerRegistryServiceConnection', 'dockerRegistryEndpoint'],
  kubernetes: ['kubernetesServiceConnection', 'kubernetesServiceEndpoint'],
};

function findSc(project: DevOpsProject, name: string): ServiceConnection | undefined {
  return project.serviceConnections.find((c) => ciEq(c.name, name) || c.id === name);
}

function getSc(t: TaskCtx, names: string[], type: ServiceConnection['type'], required = true): ServiceConnection | null {
  const name = inp(t, names);
  if (!name) {
    if (!required) return null;
    throw new TaskError(`Input required: ${names[0]}`);
  }
  const sc = findSc(t.jc.rc.project, name);
  if (!sc) throw new TaskError(`The pipeline is not valid. Job ${t.jc.nj.name}: Step input ${names[0]} references service connection ${name} which could not be found. The service connection does not exist, has been disabled or has not been authorized for use. For authorization details, refer to https://aka.ms/yamlauthz.`);
  if (sc.type !== type) throw new TaskError(`La conexión de servicio '${name}' es de tipo ${sc.type}, pero esta entrada necesita una de tipo ${type}.`);
  return sc;
}

function spPrincipal(sc: ServiceConnection): PrincipalRef {
  const sp = sc.servicePrincipalAppId ? findSp(sc.servicePrincipalAppId) : undefined;
  if (!sp) throw new TaskError(`AADSTS700016: Application with identifier '${sc.servicePrincipalAppId}' was not found in the directory '${getState().tenant.domain}'. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant.\n(La entidad de servicio de la conexión '${sc.name}' ya no existe: vuelve a crear la conexión de servicio.)`);
  return principalRefForSp(sp);
}

async function sh(t: TaskCtx, argv: string[], opts: { quiet?: boolean; show?: string } = {}): Promise<number> {
  if (!opts.quiet) t.log.cmd(opts.show ?? argv.join(' '));
  try {
    return await t.jc.sess.dispatch(argv, t.io);
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    if ((e as Error)?.message === 'aborted') return 130;
    throw e;
  }
}

async function capture(t: TaskCtx, argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const io: ShellIO = { ...t.io, out: (s) => (out += s) };
  let code: number;
  try {
    code = await t.jc.sess.dispatch(argv, io);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  }
  return { code, out };
}

async function withAzLogin<T>(t: TaskCtx, sc: ServiceConnection, fn: () => Promise<T>, show = true): Promise<T> {
  const principal = spPrincipal(sc);
  const az = t.jc.sess.az;
  if (show) {
    t.log.cmd('az cloud set -n AzureCloud');
    t.log.cmd(`az login --service-principal -u *** ${sc.authScheme === 'WorkloadIdentityFederation' ? '--federated-token ***' : '--password=***'} --tenant *** --allow-no-subscriptions`);
    const sub = getState().subscriptions.find((x) => x.id === sc.subscriptionId);
    t.log.line(JSON.stringify([{ cloudName: 'AzureCloud', id: sc.subscriptionId, isDefault: true, name: sub?.displayName ?? sc.subscriptionId, state: 'Enabled', tenantId: getState().tenant.id, user: { name: '***', type: 'servicePrincipal' } }], null, 2));
    t.log.cmd(`az account set --subscription ${sc.subscriptionId}`);
  }
  const saved = { loggedIn: az.loggedIn, principal: az.principal, subscriptionId: az.subscriptionId };
  az.loggedIn = true;
  az.principal = principal;
  az.subscriptionId = sc.subscriptionId ?? getState().currentSubscriptionId;
  try {
    return await fn();
  } finally {
    if (show) t.log.cmd('az account clear');
    az.loggedIn = saved.loggedIn;
    az.principal = saved.principal;
    az.subscriptionId = saved.subscriptionId;
  }
}

async function runScript(t: TaskCtx, script: string, interpreter = '/usr/bin/bash'): Promise<number> {
  const file = `${TEMP}/${guid()}.sh`;
  t.jc.fs.writeFile(file, script);
  t.log.line('Generating script.');
  const shown = script.split('\n');
  if (shown.length <= 12) for (const l of shown) if (l.trim()) t.log.line(l);
  t.log.line('========================== Starting Command Output ===========================');
  t.log.cmd(`${interpreter} --noprofile --norc ${file}`);
  let code: number;
  try {
    code = await t.jc.sess.run(script, t.io);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  }
  t.log.flush();
  return code;
}

function failOnStderr(t: TaskCtx, code: number, flag: boolean, label: string): number {
  if (code !== 0) {
    t.log.error(`${label} exited with code '${code}'.`);
    return code;
  }
  if (flag && t.log.stderrSeen) {
    t.log.error(`${label} wrote one or more lines to the standard error stream.`);
    return 1;
  }
  return 0;
}

function scriptWorkdir(t: TaskCtx) {
  const wd = t.step.workingDirectory ?? inp(t, 'workingDirectory');
  if (wd) {
    const abs = resolvePath(t, wd);
    if (!t.jc.fs.isDir(abs)) throw new TaskError(`Directory '${abs}' does not exist or is not a directory.`);
    t.jc.sess.cwd = abs;
  }
}

const cmdLine: TaskImpl = async (t) => {
  scriptWorkdir(t);
  const script = t.step.script ?? inp(t, 'script', '') ?? '';
  const code = await runScript(t, script);
  return failOnStderr(t, code, t.step.failOnStderr || bool(inp(t, 'failOnStderr')), 'Bash');
};

const bashTask: TaskImpl = async (t) => {
  scriptWorkdir(t);
  const type = (inp(t, 'targetType', inp(t, 'filePath') ? 'filePath' : 'inline') ?? 'inline').toLowerCase();
  let code: number;
  if (type === 'filepath') {
    const fp = resolvePath(t, req(t, 'filePath'));
    if (!t.jc.fs.isFile(fp)) throw new TaskError(`Not found filePath: ${fp}`);
    t.log.cmd(`/usr/bin/bash ${fp} ${inp(t, 'arguments', '')}`);
    code = await sh(t, ['bash', fp, ...splitArgs(inp(t, 'arguments', '') ?? '')], { quiet: true });
  } else code = await runScript(t, t.step.script ?? inp(t, 'script', '') ?? '');
  return failOnStderr(t, code, t.step.failOnStderr || bool(inp(t, 'failOnStderr')), 'Bash');
};

const powershellTask: TaskImpl = async (t) => {
  t.log.warning('El simulador no incluye PowerShell en los agentes Linux: el script se ejecuta con bash (los comandos az funcionan igual).');
  return cmdLine(t);
};

const checkout: TaskImpl = async (t) => {
  const { rc } = t.jc;
  const repo = t.step.inputs.repository || 'self';
  if (repo !== 'self') throw new TaskError(`El simulador sólo admite checkout: self (repositorio '${repo}').`);
  const dir = `${W}/s`;
  t.log.line(`Syncing repository: ${rc.repoName} (Git)`);
  t.log.cmd('git version');
  t.log.line('git version 2.47.1');
  t.log.cmd(`git init "${dir}"`);
  t.log.line(`Initialized empty Git repository in ${dir}/.git/`);
  t.log.cmd(`git remote add origin ${orgUrl()}/${encodeURIComponent(rc.project.name)}/_git/${encodeURIComponent(rc.repoName)}`);
  t.log.cmd(`git -c http.extraheader="AUTHORIZATION: bearer ***" fetch --force --tags --prune --prune-tags --progress --no-recurse-submodules origin --depth=1 +${rc.run.sourceVersion}:refs/remotes/origin/${rc.run.sourceVersion}`);
  await pause(500, rc);
  t.jc.fs.writeTree(dir, rc.tree);
  t.log.line(`remote: Found ${Object.keys(rc.tree).length} objects to send. (12 ms)`);
  t.log.line(` * [new ref]         ${rc.run.sourceVersion} -> origin/${rc.run.sourceVersion}`);
  t.log.cmd(`git checkout --progress --force refs/remotes/origin/${rc.run.sourceVersion}`);
  t.log.line(`HEAD is now at ${rc.run.sourceVersion.slice(0, 7)} ${rc.run.commitMessage.split('\n')[0]}`);
  return 0;
};

function storeArtifact(t: TaskCtx, name: string, path: string) {
  const { run } = t.jc.rc;
  const abs = resolvePath(t, path);
  const fs = t.jc.fs;
  if (!fs.exists(abs)) throw new TaskError(`Path does not exist: ${abs}`);
  if (run.artifacts[name]) throw new TaskError(`Artifact ${name} already exists for build ${run.id}.`);
  const files = fs.isDir(abs) ? fs.snapshot(abs) : { [abs.split('/').pop()!]: fs.readFile(abs) };
  const n = Object.keys(files).length;
  t.log.line(`Artifact name input: ${name}`);
  t.log.line(`Uploading pipeline artifact from ${abs} for build #${run.id}`);
  t.log.line(`Uploading ${n} files`);
  t.log.line(`Uploaded ${n} out of ${n} files (${Math.max(1, Math.round(JSON.stringify(files).length / 1024))} KB)`);
  run.artifacts[name] = files;
  t.log.line(`Associated artifact ${Object.keys(run.artifacts).length} with build ${run.id}`);
  t.log.line('File upload succeed.');
  changed();
}

const publishPipelineArtifact: TaskImpl = (t) => {
  const path = inp(t, ['targetPath', 'path'], vget(t, 'Pipeline.Workspace'))!;
  const name = inp(t, ['artifact', 'artifactName'], 'drop')!;
  storeArtifact(t, name, path);
  return 0;
};

const publishBuildArtifacts: TaskImpl = (t) => {
  const path = inp(t, ['PathtoPublish', 'pathToPublish'], vget(t, 'Build.ArtifactStagingDirectory'))!;
  const name = inp(t, ['ArtifactName', 'artifactName'], 'drop')!;
  storeArtifact(t, name, path);
  return 0;
};

function downloadTo(t: TaskCtx, names: string[], target: (name: string) => string, patterns: string[]) {
  const { run } = t.jc.rc;
  if (!names.length) {
    t.log.line('No artifacts to download.');
    return;
  }
  for (const name of names) {
    const files = run.artifacts[name];
    if (!files) throw new TaskError(`Artifact ${name} was not found for build ${run.id}. ¿Se publicó en una fase anterior con publish / PublishPipelineArtifact?`);
    const dir = target(name);
    t.log.line(`Downloading artifact ${name} from: ${orgUrl()}/_apis/resources/Containers/${run.id}?itemPath=${name}`);
    t.jc.fs.mkdir(dir, true);
    let n = 0;
    for (const [rel, content] of Object.entries(files)) {
      if (!matchesContents(rel, patterns)) continue;
      const p = `${dir}/${rel}`;
      t.jc.fs.mkdir(p.split('/').slice(0, -1).join('/'), true);
      t.jc.fs.writeFile(p, content);
      n++;
    }
    t.log.line(`Downloaded ${n} files to ${dir}`);
  }
}

const downloadStep: TaskImpl = (t) => {
  const { run } = t.jc.rc;
  const source = t.step.inputs.source || 'current';
  if (source !== 'current') throw new TaskError(`El simulador sólo admite download: current (artefactos de esta misma ejecución).`);
  const names = t.step.inputs.artifact ? [str(t.step.inputs.artifact)] : Object.keys(run.artifacts);
  const ws = vget(t, 'Pipeline.Workspace');
  downloadTo(t, names, (n) => (t.step.inputs.path ? resolvePath(t, expandMacros(str(t.step.inputs.path), t.jc.vars)) : `${ws}/${n}`), t.step.inputs.patterns ? lines(t.step.inputs.patterns) : ['**']);
  return 0;
};

const downloadPipelineArtifact: TaskImpl = (t) => {
  const { run } = t.jc.rc;
  if ((inp(t, ['buildType', 'source'], 'current') ?? 'current') !== 'current') throw new TaskError('El simulador sólo admite artefactos de la ejecución actual (buildType: current).');
  const name = inp(t, ['artifact', 'artifactName']);
  const target = resolvePath(t, inp(t, ['targetPath', 'path', 'downloadPath'], vget(t, 'Pipeline.Workspace'))!);
  const patterns = lines(inp(t, ['patterns', 'itemPattern'], '**'));
  if (name) downloadTo(t, [name], () => target, patterns);
  else downloadTo(t, Object.keys(run.artifacts), (n) => `${target}/${n}`, patterns);
  return 0;
};

const downloadBuildArtifacts: TaskImpl = (t) => {
  const { run } = t.jc.rc;
  const name = inp(t, ['artifactName']);
  const target = resolvePath(t, inp(t, ['downloadPath'], vget(t, 'System.ArtifactsDirectory'))!);
  downloadTo(t, name ? [name] : Object.keys(run.artifacts), (n) => `${target}/${n}`, lines(inp(t, ['itemPattern'], '**')));
  return 0;
};

const archiveFiles: TaskImpl = (t) => {
  const fs = t.jc.fs;
  const root = resolvePath(t, inp(t, 'rootFolderOrFile', vget(t, 'Build.BinariesDirectory'))!);
  const includeRoot = bool(inp(t, 'includeRootFolder'), true);
  const type = (inp(t, 'archiveType', 'zip') ?? 'zip').toLowerCase();
  if (type !== 'zip') throw new TaskError(`El simulador sólo admite archiveType: zip (recibido: ${type}).`);
  const archive = resolvePath(t, inp(t, 'archiveFile', `${vget(t, 'Build.ArtifactStagingDirectory')}/${vget(t, 'Build.BuildId')}.zip`)!);
  if (!fs.exists(root)) throw new TaskError(`Not found rootFolderOrFile: ${root}`);
  const base = root.split('/').pop()!;
  let files: Record<string, string>;
  if (fs.isDir(root)) {
    const snap = fs.snapshot(root, (rel) => rel.startsWith('.git/') || rel === '.git');
    files = includeRoot ? Object.fromEntries(Object.entries(snap).map(([k, v]) => [`${base}/${k}`, v])) : snap;
  } else files = { [base]: fs.readFile(root) };
  if (fs.exists(archive) && bool(inp(t, 'replaceExistingArchive'), true)) {
    t.log.line(`removing existing archive file before creation: ${archive}`);
    fs.rm(archive);
  }
  fs.mkdir(archive.split('/').slice(0, -1).join('/'), true);
  t.log.cmd(`/usr/bin/zip -r ${archive} ${includeRoot ? base : '.'}`);
  const names = Object.keys(files);
  for (const n of names.slice(0, 40)) t.log.line(`  adding: ${n} (deflated ${20 + (n.length * 7) % 60}%)`);
  if (names.length > 40) t.log.line(`  ... y ${names.length - 40} ficheros más`);
  fs.writeFile(archive, makeZip(files));
  t.log.line(`Archive file: ${archive} (${names.length} ficheros)`);
  return 0;
};

const extractFiles: TaskImpl = (t) => {
  const fs = t.jc.fs;
  const patterns = lines(inp(t, 'archiveFilePatterns', '**/*.zip'));
  const dest = resolvePath(t, req(t, 'destinationFolder'));
  if (bool(inp(t, 'cleanDestinationFolder'), true) && fs.exists(dest)) fs.rm(dest, true);
  fs.mkdir(dest, true);
  const found = patterns.flatMap((p) => findMatches(fs, p, vget(t, 'System.DefaultWorkingDirectory'), { files: true }));
  if (!found.length) throw new TaskError(`No matching files were found with search pattern: ${patterns.join(', ')}`);
  for (const f of found) {
    const z = readZip(fs.readFile(f));
    if (!z) throw new TaskError(`${f} no es un archivo zip válido.`);
    t.log.cmd(`/usr/bin/unzip -o ${f} -d ${dest}`);
    fs.writeTree(dest, z);
    for (const n of Object.keys(z).slice(0, 30)) t.log.line(`  inflating: ${dest}/${n}`);
  }
  return 0;
};

const copyFiles: TaskImpl = (t) => {
  const fs = t.jc.fs;
  const src = resolvePath(t, inp(t, ['SourceFolder', 'sourceFolder'], vget(t, 'Build.SourcesDirectory'))!);
  const contents = lines(inp(t, ['Contents', 'contents'], '**'));
  const target = resolvePath(t, req(t, ['TargetFolder', 'targetFolder']));
  const flatten = bool(inp(t, 'flattenFolders'));
  if (bool(inp(t, 'CleanTargetFolder')) && fs.exists(target)) {
    t.log.line(`Cleaning target folder: ${target}`);
    fs.rm(target, true);
  }
  if (!fs.isDir(src)) throw new TaskError(`Source folder doesn't exist: ${src}`);
  const all = walk(fs, src).filter((e) => !e.dir && !e.rel.startsWith('.git/'));
  const sel = all.filter((e) => matchesContents(e.rel, contents));
  t.log.line(`found ${sel.length} files`);
  for (const e of sel) {
    const dst = `${target}/${flatten ? e.rel.split('/').pop() : e.rel}`;
    fs.mkdir(dst.split('/').slice(0, -1).join('/'), true);
    t.log.line(`Copying ${src}/${e.rel} to ${dst}`);
    fs.writeFile(dst, fs.readFile(`${src}/${e.rel}`));
  }
  return 0;
};

const deleteFiles: TaskImpl = (t) => {
  const fs = t.jc.fs;
  const src = resolvePath(t, inp(t, 'SourceFolder', vget(t, 'Build.SourcesDirectory'))!);
  const contents = lines(req(t, 'Contents'));
  for (const e of walk(fs, src).reverse()) {
    if (matchesContents(e.rel, contents) && fs.exists(`${src}/${e.rel}`)) {
      t.log.line(`Deleting ${src}/${e.rel}`);
      fs.rm(`${src}/${e.rel}`, true);
    }
  }
  return 0;
};

const toolInstaller =
  (tool: string, input: string[], def: string): TaskImpl =>
  (t) => {
    const spec = inp(t, input, def)!.replace(/^v/, '');
    const KNOWN: Record<string, string> = { '18': '18.20.5', '20': '20.18.1', '22': '22.11.0', '3.10': '3.10.15', '3.11': '3.11.10', '3.12': '3.12.7', '3.13': '3.13.0', '1.9': '1.9.8', '1.32': '1.32.6' };
    const key = spec.replace(/\.x$/, '');
    const ver = /^\d+\.\d+\.\d+$/.test(spec) ? spec : KNOWN[key] ?? `${key}.0`;
    t.log.line(`Found tool in cache: ${tool} ${ver} x64`);
    t.log.line(`Prepending PATH environment variable with directory: /opt/hostedtoolcache/${tool}/${ver}/x64/bin`);
    return 0;
  };

const npmTask: TaskImpl = async (t) => {
  const command = (inp(t, 'command', 'install') ?? 'install').toLowerCase();
  const wd = inp(t, 'workingDir');
  if (wd) {
    const abs = resolvePath(t, wd);
    if (!t.jc.fs.isDir(abs)) throw new TaskError(`Not found workingDir: ${abs}`);
    t.jc.sess.cwd = abs;
  }
  const args = command === 'custom' ? splitArgs(req(t, 'customCommand')) : command === 'ci' ? ['ci'] : command === 'publish' ? ['publish'] : ['install', ...splitArgs(inp(t, 'arguments', '') ?? '')];
  const code = await sh(t, ['npm', ...args], { show: `/opt/hostedtoolcache/node/20.18.1/x64/bin/npm ${args.join(' ')}` });
  t.log.flush();
  if (code !== 0) t.log.error(`Error: Npm failed with return code: ${code}`);
  return code;
};

const azureCli: TaskImpl = async (t) => {
  const sc = getSc(t, ['azureSubscription', 'connectedServiceNameARM'], 'azurerm')!;
  const type = (inp(t, 'scriptType', 'bash') ?? 'bash').toLowerCase();
  if (type !== 'bash') t.log.warning(`scriptType '${type}': el simulador ejecuta el script con bash.`);
  const loc = (inp(t, 'scriptLocation', inp(t, 'inlineScript') !== undefined ? 'inlineScript' : 'scriptPath') ?? '').toLowerCase();
  scriptWorkdir(t);
  return withAzLogin(t, sc, async () => {
    if (bool(inp(t, 'addSpnToEnvironment'))) {
      for (const [k, v] of Object.entries({ servicePrincipalId: sc.servicePrincipalAppId ?? '', tenantId: getState().tenant.id, idToken: 'eyJ0eXAi***' })) {
        t.jc.sess.env[k] = v;
        t.jc.sess.exported.add(k);
      }
    }
    let code: number;
    if (loc === 'scriptpath') {
      const fp = resolvePath(t, req(t, 'scriptPath'));
      if (!t.jc.fs.isFile(fp)) throw new TaskError(`Not found scriptPath: ${fp}`);
      t.log.cmd(`/usr/bin/bash ${fp} ${inp(t, ['arguments', 'scriptArguments'], '')}`);
      code = await sh(t, ['bash', fp, ...splitArgs(inp(t, ['arguments', 'scriptArguments'], '') ?? '')], { quiet: true });
    } else {
      t.log.cmd(`/usr/bin/bash ${TEMP}/azureclitaskscript${Date.now()}.sh`);
      try {
        code = await t.jc.sess.run(inp(t, 'inlineScript', '') ?? '', t.io);
      } catch (e) {
        if (e instanceof ExitSignal) code = e.code;
        else throw e;
      }
    }
    t.log.flush();
    if (code !== 0) t.log.error(`Script failed with exit code: ${code}`);
    else if (bool(inp(t, 'failOnStandardError')) && t.log.stderrSeen) {
      t.log.error('Script has output to stderr. Failing as failOnStdErr is set to true.');
      return 1;
    }
    return code;
  });
};

function findSite(t: TaskCtx, sc: ServiceConnection, principal: PrincipalRef, appName: string, rg?: string): Resource {
  const site = getState().resources.find((r) => ciEq(r.type, 'Microsoft.Web/sites') && ciEq(r.name, appName) && r.subscriptionId === sc.subscriptionId && (!rg || ciEq(r.resourceGroup, rg)));
  if (!site || !canRead(principal, site.id)) {
    throw new TaskError(`Error: Resource '${appName}' doesn't exist. Resource should exist before deployment.${site ? `\n(La App Service existe, pero la identidad de la conexión '${sc.name}' no tiene permisos sobre ella: revisa el ámbito/rol de la conexión de servicio.)` : ''}`);
  }
  void t;
  return site;
}

function siteTarget(site: Resource, slot: string | undefined): Resource {
  if (!slot || slot.toLowerCase() === 'production') return site;
  const r = findResource(`${site.id}/slots/${slot}`);
  if (!r) throw new TaskError(`Error: Deployment slot '${slot}' doesn't exist on App Service '${site.name}'.`);
  return r;
}

function loadPackage(t: TaskCtx, pattern: string): Record<string, string> {
  const fs = t.jc.fs;
  const found = findMatches(fs, pattern, vget(t, 'System.DefaultWorkingDirectory'));
  if (!found.length) throw new TaskError(`Error: No package found with specified pattern: ${pattern}<br/>Check if the package mentioned in the task is published as an artifact in the build or a previous stage and downloaded in the current job.`);
  if (found.length > 1) throw new TaskError(`Error: More than one package matched with specified pattern: ${pattern}. Please restrain the search pattern.`);
  const p = found[0];
  if (fs.isDir(p)) return fs.snapshot(p, (rel) => rel.startsWith('.git/'));
  const z = readZip(fs.readFile(p));
  if (!z) throw new TaskError(`Error: Invalid App Service package or folder path provided: ${p}`);
  return z;
}

const webAppDeploy =
  (flavor: 'webapp' | 'rm' | 'function' | 'container'): TaskImpl =>
  async (t) => {
    const sc = getSc(t, ['azureSubscription', 'ConnectedServiceName', 'connectedServiceNameARM'], 'azurerm')!;
    const principal = spPrincipal(sc);
    const appName = req(t, ['appName', 'WebAppName']);
    const rg = inp(t, ['resourceGroupName', 'ResourceGroupName']);
    const site = findSite(t, sc, principal, appName, rg);
    const slotFlag = bool(inp(t, ['deployToSlotOrASE', 'DeployToSlotOrASEFlag']));
    const target = siteTarget(site, slotFlag ? inp(t, ['slotName', 'SlotName'], 'production') : undefined);
    t.log.line(`Got service connection details for Azure App Service:'${appName}'`);
    const appType = (inp(t, ['appType', 'WebAppKind'], '') ?? '').toLowerCase();
    if (flavor === 'container' || appType.includes('container')) {
      const image = lines(req(t, ['containers', 'imageName', 'DockerNamespace'])).join(' ');
      setSiteConfig(target.id, { linuxFxVersion: `DOCKER|${image}` }, principal);
      t.log.line(`Updating App Service configuration settings. Data: {"linuxFxVersion":"DOCKER|${image}"}`);
      t.log.line('Updated App Service configuration settings.');
      t.log.line(`App Service Application URL: https://${target.properties.defaultHostName}`);
      return 0;
    }
    const pattern = inp(t, ['package', 'packageForLinux', 'Package'], `${vget(t, 'System.DefaultWorkingDirectory')}/**/*.zip`)!;
    const files = loadPackage(t, pattern);
    const stack = inp(t, ['runtimeStack', 'RuntimeStack']);
    const startup = inp(t, ['startUpCommand', 'StartupCommand']);
    if (stack || startup) setSiteConfig(target.id, { ...(stack ? { linuxFxVersion: stack } : {}), ...(startup ? { appCommandLine: startup } : {}) }, principal);
    const settings = inp(t, ['appSettings', 'AppSettings']);
    if (settings) {
      const kv = parseOverrides(settings);
      setAppSettings(target.id, kv, {}, principal);
      t.log.line(`Updating App Service Application settings. Data: ${JSON.stringify(Object.fromEntries(Object.keys(kv).map((k) => [k, '***'])))}`);
      t.log.line('Updated App Service Application settings.');
    }
    if (!files['web.config'] && Object.keys(files).some((f) => f.includes('/')) && !Object.keys(files).some((f) => !f.includes('/'))) {
      t.log.warning('Todos los ficheros del paquete están dentro de una carpeta: la app puede no arrancar. ¿Usaste includeRootFolder: true en ArchiveFiles?');
    }
    t.log.line('Package deployment using ZIP Deploy initiated.');
    const r = await deployContent(target.id, files, { principal, deployer: 'VSTS', message: `Azure Pipelines: ${t.jc.rc.run.pipelineName} #${t.jc.rc.run.buildNumber}` });
    t.log.line(`Deploy logs can be viewed at https://${site.name}.scm.azurewebsites.net/api/deployments/${r.id}/log`);
    t.log.line(`Successfully deployed web package to App Service.`);
    const url = `https://${target.properties.defaultHostName}`;
    setVar(t.jc.vars, { name: 'AppServiceApplicationUrl', value: url, isSecret: false });
    t.log.line(`App Service Application URL: ${url}`);
    void flavor;
    return 0;
  };

const appServiceManage: TaskImpl = async (t) => {
  const sc = getSc(t, ['azureSubscription', 'ConnectedServiceName'], 'azurerm')!;
  const principal = spPrincipal(sc);
  const action = (inp(t, 'Action', 'Swap Slots') ?? '').toLowerCase();
  const site = findSite(t, sc, principal, req(t, 'WebAppName'), inp(t, 'ResourceGroupName'));
  if (action === 'swap slots') {
    const source = req(t, 'SourceSlot');
    const toProd = bool(inp(t, 'SwapWithProduction'), true);
    const target = toProd ? 'production' : req(t, 'TargetSlot');
    t.log.line(`Swapping App Service '${site.name}' slots - '${source}' and '${target}'`);
    await swapSlots(site.id, source, target, principal);
    t.log.line(`Swapped App Service '${site.name}' slots - '${source}' and '${target}'`);
    return 0;
  }
  const map: Record<string, 'Running' | 'Stopped' | 'Restart'> = { 'start azure app service': 'Running', 'stop azure app service': 'Stopped', 'restart azure app service': 'Restart' };
  if (!map[action]) throw new TaskError(`Acción no soportada por el simulador: ${action}`);
  await setSiteState(site.id, map[action], principal);
  t.log.line(`App Service '${site.name}': ${action} completado.`);
  return 0;
};

const appServiceSettings: TaskImpl = (t) => {
  const sc = getSc(t, ['azureSubscription', 'ConnectedServiceName'], 'azurerm')!;
  const principal = spPrincipal(sc);
  const site = findSite(t, sc, principal, req(t, 'appName'), inp(t, 'resourceGroupName'));
  const target = siteTarget(site, inp(t, 'slotName'));
  const raw = inp(t, 'appSettings');
  if (raw) {
    let arr: { name: string; value: string; slotSetting?: boolean }[];
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new TaskError('appSettings debe ser un array JSON: [{"name":"CLAVE","value":"valor","slotSetting":false}]');
    }
    const normal: Record<string, string> = {};
    const sticky: Record<string, string> = {};
    for (const x of arr) (x.slotSetting ? sticky : normal)[x.name] = str(x.value);
    setAppSettings(target.id, normal, sticky, principal);
    t.log.line(`Updated App Service Application settings: ${arr.map((x) => x.name).join(', ')}`);
  }
  return 0;
};

const armDeploy: TaskImpl = async (t) => {
  const sc = getSc(t, ['azureResourceManagerConnection', 'ConnectedServiceName', 'azureSubscription'], 'azurerm')!;
  const scope = inp(t, 'deploymentScope', 'Resource Group')!;
  if (!/resource group/i.test(scope)) throw new TaskError(`El simulador sólo admite deploymentScope: 'Resource Group' (recibido: ${scope}).`);
  const action = inp(t, 'action', 'Create Or Update Resource Group')!;
  const rg = req(t, 'resourceGroupName');
  return withAzLogin(t, sc, async () => {
    const sub = inp(t, 'subscriptionId', sc.subscriptionId)!;
    t.jc.sess.az.subscriptionId = sub;
    if (/delete/i.test(action)) {
      t.log.line(`Deleting resource group: ${rg}`);
      const r = await capture(t, ['az', 'group', 'delete', '-n', rg, '--yes']);
      return r.code;
    }
    const exists = getState().resourceGroups.some((g) => ciEq(g.name, rg) && g.subscriptionId === sub);
    if (!exists) {
      const loc = inp(t, 'location');
      if (!loc) throw new TaskError(`Resource group ${rg} does not exist; location is required to create it.`);
      t.log.line(`Creating resource Group: ${rg}`);
      const r = await capture(t, ['az', 'group', 'create', '-n', rg, '-l', loc]);
      if (r.code !== 0) return r.code;
    }
    const tmpl = req(t, 'csmFile');
    const tfound = findMatches(t.jc.fs, tmpl, vget(t, 'System.DefaultWorkingDirectory'), { files: true });
    if (!tfound.length) throw new TaskError(`Could not find any file matching the template file pattern: ${tmpl}`);
    const mode = inp(t, 'deploymentMode', 'Incremental')!;
    const name = inp(t, 'deploymentName', `${tfound[0].split('/').pop()!.replace(/\.(json|bicep)$/, '')}-${Date.now().toString().slice(-8)}`)!;
    const argv = ['az', 'deployment', 'group', mode === 'Validation' ? 'validate' : 'create', '-g', rg, '-f', tfound[0], '-o', 'json'];
    if (mode !== 'Validation') argv.push('-n', name, '--mode', mode);
    const pf = inp(t, 'csmParametersFile');
    if (pf) {
      const pfound = findMatches(t.jc.fs, pf, vget(t, 'System.DefaultWorkingDirectory'), { files: true });
      if (!pfound.length) throw new TaskError(`Could not find any file matching the parameters file pattern: ${pf}`);
      argv.push('-p', `@${pfound[0]}`);
    }
    for (const [k, v] of Object.entries(parseOverrides(inp(t, 'overrideParameters', '') ?? ''))) argv.push('-p', `${k}=${v}`);
    t.log.line('Starting Deployment.');
    t.log.line(`Deployment name is ${name}`);
    const r = await capture(t, argv);
    t.log.flush();
    if (r.code !== 0) {
      t.log.error('Check out the troubleshooting guide to see if your issue is addressed: https://docs.microsoft.com/en-us/azure/devops/pipelines/tasks/deploy/azure-resource-group-deployment#troubleshooting');
      t.log.error('Task failed while creating or updating the template deployment.');
      return r.code;
    }
    t.log.line(mode === 'Validation' ? 'Template validation succeeded.' : 'Successfully deployed the template.');
    const outVar = inp(t, 'deploymentOutputs');
    if (outVar) {
      try {
        const outputs = JSON.parse(r.out).properties?.outputs ?? {};
        setVar(t.jc.vars, { name: outVar, value: JSON.stringify(outputs), isSecret: false });
        t.log.line(`Updated output variable '${outVar}', which contains the outputs section of the current deployment object in string format.`);
      } catch {
        /* sin salidas */
      }
    }
    return 0;
  });
};

const keyVaultTask: TaskImpl = (t) => {
  const sc = getSc(t, ['azureSubscription', 'ConnectedServiceName'], 'azurerm')!;
  const principal = spPrincipal(sc);
  const vault = req(t, 'KeyVaultName');
  const filter = inp(t, 'SecretsFilter', '*')!;
  t.log.line(`SubscriptionId: ${sc.subscriptionId}.`);
  t.log.line(`Key vault name: ${vault}.`);
  t.log.line('Downloading secrets using: ' + filter + '.');
  let names: string[];
  try {
    names = filter.trim() === '*' ? listSecrets(vault, principal).map((x: any) => String(x.name ?? x.id.split('/').pop())) : filter.split(',').map((x) => x.trim()).filter(Boolean);
  } catch (e: any) {
    throw new TaskError(`Get secrets failed. Error: ${e?.message ?? e}. Ensure the service principal has 'Get' and 'List' permissions on the Key Vault '${vault}' (rol "Key Vault Secrets User" o directiva de acceso).`);
  }
  t.log.line(`Number of secrets found in ${vault}: ${names.length}`);
  for (const n of names) {
    try {
      const sec = getSecret(vault, n, { principal });
      setVar(t.jc.vars, { name: n, value: String(sec.value), isSecret: true });
      if (sec.value) t.jc.rc.secrets.add(String(sec.value));
    } catch (e: any) {
      throw new TaskError(`${n}: "${e?.message ?? e}". The specified Azure service connection needs to have Get, List secret management permissions on the selected key vault. To set these permissions, download the ProvisionKeyVaultPermissions.ps1 script from build/release logs and execute it, or set them from the Azure portal.`);
    }
  }
  t.log.line(`Downloading secret value for: ${names.join(', ')}.`);
  return 0;
};

function registryOf(sc: ServiceConnection): Resource {
  const reg = sc.registryId ? findResource(sc.registryId) : undefined;
  if (!reg) throw new TaskError(`The container registry for service connection '${sc.name}' no longer exists.`);
  return reg;
}

const dockerTask: TaskImpl = async (t) => {
  const command = (inp(t, 'command', 'buildAndPush') ?? 'buildAndPush').toLowerCase();
  const sc = getSc(t, SC_INPUTS.dockerregistry, 'dockerregistry', false);
  const reg = sc ? registryOf(sc) : null;
  const principal = sc ? spPrincipal(sc) : null;
  const server = reg?.properties.loginServer as string | undefined;
  const repo = inp(t, ['repository', 'imageName'], '')!;
  const tags = lines(inp(t, 'tags', vget(t, 'Build.BuildId')));
  if (command === 'login') {
    if (!sc) throw new TaskError('Input required: containerRegistry');
    t.log.cmd(`/usr/bin/docker login -u *** -p *** ${server}`);
    t.log.line('Login Succeeded');
    return 0;
  }
  if (command === 'logout') {
    t.log.cmd(`/usr/bin/docker logout ${server ?? ''}`);
    return 0;
  }
  if (!repo) throw new TaskError('Input required: repository');
  if (/[A-Z]/.test(repo)) throw new TaskError(`invalid reference format: repository name (${repo}) must be lowercase`);
  const full = server ? `${server}/${repo}` : repo;
  if (command === 'build' || command === 'buildandpush') {
    const dfPat = inp(t, 'Dockerfile', '**/Dockerfile')!;
    const dfs = findMatches(t.jc.fs, dfPat, vget(t, 'Build.SourcesDirectory'), { files: true });
    if (!dfs.length) throw new TaskError(`Unhandled: No Dockerfile matching  ${resolvePath(t, dfPat)}  was found.`);
    const df = dfs[0];
    const bc = inp(t, 'buildContext', '**')!;
    const ctxDir = bc === '**' ? df.split('/').slice(0, -1).join('/') : resolvePath(t, bc);
    t.log.cmd(`/usr/bin/docker build -f ${df} ${tags.map((x) => `-t ${full}:${x}`).join(' ')} ${inp(t, 'arguments', '')} ${ctxDir}`.replace(/\s+/g, ' '));
    try {
      const img = buildImage({ fs: t.jc.fs, contextDir: ctxDir, dockerfile: df, principal, acrLogins: server ? [server] : [], onStep: (l) => t.log.line(l) });
      t.jc.built.set(full, { img, tags });
      for (const tag of tags) t.log.line(`Successfully tagged ${full}:${tag}`);
    } catch (e) {
      if (e instanceof BuildError) {
        t.log.error(e.message);
        t.log.error("The process '/usr/bin/docker' failed with exit code 1");
        return 1;
      }
      throw e;
    }
  }
  if (command === 'push' || command === 'buildandpush') {
    if (!reg || !server) throw new TaskError('Docker registry service connection not specified (containerRegistry).');
    const b = t.jc.built.get(full);
    if (!b) throw new TaskError(`An image does not exist locally with the tag: ${full}. Construye la imagen antes (command: build) en este mismo job.`);
    for (const tag of tags) {
      t.log.cmd(`/usr/bin/docker push ${full}:${tag}`);
      t.log.line(`The push refers to repository [${full}]`);
      if (!canPush(reg, principal)) {
        t.log.line('unauthorized: authentication required, visit https://aka.ms/acr/authorization for more information.');
        t.log.error("The process '/usr/bin/docker' failed with exit code 1");
        return 1;
      }
      await pause(700, t.jc.rc);
      const digest = pushImage(reg, repo, tag, { files: b.img.files, env: b.img.env, exposed: b.img.exposed, cmd: b.img.cmd, size: b.img.size, base: b.img.base });
      t.log.line(`${tag}: digest: ${digest} size: ${1500 + (b.img.size % 900)}`);
    }
  }
  return 0;
};

function clusterFor(t: TaskCtx, legacyLabels: boolean): Resource {
  const ct = (inp(t, 'connectionType', legacyLabels ? 'Kubernetes Service Connection' : 'kubernetesServiceConnection') ?? '').toLowerCase().replace(/\s+/g, '');
  let cluster: Resource | undefined;
  if (ct === 'azureresourcemanager') {
    const sc = getSc(t, ['azureSubscriptionEndpoint', 'azureSubscriptionConnection', 'azureSubscription'], 'azurerm')!;
    const principal = spPrincipal(sc);
    const rg = req(t, 'azureResourceGroup');
    const name = req(t, 'kubernetesCluster');
    cluster = getState().resources.find((r) => ciEq(r.type, 'Microsoft.ContainerService/managedClusters') && ciEq(r.name, name) && ciEq(r.resourceGroup, rg) && r.subscriptionId === sc.subscriptionId);
    if (!cluster) throw new TaskError(`Could not fetch the cluster credentials: cluster '${name}' not found in resource group '${rg}'.`);
    if (!hasPermission(principal, 'Microsoft.ContainerService/managedClusters/listClusterUserCredential/action', cluster.id)) {
      throw new TaskError(`AuthorizationFailed: The client '${principal.name}' does not have authorization to perform action 'Microsoft.ContainerService/managedClusters/listClusterUserCredential/action' over scope '${cluster.id}'.`);
    }
  } else if (ct === 'none') {
    throw new TaskError('connectionType: None no está soportado en el simulador; usa una conexión de servicio de Kubernetes o de Azure Resource Manager.');
  } else {
    const sc = getSc(t, SC_INPUTS.kubernetes, 'kubernetes')!;
    cluster = sc.clusterId ? findResource(sc.clusterId) : undefined;
    if (!cluster) throw new TaskError(`Unable to connect to the server: dial tcp: lookup ${sc.name}: no such host (el clúster de la conexión de servicio ya no existe).`);
  }
  if (!clusterRunning(cluster)) throw new TaskError(`Unable to connect to the server: dial tcp ${cluster.properties.fqdn}:443: i/o timeout (¿el clúster está detenido?).`);
  return cluster;
}

const KUBECTL_BIN = '/opt/hostedtoolcache/kubectl/1.32.6/x64/kubectl';

async function kube(t: TaskCtx, cluster: Resource, args: string[], ns: string): Promise<number> {
  t.log.cmd(`${KUBECTL_BIN} ${args.join(' ')}${ns && !args.includes('-n') && !args.includes('--namespace') ? ` --namespace ${ns}` : ''}`);
  const code = await runKubectlAgainst(cluster, args, { sess: t.jc.sess, io: t.io }, ns);
  t.log.flush();
  return code;
}

function substituteImages(text: string, containers: string[]): string {
  let out = text;
  for (const img of containers) {
    const at = img.lastIndexOf('@');
    const base = at > 0 ? img.slice(0, at) : img.lastIndexOf(':') > img.lastIndexOf('/') ? img.slice(0, img.lastIndexOf(':')) : img;
    const re = new RegExp(`^(\\s*-?\\s*image:\\s*["']?)${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[:@][^\\s"']*)?(["']?\\s*)$`, 'gm');
    out = out.replace(re, `$1${img}$2`);
  }
  return out;
}

const k8sManifest: TaskImpl = async (t) => {
  const action = (inp(t, 'action', 'deploy') ?? 'deploy').toLowerCase();
  const cluster = clusterFor(t, false);
  const ns = inp(t, 'namespace', 'default')!;
  const fs = t.jc.fs;
  const manifests = lines(req(t, 'manifests')).flatMap((p) => {
    const f = findMatches(fs, p, vget(t, 'System.DefaultWorkingDirectory'), { files: true });
    if (!f.length) throw new TaskError(`No files matched the pattern: ${p}`);
    return f;
  });
  if (action === 'delete') {
    for (const m of manifests) if ((await kube(t, cluster, ['delete', '-f', m, '--ignore-not-found'], ns)) !== 0) return 1;
    return 0;
  }
  if (action !== 'deploy') throw new TaskError(`El simulador sólo admite action: deploy o delete (recibido: ${action}).`);
  const containers = lines(inp(t, 'containers', ''));
  const dir = `${TEMP}/Manifests_${Date.now()}`;
  fs.mkdir(dir, true);
  const deployments: string[] = [];
  for (const m of manifests) {
    const text = substituteImages(fs.readFile(m), containers);
    const out = `${dir}/${m.split('/').pop()}`;
    fs.writeFile(out, text);
    try {
      for (const doc of loadAll(text) as any[]) if (doc?.kind === 'Deployment' && doc.metadata?.name) deployments.push(doc.metadata.name);
    } catch {
      /* kubectl informará del error */
    }
    if ((await kube(t, cluster, ['apply', '-f', out], ns)) !== 0) return 1;
  }
  for (const d of deployments) {
    const code = await kube(t, cluster, ['rollout', 'status', `Deployment/${d}`, '--timeout', `${Math.max(30, Math.round(60 * Math.max(speedFactor(), 0.5)))}s`], ns);
    if (code !== 0) {
      t.log.error(`Rollout status check failed for Deployment/${d}. Revisa los pods con kubectl get pods y kubectl describe pod (¿ImagePullBackOff? ¿el clúster tiene permiso AcrPull sobre el registro?).`);
      return 1;
    }
  }
  return 0;
};

const k8sTask: TaskImpl = async (t) => {
  const cluster = clusterFor(t, true);
  const ns = inp(t, 'namespace', '')!;
  const command = req(t, 'command');
  const args = [command];
  if (bool(inp(t, 'useConfigurationFile'))) {
    const cfg = req(t, ['configuration', 'configurationPath']);
    const found = findMatches(t.jc.fs, cfg, vget(t, 'System.DefaultWorkingDirectory'));
    if (!found.length) throw new TaskError(`Not found configuration: ${cfg}`);
    args.push('-f', found[0]);
  }
  args.push(...splitArgs(inp(t, 'arguments', '') ?? ''));
  return kube(t, cluster, args, ns || 'default');
};

const TF_BIN = '/opt/hostedtoolcache/terraform/1.9.8/x64/terraform';

const terraformTask: TaskImpl = async (t) => {
  const provider = (inp(t, 'provider', 'azurerm') ?? 'azurerm').toLowerCase();
  if (provider !== 'azurerm') throw new TaskError(`El simulador sólo admite provider: azurerm (recibido: ${provider}).`);
  const command = (inp(t, 'command', 'init') ?? 'init').toLowerCase();
  const wd = resolvePath(t, inp(t, 'workingDirectory', vget(t, 'System.DefaultWorkingDirectory'))!);
  if (!t.jc.fs.isDir(wd)) throw new TaskError(`Not found workingDirectory: ${wd}`);
  t.jc.sess.cwd = wd;
  const options = splitArgs(inp(t, ['commandOptions', 'args'], '') ?? '');
  let sc: ServiceConnection | null;
  const args: string[] = [];
  if (command === 'init') {
    sc = getSc(t, ['backendServiceArm', 'backendAzureRmServiceConnection'], 'azurerm', false);
    args.push('init');
    const be: Record<string, string | undefined> = {
      storage_account_name: inp(t, 'backendAzureRmStorageAccountName'),
      container_name: inp(t, 'backendAzureRmContainerName'),
      key: inp(t, 'backendAzureRmKey'),
      resource_group_name: inp(t, 'backendAzureRmResourceGroupName'),
    };
    for (const [k, v] of Object.entries(be)) if (v) args.push(`-backend-config=${k}=${v}`);
  } else {
    sc = getSc(t, ['environmentServiceNameAzureRM', 'environmentServiceName', 'environmentAzureRmServiceConnection'], 'azurerm', command !== 'validate' && command !== 'custom');
    if (command === 'custom') args.push(...splitArgs(req(t, 'customCommand')));
    else args.push(command);
    if ((command === 'apply' || command === 'destroy') && !options.includes('-auto-approve')) args.push('-auto-approve');
  }
  args.push(...options);
  if (!args.includes('-no-color')) args.push('-no-color');
  const exec = async () => {
    if (sc) {
      t.jc.sess.env.ARM_SUBSCRIPTION_ID = sc.subscriptionId ?? '';
      t.jc.sess.env.ARM_TENANT_ID = getState().tenant.id;
      t.jc.sess.exported.add('ARM_SUBSCRIPTION_ID');
      t.jc.sess.exported.add('ARM_TENANT_ID');
    }
    const code = await sh(t, ['terraform', ...args], { show: `${TF_BIN} ${args.join(' ')}` });
    t.log.flush();
    if (code !== 0) t.log.error(`Error: The process '${TF_BIN}' failed with exit code ${code}`);
    return code;
  };
  return sc ? withAzLogin(t, sc, exec, false) : exec();
};

const noopTask =
  (msg: string): TaskImpl =>
  (t) => {
    t.log.line(msg);
    return 0;
  };

const TASKS: Record<string, TaskImpl> = {
  cmdline: cmdLine,
  bash: bashTask,
  shellscript: bashTask,
  powershell: powershellTask,
  checkout,
  publishpipelineartifact: publishPipelineArtifact,
  publishbuildartifacts: publishBuildArtifacts,
  downloadpipelineartifact: downloadPipelineArtifact,
  downloadbuildartifacts: downloadBuildArtifacts,
  archivefiles: archiveFiles,
  extractfiles: extractFiles,
  copyfiles: copyFiles,
  deletefiles: deleteFiles,
  nodetool: toolInstaller('node', ['versionSpec', 'version'], '20.x'),
  usenode: toolInstaller('node', ['version', 'versionSpec'], '20.x'),
  usepythonversion: toolInstaller('Python', ['versionSpec'], '3.12'),
  terraforminstaller: toolInstaller('terraform', ['terraformVersion'], '1.9.8'),
  kubectlinstaller: toolInstaller('kubectl', ['kubectlVersion'], '1.32.6'),
  npm: npmTask,
  azurecli: azureCli,
  azurewebapp: webAppDeploy('webapp'),
  azurermwebappdeployment: webAppDeploy('rm'),
  azurefunctionapp: webAppDeploy('function'),
  azurewebappcontainer: webAppDeploy('container'),
  azureappservicemanage: appServiceManage,
  azureappservicesettings: appServiceSettings,
  azureresourcemanagertemplatedeployment: armDeploy,
  azurekeyvault: keyVaultTask,
  docker: dockerTask,
  kubernetesmanifest: k8sManifest,
  kubernetes: k8sTask,
  terraformtaskv4: terraformTask,
  terraformtaskv3: terraformTask,
  terraformtask: terraformTask,
  terraformcli: terraformTask,
  publishtestresults: noopTask('Publishing test results... (el simulador registra los resultados de las pruebas del paso anterior)'),
  publishcodecoverageresults: noopTask('Publishing code coverage results... (simulado)'),
  cache: noopTask('Cache miss. (la caché del simulador está siempre vacía: el paso continúa)'),
};

const UNSUPPORTED = ['dotnetcorecli', 'maven', 'gradle', 'vsbuild', 'vstest', 'nuget', 'nugetcommand', 'azurepowershell', 'sqlazuredacpacdeployment', 'helmdeploy', 'helminstaller', 'azurefileCopy', 'gulp', 'grunt', 'xcode'];

function taskImpl(step: NStep): TaskImpl | undefined {
  if (step.kind === 'checkout') return checkout;
  if (step.kind === 'publish') return publishPipelineArtifact;
  if (step.kind === 'download') return downloadStep;
  return TASKS[step.task.toLowerCase()];
}

// ---------------------------------------------------------------- validación previa

function validatePlan(rc: RunCtx) {
  const base = staticVars(rc);
  for (const st of rc.plan.stages) {
    for (const j of st.jobs) {
      const m: VarMap = new Map(base);
      for (const v of [...st.variables, ...j.variables]) setVar(m, v);
      for (const s of j.steps) {
        if (s.kind === 'task' && !TASKS[s.task.toLowerCase()]) {
          if (UNSUPPORTED.includes(s.task.toLowerCase())) continue;
          throw new PipelineError(`A task is missing. The pipeline references a task called '${s.task}'. This usually indicates the task isn't installed, and you may be able to install it from the Marketplace: https://marketplace.visualstudio.com. (If you've already installed the task, check the version.)`);
        }
        for (const [type, names] of Object.entries(SC_INPUTS)) {
          for (const n of names) {
            const k = Object.keys(s.inputs).find((x) => x.toLowerCase() === n.toLowerCase());
            if (!k || !s.inputs[k]) continue;
            const val = expandMacros(str(s.inputs[k]), m);
            if (/\$\(/.test(val)) throw new PipelineError(`Job ${j.name}: Step ${s.displayName} input ${k} references service connection ${val} which could not be found. The service connection does not exist, has been disabled or has not been authorized for use. (Las variables de una conexión de servicio deben definirse en el YAML para resolverse al compilar el pipeline.)`);
            const sc = findSc(rc.project, val);
            if (!sc) throw new PipelineError(`There was a resource authorization issue: "The pipeline is not valid. Job ${j.name}: Step ${s.displayName} input ${k} references service connection ${val} which could not be found. The service connection does not exist, has been disabled or has not been authorized for use. For authorization details, refer to https://aka.ms/yamlauthz."`);
            void type;
          }
        }
      }
      const pool = j.pool;
      if (pool?.name && !ciEq(pool.name, 'Azure Pipelines') && !pool.vmImage) {
        throw new PipelineError(`There was a resource authorization issue: "The pipeline is not valid. Could not find a pool with name ${pool.name}. The pool does not exist or has not been authorized for use." (El simulador sólo dispone de agentes hospedados: usa pool: vmImage: ubuntu-latest.)`);
      }
    }
  }
}

// ---------------------------------------------------------------- ejecución

function newStep(name: string): RunStep {
  return { id: guid(), name, status: 'notStarted', log: [] };
}

function stepTitle(rc: RunCtx, s: NStep): string {
  if (s.kind === 'checkout') return s.displayName || `Checkout ${rc.repoName}@${rc.run.sourceBranch.replace('refs/heads/', '')} to s`;
  return s.displayName;
}

function prepareJob(rc: RunCtx, rj: RunJob, nj: NJob) {
  rj.steps = [newStep('Initialize job'), ...nj.steps.map((s) => newStep(stepTitle(rc, s))), newStep('Finalize Job')];
  rj.status = 'notStarted';
}

function imageOf(pool: NJob['pool']): string {
  const v = (pool?.vmImage ?? 'ubuntu-latest').toLowerCase();
  if (v.startsWith('windows')) return v === 'windows-latest' ? 'windows-2022' : v;
  if (v.startsWith('macos')) return v === 'macos-latest' ? 'macos-14' : v;
  return v === 'ubuntu-latest' ? 'ubuntu-24.04' : v;
}

function canceled(rc: RunCtx) {
  return rc.run.status === 'canceled' || rc.abort.signal.aborted;
}

function setEnv(jc: JobCtx, k: string, v: string) {
  jc.sess.env[k] = v;
  jc.sess.exported.add(k);
  jc.envKeys.push(k);
}

function prepareEnv(jc: JobCtx, step: NStep) {
  for (const k of jc.envKeys) {
    delete jc.sess.env[k];
    jc.sess.exported.delete(k);
  }
  jc.envKeys = [];
  for (const v of jc.vars.values()) if (!v.isSecret) setEnv(jc, envName(v.name), expandMacros(v.value, jc.vars));
  for (const [k, v] of Object.entries(step.env)) setEnv(jc, k, expandMacros(v, jc.vars));
  jc.sess.cwd = `${W}/s`;
}

async function runJob(rc: RunCtx, rs: RunStage, ns: NStage, rj: RunJob, nj: NJob): Promise<void> {
  prepareJob(rc, rj, nj);
  const vars = jobVars(rc, ns, nj);
  const depResults = Object.fromEntries(rj.dependsOn.map((d) => [d.toLowerCase(), resultOf(rs.jobs.find((x) => ciEq(x.name, d))?.status)]));
  let run = false;
  try {
    run = truthy(evalExpr(nj.condition ?? 'succeeded()', { variables: vars, dependencies: depResults, status: { mode: 'deps', results: depResults, canceled: canceled(rc) } }));
  } catch (e: any) {
    rj.steps[0].log.push(`##[error]${e?.message ?? e}`);
    rj.steps[0].status = 'failed';
    rj.status = 'failed';
    changed();
    return;
  }
  if (!run) {
    rj.status = 'skipped';
    rj.steps.forEach((s) => (s.status = 'skipped'));
    changed();
    return;
  }
  rj.status = 'running';
  changed();
  await pause(1200, rc);
  const root: FsDir = { t: 'd', c: {}, mt: Date.now() };
  const fs = new VFS(root);
  for (const d of [`${W}/s`, `${W}/a`, `${W}/b`, `${W}/TestResults`, TEMP, '/home/vsts/.azure']) fs.mkdir(d, true);
  const sess = createAgentSession({ fs, workDir: `${W}/s`, env: {} });
  const jc: JobCtx = { rc, stage: rs, job: rj, nj, fs, sess, vars, envKeys: [], failed: false, issues: false, built: new Map() };
  const image = imageOf(nj.pool);

  // Initialize job
  const init = rj.steps[0];
  init.status = 'running';
  init.startedAt = nowIso();
  const il = new StepLog(init, jc);
  il.line(`##[section]Starting: Initialize job`);
  il.line(`Agent name: 'Azure Pipelines ${1 + (rc.run.number % 9)}'`);
  il.line(`Agent machine name: '${sess.host}'`);
  il.line(`Current agent version: '${AGENT_VERSION}'`);
  il.line('Operating System');
  il.line(image.startsWith('windows') ? 'Microsoft Windows Server 2022 Datacenter' : image.startsWith('macos') ? 'macOS 14.7' : `Ubuntu ${image.replace('ubuntu-', '')} LTS`);
  il.line('Runner Image');
  il.line(`Image: ${image}`);
  il.line('Version: 20261019.1.0');
  il.line(`Current image version: '20261019.1.0'`);
  for (const s of nj.steps.filter((x) => x.kind === 'task')) il.line(`Downloading task: ${s.task} (${s.version || 'latest'}.${200 + (s.task.length * 7) % 60}.0)`);
  if (nj.environment) il.line(`Deployment job ${nj.name} targeting environment '${nj.environment}'`);
  il.line('Job preparation parameters');
  il.line(`Using pool: Azure Pipelines`);
  il.line(`##[section]Finishing: Initialize job`);
  il.flush();
  init.status = 'succeeded';
  init.finishedAt = nowIso();
  changed();
  if (image.startsWith('windows') || image.startsWith('macos')) {
    il.line(`##[warning]El simulador ejecuta todos los agentes como Linux (bash). La imagen ${image} se trata como ubuntu-24.04.`);
  }

  for (let i = 0; i < nj.steps.length; i++) {
    const ns_ = nj.steps[i];
    const step = rj.steps[i + 1];
    if (canceled(rc)) {
      step.status = 'canceled';
      continue;
    }
    let cond = false;
    try {
      cond = truthy(evalExpr(ns_.condition ? expandMacros(ns_.condition, vars) : 'succeeded()', { variables: vars, status: { mode: 'step', failed: jc.failed, canceled: canceled(rc) } }));
    } catch (e: any) {
      step.log.push(`##[error]${e?.message ?? e}`);
      step.status = 'failed';
      jc.failed = true;
      continue;
    }
    if (!cond) {
      step.status = 'skipped';
      step.log.push(`Evaluating: ${ns_.condition ?? 'succeeded()'}`, 'Result: False', `##[section]Skipping: ${step.name}`);
      changed();
      continue;
    }
    step.status = 'running';
    step.startedAt = nowIso();
    changed();
    const log = new StepLog(step, jc);
    log.line(`##[section]Starting: ${step.name}`);
    log.line('==============================================================================');
    log.line(`Task         : ${ns_.kind === 'task' ? ns_.task : ns_.kind === 'script' ? (ns_.task === 'Bash' ? 'Bash' : 'Command line') : ns_.displayName}`);
    if (ns_.version) log.line(`Version      : ${ns_.version}.${200 + (ns_.task.length * 7) % 60}.0`);
    log.line('==============================================================================');
    prepareEnv(jc, ns_);
    const io: ShellIO = { stdin: null, out: log.write, err: log.err, isTTY: false, signal: rc.abort.signal };
    const inputs = expandDeep(ns_.inputs, vars);
    const t: TaskCtx = { jc, step: ns_, inputs, log, io };
    if (ns_.kind === 'script') t.step = { ...ns_, script: expandMacros(ns_.script ?? '', vars) };
    let code = 0;
    await pause(300, rc);
    try {
      const impl = taskImpl(ns_);
      if (!impl) throw new TaskError(`La tarea ${ns_.task}@${ns_.version} existe en Azure DevOps, pero el simulador no la implementa. Usa un paso script o AzureCLI@2 para conseguir lo mismo.`);
      code = await impl(t);
    } catch (e: any) {
      log.flush();
      if (e?.message === 'aborted') code = 130;
      else {
        log.error(e instanceof TaskError || e?.code ? String(e.message) : `Unhandled: ${e?.message ?? e}`);
        if (!(e instanceof TaskError) && !e?.code) console.error(e);
        code = 1;
      }
    }
    log.flush();
    const forced = log.forcedResult;
    if (canceled(rc)) {
      step.status = 'canceled';
      log.line('##[error]The operation was canceled.');
    } else if (code !== 0 || forced === 'Failed') {
      if (ns_.continueOnError) {
        step.status = 'succeededWithIssues';
        jc.issues = true;
      } else {
        step.status = 'failed';
        jc.failed = true;
      }
    } else step.status = forced === 'SucceededWithIssues' ? 'succeededWithIssues' : 'succeeded';
    if (step.status === 'succeededWithIssues' && !ns_.continueOnError) jc.issues = true;
    log.line(`##[section]Finishing: ${step.name}`);
    step.finishedAt = nowIso();
    changed();
  }

  const fin = rj.steps[rj.steps.length - 1];
  fin.status = 'succeeded';
  fin.startedAt = nowIso();
  fin.log.push('##[section]Starting: Finalize Job', 'Cleaning up task key', 'Start cleaning up orphan processes.', '##[section]Finishing: Finalize Job');
  fin.finishedAt = nowIso();
  rj.status = canceled(rc) ? 'canceled' : jc.failed ? 'failed' : jc.issues ? 'succeededWithIssues' : 'succeeded';
  if (nj.environment) {
    const env = rc.project.environments.find((e) => ciEq(e.name, nj.environment!));
    env?.deployments.unshift({ runId: rc.run.id, pipelineName: rc.run.pipelineName, time: nowIso(), status: rj.status });
    if (env && env.deployments.length > 30) env.deployments = env.deployments.slice(0, 30);
  }
  changed();
}

async function waitApproval(rc: RunCtx, rs: RunStage): Promise<void> {
  while (rs.approval?.status === 'pending' && !canceled(rc) && getState().devops.projects.includes(rc.project)) {
    await sleep(400);
  }
}

async function runStage(rc: RunCtx, rs: RunStage, ns: NStage): Promise<void> {
  const { run, project } = rc;
  const deps = rs.dependsOn;
  const results = Object.fromEntries(deps.map((d) => [d.toLowerCase(), resultOf(run.stages.find((x) => ciEq(x.name, d))?.status)]));
  const vars = staticVars(rc);
  for (const v of ns.variables) setVar(vars, v);
  let go: boolean;
  try {
    go = truthy(evalExpr(ns.condition ?? 'succeeded()', { variables: vars, dependencies: results, status: { mode: 'deps', results, canceled: canceled(rc) } }));
  } catch (e: any) {
    run.error = `Stage ${ns.name}: ${e?.message ?? e}`;
    rs.status = 'failed';
    changed();
    return;
  }
  if (!go || canceled(rc)) {
    rs.status = canceled(rc) ? 'canceled' : 'skipped';
    for (const j of rs.jobs) {
      j.status = rs.status;
      for (const s of j.steps) s.status = rs.status;
    }
    changed();
    return;
  }
  // Aprobaciones y comprobaciones de los entornos
  const envs = [...new Set(ns.jobs.filter((j) => j.deployment).map((j) => j.environment!))];
  for (const envName_ of envs) {
    const env = project.environments.find((e) => ciEq(e.name, envName_)) ?? createEnvironment(project, envName_, false, []);
    if (!env.requireApproval) continue;
    if (!rs.approval || !ciEq(rs.approval.environment, env.name)) rs.approval = { environment: env.name, status: 'pending' };
    if (rs.approval.status === 'pending') {
      rs.status = 'waiting';
      run.status = 'waiting';
      changed();
      notify({
        title: `Aprobación pendiente: ${run.pipelineName} #${run.buildNumber}`,
        message: `La fase "${rs.displayName}" espera aprobación para desplegar en el entorno "${env.name}".`,
        level: 'warning',
        link: `/devops/${encodeURIComponent(project.name)}/pipelines/runs/${run.id}`,
      });
      const s = getState();
      s.emails.unshift({ id: guid(), to: s.me.upn, subject: `[Approval pending] ${project.name}/${run.pipelineName} - ${run.buildNumber}`, body: `La ejecución ${run.buildNumber} del pipeline ${run.pipelineName} necesita tu aprobación para desplegar en el entorno "${env.name}".\nFase: ${rs.displayName}\nAprueba o rechaza desde Azure DevOps > Pipelines > ejecución ${run.buildNumber}.`, time: nowIso(), read: false });
      changed();
      await waitApproval(rc, rs);
      if (canceled(rc)) {
        rs.status = 'canceled';
        changed();
        return;
      }
      run.status = 'running';
    }
    if (rs.approval.status === 'rejected') {
      rs.status = 'failed';
      run.error = `La fase ${rs.displayName} fue rechazada por ${rs.approval.by ?? 'un aprobador'} (entorno ${env.name}).`;
      for (const j of rs.jobs) j.status = 'skipped';
      changed();
      return;
    }
  }
  rs.status = 'running';
  changed();
  for (let i = 0; i < ns.jobs.length; i++) {
    await runJob(rc, rs, ns, rs.jobs[i], ns.jobs[i]);
  }
  const st = rs.jobs.map((j) => j.status);
  rs.status = canceled(rc) ? 'canceled' : st.includes('failed') ? 'failed' : st.includes('succeededWithIssues') ? 'succeededWithIssues' : st.every((x) => x === 'skipped') ? 'skipped' : 'succeeded';
  changed();
}

const active = new Set<string>();

async function executeRun(project: DevOpsProject, run: PipelineRun) {
  if (active.has(run.id) || FINAL.includes(run.status)) return;
  active.add(run.id);
  const abort = new AbortController();
  const watcher = setInterval(() => {
    if (run.status === 'canceled' || !getState().devops.projects.includes(project)) abort.abort();
  }, 300);
  try {
    const pipeline = project.pipelines.find((p) => p.id === run.pipelineId);
    const repo = pipeline ? project.repos.find((r) => r.id === pipeline.repoId) : undefined;
    if (!pipeline || !repo) throw new PipelineError('El pipeline o su repositorio ya no existen.');
    const tree = repo.commits[run.sourceVersion]?.tree ?? {};
    const yamlText = tree[pipeline.yamlPath];
    if (yamlText === undefined) throw new PipelineError(`File /${pipeline.yamlPath} not found in repository ${repo.name} branch ${run.sourceBranch} version ${run.sourceVersion}.`);
    let doc: any;
    try {
      doc = load(yamlText);
    } catch (e: any) {
      throw new PipelineError(`/${pipeline.yamlPath}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    const rc: RunCtx = { project, run, pipeline, plan: { variables: [], parameters: {}, stages: [] }, tree, repoName: repo.name, abort, secrets: new Set() };
    // parámetros, expresiones de plantilla y plantillas (template: / extends:)
    const provided = Object.fromEntries(Object.entries(run.variables).filter(([k]) => k.startsWith('parameters.')).map(([k, v]) => [k.slice('parameters.'.length), v]));
    const compiled = compileDoc(doc, { project, tree, yamlPath: pipeline.yamlPath, repo: repo.name, branch: run.sourceBranch.replace('refs/heads/', ''), version: run.sourceVersion, provided, sys: systemVars(rc) });
    rc.plan = compiled.plan;
    run.parameters = compiled.parameters;
    run.expandedYaml = compiled.yaml;
    run.templates = Object.keys(compiled.templates).length ? compiled.templates : undefined;
    validatePlan(rc);
    // Construye (o reutiliza al reanudar) la estructura de fases y jobs.
    const sameShape = run.stages.length === rc.plan.stages.length && run.stages.every((s, i) => s.name === rc.plan.stages[i].name);
    if (!sameShape) {
      run.stages = rc.plan.stages.map((st, si) => ({
        id: guid(),
        name: st.name,
        displayName: st.displayName,
        status: 'notStarted' as RunStatus,
        dependsOn: st.dependsOn ?? (si ? [rc.plan.stages[si - 1].name] : []),
        condition: st.condition,
        approval: null,
        jobs: st.jobs.map((j) => ({ id: guid(), name: j.name, displayName: j.displayName, status: 'notStarted' as RunStatus, environment: j.environment, dependsOn: j.dependsOn, condition: j.condition, steps: [] as RunStep[] })),
      }));
      run.stages.forEach((rs, si) => rs.jobs.forEach((rj, ji) => prepareJob(rc, rj, rc.plan.stages[si].jobs[ji])));
    }
    if (run.status === 'queued') {
      run.status = 'running';
      run.startedAt = nowIso();
    }
    changed();
    await pause(800, rc);
    for (let i = 0; i < run.stages.length; i++) {
      const rs = run.stages[i];
      if (FINAL.includes(rs.status)) continue;
      await runStage(rc, rs, rc.plan.stages[i]);
    }
    const st = run.stages.map((s) => s.status);
    run.status = canceled(rc) ? 'canceled' : st.includes('failed') ? 'failed' : st.includes('succeededWithIssues') ? 'succeededWithIssues' : 'succeeded';
  } catch (e: any) {
    run.error = e instanceof PipelineError ? e.message : `Error interno del simulador: ${e?.message ?? e}`;
    if (!(e instanceof PipelineError)) console.error(e);
    run.status = run.status === 'canceled' ? 'canceled' : 'failed';
    if (!run.startedAt) run.startedAt = nowIso();
  } finally {
    clearInterval(watcher);
    active.delete(run.id);
  }
  run.finishedAt = nowIso();
  for (const pr of project.pullRequests) {
    if (pr.buildRunId === run.id) pr.buildStatus = run.status === 'succeeded' || run.status === 'succeededWithIssues' ? 'succeeded' : 'failed';
  }
  changed();
  if (getState().devops.projects.includes(project)) notifyRunFinished(project, run);
}

setRunStarter((project, run) => {
  void executeRun(project, run);
});

/** Reanuda las ejecuciones que quedaron a medias al recargar la página. */
export function resumePipelineRuns() {
  for (const p of getState().devops.projects) {
    for (const r of p.runs) {
      if (FINAL.includes(r.status)) continue;
      for (const st of r.stages) {
        if (st.status === 'running') {
          st.status = 'notStarted';
          for (const j of st.jobs) j.status = 'notStarted';
        }
      }
      if (r.status === 'running' || r.status === 'waiting') r.status = 'running';
      void executeRun(p, r);
    }
  }
}

export const _pipelineInternals = { evalExpr, expandMacros, normalize, substituteImages, globRegex, parseOverrides, splitArgs };
