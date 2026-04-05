import { logger } from './logger';
import type { ProviderGenerationResult } from './analysisTypes';
import { AiExecutionAbortedError } from './src/discord/aiExecution/aiExecutionAbort';

export async function generateOpenAiResponse(params: {
  prompt: string;
  model: string;
  systemPrompt?: string;
  personaName?: string;
  traceId?: string;
  /** Responses API 응답 id — timeout 시 cancel 시도용 */
  onResponseId?: (id: string) => void;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<ProviderGenerationResult> {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const traceId = params.traceId || `openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const cwd = process.cwd();
  const nodePath = process.execPath;
  logger.info('OPENAI', 'openai sdk require started', {
    traceId,
    cwd,
    hasApiKey: !!apiKey,
    nodePath
  });
  if (!apiKey) {
    logger.warn('OPENAI', 'openai sdk require failed', {
      traceId,
      cwd,
      hasApiKey: false,
      nodePath,
      message: 'OPENAI_API_KEY is missing'
    });
    throw new Error('OPENAI_API_KEY is missing');
  }

  let OpenAI: any;
  let packageVersion: string | null = null;
  try {
    // Use runtime require to keep build resilient even before npm install.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    OpenAI = require('openai');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      packageVersion = require('openai/package.json')?.version || null;
    } catch {
      packageVersion = null;
    }
    logger.info('OPENAI', 'openai sdk require succeeded', {
      traceId,
      cwd,
      hasApiKey: true,
      nodePath,
      packageVersion
    });
  } catch (e: any) {
    logger.error('OPENAI', 'openai sdk require failed', {
      traceId,
      cwd,
      hasApiKey: true,
      nodePath,
      message: e?.message || String(e),
      stack: String(e?.stack || '').slice(0, 500)
    });
    throw e;
  }

  logger.info('OPENAI', 'openai client init started', {
    traceId,
    provider: 'openai',
    model: params.model,
    apiKeyPresent: true,
    timeoutConfigured: false
  });
  let client: any;
  try {
    client = new OpenAI({ apiKey });
    logger.info('OPENAI', 'openai client init succeeded', {
      traceId,
      provider: 'openai',
      model: params.model,
      apiKeyPresent: true,
      timeoutConfigured: false
    });
  } catch (e: any) {
    logger.error('OPENAI', 'openai client init failed', {
      traceId,
      provider: 'openai',
      model: params.model,
      apiKeyPresent: true,
      timeoutConfigured: false,
      message: e?.message || String(e)
    });
    throw e;
  }
  const input = params.systemPrompt
    ? [
        { role: 'system' as const, content: params.systemPrompt },
        { role: 'user' as const, content: params.prompt }
      ]
    : params.prompt;

  logger.info('OPENAI', 'openai request started', {
    traceId,
    personaName: params.personaName || null,
    model: params.model,
    promptLength: String(params.prompt || '').length,
    systemPromptLength: String(params.systemPrompt || '').length
  });
  if (params.abortSignal?.aborted) {
    throw new AiExecutionAbortedError('aborted before openai request');
  }
  const createBody: Record<string, unknown> = {
    model: params.model,
    input
  };
  if (params.maxOutputTokens != null) createBody.max_output_tokens = params.maxOutputTokens;
  if (params.temperature != null) createBody.temperature = params.temperature;

  let response: any;
  try {
    response = await client.responses.create(createBody as any);
  } catch (e: any) {
    logger.error('OPENAI', 'openai request failed', {
      traceId,
      personaName: params.personaName || null,
      model: params.model,
      promptLength: String(params.prompt || '').length,
      systemPromptLength: String(params.systemPrompt || '').length,
      reason: e?.message || String(e)
    });
    throw e;
  }

  const rid = typeof (response as any)?.id === 'string' ? (response as any).id : null;
  if (rid) {
    try {
      params.onResponseId?.(rid);
    } catch {
      // ignore registry errors
    }
  }

  if (params.abortSignal?.aborted) {
    throw new AiExecutionAbortedError('aborted after openai response received');
  }

  const text = String((response as any).output_text || '').trim();
  if (!text) {
    logger.warn('OPENAI', 'empty output text from responses API', { model: params.model });
  }

  const usageRaw: any = (response as any).usage || {};
  const usage = {
    input_tokens: typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : undefined,
    output_tokens: typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : undefined,
    total_tokens: typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined
  };
  logger.info('OPENAI', 'openai usage parsed', {
    traceId,
    personaName: params.personaName || null,
    model: params.model,
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null
  });

  logger.info('OPENAI', 'openai request completed', {
    traceId,
    personaName: params.personaName || null,
    model: params.model,
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    textLength: text.length
  });

  return {
    text,
    provider: 'openai',
    model: params.model,
    usage
  };
}
