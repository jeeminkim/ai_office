export type PersonaKey = 'RAY' | 'HINDENBURG' | 'JYP' | 'SIMONS' | 'DRUCKER' | 'CIO' | 'TREND' | 'OPEN_TOPIC' | 'THIEL' | 'HOT_TREND';

export type FeedbackType = 'TRUSTED' | 'ADOPTED' | 'BOOKMARKED' | 'DISLIKED' | 'REJECTED';

export type ClaimType =
  | 'MACRO'
  | 'RISK'
  | 'ALLOCATION'
  | 'EXECUTION'
  | 'VALUATION'
  | 'BEHAVIOR'
  | 'LIQUIDITY'
  | 'OPEN_TOPIC'
  | 'OTHER';

export type EvidenceScope = 'PORTFOLIO' | 'CASHFLOW' | 'EXPENSE' | 'MARKET' | 'GENERAL' | 'NONE';

export type PersonaMemory = {
  id?: string;
  discord_user_id: string;
  persona_name: string;
  memory_version?: number;
  accepted_patterns?: any;
  rejected_patterns?: any;
  style_bias?: any;
  confidence_calibration?: any;
  evidence_preferences?: any;
  last_feedback_summary?: string | null;
  last_refreshed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type AnalysisClaim = {
  id?: string;
  discord_user_id: string;
  chat_history_id: number | null;
  analysis_type: string;
  persona_name: string;
  claim_order: number;
  claim_type: ClaimType;
  claim_text: string;
  claim_summary: string;
  evidence_scope: EvidenceScope;
  evidence_refs?: any;
  confidence_score: number;
  novelty_score: number;
  usefulness_score: number;
  has_numeric_anchor: boolean;
  is_actionable: boolean;
  is_downside_focused: boolean;
};

export type AnalysisGenerationTrace = {
  id?: string;
  discord_user_id: string;
  chat_history_id: number | null;
  analysis_type: string;
  persona_name: string;
  input_context_hash?: string | null;
  memory_snapshot?: any;
  evidence_snapshot?: any;
  output_summary?: string | null;
  latency_ms?: number | null;
  token_hint_in?: number | null;
  token_hint_out?: number | null;
};

export type PersonaEvidenceBundle = {
  portfolio_snapshot?: any;
  user_profile?: any;
  recent_claims?: any;
  recent_feedback?: any;
  mode?: string;
};

export type PersonaPromptContext = {
  persona_name: string;
  persona_key: PersonaKey;
  memory_directive: string;
};

export type LlmProvider = 'gemini' | 'openai';

export type ProviderModelConfig = {
  personaKey: PersonaKey;
  provider: LlmProvider;
  model: string;
};

/** OpenAI가 1차로 선택됐으나 Gemini 응답으로 대체된 경우만 의미 있다. */
export type OpenAiToGeminiFallbackReason = 'openai_api_key_missing' | 'budget_guard' | 'openai_error';

export type ProviderGenerationMeta = {
  configured_provider: LlmProvider;
  openai_fallback_applied: boolean;
  openai_fallback_reason?: OpenAiToGeminiFallbackReason;
};

export type ProviderGenerationResult = {
  text: string;
  provider: LlmProvider;
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  estimated_cost_usd?: number;
  generation_meta?: ProviderGenerationMeta;
};

export type UsageTrackingRow = {
  id?: string;
  discord_user_id: string;
  persona_name: string;
  provider: LlmProvider;
  model: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  estimated_cost_usd: number;
  year_month: string;
  created_at?: string | null;
};

/** 작업별 모델 라우팅 (`llmProviderService.getModelForTask`) */
export type LlmTaskType = 'PERSONA_ANALYSIS' | 'CIO_DECISION' | 'SUMMARY' | 'RETRY_LIGHT';

/** Gemini `generateContent` 등 호출부 공통 출력 상한·온도 */
export type AgentGenCaps = {
  maxOutputTokens?: number;
  temperature?: number;
};

