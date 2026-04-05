import { logger } from './logger';
import type {
  LlmProvider,
  LlmTaskType,
  OpenAiToGeminiFallbackReason,
  PersonaKey,
  ProviderGenerationResult,
  ProviderGenerationMeta,
  ProviderModelConfig
} from './analysisTypes';
import { generateOpenAiResponse } from './openAiLlmService';
import { canUseOpenAiThisMonth, estimateOpenAiCost, recordApiUsage } from './usageTrackingService';
import type { AiExecutionHandle } from './src/discord/aiExecution/aiExecutionHandle';
import { AiExecutionAbortedError } from './src/discord/aiExecution/aiExecutionAbort';

function fallbackEnabled(): boolean {
  return (process.env.OPENAI_FALLBACK_TO_GEMINI || 'on').toLowerCase() !== 'off';
}

function withGeminiPrimaryMeta(result: ProviderGenerationResult): ProviderGenerationResult {
  const meta: ProviderGenerationMeta = {
    configured_provider: 'gemini',
    openai_fallback_applied: false
  };
  return { ...result, generation_meta: meta };
}

function withOpenAiPrimaryMeta(result: ProviderGenerationResult): ProviderGenerationResult {
  const meta: ProviderGenerationMeta = {
    configured_provider: 'openai',
    openai_fallback_applied: false
  };
  return { ...result, generation_meta: meta };
}

async function withOpenAiFallbackMeta(
  resultPromise: Promise<ProviderGenerationResult>,
  reason: OpenAiToGeminiFallbackReason
): Promise<ProviderGenerationResult> {
  const r = await resultPromise;
  const meta: ProviderGenerationMeta = {
    configured_provider: 'openai',
    openai_fallback_applied: true,
    openai_fallback_reason: reason
  };
  return { ...r, generation_meta: meta };
}

function personaSystemPrompt(personaKey: PersonaKey): string {
  if (personaKey === 'HINDENBURG') {
    return '# HINDENBURG_ANALYST: 냉소적/비판적 리서치 관점의 리스크 디텍터. 반드시 downside와 구조적 리스크를 제시하고 팩트 기반으로 작성.';
  }
  if (personaKey === 'SIMONS') {
    return '# JAMES_SIMONS: 데이터/확률 기반 분석가. 가능한 범위에서 확률/구간을 제시하고 근거를 간결히 설명.';
  }
  if (personaKey === 'THIEL') return '# PETER_THIEL: 운영 안정성/시스템 구조/재발방지 중심으로 문제를 구조화하고 실행안을 제시.';
  if (personaKey === 'HOT_TREND') return '# HOT_TREND_ANALYST: 빠른 변화의 배경/지속성/리스크를 간결하게 분석.';
  return '간결하고 구조적으로 답변.';
}

export function getPersonaModelConfig(personaKey: PersonaKey): ProviderModelConfig {
  if (personaKey === 'HINDENBURG') {
    return {
      personaKey,
      provider: 'openai',
      model: process.env.OPENAI_MODEL_HINDENBURG || 'gpt-5-mini'
    };
  }
  if (personaKey === 'SIMONS') {
    return {
      personaKey,
      provider: 'openai',
      model: process.env.OPENAI_MODEL_SIMONS || 'gpt-5-mini'
    };
  }
  if (personaKey === 'THIEL') {
    return {
      personaKey,
      provider: 'openai',
      model: process.env.OPENAI_MODEL_THIEL || 'gpt-5-mini'
    };
  }
  if (personaKey === 'HOT_TREND') {
    return {
      personaKey,
      provider: 'openai',
      model: process.env.OPENAI_MODEL_HOT_TREND || 'gpt-5-mini'
    };
  }
  return {
    personaKey,
    provider: 'gemini',
    model: 'gemini-2.5-flash'
  };
}

const GEMINI_FLASH = 'gemini-2.5-flash';

/**
 * 작업 유형별 기본 모델 문자열 (OpenAI 페르소나는 월별 가드 경로에서 사용).
 * CIO 등 Gemini 전용 경로는 호출부에서 `generateGeminiResponse({ model: getModelForTask(...) })`로 연동.
 */
export function getModelForTask(taskType: LlmTaskType, personaKey?: PersonaKey): string {
  switch (taskType) {
    case 'PERSONA_ANALYSIS':
      if (personaKey === 'HINDENBURG') {
        return process.env.OPENAI_MODEL_PERSONA_ANALYSIS || process.env.OPENAI_MODEL_HINDENBURG || 'gpt-5-mini';
      }
      if (personaKey === 'SIMONS') {
        return process.env.OPENAI_MODEL_PERSONA_ANALYSIS || process.env.OPENAI_MODEL_SIMONS || 'gpt-5-mini';
      }
      if (personaKey === 'HOT_TREND') {
        return process.env.OPENAI_MODEL_SUMMARY || process.env.OPENAI_MODEL_HOT_TREND || 'gpt-5-mini';
      }
      if (personaKey === 'THIEL') {
        return process.env.OPENAI_MODEL_THIEL || 'gpt-5-mini';
      }
      return GEMINI_FLASH;
    case 'CIO_DECISION':
      return process.env.OPENAI_MODEL_CIO_DECISION || process.env.OPENAI_MODEL_CIO || 'gpt-5-mini';
    case 'SUMMARY':
      return process.env.GEMINI_MODEL_SUMMARY || GEMINI_FLASH;
    case 'RETRY_LIGHT':
      return process.env.GEMINI_MODEL_RETRY_LIGHT || process.env.GEMINI_MODEL_SUMMARY || GEMINI_FLASH;
    default:
      return GEMINI_FLASH;
  }
}

export async function generateWithPersonaProvider(params: {
  discordUserId: string;
  personaKey: PersonaKey;
  personaName: string;
  prompt: string;
  fallbackToGemini: () => Promise<ProviderGenerationResult>;
  /** Discord AI timeout / 취소와 연동 */
  aiExecution?: AiExecutionHandle | null;
  taskType?: LlmTaskType;
  modelOverride?: string;
  generation?: { maxOutputTokens?: number; temperature?: number };
  /** 관측성: 병렬 페르소나 슬롯 여부 */
  parallel_execution_used?: boolean;
  /** 관측성: 압축 BASE_CONTEXT 사용 여부 */
  compressed_prompt_used?: boolean;
  /** OpenAI capability·호환 로그용 */
  analysisType?: string;
}): Promise<ProviderGenerationResult> {
  const traceId = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const config = getPersonaModelConfig(params.personaKey);
  const ex = params.aiExecution;
  const openAiModel =
    params.modelOverride ??
    (params.taskType && config.provider === 'openai'
      ? getModelForTask(params.taskType, params.personaKey)
      : config.model);
  const mergedGen = (() => {
    const g = params.generation;
    if (params.taskType === 'RETRY_LIGHT' && !g) {
      return { maxOutputTokens: 320, temperature: 0.3 };
    }
    return g;
  })();

  if (ex?.shouldDiscardOutgoing()) {
    throw new AiExecutionAbortedError();
  }
  logger.info('LLM_PROVIDER', 'provider selected', {
    personaKey: params.personaKey,
    personaName: params.personaName,
    provider: config.provider,
    model: config.provider === 'openai' ? openAiModel : config.model,
    taskType: params.taskType ?? null
  });

  if (config.provider !== 'openai') {
    if (ex?.shouldDiscardOutgoing()) throw new AiExecutionAbortedError();
    const r = await params.fallbackToGemini();
    return withGeminiPrimaryMeta(r);
  }

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('LLM_PROVIDER', 'openai key missing; fallback to gemini', {
      personaKey: params.personaKey,
      personaName: params.personaName,
      traceId,
      model: config.model,
      fallbackReason: 'openai_api_key_missing'
    });
    logger.info('PHASE1_CHECK', 'fallback_triggered', {
      reason: 'openai_api_key_missing',
      personaKey: params.personaKey
    });
    return withOpenAiFallbackMeta(params.fallbackToGemini(), 'openai_api_key_missing');
  }

  const budgetGuard = await canUseOpenAiThisMonth({
    discordUserId: params.discordUserId,
    personaName: params.personaName
  });
  if (!budgetGuard.allowed) {
    logger.warn('LLM_PROVIDER', 'openai usage rejected by monthly guard', {
      personaKey: params.personaKey,
      personaName: params.personaName,
      reason: budgetGuard.reason
    });
    if (fallbackEnabled()) {
      logger.warn('LLM_PROVIDER', 'fallback to gemini', {
        personaKey: params.personaKey,
        reason: budgetGuard.reason,
        traceId,
        personaName: params.personaName,
        model: config.model,
        fallbackReason: budgetGuard.reason || 'budget_guard'
      });
      logger.info('PHASE1_CHECK', 'fallback_triggered', {
        reason: 'budget_guard',
        detail: budgetGuard.reason || null,
        personaKey: params.personaKey
      });
      return withOpenAiFallbackMeta(params.fallbackToGemini(), 'budget_guard');
    }
    throw new Error(`OpenAI usage rejected: ${budgetGuard.reason || 'budget_guard'}`);
  }

  try {
    if (ex?.shouldDiscardOutgoing()) throw new AiExecutionAbortedError();
    const openaiResult = await generateOpenAiResponse({
      prompt: params.prompt,
      model: openAiModel,
      systemPrompt: personaSystemPrompt(params.personaKey),
      personaName: params.personaName,
      traceId,
      personaKey: params.personaKey,
      analysisType: params.analysisType,
      abortSignal: ex?.signal,
      onResponseId: id => ex?.registerOpenAiResponseId(id),
      maxOutputTokens: mergedGen?.maxOutputTokens,
      temperature: mergedGen?.temperature
    });

    const estimatedCostUsd = estimateOpenAiCost({
      model: openAiModel,
      inputTokens: openaiResult.usage?.input_tokens,
      outputTokens: openaiResult.usage?.output_tokens
    });
    openaiResult.estimated_cost_usd = estimatedCostUsd;

    await recordApiUsage({
      discord_user_id: params.discordUserId,
      persona_name: params.personaName,
      provider: 'openai',
      model: openAiModel,
      input_tokens: openaiResult.usage?.input_tokens ?? null,
      output_tokens: openaiResult.usage?.output_tokens ?? null,
      estimated_cost_usd: estimatedCostUsd
    });

    logger.info('AI_PERF', 'llm_openai_complete', {
      traceId,
      personaKey: params.personaKey,
      model_used: openAiModel,
      parallel_execution_used: params.parallel_execution_used ?? false,
      compressed_prompt_used: params.compressed_prompt_used ?? false,
      prompt_token_estimate: Math.ceil(params.prompt.length / 4),
      response_token_estimate:
        openaiResult.usage?.output_tokens ?? Math.ceil((openaiResult.text || '').length / 4)
    });

    return withOpenAiPrimaryMeta({ ...openaiResult, model: openAiModel });
  } catch (e: any) {
    logger.warn('LLM_PROVIDER', 'openai failed', {
      personaKey: params.personaKey,
      personaName: params.personaName,
      message: e?.message || String(e)
    });
    if (fallbackEnabled()) {
      logger.warn('LLM_PROVIDER', 'fallback to gemini', {
        personaKey: params.personaKey,
        reason: 'openai_error',
        traceId,
        personaName: params.personaName,
        model: config.model
      });
      logger.info('PHASE1_CHECK', 'fallback_triggered', {
        reason: 'openai_error',
        personaKey: params.personaKey
      });
      return withOpenAiFallbackMeta(params.fallbackToGemini(), 'openai_error');
    }
    throw e;
  }
}
