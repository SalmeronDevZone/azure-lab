// Registro de proveedores de recursos (Microsoft.Compute, Microsoft.Storage, ...).
import type { CloudState, PrincipalRef, Resource, ResourceGroup, Sku, Tags } from './types';
import { nowIso } from './util';

export interface ArmInput {
  type: string;
  name: string;
  location?: string;
  tags?: Tags;
  sku?: Sku;
  kind?: string;
  properties?: Record<string, any>;
  identity?: any;
  zones?: string[];
}

export interface BuildCtx {
  state: CloudState;
  principal: PrincipalRef;
  subscriptionId: string;
  resourceGroup: ResourceGroup;
  id: string;
  existing?: Resource;
}

export type EssentialValue = string | { text: string; link?: string };

export interface ResourceProvider {
  type: string;
  label: string;
  labelPlural: string;
  icon: string;
  category: string;
  description?: string;
  provisionMs: number;
  hidden?: boolean;
  locationless?: boolean;
  parentType?: string;
  global?: { code: string; message: (name: string) => string };
  nameRule?: { test: (name: string) => boolean; message: string };
  build(input: ArmInput, ctx: BuildCtx): Resource;
  afterProvision?(res: Resource, ctx: BuildCtx): void;
  beforeDelete?(res: Resource, state: CloudState): void;
  onDelete?(res: Resource, state: CloudState): void;
  monthlyCost?(res: Resource, state: CloudState): number;
  essentials?(res: Resource, state: CloudState): [string, EssentialValue][];
  status?(res: Resource): string;
  /** Propiedades calculadas que se añaden al serializar (asociaciones, estado de runtime...). */
  decorate?(res: Resource, state: CloudState): Record<string, any>;
}

const providers = new Map<string, ResourceProvider>();

export function registerProvider(p: ResourceProvider) {
  providers.set(p.type.toLowerCase(), p);
}

export function getProvider(type: string): ResourceProvider | undefined {
  return providers.get((type ?? '').toLowerCase());
}

export function allProviders(): ResourceProvider[] {
  return [...providers.values()];
}

export function providerLabel(type: string): string {
  return getProvider(type)?.label ?? type;
}

/** Crea el esqueleto común de un recurso, conservando datos si ya existía. */
export function baseResource(input: ArmInput, ctx: BuildCtx, extra: Partial<Resource> = {}): Resource {
  const ex = ctx.existing;
  return {
    id: ctx.id,
    name: input.name,
    type: getProvider(input.type)?.type ?? input.type,
    subscriptionId: ctx.subscriptionId,
    resourceGroup: ctx.resourceGroup.name,
    location: input.location ?? ex?.location ?? ctx.resourceGroup.location,
    tags: { ...(input.tags ?? ex?.tags ?? {}) },
    kind: input.kind ?? ex?.kind,
    sku: input.sku ? { ...ex?.sku, ...input.sku } : ex?.sku,
    identity: input.identity ?? ex?.identity,
    zones: input.zones ?? ex?.zones,
    properties: {},
    data: ex?.data ?? {},
    createdAt: ex?.createdAt ?? nowIso(),
    createdBy: ex?.createdBy ?? ctx.principal.name,
    ...extra,
  };
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

export function pick<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}
