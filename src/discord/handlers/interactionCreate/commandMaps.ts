/** 패널 버튼 → 분석 질의 (포트폴리오·재무 경로). index에서 이전. */
export const financialCommandQueryMap: Record<string, string> = {
  'panel:portfolio:risk': '포트폴리오 리스크 집중 분석',
  'panel:finance:analyze_spending': '최근 소비 패턴 분석 및 미래지향성 평가',
  'panel:finance:stability': '재무 안정성 점검',
  'panel:ai:full': '종합 자산 및 소비 구조 진단',
  'panel:ai:risk': '포트폴리오 리스크 점검',
  'panel:ai:strategy': '실행 가능한 투자 전략 제안',
  'panel:ai:spending': '소비 개선 전략 및 평가'
};

export const trendCommandQueryMap: Record<string, string> = {
  'panel:trend:kpop':
    'K-pop 산업·시장·콘텐츠·팬덤·플랫폼 관점에서 현재 핵심 트렌드와 이슈를 상세히 분석해 줘. (개인 포트폴리오·비중 언급 금지)',
  'panel:trend:drama':
    'OTT·드라마·영상 콘텐츠 산업 관점에서 플랫폼 경쟁, 소비 트렌드, 주요 이슈를 분석해 줘. (개인 포트폴리오·비중 언급 금지)',
  'panel:trend:sports':
    '스포츠 비즈니스(리그, 미디어, 스폰서, 팬, 글로벌 시장) 관점에서 구조와 트렌드를 분석해 줘. (개인 포트폴리오·비중 언급 금지)',
  'panel:trend:hot':
    '지금 사회·미디어·산업에서 두드러지는 핫 트렌드와 배경, 소비자 반응, 지속 가능성을 분석해 줘. (개인 포트폴리오·비중 언급 금지)'
};
