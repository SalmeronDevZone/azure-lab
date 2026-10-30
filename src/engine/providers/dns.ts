// Azure DNS: zonas públicas. Los conjuntos de registros se guardan como datos de la zona.
import type { Resource } from '../types';
import { registerProvider, baseResource } from '../registry';
import { getState } from '../store';
import { ciEq, fnv1a } from '../util';

export const T_DNS = 'Microsoft.Network/dnsZones';

export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SOA';

export interface RecordSet {
  name: string;
  type: DnsType;
  ttl: number;
  /** A/AAAA: IP · CNAME: destino · TXT: texto · MX: "preferencia intercambiador" · NS: servidor */
  records: string[];
}

export const rsKey = (type: string, name: string) => `${type.toUpperCase()}/${(name || '@').toLowerCase()}`;

export function recordSets(zone: Resource): Record<string, RecordSet> {
  zone.data = zone.data ?? {};
  zone.data.recordSets = zone.data.recordSets ?? {};
  return zone.data.recordSets;
}

export function fqdnOf(zone: Resource, name: string) {
  return name === '@' ? `${zone.name}.` : `${name}.${zone.name}.`;
}

export function recordSetJson(zone: Resource, rs: RecordSet) {
  const out: any = {
    etag: String(fnv1a(JSON.stringify(rs))),
    fqdn: fqdnOf(zone, rs.name),
    id: `${zone.id}/${rs.type}/${rs.name}`,
    name: rs.name,
    provisioningState: 'Succeeded',
    resourceGroup: zone.resourceGroup,
    TTL: rs.ttl,
    type: `Microsoft.Network/dnszones/${rs.type}`,
    metadata: null,
  };
  if (rs.type === 'A') out.ARecords = rs.records.map((ipv4Address) => ({ ipv4Address }));
  if (rs.type === 'AAAA') out.AAAARecords = rs.records.map((ipv6Address) => ({ ipv6Address }));
  if (rs.type === 'CNAME') out.CNAMERecord = { cname: rs.records[0] };
  if (rs.type === 'TXT') out.TXTRecords = rs.records.map((v) => ({ value: [v] }));
  if (rs.type === 'MX') out.MXRecords = rs.records.map((v) => ({ preference: Number(v.split(' ')[0]), exchange: v.split(' ')[1] }));
  if (rs.type === 'NS') out.NSRecords = rs.records.map((nsdname) => ({ nsdname }));
  if (rs.type === 'SOA') out.SOARecord = { host: rs.records[0], email: 'azuredns-hostmaster.microsoft.com', serialNumber: 1, refreshTime: 3600, retryTime: 300, expireTime: 2419200, minimumTtl: 300 };
  return out;
}

registerProvider({
  type: T_DNS,
  label: 'Zona DNS',
  labelPlural: 'Zonas DNS',
  icon: 'dns',
  category: 'Redes',
  description: 'Hospeda los registros DNS de tus dominios en la infraestructura global de Azure.',
  provisionMs: 1500,
  locationless: true,
  nameRule: {
    test: (n) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(n),
    message: "The zone name '{name}' is invalid. A DNS zone name must have at least two labels (for example contoso.com) and only letters, numbers and hyphens.",
  },
  build(input, ctx) {
    const ex = ctx.existing;
    const r = baseResource(input, ctx);
    r.location = 'global';
    const n = String((fnv1a(ctx.id) % 99) + 1).padStart(2, '0');
    const nameServers = ex?.properties.nameServers ?? [`ns1-${n}.azure-dns.com.`, `ns2-${n}.azure-dns.net.`, `ns3-${n}.azure-dns.org.`, `ns4-${n}.azure-dns.info.`];
    r.properties = { maxNumberOfRecordSets: 10000, maxNumberOfRecordsPerRecordSet: 20, nameServers, zoneType: 'Public' };
    if (!ex) {
      r.data = {
        recordSets: {
          [rsKey('SOA', '@')]: { name: '@', type: 'SOA', ttl: 3600, records: [nameServers[0]] },
          [rsKey('NS', '@')]: { name: '@', type: 'NS', ttl: 172800, records: nameServers },
        },
      };
    }
    return r;
  },
  decorate: (res) => ({ numberOfRecordSets: Object.keys(res.data?.recordSets ?? {}).length }),
  essentials: (res) => [
    ['Servidores de nombres', (res.properties.nameServers ?? []).join(' ')],
    ['Conjuntos de registros', String(Object.keys(res.data?.recordSets ?? {}).length)],
  ],
  monthlyCost: () => 0.5,
});

/**
 * Busca un registro A, AAAA o CNAME para un nombre en las zonas hospedadas (la zona más específica gana).
 * Devuelve 'nx' si la zona existe pero no tiene el registro (respuesta autoritativa NXDOMAIN).
 */
export function lookupRecord(host: string): { type: 'A' | 'AAAA' | 'CNAME'; values: string[] } | 'nx' | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  const zones = getState()
    .resources.filter((r) => ciEq(r.type, T_DNS) && (h === r.name.toLowerCase() || h.endsWith('.' + r.name.toLowerCase())))
    .sort((a, b) => b.name.length - a.name.length);
  const z = zones[0];
  if (!z) return null;
  const rel = h === z.name.toLowerCase() ? '@' : h.slice(0, h.length - z.name.length - 1);
  const rs: Record<string, RecordSet> = z.data?.recordSets ?? {};
  for (const t of ['CNAME', 'A', 'AAAA'] as const) {
    const r = rs[rsKey(t, rel)];
    if (r?.records.length) return { type: t, values: r.records };
  }
  return 'nx';
}

export function txtRecords(host: string): string[] {
  const h = host.toLowerCase().replace(/\.$/, '');
  const z = getState()
    .resources.filter((r) => ciEq(r.type, T_DNS) && (h === r.name.toLowerCase() || h.endsWith('.' + r.name.toLowerCase())))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!z) return [];
  const rel = h === z.name.toLowerCase() ? '@' : h.slice(0, h.length - z.name.length - 1);
  return (z.data?.recordSets ?? {})[rsKey('TXT', rel)]?.records ?? [];
}
