import type { PortfolioPositionSnapshot, PortfolioSnapshot } from './portfolioService';

export type PortfolioDiscordViewMode = 'default' | 'all' | 'retirement' | 'account';

export type SnapshotFooterKind = 'saved' | 'duplicate' | 'none';

function krw(n: number): string {
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
}

function usdAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Discord 응답용 — 미국주식 USD + KRW 카드 */
function formatUsPositionBlock(p: PortfolioPositionSnapshot, i: number): string {
  const label = p.display_name || p.symbol || p.quote_symbol || 'UNKNOWN';
  const code = p.quote_symbol || p.symbol;
  const fx = p.usdkrw_rate != null ? `${Math.round(p.usdkrw_rate).toLocaleString('ko-KR')} KRW/USD` : '-';
  const lines = [
    `**${i + 1}. ${label}** (\`${code}\`)`,
    `· 수량: **${p.quantity}**주`,
    `· 현재가: **${usdAmount(p.current_price_usd ?? p.current_price)} USD**/주`,
    `· 평가액: **${usdAmount(p.market_value_usd)} USD**`,
    `· 환율: **${fx}**`,
    `· 평가액(원화): **${krw(p.market_value_krw)}**`,
    `· 원가(원화): **${krw(p.cost_basis_krw)}**`,
    `· 손익(원화): **${krw(p.pnl_krw)}** (${p.return_pct}%) · 비중 ${p.weight_pct}%`
  ];
  return lines.join('\n');
}

function formatKrPositionBlock(p: PortfolioPositionSnapshot, i: number): string {
  const label = p.display_name || p.symbol || p.quote_symbol || 'UNKNOWN';
  const code = p.quote_symbol || p.symbol;
  return [
    `**${i + 1}. ${label}** (\`${code}\`)`,
    `· 수량: **${p.quantity}** · 평단: **${p.avg_purchase_price}** (${p.purchase_currency}/주)`,
    `· 현재가: **${p.current_price}** ${p.price_currency}`,
    `· 평가액: **${krw(p.market_value_krw)}** · 손익: **${krw(p.pnl_krw)}** (${p.return_pct}%) · 비중 ${p.weight_pct}%`
  ].join('\n');
}

function snapshotFooterLine(kind: SnapshotFooterKind): string {
  if (kind === 'saved') return '\n\n📌 오늘 스냅샷 저장됨';
  if (kind === 'duplicate') return '\n\n📌 오늘 스냅샷 이미 존재';
  return '';
}

/**
 * 사용자-facing 포트폴리오 텍스트 (기술 UUID·스키마 설명 없음)
 */
export function buildPortfolioDiscordMessage(
  snapshot: PortfolioSnapshot,
  opts: {
    viewMode: PortfolioDiscordViewMode;
    /** default: 일반계좌 표시명 */
    generalAccountName?: string;
    /** retirement / account */
    accountDisplayName?: string;
    accountTypeLabel?: string;
    snapshotFooter: SnapshotFooterKind;
    /** 전체 자산 보기에서 계좌별 UUID 나열 숨김 */
    hideAggregateAccountBreakdown: boolean;
  }
): string {
  const s = snapshot.summary;
  let head: string[] = [];

  if (opts.viewMode === 'default') {
    head = [
      '**조회 범위:** 일반계좌',
      `**계좌명:** ${opts.generalAccountName ?? '일반계좌'}`,
      '',
      `**총 평가액** ${krw(s.total_market_value_krw)} · **총 손익** ${krw(s.total_pnl_krw)} (${s.total_return_pct}%)`,
      `KR / US 비중: ${s.domestic_weight_pct}% / ${s.us_weight_pct}%`
    ];
  } else if (opts.viewMode === 'all') {
    head = [
      '**조회 범위:** 전체 자산',
      '**포함:** 일반계좌 + 퇴직연금(해당 계좌)',
      '',
      `**총 평가액** ${krw(s.total_market_value_krw)} · **총 손익** ${krw(s.total_pnl_krw)} (${s.total_return_pct}%)`,
      `KR / US 비중: ${s.domestic_weight_pct}% / ${s.us_weight_pct}%`
    ];
  } else if (opts.viewMode === 'retirement') {
    head = [
      '**조회 범위:** 퇴직연금계좌',
      '**계좌 유형:** RETIREMENT',
      opts.accountDisplayName ? `**계좌명:** ${opts.accountDisplayName}` : '',
      '',
      `**총 평가액** ${krw(s.total_market_value_krw)} · **총 손익** ${krw(s.total_pnl_krw)} (${s.total_return_pct}%)`,
      `KR / US 비중: ${s.domestic_weight_pct}% / ${s.us_weight_pct}%`
    ].filter(Boolean);
  } else {
    head = [
      '**조회 범위:** 선택 계좌',
      opts.accountDisplayName ? `**계좌명:** ${opts.accountDisplayName}` : '',
      opts.accountTypeLabel ? `**유형:** ${opts.accountTypeLabel}` : '',
      '',
      `**총 평가액** ${krw(s.total_market_value_krw)} · **총 손익** ${krw(s.total_pnl_krw)} (${s.total_return_pct}%)`,
      `KR / US 비중: ${s.domestic_weight_pct}% / ${s.us_weight_pct}%`
    ].filter(Boolean);
  }

  const posLines = snapshot.positions.map((p, i) => {
    const hideBd =
      opts.hideAggregateAccountBreakdown &&
      opts.viewMode === 'all' &&
      p.account_breakdown &&
      p.account_breakdown.length > 1;
    if (p.market === 'US') {
      const block = formatUsPositionBlock(p, i + 1);
      if (hideBd) return block;
      if (p.account_breakdown && p.account_breakdown.length > 1) {
        return `${block}\n· (합산 구성) 계좌 수 ${p.account_breakdown.length}`;
      }
      return block;
    }
    const block = formatKrPositionBlock(p, i + 1);
    if (hideBd) return block;
    if (p.account_breakdown && p.account_breakdown.length > 1) {
      return `${block}\n· (합산 구성) 계좌 수 ${p.account_breakdown.length}`;
    }
    return block;
  });

  const body = ['───', '**보유 종목**', '', ...posLines.map(x => `${x}\n`)].join('\n');
  const quoteWarn =
    snapshot.summary.degraded_quote_mode || (snapshot.summary.quote_failure_count || 0) > 0
      ? `\n\n⚠️ 일부 종목의 실시간 시세 조회가 실패해 최근 저장값/매수가 기준으로 대체되었습니다. (실패 ${snapshot.summary.quote_failure_count || 0}건)`
      : '';

  return `${head.join('\n')}\n${body}${quoteWarn}${snapshotFooterLine(opts.snapshotFooter)}`;
}

export function accountTypeLabelKo(accountType: string): string {
  const t = String(accountType || '').toUpperCase();
  if (t === 'TAXABLE') return '과세(일반)';
  if (t === 'RETIREMENT' || t === 'PENSION') return '퇴직연금';
  if (t === 'ISA') return 'ISA';
  return t || '기타';
}
