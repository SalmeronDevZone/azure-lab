// Docker simulado (cliente + demonio local) con push/pull a Azure Container Registry.
import type { CommandDef, CmdCtx, Session } from '../interp';
import type { DockerContainer, DockerImage } from '../../engine/types';
import { C, delay, eprintln, hint, parseFlags, println, table } from './util';
import { buildImage, BuildError } from './dockerBuild';
import { getState, changed } from '../../engine/store';
import { findPublicImage, normalizeImageName } from '../../engine/catalog';
import { findRegistryByLoginServer } from '../../engine/services/kube';
import { pushImage } from '../../engine/services/acr';
import { hasPermission } from '../../engine/arm';
import { findSp, principalRefForSp } from '../../engine/services/identity';
import { guid, shortHash, ciEq, relTime } from '../../engine/util';
import { appListenPort, startupLog, renderApp } from '../../engine/services/appRuntime';
import { riskyFiles } from '../../engine/fileRules';

interface DockerStore {
  images: DockerImage[];
  containers: DockerContainer[];
}

function store(sess: Session): DockerStore {
  if (sess.kind === 'cloudshell') return getState().docker;
  const anySess = sess as any;
  anySess.__docker ??= { images: [], containers: [] };
  return anySess.__docker;
}

function fullName(repo: string, tag: string) {
  return `${repo}:${tag}`;
}

function parseRef(ref: string): { name: string; repoPath: string; tag: string; registry: string | null } {
  const { repo, tag, registry } = normalizeImageName(ref);
  return { name: registry ? `${registry}/${repo}` : repo, repoPath: repo, tag, registry };
}

function findImage(st: DockerStore, ref: string): DockerImage | undefined {
  const r = parseRef(ref);
  return st.images.find((i) => (ciEq(i.repository, r.name) && i.tag === r.tag) || i.id.startsWith(ref));
}

/** Credenciales de docker para un registro: 'principal' (az acr login), SP o admin. */
function registryAuth(sess: Session, server: string): { kind: 'principal' | 'sp' | 'admin' | 'none'; id?: string } {
  const entry = sess.az.dockerLogins.find((x) => x.split('#')[0].toLowerCase() === server.toLowerCase());
  if (!entry) return sess.az.acrLogins.some((x) => x.toLowerCase() === server.toLowerCase()) ? { kind: 'principal' } : { kind: 'none' };
  const meta = entry.split('#')[1];
  if (!meta) return { kind: 'principal' };
  if (meta === 'admin') return { kind: 'admin' };
  if (meta.startsWith('sp=')) return { kind: 'sp', id: meta.slice(3) };
  return { kind: 'principal' };
}

function canAct(sess: Session, server: string, action: 'pull' | 'push'): boolean {
  const reg = findRegistryByLoginServer(server);
  if (!reg) return false;
  if (action === 'pull' && reg.properties.anonymousPullEnabled) return true;
  const auth = registryAuth(sess, server);
  const perm = action === 'pull' ? 'Microsoft.ContainerRegistry/registries/pull/read' : 'Microsoft.ContainerRegistry/registries/push/write';
  if (auth.kind === 'admin') return !!reg.properties.adminUserEnabled;
  if (auth.kind === 'sp') {
    const sp = findSp(auth.id!);
    return !!sp && hasPermission(principalRefForSp(sp), perm, reg.id);
  }
  if (auth.kind === 'principal') return hasPermission(sess.az.principal, perm, reg.id);
  return false;
}

function pullInto(ctx: CmdCtx, ref: string, quiet = false): DockerImage | null {
  const st = store(ctx.sess);
  const r = parseRef(ref);
  if (r.registry?.endsWith('.azurecr.io')) {
    const reg = findRegistryByLoginServer(r.registry);
    if (!reg) {
      eprintln(ctx.io, `Error response from daemon: Get "https://${r.registry}/v2/": dial tcp: lookup ${r.registry}: no such host`);
      return null;
    }
    if (!canAct(ctx.sess, r.registry, 'pull')) {
      eprintln(ctx.io, `Error response from daemon: Head "https://${r.registry}/v2/${r.repoPath}/manifests/${r.tag}": unauthorized: authentication required, visit https://aka.ms/acr/authorization for more information.`);
      hint(ctx.io, `Inicia sesión antes: az acr login --name ${reg.name}`);
      return null;
    }
    const t = reg.data?.repos?.[r.repoPath]?.tags?.[r.tag];
    if (!t) {
      eprintln(ctx.io, `Error response from daemon: manifest for ${r.registry}/${r.repoPath}:${r.tag} not found: manifest unknown: manifest tagged by "${r.tag}" is not found`);
      return null;
    }
    const img: DockerImage = { id: shortHash(t.digest, 64), repository: `${r.registry}/${r.repoPath}`, tag: r.tag, created: t.created, size: Math.round(t.size * 1048576), files: t.files ?? {}, exposed: t.exposed, cmd: t.cmd, env: t.env ?? {}, base: t.base ?? t.publicImage };
    st.images = st.images.filter((i) => !(i.repository === img.repository && i.tag === img.tag));
    st.images.push(img);
    if (!quiet) println(ctx.io, `${r.tag}: Pulling from ${r.repoPath}\n${shortHash(guid(), 12)}: Pull complete\nDigest: ${t.digest}\nStatus: Downloaded newer image for ${r.registry}/${r.repoPath}:${r.tag}\n${r.registry}/${r.repoPath}:${r.tag}`);
    changed();
    return img;
  }
  const pub = findPublicImage(ref);
  if (!pub) {
    eprintln(ctx.io, `Error response from daemon: pull access denied for ${r.repoPath}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`);
    return null;
  }
  const img: DockerImage = { id: shortHash(pub.name + r.tag, 64), repository: r.name, tag: r.tag, created: new Date(Date.now() - 12 * 86400000).toISOString(), size: Math.round(pub.size * 1048576), files: {}, exposed: pub.port, base: pub.name };
  st.images = st.images.filter((i) => !(i.repository === img.repository && i.tag === img.tag));
  st.images.push(img);
  if (!quiet) println(ctx.io, `${r.tag}: Pulling from library/${r.repoPath}\n${shortHash(r.repoPath, 12)}: Pull complete\nDigest: sha256:${shortHash(pub.name, 64)}\nStatus: Downloaded newer image for ${r.repoPath}:${r.tag}\ndocker.io/library/${r.repoPath}:${r.tag}`);
  changed();
  return img;
}

const sizeStr = (b: number) => (b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)}GB` : `${Math.max(1, Math.round(b / 1048576))}MB`);

const docker: CommandDef = {
  summary: 'Cliente de Docker',
  async fn(argv, ctx) {
    const sub = argv[1];
    const st = store(ctx.sess);
    const args = argv.slice(2);
    switch (sub) {
      case undefined:
      case '--help':
        println(ctx.io, 'Usage:  docker [OPTIONS] COMMAND\n\nCommon Commands:\n  run         Create and run a new container from an image\n  exec        Execute a command in a running container\n  ps          List containers\n  build       Build an image from a Dockerfile\n  pull        Download an image from a registry\n  push        Upload an image to a registry\n  images      List images\n  login       Log in to a registry\n  logout      Log out from a registry\n  version     Show the Docker version information\n\nManagement Commands:\n  image, container, system\n\nOther: tag, logs, stop, start, rm, rmi, inspect');
        return 0;
      case 'version':
      case '--version':
        println(ctx.io, sub === '--version' ? 'Docker version 27.3.1, build ce12230' : 'Client: Docker Engine - Community\n Version:           27.3.1\n API version:       1.47\n Go version:        go1.22.7\n OS/Arch:           linux/amd64\n\nServer: Docker Engine - Community\n Engine:\n  Version:          27.3.1\n  API version:      1.47 (minimum version 1.24)\n  OS/Arch:          linux/amd64\n containerd:\n  Version:          1.7.22');
        return 0;
      case 'info':
        println(ctx.io, `Client:\n Version:    27.3.1\n Context:    default\n\nServer:\n Containers: ${st.containers.length}\n  Running: ${st.containers.filter((c) => c.status === 'running').length}\n Images: ${st.images.length}\n Server Version: 27.3.1\n Storage Driver: overlay2\n Operating System: Ubuntu 22.04.5 LTS (simulado)`);
        return 0;
      case 'build':
      case 'buildx': {
        const a = sub === 'buildx' ? args.slice(1) : args;
        const { opts, rest, flags } = parseFlags(a, ['t', 'tag', 'f', 'file', 'build-arg', 'platform', 'target']);
        const tagsRaw: string[] = [];
        for (let i = 0; i < a.length; i++) if (a[i] === '-t' || a[i] === '--tag') tagsRaw.push(a[++i]);
        const buildArgs: Record<string, string> = {};
        for (let i = 0; i < a.length; i++) if (a[i] === '--build-arg') {
          const [k, v] = a[++i].split('=');
          buildArgs[k] = v;
        }
        const contextArg = rest[rest.length - 1];
        if (!contextArg) {
          eprintln(ctx.io, 'ERROR: "docker buildx build" requires exactly 1 argument.\nSee \'docker buildx build --help\'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -');
          return 1;
        }
        const dir = ctx.sess.resolve(contextArg);
        if (!ctx.sess.fs.isDir(dir)) {
          eprintln(ctx.io, `ERROR: unable to prepare context: path "${contextArg}" not found`);
          return 1;
        }
        const t0 = Date.now();
        const lines: string[] = [];
        let img;
        try {
          img = buildImage({ fs: ctx.sess.fs, contextDir: dir, dockerfile: opts.f ?? opts.file, buildArgs, acrLogins: [...ctx.sess.az.acrLogins, ...ctx.sess.az.dockerLogins.map((x) => x.split('#')[0])], principal: ctx.sess.az.principal, onStep: (l) => lines.push(l) });
        } catch (e) {
          if (e instanceof BuildError) {
            println(ctx.io, `[+] Building ${((Date.now() - t0) / 1000 + 0.4).toFixed(1)}s (${lines.length + 2}/${lines.length + 3}) FINISHED                     docker:default`);
            for (const l of lines) println(ctx.io, ` => ${l}`);
            eprintln(ctx.io, e.message);
            return 1;
          }
          throw e;
        }
        const total = img.steps.length;
        if (!flags.has('q')) {
          println(ctx.io, `[+] Building ${(1.2 + total * 0.7).toFixed(1)}s (${total + 4}/${total + 4}) FINISHED                                   docker:default`);
          println(ctx.io, ` => [internal] load build definition from ${(opts.f ?? opts.file ?? 'Dockerfile').split('/').pop()}                 0.0s`);
          println(ctx.io, ` => => transferring dockerfile: ${200 + total * 15}B                                     0.0s`);
          println(ctx.io, ` => [internal] load metadata for docker.io/library/${img.base}                 1.1s`);
          println(ctx.io, ` => [internal] load .dockerignore                                       0.0s`);
          for (const s of img.steps) {
            await delay(80, ctx.io);
            println(ctx.io, ` => ${s.padEnd(66).slice(0, 66)}  ${(0.1 + Math.random() * 2).toFixed(1)}s`);
            const extra = lines.find((l) => l.startsWith('#') && l.includes(s.split(']')[0].replace('[', '')));
            if (extra) println(ctx.io, ` => => # ${extra.replace(/^#\d+ /, '')}`);
          }
          println(ctx.io, ` => exporting to image                                                  0.2s`);
          println(ctx.io, ` => => exporting layers                                                 0.1s`);
        }
        const id = shortHash(JSON.stringify(img.files) + Date.now(), 64);
        const tags = tagsRaw.length ? tagsRaw : [];
        for (const t of tags) {
          const r = parseRef(t);
          st.images = st.images.filter((i) => !(ciEq(i.repository, r.name) && i.tag === r.tag));
          st.images.push({ id, repository: r.name, tag: r.tag, created: new Date().toISOString(), size: Math.round(img.size * 1048576), files: img.files, exposed: img.exposed, cmd: img.cmd, env: img.env, base: img.base });
          if (!flags.has('q')) println(ctx.io, ` => => naming to ${r.registry ? '' : 'docker.io/library/'}${r.name}:${r.tag}                               0.0s`);
        }
        if (!tags.length) st.images.push({ id, repository: '<none>', tag: '<none>', created: new Date().toISOString(), size: Math.round(img.size * 1048576), files: img.files, exposed: img.exposed, cmd: img.cmd, env: img.env, base: img.base });
        if (flags.has('q')) println(ctx.io, `sha256:${id}`);
        changed();
        // Consejo del simulador: un secreto copiado a la imagen queda en sus capas para siempre.
        const risky = riskyFiles(Object.keys(img.files)).filter((x) => x.kind === 'secreto');
        if (risky.length && !flags.has('q')) hint(ctx.io, `La imagen contiene ${risky.map((x) => x.path).join(', ')}: cualquiera que pueda descargarla puede leerlo. Añádelo a .dockerignore y vuelve a construirla.`);
        return 0;
      }
      case 'images':
      case 'image': {
        if (sub === 'image' && args[0] && !['ls', 'list'].includes(args[0])) {
          if (args[0] === 'rm') return docker.fn(['docker', 'rmi', ...args.slice(1)], ctx);
          if (args[0] === 'prune') {
            const before = st.images.length;
            st.images = st.images.filter((i) => i.repository !== '<none>');
            println(ctx.io, `Total reclaimed space: ${before - st.images.length > 0 ? '120MB' : '0B'}`);
            changed();
            return 0;
          }
          if (args[0] === 'inspect') return docker.fn(['docker', 'inspect', ...args.slice(1)], ctx);
        }
        const rows = [['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'], ...st.images.slice().reverse().map((i) => [i.repository, i.tag, i.id.slice(0, 12), relTime(i.created).replace('hace ', '') + ' ago', sizeStr(i.size)])];
        println(ctx.io, table(rows, 3));
        return 0;
      }
      case 'tag': {
        const [src, target] = args;
        const img = src ? findImage(st, src) : undefined;
        if (!img) {
          eprintln(ctx.io, `Error response from daemon: No such image: ${src}`);
          return 1;
        }
        if (!target) {
          eprintln(ctx.io, '"docker tag" requires exactly 2 arguments.');
          return 1;
        }
        const r = parseRef(target);
        st.images = st.images.filter((i) => !(ciEq(i.repository, r.name) && i.tag === r.tag));
        st.images.push({ ...img, repository: r.name, tag: r.tag });
        changed();
        return 0;
      }
      case 'push': {
        const ref = args.find((x) => !x.startsWith('-'));
        if (!ref) {
          eprintln(ctx.io, '"docker push" requires exactly 1 argument.');
          return 1;
        }
        const img = findImage(st, ref);
        const r = parseRef(ref);
        if (!img) {
          eprintln(ctx.io, `The push refers to repository [${r.registry ? r.name : 'docker.io/library/' + r.name}]\nAn image does not exist locally with the tag: ${r.name}`);
          hint(ctx.io, `Etiqueta primero la imagen con el servidor del registro: docker tag <imagen> <registro>.azurecr.io/${r.repoPath}:${r.tag}`);
          return 1;
        }
        if (!r.registry || r.registry === 'docker.io') {
          eprintln(ctx.io, `The push refers to repository [docker.io/library/${r.name}]\n${shortHash(r.name, 12)}: Preparing\ndenied: requested access to the resource is denied`);
          hint(ctx.io, 'Para subir a tu ACR, la imagen debe llamarse <registro>.azurecr.io/<repo>:<tag>.');
          return 1;
        }
        const reg = findRegistryByLoginServer(r.registry);
        if (!reg) {
          eprintln(ctx.io, `The push refers to repository [${r.name}]\nGet "https://${r.registry}/v2/": dial tcp: lookup ${r.registry}: no such host`);
          return 1;
        }
        println(ctx.io, `The push refers to repository [${r.name}]`);
        const layers = [shortHash(img.id + '1', 12), shortHash(img.id + '2', 12), shortHash(img.id + '3', 12)];
        for (const l of layers) println(ctx.io, `${l}: Preparing`);
        await delay(400, ctx.io);
        if (!canAct(ctx.sess, r.registry, 'push')) {
          eprintln(ctx.io, `unauthorized: authentication required, visit https://aka.ms/acr/authorization for more information.`);
          hint(ctx.io, registryAuth(ctx.sess, r.registry).kind === 'none' ? `Inicia sesión en el registro: az acr login --name ${reg.name}` : 'La identidad con la que iniciaste sesión no tiene permiso de push (necesita AcrPush o Contributor).');
          return 1;
        }
        for (const l of layers) println(ctx.io, `${l}: Pushed`);
        const digest = pushImage(reg, r.repoPath, r.tag, { files: img.files, env: img.env, exposed: img.exposed, cmd: img.cmd, size: Math.round(img.size / 1048576), base: img.base });
        println(ctx.io, `${r.tag}: digest: ${digest} size: 1578`);
        return 0;
      }
      case 'pull':
        return pullInto(ctx, args.find((x) => !x.startsWith('-')) ?? '') ? 0 : 1;
      case 'login': {
        const { opts, rest, flags } = parseFlags(args, ['u', 'username', 'p', 'password']);
        const server = (rest[0] ?? 'docker.io').toLowerCase();
        const user = opts.u ?? opts.username;
        let pass = opts.p ?? opts.password;
        if (flags.has('password-stdin')) pass = (ctx.io.stdin ?? '').trim();
        if (!server.endsWith('.azurecr.io')) {
          eprintln(ctx.io, 'Error response from daemon: Get "https://registry-1.docker.io/v2/": unauthorized: incorrect username or password');
          hint(ctx.io, 'El simulador sólo admite inicio de sesión en Azure Container Registry (*.azurecr.io).');
          return 1;
        }
        const reg = findRegistryByLoginServer(server);
        if (!reg) {
          eprintln(ctx.io, `Error response from daemon: Get "https://${server}/v2/": dial tcp: lookup ${server}: no such host`);
          return 1;
        }
        if (!user && ctx.io.prompt) {
          eprintln(ctx.io, 'Error: Cannot perform an interactive login from a non TTY device');
          return 1;
        }
        const admin = reg.properties.adminUserEnabled && ciEq(user, reg.name) && (reg.data?.passwords ?? []).some((p: any) => p.value === pass);
        const sp = findSp(user ?? '');
        const spOk = sp && sp.secrets.includes(pass ?? '');
        if (!admin && !spOk) {
          eprintln(ctx.io, `Error response from daemon: Get "https://${server}/v2/": unauthorized: Application not registered with AAD.`);
          return 1;
        }
        ctx.sess.az.dockerLogins = [...ctx.sess.az.dockerLogins.filter((x) => x.split('#')[0] !== server), `${server}#${admin ? 'admin' : `sp=${sp!.appId}`}`];
        ctx.sess.az.persist();
        if (!flags.has('password-stdin')) eprintln(ctx.io, 'WARNING! Using --password via the CLI is insecure. Use --password-stdin.');
        println(ctx.io, 'Login Succeeded');
        return 0;
      }
      case 'logout': {
        const server = (args[0] ?? '').toLowerCase();
        ctx.sess.az.dockerLogins = ctx.sess.az.dockerLogins.filter((x) => x.split('#')[0] !== server);
        ctx.sess.az.acrLogins = ctx.sess.az.acrLogins.filter((x) => x !== server);
        ctx.sess.az.persist();
        println(ctx.io, `Removing login credentials for ${server || 'https://index.docker.io/v1/'}`);
        return 0;
      }
      case 'run': {
        const { opts, flags, rest } = parseFlags(args, ['p', 'publish', 'name', 'e', 'env', 'v', 'w', 'network']);
        const ports: { host: number; container: number }[] = [];
        const env: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-p' || args[i] === '--publish') {
            const [h, c] = args[++i].split(':').slice(-2);
            ports.push({ host: Number(h), container: Number(c ?? h) });
          }
          if (args[i] === '-e' || args[i] === '--env') {
            const [k, ...v] = args[++i].split('=');
            env[k] = v.join('=');
          }
        }
        const ref = rest[0];
        if (!ref) {
          eprintln(ctx.io, '"docker run" requires at least 1 argument.');
          return 1;
        }
        let img = findImage(st, ref);
        if (!img) {
          eprintln(ctx.io, `Unable to find image '${ref.includes(':') ? ref : ref + ':latest'}' locally`);
          img = pullInto(ctx, ref) ?? undefined;
          if (!img) return 125;
        }
        for (const p of ports) {
          if (st.containers.some((c) => c.status === 'running' && c.ports.some((x) => x.host === p.host))) {
            eprintln(ctx.io, `docker: Error response from daemon: driver failed programming external connectivity on endpoint: Bind for 0.0.0.0:${p.host} failed: port is already allocated.`);
            return 125;
          }
        }
        const name = opts.name ?? `${['brave', 'eager', 'happy', 'jolly', 'quirky'][Math.floor(Math.random() * 5)]}_${['turing', 'lovelace', 'hopper', 'curie', 'knuth'][Math.floor(Math.random() * 5)]}`;
        if (st.containers.some((c) => c.name === name)) {
          eprintln(ctx.io, `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${st.containers.find((c) => c.name === name)!.id}". You have to remove (or rename) that container to be able to reuse that name.`);
          return 125;
        }
        const pkg = Object.keys(img.files).length ? { files: img.files, env: { ...(img.env ?? {}), ...env } } : { files: {}, publicImage: findPublicImage(img.base ?? ref)?.name ?? img.base ?? null, env };
        if (img.base === 'hello-world' || /hello-world/.test(ref)) {
          println(ctx.io, '\nHello from Docker!\nThis message shows that your installation appears to be working correctly.\n\nTo generate this message, Docker took the following steps:\n 1. The Docker client contacted the Docker daemon.\n 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.\n 3. The Docker daemon created a new container from that image which runs the\n    executable that produces the output you are currently reading.\n 4. The Docker daemon streamed that output to the Docker client, which sent it\n    to your terminal.');
          st.containers.push({ id: shortHash(guid(), 64), name, image: ref, status: 'exited', ports: [], created: new Date().toISOString(), env });
          changed();
          return 0;
        }
        const id = shortHash(guid(), 64);
        const listen = appListenPort(pkg as any);
        const shortLived = !listen || ['alpine', 'ubuntu', 'busybox'].includes(img.base ?? '');
        st.containers.push({ id, name, image: `${img.repository}:${img.tag}`, status: shortLived && !flags.has('d') ? 'exited' : 'running', ports, created: new Date().toISOString(), env });
        changed();
        if (flags.has('d') || flags.has('detach')) {
          println(ctx.io, id);
          if (ports.length && listen && !ports.some((p) => p.container === listen)) hint(ctx.io, `La aplicación escucha en el puerto ${listen} del contenedor, pero has publicado ${ports.map((p) => p.container).join(', ')}.`);
          return 0;
        }
        for (const l of startupLog(pkg as any)) println(ctx.io, l);
        if (!shortLived) hint(ctx.io, 'El contenedor sigue en ejecución en primer plano; en el simulador vuelves al prompt. Usa "docker run -d" y prueba con curl localhost:<puerto>.');
        return 0;
      }
      case 'ps': {
        const all = args.includes('-a') || args.includes('--all');
        const q = args.includes('-q');
        const list = st.containers.filter((c) => all || c.status === 'running');
        if (q) {
          for (const c of list) println(ctx.io, c.id.slice(0, 12));
          return 0;
        }
        println(ctx.io, table([['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'], ...list.map((c) => [c.id.slice(0, 12), c.image, '"docker-entrypoint…"', relTime(c.created).replace('hace ', '') + ' ago', c.status === 'running' ? `Up ${relTime(c.created).replace('hace ', '')}` : 'Exited (0) 1 second ago', c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(', '), c.name])], 3));
        return 0;
      }
      case 'container': {
        if (args[0] === 'ls') return docker.fn(['docker', 'ps', ...args.slice(1)], ctx);
        return docker.fn(['docker', ...args], ctx);
      }
      case 'stop':
      case 'start':
      case 'restart':
      case 'kill': {
        let code = 0;
        for (const ref of args.filter((x) => !x.startsWith('-'))) {
          const c = st.containers.find((x) => x.name === ref || x.id.startsWith(ref));
          if (!c) {
            eprintln(ctx.io, `Error response from daemon: No such container: ${ref}`);
            code = 1;
            continue;
          }
          c.status = sub === 'stop' || sub === 'kill' ? 'exited' : 'running';
          println(ctx.io, ref);
        }
        changed();
        return code;
      }
      case 'rm': {
        const force = args.includes('-f');
        let code = 0;
        for (const ref of args.filter((x) => !x.startsWith('-'))) {
          const c = st.containers.find((x) => x.name === ref || x.id.startsWith(ref));
          if (!c) {
            eprintln(ctx.io, `Error response from daemon: No such container: ${ref}`);
            code = 1;
            continue;
          }
          if (c.status === 'running' && !force) {
            eprintln(ctx.io, `Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
            code = 1;
            continue;
          }
          st.containers = st.containers.filter((x) => x !== c);
          println(ctx.io, ref);
        }
        changed();
        return code;
      }
      case 'rmi': {
        let code = 0;
        for (const ref of args.filter((x) => !x.startsWith('-'))) {
          const img = findImage(st, ref);
          if (!img) {
            eprintln(ctx.io, `Error response from daemon: No such image: ${ref}`);
            code = 1;
            continue;
          }
          st.images = st.images.filter((i) => i !== img);
          println(ctx.io, `Untagged: ${img.repository}:${img.tag}`);
        }
        changed();
        return code;
      }
      case 'logs': {
        const ref = args.filter((x) => !x.startsWith('-'))[0];
        const c = st.containers.find((x) => x.name === ref || x.id.startsWith(ref ?? ''));
        if (!c) {
          eprintln(ctx.io, `Error response from daemon: No such container: ${ref}`);
          return 1;
        }
        const img = findImage(st, c.image);
        const pkg = img && Object.keys(img.files).length ? { files: img.files, env: { ...(img.env ?? {}), ...c.env } } : { files: {}, publicImage: findPublicImage(c.image)?.name ?? img?.base ?? null };
        for (const l of startupLog(pkg as any)) println(ctx.io, l);
        return 0;
      }
      case 'exec': {
        const rest = args.filter((x) => !/^-(it|i|t)$/.test(x));
        const c = st.containers.find((x) => x.name === rest[0] || x.id.startsWith(rest[0] ?? ''));
        if (!c || c.status !== 'running') {
          eprintln(ctx.io, `Error response from daemon: container ${rest[0]} is not running`);
          return 1;
        }
        const cmd = rest.slice(1).join(' ');
        const img = findImage(st, c.image);
        if (/^(ba)?sh$|\/bin\/(ba)?sh$/.test(cmd)) {
          println(ctx.io, C.dim('(El shell interactivo dentro de contenedores no está disponible en el simulador.)'));
          return 0;
        }
        if (/^ls/.test(cmd)) println(ctx.io, Object.keys(img?.files ?? {}).join('\n'));
        else if (/^env|printenv/.test(cmd)) println(ctx.io, Object.entries({ ...(img?.env ?? {}), ...c.env, HOSTNAME: c.id.slice(0, 12) }).map(([k, v]) => `${k}=${v}`).join('\n'));
        else if (/^cat /.test(cmd)) println(ctx.io, img?.files[cmd.slice(4).replace(/^\/app\//, '').replace(/^\.\//, '')] ?? `cat: ${cmd.slice(4)}: No such file or directory`);
        else if (/^(curl|wget)/.test(cmd)) {
          const pkg = img && Object.keys(img.files).length ? { files: img.files, env: img.env } : { files: {}, publicImage: findPublicImage(c.image)?.name ?? null };
          println(ctx.io, renderApp(pkg as any, '/', {}).body);
        } else println(ctx.io, C.dim(`(exec ${cmd}: simulado)`));
        return 0;
      }
      case 'inspect': {
        const ref = args[0];
        const img = ref ? findImage(st, ref) : undefined;
        const c = st.containers.find((x) => x.name === ref || x.id.startsWith(ref ?? ''));
        if (!img && !c) {
          eprintln(ctx.io, `Error: No such object: ${ref}`);
          return 1;
        }
        const obj = c ? [{ Id: c.id, Created: c.created, State: { Status: c.status, Running: c.status === 'running' }, Image: c.image, Name: `/${c.name}`, Config: { Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`) }, NetworkSettings: { Ports: Object.fromEntries(c.ports.map((p) => [`${p.container}/tcp`, [{ HostIp: '0.0.0.0', HostPort: String(p.host) }]])) } }] : [{ Id: `sha256:${img!.id}`, RepoTags: [`${img!.repository}:${img!.tag}`], Created: img!.created, Size: img!.size, Config: { Env: Object.entries(img!.env ?? {}).map(([k, v]) => `${k}=${v}`), Cmd: img!.cmd?.split(' ') ?? null, ExposedPorts: img!.exposed ? { [`${img!.exposed}/tcp`]: {} } : null, WorkingDir: '/app' } }];
        println(ctx.io, JSON.stringify(obj, null, 4));
        return 0;
      }
      case 'system':
        if (args[0] === 'prune') {
          st.containers = st.containers.filter((c) => c.status === 'running');
          st.images = st.images.filter((i) => i.repository !== '<none>');
          changed();
          println(ctx.io, 'Total reclaimed space: 0B');
          return 0;
        }
        if (args[0] === 'df') {
          println(ctx.io, `TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\nImages          ${st.images.length}         ${st.images.length}         ${sizeStr(st.images.reduce((a, i) => a + i.size, 0))}     0B (0%)\nContainers      ${st.containers.length}         ${st.containers.filter((c) => c.status === 'running').length}         0B        0B`);
          return 0;
        }
        return 0;
      case 'compose':
        eprintln(ctx.io, 'docker compose no está disponible en el simulador.');
        return 1;
    }
    eprintln(ctx.io, `docker: '${sub}' is not a docker command.\nSee 'docker --help'`);
    return 1;
  },
};

export const DOCKER_COMMANDS: Record<string, CommandDef> = { docker };
