// Gobernanza: bloqueos de recursos y Azure Policy.
import type { Lock, PolicyAssignment, PrincipalRef } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, findRg, logActivity, policyViolated, type PolicyTarget } from '../arm';
import { getProvider } from '../registry';
import { isWithinScope, parseResourceId } from '../ids';
import { POLICY_DEFINITIONS, findPolicyDefinition, type PolicyDefinitionInfo } from '../catalog';
import { ciEq, guid, nowIso } from '../util';
import { canonicalizeScope, scopeExists } from './identity';

export function createLock(input: { name: string; level: 'CanNotDelete' | 'ReadOnly'; scope: string; notes?: string }, principal: PrincipalRef | null): Lock {
  const s = getState();
  if (!scopeExists(input.scope, s)) throw new ArmError('InvalidScope', `The scope '${input.scope}' is not valid or the resource doesn't exist.`, 404);
  const scope = canonicalizeScope(input.scope, s);
  authorize(principal, 'Microsoft.Authorization/locks/write', scope);
  if (!['CanNotDelete', 'ReadOnly'].includes(input.level)) throw new ArmError('InvalidLockLevel', `The lock level '${input.level}' is invalid. Allowed values: CanNotDelete, ReadOnly.`);
  if (!/^[^<>%&:?/\\]{1,260}$/.test(input.name)) throw new ArmError('InvalidLockName', 'The lock name is invalid.');
  const existing = s.locks.find((l) => ciEq(l.scope, scope) && ciEq(l.name, input.name));
  const lock: Lock = existing ?? { id: `${scope}/providers/Microsoft.Authorization/locks/${input.name}`, name: input.name, level: input.level, notes: input.notes, scope };
  lock.level = input.level;
  lock.notes = input.notes;
  if (!existing) s.locks.push(lock);
  logActivity({ operationNameValue: 'Microsoft.Authorization/locks/write', operationName: `Crear bloqueo de administración (${input.level})`, status: 'Succeeded', resourceId: lock.id, subscriptionId: parseResourceId(scope).subscriptionId ?? s.currentSubscriptionId, caller: principal?.name });
  changed();
  return lock;
}

export function deleteLock(name: string, scope: string, principal: PrincipalRef | null) {
  const s = getState();
  const lock = s.locks.find((l) => ciEq(l.name, name) && (ciEq(l.scope, scope) || ciEq(l.scope, canonicalizeScope(scope, s))));
  if (!lock) throw new ArmError('LockNotFound', `The lock '${name}' could not be found at scope '${scope}'.`, 404);
  authorize(principal, 'Microsoft.Authorization/locks/delete', lock.scope);
  s.locks = s.locks.filter((l) => l !== lock);
  logActivity({ operationNameValue: 'Microsoft.Authorization/locks/delete', operationName: 'Eliminar bloqueo de administración', status: 'Succeeded', resourceId: lock.id, subscriptionId: parseResourceId(lock.scope).subscriptionId ?? s.currentSubscriptionId, caller: principal?.name });
  changed();
}

export function lockJson(l: Lock) {
  const p = parseResourceId(l.scope);
  return { id: l.id, level: l.level, name: l.name, notes: l.notes ?? null, owners: null, resourceGroup: p.resourceGroup ?? null, type: 'Microsoft.Authorization/locks' };
}

export function assignPolicy(
  input: { name: string; displayName?: string; definition: string; scope: string; params?: Record<string, any>; enforcementMode?: 'Default' | 'DoNotEnforce' },
  principal: PrincipalRef | null,
): PolicyAssignment {
  const s = getState();
  if (!scopeExists(input.scope, s)) throw new ArmError('InvalidScope', `The scope '${input.scope}' is not valid.`, 404);
  const scope = canonicalizeScope(input.scope, s);
  authorize(principal, 'Microsoft.Authorization/policyAssignments/write', scope);
  const def = findPolicyDefinition(input.definition);
  if (!def) throw new ArmError('PolicyDefinitionNotFound', `The policy definition '${input.definition}' could not be found.`, 404, 'Lista las definiciones con: az policy definition list --query "[].{name:name, displayName:displayName}" -o table');
  const params: Record<string, { value: any }> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) params[k] = v && typeof v === 'object' && 'value' in v ? v : { value: v };
  for (const k of Object.keys(def.parameters)) {
    if (!(k in params)) throw new ArmError('MissingPolicyParameter', `The policy assignment '${input.name}' is missing the parameter(s) '${k}' as defined in the policy definition '${def.name}'.`, 400);
  }
  if (s.policyAssignments.some((a) => ciEq(a.scope, scope) && ciEq(a.name, input.name))) {
    s.policyAssignments = s.policyAssignments.filter((a) => !(ciEq(a.scope, scope) && ciEq(a.name, input.name)));
  }
  const pa: PolicyAssignment = {
    id: `${scope}/providers/Microsoft.Authorization/policyAssignments/${input.name}`,
    name: input.name,
    displayName: input.displayName ?? def.displayName,
    scope,
    policyDefinitionId: `/providers/Microsoft.Authorization/policyDefinitions/${def.name}`,
    parameters: params,
    enforcementMode: input.enforcementMode ?? 'Default',
    createdAt: nowIso(),
  };
  s.policyAssignments.push(pa);
  logActivity({ operationNameValue: 'Microsoft.Authorization/policyAssignments/write', operationName: `Crear asignación de directiva (${def.displayName})`, status: 'Succeeded', resourceId: pa.id, subscriptionId: parseResourceId(scope).subscriptionId ?? s.currentSubscriptionId, caller: principal?.name, category: 'Policy' });
  changed();
  return pa;
}

export function deletePolicyAssignment(name: string, scope: string | undefined, principal: PrincipalRef | null) {
  const s = getState();
  const pa = s.policyAssignments.find((a) => ciEq(a.name, name) && (!scope || ciEq(a.scope, scope) || ciEq(a.scope, canonicalizeScope(scope, s))));
  if (!pa) throw new ArmError('PolicyAssignmentNotFound', `The policy assignment '${name}' is not found.`, 404);
  authorize(principal, 'Microsoft.Authorization/policyAssignments/delete', pa.scope);
  s.policyAssignments = s.policyAssignments.filter((a) => a !== pa);
  changed();
}

export function policyAssignmentJson(a: PolicyAssignment) {
  return {
    description: null,
    displayName: a.displayName,
    enforcementMode: a.enforcementMode,
    id: a.id,
    identity: null,
    location: null,
    metadata: { createdOn: a.createdAt },
    name: a.name,
    nonComplianceMessages: null,
    notScopes: [],
    parameters: a.parameters,
    policyDefinitionId: a.policyDefinitionId,
    scope: a.scope,
    type: 'Microsoft.Authorization/policyAssignments',
  };
}

export function definitionOf(a: PolicyAssignment): PolicyDefinitionInfo | undefined {
  return POLICY_DEFINITIONS.find((d) => a.policyDefinitionId.toLowerCase().endsWith(d.name));
}

export interface ComplianceRow {
  assignment: PolicyAssignment;
  def: PolicyDefinitionInfo;
  compliant: string[];
  nonCompliant: string[];
}

/** Evalúa el cumplimiento de los recursos existentes frente a las asignaciones. */
export function complianceReport(): ComplianceRow[] {
  const s = getState();
  const rows: ComplianceRow[] = [];
  for (const a of s.policyAssignments) {
    const def = definitionOf(a);
    if (!def) continue;
    const row: ComplianceRow = { assignment: a, def, compliant: [], nonCompliant: [] };
    const targets: PolicyTarget[] = [];
    for (const rg of s.resourceGroups) {
      if (isWithinScope(rg.id, a.scope)) targets.push({ kind: 'rg', id: rg.id, name: rg.name, type: 'Microsoft.Resources/resourceGroups', location: rg.location, tags: rg.tags });
    }
    for (const r of s.resources) {
      if (getProvider(r.type)?.hidden) continue;
      if (!isWithinScope(r.id, a.scope)) continue;
      const rg = findRg(r.subscriptionId, r.resourceGroup, s);
      targets.push({ kind: 'resource', id: r.id, name: r.name, type: r.type, location: r.location, tags: r.tags, sku: r.sku, properties: r.properties, rgTags: rg?.tags });
    }
    for (const t of targets) {
      const applicable =
        def.rule.endsWith('Rg') ? t.kind === 'rg' :
        ['allowedVmSkus', 'secureTransfer', 'allowedStorageSkus', 'noPublicBlob', 'kvPurgeProtection'].includes(def.rule) ? policyApplies(def, t) :
        t.kind === 'resource';
      if (!applicable) continue;
      if (policyViolated(def, a.parameters, t)) row.nonCompliant.push(t.id);
      else row.compliant.push(t.id);
    }
    rows.push(row);
  }
  return rows;
}

function policyApplies(def: PolicyDefinitionInfo, t: PolicyTarget): boolean {
  if (t.kind !== 'resource') return false;
  if (def.rule === 'allowedVmSkus') return ciEq(t.type, 'Microsoft.Compute/virtualMachines');
  if (def.rule === 'kvPurgeProtection') return ciEq(t.type, 'Microsoft.KeyVault/vaults');
  return ciEq(t.type, 'Microsoft.Storage/storageAccounts');
}

export function newLockId() {
  return guid();
}
