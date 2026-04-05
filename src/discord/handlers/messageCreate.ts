import type { Message } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TrendTopicKind } from '../../../trendAnalysis';
import { decideOrchestratorRoute, logOrchestratorDecision } from '../../../orchestrator';
import { logger, updateHealth } from '../../../logger';
import { loadPanelState, savePanelState, getMainPanel } from '../../../panelManager';
import { resolveInstrumentMetadata } from '../../../instrumentRegistry';
import { normalizeSymbol, parseNumberStrict } from '../formParsing';
import { parseCashflowFlowType } from '../../finance/cashflowCategories';
import { recordBuyTrade, createAccount, GENERAL_ACCOUNT_NAME } from '../../../tradeService';
import { learnBehaviorFromTrades } from '../../../profileService';
import { detectFinancialIntent } from '../analysisFormatting';

function isTrendQueryCheck(query: string): boolean {
  return /(트렌드|유행|k-?pop|드라마|넷플릭스|스포츠|콘텐츠|아이돌|엔터|기회|시장)/i.test(query);
}

export type MessageCreateContext = {
  logger: typeof logger;
  supabase: SupabaseClient;
  getDiscordUserId: (user: { id: string }) => string;
  loadPanelState: typeof loadPanelState;
  savePanelState: typeof savePanelState;
  getMainPanel: typeof getMainPanel;
  updateHealth: typeof updateHealth;
  resolveInstrumentMetadata: typeof resolveInstrumentMetadata;
  normalizeSymbol: typeof normalizeSymbol;
  parseNumberStrict: typeof parseNumberStrict;
  parseCashflowFlowType: typeof parseCashflowFlowType;
  recordBuyTrade: typeof recordBuyTrade;
  learnBehaviorFromTrades: typeof learnBehaviorFromTrades;
  createAccount: typeof createAccount;
  GENERAL_ACCOUNT_NAME: string;
  decideOrchestratorRoute: typeof decideOrchestratorRoute;
  logOrchestratorDecision: typeof logOrchestratorDecision;
  detectFinancialIntent: typeof detectFinancialIntent;
  runtime: {
    runTrendAnalysis: (
      userId: string,
      userQuery: string,
      sourceInteraction: Message,
      topic: TrendTopicKind | 'free',
      triggerCustomId?: string,
      opts?: { fastMode?: 'none' | 'short' }
    ) => Promise<void>;
    runPortfolioDebate: (
      userId: string,
      userQuery: string,
      sourceInteraction: Message,
      opts?: { fastMode?: 'none' | 'light_summary' | 'short_summary' | 'retry_summary' }
    ) => Promise<void>;
    runOpenTopicDebate: (
      userId: string,
      userQuery: string,
      sourceInteraction: Message,
      opts?: {
        fastMode?: 'none' | 'light_summary' | 'short_summary';
        forcedOpenTopicView?: 'financial' | 'trend' | 'general';
      }
    ) => Promise<void>;
  };
};

export async function handleMessageCreate(message: Message, ctx: MessageCreateContext): Promise<void> {
  if (message.author.bot) return;

  if (message.content.startsWith('!')) {
    ctx.logger.info('COMMAND', `message command received: ${message.content}`, { user: message.author.tag });
  }

  if (message.content === '!메뉴') {
    const panel = ctx.getMainPanel();
    const ch: any = message.channel;
    if (typeof ch?.send !== 'function') return;
    const msg = await ch.send({
      content: '다음 메뉴를 선택하세요',
      embeds: panel.embeds,
      components: panel.components
    });
    ctx.savePanelState(msg.channel.id, msg.id);
    ctx.logger.info('PANEL', 'MENU_RENDERED_NEW_MESSAGE', {
      channelId: msg.channel.id,
      messageId: msg.id
    });
    ctx.updateHealth(s => (s.panels.lastPanelAction = 'manual_reinstall'));
    return;
  }

  if (message.content === '!패널재설치') {
    const state = ctx.loadPanelState();
    let msg: any = null;
    if (state?.channelId === message.channel.id && state.messageId) {
      const oldMsg = await (message.channel as any).messages.fetch(state.messageId).catch(() => null);
      if (oldMsg) {
        msg = await oldMsg.edit(ctx.getMainPanel()).catch(() => null);
      }
    }
    if (!msg) {
      msg = await message.reply(ctx.getMainPanel());
    }
    ctx.savePanelState(msg.channel.id, msg.id);
    ctx.logger.info('PANEL', 'Explicit reinstall via text command', {
      channelId: msg.channel.id,
      messageId: msg.id,
      mode: msg.id === state?.messageId ? 'edit_existing' : 'send_new'
    });
    ctx.updateHealth(s => (s.panels.lastPanelAction = 'manual_reinstall'));
    return;
  }

  if (message.content.startsWith('!종목추가')) {
    const parts = message.content.split(' ');
    if (parts.length < 4) return void message.reply("❌ 사용법: `!종목추가 [심볼] [수량] [평단가] [종목명?] [섹터?]`");
    const [_, symbolInput, qtyStr, priceStr, name = symbolInput, sector = 'Unknown'] = parts;
    const resolved = ctx.resolveInstrumentMetadata(symbolInput, undefined);
    const normalizedSymbol = resolved?.symbol || ctx.normalizeSymbol(symbolInput);
    const market = resolved?.market || 'KR';
    const currency = resolved?.currency || 'KRW';
    const displayName = resolved?.displayName || name;
    const quoteSymbol = resolved?.quoteSymbol || normalizedSymbol;
    const exchange = resolved?.exchange || null;
    const qty = ctx.parseNumberStrict(qtyStr);
    const price = ctx.parseNumberStrict(priceStr);
    if (qty === null || price === null) return void message.reply('❌ 수량과 평단가는 숫자로 입력해주세요.');

    await ctx.supabase.from('stocks').upsert({ symbol: normalizedSymbol, name: displayName, sector });
    try {
      await ctx.recordBuyTrade({
        discordUserId: ctx.getDiscordUserId(message.author),
        symbol: normalizedSymbol,
        displayName,
        quoteSymbol,
        exchange,
        market: market === 'US' ? 'US' : 'KR',
        currency: currency === 'USD' ? 'USD' : 'KRW',
        purchaseCurrency: market === 'US' ? (currency === 'USD' ? 'USD' : 'KRW') : 'KRW',
        quantity: qty,
        pricePerUnit: price,
        memo: '!종목추가'
      });
      void ctx.learnBehaviorFromTrades(ctx.getDiscordUserId(message.author));
    } catch (e: any) {
      ctx.logger.error('DATABASE', 'trade buy record failure', e);
      return void message.reply(`❌ 등록 실패: ${e?.message || String(e)}`);
    }
    return void message.reply(`✅ **${displayName}(${quoteSymbol})** 종목 추가 완료! (거래 원장 반영)`);
  }

  if (message.content.startsWith('!계좌추가')) {
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) {
      return void message.reply('❌ 사용법: `!계좌추가 [계좌이름] [TAXABLE|RETIREMENT|PENSION|ISA|OTHER]`');
    }
    const accountName = parts[1];
    const typeRaw = (parts[2] || 'OTHER').toUpperCase();
    const allowed = new Set(['TAXABLE', 'RETIREMENT', 'PENSION', 'ISA', 'OTHER']);
    const accountType = (allowed.has(typeRaw) ? typeRaw : 'OTHER') as
      | 'TAXABLE'
      | 'RETIREMENT'
      | 'PENSION'
      | 'ISA'
      | 'OTHER';
    try {
      await ctx.createAccount({
        discordUserId: ctx.getDiscordUserId(message.author),
        accountName,
        accountType
      });
      ctx.logger.info('ACCOUNT', 'account applied to portfolio/trade', { accountName, accountType });
      return void message.reply(
        `✅ 계좌 **${accountName}** (${accountType}) 생성 완료. **${ctx.GENERAL_ACCOUNT_NAME}**는 자동 생성되며 미지정 매수 시 해당 계좌에 반영됩니다.`
      );
    } catch (e: any) {
      return void message.reply(`❌ 계좌 생성 실패: ${e?.message || String(e)}`);
    }
  }

  if (message.content.startsWith('!내계좌')) {
    const uid = ctx.getDiscordUserId(message.author);
    const { data, error } = await ctx.supabase
      .from('accounts')
      .select('account_name, account_type, id')
      .eq('discord_user_id', uid)
      .order('created_at', { ascending: true });
    if (error) return void message.reply(`❌ 조회 실패: ${error.message}`);
    if (!data?.length) return void message.reply('등록된 계좌가 없습니다. `!계좌추가` 로 추가하세요.');
    const lines = data.map(a => `- **${a.account_name}** (${a.account_type}) \`${a.id}\``);
    return void message.reply(['**내 계좌 목록**', ...lines].join('\n'));
  }

  if (message.content.startsWith('!지출추가')) {
    const parts = message.content.split(' ');
    if (parts.length < 3) return void message.reply('❌ 사용법: `!지출추가 [금액] [카테고리] [설명...]`');
    const [_, amountStr, category, ...descParts] = parts;
    const amount = ctx.parseNumberStrict(amountStr);
    if (amount === null) return void message.reply('❌ 금액은 숫자로 입력해주세요.');

    const { error } = await ctx.supabase.from('expenses').insert({
      discord_user_id: ctx.getDiscordUserId(message.author),
      amount,
      category,
      description: descParts.join(' ')
    });
    if (error) {
      ctx.logger.error('DATABASE', 'Supabase insert failure', error);
      return void message.reply(`❌ 등록 실패: ${error.message}`);
    }
    return void message.reply(`✅ **${category}** 지출 기록 추가 완료!`);
  }

  if (message.content.startsWith('!현금흐름추가')) {
    const parts = message.content.split(' ');
    if (parts.length < 3) {
      return void message.reply(
        '❌ 사용법: `!현금흐름추가 [유형] [금액] [설명...]` — 유형: SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, LOAN_INTEREST, CONSUMPTION, OTHER_IN, OTHER_OUT'
      );
    }
    const [_, typeRaw, amountStr, ...descParts] = parts;
    const flowType = ctx.parseCashflowFlowType(typeRaw);
    if (!flowType) {
      return void message.reply(
        '❌ 잘못된 현금흐름 유형입니다. (SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, LOAN_INTEREST, CONSUMPTION, OTHER_IN, OTHER_OUT 중 택 1)'
      );
    }

    const amount = ctx.parseNumberStrict(amountStr);
    if (amount === null) return void message.reply('❌ 금액은 숫자로 입력해주세요.');

    const { error } = await ctx.supabase.from('cashflow').insert({
      discord_user_id: ctx.getDiscordUserId(message.author),
      flow_type: flowType,
      amount,
      description: descParts.join(' '),
      flow_date: new Date().toISOString()
    });
    if (error) {
      ctx.logger.error('DATABASE', 'Supabase insert failure', error);
      return void message.reply(`❌ 등록 실패: ${error.message}`);
    }
    return void message.reply(`✅ **${flowType}** 현금흐름 추가 완료!`);
  }

  if (message.content.startsWith('!토론')) {
    const orch = ctx.decideOrchestratorRoute({ messagePrefix: message.content });
    ctx.logOrchestratorDecision(orch, { source: '!토론' });
    const userQuery = message.content.replace('!토론', '').trim() || '현재 내 상황을 점검해줘.';
    const isTrend = isTrendQueryCheck(userQuery);
    const isFinancial = ctx.detectFinancialIntent(userQuery);

    const statusText = isTrend
      ? '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)'
      : isFinancial
        ? '📊 **포트폴리오 기반 재무 분석 토론 중...**'
        : '📌 **자유 주제 분석 중…** (포트폴리오 스냅샷 미사용)';

    const loadingMsg = await message.reply(statusText);
    if (isTrend) {
      await ctx.runtime.runTrendAnalysis(message.author.id, userQuery, loadingMsg, 'free', undefined);
    } else if (isFinancial) {
      await ctx.runtime.runPortfolioDebate(message.author.id, userQuery, loadingMsg);
    } else {
      await ctx.runtime.runOpenTopicDebate(message.author.id, userQuery, loadingMsg);
    }
    await loadingMsg.delete().catch(() => {});
  }
}
