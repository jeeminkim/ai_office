import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { logger } from '../../../logger';
import {
  AI_RESPONSE_TIMEOUT_MS,
  FIRST_VISIBLE_TIMEOUT_MS,
  HEARTBEAT_PROGRESS_MS,
  SOFT_PROGRESS_NOTICE_MS,
  registerPendingTimeoutRetry,
  type AiExecutionRoute,
  type PendingTimeoutRetryPayload
} from './aiExecutionPolicy';
import { createAiExecutionHandle, type AiExecutionHandle, type AiTimeoutPhase } from './aiExecutionHandle';
import { isAiExecutionAbortedError } from './aiExecutionAbort';
import { formatPartialFallbackDiscordBody } from './aiExecutionHelpers';
import { saveTimeoutRetrySnapshot, type TimeoutRetryPayloadV1 } from '../../repositories/timeoutRetrySnapshotRepository';

const START_MSG = '📌 **분석을 시작했습니다.**\n위원·모델 응답을 수집 중입니다.';
const SOFT_MSG =
  '⏳ **분석이 길어지고 있습니다.**\n계속 진행 중입니다. **약 90초 안에 첫 분석 본문**이 없으면 조기 중단되고, 전체는 **최대 약 5분**까지 진행됩니다.';
const HEARTBEAT_MSG = '⏳ **아직 처리 중입니다…** (대기 시간이 길어질 수 있습니다)';

export type RunUserVisibleAiOptions<T> = {
  userId: string;
  route: AiExecutionRoute;
  sourceInteraction: any;
  safeEditReply: (interaction: any, content: string, context: string) => Promise<void>;
  safeReplyOrFollowUp?: (interaction: any, payload: Record<string, unknown>, context: string) => Promise<void>;
  execute: (handle: AiExecutionHandle) => Promise<T>;
  buildPendingPayload: () => Omit<PendingTimeoutRetryPayload, 'createdAt'>;
};

export type RunUserVisibleAiResult<T> =
  | { ok: true; value: T; handle: AiExecutionHandle }
  | { ok: false; reason: 'timeout'; handle: AiExecutionHandle };

function buildTimeoutButtonRows(snapshotId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`timeout:retry:light:${snapshotId}`)
        .setLabel('경량 모드로 다시')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`timeout:retry:summary:${snapshotId}`)
        .setLabel('요약만 다시')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`timeout:return:menu:${snapshotId}`)
        .setLabel('메인 메뉴')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

/** Interaction은 editReply, 일반 Message(예: !토론 로딩 메시지)는 edit */
async function applyProgressToSource(
  source: any,
  content: string,
  context: string,
  safeEditReply: (interaction: any, content: string, context: string) => Promise<void>
): Promise<void> {
  if (typeof source?.editReply === 'function') {
    await safeEditReply(source, content, context);
  } else if (typeof source?.edit === 'function') {
    try {
      await source.edit({ content });
    } catch (e: any) {
      logger.warn('AI_EXECUTION', 'progress_message_edit_failed', { context, message: e?.message });
    }
  }
}

type WorkOutcome<T> =
  | { type: 'done'; value: T }
  | { type: 'aborted' }
  | { type: 'error'; error: unknown };

export async function runUserVisibleAiExecution<T>(opts: RunUserVisibleAiOptions<T>): Promise<RunUserVisibleAiResult<T>> {
  const handle = createAiExecutionHandle(opts.userId, opts.route);

  try {
    await applyProgressToSource(opts.sourceInteraction, START_MSG, 'ai_exec:start', opts.safeEditReply);
  } catch (e: any) {
    logger.warn('AI_EXECUTION', 'ai_exec_start_edit_failed', { message: e?.message, executionId: handle.executionId });
  }

  const softTimer = setTimeout(() => {
    if (handle.timedOut || handle.finalResponseCompleted) return;
    if (handle.progressNotified) return;
    handle.markProgressNotified();
    void applyProgressToSource(opts.sourceInteraction, SOFT_MSG, 'ai_exec:soft_progress', opts.safeEditReply).catch(() => {});
  }, SOFT_PROGRESS_NOTICE_MS);

  const heartbeatTimer = setInterval(() => {
    if (handle.timedOut || handle.finalResponseCompleted) return;
    if (!handle.progressNotified) return;
    void applyProgressToSource(opts.sourceInteraction, HEARTBEAT_MSG, 'ai_exec:heartbeat', opts.safeEditReply).catch(() => {});
  }, HEARTBEAT_PROGRESS_MS);

  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<AiTimeoutPhase>(resolve => {
    firstTimer = setTimeout(() => {
      if (handle.finalResponseCompleted || handle.timedOut) return;
      if (!handle.firstResponseSent) {
        if (totalTimer) clearTimeout(totalTimer);
        resolve('first_visible');
      }
    }, FIRST_VISIBLE_TIMEOUT_MS);

    totalTimer = setTimeout(() => {
      if (handle.finalResponseCompleted || handle.timedOut) return;
      if (firstTimer) clearTimeout(firstTimer);
      resolve('total');
    }, AI_RESPONSE_TIMEOUT_MS);

    handle.registerClearFirstVisibleTimer(() => {
      if (firstTimer) clearTimeout(firstTimer);
    });
  });

  const workPromise = (async (): Promise<WorkOutcome<T>> => {
    try {
      const value = await opts.execute(handle);
      return { type: 'done', value };
    } catch (error) {
      if (isAiExecutionAbortedError(error)) {
        return { type: 'aborted' };
      }
      return { type: 'error', error };
    }
  })();

  const raced = await Promise.race([
    workPromise.then(w => ({ tag: 'work' as const, w })),
    timeoutPromise.then(phase => ({ tag: 'timeout' as const, phase }))
  ]);

  clearTimeout(softTimer);
  clearInterval(heartbeatTimer);
  if (firstTimer) clearTimeout(firstTimer);
  if (totalTimer) clearTimeout(totalTimer);

  if (raced.tag === 'timeout') {
    const phase = raced.phase;
    handle.markTimedOut(phase);
    await handle.attemptProviderCancels();

    const base = opts.buildPendingPayload();
    const aug = handle.retryPayloadAugment as Partial<TimeoutRetryPayloadV1>;
    const mergedPayload: TimeoutRetryPayloadV1 = {
      v: 1,
      userId: base.userId,
      userQuery: base.userQuery,
      route: base.route,
      triggerCustomId: base.triggerCustomId,
      topic: base.topic != null ? String(base.topic) : undefined,
      analysisType: aug.analysisType,
      portfolioSnapshot: aug.portfolioSnapshot ?? null
    };

    const analysisTypeForRow = String(mergedPayload.analysisType || mergedPayload.route || 'unknown');

    const saveRes = await saveTimeoutRetrySnapshot({
      discordUserId: opts.userId,
      executionId: handle.executionId,
      analysisType: analysisTypeForRow,
      payload: mergedPayload
    });

    registerPendingTimeoutRetry(saveRes.id, {
      userId: base.userId,
      userQuery: base.userQuery,
      route: base.route,
      triggerCustomId: base.triggerCustomId,
      topic: base.topic
    });

    const partialBody = formatPartialFallbackDiscordBody(handle.partialSegments, phase);
    if (handle.partialSegments.length > 0) {
      handle.markPartialFallbackUsed({
        partialResultCount: handle.partialSegments.length,
        timeoutPhase: phase
      });
    }

    const rows = buildTimeoutButtonRows(saveRes.id);
    const payloadOut: Record<string, unknown> = {
      content: partialBody,
      components: rows,
      ephemeral: false
    };

    try {
      const src: any = opts.sourceInteraction;
      if (typeof src.followUp === 'function') {
        await src.followUp(payloadOut);
      } else if (opts.safeReplyOrFollowUp) {
        await opts.safeReplyOrFollowUp(opts.sourceInteraction, payloadOut, 'ai_exec:timeout_notice');
      } else if (src.channel?.send) {
        await src.channel.send(payloadOut);
      }
      handle.userVisibleTimeoutMessageSent = true;
      logger.info('AI_EXECUTION', 'userVisibleTimeoutMessageSent', {
        executionId: handle.executionId,
        route: opts.route,
        timeoutPhase: phase,
        snapshotId: saveRes.id,
        snapshotSource: saveRes.source,
        partialResultCount: handle.partialSegments.length
      });
    } catch (e: any) {
      logger.error('AI_EXECUTION', 'timeout_notice_send_failed', { executionId: handle.executionId, message: e?.message });
    }

    logger.info('AI_EXECUTION', 'AI_EXECUTION_RETRY_TRIGGERED', {
      executionId: handle.executionId,
      route: opts.route,
      snapshotId: saveRes.id,
      note: 'retry_snapshot_and_memory_registered'
    });

    void workPromise.then(w => {
      if (w.type === 'aborted') {
        logger.info('AI_EXECUTION', 'background_work_finished_aborted', { executionId: handle.executionId });
      } else if (w.type === 'done') {
        handle.logResultDiscarded('timeout_race_winner_timeout_but_work_completed', { hadValue: true });
      } else if (w.type === 'error') {
        logger.warn('AI_EXECUTION', 'background_work_error_after_timeout', {
          executionId: handle.executionId,
          message: (w.error as any)?.message
        });
      }
    });

    return { ok: false, reason: 'timeout', handle };
  }

  const w = raced.w;
  if (w.type === 'error') {
    throw w.error;
  }
  if (w.type === 'aborted') {
    return { ok: false, reason: 'timeout', handle };
  }

  handle.logExecutionPerfSummary();
  handle.markFinalPipelineComplete();
  return { ok: true, value: w.value, handle };
}
