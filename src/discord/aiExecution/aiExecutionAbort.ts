export class AiExecutionAbortedError extends Error {
  override name = 'AiExecutionAbortedError';
  constructor(message = 'AI execution aborted or discarded') {
    super(message);
    Object.setPrototypeOf(this, AiExecutionAbortedError.prototype);
  }
}

export function isAiExecutionAbortedError(e: unknown): boolean {
  return e instanceof AiExecutionAbortedError || (e as any)?.name === 'AiExecutionAbortedError';
}

export function assertActiveExecution(handle?: import('./aiExecutionHandle').AiExecutionHandle | null, phase?: string): void {
  if (!handle) return;
  if (handle.shouldDiscardOutgoing()) {
    handle.logResultDiscarded('assertActiveExecution', { phase: phase ?? null });
    throw new AiExecutionAbortedError();
  }
}
