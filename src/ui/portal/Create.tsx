// Asistentes de creación de recursos (como "Crear" en el portal). Cada asistente genera los comandos az
// equivalentes, que se muestran en "Revisar y crear" y se ejecutan contra la nube simulada.
import { useMemo, useState } from 'react';
import type { CloudState } from '../../engine/types';
import { useCloud, navigate, useRoute, resourceHref, rgHref } from '../hooks';
import { ServiceIcon } from '../components/Icons';
import { Callout, CliBox, Field, Select, TextInput, Checkbox, Spinner } from '../components/common';
import { Crumbs } from './blade';
import { az, cliText, errorText, tipText } from '../portalCli';
import { notify } from '../../engine/arm';
import { getProvider } from '../../engine/registry';
import { resourceId } from '../../engine/ids';
import { LOCATIONS, VM_IMAGES, VM_SIZES, WEB_RUNTIMES, APP_SERVICE_SKUS, SQL_OBJECTIVES, ACR_SKUS, K8S_VERSIONS, STORAGE_SKUS, GLOBALLY_TAKEN } from '../../engine/catalog';
import { formatMoney, guid } from '../../engine/util';
import { SB_SKUS } from '../../engine/providers/servicebus';
import { getState } from '../../engine/store';
import { toast } from '../uiStore';
import { terminal } from '../terminal/controller';

type V = Record<string, any>;
type Opt = string | { value: string; label: string };

interface F {
  key: string;
  label: string;
  tab: string;
  type?: 'text' | 'password' | 'select' | 'checkbox' | 'textarea';
  options?: (v: V, s: CloudState) => Opt[];
  def?: (s: CloudState, q: URLSearchParams) => any;
  required?: boolean;
  help?: string | ((v: V) => string);
  validate?: (val: any, v: V, s: CloudState) => string | null;
  show?: (v: V) => boolean;
  section?: string;
}

interface Cmd {
  title: string;
  args: string[];
}

interface WizardDef {
  id: string;
  title: string;
  icon: string;
  type?: string;
  intro: string;
  tabs: string[];
  fields: F[];
  commands: (v: V, s: CloudState) => Cmd[];
  target: (v: V, s: CloudState) => string;
  cost?: (v: V) => number | null;
}

// ---------------------------------------------------------------- utilidades comunes

const rgName = (v: V) => (v.rg === '__new__' ? v.newRg : v.rg);
const rgCmd = (v: V): Cmd[] => (v.rg === '__new__' ? [{ title: 'Crear grupo de recursos', args: ['group', 'create', '-n', v.newRg, '-l', v.location] }] : []);
const tagArgs = (v: V) => {
  const t = String(v.tags ?? '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter((x) => x.includes('='));
  return t.length ? ['--tags', ...t] : [];
};

function validateName(type: string, name: string, s: CloudState): string | null {
  if (!name) return 'El valor no puede estar vacío.';
  const p = getProvider(type);
  if (p?.nameRule && !p.nameRule.test(name)) return p.nameRule.message.replace(/\{name\}/g, name).replace(/'\{n\w*\}'/g, `'${name}'`);
  if (p?.global) {
    if (GLOBALLY_TAKEN.has(name.toLowerCase()) || s.resources.some((r) => r.type.toLowerCase() === type.toLowerCase() && r.name.toLowerCase() === name.toLowerCase())) return `El nombre "${name}" ya está en uso (debe ser único en todo Azure). Prueba añadiendo tus iniciales o un número.`;
  }
  return null;
}

function baseFields(type: string, opts: { nameLabel?: string; nameHelp?: string; locationless?: boolean } = {}): F[] {
  return [
    { key: 'sub', label: 'Suscripción', tab: 'Aspectos básicos', type: 'select', section: 'Detalles del proyecto', options: (_v, s) => s.subscriptions.map((x) => ({ value: x.id, label: x.displayName })), def: (s) => s.currentSubscriptionId, required: true },
    {
      key: 'rg',
      label: 'Grupo de recursos',
      tab: 'Aspectos básicos',
      type: 'select',
      options: (v, s) => [{ value: '', label: 'Seleccionar un grupo de recursos' }, ...s.resourceGroups.filter((g) => g.subscriptionId === v.sub && !g.managedBy).map((g) => g.name), { value: '__new__', label: '(Crear nuevo)' }],
      def: (_s, q) => q.get('rg') ?? '',
      required: true,
      help: 'Contenedor lógico que agrupa los recursos de una solución.',
    },
    { key: 'newRg', label: 'Nombre del nuevo grupo de recursos', tab: 'Aspectos básicos', show: (v) => v.rg === '__new__', required: true, validate: (val, v, s) => (val && s.resourceGroups.some((g) => g.subscriptionId === v.sub && g.name.toLowerCase() === String(val).toLowerCase()) ? 'Ya existe un grupo con ese nombre.' : !/^[-\w._()]{1,90}$/.test(val ?? '') || String(val).endsWith('.') ? 'Nombre no válido.' : null) },
    { key: 'name', label: opts.nameLabel ?? 'Nombre', tab: 'Aspectos básicos', section: 'Detalles de la instancia', required: true, help: opts.nameHelp, validate: (val, _v, s) => validateName(type, val, s) },
    ...(opts.locationless ? [] : [{ key: 'location', label: 'Región', tab: 'Aspectos básicos', type: 'select' as const, options: () => LOCATIONS.map((l) => ({ value: l.name, label: `(${l.geo}) ${l.displayName}` })), def: () => 'westeurope', required: true }]),
  ];
}

const tagsField: F = { key: 'tags', label: 'Etiquetas', tab: 'Etiquetas', type: 'textarea', help: 'Pares nombre=valor separados por comas o líneas, p. ej. entorno=dev, proyecto=web' };

// ---------------------------------------------------------------- definiciones de asistentes

const WIZARDS: Record<string, WizardDef> = {
  rg: {
    id: 'rg',
    title: 'Crear un grupo de recursos',
    icon: 'rg',
    intro: 'Un grupo de recursos es un contenedor que contiene los recursos relacionados de una solución de Azure. Decide qué recursos quieres agrupar según lo que tenga sentido para tu organización (normalmente, los que comparten ciclo de vida).',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [
      { key: 'sub', label: 'Suscripción', tab: 'Aspectos básicos', type: 'select', section: 'Detalles del proyecto', options: (_v, s) => s.subscriptions.map((x) => ({ value: x.id, label: x.displayName })), def: (s) => s.currentSubscriptionId, required: true },
      { key: 'name', label: 'Grupo de recursos', tab: 'Aspectos básicos', required: true, validate: (val, v, s) => (!/^[-\w._()]{1,90}$/.test(val ?? '') || String(val).endsWith('.') ? 'El nombre solo puede contener letras, números, guiones, guiones bajos, puntos y paréntesis (máx. 90).' : s.resourceGroups.some((g) => g.subscriptionId === v.sub && g.name.toLowerCase() === String(val).toLowerCase()) ? 'Ya existe un grupo de recursos con ese nombre.' : null) },
      { key: 'location', label: 'Región', tab: 'Aspectos básicos', type: 'select', section: 'Detalles del recurso', options: () => LOCATIONS.map((l) => ({ value: l.name, label: `(${l.geo}) ${l.displayName}` })), def: () => 'westeurope', required: true, help: 'Dónde se guardan los metadatos del grupo. Los recursos pueden estar en otras regiones.' },
      tagsField,
    ],
    commands: (v) => [{ title: 'Crear grupo de recursos', args: ['group', 'create', '-n', v.name, '-l', v.location, ...tagArgs(v)] }],
    target: (v) => `/subscriptions/${v.sub}/resourceGroups/${v.name}`,
    cost: () => 0,
  },
  storage: {
    id: 'storage',
    title: 'Crear una cuenta de almacenamiento',
    icon: 'storage',
    type: 'Microsoft.Storage/storageAccounts',
    intro: 'Azure Storage ofrece almacenamiento en la nube para blobs, archivos, colas y tablas, de alta disponibilidad, seguro y escalable.',
    tabs: ['Aspectos básicos', 'Opciones avanzadas', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Storage/storageAccounts', { nameLabel: 'Nombre de la cuenta de almacenamiento', nameHelp: '3-24 caracteres, sólo minúsculas y números. Debe ser único en todo Azure.' }),
      { key: 'perf', label: 'Rendimiento', tab: 'Aspectos básicos', type: 'select', options: () => [{ value: 'Standard', label: 'Estándar: recomendado para la mayoría de escenarios (v2)' }, { value: 'Premium', label: 'Prémium: baja latencia (SSD)' }], def: () => 'Standard' },
      { key: 'redundancy', label: 'Redundancia', tab: 'Aspectos básicos', type: 'select', options: (v) => (v.perf === 'Premium' ? [{ value: 'LRS', label: STORAGE_SKUS.Premium_LRS?.label ?? 'LRS' }] : ['LRS', 'ZRS', 'GRS', 'RAGRS'].map((x) => ({ value: x, label: STORAGE_SKUS[`Standard_${x}`]?.label ?? x }))), def: () => 'LRS', help: (v) => STORAGE_SKUS[`${v.perf ?? 'Standard'}_${v.redundancy ?? 'LRS'}`]?.copies ?? '' },
      { key: 'tier', label: 'Nivel de acceso', tab: 'Opciones avanzadas', type: 'select', section: 'Almacenamiento de blobs', options: () => [{ value: 'Hot', label: 'Frecuente (Hot): datos de acceso habitual' }, { value: 'Cool', label: 'Esporádico (Cool): acceso poco frecuente' }, { value: 'Cold', label: 'Frío (Cold)' }], def: () => 'Hot', show: (v) => v.perf !== 'Premium' },
      { key: 'anon', label: 'Permitir el acceso anónimo en contenedores individuales', tab: 'Opciones avanzadas', type: 'checkbox', section: 'Seguridad', def: () => false, help: 'Necesario para publicar blobs sin autenticación (p. ej. imágenes públicas).' },
      { key: 'sharedKey', label: 'Habilitar el acceso a la clave de la cuenta de almacenamiento', tab: 'Opciones avanzadas', type: 'checkbox', def: () => true },
      { key: 'tls', label: 'Versión mínima de TLS', tab: 'Opciones avanzadas', type: 'select', options: () => ['TLS1_2', 'TLS1_3'], def: () => 'TLS1_2' },
      tagsField,
    ],
    commands: (v) => [
      ...rgCmd(v),
      { title: 'Crear cuenta de almacenamiento', args: ['storage', 'account', 'create', '-n', v.name, '-g', rgName(v), '-l', v.location, '--sku', `${v.perf}_${v.redundancy}`, '--kind', v.perf === 'Premium' ? 'BlockBlobStorage' : 'StorageV2', ...(v.perf !== 'Premium' ? ['--access-tier', v.tier] : []), '--allow-blob-public-access', String(!!v.anon), '--allow-shared-key-access', String(!!v.sharedKey), '--min-tls-version', v.tls, ...tagArgs(v)] },
    ],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Storage/storageAccounts', v.name),
    cost: (v) => (STORAGE_SKUS[`${v.perf}_${v.redundancy}`]?.priceGB ?? 0.02) * 10,
  },
  vm: {
    id: 'vm',
    title: 'Crear una máquina virtual',
    icon: 'vm',
    type: 'Microsoft.Compute/virtualMachines',
    intro: 'Crea una máquina virtual con Linux o Windows. Elige una imagen de Azure Marketplace y configura el acceso (SSH o contraseña) y la red. Recuerda detenerla (desasignarla) cuando no la uses.',
    tabs: ['Aspectos básicos', 'Discos', 'Redes', 'Administración', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Compute/virtualMachines', { nameLabel: 'Nombre de la máquina virtual' }),
      { key: 'image', label: 'Imagen', tab: 'Aspectos básicos', type: 'select', options: () => VM_IMAGES.map((i) => ({ value: i.alias, label: i.displayName })), def: () => 'Ubuntu2404' },
      { key: 'size', label: 'Tamaño', tab: 'Aspectos básicos', type: 'select', options: () => VM_SIZES.map((x) => ({ value: x.name, label: `${x.name} - ${x.vCPUs} vcpu, ${x.memoryGB} GiB de memoria (${formatMoney(x.pricePerHour * 730)}/mes)` })), def: () => 'Standard_B1s' },
      { key: 'auth', label: 'Tipo de autenticación', tab: 'Aspectos básicos', type: 'select', section: 'Cuenta de administrador', options: (v) => (VM_IMAGES.find((i) => i.alias === v.image)?.os === 'Windows' ? [{ value: 'password', label: 'Contraseña' }] : [{ value: 'ssh', label: 'Clave pública SSH (recomendado)' }, { value: 'password', label: 'Contraseña' }]), def: () => 'ssh' },
      { key: 'user', label: 'Nombre de usuario', tab: 'Aspectos básicos', required: true, def: () => 'azureuser', validate: (val) => (['admin', 'administrator', 'root', 'guest', 'user', 'test'].includes(String(val).toLowerCase()) ? `"${val}" es un nombre reservado.` : null) },
      { key: 'password', label: 'Contraseña', tab: 'Aspectos básicos', type: 'password', required: true, show: (v) => v.auth === 'password' || VM_IMAGES.find((i) => i.alias === v.image)?.os === 'Windows', help: 'Mínimo 12 caracteres (Windows) o 6 (Linux) con mayúsculas, minúsculas, números y símbolos (3 de 4).' },
      { key: 'ports', label: 'Puertos de entrada públicos', tab: 'Aspectos básicos', type: 'select', section: 'Reglas de puerto de entrada', options: (v) => (VM_IMAGES.find((i) => i.alias === v.image)?.os === 'Windows' ? [{ value: 'none', label: 'Ninguno' }, { value: 'rdp', label: 'Permitir RDP (3389)' }, { value: 'rdp-http', label: 'Permitir RDP (3389) y HTTP (80)' }] : [{ value: 'none', label: 'Ninguno' }, { value: 'ssh', label: 'Permitir SSH (22)' }, { value: 'ssh-http', label: 'Permitir SSH (22) y HTTP (80)' }]), def: () => 'ssh', help: 'Abrir puertos a Internet es arriesgado: en producción restringe el origen o usa Azure Bastion.' },
      { key: 'disk', label: 'Tipo de disco del SO', tab: 'Discos', type: 'select', options: () => [{ value: 'Premium_LRS', label: 'SSD Premium' }, { value: 'StandardSSD_LRS', label: 'SSD estándar' }, { value: 'Standard_LRS', label: 'HDD estándar' }], def: () => 'StandardSSD_LRS' },
      { key: 'vnet', label: 'Red virtual', tab: 'Redes', type: 'select', section: 'Interfaz de red', options: (v, s) => [{ value: '', label: `(nueva) ${v.name || 'vm'}VNET` }, ...s.resources.filter((r) => r.type === 'Microsoft.Network/virtualNetworks' && r.subscriptionId === v.sub && r.resourceGroup.toLowerCase() === String(rgName(v) ?? '').toLowerCase() && r.location === v.location).map((r) => r.name)], def: () => '', help: 'La VM se conecta a una subred. Con "(nueva)" se crea una red 10.0.0.0/16.' },
      { key: 'pip', label: 'IP pública', tab: 'Redes', type: 'checkbox', def: () => true, help: 'Sin IP pública sólo se puede acceder desde la red virtual.' },
      { key: 'identity', label: 'Habilitar la identidad administrada asignada por el sistema', tab: 'Administración', type: 'checkbox', def: () => false },
      { key: 'customData', label: 'Datos personalizados (cloud-init)', tab: 'Administración', type: 'textarea', help: 'Script que se ejecuta en el primer arranque, p. ej. #!/bin/bash\\napt-get install -y nginx' },
      tagsField,
    ],
    commands: (v) => {
      const os = VM_IMAGES.find((i) => i.alias === v.image)?.os;
      const args = ['vm', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--image', v.image, '--size', v.size, '--admin-username', v.user, '--storage-sku', v.disk];
      if (os === 'Windows' || v.auth === 'password') args.push('--admin-password', v.password ?? '', ...(os !== 'Windows' ? ['--authentication-type', 'password'] : []));
      else args.push('--generate-ssh-keys');
      if (v.vnet) args.push('--vnet-name', v.vnet);
      if (!v.pip) args.push('--public-ip-address', '');
      args.push('--nsg-rule', v.ports === 'none' ? 'NONE' : os === 'Windows' ? 'RDP' : 'SSH');
      if (v.identity) args.push('--assign-identity');
      if (v.customData) args.push('--custom-data', String(v.customData).replace(/\\n/g, '\n'));
      args.push(...tagArgs(v));
      const out: Cmd[] = [...rgCmd(v), { title: 'Crear máquina virtual', args }];
      if (String(v.ports).endsWith('http')) out.push({ title: 'Abrir el puerto 80', args: ['vm', 'open-port', '-g', rgName(v), '-n', v.name, '--port', '80', '--priority', '1010'] });
      return out;
    },
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Compute/virtualMachines', v.name),
    cost: (v) => (VM_SIZES.find((x) => x.name === v.size)?.pricePerHour ?? 0) * 730 + 5,
  },
  webapp: {
    id: 'webapp',
    title: 'Crear aplicación web',
    icon: 'webapp',
    type: 'Microsoft.Web/sites',
    intro: 'App Service hospeda aplicaciones web, API REST y back-ends sin administrar servidores: Azure se encarga del sistema operativo, los parches y el balanceo. Tú despliegas el código.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Web/sites', { nameLabel: 'Nombre', nameHelp: 'Será tu dominio: <nombre>.azurewebsites.net (único en todo Azure).' }),
      { key: 'runtime', label: 'Pila del entorno en tiempo de ejecución', tab: 'Aspectos básicos', type: 'select', options: () => WEB_RUNTIMES.filter((x) => x.os === 'linux').map((x) => ({ value: x.id, label: x.label })), def: () => 'NODE:20-lts' },
      { key: 'plan', label: 'Plan de Linux', tab: 'Aspectos básicos', type: 'select', section: 'Plan de tarifa', options: (v, s) => [{ value: '', label: `(Nuevo) ASP-${v.name || 'app'}` }, ...s.resources.filter((r) => r.type.toLowerCase() === 'microsoft.web/serverfarms' && r.subscriptionId === v.sub && r.properties.reserved && r.location === v.location).map((r) => ({ value: r.id, label: `${r.name} (${r.sku?.name})` }))], def: () => '' },
      { key: 'sku', label: 'Plan de precios', tab: 'Aspectos básicos', type: 'select', show: (v) => !v.plan, options: () => APP_SERVICE_SKUS.filter((x) => x.name !== 'Y1' && x.name !== 'EP1').map((x) => ({ value: x.name, label: `${x.name} · ${x.description} (${formatMoney(x.pricePerHour * 730)}/mes)` })), def: () => 'B1', help: 'F1 es gratuito pero limitado; S1 o superior permite ranuras de implementación y escalado automático.' },
      { key: 'identity', label: 'Habilitar identidad administrada asignada por el sistema', tab: 'Aspectos básicos', type: 'checkbox', def: () => false },
      tagsField,
    ],
    commands: (v) => {
      const planName = v.plan ? String(v.plan).split('/').pop()! : `ASP-${v.name}`;
      const out: Cmd[] = [...rgCmd(v)];
      if (!v.plan) out.push({ title: 'Crear plan de App Service', args: ['appservice', 'plan', 'create', '-g', rgName(v), '-n', planName, '-l', v.location, '--sku', v.sku, '--is-linux'] });
      out.push({ title: 'Crear aplicación web', args: ['webapp', 'create', '-g', rgName(v), '-n', v.name, '-p', v.plan || planName, '--runtime', v.runtime, ...(v.identity ? ['--assign-identity'] : []), ...tagArgs(v)] });
      return out;
    },
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Web/sites', v.name),
    cost: (v) => (v.plan ? 0 : (APP_SERVICE_SKUS.find((x) => x.name === v.sku)?.pricePerHour ?? 0) * 730),
  },
  plan: {
    id: 'plan',
    title: 'Crear un plan de App Service',
    icon: 'plan',
    type: 'Microsoft.Web/serverfarms',
    intro: 'Un plan de App Service define los recursos de proceso (región, tamaño, número de instancias) en los que se ejecutan tus aplicaciones web. Varias apps pueden compartir un plan.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Web/serverfarms'),
      { key: 'os', label: 'Sistema operativo', tab: 'Aspectos básicos', type: 'select', options: () => ['Linux', 'Windows'], def: () => 'Linux' },
      { key: 'sku', label: 'Plan de precios', tab: 'Aspectos básicos', type: 'select', options: () => APP_SERVICE_SKUS.filter((x) => x.name !== 'Y1' && x.name !== 'EP1').map((x) => ({ value: x.name, label: `${x.name} · ${x.description}` })), def: () => 'B1' },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear plan', args: ['appservice', 'plan', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--sku', v.sku, ...(v.os === 'Linux' ? ['--is-linux'] : []), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Web/serverfarms', v.name),
    cost: (v) => (APP_SERVICE_SKUS.find((x) => x.name === v.sku)?.pricePerHour ?? 0) * 730,
  },
  sql: {
    id: 'sql',
    title: 'Crear base de datos SQL',
    icon: 'sqldb',
    type: 'Microsoft.Sql/servers/databases',
    intro: 'Azure SQL Database es un motor de base de datos relacional totalmente administrado (PaaS). Necesita un servidor lógico que agrupa las bases de datos y controla el acceso (inicios de sesión y firewall).',
    tabs: ['Aspectos básicos', 'Redes', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Sql/servers/databases', { nameLabel: 'Nombre de la base de datos', locationless: true }).map((f) => (f.key === 'name' ? { ...f, validate: (val: any) => (!val ? 'El valor no puede estar vacío.' : /[<>*%&:\\/?]/.test(val) ? 'Nombre no válido.' : null) } : f)),
      { key: 'server', label: 'Servidor', tab: 'Aspectos básicos', type: 'select', options: (v, s) => [{ value: '', label: '(Crear nuevo)' }, ...s.resources.filter((r) => r.type === 'Microsoft.Sql/servers' && r.subscriptionId === v.sub).map((r) => ({ value: r.id, label: `${r.name} (${r.location})` }))], def: (_s, q) => q.get('server') ?? '' },
      { key: 'serverName', label: 'Nombre del servidor', tab: 'Aspectos básicos', section: 'Nuevo servidor', show: (v) => !v.server, required: true, help: '<nombre>.database.windows.net (único en todo Azure).', validate: (val, _v, s) => validateName('Microsoft.Sql/servers', val, s) },
      { key: 'location', label: 'Ubicación', tab: 'Aspectos básicos', type: 'select', show: (v) => !v.server, options: () => LOCATIONS.map((l) => ({ value: l.name, label: `(${l.geo}) ${l.displayName}` })), def: () => 'westeurope' },
      { key: 'admin', label: 'Inicio de sesión del administrador', tab: 'Aspectos básicos', show: (v) => !v.server, required: true, def: () => 'sqladmin', validate: (val) => (['admin', 'administrator', 'sa', 'root', 'dbmanager'].includes(String(val).toLowerCase()) ? 'Ese nombre está reservado.' : null) },
      { key: 'password', label: 'Contraseña', tab: 'Aspectos básicos', type: 'password', show: (v) => !v.server, required: true, help: '8-128 caracteres, 3 de: mayúsculas, minúsculas, números y símbolos.' },
      { key: 'objective', label: 'Proceso y almacenamiento', tab: 'Aspectos básicos', type: 'select', section: 'Base de datos', options: () => Object.entries(SQL_OBJECTIVES).map(([k, x]) => ({ value: k, label: `${x.label} (${formatMoney(x.monthly)}/mes)` })), def: () => 'Basic' },
      { key: 'allowAzure', label: 'Permitir que los servicios y recursos de Azure accedan a este servidor', tab: 'Redes', type: 'checkbox', section: 'Reglas de firewall', def: () => false, show: (v) => !v.server },
      { key: 'allowShell', label: 'Agregar la IP de Cloud Shell (20.31.118.42) a las reglas de firewall', tab: 'Redes', type: 'checkbox', def: () => true, show: (v) => !v.server },
      tagsField,
    ],
    commands: (v, s) => {
      const server = v.server ? s.resources.find((r) => r.id === v.server) : null;
      const srvName = server?.name ?? v.serverName;
      const srvRg = server?.resourceGroup ?? rgName(v);
      const out: Cmd[] = [...rgCmd(v)];
      if (!server) {
        out.push({ title: 'Crear servidor SQL', args: ['sql', 'server', 'create', '-g', srvRg, '-n', srvName, '-l', v.location, '-u', v.admin, '-p', v.password ?? ''] });
        if (v.allowAzure) out.push({ title: 'Permitir servicios de Azure', args: ['sql', 'server', 'firewall-rule', 'create', '-g', srvRg, '-s', srvName, '-n', 'AllowAllWindowsAzureIps', '--start-ip-address', '0.0.0.0', '--end-ip-address', '0.0.0.0'] });
        if (v.allowShell) out.push({ title: 'Permitir Cloud Shell', args: ['sql', 'server', 'firewall-rule', 'create', '-g', srvRg, '-s', srvName, '-n', 'CloudShell', '--start-ip-address', '20.31.118.42', '--end-ip-address', '20.31.118.42'] });
      }
      out.push({ title: 'Crear base de datos', args: ['sql', 'db', 'create', '-g', srvRg, '-s', srvName, '-n', v.name, '--service-objective', v.objective, ...tagArgs(v)] });
      return out;
    },
    target: (v, s) => {
      const server = v.server ? s.resources.find((r) => r.id === v.server) : null;
      return `${server?.id ?? resourceId(v.sub, rgName(v), 'Microsoft.Sql/servers', v.serverName)}/databases/${v.name}`;
    },
    cost: (v) => SQL_OBJECTIVES[v.objective]?.monthly ?? 0,
  },
  keyvault: {
    id: 'keyvault',
    title: 'Crear un almacén de claves',
    icon: 'keyvault',
    type: 'Microsoft.KeyVault/vaults',
    intro: 'Azure Key Vault protege secretos (contraseñas, cadenas de conexión), claves de cifrado y certificados. Las aplicaciones los leen con su identidad administrada, sin tenerlos en el código.',
    tabs: ['Aspectos básicos', 'Configuración de acceso', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.KeyVault/vaults', { nameLabel: 'Nombre del almacén de claves', nameHelp: '3-24 caracteres: letras, números y guiones. Único en todo Azure.' }),
      { key: 'sku', label: 'Plan de tarifa', tab: 'Aspectos básicos', type: 'select', options: () => [{ value: 'standard', label: 'Estándar' }, { value: 'premium', label: 'Premium (claves protegidas por HSM)' }], def: () => 'standard' },
      { key: 'purge', label: 'Habilitar la protección de purga', tab: 'Aspectos básicos', type: 'checkbox', def: () => false, help: 'Impide borrar definitivamente el almacén o sus secretos durante el periodo de retención (no se puede desactivar después).' },
      { key: 'rbac', label: 'Modelo de permisos', tab: 'Configuración de acceso', type: 'select', options: () => [{ value: 'rbac', label: 'Control de acceso basado en roles de Azure (recomendado)' }, { value: 'policy', label: 'Directiva de acceso del almacén' }], def: () => 'rbac', help: 'Con RBAC necesitarás asignarte "Key Vault Secrets Officer" para crear secretos (ser Owner no basta).' },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear almacén de claves', args: ['keyvault', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--sku', v.sku, '--enable-rbac-authorization', String(v.rbac === 'rbac'), ...(v.purge ? ['--enable-purge-protection', 'true'] : []), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.KeyVault/vaults', v.name),
    cost: () => 0.5,
  },
  vnet: {
    id: 'vnet',
    title: 'Crear red virtual',
    icon: 'vnet',
    type: 'Microsoft.Network/virtualNetworks',
    intro: 'Una red virtual (VNet) es tu red privada en Azure: permite que los recursos (VM, AKS...) se comuniquen entre sí, con Internet y con tu red local. Se divide en subredes.',
    tabs: ['Aspectos básicos', 'Direcciones IP', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Network/virtualNetworks', { nameLabel: 'Nombre de la red virtual' }),
      { key: 'space', label: 'Espacio de direcciones IPv4', tab: 'Direcciones IP', def: () => '10.0.0.0/16', required: true, validate: (val) => (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(val ?? '') ? null : 'Usa notación CIDR, p. ej. 10.0.0.0/16') },
      { key: 'subnet', label: 'Nombre de la subred', tab: 'Direcciones IP', def: () => 'default', required: true },
      { key: 'subnetPrefix', label: 'Intervalo de la subred', tab: 'Direcciones IP', def: () => '10.0.0.0/24', required: true, validate: (val) => (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(val ?? '') ? null : 'Usa notación CIDR, p. ej. 10.0.0.0/24') },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear red virtual', args: ['network', 'vnet', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--address-prefixes', v.space, '--subnet-name', v.subnet, '--subnet-prefixes', v.subnetPrefix, ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Network/virtualNetworks', v.name),
    cost: () => 0,
  },
  nsg: {
    id: 'nsg',
    title: 'Crear grupo de seguridad de red',
    icon: 'nsg',
    type: 'Microsoft.Network/networkSecurityGroups',
    intro: 'Un grupo de seguridad de red (NSG) contiene reglas que permiten o deniegan el tráfico hacia y desde los recursos de una red virtual. Se asocia a subredes o interfaces de red.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [...baseFields('Microsoft.Network/networkSecurityGroups'), tagsField],
    commands: (v) => [...rgCmd(v), { title: 'Crear NSG', args: ['network', 'nsg', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Network/networkSecurityGroups', v.name),
    cost: () => 0,
  },
  pip: {
    id: 'pip',
    title: 'Crear dirección IP pública',
    icon: 'pip',
    type: 'Microsoft.Network/publicIPAddresses',
    intro: 'Una dirección IP pública permite que Internet se comunique con recursos de Azure (VM, equilibradores de carga...).',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [...baseFields('Microsoft.Network/publicIPAddresses'), { key: 'sku', label: 'SKU', tab: 'Aspectos básicos', type: 'select', options: () => ['Standard', 'Basic'], def: () => 'Standard' }, { key: 'dns', label: 'Etiqueta de nombre DNS (opcional)', tab: 'Aspectos básicos', help: '<etiqueta>.<región>.cloudapp.azure.com' }, tagsField],
    commands: (v) => [...rgCmd(v), { title: 'Crear IP pública', args: ['network', 'public-ip', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--sku', v.sku, ...(v.dns ? ['--dns-name', v.dns] : []), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Network/publicIPAddresses', v.name),
    cost: () => 3.65,
  },
  acr: {
    id: 'acr',
    title: 'Crear registro de contenedor',
    icon: 'acr',
    type: 'Microsoft.ContainerRegistry/registries',
    intro: 'Azure Container Registry guarda tus imágenes de contenedor privadas para desplegarlas en AKS, App Service o Container Instances.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [...baseFields('Microsoft.ContainerRegistry/registries', { nameLabel: 'Nombre del registro', nameHelp: '5-50 caracteres alfanuméricos. Será <nombre>.azurecr.io' }), { key: 'sku', label: 'Plan de precios', tab: 'Aspectos básicos', type: 'select', options: () => Object.entries(ACR_SKUS).map(([k, x]) => ({ value: k, label: `${k} · ${x.label} (${formatMoney(x.monthly)}/mes)` })), def: () => 'Basic' }, tagsField],
    commands: (v) => [...rgCmd(v), { title: 'Crear registro', args: ['acr', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--sku', v.sku, ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.ContainerRegistry/registries', v.name),
    cost: (v) => ACR_SKUS[v.sku]?.monthly ?? 5,
  },
  aks: {
    id: 'aks',
    title: 'Crear clúster de Kubernetes',
    icon: 'aks',
    type: 'Microsoft.ContainerService/managedClusters',
    intro: 'Azure Kubernetes Service (AKS) administra el plano de control de Kubernetes por ti: sólo pagas los nodos (VM) donde se ejecutan tus contenedores.',
    tabs: ['Aspectos básicos', 'Grupos de nodos', 'Integraciones', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.ContainerService/managedClusters', { nameLabel: 'Nombre del clúster de Kubernetes' }),
      { key: 'version', label: 'Versión de Kubernetes', tab: 'Aspectos básicos', type: 'select', options: () => K8S_VERSIONS.map((x) => ({ value: x, label: x + (x === '1.32.6' ? ' (predeterminada)' : '') })), def: () => '1.32.6' },
      { key: 'size', label: 'Tamaño del nodo', tab: 'Grupos de nodos', type: 'select', options: () => VM_SIZES.filter((x) => x.vCPUs >= 2).map((x) => ({ value: x.name, label: `${x.name} (${x.vCPUs} vCPU, ${x.memoryGB} GiB)` })), def: () => 'Standard_B2s' },
      { key: 'count', label: 'Número de nodos', tab: 'Grupos de nodos', type: 'select', options: () => ['1', '2', '3', '5'], def: () => '2' },
      { key: 'acr', label: 'Registro de contenedor', tab: 'Integraciones', type: 'select', options: (v, s) => [{ value: '', label: 'Ninguno' }, ...s.resources.filter((r) => r.type === 'Microsoft.ContainerRegistry/registries' && r.subscriptionId === v.sub).map((r) => r.name)], def: () => '', help: 'Concede al clúster el rol AcrPull sobre el registro (equivale a --attach-acr).' },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear clúster de AKS', args: ['aks', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '-k', v.version, '--node-count', v.count, '--node-vm-size', v.size, '--generate-ssh-keys', ...(v.acr ? ['--attach-acr', v.acr] : []), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.ContainerService/managedClusters', v.name),
    cost: (v) => (VM_SIZES.find((x) => x.name === v.size)?.pricePerHour ?? 0.04) * 730 * Number(v.count ?? 1),
  },
  aci: {
    id: 'aci',
    title: 'Crear instancia de contenedor',
    icon: 'aci',
    type: 'Microsoft.ContainerInstance/containerGroups',
    intro: 'Azure Container Instances ejecuta un contenedor en segundos sin administrar máquinas virtuales ni orquestadores. Ideal para tareas sencillas y pruebas.',
    tabs: ['Aspectos básicos', 'Redes', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.ContainerInstance/containerGroups', { nameLabel: 'Nombre del contenedor' }),
      { key: 'image', label: 'Imagen', tab: 'Aspectos básicos', def: () => 'mcr.microsoft.com/azuredocs/aci-helloworld', required: true, help: 'Imagen pública (nginx, mcr.microsoft.com/azuredocs/aci-helloworld) o de tu ACR (<registro>.azurecr.io/app:v1).' },
      { key: 'cpu', label: 'Núcleos de CPU', tab: 'Aspectos básicos', type: 'select', options: () => ['1', '2'], def: () => '1' },
      { key: 'memory', label: 'Memoria (GiB)', tab: 'Aspectos básicos', type: 'select', options: () => ['1', '1.5', '2'], def: () => '1.5' },
      { key: 'dns', label: 'Etiqueta de nombre DNS', tab: 'Redes', help: '<etiqueta>.<región>.azurecontainer.io' },
      { key: 'port', label: 'Puerto', tab: 'Redes', def: () => '80' },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear instancia de contenedor', args: ['container', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--image', v.image, '--cpu', v.cpu, '--memory', v.memory, '--ports', v.port, '--ip-address', 'Public', ...(v.dns ? ['--dns-name-label', v.dns] : []), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.ContainerInstance/containerGroups', v.name),
    cost: (v) => 30 * Number(v.cpu ?? 1),
  },
  law: {
    id: 'law',
    title: 'Crear área de trabajo de Log Analytics',
    icon: 'loganalytics',
    type: 'Microsoft.OperationalInsights/workspaces',
    intro: 'Un área de trabajo de Log Analytics centraliza los registros de tus recursos para consultarlos con KQL, crear alertas y paneles.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [...baseFields('Microsoft.OperationalInsights/workspaces'), tagsField],
    commands: (v) => [...rgCmd(v), { title: 'Crear área de trabajo', args: ['monitor', 'log-analytics', 'workspace', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.OperationalInsights/workspaces', v.name),
    cost: () => 2.3,
  },
  appinsights: {
    id: 'appinsights',
    title: 'Crear Application Insights',
    icon: 'appinsights',
    type: 'Microsoft.Insights/components',
    intro: 'Application Insights supervisa el rendimiento y la disponibilidad de tus aplicaciones (peticiones, errores, dependencias).',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [...baseFields('Microsoft.Insights/components'), { key: 'ws', label: 'Área de trabajo de Log Analytics', tab: 'Aspectos básicos', type: 'select', options: (v, s) => [{ value: '', label: 'Ninguna' }, ...s.resources.filter((r) => r.type === 'Microsoft.OperationalInsights/workspaces' && r.subscriptionId === v.sub).map((r) => ({ value: r.id, label: r.name }))], def: () => '' }, tagsField],
    commands: (v) => [...rgCmd(v), { title: 'Crear Application Insights', args: ['monitor', 'app-insights', 'component', 'create', '--app', v.name, '-g', rgName(v), '-l', v.location, ...(v.ws ? ['--workspace', v.ws] : []), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Insights/components', v.name),
    cost: () => 0,
  },
  identity: {
    id: 'identity',
    title: 'Crear identidad administrada asignada por el usuario',
    icon: 'identity',
    type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
    intro: 'Una identidad asignada por el usuario es un recurso independiente que puedes asignar a varios recursos (VM, apps, AKS...) para que accedan a otros servicios de Azure sin credenciales.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [...baseFields('Microsoft.ManagedIdentity/userAssignedIdentities'), tagsField],
    commands: (v) => [...rgCmd(v), { title: 'Crear identidad', args: ['identity', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.ManagedIdentity/userAssignedIdentities', v.name),
    cost: () => 0,
  },
  dns: {
    id: 'dns',
    title: 'Crear una zona DNS',
    icon: 'dns',
    type: 'Microsoft.Network/dnsZones',
    intro: 'Una zona DNS hospeda los registros de un dominio (por ejemplo contoso.com). Después de crearla, delega el dominio en tu registrador apuntando a los servidores de nombres de Azure DNS.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.Network/dnsZones', { nameLabel: 'Nombre', nameHelp: 'El nombre completo del dominio, p. ej. contoso-lab.com. Las zonas DNS son recursos globales.', locationless: true }),
      { key: 'location', label: 'Ubicación del grupo de recursos', tab: 'Aspectos básicos', type: 'select', options: () => LOCATIONS.map((l) => ({ value: l.name, label: `(${l.geo}) ${l.displayName}` })), def: () => 'westeurope', show: (v) => v.rg === '__new__' },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear zona DNS', args: ['network', 'dns', 'zone', 'create', '-g', rgName(v), '-n', String(v.name ?? '').toLowerCase(), ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.Network/dnsZones', String(v.name ?? '').toLowerCase()),
    cost: () => 0.5,
  },
  servicebus: {
    id: 'servicebus',
    title: 'Crear un espacio de nombres de Service Bus',
    icon: 'servicebus',
    type: 'Microsoft.ServiceBus/namespaces',
    intro: 'Service Bus es un agente de mensajes empresarial con colas (punto a punto) y temas (publicación/suscripción). Desacopla las aplicaciones: el productor envía mensajes aunque el consumidor esté caído o saturado.',
    tabs: ['Aspectos básicos', 'Etiquetas'],
    fields: [
      ...baseFields('Microsoft.ServiceBus/namespaces', { nameLabel: 'Nombre del espacio de nombres', nameHelp: '6-50 caracteres. Será <nombre>.servicebus.windows.net, así que debe ser único en todo Azure.' }),
      { key: 'sku', label: 'Plan de tarifa', tab: 'Aspectos básicos', type: 'select', options: () => Object.entries(SB_SKUS).map(([k, x]) => ({ value: k, label: `${k}: ${x.label}` })), def: () => 'Standard', help: (v) => (v.sku === 'Basic' ? 'El nivel Básico no admite temas ni suscripciones.' : v.sku === 'Premium' ? 'Recursos dedicados y aislamiento de red: caro para un laboratorio.' : 'Admite colas y temas: el recomendado para aprender.') },
      tagsField,
    ],
    commands: (v) => [...rgCmd(v), { title: 'Crear espacio de nombres', args: ['servicebus', 'namespace', 'create', '-g', rgName(v), '-n', v.name, '-l', v.location, '--sku', v.sku, ...tagArgs(v)] }],
    target: (v) => resourceId(v.sub, rgName(v), 'Microsoft.ServiceBus/namespaces', v.name),
    cost: (v) => SB_SKUS[v.sku]?.monthly ?? 10,
  },
};

export function wizardExists(id: string) {
  return !!WIZARDS[id];
}

// ---------------------------------------------------------------- componente

function initialValues(def: WizardDef, s: CloudState, q: URLSearchParams): V {
  const v: V = {};
  for (const f of def.fields) v[f.key] = f.def ? f.def(s, q) : f.type === 'checkbox' ? false : '';
  return v;
}

export function CreateWizard({ id }: { id: string }) {
  const s = useCloud();
  const route = useRoute();
  const def = WIZARDS[id];
  const [v, setV] = useState<V>(() => (def ? initialValues(def, s, route.query) : {}));
  const [tab, setTab] = useState(def?.tabs[0] ?? '');
  const [touched, setTouched] = useState(false);
  const [running, setRunning] = useState<{ step: number; error?: string; tip?: string; done?: boolean } | null>(null);
  const cmds = useMemo(() => (def ? def.commands(v, s) : []), [v, def]);
  if (!def) {
    return (
      <div className="page">
        <Callout kind="bad">No existe el asistente "{id}".</Callout>
      </div>
    );
  }
  const visible = def.fields.filter((f) => !f.show || f.show(v));
  const errors: Record<string, string> = {};
  for (const f of visible) {
    const val = v[f.key];
    if (f.required && (val === '' || val === undefined || val === null)) errors[f.key] = 'El valor no puede estar vacío.';
    else if (f.validate) {
      const e = f.validate(val, v, s);
      if (e) errors[f.key] = e;
    }
  }
  const tabErrors = (t: string) => visible.some((f) => f.tab === t && errors[f.key]);
  const allTabs = [...def.tabs, 'Revisar y crear'];
  const set = (k: string, val: any) => setV({ ...v, [k]: val });
  const create = async () => {
    setTouched(true);
    if (Object.keys(errors).length) {
      setTab(def.tabs.find((t) => tabErrors(t)) ?? def.tabs[0]);
      return;
    }
    const depName = `Microsoft.${def.id}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const nid = guid();
    notify({ id: nid, title: 'Implementación en curso...', message: `Implementación "${depName}" en curso.`, level: 'progress' });
    setRunning({ step: 0 });
    for (let i = 0; i < cmds.length; i++) {
      setRunning({ step: i });
      const r = await az(cmds[i].args, { subscription: v.sub });
      if (r.code !== 0) {
        const msg = errorText(r);
        notify({ id: nid, title: 'Error en la implementación', message: `${cmds[i].title}: ${msg}`, level: 'error' });
        setRunning({ step: i, error: msg, tip: tipText(r) });
        return;
      }
    }
    const target = def.target(v, getState());
    notify({ id: nid, title: 'Se completó la implementación', message: `La implementación "${depName}" se ha completado correctamente.`, level: 'success', link: resourceHref(target) });
    toast('Se completó la implementación', 'success', def.title.replace(/^Crear (un |una )?/, ''));
    setRunning({ step: cmds.length, done: true });
  };
  if (running) {
    const target = def.target(v, getState());
    return (
      <div className="page narrow">
        <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: def.title }]} />
        <div className="page-head">
          <ServiceIcon name={def.icon} size={36} />
          <div>
            <h1>{running.done ? 'Se completó la implementación' : running.error ? 'Error en la implementación' : 'La implementación está en curso'}</h1>
            <div className="subtitle">{def.title}</div>
          </div>
        </div>
        {running.error ? (
          <Callout kind="bad" title="La implementación ha fallado">
            <div style={{ whiteSpace: 'pre-wrap' }}>{running.error}</div>
            {running.tip ? <div style={{ marginTop: 6 }}>💡 {running.tip}</div> : null}
          </Callout>
        ) : null}
        <div className="card">
          {cmds.map((c, i) => (
            <div key={i} className="row" style={{ padding: '6px 0' }}>
              {i < running.step || running.done ? <span className="status-icon succeeded">✓</span> : i === running.step && running.error ? <span className="status-icon failed">!</span> : i === running.step ? <Spinner /> : <span className="status-icon notStarted" />}
              <span>{c.title}</span>
              <span className="muted mono small" style={{ marginLeft: 'auto', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cliText(c.args)}
              </span>
            </div>
          ))}
        </div>
        <div className="btn-row" style={{ marginTop: 16 }}>
          {running.done ? (
            <button className="btn primary" onClick={() => navigate(resourceHref(target).slice(1))}>
              Ir al recurso
            </button>
          ) : null}
          {running.error ? (
            <button className="btn primary" onClick={() => setRunning(null)}>
              Volver al asistente
            </button>
          ) : null}
          {running.done && id !== 'rg' ? (
            <button className="btn" onClick={() => navigate(rgHref(v.sub, rgName(v)).slice(1))}>
              Ir al grupo de recursos
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  const cost = def.cost?.(v);
  return (
    <div className="page narrow" style={{ paddingBottom: 0 }}>
      <Crumbs items={[{ label: 'Inicio', href: '#/' }, { label: 'Todos los servicios', href: '#/services' }, { label: def.title }]} />
      <div className="page-head">
        <ServiceIcon name={def.icon} size={36} />
        <h1>{def.title}</h1>
      </div>
      <div className="wizard-tabs">
        {allTabs.map((t) => (
          <button key={t} className={`${tab === t ? 'active' : ''}${touched && tabErrors(t) ? ' has-error' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === def.tabs[0] ? <p style={{ maxWidth: 820 }}>{def.intro}</p> : null}
      {tab !== 'Revisar y crear' ? (
        <div style={{ minHeight: 300 }}>
          {visible
            .filter((f) => f.tab === tab)
            .map((f) => {
              const err = touched || v[f.key] ? errors[f.key] : undefined;
              const help = typeof f.help === 'function' ? f.help(v) : f.help;
              return (
                <div key={f.key}>
                  {f.section ? <div className="section-title">{f.section}</div> : null}
                  {f.type === 'checkbox' ? (
                    <Field label="" help={help}>
                      <Checkbox checked={!!v[f.key]} onChange={(x) => set(f.key, x)} label={f.label} />
                    </Field>
                  ) : (
                    <Field label={f.label} required={f.required} help={help} error={err}>
                      {f.type === 'select' ? (
                        <Select value={String(v[f.key] ?? '')} onChange={(x) => set(f.key, x)} options={f.options?.(v, s) ?? []} />
                      ) : f.type === 'textarea' ? (
                        <textarea className="textarea" rows={3} value={v[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                      ) : (
                        <TextInput value={v[f.key] ?? ''} onChange={(x) => set(f.key, x)} type={f.type === 'password' ? 'password' : 'text'} invalid={!!err} />
                      )}
                    </Field>
                  )}
                </div>
              );
            })}
        </div>
      ) : (
        <div>
          {Object.keys(errors).length ? (
            <Callout kind="bad" title="Error de validación">
              Corrige los campos marcados en las pestañas: {def.tabs.filter((t) => tabErrors(t)).join(', ')}.
            </Callout>
          ) : (
            <Callout kind="ok">Validación superada.</Callout>
          )}
          {cost !== null && cost !== undefined ? (
            <div className="review-group">
              <h4>Coste estimado</h4>
              <div>{formatMoney(cost)} al mes (aproximado). En el simulador, 1 minuto real equivale a 1 hora de facturación.</div>
            </div>
          ) : null}
          {def.tabs.map((t) => (
            <div key={t} className="review-group">
              <h4>{t}</h4>
              {visible
                .filter((f) => f.tab === t && f.type !== 'password')
                .map((f) => {
                  const val = v[f.key];
                  const opt = f.type === 'select' ? (f.options?.(v, s) ?? []).find((o) => (typeof o === 'string' ? o : o.value) === String(val)) : null;
                  const label = opt ? (typeof opt === 'string' ? opt : opt.label) : f.type === 'checkbox' ? (val ? 'Sí' : 'No') : String(val ?? '') || '—';
                  return (
                    <div key={f.key} className="ess-row">
                      <span className="k">{f.label}</span>
                      <span className="v">{label}</span>
                    </div>
                  );
                })}
            </div>
          ))}
          <div className="review-group">
            <h4>Comandos equivalentes de Azure CLI</h4>
            <p className="muted small">Esto es exactamente lo que hará el portal. Puedes copiarlo y ejecutarlo en Cloud Shell para practicar la automatización.</p>
            {cmds.map((c, i) => {
              const text = cliText(c.args.map((a, j) => (c.args[j - 1] === '--admin-password' || (c.args[j - 1] === '-p' && c.args[0] === 'sql') ? '<contraseña>' : a)));
              return (
                <div key={i} style={{ marginBottom: 8 }}>
                  <CliBox cmd={text} onRun={() => terminal.typeCommand(text)} />
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="wizard-foot">
        {tab === 'Revisar y crear' ? (
          <button className="btn primary" onClick={create} disabled={!!Object.keys(errors).length}>
            Crear
          </button>
        ) : (
          <button className="btn primary" onClick={() => setTab('Revisar y crear')}>
            Revisar y crear
          </button>
        )}
        <button className="btn" disabled={allTabs.indexOf(tab) === 0} onClick={() => setTab(allTabs[allTabs.indexOf(tab) - 1])}>
          &lt; Anterior
        </button>
        <button className="btn" disabled={tab === 'Revisar y crear'} onClick={() => setTab(allTabs[allTabs.indexOf(tab) + 1])}>
          Siguiente: {allTabs[allTabs.indexOf(tab) + 1] ?? ''} &gt;
        </button>
      </div>
    </div>
  );
}
