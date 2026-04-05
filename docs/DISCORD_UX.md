# DISCORD UX

Discord에서 사용자가 보는 **메인 패널·버튼·follow-up·응답 후 내비게이션**을 정리한다. 인터랙션 라우팅의 코드 위치는 **docs/ARCHITECTURE.md**를 본다.

## 메인 패널·진입

- 메인/서브 패널 구성·복구는 `panelManager.ts`, 상태 파일 `state/discord-panel.json`.
- 텍스트 명령(`!메뉴`, `!패널재설치`, `!토론` 등)은 `handleMessageCreate`(`src/discord/handlers/messageCreate.ts`).
- **`!메뉴`**: 기존 패널 메시지를 **편집하지 않고** 항상 **새 채널 메시지**로 메인 패널을 보낸다(`content`: «다음 메뉴를 선택하세요», `getMainPanel()`의 embed·components). 상태 파일 `state/discord-panel.json`은 **새 메시지 id**로 갱신된다. 로그: `MENU_RENDERED_NEW_MESSAGE`. (`!패널재설치`는 기존처럼 저장된 메시지 **edit** 우선.)
- 패널 복구 시 채널이 비어 있으면 `DISCORD_MAIN_PANEL_CHANNEL_ID` 또는 `DEFAULT_CHANNEL_ID`로 폴백 후 재생성 — 로그 `PANEL restore *`, **docs/TROUBLESHOOTING.md** 참고.

## 포트폴리오 / 트렌드 / 데이터센터 / 설정

- `panel:main:*`, `panel:portfolio:*`, `panel:ai:*`, `panel:trend:*`, `panel:data:*` 등 customId 패턴으로 분기.
- 데이터 센터에는 시스템 로그 분석(읽기 전용), 위원 성과, Claim 감사, 리밸 계획 조회 등이 있다. **자동 매매·DB 쓰기 없음**인 경로가 있다(`logAnalysisService` 등).

## 컴포넌트 행 우선순위

- `src/discord/uiPolicy.ts` 기준: **decision > follow-up > feedback > navigation**. Discord 행 수 제한으로 초과 시 `UI_COMPONENT_POLICY` 로그.
- **NO_DATA** 등은 가능하면 본문 안내로 처리해 행을 절약한다.

## Post-response navigation

- 포트폴리오 조회·계좌 선택, AI 토론·트렌드·데이터센터·오픈 토픽 완료 후 `getQuickNavigationRows()`로 메인 메뉴를 다시 붙인다(`panel:main:reinstall` 등).
- `sendPostNavigationReply` → followUp 우선, 실패 시 `channel.send`. 로그: `post_response_navigation_attached` / `post_response_navigation_failed`.

## Feedback buttons

- **customId**: `feedback:save:{chatHistoryId}:{analysisType}:{feedbackType}:{personaKey}` (`FeedbackType`은 `analysisTypes.ts`와 정합).
- **`analysis_type`**: 버튼 customId 파싱값만 신뢰. `chat_history.debate_type`은 사용하지 않는다.
- **저장 키**: 운영에서 `chat_history.id`는 integer → `analysis_feedback_history`에는 **`chat_history_ref`(TEXT)** 우선. 마이그레이션 `docs/sql/feedback_chat_history_ref.sql`.
- **흐름**: 클릭 → defer → `saveAnalysisFeedbackHistory` → `ingestPersonaFeedback` → (가능 시) `claim_feedback` + `persona_memory`. 실패 시 사용자에게 짧은 안내만.
- **전송**: 피드백·의사결정 버튼이 붙은 메시지는 **봇 `channel.send`**. Webhook만 쓰면 interaction이 불안정할 수 있다.
- **조기 브로드캐스트**: 본문만 먼저 나간 뒤 `chat_history` 준비 후 `sendFeedbackFollowupAttachMessage`로 **별도 메시지**에 동일 패턴 피드백 행. 로그 `FEEDBACK_FOLLOWUP_ATTACH_PENDING` / `ATTACHED` / `SKIPPED`.
- **중복**: 동일 조건 연타는 서비스 계층에서 duplicate 처리.

## Decision prompt buttons

- 목적: “선택 / vs / 원하시나요” 류 질문에 **빈 텍스트만 보내지 않도록** 버튼을 붙인다(`decisionPrompt.ts`, `extractDecisionOptions`).
- **스냅샷**: `decision_snapshots`에 옵션 JSON 저장, `customId`는 `decision:select|{snapshotUuid}|{idx}`. 클릭 시 DB로 라벨 복원.
- **저장·실행**: `decision_history` 저장 후 `decisionExecutionService` — **자동 매매 없음**. 그림자 리밸·CIO follow-up·다음 질문 등 후속 채널 메시지. 로그 `DECISION_PERSISTED`, `DECISION_EXECUTION_STARTED` / `DECISION_EXECUTION_COMPLETED`.
- **배치**: 본문 청크에서 `[NO_DATA] → [의사결정] → [피드백]` 순.
- SQL: `docs/sql/decision_history.sql`.

## Follow-up interaction (비-decision)

- `isDecisionPrompt`가 아닐 때 질문이 있으면 버튼·String Select·모달로 응답을 강제(`followupPromptService.ts`).
- 스냅샷: `followup_snapshots`, `customId`는 `followup:select|*`, `followup:menu|*`, `followup:input|*`, `modal:followup:*` 등.
- 선택 후 포트폴리오/오픈토픽/트렌드로 이어진다. **dead-end 없음**, **자동 매매 없음**. 로그 `FOLLOWUP_PROMPT_DETECTED` 등.
- **오픈 토픽 관점 선택**: 분류가 모호하면 `analysis_type=open_topic_ambiguous_view` 스냅샷 + `[금융 관점으로 보기]` 등 버튼 → `runOpenTopicDebate`에 `forcedOpenTopicView` 전달. 로그 `OPEN_TOPIC_AMBIGUOUS_DETECTED`, `OPEN_TOPIC_VIEW_SELECTED`.
- SQL: `docs/sql/followup_snapshots.sql`.

## 페르소나 응답 후처리

- `postProcessPersonaOutputForDiscord`, `ensureCompleteResponse` — 기술 기호 시 쉬운 설명 보강, 미완결 문장 정리.

## 페르소나 그룹·오픈 토픽·짧은 안내 문구

- **금융 위원회**와 **트렌드·K-culture**는 서로 다른 Discord 실행 경로에서만 돌아간다. 포트폴리오 토론 응답 말미에 *“금융 위원회 기준·가중치 위원 구성”* 한 줄이 붙을 수 있다. 트렌드·오픈 토픽(분류된 경우) 첫 메시지에 *트렌드* 또는 *금융·실행(오픈 토픽)* 관점 한 줄이 붙을 수 있다 — 내부 가중치를 장황히 노출하지 않는다.
- 오픈 토픽은 `open_topic_financial` / `open_topic_trend` / `open_topic_general`로 분류되며, JYP 기본 폴백은 **트렌드 오픈**에만 해당한다. 모호하면 금융으로 **자동 고정하지 않고** follow-up으로 관점을 고른다.

## 타임아웃 재시도 버튼

- 분석 타임아웃 시 부분 요약 + `timeout:retry:light:*` 등 버튼. 스냅샷은 `timeout_retry_snapshots`(또는 메모리 폴백). **포트폴리오** 「요약만 다시」는 내부적으로 **`retry_summary`**(리스크+COO+CIO); 오픈 토픽은 기존처럼 경량/짧은 요약 `fastMode` 유지. 상세는 **docs/ANALYSIS_PIPELINE.md**, 운영 로그 키는 **docs/OPERATIONS.md** §3.1.

## Feedback → 소프트 보정(포트폴리오, 제한적)

- `persona_memory.confidence_calibration` 누적, claim 점수 소폭 보정, CIO 프롬프트 힌트. **NO_DATA·valuation·veto 게이트는 피드백으로 완화하지 않음.**
- 결정 요약 아래 이탤릭 한 줄 안내 등 — 과도한 개인화 문구 지양.
