import type { PersonaKey } from '../../analysisTypes';
import { logger } from '../../logger';
import {
  K_CULTURE_DISPLAY_NAMES,
  type OpenTopicKind,
  classifyOpenTopicQuery,
  getPersonaGroupForRoute,
  logOpenTopicClassified,
  logPersonaHardExcluded,
  logPersonaGroupSelected,
  resolveOpenTopicAnalysisType
} from '../policies/personaRoutePolicy';

/** 금융 위원회 경로에서 선호/바이어스에 반영하지 않는 K-culture·트렌드 표시명. */
export const EXCLUDED_FROM_PORTFOLIO_FINANCIAL_DISPLAY = K_CULTURE_DISPLAY_NAMES;
export { K_CULTURE_DISPLAY_NAMES };

export {
  classifyOpenTopicQuery,
  getPersonaGroupForRoute,
  logOpenTopicClassified,
  logPersonaHardExcluded,
  logPersonaGroupSelected,
  resolveOpenTopicAnalysisType,
  type OpenTopicKind
};

export function logPersonaSelectionPolicyApplied(meta: Record<string, unknown>): void {
  logger.info('PERSONA', 'PERSONA_SELECTION_POLICY_APPLIED', meta);
}

/** 프로필 문자열 → 오픈 토픽 금융 위원 PersonaKey (K-culture 매핑 없음). */
export function displayNameToFinancialOpenPersonaKey(name: string): PersonaKey | null {
  const n = String(name || '').trim();
  if (!n) return null;
  if (/Ray\s*Dalio/i.test(n)) return 'RAY';
  if (/James\s*Simons|Jim\s*Simons/i.test(n)) return 'SIMONS';
  if (/Peter\s*Drucker/i.test(n)) return 'DRUCKER';
  if (/Stanley\s*Druckenmiller|Druckenmiller|\bCIO\b/i.test(n)) return 'CIO';
  return null;
}

/** 트렌드·K-culture 오픈 토픽 전용 (JYP). */
export function displayNameToTrendOpenPersonaKey(name: string): PersonaKey | null {
  const n = String(name || '').trim();
  if (!n) return null;
  if (/JYP|박진영/i.test(n)) return 'JYP';
  return null;
}

/** @deprecated 분류 없이 쓰지 말 것. 하위 호환용. */
export function displayNameToOpenTopicPersonaKey(name: string): PersonaKey | null {
  return displayNameToTrendOpenPersonaKey(name) ?? displayNameToFinancialOpenPersonaKey(name);
}
