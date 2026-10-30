// Niveles 10 y 11: Git y Azure Repos; Azure Pipelines (CI/CD).
import type { Level } from '../types';
import type { CheckCtx } from '../checks';
import type { DevOpsProject, DevOpsRepo, PipelineRun } from '../../../engine/types';
import { T, rgCheck, siteUrl, scLimitedTo } from './helpers';
import { pipelineParameters } from '../../../shell/pipelines';
import { commitFile } from '../../../engine/services/devops';
import { getState } from '../../../engine/store';

const proj = (c: CheckCtx) => c.project('lab-devops');
const repo = (c: CheckCtx): DevOpsRepo | undefined => proj(c)?.repos.find((r) => r.name.toLowerCase() === 'lab-devops') ?? proj(c)?.repos[0];
const headTree = (r: DevOpsRepo | undefined) => (r && r.branches[r.defaultBranch] ? r.commits[r.branches[r.defaultBranch]]?.tree ?? {} : {});
const recentRuns = (c: CheckCtx, p: DevOpsProject | undefined): PipelineRun[] => (p?.runs ?? []).filter((r) => new Date(r.queuedAt).getTime() >= c.since);
const allLogs = (r: PipelineRun) => r.stages.flatMap((s) => s.jobs.flatMap((j) => j.steps.flatMap((st) => st.log)));
const ok = (r: PipelineRun) => r.status === 'succeeded' || r.status === 'succeededWithIssues';
const localFile = (c: CheckCtx, name: string) => {
  const p = Object.keys(c.s.gitLocal).find((x) => /\/lab-devops$/i.test(x));
  return p ? c.file(`${p}/${name}`) : null;
};
const MARTA_ENV = '# Configuración del portátil de Marta\nAPP_ENV=portatil-marta\nDB_PASSWORD=Marta-1234!\n';

export const LEVEL10: Level = {
  id: 10,
  slug: 'git',
  title: 'Git y Azure Repos',
  subtitle: 'Control de versiones, ramas, pull requests y directivas de rama en Azure DevOps',
  icon: 'devops',
  skills: ['Git', 'clone/commit/push', 'Ramas', 'Pull requests', 'Revisión de código', 'Directivas de rama'],
  lessons: [
    {
      id: 'l10-git',
      title: 'Git en diez minutos',
      minutes: 9,
      body: `**Git** guarda la historia de tu código como una serie de **commits** (instantáneas). Todo lo que hace un equipo DevOps —código de la aplicación, infraestructura (Bicep/Terraform), pipelines (YAML)— vive en Git.

## Las tres zonas

\`\`\`
directorio de trabajo  --git add-->  área de preparación (staging)  --git commit-->  repositorio local  --git push-->  remoto (Azure Repos)
\`\`\`

## Primeros pasos

\`\`\`bash
git config --global user.name "{{name}}"
git config --global user.email "{{upn}}"

git clone https://.../_git/lab-devops      # copia el repositorio remoto
cd lab-devops
git status                                  # qué ha cambiado
git add server.js                           # preparar un fichero (o: git add .)
git commit -m "Cambia el saludo"            # crear el commit
git push                                    # enviarlo al remoto
git log --oneline                           # historia
git pull                                    # traer los cambios de otros
\`\`\`

## Buenos commits

- Pequeños y con un propósito: "Añade la ruta /health", no "cambios varios".
- Mensaje en imperativo y claro. El *qué* se ve en el diff; explica el *porqué*.
- Nunca subas secretos (contraseñas, claves, \`.env\`): usa \`.gitignore\` y Key Vault (lo verás en la siguiente lección).

## Cuando git push falla

\`\`\`
! [rejected]  main -> main (fetch first)
\`\`\`

Alguien subió cambios antes que tú. Haz \`git pull\` (que fusiona sus cambios con los tuyos), resuelve los conflictos si los hay y vuelve a hacer \`git push\`.`,
    },
    {
      id: 'l10-gitignore',
      title: '.gitignore: lo que nunca debe llegar al repositorio',
      minutes: 7,
      body: `Un repositorio guarda **para siempre** todo lo que se sube. Por eso, antes del primer commit, un profesional crea el \`.gitignore\`: la lista de lo que Git debe ignorar.

## Qué se sube y qué no

| Se sube | No se sube nunca |
| --- | --- |
| Código, \`README.md\`, \`Dockerfile\`, \`azure-pipelines.yml\` | \`.env\` y cualquier secreto |
| \`package.json\` **y** \`package-lock.json\` | \`node_modules/\` (se reinstala con \`npm ci\`) |
| \`.env.example\` (nombres de variables, sin valores) | \`dist/\`, \`bin/\`, \`.venv/\` (se generan) |
| \`*.tf\` y \`.terraform.lock.hcl\` | \`terraform.tfstate\` y \`.terraform/\` |
| \`.gitignore\`, \`.dockerignore\` | Claves privadas (\`id_rsa\`, \`*.pem\`), \`*.log\` |

## Un .gitignore para Node.js

\`\`\`text
node_modules/
.env
.env.*
!.env.example
npm-debug.log*
\`\`\`

Las reglas: \`/\` al final = carpeta; \`*\` = cualquier texto; \`!\` = excepción (aquí, «ignora los .env.* menos .env.example»).

## Comprobar qué ignora Git

\`\`\`bash
cd ~/lab-devops
git status --ignored          # «Ignored files»: lo que no se subirá
git check-ignore -v .env      # qué regla de qué fichero lo ignora
git add .env                  # Git se niega: «The following paths are ignored...»
\`\`\`

## La trampa: lo que ya está versionado

El \`.gitignore\` **solo afecta a ficheros que todavía no están en el repositorio**. Si alguien subió el \`.env\` (por ejemplo con \`git add -f\`), seguirá en cada commit hasta que lo saques:

\`\`\`bash
git rm --cached .env                         # deja de versionarlo; tu copia local se queda
git commit -m "Saca el .env del repositorio"
git push
git log --oneline -- .env                    # ...pero sigue en el historial
\`\`\`

Por eso, si un secreto llega a un repositorio, **se cambia** (se rota): sacarlo del último commit no lo borra de la historia.`,
    },
    {
      id: 'l10-ramas',
      title: 'Ramas y pull requests',
      minutes: 8,
      body: `Una **rama** es una línea de trabajo independiente. La rama principal (\`main\`) debe estar **siempre desplegable**; el trabajo nuevo se hace en ramas de características.

\`\`\`bash
git checkout -b feature/nuevo-saludo   # crear rama y cambiarse a ella
# ...editar, add, commit...
git push -u origin feature/nuevo-saludo
git branch -a                          # ver ramas locales y remotas
git checkout main && git pull          # volver a main actualizado
\`\`\`

## Pull request (PR)

Un **pull request** propone fusionar una rama en otra. Es el corazón de la colaboración:

1. Subes tu rama y abres el PR (\`feature/x → main\`).
2. Tus compañeros **revisan** el código, comentan y **aprueban**.
3. Un **pipeline de validación** compila y ejecuta las pruebas sobre el resultado de la fusión.
4. Cuando se cumplen las directivas, **completas** el PR (normalmente con *squash merge*) y borras la rama.

\`\`\`bash
az repos pr create --source-branch feature/nuevo-saludo --target-branch main --title "Nuevo saludo"
az repos pr list -o table
az repos pr update --id <id> --status completed
\`\`\`

## Estrategias de ramas

- **Trunk-based** (recomendada para CI/CD): ramas cortas (horas o días) que se fusionan pronto en \`main\`.
- **GitFlow**: ramas \`develop\`, \`release/*\`, \`hotfix/*\`... más pesado; útil con versiones planificadas.`,
    },
    {
      id: 'l10-repos',
      title: 'Azure DevOps y directivas de rama',
      minutes: 7,
      body: `**Azure DevOps** es la plataforma de Microsoft para el ciclo completo:

| Servicio | Para qué |
| --- | --- |
| **Boards** | Planificar el trabajo (historias de usuario, tareas, bugs) |
| **Repos** | Repositorios Git con PRs y directivas |
| **Pipelines** | CI/CD con YAML |
| **Artifacts** | Paquetes (npm, NuGet, Maven...) |
| **Test Plans** | Pruebas manuales y exploratorias |

Se organiza en **organización** (\`https://dev.azure.com/<org>\`) → **proyectos** → repos, pipelines, tableros...

\`\`\`bash
az devops configure --defaults organization=https://dev.azure.com/<org> project=lab-devops
az devops project create --name lab-devops
az repos import create --git-source-url https://github.com/azure-lab/app-node --repository lab-devops
az repos show -r lab-devops --query remoteUrl -o tsv
\`\`\`

## Directivas de rama

Protegen \`main\` para que **nadie** (ni siquiera tú) haga push directo:

- **Número mínimo de revisores**: el PR necesita N aprobaciones.
- **Validación de compilación**: un pipeline debe terminar bien antes de fusionar.
- Otras: elementos de trabajo vinculados, resolución de comentarios, tipo de fusión...

Con las directivas activas, un \`git push\` a main se rechaza:

\`\`\`
! [remote rejected] main -> main (TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.)
\`\`\`

Es exactamente lo que quieres: todo cambio pasa por revisión y por el pipeline.`,
    },
  ],
  exercises: [
    {
      id: 'e10-repo',
      title: 'Tu primer repositorio en Azure Repos',
      summary: 'Proyecto de Azure DevOps, importación y clonado en Cloud Shell.',
      difficulty: 'Fácil',
      minutes: 10,
      scenario: 'El equipo empieza a usar Azure DevOps. Crea el proyecto, importa el código de la app y clónalo en tu Cloud Shell.',
      steps: [
        { id: 'project', title: 'Crea el proyecto lab-devops en Azure DevOps', check: (c) => (proj(c) ? true : 'No existe el proyecto lab-devops.') },
        { id: 'import', title: 'Importa https://github.com/azure-lab/app-node en el repositorio lab-devops', check: (c) => (headTree(repo(c))['server.js'] ? true : 'El repositorio no tiene todavía el código de app-node.') },
        { id: 'config', title: 'Configura tu nombre y correo en Git (git config --global)', check: (c) => (/name\s*=/.test(c.file('.gitconfig') ?? '') && /email\s*=/.test(c.file('.gitconfig') ?? '') ? true : 'Falta user.name o user.email en ~/.gitconfig.') },
        { id: 'clone', title: 'Clona el repositorio en tu Cloud Shell', check: (c) => (Object.keys(c.s.gitLocal).some((p) => /\/lab-devops$/i.test(p)) ? true : 'No encuentro un clon local del repositorio lab-devops.') },
      ],
      solution: `\`\`\`bash
az devops project create --name lab-devops
az devops configure --defaults project=lab-devops
az repos import create --git-source-url https://github.com/azure-lab/app-node --repository lab-devops
git config --global user.name "{{name}}"
git config --global user.email "{{upn}}"
cd ~ && git clone $(az repos show -r lab-devops --query remoteUrl -o tsv)
cd lab-devops && git log --oneline
\`\`\`
También puedes hacerlo desde el portal de DevOps: **Nuevo proyecto** → **Repos** → *Importar*.`,
    },
    {
      id: 'e10-commit',
      title: 'Commit y push',
      summary: 'Cambia el código, haz commit y súbelo a Azure Repos.',
      difficulty: 'Fácil',
      minutes: 8,
      scenario: 'Te piden que la portada diga quién la mantiene. Cambia el saludo de `server.js` y súbelo.',
      steps: [
        { id: 'edit', title: 'Cambia el mensaje de server.js en tu clon local', check: (c) => { const p = Object.keys(c.s.gitLocal).find((x) => /\/lab-devops$/i.test(x)); const f = p ? c.file(`${p}/server.js`) : null; return f && !f.includes('"Hola desde Azure Lab v1"') ? true : 'server.js sigue con el mensaje original.'; } },
        { id: 'commit', title: 'Haz un commit con un mensaje descriptivo', check: (c) => c.ran(/git commit/) || 'Ejecuta git add y git commit -m "..."' },
        { id: 'push', title: 'Súbelo con git push y compruébalo en Repos > Commits', check: (c) => { const r = repo(c); if (!r) return false; const head = r.commits[r.branches[r.defaultBranch]]; return head && !head.message.startsWith('Importado') && new Date(head.date).getTime() >= c.since - 1000 ? true : 'El último commit de main en Azure Repos todavía es el de la importación.'; } },
      ],
      solution: `\`\`\`bash
cd ~/lab-devops
sed -i 's/Hola desde Azure Lab v1/Hola desde Azure Lab · mantenido por {{name}}/' server.js
git status
git add server.js
git commit -m "Personaliza el saludo de la portada"
git push
\`\`\``,
    },
    {
      id: 'e10-gitignore',
      title: 'Rescate: un .env en el repositorio',
      summary: 'Saca un secreto del repositorio sin perder tu copia, documenta la configuración y comprueba el historial.',
      difficulty: 'Media',
      minutes: 12,
      scenario: 'Marta forzó la subida de su `.env` (con `git add -f`) y ahora la contraseña de la base de datos está en `main`, a la vista de todo el que clona el repositorio. Sácalo de ahí como lo haría un profesional. *(Al pulsar Empezar, se simula el commit de Marta en lab-devops.)*',
      setup: () => {
        const p = getState().devops.projects.find((x) => x.name.toLowerCase() === 'lab-devops');
        const r = p?.repos.find((x) => x.name.toLowerCase() === 'lab-devops') ?? p?.repos[0];
        if (!p || !r || !r.branches[r.defaultBranch] || headTree(r)['.env'] !== undefined) return;
        try {
          commitFile(p, r, r.defaultBranch, '.env', MARTA_ENV, 'WIP configuración local', 'Marta García');
        } catch {
          /* main protegida: el escenario no se puede preparar */
        }
      },
      steps: [
        { id: 'pull', title: 'Trae el commit de Marta (git pull) y comprueba que el .env está en tu clon', check: (c) => (c.ran(/git pull/) && localFile(c, '.env') !== null ? true : 'Ejecuta git pull en ~/lab-devops: debería aparecer el .env de Marta.') },
        { id: 'untrack', title: 'Saca el .env del repositorio SIN borrar tu copia local (git rm --cached), haz commit y push', check: (c) => { if (headTree(repo(c))['.env'] !== undefined) return 'El .env sigue en main en Azure Repos.'; return localFile(c, '.env') !== null ? true : 'Has borrado también tu copia local: usa git rm --cached para conservarla.'; } },
        { id: 'check', title: 'Comprueba con git check-ignore -v que ahora Git ignora el .env', check: (c) => c.ran(/git check-ignore/) || 'Ejecuta git check-ignore -v .env (mientras el fichero estaba versionado, no aparecía).' },
        { id: 'example', title: 'Sube un .env.example con los nombres de las variables, sin la contraseña', check: (c) => { const ex = headTree(repo(c))['.env.example']; if (ex === undefined) return 'No hay .env.example en main.'; if (ex.includes('Marta-1234!')) return '¡El .env.example contiene la contraseña real! Deja los valores vacíos.'; return /DB_PASSWORD/.test(ex) ? true : 'El .env.example debería documentar la variable DB_PASSWORD (sin valor).'; } },
        { id: 'history', title: 'Comprueba con git log -- .env que la contraseña sigue en el historial', check: (c) => c.ran(/git log\b.*--\s*\.env/) || 'Ejecuta git log --oneline -- .env' },
      ],
      solution: `\`\`\`bash
cd ~/lab-devops && git pull
cat .env                       # la contraseña de Marta, a la vista de todo el equipo
git rm --cached .env           # deja de versionarlo; tu copia local se queda
cat > .env.example <<'EOF'
# Copia este fichero como .env y rellena los valores (el .env no se sube a Git)
APP_ENV=local
DB_PASSWORD=
EOF
git add .env.example
git commit -m "Saca el .env del repositorio y añade .env.example"
git push
git check-ignore -v .env
git log --oneline -- .env
\`\`\``,
      wrapUp: 'El .env ya no está en main, pero sí en el historial: cualquiera puede verlo con git show. Un profesional da la contraseña por comprometida y la cambia de inmediato. Borrar el historial (git filter-repo y un push forzado) es posible, pero hay que coordinarlo con todo el equipo y no sustituye a rotar el secreto.',
    },
    {
      id: 'e10-pr',
      title: 'Rama de característica y pull request',
      summary: 'Trabaja en una rama, abre un PR y complétalo.',
      difficulty: 'Media',
      minutes: 12,
      scenario: 'Vas a añadir una ruta `/version` a la API, pero sin tocar `main` directamente: rama + pull request.',
      steps: [
        { id: 'branch', title: 'Crea la rama feature/version y súbela', check: (c) => (Object.keys(repo(c)?.branches ?? {}).some((b) => b.startsWith('feature/')) ? true : 'No hay ninguna rama feature/... en Azure Repos.') },
        { id: 'pr', title: 'Abre un pull request de feature/version a main', check: (c) => ((proj(c)?.pullRequests ?? []).some((p) => p.source.startsWith('feature/') && p.target === 'main') ? true : 'No hay ningún PR desde una rama feature/ hacia main.') },
        { id: 'complete', title: 'Completa (fusiona) el pull request', check: (c) => ((proj(c)?.pullRequests ?? []).some((p) => p.source.startsWith('feature/') && p.status === 'completed') ? true : 'El PR todavía no está completado.') },
        { id: 'pull', title: 'Vuelve a main en local y trae los cambios con git pull', check: (c) => c.ran(/git pull/) || 'Ejecuta git checkout main && git pull' },
      ],
      solution: `\`\`\`bash
cd ~/lab-devops
git checkout -b feature/version
cat >> server.js <<'EOF'

app.get('/version', (req, res) => res.json({ version: '1.1.0' }));
EOF
git add . && git commit -m "Añade la ruta /version"
git push -u origin feature/version
az repos pr create --source-branch feature/version --target-branch main --title "Ruta /version"
az repos pr update --id $(az repos pr list --query "[0].pullRequestId" -o tsv) --status completed
git checkout main && git pull
\`\`\``,
    },
    {
      id: 'e10-policy',
      title: 'Protege la rama main',
      summary: 'Directiva de revisores mínimos y comprobación del rechazo de un push directo.',
      difficulty: 'Media',
      minutes: 12,
      scenario: 'Un compañero subió un cambio roto directamente a main. Activa una directiva para que eso no vuelva a pasar.',
      steps: [
        { id: 'policy', title: 'Exige al menos 1 revisor en main (Repos > Directivas de rama)', check: (c) => ((repo(c)?.policies?.minReviewers ?? 0) >= 1 ? true : 'La rama main no exige revisores.') },
        { id: 'rejected', title: 'Intenta hacer git push directamente a main y comprueba que se rechaza', check: (c) => c.failed(/git push/) || 'Haz un commit en main y ejecuta git push: debe fallar con TF402455.' },
        { id: 'approved', title: 'Lleva el cambio por un PR, apruébalo y complétalo', check: (c) => ((proj(c)?.pullRequests ?? []).some((p) => p.status === 'completed' && p.approvals.length >= 1 && new Date(p.createdAt).getTime() >= c.since - 1000) ? true : 'No hay ningún PR reciente aprobado y completado.') },
      ],
      solution: `En el portal de DevOps: **Repos → Directivas de rama** → *Requerir un número mínimo de revisores* = 1. O con la CLI:

\`\`\`bash
az repos policy approver-count create --repository-id lab-devops --branch main --minimum-approver-count 1 --creator-vote-counts true --blocking true --enabled true --allow-downvotes false --reset-on-source-push false
cd ~/lab-devops
echo "# cambio directo" >> README.md && git commit -am "Cambio directo" && git push   # rechazado
git reset --hard HEAD~1
git checkout -b feature/readme && echo "# cambio revisado" >> README.md && git commit -am "Actualiza README"
git push -u origin feature/readme
az repos pr create --source-branch feature/readme --target-branch main --title "Actualiza README"
PR=$(az repos pr list --query "[0].pullRequestId" -o tsv)
az repos pr set-vote --id $PR --vote approve
az repos pr update --id $PR --status completed
\`\`\``,
      wrapUp: 'A partir de ahora, cualquier cambio en main (incluido el YAML del pipeline del siguiente nivel) deberá ir por una rama y un PR. Así trabajan los equipos profesionales.',
    },
  ],
  quiz: [
    { q: '¿Qué hace `git add`?', options: ['Sube los cambios al remoto', 'Prepara cambios para el siguiente commit', 'Crea una rama', 'Descarga cambios'], answer: 1, explain: 'git add mueve cambios al área de preparación (staging).' },
    { q: 'Añades `.env` al `.gitignore`, pero el `.env` ya se había subido antes. ¿Qué pasa?', options: ['Git lo borra del repositorio automáticamente', 'Sigue versionado hasta que hagas git rm --cached .env (y sigue en el historial)', 'Se cifra', 'Git lo ignora a partir de ahora en todos los commits anteriores'], answer: 1, explain: 'El .gitignore solo afecta a ficheros no versionados. Y aunque lo saques, el secreto sigue en el historial: hay que rotarlo.' },
    { q: '¿Cuál de estos ficheros SÍ debe subirse al repositorio?', options: ['node_modules/', '.env', 'package-lock.json', 'terraform.tfstate'], answer: 2, explain: 'package-lock.json fija las versiones exactas de las dependencias: sin él, npm ci falla y cada máquina podría instalar algo distinto.' },
    { q: 'git push falla con "fetch first". ¿Qué haces?', options: ['git push --force siempre', 'git pull, resolver conflictos y volver a hacer push', 'Borrar el repositorio', 'Crear otro remoto'], answer: 1, explain: 'Alguien subió cambios: intégralos con git pull y vuelve a subir. --force sobrescribiría su trabajo.' },
    { q: '¿Para qué sirve un pull request?', options: ['Para descargar código', 'Para proponer, revisar y validar cambios antes de fusionarlos', 'Para borrar ramas', 'Para crear proyectos'], answer: 1, explain: 'El PR es el punto de revisión y validación automática antes de integrar en main.' },
    { q: 'Con una directiva de revisores en main, un push directo a main...', options: ['Funciona si eres Owner', 'Se rechaza (TF402455)', 'Crea un PR automáticamente', 'Se fusiona en otra rama'], answer: 1, explain: 'Las directivas obligan a usar pull requests.' },
    { q: '¿Qué estrategia de ramas encaja mejor con CI/CD?', options: ['Una rama por desarrollador que nunca se fusiona', 'Trunk-based: ramas cortas que se fusionan pronto en main', 'Trabajar siempre en main sin ramas', 'Una rama por año'], answer: 1, explain: 'Las ramas cortas reducen conflictos y permiten integrar y desplegar con frecuencia.' },
  ],
};

export const LEVEL11: Level = {
  id: 11,
  slug: 'pipelines',
  title: 'Azure Pipelines: CI/CD',
  subtitle: 'Integración y entrega continuas con YAML: artefactos, conexiones de servicio, entornos y aprobaciones',
  icon: 'deployments',
  skills: ['YAML', 'CI', 'Artefactos', 'Conexiones de servicio', 'CD', 'Entornos', 'Aprobaciones', 'Secretos', 'Plantillas', 'Parámetros'],
  lessons: [
    {
      id: 'l11-ci',
      title: 'Integración continua con YAML',
      minutes: 9,
      body: `Un **pipeline** automatiza lo que harías a mano: compilar, probar, empaquetar y desplegar. En Azure Pipelines se define en un fichero **YAML** dentro del repositorio (*pipeline as code*): se versiona y se revisa como el resto del código.

## Anatomía

\`\`\`yaml
trigger:                 # cuándo se ejecuta: push a main
  branches:
    include: [ main ]

pool:
  vmImage: ubuntu-latest # agente hospedado por Microsoft (máquina nueva en cada ejecución)

variables:
  nodeVersion: '20.x'

stages:
- stage: Build
  jobs:
  - job: Build
    steps:
    - task: NodeTool@0
      inputs:
        versionSpec: $(nodeVersion)
    - script: |
        npm install
        npm test
      displayName: 'Instalar dependencias y probar'
\`\`\`

- **trigger**: CI. Cada push a \`main\` lanza una ejecución. (\`trigger: none\` = sólo manual.)
- **stages → jobs → steps**: las fases agrupan trabajos; cada trabajo se ejecuta en un agente; los pasos son \`script\` (bash) o **tareas** (\`task: Nombre@versión\`).
- **variables** y la sintaxis de macro \`$(nombre)\`. Hay variables predefinidas: \`$(Build.BuildId)\`, \`$(Build.SourceBranch)\`, \`$(Build.ArtifactStagingDirectory)\`...

## Crear el pipeline

Portal de DevOps → **Pipelines** → *Nueva canalización* → Azure Repos Git → repositorio → YAML. O con la CLI:

\`\`\`bash
az pipelines create --name ci-app --repository lab-devops --branch main --yml-path /azure-pipelines.yml
az pipelines runs list -o table
\`\`\`

Si un paso falla (código de salida distinto de 0), el trabajo falla y lo verás en rojo en los **registros**. Lee siempre el primer \`##[error]\`.`,
    },
    {
      id: 'l11-cd',
      title: 'Artefactos, conexiones de servicio y despliegue continuo',
      minutes: 10,
      body: `## Artefactos

Cada trabajo se ejecuta en una máquina nueva: lo que construyes en la fase **Build** desaparece al terminar... salvo que lo **publiques** como artefacto. La fase **Deploy** lo descarga y lo despliega.

\`\`\`yaml
- task: ArchiveFiles@2
  inputs:
    rootFolderOrFile: '$(System.DefaultWorkingDirectory)'
    includeRootFolder: false
    archiveFile: '$(Build.ArtifactStagingDirectory)/app.zip'
- publish: '$(Build.ArtifactStagingDirectory)/app.zip'
  artifact: drop
\`\`\`

> Cuidado con \`includeRootFolder: true\`: mete todo dentro de una carpeta y App Service no encuentra tu \`package.json\`.

## Conexiones de servicio

¿Con qué identidad despliega el pipeline en Azure? Con una **conexión de servicio** (*Project settings → Service connections*): una entidad de servicio de Entra ID con un rol (normalmente **Contributor**) en un **ámbito** concreto. Mínimo privilegio: limítala al grupo de recursos de la aplicación.

## Despliegue

\`\`\`yaml
- stage: Deploy
  dependsOn: Build
  jobs:
  - deployment: DeployWeb
    environment: dev            # entorno: historial y aprobaciones
    strategy:
      runOnce:
        deploy:
          steps:
          - task: AzureWebApp@1
            inputs:
              azureSubscription: 'sc-azure-lab'    # nombre de la conexión de servicio
              appType: webAppLinux
              appName: '$(webAppName)'
              package: '$(Pipeline.Workspace)/drop/app.zip'
\`\`\`

En un *deployment job* los artefactos se descargan automáticamente en \`$(Pipeline.Workspace)/<artefacto>\`.

Otras tareas habituales: \`AzureCLI@2\` (ejecutar az con la identidad de la conexión), \`AzureResourceManagerTemplateDeployment@3\` (ARM/Bicep), \`TerraformTaskV4@4\`, \`Docker@2\` (construir y subir a ACR), \`KubernetesManifest@1\` (desplegar en AKS).`,
    },
    {
      id: 'l11-seguridad',
      title: 'Entornos, aprobaciones y secretos',
      minutes: 7,
      body: `## Entornos y aprobaciones

Un **entorno** (dev, test, prod) en Azure DevOps registra qué se desplegó, cuándo y desde qué ejecución. Puedes añadirle **comprobaciones**: la más común, una **aprobación manual**. La fase que despliega en ese entorno se detiene ("Esperando aprobación") hasta que un aprobador la acepte.

\`\`\`yaml
- stage: DeployProd
  dependsOn: DeployDev
  condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
  jobs:
  - deployment: Prod
    environment: prod        # con aprobación configurada en Pipelines > Entornos
    strategy:
      runOnce:
        deploy:
          steps:
          - script: echo Desplegando en producción
\`\`\`

\`condition\` controla si una fase se ejecuta (\`succeeded()\`, \`failed()\`, \`always()\`, \`eq(...)\`...).

## Variables secretas

Nunca escribas contraseñas en el YAML. Opciones:

- **Variables secretas del pipeline** (*Editar → Variables → Mantener este valor en secreto*) o \`az pipelines variable create --secret true\`.
- **Grupos de variables** (Library), opcionalmente vinculados a **Key Vault**.
- La tarea \`AzureKeyVault@2\` descarga secretos de un almacén como variables secretas.

Los secretos se **enmascaran** (\`***\`) en los registros y **no** se exponen como variables de entorno automáticamente: hay que mapearlos explícitamente:

\`\`\`yaml
- script: ./desplegar.sh
  env:
    API_KEY: $(apiKey)
\`\`\`

## El agente no tiene tu .env

Cada ejecución empieza en una máquina limpia que solo contiene **lo que está en el commit**. Tu \`.env\` está en el \`.gitignore\`, así que en el agente no existe, y eso es bueno: obliga a que toda la configuración venga de variables del pipeline, grupos de variables o Key Vault. Si un build «funciona en mi máquina» pero falla en el pipeline, sospecha primero de un fichero que no está en Git.

Por la misma razón, usa \`npm ci\` en vez de \`npm install\` en el pipeline: instala exactamente lo que dice \`package-lock.json\` y falla si no está en el repositorio.`,
    },
    {
      id: 'l11-plantillas',
      title: 'Plantillas y parámetros: no repitas YAML',
      minutes: 8,
      body: `Cuando diez pipelines compilan igual, copiar y pegar pasos es una trampa: un cambio obliga a tocar diez ficheros. Las **plantillas** extraen esos bloques a ficheros reutilizables.

## Plantilla de pasos con parámetros

\`\`\`yaml
# templates/build.yml
parameters:
- name: nodeVersion
  type: string
  default: '20.x'
- name: runTests
  type: boolean
  default: true

steps:
- task: NodeTool@0
  inputs:
    versionSpec: \${{ parameters.nodeVersion }}
- script: npm install
- \${{ if parameters.runTests }}:
  - script: npm test
\`\`\`

\`\`\`yaml
# azure-pipelines.yml
steps:
- template: templates/build.yml
  parameters:
    nodeVersion: '22.x'
\`\`\`

Hay plantillas de **pasos** (\`steps:\`), **jobs** (\`jobs:\`), **fases** (\`stages:\`) y **variables** (\`variables:\`). Con \`extends:\` todo el pipeline hereda una plantilla: así un equipo de plataforma impone pasos obligatorios (por ejemplo, un escaneo de seguridad) en todos los pipelines. Las rutas son relativas al fichero que incluye la plantilla.

## Parámetros en tiempo de ejecución

Si el pipeline declara \`parameters:\` en la raíz, el panel **Ejecutar pipeline** muestra un formulario (desplegables, casillas...) y la CLI acepta \`--parameters\`:

\`\`\`yaml
parameters:
- name: entorno
  type: string
  default: dev
  values: [dev, prod]
\`\`\`

\`\`\`bash
az pipelines run --name plantillas --parameters entorno=prod
\`\`\`

## Tres sintaxis, tres momentos

| Sintaxis | Se evalúa | Uso típico |
|---|---|---|
| \`\${{ parameters.x }}\` | Al **compilar** el YAML, antes de ejecutar | Plantillas, \`if\` y \`each\` que cambian la estructura |
| \`$(variable)\` | Justo antes de ejecutar cada paso | Valores en scripts y tareas |
| \`$[ variables.x ]\` | En tiempo de ejecución, en condiciones | \`condition:\` y variables calculadas |

Los parámetros tienen **tipo** (string, number, boolean, object, stepList...) y se validan: si pasas uno que la plantilla no declara, el pipeline falla con *Unexpected parameter*. En el detalle de una ejecución, la pestaña **YAML completo** muestra el resultado de sustituir plantillas y expresiones.`,
    },
  ],
  exercises: [
    {
      id: 'e11-ci',
      title: 'Pipeline de integración continua',
      summary: 'Un pipeline YAML que instala dependencias y ejecuta las pruebas en cada push.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Cada vez que alguien sube código a `lab-devops` quieres saber en minutos si las pruebas pasan. Crea un pipeline de CI.',
      steps: [
        { id: 'yaml', title: 'Añade al repositorio un YAML que ejecute npm install y npm test (p. ej. ci.yml)', detail: 'Puedes usar el asistente *Nueva canalización → Node.js* del portal de DevOps, o crear el fichero en tu clon y subirlo (con PR si protegiste main).', check: (c) => (Object.entries(headTree(repo(c))).some(([k, v]) => /\.ya?ml$/.test(k) && /npm test/.test(v)) ? true : 'No hay en main ningún YAML que ejecute npm test.') },
        { id: 'pipeline', title: 'Crea el pipeline a partir de ese YAML', check: (c) => ((proj(c)?.pipelines ?? []).some((p) => /npm test/.test(headTree(repo(c))[p.yamlPath] ?? '')) ? true : 'No hay ningún pipeline que use un YAML con npm test.') },
        { id: 'run', title: 'Consigue una ejecución correcta', check: (c) => (recentRuns(c, proj(c)).some(ok) ? true : 'Todavía no hay ninguna ejecución correcta (revisa los registros si ha fallado).') },
        { id: 'trigger', title: 'Haz un cambio, súbelo a main y comprueba que el pipeline se lanza solo (CI)', check: (c) => (recentRuns(c, proj(c)).some((r) => r.reason === 'individualCI' && ok(r)) ? true : 'No hay ninguna ejecución correcta desencadenada por CI (reason: IndividualCI).') },
      ],
      solution: `En tu clon:

\`\`\`bash
cd ~/lab-devops && git checkout main && git pull
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
# PR + aprobación + completar (si main está protegida), después:
az pipelines create --name ci --repository lab-devops --branch main --yml-path /ci.yml
\`\`\`
Después cualquier cambio que llegue a main lanza el pipeline automáticamente.`,
    },
    {
      id: 'e11-cd',
      title: 'Despliegue continuo en App Service',
      summary: 'Conexión de servicio + pipeline Build/Deploy con artefacto hacia una web app.',
      difficulty: 'Difícil',
      minutes: 25,
      scenario: 'Ahora el pipeline debe además **desplegar** la app en Azure. El repositorio ya trae `azure-pipelines.yml` con las fases Build y Deploy; sólo tienes que preparar Azure y conectarlo.',
      steps: [
        { id: 'app', title: 'Crea rg-nivel11 con un plan Linux y una web app Node 20', check: (c) => (rgCheck(c, 'rg-nivel11') === true ? (c.site('rg-nivel11') ? true : 'No hay ninguna web app en rg-nivel11.') : rgCheck(c, 'rg-nivel11')) },
        { id: 'sc', title: 'Crea la conexión de servicio sc-azure-lab (Azure Resource Manager) limitada a rg-nivel11', check: (c) => { const sc = proj(c)?.serviceConnections.find((x) => x.name === 'sc-azure-lab'); if (!sc) return 'No existe la conexión sc-azure-lab en lab-devops.'; return scLimitedTo(c, sc, 'rg-nivel11') ? true : 'La conexión debe tener como ámbito el grupo de recursos rg-nivel11 (mínimo privilegio).'; } },
        { id: 'yaml', title: 'Pon el nombre de tu web app en webAppName de azure-pipelines.yml (en main)', check: (c) => { const y = headTree(repo(c))['azure-pipelines.yml'] ?? ''; const s = c.site('rg-nivel11'); return s && y.includes(`webAppName: '${s.name}'`) || (s && y.includes(`webAppName: ${s.name}`)) ? true : 'azure-pipelines.yml de main no tiene webAppName con el nombre de tu web app.'; } },
        { id: 'run', title: 'Ejecuta el pipeline hasta que las fases Build y Deploy terminen bien', check: (c) => (recentRuns(c, proj(c)).some((r) => ok(r) && r.stages.some((s) => s.name === 'Deploy' && s.status === 'succeeded')) ? true : 'No hay ninguna ejecución reciente con la fase Deploy correcta.') },
        { id: 'http', title: 'Comprueba que la web app sirve la aplicación desplegada por el pipeline', check: (c) => { const s = c.site('rg-nivel11'); return s && s.data?.content?.by === 'VSTS' && c.httpOk(siteUrl(s)) ? true : 'La web app no tiene todavía un despliegue de Azure Pipelines que responda.'; } },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel11 -l westeurope
az appservice plan create -g rg-nivel11 -n plan-cd --sku B1 --is-linux
APP=app-cd-$RANDOM
az webapp create -g rg-nivel11 -p plan-cd -n $APP --runtime "NODE:20-lts"
\`\`\`
1. Portal de DevOps → **Configuración del proyecto → Conexiones de servicio → Nueva**: Azure Resource Manager, *Registro de aplicación (automático)*, ámbito **Grupo de recursos** = rg-nivel11, nombre \`sc-azure-lab\`.
2. En tu clon, edita \`azure-pipelines.yml\`: \`webAppName: '<tu app>'\` y súbelo (rama + PR si main está protegida).
3. **Pipelines → Nueva canalización** → lab-devops → *Archivo YAML existente* → \`/azure-pipelines.yml\` → **Guardar y ejecutar**.

\`\`\`bash
az pipelines create --name cd-app --repository lab-devops --branch main --yml-path /azure-pipelines.yml
curl https://$APP.azurewebsites.net
\`\`\``,
      wrapUp: 'Si la fase Deploy falla con "Resource doesn\'t exist", revisa el nombre de la app y que la conexión tenga acceso a su grupo de recursos: el pipeline sólo ve lo que su identidad puede ver.',
    },
    {
      id: 'e11-approvals',
      title: 'Producción con aprobación manual',
      summary: 'Entorno prod con aprobación y una fase que espera tu visto bueno.',
      difficulty: 'Difícil',
      minutes: 15,
      scenario: 'Dirección exige que nada llegue a producción sin que una persona lo apruebe. Añade una fase DeployProd con aprobación.',
      steps: [
        { id: 'env', title: 'Crea el entorno prod y exige aprobación (Pipelines > Entornos)', check: (c) => (proj(c)?.environments.find((e) => e.name.toLowerCase() === 'prod')?.requireApproval ? true : 'El entorno prod no existe o no requiere aprobación.') },
        { id: 'yaml', title: 'Añade al YAML una fase con un deployment job en environment: prod', check: (c) => (Object.entries(headTree(repo(c))).some(([k, v]) => /\.ya?ml$/.test(k) && /environment:\s*['"]?prod/.test(v)) ? true : 'Ningún YAML de main tiene un deployment job con environment: prod.') },
        { id: 'wait', title: 'Ejecuta el pipeline y observa la fase "Esperando aprobación"', check: (c) => (recentRuns(c, proj(c)).some((r) => r.stages.some((s) => s.approval?.environment?.toLowerCase() === 'prod')) ? true : 'Ninguna ejecución reciente ha pedido aprobación para prod.') },
        { id: 'approve', title: 'Aprueba el despliegue y deja que la ejecución termine bien', check: (c) => (recentRuns(c, proj(c)).some((r) => ok(r) && r.stages.some((s) => s.approval?.status === 'approved')) ? true : 'No hay ninguna ejecución aprobada y terminada correctamente.') },
      ],
      solution: `Añade al final de \`azure-pipelines.yml\` (rama + PR):

\`\`\`yaml
  - stage: DeployProd
    displayName: 'Producción'
    dependsOn: Deploy
    jobs:
      - deployment: Prod
        environment: 'prod'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Desplegando la versión $(Build.BuildNumber) en producción"
\`\`\`
En **Pipelines → Entornos** crea \`prod\` y marca *Requerir aprobación*. Ejecuta el pipeline: la fase Producción se detiene; pulsa **Aprobar** en la ejecución (o \`az pipelines runs approve --id <id> --stage DeployProd\`).`,
    },
    {
      id: 'e11-secret',
      title: 'Secretos en el pipeline',
      summary: 'Una variable secreta enmascarada en los registros y mapeada con env.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'Un paso del pipeline necesita una clave de API. Guárdala como secreto y úsala sin que aparezca en los registros.',
      steps: [
        { id: 'var', title: 'Crea una variable secreta apiKey en un pipeline', check: (c) => ((proj(c)?.pipelines ?? []).some((p) => Object.entries(p.variables).some(([k, v]) => k.toLowerCase() === 'apikey' && v.isSecret)) ? true : 'Ningún pipeline tiene una variable secreta apiKey.') },
        { id: 'env', title: 'Úsala en un paso script mapeándola con env: (p. ej. API_KEY: $(apiKey))', check: (c) => (Object.entries(headTree(repo(c))).some(([k, v]) => /\.ya?ml$/.test(k) && /env:\s*\n\s+\w+:\s*\$\(apiKey\)/i.test(v)) ? true : 'Ningún YAML de main mapea $(apiKey) con env:.') },
        {
          id: 'masked',
          title: 'Ejecuta el pipeline y comprueba que el valor aparece como *** en los registros',
          check: (c) => {
            const p = proj(c);
            const pls = (p?.pipelines ?? []).filter((x) => Object.entries(x.variables).some(([k, v]) => k.toLowerCase() === 'apikey' && v.isSecret));
            const secrets = pls.map((x) => Object.entries(x.variables).find(([k]) => k.toLowerCase() === 'apikey')![1].value).filter(Boolean);
            const good = recentRuns(c, p).some((r) => {
              if (!ok(r) || !pls.some((x) => x.id === r.pipelineId)) return false;
              const lines = r.stages.flatMap((s) => s.jobs.flatMap((j) => j.steps.filter((st) => !/^(Checkout|Initialize|Finalize)/.test(st.name)).flatMap((st) => st.log)));
              return lines.some((l) => l.includes('***') && !l.startsWith('##[command]')) && !allLogs(r).some((l) => secrets.some((sec) => l.includes(sec)));
            });
            return good ? true : 'No hay ninguna ejecución correcta reciente del pipeline con apiKey en la que un paso muestre el secreto enmascarado (***).';
          },
        },
      ],
      solution: `\`\`\`bash
az pipelines variable create --pipeline-name ci --name apiKey --value "sk-12345-secreto" --secret true
\`\`\`
Y en el YAML (rama + PR):

\`\`\`yaml
- script: |
    echo "Usando la clave: $API_KEY"
    test -n "$API_KEY" && echo "La clave llegó al script"
  displayName: 'Usar el secreto'
  env:
    API_KEY: $(apiKey)
\`\`\``,
      wrapUp: 'Fíjate en que el valor aparece como *** aunque lo imprimas: Azure Pipelines enmascara los secretos en los registros.',
    },
    {
      id: 'e11-plantillas',
      title: 'Plantillas y parámetros en tiempo de ejecución',
      summary: 'Extrae los pasos de compilación a una plantilla reutilizable y elige el entorno al ejecutar.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Cada equipo copia y pega los mismos pasos de compilación en sus pipelines. Extráelos a una **plantilla con parámetros** en `lab-devops` y crea un pipeline que la use y que pregunte, al ejecutarlo, en qué entorno desplegar.',
      steps: [
        { id: 'tpl', title: 'Añade a main una plantilla de pasos en templates/ con al menos un parámetro', detail: 'Por ejemplo `templates/build.yml` con `parameters:` y `steps:`. Si main está protegida, súbela con una rama y una PR.', check: (c) => (Object.entries(headTree(repo(c))).some(([k, v]) => /^templates\/.+\.ya?ml$/.test(k) && /^parameters:/m.test(v) && /^steps:/m.test(v)) ? true : 'No hay en main ninguna plantilla templates/*.yml con parameters: y steps:.') },
        { id: 'use', title: 'Crea un pipeline cuyo YAML use la plantilla con - template:', check: (c) => ((proj(c)?.pipelines ?? []).some((p) => /-\s*template:\s*\/?templates\//.test(headTree(repo(c))[p.yamlPath] ?? '')) ? true : 'Ningún pipeline usa una plantilla de templates/ con - template:.') },
        { id: 'param', title: 'Declara en ese pipeline un parámetro en tiempo de ejecución entorno con los valores dev y prod', check: (c) => ((proj(c)?.pipelines ?? []).some((p) => pipelineParameters(headTree(repo(c))[p.yamlPath] ?? '').some((x) => x.name === 'entorno' && ['dev', 'prod'].every((v) => (x.values ?? []).map(String).includes(v)))) ? true : 'Ningún pipeline declara el parámetro entorno con values: [dev, prod].') },
        { id: 'run', title: 'Ejecuta el pipeline eligiendo entorno = prod y revisa la pestaña «YAML completo»', check: (c) => (recentRuns(c, proj(c)).some((r) => ok(r) && r.parameters?.entorno === 'prod' && Object.keys(r.templates ?? {}).some((t) => t.startsWith('templates/'))) ? true : 'No hay ninguna ejecución correcta con entorno=prod que use una plantilla de templates/.') },
      ],
      solution: `\`\`\`bash
cd ~/lab-devops && git checkout main && git pull
git checkout -b feature/plantillas
mkdir -p templates
cat > templates/build.yml <<'EOF'
parameters:
- name: nodeVersion
  type: string
  default: '20.x'
- name: runTests
  type: boolean
  default: true

steps:
- task: NodeTool@0
  inputs:
    versionSpec: \${{ parameters.nodeVersion }}
- script: npm install
  displayName: 'npm install'
- \${{ if parameters.runTests }}:
  - script: npm test
    displayName: 'npm test'
EOF
cat > plantillas.yml <<'EOF'
trigger: none

parameters:
- name: entorno
  displayName: Entorno de destino
  type: string
  default: dev
  values:
  - dev
  - prod

pool:
  vmImage: ubuntu-latest

steps:
- template: templates/build.yml
  parameters:
    nodeVersion: '20.x'
- script: echo "Desplegando en \${{ parameters.entorno }}"
  displayName: 'Desplegar en \${{ parameters.entorno }}'
EOF
git add . && git commit -m "Plantilla de compilación" && git push -u origin feature/plantillas
PR=$(az repos pr create --source-branch feature/plantillas --target-branch main --title "Plantilla de compilación" --query pullRequestId -o tsv)
az repos pr set-vote --id $PR --vote approve
az repos pr update --id $PR --status completed
az pipelines create --name plantillas --repository lab-devops --branch main --yml-path /plantillas.yml --skip-first-run
az pipelines run --name plantillas --branch main --parameters entorno=prod
\`\`\`

Si la directiva de rama exige una compilación de validación, espera a que termine antes de completar la PR. Desde el portal: **Pipelines → plantillas → Ejecutar** muestra el desplegable *Entorno de destino*; y **Editar** abre el editor, donde **Validar** comprueba el YAML y las plantillas sin ejecutar nada.`,
      wrapUp: 'Ahora cualquier pipeline puede reutilizar templates/build.yml con una línea. Prueba a pasarle un parámetro que no existe (colour: red): la validación falla con «Unexpected parameter», igual que en Azure DevOps.',
    },
  ],
  quiz: [
    { q: '¿Por qué hay que publicar un artefacto entre las fases Build y Deploy?', options: ['Para cifrarlo', 'Porque cada trabajo se ejecuta en un agente nuevo y los ficheros no persisten', 'Para que sea más pequeño', 'No hace falta'], answer: 1, explain: 'Los agentes hospedados son efímeros: el artefacto transporta el resultado de la compilación.' },
    { q: '¿Qué es una conexión de servicio de Azure Resource Manager?', options: ['Un usuario de Azure DevOps', 'La identidad (entidad de servicio con un rol y ámbito) con la que el pipeline actúa en Azure', 'Una VPN', 'Un tipo de agente'], answer: 1, explain: 'El pipeline usa esa identidad: sus roles RBAC determinan lo que puede desplegar.' },
    { q: '¿Cómo se consigue que nada llegue a producción sin revisión humana?', options: ['Con trigger: none', 'Con una aprobación en el entorno prod', 'Con una variable secreta', 'Con pool: self-hosted'], answer: 1, explain: 'Las comprobaciones de aprobación del entorno detienen la fase hasta que alguien la apruebe.' },
    { q: 'Una variable secreta del pipeline...', options: ['Se expone siempre como variable de entorno', 'Se enmascara en los registros y hay que mapearla con env: para usarla en scripts', 'Se puede leer en el YAML', 'No se puede usar en tareas'], answer: 1, explain: 'Los secretos no se exponen automáticamente al entorno de los scripts y se ocultan con ***.' },
    { q: '¿Qué significa `trigger: none`?', options: ['Se ejecuta en cada push', 'Sólo se ejecuta manualmente (o por otro mecanismo), no por CI', 'Nunca se puede ejecutar', 'Se ejecuta cada noche'], answer: 1, explain: 'Desactiva el desencadenador de CI.' },
    { q: '¿Cuándo se evalúa `${{ parameters.entorno }}`?', options: ['Al ejecutar cada paso', 'Al compilar el YAML, antes de que empiece la ejecución', 'Sólo en las condiciones', 'Nunca: es un comentario'], answer: 1, explain: 'Las expresiones ${{ }} son de tiempo de compilación: por eso pueden añadir o quitar pasos con if/each. $(variable) se resuelve al ejecutar.' },
  ],
};

export const _l10 = { T };
