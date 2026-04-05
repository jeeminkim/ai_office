import {
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  WebhookClient,
  Interaction,
  Message
} from 'discord.js';
import type { PersonaKey } from '../../../analysisTypes';
import { getQuickNavigationRows, type QuickNavHighlight } from '../../../panelManager';
import { splitDiscordMessage } from '../../../discordResponseUtils';
import {
  isDecisionPrompt,
  extractDecisionOptions,
  buildDecisionButtonsRow,
  logDecisionPromptDetected
} from '../../../decisionPrompt';
import { insertDecisionSnapshot } from '../../repositories/decisionRepository';
import { analyzeFollowupPrompt, buildFollowupComponentRows } from '../../../followupPromptService';
import { insertFollowupSnapshot } from '../../repositories/followupRepository';
import { personaKeyToPersonaName } from '../analysisFormatting';
import { logger, updateHealth } from '../../../logger';
import type { AiExecutionHandle } from '../aiExecution/aiExecutionHandle';

const DISCORD_CONTENT_MAX = 2000;
const DISCORD_BODY_CHUNK = 1800;
/** Discord 메시지당 ActionRow 상한(버튼/셀렉트 행 합산) */
const DISCORD_COMPONENT_ROW_LIMIT = 5;

export type DiscordBroadcastDeps = {
  webhook: WebhookClient;
  logger: typeof logger;
  updateHealth: typeof updateHealth;
  getQuickNavigationRows: typeof getQuickNavigationRows;
};

function prioritizeDiscordComponentRows(
  decisionRows: ActionRowBuilder<ButtonBuilder>[],
  followupRows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[],
  feedbackRow: ActionRowBuilder<ButtonBuilder> | null | undefined
): { rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]; dropped: string[] } {
  const ordered: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    ...decisionRows,
    ...followupRows,
    ...(feedbackRow ? [feedbackRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>] : [])
  ];
  if (ordered.length <= DISCORD_COMPONENT_ROW_LIMIT) {
    return { rows: ordered, dropped: [] };
  }
  const dropped: string[] = [];
  const d = [...decisionRows];
  let budget = DISCORD_COMPONENT_ROW_LIMIT - d.length;
  const maxFollow = Math.min(followupRows.length, Math.max(0, budget));
  const fTake = followupRows.slice(0, maxFollow);
  if (followupRows.length > fTake.length) {
    dropped.push('followup_overflow');
  }
  budget -= fTake.length;
  const fbTake =
    feedbackRow && budget > 0
      ? [feedbackRow as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>]
      : [];
  if (!fbTake.length && feedbackRow) {
    dropped.push('feedback');
  }
  return { rows: [...d, ...fTake, ...fbTake], dropped };
}

export async function sendPostNavigationReply(
  sourceInteraction: Interaction | Message,
  highlight: QuickNavHighlight,
  deps: DiscordBroadcastDeps
): Promise<void> {
  const { logger, getQuickNavigationRows } = deps;
  try {
    const rows = getQuickNavigationRows({ highlight });
    const src: any = sourceInteraction;
    if (typeof src.followUp === 'function') {
      await src.followUp({
        content: '**다음 메뉴** — 스크롤 없이 바로 선택할 수 있습니다.',
        components: rows,
        ephemeral: true
      });
      logger.info('UI', 'post_response_navigation_attached', { mode: 'followUp', highlight });
    } else if (src.channel?.send) {
      await src.channel.send({
        content: '**다음 메뉴** — 스크롤 없이 바로 선택할 수 있습니다.',
        components: rows
      });
      logger.info('UI', 'post_response_navigation_attached', { mode: 'channel_send', highlight });
    }
  } catch (e: any) {
    logger.warn('UI', 'post_response_navigation_failed', { message: e?.message });
  }
}

export async function broadcastAgentResponse(
  userId: string,
  agentName: string,
  avatarURL: string,
  content: string,
  sourceInteraction: Interaction | Message,
  feedbackRow: ActionRowBuilder<ButtonBuilder> | null | undefined,
  decisionCtx: { chatHistoryId: number; analysisType: string; personaKey?: PersonaKey } | null | undefined,
  deps: DiscordBroadcastDeps,
  executionHandle?: AiExecutionHandle | null
): Promise<string> {
  const { webhook, logger, updateHealth } = deps;
  if (executionHandle?.shouldDiscardOutgoing()) {
    executionHandle.logResultDiscarded('broadcastAgentResponse_blocked', {
      agentName,
      contentLen: content.length
    });
    return content;
  }
  let finalContent = content;
  let noDataBodyNote = '';

  if (finalContent.includes('[REASON: NO_DATA]')) {
    finalContent = finalContent.replace(/\[REASON: NO_DATA\]/g, '').trim();
    noDataBodyNote =
      '\n\n⚠️ **NO_DATA** — 포트폴리오·소비·현금흐름 데이터가 부족합니다. 메인 패널에서 종목 등록·소비·현금흐름 입력 후 다시 시도해 주세요. _(버튼 행은 decision/follow-up 우선순위로 생략될 수 있음)_';
    logger.info('UI', 'NO_DATA inlined to body (no NO_DATA button row in broadcast)');
  }

  const decisionRows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (decisionCtx && isDecisionPrompt(finalContent)) {
    const opts = extractDecisionOptions(finalContent);
    logDecisionPromptDetected(decisionCtx.chatHistoryId, decisionCtx.analysisType, opts);
    const snap = await insertDecisionSnapshot({
      discordUserId: userId,
      chatHistoryRef: String(decisionCtx.chatHistoryId),
      analysisType: decisionCtx.analysisType,
      personaKey: decisionCtx.personaKey ?? null,
      options: opts
    });
    if (snap?.id) {
      decisionRows.push(buildDecisionButtonsRow(snap.id, opts));
      logger.info('DECISION', 'DECISION_SNAPSHOT_SAVED', {
        snapshot_id: snap.id,
        chat_history_id: decisionCtx.chatHistoryId,
        option_count: opts.length
      });
      logger.info('DECISION', 'DECISION_COMPONENT_ATTACHED', { rows: decisionRows.length });
      updateHealth(s => {
        s.ux.lastDecisionSnapshotSavedAt = new Date().toISOString();
        s.ux.lastDecisionAttached = true;
      });
    } else {
      logger.warn('DECISION', 'DECISION_COMPONENT_SKIPPED', { reason: 'snapshot_insert_failed' });
      updateHealth(s => {
        s.ux.lastDecisionAttached = false;
      });
    }
  }

  const followupRows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (decisionCtx && !isDecisionPrompt(finalContent)) {
    const fu = analyzeFollowupPrompt(finalContent);
    if (fu.shouldAttach) {
      const ins = await insertFollowupSnapshot({
        discordUserId: userId,
        chatHistoryRef: String(decisionCtx.chatHistoryId),
        analysisType: decisionCtx.analysisType,
        personaName: decisionCtx.personaKey ? personaKeyToPersonaName(decisionCtx.personaKey) : null,
        promptType: fu.promptType,
        options: fu.options
      });
      if (ins?.id) {
        followupRows.push(...buildFollowupComponentRows(ins.id, fu.promptType, fu.options));
        logger.info('FOLLOWUP', 'FOLLOWUP_SNAPSHOT_SAVED', {
          snapshot_id: ins.id,
          prompt_type: fu.promptType,
          option_count: fu.options.length
        });
        logger.info('FOLLOWUP', 'FOLLOWUP_COMPONENT_ATTACHED', { rows: followupRows.length });
        updateHealth(s => {
          s.ux.lastFollowupDetectedAt = new Date().toISOString();
          s.ux.lastFollowupType = fu.promptType;
          s.ux.lastFollowupAttached = true;
        });
      } else {
        logger.warn('FOLLOWUP', 'FOLLOWUP_COMPONENT_SKIPPED', { reason: 'snapshot_insert_failed' });
        updateHealth(s => {
          s.ux.lastFollowupAttached = false;
        });
      }
    } else {
      logger.info('FOLLOWUP', 'FOLLOWUP_COMPONENT_SKIPPED', { reason: 'heuristic_not_matched' });
    }
  }

  const prioritized = prioritizeDiscordComponentRows(decisionRows, followupRows, feedbackRow);
  if (prioritized.dropped.length) {
    logger.warn('UI', 'UI_COMPONENT_POLICY', {
      dropped: prioritized.dropped,
      decision_rows: decisionRows.length,
      followup_rows: followupRows.length,
      had_feedback: !!feedbackRow
    });
    updateHealth(s => {
      s.ux.lastUiComponentPolicy = prioritized.dropped.join(',');
    });
  }

  const originalLen = finalContent.length;
  if (originalLen > 12000) {
    logger.info('DISCORD', 'response summarized for limit', { originalLength: originalLen, agentName });
    finalContent = finalContent.slice(0, 12000) + '\n\n_(응답이 길어 이후 생략)_';
  }

  const defaultAvatar = 'https://upload.wikimedia.org/wikipedia/commons/e/ef/System_Preferences_icon_Apple.png';

  const bodyChunks = splitDiscordMessage(finalContent, DISCORD_BODY_CHUNK);
  if (bodyChunks.length > 1) {
    logger.info('DISCORD', 'long response chunked', { parts: bodyChunks.length, agentName });
  }
  if (bodyChunks.length > 1 && (decisionRows.length > 0 || followupRows.length > 0 || !!feedbackRow)) {
    logger.info('UI', 'interactive_components_on_first_chunk_only', {
      parts: bodyChunks.length,
      has_decision: decisionRows.length > 0,
      has_followup: followupRows.length > 0,
      has_feedback: !!feedbackRow
    });
  }

  let broadcastSendOk = false;
  const sendParts = async (useWebhook: boolean) => {
    for (let i = 0; i < bodyChunks.length; i++) {
      const header =
        bodyChunks.length === 1
          ? `## ${agentName}\n`
          : `## ${agentName} (${i + 1}/${bodyChunks.length})\n`;
      let piece = header + bodyChunks[i];
      if (i === 0 && noDataBodyNote) {
        piece += noDataBodyNote;
      }
      if (i === 0 && feedbackRow) {
        piece += '\n\n_이 분석이 유용했나요? 아래 버튼(👍 신뢰 / ✅ 채택 / 📌 저장 / 👎 별로)으로 바로 평가해 주세요._';
      }
      if (piece.length > DISCORD_CONTENT_MAX) {
        piece = piece.slice(0, DISCORD_CONTENT_MAX - 1) + '…';
      }
      const componentsToSend = i === 0 ? prioritized.rows : undefined;

      const hasInteractiveComponents = !!(componentsToSend && componentsToSend.length);
      const useWebhookForThisPart = useWebhook && !hasInteractiveComponents;

      if (useWebhookForThisPart) {
        await webhook.send({
          content: piece,
          username: agentName,
          avatarURL: avatarURL || defaultAvatar,
          components: undefined
        });
      } else {
        const ch = (sourceInteraction as any).channel;
        if (!ch) {
          throw new Error('broadcastAgentResponse: no channel on sourceInteraction');
        }
        await ch.send({
          content: piece,
          components: componentsToSend && componentsToSend.length ? componentsToSend : undefined
        });
      }
    }
    broadcastSendOk = true;
  };

  try {
    await sendParts(true);
  } catch (e: any) {
    logger.error('DISCORD', `Webhook send error: ${e.message}`, e);
    if (sourceInteraction && (sourceInteraction as any).channel) {
      try {
        await sendParts(false);
      } catch (e2: any) {
        logger.error('DISCORD', `channel send error: ${e2.message}`, e2);
      }
    }
  }

  if (broadcastSendOk && executionHandle && !executionHandle.firstResponseSent) {
    executionHandle.markFirstResponseSent();
  }
  if (broadcastSendOk) {
    executionHandle?.markSegmentBroadcast();
  }
  return finalContent;
}

/**
 * 조기 브로드캐스트(피드백 없음) 이후 chat_history 확정 시, 동일 customId의 피드백 버튼만 **봇 채널 메시지**로 부착.
 */
export async function sendFeedbackFollowupAttachMessage(
  sourceInteraction: Interaction | Message,
  deps: DiscordBroadcastDeps,
  opts: {
    agentName: string;
    feedbackRow: ActionRowBuilder<ButtonBuilder>;
    executionHandle?: AiExecutionHandle | null;
  }
): Promise<boolean> {
  if (opts.executionHandle?.shouldDiscardOutgoing()) {
    return false;
  }
  const ch = (sourceInteraction as any).channel;
  if (!ch?.send) {
    deps.logger.warn('DISCORD', 'feedback_followup_no_channel', { agentName: opts.agentName });
    return false;
  }
  try {
    await ch.send({
      content: `_**${opts.agentName}** 위원 응답에 대한 피드백을 아래 버튼으로 남겨 주세요._`,
      components: [opts.feedbackRow]
    });
    return true;
  } catch (e: any) {
    deps.logger.warn('DISCORD', 'feedback_followup_send_failed', {
      agentName: opts.agentName,
      message: e?.message || String(e)
    });
    return false;
  }
}
