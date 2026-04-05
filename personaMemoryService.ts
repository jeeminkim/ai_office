import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { PersonaMemory, FeedbackType } from './analysisTypes';
import { selectPersonaMemoryRow, upsertPersonaMemoryRow } from './src/repositories/personaMemoryRepository';
import { isCommitteeSkippedPlaceholderResponse } from './src/services/committeeCompositionService';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

function capArray(arr: string[], cap: number): string[] {
  return arr.filter(Boolean).slice(0, cap);
}

function normalizeFeedbackType(t: string): FeedbackType | null {
  const u = String(t || '').toUpperCase();
  if (u === 'TRUSTED') return 'TRUSTED';
  if (u === 'ADOPTED') return 'ADOPTED';
  if (u === 'BOOKMARKED') return 'BOOKMARKED';
  if (u === 'DISLIKED') return 'DISLIKED';
  if (u === 'REJECTED') return 'REJECTED';
  return null;
}

function extractKeywords(text: string): string[] {
  const t = String(text || '');
  const candidates = [
    '리스크',
    '다운사이드',
    '손실',
    '전략',
    '실행',
    '액션',
    '계획',
    '행동',
    '배분',
    '비중',
    '리밸런싱',
    '평단',
    '손익',
    '유동성',
    '현금흐름',
    '지출',
    '시장',
    '밸류에이션',
    '평가',
    '기댓값',
    '확률',
    '기댓',
    'quant'
  ];
  const hits = candidates.filter(k => t.includes(k));
  return capArray(hits, 10);
}

function deriveEvidenceScopes(text: string): string[] {
  const t = String(text || '').toLowerCase();
  const scopes: string[] = [];
  if (/(현금흐름|cashflow)/i.test(t)) scopes.push('CASHFLOW');
  if (/(지출|expense|spending)/i.test(t)) scopes.push('EXPENSE');
  if (/(포트폴리오|비중|allocation|평단|손익)/i.test(t)) scopes.push('PORTFOLIO');
  if (/(시장|macroeconom|macro|금리|환율)/i.test(t)) scopes.push('MARKET');
  if (scopes.length === 0) scopes.push('GENERAL');
  return capArray(scopes, 4);
}

function deriveStyleBiasFromText(text: string): string[] {
  const t = String(text || '').toLowerCase();
  const out: string[] = [];
  if (/\d|%|usd|krw|원/.test(t)) out.push('numeric-centric');
  if (/(리스크|downside|손실|변동성)/i.test(t)) out.push('risk-focused');
  if (/(전략|allocation|비중)/i.test(t)) out.push('allocation-oriented');
  if (/(실행|action|계획|체크리스트|액션)/i.test(t)) out.push('execution-oriented');
  return capArray(out, 4);
}

function emptyPersonaMemory(discordUserId: string, personaName: string): PersonaMemory {
  return {
    discord_user_id: discordUserId,
    persona_name: personaName,
    memory_version: 1,
    accepted_patterns: { keywords: [] },
    rejected_patterns: { keywords: [] },
    style_bias: { tags: [] },
    confidence_calibration: {},
    evidence_preferences: { scopes: [] },
    last_feedback_summary: null,
    last_refreshed_at: null
  };
}

export async function loadPersonaMemory(discordUserId: string, personaName: string): Promise<PersonaMemory> {
  try {
    const data = await selectPersonaMemoryRow(discordUserId, personaName);
    if (!data) {
      logger.info('PHASE1_CHECK', 'memory_loaded', {
        discordUserId,
        personaName,
        hasRow: false,
        memory_version: null
      });
      return emptyPersonaMemory(discordUserId, personaName);
    }

    logger.info('MEMORY', 'persona memory loaded', { discordUserId, personaName, hasRow: true });
    logger.info('PHASE1_CHECK', 'memory_loaded', {
      discordUserId,
      personaName,
      hasRow: true,
      memory_version: (data as PersonaMemory).memory_version ?? null
    });
    return data as PersonaMemory;
  } catch (e: any) {
    logger.warn('MEMORY', 'persona memory load failed, fallback used', {
      discordUserId,
      personaName,
      message: e?.message || String(e)
    });
    logger.info('PHASE1_CHECK', 'memory_loaded', {
      discordUserId,
      personaName,
      hasRow: false,
      memory_version: null,
      error: true
    });
    return emptyPersonaMemory(discordUserId, personaName);
  }
}

export async function upsertPersonaMemory(input: PersonaMemory): Promise<void> {
  try {
    const payload: any = {
      discord_user_id: input.discord_user_id,
      persona_name: input.persona_name,
      memory_version: input.memory_version ?? 1,
      accepted_patterns: input.accepted_patterns ?? { keywords: [] },
      rejected_patterns: input.rejected_patterns ?? { keywords: [] },
      style_bias: input.style_bias ?? { tags: [] },
      confidence_calibration: input.confidence_calibration ?? {},
      evidence_preferences: input.evidence_preferences ?? { scopes: [] },
      last_feedback_summary: input.last_feedback_summary ?? null,
      last_refreshed_at: input.last_refreshed_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await upsertPersonaMemoryRow(payload);
    logger.info('MEMORY', 'persona memory upserted', {
      discordUserId: input.discord_user_id,
      personaName: input.persona_name
    });
  } catch (e: any) {
    logger.warn('MEMORY', 'persona memory upsert failed', {
      discordUserId: input.discord_user_id,
      personaName: input.persona_name,
      message: e?.message || String(e)
    });
  }
}

function mergeKeywordWeights(current: any, newKeywords: string[]): any {
  const existing: string[] = Array.isArray(current?.keywords) ? current.keywords : [];
  const merged = Array.from(new Set([...existing, ...newKeywords]));
  return { ...(current || {}), keywords: merged };
}

/** 피드백 기반 calibration 숫자 — 의사결정 가드 완화용이 아니라 소프트 가중치만. */
function clampCal(v: number): number {
  return Math.max(-0.1, Math.min(0.1, v));
}

function mergeRecordEMA(
  prev: Record<string, number> | undefined,
  deltas: Record<string, number>,
  retain: number
): Record<string, number> {
  const out: Record<string, number> = { ...(prev || {}) };
  for (const [k, d] of Object.entries(deltas)) {
    const oldV = out[k] ?? 0;
    out[k] = clampCal(oldV * retain + d * (1 - retain));
  }
  return out;
}

export async function refreshPersonaMemoryFromFeedback(
  discordUserId: string,
  personaName: string
): Promise<{ refreshed: boolean }> {
  try {
    logger.info('MEMORY', 'persona memory refresh started', { discordUserId, personaName });
    const current = await loadPersonaMemory(discordUserId, personaName);

    const { data: feedbackRows, error } = await supabase
      .from('analysis_feedback_history')
      .select('feedback_type,opinion_text,opinion_summary,created_at')
      .eq('discord_user_id', discordUserId)
      .eq('persona_name', personaName)
      .order('created_at', { ascending: false })
      .limit(40);

    if (error) throw error;

    const posTypes = new Set<FeedbackType>(['TRUSTED', 'ADOPTED', 'BOOKMARKED']);
    const negTypes = new Set<FeedbackType>(['DISLIKED', 'REJECTED']);

    const acceptedKeywords: string[] = [];
    const rejectedKeywords: string[] = [];
    const styleTags: string[] = [];
    const evidenceScopes: string[] = [];

    const topSummary = (feedbackRows || [])
      .map(r => r.opinion_summary ? String(r.opinion_summary) : null)
      .filter(Boolean)
      .slice(0, 1)[0] ?? null;

    for (const r of feedbackRows || []) {
      const ft = normalizeFeedbackType(String(r.feedback_type || ''));
      if (!ft) continue;
      const opinionText = String(r.opinion_text || '');
      if (isCommitteeSkippedPlaceholderResponse(opinionText)) continue;
      if (!opinionText.trim()) continue;

      const kws = extractKeywords(opinionText);
      const scopes = deriveEvidenceScopes(opinionText);
      const tags = deriveStyleBiasFromText(opinionText);

      if (posTypes.has(ft)) acceptedKeywords.push(...kws);
      if (negTypes.has(ft)) rejectedKeywords.push(...kws);
      styleTags.push(...tags);
      evidenceScopes.push(...scopes);
    }

    // claim_feedback 기반도 best-effort로 한 번 더 반영
    try {
      const { data: claimFbRows, error: cfErr } = await supabase
        .from('claim_feedback')
        .select('feedback_type,claim_id,created_at')
        .eq('discord_user_id', discordUserId)
        .order('created_at', { ascending: false })
        .limit(40);
      if (!cfErr && claimFbRows?.length) {
        const claimIds = claimFbRows.map((x: any) => x.claim_id).filter(Boolean);
        if (claimIds.length) {
          const { data: claims, error: claimErr } = await supabase
            .from('analysis_claims')
            .select(
              'id,persona_name,claim_text,claim_type,evidence_scope,has_numeric_anchor,is_actionable,is_downside_focused'
            )
            .in('id', claimIds);
          if (!claimErr && claims?.length) {
            const claimById = new Map<string, any>();
            for (const c of claims) claimById.set(String(c.id), c);
            const typeDeltas: Record<string, number> = {};
            const scopeDeltas: Record<string, number> = {};
            let numericW = 0;
            let actionableW = 0;
            let downsideW = 0;
            for (const cb of claimFbRows) {
              const claim = claimById.get(String(cb.claim_id));
              if (!claim) continue;
              if (String(claim.persona_name) !== personaName) continue;
              const ft = normalizeFeedbackType(String(cb.feedback_type || ''));
              if (!ft) continue;
              const kws = extractKeywords(String(claim.claim_text || ''));
              if (posTypes.has(ft)) acceptedKeywords.push(...kws);
              if (negTypes.has(ft)) rejectedKeywords.push(...kws);

              const w = posTypes.has(ft) ? 1 : negTypes.has(ft) ? -1 : 0;
              if (w === 0) continue;
              const ct = String(claim.claim_type || 'OTHER');
              const es = String(claim.evidence_scope || 'GENERAL');
              typeDeltas[ct] = (typeDeltas[ct] || 0) + w * 0.02;
              scopeDeltas[es] = (scopeDeltas[es] || 0) + w * 0.015;
              if (claim.has_numeric_anchor) numericW += w * 0.008;
              if (claim.is_actionable) actionableW += w * 0.008;
              if (claim.is_downside_focused) downsideW += w * 0.006;
            }

            const pcal = current.confidence_calibration || {};
            const mergedCal: Record<string, unknown> = {
              ...pcal,
              preferred_claim_types: mergeRecordEMA(
                (pcal as any).preferred_claim_types,
                typeDeltas,
                0.82
              ),
              preferred_evidence_scopes: mergeRecordEMA(
                (pcal as any).preferred_evidence_scopes,
                scopeDeltas,
                0.82
              ),
              numeric_anchor_bias: clampCal(
                Number((pcal as any).numeric_anchor_bias || 0) * 0.88 + numericW * 0.12
              ),
              actionable_bias: clampCal(
                Number((pcal as any).actionable_bias || 0) * 0.88 + actionableW * 0.12
              ),
              downside_bias: clampCal(
                Number((pcal as any).downside_bias || 0) * 0.88 + downsideW * 0.12
              ),
              conservatism_floor: 0.05
            };
            (current as any).__mergedCalibration = mergedCal;
          }
        }
      }
    } catch {
      // ignore: feedback refresh must not block
    }

    const acceptedUnique = capArray(Array.from(new Set(acceptedKeywords)), 20);
    const rejectedUnique = capArray(Array.from(new Set(rejectedKeywords)), 20);
    const styleUnique = capArray(Array.from(new Set(styleTags)), 10);
    const evidenceUnique = capArray(Array.from(new Set(evidenceScopes)), 10);

    const mergedCalibration =
      (current as any).__mergedCalibration !== undefined
        ? ((current as any).__mergedCalibration as Record<string, unknown>)
        : current.confidence_calibration || {};

    const next: PersonaMemory = {
      ...current,
      accepted_patterns: mergeKeywordWeights(current.accepted_patterns, acceptedUnique),
      rejected_patterns: mergeKeywordWeights(current.rejected_patterns, rejectedUnique),
      style_bias: { ...(current.style_bias || {}), tags: styleUnique },
      evidence_preferences: { ...(current.evidence_preferences || {}), scopes: evidenceUnique },
      confidence_calibration: mergedCalibration,
      last_feedback_summary: topSummary,
      last_refreshed_at: new Date().toISOString(),
      memory_version: (current.memory_version ?? 1) + 1
    };
    delete (current as any).__mergedCalibration;

    await upsertPersonaMemory(next);
    logger.info('MEMORY', 'persona memory refreshed', {
      discordUserId,
      personaName,
      acceptedCount: acceptedUnique.length,
      rejectedCount: rejectedUnique.length,
      styleTags: styleUnique
    });

    return { refreshed: true };
  } catch (e: any) {
    logger.warn('MEMORY', 'persona memory refresh failed', {
      discordUserId,
      personaName,
      message: e?.message || String(e)
    });
    return { refreshed: false };
  }
}

