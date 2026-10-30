// Framework de Azure CLI simulada: registro de comandos, análisis de argumentos, ayuda y salida.
import { search as jmesSearch } from 'jmespath';
import type { CmdCtx, ShellIO, Session } from '../interp';
import type { PrincipalRef } from '../../engine/types';
import { ArmError } from '../../engine/errors';
import { closest } from '../../engine/util';
import { formatOutput } from './output';
import { FsError } from '../fs';

export type ArgType = 'string' | 'bool' | 'int' | 'float' | 'list' | 'kv' | 'json';

export interface AzArg {
  name: string;
  opts: string[];
  help: string;
  required?: boolean;
  type?: ArgType;
  choices?: string[];
  default?: any;
  configKey?: string;
  hidden?: boolean;
  /** Para listas: cada aparición del argumento toma un único valor (action="append" de argparse). */
  append?: boolean;
}

export type Args = Record<string, any>;

export interface AzCtx {
  sess: Session;
  io: ShellIO;
  principal: PrincipalRef;
  subscriptionId: string;
  warn(msg: string): void;
  info(msg: string): void;
  progress<T>(p: Promise<T>, label?: string): Promise<T>;
  confirm(question: string): Promise<boolean>;
  readFileArg(path: string): string;
  output: string;
}

export interface AzCmd {
  path: string;
  summary: string;
  args: AzArg[];
  examples?: { title: string; cmd: string }[];
  confirm?: string | ((a: Args) => string | null);
  noLogin?: boolean;
  longRunning?: boolean;
  table?: (result: any, a: Args) => any;
  run(a: Args, ctx: AzCtx): Promise<any> | any;
  preview?: boolean;
  defaultOutput?: string;
  /** Nombre del argumento que recoge los valores posicionales (sin opción). */
  positional?: string;
}

const commands = new Map<string, AzCmd>();
const groups = new Map<string, string>();

export function group(path: string, summary: string) {
  groups.set(path, summary);
}

export function register(c: AzCmd) {
  commands.set(c.path, c);
  const parts = c.path.split(' ');
  for (let i = 1; i < parts.length; i++) {
    const g = parts.slice(0, i).join(' ');
    if (!groups.has(g)) groups.set(g, '');
  }
}

export function allAzCommands(): AzCmd[] {
  return [...commands.values()];
}

export function azGroups(): Map<string, string> {
  return groups;
}

// ---------------------------------------------------------------- argumentos comunes

export const A = {
  rg: (required = true): AzArg => ({ name: 'resource_group', opts: ['--resource-group', '-g'], help: 'Nombre del grupo de recursos. Puedes configurar uno por defecto con `az configure --defaults group=<nombre>`.', required, configKey: 'group' }),
  name: (help = 'Nombre del recurso.', required = true, extra: string[] = []): AzArg => ({ name: 'name', opts: ['--name', '-n', ...extra], help, required }),
  location: (required = false): AzArg => ({ name: 'location', opts: ['--location', '-l'], help: 'Ubicación (región). Valores: `az account list-locations`. Por defecto, la del grupo de recursos.', required, configKey: 'location' }),
  tags: (): AzArg => ({ name: 'tags', opts: ['--tags'], help: 'Etiquetas separadas por espacios: clave[=valor] [clave[=valor] ...]. Usa "" para borrar las existentes.', type: 'kv' }),
  noWait: (): AzArg => ({ name: 'no_wait', opts: ['--no-wait'], help: 'No esperar a que termine la operación de larga duración.', type: 'bool' }),
  yes: (): AzArg => ({ name: 'yes', opts: ['--yes', '-y'], help: 'No pedir confirmación.', type: 'bool' }),
  ids: (): AzArg => ({ name: 'ids', opts: ['--ids'], help: 'Uno o varios IDs de recurso (separados por espacios). Si se indica, no hace falta pasar otros argumentos de "Resource Id".', type: 'list' }),
  sku: (help: string, choices?: string[], def?: string): AzArg => ({ name: 'sku', opts: ['--sku'], help, choices, default: def }),
};

// ---------------------------------------------------------------- análisis

class UsageError extends Error {}

function parseArgs(cmd: AzCmd, tokens: string[], sess: Session): { args: Args; globals: Record<string, any> } {
  const args: Args = {};
  const globals: Record<string, any> = { output: undefined, query: undefined };
  const unrecognized: string[] = [];
  const byOpt = new Map<string, AzArg>();
  for (const a of cmd.args) for (const o of a.opts) byOpt.set(o, a);
  const GLOBAL: Record<string, { key: string; bool?: boolean }> = {
    '--output': { key: 'output' },
    '-o': { key: 'output' },
    '--query': { key: 'query' },
    '--subscription': { key: 'subscription' },
    '--only-show-errors': { key: 'only_show_errors', bool: true },
    '--verbose': { key: 'verbose', bool: true },
    '--debug': { key: 'debug', bool: true },
    '--help': { key: 'help', bool: true },
    '-h': { key: 'help', bool: true },
  };
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    let inline: string | undefined;
    if (tok.startsWith('--') && tok.includes('=')) {
      inline = tok.slice(tok.indexOf('=') + 1);
      tok = tok.slice(0, tok.indexOf('='));
    }
    const def = byOpt.get(tok);
    if (!def && GLOBAL[tok]) {
      const g = GLOBAL[tok];
      if (g.bool) globals[g.key] = true;
      else {
        const v = inline ?? tokens[++i];
        if (v === undefined) throw new UsageError(`argument ${tok}: expected one argument`);
        globals[g.key] = v;
      }
      continue;
    }
    if (!def) {
      if (cmd.positional && !tokens[i].startsWith('-')) {
        args[cmd.positional] = [...(args[cmd.positional] ?? []), tokens[i]];
        continue;
      }
      unrecognized.push(tokens[i]);
      continue;
    }
    const type = def.type ?? 'string';
    if (type === 'bool') {
      const nx = inline ?? tokens[i + 1];
      if (nx !== undefined && /^(true|false|yes|no|1|0|enabled|disabled)$/i.test(nx)) {
        args[def.name] = /^(true|yes|1|enabled)$/i.test(nx);
        if (inline === undefined) i++;
      } else args[def.name] = true;
      continue;
    }
    if (type === 'list' || type === 'kv') {
      const vals: string[] = inline !== undefined ? [inline] : [];
      if (def.append && inline === undefined && i + 1 < tokens.length) vals.push(tokens[++i]);
      while (!def.append && inline === undefined && i + 1 < tokens.length && !(tokens[i + 1].startsWith('-') && !/^-\d/.test(tokens[i + 1]) && tokens[i + 1].length > 1)) vals.push(tokens[++i]);
      if (!vals.length && type === 'list') throw new UsageError(`argument ${def.opts.join('/')}: expected at least one argument`);
      args[def.name] = [...(args[def.name] ?? []), ...vals];
      continue;
    }
    const v = inline ?? tokens[++i];
    if (v === undefined) throw new UsageError(`argument ${def.opts.join('/')}: expected one argument`);
    args[def.name] = v;
  }
  if (globals.help) return { args, globals };
  if (unrecognized.length) throw new UsageError(`unrecognized arguments: ${unrecognized.join(' ')}`);
  for (const a of cmd.args) {
    if (args[a.name] === undefined && a.configKey && sess.az.defaults[a.configKey]) args[a.name] = sess.az.defaults[a.configKey];
    if (args[a.name] === undefined && a.default !== undefined) args[a.name] = a.default;
  }
  const hasIds = Array.isArray(args.ids) && args.ids.length;
  const missing = cmd.args.filter((a) => a.required && (args[a.name] === undefined || args[a.name] === '') && !(hasIds && ['name', 'resource_group', 'vault_name', 'account_name', 'server'].includes(a.name)));
  if (missing.length) throw new UsageError(`the following arguments are required: ${missing.map((a) => a.opts.join('/')).join(', ')}`);
  for (const a of cmd.args) {
    const v = args[a.name];
    if (v === undefined || v === null) continue;
    if (a.choices && typeof v === 'string') {
      const c = a.choices.find((x) => x.toLowerCase() === v.toLowerCase());
      if (!c) throw new UsageError(`argument ${a.opts.join('/')}: invalid choice: '${v}' (choose from ${a.choices.map((x) => `'${x}'`).join(', ')})`);
      args[a.name] = c;
    }
    if (a.type === 'int' || a.type === 'float') {
      const n = Number(v);
      if (Number.isNaN(n) || (a.type === 'int' && !Number.isInteger(n))) throw new UsageError(`argument ${a.opts.join('/')}: invalid ${a.type} value: '${v}'`);
      args[a.name] = n;
    }
    if (a.type === 'kv') {
      const out: Record<string, string> = {};
      for (const pair of v as string[]) {
        if (pair === '') continue;
        const eq = pair.indexOf('=');
        if (eq < 0) out[pair] = '';
        else out[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      args[a.name] = out;
    }
    if (a.type === 'json' && typeof v === 'string') {
      let text = v;
      if (text.startsWith('@')) text = readFileArg(sess, text.slice(1));
      try {
        args[a.name] = JSON.parse(text);
      } catch {
        throw new UsageError(`argument ${a.opts.join('/')}: Failed to parse string as JSON: ${v.slice(0, 60)}`);
      }
    }
  }
  return { args, globals };
}

function readFileArg(sess: Session, path: string): string {
  try {
    return sess.fs.readFile(sess.resolve(path));
  } catch (e) {
    if (e instanceof FsError) throw new UsageError(`[Errno 2] No such file or directory: '${path}'`);
    throw e;
  }
}

// ---------------------------------------------------------------- ayuda

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

export function groupHelp(path: string): string {
  const out: string[] = [];
  out.push('');
  out.push('Group');
  out.push(`    az ${path}${groups.get(path) ? ` : ${groups.get(path)}` : ''}`);
  const depth = path ? path.split(' ').length : 0;
  const subgroups = [...groups.keys()].filter((g) => g.startsWith(path ? path + ' ' : '') && g.split(' ').length === depth + 1).sort();
  const cmds = [...commands.values()].filter((c) => c.path.startsWith(path ? path + ' ' : '') && c.path.split(' ').length === depth + 1).sort((a, b) => a.path.localeCompare(b.path));
  const w = Math.max(10, ...[...subgroups, ...cmds.map((c) => c.path)].map((x) => x.split(' ').pop()!.length)) + 2;
  if (subgroups.length) {
    out.push('');
    out.push('Subgroups:');
    for (const g of subgroups) out.push(`    ${g.split(' ').pop()!.padEnd(w)}: ${wrap(groups.get(g) || 'Comandos de ' + g.split(' ').pop(), 70, ' '.repeat(w + 6))}`);
  }
  if (cmds.length) {
    out.push('');
    out.push('Commands:');
    for (const c of cmds) out.push(`    ${c.path.split(' ').pop()!.padEnd(w)}: ${wrap(c.summary, 70, ' '.repeat(w + 6))}${c.preview ? ' [Preview]' : ''}`);
  }
  out.push('');
  out.push(`To search AI knowledge base for examples, use: az find "az ${path}"`);
  return out.join('\n');
}

export function commandHelp(c: AzCmd): string {
  const out: string[] = [];
  out.push('');
  out.push('Command');
  out.push(`    az ${c.path} : ${wrap(c.summary, 80, '        ')}`);
  const visible = c.args.filter((a) => !a.hidden);
  const req = visible.filter((a) => a.required);
  const opt = visible.filter((a) => !a.required);
  const fmt = (a: AzArg) => {
    const name = a.opts.join(' ');
    const extra = [a.required ? '[Required]' : '', a.choices ? `Valores permitidos: ${a.choices.join(', ')}.` : '', a.default !== undefined && a.default !== false ? `Por defecto: ${a.default}.` : ''].filter(Boolean).join(' ');
    return `    ${name.padEnd(30)}: ${wrap(`${a.help}${extra ? ' ' + extra : ''}`, 75, ' '.repeat(36))}`;
  };
  out.push('');
  out.push('Arguments');
  for (const a of req) out.push(fmt(a));
  for (const a of opt) out.push(fmt(a));
  out.push('');
  out.push('Global Arguments');
  out.push(`    ${'--debug'.padEnd(30)}: Aumenta el detalle del registro para mostrar todos los registros de depuración.`);
  out.push(`    ${'--help -h'.padEnd(30)}: Muestra este mensaje de ayuda y sale.`);
  out.push(`    ${'--only-show-errors'.padEnd(30)}: Muestra sólo errores, suprimiendo advertencias.`);
  out.push(`    ${'--output -o'.padEnd(30)}: Formato de salida. Valores permitidos: json, jsonc, none, table, tsv, yaml, yamlc. Por defecto: json.`);
  out.push(`    ${'--query'.padEnd(30)}: Cadena de consulta JMESPath. Ver http://jmespath.org/ para más información y ejemplos.`);
  out.push(`    ${'--subscription'.padEnd(30)}: Nombre o ID de la suscripción. Puedes configurar la predeterminada con \`az account set -s NAME_OR_ID\`.`);
  out.push(`    ${'--verbose'.padEnd(30)}: Aumenta el detalle del registro.`);
  if (c.examples?.length) {
    out.push('');
    out.push('Examples');
    for (const e of c.examples) {
      out.push(`    ${e.title}`);
      out.push(`        ${e.cmd}`);
      out.push('');
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- ejecución

const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface AzRunHooks {
  resolvePrincipal(sess: Session): PrincipalRef | null;
  resolveSubscription(sess: Session, override?: string): string;
}

export async function runAz(argv: string[], ctx: CmdCtx, hooks: AzRunHooks): Promise<number> {
  const { sess, io } = ctx;
  const tokens = argv.slice(1);
  const pathParts: string[] = [];
  let i = 0;
  while (i < tokens.length && !tokens[i].startsWith('-')) {
    const candidate = [...pathParts, tokens[i]].join(' ');
    if (commands.has(candidate) || groups.has(candidate)) {
      pathParts.push(tokens[i]);
      i++;
      if (commands.has(candidate)) break;
    } else break;
  }
  const path = pathParts.join(' ');
  const rest = tokens.slice(i);
  if (!path) {
    if (tokens[0] === '--version' || tokens[0] === 'version') return runAz(['az', 'version'], ctx, hooks);
    if (!tokens.length || tokens[0] === '--help' || tokens[0] === '-h') {
      io.out(AZ_BANNER + groupHelp('') + '\n');
      return 0;
    }
    const all = [...new Set([...groups.keys()].filter((g) => !g.includes(' ')))];
    const sug = closest(tokens[0], all, 3);
    io.err(RED(`ERROR: '${tokens[0]}' is misspelled or not recognized by the system.`) + '\n');
    if (sug) io.err(`Did you mean '${sug}' ?\n`);
    io.err(`\nExamples from AI knowledge base:\naz --help\n    Muestra todos los grupos de comandos disponibles.\n\nhttps://aka.ms/cli_ref\nRead more about the command in reference docs\n`);
    return 2;
  }
  const cmd = commands.get(path);
  if (!cmd) {
    if (!rest.length || rest[0] === '--help' || rest[0] === '-h') {
      io.out(groupHelp(path) + '\n');
      return 0;
    }
    const next = rest.find((t) => !t.startsWith('-'));
    if (next) {
      const opts = [...groups.keys(), ...commands.keys()].filter((g) => g.startsWith(path + ' ') && g.split(' ').length === path.split(' ').length + 1).map((g) => g.split(' ').pop()!);
      const sug = closest(next, opts, 3);
      io.err(RED(`ERROR: 'az ${path}' does not have a command named '${next}'.`) + '\n');
      if (sug) io.err(`The most similar choice to '${next}' is: ${sug}\n`);
    } else io.err(RED(`ERROR: the following arguments are required: _subcommand`) + '\n');
    io.err(`\nPrueba: az ${path} --help\n`);
    return 2;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(cmd, rest, sess);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(RED(`ERROR: ${e.message}`) + '\n');
      io.err(`\nExamples from AI knowledge base:\n`);
      for (const ex of (cmd.examples ?? []).slice(0, 2)) io.err(`${ex.cmd}\n    ${ex.title}\n\n`);
      io.err(`https://docs.microsoft.com/en-US/cli/azure/${cmd.path.split(' ')[0]}#az-${cmd.path.replace(/ /g, '-')}\nRead more about the command in reference docs\n`);
      return 2;
    }
    throw e;
  }
  const { args, globals } = parsed;
  if (globals.help) {
    io.out(commandHelp(cmd) + '\n');
    return 0;
  }
  const output = (globals.output ?? sess.az.defaults.output ?? cmd.defaultOutput ?? 'json').toLowerCase();
  if (!['json', 'jsonc', 'table', 'tsv', 'yaml', 'yamlc', 'none'].includes(output)) {
    io.err(RED(`ERROR: argument --output/-o: invalid choice: '${globals.output}' (choose from 'json', 'jsonc', 'none', 'table', 'tsv', 'yaml', 'yamlc')`) + '\n');
    return 2;
  }
  let principal = hooks.resolvePrincipal(sess);
  if (!cmd.noLogin && !principal) {
    io.err(RED(`ERROR: Please run 'az login' to setup account.`) + '\n');
    return 1;
  }
  let subscriptionId = '';
  try {
    subscriptionId = hooks.resolveSubscription(sess, globals.subscription);
  } catch (e) {
    io.err(RED(`ERROR: ${(e as Error).message}`) + '\n');
    return 1;
  }
  const quiet = !!globals.only_show_errors;
  // Mientras gira el indicador "Running ..", los avisos borran primero esa línea para no mezclarse con él.
  let spinning = false;
  const clearSpinner = () => (spinning ? '\r\x1b[K' : '');
  const actx: AzCtx = {
    sess,
    io,
    principal: principal!,
    subscriptionId,
    output,
    warn: (m) => {
      if (!quiet) io.err(clearSpinner() + YEL(`WARNING: ${m}`) + '\n');
    },
    info: (m) => {
      if (globals.verbose || globals.debug) io.err(`${clearSpinner()}INFO: ${m}\n`);
    },
    async progress<T>(p: Promise<T>, label = 'Running'): Promise<T> {
      if (!io.isTTY) return p;
      const frames = ['|', '/', '-', '\\'];
      let k = 0;
      spinning = true;
      const timer = setInterval(() => io.err(`\r ${frames[k++ % 4]} ${label} ..`), 120);
      try {
        return await p;
      } finally {
        clearInterval(timer);
        spinning = false;
        io.err('\r\x1b[K');
      }
    },
    async confirm(question: string) {
      if (!io.prompt || !io.isTTY) {
        throw new ArmError('NoTTY', 'Unable to prompt for confirmation as no tty available. Use --yes.');
      }
      const ans = (await io.prompt(`${question} (y/n): `)).trim().toLowerCase();
      return ans === 'y' || ans === 'yes';
    },
    readFileArg: (p) => readFileArg(sess, p),
  };
  try {
    const confirmText = typeof cmd.confirm === 'function' ? cmd.confirm(args) : cmd.confirm;
    if (confirmText && !args.yes) {
      const ok = await actx.confirm(confirmText);
      if (!ok) return 0;
    }
    if (globals.debug) io.err(`DEBUG: cli.knack.cli: Command arguments: ${JSON.stringify(rest)}\nDEBUG: cli.azure.cli.core: Current cloud config:\nAzureCloud\n`);
    let result = await (cmd.longRunning && !args.no_wait ? actx.progress(Promise.resolve(cmd.run(args, actx))) : cmd.run(args, actx));
    if (result === undefined) return 0;
    if (globals.query) {
      try {
        result = jmesSearch(result, globals.query);
      } catch (e) {
        io.err(RED(`ERROR: argument --query: invalid jmespath_type value: '${globals.query}'`) + '\n');
        io.err(`\x1b[2m(${(e as Error).message})\x1b[0m\n`);
        return 2;
      }
    } else if (output === 'table' && cmd.table) result = cmd.table(result, args);
    const text = formatOutput(result, output, io.isTTY);
    if (text) io.out(text + '\n');
    return 0;
  } catch (e) {
    if ((e as Error)?.message === 'aborted') throw e;
    if (e instanceof ArmError) {
      if (e.code === 'NoTTY') io.err(RED(`ERROR: ${e.message}`) + '\n');
      else if (['AuthenticationFailed'].includes(e.code) && e.message.includes('az login')) io.err(RED(`ERROR: ${e.message}`) + '\n');
      else if (e.code === 'CliError') io.err(RED(`ERROR: ${e.message}`) + '\n');
      else io.err(RED(`ERROR: (${e.code}) ${e.message.split('\n')[0]}`) + `\n${RED(`Code: ${e.code}`)}\n${RED(`Message: ${e.message}`)}\n`);
      if (e.tip) io.err(`\x1b[2m💡 ${e.tip}\x1b[0m\n`);
      return e.code === 'CliError' && e.status === 2 ? 2 : 1;
    }
    if (e instanceof UsageError) {
      io.err(RED(`ERROR: ${e.message}`) + '\n');
      return 2;
    }
    io.err(RED(`ERROR: ${(e as Error)?.message ?? e}`) + '\n');
    console.error(e);
    return 1;
  }
}

/** Error de validación del lado del cliente (sin código ARM). */
export function cliError(message: string, tip?: string, usage = false): ArmError {
  return new ArmError('CliError', message, usage ? 2 : 1, tip);
}

const AZ_BANNER = `
     /\\
    /  \\    _____   _ _  ___ _
   / /\\ \\  |_  / | | | \\'__/ _\\
  / ____ \\  / /| |_| | | |  __/
 /_/    \\_\\/___|\\__,_|_|  \\___|


Welcome to the cool new Azure CLI! (Simulador Azure Lab)

Use \`az --version\` to display the current version.
Here are the base commands:
`;
