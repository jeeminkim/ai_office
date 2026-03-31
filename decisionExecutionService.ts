import { logger } from './logger';
import type { DecisionArtifact, DecisionType } from './src/contracts/decisionContract';
import { buildPortfolioSnapshot } from './portfolioService';
import {
  buildRebalancePlanAppService,
  type RebalancePlanLine
} from './src/application/buildRebalancePlanAppService';
import { getLatestDecisionArtifactForChat } from './src/repositories/decisionArtifactRepository';
import { generateGeminiResponse } from './geminiLlmService';

export type ExecutionKind = 'immediate_sell' | 'staged_sell' | 'hold' | 'cio_followup' | 'clarify';

/** Heuristic routing: rebalance vs CIO vs clarify (no auto-trading). */
export function classifyDecisionExecution(
  selectedOption: string,
  options: string[],
  analysisType: string
): ExecutionKind {
  const sel = selectedOption.toLowerCase();
  const blob = `${selectedOption} ${options.join(' ')}`.toLowerCase();
  const fin =
    /PORTFOLIO|DEBATE|COMMITTEE|AI_FULL|AI_RISK|AI_STRATEGY|FINANCE|SPENDING|SHADOW|REBALANCE|panel:ai/i.test(
      analysisType
    );

  if (fin && /매도|리밸|비중|조정|exit|reduce|일괄|즉시|단계|분할|보류|hold|유지|매수/.test(blob)) {
    if (/보류|유지|hold|그대로/.test(sel) && !/단계|즉시|일괄/.test(sel)) return 'hold';
    if (/즉시|일괄|전량|한번에|모두/.test(sel)) return 'immediate_sell';
    if (/단계|분할|점진|나눠/.test(sel)) return 'staged_sell';
    if (/매도|리밸|비중|조정/.test(sel)) return 'staged_sell';
  }

  if (/전략|우선|실행안|구체|진단|자산배분|리스크/.test(sel) || /CIO|COMMITTEE/i.test(analysisType)) {
    return 'cio_followup';
  }
  return 'clarify';
}

function buildMinimalArtifact(
  row: { artifactId: string; decision: DecisionType; normalizedScore: number },
  discordUserId: string,
  analysisType: string,
  chatHistoryId: number | null
): DecisionArtifact {
  const now = new Date().toISOString();
  return {
    artifactId: row.artifactId,
    discordUserId,
    analysisType,
    chatHistoryId,
    engineVersion: 'db',
    policyVersion: 'db',
    createdByEngine: 'decision_execution',
    originalDecision: row.decision,
    decision: row.decision,
    confidence: 0,
    vetoApplied: false,
    vetoReason: null,
    vetoRuleIds: [],
    committeeSummary: '',
    committeeVotes: [],
    supportingClaims: [],
    supportingClaimIds: [],
    weightedScore: 0,
    normalizedScore: row.normalizedScore,
    createdAt: now
  };
}

function appendStagedScenario(discordText: string, lines: RebalancePlanLine[]): string {
  const sells = lines.filter(l => l.side === 'SELL');
  if (sells.length === 0) return discordText;
  const parts = [
    '\n\n### 단계적 매도 시나리오 (참고·자동 주문 없음)',
    '아래 **매도** 라인을 대략 **3회**로 나눠 실행한다고 가정한 수량 예시입니다.'
  ];
  for (const ln of sells) {
    const q = Math.max(1, Math.floor(ln.quantity / 3));
    parts.push(`- \`${ln.symbol}\`: 회당 약 **${q}주** (총 제안 ${ln.quantity}주 기준)`);
  }
  return discordText + '\n' + parts.join('\n');
}

export async function executeDecisionAfterSelection(params: {
  discordUserId: string;
  chatHistoryId: number;
  analysisType: string;
  personaKey: string | null;
  selectedOption: string;
  optionIndex: number;
  options: string[];
  decisionContext: Record<string, unknown>;
  userMode: 'SAFE' | 'BALANCED' | 'AGGRESSIVE';
}): Promise<{ replyAck: string; followUpMarkdown: string; execution_type: string }> {
  const kind = classifyDecisionExecution(
    params.selectedOption,
    params.options,
    params.analysisType
  );

  logger.info('DECISION', 'DECISION_EXECUTION_STARTED', {
    user_id: params.discordUserId,
    analysis_type: params.analysisType,
    execution_type: kind,
    selected_option: params.selectedOption
  });

  let replyAck = `**선택 완료:** ${params.selectedOption} 전략·의견을 반영합니다.`;
  let followUp = '';
  const execution_type = kind;

  try {
    const artifactRow = await getLatestDecisionArtifactForChat({
      chatHistoryId: params.chatHistoryId,
      analysisType: params.analysisType
    });

    if (kind === 'hold') {
      followUp =
        '### 보류·유지 기준 후속 안내\n' +
        '자동 주문·자동 매매는 없습니다. 포지션을 유지한다면 다음 점검 시점(분기/월간)과 리스크 상한만 다시 확인하는 것을 권장합니다.';
    } else if (kind === 'immediate_sell' || kind === 'staged_sell') {
      const snapshot = await buildPortfolioSnapshot(params.discordUserId);
      const da = artifactRow
        ? buildMinimalArtifact(
            artifactRow,
            params.discordUserId,
            params.analysisType,
            params.chatHistoryId
          )
        : null;

      const overrideDecision: DecisionType = kind === 'immediate_sell' ? 'EXIT' : 'REDUCE';
      const plan = await buildRebalancePlanAppService({
        discordUserId: params.discordUserId,
        snapshot,
        decisionArtifact: da,
        advisoryOverride: {
          decision: overrideDecision,
          normalizedScore: artifactRow?.normalizedScore ?? 0
        },
        userMode: params.userMode,
        chatHistoryId: params.chatHistoryId,
        analysisType: params.analysisType,
        dryRun: false
      });

      followUp = plan.discordText;
      if (kind === 'staged_sell') {
        followUp = appendStagedScenario(followUp, plan.lines);
      }
      replyAck = `**선택 완료:** ${
        kind === 'immediate_sell' ? '즉시·일괄 매도 시나리오' : '단계적 매도 시나리오'
      }를 반영해 그림자 리밸 실행안을 생성했습니다.`;
    } else if (kind === 'cio_followup') {
      const prompt = [
        '당신은 Stanley Druckenmiller 스타일 CIO입니다. 자동 주문·매매 실행 금지.',
        `사용자 선택: "${params.selectedOption}"`,
        `analysis_type: ${params.analysisType}`,
        `선택지 전체: ${params.options.join(' | ')}`,
        '위 선택을 반영한 **구체 실행안·우선순위·리스크**를 한국어로 800자 이내, 불릿 위주로 작성하세요.'
      ].join('\n');
      const g = await generateGeminiResponse({ model: 'gemini-2.5-flash', prompt });
      followUp = `## CIO 후속 분석 (선택 반영)\n\n${g.text || '_(응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.)_'}`;
      replyAck = `**선택 완료:** ${params.selectedOption}을(를) 반영한 CIO 후속 분석을 생성합니다.`;
    } else {
      followUp =
        '### 다음으로 무엇을 더 도와드릴까요?\n' +
        '- 포트폴리오 비중·리스크를 숫자로 점검\n' +
        '- 특정 종목·섹터만 깊게 분석\n' +
        '- 목표 보유 기간·손절·추가 매수 기준 정리\n\n' +
        '원하시는 한 가지를 채팅으로 짧게 적어 주세요.';
    }

    logger.info('DECISION', 'DECISION_EXECUTION_COMPLETED', {
      user_id: params.discordUserId,
      analysis_type: params.analysisType,
      execution_type,
      selected_option: params.selectedOption
    });

    return { replyAck, followUpMarkdown: followUp, execution_type };
  } catch (e: any) {
    logger.warn('DECISION', 'DECISION_EXECUTION error', {
      message: e?.message || String(e),
      execution_type: kind
    });
    followUp =
      '### 후속 안내\n후속 분석 생성 중 일시적인 문제가 있었습니다. 같은 질문을 한 번 더 보내 주시거나 잠시 후 다시 시도해 주세요. _(자동 매매 없음)_';
    logger.info('DECISION', 'DECISION_EXECUTION_COMPLETED', {
      user_id: params.discordUserId,
      analysis_type: params.analysisType,
      execution_type: 'clarify',
      selected_option: params.selectedOption
    });
    return { replyAck, followUpMarkdown: followUp, execution_type: 'clarify' };
  }
}
