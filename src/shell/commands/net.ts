// Comandos de red: curl, wget, ping, nslookup, dig, host, nc, telnet, ssh, ssh-keygen, scp.
import type { CommandDef, CmdCtx } from '../interp';
import { C, delay, eprintln, hint, parseFlags, println } from './util';
import { httpGet, parseUrl, resolveDns, tcpProbe, type FetchResult } from '../../engine/services/net';
import { getState, changed, speedFactor } from '../../engine/store';
import { ciEq, guid, shortHash } from '../../engine/util';
import { vmNetworkInfo, vmPowerState } from '../../engine/providers/compute';
import { inboundAllowed } from '../../engine/providers/network';
import { findResource } from '../../engine/arm';
import { createVmSession } from '../vmHost';
import type { Resource } from '../../engine/types';

function currentVm(ctx: CmdCtx): Resource | null {
  return ctx.sess.vmId ? findResource(ctx.sess.vmId) ?? null : null;
}

async function netDelay(ctx: CmdCtx, ms: number) {
  await delay(Math.max(20, ms * Math.max(0.1, speedFactor() || 0.1)), ctx.io);
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

function errCode(msg: string): number {
  const m = /curl: \((\d+)\)/.exec(msg);
  return m ? Number(m[1]) : 7;
}

const curl: CommandDef = {
  summary: 'Transfiere datos desde/hacia una URL',
  async fn(argv, ctx) {
    const { flags, opts, rest } = parseFlags(argv.slice(1), ['o', 'w', 'X', 'H', 'd', 'm', 'u', 'A', 'request', 'header', 'data', 'output', 'write-out', 'max-time', 'connect-timeout', 'user', 'user-agent', 'retry', 'data-raw', 'json']);
    const silent = flags.has('s') || flags.has('silent');
    const showErr = flags.has('S') || flags.has('show-error');
    const include = flags.has('i') || flags.has('include');
    const head = flags.has('I') || flags.has('head');
    const verbose = flags.has('v') || flags.has('verbose');
    const follow = flags.has('L') || flags.has('location');
    const failFlag = flags.has('f') || flags.has('fail');
    const output = opts.o ?? opts.output;
    const remoteName = flags.has('O') || flags.has('remote-name');
    const writeOut = opts.w ?? opts['write-out'];
    if (!rest.length) {
      eprintln(ctx.io, "curl: try 'curl --help' or 'curl --manual' for more information");
      return 2;
    }
    let code = 0;
    for (const rawUrl of rest) {
      let url = rawUrl;
      let res: FetchResult = { ok: false, error: '' };
      const t0 = Date.now();
      for (let hop = 0; hop < 5; hop++) {
        const u = parseUrl(url);
        if (verbose && u) {
          const ip = resolveDns(u.host)?.ip ?? '?';
          ctx.io.err(`*   Trying ${ip}:${u.port}...\n`);
        }
        res = httpGet(url, { fromVm: currentVm(ctx) });
        await netDelay(ctx, res.ok ? 150 : /\(28\)/.test(res.error ?? '') ? 2500 : 200);
        if (verbose && res.ok && u) {
          ctx.io.err(`* Connected to ${u.host} (${resolveDns(u.host)?.ip}) port ${u.port}\n> ${head ? 'HEAD' : opts.X ?? opts.request ?? 'GET'} ${u.path}${u.query ? '?' + u.query : ''} HTTP/1.1\n> Host: ${u.host}\n> User-Agent: curl/8.5.0\n> Accept: */*\n>\n< HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status!] ?? ''}\n`);
          for (const [k, v] of Object.entries(res.headers ?? {})) ctx.io.err(`< ${k}: ${v}\n`);
          ctx.io.err('<\n');
        }
        if (res.ok && follow && (res.status === 301 || res.status === 302) && res.headers?.Location) {
          url = res.headers.Location;
          continue;
        }
        break;
      }
      if (!res.ok) {
        if (!silent || showErr) eprintln(ctx.io, res.error ?? 'curl: (7) Failed to connect');
        if (res.hint && ctx.io.isTTY) hint(ctx.io, res.hint);
        code = errCode(res.error ?? '');
        if (writeOut) ctx.io.out(formatWriteOut(writeOut, 0, (Date.now() - t0) / 1000, '', 0));
        continue;
      }
      if (failFlag && (res.status ?? 0) >= 400) {
        if (!silent || showErr) eprintln(ctx.io, `curl: (22) The requested URL returned error: ${res.status}`);
        code = 22;
        continue;
      }
      let text = '';
      if (include || head) {
        text += `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status!] ?? ''}\r\n`;
        text += `Date: ${new Date().toUTCString()}\r\n`;
        for (const [k, v] of Object.entries(res.headers ?? {})) text += `${k}: ${v}\r\n`;
        text += `Content-Length: ${new TextEncoder().encode(res.body ?? '').length}\r\n\r\n`;
      }
      if (!head) text += res.body ?? '';
      const target = output ?? (remoteName ? (parseUrl(url)?.path.split('/').pop() || 'index.html') : undefined);
      if (target) {
        try {
          ctx.sess.fs.writeFile(ctx.sess.resolve(target), res.body ?? '');
        } catch {
          eprintln(ctx.io, `curl: (23) Failure writing output to destination`);
          code = 23;
          continue;
        }
        if (!silent) ctx.io.err(`  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100  ${String((res.body ?? '').length).padStart(5)}  100  ${String((res.body ?? '').length).padStart(5)}    0     0   9821      0 --:--:-- --:--:-- --:--:--  9851\n`);
      } else {
        ctx.io.out(text);
        if (ctx.io.isTTY && text && !text.endsWith('\n') && !writeOut) ctx.io.out('\n');
      }
      if (writeOut) ctx.io.out(formatWriteOut(writeOut, res.status ?? 0, (Date.now() - t0) / 1000, resolveDns(parseUrl(url)?.host ?? '')?.ip ?? '', (res.body ?? '').length));
    }
    return code;
  },
};

function formatWriteOut(fmt: string, code: number, time: number, ip: string, size: number): string {
  return fmt
    .replace(/%\{http_code\}|%\{response_code\}/g, String(code).padStart(3, '0'))
    .replace(/%\{time_total\}/g, time.toFixed(6))
    .replace(/%\{remote_ip\}/g, ip)
    .replace(/%\{size_download\}/g, String(size))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

const wget: CommandDef = {
  summary: 'Descarga ficheros desde la web',
  async fn(argv, ctx) {
    const { flags, opts, rest } = parseFlags(argv.slice(1), ['O', 'output-document']);
    const url = rest[0];
    if (!url) {
      eprintln(ctx.io, 'wget: missing URL');
      return 1;
    }
    const quiet = flags.has('q') || flags.has('quiet');
    const target = opts.O ?? opts['output-document'] ?? (parseUrl(url)?.path.split('/').pop() || 'index.html');
    const u = parseUrl(url);
    if (!quiet) ctx.io.err(`--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}\nResolving ${u?.host}... `);
    const res = httpGet(url, { fromVm: currentVm(ctx) });
    await netDelay(ctx, res.ok ? 200 : 2500);
    if (!res.ok) {
      if (!quiet) ctx.io.err(/\(6\)/.test(res.error ?? '') ? `failed: Name or service not known.\nwget: unable to resolve host address '${u?.host}'\n` : `connected.\nConnection timed out.\n`);
      if (res.hint && ctx.io.isTTY) hint(ctx.io, res.hint);
      return 4;
    }
    if (!quiet) ctx.io.err(`${resolveDns(u?.host ?? '')?.ip}\nConnecting to ${u?.host}... connected.\nHTTP request sent, awaiting response... ${res.status} ${STATUS_TEXT[res.status!] ?? ''}\nLength: ${(res.body ?? '').length} [${res.headers?.['Content-Type'] ?? 'text/html'}]\nSaving to: '${target}'\n\n${target}  100%[===================>]  ${(res.body ?? '').length}  --.-KB/s    in 0s\n\n`);
    if ((res.status ?? 0) >= 400) {
      if (!quiet) ctx.io.err(`ERROR ${res.status}: ${STATUS_TEXT[res.status!] ?? ''}.\n`);
      return 8;
    }
    if (target === '-') ctx.io.out(res.body ?? '');
    else ctx.sess.fs.writeFile(ctx.sess.resolve(target), res.body ?? '');
    return 0;
  },
};

const nslookup: CommandDef = {
  summary: 'Consulta DNS',
  fn(argv, ctx) {
    const host = argv.slice(1).find((a) => !a.startsWith('-'));
    if (!host) {
      eprintln(ctx.io, 'Usage: nslookup <host>');
      return 1;
    }
    const r = resolveDns(host);
    println(ctx.io, 'Server:\t\t168.63.129.16\nAddress:\t168.63.129.16#53\n');
    if (!r) {
      println(ctx.io, `** server can't find ${host}: NXDOMAIN`);
      return 1;
    }
    println(ctx.io, 'Non-authoritative answer:');
    if (r.cname) println(ctx.io, `${host}\tcanonical name = ${r.cname}.`);
    println(ctx.io, `Name:\t${r.cname ?? host}\nAddress: ${r.ip}`);
    return 0;
  },
};

const dig: CommandDef = {
  summary: 'Consulta DNS (dig)',
  fn(argv, ctx) {
    const short = argv.includes('+short');
    const host = argv.slice(1).find((a) => !a.startsWith('+') && !a.startsWith('-') && !['A', 'CNAME', 'AAAA', 'MX', 'TXT'].includes(a));
    if (!host) {
      eprintln(ctx.io, 'Usage: dig <host>');
      return 1;
    }
    const r = resolveDns(host);
    if (short) {
      if (r?.cname) println(ctx.io, r.cname + '.');
      if (r) println(ctx.io, r.ip);
      return 0;
    }
    println(ctx.io, `\n; <<>> DiG 9.18.28-0ubuntu0.22.04.1-Ubuntu <<>> ${host}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${r ? 'NOERROR' : 'NXDOMAIN'}, id: ${Math.floor(Math.random() * 60000)}\n;; flags: qr rd ra; QUERY: 1, ANSWER: ${r ? (r.cname ? 2 : 1) : 0}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;${host}.\t\t\tIN\tA\n`);
    if (r) {
      println(ctx.io, ';; ANSWER SECTION:');
      if (r.cname) println(ctx.io, `${host}.\t300\tIN\tCNAME\t${r.cname}.`);
      println(ctx.io, `${r.cname ?? host}.\t60\tIN\tA\t${r.ip}\n`);
    }
    println(ctx.io, `;; Query time: 12 msec\n;; SERVER: 168.63.129.16#53(168.63.129.16) (UDP)\n;; WHEN: ${new Date().toUTCString()}\n;; MSG SIZE  rcvd: 96`);
    return r ? 0 : 9;
  },
};

const hostCmd: CommandDef = {
  fn(argv, ctx) {
    const host = argv[1];
    const r = host ? resolveDns(host) : null;
    if (!r) {
      println(ctx.io, `Host ${host} not found: 3(NXDOMAIN)`);
      return 1;
    }
    if (r.cname) println(ctx.io, `${host} is an alias for ${r.cname}.`);
    println(ctx.io, `${r.cname ?? host} has address ${r.ip}`);
    return 0;
  },
};

const ping: CommandDef = {
  summary: 'Envía paquetes ICMP',
  async fn(argv, ctx) {
    const { opts, rest } = parseFlags(argv.slice(1), ['c', 'W', 'i', 'w']);
    const host = rest[0];
    if (!host) {
      eprintln(ctx.io, 'ping: usage error: Destination address required');
      return 2;
    }
    const r = resolveDns(host);
    if (!r) {
      eprintln(ctx.io, `ping: ${host}: Name or service not known`);
      return 2;
    }
    const count = Number(opts.c ?? 4);
    if (!opts.c && ctx.io.isTTY) println(ctx.io, C.dim('(el simulador envía 4 paquetes si no indicas -c)'));
    println(ctx.io, `PING ${host} (${r.ip}) 56(84) bytes of data.`);
    const s = getState();
    let replies = true;
    let why = '';
    const vm = s.resources.find((x) => ciEq(x.type, 'Microsoft.Compute/virtualMachines') && vmNetworkInfo(x, s).publicIp === r.ip);
    if (vm) {
      if (vmPowerState(vm) !== 'running') {
        replies = false;
        why = 'La VM no está en ejecución.';
      } else {
        const nic = vmNetworkInfo(vm, s).nic!;
        const rules = [nic.properties.networkSecurityGroup?.id].filter(Boolean).map((id) => s.resources.find((x) => ciEq(x.id, id)));
        const icmpOpen = rules.some((nsg) => (nsg?.properties.securityRules ?? []).some((ru: any) => ru.properties.direction === 'Inbound' && ru.properties.access === 'Allow' && (ru.properties.protocol === 'Icmp' || ru.properties.protocol === '*') && [ru.properties.sourceAddressPrefix, ...(ru.properties.sourceAddressPrefixes ?? [])].some((p: string) => ['*', 'Internet', 'Any'].includes(p))));
        replies = icmpOpen && inboundAllowed(nic, 0, 'Tcp').decisions.length >= 0;
        if (!icmpOpen) why = 'El NSG no permite ICMP de entrada (el ping usa ICMP, no TCP). Muchas veces es mejor probar con curl o nc.';
      }
    } else if (/azurewebsites\.net$|core\.windows\.net$|vault\.azure\.net$|database\.windows\.net$|azurecr\.io$/.test(host)) {
      replies = false;
      why = 'Los servicios PaaS de Azure no responden a ICMP: usa curl, nc o nslookup para diagnosticar.';
    } else if (!/^93\.184\./.test(r.ip) && host !== 'localhost') replies = false;
    let received = 0;
    for (let i = 1; i <= count; i++) {
      await netDelay(ctx, 1000);
      if (replies) {
        received++;
        println(ctx.io, `64 bytes from ${r.ip}: icmp_seq=${i} ttl=${host === 'localhost' ? 64 : 116} time=${(Math.random() * 10 + 8).toFixed(1)} ms`);
      }
    }
    println(ctx.io, `\n--- ${host} ping statistics ---\n${count} packets transmitted, ${received} received, ${Math.round(((count - received) / count) * 100)}% packet loss, time ${count * 1000 - 1}ms`);
    if (!replies && why && ctx.io.isTTY) hint(ctx.io, why);
    return received ? 0 : 1;
  },
};

async function probeCmd(ctx: CmdCtx, host: string, port: number, mode: 'nc' | 'telnet'): Promise<number> {
  const p = tcpProbe(host, port, currentVm(ctx));
  await netDelay(ctx, p.state === 'timeout' ? 2500 : 150);
  const svc: Record<number, string> = { 22: 'ssh', 80: 'http', 443: 'https', 1433: 'ms-sql-s', 3389: 'ms-wbt-server', 6379: 'redis' };
  if (p.state === 'unresolved') {
    eprintln(ctx.io, mode === 'nc' ? `nc: getaddrinfo for host "${host}" port ${port}: Name or service not known` : `telnet: could not resolve ${host}/${port}: Name or service not known`);
    return 1;
  }
  if (p.state === 'open') {
    if (mode === 'nc') eprintln(ctx.io, `Connection to ${host} (${p.ip}) ${port} port [tcp/${svc[port] ?? '*'}] succeeded!`);
    else println(ctx.io, `Trying ${p.ip}...\nConnected to ${host}.\nEscape character is '^]'.${port === 22 ? '\nSSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10' : ''}\nConnection closed by foreign host.`);
    return 0;
  }
  if (p.state === 'refused') eprintln(ctx.io, mode === 'nc' ? `nc: connect to ${host} (${p.ip}) port ${port} (tcp) failed: Connection refused` : `Trying ${p.ip}...\ntelnet: Unable to connect to remote host: Connection refused`);
  else eprintln(ctx.io, mode === 'nc' ? `nc: connect to ${host} (${p.ip}) port ${port} (tcp) timed out: Operation now in progress` : `Trying ${p.ip}...\ntelnet: Unable to connect to remote host: Connection timed out`);
  if (p.hint && ctx.io.isTTY) hint(ctx.io, p.hint);
  return 1;
}

const nc: CommandDef = {
  summary: 'Comprueba puertos TCP (nc -zv host puerto)',
  async fn(argv, ctx) {
    const { rest } = parseFlags(argv.slice(1), ['w']);
    if (rest.length < 2) {
      eprintln(ctx.io, 'usage: nc [-zv] [-w timeout] destination port');
      return 1;
    }
    return probeCmd(ctx, rest[0], Number(rest[1]), 'nc');
  },
};

const telnet: CommandDef = {
  async fn(argv, ctx) {
    if (argv.length < 3) {
      eprintln(ctx.io, 'usage: telnet host port');
      return 1;
    }
    return probeCmd(ctx, argv[1], Number(argv[2]), 'telnet');
  },
};

// ---------------------------------------------------------------- SSH

function vmByHost(host: string, fromVm: Resource | null): Resource | undefined {
  const s = getState();
  const r = resolveDns(host);
  if (!r) return undefined;
  return s.resources.find((x) => ciEq(x.type, 'Microsoft.Compute/virtualMachines') && (vmNetworkInfo(x, s).publicIp === r.ip || (!!fromVm && vmNetworkInfo(x, s).privateIp === r.ip)));
}

const ssh: CommandDef = {
  summary: 'Conexión segura a una máquina remota',
  async fn(argv, ctx) {
    const args = argv.slice(1);
    let identity: string | undefined;
    let port = 22;
    let strict = true;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-i') identity = args[++i];
      else if (a === '-p') port = Number(args[++i]);
      else if (a === '-o') {
        const o = args[++i] ?? '';
        if (/StrictHostKeyChecking\s*=\s*no/i.test(o)) strict = false;
      } else if (a === '-l') positional.unshift(`${args[++i]}@`);
      else if (/^-[tTvqANnfC46]+$/.test(a)) continue;
      else positional.push(a);
    }
    let target = positional.shift();
    if (target?.endsWith('@') && positional.length) target = target + positional.shift();
    if (!target) {
      eprintln(ctx.io, 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-i identity_file] [-l login_name] [-o option] [-p port] destination [command [argument ...]]');
      return 255;
    }
    const at = target.lastIndexOf('@');
    const user = at >= 0 ? target.slice(0, at) : ctx.sess.user;
    const host = at >= 0 ? target.slice(at + 1) : target;
    const command = positional.join(' ');
    const fromVm = currentVm(ctx);
    const r = resolveDns(host);
    if (!r) {
      eprintln(ctx.io, `ssh: Could not resolve hostname ${host}: Name or service not known`);
      return 255;
    }
    const probe = tcpProbe(host, port, fromVm);
    await netDelay(ctx, probe.state === 'timeout' ? 3000 : 300);
    if (probe.state !== 'open') {
      eprintln(ctx.io, probe.state === 'refused' ? `ssh: connect to host ${host} port ${port}: Connection refused` : `ssh: connect to host ${host} port ${port}: Connection timed out`);
      const vmT = vmByHost(host, fromVm);
      if (vmT?.data?.osType === 'Windows') hint(ctx.io, 'Es una VM Windows: usa RDP (puerto 3389) o "az vm run-command invoke --command-id RunPowerShellScript".');
      else if (probe.hint) hint(ctx.io, probe.hint);
      return 255;
    }
    const vm = vmByHost(host, fromVm);
    if (!vm || vm.data?.osType !== 'Linux') {
      eprintln(ctx.io, `ssh: connect to host ${host} port ${port}: Connection refused`);
      return 255;
    }
    const s = getState();
    const known = ctx.sess.kind === 'cloudshell' ? s.cli.knownHosts : ((ctx.sess as any).knownHosts ??= []);
    if (!known.includes(r.ip)) {
      if (strict) {
        if (!ctx.io.prompt || !ctx.io.isTTY) {
          eprintln(ctx.io, `Host key verification failed.`);
          return 255;
        }
        const fp = `SHA256:${btoa(shortHash(vm.id, 32)).slice(0, 43)}`;
        const ans = (await ctx.io.prompt(`The authenticity of host '${host} (${r.ip})' can't be established.\nED25519 key fingerprint is ${fp}.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `)).trim().toLowerCase();
        if (ans !== 'yes' && ans !== fp.toLowerCase()) {
          eprintln(ctx.io, 'Host key verification failed.');
          return 255;
        }
      }
      known.push(r.ip);
      ctx.io.err(`Warning: Permanently added '${r.ip}' (ED25519) to the list of known hosts.\n`);
      if (ctx.sess.kind === 'cloudshell') {
        try {
          ctx.sess.fs.mkdir(`${ctx.sess.home}/.ssh`, true);
          ctx.sess.fs.writeFile(`${ctx.sess.home}/.ssh/known_hosts`, `${r.ip} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${shortHash(vm.id, 43)}\n`, true);
        } catch {
          /* sin fichero */
        }
        changed();
      }
    }
    const admin = vm.properties.osProfile?.adminUsername;
    const lc = vm.properties.osProfile?.linuxConfiguration;
    const keys: string[] = (lc?.ssh?.publicKeys ?? []).map((k: any) => String(k.keyData).trim());
    let authed = false;
    if (ciEq(user, admin)) {
      const keyFile = identity ? ctx.sess.resolve(identity) : `${ctx.sess.home}/.ssh/id_rsa`;
      const pubFile = `${keyFile}.pub`;
      if (ctx.sess.fs.isFile(keyFile) && ctx.sess.fs.isFile(pubFile)) {
        const pub = ctx.sess.fs.readFile(pubFile).trim();
        if (keys.some((k) => k === pub || k.split(' ')[1] === pub.split(' ')[1])) authed = true;
      }
      if (!authed && lc?.disablePasswordAuthentication === false && ctx.io.prompt) {
        for (let attempt = 0; attempt < 3 && !authed; attempt++) {
          const pw = await ctx.io.prompt(`${user}@${host}'s password: `, { secret: true });
          if (pw === vm.data?.adminPassword) authed = true;
          else eprintln(ctx.io, 'Permission denied, please try again.');
        }
      }
    }
    if (!authed) {
      eprintln(ctx.io, `${user}@${host}: Permission denied (publickey${lc?.disablePasswordAuthentication === false ? ',password' : ''}).`);
      if (!ciEq(user, admin)) hint(ctx.io, `El usuario administrador de la VM es "${admin}". Prueba: ssh ${admin}@${host}`);
      else if (lc?.disablePasswordAuthentication !== false) hint(ctx.io, 'La VM sólo acepta claves SSH y tu clave pública no coincide (¿creaste la VM desde otra sesión o con otra clave?). Puedes restablecerla con "az vm user update --ssh-key-value ~/.ssh/id_rsa.pub".');
      return 255;
    }
    s.events.push({ t: Date.now(), kind: 'vmCmd', resourceId: vm.id, detail: 'ssh-login', caller: ctx.sess.user });
    changed();
    const vmSess = createVmSession({ vm, user: admin, asRoot: false }, ctx.sess);
    if (command) {
      let code = 0;
      try {
        code = await vmSess.run(command, ctx.io);
      } catch (e: any) {
        code = e?.code ?? 1;
      }
      return code;
    }
    if (!ctx.sess.ui.enterSession) {
      eprintln(ctx.io, 'Pseudo-terminal will not be allocated because stdin is not a terminal.');
      return 1;
    }
    const img = vm.data?.image;
    const banner = `Welcome to ${img?.distro ?? 'Ubuntu 22.04.5 LTS'} (GNU/Linux 6.5.0-1025-azure x86_64)\n\n * Documentation:  https://help.ubuntu.com\n * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro\n\n  System information as of ${new Date().toUTCString()}\n\n  System load:  0.08              Processes:             112\n  Usage of /:   5.4% of 28.89GB   Users logged in:       0\n  Memory usage: 31%               IPv4 address for eth0: ${vmNetworkInfo(vm, s).privateIp}\n\nLast login: ${new Date(Date.now() - 3600000).toUTCString()} from ${r.ip === vmNetworkInfo(vm, s).privateIp ? '10.0.0.5' : '20.31.118.42'}\n${C.dim('(Estás dentro de la VM simulada. Escribe "exit" para volver al Cloud Shell.)')}`;
    ctx.sess.ui.enterSession(vmSess, banner);
    return 0;
  },
};

const sshKeygen: CommandDef = {
  summary: 'Genera claves SSH',
  async fn(argv, ctx) {
    const { opts } = parseFlags(argv.slice(1), ['t', 'b', 'f', 'N', 'C', 'm']);
    const type = opts.t ?? 'rsa';
    const file = ctx.sess.resolve(opts.f ?? `~/.ssh/id_${type === 'ed25519' ? 'ed25519' : 'rsa'}`);
    ctx.sess.fs.mkdir(file.split('/').slice(0, -1).join('/'), true);
    println(ctx.io, `Generating public/private ${type} key pair.`);
    if (ctx.sess.fs.exists(file)) {
      if (!ctx.io.prompt) return 1;
      const a = (await ctx.io.prompt(`${file} already exists.\nOverwrite (y/n)? `)).trim().toLowerCase();
      if (a !== 'y') return 1;
    }
    if (opts.N === undefined && ctx.io.prompt && ctx.io.isTTY) {
      await ctx.io.prompt('Enter passphrase (empty for no passphrase): ', { secret: true });
      await ctx.io.prompt('Enter same passphrase again: ', { secret: true });
    }
    const material = shortHash(guid() + Date.now(), 372);
    const comment = opts.C ?? `${ctx.sess.user}@${ctx.sess.host}`;
    const pub = type === 'ed25519' ? `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${btoa(material).slice(0, 43)} ${comment}` : `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ${btoa(material).slice(0, 360)} ${comment}`;
    ctx.sess.fs.writeFile(file, `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(material + 'priv').match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`);
    ctx.sess.fs.writeFile(`${file}.pub`, pub + '\n');
    println(ctx.io, `Your identification has been saved in ${file}\nYour public key has been saved in ${file}.pub\nThe key fingerprint is:\nSHA256:${btoa(shortHash(material, 32)).slice(0, 43)} ${comment}\nThe key's randomart image is:\n+---[${type.toUpperCase()} ${opts.b ?? (type === 'rsa' ? 3072 : 256)}]----+\n|      .o+=*o.    |\n|     . +.B=o .   |\n|      o =o*.o    |\n|       ..o.+.    |\n|        S.o.     |\n|       . .o.     |\n|        ...      |\n|                 |\n|                 |\n+----[SHA256]-----+`);
    return 0;
  },
};

const scp: CommandDef = {
  summary: 'Copia ficheros a una VM por SSH',
  async fn(argv, ctx) {
    const args = argv.slice(1).filter((a, i, arr) => !a.startsWith('-') && arr[i - 1] !== '-i' && arr[i - 1] !== '-P');
    if (args.length < 2) {
      eprintln(ctx.io, 'usage: scp [-r] [-i identity_file] source ... target');
      return 1;
    }
    const target = args[args.length - 1];
    const m = /^(?:([^@]+)@)?([^:]+):(.*)$/.exec(target);
    if (!m) {
      eprintln(ctx.io, 'scp: sólo se admite copiar del Cloud Shell a una VM (usuario@host:/ruta).');
      return 1;
    }
    const [, user, host, rpath] = m;
    const probe = tcpProbe(host, 22, currentVm(ctx));
    if (probe.state !== 'open') {
      eprintln(ctx.io, `ssh: connect to host ${host} port 22: Connection ${probe.state === 'refused' ? 'refused' : 'timed out'}\nscp: Connection closed`);
      if (probe.hint) hint(ctx.io, probe.hint);
      return 1;
    }
    const vm = vmByHost(host, currentVm(ctx));
    if (!vm) return 1;
    const admin = vm.properties.osProfile?.adminUsername;
    if (user && !ciEq(user, admin)) {
      eprintln(ctx.io, `${user}@${host}: Permission denied (publickey).\nscp: Connection closed`);
      return 1;
    }
    const vmSess = createVmSession({ vm, user: admin, asRoot: false }, ctx.sess);
    for (const src of args.slice(0, -1)) {
      const abs = ctx.sess.resolve(src);
      let content: string;
      try {
        content = ctx.sess.fs.readFile(abs);
      } catch {
        eprintln(ctx.io, `scp: ${src}: No such file or directory`);
        return 1;
      }
      const dest = vmSess.resolve(rpath || '.');
      const finalPath = vmSess.fs.isDir(dest) ? `${dest}/${src.split('/').pop()}` : dest;
      try {
        vmSess.fs.writeFile(finalPath, content);
      } catch {
        eprintln(ctx.io, `scp: ${rpath}: Permission denied`);
        return 1;
      }
      println(ctx.io, `${src.split('/').pop()!.padEnd(40)} 100%  ${content.length}   ${(content.length / 1024).toFixed(1)}KB/s   00:00`);
    }
    changed();
    return 0;
  },
};

export const NET_COMMANDS: Record<string, CommandDef> = {
  curl,
  wget,
  nslookup,
  dig,
  host: hostCmd,
  ping,
  nc,
  netcat: nc,
  telnet,
  ssh,
  'ssh-keygen': sshKeygen,
  scp,
};
