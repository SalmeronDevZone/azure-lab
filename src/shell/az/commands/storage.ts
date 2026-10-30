// az storage account / container / blob / share / file / queue / message.
import { register, group, A, cliError, type Args, type AzCtx, type AzArg } from '../framework';
import { getState, changed } from '../../../engine/store';
import { ArmError } from '../../../engine/errors';
import { deleteResource, putResource, findResource } from '../../../engine/arm';
import { GLOBALLY_TAKEN } from '../../../engine/catalog';
import { ciEq, guid, isValidIp, nowIso } from '../../../engine/util';
import { flat, getRes, listInSub, op, requireRg } from '../helpers';
import {
  blobJson, checkBlobAccess, connectionString, containerJson, containersOf, createContainer, createQueue, createShare, deleteBlob, deleteContainer,
  downloadBlob, enableStaticWebsite, findAccount, generateSas, getContainer, listBlobs, listKeys, parseConnectionString, putQueueMessage, renewKey,
  setBlobTier, setContainerPublicAccess, uploadBlob, type StorageAuth,
} from '../../../engine/services/storage';
import { globToRegex } from '../../interp';

const T_ST = 'Microsoft.Storage/storageAccounts';

group('storage', 'Administra recursos de Azure Cloud Storage.');
group('storage account', 'Administra cuentas de almacenamiento.');
group('storage account keys', 'Administra las claves de acceso de la cuenta.');
group('storage account network-rule', 'Administra las reglas de red (firewall) de la cuenta.');
group('storage container', 'Administra contenedores de blobs.');
group('storage blob', 'Administra blobs (objetos).');
group('storage blob service-properties', 'Propiedades del servicio de blobs (sitio web estático).');
group('storage share', 'Administra recursos compartidos de archivos.');
group('storage file', 'Administra archivos en recursos compartidos.');
group('storage queue', 'Administra colas.');
group('storage message', 'Administra mensajes de las colas.');

const stTable = (r: any) => (Array.isArray(r) ? r : [r]).map((s: any) => ({ Name: s.name, ResourceGroup: s.resourceGroup, Location: s.location, Kind: s.kind, Sku: s.sku?.name, AccessTier: s.accessTier ?? '', ProvisioningState: s.provisioningState }));

register({
  path: 'storage account create',
  summary: 'Crea una cuenta de almacenamiento.',
  args: [
    A.name('Nombre de la cuenta: 3-24 caracteres, minúsculas y números, único en todo Azure.'),
    A.rg(),
    A.location(),
    A.sku('Redundancia y rendimiento.', ['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS', 'Standard_GZRS', 'Standard_RAGZRS', 'Premium_LRS', 'Premium_ZRS'], 'Standard_RAGRS'),
    { name: 'kind', opts: ['--kind'], help: 'Tipo de cuenta.', choices: ['StorageV2', 'Storage', 'BlobStorage', 'BlockBlobStorage', 'FileStorage'], default: 'StorageV2' },
    { name: 'access_tier', opts: ['--access-tier'], help: 'Nivel de acceso predeterminado de los blobs.', choices: ['Hot', 'Cool', 'Cold', 'Premium'] },
    { name: 'https_only', opts: ['--https-only'], help: 'Sólo permite HTTPS.', type: 'bool' },
    { name: 'min_tls_version', opts: ['--min-tls-version'], help: 'Versión mínima de TLS.', choices: ['TLS1_0', 'TLS1_1', 'TLS1_2', 'TLS1_3'] },
    { name: 'allow_blob_public_access', opts: ['--allow-blob-public-access'], help: 'Permite contenedores con acceso anónimo.', type: 'bool' },
    { name: 'allow_shared_key_access', opts: ['--allow-shared-key-access'], help: 'Permite el acceso con clave compartida.', type: 'bool' },
    { name: 'public_network_access', opts: ['--public-network-access'], help: 'Acceso desde redes públicas.', choices: ['Enabled', 'Disabled'] },
    { name: 'default_action', opts: ['--default-action'], help: 'Acción predeterminada del firewall.', choices: ['Allow', 'Deny'] },
    { name: 'hns', opts: ['--hns', '--enable-hierarchical-namespace'], help: 'Habilita el espacio de nombres jerárquico (Data Lake Gen2).', type: 'bool' },
    A.tags(),
  ],
  examples: [{ title: 'Cuenta LRS de uso general v2.', cmd: 'az storage account create -n stlab$RANDOM -g rg-lab -l westeurope --sku Standard_LRS' }],
  table: stTable,
  longRunning: true,
  async run(a, ctx) {
    const rg = requireRg(ctx, a.resource_group);
    const r = await putResource(
      {
        type: T_ST,
        name: a.name,
        location: a.location,
        tags: a.tags,
        sku: { name: a.sku },
        kind: a.kind,
        properties: {
          accessTier: a.access_tier === 'Premium' ? undefined : a.access_tier,
          supportsHttpsTrafficOnly: a.https_only,
          minimumTlsVersion: a.min_tls_version,
          allowBlobPublicAccess: a.allow_blob_public_access,
          allowSharedKeyAccess: a.allow_shared_key_access,
          publicNetworkAccess: a.public_network_access,
          isHnsEnabled: a.hns,
          networkAcls: a.default_action ? { defaultAction: a.default_action } : undefined,
        },
      },
      rg.name,
      op(ctx),
    );
    return flat(r);
  },
});

register({
  path: 'storage account list',
  summary: 'Lista las cuentas de almacenamiento.',
  args: [A.rg(false)],
  table: stTable,
  run: (a, ctx) => listInSub(ctx, T_ST, a.resource_group).map((r) => flat(r)),
});

register({
  path: 'storage account show',
  summary: 'Muestra una cuenta de almacenamiento.',
  args: [A.name('Nombre de la cuenta.', false), A.rg(false), A.ids()],
  table: stTable,
  run(a, ctx) {
    if (!a.resource_group && a.name && !a.ids?.length) {
      const r = getState().resources.find((x) => ciEq(x.type, T_ST) && ciEq(x.name, a.name) && x.subscriptionId === ctx.subscriptionId);
      if (r) return flat(r);
    }
    return flat(getRes(ctx, a, T_ST));
  },
});

register({
  path: 'storage account check-name',
  summary: 'Comprueba si un nombre de cuenta está disponible.',
  args: [A.name('Nombre a comprobar.')],
  run(a) {
    if (!/^[a-z0-9]{3,24}$/.test(a.name)) return { message: `${a.name} is not a valid storage account name. Storage account name must be between 3 and 24 characters in length and use numbers and lower-case letters only.`, nameAvailable: false, reason: 'AccountNameInvalid' };
    const taken = GLOBALLY_TAKEN.has(a.name) || getState().resources.some((r) => ciEq(r.type, T_ST) && ciEq(r.name, a.name));
    return taken ? { message: `The storage account named ${a.name} is already taken.`, nameAvailable: false, reason: 'AlreadyExists' } : { message: null, nameAvailable: true, reason: null };
  },
});

register({
  path: 'storage account update',
  summary: 'Actualiza la configuración de una cuenta de almacenamiento.',
  args: [
    A.name('Nombre de la cuenta.', false),
    A.rg(false),
    A.ids(),
    { name: 'sku', opts: ['--sku'], help: 'Nuevo SKU (cambiar de/a ZRS o Premium no es posible).' },
    { name: 'access_tier', opts: ['--access-tier'], help: 'Nivel de acceso.', choices: ['Hot', 'Cool', 'Cold'] },
    { name: 'https_only', opts: ['--https-only'], help: 'Sólo HTTPS.', type: 'bool' },
    { name: 'min_tls_version', opts: ['--min-tls-version'], help: 'TLS mínimo.', choices: ['TLS1_0', 'TLS1_1', 'TLS1_2', 'TLS1_3'] },
    { name: 'allow_blob_public_access', opts: ['--allow-blob-public-access'], help: 'Acceso anónimo a blobs.', type: 'bool' },
    { name: 'allow_shared_key_access', opts: ['--allow-shared-key-access'], help: 'Acceso con clave compartida.', type: 'bool' },
    { name: 'public_network_access', opts: ['--public-network-access'], help: 'Acceso de red pública.', choices: ['Enabled', 'Disabled'] },
    { name: 'default_action', opts: ['--default-action'], help: 'Acción predeterminada del firewall.', choices: ['Allow', 'Deny'] },
    A.tags(),
  ],
  table: stTable,
  async run(a, ctx) {
    const st = getRes(ctx, a, T_ST);
    const p = st.properties;
    const r = await putResource(
      {
        type: T_ST,
        name: st.name,
        location: st.location,
        tags: a.tags ?? st.tags,
        sku: a.sku ? { name: a.sku } : st.sku,
        kind: st.kind,
        properties: {
          ...p,
          accessTier: a.access_tier ?? p.accessTier,
          supportsHttpsTrafficOnly: a.https_only ?? p.supportsHttpsTrafficOnly,
          minimumTlsVersion: a.min_tls_version ?? p.minimumTlsVersion,
          allowBlobPublicAccess: a.allow_blob_public_access ?? p.allowBlobPublicAccess,
          allowSharedKeyAccess: a.allow_shared_key_access ?? p.allowSharedKeyAccess,
          publicNetworkAccess: a.public_network_access ?? p.publicNetworkAccess,
          networkRuleSet: { ...p.networkRuleSet, defaultAction: a.default_action ?? p.networkRuleSet?.defaultAction },
        },
      },
      st.resourceGroup,
      op(ctx),
    );
    return flat(r);
  },
});

register({
  path: 'storage account delete',
  summary: 'Elimina una cuenta de almacenamiento (y todos sus datos).',
  args: [A.name('Nombre de la cuenta.', false), A.rg(false), A.ids(), A.yes()],
  confirm: 'The storage account will be permanently deleted. Are you sure you want to perform this operation?',
  async run(a, ctx) {
    await deleteResource(getRes(ctx, a, T_ST).id, op(ctx));
    return undefined;
  },
});

register({
  path: 'storage account keys list',
  summary: 'Lista las claves de acceso de la cuenta.',
  args: [{ name: 'account_name', opts: ['--account-name', '-n'], help: 'Nombre de la cuenta.', required: true }, A.rg(false)],
  table: (r: any[]) => r.map((k) => ({ CreationTime: k.creationTime, KeyName: k.keyName, Permissions: k.permissions, Value: k.value })),
  run(a, ctx) {
    return listKeys(findAccount(a.account_name), ctx.principal);
  },
});

register({
  path: 'storage account keys renew',
  summary: 'Regenera una clave de acceso (invalida las SAS firmadas con ella).',
  args: [{ name: 'account_name', opts: ['--account-name', '-n'], help: 'Nombre de la cuenta.', required: true }, A.rg(false), { name: 'key', opts: ['--key'], help: 'Clave a regenerar.', choices: ['primary', 'secondary'], required: true }],
  run(a, ctx) {
    return renewKey(findAccount(a.account_name), a.key, ctx.principal);
  },
});

register({
  path: 'storage account show-connection-string',
  summary: 'Obtiene la cadena de conexión de la cuenta.',
  args: [{ name: 'name', opts: ['--name', '-n'], help: 'Nombre de la cuenta.', required: true }, A.rg(false)],
  run(a, ctx) {
    return { connectionString: connectionString(findAccount(a.name), ctx.principal) };
  },
});

register({
  path: 'storage account generate-sas',
  summary: 'Genera una firma de acceso compartido (SAS) de cuenta.',
  args: [{ name: 'account_name', opts: ['--account-name'], help: 'Nombre de la cuenta.', required: true }, { name: 'permissions', opts: ['--permissions'], help: 'Permisos: (a)dd (c)reate (d)elete (l)ist (r)ead (w)rite...', required: true }, { name: 'expiry', opts: ['--expiry'], help: 'Fecha de caducidad UTC (Y-m-d\'T\'H:M\'Z\').', required: true }, { name: 'services', opts: ['--services'], help: 'Servicios: (b)lob (f)ile (q)ueue (t)able.', default: 'b' }, { name: 'resource_types', opts: ['--resource-types'], help: 'Tipos: (s)ervice (c)ontainer (o)bject.', default: 'sco' }, { name: 'https_only', opts: ['--https-only'], help: 'Sólo HTTPS.', type: 'bool' }, { name: 'account_key', opts: ['--account-key'], help: 'Clave de la cuenta.' }],
  run(a, ctx) {
    const acct = findAccount(a.account_name);
    if (!a.account_key) listKeys(acct, ctx.principal);
    return generateSas(acct, { permissions: a.permissions, expiry: a.expiry, services: a.services, resourceTypes: a.resource_types, httpsOnly: a.https_only !== false });
  },
});

register({
  path: 'storage account network-rule add',
  summary: 'Añade una regla de red (IP o rango permitido) al firewall de la cuenta.',
  args: [{ name: 'account_name', opts: ['--account-name', '-n'], help: 'Nombre de la cuenta.', required: true }, A.rg(), { name: 'ip_address', opts: ['--ip-address'], help: 'IP o rango CIDR a permitir.' }, { name: 'subnet', opts: ['--subnet'], help: 'ID de subred (requiere punto de conexión de servicio).' }],
  run(a, ctx) {
    const acct = findAccount(a.account_name);
    if (a.ip_address && !isValidIp(a.ip_address) && !/\/\d+$/.test(a.ip_address)) throw cliError(`'${a.ip_address}' no es una IP o rango válido.`);
    const rules = acct.properties.networkRuleSet;
    if (a.ip_address) rules.ipRules = [...(rules.ipRules ?? []).filter((r: any) => r.value !== a.ip_address), { value: a.ip_address, action: 'Allow' }];
    if (a.subnet) rules.virtualNetworkRules = [...(rules.virtualNetworkRules ?? []), { id: a.subnet, action: 'Allow', state: 'Succeeded' }];
    changed();
    return rules;
  },
});

register({
  path: 'storage account network-rule list',
  summary: 'Lista las reglas de red de la cuenta.',
  args: [{ name: 'account_name', opts: ['--account-name', '-n'], help: 'Nombre de la cuenta.', required: true }, A.rg(false)],
  run(a) {
    const r = findAccount(a.account_name).properties.networkRuleSet;
    return { ipRules: r.ipRules ?? [], virtualNetworkRules: r.virtualNetworkRules ?? [] };
  },
});

register({
  path: 'storage account network-rule remove',
  summary: 'Quita una regla de red.',
  args: [{ name: 'account_name', opts: ['--account-name', '-n'], help: 'Nombre de la cuenta.', required: true }, A.rg(), { name: 'ip_address', opts: ['--ip-address'], help: 'IP o rango.' }],
  run(a) {
    const acct = findAccount(a.account_name);
    acct.properties.networkRuleSet.ipRules = (acct.properties.networkRuleSet.ipRules ?? []).filter((r: any) => r.value !== a.ip_address);
    changed();
    return acct.properties.networkRuleSet;
  },
});

// ---------------------------------------------------------------- autenticación de plano de datos

const authArgs: AzArg[] = [
  { name: 'account_name', opts: ['--account-name'], help: 'Nombre de la cuenta. Variable de entorno: AZURE_STORAGE_ACCOUNT.' },
  { name: 'account_key', opts: ['--account-key'], help: 'Clave de la cuenta. Variable: AZURE_STORAGE_KEY.' },
  { name: 'connection_string', opts: ['--connection-string'], help: 'Cadena de conexión. Variable: AZURE_STORAGE_CONNECTION_STRING.' },
  { name: 'sas_token', opts: ['--sas-token'], help: 'Token SAS. Variable: AZURE_STORAGE_SAS_TOKEN.' },
  { name: 'auth_mode', opts: ['--auth-mode'], help: 'Modo de autenticación: "key" (consulta la clave de la cuenta) o "login" (usa tu identidad de Entra ID y requiere un rol de datos).', choices: ['key', 'login'] },
];

function storageAuth(a: Args, ctx: AzCtx): { account: string; auth: StorageAuth } {
  const env = ctx.sess.env;
  const cs = a.connection_string ?? env.AZURE_STORAGE_CONNECTION_STRING;
  if (cs) {
    const p = parseConnectionString(cs);
    if (!p.account) throw cliError('Connection string is invalid or missing AccountName.');
    return { account: p.account, auth: { mode: 'key', explicitKey: p.key } };
  }
  const account = a.account_name ?? env.AZURE_STORAGE_ACCOUNT;
  if (!account) throw cliError('Missing credentials to access storage service. The following variations are accepted:\n    (1) account name and key (--account-name and --account-key options or\n        set AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY environment variables)\n    (2) account name and SAS token (--sas-token option used with either the --account-name\n        option or AZURE_STORAGE_ACCOUNT environment variable)\n    (3) account name (--account-name option or AZURE_STORAGE_ACCOUNT environment variable;\n        this will make calls to query for a storage account key using login credentials)\n    (4) connection string (--connection-string option or\n        set AZURE_STORAGE_CONNECTION_STRING environment variable); some shells will require\n        quoting to preserve literal character interpretation.', undefined, true);
  const key = a.account_key ?? env.AZURE_STORAGE_KEY;
  if (key) return { account, auth: { mode: 'key', explicitKey: key } };
  const sas = a.sas_token ?? env.AZURE_STORAGE_SAS_TOKEN;
  if (sas) return { account, auth: { mode: 'sas', token: sas } };
  const mode = a.auth_mode ?? env.AZURE_STORAGE_AUTH_MODE;
  if (mode === 'login') return { account, auth: { mode: 'login' } };
  if (!mode) {
    ctx.warn('\nThere are no credentials provided in your command and environment, we will query for account key for your storage account.\nIt is recommended to provide --connection-string, --account-key or --sas-token in your command as credentials.\n\nYou also can add `--auth-mode login` in your command to use Azure Active Directory (Azure AD) for authorization if your login account is assigned required RBAC roles.\nFor more information about RBAC roles in storage, visit https://learn.microsoft.com/azure/storage/common/storage-auth-aad-rbac-cli.\n\nIn addition, setting the corresponding environment variables can avoid inputting credentials in your command. Please use --help to get more information about environment variable usage.');
  }
  return { account, auth: { mode: 'key' } };
}

// ---------------------------------------------------------------- contenedores

register({
  path: 'storage container create',
  summary: 'Crea un contenedor en una cuenta de almacenamiento.',
  args: [A.name('Nombre del contenedor (3-63 caracteres, minúsculas, números y guiones).'), { name: 'public_access', opts: ['--public-access'], help: 'Nivel de acceso anónimo.', choices: ['off', 'blob', 'container'], default: 'off' }, ...authArgs, { name: 'fail_on_exist', opts: ['--fail-on-exist'], help: 'Falla si ya existe.', type: 'bool' }, { name: 'metadata', opts: ['--metadata'], help: 'Metadatos clave=valor.', type: 'kv' }],
  examples: [{ title: 'Crear un contenedor privado usando tu identidad.', cmd: 'az storage container create -n imagenes --account-name stlab123 --auth-mode login' }],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const r = createContainer(account, a.name, a.public_access, auth, ctx.principal);
    if (!r.created && a.fail_on_exist) throw new ArmError('ContainerAlreadyExists', 'The specified container already exists.', 409);
    if (a.metadata) containersOf(findAccount(account))[a.name].metadata = a.metadata;
    return r;
  },
});

register({
  path: 'storage container list',
  summary: 'Lista los contenedores de una cuenta.',
  args: [...authArgs, { name: 'prefix', opts: ['--prefix'], help: 'Filtra por prefijo.' }],
  table: (r: any[]) => r.map((c) => ({ Name: c.name, 'Lease Status': c.properties.lease.status, 'Last Modified': c.properties.lastModified })),
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    checkBlobAccess(acct, auth, 'list', ctx.principal);
    return Object.values(containersOf(acct)).filter((c) => !a.prefix || c.name.startsWith(a.prefix)).map(containerJson);
  },
});

register({
  path: 'storage container show',
  summary: 'Muestra un contenedor.',
  args: [A.name('Nombre del contenedor.'), ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    checkBlobAccess(acct, auth, 'read', ctx.principal, a.name);
    return containerJson(getContainer(acct, a.name));
  },
});

register({
  path: 'storage container exists',
  summary: 'Comprueba si existe un contenedor.',
  args: [A.name('Nombre del contenedor.'), ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    checkBlobAccess(acct, auth, 'read', ctx.principal, a.name);
    return { exists: !!containersOf(acct)[a.name] };
  },
});

register({
  path: 'storage container delete',
  summary: 'Elimina un contenedor y todos sus blobs.',
  args: [A.name('Nombre del contenedor.'), ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    return deleteContainer(account, a.name, auth, ctx.principal);
  },
});

register({
  path: 'storage container set-permission',
  summary: 'Cambia el nivel de acceso anónimo de un contenedor.',
  args: [A.name('Nombre del contenedor.'), { name: 'public_access', opts: ['--public-access'], help: 'Nivel de acceso.', choices: ['off', 'blob', 'container'], required: true }, ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const c = setContainerPublicAccess(account, a.name, a.public_access, auth, ctx.principal);
    return { etag: c.etag, lastModified: c.lastModified };
  },
});

register({
  path: 'storage container generate-sas',
  summary: 'Genera una SAS para un contenedor.',
  args: [A.name('Nombre del contenedor.'), { name: 'permissions', opts: ['--permissions'], help: 'Permisos: (r)ead (w)rite (d)elete (l)ist (a)dd (c)reate.', required: true }, { name: 'expiry', opts: ['--expiry'], help: 'Caducidad UTC.', required: true }, { name: 'https_only', opts: ['--https-only'], help: 'Sólo HTTPS.', type: 'bool' }, ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    if (auth.mode === 'key' && !auth.explicitKey) listKeys(acct, ctx.principal);
    getContainer(acct, a.name);
    return generateSas(acct, { permissions: a.permissions, expiry: a.expiry, container: a.name, httpsOnly: a.https_only !== false });
  },
});

// ---------------------------------------------------------------- blobs

const blobTable = (r: any) => (Array.isArray(r) ? r : [r]).map((b: any) => ({ Name: b.name, 'Blob Type': b.properties.blobType, 'Blob Tier': b.properties.blobTier, Length: b.properties.contentLength, 'Content Type': b.properties.contentSettings.contentType, 'Last Modified': b.properties.lastModified, Snapshot: '' }));
const containerArg: AzArg = { name: 'container_name', opts: ['--container-name', '-c'], help: 'Nombre del contenedor.', required: true };

register({
  path: 'storage blob upload',
  summary: 'Sube un fichero (o texto) a un blob.',
  args: [{ name: 'file', opts: ['--file', '-f'], help: 'Ruta del fichero local.' }, { name: 'data', opts: ['--data'], help: 'Contenido en texto (alternativa a --file).' }, containerArg, { name: 'name', opts: ['--name', '-n'], help: 'Nombre del blob (por defecto, el del fichero).' }, { name: 'overwrite', opts: ['--overwrite'], help: 'Sobrescribe si ya existe.', type: 'bool' }, { name: 'content_type', opts: ['--content-type'], help: 'Tipo MIME.' }, { name: 'tier', opts: ['--tier'], help: 'Nivel de acceso.', choices: ['Hot', 'Cool', 'Cold', 'Archive'] }, ...authArgs],
  examples: [{ title: 'Subir un fichero con tu identidad (requiere Storage Blob Data Contributor).', cmd: 'az storage blob upload --account-name stlab123 -c imagenes -n logo.txt -f ./logo.txt --auth-mode login' }],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    let content: string;
    let name = a.name;
    if (a.data !== undefined) {
      content = a.data;
      if (!name) throw cliError('usage error: --name is required when using --data', undefined, true);
    } else {
      if (!a.file) throw cliError('usage error: --file | --data', undefined, true);
      try {
        content = ctx.sess.fs.readFile(ctx.sess.resolve(a.file));
      } catch {
        throw cliError(`[Errno 2] No such file or directory: '${a.file}'`);
      }
      name = name ?? String(a.file).split('/').pop();
    }
    return uploadBlob(account, a.container_name, name, content, { auth, principal: ctx.principal, overwrite: a.overwrite, contentType: a.content_type, tier: a.tier });
  },
});

register({
  path: 'storage blob upload-batch',
  summary: 'Sube los ficheros de un directorio local a un contenedor.',
  args: [{ name: 'destination', opts: ['--destination', '-d'], help: 'Contenedor de destino (p. ej. $web).', required: true }, { name: 'source', opts: ['--source', '-s'], help: 'Directorio local de origen.', required: true }, { name: 'pattern', opts: ['--pattern'], help: 'Patrón de ficheros, p. ej. *.html.' }, { name: 'destination_path', opts: ['--destination-path'], help: 'Prefijo de destino.' }, { name: 'overwrite', opts: ['--overwrite'], help: 'Sobrescribe.', type: 'bool' }, ...authArgs],
  examples: [{ title: 'Publicar una web estática.', cmd: "az storage blob upload-batch --account-name stlab123 -s ~/samples/web-estatica -d '$web'" }],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const abs = ctx.sess.resolve(a.source);
    if (!ctx.sess.fs.isDir(abs)) throw cliError(`incorrect usage: source must be an existing directory`);
    const files = ctx.sess.fs.snapshot(abs);
    const re = a.pattern ? globToRegex(a.pattern) : null;
    const out: any[] = [];
    let n = 0;
    for (const [rel, content] of Object.entries(files)) {
      if (re && !re.test(rel) && !re.test(rel.split('/').pop()!)) continue;
      const name = a.destination_path ? `${String(a.destination_path).replace(/\/$/, '')}/${rel}` : rel;
      const r = uploadBlob(account, a.destination, name, content, { auth, principal: ctx.principal, overwrite: a.overwrite ?? true });
      out.push({ Blob: `https://${account}.blob.core.windows.net/${a.destination}/${name}`, Last_Modified: r.lastModified, Type: undefined, eTag: r.etag });
      n++;
    }
    ctx.io.err(`Finished[#############################################################]  100.0000%\n`);
    void n;
    return out;
  },
});

register({
  path: 'storage blob list',
  summary: 'Lista los blobs de un contenedor.',
  args: [containerArg, { name: 'prefix', opts: ['--prefix'], help: 'Filtra por prefijo.' }, { name: 'num_results', opts: ['--num-results'], help: 'Número máximo de resultados.' }, ...authArgs],
  table: blobTable,
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const list = listBlobs(account, a.container_name, auth, ctx.principal, a.prefix);
    return a.num_results && a.num_results !== '*' ? list.slice(0, Number(a.num_results)) : list;
  },
});

register({
  path: 'storage blob show',
  summary: 'Muestra las propiedades de un blob.',
  args: [containerArg, A.name('Nombre del blob.'), ...authArgs],
  table: blobTable,
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    checkBlobAccess(acct, auth, 'read', ctx.principal, a.container_name);
    const b = getContainer(acct, a.container_name).blobs[a.name];
    if (!b) throw new ArmError('BlobNotFound', 'The specified blob does not exist.', 404);
    return blobJson(a.container_name, a.name, b);
  },
});

register({
  path: 'storage blob exists',
  summary: 'Comprueba si existe un blob.',
  args: [containerArg, A.name('Nombre del blob.'), ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    checkBlobAccess(acct, auth, 'read', ctx.principal, a.container_name);
    return { exists: !!containersOf(acct)[a.container_name]?.blobs[a.name] };
  },
});

register({
  path: 'storage blob download',
  summary: 'Descarga un blob a un fichero local.',
  args: [containerArg, A.name('Nombre del blob.'), { name: 'file', opts: ['--file', '-f'], help: 'Fichero de destino.' }, { name: 'overwrite', opts: ['--overwrite'], help: 'Sobrescribe.', type: 'bool' }, ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const b = downloadBlob(account, a.container_name, a.name, auth, ctx.principal);
    const target = ctx.sess.resolve(a.file ?? a.name.split('/').pop()!);
    if (ctx.sess.fs.exists(target) && a.overwrite === false) throw cliError(`The specified path already exists: ${target}`);
    ctx.sess.fs.writeFile(target, b.content);
    return blobJson(a.container_name, a.name, b);
  },
});

register({
  path: 'storage blob download-batch',
  summary: 'Descarga los blobs de un contenedor a un directorio.',
  args: [{ name: 'source', opts: ['--source', '-s'], help: 'Contenedor.', required: true }, { name: 'destination', opts: ['--destination', '-d'], help: 'Directorio local.', required: true }, { name: 'pattern', opts: ['--pattern'], help: 'Patrón.' }, ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    checkBlobAccess(acct, auth, 'list', ctx.principal, a.source);
    const c = getContainer(acct, a.source);
    const re = a.pattern ? globToRegex(a.pattern) : null;
    const out: string[] = [];
    for (const name of Object.keys(c.blobs)) {
      if (re && !re.test(name)) continue;
      const b = downloadBlob(account, a.source, name, auth, ctx.principal);
      const target = ctx.sess.resolve(`${a.destination}/${name}`);
      ctx.sess.fs.mkdir(target.split('/').slice(0, -1).join('/'), true);
      ctx.sess.fs.writeFile(target, b.content);
      out.push(name);
    }
    return out;
  },
});

register({
  path: 'storage blob delete',
  summary: 'Elimina un blob.',
  args: [containerArg, A.name('Nombre del blob.'), ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    deleteBlob(account, a.container_name, a.name, auth, ctx.principal);
    return undefined;
  },
});

register({
  path: 'storage blob delete-batch',
  summary: 'Elimina blobs de un contenedor (opcionalmente por patrón).',
  args: [{ name: 'source', opts: ['--source', '-s'], help: 'Contenedor.', required: true }, { name: 'pattern', opts: ['--pattern'], help: 'Patrón.' }, ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    const c = getContainer(acct, a.source);
    const re = a.pattern ? globToRegex(a.pattern) : null;
    for (const name of Object.keys(c.blobs)) if (!re || re.test(name)) deleteBlob(account, a.source, name, auth, ctx.principal);
    return undefined;
  },
});

register({
  path: 'storage blob set-tier',
  summary: 'Cambia el nivel de acceso de un blob (Hot, Cool, Cold, Archive).',
  args: [containerArg, A.name('Nombre del blob.'), { name: 'tier', opts: ['--tier'], help: 'Nivel.', required: true, choices: ['Hot', 'Cool', 'Cold', 'Archive'] }, { name: 'type', opts: ['--type', '-t'], help: 'Tipo de blob.', default: 'block' }, ...authArgs],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    setBlobTier(account, a.container_name, a.name, a.tier, auth, ctx.principal);
    return undefined;
  },
});

register({
  path: 'storage blob url',
  summary: 'Genera la URL de un blob.',
  args: [containerArg, A.name('Nombre del blob.'), { name: 'account_name', opts: ['--account-name'], help: 'Cuenta.' }, { name: 'sas_token', opts: ['--sas-token'], help: 'SAS a añadir.' }, { name: 'protocol', opts: ['--protocol'], help: 'Protocolo.', choices: ['http', 'https'], default: 'https' }],
  run(a, ctx) {
    const acct = a.account_name ?? ctx.sess.env.AZURE_STORAGE_ACCOUNT;
    if (!acct) throw cliError('the following arguments are required: --account-name', undefined, true);
    return `${a.protocol}://${acct}.blob.core.windows.net/${a.container_name}/${a.name}${a.sas_token ? '?' + String(a.sas_token).replace(/^\?/, '') : ''}`;
  },
});

register({
  path: 'storage blob generate-sas',
  summary: 'Genera una SAS para un blob.',
  args: [containerArg, A.name('Nombre del blob.'), { name: 'permissions', opts: ['--permissions'], help: 'Permisos: (r)ead (w)rite (d)elete...', required: true }, { name: 'expiry', opts: ['--expiry'], help: 'Caducidad UTC, p. ej. 2026-12-31T23:59Z.', required: true }, { name: 'full_uri', opts: ['--full-uri'], help: 'Devuelve la URL completa con la SAS.', type: 'bool' }, { name: 'https_only', opts: ['--https-only'], help: 'Sólo HTTPS.', type: 'bool' }, ...authArgs],
  examples: [{ title: 'URL de lectura válida hasta fin de año.', cmd: 'az storage blob generate-sas --account-name stlab123 -c docs -n informe.pdf --permissions r --expiry 2026-12-31T23:59Z --full-uri -o tsv' }],
  run(a, ctx) {
    const { account, auth } = storageAuth(a, ctx);
    const acct = findAccount(account);
    if (auth.mode === 'login') throw cliError('SAS de delegación de usuario: añade --as-user y un rol de datos. En el simulador usa la clave de cuenta (--auth-mode key).');
    if (auth.mode === 'key' && !auth.explicitKey) listKeys(acct, ctx.principal);
    const c = getContainer(acct, a.container_name);
    if (!c.blobs[a.name]) ctx.warn('El blob todavía no existe; la SAS será válida cuando se cree.');
    const token = generateSas(acct, { permissions: a.permissions, expiry: a.expiry, container: a.container_name, blob: a.name, httpsOnly: a.https_only !== false });
    return a.full_uri ? `https://${account}.blob.core.windows.net/${a.container_name}/${a.name}?${token}` : token;
  },
});

register({
  path: 'storage blob service-properties update',
  summary: 'Actualiza las propiedades del servicio de blobs (sitio web estático).',
  args: [{ name: 'account_name', opts: ['--account-name'], help: 'Cuenta.', required: true }, { name: 'static_website', opts: ['--static-website'], help: 'Habilita el sitio web estático.', type: 'bool' }, { name: 'index_document', opts: ['--index-document'], help: 'Documento de índice.', default: 'index.html' }, { name: 'error_404', opts: ['--404-document'], help: 'Documento de error 404.' }, { name: 'auth_mode', opts: ['--auth-mode'], help: 'Modo de autenticación.', choices: ['key', 'login'] }],
  examples: [{ title: 'Habilitar sitio web estático.', cmd: 'az storage blob service-properties update --account-name stlab123 --static-website --index-document index.html --404-document 404.html' }],
  run(a, ctx) {
    const sw = enableStaticWebsite(a.account_name, a.index_document, a.error_404, ctx.principal, a.static_website !== false);
    return { cors: [], deleteRetentionPolicy: { enabled: false }, hourMetrics: { enabled: true }, logging: { delete: false, read: false, write: false }, minuteMetrics: { enabled: false }, staticWebsite: { defaultIndexDocumentPath: null, enabled: sw.enabled, errorDocument404Path: sw.errorDocument404Path, indexDocument: sw.indexDocument } };
  },
});

register({
  path: 'storage blob service-properties show',
  summary: 'Muestra las propiedades del servicio de blobs.',
  args: [{ name: 'account_name', opts: ['--account-name'], help: 'Cuenta.', required: true }, { name: 'auth_mode', opts: ['--auth-mode'], help: 'Modo.', choices: ['key', 'login'] }],
  run(a) {
    const sw = findAccount(a.account_name).data?.staticWebsite ?? {};
    return { staticWebsite: { enabled: !!sw.enabled, indexDocument: sw.indexDocument ?? null, errorDocument404Path: sw.errorDocument404Path ?? null } };
  },
});

// ---------------------------------------------------------------- archivos y colas

register({
  path: 'storage share create',
  summary: 'Crea un recurso compartido de archivos (SMB).',
  args: [A.name('Nombre del recurso compartido.'), { name: 'quota', opts: ['--quota', '-q'], help: 'Cuota en GiB.', type: 'int', default: 5120 }, ...authArgs],
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    return createShare(account, a.name, a.quota, ctx.principal);
  },
});

register({
  path: 'storage share list',
  summary: 'Lista los recursos compartidos.',
  args: authArgs,
  table: (r: any[]) => r.map((s) => ({ Name: s.name, Quota: s.properties.quota })),
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    return Object.values<any>(findAccount(account).data?.shares ?? {}).map((s) => ({ name: s.name, properties: { quota: s.quota, lastModified: s.lastModified } }));
  },
});

register({
  path: 'storage file upload',
  summary: 'Sube un fichero a un recurso compartido.',
  args: [{ name: 'share_name', opts: ['--share-name', '-s'], help: 'Recurso compartido.', required: true }, { name: 'source', opts: ['--source'], help: 'Fichero local.', required: true }, { name: 'path', opts: ['--path', '-p'], help: 'Ruta en el recurso compartido.' }, ...authArgs],
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    const acct = findAccount(account);
    const share = acct.data?.shares?.[a.share_name];
    if (!share) throw new ArmError('ShareNotFound', 'The specified share does not exist.', 404);
    const content = ctx.sess.fs.readFile(ctx.sess.resolve(a.source));
    const path = a.path ?? String(a.source).split('/').pop();
    share.files[path] = { content, size: content.length, lastModified: nowIso() };
    changed();
    return { content_md5: null, etag: `"0x${guid().slice(0, 12)}"`, last_modified: nowIso() };
  },
});

register({
  path: 'storage file list',
  summary: 'Lista los ficheros de un recurso compartido.',
  args: [{ name: 'share_name', opts: ['--share-name', '-s'], help: 'Recurso compartido.', required: true }, ...authArgs],
  table: (r: any[]) => r.map((f) => ({ Name: f.name, 'Content Length': f.properties.contentLength, Type: f.type })),
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    const share = findAccount(account).data?.shares?.[a.share_name];
    if (!share) throw new ArmError('ShareNotFound', 'The specified share does not exist.', 404);
    return Object.entries<any>(share.files).map(([name, f]) => ({ name, properties: { contentLength: f.size }, type: 'file' }));
  },
});

register({
  path: 'storage queue create',
  summary: 'Crea una cola.',
  args: [A.name('Nombre de la cola.'), ...authArgs],
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    return createQueue(account, a.name, ctx.principal);
  },
});

register({
  path: 'storage queue list',
  summary: 'Lista las colas.',
  args: authArgs,
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    return Object.keys(findAccount(account).data?.queues ?? {}).map((name) => ({ approximateMessageCount: null, metadata: null, name }));
  },
});

register({
  path: 'storage message put',
  summary: 'Añade un mensaje a una cola.',
  args: [{ name: 'queue_name', opts: ['--queue-name', '-q'], help: 'Cola.', required: true }, { name: 'content', opts: ['--content'], help: 'Contenido del mensaje.', required: true }, ...authArgs],
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    return putQueueMessage(account, a.queue_name, a.content, ctx.principal);
  },
});

register({
  path: 'storage message peek',
  summary: 'Consulta mensajes de una cola sin retirarlos.',
  args: [{ name: 'queue_name', opts: ['--queue-name', '-q'], help: 'Cola.', required: true }, { name: 'num_messages', opts: ['--num-messages'], help: 'Número de mensajes.', type: 'int', default: 1 }, ...authArgs],
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    const q = findAccount(account).data?.queues?.[a.queue_name];
    if (!q) throw new ArmError('QueueNotFound', 'The specified queue does not exist.', 404);
    return q.messages.slice(0, a.num_messages);
  },
});

register({
  path: 'storage message get',
  summary: 'Obtiene (y oculta temporalmente) mensajes de una cola.',
  args: [{ name: 'queue_name', opts: ['--queue-name', '-q'], help: 'Cola.', required: true }, ...authArgs],
  run(a, ctx) {
    const { account } = storageAuth(a, ctx);
    const q = findAccount(account).data?.queues?.[a.queue_name];
    if (!q) throw new ArmError('QueueNotFound', 'The specified queue does not exist.', 404);
    const m = q.messages.shift();
    changed();
    return m ? [{ ...m, dequeueCount: (m.dequeueCount ?? 0) + 1 }] : [];
  },
});

export function _storageUnused() {
  return findResource;
}
