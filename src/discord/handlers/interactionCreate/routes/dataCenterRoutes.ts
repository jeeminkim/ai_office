import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { splitDiscordMessage } from '../../../../../discordResponseUtils';
import {
  analyzeLogs,
  generateActionsView,
  generateDetailView,
  generateSystemReport
} from '../../../../../logAnalysisService';
import { getRebalancePlanById, getLatestPendingRebalancePlan } from '../../../../repositories/rebalancePlanRepository';
import {
  dismissRebalancePlanHold,
  executeRebalancePlanComplete,
  renderPlanItemsText
} from '../../../../application/executeRebalancePlanAppService';
import { buildPersonaScorecards, formatPersonaScorecardDiscord } from '../../../../services/personaScorecardService';
import { runClaimOutcomeAuditAppService } from '../../../../application/runClaimOutcomeAuditAppService';

export function getDataCenterButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'panel:data:center_presets',
      match: i =>
        i.isButton() && (i.customId === 'panel:data:daily_logs' || i.customId === 'panel:data:improvement'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const cid = i.customId;
        const action = cid === 'panel:data:daily_logs' ? 'daily_log_analysis' : 'system_improvement_suggestion';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReply(i, '🗄 **데이터 센터 분석 실행 중...**', `${cid}:status`);
        await ctx.runtime.runDataCenterAction(i.user.id, action, i);
        return true;
      }
    },
    {
      name: 'rebalance:actions',
      match: i => i.isButton() && /^rebalance:(view|complete|hold):([0-9a-f-]{36})$/i.test(i.customId),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const cid = i.customId;
        const rebMatch = /^rebalance:(view|complete|hold):([0-9a-f-]{36})$/i.exec(cid);
        if (!rebMatch) return false;
        const act = rebMatch[1].toLowerCase();
        const planId = rebMatch[2];
        const uid = i.user.id;
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        if (act === 'view') {
          const { plan, items, error } = await getRebalancePlanById(planId);
          if (error || !plan || plan.discord_user_id !== uid) {
            await ctx.interactions.safeEditReply(i, '플랜을 찾을 수 없거나 권한이 없습니다.', 'rebalance:view');
            return true;
          }
          const txt = renderPlanItemsText(items, plan.plan_header, plan.fx_usdkrw);
          await ctx.interactions.safeEditReply(i, txt.slice(0, 1990), 'rebalance:view');
          return true;
        }
        if (act === 'complete') {
          const r = await executeRebalancePlanComplete({ discordUserId: uid, planId });
          await ctx.interactions.safeEditReply(i, r.message, 'rebalance:complete');
          return true;
        }
        if (act === 'hold') {
          const r = await dismissRebalancePlanHold({ discordUserId: uid, planId });
          await ctx.interactions.safeEditReply(i, r.message, 'rebalance:hold');
          return true;
        }
        return false;
      }
    },
    {
      name: 'panel:data:persona_report',
      match: i => i.isButton() && i.customId === 'panel:data:persona_report',
      handle: async (i, ctx: DiscordInteractionContext) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const uid = i.user.id;
        const c7 = await buildPersonaScorecards({ discordUserId: uid, windowDays: 7 });
        const c30 = await buildPersonaScorecards({ discordUserId: uid, windowDays: 30 });
        const t =
          formatPersonaScorecardDiscord(c7, '최근 7일') +
          '\n\n' +
          formatPersonaScorecardDiscord(c30, '최근 30일');
        const chunks = splitDiscordMessage(t, 1800);
        await ctx.interactions.safeEditReply(i, chunks[0] || t, 'panel:data:persona_report');
        return true;
      }
    },
    {
      name: 'panel:data:claim_audit',
      match: i => i.isButton() && i.customId === 'panel:data:claim_audit',
      handle: async (i, ctx: DiscordInteractionContext) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const r = await runClaimOutcomeAuditAppService({ discordUserId: i.user.id, limit: 60 });
        const msg =
          `claim 감사 배치 완료 · 갱신 ${r.updated} · 스킵 ${r.skipped}` +
          (r.errors.length ? ` · 오류 ${r.errors.slice(0, 2).join('; ')}` : '');
        await ctx.interactions.safeEditReply(i, msg, 'panel:data:claim_audit');
        return true;
      }
    },
    {
      name: 'panel:data:rebalance_view',
      match: i => i.isButton() && i.customId === 'panel:data:rebalance_view',
      handle: async (i, ctx: DiscordInteractionContext) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const uid = i.user.id;
        const { plan, items, error } = await getLatestPendingRebalancePlan(uid);
        if (error) {
          await ctx.interactions.safeEditReply(i, `조회 실패: ${error}`, 'panel:data:rebalance_view:err');
          return true;
        }
        if (!plan) {
          await ctx.interactions.safeEditReply(i, '대기 중인 리밸런싱 계획이 없습니다.', 'panel:data:rebalance_view:empty');
          return true;
        }
        const txt = renderPlanItemsText(items, plan.plan_header, plan.fx_usdkrw);
        await ctx.interactions.safeEditReply(i, txt.slice(0, 1990), 'panel:data:rebalance_view');
        return true;
      }
    },
    {
      name: 'panel:system:log_analysis',
      match: i =>
        i.isButton() &&
        (i.customId === 'panel:system:check' ||
          i.customId === 'panel:system:detail' ||
          i.customId === 'panel:system:actions'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const cid = i.customId;
        const r = analyzeLogs();
        const raw =
          cid === 'panel:system:check'
            ? generateSystemReport(r)
            : cid === 'panel:system:detail'
              ? generateDetailView(r)
              : generateActionsView(r);
        ctx.logger.info('DATA_CENTER', 'system_log_analysis', {
          customId: cid,
          status: r.systemStatus,
          issueCount: r.issues.length,
          warnCount: r.warnings.length
        });
        const chunks = splitDiscordMessage(raw, 1800);
        await ctx.interactions.safeEditReply(i, chunks[0] || '_내용 없음_', `panel:system:${cid}`);
        for (let j = 1; j < chunks.length; j++) {
          await i.followUp({ content: chunks[j], ephemeral: true }).catch(() => {});
        }
        return true;
      }
    }
  ];
}
