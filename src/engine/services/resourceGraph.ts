// Azure Resource Graph: consulta con KQL el inventario de recursos (tablas Resources y ResourceContainers).
import type { CloudState, PrincipalRef } from '../types';
import { getState } from '../store';
import { canRead, resourceToArm } from '../arm';
import { getProvider } from '../registry';
import { runKql, type KqlResult, type KqlTable } from './kql';

const RES_COLS: KqlTable['columns'] = [
  { name: 'id', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'tenantId', type: 'string' },
  { name: 'kind', type: 'string' },
  { name: 'location', type: 'string' },
  { name: 'resourceGroup', type: 'string' },
  { name: 'subscriptionId', type: 'string' },
  { name: 'managedBy', type: 'string' },
  { name: 'sku', type: 'dynamic' },
  { name: 'properties', type: 'dynamic' },
  { name: 'tags', type: 'dynamic' },
  { name: 'identity', type: 'dynamic' },
  { name: 'zones', type: 'dynamic' },
];

/** Tablas visibles para un principal (Resource Graph sólo devuelve lo que puedes leer). */
export function graphTables(principal: PrincipalRef | null, subscriptions?: string[], s: CloudState = getState()): Record<string, KqlTable> {
  const subOk = (id: string) => !subscriptions?.length || subscriptions.includes(id);
  const resources = s.resources.filter((r) => !getProvider(r.type)?.hidden && subOk(r.subscriptionId) && canRead(principal, r.id));
  const rows = resources.map((r) => {
    const arm = resourceToArm(r);
    return {
      id: r.id,
      name: r.name,
      // Resource Graph devuelve el tipo y el grupo en minúsculas.
      type: r.type.toLowerCase(),
      tenantId: s.tenant.id,
      kind: r.kind ?? '',
      location: r.location,
      resourceGroup: r.resourceGroup.toLowerCase(),
      subscriptionId: r.subscriptionId,
      managedBy: r.managedBy ?? '',
      sku: r.sku ?? null,
      properties: arm.properties ?? {},
      tags: r.tags ?? {},
      identity: r.identity ?? null,
      zones: r.zones ?? null,
    };
  });
  const containers = [
    ...s.subscriptions.filter((x) => subOk(x.id) && canRead(principal, `/subscriptions/${x.id}`)).map((x) => ({ id: `/subscriptions/${x.id}`, name: x.displayName, type: 'microsoft.resources/subscriptions', tenantId: s.tenant.id, kind: '', location: '', resourceGroup: '', subscriptionId: x.id, managedBy: '', sku: null, properties: { state: x.state, subscriptionPolicies: { quotaId: x.offer } }, tags: {}, identity: null, zones: null })),
    ...s.resourceGroups.filter((g) => subOk(g.subscriptionId) && canRead(principal, g.id)).map((g) => ({ id: g.id, name: g.name, type: 'microsoft.resources/subscriptions/resourcegroups', tenantId: s.tenant.id, kind: '', location: g.location, resourceGroup: g.name.toLowerCase(), subscriptionId: g.subscriptionId, managedBy: g.managedBy ?? '', sku: null, properties: { provisioningState: g.provisioningState }, tags: g.tags ?? {}, identity: null, zones: null })),
  ];
  return { Resources: { columns: RES_COLS, rows }, ResourceContainers: { columns: RES_COLS, rows: containers } };
}

export function graphQuery(query: string, principal: PrincipalRef | null, opts: { subscriptions?: string[]; first?: number } = {}): { result: KqlResult; objects: Record<string, any>[] } {
  const tables = graphTables(principal, opts.subscriptions);
  const result = runKql(query, (name) => tables[name] ?? tables[Object.keys(tables).find((k) => k.toLowerCase() === name.toLowerCase()) ?? '']);
  const first = opts.first ?? 100;
  const objects = result.rows.slice(0, first).map((row) => Object.fromEntries(result.columns.map((c, i) => [c.name, row[i]])));
  return { result, objects };
}

export const GRAPH_SAMPLES: { label: string; q: string }[] = [
  { label: 'Recuento de recursos por tipo', q: 'Resources\n| summarize total = count() by type\n| order by total desc' },
  { label: 'Máquinas virtuales y su tamaño', q: "Resources\n| where type =~ 'microsoft.compute/virtualmachines'\n| project name, resourceGroup, location, tamano = properties.hardwareProfile.vmSize" },
  { label: 'Recursos sin la etiqueta entorno', q: "Resources\n| where isempty(tags['entorno'])\n| project name, type, resourceGroup" },
  { label: 'Cuentas de almacenamiento con acceso público a blobs', q: "Resources\n| where type =~ 'microsoft.storage/storageaccounts'\n| where properties.allowBlobPublicAccess == true\n| project name, resourceGroup" },
  { label: 'Recursos por región', q: 'Resources\n| summarize count() by location' },
  { label: 'Grupos de recursos y sus etiquetas', q: "ResourceContainers\n| where type =~ 'microsoft.resources/subscriptions/resourcegroups'\n| project name, location, tags" },
];
