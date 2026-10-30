// El portal ejecuta sus acciones como comandos az (misma validación, mismos errores y el comando
// equivalente se puede mostrar al estudiante).
import { createPortalSession } from '../shell/sessions';
import { ExitSignal, shQuote, type Session, type ShellIO } from '../shell/interp';
import { getState, portalPrincipal } from '../engine/store';
import { notify } from '../engine/arm';
import { toast } from './uiStore';

let sess: Session | null = null;

function session(): Session {
  const s = getState();
  if (!sess || sess.az.principal?.objectId !== s.me.objectId) sess = createPortalSession(portalPrincipal(), s.currentSubscriptionId);
  sess.az.principal = portalPrincipal();
  sess.az.loggedIn = true;
  return sess;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
  json: any;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Ejecuta un comando az (argv sin el "az" inicial). Los ficheros indicados se escriben antes en la sesión del portal. */
export async function az(args: string[], opts: { files?: Record<string, string>; subscription?: string } = {}): Promise<CliResult> {
  const sh = session();
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    const abs = p.startsWith('/') ? p : `/home/portal/${p}`;
    sh.fs.mkdir(abs.split('/').slice(0, -1).join('/'), true);
    sh.fs.writeFile(abs, c);
  }
  sh.az.subscriptionId = opts.subscription ?? getState().currentSubscriptionId;
  let out = '';
  let err = '';
  const io: ShellIO = { stdin: null, out: (s) => (out += s), err: (s) => (err += s), isTTY: false, signal: new AbortController().signal };
  const argv = ['az', ...args];
  if (!args.includes('-o') && !args.includes('--output')) argv.push('-o', 'json');
  let code: number;
  try {
    code = await sh.dispatch(argv, io);
  } catch (e) {
    code = e instanceof ExitSignal ? e.code : 1;
    if (!(e instanceof ExitSignal)) err += String((e as Error)?.message ?? e);
  }
  out = strip(out);
  err = strip(err);
  let json: any = null;
  try {
    json = out.trim() ? JSON.parse(out) : null;
  } catch {
    json = null;
  }
  return { code, out, err, json };
}

/** Texto del comando tal y como lo escribiría el estudiante. */
export function cliText(args: string[]): string {
  return 'az ' + args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shQuote(a))).join(' ');
}

/** Primera línea útil del error de la CLI (sin la pista). */
export function errorText(r: CliResult): string {
  const lines = r.err.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('💡'));
  const main = lines.find((l) => l.startsWith('ERROR:')) ?? lines[0] ?? 'Error desconocido';
  return main.replace(/^ERROR:\s*/, '');
}

export function tipText(r: CliResult): string | undefined {
  return r.err
    .split('\n')
    .find((l) => l.trim().startsWith('💡'))
    ?.trim()
    .replace(/^💡\s*/, '');
}

/**
 * Ejecuta una acción del portal mostrando notificaciones como el portal real.
 * Devuelve el resultado o null si falló.
 */
export async function portalAction(title: string, args: string[], opts: { files?: Record<string, string>; success?: string; quiet?: boolean; subscription?: string } = {}): Promise<CliResult | null> {
  const r = await az(args, opts);
  if (r.code !== 0) {
    const msg = errorText(r);
    const tip = tipText(r);
    notify({ title: `Error: ${title}`, message: msg + (tip ? `\n💡 ${tip}` : ''), level: 'error' });
    toast(`Error: ${title}`, 'error', msg);
    return null;
  }
  if (!opts.quiet) toast(opts.success ?? `${title}: completado`, 'success');
  return r;
}
