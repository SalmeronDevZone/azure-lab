// Error con forma de respuesta de Azure Resource Manager.
export class ArmError extends Error {
  code: string;
  status: number;
  /** Texto adicional (consejo didáctico) que el simulador muestra tras el error. */
  tip?: string;

  constructor(code: string, message: string, status = 400, tip?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.tip = tip;
  }
}

export function isArmError(e: unknown): e is ArmError {
  return e instanceof ArmError;
}

export function errorText(e: unknown): string {
  if (e instanceof ArmError) return `(${e.code}) ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
