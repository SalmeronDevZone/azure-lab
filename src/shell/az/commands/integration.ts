// az graph query (Azure Resource Graph) y az servicebus (espacios de nombres, colas, temas, suscripciones y reglas).
import { register, group, A, type Args, type AzCtx, type AzArg } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { KqlError } from '../../../engine/services/kql';
import { deleteResource, patchResource, putResource } from '../../../engine/arm';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { graphQuery } from '../../../engine/services/resourceGraph';
import { T_SB, sbData, connectionStringOf, type SbQueue } from '../../../engine/providers/servicebus';
import { createQueue, createTopic, createSubscription, getSubscription, setRule, countDetails } from '../../../engine/services/servicebus';
import { fakeKey } from '../../../engine/util';

// ---------------------------------------------------------------- Resource Graph

group('graph', 'Consulta recursos con Azure Resource Graph (KQL).');

register({
  path: 'graph query',
  summary: 'Ejecuta una consulta de Resource Graph (KQL) sobre los recursos a los que tienes acceso.',
  args: [
    { name: 'graph_query', opts: ['--graph-query', '-q'], help: 'Consulta KQL, p. ej. "Resources | summarize count() by type".', required: true },
    { name: 'first', opts: ['--first'], help: 'Número máximo de filas (1-1000).', type: 'int', default: 100 },
    { name: 'subscriptions', opts: ['--subscriptions'], help: 'Suscripciones en las que buscar.', type: 'list' },
  ],
  examples: [
    { title: 'Recuento de recursos por tipo.', cmd: 'az graph query -q "Resources | summarize count() by type" -o table' },
    { title: 'VMs y su tamaño.', cmd: "az graph query -q \"Resources | where type =~ 'microsoft.compute/virtualmachines' | project name, size = properties.hardwareProfile.vmSize\"" },
  ],
  table: (r: any) => r.data,
  run(a, ctx) {
    const s = getState();
    s.cli.extensions = s.cli.extensions ?? [];
    if (!s.cli.extensions.includes('resource-graph')) {
      ctx.warn("The command requires the extension resource-graph. It will be installed first.");
      s.cli.extensions.push('resource-graph');
      changed();
    }
    try {
      const { result, objects } = graphQuery(a.graph_query, ctx.principal, { subscriptions: a.subscriptions, first: Math.min(1000, Math.max(1, a.first)) });
      return { count: objects.length, data: objects, skip_token: null, total_records: result.rows.length };
    } catch (e) {
      if (e instanceof KqlError) throw new ArmError('BadRequest', `Please provide below info when asking for support: ... Query is invalid. ${e.message}`, 400, 'Las tablas disponibles son Resources y ResourceContainers. Recuerda que type viene en minúsculas: usa =~ para comparar sin distinguir mayúsculas.');
      throw e;
    }
  },
});

// ---------------------------------------------------------------- Service Bus

group('servicebus', 'Administra Azure Service Bus.');
group('servicebus namespace', 'Espacios de nombres de Service Bus.');
group('servicebus namespace authorization-rule', 'Reglas de autorización (SAS) del espacio de nombres.');
group('servicebus namespace authorization-rule keys', 'Claves de una regla de autorización.');
group('servicebus queue', 'Colas de Service Bus.');
group('servicebus topic', 'Temas de Service Bus.');
group('servicebus topic subscription', 'Suscripciones de un tema.');
group('servicebus topic subscription rule', 'Reglas (filtros) de una suscripción.');

const nsArg: AzArg = { name: 'namespace_name', opts: ['--namespace-name'], help: 'Nombre del espacio de nombres.', required: true };
const topicArg: AzArg = { name: 'topic_name', opts: ['--topic-name'], help: 'Nombre del tema.', required: true };
const subArg: AzArg = { name: 'subscription_name', opts: ['--subscription-name'], help: 'Nombre de la suscripción.', required: true };
const mdcArg: AzArg = { name: 'max_delivery_count', opts: ['--max-delivery-count'], help: 'Entregas máximas antes de enviar el mensaje a la cola de mensajes fallidos.', type: 'int' };

function ns(ctx: AzCtx, a: Args) {
  return getRes(ctx, { resource_group: a.resource_group, name: a.namespace_name }, T_SB);
}

const entityJson = (n: ReturnType<typeof ns>, type: string, e: SbQueue, extra: Record<string, any> = {}) => ({
  countDetails: countDetails(e),
  createdAt: e.createdAt,
  deadLetteringOnMessageExpiration: false,
  defaultMessageTimeToLive: 'P14D',
  id: `${n.id}/${type}/${e.name}`,
  lockDuration: e.lockDuration,
  maxDeliveryCount: e.maxDeliveryCount,
  messageCount: e.messages.length + e.deadLetter.length,
  name: e.name,
  resourceGroup: n.resourceGroup,
  status: 'Active',
  type: `Microsoft.ServiceBus/Namespaces/${type}`,
  ...extra,
});

const countTable = (r: any) => (Array.isArray(r) ? r : [r]).map((x) => ({ Name: x.name, ResourceGroup: x.resourceGroup, Status: x.status, ActiveMessages: x.countDetails?.activeMessageCount ?? '', DeadLetter: x.countDetails?.deadLetterMessageCount ?? '', MaxDeliveryCount: x.maxDeliveryCount ?? '' }));

register({
  path: 'servicebus namespace create',
  summary: 'Crea un espacio de nombres de Service Bus.',
  args: [A.rg(), A.name('Nombre (único en Azure): <nombre>.servicebus.windows.net.'), A.location(), A.sku('Nivel.', ['Basic', 'Standard', 'Premium'], 'Standard'), A.tags()],
  longRunning: true,
  examples: [{ title: 'Espacio de nombres estándar (colas y temas).', cmd: 'az servicebus namespace create -g rg-mensajes -n sb-tienda-ana --sku Standard' }],
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    return flat(await putResource({ type: T_SB, name: a.name, location: a.location, sku: { name: a.sku }, tags: a.tags, properties: {} }, rg.name, op(ctx)));
  },
});
register({ path: 'servicebus namespace list', summary: 'Lista los espacios de nombres.', args: [A.rg(false)], table: (r: any[]) => r.map((x) => ({ Name: x.name, ResourceGroup: x.resourceGroup, Location: x.location, Sku: x.sku?.name, Status: x.status })), run: (a, ctx) => listInSub(ctx, T_SB, a.resource_group).map((r) => flat(r)) });
register({ path: 'servicebus namespace show', summary: 'Muestra un espacio de nombres.', args: [A.rg(), A.name('Nombre.')], run: (a, ctx) => flat(getRes(ctx, a, T_SB)) });
register({
  path: 'servicebus namespace update',
  summary: 'Actualiza un espacio de nombres (p. ej. el nivel).',
  args: [A.rg(), A.name('Nombre.'), A.sku('Nivel.', ['Basic', 'Standard', 'Premium']), { name: 'disable_local_auth', opts: ['--disable-local-auth'], help: 'Deshabilita la autenticación con claves SAS (sólo Entra ID).', type: 'bool' }],
  async run(a, ctx) {
    const r = getRes(ctx, a, T_SB);
    if (a.sku && r.sku?.name !== 'Basic' && a.sku === 'Basic' && Object.keys(sbData(r).topics).length) throw new ArmError('BadRequest', 'Cannot downgrade to Basic tier while topics exist.', 400);
    patchResource(
      r.id,
      (x) => {
        if (a.sku) x.sku = { name: a.sku, tier: a.sku };
        if (a.disable_local_auth !== undefined) x.properties.disableLocalAuth = a.disable_local_auth;
      },
      op(ctx),
    );
    return flat(r);
  },
});
register({
  path: 'servicebus namespace delete',
  summary: 'Elimina un espacio de nombres con todas sus entidades.',
  args: [A.rg(), A.name('Nombre.'), A.noWait()],
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_SB).id, op(ctx, a));
    return undefined;
  },
});

register({
  path: 'servicebus namespace authorization-rule keys list',
  summary: 'Muestra las claves y cadenas de conexión de una regla SAS.',
  args: [A.rg(), nsArg, A.name('Nombre de la regla (RootManageSharedAccessKey).')],
  run(a, ctx) {
    const n = ns(ctx, a);
    if (a.name !== 'RootManageSharedAccessKey') throw new ArmError('NotFound', `The authorization rule '${a.name}' was not found.`, 404);
    if (n.properties.disableLocalAuth) throw new ArmError('BadRequest', 'Local authentication is disabled for this namespace. Use Microsoft Entra ID.', 400);
    patchResource(n.id, () => undefined, { ...op(ctx), action: 'Microsoft.ServiceBus/namespaces/authorizationRules/listKeys/action', opName: 'Listar las claves de acceso' });
    const d = sbData(n);
    return { keyName: a.name, primaryConnectionString: connectionStringOf(n, 'primary'), primaryKey: d.keys.primaryKey, secondaryConnectionString: connectionStringOf(n, 'secondary'), secondaryKey: d.keys.secondaryKey };
  },
});
register({
  path: 'servicebus namespace authorization-rule keys renew',
  summary: 'Regenera una clave SAS.',
  args: [A.rg(), nsArg, A.name('Nombre de la regla.'), { name: 'key', opts: ['--key'], help: 'Clave.', choices: ['PrimaryKey', 'SecondaryKey'], required: true }],
  run(a, ctx) {
    const n = ns(ctx, a);
    patchResource(
      n.id,
      (x) => {
        const d = sbData(x);
        d.keys = { ...d.keys, [a.key === 'PrimaryKey' ? 'primaryKey' : 'secondaryKey']: fakeKey(x.id + Date.now(), 44) };
      },
      { ...op(ctx), action: 'Microsoft.ServiceBus/namespaces/authorizationRules/regenerateKeys/action', opName: 'Regenerar clave SAS' },
    );
    return { keyName: a.name, primaryConnectionString: connectionStringOf(n, 'primary'), secondaryConnectionString: connectionStringOf(n, 'secondary') };
  },
});

// colas
register({
  path: 'servicebus queue create',
  summary: 'Crea una cola.',
  args: [A.rg(), nsArg, A.name('Nombre de la cola.'), mdcArg, { name: 'lock_duration', opts: ['--lock-duration'], help: 'Duración del bloqueo (ISO 8601, p. ej. PT1M).' }],
  table: countTable,
  run(a, ctx) {
    const n = ns(ctx, a);
    return entityJson(n, 'queues', createQueue(n, a.name, { maxDeliveryCount: a.max_delivery_count, lockDuration: a.lock_duration }, ctx.principal));
  },
});
register({ path: 'servicebus queue list', summary: 'Lista las colas.', args: [A.rg(), nsArg], table: countTable, run: (a, ctx) => { const n = ns(ctx, a); return Object.values(sbData(n).queues).map((q) => entityJson(n, 'queues', q)); } });
register({
  path: 'servicebus queue show',
  summary: 'Muestra una cola (countDetails indica los mensajes activos y fallidos).',
  args: [A.rg(), nsArg, A.name('Nombre de la cola.')],
  table: countTable,
  run(a, ctx) {
    const n = ns(ctx, a);
    const q = sbData(n).queues[String(a.name).toLowerCase()];
    if (!q) throw new ArmError('NotFound', `The messaging entity '${n.name}:queue:${a.name}' could not be found.`, 404);
    return entityJson(n, 'queues', q);
  },
});
register({
  path: 'servicebus queue delete',
  summary: 'Elimina una cola.',
  args: [A.rg(), nsArg, A.name('Nombre de la cola.')],
  run(a, ctx) {
    const n = ns(ctx, a);
    patchResource(n.id, (x) => void delete sbData(x).queues[String(a.name).toLowerCase()], { ...op(ctx), action: 'Microsoft.ServiceBus/namespaces/queues/delete', opName: `Eliminar la cola ${a.name}` });
    return undefined;
  },
});

// temas
register({
  path: 'servicebus topic create',
  summary: 'Crea un tema (publicación/suscripción; requiere nivel Estándar).',
  args: [A.rg(), nsArg, A.name('Nombre del tema.')],
  run(a, ctx) {
    const n = ns(ctx, a);
    const t = createTopic(n, a.name, ctx.principal);
    return { id: `${n.id}/topics/${t.name}`, name: t.name, resourceGroup: n.resourceGroup, status: 'Active', subscriptionCount: Object.keys(t.subscriptions).length, type: 'Microsoft.ServiceBus/Namespaces/Topics' };
  },
});
register({ path: 'servicebus topic list', summary: 'Lista los temas.', args: [A.rg(), nsArg], table: (r: any[]) => r.map((x) => ({ Name: x.name, ResourceGroup: x.resourceGroup, Status: x.status, SubscriptionCount: x.subscriptionCount })), run: (a, ctx) => { const n = ns(ctx, a); return Object.values(sbData(n).topics).map((t) => ({ id: `${n.id}/topics/${t.name}`, name: t.name, resourceGroup: n.resourceGroup, status: 'Active', subscriptionCount: Object.keys(t.subscriptions).length })); } });
register({
  path: 'servicebus topic delete',
  summary: 'Elimina un tema y sus suscripciones.',
  args: [A.rg(), nsArg, A.name('Nombre del tema.')],
  run(a, ctx) {
    const n = ns(ctx, a);
    patchResource(n.id, (x) => void delete sbData(x).topics[String(a.name).toLowerCase()], { ...op(ctx), action: 'Microsoft.ServiceBus/namespaces/topics/delete', opName: `Eliminar el tema ${a.name}` });
    return undefined;
  },
});

// suscripciones
register({
  path: 'servicebus topic subscription create',
  summary: 'Crea una suscripción a un tema (por defecto recibe todos los mensajes: regla $Default 1=1).',
  args: [A.rg(), nsArg, topicArg, A.name('Nombre de la suscripción.'), mdcArg],
  table: countTable,
  run(a, ctx) {
    const n = ns(ctx, a);
    return entityJson(n, `topics/${a.topic_name}/subscriptions`, createSubscription(n, a.topic_name, a.name, { maxDeliveryCount: a.max_delivery_count }, ctx.principal));
  },
});
register({ path: 'servicebus topic subscription list', summary: 'Lista las suscripciones de un tema.', args: [A.rg(), nsArg, topicArg], table: countTable, run: (a, ctx) => { const n = ns(ctx, a); const t = sbData(n).topics[String(a.topic_name).toLowerCase()]; if (!t) throw new ArmError('NotFound', `Topic ${a.topic_name} not found.`, 404); return Object.values(t.subscriptions).map((x) => entityJson(n, `topics/${t.name}/subscriptions`, x)); } });
register({ path: 'servicebus topic subscription show', summary: 'Muestra una suscripción.', args: [A.rg(), nsArg, topicArg, A.name('Nombre de la suscripción.')], table: countTable, run: (a, ctx) => { const n = ns(ctx, a); return entityJson(n, `topics/${a.topic_name}/subscriptions`, getSubscription(n, a.topic_name, a.name)); } });
register({
  path: 'servicebus topic subscription delete',
  summary: 'Elimina una suscripción.',
  args: [A.rg(), nsArg, topicArg, A.name('Nombre de la suscripción.')],
  run(a, ctx) {
    const n = ns(ctx, a);
    getSubscription(n, a.topic_name, a.name);
    patchResource(n.id, (x) => void delete sbData(x).topics[String(a.topic_name).toLowerCase()].subscriptions[String(a.name).toLowerCase()], { ...op(ctx), action: 'Microsoft.ServiceBus/namespaces/topics/subscriptions/delete', opName: `Eliminar la suscripción ${a.name}` });
    return undefined;
  },
});

// reglas
register({
  path: 'servicebus topic subscription rule create',
  summary: 'Crea una regla de filtro SQL en una suscripción.',
  args: [A.rg(), nsArg, topicArg, subArg, A.name('Nombre de la regla.'), { name: 'filter_sql_expression', opts: ['--filter-sql-expression'], help: "Expresión, p. ej. prioridad = 'alta'.", required: true }],
  examples: [{ title: 'Sólo pedidos urgentes.', cmd: "az servicebus topic subscription rule create -g rg-mensajes --namespace-name sb-tienda-ana --topic-name pedidos --subscription-name urgentes -n solo-alta --filter-sql-expression \"prioridad = 'alta'\"" }],
  run(a, ctx) {
    const n = ns(ctx, a);
    setRule(n, a.topic_name, a.subscription_name, a.name, a.filter_sql_expression, ctx.principal);
    return { filterType: 'SqlFilter', name: a.name, sqlFilter: { sqlExpression: a.filter_sql_expression }, type: 'Microsoft.ServiceBus/Namespaces/Topics/Subscriptions/Rules' };
  },
});
register({ path: 'servicebus topic subscription rule list', summary: 'Lista las reglas de una suscripción.', args: [A.rg(), nsArg, topicArg, subArg], table: (r: any[]) => r.map((x) => ({ Name: x.name, Filter: x.sqlFilter.sqlExpression })), run: (a, ctx) => getSubscription(ns(ctx, a), a.topic_name, a.subscription_name).rules.map((r) => ({ name: r.name, filterType: 'SqlFilter', sqlFilter: { sqlExpression: r.sql } })) });
register({
  path: 'servicebus topic subscription rule delete',
  summary: 'Elimina una regla. Una suscripción sin reglas no recibe ningún mensaje.',
  args: [A.rg(), nsArg, topicArg, subArg, A.name('Nombre de la regla.')],
  run(a, ctx) {
    setRule(ns(ctx, a), a.topic_name, a.subscription_name, a.name, null, ctx.principal);
    return undefined;
  },
});
