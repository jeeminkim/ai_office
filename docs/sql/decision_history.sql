-- Decision snapshots (button customId references this id; options stored server-side — no message re-parse)
-- Run in Supabase SQL editor after review.

CREATE TABLE IF NOT EXISTS decision_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id TEXT NOT NULL,
  chat_history_ref TEXT,
  analysis_type TEXT,
  persona_key TEXT,
  options JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_snapshots_user ON decision_snapshots (discord_user_id);
CREATE INDEX IF NOT EXISTS idx_decision_snapshots_created ON decision_snapshots (created_at DESC);

COMMENT ON TABLE decision_snapshots IS 'Discord decision buttons: options snapshot at broadcast time (customId decision:select|snapshotId|idx).';

-- Persisted user selections (advisory only; no trade execution)
CREATE TABLE IF NOT EXISTS decision_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id TEXT NOT NULL,
  chat_history_ref TEXT,
  analysis_type TEXT,
  selected_option TEXT NOT NULL,
  option_index INTEGER,
  decision_context JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_history_user ON decision_history (discord_user_id);
CREATE INDEX IF NOT EXISTS idx_decision_history_created ON decision_history (created_at DESC);

COMMENT ON TABLE decision_history IS 'User decision button selections; JSONB context includes options snapshot and routing hints.';
