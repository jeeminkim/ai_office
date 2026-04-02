import {
  ActionRowBuilder,
  InteractionType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { routeEarlyButtonInteraction } from '../../../interactions/interactionRouter';
import { isMainPanelInteraction } from '../../../interactions/panelInteractionHandler';
import {
  handleInstrumentCancel,
  handleInstrumentConfirm,
  handleInstrumentPick
} from '../../../interactions/instrumentConfirmationHandler';
import {
  tryHandlePortfolioButton,
  tryHandlePortfolioModalSubmit,
  tryHandlePortfolioStringSelect
} from '../../../interactions/portfolioInteractionHandler';
import { decideOrchestratorRoute, logOrchestratorDecision } from '../../../../orchestrator';
import { detectFinancialIntent } from '../../analysisFormatting';
import { trendTopicFromCustomId } from '../../../../trendAnalysis';
import { savePanelState } from '../../../../panelManager';
import { splitDiscordMessage } from '../../../../discordResponseUtils';
import {
  analyzeLogs,
  generateActionsView,
  generateDetailView,
  generateSystemReport
} from '../../../../logAnalysisService';
import { getRebalancePlanById, getLatestPendingRebalancePlan } from '../../../repositories/rebalancePlanRepository';
import {
  dismissRebalancePlanHold,
  executeRebalancePlanComplete,
  renderPlanItemsText
} from '../../../application/executeRebalancePlanAppService';
import { buildPersonaScorecards, formatPersonaScorecardDiscord } from '../../../services/personaScorecardService';
import { runClaimOutcomeAuditAppService } from '../../../application/runClaimOutcomeAuditAppService';
import { parseCashflowFlowType } from '../../../finance/cashflowCategories';
import { parseInstallmentLine } from '../../../finance/expenseInstallment';
import { parsePositiveAmount, sanitizeDescription } from '../../formParsing';
import { logSchemaSafeInsertFailure } from '../../schemaInsertErrors';
import type { InteractionRoute } from '../../interactionRegistry';
import type { DiscordInteractionContext, UserRiskMode } from '../../InteractionContext';
import { handleDecisionButtonInteraction } from './decisionHandler';
import { handleFeedbackSaveButtonInteraction } from './feedbackHandler';
import {
  handleFollowupInputButton,
  handleFollowupMenuInteraction,
  handleFollowupModalSubmit,
  handleFollowupSelectButton
} from './followupHandlers';
import { financialCommandQueryMap, trendCommandQueryMap } from './commandMaps';

/**
 * interactionCreate 분기 — 등록 순서가 우선순위다 (기존 index.ts if 체인과 동일).
 */
export function buildInteractionRoutes(): {
  buttonRoutes: InteractionRoute[];
  stringSelectRoutes: InteractionRoute[];
  modalRoutes: InteractionRoute[];
} {
  const buttonRoutes: InteractionRoute[] = [
    {
      name: 'decision:select',
      match: i => i.isButton() && i.customId.startsWith('decision:select|'),
      handle: async (i, ctx) => {
        await handleDecisionButtonInteraction(i, ctx);
        return true;
      }
    },
    {
      name: 'followup:select',
      match: i => i.isButton() && i.customId.startsWith('followup:select|'),
      handle: async (i, ctx) => {
        await handleFollowupSelectButton(i, ctx);
        return true;
      }
    },
    {
      name: 'followup:input',
      match: i => i.isButton() && i.customId.startsWith('followup:input|'),
      handle: async (i, ctx) => {
        await handleFollowupInputButton(i, ctx);
        return true;
      }
    },
    {
      name: 'feedback:save',
      match: i => i.isButton() && i.customId.startsWith('feedback:save:'),
      handle: async (i, ctx) => {
        await handleFeedbackSaveButtonInteraction(i, ctx);
        return true;
      }
    },
    {
      name: 'instr:confirm',
      match: i => i.isButton() && i.customId.startsWith('instr:confirm:'),
      handle: async (i, ctx) => {
        await handleInstrumentConfirm(i, ctx.portfolio.modalDeps);
        return true;
      }
    },
    {
      name: 'instr:cancel',
      match: i => i.isButton() && i.customId.startsWith('instr:cancel:'),
      handle: async (i, ctx) => {
        await handleInstrumentCancel(i, ctx.portfolio.modalDeps);
        return true;
      }
    },
    {
      name: 'panel:main:early',
      match: i => i.isButton() && isMainPanelInteraction(i.customId),
      handle: async (i, ctx) => {
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
      handle: async (i, ctx) => {
        const msg = await (i.channel as { send?: (p: unknown) => Promise<{ channel: { id: string }; id: string }> })?.send?.(
          ctx.panel.getMainPanel()
        );
        if (msg) savePanelState(msg.channel.id, msg.id);
        ctx.logger.info('PANEL', 'Explicit reinstall via button', { channelId: msg?.channel.id, messageId: msg?.id });
        ctx.updateHealth(s => (s.panels.lastPanelAction = 'button_reinstall'));
        await i.message?.delete().catch(() => {});
        return true;
      }
    },
    {
      name: 'trend:panel:topic',
      match: i => {
        if (!i.isButton()) return false;
        const cid = i.customId;
        const trendTopicBtn = trendTopicFromCustomId(cid);
        return trendTopicBtn != null && !!trendCommandQueryMap[cid];
      },
      handle: async (i, ctx) => {
        const cid = i.customId;
        const query = trendCommandQueryMap[cid];
        const trendTopicBtn = trendTopicFromCustomId(cid)!;
        const statusText = '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `${cid}:status`);
        await ctx.runtime.runTrendAnalysis(i.user.id, query, i, trendTopicBtn, cid);
        return true;
      }
    },
    {
      name: 'panel:data:center_presets',
      match: i =>
        i.isButton() && (i.customId === 'panel:data:daily_logs' || i.customId === 'panel:data:improvement'),
      handle: async (i, ctx) => {
        const cid = i.customId;
        const action = cid === 'panel:data:daily_logs' ? 'daily_log_analysis' : 'system_improvement_suggestion';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReply(i, '🗄 **데이터 센터 분석 실행 중...**', `${cid}:status`);
        await ctx.runtime.runDataCenterAction(i.user.id, action, i);
        return true;
      }
    },
    {
      name: 'rebalance:actions',
      match: i => i.isButton() && /^rebalance:(view|complete|hold):([0-9a-f-]{36})$/i.test(i.customId),
      handle: async (i, ctx) => {
        const cid = i.customId;
        const rebMatch = /^rebalance:(view|complete|hold):([0-9a-f-]{36})$/i.exec(cid);
        if (!rebMatch) return false;
        const act = rebMatch[1].toLowerCase();
        const planId = rebMatch[2];
        const uid = i.user.id;
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        if (act === 'view') {
          const { plan, items, error } = await getRebalancePlanById(planId);
          if (error || !plan || plan.discord_user_id !== uid) {
            await ctx.interactions.safeEditReply(i, '플랜을 찾을 수 없거나 권한이 없습니다.', 'rebalance:view');
            return true;
          }
          const txt = renderPlanItemsText(items, plan.plan_header, plan.fx_usdkrw);
          await ctx.interactions.safeEditReply(i, txt.slice(0, 1990), 'rebalance:view');
          return true;
        }
        if (act === 'complete') {
          const r = await executeRebalancePlanComplete({ discordUserId: uid, planId });
          await ctx.interactions.safeEditReply(i, r.message, 'rebalance:complete');
          return true;
        }
        if (act === 'hold') {
          const r = await dismissRebalancePlanHold({ discordUserId: uid, planId });
          await ctx.interactions.safeEditReply(i, r.message, 'rebalance:hold');
          return true;
        }
        return false;
      }
    },
    {
      name: 'panel:data:persona_report',
      match: i => i.isButton() && i.customId === 'panel:data:persona_report',
      handle: async (i, ctx) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const uid = i.user.id;
        const c7 = await buildPersonaScorecards({ discordUserId: uid, windowDays: 7 });
        const c30 = await buildPersonaScorecards({ discordUserId: uid, windowDays: 30 });
        const t =
          formatPersonaScorecardDiscord(c7, '최근 7일') +
          '\n\n' +
          formatPersonaScorecardDiscord(c30, '최근 30일');
        const chunks = splitDiscordMessage(t, 1800);
        await ctx.interactions.safeEditReply(i, chunks[0] || t, 'panel:data:persona_report');
        return true;
      }
    },
    {
      name: 'panel:data:claim_audit',
      match: i => i.isButton() && i.customId === 'panel:data:claim_audit',
      handle: async (i, ctx) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const r = await runClaimOutcomeAuditAppService({ discordUserId: i.user.id, limit: 60 });
        const msg =
          `claim 감사 배치 완료 · 갱신 ${r.updated} · 스킵 ${r.skipped}` +
          (r.errors.length ? ` · 오류 ${r.errors.slice(0, 2).join('; ')}` : '');
        await ctx.interactions.safeEditReply(i, msg, 'panel:data:claim_audit');
        return true;
      }
    },
    {
      name: 'panel:data:rebalance_view',
      match: i => i.isButton() && i.customId === 'panel:data:rebalance_view',
      handle: async (i, ctx) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const uid = i.user.id;
        const { plan, items, error } = await getLatestPendingRebalancePlan(uid);
        if (error) {
          await ctx.interactions.safeEditReply(i, `조회 실패: ${error}`, 'panel:data:rebalance_view:err');
          return true;
        }
        if (!plan) {
          await ctx.interactions.safeEditReply(i, '대기 중인 리밸런싱 계획이 없습니다.', 'panel:data:rebalance_view:empty');
          return true;
        }
        const txt = renderPlanItemsText(items, plan.plan_header, plan.fx_usdkrw);
        await ctx.interactions.safeEditReply(i, txt.slice(0, 1990), 'panel:data:rebalance_view');
        return true;
      }
    },
    {
      name: 'panel:system:log_analysis',
      match: i =>
        i.isButton() &&
        (i.customId === 'panel:system:check' ||
          i.customId === 'panel:system:detail' ||
          i.customId === 'panel:system:actions'),
      handle: async (i, ctx) => {
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        const cid = i.customId;
        const r = analyzeLogs();
        const raw =
          cid === 'panel:system:check'
            ? generateSystemReport(r)
            : cid === 'panel:system:detail'
              ? generateDetailView(r)
              : generateActionsView(r);
        ctx.logger.info('DATA_CENTER', 'system_log_analysis', {
          customId: cid,
          status: r.systemStatus,
          issueCount: r.issues.length,
          warnCount: r.warnings.length
        });
        const chunks = splitDiscordMessage(raw, 1800);
        await ctx.interactions.safeEditReply(i, chunks[0] || '_내용 없음_', `panel:system:${cid}`);
        for (let j = 1; j < chunks.length; j++) {
          await i.followUp({ content: chunks[j], ephemeral: true }).catch(() => {});
        }
        return true;
      }
    },
    {
      name: 'financial:panel:commands',
      match: i => i.isButton() && !!financialCommandQueryMap[i.customId],
      handle: async (i, ctx) => {
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
      name: 'portfolio:tryHandle',
      match: i => i.isButton() && String(i.customId).startsWith('panel:portfolio:'),
      handle: async (i, ctx) => {
        const consumed = await tryHandlePortfolioButton(i, ctx.portfolio.interactionDeps);
        return consumed;
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
      handle: async (i, ctx) => {
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
    },
    {
      name: 'panel:settings:view',
      match: i => i.isButton() && i.customId === 'panel:settings:view',
      handle: async (i, ctx) => {
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
      handle: async (i, ctx) => {
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

  const stringSelectRoutes: InteractionRoute[] = [
    {
      name: 'instr:pick',
      match: i => i.isStringSelectMenu() && i.customId.startsWith('instr:pick:'),
      handle: async (i, ctx) => {
        const ok = await handleInstrumentPick(i, ctx.portfolio.modalDeps);
        return ok;
      }
    },
    {
      name: 'followup:menu',
      match: i => i.isStringSelectMenu() && i.customId.startsWith('followup:menu|'),
      handle: async (i, ctx) => {
        await handleFollowupMenuInteraction(i, ctx);
        return true;
      }
    },
    {
      name: 'portfolio:string_select',
      match: i => i.isStringSelectMenu(),
      handle: async (i, ctx) => {
        const consumed = await tryHandlePortfolioStringSelect(i, ctx.portfolio.interactionDeps);
        return consumed;
      }
    }
  ];

  const modalRoutes: InteractionRoute[] = [
    {
      name: 'modal:followup',
      match: i => i.type === InteractionType.ModalSubmit && i.customId.startsWith('modal:followup:'),
      handle: async (i, ctx) => {
        await handleFollowupModalSubmit(i, ctx);
        return true;
      }
    },
    {
      name: 'modal:trend:free',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:trend:free',
      handle: async (i, ctx) => {
        const query = i.fields.getTextInputValue('query');
        const statusText = '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `modal:trend:free:status`);
        await ctx.runtime.runTrendAnalysis(i.user.id, query, i, 'free', 'modal:trend:free');
        return true;
      }
    },
    {
      name: 'modal:ai:ask',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:ai:ask',
      handle: async (i, ctx) => {
        const orch = decideOrchestratorRoute({ modalId: 'modal:ai:ask' });
        logOrchestratorDecision(orch, { source: 'modal:ai:ask' });
        const query = i.fields.getTextInputValue('query');
        const isFinancial = detectFinancialIntent(query);
        const statusText = isFinancial
          ? '📊 **포트폴리오 기반 재무 분석 중...**'
          : '📌 **자유 주제 분석 중…** (포트폴리오 스냅샷 미사용)';
        await ctx.interactions.safeDeferReply(i, { flags: 64 });
        await ctx.interactions.safeEditReplyPayload(i, { content: statusText }, `modal:ai:ask:status`);
        if (isFinancial) {
          await ctx.runtime.runPortfolioDebate(i.user.id, query, i);
        } else {
          await ctx.runtime.runOpenTopicDebate(i.user.id, query, i);
        }
        return true;
      }
    },
    {
      name: 'portfolio:modal_submit',
      match: i => i.type === InteractionType.ModalSubmit,
      handle: async (i, ctx) => {
        const consumed = await tryHandlePortfolioModalSubmit(i, ctx.portfolio.modalDeps);
        return consumed;
      }
    },
    {
      name: 'modal:expense:add',
      match: i => i.type === InteractionType.ModalSubmit && i.customId === 'modal:expense:add',
      handle: async (i, ctx) => {
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
      handle: async (i, ctx) => {
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

  return { buttonRoutes, stringSelectRoutes, modalRoutes };
}
