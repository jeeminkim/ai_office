import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';
import { getPersonaModelConfig, generateWithPersonaProvider } from './llmProviderService';
import { canUseOpenAiThisMonth, estimateOpenAiCost, getMonthlyUsageSummary, recordApiUsage } from './usageTrackingService';
import { runAnalysisPipeline } from './analysisPipelineService';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const DISCORD_USER_ID = process.env.PHASE1_TEST_DISCORD_USER_ID || process.env.TEST_DISCORD_USER_ID || '';

function assertCondition(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

async function selfCheck() {
  if (!DISCORD_USER_ID) throw new Error('Missing PHASE1_TEST_DISCORD_USER_ID');

  // 1) Persona routing check
  const h = getPersonaModelConfig('HINDENBURG');
  const s = getPersonaModelConfig('SIMONS');
  const r = getPersonaModelConfig('RAY');
  assertCondition(h.provider === 'openai', 'HINDENBURG must route to openai');
  assertCondition(s.provider === 'openai', 'SIMONS must route to openai');
  assertCondition(r.provider === 'gemini', 'RAY must remain on gemini');
  logger.info('SELF_CHECK', 'persona routing verified', { h, s, r });

  // 2) Usage/cost utility check
  const estimated = estimateOpenAiCost({ model: 'gpt-5-mini', inputTokens: 1000, outputTokens: 500 });
  assertCondition(estimated >= 0, 'estimated cost should be non-negative');
  await recordApiUsage({
    discord_user_id: DISCORD_USER_ID,
    persona_name: 'James Simons (Quant)',
    provider: 'openai',
    model: 'gpt-5-mini',
    input_tokens: 1000,
    output_tokens: 500,
    estimated_cost_usd: estimated
  });
  const monthly = await getMonthlyUsageSummary({ provider: 'openai' });
  logger.info('SELF_CHECK', 'usage tracking summary checked', monthly);

  // 3) Fallback when OPENAI key missing
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const fallbackNoKey = await generateWithPersonaProvider({
    discordUserId: DISCORD_USER_ID,
    personaKey: 'HINDENBURG',
    personaName: 'HINDENBURG_ANALYST',
    prompt: '테스트 프롬프트',
    fallbackToGemini: async () => ({ text: 'fallback-ok-no-key', provider: 'gemini', model: 'gemini-2.5-flash' })
  });
  assertCondition(fallbackNoKey.provider === 'gemini', 'missing key must fallback to gemini');

  // 4) Fallback when monthly max calls exceeded
  process.env.OPENAI_API_KEY = oldKey || 'dummy-key';
  const oldMaxCalls = process.env.OPENAI_MONTHLY_MAX_CALLS;
  process.env.OPENAI_MONTHLY_MAX_CALLS = '0';
  process.env.OPENAI_BUDGET_ENFORCEMENT = 'on';
  const fallbackOverLimit = await generateWithPersonaProvider({
    discordUserId: DISCORD_USER_ID,
    personaKey: 'SIMONS',
    personaName: 'James Simons (Quant)',
    prompt: '테스트 프롬프트',
    fallbackToGemini: async () => ({ text: 'fallback-ok-limit', provider: 'gemini', model: 'gemini-2.5-flash' })
  });
  assertCondition(fallbackOverLimit.provider === 'gemini', 'over-limit must fallback to gemini');
  process.env.OPENAI_MONTHLY_MAX_CALLS = oldMaxCalls || '120';

  // 5) claim pipeline still works
  await runAnalysisPipeline({
    discordUserId: DISCORD_USER_ID,
    chatHistoryId: null,
    analysisType: 'openai_phase1_self_check',
    personaOutputs: [
      {
        personaKey: 'RAY',
        personaName: 'Ray Dalio (PB)',
        responseText: '리스크부터 점검하고 하방 시나리오를 우선 제시한다.',
        providerName: 'gemini',
        modelName: 'gemini-2.5-flash'
      }
    ],
    baseContext: { check: 'openai-phase1' }
  });
  const { data: claims, error } = await supabase
    .from('analysis_claims')
    .select('id')
    .eq('discord_user_id', DISCORD_USER_ID)
    .eq('analysis_type', 'openai_phase1_self_check')
    .limit(1);
  if (error) throw error;
  assertCondition((claims || []).length > 0, 'analysis_claims should still be stored');

  // 6) guard summary call
  const guardSummary = await canUseOpenAiThisMonth();
  logger.info('SELF_CHECK', 'guard summary', guardSummary);

  if (oldKey !== undefined) process.env.OPENAI_API_KEY = oldKey;
  logger.info('SELF_CHECK', 'openai mixed operation self-check done');
}

selfCheck().catch((e) => {
  logger.error('SELF_CHECK', 'openai mixed operation self-check failed', e);
  process.exit(1);
});
