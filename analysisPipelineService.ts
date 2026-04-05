import { logger } from './logger';
import { isDecisionPrompt } from './decisionPrompt';
import type { PersonaKey } from './analysisTypes';
import { loadPersonaMemory } from './personaMemoryService';
import { saveClaims, saveClaimOutcomeAuditSkeleton } from './claimLedgerService';
import type { PersonaMemory } from './analysisTypes';
import { buildPersonaEvidenceBundle } from './analysisContextService';
import { extractClaimsByContract, type ClaimExtractionResult } from './src/contracts/claimContract';
import { isCommitteeSkippedPlaceholderResponse } from './src/services/committeeCompositionService';
import { insertGenerationTraceExtendedOrBase } from './src/repositories/generationTraceRepository';
import { dbPersistFallbackResult } from './src/contracts/fallbackPolicy';

function hashString(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return String(h);
}

async function saveGenerationTraceBestEffort(params: {
  discordUserId: string;
  chatHistoryId: number | null;
  analysisType: string;
  personaName: string;
  inputContextHash?: string | null;
  memorySnapshot?: any;
  evidenceSnapshot?: any;
  outputSummary?: string | null;
  providerName?: string | null;
  modelName?: string | null;
  estimatedCostUsd?: number | null;
}): Promise<void> {
  try {
    const traceRowBase = {
      discord_user_id: params.discordUserId,
      chat_history_id: params.chatHistoryId,
      analysis_type: params.analysisType,
      persona_name: params.personaName,
      input_context_hash: params.inputContextHash ?? null,
      memory_snapshot: params.memorySnapshot ?? {},
      evidence_snapshot: params.evidenceSnapshot ?? {},
      output_summary: params.outputSummary ?? null,
      latency_ms: null,
      token_hint_in: null,
      token_hint_out: null
    };
    const traceRowExtended = {
      ...traceRowBase,
      provider_name: params.providerName ?? null,
      model_name: params.modelName ?? null,
      estimated_cost_usd: params.estimatedCostUsd ?? null
    };
    await insertGenerationTraceExtendedOrBase({
      extended: traceRowExtended as any,
      base: traceRowBase as any
    });
    logger.info('PHASE1_CHECK', 'trace_saved', {
      personaName: params.personaName,
      analysisType: params.analysisType,
      chatHistoryId: params.chatHistoryId
    });
  } catch (e: any) {
    const fb = dbPersistFallbackResult(true, e?.message || String(e));
    logger.warn('TRACE', 'analysis_generation_trace save failed', {
      discordUserId: params.discordUserId,
      analysisType: params.analysisType,
      personaName: params.personaName,
      message: e?.message || String(e),
      fallbackContract: fb
    });
  }
}

export async function persistAnalysisArtifacts(params: {
  discordUserId: string;
  chatHistoryId: number | null;
  analysisType: string;
  personaKey: PersonaKey;
  personaName: string;
  responseText: string;
  baseContext?: any;
  memorySnapshot?: PersonaMemory;
  /** CIO trace에만 병합: 피드백 소프트 보정 메타(새 테이블 없음) */
  feedbackAdjustmentMeta?: Record<string, unknown> | null;
  providerName?: string;
  modelName?: string;
  estimatedCostUsd?: number;
}): Promise<void> {
  const { discordUserId, chatHistoryId, analysisType, personaName, responseText, baseContext } = params;

  const personaMemory = params.memorySnapshot ?? (await loadPersonaMemory(discordUserId, personaName));

  logger.info('PIPELINE', 'persistAnalysisArtifacts started', {
    discordUserId,
    analysisType,
    personaName,
    chatHistoryId
  });

  if (responseText && isDecisionPrompt(responseText)) {
    logger.info('DECISION', 'DECISION_PROMPT detected', {
      chatHistoryId,
      analysisType,
      personaName
    });
  }

  const skipClaims = isCommitteeSkippedPlaceholderResponse(responseText);
  if (skipClaims) {
    logger.info('PIPELINE', 'CLAIM_EXTRACTION_PLACEHOLDER_SKIPPED', {
      discordUserId,
      analysisType,
      personaName,
      chatHistoryId
    });
  }

  const extraction: ClaimExtractionResult = skipClaims
    ? { claims: [], fallbackUsed: false }
    : extractClaimsByContract({
        responseText,
        analysisType,
        personaName
      });
  const claims = extraction.claims;
  if (!skipClaims && extraction.fallbackUsed) {
    logger.info('CLAIMS', 'extraction contract: single-claim fallback path', { personaName, analysisType });
  }

  const inputContextHash = hashString(
    `${analysisType}|${personaName}|${chatHistoryId ?? 'null'}|${String(responseText || '').slice(0, 220)}`
  );
  const evidenceBundle = buildPersonaEvidenceBundle({
    personaKey: params.personaKey,
    personaName,
    personaMemory,
    baseContext: baseContext ?? {}
  });

  const memoryForTrace =
    params.feedbackAdjustmentMeta && params.personaKey === 'CIO'
      ? { ...(personaMemory as any), feedback_adjustment_meta: params.feedbackAdjustmentMeta }
      : personaMemory;

  await saveGenerationTraceBestEffort({
    discordUserId,
    chatHistoryId,
    analysisType,
    personaName,
    inputContextHash,
    memorySnapshot: memoryForTrace,
    evidenceSnapshot: evidenceBundle,
    outputSummary: String(claims?.[0]?.claim_summary || null),
    providerName: params.providerName ?? null,
    modelName: params.modelName ?? null,
    estimatedCostUsd: params.estimatedCostUsd ?? null
  });

  const saved = await saveClaims({
    discordUserId,
    chatHistoryId,
    analysisType,
    personaName,
    claims
  });
  logger.info('PHASE1_CHECK', 'claim_count', {
    savedCount: saved.savedCount,
    personaName,
    analysisType,
    chatHistoryId
  });
  if (saved.savedCount === 0 && claims.length > 0) {
    const fb = dbPersistFallbackResult(true, 'analysis_claims insert returned empty');
    logger.warn('PIPELINE', 'claims persist empty', { personaName, analysisType, fallbackContract: fb });
  }

  if (saved.savedClaimIds.length) {
    await Promise.all(
      saved.savedClaimIds.slice(0, 12).map(cid => saveClaimOutcomeAuditSkeleton({ discordUserId, claimId: cid }))
    );
  }

  if (saved.savedCount > 0) {
    logger.info('PIPELINE', 'persistAnalysisArtifacts completed', {
      discordUserId,
      analysisType,
      personaName,
      savedClaims: saved.savedCount
    });
  } else {
    logger.warn('PIPELINE', 'persistAnalysisArtifacts completed with empty claims', {
      discordUserId,
      analysisType,
      personaName
    });
  }
}

export async function runAnalysisPipeline(params: {
  discordUserId: string;
  chatHistoryId: number | null;
  analysisType: string;
  personaOutputs: Array<{
    personaKey: PersonaKey;
    personaName: string;
    responseText: string;
    providerName?: string;
    modelName?: string;
    estimatedCostUsd?: number;
  }>;
  baseContext?: any;
  /** CIO persona trace memory_snapshot에만 합류 */
  feedbackAdjustmentMetaForCio?: Record<string, unknown> | null;
}): Promise<void> {
  const { personaOutputs } = params;
  for (const p of personaOutputs) {
    await persistAnalysisArtifacts({
      discordUserId: params.discordUserId,
      chatHistoryId: params.chatHistoryId,
      analysisType: params.analysisType,
      personaKey: p.personaKey,
      personaName: p.personaName,
      responseText: p.responseText,
      baseContext: params.baseContext,
      feedbackAdjustmentMeta:
        p.personaKey === 'CIO' ? params.feedbackAdjustmentMetaForCio ?? null : null,
      providerName: p.providerName,
      modelName: p.modelName,
      estimatedCostUsd: p.estimatedCostUsd
    });
  }
}
