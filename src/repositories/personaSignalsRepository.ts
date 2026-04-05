import { repoSupabase } from './supabaseClient';

const POS = new Set(['TRUSTED', 'ADOPTED', 'BOOKMARKED']);
const NEG = new Set(['DISLIKED', 'REJECTED']);

export type PersonaSignalHints = {
  feedbackByPersonaName: Record<string, { pos: number; neg: number }>;
  claimFeedbackByPersonaName: Record<string, { pos: number; neg: number }>;
  recentFeedbackSummary: string;
  recentAccuracyHint: string;
};

function bump(
  map: Record<string, { pos: number; neg: number }>,
  personaName: string,
  ft: string
): void {
  const n = String(personaName || '').trim();
  if (!n) return;
  if (!map[n]) map[n] = { pos: 0, neg: 0 };
  if (POS.has(ft)) map[n].pos += 1;
  else if (NEG.has(ft)) map[n].neg += 1;
}

function summarizeCounts(map: Record<string, { pos: number; neg: number }>, maxKeys = 6): string {
  const keys = Object.keys(map).slice(0, maxKeys);
  if (!keys.length) return 'none';
  return keys
    .map(k => {
      const v = map[k];
      return `${k.slice(0, 24)}:+${v.pos}/-${v.neg}`;
    })
    .join('; ');
}

/**
 * 기존 테이블만 사용 — 최근 피드백·클레임 피드백으로 위원 가중치 보조 신호.
 */
export async function loadPersonaWeightSignalHints(discordUserId: string): Promise<PersonaSignalHints> {
  const empty: PersonaSignalHints = {
    feedbackByPersonaName: {},
    claimFeedbackByPersonaName: {},
    recentFeedbackSummary: 'none',
    recentAccuracyHint: 'none'
  };

  try {
    const { data: fbRows, error: fbErr } = await repoSupabase
      .from('analysis_feedback_history')
      .select('persona_name,feedback_type')
      .eq('discord_user_id', discordUserId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!fbErr && fbRows?.length) {
      for (const r of fbRows) {
        bump(
          empty.feedbackByPersonaName,
          String((r as { persona_name?: string }).persona_name || ''),
          String((r as { feedback_type?: string }).feedback_type || '')
        );
      }
      empty.recentFeedbackSummary = summarizeCounts(empty.feedbackByPersonaName);
    }

    const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: cfRows, error: cfErr } = await repoSupabase
      .from('claim_feedback')
      .select('claim_id,feedback_type')
      .eq('discord_user_id', discordUserId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(80);

    if (!cfErr && cfRows?.length) {
      const ids = [...new Set(cfRows.map((x: { claim_id?: string }) => x.claim_id).filter(Boolean))] as string[];
      if (ids.length) {
        const { data: claims, error: clErr } = await repoSupabase
          .from('analysis_claims')
          .select('id,persona_name')
          .in('id', ids);

        if (!clErr && claims?.length) {
          const personaByClaim = new Map<string, string>();
          for (const c of claims as { id: string; persona_name?: string }[]) {
            personaByClaim.set(String(c.id), String(c.persona_name || ''));
          }

          for (const r of cfRows as { claim_id?: string; feedback_type?: string }[]) {
            const pn = personaByClaim.get(String(r.claim_id || ''));
            if (!pn) continue;
            bump(empty.claimFeedbackByPersonaName, pn, String(r.feedback_type || ''));
          }
          empty.recentAccuracyHint = summarizeCounts(empty.claimFeedbackByPersonaName);
        }
      }
    }

    return empty;
  } catch {
    return empty;
  }
}
