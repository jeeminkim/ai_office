import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { routeEarlyButtonInteraction } from '../../../../interactions/interactionRouter';
import { isMainPanelInteraction } from '../../../../interactions/panelInteractionHandler';
import { savePanelState } from '../../../../../panelManager';

export function getPanelMainButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'panel:main:early',
      match: i => i.isButton() && isMainPanelInteraction(i.customId),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const cid = i.customId;
        const routedEarly = await routeEarlyButtonInteraction({
          interaction: i,
          customId: cid,
          getDiscordUserId: ctx.getDiscordUserId,
          safeDeferReply: ctx.interactions.safeDeferReply,
          safeEditReply: ctx.interactions.safeEditReply,
          mainPanel: {
            getTrendPanel: ctx.panel.getTrendPanel,
            getPortfolioPanel: ctx.panel.getPortfolioPanel,
            getFinancePanel: ctx.panel.getFinancePanel,
            getAIPanel: ctx.panel.getAIPanel,
            getDataCenterPanel: ctx.panel.getDataCenterPanel,
            getSettingsPanel: ctx.panel.getSettingsPanel,
            getMainPanel: ctx.panel.getMainPanel,
            safeUpdate: ctx.interactions.safeUpdate
          }
        });
        return routedEarly;
      }
    },
    {
      name: 'panel:settings:reinstall',
      match: i => i.isButton() && i.customId === 'panel:settings:reinstall',
      handle: async (i, ctx: DiscordInteractionContext) => {
        const msg = await (i.channel as { send?: (p: unknown) => Promise<{ channel: { id: string }; id: string }> })?.send?.(
          ctx.panel.getMainPanel()
        );
        if (msg) savePanelState(msg.channel.id, msg.id);
        ctx.logger.info('PANEL', 'Explicit reinstall via button', { channelId: msg?.channel.id, messageId: msg?.id });
        ctx.updateHealth(s => (s.panels.lastPanelAction = 'button_reinstall'));
        await i.message?.delete().catch(() => {});
        return true;
      }
    }
  ];
}
