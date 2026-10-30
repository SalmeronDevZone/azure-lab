// az devops / repos / pipelines / boards (extensión azure-devops).
import { register, group, cliError, type Args, type AzCtx, type AzArg } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { findResource } from '../../../engine/arm';
import { parseResourceId } from '../../../engine/ids';
import { ciEq } from '../../../engine/util';
import {
  approveStage, completePullRequest, createAzureRmConnection, createPipeline, createProject, createPullRequest, createRepo, createWorkItem, deleteProject,
  getProject, getRepo, importTemplate, org, orgUrl, queueRun, repoUrl, findRun, cancelRun, DEVOPS_HOST, linkWorkItems, unlinkWorkItem,
} from '../../../engine/services/devops';
import type { DevOpsProject } from '../../../engine/types';

group('devops', 'Administra organizaciones de Azure DevOps.');
group('devops project', 'Administra proyectos de equipo.');
group('devops service-endpoint', 'Administra conexiones de servicio.');
group('devops service-endpoint azurerm', 'Conexiones de servicio de Azure Resource Manager.');
group('repos', 'Administra Azure Repos.');
group('repos import', 'Importa repositorios.');
group('repos pr', 'Administra pull requests.');
group('repos policy', 'Administra directivas de rama.');
group('repos policy approver-count', 'Directiva de número mínimo de revisores.');
group('repos policy build', 'Directiva de validación de compilación.');
group('pipelines', 'Administra Azure Pipelines.');
group('pipelines runs', 'Administra ejecuciones de pipelines.');
group('pipelines variable', 'Variables de pipeline.');
group('pipelines variable-group', 'Grupos de variables (Library).');
group('boards', 'Administra Azure Boards.');
group('boards work-item', 'Elementos de trabajo.');

const orgArg: AzArg = { name: 'org', opts: ['--organization', '--org'], help: 'URL de la organización: https://dev.azure.com/<org>. Por defecto, la configurada con az devops configure.' };
const projArg: AzArg = { name: 'project', opts: ['--project', '-p'], help: 'Nombre del proyecto. Por defecto, el configurado con az devops configure.' };

function project(ctx: AzCtx, a: Args): DevOpsProject {
  const o = a.org ?? ctx.sess.az.defaults.organization;
  if (o && !String(o).toLowerCase().includes(org().toLowerCase())) throw new ArmError('DevOpsError', `TF400813: The user is not authorized to access this resource. (Tu organización simulada es ${orgUrl()})`, 401);
  return getProject(a.project ?? ctx.sess.az.defaults.project);
}

function who(ctx: AzCtx) {
  return ctx.principal.displayName ?? ctx.principal.name;
}

const projJson = (p: DevOpsProject) => ({ description: p.description, id: p.id, lastUpdateTime: p.createdAt, name: p.name, revision: 12, state: 'wellFormed', url: `${orgUrl()}/_apis/projects/${p.id}`, visibility: 'private' });

register({
  path: 'devops configure',
  summary: 'Configura los valores predeterminados de Azure DevOps (organización y proyecto).',
  noLogin: true,
  args: [{ name: 'defaults', opts: ['--defaults', '-d'], help: 'organization=https://dev.azure.com/<org> project=<proyecto>', type: 'kv' }, { name: 'list', opts: ['--list', '-l'], help: 'Lista la configuración.', type: 'bool' }],
  run(a, ctx) {
    if (a.list || !a.defaults) {
      ctx.io.out(`[defaults]\norganization = ${ctx.sess.az.defaults.organization ?? ''}\nproject = ${ctx.sess.az.defaults.project ?? ''}\n\n(Tu organización simulada es ${orgUrl()})\n`);
      return undefined;
    }
    for (const [k, v] of Object.entries<string>(a.defaults)) ctx.sess.az.defaults[k] = v;
    ctx.sess.az.persist();
    return undefined;
  },
});

register({
  path: 'devops project create',
  summary: 'Crea un proyecto de equipo (incluye un repositorio Git vacío con el mismo nombre).',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre del proyecto.', required: true }, { name: 'description', opts: ['--description', '-d'], help: 'Descripción.' }, orgArg, { name: 'visibility', opts: ['--visibility'], help: 'Visibilidad.', choices: ['private', 'public'] }, { name: 'source_control', opts: ['--source-control', '-s'], help: 'Control de código.', choices: ['git', 'tfvc'] }],
  examples: [{ title: 'Crear un proyecto.', cmd: 'az devops project create --name lab-devops --org https://dev.azure.com/<tu-org>' }],
  run: (a, ctx) => projJson(createProject(a.name, a.description ?? '', who(ctx))),
});

register({
  path: 'devops project list',
  summary: 'Lista los proyectos.',
  args: [orgArg],
  table: (r: any) => r.value.map((p: any) => ({ ID: p.id, Name: p.name, Visibility: p.visibility })),
  run: () => ({ continuationToken: null, value: getState().devops.projects.map(projJson) }),
});

register({
  path: 'devops project show',
  summary: 'Muestra un proyecto.',
  args: [{ name: 'project', opts: ['--project', '-p'], help: 'Proyecto.', required: true }, orgArg],
  run: (a, ctx) => projJson(project(ctx, a)),
});

register({
  path: 'devops project delete',
  summary: 'Elimina un proyecto.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. o nombre del proyecto.', required: true }, orgArg, { name: 'yes', opts: ['--yes', '-y'], help: 'No pedir confirmación.', type: 'bool' }],
  confirm: 'Are you sure you want to delete this project?',
  run(a) {
    deleteProject(a.id);
    return undefined;
  },
});

register({
  path: 'devops service-endpoint azurerm create',
  summary: 'Crea una conexión de servicio de Azure Resource Manager con una entidad de servicio.',
  args: [{ name: 'name', opts: ['--name'], help: 'Nombre de la conexión.', required: true }, { name: 'sp_id', opts: ['--azure-rm-service-principal-id'], help: 'appId de la entidad de servicio.', required: true }, { name: 'sub_id', opts: ['--azure-rm-subscription-id'], help: 'Id. de la suscripción.', required: true }, { name: 'sub_name', opts: ['--azure-rm-subscription-name'], help: 'Nombre de la suscripción.', required: true }, { name: 'tenant', opts: ['--azure-rm-tenant-id'], help: 'Id. del inquilino.', required: true }, projArg, orgArg],
  examples: [{ title: 'Con el secreto en la variable de entorno.', cmd: 'export AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY=<secreto>; az devops service-endpoint azurerm create --name sc-azure-lab --azure-rm-service-principal-id <appId> --azure-rm-subscription-id <sub> --azure-rm-subscription-name "Azure Lab - Desarrollo" --azure-rm-tenant-id <tenant>' }],
  async run(a, ctx) {
    const p = project(ctx, a);
    let secret = ctx.sess.env.AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY;
    if (!secret && ctx.io.prompt) secret = await ctx.io.prompt('Azure RM service principal key: ', { secret: true });
    if (!ciEq(a.tenant, getState().tenant.id)) throw new ArmError('DevOpsError', `AADSTS90002: Tenant '${a.tenant}' not found.`, 400);
    const sc = createAzureRmConnection(p, { name: a.name, scope: `/subscriptions/${a.sub_id}`, subscriptionId: a.sub_id, automatic: false, appId: a.sp_id, secret }, ctx.principal);
    return { authorization: { parameters: { serviceprincipalid: sc.servicePrincipalAppId, tenantid: a.tenant }, scheme: 'ServicePrincipal' }, data: { subscriptionId: a.sub_id, subscriptionName: a.sub_name }, id: sc.id, isReady: true, name: sc.name, type: 'azurerm' };
  },
});

register({
  path: 'devops service-endpoint list',
  summary: 'Lista las conexiones de servicio.',
  args: [projArg, orgArg],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, Type: x.type, IsReady: x.isReady, Id: x.id })),
  run: (a, ctx) => project(ctx, a).serviceConnections.map((s) => ({ id: s.id, name: s.name, type: s.type, isReady: s.isReady, authorization: { scheme: s.authScheme } })),
});

register({
  path: 'devops service-endpoint delete',
  summary: 'Elimina una conexión de servicio.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. o nombre.', required: true }, projArg, orgArg, { name: 'yes', opts: ['--yes', '-y'], help: 'Sin confirmación.', type: 'bool' }],
  run(a, ctx) {
    const p = project(ctx, a);
    p.serviceConnections = p.serviceConnections.filter((s) => s.id !== a.id && !ciEq(s.name, a.id));
    changed();
    return undefined;
  },
});

// ---------------------------------------------------------------- repos

const repoJson = (p: DevOpsProject, r: DevOpsProject['repos'][number]) => ({ defaultBranch: Object.keys(r.branches).length ? `refs/heads/${r.defaultBranch}` : null, id: r.id, isDisabled: false, name: r.name, project: { id: p.id, name: p.name }, remoteUrl: repoUrl(p, r), size: Object.keys(r.commits).length * 1024, sshUrl: `git@ssh.${DEVOPS_HOST}:v3/${org()}/${p.name}/${r.name}`, webUrl: `${orgUrl()}/${encodeURIComponent(p.name)}/_git/${encodeURIComponent(r.name)}` });

register({
  path: 'repos create',
  summary: 'Crea un repositorio Git.',
  args: [{ name: 'name', opts: ['--name'], help: 'Nombre.', required: true }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    return repoJson(p, createRepo(p, a.name));
  },
});

register({
  path: 'repos list',
  summary: 'Lista los repositorios.',
  args: [projArg, orgArg],
  table: (r: any[]) => r.map((x) => ({ ID: x.id, Name: x.name, DefaultBranch: x.defaultBranch, Project: x.project.name })),
  run(a, ctx) {
    const p = project(ctx, a);
    return p.repos.map((r) => repoJson(p, r));
  },
});

register({
  path: 'repos show',
  summary: 'Muestra un repositorio.',
  args: [{ name: 'repository', opts: ['--repository', '-r'], help: 'Nombre o id.', required: true }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    return repoJson(p, getRepo(p, a.repository));
  },
});

register({
  path: 'repos delete',
  summary: 'Elimina un repositorio.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. o nombre.', required: true }, projArg, orgArg, { name: 'yes', opts: ['--yes', '-y'], help: 'Sin confirmación.', type: 'bool' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = getRepo(p, a.id);
    p.repos = p.repos.filter((x) => x !== r);
    changed();
    return undefined;
  },
});

register({
  path: 'repos import create',
  summary: 'Importa un repositorio Git en un repositorio vacío.',
  args: [{ name: 'git_source_url', opts: ['--git-source-url', '--git-url'], help: 'URL de origen (en el simulador: https://github.com/azure-lab/app-node, web-estatica, iac-bicep o iac-terraform).', required: true }, { name: 'repository', opts: ['--repository', '-r'], help: 'Repositorio de destino.' }, projArg, orgArg],
  examples: [{ title: 'Importar la app de ejemplo.', cmd: 'az repos import create --git-source-url https://github.com/azure-lab/app-node --repository lab-devops' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = getRepo(p, a.repository ?? p.name);
    importTemplate(p, r, a.git_source_url, who(ctx));
    return { detailedStatus: { allSteps: ['Processing request', 'Analyzing repository objects', 'Storing objects', 'Storing index file', 'Updating references'], currentStep: 6 }, parameters: { gitSource: { url: a.git_source_url } }, repository: repoJson(p, r), status: 'completed' };
  },
});

const prJson = (p: DevOpsProject, pr: DevOpsProject['pullRequests'][number]) => ({ codeReviewId: pr.id, createdBy: { displayName: pr.createdBy }, creationDate: pr.createdAt, description: pr.description, mergeStatus: pr.status === 'completed' ? 'succeeded' : 'queued', pullRequestId: pr.id, repository: { name: p.repos.find((r) => r.id === pr.repoId)?.name }, reviewers: pr.approvals.map((x) => ({ displayName: x, vote: 10 })), sourceRefName: `refs/heads/${pr.source}`, status: pr.status, targetRefName: `refs/heads/${pr.target}`, title: pr.title });

register({
  path: 'repos pr create',
  summary: 'Crea un pull request.',
  args: [{ name: 'source_branch', opts: ['--source-branch', '-s'], help: 'Rama de origen.', required: true }, { name: 'target_branch', opts: ['--target-branch', '-t'], help: 'Rama de destino (por defecto, la predeterminada).' }, { name: 'title', opts: ['--title'], help: 'Título.' }, { name: 'description', opts: ['--description', '-d'], help: 'Descripción.', type: 'list' }, { name: 'repository', opts: ['--repository', '-r'], help: 'Repositorio.' }, projArg, orgArg, { name: 'auto_complete', opts: ['--auto-complete'], help: 'Completar automáticamente.', type: 'bool' }, { name: 'work_items', opts: ['--work-items'], help: 'Ids de elementos de trabajo que vincular.', type: 'list' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = getRepo(p, a.repository ?? p.name);
    const src = String(a.source_branch).replace('refs/heads/', '');
    return prJson(p, createPullRequest(p, r, src, (a.target_branch ?? r.defaultBranch).replace('refs/heads/', ''), a.title ?? `Merge ${src}`, (a.description ?? []).join('\n'), who(ctx), (a.work_items ?? []).map(Number)));
  },
});

register({
  path: 'repos pr list',
  summary: 'Lista pull requests.',
  args: [{ name: 'repository', opts: ['--repository', '-r'], help: 'Repositorio.' }, { name: 'status', opts: ['--status'], help: 'Estado.', choices: ['active', 'completed', 'abandoned', 'all'], default: 'active' }, projArg, orgArg],
  table: (r: any[]) => r.map((x) => ({ ID: x.pullRequestId, Created: x.creationDate, Creator: x.createdBy.displayName, Title: x.title, Status: x.status, Repository: x.repository.name })),
  run(a, ctx) {
    const p = project(ctx, a);
    return p.pullRequests.filter((x) => a.status === 'all' || x.status === a.status).map((x) => prJson(p, x));
  },
});

register({
  path: 'repos pr show',
  summary: 'Muestra un pull request.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', type: 'int', required: true }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const pr = p.pullRequests.find((x) => x.id === a.id);
    if (!pr) throw new ArmError('DevOpsError', `TF401180: The requested pull request was not found.`, 404);
    return prJson(p, pr);
  },
});

register({
  path: 'repos pr set-vote',
  summary: 'Vota un pull request (approve, reject...).',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', type: 'int', required: true }, { name: 'vote', opts: ['--vote'], help: 'Voto.', choices: ['approve', 'approve-with-suggestions', 'reset', 'wait-for-author', 'reject'], required: true }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const pr = p.pullRequests.find((x) => x.id === a.id);
    if (!pr) throw new ArmError('DevOpsError', 'TF401180: The requested pull request was not found.', 404);
    const name = who(ctx);
    pr.approvals = pr.approvals.filter((x) => x !== name);
    if (a.vote.startsWith('approve')) pr.approvals.push(name);
    changed();
    return { displayName: name, vote: a.vote.startsWith('approve') ? 10 : a.vote === 'reject' ? -10 : 0 };
  },
});

register({
  path: 'repos pr update',
  summary: 'Actualiza un pull request (p. ej. --status completed para completarlo).',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', type: 'int', required: true }, { name: 'status', opts: ['--status'], help: 'Nuevo estado.', choices: ['active', 'completed', 'abandoned'] }, { name: 'squash', opts: ['--squash'], help: 'Fusión squash.', type: 'bool' }, { name: 'transition_work_items', opts: ['--transition-work-items'], help: 'Al completar, cierra (o resuelve) los elementos de trabajo vinculados.', type: 'bool' }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    if (a.status === 'completed') return prJson(p, completePullRequest(p, a.id, who(ctx), !!a.squash, !!a.transition_work_items));
    const pr = p.pullRequests.find((x) => x.id === a.id);
    if (!pr) throw new ArmError('DevOpsError', 'TF401180: The requested pull request was not found.', 404);
    if (a.status) pr.status = a.status;
    changed();
    return prJson(p, pr);
  },
});

register({
  path: 'repos policy approver-count create',
  summary: 'Exige un número mínimo de revisores para fusionar en una rama.',
  args: [{ name: 'repository_id', opts: ['--repository-id'], help: 'Repositorio (id o nombre).', required: true }, { name: 'branch', opts: ['--branch'], help: 'Rama protegida.', required: true }, { name: 'minimum_approver_count', opts: ['--minimum-approver-count'], help: 'Mínimo de revisores.', type: 'int', required: true }, { name: 'creator_vote_counts', opts: ['--creator-vote-counts'], help: 'El voto del autor cuenta.', type: 'bool' }, { name: 'blocking', opts: ['--blocking'], help: 'Bloqueante.', type: 'bool' }, { name: 'enabled', opts: ['--enabled'], help: 'Habilitada.', type: 'bool' }, { name: 'allow_downvotes', opts: ['--allow-downvotes'], help: 'Permitir votos negativos.', type: 'bool' }, { name: 'reset_on_source_push', opts: ['--reset-on-source-push'], help: 'Restablecer al hacer push.', type: 'bool' }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = getRepo(p, a.repository_id);
    r.policies = { ...(r.policies ?? { minReviewers: 0 }), minReviewers: a.minimum_approver_count };
    changed();
    return { id: 1, isBlocking: a.blocking !== false, isEnabled: a.enabled !== false, settings: { minimumApproverCount: a.minimum_approver_count, scope: [{ refName: `refs/heads/${a.branch}`, repositoryId: r.id }] }, type: { displayName: 'Minimum number of reviewers' } };
  },
});

register({
  path: 'repos policy build create',
  summary: 'Exige que un pipeline se complete correctamente antes de fusionar (validación de compilación).',
  args: [{ name: 'repository_id', opts: ['--repository-id'], help: 'Repositorio.', required: true }, { name: 'branch', opts: ['--branch'], help: 'Rama.', required: true }, { name: 'build_definition_id', opts: ['--build-definition-id'], help: 'Id. del pipeline.', required: true }, { name: 'display_name', opts: ['--display-name'], help: 'Nombre.' }, { name: 'blocking', opts: ['--blocking'], help: 'Bloqueante.', type: 'bool' }, { name: 'enabled', opts: ['--enabled'], help: 'Habilitada.', type: 'bool' }, { name: 'queue_on_source_update_only', opts: ['--queue-on-source-update-only'], help: 'Sólo al actualizar.', type: 'bool' }, { name: 'manual_queue_only', opts: ['--manual-queue-only'], help: 'Sólo manual.', type: 'bool' }, { name: 'valid_duration', opts: ['--valid-duration'], help: 'Validez (minutos).' }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = getRepo(p, a.repository_id);
    if (!p.pipelines.some((x) => x.id === String(a.build_definition_id))) throw new ArmError('DevOpsError', `Pipeline ${a.build_definition_id} not found.`, 404);
    r.policies = { ...(r.policies ?? { minReviewers: 0 }), buildValidationPipelineId: String(a.build_definition_id) };
    changed();
    return { id: 2, isBlocking: true, isEnabled: true, settings: { buildDefinitionId: Number(a.build_definition_id), displayName: a.display_name ?? 'Build validation', scope: [{ refName: `refs/heads/${a.branch}`, repositoryId: r.id }] }, type: { displayName: 'Build' } };
  },
});

register({
  path: 'repos policy work-item-linking create',
  summary: 'Exige que las pull requests hacia una rama tengan elementos de trabajo vinculados.',
  args: [{ name: 'repository_id', opts: ['--repository-id'], help: 'Repositorio.', required: true }, { name: 'branch', opts: ['--branch'], help: 'Rama.', required: true }, { name: 'blocking', opts: ['--blocking'], help: 'Bloqueante.', type: 'bool' }, { name: 'enabled', opts: ['--enabled'], help: 'Habilitada.', type: 'bool' }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = getRepo(p, a.repository_id);
    r.policies = { ...(r.policies ?? { minReviewers: 0 }), requireLinkedWorkItem: a.enabled !== false };
    changed();
    return { id: 3, isBlocking: a.blocking !== false, isEnabled: a.enabled !== false, settings: { scope: [{ refName: `refs/heads/${a.branch}`, repositoryId: r.id }] }, type: { displayName: 'Work item linking' } };
  },
});

group('repos pr work-item', 'Elementos de trabajo vinculados a una pull request.');

const prArg = (p: DevOpsProject, id: number) => {
  const pr = p.pullRequests.find((x) => x.id === id);
  if (!pr) throw new ArmError('DevOpsError', 'TF401180: The requested pull request was not found.', 404);
  return pr;
};
const wiJson = (p: DevOpsProject, id: number) => {
  const w = p.workItems.find((x) => x.id === id)!;
  return { fields: { 'System.State': w.state, 'System.Title': w.title, 'System.WorkItemType': w.type }, id: w.id, url: `${orgUrl()}/${encodeURIComponent(p.name)}/_apis/wit/workItems/${w.id}` };
};

register({
  path: 'repos pr work-item add',
  summary: 'Vincula elementos de trabajo a una pull request.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. de la pull request.', type: 'int', required: true }, { name: 'work_items', opts: ['--work-items'], help: 'Ids de los elementos de trabajo.', type: 'list', required: true }, projArg, orgArg],
  examples: [{ title: 'Vincula la historia 12 a la PR 3.', cmd: 'az repos pr work-item add --id 3 --work-items 12' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const pr = prArg(p, a.id);
    linkWorkItems(p, pr, a.work_items.map(Number));
    return (pr.workItems ?? []).map((id) => wiJson(p, id));
  },
});

register({
  path: 'repos pr work-item list',
  summary: 'Lista los elementos de trabajo vinculados a una pull request.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. de la pull request.', type: 'int', required: true }, projArg, orgArg],
  table: (r: any[]) => r.map((x) => ({ ID: x.id, Type: x.fields['System.WorkItemType'], Title: x.fields['System.Title'], State: x.fields['System.State'] })),
  run(a, ctx) {
    const p = project(ctx, a);
    return (prArg(p, a.id).workItems ?? []).map((id) => wiJson(p, id));
  },
});

register({
  path: 'repos pr work-item remove',
  summary: 'Desvincula elementos de trabajo de una pull request.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. de la pull request.', type: 'int', required: true }, { name: 'work_items', opts: ['--work-items'], help: 'Ids de los elementos de trabajo.', type: 'list', required: true }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const pr = prArg(p, a.id);
    for (const id of a.work_items) unlinkWorkItem(p, pr, Number(id));
    return (pr.workItems ?? []).map((id) => wiJson(p, id));
  },
});

register({
  path: 'repos policy list',
  summary: 'Lista las directivas de rama.',
  args: [projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    return p.repos.filter((r) => r.policies).flatMap((r) => [...(r.policies!.minReviewers ? [{ type: 'Minimum number of reviewers', repository: r.name, minimumApproverCount: r.policies!.minReviewers }] : []), ...(r.policies!.buildValidationPipelineId ? [{ type: 'Build', repository: r.name, buildDefinitionId: r.policies!.buildValidationPipelineId }] : []), ...(r.policies!.requireLinkedWorkItem ? [{ type: 'Work item linking', repository: r.name }] : [])]);
  },
});

// ---------------------------------------------------------------- pipelines

const runJson = (p: DevOpsProject, r: DevOpsProject['runs'][number]) => ({ buildNumber: r.buildNumber, definition: { id: Number(r.pipelineId), name: r.pipelineName }, finishTime: r.finishedAt ?? null, id: Number(r.id), project: { name: p.name }, queueTime: r.queuedAt, reason: r.reason, requestedBy: { displayName: r.requestedBy }, result: r.status === 'succeededWithIssues' ? 'partiallySucceeded' : ['succeeded', 'failed', 'canceled'].includes(r.status) ? r.status : null, sourceBranch: r.sourceBranch, sourceVersion: r.sourceVersion, startTime: r.startedAt ?? null, status: ['succeeded', 'failed', 'canceled', 'succeededWithIssues'].includes(r.status) ? 'completed' : r.status === 'queued' ? 'notStarted' : 'inProgress', templateParameters: r.parameters ?? {}, url: `${orgUrl()}/${encodeURIComponent(p.name)}/_build/results?buildId=${r.id}` });

function pipelineArg(p: DevOpsProject, a: Args) {
  const pl = p.pipelines.find((x) => (a.id !== undefined && x.id === String(a.id)) || (a.name && ciEq(x.name, a.name)));
  if (!pl) throw new ArmError('DevOpsError', `There were no build definitions matching name "${a.name ?? a.id}" in project "${p.name}".`, 404);
  return pl;
}

register({
  path: 'pipelines create',
  summary: 'Crea un pipeline YAML a partir de un fichero del repositorio.',
  args: [{ name: 'name', opts: ['--name'], help: 'Nombre del pipeline.', required: true }, { name: 'repository', opts: ['--repository'], help: 'Repositorio.' }, { name: 'repository_type', opts: ['--repository-type'], help: 'Tipo de repositorio.', choices: ['tfsgit', 'github'] }, { name: 'branch', opts: ['--branch'], help: 'Rama.' }, { name: 'yml_path', opts: ['--yml-path', '--yaml-path'], help: 'Ruta del YAML, p. ej. /azure-pipelines.yml.' }, { name: 'skip_first_run', opts: ['--skip-first-run', '--skip-run'], help: 'No ejecutar al crear.', type: 'bool' }, { name: 'description', opts: ['--description'], help: 'Descripción.' }, projArg, orgArg],
  examples: [{ title: 'Crear y ejecutar un pipeline.', cmd: 'az pipelines create --name ci-app --repository lab-devops --branch main --repository-type tfsgit --yml-path /azure-pipelines.yml' }],
  run(a, ctx) {
    const p = project(ctx, a);
    if (a.repository_type === 'github') throw new ArmError('DevOpsError', 'El simulador sólo admite repositorios de Azure Repos (tfsgit).', 400);
    const r = getRepo(p, a.repository ?? p.name);
    const pl = createPipeline(p, a.name, r, a.yml_path ?? 'azure-pipelines.yml', a.branch);
    const result: any = { id: Number(pl.id), name: pl.name, path: '\\', process: { yamlFilename: pl.yamlPath, type: 2 }, repository: { id: r.id, name: r.name, type: 'TfsGit' }, url: `${orgUrl()}/${encodeURIComponent(p.name)}/_build?definitionId=${pl.id}` };
    if (!a.skip_first_run) {
      const run = queueRun(p, pl, a.branch ?? r.defaultBranch, 'manual', who(ctx));
      ctx.io.err(`Queued pipeline run ${run.buildNumber} (id ${run.id}). Sigue la ejecución en Azure DevOps > Pipelines.\n`);
    }
    return result;
  },
});

register({
  path: 'pipelines list',
  summary: 'Lista los pipelines.',
  args: [projArg, orgArg, { name: 'name', opts: ['--name'], help: 'Filtra por nombre.' }],
  table: (r: any[]) => r.map((x) => ({ ID: x.id, Path: x.path, Name: x.name, Status: x.queueStatus, 'Default Queue': 'Azure Pipelines' })),
  run(a, ctx) {
    return project(ctx, a).pipelines.filter((x) => !a.name || ciEq(x.name, a.name)).map((x) => ({ id: Number(x.id), name: x.name, path: '\\', queueStatus: 'enabled', revision: 1 }));
  },
});

register({
  path: 'pipelines show',
  summary: 'Muestra un pipeline.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.' }, { name: 'name', opts: ['--name'], help: 'Nombre.' }, projArg, orgArg, { name: 'open', opts: ['--open'], help: 'Abrir en el navegador.', type: 'bool' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const pl = pipelineArg(p, a);
    if (a.open) ctx.sess.ui.openUrl?.(`#/devops/${encodeURIComponent(p.name)}/pipelines`);
    return { id: Number(pl.id), name: pl.name, process: { yamlFilename: pl.yamlPath }, variables: Object.fromEntries(Object.entries(pl.variables).map(([k, v]) => [k, { isSecret: v.isSecret, value: v.isSecret ? null : v.value }])) };
  },
});

register({
  path: 'pipelines run',
  summary: 'Pone en cola (ejecuta) un pipeline.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.' }, { name: 'name', opts: ['--name'], help: 'Nombre.' }, { name: 'branch', opts: ['--branch'], help: 'Rama.' }, { name: 'variables', opts: ['--variables'], help: 'Variables nombre=valor.', type: 'kv' }, { name: 'parameters', opts: ['--parameters'], help: 'Parámetros en tiempo de ejecución nombre=valor (los declarados en parameters: del YAML).', type: 'kv' }, projArg, orgArg, { name: 'open', opts: ['--open'], help: 'Abrir.', type: 'bool' }],
  examples: [{ title: 'Ejecuta en producción pasando un parámetro.', cmd: 'az pipelines run --name cd --branch main --parameters entorno=prod' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const pl = pipelineArg(p, a);
    const repo = p.repos.find((r) => r.id === pl.repoId)!;
    const params = Object.fromEntries(Object.entries<string>(a.parameters ?? {}).map(([k, v]) => [`parameters.${k}`, v]));
    const run = queueRun(p, pl, (a.branch ?? repo.defaultBranch).replace('refs/heads/', ''), 'manual', who(ctx), { ...(a.variables ?? {}), ...params });
    return runJson(p, run);
  },
});

register({
  path: 'pipelines delete',
  summary: 'Elimina un pipeline.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', required: true }, projArg, orgArg, { name: 'yes', opts: ['--yes', '-y'], help: 'Sin confirmación.', type: 'bool' }],
  run(a, ctx) {
    const p = project(ctx, a);
    p.pipelines = p.pipelines.filter((x) => x.id !== String(a.id));
    changed();
    return undefined;
  },
});

register({
  path: 'pipelines runs list',
  summary: 'Lista las ejecuciones.',
  args: [projArg, orgArg, { name: 'pipeline_ids', opts: ['--pipeline-ids'], help: 'Filtra por pipelines.', type: 'list' }, { name: 'top', opts: ['--top'], help: 'Máximo.', type: 'int' }, { name: 'result', opts: ['--result'], help: 'Resultado.' }],
  table: (r: any[]) => r.map((x) => ({ 'Run ID': x.id, Number: x.buildNumber, Status: x.status, Result: x.result, 'Pipeline ID': x.definition.id, 'Pipeline Name': x.definition.name, 'Source Branch': x.sourceBranch.replace('refs/heads/', ''), 'Queued Time': x.queueTime, Reason: x.reason })),
  run(a, ctx) {
    const p = project(ctx, a);
    let list = p.runs.filter((r) => !a.pipeline_ids || a.pipeline_ids.includes(r.pipelineId)).filter((r) => !a.result || r.status === a.result);
    if (a.top) list = list.slice(0, a.top);
    return list.map((r) => runJson(p, r));
  },
});

register({
  path: 'pipelines runs show',
  summary: 'Muestra una ejecución.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. de la ejecución.', required: true }, projArg, orgArg, { name: 'open', opts: ['--open'], help: 'Abrir.', type: 'bool' }],
  run(a, ctx) {
    const p = project(ctx, a);
    const r = findRun(p, a.id);
    if (a.open) ctx.sess.ui.openUrl?.(`#/devops/${encodeURIComponent(p.name)}/pipelines/runs/${r.id}`);
    return { ...runJson(p, r), stages: r.stages.map((s) => ({ name: s.name, status: s.status, jobs: s.jobs.map((j) => ({ name: j.displayName, status: j.status })) })) };
  },
});

register({
  path: 'pipelines runs cancel',
  summary: 'Cancela una ejecución.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', required: true }, projArg, orgArg],
  run(a, ctx) {
    cancelRun(project(ctx, a), a.id);
    return undefined;
  },
});

register({
  path: 'pipelines runs approve',
  summary: 'Aprueba (o rechaza) la fase pendiente de una ejecución (simulador).',
  args: [{ name: 'id', opts: ['--id'], help: 'Id. de la ejecución.', required: true }, { name: 'stage', opts: ['--stage'], help: 'Fase.', required: true }, { name: 'reject', opts: ['--reject'], help: 'Rechazar.', type: 'bool' }, projArg, orgArg],
  run(a, ctx) {
    approveStage(project(ctx, a), a.id, a.stage, !a.reject, who(ctx));
    return undefined;
  },
});

register({
  path: 'pipelines variable create',
  summary: 'Crea una variable de pipeline (opcionalmente secreta).',
  args: [{ name: 'pipeline_name', opts: ['--pipeline-name'], help: 'Pipeline.', required: true }, { name: 'name', opts: ['--name'], help: 'Nombre.', required: true }, { name: 'value', opts: ['--value'], help: 'Valor.' }, { name: 'secret', opts: ['--secret'], help: 'Secreta.', type: 'bool' }, { name: 'allow_override', opts: ['--allow-override'], help: 'Permitir sobrescribir al ejecutar.', type: 'bool' }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const pl = pipelineArg(p, { name: a.pipeline_name });
    pl.variables[a.name] = { value: a.value ?? '', isSecret: !!a.secret };
    changed();
    return { [a.name]: { allowOverride: !!a.allow_override, isSecret: !!a.secret, value: a.secret ? null : a.value } };
  },
});

register({
  path: 'pipelines variable list',
  summary: 'Lista las variables de un pipeline.',
  args: [{ name: 'pipeline_name', opts: ['--pipeline-name'], help: 'Pipeline.', required: true }, projArg, orgArg],
  run(a, ctx) {
    const pl = pipelineArg(project(ctx, a), { name: a.pipeline_name });
    return Object.fromEntries(Object.entries(pl.variables).map(([k, v]) => [k, { isSecret: v.isSecret, value: v.isSecret ? null : v.value }]));
  },
});

register({
  path: 'pipelines variable-group create',
  summary: 'Crea un grupo de variables (Library).',
  args: [{ name: 'name', opts: ['--name'], help: 'Nombre.', required: true }, { name: 'variables', opts: ['--variables'], help: 'Variables nombre=valor.', type: 'kv', required: true }, { name: 'authorize', opts: ['--authorize'], help: 'Autorizar para todos los pipelines.', type: 'bool' }, projArg, orgArg],
  run(a, ctx) {
    const p = project(ctx, a);
    const vg = { id: String(p.variableGroups.length + 1), name: a.name, variables: Object.fromEntries(Object.entries<string>(a.variables).map(([k, v]) => [k, { value: v, isSecret: false }])) };
    p.variableGroups = [...p.variableGroups.filter((x) => !ciEq(x.name, a.name)), vg];
    changed();
    return { id: Number(vg.id), name: vg.name, variables: vg.variables };
  },
});

register({
  path: 'pipelines variable-group list',
  summary: 'Lista los grupos de variables.',
  args: [projArg, orgArg],
  run: (a, ctx) => project(ctx, a).variableGroups.map((v) => ({ id: Number(v.id), name: v.name, variables: Object.fromEntries(Object.entries(v.variables).map(([k, x]) => [k, { isSecret: x.isSecret, value: x.isSecret ? null : x.value }])) })),
});

// ---------------------------------------------------------------- boards

register({
  path: 'boards work-item create',
  summary: 'Crea un elemento de trabajo.',
  args: [{ name: 'title', opts: ['--title'], help: 'Título.', required: true }, { name: 'type', opts: ['--type'], help: 'Tipo.', required: true, choices: ['Epic', 'User Story', 'Task', 'Bug'] }, { name: 'assigned_to', opts: ['--assigned-to'], help: 'Asignado a.' }, projArg, orgArg],
  run(a, ctx) {
    const wi = createWorkItem(project(ctx, a), a.type, a.title, a.assigned_to);
    return { fields: { 'System.State': wi.state, 'System.Title': wi.title, 'System.WorkItemType': wi.type, 'System.AssignedTo': wi.assignedTo ?? null }, id: wi.id };
  },
});

register({
  path: 'boards work-item show',
  summary: 'Muestra un elemento de trabajo.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', type: 'int', required: true }, orgArg, projArg],
  run(a, ctx) {
    const wi = project(ctx, a).workItems.find((w) => w.id === a.id);
    if (!wi) throw new ArmError('DevOpsError', `TF401232: Work item ${a.id} does not exist.`, 404);
    const p = project(ctx, a);
    // Relaciones "Development" como las de la API real (ArtifactLink a PR y commits).
    const relations = (wi.links ?? []).map((l) => ({ attributes: { name: l.kind === 'pr' ? 'Pull Request' : 'Fixed in Commit', comment: l.title }, rel: 'ArtifactLink', url: l.kind === 'pr' ? `vstfs:///Git/PullRequestId/${p.id}%2F${l.repo}%2F${l.id}` : `vstfs:///Git/Commit/${p.id}%2F${l.repo}%2F${l.id}` }));
    return { fields: { 'System.State': wi.state, 'System.Title': wi.title, 'System.WorkItemType': wi.type, ...(wi.assignedTo ? { 'System.AssignedTo': wi.assignedTo } : {}) }, id: wi.id, relations: relations.length ? relations : null };
  },
});

register({
  path: 'boards work-item update',
  summary: 'Actualiza un elemento de trabajo.',
  args: [{ name: 'id', opts: ['--id'], help: 'Id.', type: 'int', required: true }, { name: 'state', opts: ['--state'], help: 'Estado.', choices: ['New', 'Active', 'Resolved', 'Closed'] }, { name: 'title', opts: ['--title'], help: 'Título.' }, orgArg, projArg],
  run(a, ctx) {
    const wi = project(ctx, a).workItems.find((w) => w.id === a.id);
    if (!wi) throw new ArmError('DevOpsError', `TF401232: Work item ${a.id} does not exist.`, 404);
    if (a.state) wi.state = a.state;
    if (a.title) wi.title = a.title;
    changed();
    return { fields: { 'System.State': wi.state, 'System.Title': wi.title }, id: wi.id };
  },
});

export function _devopsUnused() {
  return { findResource, parseResourceId, cliError };
}
