/**
 * 금융 위원회 vs 트렌드·K-culture 페르소나 **하드 분리** 정책.
 * 프롬프트 안내만이 아니라 라우트·그룹·선택 단계에서 교차 참여를 차단한다.
 */

import type { PersonaKey } from '../../analysisTypes';
import { logger } from '../../logger';
import { detectFinancialIntent } from '../discord/analysisFormatting';

/** 포트폴리오 토론·금융 파이프라인에 참여 가능한 PersonaKey (위원회). */
export const FINANCIAL_COMMITTEE_KEYS = ['RAY', 'HINDENBURG', 'SIMONS', 'DRUCKER', 'CIO'] as const;
export type FinancialCommitteeKey = (typeof FINANCIAL_COMMITTEE_KEYS)[number];

/** 트렌드 전용 에이전트 식별자 (TREND_TOPIC_CONFIG.personaKey 등, PersonaKey와 별도 문자열 허용). */
export const TREND_PERSONA_IDS = ['JYP', 'KIM_EUNHEE', 'SON_HEUNGMIN', 'JEON_HYEONGMU', 'TREND_ANALYST'] as const;
export type TrendPersonaId = (typeof TREND_PERSONA_IDS)[number];

export type RouteFamily =
  | 'portfolio_financial'
  | 'trend_k_culture'
  | 'open_topic'
  | 'other';

export type OpenTopicKind = 'financial' | 'trend' | 'general';

/** K-culture / 트렌드 표시명 — 금융 경로 선호·바이어스에서 제외. */
export const K_CULTURE_DISPLAY_NAMES = new Set([
  'JYP (Analyst)',
  '전현무 · 핫 트렌드 분석',
  '손흥민 · 스포츠 비즈니스 분석',
  '김은희 · 드라마/OTT 리서처'
]);

export function isFinancialCommitteeKey(k: PersonaKey): k is FinancialCommitteeKey {
  return (FINANCIAL_COMMITTEE_KEYS as readonly string[]).includes(k);
}

export function analysisTypeToRouteFamily(analysisType: string): RouteFamily {
  const t = analysisType || '';
  if (t.startsWith('trend_')) return 'trend_k_culture';
  if (t.startsWith('open_topic')) return 'open_topic';
  if (
    t.startsWith('portfolio_') ||
    t === 'financial_debate' ||
    t.includes('rebalance') ||
    t.includes('advisory') ||
    t.includes('data_center')
  ) {
    return 'portfolio_financial';
  }
  return 'other';
}

export function getPersonaGroupForRoute(analysisType: string, topicHint?: string): 'FINANCIAL' | 'TREND' | 'MIXED_BLOCKED' {
  const family = analysisTypeToRouteFamily(analysisType);
  if (family === 'trend_k_culture') return 'TREND';
  if (family === 'portfolio_financial') return 'FINANCIAL';
  if (family === 'open_topic') {
    if (topicHint === 'trend') return 'TREND';
    if (topicHint === 'financial' || topicHint === 'general') return 'FINANCIAL';
  }
  return 'FINANCIAL';
}

/** 오픈 토픽 질의를 금융 / 트렌드 / 일반(모호)으로 분류. 일반은 안전 측면에서 금융 오픈으로 처리. */
export function classifyOpenTopicQuery(userQuery: string): {
  kind: OpenTopicKind;
  ambiguous: boolean;
} {
  const q = userQuery || '';
  const financial = detectFinancialIntent(q);
  const trend =
    /(트렌드|k-?pop|케이팝|아이돌|드라마|ott|넷플|스포츠|엔터|콘텐츠|핫이슈|밈|예능)/i.test(q) ||
    /(전현무|손흥민|김은희|jyp|박진영)/i.test(q);

  if (financial && trend) {
    return { kind: 'financial', ambiguous: true };
  }
  if (financial) return { kind: 'financial', ambiguous: false };
  if (trend) return { kind: 'trend', ambiguous: false };
  return { kind: 'general', ambiguous: true };
}

export function resolveOpenTopicAnalysisType(kind: OpenTopicKind): string {
  if (kind === 'financial') return 'open_topic_financial';
  if (kind === 'trend') return 'open_topic_trend';
  return 'open_topic_general';
}

export function logRouteFamilyLocked(meta: Record<string, unknown>): void {
  logger.info('ROUTE', 'ROUTE_FAMILY_LOCKED', meta);
}

export function logPersonaGroupSelected(meta: Record<string, unknown>): void {
  logger.info('PERSONA', 'PERSONA_GROUP_SELECTED', meta);
}

export function logPersonaHardExcluded(meta: Record<string, unknown>): void {
  logger.warn('PERSONA', 'PERSONA_HARD_EXCLUDED', meta);
}

export function logOpenTopicClassified(meta: Record<string, unknown>): void {
  logger.info('OPEN_TOPIC', 'OPEN_TOPIC_CLASSIFIED', meta);
}
