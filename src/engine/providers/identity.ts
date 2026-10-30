// Identidades administradas (asignadas por el sistema y por el usuario).
import type { CloudState, Identity, Resource, ServicePrincipal } from '../types';
import { registerProvider, baseResource } from '../registry';
import { guid, nowIso, ciEq } from '../util';

export function createManagedIdentitySp(s: CloudState, displayName: string, resourceId: string, explicit: boolean): ServicePrincipal {
  const sp: ServicePrincipal = {
    id: guid(),
    appId: guid(),
    displayName,
    servicePrincipalType: 'ManagedIdentity',
    secrets: [],
    alternativeNames: [`isExplicit=${explicit ? 'True' : 'False'}`, resourceId],
    createdAt: nowIso(),
  };
  s.servicePrincipals.push(sp);
  return sp;
}

export function removePrincipal(s: CloudState, objectId: string) {
  s.servicePrincipals = s.servicePrincipals.filter((p) => p.id !== objectId);
  s.roleAssignments = s.roleAssignments.filter((a) => a.principalId !== objectId);
  for (const g of s.groups) g.members = g.members.filter((m) => m !== objectId);
}

/**
 * Normaliza la identidad pedida para un recurso: crea la entidad de servicio de la identidad
 * asignada por el sistema si hace falta, o la elimina si se quita.
 */
export function resolveIdentity(s: CloudState, requested: any, existing: Identity | undefined, resourceName: string, resourceId: string): Identity | undefined {
  if (requested === undefined) return existing;
  const type = String(requested?.type ?? 'None');
  const wantsSystem = /systemassigned/i.test(type);
  const wantsUser = /userassigned/i.test(type);
  let principalId = existing?.principalId;
  if (wantsSystem && !principalId) principalId = createManagedIdentitySp(s, resourceName, resourceId, false).id;
  if (!wantsSystem && principalId) {
    removePrincipal(s, principalId);
    principalId = undefined;
  }
  if (!wantsSystem && !wantsUser) return undefined;
  const uai: Record<string, { principalId: string; clientId: string }> = {};
  if (wantsUser) {
    for (const id of Object.keys(requested.userAssignedIdentities ?? existing?.userAssignedIdentities ?? {})) {
      const r = s.resources.find((x) => ciEq(x.id, id));
      uai[r?.id ?? id] = { principalId: r?.properties.principalId ?? guid(), clientId: r?.properties.clientId ?? guid() };
    }
  }
  return {
    type: (wantsSystem && wantsUser ? 'SystemAssigned, UserAssigned' : wantsSystem ? 'SystemAssigned' : 'UserAssigned') as Identity['type'],
    principalId,
    tenantId: wantsSystem ? s.tenant.id : undefined,
    userAssignedIdentities: wantsUser ? uai : undefined,
  };
}

export function cleanupIdentity(res: Resource, s: CloudState) {
  if (res.identity?.principalId) removePrincipal(s, res.identity.principalId);
}

/** Devuelve los objectIds de las identidades con las que se ejecuta un recurso. */
export function identityPrincipalIds(res: Resource): string[] {
  const out: string[] = [];
  if (res.identity?.principalId) out.push(res.identity.principalId);
  for (const v of Object.values(res.identity?.userAssignedIdentities ?? {})) out.push(v.principalId);
  return out;
}

registerProvider({
  type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
  label: 'Identidad administrada',
  labelPlural: 'Identidades administradas',
  icon: 'identity',
  category: 'Identidad',
  description: 'Identidad de Microsoft Entra que puedes asignar a uno o varios recursos.',
  provisionMs: 1000,
  build(input, ctx) {
    const ex = ctx.existing;
    const r = baseResource(input, ctx);
    let principalId = ex?.properties.principalId;
    let clientId = ex?.properties.clientId;
    if (!principalId) {
      const sp = createManagedIdentitySp(ctx.state, input.name, ctx.id, true);
      principalId = sp.id;
      clientId = sp.appId;
    }
    r.properties = { tenantId: ctx.state.tenant.id, principalId, clientId, isolationScope: 'None' };
    return r;
  },
  onDelete(res, s) {
    if (res.properties.principalId) removePrincipal(s, res.properties.principalId);
  },
  essentials(res) {
    return [
      ['Id. de cliente', res.properties.clientId],
      ['Id. de objeto (principal)', res.properties.principalId],
    ];
  },
  monthlyCost: () => 0,
});
