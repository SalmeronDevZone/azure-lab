// Blades de red: redes virtuales, NSG, IP públicas, interfaces de red y equilibradores de carga.
import { useState } from 'react';
import type { Resource } from '../../../engine/types';
import { useCloud, resourceHref } from '../../hooks';
import { openPane, closePane } from '../../uiStore';
import { CliBox, Callout, CommandBar, DataTable, Field, Select, TextInput, confirmDialog, useAsync, Checkbox } from '../../components/common';
import { portalAction, cliText } from '../../portalCli';
import { ruleValues, findSubnet } from '../../../engine/providers/network';
import { findResource } from '../../../engine/arm';
import { ciEq } from '../../../engine/util';
import type { TypeBlade } from './shared';
import { Props, gn } from './shared';

// ---------------------------------------------------------------- reglas NSG

function AddNsgRule({ nsg, direction, presetPort }: { nsg: Resource; direction: 'Inbound' | 'Outbound'; presetPort?: string }) {
  const existing = (nsg.properties.securityRules ?? []).filter((r: any) => r.properties.direction === direction).map((r: any) => r.properties.priority as number);
  const nextPrio = String(Math.max(100, ...existing.map((p: number) => p + 10)) > 4096 ? 4096 : existing.length ? Math.max(...existing) + 10 : 100);
  const [service, setService] = useState(presetPort ? 'Custom' : 'Custom');
  const [port, setPort] = useState(presetPort ?? '8080');
  const [source, setSource] = useState('*');
  const [proto, setProto] = useState('Tcp');
  const [access, setAccess] = useState('Allow');
  const [prio, setPrio] = useState(nextPrio);
  const [name, setName] = useState(`Allow-${direction === 'Inbound' ? 'In' : 'Out'}-${presetPort ?? '8080'}`);
  const { busy, run } = useAsync();
  const SERVICES: Record<string, string> = { HTTP: '80', HTTPS: '443', SSH: '22', RDP: '3389', 'MS SQL': '1433' };
  const args = ['network', 'nsg', 'rule', 'create', '-g', nsg.resourceGroup, '--nsg-name', nsg.name, '-n', name, '--priority', prio, '--direction', direction, '--access', access, '--protocol', proto, '--source-address-prefixes', source, '--destination-port-ranges', port];
  return (
    <>
      <div className="pane-body">
        <Field label="Origen">
          <Select
            value={source === '*' ? 'Any' : source === 'Internet' ? 'Internet' : 'ip'}
            onChange={(v) => setSource(v === 'Any' ? '*' : v === 'Internet' ? 'Internet' : '20.31.118.42')}
            options={[
              { value: 'Any', label: 'Cualquiera (*)' },
              { value: 'Internet', label: 'Etiqueta de servicio: Internet' },
              { value: 'ip', label: 'Direcciones IP' },
            ]}
          />
        </Field>
        {source !== '*' && source !== 'Internet' ? (
          <Field label="Direcciones IP o intervalos CIDR de origen" help="La IP pública de tu Cloud Shell simulado es 20.31.118.42 (compruébalo con curl ifconfig.me).">
            <TextInput value={source} onChange={setSource} mono />
          </Field>
        ) : null}
        <Field label="Servicio">
          <Select
            value={service}
            onChange={(v) => {
              setService(v);
              if (SERVICES[v]) {
                setPort(SERVICES[v]);
                setName(`Allow-${v.replace(/\s/g, '')}`);
              }
            }}
            options={['Custom', ...Object.keys(SERVICES)]}
          />
        </Field>
        <Field label="Intervalos de puertos de destino" required help="Un puerto (80), un intervalo (8000-8100) o * para todos.">
          <TextInput value={port} onChange={setPort} mono />
        </Field>
        <Field label="Protocolo">
          <Select value={proto} onChange={setProto} options={[{ value: '*', label: 'Cualquiera' }, 'Tcp', 'Udp', 'Icmp']} />
        </Field>
        <Field label="Acción">
          <Select
            value={access}
            onChange={setAccess}
            options={[
              { value: 'Allow', label: 'Permitir' },
              { value: 'Deny', label: 'Denegar' },
            ]}
          />
        </Field>
        <Field label="Prioridad" required help="100-4096. Cuanto menor el número, antes se evalúa la regla.">
          <TextInput value={prio} onChange={setPrio} />
        </Field>
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button
          className="btn primary"
          disabled={busy || !name || !port}
          onClick={() =>
            run(async () => {
              if (await portalAction('Crear regla de seguridad', args, { subscription: nsg.subscriptionId, success: `Regla ${name} creada en ${nsg.name}` })) closePane();
            })
          }
        >
          Agregar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

export function openAddRule(nsg: Resource, direction: 'Inbound' | 'Outbound' = 'Inbound', presetPort?: string) {
  openPane({ title: `Agregar regla de seguridad de ${direction === 'Inbound' ? 'entrada' : 'salida'}`, subtitle: nsg.name, render: () => <AddNsgRule nsg={nsg} direction={direction} presetPort={presetPort} /> });
}

export function NsgRulesTable({ nsg, direction, editable = true }: { nsg: Resource; direction: 'Inbound' | 'Outbound'; editable?: boolean }) {
  useCloud();
  const rules = [...(nsg.properties.securityRules ?? []).map((r: any) => ({ ...r, custom: true })), ...(nsg.properties.defaultSecurityRules ?? [])]
    .filter((r: any) => r.properties.direction === direction)
    .sort((a: any, b: any) => a.properties.priority - b.properties.priority);
  const del = async (name: string) => {
    if (!(await confirmDialog({ title: 'Eliminar regla', message: `¿Eliminar la regla ${name}?`, confirmText: 'Eliminar', danger: true }))) return;
    await portalAction('Eliminar regla de seguridad', ['network', 'nsg', 'rule', 'delete', '-g', nsg.resourceGroup, '--nsg-name', nsg.name, '-n', name], { subscription: nsg.subscriptionId, success: `Regla ${name} eliminada` });
  };
  return (
    <DataTable
      rows={rules}
      rowKey={(r: any) => r.name}
      columns={[
        { key: 'p', title: 'Prioridad', render: (r: any) => r.properties.priority },
        { key: 'n', title: 'Nombre', render: (r: any) => (r.custom ? <b>{r.name}</b> : <span className="muted">{r.name}</span>) },
        { key: 'port', title: 'Puerto', render: (r: any) => ruleValues(r, 'destinationPortRange').join(', ') || '*' },
        { key: 'pr', title: 'Protocolo', render: (r: any) => (r.properties.protocol === '*' ? 'Cualquiera' : r.properties.protocol) },
        { key: 's', title: 'Origen', render: (r: any) => ruleValues(r, 'sourceAddressPrefix').join(', ') },
        { key: 'd', title: 'Destino', render: (r: any) => ruleValues(r, 'destinationAddressPrefix').join(', ') },
        { key: 'a', title: 'Acción', render: (r: any) => <span className={`pill ${r.properties.access === 'Allow' ? 'ok' : 'bad'}`}>{r.properties.access === 'Allow' ? 'Permitir' : 'Denegar'}</span> },
        {
          key: 'x',
          title: '',
          render: (r: any) =>
            r.custom && editable ? (
              <button className="btn small" onClick={() => del(r.name)}>
                Eliminar
              </button>
            ) : null,
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------- NSG

function NsgRulesSection({ r, direction }: { r: Resource; direction: 'Inbound' | 'Outbound' }) {
  useCloud();
  return (
    <>
      <CommandBar items={[{ label: 'Agregar', icon: 'add', onClick: () => openAddRule(r, direction) }]} />
      <Callout>
        Las reglas se evalúan por orden de <b>prioridad</b> (de menor a mayor número) y se detiene en la primera que coincide. Las reglas predeterminadas (65000+) no se pueden borrar, pero sí anular con reglas de prioridad menor.
      </Callout>
      <NsgRulesTable nsg={r} direction={direction} />
    </>
  );
}

function NsgAssociations({ r }: { r: Resource }) {
  const s = useCloud();
  const subnets: { vnet: Resource; sn: any }[] = [];
  for (const v of s.resources.filter((x) => ciEq(x.type, 'Microsoft.Network/virtualNetworks') && x.subscriptionId === r.subscriptionId)) {
    for (const sn of v.properties.subnets ?? []) if (ciEq(sn.properties?.networkSecurityGroup?.id, r.id)) subnets.push({ vnet: v, sn });
  }
  const nics = s.resources.filter((x) => ciEq(x.type, 'Microsoft.Network/networkInterfaces') && ciEq(x.properties.networkSecurityGroup?.id, r.id));
  const [vnetId, setVnetId] = useState('');
  const [subnet, setSubnet] = useState('');
  const vnets = s.resources.filter((x) => ciEq(x.type, 'Microsoft.Network/virtualNetworks') && x.subscriptionId === r.subscriptionId && ciEq(x.location, r.location));
  const vnet = vnets.find((v) => v.id === vnetId);
  const assoc = () =>
    vnet && subnet
      ? portalAction('Asociar subred', ['network', 'vnet', 'subnet', 'update', '-g', vnet.resourceGroup, '--vnet-name', vnet.name, '-n', subnet, '--nsg', r.id], { subscription: r.subscriptionId, success: `NSG asociado a la subred ${subnet}` })
      : undefined;
  return (
    <>
      <h3 className="section-title">Subredes</h3>
      <DataTable
        rows={subnets}
        rowKey={(x) => x.sn.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (x) => x.sn.name },
          { key: 'v', title: 'Red virtual', render: (x) => <a href={resourceHref(x.vnet.id)}>{x.vnet.name}</a> },
          { key: 'a', title: 'Intervalo', render: (x) => x.sn.properties.addressPrefix },
          {
            key: 'x',
            title: '',
            render: (x) => (
              <button className="btn small" onClick={() => portalAction('Desasociar subred', ['network', 'vnet', 'subnet', 'update', '-g', x.vnet.resourceGroup, '--vnet-name', x.vnet.name, '-n', x.sn.name, '--remove', 'networkSecurityGroup'], { subscription: r.subscriptionId, success: 'Subred desasociada' })}>
                Desasociar
              </button>
            ),
          },
        ]}
        empty="Este NSG no está asociado a ninguna subred."
      />
      <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
        <div style={{ width: 240 }}>
          <Select value={vnetId} onChange={setVnetId} options={[{ value: '', label: 'Red virtual...' }, ...vnets.map((v) => ({ value: v.id, label: v.name }))]} />
        </div>
        <div style={{ width: 200 }}>
          <Select value={subnet} onChange={setSubnet} options={[{ value: '', label: 'Subred...' }, ...(vnet?.properties.subnets ?? []).map((sn: any) => sn.name)]} />
        </div>
        <button className="btn" disabled={!vnet || !subnet} onClick={assoc}>
          Asociar
        </button>
      </div>
      <h3 className="section-title">Interfaces de red</h3>
      <DataTable rows={nics} rowKey={(x) => x.id} columns={[{ key: 'n', title: 'Nombre', render: (x) => <a href={resourceHref(x.id)}>{x.name}</a> }, { key: 'v', title: 'Máquina virtual', render: (x) => (x.properties.virtualMachine?.id ? x.properties.virtualMachine.id.split('/').pop() : '—') }]} empty="Ninguna interfaz de red usa este NSG." />
    </>
  );
}

// ---------------------------------------------------------------- VNet

function AddSubnet({ vnet }: { vnet: Resource }) {
  const used = (vnet.properties.subnets ?? []).length;
  const base = (vnet.properties.addressSpace?.addressPrefixes?.[0] ?? '10.0.0.0/16').split('/')[0].split('.');
  const [name, setName] = useState(used ? `subnet${used + 1}` : 'default');
  const [prefix, setPrefix] = useState(`${base[0]}.${base[1]}.${used}.0/24`);
  const [nsg, setNsg] = useState('');
  const s = useCloud();
  const nsgs = s.resources.filter((x) => ciEq(x.type, 'Microsoft.Network/networkSecurityGroups') && ciEq(x.location, vnet.location) && x.subscriptionId === vnet.subscriptionId);
  const { busy, run } = useAsync();
  const args = ['network', 'vnet', 'subnet', 'create', '-g', vnet.resourceGroup, '--vnet-name', vnet.name, '-n', name, '--address-prefixes', prefix, ...(nsg ? ['--nsg', nsg] : [])];
  return (
    <>
      <div className="pane-body">
        <Field label="Nombre" required>
          <TextInput value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Intervalo de direcciones (CIDR)" required help={`Debe estar dentro del espacio de direcciones de la red: ${(vnet.properties.addressSpace?.addressPrefixes ?? []).join(', ')}. Azure reserva 5 direcciones de cada subred.`}>
          <TextInput value={prefix} onChange={setPrefix} mono />
        </Field>
        <Field label="Grupo de seguridad de red">
          <Select value={nsg} onChange={setNsg} options={[{ value: '', label: 'Ninguno' }, ...nsgs.map((x) => ({ value: x.id, label: x.name }))]} />
        </Field>
        <CliBox cmd={cliText(args)} />
      </div>
      <div className="pane-foot">
        <button className="btn primary" disabled={busy || !name || !prefix} onClick={() => run(async () => (await portalAction('Agregar subred', args, { subscription: vnet.subscriptionId, success: `Subred ${name} creada` })) && closePane())}>
          Guardar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function VnetSubnets({ r }: { r: Resource }) {
  const s = useCloud();
  const subnets = r.properties.subnets ?? [];
  return (
    <>
      <CommandBar items={[{ label: 'Subred', icon: 'add', onClick: () => openPane({ title: 'Agregar una subred', subtitle: r.name, render: () => <AddSubnet vnet={r} /> }) }]} />
      <DataTable
        rows={subnets}
        rowKey={(x: any) => x.id}
        columns={[
          { key: 'n', title: 'Nombre', render: (x: any) => <b>{x.name}</b> },
          { key: 'a', title: 'Intervalo IPv4', render: (x: any) => <span className="mono">{x.properties.addressPrefix}</span> },
          { key: 'u', title: 'IP disponibles', render: (x: any) => { const bits = Number(String(x.properties.addressPrefix).split('/')[1]); const used = s.resources.filter((n) => ciEq(n.type, 'Microsoft.Network/networkInterfaces') && (n.properties.ipConfigurations ?? []).some((c: any) => ciEq(c.properties?.subnet?.id, x.id))).length; return 2 ** (32 - bits) - 5 - used; } },
          { key: 'g', title: 'Grupo de seguridad', render: (x: any) => (x.properties.networkSecurityGroup?.id ? <a href={resourceHref(x.properties.networkSecurityGroup.id)}>{x.properties.networkSecurityGroup.id.split('/').pop()}</a> : '—') },
          {
            key: 'x',
            title: '',
            render: (x: any) => (
              <button
                className="btn small"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Eliminar subred', message: `¿Eliminar la subred ${x.name}?`, confirmText: 'Eliminar', danger: true })) await portalAction('Eliminar subred', ['network', 'vnet', 'subnet', 'delete', '-g', r.resourceGroup, '--vnet-name', r.name, '-n', x.name], { subscription: r.subscriptionId, success: `Subred ${x.name} eliminada` });
                }}
              >
                Eliminar
              </button>
            ),
          },
        ]}
        empty="La red no tiene subredes."
      />
    </>
  );
}

function AddPeering({ vnet }: { vnet: Resource }) {
  const s = useCloud();
  const others = s.resources.filter((x) => ciEq(x.type, 'Microsoft.Network/virtualNetworks') && x.id !== vnet.id);
  const [remote, setRemote] = useState(others[0]?.id ?? '');
  const rv = others.find((x) => x.id === remote);
  const [name, setName] = useState(rv ? `${vnet.name}-to-${rv.name}` : '');
  const [both, setBoth] = useState(true);
  const [fwd, setFwd] = useState(false);
  const { busy, run } = useAsync();
  const a1 = ['network', 'vnet', 'peering', 'create', '-g', vnet.resourceGroup, '--vnet-name', vnet.name, '-n', name, '--remote-vnet', remote, '--allow-vnet-access', ...(fwd ? ['--allow-forwarded-traffic'] : [])];
  const a2 = rv ? ['network', 'vnet', 'peering', 'create', '-g', rv.resourceGroup, '--vnet-name', rv.name, '-n', `${rv.name}-to-${vnet.name}`, '--remote-vnet', vnet.id, '--allow-vnet-access', ...(fwd ? ['--allow-forwarded-traffic'] : [])] : [];
  return (
    <>
      <div className="pane-body">
        <Field label="Red virtual remota" required>
          <Select
            value={remote}
            onChange={(v) => {
              setRemote(v);
              const x = others.find((o) => o.id === v);
              if (x) setName(`${vnet.name}-to-${x.name}`);
            }}
            options={others.map((x) => ({ value: x.id, label: `${x.name} (${x.resourceGroup})` }))}
          />
        </Field>
        <Field label="Nombre del emparejamiento" required>
          <TextInput value={name} onChange={setName} />
        </Field>
        <Checkbox checked={both} onChange={setBoth} label="Crear también el emparejamiento en la red remota (bidireccional)" />
        <Checkbox checked={fwd} onChange={setFwd} label="Permitir tráfico reenviado" />
        <Callout kind="warn">El emparejamiento requiere que los espacios de direcciones no se solapen y debe existir en ambos sentidos para que el estado sea "Connected".</Callout>
        <CliBox cmd={cliText(a1)} />
        {both && rv ? (
          <div style={{ marginTop: 8 }}>
            <CliBox cmd={cliText(a2)} />
          </div>
        ) : null}
      </div>
      <div className="pane-foot">
        <button
          className="btn primary"
          disabled={busy || !remote || !name}
          onClick={() =>
            run(async () => {
              const ok = await portalAction('Agregar emparejamiento', a1, { subscription: vnet.subscriptionId, success: 'Emparejamiento creado' });
              if (ok && both && rv) await portalAction('Agregar emparejamiento remoto', a2, { subscription: rv.subscriptionId, success: 'Emparejamiento remoto creado' });
              if (ok) closePane();
            })
          }
        >
          Agregar
        </button>
        <button className="btn" onClick={closePane}>
          Cancelar
        </button>
      </div>
    </>
  );
}

function VnetPeerings({ r }: { r: Resource }) {
  useCloud();
  const peerings = r.properties.virtualNetworkPeerings ?? [];
  return (
    <>
      <CommandBar items={[{ label: 'Agregar', icon: 'add', onClick: () => openPane({ title: 'Agregar emparejamiento', subtitle: r.name, render: () => <AddPeering vnet={r} /> }) }]} />
      <DataTable
        rows={peerings}
        rowKey={(x: any) => x.name}
        columns={[
          { key: 'n', title: 'Nombre', render: (x: any) => <b>{x.name}</b> },
          { key: 's', title: 'Estado', render: (x: any) => <span className={`pill ${x.properties.peeringState === 'Connected' ? 'ok' : 'warn'}`}>{x.properties.peeringState}</span> },
          { key: 'r', title: 'Red remota', render: (x: any) => { const id = x.properties.remoteVirtualNetwork?.id; return id && findResource(id) ? <a href={resourceHref(id)}>{id.split('/').pop()}</a> : id?.split('/').pop(); } },
          { key: 'f', title: 'Tráfico reenviado', render: (x: any) => (x.properties.allowForwardedTraffic ? 'Permitido' : 'Bloqueado') },
        ]}
        empty="No hay emparejamientos."
      />
    </>
  );
}

function VnetDevices({ r }: { r: Resource }) {
  const s = useCloud();
  const nics = s.resources.filter((n) => ciEq(n.type, 'Microsoft.Network/networkInterfaces') && (n.properties.ipConfigurations ?? []).some((c: any) => findSubnet(c.properties?.subnet?.id ?? '', s)?.vnet.id === r.id));
  return (
    <DataTable
      rows={nics}
      rowKey={(n) => n.id}
      columns={[
        { key: 'd', title: 'Dispositivo', render: (n) => <a href={resourceHref(n.id)}>{n.name}</a> },
        { key: 't', title: 'Tipo', render: () => 'Interfaz de red' },
        { key: 'ip', title: 'Dirección IP', render: (n) => n.properties.ipConfigurations?.[0]?.properties?.privateIPAddress },
        { key: 's', title: 'Subred', render: (n) => String(n.properties.ipConfigurations?.[0]?.properties?.subnet?.id ?? '').split('/').pop() },
      ]}
      empty="No hay dispositivos conectados a esta red."
    />
  );
}

// ---------------------------------------------------------------- registro

export const NETWORK_BLADES: Record<string, TypeBlade> = {
  'microsoft.network/virtualnetworks': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Espacio de direcciones', (r.properties.addressSpace?.addressPrefixes ?? []).join(', ')],
          ['Subredes', (r.properties.subnets ?? []).map((x: any) => `${x.name} (${x.properties.addressPrefix})`).join(', ') || '—'],
          ['Emparejamientos', String((r.properties.virtualNetworkPeerings ?? []).length)],
          ['Servidores DNS', 'Proporcionado por Azure'],
        ]}
      />
    ),
    sections: [
      { id: 'subnets', label: 'Subredes', icon: 'network', group: 'Configuración', Comp: VnetSubnets },
      { id: 'peerings', label: 'Emparejamientos', icon: 'link', group: 'Configuración', Comp: VnetPeerings },
      { id: 'devices', label: 'Dispositivos conectados', icon: 'network', group: 'Configuración', Comp: VnetDevices },
    ],
    cli: (r) => [
      { label: 'Ver las subredes', cmd: `az network vnet subnet list -g ${r.resourceGroup} --vnet-name ${r.name} -o table` },
      { label: 'Crear una subred', cmd: `az network vnet subnet create -g ${r.resourceGroup} --vnet-name ${r.name} -n backend --address-prefixes 10.0.2.0/24` },
    ],
  },
  'microsoft.network/networksecuritygroups': {
    Overview: ({ r }) => (
      <>
        <h3 className="section-title">Reglas de seguridad de entrada</h3>
        <NsgRulesTable nsg={r} direction="Inbound" />
      </>
    ),
    sections: [
      { id: 'inbound', label: 'Reglas de seguridad de entrada', icon: 'lock', group: 'Configuración', Comp: ({ r }) => <NsgRulesSection r={r} direction="Inbound" /> },
      { id: 'outbound', label: 'Reglas de seguridad de salida', icon: 'lock', group: 'Configuración', Comp: ({ r }) => <NsgRulesSection r={r} direction="Outbound" /> },
      { id: 'assoc', label: 'Asociaciones', icon: 'link', group: 'Configuración', Comp: NsgAssociations },
    ],
    cli: (r) => [
      { label: 'Permitir HTTP (80) desde Internet', cmd: `az network nsg rule create -g ${r.resourceGroup} --nsg-name ${r.name} -n allow-http --priority 100 --destination-port-ranges 80 --access Allow --protocol Tcp` },
      { label: 'Listar las reglas', cmd: `az network nsg rule list -g ${r.resourceGroup} --nsg-name ${r.name} -o table` },
    ],
  },
  'microsoft.network/publicipaddresses': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['Dirección IP', <span className="mono">{r.properties.ipAddress ?? '(se asigna al asociarla)'}</span>],
          ['SKU', r.sku?.name ?? 'Standard'],
          ['Asignación', r.properties.publicIPAllocationMethod],
          ['Nombre DNS', r.properties.dnsSettings?.fqdn ?? '—'],
        ]}
      />
    ),
    cli: (r) => [{ label: 'Ver la IP', cmd: `az network public-ip show ${gn(r).join(' ')} --query ipAddress -o tsv` }],
  },
  'microsoft.network/networkinterfaces': {
    Overview: ({ r }) => {
      const ic = r.properties.ipConfigurations?.[0]?.properties ?? {};
      return (
        <Props
          rows={[
            ['IP privada', <span className="mono">{ic.privateIPAddress}</span>],
            ['IP pública', ic.publicIPAddress?.id ? <a href={resourceHref(ic.publicIPAddress.id)}>{ic.publicIPAddress.id.split('/').pop()}</a> : '—'],
            ['Subred', String(ic.subnet?.id ?? '').split('/').slice(-3).join('/')],
            ['NSG', r.properties.networkSecurityGroup?.id ? <a href={resourceHref(r.properties.networkSecurityGroup.id)}>{r.properties.networkSecurityGroup.id.split('/').pop()}</a> : '—'],
            ['Máquina virtual', r.properties.virtualMachine?.id ? <a href={resourceHref(r.properties.virtualMachine.id)}>{r.properties.virtualMachine.id.split('/').pop()}</a> : '—'],
          ]}
        />
      );
    },
    cli: (r) => [{ label: 'Reglas de seguridad efectivas', cmd: `az network nic list-effective-nsg ${gn(r).join(' ')}` }],
  },
  'microsoft.network/loadbalancers': {
    Overview: ({ r }) => (
      <Props
        rows={[
          ['SKU', r.sku?.name ?? 'Standard'],
          ['Front-end', (r.properties.frontendIPConfigurations ?? []).map((f: any) => f.name).join(', ')],
          ['Grupos de back-end', (r.properties.backendAddressPools ?? []).map((b: any) => b.name).join(', ')],
          ['Reglas', (r.properties.loadBalancingRules ?? []).map((x: any) => `${x.name} (${x.properties.frontendPort}→${x.properties.backendPort})`).join(', ') || '—'],
          ['Sondeos', (r.properties.probes ?? []).map((x: any) => `${x.name} (${x.properties.protocol}:${x.properties.port})`).join(', ') || '—'],
        ]}
      />
    ),
  },
};
