import { logger } from '../../logger';

function isSchemaMismatchError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || '').toLowerCase();
  return (
    message.includes('schema cache') ||
    message.includes('column') ||
    message.includes('does not exist') ||
    message.includes('could not find')
  );
}

export function logSchemaSafeInsertFailure(table: string, payload: Record<string, unknown>, error: unknown) {
  const payloadKeys = Object.keys(payload);
  const scope = `DB][${table}][insert`;
  logger.error(scope, 'insert failed', {
    table,
    payloadKeys,
    errorMessage: (error as { message?: string })?.message || String(error),
    errorCode: (error as { code?: string })?.code || null,
    hint: isSchemaMismatchError(error) ? 'column mismatch suspected: check DB schema and payload keys' : null
  });
}
