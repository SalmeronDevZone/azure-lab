// Ejecuta la solución de referencia de cada laboratorio de la Academia en un Cloud Shell simulado
// y comprueba que todos sus pasos se validan. Garantiza que el currículo y el simulador encajan.
import { describe, it, expect, beforeAll } from 'vitest';
import '../src/engine/providers';
import { createCloudShellSession } from '../src/shell/sessions';
import '../src/shell/pipelines';
import { getState, changed } from '../src/engine/store';
import { ExitSignal, isIncomplete, type Session, type ShellIO, type SessionUI } from '../src/shell/interp';
import { tickKube } from '../src/engine/services/kube';
import { evaluateAlerts } from '../src/engine/services/monitor';
import { createAcrConnection, createEnvironment, createKubernetesConnection } from '../src/engine/services/devops';
import { LEVELS } from '../src/ui/academy/content';
import type { Exercise } from '../src/ui/academy/types';
import { startExercise, evaluateNow, getProgress, stepFeedback } from '../src/ui/academy/progress';
import { portalPrincipal } from '../src/engine/store';
import { guid } from '../src/engine/util';
import { recordPortalCommand } from '../src/shell/sessions';
import { sendMessage, abandonFirst } from '../src/engine/services/servicebus';
import { T_SB } from '../src/engine/providers/servicebus';
import { GRAPH_SAMPLES } from '../src/engine/services/resourceGraph';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const stack: Session[] = [];
let transcript = '';

const ui: SessionUI = {
  enterSession: (child, banner) => {
    stack.push(child);
    if (banner) transcript += banner;
  },
  exitSession: () => {
    if (stack.length > 1) stack.pop();
  },
  openUrl: () => undefined,
  openEditor: () => undefined,
  clear: () => undefined,
};

async function line(src: string) {
  const sess = stack[stack.length - 1];
  const io: ShellIO = { stdin: null, out: (s) => (transcript += s), err: (s) => (transcript += s), isTTY: true, signal: new AbortController().signal, prompt: async () => 'yes' };
  const entry = { id: guid(), cmd: src, ts: Date.now(), ok: true, source: 'typed' as const };
  getState().cli.commandLog.push(entry);
  transcript += `\n$ ${src}\n`;
  try {
    const code = await sess.run(src, io);
    entry.ok = code === 0;
  } catch (e) {
    if (e instanceof ExitSignal) {
      if (stack.length > 1) stack.pop();
    } else {
      transcript += `\n[excepción] ${(e as Error)?.stack ?? e}\n`;
      entry.ok = false;
    }
  }
}

/** Ejecuta un bloque de bash como lo haría el estudiante, línea a línea (agrupando heredocs y bloques). */
async function runBlock(block: string) {
  let acc = '';
  for (const raw of block.split('\n')) {
    if (!acc && (!raw.trim() || raw.trim().startsWith('#'))) continue;
    acc = acc ? `${acc}\n${raw}` : raw;
    if (isIncomplete(acc)) continue;
    // Quita un comentario "  # ..." al final de la última línea (nunca cruza saltos de línea: rompería los heredocs).
    await line(acc.replace(/[ \t]+#[ \t][^'"\n]*$/, ''));
    evaluateNow();
    acc = '';
  }
  if (acc) await line(acc);
}

function fill(md: string): string {
  const s = getState();
  return md
    .replace(/\{\{domain\}\}/g, s.tenant.domain)
    .replace(/\{\{upn\}\}/g, s.me.upn)
    .replace(/\{\{user\}\}/g, s.me.upn.split('@')[0])
    .replace(/\{\{sub\}\}/g, s.currentSubscriptionId)
    .replace(/\{\{name\}\}/g, s.me.displayName.split(' ')[0]);
}

function bashBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```bash\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) out.push(m[1]);
  return out;
}

const project = (name: string) => getState().devops.projects.find((p) => p.name === name)!;

const PR_FLOW = (branch: string, title: string) => `PR=$(az repos pr create --source-branch ${branch} --target-branch main --title "${title}" --query pullRequestId -o tsv)
az repos pr set-vote --id $PR --vote approve
az repos pr update --id $PR --status completed`;

const PROD_STAGE = `cat >> azure-pipelines.yml <<'EOF'

  - stage: DeployProd
    displayName: 'Produccion'
    dependsOn: Deploy
    jobs:
      - deployment: Prod
        environment: 'prod'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Desplegando $(Build.BuildNumber) en produccion"
EOF`;

const SC_FOR = (rg: string, spName: string) => `RG_ID=$(az group show -n ${rg} --query id -o tsv)
SP=$(az ad sp create-for-rbac --name ${spName} --role Contributor --scopes $RG_ID)
export AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY=$(echo $SP | jq -r .password)
az devops service-endpoint azurerm create --name sc-azure-lab --azure-rm-service-principal-id $(echo $SP | jq -r .appId) --azure-rm-subscription-id $(az account show --query id -o tsv) --azure-rm-subscription-name "Azure Lab - Desarrollo" --azure-rm-tenant-id $(echo $SP | jq -r .tenant)`;

async function approvePending(projectName: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const p = project(projectName);
    for (const r of p.runs) {
      const st = r.stages.find((s) => s.approval?.status === 'pending');
      if (st) {
        await line(`az pipelines runs approve --id ${r.id} --stage ${st.name} --project ${projectName}`);
        return;
      }
    }
    await new Promise((res) => setTimeout(res, 100));
  }
}

type Part = string | (() => Promise<void> | void);

/** Ejercicios cuya solución usa el portal o pasos interactivos: guion equivalente para la prueba. */
const OVERRIDES: Record<string, Part[]> = {
  'e9-aks': [],
  'e11-ci': [
    `cd ~/lab-devops && git checkout main && git pull
cat > ci.yml <<'EOF'
trigger:
- main

pool:
  vmImage: ubuntu-latest

steps:
- task: NodeTool@0
  inputs:
    versionSpec: '20.x'
- script: |
    npm install
    npm test
  displayName: 'npm install y npm test'
EOF
git checkout -b feature/ci && git add ci.yml && git commit -m "Pipeline de CI" && git push -u origin feature/ci
${PR_FLOW('feature/ci', 'Pipeline de CI')}
az pipelines create --name ci --repository lab-devops --branch main --yml-path /ci.yml
git checkout main && git pull
git checkout -b feature/ci2 && echo "// ci" >> server.js && git commit -am "Dispara CI" && git push -u origin feature/ci2
${PR_FLOW('feature/ci2', 'Dispara CI')}`,
  ],
  'e11-cd': [
    `az group create -n rg-nivel11 -l westeurope
az appservice plan create -g rg-nivel11 -n plan-cd --sku B1 --is-linux
APP=app-cd-$RANDOM
az webapp create -g rg-nivel11 -p plan-cd -n $APP --runtime "NODE:20-lts"
${SC_FOR('rg-nivel11', 'sp-cd-lab')}
cd ~/lab-devops && git checkout main && git pull
git checkout -b feature/cd
sed -i "s/<NOMBRE_DE_TU_WEBAPP>/$APP/" azure-pipelines.yml
git commit -am "Configura la web app del pipeline" && git push -u origin feature/cd
${PR_FLOW('feature/cd', 'CD')}
az pipelines create --name cd-app --repository lab-devops --branch main --yml-path /azure-pipelines.yml`,
  ],
  'e11-approvals': [
    () => void createEnvironment(project('lab-devops'), 'prod', true, [getState().me.displayName]),
    `cd ~/lab-devops && git checkout main && git pull
git checkout -b feature/prod
${PROD_STAGE}
git commit -am "Fase de produccion" && git push -u origin feature/prod
${PR_FLOW('feature/prod', 'Produccion')}`,
    () => approvePending('lab-devops'),
  ],
  'e11-secret': [
    `az pipelines variable create --pipeline-name ci --name apiKey --value "sk-12345-secreto" --secret true
cd ~/lab-devops && git checkout main && git pull
git checkout -b feature/secret
cat >> ci.yml <<'EOF'
- script: |
    echo "Usando la clave: $API_KEY"
  displayName: 'Usar el secreto'
  env:
    API_KEY: $(apiKey)
EOF
git commit -am "Usa el secreto" && git push -u origin feature/secret
${PR_FLOW('feature/secret', 'Secreto')}`,
  ],
  'e13-plataforma': [
    `az group create -n rg-final -l westeurope --tags proyecto=tienda-nube propietario=estudiante
az deployment group create -g rg-final -f ~/samples/bicep/main.bicep -p entorno=prod
APP=$(az webapp list -g rg-final --query "[0].name" -o tsv)
KV=kv-final-$RANDOM
az keyvault create -g rg-final -n $KV --enable-rbac-authorization true
az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Key Vault Secrets Officer" --scope $(az keyvault show -n $KV --query id -o tsv)
az keyvault secret set --vault-name $KV -n DbPassword --value "Pr0d-S3cr3t!"
PID=$(az webapp identity assign -g rg-final -n $APP --query principalId -o tsv)
az role assignment create --assignee $PID --role "Key Vault Secrets User" --scope $(az keyvault show -n $KV --query id -o tsv)
az webapp config appsettings set -g rg-final -n $APP --settings "DB_PASSWORD=@Microsoft.KeyVault(SecretUri=https://$KV.vault.azure.net/secrets/DbPassword/)"
az devops project create --name final
az devops configure --defaults project=final
az repos import create --git-source-url https://github.com/azure-lab/app-node --repository final
${SC_FOR('rg-final', 'sp-final')}`,
    () => void createEnvironment(project('final'), 'prod', true, [getState().me.displayName]),
    `cd ~ && git clone $(az repos show -r final --query remoteUrl -o tsv) && cd final
sed -i "s/<NOMBRE_DE_TU_WEBAPP>/$APP/" azure-pipelines.yml
${PROD_STAGE}
git commit -am "Pipeline completo" && git push
az pipelines create --name release --repository final --branch main --yml-path /azure-pipelines.yml
az repos policy approver-count create --repository-id final --branch main --minimum-approver-count 1 --creator-vote-counts true --blocking true --enabled true --allow-downvotes false --reset-on-source-push false
az monitor action-group create -g rg-final -n ag-final --short-name final --action email admin $(az account show --query user.name -o tsv)
az monitor metrics alert create -g rg-final -n errores-5xx --scopes $(az webapp show -g rg-final -n $APP --query id -o tsv) --condition "total Http5xx > 5" --window-size 5m --action ag-final
az lock create -n no-borrar -g rg-final --lock-type CanNotDelete
az consumption budget create -n presupuesto-final --amount 100 --category cost --time-grain monthly --start-date 2026-01-01 --end-date 2027-12-31 --thresholds 80 100 --contact-emails $(az account show --query user.name -o tsv)`,
    () => approvePending('final'),
  ],
  'e13-k8s-cicd': [
    `az group create -n rg-final-k8s -l westeurope
ACR=acrfinal$RANDOM
az acr create -g rg-final-k8s -n $ACR --sku Basic
az aks create -g rg-final-k8s -n aks-final --node-count 2 --generate-ssh-keys --attach-acr $ACR`,
    () => {
      const s = getState();
      const acr = s.resources.find((r) => r.type === 'Microsoft.ContainerRegistry/registries' && r.resourceGroup === 'rg-final-k8s')!;
      const aks = s.resources.find((r) => r.type === 'Microsoft.ContainerService/managedClusters' && r.resourceGroup === 'rg-final-k8s')!;
      createAcrConnection(project('final'), 'sc-acr', acr.id, portalPrincipal());
      createKubernetesConnection(project('final'), 'sc-aks', aks.id, portalPrincipal());
    },
    `cd ~/final && git checkout main && git pull
git checkout -b feature/k8s
sed -i "s/<TU_ACR>/$ACR/" k8s/deployment.yaml
cat > k8s-pipeline.yml <<'EOF'
trigger:
- main

pool:
  vmImage: ubuntu-latest

variables:
  acr: '<ACR>.azurecr.io'

stages:
- stage: Build
  jobs:
  - job: Imagen
    steps:
    - task: Docker@2
      inputs:
        command: buildAndPush
        containerRegistry: 'sc-acr'
        repository: 'app-node'
        Dockerfile: '**/Dockerfile'
        tags: '$(Build.BuildId)'
    - publish: '$(Build.SourcesDirectory)/k8s'
      artifact: manifiestos

- stage: Deploy
  dependsOn: Build
  jobs:
  - deployment: AKS
    environment: 'aks-prod'
    strategy:
      runOnce:
        deploy:
          steps:
          - task: KubernetesManifest@1
            inputs:
              action: deploy
              kubernetesServiceConnection: 'sc-aks'
              namespace: default
              manifests: |
                $(Pipeline.Workspace)/manifiestos/deployment.yaml
                $(Pipeline.Workspace)/manifiestos/service.yaml
              containers: '$(acr)/app-node:$(Build.BuildId)'
EOF
sed -i "s/<ACR>/$ACR/" k8s-pipeline.yml
git add . && git commit -m "Pipeline de contenedores" && git push -u origin feature/k8s
${PR_FLOW('feature/k8s', 'K8s')}
az pipelines create --name k8s --repository final --branch main --yml-path /k8s-pipeline.yml`,
  ],
  // El envío de mensajes se hace en el Explorador de Service Bus del portal.
  'e7-servicebus': [
    bashBlocks(LEVELS[6].exercises.find((e) => e.id === 'e7-servicebus')!.solution)[0],
    () => {
      const ns = getState().resources.find((r) => r.type === T_SB && r.resourceGroup === 'rg-nivel7')!;
      const me = portalPrincipal();
      sendMessage(ns, { topic: 'pedidos' }, '{"pedidoId":1}', { prioridad: 'alta' }, 'pedido', me);
      sendMessage(ns, { topic: 'pedidos' }, '{"pedidoId":2}', { prioridad: 'baja' }, 'pedido', me);
      sendMessage(ns, { queue: 'facturas' }, 'factura-1', {}, undefined, me);
      for (let i = 0; i < 3; i++) abandonFirst(ns, { kind: 'queue', queue: 'facturas' }, me);
    },
    bashBlocks(LEVELS[6].exercises.find((e) => e.id === 'e7-servicebus')!.solution)[1],
  ],
  'e12-graph': [
    bashBlocks(LEVELS[11].exercises.find((e) => e.id === 'e12-graph')!.solution)[0],
    () => recordPortalCommand(`az graph query -q "${GRAPH_SAMPLES[0].q.replace(/\n/g, ' ')}"`, true, portalPrincipal()),
  ],
};

async function waitDone(ex: Exercise, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = getState();
    tickKube(s);
    evaluateAlerts(s);
    evaluateNow();
    if (getProgress().done[ex.id]) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  evaluateNow();
  return !!getProgress().done[ex.id];
}

const results: { id: string; ok: boolean; missing: string[] }[] = [];

beforeAll(() => {
  const s = getState();
  s.settings.speed = 'instant';
  s.settings.onboarded = true;
  stack.push(createCloudShellSession(ui));
});

describe('soluciones de la Academia', () => {
  for (const level of LEVELS) {
    for (const ex of level.exercises) {
      it(`nivel ${level.id} · ${ex.id}`, async () => {
        transcript = '';
        while (stack.length > 1) stack.pop();
        await startExercise(ex);
        const parts: Part[] = OVERRIDES[ex.id]?.length ? OVERRIDES[ex.id] : bashBlocks(ex.solution).map((b) => (ex.id === 'e9-aks' ? b.replace(/kubectl get pods -w/g, 'kubectl get pods') : b));
        for (const part of parts) {
          if (typeof part === 'string') await runBlock(fill(part));
          else await part();
          changed();
        }
        const ok = await waitDone(ex, 25000);
        const done = new Set(getProgress().steps[ex.id] ?? []);
        const missing = ex.steps.filter((st) => !done.has(st.id)).map((st) => `${st.id}: ${stepFeedback(ex.id, st.id) ?? '(sin pista)'}`);
        results.push({ id: ex.id, ok, missing });
        if (!ok) throw new Error(`Pasos sin completar en ${ex.id}:\n  ${missing.join('\n  ')}\n\n--- Transcripción (final) ---\n${strip(transcript).slice(-6000)}`);
        expect(ok).toBe(true);
      }, 120000);
    }
  }
});
