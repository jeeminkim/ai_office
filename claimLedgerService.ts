import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { ClaimType, EvidenceScope, PersonaMemory } from './analysisTypes';
import type { AnalysisClaim, AnalysisGenerationTrace } from './analysisTypes';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

function roundScore(v: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

function detectHasNumericAnchor(text: string): boolean {
  return /\d/.test(String(text || '')) || /%|USD|KRW|원|₩/.test(String(text || ''));
}

function detectActionable(text: string): boolean {
  return /(하세요|제안|실행|액션|계획|체크리스트|구체적|매수|매도|보유|점검|확인)/i.test(String(text || ''));
}

function detectDownsideFocused(text: string): boolean {
  return /(리스크|downside|손실|최악|변동성|경고|주의|fail|drawdown)/i.test(String(text || ''));
}

const CLAIM_TYPES: ClaimType[] = [
  'MACRO',
  'RISK',
  'ALLOCATION',
  'EXECUTION',
  'VALUATION',
  'BEHAVIOR',
  'LIQUIDITY',
  'OPEN_TOPIC',
  'OTHER'
];

function inferClaimType(text: string, analysisType: string): ClaimType {
  const t = String(text || '');
  const lower = t.toLowerCase();
  if (/(downside|리스크|손실|변동성|경고|최악)/i.test(t)) return 'RISK';
  if (/(배분|비중|allocation|리밸런싱|target allocation)/i.test(t)) return 'ALLOCATION';
  if (/(실행|액션|계획|체크리스트|매수|매도|do |action)/i.test(lower)) return 'EXECUTION';
  if (/(밸류|valuation|평가|평단|p\/e|per|discount)/i.test(lower)) return 'VALUATION';
  if (/(유동성|현금흐름|cashflow)/i.test(lower)) return 'LIQUIDITY';
  if (/(행동|심리|bias|behavior)/i.test(lower)) return 'BEHAVIOR';
  if (analysisType.includes('open_topic') || /(오픈|topic only)/i.test(lower)) return 'OPEN_TOPIC';
  return 'OTHER';
}

function inferEvidenceScope(text: string): EvidenceScope {
  const t = String(text || '');
  if (/(현금흐름|cashflow)/i.test(t)) return 'CASHFLOW';
  if (/(지출|expense|spending)/i.test(t)) return 'EXPENSE';
  if (/(포트폴리오|비중|allocation|평단|손익)/i.test(t)) return 'PORTFOLIO';
  if (/(시장|macroeconom|macro|금리|환율)/i.test(t)) return 'MARKET';
  return /(none|해당없음|언급 없음)/i.test(t) ? 'NONE' : 'GENERAL';
}

function extractClaimLines(text: string): string[] {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];

  const lines = t
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

  // Heuristic: treat bullets/numbered/headings as potential claim boundaries.
  const out: string[] = [];
  let buf: string[] = [];

  const isBoundary = (line: string) => {
    return (
      /^(\d+\.|\- |\* |\• |[A-Z][A-Z0-9 _-]{2,}:|#{1,6}\s)/.test(line) ||
      /\b(결론|요약|핵심|리스크|전략|실행|배분|평가|손익)\b/i.test(line)
    );
  };

  const flush = () => {
    if (!buf.length) return;
    const claim = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (claim) out.push(claim);
    buf = [];
  };

  for (const line of lines) {
    if (isBoundary(line) && buf.length) {
      flush();
    }
    buf.push(line);
  }
  flush();
  return out.slice(0, 20);
}

function toOpinionSummary(text: string, maxLen = 220): string {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

export function extractClaimsFromResponse(params: {
  responseText: string;
  analysisType: string;
  personaName: string;
  maxClaims?: number;
}): Array<{
  claim_order: number;
  claim_type: ClaimType;
  claim_text: string;
  claim_summary: string;
  evidence_scope: EvidenceScope;
  evidence_refs?: any;
  confidence_score: number;
  novelty_score: number;
  usefulness_score: number;
  has_numeric_anchor: boolean;
  is_actionable: boolean;
  is_downside_focused: boolean;
}> {
  const { responseText, analysisType, personaName } = params;
  const maxClaims = params.maxClaims ?? 12;

  try {
    const lines = extractClaimLines(responseText).slice(0, maxClaims);
    if (!lines.length) throw new Error('No claim lines found');

    const claims = lines.map((claimText, idx) => {
      const claim_type = inferClaimType(claimText, analysisType);
      const evidence_scope = inferEvidenceScope(claimText);
      const has_numeric_anchor = detectHasNumericAnchor(claimText);
      const is_actionable = detectActionable(claimText);
      const is_downside_focused = detectDownsideFocused(claimText);

      const confidence_score = roundScore(
        0.55 +
          (has_numeric_anchor ? 0.15 : 0) +
          (is_actionable ? 0.1 : 0) +
          (is_downside_focused ? 0.08 : 0)
      );

      const novelty_score = roundScore(0.4 + (claim_type === 'OTHER' ? -0.05 : 0.05));
      const usefulness_score = roundScore(0.45 + (evidence_scope === 'PORTFOLIO' ? 0.1 : 0.03));

      return {
        claim_order: idx + 1,
        claim_type,
        claim_text: claimText,
        claim_summary: toOpinionSummary(claimText, 180),
        evidence_scope,
        evidence_refs: null,
        confidence_score,
        novelty_score,
        usefulness_score,
        has_numeric_anchor,
        is_actionable,
        is_downside_focused
      };
    });

    logger.info('CLAIMS', 'claims extracted', {
      personaName,
      analysisType,
      claimCount: claims.length
    });
    return claims;
  } catch (e: any) {
    logger.warn('CLAIMS', 'claim extraction fallback used', {
      analysisType,
      personaName,
      message: e?.message || String(e)
    });
    const text = String(responseText || '');
    const claim_type = inferClaimType(text, analysisType);
    const evidence_scope = inferEvidenceScope(text);
    return [
      {
        claim_order: 1,
        claim_type,
        claim_text: text,
        claim_summary: toOpinionSummary(text, 220),
        evidence_scope,
        evidence_refs: null,
        confidence_score: 0.35,
        novelty_score: 0.25,
        usefulness_score: 0.3,
        has_numeric_anchor: detectHasNumericAnchor(text),
        is_actionable: detectActionable(text),
        is_downside_focused: detectDownsideFocused(text)
      }
    ];
  }
}

export async function saveClaims(params: {
  discordUserId: string;
  chatHistoryId: number | null;
  analysisType: string;
  personaName: string;
  claims: ReturnType<typeof extractClaimsFromResponse>;
}): Promise<{ savedCount: number; savedClaimIds: string[] }> {
  const { discordUserId, chatHistoryId, analysisType, personaName, claims } = params;

  if (!claims.length) return { savedCount: 0, savedClaimIds: [] };

  try {
    const rows = claims.map(c => ({
      discord_user_id: discordUserId,
      chat_history_id: chatHistoryId,
      analysis_type: analysisType,
      persona_name: personaName,
      claim_order: c.claim_order,
      claim_type: c.claim_type,
      claim_text: c.claim_text,
      claim_summary: c.claim_summary,
      evidence_scope: c.evidence_scope,
      evidence_refs: c.evidence_refs ?? {},
      confidence_score: c.confidence_score,
      novelty_score: c.novelty_score,
      usefulness_score: c.usefulness_score,
      has_numeric_anchor: c.has_numeric_anchor,
      is_actionable: c.is_actionable,
      is_downside_focused: c.is_downside_focused
    }));

    const { data, error } = await supabase.from('analysis_claims').insert(rows).select('id');
    if (error) throw error;
    const ids = (data || []).map((d: any) => String(d.id));
    logger.info('CLAIMS', 'claims saved', { discordUserId, analysisType, personaName, savedCount: ids.length });
    return { savedCount: ids.length, savedClaimIds: ids };
  } catch (e: any) {
    logger.warn('CLAIMS', 'claims saved failed', {
      discordUserId,
      analysisType,
      personaName,
      message: e?.message || String(e)
    });
    return { savedCount: 0, savedClaimIds: [] };
  }
}

export async function saveClaimOutcomeAuditSkeleton(params: {
  discordUserId: string;
  claimId: string;
}): Promise<void> {
  // Phase 1: audit is a best-effort skeleton (must not block analysis).
  try {
    await supabase.from('claim_outcome_audit').insert({
      discord_user_id: params.discordUserId,
      claim_id: params.claimId,
      audit_status: 'CREATED',
      audit_note: null,
      audited_by: 'system',
      audited_at: new Date().toISOString()
    });
  } catch {
    // ignore
  }
}

export function computeOverlapScore(haystack: string, needles: string[]): number {
  const h = String(haystack || '').toLowerCase();
  let score = 0;
  for (const n of needles) {
    const k = String(n || '').trim().toLowerCase();
    if (!k) continue;
    if (h.includes(k)) score += 1;
  }
  return score;
}

export function normalizeForOverlap(text: string): string {
  return String(text || '')
    .replace(/[^\w가-힣%$€£¥\.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function selectBestClaimForFeedback(params: {
  discordUserId: string;
  chatHistoryId: number;
  analysisType: string;
  personaName: string;
  feedbackOpinionText: string;
}): Promise<AnalysisClaim | null> {
  const { discordUserId, chatHistoryId, analysisType, personaName, feedbackOpinionText } = params;

  try {
    const { data, error } = await supabase
      .from('analysis_claims')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .eq('chat_history_id', chatHistoryId)
      .eq('analysis_type', analysisType)
      .eq('persona_name', personaName)
      .order('claim_order', { ascending: true })
      .limit(12);
    if (error) throw error;

    const claims = (data || []) as any[];
    if (!claims.length) return null;

    const opinionText = String(feedbackOpinionText || '');
    const needles = extractClaimLines(opinionText).slice(0, 6);
    const scored = claims.map(c => {
      const hay = `${c.claim_summary}\n${c.claim_text}`;
      const score = computeOverlapScore(hay, needles) + (c.has_numeric_anchor ? 0.2 : 0) + (c.is_actionable ? 0.1 : 0);
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].c as AnalysisClaim;
  } catch (e: any) {
    logger.warn('CLAIMS', 'best claim selection failed', {
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      message: e?.message || String(e)
    });
    return null;
  }
}

export async function resolveClaimMappingForFeedback(params: {
  discordUserId: string;
  chatHistoryId: number;
  analysisType: string;
  personaName: string;
  feedbackOpinionText: string;
  preferredClaimId?: string | null;
}): Promise<{
  bestClaimId: string | null;
  mappingMethod: 'direct_claim_id' | 'scored_candidate' | 'legacy_only';
  mappingScore: number | null;
  candidateCount: number;
}> {
  const { discordUserId, chatHistoryId, analysisType, personaName, feedbackOpinionText, preferredClaimId } = params;
  try {
    const { data, error } = await supabase
      .from('analysis_claims')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .eq('chat_history_id', chatHistoryId)
      .eq('analysis_type', analysisType)
      .eq('persona_name', personaName)
      .order('created_at', { ascending: false })
      .order('claim_order', { ascending: true })
      .limit(20);
    if (error) throw error;
    const candidates = (data || []) as any[];
    if (!candidates.length) {
      logger.warn('FEEDBACK', 'feedback mapping legacy only', {
        discordUserId,
        chatHistoryId,
        analysisType,
        personaName,
        reason: 'no_candidates'
      });
      return { bestClaimId: null, mappingMethod: 'legacy_only', mappingScore: null, candidateCount: 0 };
    }

    if (preferredClaimId) {
      const direct = candidates.find(c => String(c.id) === String(preferredClaimId));
      if (direct?.id) {
        logger.info('FEEDBACK', 'feedback mapping direct hit', {
          discordUserId,
          chatHistoryId,
          analysisType,
          personaName,
          claimId: direct.id
        });
        return {
          bestClaimId: String(direct.id),
          mappingMethod: 'direct_claim_id',
          mappingScore: 1,
          candidateCount: candidates.length
        };
      }
    }

    const opinionText = String(feedbackOpinionText || '');
    const needles = extractClaimLines(opinionText).slice(0, 6);
    const latestCreatedAt = Date.parse(String(candidates[0]?.created_at || new Date().toISOString()));
    const targetOrder = Number(candidates[0]?.claim_order || 1);

    const scored = candidates.map((c: any) => {
      const hay = `${c.claim_summary}\n${c.claim_text}`;
      const overlap = computeOverlapScore(hay, needles);
      const samePersonaBonus = 0.2;
      const sameAnalysisTypeBonus = 0.2;
      const recentMs = Math.max(1, latestCreatedAt - Date.parse(String(c.created_at || candidates[0]?.created_at)));
      const recentBonus = Math.max(0, 0.6 - recentMs / (1000 * 60 * 60 * 24));
      const orderGap = Math.abs(Number(c.claim_order || targetOrder) - targetOrder);
      const orderBonus = Math.max(0, 0.4 - orderGap * 0.08);
      const rawScore = overlap + samePersonaBonus + sameAnalysisTypeBonus + recentBonus + orderBonus;
      return { c, score: Number(rawScore.toFixed(4)) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top?.c?.id) {
      logger.warn('FEEDBACK', 'feedback mapping legacy only', {
        discordUserId,
        chatHistoryId,
        analysisType,
        personaName,
        reason: 'empty_scored_top'
      });
      return { bestClaimId: null, mappingMethod: 'legacy_only', mappingScore: null, candidateCount: candidates.length };
    }

    logger.info('FEEDBACK', 'feedback mapping scored candidate', {
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      claimId: top.c.id,
      mappingScore: top.score,
      candidateCount: candidates.length
    });
    return {
      bestClaimId: String(top.c.id),
      mappingMethod: 'scored_candidate',
      mappingScore: top.score,
      candidateCount: candidates.length
    };
  } catch (e: any) {
    logger.warn('FEEDBACK', 'feedback mapping legacy only', {
      discordUserId,
      chatHistoryId,
      analysisType,
      personaName,
      reason: e?.message || String(e)
    });
    return { bestClaimId: null, mappingMethod: 'legacy_only', mappingScore: null, candidateCount: 0 };
  }
}

