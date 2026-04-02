import { splitDiscordMessage } from '../../../../discordResponseUtils';
import { extractDecisionOptions } from '../../../../decisionPrompt';
import { executeDecisionAfterSelection } from '../../../../decisionExecutionService';
import { getDecisionSnapshotById, insertDecisionHistoryRow } from '../../../repositories/decisionRepository';
import type { DiscordInteractionContext } from '../../InteractionContext';

function decisionTopicHintForContext(analysisType: string): string {
  if (/PORTFOLIO|DEBATE|COMMITTEE|AI_|REBALANCE/i.test(analysisType)) return 'rebalance_strategy';
  if (/TREND/i.test(analysisType)) return 'trend';
  return 'general';
}

export async function handleDecisionButtonInteraction(
  interaction: any,
  ctx: DiscordInteractionContext
): Promise<void> {
  const cid = interaction.customId as string;
  const discordUserId = ctx.getDiscordUserId(interaction.user);
  const mUuid = /^decision:select\|([0-9a-f-]{36})\|(\d+)$/i.exec(cid);
  const mLegacy = /^decision:select\|(\d+)\|(\d+)$/.exec(cid);

  let chatHistoryId = 0;
  let optIndex = 0;
  let options: string[] = [];
  let analysisType = '';
  let personaKey: string | null = null;

  if (mUuid) {
    const snapshotId = mUuid[1];
    optIndex = Number(mUuid[2]);
    const snap = await getDecisionSnapshotById(snapshotId);
    if (!snap || snap.discord_user_id !== discordUserId) {
      ctx.logger.warn('DECISION', 'snapshot missing or user mismatch', { snapshotId });
      await ctx.interactions.safeDeferReply(interaction, {});
      await interaction.editReply({
        content: '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'
      });
      return;
    }
    options = snap.options;
    analysisType = snap.analysis_type ?? '';
    personaKey = snap.persona_key;
    const ref = snap.chat_history_ref;
    chatHistoryId = ref ? parseInt(ref, 10) : 0;
  } else if (mLegacy) {
    chatHistoryId = Number(mLegacy[1]);
    optIndex = Number(mLegacy[2]);
    const msg = String((interaction as { message?: { content?: string } }).message?.content || '');
    options = extractDecisionOptions(msg);
    analysisType = '';
    personaKey = null;
  } else {
    ctx.logger.warn('DECISION', 'invalid decision customId', { cid });
    await ctx.interactions.safeDeferReply(interaction, {});
    await interaction.editReply({
      content: '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'
    });
    return;
  }

  const selectedOption = options[optIndex] ?? options[0] ?? '선택';
  if (!Number.isFinite(chatHistoryId) || chatHistoryId <= 0 || !Number.isFinite(optIndex)) {
    await ctx.interactions.safeDeferReply(interaction, {});
    await interaction.editReply({
      content: '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'
    });
    return;
  }

  await ctx.interactions.safeDeferReply(interaction, {});

  ctx.logger.info('DECISION', 'DECISION_SELECTED', {
    chatHistoryId,
    userId: discordUserId,
    selectedOption,
    optionIndex: optIndex,
    options: options.slice(0, 4)
  });
  ctx.updateHealth(s => {
    s.ux.lastDecisionSelectedAt = new Date().toISOString();
  });

  const decisionContext: Record<string, unknown> = {
    options,
    persona: personaKey,
    topic: decisionTopicHintForContext(analysisType || 'UNKNOWN')
  };
  if (mUuid) {
    decisionContext.snapshot_id = mUuid[1];
  }

  await insertDecisionHistoryRow({
    discordUserId,
    chatHistoryRef: String(chatHistoryId),
    analysisType: analysisType || null,
    selectedOption,
    optionIndex: optIndex,
    decisionContext
  });

  const userMode = await ctx.settings.loadUserMode(discordUserId);
  let exec: { replyAck: string; followUpMarkdown: string; execution_type: string };
  try {
    exec = await executeDecisionAfterSelection({
      discordUserId,
      chatHistoryId,
      analysisType: analysisType || 'UNKNOWN',
      personaKey,
      selectedOption,
      optionIndex: optIndex,
      options,
      decisionContext,
      userMode
    });
  } catch (e: unknown) {
    ctx.logger.warn('DECISION', 'executeDecisionAfterSelection threw', {
      message: e instanceof Error ? e.message : String(e)
    });
    exec = {
      replyAck: `**선택 완료:** ${selectedOption}을(를) 반영합니다.`,
      followUpMarkdown:
        '후속 안내를 불러오는 중 문제가 있었습니다. 잠시 후 다시 시도해 주세요. _(자동 매매 없음)_',
      execution_type: 'error'
    };
  }

  await interaction.editReply({ content: exec.replyAck.slice(0, 1900) });

  const ch = interaction.channel as { send?: (p: { content: string }) => Promise<unknown> } | undefined;
  if (ch?.send && exec.followUpMarkdown) {
    const chunks = splitDiscordMessage(exec.followUpMarkdown, 1800);
    for (const part of chunks) {
      try {
        await ch.send({ content: part });
      } catch (e: unknown) {
        ctx.logger.warn('DECISION', 'decision followUp channel send failed', {
          message: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }
}
