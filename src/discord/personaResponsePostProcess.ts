/**
 * 페르소나 Discord 출력: 전문성 유지 + 고객 친화 보강 + 문장 완결성.
 * normalizeProviderOutputForDiscord 마지막 단계에서 호출된다.
 */

const TECH_MARKERS =
  /[σβρΣΔ∇∂]|\\sigma|\\beta|VaR|CVaR|샤프|Sharpe|표준편차|상관계수|R\^2|p-value|유의수준|변동성\s*\(|σ\s*\)|\bβ\b|베타|알파|α|duration|듀레이션|duration/i;

const PLACEHOLDER_LINES = /^\s*(마무리|한\s*줄|요약\s*줄|결론\s*줄)\s*[\(:：].*$/gim;

/** 마지막 문장이 한국어 종결형에 가깝지 않으면 보정 */
function ensureCompleteResponse(text: string): string {
  let t = String(text || '').trim();
  if (!t) return t;

  t = t.replace(PLACEHOLDER_LINES, '').replace(/\n{3,}/g, '\n\n').trim();

  const lines = t.split('\n');
  let lastNonEmpty = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i].trim();
    if (L && !L.startsWith('_(') && !L.startsWith('```')) {
      lastNonEmpty = L;
      break;
    }
  }

  const endsOk =
    /[.!?。！？…』」]$/.test(lastNonEmpty) ||
    /(습니다|입니다|합니다|하세요|주세요|됩니다|됩니다|권장합니다|바랍니다|어떠신가요|까요\??|지요\??|세요\??)$/.test(
      lastNonEmpty
    );

  if (lastNonEmpty && !endsOk) {
    if (/\.{3,}$/.test(lastNonEmpty)) {
      t = t.replace(/\.{3,}$/m, '');
    }
    t = `${t.trim()}\n\n위 내용을 바탕으로 투자 목적에 맞게 우선순위를 정리해 보시기 바랍니다.`;
  }

  return t.trim();
}

function maybeAppendHumanFriendlyExplanation(text: string): string {
  const t = String(text || '');
  if (/###\s*쉬운\s*설명/.test(t)) return t;
  if (!TECH_MARKERS.test(t)) return t;

  const block =
    '\n\n### 쉬운 설명\n' +
    '수치·기호는 **참고용 지표**입니다. 변동성이 크다는 말은 가격이 크게 오르거나 내릴 수 있어 **기회와 손실 위험이 함께 커질 수 있다**는 뜻으로 이해하시면 됩니다. 최종 판단은 목표·기간·감내 가능 손실에 맞추세요.\n\n' +
    '### 한 줄 요약\n' +
    '지표는 방향성 힌트일 뿐이며, 자동 매매나 확정 수익을 보장하지 않습니다.';

  return t.trim() + block;
}

export function postProcessPersonaOutputForDiscord(text: string): string {
  let t = String(text || '').replace(/\r\n/g, '\n');
  t = maybeAppendHumanFriendlyExplanation(t);
  t = ensureCompleteResponse(t);
  if (t.length < 80 && !/추가 분석 필요/.test(t)) {
    t = `${t.trim()}\n\n→ 핵심 요약: 현재 정보가 부족하므로 추가 분석 필요`;
  }
  return t.trim();
}
