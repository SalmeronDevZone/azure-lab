// Plano de datos de Service Bus: envío, inspección y recepción de mensajes; filtros SQL de suscripciones.
import type { PrincipalRef, Resource } from '../types';
import { changed } from '../store';
import { ArmError } from '../errors';
import { authorize, hasPermission, patchResource } from '../arm';
import { guid, nowIso } from '../util';
import { sbData, SB_SKUS, type SbMessage, type SbQueue, type SbSubscription } from '../providers/servicebus';

const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,258}[a-zA-Z0-9_])?$/;

/**
 * Plano de datos: con un rol de datos (Azure Service Bus Data Sender/Receiver/Owner) o, si la autenticación local
 * está habilitada, con permiso para leer las claves SAS (como el Explorador de Service Bus del portal).
 */
function authorizeData(principal: PrincipalRef | null, ns: Resource, action: 'send' | 'receive') {
  const dataAction = `Microsoft.ServiceBus/namespaces/messages/${action}/action`;
  if (hasPermission(principal, dataAction, ns.id, true)) return;
  if (!ns.properties.disableLocalAuth && hasPermission(principal, 'Microsoft.ServiceBus/namespaces/authorizationRules/listKeys/action', ns.id)) return;
  authorize(principal, dataAction, ns.id, true);
}

function newEntity(name: string, opts: { maxDeliveryCount?: number; lockDuration?: string }): SbQueue {
  return { name, messages: [], deadLetter: [], maxDeliveryCount: opts.maxDeliveryCount ?? 10, lockDuration: opts.lockDuration ?? 'PT1M', createdAt: nowIso() };
}

export function createQueue(ns: Resource, name: string, opts: { maxDeliveryCount?: number; lockDuration?: string }, principal: PrincipalRef | null) {
  if (!NAME_RE.test(name)) throw new ArmError('BadRequest', `The entity name '${name}' is invalid.`);
  if (sbData(ns).topics[name.toLowerCase()]) throw new ArmError('Conflict', `Entity '${ns.name}:Topic:${name}' already exists with the same name.`, 409);
  patchResource(
    ns.id,
    (r) => {
      const d = sbData(r);
      if (!d.queues[name.toLowerCase()]) d.queues[name.toLowerCase()] = newEntity(name.toLowerCase(), opts);
    },
    { principal, action: 'Microsoft.ServiceBus/namespaces/queues/write', opName: `Crear la cola ${name}` },
  );
  return sbData(ns).queues[name.toLowerCase()];
}

export function createTopic(ns: Resource, name: string, principal: PrincipalRef | null) {
  if (!SB_SKUS[ns.sku?.name ?? 'Standard']?.topics) {
    throw new ArmError('BadRequest', `SubCode=40000. Topics are not supported in the Basic tier. Namespace: ${ns.name}.`, 400, 'Los temas (publicación/suscripción) requieren el nivel Estándar o Premium: az servicebus namespace update --sku Standard');
  }
  if (!NAME_RE.test(name)) throw new ArmError('BadRequest', `The entity name '${name}' is invalid.`);
  patchResource(
    ns.id,
    (r) => {
      const d = sbData(r);
      if (!d.topics[name.toLowerCase()]) d.topics[name.toLowerCase()] = { name: name.toLowerCase(), subscriptions: {}, createdAt: nowIso() };
    },
    { principal, action: 'Microsoft.ServiceBus/namespaces/topics/write', opName: `Crear el tema ${name}` },
  );
  return sbData(ns).topics[name.toLowerCase()];
}

export function createSubscription(ns: Resource, topic: string, name: string, opts: { maxDeliveryCount?: number }, principal: PrincipalRef | null) {
  const t = sbData(ns).topics[topic.toLowerCase()];
  if (!t) throw new ArmError('MessagingEntityNotFound', `The messaging entity '${ns.name}:topic:${topic}' could not be found.`, 404);
  patchResource(
    ns.id,
    () => {
      if (!t.subscriptions[name.toLowerCase()]) t.subscriptions[name.toLowerCase()] = { ...newEntity(name.toLowerCase(), opts), rules: [{ name: '$Default', sql: '1=1' }] };
    },
    { principal, action: 'Microsoft.ServiceBus/namespaces/topics/subscriptions/write', opName: `Crear la suscripción ${topic}/${name}` },
  );
  return t.subscriptions[name.toLowerCase()];
}

export function getSubscription(ns: Resource, topic: string, name: string): SbSubscription {
  const t = sbData(ns).topics[topic.toLowerCase()];
  const sub = t?.subscriptions[name.toLowerCase()];
  if (!sub) throw new ArmError('MessagingEntityNotFound', `The messaging entity '${ns.name}:topic:${topic}|${name}' could not be found.`, 404);
  return sub;
}

export function setRule(ns: Resource, topic: string, sub: string, name: string, sql: string | null, principal: PrincipalRef | null) {
  const s = getSubscription(ns, topic, sub);
  if (sql !== null) parseFilter(sql);
  patchResource(
    ns.id,
    () => {
      s.rules = s.rules.filter((r) => r.name !== name);
      if (sql !== null) s.rules.push({ name, sql });
    },
    { principal, action: 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules/write', opName: `${sql === null ? 'Eliminar' : 'Crear'} la regla ${name}` },
  );
  return s.rules;
}

// ---------------------------------------------------------------- filtros SQL (subconjunto)

type Cond = { prop: string; op: '=' | '<>' | 'in' | 'not in' | 'like'; values: string[] } | { always: boolean };

function parseFilter(sql: string): Cond[][] {
  const text = sql.trim();
  if (/^(1\s*=\s*1|true)$/i.test(text)) return [[{ always: true }]];
  if (/^(1\s*=\s*0|false)$/i.test(text)) return [[{ always: false }]];
  return text.split(/\s+or\s+/i).map((part) =>
    part.split(/\s+and\s+/i).map((c) => {
      const m = /^\s*([\w.]+)\s*(=|<>|!=|not\s+in|in|like)\s*(.+?)\s*$/i.exec(c);
      if (!m) throw new ArmError('BadRequest', `The filter expression '${c}' is not valid. Ejemplos válidos: prioridad = 'alta', region IN ('es','pt'), sys.Label = 'pedido'.`, 400);
      const op = m[2].toLowerCase().replace(/\s+/g, ' ').replace('!=', '<>') as any;
      const raw = m[3].replace(/^\(|\)$/g, '');
      const values = raw.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
      return { prop: m[1], op, values };
    }),
  );
}

function matches(sql: string, msg: SbMessage): boolean {
  return parseFilter(sql).some((and) =>
    and.every((c) => {
      if ('always' in c) return c.always;
      const v = c.prop.toLowerCase() === 'sys.label' ? msg.label ?? '' : c.prop.toLowerCase() === 'sys.messageid' ? msg.messageId : msg.properties[c.prop] ?? '';
      if (c.op === '=') return v === c.values[0];
      if (c.op === '<>') return v !== c.values[0];
      if (c.op === 'in') return c.values.includes(v);
      if (c.op === 'not in') return !c.values.includes(v);
      return new RegExp('^' + c.values[0].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$').test(v);
    }),
  );
}

// ---------------------------------------------------------------- mensajes

export type EntityRef = { kind: 'queue'; queue: string } | { kind: 'subscription'; topic: string; subscription: string };

function entity(ns: Resource, ref: EntityRef): SbQueue {
  if (ref.kind === 'queue') {
    const q = sbData(ns).queues[ref.queue.toLowerCase()];
    if (!q) throw new ArmError('MessagingEntityNotFound', `The messaging entity '${ns.name}:queue:${ref.queue}' could not be found.`, 404);
    return q;
  }
  return getSubscription(ns, ref.topic, ref.subscription);
}

/** Envía un mensaje a una cola o a un tema (se copia a las suscripciones cuyas reglas coinciden). */
export function sendMessage(ns: Resource, to: { queue?: string; topic?: string }, body: string, props: Record<string, string>, label: string | undefined, principal: PrincipalRef | null): number {
  authorizeData(principal, ns, 'send');
  const d = sbData(ns);
  const mk = (): SbMessage => ({ messageId: guid().replace(/-/g, ''), sequenceNumber: ++d.seq, body, properties: { ...props }, enqueuedTime: nowIso(), deliveryCount: 0, label });
  let delivered = 0;
  if (to.queue) {
    const q = d.queues[to.queue.toLowerCase()];
    if (!q) throw new ArmError('MessagingEntityNotFound', `The messaging entity '${ns.name}:queue:${to.queue}' could not be found.`, 404);
    q.messages.push(mk());
    delivered = 1;
  } else if (to.topic) {
    const t = d.topics[to.topic.toLowerCase()];
    if (!t) throw new ArmError('MessagingEntityNotFound', `The messaging entity '${ns.name}:topic:${to.topic}' could not be found.`, 404);
    const probe = mk();
    for (const sub of Object.values(t.subscriptions)) {
      if (sub.rules.some((r) => matches(r.sql, probe))) {
        sub.messages.push({ ...probe, properties: { ...probe.properties } });
        delivered++;
      }
    }
  }
  changed();
  return delivered;
}

export function peekMessages(ns: Resource, ref: EntityRef, deadLetter = false, n = 32): SbMessage[] {
  const e = entity(ns, ref);
  return (deadLetter ? e.deadLetter : e.messages).slice(0, n);
}

/** Recibe y elimina (receive-and-delete) hasta n mensajes. */
export function receiveMessages(ns: Resource, ref: EntityRef, n: number, principal: PrincipalRef | null, deadLetter = false): SbMessage[] {
  authorizeData(principal, ns, 'receive');
  const e = entity(ns, ref);
  const list = deadLetter ? e.deadLetter : e.messages;
  const out = list.splice(0, n).map((m) => ({ ...m, deliveryCount: m.deliveryCount + 1 }));
  changed();
  return out;
}

/** Simula un consumidor que falla: incrementa el recuento de entregas y, al superar el máximo, mueve el mensaje a la cola de mensajes fallidos. */
export function abandonFirst(ns: Resource, ref: EntityRef, principal: PrincipalRef | null): SbMessage | null {
  authorizeData(principal, ns, 'receive');
  const e = entity(ns, ref);
  const m = e.messages[0];
  if (!m) return null;
  m.deliveryCount++;
  if (m.deliveryCount >= e.maxDeliveryCount) {
    e.messages.shift();
    e.deadLetter.push({ ...m, deadLetterReason: 'MaxDeliveryCountExceeded' });
  }
  changed();
  return m;
}

export function countDetails(e: SbQueue) {
  return { activeMessageCount: e.messages.length, deadLetterMessageCount: e.deadLetter.length, scheduledMessageCount: 0, transferDeadLetterMessageCount: 0, transferMessageCount: 0 };
}
