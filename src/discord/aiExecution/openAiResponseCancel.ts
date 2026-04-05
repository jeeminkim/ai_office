import { logger } from '../../../logger';

export type OpenAiCancelResult = 'ok' | 'failed' | 'unavailable';

/**
 * Responses API response id 취소 시도. background=false 응답은 API상 취소 불가일 수 있음 → failed 처리.
 */
export async function tryCancelOpenAiResponses(responseId: string): Promise<OpenAiCancelResult> {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return 'unavailable';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });
    if (typeof client.responses?.cancel !== 'function') {
      logger.warn('AI_EXECUTION', 'openai_responses_cancel_unavailable', { responseId });
      return 'unavailable';
    }
    await client.responses.cancel(responseId);
    return 'ok';
  } catch (e: any) {
    logger.warn('AI_EXECUTION', 'openai_responses_cancel_error', {
      responseId,
      message: e?.message || String(e)
    });
    return 'failed';
  }
}
