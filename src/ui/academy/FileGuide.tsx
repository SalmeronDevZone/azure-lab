// Guía de ficheros: qué se versiona, qué se despliega y qué nunca debe salir de tu ordenador.
import { useState } from 'react';
import { FILE_GUIDE, DEPLOY_PATHS, type FileVerdict } from '../../engine/fileRules';
import { Icon } from '../components/Icons';
import { Callout, DataTable } from '../components/common';
import { Markdown } from './Academy';

const VERDICT: Record<FileVerdict, { label: string; cls: string }> = {
  si: { label: 'Sí', cls: 'pill ok' },
  no: { label: 'No', cls: 'pill bad' },
  depende: { label: 'Depende', cls: 'pill warn' },
  na: { label: '—', cls: 'muted' },
};

const Verdict = ({ v }: { v: FileVerdict }) => <span className={VERDICT[v].cls}>{VERDICT[v].label}</span>;

const RULES = `## Las cinco reglas de oro

1. **Un secreto nunca vive en el código ni en el repositorio.** En tu ordenador, en un \`.env\` ignorado por Git; en Azure, en la configuración de la aplicación o en Key Vault.
2. **El \`.gitignore\` se crea antes del primer commit.** No protege lo que ya está versionado: eso se saca con \`git rm --cached\`.
3. **Lo que se puede regenerar no se sube:** \`node_modules/\`, \`dist/\`, \`.venv/\`, \`bin/\`, \`.terraform/\`. Sí se suben los ficheros de bloqueo (\`package-lock.json\`, \`.terraform.lock.hcl\`), que fijan las versiones exactas.
4. **Revisa el paquete antes de desplegarlo** (\`unzip -l app.zip\`, \`git status --ignored\`, \`docker history\`). Azure no filtra nada por ti.
5. **Si un secreto se filtró, cámbialo.** Borrarlo del repositorio no lo borra del historial: \`git log -- .env\` lo sigue mostrando.

## Comprueba tu proyecto en Cloud Shell

\`\`\`bash
cd ~/samples/app-node
git init                                          # si todavía no es un repositorio
git status --ignored                              # «Ignored files»: lo que Git no subirá
git check-ignore -v .env node_modules             # ¿qué regla del .gitignore lo ignora?
zip -qr ~/app.zip . -x ".env" "node_modules/*"    # paquete sin secretos ni dependencias
unzip -l ~/app.zip                                # revisa qué viaja antes de desplegar
\`\`\`

## Un \`.gitignore\` profesional para Node.js

\`\`\`text
# Dependencias: se reinstalan con "npm ci" a partir de package-lock.json
node_modules/

# Configuración local y secretos: NUNCA al repositorio
.env
.env.*
!.env.example

# Registros, paquetes generados y ficheros del sistema
npm-debug.log*
*.zip
.DS_Store
\`\`\``;

export function FileGuide() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const cats = [...new Set(FILE_GUIDE.map((f) => f.category))];
  const rows = FILE_GUIDE.filter((f) => (!cat || f.category === cat) && (!q || `${f.file} ${f.what} ${f.rule} ${f.category}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="page">
      <div className="breadcrumb">
        <a href="#/academy">Academia</a> <Icon name="chevron" size={10} /> <span>Guía de ficheros</span>
      </div>
      <h1 style={{ fontSize: 24, margin: '6px 0' }}>Guía de ficheros</h1>
      <p className="muted" style={{ maxWidth: 820 }}>
        Qué se sube a Git, qué viaja en un despliegue y qué no debe salir nunca de tu ordenador. Saberlo es lo que distingue a un profesional: la mayoría de las filtraciones de secretos empiezan con un <span className="mono">.env</span> en el sitio equivocado.
      </p>
      <Callout kind="warn" title="¿Se borran los .env al desplegar? No.">
        Azure no filtra nada por ti: lo que va dentro del paquete llega a producción tal cual (en App Service, a <span className="mono">/home/site/wwwroot</span>). Lo que decide qué viaja es <b>cómo</b> despliegas:
      </Callout>
      <DataTable
        rows={DEPLOY_PATHS}
        rowKey={(r) => r.how}
        columns={[
          { key: 'h', title: 'Si despliegas con...', render: (r) => <b>{r.how}</b> },
          { key: 't', title: 'Viaja', render: (r) => r.travels },
          { key: 'e', title: 'Cómo excluir', render: (r) => <span className="small">{r.exclude}</span> },
        ]}
      />
      <h2 style={{ fontSize: 18, margin: '24px 0 10px' }}>Fichero a fichero</h2>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <input className="input" style={{ width: 260 }} placeholder="Buscar: .env, tfstate, node_modules..." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`btn small${!cat ? ' primary' : ''}`} onClick={() => setCat('')}>
          Todos
        </button>
        {cats.map((c) => (
          <button key={c} className={`btn small${cat === c ? ' primary' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>
            {c}
          </button>
        ))}
      </div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.file}
        columns={[
          { key: 'f', title: 'Fichero', render: (r) => <span className="mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{r.file}</span> },
          { key: 'w', title: 'Qué es', render: (r) => <span className="small">{r.what}</span> },
          { key: 'g', title: '¿A Git?', render: (r) => <Verdict v={r.git} /> },
          { key: 'd', title: '¿Se despliega?', render: (r) => <Verdict v={r.deploy} /> },
          { key: 'i', title: '¿En la imagen Docker?', render: (r) => <Verdict v={r.docker} /> },
          { key: 'r', title: 'Regla profesional', render: (r) => <span className="small">{r.rule}</span> },
        ]}
        empty="Ningún fichero coincide con la búsqueda."
      />
      <div style={{ maxWidth: 860, marginTop: 20 }}>
        <Markdown md={RULES} />
      </div>
    </div>
  );
}
