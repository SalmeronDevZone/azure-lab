// Comandos del sistema operativo invitado de las VMs Linux (sesión ssh / run-command).
import type { CommandDef, CmdCtx } from '../interp';
import type { Resource } from '../../engine/types';
import { C, delay, eprintln, hint, println, strftime } from './util';
import { findResource } from '../../engine/arm';
import { changed } from '../../engine/store';
import { vmNetworkInfo } from '../../engine/providers/compute';
import { getState } from '../../engine/store';
import { guestFs, vmCpuStress } from '../../engine/services/compute';

export function guestVm(ctx: CmdCtx): Resource | null {
  return ctx.sess.vmId ? findResource(ctx.sess.vmId) ?? null : null;
}

function pkgs(vm: Resource): string[] {
  return (vm.data!.packages ??= []);
}

function hasPkg(vm: Resource, p: string) {
  return pkgs(vm).includes(p);
}

const NGINX_PAGE = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;

const APACHE_PAGE = `<!DOCTYPE html>
<html><head><title>Apache2 Ubuntu Default Page: It works</title></head>
<body><h1>Apache2 Default Page</h1><p>It works!</p></body></html>
`;

const KNOWN: Record<string, { deps?: string[]; size: string; version: string; effect?: (vm: Resource, ctx: CmdCtx) => void }> = {
  nginx: {
    deps: ['nginx-common', 'libnginx-mod-http-geoip2'],
    size: '640 kB',
    version: '1.18.0-6ubuntu14.4',
    effect(vm, ctx) {
      const fs = ctx.sess.fs;
      fs.mkdir('/var/www/html', true);
      fs.writeFile('/var/www/html/index.nginx-debian.html', NGINX_PAGE);
      fs.mkdir('/etc/nginx/sites-available', true);
      fs.writeFile('/etc/nginx/sites-available/default', 'server {\n\tlisten 80 default_server;\n\troot /var/www/html;\n\tindex index.html index.htm index.nginx-debian.html;\n\tserver_name _;\n\tlocation / {\n\t\ttry_files $uri $uri/ =404;\n\t}\n}\n');
      if (vm.data!.services.apache2 === 'active') vm.data!.services.nginx = 'failed';
      else vm.data!.services.nginx = 'active';
    },
  },
  apache2: {
    deps: ['apache2-bin', 'apache2-data', 'apache2-utils'],
    size: '1,912 kB',
    version: '2.4.52-1ubuntu4.12',
    effect(vm, ctx) {
      ctx.sess.fs.mkdir('/var/www/html', true);
      ctx.sess.fs.writeFile('/var/www/html/index.html', APACHE_PAGE);
      if (vm.data!.services.nginx === 'active') vm.data!.services.apache2 = 'failed';
      else vm.data!.services.apache2 = 'active';
    },
  },
  stress: { size: '17.5 kB', version: '1.0.5-1' },
  'stress-ng': { size: '2,120 kB', version: '0.13.12-2ubuntu1' },
  'docker.io': { deps: ['containerd', 'runc', 'bridge-utils'], size: '28.6 MB', version: '24.0.7-0ubuntu2~22.04.1', effect: (vm) => (vm.data!.services.docker = 'active') },
  nodejs: { size: '13.3 MB', version: '12.22.9~dfsg-1ubuntu3.6' },
  npm: { deps: ['nodejs'], size: '2,034 kB', version: '8.5.1~ds-1' },
  'azure-cli': { size: '75.0 MB', version: '2.67.0-1~jammy' },
  git: { size: '3,166 kB', version: '1:2.34.1-1ubuntu1.11' },
  unzip: { size: '174 kB', version: '6.0-26ubuntu3.2' },
  zip: { size: '176 kB', version: '3.0-12build2' },
  jq: { deps: ['libjq1', 'libonig5'], size: '357 kB', version: '1.6-2.1ubuntu3' },
  tree: { size: '47.9 kB', version: '2.0.2-1' },
  htop: { size: '128 kB', version: '3.0.5-7build2' },
  'net-tools': { size: '204 kB', version: '1.60+git20181103.0eebece-1ubuntu5' },
  'mysql-client': { size: '9,400 kB', version: '8.0.40-0ubuntu0.22.04.1' },
  'postgresql-client': { size: '1,234 kB', version: '14+238' },
  'python3-pip': { size: '1,306 kB', version: '22.0.2+dfsg-1ubuntu0.5' },
  curl: { size: '194 kB', version: '7.81.0-1ubuntu1.18' },
  wget: { size: '339 kB', version: '1.21.2-2ubuntu1.1' },
};

function requireRoot(ctx: CmdCtx, cmd: string): boolean {
  if (ctx.sess.isRoot) return true;
  if (cmd === 'apt') eprintln(ctx.io, 'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
  else eprintln(ctx.io, `${cmd}: Permission denied (¿te falta sudo?)`);
  return false;
}

const apt: CommandDef = {
  summary: 'Gestor de paquetes',
  async fn(argv, ctx) {
    const vm = guestVm(ctx);
    if (!vm) return 1;
    const sub = argv[1];
    const names = argv.slice(2).filter((a) => !a.startsWith('-'));
    if (sub === 'list' && argv.includes('--installed')) {
      println(ctx.io, 'Listing... Done');
      for (const p of pkgs(vm)) println(ctx.io, `${p}/jammy-updates,now ${KNOWN[p]?.version ?? '1.0'} amd64 [installed]`);
      return 0;
    }
    if (!requireRoot(ctx, 'apt')) return 100;
    if (sub === 'update') {
      await delay(600, ctx.io);
      println(ctx.io, 'Hit:1 http://azure.archive.ubuntu.com/ubuntu jammy InRelease\nGet:2 http://azure.archive.ubuntu.com/ubuntu jammy-updates InRelease [128 kB]\nGet:3 http://azure.archive.ubuntu.com/ubuntu jammy-backports InRelease [127 kB]\nGet:4 http://azure.archive.ubuntu.com/ubuntu jammy-security InRelease [129 kB]\nFetched 31.4 MB in 5s (6,420 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n12 packages can be upgraded. Run \'apt list --upgradable\' to see them.');
      vm.data!.aptUpdated = true;
      changed();
      return 0;
    }
    if (sub === 'upgrade') {
      await delay(800, ctx.io);
      println(ctx.io, 'Reading package lists... Done\nBuilding dependency tree... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');
      return 0;
    }
    if (sub === 'install') {
      println(ctx.io, 'Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done');
      const unknown = names.filter((n) => !KNOWN[n]);
      if (unknown.length) {
        eprintln(ctx.io, `E: Unable to locate package ${unknown[0]}`);
        return 100;
      }
      const fresh = names.filter((n) => !hasPkg(vm, n));
      for (const n of names.filter((x) => hasPkg(vm, x))) println(ctx.io, `${n} is already the newest version (${KNOWN[n].version}).`);
      if (!fresh.length) {
        println(ctx.io, '0 upgraded, 0 newly installed, 0 to remove and 12 not upgraded.');
        return 0;
      }
      const all = [...new Set(fresh.flatMap((n) => [n, ...(KNOWN[n].deps ?? [])]))];
      println(ctx.io, `The following NEW packages will be installed:\n  ${all.join(' ')}\n0 upgraded, ${all.length} newly installed, 0 to remove and 12 not upgraded.\nNeed to get ${KNOWN[fresh[0]].size} of archives.\nAfter this operation, 2,${Math.floor(Math.random() * 900 + 100)} kB of additional disk space will be used.`);
      if (!argv.includes('-y') && !argv.includes('--yes') && !argv.includes('-qy')) {
        if (!ctx.io.prompt) {
          eprintln(ctx.io, 'Do you want to continue? [Y/n] Abort.');
          return 1;
        }
        const a = (await ctx.io.prompt('Do you want to continue? [Y/n] ')).trim().toLowerCase();
        if (a && a !== 'y' && a !== 'yes') {
          println(ctx.io, 'Abort.');
          return 1;
        }
      }
      for (const n of all) {
        await delay(150, ctx.io);
        println(ctx.io, `Get:${all.indexOf(n) + 1} http://azure.archive.ubuntu.com/ubuntu jammy-updates/main amd64 ${n} amd64 ${KNOWN[n]?.version ?? '1.0'}`);
      }
      for (const n of all) println(ctx.io, `Selecting previously unselected package ${n}.\nUnpacking ${n} (${KNOWN[n]?.version ?? '1.0'}) ...`);
      for (const n of all) println(ctx.io, `Setting up ${n} (${KNOWN[n]?.version ?? '1.0'}) ...`);
      for (const n of fresh) {
        pkgs(vm).push(n);
        for (const d of KNOWN[n].deps ?? []) if (KNOWN[d] && !hasPkg(vm, d)) pkgs(vm).push(d);
        KNOWN[n].effect?.(vm, ctx);
        if (n === 'nginx' && vm.data!.services.nginx === 'failed') eprintln(ctx.io, 'Job for nginx.service failed because the control process exited with error code.\nSee "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.\ninvoke-rc.d: initscript nginx, action "start" failed.');
      }
      println(ctx.io, 'Processing triggers for man-db (2.10.2-1) ...\nProcessing triggers for ufw (0.36.1-4ubuntu0.1) ...');
      ctx.sess.fs.writeFile('/var/log/syslog', `${new Date().toISOString()} apt: installed ${fresh.join(' ')}\n`, true);
      changed();
      return 0;
    }
    if (sub === 'remove' || sub === 'purge') {
      for (const n of names) {
        vm.data!.packages = pkgs(vm).filter((p) => p !== n);
        if (n === 'nginx' || n === 'apache2') delete vm.data!.services[n];
      }
      println(ctx.io, `Removing ${names.join(' ')} ...`);
      changed();
      return 0;
    }
    eprintln(ctx.io, `E: Invalid operation ${sub ?? ''}`);
    return 100;
  },
};

const SERVICE_DESC: Record<string, string> = { nginx: 'A high performance web server and a reverse proxy server', apache2: 'The Apache HTTP Server', ssh: 'OpenBSD Secure Shell server', docker: 'Docker Application Container Engine', app: 'Aplicación de ejemplo' };

const systemctl: CommandDef = {
  summary: 'Controla servicios systemd',
  fn(argv, ctx) {
    const vm = guestVm(ctx);
    if (!vm) return 1;
    const args = argv.slice(1).filter((a) => !a.startsWith('-'));
    const [op, unit] = args;
    const name = (unit ?? '').replace(/\.service$/, '');
    const svcs: Record<string, string> = vm.data!.services;
    if (op === 'list-units' || !op) {
      println(ctx.io, '  UNIT                 LOAD   ACTIVE SUB     DESCRIPTION');
      for (const [s, st] of Object.entries(svcs)) println(ctx.io, `  ${(s + '.service').padEnd(20)} loaded ${st === 'active' ? 'active running' : 'failed failed '}  ${SERVICE_DESC[s] ?? s}`);
      return 0;
    }
    if (!(name in svcs)) {
      eprintln(ctx.io, op === 'status' ? `Unit ${name}.service could not be found.` : `Failed to ${op} ${name}.service: Unit ${name}.service not found.`);
      return op === 'status' ? 4 : 5;
    }
    if (op === 'status') {
      const st = svcs[name];
      println(ctx.io, `${st === 'active' ? C.green('●') : C.red('×')} ${name}.service - ${SERVICE_DESC[name] ?? name}\n     Loaded: loaded (/lib/systemd/system/${name}.service; enabled; vendor preset: enabled)\n     Active: ${st === 'active' ? C.green('active (running)') : st === 'inactive' ? 'inactive (dead)' : C.red('failed (Result: exit-code)')} since ${strftime('%a %F %T UTC', new Date(Date.now() - 120000), true)}; 2min ago\n       Docs: man:${name}(8)\n   Main PID: ${2300 + name.length} (${name})\n      Tasks: 2 (limit: 1062)\n     Memory: 2.4M\n        CPU: 21ms\n     CGroup: /system.slice/${name}.service${st === 'failed' ? `\n\n${strftime('%b %d %T', new Date(), true)} ${ctx.sess.host} ${name}[2345]: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)` : ''}`);
      return st === 'active' ? 0 : 3;
    }
    if (op === 'is-active') {
      println(ctx.io, svcs[name] === 'active' ? 'active' : svcs[name] === 'failed' ? 'failed' : 'inactive');
      return svcs[name] === 'active' ? 0 : 3;
    }
    if (op === 'is-enabled') {
      println(ctx.io, 'enabled');
      return 0;
    }
    if (!ctx.sess.isRoot) {
      eprintln(ctx.io, `Failed to ${op} ${name}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${name}.service' for details.`);
      return 1;
    }
    if (op === 'start' || op === 'restart' || op === 'reload') {
      const other = name === 'nginx' ? 'apache2' : name === 'apache2' ? 'nginx' : null;
      if (other && svcs[other] === 'active') {
        svcs[name] = 'failed';
        eprintln(ctx.io, `Job for ${name}.service failed because the control process exited with error code.\nSee "systemctl status ${name}.service" and "journalctl -xeu ${name}.service" for details.`);
        changed();
        return 1;
      }
      svcs[name] = 'active';
    } else if (op === 'stop') svcs[name] = 'inactive';
    else if (op === 'enable' || op === 'disable') println(ctx.io, op === 'enable' ? `Synchronizing state of ${name}.service with SysV service script with /lib/systemd/systemd-sysv-install.\nExecuting: /lib/systemd/systemd-sysv-install enable ${name}` : `Removed /etc/systemd/system/multi-user.target.wants/${name}.service.`);
    changed();
    return 0;
  },
};

const service: CommandDef = {
  fn(argv, ctx) {
    const [, name, op] = argv;
    return systemctl.fn(['systemctl', op ?? 'status', name], ctx);
  },
};

const stress: CommandDef = {
  summary: 'Genera carga de CPU',
  fn(argv, ctx) {
    const vm = guestVm(ctx);
    if (!vm) return 1;
    const name = argv[0];
    if (!hasPkg(vm, name)) {
      eprintln(ctx.io, `Command '${name}' not found, but can be installed with:\nsudo apt install ${name}`);
      return 127;
    }
    const i = argv.indexOf('--timeout');
    const t = i > 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--timeout='))?.split('=')[1] ?? '60';
    const m = /^(\d+)([smh]?)$/.exec(t ?? '60');
    const secs = m ? Number(m[1]) * (m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 1) : 60;
    const cpu = argv[argv.indexOf('--cpu') + 1] ?? '1';
    vmCpuStress(vm, secs);
    println(ctx.io, name === 'stress' ? `stress: info: [${2400 + secs}] dispatching hogs: ${cpu} cpu, 0 io, 0 vm, 0 hdd` : `stress-ng: info:  [${2400 + secs}] setting to a ${secs} secs run per stressor\nstress-ng: info:  [${2400 + secs}] dispatching hogs: ${cpu} cpu`);
    hint(ctx.io, `(simulado) La CPU de la VM estará al ~95% durante ${secs} s en segundo plano. Observa la métrica "Percentage CPU" en el portal o con "az monitor metrics list".`);
    return 0;
  },
};

const ipCmd: CommandDef = {
  fn(argv, ctx) {
    const vm = guestVm(ctx);
    const ip = vm ? vmNetworkInfo(vm, getState()).privateIp : '10.0.0.4';
    if (argv[1] === 'route' || argv[1] === 'r') {
      println(ctx.io, `default via 10.0.0.1 dev eth0 proto dhcp src ${ip} metric 100\n168.63.129.16 via 10.0.0.1 dev eth0 proto dhcp src ${ip} metric 100\n169.254.169.254 via 10.0.0.1 dev eth0 proto dhcp src ${ip} metric 100`);
      return 0;
    }
    println(ctx.io, `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000\n    link/ether ${(vm ? vmNetworkInfo(vm, getState()).nic?.properties.macAddress ?? '00-0d-3a-00-00-01' : '00-0d-3a-00-00-01').toLowerCase().replace(/-/g, ':')} brd ff:ff:ff:ff:ff:ff\n    inet ${ip}/24 metric 100 brd ${ip?.split('.').slice(0, 3).join('.')}.255 scope global eth0`);
    return 0;
  },
};

const top: CommandDef = {
  fn(_argv, ctx) {
    const vm = guestVm(ctx);
    const stressed = vm && (vm.data?.stressUntil ?? 0) > Date.now();
    const cpu = stressed ? 98.7 : 1.3;
    println(ctx.io, `top - ${strftime('%T', new Date())} up 1:02,  1 user,  load average: ${stressed ? '1.98, 1.20, 0.55' : '0.04, 0.03, 0.00'}\nTasks: 112 total,   ${stressed ? 2 : 1} running, 110 sleeping,   0 stopped,   0 zombie\n%Cpu(s): ${cpu.toFixed(1)} us,  0.3 sy,  0.0 ni, ${(100 - cpu - 0.3).toFixed(1)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\nMiB Mem :    904.9 total,    221.4 free,    285.8 used,    397.7 buff/cache\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n${stressed ? '   2412 root      20   0    3716    256    256 R  98.7   0.0   0:42.18 stress\n' : ''}      1 root      20   0  166756  11840   8344 S   0.0   1.3   0:02.11 systemd\n    612 root      20   0   15428   9016   7568 S   0.0   1.0   0:00.05 sshd\n${vm?.data?.services?.nginx === 'active' ? '   1802 root      20   0   55228   1712    272 S   0.0   0.2   0:00.00 nginx\n' : ''}${C.dim('(instantánea; el simulador no refresca top)')}`);
    return 0;
  },
};

const nginxBin: CommandDef = {
  fn(argv, ctx) {
    const vm = guestVm(ctx);
    if (!vm || !hasPkg(vm, 'nginx')) {
      eprintln(ctx.io, "Command 'nginx' not found, but can be installed with:\nsudo apt install nginx");
      return 127;
    }
    if (argv.includes('-v')) eprintln(ctx.io, 'nginx version: nginx/1.18.0 (Ubuntu)');
    else if (argv.includes('-t')) eprintln(ctx.io, 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful');
    return 0;
  },
};

const cloudInit: CommandDef = { fn: (argv, ctx) => (println(ctx.io, argv[1] === 'status' ? 'status: done' : 'cloud-init 24.3.1'), 0) };

const journalctl: CommandDef = {
  fn(argv, ctx) {
    const vm = guestVm(ctx);
    const unit = argv[argv.indexOf('-u') + 1] ?? 'system';
    const st = vm?.data?.services?.[unit.replace('.service', '')];
    println(ctx.io, `${strftime('%b %d %T', new Date(Date.now() - 120000), true)} ${ctx.sess.host} systemd[1]: Starting ${SERVICE_DESC[unit] ?? unit}...\n${strftime('%b %d %T', new Date(Date.now() - 119000), true)} ${ctx.sess.host} systemd[1]: ${st === 'failed' ? `${unit}.service: Failed with result 'exit-code'.` : `Started ${SERVICE_DESC[unit] ?? unit}.`}`);
    return 0;
  },
};

const reboot: CommandDef = {
  async fn(argv, ctx) {
    if (!ctx.sess.isRoot) {
      eprintln(ctx.io, 'Failed to set wall message, ignoring: Interactive authentication required.\nFailed to reboot system via logind: Interactive authentication required.');
      return 1;
    }
    const vm = guestVm(ctx);
    if (vm) {
      vm.data!.powerState = argv[0] === 'shutdown' || argv[0] === 'poweroff' ? 'stopped' : 'restarting';
      changed();
      if (vm.data!.powerState === 'restarting') {
        setTimeout(() => {
          vm.data!.powerState = 'running';
          changed();
        }, 3000);
      }
    }
    println(ctx.io, `Connection to ${vm ? vmNetworkInfo(vm, getState()).publicIp : 'host'} closed by remote host.`);
    if (argv[0] === 'shutdown' || argv[0] === 'poweroff') hint(ctx.io, 'Has apagado el SO, pero la VM NO está desasignada: Azure sigue cobrando el proceso. Usa "az vm deallocate".');
    return ctx.sess.builtin(['exit', '0'], ctx.io);
  },
};

function gated(pkg: string, def: CommandDef): CommandDef {
  return {
    summary: def.summary,
    fn(argv, ctx) {
      const vm = guestVm(ctx);
      if (!vm || !hasPkg(vm, pkg)) {
        eprintln(ctx.io, `Command '${argv[0]}' not found, but can be installed with:\nsudo apt install ${pkg}`);
        return 127;
      }
      return def.fn(argv, ctx);
    },
  };
}

export function guestCommands(base: Record<string, CommandDef>): Record<string, CommandDef> {
  return {
    apt,
    'apt-get': apt,
    systemctl,
    service,
    stress,
    'stress-ng': stress,
    ip: ipCmd,
    ifconfig: gated('net-tools', ipCmd),
    top,
    htop: gated('htop', top),
    nginx: nginxBin,
    'cloud-init': cloudInit,
    journalctl,
    reboot,
    shutdown: reboot,
    poweroff: reboot,
    az: gated('azure-cli', base.az),
    docker: gated('docker.io', base.docker),
    node: gated('nodejs', base.node),
    npm: gated('npm', base.npm),
    unzip: gated('unzip', base.unzip),
    zip: gated('zip', base.zip),
    jq: gated('jq', base.jq),
    tree: gated('tree', base.tree),
  };
}

export function ensureGuestFs(vm: Resource) {
  return guestFs(vm);
}
