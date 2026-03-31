import { repoSupabase } from './supabaseClient';
import { logger } from '../../logger';

export type DecisionSnapshotRow = {
  id: string;
  discord_user_id: string;
  chat_history_ref: string | null;
  analysis_type: string | null;
  persona_key: string | null;
  options: string[];
};

export async function insertDecisionSnapshot(params: {
  discordUserId: string;
  chatHistoryRef: string;
  analysisType: string;
  personaKey: string | null;
  options: string[];
}): Promise<{ id: string } | null> {
  const { data, error } = await repoSupabase
    .from('decision_snapshots')
    .insert({
      discord_user_id: params.discordUserId,
      chat_history_ref: params.chatHistoryRef,
      analysis_type: params.analysisType,
      persona_key: params.personaKey,
      options: params.options
    })
    .select('id')
    .maybeSingle();

  if (error) {
    logger.warn('DECISION', 'decision_snapshots insert failed', { message: error.message });
    return null;
  }
  const id = data?.id != null ? String(data.id) : '';
  return id ? { id } : null;
}

export async function getDecisionSnapshotById(id: string): Promise<DecisionSnapshotRow | null> {
  const { data, error } = await repoSupabase
    .from('decision_snapshots')
    .select('id, discord_user_id, chat_history_ref, analysis_type, persona_key, options')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) {
    if (error) logger.warn('DECISION', 'decision_snapshots select failed', { message: error.message });
    return null;
  }

  const raw = data as Record<string, unknown>;
  const opts = raw.options;
  const options = Array.isArray(opts) ? opts.map(o => String(o)) : [];

  return {
    id: String(raw.id),
    discord_user_id: String(raw.discord_user_id ?? ''),
    chat_history_ref: raw.chat_history_ref != null ? String(raw.chat_history_ref) : null,
    analysis_type: raw.analysis_type != null ? String(raw.analysis_type) : null,
    persona_key: raw.persona_key != null ? String(raw.persona_key) : null,
    options
  };
}

export async function insertDecisionHistoryRow(params: {
  discordUserId: string;
  chatHistoryRef: string | null;
  analysisType: string | null;
  selectedOption: string;
  optionIndex: number;
  decisionContext: Record<string, unknown>;
}): Promise<boolean> {
  const { error } = await repoSupabase.from('decision_history').insert({
    discord_user_id: params.discordUserId,
    chat_history_ref: params.chatHistoryRef,
    analysis_type: params.analysisType,
    selected_option: params.selectedOption,
    option_index: params.optionIndex,
    decision_context: params.decisionContext
  });

  if (error) {
    logger.warn('DECISION', 'decision_history insert failed', { message: error.message });
    return false;
  }
  logger.info('DECISION', 'DECISION_PERSISTED', {
    discordUserId: params.discordUserId,
    analysis_type: params.analysisType,
    selected_option: params.selectedOption,
    option_index: params.optionIndex
  });
  return true;
}
