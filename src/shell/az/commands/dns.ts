// az network dns zone / record-set y az webapp config hostname (dominios personalizados).
import { register, group, A, cliError, type Args, type AzCtx, type AzArg } from '../framework';
import { getState } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { deleteResource, patchResource, putResource, findResource } from '../../../engine/arm';
import { ciEq, isValidIp } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import { T_DNS, recordSets, recordSetJson, rsKey, type DnsType } from '../../../engine/providers/dns';
import { resolveDns } from '../../../engine/services/net';
import { APP_SERVICE_SKUS } from '../../../engine/catalog';

group('network dns', 'Administra zonas y registros de Azure DNS.');
group('network dns zone', 'Administra zonas DNS.');
group('network dns record-set', 'Administra conjuntos de registros DNS.');
group('webapp config hostname', 'Administra los nombres de host (dominios personalizados) de una aplicación web.');

const zoneArg: AzArg = { name: 'zone_name', opts: ['--zone-name', '-z'], help: 'Nombre de la zona DNS (p. ej. contoso.com).', required: true };
const rsName: AzArg = { name: 'record_set_name', opts: ['--record-set-name', '-n', '--name'], help: 'Nombre relativo del conjunto de registros ("@" para el vértice de la zona).', required: true };
const ttlArg: AzArg = { name: 'ttl', opts: ['--ttl'], help: 'Tiempo de vida (segundos).', type: 'int', default: 3600 };

const zoneTable = (r: any) => (Array.isArray(r) ? r : [r]).map((z) => ({ ZoneName: z.name, ResourceGroup: z.resourceGroup, RecordSets: z.numberOfRecordSets, MaxRecordSets: z.maxNumberOfRecordSets }));
const rsTable = (r: any) =>
  (Array.isArray(r) ? r : [r]).map((x) => ({
    Name: x.name,
    ResourceGroup: x.resourceGroup,
    Ttl: x.TTL,
    Type: String(x.type).split('/').pop(),
    Metadata: '',
    Records: x.ARecords?.map((a: any) => a.ipv4Address).join(', ') ?? x.AAAARecords?.map((a: any) => a.ipv6Address).join(', ') ?? x.CNAMERecord?.cname ?? x.TXTRecords?.map((t: any) => t.value.join('')).join(', ') ?? x.MXRecords?.map((m: any) => `${m.preference} ${m.exchange}`).join(', ') ?? x.NSRecords?.map((n: any) => n.nsdname).join(', ') ?? x.SOARecord?.host ?? '',
  }));

function zone(ctx: AzCtx, a: Args) {
  return getRes(ctx, { resource_group: a.resource_group, name: a.zone_name }, T_DNS);
}

// ---------------------------------------------------------------- zonas

register({
  path: 'network dns zone create',
  summary: 'Crea una zona DNS pública.',
  args: [A.rg(), A.name('Nombre de la zona, p. ej. contoso.com.'), A.tags()],
  examples: [{ title: 'Crear la zona de un dominio.', cmd: 'az network dns zone create -g rg-dns -n contoso-lab.com' }],
  table: zoneTable,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const r = await putResource({ type: T_DNS, name: String(a.name).toLowerCase(), location: 'global', tags: a.tags, properties: {} }, rg.name, op(ctx));
    ctx.warn(`Para que Internet use esta zona, delega el dominio en tu registrador apuntando a los servidores de nombres: ${(r.properties.nameServers ?? []).join(', ')} (en el simulador la zona se resuelve directamente).`);
    return flat(r);
  },
});

register({ path: 'network dns zone list', summary: 'Lista las zonas DNS.', args: [A.rg(false)], table: zoneTable, run: (a, ctx) => listInSub(ctx, T_DNS, a.resource_group).map((r) => flat(r)) });
register({ path: 'network dns zone show', summary: 'Muestra una zona DNS.', args: [A.rg(), A.name('Nombre de la zona.')], table: zoneTable, run: (a, ctx) => flat(getRes(ctx, a, T_DNS)) });

register({
  path: 'network dns zone delete',
  summary: 'Elimina una zona DNS y todos sus registros.',
  args: [A.rg(), A.name('Nombre de la zona.'), A.yes()],
  confirm: 'Are you sure you want to perform this operation?',
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_DNS).id, op(ctx));
    return undefined;
  },
});

// ---------------------------------------------------------------- conjuntos de registros

function upsertRecord(ctx: AzCtx, a: Args, type: DnsType, value: string, mode: 'add' | 'set' | 'remove') {
  const z = zone(ctx, a);
  const name = String(a.record_set_name).toLowerCase();
  if (type === 'CNAME' && name === '@') throw new ArmError('BadRequest', 'A CNAME record cannot be created at the zone apex (@).', 400, 'En el vértice de la zona usa un registro A (o un alias). Los CNAME sólo valen para subdominios como www.');
  const rs = recordSets(z);
  if (type === 'CNAME' && Object.values(rs).some((x) => x.name === name && x.type !== 'CNAME')) throw new ArmError('BadRequest', `The record set ${name} of type CNAME conflicts with an existing record set of another type with the same name.`, 400, 'Un nombre con CNAME no puede tener otros registros (RFC 1034).');
  if (type !== 'CNAME' && rs[rsKey('CNAME', name)]) throw new ArmError('BadRequest', `A record set of type ${type} cannot be created with name ${name} because a CNAME record set with the same name already exists.`, 400);
  patchResource(
    z.id,
    (r) => {
      const sets = recordSets(r);
      const key = rsKey(type, name);
      const cur = sets[key] ?? { name, type, ttl: a.ttl ?? 3600, records: [] };
      if (mode === 'set') cur.records = [value];
      else if (mode === 'add') {
        if (!cur.records.includes(value)) cur.records.push(value);
      } else cur.records = cur.records.filter((x) => x !== value);
      if (a.ttl) cur.ttl = a.ttl;
      if (cur.records.length) sets[key] = cur;
      else if (mode === 'remove' && !a.keep_empty_record_set) delete sets[key];
      else sets[key] = cur;
    },
    { ...op(ctx), action: `Microsoft.Network/dnsZones/${type}/write`, opName: `Actualizar el conjunto de registros ${type} ${name}` },
  );
  const out = recordSets(z)[rsKey(type, name)];
  return out ? recordSetJson(z, out) : undefined;
}

const recordTypes: { t: DnsType; lower: string; add: { opt: string; key: string; help: string; validate?: (v: string) => string | null }[] }[] = [
  { t: 'A', lower: 'a', add: [{ opt: '--ipv4-address', key: 'ipv4_address', help: 'Dirección IPv4.', validate: (v) => (isValidIp(v) ? null : `'${v}' no es una dirección IPv4 válida.`) }] },
  { t: 'AAAA', lower: 'aaaa', add: [{ opt: '--ipv6-address', key: 'ipv6_address', help: 'Dirección IPv6.' }] },
  { t: 'TXT', lower: 'txt', add: [{ opt: '--value', key: 'value', help: 'Texto del registro.' }] },
  { t: 'MX', lower: 'mx', add: [{ opt: '--exchange', key: 'exchange', help: 'Servidor de correo.' }] },
];

for (const rt of recordTypes) {
  const valueArgs: AzArg[] = rt.add.map((x) => ({ name: x.key, opts: [x.opt], help: x.help, required: true }));
  if (rt.t === 'MX') valueArgs.push({ name: 'preference', opts: ['--preference'], help: 'Preferencia (menor = más prioritario).', type: 'int', required: true });
  const value = (a: Args) => {
    const raw = String(a[rt.add[0].key]);
    const err = rt.add[0].validate?.(raw);
    if (err) throw cliError(err);
    return rt.t === 'MX' ? `${a.preference} ${raw}` : raw;
  };
  group(`network dns record-set ${rt.lower}`, `Administra registros ${rt.t}.`);
  register({
    path: `network dns record-set ${rt.lower} add-record`,
    summary: `Añade un registro ${rt.t} (crea el conjunto si no existe).`,
    args: [A.rg(), zoneArg, rsName, ...valueArgs, ttlArg],
    examples: rt.t === 'A' ? [{ title: 'Apunta www a la IP pública de una VM.', cmd: 'az network dns record-set a add-record -g rg-dns -z contoso-lab.com -n www --ipv4-address 20.1.2.3' }] : [],
    table: rsTable,
    run: (a, ctx) => upsertRecord(ctx, a, rt.t, value(a), 'add'),
  });
  register({
    path: `network dns record-set ${rt.lower} remove-record`,
    summary: `Quita un registro ${rt.t}.`,
    args: [A.rg(), zoneArg, rsName, ...valueArgs, { name: 'keep_empty_record_set', opts: ['--keep-empty-record-set'], help: 'Conserva el conjunto vacío.', type: 'bool' }],
    run: (a, ctx) => upsertRecord(ctx, a, rt.t, value(a), 'remove'),
  });
}

group('network dns record-set cname', 'Administra registros CNAME.');
register({
  path: 'network dns record-set cname set-record',
  summary: 'Establece el registro CNAME de un nombre (alias hacia otro nombre DNS).',
  args: [A.rg(), zoneArg, rsName, { name: 'cname', opts: ['--cname', '-c'], help: 'Nombre canónico de destino, p. ej. miapp.azurewebsites.net.', required: true }, ttlArg],
  examples: [{ title: 'Apunta www a una web app.', cmd: 'az network dns record-set cname set-record -g rg-dns -z contoso-lab.com -n www -c miapp.azurewebsites.net' }],
  table: rsTable,
  run: (a, ctx) => upsertRecord(ctx, a, 'CNAME', String(a.cname).replace(/\.$/, ''), 'set'),
});

for (const t of ['a', 'aaaa', 'cname', 'txt', 'mx', 'ns', 'soa']) {
  if (t === 'ns' || t === 'soa') group(`network dns record-set ${t}`, `Registros ${t.toUpperCase()}.`);
  const T = t.toUpperCase() as DnsType;
  register({
    path: `network dns record-set ${t} list`,
    summary: `Lista los registros ${T} de una zona.`,
    args: [A.rg(), zoneArg],
    table: rsTable,
    run: (a, ctx) => {
      const z = zone(ctx, a);
      return Object.values(recordSets(z)).filter((x) => x.type === T).map((x) => recordSetJson(z, x));
    },
  });
  register({
    path: `network dns record-set ${t} show`,
    summary: `Muestra un conjunto de registros ${T}.`,
    args: [A.rg(), zoneArg, rsName],
    table: rsTable,
    run: (a, ctx) => {
      const z = zone(ctx, a);
      const rs = recordSets(z)[rsKey(T, a.record_set_name)];
      if (!rs) throw new ArmError('NotFound', `The resource record '${a.record_set_name}' does not exist in resource group '${z.resourceGroup}' of subscription '${ctx.subscriptionId}'.`, 404);
      return recordSetJson(z, rs);
    },
  });
  if (t !== 'soa')
    register({
      path: `network dns record-set ${t} delete`,
      summary: `Elimina un conjunto de registros ${T}.`,
      args: [A.rg(), zoneArg, rsName, A.yes()],
      confirm: 'Are you sure you want to perform this operation?',
      run: (a, ctx) => {
        const z = zone(ctx, a);
        if (T === 'NS' && a.record_set_name === '@') throw new ArmError('BadRequest', 'The NS record set at the zone apex cannot be deleted.', 400);
        patchResource(
          z.id,
          (r) => {
            delete recordSets(r)[rsKey(T, a.record_set_name)];
          },
          { ...op(ctx), action: `Microsoft.Network/dnsZones/${T}/delete`, opName: `Eliminar el conjunto de registros ${T} ${a.record_set_name}` },
        );
        return undefined;
      },
    });
}

register({
  path: 'network dns record-set list',
  summary: 'Lista todos los conjuntos de registros de una zona.',
  args: [A.rg(), zoneArg],
  table: rsTable,
  run: (a, ctx) => {
    const z = zone(ctx, a);
    return Object.values(recordSets(z)).map((x) => recordSetJson(z, x));
  },
});

// ---------------------------------------------------------------- dominios personalizados de App Service

const hostArgs: AzArg[] = [{ name: 'webapp_name', opts: ['--webapp-name'], help: 'Nombre de la aplicación web.', required: true }, A.rg()];

function siteFor(ctx: AzCtx, a: Args) {
  return getRes(ctx, { resource_group: a.resource_group, name: a.webapp_name }, 'Microsoft.Web/sites');
}

register({
  path: 'webapp config hostname add',
  summary: 'Enlaza un dominio personalizado a una aplicación web.',
  args: [...hostArgs, { name: 'hostname', opts: ['--hostname'], help: 'Dominio, p. ej. www.contoso.com.', required: true }],
  examples: [{ title: 'Enlazar www (con un CNAME hacia la app ya creado).', cmd: 'az webapp config hostname add --webapp-name miapp -g rg-web --hostname www.contoso-lab.com' }],
  run(a, ctx) {
    const site = siteFor(ctx, a);
    const host = String(a.hostname).toLowerCase();
    const plan = getState().resources.find((r) => ciEq(r.id, site.properties.serverFarmId));
    const sku = APP_SERVICE_SKUS.find((x) => x.name === plan?.sku?.name);
    if (sku && !sku.customDomains) throw new ArmError('BadRequest', `Custom domains are not supported for the ${plan!.sku!.name} pricing tier.`, 400, 'El plan gratuito (F1) no admite dominios personalizados: escala el plan a B1 o superior.');
    const dns = resolveDns(host);
    if (!dns || dns.cname?.toLowerCase() !== String(site.properties.defaultHostName).toLowerCase()) {
      throw new ArmError(
        'BadRequest',
        `A CNAME record pointing from ${host} to ${site.properties.defaultHostName} was not found. Alternative record awverify.${host} to awverify.${site.properties.defaultHostName} was not found either.`,
        400,
        `Crea primero el CNAME en tu zona DNS: az network dns record-set cname set-record -g <grupo> -z <zona> -n <subdominio> -c ${site.properties.defaultHostName}`,
      );
    }
    patchResource(
      site.id,
      (r) => {
        r.properties.hostNames = [...new Set([...(r.properties.hostNames ?? []), host])];
        r.properties.hostNameSslStates = [...(r.properties.hostNameSslStates ?? []).filter((x: any) => x.name !== host), { name: host, sslState: 'Disabled', hostType: 'Standard' }];
      },
      { ...op(ctx), action: 'Microsoft.Web/sites/hostNameBindings/write', opName: `Agregar dominio personalizado ${host}` },
    );
    ctx.warn('El dominio está enlazado sin certificado: el navegador avisará en HTTPS hasta que añadas uno (certificado administrado de App Service).');
    return { customHostNameDnsRecordType: 'CName', hostNameType: 'Verified', id: `${site.id}/hostNameBindings/${host}`, name: host, resourceGroup: site.resourceGroup, siteName: site.name, sslState: null, type: 'Microsoft.Web/sites/hostNameBindings' };
  },
});

register({
  path: 'webapp config hostname list',
  summary: 'Lista los nombres de host de una aplicación web.',
  args: hostArgs,
  table: (r: any[]) => r.map((x) => ({ Name: x.name, ResourceGroup: x.resourceGroup, SslState: x.sslState ?? '' })),
  run(a, ctx) {
    const site = siteFor(ctx, a);
    return (site.properties.hostNames ?? []).map((h: string) => ({ name: h, resourceGroup: site.resourceGroup, hostNameType: h.endsWith('.azurewebsites.net') ? 'Managed' : 'Verified', sslState: null }));
  },
});

register({
  path: 'webapp config hostname delete',
  summary: 'Quita un dominio personalizado de una aplicación web.',
  args: [...hostArgs, { name: 'hostname', opts: ['--hostname'], help: 'Dominio.', required: true }],
  run(a, ctx) {
    const site = siteFor(ctx, a);
    const host = String(a.hostname).toLowerCase();
    if (host === String(site.properties.defaultHostName).toLowerCase()) throw new ArmError('BadRequest', 'The default hostname cannot be removed.', 400);
    patchResource(
      site.id,
      (r) => {
        r.properties.hostNames = (r.properties.hostNames ?? []).filter((x: string) => x !== host);
      },
      { ...op(ctx), action: 'Microsoft.Web/sites/hostNameBindings/delete', opName: `Quitar dominio personalizado ${host}` },
    );
    return undefined;
  },
});

export const _dnsUnused = { findResource };
