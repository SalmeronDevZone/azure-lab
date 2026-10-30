// az group / resource / tag / lock / deployment / bicep / policy / provider.
import { register, group, A, cliError, type Args, type AzCtx } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import {
  authorize, canRead, checkLocks, createResourceGroup, deleteResource, deleteResourceGroup, findRg, findResource, listResources, logActivity, notFound,
  patchResource, resourceListItem, resourceToArm, rgToJson, updateResourceGroupTags,
} from '../../../engine/arm';
import { getProvider } from '../../../engine/registry';
import { isWithinScope, parseResourceId, resourceId, rgId } from '../../../engine/ids';
import { ciEq, sleep } from '../../../engine/util';
import { op, requireRg } from '../helpers';
import { createLock, deleteLock, lockJson, assignPolicy, deletePolicyAssignment, policyAssignmentJson, complianceReport } from '../../../engine/services/governance';
import { POLICY_DEFINITIONS, findPolicyDefinition } from '../../../engine/catalog';
import { deployTemplate, whatIf, validateTemplate, deploymentJson, formatWhatIf, exportTemplate } from '../../../engine/services/deployments';
import { compileBicep, formatBicepError } from '../../../engine/services/bicep';

group('group', 'Administra grupos de recursos e implementaciones de plantillas.');
group('resource', 'Administra recursos de Azure de forma genérica.');
group('tag', 'Administra etiquetas.');
group('lock', 'Administra bloqueos de recursos (CanNotDelete / ReadOnly).');
group('deployment', 'Administra implementaciones de plantillas ARM y Bicep.');
group('deployment group', 'Implementaciones en el ámbito de grupo de recursos.');
group('bicep', 'Comandos de Bicep CLI.');
group('policy', 'Administra Azure Policy.');
group('provider', 'Administra los proveedores de recursos.');

const groupTable = (r: any) => (Array.isArray(r) ? r : [r]).map((g: any) => ({ Name: g.name, Location: g.location, Status: g.properties?.provisioningState }));

register({
  path: 'group create',
  summary: 'Crea un nuevo grupo de recursos.',
  args: [A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g']), A.location(true), A.tags(), { name: 'managed_by', opts: ['--managed-by'], help: 'ID del recurso que administra el grupo.' }],
  examples: [
    { title: 'Crea un grupo de recursos en West Europe.', cmd: 'az group create -l westeurope -n rg-lab' },
    { title: 'Con etiquetas.', cmd: 'az group create -n rg-lab -l westeurope --tags entorno=dev propietario=ana' },
  ],
  table: groupTable,
  run(a, ctx) {
    const rg = createResourceGroup(a.name, a.location, a.tags, op(ctx));
    return rgToJson(rg);
  },
});

register({
  path: 'group list',
  summary: 'Lista los grupos de recursos.',
  args: [{ name: 'tag', opts: ['--tag'], help: 'Filtra por una etiqueta clave[=valor].' }],
  table: groupTable,
  run(a, ctx) {
    const s = getState();
    let list = s.resourceGroups.filter((g) => g.subscriptionId === ctx.subscriptionId && canRead(ctx.principal, g.id));
    if (a.tag) {
      const [k, v] = String(a.tag).split('=');
      list = list.filter((g) => Object.entries(g.tags).some(([tk, tv]) => ciEq(tk, k) && (v === undefined || tv === v)));
    }
    return list.map(rgToJson);
  },
});

register({
  path: 'group show',
  summary: 'Obtiene un grupo de recursos.',
  args: [A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g'])],
  table: groupTable,
  run(a, ctx) {
    const rg = requireRg(ctx, a.name);
    authorize(ctx.principal, 'Microsoft.Resources/subscriptions/resourceGroups/read', rg.id);
    return rgToJson(rg);
  },
});

register({
  path: 'group exists',
  summary: 'Comprueba si existe un grupo de recursos.',
  args: [A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g'])],
  run(a, ctx) {
    return !!findRg(ctx.subscriptionId, a.name);
  },
});

register({
  path: 'group delete',
  summary: 'Elimina un grupo de recursos y TODOS los recursos que contiene.',
  args: [A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g']), A.yes(), A.noWait(), { name: 'force_deletion_types', opts: ['--force-deletion-types', '-f'], help: 'Tipos de recurso cuya eliminación se fuerza.' }],
  confirm: 'Are you sure you want to perform this operation?',
  longRunning: true,
  examples: [{ title: 'Elimina un grupo sin confirmación y sin esperar.', cmd: 'az group delete -n rg-lab --yes --no-wait' }],
  async run(a, ctx) {
    requireRg(ctx, a.name);
    await deleteResourceGroup(a.name, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'group update',
  summary: 'Actualiza un grupo de recursos (etiquetas).',
  args: [
    A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g']),
    A.tags(),
    { name: 'set', opts: ['--set'], help: 'Actualiza una propiedad, p. ej. --set tags.entorno=prod', type: 'list' },
    { name: 'remove', opts: ['--remove'], help: 'Quita una propiedad, p. ej. --remove tags.entorno', type: 'list' },
  ],
  table: groupTable,
  run(a, ctx) {
    const rg = requireRg(ctx, a.name);
    let tags = { ...rg.tags };
    if (a.tags) tags = a.tags;
    for (const s of a.set ?? []) {
      const m = /^tags\.([^=]+)=(.*)$/.exec(s) ?? /^tags=(.*)$/.exec(s);
      if (!m) throw cliError(`Propiedad no soportada en --set: ${s}. Usa tags.<clave>=<valor>.`);
      if (m.length === 3) tags[m[1]] = m[2];
    }
    for (const r of a.remove ?? []) {
      const m = /^tags\.(.+)$/.exec(r);
      if (m) delete tags[m[1]];
      else if (r === 'tags') tags = {};
    }
    return rgToJson(updateResourceGroupTags(a.name, tags, op(ctx)));
  },
});

register({
  path: 'group wait',
  summary: 'Espera a que el grupo de recursos cumpla una condición.',
  args: [
    A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g']),
    { name: 'created', opts: ['--created'], help: 'Espera a que exista.', type: 'bool' },
    { name: 'deleted', opts: ['--deleted'], help: 'Espera a que se elimine.', type: 'bool' },
    { name: 'exists', opts: ['--exists'], help: 'Espera a que exista.', type: 'bool' },
    { name: 'timeout', opts: ['--timeout'], help: 'Tiempo máximo en segundos.', type: 'int', default: 3600 },
  ],
  longRunning: true,
  async run(a, ctx) {
    const end = Date.now() + Math.min(a.timeout, 120) * 1000;
    while (Date.now() < end) {
      const rg = findRg(ctx.subscriptionId, a.name);
      if (a.deleted && !rg) return undefined;
      if ((a.created || a.exists) && rg && rg.provisioningState === 'Succeeded') return undefined;
      await sleep(500);
    }
    throw cliError('Wait operation timed-out after 120 seconds');
  },
});

register({
  path: 'group export',
  summary: 'Captura un grupo de recursos como plantilla ARM.',
  args: [A.name('Nombre del grupo de recursos.', true, ['--resource-group', '-g'])],
  run(a, ctx) {
    const rg = requireRg(ctx, a.name);
    return exportTemplate(listResources({ rg: rg.name, subscriptionId: ctx.subscriptionId }));
  },
});

register({
  path: 'group lock create',
  summary: 'Crea un bloqueo en un grupo de recursos.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre del bloqueo.', required: true }, A.rg(), { name: 'lock_type', opts: ['--lock-type', '-t'], help: 'Tipo de bloqueo.', required: true, choices: ['CanNotDelete', 'ReadOnly'] }, { name: 'notes', opts: ['--notes'], help: 'Notas.' }],
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    return lockJson(createLock({ name: a.name, level: a.lock_type, scope: rg.id, notes: a.notes }, ctx.principal));
  },
});

// ---------------------------------------------------------------- resource

function resolveGenericResource(a: Args, ctx: AzCtx) {
  if (a.ids?.length) {
    const r = findResource(a.ids[0]);
    if (!r) throw notFound(a.ids[0]);
    return r;
  }
  if (!a.name) throw cliError('usage error: --ids | --resource-group --name --resource-type', undefined, true);
  const rg = requireRg(ctx, a.resource_group);
  let type = a.resource_type as string | undefined;
  if (a.namespace && type && !type.includes('/')) type = `${a.namespace}/${type}`;
  const candidates = getState().resources.filter((r) => r.subscriptionId === ctx.subscriptionId && ciEq(r.resourceGroup, rg.name) && ciEq(r.name, a.name) && (!type || ciEq(r.type, type) || ciEq(r.type.split('/').pop(), type)));
  if (!candidates.length) throw new ArmError('ResourceNotFound', `The Resource '${type ?? '*'}/${a.name}' under resource group '${rg.name}' was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix`, 404);
  if (candidates.length > 1) throw cliError(`There are multiple resources named '${a.name}'. Specify --resource-type.`);
  return candidates[0];
}

const genericArgs = [A.ids(), { ...A.rg(false) }, { name: 'name', opts: ['--name', '-n'], help: 'Nombre del recurso.' }, { name: 'resource_type', opts: ['--resource-type'], help: 'Tipo de recurso, p. ej. Microsoft.Storage/storageAccounts.' }, { name: 'namespace', opts: ['--namespace'], help: 'Espacio de nombres del proveedor.' }];

register({
  path: 'resource list',
  summary: 'Lista los recursos.',
  args: [A.rg(false), { name: 'resource_type', opts: ['--resource-type'], help: 'Filtra por tipo.' }, { name: 'name', opts: ['--name', '-n'], help: 'Filtra por nombre.' }, { name: 'tag', opts: ['--tag'], help: 'Filtra por etiqueta clave[=valor].' }, { name: 'location', opts: ['--location', '-l'], help: 'Filtra por ubicación.' }],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, ResourceGroup: x.resourceGroup, Location: x.location, Type: x.type, Status: x.provisioningState === 'Succeeded' ? '' : x.provisioningState })),
  run(a, ctx) {
    if (a.resource_group) requireRg(ctx, a.resource_group);
    let list = getState().resources.filter((r) => r.subscriptionId === ctx.subscriptionId && (!a.resource_group || ciEq(r.resourceGroup, a.resource_group)) && !getProvider(r.type)?.hidden && canRead(ctx.principal, r.id));
    if (a.resource_type) list = list.filter((r) => ciEq(r.type, a.resource_type));
    if (a.name) list = list.filter((r) => ciEq(r.name, a.name));
    if (a.location) list = list.filter((r) => ciEq(r.location, a.location));
    if (a.tag) {
      const [k, v] = String(a.tag).split('=');
      list = list.filter((r) => Object.entries(r.tags ?? {}).some(([tk, tv]) => ciEq(tk, k) && (v === undefined || tv === v)));
    }
    return list.map(resourceListItem);
  },
});

register({
  path: 'resource show',
  summary: 'Obtiene los detalles de un recurso.',
  args: genericArgs,
  run(a, ctx) {
    const r = resolveGenericResource(a, ctx);
    authorize(ctx.principal, `${r.type}/read`, r.id);
    return resourceToArm(r);
  },
});

register({
  path: 'resource delete',
  summary: 'Elimina un recurso.',
  args: [...genericArgs, A.noWait()],
  longRunning: true,
  async run(a, ctx) {
    if (a.ids?.length > 1) {
      for (const id of a.ids) await deleteResource(id, op(ctx, a));
      return undefined;
    }
    const r = resolveGenericResource(a, ctx);
    await deleteResource(r.id, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'resource tag',
  summary: 'Etiqueta un recurso (reemplaza las etiquetas salvo que uses --is-incremental).',
  args: [...genericArgs, { ...A.tags(), required: true }, { name: 'incremental', opts: ['--is-incremental', '-i'], help: 'Añade las etiquetas sin borrar las existentes.', type: 'bool' }],
  examples: [{ title: 'Añadir etiquetas a un recurso por ID.', cmd: 'az resource tag --ids <id> --tags entorno=dev -i' }],
  run(a, ctx) {
    const targets = a.ids?.length ? a.ids : [resolveGenericResource(a, ctx).id];
    let last: any;
    for (const id of targets) {
      const rgOnly = parseResourceId(id);
      if (!rgOnly.type && rgOnly.resourceGroup) {
        const rg = findRg(rgOnly.subscriptionId!, rgOnly.resourceGroup)!;
        last = rgToJson(updateResourceGroupTags(rg.name, a.incremental ? { ...rg.tags, ...a.tags } : a.tags, op(ctx)));
        continue;
      }
      const r = patchResource(id, (res) => (res.tags = a.incremental ? { ...res.tags, ...a.tags } : { ...a.tags }), { principal: ctx.principal, opName: 'Actualizar etiquetas' });
      last = resourceToArm(r);
    }
    return last;
  },
});

register({
  path: 'resource move',
  summary: 'Mueve recursos a otro grupo de recursos (o suscripción).',
  args: [{ ...A.ids(), required: true }, { name: 'destination_group', opts: ['--destination-group'], help: 'Grupo de recursos de destino.', required: true }, { name: 'destination_subscription_id', opts: ['--destination-subscription-id'], help: 'Suscripción de destino.' }],
  longRunning: true,
  async run(a, ctx) {
    const s = getState();
    const destSub = a.destination_subscription_id ?? ctx.subscriptionId;
    const dest = findRg(destSub, a.destination_group);
    if (!dest) throw new ArmError('ResourceGroupNotFound', `Resource group '${a.destination_group}' could not be found.`, 404);
    authorize(ctx.principal, 'Microsoft.Resources/subscriptions/resourceGroups/write', dest.id);
    const moving = (a.ids as string[]).map((id) => {
      const r = findResource(id);
      if (!r) throw notFound(id);
      authorize(ctx.principal, 'Microsoft.Resources/subscriptions/resourceGroups/moveResources/action', rgId(r.subscriptionId, r.resourceGroup));
      checkLocks(r.id, 'write');
      checkLocks(r.id, 'delete');
      return r;
    });
    // dependencias: una VM no se puede mover sin su NIC y su disco
    for (const r of moving) {
      if (ciEq(r.type, 'Microsoft.Compute/virtualMachines')) {
        const deps = [...(r.properties.networkProfile?.networkInterfaces ?? []).map((n: any) => n.id), r.properties.storageProfile?.osDisk?.managedDisk?.id].filter(Boolean);
        const missing = deps.filter((d: string) => !moving.some((m) => ciEq(m.id, d)));
        if (missing.length) throw new ArmError('MissingMoveDependentResources', `The move resources request does not contain all the dependent resources. Please check error details for missing resource identifiers. Missing: ${missing.join(', ')}`, 400, 'Para mover una VM incluye también su interfaz de red y su disco del SO (y la IP pública/NSG si están conectados).');
      }
    }
    await sleep(800);
    const replace = new Map<string, string>();
    for (const r of moving) {
      const oldId = r.id;
      const newId = oldId.replace(new RegExp(`^/subscriptions/${r.subscriptionId}/resourceGroups/${r.resourceGroup}/`, 'i'), `/subscriptions/${destSub}/resourceGroups/${dest.name}/`);
      replace.set(oldId.toLowerCase(), newId);
      for (const child of s.resources.filter((x) => isWithinScope(x.id, oldId))) {
        const nid = newId + child.id.slice(oldId.length);
        replace.set(child.id.toLowerCase(), nid);
      }
    }
    const fix = (v: any): any => {
      if (typeof v === 'string') {
        const low = v.toLowerCase();
        for (const [o, n] of replace) if (low === o || low.startsWith(o + '/')) return n + v.slice(o.length);
        return v;
      }
      if (Array.isArray(v)) return v.map(fix);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
      return v;
    };
    for (const r of s.resources) {
      const nid = replace.get(r.id.toLowerCase());
      if (nid) {
        r.id = nid;
        r.resourceGroup = dest.name;
        r.subscriptionId = destSub;
      }
      r.properties = fix(r.properties);
      if (r.managedBy) r.managedBy = fix(r.managedBy);
    }
    for (const ra of s.roleAssignments) ra.scope = fix(ra.scope);
    for (const l of s.locks) l.scope = fix(l.scope);
    for (const m of moving) logActivity({ operationNameValue: 'Microsoft.Resources/subscriptions/resourceGroups/moveResources/action', operationName: `Mover recurso a ${dest.name}`, status: 'Succeeded', resourceId: m.id, subscriptionId: destSub, caller: ctx.principal.name });
    changed();
    return undefined;
  },
});

// ---------------------------------------------------------------- tag

register({
  path: 'tag list',
  summary: 'Lista las etiquetas de un recurso o de la suscripción.',
  args: [{ name: 'resource_id', opts: ['--resource-id'], help: 'ID del recurso.' }],
  run(a, ctx) {
    if (a.resource_id) {
      const p = parseResourceId(a.resource_id);
      const tags = p.type ? findResource(a.resource_id)?.tags : findRg(p.subscriptionId!, p.resourceGroup!)?.tags;
      return { id: `${a.resource_id}/providers/Microsoft.Resources/tags/default`, name: 'default', properties: { tags: tags ?? {} }, type: 'Microsoft.Resources/tags' };
    }
    const counts: Record<string, Record<string, number>> = {};
    for (const r of [...getState().resources, ...getState().resourceGroups]) {
      if ((r as any).subscriptionId !== ctx.subscriptionId) continue;
      for (const [k, v] of Object.entries(r.tags ?? {})) {
        counts[k] = counts[k] ?? {};
        counts[k][v] = (counts[k][v] ?? 0) + 1;
      }
    }
    return Object.entries(counts).map(([tagName, vals]) => ({ count: { type: 'Total', value: Object.values(vals).reduce((x, y) => x + y, 0) }, tagName, values: Object.entries(vals).map(([tagValue, n]) => ({ count: { type: 'Total', value: n }, tagValue })) }));
  },
});

function applyTagOp(id: string, tags: Record<string, string>, opName: 'merge' | 'replace' | 'delete', ctx: AzCtx) {
  const p = parseResourceId(id);
  const calc = (cur: Record<string, string>) => {
    if (opName === 'replace') return { ...tags };
    if (opName === 'merge') return { ...cur, ...tags };
    const out = { ...cur };
    for (const k of Object.keys(tags)) delete out[k];
    return out;
  };
  if (!p.type && p.resourceGroup) {
    const rg = findRg(p.subscriptionId!, p.resourceGroup);
    if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${p.resourceGroup}' could not be found.`, 404);
    return updateResourceGroupTags(rg.name, calc(rg.tags), op(ctx)).tags;
  }
  return patchResource(id, (r) => (r.tags = calc(r.tags)), { principal: ctx.principal, opName: 'Actualizar etiquetas' }).tags;
}

register({
  path: 'tag create',
  summary: 'Crea (reemplaza) las etiquetas de un recurso.',
  args: [{ name: 'resource_id', opts: ['--resource-id'], help: 'ID del recurso o grupo.', required: true }, { ...A.tags(), required: true }],
  run(a, ctx) {
    return { id: `${a.resource_id}/providers/Microsoft.Resources/tags/default`, name: 'default', properties: { tags: applyTagOp(a.resource_id, a.tags, 'replace', ctx) }, type: 'Microsoft.Resources/tags' };
  },
});

register({
  path: 'tag update',
  summary: 'Actualiza etiquetas (merge, replace o delete).',
  args: [{ name: 'resource_id', opts: ['--resource-id'], help: 'ID del recurso o grupo.', required: true }, { ...A.tags(), required: true }, { name: 'operation', opts: ['--operation'], help: 'Operación.', required: true, choices: ['Merge', 'Replace', 'Delete'] }],
  run(a, ctx) {
    return { id: `${a.resource_id}/providers/Microsoft.Resources/tags/default`, name: 'default', properties: { tags: applyTagOp(a.resource_id, a.tags, a.operation.toLowerCase(), ctx) }, type: 'Microsoft.Resources/tags' };
  },
});

// ---------------------------------------------------------------- lock

function lockScope(a: Args, ctx: AzCtx): string {
  if (a.resource) return a.resource.startsWith('/') ? a.resource : resourceId(ctx.subscriptionId, requireRg(ctx, a.resource_group).name, a.resource_type, a.resource);
  if (a.resource_name) {
    if (!a.resource_type) throw cliError('usage error: --resource-type is required with --resource-name', undefined, true);
    const rg = requireRg(ctx, a.resource_group);
    const type = a.namespace ? `${a.namespace}/${a.resource_type}` : a.resource_type;
    return resourceId(ctx.subscriptionId, rg.name, type, a.resource_name);
  }
  if (a.resource_group) return requireRg(ctx, a.resource_group).id;
  return `/subscriptions/${ctx.subscriptionId}`;
}

const lockArgs = [
  A.rg(false),
  { name: 'resource', opts: ['--resource'], help: 'Nombre o ID del recurso.' },
  { name: 'resource_name', opts: ['--resource-name'], help: 'Nombre del recurso (requiere --resource-type).' },
  { name: 'resource_type', opts: ['--resource-type'], help: 'Tipo del recurso, p. ej. Microsoft.Storage/storageAccounts.' },
  { name: 'namespace', opts: ['--namespace'], help: 'Espacio de nombres del proveedor.' },
];

register({
  path: 'lock create',
  summary: 'Crea un bloqueo (suscripción, grupo de recursos o recurso).',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre del bloqueo.', required: true }, { name: 'lock_type', opts: ['--lock-type', '-t'], help: 'Tipo de bloqueo: CanNotDelete impide borrar; ReadOnly impide borrar y modificar.', required: true, choices: ['CanNotDelete', 'ReadOnly'] }, { name: 'notes', opts: ['--notes'], help: 'Notas del bloqueo.' }, ...lockArgs],
  examples: [
    { title: 'Bloquea un grupo de recursos contra eliminación.', cmd: 'az lock create --name no-borrar --lock-type CanNotDelete -g rg-prod' },
    { title: 'Bloquea una cuenta de almacenamiento.', cmd: 'az lock create -n solo-lectura -t ReadOnly -g rg-prod --resource-name stprod01 --resource-type Microsoft.Storage/storageAccounts' },
  ],
  run(a, ctx) {
    return lockJson(createLock({ name: a.name, level: a.lock_type, scope: lockScope(a, ctx), notes: a.notes }, ctx.principal));
  },
});

register({
  path: 'lock list',
  summary: 'Lista los bloqueos.',
  args: [...lockArgs, { name: 'filter_string', opts: ['--filter-string'], help: 'Filtro OData.' }],
  table: (r: any[]) => r.map((l) => ({ Name: l.name, ResourceGroup: l.resourceGroup, Level: l.level, Notes: l.notes })),
  run(a, ctx) {
    const s = getState();
    const scope = a.resource_group || a.resource || a.resource_name ? lockScope(a, ctx) : `/subscriptions/${ctx.subscriptionId}`;
    return s.locks.filter((l) => isWithinScope(l.scope, scope) || isWithinScope(scope, l.scope)).map(lockJson);
  },
});

register({
  path: 'lock show',
  summary: 'Muestra un bloqueo.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre del bloqueo.', required: true }, ...lockArgs],
  run(a, ctx) {
    const scope = lockScope(a, ctx);
    const l = getState().locks.find((x) => ciEq(x.name, a.name) && ciEq(x.scope, scope));
    if (!l) throw new ArmError('LockNotFound', `The lock '${a.name}' could not be found.`, 404);
    return lockJson(l);
  },
});

register({
  path: 'lock delete',
  summary: 'Elimina un bloqueo.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre del bloqueo.' }, A.ids(), ...lockArgs],
  run(a, ctx) {
    if (a.ids?.length) {
      for (const id of a.ids) {
        const l = getState().locks.find((x) => ciEq(x.id, id));
        if (!l) throw new ArmError('LockNotFound', `The lock '${id}' could not be found.`, 404);
        deleteLock(l.name, l.scope, ctx.principal);
      }
      return undefined;
    }
    if (!a.name) throw cliError('usage error: --name | --ids', undefined, true);
    deleteLock(a.name, lockScope(a, ctx), ctx.principal);
    return undefined;
  },
});

// ---------------------------------------------------------------- deployment

function loadTemplate(a: Args, ctx: AzCtx): { template: any; warnings: string[] } {
  if (a.template_spec || a.template_uri) throw cliError('El simulador sólo admite --template-file (ARM .json o Bicep .bicep).');
  if (!a.template_file) throw cliError('usage error: --template-file | --template-uri | --template-spec', undefined, true);
  const path = a.template_file as string;
  let text: string;
  try {
    text = ctx.sess.fs.readFile(ctx.sess.resolve(path));
  } catch {
    throw cliError(`[Errno 2] No such file or directory: '${path}'`);
  }
  if (path.endsWith('.bicep')) {
    try {
      const r = compileBicep(text);
      return { template: r.template, warnings: r.warnings.map((w) => `${path}(1,1) : ${w}`) };
    } catch (e) {
      throw cliError(formatBicepError(ctx.sess.resolve(path), e));
    }
  }
  try {
    return { template: JSON.parse(text), warnings: [] };
  } catch (e) {
    throw cliError(`Failed to parse '${path}', please check whether it is a valid JSON format: ${(e as Error).message}`);
  }
}

function loadParams(a: Args, ctx: AzCtx): Record<string, any> {
  const out: Record<string, any> = {};
  for (const raw of (a.parameters ?? []) as string[]) {
    let p = raw;
    if (p.startsWith('@')) p = p.slice(1);
    if ((raw.startsWith('@') || /\.(json|bicepparam)$/.test(p)) && !p.includes('=')) {
      let text: string;
      try {
        text = ctx.sess.fs.readFile(ctx.sess.resolve(p));
      } catch {
        throw cliError(`[Errno 2] No such file or directory: '${p}'`);
      }
      if (p.endsWith('.bicepparam')) {
        for (const m of text.matchAll(/^param\s+(\w+)\s*=\s*(.+)$/gm)) {
          const v = m[2].trim();
          out[m[1]] = /^'.*'$/.test(v) ? v.slice(1, -1) : /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
        }
        continue;
      }
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        throw cliError(`Failed to parse JSON: ${p}`);
      }
      const params = j.parameters ?? j;
      for (const [k, v] of Object.entries<any>(params)) out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
      continue;
    }
    if (raw.trim().startsWith('{')) {
      const j = JSON.parse(raw);
      for (const [k, v] of Object.entries<any>(j)) out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq < 0) throw cliError(`Unable to parse parameter: ${raw}. Use key=value, @file.json o un JSON.`);
    const k = raw.slice(0, eq);
    const v = raw.slice(eq + 1);
    out[k] = /^-?\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : /^[[{]/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
  }
  return out;
}

const deployArgs = [
  A.rg(),
  { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la implementación (por defecto, el nombre del fichero).' },
  { name: 'template_file', opts: ['--template-file', '-f'], help: 'Ruta a la plantilla ARM (.json) o Bicep (.bicep).' },
  { name: 'template_uri', opts: ['--template-uri', '-u'], help: 'URI de la plantilla (no soportado).', hidden: true },
  { name: 'template_spec', opts: ['--template-spec', '-s'], help: 'Template spec (no soportado).', hidden: true },
  { name: 'parameters', opts: ['--parameters', '-p'], help: 'Parámetros: @fichero.json, fichero.bicepparam, clave=valor o JSON. Se puede repetir.', type: 'list' as const },
  { name: 'mode', opts: ['--mode'], help: 'Incremental (por defecto) añade/actualiza; Complete además ELIMINA lo que no esté en la plantilla.', choices: ['Incremental', 'Complete'], default: 'Incremental' },
];

register({
  path: 'deployment group create',
  summary: 'Inicia una implementación en un grupo de recursos.',
  args: [...deployArgs, A.noWait(), { name: 'what_if', opts: ['--what-if', '-w'], help: 'Muestra el resultado de what-if sin desplegar.', type: 'bool' }, { name: 'confirm_with_what_if', opts: ['--confirm-with-what-if', '-c'], help: 'Muestra what-if y pide confirmación antes de desplegar.', type: 'bool' }],
  longRunning: true,
  examples: [
    { title: 'Desplegar una plantilla ARM con parámetros en línea.', cmd: 'az deployment group create -g rg-lab --template-file ~/samples/arm/storage.json --parameters prefijo=stlab sku=Standard_LRS' },
    { title: 'Desplegar Bicep con un fichero de parámetros.', cmd: 'az deployment group create -g rg-lab -f main.bicep -p @main.parameters.json' },
  ],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const { template, warnings } = loadTemplate(a, ctx);
    warnings.forEach((w) => ctx.io.err(`\x1b[33m${w}\x1b[0m\n`));
    const params = loadParams(a, ctx);
    const name = a.name ?? String(a.template_file).split('/').pop()!.replace(/\.(json|bicep)$/, '');
    if (a.what_if || a.confirm_with_what_if) {
      const changes = whatIf({ template, parameters: params, resourceGroup: rg.name, name, mode: a.mode, principal: ctx.principal, subscriptionId: ctx.subscriptionId });
      ctx.io.out(formatWhatIf(changes, rg.id, ctx.io.isTTY) + '\n');
      if (a.what_if) return undefined;
      if (!(await ctx.confirm('\nAre you sure you want to execute the deployment?'))) return undefined;
    }
    const p = deployTemplate({ template, parameters: params, resourceGroup: rg.name, name, mode: a.mode, principal: ctx.principal, subscriptionId: ctx.subscriptionId, source: ctx.sess.kind === 'agent' ? 'pipeline' : 'cli' });
    if (a.no_wait) {
      p.catch(() => undefined);
      return undefined;
    }
    const dep = await p;
    return deploymentJson(dep);
  },
});

register({
  path: 'deployment group what-if',
  summary: 'Muestra los cambios que haría una implementación (sin aplicarlos).',
  args: deployArgs,
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const { template, warnings } = loadTemplate(a, ctx);
    warnings.forEach((w) => ctx.io.err(`\x1b[33m${w}\x1b[0m\n`));
    const changes = whatIf({ template, parameters: loadParams(a, ctx), resourceGroup: rg.name, mode: a.mode, principal: ctx.principal, subscriptionId: ctx.subscriptionId });
    if (ctx.output === 'json' && !ctx.io.isTTY) return { changes, status: 'Succeeded' };
    ctx.io.out(formatWhatIf(changes, rg.id, ctx.io.isTTY) + '\n');
    return undefined;
  },
});

register({
  path: 'deployment group validate',
  summary: 'Valida si una plantilla es sintácticamente correcta.',
  args: deployArgs,
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const { template } = loadTemplate(a, ctx);
    const r = validateTemplate({ template, parameters: loadParams(a, ctx), resourceGroup: rg.name, principal: ctx.principal, subscriptionId: ctx.subscriptionId });
    return { error: null, id: `${rg.id}/providers/Microsoft.Resources/deployments/validate`, name: 'validate', properties: { mode: a.mode, provisioningState: 'Succeeded', validatedResources: r.resources.map((x) => ({ id: resourceId(ctx.subscriptionId, rg.name, x.type, x.name), resourceGroup: rg.name })) } };
  },
});

register({
  path: 'deployment group list',
  summary: 'Lista las implementaciones de un grupo de recursos.',
  args: [A.rg()],
  table: (r: any[]) => r.map((d) => ({ Name: d.name, State: d.properties.provisioningState, Timestamp: d.properties.timestamp, Mode: d.properties.mode, ResourceGroup: d.resourceGroup })),
  run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    return getState().deployments.filter((d) => d.subscriptionId === ctx.subscriptionId && ciEq(d.resourceGroup, rg.name)).map(deploymentJson);
  },
});

register({
  path: 'deployment group show',
  summary: 'Obtiene una implementación.',
  args: [A.rg(), { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la implementación.', required: true }],
  table: (d: any) => ({ Name: d.name, State: d.properties.provisioningState, Timestamp: d.properties.timestamp, Mode: d.properties.mode }),
  run(a, ctx) {
    const d = getState().deployments.find((x) => x.subscriptionId === ctx.subscriptionId && ciEq(x.resourceGroup, a.resource_group) && ciEq(x.name, a.name));
    if (!d) throw new ArmError('DeploymentNotFound', `Deployment '${a.name}' could not be found.`, 404);
    return deploymentJson(d);
  },
});

register({
  path: 'deployment group delete',
  summary: 'Elimina el registro de una implementación (no elimina los recursos).',
  args: [A.rg(), { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la implementación.', required: true }, A.noWait()],
  run(a, ctx) {
    const s = getState();
    s.deployments = s.deployments.filter((x) => !(x.subscriptionId === ctx.subscriptionId && ciEq(x.resourceGroup, a.resource_group) && ciEq(x.name, a.name)));
    changed();
    return undefined;
  },
});

register({
  path: 'deployment group export',
  summary: 'Exporta la plantilla usada en una implementación.',
  args: [A.rg(), { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la implementación.', required: true }],
  run(a, ctx) {
    const d = getState().deployments.find((x) => x.subscriptionId === ctx.subscriptionId && ciEq(x.resourceGroup, a.resource_group) && ciEq(x.name, a.name));
    if (!d) throw new ArmError('DeploymentNotFound', `Deployment '${a.name}' could not be found.`, 404);
    return d.template;
  },
});

register({
  path: 'deployment operation group list',
  summary: 'Lista las operaciones de una implementación.',
  args: [A.rg(), { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la implementación.', required: true }],
  run(a, ctx) {
    const d = getState().deployments.find((x) => x.subscriptionId === ctx.subscriptionId && ciEq(x.resourceGroup, a.resource_group) && ciEq(x.name, a.name));
    if (!d) throw new ArmError('DeploymentNotFound', `Deployment '${a.name}' could not be found.`, 404);
    const ops = d.outputResources.map((o, i) => ({ id: `${d.id}/operations/${i}`, operationId: String(i), properties: { provisioningOperation: 'Create', provisioningState: 'Succeeded', statusCode: 'OK', targetResource: { id: o.id, resourceName: o.id.split('/').pop(), resourceType: parseResourceId(o.id).type } } }));
    if (d.error) ops.push({ id: `${d.id}/operations/err`, operationId: 'err', properties: { provisioningOperation: 'Create', provisioningState: 'Failed', statusCode: 'BadRequest', statusMessage: { error: d.error } as any, targetResource: null as any } as any });
    return ops;
  },
});

register({
  path: 'bicep build',
  summary: 'Compila un fichero Bicep a plantilla ARM JSON.',
  noLogin: true,
  args: [{ name: 'file', opts: ['--file', '-f'], help: 'Fichero .bicep.', required: true }, { name: 'outfile', opts: ['--outfile'], help: 'Fichero de salida.' }, { name: 'stdout', opts: ['--stdout'], help: 'Imprime el resultado en la salida estándar.', type: 'bool' }],
  run(a, ctx) {
    const path = ctx.sess.resolve(a.file);
    let text: string;
    try {
      text = ctx.sess.fs.readFile(path);
    } catch {
      throw cliError(`[Errno 2] No such file or directory: '${a.file}'`);
    }
    let r: ReturnType<typeof compileBicep>;
    try {
      r = compileBicep(text);
    } catch (e) {
      throw cliError(formatBicepError(path, e));
    }
    r.warnings.forEach((w) => ctx.io.err(`\x1b[33m${path}(1,1) : ${w}\x1b[0m\n`));
    const json = JSON.stringify(r.template, null, 2) + '\n';
    if (a.stdout) {
      ctx.io.out(json);
      return undefined;
    }
    const out = a.outfile ? ctx.sess.resolve(a.outfile) : path.replace(/\.bicep$/, '.json');
    ctx.sess.fs.writeFile(out, json);
    return undefined;
  },
});

register({ path: 'bicep version', summary: 'Muestra la versión de Bicep CLI.', noLogin: true, args: [], run: (_a, ctx) => (ctx.io.out('Bicep CLI version 0.30.23 (ec3612496f)\n'), undefined) });
register({ path: 'bicep install', summary: 'Instala Bicep CLI.', noLogin: true, args: [], run: (_a, ctx) => (ctx.io.err('Bicep CLI is already installed at \'/home/user/.azure/bin/bicep\'. Skipping installation as no specific version was requested.\n'), undefined) });
register({ path: 'bicep upgrade', summary: 'Actualiza Bicep CLI.', noLogin: true, args: [], run: (_a, ctx) => (ctx.io.err('Bicep CLI is already the latest version 0.30.23.\n'), undefined) });

// ---------------------------------------------------------------- policy

function policyScope(a: Args, ctx: AzCtx): string {
  if (a.scope) return a.scope;
  if (a.resource_group) return requireRg(ctx, a.resource_group).id;
  return `/subscriptions/${ctx.subscriptionId}`;
}

const policyDefJson = (d: (typeof POLICY_DEFINITIONS)[number]) => ({
  description: d.description,
  displayName: d.displayName,
  id: `/providers/Microsoft.Authorization/policyDefinitions/${d.name}`,
  metadata: { category: d.category, version: '1.0.0' },
  mode: 'Indexed',
  name: d.name,
  parameters: Object.fromEntries(Object.entries(d.parameters).map(([k, p]) => [k, { type: p.type, metadata: { displayName: p.displayName, description: p.description } }])),
  policyRule: { if: { field: 'type', like: '*' }, then: { effect: d.effect.toLowerCase() } },
  policyType: 'BuiltIn',
  type: 'Microsoft.Authorization/policyDefinitions',
});

register({
  path: 'policy definition list',
  summary: 'Lista las definiciones de directiva.',
  args: [],
  table: (r: any[]) => r.map((d) => ({ Name: d.name, DisplayName: d.displayName, PolicyType: d.policyType, Category: d.metadata?.category })),
  run: () => POLICY_DEFINITIONS.map(policyDefJson),
});

register({
  path: 'policy definition show',
  summary: 'Muestra una definición de directiva.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre (GUID) o nombre para mostrar.', required: true }],
  run(a) {
    const d = findPolicyDefinition(a.name);
    if (!d) throw new ArmError('PolicyDefinitionNotFound', `The policy definition '${a.name}' could not be found.`, 404);
    return policyDefJson(d);
  },
});

register({
  path: 'policy assignment create',
  summary: 'Asigna una directiva a un ámbito.',
  args: [
    { name: 'name', opts: ['--name', '-n'], help: 'Nombre de la asignación.', required: true },
    { name: 'policy', opts: ['--policy'], help: 'Nombre (GUID), nombre para mostrar o ID de la definición.', required: true },
    { name: 'display_name', opts: ['--display-name'], help: 'Nombre para mostrar.' },
    { name: 'scope', opts: ['--scope'], help: 'Ámbito (suscripción, grupo o recurso).' },
    A.rg(false),
    { name: 'params', opts: ['--params', '-p'], help: 'Parámetros JSON o @fichero.', type: 'json' },
    { name: 'enforcement_mode', opts: ['--enforcement-mode'], help: 'Default aplica el efecto; DoNotEnforce sólo audita.', choices: ['Default', 'DoNotEnforce'], default: 'Default' },
  ],
  examples: [{ title: 'Sólo permitir West Europe y North Europe en un grupo.', cmd: `az policy assignment create -n solo-europa --policy "Allowed locations" -g rg-lab --params '{"listOfAllowedLocations":{"value":["westeurope","northeurope"]}}'` }],
  run(a, ctx) {
    return policyAssignmentJson(assignPolicy({ name: a.name, displayName: a.display_name, definition: a.policy, scope: policyScope(a, ctx), params: a.params, enforcementMode: a.enforcement_mode }, ctx.principal));
  },
});

register({
  path: 'policy assignment list',
  summary: 'Lista las asignaciones de directivas.',
  args: [{ name: 'scope', opts: ['--scope'], help: 'Ámbito.' }, A.rg(false), { name: 'disable_scope_strict_match', opts: ['--disable-scope-strict-match'], help: 'Incluye asignaciones heredadas.', type: 'bool' }],
  table: (r: any[]) => r.map((x) => ({ Name: x.name, DisplayName: x.displayName, EnforcementMode: x.enforcementMode, Scope: x.scope })),
  run(a, ctx) {
    const scope = policyScope(a, ctx);
    return getState().policyAssignments.filter((p) => ciEq(p.scope, scope) || isWithinScope(p.scope, scope) || (a.disable_scope_strict_match && isWithinScope(scope, p.scope))).map(policyAssignmentJson);
  },
});

register({
  path: 'policy assignment show',
  summary: 'Muestra una asignación de directiva.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre.', required: true }, { name: 'scope', opts: ['--scope'], help: 'Ámbito.' }, A.rg(false)],
  run(a, ctx) {
    const pa = getState().policyAssignments.find((p) => ciEq(p.name, a.name));
    if (!pa) throw new ArmError('PolicyAssignmentNotFound', `The policy assignment '${a.name}' is not found.`, 404);
    return policyAssignmentJson(pa);
  },
});

register({
  path: 'policy assignment delete',
  summary: 'Elimina una asignación de directiva.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre.', required: true }, { name: 'scope', opts: ['--scope'], help: 'Ámbito.' }, A.rg(false)],
  run(a, ctx) {
    deletePolicyAssignment(a.name, a.scope ?? (a.resource_group ? requireRg(ctx, a.resource_group).id : undefined), ctx.principal);
    return undefined;
  },
});

register({
  path: 'policy state summarize',
  summary: 'Resume el estado de cumplimiento de las directivas.',
  args: [A.rg(false)],
  run(a, ctx) {
    const rows = complianceReport().filter((r) => !a.resource_group || isWithinScope(r.assignment.scope, requireRg(ctx, a.resource_group).id) || isWithinScope(requireRg(ctx, a.resource_group).id, r.assignment.scope));
    return {
      policyAssignments: rows.map((r) => ({ policyAssignmentId: r.assignment.id, policySetDefinitionId: '', results: { nonCompliantPolicies: r.nonCompliant.length ? 1 : 0, nonCompliantResources: r.nonCompliant.length, resourceDetails: [{ complianceState: 'compliant', count: r.compliant.length }, { complianceState: 'noncompliant', count: r.nonCompliant.length }] } })),
      results: { nonCompliantPolicies: rows.filter((r) => r.nonCompliant.length).length, nonCompliantResources: new Set(rows.flatMap((r) => r.nonCompliant)).size },
    };
  },
});

register({
  path: 'policy state list',
  summary: 'Lista los estados de cumplimiento.',
  args: [A.rg(false), { name: 'filter', opts: ['--filter'], help: "Filtro OData, p. ej. \"complianceState eq 'NonCompliant'\"." }],
  table: (r: any[]) => r.map((x) => ({ ResourceId: x.resourceId, ComplianceState: x.complianceState, PolicyAssignmentName: x.policyAssignmentName })),
  run(a) {
    const out: any[] = [];
    for (const r of complianceReport()) {
      for (const id of r.nonCompliant) out.push({ complianceState: 'NonCompliant', isCompliant: false, policyAssignmentName: r.assignment.name, policyDefinitionName: r.def.name, resourceId: id, timestamp: new Date().toISOString() });
      if (!/NonCompliant/i.test(a.filter ?? '')) for (const id of r.compliant) out.push({ complianceState: 'Compliant', isCompliant: true, policyAssignmentName: r.assignment.name, policyDefinitionName: r.def.name, resourceId: id, timestamp: new Date().toISOString() });
    }
    return out;
  },
});

register({
  path: 'provider register',
  summary: 'Registra un proveedor de recursos en la suscripción.',
  args: [{ name: 'namespace', opts: ['--namespace', '-n'], help: 'Espacio de nombres, p. ej. Microsoft.ContainerService.', required: true }, { name: 'wait', opts: ['--wait'], help: 'Esperar.', type: 'bool' }],
  run(_a, ctx) {
    ctx.io.err('Registering is still on-going. You can monitor using \'az provider show -n <namespace>\'\n');
    return undefined;
  },
});

register({
  path: 'provider show',
  summary: 'Muestra el estado de registro de un proveedor.',
  args: [{ name: 'namespace', opts: ['--namespace', '-n'], help: 'Espacio de nombres.', required: true }],
  run(a, ctx) {
    return { id: `/subscriptions/${ctx.subscriptionId}/providers/${a.namespace}`, namespace: a.namespace, registrationPolicy: 'RegistrationRequired', registrationState: 'Registered' };
  },
});

register({
  path: 'provider list',
  summary: 'Lista los proveedores de recursos.',
  args: [],
  table: (r: any[]) => r.map((p) => ({ Namespace: p.namespace, RegistrationState: p.registrationState })),
  run(_a, ctx) {
    const ns = [...new Set(['Microsoft.Compute', 'Microsoft.Network', 'Microsoft.Storage', 'Microsoft.Web', 'Microsoft.Sql', 'Microsoft.KeyVault', 'Microsoft.ContainerRegistry', 'Microsoft.ContainerService', 'Microsoft.ContainerInstance', 'Microsoft.Insights', 'Microsoft.OperationalInsights', 'Microsoft.ManagedIdentity', 'Microsoft.Authorization', 'Microsoft.Resources'])];
    return ns.map((n) => ({ id: `/subscriptions/${ctx.subscriptionId}/providers/${n}`, namespace: n, registrationState: 'Registered' }));
  },
});
