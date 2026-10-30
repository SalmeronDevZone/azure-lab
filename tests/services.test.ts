// Pruebas de los servicios añadidos: Azure DNS, dominios personalizados, Resource Graph y Service Bus.
import { describe, it, expect, beforeAll } from 'vitest';
import '../src/engine/providers';
import { createCloudShellSession } from '../src/shell/sessions';
import { getState, portalPrincipal } from '../src/engine/store';
import { ExitSignal, type Session, type ShellIO } from '../src/shell/interp';
import { sendMessage, receiveMessages, abandonFirst } from '../src/engine/services/servicebus';
import { T_SB, sbData } from '../src/engine/providers/servicebus';
import { enforceAutoShutdown } from '../src/engine/services/compute';
import { TEMPLATES } from '../src/engine/services/devops';
import { renderApp, startupLog } from '../src/engine/services/appRuntime';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
let sess: Session;

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const io: ShellIO = { stdin: null, out: (s) => (out += s), err: (s) => (err += s), isTTY: false, signal: new AbortController().signal, prompt: async () => 'y' };
  let code: number;
  try {
    code = await sess.run(cmd, io);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  }
  return { code, out: strip(out), err: strip(err) };
}

async function ok(cmd: string) {
  const r = await sh(cmd);
  if (r.code !== 0) throw new Error(`"${cmd}" → ${r.code}\n${r.out}\n${r.err}`);
  return r.out;
}

beforeAll(async () => {
  getState().settings.speed = 'instant';
  sess = createCloudShellSession({});
  await ok('az group create -n rg-svc -l westeurope -o none');
});

describe('Azure DNS', () => {
  it('registro A hacia una VM con nginx', async () => {
    await ok('az vm create -g rg-svc -n vm-dns --image Ubuntu2404 --admin-username azureuser --generate-ssh-keys -o none');
    await ok('az vm run-command invoke -g rg-svc -n vm-dns --command-id RunShellScript --scripts "apt-get install -y nginx" -o none');
    await ok('az vm open-port -g rg-svc -n vm-dns --port 80 -o none');
    const ip = (await ok('az vm show -d -g rg-svc -n vm-dns --query publicIps -o tsv')).trim();
    await ok('az network dns zone create -g rg-svc -n contoso-lab.com -o none');
    await ok(`az network dns record-set a add-record -g rg-svc -z contoso-lab.com -n www --ipv4-address ${ip} -o none`);
    expect(await ok('nslookup www.contoso-lab.com')).toContain(ip);
    expect(await ok('curl -s http://www.contoso-lab.com')).toMatch(/nginx/i);
    expect((await sh('nslookup noexiste.contoso-lab.com')).code).not.toBe(0);
    expect(await ok('az network dns record-set list -g rg-svc -z contoso-lab.com -o table')).toContain('www');
  });

  it('dominio personalizado en App Service', async () => {
    await ok('az appservice plan create -g rg-svc -n plan-svc --sku B1 --is-linux -o none');
    await ok('az webapp create -g rg-svc -p plan-svc -n app-dns-svc-01 --runtime "NODE:20-lts" -o none');
    const noCname = await sh('az webapp config hostname add --webapp-name app-dns-svc-01 -g rg-svc --hostname app.contoso-lab.com');
    expect(noCname.err).toMatch(/CNAME record pointing/);
    await ok('az network dns record-set cname set-record -g rg-svc -z contoso-lab.com -n app -c app-dns-svc-01.azurewebsites.net -o none');
    expect(await ok('curl -s http://app.contoso-lab.com')).toMatch(/404 Web Site not found/);
    await ok('az webapp config hostname add --webapp-name app-dns-svc-01 -g rg-svc --hostname app.contoso-lab.com -o none');
    expect(await ok('curl -s http://app.contoso-lab.com')).not.toMatch(/404 Web Site not found/);
    expect((await sh('az network dns record-set cname set-record -g rg-svc -z contoso-lab.com -n @ -c x.azurewebsites.net')).code).not.toBe(0);
  });
});

describe('Resource Graph', () => {
  it('consulta con acceso a propiedades', async () => {
    const out = JSON.parse(await ok("az graph query -q \"Resources | where type =~ 'microsoft.compute/virtualmachines' | project name, tamano = properties.hardwareProfile.vmSize\""));
    expect(out.data[0].name).toBe('vm-dns');
    expect(out.data[0].tamano).toMatch(/Standard_/);
    const byType = JSON.parse(await ok('az graph query -q "Resources | summarize total = count() by type"'));
    expect(byType.count).toBeGreaterThan(3);
    const rgs = JSON.parse(await ok("az graph query -q \"ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' | project name\""));
    expect(rgs.data.map((x: any) => x.name)).toContain('rg-svc');
  });
});

describe('Service Bus', () => {
  it('colas, temas con filtros y mensajes fallidos', async () => {
    await ok('az servicebus namespace create -g rg-svc -n sb-basico-lab --sku Basic -o none');
    const basic = await sh('az servicebus topic create -g rg-svc --namespace-name sb-basico-lab -n pedidos');
    expect(basic.err).toMatch(/not supported in the Basic tier/);
    await ok('az servicebus namespace create -g rg-svc -n sb-tienda-lab --sku Standard -o none');
    await ok('az servicebus queue create -g rg-svc --namespace-name sb-tienda-lab -n facturas --max-delivery-count 3 -o none');
    await ok('az servicebus topic create -g rg-svc --namespace-name sb-tienda-lab -n pedidos -o none');
    await ok('az servicebus topic subscription create -g rg-svc --namespace-name sb-tienda-lab --topic-name pedidos -n todos -o none');
    await ok('az servicebus topic subscription create -g rg-svc --namespace-name sb-tienda-lab --topic-name pedidos -n urgentes -o none');
    await ok("az servicebus topic subscription rule create -g rg-svc --namespace-name sb-tienda-lab --topic-name pedidos --subscription-name urgentes -n solo-alta --filter-sql-expression \"prioridad = 'alta'\" -o none");
    await ok("az servicebus topic subscription rule delete -g rg-svc --namespace-name sb-tienda-lab --topic-name pedidos --subscription-name urgentes -n '$Default'");
    const nsr = getState().resources.find((r) => r.type === T_SB && r.name === 'sb-tienda-lab')!;
    const me = portalPrincipal();
    expect(sendMessage(nsr, { topic: 'pedidos' }, '{"id":1}', { prioridad: 'alta' }, undefined, me)).toBe(2);
    expect(sendMessage(nsr, { topic: 'pedidos' }, '{"id":2}', { prioridad: 'baja' }, undefined, me)).toBe(1);
    const subs = JSON.parse(await ok('az servicebus topic subscription list -g rg-svc --namespace-name sb-tienda-lab --topic-name pedidos'));
    expect(subs.find((x: any) => x.name === 'todos').countDetails.activeMessageCount).toBe(2);
    expect(subs.find((x: any) => x.name === 'urgentes').countDetails.activeMessageCount).toBe(1);
    sendMessage(nsr, { queue: 'facturas' }, 'factura-1', {}, undefined, me);
    for (let i = 0; i < 3; i++) abandonFirst(nsr, { kind: 'queue', queue: 'facturas' }, me);
    const q = JSON.parse(await ok('az servicebus queue show -g rg-svc --namespace-name sb-tienda-lab -n facturas'));
    expect(q.countDetails.deadLetterMessageCount).toBe(1);
    expect(receiveMessages(nsr, { kind: 'queue', queue: 'facturas' }, 5, me, true)).toHaveLength(1);
    expect(sbData(nsr).queues.facturas.deadLetter).toHaveLength(0);
    const keys = JSON.parse(await ok('az servicebus namespace authorization-rule keys list -g rg-svc --namespace-name sb-tienda-lab -n RootManageSharedAccessKey'));
    expect(keys.primaryConnectionString).toMatch(/^Endpoint=sb:\/\/sb-tienda-lab\.servicebus\.windows\.net\//);
  });
});

describe('Apagado automático de VM', () => {
  it('desasigna la VM a la hora programada y avisa por correo', async () => {
    const now = new Date();
    const hhmm = now.toISOString().slice(11, 16).replace(':', '');
    await ok(`az vm auto-shutdown -g rg-svc -n vm-dns --time ${hhmm} --email ops@contoso-lab.com -o none`);
    const vm = getState().resources.find((r) => r.name === 'vm-dns')!;
    expect(vm.data?.powerState).toBe('running');
    enforceAutoShutdown(getState(), now);
    expect(vm.data?.powerState).toBe('deallocated');
    expect(getState().emails[0].subject).toMatch(/Apagado automático de vm-dns/);
    // No vuelve a ejecutarse el mismo día aunque se arranque la VM.
    await ok('az vm start -g rg-svc -n vm-dns -o none');
    enforceAutoShutdown(getState(), now);
    expect(vm.data?.powerState).toBe('running');
  });
});

describe('Ficheros que importan (.gitignore, .env, package-lock.json)', () => {
  it('git respeta el .gitignore como el real', async () => {
    await ok('git config --global user.name "Estudiante" && git config --global user.email estudiante@example.com');
    await ok('mkdir -p ~/gi && cd ~/gi && git init');
    await ok("cd ~/gi && printf 'node_modules/\\n.env\\n.env.*\\n!.env.example\\n' > .gitignore");
    await ok('cd ~/gi && echo secreto > .env && echo plantilla > .env.example && mkdir -p node_modules/x && echo m > node_modules/x/i.js && echo app > app.js');
    await ok('cd ~/gi && git add .');
    const st = (await ok('cd ~/gi && git status --short')).split('\n').filter(Boolean);
    expect(st).toEqual(expect.arrayContaining(['A  .env.example', 'A  .gitignore', 'A  app.js']));
    expect(st.some((l) => /\s\.env$/.test(l) || l.includes('node_modules'))).toBe(false);
    const add = await sh('cd ~/gi && git add .env');
    expect(add.code).toBe(1);
    expect(add.err).toMatch(/ignored by one of your \.gitignore files:\n\.env/);
    expect(await ok('cd ~/gi && git check-ignore -v .env')).toBe('.gitignore:2:.env\t.env\n');
    expect((await sh('cd ~/gi && git check-ignore .env.example')).code).toBe(1);
    expect(await ok('cd ~/gi && git status --ignored')).toMatch(/Ignored files:[\s\S]*\.env[\s\S]*node_modules\//);
    // Forzado: queda versionado y el .gitignore ya no lo protege hasta git rm --cached.
    await ok('cd ~/gi && git add -f .env && git commit -qm "inicio"');
    expect((await sh('cd ~/gi && git check-ignore .env')).code).toBe(1);
    await ok('cd ~/gi && git rm --cached .env && git commit -qm "saca el .env"');
    expect(await ok('cd ~/gi && cat .env')).toBe('secreto\n');
    expect(await ok('cd ~/gi && git check-ignore .env')).toBe('.env\n');
    expect((await ok('cd ~/gi && git log --oneline -- .env')).trim().split('\n')).toHaveLength(2);
  });

  it('npm ci exige package-lock.json', async () => {
    await ok('mkdir -p ~/sinlock && cd ~/sinlock && npm init -y > /dev/null');
    const ci = await sh('cd ~/sinlock && npm ci');
    expect(ci.code).toBe(1);
    expect(ci.err).toMatch(/can only install with an existing package-lock\.json/);
    expect((await sh('cd ~/samples/app-node && npm ci')).code).toBe(0);
  });

  it('dotenv: el .env se usa si viaja, pero las App Settings siempre ganan', async () => {
    const files = { ...TEMPLATES['app-node'].files, '.env': 'APP_ENV=portatil\n# comentario\nGREETING="Hola desde .env"\n' };
    expect(renderApp({ files }, '/', {}).body).toMatch(/Hola desde \.env.*Entorno: portatil/);
    expect(renderApp({ files }, '/', { APP_ENV: 'produccion' }).body).toMatch(/Entorno: produccion/);
    expect(renderApp({ files: TEMPLATES['app-node'].files }, '/', {}).body).toMatch(/Entorno: local/);
    expect(startupLog({ files, env: {} })).toContain('[dotenv@17.2.3] injecting env (2) from .env');
  });

  it('avisa si un despliegue incluye un .env', async () => {
    await ok("cd ~/samples/app-node && printf 'APP_ENV=local\\n' > .env && zip -qr ~/fuga.zip .");
    expect(await ok('unzip -l ~/fuga.zip')).toMatch(/\s\.env\n/);
    const dep = await sh('az webapp deploy -g rg-svc -n app-dns-svc-01 --src-path ~/fuga.zip --type zip -o none');
    expect(dep.code).toBe(0);
    expect(dep.err).toMatch(/El paquete incluía \.env/);
    await ok('cd ~/samples/app-node && zip -qr ~/limpio.zip . -x ".env" && rm .env');
    const clean = await sh('az webapp deploy -g rg-svc -n app-dns-svc-01 --src-path ~/limpio.zip --type zip -o none');
    expect(clean.err).not.toMatch(/El paquete incluía/);
  });
});
