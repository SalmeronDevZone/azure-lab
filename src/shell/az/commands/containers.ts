// az acr / container / aks.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { authorize, deleteResource, findResource, hasPermission, putResource, logActivity, provisionDelay } from '../../../engine/arm';
import { resourceId } from '../../../engine/ids';
import { K8S_VERSIONS, K8S_DEFAULT_VERSION, normalizeImageName, findPublicImage } from '../../../engine/catalog';
import { ciEq, guid, nowIso, sleep } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { getRegistry, importImage, listRepositories, listTags, deleteImage, pushImage, canPush } from '../../../engine/services/acr';
import { createRoleAssignment, deleteRoleAssignments } from '../../../engine/services/identity';
import { kubeOf, kubeletPrincipal, resolveImage, syncNodes, clusterRunning } from '../../../engine/services/kube';
import { mergeKubeconfig } from '../../../engine/services/kubeconfig';
import { startupLog } from '../../../engine/services/appRuntime';
import { buildImage, BuildError } from '../../commands/dockerBuild';

const T_ACR = 'Microsoft.ContainerRegistry/registries';
const T_ACI = 'Microsoft.ContainerInstance/containerGroups';
const T_AKS = 'Microsoft.ContainerService/managedClusters';

group('acr', 'Administra registros privados de contenedores (Azure Container Registry).');
group('acr repository', 'Administra repositorios (imágenes) del registro.');
group('acr credential', 'Administra las credenciales de administrador del registro.');
group('container', 'Administra Azure Container Instances.');
group('aks', 'Administra Azure Kubernetes Service.');
group('aks nodepool', 'Administra los grupos de nodos de un clúster AKS.');
group('aks command', 'Ejecuta comandos en el clúster sin acceso directo a la API.');

const acrTable = (r: any) => (Array.isArray(r) ? r : [r]).map((x: any) => ({ Name: x.name, ResourceGroup: x.resourceGroup, Location: x.location, Sku: x.sku?.name, LoginServer: x.loginServer, CreationDate: x.creationDate, AdminEnabled: x.adminUserEnabled }));

function regArg(ctx: AzCtx, nameOrServer: string) {
  const r = getRegistry(nameOrServer);
  if (r.subscriptionId !== ctx.subscriptionId && !hasPermission(ctx.principal, `${T_ACR}/read`, r.id)) throw new ArmError('ResourceNotFound', `The resource with name '${nameOrServer}' and type '${T_ACR}' could not be found in subscription '${ctx.subscriptionId}'.`, 404);
  return r;
}

// ---------------------------------------------------------------- acr

register({
  path: 'acr create',
  summary: 'Crea un registro de contenedores.',
  args: [A.rg(), A.name('Nombre del registro (5-50 caracteres alfanuméricos, único en Azure).'), A.sku('SKU.', ['Basic', 'Standard', 'Premium']), A.location(), { name: 'admin_enabled', opts: ['--admin-enabled'], help: 'Habilita el usuario administrador.', type: 'bool' }, A.tags()],
  examples: [{ title: 'Registro básico.', cmd: 'az acr create -g rg-lab -n acrlabana --sku Basic' }],
  table: acrTable,
  longRunning: true,
  async run(a, ctx) {
    if (!a.sku) throw cliError('the following arguments are required: --sku', undefined, true);
    const rg = requireRg(ctx, a.resource_group);
    return flat(await putResource({ type: T_ACR, name: a.name, location: a.location, tags: a.tags, sku: { name: a.sku }, properties: { adminUserEnabled: !!a.admin_enabled } }, rg.name, op(ctx)));
  },
});

register({
  path: 'acr list',
  summary: 'Lista los registros.',
  args: [A.rg(false)],
  table: acrTable,
  run: (a, ctx) => listInSub(ctx, T_ACR, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'acr show',
  summary: 'Muestra un registro.',
  args: [A.name('Nombre del registro.', false), A.rg(false), A.ids()],
  table: acrTable,
  run(a, ctx) {
    if (!a.resource_group && a.name && !a.ids?.length) return flat(regArg(ctx, a.name));
    return flat(getRes(ctx, a, T_ACR));
  },
});

register({
  path: 'acr update',
  summary: 'Actualiza un registro (usuario administrador, SKU, extracción anónima).',
  args: [A.name('Nombre del registro.'), A.rg(false), { name: 'admin_enabled', opts: ['--admin-enabled'], help: 'Usuario administrador.', type: 'bool' }, { name: 'sku', opts: ['--sku'], help: 'SKU.', choices: ['Basic', 'Standard', 'Premium'] }, { name: 'anonymous_pull_enabled', opts: ['--anonymous-pull-enabled'], help: 'Extracción anónima (requiere Standard/Premium).', type: 'bool' }, A.tags()],
  async run(a, ctx) {
    const r = regArg(ctx, a.name);
    if (a.anonymous_pull_enabled && (a.sku ?? r.sku?.name) === 'Basic') throw new ArmError('BadRequest', 'Anonymous pull is not supported for Basic SKU registries.', 400);
    return flat(await putResource({ type: T_ACR, name: r.name, location: r.location, tags: a.tags ?? r.tags, sku: { name: a.sku ?? r.sku!.name }, properties: { ...r.properties, adminUserEnabled: a.admin_enabled ?? r.properties.adminUserEnabled, anonymousPullEnabled: a.anonymous_pull_enabled ?? r.properties.anonymousPullEnabled } }, r.resourceGroup, op(ctx)));
  },
});

register({
  path: 'acr delete',
  summary: 'Elimina un registro y todas sus imágenes.',
  args: [A.name('Nombre del registro.'), A.rg(false), A.yes()],
  confirm: 'Are you sure you want to delete the registry?',
  async run(a, ctx) {
    await deleteResource(regArg(ctx, a.name).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'acr login',
  summary: 'Inicia sesión en el registro con tu identidad de Azure (para docker push/pull).',
  args: [A.name('Nombre del registro.'), { name: 'expose_token', opts: ['--expose-token', '-t'], help: 'Devuelve un token en lugar de configurar Docker.', type: 'bool' }, { name: 'username', opts: ['--username', '-u'], help: 'Usuario (administrador).' }, { name: 'password', opts: ['--password', '-p'], help: 'Contraseña.' }],
  run(a, ctx) {
    const r = regArg(ctx, a.name);
    if (a.username) {
      const ok = r.properties.adminUserEnabled && ciEq(a.username, r.name) && (r.data?.passwords ?? []).some((p: any) => p.value === a.password);
      if (!ok) throw new ArmError('CliError', `Error response from daemon: Get "https://${r.properties.loginServer}/v2/": unauthorized: authentication required, visit https://aka.ms/acr/authorization for more information.`, 1);
    } else if (!hasPermission(ctx.principal, 'Microsoft.ContainerRegistry/registries/pull/read', r.id) && !hasPermission(ctx.principal, `${T_ACR}/read`, r.id)) {
      throw new ArmError('CliError', `The resource with name '${a.name}' and type '${T_ACR}' could not be found in subscription. (o no tienes permisos sobre el registro)`, 1);
    }
    if (a.expose_token) return { accessToken: `eyJhbGciOiJSUzI1NiIs.${btoa(ctx.principal.objectId).slice(0, 30)}.${guid().slice(0, 20)}`, loginServer: r.properties.loginServer };
    const logins = new Set(ctx.sess.az.acrLogins.map((x) => x.toLowerCase()));
    logins.add(r.properties.loginServer);
    ctx.sess.az.acrLogins = [...logins];
    ctx.sess.az.dockerLogins = [...new Set([...ctx.sess.az.dockerLogins, r.properties.loginServer])];
    ctx.sess.az.persist();
    ctx.io.out('Login Succeeded\n');
    return undefined;
  },
});

register({
  path: 'acr build',
  summary: 'Compila una imagen en la nube con ACR Tasks y la sube al registro (no necesita Docker local).',
  positional: 'source',
  args: [{ name: 'registry', opts: ['--registry', '-r'], help: 'Registro.', required: true }, { name: 'image', opts: ['--image', '-t'], help: 'Nombre y etiqueta, p. ej. app-node:v1.', type: 'list', append: true }, { name: 'file', opts: ['--file', '-f'], help: 'Ruta del Dockerfile (relativa al contexto).' }, { name: 'build_arg', opts: ['--build-arg'], help: 'Argumentos de compilación CLAVE=VALOR.', type: 'list', append: true }, { name: 'no_push', opts: ['--no-push'], help: 'No sube la imagen.', type: 'bool' }, { name: 'source', opts: ['--source-location'], help: 'Contexto de compilación (directorio).', type: 'list' }, A.rg(false), { name: 'no_logs', opts: ['--no-logs'], help: 'No muestra los registros.', type: 'bool' }],
  examples: [{ title: 'Compilar y subir desde el directorio actual.', cmd: 'cd ~/samples/app-node && az acr build -r acrlabana -t app-node:v1 .' }],
  async run(a, ctx) {
    const reg = regArg(ctx, a.registry);
    authorize(ctx.principal, 'Microsoft.ContainerRegistry/registries/scheduleRun/action', reg.id);
    const src = (a.source ?? [])[0];
    if (!src) throw cliError('the following arguments are required: <SOURCE_LOCATION>', 'Indica el directorio con el Dockerfile, normalmente "." (el directorio actual).', true);
    const dir = ctx.sess.resolve(src);
    if (!ctx.sess.fs.isDir(dir)) throw cliError(`Source location should be a local directory path or remote URL. '${src}' no es un directorio.`);
    const runId = `c${Math.floor(Math.random() * 30 + 1).toString(36)}${Math.floor(Math.random() * 9)}`;
    const out = (l: string) => ctx.io.out(l + '\n');
    out('Packing source code into tar to upload...');
    out(`Uploading archived source code from '/tmp/build_archive_${guid().slice(0, 32)}.tar.gz'...`);
    out(`Sending context (${(JSON.stringify(ctx.sess.fs.snapshot(dir)).length / 1024).toFixed(3)} KiB) to registry: ${reg.name}...`);
    out(`Queued a build with ID: ${runId}`);
    out('Waiting for an agent...');
    await sleep(provisionDelay(900));
    const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');
    out(`${ts()} Downloading source code...`);
    out(`${ts()} Finished downloading source code`);
    out(`${ts()} Using acb_vol_${guid().slice(0, 8)} as the home volume`);
    out(`${ts()} Setting up Docker configuration...`);
    out(`${ts()} Successfully set up Docker configuration`);
    out(`${ts()} Logging in to registry: ${reg.properties.loginServer}`);
    out(`${ts()} Successfully logged into ${reg.properties.loginServer}`);
    out(`${ts()} Executing step ID: build. Timeout(sec): 28800, Working directory: '', Network: ''`);
    const tags: string[] = (a.image ?? []).map((t: string) => (t.includes('/') && t.includes('.') ? t : `${reg.properties.loginServer}/${t}`));
    out(`${ts()} Scanning for dependencies...`);
    let img;
    try {
      img = buildImage({ fs: ctx.sess.fs, contextDir: dir, dockerfile: a.file, acrLogins: [reg.properties.loginServer], principal: ctx.principal, buildArgs: Object.fromEntries((a.build_arg ?? []).map((x: string) => x.split('='))) });
    } catch (e) {
      if (e instanceof BuildError) {
        out(e.message);
        throw new ArmError('CliError', `Run ID: ${runId} failed after 15s. Error: failed during run, err: exit status 1`, 1);
      }
      throw e;
    }
    out(`${ts()} Successfully obtained source code and scanned for dependencies`);
    out(`${ts()} Launching container with name: build`);
    img.steps.forEach((s, i) => out(`Step ${i + 1}/${img!.steps.length} : ${s.replace(/^\[\d+\/\d+\]\s*/, '')}`));
    out(`Successfully built ${guid().slice(0, 12)}`);
    for (const t of tags) out(`Successfully tagged ${t}`);
    await sleep(provisionDelay(1200));
    if (!a.no_push) {
      out(`${ts()} Executing step ID: push. Timeout(sec): 3600, Working directory: '', Network: ''`);
      for (const t of tags) {
        const { repo, tag } = normalizeImageName(t);
        out(`${ts()} Pushing image: ${t}, attempt 1`);
        const digest = pushImage(reg, repo, tag, { files: img.files, env: img.env, exposed: img.exposed, cmd: img.cmd, size: img.size, base: img.base });
        out(`${tag}: digest: ${digest} size: 1578`);
      }
      out(`${ts()} Successfully pushed image: ${tags.join(', ')}`);
    }
    out(`${ts()} Step ID: build marked as successful (elapsed time in seconds: 12.4)`);
    out(`Run ID: ${runId} was successful after 19s`);
    logActivity({ operationNameValue: 'Microsoft.ContainerRegistry/registries/scheduleRun/action', operationName: `ACR build ${tags.join(', ')}`, status: 'Succeeded', resourceId: reg.id, subscriptionId: reg.subscriptionId, caller: ctx.principal.name });
    return undefined;
  },
});

register({
  path: 'acr import',
  summary: 'Importa una imagen pública u otra imagen al registro.',
  args: [A.name('Registro de destino.'), { name: 'source', opts: ['--source'], help: 'Imagen de origen, p. ej. docker.io/library/nginx:latest.', required: true }, { name: 'image', opts: ['--image', '-t'], help: 'Nombre de destino, p. ej. nginx:v1.', type: 'list' }, A.rg(false)],
  longRunning: true,
  async run(a, ctx) {
    const reg = regArg(ctx, a.name);
    const target = (a.image ?? [])[0] ?? a.source.split('/').pop();
    await sleep(provisionDelay(1500));
    importImage(reg, a.source, target, ctx.principal);
    return undefined;
  },
});

register({
  path: 'acr repository list',
  summary: 'Lista los repositorios del registro.',
  args: [A.name('Nombre del registro.')],
  run: (a, ctx) => listRepositories(regArg(ctx, a.name), ctx.principal),
});

register({
  path: 'acr repository show-tags',
  summary: 'Lista las etiquetas de un repositorio.',
  args: [A.name('Nombre del registro.'), { name: 'repository', opts: ['--repository'], help: 'Repositorio.', required: true }, { name: 'detail', opts: ['--detail'], help: 'Muestra detalles.', type: 'bool' }, { name: 'orderby', opts: ['--orderby'], help: 'Orden.', choices: ['time_asc', 'time_desc'] }],
  table: (r: any[]) => r.map((t) => (typeof t === 'string' ? { Result: t } : { Name: t.name, LastUpdateTime: t.lastUpdateTime })),
  run(a, ctx) {
    const tags = listTags(regArg(ctx, a.name), a.repository, ctx.principal);
    if (a.orderby === 'time_desc') tags.reverse();
    return a.detail ? tags : tags.map((t) => t.name);
  },
});

register({
  path: 'acr repository show',
  summary: 'Muestra un repositorio o una imagen.',
  args: [A.name('Nombre del registro.'), { name: 'repository', opts: ['--repository'], help: 'Repositorio.' }, { name: 'image', opts: ['--image', '-t'], help: 'Imagen repo:etiqueta.' }],
  run(a, ctx) {
    const reg = regArg(ctx, a.name);
    const repo = a.repository ?? String(a.image ?? '').split(':')[0];
    const r = reg.data?.repos?.[repo];
    if (!r) throw new ArmError('RepositoryNotFound', `repository ${repo} is not found.`, 404);
    return { changeableAttributes: { deleteEnabled: true, listEnabled: true, readEnabled: true, writeEnabled: true }, createdTime: r.created, imageName: repo, lastUpdateTime: r.lastUpdate, manifestCount: Object.keys(r.tags).length, registry: reg.properties.loginServer, tagCount: Object.keys(r.tags).length };
  },
});

register({
  path: 'acr repository delete',
  summary: 'Elimina un repositorio o una imagen.',
  args: [A.name('Nombre del registro.'), { name: 'repository', opts: ['--repository'], help: 'Repositorio completo.' }, { name: 'image', opts: ['--image', '-t'], help: 'Imagen repo:etiqueta.' }, A.yes()],
  confirm: 'This operation will delete the manifest and all the images it references. Are you sure you want to continue?',
  run(a, ctx) {
    const reg = regArg(ctx, a.name);
    if (a.image) {
      const [repo, tag] = String(a.image).split(':');
      deleteImage(reg, repo, tag ?? 'latest', ctx.principal);
    } else if (a.repository) deleteImage(reg, a.repository, null, ctx.principal);
    else throw cliError('usage error: --image IMAGE | --repository REPO', undefined, true);
    return undefined;
  },
});

register({
  path: 'acr credential show',
  summary: 'Muestra las credenciales del usuario administrador.',
  args: [A.name('Nombre del registro.'), A.rg(false)],
  run(a, ctx) {
    const reg = regArg(ctx, a.name);
    authorize(ctx.principal, 'Microsoft.ContainerRegistry/registries/listCredentials/action', reg.id);
    if (!reg.properties.adminUserEnabled) throw new ArmError('CliError', `Run 'az acr update -n ${reg.name} --admin-enabled true' to enable admin first.`, 1, 'El usuario administrador está deshabilitado (recomendado). Usa identidades administradas o entidades de servicio con AcrPull/AcrPush.');
    return { passwords: reg.data!.passwords, username: reg.name };
  },
});

register({
  path: 'acr credential renew',
  summary: 'Regenera una contraseña del administrador.',
  args: [A.name('Nombre del registro.'), { name: 'password_name', opts: ['--password-name'], help: 'Contraseña.', choices: ['password', 'password2'], required: true }],
  run(a, ctx) {
    const reg = regArg(ctx, a.name);
    authorize(ctx.principal, 'Microsoft.ContainerRegistry/registries/regenerateCredential/action', reg.id);
    const p = reg.data!.passwords.find((x: any) => x.name === a.password_name);
    p.value = guid().replace(/-/g, '').slice(0, 30) + 'Ab+';
    changed();
    return { passwords: reg.data!.passwords, username: reg.name };
  },
});

// ---------------------------------------------------------------- container (ACI)

const aciTable = (r: any) => (Array.isArray(r) ? r : [r]).map((c: any) => ({ Name: c.name, ResourceGroup: c.resourceGroup, Status: c.provisioningState, Image: c.containers?.[0]?.image ?? c.containers?.[0]?.properties?.image, IP: c.ipAddress ? `${c.ipAddress.ip}:${(c.ipAddress.ports ?? []).map((p: any) => p.port).join(',')}` : '', Network: c.ipAddress?.type ?? 'Private', CPU: c.containers?.[0]?.properties?.resources?.requests?.cpu, MemoryGB: c.containers?.[0]?.properties?.resources?.requests?.memoryInGB, OsType: c.osType, Location: c.location }));

register({
  path: 'container create',
  summary: 'Crea un grupo de contenedores (Azure Container Instances).',
  args: [
    A.rg(),
    A.name('Nombre del grupo de contenedores (minúsculas, números y guiones).'),
    { name: 'image', opts: ['--image'], help: 'Imagen, p. ej. mcr.microsoft.com/azuredocs/aci-helloworld o miacr.azurecr.io/app:v1.', required: true },
    A.location(),
    { name: 'cpu', opts: ['--cpu'], help: 'vCPU.', type: 'float', default: 1 },
    { name: 'memory', opts: ['--memory'], help: 'Memoria en GB.', type: 'float', default: 1.5 },
    { name: 'ports', opts: ['--ports'], help: 'Puertos a exponer.', type: 'list' },
    { name: 'ip_address', opts: ['--ip-address'], help: 'Tipo de IP.', choices: ['Public', 'Private'] },
    { name: 'dns_name_label', opts: ['--dns-name-label'], help: 'Etiqueta DNS: <etiqueta>.<region>.azurecontainer.io' },
    { name: 'os_type', opts: ['--os-type'], help: 'SO.', choices: ['Linux', 'Windows'], default: 'Linux' },
    { name: 'environment_variables', opts: ['--environment-variables', '-e'], help: 'Variables CLAVE=VALOR.', type: 'kv' },
    { name: 'secure_environment_variables', opts: ['--secure-environment-variables'], help: 'Variables seguras.', type: 'kv' },
    { name: 'registry_login_server', opts: ['--registry-login-server'], help: 'Servidor del registro privado.' },
    { name: 'registry_username', opts: ['--registry-username'], help: 'Usuario del registro (admin o appId de SP).' },
    { name: 'registry_password', opts: ['--registry-password'], help: 'Contraseña del registro.' },
    { name: 'restart_policy', opts: ['--restart-policy'], help: 'Política de reinicio.', choices: ['Always', 'OnFailure', 'Never'], default: 'Always' },
    { name: 'command_line', opts: ['--command-line'], help: 'Comando de inicio.' },
    { name: 'assign_identity', opts: ['--assign-identity'], help: 'Identidad.', type: 'list' },
    A.tags(),
    A.noWait(),
  ],
  examples: [{ title: 'Contenedor público con DNS.', cmd: 'az container create -g rg-lab -n aci-hello --image mcr.microsoft.com/azuredocs/aci-helloworld --ports 80 --dns-name-label aci-hello-ana --os-type Linux --cpu 1 --memory 1.5' }],
  table: aciTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const { registry } = normalizeImageName(a.image);
    if (registry?.endsWith('.azurecr.io') && !a.registry_username) {
      ctx.warn('Image registry credentials are not provided. Si la imagen es privada de ACR, añade --registry-login-server, --registry-username y --registry-password.');
    }
    const ports = (a.ports ?? ['80']).map((p: string) => ({ port: Number(p), protocol: 'TCP' }));
    const envs = [...Object.entries<string>(a.environment_variables ?? {}).map(([name, value]) => ({ name, value })), ...Object.entries<string>(a.secure_environment_variables ?? {}).map(([name, secureValue]) => ({ name, secureValue }))];
    const r = await putResource(
      {
        type: T_ACI,
        name: a.name,
        location: a.location,
        tags: a.tags,
        identity: a.assign_identity ? { type: 'SystemAssigned' } : undefined,
        properties: {
          containers: [{ name: a.name, properties: { image: a.image, ports, environmentVariables: envs, command: a.command_line ? a.command_line.split(' ') : [], resources: { requests: { cpu: a.cpu, memoryInGB: a.memory } } } }],
          osType: a.os_type,
          restartPolicy: a.restart_policy,
          ipAddress: a.ip_address === 'Private' ? undefined : a.ip_address === 'Public' || a.dns_name_label || a.ports ? { type: 'Public', ports, dnsNameLabel: a.dns_name_label } : undefined,
          imageRegistryCredentials: a.registry_username ? [{ server: a.registry_login_server ?? registry, username: a.registry_username, password: a.registry_password }] : [],
        },
      },
      rg.name,
      op(ctx, a),
    );
    return flat(r);
  },
});

register({
  path: 'container list',
  summary: 'Lista los grupos de contenedores.',
  args: [A.rg(false)],
  table: aciTable,
  run: (a, ctx) => listInSub(ctx, T_ACI, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'container show',
  summary: 'Muestra un grupo de contenedores.',
  args: [A.rg(false), A.name('Nombre.', false), A.ids()],
  table: aciTable,
  run: (a, ctx) => flat(getRes(ctx, a, T_ACI)),
});

register({
  path: 'container logs',
  summary: 'Muestra los registros de un contenedor.',
  args: [A.rg(false), A.name('Nombre.', false), A.ids(), { name: 'container_name', opts: ['--container-name'], help: 'Contenedor.' }, { name: 'follow', opts: ['--follow'], help: 'Seguir.', type: 'bool' }],
  run(a, ctx) {
    const cg = getRes(ctx, a, T_ACI);
    const c = cg.properties.containers[0];
    const pkg = cg.data?.pkgs?.[c.name] ?? { files: {}, publicImage: findPublicImage(c.properties.image)?.name };
    const lines = startupLog(pkg);
    for (const e of getState().events.filter((x) => x.kind === 'http' && ciEq(x.resourceId, cg.id))) lines.push(`::ffff:20.31.118.42 - - [${new Date(e.t).toUTCString()}] "GET ${e.path ?? '/'} HTTP/1.1" ${e.status} - "-" "curl/8.5.0"`);
    ctx.io.out(lines.join('\n') + '\n');
    return undefined;
  },
});

for (const [verb, state] of [['start', 'Running'], ['stop', 'Stopped'], ['restart', 'Running']] as const) {
  register({
    path: `container ${verb}`,
    summary: verb === 'start' ? 'Inicia un grupo de contenedores.' : verb === 'stop' ? 'Detiene un grupo de contenedores (deja de facturar).' : 'Reinicia un grupo de contenedores.',
    args: [A.rg(false), A.name('Nombre.', false), A.ids(), A.noWait()],
    longRunning: true,
    async run(a, ctx) {
      const cg = getRes(ctx, a, T_ACI);
      authorize(ctx.principal, `${T_ACI}/${verb}/action`, cg.id);
      await sleep(provisionDelay(1500));
      cg.data!.state = state;
      cg.properties.instanceView = { state };
      changed();
      return undefined;
    },
  });
}

register({
  path: 'container delete',
  summary: 'Elimina un grupo de contenedores.',
  args: [A.rg(false), A.name('Nombre.', false), A.ids(), A.yes()],
  confirm: 'Are you sure you want to perform this operation?',
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_ACI).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'container exec',
  summary: 'Ejecuta un comando en un contenedor en ejecución.',
  args: [A.rg(false), A.name('Nombre.', false), { name: 'exec_command', opts: ['--exec-command'], help: 'Comando.', required: true }, { name: 'container_name', opts: ['--container-name'], help: 'Contenedor.' }],
  run(a, ctx) {
    const cg = getRes(ctx, a, T_ACI);
    if (/^(\/bin\/)?(ba)?sh$/.test(a.exec_command)) ctx.io.out(`# (shell interactivo no disponible en el simulador)\n`);
    else if (/^ls/.test(a.exec_command)) ctx.io.out(Object.keys(cg.data?.pkgs?.[cg.properties.containers[0].name]?.files ?? {}).join('\n') + '\n');
    else ctx.io.out(`(simulado) ${a.exec_command}\n`);
    return undefined;
  },
});

// ---------------------------------------------------------------- aks

const aksTable = (r: any) => (Array.isArray(r) ? r : [r]).map((c: any) => ({ Name: c.name, Location: c.location, ResourceGroup: c.resourceGroup, KubernetesVersion: c.kubernetesVersion, CurrentKubernetesVersion: c.currentKubernetesVersion, ProvisioningState: c.provisioningState, Fqdn: c.fqdn }));

function attachAcr(ctx: AzCtx, cluster: any, acr: string) {
  const reg = regArg(ctx, acr.includes('/') ? acr.split('/').pop()! : acr);
  const kid = cluster.properties.identityProfile.kubeletidentity.objectId;
  try {
    createRoleAssignment({ assignee: kid, role: 'AcrPull', scope: reg.id }, ctx.principal);
  } catch (e: any) {
    if (e?.code === 'RoleAssignmentExists') return;
    if (e?.code === 'AuthorizationFailed') throw new ArmError('CliError', `Could not create a role assignment for ACR. Are you an Owner on this subscription?`, 1, 'Adjuntar un ACR crea una asignación de rol AcrPull: necesitas permisos de Owner o User Access Administrator.');
    throw e;
  }
}

register({
  path: 'aks create',
  summary: 'Crea un clúster de Kubernetes administrado (AKS).',
  args: [
    A.rg(),
    A.name('Nombre del clúster.'),
    A.location(),
    { name: 'node_count', opts: ['--node-count', '-c'], help: 'Número de nodos del grupo de sistema.', type: 'int', default: 3 },
    { name: 'node_vm_size', opts: ['--node-vm-size', '-s'], help: 'Tamaño de los nodos.', default: 'Standard_D2s_v5' },
    { name: 'nodepool_name', opts: ['--nodepool-name'], help: 'Nombre del grupo de nodos.', default: 'nodepool1' },
    { name: 'kubernetes_version', opts: ['--kubernetes-version', '-k'], help: `Versión (${K8S_VERSIONS.join(', ')}).` },
    { name: 'generate_ssh_keys', opts: ['--generate-ssh-keys'], help: 'Genera claves SSH.', type: 'bool' },
    { name: 'attach_acr', opts: ['--attach-acr'], help: 'Concede AcrPull a la identidad kubelet sobre este ACR.' },
    { name: 'enable_addons', opts: ['--enable-addons', '-a'], help: 'Complementos: monitoring, azure-keyvault-secrets-provider...' },
    { name: 'workspace_resource_id', opts: ['--workspace-resource-id'], help: 'Área de trabajo de Log Analytics para monitoring.' },
    { name: 'network_plugin', opts: ['--network-plugin'], help: 'Plugin de red.', choices: ['azure', 'kubenet', 'none'] },
    { name: 'network_policy', opts: ['--network-policy'], help: 'Directiva de red.', choices: ['azure', 'calico', 'cilium', 'none'] },
    { name: 'tier', opts: ['--tier'], help: 'Nivel del plano de control.', choices: ['free', 'standard', 'premium'], default: 'free' },
    { name: 'enable_cluster_autoscaler', opts: ['--enable-cluster-autoscaler'], help: 'Escalado automático de nodos.', type: 'bool' },
    { name: 'min_count', opts: ['--min-count'], help: 'Mínimo de nodos.', type: 'int' },
    { name: 'max_count', opts: ['--max-count'], help: 'Máximo de nodos.', type: 'int' },
    { name: 'enable_managed_identity', opts: ['--enable-managed-identity'], help: 'Usa identidad administrada (por defecto).', type: 'bool' },
    { name: 'enable_oidc_issuer', opts: ['--enable-oidc-issuer'], help: 'Emisor OIDC.', type: 'bool' },
    { name: 'enable_workload_identity', opts: ['--enable-workload-identity'], help: 'Identidad de carga de trabajo.', type: 'bool' },
    { name: 'dns_name_prefix', opts: ['--dns-name-prefix', '-p'], help: 'Prefijo DNS.' },
    { name: 'node_resource_group', opts: ['--node-resource-group'], help: 'Grupo de recursos de nodos.' },
    { name: 'zones', opts: ['--zones', '-z'], help: 'Zonas.', type: 'list' },
    A.tags(),
    A.noWait(),
  ],
  examples: [{ title: 'Clúster pequeño conectado a un ACR.', cmd: 'az aks create -g rg-lab -n aks-lab --node-count 2 --node-vm-size Standard_B2s --generate-ssh-keys --attach-acr acrlabana' }],
  table: aksTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    if (a.enable_cluster_autoscaler && (a.min_count === undefined || a.max_count === undefined)) throw cliError('Please specify both min-count and max-count when --enable-cluster-autoscaler enabled', undefined, true);
    if (a.attach_acr) regArg(ctx, a.attach_acr);
    const addons: Record<string, any> = {};
    for (const ad of String(a.enable_addons ?? '').split(',').filter(Boolean)) {
      if (ad === 'monitoring') {
        if (!a.workspace_resource_id) throw cliError('Para el complemento monitoring indica --workspace-resource-id (en el simulador no se crea un área de trabajo predeterminada).');
        addons.omsagent = { enabled: true, config: { logAnalyticsWorkspaceResourceID: a.workspace_resource_id } };
      } else addons[ad === 'azure-keyvault-secrets-provider' ? 'azureKeyvaultSecretsProvider' : ad] = { enabled: true, config: {} };
    }
    const p = putResource(
      {
        type: T_AKS,
        name: a.name,
        location: a.location,
        tags: a.tags,
        sku: { name: 'Base', tier: a.tier === 'free' ? 'Free' : a.tier === 'standard' ? 'Standard' : 'Premium' },
        identity: { type: 'SystemAssigned' },
        properties: {
          kubernetesVersion: a.kubernetes_version ?? K8S_DEFAULT_VERSION,
          dnsPrefix: a.dns_name_prefix,
          nodeResourceGroup: a.node_resource_group,
          agentPoolProfiles: [{ name: a.nodepool_name, count: a.node_count, vmSize: a.node_vm_size, mode: 'System', enableAutoScaling: !!a.enable_cluster_autoscaler, minCount: a.min_count, maxCount: a.max_count }],
          networkProfile: { networkPlugin: a.network_plugin, networkPolicy: a.network_policy },
          addonProfiles: addons,
          oidcIssuerProfile: { enabled: !!a.enable_oidc_issuer || !!a.enable_workload_identity },
          securityProfile: a.enable_workload_identity ? { workloadIdentity: { enabled: true } } : {},
        },
      },
      rg.name,
      op(ctx, a),
    );
    const cluster = await p;
    if (a.attach_acr) {
      const doAttach = () => attachAcr(ctx, findResource(cluster.id) ?? cluster, a.attach_acr);
      if (a.no_wait) setTimeout(() => { try { doAttach(); } catch { /* ignorado */ } }, provisionDelay(7000) + 100);
      else doAttach();
    }
    if (a.no_wait) return undefined;
    return flat(cluster);
  },
});

register({
  path: 'aks list',
  summary: 'Lista los clústeres AKS.',
  args: [A.rg(false)],
  table: aksTable,
  run: (a, ctx) => listInSub(ctx, T_AKS, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'aks show',
  summary: 'Muestra un clúster AKS.',
  args: [A.rg(false), A.name('Nombre del clúster.', false), A.ids()],
  table: aksTable,
  run: (a, ctx) => flat(getRes(ctx, a, T_AKS)),
});

register({
  path: 'aks delete',
  summary: 'Elimina un clúster AKS (y su grupo de recursos de nodos).',
  args: [A.rg(false), A.name('Nombre del clúster.', false), A.ids(), A.yes(), A.noWait()],
  confirm: 'Are you sure you want to perform this operation?',
  longRunning: true,
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_AKS).id, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'aks get-credentials',
  summary: 'Descarga las credenciales del clúster y las fusiona en ~/.kube/config (para kubectl).',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'admin', opts: ['--admin', '-a'], help: 'Credenciales de administrador.', type: 'bool' }, { name: 'overwrite_existing', opts: ['--overwrite-existing'], help: 'Sobrescribe entradas existentes.', type: 'bool' }, { name: 'file', opts: ['--file', '-f'], help: 'Fichero kubeconfig.', default: '~/.kube/config' }, { name: 'context', opts: ['--context'], help: 'Nombre del contexto.' }],
  examples: [{ title: 'Configurar kubectl.', cmd: 'az aks get-credentials -g rg-lab -n aks-lab && kubectl get nodes' }],
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    authorize(ctx.principal, `Microsoft.ContainerService/managedClusters/${a.admin ? 'listClusterAdminCredential' : 'listClusterUserCredential'}/action`, c.id);
    if (c.properties.provisioningState !== 'Succeeded') throw new ArmError('OperationNotAllowed', `Cluster '${c.name}' is still being provisioned (${c.properties.provisioningState}).`, 409);
    const path = ctx.sess.resolve(a.file);
    ctx.sess.fs.mkdir(path.split('/').slice(0, -1).join('/'), true);
    const existing = ctx.sess.fs.isFile(path) ? ctx.sess.fs.readFile(path) : undefined;
    let merged = mergeKubeconfig(existing, c, !!a.admin, !!a.overwrite_existing);
    if (merged.conflict) {
      const ok = ctx.io.prompt ? (await ctx.io.prompt(merged.conflict)).trim().toLowerCase().startsWith('y') : false;
      if (!ok) return undefined;
      merged = mergeKubeconfig(existing, c, !!a.admin, true);
    }
    ctx.sess.fs.writeFile(path, merged.text);
    if (ctx.sess.kind === 'cloudshell') {
      getState().cli.kubeContext = merged.context;
      changed();
    }
    ctx.io.err(`Merged "${merged.context}" as current context in ${path}\n`);
    return undefined;
  },
});

async function updateCluster(ctx: AzCtx, c: any, mut: (p: any) => void, a: Args = {}) {
  const props = JSON.parse(JSON.stringify(c.properties));
  mut(props);
  return putResource({ type: T_AKS, name: c.name, location: c.location, tags: c.tags, sku: c.sku, identity: c.identity, properties: props }, c.resourceGroup, op(ctx, a));
}

register({
  path: 'aks scale',
  summary: 'Cambia el número de nodos de un grupo de nodos.',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'node_count', opts: ['--node-count', '-c'], help: 'Número de nodos.', type: 'int', required: true }, { name: 'nodepool_name', opts: ['--nodepool-name'], help: 'Grupo de nodos.' }, A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    const pool = a.nodepool_name ?? c.properties.agentPoolProfiles[0].name;
    if (c.properties.agentPoolProfiles.find((p: any) => p.name === pool)?.enableAutoScaling) throw cliError('Cannot scale cluster autoscaler enabled node pool.', 'Desactiva el escalado automático del grupo de nodos o ajusta min/max.');
    const r = await updateCluster(ctx, c, (p) => {
      const pp = p.agentPoolProfiles.find((x: any) => x.name === pool);
      if (!pp) throw new ArmError('NotFound', `Node pool '${pool}' not found.`, 404);
      pp.count = a.node_count;
    }, a);
    syncNodes(kubeOf(r), r.id, r.properties.agentPoolProfiles, r.properties.kubernetesVersion, clusterRunning(r));
    return flat(r);
  },
});

register({
  path: 'aks update',
  summary: 'Actualiza un clúster (adjuntar/desadjuntar ACR, escalado automático, nivel).',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'attach_acr', opts: ['--attach-acr'], help: 'Concede AcrPull a la identidad kubelet.' }, { name: 'detach_acr', opts: ['--detach-acr'], help: 'Retira AcrPull.' }, { name: 'enable_cluster_autoscaler', opts: ['--enable-cluster-autoscaler', '-e'], help: 'Habilita el escalado automático.', type: 'bool' }, { name: 'disable_cluster_autoscaler', opts: ['--disable-cluster-autoscaler', '-d'], help: 'Deshabilita el escalado automático.', type: 'bool' }, { name: 'min_count', opts: ['--min-count'], help: 'Mínimo.', type: 'int' }, { name: 'max_count', opts: ['--max-count'], help: 'Máximo.', type: 'int' }, { name: 'tier', opts: ['--tier'], help: 'Nivel.', choices: ['free', 'standard', 'premium'] }, { name: 'enable_oidc_issuer', opts: ['--enable-oidc-issuer'], help: 'Emisor OIDC.', type: 'bool' }, A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    if (a.attach_acr) {
      attachAcr(ctx, c, a.attach_acr);
      return flat(c);
    }
    if (a.detach_acr) {
      const reg = regArg(ctx, a.detach_acr);
      deleteRoleAssignments({ assignee: c.properties.identityProfile.kubeletidentity.objectId, role: 'AcrPull', scope: reg.id }, ctx.principal);
      return flat(c);
    }
    const r = await updateCluster(ctx, c, (p) => {
      const pp = p.agentPoolProfiles[0];
      if (a.enable_cluster_autoscaler) Object.assign(pp, { enableAutoScaling: true, minCount: a.min_count, maxCount: a.max_count });
      if (a.disable_cluster_autoscaler) Object.assign(pp, { enableAutoScaling: false, minCount: null, maxCount: null });
      if (a.enable_oidc_issuer) p.oidcIssuerProfile = { enabled: true };
    }, a);
    if (a.tier) r.sku = { name: 'Base', tier: a.tier === 'free' ? 'Free' : a.tier === 'standard' ? 'Standard' : 'Premium' };
    return flat(r);
  },
});

register({
  path: 'aks upgrade',
  summary: 'Actualiza la versión de Kubernetes del clúster.',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'kubernetes_version', opts: ['--kubernetes-version', '-k'], help: 'Versión de destino.', required: true }, { name: 'control_plane_only', opts: ['--control-plane-only'], help: 'Sólo el plano de control.', type: 'bool' }, A.yes(), A.noWait()],
  confirm: 'Kubernetes may be unavailable during cluster upgrades.\n Are you sure you want to perform this operation?',
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    const r = await updateCluster(ctx, c, (p) => {
      p.kubernetesVersion = a.kubernetes_version;
      if (!a.control_plane_only) p.agentPoolProfiles = p.agentPoolProfiles.map((x: any) => ({ ...x, orchestratorVersion: a.kubernetes_version }));
    }, a);
    syncNodes(kubeOf(r), r.id, r.properties.agentPoolProfiles, r.properties.kubernetesVersion, clusterRunning(r));
    return flat(r);
  },
});

for (const verb of ['stop', 'start'] as const) {
  register({
    path: `aks ${verb}`,
    summary: verb === 'stop' ? 'Detiene un clúster (deja de facturar los nodos).' : 'Inicia un clúster detenido.',
    args: [A.rg(), A.name('Nombre del clúster.'), A.noWait()],
    longRunning: true,
    async run(a, ctx) {
      const c = getRes(ctx, a, T_AKS);
      authorize(ctx.principal, `${T_AKS}/${verb}/action`, c.id);
      if (verb === 'start' && c.properties.powerState?.code === 'Running') throw new ArmError('BadRequest', 'Managed cluster is already running.', 400);
      await sleep(provisionDelay(4000));
      c.properties.powerState = { code: verb === 'stop' ? 'Stopped' : 'Running' };
      for (const p of c.properties.agentPoolProfiles) p.powerState = { code: c.properties.powerState.code };
      syncNodes(kubeOf(c), c.id, c.properties.agentPoolProfiles, c.properties.kubernetesVersion, verb === 'start');
      for (const r of getState().resources.filter((x) => ciEq(x.resourceGroup, c.properties.nodeResourceGroup) && ciEq(x.type, 'Microsoft.Compute/virtualMachineScaleSets'))) r.data = { ...(r.data ?? {}), stopped: verb === 'stop' };
      logActivity({ operationNameValue: `${T_AKS}/${verb}/action`, operationName: verb === 'stop' ? 'Detener clúster' : 'Iniciar clúster', status: 'Succeeded', resourceId: c.id, subscriptionId: c.subscriptionId, caller: ctx.principal.name });
      changed();
      return undefined;
    },
  });
}

register({
  path: 'aks get-versions',
  summary: 'Versiones de Kubernetes disponibles en una región.',
  args: [{ ...A.location(true) }],
  table: (r: any) => r.values.map((v: any) => ({ KubernetesVersion: v.version, Upgrades: K8S_VERSIONS.filter((x) => x > v.version).join(', ') || 'None available' })),
  run: () => ({ values: K8S_VERSIONS.map((v) => ({ capabilities: { supportPlan: ['KubernetesOfficial'] }, isDefault: v === K8S_DEFAULT_VERSION, isPreview: false, version: v.split('.').slice(0, 2).join('.'), patchVersions: { [v]: { upgrades: K8S_VERSIONS.filter((x) => x > v) } } })) }),
});

register({
  path: 'aks enable-addons',
  summary: 'Habilita complementos (p. ej. monitoring).',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'addons', opts: ['--addons', '-a'], help: 'Complementos separados por comas.', required: true }, { name: 'workspace_resource_id', opts: ['--workspace-resource-id'], help: 'Área de trabajo de Log Analytics.' }],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    const r = await updateCluster(ctx, c, (p) => {
      for (const ad of String(a.addons).split(',')) {
        if (ad === 'monitoring') {
          if (!a.workspace_resource_id) throw cliError('--workspace-resource-id es obligatorio para monitoring en el simulador.');
          p.addonProfiles.omsagent = { enabled: true, config: { logAnalyticsWorkspaceResourceID: a.workspace_resource_id } };
        } else p.addonProfiles[ad] = { enabled: true, config: {} };
      }
    });
    return flat(r);
  },
});

register({
  path: 'aks disable-addons',
  summary: 'Deshabilita complementos.',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'addons', opts: ['--addons', '-a'], help: 'Complementos.', required: true }],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    return flat(await updateCluster(ctx, c, (p) => {
      for (const ad of String(a.addons).split(',')) {
        const key = ad === 'monitoring' ? 'omsagent' : ad;
        if (p.addonProfiles[key]) p.addonProfiles[key].enabled = false;
      }
    }));
  },
});

register({
  path: 'aks check-acr',
  summary: 'Comprueba si el clúster puede extraer imágenes de un ACR.',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'acr', opts: ['--acr'], help: 'Servidor del ACR (miacr.azurecr.io).', required: true }],
  run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    const reg = regArg(ctx, a.acr);
    const ok = hasPermission(kubeletPrincipal(c), 'Microsoft.ContainerRegistry/registries/pull/read', reg.id);
    const out = [
      '[2026-10-26T10:00:00Z] Checking host name resolution (' + reg.properties.loginServer + '): SUCCEEDED',
      '[2026-10-26T10:00:00Z] Canonical name for ACR (' + reg.properties.loginServer + '): ' + reg.name + '.privatelink.westeurope.azurecr.io.',
      '[2026-10-26T10:00:00Z] ACR location: ' + reg.location,
      '[2026-10-26T10:00:00Z] Checking managed identity...',
      '[2026-10-26T10:00:00Z] Kubelet managed identity client ID: ' + c.properties.identityProfile.kubeletidentity.clientId,
      ok ? '[2026-10-26T10:00:01Z] Validating managed identity existance: SUCCEEDED\n[2026-10-26T10:00:01Z] Validating image pull permission: SUCCEEDED\n[2026-10-26T10:00:01Z] \nYour cluster can pull images from ' + reg.properties.loginServer + '!' : '[2026-10-26T10:00:01Z] Validating image pull permission: FAILED\n[2026-10-26T10:00:01Z] ACR ' + reg.properties.loginServer + ' rejected token exchange: ACR token exchange endpoint returned error status: 401. body: {"errors":[{"code":"UNAUTHORIZED"}]}\n(Ejecuta: az aks update -g ' + c.resourceGroup + ' -n ' + c.name + ' --attach-acr ' + reg.name + ')',
    ];
    ctx.io.out(out.join('\n') + '\n');
    if (!ok) throw new ArmError('CliError', 'Validation failed: the cluster cannot pull from the ACR.', 1);
    return undefined;
  },
});

register({
  path: 'aks nodepool list',
  summary: 'Lista los grupos de nodos.',
  args: [A.rg(), { name: 'cluster_name', opts: ['--cluster-name'], help: 'Clúster.', required: true }],
  table: (r: any[]) => r.map((p) => ({ Name: p.name, OsType: p.osType, KubernetesVersion: p.orchestratorVersion, VmSize: p.vmSize, Count: p.count, MaxPods: p.maxPods, ProvisioningState: p.provisioningState, Mode: p.mode })),
  run(a, ctx) {
    const c = getRes(ctx, { ...a, name: a.cluster_name }, T_AKS);
    return c.properties.agentPoolProfiles.map((p: any) => ({ ...p, id: `${c.id}/agentPools/${p.name}`, resourceGroup: c.resourceGroup }));
  },
});

register({
  path: 'aks nodepool add',
  summary: 'Añade un grupo de nodos (de usuario) al clúster.',
  args: [A.rg(), { name: 'cluster_name', opts: ['--cluster-name'], help: 'Clúster.', required: true }, A.name('Nombre del grupo de nodos (minúsculas, máx. 12).'), { name: 'node_count', opts: ['--node-count', '-c'], help: 'Nodos.', type: 'int', default: 3 }, { name: 'node_vm_size', opts: ['--node-vm-size', '-s'], help: 'Tamaño.', default: 'Standard_D2s_v5' }, { name: 'mode', opts: ['--mode'], help: 'Modo.', choices: ['System', 'User'], default: 'User' }, { name: 'labels', opts: ['--labels'], help: 'Etiquetas de nodo.', type: 'kv' }, { name: 'node_taints', opts: ['--node-taints'], help: 'Taints.' }, A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, { ...a, name: a.cluster_name }, T_AKS);
    if (c.properties.agentPoolProfiles.some((p: any) => p.name === a.name)) throw new ArmError('AgentPoolAlreadyExists', `Agent pool '${a.name}' already exists.`, 409);
    const r = await updateCluster(ctx, c, (p) => p.agentPoolProfiles.push({ name: a.name, count: a.node_count, vmSize: a.node_vm_size, mode: a.mode }), a);
    syncNodes(kubeOf(r), r.id, r.properties.agentPoolProfiles, r.properties.kubernetesVersion, clusterRunning(r));
    return { ...r.properties.agentPoolProfiles.find((p: any) => p.name === a.name), id: `${r.id}/agentPools/${a.name}`, resourceGroup: r.resourceGroup };
  },
});

register({
  path: 'aks nodepool scale',
  summary: 'Escala un grupo de nodos.',
  args: [A.rg(), { name: 'cluster_name', opts: ['--cluster-name'], help: 'Clúster.', required: true }, A.name('Grupo de nodos.'), { name: 'node_count', opts: ['--node-count', '-c'], help: 'Nodos.', type: 'int', required: true }, A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, { ...a, name: a.cluster_name }, T_AKS);
    const r = await updateCluster(ctx, c, (p) => {
      const pp = p.agentPoolProfiles.find((x: any) => x.name === a.name);
      if (!pp) throw new ArmError('NotFound', `Agent pool '${a.name}' not found.`, 404);
      pp.count = a.node_count;
    }, a);
    syncNodes(kubeOf(r), r.id, r.properties.agentPoolProfiles, r.properties.kubernetesVersion, clusterRunning(r));
    return { ...r.properties.agentPoolProfiles.find((p: any) => p.name === a.name), resourceGroup: r.resourceGroup };
  },
});

register({
  path: 'aks nodepool delete',
  summary: 'Elimina un grupo de nodos.',
  args: [A.rg(), { name: 'cluster_name', opts: ['--cluster-name'], help: 'Clúster.', required: true }, A.name('Grupo de nodos.'), A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    const c = getRes(ctx, { ...a, name: a.cluster_name }, T_AKS);
    const r = await updateCluster(ctx, c, (p) => (p.agentPoolProfiles = p.agentPoolProfiles.filter((x: any) => x.name !== a.name)), a);
    syncNodes(kubeOf(r), r.id, r.properties.agentPoolProfiles, r.properties.kubernetesVersion, clusterRunning(r));
    return undefined;
  },
});

register({
  path: 'aks command invoke',
  summary: 'Ejecuta un comando kubectl en el clúster sin necesidad de kubeconfig.',
  args: [A.rg(), A.name('Nombre del clúster.'), { name: 'command', opts: ['--command', '-c'], help: 'Comando, p. ej. "kubectl get pods -A".', required: true }],
  async run(a, ctx) {
    const c = getRes(ctx, a, T_AKS);
    authorize(ctx.principal, `${T_AKS}/runcommand/action`, c.id);
    const { runKubectlAgainst } = await import('../../commands/kubectl');
    ctx.io.out(`command started at ${nowIso()}, finished at ${nowIso()} with exitcode=0\n`);
    await runKubectlAgainst(c, String(a.command).replace(/^kubectl\s+/, '').split(/\s+/), { sess: ctx.sess, io: ctx.io });
    return undefined;
  },
});

export function _containersUnused() {
  return { resolveImage, canPush, resourceId };
}
