// Construcción y análisis de identificadores de recursos de Azure.

export function subId(sub: string): string {
  return `/subscriptions/${sub}`;
}

export function rgId(sub: string, rg: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}`;
}

/**
 * type 'Microsoft.Sql/servers/databases' + name 'srv/db'
 *   -> /subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Sql/servers/srv/databases/db
 */
export function resourceId(sub: string, rg: string, type: string, name: string): string {
  const [ns, ...types] = type.split('/');
  const names = name.split('/');
  let path = `${rgId(sub, rg)}/providers/${ns}`;
  types.forEach((t, i) => {
    path += `/${t}/${names[i] ?? ''}`;
  });
  return path;
}

export interface ParsedId {
  subscriptionId?: string;
  resourceGroup?: string;
  namespace?: string;
  type?: string;
  name?: string;
  types: string[];
  names: string[];
}

export function parseResourceId(id: string): ParsedId {
  const parts = id.split('/').filter(Boolean);
  const out: ParsedId = { types: [], names: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase();
    if (p === 'subscriptions') out.subscriptionId = parts[++i];
    else if (p === 'resourcegroups') out.resourceGroup = parts[++i];
    else if (p === 'providers') {
      out.namespace = parts[++i];
      const rest = parts.slice(i + 1);
      for (let j = 0; j + 1 < rest.length; j += 2) {
        out.types.push(rest[j]);
        out.names.push(rest[j + 1]);
      }
      break;
    }
  }
  if (out.namespace && out.types.length) {
    out.type = `${out.namespace}/${out.types.join('/')}`;
    out.name = out.names.join('/');
  }
  return out;
}

export function normScope(s: string): string {
  const v = (s || '/').toLowerCase().replace(/\/+$/, '');
  return v === '' ? '/' : v;
}

/** true si `target` está dentro (o es igual) de `scope`. */
export function isWithinScope(target: string, scope: string): boolean {
  const t = normScope(target);
  const sc = normScope(scope);
  if (sc === '/') return true;
  return t === sc || t.startsWith(sc + '/');
}

export function lastSegment(id: string): string {
  const parts = id.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
