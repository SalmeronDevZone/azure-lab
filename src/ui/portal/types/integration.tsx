// Blades de Azure DNS (zonas y conjuntos de registros) y Service Bus (colas, temas y explorador de mensajes).
import { useEffect, useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, useRoute, resourceHref } from '../../hooks';
import { openPane, closePane, toast } from '../../uiStore';
import { CliBox, Callout, CommandBar, CopyButton, DataTable, Field, KeyValueEditor, Select, TextInput, Checkbox, confirmDialog, useAsync } from '../../components/common';
import { Icon } from '../../components/Icons';
import { portalAction, cliText, az, errorText } from '../../portalCli';
import { findResource } from '../../../engine/arm';
import { portalPrincipal } from '../../../engine/store';
import { ciEq } from '../../../engine/util';
import { recordSets, fqdnOf, type RecordSet } from '../../../engine/providers/dns';
import { resolveDns } from '../../../engine/services/net';
import { sbData, SB_SKUS } from '../../../engine/providers/servicebus';
import { sendMessage, peekMessages, receiveMessages, abandonFirst, type EntityRef } from '../../../engine/services/servicebus';
import type { SbMessage } from '../../../engine/providers/servicebus';
import type { TypeBlade } from './shared';
import { Props, gn } from './shared';

// ---------------------------------------------------------------- Azure DNS

const z = (r: Resource) => ['-g', r.resourceGroup, '-z', r.name];

function recordText(rs: RecordSet) {
  if (rs.type === 'MX') return rs.records.map((v) => `${v.split(' ')[0]} ${v.split(' ')[1]}`).join('\n');
  if (rs.type === 'TXT') return rs.records.map((v) => `"${v}"`).join('\n');
  return rs.records.join('\n');
}

function AddRecordSet({ zone }: { zone: Resource }) {
  const s = useCloud();
  const [name, setName] = useState('www');
  const [type, setType] = useState('A');
  const [ttl, setTtl] = useState('3600');
  const [value, setValue] = useState('');
  const [pref, setPref] = useState('10');
  const { busy, run } = useAsync();
  const ips = s.resources.filter((x) => ciEq(x.type, 'Microsoft.Network/publicIPAddresses') && x.properties.ipAddress);
  const sites = s.resources.filter((x) => ciEq(x.type, 'Microsoft.Web/sites'));
  const values = value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
  const rel = name.trim() || '@';
  const base = ['network', 'dns', 'record-set', type.toLowerCase()];
  const cmds: string[][] =
    type === 'CNAME'
      ? [[...base, 'set-record', ...z(zone), '-n', rel, '-c', values[0] ?? '', '--ttl', ttl]]
      : values.map((v) => {
          const opt = type === 'A' ? ['--ipv4-address', v] : type === 'AAAA' ? ['--ipv6-address', v] : type === 'TXT' ? ['--value', v] : ['--exchange', v, '--preference', pref];
          return [...base, 'add-record', ...z(zone), '-n', rel, ...opt, '--ttl', ttl];
        });
  const help: Record<string, string> = {
    A: 'Una o varias direcciones IPv4 separadas por comas. Ejemplo: la IP pública de una VM.',
    AAAA: 'Direcciones IPv6 separadas por comas.',
    CNAME: 'Nombre DNS de destino (alias). Ejemplo: miapp.azurewebsites.net. Un CNAME no puede convivir con otros registros del mismo nombre ni estar en el vértice (@).',
    TXT: 'Texto libre. Se usa para verificar la propiedad de un dominio (asuid.www) o para SPF.',
    MX: 'Servidor de correo que recibe los mensajes del dominio, p. ej. mail.contoso-lab.com.',
  };
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" help={`FQDN resultante: ${fqdnOf(zone, rel)} · Usa @ para el propio dominio.`}>
          <TextInput value={name} onChange={setName} autoFocus mono />
        </Field>
        <Field label="Tipo">
          <Select
            value={type}
            onChange={(v) => {
              setType(v);
              setValue('');
            }}
            options={[
              { value: 'A', label: 'A: dirección IPv4' },
              { value: 'AAAA', label: 'AAAA: dirección IPv6' },
              { value: 'CNAME', label: 'CNAME: alias a otro nombre' },
              { value: 'MX', label: 'MX: intercambiador de correo' },
              { value: 'TXT', label: 'TXT: texto' },
            ]}
          />
        </Field>
        <Field label="TTL (segundos)" help="Cuánto tiempo pueden guardar en caché la respuesta los resolutores DNS.">
          <TextInput value={ttl} onChange={setTtl} />
        </Field>
        {type === 'MX' ? (
          <Field label="Preferencia" help="Menor número = mayor prioridad.">
            <TextInput value={pref} onChange={setPref} />
          </Field>
        ) : null}
        <Field label={type === 'CNAME' ? 'Alias' : type === 'TXT' ? 'Valor' : type === 'MX' ? 'Intercambiador de correo' : 'Direcciones IP'} required help={help[type]}>
          <TextInput value={value} onChange={setValue} mono />
        </Field>
        {type === 'A' && ips.length ? (
          <Field label="Usar la IP de">
            <Select value="" onChange={(v) => v && setValue(values.includes(v) ? value : [...values, v].join(', '))} options={[{ value: '', label: 'Elegir una IP pública...' }, ...ips.map((x) => ({ value: x.properties.ipAddress, label: `${x.name} (${x.properties.ipAddress})` }))]} />
          </Field>
        ) : null}
        {type === 'CNAME' && sites.length ? (
          <Field label="Apuntar a una aplicación web">
            <Select value="" onChange={(v) => v && setValue(v)} options={[{ value: '', label: 'Elegir una web app...' }, ...sites.map((x) => ({ value: x.properties.defaultHostName, label: x.properties.defaultHostName }))]} />
          </Field>
        ) : null}
        {cmds.length && values.length ? cmds.map((c, i) => <CliBox key={i} cmd={cliText(c)} />) : null}
      </div>
      <div className="pane-foot">
        <button
          className="btn primary"
          disabled={busy || !values.length || !/^\d+$/.test(ttl)}
          onClick={() =>
            run(async () => {
              for (const c of cmds) if (!(await portalAction('Agregar conjunto de registros', c, { subscription: zone.subscriptionId, quiet: true }))) return;
              toast(`Registro ${type} ${fqdnOf(zone, rel)} guardado`, 'success');
              closePane();
            })
          }
        >
          Aceptar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function ResolveTester({ zone }: { zone: Resource }) {
  useCloud();
  const [host, setHost] = useState(`www.${zone.name}`);
  const res = host.trim() ? resolveDns(host.trim()) : null;
  return (
    <div className="card" style={{ maxWidth: 820, marginTop: 16 }}>
      <h3>Probar la resolución</h3>
      <div className="row" style={{ gap: 8 }}>
        <div style={{ flex: 1 }}>
          <TextInput value={host} onChange={setHost} mono />
        </div>
      </div>
      <div className="small" style={{ marginTop: 8 }}>
        {res ? (
          <>
            <Icon name="success" size={14} style={{ color: 'var(--success)' }} /> <span className="mono">{host}</span> → {res.cname ? <span className="mono">{res.cname} → </span> : null}
            <b className="mono">{res.ip}</b>
          </>
        ) : (
          <>
            <Icon name="error" size={14} style={{ color: 'var(--danger-icon)' }} /> NXDOMAIN: el nombre no existe.
          </>
        )}
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        Es lo mismo que obtendrías con <span className="mono">nslookup {host || 'www.' + zone.name}</span> desde Cloud Shell o una VM.
      </div>
    </div>
  );
}

function RecordSetsSection({ r }: { r: Resource }) {
  useCloud();
  const sets = Object.values(recordSets(r)).sort((a, b) => (a.name === '@' ? -1 : b.name === '@' ? 1 : a.name.localeCompare(b.name)) || a.type.localeCompare(b.type));
  const del = async (rs: RecordSet) => {
    if (!(await confirmDialog({ title: 'Eliminar conjunto de registros', message: `¿Eliminar el conjunto de registros ${rs.type} "${rs.name}"? Los clientes dejarán de resolver ${fqdnOf(r, rs.name)} cuando caduque el TTL.`, confirmText: 'Eliminar', danger: true }))) return;
    await portalAction('Eliminar conjunto de registros', ['network', 'dns', 'record-set', rs.type.toLowerCase(), 'delete', ...z(r), '-n', rs.name, '--yes'], { subscription: r.subscriptionId, success: `Conjunto ${rs.type} ${rs.name} eliminado` });
  };
  return (
    <>
      <CommandBar items={[{ label: 'Conjunto de registros', icon: 'add', onClick: () => openPane({ title: 'Agregar un conjunto de registros', subtitle: r.name, render: () => <AddRecordSet zone={r} /> }) }]} />
      <DataTable
        rows={sets}
        rowKey={(x) => `${x.type}/${x.name}`}
        columns={[
          { key: 'n', title: 'Nombre', render: (x) => <b className="mono">{x.name}</b> },
          { key: 't', title: 'Tipo', render: (x) => x.type },
          { key: 'ttl', title: 'TTL', render: (x) => x.ttl },
          { key: 'v', title: 'Valor', render: (x) => <span className="mono small" style={{ whiteSpace: 'pre-line' }}>{recordText(x)}</span> },
          {
            key: 'x',
            title: '',
            render: (x) =>
              x.type === 'SOA' || (x.type === 'NS' && x.name === '@') ? null : (
                <button className="btn small" onClick={() => del(x)}>
                  Eliminar
                </button>
              ),
          },
        ]}
      />
      <ResolveTester zone={r} />
    </>
  );
}

function DnsOverview({ r }: { r: Resource }) {
  useCloud();
  const ns: string[] = r.properties.nameServers ?? [];
  return (
    <>
      <Callout title="Delegación del dominio">
        Para que Internet use esta zona, en tu registrador de dominios (donde compraste <b>{r.name}</b>) cambia los servidores de nombres por estos cuatro. En el simulador la delegación es automática: los nombres ya se resuelven desde Cloud Shell y las VM.
      </Callout>
      <Props
        rows={ns.map((n, i) => [
          `Servidor de nombres ${i + 1}`,
          <span className="row" style={{ gap: 6 }}>
            <span className="mono">{n}</span>
            <CopyButton text={n} />
          </span>,
        ])}
      />
      <h3 className="section-title">Conjuntos de registros</h3>
      <RecordSetsSection r={r} />
    </>
  );
}

// ---------------------------------------------------------------- Service Bus: entidades

function fresh(r: Resource) {
  return findResource(r.id) ?? r;
}

function AddQueue({ ns }: { ns: Resource }) {
  const [name, setName] = useState('pedidos');
  const [mdc, setMdc] = useState('10');
  const [lock, setLock] = useState('PT1M');
  const { busy, run } = useAsync();
  const args = ['servicebus', 'queue', 'create', '-g', ns.resourceGroup, '--namespace-name', ns.name, '-n', name, '--max-delivery-count', mdc, '--lock-duration', lock];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Número máximo de entregas" help="Si un consumidor falla (abandona) el mensaje tantas veces, pasa a la cola de mensajes fallidos (dead-letter).">
          <TextInput value={mdc} onChange={setMdc} />
        </Field>
        <Field label="Duración del bloqueo" help="Tiempo que un consumidor tiene para completar el mensaje antes de que vuelva a estar disponible (ISO 8601).">
          <Select value={lock} onChange={setLock} options={['PT30S', 'PT1M', 'PT5M']} />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name} onClick={() => run(async () => (await portalAction('Crear cola', args, { subscription: ns.subscriptionId, success: `Cola ${name} creada` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function QueuesSection({ r }: { r: Resource }) {
  useCloud();
  const d = sbData(r);
  const del = async (name: string) => {
    if (!(await confirmDialog({ title: 'Eliminar cola', message: `¿Eliminar la cola ${name} y todos sus mensajes?`, confirmText: 'Eliminar', danger: true }))) return;
    await portalAction('Eliminar cola', ['servicebus', 'queue', 'delete', '-g', r.resourceGroup, '--namespace-name', r.name, '-n', name], { subscription: r.subscriptionId, success: `Cola ${name} eliminada` });
  };
  return (
    <>
      <CommandBar items={[{ label: 'Cola', icon: 'add', onClick: () => openPane({ title: 'Crear una cola', subtitle: r.name, render: () => <AddQueue ns={r} /> }) }]} />
      <Callout>Una cola entrega cada mensaje a <b>un único</b> consumidor (punto a punto). Es ideal para repartir trabajo entre varias instancias de un servicio y desacoplar productor y consumidor.</Callout>
      <DataTable
        rows={Object.values(d.queues)}
        rowKey={(q) => q.name}
        columns={[
          { key: 'n', title: 'Nombre', render: (q) => <b>{q.name}</b> },
          { key: 'a', title: 'Mensajes activos', render: (q) => q.messages.length },
          { key: 'dl', title: 'Mensajes fallidos', render: (q) => (q.deadLetter.length ? <span className="pill bad">{q.deadLetter.length}</span> : 0) },
          { key: 'm', title: 'Entregas máx.', render: (q) => q.maxDeliveryCount },
          { key: 'l', title: 'Bloqueo', render: (q) => q.lockDuration },
          {
            key: 'x',
            title: '',
            render: (q) => (
              <span className="row" style={{ gap: 4 }}>
                <a className="btn small" href={resourceHref(r.id, 'explorer') + `?entity=q:${q.name}`}>
                  Explorar
                </a>
                <button className="btn small" onClick={() => del(q.name)}>
                  Eliminar
                </button>
              </span>
            ),
          },
        ]}
        empty="Todavía no hay colas. Crea una para empezar a enviar mensajes."
      />
    </>
  );
}

function AddTopic({ ns }: { ns: Resource }) {
  const [name, setName] = useState('eventos');
  const { busy, run } = useAsync();
  const args = ['servicebus', 'topic', 'create', '-g', ns.resourceGroup, '--namespace-name', ns.name, '-n', name];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name} onClick={() => run(async () => (await portalAction('Crear tema', args, { subscription: ns.subscriptionId, success: `Tema ${name} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function AddSubscription({ ns, topic }: { ns: Resource; topic: string }) {
  const [name, setName] = useState('');
  const [mdc, setMdc] = useState('10');
  const [filter, setFilter] = useState('');
  const { busy, run } = useAsync();
  const base = ['-g', ns.resourceGroup, '--namespace-name', ns.name, '--topic-name', topic];
  const cmds = [
    ['servicebus', 'topic', 'subscription', 'create', ...base, '-n', name, '--max-delivery-count', mdc],
    ...(filter.trim()
      ? [
          ['servicebus', 'topic', 'subscription', 'rule', 'create', ...base, '--subscription-name', name, '-n', 'filtro', '--filter-sql-expression', filter.trim()],
          ['servicebus', 'topic', 'subscription', 'rule', 'delete', ...base, '--subscription-name', name, '-n', '$Default'],
        ]
      : []),
  ];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required help="Cada suscripción recibe su propia copia de los mensajes del tema (por ejemplo, una por cada servicio interesado).">
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Número máximo de entregas">
          <TextInput value={mdc} onChange={setMdc} />
        </Field>
        <Field label="Filtro SQL (opcional)" help="Sin filtro, la suscripción recibe todos los mensajes (regla $Default: 1=1). Ejemplos: prioridad = 'alta' · region IN ('es','pt') · sys.Label = 'pedido'">
          <TextInput value={filter} onChange={setFilter} mono placeholder="prioridad = 'alta'" />
        </Field>
        {cmds.map((c, i) => (
          <CliBox key={i} cmd={cliText(c)} />
        ))}
      </div>
      <div className="pane-foot">
        <button
          className="btn primary"
          disabled={busy || !name}
          onClick={() =>
            run(async () => {
              for (const c of cmds) if (!(await portalAction('Crear suscripción', c, { subscription: ns.subscriptionId, quiet: true }))) return;
              toast(`Suscripción ${topic}/${name} creada`, 'success');
              closePane();
            })
          }
        >
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function AddRule({ ns, topic, sub }: { ns: Resource; topic: string; sub: string }) {
  const [name, setName] = useState('filtro2');
  const [sql, setSql] = useState("region = 'es'");
  const { busy, run } = useAsync();
  const args = ['servicebus', 'topic', 'subscription', 'rule', 'create', '-g', ns.resourceGroup, '--namespace-name', ns.name, '--topic-name', topic, '--subscription-name', sub, '-n', name, '--filter-sql-expression', sql];
  return (
    <>
      <div className="pane-body">
        <Callout>Un mensaje llega a la suscripción si cumple <b>cualquiera</b> de sus reglas (OR entre reglas). Para filtrar de verdad, elimina la regla $Default (1=1).</Callout>
        <Field label="Nombre de la regla" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Filtro SQL" required help="Propiedades personalizadas del mensaje y sys.Label. Operadores: =, <>, IN, NOT IN, LIKE, AND, OR.">
          <TextInput value={sql} onChange={setSql} mono />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name || !sql} onClick={() => run(async () => (await portalAction('Crear regla', args, { subscription: ns.subscriptionId, success: `Regla ${name} creada` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function TopicsSection({ r }: { r: Resource }) {
  useCloud();
  const d = sbData(r);
  const topics = Object.values(d.topics);
  const [sel, setSel] = useState(topics[0]?.name ?? '');
  const topic = d.topics[sel] ?? topics[0];
  const base = ['-g', r.resourceGroup, '--namespace-name', r.name];
  if (!SB_SKUS[r.sku?.name ?? 'Standard']?.topics) {
    return (
      <Callout kind="warn" title="Los temas no están disponibles en el nivel Básico">
        El nivel Básico sólo admite colas. Cambia a Estándar en <a href={resourceHref(r.id, 'config')}>Configuración</a> para usar publicación/suscripción.
      </Callout>
    );
  }
  const delTopic = async (name: string) => {
    if (!(await confirmDialog({ title: 'Eliminar tema', message: `¿Eliminar el tema ${name} con todas sus suscripciones?`, confirmText: 'Eliminar', danger: true }))) return;
    await portalAction('Eliminar tema', ['servicebus', 'topic', 'delete', ...base, '-n', name], { subscription: r.subscriptionId, success: `Tema ${name} eliminado` });
  };
  const delSub = async (name: string) => {
    if (!(await confirmDialog({ title: 'Eliminar suscripción', message: `¿Eliminar la suscripción ${name}?`, confirmText: 'Eliminar', danger: true }))) return;
    await portalAction('Eliminar suscripción', ['servicebus', 'topic', 'subscription', 'delete', ...base, '--topic-name', topic.name, '-n', name], { subscription: r.subscriptionId, success: `Suscripción ${name} eliminada` });
  };
  const delRule = (sub: string, rule: string) => portalAction('Eliminar regla', ['servicebus', 'topic', 'subscription', 'rule', 'delete', ...base, '--topic-name', topic.name, '--subscription-name', sub, '-n', rule], { subscription: r.subscriptionId, success: `Regla ${rule} eliminada` });
  return (
    <>
      <CommandBar items={[{ label: 'Tema', icon: 'add', onClick: () => openPane({ title: 'Crear un tema', subtitle: r.name, render: () => <AddTopic ns={r} /> }) }]} />
      <Callout>Un tema entrega una <b>copia</b> de cada mensaje a cada suscripción cuyas reglas coinciden (publicación/suscripción). Así, varios servicios reaccionan al mismo evento sin conocerse entre sí.</Callout>
      <DataTable
        rows={topics}
        rowKey={(t) => t.name}
        onRowClick={(t) => setSel(t.name)}
        columns={[
          { key: 'n', title: 'Nombre', render: (t) => (t.name === topic?.name ? <b>▸ {t.name}</b> : t.name) },
          { key: 's', title: 'Suscripciones', render: (t) => Object.keys(t.subscriptions).length },
          { key: 'm', title: 'Mensajes pendientes', render: (t) => Object.values(t.subscriptions).reduce((a, x) => a + x.messages.length, 0) },
          {
            key: 'x',
            title: '',
            render: (t) => (
              <button
                className="btn small"
                onClick={(e) => {
                  e.stopPropagation();
                  delTopic(t.name);
                }}
              >
                Eliminar
              </button>
            ),
          },
        ]}
        empty="Todavía no hay temas."
      />
      {topic ? (
        <>
          <h3 className="section-title">Suscripciones de {topic.name}</h3>
          <CommandBar items={[{ label: 'Suscripción', icon: 'add', onClick: () => openPane({ title: 'Crear una suscripción', subtitle: `${r.name}/${topic.name}`, render: () => <AddSubscription ns={r} topic={topic.name} /> }) }]} />
          <DataTable
            rows={Object.values(topic.subscriptions)}
            rowKey={(x) => x.name}
            columns={[
              { key: 'n', title: 'Nombre', render: (x) => <b>{x.name}</b> },
              {
                key: 'r',
                title: 'Reglas (filtros)',
                render: (x) => (
                  <div>
                    {x.rules.map((ru) => (
                      <div key={ru.name} className="row small" style={{ gap: 6 }}>
                        <span className="mono">
                          {ru.name}: {ru.sql}
                        </span>
                        <button title="Eliminar regla" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger-icon)', padding: 0 }} onClick={() => delRule(x.name, ru.name)}>
                          ✕
                        </button>
                      </div>
                    ))}
                    {!x.rules.length ? <span className="small" style={{ color: 'var(--danger-icon)' }}>Sin reglas: no recibirá ningún mensaje</span> : null}
                  </div>
                ),
              },
              { key: 'a', title: 'Activos', render: (x) => x.messages.length },
              { key: 'dl', title: 'Fallidos', render: (x) => (x.deadLetter.length ? <span className="pill bad">{x.deadLetter.length}</span> : 0) },
              {
                key: 'x',
                title: '',
                render: (x) => (
                  <span className="row" style={{ gap: 4 }}>
                    <button className="btn small" onClick={() => openPane({ title: 'Agregar regla de filtro', subtitle: `${topic.name}/${x.name}`, render: () => <AddRule ns={r} topic={topic.name} sub={x.name} /> })}>
                      + Regla
                    </button>
                    <a className="btn small" href={resourceHref(r.id, 'explorer') + `?entity=s:${topic.name}/${x.name}`}>
                      Explorar
                    </a>
                    <button className="btn small" onClick={() => delSub(x.name)}>
                      Eliminar
                    </button>
                  </span>
                ),
              },
            ]}
            empty="Este tema no tiene suscripciones: los mensajes que se publiquen se descartarán."
          />
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Service Bus: explorador

function entityOptions(r: Resource) {
  const d = sbData(r);
  return [
    ...Object.values(d.queues).map((q) => ({ value: `q:${q.name}`, label: `Cola · ${q.name}` })),
    ...Object.values(d.topics).flatMap((t) => Object.values(t.subscriptions).map((x) => ({ value: `s:${t.name}/${x.name}`, label: `Suscripción · ${t.name}/${x.name}` }))),
  ];
}

const toRef = (v: string): EntityRef | null => (v.startsWith('q:') ? { kind: 'queue', queue: v.slice(2) } : v.startsWith('s:') ? { kind: 'subscription', topic: v.slice(2).split('/')[0], subscription: v.slice(2).split('/')[1] } : null);

function MessagesTable({ rows, deadLetter }: { rows: SbMessage[]; deadLetter?: boolean }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(m) => m.messageId + m.sequenceNumber}
      columns={[
        { key: 's', title: 'Nº sec.', render: (m) => m.sequenceNumber },
        { key: 'l', title: 'Asunto (label)', render: (m) => m.label ?? '—' },
        { key: 'b', title: 'Cuerpo', render: (m) => <span className="mono small">{m.body.length > 80 ? m.body.slice(0, 80) + '…' : m.body}</span> },
        { key: 'p', title: 'Propiedades', render: (m) => <span className="mono small">{Object.entries(m.properties).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</span> },
        { key: 'd', title: 'Entregas', render: (m) => m.deliveryCount },
        ...(deadLetter ? [{ key: 'r', title: 'Motivo', render: (m: SbMessage) => m.deadLetterReason ?? '—' }] : []),
      ]}
      empty={deadLetter ? 'La cola de mensajes fallidos está vacía.' : 'No hay mensajes activos.'}
    />
  );
}

/** Al llegar desde "Explorar" de una cola o suscripción, la entidad viene en ?entity= y el explorador se reinicia. */
function Explorer({ r }: { r: Resource }) {
  const initial = useRoute().query.get('entity') ?? '';
  return <ExplorerView key={initial} r={r} initial={initial} />;
}

function ExplorerView({ r, initial }: { r: Resource; initial: string }) {
  useCloud();
  const d = sbData(r);
  const targets = [...Object.values(d.queues).map((q) => ({ value: `q:${q.name}`, label: `Cola · ${q.name}` })), ...Object.values(d.topics).map((t) => ({ value: `t:${t.name}`, label: `Tema · ${t.name}` }))];
  const sources = entityOptions(r);
  const [target, setTarget] = useState(initial.startsWith('q:') ? initial : initial.startsWith('s:') ? `t:${initial.slice(2).split('/')[0]}` : targets[0]?.value ?? '');
  const [source, setSource] = useState(initial || sources[0]?.value || '');
  const [body, setBody] = useState('{\n  "pedidoId": 1001,\n  "importe": 59.9\n}');
  const [label, setLabel] = useState('pedido-creado');
  const [props, setProps] = useState<[string, string][]>([['prioridad', 'alta']]);
  const [dlq, setDlq] = useState(false);
  const [received, setReceived] = useState<SbMessage[] | null>(null);
  useEffect(() => setReceived(null), [source, dlq]);
  if (!targets.length) return <Callout title="Aún no hay entidades">Crea una <a href={resourceHref(r.id, 'queues')}>cola</a> o un <a href={resourceHref(r.id, 'topics')}>tema</a> para enviar y recibir mensajes.</Callout>;
  const ref = toRef(source);
  const ns = fresh(r);
  const act = (fn: () => void) => {
    try {
      fn();
    } catch (e: any) {
      toast('Error del Explorador de Service Bus', 'error', String(e?.message ?? e));
    }
  };
  const send = () =>
    act(() => {
      const to = target.startsWith('q:') ? { queue: target.slice(2) } : { topic: target.slice(2) };
      const n = sendMessage(ns, to, body, Object.fromEntries(props.filter(([k]) => k.trim())), label || undefined, portalPrincipal());
      toast(to.queue ? `Mensaje enviado a la cola ${to.queue}` : n ? `Mensaje publicado en ${to.topic}: llegó a ${n} suscripción(es)` : `Mensaje publicado en ${to.topic}, pero ninguna suscripción coincide`, n ? 'success' : 'warning');
    });
  const list = ref ? (() => { try { return peekMessages(ns, ref, dlq); } catch { return []; } })() : [];
  return (
    <>
      {r.properties.disableLocalAuth ? (
        <Callout kind="warn">
          La autenticación local (SAS) está deshabilitada: para usar el explorador necesitas un rol de datos como <b>Azure Service Bus Data Owner</b> en <a href={resourceHref(r.id, 'iam')}>Control de acceso (IAM)</a>.
        </Callout>
      ) : null}
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3>Enviar un mensaje</h3>
          <Field stack label="Destino">
            <Select value={target} onChange={setTarget} options={targets} />
          </Field>
          <Field stack label="Asunto (label)" help="Se puede filtrar con sys.Label en las reglas de las suscripciones.">
            <TextInput value={label} onChange={setLabel} />
          </Field>
          <Field stack label="Cuerpo">
            <textarea className="textarea mono" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <Field stack label="Propiedades personalizadas" help="Las reglas SQL de las suscripciones filtran por estas propiedades.">
            <KeyValueEditor value={props} onChange={setProps} />
          </Field>
          <button className="btn primary" onClick={send}>
            Enviar
          </button>
        </div>
        <div className="card">
          <h3>Recibir mensajes</h3>
          <Field stack label="Origen">
            <Select value={source} onChange={setSource} options={sources.length ? sources : [{ value: '', label: 'No hay colas ni suscripciones' }]} />
          </Field>
          <Checkbox checked={dlq} onChange={setDlq} label="Cola de mensajes fallidos (dead-letter)" />
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn" disabled={!ref} onClick={() => act(() => setReceived(receiveMessages(ns, ref!, 1, portalPrincipal(), dlq)))}>
              Recibir y eliminar
            </button>
            <button
              className="btn"
              disabled={!ref || dlq}
              title="Simula un consumidor que falla al procesar el primer mensaje"
              onClick={() =>
                act(() => {
                  const before = peekMessages(ns, ref!, true, Infinity).length;
                  const m = abandonFirst(ns, ref!, portalPrincipal());
                  if (!m) toast('No hay mensajes que abandonar', 'warning');
                  else if (peekMessages(ns, ref!, true, Infinity).length > before) toast('Mensaje movido a la cola de mensajes fallidos', 'warning', 'Superó el número máximo de entregas (MaxDeliveryCountExceeded).');
                  else toast(`Mensaje abandonado (entrega ${m.deliveryCount})`, 'info', 'Vuelve a la cola para otro intento.');
                })
              }
            >
              Simular fallo del consumidor
            </button>
          </div>
          {received ? (
            <div style={{ marginTop: 12 }}>
              <div className="small muted">Recibido{received.length ? '' : ': la entidad estaba vacía'}</div>
              {received.map((m) => (
                <div key={m.messageId} className="code" style={{ marginTop: 4 }}>
                  {JSON.stringify({ messageId: m.messageId, sequenceNumber: m.sequenceNumber, label: m.label, applicationProperties: m.properties, deliveryCount: m.deliveryCount, body: m.body }, null, 2)}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <h3 className="section-title">
        {dlq ? 'Mensajes fallidos' : 'Mensajes activos'} en {source.slice(2) || '—'} (inspección sin consumirlos)
      </h3>
      <MessagesTable rows={list} deadLetter={dlq} />
    </>
  );
}

// ---------------------------------------------------------------- Service Bus: acceso y configuración

function SasSection({ r }: { r: Resource }) {
  useCloud();
  const [keys, setKeys] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const base = ['servicebus', 'namespace', 'authorization-rule', 'keys'];
  const load = async () => {
    const res = await az([...base, 'list', '-g', r.resourceGroup, '--namespace-name', r.name, '-n', 'RootManageSharedAccessKey'], { subscription: r.subscriptionId });
    if (res.code) {
      setErr(errorText(res));
      setKeys(null);
    } else {
      setErr(null);
      setKeys(res.json);
    }
  };
  useEffect(() => {
    load();
  }, [r.id, r.properties.disableLocalAuth]);
  const renew = async (key: 'PrimaryKey' | 'SecondaryKey') => {
    if (!(await confirmDialog({ title: 'Regenerar clave', message: `Las aplicaciones que usen la clave ${key === 'PrimaryKey' ? 'principal' : 'secundaria'} dejarán de conectarse. ¿Continuar?`, confirmText: 'Regenerar', danger: true }))) return;
    if (await portalAction('Regenerar clave', [...base, 'renew', '-g', r.resourceGroup, '--namespace-name', r.name, '-n', 'RootManageSharedAccessKey', '--key', key], { subscription: r.subscriptionId, success: 'Clave regenerada' })) load();
  };
  const mask = (v: string) => (show ? v : '•'.repeat(24));
  return (
    <>
      <Callout>
        Las directivas SAS dan acceso con una clave compartida. Es cómodo para empezar, pero en producción es mejor usar <b>identidades administradas</b> con los roles <i>Azure Service Bus Data Sender/Receiver</i> y deshabilitar la autenticación local.
      </Callout>
      {r.properties.disableLocalAuth ? <Callout kind="warn">La autenticación local está deshabilitada: las claves existen pero el servicio las rechaza.</Callout> : null}
      {err ? <Callout kind="bad" title="No puedes leer las claves">{err}</Callout> : null}
      {keys ? (
        <>
          <Props
            rows={[
              ['Directiva', 'RootManageSharedAccessKey'],
              ['Notificaciones', 'Administrar, Enviar, Escuchar'],
              ...(
                [
                  ['Clave principal', keys.primaryKey],
                  ['Clave secundaria', keys.secondaryKey],
                  ['Cadena de conexión principal', keys.primaryConnectionString],
                  ['Cadena de conexión secundaria', keys.secondaryConnectionString],
                ] as [string, string][]
              ).map(([k, v]): [string, any] => [
                k,
                <span className="row" style={{ gap: 6 }}>
                  <span className="mono small" style={{ wordBreak: 'break-all' }}>
                    {mask(v)}
                  </span>
                  <CopyButton text={v} />
                </span>,
              ]),
            ]}
          />
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn" onClick={() => setShow(!show)}>
              {show ? 'Ocultar valores' : 'Mostrar valores'}
            </button>
            <button className="btn" onClick={() => renew('PrimaryKey')}>
              Regenerar clave principal
            </button>
            <button className="btn" onClick={() => renew('SecondaryKey')}>
              Regenerar clave secundaria
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

function SbConfig({ r }: { r: Resource }) {
  useCloud();
  const [sku, setSku] = useState(r.sku?.name ?? 'Standard');
  const [local, setLocal] = useState(!r.properties.disableLocalAuth);
  const { busy, run } = useAsync();
  const args = ['servicebus', 'namespace', 'update', ...gn(r), ...(sku !== r.sku?.name ? ['--sku', sku] : []), ...(local === !!r.properties.disableLocalAuth ? ['--disable-local-auth', String(!local)] : [])];
  const dirty = args.length > 7;
  return (
    <div style={{ maxWidth: 640 }}>
      <Field label="Plan de tarifa">
        <Select value={sku} onChange={setSku} options={Object.entries(SB_SKUS).map(([k, v]) => ({ value: k, label: `${k}: ${v.label}` }))} />
      </Field>
      <Checkbox checked={local} onChange={setLocal} label="Autenticación local (claves SAS)" />
      <div className="muted small" style={{ margin: '4px 0 12px 24px' }}>
        Si la deshabilitas, sólo se aceptan identidades de Microsoft Entra ID con roles de datos de Service Bus.
      </div>
      {dirty ? <CliBox cmd={cliText(args)} /> : null}
      <button className="btn primary" style={{ marginTop: 10 }} disabled={busy || !dirty} onClick={() => run(() => portalAction('Actualizar espacio de nombres', args, { subscription: r.subscriptionId, success: 'Configuración guardada' }))}>
        Guardar
      </button>
    </div>
  );
}

function SbOverview({ r }: { r: Resource }) {
  useCloud();
  const d = sbData(r);
  const all = [...Object.values(d.queues), ...Object.values(d.topics).flatMap((t) => Object.values(t.subscriptions))];
  return (
    <>
      <Props
        rows={[
          ['Nombre de host', <span className="row" style={{ gap: 6 }}><span className="mono">{r.name}.servicebus.windows.net</span><CopyButton text={`${r.name}.servicebus.windows.net`} /></span>],
          ['Mensajes activos', String(all.reduce((a, x) => a + x.messages.length, 0))],
          ['Mensajes fallidos', String(all.reduce((a, x) => a + x.deadLetter.length, 0))],
          ['Autenticación local', r.properties.disableLocalAuth ? 'Deshabilitada (sólo Entra ID)' : 'Habilitada'],
        ]}
      />
      <div className="grid3" style={{ marginTop: 16 }}>
        {[
          ['queues', 'file', 'Colas', 'Mensajería punto a punto: cada mensaje lo procesa un solo consumidor.'],
          ['topics', 'link', 'Temas', 'Publicación/suscripción con filtros por suscripción.'],
          ['explorer', 'search', 'Explorador de Service Bus', 'Envía, inspecciona y recibe mensajes desde el portal.'],
        ].map(([id, icon, title, desc]) => (
          <a key={id} className="card" href={resourceHref(r.id, id)} style={{ color: 'var(--text)', textDecoration: 'none' }}>
            <div className="row" style={{ gap: 8 }}>
              <Icon name={icon} style={{ color: 'var(--accent)' }} />
              <b>{title}</b>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {desc}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- registro

export const INTEGRATION_BLADES: Record<string, TypeBlade> = {
  'microsoft.network/dnszones': {
    Overview: DnsOverview,
    sections: [{ id: 'recordsets', label: 'Conjuntos de registros', icon: 'network', group: 'Administración de DNS', Comp: RecordSetsSection }],
    cli: (r) => [
      { label: 'Listar los registros', cmd: `az network dns record-set list -g ${r.resourceGroup} -z ${r.name} -o table` },
      { label: 'Apuntar www a una IP', cmd: `az network dns record-set a add-record -g ${r.resourceGroup} -z ${r.name} -n www --ipv4-address 20.1.2.3` },
      { label: 'Alias hacia una web app', cmd: `az network dns record-set cname set-record -g ${r.resourceGroup} -z ${r.name} -n app -c miapp.azurewebsites.net` },
      { label: 'Comprobar la resolución', cmd: `nslookup www.${r.name}` },
    ],
  },
  'microsoft.servicebus/namespaces': {
    Overview: SbOverview,
    sections: [
      { id: 'queues', label: 'Colas', icon: 'file', group: 'Entidades', Comp: QueuesSection },
      { id: 'topics', label: 'Temas', icon: 'link', group: 'Entidades', Comp: TopicsSection },
      { id: 'explorer', label: 'Explorador de Service Bus', icon: 'search', group: 'Entidades', Comp: Explorer },
      { id: 'sas', label: 'Directivas de acceso compartido', icon: 'key', group: 'Configuración', Comp: SasSection },
      { id: 'config', label: 'Configuración', icon: 'settings2', group: 'Configuración', Comp: SbConfig },
    ],
    cli: (r) => [
      { label: 'Crear una cola', cmd: `az servicebus queue create -g ${r.resourceGroup} --namespace-name ${r.name} -n pedidos` },
      { label: 'Ver el recuento de mensajes', cmd: `az servicebus queue show -g ${r.resourceGroup} --namespace-name ${r.name} -n pedidos --query countDetails` },
      { label: 'Cadena de conexión', cmd: `az servicebus namespace authorization-rule keys list -g ${r.resourceGroup} --namespace-name ${r.name} -n RootManageSharedAccessKey --query primaryConnectionString -o tsv` },
    ],
  },
};
