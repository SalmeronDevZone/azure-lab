// Los ficheros que separan a un profesional de un amateur: qué se versiona, qué se despliega y qué nunca debe salir
// de tu ordenador. Lo usan la Guía de ficheros de la Academia, los avisos de la CLI y el explorador de Kudu del portal.

/** si = va · no = nunca · depende = según el caso (ver la regla) · na = no aplica */
export type FileVerdict = 'si' | 'no' | 'depende' | 'na';

export interface FileGuideEntry {
  file: string;
  category: string;
  what: string;
  git: FileVerdict;
  deploy: FileVerdict;
  docker: FileVerdict;
  rule: string;
}

export const FILE_GUIDE: FileGuideEntry[] = [
  // Secretos y configuración
  { file: '.env', category: 'Secretos y configuración', what: 'Variables y secretos de TU entorno local (contraseñas, claves de API, cadenas de conexión).', git: 'no', deploy: 'no', docker: 'no', rule: 'Nadie lo borra por ti: si va en el paquete, llega a Azure. En Azure los valores van en la configuración de la aplicación (App Settings) o en Key Vault.' },
  { file: '.env.example', category: 'Secretos y configuración', what: 'Plantilla con los NOMBRES de las variables que necesita la app, sin valores secretos.', git: 'si', deploy: 'no', docker: 'no', rule: 'Es la documentación de la configuración: quien clone el repo copia este fichero como .env y lo rellena.' },
  { file: 'local.settings.json', category: 'Secretos y configuración', what: 'Configuración local de Azure Functions, con cadenas de conexión reales.', git: 'no', deploy: 'no', docker: 'no', rule: 'La .funcignore que crea func init ya lo excluye. Cada valor debe existir también en la configuración de la Function App.' },
  { file: 'appsettings.json', category: 'Secretos y configuración', what: 'Configuración de una app .NET (niveles de log, URLs, opciones).', git: 'si', deploy: 'si', docker: 'si', rule: 'Sin contraseñas: en local usa User Secrets (dotnet user-secrets) y en Azure, App Settings o Key Vault.' },
  // Node.js
  { file: 'package.json', category: 'Node.js', what: 'Ficha de la app: dependencias, scripts (npm start, npm test) y versión de Node.', git: 'si', deploy: 'si', docker: 'si', rule: 'Declara la versión de Node en "engines" para que Azure y el pipeline usen la misma que tú.' },
  { file: 'package-lock.json', category: 'Node.js', what: 'Versiones EXACTAS de todas las dependencias, incluidas las indirectas.', git: 'si', deploy: 'si', docker: 'si', rule: 'Súbelo siempre: npm ci falla sin él y es lo que garantiza que tu PC, el pipeline y Azure instalan lo mismo.' },
  { file: 'node_modules/', category: 'Node.js', what: 'Las dependencias descargadas: miles de ficheros, distintos según el sistema operativo.', git: 'no', deploy: 'depende', docker: 'no', rule: 'Se reconstruye con npm ci. En App Service, o lo instala el pipeline (en Linux) o activas la compilación en el servidor (SCM_DO_BUILD_DURING_DEPLOYMENT=true). Nunca subas el de tu Windows a un Linux.' },
  { file: 'dist/ · build/', category: 'Node.js', what: 'El resultado de compilar o empaquetar la app (lo que de verdad se ejecuta o se sirve).', git: 'no', deploy: 'si', docker: 'depende', rule: 'Lo genera el pipeline en cada ejecución; nunca se edita ni se sube a mano.' },
  { file: '.npmrc', category: 'Node.js', what: 'Configuración de npm, por ejemplo un registro privado (Azure Artifacts).', git: 'depende', deploy: 'no', docker: 'depende', rule: 'Si lleva un _authToken, no lo subas: en Azure Pipelines usa la tarea npmAuthenticate.' },
  { file: '.nvmrc', category: 'Node.js', what: 'La versión de Node que usa el proyecto (por ejemplo, 20).', git: 'si', deploy: 'na', docker: 'na', rule: 'Evita el «en mi máquina funciona»: todo el equipo usa la misma versión.' },
  // Python
  { file: 'requirements.txt', category: 'Python', what: 'Las dependencias de una app Python.', git: 'si', deploy: 'si', docker: 'si', rule: 'Fija las versiones (flask==3.1.0). App Service las instala con pip al desplegar.' },
  { file: '.venv/ · venv/', category: 'Python', what: 'El entorno virtual local con las librerías instaladas.', git: 'no', deploy: 'no', docker: 'no', rule: 'Se recrea con python -m venv .venv y pip install -r requirements.txt.' },
  { file: '__pycache__/', category: 'Python', what: 'Código compilado temporal de Python.', git: 'no', deploy: 'no', docker: 'no', rule: 'Python lo regenera solo.' },
  // .NET
  { file: 'bin/ · obj/', category: '.NET', what: 'Resultados intermedios de compilar con dotnet build.', git: 'no', deploy: 'no', docker: 'no', rule: 'Se despliega la salida de dotnet publish, generada en el pipeline.' },
  // Contenedores
  { file: 'Dockerfile', category: 'Contenedores', what: 'La receta para construir la imagen del contenedor.', git: 'si', deploy: 'na', docker: 'na', rule: 'Nunca escribas secretos con ENV o ARG: quedan grabados en la imagen y cualquiera los ve con docker history.' },
  { file: '.dockerignore', category: 'Contenedores', what: 'Lo que NO entra en el contexto de docker build.', git: 'si', deploy: 'na', docker: 'na', rule: 'Incluye siempre .env, .git y node_modules: COPY . . copia todo lo demás, y un secreto copiado queda en una capa aunque lo borres después.' },
  { file: 'compose.yaml', category: 'Contenedores', what: 'Varios contenedores juntos en tu ordenador (app + base de datos...).', git: 'si', deploy: 'no', docker: 'na', rule: 'Sin contraseñas escritas: usa variables (${DB_PASSWORD}) que Compose lee de un .env que no se sube.' },
  // Git
  { file: '.gitignore', category: 'Git', what: 'La lista de lo que git no debe versionar.', git: 'si', deploy: 'no', docker: 'no', rule: 'Créalo ANTES del primer commit: no protege lo que ya está versionado (eso se saca con git rm --cached).' },
  { file: '.gitattributes', category: 'Git', what: 'Reglas de finales de línea, ficheros binarios y Git LFS.', git: 'si', deploy: 'no', docker: 'no', rule: 'Con * text=auto evitas cambios fantasma entre Windows (CRLF) y Linux (LF).' },
  { file: '.git/', category: 'Git', what: 'La base de datos del repositorio, con TODO el historial.', git: 'na', deploy: 'no', docker: 'no', rule: 'Nunca la despliegues: con ella se recupera cualquier secreto que se subiera alguna vez.' },
  // Terraform
  { file: '*.tf', category: 'Terraform', what: 'El código de la infraestructura.', git: 'si', deploy: 'na', docker: 'na', rule: 'Revisa siempre el terraform plan en una pull request antes del apply.' },
  { file: '.terraform.lock.hcl', category: 'Terraform', what: 'Versiones exactas de los proveedores que eligió terraform init.', git: 'si', deploy: 'na', docker: 'na', rule: 'Súbelo, igual que package-lock.json: el pipeline usará los mismos proveedores que tú.' },
  { file: '.terraform/', category: 'Terraform', what: 'Proveedores y módulos que descarga terraform init.', git: 'no', deploy: 'no', docker: 'no', rule: 'Se regenera con terraform init.' },
  { file: 'terraform.tfstate', category: 'Terraform', what: 'El estado: qué recursos gestiona Terraform, con valores sensibles en texto plano.', git: 'no', deploy: 'no', docker: 'no', rule: 'En un backend remoto (un blob de Azure Storage, con bloqueo), nunca en Git ni en tu portátil.' },
  { file: '*.tfvars', category: 'Terraform', what: 'Valores de las variables (por ejemplo, dev.tfvars, prod.tfvars).', git: 'depende', deploy: 'na', docker: 'na', rule: 'Sube los que no tienen secretos; los secretos, con variables TF_VAR_ del pipeline o desde Key Vault.' },
  // Bicep y ARM
  { file: 'main.bicep · *.json (ARM)', category: 'Bicep y ARM', what: 'Las plantillas de infraestructura.', git: 'si', deploy: 'na', docker: 'na', rule: 'Valida con az deployment group what-if antes de desplegar.' },
  { file: '*.bicepparam · parameters.json', category: 'Bicep y ARM', what: 'Los valores de los parámetros de cada entorno.', git: 'si', deploy: 'na', docker: 'na', rule: 'Sin contraseñas: haz referencia a un secreto de Key Vault en vez de escribirlo.' },
  // Azure Functions
  { file: 'host.json', category: 'Azure Functions', what: 'Configuración del host de Functions (versión, extensiones, registros).', git: 'si', deploy: 'si', docker: 'si', rule: 'Es parte de la app: viaja en cada despliegue.' },
  { file: '.funcignore', category: 'Azure Functions', what: 'Lo que func azure functionapp publish NO publica.', git: 'si', deploy: 'no', docker: 'no', rule: 'Revisa que incluya local.settings.json, .venv y las pruebas.' },
  // CI/CD y Kubernetes
  { file: 'azure-pipelines.yml', category: 'CI/CD', what: 'La definición del pipeline (CI/CD) como código.', git: 'si', deploy: 'no', docker: 'no', rule: 'Sin secretos: usa variables secretas, grupos de variables o Key Vault. El agente solo ve lo que está en el commit: tu .env no existe allí.' },
  { file: 'manifiestos de Kubernetes (*.yaml)', category: 'CI/CD', what: 'Deployments, Services, ConfigMaps... de AKS.', git: 'si', deploy: 'si', docker: 'na', rule: 'Un Secret de Kubernetes solo está codificado en base64, no cifrado: no subas manifiestos Secret con valores reales.' },
  // Credenciales y claves
  { file: 'id_rsa · id_ed25519', category: 'Credenciales y claves', what: 'Tu clave PRIVADA de SSH.', git: 'no', deploy: 'no', docker: 'no', rule: 'Solo en ~/.ssh y con permisos 600. La que termina en .pub (pública) sí se puede compartir.' },
  { file: '*.pem · *.pfx · *.key', category: 'Credenciales y claves', what: 'Certificados con su clave privada.', git: 'no', deploy: 'no', docker: 'no', rule: 'Guárdalos en Key Vault: App Service y AKS los cargan desde allí.' },
  { file: '~/.kube/config', category: 'Credenciales y claves', what: 'Las credenciales de tus clústeres de Kubernetes.', git: 'no', deploy: 'no', docker: 'no', rule: 'Quien tenga el fichero tiene el clúster: no lo copies a repositorios ni a imágenes.' },
  // Documentación y sistema
  { file: 'README.md', category: 'Documentación y sistema', what: 'La puerta de entrada del proyecto: qué es, cómo se arranca, cómo se despliega.', git: 'si', deploy: 'no', docker: 'no', rule: 'Si alguien nuevo no puede arrancar el proyecto leyéndolo, el README está incompleto.' },
  { file: '.vscode/', category: 'Documentación y sistema', what: 'Configuración del editor.', git: 'depende', deploy: 'no', docker: 'no', rule: 'Se comparte lo útil para el equipo (extensiones recomendadas); lo personal, no.' },
  { file: '*.log · .DS_Store · Thumbs.db', category: 'Documentación y sistema', what: 'Registros y ficheros basura del sistema operativo.', git: 'no', deploy: 'no', docker: 'no', rule: 'Añádelos al .gitignore desde el primer día.' },
];

/** Cada forma de desplegar decide qué viaja: Azure no filtra nada por ti. */
export const DEPLOY_PATHS: { how: string; travels: string; exclude: string }[] = [
  { how: 'az webapp deploy con un zip', travels: 'Todo lo que metas en el zip. zip -r incluye los ficheros ocultos, como .env.', exclude: 'zip -r app.zip . -x ".env" "node_modules/*" y revisa el paquete con unzip -l app.zip' },
  { how: 'Pipeline (Azure Pipelines)', travels: 'Solo lo que está en el commit, más lo que generes durante el build.', exclude: '.gitignore: lo ignorado ni siquiera existe en el agente' },
  { how: 'docker build', travels: 'Todo el contexto que copies con COPY, salvo lo que diga .dockerignore.', exclude: '.dockerignore (y nunca secretos en ENV o ARG)' },
  { how: 'func azure functionapp publish', travels: 'La carpeta del proyecto, salvo lo que diga .funcignore.', exclude: '.funcignore' },
  { how: 'git push a Azure Repos', travels: 'Solo lo que esté versionado.', exclude: '.gitignore, y git rm --cached para lo que ya se subió' },
];

/** Ficheros sensibles o que sobran dentro de un paquete (para los avisos del simulador). */
export function riskyFiles(paths: string[]): { path: string; kind: 'secreto' | 'sobra'; why: string }[] {
  const out: { path: string; kind: 'secreto' | 'sobra'; why: string }[] = [];
  const seen = new Set<string>();
  const add = (path: string, kind: 'secreto' | 'sobra', why: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, kind, why });
  };
  for (const p of paths) {
    const name = p.split('/').pop() ?? p;
    const top = p.split('/')[0];
    if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)) add(p, 'secreto', 'configuración local con posibles secretos');
    else if (name === 'local.settings.json') add(p, 'secreto', 'configuración local de Azure Functions');
    else if (/\.(pem|pfx|key|p12)$/.test(name) || /^id_(rsa|ed25519|ecdsa)$/.test(name)) add(p, 'secreto', 'clave privada o certificado');
    else if (/^terraform\.tfstate(\.backup)?$/.test(name)) add(p, 'secreto', 'estado de Terraform con valores sensibles');
    else if (top === '.git') add('.git/', 'secreto', 'historial completo del repositorio');
    else if (top === 'node_modules') add('node_modules/', 'sobra', 'dependencias de tu sistema; se instalan en el destino');
  }
  return out;
}
