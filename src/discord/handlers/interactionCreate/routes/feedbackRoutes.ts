import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { handleFeedbackSaveButtonInteraction } from '../feedbackHandler';

export function getFeedbackButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'feedback:save',
      match: i => i.isButton() && i.customId.startsWith('feedback:save:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleFeedbackSaveButtonInteraction(i, ctx);
        return true;
      }
    }
  ];
}
