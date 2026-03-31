import 'dotenv/config';
import {
    Client,
    GatewayIntentBits,
    WebhookClient,
    Message,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Interaction,
    Events,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType
} from 'discord.js';
import { logger, updateHealth, startHeartbeat } from './logger';
import { JYPAgent } from './agents';
import { createClient } from '@supabase/supabase-js';
import {
    ensureMainPanelOnBoot,
    savePanelState,
    loadPanelState,
    getMainPanel,
    getPortfolioPanel,
    getPortfolioMorePanel,
    getFinancePanel,
    getAIPanel,
    getTrendPanel,
    getDataCenterPanel,
    getSettingsPanel,
    getNoDataButtons,
    getQuickNavigationRows,
    type QuickNavHighlight
} from './panelManager';
import { buildPortfolioSnapshot } from './portfolioService';
import { resolveInstrumentMetadata } from './instrumentRegistry';
import { trendTopicFromCustomId, type TrendTopicKind } from './trendAnalysis';
import { learnBehaviorFromSnapshots, learnBehaviorFromTrades, loadUserProfile } from './profileService';
import { saveAnalysisFeedbackHistory, type FeedbackType } from './feedbackService';
import { ingestPersonaFeedback } from './feedbackIngestionService';
import { findChatHistoryById } from './src/repositories/chatHistoryRepository';
import {
    recordBuyTrade,
    recordSellTrade,
    findPortfolioRowForSymbol,
    findPortfolioRowInAccount,
    findFirstRetirementAccount,
    listUserAccounts,
    createAccount,
    getOrCreateDefaultAccountId,
    GENERAL_ACCOUNT_NAME
} from './tradeService';
import { buildPortfolioDiscordMessage, accountTypeLabelKo } from './portfolioUx';
import type { PortfolioSnapshot } from './portfolioService';
import { maybeStoreDailyPortfolioSnapshotHistory } from './snapshotService';
import { decideOrchestratorRoute, logOrchestratorDecision } from './orchestrator';
import { routeEarlyButtonInteraction } from './src/interactions/interactionRouter';
import { runDataCenterAppService } from './src/application/runDataCenterAppService';
import { splitDiscordMessage, chooseInteractionRoute } from './discordResponseUtils';
import { generateGeminiResponse } from './geminiLlmService';
import type { PersonaKey } from './analysisTypes';
import { insertChatHistoryWithLegacyFallback } from './src/repositories/chatHistoryRepository';
import { detectFinancialIntent, normalizeProviderOutputForDiscord } from './src/discord/analysisFormatting';
import { runPortfolioDebateAppService } from './src/application/runPortfolioDebateAppService';
import { formatDecisionSummaryForDiscord } from './src/application/runDecisionEngineAppService';
import { buildRebalancePlanAppService } from './src/application/buildRebalancePlanAppService';
import {
    dismissRebalancePlanHold,
    executeRebalancePlanComplete,
    renderPlanItemsText
} from './src/application/executeRebalancePlanAppService';
import { runClaimOutcomeAuditAppService } from './src/application/runClaimOutcomeAuditAppService';
import { getRebalancePlanById, getLatestPendingRebalancePlan } from './src/repositories/rebalancePlanRepository';
import { buildPersonaScorecards, formatPersonaScorecardDiscord } from './src/services/personaScorecardService';
import { runTrendAnalysisAppService } from './src/application/runTrendAnalysisAppService';
import { runOpenTopicDebateAppService } from './src/application/runOpenTopicDebateAppService';
import {
    isDecisionPrompt,
    extractDecisionOptions,
    buildDecisionButtonsRow,
    logDecisionPromptDetected
} from './decisionPrompt';
import { executeDecisionAfterSelection } from './decisionExecutionService';
import {
    insertDecisionSnapshot,
    getDecisionSnapshotById,
    insertDecisionHistoryRow
} from './src/repositories/decisionRepository';
import {
    handleInstrumentConfirm,
    handleInstrumentCancel,
    handleInstrumentPick
} from './src/interactions/instrumentConfirmationHandler';
import { parseCashflowFlowType } from './src/finance/cashflowCategories';
import { parseInstallmentLine } from './src/finance/expenseInstallment';
import {
    tryHandlePortfolioButton,
    tryHandlePortfolioModalSubmit,
    tryHandlePortfolioStringSelect
} from './src/interactions/portfolioInteractionHandler';

logger.info('BOOT', 'index initialization started');

function validateEnv() {
    const env = {
        DISCORD_TOKEN: process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN,
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL
    };
    const missing = Object.entries(env)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missing.length > 0) {
        logger.error('ENV', 'Missing required environment variables', { missing });
        updateHealth(s => s.discord.lastError = `Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }

    logger.info('ENV', 'Environment validation passed', {
        keysChecked: ['DISCORD_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'DISCORD_WEBHOOK_URL']
    });

    return {
        DISCORD_TOKEN: env.DISCORD_TOKEN as string,
        SUPABASE_URL: env.SUPABASE_URL as string,
        SUPABASE_KEY: env.SUPABASE_SERVICE_ROLE_KEY as string,
        WEBHOOK_URL: env.DISCORD_WEBHOOK_URL as string
    };
}

const { DISCORD_TOKEN, SUPABASE_URL, SUPABASE_KEY, WEBHOOK_URL } = validateEnv();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const webhook = new WebhookClient({ url: WEBHOOK_URL });
startHeartbeat();

function parseNumberStrict(value: string): number | null {
    if (!value) return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
}

function normalizeSymbol(value: string): string {
    return (value || '').trim().toUpperCase();
}

function formatKrw(v: number): string {
    return `${Math.round(v).toLocaleString('ko-KR')}원`;
}

/** `analysis_claims.persona_name` / `src/discord/analysisFormatting.ts` 과 동일 계열로 맞춤 (claim 매핑 정합성). */
function personaKeyToDisplayNameForFeedback(personaKey: string): string {
    const k = personaKey as PersonaKey;
    switch (k) {
        case 'RAY': return 'Ray Dalio (PB)';
        case 'HINDENBURG': return 'HINDENBURG_ANALYST';
        case 'JYP': return 'JYP (Analyst)';
        case 'SIMONS': return 'James Simons (Quant)';
        case 'DRUCKER': return 'Peter Drucker (COO)';
        case 'CIO': return 'Stanley Druckenmiller (CIO)';
        case 'TREND': return 'Trend Analyst';
        case 'OPEN_TOPIC': return 'Open Topic Analyst';
        case 'THIEL': return 'Peter Thiel (Data Center)';
        case 'HOT_TREND': return '전현무 · 핫 트렌드 분석';
        default: return personaKey || 'Unknown';
    }
}

function getFeedbackButtonsRow(chatHistoryId: number, analysisType: string, personaKey: PersonaKey): ActionRowBuilder<ButtonBuilder> {
    const mk = (feedbackType: FeedbackType, label: string, style: ButtonStyle) =>
        new ButtonBuilder()
            .setCustomId(`feedback:save:${chatHistoryId}:${analysisType}:${feedbackType}:${personaKey}`)
            .setLabel(label)
            .setStyle(style);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        mk('TRUSTED', '👍 신뢰', ButtonStyle.Primary),
        mk('ADOPTED', '✅ 채택', ButtonStyle.Success),
        mk('BOOKMARKED', '📌 저장', ButtonStyle.Secondary),
        mk('DISLIKED', '👎 별로', ButtonStyle.Danger)
    );
}

function getPersonaColumnKey(personaKey: PersonaKey): 'ray_advice' | 'key_risks' | 'key_actions' | 'jyp_insight' | 'simons_opportunity' | 'drucker_decision' | 'cio_decision' | 'jyp_weekly_report' | 'summary' | 'trend_text' {
    switch (personaKey) {
        case 'RAY': return 'ray_advice';
        case 'HINDENBURG': return 'key_risks';
        case 'JYP': return 'jyp_insight';
        case 'SIMONS': return 'simons_opportunity';
        case 'DRUCKER': return 'drucker_decision';
        case 'CIO': return 'cio_decision';
        case 'TREND': return 'ray_advice'; // trend은 ray_advice 컬럼에 텍스트를 저장
        case 'OPEN_TOPIC': return 'jyp_insight'; // open topic은 기본적으로 jyp_insight에 저장
        default: return 'jyp_insight';
    }
}

function getDiscordUserId(user: { id: string }): string {
    return user.id;
}

/** 고급 매수/매도: 모달 직전에 선택한 계좌 (단일 프로세스 가정) */
const pendingBuyAccountId = new Map<string, string>();
const pendingSellAccountId = new Map<string, string>();

function parsePositiveAmount(value: string): number | null {
    const amount = parseNumberStrict(value);
    if (amount === null || amount <= 0) return null;
    return amount;
}

function sanitizeDescription(value: string): string {
    return (value || '').trim();
}

function isSchemaMismatchError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();
    return (
        message.includes('schema cache') ||
        message.includes('column') ||
        message.includes('does not exist') ||
        message.includes('could not find')
    );
}

function logSchemaSafeInsertFailure(table: string, payload: Record<string, unknown>, error: any) {
    const payloadKeys = Object.keys(payload);
    const scope = `DB][${table}][insert`;
    logger.error(scope, 'insert failed', {
        table,
        payloadKeys,
        errorMessage: error?.message || String(error),
        errorCode: error?.code || null,
        hint: isSchemaMismatchError(error) ? 'column mismatch suspected: check DB schema and payload keys' : null
    });
}

type PortfolioQueryUiMode = 'default' | 'all' | 'retirement' | 'account';

async function runPortfolioQueryFromButton(
    interaction: any,
    discordUserId: string,
    uiMode: PortfolioQueryUiMode,
    opts: {
        accountId?: string;
        accountName?: string;
        accountType?: string;
        orchestratorCustomId: string;
    }
): Promise<void> {
    await safeDeferReply(interaction, { flags: 64 });

    const orch = decideOrchestratorRoute({ customId: opts.orchestratorCustomId });
    logOrchestratorDecision(orch, { discordUserId, source: opts.orchestratorCustomId });

    let snapshot: PortfolioSnapshot;
    if (uiMode === 'default') {
        logger.info('UI', 'default account view selected', { discordUserId });
        snapshot = await buildPortfolioSnapshot(discordUserId, { scope: 'DEFAULT' });
    } else if (uiMode === 'all') {
        logger.info('UI', 'aggregate asset view selected', { discordUserId });
        snapshot = await buildPortfolioSnapshot(discordUserId, { scope: 'ALL' });
    } else {
        if (!opts.accountId) {
            await safeEditReply(interaction, '계좌를 찾을 수 없습니다.', 'portfolio:no_account');
            return;
        }
        if (uiMode === 'retirement') {
            logger.info('UI', 'retirement account view selected', { discordUserId, accountId: opts.accountId });
        } else {
            logger.info('UI', 'account-specific view selected', { discordUserId, accountId: opts.accountId });
        }
        snapshot = await buildPortfolioSnapshot(discordUserId, { scope: 'ACCOUNT', accountId: opts.accountId });
    }

    if (snapshot.summary.position_count === 0) {
        const emptyMsg =
            uiMode === 'default'
                ? '일반계좌에 조회할 보유 종목이 없습니다.'
                : uiMode === 'all'
                  ? '합산할 포지션이 없습니다.'
                  : '선택한 계좌에 조회할 보유 종목이 없습니다.';
        await safeEditReply(interaction, emptyMsg, 'portfolio:empty');
        return;
    }

    let snapshotFooter: 'saved' | 'duplicate' | 'none' = 'none';
    try {
        if (uiMode === 'all') {
            const stored = await maybeStoreDailyPortfolioSnapshotHistory(discordUserId, snapshot, {
                accountId: null,
                snapshotKind: 'aggregate'
            });
            if (stored) void learnBehaviorFromSnapshots(discordUserId);
            snapshotFooter = stored ? 'saved' : 'duplicate';
        } else {
            const accId =
                uiMode === 'default' ? await getOrCreateDefaultAccountId(discordUserId) : opts.accountId!;
            const stored = await maybeStoreDailyPortfolioSnapshotHistory(discordUserId, snapshot, {
                accountId: accId,
                snapshotKind: 'account'
            });
            if (stored) void learnBehaviorFromSnapshots(discordUserId);
            snapshotFooter = stored ? 'saved' : 'duplicate';
        }
    } catch {
        snapshotFooter = 'none';
    }

    logger.info('UI', 'snapshot status shown', { discordUserId, snapshotFooter, uiMode });

    const viewModeForUx: 'default' | 'all' | 'retirement' | 'account' =
        uiMode === 'retirement' ? 'retirement' : uiMode === 'account' ? 'account' : uiMode;

    const text = buildPortfolioDiscordMessage(snapshot, {
        viewMode: viewModeForUx,
        generalAccountName: GENERAL_ACCOUNT_NAME,
        accountDisplayName: opts.accountName,
        accountTypeLabel: opts.accountType ? accountTypeLabelKo(opts.accountType) : undefined,
        snapshotFooter,
        hideAggregateAccountBreakdown: uiMode === 'all'
    });

    await safeEditReplyPayload(interaction, { content: text, flags: 64 }, 'portfolio:query:success');
    try {
        await interaction.followUp({
            content: '**다음 메뉴** — 스크롤 없이 바로 선택할 수 있습니다.',
            components: getQuickNavigationRows({ highlight: 'portfolio' }),
            flags: 64
        });
        logger.info('UI', 'post_response_navigation_attached', {
            context: 'portfolio:query:success',
            discordUserId
        });
    } catch (e: any) {
        logger.warn('UI', 'post_response_navigation_failed', { context: 'portfolio:query:success', message: e?.message });
    }
}

/** 계좌별 보기 — 에페머럴 메시지 + select 응답 */
async function runPortfolioQueryFromAccountSelect(interaction: any, discordUserId: string, accountId: string): Promise<void> {
    await ensureInteractionDeferred(interaction, 'update');
    const rows = await listUserAccounts(discordUserId);
    const acct = rows.find(a => a.id === accountId);
    if (!acct) {
        await safeEditReplyPayload(interaction, { content: '계좌를 찾을 수 없습니다.', components: [] }, 'portfolio:account_select:not_found');
        return;
    }

    logger.info('UI', 'account-specific view selected', { discordUserId, accountId });

    const snapshot = await buildPortfolioSnapshot(discordUserId, { scope: 'ACCOUNT', accountId });
    if (snapshot.summary.position_count === 0) {
        await safeEditReplyPayload(interaction, { content: '선택한 계좌에 조회할 보유 종목이 없습니다.', components: [] }, 'portfolio:account_select:empty');
        return;
    }

    let snapshotFooter: 'saved' | 'duplicate' | 'none' = 'none';
    try {
        const stored = await maybeStoreDailyPortfolioSnapshotHistory(discordUserId, snapshot, {
            accountId,
            snapshotKind: 'account'
        });
        if (stored) void learnBehaviorFromSnapshots(discordUserId);
        snapshotFooter = stored ? 'saved' : 'duplicate';
    } catch {
        snapshotFooter = 'none';
    }

    logger.info('UI', 'snapshot status shown', { discordUserId, snapshotFooter, uiMode: 'account' });

    const text = buildPortfolioDiscordMessage(snapshot, {
        viewMode: 'account',
        generalAccountName: GENERAL_ACCOUNT_NAME,
        accountDisplayName: acct.account_name,
        accountTypeLabel: accountTypeLabelKo(acct.account_type),
        snapshotFooter,
        hideAggregateAccountBreakdown: false
    });

    await safeEditReplyPayload(interaction, { content: text, components: [] }, 'portfolio:account_select:success');
    try {
        await interaction.followUp({
            content: '**다음 메뉴** — 스크롤 없이 바로 선택할 수 있습니다.',
            components: getQuickNavigationRows({ highlight: 'portfolio' }),
            flags: 64
        });
        logger.info('UI', 'post_response_navigation_attached', {
            context: 'portfolio:account_select:success',
            discordUserId
        });
    } catch (e: any) {
        logger.warn('UI', 'post_response_navigation_failed', {
            context: 'portfolio:account_select:success',
            message: e?.message
        });
    }
}

async function safeEditReply(interaction: any, content: string, context: string) {
    return safeEditReplyPayload(interaction, { content, flags: 64 }, context);
}

function normalizeInteractionPayload(payload: any): any {
    if (!payload || typeof payload !== 'object') return payload;
    const next = { ...payload };
    if ('ephemeral' in next) {
        if (next.ephemeral === true) next.flags = 64;
        delete next.ephemeral;
    }
    return next;
}

async function safeDeferReply(interaction: any, options: any = { flags: 64 }): Promise<boolean> {
    if (interaction.deferred || interaction.replied) {
        logger.warn('INTERACTION', 'defer skipped: already handled', {
            customId: interaction.customId,
            discordUserId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied
        });
        return false;
    }
    logger.info('INTERACTION', 'interaction deferred', {
        customId: interaction.customId,
        discordUserId: interaction.user?.id
    });
    await interaction.deferReply(normalizeInteractionPayload(options));
    logger.info('INTERACTION', 'interaction defer succeeded', {
        customId: interaction.customId,
        discordUserId: interaction.user?.id
    });
    return true;
}

async function safeDeferUpdate(interaction: any): Promise<boolean> {
    if (interaction.deferred || interaction.replied) {
        logger.info('INTERACTION', 'interaction defer skipped', {
            mode: 'update',
            customId: interaction.customId,
            deferred: interaction.deferred,
            replied: interaction.replied
        });
        return false;
    }
    logger.info('INTERACTION', 'interaction defer started', {
        mode: 'update',
        customId: interaction.customId,
        discordUserId: interaction.user?.id
    });
    await interaction.deferUpdate();
    logger.info('INTERACTION', 'interaction defer succeeded', {
        mode: 'update',
        customId: interaction.customId,
        discordUserId: interaction.user?.id
    });
    return true;
}

async function ensureInteractionDeferred(interaction: any, mode: 'reply' | 'update' = 'reply'): Promise<boolean> {
    if (mode === 'update') return safeDeferUpdate(interaction);
    return safeDeferReply(interaction, { flags: 64 });
}

async function safeSendChunkedInteractionContent(interaction: any, payload: any, context: string): Promise<void> {
    const normalizedPayload = normalizeInteractionPayload(payload || {});
    const rawContent = String(normalizedPayload?.content || '');
    const chunks = splitDiscordMessage(rawContent, 1800);
    if (rawContent.length > 2000) {
        logger.warn('DISCORD', 'discord content too long prevented', {
            context,
            originalLength: rawContent.length,
            chunkCount: chunks.length
        });
    }
    if (chunks.length > 1) {
        logger.info('DISCORD', 'message chunked count', { context, chunkCount: chunks.length });
    }
    const firstPayload = { ...normalizedPayload, content: chunks[0] || '' };
    const route = chooseInteractionRoute(interaction);
    logger.info('INTERACTION', 'reply route selected', { context, route, deferred: interaction.deferred, replied: interaction.replied });
    try {
        if (route === 'reply') {
            await interaction.reply(firstPayload);
        } else if (route === 'editReply') {
            await interaction.editReply(firstPayload);
        } else {
            await interaction.followUp(firstPayload);
        }
    } catch (e: any) {
        const msg = String(e?.message || '');
        if (route === 'editReply') {
            logger.warn('INTERACTION', 'editReply fallback to followUp', { context, message: msg });
            try {
                await interaction.followUp(firstPayload);
            } catch (e2: any) {
                logger.error('INTERACTION', 'unknown interaction caught', { context, message: e2?.message || String(e2) });
                if ((interaction as any)?.channel?.send) {
                    await (interaction as any).channel.send({ content: firstPayload.content });
                }
            }
        } else {
            logger.error('INTERACTION', 'unknown interaction caught', { context, message: msg });
            if ((interaction as any)?.channel?.send) {
                await (interaction as any).channel.send({ content: firstPayload.content });
            }
        }
    }
    for (let i = 1; i < chunks.length; i++) {
        try {
            const restPayload: any = { content: chunks[i] };
            if ('flags' in normalizedPayload) restPayload.flags = normalizedPayload.flags;
            await interaction.followUp(restPayload);
        } catch {
            if ((interaction as any)?.channel?.send) {
                await (interaction as any).channel.send({ content: chunks[i] });
            }
        }
    }
}

async function safeEditReplyPayload(interaction: any, payload: any, context: string): Promise<void> {
    try {
        await safeSendChunkedInteractionContent(interaction, payload, context);
        logger.info('INTERACTION', 'discord reply/edit success', {
            context,
            customId: interaction.customId,
            discordUserId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied
        });
        updateHealth(h => {
            h.interactions.lastInteractionAt = new Date().toISOString();
        });
    } catch (replyError: any) {
        logger.error('INTERACTION', 'discord reply/edit failure', {
            context,
            customId: interaction.customId,
            discordUserId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied,
            error: replyError?.message || String(replyError)
        });
        updateHealth(h => h.discord.lastError = `reply_failed:${context}:${replyError?.message || 'unknown'}`);
    }
}

async function safeReplyOrFollowUp(interaction: any, payload: any, context: string): Promise<void> {
    try {
        await safeSendChunkedInteractionContent(interaction, payload, context);
        logger.info('INTERACTION', `interaction completed: ${context}`, {
            customId: interaction.customId,
            discordUserId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied
        });
    } catch (e: any) {
        logger.error('INTERACTION', `fallback response failed: ${context}`, {
            customId: interaction.customId,
            discordUserId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied,
            error: e?.message || String(e)
        });
    }
}

async function safeUpdate(interaction: any, payload: any, context: string): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        logger.warn('INTERACTION', `update skipped: ${context}`, {
            customId: interaction.customId,
            discordUserId: interaction.user?.id,
            deferred: interaction.deferred,
            replied: interaction.replied
        });
        return;
    }
    logger.info('INTERACTION', 'interaction update started', {
        customId: interaction.customId,
        discordUserId: interaction.user?.id
    });
    await interaction.update(payload);
    logger.info('INTERACTION', `interaction completed: ${context}`, {
        customId: interaction.customId,
        discordUserId: interaction.user?.id,
        deferred: interaction.deferred,
        replied: interaction.replied
    });
}

let __dbSchemaChecked = false;
async function checkDbSchemaCompatibilityOnce(): Promise<void> {
    if (__dbSchemaChecked) return;
    __dbSchemaChecked = true;
    logger.info('DB', 'DB schema check started');
    try {
        // Table existence checks (small selects)
        await supabase.from('user_profile').select('discord_user_id').limit(1);
        await supabase.from('analysis_feedback_history').select('id').limit(1);
        // Column existence checks
        await supabase.from('chat_history').select('id,summary,key_risks,key_actions').limit(1);
        await supabase.from('accounts').select('id').limit(1);
        await supabase.from('trade_history').select('purchase_currency').limit(1);
        await supabase.from('portfolio_snapshot_history').select('id').limit(1);
        await supabase.from('portfolio').select('account_id,purchase_currency').limit(1);

        logger.info('DB', 'DB schema check passed');
    } catch (e: any) {
        logger.error('DB', 'DB schema check failed', {
            message: e?.message || String(e)
        });
        logger.warn('DB', 'DB missing column fallback triggered');
    }
}

function extractWeeklyReport(jypText: string): string | null {
    if (!jypText) return null;
    const text = jypText.replace(/\r\n/g, '\n');
    const startPattern = /(##\s*Weekly K-Culture Report|\[K-Culture Weekly Report\])/i;
    const startMatch = text.match(startPattern);
    if (!startMatch || startMatch.index === undefined) return null;

    const startIndex = startMatch.index;
    const remaining = text.slice(startIndex);
    const endMatch = remaining.match(/\n##\s|\n\[?[A-Za-z][A-Za-z\s_-]*Agent\]?|\n\[[A-Za-z][A-Za-z\s_-]*\]/);
    const section = endMatch ? remaining.slice(0, endMatch.index) : remaining;
    const cleaned = section.trim();

    return cleaned.length > 0 ? cleaned : null;
}

function getThisWeekFridayKST(now: Date = new Date()): Date {
    const weekdayText = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        weekday: 'short'
    }).format(now);
    const weekdayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
    };
    const kstWeekday = weekdayMap[weekdayText] ?? 0;

    const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now).split('-').map(Number);
    const [year, month, day] = ymd;

    const kstMidnightUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - (9 * 60 * 60 * 1000);
    const daysUntilFriday = (5 - kstWeekday + 7) % 7;
    return new Date(kstMidnightUtcMs + (daysUntilFriday * 24 * 60 * 60 * 1000));
}

function shouldGenerateWeeklyReport(now: Date, targetFridayKst: Date, lastReportDate: Date | null): boolean {
    if (now < targetFridayKst) return false;
    if (!lastReportDate) return true;
    return lastReportDate < targetFridayKst;
}

async function runWeeklyReportSchedulerCheck() {
    const now = new Date();
    const targetFriday = getThisWeekFridayKST(now);
    try {
        // Overall gating: last time any weekly_report was generated
        const { data, error } = await supabase
            .from('chat_history')
            .select('created_at')
            .eq('user_query', 'weekly_investment_report')
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            logger.error('SCHEDULER', 'weekly report last-date query failed', error);
            return;
        }

        const lastReportDate = data && data.length > 0 && data[0].created_at ? new Date(data[0].created_at) : null;
        logger.info('SCHEDULER', 'weekly report check', {
            now: now.toISOString(),
            targetFriday: targetFriday.toISOString(),
            lastReportDate: lastReportDate ? lastReportDate.toISOString() : null
        });

        if (!shouldGenerateWeeklyReport(now, targetFriday, lastReportDate)) {
            logger.warn('SCHEDULER', 'weekly report skipped');
            return;
        }

        // Weekly window (previous Friday -> this Friday)
        const weekStart = new Date(targetFriday.getTime() - 7 * 24 * 60 * 60 * 1000);
        const weekStartIso = weekStart.toISOString();

        const { data: activeRows, error: activeUsersError } = await supabase
            .from('chat_history')
            .select('user_id')
            .gte('created_at', weekStartIso)
            .neq('user_id', 'system')
            .limit(2000);

        if (activeUsersError) {
            logger.error('SCHEDULER', 'weekly report active user query failed', activeUsersError);
            return;
        }

        const uniqueUserIds = Array.from(
            new Set((activeRows || []).map(r => String(r.user_id)).filter(Boolean))
        ).slice(0, 10);

        logger.info('SCHEDULER', 'weekly report generating for users', { count: uniqueUserIds.length, weekStartIso });

        const jyp = new JYPAgent(); // reuse single agent for report generation (isTrendQuery=true bypasses anchored gate)

        for (const discordUserId of uniqueUserIds) {
            // Skip if already generated this week for that user
            const { data: existing, error: existingErr } = await supabase
                .from('chat_history')
                .select('id')
                .eq('user_id', discordUserId)
                .eq('user_query', 'weekly_investment_report')
                .gte('created_at', weekStartIso)
                .limit(1);
            if (existingErr) {
                logger.warn('SCHEDULER', 'weekly report per-user exists check failed', { discordUserId, message: existingErr?.message || String(existingErr) });
                continue;
            }
            if (existing && existing.length > 0) {
                continue;
            }

            const [recentChatsRes, recentFeedbackRes, profile] = await Promise.all([
                supabase
                    .from('chat_history')
                    .select('summary,key_risks,key_actions')
                    .eq('user_id', discordUserId)
                    .gte('created_at', weekStartIso)
                    .order('created_at', { ascending: false })
                    .limit(20),
                supabase
                    .from('analysis_feedback_history')
                    .select('persona_name,feedback_type,opinion_summary,opinion_text,analysis_type,topic_tags')
                    .eq('discord_user_id', discordUserId)
                    .gte('created_at', weekStartIso)
                    .order('created_at', { ascending: false })
                    .limit(50),
                loadUserProfile(discordUserId)
            ]);

            const recentChats = recentChatsRes.data || [];
            const recentFeedback = recentFeedbackRes.data || [];

            const chatSummaries = recentChats
                .map((c: any) => c.summary || '')
                .filter(Boolean)
                .slice(0, 10);

            const usedChatFields = chatSummaries.length > 0;
            const fallbackChatText = !usedChatFields
                ? recentChats
                    .map((c: any) => c.key_risks || c.key_actions || '')
                    .filter(Boolean)
                    .slice(0, 6)
                    .join('\\n---\\n')
                : '';

            if (!usedChatFields) {
                logger.info('REPORT', 'fallback summarization used', { discordUserId });
            }

            logger.info('REPORT', 'chat_history summary fields used', {
                discordUserId,
                usedChatFields,
                chatSummariesCount: chatSummaries.length
            });

            const topPreferredPersonas = profile.preferred_personas || [];
            const topAvoidedPersonas = profile.avoided_personas || [];
            const favoredStyles = profile.favored_analysis_styles || [];

            logger.info('REPORT', 'user preference signals applied', {
                discordUserId,
                topPreferredPersonas,
                topAvoidedPersonasCount: topAvoidedPersonas.length,
                favoredStyles: favoredStyles.slice(0, 5),
                profileHasRiskTolerance: !!profile.risk_tolerance,
                profileHasFavoredStyles: profile.favored_analysis_styles?.length > 0
            });

            const reportContext = {
                user_profile: {
                    risk_tolerance: profile.risk_tolerance,
                    investment_style: profile.investment_style,
                    preferred_personas: profile.preferred_personas,
                    avoided_personas: profile.avoided_personas,
                    favored_analysis_styles: profile.favored_analysis_styles
                },
                feedback_signals: {
                    topPreferredPersonas,
                    topAvoidedPersonas,
                    favoredStyles
                },
                recent_chat_summaries: usedChatFields ? chatSummaries : null,
                recent_chat_fallback_text: usedChatFields ? null : fallbackChatText
            };

            logger.info('REPORT', 'weekly summary generated', { discordUserId });

            const weeklyPrompt = `
You MUST output exactly in Korean.

Weekly Investment Report

[CONTEXT]
${JSON.stringify(reportContext, null, 2)}

Rules:
- 반드시 아래 섹션을 정확히 이 순서로 출력하라.
  1) Executive Summary
  2) Consensus View
  3) Diverging Opinions
  4) Key Risks
  5) Opportunities
  6) Recommended Actions
  7) User Preference Insight
- recent_chat_summaries / key_risks / key_actions에서 나온 내용을 우선 활용하고, 비어 있으면 fallback을 쓰되 그 사실을 한 줄로 명시하라.
- User Preference Insight에는 preferred_personas / favored_analysis_styles / avoided_personas가 반영되었음을 확인 가능한 문장으로 작성하라.
`;

            const reportText = await jyp.inspire(weeklyPrompt, true, '[Scheduler]');

            const payload: any = {
                user_id: discordUserId,
                user_query: 'weekly_investment_report',
                jyp_weekly_report: reportText,
                ray_advice: null,
                jyp_insight: null,
                simons_opportunity: null,
                drucker_decision: null,
                cio_decision: null,
                summary: null,
                key_risks: null,
                key_actions: null,
                created_at: new Date().toISOString()
            };

            const insertedId = await insertChatHistoryWithLegacyFallback(payload, true);
            if (!insertedId) {
                logger.warn('REPORT', 'weekly report insert skipped (schema fallback or failed)', { discordUserId });
            }
        }

        logger.info('SCHEDULER', 'weekly report generated');
    } catch (e: any) {
        logger.error('SCHEDULER', 'weekly report scheduler error', e);
    }
}

function startWeeklyReportScheduler() {
    if ((globalThis as any).__weeklySchedulerStarted) {
        return;
    }
    (globalThis as any).__weeklySchedulerStarted = true;
    logger.info('SCHEDULER', 'weekly report scheduler started');

    runWeeklyReportSchedulerCheck().catch(() => {
        // runWeeklyReportSchedulerCheck already logs errors internally.
    });

    setInterval(() => {
        runWeeklyReportSchedulerCheck().catch(() => {
            // runWeeklyReportSchedulerCheck already logs errors internally.
        });
    }, 60 * 60 * 1000);
}

function isTrendQueryCheck(query: string): boolean {
    return /(트렌드|유행|k-?pop|드라마|넷플릭스|스포츠|콘텐츠|아이돌|엔터|기회|시장)/i.test(query);
}

const DISCORD_CONTENT_MAX = 2000;
const DISCORD_BODY_CHUNK = 1800;

async function sendPostNavigationReply(sourceInteraction: Interaction | Message, highlight: QuickNavHighlight) {
    try {
        const rows = getQuickNavigationRows({ highlight });
        const src: any = sourceInteraction;
        if (typeof src.followUp === 'function') {
            await src.followUp({
                content: '**다음 메뉴** — 스크롤 없이 바로 선택할 수 있습니다.',
                components: rows,
                ephemeral: true
            });
            logger.info('UI', 'post_response_navigation_attached', { mode: 'followUp', highlight });
        } else if (src.channel?.send) {
            await src.channel.send({
                content: '**다음 메뉴** — 스크롤 없이 바로 선택할 수 있습니다.',
                components: rows
            });
            logger.info('UI', 'post_response_navigation_attached', { mode: 'channel_send', highlight });
        }
    } catch (e: any) {
        logger.warn('UI', 'post_response_navigation_failed', { message: e?.message });
    }
}

function decisionTopicHintForContext(analysisType: string): string {
    if (/PORTFOLIO|DEBATE|COMMITTEE|AI_|REBALANCE/i.test(analysisType)) return 'rebalance_strategy';
    if (/TREND/i.test(analysisType)) return 'trend';
    return 'general';
}

async function broadcastAgentResponse(
    userId: string,
    agentName: string,
    avatarURL: string,
    content: string,
    sourceInteraction: Interaction | Message,
    feedbackRow?: ActionRowBuilder<ButtonBuilder> | null,
    decisionCtx?: { chatHistoryId: number; analysisType: string; personaKey?: PersonaKey } | null
) {
    let finalContent = content;
    let components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (finalContent.includes('[REASON: NO_DATA]')) {
        finalContent = finalContent.replace(/\[REASON: NO_DATA\]/g, '').trim();
        components = [getNoDataButtons()];
    }

    const decisionRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (decisionCtx && isDecisionPrompt(finalContent)) {
        const opts = extractDecisionOptions(finalContent);
        logDecisionPromptDetected(decisionCtx.chatHistoryId, decisionCtx.analysisType, opts);
        const snap = await insertDecisionSnapshot({
            discordUserId: userId,
            chatHistoryRef: String(decisionCtx.chatHistoryId),
            analysisType: decisionCtx.analysisType,
            personaKey: decisionCtx.personaKey ?? null,
            options: opts
        });
        if (snap?.id) {
            decisionRows.push(buildDecisionButtonsRow(snap.id, opts));
        } else {
            logger.warn('DECISION', 'decision_snapshots insert failed; decision buttons omitted');
        }
    }

    const originalLen = finalContent.length;
    if (originalLen > 12000) {
        logger.info('DISCORD', 'response summarized for limit', { originalLength: originalLen, agentName });
        finalContent =
            finalContent.slice(0, 12000) + '\n\n_(응답이 길어 이후 생략)_';
    }

    const defaultAvatar = 'https://upload.wikimedia.org/wikipedia/commons/e/ef/System_Preferences_icon_Apple.png';

    const bodyChunks = splitDiscordMessage(finalContent, DISCORD_BODY_CHUNK);
    if (bodyChunks.length > 1) {
        logger.info('DISCORD', 'long response chunked', { parts: bodyChunks.length, agentName });
    }

    const sendParts = async (useWebhook: boolean) => {
        for (let i = 0; i < bodyChunks.length; i++) {
            const header =
                bodyChunks.length === 1
                    ? `## ${agentName}\n`
                    : `## ${agentName} (${i + 1}/${bodyChunks.length})\n`;
            let piece = header + bodyChunks[i];
            if (i === 0 && feedbackRow) {
                piece += '\n\n_이 분석이 유용했나요? 아래 버튼(👍 신뢰 / ✅ 채택 / 📌 저장 / 👎 별로)으로 바로 평가해 주세요._';
            }
            if (piece.length > DISCORD_CONTENT_MAX) {
                piece = piece.slice(0, DISCORD_CONTENT_MAX - 1) + '…';
            }
            const componentsToSend = i === 0
                ? [
                    ...(components.length ? components : []),
                    ...decisionRows,
                    ...(feedbackRow ? [feedbackRow] : [])
                  ]
                : undefined;

            const hasInteractiveComponents = !!(componentsToSend && componentsToSend.length);
            const useWebhookForThisPart = useWebhook && !hasInteractiveComponents;

            if (useWebhookForThisPart) {
                await webhook.send({
                    content: piece,
                    username: agentName,
                    avatarURL: avatarURL || defaultAvatar,
                    components: undefined
                });
            } else {
                const ch = (sourceInteraction as any).channel;
                if (!ch) {
                    throw new Error('broadcastAgentResponse: no channel on sourceInteraction');
                }
                await ch.send({
                    content: piece,
                    components: componentsToSend && componentsToSend.length ? componentsToSend : undefined
                });
            }
        }
    };

    try {
        await sendParts(true);
    } catch (e: any) {
        logger.error('DISCORD', `Webhook send error: ${e.message}`, e);
        if (sourceInteraction && (sourceInteraction as any).channel) {
            try {
                await sendParts(false);
            } catch (e2: any) {
                logger.error('DISCORD', `channel send error: ${e2.message}`, e2);
            }
        }
    }

    return finalContent;
}

async function getFinancialAnchorState(userId: string): Promise<{ hasPortfolio: boolean; hasLifestyle: boolean }> {
    try {
        const [portfolioRes, expensesRes, cashflowRes] = await Promise.all([
            supabase.from('portfolio').select('id').or(`discord_user_id.eq.${userId},user_id.eq.${userId}`).limit(1),
            supabase.from('expenses').select('id').or(`discord_user_id.eq.${userId},user_id.eq.${userId}`).limit(1),
            supabase.from('cashflow').select('id').or(`discord_user_id.eq.${userId},user_id.eq.${userId}`).limit(1)
        ]);
        const hasPortfolio = (portfolioRes.data?.length ?? 0) > 0;
        const hasLifestyle = (expensesRes.data?.length ?? 0) > 0 || (cashflowRes.data?.length ?? 0) > 0;
        return { hasPortfolio, hasLifestyle };
    } catch (e: any) {
        logger.error('GATE', 'financial anchor state check crashed', e);
        return { hasPortfolio: false, hasLifestyle: false };
    }
}

async function sendGateEmbed(sourceInteraction: any, description: string) {
    const embed = new EmbedBuilder().setTitle('[System]').setDescription(description).setColor('#e74c3c');
    if (sourceInteraction?.isButton?.() || sourceInteraction?.isModalSubmit?.()) {
        await sourceInteraction.followUp({ embeds: [embed] });
    } else {
        await sourceInteraction.reply({ embeds: [embed] });
    }
}

type UserMode = 'SAFE' | 'BALANCED' | 'AGGRESSIVE';

async function loadUserMode(discordUserId: string): Promise<UserMode> {
    const { data, error } = await supabase
        .from('user_settings')
        .select('mode')
        .eq('discord_user_id', discordUserId)
        .maybeSingle();
    if (error) {
        logger.error('SETTINGS', 'settings load failed', {
            discordUserId,
            message: error.message
        });
        return 'BALANCED';
    }
    const mode = String(data?.mode || 'BALANCED').toUpperCase();
    if (mode === 'SAFE' || mode === 'AGGRESSIVE' || mode === 'BALANCED') {
        logger.info('SETTINGS', 'settings loaded', { discordUserId, mode });
        return mode;
    }
    return 'BALANCED';
}

async function saveUserMode(discordUserId: string, mode: UserMode): Promise<void> {
    const payload = {
        discord_user_id: discordUserId,
        mode,
        updated_at: new Date().toISOString()
    };
    const { error } = await supabase
        .from('user_settings')
        .upsert(payload, { onConflict: 'discord_user_id' });
    if (error) {
        logger.error('SETTINGS', 'settings update failed', {
            discordUserId,
            mode,
            message: error.message
        });
        throw error;
    }
    logger.info('SETTINGS', 'settings updated', { discordUserId, mode });
}

/** 트렌드 패널 전용: application 계층 실행 후 Discord 전송만 index에서 처리 */
async function runTrendAnalysis(
    userId: string,
    userQuery: string,
    sourceInteraction: any,
    topic: TrendTopicKind,
    triggerCustomId?: string
) {
    try {
        const out = await runTrendAnalysisAppService({ userId, userQuery, topic, triggerCustomId });
        const feedbackRow = out.chatHistoryId ? getFeedbackButtonsRow(out.chatHistoryId, out.analysisType, 'TREND') : null;
        const decisionCtx =
            out.chatHistoryId != null
                ? {
                      chatHistoryId: out.chatHistoryId,
                      analysisType: out.analysisType,
                      personaKey: 'TREND' as PersonaKey
                  }
                : null;
        await broadcastAgentResponse(userId, out.agentLabel, out.avatarUrl, out.text, sourceInteraction, feedbackRow, decisionCtx);
        await sendPostNavigationReply(sourceInteraction, 'trend');
    } catch (err: any) {
        logger.error('ROUTER', '트렌드 분석 에러: ' + err.message, err);
    }
}

async function runDataCenterAction(
    userId: string,
    action: 'daily_log_analysis' | 'system_improvement_suggestion',
    sourceInteraction?: Interaction
) {
    const prompt = action === 'daily_log_analysis'
        ? [
            '오늘 하루 운영 로그를 분석해 주세요.',
            '- 에러/경고 패턴',
            '- 성능 저하 징후',
            '- 데이터 품질 이상 가능성',
            '- 재발 방지 포인트',
            '출력: 핵심 이슈 5개 + 원인 가설 + 즉시 조치'
          ].join('\n')
        : [
            '현재 AI 투자 오피스 시스템의 개선안을 제안해 주세요.',
            '- 안정성',
            '- 관측성',
            '- 데이터 정합성',
            '- Discord UX',
            '출력: 우선순위 높은 개선안 5개(기대효과/리스크/난이도 포함)'
          ].join('\n');

    const result = await runDataCenterAppService({
        discordUserId: userId,
        personaName: 'Peter Thiel (Data Center)',
        prompt,
        fallbackToGemini: async () => {
            const g = await generateGeminiResponse({ model: 'gemini-2.5-flash', prompt });
            return { text: g.text || '', provider: 'gemini', model: 'gemini-2.5-flash' };
        }
    });

    logger.info('LLM_PROVIDER', 'provider selected for Peter Thiel', {
        personaName: 'Peter Thiel (Data Center)',
        provider: result.provider,
        model: result.model,
        fallbackApplied: result.fallbackApplied,
        fallbackReason: result.fallbackReason
    });
    logger.info('INTERACTION', 'data center action invoked', {
        action,
        discordUserId: userId,
        provider: result.provider,
        model: result.model
    });

    const title = action === 'daily_log_analysis' ? '🗄 Peter Thiel · 하루치 로그 분석' : '🗄 Peter Thiel · 시스템 개선안 제안';
    const content = `## ${title}\n\n${normalizeProviderOutputForDiscord({
        text: result.text || '',
        provider: result.provider,
        personaKey: 'THIEL'
    })}`;
    await safeSendChunkedInteractionContent(sourceInteraction, { content }, `data_center:${action}`);
    if (sourceInteraction) await sendPostNavigationReply(sourceInteraction, 'data_center');
}

/** Phase 2.5 — shadow 리밸런싱 실행안(자동 주문 없음). trade_history는 「완료」버튼 후에만 반영. */
async function postShadowRebalanceFollowUp(userId: string, result: Awaited<ReturnType<typeof runPortfolioDebateAppService>>, sourceInteraction: Interaction) {
    if (result.status !== 'ok' || !result.chatHistoryId || !result.decisionArtifact) return;
    try {
        const mode = await loadUserMode(userId);
        const snap = await buildPortfolioSnapshot(userId, { scope: 'DEFAULT' });
        const plan = await buildRebalancePlanAppService({
            discordUserId: userId,
            snapshot: snap,
            decisionArtifact: result.decisionArtifact,
            userMode: mode,
            chatHistoryId: result.chatHistoryId,
            analysisType: result.analysisType,
            dryRun: false
        });
        if (!plan.planId || !plan.lines.length) return;
        const ch = (sourceInteraction as any).channel;
        if (!ch?.send) return;
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`rebalance:view:${plan.planId}`).setLabel('리밸런싱 계획 보기').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`rebalance:complete:${plan.planId}`).setLabel('리밸런싱 완료').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`rebalance:hold:${plan.planId}`).setLabel('이번엔 보류').setStyle(ButtonStyle.Danger)
        );
        const chunks = splitDiscordMessage(plan.discordText, 1800);
        await ch.send({
            content: chunks[0] || plan.discordText,
            components: [row]
        });
        for (let i = 1; i < chunks.length; i++) {
            await ch.send({ content: `_(계속 ${i + 1}/${chunks.length})_\n${chunks[i]}` });
        }
        logger.info('REBALANCE', 'shadow plan message posted', { planId: plan.planId, discordUserId: userId });
    } catch (e: any) {
        logger.warn('REBALANCE', 'follow-up post failed', { message: e?.message || String(e) });
    }
}

/** 금융/포트폴리오 5인 토론 — application 계층에서 LLM·저장 수행 */
async function runPortfolioDebate(userId: string, userQuery: string, sourceInteraction: any) {
    try {
        const result = await runPortfolioDebateAppService({
            userId,
            userQuery,
            triggerCustomId: sourceInteraction?.customId,
            loadUserMode,
            getFinancialAnchorState: () => getFinancialAnchorState(userId)
        });
        if (result.status === 'gate_lifestyle') {
            await sendGateEmbed(
                sourceInteraction,
                '소비·현금흐름 데이터가 없어 이 분석은 실행할 수 없습니다.\n지출 또는 현금흐름을 먼저 등록해 주세요.'
            );
            return;
        }
        if (result.status === 'gate_no_portfolio') {
            const embed = new EmbedBuilder()
                .setTitle('[System]')
                .setDescription('분석에 필요한 포트폴리오(보유 종목) 데이터가 없습니다.\n\n아래 버튼으로 먼저 종목을 등록해 주세요.')
                .setColor('#e74c3c');
            if (sourceInteraction.isButton?.() || sourceInteraction.isModalSubmit?.()) {
                await sourceInteraction.followUp({ embeds: [embed], components: [getNoDataButtons()] });
            } else {
                await sourceInteraction.reply({ embeds: [embed], components: [getNoDataButtons()] });
            }
            return;
        }
        if (result.status === 'aborted_silent') {
            return;
        }
        for (const seg of result.segments) {
            const feedbackRow = result.chatHistoryId
                ? getFeedbackButtonsRow(result.chatHistoryId, result.analysisType, seg.key)
                : null;
            const decisionCtx =
                result.chatHistoryId != null
                    ? {
                          chatHistoryId: result.chatHistoryId,
                          analysisType: result.analysisType,
                          personaKey: seg.key
                      }
                    : null;
            await broadcastAgentResponse(
                userId,
                seg.agentName,
                seg.avatarUrl,
                seg.text,
                sourceInteraction,
                feedbackRow,
                decisionCtx
            );
        }
        if (result.decisionArtifact) {
            let summary = formatDecisionSummaryForDiscord(result.decisionArtifact);
            if (result.feedbackCalibrationLine) {
                summary += `\n\n_${result.feedbackCalibrationLine}_`;
            }
            const decisionCtxSummary =
                result.chatHistoryId != null
                    ? {
                          chatHistoryId: result.chatHistoryId,
                          analysisType: result.analysisType,
                          personaKey: 'CIO' as PersonaKey
                      }
                    : null;
            await broadcastAgentResponse(
                userId,
                '투자위원회 · 결정 요약',
                'https://upload.wikimedia.org/wikipedia/commons/e/ef/System_Preferences_icon_Apple.png',
                summary,
                sourceInteraction,
                null,
                decisionCtxSummary
            );
        }
        await postShadowRebalanceFollowUp(userId, result, sourceInteraction);
        await sendPostNavigationReply(sourceInteraction, 'ai');
    } catch (err: any) {
        logger.error('ROUTER', '포트폴리오 토론 에러: ' + err.message, err);
    }
}

/** 자유 주제 토론 — application 계층에서 LLM·저장 수행 */
async function runOpenTopicDebate(userId: string, userQuery: string, sourceInteraction: any) {
    try {
        const out = await runOpenTopicDebateAppService({ userId, userQuery, loadUserMode });
        for (const b of out.broadcasts) {
            const feedbackRow = out.chatHistoryId ? getFeedbackButtonsRow(out.chatHistoryId, out.analysisType, b.personaKey) : null;
            const decisionCtx =
                out.chatHistoryId != null
                    ? {
                          chatHistoryId: out.chatHistoryId,
                          analysisType: out.analysisType,
                          personaKey: b.personaKey
                      }
                    : null;
            await broadcastAgentResponse(userId, b.agentName, b.avatarUrl, b.text, sourceInteraction, feedbackRow, decisionCtx);
        }
        await sendPostNavigationReply(sourceInteraction, 'ai');
    } catch (err: any) {
        logger.error('ROUTER', '오픈 토픽 토론 에러: ' + err.message, err);
    }
}

const financialCommandQueryMap: Record<string, string> = {
    'panel:portfolio:risk': '포트폴리오 리스크 집중 분석',
    'panel:finance:analyze_spending': '최근 소비 패턴 분석 및 미래지향성 평가',
    'panel:finance:stability': '재무 안정성 점검',
    'panel:ai:full': '종합 자산 및 소비 구조 진단',
    'panel:ai:risk': '포트폴리오 리스크 점검',
    'panel:ai:strategy': '실행 가능한 투자 전략 제안',
    'panel:ai:spending': '소비 개선 전략 및 평가'
};

const trendCommandQueryMap: Record<string, string> = {
    'panel:trend:kpop':
        'K-pop 산업·시장·콘텐츠·팬덤·플랫폼 관점에서 현재 핵심 트렌드와 이슈를 상세히 분석해 줘. (개인 포트폴리오·비중 언급 금지)',
    'panel:trend:drama':
        'OTT·드라마·영상 콘텐츠 산업 관점에서 플랫폼 경쟁, 소비 트렌드, 주요 이슈를 분석해 줘. (개인 포트폴리오·비중 언급 금지)',
    'panel:trend:sports':
        '스포츠 비즈니스(리그, 미디어, 스폰서, 팬, 글로벌 시장) 관점에서 구조와 트렌드를 분석해 줘. (개인 포트폴리오·비중 언급 금지)',
    'panel:trend:hot':
        '지금 사회·미디어·산업에서 두드러지는 핫 트렌드와 배경, 소비자 반응, 지속 가능성을 분석해 줘. (개인 포트폴리오·비중 언급 금지)'
};

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!')) {
        logger.info('COMMAND', `message command received: ${message.content}`, { user: message.author.tag });
    }

    if (message.content === '!메뉴' || message.content === '!패널재설치') {
        const state = loadPanelState();
        let msg: any = null;
        if (state?.channelId === message.channel.id && state.messageId) {
            const oldMsg = await (message.channel as any).messages.fetch(state.messageId).catch(() => null);
            if (oldMsg) {
                msg = await oldMsg.edit(getMainPanel()).catch(() => null);
            }
        }
        if (!msg) {
            msg = await message.reply(getMainPanel());
        }
        savePanelState(msg.channel.id, msg.id);
        logger.info('PANEL', 'Explicit reinstall via text command', {
            channelId: msg.channel.id,
            messageId: msg.id,
            mode: msg.id === state?.messageId ? 'edit_existing' : 'send_new'
        });
        updateHealth(s => s.panels.lastPanelAction = 'manual_reinstall');
        return;
    }

    if (message.content.startsWith('!종목추가')) {
        const parts = message.content.split(' ');
        if (parts.length < 4) return message.reply("❌ 사용법: `!종목추가 [심볼] [수량] [평단가] [종목명?] [섹터?]`");
        const [_, symbolInput, qtyStr, priceStr, name = symbolInput, sector = 'Unknown'] = parts;
        const resolved = resolveInstrumentMetadata(symbolInput, undefined);
        const normalizedSymbol = resolved?.symbol || normalizeSymbol(symbolInput);
        const market = resolved?.market || 'KR';
        const currency = resolved?.currency || 'KRW';
        const displayName = resolved?.displayName || name;
        const quoteSymbol = resolved?.quoteSymbol || normalizedSymbol;
        const exchange = resolved?.exchange || null;
        const qty = parseNumberStrict(qtyStr);
        const price = parseNumberStrict(priceStr);
        if (qty === null || price === null) return message.reply("❌ 수량과 평단가는 숫자로 입력해주세요.");

        await supabase.from('stocks').upsert({ symbol: normalizedSymbol, name: displayName, sector });
        try {
            await recordBuyTrade({
                discordUserId: getDiscordUserId(message.author),
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
            void learnBehaviorFromTrades(getDiscordUserId(message.author));
        } catch (e: any) {
            logger.error('DATABASE', 'trade buy record failure', e);
            return message.reply(`❌ 등록 실패: ${e?.message || String(e)}`);
        }
        return message.reply(`✅ **${displayName}(${quoteSymbol})** 종목 추가 완료! (거래 원장 반영)`);
    }

    if (message.content.startsWith('!계좌추가')) {
        const parts = message.content.trim().split(/\s+/);
        if (parts.length < 2) {
            return message.reply('❌ 사용법: `!계좌추가 [계좌이름] [TAXABLE|RETIREMENT|PENSION|ISA|OTHER]`');
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
            await createAccount({
                discordUserId: getDiscordUserId(message.author),
                accountName,
                accountType
            });
            logger.info('ACCOUNT', 'account applied to portfolio/trade', { accountName, accountType });
            return message.reply(
                `✅ 계좌 **${accountName}** (${accountType}) 생성 완료. **${GENERAL_ACCOUNT_NAME}**는 자동 생성되며 미지정 매수 시 해당 계좌에 반영됩니다.`
            );
        } catch (e: any) {
            return message.reply(`❌ 계좌 생성 실패: ${e?.message || String(e)}`);
        }
    }

    if (message.content.startsWith('!내계좌')) {
        const uid = getDiscordUserId(message.author);
        const { data, error } = await supabase
            .from('accounts')
            .select('account_name, account_type, id')
            .eq('discord_user_id', uid)
            .order('created_at', { ascending: true });
        if (error) return message.reply(`❌ 조회 실패: ${error.message}`);
        if (!data?.length) return message.reply('등록된 계좌가 없습니다. `!계좌추가` 로 추가하세요.');
        const lines = data.map(a => `- **${a.account_name}** (${a.account_type}) \`${a.id}\``);
        return message.reply(['**내 계좌 목록**', ...lines].join('\n'));
    }

    if (message.content.startsWith('!지출추가')) {
        const parts = message.content.split(' ');
        if (parts.length < 3) return message.reply("❌ 사용법: `!지출추가 [금액] [카테고리] [설명...]`");
        const [_, amountStr, category, ...descParts] = parts;
        const amount = parseNumberStrict(amountStr);
        if (amount === null) return message.reply("❌ 금액은 숫자로 입력해주세요.");

        const { error } = await supabase.from('expenses').insert({
            discord_user_id: getDiscordUserId(message.author), amount, category, description: descParts.join(' ')
        });
        if (error) {
            logger.error('DATABASE', 'Supabase insert failure', error);
            return message.reply(`❌ 등록 실패: ${error.message}`);
        }
        return message.reply(`✅ **${category}** 지출 기록 추가 완료!`);
    }

    if (message.content.startsWith('!현금흐름추가')) {
        const parts = message.content.split(' ');
        if (parts.length < 3) {
            return message.reply(
                '❌ 사용법: `!현금흐름추가 [유형] [금액] [설명...]` — 유형: SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, LOAN_INTEREST, CONSUMPTION, OTHER_IN, OTHER_OUT'
            );
        }
        const [_, typeRaw, amountStr, ...descParts] = parts;
        const flowType = parseCashflowFlowType(typeRaw);
        if (!flowType) {
            return message.reply(
                '❌ 잘못된 현금흐름 유형입니다. (SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, LOAN_INTEREST, CONSUMPTION, OTHER_IN, OTHER_OUT 중 택 1)'
            );
        }
        
        const amount = parseNumberStrict(amountStr);
        if (amount === null) return message.reply("❌ 금액은 숫자로 입력해주세요.");

        const { error } = await supabase.from('cashflow').insert({
            discord_user_id: getDiscordUserId(message.author), flow_type: flowType, amount, description: descParts.join(' '), flow_date: new Date().toISOString()
        });
        if (error) {
            logger.error('DATABASE', 'Supabase insert failure', error);
            return message.reply(`❌ 등록 실패: ${error.message}`);
        }
        return message.reply(`✅ **${flowType}** 현금흐름 추가 완료!`);
    }

    if (message.content.startsWith('!토론')) {
        const orch = decideOrchestratorRoute({ messagePrefix: message.content });
        logOrchestratorDecision(orch, { source: '!토론' });
        const userQuery = message.content.replace('!토론', '').trim() || '현재 내 상황을 점검해줘.';
        const isTrend = isTrendQueryCheck(userQuery);
        const isFinancial = detectFinancialIntent(userQuery);

        const statusText = isTrend
            ? '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)'
            : isFinancial
                ? '📊 **포트폴리오 기반 재무 분석 토론 중...**'
                : '📌 **자유 주제 분석 중…** (포트폴리오 스냅샷 미사용)';

        const loadingMsg = await message.reply(statusText);
        if (isTrend) {
            await runTrendAnalysis(message.author.id, userQuery, loadingMsg, 'free', undefined);
        } else if (isFinancial) {
            await runPortfolioDebate(message.author.id, userQuery, loadingMsg);
        } else {
            await runOpenTopicDebate(message.author.id, userQuery, loadingMsg);
        }
        await loadingMsg.delete().catch(() => {});
    }
});

async function handleDecisionButtonInteraction(interaction: any): Promise<void> {
    const cid = interaction.customId as string;
    const discordUserId = getDiscordUserId(interaction.user);
    const mUuid = /^decision:select\|([0-9a-f-]{36})\|(\d+)$/i.exec(cid);
    const mLegacy = /^decision:select\|(\d+)\|(\d+)$/.exec(cid);

    let chatHistoryId = 0;
    let optIndex = 0;
    let options: string[] = [];
    let analysisType = '';
    let personaKey: string | null = null;

    if (mUuid) {
        const snapshotId = mUuid[1];
        optIndex = Number(mUuid[2]);
        const snap = await getDecisionSnapshotById(snapshotId);
        if (!snap || snap.discord_user_id !== discordUserId) {
            logger.warn('DECISION', 'snapshot missing or user mismatch', { snapshotId });
            await safeDeferReply(interaction, {});
            await interaction.editReply({
                content: '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'
            });
            return;
        }
        options = snap.options;
        analysisType = snap.analysis_type ?? '';
        personaKey = snap.persona_key;
        const ref = snap.chat_history_ref;
        chatHistoryId = ref ? parseInt(ref, 10) : 0;
    } else if (mLegacy) {
        chatHistoryId = Number(mLegacy[1]);
        optIndex = Number(mLegacy[2]);
        const msg = String(interaction.message?.content || '');
        options = extractDecisionOptions(msg);
        analysisType = '';
        personaKey = null;
    } else {
        logger.warn('DECISION', 'invalid decision customId', { cid });
        await safeDeferReply(interaction, {});
        await interaction.editReply({
            content: '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'
        });
        return;
    }

    const selectedOption = options[optIndex] ?? options[0] ?? '선택';
    if (!Number.isFinite(chatHistoryId) || chatHistoryId <= 0 || !Number.isFinite(optIndex)) {
        await safeDeferReply(interaction, {});
        await interaction.editReply({
            content: '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'
        });
        return;
    }

    await safeDeferReply(interaction, {});

    logger.info('DECISION', 'DECISION_SELECTED', {
        chatHistoryId,
        userId: discordUserId,
        selectedOption,
        optionIndex: optIndex,
        options: options.slice(0, 4)
    });

    const decisionContext: Record<string, unknown> = {
        options,
        persona: personaKey,
        topic: decisionTopicHintForContext(analysisType || 'UNKNOWN')
    };
    if (mUuid) {
        decisionContext.snapshot_id = mUuid[1];
    }

    await insertDecisionHistoryRow({
        discordUserId,
        chatHistoryRef: String(chatHistoryId),
        analysisType: analysisType || null,
        selectedOption,
        optionIndex: optIndex,
        decisionContext
    });

    const userMode = await loadUserMode(discordUserId);
    let exec: { replyAck: string; followUpMarkdown: string; execution_type: string };
    try {
        exec = await executeDecisionAfterSelection({
            discordUserId,
            chatHistoryId,
            analysisType: analysisType || 'UNKNOWN',
            personaKey,
            selectedOption,
            optionIndex: optIndex,
            options,
            decisionContext,
            userMode
        });
    } catch (e: any) {
        logger.warn('DECISION', 'executeDecisionAfterSelection threw', { message: e?.message || String(e) });
        exec = {
            replyAck: `**선택 완료:** ${selectedOption}을(를) 반영합니다.`,
            followUpMarkdown:
                '후속 안내를 불러오는 중 문제가 있었습니다. 잠시 후 다시 시도해 주세요. _(자동 매매 없음)_',
            execution_type: 'error'
        };
    }

    await interaction.editReply({ content: exec.replyAck.slice(0, 1900) });

    const ch = interaction.channel as { send?: (p: { content: string }) => Promise<unknown> } | undefined;
    if (ch?.send && exec.followUpMarkdown) {
        const chunks = splitDiscordMessage(exec.followUpMarkdown, 1800);
        for (const part of chunks) {
            try {
                await ch.send({ content: part });
            } catch (e: any) {
                logger.warn('DECISION', 'decision followUp channel send failed', { message: e?.message || String(e) });
            }
        }
    }
}

async function handleFeedbackSaveButtonInteraction(interaction: any): Promise<void> {
    const cid = interaction.customId as string;
    const discordUserId = getDiscordUserId(interaction.user);
    await safeDeferReply(interaction, { flags: 64 });

    const prefix = 'feedback:save:';
    const rest = cid.slice(prefix.length);
    const m = /^(\d+):([^:]+):(TRUSTED|ADOPTED|BOOKMARKED|DISLIKED|REJECTED):([A-Z0-9_]+)$/.exec(rest);
    if (!m) {
        logger.warn('FEEDBACK', 'invalid feedback customId', { cid });
        await safeEditReply(interaction, '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'feedback:failure');
        return;
    }

    const chatHistoryId = Number(m[1]);
    const analysisType = m[2];
    const feedbackType = m[3] as FeedbackType;
    const personaKey = m[4];

    if (!Number.isFinite(chatHistoryId) || chatHistoryId <= 0) {
        await safeEditReply(interaction, '요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'feedback:failure');
        return;
    }

    logger.info('FEEDBACK', 'feedback button clicked', {
        chatHistoryId,
        analysisType,
        feedbackType,
        personaKey,
        discordUserId
    });

    const personaName = personaKeyToDisplayNameForFeedback(personaKey);
    /** analysisType은 customId 파싱값만 사용(chat_history.debate_type 조회 없음). */

    try {
        const chatRow = await findChatHistoryById(chatHistoryId);
        if (!chatRow) {
            await safeEditReply(interaction, '연결된 분석 기록을 찾을 수 없습니다.', 'feedback:not_found');
            return;
        }
        if (String((chatRow as any).user_id) !== String(discordUserId)) {
            await safeEditReply(interaction, '본인 분석에 대한 피드백만 저장할 수 있습니다.', 'feedback:forbidden');
            return;
        }

        const saveResult = await saveAnalysisFeedbackHistory({
            discordUserId,
            chatHistoryId,
            analysisType,
            personaName,
            opinionSummary: `button:${feedbackType}`,
            opinionText: `button:${feedbackType}`,
            feedbackType,
            feedbackNote: null,
            topicTags: []
        });

        if (saveResult.duplicate) {
            logger.warn('FEEDBACK', 'duplicate ignored', {
                scope: 'analysis_feedback_history',
                chatHistoryId,
                analysisType,
                feedbackType,
                personaKey,
                discordUserId
            });
            await safeEditReply(interaction, '이미 같은 피드백이 저장되어 있습니다.', 'feedback:duplicate');
            return;
        }

        logger.info('FEEDBACK', 'feedback history saved', {
            chatHistoryId,
            analysisType,
            feedbackType,
            personaName,
            discordUserId
        });

        const ingestResult = await ingestPersonaFeedback({
            discordUserId,
            chatHistoryId,
            analysisType,
            personaName,
            feedbackType,
            opinionText: `button:${feedbackType}`,
            feedbackNote: null
        });

        logger.info('FEEDBACK', 'feedback ingestion result', {
            chatHistoryId,
            analysisType,
            feedbackType,
            personaName,
            duplicate: ingestResult.duplicate,
            mappedCount: ingestResult.mappedCount,
            bestClaimId: ingestResult.bestClaimId,
            mappingMethod: ingestResult.mappingMethod,
            discordUserId
        });

        if (ingestResult.duplicate) {
            logger.warn('FEEDBACK', 'duplicate ignored', {
                scope: 'claim_feedback',
                chatHistoryId,
                analysisType,
                feedbackType,
                personaKey,
                discordUserId
            });
            await safeEditReply(interaction, '이미 반영된 피드백입니다.', 'feedback:claim_duplicate');
            return;
        }

        await safeEditReply(interaction, `피드백 저장 완료: ${feedbackType}`, 'feedback:success');
    } catch (e: any) {
        logger.error('FEEDBACK', 'handler failed', {
            message: e?.message || String(e),
            chatHistoryId,
            analysisType,
            feedbackType,
            personaKey,
            discordUserId
        });
        await safeEditReply(
            interaction,
            '일시적인 저장 오류입니다. 잠시 후 다시 시도해 주세요.',
            'feedback:failure'
        );
    }
}

const portfolioInteractionDeps = {
    getDiscordUserId,
    pendingBuyAccountId,
    pendingSellAccountId,
    getPortfolioMorePanel,
    safeDeferReply,
    safeEditReply,
    safeUpdate,
    safeReplyOrFollowUp,
    listUserAccounts,
    GENERAL_ACCOUNT_NAME,
    accountTypeLabelKo,
    findFirstRetirementAccount,
    runPortfolioQueryFromButton,
    runPortfolioQueryFromAccountSelect
};

const portfolioModalDeps = {
    ...portfolioInteractionDeps,
    supabase,
    resolveInstrumentMetadata,
    normalizeSymbol,
    parsePositiveAmount,
    recordBuyTrade,
    recordSellTrade,
    findPortfolioRowForSymbol,
    findPortfolioRowInAccount,
    learnBehaviorFromTrades
};

logger.info('BOOT', 'interactionCreate handler registered', {
    pid: process.pid,
    source: 'index.ts'
});

client.on('interactionCreate', async (interaction: Interaction) => {
    try {
        logger.info('INTERACTION', 'interactionCreate entered', {
            interactionId: (interaction as any).id,
            customId: 'customId' in (interaction as any) ? (interaction as any).customId : null,
            type: interaction.type,
            userId: (interaction as any).user?.id,
            deferred: (interaction as any).deferred,
            replied: (interaction as any).replied
        });

        if (interaction.isButton()) {
            const cid = interaction.customId;
            logger.info('INTERACTION', 'interaction received', {
                customId: cid,
                type: interaction.type,
                discordUserId: interaction.user?.id,
                deferred: interaction.deferred,
                replied: interaction.replied
            });
            logger.info('INTERACTION', `button customId=${cid}`, { user: interaction.user.tag });
            updateHealth(s => {
                s.interactions.lastInteractionAt = new Date().toISOString();
                s.interactions.lastInteractionType = 'button';
                s.interactions.lastCustomId = cid;
            });

            if (cid.startsWith('decision:select|')) {
                await handleDecisionButtonInteraction(interaction);
                return;
            }

            if (cid.startsWith('feedback:save:')) {
                await handleFeedbackSaveButtonInteraction(interaction);
                return;
            }

            if (cid.startsWith('instr:confirm:')) {
                await handleInstrumentConfirm(interaction, portfolioModalDeps);
                return;
            }
            if (cid.startsWith('instr:cancel:')) {
                await handleInstrumentCancel(interaction, portfolioModalDeps);
                return;
            }

            const routedEarly = await routeEarlyButtonInteraction({
                interaction,
                customId: cid,
                getDiscordUserId,
                safeDeferReply,
                safeEditReply,
                mainPanel: {
                    getTrendPanel,
                    getPortfolioPanel,
                    getFinancePanel,
                    getAIPanel,
                    getDataCenterPanel,
                    getSettingsPanel,
                    getMainPanel,
                    safeUpdate
                }
            });
            if (routedEarly) {
                return;
            }

            if (cid === 'panel:settings:reinstall') {
                const msg = await (interaction.channel as any)?.send(getMainPanel());
                if (msg) savePanelState(msg.channel.id, msg.id);
                logger.info('PANEL', 'Explicit reinstall via button', { channelId: msg?.channel.id, messageId: msg?.id });
                updateHealth(s => s.panels.lastPanelAction = 'button_reinstall');
                await interaction.message?.delete().catch(()=>{});
                return;
            }

            const trendTopicBtn = trendTopicFromCustomId(cid);
            if (trendTopicBtn != null && trendCommandQueryMap[cid]) {
                const query = trendCommandQueryMap[cid];
                const statusText = '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)';
                await safeDeferReply(interaction, { flags: 64 });
                await safeEditReplyPayload(interaction, { content: statusText }, `${cid}:status`);
                await runTrendAnalysis(interaction.user.id, query, interaction, trendTopicBtn, cid);
                return;
            }

            if (cid === 'panel:data:daily_logs' || cid === 'panel:data:improvement') {
                const action = cid === 'panel:data:daily_logs' ? 'daily_log_analysis' : 'system_improvement_suggestion';
                await safeDeferReply(interaction, { flags: 64 });
                await safeEditReply(interaction, '🗄 **데이터 센터 분석 실행 중...**', `${cid}:status`);
                await runDataCenterAction(interaction.user.id, action, interaction);
                return;
            }

            const rebMatch = /^rebalance:(view|complete|hold):([0-9a-f-]{36})$/i.exec(cid);
            if (rebMatch) {
                const act = rebMatch[1].toLowerCase();
                const planId = rebMatch[2];
                const uid = interaction.user.id;
                await safeDeferReply(interaction, { flags: 64 });
                if (act === 'view') {
                    const { plan, items, error } = await getRebalancePlanById(planId);
                    if (error || !plan || plan.discord_user_id !== uid) {
                        await safeEditReply(interaction, '플랜을 찾을 수 없거나 권한이 없습니다.', 'rebalance:view');
                        return;
                    }
                    const txt = renderPlanItemsText(items, plan.plan_header, plan.fx_usdkrw);
                    await safeEditReply(interaction, txt.slice(0, 1990), 'rebalance:view');
                    return;
                }
                if (act === 'complete') {
                    const r = await executeRebalancePlanComplete({ discordUserId: uid, planId });
                    await safeEditReply(interaction, r.message, 'rebalance:complete');
                    return;
                }
                if (act === 'hold') {
                    const r = await dismissRebalancePlanHold({ discordUserId: uid, planId });
                    await safeEditReply(interaction, r.message, 'rebalance:hold');
                    return;
                }
            }

            if (cid === 'panel:data:persona_report') {
                await safeDeferReply(interaction, { flags: 64 });
                const uid = interaction.user.id;
                const c7 = await buildPersonaScorecards({ discordUserId: uid, windowDays: 7 });
                const c30 = await buildPersonaScorecards({ discordUserId: uid, windowDays: 30 });
                const t =
                    formatPersonaScorecardDiscord(c7, '최근 7일') +
                    '\n\n' +
                    formatPersonaScorecardDiscord(c30, '최근 30일');
                const chunks = splitDiscordMessage(t, 1800);
                await safeEditReply(interaction, chunks[0] || t, 'panel:data:persona_report');
                return;
            }

            if (cid === 'panel:data:claim_audit') {
                await safeDeferReply(interaction, { flags: 64 });
                const r = await runClaimOutcomeAuditAppService({ discordUserId: interaction.user.id, limit: 60 });
                const msg =
                    `claim 감사 배치 완료 · 갱신 ${r.updated} · 스킵 ${r.skipped}` +
                    (r.errors.length ? ` · 오류 ${r.errors.slice(0, 2).join('; ')}` : '');
                await safeEditReply(interaction, msg, 'panel:data:claim_audit');
                return;
            }

            if (cid === 'panel:data:rebalance_view') {
                await safeDeferReply(interaction, { flags: 64 });
                const uid = interaction.user.id;
                const { plan, items, error } = await getLatestPendingRebalancePlan(uid);
                if (error) {
                    await safeEditReply(interaction, `조회 실패: ${error}`, 'panel:data:rebalance_view:err');
                    return;
                }
                if (!plan) {
                    await safeEditReply(interaction, '대기 중인 리밸런싱 계획이 없습니다.', 'panel:data:rebalance_view:empty');
                    return;
                }
                const txt = renderPlanItemsText(items, plan.plan_header, plan.fx_usdkrw);
                await safeEditReply(interaction, txt.slice(0, 1990), 'panel:data:rebalance_view');
                return;
            }

            if (financialCommandQueryMap[cid]) {
                const query = financialCommandQueryMap[cid];
                const statusText = '📊 **포트폴리오·소비·현금흐름 기준 재무 분석 중...**';
                await safeDeferReply(interaction, { flags: 64 });
                await safeEditReplyPayload(interaction, { content: statusText }, `${cid}:status`);
                await runPortfolioDebate(interaction.user.id, query, interaction);
                return;
            }

            if (await tryHandlePortfolioButton(interaction, portfolioInteractionDeps)) {
                return;
            }

            if (cid === 'panel:finance:add_expense') {
                const modal = new ModalBuilder().setCustomId('modal:expense:add').setTitle('💸 지출 기록');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('amount').setLabel("금액").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('category').setLabel("카테고리").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('desc').setLabel("상세 설명").setStyle(TextInputStyle.Paragraph).setRequired(false)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('installment')
                            .setLabel('할부 (N 또는 Y 개월 시작일, 예: Y 3 2026-01-01)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    )
                );
                await interaction.showModal(modal);
                return;
            }

            if (cid === 'panel:finance:add_cashflow') {
                logger.info('INTERACTION', 'button click: panel:finance:add_cashflow', { user: interaction.user.tag });
                const modal = new ModalBuilder().setCustomId('modal:cashflow:add').setTitle('💰 현금흐름 입력');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('flow_type')
                            .setLabel('유형 (SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, …)')
                            .setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('amount').setLabel("금액").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('desc').setLabel("상세 설명").setStyle(TextInputStyle.Paragraph).setRequired(false))
                );
                logger.info('INTERACTION', 'modal open: modal:cashflow:add', { user: interaction.user.tag });
                await interaction.showModal(modal);
                return;
            }

            if (cid === 'panel:ai:ask' || cid === 'panel:trend:free') {
                const modal = new ModalBuilder().setCustomId(cid === 'panel:ai:ask' ? 'modal:ai:ask' : 'modal:trend:free').setTitle(cid === 'panel:ai:ask' ? '✍️ 직접 질문' : '🔍 자유 탐색');
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('query').setLabel("궁금한 내용을 입력하세요").setStyle(TextInputStyle.Paragraph)
                ));
                await interaction.showModal(modal);
                return;
            }

            if (cid === 'panel:settings:view') {
                const discordUserId = getDiscordUserId(interaction.user);
                const mode = await loadUserMode(discordUserId);
                await safeReplyOrFollowUp(interaction, { content: `현재 설정 모드: **${mode}**`, ephemeral: true }, 'panel:settings:view');
                return;
            }

            if (cid.startsWith('panel:settings:')) {
                const modeMap: Record<string, UserMode> = {
                    'panel:settings:safe': 'SAFE',
                    'panel:settings:balanced': 'BALANCED',
                    'panel:settings:aggressive': 'AGGRESSIVE'
                };
                const targetMode = modeMap[cid];
                if (!targetMode) return;
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    await saveUserMode(discordUserId, targetMode);
                    await safeReplyOrFollowUp(interaction, { content: `✅ 성향 설정 저장 완료: **${targetMode}**`, ephemeral: true }, 'panel:settings:update');
                } catch (e: any) {
                    await safeReplyOrFollowUp(interaction, { content: `❌ 설정 저장 실패: ${e?.message || 'unknown'}`, ephemeral: true }, 'panel:settings:update:failure');
                }
                return;
            }
        }

        if (interaction.isStringSelectMenu()) {
            const sid = interaction.customId;
            updateHealth(s => {
                s.interactions.lastInteractionAt = new Date().toISOString();
                s.interactions.lastInteractionType = 'string_select';
                s.interactions.lastCustomId = sid;
            });

            if (sid.startsWith('instr:pick:')) {
                if (await handleInstrumentPick(interaction, portfolioModalDeps)) return;
            }

            if (await tryHandlePortfolioStringSelect(interaction, portfolioInteractionDeps)) {
                return;
            }
        }

        if (interaction.type === InteractionType.ModalSubmit) {
            const cid = interaction.customId;
            logger.info('INTERACTION', 'interaction received', {
                customId: cid,
                type: interaction.type,
                discordUserId: interaction.user?.id,
                deferred: interaction.deferred,
                replied: interaction.replied
            });
            logger.info('INTERACTION', `modal customId=${cid}`, { user: interaction.user.tag });
            updateHealth(s => {
                s.interactions.lastInteractionAt = new Date().toISOString();
                s.interactions.lastInteractionType = 'modal';
                s.interactions.lastCustomId = cid;
            });

            if (cid === 'modal:trend:free') {
                const query = interaction.fields.getTextInputValue('query');
                const statusText = '📌 **트렌드·주제 분석 중…** (포트폴리오 스냅샷 미사용)';
                await safeDeferReply(interaction, { flags: 64 });
                await safeEditReplyPayload(interaction, { content: statusText }, `${cid}:status`);
                await runTrendAnalysis(interaction.user.id, query, interaction, 'free', cid);
                return;
            }

            if (cid === 'modal:ai:ask') {
                const orch = decideOrchestratorRoute({ modalId: cid });
                logOrchestratorDecision(orch, { source: 'modal:ai:ask' });
                const query = interaction.fields.getTextInputValue('query');
                const isFinancial = detectFinancialIntent(query);
                const statusText = isFinancial
                    ? '📊 **포트폴리오 기반 재무 분석 중...**'
                    : '📌 **자유 주제 분석 중…** (포트폴리오 스냅샷 미사용)';
                await safeDeferReply(interaction, { flags: 64 });
                await safeEditReplyPayload(interaction, { content: statusText }, `${cid}:status`);
                if (isFinancial) {
                    await runPortfolioDebate(interaction.user.id, query, interaction);
                } else {
                    await runOpenTopicDebate(interaction.user.id, query, interaction);
                }
                return;
            }

            if (await tryHandlePortfolioModalSubmit(interaction, portfolioModalDeps)) {
                return;
            }

            if (cid === 'modal:expense:add') {
                await safeDeferReply(interaction, { flags: 64 });
                const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
                const category = interaction.fields.getTextInputValue('category');
                const desc = sanitizeDescription(interaction.fields.getTextInputValue('desc'));
                const installmentRaw = (interaction.fields.getTextInputValue('installment') || '').trim();
                if (!amount) {
                    await safeEditReply(interaction, "입력값을 확인해주세요. 금액이 올바르지 않습니다.", 'modal:expense:add:validation_failure');
                    return;
                }

                const inst = parseInstallmentLine(installmentRaw, amount);
                const expensePayload: Record<string, unknown> = {
                    discord_user_id: getDiscordUserId(interaction.user),
                    amount,
                    category,
                    description: desc,
                    is_installment: inst.is_installment,
                    installment_months: inst.installment_months,
                    monthly_recognized_amount: inst.monthly_recognized_amount,
                    installment_start_date: inst.installment_start_date
                };

                const { error } = await supabase.from('expenses').insert(expensePayload);
                if (error) { 
                    logger.error('DATABASE', 'Supabase insert failure', error); 
                    await safeEditReply(interaction, "지출 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", 'modal:expense:add:db_failure');
                    return; 
                }
                await safeEditReply(interaction, `✅ **${category}** 지출 기록 완료!`, 'modal:expense:add:success');
                return;
            }

            if (cid === 'modal:cashflow:add') {
                logger.info('INTERACTION', 'modal submit received: modal:cashflow:add', { user: interaction.user.tag });
                await safeDeferReply(interaction, { flags: 64 });
                try {
                    const flowTypeRaw = interaction.fields.getTextInputValue('flow_type');
                    const flowType = parseCashflowFlowType(flowTypeRaw);
                    const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
                    const description = sanitizeDescription(interaction.fields.getTextInputValue('desc'));

                    if (!flowType || !amount) {
                        logger.warn('INTERACTION', 'validation failure: modal:cashflow:add', {
                            flowTypeRaw,
                            amountRaw: interaction.fields.getTextInputValue('amount')
                        });
                        await safeEditReply(
                            interaction,
                            '입력값을 확인해주세요. 금액과 유형이 올바르지 않습니다. 유형: SALARY, BONUS, LOAN_IN, LOAN_PRINCIPAL, LOAN_INTEREST, CONSUMPTION, OTHER_IN, OTHER_OUT (레거시 영문 별칭도 허용)',
                            'modal:cashflow:add:validation_failure'
                        );
                        return;
                    }

                    logger.info('INTERACTION', 'validation success: modal:cashflow:add', { flowType, amount });
                    const payload = {
                        discord_user_id: getDiscordUserId(interaction.user),
                        flow_type: flowType,
                        amount,
                        description,
                        flow_date: new Date().toISOString()
                    };

                    logger.info('DB', '[cashflow][insert] attempt', { table: 'cashflow', payloadKeys: Object.keys(payload) });
                    const { error } = await supabase.from('cashflow').insert(payload);
                    if (error) {
                        logSchemaSafeInsertFailure('cashflow', payload, error);
                        await safeEditReply(interaction, "현금흐름 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", 'modal:cashflow:add:db_failure');
                        return;
                    }

                    logger.info('DB', '[cashflow][insert] success', { userId: interaction.user.id, flowType, amount });
                    await safeEditReply(interaction, "현금흐름이 정상적으로 저장되었습니다.", 'modal:cashflow:add:success');
                } catch (modalError: any) {
                    logger.error('INTERACTION', 'modal:cashflow:add exception', modalError);
                    await safeEditReply(interaction, "현금흐름 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", 'modal:cashflow:add:exception');
                }
                return;
            }
        }
    } catch (error) {
        const anyInteraction: any = interaction as any;
        if (anyInteraction.__localErrorHandled) {
            return;
        }
        logger.error('INTERACTION', 'global catch entered', {
            interactionId: anyInteraction.id,
            customId: 'customId' in anyInteraction ? anyInteraction.customId : null,
            deferred: anyInteraction.deferred,
            replied: anyInteraction.replied,
            error: error instanceof Error ? error.message : String(error)
        });
        // Minimize extra ack attempts in global catch
        if (anyInteraction.deferred || anyInteraction.replied) {
            await safeReplyOrFollowUp(anyInteraction, { content: '처리 중 오류가 발생했습니다.', ephemeral: true }, 'interaction:global_catch');
        }
    }
});

// Use clientReady hook to prevent warning & ensure safe boot
client.once(Events.ClientReady, async (c) => {
    logger.info('BOOT', 'ready handler entered', {
        once: true,
        pid: process.pid
    });
    if ((globalThis as any).__aiOfficeReadyHandled) {
        logger.warn('BOOT', 'ready handler already executed, skipping duplicate');
        return;
    }
    (globalThis as any).__aiOfficeReadyHandled = true;
    logger.info('DISCORD', `ready bot=${c.user.tag} guilds=${c.guilds.cache.size}`);
    updateHealth(s => {
        s.discord.ready = true;
        s.discord.botTag = c.user.tag;
        s.discord.guildCount = c.guilds.cache.size;
    });

    // DB schema compatibility check (tables/columns existence)
    await checkDbSchemaCompatibilityOnce();

    // Startup restore + announcement
    await ensureMainPanelOnBoot(client);
    
    logger.info('BOOT', `[🟢 PM2 Status] KJM Office Bot is Online: ${c.user.tag}`);
});

updateHealth(s => s.discord.loginAttempted = true);
startWeeklyReportScheduler();
logger.info('DISCORD', 'login attempt');
client.login(DISCORD_TOKEN).catch(e => {
    logger.error('DISCORD', 'login failure', e);
    updateHealth(s => s.discord.lastError = e.message);
});
