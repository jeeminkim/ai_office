import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { handleDecisionButtonInteraction } from '../decisionHandler';

export function getDecisionButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'decision:select',
      match: i => i.isButton() && i.customId.startsWith('decision:select|'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleDecisionButtonInteraction(i, ctx);
        return true;
      }
    }
  ];
}
