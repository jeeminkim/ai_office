import type { UserProfile } from '../../profileService';
import { personaKeyToPersonaName } from '../discord/analysisFormatting';
import { logger } from '../../logger';
import type { PersonaWeightMeta } from './personaWeightService';

export type CommitteeRunMode = 'full' | 'light' | 'retry_summary' | 'short';

export type FinancialCommitteePlan = {
  runRay: boolean;
  runHindenburg: boolean;
  runSimons: boolean;
  /** `short` 모드만 false — CIO 단독 요약. */
  runDrucker: boolean;
  compositionReason: string;
  weightMeta: PersonaWeightMeta;
};

function random01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * 가중치·회피·모드 기반 금융 위원 구성. 리스크 좌석(Ray/Hindenburg) 하한·SIMONS 확률 포함.
 * 단일 최고점만 선택하지 않도록 구간 확률·동시 포함을 혼합한다.
 */
export function buildFinancialCommitteePlan(params: {
  userId: string;
  analysisType: string;
  profile: UserProfile;
  weightMeta: PersonaWeightMeta;
  runMode: CommitteeRunMode;
}): FinancialCommitteePlan {
  const { userId, analysisType, profile, weightMeta, runMode } = params;
  const w = weightMeta.adjusted;
  const avoided = new Set(profile.avoided_personas || []);
  const avoidedRay = avoided.has(personaKeyToPersonaName('RAY'));
  const avoidedH = avoided.has(personaKeyToPersonaName('HINDENBURG'));
  const favored = profile.favored_analysis_styles || [];
  const riskHeavy = favored.includes('risk-heavy') || favored.includes('risk-focused');
  const dataDriven = favored.includes('data-driven') || favored.includes('numeric-centric');

  let runRay = true;
  let runHindenburg = true;
  let runSimons = true;
  let runDrucker = true;
  const reason: string[] = [];

  const seed = `${userId}:${analysisType}:${runMode}`;
  const r1 = random01(seed + ':a');
  const r2 = random01(seed + ':b');

  if (runMode === 'short') {
    runRay = false;
    runHindenburg = false;
    runSimons = false;
    runDrucker = false;
    reason.push('short:ci_only');
  } else if (runMode === 'light' || runMode === 'retry_summary') {
    runSimons = false;
    reason.push(`${runMode}:no_simons`);
    if (runMode === 'retry_summary') {
      runDrucker = true;
      reason.push('retry_summary:drucker_on');
    } else {
      runDrucker = false;
      reason.push('light:no_drucker');
    }
    if (avoidedRay && !avoidedH) {
      runRay = false;
      reason.push('avoided_ray');
    } else if (avoidedH && !avoidedRay) {
      runHindenburg = false;
      reason.push('avoided_hindenburg');
    } else if (avoidedRay && avoidedH) {
      runRay = r1 < 0.5;
      runHindenburg = !runRay;
      reason.push('both_avoided_risk_fallback_one');
    } else {
      const sum = w.RAY + w.HINDENBURG;
      runRay = r1 < w.RAY / sum;
      runHindenburg = !runRay;
      reason.push(`${runMode}:single_risk_weighted`);
    }
  } else {
    if (avoidedRay && !avoidedH) {
      runRay = false;
      runHindenburg = true;
      reason.push('avoided_ray');
    } else if (avoidedH && !avoidedRay) {
      runRay = true;
      runHindenburg = false;
      reason.push('avoided_hindenburg');
    } else if (avoidedRay && avoidedH) {
      runRay = true;
      runHindenburg = r2 < 0.45;
      reason.push('both_avoided_risk_partial');
    } else if (riskHeavy) {
      runRay = true;
      runHindenburg = true;
      reason.push('risk_heavy:both_risk');
    } else {
      const pBoth = 0.38 + 0.22 * Math.min(w.RAY, w.HINDENBURG);
      if (r1 < pBoth) {
        runRay = true;
        runHindenburg = true;
        reason.push(`full:both_risk(p=${pBoth.toFixed(2)})`);
      } else {
        const sum = w.RAY + w.HINDENBURG;
        runRay = r2 < w.RAY / sum;
        runHindenburg = !runRay;
        reason.push('full:single_risk_weighted');
      }
    }

    const simonsBoost = dataDriven ? 0.12 : 0;
    const pSimons = Math.min(0.9, 0.28 + w.SIMONS * 0.45 + simonsBoost);
    runSimons = random01(seed + ':s') < pSimons;
    reason.push(`simons_p=${pSimons.toFixed(2)}:${runSimons ? 'on' : 'off'}`);
  }

  const selectedPersonas = [
    ...(runRay ? ['RAY'] : []),
    ...(runHindenburg ? ['HINDENBURG'] : []),
    ...(runSimons ? ['SIMONS'] : []),
    ...(runDrucker ? ['DRUCKER'] : []),
    'CIO'
  ];

  const excludedPersonas = [
    ...(!runRay ? ['RAY'] : []),
    ...(!runHindenburg ? ['HINDENBURG'] : []),
    ...(!runSimons ? ['SIMONS'] : []),
    ...(!runDrucker ? ['DRUCKER'] : [])
  ];

  logger.info('PERSONA', 'COMMITTEE_COMPOSITION_BUILT', {
    analysisType,
    runMode,
    routeFamily: 'financial',
    runRay,
    runHindenburg,
    runSimons,
    runDrucker,
    selectedPersonas,
    excludedPersonas,
    compositionReason: reason.join('|'),
    userPreferred: profile.preferred_personas?.slice(0, 6),
    userAvoided: profile.avoided_personas?.slice(0, 6),
    weightSnapshot: params.weightMeta.adjusted
  });

  return {
    runRay,
    runHindenburg,
    runSimons,
    runDrucker,
    compositionReason: reason.join(' · '),
    weightMeta
  };
}

const PLACEHOLDER_MARK = '이번 라운드 위원 구성에서 생략됨';

export const COMMITTEE_SKIPPED_PLACEHOLDER = (label: string) => `_[${label}: ${PLACEHOLDER_MARK}]_`;

export function isCommitteeSkippedPlaceholderResponse(text: string): boolean {
  return String(text || '').includes(PLACEHOLDER_MARK);
}
