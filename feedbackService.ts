import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import { aggregateProfileFromFeedbackHistory } from './profileService';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export type FeedbackType = 'TRUSTED' | 'ADOPTED' | 'BOOKMARKED' | 'DISLIKED' | 'REJECTED';

export async function saveAnalysisFeedbackHistory(params: {
  discordUserId: string;
  chatHistoryId: number;
  analysisType: string;
  personaName: string;
  opinionSummary: string;
  opinionText: string;
  feedbackType: FeedbackType;
  feedbackNote?: string | null;
  topicTags?: string[];
  mappedClaimId?: string | null;
  mappingMethod?: string | null;
  mappingScore?: number | null;
}): Promise<{ saved: boolean; duplicate: boolean }> {
  try {
    const {
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      opinionSummary,
      opinionText,
      feedbackType,
      feedbackNote,
      topicTags,
      mappedClaimId,
      mappingMethod,
      mappingScore
    } = params;

    const payload: any = {
      discord_user_id: discordUserId,
      chat_history_id: chatHistoryId,
      analysis_type: analysisType,
      persona_name: personaName,
      opinion_summary: opinionSummary,
      opinion_text: opinionText,
      feedback_type: feedbackType,
      feedback_note: feedbackNote ?? null,
      topic_tags: topicTags ?? [],
      mapped_claim_id: mappedClaimId ?? null,
      mapping_method: mappingMethod ?? null,
      mapping_score: mappingScore ?? null
    };

    // Harmless idempotency guard for repeated button clicks
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentDup, error: dupErr } = await supabase
      .from('analysis_feedback_history')
      .select('id,created_at')
      .eq('discord_user_id', discordUserId)
      .eq('chat_history_id', chatHistoryId)
      .eq('persona_name', personaName)
      .eq('feedback_type', feedbackType)
      .gte('created_at', tenMinutesAgo)
      .order('created_at', { ascending: false })
      .limit(1);
    if (dupErr) {
      logger.warn('PROFILE', 'feedback duplicate check failed; continue insert', {
        message: dupErr.message
      });
    } else if ((recentDup || []).length > 0) {
      logger.warn('PROFILE', 'feedback duplicate ignored', {
        discordUserId,
        chatHistoryId,
        personaName,
        feedbackType
      });
      return { saved: false, duplicate: true };
    }

    const { error } = await supabase.from('analysis_feedback_history').insert(payload);
    if (error) throw error;

    logger.info('PROFILE', 'feedback stored', {
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      feedbackType,
      mappedClaimId: mappedClaimId ?? null,
      mappingMethod: mappingMethod ?? null,
      mappingScore: mappingScore ?? null
    });
    logger.info('FEEDBACK', 'analysis_feedback_history saved with mapped claim metadata', {
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      mappedClaimId: mappedClaimId ?? null,
      mappingMethod: mappingMethod ?? null,
      mappingScore: mappingScore ?? null
    });
    logger.info('DB', 'DB insert feedback success', { discordUserId, personaName, feedbackType });

    await aggregateProfileFromFeedbackHistory(discordUserId);
    return { saved: true, duplicate: false };
  } catch (e: any) {
    logger.error('PROFILE', 'save feedback failed', {
      message: e?.message || String(e)
    });
    throw e;
  }
}

