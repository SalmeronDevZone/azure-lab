// Blades de proceso: máquinas virtuales y discos.
import { useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, resourceHref } from '../../hooks';
import { Callout, CliBox, CodeBlock, DataTable, Field, Select, StatusPill, TextInput, Checkbox, useAsync, confirmDialog } from '../../components/common';
import { portalAction, cliText } from '../../portalCli';
import { vmNetworkInfo, vmPowerState, powerStateLabel } from '../../../engine/providers/compute';
import { VM_SIZES } from '../../../engine/catalog';
import { findResource } from '../../../engine/arm';
import { ciEq, formatMoney } from '../../../engine/util';
import { terminal } from '../../terminal/controller';
import type { TypeBlade } from './shared';
import { MetricsSection, Props, gn } from './shared';
import { NsgRulesTable, openAddRule } from './network';

function VmOverview({ r }: { r: Resource }) {
  const s = useCloud();
  const net = vmNetworkInfo(r, s);
  const size = VM_SIZES.find((x) => x.name === r.properties.hardwareProfile?.vmSize);
  const ps = vmPowerState(r);
  return (
    <>
      {ps === 'stopped' ? (
        <Callout kind="warn" title="La VM está detenida pero sigue asignada">
          Al apagarla desde dentro del sistema operativo (o con <code>az vm stop</code>) sigues pagando el proceso. Usa <b>Detener</b> en el portal o <code>az vm deallocate</code> para liberar el hardware y dejar de pagarlo.
        </Callout>
      ) : null}
      <div className="grid2">
        <div>
          <h3 className="section-title">Máquina virtual</h3>
          <Props
            rows={[
              ['Nombre del equipo', r.properties.osProfile?.computerName],
              ['Sistema operativo', `${r.data?.osType ?? ''} (${r.data?.image?.label ?? r.properties.storageProfile?.imageReference?.offer ?? ''})`],
              ['Estado', <StatusPill status={powerStateLabel(ps)} />],
              ['Usuario administrador', r.properties.osProfile?.adminUsername],
              ['Identidad administrada', r.identity?.principalId ? 'Asignada por el sistema' : 'Desactivada'],
            ]}
          />
        </div>
        <div>
          <h3 className="section-title">Tamaño y red</h3>
          <Props
            rows={[
              ['Tamaño', size ? `${size.name} (${size.vCPUs} vCPU, ${size.memoryGB} GiB)` : r.properties.hardwareProfile?.vmSize],
              ['Coste aproximado', size ? `${formatMoney(size.pricePerHour * 730)} / mes (sólo en ejecución)` : '—'],
              ['IP pública', net.publicIp ? <span className="mono">{net.publicIp}</span> : 'Ninguna'],
              ['IP privada', <span className="mono">{net.privateIp}</span>],
              ['Red/subred', net.vnet ? <a href={resourceHref(net.vnet.id)}>{`${net.vnet.name}/${net.subnet?.name}`}</a> : '—'],
            ]}
          />
        </div>
      </div>
    </>
  );
}

function VmConnect({ r }: { r: Resource }) {
  const s = useCloud();
  const net = vmNetworkInfo(r, s);
  const user = r.properties.osProfile?.adminUsername ?? 'azureuser';
  const host = net.publicIp ?? net.privateIp;
  const cmd = `ssh ${user}@${host}`;
  if (r.data?.osType === 'Windows') {
    return (
      <>
        <Callout title="Conexión RDP">Las VM Windows se administran por Escritorio remoto (puerto 3389). El simulador no incluye un cliente RDP: usa <b>Ejecutar comando</b> (PowerShell) para administrarla, por ejemplo instalar IIS con <code>Install-WindowsFeature -Name Web-Server</code>.</Callout>
        <Props rows={[['Dirección IP', host ?? '—'], ['Puerto', '3389'], ['Usuario', user]]} />
      </>
    );
  }
  return (
    <>
      <p>Conéctate a la VM por SSH desde Cloud Shell. Para que funcione, la VM debe estar en ejecución, tener una IP pública y el NSG debe permitir el puerto 22 desde tu IP.</p>
      <CliBox cmd={cmd} onRun={() => terminal.runCommand(cmd)} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!net.publicIp} onClick={() => terminal.runCommand(cmd)}>
          Conectar mediante Cloud Shell
        </button>
      </div>
      <h3 className="section-title">Comprobaciones</h3>
      <Props
        rows={[
          ['Estado de la VM', <StatusPill status={powerStateLabel(vmPowerState(r))} />],
          ['IP pública', net.publicIp ?? 'No tiene (sólo accesible desde la red virtual)'],
          ['Autenticación', r.properties.osProfile?.linuxConfiguration?.disablePasswordAuthentication === false ? 'Contraseña' : 'Clave SSH (~/.ssh/id_rsa de tu Cloud Shell)'],
        ]}
      />
    </>
  );
}

function VmNetworking({ r }: { r: Resource }) {
  const s = useCloud();
  const net = vmNetworkInfo(r, s);
  const nicNsg = net.nic?.properties.networkSecurityGroup?.id ? findResource(net.nic.properties.networkSecurityGroup.id) : undefined;
  const subnetNsg = net.subnet?.properties?.networkSecurityGroup?.id ? findResource(net.subnet.properties.networkSecurityGroup.id) : undefined;
  return (
    <>
      <Props
        rows={[
          ['Interfaz de red', net.nic ? <a href={resourceHref(net.nic.id)}>{net.nic.name}</a> : '—'],
          ['IP pública', net.publicIp ? <span className="mono">{net.publicIp}</span> : '—'],
          ['IP privada', <span className="mono">{net.privateIp}</span>],
          ['Red/subred', net.vnet ? `${net.vnet.name}/${net.subnet?.name}` : '—'],
        ]}
      />
      {!nicNsg && !subnetNsg ? <Callout kind="warn">No hay ningún NSG asociado: todo el tráfico entrante está permitido. Es recomendable proteger la VM con un NSG.</Callout> : null}
      {[
        ['Grupo de seguridad de red de la subred', subnetNsg],
        ['Grupo de seguridad de red de la interfaz', nicNsg],
      ].map(([label, nsg]) =>
        nsg ? (
          <div key={(nsg as Resource).id}>
            <h3 className="section-title row" style={{ gap: 10 }}>
              {label as string}: <a href={resourceHref((nsg as Resource).id)}>{(nsg as Resource).name}</a>
              <span className="spacer" />
              <button className="btn small primary" onClick={() => openAddRule(nsg as Resource, 'Inbound')}>
                Agregar regla de puerto de entrada
              </button>
            </h3>
            <NsgRulesTable nsg={nsg as Resource} direction="Inbound" />
          </div>
        ) : null,
      )}
      <Callout>Si la subred y la interfaz tienen NSG, el tráfico entrante debe permitirse en <b>los dos</b> (primero se evalúa el de la subred y después el de la NIC).</Callout>
    </>
  );
}

function VmSize({ r }: { r: Resource }) {
  useCloud();
  const cur = r.properties.hardwareProfile?.vmSize;
  const [sel, setSel] = useState(cur);
  const { busy, run } = useAsync();
  const args = ['vm', 'resize', ...gn(r), '--size', sel];
  return (
    <>
      <p className="muted">Cambiar el tamaño reinicia la VM. El coste depende del tamaño y sólo se cobra mientras está en ejecución.</p>
      <DataTable
        rows={VM_SIZES}
        rowKey={(x) => x.name}
        onRowClick={(x) => setSel(x.name)}
        columns={[
          { key: 'sel', title: '', render: (x) => <input type="radio" checked={sel === x.name} readOnly /> },
          { key: 'n', title: 'Tamaño de VM', render: (x) => <b>{x.name}</b> },
          { key: 'f', title: 'Familia', render: (x) => x.family },
          { key: 'c', title: 'vCPU', render: (x) => x.vCPUs },
          { key: 'm', title: 'RAM (GiB)', render: (x) => x.memoryGB },
          { key: 'd', title: 'Discos de datos', render: (x) => x.maxDataDisks },
          { key: 'p', title: 'Coste/mes', render: (x) => formatMoney(x.pricePerHour * 730) },
          { key: 'cur', title: '', render: (x) => (x.name === cur ? <span className="pill info">Actual</span> : null) },
        ]}
      />
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy || sel === cur} onClick={() => run(() => portalAction('Cambiar tamaño de la VM', args, { subscription: r.subscriptionId, success: `Tamaño cambiado a ${sel}` }))}>
          {busy ? 'Cambiando...' : 'Cambiar tamaño'}
        </button>
        <span className="mono small muted">{cliText(args)}</span>
      </div>
    </>
  );
}

function VmAutoShutdown({ r }: { r: Resource }) {
  useCloud();
  const cfg = r.data?.autoShutdown;
  const [on, setOn] = useState(!!cfg);
  const [time, setTime] = useState(cfg?.time ? `${cfg.time.slice(0, 2)}:${cfg.time.slice(2)}` : '19:00');
  const [email, setEmail] = useState(cfg?.email ?? '');
  const { busy, run } = useAsync();
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const args = on ? ['vm', 'auto-shutdown', ...gn(r), '--time', time.replace(':', ''), ...(email ? ['--email', email] : [])] : ['vm', 'auto-shutdown', ...gn(r), '--off'];
  const utcNow = new Date().toISOString().slice(11, 16);
  const dirty = on !== !!cfg || (on && (time.replace(':', '') !== cfg?.time || (email || null) !== (cfg?.email ?? null)));
  return (
    <div style={{ maxWidth: 640 }}>
      <Callout>
        Apaga y <b>desasigna</b> la VM todos los días a la misma hora: el truco más sencillo para no pagar por VM de desarrollo olvidadas encendidas. La hora es UTC (ahora son las <span className="mono">{utcNow}</span> UTC).
      </Callout>
      <Checkbox checked={on} onChange={setOn} label="Habilitar el apagado automático" />
      {on ? (
        <>
          <Field label="Hora de apagado programada (UTC)" required error={valid ? null : 'Formato HH:MM, p. ej. 19:00'}>
            <TextInput value={time} onChange={setTime} mono />
          </Field>
          <Field label="Correo de notificación" help="Recibirás un aviso en la bandeja simulada cuando se apague la VM.">
            <TextInput value={email} onChange={setEmail} placeholder="tu@correo" />
          </Field>
        </>
      ) : null}
      {cfg?.lastRun ? <div className="muted small">Última ejecución: {cfg.lastRun}</div> : null}
      <CliBox cmd={cliText(args)} />
      <button className="btn primary" style={{ marginTop: 10 }} disabled={busy || (on && !valid) || !dirty} onClick={() => run(() => portalAction('Configurar apagado automático', args, { subscription: r.subscriptionId, success: on ? `Apagado automático a las ${time} UTC` : 'Apagado automático deshabilitado' }))}>
        Guardar
      </button>
    </div>
  );
}

function VmRunCommand({ r }: { r: Resource }) {
  const win = r.data?.osType === 'Windows';
  const [script, setScript] = useState(win ? 'Install-WindowsFeature -Name Web-Server' : 'apt-get update\napt-get install -y nginx\nsystemctl status nginx --no-pager');
  const [out, setOut] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const args = ['vm', 'run-command', 'invoke', ...gn(r), '--command-id', win ? 'RunPowerShellScript' : 'RunShellScript', '--scripts', script];
  return (
    <>
      <p className="muted">Ejecuta un script dentro de la VM a través del agente de Azure (no necesita SSH ni puertos abiertos). Se ejecuta como {win ? 'administrador' : 'root'}.</p>
      <Field stack label={win ? 'Script de PowerShell' : 'Script de shell (bash)'}>
        <textarea className="textarea" rows={8} value={script} onChange={(e) => setScript(e.target.value)} />
      </Field>
      <div className="btn-row">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setOut(null);
              const res = await portalAction('Ejecutar comando', args, { subscription: r.subscriptionId, quiet: true });
              if (res) {
                const msg = res.json?.value?.map((v: any) => v.message).join('\n') ?? res.out;
                setOut(msg);
              }
            })
          }
        >
          {busy ? 'Ejecutando...' : 'Ejecutar'}
        </button>
      </div>
      {out !== null ? (
        <>
          <h3 className="section-title">Salida</h3>
          <CodeBlock code={out} wrap />
        </>
      ) : null}
    </>
  );
}

function VmDisks({ r }: { r: Resource }) {
  const s = useCloud();
  const os = r.properties.storageProfile?.osDisk;
  const data = r.properties.storageProfile?.dataDisks ?? [];
  const rows = [{ ...os, kind: 'SO' }, ...data.map((d: any) => ({ ...d, kind: 'Datos' }))].filter(Boolean);
  return (
    <DataTable
      rows={rows}
      rowKey={(d: any) => d.name}
      columns={[
        { key: 'n', title: 'Nombre del disco', render: (d: any) => (d.managedDisk?.id && findResource(d.managedDisk.id) ? <a href={resourceHref(d.managedDisk.id)}>{d.name}</a> : d.name) },
        { key: 'k', title: 'Tipo', render: (d: any) => d.kind },
        { key: 'lun', title: 'LUN', render: (d: any) => d.lun ?? '—' },
        { key: 'sku', title: 'Tipo de almacenamiento', render: (d: any) => d.managedDisk?.storageAccountType ?? findResource(d.managedDisk?.id ?? '', s)?.sku?.name ?? '—' },
        { key: 'sz', title: 'Tamaño (GiB)', render: (d: any) => d.diskSizeGB ?? findResource(d.managedDisk?.id ?? '', s)?.properties.diskSizeGB ?? '—' },
      ]}
    />
  );
}

function VmIdentity({ r }: { r: Resource }) {
  useCloud();
  const on = !!r.identity?.principalId;
  return (
    <>
      <p>Una identidad administrada asignada por el sistema permite que el código de la VM se autentique en otros servicios de Azure (Key Vault, Storage...) sin guardar credenciales. Se borra junto con la VM.</p>
      <Props rows={[['Estado', on ? 'Activado' : 'Desactivado'], ['Id. de objeto (principal)', on ? <span className="mono">{r.identity!.principalId}</span> : '—']]} />
      <div className="btn-row" style={{ marginTop: 12 }}>
        {!on ? (
          <button className="btn primary" onClick={() => portalAction('Habilitar identidad administrada', ['vm', 'identity', 'assign', ...gn(r)], { subscription: r.subscriptionId, success: 'Identidad asignada por el sistema habilitada' })}>
            Activar identidad asignada por el sistema
          </button>
        ) : (
          <span className="muted">Para darle permisos, ve a <i>Control de acceso (IAM)</i> del recurso destino y asígnale un rol a la identidad "{r.name}".</span>
        )}
      </div>
    </>
  );
}

const vmCmd = (label: string, title: string, args: string[], r: Resource, confirm?: string) => async () => {
  if (confirm && !(await confirmDialog({ title, message: confirm, confirmText: label }))) return;
  await portalAction(title, args, { subscription: r.subscriptionId, success: `${title}: ${r.name}` });
};

export const COMPUTE_BLADES: Record<string, TypeBlade> = {
  'microsoft.compute/virtualmachines': {
    commands: (r) => {
      const ps = vmPowerState(r);
      return [
        { label: 'Conectar', icon: 'terminal', onClick: () => (location.hash = resourceHref(r.id, 'connect')) },
        { label: 'Iniciar', icon: 'play', disabled: ps === 'running' || ps === 'starting', onClick: vmCmd('Iniciar', 'Iniciar máquina virtual', ['vm', 'start', ...gn(r)], r) },
        { label: 'Reiniciar', icon: 'restart', disabled: ps !== 'running', onClick: vmCmd('Reiniciar', 'Reiniciar máquina virtual', ['vm', 'restart', ...gn(r)], r) },
        { label: 'Detener', icon: 'stop', disabled: ps === 'deallocated' || ps === 'deallocating', onClick: vmCmd('Detener', 'Detener (desasignar) máquina virtual', ['vm', 'deallocate', ...gn(r)], r, 'La VM se detendrá y se desasignará: dejarás de pagar el proceso. Si la IP pública es dinámica, puede cambiar.') },
      ];
    },
    Overview: VmOverview,
    sections: [
      { id: 'connect', label: 'Conectar', icon: 'terminal', group: 'Conectar', Comp: VmConnect },
      { id: 'networking', label: 'Redes', icon: 'network', group: 'Configuración', Comp: VmNetworking },
      { id: 'disks', label: 'Discos', icon: 'file', group: 'Configuración', Comp: VmDisks },
      { id: 'size', label: 'Tamaño', icon: 'chart', group: 'Configuración', Comp: VmSize },
      { id: 'identity', label: 'Identidad', icon: 'key', group: 'Configuración', Comp: VmIdentity },
      { id: 'autoshutdown', label: 'Apagado automático', icon: 'stop', group: 'Operaciones', Comp: VmAutoShutdown },
      { id: 'runcommand', label: 'Ejecutar comando', icon: 'code', group: 'Operaciones', Comp: VmRunCommand },
      { id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection },
    ],
    cli: (r) => [
      { label: 'Ver la IP pública', cmd: `az vm show -d ${gn(r).join(' ')} --query publicIps -o tsv` },
      { label: 'Abrir el puerto 80', cmd: `az vm open-port ${gn(r).join(' ')} --port 80` },
      { label: 'Desasignar (dejar de pagar el proceso)', cmd: `az vm deallocate ${gn(r).join(' ')}` },
    ],
  },
  'microsoft.compute/disks': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Tamaño', `${r.properties.diskSizeGB} GiB`],
          ['Tipo', r.sku?.name],
          ['Estado', r.properties.diskState],
          ['Sistema operativo', r.properties.osType ?? '—'],
          ['Propietario', r.managedBy ? <a href={resourceHref(r.managedBy)}>{r.managedBy.split('/').pop()}</a> : 'Sin conectar'],
        ]}
      />
    ),
  },
  'microsoft.compute/virtualmachinescalesets': {
    Overview: ({ r }) => <Props rows={[['Capacidad', String(r.sku?.capacity ?? 0)], ['Tamaño', r.sku?.name]]} />,
    sections: [{ id: 'metrics', label: 'Métricas', icon: 'chart', group: 'Supervisión', Comp: MetricsSection }],
  },
};

export function vmPowerLabel(r: Resource) {
  return ciEq(r.type, 'Microsoft.Compute/virtualMachines') ? powerStateLabel(vmPowerState(r)) : null;
}
