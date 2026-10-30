// Niveles 12 y 13: observabilidad, costes y gobierno; proyecto final DevOps.
import type { Level } from '../types';
import type { CheckCtx } from '../checks';
import type { DevOpsProject, PipelineRun } from '../../../engine/types';
import { T, rgCheck, siteUrl, kvRefResolved, scLimitedTo } from './helpers';
import { kubeletPrincipal } from '../../../engine/services/kube';

const inRg = (c: CheckCtx, rg: string) => (id: string) => id.toLowerCase().includes(`/resourcegroups/${rg.toLowerCase()}/`) || id.toLowerCase().endsWith(`/resourcegroups/${rg.toLowerCase()}`);
const fp = (c: CheckCtx): DevOpsProject | undefined => c.project('final');
const okRun = (r: PipelineRun) => r.status === 'succeeded' || r.status === 'succeededWithIssues';
const runs = (c: CheckCtx, p?: DevOpsProject) => (p?.runs ?? []).filter((r) => new Date(r.queuedAt).getTime() >= c.since - 1000);

export const LEVEL12: Level = {
  id: 12,
  slug: 'operaciones',
  title: 'Observabilidad, costes y gobierno',
  subtitle: 'Azure Monitor, alertas, KQL, Cost Management, etiquetas, bloqueos y Azure Policy',
  icon: 'monitor',
  skills: ['Métricas', 'Alertas', 'Grupos de acciones', 'Log Analytics', 'KQL', 'Resource Graph', 'Presupuestos', 'Bloqueos', 'Azure Policy'],
  lessons: [
    {
      id: 'l12-monitor',
      title: 'Azure Monitor: métricas, registros y alertas',
      minutes: 8,
      body: `"No puedes mejorar lo que no mides". **Azure Monitor** recoge la telemetría de todos los recursos:

- **Métricas**: números a intervalos regulares (CPU, peticiones, latencia, errores 5xx). Gratuitas, casi en tiempo real, se conservan 93 días. Ideales para alertas y gráficos.
- **Registros (logs)**: eventos detallados (cada petición HTTP, cada acceso a un secreto, cada operación de administración). Se envían a un **área de trabajo de Log Analytics** mediante una **configuración de diagnóstico** y se consultan con **KQL**.
- **Registro de actividad**: operaciones de administración (quién creó, cambió o borró qué). Siempre activo.

## Alertas

Una **regla de alertas** vigila una señal y, cuando se cumple la condición, avisa a un **grupo de acciones** (correo, SMS, webhook, Azure Function, Logic App...).

\`\`\`bash
az monitor action-group create -g rg-nivel12 -n ag-ops --short-name ops --action email admin {{upn}}
VM_ID=$(az vm show -g rg-nivel12 -n vm-carga --query id -o tsv)
az monitor metrics alert create -g rg-nivel12 -n cpu-alta --scopes $VM_ID \\
  --condition "avg Percentage CPU > 80" --window-size 5m --evaluation-frequency 1m --action ag-ops
\`\`\`

## Probar la alerta

Genera carga en la VM (dentro de la VM o con run-command):

\`\`\`bash
az vm run-command invoke -g rg-nivel12 -n vm-carga --command-id RunShellScript \\
  --scripts "apt-get install -y stress && stress --cpu 2 --timeout 300"
\`\`\`

En el simulador el tiempo de las alertas va acelerado: en un par de minutos la CPU subirá, la alerta se activará y te llegará un correo a la bandeja simulada.`,
    },
    {
      id: 'l12-kql',
      title: 'KQL: consulta tus registros',
      minutes: 7,
      body: `**Kusto Query Language (KQL)** es el lenguaje de consulta de Log Analytics (y de Microsoft Sentinel, Application Insights, Azure Data Explorer...). Una consulta es una **tabla** seguida de operadores separados por \`|\`:

\`\`\`kusto
AzureActivity
| where TimeGenerated > ago(1h)
| where ActivityStatusValue == "Failed"
| project TimeGenerated, OperationNameValue, Caller
| order by TimeGenerated desc
| take 20
\`\`\`

## Operadores esenciales

| Operador | Hace |
| --- | --- |
| \`where\` | Filtra filas |
| \`project\` | Elige columnas |
| \`extend\` | Crea columnas calculadas |
| \`summarize ... by\` | Agrega (count(), avg(), max(), dcount()...) |
| \`order by\` / \`top\` / \`take\` | Ordena y limita |
| \`bin(TimeGenerated, 5m)\` | Agrupa por intervalos de tiempo |
| \`render timechart\` | Gráfico |

\`\`\`kusto
AppServiceHTTPLogs
| summarize Peticiones = count(), Errores = countif(ScStatus >= 500) by bin(TimeGenerated, 5m)
\`\`\`

Desde la CLI:

\`\`\`bash
WS=$(az monitor log-analytics workspace show -g rg-nivel12 -n law-ops --query customerId -o tsv)
az monitor log-analytics query -w $WS --analytics-query "AzureActivity | summarize count() by Caller" -o table
\`\`\`

Para que lleguen registros de un recurso (web app, Key Vault, NSG...), crea su **configuración de diagnóstico** hacia el área de trabajo.`,
    },
    {
      id: 'l12-gobierno',
      title: 'Costes y gobierno: presupuestos, etiquetas, bloqueos y Azure Policy',
      minutes: 8,
      body: `## Cost Management

- **Análisis de costes**: por grupo de recursos, servicio, etiqueta...
- **Presupuestos**: un importe mensual con avisos al 50/80/100 %. Avisan, **no detienen** nada (para eso, automatiza con un grupo de acciones).
- **Advisor**: recomendaciones de ahorro (VMs infrautilizadas, recursos huérfanos...), seguridad y fiabilidad.

\`\`\`bash
az consumption budget create -n presupuesto-lab --amount 50 --category cost --time-grain monthly \\
  --start-date 2026-01-01 --end-date 2027-12-31 --thresholds 80 100 --contact-emails {{upn}}
\`\`\`

## Etiquetas para repartir costes

Con etiquetas como \`centroCoste\`, \`proyecto\` o \`propietario\` puedes saber quién gasta qué. Una directiva puede **exigirlas** o **heredarlas** del grupo de recursos.

## Bloqueos

- **CanNotDelete** (Eliminar): se puede usar y modificar, pero no borrar.
- **ReadOnly** (Solo lectura): ni modificar ni borrar.

Se aplican a todo el mundo, incluidos los Owner, y se heredan. Imprescindibles en recursos críticos de producción.

\`\`\`bash
az lock create -n no-borrar -g rg-nivel12 --lock-type CanNotDelete
\`\`\`

## Azure Policy

Reglas que se evalúan en **cada** petición a ARM. Efectos:

- **Deny**: bloquea la creación o el cambio (error \`RequestDisallowedByPolicy\`).
- **Audit**: permite pero marca el recurso como no compatible.
- **Modify / DeployIfNotExists**: corrige automáticamente.

Ejemplos típicos: *Ubicaciones permitidas*, *Requerir una etiqueta*, *Tamaños de VM permitidos*. Se asignan a un ámbito (grupo de administración, suscripción o grupo de recursos).

\`\`\`bash
RG_ID=$(az group show -n rg-nivel12 --query id -o tsv)
az policy assignment create -n solo-europa --policy e56962a6-4747-49cd-b67b-bf8b01975c4c \\
  --scope $RG_ID --params '{"listOfAllowedLocations":{"value":["westeurope","northeurope"]}}'
\`\`\``,
    },
    {
      id: 'l12-graph',
      title: 'Resource Graph: el inventario de toda tu nube con KQL',
      minutes: 5,
      body: `Con decenas de suscripciones y miles de recursos, abrirlos uno a uno no escala. **Azure Resource Graph** indexa las propiedades de **todos** los recursos a los que tienes acceso y permite consultarlas con KQL en milisegundos.

| Tabla | Contenido |
|---|---|
| \`Resources\` | Todos los recursos: \`name\`, \`type\`, \`location\`, \`resourceGroup\`, \`tags\`, \`sku\`, \`properties\`... |
| \`ResourceContainers\` | Suscripciones y grupos de recursos |

\`\`\`bash
az graph query -q "Resources | summarize total = count() by type | order by total desc" -o table
\`\`\`

- \`type\` y \`resourceGroup\` vienen en **minúsculas**: compara con \`=~\` (sin distinguir mayúsculas).
- Entra en el JSON con puntos o corchetes: \`properties.hardwareProfile.vmSize\`, \`tags['entorno']\`.

\`\`\`bash
az graph query -q "Resources | where type =~ 'microsoft.compute/virtualmachines' | project name, resourceGroup, tamano = properties.hardwareProfile.vmSize" -o table
az graph query -q "Resources | where isempty(tags['entorno']) | project name, type, resourceGroup" -o table
\`\`\`

En el portal tienes el mismo motor en **Explorador de Resource Graph**, con consultas de ejemplo y gráficos. Diferencia con Log Analytics: Resource Graph responde «**qué hay** y cómo está configurado ahora»; Log Analytics, «**qué ha pasado**» (registros y métricas a lo largo del tiempo).`,
    },
  ],
  exercises: [
    {
      id: 'e12-alert',
      title: 'Alerta de CPU alta con aviso por correo',
      summary: 'Grupo de acciones, regla de alertas de métrica y una prueba de carga real.',
      difficulty: 'Difícil',
      minutes: 20,
      scenario: 'Producción sufrió una caída por CPU al 100 % y nadie se enteró. Configura una alerta y demuestra que funciona.',
      steps: [
        { id: 'vm', title: 'Crea rg-nivel12 y una VM Linux vm-carga en ejecución', check: (c) => { const r = rgCheck(c, 'rg-nivel12'); if (r !== true) return r; const vm = c.vm('rg-nivel12'); return vm && c.powerState(vm) === 'running' ? true : 'No hay ninguna VM en ejecución en rg-nivel12.'; } },
        { id: 'ag', title: 'Crea un grupo de acciones que envíe un correo a tu usuario', check: (c) => (c.one(T.ag, (r) => c.inRg('rg-nivel12')(r) && (r.properties.emailReceivers ?? []).length > 0) ? true : 'No hay un grupo de acciones con correo en rg-nivel12.') },
        { id: 'rule', title: 'Crea una regla de alertas: avg Percentage CPU > 80 sobre la VM, con el grupo de acciones', check: (c) => { const rule = c.one(T.alert, (r) => c.inRg('rg-nivel12')(r) && r.properties.criteria?.allOf?.[0]?.metricName === 'Percentage CPU'); if (!rule) return 'No hay una regla de alertas de Percentage CPU en rg-nivel12.'; return (rule.properties.actions ?? []).length ? true : 'La regla no tiene ningún grupo de acciones.'; } },
        { id: 'stress', title: 'Genera carga de CPU en la VM (stress)', check: (c) => (c.vm('rg-nivel12')?.data?.stressUntil ? true : 'Todavía no has generado carga con stress en la VM.') },
        { id: 'fired', title: 'Espera a que se active la alerta (Monitor > Alertas)', check: (c) => (c.s.alerts.some((a) => inRg(c, 'rg-nivel12')(a.ruleId) && new Date(a.firedAt).getTime() >= c.since) ? true : 'La alerta todavía no se ha activado (puede tardar un par de minutos).') },
        { id: 'mail', title: 'Comprueba que te ha llegado el correo de la alerta', check: (c) => (c.s.emails.some((m) => /Fired/.test(m.subject) && new Date(m.time).getTime() >= c.since) ? true : 'No ha llegado ningún correo de alerta todavía.') },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel12 -l westeurope
az vm create -g rg-nivel12 -n vm-carga --image Ubuntu2404 --size Standard_B1s --admin-username azureuser --generate-ssh-keys
az monitor action-group create -g rg-nivel12 -n ag-ops --short-name ops --action email admin $(az account show --query user.name -o tsv)
VM_ID=$(az vm show -g rg-nivel12 -n vm-carga --query id -o tsv)
az monitor metrics alert create -g rg-nivel12 -n cpu-alta --scopes $VM_ID --condition "avg Percentage CPU > 80" --window-size 5m --evaluation-frequency 1m --action ag-ops
az vm run-command invoke -g rg-nivel12 -n vm-carga --command-id RunShellScript --scripts "apt-get install -y stress && stress --cpu 2 --timeout 600"
\`\`\`
Espera un par de minutos y revisa **Monitor → Alertas** y el **correo** (sobre de la barra superior).`,
    },
    {
      id: 'e12-kql',
      title: 'Registros centralizados y KQL',
      summary: 'Área de trabajo de Log Analytics, configuración de diagnóstico y consultas KQL.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Seguridad quiere saber quién accede a los secretos y qué operaciones fallan. Centraliza los registros y aprende a consultarlos.',
      steps: [
        { id: 'law', title: 'Crea el área de trabajo de Log Analytics law-ops en rg-nivel12', check: (c) => (c.one(T.law, (r) => c.inRg('rg-nivel12')(r)) ? true : 'No hay ningún área de trabajo de Log Analytics en rg-nivel12.') },
        { id: 'diag', title: 'Crea una configuración de diagnóstico de algún recurso (web app, Key Vault...) hacia law-ops', check: (c) => { const ws = c.one(T.law, c.inRg('rg-nivel12')); return ws && c.s.diagnosticSettings.some((d) => d.workspaceId?.toLowerCase() === ws.id.toLowerCase()) ? true : 'Ningún recurso envía todavía registros a tu área de trabajo.'; } },
        { id: 'query', title: 'Consulta AzureActivity desde la CLI con az monitor log-analytics query', check: (c) => c.ran(/log-analytics query.*AzureActivity/) || 'Ejecuta una consulta sobre AzureActivity con az monitor log-analytics query.' },
        { id: 'summarize', title: 'Haz una consulta que agregue con summarize ... by', check: (c) => c.ran(/log-analytics query.*summarize/) || 'Incluye summarize count() by <columna> en tu consulta.' },
      ],
      solution: `\`\`\`bash
az monitor log-analytics workspace create -g rg-nivel12 -n law-ops
WS_ID=$(az monitor log-analytics workspace show -g rg-nivel12 -n law-ops --query id -o tsv)
WS=$(az monitor log-analytics workspace show -g rg-nivel12 -n law-ops --query customerId -o tsv)
KV=$(az keyvault list --query "[0].id" -o tsv)
az monitor diagnostic-settings create -n diag-kv --resource $KV --workspace $WS_ID --logs '[{"category":"AuditEvent","enabled":true}]'
az monitor log-analytics query -w $WS --analytics-query "AzureActivity | take 10" -o table
az monitor log-analytics query -w $WS --analytics-query "AzureActivity | summarize Operaciones=count() by Caller" -o table
\`\`\`
También puedes usar el editor de consultas en **Monitor → Registros**.`,
    },
    {
      id: 'e12-gov',
      title: 'Gobierno: costes, bloqueos y directivas',
      summary: 'Presupuesto, etiqueta de centro de coste, bloqueo y directiva de ubicaciones.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Finanzas y seguridad te piden unas reglas mínimas para rg-nivel12: saber cuánto cuesta, que nadie lo borre por error y que sólo se use Europa.',
      steps: [
        { id: 'tag', title: 'Etiqueta rg-nivel12 con centroCoste = it-operaciones', check: (c) => (c.rg('rg-nivel12')?.tags?.centroCoste === 'it-operaciones' ? true : 'Falta la etiqueta centroCoste=it-operaciones en rg-nivel12.') },
        { id: 'budget', title: 'Crea un presupuesto mensual con avisos por correo', check: (c) => (c.s.budgets.length && c.s.budgets.some((b) => b.contactEmails.length) ? true : 'No hay ningún presupuesto con correo de contacto.') },
        { id: 'policy', title: 'Asigna la directiva "Allowed locations" a rg-nivel12 (sólo westeurope y northeurope)', check: (c) => (c.s.policyAssignments.some((a) => a.policyDefinitionId.includes('e56962a6-4747-49cd-b67b-bf8b01975c4c') && a.scope.toLowerCase().endsWith('/resourcegroups/rg-nivel12')) ? true : 'No hay una asignación de Allowed locations en el ámbito de rg-nivel12.') },
        { id: 'denied', title: 'Intenta crear un recurso en eastus dentro de rg-nivel12 y comprueba que la directiva lo deniega', check: (c) => (c.s.activityLog.some((e) => e.category === 'Policy' && e.status === 'Failed' && inRg(c, 'rg-nivel12')(e.resourceId) && new Date(e.time).getTime() >= c.since) ? true : 'Todavía no hay ninguna operación denegada por Azure Policy en rg-nivel12.') },
        { id: 'lock', title: 'Pon un bloqueo CanNotDelete en rg-nivel12 y comprueba que no se puede eliminar', check: (c) => { const l = c.s.locks.some((x) => x.level === 'CanNotDelete' && x.scope.toLowerCase().endsWith('/resourcegroups/rg-nivel12')); if (!l) return 'rg-nivel12 no tiene un bloqueo CanNotDelete.'; return c.failed(/az group delete.*rg-nivel12/) ? true : 'Intenta borrar el grupo (az group delete -n rg-nivel12 --yes) para ver el error ScopeLocked.'; } },
      ],
      solution: `\`\`\`bash
az group update -n rg-nivel12 --tags centroCoste=it-operaciones
az consumption budget create -n presupuesto-lab --amount 50 --category cost --time-grain monthly --start-date 2026-01-01 --end-date 2027-12-31 --thresholds 80 100 --contact-emails $(az account show --query user.name -o tsv)
RG_ID=$(az group show -n rg-nivel12 --query id -o tsv)
az policy assignment create -n solo-europa --policy e56962a6-4747-49cd-b67b-bf8b01975c4c --scope $RG_ID --params '{"listOfAllowedLocations":{"value":["westeurope","northeurope"]}}'
az storage account create -n stfuera$RANDOM -g rg-nivel12 -l eastus --sku Standard_LRS   # RequestDisallowedByPolicy
az lock create -n no-borrar -g rg-nivel12 --lock-type CanNotDelete
az group delete -n rg-nivel12 --yes                                                        # ScopeLocked
\`\`\``,
      wrapUp: 'Para limpiar el nivel tendrás que quitar primero el bloqueo (`az lock delete -n no-borrar -g rg-nivel12`). Así de efectivos son.',
    },
    {
      id: 'e12-graph',
      title: 'Inventario con Resource Graph',
      summary: 'Responde preguntas sobre todos tus recursos con consultas KQL, desde la CLI y el portal.',
      difficulty: 'Fácil',
      minutes: 8,
      scenario: 'Dirección pide un inventario: cuántos recursos hay de cada tipo, qué máquinas virtuales existen y de qué tamaño, y qué recursos incumplen la norma de etiquetar el centro de coste. Respóndelo sin abrir los recursos uno a uno.',
      steps: [
        { id: 'bytype', title: 'Cuenta tus recursos por tipo con az graph query', check: (c) => c.ran(/graph query.*summarize.*by\s+type/i) || 'Usa az graph query con «summarize count() by type».' },
        { id: 'vmsize', title: 'Lista las VM con su tamaño (properties.hardwareProfile.vmSize)', check: (c) => c.ran(/graph query.*virtualmachines.*hardwareProfile\.vmSize/i, { source: ['shell', 'typed', 'portal'] }) || "Filtra por type =~ 'microsoft.compute/virtualmachines' y proyecta properties.hardwareProfile.vmSize." },
        { id: 'tags', title: 'Encuentra los recursos que no tienen la etiqueta centroCoste', check: (c) => c.ran(/graph query.*tags.*centroCoste/i, { source: ['shell', 'typed', 'portal'] }) || "Filtra con isempty(tags['centroCoste'])." },
        { id: 'portal', title: 'Ejecuta una consulta en el Explorador de Resource Graph del portal', check: (c) => c.ran(/graph query/, { source: 'portal' }) || 'Abre Todos los servicios → Explorador de Resource Graph y ejecuta una consulta.' },
      ],
      solution: `\`\`\`bash
az graph query -q "Resources | summarize total = count() by type | order by total desc" -o table
az graph query -q "Resources | where type =~ 'microsoft.compute/virtualmachines' | project name, resourceGroup, tamano = properties.hardwareProfile.vmSize" -o table
az graph query -q "Resources | where isempty(tags['centroCoste']) | project name, type, resourceGroup" -o table
\`\`\`

Después abre **Explorador de Resource Graph** en el portal (búscalo en la barra superior), elige una consulta de ejemplo y pulsa **Ejecutar consulta**. Si el resultado tiene una columna numérica, verás también un gráfico de barras.`,
      wrapUp: 'Resource Graph sólo muestra lo que puedes leer: con un usuario con rol Reader en un único grupo, la misma consulta devuelve menos filas. Es la base de los inventarios y de muchas comprobaciones de cumplimiento.',
    },
  ],
  quiz: [
    { q: '¿Qué necesitas para consultar con KQL los registros de una web app?', options: ['Nada, ya están', 'Una configuración de diagnóstico que los envíe a Log Analytics', 'Un presupuesto', 'Un bloqueo ReadOnly'], answer: 1, explain: 'Los registros de recursos se envían a un área de trabajo mediante la configuración de diagnóstico.' },
    { q: '¿Qué hace un presupuesto cuando se supera?', options: ['Detiene los recursos', 'Envía avisos (y puede disparar un grupo de acciones)', 'Borra el grupo de recursos', 'Bloquea la suscripción'], answer: 1, explain: 'Los presupuestos avisan; detener recursos requiere automatización adicional.' },
    { q: 'Un Owner intenta borrar un grupo con bloqueo CanNotDelete. ¿Qué ocurre?', options: ['Se borra, Owner puede todo', 'Falla con ScopeLocked hasta que se quite el bloqueo', 'Se borra sólo el bloqueo', 'Se mueve a la papelera'], answer: 1, explain: 'Los bloqueos se aplican a todos los usuarios, incluido Owner.' },
    { q: '¿Qué efecto de Azure Policy impide crear un recurso no conforme?', options: ['Audit', 'Deny', 'Modify', 'Disabled'], answer: 1, explain: 'Deny bloquea la petición con RequestDisallowedByPolicy.' },
    { q: 'En KQL, ¿qué operador agrega filas (por ejemplo, contar por usuario)?', options: ['where', 'project', 'summarize', 'take'], answer: 2, explain: 'summarize count() by Caller agrupa y cuenta.' },
  ],
};

export const LEVEL13: Level = {
  id: 13,
  slug: 'proyecto-final',
  title: 'Proyecto final: plataforma DevOps completa',
  subtitle: 'Combina todo lo aprendido: IaC, CI/CD con aprobaciones, secretos, contenedores, supervisión y gobierno',
  icon: 'academy',
  skills: ['Arquitectura', 'IaC', 'CI/CD', 'Seguridad', 'Contenedores', 'Observabilidad', 'Gobierno'],
  lessons: [
    {
      id: 'l13-arquitectura',
      title: 'El proyecto: de un commit a producción',
      minutes: 7,
      body: `Ha llegado el momento de demostrar que eres un **auténtico ingeniero DevOps**. Vas a montar, de principio a fin, la plataforma de una aplicación como lo haría un equipo profesional:

\`\`\`
 Desarrollador ──git push──► Azure Repos (main protegida, PR)
                                   │
                                   ▼
                         Azure Pipelines (YAML)
                 ┌───────────┬─────────────┬──────────────────┐
                 │ Build     │ Deploy dev  │ Deploy prod      │
                 │ npm test  │ (automático)│ (con aprobación) │
                 └─────┬─────┴──────┬──────┴────────┬─────────┘
                       │ artefacto  │               │
                       ▼            ▼               ▼
                 rg-final:  App Service (identidad administrada) ──► Key Vault (secretos)
                            Log Analytics + alertas + grupo de acciones
                            Bloqueo + presupuesto + etiquetas
\`\`\`

## Principios que debes aplicar

1. **Todo como código**: infraestructura con Bicep/ARM/Terraform y el pipeline en YAML dentro del repositorio.
2. **Mínimo privilegio**: la conexión de servicio sólo tiene acceso a \`rg-final\`; la app lee secretos con su identidad administrada.
3. **Cero secretos en el código**: Key Vault + referencias desde App Service.
4. **Nada llega a producción sin revisión**: PR con revisión en \`main\` y aprobación del entorno \`prod\`.
5. **Si no se mide, no existe**: alertas sobre la aplicación con aviso por correo.
6. **Gobierno**: etiquetas de propietario y coste, bloqueo contra borrado y presupuesto.

## Consejos

- Sigue los pasos en orden, pero recuerda que puedes usar **cualquier herramienta**: portal, CLI, IaC o pipeline.
- Si algo falla, lee el error completo: el simulador te da los mismos mensajes que Azure (y una pista 💡 cuando puede).
- Reutiliza lo que ya tienes: los ejemplos de \`~/samples\`, tus scripts del nivel 2, tu Bicep del nivel 8 y el YAML del nivel 11.`,
    },
    {
      id: 'l13-siguientes',
      title: 'Y después, ¿qué?',
      minutes: 4,
      body: `Si has llegado hasta aquí, dominas los fundamentos que se piden a un ingeniero DevOps en Azure. Para seguir creciendo:

## Certificaciones que encajan con esta ruta

- **AZ-900** (Azure Fundamentals): niveles 1-5.
- **AZ-104** (Azure Administrator): niveles 3-7 y 12.
- **AZ-400** (DevOps Engineer Expert): niveles 8-13.

## Temas para profundizar

- **GitHub Actions** (la alternativa de GitHub a Azure Pipelines, con los mismos conceptos).
- **Workload identity federation (OIDC)** para pipelines sin secretos.
- **Helm**, **GitOps** (Flux/Argo CD) e **ingress** en Kubernetes.
- **Azure Container Apps** y **Azure Functions** (serverless).
- **Redes privadas**: endpoints privados, Azure Firewall, Application Gateway, Front Door.
- **SRE**: SLO/SLI, presupuestos de error, gestión de incidentes y post-mortems.
- **FinOps**: optimización continua de costes.

## Practica con una suscripción real

Todo lo que has hecho aquí funciona igual en Azure. Abre una **cuenta gratuita**, configura **presupuestos y alertas de coste antes que nada** y repite los laboratorios. Y, sobre todo: automatiza, mide y mejora un poco cada día. ¡Enhorabuena! 🏆`,
    },
  ],
  exercises: [
    {
      id: 'e13-plataforma',
      title: 'La plataforma completa',
      summary: 'Infraestructura, seguridad, CI/CD con aprobación, supervisión y gobierno en rg-final.',
      difficulty: 'Reto',
      minutes: 90,
      scenario: `La startup **Tienda Nube** te contrata para montar su plataforma. Requisitos:

- Todo en el grupo **rg-final** (etiquetas \`proyecto=tienda-nube\` y \`propietario\`).
- La aplicación (\`~/samples/app-node\`) en **App Service**, desplegada **sólo por un pipeline** de Azure DevOps en el proyecto **final**.
- Fases **Build → dev → prod**, con **aprobación** para prod.
- La contraseña de la base de datos en **Key Vault**, leída por la app con su **identidad administrada**.
- **Alerta** de errores HTTP 5xx con aviso por correo.
- **Bloqueo** contra borrado y **presupuesto** mensual.`,
      steps: [
        { id: 'rg', title: 'Crea rg-final con las etiquetas proyecto=tienda-nube y propietario', check: (c) => { const g = c.rg('rg-final'); if (!g) return 'No existe rg-final.'; return g.tags?.proyecto === 'tienda-nube' && g.tags?.propietario ? true : 'rg-final necesita las etiquetas proyecto=tienda-nube y propietario=<tu nombre>.'; } },
        { id: 'iac', title: 'Crea la infraestructura (plan + web app) con una implementación de ARM/Bicep en rg-final', check: (c) => (c.s.deployments.some((d) => d.resourceGroup.toLowerCase() === 'rg-final' && d.provisioningState === 'Succeeded') && c.site('rg-final') ? true : 'Necesitas una implementación correcta (az deployment group create) que cree la web app en rg-final.') },
        { id: 'kv', title: 'Key Vault con el secreto DbPassword y la app leyéndolo por referencia con su identidad', check: (c) => { const site = c.site('rg-final'); if (!site) return false; if (!c.one(T.kv, c.inRg('rg-final'))) return 'No hay Key Vault en rg-final.'; return kvRefResolved(site) ? true : 'La app no tiene ninguna referencia a Key Vault que se resuelva.'; } },
        { id: 'repo', title: 'Proyecto final en Azure DevOps con el código de la app y main protegida (≥1 revisor)', check: (c) => { const p = fp(c); if (!p) return 'No existe el proyecto final en Azure DevOps.'; const r = p.repos.find((x) => Object.keys(x.branches).length); if (!r) return 'El repositorio del proyecto final está vacío.'; return (r.policies?.minReviewers ?? 0) >= 1 ? true : 'Protege main con al menos un revisor.'; } },
        { id: 'sc', title: 'Conexión de servicio de Azure Resource Manager limitada a rg-final', check: (c) => (fp(c)?.serviceConnections.some((s) => s.type === 'azurerm' && scLimitedTo(c, s, 'rg-final')) ? true : 'No hay una conexión de servicio con ámbito rg-final en el proyecto final.') },
        { id: 'pipeline', title: 'Pipeline con al menos 3 fases (Build, dev, prod) y aprobación en el entorno prod', check: (c) => { const p = fp(c); if (!p) return false; const env = p.environments.find((e) => e.name.toLowerCase() === 'prod'); if (!env?.requireApproval) return 'El entorno prod debe requerir aprobación.'; return runs(c, p).some((r) => r.stages.length >= 3) ? true : 'Todavía no hay ninguna ejecución con 3 fases o más.'; } },
        { id: 'release', title: 'Una ejecución completa y aprobada que despliegue la app en rg-final', check: (c) => { const p = fp(c); const ok = runs(c, p).some((r) => okRun(r) && r.stages.some((s) => s.approval?.status === 'approved')); if (!ok) return 'No hay ninguna ejecución correcta con la aprobación de prod.'; const site = c.site('rg-final'); return site && site.data?.content?.by === 'VSTS' && c.httpOk(siteUrl(site)) ? true : 'La web app no tiene un despliegue de Azure Pipelines que responda.'; } },
        { id: 'monitor', title: 'Alerta de Http5xx sobre la web app con un grupo de acciones de correo', check: (c) => { const site = c.site('rg-final'); const rule = c.one(T.alert, (r) => c.inRg('rg-final')(r) && /Http5xx/i.test(r.properties.criteria?.allOf?.[0]?.metricName ?? '') && String(r.properties.scopes?.[0] ?? '').toLowerCase() === site?.id.toLowerCase()); return rule && (rule.properties.actions ?? []).length ? true : 'Falta una regla de alertas de Http5xx sobre la web app con un grupo de acciones.'; } },
        { id: 'gov', title: 'Bloqueo CanNotDelete en rg-final y un presupuesto mensual', check: (c) => (c.s.locks.some((l) => l.level === 'CanNotDelete' && l.scope.toLowerCase().endsWith('/resourcegroups/rg-final')) ? (c.s.budgets.length ? true : 'Crea un presupuesto mensual.') : 'rg-final no tiene un bloqueo CanNotDelete.') },
      ],
      solution: `Una posible solución completa (adáptala a tus nombres):

\`\`\`bash
# 1. Grupo e infraestructura como código
az group create -n rg-final -l westeurope --tags proyecto=tienda-nube propietario={{name}}
az deployment group create -g rg-final -f ~/samples/bicep/main.bicep -p entorno=prod
APP=$(az webapp list -g rg-final --query "[0].name" -o tsv)

# 2. Secretos con identidad administrada
KV=kv-final-$RANDOM
az keyvault create -g rg-final -n $KV --enable-rbac-authorization true
az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Key Vault Secrets Officer" --scope $(az keyvault show -n $KV --query id -o tsv)
az keyvault secret set --vault-name $KV -n DbPassword --value "Pr0d-S3cr3t!"
PID=$(az webapp identity assign -g rg-final -n $APP --query principalId -o tsv)
az role assignment create --assignee $PID --role "Key Vault Secrets User" --scope $(az keyvault show -n $KV --query id -o tsv)
az webapp config appsettings set -g rg-final -n $APP --settings "DB_PASSWORD=@Microsoft.KeyVault(SecretUri=https://$KV.vault.azure.net/secrets/DbPassword/)"

# 3. Azure DevOps
az devops project create --name final
az devops configure --defaults project=final
az repos import create --git-source-url https://github.com/azure-lab/app-node --repository final
\`\`\`
En el portal de DevOps: conexión de servicio \`sc-azure-lab\` con ámbito **rg-final**, entorno **prod** con aprobación, y en el repositorio edita \`azure-pipelines.yml\`: pon \`webAppName\` y añade una fase \`DeployProd\` con \`environment: prod\` (como en el nivel 11). Crea el pipeline, ejecútalo y aprueba prod. Después protege main con 1 revisor.

\`\`\`bash
# 4. Supervisión y gobierno
az monitor action-group create -g rg-final -n ag-final --short-name final --action email admin $(az account show --query user.name -o tsv)
az monitor metrics alert create -g rg-final -n errores-5xx --scopes $(az webapp show -g rg-final -n $APP --query id -o tsv) --condition "total Http5xx > 5" --window-size 5m --action ag-final
az lock create -n no-borrar -g rg-final --lock-type CanNotDelete
az consumption budget create -n presupuesto-final --amount 100 --category cost --time-grain monthly --start-date 2026-01-01 --end-date 2027-12-31 --thresholds 80 100 --contact-emails $(az account show --query user.name -o tsv)
\`\`\``,
      wrapUp: '🏆 **¡Lo has conseguido!** Has construido una plataforma con IaC, CI/CD con aprobaciones, secretos sin contraseñas, supervisión y gobierno. Eso es exactamente el trabajo de un ingeniero DevOps.',
    },
    {
      id: 'e13-k8s-cicd',
      title: 'Reto extra: CI/CD de contenedores hacia AKS',
      summary: 'Un pipeline que construye la imagen en ACR (Docker@2) y la despliega en AKS (KubernetesManifest@1).',
      difficulty: 'Reto',
      minutes: 60,
      scenario: 'Tienda Nube quiere migrar a Kubernetes. Crea un pipeline que, en cada push, construya la imagen con el número de build como etiqueta, la suba a ACR y actualice el Deployment de AKS.',
      steps: [
        { id: 'infra', title: 'ACR y AKS (con AcrPull) en rg-final-k8s', check: (c) => { const acr = c.one(T.acr, c.inRg('rg-final-k8s')); const aks = c.one(T.aks, c.inRg('rg-final-k8s')); if (!acr || !aks) return 'Necesitas un ACR y un AKS en rg-final-k8s.'; const kp = kubeletPrincipal(aks); return kp && c.hasRole(kp.objectId, 'AcrPull', acr.name) ? true : 'El clúster no tiene AcrPull sobre el registro.'; } },
        { id: 'sc', title: 'Conexiones de servicio de Docker Registry (ACR) y Kubernetes (AKS) en el proyecto final', check: (c) => { const p = fp(c); if (!p) return 'No existe el proyecto final.'; const types = new Set(p.serviceConnections.map((s) => s.type)); return types.has('dockerregistry') && types.has('kubernetes') ? true : 'Faltan las conexiones de tipo Docker Registry y/o Kubernetes.'; } },
        { id: 'yaml', title: 'Un YAML con las tareas Docker@2 y KubernetesManifest@1', check: (c) => { const p = fp(c); const r = p?.repos.find((x) => Object.keys(x.branches).length); const tree = r ? r.commits[r.branches[r.defaultBranch]]?.tree ?? {} : {}; return Object.entries(tree).some(([k, v]) => /\.ya?ml$/.test(k) && /Docker@2/.test(v) && /KubernetesManifest@1/.test(v)) ? true : 'Ningún YAML de main usa Docker@2 y KubernetesManifest@1.'; } },
        { id: 'image', title: 'El pipeline sube a ACR una imagen etiquetada con el número de build', check: (c) => { const acr = c.one(T.acr, c.inRg('rg-final-k8s')); const p = fp(c); const ids = new Set((p?.runs ?? []).map((r) => r.id)); return Object.values<any>(acr?.data?.repos ?? {}).some((repo) => Object.keys(repo.tags ?? {}).some((t) => ids.has(t))) ? true : 'El ACR no tiene ninguna imagen etiquetada con el id de una ejecución del pipeline.'; } },
        { id: 'deploy', title: 'El Deployment de AKS ejecuta esa imagen con todos los pods en Running', check: (c) => { const aks = c.one(T.aks, c.inRg('rg-final-k8s')); const p = fp(c); if (!aks || !p) return false; const k = c.kube(aks); const ids = new Set(p.runs.map((r) => r.id)); const d = k.deployments.find((x) => x.template.containers.some((ct) => ids.has(ct.image.split(':').pop() ?? ''))); if (!d) return 'Ningún Deployment usa una imagen con la etiqueta de una ejecución.'; const pods = k.pods.filter((x) => x.owner?.name.startsWith(d.meta.name + '-') && x.status !== 'Terminating'); return pods.length && pods.every((x) => x.status === 'Running') ? true : 'Los pods del Deployment todavía no están todos en Running.'; } },
      ],
      solution: `\`\`\`bash
az group create -n rg-final-k8s -l westeurope
ACR=acrfinal$RANDOM
az acr create -g rg-final-k8s -n $ACR --sku Basic
az aks create -g rg-final-k8s -n aks-final --node-count 2 --generate-ssh-keys --attach-acr $ACR
\`\`\`
En el proyecto **final** crea las conexiones \`sc-acr\` (Docker Registry → tu ACR) y \`sc-aks\` (Kubernetes → aks-final). En el repositorio, ajusta \`k8s/deployment.yaml\` con \`image: <ACR>.azurecr.io/app-node:v1\` y añade \`k8s-pipeline.yml\`:

\`\`\`yaml
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
\`\`\`
Crea el pipeline con \`/k8s-pipeline.yml\` y ejecútalo.`,
      wrapUp: 'Has implementado un flujo de entrega de contenedores de nivel profesional: imagen inmutable por build, registro privado y despliegue declarativo en Kubernetes.',
    },
  ],
  quiz: [
    { q: 'En la plataforma final, ¿con qué identidad lee la aplicación la contraseña de Key Vault?', options: ['Con tu usuario', 'Con la identidad administrada de la web app', 'Con la clave del almacenamiento', 'Con la conexión de servicio del pipeline'], answer: 1, explain: 'La identidad administrada de la app tiene el rol Key Vault Secrets User y resuelve la referencia.' },
    { q: '¿Por qué la conexión de servicio debe limitarse a rg-final?', options: ['Por rendimiento', 'Por mínimo privilegio: si se compromete el pipeline, el daño se limita a ese grupo', 'Porque Azure DevOps lo exige', 'Para que sea más barato'], answer: 1, explain: 'Limitar el ámbito reduce el radio de impacto.' },
    { q: '¿Qué garantiza que un cambio no llegue a producción sin revisión humana?', options: ['El trigger de CI', 'Las directivas de rama (PR con revisores) y la aprobación del entorno prod', 'El presupuesto', 'El bloqueo CanNotDelete'], answer: 1, explain: 'Revisión del código en el PR y aprobación del despliegue en el entorno.' },
    { q: '¿Por qué etiquetar las imágenes con el número de build en lugar de "latest"?', options: ['Ocupan menos', 'Cada despliegue es trazable e inmutable y se puede volver atrás a una versión concreta', 'Kubernetes no admite latest', 'Es obligatorio en ACR'], answer: 1, explain: 'Una etiqueta única por build permite saber qué se ejecuta y hacer rollback fiable.' },
    { q: '¿Qué pieza te avisa si la aplicación empieza a devolver errores 500?', options: ['Advisor', 'Una regla de alertas de métrica (Http5xx) con un grupo de acciones', 'Azure Policy', 'El registro de actividad'], answer: 1, explain: 'Las alertas de métricas vigilan señales como Http5xx y notifican mediante grupos de acciones.' },
  ],
};

export const _l12 = { rgCheck };
