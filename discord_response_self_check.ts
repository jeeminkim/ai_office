import { splitDiscordMessage, chooseInteractionRoute } from './discordResponseUtils';
import { buildPortfolioDiscordMessage } from './portfolioUx';

function assertCondition(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

function makeLongText(len: number): string {
  return Array.from({ length: len }, (_, i) => (i % 70 === 0 ? '\n' : 'A')).join('');
}

async function selfCheck() {
  // 1) 2500+ text chunking
  const long = makeLongText(2600);
  const chunks = splitDiscordMessage(long, 1800);
  assertCondition(chunks.length >= 2, 'Long content must be chunked');
  assertCondition(chunks.every((c) => c.length <= 1800), 'Each chunk must be <= 1800');

  // 2) defer/edit route expectation
  assertCondition(chooseInteractionRoute({ deferred: true, replied: false }) === 'editReply', 'Deferred route should be editReply');

  // 3) replied -> followUp fallback expectation
  assertCondition(chooseInteractionRoute({ deferred: false, replied: true }) === 'followUp', 'Replied route should be followUp');

  // 4) quote partial failure warning UX check
  const msg = buildPortfolioDiscordMessage(
    {
      meta: { scope: 'DEFAULT', account_id: 'acc' },
      summary: {
        total_market_value_krw: 1000000,
        total_cost_basis_krw: 900000,
        total_pnl_krw: 100000,
        total_return_pct: 11.11,
        position_count: 1,
        top3_weight_pct: 100,
        domestic_weight_pct: 100,
        us_weight_pct: 0,
        quote_failure_count: 3,
        degraded_quote_mode: true
      },
      positions: []
    },
    {
      viewMode: 'default',
      generalAccountName: '일반계좌',
      snapshotFooter: 'none',
      hideAggregateAccountBreakdown: true
    }
  );
  assertCondition(msg.includes('실시간 시세 조회가 실패'), 'Degraded quote warning must be present');

  // 5) simulated long responses for portfolio/trend/ai should chunk safely
  const longPortfolio = splitDiscordMessage(`## Portfolio\n${makeLongText(3500)}`, 1800);
  const longTrend = splitDiscordMessage(`## Trend\n${makeLongText(4200)}`, 1800);
  const longAi = splitDiscordMessage(`## AI\n${makeLongText(5100)}`, 1800);
  assertCondition(longPortfolio.length > 1 && longTrend.length > 1 && longAi.length > 1, 'portfolio/trend/ai long outputs must split');

  console.log('discord_response_self_check: OK');
}

selfCheck().catch((e) => {
  console.error('discord_response_self_check: FAILED', e);
  process.exit(1);
});
