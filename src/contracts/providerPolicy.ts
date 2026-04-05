import type {
  LlmProvider,
  OpenAiToGeminiFallbackReason,
  PersonaKey,
  ProviderGenerationResult
} from '../../analysisTypes';
import { generateWithPersonaProvider, getPersonaModelConfig } from '../../llmProviderService';

export type ProviderFallbackReason = OpenAiToGeminiFallbackReason;

/** 월간 OpenAI 예산/호출 가드 결과 — `usageTrackingService.canUseOpenAiThisMonth` 반환과 정합 */
export type OpenAiBudgetGuardResult = {
  allowed: boolean;
  reason?: string;
  summary: {
    yearMonth: string;
    callCount: number;
    estimatedCostUsd: number;
    maxCalls: number;
    budgetUsd: number;
  };
};

export type ProviderRuntimeContext = {
  discordUserId: string;
  personaKey: PersonaKey;
  personaName: string;
  /** OpenAI capability·호환 로그용 */
  analysisType?: string;
};

export type ProviderSelectionPolicy = {
  personaKey: PersonaKey;
  provider: LlmProvider;
  model: string;
};

export type ProviderExecutionResult = ProviderGenerationResult & {
  /** OpenAI가 1차 설정인데 실제 응답이 Gemini fallback인 경우만 true */
  fallbackApplied: boolean;
  fallbackReason: OpenAiToGeminiFallbackReason | null;
};

export function resolveProviderForPersona(ctx: ProviderRuntimeContext): ProviderSelectionPolicy {
  return getPersonaModelConfig(ctx.personaKey);
}

export async function executeWithProvider(params: {
  runtime: ProviderRuntimeContext;
  prompt: string;
  fallbackToGemini: () => Promise<ProviderGenerationResult>;
}): Promise<ProviderExecutionResult> {
  const result = await generateWithPersonaProvider({
    discordUserId: params.runtime.discordUserId,
    personaKey: params.runtime.personaKey,
    personaName: params.runtime.personaName,
    prompt: params.prompt,
    analysisType: params.runtime.analysisType,
    fallbackToGemini: params.fallbackToGemini
  });
  const meta = result.generation_meta;
  const fallbackApplied = meta?.openai_fallback_applied === true;
  const fallbackReason: OpenAiToGeminiFallbackReason | null = fallbackApplied
    ? meta?.openai_fallback_reason ?? 'openai_error'
    : null;
  return {
    ...result,
    fallbackApplied,
    fallbackReason
  };
}

