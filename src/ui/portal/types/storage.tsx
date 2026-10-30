// Blade de cuentas de almacenamiento: contenedores y blobs, claves, SAS, sitio web estático y redes.
import { useRef, useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud } from '../../hooks';
import { openPane, closePane } from '../../uiStore';
import { Callout, CliBox, CodeBlock, CommandBar, CopyButton, DataTable, Field, Select, TextInput, Checkbox, confirmDialog, useAsync } from '../../components/common';
import { portalAction, cliText, az } from '../../portalCli';
import { containersOf, type ContainerItem } from '../../../engine/services/storage';
import { formatBytes, relTime } from '../../../engine/util';
import { openUrl } from '../../terminal/controller';
import type { TypeBlade } from './shared';
import { MetricsSection, Props, gn } from './shared';

const keyAuth = (r: Resource) => ['--account-name', r.name, '--auth-mode', 'key'];

function NewContainer({ r }: { r: Resource }) {
  const [name, setName] = useState('');
  const [access, setAccess] = useState('off');
  const { busy, run } = useAsync();
  const args = ['storage', 'container', 'create', '-n', name, '--public-access', access, ...keyAuth(r)];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required help="3-63 caracteres: minúsculas, números y guiones.">
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Nivel de acceso anónimo">
          <Select
            value={access}
            onChange={setAccess}
            options={[
              { value: 'off', label: 'Privado (sin acceso anónimo)' },
              { value: 'blob', label: 'Blob (acceso de lectura anónimo sólo para blobs)' },
              { value: 'container', label: 'Contenedor (lectura anónima de contenedores y blobs)' },
            ]}
          />
        </Field>
        {access !== 'off' && !r.properties.allowBlobPublicAccess ? <Callout kind="warn">La cuenta tiene deshabilitado el acceso anónimo a blobs ("Permitir el acceso anónimo a blobs" en Configuración). La creación fallará hasta que lo habilites.</Callout> : null}
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name} onClick={() => run(async () => (await portalAction('Crear contenedor', args, { subscription: r.subscriptionId, success: `Contenedor ${name} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function ContainerView({ r, c, onBack }: { r: Resource; c: ContainerItem; onBack: () => void }) {
  useCloud();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [view, setView] = useState<string | null>(null);
  const blobs = Object.entries(c.blobs).map(([name, b]) => ({ name, ...b }));
  const blobUrl = (n: string) => `https://${r.name}.blob.core.windows.net/${c.name}/${n}`;
  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      const text = await f.text();
      await portalAction('Cargar blob', ['storage', 'blob', 'upload', '-c', c.name, '-n', f.name, '-f', `/home/portal/upload/${f.name}`, '--overwrite', ...keyAuth(r)], { files: { [`upload/${f.name}`]: text }, subscription: r.subscriptionId, success: `Blob ${f.name} cargado` });
    }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: 'Eliminar blobs', message: `¿Eliminar ${sel.length} blob(s)?`, confirmText: 'Eliminar', danger: true }))) return;
    for (const n of sel) await portalAction('Eliminar blob', ['storage', 'blob', 'delete', '-c', c.name, '-n', n, ...keyAuth(r)], { subscription: r.subscriptionId, quiet: true });
    setSel([]);
  };
  const viewed = view ? c.blobs[view] : null;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <a onClick={onBack}>← Contenedores</a>
        <span className="muted">/ {c.name}</span>
        <span className="pill">{c.publicAccess === 'off' ? 'Privado' : c.publicAccess === 'blob' ? 'Blob (anónimo)' : 'Contenedor (anónimo)'}</span>
      </div>
      <CommandBar
        items={[
          { label: 'Cargar', icon: 'upload', onClick: () => fileRef.current?.click() },
          { label: 'Eliminar', icon: 'delete', disabled: !sel.length, onClick: del },
        ]}
      />
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => e.target.files && upload(e.target.files).then(() => (e.target.value = ''))} />
      <p className="muted small">Método de autenticación: clave de acceso (como el portal cuando tienes permiso para listar las claves).</p>
      <DataTable
        rows={blobs}
        rowKey={(b) => b.name}
        selectable
        selected={sel}
        onSelect={setSel}
        columns={[
          { key: 'n', title: 'Nombre', render: (b) => <a onClick={() => setView(b.name)}>{b.name}</a>, sort: (b) => b.name },
          { key: 'm', title: 'Modificado', render: (b) => relTime(b.lastModified) },
          { key: 't', title: 'Nivel de acceso', render: (b) => b.tier },
          { key: 'ty', title: 'Tipo de contenido', render: (b) => b.contentType },
          { key: 's', title: 'Tamaño', render: (b) => formatBytes(b.size), sort: (b) => b.size },
        ]}
        empty="No hay blobs en este contenedor. Usa Cargar o az storage blob upload."
      />
      {view && viewed ? (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>{view}</h3>
            <span className="spacer" />
            <button className="btn small" onClick={() => openUrl(blobUrl(view))}>
              Abrir URL en el navegador
            </button>
            <button className="btn small" onClick={() => setView(null)}>
              Cerrar
            </button>
          </div>
          <div className="row small muted" style={{ margin: '6px 0 10px' }}>
            <span className="mono">{blobUrl(view)}</span>
            <CopyButton text={blobUrl(view)} />
          </div>
          {c.publicAccess === 'off' ? <Callout>El contenedor es privado: abrir la URL sin un token SAS devolverá ResourceNotFound/PublicAccessNotPermitted. Genera un SAS en la sección "Firma de acceso compartido".</Callout> : null}
          <CodeBlock code={viewed.content.length > 20000 ? viewed.content.slice(0, 20000) + '\n...' : viewed.content} maxHeight={360} wrap />
        </div>
      ) : null}
    </>
  );
}

function FileShares({ r }: { r: Resource }) {
  useCloud();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('documentos');
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const shares = Object.values<any>(r.data?.shares ?? {});
  const share = open ? r.data?.shares?.[open] : null;
  const args = ['storage', 'share', 'create', '-n', name, '--quota', '100', ...keyAuth(r)];
  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      const text = await f.text();
      await portalAction('Cargar archivo', ['storage', 'file', 'upload', '-s', open!, '--source', `/home/portal/upload/${f.name}`, '--path', f.name, ...keyAuth(r)], { files: { [`upload/${f.name}`]: text }, subscription: r.subscriptionId, success: `Archivo ${f.name} cargado` });
    }
  };
  if (share) {
    return (
      <>
        <div className="row" style={{ marginBottom: 8 }}>
          <a onClick={() => setOpen(null)}>← Recursos compartidos</a>
          <span className="muted">/ {share.name}</span>
        </div>
        <CommandBar items={[{ label: 'Cargar', icon: 'upload', onClick: () => fileRef.current?.click() }]} />
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => e.target.files && upload(e.target.files).then(() => (e.target.value = ''))} />
        <DataTable
          rows={Object.entries<any>(share.files).map(([n, f]) => ({ name: n, ...f }))}
          rowKey={(f) => f.name}
          columns={[
            { key: 'n', title: 'Nombre', render: (f) => f.name },
            { key: 's', title: 'Tamaño', render: (f) => formatBytes(f.size ?? 0) },
            { key: 'm', title: 'Modificado', render: (f) => relTime(f.lastModified) },
          ]}
          empty="El recurso compartido está vacío."
        />
        <h3 className="section-title">Conectar</h3>
        <p className="muted small">Desde una VM Linux se monta por SMB 3 (puerto 445) con la clave de la cuenta:</p>
        <CodeBlock code={`sudo mkdir -p /mnt/${share.name}\nsudo mount -t cifs //${r.name}.file.core.windows.net/${share.name} /mnt/${share.name} \\\n  -o username=${r.name},password=<clave>,serverino,vers=3.0`} />
      </>
    );
  }
  return (
    <>
      <Callout>Azure Files ofrece carpetas compartidas SMB/NFS administradas: varias VM (o tu PC) pueden montarlas a la vez, como un servidor de archivos sin servidor.</Callout>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <div style={{ width: 240 }}>
          <TextInput value={name} onChange={setName} placeholder="Nombre del recurso compartido" />
        </div>
        <button className="btn primary" disabled={busy || !name} onClick={() => run(() => portalAction('Crear recurso compartido', args, { subscription: r.subscriptionId, success: `Recurso compartido ${name} creado` }))}>
          + Recurso compartido
        </button>
      </div>
      <DataTable
        rows={shares}
        rowKey={(x) => x.name}
        columns={[
          { key: 'n', title: 'Nombre', render: (x) => <a onClick={() => setOpen(x.name)}>{x.name}</a> },
          { key: 'q', title: 'Cuota', render: (x) => `${x.quota} GiB` },
          { key: 'f', title: 'Archivos', render: (x) => Object.keys(x.files ?? {}).length },
          { key: 'm', title: 'Modificado', render: (x) => relTime(x.lastModified) },
        ]}
        empty="No hay recursos compartidos de archivos."
      />
      <CliBox cmd={cliText(args)} />
    </>
  );
}

function StorageQueues({ r }: { r: Resource }) {
  useCloud();
  const [name, setName] = useState('tareas');
  const [sel, setSel] = useState<string>(Object.keys(r.data?.queues ?? {})[0] ?? '');
  const [msg, setMsg] = useState('procesar-pedido-1001');
  const { busy, run } = useAsync();
  const queues = Object.entries<any>(r.data?.queues ?? {}).map(([n, q]) => ({ name: n, ...q }));
  const q = r.data?.queues?.[sel];
  const args = ['storage', 'queue', 'create', '-n', name, ...keyAuth(r)];
  return (
    <>
      <Callout>Las colas de Storage son la mensajería más sencilla y barata (millones de mensajes de hasta 64 KB). Para temas, filtros, sesiones o mensajes fallidos, usa Service Bus.</Callout>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <div style={{ width: 240 }}>
          <TextInput value={name} onChange={setName} placeholder="Nombre de la cola" />
        </div>
        <button
          className="btn primary"
          disabled={busy || !name}
          onClick={() =>
            run(async () => {
              if (await portalAction('Crear cola', args, { subscription: r.subscriptionId, success: `Cola ${name} creada` })) setSel(name);
            })
          }
        >
          + Cola
        </button>
      </div>
      <DataTable
        rows={queues}
        rowKey={(x) => x.name}
        onRowClick={(x) => setSel(x.name)}
        columns={[
          { key: 'n', title: 'Nombre', render: (x) => (x.name === sel ? <b>▸ {x.name}</b> : x.name) },
          { key: 'c', title: 'Mensajes', render: (x) => (x.messages ?? []).length },
          { key: 'u', title: 'URL', render: (x) => <span className="mono small">https://{r.name}.queue.core.windows.net/{x.name}</span> },
        ]}
        empty="No hay colas."
      />
      {q ? (
        <>
          <h3 className="section-title">Mensajes de {sel}</h3>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <div style={{ width: 300 }}>
              <TextInput value={msg} onChange={setMsg} />
            </div>
            <button className="btn" disabled={!msg} onClick={() => portalAction('Agregar mensaje', ['storage', 'message', 'put', '-q', sel, '--content', msg, ...keyAuth(r)], { subscription: r.subscriptionId, success: 'Mensaje agregado' })}>
              Agregar mensaje
            </button>
            <button className="btn" disabled={!q.messages?.length} onClick={() => portalAction('Quitar de la cola', ['storage', 'message', 'get', '-q', sel, ...keyAuth(r)], { subscription: r.subscriptionId, success: 'Mensaje quitado de la cola' })}>
              Quitar de la cola
            </button>
          </div>
          <DataTable
            rows={q.messages ?? []}
            rowKey={(m: any) => m.id}
            columns={[
              { key: 'id', title: 'Id.', render: (m: any) => <span className="mono small">{m.id.slice(0, 8)}</span> },
              { key: 'c', title: 'Texto del mensaje', render: (m: any) => m.content },
              { key: 'i', title: 'Hora de inserción', render: (m: any) => relTime(m.insertionTime) },
              { key: 'd', title: 'Recuento de extracciones', render: (m: any) => m.dequeueCount ?? 0 },
            ]}
            empty="La cola está vacía."
          />
        </>
      ) : null}
    </>
  );
}

function Containers({ r }: { r: Resource }) {
  useCloud();
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const cs = Object.values(containersOf(r));
  const cur = open ? cs.find((c) => c.name === open) : undefined;
  if (cur) return <ContainerView r={r} c={cur} onBack={() => setOpen(null)} />;
  const del = async () => {
    if (!(await confirmDialog({ title: 'Eliminar contenedores', message: `¿Eliminar ${sel.join(', ')} y todos sus blobs?`, confirmText: 'Eliminar', danger: true }))) return;
    for (const n of sel) await portalAction('Eliminar contenedor', ['storage', 'container', 'delete', '-n', n, ...keyAuth(r)], { subscription: r.subscriptionId, quiet: true });
    setSel([]);
  };
  return (
    <>
      <CommandBar
        items={[
          { label: 'Contenedor', icon: 'add', onClick: () => openPane({ title: 'Nuevo contenedor', render: () => <NewContainer r={r} /> }) },
          { label: 'Eliminar', icon: 'delete', disabled: !sel.length, onClick: del },
        ]}
      />
      <DataTable
        rows={cs}
        rowKey={(c) => c.name}
        selectable
        selected={sel}
        onSelect={setSel}
        columns={[
          { key: 'n', title: 'Nombre', render: (c) => <a onClick={() => setOpen(c.name)}>{c.name}</a>, sort: (c) => c.name },
          { key: 'm', title: 'Última modificación', render: (c) => relTime(c.lastModified) },
          { key: 'a', title: 'Acceso anónimo', render: (c) => (c.publicAccess === 'off' ? 'Privado' : c.publicAccess === 'blob' ? 'Blob' : 'Contenedor') },
          { key: 'b', title: 'Blobs', render: (c) => Object.keys(c.blobs).length },
        ]}
        empty="No hay contenedores."
      />
    </>
  );
}

function AccessKeys({ r }: { r: Resource }) {
  useCloud();
  const [show, setShow] = useState(false);
  const keys: { keyName: string; value: string }[] = r.data?.keys ?? [];
  const cs = (k: string) => `DefaultEndpointsProtocol=https;AccountName=${r.name};AccountKey=${k};EndpointSuffix=core.windows.net`;
  return (
    <>
      <Callout kind="warn">Las claves de acceso dan control total sobre los datos de la cuenta. Guárdalas en Key Vault y rótalas periódicamente; mejor aún, usa Microsoft Entra ID (roles de datos) o identidades administradas.</Callout>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setShow(!show)}>
          {show ? 'Ocultar' : 'Mostrar'} claves
        </button>
      </div>
      {keys.map((k) => (
        <div key={k.keyName} className="card" style={{ marginBottom: 12 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>{k.keyName}</h3>
            <span className="spacer" />
            <button
              className="btn small"
              onClick={async () => {
                if (await confirmDialog({ title: `Girar ${k.keyName}`, message: 'Las aplicaciones que usen esta clave dejarán de funcionar hasta que actualices su configuración.', confirmText: 'Girar clave' }))
                  await portalAction('Girar clave', ['storage', 'account', 'keys', 'renew', ...gn(r).map((x) => (x === '-n' ? '--account-name' : x)), '--key', k.keyName === 'key1' ? 'primary' : 'secondary'], { subscription: r.subscriptionId, success: `${k.keyName} regenerada` });
              }}
            >
              Girar clave
            </button>
          </div>
          <Field stack label="Clave">
            <div className="row">
              <input className="input mono" readOnly value={show ? k.value : '•'.repeat(40)} />
              <CopyButton text={k.value} />
            </div>
          </Field>
          <Field stack label="Cadena de conexión">
            <div className="row">
              <input className="input mono" readOnly value={show ? cs(k.value) : '•'.repeat(60)} />
              <CopyButton text={cs(k.value)} />
            </div>
          </Field>
        </div>
      ))}
    </>
  );
}

function Sas({ r }: { r: Resource }) {
  const [perms, setPerms] = useState<Record<string, boolean>>({ r: true, l: true, w: false, d: false, c: false });
  const [hours, setHours] = useState('8');
  const [container, setContainer] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const expiry = new Date(Date.now() + Number(hours) * 3600000).toISOString().slice(0, 16) + 'Z';
  const p = ['r', 'w', 'd', 'l', 'c'].filter((x) => perms[x]).join('');
  const args = container
    ? ['storage', 'container', 'generate-sas', '-n', container, '--permissions', p, '--expiry', expiry, '--https-only', ...keyAuth(r).slice(0, 2), '-o', 'tsv']
    : ['storage', 'account', 'generate-sas', '--account-name', r.name, '--services', 'b', '--resource-types', 'sco', '--permissions', p, '--expiry', expiry, '--https-only', '-o', 'tsv'];
  const cs = Object.keys(containersOf(r));
  return (
    <>
      <p>Una firma de acceso compartido (SAS) es un token que concede acceso limitado (permisos y caducidad) sin compartir la clave de la cuenta.</p>
      <Field label="Ámbito">
        <Select value={container} onChange={setContainer} options={[{ value: '', label: 'Cuenta (todos los contenedores)' }, ...cs.map((c) => ({ value: c, label: `Contenedor: ${c}` }))]} />
      </Field>
      <Field label="Permisos">
        <div className="row wrap">
          {[
            ['r', 'Lectura'],
            ['l', 'Lista'],
            ['w', 'Escritura'],
            ['c', 'Creación'],
            ['d', 'Eliminación'],
          ].map(([k, l]) => (
            <Checkbox key={k} checked={!!perms[k]} onChange={(v) => setPerms({ ...perms, [k]: v })} label={l} />
          ))}
        </div>
      </Field>
      <Field label="Caducidad (horas desde ahora)">
        <TextInput value={hours} onChange={setHours} />
      </Field>
      <CliBox cmd={cliText(args)} />
      <div className="btn-row" style={{ margin: '12px 0' }}>
        <button
          className="btn primary"
          disabled={busy || !p}
          onClick={() =>
            run(async () => {
              const res = await az(args, { subscription: r.subscriptionId });
              setResult(res.code === 0 ? res.out.trim().replace(/^"|"$/g, '') : `Error: ${res.err}`);
            })
          }
        >
          Generar SAS y cadena de conexión
        </button>
      </div>
      {result ? (
        <>
          <Field stack label="Token SAS">
            <div className="row">
              <input className="input mono" readOnly value={result} />
              <CopyButton text={result} />
            </div>
          </Field>
          <Field stack label={`URL de ${container ? 'contenedor' : 'servicio Blob'} con SAS`}>
            <div className="row">
              <input className="input mono" readOnly value={`https://${r.name}.blob.core.windows.net/${container ? container + '?restype=container&comp=list&' : '?'}${result}`} />
              <CopyButton text={`https://${r.name}.blob.core.windows.net/${container ? container + '?restype=container&comp=list&' : '?'}${result}`} />
            </div>
          </Field>
        </>
      ) : null}
    </>
  );
}

function StaticWebsite({ r }: { r: Resource }) {
  useCloud();
  const sw = r.data?.staticWebsite ?? { enabled: false };
  const [index, setIndex] = useState(sw.indexDocument ?? 'index.html');
  const [err404, setErr404] = useState(sw.errorDocument404Path ?? '');
  const { busy, run } = useAsync();
  const args = ['storage', 'blob', 'service-properties', 'update', '--account-name', r.name, '--static-website', '--index-document', index, ...(err404 ? ['--404-document', err404] : []), '--auth-mode', 'key'];
  const url = r.properties.primaryEndpoints?.web;
  return (
    <>
      <p>Hospeda una web estática (HTML, CSS, JavaScript, imágenes) directamente desde el almacenamiento. Los ficheros se suben al contenedor especial <code>$web</code>.</p>
      <Props
        rows={[
          ['Estado', sw.enabled ? <span className="pill ok">Habilitado</span> : <span className="pill">Deshabilitado</span>],
          ['Punto de conexión principal', sw.enabled ? <a onClick={() => openUrl(url)}>{url}</a> : '—'],
        ]}
      />
      <div style={{ maxWidth: 760, marginTop: 14 }}>
        <Field label="Nombre del documento de índice">
          <TextInput value={index} onChange={setIndex} />
        </Field>
        <Field label="Ruta del documento de error">
          <TextInput value={err404} onChange={setErr404} placeholder="404.html" />
        </Field>
      </div>
      <div className="btn-row">
        <button className="btn primary" disabled={busy} onClick={() => run(() => portalAction('Habilitar sitio web estático', args, { subscription: r.subscriptionId, success: 'Sitio web estático habilitado' }))}>
          {sw.enabled ? 'Guardar' : 'Habilitar'}
        </button>
        {sw.enabled ? (
          <button className="btn" onClick={() => portalAction('Deshabilitar sitio web estático', ['storage', 'blob', 'service-properties', 'update', '--account-name', r.name, '--static-website', 'false', '--auth-mode', 'key'], { subscription: r.subscriptionId })}>
            Deshabilitar
          </button>
        ) : null}
      </div>
      <div style={{ marginTop: 16 }}>
        <CliBox cmd={`az storage blob upload-batch --account-name ${r.name} -s ./mi-web -d '$web' --auth-mode key`} />
      </div>
    </>
  );
}

function Configuration({ r }: { r: Resource }) {
  useCloud();
  const [publicBlob, setPublicBlob] = useState(!!r.properties.allowBlobPublicAccess);
  const [sharedKey, setSharedKey] = useState(r.properties.allowSharedKeyAccess !== false);
  const [tier, setTier] = useState(r.properties.accessTier ?? 'Hot');
  const [sku, setSku] = useState(r.sku?.name ?? 'Standard_LRS');
  const { busy, run } = useAsync();
  const args = ['storage', 'account', 'update', ...gn(r), '--allow-blob-public-access', String(publicBlob), '--allow-shared-key-access', String(sharedKey), ...(tier ? ['--access-tier', tier] : []), '--sku', sku];
  return (
    <div style={{ maxWidth: 860 }}>
      <Field label="Redundancia" help="LRS: 3 copias en un centro de datos. ZRS: en 3 zonas. GRS: replicada a la región emparejada. RA-GRS: además, lectura en la secundaria.">
        <Select value={sku} onChange={setSku} options={['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS', 'Standard_GZRS', 'Standard_RAGZRS', 'Premium_LRS']} />
      </Field>
      <Field label="Nivel de acceso predeterminado" help="Frecuente (Hot) para datos que se usan a menudo; esporádico (Cool) o frío (Cold) abaratan el almacenamiento pero encarecen el acceso.">
        <Select
          value={tier}
          onChange={setTier}
          options={[
            { value: 'Hot', label: 'Frecuente (Hot)' },
            { value: 'Cool', label: 'Esporádico (Cool)' },
            { value: 'Cold', label: 'Frío (Cold)' },
          ]}
        />
      </Field>
      <Field label="Permitir el acceso anónimo a blobs">
        <Checkbox checked={publicBlob} onChange={setPublicBlob} label={publicBlob ? 'Habilitado' : 'Deshabilitado'} />
      </Field>
      <Field label="Permitir el acceso con clave de cuenta">
        <Checkbox checked={sharedKey} onChange={setSharedKey} label={sharedKey ? 'Habilitado' : 'Deshabilitado (sólo Entra ID)'} />
      </Field>
      <CliBox cmd={cliText(args)} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={() => run(() => portalAction('Actualizar la configuración', args, { subscription: r.subscriptionId, success: 'Configuración guardada' }))}>
          Guardar
        </button>
      </div>
    </div>
  );
}

function Networking({ r }: { r: Resource }) {
  useCloud();
  const rules = r.properties.networkRuleSet ?? { defaultAction: 'Allow', ipRules: [] };
  const [ip, setIp] = useState('20.31.118.42');
  return (
    <>
      <Field label="Acceso a la red pública">
        <Select
          value={rules.defaultAction === 'Allow' ? 'all' : 'selected'}
          onChange={(v) => portalAction('Actualizar reglas de red', ['storage', 'account', 'update', ...gn(r), '--default-action', v === 'all' ? 'Allow' : 'Deny'], { subscription: r.subscriptionId, success: 'Reglas de red actualizadas' })}
          options={[
            { value: 'all', label: 'Habilitado desde todas las redes' },
            { value: 'selected', label: 'Habilitado desde redes virtuales y direcciones IP seleccionadas' },
          ]}
        />
      </Field>
      {rules.defaultAction === 'Deny' ? (
        <>
          <h3 className="section-title">Firewall: intervalos de direcciones</h3>
          <DataTable rows={rules.ipRules ?? []} rowKey={(x: any) => x.value ?? x.ipAddressOrRange} columns={[{ key: 'v', title: 'Dirección IP o CIDR', render: (x: any) => <span className="mono">{x.value ?? x.ipAddressOrRange}</span> }]} empty="Sin reglas: sólo se permite el acceso desde los servicios de confianza." />
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <input className="input mono" style={{ maxWidth: 220 }} value={ip} onChange={(e) => setIp(e.target.value)} />
            <button className="btn" onClick={() => portalAction('Agregar regla de IP', ['storage', 'account', 'network-rule', 'add', '--account-name', r.name, '-g', r.resourceGroup, '--ip-address', ip], { subscription: r.subscriptionId, success: `IP ${ip} permitida` })}>
              Agregar la IP
            </button>
            <span className="muted small">Tu IP de Cloud Shell: 20.31.118.42</span>
          </div>
        </>
      ) : null}
    </>
  );
}

export const STORAGE_BLADES: Record<string, TypeBlade> = {
  'microsoft.storage/storageaccounts': {
    Overview: ({ r }) => (
      <div className="grid2">
        <div>
          <h3 className="section-title">Propiedades</h3>
          <Props
            rows={[
              ['Rendimiento', r.sku?.tier ?? 'Standard'],
              ['Replicación', r.sku?.name?.split('_')[1]],
              ['Tipo de cuenta', r.kind],
              ['Nivel de acceso', r.properties.accessTier ?? '—'],
              ['Acceso anónimo a blobs', r.properties.allowBlobPublicAccess ? 'Habilitado' : 'Deshabilitado'],
              ['TLS mínimo', r.properties.minimumTlsVersion],
            ]}
          />
        </div>
        <div>
          <h3 className="section-title">Puntos de conexión</h3>
          <Props
            rows={[
              ['Blob', <span className="mono small">{r.properties.primaryEndpoints?.blob}</span>],
              ['File', <span className="mono small">{r.properties.primaryEndpoints?.file}</span>],
              ['Queue', <span className="mono small">{r.properties.primaryEndpoints?.queue}</span>],
              ['Sitio web estático', r.data?.staticWebsite?.enabled ? <a onClick={() => openUrl(r.properties.primaryEndpoints?.web)}>{r.properties.primaryEndpoints?.web}</a> : 'Deshabilitado'],
              ['Contenedores', String(Object.keys(containersOf(r)).length)],
            ]}
          />
        </div>
      </div>
    ),
    sections: [
      { id: 'containers', label: 'Contenedores', icon: 'folder', group: 'Almacenamiento de datos', Comp: Containers },
      { id: 'shares', label: 'Recursos compartidos de archivos', icon: 'folder', group: 'Almacenamiento de datos', Comp: FileShares },
      { id: 'queues', label: 'Colas', icon: 'file', group: 'Almacenamiento de datos', Comp: StorageQueues },
      { id: 'keys', label: 'Claves de acceso', icon: 'key', group: 'Seguridad y redes', Comp: AccessKeys },
      { id: 'sas', label: 'Firma de acceso compartido', icon: 'link', group: 'Seguridad y redes', Comp: Sas },
      { id: 'networking', label: 'Redes', icon: 'network', group: 'Seguridad y redes', Comp: Networking },
      { id: 'static', label: 'Sitio web estático', icon: 'cloud', group: 'Administración de datos', Comp: StaticWebsite },
      { id: 'config', label: 'Configuración', icon: 'settings2', group: 'Configuración', Comp: Configuration },
      { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
    ],
    cli: (r) => [
      { label: 'Crear un contenedor (con tu identidad de Entra ID)', cmd: `az storage container create --account-name ${r.name} -n datos --auth-mode login` },
      { label: 'Subir un fichero', cmd: `az storage blob upload --account-name ${r.name} -c datos -f ./fichero.txt -n fichero.txt --auth-mode login` },
      { label: 'Listar blobs en formato tabla', cmd: `az storage blob list --account-name ${r.name} -c datos --auth-mode login -o table` },
    ],
  },
};
