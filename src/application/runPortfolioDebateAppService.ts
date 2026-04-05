import {
  RayDalioAgent,
  JamesSimonsAgent,
  PeterDruckerAgent,
  StanleyDruckenmillerAgent,
  HindenburgAgent
} from '../../agents';
import { buildPortfolioSnapshot } from '../../portfolioService';
import { loadUserProfile, type UserProfile } from '../../profileService';
import { loadPersonaMemory } from '../../personaMemoryService';
import { buildPersonaPromptContext, buildBaseAnalysisContext } from '../../analysisContextService';
import { runAnalysisPipeline } from '../../analysisPipelineService';
import { generateWithPersonaProvider } from '../../llmProviderService';
import type { PersonaKey, PersonaMemory } from '../../analysisTypes';
import { logger, updateHealth } from '../../logger';
import { insertChatHistoryWithLegacyFallback } from '../repositories/chatHistoryRepository';
import {
  asGeminiResult,
  guessAnalysisTypeFromTrigger,
  normalizeProviderOutputForDiscord,
  personaKeyToPersonaName,
  toOpinionSummary
} from '../discord/analysisFormatting';
import {
  EXCLUDED_FROM_PORTFOLIO_FINANCIAL_DISPLAY,
  logPersonaSelectionPolicyApplied
} from '../discord/personaSelectionPolicy';
import { analysisTypeToRouteFamily, logPersonaGroupSelected, logRouteFamilyLocked } from '../policies/personaRoutePolicy';
import {
  buildFinancialCommitteePlan,
  COMMITTEE_SKIPPED_PLACEHOLDER,
  isCommitteeSkippedPlaceholderResponse
} from '../services/committeeCompositionService';
import { computeFinancialPersonaWeights } from '../services/personaWeightService';
import { loadPersonaWeightSignalHints } from '../repositories/personaSignalsRepository';
import { extractClaimsByContract, type ClaimExtractionResult } from '../contracts/claimContract';
import {
  aggregateFeedbackAdjustmentMeta,
  buildCioCalibrationPromptBlock,
  buildFeedbackCalibrationDiscordLine,
  buildFeedbackDecisionSignal,
  type FeedbackDecisionSignal
} from '../services/feedbackDecisionCalibrationService';
import type { DecisionArtifact } from '../contracts/decisionContract';
import { runDecisionEngineAppService } from './runDecisionEngineAppService';
import type { AiExecutionHandle } from '../discord/aiExecution/aiExecutionHandle';
import { assertActiveExecution } from '../discord/aiExecution/aiExecutionAbort';
import { collectPartialResult } from '../discord/aiExecution/aiExecutionHelpers';
import { generateGeminiResponse } from '../../geminiLlmService';
import type { AgentGenCaps, ProviderGenerationResult } from '../../analysisTypes';
import { getModelForTask } from '../../llmProviderService';
import {
  buildPortfolioBaseContext,
  buildPersonaContext,
  buildTaskPrompt,
  compressPersonaOutputsForCio,
  estimateTokensApprox,
  truncateUtf8Chars
} from './promptCompressionPortfolio';

const PORTFOLIO_SEGMENT_META: Partial<Record<PersonaKey, { agentName: string; avatarUrl: string }>> = {
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

const GEM_PERSONA_CAPS: AgentGenCaps = { maxOutputTokens: 480, temperature: 0.35 };
const GEM_CIO_CAPS: AgentGenCaps = { maxOutputTokens: 290, temperature: 0.28 };
const OPENAI_PERSONA_CAPS = { maxOutputTokens: 450, temperature: 0.35 };

export type PortfolioDebateSegment = {
  key: PersonaKey;
  agentName: string;
  avatarUrl: string;
  text: string;
};

export type RunPortfolioDebateAppResult =
  | { status: 'gate_lifestyle' }
  | { status: 'gate_no_portfolio' }
  /** Ray 레이어에서 NO_DATA — 기존 index와 동일하게 사용자 메시지 없이 종료 */
  | { status: 'aborted_silent' }
  | {
      status: 'ok';
      analysisType: string;
      chatHistoryId: number | null;
      orderedKeys: PersonaKey[];
      segments: PortfolioDebateSegment[];
      /** Phase 2 구조화 결정(저장 실패 시 null 가능) */
      decisionArtifact: DecisionArtifact | null;
      /** 피드백 소프트 보정 한 줄(결론 강제 없음) */
      feedbackCalibrationLine: string | null;
    };

function requiresLifestyleAnchorsForTrigger(customId?: string): boolean {
  if (!customId) return false;
  return customId === 'panel:finance:analyze_spending' || customId === 'panel:ai:spending';
}

type PortfolioSnap = Awaited<ReturnType<typeof buildPortfolioSnapshot>>;

async function preparePortfolioFastCommittee(params: {
  userId: string;
  analysisType: string;
  mode: 'SAFE' | 'BALANCED' | 'AGGRESSIVE';
  userQuery: string;
  snapshot: PortfolioSnap;
  profile: UserProfile;
  partialScopeFast: string;
  runMode: 'light' | 'retry_summary';
}) {
  const hints = await loadPersonaWeightSignalHints(params.userId);
  const keys = ['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER', 'CIO'] as const;
  const personaMemoryByKey = new Map<(typeof keys)[number], PersonaMemory>();
  await Promise.all(
    keys.map(async k => {
      const personaMemory = await loadPersonaMemory(params.userId, personaKeyToPersonaName(k));
      personaMemoryByKey.set(k, personaMemory);
    })
  );
  const memories = {
    RAY: personaMemoryByKey.get('RAY') ?? null,
    HINDENBURG: personaMemoryByKey.get('HINDENBURG') ?? null,
    SIMONS: personaMemoryByKey.get('SIMONS') ?? null,
    DRUCKER: personaMemoryByKey.get('DRUCKER') ?? null,
    CIO: personaMemoryByKey.get('CIO') ?? null
  };
  const weightMeta = computeFinancialPersonaWeights({
    userId: params.userId,
    profile: params.profile,
    memories,
    signalHints: hints,
    observability: { analysisType: params.analysisType, routeFamily: 'financial' }
  });
  const committeePlan = buildFinancialCommitteePlan({
    userId: params.userId,
    analysisType: params.analysisType,
    profile: params.profile,
    weightMeta,
    runMode: params.runMode
  });
  const quoteQualityPlain = params.snapshot.summary.quote_quality_note
    ? String(params.snapshot.summary.quote_quality_note)
    : '';
  const profilePromptParts: string[] = [];
  if (params.profile.risk_tolerance) profilePromptParts.push(`risk_tolerance=${params.profile.risk_tolerance}`);
  if (params.profile.investment_style) profilePromptParts.push(`investment_style=${params.profile.investment_style}`);
  if (params.profile.favored_analysis_styles?.length)
    profilePromptParts.push(`favored_analysis_styles=${params.profile.favored_analysis_styles.join(',')}`);
  const profileOneLiner = profilePromptParts.join(' | ').slice(0, 520);
  const modePromptLine = `${params.mode} — SAFE=보수적, BALANCED=중립, AGGRESSIVE=공격적 톤 반영`;
  const compressedBaseCore = buildPortfolioBaseContext({
    mode: modePromptLine,
    userQuery: params.userQuery,
    snapshot: params.snapshot,
    partialScopeBlock: params.partialScopeFast || undefined,
    profileOneLiner: profileOneLiner || undefined,
    quoteQualityBlock: quoteQualityPlain || undefined,
    compressionMode: 'aggressive_compressed'
  });
  const compressedBase = `${compressedBaseCore}\n[ADVISORY_ONLY] 자동 주문·자동 매매 없음. 조언·정보 목적.`;
  const memDir = (k: (typeof keys)[number]) => {
    const personaMemory = personaMemoryByKey.get(k)!;
    return buildPersonaPromptContext({
      personaKey: k,
      personaName: personaKeyToPersonaName(k),
      personaMemory,
      baseContext: {}
    }).memory_directive;
  };
  return { committeePlan, compressedBase, memDir };
}

export async function runPortfolioDebateAppService(params: {
  userId: string;
  userQuery: string;
  triggerCustomId?: string;
  loadUserMode: (id: string) => Promise<'SAFE' | 'BALANCED' | 'AGGRESSIVE'>;
  getFinancialAnchorState: () => Promise<{ hasPortfolio: boolean; hasLifestyle: boolean }>;
  execution?: AiExecutionHandle | null;
  /** timeout 재시도: 경량 위원·짧은 출력 · 요약 재시도(리스크+COO+CIO) */
  fastMode?: 'none' | 'light_summary' | 'short_summary' | 'retry_summary';
  /** 첫 페르소나 완료 시 즉시 UI 전송(피드백 버튼은 최종 루프에서만, 중복 방지용 스킵) */
  onPersonaSegmentReady?: (seg: PortfolioDebateSegment) => void | Promise<void>;
}): Promise<RunPortfolioDebateAppResult> {
  const { userId, userQuery, triggerCustomId } = params;
  const ex = params.execution ?? null;

  try {
    logger.info('AI', 'portfolio debate route selected', { discordUserId: userId });
    const mode = await params.loadUserMode(userId);
    const snapshot = await buildPortfolioSnapshot(userId, { scope: 'ALL' });
    const anchorState = await params.getFinancialAnchorState();
    const hasPortfolio = anchorState.hasPortfolio || snapshot.summary.position_count > 0;

    updateHealth(s => (s.ai.lastRoute = 'financial_debate'));

    if (requiresLifestyleAnchorsForTrigger(triggerCustomId) && !anchorState.hasLifestyle) {
      logger.info('GATE', 'lifestyle_data_required_blocked', { triggerId: triggerCustomId });
      return { status: 'gate_lifestyle' };
    }

    if (!hasPortfolio) {
      logger.info('GATE', 'NO_DATA triggered');
      logger.info('AI', 'Gemini skipped due to NO_DATA');
      updateHealth(s => (s.ai.lastNoDataTriggered = true));
      return { status: 'gate_no_portfolio' };
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

    updateHealth(s => (s.ai.lastNoDataTriggered = false));

    const partialScopeFast =
      hasPortfolio && !anchorState.hasLifestyle
        ? [
            '[분석 범위]',
            '- 현재 등록된 **포트폴리오 스냅샷 기준 부분 분석**이다.',
            '- **생활비 적합성·월 투자여력·현금버퍼 적정성** 등은 지출/현금흐름 데이터 없이 **정밀 판단 불가** — 답변에서 "부분 분석"과 "정밀 분석 불가"를 구분해 명시하라.',
            '- 지출·현금흐름을 입력하면 위 항목을 정밀화할 수 있다.'
          ].join('\n')
        : '';

    assertActiveExecution(ex, 'portfolio:post_gate');

    let analysisType = guessAnalysisTypeFromTrigger(triggerCustomId, userQuery);
    if (analysisType === 'open_topic') {
      logger.warn('ROUTE', 'ROUTE_OVERRIDE_BLOCKED', {
        executionId: ex?.executionId,
        from: 'portfolio_financial',
        to: analysisType
      });
      analysisType = 'portfolio_financial';
    }
    ex?.lockAnalysisRoute(analysisType);
    analysisType = ex?.coerceAnalysisRoute(analysisType) ?? analysisType;
    ex?.augmentRetryPayload({
      analysisType,
      portfolioSnapshot: {
        positionCount: snapshot.summary.position_count,
        totalMarketValueKrw: snapshot.summary.total_market_value_krw,
        degradedQuoteMode: snapshot.summary.degraded_quote_mode,
        quoteFailureCount: snapshot.summary.quote_failure_count ?? 0
      }
    });

    if (params.fastMode === 'short_summary') {
      const profile = await loadUserProfile(userId);
      const hintsShort = await loadPersonaWeightSignalHints(userId);
      const memKeysShort = ['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER', 'CIO'] as const;
      const pmShort: Partial<Record<PersonaKey, PersonaMemory>> = {};
      await Promise.all(
        memKeysShort.map(async k => {
          pmShort[k] = await loadPersonaMemory(userId, personaKeyToPersonaName(k));
        })
      );
      const weightMetaShort = computeFinancialPersonaWeights({
        userId,
        profile,
        memories: {
          RAY: pmShort.RAY ?? null,
          HINDENBURG: pmShort.HINDENBURG ?? null,
          SIMONS: pmShort.SIMONS ?? null,
          DRUCKER: pmShort.DRUCKER ?? null,
          CIO: pmShort.CIO ?? null
        },
        signalHints: hintsShort,
        observability: { analysisType, routeFamily: 'financial' }
      });
      buildFinancialCommitteePlan({
        userId,
        analysisType,
        profile,
        weightMeta: weightMetaShort,
        runMode: 'short'
      });
      const partialSeg =
        ex?.partialSegments?.length ?
          `${ex.partialSegments.map(s => `${s.persona}: ${s.excerpt}`).join('\n')}\n`
        : '';
      const compressed = buildPortfolioBaseContext({
        mode,
        userQuery,
        snapshot,
        partialScopeBlock: partialScopeFast || undefined,
        profileOneLiner: undefined,
        quoteQualityBlock: snapshot.summary.quote_quality_note || undefined,
        compressionMode: 'aggressive_compressed'
      });
      const prompt = `${buildTaskPrompt('retry_summary')}\n[FAST_SUMMARY_ONLY]\n${partialSeg ? `[PRIOR_PARTIAL]\n${partialSeg}` : ''}${compressed}`;
      assertActiveExecution(ex, 'portfolio:short:pre_llm');
      const raw = await generateGeminiResponse({
        model: getModelForTask('RETRY_LIGHT'),
        prompt,
        maxOutputTokens: 240,
        temperature: 0.35
      });
      assertActiveExecution(ex, 'portfolio:short:post_llm');
      const summaryText = normalizeProviderOutputForDiscord({
        text: raw.text || '',
        provider: 'gemini',
        personaKey: 'CIO'
      });
      collectPartialResult(ex, 'Stanley Druckenmiller (CIO) · 요약', summaryText);
      const chatHistoryPayload: Record<string, unknown> = {
        user_id: userId,
        user_query: userQuery,
        ray_advice: null,
        jyp_insight: null,
        simons_opportunity: null,
        drucker_decision: null,
        cio_decision: summaryText,
        jyp_weekly_report: null,
        summary: toOpinionSummary(summaryText, 800),
        key_risks: null,
        key_actions: null
      };
      const chatHistoryId = await insertChatHistoryWithLegacyFallback(chatHistoryPayload, true);
      assertActiveExecution(ex, 'portfolio:short:post_insert');
      ex?.setPerfMetrics({
        compressed_prompt_mode: 'aggressive_compressed',
        retry_mode_used: 'short_summary',
        persona_parallel_wall_time_ms: 0,
        prompt_build_time_ms: null,
        cio_stage_time_ms: null
      });
      if (chatHistoryId) {
        const baseContext = buildBaseAnalysisContext({
          discordUserId: userId,
          analysisType,
          userQuery,
          mode,
          userProfile: profile,
          snapshotSummary: snapshot.summary,
          snapshotPositionsCount: snapshot.positions.length,
          partialScope: partialScopeFast || undefined
        });
        await runAnalysisPipeline({
          discordUserId: userId,
          chatHistoryId,
          analysisType,
          personaOutputs: [
            {
              personaKey: 'CIO',
              personaName: personaKeyToPersonaName('CIO'),
              responseText: summaryText,
              providerName: 'gemini',
              modelName: raw.model || getModelForTask('RETRY_LIGHT')
            }
          ],
          baseContext
        });
      }
      return {
        status: 'ok',
        analysisType,
        chatHistoryId,
        orderedKeys: ['CIO'],
        segments: [
          {
            key: 'CIO',
            agentName: 'Stanley Druckenmiller (CIO) · 요약',
            avatarUrl: PORTFOLIO_SEGMENT_META.CIO!.avatarUrl,
            text: summaryText
          }
        ],
        decisionArtifact: null,
        feedbackCalibrationLine: null
      };
    }

    if (params.fastMode === 'retry_summary') {
      const profile = await loadUserProfile(userId);
      const { committeePlan, compressedBase, memDir } = await preparePortfolioFastCommittee({
        userId,
        analysisType,
        mode,
        userQuery,
        snapshot,
        profile,
        partialScopeFast,
        runMode: 'retry_summary'
      });
      const SK = COMMITTEE_SKIPPED_PLACEHOLDER;
      const ray = new RayDalioAgent();
      const hindenburg = new HindenburgAgent();
      const drucker = new PeterDruckerAgent();
      const cio = new StanleyDruckenmillerAgent();
      await Promise.all([
        ray.initializeContext(userId),
        hindenburg.initializeContext(userId),
        drucker.initializeContext(userId),
        cio.initializeContext(userId)
      ]);
      ray.setPortfolioSnapshot(snapshot.positions);
      hindenburg.setPortfolioSnapshot(snapshot.positions);
      drucker.setPortfolioSnapshot(snapshot.positions);
      cio.setPortfolioSnapshot(snapshot.positions);

      const notifyRetrySeg = async (key: PersonaKey, text: string) => {
        const cb = params.onPersonaSegmentReady;
        if (!cb) return;
        const m = PORTFOLIO_SEGMENT_META[key];
        if (!m) return;
        await cb({ key, agentName: m.agentName, avatarUrl: m.avatarUrl, text });
      };

      const runNote = '[RETRY_SUMMARY_COMMITTEE]\n리스크 1인 + COO + CIO. 간결 bullet.\n';
      let rayRes = SK('Ray Dalio (PB)');
      let hindenburgGen: ProviderGenerationResult = {
        text: SK('HINDENBURG_ANALYST'),
        provider: 'gemini',
        model: 'committee-skip'
      };
      let hindenburgRes = hindenburgGen.text;

      if (committeePlan.runRay) {
        const rq = `${runNote}${compressedBase}\n\n${buildPersonaContext({
          personaKey: 'RAY',
          personaBiasDirective: '',
          memoryDirective: memDir('RAY'),
          compressionMode: 'aggressive_compressed'
        })}\n\n${buildTaskPrompt('persona_brevity')}`;
        assertActiveExecution(ex, 'portfolio:retry:pre_ray');
        const rayResRaw = await ray.analyze(rq, false, GEM_PERSONA_CAPS);
        assertActiveExecution(ex, 'portfolio:retry:post_ray');
        rayRes = normalizeProviderOutputForDiscord({ text: rayResRaw, provider: 'gemini', personaKey: 'RAY' });
        collectPartialResult(ex, 'Ray Dalio (PB)', rayRes);
        if (rayRes?.includes('[REASON: NO_DATA]')) {
          return { status: 'aborted_silent' };
        }
        await notifyRetrySeg('RAY', rayRes);
      } else if (committeePlan.runHindenburg) {
        const hq = `${runNote}${compressedBase}\n\n${buildPersonaContext({
          personaKey: 'HINDENBURG',
          personaBiasDirective: '',
          memoryDirective: memDir('HINDENBURG'),
          compressionMode: 'aggressive_compressed'
        })}\n\n${buildTaskPrompt('persona_brevity')}`;
        assertActiveExecution(ex, 'portfolio:retry:pre_hindenburg');
        hindenburgGen = await generateWithPersonaProvider({
          discordUserId: userId,
          personaKey: 'HINDENBURG',
          personaName: personaKeyToPersonaName('HINDENBURG'),
          prompt: hq,
          aiExecution: ex ?? undefined,
          taskType: 'PERSONA_ANALYSIS',
          generation: OPENAI_PERSONA_CAPS,
          parallel_execution_used: false,
          compressed_prompt_used: true,
          fallbackToGemini: async () => asGeminiResult(await hindenburg.analyze(hq, false, GEM_PERSONA_CAPS))
        });
        assertActiveExecution(ex, 'portfolio:retry:post_hindenburg');
        hindenburgRes = normalizeProviderOutputForDiscord({
          text: hindenburgGen.text,
          provider: hindenburgGen.provider,
          personaKey: 'HINDENBURG'
        });
        collectPartialResult(ex, 'HINDENBURG_ANALYST', hindenburgRes);
        await notifyRetrySeg('HINDENBURG', hindenburgRes);
      }

      const riskPeers: { label: string; text: string }[] = [];
      if (committeePlan.runRay) riskPeers.push({ label: 'Ray', text: rayRes });
      if (committeePlan.runHindenburg) riskPeers.push({ label: 'Hindenburg', text: hindenburgRes });

      let druckerRes = SK('Peter Drucker (COO)');
      if (committeePlan.runDrucker) {
        const druckerCombinedLog = `${buildTaskPrompt('persona_brevity')}\n${compressPersonaOutputsForCio(
          riskPeers.length ? riskPeers : [{ label: 'Risk', text: rayRes }],
          340
        )}${memDir('DRUCKER') ? `\n\n[MEMORY]\n${truncateUtf8Chars(memDir('DRUCKER'), 700)}` : ''}`;
        assertActiveExecution(ex, 'portfolio:retry:pre_drucker');
        const druckerResRaw = await drucker.summarizeAndGenerateActions(false, druckerCombinedLog, GEM_PERSONA_CAPS);
        assertActiveExecution(ex, 'portfolio:retry:post_drucker');
        druckerRes = normalizeProviderOutputForDiscord({ text: druckerResRaw, provider: 'gemini', personaKey: 'DRUCKER' });
        collectPartialResult(ex, 'Peter Drucker (COO)', druckerRes);
        await notifyRetrySeg('DRUCKER', druckerRes);
      }

      const cioPeers = [...riskPeers, { label: 'Drucker', text: druckerRes }];
      const tCioRetry = Date.now();
      assertActiveExecution(ex, 'portfolio:retry:pre_cio');
      const cioResRaw = await cio.decide(
        false,
        `${buildTaskPrompt('persona_brevity')}\n[RETRY_SUMMARY_CIO]\n${compressPersonaOutputsForCio(cioPeers, 900)}${memDir('CIO') ? `\n\n[MEMORY]\n${truncateUtf8Chars(memDir('CIO'), 500)}` : ''}`,
        GEM_CIO_CAPS
      );
      assertActiveExecution(ex, 'portfolio:retry:post_cio');
      const cioRes = normalizeProviderOutputForDiscord({ text: cioResRaw, provider: 'gemini', personaKey: 'CIO' });
      collectPartialResult(ex, 'Stanley Druckenmiller (CIO)', cioRes);
      await notifyRetrySeg('CIO', cioRes);

      ex?.setPerfMetrics({
        compressed_prompt_mode: 'aggressive_compressed',
        retry_mode_used: 'retry_summary',
        persona_parallel_wall_time_ms: 0,
        prompt_build_time_ms: null,
        cio_stage_time_ms: Date.now() - tCioRetry
      });

      const chatHistoryPayload: Record<string, unknown> = {
        user_id: userId,
        user_query: userQuery,
        ray_advice: committeePlan.runRay ? rayRes : null,
        jyp_insight: null,
        simons_opportunity: null,
        drucker_decision: druckerRes,
        cio_decision: cioRes,
        jyp_weekly_report: null,
        summary: toOpinionSummary(cioRes, 900),
        key_risks: committeePlan.runHindenburg
          ? toOpinionSummary(hindenburgRes, 1200)
          : committeePlan.runRay
            ? toOpinionSummary(rayRes, 800)
            : null,
        key_actions: toOpinionSummary(druckerRes, 800)
      };
      const chatHistoryId = await insertChatHistoryWithLegacyFallback(chatHistoryPayload, true);
      assertActiveExecution(ex, 'portfolio:retry:post_insert');

      const personaOutputsRetry: Array<{
        personaKey: PersonaKey;
        personaName: string;
        responseText: string;
        providerName?: string;
        modelName?: string;
        estimatedCostUsd?: number;
      }> = [];
      if (committeePlan.runRay) {
        personaOutputsRetry.push({
          personaKey: 'RAY',
          personaName: personaKeyToPersonaName('RAY'),
          responseText: rayRes,
          providerName: 'gemini',
          modelName: 'gemini-2.5-flash'
        });
      }
      if (committeePlan.runHindenburg) {
        personaOutputsRetry.push({
          personaKey: 'HINDENBURG',
          personaName: personaKeyToPersonaName('HINDENBURG'),
          responseText: hindenburgRes,
          providerName: hindenburgGen.provider,
          modelName: hindenburgGen.model,
          estimatedCostUsd: hindenburgGen.estimated_cost_usd
        });
      }
      if (committeePlan.runDrucker) {
        personaOutputsRetry.push({
          personaKey: 'DRUCKER',
          personaName: personaKeyToPersonaName('DRUCKER'),
          responseText: druckerRes,
          providerName: 'gemini',
          modelName: 'gemini-2.5-flash'
        });
      }
      personaOutputsRetry.push({
        personaKey: 'CIO',
        personaName: personaKeyToPersonaName('CIO'),
        responseText: cioRes,
        providerName: 'gemini',
        modelName: 'gemini-2.5-flash'
      });

      if (chatHistoryId) {
        const baseContext = buildBaseAnalysisContext({
          discordUserId: userId,
          analysisType,
          userQuery,
          mode,
          userProfile: profile,
          snapshotSummary: snapshot.summary,
          snapshotPositionsCount: snapshot.positions.length,
          partialScope: partialScopeFast || undefined
        });
        await runAnalysisPipeline({
          discordUserId: userId,
          chatHistoryId,
          analysisType,
          personaOutputs: personaOutputsRetry,
          baseContext
        });
      }

      const orderedKeysRetry: PersonaKey[] = ([] as PersonaKey[])
        .concat(committeePlan.runRay ? (['RAY'] as const) : [])
        .concat(committeePlan.runHindenburg ? (['HINDENBURG'] as const) : [])
        .concat(committeePlan.runDrucker ? (['DRUCKER'] as const) : [])
        .concat(['CIO'] as const);

      const resultByKeyRetry: Record<PersonaKey, string> = {
        RAY: rayRes,
        HINDENBURG: hindenburgRes,
        SIMONS: '',
        DRUCKER: druckerRes,
        CIO: cioRes,
        JYP: '',
        TREND: '',
        OPEN_TOPIC: '',
        THIEL: '',
        HOT_TREND: ''
      };
      const segmentsRetry: PortfolioDebateSegment[] = [];
      for (const k of orderedKeysRetry) {
        const meta = PORTFOLIO_SEGMENT_META[k];
        if (!meta) continue;
        segmentsRetry.push({ key: k, agentName: meta.agentName, avatarUrl: meta.avatarUrl, text: resultByKeyRetry[k] });
      }

      return {
        status: 'ok',
        analysisType,
        chatHistoryId,
        orderedKeys: orderedKeysRetry,
        segments: segmentsRetry,
        decisionArtifact: null,
        feedbackCalibrationLine: null
      };
    }

    if (params.fastMode === 'light_summary') {
      const profile = await loadUserProfile(userId);
      const { committeePlan, compressedBase, memDir } = await preparePortfolioFastCommittee({
        userId,
        analysisType,
        mode,
        userQuery,
        snapshot,
        profile,
        partialScopeFast,
        runMode: 'light'
      });
      const SK = COMMITTEE_SKIPPED_PLACEHOLDER;
      const ray = new RayDalioAgent();
      const hindenburg = new HindenburgAgent();
      const cio = new StanleyDruckenmillerAgent();
      await Promise.all([
        ray.initializeContext(userId),
        hindenburg.initializeContext(userId),
        cio.initializeContext(userId)
      ]);
      ray.setPortfolioSnapshot(snapshot.positions);
      hindenburg.setPortfolioSnapshot(snapshot.positions);
      cio.setPortfolioSnapshot(snapshot.positions);

      const notifyLightSeg = async (key: PersonaKey, text: string) => {
        const cb = params.onPersonaSegmentReady;
        if (!cb) return;
        const m = PORTFOLIO_SEGMENT_META[key];
        if (!m) return;
        await cb({ key, agentName: m.agentName, avatarUrl: m.avatarUrl, text });
      };

      const lightNote = '[LIGHT_COMMITTEE_RETRY]\n가중치 기반 리스크 1인 + CIO. 핵심 bullet.\n';
      let rayRes = SK('Ray Dalio (PB)');
      let hindenburgGenLight: ProviderGenerationResult = {
        text: SK('HINDENBURG_ANALYST'),
        provider: 'gemini',
        model: 'committee-skip'
      };
      let hindenburgRes = hindenburgGenLight.text;

      if (committeePlan.runRay) {
        const rayQuery = `${lightNote}${compressedBase}\n\n${buildPersonaContext({
          personaKey: 'RAY',
          personaBiasDirective: '',
          memoryDirective: memDir('RAY'),
          compressionMode: 'aggressive_compressed'
        })}\n\n${buildTaskPrompt('persona_brevity')}`;
        assertActiveExecution(ex, 'portfolio:light:pre_ray');
        const rayResRaw = await ray.analyze(rayQuery, false, GEM_PERSONA_CAPS);
        assertActiveExecution(ex, 'portfolio:light:post_ray');
        rayRes = normalizeProviderOutputForDiscord({ text: rayResRaw, provider: 'gemini', personaKey: 'RAY' });
        collectPartialResult(ex, 'Ray Dalio (PB)', rayRes);
        if (rayRes?.includes('[REASON: NO_DATA]')) {
          return { status: 'aborted_silent' };
        }
        await notifyLightSeg('RAY', rayRes);
      } else if (committeePlan.runHindenburg) {
        const hq = `${lightNote}${compressedBase}\n\n${buildPersonaContext({
          personaKey: 'HINDENBURG',
          personaBiasDirective: '',
          memoryDirective: memDir('HINDENBURG'),
          compressionMode: 'aggressive_compressed'
        })}\n\n${buildTaskPrompt('persona_brevity')}`;
        assertActiveExecution(ex, 'portfolio:light:pre_hindenburg');
        hindenburgGenLight = await generateWithPersonaProvider({
          discordUserId: userId,
          personaKey: 'HINDENBURG',
          personaName: personaKeyToPersonaName('HINDENBURG'),
          prompt: hq,
          aiExecution: ex ?? undefined,
          taskType: 'PERSONA_ANALYSIS',
          generation: OPENAI_PERSONA_CAPS,
          parallel_execution_used: false,
          compressed_prompt_used: true,
          fallbackToGemini: async () => asGeminiResult(await hindenburg.analyze(hq, false, GEM_PERSONA_CAPS))
        });
        assertActiveExecution(ex, 'portfolio:light:post_hindenburg');
        hindenburgRes = normalizeProviderOutputForDiscord({
          text: hindenburgGenLight.text,
          provider: hindenburgGenLight.provider,
          personaKey: 'HINDENBURG'
        });
        collectPartialResult(ex, 'HINDENBURG_ANALYST', hindenburgRes);
        await notifyLightSeg('HINDENBURG', hindenburgRes);
      }

      const riskPeersLight: { label: string; text: string }[] = [];
      if (committeePlan.runRay) riskPeersLight.push({ label: 'Ray', text: rayRes });
      if (committeePlan.runHindenburg) riskPeersLight.push({ label: 'Hindenburg', text: hindenburgRes });

      const tCioLight = Date.now();
      const cioResRaw = await cio.decide(
        false,
        `${buildTaskPrompt('persona_brevity')}\n[LIGHT_PATH]\n${compressPersonaOutputsForCio(
          riskPeersLight.length ? riskPeersLight : [{ label: 'Risk', text: rayRes }],
          900
        )}${memDir('CIO') ? `\n\n[MEMORY]\n${truncateUtf8Chars(memDir('CIO'), 500)}` : ''}`,
        GEM_CIO_CAPS
      );
      assertActiveExecution(ex, 'portfolio:light:post_cio');
      const cioRes = normalizeProviderOutputForDiscord({ text: cioResRaw, provider: 'gemini', personaKey: 'CIO' });
      collectPartialResult(ex, 'Stanley Druckenmiller (CIO)', cioRes);
      await notifyLightSeg('CIO', cioRes);
      ex?.setPerfMetrics({
        compressed_prompt_mode: 'aggressive_compressed',
        retry_mode_used: 'light_summary',
        persona_parallel_wall_time_ms: 0,
        prompt_build_time_ms: null,
        cio_stage_time_ms: Date.now() - tCioLight
      });
      const chatHistoryPayload: Record<string, unknown> = {
        user_id: userId,
        user_query: userQuery,
        ray_advice: committeePlan.runRay ? rayRes : null,
        jyp_insight: null,
        simons_opportunity: null,
        drucker_decision: null,
        cio_decision: cioRes,
        jyp_weekly_report: null,
        summary: toOpinionSummary(cioRes, 900),
        key_risks: committeePlan.runHindenburg
          ? toOpinionSummary(hindenburgRes, 1200)
          : committeePlan.runRay
            ? toOpinionSummary(rayRes, 800)
            : null,
        key_actions: null
      };
      const chatHistoryId = await insertChatHistoryWithLegacyFallback(chatHistoryPayload, true);
      assertActiveExecution(ex, 'portfolio:light:post_insert');

      const personaOutputsLight: Array<{
        personaKey: PersonaKey;
        personaName: string;
        responseText: string;
        providerName?: string;
        modelName?: string;
        estimatedCostUsd?: number;
      }> = [];
      if (committeePlan.runRay) {
        personaOutputsLight.push({
          personaKey: 'RAY',
          personaName: personaKeyToPersonaName('RAY'),
          responseText: rayRes,
          providerName: 'gemini',
          modelName: 'gemini-2.5-flash'
        });
      }
      if (committeePlan.runHindenburg) {
        personaOutputsLight.push({
          personaKey: 'HINDENBURG',
          personaName: personaKeyToPersonaName('HINDENBURG'),
          responseText: hindenburgRes,
          providerName: hindenburgGenLight.provider,
          modelName: hindenburgGenLight.model,
          estimatedCostUsd: hindenburgGenLight.estimated_cost_usd
        });
      }
      personaOutputsLight.push({
        personaKey: 'CIO',
        personaName: personaKeyToPersonaName('CIO'),
        responseText: cioRes,
        providerName: 'gemini',
        modelName: 'gemini-2.5-flash'
      });

      if (chatHistoryId) {
        const baseContext = buildBaseAnalysisContext({
          discordUserId: userId,
          analysisType,
          userQuery,
          mode,
          userProfile: profile,
          snapshotSummary: snapshot.summary,
          snapshotPositionsCount: snapshot.positions.length,
          partialScope: partialScopeFast || undefined
        });
        await runAnalysisPipeline({
          discordUserId: userId,
          chatHistoryId,
          analysisType,
          personaOutputs: personaOutputsLight,
          baseContext
        });
      }
      const orderedKeysLight: PersonaKey[] = ([] as PersonaKey[])
        .concat(committeePlan.runRay ? (['RAY'] as const) : [])
        .concat(committeePlan.runHindenburg ? (['HINDENBURG'] as const) : [])
        .concat(['CIO'] as const);
      const resultByKeyLight: Record<PersonaKey, string> = {
        RAY: rayRes,
        HINDENBURG: hindenburgRes,
        SIMONS: '',
        DRUCKER: '',
        CIO: cioRes,
        JYP: '',
        TREND: '',
        OPEN_TOPIC: '',
        THIEL: '',
        HOT_TREND: ''
      };
      const segmentsLight: PortfolioDebateSegment[] = [];
      for (const k of orderedKeysLight) {
        const meta = PORTFOLIO_SEGMENT_META[k];
        if (!meta) continue;
        segmentsLight.push({ key: k, agentName: meta.agentName, avatarUrl: meta.avatarUrl, text: resultByKeyLight[k] });
      }
      return {
        status: 'ok',
        analysisType,
        chatHistoryId,
        orderedKeys: orderedKeysLight,
        segments: segmentsLight,
        decisionArtifact: null,
        feedbackCalibrationLine: null
      };
    }

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
    const quoteQualityPlain = snapshot.summary.quote_quality_note ? String(snapshot.summary.quote_quality_note) : '';
    const partialScope =
      hasPortfolio && !anchorState.hasLifestyle
        ? [
            '[분석 범위]',
            '- 현재 등록된 **포트폴리오 스냅샷 기준 부분 분석**이다.',
            '- **생활비 적합성·월 투자여력·현금버퍼 적정성** 등은 지출/현금흐름 데이터 없이 **정밀 판단 불가** — 답변에서 "부분 분석"과 "정밀 분석 불가"를 구분해 명시하라.',
            '- 지출·현금흐름을 입력하면 위 항목을 정밀화할 수 있다.'
          ].join('\n')
        : '';

    const tPromptStart = Date.now();
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
    if (profile.favored_analysis_styles?.length)
      profilePromptParts.push(`favored_analysis_styles=${profile.favored_analysis_styles.join(',')}`);
    if (profile.preferred_personas?.length)
      profilePromptParts.push(`preferred_personas=${profile.preferred_personas.join(',')}`);
    if (profile.avoided_personas?.length) profilePromptParts.push(`avoided_personas=${profile.avoided_personas.join(',')}`);
    if (profile.personalization_notes) profilePromptParts.push(`personalization_notes=${profile.personalization_notes}`);

    const profileOneLiner = profilePromptParts.join(' | ').slice(0, 520);
    const modePromptLine = `${mode} — SAFE=보수적, BALANCED=중립, AGGRESSIVE=공격적 톤 반영`;

    const favored = profile.favored_analysis_styles || [];
    const styleDirectives: string[] = [];
    if (favored.includes('risk-heavy') || favored.includes('risk-focused')) {
      styleDirectives.push(
        '[STYLE:risk-heavy]\n- 모든 페르소나는 먼저 DOWNside(최악/리스크) 시나리오를 제시하고, 그 다음에 구조/대응/관측지표로 이어가라.'
      );
    }
    if (favored.includes('data-driven') || favored.includes('numeric-centric')) {
      styleDirectives.push(
        '[STYLE:data-driven]\n- 모든 페르소나는 가능한 한 수치/확률/구간(예: ~범위, %가능성)을 최소 1개 이상 포함해라.'
      );
    }
    if (favored.includes('action-oriented') || favored.includes('execution-oriented')) {
      styleDirectives.push('[STYLE:action-oriented]\n- 모든 페르소나는 결론 말미에 반드시 실행 체크리스트(3개 이하)를 제공하라.');
    }
    const styleDirectiveBlock = styleDirectives.length ? `\n\n[FAVORED_ANALYSIS_STYLES]\n${styleDirectives.join('\n')}` : '';

    const preferredNamesForBias = (profile.preferred_personas || []).filter(
      n => !EXCLUDED_FROM_PORTFOLIO_FINANCIAL_DISPLAY.has(n)
    );
    const avoidedNamesForBias = profile.avoided_personas || [];
    logPersonaSelectionPolicyApplied({
      analysisType: 'portfolio_financial',
      excluded_entertainment_from_bias: true,
      preferred_count: preferredNamesForBias.length
    });
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

    const memoryKeys: PersonaKey[] = ['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER', 'CIO'];
    const memoryByKey = new Map<PersonaKey, string>();
    const personaMemoryByKey = new Map<PersonaKey, PersonaMemory>();
    await Promise.all(
      memoryKeys.map(async k => {
        const personaName = personaKeyToPersonaName(k);
        const personaMemory = await loadPersonaMemory(userId, personaName);
        personaMemoryByKey.set(k, personaMemory);
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

    logRouteFamilyLocked({
      routeFamily: analysisTypeToRouteFamily(analysisType),
      analysisType,
      discordUserId: userId
    });
    logPersonaGroupSelected({
      analysisType,
      personaGroup: 'FINANCIAL',
      discordUserId: userId,
      note: 'trend_k_culture_personas_excluded_by_policy'
    });

    const signalHintsFull = await loadPersonaWeightSignalHints(userId);
    const weightMeta = computeFinancialPersonaWeights({
      userId,
      profile,
      memories: {
        RAY: personaMemoryByKey.get('RAY') ?? null,
        HINDENBURG: personaMemoryByKey.get('HINDENBURG') ?? null,
        SIMONS: personaMemoryByKey.get('SIMONS') ?? null,
        DRUCKER: personaMemoryByKey.get('DRUCKER') ?? null,
        CIO: personaMemoryByKey.get('CIO') ?? null
      },
      signalHints: signalHintsFull,
      observability: { analysisType, routeFamily: 'financial' }
    });
    const committeePlan = buildFinancialCommitteePlan({
      userId,
      analysisType,
      profile,
      weightMeta,
      runMode: 'full'
    });
    const SK = COMMITTEE_SKIPPED_PLACEHOLDER;

    const precomputedDruckerPreamble = `${personaBiasDirective('DRUCKER')}${styleDirectiveBlock}\n${buildTaskPrompt('persona_brevity')}`;
    const precomputedCioStyleBlock = `${personaBiasDirective('CIO')}${styleDirectiveBlock}`;
    const advisoryOnlyLine = '[ADVISORY_ONLY] 자동 주문·자동 매매 없음. 조언·정보 목적.';

    const compressedBaseCore = buildPortfolioBaseContext({
      mode: modePromptLine,
      userQuery,
      snapshot,
      partialScopeBlock: partialScope || undefined,
      profileOneLiner: profileOneLiner || undefined,
      quoteQualityBlock: quoteQualityPlain || undefined,
      styleDirectiveBlock: styleDirectiveBlock || undefined,
      compressionMode: 'standard_compressed'
    });
    const compressedBase = `${compressedBaseCore}\n${advisoryOnlyLine}`;
    const prompt_build_time_ms = Date.now() - tPromptStart;

    const perfCommitteeStart = Date.now();
    const notifySeg = async (key: PersonaKey, text: string) => {
      const cb = params.onPersonaSegmentReady;
      if (!cb) return;
      const m = PORTFOLIO_SEGMENT_META[key];
      if (!m) return;
      await cb({ key, agentName: m.agentName, avatarUrl: m.avatarUrl, text });
    };

    const runRayExec = async (): Promise<string> => {
      const t0 = Date.now();
      const rq = `${compressedBase}\n\n${buildPersonaContext({
        personaKey: 'RAY',
        personaBiasDirective: personaBiasDirective('RAY'),
        memoryDirective: rayMemory,
        compressionMode: 'standard_compressed'
      })}\n\n${buildTaskPrompt('persona')}`;
      assertActiveExecution(ex, 'portfolio:pre_ray');
      const rayResRaw = await ray.analyze(rq, false, GEM_PERSONA_CAPS);
      assertActiveExecution(ex, 'portfolio:post_ray');
      const out = normalizeProviderOutputForDiscord({ text: rayResRaw, provider: 'gemini', personaKey: 'RAY' });
      collectPartialResult(ex, 'Ray Dalio (PB)', out);
      logger.info('AI_PERF', 'persona_execution_time', {
        persona: 'RAY',
        ms: Date.now() - t0,
        parallel_execution_used: committeePlan.runHindenburg,
        compressed_prompt_used: true,
        model_used: 'gemini-2.5-flash',
        prompt_token_estimate: estimateTokensApprox(rq.length)
      });
      if (!out?.includes('[REASON: NO_DATA]')) {
        await notifySeg('RAY', out);
      }
      return out;
    };

    const runHindExec = async (): Promise<{ hindenburgGen: ProviderGenerationResult; hindenburgRes: string }> => {
      const t0 = Date.now();
      const hq = `${compressedBase}\n\n${buildPersonaContext({
        personaKey: 'HINDENBURG',
        personaBiasDirective: personaBiasDirective('HINDENBURG'),
        memoryDirective: hindenburgMemory,
        compressionMode: 'standard_compressed'
      })}\n\n${buildTaskPrompt('persona')}`;
      assertActiveExecution(ex, 'portfolio:pre_hindenburg');
      const hindGen = await generateWithPersonaProvider({
        discordUserId: userId,
        personaKey: 'HINDENBURG',
        personaName: personaKeyToPersonaName('HINDENBURG'),
        prompt: hq,
        aiExecution: ex ?? undefined,
        taskType: 'PERSONA_ANALYSIS',
        generation: OPENAI_PERSONA_CAPS,
        parallel_execution_used: committeePlan.runRay,
        compressed_prompt_used: true,
        fallbackToGemini: async () => asGeminiResult(await hindenburg.analyze(hq, false, GEM_PERSONA_CAPS))
      });
      assertActiveExecution(ex, 'portfolio:post_hindenburg');
      const hindRes = normalizeProviderOutputForDiscord({
        text: hindGen.text,
        provider: hindGen.provider,
        personaKey: 'HINDENBURG'
      });
      collectPartialResult(ex, 'HINDENBURG_ANALYST', hindRes);
      logger.info('AI_PERF', 'persona_execution_time', {
        persona: 'HINDENBURG',
        ms: Date.now() - t0,
        parallel_execution_used: committeePlan.runRay,
        compressed_prompt_used: true,
        model_used: hindGen.model,
        prompt_token_estimate: estimateTokensApprox(hq.length),
        response_token_estimate: hindGen.usage?.output_tokens ?? Math.ceil((hindGen.text || '').length / 4)
      });
      await notifySeg('HINDENBURG', hindRes);
      return { hindenburgGen: hindGen, hindenburgRes: hindRes };
    };

    const tParallelWallStart = Date.now();
    let persona_parallel_wall_time_ms = 0;
    let rayRes: string;
    let hindenburgGen: ProviderGenerationResult;
    let hindenburgRes: string;

    if (committeePlan.runRay && committeePlan.runHindenburg) {
      const [rayOutcome, hindOutcome] = await Promise.allSettled([runRayExec(), runHindExec()]);
      persona_parallel_wall_time_ms = Date.now() - tParallelWallStart;
      if (rayOutcome.status === 'rejected') {
        throw rayOutcome.reason;
      }
      rayRes = rayOutcome.value;
      if (rayRes?.includes('[REASON: NO_DATA]')) {
        logger.warn('AI', 'Ray Dalio aborted due to NO_DATA at logic layer');
        return { status: 'aborted_silent' };
      }
      if (hindOutcome.status === 'fulfilled') {
        hindenburgGen = hindOutcome.value.hindenburgGen;
        hindenburgRes = hindOutcome.value.hindenburgRes;
      } else {
        logger.warn('AI', 'hindenburg_parallel_failed', { message: String(hindOutcome.reason) });
        hindenburgRes = '[HINDENBURG: 응답 생성 실패 — 생략]';
        hindenburgGen = { text: hindenburgRes, provider: 'gemini', model: 'error-placeholder' };
        collectPartialResult(ex, 'HINDENBURG_ANALYST', hindenburgRes);
        await notifySeg('HINDENBURG', hindenburgRes);
      }
      logger.info('AI_PERF', 'parallel_ray_hindenburg_window_ms', {
        persona_parallel_wall_time_ms,
        parallel_execution_used: true,
        compressed_prompt_mode: 'standard_compressed'
      });
    } else if (committeePlan.runRay) {
      rayRes = await runRayExec();
      if (rayRes?.includes('[REASON: NO_DATA]')) {
        logger.warn('AI', 'Ray Dalio aborted due to NO_DATA at logic layer');
        return { status: 'aborted_silent' };
      }
      hindenburgRes = SK('HINDENBURG_ANALYST');
      hindenburgGen = { text: hindenburgRes, provider: 'gemini', model: 'committee-skip' };
      persona_parallel_wall_time_ms = Date.now() - tParallelWallStart;
      logger.info('AI_PERF', 'parallel_ray_hindenburg_window_ms', {
        persona_parallel_wall_time_ms,
        parallel_execution_used: false,
        compressed_prompt_mode: 'standard_compressed'
      });
    } else if (committeePlan.runHindenburg) {
      rayRes = SK('Ray Dalio (PB)');
      try {
        const h = await runHindExec();
        hindenburgGen = h.hindenburgGen;
        hindenburgRes = h.hindenburgRes;
      } catch (e: any) {
        logger.warn('AI', 'hindenburg_only_failed', { message: e?.message || String(e) });
        hindenburgRes = '[HINDENBURG: 응답 생성 실패 — 생략]';
        hindenburgGen = { text: hindenburgRes, provider: 'gemini', model: 'error-placeholder' };
        collectPartialResult(ex, 'HINDENBURG_ANALYST', hindenburgRes);
        await notifySeg('HINDENBURG', hindenburgRes);
      }
      persona_parallel_wall_time_ms = Date.now() - tParallelWallStart;
      logger.info('AI_PERF', 'parallel_ray_hindenburg_window_ms', {
        persona_parallel_wall_time_ms,
        parallel_execution_used: false,
        compressed_prompt_mode: 'standard_compressed'
      });
    } else {
      rayRes = SK('Ray Dalio (PB)');
      hindenburgRes = SK('HINDENBURG_ANALYST');
      hindenburgGen = { text: hindenburgRes, provider: 'gemini', model: 'committee-skip' };
      persona_parallel_wall_time_ms = Date.now() - tParallelWallStart;
      logger.warn('COMMITTEE', 'risk_seat_fallback_both_skipped', { committeePlan });
    }

    const riskPeers: { label: string; text: string }[] = [];
    if (committeePlan.runRay) riskPeers.push({ label: 'Ray', text: rayRes });
    if (committeePlan.runHindenburg) riskPeers.push({ label: 'Hindenburg', text: hindenburgRes });
    const peerForSimons = compressPersonaOutputsForCio(riskPeers.length ? riskPeers : [{ label: 'Risk', text: rayRes }], 420);

    let simonsGen: ProviderGenerationResult;
    let simonsRes: string;
    if (committeePlan.runSimons) {
      const simonsQuery = `${compressedBase}\n\n${buildPersonaContext({
        personaKey: 'SIMONS',
        personaBiasDirective: personaBiasDirective('SIMONS'),
        memoryDirective: simonsMemory,
        compressionMode: 'standard_compressed'
      })}\n\n${buildTaskPrompt('persona')}`;
      assertActiveExecution(ex, 'portfolio:pre_simons');
      const tSim = Date.now();
      simonsGen = await generateWithPersonaProvider({
        discordUserId: userId,
        personaKey: 'SIMONS',
        personaName: personaKeyToPersonaName('SIMONS'),
        prompt: simonsQuery,
        aiExecution: ex ?? undefined,
        taskType: 'PERSONA_ANALYSIS',
        generation: OPENAI_PERSONA_CAPS,
        compressed_prompt_used: true,
        fallbackToGemini: async () =>
          asGeminiResult(await simons.strategize(simonsQuery, false, peerForSimons, GEM_PERSONA_CAPS))
      });
      assertActiveExecution(ex, 'portfolio:post_simons');
      simonsRes = normalizeProviderOutputForDiscord({
        text: simonsGen.text,
        provider: simonsGen.provider,
        personaKey: 'SIMONS'
      });
      collectPartialResult(ex, 'James Simons (Quant)', simonsRes);
      logger.info('AI_PERF', 'persona_execution_time', {
        persona: 'SIMONS',
        ms: Date.now() - tSim,
        parallel_execution_used: false,
        model_used: simonsGen.model,
        prompt_token_estimate: estimateTokensApprox(simonsQuery.length)
      });
      await notifySeg('SIMONS', simonsRes);
    } else {
      simonsRes = SK('James Simons (Quant)');
      simonsGen = { text: simonsRes, provider: 'gemini', model: 'committee-skip' };
    }

    const druckerPeers = [...riskPeers, ...(committeePlan.runSimons ? [{ label: 'Simons', text: simonsRes }] : [])];
    const druckerCombinedLog = `${precomputedDruckerPreamble}\n${compressPersonaOutputsForCio(druckerPeers, 340)}${druckerMemory ? `\n\n[MEMORY]\n${truncateUtf8Chars(druckerMemory, 900)}` : ''}`;
    assertActiveExecution(ex, 'portfolio:pre_drucker');
    const tDr = Date.now();
    const druckerResRaw = await drucker.summarizeAndGenerateActions(false, druckerCombinedLog, GEM_PERSONA_CAPS);
    assertActiveExecution(ex, 'portfolio:post_drucker');
    const druckerRes = normalizeProviderOutputForDiscord({ text: druckerResRaw, provider: 'gemini', personaKey: 'DRUCKER' });
    collectPartialResult(ex, 'Peter Drucker (COO)', druckerRes);
    logger.info('AI_PERF', 'persona_execution_time', {
      persona: 'DRUCKER',
      ms: Date.now() - tDr,
      compressed_prompt_used: true,
      model_used: 'gemini-2.5-flash'
    });
    await notifySeg('DRUCKER', druckerRes);

    const preCioPersonas: PersonaKey[] = (['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER'] as PersonaKey[]).filter(k => {
      if (k === 'RAY') return committeePlan.runRay;
      if (k === 'HINDENBURG') return committeePlan.runHindenburg;
      if (k === 'SIMONS') return committeePlan.runSimons;
      return true;
    });
    const feedbackSignals: FeedbackDecisionSignal[] = [];
    const segmentText: Record<PersonaKey, string> = {
      RAY: rayRes,
      HINDENBURG: hindenburgRes,
      SIMONS: simonsRes,
      DRUCKER: druckerRes,
      CIO: '',
      JYP: '',
      TREND: '',
      OPEN_TOPIC: '',
      THIEL: '',
      HOT_TREND: ''
    };
    for (const pk of preCioPersonas) {
      const pn = personaKeyToPersonaName(pk);
      const pm = personaMemoryByKey.get(pk) ?? ({} as PersonaMemory);
      const segTxt = segmentText[pk] || '';
      const extracted: ClaimExtractionResult = isCommitteeSkippedPlaceholderResponse(segTxt)
        ? { claims: [], fallbackUsed: false }
        : extractClaimsByContract({
            responseText: segTxt,
            analysisType,
            personaName: pn
          });
      feedbackSignals.push(
        buildFeedbackDecisionSignal({
          discordUserId: userId,
          analysisType,
          personaName: pn,
          personaKey: pk,
          claims: extracted.claims,
          personaMemory: pm
        })
      );
    }
    const cioCalibBlock = buildCioCalibrationPromptBlock(feedbackSignals);
    const feedbackAdjustmentMetaForCio = aggregateFeedbackAdjustmentMeta(feedbackSignals, analysisType);
    const feedbackCalibrationLine = buildFeedbackCalibrationDiscordLine(feedbackSignals);

    const cioBodyCore = compressPersonaOutputsForCio([...druckerPeers, { label: 'Drucker', text: druckerRes }], 280);
    let cioCombinedLog = `${precomputedCioStyleBlock}\n${buildTaskPrompt('cio')}\n[CIO_INPUT]\n${cioBodyCore}`;
    if (cioMemory) {
      cioCombinedLog += `\n\n[MEMORY]\n${truncateUtf8Chars(cioMemory, 800)}`;
    }
    if (cioCalibBlock.trim()) {
      cioCombinedLog += `\n\n${cioCalibBlock}`;
    }
    assertActiveExecution(ex, 'portfolio:pre_cio');
    const tCio = Date.now();
    const cioResRaw = await cio.decide(false, cioCombinedLog, GEM_CIO_CAPS);
    assertActiveExecution(ex, 'portfolio:post_cio');
    const cio_stage_time_ms = Date.now() - tCio;
    const cioResBase = normalizeProviderOutputForDiscord({ text: cioResRaw, provider: 'gemini', personaKey: 'CIO' });
    const cioRes = `${cioResBase}\n\n_이번 분석은 금융 위원회 기준으로, 가중치·정책에 따른 위원 구성으로 진행했습니다._`;
    collectPartialResult(ex, 'Stanley Druckenmiller (CIO)', cioRes);
    logger.info('AI_PERF', 'persona_execution_time', {
      persona: 'CIO',
      ms: cio_stage_time_ms,
      cio_stage_time_ms,
      compressed_prompt_used: true,
      compressed_prompt_mode: 'standard_compressed',
      model_used: 'gemini-2.5-flash',
      prompt_token_estimate: estimateTokensApprox(cioCombinedLog.length)
    });
    await notifySeg('CIO', cioRes);

    logger.info('AI_PERF', 'portfolio_pipeline_complete', {
      committee_pipeline_wall_ms: Date.now() - perfCommitteeStart,
      prompt_build_time_ms,
      persona_parallel_wall_time_ms,
      cio_stage_time_ms,
      parallel_execution_used: true,
      compressed_prompt_used: true,
      compressed_prompt_mode: 'standard_compressed',
      retry_mode_used: 'none',
      base_context_chars: compressedBase.length,
      prompt_token_estimate: estimateTokensApprox(compressedBase.length)
    });

    ex?.setPerfMetrics({
      prompt_build_time_ms,
      persona_parallel_wall_time_ms,
      cio_stage_time_ms,
      compressed_prompt_mode: 'standard_compressed',
      retry_mode_used: 'none'
    });

    const personaOutputsForPipeline = [
      ...(committeePlan.runRay
        ? [
            {
              personaKey: 'RAY' as const,
              personaName: personaKeyToPersonaName('RAY'),
              responseText: rayRes,
              providerName: 'gemini',
              modelName: 'gemini-2.5-flash'
            }
          ]
        : []),
      ...(committeePlan.runHindenburg
        ? [
            {
              personaKey: 'HINDENBURG' as const,
              personaName: personaKeyToPersonaName('HINDENBURG'),
              responseText: hindenburgRes,
              providerName: hindenburgGen.provider,
              modelName: hindenburgGen.model,
              estimatedCostUsd: hindenburgGen.estimated_cost_usd
            }
          ]
        : []),
      ...(committeePlan.runSimons
        ? [
            {
              personaKey: 'SIMONS' as const,
              personaName: personaKeyToPersonaName('SIMONS'),
              responseText: simonsRes,
              providerName: simonsGen.provider,
              modelName: simonsGen.model,
              estimatedCostUsd: simonsGen.estimated_cost_usd
            }
          ]
        : []),
      {
        personaKey: 'DRUCKER' as const,
        personaName: personaKeyToPersonaName('DRUCKER'),
        responseText: druckerRes,
        providerName: 'gemini',
        modelName: 'gemini-2.5-flash'
      },
      {
        personaKey: 'CIO' as const,
        personaName: personaKeyToPersonaName('CIO'),
        responseText: cioRes,
        providerName: 'gemini',
        modelName: 'gemini-2.5-flash'
      }
    ];

    const preferredNames = (profile.preferred_personas || []).filter(
      n => !EXCLUDED_FROM_PORTFOLIO_FINANCIAL_DISPLAY.has(n)
    );
    const avoidedNames = profile.avoided_personas || [];
    const keyOrder: PersonaKey[] = (['HINDENBURG', 'RAY', 'SIMONS', 'DRUCKER', 'CIO'] as PersonaKey[]).filter(k => {
      if (k === 'RAY') return committeePlan.runRay;
      if (k === 'HINDENBURG') return committeePlan.runHindenburg;
      if (k === 'SIMONS') return committeePlan.runSimons;
      return true;
    });
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
      preferredSummaryKey === 'HINDENBURG'
        ? hindenburgRes
        : preferredSummaryKey === 'RAY'
          ? rayRes
          : preferredSummaryKey === 'SIMONS'
            ? simonsRes
            : preferredSummaryKey === 'DRUCKER'
              ? druckerRes
              : cioRes;

    const chatHistoryPayload: Record<string, unknown> = {
      user_id: userId,
      user_query: userQuery,
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

    assertActiveExecution(ex, 'portfolio:pre_chat_insert');
    const chatHistoryId = await insertChatHistoryWithLegacyFallback(chatHistoryPayload, true);
    if (chatHistoryId) logger.info('DB', 'chat_history insert success', { chatHistoryId });
    assertActiveExecution(ex, 'portfolio:post_chat_insert');

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

      assertActiveExecution(ex, 'portfolio:pre_pipeline');
      await runAnalysisPipeline({
        discordUserId: userId,
        chatHistoryId,
        analysisType,
        feedbackAdjustmentMetaForCio,
        personaOutputs: personaOutputsForPipeline,
        baseContext
      });
    }

    let decisionArtifact: DecisionArtifact | null = null;
    if (chatHistoryId) {
      try {
        const usSingleAssetConcentration = snapshot.positions.some(
          p => p.market === 'US' && p.weight_pct >= 95
        );
        decisionArtifact = await runDecisionEngineAppService({
          discordUserId: userId,
          chatHistoryId,
          analysisType,
          personaOutputs: personaOutputsForPipeline.map(p => ({
            personaKey: p.personaKey,
            personaName: p.personaName,
            responseText: p.responseText
          })),
          snapshotSummary: {
            position_count: snapshot.summary.position_count,
            top3_weight_pct: snapshot.summary.top3_weight_pct,
            degraded_quote_mode: snapshot.summary.degraded_quote_mode,
            quote_failure_count: snapshot.summary.quote_failure_count ?? 0
          },
          anchorState: { hasLifestyle: anchorState.hasLifestyle },
          usSingleAssetConcentration
        });
      } catch (de: any) {
        logger.warn('DECISION_ENGINE', 'decision_artifact_save_failed', { message: de?.message || String(de) });
      }
    }

    logger.info('AI', 'Gemini call completed');

    const resultByKey: Record<PersonaKey, string> = {
      RAY: rayRes,
      HINDENBURG: hindenburgRes,
      SIMONS: simonsRes,
      DRUCKER: druckerRes,
      CIO: cioRes,
      JYP: '',
      TREND: '',
      OPEN_TOPIC: '',
      THIEL: '',
      HOT_TREND: ''
    };

    const segments: PortfolioDebateSegment[] = [];
    for (const k of orderedKeys) {
      const meta = PORTFOLIO_SEGMENT_META[k];
      if (!meta) continue;
      segments.push({
        key: k,
        agentName: meta.agentName,
        avatarUrl: meta.avatarUrl,
        text: resultByKey[k]
      });
    }

    return {
      status: 'ok',
      analysisType,
      chatHistoryId,
      orderedKeys,
      segments,
      decisionArtifact,
      feedbackCalibrationLine
    };
  } catch (err: any) {
    logger.error('ROUTER', '포트폴리오 토론 에러: ' + err.message, err);
    throw err;
  }
}
