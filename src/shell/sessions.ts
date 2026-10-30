// Creación de sesiones de shell (Cloud Shell, VM y agentes de pipeline) y registro de comandos.
import { Session, ExitSignal, type AzState, type CommandDef, type SessionUI, type ShellIO } from './interp';
import { VFS } from './fs';
import { CORE_COMMANDS } from './commands/core';
import { NET_COMMANDS } from './commands/net';
import { DEV_COMMANDS } from './commands/dev';
import { DOCKER_COMMANDS } from './commands/docker';
import { KUBECTL_COMMANDS } from './commands/kubectl';
import { GIT_COMMANDS } from './commands/git';
import { guestCommands, ensureGuestFs } from './commands/guest';
import { runAz, type AzRunHooks } from './az/framework';
import './az/index';
import { getState, changed, homeDir, bus } from '../engine/store';
import { findResource } from '../engine/arm';
import { accessibleSubscriptions } from './az/commands/account';
import { setGuestRunner, setVmSessionFactory } from './vmHost';
import type { PrincipalRef, Resource } from '../engine/types';
import { ciEq, guid } from '../engine/util';
import { eprintln } from './commands/util';

export const azHooks: AzRunHooks = {
  resolvePrincipal: (sess) => (sess.az.loggedIn ? sess.az.principal : null),
  resolveSubscription(sess, override) {
    const s = getState();
    if (override) {
      const subs = sess.az.principal ? accessibleSubscriptions(sess.az.principal) : s.subscriptions;
      const sub = subs.find((x) => ciEq(x.id, override) || ciEq(x.displayName, override));
      if (!sub) throw new Error(`Subscription '${override}' not found. Check the spelling and casing and try again.`);
      return sub.id;
    }
    const id = sess.az.subscriptionId || s.currentSubscriptionId;
    return s.subscriptions.some((x) => x.id === id) ? id : s.subscriptions[0].id;
  },
};

const azCommand: CommandDef = { summary: 'Azure CLI', fn: (argv, ctx) => runAz(argv, ctx, azHooks) };

export function baseCommands(): Record<string, CommandDef> {
  return { ...CORE_COMMANDS, ...NET_COMMANDS, ...DEV_COMMANDS, ...DOCKER_COMMANDS, ...KUBECTL_COMMANDS, ...GIT_COMMANDS, az: azCommand };
}

function logCommand(source: 'shell' | 'pipeline' | 'vm' | 'portal', principal: () => PrincipalRef | null) {
  return (e: { cmd: string; ok: boolean }) => {
    const s = getState();
    s.cli.commandLog.push({ id: guid(), cmd: e.cmd, ts: Date.now(), ok: e.ok, source, principal: principal()?.name });
    if (s.cli.commandLog.length > 800) s.cli.commandLog = s.cli.commandLog.slice(-600);
    changed();
    bus.emit('command', { cmd: e.cmd, ok: e.ok, source });
  };
}

/** Registra en el historial una operación del portal que no pasa por una sesión (p. ej. el Explorador de Resource Graph). */
export function recordPortalCommand(cmd: string, ok: boolean, principal: PrincipalRef | null) {
  logCommand('portal', () => principal)({ cmd, ok });
}

// ---------------------------------------------------------------- Cloud Shell

export function cloudShellAz(): AzState {
  const s = () => getState().cli;
  return {
    get loggedIn() {
      return s().loggedIn;
    },
    set loggedIn(v: boolean) {
      s().loggedIn = v;
    },
    get principal() {
      return s().principal;
    },
    set principal(v: PrincipalRef | null) {
      s().principal = v;
    },
    get subscriptionId() {
      return s().subscriptionId ?? getState().currentSubscriptionId;
    },
    set subscriptionId(v: string) {
      s().subscriptionId = v;
    },
    get defaults() {
      return s().defaults;
    },
    set defaults(v: Record<string, string>) {
      s().defaults = v;
    },
    get acrLogins() {
      return s().acrLogins;
    },
    set acrLogins(v: string[]) {
      s().acrLogins = v;
    },
    get dockerLogins() {
      return s().dockerLogins;
    },
    set dockerLogins(v: string[]) {
      s().dockerLogins = v;
    },
    persist: () => changed(),
  };
}

export function createCloudShellSession(ui: SessionUI): Session {
  const s = getState();
  const home = homeDir(s);
  const user = home.split('/').pop()!;
  const fs = new VFS(s.fs, () => changed());
  if (!fs.isDir(home)) fs.mkdir(home, true);
  const sess = new Session({
    kind: 'cloudshell',
    fs,
    home,
    user,
    host: `SandboxHost-${guid().slice(0, 8)}`,
    cwd: fs.isDir(s.cli.cwd) ? s.cli.cwd : home,
    env: {
      AZURE_HTTP_USER_AGENT: 'cloud-shell/1.0',
      ACC_CLOUD: 'PROD',
      ACC_LOCATION: 'westeurope',
      AZUREPS_HOST_ENVIRONMENT: 'cloud-shell/1.0',
      ACC_TERM_ID: guid().slice(0, 6),
      PS1: '\\u@Azure:\\w$ ',
    },
    commands: baseCommands(),
    ui,
    az: cloudShellAz(),
    history: s.cli.history,
  });
  sess.onCommand = logCommand('shell', () => sess.az.principal);
  return sess;
}

export async function loadBashrc(sess: Session, io: ShellIO) {
  const p = `${sess.home}/.bashrc`;
  if (sess.fs.isFile(p)) {
    try {
      await sess.runScriptFile([p], io, true, true);
    } catch (e) {
      if (!(e instanceof ExitSignal)) console.error(e);
    }
  }
}

// ---------------------------------------------------------------- VM

function ephemeralAz(principal: PrincipalRef | null = null, subscriptionId = getState().currentSubscriptionId): AzState {
  return { loggedIn: !!principal, principal, subscriptionId, defaults: {}, acrLogins: [], dockerLogins: [], persist: () => undefined };
}

export function createVmSession(vm: Resource, user: string, asRoot: boolean, ui?: SessionUI, parentAz?: AzState): Session {
  const root = ensureGuestFs(vm);
  const fs = new VFS(root, () => changed(), asRoot ? [] : ['/etc', '/var', '/usr', '/opt', '/root', '/lib', '/bin', '/sbin']);
  const home = asRoot ? '/root' : `/home/${user}`;
  if (!fs.isDir(home)) fs.mkdir(home, true);
  const base = baseCommands();
  const commands: Record<string, CommandDef> = { ...CORE_COMMANDS, ...NET_COMMANDS, git: base.git, tar: base.tar, python3: base.python3, python: base.python3, pip3: base.pip3, ...guestCommands(base) };
  const az = (vm.data!.guestAz as AzState | undefined) ?? ephemeralAz();
  void parentAz;
  const sess = new Session({
    kind: 'vm',
    fs,
    home,
    user,
    host: vm.properties.osProfile?.computerName ?? vm.name,
    cwd: home,
    commands,
    ui,
    az,
    vmId: vm.id,
    isRoot: asRoot,
  });
  commands.sudo = {
    summary: 'Ejecuta un comando como root',
    async fn(argv, ctx) {
      const args = argv.slice(1);
      if (!args.length) {
        eprintln(ctx.io, 'usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] command');
        return 1;
      }
      const piped = ctx.io.stdin !== null && ['bash', 'sh', '-s'].includes(args[0]);
      if (!piped && (['-i', '-s', 'su', 'bash', '-su'].includes(args[0]) || (args[0] === 'su' && (args[1] === '-' || !args[1])))) {
        if (!ctx.sess.ui.enterSession) {
          eprintln(ctx.io, 'sudo: a terminal is required to read the password');
          return 1;
        }
        const rs = createVmSession(vm, user, true, ctx.sess.ui);
        ctx.sess.ui.enterSession(rs);
        return 0;
      }
      const rs = createVmSession(vm, user, true, ctx.sess.ui);
      rs.cwd = ctx.sess.cwd;
      Object.assign(rs.env, { SUDO_USER: user });
      try {
        return await rs.dispatch(args.filter((a, i) => !(i === 0 && a === '-E')), ctx.io);
      } catch (e) {
        if (e instanceof ExitSignal) return e.code;
        throw e;
      }
    },
  };
  commands.su = { fn: (argv, ctx) => commands.sudo.fn(['sudo', '-i'], ctx) };
  sess.onCommand = logCommand('vm', () => ({ type: 'User', objectId: '', name: `${user}@${vm.name}`, displayName: user }));
  return sess;
}

/** Ejecuta un script como root dentro de la VM (run-command, CustomScript, cloud-init). */
async function runGuest(vm: Resource, script: string, asRoot: boolean) {
  const user = vm.properties.osProfile?.adminUsername ?? 'azureuser';
  const sess = createVmSession(vm, user, asRoot);
  let stdout = '';
  let stderr = '';
  const io: ShellIO = { stdin: null, out: (s) => (stdout += s), err: (s) => (stderr += s), isTTY: false, signal: new AbortController().signal };
  let code = 0;
  if (vm.data?.osType === 'Windows') {
    const r = runPowerShell(vm, script);
    return { stdout: r.out, stderr: r.err, code: r.code };
  }
  try {
    code = await sess.run(script, io);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else {
      stderr += String((e as Error)?.message ?? e);
      code = 1;
    }
  }
  changed();
  return { stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr: stderr.replace(/\x1b\[[0-9;]*m/g, ''), code };
}

/** Mini intérprete de PowerShell para VMs Windows (run-command RunPowerShellScript). */
function runPowerShell(vm: Resource, script: string): { out: string; err: string; code: number } {
  let out = '';
  let err = '';
  for (const raw of script.split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean)) {
    if (/^Install-WindowsFeature\s+(-name\s+)?Web-Server/i.test(raw)) {
      vm.data!.services.W3SVC = 'running';
      out += '\nSuccess Restart Needed Exit Code      Feature Result\n------- -------------- ---------      --------------\nTrue    No             Success        {Common HTTP Features, Default Document, D...\n';
    } else if (/^Get-Service\s+(\w+)/i.test(raw)) {
      const n = /^Get-Service\s+(\w+)/i.exec(raw)![1];
      out += `\nStatus   Name               DisplayName\n------   ----               -----------\n${(vm.data!.services[n] === 'running' ? 'Running' : 'Stopped').padEnd(8)} ${n.padEnd(18)} ${n}\n`;
    } else if (/^(Write-Output|echo|Write-Host)\s+(.*)$/i.test(raw)) out += /^(?:Write-Output|echo|Write-Host)\s+(.*)$/i.exec(raw)![1].replace(/^["']|["']$/g, '') + '\n';
    else if (/^hostname$/i.test(raw)) out += (vm.properties.osProfile?.computerName ?? vm.name) + '\n';
    else if (/^Restart-Computer/i.test(raw)) out += '';
    else if (/^Set-Content|^Add-Content/i.test(raw)) out += '';
    else err += `${raw.split(' ')[0]} : The term '${raw.split(' ')[0]}' is not recognized in the simulator.\n`;
  }
  changed();
  return { out, err, code: err ? 1 : 0 };
}

setGuestRunner(runGuest);
setVmSessionFactory((req, parent) => createVmSession(req.vm, req.user, req.asRoot, parent?.ui));

// ---------------------------------------------------------------- agentes de pipeline

export function createAgentSession(opts: { fs: VFS; workDir: string; env: Record<string, string>; principal?: PrincipalRef | null; subscriptionId?: string; log?: (s: string) => void }): Session {
  const sess = new Session({
    kind: 'agent',
    fs: opts.fs,
    home: '/home/vsts',
    user: 'vsts',
    host: `fv-az${Math.floor(Math.random() * 900 + 100)}-${Math.floor(Math.random() * 900 + 100)}`,
    cwd: opts.workDir,
    env: { AGENT_OS: 'Linux', AGENT_NAME: 'Hosted Agent', TF_BUILD: 'True', ...opts.env },
    commands: baseCommands(),
    az: ephemeralAz(opts.principal ?? null, opts.subscriptionId),
  });
  sess.onCommand = logCommand('pipeline', () => sess.az.principal);
  return sess;
}

// ---------------------------------------------------------------- portal

/**
 * Sesión interna que usa el portal para ejecutar sus acciones como comandos az
 * (misma validación y mismos errores que la CLI). Se registra con origen "portal".
 */
export function createPortalSession(principal: PrincipalRef, subscriptionId: string): Session {
  const fs = new VFS({ t: 'd', c: {}, mt: Date.now() });
  fs.mkdir('/home/portal', true);
  const sess = new Session({
    kind: 'agent',
    fs,
    home: '/home/portal',
    user: 'portal',
    host: 'portal.azure.com',
    commands: baseCommands(),
    az: ephemeralAz(principal, subscriptionId),
  });
  sess.onCommand = logCommand('portal', () => sess.az.principal);
  return sess;
}

export function vmById(id: string): Resource | undefined {
  return findResource(id);
}
