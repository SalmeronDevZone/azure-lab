// Niveles 6 y 7: identidad y seguridad; App Service y bases de datos.
import type { Level } from '../types';
import type { CheckCtx } from '../checks';
import { T, rgCheck, kvRefResolved, siteUrl, findTable } from './helpers';
import { envFor, deployContent } from '../../../engine/services/web';
import { TEMPLATES } from '../../../engine/services/devops';
import { getState, portalPrincipal } from '../../../engine/store';
import { APP_SERVICE_SKUS } from '../../../engine/catalog';
import { ciEq, ipToInt } from '../../../engine/util';
import { recordSets, rsKey } from '../../../engine/providers/dns';
import { sbData } from '../../../engine/providers/servicebus';

const laura = (c: CheckCtx) => c.s.users.find((u) => u.userPrincipalName.toLowerCase().startsWith('laura@'));
const grpOps = (c: CheckCtx) => c.s.groups.find((g) => g.displayName.toLowerCase() === 'grp-operaciones');
const kv6 = (c: CheckCtx) => c.one(T.kv, c.inRg('rg-nivel6'));
const zone7 = (c: CheckCtx) => c.one(T.dns, (r) => c.inRg('rg-nivel7')(r) && r.name === 'tienda-lab.com');
const sb7 = (c: CheckCtx) => c.one(T.sb, c.inRg('rg-nivel7'));
const urgentes7 = (c: CheckCtx) => {
  const ns = sb7(c);
  return ns ? sbData(ns).topics.pedidos?.subscriptions.urgentes : undefined;
};

export const LEVEL6: Level = {
  id: 6,
  slug: 'identidad',
  title: 'Identidad y seguridad',
  subtitle: 'Microsoft Entra ID, control de acceso (RBAC), identidades administradas y Key Vault',
  icon: 'keyvault',
  skills: ['Entra ID', 'Usuarios y grupos', 'RBAC', 'Mínimo privilegio', 'Key Vault', 'Identidad administrada'],
  lessons: [
    {
      id: 'l6-entra',
      title: 'Microsoft Entra ID: identidades',
      minutes: 6,
      body: `**Microsoft Entra ID** es el servicio de identidad de Azure. Responde a la pregunta **"¿quién eres?"** (autenticación). Contiene:

- **Usuarios**: personas, con su UPN (\`laura@{{domain}}\`) y contraseña / MFA.
- **Grupos**: conjuntos de usuarios (y otras identidades). Los permisos se asignan a grupos, no a personas sueltas.
- **Registros de aplicaciones** y **entidades de servicio** (*service principals*): identidades para software (scripts, pipelines, aplicaciones). Se autentican con un secreto, un certificado o federación (OIDC).
- **Identidades administradas**: entidades de servicio que Azure crea y rota por ti para un recurso (VM, web app, AKS...). Sin secretos que guardar.

\`\`\`bash
az ad user create --display-name "Laura Ops" --user-principal-name laura@{{domain}} --password "L4b-P@ssw0rd!"
az ad group create --display-name grp-operaciones --mail-nickname grp-operaciones
az ad group member add -g grp-operaciones --member-id $(az ad user show --id laura@{{domain}} --query id -o tsv)
az ad sp create-for-rbac --name sp-despliegue --role Contributor --scopes /subscriptions/{{sub}}/resourceGroups/rg-nivel6
\`\`\`

> El último comando devuelve \`appId\`, \`password\` y \`tenant\`: son credenciales. Trátalas como un secreto (en un pipeline van en una conexión de servicio o en Key Vault, nunca en el código).`,
    },
    {
      id: 'l6-rbac',
      title: 'Control de acceso basado en roles (RBAC)',
      minutes: 8,
      body: `RBAC responde a **"¿qué puedes hacer?"** (autorización). Una **asignación de rol** une tres piezas:

\`\`\`
QUIÉN (entidad de seguridad)  +  QUÉ (definición de rol)  +  DÓNDE (ámbito)
grp-operaciones                   Reader                        /subscriptions/.../resourceGroups/rg-nivel6
\`\`\`

## Roles integrados más usados

| Rol | Puede |
| --- | --- |
| **Owner** (Propietario) | Todo, incluido dar permisos a otros |
| **Contributor** (Colaborador) | Crear y gestionar recursos, **pero no** dar permisos |
| **Reader** (Lector) | Ver, sin cambiar nada |
| **User Access Administrator** | Gestionar el acceso (asignaciones) |
| Roles específicos | *Virtual Machine Contributor*, *Storage Blob Data Reader*, *Key Vault Secrets User*, *AcrPull*... |

## Herencia

Un rol asignado en la **suscripción** se hereda en todos sus grupos y recursos; uno en el **grupo de recursos**, en todos sus recursos. Asigna siempre en el ámbito **más bajo** posible.

## Plano de control frente a plano de datos

Los roles como Owner o Contributor gestionan **recursos** (crear una cuenta de almacenamiento, un almacén de claves...). Leer **los datos** (blobs, secretos) requiere roles de datos (*Storage Blob Data ...*, *Key Vault Secrets ...*). Por eso un Owner no puede leer un secreto si no se le asigna un rol de datos.

\`\`\`bash
RG_ID=$(az group show -n rg-nivel6 --query id -o tsv)
az role assignment create --assignee $(az ad group show -g grp-operaciones --query id -o tsv) --role Reader --scope $RG_ID
az role assignment list -g rg-nivel6 -o table
\`\`\`

## Principio de mínimo privilegio

Da sólo los permisos necesarios, en el ámbito necesario, durante el tiempo necesario. Un pipeline que sólo despliega una web app no necesita ser Contributor de toda la suscripción.`,
    },
    {
      id: 'l6-kv',
      title: 'Key Vault e identidades administradas',
      minutes: 8,
      body: `**Azure Key Vault** guarda **secretos** (contraseñas, cadenas de conexión, tokens), **claves** de cifrado y **certificados**, con auditoría de cada acceso.

## Modelos de permisos

- **RBAC de Azure (recomendado)**: roles *Key Vault Secrets Officer* (leer y escribir secretos) y *Key Vault Secrets User* (sólo leer), asignados en IAM.
- **Directivas de acceso** (heredado): permisos definidos dentro del almacén.

\`\`\`bash
az keyvault create -g rg-nivel6 -n kv-{{user}}-01 --enable-rbac-authorization true
az role assignment create --assignee {{upn}} --role "Key Vault Secrets Officer" \\
  --scope $(az keyvault show -n kv-{{user}}-01 --query id -o tsv)
az keyvault secret set --vault-name kv-{{user}}-01 -n DbPassword --value "S3cr3t0-L4b"
az keyvault secret show --vault-name kv-{{user}}-01 -n DbPassword --query value -o tsv
\`\`\`

## Eliminación temporal

Un secreto o almacén eliminado se conserva (90 días por defecto) y se puede **recuperar**. Con la **protección de purga**, nadie puede borrarlo definitivamente antes de tiempo.

## La pieza clave: identidad administrada + referencia a Key Vault

¿Cómo lee una aplicación un secreto sin tener otra contraseña para acceder al almacén? Con una **identidad administrada**:

1. Activa la identidad de la web app: \`az webapp identity assign\`.
2. Dale a esa identidad el rol **Key Vault Secrets User** en el almacén.
3. En la configuración de la app, usa una **referencia**:

\`\`\`
DB_PASSWORD = @Microsoft.KeyVault(SecretUri=https://kv-{{user}}-01.vault.azure.net/secrets/DbPassword/)
\`\`\`

App Service resuelve la referencia con su identidad y tu código recibe el valor en \`process.env.DB_PASSWORD\`. **Cero secretos en el código o en la configuración.**`,
    },
  ],
  exercises: [
    {
      id: 'e6-rbac',
      title: 'Equipo de operaciones con mínimo privilegio',
      summary: 'Usuario, grupo y asignaciones de rol en el ámbito de un grupo de recursos.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Laura entra en el equipo de operaciones. Debe poder ver los recursos de `rg-nivel6` y administrar sus máquinas virtuales, pero nada más (ni otras suscripciones ni dar permisos).',
      steps: [
        { id: 'rg', title: 'Crea el grupo de recursos rg-nivel6', check: (c) => rgCheck(c, 'rg-nivel6') },
        { id: 'user', title: 'Crea la usuaria laura@{{domain}} en Microsoft Entra ID', check: (c) => (laura(c) ? true : 'No existe ningún usuario laura@...') },
        { id: 'group', title: 'Crea el grupo grp-operaciones y añade a Laura', check: (c) => { const g = grpOps(c); if (!g) return 'No existe el grupo grp-operaciones.'; const u = laura(c); return u && g.members.includes(u.id) ? true : 'Laura no es miembro de grp-operaciones.'; } },
        { id: 'reader', title: 'Asigna al grupo el rol Reader en rg-nivel6', check: (c) => { const g = grpOps(c); return g && c.hasRole(g.id, 'Reader', '/resourcegroups/rg-nivel6') ? true : 'grp-operaciones no tiene Reader en rg-nivel6.'; } },
        { id: 'vmc', title: 'Asigna al grupo el rol Virtual Machine Contributor en rg-nivel6', check: (c) => { const g = grpOps(c); return g && c.hasRole(g.id, 'Virtual Machine Contributor', '/resourcegroups/rg-nivel6') ? true : 'grp-operaciones no tiene Virtual Machine Contributor en rg-nivel6.'; } },
        { id: 'noowner', title: 'Comprueba que el grupo NO tiene Owner ni Contributor en la suscripción', check: (c) => { const g = grpOps(c); if (!g) return false; const bad = c.roleAssignments((a) => a.principalId === g.id && ['Owner', 'Contributor'].includes(a.roleDefinitionName) && !a.scope.toLowerCase().includes('/resourcegroups/')); return bad.length ? 'El grupo tiene Owner/Contributor a nivel de suscripción: quítalo.' : c.ran(/role assignment list/) || 'Revisa sus roles con az role assignment list --assignee <id-grupo> --all -o table'; } },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel6 -l westeurope
DOMINIO=$(az account show --query user.name -o tsv | cut -d@ -f2)
az ad user create --display-name "Laura Ops" --user-principal-name laura@$DOMINIO --password "L4b-P@ssw0rd!"
az ad group create --display-name grp-operaciones --mail-nickname grp-operaciones
az ad group member add -g grp-operaciones --member-id $(az ad user show --id laura@$DOMINIO --query id -o tsv)
GRP=$(az ad group show -g grp-operaciones --query id -o tsv)
RG_ID=$(az group show -n rg-nivel6 --query id -o tsv)
az role assignment create --assignee $GRP --role Reader --scope $RG_ID
az role assignment create --assignee $GRP --role "Virtual Machine Contributor" --scope $RG_ID
az role assignment list --assignee $GRP --all -o table
\`\`\`
En el portal: **Microsoft Entra ID** → Usuarios / Grupos, y en el grupo de recursos → **Control de acceso (IAM)** → *Agregar asignación de roles*.`,
    },
    {
      id: 'e6-kv',
      title: 'Guarda secretos en Key Vault',
      summary: 'Almacén con RBAC, rol de datos para ti y un secreto.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'La contraseña de la base de datos está escrita en un fichero de configuración. Muévela a Key Vault.',
      steps: [
        { id: 'kv', title: 'Crea un almacén de claves en rg-nivel6 con el modelo RBAC', check: (c) => { const kv = kv6(c); if (!kv) return 'No hay ningún almacén de claves en rg-nivel6.'; return kv.properties.enableRbacAuthorization ? true : 'El almacén debe usar el modelo de permisos RBAC.'; } },
        { id: 'denied', title: 'Intenta crear un secreto antes de tener permisos (verás Forbidden)', check: (c) => c.tried(/keyvault secret set/) || 'Prueba az keyvault secret set ... para ver el error.' },
        { id: 'role', title: 'Asígnate el rol Key Vault Secrets Officer en el almacén', check: (c) => { const kv = kv6(c); return kv && c.hasRole(c.me.objectId, 'Key Vault Secrets Officer', kv.name) ? true : 'No tienes Key Vault Secrets Officer en el almacén.'; } },
        { id: 'secret', title: 'Crea el secreto DbPassword', check: (c) => { const kv = kv6(c); const sec = kv?.data?.secrets?.DbPassword; return sec && !sec.deleted ? true : 'No existe el secreto DbPassword.'; } },
        { id: 'read', title: 'Lee el valor del secreto desde la CLI', check: (c) => c.ran(/keyvault secret show/) || 'Usa az keyvault secret show ... --query value -o tsv' },
      ],
      solution: `\`\`\`bash
KV=kv-$RANDOM
az keyvault create -g rg-nivel6 -n $KV --enable-rbac-authorization true
az keyvault secret set --vault-name $KV -n DbPassword --value "S3cr3t0-L4b"   # Forbidden
az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Key Vault Secrets Officer" --scope $(az keyvault show -n $KV --query id -o tsv)
az keyvault secret set --vault-name $KV -n DbPassword --value "S3cr3t0-L4b"
az keyvault secret show --vault-name $KV -n DbPassword --query value -o tsv
\`\`\``,
    },
    {
      id: 'e6-mi',
      title: 'Una app sin contraseñas (identidad administrada)',
      summary: 'La web app lee el secreto de Key Vault con su identidad administrada.',
      difficulty: 'Difícil',
      minutes: 20,
      scenario: 'Despliega una web app que reciba la contraseña de la base de datos como variable de entorno **sin** que nadie copie el valor: App Service la leerá de Key Vault con su propia identidad.',
      steps: [
        { id: 'app', title: 'Crea un plan y una web app (Node 20) en rg-nivel6', check: (c) => (c.site('rg-nivel6') ? true : 'No hay ninguna web app en rg-nivel6.') },
        { id: 'identity', title: 'Activa la identidad administrada asignada por el sistema de la web app', check: (c) => (c.site('rg-nivel6')?.identity?.principalId ? true : 'La web app no tiene identidad administrada.') },
        { id: 'role', title: 'Da a la identidad de la app el rol Key Vault Secrets User en el almacén', check: (c) => { const site = c.site('rg-nivel6'); const kv = kv6(c); if (!site?.identity?.principalId || !kv) return false; return c.hasRole(site.identity.principalId, 'Key Vault Secrets User', kv.name) || c.hasRole(site.identity.principalId, 'Key Vault Secrets Officer', kv.name) ? true : 'La identidad de la app no tiene permiso de lectura de secretos en el almacén.'; } },
        { id: 'ref', title: 'Crea la configuración DB_PASSWORD con una referencia a Key Vault que se resuelva', detail: 'Valor: `@Microsoft.KeyVault(SecretUri=https://<almacén>.vault.azure.net/secrets/DbPassword/)`', check: (c) => { const site = c.site('rg-nivel6'); if (!site) return false; if (!(site.properties.siteConfig?.appSettings ?? []).some((x: any) => x.name === 'DB_PASSWORD')) return 'Falta la configuración DB_PASSWORD.'; return kvRefResolved(site) ? true : 'La referencia no se resuelve: revisa la URI del secreto, la identidad y el rol.'; } },
      ],
      solution: `\`\`\`bash
KV=$(az keyvault list -g rg-nivel6 --query "[0].name" -o tsv)
az appservice plan create -g rg-nivel6 -n plan-nivel6 --sku B1 --is-linux
APP=app-secretos-$RANDOM
az webapp create -g rg-nivel6 -p plan-nivel6 -n $APP --runtime "NODE:20-lts"
PRINCIPAL=$(az webapp identity assign -g rg-nivel6 -n $APP --query principalId -o tsv)
az role assignment create --assignee $PRINCIPAL --role "Key Vault Secrets User" --scope $(az keyvault show -n $KV --query id -o tsv)
az webapp config appsettings set -g rg-nivel6 -n $APP --settings "DB_PASSWORD=@Microsoft.KeyVault(SecretUri=https://$KV.vault.azure.net/secrets/DbPassword/)"
\`\`\`
En el portal, en **Variables de entorno** de la app verás "Referencia de Key Vault resuelta".`,
      wrapUp: 'Este patrón (identidad administrada + RBAC + referencia a Key Vault) es el estándar para no tener secretos en aplicaciones ni en pipelines.',
    },
  ],
  quiz: [
    { q: '¿Qué diferencia hay entre Contributor y Owner?', options: ['Ninguna', 'Contributor no puede asignar roles a otros', 'Owner no puede borrar recursos', 'Contributor sólo lee'], answer: 1, explain: 'Contributor gestiona recursos pero no el acceso; Owner además puede asignar roles.' },
    { q: 'Asignas Reader en la suscripción. ¿Qué ocurre en sus grupos de recursos?', options: ['Nada', 'Se hereda en todos', 'Sólo en los nuevos', 'Hay que repetirlo en cada grupo'], answer: 1, explain: 'Las asignaciones se heredan hacia abajo en la jerarquía.' },
    { q: 'Eres Owner. ¿Por qué no puedes leer un secreto de un Key Vault con RBAC?', options: ['Owner está prohibido en Key Vault', 'Leer secretos es plano de datos y requiere Key Vault Secrets User/Officer', 'Hay que esperar 24 h', 'Key Vault no admite RBAC'], answer: 1, explain: 'Los roles de administración no incluyen acciones de datos sobre secretos.' },
    { q: '¿Qué ventaja tiene una identidad administrada?', options: ['Es gratuita y no caduca nunca', 'Azure gestiona sus credenciales: no hay secretos que guardar ni rotar', 'Da permisos de Owner automáticamente', 'Funciona fuera de Azure'], answer: 1, explain: 'Las credenciales las gestiona y rota Azure; sólo asignas roles a la identidad.' },
    { q: '¿Dónde deberían asignarse los permisos de un equipo?', options: ['A cada persona individualmente', 'A un grupo de Entra ID', 'Al inquilino entero', 'En el código de la aplicación'], answer: 1, explain: 'Asignar a grupos simplifica las altas y bajas de personas.' },
  ],
};

export const LEVEL7: Level = {
  id: 7,
  slug: 'paas',
  title: 'App Service y bases de datos',
  subtitle: 'PaaS: despliega aplicaciones sin servidores que administrar, con ranuras, escalado y Azure SQL',
  icon: 'webapp',
  skills: ['App Service', 'Planes', 'Despliegue zip', 'Variables de entorno', 'Ranuras', 'Azure SQL', 'Azure DNS', 'Service Bus'],
  lessons: [
    {
      id: 'l7-appservice',
      title: 'App Service: planes y aplicaciones',
      minutes: 7,
      body: `**Azure App Service** hospeda aplicaciones web y APIs (Node.js, Python, .NET, Java, PHP o contenedores) sin que gestiones servidores: Azure parchea el sistema operativo, balancea el tráfico y reinicia lo que falle.

## Plan + aplicación

- El **plan de App Service** es la "granja" de máquinas: región, sistema operativo, nivel de precios y número de instancias. **Pagas el plan**, tengas una app o diez.
- La **aplicación web** es tu código ejecutándose en el plan, con su URL \`https://<nombre>.azurewebsites.net\` (nombre único global).

| Nivel | Para | Ranuras | Autoescalado |
| --- | --- | --- | --- |
| F1 (gratis) | Pruebas | No | No |
| B1-B3 (básico) | Desarrollo, apps pequeñas | No | No |
| S1-S3 (estándar) | Producción | Sí (5) | Sí |
| P1v3+ (premium) | Producción exigente | Sí (20) | Sí |

\`\`\`bash
az appservice plan create -g rg-nivel7 -n plan-web --sku B1 --is-linux
az webapp create -g rg-nivel7 -p plan-web -n app-{{user}}-01 --runtime "NODE:20-lts"
\`\`\`

## Desplegar el código

La forma más directa es un **zip** con la aplicación. App Service (con su motor Oryx) detecta el lenguaje, ejecuta \`npm install\` y arranca la app.

\`\`\`bash
cd ~/samples/app-node
zip -r app.zip . -x ".env" "node_modules/*"    # sin secretos locales ni dependencias
unzip -l app.zip                              # revisa qué viaja ANTES de desplegar
az webapp deploy -g rg-nivel7 -n app-{{user}}-01 --src-path app.zip --type zip
\`\`\`

> El \`-x\` no es un detalle: \`zip -r\` mete también los ficheros ocultos, como \`.env\`, y Azure no filtra nada por ti. Lo verás a fondo en la lección «Qué viaja en un despliegue».

Otras opciones: Azure Pipelines / GitHub Actions (lo verás en el nivel 11), imágenes de contenedor, Git local, FTP...

## Diagnóstico

\`\`\`bash
az webapp log tail -g rg-nivel7 -n app-{{user}}-01    # registros en directo
az webapp browse -g rg-nivel7 -n app-{{user}}-01      # abrir en el navegador
\`\`\``,
    },
    {
      id: 'l7-config',
      title: 'Configuración, ranuras de implementación y escalado',
      minutes: 8,
      body: `## Variables de entorno (configuración de la aplicación)

El código no debe llevar valores que cambian entre entornos (URLs, cadenas de conexión, *feature flags*). Se configuran en la app y llegan como **variables de entorno** (twelve-factor app):

\`\`\`bash
az webapp config appsettings set -g rg-nivel7 -n <app> --settings GREETING="Hola desde producción" ENTORNO=prod
\`\`\`

En Node.js: \`process.env.GREETING\`. Cambiar la configuración reinicia la app, pero **no** requiere redesplegar.

## Ranuras de implementación (deployment slots)

Una **ranura** es otra instancia de tu app con su propia URL (\`<app>-staging.azurewebsites.net\`). El flujo típico:

1. Despliegas la nueva versión en **staging**.
2. La pruebas (o la "calientas").
3. **Intercambias** (*swap*) staging ↔ producción: el cambio es instantáneo y sin caída. Si algo va mal, vuelves a intercambiar.

\`\`\`bash
az webapp deployment slot create -g rg-nivel7 -n <app> --slot staging
az webapp deploy -g rg-nivel7 -n <app> --slot staging --src-path app.zip --type zip
az webapp deployment slot swap -g rg-nivel7 -n <app> --slot staging --target-slot production
\`\`\`

Los valores marcados como **configuración de ranura** (*sticky*, \`--slot-settings\`) se quedan en su ranura al intercambiar (p. ej. la cadena de conexión a la base de datos de pruebas).

Necesitas un plan **Standard (S1)** o superior.

## Escalado

- **Vertical (scale up)**: cambiar de nivel del plan (B1 → S1 → P1v3): más CPU/RAM y más funciones.
- **Horizontal (scale out)**: más instancias, manualmente o con **escalado automático** por métricas (CPU, peticiones).

\`\`\`bash
az appservice plan update -g rg-nivel7 -n plan-web --sku S1
az appservice plan update -g rg-nivel7 -n plan-web --number-of-workers 3
\`\`\``,
    },
    {
      id: 'l7-paquete',
      title: 'Qué viaja en un despliegue: .env, App Settings y el paquete',
      minutes: 7,
      body: `**¿Se borra el \`.env\` al desplegar? No.** Azure no filtra nada por ti: lo que va dentro del paquete llega a \`/home/site/wwwroot\` tal cual. Es uno de los errores más comunes (y más caros) de quien empieza.

## Dos mundos de configuración

| | En tu ordenador | En Azure |
| --- | --- | --- |
| Dónde viven los valores | Un fichero \`.env\` | **Configuración de la aplicación** (App Settings) o **Key Vault** |
| Quién los lee | La librería \`dotenv\` los carga al arrancar | App Service los inyecta como variables de entorno |
| ¿Va a Git? | **Nunca** (está en el \`.gitignore\`) | No hay fichero: viven en el recurso |

La app de ejemplo hace \`require('dotenv').config()\`. Si el \`.env\` existe, lo lee; si no, no pasa nada. Y dotenv **nunca sobrescribe** una variable que ya existe: en Azure, una App Setting siempre gana al \`.env\`.

## El problema

Si el \`.env\` viaja en el zip:

- Tu configuración local (\`APP_ENV=local\`, la base de datos de pruebas...) se cuela en producción para toda variable que no esté en App Settings.
- Tus contraseñas quedan en el servidor: cualquiera con acceso a **Kudu** (*Herramientas avanzadas*) o al paquete puede leerlas.

## Cómo lo hace un profesional

\`\`\`bash
cd ~/samples/app-node
zip -r ~/app.zip . -x ".env" "node_modules/*"   # el .env y las dependencias, fuera
unzip -l ~/app.zip                               # revisa la lista de ficheros
az webapp config appsettings set -g rg-nivel7 -n <app> --settings APP_ENV=produccion
\`\`\`

Y mejor aún: despliega **desde un pipeline**. El agente solo tiene lo que está en el commit, así que un \`.env\` ignorado por Git ni siquiera existe allí.

Después de desplegar, el portal te deja comprobarlo: web app → **Herramientas avanzadas (Kudu)** muestra los ficheros que hay en \`/home/site/wwwroot\`. Tienes la lista completa de ficheros y reglas en **Academia → Guía de ficheros**.`,
    },
    {
      id: 'l7-sql',
      title: 'Azure SQL Database',
      minutes: 7,
      body: `**Azure SQL Database** es SQL Server como servicio: Azure se ocupa de la alta disponibilidad, las copias de seguridad automáticas (restauración a un momento dado) y los parches.

## Servidor lógico + bases de datos

- El **servidor lógico** (\`<nombre>.database.windows.net\`, único global) agrupa bases de datos y define el **administrador** y el **firewall**.
- Cada **base de datos** tiene su nivel de rendimiento: modelo DTU (*Basic*, *S0*...) o vCore (*General Purpose*, *serverless*...).

\`\`\`bash
az sql server create -g rg-nivel7 -n sql-{{user}}-01 -l westeurope -u sqladmin -p 'P@ssw0rd-Lab-2026'
az sql db create -g rg-nivel7 -s sql-{{user}}-01 -n tienda --service-objective Basic
\`\`\`

## Firewall

Por defecto **nadie** puede conectarse. Abre sólo lo necesario:

\`\`\`bash
# tu IP de Cloud Shell
az sql server firewall-rule create -g rg-nivel7 -s sql-{{user}}-01 -n cloudshell \\
  --start-ip-address $(curl -s ifconfig.me) --end-ip-address $(curl -s ifconfig.me)
# servicios de Azure (App Service, Functions...) — regla especial 0.0.0.0
az sql server firewall-rule create -g rg-nivel7 -s sql-{{user}}-01 -n AllowAllWindowsAzureIps \\
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
\`\`\`

En producción lo ideal son **endpoints privados** (la base de datos sólo es accesible desde tu VNet) y autenticación con **Entra ID / identidad administrada** en lugar de usuario y contraseña.

## Conectarse

\`\`\`bash
sqlcmd -S sql-{{user}}-01.database.windows.net -d tienda -U sqladmin -P 'P@ssw0rd-Lab-2026' \\
  -Q "CREATE TABLE productos (id INT PRIMARY KEY, nombre NVARCHAR(100), precio DECIMAL(10,2))"
\`\`\``,
    },
    {
      id: 'l7-integracion',
      title: 'Dominios propios (Azure DNS) y mensajería (Service Bus)',
      minutes: 8,
      body: `Dos piezas que aparecen en casi cualquier arquitectura real: un **dominio propio** y un **agente de mensajes** que desacopla servicios.

## Azure DNS

Una **zona DNS** hospeda los registros de un dominio. Azure le asigna cuatro **servidores de nombres**; en tu registrador (donde compraste el dominio) **delegas** el dominio en ellos y, a partir de ahí, administras los registros desde Azure.

| Registro | Para qué sirve |
|---|---|
| A / AAAA | nombre → dirección IP (p. ej. la IP pública de una VM) |
| CNAME | nombre → otro nombre (alias), p. ej. \`www\` → \`miapp.azurewebsites.net\` |
| TXT | texto: verificación de propiedad del dominio, SPF... |
| MX | servidores de correo del dominio |

\`\`\`bash
az network dns zone create -g rg-nivel7 -n tienda-lab.com
APP=$(az webapp list -g rg-nivel7 --query "[0].name" -o tsv)
az network dns record-set cname set-record -g rg-nivel7 -z tienda-lab.com -n www -c $APP.azurewebsites.net
nslookup www.tienda-lab.com
\`\`\`

Para que App Service responda a ese nombre hay que añadirlo como **dominio personalizado**. Azure comprueba que el CNAME existe (así demuestras que el dominio es tuyo) y exige un plan **B1 o superior** (el gratuito F1 no admite dominios propios):

\`\`\`bash
az webapp config hostname add -g rg-nivel7 --webapp-name $APP --hostname www.tienda-lab.com
\`\`\`

> Un CNAME no puede estar en el vértice del dominio (\`@\`) ni convivir con otros registros del mismo nombre. Para \`tienda-lab.com\` «a secas» se usa un registro A.

## Service Bus: colas y temas

Si un servicio llama directamente a otro y el segundo cae o va lento, el primero también falla. Con un **agente de mensajes** el productor deja el mensaje y sigue trabajando; el consumidor lo procesa cuando puede.

- **Cola**: punto a punto. Cada mensaje lo procesa **un único** consumidor (reparto de trabajo).
- **Tema + suscripciones**: publicación/suscripción. Cada suscripción recibe **su propia copia**. Con **filtros SQL** (\`prioridad = 'alta'\`) cada suscripción elige qué mensajes le interesan.
- **Mensajes fallidos (dead-letter)**: si el consumidor falla más veces que el **número máximo de entregas**, el mensaje se aparta a una subcola para revisarlo sin bloquear al resto.

\`\`\`bash
SB=sb-tienda-$RANDOM
az servicebus namespace create -g rg-nivel7 -n $SB --sku Standard
az servicebus queue create -g rg-nivel7 --namespace-name $SB -n facturas --max-delivery-count 3
az servicebus topic create -g rg-nivel7 --namespace-name $SB -n pedidos
\`\`\`

El nivel **Básico** sólo admite colas: los temas necesitan **Estándar**. La CLI administra las entidades; los mensajes los envían y reciben tus aplicaciones (con el SDK) o, para probar, el **Explorador de Service Bus** del portal. En producción, en vez de cadenas de conexión con claves SAS, usa identidades administradas con los roles *Azure Service Bus Data Sender* / *Data Receiver*.`,
    },
  ],
  exercises: [
    {
      id: 'e7-deploy',
      title: 'Despliega la aplicación Node.js',
      summary: 'Plan Linux, web app Node 20 y despliegue de un zip.',
      difficulty: 'Fácil',
      minutes: 12,
      scenario: 'El equipo de desarrollo te pasa la app de `~/samples/app-node`. Publícala en App Service.',
      steps: [
        { id: 'rg', title: 'Crea el grupo de recursos rg-nivel7', check: (c) => rgCheck(c, 'rg-nivel7') },
        { id: 'plan', title: 'Crea un plan de App Service Linux (B1) en rg-nivel7', check: (c) => (c.one(T.plan, (r) => c.inRg('rg-nivel7')(r) && !!r.properties.reserved) ? true : 'No hay un plan Linux en rg-nivel7.') },
        { id: 'app', title: 'Crea una web app con la pila Node 20 LTS', check: (c) => { const s = c.site('rg-nivel7'); if (!s) return 'No hay ninguna web app en rg-nivel7.'; return /NODE/i.test(s.properties.siteConfig?.linuxFxVersion ?? '') ? true : 'La web app debe usar la pila Node.'; } },
        { id: 'deploy', title: 'Despliega ~/samples/app-node como zip', check: (c) => (c.site('rg-nivel7')?.data?.content?.files?.['server.js'] ? true : 'La app todavía no tiene server.js desplegado.') },
        { id: 'http', title: 'Comprueba que la app responde "Hola desde Azure Lab"', check: (c) => { const s = c.site('rg-nivel7'); return s && c.httpOk(siteUrl(s), 'Hola desde Azure Lab') ? true : 'La URL de la app todavía no devuelve el saludo.'; } },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel7 -l westeurope
az appservice plan create -g rg-nivel7 -n plan-web --sku B1 --is-linux
APP=app-node-$RANDOM
az webapp create -g rg-nivel7 -p plan-web -n $APP --runtime "NODE:20-lts"
cd ~/samples/app-node && zip -r ~/app.zip . && cd ~
az webapp deploy -g rg-nivel7 -n $APP --src-path ~/app.zip --type zip
curl https://$APP.azurewebsites.net
\`\`\``,
    },
    {
      id: 'e7-config',
      title: 'Cambia el comportamiento sin redesplegar',
      summary: 'Usa la configuración de la aplicación (variables de entorno).',
      difficulty: 'Fácil',
      minutes: 6,
      scenario: 'Marketing quiere otro saludo en la portada. La app lee `process.env.GREETING`: cámbialo sin tocar el código.',
      steps: [
        { id: 'setting', title: 'Crea la configuración GREETING con el texto que quieras', check: (c) => { const s = c.site('rg-nivel7'); return s && envFor(s).GREETING ? true : 'La app no tiene la variable GREETING.'; } },
        { id: 'http', title: 'Comprueba que la app muestra el nuevo saludo', check: (c) => { const s = c.site('rg-nivel7'); const g = s && envFor(s).GREETING; return s && g && c.httpOk(siteUrl(s), g) ? true : 'La app todavía no muestra el valor de GREETING.'; } },
      ],
      solution: `\`\`\`bash
APP=$(az webapp list -g rg-nivel7 --query "[0].name" -o tsv)
az webapp config appsettings set -g rg-nivel7 -n $APP --settings GREETING="¡Rebajas de otoño!"
curl https://$APP.azurewebsites.net
\`\`\``,
    },
    {
      id: 'e7-env',
      title: 'El .env que llegó a producción',
      summary: 'Configuración local vs. App Settings, un paquete limpio y Kudu para comprobarlo.',
      difficulty: 'Media',
      minutes: 12,
      scenario: 'Marta ha desplegado desde su portátil con `zip -r app.zip .` y su **.env viajó dentro del paquete**. Ahora producción dice «Entorno: portatil-marta» y su contraseña de la base de datos está en el servidor. Arréglalo como lo haría un profesional. *(Al pulsar Empezar, se simula el despliegue de Marta en tu web app de rg-nivel7.)*',
      setup: async () => {
        const site = getState().resources.find((r) => ciEq(r.type, T.site) && ciEq(r.resourceGroup, 'rg-nivel7'));
        if (!site) return;
        const marta = '# Configuración del portátil de Marta\nAPP_ENV=portatil-marta\nDB_PASSWORD=Marta-1234!\n';
        await deployContent(site.id, { ...TEMPLATES['app-node'].files, '.env': marta }, { principal: portalPrincipal(), deployer: 'ZipDeploy', message: 'Despliegue manual desde el portátil de Marta' });
      },
      steps: [
        { id: 'see', title: 'Comprueba con curl que producción muestra «Entorno: portatil-marta»', detail: 'Mira también el portal: web app → **Herramientas avanzadas (Kudu)**. Verás el `.env` de Marta en `/home/site/wwwroot`, con su contraseña.', check: (c) => c.ran(/curl\b.*azurewebsites\.net/) || 'Ejecuta curl contra la URL de tu web app.' },
        { id: 'local', title: 'Crea TU .env local en ~/samples/app-node (por ejemplo, APP_ENV=local)', check: (c) => (/^\s*APP_ENV\s*=/m.test(c.file('samples/app-node/.env') ?? '') ? true : 'No hay ningún ~/samples/app-node/.env con APP_ENV.') },
        { id: 'setting', title: 'Define APP_ENV=produccion en la configuración de la aplicación', check: (c) => { const s = c.site('rg-nivel7'); return s && /^producci[oó]n$/i.test(envFor(s).APP_ENV ?? '') ? true : 'La web app no tiene la configuración APP_ENV=produccion.'; } },
        { id: 'clean', title: 'Vuelve a desplegar un paquete SIN .env (revísalo antes con unzip -l)', check: (c) => { const s = c.site('rg-nivel7'); const ct = s?.data?.content; if (!ct?.files?.['server.js'] || new Date(ct.deployedAt).getTime() < c.since) return 'No ha habido ningún despliegue tuyo desde que empezaste el laboratorio.'; return ct.files['.env'] === undefined ? true : 'El paquete desplegado sigue incluyendo .env: exclúyelo con zip -x ".env".'; } },
        { id: 'http', title: 'Comprueba que la portada muestra «Entorno: produccion»', check: (c) => { const s = c.site('rg-nivel7'); return s && c.httpOk(siteUrl(s), /Entorno: producci[oó]n/i) ? true : 'La portada todavía no muestra «Entorno: produccion».'; } },
      ],
      solution: `\`\`\`bash
APP=$(az webapp list -g rg-nivel7 --query "[0].name" -o tsv)
curl -s https://$APP.azurewebsites.net
cd ~/samples/app-node
printf 'APP_ENV=local\\nGREETING=Hola desde mi portátil\\n' > .env
az webapp config appsettings set -g rg-nivel7 -n $APP --settings APP_ENV=produccion
zip -qr ~/app-limpia.zip . -x ".env" "node_modules/*"
unzip -l ~/app-limpia.zip
az webapp deploy -g rg-nivel7 -n $APP --src-path ~/app-limpia.zip --type zip
curl -s https://$APP.azurewebsites.net
\`\`\`

Fíjate en el orden de prioridad: aunque el \`.env\` de Marta siguiera en el servidor, la App Setting \`APP_ENV\` ganaría, porque dotenv nunca sobrescribe una variable que ya existe. Por eso hay que hacer las dos cosas: configurar Azure y sacar el \`.env\` del paquete.`,
      wrapUp: 'La contraseña de Marta estuvo en el servidor: un profesional la da por comprometida y la cambia (y la guarda en Key Vault). Revisa siempre el paquete con unzip -l antes de desplegar, o mejor: despliega solo desde un pipeline.',
    },
    {
      id: 'e7-slots',
      title: 'Staging y swap sin caída',
      summary: 'Escala a Standard, crea una ranura staging, despliega en ella e intercambia.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Hay una versión nueva y no quieres arriesgarte a romper producción. Usa una ranura de staging.',
      steps: [
        { id: 'scale', title: 'Escala el plan a Standard S1 (o superior)', check: (c) => { const p = c.one(T.plan, c.inRg('rg-nivel7')); const sku = APP_SERVICE_SKUS.find((x) => x.name === p?.sku?.name); return sku && sku.slots > 0 ? true : 'El plan debe ser S1 o superior para tener ranuras.'; } },
        { id: 'slot', title: 'Crea la ranura staging', check: (c) => (c.one(T.slot, (r) => c.inRg('rg-nivel7')(r) && r.name.endsWith('/staging')) ? true : 'No existe la ranura staging.') },
        { id: 'deploy', title: 'Despliega la app en la ranura staging y comprueba su URL', check: (c) => { const sl = c.one(T.slot, (r) => c.inRg('rg-nivel7')(r) && r.name.endsWith('/staging')); return sl && sl.data?.content && c.httpOk(siteUrl(sl)) ? true : 'La ranura staging todavía no tiene la app desplegada y respondiendo.'; } },
        { id: 'swap', title: 'Intercambia staging con producción', check: (c) => (c.s.activityLog.some((e) => e.operationNameValue.includes('slotsswap') && e.resourceId.toLowerCase().includes('/resourcegroups/rg-nivel7/') && new Date(e.time).getTime() >= c.since) ? true : 'Todavía no has hecho el intercambio.') },
      ],
      solution: `\`\`\`bash
APP=$(az webapp list -g rg-nivel7 --query "[0].name" -o tsv)
az appservice plan update -g rg-nivel7 -n plan-web --sku S1
az webapp deployment slot create -g rg-nivel7 -n $APP --slot staging --configuration-source $APP
az webapp deploy -g rg-nivel7 -n $APP --slot staging --src-path ~/app.zip --type zip
curl https://$APP-staging.azurewebsites.net
az webapp deployment slot swap -g rg-nivel7 -n $APP --slot staging --target-slot production
\`\`\``,
      wrapUp: 'Recuerda bajar el plan a B1 (o borrar el grupo) al terminar: el nivel S1 es más caro.',
    },
    {
      id: 'e7-sql',
      title: 'Tu base de datos en Azure SQL',
      summary: 'Servidor lógico, base de datos, firewall y una tabla con datos.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'La tienda necesita una base de datos de productos. Créala, protégela con el firewall y carga los primeros datos.',
      steps: [
        { id: 'server', title: 'Crea un servidor SQL en rg-nivel7', check: (c) => (c.one(T.sqlServer, c.inRg('rg-nivel7')) ? true : 'No hay servidor SQL en rg-nivel7.') },
        { id: 'db', title: 'Crea la base de datos tienda (Basic)', check: (c) => (c.one(T.sqlDb, (r) => c.inRg('rg-nivel7')(r) && r.name.endsWith('/tienda')) ? true : 'No existe la base de datos tienda.') },
        { id: 'blocked', title: 'Intenta conectarte con sqlcmd antes de abrir el firewall (fallará)', check: (c) => c.tried(/sqlcmd/) || 'Prueba a conectarte con sqlcmd.' },
        { id: 'fw', title: 'Crea una regla de firewall para la IP de Cloud Shell (20.31.118.42)', check: (c) => (c.res('Microsoft.Sql/servers/firewallRules', (r) => c.inRg('rg-nivel7')(r) && ipToInt(r.properties.startIpAddress) <= ipToInt('20.31.118.42') && ipToInt(r.properties.endIpAddress) >= ipToInt('20.31.118.42') && r.properties.startIpAddress !== '0.0.0.0').length ? true : 'No hay regla de firewall que incluya 20.31.118.42.') },
        { id: 'table', title: 'Crea la tabla productos e inserta al menos un producto', check: (c) => { const db = c.one(T.sqlDb, (r) => c.inRg('rg-nivel7')(r) && r.name.endsWith('/tienda')); const t = db && findTable(db, 'productos'); return t ? (t.rows.length ? true : 'La tabla productos está vacía.') : 'No existe la tabla productos.'; } },
      ],
      solution: `\`\`\`bash
SQL=sql-$RANDOM
az sql server create -g rg-nivel7 -n $SQL -l westeurope -u sqladmin -p 'P@ssw0rd-Lab-2026'
az sql db create -g rg-nivel7 -s $SQL -n tienda --service-objective Basic
MI_IP=$(curl -s ifconfig.me)
az sql server firewall-rule create -g rg-nivel7 -s $SQL -n cloudshell --start-ip-address $MI_IP --end-ip-address $MI_IP
sqlcmd -S $SQL.database.windows.net -d tienda -U sqladmin -P 'P@ssw0rd-Lab-2026' -Q "CREATE TABLE productos (id INT, nombre NVARCHAR(100), precio DECIMAL(10,2)); INSERT INTO productos VALUES (1, 'Taza Azure', 9.95)"
sqlcmd -S $SQL.database.windows.net -d tienda -U sqladmin -P 'P@ssw0rd-Lab-2026' -Q "SELECT * FROM productos"
\`\`\``,
    },
    {
      id: 'e7-dominio',
      title: 'Tu propio dominio para la web app',
      summary: 'Zona DNS, registro CNAME y dominio personalizado en App Service.',
      difficulty: 'Media',
      minutes: 12,
      scenario: 'La tienda ha registrado el dominio `tienda-lab.com` y quiere publicar la web en `www.tienda-lab.com` en lugar de en `*.azurewebsites.net`. Usa la web app del primer ejercicio de este nivel (su plan debe ser B1 o superior).',
      steps: [
        { id: 'zone', title: 'Crea la zona DNS tienda-lab.com en rg-nivel7', check: (c) => (zone7(c) ? true : 'No existe la zona DNS tienda-lab.com en rg-nivel7.') },
        {
          id: 'cname',
          title: 'Crea el registro CNAME www que apunte al nombre de host de la web app (<app>.azurewebsites.net)',
          check: (c) => {
            const z = zone7(c);
            const rs = z && recordSets(z)[rsKey('CNAME', 'www')];
            if (!rs) return 'No hay un registro CNAME llamado www en la zona.';
            const s = c.site('rg-nivel7');
            return s && rs.records[0]?.toLowerCase() === String(s.properties.defaultHostName).toLowerCase() ? true : `El CNAME apunta a ${rs.records[0]}; debe apuntar a ${s?.properties.defaultHostName ?? 'la web app de rg-nivel7'}.`;
          },
        },
        { id: 'lookup', title: 'Comprueba con nslookup que www.tienda-lab.com resuelve', check: (c) => c.ran(/^(nslookup|dig|host)\b.*www\.tienda-lab\.com/) || 'Ejecuta nslookup www.tienda-lab.com en Cloud Shell.' },
        { id: 'hostname', title: 'Añade www.tienda-lab.com como dominio personalizado de la web app', check: (c) => ((c.site('rg-nivel7')?.properties.hostNames ?? []).includes('www.tienda-lab.com') ? true : 'La web app todavía no tiene el dominio personalizado www.tienda-lab.com.') },
        { id: 'http', title: 'Comprueba que http://www.tienda-lab.com muestra tu aplicación', check: (c) => (c.httpOk('http://www.tienda-lab.com') ? true : 'http://www.tienda-lab.com todavía no devuelve tu aplicación.') },
      ],
      solution: `\`\`\`bash
APP=$(az webapp list -g rg-nivel7 --query "[0].name" -o tsv)
az network dns zone create -g rg-nivel7 -n tienda-lab.com
az network dns record-set cname set-record -g rg-nivel7 -z tienda-lab.com -n www -c $APP.azurewebsites.net
nslookup www.tienda-lab.com
az webapp config hostname add -g rg-nivel7 --webapp-name $APP --hostname www.tienda-lab.com
curl http://www.tienda-lab.com
\`\`\`

Si añades el dominio antes de crear el CNAME, Azure lo rechaza: así comprueba que controlas el dominio. Prueba también \`curl\` antes del \`hostname add\`: verás el 404 «Web Site not found», porque el DNS ya llega a App Service pero ninguna app tiene ese nombre.`,
      wrapUp: 'En Azure real, después añadirías un certificado TLS (certificado administrado gratuito de App Service) para servir el dominio por HTTPS.',
    },
    {
      id: 'e7-servicebus',
      title: 'Desacopla la tienda con Service Bus',
      summary: 'Cola con mensajes fallidos, tema con suscripciones y filtros SQL.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Cuando entra un pedido, el servicio de pedidos lo **publica** y se olvida: almacén procesa todos los pedidos y el equipo de urgencias sólo los de prioridad alta. La facturación se reparte con una **cola**, y un mensaje que falla repetidamente no debe bloquear al resto.',
      steps: [
        { id: 'ns', title: 'Crea un espacio de nombres de Service Bus de nivel Estándar en rg-nivel7', check: (c) => { const ns = sb7(c); if (!ns) return 'No hay ningún espacio de nombres de Service Bus en rg-nivel7.'; return ns.sku?.name === 'Basic' ? 'El nivel Básico no admite temas: actualízalo con az servicebus namespace update --sku Standard.' : true; } },
        { id: 'queue', title: 'Crea la cola facturas con un máximo de 3 entregas', check: (c) => { const ns = sb7(c); const q = ns && sbData(ns).queues.facturas; if (!q) return 'No existe la cola facturas.'; return q.maxDeliveryCount === 3 ? true : `La cola facturas admite ${q.maxDeliveryCount} entregas; deben ser 3 (--max-delivery-count 3).`; } },
        { id: 'topic', title: 'Crea el tema pedidos con dos suscripciones: almacen y urgentes', check: (c) => { const ns = sb7(c); const t = ns && sbData(ns).topics.pedidos; if (!t) return 'No existe el tema pedidos.'; const missing = ['almacen', 'urgentes'].filter((x) => !t.subscriptions[x]); return missing.length ? `Falta la suscripción ${missing.join(' y ')}.` : true; } },
        {
          id: 'filter',
          title: "Haz que urgentes sólo reciba los mensajes con prioridad = 'alta'",
          detail: 'Crea una regla con el filtro SQL y elimina la regla **$Default** (1=1), que deja pasar todo.',
          check: (c) => {
            const sub = urgentes7(c);
            if (!sub) return 'Primero crea la suscripción urgentes.';
            if (!sub.rules.some((r) => /prioridad\s*=\s*'alta'/i.test(r.sql))) return "La suscripción urgentes no tiene una regla con el filtro prioridad = 'alta'.";
            return sub.rules.some((r) => /^(1\s*=\s*1|true)$/i.test(r.sql.trim())) ? 'La regla $Default (1=1) sigue dejando pasar todos los mensajes: elimínala.' : true;
          },
        },
        {
          id: 'send',
          title: 'Desde el Explorador de Service Bus, publica en pedidos un mensaje con prioridad=alta y otro con prioridad=baja',
          detail: 'Portal → tu espacio de nombres → **Explorador de Service Bus**. Añade la propiedad personalizada `prioridad` a cada mensaje.',
          check: (c) => {
            const ns = sb7(c);
            const t = ns && sbData(ns).topics.pedidos;
            const alm = t?.subscriptions.almacen;
            const urg = t?.subscriptions.urgentes;
            if (!alm || !urg) return 'Faltan las suscripciones almacen y urgentes.';
            if (urg.messages.some((m) => m.properties.prioridad !== 'alta')) return 'urgentes tiene mensajes que no son de prioridad alta (¿los enviaste antes de crear el filtro?). Recíbelos para vaciar la suscripción y vuelve a publicar.';
            if (!alm.messages.some((m) => m.properties.prioridad === 'baja')) return 'almacen todavía no tiene ningún mensaje con prioridad=baja.';
            return urg.messages.some((m) => m.properties.prioridad === 'alta') ? true : 'urgentes todavía no ha recibido ningún mensaje con prioridad=alta.';
          },
        },
        { id: 'dlq', title: 'Envía un mensaje a facturas y simula fallos del consumidor hasta que acabe en mensajes fallidos', check: (c) => { const ns = sb7(c); const q = ns && sbData(ns).queues.facturas; return q?.deadLetter.length ? true : 'La cola de mensajes fallidos de facturas sigue vacía. Usa «Simular fallo del consumidor» en el explorador.'; } },
        { id: 'count', title: 'Consulta con la CLI el recuento de mensajes de facturas (countDetails)', check: (c) => c.ran(/servicebus queue show.*facturas/) || 'Ejecuta az servicebus queue show ... -n facturas --query countDetails.' },
      ],
      solution: `\`\`\`bash
SB=sb-tienda-$RANDOM
az servicebus namespace create -g rg-nivel7 -n $SB --sku Standard
az servicebus queue create -g rg-nivel7 --namespace-name $SB -n facturas --max-delivery-count 3
az servicebus topic create -g rg-nivel7 --namespace-name $SB -n pedidos
az servicebus topic subscription create -g rg-nivel7 --namespace-name $SB --topic-name pedidos -n almacen
az servicebus topic subscription create -g rg-nivel7 --namespace-name $SB --topic-name pedidos -n urgentes
az servicebus topic subscription rule create -g rg-nivel7 --namespace-name $SB --topic-name pedidos --subscription-name urgentes -n solo-alta --filter-sql-expression "prioridad = 'alta'"
az servicebus topic subscription rule delete -g rg-nivel7 --namespace-name $SB --topic-name pedidos --subscription-name urgentes -n '$Default'
\`\`\`

Fíjate en las comillas simples de \`'$Default'\`: con comillas dobles, Bash sustituiría \`$Default\` por una variable vacía.

En el portal, abre el espacio de nombres → **Explorador de Service Bus**:

1. Destino *Tema · pedidos*, propiedad \`prioridad = alta\` → **Enviar** (llega a 2 suscripciones).
2. Cambia a \`prioridad = baja\` → **Enviar** (llega sólo a almacen).
3. Destino *Cola · facturas* → **Enviar**. En «Recibir mensajes», origen *Cola · facturas* → **Simular fallo del consumidor** tres veces: el mensaje pasa a la cola de mensajes fallidos.

\`\`\`bash
az servicebus queue show -g rg-nivel7 --namespace-name $SB -n facturas --query countDetails
\`\`\``,
      wrapUp: 'Los mensajes fallidos no se pierden: revísalos (motivo MaxDeliveryCountExceeded), corrige el consumidor y reenvíalos. El nivel Estándar cuesta unos 10 $/mes: borra el espacio de nombres al terminar si no lo vas a usar.',
    },
  ],
  quiz: [
    { q: '¿Qué pagas en App Service?', options: ['Cada petición HTTP', 'El plan de App Service, tenga las apps que tenga', 'Sólo el tráfico de salida', 'Nada si la app está parada'], answer: 1, explain: 'El coste es del plan (instancias × nivel), aunque las apps estén detenidas.' },
    { q: '¿Qué nivel mínimo necesitas para usar ranuras de implementación?', options: ['F1', 'B1', 'S1', 'Cualquiera'], answer: 2, explain: 'Las ranuras están disponibles a partir del nivel Standard.' },
    { q: 'Una configuración marcada como "valor de ranura" (sticky)...', options: ['Se intercambia con la ranura', 'Se queda en su ranura al hacer swap', 'Es secreta', 'Sólo existe en producción'], answer: 1, explain: 'Los valores sticky no viajan con el swap: ideal para cadenas de conexión de cada entorno.' },
    { q: '¿Cómo llega una configuración de la aplicación a tu código Node.js?', options: ['Como un fichero config.json', 'Como variable de entorno (process.env)', 'Por una petición HTTP', 'Hay que leerla de la API de Azure'], answer: 1, explain: 'App Service expone la configuración como variables de entorno.' },
    { q: 'Por defecto, ¿quién puede conectarse a un servidor de Azure SQL?', options: ['Todo Internet', 'Nadie hasta que crees reglas de firewall', 'Sólo Azure', 'Sólo el portal'], answer: 1, explain: 'El firewall del servidor bloquea todas las conexiones hasta que permites IPs concretas.' },
    { q: 'Despliegas con `zip -r app.zip .` y en la carpeta hay un `.env`. ¿Qué pasa con él?', options: ['App Service lo borra al desplegar', 'Viaja en el paquete y queda en /home/site/wwwroot', 'zip ignora los ficheros ocultos', 'Azure lo convierte en App Settings'], answer: 1, explain: 'Azure no filtra nada: lo que va en el paquete llega a producción. Exclúyelo con zip -x ".env" y pon la configuración en App Settings o Key Vault.' },
    { q: 'Hay un `.env` con APP_ENV=local en el servidor y una App Setting APP_ENV=produccion. ¿Qué valor ve una app que usa dotenv?', options: ['local', 'produccion', 'Los dos', 'Ninguno: la app falla'], answer: 1, explain: 'dotenv nunca sobrescribe una variable que ya existe, y App Service crea las App Settings antes de que arranque tu código.' },
    { q: '¿Qué registro DNS usas para que www.contoso.com apunte a miapp.azurewebsites.net?', options: ['A', 'CNAME', 'MX', 'TXT'], answer: 1, explain: 'Un CNAME es un alias de un nombre hacia otro nombre; App Service lo comprueba antes de aceptar el dominio personalizado.' },
    { q: 'Tres servicios deben reaccionar al mismo evento "pedido creado". ¿Qué usas en Service Bus?', options: ['Una cola por servicio y que el productor envíe tres veces', 'Un tema con una suscripción por servicio', 'Una sola cola compartida', 'El nivel Básico'], answer: 1, explain: 'En un tema cada suscripción recibe su propia copia del mensaje; en una cola cada mensaje lo procesa un único consumidor.' },
  ],
};
