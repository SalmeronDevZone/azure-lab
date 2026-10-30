// Motor de plantillas ARM: evaluación de expresiones, dependencias, despliegue incremental/completo y what-if.
import type { CloudState, Deployment, PrincipalRef, Resource, ResourceGroup } from '../types';
import { getState, changed, portalPrincipal } from '../store';
import { ArmError } from '../errors';
import { authorize, deleteResource, findResource, findRg, logActivity, patchResource, putResource, resourceToArm } from '../arm';
import { getProvider } from '../registry';
import { parseResourceId, resourceId as buildResourceId, isWithinScope } from '../ids';
import { ciEq, deepClone, fnv1a, guid, nowIso, shortHash, uniqueString } from '../util';
import { upsertNsgRule, upsertSubnet, createPeering } from './networkOps';
import { createRoleAssignment, findRoleDefinition } from './identity';
import { createLock } from './governance';
import { createDiagnosticSetting } from './diagnostics';
import { containersOf } from './storage';

// ---------------------------------------------------------------- parser de expresiones

type Access = { k: 'prop'; name: string } | { k: 'idx'; expr: AExpr };
type AExpr =
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'call'; fn: string; args: AExpr[]; access: Access[] };

export function parseArmExpression(src: string): AExpr {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const err = (m: string) => new ArmError('InvalidTemplate', `Unable to parse language expression '${src}': ${m}`);
  function primary(): AExpr {
    ws();
    const c = src[i];
    if (c === "'") {
      i++;
      let s = '';
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          s += "'";
          i += 2;
          continue;
        }
        if (src[i] === "'") break;
        s += src[i++];
      }
      if (src[i] !== "'") throw err("expected closing quote");
      i++;
      return withAccess({ k: 'str', v: s } as AExpr);
    }
    if (/[-\d]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      const v = Number(src.slice(i, j));
      i = j;
      return { k: 'num', v };
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w.]/.test(src[j]) && !(src[j] === '.' && !/[A-Za-z]/.test(src[j + 1] ?? ''))) j++;
      let name = src.slice(i, j);
      // permitir prefijos de espacio de nombres sys.
      i = j;
      ws();
      if (name === 'true' || name === 'false' || name === 'null') {
        if (src[i] === '(') {
          i++;
          ws();
          if (src[i] !== ')') throw err(`expected ')' after '${name}('`);
          i++;
        }
        return name === 'null' ? { k: 'null' } : { k: 'bool', v: name === 'true' };
      }
      if (name.startsWith('sys.')) name = name.slice(4);
      if (src[i] !== '(') throw err(`expected '(' after '${name}'`);
      i++;
      const args: AExpr[] = [];
      ws();
      if (src[i] === ')') i++;
      else {
        for (;;) {
          args.push(primary());
          ws();
          if (src[i] === ',') {
            i++;
            continue;
          }
          if (src[i] === ')') {
            i++;
            break;
          }
          throw err(`expected ',' or ')' at position ${i}`);
        }
      }
      return withAccess({ k: 'call', fn: name.toLowerCase(), args, access: [] });
    }
    throw err(`unexpected character '${c ?? 'EOF'}' at position ${i}`);
  }
  function withAccess(e: AExpr): AExpr {
    const access: Access[] = [];
    for (;;) {
      ws();
      if (src[i] === '.') {
        i++;
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        access.push({ k: 'prop', name: src.slice(i, j) });
        i = j;
      } else if (src[i] === '[') {
        i++;
        const idx = primary();
        ws();
        if (src[i] !== ']') throw err("expected ']'");
        i++;
        access.push({ k: 'idx', expr: idx });
      } else break;
    }
    if (!access.length) return e;
    if (e.k === 'call') return { ...e, access: [...e.access, ...access] };
    return { k: 'call', fn: '__value', args: [e], access };
  }
  const e = primary();
  ws();
  if (i < src.length) throw err(`unexpected trailing characters '${src.slice(i)}'`);
  return e;
}

// ---------------------------------------------------------------- evaluación

export interface EvalCtx {
  s: CloudState;
  params: Record<string, any>;
  rawVars: Record<string, any>;
  varCache: Record<string, any>;
  rg: ResourceGroup;
  deploymentName: string;
  copy?: { name: string; index: number };
  templateResources: { type: string; name: string }[];
  whatIf: boolean;
  principal: PrincipalRef;
}

const PLACEHOLDER = Symbol('placeholder');

function placeholder(text: string): any {
  return new Proxy(
    { [PLACEHOLDER]: text, toString: () => `[${text}]` },
    {
      get(target: any, prop) {
        if (prop === PLACEHOLDER) return target[PLACEHOLDER];
        if (prop === 'toString' || prop === Symbol.toPrimitive) return () => `[${text}]`;
        if (typeof prop === 'symbol') return undefined;
        return placeholder(`${text}.${String(prop)}`);
      },
    },
  );
}

export function isPlaceholder(v: any): boolean {
  return v && typeof v === 'object' && v[PLACEHOLDER] !== undefined;
}

function str(v: any): string {
  if (isPlaceholder(v)) return `[${v[PLACEHOLDER]}]`;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function resolveResourceIdArgs(args: any[], ctx: EvalCtx, scope: 'rg' | 'sub' = 'rg'): string {
  const typeIdx = args.findIndex((a) => typeof a === 'string' && /^[A-Za-z]+\.[A-Za-z.]+\/[A-Za-z]/.test(a));
  if (typeIdx < 0) throw new ArmError('InvalidTemplate', `Unable to evaluate template language function 'resourceId': the type '${args[0]}' is invalid.`);
  const type = args[typeIdx];
  const names = args.slice(typeIdx + 1).map(str);
  const pre = args.slice(0, typeIdx).map(str);
  const segs = type.split('/').length - 1;
  if (names.length !== segs) {
    throw new ArmError('InvalidTemplate', `Unable to evaluate template language function 'resourceId': function requires exactly one multi-segmented argument which must be resource type including resource provider namespace. Current function arguments '${args.join(',')}'.`);
  }
  let sub = ctx.rg.subscriptionId;
  let rg = ctx.rg.name;
  if (pre.length === 1) rg = pre[0];
  if (pre.length === 2) {
    sub = pre[0];
    rg = pre[1];
  }
  if (scope === 'sub') {
    const [ns, ...types] = type.split('/');
    return `/subscriptions/${sub}/providers/${ns}` + types.map((t: string, i: number) => `/${t}/${names[i]}`).join('');
  }
  return buildResourceId(sub, rg, type, names.join('/'));
}

function lookupResource(arg: any, ctx: EvalCtx): Resource | undefined {
  const v = str(arg);
  if (v.startsWith('/')) return findResource(v, ctx.s);
  const decl = ctx.templateResources.find((r) => ciEq(r.name, v) || ciEq(r.name.split('/').pop(), v));
  if (decl) return findResource(buildResourceId(ctx.rg.subscriptionId, ctx.rg.name, decl.type, decl.name), ctx.s);
  return ctx.s.resources.find((r) => ciEq(r.name, v) && ciEq(r.resourceGroup, ctx.rg.name));
}

function armView(r: Resource, full: boolean) {
  const v = resourceToArm(r);
  if (!full) return v.properties;
  return { ...v, apiVersion: '2023-01-01' };
}

function call(fn: string, rawArgs: AExpr[], ctx: EvalCtx): any {
  if (fn === 'if') {
    const cond = evalExpr(rawArgs[0], ctx);
    return evalExpr(cond ? rawArgs[1] : rawArgs[2], ctx);
  }
  const a = rawArgs.map((x) => evalExpr(x, ctx));
  switch (fn) {
    case '__value':
      return a[0];
    case 'parameters': {
      const k = Object.keys(ctx.params).find((p) => ciEq(p, a[0]));
      if (k === undefined) throw new ArmError('InvalidTemplate', `The template parameter '${a[0]}' is not found. Please see https://aka.ms/arm-syntax-parameters for usage details.`);
      return ctx.params[k];
    }
    case 'variables': {
      const k = Object.keys(ctx.rawVars).find((p) => ciEq(p, a[0]));
      if (k === undefined) throw new ArmError('InvalidTemplate', `The template variable '${a[0]}' is not found. Please see https://aka.ms/arm-syntax-variables for usage details.`);
      if (!(k in ctx.varCache)) ctx.varCache[k] = evalValue(ctx.rawVars[k], ctx);
      return ctx.varCache[k];
    }
    case 'resourcegroup':
      return { id: ctx.rg.id, name: ctx.rg.name, type: 'Microsoft.Resources/resourceGroups', location: ctx.rg.location, managedBy: ctx.rg.managedBy ?? null, tags: ctx.rg.tags, properties: { provisioningState: 'Succeeded' } };
    case 'subscription': {
      const sub = ctx.s.subscriptions.find((x) => x.id === ctx.rg.subscriptionId)!;
      return { id: `/subscriptions/${sub.id}`, subscriptionId: sub.id, tenantId: sub.tenantId, displayName: sub.displayName };
    }
    case 'tenant':
      return { tenantId: ctx.s.tenant.id, displayName: ctx.s.tenant.displayName };
    case 'deployment':
      return { name: ctx.deploymentName, properties: { templateLink: null } };
    case 'environment':
      return { name: 'AzureCloud', suffixes: { storage: 'core.windows.net', keyvaultDns: '.vault.azure.net', sqlServerHostname: '.database.windows.net', acrLoginServer: '.azurecr.io' }, authentication: { loginEndpoint: 'https://login.microsoftonline.com/' } };
    case 'concat':
      if (a.some((x) => Array.isArray(x))) return a.flatMap((x) => (Array.isArray(x) ? x : [x]));
      return a.map(str).join('');
    case 'format':
      return str(a[0]).replace(/\{\{|\}\}|\{(\d+)(?::[^}]*)?\}/g, (m, n) => (m === '{{' ? '{' : m === '}}' ? '}' : str(a[Number(n) + 1])));
    case 'tolower':
      return str(a[0]).toLowerCase();
    case 'toupper':
      return str(a[0]).toUpperCase();
    case 'trim':
      return str(a[0]).trim();
    case 'uniquestring':
      return uniqueString(...a.map(str));
    case 'guid': {
      const h = shortHash(a.map(str).join('|'), 32);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    case 'newguid':
      return guid();
    case 'utcnow':
      return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    case 'resourceid':
      return resolveResourceIdArgs(a, ctx);
    case 'subscriptionresourceid':
      return resolveResourceIdArgs(a, ctx, 'sub');
    case 'tenantresourceid': {
      const [type, ...names] = a.map(str);
      const [ns, ...types] = type.split('/');
      return `/providers/${ns}` + types.map((t, i) => `/${t}/${names[i]}`).join('');
    }
    case 'extensionresourceid': {
      const [base, type, ...names] = a.map(str);
      const [ns, ...types] = type.split('/');
      return `${base}/providers/${ns}` + types.map((t, i) => `/${t}/${names[i]}`).join('');
    }
    case 'reference': {
      const r = lookupResource(a[0], ctx);
      const full = a.some((x) => ciEq(str(x), 'Full'));
      if (!r) {
        if (ctx.whatIf) return placeholder(`reference('${str(a[0])}')`);
        throw new ArmError('InvalidTemplate', `The template function 'reference' is not expected at this location or the resource '${str(a[0])}' was not found. Make sure the resource exists or is deployed before (dependsOn).`);
      }
      return armView(r, full);
    }
    case 'listkeys': {
      const r = lookupResource(a[0], ctx);
      if (!r) {
        if (ctx.whatIf) return placeholder(`listKeys('${str(a[0])}')`);
        throw new ArmError('ResourceNotFound', `The resource '${str(a[0])}' was not found for listKeys.`, 404);
      }
      authorize(ctx.principal, `${r.type}/listkeys/action`, r.id);
      if (ciEq(r.type, 'Microsoft.Storage/storageAccounts')) return { keys: (r.data?.keys ?? []).map((k: any) => ({ keyName: k.keyName, value: k.value, permissions: 'FULL' })) };
      if (ciEq(r.type, 'Microsoft.ContainerRegistry/registries')) return { username: r.name, passwords: r.data?.passwords ?? [] };
      return { keys: [] };
    }
    case 'listcredentials':
      return call('listkeys', rawArgs, ctx);
    case 'equals':
      return JSON.stringify(a[0]) === JSON.stringify(a[1]) || (typeof a[0] === 'string' && typeof a[1] === 'string' && a[0].toLowerCase() === a[1].toLowerCase());
    case 'not':
      return !a[0];
    case 'and':
      return a.every(Boolean);
    case 'or':
      return a.some(Boolean);
    case 'greater':
      return a[0] > a[1];
    case 'greaterorequals':
      return a[0] >= a[1];
    case 'less':
      return a[0] < a[1];
    case 'lessorequals':
      return a[0] <= a[1];
    case 'empty':
      return a[0] === null || a[0] === undefined || a[0] === '' || (Array.isArray(a[0]) && !a[0].length) || (typeof a[0] === 'object' && !Object.keys(a[0]).length);
    case 'coalesce':
      return a.find((x) => x !== null && x !== undefined) ?? null;
    case 'length':
      return Array.isArray(a[0]) ? a[0].length : typeof a[0] === 'object' && a[0] ? Object.keys(a[0]).length : str(a[0]).length;
    case 'contains':
      if (Array.isArray(a[0])) return a[0].some((x) => JSON.stringify(x) === JSON.stringify(a[1]));
      if (a[0] && typeof a[0] === 'object') return Object.keys(a[0]).some((k) => ciEq(k, a[1]));
      return str(a[0]).toLowerCase().includes(str(a[1]).toLowerCase());
    case 'startswith':
      return str(a[0]).toLowerCase().startsWith(str(a[1]).toLowerCase());
    case 'endswith':
      return str(a[0]).toLowerCase().endsWith(str(a[1]).toLowerCase());
    case 'substring':
      return str(a[0]).substr(Number(a[1]), a[2] === undefined ? undefined : Number(a[2]));
    case 'take':
      return Array.isArray(a[0]) ? a[0].slice(0, Number(a[1])) : str(a[0]).slice(0, Number(a[1]));
    case 'skip':
      return Array.isArray(a[0]) ? a[0].slice(Number(a[1])) : str(a[0]).slice(Number(a[1]));
    case 'first':
      return Array.isArray(a[0]) ? a[0][0] : str(a[0])[0];
    case 'last':
      return Array.isArray(a[0]) ? a[0][a[0].length - 1] : str(a[0]).slice(-1);
    case 'replace':
      return str(a[0]).split(str(a[1])).join(str(a[2]));
    case 'split':
      return str(a[0]).split(Array.isArray(a[1]) ? new RegExp(a[1].map((x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')) : str(a[1]));
    case 'join':
      return (a[0] as any[]).map(str).join(str(a[1]));
    case 'indexof':
      return str(a[0]).toLowerCase().indexOf(str(a[1]).toLowerCase());
    case 'string':
      return typeof a[0] === 'string' ? a[0] : JSON.stringify(a[0]);
    case 'int':
      return Math.trunc(Number(a[0]));
    case 'bool':
      return a[0] === true || ciEq(str(a[0]), 'true') || a[0] === 1;
    case 'json':
      return JSON.parse(str(a[0]));
    case 'base64':
      return btoa(unescape(encodeURIComponent(str(a[0]))));
    case 'add':
      return Number(a[0]) + Number(a[1]);
    case 'sub':
      return Number(a[0]) - Number(a[1]);
    case 'mul':
      return Number(a[0]) * Number(a[1]);
    case 'div':
      return Math.trunc(Number(a[0]) / Number(a[1]));
    case 'mod':
      return Number(a[0]) % Number(a[1]);
    case 'min':
      return Math.min(...(Array.isArray(a[0]) ? a[0] : a));
    case 'max':
      return Math.max(...(Array.isArray(a[0]) ? a[0] : a));
    case 'range':
      return Array.from({ length: Number(a[1]) }, (_, i) => Number(a[0]) + i);
    case 'array':
      return Array.isArray(a[0]) ? a[0] : [a[0]];
    case 'createarray':
      return a;
    case 'createobject': {
      const o: Record<string, any> = {};
      for (let i = 0; i < a.length; i += 2) o[str(a[i])] = a[i + 1];
      return o;
    }
    case 'union':
      if (Array.isArray(a[0])) return [...new Set(a.flat().map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
      return Object.assign({}, ...a);
    case 'intersection':
      return (a[0] as any[]).filter((x) => a.slice(1).every((arr: any[]) => arr.includes(x)));
    case 'copyindex': {
      if (!ctx.copy) throw new ArmError('InvalidTemplate', "The template function 'copyIndex' is not expected at this location. It can only be used in a resource with a copy loop.");
      return ctx.copy.index + Number(typeof a[0] === 'number' ? a[0] : a[1] ?? 0);
    }
    case 'datetimeadd':
      return new Date(Date.parse(str(a[0])) + 3600000).toISOString();
    case 'pickzones':
      return ['1'];
  }
  throw new ArmError('InvalidTemplate', `The template function '${fn}' is not valid (o no está soportada por el simulador).`);
}

function applyAccess(v: any, access: Access[], ctx: EvalCtx, fnName: string): any {
  let cur = v;
  for (const ac of access) {
    if (isPlaceholder(cur)) {
      cur = cur[ac.k === 'prop' ? ac.name : String(evalExpr(ac.expr, ctx))];
      continue;
    }
    if (cur === null || cur === undefined) {
      throw new ArmError('InvalidTemplate', `The language expression property '${ac.k === 'prop' ? ac.name : '[index]'}' can't be evaluated (resultado de ${fnName}() es nulo).`);
    }
    if (ac.k === 'prop') {
      const key = Object.keys(cur).find((k) => ciEq(k, ac.name));
      if (key === undefined) {
        throw new ArmError('InvalidTemplate', `The language expression property '${ac.name}' doesn't exist, available properties are '${Object.keys(cur).join(', ')}'.`);
      }
      cur = cur[key];
    } else {
      const idx = evalExpr(ac.expr, ctx);
      cur = cur[idx];
    }
  }
  return cur;
}

function evalExpr(e: AExpr, ctx: EvalCtx): any {
  switch (e.k) {
    case 'str':
      return e.v;
    case 'num':
      return e.v;
    case 'bool':
      return e.v;
    case 'null':
      return null;
    case 'call': {
      const v = call(e.fn, e.args, ctx);
      return e.access.length ? applyAccess(v, e.access, ctx, e.fn) : v;
    }
  }
}

export function evalValue(v: any, ctx: EvalCtx): any {
  if (typeof v === 'string') {
    if (v.startsWith('[[')) return v.slice(1);
    if (v.startsWith('[') && v.endsWith(']')) return evalExpr(parseArmExpression(v.slice(1, -1)), ctx);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => evalValue(x, ctx));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = evalValue(val, ctx);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- parámetros

export function resolveParameters(template: any, provided: Record<string, any>, ctx: EvalCtx): Record<string, any> {
  const defs: Record<string, any> = template.parameters ?? {};
  for (const k of Object.keys(provided)) {
    if (!Object.keys(defs).some((d) => ciEq(d, k))) {
      throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The template parameters '${k}' in the parameters file are not valid; they are not present in the original template and can therefore not be provided at deployment time. The only supported parameters for this template are '${Object.keys(defs).join(', ')}'.`);
    }
  }
  const out: Record<string, any> = {};
  ctx.params = out;
  for (const [name, def] of Object.entries<any>(defs)) {
    const pk = Object.keys(provided).find((k) => ciEq(k, name));
    let val: any;
    if (pk !== undefined) val = provided[pk];
    else if ('defaultValue' in def) val = evalValue(def.defaultValue, ctx);
    else throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The value for the template parameter '${name}' at line '1' and column '1' is not provided. Please see https://aka.ms/arm-create-parameter-file for usage details.'.`);
    const type = String(def.type ?? 'string').toLowerCase();
    if (type === 'int' && typeof val === 'string' && /^-?\d+$/.test(val)) val = Number(val);
    if (type === 'bool' && typeof val === 'string') val = val.toLowerCase() === 'true';
    if ((type === 'array' || type === 'object') && typeof val === 'string') {
      try {
        val = JSON.parse(val);
      } catch {
        /* se valida abajo */
      }
    }
    const typeOk =
      type === 'string' || type === 'securestring' ? typeof val === 'string' :
      type === 'int' ? Number.isInteger(val) :
      type === 'bool' ? typeof val === 'boolean' :
      type === 'array' ? Array.isArray(val) :
      type === 'object' || type === 'secureobject' ? typeof val === 'object' && val !== null && !Array.isArray(val) : true;
    if (!typeOk) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'Template parameter JToken type is not valid. Expected '${def.type}'. Actual '${typeof val}'. Please see https://aka.ms/arm-create-parameter-file for usage details.'.`);
    if (def.allowedValues && !def.allowedValues.some((x: any) => JSON.stringify(x) === JSON.stringify(val))) {
      throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The provided value '${str(val)}' for the template parameter '${name}' is not valid. The parameter value is not part of the allowed value(s): '${def.allowedValues.join(',')}'.'.`);
    }
    if (typeof val === 'string') {
      if (def.minLength !== undefined && val.length < def.minLength) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The provided value for the template parameter '${name}' is not valid. Length of the value should be greater than or equal to '${def.minLength}'.'.`);
      if (def.maxLength !== undefined && val.length > def.maxLength) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The provided value for the template parameter '${name}' is not valid. Length of the value should be less than or equal to '${def.maxLength}'.'.`);
    }
    if (typeof val === 'number') {
      if (def.minValue !== undefined && val < def.minValue) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The provided value for the template parameter '${name}' is not valid. The value must be greater than or equal to '${def.minValue}'.'.`);
      if (def.maxValue !== undefined && val > def.maxValue) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The provided value for the template parameter '${name}' is not valid. The value must be less than or equal to '${def.maxValue}'.'.`);
    }
    out[name] = val;
  }
  return out;
}

// ---------------------------------------------------------------- expansión de recursos

interface Expanded {
  key: string;
  def: any;
  copy?: { name: string; index: number };
  type: string;
  name: string;
  dependsOnRaw: any[];
  parentKey?: string;
}

function expandResources(template: any, ctx: EvalCtx): Expanded[] {
  const out: Expanded[] = [];
  const walk = (list: any[], parent?: { type: string; name: string; key: string }) => {
    if (!Array.isArray(list)) throw new ArmError('InvalidTemplate', "Deployment template validation failed: 'The template 'resources' property must be an array.'");
    for (const def of list) {
      if (!def?.type || def.name === undefined) throw new ArmError('InvalidTemplate', "Deployment template validation failed: 'Each template resource must have a 'type' and a 'name'.'");
      const count = def.copy ? Number(evalValue(def.copy.count, ctx)) : 1;
      if (def.copy && (!Number.isInteger(count) || count < 0 || count > 800)) throw new ArmError('InvalidTemplate', `The copy count must be a non-negative integer not greater than 800. Actual: ${count}`);
      for (let i = 0; i < count; i++) {
        const copy = def.copy ? { name: def.copy.name, index: i } : undefined;
        const sub = { ...ctx, copy };
        if (def.condition !== undefined && !evalValue(def.condition, sub)) continue;
        let type = String(def.type);
        let name = str(evalValue(def.name, sub));
        if (parent && !type.includes('/')) {
          type = `${parent.type}/${type}`;
          name = `${parent.name}/${name}`;
        } else if (parent && type.split('/').length === 2 && !type.startsWith(parent.type.split('/')[0])) {
          // tipo completo de otro proveedor anidado (poco común)
        } else if (parent && type.split('/').length <= parent.type.split('/').length) {
          type = `${parent.type}/${type}`;
          name = `${parent.name}/${name}`;
        }
        const segs = type.split('/').length - 1;
        if (name.split('/').length !== segs) {
          throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The template resource '${name}' for type '${type}' at line '1' and column '1' has incorrect segment lengths. A nested resource type must have identical number of segments as its resource name. A root resource type must have segment length one greater than its resource name.'`);
        }
        const key = `${type}/${name}`.toLowerCase();
        out.push({ key, def, copy, type, name, dependsOnRaw: def.dependsOn ?? [], parentKey: parent?.key });
        if (def.resources) walk(def.resources, { type, name, key });
      }
    }
  };
  walk(template.resources ?? []);
  return out;
}

function toposort(items: Expanded[], ctx: EvalCtx): Expanded[] {
  const byKey = new Map(items.map((x) => [x.key, x]));
  const deps = new Map<string, Set<string>>();
  for (const it of items) {
    const set = new Set<string>();
    if (it.parentKey && byKey.has(it.parentKey)) set.add(it.parentKey);
    for (const d of it.dependsOnRaw) {
      const v = str(evalValue(d, { ...ctx, copy: it.copy }));
      let match: Expanded[] = [];
      if (v.startsWith('/')) {
        const p = parseResourceId(v);
        if (p.type && p.name) match = items.filter((x) => x.key === `${p.type}/${p.name}`.toLowerCase());
      } else {
        match = items.filter((x) => ciEq(x.name, v) || ciEq(x.name.split('/').pop(), v) || ciEq(x.def.copy?.name, v) || x.key === v.toLowerCase());
      }
      for (const m of match) if (m.key !== it.key) set.add(m.key);
    }
    // dependencias implícitas: un recurso hijo depende de su padre si está en la plantilla
    const parentKey = it.type.split('/').length > 2 ? `${it.type.split('/').slice(0, -1).join('/')}/${it.name.split('/').slice(0, -1).join('/')}`.toLowerCase() : null;
    if (parentKey && byKey.has(parentKey)) set.add(parentKey);
    deps.set(it.key, set);
  }
  const out: Expanded[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (k: string, path: string[]) => {
    const st = state.get(k) ?? 0;
    if (st === 2) return;
    if (st === 1) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'Circular dependency detected on resource: '${path.join("' -> '")}'. Please see https://aka.ms/arm-syntax-resources for usage details.'`);
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d, [...path, d]);
    state.set(k, 2);
    out.push(byKey.get(k)!);
  };
  for (const it of items) visit(it.key, [it.key]);
  return out;
}

// ---------------------------------------------------------------- aplicar recursos

const SPECIAL_TYPES = [
  'microsoft.storage/storageaccounts/blobservices',
  'microsoft.storage/storageaccounts/blobservices/containers',
  'microsoft.storage/storageaccounts/fileservices',
  'microsoft.storage/storageaccounts/fileservices/shares',
  'microsoft.web/sites/config',
  'microsoft.web/sites/slots/config',
  'microsoft.network/networksecuritygroups/securityrules',
  'microsoft.network/virtualnetworks/subnets',
  'microsoft.network/virtualnetworks/virtualnetworkpeerings',
  'microsoft.keyvault/vaults/secrets',
  'microsoft.keyvault/vaults/accesspolicies',
  'microsoft.authorization/roleassignments',
  'microsoft.authorization/locks',
  'microsoft.insights/diagnosticsettings',
  'microsoft.containerservice/managedclusters/agentpools',
];

export function isSupportedType(type: string): boolean {
  return !!getProvider(type) || SPECIAL_TYPES.includes(type.toLowerCase());
}

function parentId(ctx: EvalCtx, type: string, name: string, levels = 1): string {
  const t = type.split('/').slice(0, -levels).join('/');
  const n = name.split('/').slice(0, -levels).join('/');
  return buildResourceId(ctx.rg.subscriptionId, ctx.rg.name, t, n);
}

async function applyResource(def: any, type: string, name: string, ctx: EvalCtx, opts: { source: Deployment['source'] }): Promise<string> {
  const lower = type.toLowerCase();
  const props = def.properties ?? {};
  const principal = ctx.principal;
  const requireParent = (id: string) => {
    const p = findResource(id, ctx.s);
    if (!p) throw new ArmError('ParentResourceNotFound', `Can not perform requested operation on nested resource. Parent resource '${id.split('/').pop()}' not found.`, 404);
    return p;
  };
  switch (lower) {
    case 'microsoft.storage/storageaccounts/blobservices':
    case 'microsoft.storage/storageaccounts/fileservices': {
      const acct = requireParent(parentId(ctx, type, name));
      return `${acct.id}/${type.split('/').pop()}/default`;
    }
    case 'microsoft.storage/storageaccounts/blobservices/containers': {
      const acct = requireParent(parentId(ctx, type, name, 2));
      authorize(principal, 'Microsoft.Storage/storageAccounts/blobServices/containers/write', acct.id);
      const cname = name.split('/').pop()!;
      const access = (props.publicAccess ?? 'None').toLowerCase();
      if (access !== 'none' && !acct.properties.allowBlobPublicAccess) throw new ArmError('PublicAccessNotPermitted', 'Public access is not permitted on this storage account.', 409);
      const cs = containersOf(acct);
      if (!cs[cname]) cs[cname] = { name: cname, publicAccess: access === 'none' ? 'off' : access === 'blob' ? 'blob' : 'container', lastModified: nowIso(), etag: `"0x${shortHash(guid(), 12)}"`, metadata: props.metadata ?? {}, blobs: {} };
      changed();
      return `${acct.id}/blobServices/default/containers/${cname}`;
    }
    case 'microsoft.storage/storageaccounts/fileservices/shares': {
      const acct = requireParent(parentId(ctx, type, name, 2));
      const sname = name.split('/').pop()!;
      acct.data!.shares = acct.data!.shares ?? {};
      acct.data!.shares[sname] = acct.data!.shares[sname] ?? { name: sname, quota: props.shareQuota ?? 5120, files: {}, lastModified: nowIso() };
      changed();
      return `${acct.id}/fileServices/default/shares/${sname}`;
    }
    case 'microsoft.web/sites/config':
    case 'microsoft.web/sites/slots/config': {
      const site = requireParent(parentId(ctx, type, name));
      const cfgName = name.split('/').pop()!.toLowerCase();
      patchResource(site.id, (r) => {
        if (cfgName === 'appsettings') r.properties.siteConfig.appSettings = Object.entries(props).map(([k, v]) => ({ name: k, value: str(v) }));
        else if (cfgName === 'web') Object.assign(r.properties.siteConfig, props);
        else if (cfgName === 'connectionstrings') r.properties.siteConfig.connectionStrings = Object.entries<any>(props).map(([k, v]) => ({ name: k, connectionString: v.value, type: v.type }));
      }, { principal, opName: `Actualizar configuración (${cfgName})` });
      return `${site.id}/config/${cfgName}`;
    }
    case 'microsoft.network/networksecuritygroups/securityrules': {
      const nsg = requireParent(parentId(ctx, type, name));
      const rule = upsertNsgRule(nsg.id, { name: name.split('/').pop(), properties: props }, principal);
      return rule.id;
    }
    case 'microsoft.network/virtualnetworks/subnets': {
      const vnet = requireParent(parentId(ctx, type, name));
      const sn = upsertSubnet(vnet.id, { name: name.split('/').pop()!, addressPrefix: props.addressPrefix ?? props.addressPrefixes?.[0], nsgId: props.networkSecurityGroup?.id }, principal);
      return sn.id;
    }
    case 'microsoft.network/virtualnetworks/virtualnetworkpeerings': {
      const vnet = requireParent(parentId(ctx, type, name));
      const p = createPeering(vnet.id, name.split('/').pop()!, props.remoteVirtualNetwork?.id, { allowVnetAccess: props.allowVirtualNetworkAccess, allowForwardedTraffic: props.allowForwardedTraffic }, principal);
      return p.id;
    }
    case 'microsoft.keyvault/vaults/secrets': {
      const vault = requireParent(parentId(ctx, type, name));
      authorize(principal, 'Microsoft.KeyVault/vaults/secrets/write', vault.id);
      const sname = name.split('/').pop()!;
      const secrets = vault.data!.secrets as Record<string, any>;
      const version = { id: shortHash(guid(), 32), value: str(props.value), created: nowIso(), enabled: props.attributes?.enabled ?? true, contentType: props.contentType ?? null };
      if (secrets[sname]) secrets[sname].versions.push(version);
      else secrets[sname] = { versions: [version], deleted: null };
      changed();
      return `${vault.id}/secrets/${sname}`;
    }
    case 'microsoft.keyvault/vaults/accesspolicies': {
      const vault = requireParent(parentId(ctx, type, name));
      patchResource(vault.id, (r) => {
        const list: any[] = r.properties.accessPolicies ?? [];
        for (const ap of props.accessPolicies ?? []) {
          const ex = list.find((x) => x.objectId === ap.objectId);
          if (ex) ex.permissions = ap.permissions;
          else list.push({ tenantId: ctx.s.tenant.id, ...ap });
        }
        r.properties.accessPolicies = list;
      }, { principal, action: 'Microsoft.KeyVault/vaults/accessPolicies/write' });
      return `${vault.id}/accessPolicies/add`;
    }
    case 'microsoft.authorization/roleassignments': {
      const scope = def.scope ? str(def.scope) : ctx.rg.id;
      const roleId = str(props.roleDefinitionId);
      const role = findRoleDefinition(roleId.split('/').pop()!, ctx.s);
      if (!role) throw new ArmError('RoleDefinitionDoesNotExist', `The specified role definition with ID '${roleId.split('/').pop()}' does not exist.`, 404);
      try {
        const ra = createRoleAssignment({ assignee: str(props.principalId), role: role.name, scope: scope.startsWith('/') ? scope : buildResourceId(ctx.rg.subscriptionId, ctx.rg.name, '', '') }, principal);
        return ra.id;
      } catch (e) {
        if (e instanceof ArmError && e.code === 'RoleAssignmentExists') return `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`;
        throw e;
      }
    }
    case 'microsoft.authorization/locks': {
      const scope = def.scope ? str(def.scope) : ctx.rg.id;
      const l = createLock({ name: name.split('/').pop()!, level: props.level, scope, notes: props.notes }, principal);
      return l.id;
    }
    case 'microsoft.insights/diagnosticsettings': {
      const scope = def.scope ? str(def.scope) : '';
      if (!scope) throw new ArmError('InvalidTemplate', "Diagnostic settings require a 'scope' property pointing to the target resource.");
      const target = findResource(scope, ctx.s) ?? lookupResource(scope, ctx);
      if (!target) throw new ArmError('ResourceNotFound', `Target resource '${scope}' not found.`, 404);
      const d = createDiagnosticSetting({ name: name.split('/').pop()!, resourceId: target.id, workspaceId: props.workspaceId, storageAccountId: props.storageAccountId, logs: props.logs, metrics: props.metrics }, principal);
      return d.id;
    }
    case 'microsoft.containerservice/managedclusters/agentpools': {
      const cluster = requireParent(parentId(ctx, type, name));
      const poolName = name.split('/').pop()!;
      const pools = [...cluster.properties.agentPoolProfiles.filter((p: any) => p.name !== poolName), { name: poolName, ...props }];
      await putResource({ type: cluster.type, name: cluster.name, location: cluster.location, properties: { ...cluster.properties, agentPoolProfiles: pools } }, cluster.resourceGroup, { principal, subscriptionId: cluster.subscriptionId });
      return `${cluster.id}/agentPools/${poolName}`;
    }
  }
  const provider = getProvider(type);
  if (!provider) {
    throw new ArmError('NoRegisteredProviderFound', `The resource type '${type}' is not supported by Azure Lab (simulador). Supported types: ${[...new Set([...SPECIAL_TYPES])].slice(0, 6).join(', ')}, ...`, 400);
  }
  const res = await putResource(
    {
      type,
      name,
      location: def.location,
      tags: def.tags,
      sku: def.sku,
      kind: def.kind,
      properties: props,
      identity: def.identity,
      zones: def.zones,
    },
    ctx.rg.name,
    { principal, subscriptionId: ctx.rg.subscriptionId, source: opts.source },
  );
  return res.id;
}

// ---------------------------------------------------------------- API pública

export interface DeployInput {
  template: any;
  parameters?: Record<string, any>;
  resourceGroup: string;
  name?: string;
  mode?: 'Incremental' | 'Complete';
  principal?: PrincipalRef | null;
  subscriptionId?: string;
  source?: Deployment['source'];
  onProgress?: (msg: string) => void;
}

function makeCtx(input: DeployInput, whatIf: boolean): EvalCtx {
  const s = getState();
  const sub = input.subscriptionId ?? s.currentSubscriptionId;
  const rg = findRg(sub, input.resourceGroup, s);
  if (!rg) throw new ArmError('ResourceGroupNotFound', `Resource group '${input.resourceGroup}' could not be found.`, 404);
  const t = input.template;
  if (!t || typeof t !== 'object') throw new ArmError('InvalidTemplate', 'The template is not a valid JSON object.');
  const principal = (input.principal === undefined ? portalPrincipal() : input.principal) as PrincipalRef;
  if (!principal) throw new ArmError('AuthenticationFailed', "Please run 'az login' to setup account.", 401);
  const ctx: EvalCtx = { s, params: {}, rawVars: t.variables ?? {}, varCache: {}, rg, deploymentName: input.name ?? 'deployment', templateResources: [], whatIf, principal };
  ctx.params = resolveParameters(t, input.parameters ?? {}, ctx);
  const expanded = expandResources(t, ctx);
  ctx.templateResources = expanded.map((x) => ({ type: x.type, name: x.name }));
  return ctx;
}

export function validateTemplate(input: DeployInput): { ok: true; resources: { type: string; name: string }[] } {
  const ctx = makeCtx(input, true);
  const expanded = toposort(expandResources(input.template, ctx), ctx);
  for (const e of expanded) {
    if (!isSupportedType(e.type)) throw new ArmError('NoRegisteredProviderFound', `The resource type '${e.type}' is not supported by Azure Lab (simulador).`);
    evalValue(e.def, { ...ctx, copy: e.copy });
  }
  return { ok: true, resources: expanded.map((e) => ({ type: e.type, name: e.name })) };
}

export async function deployTemplate(input: DeployInput): Promise<Deployment> {
  const s = getState();
  const sub = input.subscriptionId ?? s.currentSubscriptionId;
  const name = input.name ?? `deployment-${Date.now()}`;
  const ctx = makeCtx({ ...input, name }, false);
  authorize(ctx.principal, 'Microsoft.Resources/deployments/write', ctx.rg.id);
  const ordered = toposort(expandResources(input.template, ctx), ctx);
  for (const e of ordered) if (!isSupportedType(e.type)) throw new ArmError('InvalidTemplate', `Deployment template validation failed: 'The resource type '${e.type}' is not supported by Azure Lab (simulador).'`);
  const id = `${ctx.rg.id}/providers/Microsoft.Resources/deployments/${name}`;
  const started = Date.now();
  const dep: Deployment = {
    id,
    name,
    resourceGroup: ctx.rg.name,
    subscriptionId: sub,
    provisioningState: 'Running',
    timestamp: nowIso(),
    mode: input.mode ?? 'Incremental',
    templateHash: String(fnv1a(JSON.stringify(input.template))),
    parameters: Object.fromEntries(Object.entries(ctx.params).map(([k, v]) => [k, { type: typeof v === 'number' ? 'Int' : typeof v === 'boolean' ? 'Bool' : Array.isArray(v) ? 'Array' : typeof v === 'object' ? 'Object' : 'String', value: /password|secret/i.test(k) ? '' : v }])),
    outputs: {},
    outputResources: [],
    source: input.source ?? 'cli',
    template: deepClone(input.template),
  };
  s.deployments = s.deployments.filter((d) => !(ciEq(d.name, name) && ciEq(d.resourceGroup, ctx.rg.name) && d.subscriptionId === sub));
  s.deployments.push(dep);
  logActivity({ operationNameValue: 'Microsoft.Resources/deployments/write', operationName: `Crear implementación ${name}`, status: 'Started', resourceId: id, subscriptionId: sub, caller: ctx.principal.name });
  changed();
  const deployedIds: string[] = [];
  try {
    for (const e of ordered) {
      const ectx = { ...ctx, copy: e.copy };
      const def = evalValue(e.def, ectx);
      input.onProgress?.(`${e.type}/${e.name}`);
      const rid = await applyResource(def, e.type, e.name, ectx, { source: dep.source });
      deployedIds.push(rid);
      dep.outputResources.push({ id: rid, status: 'Succeeded' });
      changed();
    }
    if (dep.mode === 'Complete') {
      const keep = new Set(deployedIds.map((x) => x.toLowerCase()));
      const doomed = s.resources.filter((r) => r.subscriptionId === sub && ciEq(r.resourceGroup, ctx.rg.name) && !getProvider(r.type)?.hidden && ![...keep].some((k) => isWithinScope(k, r.id) || isWithinScope(r.id, k)) && !ciEq(r.type, 'Microsoft.Compute/disks') && !ciEq(r.type, 'Microsoft.Network/networkInterfaces'));
      for (const r of doomed) {
        input.onProgress?.(`Eliminando (modo Complete): ${r.type}/${r.name}`);
        await deleteResource(r.id, { principal: ctx.principal, delayMs: 300 });
      }
    }
    const outs: Record<string, { type: string; value: any }> = {};
    for (const [k, o] of Object.entries<any>(input.template.outputs ?? {})) {
      if (o.condition !== undefined && !evalValue(o.condition, ctx)) continue;
      outs[k] = { type: o.type ?? 'String', value: evalValue(o.value, ctx) };
    }
    dep.outputs = outs;
    dep.provisioningState = 'Succeeded';
  } catch (e: any) {
    dep.provisioningState = 'Failed';
    dep.error = { code: e?.code ?? 'InternalError', message: e?.message ?? String(e) };
    dep.duration = `PT${((Date.now() - started) / 1000).toFixed(1)}S`;
    logActivity({ operationNameValue: 'Microsoft.Resources/deployments/write', operationName: `Crear implementación ${name}`, status: 'Failed', resourceId: id, subscriptionId: sub, caller: ctx.principal.name, message: dep.error.message });
    changed();
    const details = JSON.stringify([{ code: dep.error.code, message: dep.error.message }]);
    const err = new ArmError('DeploymentFailed', `At least one resource deployment operation failed. Please list deployment operations for details. Please see https://aka.ms/arm-deployment-operations for usage details.\nDetails: ${details}`, 400, e?.tip);
    throw err;
  }
  dep.duration = `PT${((Date.now() - started) / 1000).toFixed(1)}S`;
  logActivity({ operationNameValue: 'Microsoft.Resources/deployments/write', operationName: `Crear implementación ${name}`, status: 'Succeeded', resourceId: id, subscriptionId: sub, caller: ctx.principal.name });
  changed();
  return dep;
}

export interface WhatIfChange {
  changeType: 'Create' | 'Modify' | 'Delete' | 'NoChange' | 'Unsupported';
  resourceId: string;
  type: string;
  name: string;
  apiVersion?: string;
  after?: Record<string, any>;
  delta: { path: string; before: any; after: any }[];
}

function flatten(obj: any, prefix = '', out: Record<string, any> = {}): Record<string, any> {
  if (isPlaceholder(obj)) {
    out[prefix] = `[${obj[PLACEHOLDER]}]`;
    return out;
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = obj;
  return out;
}

export function whatIf(input: DeployInput): WhatIfChange[] {
  const ctx = makeCtx(input, true);
  const ordered = toposort(expandResources(input.template, ctx), ctx);
  const changes: WhatIfChange[] = [];
  const touched = new Set<string>();
  for (const e of ordered) {
    const def = evalValue(e.def, { ...ctx, copy: e.copy });
    const id = buildResourceId(ctx.rg.subscriptionId, ctx.rg.name, e.type, e.name);
    touched.add(id.toLowerCase());
    if (!isSupportedType(e.type)) {
      changes.push({ changeType: 'Unsupported', resourceId: id, type: e.type, name: e.name, delta: [] });
      continue;
    }
    const after: Record<string, any> = { apiVersion: def.apiVersion, id, location: def.location ?? (getProvider(e.type) ? ctx.rg.location : undefined), name: e.name, type: e.type };
    if (def.kind) after.kind = def.kind;
    if (def.sku) Object.assign(after, flatten(def.sku, 'sku'));
    if (def.tags) Object.assign(after, flatten(def.tags, 'tags'));
    if (def.properties) Object.assign(after, flatten(def.properties, 'properties'));
    const existing = findResource(id, ctx.s);
    if (!existing) {
      changes.push({ changeType: 'Create', resourceId: id, type: e.type, name: e.name, apiVersion: def.apiVersion, after, delta: [] });
      continue;
    }
    const cur: Record<string, any> = { location: existing.location, kind: existing.kind, ...flatten(existing.sku ?? {}, 'sku'), ...flatten(existing.tags ?? {}, 'tags'), ...flatten(existing.properties ?? {}, 'properties') };
    const delta: WhatIfChange['delta'] = [];
    for (const [k, v] of Object.entries(after)) {
      if (['apiVersion', 'id', 'name', 'type'].includes(k) || v === undefined) continue;
      const before = cur[k];
      const norm = (x: any) => (typeof x === 'string' ? x.toLowerCase().replace(/\s/g, '') : JSON.stringify(x));
      if (before === undefined && (v === null || (Array.isArray(v) && !v.length))) continue;
      if (norm(before) !== norm(v)) delta.push({ path: k, before, after: v });
    }
    for (const k of Object.keys(cur).filter((x) => x.startsWith('tags.'))) if (!(k in after) && def.tags) delta.push({ path: k, before: cur[k], after: undefined });
    changes.push({ changeType: delta.length ? 'Modify' : 'NoChange', resourceId: id, type: e.type, name: e.name, apiVersion: def.apiVersion, after, delta });
  }
  if (input.mode === 'Complete') {
    for (const r of ctx.s.resources.filter((x) => x.subscriptionId === ctx.rg.subscriptionId && ciEq(x.resourceGroup, ctx.rg.name) && !getProvider(x.type)?.hidden)) {
      if (![...touched].some((k) => isWithinScope(k, r.id) || isWithinScope(r.id, k))) changes.push({ changeType: 'Delete', resourceId: r.id, type: r.type, name: r.name, delta: [] });
    }
  }
  return changes;
}

export function formatWhatIf(changes: WhatIfChange[], scope: string, color = true): string {
  const c = (code: string, t: string) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const sym: Record<string, string> = { Create: c('32', '+'), Modify: c('35', '~'), Delete: c('31', '-'), NoChange: c('90', '='), Unsupported: c('33', 'x') };
  const lines: string[] = [];
  lines.push('Note: The result may contain false positive predictions (noise).');
  lines.push('You can help us improve the accuracy of the result by opening an issue here: https://aka.ms/WhatIfIssues');
  lines.push('');
  lines.push('Resource and property changes are indicated with these symbols:');
  const used = [...new Set(changes.map((x) => x.changeType))];
  const label: Record<string, string> = { Create: 'Create', Modify: 'Modify', Delete: 'Delete', NoChange: 'Nochange', Unsupported: 'Unsupported' };
  for (const u of used) lines.push(`  ${sym[u]} ${label[u]}`);
  lines.push('');
  lines.push('The deployment will update the following scope:');
  lines.push('');
  lines.push(`Scope: ${scope}`);
  lines.push('');
  for (const ch of changes) {
    lines.push(`  ${sym[ch.changeType]} ${ch.type}/${ch.name}${ch.apiVersion ? ` [${ch.apiVersion}]` : ''}`);
    if (ch.changeType === 'Create' && ch.after) {
      lines.push('');
      const keys = Object.keys(ch.after).filter((k) => ch.after![k] !== undefined);
      const w = Math.max(...keys.map((k) => k.length)) + 2;
      for (const k of keys) lines.push(`      ${(k + ':').padEnd(w)} ${JSON.stringify(ch.after[k])}`);
      lines.push('');
    }
    if (ch.changeType === 'Modify') {
      lines.push('');
      for (const d of ch.delta) {
        if (d.after === undefined) lines.push(`    ${c('31', '-')} ${d.path}: ${JSON.stringify(d.before)}`);
        else if (d.before === undefined) lines.push(`    ${c('32', '+')} ${d.path}: ${JSON.stringify(d.after)}`);
        else lines.push(`    ${c('35', '~')} ${d.path}: ${JSON.stringify(d.before)} => ${JSON.stringify(d.after)}`);
      }
      lines.push('');
    }
  }
  const counts = (t: string) => changes.filter((x) => x.changeType === t).length;
  const parts = [counts('Create') && `${counts('Create')} to create`, counts('Modify') && `${counts('Modify')} to modify`, counts('Delete') && `${counts('Delete')} to delete`, counts('NoChange') && `${counts('NoChange')} no change`].filter(Boolean);
  lines.push(`Resource changes: ${parts.join(', ') || 'no change'}.`);
  return lines.join('\n');
}

export function deploymentJson(d: Deployment) {
  return {
    id: d.id,
    location: null,
    name: d.name,
    properties: {
      correlationId: guid(),
      debugSetting: null,
      dependencies: [],
      duration: d.duration ?? 'PT0S',
      error: d.error ? { code: d.error.code, message: d.error.message } : null,
      mode: d.mode,
      onErrorDeployment: null,
      outputResources: d.outputResources.map((o) => ({ id: o.id, resourceGroup: d.resourceGroup })),
      outputs: Object.keys(d.outputs).length ? d.outputs : null,
      parameters: d.parameters,
      parametersLink: null,
      providers: [],
      provisioningState: d.provisioningState,
      templateHash: d.templateHash,
      templateLink: null,
      timestamp: d.timestamp,
      validatedResources: null,
    },
    resourceGroup: d.resourceGroup,
    tags: null,
    type: 'Microsoft.Resources/deployments',
  };
}

/** Genera una plantilla ARM a partir de recursos existentes (Exportar plantilla). */
export function exportTemplate(resources: Resource[]): any {
  const params: Record<string, any> = {};
  const res = resources
    .filter((r) => !getProvider(r.type)?.hidden)
    .map((r) => {
      const pname = `${r.type.split('/').pop()}_${r.name.replace(/[^A-Za-z0-9]/g, '_')}_name`;
      params[pname] = { defaultValue: r.name, type: 'String' };
      const arm = resourceToArm(r);
      const out: any = { type: r.type, apiVersion: '2023-01-01', name: `[parameters('${pname}')]`, location: r.location };
      if (r.sku) out.sku = r.sku;
      if (r.kind) out.kind = r.kind;
      if (arm.tags) out.tags = arm.tags;
      if (r.identity) out.identity = { type: r.identity.type };
      const props = { ...arm.properties };
      delete props.provisioningState;
      out.properties = props;
      return out;
    });
  return { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#', contentVersion: '1.0.0.0', parameters: params, variables: {}, resources: res };
}
