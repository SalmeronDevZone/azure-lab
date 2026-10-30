// Conexiones a Azure SQL Database y un mini motor SQL en memoria para los laboratorios.
import type { Resource } from '../types';
import { getState, changed } from '../store';
import { ArmError } from '../errors';
import { recordEvent } from '../arm';
import { ciEq } from '../util';
import { databasesOf, sqlFirewallAllows } from '../providers/sql';
import { CLOUD_SHELL_IP } from '../providers/network';

export interface SqlConnection {
  server: Resource;
  db: Resource | null;
  user: string;
}

export function findServerByFqdn(host: string): Resource | undefined {
  const h = host.toLowerCase().replace(/^tcp:/, '').split(',')[0];
  return getState().resources.find((r) => ciEq(r.type, 'Microsoft.Sql/servers') && (ciEq(r.properties.fullyQualifiedDomainName, h) || ciEq(r.name, h)));
}

export function connect(host: string, database: string | undefined, user: string, password: string, fromIp = CLOUD_SHELL_IP, fromAzure = false): SqlConnection {
  const s = getState();
  const server = findServerByFqdn(host);
  if (!server) {
    throw new ArmError('SqlConnectionFailed', `Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login timeout expired.\nSqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : A network-related or instance-specific error has occurred while establishing a connection to SQL Server. Server is not found or not accessible.`, 404);
  }
  if (!sqlFirewallAllows(server, fromIp, s.resources, fromAzure)) {
    recordEvent({ kind: 'sqlConn', resourceId: server.id, status: 40615, detail: 'firewall' });
    throw new ArmError(
      '40615',
      `Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Cannot open server '${server.name}' requested by the login. Client with IP address '${fromIp}' is not allowed to access the server.  To enable access, use the Azure Management Portal or run sp_set_firewall_rule on the master database to create a firewall rule for this IP address or address range.  It may take up to five minutes for this change to take effect..`,
      403,
      `Crea una regla de firewall: az sql server firewall-rule create -g ${server.resourceGroup} -s ${server.name} -n cloudshell --start-ip-address ${fromIp} --end-ip-address ${fromIp}`,
    );
  }
  const okUser = ciEq(user, server.properties.administratorLogin) || ciEq(user, `${server.properties.administratorLogin}@${server.name}`);
  if (!okUser || password !== server.data?.adminPassword) {
    recordEvent({ kind: 'sqlConn', resourceId: server.id, status: 18456, detail: 'login' });
    throw new ArmError('18456', `Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user '${user}'..`, 401);
  }
  let db: Resource | null = null;
  if (database && !ciEq(database, 'master')) {
    db = databasesOf(server, s.resources).find((d) => ciEq(d.name.split('/')[1], database)) ?? null;
    if (!db) throw new ArmError('4060', `Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Cannot open database "${database}" requested by the login. The login failed..`, 404);
  }
  recordEvent({ kind: 'sqlConn', resourceId: db?.id ?? server.id, status: 0, detail: 'ok' });
  return { server, db, user };
}

interface Table {
  columns: { name: string; type: string }[];
  rows: any[][];
}

function tables(conn: SqlConnection): Record<string, Table> {
  if (!conn.db) return {};
  conn.db.data = conn.db.data ?? {};
  conn.db.data.tables = conn.db.data.tables ?? {};
  return conn.db.data.tables;
}

function splitValues(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && s[i + 1] === "'" && q) {
      cur += "'";
      i++;
      continue;
    }
    if (c === "'") {
      q = !q;
      cur += c;
      continue;
    }
    if (c === ',' && !q) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function lit(v: string): any {
  const t = v.trim();
  if (/^N?'.*'$/s.test(t)) return t.replace(/^N?'/, '').replace(/'$/, '').replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^null$/i.test(t)) return null;
  if (/^getdate\(\)$/i.test(t)) return new Date().toISOString().replace('T', ' ').slice(0, 23);
  return t;
}

export interface SqlResult {
  columns: string[];
  rows: any[][];
  message?: string;
}

/** Ejecuta un lote T-SQL muy simplificado. */
export function execSql(conn: SqlConnection, sql: string): SqlResult[] {
  const results: SqlResult[] = [];
  const stmts = sql.split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)|\n\s*GO\s*(?:\n|$)/i).map((x) => x.trim()).filter(Boolean);
  for (const st of stmts) results.push(execOne(conn, st));
  changed();
  return results;
}

function execOne(conn: SqlConnection, st: string): SqlResult {
  const tbls = tables(conn);
  const dbName = conn.db ? conn.db.name.split('/')[1] : 'master';
  let m: RegExpExecArray | null;
  if (/^select\s+@@version\s*$/i.test(st)) return { columns: [''], rows: [['Microsoft SQL Azure (RTM) - 12.0.2000.8 \n\tSep 18 2026 12:18:42 \n\tCopyright (C) 2022 Microsoft Corporation\n']] };
  if (/^select\s+db_name\(\)\s*$/i.test(st)) return { columns: [''], rows: [[dbName]] };
  if (/^select\s+getdate\(\)\s*$/i.test(st)) return { columns: [''], rows: [[new Date().toISOString().replace('T', ' ').slice(0, 23)]] };
  if ((m = /^select\s+(-?\d+)\s*(?:as\s+(\w+))?$/i.exec(st))) return { columns: [m[2] ?? ''], rows: [[Number(m[1])]] };
  if ((m = /^select\s+'(.*)'\s*(?:as\s+(\w+))?$/i.exec(st))) return { columns: [m[2] ?? ''], rows: [[m[1]]] };
  if (/^select\s+name\s+from\s+sys\.databases/i.test(st)) {
    return { columns: ['name'], rows: [['master'], ...databasesOf(conn.server, getState().resources).map((d) => [d.name.split('/')[1]])] };
  }
  if (/^select\s+.*from\s+(sys\.tables|information_schema\.tables)/i.test(st)) return { columns: ['name'], rows: Object.keys(tbls).map((t) => [t]) };
  if ((m = /^create\s+table\s+(?:dbo\.)?\[?(\w+)\]?\s*\(([\s\S]+)\)\s*$/i.exec(st))) {
    if (!conn.db) throw new ArmError('262', `CREATE TABLE permission denied in database 'master'.`);
    const name = m[1];
    if (tbls[name.toLowerCase()]) throw new ArmError('2714', `There is already an object named '${name}' in the database.`);
    const cols = splitValues(m[2])
      .filter((c) => !/^(primary|constraint|foreign|unique)\b/i.test(c))
      .map((c) => {
        const [n, ...rest] = c.trim().split(/\s+/);
        return { name: n.replace(/[[\]]/g, ''), type: rest.join(' ') };
      });
    tbls[name.toLowerCase()] = { columns: cols, rows: [] };
    return { columns: [], rows: [], message: 'Commands completed successfully.' };
  }
  if ((m = /^drop\s+table\s+(?:dbo\.)?\[?(\w+)\]?\s*$/i.exec(st))) {
    if (!tbls[m[1].toLowerCase()]) throw new ArmError('3701', `Cannot drop the table '${m[1]}', because it does not exist or you do not have permission.`);
    delete tbls[m[1].toLowerCase()];
    return { columns: [], rows: [], message: 'Commands completed successfully.' };
  }
  if ((m = /^insert\s+into\s+(?:dbo\.)?\[?(\w+)\]?\s*(?:\(([^)]*)\))?\s*values\s*([\s\S]+)$/i.exec(st))) {
    const t = tbls[m[1].toLowerCase()];
    if (!t) throw new ArmError('208', `Invalid object name '${m[1]}'.`);
    const cols = m[2] ? m[2].split(',').map((c) => c.trim().replace(/[[\]]/g, '')) : t.columns.map((c) => c.name);
    const groups = m[3].match(/\((?:[^()']|'(?:[^']|'')*')*\)/g) ?? [];
    let n = 0;
    for (const g of groups) {
      const vals = splitValues(g.slice(1, -1)).map(lit);
      const row = t.columns.map((c) => {
        const i = cols.findIndex((x) => ciEq(x, c.name));
        if (i >= 0) return vals[i];
        if (/identity/i.test(c.type)) return t.rows.length + 1;
        return null;
      });
      t.rows.push(row);
      n++;
    }
    return { columns: [], rows: [], message: `(${n} row${n === 1 ? '' : 's'} affected)` };
  }
  if ((m = /^select\s+count\(\*\)\s+from\s+(?:dbo\.)?\[?(\w+)\]?\s*$/i.exec(st))) {
    const t = tbls[m[1].toLowerCase()];
    if (!t) throw new ArmError('208', `Invalid object name '${m[1]}'.`);
    return { columns: [''], rows: [[t.rows.length]] };
  }
  if ((m = /^select\s+(?:top\s+(\d+)\s+)?(.+?)\s+from\s+(?:dbo\.)?\[?(\w+)\]?(?:\s+where\s+(\w+)\s*=\s*(.+?))?(?:\s+order\s+by\s+(\w+)(\s+desc)?)?\s*$/i.exec(st))) {
    const t = tbls[m[3].toLowerCase()];
    if (!t) throw new ArmError('208', `Invalid object name '${m[3]}'.`);
    let rows = [...t.rows];
    if (m[4]) {
      const ci = t.columns.findIndex((c) => ciEq(c.name, m![4]));
      if (ci < 0) throw new ArmError('207', `Invalid column name '${m[4]}'.`);
      const v = lit(m[5]);
      rows = rows.filter((r) => String(r[ci]) === String(v));
    }
    if (m[6]) {
      const ci = t.columns.findIndex((c) => ciEq(c.name, m![6]));
      rows.sort((a, b) => (a[ci] > b[ci] ? 1 : a[ci] < b[ci] ? -1 : 0));
      if (m[7]) rows.reverse();
    }
    if (m[1]) rows = rows.slice(0, Number(m[1]));
    const sel = m[2].trim();
    if (sel === '*') return { columns: t.columns.map((c) => c.name), rows };
    const names = sel.split(',').map((x) => x.trim().replace(/[[\]]/g, ''));
    const idx = names.map((n) => {
      const i = t.columns.findIndex((c) => ciEq(c.name, n));
      if (i < 0) throw new ArmError('207', `Invalid column name '${n}'.`);
      return i;
    });
    return { columns: names, rows: rows.map((r) => idx.map((i) => r[i])) };
  }
  if ((m = /^delete\s+from\s+(?:dbo\.)?\[?(\w+)\]?\s*(?:where\s+(\w+)\s*=\s*(.+))?$/i.exec(st))) {
    const t = tbls[m[1].toLowerCase()];
    if (!t) throw new ArmError('208', `Invalid object name '${m[1]}'.`);
    const before = t.rows.length;
    if (m[2]) {
      const ci = t.columns.findIndex((c) => ciEq(c.name, m![2]));
      const v = lit(m[3]);
      t.rows = t.rows.filter((r) => String(r[ci]) !== String(v));
    } else t.rows = [];
    return { columns: [], rows: [], message: `(${before - t.rows.length} rows affected)` };
  }
  throw new ArmError('102', `Incorrect syntax near '${st.split(/\s+/).slice(0, 2).join(' ')}'. (El simulador soporta CREATE TABLE, INSERT, SELECT, DELETE, DROP TABLE y algunas funciones del sistema.)`);
}

export function formatSqlResults(results: SqlResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    if (r.message && !r.columns.length) {
      out.push(r.message);
      continue;
    }
    const widths = r.columns.map((c, i) => Math.max(c.length, ...r.rows.map((row) => String(row[i] ?? 'NULL').length), 4));
    out.push(r.columns.map((c, i) => c.padEnd(widths[i])).join(' '));
    out.push(widths.map((w) => '-'.repeat(w)).join(' '));
    for (const row of r.rows) out.push(row.map((v, i) => String(v ?? 'NULL').padEnd(widths[i])).join(' '));
    out.push('');
    out.push(`(${r.rows.length} row${r.rows.length === 1 ? '' : 's'} affected)`);
  }
  return out.join('\n');
}
