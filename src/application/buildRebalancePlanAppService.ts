import type { PortfolioSnapshot, PortfolioPositionSnapshot } from '../../portfolioService';
import type { DecisionArtifact, DecisionType } from '../contracts/decisionContract';
import { getUsdKrwRate } from '../../fxService';
import { insertRebalancePlanRecord, type RebalancePlanItemRow } from '../repositories/rebalancePlanRepository';
import { logger } from '../../logger';

/** KRW — ignore micro-trades to reduce churn */
const MIN_TRADE_KRW_DEFAULT = 150_000;
/** Absolute weight band (percentage points) before acting */
const WEIGHT_BAND_PP = 2.0;
/** Max single-name target weight (%) */
const CAP_SINGLE_NAME_PP = 28;
/** Floor single-name target (%) */
const FLOOR_NAME_PP = 3;

export type BuildRebalancePlanParams = {
  discordUserId: string;
  snapshot: PortfolioSnapshot;
  decisionArtifact: DecisionArtifact | null;
  userMode?: 'SAFE' | 'BALANCED' | 'AGGRESSIVE';
  chatHistoryId: number | null;
  analysisType: string | null;
  minTradeKrw?: number;
  /** Skip DB persist (dry run) */
  dryRun?: boolean;
  /**
   * Advisory-only tilt for planning (does not change stored committee artifact).
   * Used when user picks e.g. immediate vs staged sell from Discord buttons.
   */
  advisoryOverride?: { decision: DecisionType; normalizedScore?: number };
};

export type RebalancePlanLine = {
  symbol: string;
  display_name: string;
  side: 'SELL' | 'BUY';
  quantity: number;
  estimated_price: number;
  estimated_amount_krw: number;
  rationale: string;
  market: 'KR' | 'US';
  quote_symbol: string | null;
};

export type BuildRebalancePlanResult = {
  planId: string | null;
  header: string;
  lines: RebalancePlanLine[];
  summary: {
    before_weights: Record<string, number>;
    after_weights_est: Record<string, number>;
    cash_impact_krw: number;
    fx_usdkrw: number;
    drift_reduction_pp: number;
  };
  discordText: string;
  persistError: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function priceKrwPerShare(p: PortfolioPositionSnapshot): number {
  const mv = p.market_value_krw;
  const q = p.quantity || 1;
  return q > 0 ? mv / q : p.current_price * (p.fx_rate_to_krw || 1);
}

/**
 * Equal-weight target with caps; decision tilts band only (does not replace risk gates).
 */
function computeTargetWeights(
  positions: PortfolioPositionSnapshot[],
  decision: DecisionType | null,
  normalizedScore: number
): { targets: Record<string, number>; bandBoost: number } {
  const n = positions.length;
  if (n === 0) return { targets: {}, bandBoost: 0 };

  const eq = 100 / n;
  const targets: Record<string, number> = {};
  /** Slightly wider band when committee is neutral — less trading */
  let bandBoost = 0;
  if (decision === 'NO_ACTION' || decision === 'HOLD') bandBoost = 1.5;
  if (decision === 'REDUCE' || decision === 'EXIT') bandBoost = -0.5;
  if (decision === 'ADD' || decision === 'BUY') bandBoost = -1;
  if (Number.isFinite(normalizedScore)) {
    if (normalizedScore > 0.25) bandBoost -= 0.3;
    if (normalizedScore < -0.25) bandBoost += 0.4;
  }

  for (const p of positions) {
    let t = eq;
    const w = p.weight_pct;
    if (w > eq + 8) t = Math.max(eq, Math.min(CAP_SINGLE_NAME_PP, w - 4));
    else if (w < eq - 5) t = Math.min(CAP_SINGLE_NAME_PP, Math.max(FLOOR_NAME_PP, w + 3));
    else t = Math.min(CAP_SINGLE_NAME_PP, Math.max(FLOOR_NAME_PP, eq));
    targets[p.symbol] = round2(t);
  }

  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - 100) > 0.01) {
    const scale = 100 / sum;
    for (const k of Object.keys(targets)) targets[k] = round2(targets[k] * scale);
  }

  return { targets, bandBoost };
}

function buildLines(
  positions: PortfolioPositionSnapshot[],
  totalMv: number,
  targets: Record<string, number>,
  band: number,
  minTradeKrw: number,
  decision: DecisionType | null
): RebalancePlanLine[] {
  const lines: RebalancePlanLine[] = [];
  const posBySym = new Map(positions.map(p => [p.symbol, p]));

  for (const p of positions) {
    const tw = targets[p.symbol] ?? 0;
    const curW = p.weight_pct;
    const deltaW = curW - tw;
    const effBand = Math.max(WEIGHT_BAND_PP, band);
    if (Math.abs(deltaW) < effBand) continue;

    const px = priceKrwPerShare(p);
    if (!(px > 0) || !(totalMv > 0)) continue;

    const targetMv = (tw / 100) * totalMv;
    const curMv = p.market_value_krw;
    const mvDelta = targetMv - curMv;
    if (Math.abs(mvDelta) < minTradeKrw) continue;

    if (mvDelta < 0) {
      const sellMv = Math.min(Math.abs(mvDelta), curMv - minTradeKrw * 0.25);
      if (sellMv < minTradeKrw) continue;
      let qty = Math.floor(sellMv / px);
      if (qty < 1) continue;
      qty = Math.min(qty, Math.floor(p.quantity));
      if (qty < 1) continue;
      const amt = qty * px;
      lines.push({
        symbol: p.symbol,
        display_name: p.display_name,
        side: 'SELL',
        quantity: qty,
        estimated_price: round2(px),
        estimated_amount_krw: round2(amt),
        rationale: `비중 ${round2(curW)}% → 목표 ${round2(tw)}% 근접 (${decision ?? 'N/A'} 반영, 밴드 ${effBand}pp)`,
        market: p.market,
        quote_symbol: p.quote_symbol
      });
    } else {
      const buyMv = mvDelta;
      if (buyMv < minTradeKrw) continue;
      let qty = Math.floor(buyMv / px);
      if (qty < 1) continue;
      const amt = qty * px;
      lines.push({
        symbol: p.symbol,
        display_name: p.display_name,
        side: 'BUY',
        quantity: qty,
        estimated_price: round2(px),
        estimated_amount_krw: round2(amt),
        rationale: `비중 ${round2(curW)}% → 목표 ${round2(tw)}% 근접`,
        market: p.market,
        quote_symbol: p.quote_symbol
      });
    }
  }

  lines.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'SELL' ? -1 : 1;
    return b.estimated_amount_krw - a.estimated_amount_krw;
  });

  return lines;
}

function estimateAfterWeights(
  positions: PortfolioPositionSnapshot[],
  lines: RebalancePlanLine[],
  totalMv: number
): Record<string, number> {
  const adj = new Map<string, number>();
  for (const p of positions) adj.set(p.symbol, p.market_value_krw);
  for (const ln of lines) {
    const cur = adj.get(ln.symbol) ?? 0;
    if (ln.side === 'SELL') adj.set(ln.symbol, Math.max(0, cur - ln.estimated_amount_krw));
    else adj.set(ln.symbol, cur + ln.estimated_amount_krw);
  }
  const sum = [...adj.values()].reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (!(sum > 0)) return out;
  for (const [sym, mv] of adj) {
    out[sym] = round2((mv / sum) * 100);
  }
  return out;
}

function driftVsTarget(weightsBySymbol: Record<string, number>, targets: Record<string, number>, symbols: string[]): number {
  let s = 0;
  for (const sym of symbols) {
    s += Math.abs((weightsBySymbol[sym] ?? 0) - (targets[sym] ?? 0));
  }
  return round2(s);
}

export function formatRebalancePlanDiscord(params: {
  header: string;
  lines: RebalancePlanLine[];
  summary: BuildRebalancePlanResult['summary'];
  rationaleThreeLines: string[];
}): string {
  const parts: string[] = [];
  parts.push(`## ${params.header}`);
  parts.push('');
  parts.push(`- 기준 환율 USD/KRW: **${params.summary.fx_usdkrw.toFixed(2)}**`);
  parts.push(`- 예상 현금 임팩트(매도−매수): **${params.summary.cash_impact_krw.toLocaleString('ko-KR')} KRW**`);
  parts.push(`- 드리프트 감소(추정): **${params.summary.drift_reduction_pp} pp**`);
  parts.push('');
  if (params.lines.length === 0) {
    parts.push('_(거래 제안 없음 — 최소 금액/밴드 또는 스냅샷 조건 미충족)_');
  } else {
    parts.push('### 제안 라인');
    for (const ln of params.lines) {
      const side = ln.side === 'SELL' ? '매도' : '매수';
      parts.push(
        `- **${side}** \`${ln.display_name || ln.symbol}\` (${ln.symbol}) **${ln.quantity}주** @ ~${ln.estimated_price.toLocaleString('ko-KR')} → ~${ln.estimated_amount_krw.toLocaleString('ko-KR')} KRW`
      );
      parts.push(`  - _${ln.rationale}_`);
    }
  }
  parts.push('');
  parts.push('### 왜 이 액션인가 (3줄)');
  for (const t of params.rationaleThreeLines) parts.push(`- ${t}`);
  parts.push('');
  parts.push(
    '_자동 주문 없음. HTS/MTS에서 직접 체결한 뒤 「리밸런싱 완료」를 눌러 기록을 반영하세요._'
  );
  return parts.join('\n');
}

export async function buildRebalancePlanAppService(params: BuildRebalancePlanParams): Promise<BuildRebalancePlanResult> {
  const minKrw = params.minTradeKrw ?? MIN_TRADE_KRW_DEFAULT;
  const positions = params.snapshot.positions || [];
  const totalMv = params.snapshot.summary.total_market_value_krw;
  const fx = await getUsdKrwRate();

  const beforeW: Record<string, number> = {};
  for (const p of positions) beforeW[p.symbol] = round2(p.weight_pct);

  const decision =
    params.advisoryOverride?.decision ?? params.decisionArtifact?.decision ?? null;
  const norm =
    params.advisoryOverride?.normalizedScore ?? params.decisionArtifact?.normalizedScore ?? 0;

  if (!positions.length || totalMv <= 0) {
    const empty: BuildRebalancePlanResult = {
      planId: null,
      header: '리밸런싱 실행안 (스냅샷 없음)',
      lines: [],
      summary: {
        before_weights: beforeW,
        after_weights_est: {},
        cash_impact_krw: 0,
        fx_usdkrw: fx,
        drift_reduction_pp: 0
      },
      discordText: '포지션이 없어 리밸런싱 실행안을 만들 수 없습니다.',
      persistError: null
    };
    return empty;
  }

  if (decision === 'NO_ACTION') {
    const empty: BuildRebalancePlanResult = {
      planId: null,
      header: '리밸런싱 실행안 (위원회 NO_ACTION)',
      lines: [],
      summary: {
        before_weights: beforeW,
        after_weights_est: beforeW,
        cash_impact_krw: 0,
        fx_usdkrw: fx,
        drift_reduction_pp: 0
      },
      discordText:
        '위원회 결론이 **NO_ACTION** 이라 자동 제안을 생략했습니다. (게이트·veto는 약화되지 않음)',
      persistError: null
    };
    return empty;
  }

  const { targets, bandBoost } = computeTargetWeights(positions, decision, norm);
  const lines = buildLines(positions, totalMv, targets, WEIGHT_BAND_PP + bandBoost, minKrw, decision);

  const sellKrw = lines.filter(l => l.side === 'SELL').reduce((a, l) => a + l.estimated_amount_krw, 0);
  const buyKrw = lines.filter(l => l.side === 'BUY').reduce((a, l) => a + l.estimated_amount_krw, 0);
  const cashImpact = round2(sellKrw - buyKrw);

  const afterW = estimateAfterWeights(positions, lines, totalMv);
  const syms = positions.map(p => p.symbol);
  const driftBefore = driftVsTarget(beforeW, targets, syms);
  const driftAfter = driftVsTarget(afterW, targets, syms);
  const driftReduction = Math.max(0, round2(driftBefore - driftAfter));

  const mode = params.userMode ?? 'BALANCED';
  const header = `리밸런싱 실행안 (모드 ${mode}, 스냅샷 기준)`;

  const rationaleThree = [
    `위원회 구조화 결론 **${decision ?? 'N/A'}** 및 정규화 점수 ${norm.toFixed(3)}를 반영해 목표 비중을 조정했습니다.`,
    `최소 거래 ${minKrw.toLocaleString('ko-KR')} KRW·비중 밴드 ${WEIGHT_BAND_PP}pp 이상에서만 라인을 생성했습니다.`,
    '시세는 스냅샷 시점 기준이며, 실제 체결가·세금·수수료는 HTS/MTS 기준입니다.'
  ];

  const discordText = formatRebalancePlanDiscord({
    header,
    lines,
    summary: {
      before_weights: beforeW,
      after_weights_est: afterW,
      cash_impact_krw: cashImpact,
      fx_usdkrw: fx,
      drift_reduction_pp: driftReduction
    },
    rationaleThreeLines: rationaleThree
  });

  const itemRows: RebalancePlanItemRow[] = lines.map((ln, i) => ({
    sort_order: i,
    symbol: ln.symbol,
    display_name: ln.display_name,
    side: ln.side,
    quantity: ln.quantity,
    estimated_price: ln.estimated_price,
    estimated_amount_krw: ln.estimated_amount_krw,
    rationale: ln.rationale,
    market: ln.market,
    quote_symbol: ln.quote_symbol
  }));

  let planId: string | null = null;
  let persistError: string | null = null;

  if (!params.dryRun && lines.length > 0) {
    const ins = await insertRebalancePlanRecord({
      discordUserId: params.discordUserId,
      chatHistoryId: params.chatHistoryId,
      decisionArtifactId: params.decisionArtifact?.artifactId ?? null,
      analysisType: params.analysisType,
      planHeader: header,
      summaryJson: {
        before_weights: beforeW,
        after_weights_est: afterW,
        cash_impact_krw: cashImpact,
        drift_reduction_pp: driftReduction,
        decision,
        normalized_score: norm
      },
      fxUsdkrw: fx,
      decisionSnapshot: params.decisionArtifact ? JSON.stringify(params.decisionArtifact).slice(0, 12000) : null,
      items: itemRows
    });
    planId = ins.planId;
    persistError = ins.error;
    if (persistError) {
      logger.warn('REBALANCE', 'plan persist failed', { message: persistError });
    } else {
      logger.info('REBALANCE', 'shadow plan saved', { planId, lineCount: lines.length });
    }
  }

  return {
    planId,
    header,
    lines,
    summary: {
      before_weights: beforeW,
      after_weights_est: afterW,
      cash_impact_krw: cashImpact,
      fx_usdkrw: fx,
      drift_reduction_pp: driftReduction
    },
    discordText,
    persistError
  };
}
