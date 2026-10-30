// Catálogo de datos estáticos: regiones, tamaños, imágenes, SKUs, precios aproximados, roles y políticas.
import type { RoleDefinition } from './types';

export const HOURS_PER_MONTH = 730;

export interface Location {
  name: string;
  displayName: string;
  geo: string;
  paired?: string;
  zones: boolean;
}

export const LOCATIONS: Location[] = [
  { name: 'westeurope', displayName: 'West Europe', geo: 'Europa', paired: 'northeurope', zones: true },
  { name: 'northeurope', displayName: 'North Europe', geo: 'Europa', paired: 'westeurope', zones: true },
  { name: 'spaincentral', displayName: 'Spain Central', geo: 'Europa', zones: true },
  { name: 'francecentral', displayName: 'France Central', geo: 'Europa', paired: 'francesouth', zones: true },
  { name: 'germanywestcentral', displayName: 'Germany West Central', geo: 'Europa', paired: 'germanynorth', zones: true },
  { name: 'swedencentral', displayName: 'Sweden Central', geo: 'Europa', paired: 'swedensouth', zones: true },
  { name: 'italynorth', displayName: 'Italy North', geo: 'Europa', zones: true },
  { name: 'uksouth', displayName: 'UK South', geo: 'Europa', paired: 'ukwest', zones: true },
  { name: 'eastus', displayName: 'East US', geo: 'Estados Unidos', paired: 'westus', zones: true },
  { name: 'eastus2', displayName: 'East US 2', geo: 'Estados Unidos', paired: 'centralus', zones: true },
  { name: 'centralus', displayName: 'Central US', geo: 'Estados Unidos', paired: 'eastus2', zones: true },
  { name: 'westus2', displayName: 'West US 2', geo: 'Estados Unidos', paired: 'westcentralus', zones: true },
  { name: 'westus3', displayName: 'West US 3', geo: 'Estados Unidos', paired: 'eastus', zones: true },
  { name: 'canadacentral', displayName: 'Canada Central', geo: 'Canadá', paired: 'canadaeast', zones: true },
  { name: 'brazilsouth', displayName: 'Brazil South', geo: 'Sudamérica', paired: 'southcentralus', zones: true },
  { name: 'mexicocentral', displayName: 'Mexico Central', geo: 'México', zones: true },
  { name: 'southeastasia', displayName: 'Southeast Asia', geo: 'Asia Pacífico', paired: 'eastasia', zones: true },
  { name: 'japaneast', displayName: 'Japan East', geo: 'Asia Pacífico', paired: 'japanwest', zones: true },
  { name: 'australiaeast', displayName: 'Australia East', geo: 'Asia Pacífico', paired: 'australiasoutheast', zones: true },
  { name: 'centralindia', displayName: 'Central India', geo: 'India', paired: 'southindia', zones: true },
];

export function findLocation(name?: string): Location | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase().replace(/\s+/g, '');
  return LOCATIONS.find((l) => l.name === n || l.displayName.toLowerCase().replace(/\s+/g, '') === n);
}

export function locationDisplay(name?: string): string {
  return findLocation(name)?.displayName ?? name ?? '';
}

export interface VmSize {
  name: string;
  vCPUs: number;
  memoryGB: number;
  maxDataDisks: number;
  pricePerHour: number;
  family: string;
}

export const VM_SIZES: VmSize[] = [
  { name: 'Standard_B1s', vCPUs: 1, memoryGB: 1, maxDataDisks: 2, pricePerHour: 0.0104, family: 'B · Ampliable' },
  { name: 'Standard_B1ms', vCPUs: 1, memoryGB: 2, maxDataDisks: 2, pricePerHour: 0.0207, family: 'B · Ampliable' },
  { name: 'Standard_B2s', vCPUs: 2, memoryGB: 4, maxDataDisks: 4, pricePerHour: 0.0416, family: 'B · Ampliable' },
  { name: 'Standard_B2ms', vCPUs: 2, memoryGB: 8, maxDataDisks: 4, pricePerHour: 0.0832, family: 'B · Ampliable' },
  { name: 'Standard_B4ms', vCPUs: 4, memoryGB: 16, maxDataDisks: 8, pricePerHour: 0.166, family: 'B · Ampliable' },
  { name: 'Standard_D2s_v5', vCPUs: 2, memoryGB: 8, maxDataDisks: 4, pricePerHour: 0.096, family: 'D · Uso general' },
  { name: 'Standard_D4s_v5', vCPUs: 4, memoryGB: 16, maxDataDisks: 8, pricePerHour: 0.192, family: 'D · Uso general' },
  { name: 'Standard_D8s_v5', vCPUs: 8, memoryGB: 32, maxDataDisks: 16, pricePerHour: 0.384, family: 'D · Uso general' },
  { name: 'Standard_D2as_v5', vCPUs: 2, memoryGB: 8, maxDataDisks: 4, pricePerHour: 0.086, family: 'D · Uso general (AMD)' },
  { name: 'Standard_DS1_v2', vCPUs: 1, memoryGB: 3.5, maxDataDisks: 4, pricePerHour: 0.073, family: 'D · Uso general' },
  { name: 'Standard_DS2_v2', vCPUs: 2, memoryGB: 7, maxDataDisks: 8, pricePerHour: 0.146, family: 'D · Uso general' },
  { name: 'Standard_E2s_v5', vCPUs: 2, memoryGB: 16, maxDataDisks: 4, pricePerHour: 0.126, family: 'E · Memoria optimizada' },
  { name: 'Standard_E4s_v5', vCPUs: 4, memoryGB: 32, maxDataDisks: 8, pricePerHour: 0.252, family: 'E · Memoria optimizada' },
  { name: 'Standard_F2s_v2', vCPUs: 2, memoryGB: 4, maxDataDisks: 4, pricePerHour: 0.085, family: 'F · Proceso optimizado' },
  { name: 'Standard_F4s_v2', vCPUs: 4, memoryGB: 8, maxDataDisks: 8, pricePerHour: 0.169, family: 'F · Proceso optimizado' },
  { name: 'Standard_NC6s_v3', vCPUs: 6, memoryGB: 112, maxDataDisks: 12, pricePerHour: 3.06, family: 'N · GPU' },
];

export function findVmSize(name?: string): VmSize | undefined {
  return VM_SIZES.find((s) => s.name.toLowerCase() === (name ?? '').toLowerCase());
}

export interface VmImage {
  alias: string;
  urn: string;
  publisher: string;
  offer: string;
  sku: string;
  os: 'Linux' | 'Windows';
  displayName: string;
  distro: string;
}

export const VM_IMAGES: VmImage[] = [
  { alias: 'Ubuntu2404', urn: 'Canonical:ubuntu-24_04-lts:server:latest', publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', os: 'Linux', displayName: 'Ubuntu Server 24.04 LTS - x64 Gen2', distro: 'Ubuntu 24.04.1 LTS' },
  { alias: 'Ubuntu2204', urn: 'Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest', publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: '22_04-lts-gen2', os: 'Linux', displayName: 'Ubuntu Server 22.04 LTS - x64 Gen2', distro: 'Ubuntu 22.04.5 LTS' },
  { alias: 'Debian12', urn: 'Debian:debian-12:12-gen2:latest', publisher: 'Debian', offer: 'debian-12', sku: '12-gen2', os: 'Linux', displayName: 'Debian 12 "Bookworm" - x64 Gen2', distro: 'Debian GNU/Linux 12 (bookworm)' },
  { alias: 'Debian11', urn: 'Debian:debian-11:11-backports-gen2:latest', publisher: 'Debian', offer: 'debian-11', sku: '11-backports-gen2', os: 'Linux', displayName: 'Debian 11 "Bullseye" - x64 Gen2', distro: 'Debian GNU/Linux 11 (bullseye)' },
  { alias: 'RHELRaw8LVMGen2', urn: 'RedHat:RHEL:8-lvm-gen2:latest', publisher: 'RedHat', offer: 'RHEL', sku: '8-lvm-gen2', os: 'Linux', displayName: 'Red Hat Enterprise Linux 8 LVM - Gen2', distro: 'Red Hat Enterprise Linux 8.10' },
  { alias: 'Win2022Datacenter', urn: 'MicrosoftWindowsServer:WindowsServer:2022-datacenter-g2:latest', publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-datacenter-g2', os: 'Windows', displayName: 'Windows Server 2022 Datacenter - x64 Gen2', distro: 'Windows Server 2022 Datacenter' },
  { alias: 'Win2022AzureEditionCore', urn: 'MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition-core:latest', publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-datacenter-azure-edition-core', os: 'Windows', displayName: 'Windows Server 2022 Datacenter: Azure Edition Core', distro: 'Windows Server 2022 Azure Edition' },
  { alias: 'Win2019Datacenter', urn: 'MicrosoftWindowsServer:WindowsServer:2019-Datacenter:latest', publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2019-Datacenter', os: 'Windows', displayName: 'Windows Server 2019 Datacenter', distro: 'Windows Server 2019 Datacenter' },
];

export function findVmImage(aliasOrUrn?: string): VmImage | undefined {
  const v = (aliasOrUrn ?? '').toLowerCase();
  return VM_IMAGES.find((i) => i.alias.toLowerCase() === v || i.urn.toLowerCase() === v || i.urn.toLowerCase().replace(':latest', '') === v);
}

export const DISK_SKUS: Record<string, { label: string; pricePer32GB: number }> = {
  Premium_LRS: { label: 'SSD Premium (LRS)', pricePer32GB: 5.28 },
  StandardSSD_LRS: { label: 'SSD estándar (LRS)', pricePer32GB: 2.4 },
  Standard_LRS: { label: 'HDD estándar (LRS)', pricePer32GB: 1.54 },
  Premium_ZRS: { label: 'SSD Premium (ZRS)', pricePer32GB: 7.92 },
  StandardSSD_ZRS: { label: 'SSD estándar (ZRS)', pricePer32GB: 3.6 },
};

export interface WebRuntime {
  id: string;
  label: string;
  fx: string;
  os: 'linux' | 'windows';
  lang: 'node' | 'python' | 'dotnet' | 'java' | 'php';
}

export const WEB_RUNTIMES: WebRuntime[] = [
  { id: 'NODE:22-lts', label: 'Node 22 LTS', fx: 'NODE|22-lts', os: 'linux', lang: 'node' },
  { id: 'NODE:20-lts', label: 'Node 20 LTS', fx: 'NODE|20-lts', os: 'linux', lang: 'node' },
  { id: 'PYTHON:3.13', label: 'Python 3.13', fx: 'PYTHON|3.13', os: 'linux', lang: 'python' },
  { id: 'PYTHON:3.12', label: 'Python 3.12', fx: 'PYTHON|3.12', os: 'linux', lang: 'python' },
  { id: 'PYTHON:3.11', label: 'Python 3.11', fx: 'PYTHON|3.11', os: 'linux', lang: 'python' },
  { id: 'DOTNETCORE:9.0', label: '.NET 9 (STS)', fx: 'DOTNETCORE|9.0', os: 'linux', lang: 'dotnet' },
  { id: 'DOTNETCORE:8.0', label: '.NET 8 (LTS)', fx: 'DOTNETCORE|8.0', os: 'linux', lang: 'dotnet' },
  { id: 'JAVA:21-java21', label: 'Java 21', fx: 'JAVA|21-java21', os: 'linux', lang: 'java' },
  { id: 'JAVA:17-java17', label: 'Java 17', fx: 'JAVA|17-java17', os: 'linux', lang: 'java' },
  { id: 'PHP:8.3', label: 'PHP 8.3', fx: 'PHP|8.3', os: 'linux', lang: 'php' },
  { id: 'PHP:8.2', label: 'PHP 8.2', fx: 'PHP|8.2', os: 'linux', lang: 'php' },
  { id: 'dotnet:8', label: '.NET 8 (Windows)', fx: 'v8.0', os: 'windows', lang: 'dotnet' },
  { id: 'NODE:20LTS', label: 'Node 20 LTS (Windows)', fx: '~20', os: 'windows', lang: 'node' },
];

export function findRuntime(id?: string): WebRuntime | undefined {
  const v = (id ?? '').toLowerCase().replace('|', ':');
  return WEB_RUNTIMES.find((r) => r.id.toLowerCase() === v || r.fx.toLowerCase().replace('|', ':') === v);
}

export interface AppServiceSku {
  name: string;
  tier: string;
  family: string;
  pricePerHour: number;
  maxWorkers: number;
  slots: number;
  alwaysOn: boolean;
  autoscale: boolean;
  customDomains: boolean;
  cores: number;
  memoryGB: number;
  description: string;
}

export const APP_SERVICE_SKUS: AppServiceSku[] = [
  { name: 'F1', tier: 'Free', family: 'F', pricePerHour: 0, maxWorkers: 1, slots: 0, alwaysOn: false, autoscale: false, customDomains: false, cores: 0.25, memoryGB: 1, description: 'Gratis · compartido · 60 min CPU/día' },
  { name: 'B1', tier: 'Basic', family: 'B', pricePerHour: 0.018, maxWorkers: 3, slots: 0, alwaysOn: true, autoscale: false, customDomains: true, cores: 1, memoryGB: 1.75, description: 'Básico · desarrollo y pruebas' },
  { name: 'B2', tier: 'Basic', family: 'B', pricePerHour: 0.036, maxWorkers: 3, slots: 0, alwaysOn: true, autoscale: false, customDomains: true, cores: 2, memoryGB: 3.5, description: 'Básico' },
  { name: 'B3', tier: 'Basic', family: 'B', pricePerHour: 0.071, maxWorkers: 3, slots: 0, alwaysOn: true, autoscale: false, customDomains: true, cores: 4, memoryGB: 7, description: 'Básico' },
  { name: 'S1', tier: 'Standard', family: 'S', pricePerHour: 0.095, maxWorkers: 10, slots: 5, alwaysOn: true, autoscale: true, customDomains: true, cores: 1, memoryGB: 1.75, description: 'Estándar · slots y escalado automático' },
  { name: 'S2', tier: 'Standard', family: 'S', pricePerHour: 0.19, maxWorkers: 10, slots: 5, alwaysOn: true, autoscale: true, customDomains: true, cores: 2, memoryGB: 3.5, description: 'Estándar' },
  { name: 'S3', tier: 'Standard', family: 'S', pricePerHour: 0.38, maxWorkers: 10, slots: 5, alwaysOn: true, autoscale: true, customDomains: true, cores: 4, memoryGB: 7, description: 'Estándar' },
  { name: 'P0v3', tier: 'PremiumV3', family: 'Pv3', pricePerHour: 0.077, maxWorkers: 30, slots: 20, alwaysOn: true, autoscale: true, customDomains: true, cores: 1, memoryGB: 4, description: 'Premium v3 · producción' },
  { name: 'P1v3', tier: 'PremiumV3', family: 'Pv3', pricePerHour: 0.155, maxWorkers: 30, slots: 20, alwaysOn: true, autoscale: true, customDomains: true, cores: 2, memoryGB: 8, description: 'Premium v3 · producción' },
  { name: 'P2v3', tier: 'PremiumV3', family: 'Pv3', pricePerHour: 0.31, maxWorkers: 30, slots: 20, alwaysOn: true, autoscale: true, customDomains: true, cores: 4, memoryGB: 16, description: 'Premium v3' },
  { name: 'P3v3', tier: 'PremiumV3', family: 'Pv3', pricePerHour: 0.62, maxWorkers: 30, slots: 20, alwaysOn: true, autoscale: true, customDomains: true, cores: 8, memoryGB: 32, description: 'Premium v3' },
  { name: 'Y1', tier: 'Dynamic', family: 'Y', pricePerHour: 0, maxWorkers: 200, slots: 1, alwaysOn: false, autoscale: true, customDomains: true, cores: 0, memoryGB: 1.5, description: 'Consumo (Functions)' },
  { name: 'EP1', tier: 'ElasticPremium', family: 'EP', pricePerHour: 0.169, maxWorkers: 20, slots: 3, alwaysOn: true, autoscale: true, customDomains: true, cores: 1, memoryGB: 3.5, description: 'Functions Premium' },
];

export function findAppServiceSku(name?: string): AppServiceSku | undefined {
  return APP_SERVICE_SKUS.find((s) => s.name.toLowerCase() === (name ?? '').toLowerCase());
}

export const STORAGE_SKUS: Record<string, { label: string; tier: string; copies: string; priceGB: number }> = {
  Standard_LRS: { label: 'LRS · Almacenamiento con redundancia local', tier: 'Standard', copies: '3 copias en un centro de datos', priceGB: 0.0184 },
  Standard_ZRS: { label: 'ZRS · Redundancia de zona', tier: 'Standard', copies: '3 copias en 3 zonas de disponibilidad', priceGB: 0.023 },
  Standard_GRS: { label: 'GRS · Redundancia geográfica', tier: 'Standard', copies: '6 copias: 3 locales + 3 en la región emparejada', priceGB: 0.0368 },
  Standard_RAGRS: { label: 'RA-GRS · Geo con acceso de lectura', tier: 'Standard', copies: 'GRS + lectura en la región secundaria', priceGB: 0.046 },
  Standard_GZRS: { label: 'GZRS · Geo y zona', tier: 'Standard', copies: 'ZRS + copia en región emparejada', priceGB: 0.0414 },
  Standard_RAGZRS: { label: 'RA-GZRS · Geo y zona con lectura', tier: 'Standard', copies: 'GZRS + lectura secundaria', priceGB: 0.0518 },
  Premium_LRS: { label: 'Premium LRS', tier: 'Premium', copies: '3 copias en SSD', priceGB: 0.15 },
  Premium_ZRS: { label: 'Premium ZRS', tier: 'Premium', copies: '3 zonas en SSD', priceGB: 0.188 },
};

export const SQL_OBJECTIVES: Record<string, { tier: string; family?: string; capacity: number; monthly: number; label: string; maxSizeGB: number }> = {
  Basic: { tier: 'Basic', capacity: 5, monthly: 4.9, label: 'Basic · 5 DTU', maxSizeGB: 2 },
  S0: { tier: 'Standard', capacity: 10, monthly: 14.72, label: 'Standard S0 · 10 DTU', maxSizeGB: 250 },
  S1: { tier: 'Standard', capacity: 20, monthly: 29.43, label: 'Standard S1 · 20 DTU', maxSizeGB: 250 },
  S2: { tier: 'Standard', capacity: 50, monthly: 73.59, label: 'Standard S2 · 50 DTU', maxSizeGB: 250 },
  S3: { tier: 'Standard', capacity: 100, monthly: 147.18, label: 'Standard S3 · 100 DTU', maxSizeGB: 1024 },
  P1: { tier: 'Premium', capacity: 125, monthly: 456.25, label: 'Premium P1 · 125 DTU', maxSizeGB: 1024 },
  GP_S_Gen5_1: { tier: 'GeneralPurpose', family: 'Gen5', capacity: 1, monthly: 0, label: 'Uso general sin servidor · 1 vCore', maxSizeGB: 32 },
  GP_S_Gen5_2: { tier: 'GeneralPurpose', family: 'Gen5', capacity: 2, monthly: 0, label: 'Uso general sin servidor · 2 vCores', maxSizeGB: 32 },
  GP_Gen5_2: { tier: 'GeneralPurpose', family: 'Gen5', capacity: 2, monthly: 368.0, label: 'Uso general aprovisionado · 2 vCores', maxSizeGB: 1024 },
  BC_Gen5_2: { tier: 'BusinessCritical', family: 'Gen5', capacity: 2, monthly: 997.0, label: 'Crítico para la empresa · 2 vCores', maxSizeGB: 1024 },
};

export const ACR_SKUS: Record<string, { monthly: number; storageGB: number; label: string }> = {
  Basic: { monthly: 5, storageGB: 10, label: 'Básico · 10 GiB' },
  Standard: { monthly: 20, storageGB: 100, label: 'Estándar · 100 GiB' },
  Premium: { monthly: 50, storageGB: 500, label: 'Premium · 500 GiB, geo-replicación' },
};

export const K8S_VERSIONS = ['1.31.10', '1.32.6', '1.33.2'];
export const K8S_DEFAULT_VERSION = '1.32.6';

/** Imágenes públicas conocidas (Docker Hub / MCR). */
export const PUBLIC_IMAGES: Record<string, { port: number; response: string; size: number; cmd?: string }> = {
  nginx: { port: 80, response: '<h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working.</p>', size: 192 },
  httpd: { port: 80, response: '<html><body><h1>It works!</h1></body></html>', size: 148 },
  'mcr.microsoft.com/azuredocs/aci-helloworld': { port: 80, response: '<h1>Welcome to Azure Container Instances!</h1>', size: 66 },
  'mcr.microsoft.com/azuredocs/azure-vote-front': { port: 80, response: '<h1>Azure Voting App</h1><button>Cats</button><button>Dogs</button>', size: 940 },
  'mcr.microsoft.com/dotnet/samples': { port: 8080, response: '<h1>Welcome to .NET</h1>', size: 120 },
  'mcr.microsoft.com/k8se/quickstart': { port: 80, response: '<h1>Azure Container Apps Quickstart</h1>', size: 60 },
  redis: { port: 6379, response: '+PONG', size: 117 },
  busybox: { port: 0, response: '', size: 4 },
  'hello-world': { port: 0, response: 'Hello from Docker!', size: 0.02 },
  node: { port: 3000, response: '', size: 1100 },
  python: { port: 8000, response: '', size: 1000 },
  alpine: { port: 0, response: '', size: 7 },
  ubuntu: { port: 0, response: '', size: 78 },
  'mcr.microsoft.com/dotnet/aspnet': { port: 8080, response: '', size: 220 },
  postgres: { port: 5432, response: '', size: 430 },
  mongo: { port: 27017, response: '', size: 700 },
};

export function normalizeImageName(img: string): { repo: string; tag: string; registry: string | null } {
  let s = img.trim();
  let tag = 'latest';
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);
  const lastSlash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = s.slice(colon + 1);
    s = s.slice(0, colon);
  }
  let registry: string | null = null;
  const firstSeg = s.split('/')[0];
  if (s.includes('/') && (firstSeg.includes('.') || firstSeg.includes(':') || firstSeg === 'localhost')) {
    registry = firstSeg.toLowerCase();
    s = s.slice(firstSeg.length + 1);
  }
  if (registry && ['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(registry)) registry = null;
  let repo = s;
  if (!registry && repo.startsWith('library/')) repo = repo.slice('library/'.length);
  return { repo, tag, registry };
}

export function findPublicImage(img: string) {
  const { repo, registry } = normalizeImageName(img);
  if (registry && registry.endsWith('.azurecr.io')) return undefined;
  const key = registry ? `${registry}/${repo}` : repo;
  return PUBLIC_IMAGES[key] ? { name: key, ...PUBLIC_IMAGES[key] } : undefined;
}

/** Nombres que "otros clientes" ya usan globalmente (para enseñar la unicidad global). */
export const GLOBALLY_TAKEN = new Set([
  'test', 'storage', 'mystorage', 'mystorageaccount', 'storageaccount', 'demo', 'azure', 'data', 'backup', 'prod', 'dev',
  'files', 'images', 'media', 'logs', 'webapp', 'myapp', 'app', 'api', 'web', 'site', 'mywebapp', 'myvault', 'keyvault',
  'vault', 'registry', 'myregistry', 'sql', 'sqlserver', 'myserver', 'server', 'contoso', 'fabrikam', 'hello', 'helloworld',
  'acr', 'myacr', 'kv', 'mykv', 'portal', 'devops', 'pruebas', 'prueba', 'miapp', 'mialmacenamiento', 'almacenamiento',
]);

// ---------------- RBAC: roles integrados ----------------

const role = (name: string, roleName: string, description: string, actions: string[], notActions: string[] = [], dataActions: string[] = [], notDataActions: string[] = []): RoleDefinition => ({
  id: `/providers/Microsoft.Authorization/roleDefinitions/${name}`,
  name,
  roleName,
  description,
  roleType: 'BuiltInRole',
  permissions: [{ actions, notActions, dataActions, notDataActions }],
  assignableScopes: ['/'],
});

export const BUILTIN_ROLES: RoleDefinition[] = [
  role('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'Owner', 'Concede acceso total para administrar todos los recursos, incluida la capacidad de asignar roles en Azure RBAC.', ['*']),
  role('b24988ac-6180-42a0-ab88-20f7382dd24c', 'Contributor', 'Concede acceso total para administrar todos los recursos, pero no permite asignar roles en Azure RBAC.', ['*'], [
    'Microsoft.Authorization/*/Delete',
    'Microsoft.Authorization/*/Write',
    'Microsoft.Authorization/elevateAccess/Action',
  ]),
  role('acdd72a7-3385-48ef-bd42-f606fba81ae7', 'Reader', 'Permite ver todos los recursos, pero no realizar cambios.', ['*/read']),
  role('18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', 'User Access Administrator', 'Permite administrar el acceso de los usuarios a los recursos de Azure.', ['*/read', 'Microsoft.Authorization/*']),
  role('f58310d9-a9f6-439a-9e8d-f62e7b41a168', 'Role Based Access Control Administrator', 'Administra el acceso a recursos mediante asignaciones de roles (sin otras operaciones).', ['Microsoft.Authorization/roleAssignments/*', '*/read']),
  role('9980e02c-c2be-4d73-94e8-173b1dc7cf3c', 'Virtual Machine Contributor', 'Administra máquinas virtuales, pero no el acceso ni la red/almacenamiento a los que se conectan.', [
    'Microsoft.Compute/*',
    'Microsoft.Network/networkInterfaces/*',
    'Microsoft.Network/publicIPAddresses/*',
    'Microsoft.Network/virtualNetworks/subnets/join/action',
    'Microsoft.Network/networkSecurityGroups/join/action',
    'Microsoft.Network/*/read',
    'Microsoft.Resources/*/read',
    'Microsoft.Insights/*/read',
  ]),
  role('4d97b98b-1d4f-4787-a291-c67834d212e7', 'Network Contributor', 'Administra redes, pero no el acceso a ellas.', ['Microsoft.Network/*', 'Microsoft.Resources/*/read', 'Microsoft.Insights/*/read']),
  role('17d1049b-9a84-46fb-8f53-869881c3d3ab', 'Storage Account Contributor', 'Administra cuentas de almacenamiento (incluye claves), no el acceso.', ['Microsoft.Storage/storageAccounts/*', 'Microsoft.Resources/*/read', 'Microsoft.Insights/*/read']),
  role('b7e6dc6d-f1e8-4753-8033-0f276bb0955b', 'Storage Blob Data Owner', 'Acceso total a contenedores y datos de blobs, incluida la asignación de ACL POSIX.', ['Microsoft.Storage/storageAccounts/blobServices/containers/*', 'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'], [], ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*']),
  role('ba92f5b4-2d11-453d-a403-e96b0029c9fe', 'Storage Blob Data Contributor', 'Leer, escribir y eliminar contenedores y blobs de Azure Storage.', ['Microsoft.Storage/storageAccounts/blobServices/containers/delete', 'Microsoft.Storage/storageAccounts/blobServices/containers/read', 'Microsoft.Storage/storageAccounts/blobServices/containers/write', 'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'], [], [
    'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete',
    'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read',
    'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write',
    'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action',
  ]),
  role('090c5cfd-751d-490a-894a-3ce6f1109419', 'Azure Service Bus Data Owner', 'Acceso total a los recursos de Azure Service Bus (enviar, recibir y administrar entidades).', ['Microsoft.ServiceBus/*'], [], ['Microsoft.ServiceBus/*']),
  role('69a216fc-b8fb-44d8-bc22-1f3c2cd27a39', 'Azure Service Bus Data Sender', 'Enviar mensajes a colas y temas de Service Bus.', ['Microsoft.ServiceBus/*/queues/read', 'Microsoft.ServiceBus/*/topics/read', 'Microsoft.ServiceBus/*/topics/subscriptions/read'], [], ['Microsoft.ServiceBus/*/send/action']),
  role('4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0', 'Azure Service Bus Data Receiver', 'Recibir mensajes de colas y suscripciones de Service Bus.', ['Microsoft.ServiceBus/*/queues/read', 'Microsoft.ServiceBus/*/topics/read', 'Microsoft.ServiceBus/*/topics/subscriptions/read'], [], ['Microsoft.ServiceBus/*/receive/action']),
  role('befefa01-2a29-4197-83a8-272ff33ce314', 'DNS Zone Contributor', 'Administra zonas DNS y conjuntos de registros, pero no el acceso a ellos.', ['Microsoft.Authorization/*/read', 'Microsoft.Network/dnsZones/*', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Resources/deployments/*']),
  role('2a2b9908-6ea1-4ae2-8e65-a410df84e7d1', 'Storage Blob Data Reader', 'Leer y enumerar contenedores y blobs de Azure Storage.', ['Microsoft.Storage/storageAccounts/blobServices/containers/read', 'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'], [], ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read']),
  role('00482a5a-887f-4fb3-b363-3b7fe8e74483', 'Key Vault Administrator', 'Realiza todas las operaciones de plano de datos en un almacén de claves.', ['Microsoft.Authorization/*/read', 'Microsoft.Insights/alertRules/*', 'Microsoft.Resources/*/read', 'Microsoft.KeyVault/checkNameAvailability/read', 'Microsoft.KeyVault/deletedVaults/read', 'Microsoft.KeyVault/locations/*/read', 'Microsoft.KeyVault/vaults/*/read', 'Microsoft.KeyVault/operations/read'], [], ['Microsoft.KeyVault/vaults/*']),
  role('b86a8fe4-44ce-4948-aee5-eccb2c155cd7', 'Key Vault Secrets Officer', 'Realiza cualquier acción sobre los secretos de un almacén de claves.', ['Microsoft.Authorization/*/read', 'Microsoft.Resources/*/read', 'Microsoft.KeyVault/vaults/*/read'], [], ['Microsoft.KeyVault/vaults/secrets/*']),
  role('4633458b-17de-408a-b874-0445c86b69e6', 'Key Vault Secrets User', 'Lee el contenido de los secretos.', [], [], ['Microsoft.KeyVault/vaults/secrets/getSecret/action', 'Microsoft.KeyVault/vaults/secrets/readMetadata/action']),
  role('f25e0fa2-a7c8-4377-a976-54943a77a395', 'Key Vault Contributor', 'Administra almacenes de claves, pero no permite asignar roles ni acceder a secretos.', ['Microsoft.KeyVault/*', 'Microsoft.Resources/*/read', 'Microsoft.Insights/alertRules/*'], ['Microsoft.KeyVault/locations/deletedVaults/purge/action']),
  role('7f951dda-4ed3-4680-a7ca-43fe172d538d', 'AcrPull', 'Extraer (pull) imágenes de un registro de contenedor.', ['Microsoft.ContainerRegistry/registries/pull/read']),
  role('8311e382-0749-4cb8-b61a-304f252e45ec', 'AcrPush', 'Insertar (push) y extraer imágenes de un registro de contenedor.', ['Microsoft.ContainerRegistry/registries/pull/read', 'Microsoft.ContainerRegistry/registries/push/write']),
  role('de139f84-1756-47ae-9be6-808fbbe84772', 'Website Contributor', 'Administra sitios web (no planes), pero no el acceso a ellos.', ['Microsoft.Web/sites/*', 'Microsoft.Web/serverFarms/join/action', 'Microsoft.Web/serverFarms/read', 'Microsoft.Resources/*/read', 'Microsoft.Insights/*/read']),
  role('9b7fa17d-e63e-47b0-bb0a-15c516ac86ec', 'SQL DB Contributor', 'Administra bases de datos SQL, pero no el acceso ni las directivas de seguridad.', ['Microsoft.Sql/servers/databases/*', 'Microsoft.Sql/servers/read', 'Microsoft.Resources/*/read', 'Microsoft.Insights/*/read']),
  role('6d8ee4ec-f05a-4a1d-8b00-a9b17e38b437', 'SQL Server Contributor', 'Administra servidores y bases de datos SQL, pero no el acceso.', ['Microsoft.Sql/servers/*', 'Microsoft.Resources/*/read', 'Microsoft.Insights/*/read']),
  role('43d0d8ad-25c7-4714-9337-8ba259a9fe05', 'Monitoring Reader', 'Puede leer todos los datos de supervisión (métricas, registros, etc.).', ['*/read', 'Microsoft.OperationalInsights/workspaces/search/action']),
  role('749f88d5-cbae-40b8-bcfc-e573ddc772fa', 'Monitoring Contributor', 'Puede leer todos los datos de supervisión y editar la configuración de supervisión.', ['*/read', 'Microsoft.Insights/*', 'Microsoft.AlertsManagement/*', 'Microsoft.OperationalInsights/workspaces/*']),
  role('73c42c96-874c-492b-b04d-ab87d138a893', 'Log Analytics Reader', 'Puede ver y buscar todos los datos de supervisión.', ['*/read', 'Microsoft.OperationalInsights/workspaces/analytics/query/action', 'Microsoft.OperationalInsights/workspaces/search/action']),
  role('4abbcc35-e782-43d8-92c5-2d3f1bd2253f', 'Azure Kubernetes Service Cluster User Role', 'Permite obtener las credenciales de usuario del clúster.', ['Microsoft.ContainerService/managedClusters/listClusterUserCredential/action', 'Microsoft.ContainerService/managedClusters/read']),
  role('0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8', 'Azure Kubernetes Service Cluster Admin Role', 'Permite obtener las credenciales de administrador del clúster.', ['Microsoft.ContainerService/managedClusters/listClusterAdminCredential/action', 'Microsoft.ContainerService/managedClusters/accessProfiles/listCredential/action', 'Microsoft.ContainerService/managedClusters/read', 'Microsoft.ContainerService/managedClusters/runcommand/action']),
  role('f1a07417-d97a-45cb-824c-7a7467783830', 'Managed Identity Operator', 'Leer y asignar identidades asignadas por el usuario.', ['Microsoft.ManagedIdentity/userAssignedIdentities/*/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/*/assign/action', 'Microsoft.Resources/*/read']),
];

export function findRole(nameOrId: string): RoleDefinition | undefined {
  const v = nameOrId.toLowerCase();
  return BUILTIN_ROLES.find((r) => r.roleName.toLowerCase() === v || r.name === v || r.id.toLowerCase() === v || r.id.toLowerCase().endsWith('/' + v));
}

// ---------------- Azure Policy: definiciones integradas ----------------

export type PolicyRuleKey =
  | 'allowedLocations'
  | 'allowedLocationsRg'
  | 'requireTag'
  | 'requireTagRg'
  | 'allowedVmSkus'
  | 'notAllowedTypes'
  | 'inheritTag'
  | 'secureTransfer'
  | 'allowedStorageSkus'
  | 'kvPurgeProtection'
  | 'noPublicBlob';

export interface PolicyDefinitionInfo {
  name: string;
  displayName: string;
  description: string;
  category: string;
  effect: 'Deny' | 'Audit' | 'Modify';
  rule: PolicyRuleKey;
  parameters: Record<string, { type: 'String' | 'Array'; displayName: string; description: string }>;
}

export const POLICY_DEFINITIONS: PolicyDefinitionInfo[] = [
  { name: 'e56962a6-4747-49cd-b67b-bf8b01975c4c', displayName: 'Allowed locations', description: 'Restringe las ubicaciones en las que tu organización puede implementar recursos.', category: 'General', effect: 'Deny', rule: 'allowedLocations', parameters: { listOfAllowedLocations: { type: 'Array', displayName: 'Ubicaciones permitidas', description: 'Lista de ubicaciones en las que se pueden implementar recursos.' } } },
  { name: 'e765b5de-1225-4ba3-bd56-1ac6695af988', displayName: 'Allowed locations for resource groups', description: 'Restringe las ubicaciones en las que se pueden crear grupos de recursos.', category: 'General', effect: 'Deny', rule: 'allowedLocationsRg', parameters: { listOfAllowedLocations: { type: 'Array', displayName: 'Ubicaciones permitidas', description: 'Lista de ubicaciones permitidas para grupos de recursos.' } } },
  { name: '871b6d14-10aa-478d-b590-94f262ecfa99', displayName: 'Require a tag on resources', description: 'Exige la existencia de una etiqueta. No se aplica a grupos de recursos.', category: 'Tags', effect: 'Deny', rule: 'requireTag', parameters: { tagName: { type: 'String', displayName: 'Nombre de etiqueta', description: 'Nombre de la etiqueta, como "entorno".' } } },
  { name: '96670d01-0a4d-4649-9c89-2d3abc0a5025', displayName: 'Require a tag on resource groups', description: 'Exige la existencia de una etiqueta en los grupos de recursos.', category: 'Tags', effect: 'Deny', rule: 'requireTagRg', parameters: { tagName: { type: 'String', displayName: 'Nombre de etiqueta', description: 'Nombre de la etiqueta.' } } },
  { name: 'ea3f2387-9b95-492a-a190-fcdc54f7b070', displayName: 'Inherit a tag from the resource group if missing', description: 'Agrega la etiqueta especificada con su valor del grupo de recursos cuando falta en un recurso.', category: 'Tags', effect: 'Modify', rule: 'inheritTag', parameters: { tagName: { type: 'String', displayName: 'Nombre de etiqueta', description: 'Etiqueta que se heredará del grupo de recursos.' } } },
  { name: 'cccc23c7-8427-4f53-ad12-b6a63eb452b3', displayName: 'Allowed virtual machine size SKUs', description: 'Permite especificar un conjunto de tamaños de máquina virtual que la organización puede implementar.', category: 'Compute', effect: 'Deny', rule: 'allowedVmSkus', parameters: { listOfAllowedSKUs: { type: 'Array', displayName: 'Tamaños permitidos', description: 'Lista de SKUs de VM permitidos.' } } },
  { name: '6c112d4e-5bc7-47ae-a041-ea2d9dccd749', displayName: 'Not allowed resource types', description: 'Restringe los tipos de recursos que se pueden implementar.', category: 'General', effect: 'Deny', rule: 'notAllowedTypes', parameters: { listOfResourceTypesNotAllowed: { type: 'Array', displayName: 'Tipos no permitidos', description: 'Lista de tipos de recurso prohibidos.' } } },
  { name: '7433c107-6db4-4ad1-b57a-a76dce0154a1', displayName: 'Storage accounts should be limited by allowed SKUs', description: 'Restringe los SKUs de cuentas de almacenamiento que se pueden implementar.', category: 'Storage', effect: 'Deny', rule: 'allowedStorageSkus', parameters: { listOfAllowedSKUs: { type: 'Array', displayName: 'SKUs permitidos', description: 'Lista de SKUs de almacenamiento permitidos.' } } },
  { name: '404c3081-a854-4457-ae30-26a93ef643f9', displayName: 'Secure transfer to storage accounts should be enabled', description: 'Audita que las cuentas de almacenamiento sólo acepten HTTPS.', category: 'Storage', effect: 'Audit', rule: 'secureTransfer', parameters: {} },
  { name: '4fa4b6c0-31ca-4c0d-b10d-24b96f62a751', displayName: 'Storage account public access should be disallowed', description: 'Audita las cuentas que permiten acceso público anónimo a blobs.', category: 'Storage', effect: 'Audit', rule: 'noPublicBlob', parameters: {} },
  { name: '0b60c0b2-2dc2-4e1c-b5c9-abbed971de53', displayName: 'Key vaults should have deletion protection enabled', description: 'Audita los almacenes de claves sin protección de purga.', category: 'Key Vault', effect: 'Audit', rule: 'kvPurgeProtection', parameters: {} },
];

export function findPolicyDefinition(nameOrId: string): PolicyDefinitionInfo | undefined {
  const v = nameOrId.toLowerCase().split('/').pop()!;
  return POLICY_DEFINITIONS.find((p) => p.name === v || p.displayName.toLowerCase() === nameOrId.toLowerCase());
}

export const METRIC_CATALOG: Record<string, { name: string; unit: string; aggregation: string; label: string }[]> = {
  'microsoft.compute/virtualmachines': [
    { name: 'Percentage CPU', unit: 'Percent', aggregation: 'Average', label: 'Porcentaje de CPU' },
    { name: 'Available Memory Bytes', unit: 'Bytes', aggregation: 'Average', label: 'Memoria disponible' },
    { name: 'Network In Total', unit: 'Bytes', aggregation: 'Total', label: 'Red de entrada total' },
    { name: 'Network Out Total', unit: 'Bytes', aggregation: 'Total', label: 'Red de salida total' },
  ],
  'microsoft.web/sites': [
    { name: 'Requests', unit: 'Count', aggregation: 'Total', label: 'Solicitudes' },
    { name: 'Http5xx', unit: 'Count', aggregation: 'Total', label: 'Errores HTTP 5xx' },
    { name: 'Http4xx', unit: 'Count', aggregation: 'Total', label: 'Errores HTTP 4xx' },
    { name: 'AverageResponseTime', unit: 'Seconds', aggregation: 'Average', label: 'Tiempo de respuesta' },
    { name: 'CpuTime', unit: 'Seconds', aggregation: 'Total', label: 'Tiempo de CPU' },
  ],
  'microsoft.web/serverfarms': [
    { name: 'CpuPercentage', unit: 'Percent', aggregation: 'Average', label: 'Porcentaje de CPU' },
    { name: 'MemoryPercentage', unit: 'Percent', aggregation: 'Average', label: 'Porcentaje de memoria' },
  ],
  'microsoft.storage/storageaccounts': [
    { name: 'Transactions', unit: 'Count', aggregation: 'Total', label: 'Transacciones' },
    { name: 'UsedCapacity', unit: 'Bytes', aggregation: 'Average', label: 'Capacidad usada' },
    { name: 'Availability', unit: 'Percent', aggregation: 'Average', label: 'Disponibilidad' },
  ],
  'microsoft.sql/servers/databases': [
    { name: 'cpu_percent', unit: 'Percent', aggregation: 'Average', label: 'Porcentaje de CPU' },
    { name: 'dtu_consumption_percent', unit: 'Percent', aggregation: 'Average', label: 'Porcentaje de DTU' },
    { name: 'connection_successful', unit: 'Count', aggregation: 'Total', label: 'Conexiones correctas' },
  ],
  'microsoft.containerservice/managedclusters': [
    { name: 'node_cpu_usage_percentage', unit: 'Percent', aggregation: 'Average', label: 'Uso de CPU de nodos' },
    { name: 'kube_pod_status_ready', unit: 'Count', aggregation: 'Average', label: 'Pods listos' },
  ],
  'microsoft.keyvault/vaults': [
    { name: 'ServiceApiHit', unit: 'Count', aggregation: 'Total', label: 'Llamadas a la API' },
    { name: 'Availability', unit: 'Percent', aggregation: 'Average', label: 'Disponibilidad' },
  ],
  'microsoft.containerinstance/containergroups': [
    { name: 'CpuUsage', unit: 'Count', aggregation: 'Average', label: 'Uso de CPU' },
    { name: 'MemoryUsage', unit: 'Bytes', aggregation: 'Average', label: 'Uso de memoria' },
  ],
};
