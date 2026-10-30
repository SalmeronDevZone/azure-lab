// Blades de App Service: aplicaciones web, ranuras y planes.
import { useEffect, useRef, useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, resourceHref, useTick } from '../../hooks';
import { openPane, closePane } from '../../uiStore';
import { Callout, CliBox, CodeBlock, CommandBar, DataTable, Field, KeyValueEditor, Select, TextInput, Checkbox, confirmDialog, useAsync, StatusPill } from '../../components/common';
import { portalAction, cliText } from '../../portalCli';
import { appSettingsList, resolveSetting } from '../../../engine/services/web';
import { planOf, slotsOf, sitesOnPlan, runtimeLabel } from '../../../engine/providers/web';
import { APP_SERVICE_SKUS } from '../../../engine/catalog';
import { formatDate, formatMoney, relTime } from '../../../engine/util';
import { openUrl } from '../../terminal/controller';
import { getState } from '../../../engine/store';
import { makeZip } from '../../../shell/fs';
import { riskyFiles } from '../../../engine/fileRules';
import type { TypeBlade } from './shared';
import { MetricsSection, Props } from './shared';

const isSlot = (r: Resource) => r.type.toLowerCase() === 'microsoft.web/sites/slots';
const siteName = (r: Resource) => (isSlot(r) ? r.name.split('/')[0] : r.name);
const slotName = (r: Resource) => (isSlot(r) ? r.name.split('/')[1] : undefined);
const wa = (r: Resource) => ['-g', r.resourceGroup, '-n', siteName(r), ...(isSlot(r) ? ['--slot', slotName(r)!] : [])];

function SiteOverview({ r }: { r: Resource }) {
  const s = useCloud();
  const plan = planOf(r, s);
  const url = `https://${r.properties.defaultHostName}`;
  const last = r.data?.deployments?.[0];
  return (
    <>
      {r.properties.state !== 'Running' ? <Callout kind="warn">La aplicación está detenida: devuelve el error 403 "Site Disabled" hasta que la inicies.</Callout> : null}
      {!r.data?.content ? (
        <Callout title="Todavía no has desplegado código">
          La aplicación muestra la página predeterminada de App Service. Despliega con <code>az webapp deploy</code> (zip), desde el Centro de implementación o con un pipeline de Azure DevOps.
        </Callout>
      ) : null}
      <div className="grid2">
        <div>
          <h3 className="section-title">Aplicación web</h3>
          <Props
            rows={[
              ['Dominio predeterminado', <a onClick={() => openUrl(url)}>{r.properties.defaultHostName}</a>],
              ['Estado', <StatusPill status={r.properties.state === 'Running' ? 'En ejecución' : 'Detenida'} />],
              ['Pila', runtimeLabel(r)],
              ['Solo HTTPS', r.properties.httpsOnly ? 'Activado' : 'Desactivado'],
              ['Identidad administrada', r.identity?.principalId ? 'Asignada por el sistema' : 'Desactivada'],
            ]}
          />
        </div>
        <div>
          <h3 className="section-title">Hospedaje e implementación</h3>
          <Props
            rows={[
              ['Plan de App Service', plan ? <a href={resourceHref(plan.id)}>{`${plan.name} (${plan.sku?.name})`}</a> : '—'],
              ['Sistema operativo', r.properties.reserved ? 'Linux' : 'Windows'],
              ['Última implementación', last ? `${relTime(last.end_time)} · ${last.deployer}` : 'Ninguna'],
              ['Versión desplegada', r.data?.content ? `v${r.data.content.version} (${Object.keys(r.data.content.files ?? {}).length} ficheros)` : '—'],
              ['IP de salida', <span className="mono small">{r.properties.outboundIpAddresses}</span>],
            ]}
          />
        </div>
      </div>
    </>
  );
}

/** Herramientas avanzadas (Kudu): lo que hay realmente en /home/site/wwwroot tras desplegar. */
function KuduFiles({ r }: { r: Resource }) {
  useCloud();
  const [sel, setSel] = useState<string | null>(null);
  const files: Record<string, string> = r.data?.content?.files ?? {};
  const names = Object.keys(files).sort();
  const risky = riskyFiles(names);
  const flag = (n: string) => risky.find((x) => x.path === n || (x.path.endsWith('/') && n.startsWith(x.path)));
  const host = String(r.properties.defaultHostName ?? '').replace('.azurewebsites.net', '.scm.azurewebsites.net');
  return (
    <>
      <p className="muted small">
        Kudu (<span className="mono">https://{host}</span>) muestra el sistema de ficheros de la aplicación. Lo que ves en <span className="mono">/home/site/wwwroot</span> es exactamente lo que desplegaste: App Service no quita ni añade nada.
      </p>
      {risky.filter((x) => x.kind === 'secreto').length ? (
        <Callout kind="bad" title="El despliegue incluye ficheros que nunca deberían llegar a producción">
          {risky
            .filter((x) => x.kind === 'secreto')
            .map((x) => `${x.path} (${x.why})`)
            .join(' · ')}
          . Cualquiera con acceso a Kudu o al paquete puede leerlos. Exclúyelos del paquete, vuelve a desplegar y considera comprometidos los secretos que contenían. <a href="#/academy/ficheros">Guía de ficheros</a>
        </Callout>
      ) : names.length ? (
        <Callout kind="ok">El paquete no contiene ficheros sensibles conocidos (.env, claves privadas, local.settings.json, .git...).</Callout>
      ) : null}
      {risky.some((x) => x.kind === 'sobra') ? <Callout kind="warn">El paquete incluye node_modules/: funciona si se instaló en Linux, pero lo habitual es que lo instale el pipeline o la compilación en el servidor (SCM_DO_BUILD_DURING_DEPLOYMENT=true).</Callout> : null}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 340, flex: '0 0 340px' }}>
          <DataTable
            rows={names}
            rowKey={(n) => n}
            onRowClick={(n) => setSel(n)}
            columns={[
              { key: 'n', title: '/home/site/wwwroot', render: (n) => <span className="mono small" style={{ fontWeight: n === sel ? 600 : 400 }}>{n}</span> },
              { key: 's', title: 'Tamaño', render: (n) => `${files[n].length} B` },
              { key: 'f', title: '', render: (n) => { const x = flag(n); return x ? <span className={`pill ${x.kind === 'secreto' ? 'bad' : 'warn'}`}>{x.kind === 'secreto' ? 'Sensible' : 'Sobra'}</span> : null; } },
            ]}
            empty="Todavía no hay nada desplegado."
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>{sel && files[sel] !== undefined ? <CodeBlock code={files[sel]} maxHeight={420} /> : <div className="muted small">Selecciona un fichero para ver su contenido.</div>}</div>
      </div>
    </>
  );
}

function DeploymentCenter({ r }: { r: Resource }) {
  useCloud();
  const fileRef = useRef<HTMLInputElement>(null);
  const deps: any[] = r.data?.deployments ?? [];
  const deployFiles = async (files: FileList) => {
    const map: Record<string, string> = {};
    for (const f of Array.from(files)) map[(f as any).webkitRelativePath ? (f as any).webkitRelativePath.split('/').slice(1).join('/') : f.name] = await f.text();
    const zip = makeZip(map);
    await portalAction('Implementar (zip)', ['webapp', 'deploy', ...wa(r), '--src-path', '/home/portal/deploy/app.zip', '--type', 'zip'], { files: { 'deploy/app.zip': zip }, subscription: r.subscriptionId, success: `Implementación completada en ${siteName(r)}` });
  };
  return (
    <>
      <p>App Service admite varias formas de desplegar: paquete zip (<code>az webapp deploy</code>), Azure Pipelines / GitHub Actions (CI/CD), contenedores, FTP... En el simulador puedes desplegar desde Cloud Shell, desde un pipeline o subiendo aquí los ficheros de la app.</p>
      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button className="btn primary" onClick={() => fileRef.current?.click()}>
          <span>Subir ficheros y desplegar</span>
        </button>
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => e.target.files && deployFiles(e.target.files).then(() => (e.target.value = ''))} />
      </div>
      <CliBox cmd={`cd ~/samples/app-node && zip -r app.zip . && az webapp deploy ${wa(r).join(' ')} --src-path app.zip --type zip`} />
      <h3 className="section-title">Registros de implementación</h3>
      <DataTable
        rows={deps}
        rowKey={(d) => d.id}
        columns={[
          { key: 't', title: 'Hora', render: (d) => formatDate(d.end_time) },
          { key: 's', title: 'Estado', render: (d) => <span className={`pill ${d.status === 4 ? 'ok' : 'bad'}`}>{d.status === 4 ? 'Correcto' : 'Error'}{d.active ? ' (activa)' : ''}</span> },
          { key: 'b', title: 'Implementado por', render: (d) => d.deployer },
          { key: 'm', title: 'Mensaje', render: (d) => d.message },
        ]}
        empty="Sin implementaciones."
      />
    </>
  );
}

function AppSettings({ r }: { r: Resource }) {
  useCloud();
  const current = appSettingsList(r);
  const [rows, setRows] = useState<[string, string][]>(current.map((x: any) => [x.name, x.value]));
  const [sticky, setSticky] = useState<string[]>(current.filter((x: any) => x.slotSetting).map((x: any) => x.name));
  const [show, setShow] = useState(false);
  const { busy, run } = useAsync();
  useEffect(() => {
    setRows(appSettingsList(r).map((x: any) => [x.name, x.value]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.properties.siteConfig?.appSettings?.length]);
  const valid = rows.filter(([k]) => k.trim());
  const normal = valid.filter(([k]) => !sticky.includes(k));
  const slotS = valid.filter(([k]) => sticky.includes(k));
  const removed = current.map((x: any) => x.name).filter((n: string) => !valid.some(([k]) => k === n));
  const setArgs = ['webapp', 'config', 'appsettings', 'set', ...wa(r), ...(normal.length ? ['--settings', ...normal.map(([k, v]) => `${k}=${v}`)] : []), ...(slotS.length ? ['--slot-settings', ...slotS.map(([k, v]) => `${k}=${v}`)] : [])];
  const save = () =>
    run(async () => {
      if (removed.length) await portalAction('Eliminar configuración', ['webapp', 'config', 'appsettings', 'delete', ...wa(r), '--setting-names', ...removed], { subscription: r.subscriptionId, quiet: true });
      if (valid.length) await portalAction('Guardar configuración', setArgs, { subscription: r.subscriptionId, success: 'Configuración de la aplicación guardada (la aplicación se reinicia)' });
    });
  return (
    <>
      <p>
        La configuración de la aplicación se expone a tu código como <b>variables de entorno</b> (en Node: <code>process.env.NOMBRE</code>). Para secretos, usa referencias a Key Vault: <code>@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/clave/)</code> con una identidad administrada.
      </p>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button className="btn small" onClick={() => setShow(!show)}>
          {show ? 'Ocultar valores' : 'Mostrar valores'}
        </button>
      </div>
      <div style={{ maxWidth: 900 }}>
        <KeyValueEditor value={rows.map(([k, v]) => [k, show || !v ? v : v]) as [string, string][]} onChange={setRows} />
      </div>
      {valid.length ? (
        <>
          <h3 className="section-title">Estado de las referencias y ranuras</h3>
          <DataTable
            rows={valid}
            rowKey={(x) => x[0]}
            columns={[
              { key: 'n', title: 'Nombre', render: ([k]) => <b>{k}</b> },
              { key: 'v', title: 'Valor efectivo', render: ([, v]) => { if (!v.startsWith('@Microsoft.KeyVault')) return show ? v : '••••••'; const res = resolveSetting(r, v); return res.resolved ? <span className="pill ok">Referencia de Key Vault resuelta</span> : <span className="pill bad" title={res.error}>Error: {res.error}</span>; } },
              { key: 's', title: 'Valor de ranura (sticky)', render: ([k]) => <Checkbox checked={sticky.includes(k)} onChange={(c) => setSticky(c ? [...sticky, k] : sticky.filter((x) => x !== k))} label="" /> },
            ]}
          />
        </>
      ) : null}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={save}>
          Guardar
        </button>
      </div>
      {valid.length ? (
        <div style={{ marginTop: 12 }}>
          <CliBox cmd={cliText(setArgs)} />
        </div>
      ) : null}
    </>
  );
}

function GeneralSettings({ r }: { r: Resource }) {
  useCloud();
  const [https, setHttps] = useState(!!r.properties.httpsOnly);
  const [alwaysOn, setAlwaysOn] = useState(!!r.properties.siteConfig?.alwaysOn);
  const [startup, setStartup] = useState(r.properties.siteConfig?.appCommandLine ?? '');
  const { busy, run } = useAsync();
  return (
    <div style={{ maxWidth: 860 }}>
      <Field label="Pila">
        <span>{runtimeLabel(r)}</span>
      </Field>
      <Field label="Comando de inicio" help="Opcional. Por ejemplo: node server.js o gunicorn app:app">
        <TextInput value={startup} onChange={setStartup} mono />
      </Field>
      <Field label="AlwaysOn" help="Mantiene la app cargada (no disponible en el plan gratuito F1).">
        <Checkbox checked={alwaysOn} onChange={setAlwaysOn} label={alwaysOn ? 'Activado' : 'Desactivado'} />
      </Field>
      <Field label="Solo HTTPS" help="Redirige todo el tráfico HTTP a HTTPS.">
        <Checkbox checked={https} onChange={setHttps} label={https ? 'Activado' : 'Desactivado'} />
      </Field>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await portalAction('Guardar configuración general', ['webapp', 'config', 'set', ...wa(r), '--always-on', String(alwaysOn), ...(startup ? ['--startup-file', startup] : [])], { subscription: r.subscriptionId, quiet: true });
              await portalAction('Solo HTTPS', ['webapp', 'update', ...wa(r), '--https-only', String(https)], { subscription: r.subscriptionId, success: 'Configuración general guardada' });
            })
          }
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

function NewSlot({ r }: { r: Resource }) {
  const [name, setName] = useState('staging');
  const [clone, setClone] = useState(true);
  const { busy, run } = useAsync();
  const args = ['webapp', 'deployment', 'slot', 'create', '-g', r.resourceGroup, '-n', r.name, '--slot', name, ...(clone ? ['--configuration-source', r.name] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required help={`URL: https://${r.name}-${name}.azurewebsites.net`}>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Checkbox checked={clone} onChange={setClone} label={`Clonar la configuración de ${r.name}`} />
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name} onClick={() => run(async () => (await portalAction('Agregar ranura', args, { subscription: r.subscriptionId, success: `Ranura ${name} creada` })) && closePane())}>
          Agregar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function Slots({ r }: { r: Resource }) {
  const s = useCloud();
  const plan = planOf(r, s);
  const sku = APP_SERVICE_SKUS.find((x) => x.name === plan?.sku?.name);
  const slots = slotsOf(r, s);
  const routing: Record<string, number> = r.data?.routing ?? {};
  const [swapFrom, setSwapFrom] = useState(slots[0] ? slots[0].name.split('/')[1] : '');
  const { busy, run } = useAsync();
  const [pct, setPct] = useState<Record<string, string>>(Object.fromEntries(slots.map((x) => [x.name.split('/')[1], String(routing[x.name.split('/')[1]] ?? 0)])));
  if (!sku?.slots) {
    return (
      <Callout kind="warn" title="Las ranuras de implementación no están disponibles en este plan">
        El plan <b>{plan?.sku?.name}</b> no admite ranuras. Escala el plan a Estándar (S1) o Premium (P1v3) para usarlas.
      </Callout>
    );
  }
  const total = Object.values(pct).reduce((a, b) => a + Number(b || 0), 0);
  return (
    <>
      <p>Las ranuras son entornos en vivo (p. ej. <i>staging</i>) con su propio nombre de host. Despliega en staging, pruébalo y después <b>intercámbialo</b> con producción sin tiempo de inactividad.</p>
      <CommandBar
        items={[
          { label: 'Agregar ranura', icon: 'add', onClick: () => openPane({ title: 'Agregar una ranura', render: () => <NewSlot r={r} /> }) },
          { label: 'Intercambiar', icon: 'refresh', disabled: !slots.length, onClick: () => swapFrom && run(() => portalAction('Intercambiar ranuras', ['webapp', 'deployment', 'slot', 'swap', '-g', r.resourceGroup, '-n', r.name, '--slot', swapFrom, '--target-slot', 'production'], { subscription: r.subscriptionId, success: `Intercambio ${swapFrom} ⇄ production completado` })) },
        ]}
      />
      <DataTable
        rows={[{ name: r.name, host: r.properties.defaultHostName, state: r.properties.state, prod: true } as any, ...slots.map((x) => ({ name: x.name, host: x.properties.defaultHostName, state: x.properties.state, prod: false, id: x.id }))]}
        rowKey={(x: any) => x.name}
        columns={[
          { key: 'n', title: 'Nombre', render: (x: any) => (x.prod ? <b>{x.name} (producción)</b> : <a href={resourceHref(x.id)}>{x.name.split('/')[1]}</a>) },
          { key: 'h', title: 'Host', render: (x: any) => <a onClick={() => openUrl(`https://${x.host}`)}>{x.host}</a> },
          { key: 's', title: 'Estado', render: (x: any) => <StatusPill status={x.state === 'Running' ? 'En ejecución' : 'Detenida'} /> },
          { key: 'p', title: '% de tráfico', render: (x: any) => (x.prod ? `${Math.max(0, 100 - total)} %` : <input className="input" style={{ width: 70 }} value={pct[x.name.split('/')[1]] ?? '0'} onChange={(e) => setPct({ ...pct, [x.name.split('/')[1]]: e.target.value })} />) },
        ]}
      />
      <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
        <span>Intercambiar</span>
        <div style={{ width: 180 }}>
          <Select value={swapFrom} onChange={setSwapFrom} options={slots.map((x) => x.name.split('/')[1])} />
        </div>
        <span>con production</span>
        <span className="spacer" />
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            const dist = Object.entries(pct).filter(([, v]) => Number(v) > 0);
            run(() => (dist.length ? portalAction('Enrutamiento de tráfico', ['webapp', 'traffic-routing', 'set', '-g', r.resourceGroup, '-n', r.name, '-d', ...dist.map(([k, v]) => `${k}=${v}`)], { subscription: r.subscriptionId, success: 'Enrutamiento de tráfico actualizado' }) : portalAction('Enrutamiento de tráfico', ['webapp', 'traffic-routing', 'clear', '-g', r.resourceGroup, '-n', r.name], { subscription: r.subscriptionId, success: 'Todo el tráfico va a producción' })));
          }}
        >
          Guardar % de tráfico
        </button>
      </div>
    </>
  );
}

function SiteIdentity({ r }: { r: Resource }) {
  useCloud();
  const on = !!r.identity?.principalId;
  return (
    <>
      <p>Con una identidad administrada asignada por el sistema, la aplicación puede acceder a Key Vault, Storage o SQL sin guardar contraseñas. Después, asígnale un rol (p. ej. <i>Key Vault Secrets User</i>) en el recurso destino.</p>
      <Props rows={[['Estado', on ? 'Activado' : 'Desactivado'], ['Id. de objeto (principal)', on ? <span className="mono">{r.identity!.principalId}</span> : '—']]} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        {on ? (
          <button
            className="btn"
            onClick={async () => {
              if (await confirmDialog({ title: 'Desactivar identidad', message: 'Se eliminará la identidad y sus asignaciones de roles. Las referencias a Key Vault dejarán de resolverse.', confirmText: 'Desactivar', danger: true }))
                await portalAction('Desactivar identidad', ['webapp', 'identity', 'remove', ...wa(r)], { subscription: r.subscriptionId, success: 'Identidad desactivada' });
            }}
          >
            Desactivar
          </button>
        ) : (
          <button className="btn primary" onClick={() => portalAction('Activar identidad administrada', ['webapp', 'identity', 'assign', ...wa(r)], { subscription: r.subscriptionId, success: 'Identidad asignada por el sistema activada' })}>
            Activar identidad asignada por el sistema
          </button>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        <CliBox cmd={`az webapp identity assign ${wa(r).join(' ')}`} />
      </div>
    </>
  );
}

function LogStream({ r }: { r: Resource }) {
  useCloud();
  useTick(2000);
  const logs: string[] = getState().resources.find((x) => x.id === r.id)?.data?.logs ?? [];
  return (
    <>
      <p className="muted">Registros de la aplicación y de la plataforma (arranque del contenedor, despliegues, reinicios). Equivale a <code>az webapp log tail</code>.</p>
      <CodeBlock code={logs.length ? logs.slice(-200).join('\n') : 'Conectado. Esperando registros...'} maxHeight={520} />
    </>
  );
}

function ScaleUp({ r }: { r: Resource }) {
  useCloud();
  const [sel, setSel] = useState(r.sku?.name ?? 'B1');
  const [workers, setWorkers] = useState(String(r.sku?.capacity ?? 1));
  const { busy, run } = useAsync();
  const cur = APP_SERVICE_SKUS.find((x) => x.name === sel);
  const args = ['appservice', 'plan', 'update', '-g', r.resourceGroup, '-n', r.name, '--sku', sel, '--number-of-workers', workers];
  return (
    <>
      <p><b>Escalar verticalmente</b> (scale up) cambia el nivel del plan: más CPU/memoria y funciones (ranuras, escalado automático). <b>Escalar horizontalmente</b> (scale out) añade instancias.</p>
      <DataTable
        rows={APP_SERVICE_SKUS}
        rowKey={(x) => x.name}
        onRowClick={(x) => setSel(x.name)}
        columns={[
          { key: 's', title: '', render: (x) => <input type="radio" checked={sel === x.name} readOnly /> },
          { key: 'n', title: 'Plan', render: (x) => <b>{x.name}</b> },
          { key: 'd', title: 'Descripción', render: (x) => x.description },
          { key: 'c', title: 'Núcleos / RAM', render: (x) => `${x.cores} / ${x.memoryGB} GB` },
          { key: 'sl', title: 'Ranuras', render: (x) => x.slots || '—' },
          { key: 'a', title: 'Autoescalado', render: (x) => (x.autoscale ? 'Sí' : '—') },
          { key: 'p', title: 'Coste/mes (1 instancia)', render: (x) => formatMoney(x.pricePerHour * 730) },
        ]}
      />
      <div className="row wrap" style={{ marginTop: 12, gap: 10 }}>
        <span>Instancias:</span>
        <input className="input" style={{ width: 80 }} value={workers} onChange={(e) => setWorkers(e.target.value)} />
        <span className="muted small">(máximo {cur?.maxWorkers})</span>
        <span className="spacer" />
        <button className="btn primary" disabled={busy} onClick={() => run(() => portalAction('Escalar el plan', args, { subscription: r.subscriptionId, success: `Plan escalado a ${sel} × ${workers}` }))}>
          Aplicar
        </button>
      </div>
      <div style={{ marginTop: 12 }}>
        <CliBox cmd={cliText(args)} />
      </div>
    </>
  );
}

function PlanApps({ r }: { r: Resource }) {
  const s = useCloud();
  const apps = sitesOnPlan(r, s);
  return <DataTable rows={apps} rowKey={(x) => x.id} columns={[{ key: 'n', title: 'Nombre', render: (x) => <a href={resourceHref(x.id)}>{x.name}</a> }, { key: 's', title: 'Estado', render: (x) => <StatusPill status={x.properties.state === 'Running' ? 'En ejecución' : 'Detenida'} /> }, { key: 't', title: 'Tipo', render: (x) => (x.type.toLowerCase().endsWith('slots') ? 'Ranura' : x.kind?.includes('functionapp') ? 'Function App' : 'Web App') }]} empty="No hay aplicaciones en este plan." />;
}

const siteCmd = (title: string, args: string[], r: Resource) => () => portalAction(title, args, { subscription: r.subscriptionId, success: `${title}: ${r.name}` });

const SITE: TypeBlade = {
  commands: (r) => [
    { label: 'Examinar', icon: 'open', onClick: () => openUrl(`https://${r.properties.defaultHostName}`) },
    { label: 'Detener', icon: 'stop', disabled: r.properties.state !== 'Running', onClick: siteCmd('Detener aplicación', ['webapp', 'stop', ...wa(r)], r) },
    { label: 'Iniciar', icon: 'play', disabled: r.properties.state === 'Running', onClick: siteCmd('Iniciar aplicación', ['webapp', 'start', ...wa(r)], r) },
    { label: 'Reiniciar', icon: 'restart', onClick: siteCmd('Reiniciar aplicación', ['webapp', 'restart', ...wa(r)], r) },
  ],
  Overview: SiteOverview,
  sections: [
    { id: 'deployment', label: 'Centro de implementación', icon: 'rocket', group: 'Implementación', Comp: DeploymentCenter },
    { id: 'slots', label: 'Ranuras de implementación', icon: 'branch', group: 'Implementación', Comp: Slots },
    { id: 'appsettings', label: 'Variables de entorno', icon: 'settings2', group: 'Configuración', Comp: AppSettings },
    { id: 'general', label: 'Configuración general', icon: 'settings2', group: 'Configuración', Comp: GeneralSettings },
    { id: 'identity', label: 'Identidad', icon: 'key', group: 'Configuración', Comp: SiteIdentity },
    { id: 'logstream', label: 'Secuencia de registro', icon: 'activity', group: 'Supervisión', Comp: LogStream },
    { id: 'kudu', label: 'Herramientas avanzadas (Kudu)', icon: 'folder', group: 'Herramientas de desarrollo', Comp: KuduFiles },
    { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
  ],
  cli: (r) => [
    { label: 'Desplegar un zip', cmd: `az webapp deploy ${wa(r).join(' ')} --src-path app.zip --type zip` },
    { label: 'Configurar una variable de entorno', cmd: `az webapp config appsettings set ${wa(r).join(' ')} --settings GREETING="Hola"` },
    { label: 'Ver los registros en directo', cmd: `az webapp log tail ${wa(r).join(' ')}` },
  ],
};

export const WEB_BLADES: Record<string, TypeBlade> = {
  'microsoft.web/sites': SITE,
  'microsoft.web/sites/slots': { ...SITE, sections: SITE.sections!.filter((x) => x.id !== 'slots') },
  'microsoft.web/serverfarms': {
    Overview: ({ r }) => {
      const s = useCloud();
      const sku = APP_SERVICE_SKUS.find((x) => x.name === r.sku?.name);
      return (
        <Props
          rows={[
            ['Plan de tarifa', `${r.sku?.name} · ${sku?.description ?? ''}`],
            ['Instancias', String(r.sku?.capacity ?? 1)],
            ['Sistema operativo', r.properties.reserved ? 'Linux' : 'Windows'],
            ['Aplicaciones', String(sitesOnPlan(r, s).length)],
            ['Coste estimado', formatMoney((sku?.pricePerHour ?? 0) * 730 * (r.sku?.capacity ?? 1)) + ' / mes'],
          ]}
        />
      );
    },
    sections: [
      { id: 'apps', label: 'Aplicaciones', icon: 'webapp', group: 'Configuración', Comp: PlanApps },
      { id: 'scaleup', label: 'Escalar verticalmente', icon: 'chart', group: 'Configuración', Comp: ScaleUp },
      { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
    ],
    cli: (r) => [{ label: 'Escalar a S1 (permite ranuras)', cmd: `az appservice plan update -g ${r.resourceGroup} -n ${r.name} --sku S1` }],
  },
};
