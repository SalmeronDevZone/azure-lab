// Ayudas comunes para la implementación de comandos az.
import type { Args, AzCtx } from './framework';
import { cliError } from './framework';
import type { Resource, ResourceGroup } from '../../engine/types';
import { ArmError } from '../../engine/errors';
import { findRg, findResource, notFound, resourceToFlat, type OpOpts } from '../../engine/arm';
import { getState } from '../../engine/store';
import { parseResourceId, resourceId } from '../../engine/ids';
import { ciEq } from '../../engine/util';

export function op(ctx: AzCtx, a: Args = {}): OpOpts {
  return { principal: ctx.principal, subscriptionId: ctx.subscriptionId, noWait: !!a.no_wait, source: ctx.sess.kind === 'agent' ? 'pipeline' : 'cli' };
}

export function requireRg(ctx: AzCtx, name: string | undefined): ResourceGroup {
  if (!name) throw cliError('the following arguments are required: --resource-group/-g', undefined, true);
  const rg = findRg(ctx.subscriptionId, name);
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${name}' could not be found.`, 404, 'Lista tus grupos con: az group list -o table');
  return rg;
}

/** Busca un recurso por --ids o por nombre + grupo. */
export function getRes(ctx: AzCtx, a: Args, type: string, nameKey = 'name'): Resource {
  if (Array.isArray(a.ids) && a.ids.length) {
    const r = findResource(a.ids[0]);
    if (!r || !ciEq(r.type, type)) throw notFound(a.ids[0]);
    return r;
  }
  const name = a[nameKey];
  if (!name) throw cliError(`the following arguments are required: --name/-n`, undefined, true);
  const rg = requireRg(ctx, a.resource_group);
  const id = resourceId(ctx.subscriptionId, rg.name, type, name);
  const r = findResource(id);
  if (!r) throw notFound(id);
  return r;
}

export function findInSub(ctx: AzCtx, type: string, name: string, rg?: string): Resource | undefined {
  return getState().resources.find((r) => ciEq(r.type, type) && ciEq(r.name, name) && r.subscriptionId === ctx.subscriptionId && (!rg || ciEq(r.resourceGroup, rg)));
}

export function listInSub(ctx: AzCtx, type: string, rg?: string): Resource[] {
  if (rg) requireRg(ctx, rg);
  return getState().resources.filter((r) => ciEq(r.type, type) && r.subscriptionId === ctx.subscriptionId && (!rg || ciEq(r.resourceGroup, rg)));
}

export function flat(r: Resource, extra: Record<string, any> = {}) {
  return resourceToFlat(r, extra);
}

/** Resuelve un ID o nombre (en el mismo grupo) de un recurso referenciado. */
export function refId(ctx: AzCtx, value: string | undefined, type: string, rg: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/')) return value;
  return resourceId(ctx.subscriptionId, rg, type, value);
}

export function rgOfId(id: string) {
  return parseResourceId(id).resourceGroup;
}

export function boolArg(v: any): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  return /^(true|yes|1|enabled)$/i.test(String(v));
}
