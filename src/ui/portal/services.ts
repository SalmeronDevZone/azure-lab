// Catálogo de servicios del portal (menú, "Todos los servicios", búsqueda).

export interface ServiceDef {
  id: string;
  label: string;
  icon: string;
  category: string;
  type?: string;
  href?: string;
  create?: string;
  keywords?: string;
  description?: string;
}

export const typeHref = (type: string) => `#/browse/${encodeURIComponent(type)}`;

export const SERVICES: ServiceDef[] = [
  { id: 'rg', label: 'Grupos de recursos', icon: 'rg', category: 'General', href: '#/groups', create: 'rg', keywords: 'resource groups grupo', description: 'Contenedores lógicos que agrupan recursos relacionados.' },
  { id: 'all', label: 'Todos los recursos', icon: 'all', category: 'General', href: '#/resources', keywords: 'all resources', description: 'Lista de todos los recursos de tus suscripciones.' },
  { id: 'subs', label: 'Suscripciones', icon: 'subscription', category: 'General', href: '#/subscriptions', keywords: 'subscriptions billing facturación', description: 'Unidad de facturación y límite de acceso.' },
  { id: 'vm', label: 'Máquinas virtuales', icon: 'vm', category: 'Proceso', type: 'Microsoft.Compute/virtualMachines', create: 'vm', keywords: 'virtual machines vm linux windows servidor', description: 'Servidores Linux y Windows bajo demanda (IaaS).' },
  { id: 'vmss', label: 'Conjuntos de escalado de VM', icon: 'vmss', category: 'Proceso', type: 'Microsoft.Compute/virtualMachineScaleSets', keywords: 'vmss scale sets', description: 'Grupos de VM idénticas con escalado automático.' },
  { id: 'disk', label: 'Discos', icon: 'disk', category: 'Proceso', type: 'Microsoft.Compute/disks', keywords: 'disks managed', description: 'Discos administrados para máquinas virtuales.' },
  { id: 'webapp', label: 'App Services', icon: 'webapp', category: 'Web', type: 'Microsoft.Web/sites', create: 'webapp', keywords: 'web app service paas aplicaciones web functions', description: 'Hospedaje de aplicaciones web totalmente administrado (PaaS).' },
  { id: 'plan', label: 'Planes de App Service', icon: 'plan', category: 'Web', type: 'Microsoft.Web/serverfarms', create: 'plan', keywords: 'app service plan', description: 'Capacidad de proceso donde se ejecutan las web apps.' },
  { id: 'storage', label: 'Cuentas de almacenamiento', icon: 'storage', category: 'Almacenamiento', type: 'Microsoft.Storage/storageAccounts', create: 'storage', keywords: 'storage blob files queue tablas', description: 'Blobs, archivos, colas y tablas en la nube.' },
  { id: 'sqlserver', label: 'Servidores SQL', icon: 'sqlserver', category: 'Bases de datos', type: 'Microsoft.Sql/servers', create: 'sql', keywords: 'sql server azure sql', description: 'Servidor lógico para bases de datos de Azure SQL.' },
  { id: 'sqldb', label: 'Bases de datos SQL', icon: 'sqldb', category: 'Bases de datos', type: 'Microsoft.Sql/servers/databases', create: 'sql', keywords: 'sql database base de datos', description: 'Base de datos relacional administrada (PaaS).' },
  { id: 'vnet', label: 'Redes virtuales', icon: 'vnet', category: 'Redes', type: 'Microsoft.Network/virtualNetworks', create: 'vnet', keywords: 'vnet virtual network subred subnet', description: 'Red privada aislada en Azure.' },
  { id: 'nsg', label: 'Grupos de seguridad de red', icon: 'nsg', category: 'Redes', type: 'Microsoft.Network/networkSecurityGroups', create: 'nsg', keywords: 'nsg firewall reglas security group', description: 'Reglas de filtrado de tráfico de red.' },
  { id: 'pip', label: 'Direcciones IP públicas', icon: 'pip', category: 'Redes', type: 'Microsoft.Network/publicIPAddresses', create: 'pip', keywords: 'public ip pública', description: 'Direcciones IP accesibles desde Internet.' },
  { id: 'nic', label: 'Interfaces de red', icon: 'nic', category: 'Redes', type: 'Microsoft.Network/networkInterfaces', keywords: 'nic network interface', description: 'Tarjetas de red virtuales de las VM.' },
  { id: 'lb', label: 'Equilibradores de carga', icon: 'lb', category: 'Redes', type: 'Microsoft.Network/loadBalancers', keywords: 'load balancer equilibrador', description: 'Reparte el tráfico entre varias VM.' },
  { id: 'dns', label: 'Zonas DNS', icon: 'dns', category: 'Redes', type: 'Microsoft.Network/dnsZones', create: 'dns', keywords: 'dns zona dominio registro cname a txt mx', description: 'Hospeda los registros DNS de tus dominios.' },
  { id: 'sb', label: 'Service Bus', icon: 'servicebus', category: 'Integración', type: 'Microsoft.ServiceBus/namespaces', create: 'servicebus', keywords: 'service bus colas temas mensajería queue topic suscripción', description: 'Mensajería empresarial con colas y temas (pub/sub).' },
  { id: 'aks', label: 'Servicios de Kubernetes', icon: 'aks', category: 'Contenedores', type: 'Microsoft.ContainerService/managedClusters', create: 'aks', keywords: 'aks kubernetes k8s cluster', description: 'Kubernetes administrado (AKS).' },
  { id: 'acr', label: 'Registros de contenedor', icon: 'acr', category: 'Contenedores', type: 'Microsoft.ContainerRegistry/registries', create: 'acr', keywords: 'acr container registry docker imágenes', description: 'Registro privado de imágenes Docker.' },
  { id: 'aci', label: 'Instancias de contenedor', icon: 'aci', category: 'Contenedores', type: 'Microsoft.ContainerInstance/containerGroups', create: 'aci', keywords: 'aci container instances', description: 'Ejecuta un contenedor sin administrar servidores.' },
  { id: 'kv', label: 'Almacenes de claves', icon: 'keyvault', category: 'Seguridad', type: 'Microsoft.KeyVault/vaults', create: 'keyvault', keywords: 'key vault secretos claves certificados', description: 'Guarda secretos, claves y certificados de forma segura.' },
  { id: 'mi', label: 'Identidades administradas', icon: 'identity', category: 'Identidad', type: 'Microsoft.ManagedIdentity/userAssignedIdentities', create: 'identity', keywords: 'managed identity identidad', description: 'Identidades de Entra ID para recursos de Azure.' },
  { id: 'entra', label: 'Microsoft Entra ID', icon: 'entra', category: 'Identidad', href: '#/entra', keywords: 'azure ad active directory usuarios grupos aplicaciones entra', description: 'Usuarios, grupos y registros de aplicaciones.' },
  { id: 'monitor', label: 'Monitor', icon: 'monitor', category: 'Supervisión', href: '#/monitor', keywords: 'monitor métricas alertas logs kql', description: 'Métricas, alertas y registros de toda la plataforma.' },
  { id: 'law', label: 'Áreas de trabajo de Log Analytics', icon: 'loganalytics', category: 'Supervisión', type: 'Microsoft.OperationalInsights/workspaces', create: 'law', keywords: 'log analytics workspace kql', description: 'Almacén de registros consultable con KQL.' },
  { id: 'appi', label: 'Application Insights', icon: 'appinsights', category: 'Supervisión', type: 'Microsoft.Insights/components', create: 'appinsights', keywords: 'application insights apm telemetría', description: 'Supervisión del rendimiento de aplicaciones.' },
  { id: 'cost', label: 'Cost Management', icon: 'cost', category: 'Administración', href: '#/cost', keywords: 'costes cost presupuesto budget facturación', description: 'Análisis de costes y presupuestos.' },
  { id: 'advisor', label: 'Advisor', icon: 'advisor', category: 'Administración', href: '#/advisor', keywords: 'advisor recomendaciones', description: 'Recomendaciones de coste, seguridad y fiabilidad.' },
  { id: 'policy', label: 'Directiva', icon: 'policy', category: 'Administración', href: '#/policy', keywords: 'policy directiva gobierno cumplimiento', description: 'Reglas de gobierno y cumplimiento.' },
  { id: 'graph', label: 'Explorador de Resource Graph', icon: 'graph', category: 'Administración', href: '#/graph', keywords: 'resource graph explorer kql inventario consulta', description: 'Consulta tu inventario de recursos con KQL.' },
  { id: 'activity', label: 'Registro de actividad', icon: 'monitor', category: 'Administración', href: '#/monitor/activity', keywords: 'activity log registro auditoría', description: 'Quién hizo qué y cuándo.' },
  { id: 'devops', label: 'Azure DevOps', icon: 'devops', category: 'DevOps', href: '#/devops', keywords: 'devops repos pipelines boards ci cd git', description: 'Repos, Pipelines, Boards y entornos.' },
  { id: 'academy', label: 'Academia Azure Lab', icon: 'academy', category: 'Aprendizaje', href: '#/academy', keywords: 'academia cursos niveles ejercicios aprender', description: 'Ruta guiada por niveles hasta DevOps.' },
  { id: 'ficheros', label: 'Guía de ficheros', icon: 'academy', category: 'Aprendizaje', href: '#/academy/ficheros', keywords: 'env .env gitignore dockerignore funcignore node_modules package-lock tfstate secretos ficheros despliegue', description: 'Qué se sube a Git, qué se despliega y qué nunca debe salir de tu ordenador.' },
  { id: 'mail', label: 'Correo (simulado)', icon: 'mail', category: 'Aprendizaje', href: '#/mail', keywords: 'correo email alertas', description: 'Bandeja de entrada de las alertas y avisos.' },
];

export function serviceHref(s: ServiceDef) {
  return s.href ?? (s.type ? typeHref(s.type) : '#/');
}

export function serviceForType(type: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.type?.toLowerCase() === type.toLowerCase());
}

/** Asistente de creación por tipo de recurso. */
export const CREATE_FOR_TYPE: Record<string, string> = Object.fromEntries(SERVICES.filter((s) => s.type && s.create).map((s) => [s.type!.toLowerCase(), s.create!]));
