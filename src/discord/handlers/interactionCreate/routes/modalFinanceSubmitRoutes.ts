import { InteractionType } from 'discord.js';
import type { InteractionRoute } from '../../../interactionRegistry';
import type { DiscordInteractionContext } from '../../../InteractionContext';
import { parseCashflowFlowType } from '../../../../finance/cashflowCategories';
import { parseInstallmentLine } from '../../../../finance/expenseInstallment';
import { parsePositiveAmount, sanitizeDescription } from '../../../formParsing';
import { logSchemaSafeInsertFailure } from '../../../schemaInsertErrors';

export function getModalFinanceSubmitRoutes(): InteractionRoute[] {
  return [
    {
      name: 'modal:expense:add',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:expense:add',
      handle: async (i, ctx: DiscordInteractionContext) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const amount = parsePositiveAmount(i.fields.getTextInputValue('amount'));
        const category = i.fields.getTextInputValue('category');
        const desc = sanitizeDescription(i.fields.getTextInputValue('desc'));
        const installmentRaw = (i.fields.getTextInputValue('installment') || '').trim();
        if (!amount) {
          await ctx.interactions.safeEditReply(
            i,
            '입력값을 확인해주세요. 금액이 올바르지 않습니다.',
            'modal:expense:add:validation_failure'
          );
          return true;
        }

        const inst = parseInstallmentLine(installmentRaw, amount);
        const expensePayload: Record<string, unknown> = {
          discord_user_id: ctx.getDiscordUserId(i.user),
          amount,
          category,
          description: desc,
          is_installment: inst.is_installment,
          installment_months: inst.installment_months,
          monthly_recognized_amount: inst.monthly_recognized_amount,
          installment_start_date: inst.installment_start_date
        };

        const { error } = await ctx.supabase.from('expenses').insert(expensePayload);
        if (error) {
          ctx.logger.error('DATABASE', 'Supabase insert failure', error);
          await ctx.interactions.safeEditReply(
            i,
            '지출 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
            'modal:expense:add:db_failure'
          );
          return true;
        }
        await ctx.interactions.safeEditReply(i, `✅ **${category}** 지출 기록 완료!`, 'modal:expense:add:success');
        return true;
      }
    },
    {
      name: 'modal:cashflow:add',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:cashflow:add',
      handle: async (i, ctx: DiscordInteractionContext) => {
        ctx.logger.info('INTERACTION', 'modal submit received: modal:cashflow:add', { user: i.user.tag });
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        try {
          const flowTypeRaw = i.fields.getTextInputValue('flow_type');
          const flowType = parseCashflowFlowType(flowTypeRaw);
          const amount = parsePositiveAmount(i.fields.getTextInputValue('amount'));
          const description = sanitizeDescription(i.fields.getTextInputValue('desc'));

          if (!flowType || !amount) {
            ctx.logger.warn('INTERACTION', 'validation failure: modal:cashflow:add', {
              flowTypeRaw,
              amountRaw: i.fields.getTextInputValue('amount')
            });
            await ctx.interactions.safeEditReply(
              i,
              '입력값을 확인해주세요. 금액과 유형이 올바르지 않습니다. 유형: SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, LOAN_INTEREST, CONSUMPTION, OTHER_IN, OTHER_OUT (레거시 영문 별칭도 허용)',
              'modal:cashflow:add:validation_failure'
            );
            return true;
          }

          ctx.logger.info('INTERACTION', 'validation success: modal:cashflow:add', { flowType, amount });
          const payload = {
            discord_user_id: ctx.getDiscordUserId(i.user),
            flow_type: flowType,
            amount,
            description,
            flow_date: new Date().toISOString()
          };

          ctx.logger.info('DB', '[cashflow][insert] attempt', { table: 'cashflow', payloadKeys: Object.keys(payload) });
          const { error } = await ctx.supabase.from('cashflow').insert(payload);
          if (error) {
            logSchemaSafeInsertFailure('cashflow', payload, error);
            await ctx.interactions.safeEditReply(
              i,
              '현금흐름 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
              'modal:cashflow:add:db_failure'
            );
            return true;
          }

          ctx.logger.info('DB', '[cashflow][insert] success', { userId: i.user.id, flowType, amount });
          await ctx.interactions.safeEditReply(i, '현금흐름이 정상적으로 저장되었습니다.', 'modal:cashflow:add:success');
        } catch (modalError: unknown) {
          ctx.logger.error('INTERACTION', 'modal:cashflow:add exception', modalError);
          await ctx.interactions.safeEditReply(
            i,
            '현금흐름 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
            'modal:cashflow:add:exception'
          );
        }
        return true;
      }
    }
  ];
}
