import { InteractionType } from 'discord.js';
import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { decideOrchestratorRoute, logOrchestratorDecision } from '../../../../../orchestrator';
import { detectFinancialIntent } from '../../../analysisFormatting';

export function getModalTrendAiRoutes(): InteractionRoute[] {
  return [
    {
      name: 'modal:trend:free',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:trend:free',
      handle: async (i, ctx: DiscordInteractionContext) => {
        const query = i.fields.getTextInputValue('query');
        const statusText = '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `modal:trend:free:status`);
        await ctx.runtime.runTrendAnalysis(i.user.id, query, i, 'free', 'modal:trend:free');
        return true;
      }
    },
    {
      name: 'modal:ai:ask',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:ai:ask',
      handle: async (i, ctx: DiscordInteractionContext) => {
        const orch = decideOrchestratorRoute({ modalId: 'modal:ai:ask' });
        logOrchestratorDecision(orch, { source: 'modal:ai:ask' });
        const query = i.fields.getTextInputValue('query');
        const isFinancial = detectFinancialIntent(query);
        const statusText = isFinancial
          ? '📊 **포트폴리오 기반 재무 분석 중...**'
          : '📌 **자유 주제 분석 중…** (포트폴리오 스냅샷 미사용)';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `modal:ai:ask:status`);
        if (isFinancial) {
          await ctx.runtime.runPortfolioDebate(i.user.id, query, i);
        } else {
          await ctx.runtime.runOpenTopicDebate(i.user.id, query, i);
        }
        return true;
      }
    }
  ];
}
