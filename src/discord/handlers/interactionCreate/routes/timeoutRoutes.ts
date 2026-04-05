import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { takePendingTimeoutRetry } from '../../../aiExecution/aiExecutionPolicy';
import type { AiExecutionRoute } from '../../../aiExecution/aiExecutionPolicy';
import type { TrendTopicKind } from '../../../../../trendAnalysis';
import {
  consumeTimeoutRetrySnapshot,
  isUuid,
  releaseTimeoutRetrySnapshot,
  type TimeoutRetryPayloadV1
} from '../../../../repositories/timeoutRetrySnapshotRepository';

const ID_CAPTURE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})';

function parseTimeoutButton(cid: string): { kind: 'light' | 'summary' | 'menu'; id: string } | null {
  const m1 = new RegExp(`^timeout:retry:light:${ID_CAPTURE}$`, 'i').exec(cid);
  if (m1) return { kind: 'light', id: m1[1] };
  const m2 = new RegExp(`^timeout:retry:summary:${ID_CAPTURE}$`, 'i').exec(cid);
  if (m2) return { kind: 'summary', id: m2[1] };
  const m3 = new RegExp(`^timeout:return:menu:${ID_CAPTURE}$`, 'i').exec(cid);
  if (m3) return { kind: 'menu', id: m3[1] };
  return null;
}

function trendTopicOrFree(t: string | undefined): TrendTopicKind | 'free' {
  if (!t || t === 'free') return 'free';
  return t as TrendTopicKind;
}

function payloadToPending(p: TimeoutRetryPayloadV1): {
  userId: string;
  userQuery: string;
  route: AiExecutionRoute;
  triggerCustomId?: string;
  topic?: TrendTopicKind | 'free';
} {
  return {
    userId: p.userId,
    userQuery: p.userQuery,
    route: p.route as AiExecutionRoute,
    triggerCustomId: p.triggerCustomId,
    topic: p.topic as TrendTopicKind | 'free' | undefined
  };
}

export function getTimeoutButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'timeout:retry_or_menu',
      match: i => i.isButton() && /^timeout:(retry:light|retry:summary|return:menu):/i.test(i.customId),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const parsed = parseTimeoutButton(i.customId);
        if (!parsed) return false;

        const discordUserId = ctx.getDiscordUserId(i.user);

        if (parsed.kind === 'menu') {
          if (isUuid(parsed.id)) {
            await releaseTimeoutRetrySnapshot(parsed.id, discordUserId);
          } else {
            takePendingTimeoutRetry(parsed.id);
          }
          await ctx.interactions.safeDeferReply(i, {});
          try {
            await ctx.interactions.safeEditReplyPayload(i, ctx.panel.getMainPanel(), 'timeout:return:menu');
          } catch (e: unknown) {
            ctx.logger.warn('AI_EXECUTION', 'timeout_menu_panel_failed', {
              message: e instanceof Error ? e.message : String(e)
            });
            await i.editReply({
              content: '메인 패널을 표시하지 못했습니다. 채널에 고정된 패널 메시지를 확인해 주세요.'
            });
          }
          ctx.logger.info('AI_EXECUTION', 'AI_EXECUTION_RETRY_TRIGGERED', {
            snapshotId: parsed.id,
            kind: 'menu_return'
          });
          return true;
        }

        let pending:
          | ReturnType<typeof payloadToPending>
          | null = null;

        if (isUuid(parsed.id)) {
          const row = await consumeTimeoutRetrySnapshot(parsed.id, discordUserId);
          if (row) pending = payloadToPending(row);
        } else {
          const mem = takePendingTimeoutRetry(parsed.id);
          if (mem) pending = mem;
        }

        if (!pending || pending.userId !== discordUserId) {
          await i.reply({
            content: '재시도 세션이 만료되었거나 권한이 없습니다. 메인 패널에서 다시 분석을 시작해 주세요.',
            ephemeral: true
          });
          return true;
        }

        await ctx.interactions.safeDeferReply(i, {});
        const modeLabel = parsed.kind === 'light' ? '경량 모드' : '요약 모드';
        await i.editReply({
          content: `**${modeLabel}로 다시 실행합니다.** _(자동 주문 없음)_`
        });

        const portfolioFast = parsed.kind === 'light' ? 'light_summary' : 'short_summary';
        const openFast = portfolioFast;

        try {
          switch (pending.route) {
            case 'portfolio':
              await ctx.runtime.runPortfolioDebate(pending.userId, pending.userQuery, i, {
                fastMode: portfolioFast
              });
              break;
            case 'trend':
              await ctx.runtime.runTrendAnalysis(
                pending.userId,
                pending.userQuery,
                i,
                trendTopicOrFree(pending.topic as string | undefined),
                pending.triggerCustomId,
                { fastMode: 'short' }
              );
              break;
            case 'open_topic':
            case 'followup':
            case 'unknown':
            default:
              await ctx.runtime.runOpenTopicDebate(pending.userId, pending.userQuery, i, {
                fastMode: openFast
              });
          }
          await i.editReply({
            content: `**${modeLabel} 재분석이 채널에 전송되었습니다.** _(자동 주문 없음)_`
          });
          ctx.logger.info('AI_EXECUTION', 'AI_EXECUTION_RETRY_TRIGGERED', {
            snapshotId: parsed.id,
            kind: parsed.kind,
            route: pending.route
          });
        } catch (e: unknown) {
          ctx.logger.warn('AI_EXECUTION', 'timeout_retry_run_failed', {
            message: e instanceof Error ? e.message : String(e),
            snapshotId: parsed.id
          });
          await i.editReply({
            content: '재분석 중 문제가 있었습니다. 잠시 후 메인 패널에서 다시 시도해 주세요. _(자동 주문 없음)_'
          });
        }
        return true;
      }
    }
  ];
}
