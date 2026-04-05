import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { FeedbackType } from './analysisTypes';
import { refreshPersonaMemoryFromFeedback } from './personaMemoryService';
import { resolveClaimMappingForFeedback, saveClaimFeedback } from './claimLedgerService';
import { isCommitteeSkippedPlaceholderResponse } from './src/services/committeeCompositionService';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export async function ingestPersonaFeedback(params: {
  discordUserId: string;
  chatHistoryId: number | null;
  analysisType: string;
  personaName: string;
  feedbackType: FeedbackType;
  feedbackNote?: string | null;
  opinionText: string;
  preferredClaimId?: string | null;
}): Promise<{
  mappedCount: number;
  fallbackLegacyOnly: boolean;
  duplicate: boolean;
  bestClaimId: string | null;
  mappingMethod: 'direct_claim_id' | 'scored_candidate' | 'legacy_only';
  mappingScore: number | null;
  candidateCount: number;
}> {
  const { discordUserId, chatHistoryId, analysisType, personaName, feedbackType, opinionText } = params;

  if (isCommitteeSkippedPlaceholderResponse(opinionText)) {
    logger.info('FEEDBACK', 'FEEDBACK_MAPPING_PLACEHOLDER_SKIPPED', {
      discordUserId,
      analysisType,
      personaName,
      chatHistoryId
    });
    return {
      mappedCount: 0,
      fallbackLegacyOnly: true,
      duplicate: false,
      bestClaimId: null,
      mappingMethod: 'legacy_only',
      mappingScore: null,
      candidateCount: 0
    };
  }

  if (!chatHistoryId) {
    logger.warn('FEEDBACK', 'ingestPersonaFeedback skipped (chatHistoryId is null)', {
      discordUserId,
      analysisType,
      personaName
    });
    return {
      mappedCount: 0,
      fallbackLegacyOnly: true,
      duplicate: false,
      bestClaimId: null,
      mappingMethod: 'legacy_only',
      mappingScore: null,
      candidateCount: 0
    };
  }

  try {
    const mapped = await resolveClaimMappingForFeedback({
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      feedbackOpinionText: opinionText,
      preferredClaimId: params.preferredClaimId ?? null
    });

    if (!mapped.bestClaimId) {
      logger.warn('FEEDBACK', 'claim_feedback fallback to legacy only', {
        discordUserId,
        analysisType,
        personaName,
        chatHistoryId,
        candidateCount: mapped.candidateCount
      });
      await refreshPersonaMemoryFromFeedback(discordUserId, personaName).catch(() => {});
      return {
        mappedCount: 0,
        fallbackLegacyOnly: true,
        duplicate: false,
        bestClaimId: null,
        mappingMethod: 'legacy_only',
        mappingScore: null,
        candidateCount: mapped.candidateCount
      };
    } else {
      const { data: exists, error: existsErr } = await supabase
        .from('claim_feedback')
        .select('id')
        .eq('discord_user_id', discordUserId)
        .eq('claim_id', mapped.bestClaimId)
        .eq('feedback_type', feedbackType)
        .order('created_at', { ascending: false })
        .limit(1);
      if (!existsErr && (exists || []).length > 0) {
        logger.warn('FEEDBACK', 'claim_feedback duplicate ignored', {
          discordUserId,
          analysisType,
          personaName,
          chatHistoryId,
          claimId: mapped.bestClaimId,
          feedbackType
        });
        await refreshPersonaMemoryFromFeedback(discordUserId, personaName).catch(() => {});
        return {
          mappedCount: 1,
          fallbackLegacyOnly: false,
          duplicate: true,
          bestClaimId: mapped.bestClaimId,
          mappingMethod: mapped.mappingMethod,
          mappingScore: mapped.mappingScore,
          candidateCount: mapped.candidateCount
        };
      }
      const saveResult = await saveClaimFeedback({
        discordUserId,
        claimId: mapped.bestClaimId,
        feedbackType,
        feedbackNote: params.feedbackNote ?? null
      });
      if (!saveResult.saved && saveResult.duplicate) {
        await refreshPersonaMemoryFromFeedback(discordUserId, personaName).catch(() => {});
        return {
          mappedCount: 1,
          fallbackLegacyOnly: false,
          duplicate: true,
          bestClaimId: mapped.bestClaimId,
          mappingMethod: mapped.mappingMethod,
          mappingScore: mapped.mappingScore,
          candidateCount: mapped.candidateCount
        };
      }
      if (!saveResult.saved) {
        logger.warn('FEEDBACK', 'claim_feedback not persisted (non-fatal)', {
          discordUserId,
          analysisType,
          personaName,
          chatHistoryId,
          claimId: mapped.bestClaimId,
          feedbackType
        });
        await refreshPersonaMemoryFromFeedback(discordUserId, personaName).catch(() => {});
        return {
          mappedCount: 0,
          fallbackLegacyOnly: true,
          duplicate: false,
          bestClaimId: mapped.bestClaimId,
          mappingMethod: mapped.mappingMethod,
          mappingScore: mapped.mappingScore,
          candidateCount: mapped.candidateCount
        };
      }
      logger.info('FEEDBACK', 'claim_feedback inserted', {
        discordUserId,
        analysisType,
        personaName,
        chatHistoryId,
        claimId: mapped.bestClaimId,
        feedbackType
      });
      logger.info('FEEDBACK', 'claim_feedback mapped count', {
        discordUserId,
        analysisType,
        personaName,
        chatHistoryId,
        mappedCount: 1,
        candidateCount: mapped.candidateCount
      });
    }

    // memory refresh trigger best-effort
    await refreshPersonaMemoryFromFeedback(discordUserId, personaName).catch(() => {});
    logger.info('FEEDBACK', 'persona memory refresh triggered', {
      discordUserId,
      personaName
    });
    return {
      mappedCount: 1,
      fallbackLegacyOnly: false,
      duplicate: false,
      bestClaimId: mapped.bestClaimId,
      mappingMethod: mapped.mappingMethod,
      mappingScore: mapped.mappingScore,
      candidateCount: mapped.candidateCount
    };
  } catch (e: any) {
    logger.warn('FEEDBACK', 'ingestPersonaFeedback failed', {
      discordUserId,
      analysisType,
      personaName,
      chatHistoryId,
      message: e?.message || String(e)
    });
    return {
      mappedCount: 0,
      fallbackLegacyOnly: true,
      duplicate: false,
      bestClaimId: null,
      mappingMethod: 'legacy_only',
      mappingScore: null,
      candidateCount: 0
    };
  }
}

