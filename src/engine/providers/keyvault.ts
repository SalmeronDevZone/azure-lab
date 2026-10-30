// Microsoft.KeyVault: almacenes de claves (secretos, claves y certificados).
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { nowIso } from '../util';

export const T_KV = 'Microsoft.KeyVault/vaults';

registerProvider({
  type: T_KV,
  label: 'Almacén de claves',
  labelPlural: 'Almacenes de claves',
  icon: 'keyvault',
  category: 'Seguridad',
  description: 'Guarda de forma segura secretos, claves de cifrado y certificados.',
  provisionMs: 2500,
  global: { code: 'VaultAlreadyExists', message: (n) => `The vault name '${n}' is already in use. Vault names are globally unique so it is possible that the name is already taken.` },
  nameRule: {
    test: (n) => /^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(n) && !n.includes('--'),
    message: "The vault name '{name}' is invalid. A vault's name must be between 3-24 alphanumeric characters. The name must begin with a letter, end with a letter or digit, and not contain consecutive hyphens.",
  },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const skuName = String(p.sku?.name ?? ex?.properties.sku?.name ?? 'standard').toLowerCase();
    if (!['standard', 'premium'].includes(skuName)) throw new ArmError('BadRequest', `Invalid SKU '${skuName}'. Allowed values: standard, premium.`);
    const purge = p.enablePurgeProtection ?? ex?.properties.enablePurgeProtection ?? null;
    if (ex?.properties.enablePurgeProtection === true && purge !== true) {
      throw new ArmError('BadRequest', 'The property "enablePurgeProtection" cannot be set to false. Enabling the purge protection for a vault is an irreversible action.', 400, 'La protección de purga es irreversible una vez activada.');
    }
    const retention = Number(p.softDeleteRetentionInDays ?? ex?.properties.softDeleteRetentionInDays ?? 90);
    if (retention < 7 || retention > 90) throw new ArmError('BadRequest', 'softDeleteRetentionInDays must be between 7 and 90.');
    const r = baseResource(input, ctx);
    r.properties = {
      tenantId: ctx.state.tenant.id,
      sku: { family: 'A', name: skuName },
      accessPolicies: p.accessPolicies ?? ex?.properties.accessPolicies ?? [],
      enableRbacAuthorization: p.enableRbacAuthorization ?? ex?.properties.enableRbacAuthorization ?? true,
      enableSoftDelete: true,
      softDeleteRetentionInDays: retention,
      enablePurgeProtection: purge,
      vaultUri: `https://${input.name.toLowerCase()}.vault.azure.net/`,
      publicNetworkAccess: p.publicNetworkAccess ?? ex?.properties.publicNetworkAccess ?? 'Enabled',
      enabledForDeployment: p.enabledForDeployment ?? ex?.properties.enabledForDeployment ?? false,
      enabledForTemplateDeployment: p.enabledForTemplateDeployment ?? ex?.properties.enabledForTemplateDeployment ?? false,
      enabledForDiskEncryption: p.enabledForDiskEncryption ?? ex?.properties.enabledForDiskEncryption ?? false,
      networkAcls: p.networkAcls ?? ex?.properties.networkAcls ?? { bypass: 'AzureServices', defaultAction: 'Allow', ipRules: [], virtualNetworkRules: [] },
    };
    r.data = { ...(r.data ?? {}), secrets: r.data?.secrets ?? {}, keys: r.data?.keys ?? {}, certificates: r.data?.certificates ?? {} };
    return r;
  },
  onDelete(res, s) {
    // Eliminación temporal (soft delete): el almacén se puede recuperar durante el periodo de retención.
    const days = res.properties.softDeleteRetentionInDays ?? 90;
    s.deletedVaults = s.deletedVaults.filter((v) => v.name.toLowerCase() !== res.name.toLowerCase());
    s.deletedVaults.push({
      name: res.name,
      id: `/subscriptions/${res.subscriptionId}/providers/Microsoft.KeyVault/locations/${res.location}/deletedVaults/${res.name}`,
      location: res.location,
      deletionDate: nowIso(),
      scheduledPurgeDate: new Date(Date.now() + days * 86400000).toISOString(),
      resource: JSON.parse(JSON.stringify(res)),
    });
  },
  essentials(res) {
    const secrets = Object.values<any>(res.data?.secrets ?? {}).filter((x) => !x.deleted).length;
    return [
      ['URI del almacén', res.properties.vaultUri],
      ['Plan de tarifa', res.properties.sku?.name === 'premium' ? 'Premium' : 'Estándar'],
      ['Modelo de permisos', res.properties.enableRbacAuthorization ? 'Control de acceso basado en rol de Azure (RBAC)' : 'Directiva de acceso del almacén'],
      ['Eliminación temporal', `Habilitada (${res.properties.softDeleteRetentionInDays} días)`],
      ['Protección de purga', res.properties.enablePurgeProtection ? 'Habilitada' : 'Deshabilitada'],
      ['Secretos', String(secrets)],
    ];
  },
  monthlyCost(res) {
    return 0.03 * Math.max(1, Object.keys(res.data?.secrets ?? {}).length);
  },
});
