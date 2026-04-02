import { findChatHistoryById } from '../../../repositories/chatHistoryRepository';
import { saveAnalysisFeedbackHistory, type FeedbackType } from '../../../../feedbackService';
import { ingestPersonaFeedback } from '../../../../feedbackIngestionService';
import { personaKeyToDisplayNameForFeedback } from '../../personaDisplay';
import type { DiscordInteractionContext } from '../../InteractionContext';

export async function handleFeedbackSaveButtonInteraction(
  interaction: any,
  ctx: DiscordInteractionContext
): Promise<void> {
  const cid = interaction.customId as string;
  const discordUserId = ctx.getDiscordUserId(interaction.user);
  await ctx.interactions.safeDeferReply(interaction, { flags: 64 });

  const prefix = 'feedback:save:';
  const rest = cid.slice(prefix.length);
  const m = /^(\d+):([^:]+):(TRUSTED|ADOPTED|BOOKMARKED|DISLIKED|REJECTED):([A-Z0-9_]+)$/.exec(rest);
  if (!m) {
    ctx.logger.warn('FEEDBACK', 'invalid feedback customId', { cid });
    await ctx.interactions.safeEditReply(interaction, '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'feedback:failure');
    return;
  }

  const chatHistoryId = Number(m[1]);
  const analysisType = m[2];
  const feedbackType = m[3] as FeedbackType;
  const personaKey = m[4];

  if (!Number.isFinite(chatHistoryId) || chatHistoryId <= 0) {
    await ctx.interactions.safeEditReply(interaction, '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'feedback:failure');
    return;
  }

  ctx.logger.info('FEEDBACK', 'feedback button clicked', {
    chatHistoryId,
    analysisType,
    feedbackType,
    personaKey,
    discordUserId
  });

  const personaName = personaKeyToDisplayNameForFeedback(personaKey);

  try {
    const chatRow = await findChatHistoryById(chatHistoryId);
    if (!chatRow) {
      await ctx.interactions.safeEditReply(interaction, '연결된 분석 기록을 찾을 수 없습니다.', 'feedback:not_found');
      return;
    }
    if (String((chatRow as { user_id?: string }).user_id) !== String(discordUserId)) {
      await ctx.interactions.safeEditReply(interaction, '본인 분석에 대한 피드백만 저장할 수 있습니다.', 'feedback:forbidden');
      return;
    }

    const saveResult = await saveAnalysisFeedbackHistory({
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      opinionSummary: `button:${feedbackType}`,
      opinionText: `button:${feedbackType}`,
      feedbackType,
      feedbackNote: null,
      topicTags: []
    });

    if (saveResult.duplicate) {
      ctx.logger.warn('FEEDBACK', 'duplicate ignored', {
        scope: 'analysis_feedback_history',
        chatHistoryId,
        analysisType,
        feedbackType,
        personaKey,
        discordUserId
      });
      await ctx.interactions.safeEditReply(interaction, '이미 같은 피드백이 저장되어 있습니다.', 'feedback:duplicate');
      return;
    }

    ctx.logger.info('FEEDBACK', 'feedback history saved', {
      chatHistoryId,
      analysisType,
      feedbackType,
      personaName,
      discordUserId
    });

    const ingestResult = await ingestPersonaFeedback({
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      feedbackType,
      opinionText: `button:${feedbackType}`,
      feedbackNote: null
    });

    ctx.logger.info('FEEDBACK', 'feedback ingestion result', {
      chatHistoryId,
      analysisType,
      feedbackType,
      personaName,
      duplicate: ingestResult.duplicate,
      mappedCount: ingestResult.mappedCount,
      bestClaimId: ingestResult.bestClaimId,
      mappingMethod: ingestResult.mappingMethod,
      discordUserId
    });

    if (ingestResult.duplicate) {
      ctx.logger.warn('FEEDBACK', 'duplicate ignored', {
        scope: 'claim_feedback',
        chatHistoryId,
        analysisType,
        feedbackType,
        personaKey,
        discordUserId
      });
      await ctx.interactions.safeEditReply(interaction, '이미 반영된 피드백입니다.', 'feedback:claim_duplicate');
      return;
    }

    await ctx.interactions.safeEditReply(interaction, `피드백 저장 완료: ${feedbackType}`, 'feedback:success');
  } catch (e: unknown) {
    ctx.logger.error('FEEDBACK', 'handler failed', {
      message: e instanceof Error ? e.message : String(e),
      chatHistoryId,
      analysisType,
      feedbackType,
      personaKey,
      discordUserId
    });
    await ctx.interactions.safeEditReply(
      interaction,
      '일시적인 저장 오류입니다. 잠시 후 다시 시도해 주세요.',
      'feedback:failure'
    );
  }
}
