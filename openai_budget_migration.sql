-- Preferred: isolated usage table for provider budget tracking
create table if not exists public.api_usage_tracking (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null,
  persona_name text not null,
  provider text not null,
  model text not null,
  input_tokens integer null,
  output_tokens integer null,
  estimated_cost_usd numeric(14, 8) not null default 0,
  year_month text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_api_usage_tracking_year_month_provider
  on public.api_usage_tracking (year_month, provider);

create index if not exists idx_api_usage_tracking_user_created
  on public.api_usage_tracking (discord_user_id, created_at desc);

-- Optional: extend existing trace table with provider metadata (safe if columns already exist)
alter table public.analysis_generation_trace
  add column if not exists provider_name text null,
  add column if not exists model_name text null,
  add column if not exists estimated_cost_usd numeric(14, 8) null;
