// Microsoft.Storage: cuentas de almacenamiento.
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { STORAGE_SKUS, findLocation } from '../catalog';
import { fakeKey, guid, nowIso } from '../util';
import type { Resource } from '../types';

const KINDS = ['StorageV2', 'Storage', 'BlobStorage', 'BlockBlobStorage', 'FileStorage'];

export function storageUsedBytes(res: Resource): number {
  let n = 0;
  for (const c of Object.values<any>(res.data?.containers ?? {})) for (const b of Object.values<any>(c.blobs ?? {})) n += b.size ?? 0;
  for (const sh of Object.values<any>(res.data?.shares ?? {})) for (const f of Object.values<any>(sh.files ?? {})) n += f.size ?? 0;
  return n;
}

registerProvider({
  type: 'Microsoft.Storage/storageAccounts',
  label: 'Cuenta de almacenamiento',
  labelPlural: 'Cuentas de almacenamiento',
  icon: 'storage',
  category: 'Almacenamiento',
  description: 'Blobs, archivos, colas y tablas con alta disponibilidad y redundancia configurable.',
  provisionMs: 2500,
  global: { code: 'StorageAccountAlreadyTaken', message: (n) => `The storage account named ${n} is already taken.` },
  nameRule: {
    test: (n) => /^[a-z0-9]{3,24}$/.test(n),
    message: '{name} is not a valid storage account name. Storage account name must be between 3 and 24 characters in length and use numbers and lower-case letters only.',
  },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const skuName = input.sku?.name ?? ex?.sku?.name ?? 'Standard_RAGRS';
    const skuInfo = STORAGE_SKUS[skuName];
    if (!skuInfo) {
      throw new ArmError('InvalidValuesForRequestParameters', `Values for request parameters are invalid: sku.name. The value '${skuName}' is not allowed. Allowed values: ${Object.keys(STORAGE_SKUS).join(', ')}.`);
    }
    const kind = input.kind ?? ex?.kind ?? 'StorageV2';
    if (!KINDS.includes(kind)) throw new ArmError('InvalidValuesForRequestParameters', `The value '${kind}' is not allowed for kind. Allowed values: ${KINDS.join(', ')}.`);
    if (ex && ex.sku?.name.startsWith('Premium') !== skuName.startsWith('Premium')) {
      throw new ArmError('InvalidAccountType', `Storage account type cannot be changed between Standard and Premium after creation.`, 400, 'El rendimiento (Standard/Premium) se elige al crear la cuenta y no se puede cambiar después.');
    }
    if (ex && /ZRS/.test(skuName) !== /ZRS/.test(ex.sku?.name ?? '')) {
      throw new ArmError('InvalidAccountType', `Conversion between ${ex.sku?.name} and ${skuName} requires a live migration request and is not supported through this API.`, 400, 'Cambiar a/desde ZRS requiere una migración; prueba con LRS ↔ GRS ↔ RA-GRS.');
    }
    const tier = skuInfo.tier === 'Premium' ? undefined : (p.accessTier ?? ex?.properties.accessTier ?? 'Hot');
    if (tier && !['Hot', 'Cool', 'Cold'].includes(tier)) throw new ArmError('InvalidValuesForRequestParameters', `The value '${tier}' is not allowed for accessTier. Allowed values: Hot, Cool, Cold.`);
    const geo = /GRS|GZRS/.test(skuName);
    const ra = /^Standard_RA/.test(skuName);
    const name = input.name;
    const loc = findLocation(input.location);
    const r = baseResource(input, ctx);
    r.sku = { name: skuName, tier: skuInfo.tier };
    r.kind = kind;
    const endpoints = (suffix = '') => ({
      blob: `https://${name}${suffix}.blob.core.windows.net/`,
      dfs: `https://${name}${suffix}.dfs.core.windows.net/`,
      file: suffix ? undefined : `https://${name}.file.core.windows.net/`,
      queue: `https://${name}${suffix}.queue.core.windows.net/`,
      table: `https://${name}${suffix}.table.core.windows.net/`,
      web: `https://${name}${suffix}.z6.web.core.windows.net/`,
    });
    r.properties = {
      accessTier: tier,
      allowBlobPublicAccess: p.allowBlobPublicAccess ?? ex?.properties.allowBlobPublicAccess ?? false,
      allowCrossTenantReplication: false,
      allowSharedKeyAccess: p.allowSharedKeyAccess ?? ex?.properties.allowSharedKeyAccess ?? true,
      creationTime: ex?.properties.creationTime ?? nowIso(),
      defaultToOAuthAuthentication: false,
      dnsEndpointType: 'Standard',
      encryption: { keySource: 'Microsoft.Storage', requireInfrastructureEncryption: false, services: { blob: { enabled: true, keyType: 'Account' }, file: { enabled: true, keyType: 'Account' } } },
      isHnsEnabled: p.isHnsEnabled ?? ex?.properties.isHnsEnabled ?? false,
      keyCreationTime: ex?.properties.keyCreationTime ?? { key1: nowIso(), key2: nowIso() },
      minimumTlsVersion: p.minimumTlsVersion ?? ex?.properties.minimumTlsVersion ?? 'TLS1_2',
      networkRuleSet: {
        bypass: p.networkAcls?.bypass ?? p.networkRuleSet?.bypass ?? ex?.properties.networkRuleSet?.bypass ?? 'AzureServices',
        defaultAction: p.networkAcls?.defaultAction ?? p.networkRuleSet?.defaultAction ?? ex?.properties.networkRuleSet?.defaultAction ?? 'Allow',
        ipRules: p.networkAcls?.ipRules ?? p.networkRuleSet?.ipRules ?? ex?.properties.networkRuleSet?.ipRules ?? [],
        virtualNetworkRules: p.networkAcls?.virtualNetworkRules ?? p.networkRuleSet?.virtualNetworkRules ?? ex?.properties.networkRuleSet?.virtualNetworkRules ?? [],
      },
      primaryEndpoints: endpoints(),
      primaryLocation: input.location,
      publicNetworkAccess: p.publicNetworkAccess ?? ex?.properties.publicNetworkAccess ?? 'Enabled',
      secondaryEndpoints: ra ? endpoints('-secondary') : null,
      secondaryLocation: geo ? loc?.paired ?? null : null,
      statusOfPrimary: 'available',
      statusOfSecondary: geo ? 'available' : null,
      supportsHttpsTrafficOnly: p.supportsHttpsTrafficOnly ?? ex?.properties.supportsHttpsTrafficOnly ?? true,
    };
    const data = r.data!;
    data.keys = data.keys ?? [
      { keyName: 'key1', value: fakeKey(ctx.id + 'k1'), permissions: 'FULL', creationTime: nowIso() },
      { keyName: 'key2', value: fakeKey(ctx.id + 'k2'), permissions: 'FULL', creationTime: nowIso() },
    ];
    data.containers = data.containers ?? {};
    data.shares = data.shares ?? {};
    data.queues = data.queues ?? {};
    data.tables = data.tables ?? {};
    data.staticWebsite = data.staticWebsite ?? { enabled: false, indexDocument: null, errorDocument404Path: null };
    data.etagSeed = data.etagSeed ?? guid();
    return r;
  },
  status(res) {
    return res.properties.provisioningState === 'Succeeded' ? 'Disponible' : res.properties.provisioningState;
  },
  essentials(res) {
    const sku = STORAGE_SKUS[res.sku?.name ?? ''];
    return [
      ['Rendimiento', res.sku?.tier ?? 'Standard'],
      ['Replicación', sku?.label ?? res.sku?.name ?? ''],
      ['Tipo de cuenta', res.kind === 'StorageV2' ? 'StorageV2 (uso general v2)' : res.kind ?? ''],
      ['Nivel de acceso', res.properties.accessTier ?? '-'],
      ['Ubicación principal/secundaria', `${res.properties.primaryLocation}${res.properties.secondaryLocation ? ' / ' + res.properties.secondaryLocation : ''}`],
      ['Punto de conexión de blobs', res.properties.primaryEndpoints?.blob],
      ['Acceso anónimo a blobs', res.properties.allowBlobPublicAccess ? 'Habilitado' : 'Deshabilitado'],
      ['Solo tráfico HTTPS', res.properties.supportsHttpsTrafficOnly ? 'Sí' : 'No'],
    ];
  },
  monthlyCost(res) {
    const info = STORAGE_SKUS[res.sku?.name ?? 'Standard_LRS'];
    const gb = storageUsedBytes(res) / 1024 ** 3;
    return 0.1 + gb * (info?.priceGB ?? 0.02) * (res.properties.accessTier === 'Cool' ? 0.55 : res.properties.accessTier === 'Cold' ? 0.2 : 1);
  },
});
