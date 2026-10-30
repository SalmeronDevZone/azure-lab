// Niveles 8 y 9: infraestructura como código; contenedores y Kubernetes.
import type { Level } from '../types';
import type { CheckCtx } from '../checks';
import type { Resource } from '../../../engine/types';
import { T, rgCheck } from './helpers';
import { kubeletPrincipal } from '../../../engine/services/kube';

const deps = (c: CheckCtx, rg: string) => c.s.deployments.filter((d) => d.resourceGroup.toLowerCase() === rg.toLowerCase() && new Date(d.timestamp).getTime() >= c.since - 1000);
const acr9 = (c: CheckCtx) => c.one(T.acr, c.inRg('rg-nivel9'));
const aks9 = (c: CheckCtx) => c.one(T.aks, c.inRg('rg-nivel9'));
const repoTags = (acr: Resource | undefined, repo: string): string[] => Object.keys(acr?.data?.repos?.[repo]?.tags ?? {});

function appDeployment(c: CheckCtx) {
  const cl = aks9(c);
  if (!cl) return null;
  const k = c.kube(cl);
  const d = k.deployments.find((x) => x.meta.name === 'app-node');
  if (!d) return null;
  const pods = k.pods.filter((p) => p.owner?.name.startsWith('app-node-') && p.status !== 'Terminating');
  return { cl, k, d, pods, ready: pods.filter((p) => p.status === 'Running').length };
}

export const LEVEL8: Level = {
  id: 8,
  slug: 'iac',
  title: 'Infraestructura como código',
  subtitle: 'Plantillas ARM, Bicep y Terraform: infraestructura versionada, repetible y revisable',
  icon: 'deployments',
  skills: ['Declarativo', 'ARM', 'Bicep', 'what-if', 'Terraform', 'Estado remoto'],
  lessons: [
    {
      id: 'l8-por-que',
      title: '¿Por qué infraestructura como código?',
      minutes: 6,
      body: `Hasta ahora has creado recursos con clics y comandos. Funciona, pero:

- ¿Cómo creas **exactamente** el mismo entorno en test y en producción?
- ¿Quién cambió ese NSG el martes, y por qué?
- ¿Cómo revisa un compañero un cambio de infraestructura **antes** de aplicarlo?

**Infraestructura como código (IaC)**: describes la infraestructura en ficheros de texto que guardas en Git, revisas con pull requests y aplicas con un pipeline.

## Imperativo frente a declarativo

| Imperativo (scripts) | Declarativo (IaC) |
| --- | --- |
| "Crea un grupo, luego una VNet, luego..." | "Quiero que exista esto" |
| Tú gestionas el orden y los errores | La herramienta calcula qué hacer |
| Ejecutarlo dos veces puede fallar | **Idempotente**: aplicar dos veces da el mismo resultado |

## Las herramientas en Azure

- **Plantillas ARM** (JSON): el formato nativo de Azure Resource Manager.
- **Bicep**: un lenguaje más legible que se compila a ARM. Es la opción recomendada por Microsoft para Azure.
- **Terraform** (HashiCorp, HCL): multinube, con un fichero de **estado** que registra lo que gestiona.

Las tres son declarativas e idempotentes. Cualquiera de ellas se puede ejecutar desde un pipeline (nivel 11).

## Deriva (drift)

Si alguien cambia a mano un recurso gestionado por IaC, el código y la realidad dejan de coincidir. Las herramientas detectan esa **deriva**: \`az deployment group what-if\` en ARM/Bicep y \`terraform plan\` en Terraform.`,
    },
    {
      id: 'l8-arm-bicep',
      title: 'Plantillas ARM y Bicep',
      minutes: 9,
      body: `## Estructura de una plantilla ARM

\`\`\`json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": { "prefijo": { "type": "string", "defaultValue": "stlab" } },
  "variables": { "nombre": "[concat(parameters('prefijo'), uniqueString(resourceGroup().id))]" },
  "resources": [{
    "type": "Microsoft.Storage/storageAccounts",
    "apiVersion": "2023-05-01",
    "name": "[variables('nombre')]",
    "location": "[resourceGroup().location]",
    "sku": { "name": "Standard_LRS" },
    "kind": "StorageV2"
  }],
  "outputs": { "cuenta": { "type": "string", "value": "[variables('nombre')]" } }
}
\`\`\`

Las expresiones entre \`[ ]\` se evalúan al desplegar: \`parameters()\`, \`variables()\`, \`resourceGroup()\`, \`uniqueString()\`, \`concat()\`, \`reference()\`...

## Lo mismo en Bicep

\`\`\`bicep
param prefijo string = 'stlab'
var nombre = '\${prefijo}\${uniqueString(resourceGroup().id)}'

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: nombre
  location: resourceGroup().location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
}

output cuenta string = st.name
\`\`\`

Más corto, con autocompletado y con dependencias implícitas (si usas \`st.id\` en otro recurso, Bicep sabe que va después).

## Desplegar

\`\`\`bash
az deployment group what-if -g rg-nivel8 -f main.bicep -p prefijo=stdemo   # vista previa
az deployment group create  -g rg-nivel8 -f main.bicep -p prefijo=stdemo   # aplicar
az deployment group list -g rg-nivel8 -o table
az bicep build -f main.bicep        # ver el ARM generado
\`\`\`

## Modos

- **Incremental** (por defecto): crea y actualiza lo que hay en la plantilla; no toca lo demás.
- **Complete**: además **elimina** lo que haya en el grupo y no esté en la plantilla. Úsalo con mucho cuidado (y siempre con what-if antes).

> Truco: en cualquier grupo de recursos del portal, **Exportar plantilla** genera el ARM de lo que ya existe (\`az group export -n <rg>\`). Es un buen punto de partida.`,
    },
    {
      id: 'l8-terraform',
      title: 'Terraform: init, plan, apply y estado',
      minutes: 9,
      body: `Terraform usa ficheros \`.tf\` en HCL. Un **proveedor** (\`azurerm\`) traduce los recursos a llamadas a la API de Azure.

\`\`\`hcl
provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-tflab-dev"
  location = "westeurope"
}
\`\`\`

## El ciclo de trabajo

\`\`\`bash
cd ~/samples/terraform
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)   # azurerm 4.x lo exige
terraform init       # descarga proveedores y configura el backend
terraform plan       # qué va a cambiar (+ crear, ~ modificar, - destruir)
terraform apply      # aplicar (pide confirmación; -auto-approve en pipelines)
terraform output     # valores de salida
terraform destroy    # eliminar todo lo gestionado
\`\`\`

## El fichero de estado

Terraform guarda en **terraform.tfstate** qué recursos gestiona y sus atributos. Es crítico:

- Sin él, Terraform "olvida" la infraestructura e intentaría crearla de nuevo.
- Puede contener **secretos**.
- Si dos personas (o pipelines) aplican a la vez con estados locales distintos, se pisan.

Por eso en equipo el estado va en un **backend remoto**: un blob en una cuenta de almacenamiento de Azure, con bloqueo.

\`\`\`hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "rg-tfstate"
    storage_account_name = "sttfstate12345"
    container_name       = "tfstate"
    key                  = "lab.terraform.tfstate"
  }
}
\`\`\`

Después de añadir o cambiar el backend, vuelve a ejecutar \`terraform init\`.

## Qué ficheros de Terraform van a Git

| Fichero | ¿A Git? | Por qué |
| --- | --- | --- |
| \`*.tf\` | Sí | Es tu infraestructura como código |
| \`.terraform.lock.hcl\` | **Sí** | Fija las versiones de los proveedores, como \`package-lock.json\` |
| \`.terraform/\` | No | Lo descarga \`terraform init\` |
| \`terraform.tfstate\`, \`*.tfstate.backup\` | **Nunca** | Contiene secretos en texto plano; va en el backend remoto |
| \`*.tfvars\` | Depende | Sí si no tiene secretos; los secretos, con variables \`TF_VAR_\` |

> En un pipeline, el agente es una máquina nueva en cada ejecución: **sin backend remoto el estado se pierde** al terminar. Lo comprobarás en el nivel 11.`,
    },
  ],
  exercises: [
    {
      id: 'e8-arm',
      title: 'Despliega una plantilla ARM con what-if',
      summary: 'Previsualiza y despliega ~/samples/arm/storage.json.',
      difficulty: 'Fácil',
      minutes: 10,
      scenario: 'Vas a desplegar una cuenta de almacenamiento definida en una plantilla, revisando antes qué cambios hará.',
      steps: [
        { id: 'rg', title: 'Crea el grupo de recursos rg-nivel8', check: (c) => rgCheck(c, 'rg-nivel8') },
        { id: 'whatif', title: 'Ejecuta what-if con ~/samples/arm/storage.json', check: (c) => c.ran(/deployment group what-if/) || 'Usa az deployment group what-if -g rg-nivel8 -f ~/samples/arm/storage.json' },
        { id: 'deploy', title: 'Despliega la plantilla (implementación correcta en rg-nivel8)', check: (c) => (deps(c, 'rg-nivel8').some((d) => d.provisioningState === 'Succeeded') ? true : 'No hay ninguna implementación correcta reciente en rg-nivel8.') },
        { id: 'outputs', title: 'Consulta las salidas de la implementación con --query', check: (c) => c.ran(/deployment group (show|list).*--query.*outputs/) || c.ran(/deployment group show/) || 'Prueba az deployment group show -g rg-nivel8 -n <implementación> --query properties.outputs' },
        { id: 'export', title: 'Exporta la plantilla del grupo de recursos', check: (c) => c.ran(/az (group export|deployment group export)/) || 'Usa az group export -n rg-nivel8 (o "Exportar plantilla" en el portal y luego el comando).' },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel8 -l westeurope
az deployment group what-if -g rg-nivel8 -f ~/samples/arm/storage.json
az deployment group create -g rg-nivel8 -n despliegue-st -f ~/samples/arm/storage.json
az deployment group show -g rg-nivel8 -n despliegue-st --query properties.outputs
az group export -n rg-nivel8 > ~/rg-nivel8.json
\`\`\``,
    },
    {
      id: 'e8-bicep',
      title: 'Escribe tu propio Bicep',
      summary: 'Un fichero Bicep con parámetro, recurso y salida, desplegado en Azure.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Escribe desde cero un Bicep que cree un plan de App Service y una web app, con el nombre como parámetro y la URL como salida. (Puedes inspirarte en `~/samples/bicep/main.bicep`).',
      steps: [
        { id: 'file', title: 'Crea ~/iac/main.bicep con al menos un param, un resource y un output', check: (c) => { const f = c.file('iac/main.bicep'); if (!f) return 'No existe ~/iac/main.bicep.'; for (const k of ['param ', 'resource ', 'output ']) if (!f.includes(k)) return `Al fichero le falta "${k.trim()}".`; return true; } },
        { id: 'build', title: 'Compílalo a ARM con az bicep build', check: (c) => c.ran(/az bicep build/) || 'Ejecuta az bicep build -f ~/iac/main.bicep' },
        { id: 'deploy', title: 'Despliégalo en rg-nivel8 y que la implementación tenga salidas', check: (c) => { if (!c.ran(/deployment group create.*\.bicep/)) return 'Despliega el fichero .bicep con az deployment group create.'; return deps(c, 'rg-nivel8').some((d) => d.provisioningState === 'Succeeded' && Object.keys(d.outputs ?? {}).length) ? true : 'La implementación no terminó bien o no tiene salidas (output).'; } },
        { id: 'site', title: 'Comprueba que se ha creado una web app en rg-nivel8', check: (c) => (c.site('rg-nivel8') ? true : 'No hay ninguna web app en rg-nivel8.') },
      ],
      solution: `\`\`\`bash
mkdir -p ~/iac
cat > ~/iac/main.bicep <<'EOF'
param nombre string = 'app-bicep-\${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-\${nombre}'
  location: location
  sku: { name: 'B1' }
  kind: 'linux'
  properties: { reserved: true }
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: nombre
  location: location
  properties: {
    serverFarmId: plan.id
    siteConfig: { linuxFxVersion: 'NODE|20-lts' }
  }
}

output url string = 'https://\${web.properties.defaultHostName}'
EOF
az bicep build -f ~/iac/main.bicep
az deployment group create -g rg-nivel8 -f ~/iac/main.bicep --query properties.outputs
\`\`\``,
    },
    {
      id: 'e8-terraform',
      title: 'Terraform con estado remoto en Azure Storage',
      summary: 'Backend azurerm, init, plan y apply del ejemplo ~/samples/terraform.',
      difficulty: 'Difícil',
      minutes: 20,
      scenario: 'Tu equipo va a usar Terraform. Antes de nada, el estado tiene que vivir en Azure Storage para que todos (y los pipelines) compartan la misma verdad.',
      steps: [
        { id: 'state', title: 'Crea rg-tfstate con una cuenta de almacenamiento y un contenedor tfstate', check: (c) => { if (!c.rg('rg-tfstate')) return 'No existe rg-tfstate.'; const st = c.storage('rg-tfstate'); if (!st) return 'No hay cuenta de almacenamiento en rg-tfstate.'; return st.data?.containers?.tfstate ? true : 'Falta el contenedor tfstate.'; } },
        { id: 'backend', title: 'Añade un bloque backend "azurerm" a ~/samples/terraform/main.tf', check: (c) => (/backend\s+"azurerm"/.test(c.file('samples/terraform/main.tf') ?? '') || /backend\s+"azurerm"/.test(c.file('samples/terraform/backend.tf') ?? '') ? true : 'No encuentro backend "azurerm" en main.tf ni en backend.tf.') },
        { id: 'init', title: 'Ejecuta terraform init (con ARM_SUBSCRIPTION_ID exportada)', check: (c) => c.ran(/terraform init/) || 'terraform init todavía no ha terminado bien.' },
        { id: 'plan', title: 'Revisa el plan con terraform plan', check: (c) => c.ran(/terraform plan/) || 'Ejecuta terraform plan.' },
        { id: 'apply', title: 'Aplica con terraform apply y comprueba que el estado está en el blob', check: (c) => { if (!c.ran(/terraform apply/)) return 'terraform apply todavía no ha terminado bien.'; const st = c.storage('rg-tfstate'); return Object.keys(st?.data?.containers?.tfstate?.blobs ?? {}).length ? true : 'No hay ningún blob de estado en el contenedor tfstate.'; } },
        { id: 'rg', title: 'Verifica que Terraform creó el grupo rg-tflab-dev con la etiqueta creadoCon=terraform', check: (c) => (c.rg('rg-tflab-dev')?.tags?.creadoCon === 'terraform' ? true : 'No existe rg-tflab-dev etiquetado por Terraform.') },
      ],
      solution: `\`\`\`bash
az group create -n rg-tfstate -l westeurope
TFST=sttfstate$RANDOM
az storage account create -n $TFST -g rg-tfstate --sku Standard_LRS
az storage container create --account-name $TFST -n tfstate --auth-mode key
cd ~/samples/terraform
cat > backend.tf <<EOF
terraform {
  backend "azurerm" {
    resource_group_name  = "rg-tfstate"
    storage_account_name = "$TFST"
    container_name       = "tfstate"
    key                  = "lab.terraform.tfstate"
  }
}
EOF
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
terraform init
terraform plan
terraform apply -auto-approve
az storage blob list --account-name $TFST -c tfstate --auth-mode key -o table
\`\`\``,
      wrapUp: 'Prueba a cambiar a mano una etiqueta de rg-tflab-dev en el portal y ejecuta `terraform plan`: verás la deriva. Para limpiar: `terraform destroy -auto-approve`.',
    },
  ],
  quiz: [
    { q: '¿Qué significa que una herramienta de IaC sea idempotente?', options: ['Que es gratuita', 'Que aplicarla varias veces produce el mismo resultado', 'Que sólo funciona una vez', 'Que no necesita estado'], answer: 1, explain: 'Puedes aplicar la misma definición tantas veces como quieras: sólo cambia lo necesario.' },
    { q: '¿Qué hace `az deployment group what-if`?', options: ['Despliega en modo prueba en otra región', 'Muestra los cambios que haría el despliegue sin aplicarlos', 'Borra los recursos que sobran', 'Compila Bicep'], answer: 1, explain: 'what-if es la vista previa de ARM/Bicep, como terraform plan.' },
    { q: '¿Qué riesgo tiene el modo Complete en un despliegue ARM?', options: ['Ninguno', 'Elimina los recursos del grupo que no estén en la plantilla', 'No admite parámetros', 'Es más lento'], answer: 1, explain: 'Complete deja el grupo exactamente como la plantilla, borrando lo demás.' },
    { q: '¿Por qué se guarda el estado de Terraform en un backend remoto?', options: ['Porque es obligatorio en azurerm', 'Para compartirlo entre personas y pipelines con bloqueo y no perderlo', 'Para que sea más rápido', 'Para cifrar el código'], answer: 1, explain: 'Un estado local se pierde o diverge; el backend remoto es la fuente de verdad compartida.' },
    { q: 'Bicep se...', options: ['Ejecuta en una VM', 'Compila a una plantilla ARM', 'Convierte en Terraform', 'Interpreta en el navegador'], answer: 1, explain: 'Bicep es un lenguaje que se transpila a JSON de ARM antes de desplegar.' },
  ],
};

export const LEVEL9: Level = {
  id: 9,
  slug: 'contenedores',
  title: 'Contenedores y Kubernetes',
  subtitle: 'Docker, Azure Container Registry, Container Instances y Azure Kubernetes Service',
  icon: 'aks',
  skills: ['Docker', 'Dockerfile', 'ACR', 'ACI', 'AKS', 'kubectl', 'Rolling update'],
  lessons: [
    {
      id: 'l9-docker',
      title: 'Docker: imágenes y contenedores',
      minutes: 8,
      body: `Un **contenedor** empaqueta tu aplicación con todo lo que necesita (runtime, librerías, configuración) para que se ejecute igual en tu portátil, en un pipeline o en producción. A diferencia de una VM, comparte el núcleo del sistema operativo: arranca en segundos y ocupa megas, no gigas.

- **Imagen**: plantilla inmutable (por capas). Se construye a partir de un **Dockerfile**.
- **Contenedor**: una instancia en ejecución de una imagen.
- **Registro**: almacén de imágenes (Docker Hub, **Azure Container Registry**).

## Dockerfile

\`\`\`dockerfile
FROM node:20-alpine          # imagen base
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
\`\`\`

## Comandos básicos

\`\`\`bash
cd ~/samples/app-node
docker build -t app-node:v1 .
docker images
docker run -d -p 8080:3000 --name web app-node:v1
curl localhost:8080
docker logs web
docker stop web && docker rm web
\`\`\`

\`-p 8080:3000\` publica el puerto 3000 del contenedor en el 8080 del host.

## .dockerignore: lo que no entra en la imagen

\`COPY . .\` copia **todo** el directorio... salvo lo que diga \`.dockerignore\`. Sin él, tu \`.env\`, la carpeta \`.git\` (con todo el historial) y \`node_modules\` acaban dentro de la imagen, y cualquiera que pueda descargarla puede leerlos.

\`\`\`text
node_modules
.git
.env
*.zip
\`\`\`

Dos reglas más: nunca pongas secretos en \`ENV\` o \`ARG\` del Dockerfile (se ven con \`docker history\`), y recuerda que un fichero copiado en una capa sigue en la imagen aunque lo borres en una capa posterior.

## Etiquetas (tags)

\`app-node:v1\`, \`app-node:v2\`... Evita \`latest\` en producción: no sabes qué versión estás ejecutando. En CI/CD se suele etiquetar con el número de build o el hash del commit.`,
    },
    {
      id: 'l9-acr-aci',
      title: 'Azure Container Registry y Container Instances',
      minutes: 7,
      body: `## Azure Container Registry (ACR)

Tu registro privado de imágenes, integrado con Entra ID.

\`\`\`bash
az acr create -g rg-nivel9 -n acr{{user}}01 --sku Basic
# Opción A: construir en la nube (no necesitas Docker local)
az acr build -r acr{{user}}01 -t app-node:v1 ~/samples/app-node
# Opción B: construir en local y subir
az acr login -n acr{{user}}01
docker tag app-node:v1 acr{{user}}01.azurecr.io/app-node:v1
docker push acr{{user}}01.azurecr.io/app-node:v1
az acr repository list -n acr{{user}}01 -o table
\`\`\`

Roles: **AcrPull** (descargar), **AcrPush** (subir). El **usuario administrador** (\`--admin-enabled true\`) es una credencial compartida: cómoda para pruebas, desaconsejada en producción.

## Azure Container Instances (ACI)

La forma más rápida de ejecutar un contenedor en Azure: sin VMs ni orquestador, pagas por segundo.

\`\`\`bash
az acr update -n acr{{user}}01 --admin-enabled true
PASS=$(az acr credential show -n acr{{user}}01 --query "passwords[0].value" -o tsv)
az container create -g rg-nivel9 -n aci-app --image acr{{user}}01.azurecr.io/app-node:v1 \\
  --registry-login-server acr{{user}}01.azurecr.io --registry-username acr{{user}}01 --registry-password $PASS \\
  --ports 3000 --dns-name-label app{{user}} --ip-address Public
az container show -g rg-nivel9 -n aci-app --query ipAddress.fqdn -o tsv
az container logs -g rg-nivel9 -n aci-app
\`\`\`

ACI es ideal para tareas puntuales, pruebas y trabajos por lotes. Para aplicaciones con varias réplicas, escalado y actualizaciones sin caída, usarás Kubernetes.`,
    },
    {
      id: 'l9-aks',
      title: 'Kubernetes y AKS',
      minutes: 10,
      body: `**Kubernetes** orquesta contenedores: los reparte entre **nodos**, los reinicia si fallan, los escala y los actualiza sin caída. **AKS** es Kubernetes administrado: Azure gestiona el plano de control y tú sólo pagas los nodos.

## Objetos principales

| Objeto | Qué es |
| --- | --- |
| **Pod** | Uno o varios contenedores que se ejecutan juntos (la unidad mínima) |
| **Deployment** | Declara cuántas réplicas de un pod quieres y con qué imagen; gestiona las actualizaciones |
| **ReplicaSet** | Lo crea el Deployment para mantener N pods de una versión |
| **Service** | IP/nombre estable para un conjunto de pods. \`LoadBalancer\` les da una IP pública |
| **Namespace** | Separación lógica dentro del clúster |

## Crear el clúster y conectarte

\`\`\`bash
az aks create -g rg-nivel9 -n aks-lab --node-count 2 --generate-ssh-keys --attach-acr acr{{user}}01
az aks get-credentials -g rg-nivel9 -n aks-lab
kubectl get nodes
\`\`\`

\`--attach-acr\` asigna el rol **AcrPull** a la identidad del clúster (kubelet). Sin eso, los pods no pueden descargar imágenes privadas y verás **ErrImagePull / ImagePullBackOff**.

## Desplegar de forma declarativa

\`\`\`bash
kubectl apply -f ~/samples/app-node/k8s/      # deployment.yaml + service.yaml
kubectl get deployments,pods,services
kubectl describe pod <pod>                     # eventos: ¿por qué no arranca?
kubectl logs <pod>
\`\`\`

## Actualizar y volver atrás

\`\`\`bash
kubectl set image deployment/app-node app-node=acr{{user}}01.azurecr.io/app-node:v2
kubectl rollout status deployment/app-node
kubectl rollout history deployment/app-node
kubectl rollout undo deployment/app-node
kubectl scale deployment/app-node --replicas=4
\`\`\`

El **rolling update** crea pods nuevos y retira los antiguos poco a poco: los usuarios no notan el cambio.`,
    },
  ],
  exercises: [
    {
      id: 'e9-docker',
      title: 'Conteneriza la aplicación y súbela a ACR',
      summary: 'docker build, docker run, prueba local y publicación en Azure Container Registry.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'La app Node.js va a pasar a contenedores. Construye la imagen, pruébala en local y publícala en un registro privado.',
      steps: [
        { id: 'build', title: 'Construye la imagen app-node:v1 con docker build en ~/samples/app-node', check: (c) => c.ran(/docker build/) || 'Ejecuta docker build -t app-node:v1 . dentro de ~/samples/app-node' },
        { id: 'run', title: 'Ejecuta un contenedor publicando el puerto 3000 en el 8080', check: (c) => (c.s.docker.containers.some((x) => x.status === 'running' && x.ports.some((p) => p.container === 3000)) ? true : 'No hay ningún contenedor en ejecución con el puerto 3000 publicado.') },
        { id: 'curl', title: 'Prueba la app con curl localhost:8080', check: (c) => c.ran(/curl .*localhost/) || 'Haz curl localhost:8080' },
        { id: 'acr', title: 'Crea un registro de contenedor en rg-nivel9', check: (c) => (rgCheck(c, 'rg-nivel9') === true ? (acr9(c) ? true : 'No hay ningún ACR en rg-nivel9.') : rgCheck(c, 'rg-nivel9')) },
        { id: 'push', title: 'Publica la imagen app-node:v1 en el ACR (az acr build o docker push)', check: (c) => (repoTags(acr9(c), 'app-node').includes('v1') ? true : 'El repositorio app-node:v1 todavía no está en el registro.') },
      ],
      solution: `\`\`\`bash
cd ~/samples/app-node
docker build -t app-node:v1 .
docker run -d -p 8080:3000 --name web app-node:v1
curl localhost:8080
az group create -n rg-nivel9 -l westeurope
ACR=acr$RANDOM
az acr create -g rg-nivel9 -n $ACR --sku Basic
az acr build -r $ACR -t app-node:v1 .
az acr repository show-tags -n $ACR --repository app-node -o table
\`\`\``,
    },
    {
      id: 'e9-aci',
      title: 'Ejecuta el contenedor en Azure Container Instances',
      summary: 'Un contenedor público en segundos, con la imagen de tu ACR.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'Necesitas una demo pública de la app en cinco minutos. Container Instances es perfecto.',
      steps: [
        { id: 'admin', title: 'Habilita el usuario administrador del ACR (sólo para esta prueba)', check: (c) => (acr9(c)?.properties.adminUserEnabled ? true : 'El usuario administrador del ACR está deshabilitado.') },
        { id: 'aci', title: 'Crea la instancia aci-app con la imagen del ACR, IP pública y puerto 3000', check: (c) => { const a = c.one(T.aci, (r) => c.inRg('rg-nivel9')(r)); if (!a) return 'No hay ninguna instancia de contenedor en rg-nivel9.'; return /azurecr\.io\/app-node/.test(a.properties.containers?.[0]?.properties?.image ?? '') ? true : 'La instancia debe usar la imagen app-node de tu ACR.'; } },
        { id: 'http', title: 'Abre la app (http://<IP o FQDN>:3000) y comprueba que responde', check: (c) => { const a = c.one(T.aci, c.inRg('rg-nivel9')); const ip = a?.properties.ipAddress?.ip; return ip && c.httpOk(`http://${ip}:3000`) ? true : 'La instancia todavía no responde en el puerto 3000.'; } },
        { id: 'logs', title: 'Consulta sus registros con az container logs', check: (c) => c.ran(/az container logs/) || 'Usa az container logs -g rg-nivel9 -n aci-app' },
      ],
      solution: `\`\`\`bash
ACR=$(az acr list -g rg-nivel9 --query "[0].name" -o tsv)
az acr update -n $ACR --admin-enabled true
PASS=$(az acr credential show -n $ACR --query "passwords[0].value" -o tsv)
az container create -g rg-nivel9 -n aci-app --image $ACR.azurecr.io/app-node:v1 --registry-login-server $ACR.azurecr.io --registry-username $ACR --registry-password $PASS --ports 3000 --ip-address Public --dns-name-label app$RANDOM
IP=$(az container show -g rg-nivel9 -n aci-app --query ipAddress.ip -o tsv)
curl http://$IP:3000
az container logs -g rg-nivel9 -n aci-app
\`\`\``,
    },
    {
      id: 'e9-aks',
      title: 'Despliega en Azure Kubernetes Service',
      summary: 'Clúster AKS con acceso al ACR, Deployment de 2 réplicas y Service LoadBalancer.',
      difficulty: 'Difícil',
      minutes: 20,
      scenario: 'La app necesita alta disponibilidad y actualizaciones sin caída. Despliégala en AKS con dos réplicas detrás de un equilibrador de carga.',
      steps: [
        { id: 'aks', title: 'Crea un clúster AKS en rg-nivel9 y obtén sus credenciales', check: (c) => (aks9(c) ? (c.ran(/aks get-credentials/) ? true : 'Ejecuta az aks get-credentials para configurar kubectl.') : 'No hay ningún clúster AKS en rg-nivel9.') },
        { id: 'acrpull', title: 'Permite que el clúster descargue imágenes de tu ACR (AcrPull)', check: (c) => { const cl = aks9(c); const acr = acr9(c); const kp = cl && kubeletPrincipal(cl); return kp && acr && c.hasRole(kp.objectId, 'AcrPull', acr.name) ? true : 'La identidad del clúster no tiene AcrPull en el registro (usa --attach-acr).'; } },
        { id: 'manifest', title: 'Edita ~/samples/app-node/k8s/deployment.yaml para usar la imagen de tu ACR', check: (c) => (/image:\s*\S+\.azurecr\.io\/app-node:v1/.test(c.file('samples/app-node/k8s/deployment.yaml') ?? '') && !(c.file('samples/app-node/k8s/deployment.yaml') ?? '').includes('<TU_ACR>') ? true : 'El manifiesto todavía usa <TU_ACR> o no apunta a tu registro.') },
        { id: 'deploy', title: 'Aplica los manifiestos y consigue 2 pods de app-node en Running', check: (c) => { const a = appDeployment(c); if (!a) return 'No existe el Deployment app-node en el clúster.'; return a.ready >= 2 ? true : `Pods listos: ${a.ready}/2. Revisa kubectl get pods y kubectl describe pod.`; } },
        { id: 'svc', title: 'Comprueba que el Service LoadBalancer tiene IP externa y la app responde', check: (c) => { const a = appDeployment(c); const svc = a?.k.services.find((x) => x.type === 'LoadBalancer' && x.externalIP); return svc && c.httpOk(`http://${svc.externalIP}:${svc.ports[0]?.port ?? 80}`) ? true : 'El servicio todavía no tiene IP externa o no responde.'; } },
      ],
      solution: `\`\`\`bash
ACR=$(az acr list -g rg-nivel9 --query "[0].name" -o tsv)
az aks create -g rg-nivel9 -n aks-lab --node-count 2 --generate-ssh-keys --attach-acr $ACR
az aks get-credentials -g rg-nivel9 -n aks-lab
sed -i "s/<TU_ACR>/$ACR/" ~/samples/app-node/k8s/deployment.yaml
kubectl apply -f ~/samples/app-node/k8s/
kubectl get pods -w
kubectl get service app-node
curl http://$(kubectl get service app-node -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
\`\`\``,
      wrapUp: 'Prueba a quitar el rol AcrPull (o a desplegar una imagen que no existe) y observa ErrImagePull → ImagePullBackOff con `kubectl describe pod`: es uno de los errores más comunes en AKS.',
    },
    {
      id: 'e9-rollout',
      title: 'Actualización continua y rollback',
      summary: 'Publica la v2, actualiza el Deployment sin caída y vuelve atrás.',
      difficulty: 'Difícil',
      minutes: 15,
      scenario: 'Sale la versión 2. Despliégala con un rolling update y practica la vuelta atrás por si algo falla en producción.',
      steps: [
        { id: 'v2', title: 'Publica app-node:v2 en el ACR (cambia antes el mensaje en server.js)', check: (c) => (repoTags(acr9(c), 'app-node').includes('v2') ? true : 'El registro todavía no tiene app-node:v2.') },
        { id: 'set', title: 'Actualiza el Deployment a la imagen v2 (kubectl set image o apply)', check: (c) => { const a = appDeployment(c); return a?.d.template.containers.some((x) => x.image.endsWith(':v2')) || (a?.d.history ?? []).some((h) => h.images.includes(':v2')) ? true : 'El Deployment no ha usado todavía la imagen v2.'; } },
        { id: 'status', title: 'Sigue el despliegue con kubectl rollout status', check: (c) => c.ran(/kubectl rollout status/) || 'Ejecuta kubectl rollout status deployment/app-node' },
        { id: 'undo', title: 'Vuelve a la versión anterior con kubectl rollout undo', check: (c) => { if (!c.ran(/kubectl rollout undo/)) return 'Ejecuta kubectl rollout undo deployment/app-node'; const a = appDeployment(c); return a && a.d.template.containers.every((x) => x.image.endsWith(':v1')) ? true : 'El Deployment no ha vuelto a v1.'; } },
      ],
      solution: `\`\`\`bash
ACR=$(az acr list -g rg-nivel9 --query "[0].name" -o tsv)
cd ~/samples/app-node
sed -i 's/Hola desde Azure Lab v1/Hola desde Azure Lab v2/' server.js
az acr build -r $ACR -t app-node:v2 .
kubectl set image deployment/app-node app-node=$ACR.azurecr.io/app-node:v2
kubectl rollout status deployment/app-node
kubectl rollout history deployment/app-node
kubectl rollout undo deployment/app-node
\`\`\``,
      wrapUp: 'Cuando termines el nivel, detén el clúster (`az aks stop`) o borra rg-nivel9 para no acumular coste.',
    },
  ],
  quiz: [
    { q: 'Tu Dockerfile hace `COPY . .` y no tienes `.dockerignore`. ¿Qué entra en la imagen?', options: ['Solo el código', 'Todo el directorio: también .env, .git y node_modules', 'Nada hasta que hagas docker push', 'Solo lo versionado en Git'], answer: 1, explain: 'docker build copia todo el contexto salvo lo que diga .dockerignore; y un secreto copiado queda en una capa aunque lo borres después.' },
    { q: '¿Qué diferencia principal hay entre un contenedor y una VM?', options: ['El contenedor incluye su propio núcleo del SO', 'El contenedor comparte el núcleo del host y es mucho más ligero', 'La VM arranca más rápido', 'No hay diferencia'], answer: 1, explain: 'Los contenedores comparten el kernel: arrancan en segundos y ocupan poco.' },
    { q: 'Tus pods muestran ImagePullBackOff con una imagen de ACR. ¿Causa más probable?', options: ['Falta memoria', 'El clúster no tiene permiso AcrPull sobre el registro (o la imagen no existe)', 'El Service no es LoadBalancer', 'El puerto es incorrecto'], answer: 1, explain: 'Sin AcrPull (o con un nombre/etiqueta incorrectos) kubelet no puede descargar la imagen.' },
    { q: '¿Qué objeto de Kubernetes da una IP pública estable a un conjunto de pods?', options: ['Pod', 'ReplicaSet', 'Service de tipo LoadBalancer', 'ConfigMap'], answer: 2, explain: 'Un Service LoadBalancer crea una IP pública en Azure que reparte el tráfico entre los pods.' },
    { q: '¿Qué hace `az acr build`?', options: ['Crea un registro', 'Construye la imagen en la nube y la sube al registro', 'Despliega en AKS', 'Descarga una imagen'], answer: 1, explain: 'ACR Tasks construye la imagen sin necesidad de Docker local.' },
    { q: '¿Para qué sirve `kubectl rollout undo`?', options: ['Borrar el Deployment', 'Volver a la revisión anterior del Deployment', 'Reiniciar los nodos', 'Cancelar un pod'], answer: 1, explain: 'Revierte el Deployment a la plantilla de la revisión anterior.' },
  ],
};
