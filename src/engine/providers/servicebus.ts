// Azure Service Bus: espacios de nombres con colas, temas y suscripciones (mensajería entre aplicaciones).
import type { Resource } from '../types';
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { fakeKey, nowIso } from '../util';

export const T_SB = 'Microsoft.ServiceBus/namespaces';

export interface SbMessage {
  messageId: string;
  sequenceNumber: number;
  body: string;
  properties: Record<string, string>;
  enqueuedTime: string;
  deliveryCount: number;
  label?: string;
  lockedUntil?: number;
  deadLetterReason?: string;
}

export interface SbQueue {
  name: string;
  messages: SbMessage[];
  deadLetter: SbMessage[];
  maxDeliveryCount: number;
  lockDuration: string;
  createdAt: string;
}

export interface SbSubscription extends SbQueue {
  rules: { name: string; sql: string }[];
}

export interface SbTopic {
  name: string;
  subscriptions: Record<string, SbSubscription>;
  createdAt: string;
}

export const SB_SKUS: Record<string, { monthly: number; topics: boolean; label: string }> = {
  Basic: { monthly: 0.05, topics: false, label: 'Básico · sólo colas' },
  Standard: { monthly: 10, topics: true, label: 'Estándar · colas y temas' },
  Premium: { monthly: 677, topics: true, label: 'Premium · recursos dedicados' },
};

export function sbData(ns: Resource) {
  ns.data = ns.data ?? {};
  ns.data.queues = ns.data.queues ?? {};
  ns.data.topics = ns.data.topics ?? {};
  ns.data.seq = ns.data.seq ?? 0;
  return ns.data as { queues: Record<string, SbQueue>; topics: Record<string, SbTopic>; seq: number; keys: { primaryKey: string; secondaryKey: string } };
}

export function connectionStringOf(ns: Resource, which: 'primary' | 'secondary' = 'primary') {
  const d = sbData(ns);
  return `Endpoint=sb://${ns.name}.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${which === 'primary' ? d.keys.primaryKey : d.keys.secondaryKey}`;
}

registerProvider({
  type: T_SB,
  label: 'Espacio de nombres de Service Bus',
  labelPlural: 'Espacios de nombres de Service Bus',
  icon: 'servicebus',
  category: 'Integración',
  description: 'Mensajería empresarial fiable: colas y temas de publicación/suscripción entre aplicaciones.',
  provisionMs: 2500,
  global: { code: 'Conflict', message: (n) => `Namespace name '${n}' is already taken. The namespace name must be unique across Azure (<nombre>.servicebus.windows.net).` },
  nameRule: {
    test: (n) => /^[a-zA-Z][a-zA-Z0-9-]{4,48}[a-zA-Z0-9]$/.test(n) && !/-sb$|-mgmt$/i.test(n),
    message: "The specified namespace name '{name}' is invalid: it must be 6-50 characters, start with a letter, end with a letter or number and contain only letters, numbers and hyphens.",
  },
  build(input, ctx) {
    const ex = ctx.existing;
    const r = baseResource(input, ctx);
    const sku = input.sku?.name ?? ex?.sku?.name ?? 'Standard';
    if (!SB_SKUS[sku]) throw new ArmError('BadRequest', `The specified SKU '${sku}' is not valid. Valid values: Basic, Standard, Premium.`);
    r.sku = { name: sku, tier: sku };
    r.properties = {
      serviceBusEndpoint: `https://${input.name}.servicebus.windows.net:443/`,
      status: 'Active',
      createdAt: ex?.properties.createdAt ?? nowIso(),
      minimumTlsVersion: '1.2',
      publicNetworkAccess: 'Enabled',
      disableLocalAuth: false,
      zoneRedundant: false,
    };
    const d = sbData(r);
    d.keys = d.keys ?? { primaryKey: fakeKey(ctx.id + 'p', 44), secondaryKey: fakeKey(ctx.id + 's', 44) };
    return r;
  },
  decorate: (res) => {
    const d = sbData(res);
    return { queueCount: Object.keys(d.queues).length, topicCount: Object.keys(d.topics).length };
  },
  essentials: (res) => {
    const d = sbData(res);
    return [
      ['Plan de tarifa', `${res.sku?.name} (${SB_SKUS[res.sku?.name ?? 'Standard']?.label ?? ''})`],
      ['Nombre de host', `${res.name}.servicebus.windows.net`],
      ['Colas', String(Object.keys(d.queues).length)],
      ['Temas', String(Object.keys(d.topics).length)],
    ];
  },
  status: () => 'Activo',
  monthlyCost: (res) => SB_SKUS[res.sku?.name ?? 'Standard']?.monthly ?? 10,
});
