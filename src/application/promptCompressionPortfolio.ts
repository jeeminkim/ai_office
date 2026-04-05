import type { PersonaKey } from '../../analysisTypes';
import type { PortfolioSnapshot } from '../../portfolioService';

/** 기본 위원 경로는 standard, timeout 재시도·짧은 트렌드 등은 aggressive */
export type CompressedPromptMode = 'standard_compressed' | 'aggressive_compressed';

const TOP_HOLDINGS_STANDARD = 18;
const TOP_HOLDINGS_AGGRESSIVE = 10;

export function estimateTokensApprox(charCount: number): number {
  return Math.max(0, Math.ceil(charCount / 4));
}

export function truncateUtf8Chars(s: string, maxChars: number): string {
  const t = String(s || '').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * BASE_CONTEXT: 공통·압축 (전체 JSON 스냅샷 대신 요약 + 상위 보유만).
 */
export function buildPortfolioBaseContext(opts: {
  mode: string;
  userQuery: string;
  snapshot: PortfolioSnapshot;
  partialScopeBlock?: string;
  profileOneLiner?: string;
  quoteQualityBlock?: string;
  styleDirectiveBlock?: string;
  /** default: standard_compressed */
  compressionMode?: CompressedPromptMode;
}): string {
  const { snapshot, userQuery, mode } = opts;
  const aggressive = opts.compressionMode === 'aggressive_compressed';
  const topN = aggressive ? TOP_HOLDINGS_AGGRESSIVE : TOP_HOLDINGS_STANDARD;
  const profileMax = aggressive ? 280 : 420;
  const quoteMax = aggressive ? 200 : 320;
  const userQMax = aggressive ? 1200 : 2000;
  const s = snapshot.summary;
  const positions = [...snapshot.positions].sort((a, b) => b.weight_pct - a.weight_pct).slice(0, topN);
  const posLines = positions.map(
    p =>
      `${p.symbol}|${p.market}|w${p.weight_pct.toFixed(1)}%|mvKRW~${Math.round(p.market_value_krw)}|px${p.current_price}${p.currency === 'USD' ? 'USD' : ''}`
  );
  const parts = [
    aggressive ? '[BASE_CONTEXT — compressed:aggressive]' : '[BASE_CONTEXT — compressed:standard]',
    `[USER_MODE] ${mode}`,
    opts.profileOneLiner ? `[PROFILE] ${truncateUtf8Chars(opts.profileOneLiner, profileMax)}` : '',
    `[PORTFOLIO_SUM] n=${s.position_count} mvKRW=${Math.round(s.total_market_value_krw)} pnlKRW=${Math.round(s.total_pnl_krw)} ret%=${s.total_return_pct.toFixed(2)} top3w%=${s.top3_weight_pct.toFixed(1)} KR%=${s.domestic_weight_pct.toFixed(1)} US%=${s.us_weight_pct.toFixed(1)}`,
    s.degraded_quote_mode
      ? `[QUOTE] degraded=true failures=${s.quote_failure_count ?? 0}`
      : `[QUOTE] degraded=false`,
    opts.quoteQualityBlock ? truncateUtf8Chars(opts.quoteQualityBlock.replace(/^\s+|\s+$/g, ''), quoteMax) : '',
    `[TOP_HOLDINGS≤${topN}]`,
    posLines.length ? posLines.join('\n') : '(none)',
    opts.partialScopeBlock ? `\n${opts.partialScopeBlock}` : '',
    opts.styleDirectiveBlock ? `\n${opts.styleDirectiveBlock}` : '',
    `[USER_QUESTION]\n${truncateUtf8Chars(userQuery, userQMax)}`,
    '[ANCHOR_RULE] 위 수치·스냅샷만 앵커. 없는 현금흐름/지출은 단정 금지.'
  ];
  return parts.filter(Boolean).join('\n');
}

/** PERSONA_CONTEXT: 역할 한 줄 + 바이어스 + 메모리(잘림). */
export function buildPersonaContext(opts: {
  personaKey: PersonaKey;
  personaBiasDirective: string;
  memoryDirective: string;
  compressionMode?: CompressedPromptMode;
}): string {
  const role =
    opts.personaKey === 'RAY'
      ? '[PERSONA] Ray — 거시·리스크 균형'
      : opts.personaKey === 'HINDENBURG'
        ? '[PERSONA] Hindenburg — 다운사이드·구조 리스크'
        : opts.personaKey === 'SIMONS'
          ? '[PERSONA] Simons — 확률·데이터 시그널'
          : opts.personaKey === 'DRUCKER'
            ? '[PERSONA] Drucker — 실행 레버·구조'
            : opts.personaKey === 'CIO'
              ? '[PERSONA] CIO — 최종 GO/HOLD/NO'
              : `[PERSONA] ${opts.personaKey}`;
  const bias = opts.personaBiasDirective || '';
  const memMax = opts.compressionMode === 'aggressive_compressed' ? 650 : 1100;
  const mem = opts.memoryDirective ? truncateUtf8Chars(opts.memoryDirective, memMax) : '';
  return [role, bias, mem ? `[MEMORY]\n${mem}` : ''].filter(Boolean).join('\n');
}

export type PortfolioTaskPromptMode = 'persona' | 'persona_brevity' | 'cio' | 'retry_summary';

/** TASK_PROMPT: 출력 길이·형식 제한. */
export function buildTaskPrompt(mode: PortfolioTaskPromptMode): string {
  switch (mode) {
    case 'persona':
      return '[TASK]\n핵심 판단만. **3~5문장 또는 bullet 5개 이내.** 장황한 서두 금지.';
    case 'persona_brevity':
      return '[TASK]\n**2~4문장.** 한 줄 결론 먼저.';
    case 'cio':
      return '[TASK]\n위 **요약 블록**만 근거로 결론. **GO|HOLD|NO** 포함, 본문 3~5문장.';
    case 'retry_summary':
      return '[TASK]\n**400자 이내** 한국어 요약만.';
    default:
      return '[TASK]\n간결히.';
  }
}

export function compressPersonaLine(label: string, text: string, maxChars: number): string {
  const body = truncateUtf8Chars(text.replace(/\s+/g, ' ').trim(), maxChars);
  return `[${label}]\n${body}`;
}

/** CIO·Simons peer 등 후속 단계 입력 압축. */
export function compressPersonaOutputsForCio(entries: { label: string; text: string }[], maxEach: number): string {
  return entries.map(e => compressPersonaLine(e.label, e.text, maxEach)).join('\n\n');
}

/** 오픈 토픽 BASE (포트폴리오 JSON 없음). */
export function buildOpenTopicBaseContext(opts: {
  mode: string;
  userQuery: string;
  profileOneLiner: string;
  openTopicGuardBlock: string;
  compressionMode?: CompressedPromptMode;
}): string {
  const aggressive = opts.compressionMode === 'aggressive_compressed';
  return [
    aggressive ? '[BASE_CONTEXT — OPEN_TOPIC compressed:aggressive]' : '[BASE_CONTEXT — OPEN_TOPIC compressed:standard]',
    opts.openTopicGuardBlock.trim(),
    `[USER_MODE] ${opts.mode}`,
    `[PROFILE] ${truncateUtf8Chars(opts.profileOneLiner, aggressive ? 300 : 400)}`,
    `[USER_TOPIC]\n${truncateUtf8Chars(opts.userQuery, aggressive ? 1200 : 2000)}`
  ]
    .filter(Boolean)
    .join('\n');
}
