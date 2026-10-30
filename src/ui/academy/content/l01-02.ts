// Niveles 1 y 2: fundamentos de Azure, portal, Cloud Shell, Azure CLI y Bash.
import type { Level } from '../types';
import { rgCheck } from './helpers';

export const LEVEL1: Level = {
  id: 1,
  slug: 'fundamentos',
  title: 'Primeros pasos en Azure',
  subtitle: 'Qué es la nube, cómo se organiza Azure y tus dos herramientas: el portal y Cloud Shell',
  icon: 'subscription',
  skills: ['Modelos de nube', 'Regiones', 'Suscripciones', 'Grupos de recursos', 'Etiquetas', 'Azure CLI'],
  lessons: [
    {
      id: 'l1-nube',
      title: '¿Qué es la nube y qué es Azure?',
      minutes: 6,
      body: `La **computación en la nube** consiste en usar recursos informáticos (servidores, almacenamiento, bases de datos, redes...) a través de Internet, **bajo demanda** y **pagando sólo por lo que usas**. En lugar de comprar y mantener servidores, se los "alquilas" a un proveedor como Microsoft Azure.

## Ventajas que verás una y otra vez

- **Elasticidad**: añadir o quitar capacidad en minutos (o automáticamente).
- **Pago por uso**: una máquina virtual cuesta por hora; si la apagas (desasignas), dejas de pagar el proceso.
- **Alcance global**: Azure tiene regiones por todo el mundo. Puedes desplegar cerca de tus usuarios.
- **Servicios gestionados**: Azure se encarga del hardware, los parches o las copias de seguridad, según el servicio.

## IaaS, PaaS y SaaS

| Modelo | Tú gestionas | Azure gestiona | Ejemplo |
| --- | --- | --- | --- |
| **IaaS** (infraestructura) | SO, parches, software, datos | Hardware, red, virtualización | Máquinas virtuales |
| **PaaS** (plataforma) | Tu código y tus datos | Todo lo demás | App Service, Azure SQL |
| **SaaS** (software) | Sólo el uso y los datos | Todo | Microsoft 365 |

Cuanto más "arriba" vayas (IaaS → PaaS → SaaS), menos trabajo operativo tienes, a cambio de menos control. Un buen ingeniero DevOps elige el nivel adecuado para cada pieza.

## Modelo de responsabilidad compartida

La seguridad es **compartida**: Azure protege los centros de datos y la infraestructura; tú eres responsable de tus datos, identidades, configuración de acceso y, en IaaS, del sistema operativo. Por ejemplo, si abres el puerto 22 de una VM a todo Internet con una contraseña débil, el problema es tuyo, no de Azure.

## Regiones y zonas de disponibilidad

Una **región** es una ubicación geográfica con uno o varios centros de datos (por ejemplo *West Europe* en Países Bajos o *Spain Central* en Madrid). Muchas regiones tienen **zonas de disponibilidad**: centros de datos separados físicamente dentro de la región, para tolerar fallos. Además, cada región tiene una **región emparejada** para recuperación ante desastres (West Europe ↔ North Europe).

> En este simulador todo ocurre en tu navegador, pero los nombres, las regiones, los comandos y los errores son los de Azure. Lo que aprendas aquí lo podrás usar tal cual en una suscripción real.`,
    },
    {
      id: 'l1-jerarquia',
      title: 'La jerarquía de Azure: inquilino, suscripciones y grupos de recursos',
      minutes: 7,
      body: `Todo en Azure se organiza en niveles. Entenderlos es clave para la seguridad (los permisos se **heredan**) y para los costes.

\`\`\`
Inquilino de Microsoft Entra ID  (tu organización: usuarios, grupos, aplicaciones)
└── Grupos de administración     (opcional: agrupar suscripciones)
    └── Suscripción              (facturación y límite de acceso)
        └── Grupo de recursos    (contenedor lógico de una solución)
            └── Recurso          (VM, cuenta de almacenamiento, web app...)
\`\`\`

## Inquilino (tenant)

Es tu directorio de **Microsoft Entra ID** (antes Azure AD). Contiene las identidades: usuarios, grupos y aplicaciones. En el simulador tu inquilino es **{{domain}}** y tu usuario **{{upn}}**.

## Suscripción

Es la unidad de **facturación** y un **límite de administración**. Una empresa suele tener varias (por ejemplo *Desarrollo* y *Producción*) para separar costes y permisos. Tú tienes dos: *Azure Lab - Desarrollo* y *Azure Lab - Producción*.

## Grupo de recursos

Un **contenedor lógico** para recursos que comparten **ciclo de vida**: se crean, se gestionan y se eliminan juntos. Reglas importantes:

- Todo recurso pertenece a **un único** grupo de recursos.
- Un grupo tiene una región (donde se guardan sus metadatos), pero sus recursos pueden estar en otras regiones.
- **Eliminar un grupo elimina todo lo que contiene.** Por eso es tan útil para los laboratorios: un grupo por práctica y lo borras al terminar.

## Azure Resource Manager (ARM)

Todas las peticiones (portal, CLI, PowerShell, Terraform, pipelines...) pasan por **Azure Resource Manager**, que autentica, autoriza (RBAC), aplica directivas y bloqueos, y registra la operación en el **registro de actividad**. Por eso da igual la herramienta: el resultado es el mismo.

Cada recurso tiene un **identificador único** con esta forma:

\`\`\`
/subscriptions/<id-suscripción>/resourceGroups/<grupo>/providers/Microsoft.Storage/storageAccounts/<nombre>
\`\`\`

## Etiquetas (tags)

Pares \`nombre=valor\` que añades a grupos y recursos para organizarlos: \`entorno=prod\`, \`proyecto=tienda\`, \`centroCoste=marketing\`. Se usan para filtrar, para repartir la factura y en directivas de gobierno.

> **Convención de nombres**: en Azure es habitual usar prefijos por tipo: \`rg-\` (grupo de recursos), \`vm-\`, \`vnet-\`, \`st\` (almacenamiento, sin guiones), \`app-\`, \`kv-\`... Ayuda mucho cuando hay cientos de recursos.`,
    },
    {
      id: 'l1-cli',
      title: 'Cloud Shell y Azure CLI',
      minutes: 8,
      body: `El portal es cómodo para explorar, pero un ingeniero DevOps **automatiza**. Para eso usarás **Azure CLI** (\`az\`) desde **Cloud Shell**, un terminal Bash en el navegador que ya tiene la sesión iniciada con tu cuenta.

Ábrelo con el icono \`>_\` de la barra superior.

## Estructura de los comandos

\`\`\`
az <grupo> [<subgrupo>] <comando> --parametro valor
\`\`\`

Por ejemplo:

\`\`\`bash
az group create --name rg-demo --location westeurope
az storage account list --resource-group rg-demo
az vm start -g rg-demo -n vm-web
\`\`\`

Muchos parámetros tienen forma corta: \`-g\` (\`--resource-group\`), \`-n\` (\`--name\`), \`-l\` (\`--location\`), \`-o\` (\`--output\`).

## Ayuda integrada

No hace falta memorizar nada:

\`\`\`bash
az --help
az group --help
az group create --help
az find "crear máquina virtual"
\`\`\`

## Formatos de salida

Por defecto \`az\` devuelve **JSON** (ideal para scripts). Con \`-o\` / \`--output\` cambias el formato:

\`\`\`bash
az group list -o table
az group list -o tsv
az account show -o yaml
\`\`\`

## Consultas con --query (JMESPath)

\`--query\` filtra y transforma el JSON **antes** de mostrarlo:

\`\`\`bash
az account show --query name -o tsv
az group list --query "[].name" -o tsv
az group list --query "[?location=='westeurope'].{Nombre:name, Region:location}" -o table
\`\`\`

- \`[]\` recorre una lista, \`.name\` toma un campo.
- \`[?condición]\` filtra.
- \`-o tsv\` quita las comillas: perfecto para guardar un valor en una variable.

## Tu cuenta

\`\`\`bash
az account show
az account list -o table
az account set --subscription "Azure Lab - Producción"
\`\`\`

> **Truco**: pulsa \`Tab\` para autocompletar grupos, comandos y parámetros de \`az\`, y \`↑\` para recuperar comandos anteriores.`,
    },
  ],
  exercises: [
    {
      id: 'e1-portal-rg',
      title: 'Tu primer grupo de recursos (portal)',
      summary: 'Crea un grupo de recursos desde el portal y etiquétalo.',
      difficulty: 'Fácil',
      minutes: 5,
      scenario: `Vas a preparar el espacio de trabajo de este curso. Usa el **portal** (no Cloud Shell) para crear un grupo de recursos y etiquetarlo, igual que harías en tu primer día en una empresa.`,
      steps: [
        {
          id: 'rg',
          title: 'Crea el grupo de recursos rg-nivel1 en la región West Europe',
          detail: 'Menú del portal → **Grupos de recursos** → **Crear**. Suscripción: *Azure Lab - Desarrollo*. Región: *(Europa) West Europe*.',
          hint: 'En la página de inicio también tienes el acceso **Crear un recurso** → *Grupos de recursos*.',
          check: (c) => rgCheck(c, 'rg-nivel1', 'westeurope'),
        },
        {
          id: 'tag',
          title: 'Añade la etiqueta entorno = aprendizaje',
          detail: 'Abre el grupo de recursos → **Etiquetas** → nombre `entorno`, valor `aprendizaje` → **Aplicar**.',
          check: (c) => (c.rg('rg-nivel1')?.tags?.entorno?.toLowerCase() === 'aprendizaje' ? true : 'La etiqueta entorno=aprendizaje todavía no está en rg-nivel1.'),
        },
        {
          id: 'activity',
          title: 'Revisa el registro de actividad del grupo',
          detail: 'En el grupo de recursos abre **Registro de actividad**: verás quién creó el grupo y quién cambió las etiquetas. Después vuelve a **Información general** y abre la **Vista JSON**.',
          hint: 'Este paso se completa cuando el grupo tiene sus operaciones registradas y ya lleva la etiqueta.',
          check: (c) => c.s.activityLog.some((e) => e.resourceId.toLowerCase().endsWith('/resourcegroups/rg-nivel1')) && c.rg('rg-nivel1')?.tags?.entorno?.toLowerCase() === 'aprendizaje',
        },
      ],
      solution: `1. **Grupos de recursos** → **Crear** → nombre \`rg-nivel1\`, región *West Europe* → **Revisar y crear** → **Crear**.
2. En el grupo → **Etiquetas** → \`entorno\` = \`aprendizaje\` → **Aplicar**.
3. **Registro de actividad** muestra "Crear o actualizar grupo de recursos" y "Actualizar etiquetas del grupo de recursos".

En la pestaña *Revisar y crear* del asistente verás el comando equivalente:

\`\`\`bash
az group create -n rg-nivel1 -l westeurope --tags entorno=aprendizaje
\`\`\``,
      wrapUp: 'Fíjate en que el asistente del portal te enseña el comando de Azure CLI equivalente: el portal y la CLI hablan con la misma API (Azure Resource Manager).',
    },
    {
      id: 'e1-cli',
      title: 'Hola, Azure CLI',
      summary: 'Consulta tu cuenta, crea y elimina un grupo de recursos desde Cloud Shell.',
      difficulty: 'Fácil',
      minutes: 10,
      scenario: `Ahora repite lo mismo **sin tocar el portal**: todo desde Cloud Shell con \`az\`. Es la base de toda la automatización que vendrá.`,
      steps: [
        {
          id: 'show',
          title: 'Muestra tu cuenta activa con az account show',
          detail: 'Abre Cloud Shell (`>_` en la barra superior) y ejecuta:\n\n```bash\naz account show\n```',
          check: (c) => c.ran(/^az account show/),
        },
        {
          id: 'table',
          title: 'Lista los grupos de recursos en formato tabla',
          detail: '```bash\naz group list -o table\n```',
          check: (c) => c.ran(/az group list.*(-o|--output)\s+table/),
        },
        {
          id: 'create',
          title: 'Crea rg-cli-nivel1 en North Europe con la CLI',
          detail: '```bash\naz group create --name rg-cli-nivel1 --location northeurope\n```',
          check: (c) => (c.ran(/az group create.*rg-cli-nivel1/) && c.ran(/az group create.*northeurope/) ? true : c.ran(/az group create/) ? rgCheck(c, 'rg-cli-nivel1', 'northeurope') : 'Créalo con az group create desde Cloud Shell.'),
        },
        {
          id: 'query',
          title: 'Obtén sólo los nombres de los grupos con --query',
          detail: '```bash\naz group list --query "[].name" -o tsv\n```',
          hint: 'La expresión `[].name` recorre la lista y se queda con el campo `name` de cada grupo.',
          check: (c) => c.ran(/az group list.*--query/),
        },
        {
          id: 'delete',
          title: 'Elimina rg-cli-nivel1',
          detail: '```bash\naz group delete --name rg-cli-nivel1 --yes\n```\n\nSin `--yes`, la CLI te pedirá confirmación.',
          check: (c) => (c.ran(/az group delete/) && !c.rg('rg-cli-nivel1') ? true : c.rg('rg-cli-nivel1') ? 'rg-cli-nivel1 todavía existe.' : 'Elimínalo con az group delete.'),
        },
      ],
      solution: `\`\`\`bash
az account show
az group list -o table
az group create --name rg-cli-nivel1 --location northeurope
az group list --query "[].name" -o tsv
az group delete --name rg-cli-nivel1 --yes
\`\`\``,
      wrapUp: '¡Ya hablas con Azure desde la línea de comandos! Mantén `rg-nivel1`: lo usarás de nuevo.',
    },
  ],
  quiz: [
    { q: '¿Qué modelo de servicio es una máquina virtual de Azure?', options: ['SaaS', 'PaaS', 'IaaS', 'FaaS'], answer: 2, explain: 'Con una VM gestionas el sistema operativo y el software: es infraestructura como servicio (IaaS).' },
    { q: '¿Qué ocurre al eliminar un grupo de recursos?', options: ['Sólo se borra el grupo, los recursos pasan a otro', 'Se eliminan el grupo y todos sus recursos', 'Azure lo impide si tiene recursos', 'Se archiva durante 30 días'], answer: 1, explain: 'Eliminar un grupo de recursos elimina todo su contenido (salvo que un bloqueo lo impida).' },
    { q: '¿Cuál es la unidad de facturación en Azure?', options: ['El inquilino', 'El grupo de recursos', 'La suscripción', 'La región'], answer: 2, explain: 'La factura se genera por suscripción.' },
    { q: '¿Qué hace `--query "[].name" -o tsv` en `az group list`?', options: ['Filtra los grupos por nombre', 'Devuelve sólo los nombres, sin comillas', 'Cambia el nombre de los grupos', 'Ordena por nombre'], answer: 1, explain: 'JMESPath `[].name` toma el campo name de cada elemento y `-o tsv` lo muestra como texto plano.' },
    { q: '¿Qué servicio procesa todas las peticiones de administración (portal, CLI, Terraform...)?', options: ['Azure Monitor', 'Azure Resource Manager', 'Microsoft Entra ID', 'Azure Policy'], answer: 1, explain: 'ARM es la capa de administración común: autentica, autoriza, aplica directivas y registra cada operación.' },
  ],
};

export const LEVEL2: Level = {
  id: 2,
  slug: 'bash',
  title: 'Linux y Bash para la nube',
  subtitle: 'Domina la terminal: ficheros, tuberías, variables y scripts que automatizan Azure',
  icon: 'shell',
  skills: ['Sistema de ficheros', 'Tuberías', 'Variables', 'Scripts', 'jq', 'JSON'],
  lessons: [
    {
      id: 'l2-ficheros',
      title: 'Moverte por el sistema de ficheros',
      minutes: 6,
      body: `Casi toda la infraestructura cloud (VMs, contenedores, agentes de CI) corre en **Linux**, y la herramienta universal para manejarla es **Bash**. Cloud Shell es un Linux con Bash.

## Orientarte

\`\`\`bash
pwd              # ¿dónde estoy?
ls               # qué hay aquí
ls -la           # incluidos los ocultos, con permisos y tamaños
cd ~/samples     # ir a un directorio (~ es tu carpeta personal)
cd ..            # subir un nivel
tree ~/samples   # ver el árbol
\`\`\`

## Crear, copiar, mover y borrar

\`\`\`bash
mkdir -p proyectos/web       # -p crea también los directorios intermedios
touch notas.txt              # crea un fichero vacío
cp notas.txt copia.txt
mv copia.txt proyectos/
rm proyectos/copia.txt
rm -r proyectos              # borra un directorio y su contenido (¡cuidado!)
\`\`\`

## Ver y editar ficheros

\`\`\`bash
cat ~/samples/README.md      # mostrar todo
head -n 5 fichero            # primeras líneas
tail -n 20 fichero           # últimas líneas
code fichero.txt             # abre el editor de Cloud Shell (Ctrl+S guarda)
\`\`\`

## Rutas

- **Absolutas**: empiezan por \`/\` → \`/home/{{user}}/samples\`
- **Relativas**: desde donde estás → \`samples/app-node\`
- \`~\` = tu directorio personal, \`.\` = el actual, \`..\` = el padre.

## Permisos

\`ls -l\` muestra cosas como \`-rwxr-xr--\`: lectura (r), escritura (w) y ejecución (x) para el propietario, el grupo y el resto. Para poder ejecutar un script necesitas el permiso \`x\`:

\`\`\`bash
chmod +x script.sh
./script.sh
\`\`\``,
    },
    {
      id: 'l2-tuberias',
      title: 'Tuberías, redirecciones y variables',
      minutes: 7,
      body: `La filosofía Unix: **pequeñas herramientas que se combinan**. La salida de un comando puede ser la entrada de otro.

## Tuberías |

\`\`\`bash
cat server.js | grep GREETING          # filtra líneas
az group list -o tsv | wc -l           # cuenta grupos
ls -l | sort -k5 -n | tail -3          # los 3 ficheros más grandes
\`\`\`

## Redirecciones

\`\`\`bash
echo "hola" > saludo.txt     # escribe (sobrescribe)
echo "adiós" >> saludo.txt   # añade al final
az group list > grupos.json  # guarda la salida de un comando
comando 2> errores.txt       # guarda los errores (stderr)
comando > todo.txt 2>&1      # salida y errores juntos
\`\`\`

## Variables

\`\`\`bash
RG=rg-demo
LOCATION=westeurope
az group create -n $RG -l $LOCATION
echo "Creado $RG en $LOCATION"
\`\`\`

Sin espacios alrededor del \`=\`. Usa comillas dobles si el valor tiene espacios: \`NOMBRE="Mi app"\`.

## Sustitución de comandos $( )

Guarda la salida de un comando en una variable. Es **el patrón más usado** con Azure CLI:

\`\`\`bash
SUB_ID=$(az account show --query id -o tsv)
RG_ID=$(az group show -n rg-nivel1 --query id -o tsv)
echo "El id es $RG_ID"
\`\`\`

## Encadenar: && y ||

\`\`\`bash
mkdir web && cd web          # sólo entra si mkdir funcionó
az group show -n rg-x || echo "No existe"
\`\`\`

## JSON con jq

\`--query\` cubre casi todo, pero \`jq\` es la navaja suiza del JSON:

\`\`\`bash
az group list | jq '.[].name'
az group list | jq -r '.[] | select(.location=="westeurope") | .name'
\`\`\``,
    },
    {
      id: 'l2-scripts',
      title: 'Scripts de Bash: automatiza lo repetitivo',
      minutes: 7,
      body: `Un **script** es un fichero con comandos que se ejecutan en orden. Es el primer paso de la automatización (y la base de muchos pipelines de CI/CD).

\`\`\`bash
#!/bin/bash
# crear-entorno.sh — crea un grupo de recursos con etiquetas
set -e                       # para en cuanto un comando falle

RG=\${1:-rg-script}           # primer argumento o valor por defecto
LOCATION=westeurope

echo "Creando $RG en $LOCATION..."
az group create -n "$RG" -l "$LOCATION" --tags creadoPor=script -o none
echo "Listo: $(az group show -n "$RG" --query id -o tsv)"
\`\`\`

- La primera línea (\`#!/bin/bash\`, *shebang*) indica el intérprete.
- \`set -e\` evita seguir ejecutando tras un error (muy recomendable en automatización).
- \`$1\`, \`$2\`... son los argumentos; \`\${1:-valor}\` da un valor por defecto.

## Ejecutarlo

\`\`\`bash
chmod +x crear-entorno.sh
./crear-entorno.sh rg-pruebas
# o bien, sin permiso de ejecución:
bash crear-entorno.sh rg-pruebas
\`\`\`

## Condiciones y bucles

\`\`\`bash
if az group show -n "$RG" > /dev/null 2>&1; then
  echo "Ya existe"
else
  az group create -n "$RG" -l westeurope
fi

for entorno in dev test prod; do
  az group create -n "rg-app-$entorno" -l westeurope -o none
done
\`\`\`

> Los scripts deben ser **idempotentes** siempre que se pueda: ejecutarlos dos veces no debería romper nada. Muchos comandos \`az ... create\` ya lo son (si existe, lo actualizan).`,
    },
  ],
  exercises: [
    {
      id: 'e2-ficheros',
      title: 'Explorando Cloud Shell',
      summary: 'Crea directorios y ficheros, y usa grep, wc y tuberías.',
      difficulty: 'Fácil',
      minutes: 10,
      scenario: 'Te han pasado un proyecto de ejemplo en `~/samples`. Explóralo y prepara una carpeta de trabajo propia.',
      steps: [
        { id: 'dir', title: 'Crea el directorio ~/proyectos/web', detail: '```bash\nmkdir -p ~/proyectos/web\n```', check: (c) => (c.dir('proyectos/web') ? true : 'No existe ~/proyectos/web.') },
        {
          id: 'html',
          title: 'Crea ~/proyectos/web/index.html con un título <h1>',
          detail: 'Puedes usar el editor (`code ~/proyectos/web/index.html`) o una redirección:\n\n```bash\necho "<h1>Mi primera web en Azure</h1>" > ~/proyectos/web/index.html\n```',
          check: (c) => (/<h1/i.test(c.file('proyectos/web/index.html') ?? '') ? true : 'El fichero no existe o no contiene una etiqueta <h1>.'),
        },
        { id: 'wc', title: 'Cuenta las líneas de ~/samples/app-node/server.js con wc', detail: '```bash\nwc -l ~/samples/app-node/server.js\n```', check: (c) => c.ran(/\bwc\b.*-l/) },
        {
          id: 'grep',
          title: 'Busca qué variable de entorno usa la app (GREETING) con grep',
          detail: '```bash\ngrep -rn "process.env" ~/samples/app-node\n```',
          hint: '`grep -r` busca de forma recursiva y `-n` muestra el número de línea.',
          check: (c) => c.ran(/\bgrep\b/),
        },
        { id: 'pipe', title: 'Usa una tubería: lista ~/samples y cuenta las entradas', detail: '```bash\nls ~/samples | wc -l\n```', check: (c) => c.ran(/\|\s*wc/) },
      ],
      solution: `\`\`\`bash
mkdir -p ~/proyectos/web
echo "<h1>Mi primera web en Azure</h1>" > ~/proyectos/web/index.html
wc -l ~/samples/app-node/server.js
grep -rn "process.env" ~/samples/app-node
ls ~/samples | wc -l
\`\`\``,
    },
    {
      id: 'e2-script',
      title: 'Tu primer script de automatización',
      summary: 'Escribe un script con variables que cree un grupo de recursos y ejecútalo.',
      difficulty: 'Media',
      minutes: 15,
      scenario: 'Tu equipo crea a mano los grupos de recursos de cada proyecto y siempre se olvidan las etiquetas. Escribe un script reutilizable.',
      steps: [
        {
          id: 'file',
          title: 'Crea ~/scripts/crear-rg.sh con shebang, set -e y az group create',
          detail: 'Ábrelo con `code ~/scripts/crear-rg.sh` (crea antes la carpeta con `mkdir -p ~/scripts`). Debe empezar por `#!/bin/bash`, usar `set -e` y una variable para el nombre del grupo.',
          hint: 'Mira el ejemplo de la lección 3 o `~/samples/scripts/crear-entorno.sh`.',
          check: (c) => {
            const f = c.file('scripts/crear-rg.sh');
            if (!f) return 'No existe ~/scripts/crear-rg.sh.';
            if (!f.startsWith('#!')) return 'Falta el shebang (#!/bin/bash) en la primera línea.';
            if (!/set -e/.test(f)) return 'Añade set -e.';
            if (!/az group create/.test(f)) return 'El script debe crear el grupo con az group create.';
            if (!/\$\{?\w+/.test(f)) return 'Usa al menos una variable ($RG...).';
            return true;
          },
        },
        {
          id: 'tags',
          title: 'Haz que el script añada la etiqueta creadoPor=script',
          check: (c) => (/--tags[^\n]*creadoPor=script/.test(c.file('scripts/crear-rg.sh') ?? '') ? true : 'Añade --tags creadoPor=script al az group create del script.'),
        },
        { id: 'chmod', title: 'Dale permiso de ejecución con chmod +x', detail: '```bash\nchmod +x ~/scripts/crear-rg.sh\n```', check: (c) => c.ran(/chmod\s+(\+x|[0-7]*[1357][0-7]{2}|u\+x)/) },
        {
          id: 'run',
          title: 'Ejecútalo para crear rg-script (con la etiqueta)',
          detail: '```bash\n~/scripts/crear-rg.sh rg-script\n```',
          check: (c) => {
            if (!c.ran(/crear-rg\.sh/)) return 'Ejecuta el script.';
            const g = c.rg('rg-script');
            if (!g) return 'El grupo rg-script todavía no existe.';
            return g.tags?.creadoPor === 'script' ? true : 'rg-script existe pero no tiene la etiqueta creadoPor=script.';
          },
        },
      ],
      solution: `\`\`\`bash
mkdir -p ~/scripts
cat > ~/scripts/crear-rg.sh <<'EOF'
#!/bin/bash
set -e
RG=\${1:-rg-script}
LOCATION=\${2:-westeurope}
az group create -n "$RG" -l "$LOCATION" --tags creadoPor=script -o none
echo "Grupo $RG creado en $LOCATION"
EOF
chmod +x ~/scripts/crear-rg.sh
~/scripts/crear-rg.sh rg-script
\`\`\``,
      wrapUp: 'Este patrón (script + variables + `set -e`) es exactamente lo que ejecutará más adelante un pipeline de Azure DevOps.',
    },
    {
      id: 'e2-json',
      title: 'Datos JSON: --query, variables y jq',
      summary: 'Extrae información de Azure y guárdala en variables y ficheros.',
      difficulty: 'Media',
      minutes: 10,
      scenario: 'Para automatizar necesitas sacar datos concretos (ids, nombres, IPs) de las respuestas JSON de Azure.',
      steps: [
        { id: 'save', title: 'Guarda la lista de grupos en ~/grupos.json', detail: '```bash\naz group list > ~/grupos.json\n```', check: (c) => { try { return Array.isArray(JSON.parse(c.file('grupos.json') ?? 'x')) ? true : 'grupos.json no contiene una lista JSON.'; } catch { return 'No existe ~/grupos.json o no es JSON válido.'; } } },
        { id: 'jq', title: 'Extrae los nombres con jq', detail: '```bash\njq -r \'.[].name\' ~/grupos.json\n```', check: (c) => c.ran(/\bjq\b/) },
        {
          id: 'var',
          title: 'Guarda el id de rg-script en una variable con $( ) y muéstralo',
          detail: '```bash\nRG_ID=$(az group show -n rg-script --query id -o tsv)\necho $RG_ID\n```',
          check: (c) => c.ran(/=\$\(az .*--query/) || c.ran(/\w+=\$\(az\b/) ? true : 'Usa VARIABLE=$(az ... --query ... -o tsv).',
        },
        { id: 'filter', title: 'Lista sólo los grupos de westeurope en formato tabla', detail: '```bash\naz group list --query "[?location==\'westeurope\'].name" -o table\n```', check: (c) => c.ran(/az group list.*--query.*\?/) },
      ],
      solution: `\`\`\`bash
az group list > ~/grupos.json
jq -r '.[].name' ~/grupos.json
RG_ID=$(az group show -n rg-script --query id -o tsv)
echo $RG_ID
az group list --query "[?location=='westeurope'].name" -o table
\`\`\``,
      wrapUp: 'Puedes limpiar: `az group delete -n rg-script --yes --no-wait`.',
    },
  ],
  quiz: [
    { q: '¿Qué hace `set -e` al principio de un script?', options: ['Activa el modo depuración', 'Detiene el script si un comando falla', 'Exporta todas las variables', 'Ejecuta el script como root'], answer: 1, explain: 'Con set -e el script termina en cuanto un comando devuelve un código de error.' },
    { q: '¿Cuál es la forma correcta de guardar el id de un grupo en una variable?', options: ['RG_ID = az group show -n rg --query id', 'RG_ID=$(az group show -n rg --query id -o tsv)', 'set RG_ID az group show', 'export $(az group show)'], answer: 1, explain: 'Sin espacios alrededor del = y con sustitución de comandos $( ). -o tsv quita las comillas.' },
    { q: '¿Qué diferencia hay entre > y >>?', options: ['Ninguna', '> añade y >> sobrescribe', '> sobrescribe y >> añade al final', '>> redirige los errores'], answer: 2, explain: '> crea o sobrescribe el fichero; >> añade al final.' },
    { q: 'Para ejecutar ./script.sh necesitas...', options: ['Permiso de ejecución (chmod +x)', 'Ser root', 'Que tenga extensión .exe', 'Compilarlo antes'], answer: 0, explain: 'El fichero necesita el bit de ejecución; también puedes ejecutarlo con bash script.sh.' },
    { q: '`cmd1 && cmd2` ejecuta cmd2...', options: ['Siempre', 'Sólo si cmd1 falla', 'Sólo si cmd1 tiene éxito', 'En paralelo con cmd1'], answer: 2, explain: '&& encadena sólo si el anterior terminó bien; || sólo si falló.' },
  ],
};
