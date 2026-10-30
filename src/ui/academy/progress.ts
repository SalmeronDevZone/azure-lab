// Progreso de la Academia (XP, rangos, pasos completados) y motor de validación automática.
import { useSyncExternalStore } from 'react';
import { LEVELS } from './content';
import type { Exercise, Level } from './types';
import { CheckCtx } from './checks';
import { getState, subscribe as subscribeCloud } from '../../engine/store';
import { notify } from '../../engine/arm';
import { readKey, writeKey } from '../../engine/persistence';
import { toast } from '../uiStore';

const KEY = 'azlab:academy:v1';

export interface ProgressData {
  v: 1;
  steps: Record<string, string[]>;
  done: Record<string, string>;
  started: Record<string, number>;
  lessons: Record<string, boolean>;
  quiz: Record<number, { score: number; total: number; answers: number[] }>;
  active: string | null;
  hints: Record<string, boolean>;
}

function empty(): ProgressData {
  return { v: 1, steps: {}, done: {}, started: {}, lessons: {}, quiz: {}, active: null, hints: {} };
}

function load(): ProgressData {
  try {
    const raw = readKey(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
}

let data: ProgressData = load();
let ver = 0;
const listeners = new Set<() => void>();

function save() {
  ver++;
  try {
    writeKey(KEY, JSON.stringify(data));
  } catch {
    /* sin almacenamiento */
  }
  for (const l of [...listeners]) l();
}

export function getProgress(): ProgressData {
  return data;
}

export function useAcademy(): ProgressData {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ver,
    () => ver,
  );
  return data;
}

// ---------------------------------------------------------------- XP y rangos

export const RANKS = [
  { xp: 0, name: 'Novato', icon: '🌱' },
  { xp: 150, name: 'Aprendiz cloud', icon: '☁️' },
  { xp: 450, name: 'Explorador de Azure', icon: '🧭' },
  { xp: 900, name: 'Administrador junior', icon: '🛠️' },
  { xp: 1500, name: 'Ingeniero cloud', icon: '⚙️' },
  { xp: 2300, name: 'Ingeniero de plataforma', icon: '🏗️' },
  { xp: 3200, name: 'Ingeniero DevOps', icon: '🚀' },
  { xp: 4200, name: 'Auténtico DevOps', icon: '🏆' },
];

export const XP = { step: 10, exercise: 60, lesson: 10, quizQuestion: 10 };

export function allExercises(): { level: Level; ex: Exercise }[] {
  return LEVELS.flatMap((level) => level.exercises.map((ex) => ({ level, ex })));
}

export function findExercise(id: string) {
  return allExercises().find((x) => x.ex.id === id);
}

export function computeXp(d: ProgressData = data): number {
  let xp = 0;
  for (const steps of Object.values(d.steps)) xp += steps.length * XP.step;
  xp += Object.keys(d.done).length * XP.exercise;
  xp += Object.keys(d.lessons).length * XP.lesson;
  for (const q of Object.values(d.quiz)) xp += q.score * XP.quizQuestion;
  return xp;
}

export function academyProgress() {
  const xp = computeXp();
  let rank = RANKS[0];
  let next: (typeof RANKS)[number] | null = null;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].xp) {
      rank = RANKS[i];
      next = RANKS[i + 1] ?? null;
    }
  }
  const total = allExercises().length;
  const done = Object.keys(data.done).filter((id) => findExercise(id)).length;
  return { xp, rank, next, exercisesDone: done, exercisesTotal: total, percent: total ? Math.round((done / total) * 100) : 0 };
}

// ---------------------------------------------------------------- niveles

export function levelStats(level: Level) {
  const exDone = level.exercises.filter((e) => data.done[e.id]).length;
  const lessonsDone = level.lessons.filter((l) => data.lessons[l.id]).length;
  const quiz = data.quiz[level.id];
  return { exDone, exTotal: level.exercises.length, lessonsDone, lessonsTotal: level.lessons.length, quiz, done: exDone === level.exercises.length && level.exercises.length > 0 };
}

export function levelUnlocked(level: Level): boolean {
  if (level.id <= 1 || getState().settings.freeMode) return true;
  const prev = LEVELS.find((l) => l.id === level.id - 1);
  return !prev || levelStats(prev).done;
}

/** Siguiente parada recomendada (lección o ejercicio pendiente). */
export function currentStop(): { levelTitle: string; title: string; href: string } | null {
  for (const level of LEVELS) {
    if (!levelUnlocked(level)) continue;
    for (const l of level.lessons) if (!data.lessons[l.id]) return { levelTitle: `Nivel ${level.id} · ${level.title}`, title: `Lección: ${l.title}`, href: `/academy/level/${level.id}/lesson/${l.id}` };
    for (const e of level.exercises) if (!data.done[e.id]) return { levelTitle: `Nivel ${level.id} · ${level.title}`, title: `Ejercicio: ${e.title}`, href: `/academy/level/${level.id}/exercise/${e.id}` };
    if (!data.quiz[level.id]) return { levelTitle: `Nivel ${level.id} · ${level.title}`, title: 'Cuestionario del nivel', href: `/academy/level/${level.id}/quiz` };
  }
  return null;
}

// ---------------------------------------------------------------- acciones

export async function startExercise(ex: Exercise) {
  if (!data.started[ex.id]) data.started[ex.id] = Date.now();
  data.active = ex.id;
  save();
  if (ex.setup && !data.steps[ex.id]?.length) {
    try {
      await ex.setup();
    } catch (e) {
      console.error('Error preparando el ejercicio', e);
    }
  }
  evaluateNow();
}

export function setActive(id: string | null) {
  data.active = id;
  save();
}

export function resetExercise(ex: Exercise) {
  delete data.steps[ex.id];
  delete data.done[ex.id];
  data.started[ex.id] = Date.now();
  save();
  evaluateNow();
}

export function markLesson(id: string) {
  if (data.lessons[id]) return;
  data.lessons[id] = true;
  save();
}

export function saveQuiz(levelId: number, answers: number[], score: number, total: number) {
  const prev = data.quiz[levelId];
  if (!prev || score >= prev.score) data.quiz[levelId] = { answers, score, total };
  save();
}

export function revealHint(stepKey: string) {
  data.hints[stepKey] = true;
  save();
}

export function resetAcademy() {
  data = empty();
  save();
}

/** Sustituye el progreso por el de una copia exportada (texto JSON). */
export function replaceProgress(raw: string) {
  data = { ...empty(), ...JSON.parse(raw) };
  save();
}

// ---------------------------------------------------------------- motor de validación

export interface StepState {
  done: boolean;
  feedback?: string;
}

const feedbackCache = new Map<string, string>();

export function stepFeedback(exId: string, stepId: string): string | undefined {
  return feedbackCache.get(`${exId}/${stepId}`);
}

function evaluateExercise(ex: Exercise): boolean {
  const since = data.started[ex.id] ?? Date.now();
  const ctx = new CheckCtx(since);
  const doneSteps = new Set(data.steps[ex.id] ?? []);
  let changedAny = false;
  for (const st of ex.steps) {
    if (doneSteps.has(st.id)) continue;
    let r: boolean | string = false;
    try {
      r = st.check(ctx);
    } catch (e) {
      r = false;
      console.warn('Error en la validación del paso', ex.id, st.id, e);
    }
    if (r === true) {
      doneSteps.add(st.id);
      feedbackCache.delete(`${ex.id}/${st.id}`);
      changedAny = true;
    } else if (typeof r === 'string') feedbackCache.set(`${ex.id}/${st.id}`, r);
    else feedbackCache.delete(`${ex.id}/${st.id}`);
  }
  if (changedAny) {
    data.steps[ex.id] = ex.steps.filter((x) => doneSteps.has(x.id)).map((x) => x.id);
    if (!data.done[ex.id] && ex.steps.every((x) => doneSteps.has(x.id))) {
      data.done[ex.id] = new Date().toISOString();
      const before = academyProgress().rank;
      setTimeout(() => {
        toast(`🎉 ¡Ejercicio completado! +${XP.exercise} XP`, 'success', ex.title);
        notify({ title: 'Academia: ejercicio completado', message: ex.title, level: 'success', link: '#/academy' });
        const after = academyProgress().rank;
        if (after.name !== before.name) toast(`${after.icon} ¡Nuevo rango: ${after.name}!`, 'success');
      }, 0);
    }
  }
  return changedAny;
}

export function evaluateNow() {
  let any = false;
  for (const { ex } of allExercises()) {
    if (data.started[ex.id] === undefined || data.done[ex.id]) continue;
    if (evaluateExercise(ex)) any = true;
  }
  if (any) save();
  else {
    ver++;
    for (const l of [...listeners]) l();
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Reevalúa los ejercicios en curso cada vez que cambia la nube (con un pequeño retardo). */
export function startAcademyEngine() {
  if (started) return;
  started = true;
  subscribeCloud(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      evaluateNow();
    }, 600);
  });
  setInterval(evaluateNow, 5000);
  setTimeout(evaluateNow, 500);
}
