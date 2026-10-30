// Microsoft.Sql: servidores lógicos, bases de datos y reglas de firewall.
import { registerProvider, baseResource } from '../registry';
import { ArmError } from '../errors';
import { SQL_OBJECTIVES } from '../catalog';
import { ciEq, guid, isValidIp, ipToInt, nowIso } from '../util';
import type { Resource } from '../types';

const T_SERVER = 'Microsoft.Sql/servers';
const T_DB = 'Microsoft.Sql/servers/databases';
const T_FW = 'Microsoft.Sql/servers/firewallRules';

const RESERVED_LOGINS = ['admin', 'administrator', 'sa', 'root', 'dbmanager', 'loginmanager', 'dbo', 'guest', 'public', 'sysadmin'];

export function sqlPasswordOk(pw: string, login: string): boolean {
  if (!pw || pw.length < 8 || pw.length > 128) return false;
  if (login && pw.toLowerCase().includes(login.toLowerCase())) return false;
  let n = 0;
  if (/[A-Z]/.test(pw)) n++;
  if (/[a-z]/.test(pw)) n++;
  if (/\d/.test(pw)) n++;
  if (/[^A-Za-z0-9]/.test(pw)) n++;
  return n >= 3;
}

export function databasesOf(server: Resource, resources: Resource[]): Resource[] {
  return resources.filter((r) => ciEq(r.type, T_DB) && r.id.toLowerCase().startsWith(server.id.toLowerCase() + '/databases/'));
}

export function firewallRulesOf(server: Resource, resources: Resource[]): Resource[] {
  return resources.filter((r) => ciEq(r.type, T_FW) && r.id.toLowerCase().startsWith(server.id.toLowerCase() + '/firewallrules/'));
}

export function sqlFirewallAllows(server: Resource, ip: string, resources: Resource[], fromAzure = false): boolean {
  if (server.properties.publicNetworkAccess === 'Disabled') return false;
  const n = ipToInt(ip);
  return firewallRulesOf(server, resources).some((r) => {
    const a = r.properties.startIpAddress;
    const b = r.properties.endIpAddress;
    if (a === '0.0.0.0' && b === '0.0.0.0') return fromAzure;
    return n >= ipToInt(a) && n <= ipToInt(b);
  });
}

registerProvider({
  type: T_SERVER,
  label: 'Servidor SQL',
  labelPlural: 'Servidores SQL',
  icon: 'sqlserver',
  category: 'Bases de datos',
  description: 'Servidor lógico que agrupa bases de datos de Azure SQL Database.',
  provisionMs: 3500,
  global: { code: 'NameAlreadyExists', message: (n) => `The name '${n}.database.windows.net' already exists. Choose a different name.` },
  nameRule: {
    test: (n) => /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/.test(n),
    message: "Invalid value given for parameter ServerName. Specify a valid parameter value: '{name}' (sólo minúsculas, números y guiones; 1-63 caracteres; no puede empezar ni terminar con guion).",
  },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const login = p.administratorLogin ?? ex?.properties.administratorLogin;
    const r = baseResource(input, ctx);
    if (!ex) {
      if (!login) throw new ArmError('InvalidParameterValue', "Invalid value given for parameter Login. Specify a valid parameter value.");
      if (RESERVED_LOGINS.includes(String(login).toLowerCase()) || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(login)) {
        throw new ArmError(
          'InvalidLoginName',
          `Login '${login}' is not allowed. The login name you have entered is not allowed. Login name cannot be any of the reserved names (admin, administrator, sa, root, dbmanager, loginmanager, dbo, guest, public) and must start with a letter.`,
          400,
          'Usa un nombre como "sqladmin" o "adminlab".',
        );
      }
      const pw = p.administratorLoginPassword;
      if (!sqlPasswordOk(pw, login)) {
        throw new ArmError(
          'PasswordNotComplex',
          'Password validation failed. The password does not meet policy requirements because it is not complex enough.',
          400,
          'La contraseña debe tener 8-128 caracteres, incluir 3 de estas 4 categorías (mayúsculas, minúsculas, números, símbolos) y no contener el nombre de inicio de sesión.',
        );
      }
      r.data = { ...(r.data ?? {}), adminPassword: pw };
    } else if (p.administratorLoginPassword) {
      if (!sqlPasswordOk(p.administratorLoginPassword, login)) throw new ArmError('PasswordNotComplex', 'Password validation failed. The password does not meet policy requirements because it is not complex enough.');
      r.data = { ...(r.data ?? {}), adminPassword: p.administratorLoginPassword };
    }
    r.kind = 'v12.0';
    r.properties = {
      administratorLogin: login,
      version: '12.0',
      state: 'Ready',
      fullyQualifiedDomainName: `${input.name}.database.windows.net`,
      publicNetworkAccess: p.publicNetworkAccess ?? ex?.properties.publicNetworkAccess ?? 'Enabled',
      minimalTlsVersion: p.minimalTlsVersion ?? ex?.properties.minimalTlsVersion ?? '1.2',
      restrictOutboundNetworkAccess: 'Disabled',
      administrators: p.administrators ?? ex?.properties.administrators ?? null,
    };
    return r;
  },
  essentials(res, s) {
    return [
      ['Nombre del servidor', res.properties.fullyQualifiedDomainName],
      ['Inicio de sesión de administrador', res.properties.administratorLogin],
      ['Bases de datos', String(databasesOf(res, s.resources).length)],
      ['Acceso de red pública', res.properties.publicNetworkAccess === 'Enabled' ? 'Habilitado' : 'Deshabilitado'],
      ['Reglas de firewall', String(firewallRulesOf(res, s.resources).length)],
    ];
  },
  monthlyCost: () => 0,
});

registerProvider({
  type: T_DB,
  label: 'Base de datos SQL',
  labelPlural: 'Bases de datos SQL',
  icon: 'sqldb',
  category: 'Bases de datos',
  description: 'Base de datos relacional totalmente administrada (PaaS).',
  provisionMs: 3000,
  parentType: T_SERVER,
  nameRule: { test: (n) => /^[^<>*%&:\\/?]{1,128}$/.test(n) && !/[. ]$/.test(n) && !['master', 'tempdb', 'model', 'msdb'].includes(n.toLowerCase()), message: "The database name '{name}' is not valid or is reserved." },
  build(input, ctx) {
    const ex = ctx.existing;
    const p = input.properties ?? {};
    const serverId = ctx.id.split('/databases/')[0];
    const server = ctx.state.resources.find((r) => ciEq(r.id, serverId))!;
    if (!ciEq(server.location, input.location)) {
      throw new ArmError('InvalidParameterValue', `The database location '${input.location}' must match the server location '${server.location}'.`);
    }
    const objective = input.sku?.name ?? p.requestedServiceObjectiveName ?? ex?.sku?.name ?? 'GP_S_Gen5_2';
    const info = SQL_OBJECTIVES[objective];
    if (!info) {
      throw new ArmError('InvalidParameterValue', `The service objective '${objective}' specified is invalid. Valid values: ${Object.keys(SQL_OBJECTIVES).join(', ')}.`);
    }
    const r = baseResource(input, ctx);
    r.sku = { name: objective, tier: info.tier, family: info.family, capacity: info.capacity };
    r.kind = info.tier === 'GeneralPurpose' && objective.includes('_S_') ? 'v12.0,user,vcore,serverless' : 'v12.0,user';
    r.managedBy = undefined;
    r.properties = {
      collation: p.collation ?? ex?.properties.collation ?? 'SQL_Latin1_General_CP1_CI_AS',
      maxSizeBytes: Number(p.maxSizeBytes ?? info.maxSizeGB * 1024 ** 3),
      status: 'Online',
      databaseId: ex?.properties.databaseId ?? guid(),
      creationDate: ex?.properties.creationDate ?? nowIso(),
      currentServiceObjectiveName: objective,
      requestedServiceObjectiveName: objective,
      defaultSecondaryLocation: 'northeurope',
      catalogCollation: 'SQL_Latin1_General_CP1_CI_AS',
      zoneRedundant: p.zoneRedundant ?? false,
      readScale: 'Disabled',
      currentSku: { name: objective, tier: info.tier, capacity: info.capacity },
      autoPauseDelay: objective.includes('_S_') ? p.autoPauseDelay ?? 60 : undefined,
      minCapacity: objective.includes('_S_') ? 0.5 : undefined,
      requestedBackupStorageRedundancy: p.requestedBackupStorageRedundancy ?? 'Geo',
      isLedgerOn: false,
    };
    r.data = { ...(r.data ?? {}), tables: r.data?.tables ?? {} };
    return r;
  },
  status: () => 'En línea',
  essentials(res) {
    const info = SQL_OBJECTIVES[res.sku?.name ?? ''];
    return [
      ['Estado', 'En línea'],
      ['Servidor', res.id.split('/databases/')[0].split('/').pop()!],
      ['Plan de tarifa', info?.label ?? res.sku?.name ?? ''],
      ['Tamaño máximo', `${Math.round((res.properties.maxSizeBytes ?? 0) / 1024 ** 3)} GB`],
      ['Intercalación', res.properties.collation],
      ['Cadena de conexión', 'Ver "Cadenas de conexión" en el menú'],
    ];
  },
  monthlyCost(res) {
    return SQL_OBJECTIVES[res.sku?.name ?? '']?.monthly ?? 0;
  },
});

registerProvider({
  type: T_FW,
  label: 'Regla de firewall de SQL',
  labelPlural: 'Reglas de firewall de SQL',
  icon: 'sqlserver',
  category: 'Bases de datos',
  provisionMs: 600,
  hidden: true,
  parentType: T_SERVER,
  build(input, ctx) {
    const p = input.properties ?? {};
    const a = p.startIpAddress;
    const b = p.endIpAddress ?? a;
    if (!isValidIp(a) || !isValidIp(b)) throw new ArmError('InvalidParameterValue', `Invalid value given for parameter StartIpAddress/EndIpAddress. Specify a valid IP address.`);
    if (ipToInt(a) > ipToInt(b)) throw new ArmError('FirewallRuleNotIPv4Address', `The start IP address ${a} must be less than or equal to the end IP address ${b}.`);
    const r = baseResource(input, ctx);
    r.properties = { startIpAddress: a, endIpAddress: b };
    return r;
  },
});

export { T_SERVER, T_DB, T_FW };
