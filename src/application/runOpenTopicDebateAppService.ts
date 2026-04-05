import {
  RayDalioAgent,
  JYPAgent,
  JamesSimonsAgent,
  PeterDruckerAgent,
  StanleyDruckenmillerAgent
} from '../../agents';
import { loadUserProfile } from '../../profileService';
import { loadPersonaMemory } from '../../personaMemoryService';
import { buildPersonaPromptContext, buildBaseAnalysisContext } from '../../analysisContextService';
import { runAnalysisPipeline } from '../../analysisPipelineService';
import { generateWithPersonaProvider } from '../../llmProviderService';
import type { PersonaKey } from '../../analysisTypes';
import { logger } from '../../logger';
import { insertChatHistoryWithLegacyFallback } from '../repositories/chatHistoryRepository';
import {
  asGeminiResult,
  guessAnalysisTypeFromTrigger,
  normalizeProviderOutputForDiscord,
  personaKeyToPersonaName,
  toOpinionSummary
} from '../discord/analysisFormatting';
import {
  K_CULTURE_DISPLAY_NAMES,
  classifyOpenTopicQuery,
  displayNameToFinancialOpenPersonaKey,
  displayNameToTrendOpenPersonaKey,
  getPersonaGroupForRoute,
  logOpenTopicClassified,
  logPersonaGroupSelected,
  logPersonaHardExcluded,
  logPersonaSelectionPolicyApplied,
  resolveOpenTopicAnalysisType
} from '../discord/personaSelectionPolicy';
import type { AiExecutionHandle } from '../discord/aiExecution/aiExecutionHandle';
import { assertActiveExecution } from '../discord/aiExecution/aiExecutionAbort';
import { collectPartialResult } from '../discord/aiExecution/aiExecutionHelpers';
import type { AgentGenCaps } from '../../analysisTypes';
import { getModelForTask } from '../../llmProviderService';
import { buildOpenTopicBaseContext, buildPersonaContext, buildTaskPrompt } from './promptCompressionPortfolio';
import type { OpenTopicKind } from '../policies/personaRoutePolicy';

const OPEN_TOPIC_GEM: AgentGenCaps = { maxOutputTokens: 420, temperature: 0.38 };

export type OpenTopicBroadcast = {
  personaKey: PersonaKey;
  agentName: string;
  avatarUrl: string;
  text: string;
};

export type RunOpenTopicDebateAppResult =
  | {
      status: 'ambiguous_pick';
      userQuery: string;
      classifiedKind: OpenTopicKind;
    }
  | {
      status: 'ok';
      analysisType: string;
      chatHistoryId: number | null;
      broadcasts: OpenTopicBroadcast[];
    };

export async function runOpenTopicDebateAppService(params: {
  userId: string;
  userQuery: string;
  loadUserMode: (id: string) => Promise<'SAFE' | 'BALANCED' | 'AGGRESSIVE'>;
  execution?: AiExecutionHandle | null;
  fastMode?: 'none' | 'light_summary' | 'short_summary';
  /** followup 스냅샷에서 관점 확정 시 — 모호 분기 생략 */
  forcedOpenTopicView?: 'financial' | 'trend' | 'general';
  /** 페르소나 완료 시 즉시 UI 전송(최종 루프에서 스킵) */
  onPersonaReady?: (b: OpenTopicBroadcast) => void | Promise<void>;
}): Promise<RunOpenTopicDebateAppResult> {
  const { userId, userQuery } = params;
  const ex = params.execution ?? null;

  logger.info('OPEN_TOPIC', 'OPEN_TOPIC debate route selected', { discordUserId: userId });
  logger.info('OPEN_TOPIC', 'OPEN_TOPIC portfolio snapshot skipped', { discordUserId: userId });

  const mode = await params.loadUserMode(userId);
  const profile = await loadUserProfile(userId);
  logger.info('PROFILE', 'user profile applied', {
    discordUserId: userId,
    risk_tolerance: profile.risk_tolerance,
    investment_style: profile.investment_style,
    preferred_personas: profile.preferred_personas
  });

  const classified = classifyOpenTopicQuery(userQuery);
  let kind = classified.kind;
  let ambiguous = classified.ambiguous;
  if (params.forcedOpenTopicView) {
    kind = params.forcedOpenTopicView;
    ambiguous = false;
  }

  const fast = params.fastMode ?? 'none';
  if (ambiguous && !params.forcedOpenTopicView && fast === 'none') {
    logger.info('OPEN_TOPIC', 'OPEN_TOPIC_AMBIGUOUS_DETECTED', {
      discordUserId: userId,
      classifiedKind: classified.kind,
      ambiguous: classified.ambiguous
    });
    return { status: 'ambiguous_pick', userQuery, classifiedKind: classified.kind };
  }

  const resolvedAnalysisType = resolveOpenTopicAnalysisType(kind);
  logOpenTopicClassified({
    kind,
    ambiguous,
    resolvedAnalysisType,
    discordUserId: userId
  });
  ex?.lockAnalysisRoute(resolvedAnalysisType);

  const topicHint: 'financial' | 'trend' | 'general' =
    kind === 'trend' ? 'trend' : kind === 'financial' ? 'financial' : 'general';
  const personaGroup = getPersonaGroupForRoute(resolvedAnalysisType, topicHint);
  logPersonaGroupSelected({
    analysisType: resolvedAnalysisType,
    personaGroup,
    routeFamily: 'open_topic',
    discordUserId: userId
  });

  for (const nm of profile.preferred_personas || []) {
    if (K_CULTURE_DISPLAY_NAMES.has(nm) && resolvedAnalysisType !== 'open_topic_trend') {
      logPersonaHardExcluded({
        displayName: nm,
        analysisType: resolvedAnalysisType,
        reason: 'k_culture_not_in_financial_open'
      });
    }
    if (
      resolvedAnalysisType === 'open_topic_trend' &&
      !K_CULTURE_DISPLAY_NAMES.has(nm) &&
      /Ray|Dalio|Simons|Drucker|Druckenmiller|\bCIO\b|HINDENBURG/i.test(nm)
    ) {
      logPersonaHardExcluded({
        displayName: nm,
        analysisType: resolvedAnalysisType,
        reason: 'financial_persona_not_in_trend_open'
      });
    }
  }

  const userFramingLine =
    resolvedAnalysisType === 'open_topic_trend'
      ? '_이번 주제는 트렌드·K-culture 관점으로 분석했습니다._'
      : resolvedAnalysisType === 'open_topic_general'
        ? '_이번 주제는 일반 요약(오픈 토픽) 관점으로 분석했습니다._'
        : '_이번 주제는 금융·실행(오픈 토픽) 관점으로 분석했습니다._';

  const profilePromptParts: string[] = [];
  if (profile.risk_tolerance) profilePromptParts.push(`risk_tolerance=${profile.risk_tolerance}`);
  if (profile.investment_style) profilePromptParts.push(`investment_style=${profile.investment_style}`);
  if (profile.favored_analysis_styles?.length)
    profilePromptParts.push(`favored_analysis_styles=${profile.favored_analysis_styles.join(',')}`);
  if (profile.personalization_notes) profilePromptParts.push(`personalization_notes=${profile.personalization_notes}`);

  const profilePrompt = profilePromptParts.length
    ? `[USER_PROFILE]\n${profilePromptParts.join('\n')}\n`
    : `[USER_PROFILE]\n(없음)\n`;

  const openTopicPrompt =
    resolvedAnalysisType === 'open_topic_trend'
      ? `[OPEN_TOPIC_TREND_ONLY — K-culture/트렌드 전용]\n- 개인 포트폴리오·보유종목·비중·리밸런싱·매매 지시는 다루지 않는다.\n- 산업·콘텐츠·팬덤·플랫폼·이슈 중심으로 서술한다.\n- 금융 위원회(Ray/Simons/Drucker/CIO) 역할을 흉내 내지 말 것.\n`
      : `[OPEN_TOPIC_FINANCIAL_GENERAL]\n- 개인 포트폴리오 수치·보유 종목·비중·리밸런싱·평단·손익은 언급하지 않는다.\n- 금융·실행·리스크·정량 관점의 **일반론**은 허용한다.\n- 특정 종목 매수/비중 지시는 금지한다.\n`;

  const q = userQuery || '';
  const avoided = new Set(profile.avoided_personas || []);

  let selected: PersonaKey[] = [];
  let personaPickSource: 'profile' | 'hint' | 'fallback' = 'profile';

  if (resolvedAnalysisType === 'open_topic_trend') {
    selected = (profile.preferred_personas || [])
      .map(displayNameToTrendOpenPersonaKey)
      .filter((k): k is PersonaKey => k != null)
      .filter(k => !avoided.has(personaKeyToPersonaName(k)));
    if (selected.length === 0) {
      selected = ['JYP'];
      personaPickSource = 'fallback';
    }
  } else {
    selected = (profile.preferred_personas || [])
      .map(displayNameToFinancialOpenPersonaKey)
      .filter((k): k is PersonaKey => k != null)
      .filter(k => !avoided.has(personaKeyToPersonaName(k)));

    if (selected.length === 0) {
      const hint: PersonaKey[] = [];
      if (/(리스크|위험|변동성|다운사이드)/i.test(q)) hint.push('RAY');
      else if (/(실행|전략|액션|플랜|로드맵)/i.test(q)) hint.push('DRUCKER');
      else if (/(정량|수치|모델|quant|기댓값)/i.test(q)) hint.push('SIMONS');
      else if (/(의사결정|결론|CIO|GO|HOLD)/i.test(q)) hint.push('CIO');
      for (const h of hint) {
        if (!avoided.has(personaKeyToPersonaName(h))) {
          selected = [h];
          personaPickSource = 'hint';
          break;
        }
      }
    }
    if (!selected || selected.length === 0) {
      selected = ['DRUCKER', 'CIO'];
      personaPickSource = 'fallback';
    }
  }

  if (params.fastMode === 'light_summary') {
    selected = selected.slice(0, 1);
  }

  logPersonaSelectionPolicyApplied({
    analysisType: resolvedAnalysisType,
    source: personaPickSource,
    selected,
    discordUserId: userId
  });
  logger.info('OPEN_TOPIC', 'OPEN_TOPIC personas engaged', { discordUserId: userId, selected });

  const modePrompt = `[USER_MODE]\n${mode}\n(오픈 토픽은 금융 계산/포트폴리오 언급 없이 분석 톤만 반영)`;
  const openCompression =
    params.fastMode === 'light_summary' ? 'aggressive_compressed' : 'standard_compressed';
  const compressedBase = buildOpenTopicBaseContext({
    mode: modePrompt,
    userQuery: q,
    profileOneLiner: profilePromptParts.join(' | ').slice(0, 400),
    openTopicGuardBlock: `${openTopicPrompt}\n${profilePrompt}`,
    compressionMode: openCompression
  });
  const taskMode = params.fastMode === 'light_summary' ? 'persona_brevity' : 'persona';

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

  const results: Partial<Record<PersonaKey, string>> = {};
  const providerMetaByKey: Partial<Record<PersonaKey, { provider: string; model: string; estimatedCostUsd?: number }>> = {};
  let attachUserFramingOnce = true;

  const avatarFor = (p: PersonaKey): string =>
    p === 'JYP'
      ? 'https://upload.wikimedia.org/wikipedia/commons/4/44/Park_Jin-young_at_WCG_2020.png'
      : p === 'RAY'
        ? 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Ray_Dalio_at_the_World_Economic_Forum_%28cropped%29.jpg'
        : p === 'SIMONS'
          ? 'https://upload.wikimedia.org/wikipedia/commons/4/46/Jim_Simons.jpg'
          : p === 'DRUCKER'
            ? 'https://upload.wikimedia.org/wikipedia/commons/0/00/Peter_Drucker_circa_1980.jpg'
            : 'https://upload.wikimedia.org/wikipedia/commons/0/0f/StanleyDruckenmiller.jpg';

  const runPersona = async (p: PersonaKey): Promise<void> => {
    const agent = personas[p];
    if (!agent) return;
    try {
      assertActiveExecution(ex, `open_topic:pre_${p}`);
      const memoryDirective = memoryByKey.get(p) ?? '';
      const personaQuery = `${compressedBase}\n\n${buildPersonaContext({
        personaKey: p,
        personaBiasDirective: '',
        memoryDirective,
        compressionMode: openCompression
      })}\n\n${buildTaskPrompt(taskMode)}`;

      if (p === 'SIMONS') {
        const gen = await generateWithPersonaProvider({
          discordUserId: userId,
          personaKey: 'SIMONS',
          personaName: personaKeyToPersonaName('SIMONS'),
          prompt: personaQuery,
          aiExecution: ex ?? undefined,
          taskType: 'PERSONA_ANALYSIS',
          generation: { maxOutputTokens: 420, temperature: 0.35 },
          parallel_execution_used: selected.length > 1,
          compressed_prompt_used: true,
          fallbackToGemini: async () => asGeminiResult(await agent.strategize(personaQuery, true, '', OPEN_TOPIC_GEM))
        });
        providerMetaByKey[p] = {
          provider: gen.provider,
          model: gen.model,
          estimatedCostUsd: gen.estimated_cost_usd
        };
        const normalized = normalizeProviderOutputForDiscord({ text: gen.text, provider: gen.provider, personaKey: p });
        results[p] = filterForbiddenFinancialKeywords(normalized, p);
      } else {
        const rawText = await (p === 'RAY'
          ? agent.analyze(personaQuery, true, OPEN_TOPIC_GEM)
          : p === 'JYP'
            ? agent.inspire(personaQuery, true, '', OPEN_TOPIC_GEM)
            : p === 'DRUCKER'
              ? agent.summarizeAndGenerateActions(true, '', OPEN_TOPIC_GEM)
              : agent.decide(true, '', OPEN_TOPIC_GEM));
        providerMetaByKey[p] = { provider: 'gemini', model: getModelForTask('SUMMARY') };
        const normalized = normalizeProviderOutputForDiscord({ text: rawText, provider: 'gemini', personaKey: p });
        results[p] = filterForbiddenFinancialKeywords(normalized, p);
      }
      collectPartialResult(ex, personaKeyToPersonaName(p), results[p]!);
      assertActiveExecution(ex, `open_topic:post_${p}`);
      logger.info('AI_PERF', 'open_topic_persona', {
        discordUserId: userId,
        personaKey: p,
        parallel_execution_used: selected.length > 1,
        compressed_prompt_used: true,
        compressed_prompt_mode: openCompression,
        model_used: providerMetaByKey[p]?.model
      });
      if (params.onPersonaReady) {
        let textOut = String(results[p] || '');
        if (attachUserFramingOnce) {
          textOut = `${userFramingLine}\n\n${textOut}`;
          attachUserFramingOnce = false;
        }
        await params.onPersonaReady({
          personaKey: p,
          agentName: personaKeyToPersonaName(p),
          avatarUrl: avatarFor(p),
          text: textOut
        });
      }
    } catch (e: any) {
      logger.warn('OPEN_TOPIC', 'persona_failed', { personaKey: p, message: e?.message || String(e) });
      results[p] = filterForbiddenFinancialKeywords('_(응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.)_', p);
      providerMetaByKey[p] = { provider: 'gemini', model: 'error-placeholder' };
      collectPartialResult(ex, personaKeyToPersonaName(p), results[p]!);
    }
  };

  const tOpenParallel = Date.now();
  await Promise.allSettled(selected.map(p => runPersona(p)));
  const persona_parallel_wall_time_ms = Date.now() - tOpenParallel;
  ex?.setPerfMetrics({
    compressed_prompt_mode: openCompression,
    retry_mode_used: params.fastMode && params.fastMode !== 'none' ? params.fastMode : 'none',
    persona_parallel_wall_time_ms
  });

  assertActiveExecution(ex, 'open_topic:pre_chat_insert');
  const chatHistoryPayload: Record<string, unknown> = {
    user_id: userId,
    user_query: userQuery,
    ray_advice: results.RAY ?? null,
    jyp_insight: results.JYP ?? null,
    simons_opportunity: results.SIMONS ?? null,
    drucker_decision: results.DRUCKER ?? null,
    cio_decision: results.CIO ?? null,
    jyp_weekly_report: null,
    summary: toOpinionSummary(String(results[selected[0]] || ''), 1000),
    key_risks: toOpinionSummary(String(results.RAY || ''), 1000),
    key_actions: toOpinionSummary(String(results.DRUCKER || ''), 1000)
  };

  const chatHistoryId = await insertChatHistoryWithLegacyFallback(chatHistoryPayload, true);
  if (chatHistoryId) logger.info('DB', 'chat_history insert success (open_topic)', { chatHistoryId });
  assertActiveExecution(ex, 'open_topic:post_chat_insert');

  const guessedType = guessAnalysisTypeFromTrigger(undefined, userQuery);
  let analysisType = resolvedAnalysisType;
  if (ex) {
    analysisType = ex.coerceAnalysisRoute(guessedType);
  } else if (guessedType.startsWith('portfolio_')) {
    logger.warn('ROUTE', 'ROUTE_OVERRIDE_BLOCKED', { from: resolvedAnalysisType, to: guessedType });
    analysisType = resolvedAnalysisType;
  }
  ex?.augmentRetryPayload({ analysisType });

  if (chatHistoryId) {
    assertActiveExecution(ex, 'open_topic:pre_pipeline');
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
        modelName: providerMetaByKey[p]?.model || getModelForTask('SUMMARY'),
        estimatedCostUsd: providerMetaByKey[p]?.estimatedCostUsd
      })),
      baseContext
    });
  }

  const broadcasts: OpenTopicBroadcast[] = [];
  for (const p of selected) {
    const label = personaKeyToPersonaName(p);
    const avatarURL =
      p === 'JYP'
        ? 'https://upload.wikimedia.org/wikipedia/commons/4/44/Park_Jin-young_at_WCG_2020.png'
        : p === 'RAY'
          ? 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Ray_Dalio_at_the_World_Economic_Forum_%28cropped%29.jpg'
          : p === 'SIMONS'
            ? 'https://upload.wikimedia.org/wikipedia/commons/4/46/Jim_Simons.jpg'
            : p === 'DRUCKER'
              ? 'https://upload.wikimedia.org/wikipedia/commons/0/00/Peter_Drucker_circa_1980.jpg'
              : 'https://upload.wikimedia.org/wikipedia/commons/0/0f/StanleyDruckenmiller.jpg';
    broadcasts.push({
      personaKey: p,
      agentName: label,
      avatarUrl: avatarURL,
      text: String(results[p] || '')
    });
  }

  return { status: 'ok', analysisType, chatHistoryId, broadcasts };
}
