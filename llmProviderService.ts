import { logger } from './logger';
import type { LlmProvider, PersonaKey, ProviderGenerationResult, ProviderModelConfig } from './analysisTypes';
import { generateOpenAiResponse } from './openAiLlmService';
import { canUseOpenAiThisMonth, estimateOpenAiCost, recordApiUsage } from './usageTrackingService';

function fallbackEnabled(): boolean {
  return (process.env.OPENAI_FALLBACK_TO_GEMINI || 'on').toLowerCase() !== 'off';
}

function personaSystemPrompt(personaKey: PersonaKey): string {
  if (personaKey === 'HINDENBURG') {
    return '# HINDENBURG_ANALYST: 냉소적/비판적 리서치 관점의 리스크 디텍터. 반드시 downside와 구조적 리스크를 제시하고 팩트 기반으로 작성.';
  }
  if (personaKey === 'SIMONS') {
    return '# JAMES_SIMONS: 데이터/확률 기반 분석가. 가능한 범위에서 확률/구간을 제시하고 근거를 간결히 설명.';
  }
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
  return {
    personaKey,
    provider: 'gemini',
    model: 'gemini-2.5-flash'
  };
}

export async function generateWithPersonaProvider(params: {
  discordUserId: string;
  personaKey: PersonaKey;
  personaName: string;
  prompt: string;
  fallbackToGemini: () => Promise<ProviderGenerationResult>;
}): Promise<ProviderGenerationResult> {
  const traceId = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const config = getPersonaModelConfig(params.personaKey);
  logger.info('LLM_PROVIDER', 'provider selected', {
    personaKey: params.personaKey,
    personaName: params.personaName,
    provider: config.provider,
    model: config.model
  });

  if (config.provider !== 'openai') {
    return params.fallbackToGemini();
  }

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('LLM_PROVIDER', 'openai key missing; fallback to gemini', {
      personaKey: params.personaKey,
      personaName: params.personaName,
      traceId,
      model: config.model,
      fallbackReason: 'openai_api_key_missing'
    });
    return params.fallbackToGemini();
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
      return params.fallbackToGemini();
    }
    throw new Error(`OpenAI usage rejected: ${budgetGuard.reason || 'budget_guard'}`);
  }

  try {
    const openaiResult = await generateOpenAiResponse({
      prompt: params.prompt,
      model: config.model,
      systemPrompt: personaSystemPrompt(params.personaKey),
      personaName: params.personaName,
      traceId
    });

    const estimatedCostUsd = estimateOpenAiCost({
      model: config.model,
      inputTokens: openaiResult.usage?.input_tokens,
      outputTokens: openaiResult.usage?.output_tokens
    });
    openaiResult.estimated_cost_usd = estimatedCostUsd;

    await recordApiUsage({
      discord_user_id: params.discordUserId,
      persona_name: params.personaName,
      provider: 'openai',
      model: config.model,
      input_tokens: openaiResult.usage?.input_tokens ?? null,
      output_tokens: openaiResult.usage?.output_tokens ?? null,
      estimated_cost_usd: estimatedCostUsd
    });

    return openaiResult;
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
      return params.fallbackToGemini();
    }
    throw e;
  }
}
