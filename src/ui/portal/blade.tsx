// Piezas comunes de los blades: cabecera, menú, información esencial y secciones genéricas
// (registro de actividad, IAM, etiquetas, bloqueos, JSON).
import { useMemo, useState, type ReactNode } from 'react';
import { useCloud, navigate, resourceHref } from '../hooks';
import { openPane, closePane } from '../uiStore';
import { Icon, ServiceIcon } from '../components/Icons';
import { CliBox, Callout, CommandBar, DataTable, Field, JsonView, KeyValueEditor, Radio, Select, TextInput, confirmDialog, useAsync } from '../components/common';
import { portalAction, cliText } from './../portalCli';
import { terminal, openUrl } from '../terminal/controller';
import type { EssentialValue } from '../../engine/registry';
import { listRoleAssignments, principalDisplay } from '../../engine/services/identity';
import { allRoleDefinitions, locksAffecting } from '../../engine/arm';
import { isWithinScope, parseResourceId } from '../../engine/ids';
import { formatDate, relTime } from '../../engine/util';

// ---------------------------------------------------------------- estructura

export interface MenuItem {
  id: string;
  label: string;
  icon: string;
  group?: string;
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <div className="breadcrumb">
      {items.map((c, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
          {i < items.length - 1 ? <Icon name="chevron" size={10} /> : null}
        </span>
      ))}
    </div>
  );
}

export function BladeLayout({
  crumbs,
  icon,
  title,
  subtitle,
  menu,
  active,
  hrefFor,
  children,
}: {
  crumbs: { label: string; href?: string }[];
  icon: string;
  title: string;
  subtitle: string;
  menu: MenuItem[];
  active: string;
  hrefFor: (id: string) => string;
  children: ReactNode;
}) {
  const [filter, setFilter] = useState('');
  let lastGroup: string | undefined = '';
  const items = menu.filter((m) => !filter || m.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="blade-header">
        <Crumbs items={crumbs} />
        <div className="page-head" style={{ marginBottom: 10 }}>
          <ServiceIcon name={icon} size={34} />
          <div>
            <h1>
              {title}
              {menu.find((m) => m.id === active) && active !== 'overview' ? <span style={{ fontWeight: 400 }}> | {menu.find((m) => m.id === active)!.label}</span> : null}
            </h1>
            <div className="subtitle">{subtitle}</div>
          </div>
        </div>
      </div>
      <div className="blade" style={{ flex: 1, minHeight: 0 }}>
        <div className="blade-menu">
          <div className="filter">
            <input className="input" placeholder="Buscar" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {items.map((m) => {
            const head = m.group !== lastGroup && m.group ? <div className="blade-menu-group">{m.group}</div> : null;
            lastGroup = m.group;
            return (
              <div key={m.id}>
                {head}
                <a className={`blade-menu-item${m.id === active ? ' active' : ''}`} href={hrefFor(m.id)}>
                  <Icon name={m.icon} style={{ color: 'var(--accent)' }} />
                  {m.label}
                </a>
              </div>
            );
          })}
        </div>
        <div className="blade-body">{children}</div>
      </div>
    </div>
  );
}

export function EssentialValueView({ v }: { v: EssentialValue }) {
  if (typeof v === 'string') return <>{v}</>;
  if (!v.link) return <>{v.text}</>;
  if (v.link.startsWith('/subscriptions/')) return <a href={resourceHref(v.link)}>{v.text}</a>;
  if (v.link.startsWith('#')) return <a href={v.link}>{v.text}</a>;
  return (
    <a onClick={() => openUrl(v.link!)} title="Abrir en el navegador simulado">
      {v.text}
    </a>
  );
}

export function Essentials({ left, right, onJson }: { left: [string, EssentialValue | ReactNode][]; right: [string, EssentialValue | ReactNode][]; onJson?: () => void }) {
  const [open, setOpen] = useState(true);
  const cell = (v: EssentialValue | ReactNode) => (typeof v === 'string' || (v && typeof v === 'object' && 'text' in (v as any)) ? <EssentialValueView v={v as EssentialValue} /> : (v as ReactNode));
  return (
    <>
      <div className="essentials-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevron'} size={12} /> Información esencial
        <span className="spacer" />
        {onJson ? (
          <a
            onClick={(e) => {
              e.stopPropagation();
              onJson();
            }}
            className="small"
            style={{ fontWeight: 400 }}
          >
            Vista JSON
          </a>
        ) : null}
      </div>
      {open ? (
        <div className="essentials">
          <div>
            {left.map(([k, v]) => (
              <div key={k} className="ess-row">
                <span className="k">{k}</span>
                <span className="v">{cell(v)}</span>
              </div>
            ))}
          </div>
          <div>
            {right.map(([k, v]) => (
              <div key={k} className="ess-row">
                <span className="k">{k}</span>
                <span className="v">{cell(v)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Caja con comandos de CLI equivalentes (didáctica) y botón para ejecutarlos en Cloud Shell. */
export function CliHints({ title = 'Hazlo también con Azure CLI', cmds }: { title?: string; cmds: { label: string; cmd: string }[] }) {
  if (!cmds.length) return null;
  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h3 className="row" style={{ gap: 8 }}>
        <Icon name="terminal" style={{ color: 'var(--accent)' }} /> {title}
      </h3>
      {cmds.map((c) => (
        <div key={c.cmd} style={{ marginBottom: 10 }}>
          <div className="muted small" style={{ marginBottom: 4 }}>
            {c.label}
          </div>
          <CliBox cmd={c.cmd} onRun={() => terminal.typeCommand(c.cmd)} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- registro de actividad

export function ActivitySection({ scope }: { scope: string }) {
  const s = useCloud();
  const [q, setQ] = useState('');
  const rows = useMemo(
    () =>
      s.activityLog
        .filter((e) => isWithinScope(e.resourceId, scope) || e.resourceId.toLowerCase() === scope.toLowerCase())
        .filter((e) => !q || (e.operationName + e.caller + e.resourceId + e.status).toLowerCase().includes(q.toLowerCase()))
        .slice()
        .reverse()
        .slice(0, 300),
    [s.activityLog.length, scope, q],
  );
  const [sel, setSel] = useState<string | null>(null);
  const cur = rows.find((r) => r.id === sel);
  return (
    <>
      <Callout>El registro de actividad muestra las operaciones de escritura (PUT, POST, DELETE) realizadas sobre los recursos: quién, qué y cuándo. Las lecturas no se registran.</Callout>
      <div className="list-toolbar">
        <input className="input" placeholder="Buscar operación, usuario o recurso" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">{rows.length} eventos</span>
      </div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => setSel(r.id === sel ? null : r.id)}
        columns={[
          { key: 'op', title: 'Nombre de la operación', render: (r) => r.operationName },
          { key: 'st', title: 'Estado', render: (r) => <span className={`pill ${r.status === 'Succeeded' ? 'ok' : r.status === 'Failed' ? 'bad' : 'info'}`}>{r.status === 'Succeeded' ? 'Correcto' : r.status === 'Failed' ? 'Error' : r.status}</span> },
          { key: 't', title: 'Hora', render: (r) => <span title={formatDate(r.time)}>{relTime(r.time)}</span> },
          { key: 'res', title: 'Recurso', render: (r) => r.resourceId.split('/').pop() },
          { key: 'c', title: 'Iniciado por', render: (r) => r.caller },
        ]}
        empty="No hay eventos en el registro de actividad para este ámbito."
      />
      {cur ? (
        <div style={{ marginTop: 14 }}>
          <JsonView value={cur} />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- IAM

const PRIVILEGED = ['Owner', 'Contributor', 'User Access Administrator', 'Role Based Access Control Administrator'];

function AddRoleAssignment({ scope, subscriptionId }: { scope: string; subscriptionId: string }) {
  const s = useCloud();
  const [step, setStep] = useState<'role' | 'members' | 'review'>('role');
  const [roleQ, setRoleQ] = useState('');
  const [privileged, setPrivileged] = useState(false);
  const [role, setRole] = useState<string>('');
  const [kind, setKind] = useState<'principal' | 'mi'>('principal');
  const [memberQ, setMemberQ] = useState('');
  const [member, setMember] = useState<{ id: string; name: string; type: string } | null>(null);
  const { busy, run } = useAsync();
  const roles = allRoleDefinitions().filter((r) => (privileged ? PRIVILEGED.includes(r.roleName) : !PRIVILEGED.includes(r.roleName)) && (r.roleName + r.description).toLowerCase().includes(roleQ.toLowerCase()));
  const candidates = (
    kind === 'principal'
      ? [...s.users.map((u) => ({ id: u.id, name: u.displayName, sub: u.userPrincipalName, type: 'User' })), ...s.groups.map((g) => ({ id: g.id, name: g.displayName, sub: 'Grupo', type: 'Group' })), ...s.servicePrincipals.filter((x) => x.servicePrincipalType === 'Application').map((x) => ({ id: x.id, name: x.displayName, sub: `Aplicación · ${x.appId}`, type: 'ServicePrincipal' }))]
      : s.servicePrincipals.filter((x) => x.servicePrincipalType === 'ManagedIdentity').map((x) => ({ id: x.id, name: x.displayName, sub: 'Identidad administrada', type: 'ServicePrincipal' }))
  ).filter((c) => (c.name + c.sub).toLowerCase().includes(memberQ.toLowerCase()));
  const args = member ? ['role', 'assignment', 'create', '--assignee-object-id', member.id, '--assignee-principal-type', member.type, '--role', role, '--scope', scope] : [];
  return (
    <>
      <div className="pane-body">
        <div className="wizard-tabs">
          <button className={step === 'role' ? 'active' : ''} onClick={() => setStep('role')}>
            Rol
          </button>
          <button className={step === 'members' ? 'active' : ''} onClick={() => role && setStep('members')}>
            Miembros
          </button>
          <button className={step === 'review' ? 'active' : ''} onClick={() => role && member && setStep('review')}>
            Revisar y asignar
          </button>
        </div>
        {step === 'role' ? (
          <>
            <p className="muted">Una definición de rol es una colección de permisos. Elige el rol con los permisos mínimos necesarios (principio de mínimo privilegio).</p>
            <Radio
              value={privileged ? 'p' : 'j'}
              onChange={(v) => setPrivileged(v === 'p')}
              options={[
                { value: 'j', label: 'Roles de función de trabajo', help: 'Acceso a recursos concretos (lector, colaborador de un servicio...).' },
                { value: 'p', label: 'Roles de administrador con privilegios', help: 'Owner, Contributor, User Access Administrator: conceden mucho poder.' },
              ]}
            />
            <input className="input" placeholder="Buscar por nombre o descripción" value={roleQ} onChange={(e) => setRoleQ(e.target.value)} style={{ margin: '10px 0' }} />
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table className="grid">
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.id} className={role === r.roleName ? 'selected' : undefined} onClick={() => setRole(r.roleName)} style={{ cursor: 'pointer' }}>
                      <td style={{ width: 28 }}>
                        <input type="radio" checked={role === r.roleName} readOnly />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.roleName}</div>
                        <div className="muted small">{r.description}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : step === 'members' ? (
          <>
            <Field stack label="Asignar acceso a">
              <Radio
                value={kind}
                onChange={(v) => {
                  setKind(v);
                  setMember(null);
                }}
                options={[
                  { value: 'principal', label: 'Usuario, grupo o entidad de servicio' },
                  { value: 'mi', label: 'Identidad administrada' },
                ]}
              />
            </Field>
            <input className="input" placeholder="Buscar por nombre" value={memberQ} onChange={(e) => setMemberQ(e.target.value)} style={{ marginBottom: 10 }} />
            <div className="table-wrap" style={{ maxHeight: 340 }}>
              <table className="grid">
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id} className={member?.id === c.id ? 'selected' : undefined} onClick={() => setMember(c)} style={{ cursor: 'pointer' }}>
                      <td style={{ width: 28 }}>
                        <input type="radio" checked={member?.id === c.id} readOnly />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        <div className="muted small">{c.sub}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!candidates.length ? <div className="empty">No hay resultados.</div> : null}
            </div>
          </>
        ) : (
          <>
            <div className="review-group">
              <h4>Rol</h4>
              <div>{role}</div>
            </div>
            <div className="review-group">
              <h4>Ámbito</h4>
              <div className="mono small">{scope}</div>
            </div>
            <div className="review-group">
              <h4>Miembro</h4>
              <div>
                {member?.name} <span className="muted">({member?.type})</span>
              </div>
            </div>
            <div className="review-group">
              <h4>Comando equivalente</h4>
              <CliBox cmd={cliText(args)} />
            </div>
          </>
        )}
      </div>
      <div className="pane-foot">
        {step !== 'review' ? (
          <button className="btn primary" disabled={(step === 'role' && !role) || (step === 'members' && !member)} onClick={() => setStep(step === 'role' ? 'members' : 'review')}>
            Siguiente
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await portalAction('Agregar asignación de roles', args, { subscription: subscriptionId, success: `Se asignó el rol ${role} a ${member?.name}` });
                if (r) closePane();
              })
            }
          >
            {busy ? 'Asignando...' : 'Revisar y asignar'}
          </button>
        )}
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

export function IamSection({ scope, subscriptionId }: { scope: string; subscriptionId: string }) {
  const s = useCloud();
  const [tab, setTab] = useState<'assign' | 'roles' | 'check'>('assign');
  const [sel, setSel] = useState<string[]>([]);
  const [checkQ, setCheckQ] = useState('');
  const list = listRoleAssignments({ scope, includeInherited: true });
  const add = () => openPane({ title: 'Agregar asignación de roles', subtitle: scope, width: 640, render: () => <AddRoleAssignment scope={scope} subscriptionId={subscriptionId} /> });
  const remove = async () => {
    if (!sel.length) return;
    if (!(await confirmDialog({ title: 'Quitar asignaciones de roles', message: `¿Quitar ${sel.length} asignación(es) de roles?`, confirmText: 'Quitar', danger: true }))) return;
    const r = await portalAction('Quitar asignación de roles', ['role', 'assignment', 'delete', '--ids', ...sel], { subscription: subscriptionId });
    if (r) setSel([]);
  };
  const checked = checkQ ? [...s.users, ...s.groups.map((g) => ({ ...g, userPrincipalName: 'Grupo' }))].filter((u: any) => (u.displayName + u.userPrincipalName).toLowerCase().includes(checkQ.toLowerCase())).slice(0, 5) : [];
  return (
    <>
      <CommandBar
        items={[
          { label: 'Agregar asignación de roles', icon: 'add', onClick: add },
          { label: 'Quitar', icon: 'delete', onClick: remove, disabled: !sel.length || sel.some((id) => !list.find((a) => a.id === id && a.scope.toLowerCase() === scope.toLowerCase())) },
        ]}
      />
      <div className="tabs">
        {[
          ['check', 'Comprobar el acceso'],
          ['assign', 'Asignaciones de roles'],
          ['roles', 'Roles'],
        ].map(([id, l]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id as any)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'assign' ? (
        <>
          <p className="muted">
            Las asignaciones se heredan: un rol asignado en la suscripción o en el grupo de recursos se aplica también aquí (columna <i>Ámbito</i>).
          </p>
          <DataTable
            rows={list}
            rowKey={(a) => a.id}
            selectable
            selected={sel}
            onSelect={setSel}
            columns={[
              { key: 'n', title: 'Nombre', render: (a) => principalDisplay(a.principalId).name, sort: (a) => principalDisplay(a.principalId).name },
              { key: 't', title: 'Tipo', render: (a) => principalDisplay(a.principalId).type },
              { key: 'r', title: 'Rol', render: (a) => a.roleDefinitionName, sort: (a) => a.roleDefinitionName },
              { key: 's', title: 'Ámbito', render: (a) => (a.scope.toLowerCase() === scope.toLowerCase() ? 'Este recurso' : `${parseResourceId(a.scope).resourceGroup ? 'Grupo de recursos (heredado)' : 'Suscripción (heredado)'}`) },
            ]}
            empty="No hay asignaciones de roles en este ámbito."
          />
        </>
      ) : tab === 'roles' ? (
        <DataTable
          rows={allRoleDefinitions()}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', title: 'Nombre', render: (r) => <b>{r.roleName}</b>, sort: (r) => r.roleName },
            { key: 'd', title: 'Descripción', render: (r) => <span className="muted">{r.description}</span> },
            { key: 't', title: 'Tipo', render: (r) => (r.roleType === 'BuiltInRole' ? 'Integrado' : 'Personalizado') },
            { key: 'c', title: 'Asignaciones', render: (r) => list.filter((a) => a.roleDefinitionName === r.roleName).length },
          ]}
        />
      ) : (
        <>
          <p className="muted">Busca un usuario o grupo para ver qué roles tiene (directos o heredados) en este ámbito.</p>
          <input className="input" style={{ maxWidth: 360, marginBottom: 12 }} placeholder="Nombre o correo" value={checkQ} onChange={(e) => setCheckQ(e.target.value)} />
          {checked.map((u: any) => {
            const mine = list.filter((a) => a.principalId === u.id || s.groups.some((g) => g.id === a.principalId && g.members.includes(u.id)));
            return (
              <div key={u.id} className="card" style={{ marginBottom: 10 }}>
                <b>{u.displayName}</b> <span className="muted">{u.userPrincipalName}</span>
                <div style={{ marginTop: 6 }}>{mine.length ? mine.map((a) => <span key={a.id} className="tag">{a.roleDefinitionName}</span>) : <span className="muted">Sin acceso en este ámbito.</span>}</div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- etiquetas

export function TagsSection({ kind, id, name, tags, subscriptionId }: { kind: 'resource' | 'rg'; id: string; name: string; tags: Record<string, string>; subscriptionId: string }) {
  const [rows, setRows] = useState<[string, string][]>(Object.entries(tags ?? {}));
  const { busy, run } = useAsync();
  const valid = rows.filter(([k]) => k.trim());
  const tagArgs = valid.map(([k, v]) => `${k.trim()}=${v}`);
  const args = kind === 'rg' ? ['group', 'update', '-n', name, '--tags', ...(tagArgs.length ? tagArgs : [''])] : ['resource', 'tag', '--ids', id, '--tags', ...(tagArgs.length ? tagArgs : [''])];
  return (
    <>
      <p className="muted">Las etiquetas son pares nombre/valor que te permiten categorizar recursos y ver la facturación consolidada aplicando la misma etiqueta a varios recursos y grupos de recursos (p. ej. entorno=prod, proyecto=web).</p>
      <div style={{ maxWidth: 640 }}>
        <KeyValueEditor value={rows} onChange={setRows} />
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={() => run(() => portalAction('Actualizar etiquetas', args, { subscription: subscriptionId, success: 'Etiquetas actualizadas' }))}>
          Aplicar
        </button>
        <button className="btn" onClick={() => setRows(Object.entries(tags ?? {}))}>
          Descartar cambios
        </button>
      </div>
      <div style={{ marginTop: 18, maxWidth: 760 }}>
        <div className="muted small" style={{ marginBottom: 4 }}>
          Comando equivalente
        </div>
        <CliBox cmd={cliText(args)} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- bloqueos

function AddLock({ scope, subscriptionId }: { scope: string; subscriptionId: string }) {
  const [name, setName] = useState('');
  const [level, setLevel] = useState<'CanNotDelete' | 'ReadOnly'>('CanNotDelete');
  const [notes, setNotes] = useState('');
  const { busy, run } = useAsync();
  const p = parseResourceId(scope);
  const target = p.name ? ['--resource', scope] : p.resourceGroup ? ['-g', p.resourceGroup] : [];
  const args = ['lock', 'create', '-n', name, '--lock-type', level, ...target, ...(notes ? ['--notes', notes] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre del bloqueo" required>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Tipo de bloqueo" required>
          <Select
            value={level}
            onChange={(v) => setLevel(v as any)}
            options={[
              { value: 'CanNotDelete', label: 'Eliminar (CanNotDelete)' },
              { value: 'ReadOnly', label: 'Solo lectura (ReadOnly)' },
            ]}
          />
        </Field>
        <Field label="Notas">
          <TextInput value={notes} onChange={setNotes} />
        </Field>
        <Callout>
          <b>Eliminar</b>: se puede leer y modificar, pero no borrar. <b>Solo lectura</b>: no se puede ni modificar ni borrar. Los bloqueos se heredan y se aplican a todos, incluidos los propietarios (Owner).
        </Callout>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button
          className="btn primary"
          disabled={!name || busy}
          onClick={() =>
            run(async () => {
              if (await portalAction('Crear bloqueo', args, { subscription: subscriptionId, success: `Bloqueo "${name}" creado` })) closePane();
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

export function LocksSection({ scope, subscriptionId }: { scope: string; subscriptionId: string }) {
  useCloud();
  const locks = locksAffecting(scope);
  return (
    <>
      <CommandBar items={[{ label: 'Agregar', icon: 'add', onClick: () => openPane({ title: 'Agregar bloqueo', render: () => <AddLock scope={scope} subscriptionId={subscriptionId} /> }) }]} />
      <p className="muted">Los bloqueos de administración evitan que otros usuarios borren o modifiquen por error recursos críticos.</p>
      <DataTable
        rows={locks}
        rowKey={(l) => l.id}
        columns={[
          { key: 'n', title: 'Nombre del bloqueo', render: (l) => <b>{l.name}</b> },
          { key: 't', title: 'Tipo', render: (l) => (l.level === 'CanNotDelete' ? 'Eliminar' : 'Solo lectura') },
          { key: 's', title: 'Ámbito', render: (l) => (l.scope.toLowerCase() === scope.toLowerCase() ? 'Este recurso' : parseResourceId(l.scope).name ?? parseResourceId(l.scope).resourceGroup ?? 'Suscripción') },
          { key: 'no', title: 'Notas', render: (l) => l.notes ?? '' },
          {
            key: 'a',
            title: '',
            render: (l) =>
              l.scope.toLowerCase() === scope.toLowerCase() ? (
                <button className="btn small" onClick={() => portalAction('Eliminar bloqueo', ['lock', 'delete', '--ids', l.id], { subscription: subscriptionId, success: 'Bloqueo eliminado' })}>
                  Eliminar
                </button>
              ) : (
                <span className="muted small">Heredado</span>
              ),
          },
        ]}
        empty="Este recurso no tiene bloqueos."
      />
    </>
  );
}

export function JsonSection({ obj, title = 'Vista JSON del recurso' }: { obj: any; title?: string }) {
  return (
    <>
      <p className="muted">{title}: es la representación del recurso en Azure Resource Manager (lo que devuelve la API REST y <code>az resource show</code>).</p>
      <JsonView value={obj} maxHeight={640} />
    </>
  );
}

export function goResource(id: string) {
  navigate(resourceHref(id).slice(1));
}
