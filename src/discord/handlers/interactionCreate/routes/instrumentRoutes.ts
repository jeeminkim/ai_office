import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import {
  handleInstrumentCancel,
  handleInstrumentConfirm,
  handleInstrumentPick
} from '../../../../interactions/instrumentConfirmationHandler';

export function getInstrumentButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'instr:confirm',
      match: i => i.isButton() && i.customId.startsWith('instr:confirm:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleInstrumentConfirm(i, ctx.portfolio.modalDeps);
        return true;
      }
    },
    {
      name: 'instr:cancel',
      match: i => i.isButton() && i.customId.startsWith('instr:cancel:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        await handleInstrumentCancel(i, ctx.portfolio.modalDeps);
        return true;
      }
    }
  ];
}

export function getInstrumentStringSelectRoutes(): InteractionRoute[] {
  return [
    {
      name: 'instr:pick',
      match: i => i.isStringSelectMenu() && i.customId.startsWith('instr:pick:'),
      handle: async (i, ctx: DiscordInteractionContext) => {
        const ok = await handleInstrumentPick(i, ctx.portfolio.modalDeps);
        return ok;
      }
    }
  ];
}
