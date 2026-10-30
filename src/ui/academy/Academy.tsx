// Academia: ruta guiada por niveles, lecciones, ejercicios con validación automática y cuestionarios.
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { LEVELS } from './content';
import type { Exercise, Level } from './types';
import { useAcademy, academyProgress, levelStats, levelUnlocked, startExercise, resetExercise, setActive, markLesson, saveQuiz, stepFeedback, revealHint, findExercise, RANKS, XP, currentStop } from './progress';
import { useCloud, navigate, useRoute } from '../hooks';
import { setUi, useUi } from '../uiStore';
import { terminal } from '../terminal/controller';
import { Icon, ServiceIcon } from '../components/Icons';
import { Callout, confirmDialog } from '../components/common';
import { getState } from '../../engine/store';
import { FileGuide } from './FileGuide';

// ---------------------------------------------------------------- markdown

function fill(md: string): string {
  const s = getState();
  return md
    .replace(/\{\{domain\}\}/g, s.tenant.domain)
    .replace(/\{\{upn\}\}/g, s.me.upn)
    .replace(/\{\{user\}\}/g, s.me.upn.split('@')[0])
    .replace(/\{\{sub\}\}/g, s.currentSubscriptionId)
    .replace(/\{\{name\}\}/g, s.me.displayName.split(' ')[0]);
}

export function Markdown({ md, className = 'lesson' }: { md: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => marked.parse(fill(md), { async: false }) as string, [md]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.run-btn')) return;
      const code = pre.querySelector('code');
      if (!code) return;
      const lang = code.className;
      if (!/language-(bash|sh|shell|console)/.test(lang)) return;
      const btn = document.createElement('button');
      btn.className = 'run-btn';
      btn.textContent = 'Probar en Cloud Shell';
      btn.onclick = () => {
        const lines = (code.textContent ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
        if (!lines.length) return;
        // Una línea: se escribe en Cloud Shell para que el estudiante la revise y pulse Intro.
        // Varias: se escriben de una en una tras ejecutar la anterior (como al pegar en bash).
        if (lines.length === 1) terminal.typeCommand(lines[0]);
        else {
          for (const l of lines.slice(0, -1)) terminal.runCommand(l);
          terminal.typeAfterQueue(lines[lines.length - 1]);
        }
      };
      pre.appendChild(btn);
    });
    el.querySelectorAll('a[href^="#/"]').forEach((a) => a.addEventListener('click', () => setUi({ shellMax: false })));
  }, [html]);
  return <div ref={ref} className={`md ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------- panel principal

function Dashboard() {
  useAcademy();
  useCloud();
  const p = academyProgress();
  const stop = currentStop();
  const nextXp = p.next ? p.next.xp : p.xp;
  const prevXp = p.rank.xp;
  const pct = p.next ? Math.round(((p.xp - prevXp) / (nextXp - prevXp)) * 100) : 100;
  return (
    <div className="academy">
      <div className="academy-hero">
        <div className="row" style={{ gap: 10, opacity: 0.8 }}>
          <ServiceIcon name="academy" size={22} /> Academia Azure Lab
        </div>
        <h1 style={{ margin: '8px 0 6px' }}>De cero a ingeniero DevOps en Azure</h1>
        <p>13 niveles con lecciones breves y laboratorios prácticos que se validan solos mientras trabajas en el portal, en Cloud Shell y en Azure DevOps. Todo ocurre en tu nube simulada: rompe cosas sin miedo.</p>
        <div className="rank-card">
          <div className="rank-badge">{p.rank.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{p.rank.name}</div>
            <div style={{ opacity: 0.85, fontSize: 13 }}>
              {p.xp} XP · {p.exercisesDone}/{p.exercisesTotal} ejercicios{p.next ? ` · ${nextXp - p.xp} XP para "${p.next.name}"` : ' · ¡rango máximo!'}
            </div>
            <div className="progress xp" style={{ marginTop: 8, background: 'rgba(255,255,255,0.18)' }}>
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>
          {stop ? (
            <button className="btn primary" onClick={() => navigate(stop.href)}>
              Continuar: {stop.title.length > 38 ? stop.title.slice(0, 38) + '…' : stop.title}
            </button>
          ) : null}
        </div>
        <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
          <a className="btn small" href="#/academy/ficheros">
            📁 Guía de ficheros: .env, .gitignore, node_modules...
          </a>
          <a className="btn small" href="#/academy/guide">
            Cómo funciona la Academia
          </a>
        </div>
      </div>
      <div className="levels">
        {LEVELS.map((l) => {
          const st = levelStats(l);
          const unlocked = levelUnlocked(l);
          return (
            <a key={l.id} className={`level-card${unlocked ? '' : ' locked'}${st.done ? ' done' : ''}`} href={unlocked ? `#/academy/level/${l.id}` : undefined} onClick={(e) => !unlocked && e.preventDefault()} title={unlocked ? '' : 'Completa los ejercicios del nivel anterior para desbloquearlo (o activa el modo libre en Configuración).'}>
              <div className="row">
                <span className="level-num">{st.done ? '✓' : l.id}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{l.title}</h3>
                  <div className="muted small">{l.subtitle}</div>
                </div>
                <ServiceIcon name={l.icon} size={28} />
              </div>
              <div className="row wrap" style={{ gap: 4 }}>
                {l.skills.slice(0, 5).map((s) => (
                  <span key={s} className="tag">
                    {s}
                  </span>
                ))}
              </div>
              <div className="row small muted" style={{ marginTop: 'auto' }}>
                <span>📖 {st.lessonsDone}/{st.lessonsTotal}</span>
                <span>🧪 {st.exDone}/{st.exTotal}</span>
                <span>📝 {st.quiz ? `${st.quiz.score}/${st.quiz.total}` : '—'}</span>
                <span className="spacer" />
                {!unlocked ? <span>🔒 Bloqueado</span> : st.done ? <span style={{ color: 'var(--success)' }}>Completado</span> : null}
              </div>
              <div className="progress" style={{ height: 4 }}>
                <div style={{ width: `${st.exTotal ? (st.exDone / st.exTotal) * 100 : 0}%`, background: st.done ? 'var(--success)' : undefined }} />
              </div>
            </a>
          );
        })}
      </div>
      <div className="page" style={{ paddingTop: 0 }}>
        <h2 style={{ fontSize: 16, marginBottom: 10 }}>Rangos</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          {RANKS.map((r) => (
            <span key={r.name} className={`pill${p.xp >= r.xp ? ' xp' : ''}`} style={{ height: 28, padding: '0 12px' }}>
              {r.icon} {r.name} · {r.xp} XP
            </span>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          XP: {XP.lesson} por lección leída, {XP.step} por paso de laboratorio, {XP.exercise} extra por ejercicio completado y {XP.quizQuestion} por respuesta correcta.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- nivel

function LevelPage({ level }: { level: Level }) {
  const d = useAcademy();
  const st = levelStats(level);
  return (
    <div className="page narrow">
      <div className="breadcrumb">
        <a href="#/academy">Academia</a> <Icon name="chevron" size={10} /> <span>Nivel {level.id}</span>
      </div>
      <div className="page-head">
        <ServiceIcon name={level.icon} size={44} />
        <div>
          <h1>
            Nivel {level.id} · {level.title}
          </h1>
          <div className="subtitle">{level.subtitle}</div>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 18 }}>
        <span className="muted">Aprenderás:</span>
        {level.skills.map((s) => (
          <span key={s} className="tag">
            {s}
          </span>
        ))}
      </div>
      <h2 className="section-title">📖 Lecciones</h2>
      <div className="file-tree">
        {level.lessons.map((l, i) => (
          <a key={l.id} className="file-row" href={`#/academy/level/${level.id}/lesson/${l.id}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
            <span className={`status-icon ${d.lessons[l.id] ? 'succeeded' : 'notStarted'}`}>{d.lessons[l.id] ? '✓' : ''}</span>
            <span>
              {i + 1}. {l.title}
            </span>
            <span className="spacer" />
            <span className="muted small">{l.minutes} min</span>
          </a>
        ))}
      </div>
      <h2 className="section-title">🧪 Laboratorios</h2>
      <div className="file-tree">
        {level.exercises.map((e) => {
          const stepsDone = d.steps[e.id]?.length ?? 0;
          return (
            <a key={e.id} className="file-row" href={`#/academy/level/${level.id}/exercise/${e.id}`} style={{ color: 'var(--text)', textDecoration: 'none', alignItems: 'flex-start' }}>
              <span className={`status-icon ${d.done[e.id] ? 'succeeded' : d.started[e.id] ? 'running' : 'notStarted'}`} style={{ marginTop: 2 }}>
                {d.done[e.id] ? '✓' : ''}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{e.title}</div>
                <div className="muted small">{e.summary}</div>
              </div>
              <span className={`pill ${e.difficulty === 'Fácil' ? 'ok' : e.difficulty === 'Media' ? 'info' : e.difficulty === 'Difícil' ? 'warn' : 'xp'}`}>{e.difficulty}</span>
              <span className="muted small nowrap" style={{ width: 90, textAlign: 'right' }}>
                {stepsDone}/{e.steps.length} pasos
              </span>
            </a>
          );
        })}
      </div>
      <h2 className="section-title">📝 Cuestionario</h2>
      <div className="card row">
        <div style={{ flex: 1 }}>
          {level.quiz.length} preguntas para comprobar lo aprendido. {st.quiz ? `Mejor resultado: ${st.quiz.score}/${st.quiz.total}.` : ''}
        </div>
        <button className="btn" onClick={() => navigate(`/academy/level/${level.id}/quiz`)}>
          {st.quiz ? 'Repetir' : 'Empezar'}
        </button>
      </div>
      {st.done ? (
        <Callout kind="ok" title={`¡Nivel ${level.id} completado!`}>
          {LEVELS.find((l) => l.id === level.id + 1) ? (
            <>
              Ya puedes pasar al <a href={`#/academy/level/${level.id + 1}`}>nivel {level.id + 1}: {LEVELS.find((l) => l.id === level.id + 1)!.title}</a>.
            </>
          ) : (
            'Has terminado la ruta. ¡Enhorabuena!'
          )}
        </Callout>
      ) : null}
    </div>
  );
}

function LessonPage({ level, lessonId }: { level: Level; lessonId: string }) {
  useAcademy();
  const idx = level.lessons.findIndex((l) => l.id === lessonId);
  const lesson = level.lessons[idx];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollIntoView({ block: 'start' });
  }, [lessonId]);
  if (!lesson) return <div className="page">Lección no encontrada.</div>;
  const next = level.lessons[idx + 1];
  const goNext = () => {
    markLesson(lesson.id);
    navigate(next ? `/academy/level/${level.id}/lesson/${next.id}` : level.exercises[0] ? `/academy/level/${level.id}/exercise/${level.exercises[0].id}` : `/academy/level/${level.id}`);
  };
  return (
    <div className="page narrow" ref={scroller}>
      <div className="breadcrumb">
        <a href="#/academy">Academia</a> <Icon name="chevron" size={10} /> <a href={`#/academy/level/${level.id}`}>Nivel {level.id}</a> <Icon name="chevron" size={10} /> <span>Lección {idx + 1}</span>
      </div>
      <div className="muted small">
        Lección {idx + 1} de {level.lessons.length} · {lesson.minutes} min de lectura
      </div>
      <Markdown md={`# ${lesson.title}\n\n${lesson.body}`} />
      <div className="btn-row" style={{ margin: '24px 0 40px', maxWidth: 860 }}>
        {idx > 0 ? (
          <button className="btn" onClick={() => navigate(`/academy/level/${level.id}/lesson/${level.lessons[idx - 1].id}`)}>
            ← Anterior
          </button>
        ) : null}
        <span className="spacer" />
        <button className="btn primary" onClick={goNext}>
          {next ? 'Entendido, siguiente lección →' : 'Entendido, ¡a practicar! →'}
        </button>
      </div>
    </div>
  );
}

export function StepList({ ex, compact }: { ex: Exercise; compact?: boolean }) {
  const d = useAcademy();
  const done = new Set(d.steps[ex.id] ?? []);
  const firstPending = ex.steps.find((s) => !done.has(s.id));
  return (
    <ul className="steps">
      {ex.steps.map((st, i) => {
        const isDone = done.has(st.id);
        const fb = !isDone && d.started[ex.id] ? stepFeedback(ex.id, st.id) : undefined;
        const hintKey = `${ex.id}/${st.id}`;
        return (
          <li key={st.id} className={`step${isDone ? ' done' : firstPending?.id === st.id ? ' current' : ''}`}>
            <span className="step-check">{isDone ? '✓' : i + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="title">{st.title}</div>
              {!compact && st.detail ? (
                <div className="detail">
                  <Markdown md={st.detail} className="" />
                </div>
              ) : null}
              {fb ? <div className="feedback">⏳ {fb}</div> : null}
              {!compact && st.hint && !isDone ? (
                d.hints[hintKey] ? (
                  <div className="callout" style={{ marginTop: 6, marginBottom: 0 }}>
                    <span>💡</span>
                    <div className="body">
                      <Markdown md={st.hint} className="" />
                    </div>
                  </div>
                ) : (
                  <a className="small" onClick={() => revealHint(hintKey)}>
                    Mostrar pista
                  </a>
                )
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ExercisePage({ level, exId }: { level: Level; exId: string }) {
  const d = useAcademy();
  useCloud();
  const ex = level.exercises.find((e) => e.id === exId);
  const [showSolution, setShowSolution] = useState(false);
  if (!ex) return <div className="page">Ejercicio no encontrado.</div>;
  const started = d.started[ex.id] !== undefined;
  const done = !!d.done[ex.id];
  const stepsDone = d.steps[ex.id]?.length ?? 0;
  const idx = level.exercises.indexOf(ex);
  const next = level.exercises[idx + 1];
  return (
    <div className="page narrow">
      <div className="breadcrumb">
        <a href="#/academy">Academia</a> <Icon name="chevron" size={10} /> <a href={`#/academy/level/${level.id}`}>Nivel {level.id}</a> <Icon name="chevron" size={10} /> <span>Laboratorio</span>
      </div>
      <div className="page-head">
        <span style={{ fontSize: 30 }}>🧪</span>
        <div style={{ flex: 1 }}>
          <h1>{ex.title}</h1>
          <div className="subtitle">
            {ex.difficulty} · ~{ex.minutes} min · {ex.steps.length} pasos · {ex.steps.length * XP.step + XP.exercise} XP
          </div>
        </div>
      </div>
      <div className="lesson" style={{ marginBottom: 6 }}>
        <Markdown md={ex.scenario} className="" />
      </div>
      {!started ? (
        <div className="card row" style={{ marginBottom: 18 }}>
          <div style={{ flex: 1 }}>Cuando pulses <b>Empezar</b>, la Academia vigilará tu nube simulada y marcará cada paso en cuanto lo completes, tanto si lo haces en el portal como en Cloud Shell.</div>
          <button className="btn primary" onClick={() => startExercise(ex)}>
            Empezar laboratorio
          </button>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row">
            <b>
              Progreso: {stepsDone}/{ex.steps.length}
            </b>
            <span className="spacer" />
            {!done && d.active !== ex.id ? (
              <button className="btn small" onClick={() => setActive(ex.id)}>
                Fijar en el panel lateral
              </button>
            ) : null}
            <button className="btn small" onClick={() => setUi({ shellOpen: true })}>
              <Icon name="shell" size={14} /> Abrir Cloud Shell
            </button>
            <button
              className="btn small"
              onClick={async () => {
                if (await confirmDialog({ title: 'Reiniciar laboratorio', message: 'Se borrará el progreso de este ejercicio (los recursos que hayas creado no se eliminan).', confirmText: 'Reiniciar' })) resetExercise(ex);
              }}
            >
              Reiniciar
            </button>
          </div>
          <div className="progress xp" style={{ marginTop: 8 }}>
            <div style={{ width: `${(stepsDone / ex.steps.length) * 100}%` }} />
          </div>
        </div>
      )}
      <StepList ex={ex} />
      {done ? (
        <div className="card celebrate" style={{ marginTop: 18 }}>
          <div className="emoji">🎉</div>
          <h2>¡Laboratorio completado!</h2>
          {ex.wrapUp ? (
            <div style={{ textAlign: 'left', maxWidth: 680, margin: '12px auto 0' }}>
              <Markdown md={ex.wrapUp} />
            </div>
          ) : null}
          <div className="btn-row" style={{ justifyContent: 'center', marginTop: 14 }}>
            {next ? (
              <button className="btn primary" onClick={() => navigate(`/academy/level/${level.id}/exercise/${next.id}`)}>
                Siguiente laboratorio →
              </button>
            ) : (
              <button className="btn primary" onClick={() => navigate(`/academy/level/${level.id}/quiz`)}>
                Hacer el cuestionario →
              </button>
            )}
          </div>
        </div>
      ) : null}
      <div style={{ margin: '22px 0 40px' }}>
        <a onClick={() => setShowSolution(!showSolution)}>{showSolution ? 'Ocultar la solución' : '¿Atascado? Ver la solución de referencia'}</a>
        {showSolution ? (
          <div className="card" style={{ marginTop: 10 }}>
            <Markdown md={ex.solution} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuizPage({ level }: { level: Level }) {
  useAcademy();
  const [answers, setAnswers] = useState<(number | null)[]>(level.quiz.map(() => null));
  const [submitted, setSubmitted] = useState(false);
  const score = answers.filter((a, i) => a === level.quiz[i].answer).length;
  return (
    <div className="page narrow">
      <div className="breadcrumb">
        <a href="#/academy">Academia</a> <Icon name="chevron" size={10} /> <a href={`#/academy/level/${level.id}`}>Nivel {level.id}</a> <Icon name="chevron" size={10} /> <span>Cuestionario</span>
      </div>
      <div className="page-head">
        <span style={{ fontSize: 30 }}>📝</span>
        <h1>Cuestionario · {level.title}</h1>
      </div>
      {level.quiz.map((q, i) => (
        <div key={i} className="quiz-q card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {i + 1}. {q.q}
          </div>
          {q.options.map((o, j) => {
            const chosen = answers[i] === j;
            const cls = submitted ? (j === q.answer ? ' right' : chosen ? ' wrong' : '') : chosen ? ' chosen' : '';
            return (
              <div key={j} className={`quiz-opt${cls}`} onClick={() => !submitted && setAnswers(answers.map((a, k) => (k === i ? j : a)))}>
                <input type="radio" checked={chosen} readOnly />
                <span>{o}</span>
              </div>
            );
          })}
          {submitted ? <div className={`small ${answers[i] === q.answer ? '' : ''}`} style={{ marginTop: 6, color: 'var(--text-2)' }}>{answers[i] === q.answer ? '✅ ' : '❌ '}{q.explain}</div> : null}
        </div>
      ))}
      <div className="btn-row" style={{ marginBottom: 40 }}>
        {!submitted ? (
          <button
            className="btn primary"
            disabled={answers.some((a) => a === null)}
            onClick={() => {
              setSubmitted(true);
              saveQuiz(level.id, answers as number[], score, level.quiz.length);
            }}
          >
            Comprobar respuestas
          </button>
        ) : (
          <>
            <span style={{ fontSize: 16, fontWeight: 600 }}>
              Resultado: {score}/{level.quiz.length} {score === level.quiz.length ? '🏆' : score >= level.quiz.length / 2 ? '👍' : '📚'}
            </span>
            <button
              className="btn"
              onClick={() => {
                setSubmitted(false);
                setAnswers(level.quiz.map(() => null));
              }}
            >
              Repetir
            </button>
            <button className="btn primary" onClick={() => navigate(`/academy/level/${level.id}`)}>
              Volver al nivel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Guide() {
  return (
    <div className="page narrow">
      <div className="breadcrumb">
        <a href="#/academy">Academia</a> <Icon name="chevron" size={10} /> <span>Cómo funciona</span>
      </div>
      <Markdown
        md={`# Cómo funciona Azure Lab

Azure Lab es una **réplica local de Azure** para aprender sin coste ni riesgo. Nada sale de tu navegador: los recursos, Cloud Shell, Azure DevOps y los registros son simulados, pero se comportan como en Azure (mismos comandos, mismos errores, mismos conceptos).

## Las tres herramientas que usarás

| Herramienta | Para qué | Cómo abrirla |
| --- | --- | --- |
| **Portal** | Crear y administrar recursos con la interfaz gráfica | Es lo que estás viendo |
| **Cloud Shell** | Bash + Azure CLI (\`az\`), \`kubectl\`, \`terraform\`, \`git\`, \`docker\`... | Icono \`>_\` de la barra superior |
| **Azure DevOps** | Repos Git, pipelines de CI/CD, entornos y aprobaciones | Icono de DevOps de la barra superior |

## Cómo se valida un laboratorio

1. Abre el laboratorio y pulsa **Empezar**.
2. Trabaja como quieras: portal, CLI o pipelines. El panel lateral te muestra los pasos.
3. Cada paso se marca solo cuando la nube cumple la condición (por ejemplo, "existe una VM en ejecución con el puerto 80 abierto").

## Atajos de Cloud Shell

- \`↑\` / \`↓\`: historial · \`Tab\`: autocompletar comandos, rutas y subcomandos de \`az\`
- \`Ctrl+C\`: cancelar · \`Ctrl+L\`: limpiar · \`Ctrl+A\` / \`Ctrl+E\`: inicio/fin de línea
- \`code fichero\`: abre el editor · \`az <grupo> --help\`: ayuda de cualquier comando
- En \`~/samples\` tienes ejemplos (web estática, app Node.js, plantillas ARM/Bicep/Terraform, manifiestos de Kubernetes y un pipeline).

## Consejos

- Usa **Configuración** (engranaje) para cambiar la velocidad de aprovisionamiento, el tema o restablecer la nube.
- Los costes se simulan: 1 minuto real = 1 hora facturada. Detén o elimina lo que no uses.
- Si te atascas, cada paso tiene una **pista** y cada laboratorio una **solución de referencia**.
`}
      />
    </div>
  );
}

// ---------------------------------------------------------------- panel flotante del laboratorio

export function LabPanel() {
  const d = useAcademy();
  const u = useUi();
  const route = useRoute();
  if (!d.active) return null;
  const found = findExercise(d.active);
  if (!found) return null;
  const { ex, level } = found;
  if (route.path.includes(`/exercise/${ex.id}`) || route.parts[0] === 'devops' && u.shellMax) return null;
  const doneCount = d.steps[ex.id]?.length ?? 0;
  const finished = !!d.done[ex.id];
  return (
    <div className={`lab-panel${u.labCollapsed ? ' collapsed' : ''}`} style={u.shellOpen && !u.shellMax ? { bottom: u.shellHeight + 16 } : undefined}>
      <div className="lab-panel-head" onClick={() => setUi({ labCollapsed: !u.labCollapsed })}>
        <span>🧪</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.title}</div>
          <div className="muted small">
            Nivel {level.id} · {doneCount}/{ex.steps.length} pasos {finished ? '· ✅ completado' : ''}
          </div>
        </div>
        <Icon name={u.labCollapsed ? 'chevronDown' : 'minimize'} size={14} />
      </div>
      {!u.labCollapsed ? (
        <div className="lab-panel-body">
          <div className="progress xp" style={{ marginBottom: 6 }}>
            <div style={{ width: `${(doneCount / ex.steps.length) * 100}%` }} />
          </div>
          <StepList ex={ex} compact />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn small primary" onClick={() => navigate(`/academy/level/${level.id}/exercise/${ex.id}`)}>
              Ver instrucciones
            </button>
            <button className="btn small" onClick={() => setActive(null)}>
              Ocultar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- enrutado

export function AcademyRoute() {
  const route = useRoute();
  const parts = route.parts;
  if (parts[1] === 'guide') return <Guide />;
  if (parts[1] === 'ficheros') return <FileGuide />;
  if (parts[1] === 'level') {
    const level = LEVELS.find((l) => l.id === Number(parts[2]));
    if (!level) return <Dashboard />;
    if (!levelUnlocked(level))
      return (
        <div className="page narrow">
          <Callout kind="warn" title="Nivel bloqueado">
            Completa los laboratorios del nivel {level.id - 1} para desbloquearlo, o activa el <b>modo libre</b> en Configuración. <a href="#/academy">Volver a la Academia</a>
          </Callout>
        </div>
      );
    if (parts[3] === 'lesson') return <LessonPage level={level} lessonId={parts[4]} />;
    if (parts[3] === 'exercise') return <ExercisePage level={level} exId={parts[4]} />;
    if (parts[3] === 'quiz') return <QuizPage level={level} />;
    return <LevelPage level={level} />;
  }
  return <Dashboard />;
}
