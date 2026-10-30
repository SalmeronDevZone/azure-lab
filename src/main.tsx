// Punto de entrada. Primero recupera tus datos (del servidor del contenedor si lo hay; si no, del navegador)
// y sólo entonces carga la app, porque la nube y el progreso se leen al cargar sus módulos.
import { hydrate } from './engine/persistence';

void hydrate().then(() => import('./boot'));
