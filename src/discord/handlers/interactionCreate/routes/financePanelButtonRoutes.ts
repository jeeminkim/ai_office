import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { financialCommandQueryMap } from '../commandMaps';

export function getFinancePanelButtonRoutes(): InteractionRoute[] {
  return [
    {
      name: 'financial:panel:commands',
      match: i => i.isButton() && !!financialCommandQueryMap[i.customId],
      handle: async (i, ctx: DiscordInteractionContext) => {
        const cid = i.customId;
        const query = financialCommandQueryMap[cid];
        const statusText = '📊 **포트폴리오·소비·현금흐름 기준 재무 분석 중...**';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `${cid}:status`);
        await ctx.runtime.runPortfolioDebate(i.user.id, query, i);
        return true;
      }
    },
    {
      name: 'panel:finance:add_expense',
      match: i => i.isButton() && i.customId === 'panel:finance:add_expense',
      handle: async i => {
        const modal = new ModalBuilder().setCustomId('modal:expense:add').setTitle('💸 지출 기록');
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel('금액').setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('category').setLabel('카테고리').setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('desc').setLabel('상세 설명').setStyle(TextInputStyle.Paragraph).setRequired(false)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('installment')
              .setLabel('할부 (N 또는 Y 개월 시작일, 예: Y 3 2026-01-01)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
          )
        );
        await i.showModal(modal);
        return true;
      }
    },
    {
      name: 'panel:finance:add_cashflow',
      match: i => i.isButton() && i.customId === 'panel:finance:add_cashflow',
      handle: async (i, ctx: DiscordInteractionContext) => {
        ctx.logger.info('INTERACTION', 'button click: panel:finance:add_cashflow', { user: i.user.tag });
        const modal = new ModalBuilder().setCustomId('modal:cashflow:add').setTitle('💰 현금흐름 입력');
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('flow_type')
              .setLabel('유형 (SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, …)')
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel('금액').setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('desc').setLabel('상세 설명').setStyle(TextInputStyle.Paragraph).setRequired(false)
          )
        );
        ctx.logger.info('INTERACTION', 'modal open: modal:cashflow:add', { user: i.user.tag });
        await i.showModal(modal);
        return true;
      }
    },
    {
      name: 'panel:ai:ask_or_trend:free',
      match: i => i.isButton() && (i.customId === 'panel:ai:ask' || i.customId === 'panel:trend:free'),
      handle: async i => {
        const modal = new ModalBuilder()
          .setCustomId(i.customId === 'panel:ai:ask' ? 'modal:ai:ask' : 'modal:trend:free')
          .setTitle(i.customId === 'panel:ai:ask' ? '✍️ 직접 질문' : '🔍 자유 탐색');
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('query').setLabel('궁금한 내용을 입력하세요').setStyle(TextInputStyle.Paragraph)
          )
        );
        await i.showModal(modal);
        return true;
      }
    }
  ];
}
