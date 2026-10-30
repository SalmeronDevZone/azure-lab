// Blades de datos y seguridad: Key Vault, servidores y bases de datos de Azure SQL.
import { useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, resourceHref } from '../../hooks';
import { openPane, closePane } from '../../uiStore';
import { Callout, CliBox, CodeBlock, CommandBar, CopyButton, DataTable, Field, TextInput, Checkbox, confirmDialog, useAsync, Select } from '../../components/common';
import { portalAction, cliText } from '../../portalCli';
import { kvAllowed } from '../../../engine/services/keyvault';
import { connect, execSql, formatSqlResults } from '../../../engine/services/sql';
import { databasesOf, firewallRulesOf } from '../../../engine/providers/sql';
import { portalPrincipal, getState } from '../../../engine/store';
import { principalDisplay } from '../../../engine/services/identity';
import { relTime, formatDate } from '../../../engine/util';
import type { TypeBlade } from './shared';
import { MetricsSection, Props, gn } from './shared';
import { Icon } from '../../components/Icons';

// ---------------------------------------------------------------- Key Vault

function NewSecret({ r }: { r: Resource }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const { busy, run } = useAsync();
  const args = ['keyvault', 'secret', 'set', '--vault-name', r.name, '-n', name, '--value', value];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required help="Letras, números y guiones (1-127 caracteres).">
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Valor del secreto" required>
          <TextInput value={value} onChange={setValue} type="password" />
        </Field>
        <CliBox cmd={cliText(args.map((a) => (a === value && value ? '<valor>' : a)))} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name || !value} onClick={() => run(async () => (await portalAction('Crear secreto', args, { subscription: r.subscriptionId, success: `Secreto ${name} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function Secrets({ r }: { r: Resource }) {
  useCloud();
  const me = portalPrincipal();
  const canList = kvAllowed(r, me, 'list');
  const canGet = kvAllowed(r, me, 'get');
  const [shown, setShown] = useState<Record<string, string>>({});
  const secrets = Object.entries<any>(r.data?.secrets ?? {}).filter(([, v]) => !v.deleted);
  const deleted = Object.entries<any>(r.data?.secrets ?? {}).filter(([, v]) => v.deleted);
  if (!canList) {
    return (
      <>
        <CommandBar items={[{ label: 'Generar o importar', icon: 'add', onClick: () => openPane({ title: 'Crear un secreto', render: () => <NewSecret r={r} /> }) }]} />
        <Callout kind="bad" title={r.properties.enableRbacAuthorization ? 'No está autorizado para ver este contenido.' : "La operación 'Lista' no está habilitada en la directiva de acceso de este almacén de claves."}>
          {r.properties.enableRbacAuthorization ? (
            <>
              Este almacén usa el modelo de permisos <b>Control de acceso basado en roles de Azure</b>. Ser propietario (Owner) da permisos sobre el <i>recurso</i>, pero no sobre los <i>datos</i>: asígnate el rol <b>Key Vault Secrets Officer</b> en Control de acceso (IAM) del almacén.
            </>
          ) : (
            <>Agrega una directiva de acceso para tu usuario con permisos de secretos (Get, List, Set...) en la sección <b>Directivas de acceso</b>.</>
          )}
        </Callout>
      </>
    );
  }
  const reveal = async (name: string) => {
    const res = await portalAction('Mostrar secreto', ['keyvault', 'secret', 'show', '--vault-name', r.name, '-n', name], { subscription: r.subscriptionId, quiet: true });
    if (res?.json) setShown({ ...shown, [name]: res.json.value });
  };
  return (
    <>
      <CommandBar items={[{ label: 'Generar o importar', icon: 'add', onClick: () => openPane({ title: 'Crear un secreto', render: () => <NewSecret r={r} /> }) }]} />
      <DataTable
        rows={secrets}
        rowKey={([n]) => n}
        columns={[
          { key: 'n', title: 'Nombre', render: ([n]) => <b>{n}</b> },
          { key: 's', title: 'Estado', render: ([, v]) => (v.versions[v.versions.length - 1]?.enabled === false ? <span className="pill bad">Deshabilitado</span> : <span className="pill ok">Habilitado</span>) },
          { key: 'v', title: 'Versiones', render: ([, v]) => v.versions.length },
          { key: 'm', title: 'Actualizado', render: ([, v]) => relTime(v.versions[v.versions.length - 1]?.created ?? v.versions[v.versions.length - 1]?.attributes?.created ?? new Date().toISOString()) },
          {
            key: 'val',
            title: 'Valor',
            render: ([n]) =>
              shown[n] !== undefined ? (
                <span className="row" style={{ gap: 6 }}>
                  <span className="mono">{shown[n]}</span>
                  <CopyButton text={shown[n]} />
                </span>
              ) : (
                <button className="btn small" disabled={!canGet} onClick={() => reveal(n)} title={canGet ? '' : 'Sin permiso Get'}>
                  Mostrar valor
                </button>
              ),
          },
          {
            key: 'x',
            title: '',
            render: ([n]) => (
              <button
                className="btn small"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Eliminar secreto', message: `¿Eliminar ${n}? Con la eliminación temporal activada podrás recuperarlo durante el periodo de retención.`, confirmText: 'Eliminar', danger: true }))
                    await portalAction('Eliminar secreto', ['keyvault', 'secret', 'delete', '--vault-name', r.name, '-n', n], { subscription: r.subscriptionId, success: `Secreto ${n} eliminado` });
                }}
              >
                Eliminar
              </button>
            ),
          },
        ]}
        empty="No hay secretos en este almacén."
      />
      {deleted.length ? (
        <>
          <h3 className="section-title">Secretos eliminados (recuperables)</h3>
          <DataTable
            rows={deleted}
            rowKey={([n]) => n}
            columns={[
              { key: 'n', title: 'Nombre', render: ([n]) => n },
              { key: 'r', title: '', render: ([n]) => <button className="btn small" onClick={() => portalAction('Recuperar secreto', ['keyvault', 'secret', 'recover', '--vault-name', r.name, '-n', n], { subscription: r.subscriptionId, success: `Secreto ${n} recuperado` })}>Recuperar</button> },
            ]}
          />
        </>
      ) : null}
    </>
  );
}

function AccessConfig({ r }: { r: Resource }) {
  useCloud();
  const rbac = !!r.properties.enableRbacAuthorization;
  return (
    <>
      <p>Key Vault tiene dos modelos de permisos para el plano de datos (secretos, claves y certificados):</p>
      <ul>
        <li>
          <b>Control de acceso basado en roles de Azure (recomendado)</b>: roles como <i>Key Vault Secrets User</i> u <i>Officer</i> asignados en IAM.
        </li>
        <li>
          <b>Directiva de acceso del almacén</b>: el modelo heredado, con permisos por usuario/aplicación definidos en el propio almacén.
        </li>
      </ul>
      <Props rows={[['Modelo de permisos', rbac ? 'Control de acceso basado en roles de Azure' : 'Directiva de acceso del almacén'], ['Eliminación temporal', 'Habilitada (90 días)'], ['Protección de purga', r.properties.enablePurgeProtection ? 'Habilitada' : 'Deshabilitada']]} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => portalAction('Cambiar modelo de permisos', ['keyvault', 'update', '-n', r.name, '-g', r.resourceGroup, '--enable-rbac-authorization', String(!rbac)], { subscription: r.subscriptionId, success: 'Modelo de permisos actualizado' })}>
          Cambiar a {rbac ? 'directivas de acceso' : 'RBAC de Azure'}
        </button>
      </div>
    </>
  );
}

function AccessPolicies({ r }: { r: Resource }) {
  const s = useCloud();
  const [who, setWho] = useState('');
  const [perms, setPerms] = useState<Record<string, boolean>>({ get: true, list: true, set: false, delete: false });
  const policies: any[] = r.properties.accessPolicies ?? [];
  if (r.properties.enableRbacAuthorization) return <Callout>Este almacén usa RBAC de Azure: las directivas de acceso no se aplican. Usa Control de acceso (IAM).</Callout>;
  const candidates = [...s.users.map((u) => ({ id: u.id, label: `${u.displayName} (${u.userPrincipalName})` })), ...s.servicePrincipals.map((x) => ({ id: x.id, label: `${x.displayName} (${x.servicePrincipalType === 'ManagedIdentity' ? 'identidad administrada' : 'aplicación'})` }))];
  const p = Object.keys(perms).filter((k) => perms[k]);
  const args = ['keyvault', 'set-policy', '-n', r.name, '--object-id', who, '--secret-permissions', ...p];
  return (
    <>
      <DataTable
        rows={policies}
        rowKey={(x) => x.objectId}
        columns={[
          { key: 'n', title: 'Nombre', render: (x) => principalDisplay(x.objectId).name },
          { key: 't', title: 'Tipo', render: (x) => principalDisplay(x.objectId).type },
          { key: 'p', title: 'Permisos de secretos', render: (x) => (x.permissions?.secrets ?? []).join(', ') },
          { key: 'd', title: '', render: (x) => <button className="btn small" onClick={() => portalAction('Eliminar directiva', ['keyvault', 'delete-policy', '-n', r.name, '--object-id', x.objectId], { subscription: r.subscriptionId, success: 'Directiva eliminada' })}>Eliminar</button> },
        ]}
        empty="No hay directivas de acceso."
      />
      <h3 className="section-title">Crear una directiva de acceso</h3>
      <div style={{ maxWidth: 760 }}>
        <Field label="Entidad de seguridad">
          <Select value={who} onChange={setWho} options={[{ value: '', label: 'Selecciona...' }, ...candidates.map((c) => ({ value: c.id, label: c.label }))]} />
        </Field>
        <Field label="Permisos de secretos">
          <div className="row wrap">
            {['get', 'list', 'set', 'delete', 'recover', 'purge'].map((k) => (
              <Checkbox key={k} checked={!!perms[k]} onChange={(v) => setPerms({ ...perms, [k]: v })} label={k} />
            ))}
          </div>
        </Field>
        <CliBox cmd={cliText(args)} />
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={!who || !p.length} onClick={() => portalAction('Crear directiva de acceso', args, { subscription: r.subscriptionId, success: 'Directiva de acceso creada' })}>
            Crear
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- SQL

function Firewall({ r }: { r: Resource }) {
  const s = useCloud();
  const rules = firewallRulesOf(r, s.resources);
  const [name, setName] = useState('ClientIPAddress');
  const [ip, setIp] = useState('20.31.118.42');
  const allowAzure = rules.some((x: Resource) => x.properties.startIpAddress === '0.0.0.0' && x.properties.endIpAddress === '0.0.0.0');
  const args = ['sql', 'server', 'firewall-rule', 'create', '-g', r.resourceGroup, '-s', r.name, '-n', name, '--start-ip-address', ip, '--end-ip-address', ip];
  return (
    <>
      <Callout>
        Por defecto el servidor rechaza todas las conexiones. Añade reglas de firewall para las IP de tus clientes. La IP de tu Cloud Shell simulado es <b className="mono">20.31.118.42</b>.
      </Callout>
      <Checkbox
        checked={allowAzure}
        onChange={(v) =>
          v
            ? portalAction('Permitir servicios de Azure', ['sql', 'server', 'firewall-rule', 'create', '-g', r.resourceGroup, '-s', r.name, '-n', 'AllowAllWindowsAzureIps', '--start-ip-address', '0.0.0.0', '--end-ip-address', '0.0.0.0'], { subscription: r.subscriptionId, success: 'Los servicios de Azure pueden acceder al servidor' })
            : portalAction('Quitar acceso de servicios de Azure', ['sql', 'server', 'firewall-rule', 'delete', '-g', r.resourceGroup, '-s', r.name, '-n', 'AllowAllWindowsAzureIps'], { subscription: r.subscriptionId })
        }
        label="Permitir que los servicios y recursos de Azure accedan a este servidor"
      />
      <h3 className="section-title">Reglas de firewall</h3>
      <DataTable
        rows={rules}
        rowKey={(x: Resource) => x.id}
        columns={[
          { key: 'n', title: 'Nombre de regla', render: (x: Resource) => x.name.split('/').pop() },
          { key: 'a', title: 'IP inicial', render: (x: Resource) => <span className="mono">{x.properties.startIpAddress}</span> },
          { key: 'b', title: 'IP final', render: (x: Resource) => <span className="mono">{x.properties.endIpAddress}</span> },
          { key: 'd', title: '', render: (x: Resource) => <button className="btn small" onClick={() => portalAction('Eliminar regla de firewall', ['sql', 'server', 'firewall-rule', 'delete', '-g', r.resourceGroup, '-s', r.name, '-n', x.name.split('/').pop()!], { subscription: r.subscriptionId, success: 'Regla eliminada' })}>Eliminar</button> },
        ]}
        empty="No hay reglas: nadie puede conectarse desde fuera."
      />
      <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
        <input className="input" style={{ width: 200 }} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input mono" style={{ width: 180 }} value={ip} onChange={(e) => setIp(e.target.value)} />
        <button className="btn" onClick={() => portalAction('Agregar regla de firewall', args, { subscription: r.subscriptionId, success: `Regla ${name} creada` })}>
          Agregar regla
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        <CliBox cmd={cliText(args)} />
      </div>
    </>
  );
}

function Databases({ r }: { r: Resource }) {
  const s = useCloud();
  const dbs = databasesOf(r, s.resources);
  return (
    <>
      <CommandBar items={[{ label: 'Crear base de datos', icon: 'add', onClick: () => (location.hash = `#/create/sql?server=${encodeURIComponent(r.id)}`) }]} />
      <DataTable
        rows={dbs}
        rowKey={(x: Resource) => x.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (x: Resource) => <a href={resourceHref(x.id)}>{x.name.split('/').pop()}</a> },
          { key: 's', title: 'Estado', render: (x: Resource) => <span className="pill ok">{x.properties.status ?? 'Online'}</span> },
          { key: 'p', title: 'Plan de tarifa', render: (x: Resource) => x.sku?.name },
        ]}
        empty="El servidor no tiene bases de datos."
      />
    </>
  );
}

function QueryEditor({ r }: { r: Resource }) {
  const server = getState().resources.find((x) => x.id.toLowerCase() === r.id.split('/databases/')[0].toLowerCase());
  const [user, setUser] = useState(server?.properties.administratorLogin ?? '');
  const [pw, setPw] = useState('');
  const [sql, setSql] = useState('SELECT name FROM sys.tables;');
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const clientIp = '88.21.144.37';
  const run = () => {
    setErr(null);
    try {
      const conn = connect(`${server?.name}.database.windows.net`, r.name.split('/').pop(), user, pw, clientIp);
      setConnected(true);
      setOut(formatSqlResults(execSql(conn, sql)));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setOut(null);
    }
  };
  return (
    <>
      <p>Editor de consultas de la base de datos (cliente: tu navegador, IP <span className="mono">{clientIp}</span>). Inicia sesión con la autenticación de SQL Server.</p>
      {!connected ? (
        <div style={{ maxWidth: 520 }}>
          <Field label="Inicio de sesión">
            <TextInput value={user} onChange={setUser} />
          </Field>
          <Field label="Contraseña">
            <TextInput value={pw} onChange={setPw} type="password" onEnter={run} />
          </Field>
        </div>
      ) : null}
      <Field stack label="Consulta">
        <textarea className="textarea" rows={6} value={sql} onChange={(e) => setSql(e.target.value)} />
      </Field>
      <div className="btn-row">
        <button className="btn primary" onClick={run}>
          Ejecutar
        </button>
        {connected ? (
          <button className="btn" onClick={() => setConnected(false)}>
            Cerrar sesión
          </button>
        ) : null}
      </div>
      {err ? (
        <div style={{ marginTop: 12 }}>
          <Callout kind="bad" title="Error">
            <div style={{ whiteSpace: 'pre-wrap' }}>{err}</div>
            {/not allowed to access the server/i.test(err) ? (
              <div style={{ marginTop: 8 }}>
                <button className="btn small" onClick={() => server && portalAction('Permitir IP del cliente', ['sql', 'server', 'firewall-rule', 'create', '-g', server.resourceGroup, '-s', server.name, '-n', 'ClientIP-Portal', '--start-ip-address', clientIp, '--end-ip-address', clientIp], { subscription: server.subscriptionId, success: `IP ${clientIp} permitida en el firewall` })}>
                  Permitir la IP {clientIp} en el firewall del servidor
                </button>
              </div>
            ) : null}
          </Callout>
        </div>
      ) : null}
      {out !== null ? (
        <div style={{ marginTop: 12 }}>
          <CodeBlock code={out || '(0 filas)'} />
        </div>
      ) : null}
    </>
  );
}

function ConnectionStrings({ r }: { r: Resource }) {
  const server = r.id.split('/databases/')[0].split('/').pop();
  const db = r.name.split('/').pop();
  const ado = `Server=tcp:${server}.database.windows.net,1433;Initial Catalog=${db};Persist Security Info=False;User ID={your_username};Password={your_password};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`;
  return (
    <>
      <Field stack label="ADO.NET (autenticación de SQL)">
        <CodeBlock code={ado} wrap />
      </Field>
      <Field stack label="sqlcmd (Cloud Shell)">
        <CliBox cmd={`sqlcmd -S ${server}.database.windows.net -d ${db} -U <usuario> -P '<contraseña>' -Q "SELECT 1"`} />
      </Field>
    </>
  );
}

export const DATA_BLADES: Record<string, TypeBlade> = {
  'microsoft.keyvault/vaults': {
    Overview: ({ r }) => {
      useCloud();
      const canList = kvAllowed(r, portalPrincipal(), 'list');
      return (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <span className="mono small">{r.properties.vaultUri}</span>
            <CopyButton text={r.properties.vaultUri} label="Copiar URI" />
          </div>
          {r.properties.enableRbacAuthorization && !canList ? (
            <Callout kind="warn" title="Todavía no puedes ver los secretos de este almacén">
              El almacén usa RBAC de Azure. Para gestionar secretos necesitas el rol <b>Key Vault Secrets Officer</b> (o <i>Key Vault Administrator</i>) en <a href={resourceHref(r.id, 'iam')}>Control de acceso (IAM)</a>: ser Owner no basta.
            </Callout>
          ) : null}
          <div className="grid3">
            {[
              ['secrets', 'key', 'Secretos', 'Contraseñas, cadenas de conexión y tokens que leen tus aplicaciones.'],
              ['accessconfig', 'settings2', 'Configuración de acceso', 'RBAC de Azure o directivas de acceso del almacén.'],
              ['iam', 'people', 'Control de acceso (IAM)', 'Quién puede administrar el almacén y leer sus secretos.'],
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
    },
    sections: [
      { id: 'secrets', label: 'Secretos', icon: 'key', group: 'Objetos', Comp: Secrets },
      { id: 'accessconfig', label: 'Configuración de acceso', icon: 'settings2', group: 'Configuración', Comp: AccessConfig },
      { id: 'policies', label: 'Directivas de acceso', icon: 'people', group: 'Configuración', Comp: AccessPolicies },
      { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
    ],
    cli: (r) => [
      { label: 'Darte permiso para gestionar secretos (modelo RBAC)', cmd: `az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Key Vault Secrets Officer" --scope $(az keyvault show -n ${r.name} --query id -o tsv)` },
      { label: 'Crear un secreto', cmd: `az keyvault secret set --vault-name ${r.name} -n DbPassword --value "S3cr3t0!"` },
      { label: 'Leer un secreto', cmd: `az keyvault secret show --vault-name ${r.name} -n DbPassword --query value -o tsv` },
    ],
  },
  'microsoft.sql/servers': {
    Overview: ({ r }) => {
      const s = useCloud();
      return (
        <Props
          rows={[
            ['Nombre del servidor', <span className="mono">{r.properties.fullyQualifiedDomainName}</span>],
            ['Administrador de SQL', r.properties.administratorLogin],
            ['Bases de datos', String(databasesOf(r, s.resources).length)],
            ['Reglas de firewall', String(firewallRulesOf(r, s.resources).length)],
            ['Versión', r.properties.version ?? '12.0'],
          ]}
        />
      );
    },
    sections: [
      { id: 'databases', label: 'Bases de datos SQL', icon: 'file', group: 'Configuración', Comp: Databases },
      { id: 'networking', label: 'Redes', icon: 'network', group: 'Seguridad', Comp: Firewall },
    ],
    cli: (r) => [{ label: 'Permitir tu IP de Cloud Shell', cmd: `az sql server firewall-rule create -g ${r.resourceGroup} -s ${r.name} -n cloudshell --start-ip-address $(curl -s ifconfig.me) --end-ip-address $(curl -s ifconfig.me)` }],
  },
  'microsoft.sql/servers/databases': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Servidor', <a href={resourceHref(r.id.split('/databases/')[0])}>{r.id.split('/databases/')[0].split('/').pop()}</a>],
          ['Plan de tarifa', `${r.sku?.name} (${r.sku?.tier})`],
          ['Estado', r.properties.status ?? 'Online'],
          ['Tamaño máximo', r.properties.maxSizeBytes ? `${Math.round(r.properties.maxSizeBytes / 1024 ** 3)} GB` : '—'],
          ['Creada', formatDate(r.createdAt)],
        ]}
      />
    ),
    sections: [
      { id: 'query', label: 'Editor de consultas', icon: 'code', group: 'General', Comp: QueryEditor },
      { id: 'connstr', label: 'Cadenas de conexión', icon: 'link', group: 'Configuración', Comp: ConnectionStrings },
      { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
    ],
  },
};

export const _gn = gn;
