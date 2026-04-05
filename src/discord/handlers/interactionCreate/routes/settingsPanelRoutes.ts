import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext, UserRiskMode } from '../../../InteractionContext';

export function getSettingsPanelButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'panel:settings:view',
      match: i => i.isButton() && i.customId === 'panel:settings:view',
      handle: async (i, ctx: DiscordInteractionContext) => {
        const discordUserId = ctx.getDiscordUserId(i.user);
        const mode = await ctx.settings.loadUserMode(discordUserId);
        await ctx.interactions.safeReplyOrFollowUp(
          i,
          { content: `현재 설정 모드: **${mode}**`, ephemeral: true },
          'panel:settings:view'
        );
        return true;
      }
    },
    {
      name: 'panel:settings:mode',
      match: i => i.isButton() && i.customId.startsWith('panel:settings:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const cid = i.customId;
        const modeMap: Record<string, UserRiskMode> = {
          'panel:settings:safe': 'SAFE',
          'panel:settings:balanced': 'BALANCED',
          'panel:settings:aggressive': 'AGGRESSIVE'
        };
        const targetMode = modeMap[cid];
        if (!targetMode) return false;
        const discordUserId = ctx.getDiscordUserId(i.user);
        try {
          await ctx.settings.saveUserMode(discordUserId, targetMode);
          await ctx.interactions.safeReplyOrFollowUp(
            i,
            { content: `✅ 성향 설정 저장 완료: **${targetMode}**`, ephemeral: true },
            'panel:settings:update'
          );
        } catch (e: unknown) {
          await ctx.interactions.safeReplyOrFollowUp(
            i,
            { content: `❌ 설정 저장 실패: ${e instanceof Error ? e.message : 'unknown'}`, ephemeral: true },
            'panel:settings:update:failure'
          );
        }
        return true;
      }
    }
  ];
}
