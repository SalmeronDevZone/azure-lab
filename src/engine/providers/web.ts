// Microsoft.Web: planes de App Service, aplicaciones web, Functions y ranuras de implementación.
import type { CloudState, Resource } from '../types';
import { registerProvider, baseResource, type ArmInput, type BuildCtx } from '../registry';
import { ArmError } from '../errors';
import { APP_SERVICE_SKUS, HOURS_PER_MONTH, findAppServiceSku, findRuntime, locationDisplay } from '../catalog';
import { ciEq, nowIso, randomPublicIp } from '../util';
import { cleanupIdentity, resolveIdentity } from './identity';

const T_PLAN = 'Microsoft.Web/serverfarms';
const T_SITE = 'Microsoft.Web/sites';
const T_SLOT = 'Microsoft.Web/sites/slots';

export function planOf(site: Resource, s: CloudState): Resource | undefined {
  return s.resources.find((r) => ciEq(r.id, site.properties.serverFarmId));
}

export function sitesOnPlan(plan: Resource, s: CloudState): Resource[] {
  return s.resources.filter((r) => (ciEq(r.type, T_SITE) || ciEq(r.type, T_SLOT)) && ciEq(r.properties.serverFarmId, plan.id));
}

export function slotsOf(site: Resource, s: CloudState): Resource[] {
  return s.resources.filter((r) => ciEq(r.type, T_SLOT) && r.id.toLowerCase().startsWith(site.id.toLowerCase() + '/slots/'));
}

export function runtimeLabel(site: Resource): string {
  const fx: string = site.properties.siteConfig?.linuxFxVersion ?? '';
  if (fx.toUpperCase().startsWith('DOCKER|')) return `Contenedor: ${fx.slice(7)}`;
  const rt = findRuntime(fx);
  return rt?.label ?? (fx || site.properties.siteConfig?.netFrameworkVersion || '-');
}

registerProvider({
  type: T_PLAN,
  label: 'Plan de App Service',
  labelPlural: 'Planes de App Service',
  icon: 'plan',
  category: 'Web',
  description: 'Define la región, el tamaño y el número de instancias donde se ejecutan tus apps.',
  provisionMs: 2000,
  nameRule: { test: (n) => /^[a-zA-Z0-9-]{1,60}$/.test(n), message: "App Service plan name '{name}' is invalid (1-60 caracteres: letras, números y guiones)." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const skuName = input.sku?.name ?? ex?.sku?.name ?? 'B1';
    const sku = findAppServiceSku(skuName);
    if (!sku) throw new ArmError('BadRequest', `The pricing tier '${skuName}' is not allowed in this resource group. Valid values: ${APP_SERVICE_SKUS.map((x) => x.name).join(', ')}.`);
    const capacity = Number(input.sku?.capacity ?? ex?.sku?.capacity ?? 1);
    if (capacity < 1 || capacity > sku.maxWorkers) {
      throw new ArmError('BadRequest', `You cannot scale to ${capacity} instances in the '${sku.tier}' pricing tier. The maximum for this tier is ${sku.maxWorkers}.`, 400, sku.tier === 'Free' ? 'El nivel Free sólo admite 1 instancia. Escala verticalmente a Basic o superior.' : undefined);
    }
    const kindIn = (input.kind ?? ex?.kind ?? '').toLowerCase();
    const reserved = p.reserved ?? ex?.properties.reserved ?? kindIn.includes('linux');
    if (ex) {
      const sites = sitesOnPlan(ex, ctx.state);
      const slotCount = sites.filter((x) => ciEq(x.type, T_SLOT)).length;
      if (slotCount > 0 && sku.slots === 0) {
        throw new ArmError('BadRequest', `Cannot downgrade to '${sku.tier}' because the plan contains apps with deployment slots. Delete the slots first.`, 400);
      }
      if (sites.some((x) => x.properties.siteConfig?.alwaysOn) && !sku.alwaysOn) {
        throw new ArmError('Conflict', `Cannot change the plan to '${sku.tier}' because some apps have 'Always On' enabled, which is not supported in this tier.`, 409);
      }
    }
    const r = baseResource(input, ctx);
    r.kind = reserved ? 'linux' : 'app';
    r.sku = { name: sku.name, tier: sku.tier, size: sku.name, family: sku.family, capacity };
    r.properties = {
      status: 'Ready',
      maximumNumberOfWorkers: sku.maxWorkers,
      geoRegion: locationDisplay(input.location),
      reserved,
      perSiteScaling: p.perSiteScaling ?? false,
      elasticScaleEnabled: false,
      zoneRedundant: p.zoneRedundant ?? false,
      isSpot: false,
      hyperV: false,
      numberOfWorkers: capacity,
      targetWorkerCount: 0,
      targetWorkerSizeId: 0,
    };
    return r;
  },
  beforeDelete(res, s) {
    const apps = sitesOnPlan(res, s).filter((x) => ciEq(x.type, T_SITE));
    if (apps.length) {
      throw new ArmError('Conflict', `Server farm '${res.name}' cannot be deleted because it has web app(s) ${apps.map((a) => a.name).join(',')} assigned to it.`, 409, 'Elimina o mueve primero las aplicaciones que usan este plan.');
    }
  },
  decorate(res, s) {
    return { numberOfSites: sitesOnPlan(res, s).filter((x) => ciEq(x.type, T_SITE)).length };
  },
  essentials(res, s) {
    const sku = findAppServiceSku(res.sku?.name);
    return [
      ['Plan de tarifa', `${res.sku?.name} (${sku?.description ?? res.sku?.tier})`],
      ['Sistema operativo', res.properties.reserved ? 'Linux' : 'Windows'],
      ['Instancias', `${res.sku?.capacity ?? 1} (máx. ${sku?.maxWorkers})`],
      ['Aplicaciones', String(sitesOnPlan(res, s).filter((x) => ciEq(x.type, T_SITE)).length)],
      ['Ranuras de implementación', sku?.slots ? `Hasta ${sku.slots}` : 'No disponible en este nivel'],
      ['Escalado automático', sku?.autoscale ? 'Disponible' : 'No disponible'],
    ];
  },
  monthlyCost(res) {
    const sku = findAppServiceSku(res.sku?.name);
    return (sku?.pricePerHour ?? 0) * HOURS_PER_MONTH * (res.sku?.capacity ?? 1);
  },
});

function buildSite(input: ArmInput, ctx: BuildCtx, isSlot: boolean): Resource {
  const ex = ctx.existing;
  const p = input.properties ?? {};
  const s = ctx.state;
  let parent: Resource | undefined;
  if (isSlot) {
    const parentId = ctx.id.split('/slots/')[0];
    parent = s.resources.find((r) => ciEq(r.id, parentId));
    if (!parent) throw new ArmError('ParentResourceNotFound', `Parent web app not found for slot ${input.name}.`, 404);
  }
  const planId = p.serverFarmId ?? ex?.properties.serverFarmId ?? parent?.properties.serverFarmId;
  const plan = planId ? s.resources.find((r) => ciEq(r.id, planId) || (ciEq(r.type, T_PLAN) && ciEq(r.name, planId))) : undefined;
  if (!plan) {
    throw new ArmError('ServerFarmNotFound', `The server farm '${planId ?? '(vacío)'}' with id '${planId ?? ''}' could not be found.`, 404, 'Crea antes un plan de App Service (az appservice plan create) o indica su nombre con --plan.');
  }
  if (!ciEq(plan.location, input.location)) {
    throw new ArmError('BadRequest', `The web app location '${input.location}' must match the App Service plan location '${plan.location}'.`, 400);
  }
  const sku = findAppServiceSku(plan.sku?.name)!;
  if (isSlot && !ex) {
    const count = slotsOf(parent!, s).length;
    if (count >= sku.slots) {
      throw new ArmError(
        'BadRequest',
        `Cannot complete the operation because the site will exceed the number of slots allowed for the '${sku.tier}' SKU.`,
        400,
        sku.slots === 0 ? 'Las ranuras de implementación requieren un plan Standard (S1) o superior.' : `Este nivel permite un máximo de ${sku.slots} ranuras.`,
      );
    }
  }
  const prevCfg = ex?.properties.siteConfig ?? (isSlot ? {} : {});
  const cfgIn = p.siteConfig ?? {};
  const linux = plan.properties.reserved;
  let fx: string | undefined = cfgIn.linuxFxVersion ?? prevCfg.linuxFxVersion ?? (isSlot ? parent!.properties.siteConfig?.linuxFxVersion : undefined);
  if (fx && linux && !fx.toUpperCase().startsWith('DOCKER|') && !findRuntime(fx)) {
    throw new ArmError('BadRequest', `Linux Runtime '${fx}' is not supported. Run 'az webapp list-runtimes --os-type linux' to see the supported runtimes.`);
  }
  if (fx && findRuntime(fx)) fx = findRuntime(fx)!.fx;
  const alwaysOn = cfgIn.alwaysOn ?? prevCfg.alwaysOn ?? sku.alwaysOn;
  if (alwaysOn && !sku.alwaysOn) {
    throw new ArmError('Conflict', `There was a conflict. AlwaysOn cannot be set for this site as the plan does not allow it. For more information on pricing and features, please see: https://aka.ms/appservicepricingdetails`, 409, 'Always On no está disponible en el nivel Free.');
  }
  const kind = input.kind ?? ex?.kind ?? parent?.kind ?? (linux ? 'app,linux' : 'app');
  const hostBase = isSlot ? `${parent!.name}-${input.name.split('/')[1]}` : input.name;
  const host = `${hostBase.toLowerCase()}.azurewebsites.net`;
  const r = baseResource(input, ctx);
  r.kind = kind;
  r.identity = resolveIdentity(s, input.identity, ex?.identity, isSlot ? `${parent!.name}/slots/${input.name.split('/')[1]}` : input.name, ctx.id);
  const outbound = ex?.properties.outboundIpAddresses ?? [0, 1, 2, 3].map((i) => randomPublicIp(plan.id + i)).join(',');
  r.properties = {
    name: input.name.split('/').pop(),
    state: ex?.properties.state ?? 'Running',
    enabled: true,
    hostNames: [host],
    enabledHostNames: [host, host.replace('.azurewebsites.net', '.scm.azurewebsites.net')],
    defaultHostName: host,
    serverFarmId: plan.id,
    reserved: linux,
    httpsOnly: p.httpsOnly ?? ex?.properties.httpsOnly ?? false,
    clientAffinityEnabled: p.clientAffinityEnabled ?? ex?.properties.clientAffinityEnabled ?? true,
    clientCertEnabled: false,
    publicNetworkAccess: p.publicNetworkAccess ?? ex?.properties.publicNetworkAccess ?? 'Enabled',
    keyVaultReferenceIdentity: 'SystemAssigned',
    usageState: 'Normal',
    availabilityState: 'Normal',
    outboundIpAddresses: outbound,
    possibleOutboundIpAddresses: outbound,
    lastModifiedTimeUtc: nowIso(),
    repositorySiteName: input.name.split('/').pop(),
    containerSize: 0,
    siteConfig: {
      linuxFxVersion: linux ? fx ?? '' : '',
      windowsFxVersion: null,
      netFrameworkVersion: linux ? null : cfgIn.netFrameworkVersion ?? prevCfg.netFrameworkVersion ?? 'v4.0',
      alwaysOn,
      http20Enabled: cfgIn.http20Enabled ?? prevCfg.http20Enabled ?? true,
      minTlsVersion: cfgIn.minTlsVersion ?? prevCfg.minTlsVersion ?? '1.2',
      ftpsState: cfgIn.ftpsState ?? prevCfg.ftpsState ?? 'FtpsOnly',
      numberOfWorkers: cfgIn.numberOfWorkers ?? prevCfg.numberOfWorkers ?? 1,
      healthCheckPath: cfgIn.healthCheckPath ?? prevCfg.healthCheckPath ?? null,
      appCommandLine: cfgIn.appCommandLine ?? prevCfg.appCommandLine ?? '',
      acrUseManagedIdentityCreds: cfgIn.acrUseManagedIdentityCreds ?? prevCfg.acrUseManagedIdentityCreds ?? false,
      appSettings: (cfgIn.appSettings ?? prevCfg.appSettings ?? []).map((x: any) => ({ name: String(x.name), value: String(x.value ?? '') })),
      connectionStrings: cfgIn.connectionStrings ?? prevCfg.connectionStrings ?? [],
    },
    slotSwapStatus: ex?.properties.slotSwapStatus ?? null,
  };
  const data = r.data!;
  data.content = data.content ?? { files: {}, version: 0, deployedAt: null, by: null, kind: null };
  data.deployments = data.deployments ?? [];
  data.logs = data.logs ?? [];
  data.stickySettings = data.stickySettings ?? [];
  return r;
}

registerProvider({
  type: T_SITE,
  label: 'App Service',
  labelPlural: 'App Services',
  icon: 'webapp',
  category: 'Web',
  description: 'Hospeda aplicaciones web y APIs sin administrar servidores (PaaS).',
  provisionMs: 3000,
  global: { code: 'Conflict', message: (n) => `Website with given name ${n} already exists.` },
  nameRule: {
    test: (n) => /^[a-zA-Z0-9][a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$/.test(n),
    message: "Site name '{name}' is invalid. The name can contain letters, numbers and hyphens (2-60 characters) and must start and end with a letter or number.",
  },
  build: (input, ctx) => buildSite(input, ctx, false),
  onDelete(res, s) {
    cleanupIdentity(res, s);
    for (const slot of slotsOf(res, s)) cleanupIdentity(slot, s);
  },
  status(res) {
    if (res.properties.provisioningState !== 'Succeeded') return res.properties.provisioningState;
    return res.properties.state === 'Running' ? 'En ejecución' : 'Detenida';
  },
  essentials(res, s) {
    const plan = planOf(res, s);
    return [
      ['Estado', res.properties.state === 'Running' ? 'En ejecución' : 'Detenida'],
      ['Dominio predeterminado', { text: res.properties.defaultHostName, link: `https://${res.properties.defaultHostName}` }],
      ['Plan de App Service', plan ? { text: `${plan.name} (${plan.sku?.name}: ${plan.sku?.capacity})`, link: plan.id } : '-'],
      ['Sistema operativo', res.properties.reserved ? 'Linux' : 'Windows'],
      ['Pila en tiempo de ejecución', runtimeLabel(res)],
      ['Solo HTTPS', res.properties.httpsOnly ? 'Activado' : 'Desactivado'],
      ['Identidad administrada', res.identity?.principalId ? 'Asignada por el sistema' : 'Desactivada'],
      ['Última implementación', res.data?.content?.deployedAt ? new Date(res.data.content.deployedAt).toLocaleString('es-ES') : 'Sin implementaciones'],
    ];
  },
  monthlyCost: () => 0,
});

registerProvider({
  type: T_SLOT,
  label: 'Ranura de implementación',
  labelPlural: 'Ranuras de implementación',
  icon: 'webapp',
  category: 'Web',
  provisionMs: 2500,
  parentType: T_SITE,
  nameRule: { test: (n) => /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(n), message: "Slot name '{name}' is invalid (letras, números y guiones)." },
  build: (input, ctx) => buildSite(input, ctx, true),
  onDelete: (res, s) => cleanupIdentity(res, s),
  status(res) {
    return res.properties.state === 'Running' ? 'En ejecución' : 'Detenida';
  },
  essentials(res, s) {
    const plan = planOf(res, s);
    return [
      ['Estado', res.properties.state === 'Running' ? 'En ejecución' : 'Detenida'],
      ['Dominio', { text: res.properties.defaultHostName, link: `https://${res.properties.defaultHostName}` }],
      ['Plan de App Service', plan ? { text: plan.name, link: plan.id } : '-'],
      ['Pila en tiempo de ejecución', runtimeLabel(res)],
    ];
  },
  monthlyCost: () => 0,
});

export { T_PLAN, T_SITE, T_SLOT };
