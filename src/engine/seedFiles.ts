// Ficheros iniciales del Cloud Shell (directorio home del usuario).
import type { FsDir, FsNode } from './types';

export const SAMPLE_FILES: Record<string, string> = {
  'README.md': `# Bienvenido a tu Cloud Shell simulado

Este directorio home se conserva entre sesiones (como el recurso compartido
de archivos del Cloud Shell real).

Comandos útiles:
  az --help                Ayuda de Azure CLI
  az group list -o table   Lista los grupos de recursos
  ls ~/samples             Proyectos de ejemplo para los laboratorios
  code <fichero>           Abre el editor integrado
  help                     Lista de comandos disponibles en este shell

Carpetas de ejemplo:
  samples/web-estatica   Web estática (Storage / App Service)
  samples/app-node       App Node.js con Dockerfile, manifiestos de Kubernetes y pipeline
  samples/arm            Plantillas ARM
  samples/bicep          Plantillas Bicep
  samples/terraform      Configuración de Terraform
  samples/scripts        Scripts de automatización con Azure CLI
`,
  'samples/web-estatica/index.html': `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Mi primera web en Azure</title>
</head>
<body>
  <h1>¡Hola desde Azure Storage!</h1>
  <p>Esta página se sirve como sitio web estático.</p>
</body>
</html>
`,
  'samples/web-estatica/404.html': `<!DOCTYPE html>
<html lang="es"><body><h1>404 - Página no encontrada</h1></body></html>
`,
  'samples/app-node/package.json': `{
  "name": "app-node",
  "version": "1.0.0",
  "description": "App de ejemplo para Azure Lab",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node test.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "dotenv": "^17.2.3",
    "express": "^4.21.2"
  }
}
`,
  'samples/app-node/package-lock.json': `{
  "name": "app-node",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "app-node",
      "version": "1.0.0",
      "dependencies": {
        "dotenv": "^17.2.3",
        "express": "^4.21.2"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/dotenv": {
      "version": "17.2.3",
      "resolved": "https://registry.npmjs.org/dotenv/-/dotenv-17.2.3.tgz",
      "license": "BSD-2-Clause"
    },
    "node_modules/express": {
      "version": "4.21.2",
      "resolved": "https://registry.npmjs.org/express/-/express-4.21.2.tgz",
      "license": "MIT"
    }
  }
}
`,
  'samples/app-node/.gitignore': `# Dependencias: se reinstalan con "npm ci" a partir de package-lock.json
node_modules/

# Configuración local y secretos: NUNCA al repositorio
.env
.env.*
!.env.example

# Registros, paquetes generados y ficheros del sistema
npm-debug.log*
*.zip
.DS_Store
`,
  'samples/app-node/server.js': `// Lee el fichero .env si existe (solo en tu ordenador). En Azure, la configuración llega
// como variables de entorno (App Settings) y el .env no debe viajar en el paquete.
require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Cambia este mensaje, vuelve a desplegar y comprueba el resultado con curl
const message = process.env.GREETING || "Hola desde Azure Lab v1";

app.get('/', (req, res) => {
  res.send(\`<h1>\${message}</h1><p>Entorno: \${process.env.APP_ENV || 'local'}</p>\`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => console.log(\`Servidor escuchando en el puerto \${port}\`));
`,
  'samples/app-node/test.js': `// Pruebas mínimas que se ejecutan con "npm test"
const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');

if (!src.includes("/health")) {
  console.error('✖ Falta la ruta /health');
  process.exit(1);
}
console.log('✔ La ruta /health existe');

if (!src.includes("express")) {
  console.error('✖ La app no usa express');
  process.exit(1);
}
console.log('✔ La app usa express');
`,
  'samples/app-node/Dockerfile': `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
`,
  'samples/app-node/.dockerignore': `node_modules
npm-debug.log
.git
.env
*.zip
`,
  'samples/app-node/k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-node
  labels:
    app: app-node
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app-node
  template:
    metadata:
      labels:
        app: app-node
    spec:
      containers:
        - name: app-node
          image: <TU_ACR>.azurecr.io/app-node:v1
          ports:
            - containerPort: 3000
          env:
            - name: APP_ENV
              value: "aks"
`,
  'samples/app-node/k8s/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: app-node
spec:
  type: LoadBalancer
  selector:
    app: app-node
  ports:
    - port: 80
      targetPort: 3000
`,
  'samples/app-node/azure-pipelines.yml': `trigger:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

variables:
  webAppName: '<NOMBRE_DE_TU_WEBAPP>'
  azureSubscription: 'sc-azure-lab'

stages:
  - stage: Build
    displayName: 'Compilar y probar'
    jobs:
      - job: Build
        steps:
          - task: NodeTool@0
            inputs:
              versionSpec: '20.x'
          - script: |
              npm install
              npm test
            displayName: 'npm install y pruebas'
          - task: ArchiveFiles@2
            inputs:
              rootFolderOrFile: '$(System.DefaultWorkingDirectory)'
              includeRootFolder: false
              archiveType: zip
              archiveFile: '$(Build.ArtifactStagingDirectory)/app.zip'
          - publish: '$(Build.ArtifactStagingDirectory)/app.zip'
            artifact: drop

  - stage: Deploy
    displayName: 'Desplegar en App Service'
    dependsOn: Build
    jobs:
      - deployment: DeployWeb
        environment: 'dev'
        strategy:
          runOnce:
            deploy:
              steps:
                - task: AzureWebApp@1
                  inputs:
                    azureSubscription: '$(azureSubscription)'
                    appType: webAppLinux
                    appName: '$(webAppName)'
                    package: '$(Pipeline.Workspace)/drop/app.zip'
`,
  'samples/arm/storage.json': `{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "prefijo": {
      "type": "string",
      "defaultValue": "stlab",
      "maxLength": 11
    },
    "sku": {
      "type": "string",
      "defaultValue": "Standard_LRS",
      "allowedValues": ["Standard_LRS", "Standard_GRS", "Standard_ZRS"]
    },
    "location": {
      "type": "string",
      "defaultValue": "[resourceGroup().location]"
    }
  },
  "variables": {
    "nombreCuenta": "[toLower(concat(parameters('prefijo'), uniqueString(resourceGroup().id)))]"
  },
  "resources": [
    {
      "type": "Microsoft.Storage/storageAccounts",
      "apiVersion": "2023-05-01",
      "name": "[variables('nombreCuenta')]",
      "location": "[parameters('location')]",
      "sku": { "name": "[parameters('sku')]" },
      "kind": "StorageV2",
      "properties": {
        "minimumTlsVersion": "TLS1_2",
        "supportsHttpsTrafficOnly": true,
        "allowBlobPublicAccess": false
      },
      "tags": { "entorno": "dev", "creadoCon": "ARM" }
    }
  ],
  "outputs": {
    "nombreCuenta": {
      "type": "string",
      "value": "[variables('nombreCuenta')]"
    },
    "endpointBlob": {
      "type": "string",
      "value": "[reference(resourceId('Microsoft.Storage/storageAccounts', variables('nombreCuenta'))).primaryEndpoints.blob]"
    }
  }
}
`,
  'samples/arm/storage.parameters.json': `{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "prefijo": { "value": "stprod" },
    "sku": { "value": "Standard_GRS" }
  }
}
`,
  'samples/bicep/main.bicep': `@description('Entorno de despliegue')
@allowed([
  'dev'
  'prod'
])
param entorno string = 'dev'

param location string = resourceGroup().location
param prefijo string = 'lab'

var sufijo = uniqueString(resourceGroup().id)

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-\${prefijo}-\${entorno}'
  location: location
  sku: {
    name: entorno == 'prod' ? 'S1' : 'B1'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: 'app-\${prefijo}-\${entorno}-\${sufijo}'
  location: location
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appSettings: [
        {
          name: 'APP_ENV'
          value: entorno
        }
      ]
    }
  }
  tags: {
    entorno: entorno
  }
}

output url string = 'https://\${web.properties.defaultHostName}'
`,
  'samples/terraform/main.tf': `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# azurerm 4.x necesita el ID de suscripción:
#   export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
provider "azurerm" {
  features {}
}

resource "random_string" "sufijo" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-\${var.prefijo}-\${var.entorno}"
  location = var.location
  tags = {
    entorno   = var.entorno
    creadoCon = "terraform"
  }
}

resource "azurerm_storage_account" "st" {
  name                     = "st\${var.prefijo}\${random_string.sufijo.result}"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = azurerm_resource_group.rg.tags
}
`,
  'samples/terraform/variables.tf': `variable "prefijo" {
  type        = string
  description = "Prefijo para los nombres de recursos"
  default     = "tflab"
}

variable "entorno" {
  type    = string
  default = "dev"
}

variable "location" {
  type    = string
  default = "westeurope"
}
`,
  'samples/terraform/outputs.tf': `output "resource_group_id" {
  value = azurerm_resource_group.rg.id
}

output "storage_account_name" {
  value = azurerm_storage_account.st.name
}
`,
  'samples/scripts/crear-entorno.sh': `#!/bin/bash
# Script de ejemplo: crea un entorno con variables y Azure CLI
set -e
PREFIJO="demo"
LOCATION="westeurope"
RG="rg-\${PREFIJO}-script"

echo "Creando grupo de recursos $RG en $LOCATION..."
az group create --name "$RG" --location "$LOCATION" --tags entorno=dev creadoCon=script -o none

echo "Creando red virtual..."
az network vnet create -g "$RG" -n "vnet-\${PREFIJO}" --address-prefix 10.10.0.0/16 \\
  --subnet-name snet-web --subnet-prefix 10.10.1.0/24 -o none

echo "Listo. Recursos en $RG:"
az resource list -g "$RG" -o table
`,
  'samples/scripts/limpiar.sh': `#!/bin/bash
# Elimina todos los grupos de recursos que empiezan por un prefijo
PREFIJO=\${1:-rg-demo}
for rg in $(az group list --query "[?starts_with(name, '$PREFIJO')].name" -o tsv); do
  echo "Eliminando $rg..."
  az group delete --name "$rg" --yes --no-wait
done
echo "Solicitudes de eliminación enviadas."
`,
  'clouddrive/.keep': '',
};

/** Ficheros de ejemplo añadidos después de crearse algunas nubes: se copian a las existentes si faltan. */
export const LATER_SAMPLE_FILES = ['samples/app-node/.gitignore', 'samples/app-node/package-lock.json'];

/** Añade a un home existente los ficheros indicados que no tenga (nunca sobrescribe los del usuario). */
export function addMissingFiles(root: FsDir, basePath: string, files: Record<string, string>, only: string[]) {
  for (const rel of only) {
    if (files[rel] === undefined) continue;
    const parts = [...basePath.split('/').filter(Boolean), ...rel.split('/')];
    const name = parts.pop()!;
    let cur: FsDir | null = root;
    for (const p of parts) {
      const n: FsNode | undefined = cur.c[p];
      cur = n && n.t === 'd' ? n : null;
      if (!cur) break;
    }
    // Sólo si la carpeta del ejemplo sigue existiendo y el fichero no está.
    if (cur && !cur.c[name]) cur.c[name] = { t: 'f', d: files[rel], mt: Date.now() };
  }
}

export function buildFsFromMap(files: Record<string, string>, basePath: string): FsDir {
  const root: FsDir = { t: 'd', c: {}, mt: Date.now() };
  const ensureDir = (parts: string[]): FsDir => {
    let cur = root;
    for (const p of parts) {
      if (!p) continue;
      let n = cur.c[p];
      if (!n || n.t !== 'd') {
        n = { t: 'd', c: {}, mt: Date.now() };
        cur.c[p] = n;
      }
      cur = n as FsDir;
    }
    return cur;
  };
  const baseParts = basePath.split('/').filter(Boolean);
  ensureDir(baseParts);
  for (const [rel, content] of Object.entries(files)) {
    const parts = [...baseParts, ...rel.split('/')];
    const name = parts.pop()!;
    const dir = ensureDir(parts);
    const file: FsNode = { t: 'f', d: content, mt: Date.now(), x: rel.endsWith('.sh') };
    dir.c[name] = file;
  }
  ensureDir(['tmp']);
  return root;
}
