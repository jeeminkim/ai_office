-- 1) claim_feedback concurrent duplicate 방어
create unique index if not exists uq_claim_feedback_user_claim_type
  on public.claim_feedback (discord_user_id, claim_id, feedback_type);

-- 2) analysis_feedback_history 매핑 메타데이터 확장
alter table public.analysis_feedback_history
  add column if not exists mapped_claim_id uuid null,
  add column if not exists mapping_method text null,
  add column if not exists mapping_score numeric null;

-- Optional FK (데이터 품질 강화, 기존 데이터와 충돌 없을 때만 적용 권장)
-- alter table public.analysis_feedback_history
--   add constraint fk_analysis_feedback_history_mapped_claim
--   foreign key (mapped_claim_id) references public.analysis_claims(id);
