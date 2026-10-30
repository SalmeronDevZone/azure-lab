// Microsoft Entra ID: inquilino, usuarios, grupos, registros de aplicaciones y aplicaciones empresariales.
import { useState } from 'react';
import { useCloud } from '../hooks';
import { openPane, closePane } from '../uiStore';
import { BladeLayout, type MenuItem } from './blade';
import { Callout, CliBox, CommandBar, CopyButton, DataTable, Field, TextInput, Checkbox, confirmDialog, useAsync, Select } from '../components/common';
import { portalAction, cliText } from '../portalCli';
import { listRoleAssignments } from '../../engine/services/identity';
import { formatDate, relTime } from '../../engine/util';
import { Essentials } from './blade';

function NewUser() {
  const s = useCloud();
  const [display, setDisplay] = useState('');
  const [alias, setAlias] = useState('');
  const [pw, setPw] = useState('');
  const [job, setJob] = useState('');
  const { busy, run } = useAsync();
  const upn = `${alias}@${s.tenant.domain}`;
  const args = ['ad', 'user', 'create', '--display-name', display, '--user-principal-name', upn, '--password', pw, ...(job ? ['--job-title', job] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre principal de usuario" required help={`Inicio de sesión: ${upn}`}>
          <TextInput value={alias} onChange={setAlias} autoFocus />
        </Field>
        <Field label="Nombre para mostrar" required>
          <TextInput value={display} onChange={setDisplay} />
        </Field>
        <Field label="Contraseña" required help="Mínimo 8 caracteres con 3 de: mayúsculas, minúsculas, números y símbolos.">
          <TextInput value={pw} onChange={setPw} type="password" />
        </Field>
        <Field label="Puesto">
          <TextInput value={job} onChange={setJob} />
        </Field>
        <CliBox cmd={cliText(args.map((a) => (a === pw && pw ? '<contraseña>' : a)))} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !alias || !display || !pw} onClick={() => run(async () => (await portalAction('Crear usuario', args, { success: `Usuario ${upn} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function NewGroup() {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const { busy, run } = useAsync();
  const args = ['ad', 'group', 'create', '--display-name', name, '--mail-nickname', name.replace(/[^\w-]/g, ''), ...(desc ? ['--description', desc] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Tipo de grupo">
          <span>Seguridad</span>
        </Field>
        <Field label="Nombre del grupo" required>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Descripción">
          <TextInput value={desc} onChange={setDesc} />
        </Field>
        <Callout>Asigna roles de Azure a grupos en lugar de a usuarios individuales: es más fácil de mantener cuando las personas cambian de equipo.</Callout>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name} onClick={() => run(async () => (await portalAction('Crear grupo', args, { success: `Grupo ${name} creado` })) && closePane())}>
          Crear
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function Users() {
  const s = useCloud();
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const list = s.users.filter((u) => (u.displayName + u.userPrincipalName).toLowerCase().includes(q.toLowerCase()));
  const del = async () => {
    if (sel.includes(s.me.objectId)) return alert('No puedes eliminar tu propio usuario.');
    if (!(await confirmDialog({ title: 'Eliminar usuarios', message: `¿Eliminar ${sel.length} usuario(s)? Perderán sus asignaciones de roles.`, confirmText: 'Eliminar', danger: true }))) return;
    for (const id of sel) await portalAction('Eliminar usuario', ['ad', 'user', 'delete', '--id', id], { quiet: true });
    setSel([]);
  };
  return (
    <>
      <CommandBar
        items={[
          { label: 'Nuevo usuario', icon: 'add', onClick: () => openPane({ title: 'Crear nuevo usuario', render: () => <NewUser /> }) },
          { label: 'Eliminar', icon: 'delete', disabled: !sel.length, onClick: del },
        ]}
      />
      <input className="input" style={{ maxWidth: 320, marginBottom: 10 }} placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
      <DataTable
        rows={list}
        rowKey={(u) => u.id}
        selectable
        selected={sel}
        onSelect={setSel}
        columns={[
          { key: 'n', title: 'Nombre para mostrar', render: (u) => <b>{u.displayName}</b>, sort: (u) => u.displayName },
          { key: 'u', title: 'Nombre principal de usuario', render: (u) => u.userPrincipalName },
          { key: 't', title: 'Tipo de usuario', render: (u) => (u.userType === 'Member' ? 'Miembro' : 'Invitado') },
          { key: 'j', title: 'Puesto', render: (u) => u.jobTitle ?? '' },
          { key: 'g', title: 'Grupos', render: (u) => s.groups.filter((g) => g.members.includes(u.id)).map((g) => g.displayName).join(', ') },
          { key: 'r', title: 'Roles de Azure', render: (u) => listRoleAssignments({ assignee: u.id }).length },
        ]}
      />
    </>
  );
}

function GroupMembers({ groupId }: { groupId: string }) {
  const s = useCloud();
  const g = s.groups.find((x) => x.id === groupId);
  const [add, setAdd] = useState('');
  if (!g) return null;
  const candidates = [...s.users.map((u) => ({ id: u.id, label: `${u.displayName} (${u.userPrincipalName})` })), ...s.servicePrincipals.map((x) => ({ id: x.id, label: `${x.displayName} (entidad de servicio)` }))].filter((c) => !g.members.includes(c.id));
  const name = (id: string) => s.users.find((u) => u.id === id)?.displayName ?? s.servicePrincipals.find((x) => x.id === id)?.displayName ?? s.groups.find((x) => x.id === id)?.displayName ?? id;
  return (
    <div className="pane-body">
      <h3 className="section-title">Miembros ({g.members.length})</h3>
      <DataTable
        rows={g.members}
        rowKey={(id) => id}
        columns={[
          { key: 'n', title: 'Nombre', render: (id) => name(id) },
          { key: 'x', title: '', render: (id) => <button className="btn small" onClick={() => portalAction('Quitar miembro', ['ad', 'group', 'member', 'remove', '-g', g.id, '--member-id', id], { success: 'Miembro quitado' })}>Quitar</button> },
        ]}
        empty="El grupo no tiene miembros."
      />
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Select value={add} onChange={setAdd} options={[{ value: '', label: 'Agregar miembro...' }, ...candidates.map((c) => ({ value: c.id, label: c.label }))]} />
        </div>
        <button className="btn primary" disabled={!add} onClick={() => portalAction('Agregar miembro', ['ad', 'group', 'member', 'add', '-g', g.id, '--member-id', add], { success: 'Miembro agregado' }).then(() => setAdd(''))}>
          Agregar
        </button>
      </div>
      <h3 className="section-title">Roles de Azure asignados al grupo</h3>
      <DataTable rows={listRoleAssignments({ assignee: g.id })} rowKey={(a) => a.id} columns={[{ key: 'r', title: 'Rol', render: (a) => a.roleDefinitionName }, { key: 's', title: 'Ámbito', render: (a) => <span className="mono small">{a.scope}</span> }]} empty="Sin roles asignados." />
    </div>
  );
}

function Groups() {
  const s = useCloud();
  return (
    <>
      <CommandBar items={[{ label: 'Nuevo grupo', icon: 'add', onClick: () => openPane({ title: 'Nuevo grupo', render: () => <NewGroup /> }) }]} />
      <DataTable
        rows={s.groups}
        rowKey={(g) => g.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (g) => <a onClick={() => openPane({ title: g.displayName, subtitle: 'Grupo de seguridad', render: () => <GroupMembers groupId={g.id} /> })}>{g.displayName}</a> },
          { key: 'd', title: 'Descripción', render: (g) => g.description ?? '' },
          { key: 'm', title: 'Miembros', render: (g) => g.members.length },
          { key: 'c', title: 'Creado', render: (g) => relTime(g.createdAt) },
          { key: 'x', title: '', render: (g) => <button className="btn small" onClick={async () => (await confirmDialog({ title: 'Eliminar grupo', message: `¿Eliminar ${g.displayName}?`, confirmText: 'Eliminar', danger: true })) && portalAction('Eliminar grupo', ['ad', 'group', 'delete', '-g', g.id], { success: 'Grupo eliminado' })}>Eliminar</button> },
        ]}
        empty="No hay grupos."
      />
    </>
  );
}

function AppDetails({ appId }: { appId: string }) {
  const s = useCloud();
  const app = s.apps.find((a) => a.appId === appId);
  const [secret, setSecret] = useState<string | null>(null);
  if (!app) return null;
  return (
    <div className="pane-body">
      <Essentials
        left={[
          ['Id. de aplicación (cliente)', app.appId],
          ['Id. de objeto', app.id],
        ]}
        right={[
          ['Id. de directorio (inquilino)', s.tenant.id],
          ['Creada', formatDate(app.createdAt)],
        ]}
      />
      <h3 className="section-title">Certificados y secretos</h3>
      <DataTable rows={app.passwordCredentials} rowKey={(c) => c.keyId} columns={[{ key: 'd', title: 'Descripción', render: (c) => c.displayName }, { key: 'h', title: 'Valor', render: (c) => `${c.hint}••••••••` }, { key: 'e', title: 'Expira', render: (c) => formatDate(c.endDateTime) }]} empty="Sin secretos de cliente." />
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button
          className="btn"
          onClick={async () => {
            const r = await portalAction('Nuevo secreto de cliente', ['ad', 'app', 'credential', 'reset', '--id', app.appId, '--append', '--display-name', 'portal'], { quiet: true });
            if (r?.json?.password) setSecret(r.json.password);
          }}
        >
          Nuevo secreto de cliente
        </button>
      </div>
      {secret ? (
        <Callout kind="warn" title="Copia el valor ahora: no se volverá a mostrar">
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <span className="mono">{secret}</span>
            <CopyButton text={secret} />
          </div>
        </Callout>
      ) : null}
      <h3 className="section-title">Credenciales federadas</h3>
      <DataTable rows={app.federatedCredentials} rowKey={(f) => f.name} columns={[{ key: 'n', title: 'Nombre', render: (f) => f.name }, { key: 'i', title: 'Emisor', render: (f) => <span className="small">{f.issuer}</span> }, { key: 's', title: 'Sujeto', render: (f) => <span className="small">{f.subject}</span> }]} empty="Sin credenciales federadas (OIDC)." />
    </div>
  );
}

function Apps() {
  const s = useCloud();
  const [name, setName] = useState('');
  return (
    <>
      <Callout>
        Un <b>registro de aplicación</b> define una identidad para una aplicación (id. de cliente). Su <b>entidad de servicio</b> (aplicación empresarial) es la que recibe roles en Azure. Los pipelines usan entidades de servicio para desplegar (conexiones de servicio).
      </Callout>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 300 }} placeholder="Nombre de la nueva aplicación" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name} onClick={() => portalAction('Registrar aplicación', ['ad', 'app', 'create', '--display-name', name], { success: `Aplicación ${name} registrada` }).then(() => setName(''))}>
          Nuevo registro
        </button>
      </div>
      <DataTable
        rows={s.apps}
        rowKey={(a) => a.id}
        columns={[
          { key: 'n', title: 'Nombre para mostrar', render: (a) => <a onClick={() => openPane({ title: a.displayName, subtitle: 'Registro de aplicación', width: 680, render: () => <AppDetails appId={a.appId} /> })}>{a.displayName}</a> },
          { key: 'i', title: 'Id. de aplicación (cliente)', render: (a) => <span className="mono small">{a.appId}</span> },
          { key: 'c', title: 'Creada', render: (a) => relTime(a.createdAt) },
          { key: 's', title: 'Secretos', render: (a) => a.passwordCredentials.length },
          { key: 'x', title: '', render: (a) => <button className="btn small" onClick={async () => (await confirmDialog({ title: 'Eliminar aplicación', message: `¿Eliminar ${a.displayName} y su entidad de servicio?`, confirmText: 'Eliminar', danger: true })) && portalAction('Eliminar aplicación', ['ad', 'app', 'delete', '--id', a.appId], { success: 'Aplicación eliminada' })}>Eliminar</button> },
        ]}
        empty="No hay registros de aplicaciones."
      />
      <div style={{ marginTop: 14 }}>
        <CliBox cmd={`az ad sp create-for-rbac --name sp-pipeline --role Contributor --scopes /subscriptions/${s.currentSubscriptionId}/resourceGroups/<grupo>`} />
      </div>
    </>
  );
}

function EnterpriseApps() {
  const s = useCloud();
  const [filter, setFilter] = useState('all');
  const list = s.servicePrincipals.filter((x) => filter === 'all' || (filter === 'mi' ? x.servicePrincipalType === 'ManagedIdentity' : x.servicePrincipalType === 'Application'));
  return (
    <>
      <div style={{ width: 280, marginBottom: 10 }}>
        <Select
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todas las aplicaciones' },
            { value: 'app', label: 'Aplicaciones' },
            { value: 'mi', label: 'Identidades administradas' },
          ]}
        />
      </div>
      <DataTable
        rows={list}
        rowKey={(x) => x.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (x) => <b>{x.displayName}</b> },
          { key: 't', title: 'Tipo', render: (x) => (x.servicePrincipalType === 'ManagedIdentity' ? 'Identidad administrada' : 'Aplicación') },
          { key: 'a', title: 'Id. de aplicación', render: (x) => <span className="mono small">{x.appId}</span> },
          { key: 'o', title: 'Id. de objeto', render: (x) => <span className="mono small">{x.id}</span> },
          { key: 'r', title: 'Roles de Azure', render: (x) => listRoleAssignments({ assignee: x.id }).map((a) => a.roleDefinitionName).join(', ') || '—' },
        ]}
        empty="No hay entidades de servicio."
      />
    </>
  );
}

function Overview() {
  const s = useCloud();
  return (
    <>
      <Essentials
        left={[
          ['Nombre', s.tenant.displayName],
          ['Id. de inquilino', s.tenant.id],
          ['Dominio principal', s.tenant.domain],
        ]}
        right={[
          ['Usuarios', String(s.users.length)],
          ['Grupos', String(s.groups.length)],
          ['Aplicaciones', String(s.apps.length)],
        ]}
      />
      <Callout>
        Microsoft Entra ID (antes Azure Active Directory) es el servicio de identidad de Azure: <b>autentica</b> (quién eres). Los roles de Azure (RBAC) <b>autorizan</b> (qué puedes hacer) sobre suscripciones, grupos de recursos y recursos.
      </Callout>
    </>
  );
}

export function EntraPage({ section }: { section: string }) {
  const menu: MenuItem[] = [
    { id: 'overview', label: 'Información general', icon: 'overview' },
    { id: 'users', label: 'Usuarios', icon: 'people', group: 'Administrar' },
    { id: 'groups', label: 'Grupos', icon: 'people', group: 'Administrar' },
    { id: 'apps', label: 'Registros de aplicaciones', icon: 'key', group: 'Administrar' },
    { id: 'enterprise', label: 'Aplicaciones empresariales', icon: 'all', group: 'Administrar' },
  ];
  const body = section === 'users' ? <Users /> : section === 'groups' ? <Groups /> : section === 'apps' ? <Apps /> : section === 'enterprise' ? <EnterpriseApps /> : <Overview />;
  return (
    <BladeLayout crumbs={[{ label: 'Inicio', href: '#/' }, { label: 'Microsoft Entra ID' }]} icon="entra" title="Microsoft Entra ID" subtitle="Inquilino" menu={menu} active={section || 'overview'} hrefFor={(id) => `#/entra${id === 'overview' ? '' : '/' + id}`}>
      {body}
    </BladeLayout>
  );
}

export const _unused = { Checkbox };
