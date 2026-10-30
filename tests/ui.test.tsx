// Prueba de renderizado de todas las rutas de la interfaz (detecta errores en tiempo de ejecución).
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToString } from 'react-dom/server';
import '../src/engine/providers';
import { createCloudShellSession } from '../src/shell/sessions';
import '../src/shell/pipelines';
import { getState } from '../src/engine/store';
import { ExitSignal, type Session, type ShellIO } from '../src/shell/interp';
import { App } from '../src/ui/App';
import { setRouteForTests } from '../src/ui/hooks';
import { setUi } from '../src/ui/uiStore';
import { typeBlade } from '../src/ui/portal/types';
import { LEVELS } from '../src/ui/academy/content';
import { startExercise } from '../src/ui/academy/progress';

let sess: Session;

async function sh(cmd: string) {
  let out = '';
  const io: ShellIO = { stdin: null, out: (s) => (out += s), err: (s) => (out += s), isTTY: false, signal: new AbortController().signal, prompt: async () => 'y' };
  let code: number;
  try {
    code = await sess.run(cmd, io);
  } catch (e) {
    code = e instanceof ExitSignal ? e.code : 1;
  }
  if (code !== 0) throw new Error(`${cmd}\n${out}`);
  return out;
}

function render(hash: string): string {
  setRouteForTests(hash);
  try {
    return renderToString(<App />);
  } catch (e: any) {
    throw new Error(`Fallo al renderizar ${hash}: ${e?.stack ?? e}`);
  }
}

beforeAll(async () => {
  const s = getState();
  s.settings.speed = 'instant';
  s.settings.onboarded = true;
  s.settings.freeMode = true;
  sess = createCloudShellSession({});
  await sh('az group create -n rg-ui -l westeurope --tags entorno=test -o none');
  await sh('az storage account create -n stuitest01 -g rg-ui --sku Standard_LRS -o none');
  await sh('az storage container create --account-name stuitest01 -n datos --auth-mode key -o none');
  await sh('az storage blob upload --account-name stuitest01 -c datos -n a.txt --data hola --auth-mode key -o none');
  await sh('az vm create -g rg-ui -n vm1 --image Ubuntu2204 --admin-username azureuser --generate-ssh-keys -o none');
  await sh('az appservice plan create -g rg-ui -n plan1 --sku S1 --is-linux -o none');
  await sh('az webapp create -g rg-ui -p plan1 -n app-ui-test-01 --runtime "NODE:20-lts" -o none');
  await sh('az webapp deployment slot create -g rg-ui -n app-ui-test-01 --slot staging -o none');
  await sh('az keyvault create -g rg-ui -n kv-ui-test-01 -o none');
  await sh('az sql server create -g rg-ui -n sql-ui-test-01 -u sqladmin -p "P@ssw0rd-Lab-2026" -o none');
  await sh('az sql db create -g rg-ui -s sql-ui-test-01 -n db1 --service-objective Basic -o none');
  await sh('az network nsg create -g rg-ui -n nsg1 -o none');
  await sh('az network public-ip create -g rg-ui -n pip1 -o none');
  await sh('az acr create -g rg-ui -n acruitest01 --sku Basic -o none');
  await sh('az aks create -g rg-ui -n aks1 --node-count 1 --generate-ssh-keys -o none');
  await sh('az container create -g rg-ui -n aci1 --image nginx --ports 80 -o none');
  await sh('az monitor log-analytics workspace create -g rg-ui -n law1 -o none');
  await sh('az monitor app-insights component create --app ai1 -g rg-ui -l westeurope -o none');
  await sh('az identity create -g rg-ui -n id1 -o none');
  await sh('az monitor action-group create -g rg-ui -n ag1 --short-name ag1 --action email admin a@b.com -o none');
  await sh('az monitor metrics alert create -g rg-ui -n cpu --scopes $(az vm show -g rg-ui -n vm1 --query id -o tsv) --condition "avg Percentage CPU > 80" --action ag1 -o none');
  await sh('az lock create -n l1 -g rg-ui --lock-type CanNotDelete -o none');
  await sh('az devops project create --name ui-proj -o none && az devops configure --defaults project=ui-proj');
  await sh('az repos import create --git-source-url https://github.com/azure-lab/app-node --repository ui-proj -o none');
  await sh('az pipelines create --name ci --repository ui-proj --branch main --yml-path /azure-pipelines.yml -o none');
  await new Promise((r) => setTimeout(r, 400));
  await startExercise(LEVELS[0].exercises[0]);
}, 60000);

describe('renderizado de rutas', () => {
  it('portal: páginas generales', () => {
    for (const h of ['#/', '#/services', '#/resources', '#/groups', '#/subscriptions', '#/mail', '#/advisor', '#/cost', '#/cost/budgets']) expect(render(h).length).toBeGreaterThan(100);
  });

  it('portal: listas por tipo y blades de cada recurso', () => {
    const s = getState();
    const types = [...new Set(s.resources.map((r) => r.type))];
    for (const t of types) render(`#/browse/${encodeURIComponent(t)}`);
    for (const r of s.resources) {
      const sections = ['overview', 'activity', 'iam', 'tags', 'locks', 'export', 'json', ...(typeBlade(r.type).sections ?? []).map((x) => x.id)];
      for (const sec of sections) render(`#/resource/${encodeURIComponent(r.id)}/${sec}`);
    }
    for (const g of s.resourceGroups) for (const sec of ['overview', 'activity', 'iam', 'tags', 'deployments', 'locks', 'cost', 'export']) render(`#/resource/${encodeURIComponent(g.id)}/${sec}`);
    for (const sub of s.subscriptions) for (const sec of ['overview', 'iam', 'groups', 'locks', 'activity']) render(`#/resource/${encodeURIComponent('/subscriptions/' + sub.id)}/${sec}`);
    expect(render('#/resource/' + encodeURIComponent('/subscriptions/x/resourceGroups/no/providers/A/b/c'))).toContain('No se encontró');
  });

  it('portal: asistentes de creación', () => {
    for (const w of ['rg', 'storage', 'vm', 'webapp', 'plan', 'sql', 'keyvault', 'vnet', 'nsg', 'pip', 'acr', 'aks', 'aci', 'law', 'appinsights', 'identity']) expect(render(`#/create/${w}?rg=rg-ui`)).toContain('wizard-tabs');
  });

  it('portal: Entra, Monitor y Directiva', () => {
    for (const sec of ['overview', 'users', 'groups', 'apps', 'enterprise']) render(`#/entra/${sec}`);
    for (const sec of ['overview', 'activity', 'alerts', 'metrics', 'logs', 'diagnostics']) render(`#/monitor/${sec}`);
    for (const sec of ['overview', 'assignments', 'definitions']) render(`#/policy/${sec}`);
  });

  it('Azure DevOps', () => {
    const p = getState().devops.projects[0];
    const base = `#/devops/${encodeURIComponent(p.name)}`;
    render('#/devops');
    for (const a of ['', '/boards', '/repos', '/repos/ui-proj/files', '/repos/ui-proj/files?path=server.js', '/repos/ui-proj/files?path=k8s', '/repos/ui-proj/commits', '/repos/ui-proj/branches', '/repos/ui-proj/prs', '/repos/ui-proj/policies', '/pipelines', '/environments', '/library', '/settings']) render(base + a);
    for (const r of p.runs) expect(render(`${base}/pipelines/runs/${r.id}`)).toContain(r.buildNumber);
  });

  it('Academia: todos los niveles, lecciones, laboratorios y cuestionarios', () => {
    render('#/academy');
    render('#/academy/guide');
    for (const l of LEVELS) {
      render(`#/academy/level/${l.id}`);
      for (const le of l.lessons) expect(render(`#/academy/level/${l.id}/lesson/${le.id}`)).toContain(le.title.slice(0, 10));
      for (const ex of l.exercises) render(`#/academy/level/${l.id}/exercise/${ex.id}`);
      render(`#/academy/level/${l.id}/quiz`);
    }
  });

  it('Cloud Shell abierto y panel del laboratorio', () => {
    setUi({ shellOpen: true });
    expect(render('#/')).toContain('shell-dock');
    setUi({ shellOpen: false });
  });
});
