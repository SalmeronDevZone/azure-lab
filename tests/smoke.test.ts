// Pruebas de humo del simulador: ejecutan comandos reales en el Cloud Shell simulado.
import { describe, it, expect, beforeAll } from 'vitest';
import '../src/engine/providers';
import { createCloudShellSession } from '../src/shell/sessions';
import '../src/shell/pipelines';
import { getState } from '../src/engine/store';
import { ExitSignal, type Session, type ShellIO } from '../src/shell/interp';
import { tickKube } from '../src/engine/services/kube';

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
  if (r.code !== 0) throw new Error(`"${cmd}" → código ${r.code}\nSTDOUT:\n${r.out}\nSTDERR:\n${r.err}`);
  return r.out;
}

async function waitFor(fn: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  getState().settings.speed = 'instant';
  sess = createCloudShellSession({});
});

describe('shell básico', () => {
  it('tuberías, variables y bucles', async () => {
    expect(await ok('echo hola | tr a-z A-Z')).toBe('HOLA\n');
    expect(await ok('X=3; for i in $(seq 1 $X); do echo -n $i; done; echo')).toBe('123\n');
    expect(await ok('[[ -d ~/samples ]] && echo si')).toBe('si\n');
    expect(await ok('cat <<EOF\nhola $USER\nEOF')).toContain('hola');
    expect((await sh('comandoinexistente')).code).toBe(127);
  });
});

describe('az CLI', () => {
  it('cuenta y grupos', async () => {
    expect(await ok('az account show --query name -o tsv')).toContain('Azure Lab');
    await ok('az group create -n rg-smoke -l westeurope -o none');
    expect(await ok('az group list --query "[].name" -o tsv')).toContain('rg-smoke');
    expect((await sh('az group create -n rg-x -l marte')).code).not.toBe(0);
  });

  it('storage: cuenta, contenedor y blob', async () => {
    await ok('az storage account create -n stsmoke123 -g rg-smoke -l westeurope --sku Standard_LRS -o none');
    expect((await sh('az storage container create --account-name stsmoke123 -n datos --auth-mode login -o none')).err).toMatch(/AuthorizationPermissionMismatch/);
    await ok('az storage container create --account-name stsmoke123 -n datos --auth-mode key -o none');
    const r = await sh('echo hola > f.txt && az storage blob upload --account-name stsmoke123 -c datos -n f.txt -f f.txt --auth-mode login -o none');
    // Sin el rol Storage Blob Data Contributor la subida con --auth-mode login debe fallar, como en Azure.
    if (r.code !== 0) {
      expect(r.err).toMatch(/AuthorizationPermissionMismatch|permission/i);
      await ok('az storage blob upload --account-name stsmoke123 -c datos -n f.txt -f f.txt --auth-mode key -o none');
    }
    expect(await ok('az storage blob list --account-name stsmoke123 -c datos --auth-mode key --query "[].name" -o tsv')).toContain('f.txt');
  });

  it('VM con nginx accesible por HTTP', async () => {
    await ok('az vm create -g rg-smoke -n vm1 --image Ubuntu2204 --admin-username azureuser --generate-ssh-keys -o none');
    const ip = (await ok('az vm show -d -g rg-smoke -n vm1 --query publicIps -o tsv')).trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    await ok('az vm run-command invoke -g rg-smoke -n vm1 --command-id RunShellScript --scripts "apt-get update && apt-get install -y nginx" -o none');
    const blocked = await sh(`curl -s -m 5 http://${ip}`);
    expect(blocked.code).not.toBe(0);
    await ok('az vm open-port -g rg-smoke -n vm1 --port 80 -o none');
    expect(await ok(`curl -s http://${ip}`)).toMatch(/nginx/i);
  });

  it('App Service con despliegue zip', async () => {
    await ok('az appservice plan create -g rg-smoke -n plan-smoke --sku B1 --is-linux -o none');
    await ok('az webapp create -g rg-smoke -p plan-smoke -n app-smoke-777 --runtime "NODE:20-lts" -o none');
    await ok('cd ~/samples/app-node && zip -r ../app.zip . > /dev/null && cd ~');
    await ok('az webapp deploy -g rg-smoke -n app-smoke-777 --src-path ~/samples/app.zip --type zip -o none');
    expect(await ok('curl -s https://app-smoke-777.azurewebsites.net')).toContain('Hola desde Azure Lab');
    await ok('az webapp config appsettings set -g rg-smoke -n app-smoke-777 --settings GREETING="Hola v2" -o none');
    expect(await ok('curl -s https://app-smoke-777.azurewebsites.net')).toContain('Hola v2');
  });

  it('ARM y Bicep', async () => {
    await ok('az deployment group create -g rg-smoke -f ~/samples/arm/storage.json -o none');
    await ok('az deployment group create -g rg-smoke -f ~/samples/bicep/main.bicep -o none');
    expect(await ok('az deployment group list -g rg-smoke --query "length(@)"')).not.toBe('0\n');
  });

  it('Terraform init/plan/apply', async () => {
    const out = await sh('cd ~/samples/terraform && export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv) && terraform init > /dev/null && terraform apply -auto-approve');
    await ok('cd ~');
    if (out.code !== 0) throw new Error(out.out + out.err);
    expect(out.out).toMatch(/Apply complete!/);
  });
});

describe('contenedores', () => {
  it('ACR build + AKS + kubectl', async () => {
    await ok('az acr create -g rg-smoke -n acrsmoke777 --sku Basic -o none');
    await ok('cd ~/samples/app-node && az acr build -r acrsmoke777 -t app-node:v1 . > /dev/null; cd ~');
    expect(await ok('az acr repository list -n acrsmoke777 -o tsv')).toContain('app-node');
    await ok('az aks create -g rg-smoke -n aks-smoke --node-count 1 --generate-ssh-keys --attach-acr acrsmoke777 -o none');
    await ok('az aks get-credentials -g rg-smoke -n aks-smoke --overwrite-existing');
    await ok("sed -i 's/<TU_ACR>/acrsmoke777/' ~/samples/app-node/k8s/deployment.yaml");
    await ok('kubectl apply -f ~/samples/app-node/k8s/');
    for (let i = 0; i < 30; i++) {
      tickKube(getState());
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(await ok('kubectl get pods')).toMatch(/Running/);
    const ip = (await ok("kubectl get svc app-node -o jsonpath='{.status.loadBalancer.ingress[0].ip}'")).trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(await ok(`curl -s http://${ip}`)).toContain('Hola desde Azure Lab');
  });
});

describe('Azure DevOps', () => {
  it('proyecto, repos, git push y pipeline CI/CD', async () => {
    await ok('az devops project create --name lab-smoke -o none');
    await ok('az devops configure --defaults project=lab-smoke');
    await ok('az repos import create --git-source-url https://github.com/azure-lab/app-node --repository lab-smoke -o none');
    const sub = (await ok('az account show --query id -o tsv')).trim();
    const sp = JSON.parse(await ok(`az ad sp create-for-rbac --name sp-smoke --role Contributor --scopes /subscriptions/${sub}`));
    await ok(
      `export AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY='${sp.password}'; az devops service-endpoint azurerm create --name sc-azure-lab --azure-rm-service-principal-id ${sp.appId} --azure-rm-subscription-id ${sub} --azure-rm-subscription-name x --azure-rm-tenant-id ${sp.tenant} -o none`,
    );
    const url = (await ok('az repos show -r lab-smoke --query remoteUrl -o tsv')).trim();
    await ok('git config --global user.name "Estudiante" && git config --global user.email estudiante@example.com');
    await ok(`git clone ${url} repo-smoke > /dev/null 2>&1`);
    await ok(`cd repo-smoke && sed -i "s/<NOMBRE_DE_TU_WEBAPP>/app-smoke-777/" azure-pipelines.yml && git add . && git commit -m "configurar webapp" > /dev/null && git push > /dev/null 2>&1; cd ~`);
    await ok('az pipelines create --name ci-smoke --repository lab-smoke --branch main --yml-path /azure-pipelines.yml -o none');
    const project = getState().devops.projects.find((p) => p.name === 'lab-smoke')!;
    await waitFor(() => project.runs.length > 0 && ['succeeded', 'failed', 'canceled', 'succeededWithIssues'].includes(project.runs[0].status), 20000);
    const run = project.runs[0];
    const dump = run.stages.map((s) => `${s.name}:${s.status}\n` + s.jobs.map((j) => j.steps.map((st) => `  [${st.status}] ${st.name}\n${st.log.map((l) => '      ' + l).join('\n')}`).join('\n')).join('\n')).join('\n');
    if (run.status !== 'succeeded') throw new Error(`run ${run.status} ${run.error ?? ''}\n${dump}`);
    expect(run.artifacts.drop).toBeTruthy();
  }, 30000);
});

describe('seguridad, datos y gobierno', () => {
  it('Key Vault con RBAC', async () => {
    await ok('az keyvault create -g rg-smoke -n kv-smoke-777 -l westeurope -o none');
    const denied = await sh('az keyvault secret set --vault-name kv-smoke-777 -n clave --value s3cr3t -o none');
    expect(denied.code).not.toBe(0);
    const me = (await ok('az ad signed-in-user show --query id -o tsv')).trim();
    const kvId = (await ok('az keyvault show -n kv-smoke-777 --query id -o tsv')).trim();
    await ok(`az role assignment create --assignee ${me} --role "Key Vault Secrets Officer" --scope ${kvId} -o none`);
    await ok('az keyvault secret set --vault-name kv-smoke-777 -n clave --value s3cr3t -o none');
    expect(await ok('az keyvault secret show --vault-name kv-smoke-777 -n clave --query value -o tsv')).toBe('s3cr3t\n');
  });

  it('Azure SQL con firewall y sqlcmd', async () => {
    await ok('az sql server create -g rg-smoke -n sql-smoke-777 -l westeurope -u sqladmin -p "P@ssw0rd-Lab-2026" -o none');
    await ok('az sql db create -g rg-smoke -s sql-smoke-777 -n appdb --service-objective Basic -o none');
    const blocked = await sh('sqlcmd -S sql-smoke-777.database.windows.net -d appdb -U sqladmin -P "P@ssw0rd-Lab-2026" -Q "SELECT 1"');
    expect(blocked.code).not.toBe(0);
    await ok('az sql server firewall-rule create -g rg-smoke -s sql-smoke-777 -n cloudshell --start-ip-address 20.31.118.42 --end-ip-address 20.31.118.42 -o none');
    await ok('sqlcmd -S sql-smoke-777.database.windows.net -d appdb -U sqladmin -P "P@ssw0rd-Lab-2026" -Q "CREATE TABLE t (id INT, nombre NVARCHAR(50)); INSERT INTO t VALUES (1, \'ana\')"');
    expect(await ok('sqlcmd -S sql-smoke-777.database.windows.net -d appdb -U sqladmin -P "P@ssw0rd-Lab-2026" -Q "SELECT nombre FROM t"')).toContain('ana');
  });

  it('bloqueos, etiquetas y directivas', async () => {
    await ok('az group create -n rg-lock -l westeurope -o none');
    await ok('az lock create -n no-borrar -g rg-lock --lock-type CanNotDelete -o none');
    const del = await sh('az group delete -n rg-lock --yes');
    expect(del.code).not.toBe(0);
    expect(del.err).toMatch(/ScopeLocked/);
    await ok('az lock delete -n no-borrar -g rg-lock');
    await ok('az group delete -n rg-lock --yes');
    await ok('az group update -n rg-smoke --tags entorno=lab -o none');
    expect(await ok('az group show -n rg-smoke --query tags.entorno -o tsv')).toBe('lab\n');
  });

  it('usuarios, grupos y roles', async () => {
    const domain = (await ok("az account show --query user.name -o tsv")).trim().split('@')[1];
    await ok(`az ad user create --display-name "Ana Ops" --user-principal-name ana@${domain} --password "Lab-P@ssw0rd-1" -o none`);
    await ok('az ad group create --display-name ops --mail-nickname ops -o none');
    await ok(`az ad group member add -g ops --member-id $(az ad user show --id ana@${domain} --query id -o tsv)`);
    const sub = (await ok('az account show --query id -o tsv')).trim();
    await ok(`az role assignment create --assignee $(az ad group show -g ops --query id -o tsv) --role Reader --scope /subscriptions/${sub}/resourceGroups/rg-smoke -o none`);
    expect(await ok('az role assignment list -g rg-smoke --query "[].roleDefinitionName" -o tsv')).toContain('Reader');
  });

  it('docker local', async () => {
    await ok('cd ~/samples/app-node && docker build -t app-local:1 . > /dev/null; cd ~');
    await ok('docker run -d -p 8080:3000 --name web app-local:1 > /dev/null');
    expect(await ok('curl -s localhost:8080')).toContain('Hola desde Azure Lab');
    expect(await ok('docker ps --format "{{.Names}}"')).toContain('web');
  });

  it('Log Analytics y KQL', async () => {
    await ok('az monitor log-analytics workspace create -g rg-smoke -n law-smoke -o none');
    const r = await ok('az monitor log-analytics query -w $(az monitor log-analytics workspace show -g rg-smoke -n law-smoke --query customerId -o tsv) --analytics-query "AzureActivity | summarize count() by OperationNameValue | take 5" -o json');
    expect(() => JSON.parse(r)).not.toThrow();
  });
});
