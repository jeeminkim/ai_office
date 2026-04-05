import { InteractionType } from 'discord.js';
import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import {
  tryHandlePortfolioButton,
  tryHandlePortfolioModalSubmit,
  tryHandlePortfolioStringSelect
} from '../../../../interactions/portfolioInteractionHandler';

export function getPortfolioButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'portfolio:tryHandle',
      match: i => i.isButton() && String(i.customId).startsWith('panel:portfolio:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const consumed = await tryHandlePortfolioButton(i, ctx.portfolio.interactionDeps);
        return consumed;
      }
    }
  ];
}

export function getPortfolioStringSelectRoutes(): InteractionRoute[] {
  return [
    {
      name: 'portfolio:string_select',
      match: i => i.isStringSelectMenu(),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const consumed = await tryHandlePortfolioStringSelect(i, ctx.portfolio.interactionDeps);
        return consumed;
      }
    }
  ];
}

export function getPortfolioModalSubmitRoutes(): InteractionRoute[] {
  return [
    {
      name: 'portfolio:modal_submit',
      match: i => i.type === InteractionType.ModalSubmit,
      handle: async (i, ctx: DiscordInteractionContext) => {
        const consumed = await tryHandlePortfolioModalSubmit(i, ctx.portfolio.modalDeps);
        return consumed;
      }
    }
  ];
}
