// Niveles 3, 4 y 5: almacenamiento, redes y máquinas virtuales.
import type { Level } from '../types';
import type { Resource } from '../../../engine/types';
import type { CheckCtx } from '../checks';
import { T, rgCheck, lastCurlUrl, vmIp, vmPortOpen } from './helpers';
import { ruleValues } from '../../../engine/providers/network';

const containers = (st: Resource) => (st.data?.containers ?? {}) as Record<string, { publicAccess: string; blobs: Record<string, any> }>;

function nsgRule(nsg: Resource, port: string, pred: (r: any) => boolean = () => true) {
  return (nsg.properties.securityRules ?? []).find((r: any) => r.properties.direction === 'Inbound' && r.properties.access === 'Allow' && ruleValues(r, 'destinationPortRange').some((p) => p === port || p === '*' || (p.includes('-') && Number(p.split('-')[0]) <= Number(port) && Number(p.split('-')[1]) >= Number(port))) && pred(r));
}

function subnetOf(c: CheckCtx, vnet: string, subnet: string) {
  const v = c.one(T.vnet, (r) => r.name.toLowerCase() === vnet.toLowerCase());
  return v ? (v.properties.subnets ?? []).find((s: any) => s.name.toLowerCase() === subnet.toLowerCase()) : undefined;
}

export const LEVEL3: Level = {
  id: 3,
  slug: 'almacenamiento',
  title: 'Almacenamiento en Azure',
  subtitle: 'Cuentas de almacenamiento, blobs, webs estáticas y acceso seguro con SAS y Entra ID',
  icon: 'storage',
  skills: ['Cuentas de almacenamiento', 'Redundancia', 'Blobs', 'Web estática', 'SAS', 'RBAC de datos'],
  lessons: [
    {
      id: 'l3-cuentas',
      title: 'Cuentas de almacenamiento y redundancia',
      minutes: 7,
      body: `Una **cuenta de almacenamiento** es el punto de entrada a los servicios de datos de Azure Storage:

| Servicio | Para qué | Ejemplo |
| --- | --- | --- |
| **Blobs** | Objetos y ficheros de cualquier tipo | Imágenes, copias de seguridad, webs estáticas, estado de Terraform |
| **Files** | Recursos compartidos SMB/NFS | Unidad de red compartida entre VMs |
| **Queues** | Mensajes entre componentes | Cola de pedidos pendientes |
| **Tables** | NoSQL clave-valor sencillo | Catálogos, configuraciones |

## El nombre es global

El nombre forma parte de la URL (\`https://<nombre>.blob.core.windows.net\`), así que debe ser **único en todo Azure**: 3-24 caracteres, sólo **minúsculas y números**. Un truco habitual: prefijo + iniciales + número, p. ej. \`stweb{{user}}01\`.

## Rendimiento y redundancia

- **Estándar** (HDD/SSD, uso general) o **Premium** (SSD de baja latencia).
- **Redundancia** (cuántas copias y dónde):

| Opción | Copias | Protege frente a |
| --- | --- | --- |
| **LRS** | 3 en un centro de datos | Fallo de disco/servidor |
| **ZRS** | 3 en zonas distintas | Caída de un centro de datos |
| **GRS** | 6 (3 + 3 en la región emparejada) | Desastre regional |
| **RA-GRS** | Como GRS + lectura en la secundaria | Desastre regional, con lectura |

Más redundancia = más disponibilidad y más coste. Para un laboratorio, LRS; para datos críticos, ZRS/GRS.

\`\`\`bash
az storage account create -n <nombre> -g rg-nivel3 -l westeurope --sku Standard_LRS --kind StorageV2
\`\`\``,
    },
    {
      id: 'l3-blobs',
      title: 'Contenedores, blobs y niveles de acceso',
      minutes: 6,
      body: `Los blobs se guardan dentro de **contenedores** (parecidos a carpetas de primer nivel):

\`\`\`
cuenta (stweb01) → contenedor (imagenes) → blob (logo.png)
https://stweb01.blob.core.windows.net/imagenes/logo.png
\`\`\`

## Operaciones básicas

\`\`\`bash
az storage container create --account-name <cuenta> -n imagenes --auth-mode login
az storage blob upload --account-name <cuenta> -c imagenes -f logo.png -n logo.png --auth-mode login
az storage blob list --account-name <cuenta> -c imagenes --auth-mode login -o table
az storage blob upload-batch --account-name <cuenta> -d imagenes -s ./carpeta --auth-mode login
\`\`\`

## Niveles de acceso

- **Frecuente (Hot)**: datos de uso diario. Almacenar es más caro, leer más barato.
- **Esporádico (Cool)** y **Frío (Cold)**: datos que se leen poco (30/90 días mínimos).
- **Archivo**: el más barato, pero hay que "rehidratar" el blob (horas) antes de leerlo.

Puedes automatizar el paso entre niveles con **directivas de ciclo de vida**.

## Web estática

Una cuenta StorageV2 puede servir una web estática (HTML, CSS, JS) desde un contenedor especial llamado **\`$web\`**, sin servidores:

\`\`\`bash
az storage blob service-properties update --account-name <cuenta> --static-website --index-document index.html
az storage blob upload-batch --account-name <cuenta> -s ~/samples/web-estatica -d '$web'
\`\`\`

La web queda publicada en \`https://<cuenta>.z6.web.core.windows.net\`.`,
    },
    {
      id: 'l3-seguridad',
      title: 'Seguridad: claves, SAS y Microsoft Entra ID',
      minutes: 8,
      body: `Hay tres formas de autorizar el acceso a los datos de una cuenta:

## 1. Claves de acceso (--auth-mode key)

Cada cuenta tiene dos claves que dan **control total** sobre todos los datos. Son cómodas pero peligrosas: quien tenga la clave lo puede todo. Si se filtran, **rótalas** (hay dos para poder cambiar una mientras usas la otra).

## 2. Firmas de acceso compartido (SAS)

Un **token SAS** se añade a la URL y concede acceso **limitado**: a qué (cuenta, contenedor, blob), qué permisos (\`r\` leer, \`w\` escribir, \`l\` listar...), hasta cuándo y desde qué IP.

\`\`\`bash
FIN=$(date -u -d "+2 hours" +%Y-%m-%dT%H:%MZ)
SAS=$(az storage blob generate-sas --account-name <cuenta> -c privado -n informe.txt --permissions r --expiry $FIN -o tsv)
curl "https://<cuenta>.blob.core.windows.net/privado/informe.txt?$SAS"
\`\`\`

Es la forma de compartir un fichero privado sin entregar la clave.

## 3. Microsoft Entra ID + RBAC (--auth-mode login) — recomendado

Usas tu identidad (o la de una aplicación) y Azure comprueba tus **roles de datos**:

- **Storage Blob Data Reader**: leer blobs.
- **Storage Blob Data Contributor**: leer, escribir y borrar.
- **Storage Blob Data Owner**: además, gestionar permisos POSIX (ACL).

> ⚠️ Ser **Owner** de la suscripción te permite administrar la cuenta (plano de control) pero **no** leer los datos con \`--auth-mode login\` (plano de datos). Es una de las confusiones más habituales: necesitas además un rol *Storage Blob Data ...*.

\`\`\`bash
ID=$(az storage account show -n <cuenta> --query id -o tsv)
az role assignment create --assignee {{upn}} --role "Storage Blob Data Contributor" --scope $ID
\`\`\`

Cuando todo el mundo usa Entra ID, puedes **deshabilitar el acceso con clave** (\`--allow-shared-key-access false\`) y reducir mucho el riesgo.`,
    },
  ],
  exercises: [
    {
      id: 'e3-web',
      title: 'Publica una web estática',
      summary: 'Cuenta de almacenamiento + contenedor $web = web publicada sin servidores.',
      difficulty: 'Fácil',
      minutes: 12,
      scenario: 'El departamento de marketing necesita una página de campaña para mañana. Es HTML estático: no necesitas ninguna VM. En `~/samples/web-estatica` tienes la web.',
      steps: [
        { id: 'rg', title: 'Crea el grupo de recursos rg-nivel3', check: (c) => rgCheck(c, 'rg-nivel3') },
        { id: 'st', title: 'Crea una cuenta de almacenamiento StorageV2 (Standard_LRS) en rg-nivel3', detail: 'Elige un nombre único (minúsculas y números), por ejemplo `stweb{{user}}01`.', check: (c) => { const st = c.storage('rg-nivel3'); if (!st) return 'No hay ninguna cuenta de almacenamiento en rg-nivel3.'; return st.kind === 'StorageV2' ? true : 'La cuenta debe ser de tipo StorageV2.'; } },
        { id: 'static', title: 'Habilita el sitio web estático con index.html como documento de índice', check: (c) => (c.storage('rg-nivel3')?.data?.staticWebsite?.enabled ? true : 'El sitio web estático no está habilitado.') },
        { id: 'upload', title: 'Sube los ficheros de ~/samples/web-estatica al contenedor $web', detail: '```bash\naz storage blob upload-batch --account-name <cuenta> -s ~/samples/web-estatica -d \'$web\' --auth-mode key\n```', check: (c) => { const st = c.storage('rg-nivel3'); return st && containers(st)['$web']?.blobs?.['index.html'] ? true : 'No hay index.html en el contenedor $web.'; } },
        { id: 'http', title: 'Comprueba que la web responde (navegador o curl)', detail: 'La URL está en la cuenta → **Sitio web estático** → *Punto de conexión principal*. Desde Cloud Shell: `curl https://<cuenta>.z6.web.core.windows.net`', check: (c) => { const st = c.storage('rg-nivel3'); return st && c.httpOk(st.properties.primaryEndpoints?.web) ? true : 'La web todavía no responde con HTTP 200.'; } },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel3 -l westeurope
ST=stweb$RANDOM
az storage account create -n $ST -g rg-nivel3 -l westeurope --sku Standard_LRS --kind StorageV2
az storage blob service-properties update --account-name $ST --static-website --index-document index.html --auth-mode key
az storage blob upload-batch --account-name $ST -s ~/samples/web-estatica -d '$web' --auth-mode key
curl $(az storage account show -n $ST --query primaryEndpoints.web -o tsv)
\`\`\``,
      wrapUp: 'Una web estática en Storage cuesta céntimos al mes y escala sola. Para un dominio propio con HTTPS se pone delante Azure Front Door o una CDN.',
    },
    {
      id: 'e3-sas',
      title: 'Comparte un fichero privado con SAS',
      summary: 'Contenedor privado, blob sin acceso anónimo y un token SAS de sólo lectura.',
      difficulty: 'Media',
      minutes: 12,
      scenario: 'Tienes que enviar un informe a un proveedor externo. No puede ser público ni puedes darle la clave de la cuenta: genera un enlace temporal de sólo lectura.',
      steps: [
        { id: 'container', title: 'Crea un contenedor privado llamado privado en tu cuenta de rg-nivel3', check: (c) => { const st = c.storage('rg-nivel3'); const ct = st && containers(st).privado; return ct ? (ct.publicAccess === 'off' ? true : 'El contenedor privado no debe permitir acceso anónimo.') : 'No existe el contenedor "privado".'; } },
        { id: 'blob', title: 'Sube un fichero informe.txt al contenedor', detail: '```bash\necho "Ventas Q3: 1.2M" > informe.txt\naz storage blob upload --account-name <cuenta> -c privado -f informe.txt -n informe.txt --auth-mode key\n```', check: (c) => { const st = c.storage('rg-nivel3'); return st && containers(st).privado?.blobs?.['informe.txt'] ? true : 'No hay informe.txt en el contenedor privado.'; } },
        { id: 'anon', title: 'Comprueba que sin token no se puede descargar (curl a la URL del blob)', detail: '```bash\ncurl https://<cuenta>.blob.core.windows.net/privado/informe.txt\n```\nDebes recibir un error XML (ResourceNotFound o PublicAccessNotPermitted).', check: (c) => (c.cmds(['shell', 'typed']).some((x) => /^curl\s/.test(x.cmd) && /\/privado\/informe\.txt/.test(x.cmd) && !/sig=/.test(x.cmd)) ? true : 'Haz un curl a la URL del blob sin token.') },
        { id: 'sas', title: 'Genera un SAS de sólo lectura (permiso r) que caduque en pocas horas', check: (c) => (c.ran(/generate-sas.*--permissions\s+['"]?r['"]?(\s|$)/) ? true : 'Genera el SAS con az storage blob generate-sas ... --permissions r --expiry <fecha>.') },
        { id: 'use', title: 'Descarga el blob con curl usando la URL con el SAS', check: (c) => { const url = lastCurlUrl(c, /informe\.txt\?.*sig=/); return url && c.httpOk(url) ? true : 'Haz curl "https://<cuenta>.blob.core.windows.net/privado/informe.txt?<token>" (entre comillas).'; } },
      ],
      solution: `\`\`\`bash
ST=$(az storage account list -g rg-nivel3 --query "[0].name" -o tsv)
az storage container create --account-name $ST -n privado --auth-mode key
echo "Ventas Q3: 1.2M" > informe.txt
az storage blob upload --account-name $ST -c privado -f informe.txt -n informe.txt --auth-mode key
curl https://$ST.blob.core.windows.net/privado/informe.txt        # falla
FIN=$(date -u -d "+2 hours" +%Y-%m-%dT%H:%MZ)
SAS=$(az storage blob generate-sas --account-name $ST -c privado -n informe.txt --permissions r --expiry $FIN -o tsv)
curl "https://$ST.blob.core.windows.net/privado/informe.txt?$SAS"   # funciona
\`\`\``,
      wrapUp: 'Si regeneras la clave con la que se firmó el SAS, el SAS deja de funcionar al instante: es la forma de revocarlo en caso de emergencia.',
    },
    {
      id: 'e3-entra',
      title: 'Adiós a las claves: acceso con Entra ID',
      summary: 'Asigna un rol de datos, sube un blob con tu identidad y desactiva las claves.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'Auditoría ha detectado que las claves de la cuenta están en varios scripts. Pasa a usar identidades de Entra ID y desactiva el acceso con clave.',
      steps: [
        { id: 'fail', title: 'Intenta listar los blobs con --auth-mode login (verás que falla aunque seas Owner)', check: (c) => c.tried(/storage blob list.*--auth-mode login/) || c.tried(/storage (blob|container) .*--auth-mode login/) },
        { id: 'role', title: 'Asígnate el rol Storage Blob Data Contributor en la cuenta de almacenamiento', check: (c) => { const st = c.storage('rg-nivel3'); return st && c.hasRole(c.me.objectId, 'Storage Blob Data Contributor', st.name) ? true : 'No tienes el rol Storage Blob Data Contributor en la cuenta (ni heredado del grupo).'; } },
        { id: 'login', title: 'Sube un blob usando --auth-mode login', check: (c) => (c.ran(/storage blob upload.*--auth-mode login/) ? true : 'Sube un fichero con az storage blob upload ... --auth-mode login.') },
        { id: 'nokey', title: 'Deshabilita el acceso con clave de cuenta', detail: '```bash\naz storage account update -n <cuenta> -g rg-nivel3 --allow-shared-key-access false\n```', check: (c) => (c.storage('rg-nivel3')?.properties.allowSharedKeyAccess === false ? true : 'El acceso con clave sigue habilitado.') },
      ],
      solution: `\`\`\`bash
ST=$(az storage account list -g rg-nivel3 --query "[0].name" -o tsv)
az storage blob list --account-name $ST -c privado --auth-mode login     # AuthorizationPermissionMismatch
ID=$(az storage account show -n $ST --query id -o tsv)
az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Storage Blob Data Contributor" --scope $ID
echo hola > hola.txt
az storage blob upload --account-name $ST -c privado -f hola.txt -n hola.txt --auth-mode login
az storage account update -n $ST -g rg-nivel3 --allow-shared-key-access false
\`\`\``,
      wrapUp: 'Ahora `--auth-mode key` y los SAS firmados con clave dejan de funcionar en esa cuenta. Es la configuración recomendada en producción.',
    },
  ],
  quiz: [
    { q: '¿Qué redundancia protege frente a la caída de un centro de datos completo dentro de la región?', options: ['LRS', 'ZRS', 'Ninguna', 'Premium'], answer: 1, explain: 'ZRS replica en tres zonas de disponibilidad (centros de datos separados).' },
    { q: 'Eres Owner de la suscripción. ¿Puedes leer blobs con --auth-mode login?', options: ['Sí, Owner lo puede todo', 'No, necesitas un rol de datos como Storage Blob Data Reader', 'Sólo si la cuenta es Premium', 'Sólo desde el portal'], answer: 1, explain: 'Los roles de administración (plano de control) no dan acceso a los datos (plano de datos).' },
    { q: '¿Cuál es la ventaja principal de un token SAS frente a la clave de la cuenta?', options: ['Es más rápido', 'Limita permisos, ámbito y caducidad', 'No caduca nunca', 'Funciona sin Internet'], answer: 1, explain: 'Un SAS concede sólo lo necesario y durante un tiempo limitado.' },
    { q: '¿En qué contenedor se publica una web estática?', options: ['public', 'www', '$web', 'static'], answer: 2, explain: 'Al habilitar el sitio web estático, Azure crea el contenedor $web.' },
    { q: '¿Qué nombre de cuenta de almacenamiento es válido?', options: ['St-Web-01', 'stweb01', 'st_web_01', 'stweb01.prod'], answer: 1, explain: 'Sólo minúsculas y números, entre 3 y 24 caracteres.' },
  ],
};

export const LEVEL4: Level = {
  id: 4,
  slug: 'redes',
  title: 'Redes en Azure',
  subtitle: 'Redes virtuales, subredes, NSG, IP públicas y emparejamiento',
  icon: 'vnet',
  skills: ['VNet', 'CIDR', 'Subredes', 'NSG', 'Peering', 'IP pública'],
  lessons: [
    {
      id: 'l4-vnet',
      title: 'Redes virtuales, subredes y CIDR',
      minutes: 8,
      body: `Una **red virtual (VNet)** es tu red privada en Azure. Los recursos conectados (VMs, AKS, endpoints privados...) se comunican entre sí con IPs privadas.

## Notación CIDR

Un rango se escribe como \`dirección/prefijo\`. El prefijo indica cuántos bits son fijos:

| CIDR | Direcciones | Uso típico |
| --- | --- | --- |
| \`10.0.0.0/16\` | 65 536 | Espacio de una VNet |
| \`10.0.1.0/24\` | 256 | Una subred |
| \`10.0.1.0/27\` | 32 | Subred pequeña |

Usa siempre rangos privados (RFC 1918): \`10.0.0.0/8\`, \`172.16.0.0/12\`, \`192.168.0.0/16\`.

## Subredes

Divides la VNet en **subredes** para separar capas (web, aplicación, datos) y aplicarles reglas distintas. Las subredes deben estar **dentro** del espacio de la VNet y **no solaparse**.

> Azure reserva **5 direcciones** de cada subred (la primera y la última y tres para servicios internos): en un /24 tienes 251 IPs utilizables.

\`\`\`bash
az network vnet create -g rg-nivel4 -n vnet-app --address-prefixes 10.10.0.0/16 \\
  --subnet-name web --subnet-prefixes 10.10.1.0/24
az network vnet subnet create -g rg-nivel4 --vnet-name vnet-app -n datos --address-prefixes 10.10.2.0/24
\`\`\`

## Planifica antes

Cambiar el direccionamiento después es costoso. Evita solapamientos con tu red local y con otras VNets que quieras conectar (peering o VPN): **dos redes con rangos solapados no se pueden emparejar**.`,
    },
    {
      id: 'l4-nsg',
      title: 'Grupos de seguridad de red (NSG)',
      minutes: 8,
      body: `Un **NSG** es un cortafuegos de capa 4 con reglas que **permiten o deniegan** tráfico según origen, destino, puerto y protocolo. Se asocia a una **subred** y/o a una **interfaz de red (NIC)**.

## Cómo se evalúan las reglas

- Cada regla tiene una **prioridad** (100-4096). Se evalúan de **menor a mayor** número y se aplica **la primera que coincide**.
- Hay **reglas predeterminadas** (65000+) que no se pueden borrar:
  - \`AllowVnetInBound\`: tráfico dentro de la VNet permitido.
  - \`AllowAzureLoadBalancerInBound\`.
  - \`DenyAllInBound\`: **todo lo demás desde Internet se deniega**.
- Si hay NSG en la subred **y** en la NIC, el tráfico entrante debe estar permitido en **los dos**.

\`\`\`bash
az network nsg create -g rg-nivel4 -n nsg-web
az network nsg rule create -g rg-nivel4 --nsg-name nsg-web -n allow-http \\
  --priority 100 --direction Inbound --access Allow --protocol Tcp \\
  --source-address-prefixes Internet --destination-port-ranges 80 443
az network vnet subnet update -g rg-nivel4 --vnet-name vnet-app -n web --nsg nsg-web
\`\`\`

## Buenas prácticas

- **Mínimo privilegio**: abre sólo los puertos necesarios y, si puedes, sólo desde orígenes concretos (tu IP, otra subred).
- Nunca abras SSH (22) o RDP (3389) a \`*\` en producción: usa Azure Bastion, VPN o al menos restringe el origen.
- Usa **etiquetas de servicio** (\`Internet\`, \`VirtualNetwork\`, \`AzureLoadBalancer\`...) en lugar de listas de IPs.

## Diagnóstico

\`\`\`bash
az network nic list-effective-nsg -g <rg> -n <nic>     # reglas efectivas de una NIC
az network watcher test-ip-flow ...                     # ¿se permitiría este paquete?
\`\`\``,
    },
    {
      id: 'l4-conectividad',
      title: 'IP públicas, DNS y emparejamiento de redes',
      minutes: 6,
      body: `## IP públicas

Un recurso sólo es accesible desde Internet si tiene una **IP pública** (o está detrás de un equilibrador de carga / gateway que la tenga). Las IP públicas Standard son estáticas y seguras por defecto (requieren NSG que permita el tráfico).

\`\`\`bash
az network public-ip create -g rg-nivel4 -n pip-web --sku Standard --dns-name web{{user}}
\`\`\`

Con \`--dns-name\` obtienes un nombre: \`web{{user}}.westeurope.cloudapp.azure.com\`.

## Emparejamiento (peering)

El **VNet peering** conecta dos redes virtuales a través de la red troncal de Microsoft, con baja latencia y sin pasar por Internet. Es la base de la arquitectura **hub-spoke**: una red central (hub) con servicios compartidos (firewall, VPN, DNS) y redes de aplicación (spokes) emparejadas con ella.

Reglas:

- Hay que crearlo **en los dos sentidos** (A→B y B→A); hasta entonces el estado es *Initiated* y no hay tráfico.
- Los espacios de direcciones **no pueden solaparse**.
- **No es transitivo**: si A↔Hub y Hub↔B, A no habla con B (salvo con un firewall/NVA que enrute).

\`\`\`bash
az network vnet peering create -g rg-nivel4 -n app-a-hub --vnet-name vnet-app \\
  --remote-vnet vnet-hub --allow-vnet-access
az network vnet peering create -g rg-nivel4 -n hub-a-app --vnet-name vnet-hub \\
  --remote-vnet vnet-app --allow-vnet-access
\`\`\``,
    },
  ],
  exercises: [
    {
      id: 'e4-vnet',
      title: 'Diseña una red de dos capas',
      summary: 'Una VNet con subredes separadas para la capa web y la de datos.',
      difficulty: 'Fácil',
      minutes: 10,
      scenario: 'Vas a preparar la red de una aplicación con una capa web (expuesta) y una capa de datos (privada).',
      steps: [
        { id: 'rg', title: 'Crea el grupo de recursos rg-nivel4', check: (c) => rgCheck(c, 'rg-nivel4') },
        { id: 'vnet', title: 'Crea la red virtual vnet-app con el espacio 10.10.0.0/16', check: (c) => { const v = c.one(T.vnet, (r) => r.name === 'vnet-app' && c.inRg('rg-nivel4')(r)); if (!v) return 'No existe vnet-app en rg-nivel4.'; return (v.properties.addressSpace?.addressPrefixes ?? []).includes('10.10.0.0/16') ? true : 'El espacio de direcciones debe ser 10.10.0.0/16.'; } },
        { id: 'web', title: 'Crea la subred web con 10.10.1.0/24', check: (c) => (subnetOf(c, 'vnet-app', 'web')?.properties.addressPrefix === '10.10.1.0/24' ? true : 'Falta la subred web (10.10.1.0/24).') },
        { id: 'datos', title: 'Crea la subred datos con 10.10.2.0/24', check: (c) => (subnetOf(c, 'vnet-app', 'datos')?.properties.addressPrefix === '10.10.2.0/24' ? true : 'Falta la subred datos (10.10.2.0/24).') },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel4 -l westeurope
az network vnet create -g rg-nivel4 -n vnet-app --address-prefixes 10.10.0.0/16 --subnet-name web --subnet-prefixes 10.10.1.0/24
az network vnet subnet create -g rg-nivel4 --vnet-name vnet-app -n datos --address-prefixes 10.10.2.0/24
\`\`\``,
    },
    {
      id: 'e4-nsg',
      title: 'Protege las subredes con NSG',
      summary: 'Reglas de entrada con mínimo privilegio para cada capa.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'La subred web debe aceptar HTTP/HTTPS de Internet. La de datos sólo debe aceptar SQL (1433) desde la subred web.',
      steps: [
        { id: 'nsgweb', title: 'Crea nsg-web con una regla que permita 80 y 443 desde Internet', check: (c) => { const n = c.one(T.nsg, (r) => r.name === 'nsg-web'); if (!n) return 'No existe nsg-web.'; return nsgRule(n, '80') && nsgRule(n, '443') ? true : 'nsg-web debe permitir los puertos 80 y 443 de entrada.'; } },
        { id: 'assocweb', title: 'Asocia nsg-web a la subred web', check: (c) => (String(subnetOf(c, 'vnet-app', 'web')?.properties.networkSecurityGroup?.id ?? '').toLowerCase().endsWith('/nsg-web') ? true : 'La subred web no tiene asociado nsg-web.') },
        { id: 'nsgdatos', title: 'Crea nsg-datos con una regla que permita 1433 sólo desde 10.10.1.0/24', check: (c) => { const n = c.one(T.nsg, (r) => r.name === 'nsg-datos'); if (!n) return 'No existe nsg-datos.'; const r = nsgRule(n, '1433'); if (!r) return 'nsg-datos debe permitir el puerto 1433.'; return ruleValues(r, 'sourceAddressPrefix').every((x) => x === '10.10.1.0/24') ? true : 'El origen de la regla 1433 debe ser sólo 10.10.1.0/24 (la subred web).'; } },
        { id: 'assocdatos', title: 'Asocia nsg-datos a la subred datos', check: (c) => (String(subnetOf(c, 'vnet-app', 'datos')?.properties.networkSecurityGroup?.id ?? '').toLowerCase().endsWith('/nsg-datos') ? true : 'La subred datos no tiene asociado nsg-datos.') },
      ],
      solution: `\`\`\`bash
az network nsg create -g rg-nivel4 -n nsg-web
az network nsg rule create -g rg-nivel4 --nsg-name nsg-web -n allow-web --priority 100 --access Allow --protocol Tcp --source-address-prefixes Internet --destination-port-ranges 80 443
az network vnet subnet update -g rg-nivel4 --vnet-name vnet-app -n web --nsg nsg-web
az network nsg create -g rg-nivel4 -n nsg-datos
az network nsg rule create -g rg-nivel4 --nsg-name nsg-datos -n allow-sql-from-web --priority 100 --access Allow --protocol Tcp --source-address-prefixes 10.10.1.0/24 --destination-port-ranges 1433
az network vnet subnet update -g rg-nivel4 --vnet-name vnet-app -n datos --nsg nsg-datos
\`\`\``,
      wrapUp: 'Observa que no hace falta una regla "denegar todo": la regla predeterminada DenyAllInBound ya bloquea lo que no hayas permitido.',
    },
    {
      id: 'e4-peering',
      title: 'Conecta dos redes (hub-spoke)',
      summary: 'Crea una red hub y empareja ambas redes en los dos sentidos.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'Seguridad va a desplegar un firewall central en una red "hub". Tu red de aplicación debe poder comunicarse con ella.',
      steps: [
        { id: 'hub', title: 'Crea vnet-hub con el espacio 10.0.0.0/16 en rg-nivel4', check: (c) => { const v = c.one(T.vnet, (r) => r.name === 'vnet-hub'); return v ? ((v.properties.addressSpace?.addressPrefixes ?? []).includes('10.0.0.0/16') ? true : 'vnet-hub debe usar 10.0.0.0/16.') : 'No existe vnet-hub.'; } },
        { id: 'p1', title: 'Crea el emparejamiento de vnet-app hacia vnet-hub', check: (c) => (c.one(T.vnet, (r) => r.name === 'vnet-app')?.properties.virtualNetworkPeerings ?? []).some((p: any) => String(p.properties.remoteVirtualNetwork?.id).toLowerCase().endsWith('/vnet-hub')) || 'vnet-app no tiene un emparejamiento hacia vnet-hub.' },
        { id: 'p2', title: 'Crea el emparejamiento inverso y comprueba que el estado es Connected', check: (c) => (c.one(T.vnet, (r) => r.name === 'vnet-app')?.properties.virtualNetworkPeerings ?? []).some((p: any) => p.properties.peeringState === 'Connected') || 'El emparejamiento todavía no está Connected (¿falta el sentido vnet-hub → vnet-app?).' },
      ],
      solution: `\`\`\`bash
az network vnet create -g rg-nivel4 -n vnet-hub --address-prefixes 10.0.0.0/16 --subnet-name compartida --subnet-prefixes 10.0.1.0/24
az network vnet peering create -g rg-nivel4 -n app-a-hub --vnet-name vnet-app --remote-vnet vnet-hub --allow-vnet-access
az network vnet peering create -g rg-nivel4 -n hub-a-app --vnet-name vnet-hub --remote-vnet vnet-app --allow-vnet-access
az network vnet peering list -g rg-nivel4 --vnet-name vnet-app -o table
\`\`\``,
    },
  ],
  quiz: [
    { q: '¿Cuántas direcciones utilizables tiene una subred /24 en Azure?', options: ['256', '254', '251', '128'], answer: 2, explain: 'Azure reserva 5 direcciones de cada subred: 256 - 5 = 251.' },
    { q: 'Una regla de NSG con prioridad 100 permite el puerto 22 y otra con prioridad 200 lo deniega. ¿Qué pasa?', options: ['Se deniega', 'Se permite', 'Error de configuración', 'Depende del protocolo'], answer: 1, explain: 'Se aplica la primera regla que coincide por orden de prioridad (menor número primero).' },
    { q: '¿Qué hace la regla predeterminada DenyAllInBound?', options: ['Bloquea también el tráfico interno de la VNet', 'Deniega el tráfico entrante no permitido por reglas anteriores', 'Se puede borrar', 'Sólo afecta a UDP'], answer: 1, explain: 'Es la última regla (65500): bloquea lo que no se haya permitido antes. AllowVnetInBound (65000) permite el tráfico interno.' },
    { q: 'Hub↔A y Hub↔B están emparejadas. ¿A puede hablar con B directamente?', options: ['Sí, el peering es transitivo', 'No, el peering no es transitivo', 'Sólo si están en la misma región', 'Sólo por IPv6'], answer: 1, explain: 'El emparejamiento no es transitivo; necesitas un peering A↔B o un firewall/NVA en el hub que enrute.' },
    { q: '¿Se pueden emparejar dos VNets con 10.0.0.0/16 cada una?', options: ['Sí', 'No, los espacios no pueden solaparse', 'Sólo en regiones distintas', 'Sí, con NAT automático'], answer: 1, explain: 'El peering exige espacios de direcciones sin solapamiento.' },
  ],
};

export const LEVEL5: Level = {
  id: 5,
  slug: 'maquinas-virtuales',
  title: 'Máquinas virtuales',
  subtitle: 'Despliega, conecta, configura y controla el coste de servidores Linux en Azure',
  icon: 'vm',
  skills: ['VM', 'SSH', 'nginx', 'NSG', 'Desasignar', 'run-command', 'cloud-init'],
  lessons: [
    {
      id: 'l5-anatomia',
      title: 'Anatomía de una máquina virtual',
      minutes: 7,
      body: `Una VM de Azure no es un único recurso, sino varios que trabajan juntos:

\`\`\`
VM (tamaño: CPU/RAM)
├── Disco del SO (y discos de datos)     → Microsoft.Compute/disks
└── Interfaz de red (NIC)                → IP privada en una subred
    ├── IP pública (opcional)
    └── NSG (opcional, en la NIC o en la subred)
\`\`\`

Cuando ejecutas \`az vm create\` sin más, la CLI crea **todo** por ti: VNet, subred, NSG (con SSH abierto), IP pública, NIC y disco.

\`\`\`bash
az vm create -g rg-nivel5 -n vm-web --image Ubuntu2404 --size Standard_B1s \\
  --admin-username azureuser --generate-ssh-keys
\`\`\`

## Tamaños

El tamaño define vCPU, memoria, discos máximos y precio. Familias habituales:

- **B (ampliables)**: baratas, acumulan créditos de CPU. Perfectas para pruebas y webs pequeñas.
- **D (uso general)**, **E (memoria)**, **F (CPU)**, **N (GPU)**.

Puedes cambiar de tamaño después (\`az vm resize\`), con un reinicio.

## Imágenes

Ubuntu, Debian, RHEL, Windows Server... Con alias cortos en la CLI (\`Ubuntu2404\`, \`Debian12\`, \`Win2022Datacenter\`) o la URN completa \`Publisher:Offer:Sku:Version\`.

## Disponibilidad

Una sola VM tiene un SLA limitado. Para alta disponibilidad: varias VMs en **zonas de disponibilidad** detrás de un **equilibrador de carga**, o un **conjunto de escalado (VMSS)**.`,
    },
    {
      id: 'l5-acceso',
      title: 'Acceso seguro: SSH, claves y puertos',
      minutes: 7,
      body: `## Claves SSH en lugar de contraseñas

Con \`--generate-ssh-keys\` la CLI crea (si no existe) el par \`~/.ssh/id_rsa\` / \`~/.ssh/id_rsa.pub\` en tu Cloud Shell y copia la pública en la VM. Conectarte es tan fácil como:

\`\`\`bash
IP=$(az vm show -d -g rg-nivel5 -n vm-web --query publicIps -o tsv)
ssh azureuser@$IP
\`\`\`

La clave privada nunca sale de tu Cloud Shell. Es mucho más seguro que una contraseña.

## Abrir puertos

Por defecto sólo el 22 está permitido (si lo pediste). Para servir una web necesitas abrir el 80:

\`\`\`bash
az vm open-port -g rg-nivel5 -n vm-web --port 80 --priority 1010
\`\`\`

Esto añade una regla al NSG de la VM. Recuerda: si la subred también tiene NSG, también debe permitirlo.

## Administrar sin SSH: run-command

El **agente de Azure** dentro de la VM puede ejecutar scripts como root sin abrir ningún puerto:

\`\`\`bash
az vm run-command invoke -g rg-nivel5 -n vm-web --command-id RunShellScript \\
  --scripts "apt-get update && apt-get install -y nginx"
\`\`\`

## cloud-init: configurar en el primer arranque

Con \`--custom-data\` pasas un script (o un fichero cloud-init) que se ejecuta al crear la VM. Es la forma "inmutable" de configurar servidores: la VM nace ya preparada.

\`\`\`bash
az vm create ... --custom-data cloud-init.sh
\`\`\``,
    },
    {
      id: 'l5-coste',
      title: 'Ciclo de vida y coste: detener no es desasignar',
      minutes: 5,
      body: `Una VM pasa por varios **estados de energía**:

| Estado | ¿Pagas el proceso (CPU/RAM)? | ¿Pagas el disco? | Cómo se llega |
| --- | --- | --- | --- |
| **En ejecución** | Sí | Sí | \`az vm start\` |
| **Detenida** (*Stopped*) | **Sí** | Sí | \`az vm stop\`, \`shutdown\` dentro de la VM |
| **Desasignada** (*Deallocated*) | **No** | Sí | \`az vm deallocate\`, botón *Detener* del portal |

> ⚠️ Apagar la VM desde el sistema operativo o con \`az vm stop\` la deja **detenida pero asignada**: el hardware sigue reservado y **sigues pagando**. Para dejar de pagar el proceso hay que **desasignarla**.

Al desasignar, la IP pública dinámica puede cambiar (usa una IP estática si necesitas conservarla).

## Otras palancas de coste

- **Apagado automático** programado (ideal para entornos de desarrollo).
- **Tamaño adecuado**: Advisor te avisa de VMs infrautilizadas.
- **Reservas** y **plan de ahorro** para cargas estables (hasta ~70 % de descuento).
- **VMs de acceso puntual (Spot)** para cargas que toleran interrupciones.

En este simulador 1 minuto real = 1 hora facturada: mira **Cost Management** después de dejar una VM encendida un rato.`,
    },
  ],
  exercises: [
    {
      id: 'e5-web',
      title: 'Servidor web Linux en Azure',
      summary: 'VM Ubuntu con nginx accesible desde Internet.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Necesitas un servidor web clásico (IaaS) para una aplicación heredada. Despliega una VM Linux con nginx y publícala en el puerto 80.',
      steps: [
        { id: 'rg', title: 'Crea el grupo de recursos rg-nivel5', check: (c) => rgCheck(c, 'rg-nivel5') },
        { id: 'vm', title: 'Crea la VM vm-web (Ubuntu, Standard_B1s, autenticación con clave SSH)', check: (c) => { const vm = c.vm('rg-nivel5', 'vm-web'); if (!vm) return 'No existe vm-web en rg-nivel5.'; if (vm.data?.osType !== 'Linux') return 'vm-web debe ser Linux.'; return c.powerState(vm) === 'running' ? true : `vm-web está ${c.powerState(vm)}.`; } },
        { id: 'nginx', title: 'Instala nginx en la VM (run-command o SSH + sudo apt)', check: (c) => (c.vm('rg-nivel5', 'vm-web')?.data?.services?.nginx === 'active' ? true : 'nginx no está instalado y en ejecución en vm-web.') },
        { id: 'port', title: 'Abre el puerto 80 en el NSG de la VM', check: (c) => { const vm = c.vm('rg-nivel5', 'vm-web'); return vm && vmPortOpen(c, vm, 80) ? true : 'El puerto 80 no está permitido desde Internet.'; } },
        { id: 'http', title: 'Comprueba con curl (o el navegador) que http://<IP-pública> responde', check: (c) => { const vm = c.vm('rg-nivel5', 'vm-web'); const ip = vm && vmIp(c, vm); return ip && c.httpOk(`http://${ip}`) ? true : 'La IP pública de vm-web todavía no responde por HTTP.'; } },
      ],
      solution: `\`\`\`bash
az group create -n rg-nivel5 -l westeurope
az vm create -g rg-nivel5 -n vm-web --image Ubuntu2404 --size Standard_B1s --admin-username azureuser --generate-ssh-keys
az vm run-command invoke -g rg-nivel5 -n vm-web --command-id RunShellScript --scripts "apt-get update && apt-get install -y nginx"
az vm open-port -g rg-nivel5 -n vm-web --port 80 --priority 1010
curl http://$(az vm show -d -g rg-nivel5 -n vm-web --query publicIps -o tsv)
\`\`\``,
    },
    {
      id: 'e5-ssh',
      title: 'Entra por SSH y personaliza la web',
      summary: 'Conéctate a la VM, edita la página de nginx con sudo y compruébalo.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'El cliente quiere ver su propia página de inicio en lugar de la de nginx. Entra en el servidor y cámbiala.',
      steps: [
        { id: 'ssh', title: 'Conéctate por SSH a vm-web desde Cloud Shell', detail: '```bash\nssh azureuser@$(az vm show -d -g rg-nivel5 -n vm-web --query publicIps -o tsv)\n```', check: (c) => c.ran(/^ssh\b.*@/, { source: ['shell', 'typed'] }) || c.tried(/^ssh\b/) || 'Usa ssh azureuser@<IP>.' },
        { id: 'edit', title: 'Dentro de la VM, escribe tu propia /var/www/html/index.html (que contenga "Azure Lab")', detail: 'Necesitas permisos de root:\n\n```bash\necho "<h1>Hola desde Azure Lab</h1>" | sudo tee /var/www/html/index.html\n```', check: (c) => { const vm = c.vm('rg-nivel5', 'vm-web'); const ip = vm && vmIp(c, vm); return ip && c.httpOk(`http://${ip}`, /Azure Lab/i) ? true : 'La página de la VM todavía no contiene "Azure Lab".'; } },
        { id: 'exit', title: 'Sal de la sesión SSH con exit', check: (c) => c.cmds(['typed']).some((x) => /^\s*(exit|logout)\s*$/.test(x.cmd)) || 'Escribe exit para volver a Cloud Shell.' },
      ],
      solution: `\`\`\`bash
ssh azureuser@$(az vm show -d -g rg-nivel5 -n vm-web --query publicIps -o tsv)
echo "<h1>Hola desde Azure Lab</h1>" | sudo tee /var/www/html/index.html
exit
curl http://$(az vm show -d -g rg-nivel5 -n vm-web --query publicIps -o tsv)
\`\`\``,
      wrapUp: 'Cambiar servidores a mano por SSH no escala ni deja rastro. En niveles posteriores lo harás con cloud-init, imágenes de contenedor e infraestructura como código.',
    },
    {
      id: 'e5-coste',
      title: 'Ahorra: detener frente a desasignar',
      summary: 'Comprueba la diferencia entre stop y deallocate.',
      difficulty: 'Fácil',
      minutes: 6,
      scenario: 'Es viernes por la tarde y la VM de pruebas no se usará hasta el lunes. Apágala de forma que no pagues el proceso.',
      steps: [
        { id: 'stop', title: 'Detén vm-web con az vm stop y observa su estado (detenida)', check: (c) => c.ran(/az vm stop/) || 'Ejecuta az vm stop -g rg-nivel5 -n vm-web.' },
        { id: 'status', title: 'Consulta el estado de energía con az vm get-instance-view o az vm show -d', check: (c) => c.ran(/az vm (get-instance-view|show.*-d|list.*-d|show.*--show-details)/) || 'Consulta el estado con az vm show -d ... --query powerState.' },
        { id: 'dealloc', title: 'Desasigna la VM (estado: desasignada)', check: (c) => { const vm = c.vm('rg-nivel5', 'vm-web'); return vm && c.powerState(vm) === 'deallocated' ? true : 'vm-web no está desasignada.'; } },
      ],
      solution: `\`\`\`bash
az vm stop -g rg-nivel5 -n vm-web
az vm show -d -g rg-nivel5 -n vm-web --query powerState -o tsv   # VM stopped (¡sigues pagando!)
az vm deallocate -g rg-nivel5 -n vm-web
az vm show -d -g rg-nivel5 -n vm-web --query powerState -o tsv   # VM deallocated
\`\`\``,
      wrapUp: 'Mira Cost Management o Advisor: las VMs detenidas pero asignadas aparecen como recomendación de ahorro. Cuando termines el nivel, puedes borrar todo con `az group delete -n rg-nivel5 --yes --no-wait`.',
    },
  ],
  quiz: [
    { q: '¿En qué estado dejas de pagar el proceso (CPU/RAM) de una VM?', options: ['Detenida', 'Desasignada', 'Reiniciando', 'En ejecución con 0 % de CPU'], answer: 1, explain: 'Sólo al desasignar se libera el hardware y se deja de facturar el proceso.' },
    { q: '¿Qué crea `az vm create` si no indicas red?', options: ['Nada, falla', 'Sólo la VM', 'VNet, subred, NSG, IP pública, NIC y disco', 'Un equilibrador de carga'], answer: 2, explain: 'La CLI crea automáticamente todos los recursos de red necesarios.' },
    { q: '¿Qué permite `az vm run-command invoke`?', options: ['Ejecutar scripts en la VM sin SSH a través del agente', 'Abrir un escritorio remoto', 'Cambiar el tamaño', 'Copiar ficheros por FTP'], answer: 0, explain: 'run-command usa el agente de Azure para ejecutar scripts como root sin abrir puertos.' },
    { q: 'Tienes NSG en la subred que permite el 80 y NSG en la NIC sin esa regla. ¿Llega el tráfico HTTP?', options: ['Sí', 'No, debe permitirse en ambos', 'Sólo HTTPS', 'Depende del tamaño de la VM'], answer: 1, explain: 'El tráfico entrante se evalúa primero en el NSG de subred y después en el de la NIC: ambos deben permitirlo.' },
    { q: '¿Para qué sirve --custom-data (cloud-init)?', options: ['Para etiquetar la VM', 'Para ejecutar configuración en el primer arranque', 'Para cifrar el disco', 'Para elegir la región'], answer: 1, explain: 'cloud-init configura la VM automáticamente al crearla.' },
  ],
};
