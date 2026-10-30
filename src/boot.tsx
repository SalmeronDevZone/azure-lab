// Arranque de la app, ya con los datos guardados disponibles (los ha recuperado main.tsx).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import './engine/providers';
import './shell/sessions';
import { resumePipelineRuns } from './shell/pipelines';
import { startClock } from './engine/services/clock';
import { flushSave } from './engine/store';
import { flushRemote } from './engine/persistence';
import { startAcademyEngine } from './ui/academy/progress';
import { App } from './ui/App';

startClock();
resumePipelineRuns();
if (import.meta.env.DEV) {
  // Ganchos de depuración (sólo con npm run dev).
  void import('./ui/terminal/controller').then(({ terminal }) => ((window as any).__azlab = { terminal, getState: () => import('./engine/store').then((m) => m.getState()) }));
}
startAcademyEngine();
const saveNow = () => {
  flushSave();
  void flushRemote();
};
window.addEventListener('beforeunload', saveNow);
// Al cambiar de pestaña o minimizar se guarda ya: es el último aviso fiable antes de cerrar.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveNow());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
