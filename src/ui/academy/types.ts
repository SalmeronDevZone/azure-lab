// Tipos del currículo de la Academia.
import type { CheckCtx } from './checks';

export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  /** Markdown. Los bloques ```bash muestran un botón para probarlos en Cloud Shell. */
  body: string;
}

export interface Step {
  id: string;
  title: string;
  /** Markdown con las instrucciones del paso. */
  detail?: string;
  hint?: string;
  /** true si está hecho; un string es una pista de por qué todavía no. */
  check: (c: CheckCtx) => boolean | string;
}

export interface Exercise {
  id: string;
  title: string;
  summary: string;
  difficulty: 'Fácil' | 'Media' | 'Difícil' | 'Reto';
  minutes: number;
  /** Contexto del escenario (markdown). */
  scenario: string;
  steps: Step[];
  /** Solución de referencia (markdown). */
  solution: string;
  /** Al terminar: consejo de limpieza / reflexión. */
  wrapUp?: string;
  /** Prepara el escenario (p. ej. crear recursos rotos para diagnosticar). Se ejecuta al empezar. */
  setup?: () => Promise<void> | void;
}

export interface QuizQuestion {
  q: string;
  options: string[];
  answer: number;
  explain: string;
}

export interface Level {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  icon: string;
  skills: string[];
  lessons: Lesson[];
  exercises: Exercise[];
  quiz: QuizQuestion[];
}
