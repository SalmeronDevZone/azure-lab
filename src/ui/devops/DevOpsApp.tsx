// Portal de Azure DevOps simulado.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCloud, navigate, useRoute, useTick } from '../hooks';
import { setUi, toast, openPane, closePane, useUi } from '../uiStore';
import { Icon, ServiceIcon } from '../components/Icons';
import { Callout, CliBox, CodeBlock, CopyButton, DataTable, Empty, Field, Select, TextInput, Checkbox, confirmDialog, Radio, initials } from '../components/common';
import type { DevOpsProject, DevOpsRepo, GitCommit, PipelineRun, PullRequest, RunJob, RunStage, RunStatus, ServiceConnection, WorkItem } from '../../engine/types';
import {
  approveStage, cancelRun, rerunFailedStages, linkWorkItems, unlinkWorkItem, branchProtected, commitFile, completePullRequest, createAcrConnection, createAzureRmConnection, createBranch, createEnvironment, createKubernetesConnection, createPipeline, createProject, createPullRequest, createRepo, createWorkItem, deleteProject, filesAt, importTemplate, org, orgUrl, prPolicyStatus, queueRun, repoUrl, TEMPLATES,
} from '../../engine/services/devops';
import { changed, getState, portalPrincipal } from '../../engine/store';
import { formatDate, relTime, guid } from '../../engine/util';
import { readZip } from '../../shell/fs';
import { compilePipeline, pipelineParameters, type CompiledPipeline } from '../../shell/pipelines';

// ---------------------------------------------------------------- utilidades

function act(fn: () => unknown, ok?: string): boolean {
  try {
    fn();
    if (ok) toast(ok, 'success');
    return true;
  } catch (e: any) {
    toast('Error', 'error', String(e?.message ?? e));
    return false;
  }
}

const me = () => getState().me.displayName;
const pHref = (p: DevOpsProject, rest = '') => `#/devops/${encodeURIComponent(p.name)}${rest}`;
const COLORS = ['#0078d4', '#8764b8', '#107c10', '#ca5010', '#038387', '#c239b3', '#4f6bed'];
const projColor = (p: DevOpsProject) => COLORS[p.name.charCodeAt(0) % COLORS.length];

export function RunStatusIcon({ status, size = 16 }: { status: RunStatus | string; size?: number }) {
  const sym: Record<string, string> = { succeeded: '✓', failed: '✕', canceled: '⊘', skipped: '−', running: '', waiting: '⏸', queued: '', notStarted: '', succeededWithIssues: '!' };
  return (
    <span className={`status-icon ${status}`} style={{ width: size, height: size }}>
      {status === 'running' ? <span className="spinner" style={{ width: size - 4, height: size - 4, borderWidth: 2, borderColor: 'rgba(255,255,255,.35)', borderTopColor: '#fff' }} /> : sym[status] ?? ''}
    </span>
  );
}

const STATUS_ES: Record<string, string> = { succeeded: 'Correcto', failed: 'Error', canceled: 'Cancelado', skipped: 'Omitido', running: 'En ejecución', waiting: 'Esperando aprobación', queued: 'En cola', notStarted: 'No iniciado', succeededWithIssues: 'Correcto con advertencias' };

function duration(a?: string, b?: string) {
  if (!a) return '';
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ---------------------------------------------------------------- inicio de la organización

function OrgHome() {
  const s = useCloud();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <div className="ado-body">
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{org()}</h1>
      <div className="muted" style={{ marginBottom: 18 }}>
        {orgUrl()}
      </div>
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Proyectos</h2>
          {!s.devops.projects.length ? (
            <div className="card muted">Todavía no hay proyectos. Un proyecto agrupa repositorios, pipelines, tableros y entornos de un equipo.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px,1fr))', gap: 12 }}>
              {s.devops.projects.map((p) => (
                <a key={p.id} className="card" href={pHref(p)} style={{ color: 'var(--text)', textDecoration: 'none', display: 'flex', gap: 12 }}>
                  <span className="proj-icon" style={{ background: projColor(p) }}>
                    {p.name[0].toUpperCase()}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <b>{p.name}</b>
                    <div className="muted small">{p.description || `${p.repos.length} repos · ${p.pipelines.length} pipelines`}</div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Crear un proyecto</h3>
          <Field stack label="Nombre del proyecto" required>
            <TextInput value={name} onChange={setName} />
          </Field>
          <Field stack label="Descripción">
            <TextInput value={desc} onChange={setDesc} />
          </Field>
          <div className="muted small" style={{ marginBottom: 10 }}>
            Visibilidad: privado · Control de versiones: Git · Proceso: Agile
          </div>
          <button
            className="btn primary"
            disabled={!name}
            onClick={() => {
              if (act(() => createProject(name, desc, me()), `Proyecto ${name} creado`)) navigate(`/devops/${encodeURIComponent(name)}`);
            }}
          >
            Crear
          </button>
          <div style={{ marginTop: 14 }}>
            <CliBox cmd={`az devops project create --name ${name || 'mi-proyecto'} --org ${orgUrl()}`} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- resumen del proyecto

function ProjectSummary({ p }: { p: DevOpsProject }) {
  useCloud();
  return (
    <div className="ado-body">
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="proj-icon" style={{ background: projColor(p), width: 44, height: 44, fontSize: 20 }}>
          {p.name[0].toUpperCase()}
        </span>
        <div>
          <h1 style={{ fontSize: 22 }}>{p.name}</h1>
          <div className="muted">{p.description || 'Sin descripción'}</div>
        </div>
        <span className="spacer" />
        <button
          className="btn"
          onClick={async () => {
            if (await confirmDialog({ title: 'Eliminar proyecto', message: `Se eliminarán repositorios, pipelines y ejecuciones de ${p.name}.`, confirmText: 'Eliminar', danger: true, requireText: p.name })) {
              act(() => deleteProject(p.name), 'Proyecto eliminado');
              navigate('/devops');
            }
          }}
        >
          Eliminar proyecto
        </button>
      </div>
      <div className="grid3" style={{ marginBottom: 18 }}>
        {[
          ['git', 'Repos', p.repos.length, '/repos'],
          ['pipeline', 'Pipelines', p.pipelines.length, '/pipelines'],
          ['boards', 'Elementos de trabajo', p.workItems.length, '/boards'],
        ].map(([icon, label, n, href]) => (
          <a key={label as string} className="card" href={pHref(p, href as string)} style={{ color: 'var(--text)', textDecoration: 'none' }}>
            <div className="row">
              <Icon name={icon as string} size={22} style={{ color: 'var(--accent)' }} />
              <b>{label}</b>
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 6 }}>{n}</div>
          </a>
        ))}
      </div>
      <h2 style={{ fontSize: 16, marginBottom: 10 }}>Ejecuciones recientes</h2>
      <RunsTable p={p} runs={p.runs.slice(0, 8)} />
      <Callout>
        Flujo típico de DevOps: el código vive en <b>Repos</b> (Git), cada push dispara un <b>pipeline</b> de CI que compila y prueba, publica un <b>artefacto</b> y una fase de CD lo despliega en un <b>entorno</b> (dev, prod) con <b>aprobaciones</b>. Los <b>Boards</b> organizan el trabajo.
      </Callout>
    </div>
  );
}

// ---------------------------------------------------------------- Boards

function Boards({ p }: { p: DevOpsProject }) {
  useCloud();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'User Story' | 'Task' | 'Bug' | 'Epic'>('User Story');
  const cols: ('New' | 'Active' | 'Resolved' | 'Closed')[] = ['New', 'Active', 'Resolved', 'Closed'];
  const label: Record<string, string> = { New: 'Nuevo', Active: 'Activo', Resolved: 'Resuelto', Closed: 'Cerrado' };
  const move = (id: number, dir: 1 | -1) => {
    const wi = p.workItems.find((w) => w.id === id)!;
    const i = cols.indexOf(wi.state);
    wi.state = cols[Math.max(0, Math.min(cols.length - 1, i + dir))];
    changed();
  };
  return (
    <div className="ado-body">
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Tablero</h1>
      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <div style={{ width: 160 }}>
          <Select value={type} onChange={(v) => setType(v as any)} options={['User Story', 'Task', 'Bug', 'Epic']} />
        </div>
        <input className="input" style={{ maxWidth: 380 }} placeholder="Título del nuevo elemento de trabajo" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title && act(() => createWorkItem(p, type, title, me())) && setTitle('')} />
        <button className="btn primary" disabled={!title} onClick={() => act(() => createWorkItem(p, type, title, me())) && setTitle('')}>
          Nuevo elemento
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
        {cols.map((c) => (
          <div key={c} style={{ background: 'var(--surface-2)', borderRadius: 4, padding: 10, minHeight: 300 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {label[c]} <span className="muted">({p.workItems.filter((w) => w.state === c).length})</span>
            </div>
            {p.workItems
              .filter((w) => w.state === c)
              .map((w) => (
                <div key={w.id} className="card" style={{ marginBottom: 8, padding: 10, borderLeft: `4px solid ${w.type === 'Bug' ? '#cc293d' : w.type === 'Task' ? '#f2cb1d' : w.type === 'Epic' ? '#ff7b00' : '#009ccc'}` }}>
                  <div className="small muted">
                    {w.type} #{w.id}
                  </div>
                  <div style={{ fontWeight: 600 }}>{w.title}</div>
                  {w.links?.length ? (
                    <div className="small" style={{ marginTop: 4 }} title={w.links.map((l) => (l.kind === 'pr' ? `PR !${l.id}: ${l.title}` : `Commit ${l.id.slice(0, 7)}: ${l.title}`)).join('\n')}>
                      {w.links
                        .filter((l) => l.kind === 'pr')
                        .map((l) => (
                          <a key={l.id} style={{ marginRight: 6 }} href={`#/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(l.repo ?? p.name)}/prs/${l.id}`}>
                            ⤴ PR !{l.id}
                          </a>
                        ))}
                      {w.links.some((l) => l.kind === 'commit') ? <span className="muted">· {w.links.filter((l) => l.kind === 'commit').length} commit(s)</span> : null}
                    </div>
                  ) : null}
                  <div className="row small" style={{ marginTop: 6 }}>
                    <span className="muted">{w.assignedTo ?? 'Sin asignar'}</span>
                    <span className="spacer" />
                    <button className="btn small" disabled={c === 'New'} onClick={() => move(w.id, -1)}>
                      ←
                    </button>
                    <button className="btn small" disabled={c === 'Closed'} onClick={() => move(w.id, 1)}>
                      →
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Repos

function commitsOf(repo: DevOpsRepo, ref: string): GitCommit[] {
  const out: GitCommit[] = [];
  const seen = new Set<string>();
  const queue = [repo.branches[ref] ?? ref];
  while (queue.length && out.length < 200) {
    const id = queue.shift()!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const c = repo.commits[id];
    if (!c) continue;
    out.push(c);
    queue.push(...c.parents);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function changedFiles(repo: DevOpsRepo, c: GitCommit): { path: string; kind: 'add' | 'edit' | 'delete' }[] {
  const prev = c.parents[0] ? repo.commits[c.parents[0]]?.tree ?? {} : {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(c.tree)]);
  return [...keys].filter((k) => prev[k] !== c.tree[k]).map((k) => ({ path: k, kind: !(k in prev) ? 'add' : !(k in c.tree) ? 'delete' : 'edit' }));
}

function lineDiff(a: string, b: string): { t: ' ' | '+' | '-'; l: string }[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 400000) return [...A.map((l) => ({ t: '-' as const, l })), ...B.map((l) => ({ t: '+' as const, l }))];
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; l: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ t: ' ', l: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', l: A[i++] });
    else out.push({ t: '+', l: B[j++] });
  }
  while (i < n) out.push({ t: '-', l: A[i++] });
  while (j < m) out.push({ t: '+', l: B[j++] });
  return out;
}

function DiffView({ a, b }: { a: string; b: string }) {
  const d = lineDiff(a, b);
  return (
    <div className="code" style={{ padding: 0, maxHeight: 420 }}>
      {d.map((x, i) => (
        <div key={i} className={x.t === '+' ? 'diff-add' : x.t === '-' ? 'diff-del' : ''} style={{ padding: '0 10px' }}>
          {x.t} {x.l}
        </div>
      ))}
    </div>
  );
}

function RepoPicker({ p, repo, section }: { p: DevOpsProject; repo: DevOpsRepo; section: string }) {
  return (
    <div className="row" style={{ marginBottom: 14, gap: 8 }}>
      <Icon name="git" style={{ color: '#f05133' }} />
      <div style={{ width: 220 }}>
        <Select value={repo.name} onChange={(v) => navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(v)}/${section}`)} options={p.repos.map((r) => r.name)} />
      </div>
      <span className="spacer" />
      <button
        className="btn"
        onClick={() => {
          const n = prompt('Nombre del nuevo repositorio:');
          if (n && act(() => createRepo(p, n), `Repositorio ${n} creado`)) navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(n)}`);
        }}
      >
        Nuevo repositorio
      </button>
      <button className="btn primary" onClick={() => openPane({ title: 'Clonar repositorio', render: () => <ClonePane p={p} repo={repo} /> })}>
        Clonar
      </button>
    </div>
  );
}

function ClonePane({ p, repo }: { p: DevOpsProject; repo: DevOpsRepo }) {
  const url = repoUrl(p, repo);
  return (
    <div className="pane-body">
      <Field stack label="URL HTTPS">
        <div className="row">
          <input className="input mono" readOnly value={url} />
          <CopyButton text={url} />
        </div>
      </Field>
      <p className="muted small">En el simulador la autenticación con Azure Repos es automática desde tu Cloud Shell (usa tu cuenta {getState().me.upn}).</p>
      <CliBox cmd={`git clone ${url}`} />
    </div>
  );
}

function EmptyRepo({ p, repo }: { p: DevOpsProject; repo: DevOpsRepo }) {
  const [tpl, setTpl] = useState(Object.keys(TEMPLATES)[0]);
  const url = repoUrl(p, repo);
  return (
    <>
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>{repo.name} está vacío. Añade código.</h2>
      <h3 className="section-title">Clonar en tu equipo (Cloud Shell)</h3>
      <CliBox cmd={`git clone ${url}`} />
      <h3 className="section-title">Enviar un repositorio existente desde la línea de comandos</h3>
      <CodeBlock code={`git remote add origin ${url}\ngit push -u origin --all`} />
      <h3 className="section-title">Importar un repositorio</h3>
      <div className="row" style={{ gap: 8 }}>
        <div style={{ width: 360 }}>
          <Select value={tpl} onChange={setTpl} options={Object.entries(TEMPLATES).map(([k, t]) => ({ value: k, label: `https://github.com/azure-lab/${k} · ${t.label}` }))} />
        </div>
        <button className="btn primary" onClick={() => act(() => importTemplate(p, repo, `https://github.com/azure-lab/${tpl}`, me()), 'Repositorio importado')}>
          Importar
        </button>
      </div>
      <h3 className="section-title">Inicializar con un README</h3>
      <button className="btn" onClick={() => act(() => commitFile(p, repo, 'main', 'README.md', `# ${repo.name}\n\nProyecto creado en Azure Lab.\n`, 'Commit inicial', me()), 'Repositorio inicializado')}>
        Inicializar
      </button>
    </>
  );
}

function FilesView({ p, repo }: { p: DevOpsProject; repo: DevOpsRepo }) {
  const route = useRoute();
  useCloud();
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [editing, setEditing] = useState<{ path: string; text: string; isNew: boolean } | null>(null);
  const [msg, setMsg] = useState('');
  const path = route.query.get('path') ?? '';
  if (!Object.keys(repo.branches).length) return <EmptyRepo p={p} repo={repo} />;
  const tree = filesAt(repo, branch);
  const isFile = path in tree;
  const dir = isFile ? path.split('/').slice(0, -1).join('/') : path;
  const prefix = dir ? dir + '/' : '';
  const entries = new Map<string, boolean>();
  for (const k of Object.keys(tree)) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const first = rest.split('/')[0];
    entries.set(first, rest.includes('/') || entries.get(first) === true);
  }
  const go = (pth: string) => navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(repo.name)}/files?path=${encodeURIComponent(pth)}`);
  const head = repo.commits[repo.branches[branch]];
  const save = () => {
    if (!editing) return;
    if (act(() => commitFile(p, repo, branch, editing.path, editing.text, msg || `Actualizar ${editing.path}`, me()), `Commit en ${branch}`)) {
      setEditing(null);
      setMsg('');
      go(editing.path);
    }
  };
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <Icon name="branch" />
        <div style={{ width: 200 }}>
          <Select value={branch} onChange={setBranch} options={Object.keys(repo.branches)} />
        </div>
        <span className="muted small">
          / <a onClick={() => go('')}>{repo.name}</a>
          {(isFile ? path : dir)
            .split('/')
            .filter(Boolean)
            .map((seg, i, arr) => (
              <span key={i}>
                {' / '}
                <a onClick={() => go(arr.slice(0, i + 1).join('/'))}>{seg}</a>
              </span>
            ))}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => setEditing({ path: prefix + 'nuevo-fichero.txt', text: '', isNew: true })}>
          + Nuevo fichero
        </button>
      </div>
      {head ? (
        <div className="card small" style={{ marginBottom: 10, padding: '8px 12px' }}>
          Último commit: <b>{head.message.split('\n')[0]}</b> · <span className="mono">{head.id.slice(0, 8)}</span> · {head.author} · {relTime(head.date)}
        </div>
      ) : null}
      {editing ? (
        <div className="card">
          <Field stack label="Ruta del fichero">
            <TextInput value={editing.path} onChange={(v) => setEditing({ ...editing, path: v })} mono disabled={!editing.isNew} />
          </Field>
          <textarea className="textarea" rows={22} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input className="input" placeholder={`Mensaje del commit (Actualizar ${editing.path})`} value={msg} onChange={(e) => setMsg(e.target.value)} />
            <button className="btn primary" onClick={save}>
              Confirmar (commit)
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </div>
          {repo.policies && branch === repo.defaultBranch ? <div className="muted small" style={{ marginTop: 6 }}>⚠️ La rama {branch} está protegida por directivas: tendrás que hacer el cambio en otra rama y abrir un pull request.</div> : null}
        </div>
      ) : isFile ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <Icon name="file" />
            <b>{path.split('/').pop()}</b>
            <span className="spacer" />
            <button className="btn small" onClick={() => setEditing({ path, text: tree[path], isNew: false })}>
              Editar
            </button>
            <button className="btn small" onClick={async () => (await confirmDialog({ title: 'Eliminar fichero', message: `¿Eliminar ${path} en ${branch}?`, confirmText: 'Eliminar', danger: true })) && act(() => commitFile(p, repo, branch, path, null, `Eliminar ${path}`, me()), 'Fichero eliminado') && go(dir)}>
              Eliminar
            </button>
          </div>
          <div className="code" style={{ border: 0, maxHeight: 600 }}>
            {readZip(tree[path]) ? '(fichero binario)' : tree[path]}
          </div>
        </div>
      ) : (
        <div className="file-tree">
          {[...entries.entries()]
            .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] ? -1 : 1))
            .map(([name, isDir]) => (
              <div key={name} className="file-row" onClick={() => go(prefix + name)}>
                <Icon name={isDir ? 'folder' : 'file'} style={{ color: isDir ? '#dcb67a' : 'var(--text-2)' }} />
                {name}
              </div>
            ))}
        </div>
      )}
      {!isFile && tree[prefix + 'README.md'] ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>
            README.md
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{tree[prefix + 'README.md']}</div>
        </div>
      ) : null}
    </>
  );
}

function CommitsView({ repo }: { repo: DevOpsRepo }) {
  useCloud();
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [sel, setSel] = useState<string | null>(null);
  const list = commitsOf(repo, branch);
  const cur = sel ? repo.commits[sel] : null;
  return (
    <>
      <div style={{ width: 200, marginBottom: 10 }}>
        <Select value={branch} onChange={setBranch} options={Object.keys(repo.branches)} />
      </div>
      <DataTable
        rows={list}
        rowKey={(c) => c.id}
        onRowClick={(c) => setSel(c.id === sel ? null : c.id)}
        columns={[
          { key: 'id', title: 'Commit', render: (c) => <span className="mono">{c.id.slice(0, 8)}</span> },
          { key: 'm', title: 'Mensaje', render: (c) => <b>{c.message.split('\n')[0]}</b> },
          { key: 'a', title: 'Autor', render: (c) => c.author },
          { key: 'd', title: 'Fecha', render: (c) => relTime(c.date) },
          { key: 'f', title: 'Ficheros', render: (c) => changedFiles(repo, c).length },
        ]}
        empty="Sin commits."
      />
      {cur ? (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>{cur.message}</h3>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {cur.author} · {formatDate(cur.date)} · padres: {cur.parents.map((x) => x.slice(0, 8)).join(', ') || 'ninguno'}
          </div>
          {changedFiles(repo, cur).map((f) => (
            <div key={f.path} style={{ marginBottom: 10 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                <span className={`pill ${f.kind === 'add' ? 'ok' : f.kind === 'delete' ? 'bad' : 'info'}`}>{f.kind === 'add' ? 'A' : f.kind === 'delete' ? 'D' : 'M'}</span> {f.path}
              </div>
              <DiffView a={cur.parents[0] ? repo.commits[cur.parents[0]]?.tree[f.path] ?? '' : ''} b={cur.tree[f.path] ?? ''} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function BranchesView({ p, repo }: { p: DevOpsProject; repo: DevOpsRepo }) {
  useCloud();
  const [name, setName] = useState('');
  const [from, setFrom] = useState(repo.defaultBranch);
  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder="feature/mi-cambio" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="muted">desde</span>
        <div style={{ width: 180 }}>
          <Select value={from} onChange={setFrom} options={Object.keys(repo.branches)} />
        </div>
        <button className="btn primary" disabled={!name} onClick={() => act(() => createBranch(repo, name, from), `Rama ${name} creada`) && setName('')}>
          Nueva rama
        </button>
      </div>
      <DataTable
        rows={Object.entries(repo.branches)}
        rowKey={([b]) => b}
        columns={[
          { key: 'n', title: 'Rama', render: ([b]) => <span className="row" style={{ gap: 6 }}><Icon name="branch" />{b}{b === repo.defaultBranch ? <span className="pill info">predeterminada</span> : null}{repo.policies && b === repo.defaultBranch ? <span className="pill warn">protegida</span> : null}</span> },
          { key: 'c', title: 'Último commit', render: ([, id]) => <span><span className="mono">{id.slice(0, 8)}</span> {repo.commits[id]?.message.split('\n')[0]}</span> },
          { key: 'a', title: 'Autor', render: ([, id]) => repo.commits[id]?.author },
          { key: 'd', title: 'Actualizada', render: ([, id]) => relTime(repo.commits[id]?.date ?? new Date().toISOString()) },
          {
            key: 'x',
            title: '',
            render: ([b]) =>
              b !== repo.defaultBranch ? (
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn small" onClick={() => navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(repo.name)}/prs?new=${encodeURIComponent(b)}`)}>
                    Nuevo PR
                  </button>
                  <button className="btn small" onClick={async () => (await confirmDialog({ title: 'Eliminar rama', message: `¿Eliminar ${b}?`, confirmText: 'Eliminar', danger: true })) && (delete repo.branches[b], changed())}>
                    Eliminar
                  </button>
                </span>
              ) : null,
          },
        ]}
      />
    </>
  );
}

const WI_COLOR: Record<string, string> = { Bug: '#cc293d', Task: '#f2cb1d', Epic: '#ff7b00', 'User Story': '#009ccc' };
const WI_STATE: Record<string, string> = { New: 'Nuevo', Active: 'Activo', Resolved: 'Resuelto', Closed: 'Cerrado' };

function PrWorkItems({ p, pr }: { p: DevOpsProject; pr: PullRequest }) {
  const [add, setAdd] = useState('');
  const linked = (pr.workItems ?? []).map((id) => p.workItems.find((w) => w.id === id)).filter(Boolean) as WorkItem[];
  const candidates = p.workItems.filter((w) => !(pr.workItems ?? []).includes(w.id) && w.state !== 'Closed');
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Elementos de trabajo</h3>
      {linked.map((w) => (
        <div key={w.id} className="row small" style={{ margin: '4px 0', gap: 8 }}>
          <span style={{ width: 4, height: 16, background: WI_COLOR[w.type], borderRadius: 2 }} />
          <span className="muted">
            {w.type} #{w.id}
          </span>
          <b>{w.title}</b>
          <span className="pill">{WI_STATE[w.state]}</span>
          {pr.status === 'active' ? (
            <button className="btn small" title="Quitar el vínculo" onClick={() => unlinkWorkItem(p, pr, w.id)}>
              ✕
            </button>
          ) : null}
        </div>
      ))}
      {!linked.length ? <div className="muted small">Ninguno. Menciona #id en la descripción o en los commits (p. ej. «Corrige el login #12») o vincúlalo aquí.</div> : null}
      {pr.status === 'active' && candidates.length ? (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <div style={{ width: 320 }}>
            <Select value={add} onChange={setAdd} options={[{ value: '', label: 'Vincular un elemento de trabajo...' }, ...candidates.map((w) => ({ value: String(w.id), label: `#${w.id} ${w.title}` }))]} />
          </div>
          <button className="btn" disabled={!add} onClick={() => act(() => linkWorkItems(p, pr, [Number(add)]), 'Elemento de trabajo vinculado') && setAdd('')}>
            Vincular
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PrDetail({ p, repo, prId }: { p: DevOpsProject; repo: DevOpsRepo; prId: number }) {
  useCloud();
  useTick(2000);
  const [transition, setTransition] = useState(true);
  const pr = p.pullRequests.find((x) => x.id === prId);
  if (!pr) return <Empty title="Pull request no encontrado" />;
  const st = prPolicyStatus(p, pr);
  const src = filesAt(repo, pr.source);
  const tgt = filesAt(repo, pr.target);
  const files = [...new Set([...Object.keys(src), ...Object.keys(tgt)])].filter((k) => src[k] !== tgt[k]);
  const run = pr.buildRunId ? p.runs.find((r) => r.id === pr.buildRunId) : undefined;
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className={`pill ${pr.status === 'active' ? 'info' : pr.status === 'completed' ? 'ok' : ''}`}>{pr.status === 'active' ? 'Activo' : pr.status === 'completed' ? 'Completado' : 'Abandonado'}</span>
        <h2 style={{ fontSize: 18 }}>
          !{pr.id} {pr.title}
        </h2>
      </div>
      <div className="muted" style={{ marginBottom: 12 }}>
        {pr.createdBy} quiere fusionar <b>{pr.source}</b> en <b>{pr.target}</b> · {relTime(pr.createdAt)}
      </div>
      {pr.description ? <div className="card" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>{pr.description}</div> : null}
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>Directivas de rama</h3>
        {repo.policies && pr.target === repo.defaultBranch ? (
          <>
            {repo.policies.minReviewers ? (
              <div className="row small" style={{ margin: '4px 0' }}>
                <RunStatusIcon status={pr.approvals.length >= repo.policies.minReviewers ? 'succeeded' : 'waiting'} />
                Revisores requeridos: {pr.approvals.length}/{repo.policies.minReviewers} aprobaciones {pr.approvals.length ? `(${pr.approvals.join(', ')})` : ''}
              </div>
            ) : null}
            {repo.policies.buildValidationPipelineId ? (
              <div className="row small" style={{ margin: '4px 0' }}>
                <RunStatusIcon status={run?.status ?? 'notStarted'} />
                Validación de compilación: {run ? <a href={pHref(p, `/pipelines/runs/${run.id}`)}>{run.pipelineName} #{run.buildNumber} · {STATUS_ES[run.status]}</a> : 'sin ejecutar'}
              </div>
            ) : null}
            {repo.policies.requireLinkedWorkItem ? (
              <div className="row small" style={{ margin: '4px 0' }}>
                <RunStatusIcon status={(pr.workItems ?? []).length ? 'succeeded' : 'waiting'} />
                Elementos de trabajo vinculados: {(pr.workItems ?? []).length ? (pr.workItems ?? []).map((id) => `#${id}`).join(', ') : 'ninguno (obligatorio)'}
              </div>
            ) : null}
          </>
        ) : (
          <div className="muted small">La rama de destino no tiene directivas.</div>
        )}
        {!st.ok && pr.status === 'active' ? <div className="feedback small" style={{ color: 'var(--warning)', marginTop: 6 }}>{st.reasons.join(' ')}</div> : null}
      </div>
      <PrWorkItems p={p} pr={pr} />
      {pr.status === 'active' && (pr.workItems ?? []).length ? (
        <div style={{ marginBottom: 8 }}>
          <Checkbox checked={transition} onChange={setTransition} label="Completar los elementos de trabajo vinculados después de combinar" />
        </div>
      ) : null}
      {pr.status === 'active' ? (
        <div className="btn-row" style={{ marginBottom: 16 }}>
          <button
            className="btn"
            disabled={pr.approvals.includes(me())}
            onClick={() => {
              pr.approvals.push(me());
              changed();
              toast('Has aprobado el pull request', 'success');
            }}
          >
            ✓ Aprobar
          </button>
          <button className="btn primary" disabled={!st.ok} onClick={() => act(() => completePullRequest(p, pr.id, me(), true, transition), 'Pull request completado (squash merge)')} title={st.ok ? '' : st.reasons.join(' ')}>
            Completar
          </button>
          <button
            className="btn"
            onClick={() => {
              pr.status = 'abandoned';
              changed();
            }}
          >
            Abandonar
          </button>
        </div>
      ) : null}
      <h3 className="section-title">Ficheros ({files.length})</h3>
      {files.map((f) => (
        <div key={f} style={{ marginBottom: 10 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            {f}
          </div>
          <DiffView a={tgt[f] ?? ''} b={src[f] ?? ''} />
        </div>
      ))}
    </>
  );
}

function PrsView({ p, repo }: { p: DevOpsProject; repo: DevOpsRepo }) {
  useCloud();
  const route = useRoute();
  const prId = route.parts[5] ? Number(route.parts[5]) : null;
  const preset = route.query.get('new');
  const [creating, setCreating] = useState(!!preset);
  const [source, setSource] = useState(preset ?? Object.keys(repo.branches).find((b) => b !== repo.defaultBranch) ?? '');
  const [target, setTarget] = useState(repo.defaultBranch);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [tab, setTab] = useState<'active' | 'completed' | 'abandoned'>('active');
  if (prId) return <PrDetail p={p} repo={repo} prId={prId} />;
  const list = p.pullRequests.filter((x) => x.repoId === repo.id && x.status === tab);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="tabs" style={{ margin: 0, border: 0 }}>
          {(['active', 'completed', 'abandoned'] as const).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'active' ? 'Activos' : t === 'completed' ? 'Completados' : 'Abandonados'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(!creating)}>
          Nuevo pull request
        </button>
      </div>
      {creating ? (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <div style={{ width: 200 }}>
              <Select value={source} onChange={setSource} options={Object.keys(repo.branches)} />
            </div>
            <span>→</span>
            <div style={{ width: 200 }}>
              <Select value={target} onChange={setTarget} options={Object.keys(repo.branches)} />
            </div>
          </div>
          <Field stack label="Título" required>
            <TextInput value={title} onChange={setTitle} />
          </Field>
          <Field stack label="Descripción">
            <textarea className="textarea" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <button
            className="btn primary"
            disabled={!title || !source}
            onClick={() => {
              let id = 0;
              if (act(() => (id = createPullRequest(p, repo, source, target, title, desc, me()).id), 'Pull request creado')) {
                setCreating(false);
                navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(repo.name)}/prs/${id}`);
              }
            }}
          >
            Crear
          </button>
        </div>
      ) : null}
      <DataTable
        rows={list}
        rowKey={(x) => String(x.id)}
        onRowClick={(x) => navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(repo.name)}/prs/${x.id}`)}
        columns={[
          { key: 'i', title: 'Id.', render: (x) => `!${x.id}` },
          { key: 't', title: 'Título', render: (x) => <b>{x.title}</b> },
          { key: 'b', title: 'Ramas', render: (x) => `${x.source} → ${x.target}` },
          { key: 'a', title: 'Creado por', render: (x) => x.createdBy },
          { key: 'v', title: 'Aprobaciones', render: (x) => x.approvals.length },
          { key: 'bs', title: 'Compilación', render: (x) => (x.buildStatus && x.buildStatus !== 'none' ? <span className={`pill ${x.buildStatus === 'succeeded' ? 'ok' : x.buildStatus === 'failed' ? 'bad' : 'info'}`}>{x.buildStatus}</span> : '—') },
        ]}
        empty="No hay pull requests."
      />
    </>
  );
}

function PoliciesView({ p, repo }: { p: DevOpsProject; repo: DevOpsRepo }) {
  useCloud();
  const pol = repo.policies ?? { minReviewers: 0, buildValidationPipelineId: null };
  const set = (patch: Partial<NonNullable<DevOpsRepo['policies']>>) => {
    const next = { ...pol, ...patch };
    repo.policies = next.minReviewers || next.buildValidationPipelineId || next.requireLinkedWorkItem ? next : null;
    changed();
    toast('Directivas de rama actualizadas', 'success');
  };
  return (
    <>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Directivas de la rama {repo.defaultBranch}</h2>
      <Callout>Las directivas de rama protegen la rama principal: nadie puede hacer push directamente; los cambios entran mediante pull requests revisados y validados por un pipeline.</Callout>
      <div className="card" style={{ marginBottom: 12 }}>
        <Checkbox checked={pol.minReviewers > 0} onChange={(v) => set({ minReviewers: v ? 1 : 0 })} label={<b>Requerir un número mínimo de revisores</b>} />
        {pol.minReviewers > 0 ? (
          <div className="row" style={{ marginLeft: 26, gap: 8 }}>
            <span>Mínimo:</span>
            <input className="input" style={{ width: 70 }} type="number" min={1} value={pol.minReviewers} onChange={(e) => set({ minReviewers: Math.max(1, Number(e.target.value)) })} />
          </div>
        ) : null}
      </div>
      <div className="card">
        <Checkbox checked={!!pol.buildValidationPipelineId} onChange={(v) => set({ buildValidationPipelineId: v ? p.pipelines.find((x) => x.repoId === repo.id)?.id ?? null : null })} label={<b>Validación de compilación</b>} />
        {pol.buildValidationPipelineId ? (
          <div className="row" style={{ marginLeft: 26, gap: 8 }}>
            <span>Pipeline:</span>
            <div style={{ width: 260 }}>
              <Select value={pol.buildValidationPipelineId ?? ''} onChange={(v) => set({ buildValidationPipelineId: v })} options={p.pipelines.filter((x) => x.repoId === repo.id).map((x) => ({ value: x.id, label: x.name }))} />
            </div>
          </div>
        ) : null}
        {!p.pipelines.some((x) => x.repoId === repo.id) ? <div className="muted small" style={{ marginLeft: 26 }}>Crea primero un pipeline para este repositorio.</div> : null}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <Checkbox checked={!!pol.requireLinkedWorkItem} onChange={(v) => set({ requireLinkedWorkItem: v })} label={<b>Comprobar los elementos de trabajo vinculados</b>} />
        <div className="muted small" style={{ marginLeft: 26 }}>
          Cada pull request debe estar vinculada a una historia, tarea o error de Boards: así cada cambio en producción es trazable hasta su requisito.
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <CliBox cmd={`az repos policy approver-count create --repository-id ${repo.name} --branch ${repo.defaultBranch} --minimum-approver-count 1 --creator-vote-counts false --blocking true --enabled true --allow-downvotes false --reset-on-source-push false --project ${p.name}`} />
      </div>
    </>
  );
}

function ReposPage({ p }: { p: DevOpsProject }) {
  const route = useRoute();
  const repo = (route.parts[3] ? p.repos.find((r) => r.name.toLowerCase() === route.parts[3].toLowerCase()) : null) ?? p.repos[0];
  const section = route.parts[4] ?? 'files';
  if (!repo)
    return (
      <div className="ado-body">
        <Empty title="No hay repositorios">
          <button className="btn primary" onClick={() => act(() => createRepo(p, p.name), 'Repositorio creado')}>
            Crear repositorio
          </button>
        </Empty>
      </div>
    );
  return (
    <div className="ado-body">
      <RepoPicker p={p} repo={repo} section={section} />
      {section === 'commits' ? <CommitsView repo={repo} /> : section === 'branches' ? <BranchesView p={p} repo={repo} /> : section === 'prs' ? <PrsView p={p} repo={repo} /> : section === 'policies' ? <PoliciesView p={p} repo={repo} /> : <FilesView p={p} repo={repo} />}
    </div>
  );
}

// ---------------------------------------------------------------- Pipelines

function RunsTable({ p, runs }: { p: DevOpsProject; runs: PipelineRun[] }) {
  useTick(2000);
  return (
    <DataTable
      rows={runs}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(pHref(p, `/pipelines/runs/${r.id}`).slice(1))}
      columns={[
        { key: 's', title: '', width: 30, render: (r) => <RunStatusIcon status={r.status} /> },
        { key: 'd', title: 'Descripción', render: (r) => <div><b>#{r.buildNumber} · {r.commitMessage.split('\n')[0]}</b><div className="muted small">{r.reason === 'individualCI' ? 'Desencadenado por CI' : r.reason === 'pullRequest' ? 'Validación de PR' : 'Manual'} · {r.requestedBy}</div></div> },
        { key: 'p', title: 'Pipeline', render: (r) => r.pipelineName },
        { key: 'b', title: 'Rama', render: (r) => <span className="row" style={{ gap: 4 }}><Icon name="branch" size={12} />{r.sourceBranch.replace('refs/heads/', '')}</span> },
        { key: 't', title: 'Cuándo', render: (r) => relTime(r.queuedAt) },
        { key: 'du', title: 'Duración', render: (r) => duration(r.startedAt, r.finishedAt) },
      ]}
      empty="No hay ejecuciones."
    />
  );
}

const STARTER_YAML = `# Pipeline inicial: se ejecuta con cada push a main
trigger:
- main

pool:
  vmImage: ubuntu-latest

steps:
- script: echo ¡Hola, mundo!
  displayName: 'Ejecutar un script de una línea'

- script: |
    echo Añade otras tareas para compilar, probar y desplegar tu proyecto.
    echo Consulta https://aka.ms/yaml
  displayName: 'Ejecutar un script de varias líneas'
`;

const NODE_YAML = `# Compilar y probar una app Node.js
trigger:
- main

pool:
  vmImage: ubuntu-latest

steps:
- task: NodeTool@0
  inputs:
    versionSpec: '20.x'
  displayName: 'Instalar Node.js'

- script: |
    npm install
    npm test
  displayName: 'npm install y npm test'
`;

function NewPipeline({ p }: { p: DevOpsProject }) {
  useCloud();
  const [step, setStep] = useState(1);
  const [repoName, setRepoName] = useState(p.repos[0]?.name ?? '');
  const repo = p.repos.find((r) => r.name === repoName);
  const ymls = repo ? Object.keys(filesAt(repo, repo.defaultBranch)).filter((f) => /\.ya?ml$/.test(f) && !f.includes('k8s/')) : [];
  const [mode, setMode] = useState<'existing' | 'starter' | 'node'>(ymls.length ? 'existing' : 'starter');
  const [path, setPath] = useState(ymls[0] ?? 'azure-pipelines.yml');
  const [yaml, setYaml] = useState('');
  const [name, setName] = useState(`${repoName}-ci`);
  useEffect(() => {
    if (!repo) return;
    if (mode === 'existing') setYaml(filesAt(repo, repo.defaultBranch)[path] ?? '');
    else setYaml(mode === 'node' ? NODE_YAML : STARTER_YAML);
  }, [mode, path, repoName]);
  const save = (run: boolean) => {
    if (!repo) return;
    const ok = act(() => {
      const tree = filesAt(repo, repo.defaultBranch);
      const target = mode === 'existing' ? path : 'azure-pipelines.yml';
      if (tree[target] !== yaml) commitFile(p, repo, repo.defaultBranch, target, yaml, 'Configurar Azure Pipelines', me());
      const pl = createPipeline(p, name, repo, target, repo.defaultBranch);
      if (run) queueRun(p, pl, repo.defaultBranch, 'manual', me());
    }, run ? 'Pipeline creado y en ejecución' : 'Pipeline creado');
    if (ok) {
      closePane();
      navigate(pHref(p, '/pipelines').slice(1));
    }
  };
  return (
    <>
      <div className="pane-body">
        <div className="wizard-tabs">
          {['Conectar', 'Seleccionar', 'Configurar', 'Revisar'].map((t, i) => (
            <button key={t} className={step === i + 1 ? 'active' : ''} onClick={() => i + 1 < step && setStep(i + 1)}>
              {t}
            </button>
          ))}
        </div>
        {step === 1 ? (
          <>
            <h3>¿Dónde está tu código?</h3>
            <div className="card" style={{ cursor: 'pointer', borderColor: 'var(--accent)' }} onClick={() => setStep(2)}>
              <div className="row">
                <Icon name="git" style={{ color: '#f05133' }} />
                <b>Azure Repos Git</b>
                <span className="pill info">YAML</span>
              </div>
              <div className="muted small">Repositorios Git de este proyecto</div>
            </div>
            <div className="card muted" style={{ marginTop: 8 }}>
              GitHub, Bitbucket y otros orígenes no están disponibles en el simulador.
            </div>
          </>
        ) : step === 2 ? (
          <>
            <h3>Selecciona un repositorio</h3>
            {p.repos.map((r) => (
              <div key={r.id} className="file-row" style={{ background: r.name === repoName ? 'var(--selected)' : undefined }} onClick={() => { setRepoName(r.name); setName(`${r.name}-ci`); setStep(3); }}>
                <Icon name="git" /> {r.name} {Object.keys(r.branches).length ? '' : <span className="muted small">(vacío)</span>}
              </div>
            ))}
          </>
        ) : step === 3 ? (
          <>
            <h3>Configura tu pipeline</h3>
            {!repo || !Object.keys(repo.branches).length ? <Callout kind="warn">El repositorio está vacío: sube o importa código primero.</Callout> : null}
            <Radio
              value={mode}
              onChange={setMode}
              options={[
                { value: 'existing', label: 'Archivo YAML de Azure Pipelines existente', help: ymls.length ? `Encontrados: ${ymls.join(', ')}` : 'No hay ficheros .yml en la rama principal.' },
                { value: 'starter', label: 'Pipeline inicial', help: 'Un ejemplo mínimo para empezar.' },
                { value: 'node', label: 'Node.js', help: 'Instala Node, ejecuta npm install y npm test.' },
              ]}
            />
            {mode === 'existing' && ymls.length ? (
              <Field stack label="Ruta">
                <Select value={path} onChange={setPath} options={ymls} />
              </Field>
            ) : null}
            <button className="btn primary" disabled={!repo || !Object.keys(repo.branches).length || (mode === 'existing' && !ymls.length)} onClick={() => setStep(4)}>
              Continuar
            </button>
          </>
        ) : (
          <>
            <Field stack label="Nombre del pipeline">
              <TextInput value={name} onChange={setName} />
            </Field>
            <Field stack label={`Revisa el YAML (${mode === 'existing' ? path : 'azure-pipelines.yml'})`}>
              <textarea className="textarea" rows={20} value={yaml} onChange={(e) => setYaml(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      {step === 4 ? (
        <div className="pane-foot">
          <button className="btn primary" onClick={() => save(true)}>
            Guardar y ejecutar
          </button>
          <button className="btn" onClick={() => save(false)}>
            Guardar
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Controles para los parámetros en tiempo de ejecución declarados en el YAML (parameters:). */
function RuntimeParams({ defs, values, onChange }: { defs: ReturnType<typeof pipelineParameters>; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  if (!defs.length) return null;
  const set = (k: string, v: string) => onChange({ ...values, [k]: v });
  return (
    <>
      <h3 className="section-title" style={{ marginTop: 4 }}>
        Parámetros
      </h3>
      {defs.map((d) => {
        const label = d.displayName ?? d.name;
        const v = values[d.name] ?? '';
        if (d.type === 'boolean') return <Checkbox key={d.name} checked={v === 'true'} onChange={(x) => set(d.name, String(x))} label={label} />;
        if (d.values?.length)
          return (
            <Field key={d.name} stack label={label}>
              {d.values.length <= 4 ? <Radio value={v} onChange={(x) => set(d.name, x)} options={d.values.map((x) => ({ value: String(x), label: String(x) }))} /> : <Select value={v} onChange={(x) => set(d.name, x)} options={d.values.map(String)} />}
            </Field>
          );
        if (['object', 'step', 'steplist', 'job', 'joblist', 'stage', 'stagelist'].includes(d.type.toLowerCase())) return null;
        return (
          <Field key={d.name} stack label={label} help={d.type === 'number' ? 'Número' : undefined}>
            <TextInput value={v} onChange={(x) => set(d.name, x)} />
          </Field>
        );
      })}
    </>
  );
}

const paramDefaults = (defs: ReturnType<typeof pipelineParameters>) => Object.fromEntries(defs.map((d) => [d.name, d.default === undefined || d.default === null ? '' : typeof d.default === 'object' ? JSON.stringify(d.default) : String(d.default)]));

function RunPipelinePane({ p, plId, initial }: { p: DevOpsProject; plId: string; initial?: { branch?: string; variables?: Record<string, string> } }) {
  const pl = p.pipelines.find((x) => x.id === plId)!;
  const repo = p.repos.find((r) => r.id === pl.repoId)!;
  const [branch, setBranch] = useState(initial?.branch ?? repo.defaultBranch);
  const defs = useMemo(() => pipelineParameters(filesAt(repo, branch)[pl.yamlPath] ?? ''), [repo, branch, pl.yamlPath]);
  const fromRun = Object.fromEntries(Object.entries(initial?.variables ?? {}).filter(([k]) => k.startsWith('parameters.')).map(([k, v]) => [k.slice(11), v]));
  const [params, setParams] = useState<Record<string, string>>({ ...paramDefaults(defs), ...fromRun });
  const [vars, setVars] = useState(
    Object.entries(initial?.variables ?? {})
      .filter(([k]) => !k.startsWith('parameters.'))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  useEffect(() => setParams((cur) => ({ ...paramDefaults(defs), ...Object.fromEntries(Object.entries(cur).filter(([k]) => defs.some((d) => d.name === k))) })), [defs]);
  const cli = `az pipelines run --name ${pl.name} --branch ${branch}${defs.length ? ' --parameters ' + defs.filter((d) => params[d.name] !== undefined && !['object', 'steplist', 'joblist', 'stagelist'].includes(d.type.toLowerCase())).map((d) => `${d.name}=${/\s/.test(params[d.name]) ? `"${params[d.name]}"` : params[d.name]}`).join(' ') : ''}`;
  return (
    <>
      <div className="pane-body">
        <Field stack label="Rama">
          <Select value={branch} onChange={setBranch} options={Object.keys(repo.branches)} />
        </Field>
        <RuntimeParams defs={defs} values={params} onChange={setParams} />
        <Field stack label="Variables (nombre=valor, una por línea)">
          <textarea className="textarea" rows={3} value={vars} onChange={(e) => setVars(e.target.value)} />
        </Field>
        <CliBox cmd={cli} />
      </div>
      <div className="pane-foot">
        <button
          className="btn primary"
          onClick={() => {
            let id = '';
            const v: Record<string, string> = Object.fromEntries(vars.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
            for (const d of defs) if (params[d.name] !== undefined && !['object', 'steplist', 'joblist', 'stagelist'].includes(d.type.toLowerCase())) v[`parameters.${d.name}`] = params[d.name];
            if (act(() => (id = queueRun(p, pl, branch, 'manual', me(), v).id))) {
              closePane();
              navigate(pHref(p, `/pipelines/runs/${id}`).slice(1));
            }
          }}
        >
          Ejecutar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function PipelinesList({ p }: { p: DevOpsProject }) {
  useCloud();
  const [tab, setTab] = useState<'recent' | 'all' | 'runs'>('recent');
  return (
    <div className="ado-body">
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 20 }}>Pipelines</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => openPane({ title: 'Nueva canalización', width: 680, render: () => <NewPipeline p={p} /> })}>
          Nueva canalización
        </button>
      </div>
      <div className="tabs">
        {(['recent', 'all', 'runs'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'recent' ? 'Recientes' : t === 'all' ? 'Todas' : 'Ejecuciones'}
          </button>
        ))}
      </div>
      {tab === 'runs' ? (
        <RunsTable p={p} runs={p.runs} />
      ) : (
        <DataTable
          rows={p.pipelines}
          rowKey={(x) => x.id}
          columns={[
            { key: 'n', title: 'Pipeline', render: (x) => <b>{x.name}</b> },
            { key: 'y', title: 'YAML', render: (x) => <span className="mono small">/{x.yamlPath}</span> },
            { key: 'r', title: 'Repositorio', render: (x) => p.repos.find((r) => r.id === x.repoId)?.name },
            { key: 'l', title: 'Última ejecución', render: (x) => { const r = p.runs.find((y) => y.pipelineId === x.id); return r ? <a className="row" style={{ gap: 6 }} onClick={(e) => { e.stopPropagation(); navigate(pHref(p, `/pipelines/runs/${r.id}`).slice(1)); }}><RunStatusIcon status={r.status} />#{r.buildNumber} · {relTime(r.queuedAt)}</a> : '—'; } },
            {
              key: 'x',
              title: '',
              render: (x) => (
                <span className="row" style={{ gap: 4 }}>
                  <a className="btn small" href={pHref(p, `/pipelines/edit/${x.id}`)}>
                    Editar
                  </a>
                  <button className="btn small primary" onClick={() => openPane({ title: `Ejecutar ${x.name}`, render: () => <RunPipelinePane p={p} plId={x.id} /> })}>
                    Ejecutar
                  </button>
                </span>
              ),
            },
          ]}
          empty={
            <Empty title="Crea tu primera canalización">
              <p>Automatiza la compilación, las pruebas y el despliegue de tu código.</p>
              <button className="btn primary" onClick={() => openPane({ title: 'Nueva canalización', width: 680, render: () => <NewPipeline p={p} /> })}>
                Crear canalización
              </button>
            </Empty>
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor de pipelines

const SNIPPETS: { label: string; text: string }[] = [
  { label: 'Script de Bash', text: "- script: |\n    echo \"Hola desde $(Build.BuildNumber)\"\n  displayName: 'Ejecutar script'" },
  { label: 'Azure CLI (AzureCLI@2)', text: "- task: AzureCLI@2\n  displayName: 'Azure CLI'\n  inputs:\n    azureSubscription: 'sc-azure-lab'\n    scriptType: bash\n    scriptLocation: inlineScript\n    inlineScript: |\n      az group list -o table" },
  { label: 'Desplegar web app (AzureWebApp@1)', text: "- task: AzureWebApp@1\n  displayName: 'Desplegar en App Service'\n  inputs:\n    azureSubscription: 'sc-azure-lab'\n    appType: webAppLinux\n    appName: '<NOMBRE_DE_TU_WEBAPP>'\n    package: '$(Pipeline.Workspace)/drop/*.zip'" },
  { label: 'Publicar un artefacto', text: "- publish: $(Build.ArtifactStagingDirectory)\n  artifact: drop\n  displayName: 'Publicar artefacto'" },
  { label: 'Docker: compilar e insertar (Docker@2)', text: "- task: Docker@2\n  displayName: 'Compilar e insertar la imagen'\n  inputs:\n    containerRegistry: 'sc-acr'\n    repository: 'app'\n    command: buildAndPush\n    tags: |\n      $(Build.BuildId)" },
  { label: 'Usar una plantilla de pasos', text: "- template: templates/build.yml\n  parameters:\n    nodeVersion: '20.x'" },
  { label: 'Paso condicional (${{ if }})', text: "- ${{ if eq(parameters.entorno, 'prod') }}:\n  - script: echo \"Sólo en producción\"" },
];

function PipelineEditor({ p, plId }: { p: DevOpsProject; plId: string }) {
  useCloud();
  const pl = p.pipelines.find((x) => x.id === plId);
  const repo = pl ? p.repos.find((r) => r.id === pl.repoId) : undefined;
  const [branch, setBranch] = useState(repo?.defaultBranch ?? 'main');
  const original = repo && pl ? filesAt(repo, branch)[pl.yamlPath] ?? '' : '';
  const [text, setText] = useState(original);
  const [loadedFrom, setLoadedFrom] = useState(branch);
  const [result, setResult] = useState<{ ok: true; c: CompiledPipeline } | { ok: false; error: string } | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState<'direct' | 'pr'>('direct');
  const [newBranch, setNewBranch] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  if (!pl || !repo) return <div className="ado-body"><Empty title="Pipeline no encontrado" /></div>;
  if (loadedFrom !== branch) {
    setLoadedFrom(branch);
    setText(original);
    setResult(null);
  }
  const dirty = text !== original;
  const protectedBranch = branchProtected(repo, branch);
  const validate = () => {
    try {
      setResult({ ok: true, c: compilePipeline(p, repo.name, branch, pl.yamlPath, { text }) });
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message ?? e) });
    }
  };
  const insert = (snippet: string) => {
    const el = ta.current;
    const pos = el ? el.selectionStart : text.length;
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const indent = /^\s*/.exec(text.slice(lineStart, pos))?.[0] ?? '';
    const atLineStart = text.slice(lineStart, pos).trim() === '';
    const body = snippet.split('\n').join('\n' + indent);
    const next = text.slice(0, pos) + (atLineStart ? '' : '\n' + indent) + body + '\n' + text.slice(pos);
    setText(next);
    requestAnimationFrame(() => el?.focus());
  };
  const save = () => {
    const message = msg.trim() || `Actualizar ${pl.yamlPath}`;
    if (mode === 'direct' || !protectedBranch) {
      if (act(() => commitFile(p, repo, branch, pl.yamlPath, text, message, me()), `Commit en ${branch}`)) setSaving(false);
      return;
    }
    const nb = newBranch.trim() || `${me().split(' ')[0].toLowerCase()}/pipeline-${Date.now().toString(36).slice(-4)}`;
    let prId = 0;
    if (
      act(() => {
        createBranch(repo, nb, branch);
        commitFile(p, repo, nb, pl.yamlPath, text, message, me());
        prId = createPullRequest(p, repo, nb, branch, message, `Cambios en /${pl.yamlPath} desde el editor de pipelines.`, me()).id;
      }, 'Pull request creada')
    )
      navigate(`/devops/${encodeURIComponent(p.name)}/repos/${encodeURIComponent(repo.name)}/prs/${prId}`);
  };
  const lines = text.split('\n').length;
  return (
    <div className="ado-body">
      <div className="breadcrumb">
        <a href={pHref(p, '/pipelines')}>Pipelines</a> <Icon name="chevron" size={10} /> <span>{pl.name}</span> <Icon name="chevron" size={10} /> <span>Editar</span>
      </div>
      <div className="row wrap" style={{ marginBottom: 10, gap: 10 }}>
        <h1 style={{ fontSize: 20 }}>{pl.name}</h1>
        <div style={{ width: 180 }}>
          <Select value={branch} onChange={setBranch} options={Object.keys(repo.branches)} />
        </div>
        <span className="mono small muted">
          {repo.name}/{pl.yamlPath}
        </span>
        {dirty ? <span className="pill warn">Sin guardar</span> : null}
        <span className="spacer" />
        <button className="btn" onClick={validate}>
          Validar
        </button>
        <button className="btn primary" disabled={!dirty} onClick={() => setSaving(true)}>
          Guardar
        </button>
        <button className="btn" onClick={() => openPane({ title: `Ejecutar ${pl.name}`, render: () => <RunPipelinePane p={p} plId={pl.id} initial={{ branch }} /> })}>
          Ejecutar
        </button>
      </div>
      {saving ? (
        <div className="card" style={{ marginBottom: 12, maxWidth: 760 }}>
          <h3>Guardar</h3>
          <Field stack label="Mensaje del commit">
            <TextInput value={msg} onChange={setMsg} placeholder={`Actualizar ${pl.yamlPath}`} autoFocus />
          </Field>
          {protectedBranch ? (
            <>
              <Radio
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'pr', label: 'Crear una rama nueva para este commit e iniciar una pull request', help: `La rama ${branch} tiene directivas: no admite commits directos.` },
                  { value: 'direct', label: `Confirmar directamente en la rama ${branch}`, help: 'Fallará por las directivas de rama (TF402455).' },
                ]}
              />
              {mode === 'pr' ? (
                <Field stack label="Nombre de la rama nueva">
                  <TextInput value={newBranch} onChange={setNewBranch} placeholder={`${me().split(' ')[0].toLowerCase()}/pipeline`} mono />
                </Field>
              ) : null}
            </>
          ) : (
            <div className="muted small" style={{ marginBottom: 8 }}>
              Se confirmará en la rama <b>{branch}</b>. Si el <span className="mono">trigger:</span> del YAML incluye esa rama, el commit lanzará una ejecución de CI.
            </div>
          )}
          <div className="btn-row">
            <button className="btn primary" onClick={save}>
              {protectedBranch && mode === 'pr' ? 'Crear pull request' : 'Confirmar (commit)'}
            </button>
            <button className="btn" onClick={() => setSaving(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="yaml-editor">
            <div className="gutter" aria-hidden>
              {Array.from({ length: lines }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={ta}
              spellCheck={false}
              value={text}
              rows={Math.max(24, lines + 2)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const s = el.selectionStart;
                  setText(text.slice(0, s) + '  ' + text.slice(el.selectionEnd));
                  requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
                }
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (dirty) setSaving(true);
                }
              }}
            />
          </div>
          {result && !result.ok ? (
            <Callout kind="bad" title="El YAML no es válido">
              <div style={{ whiteSpace: 'pre-wrap' }}>{result.error}</div>
            </Callout>
          ) : null}
          {result && result.ok ? (
            <Callout kind="ok" title="Correcto: el pipeline es válido">
              {result.c.stages.map((s) => (
                <div key={s.name} className="small" style={{ marginTop: 4 }}>
                  <b>{s.displayName === 'Pipeline' ? 'Pipeline' : `Fase ${s.displayName}`}</b>
                  {s.jobs.map((j) => (
                    <div key={j.name} style={{ marginLeft: 14 }}>
                      {j.displayName === 'Job' ? 'Job' : `Job ${j.displayName}`}: <span className="muted">{j.steps.join(' → ') || '(sin pasos)'}</span>
                    </div>
                  ))}
                </div>
              ))}
              {Object.keys(result.c.templates).length ? <div className="small" style={{ marginTop: 6 }}>Plantillas: {Object.keys(result.c.templates).map((t) => <span key={t} className="mono">/{t} </span>)}</div> : null}
              <div style={{ marginTop: 8 }}>
                <a onClick={() => setShowFull(!showFull)}>{showFull ? 'Ocultar el YAML completo' : 'Ver el YAML completo (plantillas expandidas)'}</a>
              </div>
              {showFull ? <CodeBlock code={result.c.yaml} maxHeight={360} /> : null}
            </Callout>
          ) : null}
        </div>
        <div className="card" style={{ width: 280, flex: '0 0 280px' }}>
          <h3>Asistente</h3>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Coloca el cursor donde quieras el paso y pulsa un fragmento para insertarlo.
          </div>
          {SNIPPETS.map((s) => (
            <div key={s.label} style={{ padding: '4px 0' }}>
              <a onClick={() => insert(s.text)}>+ {s.label}</a>
            </div>
          ))}
          <div className="muted small" style={{ marginTop: 12 }}>
            Tab inserta dos espacios · Ctrl+S guarda. Recuerda: en YAML la sangría importa y no se pueden usar tabuladores.
          </div>
        </div>
      </div>
    </div>
  );
}

function LogViewer({ job }: { job: RunJob }) {
  const [sel, setSel] = useState<string | null>(null);
  useTick(1000);
  // Por defecto: el paso en curso, el que falló o el último paso "de verdad" (no Initialize/Finalize).
  const userSteps = job.steps.filter((s) => !/^(Initialize job|Finalize Job)$/.test(s.name) && s.status !== 'notStarted' && s.status !== 'skipped');
  const step = job.steps.find((s) => s.id === sel) ?? job.steps.find((s) => s.status === 'running') ?? job.steps.find((s) => s.status === 'failed') ?? userSteps[userSteps.length - 1] ?? job.steps[0];
  return (
    <div className="logs">
      <div className="logs-steps">
        <div className="job">
          <RunStatusIcon status={job.status} />
          {job.displayName}
        </div>
        {job.steps.map((s) => (
          <div key={s.id} className={`st${step?.id === s.id ? ' sel' : ''}`} onClick={() => setSel(s.id)}>
            <RunStatusIcon status={s.status} size={14} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <span className="muted small">{duration(s.startedAt, s.finishedAt)}</span>
          </div>
        ))}
      </div>
      <div className="logs-text">
        {(step?.log ?? []).map((l, i) => {
          const cls = l.startsWith('##[section]') ? 'section' : l.startsWith('##[command]') ? 'cmd' : l.startsWith('##[error]') ? 'error' : l.startsWith('##[warning]') ? 'warning' : '';
          return (
            <div key={i} className={`ln ${cls}`}>
              <span className="n">{i + 1}</span>
              <span>{l.replace(/^##\[(section|command|error|warning)\]/, (m, k) => (k === 'error' ? 'Error: ' : k === 'warning' ? 'Advertencia: ' : k === 'command' ? '' : ''))}</span>
            </div>
          );
        })}
        {!step?.log.length ? <div className="ln"><span className="n" /> <span style={{ color: '#888' }}>{step?.status === 'notStarted' ? 'Pendiente...' : step?.status === 'skipped' ? 'Paso omitido.' : 'Esperando la salida...'}</span></div> : null}
      </div>
    </div>
  );
}

function RunDetail({ p, runId }: { p: DevOpsProject; runId: string }) {
  useCloud();
  useTick(1000);
  const run = p.runs.find((r) => r.id === runId);
  const [jobSel, setJobSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'logs' | 'yaml'>('logs');
  if (!run) return <div className="ado-body"><Empty title="Ejecución no encontrada" /></div>;
  const jobs = run.stages.flatMap((s) => s.jobs.map((j) => ({ s, j })));
  const curJob = jobs.find((x) => x.j.id === jobSel)?.j ?? jobs.find((x) => x.j.status === 'running')?.j ?? jobs.find((x) => x.j.status === 'failed')?.j ?? jobs[jobs.length - 1]?.j;
  const pending = run.stages.filter((s) => s.approval?.status === 'pending');
  const active = !['succeeded', 'failed', 'canceled', 'succeededWithIssues'].includes(run.status);
  const pl = p.pipelines.find((x) => x.id === run.pipelineId);
  return (
    <div className="ado-body">
      <div className="breadcrumb">
        <a href={pHref(p, '/pipelines')}>Pipelines</a> <Icon name="chevron" size={10} /> <span>{run.pipelineName}</span>
      </div>
      <div className="row" style={{ marginBottom: 6 }}>
        <RunStatusIcon status={run.status} size={22} />
        <h1 style={{ fontSize: 20 }}>
          #{run.buildNumber} · {run.commitMessage.split('\n')[0]}
        </h1>
        <span className="spacer" />
        {active ? (
          <button className="btn" onClick={() => act(() => cancelRun(p, run.id), 'Ejecución cancelada')}>
            Cancelar
          </button>
        ) : pl ? (
          <>
            <a className="btn" href={pHref(p, `/pipelines/edit/${pl.id}`)}>
              Editar pipeline
            </a>
            {(run.status === 'failed' || run.status === 'canceled') && run.stages.some((s) => ['failed', 'canceled', 'skipped'].includes(s.status)) ? (
              <button className="btn" title="Repite sólo las fases que fallaron; las correctas y sus artefactos se conservan" onClick={() => act(() => rerunFailedStages(p, run.id), 'Repitiendo las fases con errores')}>
                Volver a ejecutar las fases con errores
              </button>
            ) : null}
            <button className="btn" title="Misma rama, variables y parámetros" onClick={() => { let id = ''; if (act(() => (id = queueRun(p, pl, run.sourceBranch.replace('refs/heads/', ''), 'manual', me(), run.variables).id))) navigate(pHref(p, `/pipelines/runs/${id}`).slice(1)); }}>
              Volver a ejecutar
            </button>
          </>
        ) : null}
      </div>
      <div className="muted small" style={{ marginBottom: 14 }}>
        {STATUS_ES[run.status]} · {run.reason === 'individualCI' ? 'Desencadenado por CI' : run.reason === 'pullRequest' ? 'Validación de PR' : 'Ejecución manual'} por {run.requestedBy} · rama {run.sourceBranch.replace('refs/heads/', '')} · commit <span className="mono">{run.sourceVersion.slice(0, 8)}</span> · {formatDate(run.queuedAt)} · duración {duration(run.startedAt, run.finishedAt)}{run.attempt ? ` · intento ${run.attempt}` : ''}
      </div>
      {run.error ? (
        <Callout kind="bad" title="La ejecución no se pudo completar">
          <div style={{ whiteSpace: 'pre-wrap' }}>{run.error}</div>
        </Callout>
      ) : null}
      {pending.map((st) => (
        <Callout key={st.id} kind="warn" title={`La fase "${st.displayName}" espera aprobación para desplegar en el entorno "${st.approval!.environment}"`}>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => act(() => approveStage(p, run.id, st.id, true, me()), 'Aprobado')}>
              Aprobar
            </button>
            <button className="btn" onClick={() => act(() => approveStage(p, run.id, st.id, false, me()), 'Rechazado')}>
              Rechazar
            </button>
          </div>
        </Callout>
      ))}
      <div className="run-graph">
        {run.stages.map((st) => (
          <StageBox key={st.id} st={st} onJob={(id) => setJobSel(id)} sel={curJob?.id} />
        ))}
      </div>
      {Object.keys(run.artifacts).length ? (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Artefactos publicados</h3>
          {Object.entries(run.artifacts).map(([n, files]) => (
            <div key={n} className="small">
              📦 <b>{n}</b> · {Object.keys(files).length} ficheros ({Object.keys(files).slice(0, 4).join(', ')}
              {Object.keys(files).length > 4 ? '…' : ''})
            </div>
          ))}
        </div>
      ) : null}
      {run.parameters && Object.keys(run.parameters).length ? (
        <div className="small" style={{ marginBottom: 10 }}>
          <b>Parámetros:</b>{' '}
          {Object.entries(run.parameters).map(([k, v]) => (
            <span key={k} className="pill" style={{ marginRight: 6 }}>
              {k} = {typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </span>
          ))}
        </div>
      ) : null}
      {run.expandedYaml ? (
        <div className="tabs" style={{ marginBottom: 10 }}>
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>
            Registros
          </button>
          <button className={tab === 'yaml' ? 'active' : ''} onClick={() => setTab('yaml')}>
            YAML completo{run.templates ? ` (${Object.keys(run.templates).length} ${Object.keys(run.templates).length === 1 ? 'plantilla' : 'plantillas'})` : ''}
          </button>
        </div>
      ) : null}
      {tab === 'yaml' && run.expandedYaml ? (
        <>
          <p className="muted small">
            Así quedó el pipeline tras sustituir las plantillas y las expresiones <span className="mono">{'${{ }}'}</span> (en tiempo de compilación). Las macros <span className="mono">$(variable)</span> se resuelven después, al ejecutar cada paso.
            {run.templates ? (
              <>
                {' '}
                Plantillas usadas:{' '}
                {Object.entries(run.templates).map(([t, n]) => (
                  <span key={t} className="mono">
                    /{t}
                    {n > 1 ? ` ×${n}` : ''}{' '}
                  </span>
                ))}
              </>
            ) : null}
          </p>
          <CodeBlock code={run.expandedYaml} maxHeight={520} />
        </>
      ) : curJob ? (
        <LogViewer key={curJob.id} job={curJob} />
      ) : !run.error ? (
        <div className="muted">Preparando la ejecución...</div>
      ) : null}
    </div>
  );
}

function StageBox({ st, onJob, sel }: { st: RunStage; onJob: (id: string) => void; sel?: string }) {
  return (
    <div className="stage-box">
      <div className="row">
        <RunStatusIcon status={st.status} />
        <b>{st.displayName}</b>
      </div>
      <div className="muted small">{STATUS_ES[st.status] ?? st.status}</div>
      <div className="jobs">
        {st.jobs.map((j) => (
          <div key={j.id} className="row" style={{ gap: 6, padding: '3px 4px', cursor: 'pointer', borderRadius: 3, background: sel === j.id ? 'var(--selected)' : undefined }} onClick={() => onJob(j.id)}>
            <RunStatusIcon status={j.status} size={14} />
            <span>{j.displayName}</span>
            {j.environment ? <span className="pill" style={{ height: 18 }}>{j.environment}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- entornos, Library, conexiones de servicio

function Environments({ p }: { p: DevOpsProject }) {
  useCloud();
  const [name, setName] = useState('');
  return (
    <div className="ado-body">
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Entornos</h1>
      <Callout>Un entorno (dev, test, prod) es el destino de un <i>deployment job</i>. Puedes exigir <b>aprobaciones</b> antes de desplegar en él y ver el historial de despliegues. Se crean automáticamente la primera vez que un pipeline los usa.</Callout>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Nombre (p. ej. prod)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name} onClick={() => act(() => createEnvironment(p, name, false, []), `Entorno ${name} creado`) && setName('')}>
          Crear entorno
        </button>
      </div>
      {p.environments.map((e) => (
        <div key={e.id} className="card" style={{ marginBottom: 12 }}>
          <div className="row">
            <Icon name="env" style={{ color: 'var(--accent)' }} />
            <h3 style={{ margin: 0 }}>{e.name}</h3>
            <span className="spacer" />
            <Checkbox
              checked={e.requireApproval}
              onChange={(v) => {
                createEnvironment(p, e.name, v, v ? [me()] : []);
                toast(v ? `Aprobación requerida para ${e.name} (aprobador: ${me()})` : `Aprobaciones desactivadas en ${e.name}`, 'success');
              }}
              label="Requerir aprobación antes de desplegar"
            />
          </div>
          {e.requireApproval ? <div className="muted small">Aprobadores: {e.approvers.join(', ')}</div> : null}
          <div style={{ marginTop: 8 }}>
            {e.deployments.length ? (
              e.deployments.slice(0, 6).map((d, i) => (
                <div key={i} className="row small" style={{ padding: '3px 0' }}>
                  <RunStatusIcon status={d.status} size={14} />
                  <a href={pHref(p, `/pipelines/runs/${d.runId}`)}>{d.pipelineName}</a>
                  <span className="muted">{relTime(d.time)}</span>
                </div>
              ))
            ) : (
              <span className="muted small">Sin despliegues todavía.</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Library({ p }: { p: DevOpsProject }) {
  useCloud();
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  const [secret, setSecret] = useState(false);
  return (
    <div className="ado-body">
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Library · Grupos de variables</h1>
      <Callout>Los grupos de variables comparten valores entre pipelines (<code>variables: - group: nombre</code>). Las variables secretas se enmascaran (***) en los registros y no se exponen como variables de entorno salvo que las mapees con <code>env:</code>.</Callout>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Nombre del grupo" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn primary"
          disabled={!name}
          onClick={() => {
            p.variableGroups.push({ id: String(p.variableGroups.length + 1), name, variables: {} });
            changed();
            setOpen(name);
            setName('');
          }}
        >
          + Grupo de variables
        </button>
      </div>
      {p.variableGroups.map((g) => (
        <div key={g.id} className="card" style={{ marginBottom: 10 }}>
          <div className="row" onClick={() => setOpen(open === g.name ? null : g.name)} style={{ cursor: 'pointer' }}>
            <Icon name="library" style={{ color: 'var(--accent)' }} />
            <b>{g.name}</b>
            <span className="muted small">{Object.keys(g.variables).length} variables</span>
          </div>
          {open === g.name ? (
            <div style={{ marginTop: 10 }}>
              <DataTable
                rows={Object.entries(g.variables)}
                rowKey={([n]) => n}
                columns={[
                  { key: 'n', title: 'Nombre', render: ([n]) => <span className="mono">{n}</span> },
                  { key: 'v', title: 'Valor', render: ([, x]) => (x.isSecret ? '******' : x.value) },
                  { key: 'x', title: '', render: ([n]) => <button className="btn small" onClick={() => { delete g.variables[n]; changed(); }}>Quitar</button> },
                ]}
                empty="Sin variables."
              />
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <input className="input" placeholder="Nombre" value={k} onChange={(e) => setK(e.target.value)} />
                <input className="input" placeholder="Valor" type={secret ? 'password' : 'text'} value={v} onChange={(e) => setV(e.target.value)} />
                <Checkbox checked={secret} onChange={setSecret} label="🔒" />
                <button
                  className="btn"
                  disabled={!k}
                  onClick={() => {
                    g.variables[k] = { value: v, isSecret: secret };
                    changed();
                    setK('');
                    setV('');
                    setSecret(false);
                  }}
                >
                  Agregar
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function NewServiceConnection({ p }: { p: DevOpsProject }) {
  const s = useCloud();
  const [type, setType] = useState<'azurerm' | 'dockerregistry' | 'kubernetes'>('azurerm');
  const [auth, setAuth] = useState<'auto' | 'manual'>('auto');
  const [level, setLevel] = useState<'sub' | 'rg'>('sub');
  const [sub, setSub] = useState(s.currentSubscriptionId);
  const [rg, setRg] = useState('');
  const [name, setName] = useState('sc-azure-lab');
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [target, setTarget] = useState('');
  const regs = s.resources.filter((r) => r.type === 'Microsoft.ContainerRegistry/registries');
  const clusters = s.resources.filter((r) => r.type === 'Microsoft.ContainerService/managedClusters');
  const create = () => {
    const admin = portalPrincipal();
    const ok = act(() => {
      if (type === 'azurerm') {
        const scope = level === 'sub' ? `/subscriptions/${sub}` : `/subscriptions/${sub}/resourceGroups/${rg}`;
        createAzureRmConnection(p, { name, scope, subscriptionId: sub, automatic: auth === 'auto', appId: auth === 'manual' ? appId : undefined, secret: auth === 'manual' ? secret : undefined }, admin);
      } else if (type === 'dockerregistry') createAcrConnection(p, name, target, admin);
      else createKubernetesConnection(p, name, target, admin);
    }, `Conexión de servicio ${name} creada`);
    if (ok) closePane();
  };
  return (
    <>
      <div className="pane-body">
        <Field stack label="Tipo de conexión">
          <Select value={type} onChange={(v) => { setType(v as any); setTarget(''); setName(v === 'azurerm' ? 'sc-azure-lab' : v === 'dockerregistry' ? 'sc-acr' : 'sc-aks'); }} options={[{ value: 'azurerm', label: 'Azure Resource Manager' }, { value: 'dockerregistry', label: 'Docker Registry (Azure Container Registry)' }, { value: 'kubernetes', label: 'Kubernetes (AKS)' }]} />
        </Field>
        {type === 'azurerm' ? (
          <>
            <Field stack label="Tipo de identidad">
              <Radio value={auth} onChange={setAuth} options={[{ value: 'auto', label: 'Registro de aplicación (automático)', help: 'Azure DevOps crea la entidad de servicio y le asigna el rol Contributor en el ámbito elegido (federación de identidades de carga de trabajo).' }, { value: 'manual', label: 'Entidad de servicio existente (manual)', help: 'Usa el appId y el secreto de un SP creado con az ad sp create-for-rbac.' }]} />
            </Field>
            {auth === 'manual' ? (
              <>
                <Field stack label="Id. de la entidad de servicio (appId)" required>
                  <TextInput value={appId} onChange={setAppId} mono />
                </Field>
                <Field stack label="Clave (secreto)" required>
                  <TextInput value={secret} onChange={setSecret} type="password" />
                </Field>
              </>
            ) : null}
            <Field stack label="Nivel de ámbito">
              <Select value={level} onChange={(v) => setLevel(v as any)} options={[{ value: 'sub', label: 'Suscripción' }, { value: 'rg', label: 'Grupo de recursos (recomendado: mínimo privilegio)' }]} />
            </Field>
            <Field stack label="Suscripción">
              <Select value={sub} onChange={setSub} options={s.subscriptions.map((x) => ({ value: x.id, label: x.displayName }))} />
            </Field>
            {level === 'rg' ? (
              <Field stack label="Grupo de recursos">
                <Select value={rg} onChange={setRg} options={[{ value: '', label: 'Selecciona...' }, ...s.resourceGroups.filter((g) => g.subscriptionId === sub).map((g) => g.name)]} />
              </Field>
            ) : null}
          </>
        ) : (
          <Field stack label={type === 'dockerregistry' ? 'Registro de contenedor' : 'Clúster'} required>
            <Select value={target} onChange={setTarget} options={[{ value: '', label: 'Selecciona...' }, ...(type === 'dockerregistry' ? regs : clusters).map((r) => ({ value: r.id, label: `${r.name} (${r.resourceGroup})` }))]} />
          </Field>
        )}
        <Field stack label="Nombre de la conexión de servicio" required help="Es el valor que pondrás en el YAML (azureSubscription, containerRegistry, kubernetesServiceConnection).">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Checkbox checked onChange={() => undefined} label="Conceder permiso de acceso a todas las canalizaciones" />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={!name || (type === 'azurerm' ? (level === 'rg' && !rg) || (auth === 'manual' && (!appId || !secret)) : !target)} onClick={create}>
          Guardar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function ServiceConnections({ p }: { p: DevOpsProject }) {
  useCloud();
  const typeLabel: Record<ServiceConnection['type'], string> = { azurerm: 'Azure Resource Manager', dockerregistry: 'Docker Registry', kubernetes: 'Kubernetes' };
  return (
    <div className="ado-body">
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 20 }}>Conexiones de servicio</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => openPane({ title: 'Nueva conexión de servicio', width: 600, render: () => <NewServiceConnection p={p} /> })}>
          Nueva conexión de servicio
        </button>
      </div>
      <Callout>Una conexión de servicio guarda cómo se autentica el pipeline contra Azure (una entidad de servicio con un rol en un ámbito). Los pipelines nunca usan tu usuario: usan esta identidad, así que sus permisos (RBAC) determinan qué pueden desplegar.</Callout>
      <DataTable
        rows={p.serviceConnections}
        rowKey={(c) => c.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (c) => <b>{c.name}</b> },
          { key: 't', title: 'Tipo', render: (c) => typeLabel[c.type] },
          { key: 'a', title: 'Autenticación', render: (c) => c.authScheme },
          { key: 's', title: 'Ámbito / destino', render: (c) => <span className="small mono">{c.scope ?? c.registryId?.split('/').pop() ?? c.clusterId?.split('/').pop()}</span> },
          { key: 'sp', title: 'Entidad de servicio (appId)', render: (c) => <span className="mono small">{c.servicePrincipalAppId}</span> },
          { key: 'x', title: '', render: (c) => <button className="btn small" onClick={async () => (await confirmDialog({ title: 'Eliminar conexión', message: `¿Eliminar ${c.name}? Los pipelines que la usan fallarán.`, confirmText: 'Eliminar', danger: true })) && ((p.serviceConnections = p.serviceConnections.filter((x) => x.id !== c.id)), changed())}>Eliminar</button> },
        ]}
        empty="No hay conexiones de servicio."
      />
    </div>
  );
}

// ---------------------------------------------------------------- estructura

function ProjectNav({ p, area }: { p: DevOpsProject; area: string }) {
  const route = useRoute();
  const repo = route.parts[3] ?? p.repos[0]?.name ?? '';
  const sub = route.parts[4] ?? 'files';
  const items: [string, string, string][] = [
    ['', 'Información general', 'overview'],
    ['/boards', 'Boards', 'boards'],
    ['/repos', 'Repos', 'git'],
    ['/pipelines', 'Pipelines', 'pipeline'],
  ];
  return (
    <nav className="ado-nav">
      <div className="proj">
        <span className="proj-icon" style={{ background: projColor(p) }}>
          {p.name[0].toUpperCase()}
        </span>
        {p.name}
      </div>
      {items.map(([href, label, icon]) => (
        <div key={label}>
          <a href={pHref(p, href)} className={area === (href.slice(1) || 'overview') ? 'active' : ''}>
            <Icon name={icon} style={{ color: 'var(--accent)' }} />
            {label}
          </a>
          {href === '/repos' && area === 'repos'
            ? [
                ['files', 'Archivos'],
                ['commits', 'Commits'],
                ['branches', 'Ramas'],
                ['prs', 'Pull requests'],
                ['policies', 'Directivas de rama'],
              ].map(([id, l]) => (
                <a key={id} className={`sub${sub === id ? ' active' : ''}`} href={pHref(p, `/repos/${encodeURIComponent(repo)}/${id}`)}>
                  {l}
                </a>
              ))
            : null}
          {href === '/pipelines' && ['pipelines', 'environments', 'library'].includes(area)
            ? [
                ['/pipelines', 'Pipelines', 'pipelines'],
                ['/environments', 'Entornos', 'environments'],
                ['/library', 'Library', 'library'],
              ].map(([h, l, a]) => (
                <a key={h} className={`sub${area === a ? ' active' : ''}`} href={pHref(p, h)}>
                  {l}
                </a>
              ))
            : null}
        </div>
      ))}
      <div className="sidenav-sep" />
      <a href={pHref(p, '/settings')} className={area === 'settings' ? 'active' : ''}>
        <Icon name="settings2" style={{ color: 'var(--text-2)' }} />
        Configuración del proyecto
      </a>
    </nav>
  );
}

export function DevOpsApp() {
  const s = useCloud();
  const route = useRoute();
  const u = useUi();
  const projName = route.parts[1];
  const p = projName ? s.devops.projects.find((x) => x.name.toLowerCase() === projName.toLowerCase()) : undefined;
  const area = route.parts[2] ?? 'overview';
  let body: ReactNode;
  if (!projName) body = <OrgHome />;
  else if (!p)
    body = (
      <div className="ado-body">
        <Empty title={`El proyecto "${projName}" no existe`}>
          <a href="#/devops">Volver a la organización</a>
        </Empty>
      </div>
    );
  else if (area === 'boards') body = <Boards p={p} />;
  else if (area === 'repos') body = <ReposPage p={p} />;
  else if (area === 'pipelines' && route.parts[3] === 'runs' && route.parts[4]) body = <RunDetail p={p} runId={route.parts[4]} />;
  else if (area === 'pipelines' && route.parts[3] === 'edit' && route.parts[4]) body = <PipelineEditor key={route.parts[4]} p={p} plId={route.parts[4]} />;
  else if (area === 'pipelines') body = <PipelinesList p={p} />;
  else if (area === 'environments') body = <Environments p={p} />;
  else if (area === 'library') body = <Library p={p} />;
  else if (area === 'settings') body = <ServiceConnections p={p} />;
  else body = <ProjectSummary p={p} />;
  return (
    <div className="ado">
      <div className="ado-top">
        <a className="ado-logo" href="#/devops">
          <ServiceIcon name="devops" size={24} /> Azure DevOps
        </a>
        <span className="ado-crumbs">
          <Icon name="chevron" size={10} /> <a href="#/devops">{org()}</a>
          {p ? (
            <>
              <Icon name="chevron" size={10} /> <a href={pHref(p)}>{p.name}</a>
            </>
          ) : null}
        </span>
        <span className="spacer" />
        <button className={`btn small${u.shellOpen ? ' primary' : ''}`} onClick={() => setUi({ shellOpen: !u.shellOpen })}>
          <Icon name="shell" size={14} /> Cloud Shell
        </button>
        <button className="btn small" onClick={() => navigate('/academy')}>
          🎓 Academia
        </button>
        <button className="btn small" onClick={() => navigate('/')}>
          Portal de Azure
        </button>
        <span className="avatar" title={s.me.upn}>
          {initials(s.me.displayName)}
        </span>
      </div>
      <div className="ado-main">
        {p ? <ProjectNav p={p} area={area} /> : null}
        {body}
      </div>
    </div>
  );
}

export const _devopsUi = { guid, useMemo };
