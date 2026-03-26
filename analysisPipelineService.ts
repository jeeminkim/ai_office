import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { AnalysisGenerationTrace, PersonaKey } from './analysisTypes';
import { loadPersonaMemory } from './personaMemoryService';
import { extractClaimsFromResponse, saveClaims, saveClaimOutcomeAuditSkeleton } from './claimLedgerService';
import type { PersonaMemory } from './analysisTypes';
import { buildPersonaEvidenceBundle } from './analysisContextService';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

function hashString(input: string): string {
  // Small deterministic hash without importing extra libs beyond Node.
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
    const traceRowBase: any = {
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
    const traceRowExtended: any = {
      ...traceRowBase,
      provider_name: params.providerName ?? null,
      model_name: params.modelName ?? null,
      estimated_cost_usd: params.estimatedCostUsd ?? null
    };

    let { error } = await supabase.from('analysis_generation_trace').insert(traceRowExtended);
    if (error) {
      logger.warn('TRACE', 'analysis_generation_trace extended insert failed; fallback to base columns', {
        message: error.message
      });
      const retry = await supabase.from('analysis_generation_trace').insert(traceRowBase);
      error = retry.error || null;
      if (error) throw error;
    }
    logger.info('TRACE', 'analysis_generation_trace stored', {
      discordUserId: params.discordUserId,
      analysisType: params.analysisType,
      personaName: params.personaName,
      providerName: params.providerName ?? null,
      modelName: params.modelName ?? null
    });
  } catch (e: any) {
    logger.warn('TRACE', 'analysis_generation_trace save failed', {
      discordUserId: params.discordUserId,
      analysisType: params.analysisType,
      personaName: params.personaName,
      message: e?.message || String(e)
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
  // best-effort
  memorySnapshot?: PersonaMemory;
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

  let claims;
  try {
    claims = extractClaimsFromResponse({
      responseText,
      analysisType,
      personaName
    });
  } catch (e: any) {
    claims = extractClaimsFromResponse({
      responseText,
      analysisType,
      personaName
    });
  }

  // Save trace first (so operators can see generation even if claims insert fails)
  const inputContextHash = hashString(
    `${analysisType}|${personaName}|${chatHistoryId ?? 'null'}|${String(responseText || '').slice(0, 220)}`
  );
  const evidenceBundle = buildPersonaEvidenceBundle({
    personaKey: params.personaKey,
    personaName,
    personaMemory,
    baseContext: baseContext ?? {}
  });

  await saveGenerationTraceBestEffort({
    discordUserId,
    chatHistoryId,
    analysisType,
    personaName,
    inputContextHash,
    memorySnapshot: personaMemory,
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

  // Audit skeleton best-effort
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
      providerName: p.providerName,
      modelName: p.modelName,
      estimatedCostUsd: p.estimatedCostUsd
    });
  }
}

