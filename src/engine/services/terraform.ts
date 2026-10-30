// Terraform simulado con el proveedor azurerm (y random): init, plan, apply, destroy, state, import y outputs.
import type { PrincipalRef, Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { authorize, createResourceGroup, deleteResource, deleteResourceGroup, findResource, findRg, listResources, putResource, resourceToArm, updateResourceGroupTags } from '../arm';
import { getProvider } from '../registry';
import { resourceId as buildId } from '../ids';
import { ciEq, guid, seededRandom, fnv1a } from '../util';
import { parseHcl, evalHcl, isUnknown, UNKNOWN, bodyRefs, collectRefs, applySteps, HclError, type HBlock, type HBody, type EvalScope } from './hcl';
import { createRoleAssignment, deleteRoleAssignments, findRoleDefinition, findSp, principalRefForSp } from './identity';
import { containersOf, findAccount, uploadBlob, downloadBlob } from './storage';
import { upsertSubnet, deleteSubnet, upsertNsgRule, deleteNsgRule, setNicNsg } from './networkOps';
import { setSecret, deleteSecret, getVault } from './keyvault';
import { createLock, deleteLock } from './governance';
import { vmNetworkInfo } from '../providers/compute';
import { kubeconfigFor } from './kubeconfig';

export interface TfFiles {
  list(): string[];
  read(name: string): string | undefined;
  write(name: string, content: string): void;
  mkdir(name: string): void;
  exists(name: string): boolean;
  remove(name: string): void;
}

export interface TfIO {
  out(s: string): void;
  err(s: string): void;
  prompt?(q: string): Promise<string>;
  files: TfFiles;
  env: Record<string, string>;
  cliPrincipal: PrincipalRef | null;
  cliSubscription: string | null;
  color: boolean;
}

class TfError extends Error {
  constructor(public summary: string, public detail = '', public where?: { addr?: string; file?: string; line?: number; src?: string }) {
    super(summary);
  }
}

const TF_VERSION = '1.9.8';
const PROVIDER_VERSIONS: Record<string, string> = { azurerm: '4.8.0', random: '3.6.3', azuread: '3.0.2' };

// ---------------------------------------------------------------- configuración

interface Config {
  terraformBlocks: HBlock[];
  providers: HBlock[];
  variables: Map<string, HBlock>;
  locals: Map<string, { expr: any; line: number; file: string }>;
  resources: Map<string, HBlock>;
  data: Map<string, HBlock>;
  outputs: Map<string, HBlock>;
  sources: Record<string, string>;
}

function loadConfig(io: TfIO): Config {
  const files = io.files.list().filter((f) => f.endsWith('.tf')).sort();
  if (!files.length) throw new TfError('No configuration files', 'Apply requires configuration to be present. Applying without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run \'terraform destroy\' instead.');
  const cfg: Config = { terraformBlocks: [], providers: [], variables: new Map(), locals: new Map(), resources: new Map(), data: new Map(), outputs: new Map(), sources: {} };
  for (const f of files) {
    const src = io.files.read(f) ?? '';
    cfg.sources[f] = src;
    let body: HBody;
    try {
      body = parseHcl(src, f);
    } catch (e) {
      if (e instanceof HclError) throw new TfError(e.summary, e.detail, { file: e.file, line: e.line, src });
      throw e;
    }
    for (const [k] of Object.entries(body.attrs)) throw new TfError('Unsupported argument', `An argument named "${k}" is not expected here.`, { file: f, line: body.attrs[k].line });
    for (const b of body.blocks) {
      const lbl = b.labels;
      switch (b.type) {
        case 'terraform':
          cfg.terraformBlocks.push(b);
          break;
        case 'provider':
          cfg.providers.push(b);
          break;
        case 'variable':
          if (cfg.variables.has(lbl[0])) throw new TfError('Duplicate variable declaration', `A variable named "${lbl[0]}" was already declared.`, { file: f, line: b.line });
          cfg.variables.set(lbl[0], b);
          break;
        case 'locals':
          for (const [k, a] of Object.entries(b.body.attrs)) cfg.locals.set(k, { expr: a.expr, line: a.line, file: f });
          break;
        case 'resource': {
          if (lbl.length !== 2) throw new TfError('Missing name for resource', 'All resource blocks must have 2 labels (type, name).', { file: f, line: b.line });
          const key = `${lbl[0]}.${lbl[1]}`;
          if (cfg.resources.has(key)) throw new TfError('Duplicate resource configuration', `A ${lbl[0]} resource named "${lbl[1]}" was already declared.`, { file: f, line: b.line });
          cfg.resources.set(key, b);
          break;
        }
        case 'data':
          cfg.data.set(`${lbl[0]}.${lbl[1]}`, b);
          break;
        case 'output':
          cfg.outputs.set(lbl[0], b);
          break;
        case 'module':
          throw new TfError('Unsupported block type', 'Los módulos todavía no están soportados por el simulador.', { file: f, line: b.line });
        default:
          throw new TfError('Unsupported block type', `Blocks of type "${b.type}" are not expected here.`, { file: f, line: b.line });
      }
    }
  }
  return cfg;
}

function requiredProviders(cfg: Config): Record<string, { source: string; version?: string }> {
  const out: Record<string, { source: string; version?: string }> = {};
  for (const tb of cfg.terraformBlocks) {
    for (const rp of tb.body.blocks.filter((b) => b.type === 'required_providers')) {
      for (const [name, a] of Object.entries(rp.body.attrs)) {
        const v = evalHcl(a.expr, { lookup: () => undefined });
        out[name] = typeof v === 'string' ? { source: `hashicorp/${name}`, version: v } : { source: v?.source ?? `hashicorp/${name}`, version: v?.version };
      }
    }
  }
  for (const key of [...cfg.resources.keys(), ...cfg.data.keys()]) {
    const p = key.split('_')[0];
    if (!out[p]) out[p] = { source: `hashicorp/${p}` };
  }
  return out;
}

function backendConfig(cfg: Config, sc: EvalScope): { type: string; attrs: Record<string, any> } | null {
  for (const tb of cfg.terraformBlocks) {
    const be = tb.body.blocks.find((b) => b.type === 'backend');
    if (be) {
      const attrs: Record<string, any> = {};
      for (const [k, a] of Object.entries(be.body.attrs)) attrs[k] = evalHcl(a.expr, sc);
      return { type: be.labels[0], attrs };
    }
  }
  return null;
}

// ---------------------------------------------------------------- estado

interface StateInstance {
  index_key?: number;
  schema_version: number;
  attributes: Record<string, any>;
  sensitive_attributes: any[];
  dependencies?: string[];
}

interface StateResource {
  mode: 'managed' | 'data';
  type: string;
  name: string;
  provider: string;
  instances: StateInstance[];
}

interface TfState {
  version: 4;
  terraform_version: string;
  serial: number;
  lineage: string;
  outputs: Record<string, { value: any; type: any; sensitive?: boolean }>;
  resources: StateResource[];
  check_results: null;
}

function emptyState(): TfState {
  return { version: 4, terraform_version: TF_VERSION, serial: 0, lineage: guid(), outputs: {}, resources: [], check_results: null };
}

interface StateStore {
  load(): TfState;
  save(st: TfState): void;
  describe: string;
}

/** Configuración del backend guardada por terraform init (incluye -backend-config parciales). */
function savedBackend(io: TfIO): Record<string, any> {
  try {
    return JSON.parse(io.files.read('.terraform/terraform.tfstate') ?? '{}').backend?.config ?? {};
  } catch {
    return {};
  }
}

function stateStore(cfg: Config, io: TfIO, auth: Auth | null): StateStore {
  const be = backendConfig(cfg, { lookup: () => undefined });
  if (be) be.attrs = { ...savedBackend(io), ...Object.fromEntries(Object.entries(be.attrs).filter(([, v]) => v !== undefined && v !== null)) };
  if (!be || be.type === 'local') {
    const path = be?.attrs.path ?? 'terraform.tfstate';
    return {
      describe: 'local',
      load: () => {
        const raw = io.files.read(path);
        return raw ? JSON.parse(raw) : emptyState();
      },
      save: (st) => {
        const prev = io.files.read(path);
        if (prev) io.files.write(`${path}.backup`, prev);
        io.files.write(path, JSON.stringify(st, null, 2) + '\n');
      },
    };
  }
  if (be.type !== 'azurerm') throw new TfError('Unsupported backend type', `There is no backend type named "${be.type}" en el simulador (usa "local" o "azurerm").`);
  const { storage_account_name: acct, container_name: container, key } = be.attrs;
  if (!acct || !container || !key) throw new TfError('Missing required argument', 'The backend "azurerm" requires storage_account_name, container_name and key.');
  const principal = auth?.principal ?? io.cliPrincipal;
  const keyAuth = io.env.ARM_ACCESS_KEY ? { mode: 'key' as const, explicitKey: io.env.ARM_ACCESS_KEY } : be.attrs.use_azuread_auth ? { mode: 'login' as const } : { mode: 'key' as const };
  return {
    describe: `azurerm (${acct}/${container}/${key})`,
    load: () => {
      try {
        const b = downloadBlob(acct, container, key, keyAuth, principal);
        return JSON.parse(b.content);
      } catch (e: any) {
        if (e?.code === 'BlobNotFound') return emptyState();
        throw new TfError('Error loading state', `Failed to read state from azurerm backend: ${e?.code ?? ''} ${e?.message ?? e}`);
      }
    },
    save: (st) => {
      try {
        uploadBlob(acct, container, key, JSON.stringify(st, null, 2), { auth: keyAuth, principal, overwrite: true, contentType: 'application/json' });
      } catch (e: any) {
        throw new TfError('Failed to save state', `Error saving state to azurerm backend: ${e?.code ?? ''} ${e?.message ?? e}`);
      }
    },
  };
}

function findStateRes(st: TfState, type: string, name: string): StateResource | undefined {
  return st.resources.find((r) => r.mode === 'managed' && r.type === type && r.name === name);
}

// ---------------------------------------------------------------- autenticación del proveedor

interface Auth {
  principal: PrincipalRef;
  subscriptionId: string;
  features: Record<string, any>;
}

function providerAuth(cfg: Config, io: TfIO, sc: EvalScope, needed: boolean): Auth | null {
  const usesAzurerm = [...cfg.resources.keys(), ...cfg.data.keys()].some((k) => k.startsWith('azurerm_'));
  if (!usesAzurerm && !needed) return null;
  const p = cfg.providers.find((x) => x.labels[0] === 'azurerm');
  if (usesAzurerm && !p) {
    // Terraform crea una configuración vacía implícita, y azurerm exige "features"
    throw new TfError('Missing required argument', 'The argument "features" is required, but no definition was found. (Añade un bloque provider "azurerm" { features {} })');
  }
  if (!p) return null;
  const features = p.body.blocks.find((b) => b.type === 'features');
  if (!features) throw new TfError('Insufficient features blocks', 'At least 1 "features" blocks are required.', { file: p.file, line: p.line });
  const subAttr = p.body.attrs.subscription_id ? evalHcl(p.body.attrs.subscription_id.expr, sc) : undefined;
  const subscriptionId = subAttr ?? io.env.ARM_SUBSCRIPTION_ID;
  const s = getState();
  let principal: PrincipalRef | null = null;
  if (io.env.ARM_CLIENT_ID && io.env.ARM_CLIENT_SECRET) {
    const sp = findSp(io.env.ARM_CLIENT_ID);
    if (!sp || !sp.secrets.includes(io.env.ARM_CLIENT_SECRET)) {
      throw new TfError('building account: could not acquire access token to parse claims', `clientCredentialsToken: received HTTP status 401 with response: {"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${io.env.ARM_CLIENT_ID}'."}`);
    }
    if (io.env.ARM_TENANT_ID && !ciEq(io.env.ARM_TENANT_ID, s.tenant.id)) throw new TfError('building account', `AADSTS90002: Tenant '${io.env.ARM_TENANT_ID}' not found.`);
    principal = principalRefForSp(sp);
  } else principal = io.cliPrincipal;
  if (!principal) throw new TfError('building account: could not acquire access token to parse claims', "running Azure CLI: exit status 1: ERROR: Please run 'az login' to setup account.");
  if (!subscriptionId) {
    throw new TfError(
      'subscription ID could not be determined and was not specified',
      'azurerm 4.x requiere el ID de suscripción. Defínelo en el bloque provider ("subscription_id = ...") o exporta la variable:\n  export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)',
    );
  }
  if (!s.subscriptions.some((x) => ciEq(x.id, subscriptionId))) throw new TfError('building account', `Subscription "${subscriptionId}" was not found in tenant ${s.tenant.id}.`);
  return { principal, subscriptionId: s.subscriptions.find((x) => ciEq(x.id, subscriptionId))!.id, features: {} };
}

// ---------------------------------------------------------------- esquemas de recursos

interface ApplyCtx {
  auth: Auth;
  io: TfIO;
  state: TfState;
  ownedIds: Set<string>;
}

interface Schema {
  required: string[];
  optional: string[];
  blocks?: string[];
  forceNew: string[];
  computed: string[];
  sensitive?: string[];
  create(cfg: any, ctx: ApplyCtx): Promise<Record<string, any>>;
  read(st: Record<string, any>, ctx: ApplyCtx): Record<string, any> | null;
  update?(cfg: any, st: Record<string, any>, ctx: ApplyCtx): Promise<Record<string, any>>;
  destroy(st: Record<string, any>, ctx: ApplyCtx): Promise<void>;
}

const blk = (cfg: any, name: string) => (Array.isArray(cfg[name]) ? cfg[name][0] : cfg[name]) ?? undefined;

function tags(t: any): Record<string, string> {
  return t && typeof t === 'object' ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])) : {};
}

function rgOf(cfg: any): string {
  return cfg.resource_group_name;
}

async function armPut(ctx: ApplyCtx, input: any, rg: string): Promise<Resource> {
  return putResource(input, rg, { principal: ctx.auth.principal, subscriptionId: ctx.auth.subscriptionId, source: 'terraform' });
}

async function armDelete(ctx: ApplyCtx, id: string) {
  if (!findResource(id)) return;
  await deleteResource(id, { principal: ctx.auth.principal });
}

function genericArm(spec: {
  type: string;
  required: string[];
  optional?: string[];
  blocks?: string[];
  forceNew?: string[];
  computed?: string[];
  sensitive?: string[];
  build(cfg: any, ctx: ApplyCtx): any;
  rg?: (cfg: any, ctx: ApplyCtx) => string;
  extra?(res: Resource, cfg: any): Record<string, any>;
}): Schema {
  const rgFn = spec.rg ?? ((cfg: any) => rgOf(cfg));
  const echo = (res: Resource, cfg: any) => ({ ...cfg, id: res.id, ...(spec.extra?.(res, cfg) ?? {}) });
  return {
    required: spec.required,
    optional: ['tags', ...(spec.optional ?? [])],
    blocks: spec.blocks,
    forceNew: spec.forceNew ?? ['name', 'resource_group_name', 'location'],
    computed: ['id', ...(spec.computed ?? [])],
    sensitive: spec.sensitive,
    async create(cfg, ctx) {
      const rg = rgFn(cfg, ctx);
      const existing = findResource(buildId(ctx.auth.subscriptionId, rg, spec.type, spec.build(cfg, ctx).name ?? cfg.name), getState());
      if (existing && !ctx.ownedIds.has(existing.id.toLowerCase())) {
        throw new TfError(
          `A resource with the ID "${existing.id}" already exists - to be managed via Terraform this resource needs to be imported into the State.`,
          `Please see the resource documentation for "${spec.type}" for more information.\n(Usa "terraform import <dirección> ${existing.id}")`,
        );
      }
      const res = await armPut(ctx, { type: spec.type, ...spec.build(cfg, ctx) }, rg);
      return echo(res, cfg);
    },
    read(st) {
      const res = findResource(st.id);
      if (!res) return null;
      return { ...st, tags: res.tags && Object.keys(res.tags).length ? { ...res.tags } : st.tags ? {} : undefined, ...(spec.extra?.(res, st) ?? {}) };
    },
    async update(cfg, st, ctx) {
      const res = await armPut(ctx, { type: spec.type, ...spec.build(cfg, ctx) }, rgFn(cfg, ctx));
      return echo(res, cfg);
    },
    async destroy(st, ctx) {
      await armDelete(ctx, st.id);
    },
  };
}

function stackToFx(stack: any): string | undefined {
  if (!stack) return undefined;
  if (stack.node_version) return `NODE|${stack.node_version}`;
  if (stack.python_version) return `PYTHON|${stack.python_version}`;
  if (stack.dotnet_version) return `DOTNETCORE|${stack.dotnet_version}`;
  if (stack.java_version) return `JAVA|${stack.java_version}-java${stack.java_version}`;
  if (stack.php_version) return `PHP|${stack.php_version}`;
  if (stack.docker_image_name) return `DOCKER|${(stack.docker_registry_url ?? '').replace(/^https?:\/\//, '')}${stack.docker_registry_url ? '/' : ''}${stack.docker_image_name}`;
  return undefined;
}

function randomFrom(alphabet: string, len: number, seed: string): string {
  const r = seededRandom(fnv1a(seed));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(r() * alphabet.length)];
  return out;
}

const PETS_ADJ = ['brave', 'calm', 'eager', 'fancy', 'gentle', 'happy', 'jolly', 'kind', 'lively', 'nice', 'proud', 'silly', 'witty', 'zesty', 'bold', 'crisp'];
const PETS_ANIMAL = ['otter', 'panda', 'tiger', 'koala', 'lynx', 'falcon', 'gecko', 'heron', 'ibis', 'jaguar', 'lemur', 'marmot', 'newt', 'orca', 'puffin', 'quokka'];

const SCHEMAS: Record<string, Schema> = {
  random_string: {
    required: ['length'],
    optional: ['special', 'upper', 'lower', 'numeric', 'number', 'min_upper', 'min_lower', 'min_numeric', 'min_special', 'override_special', 'keepers'],
    forceNew: ['length', 'special', 'upper', 'lower', 'numeric', 'number', 'keepers'],
    computed: ['id', 'result'],
    async create(cfg) {
      let alpha = '';
      if (cfg.lower !== false) alpha += 'abcdefghijklmnopqrstuvwxyz';
      if (cfg.upper !== false) alpha += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      if (cfg.numeric !== false && cfg.number !== false) alpha += '0123456789';
      if (cfg.special !== false) alpha += cfg.override_special ?? '!@#$%&*()-_=+[]{}<>:?';
      const result = randomFrom(alpha || 'abc', Number(cfg.length), guid());
      return { ...cfg, id: result, result };
    },
    read: (st) => st,
    async destroy() {},
  },
  random_password: {
    required: ['length'],
    optional: ['special', 'upper', 'lower', 'numeric', 'override_special', 'min_upper', 'min_lower', 'min_numeric', 'min_special'],
    forceNew: ['length', 'special'],
    computed: ['id', 'result', 'bcrypt_hash'],
    sensitive: ['result', 'bcrypt_hash'],
    async create(cfg) {
      const result = randomFrom('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' + (cfg.special !== false ? '!#$%&*-_=+' : ''), Number(cfg.length), guid()) + 'Aa1!';
      return { ...cfg, id: 'none', result: result.slice(0, Number(cfg.length)), bcrypt_hash: '$2a$10$' + randomFrom('abcdef0123456789', 53, guid()) };
    },
    read: (st) => st,
    async destroy() {},
  },
  random_pet: {
    required: [],
    optional: ['length', 'separator', 'prefix', 'keepers'],
    forceNew: ['length', 'separator', 'prefix', 'keepers'],
    computed: ['id'],
    async create(cfg) {
      const r = seededRandom(fnv1a(guid()));
      const n = Number(cfg.length ?? 2);
      const words = [...Array(Math.max(0, n - 1))].map(() => PETS_ADJ[Math.floor(r() * PETS_ADJ.length)]);
      words.push(PETS_ANIMAL[Math.floor(r() * PETS_ANIMAL.length)]);
      const id = [cfg.prefix, ...words].filter(Boolean).join(cfg.separator ?? '-');
      return { ...cfg, id };
    },
    read: (st) => st,
    async destroy() {},
  },
  random_integer: {
    required: ['min', 'max'],
    optional: ['seed', 'keepers'],
    forceNew: ['min', 'max', 'seed', 'keepers'],
    computed: ['id', 'result'],
    async create(cfg) {
      const result = Math.floor(Number(cfg.min) + Math.random() * (Number(cfg.max) - Number(cfg.min) + 1));
      return { ...cfg, id: String(result), result };
    },
    read: (st) => st,
    async destroy() {},
  },
  azurerm_resource_group: {
    required: ['name', 'location'],
    optional: ['tags', 'managed_by'],
    forceNew: ['name', 'location'],
    computed: ['id'],
    async create(cfg, ctx) {
      const existing = findRg(ctx.auth.subscriptionId, cfg.name);
      if (existing && !ctx.ownedIds.has(existing.id.toLowerCase())) {
        throw new TfError(`A resource with the ID "${existing.id}" already exists - to be managed via Terraform this resource needs to be imported into the State.`, `Please see the resource documentation for "azurerm_resource_group" for more information.\n(Usa "terraform import azurerm_resource_group.<nombre> ${existing.id}")`);
      }
      const rg = createResourceGroup(cfg.name, cfg.location, tags(cfg.tags), { principal: ctx.auth.principal, subscriptionId: ctx.auth.subscriptionId });
      return { ...cfg, id: rg.id, location: rg.location, tags: cfg.tags ?? {} };
    },
    read(st, ctx) {
      const rg = findRg(ctx.auth.subscriptionId, st.name);
      if (!rg) return null;
      return { ...st, location: rg.location, tags: { ...rg.tags } };
    },
    async update(cfg, st, ctx) {
      updateResourceGroupTags(cfg.name, tags(cfg.tags), { principal: ctx.auth.principal, subscriptionId: ctx.auth.subscriptionId });
      return { ...st, ...cfg, tags: cfg.tags ?? {} };
    },
    async destroy(st, ctx) {
      const s = getState();
      const inside = listResources({ rg: st.name, subscriptionId: ctx.auth.subscriptionId }, s).filter((r) => !getProvider(r.type)?.hidden && !ctx.ownedIds.has(r.id.toLowerCase()));
      if (inside.length) {
        throw new TfError(
          `deleting Resource Group "${st.name}": the Resource Group still contains Resources.`,
          `Terraform is configured to check for Resources within the Resource Group when deleting the Resource Group - and raise an error if nested Resources still exist to avoid unintentionally deleting these Resources.\n\nTerraform has detected that the following Resources still exist within the Resource Group:\n\n${inside.map((r) => `* \`${r.id}\``).join('\n')}\n\nThis feature is intended to avoid the unintentional destruction of nested Resources provisioned through some other means (for example, an ARM Template Deployment) - as such you must either remove these Resources, or disable this behaviour using the feature flag \`prevent_deletion_if_contains_resources\` within the \`features\` block when configuring the Provider.`,
        );
      }
      if (findRg(ctx.auth.subscriptionId, st.name)) await deleteResourceGroup(st.name, { principal: ctx.auth.principal, subscriptionId: ctx.auth.subscriptionId });
    },
  },
  azurerm_storage_account: genericArm({
    type: 'Microsoft.Storage/storageAccounts',
    required: ['name', 'resource_group_name', 'location', 'account_tier', 'account_replication_type'],
    optional: ['account_kind', 'access_tier', 'min_tls_version', 'https_traffic_only_enabled', 'allow_nested_items_to_be_public', 'public_network_access_enabled', 'shared_access_key_enabled', 'is_hns_enabled'],
    blocks: ['static_website', 'network_rules', 'blob_properties', 'identity'],
    forceNew: ['name', 'resource_group_name', 'location', 'account_tier', 'account_kind', 'is_hns_enabled'],
    computed: ['primary_blob_endpoint', 'primary_web_endpoint', 'primary_access_key', 'primary_connection_string', 'secondary_location'],
    sensitive: ['primary_access_key', 'primary_connection_string'],
    build: (c) => ({
      name: c.name,
      location: c.location,
      tags: tags(c.tags),
      kind: c.account_kind ?? 'StorageV2',
      sku: { name: `${c.account_tier}_${c.account_replication_type}` },
      properties: {
        accessTier: c.account_tier === 'Premium' ? undefined : c.access_tier ?? 'Hot',
        minimumTlsVersion: c.min_tls_version ?? 'TLS1_2',
        supportsHttpsTrafficOnly: c.https_traffic_only_enabled ?? true,
        allowBlobPublicAccess: c.allow_nested_items_to_be_public ?? false,
        publicNetworkAccess: c.public_network_access_enabled === false ? 'Disabled' : 'Enabled',
        allowSharedKeyAccess: c.shared_access_key_enabled ?? true,
        isHnsEnabled: c.is_hns_enabled ?? false,
        networkAcls: blk(c, 'network_rules') ? { defaultAction: blk(c, 'network_rules').default_action ?? 'Deny', ipRules: (blk(c, 'network_rules').ip_rules ?? []).map((v: string) => ({ value: v, action: 'Allow' })), virtualNetworkRules: [] } : undefined,
      },
    }),
    extra: (r) => {
      const key = r.data?.keys?.[0]?.value ?? '';
      return {
        primary_blob_endpoint: r.properties.primaryEndpoints?.blob,
        primary_web_endpoint: r.properties.primaryEndpoints?.web,
        primary_access_key: key,
        primary_connection_string: `DefaultEndpointsProtocol=https;AccountName=${r.name};AccountKey=${key};EndpointSuffix=core.windows.net`,
        secondary_location: r.properties.secondaryLocation ?? '',
        account_replication_type: (r.sku?.name ?? '').split('_')[1],
        access_tier: r.properties.accessTier,
      };
    },
  }),
  azurerm_storage_container: {
    required: ['name'],
    optional: ['storage_account_name', 'storage_account_id', 'container_access_type', 'metadata'],
    forceNew: ['name', 'storage_account_name', 'storage_account_id'],
    computed: ['id', 'resource_manager_id'],
    async create(cfg, ctx) {
      const acct = cfg.storage_account_id ? findResource(cfg.storage_account_id) : getState().resources.find((r) => ciEq(r.type, 'Microsoft.Storage/storageAccounts') && ciEq(r.name, cfg.storage_account_name));
      if (!acct) throw new TfError('retrieving Storage Account', `Storage Account "${cfg.storage_account_name ?? cfg.storage_account_id}" was not found.`);
      authorize(ctx.auth.principal, 'Microsoft.Storage/storageAccounts/blobServices/containers/write', acct.id);
      const access = cfg.container_access_type ?? 'private';
      if (access !== 'private' && !acct.properties.allowBlobPublicAccess) throw new TfError('creating Container', 'containers.Client#Create: Failure responding to request: StatusCode=409 -- Original Error: autorest/azure: Service returned an error. Status=409 Code="PublicAccessNotPermitted" Message="Public access is not permitted on this storage account."');
      const cs = containersOf(acct);
      cs[cfg.name] = cs[cfg.name] ?? { name: cfg.name, publicAccess: access === 'private' ? 'off' : access, lastModified: new Date().toISOString(), etag: `"0x${guid().slice(0, 12)}"`, metadata: cfg.metadata ?? {}, blobs: {} };
      changed();
      const rmId = `${acct.id}/blobServices/default/containers/${cfg.name}`;
      return { ...cfg, id: cfg.storage_account_id ? rmId : `https://${acct.name}.blob.core.windows.net/${cfg.name}`, resource_manager_id: rmId, container_access_type: access };
    },
    read(st) {
      const acctId = st.resource_manager_id?.split('/blobServices/')[0];
      const acct = acctId ? findResource(acctId) : undefined;
      if (!acct || !acct.data?.containers?.[st.name]) return null;
      return st;
    },
    async destroy(st, ctx) {
      const acctId = st.resource_manager_id?.split('/blobServices/')[0];
      const acct = acctId ? findResource(acctId) : undefined;
      if (acct?.data?.containers?.[st.name]) {
        authorize(ctx.auth.principal, 'Microsoft.Storage/storageAccounts/blobServices/containers/delete', acct.id);
        delete acct.data.containers[st.name];
        changed();
      }
    },
  },
  azurerm_virtual_network: genericArm({
    type: 'Microsoft.Network/virtualNetworks',
    required: ['name', 'resource_group_name', 'location', 'address_space'],
    optional: ['dns_servers'],
    blocks: ['subnet'],
    computed: ['guid'],
    build: (c) => ({
      name: c.name,
      location: c.location,
      tags: tags(c.tags),
      properties: {
        addressSpace: { addressPrefixes: c.address_space },
        dhcpOptions: { dnsServers: c.dns_servers ?? [] },
        subnets: Array.isArray(c.subnet) ? c.subnet.map((s: any) => ({ name: s.name, properties: { addressPrefix: (s.address_prefixes ?? [s.address_prefix])[0], networkSecurityGroup: s.security_group ? { id: s.security_group } : undefined } })) : undefined,
      },
    }),
    extra: (r) => ({ guid: r.properties.resourceGuid }),
  }),
  azurerm_subnet: {
    required: ['name', 'resource_group_name', 'virtual_network_name', 'address_prefixes'],
    optional: ['service_endpoints', 'default_outbound_access_enabled'],
    blocks: ['delegation'],
    forceNew: ['name', 'resource_group_name', 'virtual_network_name'],
    computed: ['id'],
    async create(cfg, ctx) {
      const vnetId = buildId(ctx.auth.subscriptionId, cfg.resource_group_name, 'Microsoft.Network/virtualNetworks', cfg.virtual_network_name);
      if (!findResource(vnetId)) throw new TfError('retrieving Virtual Network', `Virtual Network "${cfg.virtual_network_name}" (Resource Group "${cfg.resource_group_name}") was not found.`);
      const sn = upsertSubnet(vnetId, { name: cfg.name, addressPrefix: cfg.address_prefixes?.[0], serviceEndpoints: cfg.service_endpoints }, ctx.auth.principal);
      return { ...cfg, id: sn.id };
    },
    read(st) {
      const vnet = findResource(st.id.split('/subnets/')[0]);
      const sn = vnet?.properties.subnets?.find((x: any) => ciEq(x.name, st.name));
      if (!sn) return null;
      return { ...st, address_prefixes: [sn.properties.addressPrefix] };
    },
    async update(cfg, st, ctx) {
      upsertSubnet(st.id.split('/subnets/')[0], { name: cfg.name, addressPrefix: cfg.address_prefixes?.[0], serviceEndpoints: cfg.service_endpoints }, ctx.auth.principal);
      return { ...st, ...cfg };
    },
    async destroy(st, ctx) {
      const vnet = findResource(st.id.split('/subnets/')[0]);
      if (vnet?.properties.subnets?.some((x: any) => ciEq(x.name, st.name))) deleteSubnet(vnet.id, st.name, ctx.auth.principal);
    },
  },
  azurerm_network_security_group: genericArm({
    type: 'Microsoft.Network/networkSecurityGroups',
    required: ['name', 'resource_group_name', 'location'],
    blocks: ['security_rule'],
    build: (c) => ({
      name: c.name,
      location: c.location,
      tags: tags(c.tags),
      properties: {
        securityRules: (c.security_rule ?? []).map((r: any) => ({
          name: r.name,
          properties: {
            priority: r.priority,
            direction: r.direction,
            access: r.access,
            protocol: r.protocol,
            sourcePortRange: r.source_port_range,
            sourcePortRanges: r.source_port_ranges,
            destinationPortRange: r.destination_port_range,
            destinationPortRanges: r.destination_port_ranges,
            sourceAddressPrefix: r.source_address_prefix,
            sourceAddressPrefixes: r.source_address_prefixes,
            destinationAddressPrefix: r.destination_address_prefix,
            destinationAddressPrefixes: r.destination_address_prefixes,
            description: r.description,
          },
        })),
      },
    }),
  }),
  azurerm_network_security_rule: {
    required: ['name', 'resource_group_name', 'network_security_group_name', 'priority', 'direction', 'access', 'protocol'],
    optional: ['source_port_range', 'source_port_ranges', 'destination_port_range', 'destination_port_ranges', 'source_address_prefix', 'source_address_prefixes', 'destination_address_prefix', 'destination_address_prefixes', 'description'],
    forceNew: ['name', 'resource_group_name', 'network_security_group_name'],
    computed: ['id'],
    async create(c, ctx) {
      const nsgId = buildId(ctx.auth.subscriptionId, c.resource_group_name, 'Microsoft.Network/networkSecurityGroups', c.network_security_group_name);
      const r = upsertNsgRule(nsgId, { name: c.name, properties: { priority: c.priority, direction: c.direction, access: c.access, protocol: c.protocol, sourcePortRange: c.source_port_range, sourcePortRanges: c.source_port_ranges, destinationPortRange: c.destination_port_range, destinationPortRanges: c.destination_port_ranges, sourceAddressPrefix: c.source_address_prefix, sourceAddressPrefixes: c.source_address_prefixes, destinationAddressPrefix: c.destination_address_prefix, destinationAddressPrefixes: c.destination_address_prefixes, description: c.description } }, ctx.auth.principal);
      return { ...c, id: r.id };
    },
    read(st) {
      const nsg = findResource(st.id.split('/securityRules/')[0]);
      return nsg?.properties.securityRules?.some((r: any) => ciEq(r.name, st.name)) ? st : null;
    },
    async update(c, st, ctx) {
      return SCHEMAS.azurerm_network_security_rule.create(c, ctx);
    },
    async destroy(st, ctx) {
      const nsg = findResource(st.id.split('/securityRules/')[0]);
      if (nsg?.properties.securityRules?.some((r: any) => ciEq(r.name, st.name))) deleteNsgRule(nsg.id, st.name, ctx.auth.principal);
    },
  },
  azurerm_subnet_network_security_group_association: {
    required: ['subnet_id', 'network_security_group_id'],
    optional: [],
    forceNew: ['subnet_id', 'network_security_group_id'],
    computed: ['id'],
    async create(c, ctx) {
      const vnetId = c.subnet_id.split('/subnets/')[0];
      const name = c.subnet_id.split('/subnets/')[1];
      upsertSubnet(vnetId, { name, nsgId: c.network_security_group_id }, ctx.auth.principal);
      return { ...c, id: c.subnet_id };
    },
    read(st) {
      const vnet = findResource(st.subnet_id.split('/subnets/')[0]);
      const sn = vnet?.properties.subnets?.find((x: any) => ciEq(x.id, st.subnet_id));
      return sn && ciEq(sn.properties.networkSecurityGroup?.id, st.network_security_group_id) ? st : null;
    },
    async destroy(st, ctx) {
      const vnetId = st.subnet_id.split('/subnets/')[0];
      if (findResource(vnetId)) upsertSubnet(vnetId, { name: st.subnet_id.split('/subnets/')[1], nsgId: null }, ctx.auth.principal);
    },
  },
  azurerm_public_ip: genericArm({
    type: 'Microsoft.Network/publicIPAddresses',
    required: ['name', 'resource_group_name', 'location', 'allocation_method'],
    optional: ['sku', 'domain_name_label', 'zones', 'idle_timeout_in_minutes'],
    computed: ['ip_address', 'fqdn'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), sku: { name: c.sku ?? 'Standard' }, properties: { publicIPAllocationMethod: c.allocation_method, dnsSettings: c.domain_name_label ? { domainNameLabel: c.domain_name_label } : undefined } }),
    extra: (r) => ({ ip_address: r.properties.ipAddress, fqdn: r.properties.dnsSettings?.fqdn ?? '' }),
  }),
  azurerm_network_interface: genericArm({
    type: 'Microsoft.Network/networkInterfaces',
    required: ['name', 'resource_group_name', 'location'],
    blocks: ['ip_configuration'],
    computed: ['private_ip_address', 'mac_address'],
    build: (c) => {
      const ic = blk(c, 'ip_configuration') ?? {};
      return { name: c.name, location: c.location, tags: tags(c.tags), properties: { ipConfigurations: [{ name: ic.name ?? 'internal', properties: { subnet: { id: ic.subnet_id }, privateIPAllocationMethod: ic.private_ip_address_allocation ?? 'Dynamic', publicIPAddress: ic.public_ip_address_id ? { id: ic.public_ip_address_id } : undefined } }] } };
    },
    extra: (r) => ({ private_ip_address: r.properties.ipConfigurations?.[0]?.properties?.privateIPAddress, mac_address: r.properties.macAddress }),
  }),
  azurerm_network_interface_security_group_association: {
    required: ['network_interface_id', 'network_security_group_id'],
    optional: [],
    forceNew: ['network_interface_id', 'network_security_group_id'],
    computed: ['id'],
    async create(c, ctx) {
      setNicNsg(c.network_interface_id, c.network_security_group_id, ctx.auth.principal);
      return { ...c, id: `${c.network_interface_id}|${c.network_security_group_id}` };
    },
    read(st) {
      const nic = findResource(st.network_interface_id);
      return nic && ciEq(nic.properties.networkSecurityGroup?.id, st.network_security_group_id) ? st : null;
    },
    async destroy(st, ctx) {
      if (findResource(st.network_interface_id)) setNicNsg(st.network_interface_id, null, ctx.auth.principal);
    },
  },
  azurerm_linux_virtual_machine: genericArm({
    type: 'Microsoft.Compute/virtualMachines',
    required: ['name', 'resource_group_name', 'location', 'size', 'admin_username', 'network_interface_ids'],
    optional: ['admin_password', 'disable_password_authentication', 'computer_name', 'custom_data', 'zone'],
    blocks: ['admin_ssh_key', 'os_disk', 'source_image_reference', 'identity', 'boot_diagnostics'],
    forceNew: ['name', 'resource_group_name', 'location', 'admin_username', 'admin_password', 'source_image_reference', 'computer_name'],
    computed: ['public_ip_address', 'private_ip_address', 'virtual_machine_id'],
    sensitive: ['admin_password', 'custom_data'],
    build: (c) => {
      const img = blk(c, 'source_image_reference') ?? {};
      const od = blk(c, 'os_disk') ?? {};
      const key = blk(c, 'admin_ssh_key');
      const pwd = c.disable_password_authentication === false;
      return {
        name: c.name,
        location: c.location,
        tags: tags(c.tags),
        properties: {
          hardwareProfile: { vmSize: c.size },
          storageProfile: { imageReference: { publisher: img.publisher, offer: img.offer, sku: img.sku, version: img.version ?? 'latest' }, osDisk: { managedDisk: { storageAccountType: od.storage_account_type ?? 'Standard_LRS' }, diskSizeGB: od.disk_size_gb, deleteOption: 'Delete' } },
          osProfile: { computerName: c.computer_name ?? c.name, adminUsername: c.admin_username, adminPassword: c.admin_password, linuxConfiguration: { disablePasswordAuthentication: !pwd, ssh: key ? { publicKeys: [{ path: `/home/${c.admin_username}/.ssh/authorized_keys`, keyData: key.public_key }] } : undefined } },
          networkProfile: { networkInterfaces: (c.network_interface_ids ?? []).map((id: string) => ({ id })) },
        },
      };
    },
    extra: (r) => {
      const n = vmNetworkInfo(r, getState());
      return { public_ip_address: n.publicIp ?? '', private_ip_address: n.privateIp ?? '', virtual_machine_id: r.properties.vmId };
    },
  }),
  azurerm_service_plan: genericArm({
    type: 'Microsoft.Web/serverfarms',
    required: ['name', 'resource_group_name', 'location', 'os_type', 'sku_name'],
    optional: ['worker_count', 'zone_balancing_enabled'],
    forceNew: ['name', 'resource_group_name', 'location', 'os_type'],
    computed: ['kind', 'reserved'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), kind: c.os_type === 'Linux' ? 'linux' : 'app', sku: { name: c.sku_name, capacity: c.worker_count ?? 1 }, properties: { reserved: c.os_type === 'Linux' } }),
    extra: (r) => ({ kind: r.kind, reserved: r.properties.reserved, worker_count: r.sku?.capacity }),
  }),
  azurerm_linux_web_app: genericArm({
    type: 'Microsoft.Web/sites',
    required: ['name', 'resource_group_name', 'location', 'service_plan_id'],
    optional: ['https_only', 'app_settings', 'enabled', 'public_network_access_enabled', 'client_affinity_enabled'],
    blocks: ['site_config', 'identity', 'connection_string', 'logs'],
    computed: ['default_hostname', 'outbound_ip_addresses', 'possible_outbound_ip_addresses', 'kind'],
    build: (c) => {
      const sc = blk(c, 'site_config') ?? {};
      const stack = blk(sc, 'application_stack');
      const ident = blk(c, 'identity');
      return {
        name: c.name,
        location: c.location,
        tags: tags(c.tags),
        kind: 'app,linux',
        identity: ident ? { type: ident.type } : { type: 'None' },
        properties: {
          serverFarmId: c.service_plan_id,
          httpsOnly: c.https_only ?? false,
          publicNetworkAccess: c.public_network_access_enabled === false ? 'Disabled' : 'Enabled',
          siteConfig: {
            linuxFxVersion: stackToFx(stack) ?? '',
            alwaysOn: sc.always_on ?? true,
            healthCheckPath: sc.health_check_path,
            minTlsVersion: sc.minimum_tls_version ?? '1.2',
            ftpsState: sc.ftps_state ?? 'Disabled',
            appSettings: Object.entries(c.app_settings ?? {}).map(([name, value]) => ({ name, value: String(value) })),
          },
        },
      };
    },
    extra: (r) => ({
      default_hostname: r.properties.defaultHostName,
      outbound_ip_addresses: r.properties.outboundIpAddresses,
      possible_outbound_ip_addresses: r.properties.possibleOutboundIpAddresses,
      kind: r.kind,
      identity: r.identity?.principalId ? [{ type: r.identity.type, principal_id: r.identity.principalId, tenant_id: r.identity.tenantId, identity_ids: [] }] : [],
    }),
  }),
  azurerm_key_vault: genericArm({
    type: 'Microsoft.KeyVault/vaults',
    required: ['name', 'resource_group_name', 'location', 'tenant_id', 'sku_name'],
    optional: ['rbac_authorization_enabled', 'enable_rbac_authorization', 'purge_protection_enabled', 'soft_delete_retention_days', 'public_network_access_enabled', 'enabled_for_deployment', 'enabled_for_template_deployment', 'enabled_for_disk_encryption'],
    blocks: ['access_policy', 'network_acls'],
    forceNew: ['name', 'resource_group_name', 'location', 'tenant_id'],
    computed: ['vault_uri'],
    build: (c) => ({
      name: c.name,
      location: c.location,
      tags: tags(c.tags),
      properties: {
        tenantId: c.tenant_id,
        sku: { family: 'A', name: c.sku_name },
        enableRbacAuthorization: c.rbac_authorization_enabled ?? c.enable_rbac_authorization ?? false,
        enablePurgeProtection: c.purge_protection_enabled ?? null,
        softDeleteRetentionInDays: c.soft_delete_retention_days ?? 90,
        publicNetworkAccess: c.public_network_access_enabled === false ? 'Disabled' : 'Enabled',
        accessPolicies: (c.access_policy ?? []).map((ap: any) => ({ tenantId: ap.tenant_id, objectId: ap.object_id, permissions: { secrets: (ap.secret_permissions ?? []).map((x: string) => x.toLowerCase()), keys: (ap.key_permissions ?? []).map((x: string) => x.toLowerCase()), certificates: [] } })),
      },
    }),
    extra: (r) => ({ vault_uri: r.properties.vaultUri }),
  }),
  azurerm_key_vault_secret: {
    required: ['name', 'value', 'key_vault_id'],
    optional: ['content_type', 'tags', 'expiration_date'],
    forceNew: ['name', 'key_vault_id'],
    computed: ['id', 'version', 'versionless_id', 'resource_id'],
    sensitive: ['value'],
    async create(c, ctx) {
      const vault = findResource(c.key_vault_id);
      if (!vault) throw new TfError('retrieving Key Vault', `Key Vault "${c.key_vault_id}" was not found.`);
      try {
        const sec = setSecret(vault.name, c.name, String(c.value), { principal: ctx.auth.principal, contentType: c.content_type });
        return { ...c, id: sec.id, version: sec.id.split('/').pop(), versionless_id: `${vault.properties.vaultUri}secrets/${c.name}`, resource_id: `${vault.id}/secrets/${c.name}` };
      } catch (e: any) {
        throw new TfError(`checking for presence of existing Secret "${c.name}" (Key Vault "${vault.properties.vaultUri}")`, `keyvault.BaseClient#GetSecret: Failure responding to request: StatusCode=403 -- Original Error: autorest/azure: Service returned an error. Status=403 Code="Forbidden" Message="${(e?.message ?? '').split('\n')[0]}"\n\n(Pista: el principal con el que ejecutas Terraform necesita un rol como "Key Vault Secrets Officer" en el almacén.)`);
      }
    },
    read(st) {
      const vault = findResource(st.key_vault_id);
      const sec = vault?.data?.secrets?.[st.name];
      if (!sec || sec.deleted) return null;
      return st;
    },
    async update(c, st, ctx) {
      return SCHEMAS.azurerm_key_vault_secret.create(c, ctx);
    },
    async destroy(st, ctx) {
      const vault = findResource(st.key_vault_id);
      if (vault?.data?.secrets?.[st.name] && !vault.data.secrets[st.name].deleted) deleteSecret(vault.name, st.name, ctx.auth.principal);
    },
  },
  azurerm_container_registry: genericArm({
    type: 'Microsoft.ContainerRegistry/registries',
    required: ['name', 'resource_group_name', 'location', 'sku'],
    optional: ['admin_enabled', 'public_network_access_enabled', 'anonymous_pull_enabled'],
    computed: ['login_server', 'admin_username', 'admin_password'],
    sensitive: ['admin_password'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), sku: { name: c.sku }, properties: { adminUserEnabled: c.admin_enabled ?? false, anonymousPullEnabled: c.anonymous_pull_enabled ?? false } }),
    extra: (r) => ({ login_server: r.properties.loginServer, admin_username: r.properties.adminUserEnabled ? r.name : '', admin_password: r.properties.adminUserEnabled ? r.data?.passwords?.[0]?.value : '' }),
  }),
  azurerm_kubernetes_cluster: genericArm({
    type: 'Microsoft.ContainerService/managedClusters',
    required: ['name', 'resource_group_name', 'location'],
    optional: ['dns_prefix', 'kubernetes_version', 'sku_tier', 'node_resource_group', 'oidc_issuer_enabled', 'workload_identity_enabled', 'role_based_access_control_enabled'],
    blocks: ['default_node_pool', 'identity', 'oms_agent', 'network_profile'],
    forceNew: ['name', 'resource_group_name', 'location', 'dns_prefix', 'node_resource_group'],
    computed: ['fqdn', 'kube_config_raw', 'kubelet_identity', 'node_resource_group', 'oidc_issuer_url'],
    sensitive: ['kube_config_raw', 'kube_config'],
    build: (c) => {
      const np = blk(c, 'default_node_pool') ?? {};
      const oms = blk(c, 'oms_agent');
      return {
        name: c.name,
        location: c.location,
        tags: tags(c.tags),
        sku: { name: 'Base', tier: c.sku_tier ?? 'Free' },
        identity: { type: blk(c, 'identity')?.type ?? 'SystemAssigned' },
        properties: {
          kubernetesVersion: c.kubernetes_version,
          dnsPrefix: c.dns_prefix,
          nodeResourceGroup: c.node_resource_group,
          agentPoolProfiles: [{ name: np.name ?? 'default', count: np.node_count ?? 1, vmSize: np.vm_size ?? 'Standard_D2s_v5', mode: 'System', enableAutoScaling: np.auto_scaling_enabled ?? false, minCount: np.min_count, maxCount: np.max_count }],
          addonProfiles: oms ? { omsagent: { enabled: true, config: { logAnalyticsWorkspaceResourceID: oms.log_analytics_workspace_id } } } : {},
          networkProfile: { networkPlugin: blk(c, 'network_profile')?.network_plugin ?? 'azure' },
          oidcIssuerProfile: { enabled: c.oidc_issuer_enabled ?? false },
        },
      };
    },
    extra: (r) => ({
      fqdn: r.properties.fqdn,
      node_resource_group: r.properties.nodeResourceGroup,
      kube_config_raw: kubeconfigFor(r, false),
      kubelet_identity: [{ client_id: r.properties.identityProfile.kubeletidentity.clientId, object_id: r.properties.identityProfile.kubeletidentity.objectId, user_assigned_identity_id: r.properties.identityProfile.kubeletidentity.resourceId }],
      oidc_issuer_url: r.properties.oidcIssuerProfile?.enabled ? `https://${r.location}.oic.prod-aks.azure.com/${getState().tenant.id}/${guid()}/` : '',
    }),
  }),
  azurerm_role_assignment: {
    required: ['scope', 'principal_id'],
    optional: ['role_definition_name', 'role_definition_id', 'principal_type', 'description', 'skip_service_principal_aad_check'],
    forceNew: ['scope', 'principal_id', 'role_definition_name', 'role_definition_id'],
    computed: ['id', 'principal_type'],
    async create(c, ctx) {
      const role = c.role_definition_name ?? String(c.role_definition_id ?? '').split('/').pop();
      if (!role || !findRoleDefinition(role)) throw new TfError('loading Role Definition List', `could not find role '${role}'`);
      try {
        const ra = createRoleAssignment({ assignee: c.principal_id, role, scope: c.scope }, ctx.auth.principal);
        return { ...c, id: ra.id, principal_type: ra.principalType, role_definition_id: ra.roleDefinitionId, role_definition_name: ra.roleDefinitionName };
      } catch (e: any) {
        if (e?.code === 'RoleAssignmentExists') throw new TfError('unexpected status 409 (409 Conflict) with error: RoleAssignmentExists: The role assignment already exists.', 'Ya existe esa asignación fuera de Terraform: impórtala o elimínala.');
        throw e;
      }
    },
    read(st) {
      return getState().roleAssignments.some((a) => ciEq(a.id, st.id)) ? st : null;
    },
    async destroy(st, ctx) {
      if (getState().roleAssignments.some((a) => ciEq(a.id, st.id))) deleteRoleAssignments({ ids: [st.id] }, ctx.auth.principal);
    },
  },
  azurerm_mssql_server: genericArm({
    type: 'Microsoft.Sql/servers',
    required: ['name', 'resource_group_name', 'location', 'version'],
    optional: ['administrator_login', 'administrator_login_password', 'minimum_tls_version', 'public_network_access_enabled'],
    blocks: ['azuread_administrator', 'identity'],
    computed: ['fully_qualified_domain_name'],
    sensitive: ['administrator_login_password'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), properties: { administratorLogin: c.administrator_login, administratorLoginPassword: c.administrator_login_password, version: c.version, minimalTlsVersion: c.minimum_tls_version ?? '1.2', publicNetworkAccess: c.public_network_access_enabled === false ? 'Disabled' : 'Enabled' } }),
    extra: (r) => ({ fully_qualified_domain_name: r.properties.fullyQualifiedDomainName }),
  }),
  azurerm_mssql_database: genericArm({
    type: 'Microsoft.Sql/servers/databases',
    required: ['name', 'server_id'],
    optional: ['sku_name', 'max_size_gb', 'collation', 'zone_redundant', 'auto_pause_delay_in_minutes', 'min_capacity'],
    forceNew: ['name', 'server_id'],
    rg: (c) => String(c.server_id).split('/')[4],
    build: (c) => {
      const server = findResource(c.server_id);
      if (!server) throw new TfError('retrieving Server', `Server "${c.server_id}" was not found.`);
      return { name: `${server.name}/${c.name}`, location: server.location, tags: tags(c.tags), sku: { name: c.sku_name ?? 'GP_S_Gen5_2' }, properties: { maxSizeBytes: c.max_size_gb ? c.max_size_gb * 1024 ** 3 : undefined, collation: c.collation } };
    },
  }),
  azurerm_mssql_firewall_rule: genericArm({
    type: 'Microsoft.Sql/servers/firewallRules',
    required: ['name', 'server_id', 'start_ip_address', 'end_ip_address'],
    optional: [],
    forceNew: ['name', 'server_id'],
    rg: (c) => String(c.server_id).split('/')[4],
    build: (c) => {
      const server = findResource(c.server_id);
      if (!server) throw new TfError('retrieving Server', `Server "${c.server_id}" was not found.`);
      return { name: `${server.name}/${c.name}`, location: server.location, properties: { startIpAddress: c.start_ip_address, endIpAddress: c.end_ip_address } };
    },
  }),
  azurerm_log_analytics_workspace: genericArm({
    type: 'Microsoft.OperationalInsights/workspaces',
    required: ['name', 'resource_group_name', 'location'],
    optional: ['sku', 'retention_in_days', 'daily_quota_gb'],
    computed: ['workspace_id', 'primary_shared_key'],
    sensitive: ['primary_shared_key'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), properties: { sku: { name: c.sku ?? 'PerGB2018' }, retentionInDays: c.retention_in_days ?? 30 } }),
    extra: (r) => ({ workspace_id: r.properties.customerId, primary_shared_key: btoa(r.properties.customerId).slice(0, 44) + '==' }),
  }),
  azurerm_application_insights: genericArm({
    type: 'Microsoft.Insights/components',
    required: ['name', 'resource_group_name', 'location', 'application_type'],
    optional: ['workspace_id', 'retention_in_days'],
    computed: ['instrumentation_key', 'connection_string', 'app_id'],
    sensitive: ['instrumentation_key', 'connection_string'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), kind: 'web', properties: { Application_Type: c.application_type, WorkspaceResourceId: c.workspace_id } }),
    extra: (r) => ({ instrumentation_key: r.properties.InstrumentationKey, connection_string: r.properties.ConnectionString, app_id: r.properties.AppId }),
  }),
  azurerm_user_assigned_identity: genericArm({
    type: 'Microsoft.ManagedIdentity/userAssignedIdentities',
    required: ['name', 'resource_group_name', 'location'],
    computed: ['principal_id', 'client_id', 'tenant_id'],
    build: (c) => ({ name: c.name, location: c.location, tags: tags(c.tags), properties: {} }),
    extra: (r) => ({ principal_id: r.properties.principalId, client_id: r.properties.clientId, tenant_id: r.properties.tenantId }),
  }),
  azurerm_monitor_action_group: genericArm({
    type: 'Microsoft.Insights/actionGroups',
    required: ['name', 'resource_group_name', 'short_name'],
    optional: ['enabled', 'location'],
    blocks: ['email_receiver'],
    forceNew: ['name', 'resource_group_name'],
    build: (c) => ({ name: c.name, location: 'Global', tags: tags(c.tags), properties: { groupShortName: c.short_name, enabled: c.enabled ?? true, emailReceivers: (c.email_receiver ?? []).map((e: any) => ({ name: e.name, emailAddress: e.email_address })) } }),
  }),
  azurerm_management_lock: {
    required: ['name', 'scope', 'lock_level'],
    optional: ['notes'],
    forceNew: ['name', 'scope', 'lock_level', 'notes'],
    computed: ['id'],
    async create(c, ctx) {
      const l = createLock({ name: c.name, scope: c.scope, level: c.lock_level, notes: c.notes }, ctx.auth.principal);
      return { ...c, id: l.id };
    },
    read(st) {
      return getState().locks.some((l) => ciEq(l.id, st.id)) ? st : null;
    },
    async destroy(st, ctx) {
      if (getState().locks.some((l) => ciEq(l.id, st.id))) deleteLock(st.name, st.scope, ctx.auth.principal);
    },
  },
};

const DATA_SOURCES: Record<string, (cfg: any, ctx: { auth: Auth | null; io: TfIO }) => Record<string, any>> = {
  azurerm_client_config: (_c, ctx) => {
    const s = getState();
    const p = ctx.auth?.principal;
    const sp = p?.type === 'ServicePrincipal' ? s.servicePrincipals.find((x) => x.id === p.objectId) : undefined;
    return { id: guid(), tenant_id: s.tenant.id, object_id: p?.objectId ?? '', subscription_id: ctx.auth?.subscriptionId ?? '', client_id: sp?.appId ?? '04b07795-8ddb-461a-bbee-02f9e1bf7b46' };
  },
  azurerm_subscription: (_c, ctx) => {
    const s = getState();
    const sub = s.subscriptions.find((x) => x.id === ctx.auth?.subscriptionId)!;
    return { id: `/subscriptions/${sub.id}`, subscription_id: sub.id, display_name: sub.displayName, tenant_id: sub.tenantId, state: sub.state };
  },
  azurerm_resource_group: (c, ctx) => {
    const rg = findRg(ctx.auth!.subscriptionId, c.name);
    if (!rg) throw new TfError(`Resource Group "${c.name}" was not found`, '');
    return { id: rg.id, name: rg.name, location: rg.location, tags: { ...rg.tags }, managed_by: rg.managedBy ?? '' };
  },
  azurerm_key_vault: (c, ctx) => {
    const v = findResource(buildId(ctx.auth!.subscriptionId, c.resource_group_name, 'Microsoft.KeyVault/vaults', c.name));
    if (!v) throw new TfError(`Key Vault "${c.name}" (Resource Group "${c.resource_group_name}") was not found`, '');
    return { id: v.id, name: v.name, vault_uri: v.properties.vaultUri, tenant_id: v.properties.tenantId, location: v.location };
  },
  azurerm_container_registry: (c, ctx) => {
    const r = findResource(buildId(ctx.auth!.subscriptionId, c.resource_group_name, 'Microsoft.ContainerRegistry/registries', c.name));
    if (!r) throw new TfError(`Container Registry "${c.name}" was not found`, '');
    return { id: r.id, name: r.name, login_server: r.properties.loginServer, location: r.location };
  },
  azurerm_key_vault_secret: (c) => {
    const v = findResource(c.key_vault_id);
    const sec = v?.data?.secrets?.[c.name];
    if (!sec) throw new TfError(`Secret "${c.name}" was not found`, '');
    return { id: `${v!.properties.vaultUri}secrets/${c.name}`, value: sec.versions[sec.versions.length - 1].value };
  },
};

// ---------------------------------------------------------------- evaluación de la configuración

interface PlannedValues {
  [addr: string]: Record<string, any> | Record<string, any>[];
}

function blockToObject(b: HBody, sc: EvalScope, schema?: Schema, addr?: string, file?: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, a] of Object.entries(b.attrs)) {
    if (['count', 'for_each', 'depends_on', 'lifecycle', 'provider'].includes(k)) continue;
    if (schema && ![...schema.required, ...schema.optional].includes(k)) {
      throw new TfError('Unsupported argument', `An argument named "${k}" is not expected here.`, { addr, file, line: a.line });
    }
    let v: any;
    try {
      v = evalHcl(a.expr, sc);
    } catch (e: any) {
      if (e instanceof TfError) throw e;
      throw new TfError('Invalid expression', e?.message ?? String(e), { addr, file, line: a.line });
    }
    if (v !== null && v !== undefined) out[k] = v;
  }
  for (const nb of b.blocks) {
    if (nb.type === 'lifecycle' || nb.type === 'provisioner' || nb.type === 'timeouts') continue;
    if (schema && !(schema.blocks ?? []).includes(nb.type)) throw new TfError('Unsupported block type', `Blocks of type "${nb.type}" are not expected here.`, { addr, file, line: nb.line });
    (out[nb.type] ??= []).push(blockToObject(nb.body, sc));
  }
  if (schema) {
    for (const r of schema.required) {
      if (!(r in out) && !(r in b.attrs)) throw new TfError('Missing required argument', `The argument "${r}" is required, but no definition was found.`, { addr, file, line: undefined });
    }
  }
  return out;
}

function valueStr(v: any): string {
  if (isUnknown(v)) return '(known after apply)';
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- comandos

interface Action {
  addr: string;
  type: string;
  name: string;
  index?: number;
  action: 'create' | 'update' | 'replace' | 'delete' | 'noop' | 'read';
  config?: Record<string, any>;
  prior?: Record<string, any>;
  forceReasons?: string[];
  deps: string[];
  block?: HBlock;
}

class Engine {
  cfg!: Config;
  vars: Record<string, any> = {};
  localsCache: Record<string, any> = {};
  dataVals: Record<string, any> = {};
  values: Record<string, Record<string, any> | Record<string, any>[]> = {};
  auth: Auth | null = null;
  st!: TfState;
  store!: StateStore;
  c: (code: string, s: string) => string;

  constructor(public io: TfIO) {
    this.c = (code, s) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  }

  scope(countIndex?: number): EvalScope {
    return {
      readFile: (p) => {
        const v = this.io.files.read(p.replace(/^\.\//, '').replace(/^\$\{path\.module\}\//, ''));
        if (v === undefined) throw new Error(`Invalid value for "path" parameter: no file exists at "${p}".`);
        return v;
      },
      lookup: (root, steps, line) => {
        const attr = steps[0]?.attr;
        if (root === 'var') {
          if (attr === undefined || !(attr in this.vars)) throw new TfError('Reference to undeclared input variable', `An input variable with the name "${attr}" has not been declared. This variable can be declared with a variable "${attr}" {} block.`, { line });
          return applySteps(this.vars[attr], steps.slice(1));
        }
        if (root === 'local') {
          if (attr === undefined || !this.cfg.locals.has(attr)) throw new TfError('Reference to undeclared local value', `A local value with the name "${attr}" has not been declared.`, { line });
          if (!(attr in this.localsCache)) this.localsCache[attr] = evalHcl(this.cfg.locals.get(attr)!.expr, this.scope());
          return applySteps(this.localsCache[attr], steps.slice(1));
        }
        if (root === 'count') {
          if (countIndex === undefined) throw new TfError('Reference to "count" in non-counted context', 'The "count" object can only be used in "module", "resource", and "data" blocks, and only when the "count" argument is set.', { line });
          return countIndex;
        }
        if (root === 'path') return '.';
        if (root === 'terraform') return 'default';
        if (root === 'data') {
          const key = `${steps[0]?.attr}.${steps[1]?.attr}`;
          if (!(key in this.dataVals)) {
            if (!this.cfg.data.has(key)) throw new TfError('Reference to undeclared resource', `A data resource "${steps[0]?.attr}" "${steps[1]?.attr}" has not been declared in the root module.`, { line });
            this.readData(key);
          }
          return applySteps(this.dataVals[key], steps.slice(2));
        }
        if (root === 'each') throw new TfError('Unsupported "for_each"', 'for_each todavía no está soportado por el simulador; usa count.', { line });
        const key = `${root}.${attr}`;
        if (!this.cfg.resources.has(key)) throw new TfError('Reference to undeclared resource', `A managed resource "${root}" "${attr}" has not been declared in the root module.`, { line });
        const v = this.values[key];
        if (v === undefined) return UNKNOWN;
        return applySteps(v, steps.slice(1));
      },
    };
  }

  readData(key: string) {
    const b = this.cfg.data.get(key)!;
    const fn = DATA_SOURCES[b.labels[0]];
    if (!fn) throw new TfError('Invalid data source', `The provider hashicorp/azurerm does not support data source "${b.labels[0]}" (en el simulador).`, { file: b.file, line: b.line });
    const cfg = blockToObject(b.body, this.scope());
    this.dataVals[key] = fn(cfg, { auth: this.auth, io: this.io });
  }

  loadVars(argv: string[]) {
    const provided: Record<string, any> = {};
    const tfvarsFiles = ['terraform.tfvars', ...this.io.files.list().filter((f) => f.endsWith('.auto.tfvars')).sort()];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const m = /^-var-file=(.+)$/.exec(a) ?? (a === '-var-file' ? [a, argv[++i]] : null);
      if (m) tfvarsFiles.push(m[1]);
    }
    for (const f of tfvarsFiles) {
      const src = this.io.files.read(f);
      if (src === undefined) {
        if (f !== 'terraform.tfvars') throw new TfError('Failed to read variables file', `Given variables file ${f} does not exist.`);
        continue;
      }
      const body = parseHcl(src, f);
      for (const [k, a] of Object.entries(body.attrs)) provided[k] = evalHcl(a.expr, { lookup: () => undefined });
    }
    for (const [k, v] of Object.entries(this.io.env)) if (k.startsWith('TF_VAR_')) provided[k.slice(7)] = v;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const raw = a.startsWith('-var=') ? a.slice(5) : a === '-var' ? argv[++i] : null;
      if (raw) {
        const eq = raw.indexOf('=');
        if (eq < 0) throw new TfError('Invalid -var option', `The given -var option "${raw}" is not correctly specified. Must be a variable name and value separated by an equals sign, like -var="key=value".`);
        provided[raw.slice(0, eq)] = raw.slice(eq + 1);
      }
    }
    return provided;
  }

  async resolveVars(argv: string[], interactive: boolean) {
    const provided = this.loadVars(argv);
    for (const [name, b] of this.cfg.variables) {
      let v: any;
      const type = b.body.attrs.type ? (b.body.attrs.type.expr as any).root ?? 'string' : 'string';
      if (name in provided) v = provided[name];
      else if (b.body.attrs.default) v = evalHcl(b.body.attrs.default.expr, { lookup: () => undefined });
      else if (interactive && this.io.prompt) {
        const desc = b.body.attrs.description ? evalHcl(b.body.attrs.description.expr, { lookup: () => undefined }) : '';
        v = await this.io.prompt(`var.${name}\n${desc ? `  ${desc}\n\n` : ''}  Enter a value: `);
      } else throw new TfError('No value for required variable', `The root module input variable "${name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, { file: b.file, line: b.line });
      if (type === 'number' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      if (type === 'bool' && typeof v === 'string') v = v === 'true';
      for (const vb of b.body.blocks.filter((x) => x.type === 'validation')) {
        const cond = evalHcl(vb.body.attrs.condition.expr, { lookup: (root, steps) => (root === 'var' && steps[0]?.attr === name ? applySteps(v, steps.slice(1)) : undefined) });
        if (!cond) {
          const msg = vb.body.attrs.error_message ? evalHcl(vb.body.attrs.error_message.expr, { lookup: () => undefined }) : 'Invalid value.';
          throw new TfError('Invalid value for variable', `${msg}\n\nThis was checked by the validation rule at ${vb.file}:${vb.line}.`, { file: b.file, line: b.line });
        }
      }
      this.vars[name] = v;
    }
    for (const k of Object.keys(provided)) {
      if (!this.cfg.variables.has(k) && !(k in this.io.env) && !Object.keys(this.io.env).includes('TF_VAR_' + k)) {
        this.io.out(this.c('33', `\nWarning: Value for undeclared variable\n\nThe root module does not declare a variable named "${k}" but a value was found. If you meant to use this value, add a "variable" block to the configuration.\n`));
      }
    }
  }

  resourceDeps(b: HBlock): string[] {
    const refs = bodyRefs(b.body);
    const deps = new Set<string>();
    const addFromRef = (ref: string, seen = new Set<string>()) => {
      const parts = ref.split('.');
      if (parts[0] === 'local' && parts[1] && this.cfg.locals.has(parts[1]) && !seen.has(parts[1])) {
        seen.add(parts[1]);
        const sub: string[] = [];
        collectRefs(this.cfg.locals.get(parts[1])!.expr, sub);
        sub.forEach((r) => addFromRef(r, seen));
        return;
      }
      if (parts[0] === 'data') return;
      const key = `${parts[0]}.${parts[1]}`;
      if (this.cfg.resources.has(key)) deps.add(key);
    };
    refs.forEach((r) => addFromRef(r));
    const dep = b.body.attrs.depends_on;
    if (dep && dep.expr.k === 'list') for (const it of dep.expr.items) if (it.k === 'trav') deps.add(`${it.root}.${(it.steps[0] as any)?.attr}`);
    return [...deps];
  }

  ordered(): string[] {
    const keys = [...this.cfg.resources.keys()];
    const out: string[] = [];
    const st = new Map<string, number>();
    const visit = (k: string, path: string[]) => {
      if (st.get(k) === 2) return;
      if (st.get(k) === 1) throw new TfError('Cycle', path.join(', '));
      st.set(k, 1);
      for (const d of this.resourceDeps(this.cfg.resources.get(k)!)) visit(d, [...path, d]);
      st.set(k, 2);
      out.push(k);
    };
    keys.forEach((k) => visit(k, [k]));
    return out;
  }

  ownedIds(): Set<string> {
    const set = new Set<string>();
    for (const r of this.st.resources) for (const i of r.instances) if (i.attributes?.id) set.add(String(i.attributes.id).toLowerCase());
    return set;
  }

  ctx(): ApplyCtx {
    return { auth: this.auth!, io: this.io, state: this.st, ownedIds: this.ownedIds() };
  }

  refresh() {
    for (const r of this.st.resources) {
      if (r.mode !== 'managed') continue;
      const schema = SCHEMAS[r.type];
      if (!schema) continue;
      for (const inst of r.instances) {
        const addr = `${r.type}.${r.name}${inst.index_key !== undefined ? `[${inst.index_key}]` : ''}`;
        if (r.type.startsWith('azurerm_')) this.io.out(`${addr}: Refreshing state... [id=${inst.attributes.id}]`);
        const fresh = r.type.startsWith('azurerm_') ? schema.read(inst.attributes, this.ctx()) : inst.attributes;
        if (fresh === null) (inst as any).__gone = true;
        else inst.attributes = fresh;
      }
    }
  }

  stateValue(type: string, name: string): any {
    const r = findStateRes(this.st, type, name);
    if (!r) return undefined;
    if (r.instances.some((i) => i.index_key !== undefined)) return r.instances.filter((i) => !(i as any).__gone).map((i) => i.attributes);
    const inst = r.instances[0];
    return inst && !(inst as any).__gone ? inst.attributes : undefined;
  }

  plan(destroy = false): Action[] {
    const actions: Action[] = [];
    const order = this.ordered();
    for (const key of order) {
      const [type, name] = key.split('.');
      this.values[key] = this.stateValue(type, name);
    }
    if (!destroy) {
      for (const key of order) {
        const b = this.cfg.resources.get(key)!;
        const [type, name] = key.split('.');
        const schema = SCHEMAS[type];
        if (!schema) throw new TfError('Invalid resource type', `The provider hashicorp/${type.split('_')[0]} does not support resource type "${type}" (o el simulador aún no lo implementa).`, { file: b.file, line: b.line });
        const countExpr = b.body.attrs.count;
        const count = countExpr ? Number(evalHcl(countExpr.expr, this.scope())) : undefined;
        if (count !== undefined && (isNaN(count) || isUnknown(count))) throw new TfError('Invalid count argument', 'The "count" value depends on resource attributes that cannot be determined until apply.', { file: b.file, line: countExpr!.line });
        const indices = count === undefined ? [undefined] : [...Array(count).keys()];
        const sr = findStateRes(this.st, type, name);
        const planned: Record<string, any>[] = [];
        for (const idx of indices) {
          const addr = `${key}${idx !== undefined ? `[${idx}]` : ''}`;
          const cfgObj = blockToObject(b.body, this.scope(idx), schema, addr, b.file);
          const inst = sr?.instances.find((i) => i.index_key === idx);
          const prior = inst && !(inst as any).__gone ? inst.attributes : undefined;
          const deps = this.resourceDeps(b);
          let action: Action['action'] = 'create';
          let forceReasons: string[] = [];
          if (prior) {
            const changedKeys = Object.keys(cfgObj).filter((k) => !isUnknown(cfgObj[k]) && JSON.stringify(normalize(cfgObj[k])) !== JSON.stringify(normalize(prior[k])));
            const unknownKeys = Object.keys(cfgObj).filter((k) => isUnknown(cfgObj[k]) || JSON.stringify(cfgObj[k]).includes('__unknown'));
            const all = [...changedKeys, ...unknownKeys.filter((k) => deps.some((d) => actions.some((a) => a.addr.startsWith(d) && a.action !== 'noop')))];
            if ('tags' in prior && !('tags' in cfgObj) && Object.keys(prior.tags ?? {}).length) all.push('tags');
            forceReasons = all.filter((k) => schema.forceNew.includes(k));
            action = forceReasons.length ? 'replace' : all.length ? 'update' : 'noop';
          }
          const plannedVals: Record<string, any> = action === 'noop' ? { ...prior } : { ...(action === 'update' ? prior : {}), ...cfgObj };
          if (action === 'create' || action === 'replace') for (const c of schema.computed) if (!(c in cfgObj)) plannedVals[c] = UNKNOWN;
          planned.push(plannedVals);
          actions.push({ addr, type, name, index: idx, action, config: cfgObj, prior, forceReasons, deps, block: b });
        }
        this.values[key] = count === undefined ? planned[0] : planned;
        // instancias sobrantes (count reducido)
        for (const inst of sr?.instances ?? []) {
          if (inst.index_key !== undefined && (count === undefined || inst.index_key >= count)) actions.push({ addr: `${key}[${inst.index_key}]`, type, name, index: inst.index_key, action: 'delete', prior: inst.attributes, deps: [] });
          if (inst.index_key === undefined && count !== undefined) actions.push({ addr: key, type, name, action: 'delete', prior: inst.attributes, deps: [] });
        }
      }
    }
    for (const r of this.st.resources) {
      if (r.mode !== 'managed') continue;
      const key = `${r.type}.${r.name}`;
      if (!destroy && this.cfg.resources.has(key)) continue;
      for (const inst of r.instances) {
        if ((inst as any).__gone) continue;
        actions.push({ addr: `${key}${inst.index_key !== undefined ? `[${inst.index_key}]` : ''}`, type: r.type, name: r.name, index: inst.index_key, action: 'delete', prior: inst.attributes, deps: inst.dependencies ?? [] });
      }
    }
    return actions;
  }

  renderPlan(actions: Action[]): string {
    const c = this.c;
    const lines: string[] = [];
    const real = actions.filter((a) => a.action !== 'noop');
    if (!real.length) return '';
    lines.push('');
    lines.push('Terraform used the selected providers to generate the following execution');
    lines.push('plan. Resource actions are indicated with the following symbols:');
    const used = new Set(real.map((a) => a.action));
    if (used.has('create')) lines.push(`  ${c('32', '+')} create`);
    if (used.has('update')) lines.push(`  ${c('33', '~')} update in-place`);
    if (used.has('delete')) lines.push(`  ${c('31', '-')} destroy`);
    if (used.has('replace')) lines.push(`${c('31', '-')}/${c('32', '+')} destroy and then create replacement`);
    lines.push('');
    lines.push('Terraform will perform the following actions:');
    for (const a of real) {
      const schema = SCHEMAS[a.type];
      const sens = new Set(schema?.sensitive ?? []);
      const fmt = (k: string, v: any) => (sens.has(k) ? '(sensitive value)' : valueStr(v));
      lines.push('');
      const head = { create: 'will be created', update: 'will be updated in-place', replace: 'must be replaced', delete: 'will be destroyed', noop: '', read: 'will be read during apply' }[a.action];
      lines.push(`  ${c('1', `# ${a.addr} ${head}`)}`);
      if (a.action === 'delete' && !this.cfg.resources.has(`${a.type}.${a.name}`)) lines.push(`  # (because ${a.type}.${a.name} is not in configuration)`);
      const sym = { create: c('32', '+'), update: c('33', '~'), replace: `${c('31', '-')}/${c('32', '+')}`, delete: c('31', '-'), noop: ' ', read: '<=' }[a.action];
      lines.push(`  ${sym} resource "${a.type}" "${a.name}" {`);
      let vals: Record<string, any>;
      if (a.action === 'delete') vals = a.prior ?? {};
      else {
        vals = { ...a.config };
        if (a.action === 'create' || a.action === 'replace') for (const k of schema.computed) if (!(k in vals)) vals[k] = UNKNOWN;
      }
      const keys = Object.keys(vals).filter((k) => vals[k] !== undefined && vals[k] !== null && !(typeof vals[k] === 'object' && !isUnknown(vals[k]) && !Array.isArray(vals[k]) && !Object.keys(vals[k]).length && a.action !== 'create')).sort();
      const width = Math.max(0, ...keys.filter((k) => !isBlockList(vals[k])).map((k) => k.length));
      for (const k of keys) {
        const v = vals[k];
        if (a.action === 'update') {
          const before = a.prior?.[k];
          if (JSON.stringify(normalize(before)) === JSON.stringify(normalize(v)) && !isUnknown(v)) continue;
          lines.push(`      ${c('33', '~')} ${k.padEnd(width)} = ${fmt(k, before)} ${c('33', '->')} ${fmt(k, v)}`);
          continue;
        }
        const pre = a.action === 'delete' ? c('31', '-') : c('32', '+');
        if (isBlockList(v)) {
          for (const item of v) {
            lines.push(`      ${pre} ${k} {`);
            for (const [ik, iv] of Object.entries<any>(item)) lines.push(`          ${pre} ${ik} = ${valueStr(iv)}`);
            lines.push('        }');
          }
          continue;
        }
        if (v && typeof v === 'object' && !Array.isArray(v) && !isUnknown(v)) {
          lines.push(`      ${pre} ${k.padEnd(width)} = {`);
          for (const [mk, mv] of Object.entries(v)) lines.push(`          ${pre} "${mk}" = ${valueStr(mv)}`);
          lines.push('        }');
          continue;
        }
        const force = a.action === 'replace' && a.forceReasons?.includes(k) ? c('31', ' # forces replacement') : '';
        const shown = a.action === 'delete' ? `${fmt(k, v)} -> null` : a.action === 'replace' && a.prior && a.prior[k] !== undefined && JSON.stringify(a.prior[k]) !== JSON.stringify(v) ? `${fmt(k, a.prior[k])} -> ${fmt(k, v)}` : fmt(k, v);
        lines.push(`      ${pre} ${k.padEnd(width)} = ${shown}${force}`);
      }
      lines.push('    }');
    }
    const n = (t: string) => real.filter((a) => a.action === t).length;
    lines.push('');
    lines.push(`${c('1', 'Plan:')} ${n('create') + n('replace')} to add, ${n('update')} to change, ${n('delete') + n('replace')} to destroy.`);
    return lines.join('\n');
  }

  outputChanges(): string[] {
    const out: string[] = [];
    for (const [name] of this.cfg.outputs) if (!(name in (this.st.outputs ?? {}))) out.push(`  ${this.c('32', '+')} ${name} = (known after apply)`);
    return out;
  }

  writeState() {
    this.st.serial++;
    this.st.terraform_version = TF_VERSION;
    this.store.save(this.st);
  }

  setInstance(type: string, name: string, index: number | undefined, attrs: Record<string, any> | null, deps: string[]) {
    let r = findStateRes(this.st, type, name);
    if (!r) {
      if (!attrs) return;
      r = { mode: 'managed', type, name, provider: `provider["registry.terraform.io/hashicorp/${type.split('_')[0]}"]`, instances: [] };
      this.st.resources.push(r);
    }
    r.instances = r.instances.filter((i) => i.index_key !== index);
    if (attrs) {
      const clean = JSON.parse(JSON.stringify(attrs));
      r.instances.push({ ...(index !== undefined ? { index_key: index } : {}), schema_version: 0, attributes: clean, sensitive_attributes: [], dependencies: deps });
      r.instances.sort((a, b) => (a.index_key ?? 0) - (b.index_key ?? 0));
    }
    if (!r.instances.length) this.st.resources = this.st.resources.filter((x) => x !== r);
  }

  async apply(actions: Action[]): Promise<{ added: number; changed: number; destroyed: number }> {
    const c = this.c;
    const counts = { added: 0, changed: 0, destroyed: 0 };
    const deletes = actions.filter((a) => a.action === 'delete' || a.action === 'replace');
    // destruir en orden inverso de dependencias
    const order = this.ordered();
    deletes.sort((a, b) => order.indexOf(`${b.type}.${b.name}`) - order.indexOf(`${a.type}.${a.name}`));
    for (const a of deletes) {
      const schema = SCHEMAS[a.type];
      const t0 = Date.now();
      this.io.out(`${c('1', a.addr)}: Destroying... [id=${a.prior?.id}]`);
      await schema.destroy(a.prior!, this.ctx());
      this.setInstance(a.type, a.name, a.index, null, []);
      this.writeState();
      this.io.out(`${c('1', a.addr)}: Destruction complete after ${Math.max(1, Math.round((Date.now() - t0) / 1000))}s`);
      if (a.action === 'delete') counts.destroyed++;
    }
    for (const key of order) {
      const acts = actions.filter((a) => `${a.type}.${a.name}` === key && (a.action === 'create' || a.action === 'update' || a.action === 'replace'));
      const b = this.cfg.resources.get(key);
      if (!b) continue;
      const results: Record<string, any>[] = [];
      for (const a of acts) {
        const schema = SCHEMAS[a.type];
        // reevaluar con valores reales de las dependencias ya aplicadas
        const cfgObj = blockToObject(b.body, this.scope(a.index), schema, a.addr, b.file);
        const t0 = Date.now();
        const verb = a.action === 'update' ? 'Modifying...' : 'Creating...';
        this.io.out(`${c('1', a.addr)}: ${verb}${a.action === 'update' ? ` [id=${a.prior?.id}]` : ''}`);
        let attrs: Record<string, any>;
        try {
          attrs = a.action === 'update' && schema.update ? await schema.update(cfgObj, a.prior!, this.ctx()) : await schema.create(cfgObj, this.ctx());
        } catch (e: any) {
          const detail = e instanceof TfError ? e : new TfError(`${a.action === 'update' ? 'updating' : 'creating'} ${a.addr}`, e instanceof ArmError ? `unexpected status ${e.status} with error: ${e.code}: ${e.message}` : e?.message ?? String(e));
          detail.where = { addr: a.addr, file: b.file, line: b.line, src: this.cfg.sources[b.file] };
          throw detail;
        }
        this.setInstance(a.type, a.name, a.index, attrs, a.deps);
        this.writeState();
        results.push(attrs);
        const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
        this.io.out(`${c('1', a.addr)}: ${a.action === 'update' ? 'Modifications' : 'Creation'} complete after ${secs}s [id=${attrs.id}]`);
        if (a.action === 'update') counts.changed++;
        else counts.added++;
      }
      const [type, name] = key.split('.');
      this.values[key] = this.stateValue(type, name);
    }
    return counts;
  }

  computeOutputs(): Record<string, { value: any; type: any; sensitive?: boolean }> {
    const outs: Record<string, { value: any; type: any; sensitive?: boolean }> = {};
    for (const [name, b] of this.cfg.outputs) {
      const v = b.body.attrs.value ? evalHcl(b.body.attrs.value.expr, this.scope()) : null;
      const sensitive = b.body.attrs.sensitive ? !!evalHcl(b.body.attrs.sensitive.expr, this.scope()) : false;
      outs[name] = { value: v, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : Array.isArray(v) ? ['tuple', []] : typeof v === 'object' ? ['object', {}] : 'string', ...(sensitive ? { sensitive } : {}) };
    }
    return outs;
  }

  printOutputs(outs: Record<string, any>) {
    const names = Object.keys(outs).sort();
    if (!names.length) return;
    this.io.out(`\n${this.c('32;1', 'Outputs:')}\n`);
    for (const n of names) this.io.out(`${n} = ${outs[n].sensitive ? '<sensitive>' : typeof outs[n].value === 'string' ? JSON.stringify(outs[n].value) : JSON.stringify(outs[n].value, null, 2)}`);
  }
}

function isBlockList(v: any) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && !isUnknown(x));
}

function normalize(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== null && v[k] !== undefined) o[k] = normalize(v[k]);
    return o;
  }
  return v;
}

// ---------------------------------------------------------------- salida de errores

function errorBox(e: TfError, io: TfIO): string {
  const c = (code: string, s: string) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines: string[] = [];
  lines.push(c('31', '╷'));
  lines.push(`${c('31', '│')} ${c('31;1', 'Error:')} ${c('1', e.summary)}`);
  if (e.where?.addr || e.where?.file) {
    lines.push(c('31', '│'));
    if (e.where.addr) lines.push(`${c('31', '│')}   with ${e.where.addr},`);
    if (e.where.file && e.where.line) {
      lines.push(`${c('31', '│')}   on ${e.where.file} line ${e.where.line}:`);
      const src = e.where.src ?? io.files.read(e.where.file) ?? '';
      const ln = src.split('\n')[e.where.line - 1];
      if (ln !== undefined) lines.push(`${c('31', '│')}   ${e.where.line}: ${ln}`);
    }
  }
  if (e.detail) {
    lines.push(c('31', '│'));
    for (const l of e.detail.split('\n')) lines.push(`${c('31', '│')} ${l}`);
  }
  lines.push(c('31', '╵'));
  return lines.join('\n');
}

// ---------------------------------------------------------------- punto de entrada

const HELP = `Usage: terraform [global options] <subcommand> [args]

The available commands for execution are listed below.
The primary workflow commands are given first, followed by
less common or more advanced commands.

Main commands:
  init          Prepare your working directory for other commands
  validate      Check whether the configuration is valid
  plan          Show changes required by the current configuration
  apply         Create or update infrastructure
  destroy       Destroy previously-created infrastructure

All other commands:
  fmt           Reformat your configuration in the standard style
  import        Associate existing infrastructure with a Terraform resource
  output        Show output values from your root module
  providers     Show the providers required for this configuration
  show          Show the current state or a saved plan
  state         Advanced state management (list, show, rm)
  version       Show the current Terraform version
  workspace     Workspace management`;

export async function terraformCommand(argv: string[], io: TfIO): Promise<number> {
  const cmd = argv[0];
  const args = argv.slice(1);
  const color = (code: string, s: string) => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  if (!cmd || cmd === '-help' || cmd === '--help' || cmd === 'help' || cmd === '-h') {
    io.out(HELP);
    return cmd ? 0 : 127;
  }
  if (cmd === 'version' || cmd === '-version' || cmd === '--version' || cmd === '-v') {
    io.out(`Terraform v${TF_VERSION}\non linux_amd64`);
    for (const p of ['azurerm', 'random']) if (io.files.exists(`.terraform/providers/registry.terraform.io/hashicorp/${p}`)) io.out(`+ provider registry.terraform.io/hashicorp/${p} v${PROVIDER_VERSIONS[p]}`);
    return 0;
  }
  const eng = new Engine(io);
  try {
    eng.cfg = loadConfig(io);
    const req = requiredProviders(eng.cfg);
    if (cmd === 'init') {
      io.out(color('1', 'Initializing the backend...'));
      const be = backendConfig(eng.cfg, eng.scope());
      for (let i = 0; i < args.length; i++) {
        const raw = args[i] === '-backend-config' ? args[++i] : args[i].startsWith('-backend-config=') ? args[i].slice(16) : null;
        if (raw === null || raw === undefined) continue;
        if (!be) throw new TfError('Invalid backend configuration argument', 'The -backend-config option is only valid when a backend block is declared in the configuration (p. ej. terraform { backend "azurerm" {} }).');
        const eq = raw.indexOf('=');
        if (eq > 0) be.attrs[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim().replace(/^"|"$/g, '');
      }
      if (be && be.type === 'azurerm') {
        const principal = io.cliPrincipal;
        try {
          const acct = findAccount(be.attrs.storage_account_name);
          if (!acct.data?.containers?.[be.attrs.container_name]) {
            throw new TfError('Failed to get existing workspaces: containers.Client#ListBlobs', `Failure responding to request: StatusCode=404 -- Original Error: autorest/azure: Service returned an error. Status=404 Code="ContainerNotFound" Message="The specified container does not exist."`);
          }
          if (!io.env.ARM_ACCESS_KEY) authorize(principal, 'Microsoft.Storage/storageAccounts/listkeys/action', acct.id);
        } catch (e: any) {
          if (e instanceof TfError) throw e;
          throw new TfError('Failed to get existing workspaces', `${e?.code ?? ''}: ${e?.message ?? e}`);
        }
        io.out(color('32', `\nSuccessfully configured the backend "azurerm"! Terraform will automatically\nuse this backend unless the backend configuration changes.`));
      }
      io.out(color('1', 'Initializing provider plugins...'));
      for (const [name, info] of Object.entries(req)) {
        const ver = PROVIDER_VERSIONS[name];
        if (!ver) throw new TfError('Failed to query available provider packages', `Could not retrieve the list of available versions for provider ${info.source}: provider registry registry.terraform.io does not have a provider named registry.terraform.io/${info.source} (en el simulador sólo están disponibles: azurerm, random).`);
        if (io.files.exists(`.terraform/providers/registry.terraform.io/hashicorp/${name}`)) io.out(`- Reusing previous version of ${info.source} from the dependency lock file`);
        else {
          io.out(`- Finding ${info.source} versions matching "${info.version ?? '*'}"...`);
          io.out(`- Installing ${info.source} v${ver}...`);
          io.out(`- Installed ${info.source} v${ver} (signed by HashiCorp)`);
        }
        io.files.mkdir(`.terraform/providers/registry.terraform.io/hashicorp/${name}`);
      }
      const lock = Object.entries(req)
        .map(([n, i]) => `provider "registry.terraform.io/${i.source}" {\n  version     = "${PROVIDER_VERSIONS[n]}"\n  constraints = "${i.version ?? '>= 0.0.0'}"\n  hashes = [\n    "h1:${btoa(n + PROVIDER_VERSIONS[n]).slice(0, 43)}=",\n  ]\n}\n`)
        .join('\n');
      const hadLock = io.files.exists('.terraform.lock.hcl');
      io.files.write('.terraform.lock.hcl', `# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\n${lock}`);
      if (be) io.files.write('.terraform/terraform.tfstate', JSON.stringify({ version: 3, backend: { type: be.type, config: be.attrs } }, null, 2));
      if (!hadLock) io.out(`Terraform has created a lock file ${color('1', '.terraform.lock.hcl')} to record the provider\nselections it made above. Include this file in your version control repository\nso that Terraform can guarantee to make the same selections by default when\nyou run "terraform init" in the future.`);
      io.out(color('32;1', '\nTerraform has been successfully initialized!'));
      io.out(color('32', `\nYou may now begin working with Terraform. Try running "terraform plan" to see\nany changes that are required for your infrastructure. All Terraform commands\nshould now work.\n\nIf you ever set or change modules or backend configuration for Terraform,\nrerun this command to reinitialize your working directory. If you forget, other\ncommands will detect it and remind you to do so if necessary.`));
      return 0;
    }
    if (cmd === 'fmt') return 0;
    if (cmd === 'workspace') {
      io.out(args[0] === 'list' ? '* default' : 'default');
      return 0;
    }
    if (cmd === 'providers') {
      io.out('\nProviders required by configuration:\n.');
      for (const [n, i] of Object.entries(req)) io.out(`├── provider[registry.terraform.io/${i.source}] ${i.version ?? ''}`);
      return 0;
    }
    for (const name of Object.keys(req)) {
      if (!io.files.exists(`.terraform/providers/registry.terraform.io/hashicorp/${name}`)) {
        throw new TfError('Inconsistent dependency lock file', `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n  - provider registry.terraform.io/hashicorp/${name}: required by this configuration but no version is selected\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init`);
      }
    }
    const interactive = !args.includes('-input=false');
    if (cmd === 'validate') {
      await eng.resolveVars([], false).catch(() => undefined);
      for (const [key, b] of eng.cfg.resources) {
        const schema = SCHEMAS[b.labels[0]];
        if (!schema) throw new TfError('Invalid resource type', `The provider hashicorp/${b.labels[0].split('_')[0]} does not support resource type "${b.labels[0]}".`, { file: b.file, line: b.line });
        for (const k of Object.keys(b.body.attrs)) if (!['count', 'for_each', 'depends_on', 'provider'].includes(k) && ![...schema.required, ...schema.optional].includes(k)) throw new TfError('Unsupported argument', `An argument named "${k}" is not expected here.`, { addr: key, file: b.file, line: b.body.attrs[k].line });
        for (const r of schema.required) if (!b.body.attrs[r]) throw new TfError('Missing required argument', `The argument "${r}" is required, but no definition was found.`, { addr: key, file: b.file, line: b.line });
      }
      if ([...eng.cfg.resources.keys()].some((k) => k.startsWith('azurerm_')) && !eng.cfg.providers.some((p) => p.labels[0] === 'azurerm' && p.body.blocks.some((x) => x.type === 'features'))) {
        throw new TfError('Missing required argument', 'The argument "features" is required, but no definition was found.');
      }
      io.out(color('32;1', 'Success!') + ' The configuration is valid.');
      return 0;
    }
    await eng.resolveVars(args, interactive);
    eng.auth = providerAuth(eng.cfg, io, eng.scope(), false);
    eng.store = stateStore(eng.cfg, io, eng.auth);
    eng.st = eng.store.load();
    if (cmd === 'output') {
      const raw = args.includes('-raw');
      const json = args.includes('-json');
      const name = args.find((a) => !a.startsWith('-'));
      const outs = eng.st.outputs ?? {};
      if (name) {
        if (!(name in outs)) throw new TfError('Output not found', `The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run \`terraform apply\`, since the state won't be updated with new output variables until that command is run.`);
        const v = outs[name].value;
        io.out(raw ? String(v) : json ? JSON.stringify(v) : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, null, 2));
        return 0;
      }
      if (json) io.out(JSON.stringify(outs, null, 2));
      else if (!Object.keys(outs).length) io.out(color('33', '╷\n│ Warning: No outputs found\n│ \n│ The state file either has no outputs defined, or all the defined outputs\n│ are empty. Please define an output in your configuration with the `output`\n│ keyword and run `terraform refresh` for it to become available. If you are\n│ using interpolation, please verify the interpolated value is not empty. You\n│ can use the `terraform console` command to assist.\n╵'));
      else for (const [k, o] of Object.entries(outs).sort()) io.out(`${k} = ${o.sensitive ? '<sensitive>' : JSON.stringify(o.value)}`);
      return 0;
    }
    if (cmd === 'state') {
      const sub = args[0];
      if (sub === 'list') {
        for (const r of eng.st.resources) for (const i of r.instances) io.out(`${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${i.index_key !== undefined ? `[${i.index_key}]` : ''}`);
        return 0;
      }
      if (sub === 'show') {
        const addr = args[1];
        const m = /^([\w]+)\.([\w-]+)(?:\[(\d+)\])?$/.exec(addr ?? '');
        const r = m ? findStateRes(eng.st, m[1], m[2]) : undefined;
        const inst = r?.instances.find((i) => (m?.[3] === undefined ? i.index_key === undefined : i.index_key === Number(m[3])));
        if (!inst) throw new TfError('No instance found for the given address!', 'This command requires that the address references one specific instance. To view the available instances, use "terraform state list".');
        io.out(`# ${addr}:\nresource "${m![1]}" "${m![2]}" {`);
        const sens = new Set(SCHEMAS[m![1]]?.sensitive ?? []);
        const keys = Object.keys(inst.attributes).sort();
        const w = Math.max(...keys.map((k) => k.length));
        for (const k of keys) io.out(`    ${k.padEnd(w)} = ${sens.has(k) ? '(sensitive value)' : JSON.stringify(inst.attributes[k])}`);
        io.out('}');
        return 0;
      }
      if (sub === 'rm') {
        const addr = args[1];
        const m = /^([\w]+)\.([\w-]+)/.exec(addr ?? '');
        const r = m ? findStateRes(eng.st, m[1], m[2]) : undefined;
        if (!r) throw new TfError('Invalid target address', `No matching objects found. To view the available instances, use "terraform state list".`);
        eng.st.resources = eng.st.resources.filter((x) => x !== r);
        eng.writeState();
        io.out(`Removed ${addr}\nSuccessfully removed 1 resource instance(s).`);
        return 0;
      }
      io.out('Usage: terraform [global options] state <subcommand> [options] [args]\n\nSubcommands: list, show, rm');
      return 1;
    }
    if (cmd === 'show') {
      if (!eng.st.resources.length) {
        io.out('The state file is empty. No resources are represented.');
        return 0;
      }
      for (const r of eng.st.resources) {
        for (const i of r.instances) {
          io.out(`# ${r.type}.${r.name}${i.index_key !== undefined ? `[${i.index_key}]` : ''}:\nresource "${r.type}" "${r.name}" {`);
          const sens = new Set(SCHEMAS[r.type]?.sensitive ?? []);
          for (const k of Object.keys(i.attributes).sort()) io.out(`    ${k} = ${sens.has(k) ? '(sensitive value)' : JSON.stringify(i.attributes[k])}`);
          io.out('}\n');
        }
      }
      return 0;
    }
    if (cmd === 'import') {
      const pos = args.filter((a) => !a.startsWith('-'));
      const [addr, id] = pos;
      const m = /^([\w]+)\.([\w-]+)$/.exec(addr ?? '');
      if (!m || !id) throw new TfError('Invalid arguments', 'Usage: terraform import [options] ADDR ID');
      if (!eng.cfg.resources.has(addr)) throw new TfError('resource address "' + addr + '" does not exist in the configuration.', `Before importing this resource, please create its configuration in the root module. For example:\n\nresource "${m[1]}" "${m[2]}" {\n  # (resource arguments)\n}`);
      if (findStateRes(eng.st, m[1], m[2])) throw new TfError('Resource already managed by Terraform', `Terraform is already managing a remote object for ${addr}. To import to this address you must first remove the existing object from the state.`);
      io.out(`${addr}: Importing from ID "${id}"...`);
      const schema = SCHEMAS[m[1]];
      const b = eng.cfg.resources.get(addr)!;
      eng.plan();
      const cfgObj = blockToObject(b.body, eng.scope(), schema, addr, b.file);
      let attrs: Record<string, any> | null;
      if (m[1] === 'azurerm_resource_group') {
        const rg = getState().resourceGroups.find((g) => ciEq(g.id, id));
        attrs = rg ? { ...cfgObj, id: rg.id, name: rg.name, location: rg.location, tags: { ...rg.tags } } : null;
      } else {
        const res = findResource(id);
        attrs = res ? schema.read({ ...cfgObj, id: res.id, tags: { ...res.tags }, location: res.location }, eng.ctx()) : null;
      }
      if (!attrs) throw new TfError('Cannot import non-existent remote object', `While attempting to import an existing object to "${addr}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`);
      eng.setInstance(m[1], m[2], undefined, attrs, []);
      eng.writeState();
      io.out(`${addr}: Import prepared!\n  Prepared ${m[1]} for import\n${addr}: Refreshing state... [id=${id}]\n`);
      io.out(color('32;1', 'Import successful!') + '\n\nThe resources that were imported are shown above. These resources are now in\nyour Terraform state and will henceforth be managed by Terraform.');
      return 0;
    }
    if (cmd === 'plan' || cmd === 'apply' || cmd === 'destroy' || cmd === 'refresh') {
      const destroy = cmd === 'destroy' || args.includes('-destroy');
      if (eng.st.resources.length) eng.refresh();
      if (cmd === 'refresh') {
        eng.st.outputs = eng.computeOutputs();
        eng.writeState();
        eng.printOutputs(eng.st.outputs);
        return 0;
      }
      const actions = eng.plan(destroy);
      for (const [key] of eng.cfg.data) if (!(key in eng.dataVals)) eng.readData(key);
      const text = eng.renderPlan(actions);
      const real = actions.filter((a) => a.action !== 'noop');
      if (!real.length) {
        const outs = destroy ? {} : eng.computeOutputs();
        const outChanged = JSON.stringify(outs) !== JSON.stringify(eng.st.outputs ?? {});
        io.out(color('32;1', '\nNo changes.') + color('1', destroy ? ' No objects need to be destroyed.' : ' Your infrastructure matches the configuration.'));
        io.out(destroy ? '\nEither you have not created any objects yet or the existing objects were\nalready deleted outside of Terraform.' : '\nTerraform has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.');
        if (cmd !== 'plan' && outChanged) {
          eng.st.outputs = outs;
          eng.writeState();
          eng.printOutputs(outs);
        }
        if (cmd === 'apply') io.out(color('32;1', '\nApply complete! Resources: 0 added, 0 changed, 0 destroyed.'));
        if (cmd === 'destroy') io.out(color('32;1', '\nDestroy complete! Resources: 0 destroyed.'));
        return 0;
      }
      io.out(text);
      if (!destroy) {
        const oc = eng.outputChanges();
        if (oc.length) io.out(`\nChanges to Outputs:\n${oc.join('\n')}`);
      }
      if (cmd === 'plan') {
        const outFile = args.find((a) => a.startsWith('-out='))?.slice(5) ?? (args.includes('-out') ? args[args.indexOf('-out') + 1] : undefined);
        if (outFile) {
          io.files.write(outFile, JSON.stringify({ format_version: '1.2', planned: real.map((a) => ({ addr: a.addr, action: a.action })), serial: eng.st.serial }));
          io.out(`\n─────────────────────────────────────────────────────────────────────────────\n\nSaved the plan to: ${outFile}\n\nTo perform exactly these actions, run the following command to apply:\n    terraform apply "${outFile}"`);
        } else io.out(`\n─────────────────────────────────────────────────────────────────────────────\n\nNote: You didn't use the -out option to save this plan, so Terraform can't\nguarantee to take exactly these actions if you run "terraform apply" now.`);
        return 0;
      }
      const planFile = args.find((a) => !a.startsWith('-') && io.files.exists(a));
      const auto = args.includes('-auto-approve') || !!planFile;
      if (!auto) {
        if (!io.prompt) throw new TfError('No value for required input', 'Apply needs confirmation. Use -auto-approve in non-interactive mode.');
        const q = destroy
          ? `\n${color('1', 'Do you really want to destroy all resources?')}\n  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only 'yes' will be accepted to confirm.\n\n  ${color('1', 'Enter a value:')} `
          : `\n${color('1', 'Do you want to perform these actions?')}\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  ${color('1', 'Enter a value:')} `;
        const answer = (await io.prompt(q)).trim();
        if (answer !== 'yes') {
          io.out(`\n${destroy ? 'Destroy' : 'Apply'} cancelled.`);
          return 1;
        }
      }
      io.out('');
      if (!eng.auth && real.some((a) => a.type.startsWith('azurerm_'))) eng.auth = providerAuth(eng.cfg, io, eng.scope(), true);
      const counts = await eng.apply(real);
      eng.st.outputs = destroy ? {} : eng.computeOutputs();
      eng.writeState();
      if (destroy) io.out(color('32;1', `\nDestroy complete! Resources: ${counts.destroyed} destroyed.`));
      else {
        io.out(color('32;1', `\nApply complete! Resources: ${counts.added} added, ${counts.changed} changed, ${counts.destroyed} destroyed.`));
        eng.printOutputs(eng.st.outputs);
      }
      return 0;
    }
    io.err(`Terraform has no command named "${cmd}".\n\nTo see all of Terraform's top-level commands, run:\n  terraform -help`);
    return 1;
  } catch (e: any) {
    if (e instanceof TfError) {
      io.err(errorBox(e, io));
      return 1;
    }
    if (e instanceof ArmError) {
      io.err(errorBox(new TfError(e.code, e.message), io));
      return 1;
    }
    io.err(errorBox(new TfError('Unexpected error', e?.message ?? String(e)), io));
    return 1;
  }
}

export function terraformSupportedTypes(): string[] {
  return Object.keys(SCHEMAS);
}

void resourceToArm;
