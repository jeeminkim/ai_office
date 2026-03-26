import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import { saveAnalysisFeedbackHistory } from './feedbackService';
import { ingestPersonaFeedback } from './feedbackIngestionService';
import { resolveClaimMappingForFeedback } from './claimLedgerService';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const DISCORD_USER_ID = process.env.PHASE1_TEST_DISCORD_USER_ID || process.env.TEST_DISCORD_USER_ID || '';

function assertCondition(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

async function pickRecentChat(discordUserId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('chat_history')
    .select('id,user_id,debate_type,key_risks,simons_opportunity,created_at')
    .eq('user_id', discordUserId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

async function selfCheck() {
  if (!DISCORD_USER_ID) throw new Error('Missing PHASE1_TEST_DISCORD_USER_ID');

  const chat = await pickRecentChat(DISCORD_USER_ID);
  if (!chat?.id) throw new Error('No recent chat_history for test user');

  const chatHistoryId = Number(chat.id);
  const analysisType = String(chat.debate_type || 'unknown');
  const personaName = 'HINDENBURG_ANALYST';
  const opinionText = String(chat.key_risks || chat.simons_opportunity || '').trim() || '테스트 의견 본문';

  // 0) direct claim id / scored mapping 경로 확인
  const { data: candidateClaims } = await supabase
    .from('analysis_claims')
    .select('id')
    .eq('discord_user_id', DISCORD_USER_ID)
    .eq('chat_history_id', chatHistoryId)
    .eq('analysis_type', analysisType)
    .eq('persona_name', personaName)
    .order('created_at', { ascending: false })
    .limit(5);
  const directClaimId = String((candidateClaims || [])[0]?.id || '');

  if (directClaimId) {
    const directMapped = await resolveClaimMappingForFeedback({
      discordUserId: DISCORD_USER_ID,
      chatHistoryId,
      analysisType,
      personaName,
      feedbackOpinionText: opinionText,
      preferredClaimId: directClaimId
    });
    assertCondition(directMapped.mappingMethod === 'direct_claim_id', 'direct claim id should map as direct_claim_id');
    assertCondition(directMapped.bestClaimId === directClaimId, 'direct mapped claim id mismatch');
    logger.info('SELF_CHECK', 'direct mapping checked', directMapped);
  }

  const scoredMapped = await resolveClaimMappingForFeedback({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId,
    analysisType,
    personaName,
    feedbackOpinionText: opinionText
  });
  assertCondition(
    scoredMapped.mappingMethod === 'scored_candidate' || scoredMapped.mappingMethod === 'legacy_only',
    'scored mapping should be scored_candidate or legacy_only'
  );
  logger.info('SELF_CHECK', 'scored mapping checked', scoredMapped);

  // 1) analysis_feedback_history 저장
  const first = await saveAnalysisFeedbackHistory({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId,
    analysisType,
    personaName,
    opinionSummary: opinionText.slice(0, 180),
    opinionText,
    feedbackType: 'TRUSTED'
  });
  assertCondition(first.saved || first.duplicate, 'feedback history should be saved or treated as duplicate');
  logger.info('SELF_CHECK', 'feedback history save checked', first);

  // 2) 동일 클릭 idempotent
  const second = await saveAnalysisFeedbackHistory({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId,
    analysisType,
    personaName,
    opinionSummary: opinionText.slice(0, 180),
    opinionText,
    feedbackType: 'TRUSTED'
  });
  assertCondition(second.duplicate === true, 'second feedback click should be duplicate');
  logger.info('SELF_CHECK', 'feedback duplicate guard checked', second);

  // 3) claim_feedback 매핑 시도 + legacy fallback 허용
  const ingest = await ingestPersonaFeedback({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId,
    analysisType,
    personaName,
    feedbackType: 'TRUSTED',
    feedbackNote: 'uiux_self_check',
    opinionText,
    preferredClaimId: directClaimId || null
  });
  assertCondition(
    ingest.mappedCount >= 0 && typeof ingest.fallbackLegacyOnly === 'boolean',
    'ingest result must contain mapping/fallback state'
  );
  logger.info('SELF_CHECK', 'claim feedback mapping checked', ingest);

  // 4) 후보 없음 legacy_only
  const legacyOnly = await resolveClaimMappingForFeedback({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId: -1,
    analysisType: 'nonexistent_analysis_type',
    personaName: 'UNKNOWN_PERSONA',
    feedbackOpinionText: 'none'
  });
  assertCondition(legacyOnly.mappingMethod === 'legacy_only', 'no candidates should be legacy_only');
  logger.info('SELF_CHECK', 'legacy only mapping checked', legacyOnly);

  // 5) metadata 저장 확인
  const metadataSave = await saveAnalysisFeedbackHistory({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId,
    analysisType,
    personaName,
    opinionSummary: opinionText.slice(0, 120),
    opinionText,
    feedbackType: 'BOOKMARKED',
    mappedClaimId: ingest.bestClaimId,
    mappingMethod: ingest.mappingMethod,
    mappingScore: ingest.mappingScore
  });
  assertCondition(metadataSave.saved || metadataSave.duplicate, 'metadata save should succeed or duplicate');
  logger.info('SELF_CHECK', 'analysis_feedback_history metadata save checked', {
    metadataSave,
    mappedClaimId: ingest.bestClaimId,
    mappingMethod: ingest.mappingMethod,
    mappingScore: ingest.mappingScore
  });

  logger.info('SELF_CHECK', 'uiux stability self-check done');
}

selfCheck().catch((e) => {
  logger.error('SELF_CHECK', 'uiux stability self-check failed', e);
  process.exit(1);
});
