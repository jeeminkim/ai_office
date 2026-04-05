import { InteractionType } from 'discord.js';
import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import {
  handleFollowupInputButton,
  handleFollowupMenuInteraction,
  handleFollowupModalSubmit,
  handleFollowupSelectButton
} from '../followupHandlers';

export function getFollowupButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'followup:select',
      match: i => i.isButton() && i.customId.startsWith('followup:select|'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleFollowupSelectButton(i, ctx);
        return true;
      }
    },
    {
      name: 'followup:input',
      match: i => i.isButton() && i.customId.startsWith('followup:input|'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleFollowupInputButton(i, ctx);
        return true;
      }
    }
  ];
}

export function getFollowupStringSelectRoutes(): InteractionRoute[] {
  return [
    {
      name: 'followup:menu',
      match: i => i.isStringSelectMenu() && i.customId.startsWith('followup:menu|'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleFollowupMenuInteraction(i, ctx);
        return true;
      }
    }
  ];
}

export function getFollowupModalRoutes(): InteractionRoute[] {
  return [
    {
      name: 'modal:followup',
      match: i => i.type === InteractionType.ModalSubmit && i.customId.startsWith('modal:followup:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleFollowupModalSubmit(i, ctx);
        return true;
      }
    }
  ];
}
