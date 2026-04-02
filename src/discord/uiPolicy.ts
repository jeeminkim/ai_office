/**
 * Discord UI 정책 — 동작 변경 없이 문서화·검색용 상수.
 * 우선순위: decision > follow-up > feedback > navigation(퀵메뉴).
 * 인터랙티브 컴포넌트는 첫 메시지/첫 청크에 두고, 질문만 던지고 끝나지 않게 후속 메뉴를 붙인다.
 * 리밸런스·결정 등은 webhook이 아닌 봇 작성 메시지로 컴포넌트를 유지한다.
 */
export const UI_COMPONENT_PRIORITY_NOTE =
  'decision > follow-up > feedback > navigation; first chunk keeps interactive rows where applicable';
