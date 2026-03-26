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
    InteractionType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} from 'discord.js';
import { logger, updateHealth, startHeartbeat } from './logger';
import { RayDalioAgent, JYPAgent, JamesSimonsAgent, PeterDruckerAgent, StanleyDruckenmillerAgent, HindenburgAgent } from './agents';
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
    getSettingsPanel,
    getNoDataButtons
} from './panelManager';
import { buildPortfolioSnapshot } from './portfolioService';
import { resolveInstrumentMetadata } from './instrumentRegistry';
import {
    generateTrendSpecialistResponse,
    trendTopicFromCustomId,
    TREND_TOPIC_CONFIG,
    type TrendTopicKind
} from './trendAnalysis';
import { learnBehaviorFromSnapshots, learnBehaviorFromTrades, loadUserProfile } from './profileService';
import { saveAnalysisFeedbackHistory, type FeedbackType } from './feedbackService';
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
import { loadPersonaMemory } from './personaMemoryService';
import { buildPersonaPromptContext, buildBaseAnalysisContext } from './analysisContextService';
import { runAnalysisPipeline } from './analysisPipelineService';
import { ingestPersonaFeedback } from './feedbackIngestionService';
import { generateWithPersonaProvider } from './llmProviderService';
import type { ProviderGenerationResult } from './analysisTypes';
import { splitDiscordMessage, chooseInteractionRoute } from './discordResponseUtils';

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

type PersonaKey = 'RAY' | 'HINDENBURG' | 'SIMONS' | 'DRUCKER' | 'CIO' | 'JYP' | 'TREND' | 'OPEN_TOPIC';

function detectFinancialIntent(query: string): boolean {
    // 금융/포트폴리오 맥락을 명시적으로 요구한 경우만 포트폴리오 토론으로 라우팅.
    return /(포트폴리오|비중|리스크|손익|평단|리밸런싱|투자 전략|종합 진단|현금버퍼|월 투자여력|자산배분)/i.test(query);
}

function guessAnalysisTypeFromTrigger(triggerCustomId: string | undefined, userQuery: string): string {
    const t = triggerCustomId || '';
    if (t.includes('panel:portfolio:risk') || /(리스크|변동성|위험)/i.test(userQuery)) return 'portfolio_risk';
    if (t.includes('panel:ai:strategy')) return 'portfolio_strategy';
    if (t.includes('panel:ai:full')) return 'portfolio_full_diagnosis';
    if (t.includes('panel:trend:')) return `trend_${t.split(':').pop() || 'unknown'}`;
    if (t.includes('open_topic')) return 'open_topic';
    // default
    return detectFinancialIntent(userQuery) ? 'portfolio_financial' : 'open_topic';
}

function toOpinionSummary(text: string, maxLen = 220): string {
    const t = (text || '').trim();
    if (!t) return '';
    return t.length <= maxLen ? t : t.slice(0, maxLen) + '…';
}

function asGeminiResult(text: string): ProviderGenerationResult {
    return {
        text,
        provider: 'gemini',
        model: 'gemini-2.5-flash'
    };
}

function normalizeProviderOutputForDiscord(params: { text: string; provider: string; personaKey: PersonaKey }): string {
    const provider = params.provider;
    const personaKey = params.personaKey;
    let t = String(params.text || '').replace(/\r\n/g, '\n').trim();
    if (!t) {
        logger.warn('UX', 'empty provider response handled', { provider, personaKey });
        t = '응답 생성이 불안정하여 핵심 요약으로 대체합니다. 잠시 후 다시 시도해 주세요.';
    }
    if (t.length < 40) {
        logger.warn('UX', 'too short provider response handled', { provider, personaKey, length: t.length });
        t = `${t}\n\n- 위 응답이 너무 짧아 핵심 요약이 제한될 수 있습니다.`;
    }
    if (t.length > 2600 && !t.startsWith('##')) {
        t = `## 핵심 요약\n${t.slice(0, 500)}\n\n## 상세 내용\n${t}`;
    }
    logger.info('UX', 'provider output normalized', {
        provider,
        personaKey,
        originalLength: String(params.text || '').length,
        normalizedLength: t.length
    });
    return t;
}

function getFeedbackButtonsRow(chatHistoryId: number, analysisType: string, personaKey: PersonaKey): ActionRowBuilder<ButtonBuilder> {
    const mk = (feedbackType: FeedbackType, label: string, style: ButtonStyle) =>
        new ButtonBuilder()
            .setCustomId(`feedback:save:${chatHistoryId}:${feedbackType}:${personaKey}`)
            .setLabel(label)
            .setStyle(style);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        mk('TRUSTED', '좋았어요(Trust)', ButtonStyle.Primary),
        mk('ADOPTED', '채택(Adopt)', ButtonStyle.Success),
        mk('BOOKMARKED', '저장(Bookmark)', ButtonStyle.Secondary),
        mk('DISLIKED', '별로예요(Dislike)', ButtonStyle.Danger)
    );
}

async function getRecentClaimIdForFeedback(params: {
    discordUserId: string;
    chatHistoryId: number;
    analysisType: string;
    personaName: string;
}): Promise<string | null> {
    try {
        const { data, error } = await supabase
            .from('analysis_claims')
            .select('id,created_at,claim_order')
            .eq('discord_user_id', params.discordUserId)
            .eq('chat_history_id', params.chatHistoryId)
            .eq('analysis_type', params.analysisType)
            .eq('persona_name', params.personaName)
            .order('created_at', { ascending: false })
            .order('claim_order', { ascending: true })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return data?.id ? String(data.id) : null;
    } catch (e: any) {
        logger.warn('FEEDBACK', 'recent claim lookup failed', {
            discordUserId: params.discordUserId,
            chatHistoryId: params.chatHistoryId,
            analysisType: params.analysisType,
            personaName: params.personaName,
            message: e?.message || String(e)
        });
        return null;
    }
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

function personaKeyToPersonaName(personaKey: PersonaKey): string {
    switch (personaKey) {
        case 'RAY': return 'Ray Dalio (PB)';
        case 'HINDENBURG': return 'HINDENBURG_ANALYST';
        case 'JYP': return 'JYP (Analyst)';
        case 'SIMONS': return 'James Simons (Quant)';
        case 'DRUCKER': return 'Peter Drucker (COO)';
        case 'CIO': return 'Stanley Druckenmiller (CIO)';
        case 'TREND': return 'Trend Analyst';
        case 'OPEN_TOPIC': return 'Open Topic Analyst';
        default: return 'Unknown';
    }
}

async function safeInsertChatHistoryAndGetId(payload: any, retryWithoutExtendedColumns = true): Promise<number | null> {
    try {
        const { data, error } = await supabase
            .from('chat_history')
            .insert(payload)
            .select('id')
            .maybeSingle();
        if (error) throw error;
        const idRaw = data?.id;
        const idNum = typeof idRaw === 'number' ? idRaw : Number(idRaw);
        return Number.isFinite(idNum) ? idNum : null;
    } catch (e: any) {
        if (!retryWithoutExtendedColumns) throw e;

        logger.warn('DB', 'chat_history insert fallback triggered', {
            message: e?.message || String(e),
            retryWithoutExtendedColumns
        });

        // Fallback: remove extended columns to match legacy schema.
        const retryPayload: any = { ...payload };
        delete retryPayload.debate_type;
        delete retryPayload.summary;
        delete retryPayload.key_risks;
        delete retryPayload.key_actions;

        // Ensure required legacy columns exist.
        const basePayload: any = {
            user_id: retryPayload.user_id,
            user_query: retryPayload.user_query,
            ray_advice: retryPayload.ray_advice,
            jyp_insight: retryPayload.jyp_insight,
            simons_opportunity: retryPayload.simons_opportunity,
            drucker_decision: retryPayload.drucker_decision,
            cio_decision: retryPayload.cio_decision,
            jyp_weekly_report: retryPayload.jyp_weekly_report
        };

        const { data: retryData, error: retryError } = await supabase
            .from('chat_history')
            .insert(basePayload)
            .select('id')
            .maybeSingle();

        if (retryError) {
            logger.error('DB', 'chat_history insert fallback failed', { message: retryError?.message || String(retryError) });
            return null;
        }
        const idRaw = retryData?.id;
        const idNum = typeof idRaw === 'number' ? idRaw : Number(idRaw);
        return Number.isFinite(idNum) ? idNum : null;
    }
}

function getDiscordUserId(user: { id: string }): string {
    return user.id;
}

/** 고급 매수/매도: 모달 직전에 선택한 계좌 (단일 프로세스 가정) */
const pendingBuyAccountId = new Map<string, string>();
const pendingSellAccountId = new Map<string, string>();

function normalizeFlowType(value: string): string | null {
    const valid = ['income', 'fixed_expense', 'saving', 'investment', 'debt_payment', 'other'];
    const normalized = (value || '').trim().toLowerCase();
    if (valid.includes(normalized)) return normalized;
    return null;
}


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

    await safeEditReply(interaction, text, 'portfolio:query:success');
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
        await supabase.from('chat_history').select('debate_type,summary,key_risks,key_actions').limit(1);
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
                    .select('summary,key_risks,key_actions,debate_type')
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
                debate_type: 'weekly_investment_report',
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

            const insertedId = await safeInsertChatHistoryAndGetId(payload, true);
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

async function broadcastAgentResponse(
    userId: string,
    agentName: string,
    avatarURL: string,
    content: string,
    sourceInteraction: Interaction | Message,
    feedbackRow?: ActionRowBuilder<ButtonBuilder> | null
) {
    let finalContent = content;
    let components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (finalContent.includes('[REASON: NO_DATA]')) {
        finalContent = finalContent.replace(/\[REASON: NO_DATA\]/g, '').trim();
        components = [getNoDataButtons()];
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
            if (piece.length > DISCORD_CONTENT_MAX) {
                piece = piece.slice(0, DISCORD_CONTENT_MAX - 1) + '…';
            }
            const componentsToSend = i === 0
                ? [
                    ...(components.length ? components : []),
                    ...(feedbackRow ? [feedbackRow] : [])
                  ]
                : undefined;

            if (useWebhook) {
                await webhook.send({
                    content: piece,
                    username: agentName,
                    avatarURL: avatarURL || defaultAvatar,
                    components: componentsToSend && componentsToSend.length ? componentsToSend : undefined
                });
            } else {
                await (sourceInteraction as any).channel.send({
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

function requiresLifestyleAnchorsForTrigger(customId?: string): boolean {
    if (!customId) return false;
    return customId === 'panel:finance:analyze_spending' || customId === 'panel:ai:spending';
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

/** 트렌드 패널 전용: 스냅샷·5인 토론 없음, 단일 페르소나 */
async function runTrendAnalysis(
    userId: string,
    userQuery: string,
    sourceInteraction: any,
    topic: TrendTopicKind,
    triggerCustomId?: string
) {
    try {
        logger.info('TREND', 'trend analysis route selected', { topic, customId: triggerCustomId ?? null });
        logger.info('TREND', 'portfolio snapshot skipped', { reason: 'trend_pipeline' });
        const cfg = TREND_TOPIC_CONFIG[topic];
        logger.info('TREND', 'trend persona selected', { personaKey: cfg.personaKey, agentLabel: cfg.agentLabel });

        updateHealth(s => s.ai.lastRoute = 'trend_isolated');

        logger.info('AI', 'Gemini call started');
        const textRaw = await generateTrendSpecialistResponse(topic, userQuery);
        const text = normalizeProviderOutputForDiscord({ text: textRaw, provider: 'gemini', personaKey: 'TREND' });
        logger.info('AI', 'Gemini call completed');

        const analysisType = `trend_${topic}`;
        const profile = await loadUserProfile(userId);
        const baseContext = buildBaseAnalysisContext({
            discordUserId: userId,
            analysisType,
            userQuery,
            mode: undefined,
            userProfile: profile,
            snapshotSummary: null,
            snapshotPositionsCount: undefined
        });
        const chatHistoryPayload: any = {
            user_id: userId,
            user_query: userQuery,
            debate_type: analysisType,
            ray_advice: text,
            jyp_insight: null as string | null,
            simons_opportunity: null as string | null,
            drucker_decision: null as string | null,
            cio_decision: null as string | null,
            jyp_weekly_report: null as string | null,
            summary: toOpinionSummary(text, 900),
            key_risks: null,
            key_actions: null
        };

        const chatHistoryId = await safeInsertChatHistoryAndGetId(chatHistoryPayload, true);
        if (chatHistoryId) {
            await runAnalysisPipeline({
                discordUserId: userId,
                chatHistoryId,
                analysisType,
                personaOutputs: [
                    {
                        personaKey: 'TREND',
                        personaName: personaKeyToPersonaName('TREND'),
                        responseText: text,
                        providerName: 'gemini',
                        modelName: 'gemini-2.5-flash'
                    }
                ],
                baseContext
            });
        }
        const feedbackRow = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, 'TREND') : null;

        await broadcastAgentResponse(userId, cfg.agentLabel, cfg.avatarUrl, text, sourceInteraction, feedbackRow);

        if (chatHistoryId) logger.info('DB', 'chat_history insert success (trend)', { chatHistoryId });
    } catch (err: any) {
        logger.error('ROUTER', '트렌드 분석 에러: ' + err.message, err);
    }
}

/** 금융/포트폴리오 5인 토론 — 스냅샷 주입 */
async function runPortfolioDebate(userId: string, userQuery: string, sourceInteraction: any) {
    try {
        logger.info('AI', 'portfolio debate route selected', { discordUserId: userId });
        const mode = await loadUserMode(userId);
        const snapshot = await buildPortfolioSnapshot(userId, { scope: 'ALL' });
        const anchorState = await getFinancialAnchorState(userId);
        const triggerId: string | undefined = sourceInteraction?.customId;
        const hasPortfolio = anchorState.hasPortfolio || snapshot.summary.position_count > 0;

        updateHealth(s => s.ai.lastRoute = 'financial_debate');

        if (requiresLifestyleAnchorsForTrigger(triggerId) && !anchorState.hasLifestyle) {
            logger.info('GATE', 'lifestyle_data_required_blocked', { triggerId });
            await sendGateEmbed(
                sourceInteraction,
                '소비·현금흐름 데이터가 없어 이 분석은 실행할 수 없습니다.\n지출 또는 현금흐름을 먼저 등록해 주세요.'
            );
            return;
        }

        if (!hasPortfolio) {
            logger.info('GATE', 'NO_DATA triggered');
            logger.info('AI', 'Gemini skipped due to NO_DATA');
            updateHealth(s => s.ai.lastNoDataTriggered = true);

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

        if (hasPortfolio && !anchorState.hasLifestyle) {
            logger.info('GATE', 'partial_analysis_mode', {
                discordUserId: userId,
                reason: 'missing_expenses_or_cashflow'
            });
            logger.info('GATE', 'portfolio_only_mode', {
                discordUserId: userId,
                positionCount: snapshot.summary.position_count
            });
            logger.info('AI', 'debate proceeding with portfolio snapshot only', {
                discordUserId: userId,
                positionCount: snapshot.summary.position_count
            });
        }

        updateHealth(s => s.ai.lastNoDataTriggered = false);

        logger.info('AI', 'Gemini call started');
        const ray = new RayDalioAgent();
        const hindenburg = new HindenburgAgent();
        const simons = new JamesSimonsAgent();
        const drucker = new PeterDruckerAgent();
        const cio = new StanleyDruckenmillerAgent();

        await Promise.all([
            ray.initializeContext(userId),
            hindenburg.initializeContext(userId),
            simons.initializeContext(userId),
            drucker.initializeContext(userId),
            cio.initializeContext(userId)
        ]);
        ray.setPortfolioSnapshot(snapshot.positions);
        hindenburg.setPortfolioSnapshot(snapshot.positions);
        simons.setPortfolioSnapshot(snapshot.positions);
        drucker.setPortfolioSnapshot(snapshot.positions);
        cio.setPortfolioSnapshot(snapshot.positions);

        logger.info('AI', 'portfolio debate snapshot prepared', {
            discordUserId: userId,
            totalMarketValueKrw: snapshot.summary.total_market_value_krw,
            top3WeightPct: snapshot.summary.top3_weight_pct,
            domesticWeightPct: snapshot.summary.domestic_weight_pct,
            usWeightPct: snapshot.summary.us_weight_pct
        });
        const modePrompt = `[USER_MODE]\n${mode}\nSAFE=보수적, BALANCED=중립, AGGRESSIVE=공격적 기준을 답변 강도에 반영하라.`;
        const snapshotPrompt = `[PORTFOLIO_SNAPSHOT]\n${JSON.stringify(snapshot, null, 2)}\n위 스냅샷을 기준으로만 자산배분/리스크/리밸런싱을 논의하라.`;
        const partialScope =
            hasPortfolio && !anchorState.hasLifestyle
                ? [
                      '[분석 범위]',
                      '- 현재 등록된 **포트폴리오 스냅샷 기준 부분 분석**이다.',
                      '- **생활비 적합성·월 투자여력·현금버퍼 적정성** 등은 지출/현금흐름 데이터 없이 **정밀 판단 불가** — 답변에서 "부분 분석"과 "정밀 분석 불가"를 구분해 명시하라.',
                      '- 지출·현금흐름을 입력하면 위 항목을 정밀화할 수 있다.'
                  ].join('\n')
                : '';

        const profile = await loadUserProfile(userId);
        logger.info('PROFILE', 'user profile applied', {
            discordUserId: userId,
            risk_tolerance: profile.risk_tolerance,
            investment_style: profile.investment_style,
            favored_analysis_styles: profile.favored_analysis_styles?.slice(0, 5)
        });

        const profilePromptParts: string[] = [];
        if (profile.risk_tolerance) profilePromptParts.push(`risk_tolerance=${profile.risk_tolerance}`);
        if (profile.investment_style) profilePromptParts.push(`investment_style=${profile.investment_style}`);
        if (profile.favored_analysis_styles?.length) profilePromptParts.push(`favored_analysis_styles=${profile.favored_analysis_styles.join(',')}`);
        if (profile.preferred_personas?.length) profilePromptParts.push(`preferred_personas=${profile.preferred_personas.join(',')}`);
        if (profile.avoided_personas?.length) profilePromptParts.push(`avoided_personas=${profile.avoided_personas.join(',')}`);
        if (profile.personalization_notes) profilePromptParts.push(`personalization_notes=${profile.personalization_notes}`);

        const profilePrompt = profilePromptParts.length
            ? `[USER PERSONALIZATION CONTEXT]\n${profilePromptParts.join('\n')}\n\n`
            : '';

        const baseQuery = `${profilePrompt}${modePrompt}\n\n${userQuery}\n\n${snapshotPrompt}${partialScope ? `\n\n${partialScope}\n` : ''}`;

        const favored = profile.favored_analysis_styles || [];
        const styleDirectives: string[] = [];
        if (favored.includes('risk-heavy') || favored.includes('risk-focused')) {
            styleDirectives.push('[STYLE:risk-heavy]\n- 모든 페르소나는 먼저 DOWNside(최악/리스크) 시나리오를 제시하고, 그 다음에 구조/대응/관측지표로 이어가라.');
        }
        if (favored.includes('data-driven') || favored.includes('numeric-centric')) {
            styleDirectives.push('[STYLE:data-driven]\n- 모든 페르소나는 가능한 한 수치/확률/구간(예: ~범위, %가능성)을 최소 1개 이상 포함해라.');
        }
        if (favored.includes('action-oriented') || favored.includes('execution-oriented')) {
            styleDirectives.push('[STYLE:action-oriented]\n- 모든 페르소나는 결론 말미에 반드시 실행 체크리스트(3개 이하)를 제공하라.');
        }
        const styleDirectiveBlock = styleDirectives.length ? `\n\n[FAVORED_ANALYSIS_STYLES]\n${styleDirectives.join('\n')}` : '';

        const preferredNamesForBias = profile.preferred_personas || [];
        const avoidedNamesForBias = profile.avoided_personas || [];
        const personaBiasDirective = (k: PersonaKey) => {
            const n = personaKeyToPersonaName(k);
            const isPreferred = preferredNamesForBias.includes(n);
            const isAvoided = avoidedNamesForBias.includes(n);
            if (isPreferred) {
                return `[PERSONA_BIAS]\npreferred_persona=true\n응답을 더 길게(핵심 bullet 5개 이상) 작성하고 요약(summary)에도 우선 반영하라.\n`;
            }
            if (isAvoided) {
                return `[PERSONA_BIAS]\npreferred_persona=false\n응답은 간결하게(핵심 bullet 2개 이하) 하고 하단/후순위로 작성하라.\n`;
            }
            return '';
        };

        // Phase 1: persona_memory 반영 (프롬프트 대규모 변경 없이, 짧은 지시문만 덧붙임)
        const memoryKeys: PersonaKey[] = ['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER', 'CIO'];
        const memoryByKey = new Map<PersonaKey, string>();
        await Promise.all(
            memoryKeys.map(async k => {
                const personaName = personaKeyToPersonaName(k);
                const personaMemory = await loadPersonaMemory(userId, personaName);
                const personaPromptCtx = buildPersonaPromptContext({
                    personaKey: k,
                    personaName,
                    personaMemory,
                    baseContext: {}
                });
                memoryByKey.set(k, personaPromptCtx.memory_directive);
            })
        );

        const rayMemory = memoryByKey.get('RAY') ?? '';
        const hindenburgMemory = memoryByKey.get('HINDENBURG') ?? '';
        const simonsMemory = memoryByKey.get('SIMONS') ?? '';
        const druckerMemory = memoryByKey.get('DRUCKER') ?? '';
        const cioMemory = memoryByKey.get('CIO') ?? '';

        const rayQuery = `${baseQuery}${styleDirectiveBlock}\n\n${personaBiasDirective('RAY')}${rayMemory ? `\n\n${rayMemory}` : ''}`;
        const hindenburgQuery = `${baseQuery}${styleDirectiveBlock}\n\n${personaBiasDirective('HINDENBURG')}${hindenburgMemory ? `\n\n${hindenburgMemory}` : ''}`;
        const simonsQuery = `${baseQuery}${styleDirectiveBlock}\n\n${personaBiasDirective('SIMONS')}${simonsMemory ? `\n\n${simonsMemory}` : ''}`;
        const druckerQuery = `${baseQuery}${styleDirectiveBlock}\n\n${personaBiasDirective('DRUCKER')}${druckerMemory ? `\n\n${druckerMemory}` : ''}`;
        const cioQuery = `${baseQuery}${styleDirectiveBlock}\n\n${personaBiasDirective('CIO')}${cioMemory ? `\n\n${cioMemory}` : ''}`;

        // 1) Gemini 결과를 먼저 계산
        const rayResRaw = await ray.analyze(rayQuery, false);
        const rayRes = normalizeProviderOutputForDiscord({ text: rayResRaw, provider: 'gemini', personaKey: 'RAY' });
        if (rayRes?.includes('[REASON: NO_DATA]')) {
            logger.warn('AI', 'Ray Dalio aborted due to NO_DATA at logic layer');
            return;
        }
        logger.info('AGENT', 'Hindenburg analysis started', { userId });
        const hindenburgGen = await generateWithPersonaProvider({
            discordUserId: userId,
            personaKey: 'HINDENBURG',
            personaName: personaKeyToPersonaName('HINDENBURG'),
            prompt: hindenburgQuery,
            fallbackToGemini: async () => asGeminiResult(await hindenburg.analyze(hindenburgQuery, false))
        });
        const hindenburgRes = normalizeProviderOutputForDiscord({
            text: hindenburgGen.text,
            provider: hindenburgGen.provider,
            personaKey: 'HINDENBURG'
        });
        const simonsGen = await generateWithPersonaProvider({
            discordUserId: userId,
            personaKey: 'SIMONS',
            personaName: personaKeyToPersonaName('SIMONS'),
            prompt: simonsQuery,
            fallbackToGemini: async () =>
                asGeminiResult(await simons.strategize(simonsQuery, false, `[Ray]\n${rayRes}\n[Hindenburg]\n${hindenburgRes}`))
        });
        const simonsRes = normalizeProviderOutputForDiscord({
            text: simonsGen.text,
            provider: simonsGen.provider,
            personaKey: 'SIMONS'
        });
        const druckerCombinedLog = `${personaBiasDirective('DRUCKER')}${styleDirectiveBlock}\n[Ray]\n${rayRes}\n[Hindenburg]\n${hindenburgRes}\n[Simons]\n${simonsRes}`;
        const druckerResRaw = await drucker.summarizeAndGenerateActions(false, druckerCombinedLog);
        const druckerRes = normalizeProviderOutputForDiscord({ text: druckerResRaw, provider: 'gemini', personaKey: 'DRUCKER' });
        const cioCombinedLog = `${personaBiasDirective('CIO')}${styleDirectiveBlock}\n[Ray]\n${rayRes}\n[Hindenburg]\n${hindenburgRes}\n[Simons]\n${simonsRes}\n[Drucker]\n${druckerRes}`;
        const cioResRaw = await cio.decide(false, cioCombinedLog);
        const cioRes = normalizeProviderOutputForDiscord({ text: cioResRaw, provider: 'gemini', personaKey: 'CIO' });

        const analysisType = guessAnalysisTypeFromTrigger(triggerId, userQuery);

        // Persona bias: preferred personas는 상단/요약에 우선 반영, avoided personas는 하단/요약에서 제외
        const preferredNames = profile.preferred_personas || [];
        const avoidedNames = profile.avoided_personas || [];
        const keyOrder: PersonaKey[] = ['HINDENBURG', 'RAY', 'SIMONS', 'DRUCKER', 'CIO'];
        const scoreForKey = (k: PersonaKey) => {
            const n = personaKeyToPersonaName(k);
            const pi = preferredNames.indexOf(n);
            if (pi >= 0) return 10000 - pi;
            const ai = avoidedNames.indexOf(n);
            if (ai >= 0) return -10000 - ai;
            return 0;
        };
        const orderedKeys = [...keyOrder].sort((a, b) => scoreForKey(b) - scoreForKey(a));
        const preferredSummaryKey = orderedKeys.find(k => preferredNames.includes(personaKeyToPersonaName(k))) || 'CIO';
        const preferredSummarySource =
            preferredSummaryKey === 'HINDENBURG' ? hindenburgRes :
                preferredSummaryKey === 'RAY' ? rayRes :
                    preferredSummaryKey === 'SIMONS' ? simonsRes :
                        preferredSummaryKey === 'DRUCKER' ? druckerRes :
                            cioRes;

        // 2) chat_history를 먼저 insert해서 id를 확보 (feedback 연결 목적)
        const chatHistoryPayload: any = {
            user_id: userId,
            user_query: userQuery,
            debate_type: analysisType,
            ray_advice: rayRes,
            jyp_insight: null,
            simons_opportunity: simonsRes,
            drucker_decision: druckerRes,
            cio_decision: cioRes,
            jyp_weekly_report: null,
            summary: toOpinionSummary(preferredSummarySource, 1000),
            key_risks: toOpinionSummary(hindenburgRes, 1500),
            key_actions: toOpinionSummary(druckerRes, 1500)
        };
        logger.info('DB', 'chat_history payload preview', {
            keys: Object.keys(chatHistoryPayload),
            hasWeeklyReport: false
        });

        const chatHistoryId = await safeInsertChatHistoryAndGetId(chatHistoryPayload, true);
        if (chatHistoryId) logger.info('DB', 'chat_history insert success', { chatHistoryId });

        if (chatHistoryId) {
            const baseContext = buildBaseAnalysisContext({
                discordUserId: userId,
                analysisType,
                userQuery,
                mode,
                userProfile: profile,
                snapshotSummary: snapshot.summary,
                snapshotPositionsCount: snapshot.positions.length,
                partialScope: partialScope || undefined
            });

            await runAnalysisPipeline({
                discordUserId: userId,
                chatHistoryId,
                analysisType,
                personaOutputs: [
                    { personaKey: 'RAY', personaName: personaKeyToPersonaName('RAY'), responseText: rayRes, providerName: 'gemini', modelName: 'gemini-2.5-flash' },
                    {
                        personaKey: 'HINDENBURG',
                        personaName: personaKeyToPersonaName('HINDENBURG'),
                        responseText: hindenburgRes,
                        providerName: hindenburgGen.provider,
                        modelName: hindenburgGen.model,
                        estimatedCostUsd: hindenburgGen.estimated_cost_usd
                    },
                    {
                        personaKey: 'SIMONS',
                        personaName: personaKeyToPersonaName('SIMONS'),
                        responseText: simonsRes,
                        providerName: simonsGen.provider,
                        modelName: simonsGen.model,
                        estimatedCostUsd: simonsGen.estimated_cost_usd
                    },
                    { personaKey: 'DRUCKER', personaName: personaKeyToPersonaName('DRUCKER'), responseText: druckerRes, providerName: 'gemini', modelName: 'gemini-2.5-flash' },
                    { personaKey: 'CIO', personaName: personaKeyToPersonaName('CIO'), responseText: cioRes, providerName: 'gemini', modelName: 'gemini-2.5-flash' }
                ],
                baseContext
            });
        }

        logger.info('AI', 'Gemini call completed');

        // 3) 확보한 chat_history_id로 feedback 버튼을 붙여서 전송
        const feedbackRay = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, 'RAY') : null;
        const feedbackHindenburg = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, 'HINDENBURG') : null;
        const feedbackSimons = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, 'SIMONS') : null;
        const feedbackDrucker = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, 'DRUCKER') : null;
        const feedbackCio = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, 'CIO') : null;

        const resultByKey: Record<PersonaKey, string> = {
            RAY: rayRes,
            HINDENBURG: hindenburgRes,
            SIMONS: simonsRes,
            DRUCKER: druckerRes,
            CIO: cioRes,
            JYP: '',
            TREND: '',
            OPEN_TOPIC: ''
        };

        const metaByKey: Partial<Record<PersonaKey, { agentName: string; avatarUrl: string }>> = {
            RAY: {
                agentName: 'Ray Dalio (PB)',
                avatarUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Ray_Dalio_at_the_World_Economic_Forum_%28cropped%29.jpg'
            },
            HINDENBURG: {
                agentName: 'HINDENBURG_ANALYST',
                avatarUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Albert_Einstein_Head.png'
            },
            SIMONS: {
                agentName: 'James Simons (Quant)',
                avatarUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/46/Jim_Simons.jpg'
            },
            DRUCKER: {
                agentName: 'Peter Drucker (COO)',
                avatarUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/00/Peter_Drucker_circa_1980.jpg'
            },
            CIO: {
                agentName: 'Stanley Druckenmiller (CIO)',
                avatarUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Stanley_Druckenmiller.jpg'
            }
        };

        const feedbackByKey: Partial<Record<PersonaKey, ActionRowBuilder<ButtonBuilder> | null>> = {
            RAY: feedbackRay,
            HINDENBURG: feedbackHindenburg,
            SIMONS: feedbackSimons,
            DRUCKER: feedbackDrucker,
            CIO: feedbackCio
        };

        for (const k of orderedKeys) {
            const meta = metaByKey[k];
            if (!meta) continue;
            await broadcastAgentResponse(
                userId,
                meta.agentName,
                meta.avatarUrl,
                resultByKey[k],
                sourceInteraction,
                feedbackByKey[k] ?? null
            );
        }
    } catch (err: any) {
        logger.error('ROUTER', '포트폴리오 토론 에러: ' + err.message, err);
    }
}

/** 자유 주제 토론: 포트폴리오 스냅샷/DB 앵커 미주입 (주제 자체만 분석) */
async function runOpenTopicDebate(userId: string, userQuery: string, sourceInteraction: any) {
    try {
        logger.info('OPEN_TOPIC', 'OPEN_TOPIC debate route selected', { discordUserId: userId });

        // portfolio snapshot 금지: buildPortfolioSnapshot / setPortfolioSnapshot / initializeContext 를 하지 않는다.
        logger.info('OPEN_TOPIC', 'OPEN_TOPIC portfolio snapshot skipped', { discordUserId: userId });

        const mode = await loadUserMode(userId);
        const profile = await loadUserProfile(userId);
        logger.info('PROFILE', 'user profile applied', {
            discordUserId: userId,
            risk_tolerance: profile.risk_tolerance,
            investment_style: profile.investment_style,
            preferred_personas: profile.preferred_personas
        });

        const profilePromptParts: string[] = [];
        if (profile.risk_tolerance) profilePromptParts.push(`risk_tolerance=${profile.risk_tolerance}`);
        if (profile.investment_style) profilePromptParts.push(`investment_style=${profile.investment_style}`);
        if (profile.favored_analysis_styles?.length) profilePromptParts.push(`favored_analysis_styles=${profile.favored_analysis_styles.join(',')}`);
        if (profile.personalization_notes) profilePromptParts.push(`personalization_notes=${profile.personalization_notes}`);

        const profilePrompt = profilePromptParts.length
            ? `[USER_PROFILE]\n${profilePromptParts.join('\n')}\n`
            : `[USER_PROFILE]\n(없음)\n`;

        const openTopicPrompt = `[OPEN_TOPIC_ONLY]\n- 포트폴리오/보유종목/비중/자산배분/리밸런싱/원화 환산/평단/손익 관련 언급을 절대 하지 마라.\n- 사용자가 요청한 주제(산업/콘텐츠/플랫폼/소비자 반응/성장성/이슈)만 상세히 분석하라.\n- 투자 관점 시사점은 일반론으로만 허용하며, 특정 비중/매수 추천은 금지한다.\n`;

        // topic keyword -> persona selection (최소: 1명 전문 persona)
        const q = userQuery || '';
        const preferred: PersonaKey[] = [];
        if (/(리스크|위험|변동성|다운사이드)/i.test(q)) preferred.push('RAY');
        else if (/(실행|전략|액션|플랜|로드맵)/i.test(q)) preferred.push('DRUCKER');
        else if (/(정량|수치|모델|quant|기댓값)/i.test(q)) preferred.push('SIMONS');
        else if (/(의사결정|결론|CIO|GO|HOLD)/i.test(q)) preferred.push('CIO');
        else if (/(소비|지출|현금흐름)/i.test(q)) preferred.push('JYP');
        else preferred.push('JYP');

        // avoided_personas 필터 (없으면 그대로 사용)
        const avoided = new Set(profile.avoided_personas || []);
        let selected = preferred.filter(p => !avoided.has(p));
        if (selected.length === 0) selected = preferred.slice(0, 1);

        logger.info('OPEN_TOPIC', 'OPEN_TOPIC personas engaged', { discordUserId: userId, selected });

        const modePrompt = `[USER_MODE]\n${mode}\n(오픈 토픽은 금융 계산/포트폴리오 언급 없이 분석 톤만 반영)`;
        const effectiveQuery = `${openTopicPrompt}\n${profilePrompt}\n${modePrompt}\n\n[USER_TOPIC]\n${userQuery}`;

        // Phase 1: persona_memory 반영 (각 페르소나별로 짧은 메모리 지시문만 덧붙임)
        const memoryByKey = new Map<PersonaKey, string>();
        await Promise.all(
            selected.map(async p => {
                const personaName = personaKeyToPersonaName(p);
                const personaMemory = await loadPersonaMemory(userId, personaName);
                const personaPromptCtx = buildPersonaPromptContext({
                    personaKey: p,
                    personaName,
                    personaMemory,
                    baseContext: {}
                });
                memoryByKey.set(p, personaPromptCtx.memory_directive);
            })
        );

        const personas: Partial<Record<PersonaKey, any>> = {
            RAY: new RayDalioAgent(),
            JYP: new JYPAgent(),
            SIMONS: new JamesSimonsAgent(),
            DRUCKER: new PeterDruckerAgent(),
            CIO: new StanleyDruckenmillerAgent()
        };

        const forbiddenKeywords = ['포트폴리오', '비중', '보유종목', '리밸런싱'];
        const filterForbiddenFinancialKeywords = (text: string, personaKey: PersonaKey): string => {
            const t = String(text || '');
            const found = forbiddenKeywords.find(k => t.includes(k));
            if (!found) return t;

            logger.warn('OPEN_TOPIC', 'OPEN_TOPIC forbidden financial keyword detected', {
                discordUserId: userId,
                personaKey,
                keyword: found
            });

            const filtered = t
                .split('\n')
                .filter(line => !forbiddenKeywords.some(k => line.includes(k)))
                .join('\n')
                .trim();

            return filtered || '요청하신 주제 분야 중심으로만 답변합니다.';
        };

        // isTrendQuery=true로 validateAndGenerate의 NO_DATA 하드게이트를 우회
        const results: Partial<Record<PersonaKey, string>> = {};
        const providerMetaByKey: Partial<Record<PersonaKey, { provider: string; model: string; estimatedCostUsd?: number }>> = {};
        for (const p of selected) {
            const agent = personas[p];
            const memoryDirective = memoryByKey.get(p) ?? '';
            const personaQuery = memoryDirective ? `${effectiveQuery}\n\n${memoryDirective}` : effectiveQuery;
            if (p === 'SIMONS') {
                const gen = await generateWithPersonaProvider({
                    discordUserId: userId,
                    personaKey: 'SIMONS',
                    personaName: personaKeyToPersonaName('SIMONS'),
                    prompt: personaQuery,
                    fallbackToGemini: async () => asGeminiResult(await agent.strategize(personaQuery, true, ''))
                });
                providerMetaByKey[p] = {
                    provider: gen.provider,
                    model: gen.model,
                    estimatedCostUsd: gen.estimated_cost_usd
                };
                const normalized = normalizeProviderOutputForDiscord({ text: gen.text, provider: gen.provider, personaKey: p });
                results[p] = filterForbiddenFinancialKeywords(normalized, p);
                continue;
            }

            const rawText = await (p === 'RAY'
                ? agent.analyze(personaQuery, true)
                : p === 'JYP'
                    ? agent.inspire(personaQuery, true, '')
                    : p === 'DRUCKER'
                        ? agent.summarizeAndGenerateActions(true, '')
                        : agent.decide(true, ''));
            providerMetaByKey[p] = { provider: 'gemini', model: 'gemini-2.5-flash' };
            const normalized = normalizeProviderOutputForDiscord({ text: rawText, provider: 'gemini', personaKey: p });
            results[p] = filterForbiddenFinancialKeywords(normalized, p);
        }

        const debateType = 'open_topic';
        const chatHistoryPayload: any = {
            user_id: userId,
            user_query: userQuery,
            debate_type: debateType,
            ray_advice: results.RAY ?? null,
            jyp_insight: results.JYP ?? null,
            simons_opportunity: results.SIMONS ?? null,
            drucker_decision: results.DRUCKER ?? null,
            cio_decision: results.CIO ?? null,
            jyp_weekly_report: null as string | null,
            summary: toOpinionSummary(String(results[selected[0]] || ''), 1000),
            key_risks: toOpinionSummary(String(results.RAY || ''), 1000),
            key_actions: toOpinionSummary(String(results.DRUCKER || ''), 1000)
        };

        const chatHistoryId = await safeInsertChatHistoryAndGetId(chatHistoryPayload, true);
        if (chatHistoryId) logger.info('DB', 'chat_history insert success (open_topic)', { chatHistoryId });

        const analysisType = guessAnalysisTypeFromTrigger(undefined, userQuery);

        if (chatHistoryId) {
            const baseContext = buildBaseAnalysisContext({
                discordUserId: userId,
                analysisType,
                userQuery,
                mode,
                userProfile: profile,
                snapshotSummary: null,
                snapshotPositionsCount: undefined,
                partialScope: undefined
            });

            await runAnalysisPipeline({
                discordUserId: userId,
                chatHistoryId,
                analysisType,
                personaOutputs: selected.map(p => ({
                    personaKey: p,
                    personaName: personaKeyToPersonaName(p),
                    responseText: String(results[p] || ''),
                    providerName: providerMetaByKey[p]?.provider || 'gemini',
                    modelName: providerMetaByKey[p]?.model || 'gemini-2.5-flash',
                    estimatedCostUsd: providerMetaByKey[p]?.estimatedCostUsd
                })),
                baseContext
            });
        }

        for (const p of selected) {
            const feedbackRow = chatHistoryId ? getFeedbackButtonsRow(chatHistoryId, analysisType, p) : null;
            const label = personaKeyToPersonaName(p);
            const avatarURL = p === 'JYP'
                ? 'https://upload.wikimedia.org/wikipedia/commons/4/44/Park_Jin-young_at_WCG_2020.png'
                : p === 'RAY'
                    ? 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Ray_Dalio_at_the_World_Economic_Forum_%28cropped%29.jpg'
                    : p === 'SIMONS'
                        ? 'https://upload.wikimedia.org/wikipedia/commons/4/46/Jim_Simons.jpg'
                        : p === 'DRUCKER'
                            ? 'https://upload.wikimedia.org/wikipedia/commons/0/00/Peter_Drucker_circa_1980.jpg'
                            : 'https://upload.wikimedia.org/wikipedia/commons/0/0f/StanleyDruckenmiller.jpg';

            await broadcastAgentResponse(userId, label, avatarURL, String(results[p] || ''), sourceInteraction, feedbackRow);
        }
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
        if (parts.length < 3) return message.reply("❌ 사용법: `!현금흐름추가 [종류] [금액] [설명...]` (income, fixed_expense, saving, investment, debt_payment, other)");
        const [_, typeRaw, amountStr, ...descParts] = parts;
        const flowType = normalizeFlowType(typeRaw);
        if (!flowType) return message.reply("❌ 잘못된 현금흐름 종류입니다. (income, fixed_expense, saving, investment, debt_payment, other 중 택 1)");
        
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

            // Feedback button handler: analysis feedback를 누적 저장
            if (cid.startsWith('feedback:save:')) {
                await safeDeferReply(interaction, { flags: 64 });
                try {
                    const parts = cid.split(':');
                    // feedback:save:${chatHistoryId}:${feedbackType}:${personaKey}
                    const chatHistoryIdRaw = parts[2];
                    const feedbackTypeRaw = parts[3];
                    const personaKeyRaw = parts[4];

                    const discordUserId = getDiscordUserId(interaction.user);
                    const feedbackType = String(feedbackTypeRaw || '').toUpperCase() as FeedbackType;
                    const personaKey = String(personaKeyRaw || '') as PersonaKey;

                    const chatHistoryId = Number(chatHistoryIdRaw);
                    if (!Number.isFinite(chatHistoryId) || !feedbackType || !personaKey) {
                        await safeEditReply(interaction, '❌ 피드백 처리 실패(파라미터 누락).', 'feedback:save:invalid');
                        return;
                    }

                    logger.info('PROFILE', 'feedback button clicked', {
                        discordUserId,
                        chatHistoryId,
                        feedbackType,
                        personaKey
                    });

                    let chatRow: any = null;
                    try {
                        const { data, error } = await supabase
                            .from('chat_history')
                            .select('id,user_id,debate_type,user_query,ray_advice,key_risks,key_actions,jyp_insight,simons_opportunity,drucker_decision,cio_decision,summary')
                            .eq('id', chatHistoryId)
                            .maybeSingle();
                        if (error) throw error;
                        chatRow = data;
                    } catch (selErr: any) {
                        logger.warn('DB', 'chat_history select fallback triggered', {
                            discordUserId,
                            message: selErr?.message || String(selErr)
                        });
                        const { data, error } = await supabase
                            .from('chat_history')
                            .select('id,user_id,debate_type,user_query,ray_advice,jyp_insight,simons_opportunity,drucker_decision,cio_decision')
                            .eq('id', chatHistoryId)
                            .maybeSingle();
                        if (error) throw error;
                        chatRow = data;
                    }

                    if (!chatRow) {
                        await safeEditReply(interaction, '❌ 연결된 분석 기록을 찾을 수 없습니다(만료/삭제).', 'feedback:save:not_found');
                        return;
                    }
                    if (String(chatRow.user_id) !== String(discordUserId)) {
                        await safeEditReply(interaction, '❌ 본인 분석에 대한 피드백만 저장할 수 있습니다.', 'feedback:save:unauthorized');
                        return;
                    }

                    const columnKey = getPersonaColumnKey(personaKey);
                    let opinionText = String((chatRow as any)[columnKey] || '');
                    if (!opinionText && columnKey === 'key_risks') {
                        // schema 미스매치 fallback: HINDENBURG는 key_risks 대신 ray_advice에 저장됐을 수 있음
                        opinionText = String(chatRow?.ray_advice || '');
                    }
                    if (!opinionText) {
                        await safeEditReply(interaction, '❌ 해당 페르소나 응답을 찾지 못했습니다.', 'feedback:save:no_opinion');
                        return;
                    }

                    const opinionSummary = toOpinionSummary(opinionText, 220);
                    const analysisType = String(chatRow.debate_type || 'unknown');
                    const personaName = personaKeyToPersonaName(personaKey);

                    const preferredClaimId = await getRecentClaimIdForFeedback({
                        discordUserId,
                        chatHistoryId,
                        analysisType,
                        personaName
                    });

                    let ingestResult: {
                        mappedCount: number;
                        fallbackLegacyOnly: boolean;
                        duplicate: boolean;
                        bestClaimId: string | null;
                        mappingMethod: 'direct_claim_id' | 'scored_candidate' | 'legacy_only';
                        mappingScore: number | null;
                        candidateCount: number;
                    } = {
                        mappedCount: 0,
                        fallbackLegacyOnly: true,
                        duplicate: false,
                        bestClaimId: null,
                        mappingMethod: 'legacy_only',
                        mappingScore: null,
                        candidateCount: 0
                    };
                    try {
                        ingestResult = await ingestPersonaFeedback({
                            discordUserId,
                            chatHistoryId,
                            analysisType,
                            personaName,
                            feedbackType,
                            feedbackNote: null,
                            opinionText,
                            preferredClaimId
                        });
                    } catch {
                        // keep legacy flow
                    }

                    const historyResult = await saveAnalysisFeedbackHistory({
                        discordUserId,
                        chatHistoryId,
                        analysisType,
                        personaName,
                        opinionSummary,
                        opinionText,
                        feedbackType,
                        mappedClaimId: ingestResult.bestClaimId,
                        mappingMethod: ingestResult.mappingMethod,
                        mappingScore: ingestResult.mappingScore
                    });

                    logger.info('FEEDBACK', 'feedback button handled', {
                        discordUserId,
                        chatHistoryId,
                        personaKey,
                        feedbackType,
                        historyDuplicate: historyResult.duplicate,
                        claimMappedCount: ingestResult.mappedCount,
                        fallbackLegacyOnly: ingestResult.fallbackLegacyOnly,
                        claimDuplicate: ingestResult.duplicate,
                        mappingMethod: ingestResult.mappingMethod,
                        mappingScore: ingestResult.mappingScore,
                        mappedClaimId: ingestResult.bestClaimId,
                        candidateCount: ingestResult.candidateCount
                    });

                    const uxMessage = historyResult.duplicate || ingestResult.duplicate
                        ? `✅ 피드백은 이미 반영되어 있습니다. (${feedbackType})`
                        : `✅ 피드백이 저장되었습니다. (${feedbackType})`;
                    await safeEditReply(interaction, uxMessage, 'feedback:save:success');
                } catch (e: any) {
                    logger.error('PROFILE', 'feedback save handler failed', { error: e?.message || String(e) });
                    await safeEditReply(interaction, `❌ 피드백 저장 실패 (시스템 로그 기록됨).`, 'feedback:save:failure');
                }
                return;
            }

            if (cid.startsWith('panel:main:')) {
                logger.info('INTERACTION', 'handler branch entered', {
                    interactionId: interaction.id,
                    customId: interaction.customId
                });
                if (cid === 'panel:main:trend') {
                    logger.info('INTERACTION', 'main trend branch start', {
                        interactionId: interaction.id,
                        discordUserId: interaction.user?.id
                    });
                    try {
                        if (interaction.deferred || interaction.replied) {
                            logger.warn('INTERACTION', 'main trend update skipped — already acknowledged', {
                                interactionId: interaction.id,
                                deferred: interaction.deferred,
                                replied: interaction.replied
                            });
                            return;
                        }
                        await interaction.update(getTrendPanel());
                        logger.info('INTERACTION', 'main trend update success', {
                            interactionId: interaction.id,
                            customId: interaction.customId
                        });
                    } catch (e: any) {
                        logger.error('INTERACTION', 'main trend local catch', {
                            interactionId: interaction.id,
                            message: e?.message,
                            code: e?.code
                        });
                        try {
                            if (!interaction.replied && !interaction.deferred) {
                                await interaction.reply({
                                    ...getTrendPanel(),
                                    flags: 64
                                });
                            }
                        } catch (_) {
                            /* ignore */
                        }
                    }
                    logger.info('INTERACTION', 'main trend branch return', {
                        interactionId: interaction.id,
                        customId: interaction.customId
                    });
                    return;
                }
                if (cid === 'panel:main:portfolio') {
                    logger.info('UI', 'portfolio panel rendered', { variant: 'main' });
                    await safeUpdate(interaction, getPortfolioPanel(), 'panel:main:portfolio');
                }
                else if (cid === 'panel:main:finance') await safeUpdate(interaction, getFinancePanel(), 'panel:main:finance');
                else if (cid === 'panel:main:ai') await safeUpdate(interaction, getAIPanel(), 'panel:main:ai');
                else if (cid === 'panel:main:settings') await safeUpdate(interaction, getSettingsPanel(), 'panel:main:settings');
                else if (cid === 'panel:main:reinstall') await safeUpdate(interaction, getMainPanel(), 'panel:main:reinstall');
                logger.info('INTERACTION', 'handler branch returning', {
                    interactionId: interaction.id,
                    customId: interaction.customId
                });
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

            if (financialCommandQueryMap[cid]) {
                const query = financialCommandQueryMap[cid];
                const statusText = '📊 **포트폴리오·소비·현금흐름 기준 재무 분석 중...**';
                await safeDeferReply(interaction, { flags: 64 });
                await safeEditReplyPayload(interaction, { content: statusText }, `${cid}:status`);
                await runPortfolioDebate(interaction.user.id, query, interaction);
                return;
            }

            if (cid === 'panel:portfolio:more') {
                logger.info('UI', 'portfolio panel rendered', { variant: 'more' });
                await safeUpdate(interaction, getPortfolioMorePanel(), 'panel:portfolio:more');
                return;
            }

            if (cid === 'panel:portfolio:accounts') {
                await safeDeferReply(interaction, { flags: 64 });
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    const rows = await listUserAccounts(discordUserId);
                    if (!rows.length) {
                        await safeEditReply(
                            interaction,
                            '등록된 계좌가 없습니다. 채팅에서 `!계좌추가 계좌이름 유형`으로 추가할 수 있습니다.',
                            'panel:portfolio:accounts:empty'
                        );
                        return;
                    }
                    const lines = rows.map(a => {
                        const isGen = a.account_name === GENERAL_ACCOUNT_NAME;
                        const badge = isGen
                            ? '[기본]'
                            : a.account_type === 'RETIREMENT' || a.account_type === 'PENSION'
                              ? '[퇴직연금]'
                              : `[${accountTypeLabelKo(a.account_type)}]`;
                        return `· **${a.account_name}** ${badge}`;
                    });
                    const text = ['**내 계좌**', '', ...lines, '', `_일반계좌가 기본 매매·조회 계좌입니다._`].join('\n');
                    await safeEditReply(interaction, text, 'panel:portfolio:accounts:ok');
                } catch (e: any) {
                    await safeEditReply(interaction, `계좌 목록을 불러오지 못했습니다.`, 'panel:portfolio:accounts:err');
                }
                return;
            }

            if (cid === 'panel:portfolio:view:pick') {
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    const rows = await listUserAccounts(discordUserId);
                    if (!rows.length) {
                        await interaction.reply({
                            content: '등록된 계좌가 없습니다. `!계좌추가`로 먼저 추가해 주세요.',
                            ephemeral: true
                        });
                        return;
                    }
                    const select = new StringSelectMenuBuilder()
                        .setCustomId('select:portfolio:account')
                        .setPlaceholder('조회할 계좌 선택')
                        .addOptions(
                            rows.slice(0, 25).map(a =>
                                new StringSelectMenuOptionBuilder()
                                    .setLabel(`${a.account_name} (${accountTypeLabelKo(a.account_type)})`.slice(0, 100))
                                    .setValue(a.id)
                            )
                        );
                    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                    await interaction.reply({
                        content: '계좌를 선택하면 해당 계좌만 조회합니다.',
                        components: [row],
                        ephemeral: true
                    });
                    logger.info('UI', 'advanced account selector used', { purpose: 'view_by_account' });
                } catch (e: any) {
                    await interaction.reply({ content: '계좌 목록을 불러오지 못했습니다.', ephemeral: true }).catch(() => {});
                }
                return;
            }

            if (cid === 'panel:portfolio:view:retirement') {
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    const r = await findFirstRetirementAccount(discordUserId);
                    if (!r) {
                        await safeDeferReply(interaction, { flags: 64 });
                        await safeEditReply(
                            interaction,
                            '퇴직연금 계좌가 없습니다. `!계좌추가 퇴직연금계좌 RETIREMENT`로 추가하거나 **계좌 관리**를 이용하세요.',
                            'panel:portfolio:view:retirement:none'
                        );
                        return;
                    }
                    await runPortfolioQueryFromButton(interaction, discordUserId, 'retirement', {
                        accountId: r.id,
                        accountName: r.account_name,
                        accountType: r.account_type,
                        orchestratorCustomId: cid
                    });
                } catch (e: any) {
                    (interaction as any).__localErrorHandled = true;
                    await safeDeferReply(interaction, { flags: 64 }).catch(() => {});
                    await safeEditReply(interaction, '조회 처리 중 오류가 발생했습니다.', 'panel:portfolio:view:retirement:ex').catch(() => {});
                }
                return;
            }

            if (cid === 'panel:portfolio:add:other') {
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    const rows = await listUserAccounts(discordUserId);
                    if (!rows.length) {
                        await interaction.reply({
                            content: '등록된 계좌가 없습니다. 먼저 `!계좌추가`로 계좌를 만든 뒤 이용하세요.',
                            ephemeral: true
                        });
                        return;
                    }
                    const select = new StringSelectMenuBuilder()
                        .setCustomId('select:portfolio:buy')
                        .setPlaceholder('매수를 반영할 계좌')
                        .addOptions(
                            rows.slice(0, 25).map(a =>
                                new StringSelectMenuOptionBuilder()
                                    .setLabel(`${a.account_name} (${accountTypeLabelKo(a.account_type)})`.slice(0, 100))
                                    .setValue(a.id)
                            )
                        );
                    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                    await interaction.reply({
                        content: '계좌를 고른 뒤 입력 창이 열립니다.',
                        components: [row],
                        ephemeral: true
                    });
                    logger.info('UI', 'advanced account selector used', { purpose: 'buy' });
                } catch (e: any) {
                    await interaction.reply({ content: '계좌 목록을 불러오지 못했습니다.', ephemeral: true }).catch(() => {});
                }
                return;
            }

            if (cid === 'panel:portfolio:delete:other') {
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    const rows = await listUserAccounts(discordUserId);
                    if (!rows.length) {
                        await interaction.reply({
                            content: '등록된 계좌가 없습니다.',
                            ephemeral: true
                        });
                        return;
                    }
                    const select = new StringSelectMenuBuilder()
                        .setCustomId('select:portfolio:sell')
                        .setPlaceholder('매도할 계좌')
                        .addOptions(
                            rows.slice(0, 25).map(a =>
                                new StringSelectMenuOptionBuilder()
                                    .setLabel(`${a.account_name} (${accountTypeLabelKo(a.account_type)})`.slice(0, 100))
                                    .setValue(a.id)
                            )
                        );
                    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
                    await interaction.reply({
                        content: '계좌를 고른 뒤 매도 입력 창이 열립니다.',
                        components: [row],
                        ephemeral: true
                    });
                    logger.info('UI', 'advanced account selector used', { purpose: 'sell' });
                } catch (e: any) {
                    await interaction.reply({ content: '계좌 목록을 불러오지 못했습니다.', ephemeral: true }).catch(() => {});
                }
                return;
            }

            if (cid === 'panel:portfolio:add') {
                pendingBuyAccountId.delete(getDiscordUserId(interaction.user));
                pendingSellAccountId.delete(getDiscordUserId(interaction.user));
                logger.info('UI', 'trade modal opened', { flow: 'buy_default' });
                const modal = new ModalBuilder().setCustomId('modal:portfolio:add').setTitle('➕ 종목 추가 (일반계좌)');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('symbol').setLabel("심볼 (티커)").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('qty').setLabel("수량").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('price').setLabel("평균 매수 단가").setStyle(TextInputStyle.Short))
                );
                await interaction.showModal(modal);
                return;
            }

            if (cid === 'panel:finance:add_expense') {
                const modal = new ModalBuilder().setCustomId('modal:expense:add').setTitle('💸 지출 기록');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('amount').setLabel("금액").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('category').setLabel("카테고리").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('desc').setLabel("상세 설명").setStyle(TextInputStyle.Paragraph).setRequired(false))
                );
                await interaction.showModal(modal);
                return;
            }

            if (cid === 'panel:finance:add_cashflow') {
                logger.info('INTERACTION', 'button click: panel:finance:add_cashflow', { user: interaction.user.tag });
                const modal = new ModalBuilder().setCustomId('modal:cashflow:add').setTitle('💰 현금흐름 입력');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('flow_type').setLabel("종류 (income/saving/investment/fixed_expense 등)").setStyle(TextInputStyle.Short)),
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

            if (cid === 'panel:portfolio:view' || cid === 'panel:portfolio:view:all') {
                const isAll = cid === 'panel:portfolio:view:all';
                const discordUserId = getDiscordUserId(interaction.user);
                try {
                    await runPortfolioQueryFromButton(
                        interaction,
                        discordUserId,
                        isAll ? 'all' : 'default',
                        { orchestratorCustomId: cid }
                    );
                } catch (e: any) {
                    (interaction as any).__localErrorHandled = true;
                    logger.error('INTERACTION', 'portfolio view local catch', {
                        message: e?.message,
                        stack: e?.stack,
                        customId: interaction.customId,
                        interactionUserId: interaction.user.id
                    });
                    if (interaction.deferred || interaction.replied) {
                        await safeEditReply(interaction, '포트폴리오 조회 처리 중 오류가 발생했습니다.', 'panel:portfolio:view:exception');
                    } else {
                        await safeReplyOrFollowUp(interaction, { content: '포트폴리오 조회 처리 중 오류가 발생했습니다.', flags: 64 }, 'panel:portfolio:view:exception_unacked');
                    }
                }
                return;
            }

            if (cid === 'panel:portfolio:delete') {
                pendingBuyAccountId.delete(getDiscordUserId(interaction.user));
                pendingSellAccountId.delete(getDiscordUserId(interaction.user));
                logger.info('UI', 'trade modal opened', { flow: 'sell_default' });
                const modal = new ModalBuilder().setCustomId('modal:portfolio:delete').setTitle('➖ 종목 매도 (일반계좌)');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder().setCustomId('symbol').setLabel('심볼 (티커)').setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('qty')
                            .setLabel('매도 수량 (비우면 전량)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    ),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('sell_price')
                            .setLabel('매도 단가 (비우면 평단가)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    )
                );
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
            const discordUserId = getDiscordUserId(interaction.user);
            updateHealth(s => {
                s.interactions.lastInteractionAt = new Date().toISOString();
                s.interactions.lastInteractionType = 'string_select';
                s.interactions.lastCustomId = sid;
            });

            if (sid === 'select:portfolio:account') {
                const accountId = interaction.values[0];
                try {
                    await runPortfolioQueryFromAccountSelect(interaction, discordUserId, accountId);
                } catch (e: any) {
                    logger.error('INTERACTION', 'select portfolio account failed', e);
                    await interaction.editReply({ content: '조회 중 오류가 발생했습니다.', components: [] }).catch(() => {});
                }
                return;
            }

            if (sid === 'select:portfolio:buy') {
                const accountId = interaction.values[0];
                pendingBuyAccountId.set(discordUserId, accountId);
                logger.info('UI', 'trade modal opened', { flow: 'buy_advanced' });
                const modal = new ModalBuilder().setCustomId('modal:portfolio:add').setTitle('➕ 종목 추가 (선택 계좌)');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('symbol').setLabel("심볼 (티커)").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('qty').setLabel("수량").setStyle(TextInputStyle.Short)),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('price').setLabel("평균 매수 단가").setStyle(TextInputStyle.Short))
                );
                await interaction.showModal(modal);
                return;
            }

            if (sid === 'select:portfolio:sell') {
                const accountId = interaction.values[0];
                pendingSellAccountId.set(discordUserId, accountId);
                logger.info('UI', 'trade modal opened', { flow: 'sell_advanced' });
                const modal = new ModalBuilder().setCustomId('modal:portfolio:delete').setTitle('➖ 종목 매도 (선택 계좌)');
                modal.addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder().setCustomId('symbol').setLabel('심볼 (티커)').setStyle(TextInputStyle.Short)
                    ),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('qty')
                            .setLabel('매도 수량 (비우면 전량)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    ),
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId('sell_price')
                            .setLabel('매도 단가 (비우면 평단가)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(false)
                    )
                );
                await interaction.showModal(modal);
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

            if (cid === 'modal:portfolio:add') {
                logger.info('INTERACTION', 'handler branch entered', {
                    interactionId: interaction.id,
                    customId: interaction.customId
                });
                await safeDeferReply(interaction, { flags: 64 });
                try {
                    const rawInput = interaction.fields.getTextInputValue('symbol');
                    const resolved = resolveInstrumentMetadata(rawInput, undefined);
                    const symbol = resolved?.symbol || normalizeSymbol(rawInput);
                    const displayName = resolved?.displayName || rawInput;
                    const quoteSymbol = resolved?.quoteSymbol || symbol;
                    const exchange = resolved?.exchange || null;
                    const market = (resolved?.market === 'US' ? 'US' : 'KR') as 'KR' | 'US';
                    const currency = (resolved?.currency === 'USD' ? 'USD' : 'KRW') as 'KRW' | 'USD';
                    const qty = parsePositiveAmount(interaction.fields.getTextInputValue('qty'));
                    const price = parsePositiveAmount(interaction.fields.getTextInputValue('price'));
                    if (!qty || !price) {
                        await safeEditReply(interaction, "❌ 수량과 평단가는 0보다 큰 숫자여야 합니다.", 'modal:portfolio:add:validation_failure');
                        return;
                    }
                    const discordUserId = getDiscordUserId(interaction.user);
                    logger.info('PORTFOLIO', 'portfolio upsert requested', {
                        interactionId: interaction.id,
                        discordUserId,
                        username: interaction.user.username,
                        symbol,
                        quantity: qty,
                        avgPurchasePrice: price
                    });
                    logger.info('PORTFOLIO', 'trade buy payload', {
                        discordUserId,
                        symbol,
                        market,
                        currency,
                        quantity: qty,
                        pricePerUnit: price
                    });

                    await supabase.from('stocks').upsert({ symbol, name: displayName, sector: 'Unknown' });
                    const buyOverride = pendingBuyAccountId.get(discordUserId);
                    if (buyOverride) pendingBuyAccountId.delete(discordUserId);
                    const accountsForLabel = await listUserAccounts(discordUserId);
                    const accLabel =
                        buyOverride != null
                            ? accountsForLabel.find(a => a.id === buyOverride)?.account_name ?? '선택 계좌'
                            : GENERAL_ACCOUNT_NAME;

                    await recordBuyTrade({
                        discordUserId,
                        accountId: buyOverride,
                        symbol,
                        displayName,
                        quoteSymbol,
                        exchange,
                        market,
                        currency,
                        purchaseCurrency: market === 'US' ? (currency === 'USD' ? 'USD' : 'KRW') : 'KRW',
                        quantity: qty,
                        pricePerUnit: price,
                        fee: 0,
                        memo: 'modal:portfolio:add'
                    });
                    logger.info('PORTFOLIO', 'portfolio upsert completed', {
                        discordUserId,
                        symbol
                    });
                    void learnBehaviorFromTrades(discordUserId);
                    await safeEditReply(
                        interaction,
                        `✅ **${accLabel}**에 반영됨\n**${displayName}** · ${qty}주 · 단가 ${price}\n거래 기록 저장됨`,
                        'modal:portfolio:add:success'
                    );
                    logger.info('PORTFOLIO', 'portfolio upsert success response sent', {
                        discordUserId: interaction.user.id,
                        symbol
                    });
                    logger.info('INTERACTION', 'handler branch returning', {
                        interactionId: interaction.id,
                        customId: interaction.customId
                    });
                    return;
                } catch (e: any) {
                    logger.error('PORTFOLIO', 'portfolio upsert error response sent', {
                        discordUserId: interaction.user.id,
                        symbol: normalizeSymbol(interaction.fields.getTextInputValue('symbol')),
                        message: e?.message || String(e)
                    });
                    await safeEditReply(interaction, `❌ 저장 실패: ${e?.message || 'unknown error'}`, 'modal:portfolio:add:exception');
                    return;
                }
            }

            if (cid === 'modal:portfolio:delete') {
                await safeDeferReply(interaction, { flags: 64 });
                try {
                    const symbol = normalizeSymbol(interaction.fields.getTextInputValue('symbol'));
                    const qtyRaw = (interaction.fields.getTextInputValue('qty') || '').trim();
                    const priceRaw = (interaction.fields.getTextInputValue('sell_price') || '').trim();
                    const discordUserId = getDiscordUserId(interaction.user);

                    const sellOverride = pendingSellAccountId.get(discordUserId);
                    if (sellOverride) pendingSellAccountId.delete(discordUserId);

                    const found = sellOverride
                        ? await findPortfolioRowInAccount(discordUserId, symbol, sellOverride)
                        : await findPortfolioRowForSymbol(discordUserId, symbol);
                    if (!found) {
                        logger.warn('PORTFOLIO', 'sell target not found', { discordUserId, symbol });
                        await safeEditReply(interaction, '해당 심볼은 현재 등록되어 있지 않습니다.', 'modal:portfolio:delete:not_found');
                        return;
                    }

                    const maxQty = Number(found.row.quantity || 0);
                    if (!Number.isFinite(maxQty) || maxQty <= 0) {
                        await safeEditReply(interaction, '보유 수량이 없습니다.', 'modal:portfolio:delete:empty');
                        return;
                    }
                    let finalQty: number;
                    if (qtyRaw) {
                        const pq = parsePositiveAmount(qtyRaw);
                        if (pq === null) {
                            await safeEditReply(interaction, '매도 수량은 0보다 큰 숫자여야 합니다.', 'modal:portfolio:delete:bad_qty');
                            return;
                        }
                        finalQty = pq;
                    } else {
                        finalQty = maxQty;
                    }
                    if (!finalQty || finalQty <= 0 || !Number.isFinite(finalQty)) {
                        await safeEditReply(interaction, '매도 수량을 확인해 주세요.', 'modal:portfolio:delete:bad_qty');
                        return;
                    }
                    if (finalQty > maxQty) {
                        await safeEditReply(interaction, `매도 수량이 보유(${maxQty})를 초과합니다.`, 'modal:portfolio:delete:qty_overflow');
                        return;
                    }

                    const avg = Number(found.row.avg_purchase_price || 0);
                    const sellPrice = priceRaw ? parsePositiveAmount(priceRaw) : avg;
                    if (sellPrice === null || sellPrice <= 0) {
                        await safeEditReply(interaction, '매도 단가를 확인해 주세요.', 'modal:portfolio:delete:bad_price');
                        return;
                    }

                    const { realizedPnlKrw } = await recordSellTrade({
                        discordUserId,
                        accountId: found.accountId,
                        symbol,
                        sellQuantity: finalQty,
                        sellPricePerUnit: sellPrice,
                        fee: 0,
                        memo: 'modal:portfolio:delete'
                    });
                    void learnBehaviorFromTrades(discordUserId);

                    const { count } = await supabase
                        .from('portfolio')
                        .select('id', { count: 'exact', head: true })
                        .or(`discord_user_id.eq.${discordUserId},user_id.eq.${discordUserId}`);

                    logger.info('PORTFOLIO', 'portfolio sell completed', {
                        discordUserId,
                        symbol,
                        sellQty: finalQty,
                        realizedPnlKrw,
                        remainPositions: count ?? 0
                    });

                    const accRows = await listUserAccounts(discordUserId);
                    const sellAccName =
                        accRows.find(a => a.id === found.accountId)?.account_name ?? GENERAL_ACCOUNT_NAME;

                    await safeEditReply(
                        interaction,
                        `✅ **${sellAccName}**에서 매도 반영\n**${symbol}** ${finalQty}주 · 실현손익(추정) **${Math.round(realizedPnlKrw).toLocaleString('ko-KR')}원**`,
                        'modal:portfolio:delete:success'
                    );
                } catch (e: any) {
                    logger.error('PORTFOLIO', 'portfolio sell failed', { message: e?.message });
                    await safeEditReply(interaction, `❌ 매도 처리 실패: ${e?.message || 'unknown'}`, 'modal:portfolio:delete:failure');
                }
                return;
            }

            if (cid === 'modal:expense:add') {
                await safeDeferReply(interaction, { flags: 64 });
                const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
                const category = interaction.fields.getTextInputValue('category');
                const desc = sanitizeDescription(interaction.fields.getTextInputValue('desc'));
                if (!amount) {
                    await safeEditReply(interaction, "입력값을 확인해주세요. 금액이 올바르지 않습니다.", 'modal:expense:add:validation_failure');
                    return;
                }
                
                const { error } = await supabase.from('expenses').insert({
                    discord_user_id: getDiscordUserId(interaction.user), amount, category, description: desc
                });
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
                    const flowType = normalizeFlowType(flowTypeRaw);
                    const amount = parsePositiveAmount(interaction.fields.getTextInputValue('amount'));
                    const description = sanitizeDescription(interaction.fields.getTextInputValue('desc'));

                    if (!flowType || !amount) {
                        logger.warn('INTERACTION', 'validation failure: modal:cashflow:add', {
                            flowTypeRaw,
                            amountRaw: interaction.fields.getTextInputValue('amount')
                        });
                        await safeEditReply(interaction, "입력값을 확인해주세요. 금액과 유형이 올바르지 않습니다.", 'modal:cashflow:add:validation_failure');
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
