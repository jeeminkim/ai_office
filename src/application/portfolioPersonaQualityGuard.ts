import type { PersonaKey } from '../../analysisTypes';
import { logger } from '../../logger';

const COMMITTEE_KEYS = new Set<PersonaKey>(['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER', 'CIO']);

/** full / fast 공통: 최대 호출 횟수(초기 1 + 재생성 2) */
export const PORTFOLIO_QUALITY_MAX_ATTEMPTS = 3;

export type PortfolioQualityRunMode = 'full' | 'light' | 'retry_summary' | 'short_summary';

/** 모델 원문 기준(후처리 전) 문장 수 추정 */
export function countSentencesLoose(text: string): number {
  const t = String(text || '').trim();
  if (!t) return 0;
  const byPunct = t.split(/[.!?。！？…]+/).filter(s => s.replace(/[#*_`\s\d]/g, '').length > 8);
  const byLine = t.split(/\n/).filter(s => s.replace(/^[-*•\d.\s]+/, '').trim().length > 18);
  return Math.max(byPunct.length, byLine.length >= 4 ? byLine.length : byPunct.length);
}

export function countEvidenceMarkers(text: string): number {
  const t = String(text || '');
  let n = 0;
  if (/\d+\.?\d*\s*%/.test(t)) n += 1;
  if (/\d{1,3}(,\d{3})+|\d+\s*원|\d+\s*억|w\d|비중|top\d|KR%|US%/i.test(t)) n += 1;
  if (/(^|\n)\s*[-*•]\s/.test(t)) n += 1;
  if (/(근거|이유|첫째|둘째|또한|예를 들어|데이터|수치|시그널)/i.test(t)) n += 1;
  if (/\d+\)/.test(t) || /\(1\)|\(2\)/.test(t)) n += 1;
  return n;
}

export function hasJudgmentOrDirection(text: string): boolean {
  return /(판단|결론|권장|방향|전략|리스크|경고|방어|유지|축소|확대|대응|GO|HOLD|REDUCE|EXIT|NO\b)/i.test(
    String(text || '')
  );
}

export function cioHasVerdictToken(text: string): boolean {
  return /(GO|HOLD|REDUCE|EXIT|NO\b|보류|유지|축소|확대|청산|이탈|진입|추가\s*매수)/i.test(String(text || ''));
}

export function portfolioPersonaMeetsQualityFloor(personaKey: PersonaKey, rawText: string): boolean {
  if (!COMMITTEE_KEYS.has(personaKey)) return true;
  const t = String(rawText || '').trim();
  if (t.length < 120) return false;
  const sc = countSentencesLoose(t);
  const ev = countEvidenceMarkers(t);
  if (sc < 4 || ev < 2) return false;
  if (!hasJudgmentOrDirection(t)) return false;
  if (personaKey === 'CIO' && !cioHasVerdictToken(t)) return false;
  return true;
}

export function evaluatePortfolioPersonaQualityMetrics(personaKey: PersonaKey, rawText: string) {
  const t = String(rawText || '').trim();
  const pass = portfolioPersonaMeetsQualityFloor(personaKey, t);
  return {
    pass,
    responseLength: t.length,
    sentenceCount: countSentencesLoose(t),
    evidenceMarkerCount: countEvidenceMarkers(t),
    hasDecisionToken: personaKey === 'CIO' ? cioHasVerdictToken(t) : hasJudgmentOrDirection(t)
  };
}

export function buildPortfolioQualityRetryAppend(personaKey: PersonaKey, attemptIndex: number): string {
  const n = attemptIndex + 1;
  const common = `\n\n[QUALITY_RETRY_${n}]\n이전 출력이 분석 구조·근거 기준에 미달했습니다. **반드시** 아래를 만족해 다시 작성하세요.\n- 최소 **4문장** 이상.\n- **근거 2개 이상**(수치·비중·스냅샷·시그널 등 구체적으로).\n- **판단 또는 방향성**을 명시.\n추상적 한 줄(예: "리스크 있음"만)은 금지.\n`;

  const byKey: Partial<Record<PersonaKey, string>> = {
    RAY: `${common}구조: (1) 포트폴리오 리스크 구조 (2) 편중/균형 (3) 거시·시스템 리스크 (4) 리스크 관리 방향.`,
    HINDENBURG: `${common}구조: (1) 핵심 리스크 한 문장 정의 (2) 구체 근거 2개 이상 (3) downside 시나리오(범위) (4) 경고 또는 방어 전략.`,
    SIMONS: `${common}구조: (1) 시장 상태를 데이터로 정의 (2) 시그널 2개 이상 (3) 패턴·확률 해석 (4) 유리/불리 판단. 감정 표현 금지.`,
    DRUCKER: `${common}구조: (1) 포트폴리오 문제 정의 (2) 실행 전략 1~2개(구체 비중·종목군 수준) (3) 실행 방법 (4) 기대 효과. "비중 줄인다"만 쓰지 말 것.`,
    CIO: `${common}구조: (1) **GO|HOLD|REDUCE|EXIT**(또는 동의 한국어) 중 하나를 본문에 명시 (2) 이유 2개 이상 (3) 리스크 (4) 실행 요약. "지켜본다" 단독 문장 금지.`
  };

  return byKey[personaKey] || common;
}

/**
 * 포트폴리오 금융 위원 공통: normalize 이전 원문 기준 품질 판정 + 최대 PORTFOLIO_QUALITY_MAX_ATTEMPTS회 호출.
 */
export async function runPortfolioPersonaWithQualityRetry<T>(params: {
  personaKey: PersonaKey;
  basePrompt: string;
  maxAttempts?: number;
  invoke: (fullPrompt: string) => Promise<T>;
  getText: (result: T) => string;
  analysisType: string;
  runMode: PortfolioQualityRunMode;
  executionId?: string | null;
}): Promise<T> {
  const max = params.maxAttempts ?? PORTFOLIO_QUALITY_MAX_ATTEMPTS;
  const baseLog = {
    personaKey: params.personaKey,
    analysisType: params.analysisType,
    runMode: params.runMode,
    executionId: params.executionId ?? null
  };

  let last = await params.invoke(params.basePrompt);
  let raw = params.getText(last);
  let metrics = evaluatePortfolioPersonaQualityMetrics(params.personaKey, raw);
  if (metrics.pass) {
    logger.info('QUALITY', 'QUALITY_FLOOR_PASSED', { ...baseLog, attemptNo: 1, ...metrics });
    return last;
  }
  logger.warn('QUALITY', 'QUALITY_FLOOR_FAILED', { ...baseLog, attemptNo: 1, ...metrics });

  for (let a = 1; a < max; a++) {
    const attemptNo = a + 1;
    logger.info('QUALITY', 'QUALITY_REGENERATE_ATTEMPT', { ...baseLog, attemptNo });
    const prompt = `${params.basePrompt}${buildPortfolioQualityRetryAppend(params.personaKey, a - 1)}`;
    last = await params.invoke(prompt);
    raw = params.getText(last);
    metrics = evaluatePortfolioPersonaQualityMetrics(params.personaKey, raw);
    if (metrics.pass) {
      logger.info('QUALITY', 'QUALITY_REGENERATE_RECOVERED', { ...baseLog, attemptNo, ...metrics });
      return last;
    }
    logger.warn('QUALITY', 'QUALITY_FLOOR_FAILED', { ...baseLog, attemptNo, ...metrics });
  }

  logger.warn('QUALITY', 'QUALITY_REGENERATE_EXHAUSTED', {
    ...baseLog,
    attemptNo: max,
    ...metrics
  });
  return last;
}
