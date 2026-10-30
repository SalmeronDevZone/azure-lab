// Registro de blades específicos por tipo de recurso.
import type { TypeBlade } from './shared';
import { COMPUTE_BLADES } from './compute';
import { NETWORK_BLADES } from './network';
import { STORAGE_BLADES } from './storage';
import { WEB_BLADES } from './web';
import { DATA_BLADES } from './data';
import { CONTAINER_BLADES } from './containers';
import { MONITOR_BLADES } from './monitor';
import { INTEGRATION_BLADES } from './integration';

const ALL: Record<string, TypeBlade> = { ...COMPUTE_BLADES, ...NETWORK_BLADES, ...STORAGE_BLADES, ...WEB_BLADES, ...DATA_BLADES, ...CONTAINER_BLADES, ...MONITOR_BLADES, ...INTEGRATION_BLADES };

export function typeBlade(type: string): TypeBlade {
  return ALL[type.toLowerCase()] ?? {};
}

export type { TypeBlade } from './shared';
