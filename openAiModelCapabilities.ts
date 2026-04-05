/**
 * OpenAI Responses API(`responses.create`) 기준 모델별 지원 파라미터.
 * 미등록 모델은 보수적으로 temperature 등을 허용(기존 동작 유지); gpt-5* 계열은 temperature 미지원이 일반적.
 */

export type OpenAiModelCapabilities = {
  supportsTemperature: boolean;
  supportsMaxOutputTokens: boolean;
  /** 향후 reasoning_effort 등 확장용 */
  supportsReasoningEffort: boolean;
};

const DEFAULT_CAPS: OpenAiModelCapabilities = {
  supportsTemperature: true,
  supportsMaxOutputTokens: true,
  supportsReasoningEffort: false
};

/** 정규화: 비교용 소문자 문자열(env에 버전 접미사가 붙어도 prefix로 판별) */
export function normalizeOpenAiModelId(model: string): string {
  return String(model || '').trim().toLowerCase();
}

function capsForNormalizedId(norm: string): OpenAiModelCapabilities {
  if (norm.startsWith('gpt-5') || /^o[0-9]/.test(norm) || norm.startsWith('o1') || norm.startsWith('o3')) {
    return {
      supportsTemperature: false,
      supportsMaxOutputTokens: true,
      supportsReasoningEffort: false
    };
  }
  return { ...DEFAULT_CAPS };
}

export function getOpenAiModelCapabilities(model: string): OpenAiModelCapabilities {
  const norm = normalizeOpenAiModelId(model);
  return capsForNormalizedId(norm);
}
