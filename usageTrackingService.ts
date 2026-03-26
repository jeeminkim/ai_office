import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { UsageTrackingRow } from './analysisTypes';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const OPENAI_PRICE_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-5-mini': { input: 0.25, output: 2.0 }
};

function getYearMonth(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function estimateOpenAiCost(params: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}): number {
  const price = OPENAI_PRICE_PER_1M_TOKENS[params.model] || OPENAI_PRICE_PER_1M_TOKENS['gpt-5-mini'];
  const inTokens = params.inputTokens || 0;
  const outTokens = params.outputTokens || 0;
  const estimated = (inTokens / 1_000_000) * price.input + (outTokens / 1_000_000) * price.output;
  const normalized = Math.max(0, Number(estimated.toFixed(8)));
  logger.info('OPENAI_BUDGET', 'estimated cost computed', {
    model: params.model,
    inputTokens: inTokens,
    outputTokens: outTokens,
    estimatedCostUsd: normalized
  });
  return normalized;
}

export async function recordApiUsage(params: Omit<UsageTrackingRow, 'year_month' | 'created_at'> & { yearMonth?: string }): Promise<void> {
  const yearMonth = params.yearMonth || getYearMonth();
  const row: any = {
    discord_user_id: params.discord_user_id,
    persona_name: params.persona_name,
    provider: params.provider,
    model: params.model,
    input_tokens: params.input_tokens ?? null,
    output_tokens: params.output_tokens ?? null,
    estimated_cost_usd: params.estimated_cost_usd,
    year_month: yearMonth
  };

  try {
    const { error } = await supabase.from('api_usage_tracking').insert(row);
    if (error) throw error;
    logger.info('OPENAI_BUDGET', 'api usage tracking saved', {
      personaName: params.persona_name,
      provider: params.provider,
      model: params.model,
      yearMonth,
      estimatedCostUsd: params.estimated_cost_usd
    });
  } catch (e: any) {
    logger.warn('OPENAI_BUDGET', 'api usage tracking failed', {
      personaName: params.persona_name,
      provider: params.provider,
      model: params.model,
      yearMonth,
      message: e?.message || String(e)
    });
  }
}

export async function getMonthlyUsageSummary(params?: {
  yearMonth?: string;
  provider?: 'openai' | 'gemini';
}): Promise<{ yearMonth: string; callCount: number; estimatedCostUsd: number }> {
  const yearMonth = params?.yearMonth || getYearMonth();
  const provider = params?.provider || 'openai';
  const { data, error, count } = await supabase
    .from('api_usage_tracking')
    .select('estimated_cost_usd', { count: 'exact' })
    .eq('year_month', yearMonth)
    .eq('provider', provider);

  if (error) {
    logger.warn('OPENAI_BUDGET', 'monthly usage summary query failed', {
      yearMonth,
      provider,
      message: error.message
    });
    return { yearMonth, callCount: 0, estimatedCostUsd: 0 };
  }

  const estimatedCostUsd = Number(
    ((data || []) as any[]).reduce((acc, row) => acc + Number(row?.estimated_cost_usd || 0), 0).toFixed(8)
  );
  return {
    yearMonth,
    callCount: count || 0,
    estimatedCostUsd
  };
}

export async function canUseOpenAiThisMonth(params?: {
  discordUserId?: string;
  personaName?: string;
}): Promise<{
  allowed: boolean;
  reason?: string;
  summary: { yearMonth: string; callCount: number; estimatedCostUsd: number; maxCalls: number; budgetUsd: number };
}> {
  const enforcementOn = (process.env.OPENAI_BUDGET_ENFORCEMENT || 'on').toLowerCase() !== 'off';
  const maxCalls = Number(process.env.OPENAI_MONTHLY_MAX_CALLS || '120');
  const budgetUsd = Number(process.env.OPENAI_MONTHLY_BUDGET_USD || '10');

  const monthly = await getMonthlyUsageSummary({ provider: 'openai' });
  const overCalls = monthly.callCount >= maxCalls;
  const overBudget = monthly.estimatedCostUsd >= budgetUsd;

  if (!enforcementOn) {
    logger.warn('OPENAI_BUDGET', 'budget enforcement disabled', {
      monthly,
      maxCalls,
      budgetUsd
    });
    return {
      allowed: true,
      summary: { ...monthly, maxCalls, budgetUsd }
    };
  }

  if (overCalls || overBudget) {
    const reason = overCalls ? 'monthly_max_calls_exceeded' : 'monthly_budget_exceeded';
    logger.warn('OPENAI_BUDGET', overCalls ? 'openai monthly max calls guard triggered' : 'openai monthly budget guard triggered', {
      discordUserId: params?.discordUserId || null,
      personaName: params?.personaName || null,
      currentMonthlyCalls: monthly.callCount,
      currentMonthlyEstimatedCostUsd: monthly.estimatedCostUsd,
      limitCalls: maxCalls,
      limitBudgetUsd: budgetUsd,
      reason,
      monthly,
      maxCalls,
      budgetUsd
    });
    return {
      allowed: false,
      reason,
      summary: { ...monthly, maxCalls, budgetUsd }
    };
  }

  logger.info('OPENAI_BUDGET', 'openai usage accepted', {
    discordUserId: params?.discordUserId || null,
    personaName: params?.personaName || null,
    currentMonthlyCalls: monthly.callCount,
    currentMonthlyEstimatedCostUsd: monthly.estimatedCostUsd,
    limitCalls: maxCalls,
    limitBudgetUsd: budgetUsd,
    monthly,
    maxCalls,
    budgetUsd
  });
  return {
    allowed: true,
    summary: { ...monthly, maxCalls, budgetUsd }
  };
}
