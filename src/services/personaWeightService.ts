import type { PersonaMemory } from '../../analysisTypes';
import type { UserProfile } from '../../profileService';
import type { FinancialCommitteeKey } from '../policies/personaRoutePolicy';
import { FINANCIAL_COMMITTEE_KEYS } from '../policies/personaRoutePolicy';
import { personaKeyToPersonaName } from '../discord/analysisFormatting';
import { logger } from '../../logger';
import type { PersonaSignalHints } from '../repositories/personaSignalsRepository';

export type PersonaWeightMeta = {
  base: Record<FinancialCommitteeKey, number>;
  adjusted: Record<FinancialCommitteeKey, number>;
  notes: string[];
  recentFeedbackSummary?: string;
  recentAccuracyHint?: string;
};

/** 사용자 id 기반 결정론 지터(동일 세션 내 안정, 완전 고정은 아님). */
function stableJitter(userId: string, key: FinancialCommitteeKey): number {
  let h = 0;
  const s = `${userId}:${key}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 17) / 100; // 0~0.16
}

function memoryPenalty(memory: PersonaMemory | null | undefined): number {
  if (!memory?.last_feedback_summary) return 0;
  const t = String(memory.last_feedback_summary).toUpperCase();
  if (t.includes('DISLIKED') || t.includes('REJECTED')) return -0.18;
  if (t.includes('ADOPTED') || t.includes('TRUSTED')) return 0.06;
  return 0;
}

/**
 * 금융 위원회 좌석별 가중치. 트렌드 페르소나는 이 맵에 포함하지 않는다(금융 경로에서 weight=0 = 미참여).
 */
function applyRecentSignalDeltas(
  adjusted: Record<FinancialCommitteeKey, number>,
  hints: PersonaSignalHints | undefined,
  notes: string[]
): void {
  if (!hints) return;
  for (const k of FINANCIAL_COMMITTEE_KEYS) {
    const nm = personaKeyToPersonaName(k);
    const f = hints.feedbackByPersonaName[nm];
    const c = hints.claimFeedbackByPersonaName[nm];
    let delta = 0;
    if (f) {
      const net = f.pos - f.neg;
      if (net > 0) {
        delta += 0.05;
        notes.push(`recentFb+:${k}`);
      }
      if (net < 0) {
        delta -= 0.05;
        notes.push(`recentFb-:${k}`);
      }
    }
    if (c) {
      const net = c.pos - c.neg;
      if (net > 0) {
        delta += 0.05;
        notes.push(`claimFb+:${k}`);
      }
      if (net < 0) {
        delta -= 0.05;
        notes.push(`claimFb-:${k}`);
      }
    }
    delta = Math.max(-0.1, Math.min(0.1, delta));
    if (delta !== 0) adjusted[k] += delta;
  }
}

export function computeFinancialPersonaWeights(params: {
  userId: string;
  profile: UserProfile;
  memories: Partial<Record<FinancialCommitteeKey, PersonaMemory | null>>;
  signalHints?: PersonaSignalHints;
  observability?: { analysisType?: string; routeFamily?: string };
}): PersonaWeightMeta {
  const { userId, profile } = params;
  const notes: string[] = [];

  const base: Record<FinancialCommitteeKey, number> = {
    CIO: 1.0,
    DRUCKER: 0.95,
    RAY: 0.9,
    HINDENBURG: 0.85,
    SIMONS: 0.7
  };

  const preferred = new Set(profile.preferred_personas || []);
  const avoided = new Set(profile.avoided_personas || []);

  const adjusted = { ...base } as Record<FinancialCommitteeKey, number>;

  for (const k of FINANCIAL_COMMITTEE_KEYS) {
    const name = personaKeyToPersonaName(k);
    if (preferred.has(name)) {
      adjusted[k] += 0.08;
      notes.push(`preferred:${k}`);
    }
    if (avoided.has(name)) {
      adjusted[k] -= 0.22;
      notes.push(`avoided:${k}`);
    }
    adjusted[k] += memoryPenalty(params.memories[k]);
    adjusted[k] += stableJitter(userId, k);
    if (k === 'RAY' || k === 'HINDENBURG') {
      adjusted[k] = Math.max(adjusted[k], 0.72);
    }
    adjusted[k] = Math.max(0.05, Math.min(1.15, adjusted[k]));
  }

  applyRecentSignalDeltas(adjusted, params.signalHints, notes);

  for (const k of FINANCIAL_COMMITTEE_KEYS) {
    if (k === 'RAY' || k === 'HINDENBURG') {
      adjusted[k] = Math.max(adjusted[k], 0.72);
    }
    adjusted[k] = Math.max(0.05, Math.min(1.15, adjusted[k]));
  }

  const recentFeedbackSummary = params.signalHints?.recentFeedbackSummary ?? 'none';
  const recentAccuracyHint = params.signalHints?.recentAccuracyHint ?? 'none';

  logger.info('PERSONA', 'PERSONA_WEIGHT_APPLIED', {
    discordUserId: userId,
    analysisType: params.observability?.analysisType,
    routeFamily: params.observability?.routeFamily ?? 'financial',
    weights: adjusted,
    notes: notes.slice(0, 16),
    recentFeedbackSummary,
    recentAccuracyHint,
    compositionReason: notes.filter(n => /recentFb|claimFb/.test(n)).join('|') || 'no_recent_signal_delta'
  });

  return {
    base,
    adjusted,
    notes,
    recentFeedbackSummary,
    recentAccuracyHint
  };
}
