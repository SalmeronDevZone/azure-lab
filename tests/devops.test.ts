// Pruebas de Azure Pipelines: plantillas (template:, extends:), parámetros en tiempo de ejecución y expresiones.
import { describe, it, expect, beforeAll } from 'vitest';
import '../src/engine/providers';
import { compilePipeline } from '../src/shell/pipelines';
import { getState } from '../src/engine/store';
import { createProject, commitFile, createPipeline, queueRun, rerunFailedStages, createWorkItem, createBranch, createPullRequest, prPolicyStatus, completePullRequest } from '../src/engine/services/devops';
import type { DevOpsProject, DevOpsRepo, PipelineRun } from '../src/engine/types';

let p: DevOpsProject;
let repo: DevOpsRepo;
const FINAL = ['succeeded', 'failed', 'canceled', 'succeededWithIssues'];

async function waitRun(run: PipelineRun, ms = 15000) {
  const t0 = Date.now();
  while (!FINAL.includes(run.status)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${run.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return run;
}

const logOf = (run: PipelineRun) => run.stages.flatMap((s) => s.jobs.flatMap((j) => j.steps.flatMap((st) => [`[${st.name}]`, ...st.log]))).join('\n');

function put(path: string, text: string) {
  commitFile(p, repo, 'main', path, text, `Añade ${path}`, 'Estudiante');
}

beforeAll(() => {
  getState().settings.speed = 'instant';
  p = createProject('tpl-lab', '', 'Estudiante');
  repo = p.repos[0];
  put('templates/build.yml', `parameters:
- name: nodeVersion
  type: string
  default: '20.x'
- name: runTests
  type: boolean
  default: true
- name: extraSteps
  type: stepList
  default: []
steps:
- script: echo "Node \${{ parameters.nodeVersion }}"
  displayName: 'Usar Node \${{ parameters.nodeVersion }}'
- \${{ if eq(parameters.runTests, true) }}:
  - script: echo "ejecutando pruebas"
    displayName: 'Pruebas'
- \${{ else }}:
  - script: echo "sin pruebas"
    displayName: 'Sin pruebas'
- \${{ parameters.extraSteps }}
`);
  put('templates/vars.yml', `variables:
  appName: tienda
  region: westeurope
`);
  put('templates/deploy-jobs.yml', `parameters:
- name: environments
  type: object
  default: [dev, pre]
jobs:
- \${{ each env in parameters.environments }}:
  - job: Deploy_\${{ env }}
    displayName: 'Desplegar en \${{ env }}'
    steps:
    - script: echo "desplegando \$(appName) en \${{ env }}"
`);
});

describe('plantillas de pipeline', () => {
  it('pasos, variables y jobs desde plantillas con parámetros, if/else y each', async () => {
    put('azure-pipelines.yml', `trigger: none
parameters:
- name: entorno
  displayName: Entorno de destino
  type: string
  default: dev
  values: [dev, prod]
- name: pruebas
  type: boolean
  default: false
variables:
- template: templates/vars.yml
- name: version
  value: '1.0'
stages:
- stage: Build
  jobs:
  - job: Build
    steps:
    - template: templates/build.yml
      parameters:
        nodeVersion: '22.x'
        runTests: \${{ parameters.pruebas }}
        extraSteps:
        - script: echo "paso extra de \$(appName)"
          displayName: 'Paso extra'
- stage: Deploy
  jobs:
  - template: templates/deploy-jobs.yml
    parameters:
      environments:
      - \${{ parameters.entorno }}
      - qa
`);
    const pl = createPipeline(p, 'tpl', repo, 'azure-pipelines.yml', 'main');
    const run = await waitRun(queueRun(p, pl, 'main', 'manual', 'Estudiante', { 'parameters.entorno': 'prod' }));
    if (run.status !== 'succeeded') throw new Error(`${run.status}: ${run.error}\n${logOf(run)}`);
    const steps = run.stages[0].jobs[0].steps.map((s) => s.name);
    expect(steps).toContain('Usar Node 22.x');
    expect(steps).toContain('Sin pruebas');
    expect(steps).not.toContain('Pruebas');
    expect(steps).toContain('Paso extra');
    expect(logOf(run)).toContain('paso extra de tienda');
    expect(run.stages[1].jobs.map((j) => j.name)).toEqual(['Deploy_prod', 'Deploy_qa']);
    expect(logOf(run)).toContain('desplegando tienda en prod');
    expect(run.parameters).toEqual({ entorno: 'prod', pruebas: false });
    expect(run.templates?.['templates/build.yml']).toBe(1);
    expect(run.expandedYaml).toContain('Deploy_qa');
  });

  it('extends: el pipeline hereda la estructura de una plantilla', async () => {
    put('templates/secure.yml', `parameters:
- name: buildSteps
  type: stepList
  default: []
stages:
- stage: Seguridad
  jobs:
  - job: Escaneo
    steps:
    - script: echo "escaneo obligatorio"
- stage: Build
  jobs:
  - job: Build
    steps:
    - \${{ each s in parameters.buildSteps }}:
      - \${{ s }}
`);
    put('extends.yml', `trigger: none
extends:
  template: templates/secure.yml
  parameters:
    buildSteps:
    - script: echo "compilando"
      displayName: Compilar
`);
    const pl = createPipeline(p, 'ext', repo, 'extends.yml', 'main');
    const run = await waitRun(queueRun(p, pl, 'main', 'manual', 'Estudiante'));
    if (run.status !== 'succeeded') throw new Error(`${run.status}: ${run.error}\n${logOf(run)}`);
    expect(run.stages.map((s) => s.name)).toEqual(['Seguridad', 'Build']);
    expect(logOf(run)).toContain('escaneo obligatorio');
    expect(run.stages[1].jobs[0].steps.map((s) => s.name)).toContain('Compilar');
  });

  it('volver a ejecutar sólo las fases con errores', async () => {
    // La fase Deploy falla si no existe la variable listo; la fase Build (correcta) no se repite.
    put('rerun.yml', `trigger: none
stages:
- stage: Build
  jobs:
  - job: B
    steps:
    - script: echo "compilado $(Build.BuildNumber)"
- stage: Deploy
  jobs:
  - job: D
    steps:
    - script: test -n "$(listo)"
`);
    const pl = createPipeline(p, 'rerun', repo, 'rerun.yml', 'main');
    const run = await waitRun(queueRun(p, pl, 'main', 'manual', 'Estudiante'));
    expect(run.status).toBe('failed');
    expect(run.stages.map((s) => s.status)).toEqual(['succeeded', 'failed']);
    const buildStartedAt = run.stages[0].jobs[0].steps[0].startedAt;
    pl.variables.listo = { value: 'si', isSecret: false };
    rerunFailedStages(p, run.id);
    expect(run.attempt).toBe(2);
    await waitRun(run);
    if (run.status !== 'succeeded') throw new Error(`${run.status}: ${run.error}\n${logOf(run)}`);
    expect(run.stages[0].jobs[0].steps[0].startedAt).toBe(buildStartedAt);
    expect(() => rerunFailedStages(p, run.id)).toThrow(/con errores/);
  });

  it('errores como en Azure DevOps', () => {
    const err = (text: string, params?: Record<string, any>) => {
      try {
        compilePipeline(p, 'tpl-lab', 'main', 'probe.yml', { text, parameters: params });
        return '';
      } catch (e: any) {
        return String(e.message);
      }
    };
    expect(err('steps:\n- template: templates/noexiste.yml')).toMatch(/File \/templates\/noexiste\.yml not found in repository tpl-lab/);
    expect(err('steps:\n- template: templates/build.yml\n  parameters:\n    colour: red')).toMatch(/Unexpected parameter 'colour'/);
    expect(err('steps:\n- template: templates/build.yml\n  parameters:\n    runTests: quizas')).toMatch(/not a valid Boolean/);
    expect(err('parameters:\n- name: entorno\n  values: [dev, prod]\nsteps:\n- script: echo hola', { entorno: 'test' })).toMatch(/not a valid value/);
    expect(err('parameters:\n- name: obligatorio\n  type: string\nsteps:\n- script: echo hola')).toMatch(/A value for the 'obligatorio' parameter must be provided/);
    expect(err('jobs:\n- template: templates/build.yml')).toMatch(/se esperaba una plantilla de jobs/);
    put('templates/loop.yml', 'steps:\n- template: loop.yml');
    expect(err('steps:\n- template: templates/loop.yml')).toMatch(/anidadas demasiado/);
    const ok = compilePipeline(p, 'tpl-lab', 'main', 'probe.yml', { text: 'steps:\n- template: /templates/build.yml\n  parameters:\n    runTests: false' });
    expect(ok.stages[0].jobs[0].steps).toEqual(['Usar Node 20.x', 'Sin pruebas']);
  });
});

describe('Boards y Repos: elementos de trabajo vinculados', () => {
  it('menciones #id, directiva de vinculación y cierre al completar la PR', () => {
    const wi = createWorkItem(p, 'User Story', 'Inicio de sesión', 'Estudiante');
    createBranch(repo, 'feature/login', 'main');
    commitFile(p, repo, 'feature/login', 'login.js', 'module.exports = () => true;', `Inicio de sesión AB#${wi.id}`, 'Estudiante');
    expect(wi.links?.some((l) => l.kind === 'commit')).toBe(true);
    repo.policies = { minReviewers: 0, requireLinkedWorkItem: true };
    expect(() => commitFile(p, repo, 'main', 'x.txt', 'x', 'directo', 'Estudiante')).toThrow(/TF402455/);
    const pr = createPullRequest(p, repo, 'feature/login', 'main', 'Login', '', 'Estudiante');
    expect(pr.workItems).toEqual([wi.id]);
    expect(prPolicyStatus(p, pr).ok).toBe(true);
    createBranch(repo, 'feature/sin', 'main');
    commitFile(p, repo, 'feature/sin', 'otro.txt', 'x', 'Cambio sin vínculo', 'Estudiante');
    const pr2 = createPullRequest(p, repo, 'feature/sin', 'main', 'Sin vínculo', '', 'Estudiante');
    expect(prPolicyStatus(p, pr2).reasons.join(' ')).toMatch(/elemento de trabajo vinculado/);
    expect(() => completePullRequest(p, pr2.id, 'Estudiante')).toThrow(/TF401027/);
    expect(() => createPullRequest(p, repo, 'feature/sin', 'feature/login', 'x', '', 'Estudiante', [999])).toThrow(/TF401232/);
    completePullRequest(p, pr.id, 'Estudiante', true, true);
    expect(wi.state).toBe('Resolved');
    expect(wi.links?.some((l) => l.kind === 'pr' && l.id === String(pr.id))).toBe(true);
    repo.policies = null;
  });
});
