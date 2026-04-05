import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { trendTopicFromCustomId } from '../../../../../trendAnalysis';
import { trendCommandQueryMap } from '../commandMaps';

export function getTrendPanelButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'trend:panel:topic',
      match: i => {
        if (!i.isButton()) return false;
        const cid = i.customId;
        const trendTopicBtn = trendTopicFromCustomId(cid);
        return trendTopicBtn != null && !!trendCommandQueryMap[cid];
      },
      handle: async (i, ctx: DiscordInteractionContext) => {
        const cid = i.customId;
        const query = trendCommandQueryMap[cid];
        const trendTopicBtn = trendTopicFromCustomId(cid)!;
        const statusText = '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `${cid}:status`);
        await ctx.runtime.runTrendAnalysis(i.user.id, query, i, trendTopicBtn, cid);
        return true;
      }
    }
  ];
}
