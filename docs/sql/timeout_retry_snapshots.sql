-- Timeout 재시도 스냅샷 (프로세스 재시작 후에도 버튼 유효)
CREATE TABLE IF NOT EXISTS public.timeout_retry_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_timeout_retry_snapshots_user ON public.timeout_retry_snapshots (discord_user_id);
CREATE INDEX IF NOT EXISTS idx_timeout_retry_snapshots_expires ON public.timeout_retry_snapshots (expires_at);

COMMENT ON TABLE public.timeout_retry_snapshots IS 'AI 분석 타임아웃 후 재시도 버튼용 payload (경량/요약 재실행)';
