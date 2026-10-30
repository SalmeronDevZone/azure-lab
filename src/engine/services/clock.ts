// Reloj del simulador: avanza clústeres, evalúa alertas, escalado automático y costes.
import { getState } from '../store';
import { tickKube } from './kube';
import { evaluateAlerts, evaluateAutoscale } from './monitor';
import { accrueCosts } from './cost';
import { enforceAutoShutdown } from './compute';

let started = false;

export function startClock() {
  if (started || typeof window === 'undefined') return;
  started = true;
  let n = 0;
  setInterval(() => {
    n++;
    const s = getState();
    try {
      tickKube(s);
      if (n % 3 === 0) evaluateAlerts(s);
      if (n % 4 === 0) evaluateAutoscale(s);
      if (n % 3 === 1) accrueCosts(s);
      if (n % 10 === 0) enforceAutoShutdown(s);
    } catch (e) {
      console.error('Error en el reloj del simulador', e);
    }
  }, 2000);
}
