# CHANGELOG

이 문서는 코드 변경 이력을 운영 관점으로 기록한다.

## 문서 정본(현재 운영 기준)

- 설계·운영·DB·UX·파이프라인·장애 점검·환경·테스트·정책의 **정본**은 `README.md`(입구)와 `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/DATABASE.md`, `docs/DISCORD_UX.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/TROUBLESHOOTING.md`, `docs/ENVIRONMENT.md`, `docs/TEST_CHECKLIST.md`, `docs/DOCUMENTATION_POLICY.md`, `docs/CHANGELOG.md`(이력)이다.
- `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/DATABASE_SCHEMA.md`는 **리다이렉트 스텁만** 유지하며, 본문 정본으로 쓰지 않는다.
- 아래 날짜별 항목에 구 파일명이 나오면 **당시 작업 당시 기록**이다. **신규 문서 갱신은 위 정본 경로만** 수정한다.

## 기록 원칙
- 의미 있는 코드 변경 시 **항상** 이 파일을 갱신한다.
- 문서 갱신 없이 코드만 변경한 작업은 완료로 간주하지 않는다.
- 항목은 아래 분류를 사용한다.
  - `Added`
  - `Changed`
  - `Fixed`
  - `Refactor`
  - `Docs`
- 한 항목은 “무엇을/왜” 중심으로 1~2줄로 적는다.
- 가능하면 관련 파일 경로를 함께 기록한다.

## 템플릿

```md
## YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Refactor
- ...

### Docs
- ...
```

## 2026-04-06

### Docs
- 문서 canonical 체계 보호를 위한 `npm run docs:check` 추가 (`scripts/docs-check.ts`). `docs/DOCUMENTATION_POLICY.md` § 문서 린트 참고.

## 2026-03-28

### Added
- **위원 `runMode`·경량/재시도 통합**: `committeeCompositionService`에 `light`·`retry_summary`·`short`; 포트폴리오 `light_summary`·`retry_summary`도 `personaWeightService`+`loadPersonaWeightSignalHints`·동일 금융 패밀리(트렌드 페르소나 비개입). 타임아웃 포트폴리오 「요약만 다시」→ `retry_summary`(`timeoutRoutes.ts`). 로그 `COMMITTEE_COMPOSITION_BUILT`·`PERSONA_WEIGHT_APPLIED` 필드 보강(`selectedPersonas`·`recentFeedbackSummary` 등).
- **오픈 토픽 모호 UX**: `OPEN_TOPIC_AMBIGUOUS_DETECTED` / `OPEN_TOPIC_VIEW_SELECTED`, `followup_snapshots`(`open_topic_ambiguous_view`, `chat_history_ref` `otamb:*`), `runOpenTopicDebate` `forcedOpenTopicView`(`index.ts`, `followupHandlers.ts`, `runOpenTopicDebateAppService.ts`).
- **Placeholder 격리**: 위원 생략 플레이스홀더는 `analysis_claims`/claim 매핑/`persona_memory` 집계에서 제외, trace·실행 요약은 허용. `CLAIM_EXTRACTION_PLACEHOLDER_SKIPPED`, `FEEDBACK_MAPPING_PLACEHOLDER_SKIPPED`(`analysisPipelineService.ts`, `feedbackIngestionService.ts`, `personaMemoryService.ts`).

### Changed
- **가중치 신호**: 최근 10건 `analysis_feedback_history` + 30일 `claim_feedback`→`analysis_claims` 매핑으로 얇은 보정(클램프, 리스크 좌석 하한 유지; `personaSignalsRepository.ts`).

### Fixed
- **라우트 락·분석 타입**: `AiExecutionHandle.lockAnalysisRoute` / `coerceAnalysisRoute` — 포트폴리오 토론에서 `open_topic`·`trend_*`로의 교차 덮어쓰기 차단, 오픈 토픽에서 `portfolio_*` 차단. 로그 `ROUTE_LOCKED`, `ROUTE_OVERRIDE_BLOCKED` (`aiExecutionHandle.ts`, `runPortfolioDebateAppService.ts`, `runOpenTopicDebateAppService.ts`).
- **오픈 토픽 페르소나**: 프로필 선호 → 질문 힌트 → **Drucker·CIO** 폴백; JYP 기본 폴백 제거 (`runOpenTopicDebateAppService.ts`, `personaSelectionPolicy.ts`).
- **금융 경로 페르소나 바이어스**: 엔터/트렌드 표시명을 포트폴리오 선호에서 제외 (`runPortfolioDebateAppService.ts`).
- **`!메뉴`**: 항상 새 메시지로 메인 패널 전송 + `MENU_RENDERED_NEW_MESSAGE` (`messageCreate.ts`).
- **짧은 페르소나 출력**: 80자 미만 시 한 줄 보강 (`personaResponsePostProcess.ts`).

### Added
- **AI 분석 5분 타임아웃·재시도**: `src/discord/aiExecution/*` — `runUserVisibleAiExecution` 래핑(`index.ts` 포트폴리오·트렌드·오픈 토픽), `AiExecutionHandle`·`AbortController`·OpenAI Responses **cancel best-effort**·`broadcastAgentResponse` 폐기 가드·`timeoutRoutes.ts` 버튼(경량/요약/메인 메뉴). in-memory 재시도 payload(`aiExecutionPolicy.ts`). **자동 매매 없음**.
- **AI 성능·비용 경로(압축·병렬·모델 분리)**: `src/application/promptCompressionPortfolio.ts` — 포트폴리오/오픈토픽 **BASE·PERSONA·TASK** 분리·압축, `compressPersonaOutputsForCio`. 포트폴리오 **Ray ∥ Hindenburg** 병렬(`Promise.allSettled`), CIO 입력 압축. `analysisTypes` `LlmTaskType`·`AgentGenCaps`; `llmProviderService.getModelForTask`·OpenAI/Gemini **max_tokens·temperature**; `agents.ts`·`geminiLlmService`·`openAiLlmService` 생성 옵션. 관측 **`AI_PERF`**. `index.ts` **조기 `broadcastAgentResponse`**(`onPersonaSegmentReady` / `onPersonaReady`) + 최종 루프 중복 스킵. `decisionExecutionService` CIO follow-up Gemini에 동일 요약 모델·상한. **timeout/cancel·위원회 구조 유지**.
- **조기 브로드캐스트 후 피드백 분리**: `registerPendingFeedbackFollowup` → `chat_history` 확정 후 `sendFeedbackFollowupAttachMessage`(`discordBroadcastService.ts`)로 봇 메시지에 기존 `feedback:save:*` 행 부착. 로그 `FEEDBACK_FOLLOWUP_ATTACH_PENDING` / `ATTACHED` / `SKIPPED`, 중복 방지.
- **`AI_PERF` 실행 요약**: `first_visible_latency_ms`, `execution_summary`(`total_execution_time_ms`, `prompt_build_time_ms`, `persona_parallel_wall_time_ms`, `cio_stage_time_ms`, `compressed_prompt_mode`, `retry_mode_used`, `partial_fallback_used`) — `aiExecutionHandle.ts`·앱 서비스.
- **압축 모드 구분**: `standard_compressed`(기본) vs `aggressive_compressed`(재시도 경량·요약·FAST 트렌드 등); `AI_PERF`에 기록.
- **`personaSelectionPolicy.ts`**: 금융 제외 집합·오픈 토픽 표시명→키 매핑; 트렌드 호출 시 `PERSONA_SELECTION_POLICY_APPLIED` (`trendAnalysis.ts`).

### Changed
- **`InteractionRuntimeBundle`**: `runPortfolioDebate` / `runOpenTopicDebate` / `runTrendAnalysis`에 선택 인자 `opts.fastMode` (timeout 재시도·경량 경로).
- **`runTrendAnalysisAppService`**: `execution`·`fastMode`·`assertActiveExecution` 복구 및 정합.
- **`scripts/interaction-smoke-check.ts`**: `timeoutRoutes.ts` 파일 존재 기대 목록에 추가.
- **AI timeout 고도화(2차)**: `FIRST_VISIBLE_TIMEOUT_MS`(90s) + 전체 5분, `markFirstResponseSent`·조기 타이머 해제, 타임아웃 시 **partial 요약**(`aiExecutionHelpers.formatPartialFallbackDiscordBody`, `collectPartialResult` in app services), **`timeout_retry_snapshots` DB** + 실패 시 메모리 폴백, 버튼 ID를 UUID 스냅샷 기준으로 통일(레거시 hex 호환 유지). `AiExecutionHandle`에 `expired`·`timeoutPhase`·`partialSegments`·`augmentRetryPayload`.

### Docs
- **정본·스텁 정리**: `docs/DOCUMENTATION_POLICY.md` § 문서 정본(canonical) 명문화; `docs/SYSTEM_ARCHITECTURE.md` 등 구명 3종은 짧은 리다이렉트 스텁만 유지. `README.md` 정책 한 줄 보강.
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md`, `docs/DATABASE_SCHEMA.md`, `docs/CHANGELOG.md` — 2단계 타임아웃·partial·스냅샷·로그 반영.
- 동일 날짜 후속: `README.md`, `SYSTEM_ARCHITECTURE.md`, `OPERATIONS_RUNBOOK.md`, `TEST_CHECKLIST.md`, `ENVIRONMENT.md`, `.env.example` — 프롬프트 압축·페르소나 병렬·`getModelForTask`·`AI_PERF`·조기 브로드캐스트 트레이드오프.
- 동일 날짜 후속(피드백 follow-up·`AI_PERF`·압축 모드·Drucker/CIO 선계산): `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md`.
- **문서 구조 정리(후속)**: README 입구 문서화 축소; `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/DATABASE.md`, `docs/DISCORD_UX.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/TROUBLESHOOTING.md` 신설·분리. `SYSTEM_ARCHITECTURE.md`·`OPERATIONS_RUNBOOK.md`·`DATABASE_SCHEMA.md`는 리다이렉트 스텁. `DOCUMENTATION_POLICY.md` 정식 파일명 반영.
- **성능·피드백 UX 문서 정렬**: README, `docs/ANALYSIS_PIPELINE.md`, 정본(`ARCHITECTURE`·`DISCORD_UX`·`OPERATIONS`) 교차 참고에 조기 브로드캐스트 피드백 follow-up, `AI_PERF`·`first_visible_latency_ms`, 압축 모드 안내.
- **라우트 락·페르소나·`!메뉴`**: `docs/DISCORD_UX.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` — 신규 메시지 메뉴, `ROUTE_*`·`PERSONA_SELECTION_POLICY_APPLIED`·`MENU_RENDERED_NEW_MESSAGE`.

### Added
- **페르소나 그룹·라우트 패밀리**: `src/policies/personaRoutePolicy.ts` — 금융 위원회 vs 트렌드·K-culture 하드 분리, `open_topic_{financial|trend|general}` 분류, `ROUTE_FAMILY_LOCKED` / `PERSONA_GROUP_SELECTED` / `PERSONA_HARD_EXCLUDED` / `OPEN_TOPIC_CLASSIFIED`.
- **가중치·위원 구성**: `src/services/personaWeightService.ts`(`PERSONA_WEIGHT_APPLIED`), `src/services/committeeCompositionService.ts`(`COMMITTEE_COMPOSITION_BUILT`) — 프로필·메모리 기반, 리스크 좌석 하한·SIMONS 확률 포함.

### Changed
- **`runPortfolioDebateAppService.ts`**: Drucker·CIO 고정, Ray/Hindenburg/Simons는 계획에 따라 생략 가능(플레이스홀더·파이프라인·의사결정 출력 동기화). CIO 말미 한 줄 안내.
- **`runOpenTopicDebateAppService.ts`**: 질의 분류 후 그룹별 페르소나만 선택; 트렌드 오픈은 JYP 계열만, 금융 오픈은 Ray/Simons/Drucker/CIO만.
- **`runTrendAnalysisAppService.ts`**, **`aiExecutionHandle.ts`**: `trend_*` 라우트 락·금융/오픈 교차 차단 강화.

### Docs
- `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/DISCORD_UX.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/TROUBLESHOOTING.md`, `docs/DOCUMENTATION_POLICY.md` — 그룹 분리·위원 엔진·오픈 토픽 분류·관측 로그.

## 2026-03-29

### Refactor
- **Interaction routes**: `buildInteractionRoutes.ts`는 **조립 전용**. 도메인별 `src/discord/handlers/interactionCreate/routes/*.ts`(패널·데이터센터·포트폴리오·금융 모달·설정·decision/feedback/follow-up 등). `InteractionRoute` / `dispatchRoutesInOrder` / 등록 순서·핸들 로직은 이전 단일 파일과 동일하게 이전.
- **index.ts 슬림화**: `Events.MessageCreate` → `handleMessageCreate` + `MessageCreateContext` (`src/discord/handlers/messageCreate.ts`). 에이전트 브로드캐스트·컴포넌트 행 우선순위·post-navigation → `src/discord/services/discordBroadcastService.ts` (`discordBroadcastDeps` 주입). `domain/` 신설 및 루트 `*Service.ts` 대이동 없음.

### Changed
- **스모크**: `scripts/interaction-smoke-check.ts`·`scripts/followup-route-smoke.ts` 끝에 `process.exit(0)` 추가(transitive import 시 Node가 종료되지 않는 환경 대비). interaction 스모크에서 기대 `routes/*.ts`·`messageCreate.ts`·`discordBroadcastService.ts` 경로 존재 확인.

### Docs
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md`, `docs/CHANGELOG.md` — 위 구조 반영.

## 2026-04-02

### Refactor
- **Discord entrypoint**: `interactionCreate`를 `src/discord/handlers/interactionCreate/buildInteractionRoutes.ts`의 `InteractionRoute[]` + `dispatchRoutesInOrder`로 위임. `DiscordInteractionContext`, `createPanelAdapter()`(panelManager 래핑), decision/feedback/follow-up 핸들러 분리. `src/discord/formParsing.ts`, `schemaInsertErrors.ts`로 모달 파싱·DB insert 로그 헬퍼 공용화. 동작 변경 최소·advisory 유지.

### Added
- **스모크**: `npm run smoke:interaction` | `smoke:followup-routes` | `smoke:panel-restore`(dummy Supabase 선로드가 필요한 스크립트는 `setDummySupabaseEnv.cjs` 사용).

### Docs
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md` — registry·context·스모크 반영.

## 2026-04-01

### Added
- **System operator (로그 분석)**: `logAnalysisService.ts` — `logs/` 읽기 전용 스캔·패턴 분류·Peter Thiel 스타일 리포트(`generateSystemReport` 등). Discord 데이터 센터 `panel:system:check|detail|actions`, 30초 캐시. 자동 매매·DB·kill 없음.

### Changed
- **Quote 안정화**: `quoteService.ts` — Yahoo JSON 요청에 브라우저형 헤더; `yahoo_v7_http_error` / `yahoo_chart_http_error` 로그; `dominantFailureReason`, `QuoteResult.request_failure_reason` / `is_stale`; EOD·DB fallback 라벨 정리.
- **포트폴리오 표시**: `portfolioService.ts` / `portfolioUx.ts` — 종목별 시세 출처·기준시각·stale·실패유형 한 줄; `quote_quality_note`·`quote_quality_degraded_summary` 로그.
- **메인 패널**: `panelManager.ts` — `DISCORD_MAIN_PANEL_CHANNEL_ID` / `DEFAULT_CHANNEL_ID` 폴백 채널; state 저장 재시도; `PANEL restore *` 로그; `logger.ts` health `panels.*` 확장.
- **스케줄러**: `index.ts` 주간 리포트 매시간 check/skip → `logger.debug` (ops 노이즈 감소).
- **Discord UX 관측성**: `index.ts` — `prioritizeDiscordComponentRows`(5행), NO_DATA 본문 우선, `DECISION_*` / `FOLLOWUP_*` 스냅샷·부착·스킵 로그, `UI_COMPONENT_POLICY`/`healthState.ux`.
- **토론 입력**: `runPortfolioDebateAppService.ts` — `[QUOTE_QUALITY]` 블록(지연 시세 시).

### Docs
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md`, `docs/DATABASE_SCHEMA.md` — system operator·로그 분석·DB 비저장 정책 반영.

## 2026-03-30

### Added
- **의사결정 영구 저장·실행**: `docs/sql/decision_history.sql` — `decision_snapshots`, `decision_history`. `src/repositories/decisionRepository.ts`. 버튼 `decision:select|{uuid}|{idx}` + `decisionExecutionService.ts`(`executeDecisionAfterSelection`, `DECISION_EXECUTION_STARTED`/`COMPLETED`). `getLatestDecisionArtifactForChat`(`decisionArtifactRepository.ts`). `buildRebalancePlanAppService` `advisoryOverride`(EXIT/REDUCE).

### Docs
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md` — decision → shadow execution 흐름.

## 2026-03-28

### Added
- **Follow-up 질문 UX**: `docs/sql/followup_snapshots.sql`, `src/repositories/followupRepository.ts`, `followupPromptService.ts` — 질문 감지 시 `followup_snapshots` 저장 후 버튼/스트링 셀렉트/모달(`followup:select|*`, `followup:menu|*`, `followup:input|*`, `modal:followup:*`). 선택·입력 후 포트폴리오/오픈 토픽/트렌드로 이어짐. 로그 `FOLLOWUP_*`.
- **페르소나 응답 후처리**: `src/discord/personaResponsePostProcess.ts` — 기술 기호 시 쉬운 설명 보강, `ensureCompleteResponse`로 완결성 보정. `analysisFormatting.ts` 정규화 경로에서 적용.
- **Control Panel 관측성**: `logs/control-panel/control-panel.log_YYYYMMDD` 전용(`controlPanelLog.ts`), `state/control-panel-state.json` 요약, `stopPipeline.ts` 다단계 중지(graceful→검증→Windows `/F` 자동 fallback), `CONTROL_PANEL *` 이벤트(동일 실패 10초 dedupe). UI는 상태판·로그 경로 안내만(기본 raw tail 제거)
- **시세 다단계 fallback**: `quoteService.ts` — Yahoo quote → chart 일봉(EOD) → DB/스냅샷; 종목별 `resolved_quote_symbol`, `price_source_kind`, `price_asof`, `market_state`, `fallback_reason`; `QUOTE_RESOLUTION` 로그(`current_success`, `eod_fallback_used`, `cache_fallback_used`, `symbol_corrected`)
- **포트폴리오 가격 표시**: `portfolioService.ts` / `portfolioUx.ts` — 요약 `price_basis_hint`, `partial_quote_warning`; KR 장 마감 후 종가 안정화
- **응답 후 빠른 메뉴**: `panelManager.ts` `getQuickNavigationRows`, `index.ts` `sendPostNavigationReply` — 포트폴리오·토론·트렌드·데이터센터 등 후 `UI` `post_response_navigation_attached`
- **KR 심볼 보정**: `instrumentRegistry.ts` `normalizePortfolioInstrument` — `.KS`/`.KQ`·6자리 정합(가능 시)
- **로깅 고도화**: `loggingPaths.ts` + `logger.ts` — `logs/daily/office-{runtime,error,ops,debug}_*.log`, `logger.debug`, `logger.ops`, INTERACTION INFO 메인 runtime 생략(카테고리 유지), WARN/ERROR 중복 억제, 일별 보존(`OFFICE_LOG_RETENTION_DAYS`)
- **AI Office Control Panel (로컬)**: `apps/control-panel/` — Express API(`/api/status|start|stop|restart|processes|kill|logs/*`), spawn 기반 `dist/index.js` 기동·`state/control-panel-child.json` 추적, `healthGate` 중복 기동 방지
- **Phase 3 금융·종목 정합성**: `docs/sql/phase3_finance_instrument_integrity.sql` — `expenses` 할부 컬럼, `cashflow.flow_type` 레거시 UPDATE + CHECK(NOT VALID), `instrument_registration_candidates`, `portfolio`/`trade_history` KR·US 메타 CHECK(NOT VALID)
- `src/finance/cashflowCategories.ts` 표준 8종 + `parseCashflowFlowType`; `agents.ts` 스냅샷에 `formatCashflowSnapshotLine`
- `src/services/instrumentValidation.ts` + `src/interactions/instrumentConfirmationHandler.ts` + `src/repositories/instrumentCandidateRepository.ts` — 종목 추가 후보 저장 후 `instr:confirm`/`instr:cancel`/`instr:pick`로만 확정
- `src/finance/expenseInstallment.ts` — 지출 모달 할부 한 줄 파싱
- **의사결정 버튼(초기)**: `decisionPrompt.ts` 휴리스틱·`extractDecisionOptions`·`broadcastAgentResponse`에 선택 행 부착, `index.ts` `handleDecisionButtonInteraction` — `DECISION` 로그(`DECISION_PROMPT detected`는 `analysisPipelineService` persist, `DECISION_OPTIONS extracted` / `DECISION_SELECTED`는 Discord 경로). (2026-03-30 이후 스냅샷 UUID·`decision_history`·`decisionExecutionService` 참고.)

### Fixed
- **피드백·claim UUID**: `chat_history.id`(integer)를 UUID FK에 넣지 않도록 `analysis_feedback_history`에 **`chat_history_ref`(TEXT)** 우선 저장(`feedbackService.ts`, `feedbackRepository.ts`, `docs/sql/feedback_chat_history_ref.sql`). `mapped_claim_id`는 형식이 UUID일 때만 저장. `claim_feedback` insert가 UUID 오류면 non-fatal 스킵(`claimLedgerService.ts`, `feedbackIngestionService.ts`). 피드백 버튼 UX 문구 완화(`index.ts`)

### Changed
- `index.ts`: `!현금흐름추가`·`modal:cashflow:add`·`modal:expense:add`를 위 표준/할부에 맞춤; `instr:*` 버튼·스트링 셀렉트 라우팅; 포트폴리오·분석 흐름 후 `sendPostNavigationReply`
- `portfolioInteractionHandler`/`modal:portfolio:add`: 즉시 매수 없이 후보 플로우로 위임(기존 요약)
- `loggingPaths.ts`: `CONTROL_PANEL_LOG_DIR`·`controlPanelLogPath`; Control Panel UI 상태판·로그 경로 안내만(기본 tail 제거)
- **Windows Control Panel 중지**: `stopPipeline.ts`·`stopSafety.ts`·`stopErrorNormalize.ts` — `child_sigterm` 우선, 1.5s/4s/8s `post_stop_verification`, 안전 조건에서만 `taskkill /F /T` 자동; `stopPhase`·stderr 정규화; `postStopVerify.ts` 제거

### Docs
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md` — follow-up 흐름·스냅샷·검증 항목.
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md` — 피드백 `chat_history_ref`·의사결정 버튼 흐름·`DECISION` 로그 운영 반영
- `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md` — Phase 3 + 로깅/컨트롤 패널 운영 절차 반영
- Quote 다단계·KR EOD·후속 네비게이션·`QUOTE_RESOLUTION`/`post_response_navigation` 운영 검증: `README.md`, `SYSTEM_ARCHITECTURE.md`, `OPERATIONS_RUNBOOK.md`, `TEST_CHECKLIST.md`
- Control Panel 전용 로그·상태판·Windows stop/kill 진단: `README.md`, `SYSTEM_ARCHITECTURE.md`, `OPERATIONS_RUNBOOK.md`, `TEST_CHECKLIST.md`

## 2026-03-29

### Added
- **Phase 2.5 Advisory Execution Layer**: `buildRebalancePlanAppService` / `executeRebalancePlanAppService` / `rebalancePlanRepository`; 포트폴리오 토론 직후 그림자 리밸 플랜 저장·Discord 버튼(`rebalance:view|complete|hold:*`); 완료 시에만 `trade_history`+스냅샷 기록
- `runClaimOutcomeAuditAppService` + `claimOutcomeAuditRepository` — `claim_outcome_audit` 갱신(7d/30d, MVP 시세 스냅샷)
- `personaScorecardService` + 데이터 센터 `panel:data:persona_report` / `panel:data:claim_audit` / `panel:data:rebalance_view`
- `personaPerformanceCalibrationService` + `personaCommitteeMap` — 위원회 투표 가중 **bounded** 보정(RAY/HINDENBURG safety floor); `decisionEngineService` → `runCommitteeVote(weightMultipliers?)`
- SQL: `docs/sql/phase2_5_advisory_execution.sql` (`rebalance_plans`, `rebalance_plan_items`, `claim_outcome_audit` 확장)

### Fixed
- `chat_history.debate_type` 미존재 DB 대응: `findChatHistoryById`에서 `debate_type` select 제거, 피드백·`runFeedbackAppService`는 **`analysisType`을 customId(또는 명시 인자)로만** 사용. 부트 스키마 체크·주간 리포트 조회·`chat_history` insert payload에서 `debate_type` 의존 제거(SQL 추가 없음)
- Discord 피드백 버튼: `customId`에 `analysis_type` 포함(`feedback:save:{chatHistoryId}:{analysisType}:{feedbackType}:{personaKey}`), `interactionCreate`에서 `feedback:save:*` 선처리 후 `saveAnalysisFeedbackHistory` → `ingestPersonaFeedback`; 인터랙티브 컴포넌트가 있을 때는 `broadcastAgentResponse`가 **webhook 대신 채널 봇 메시지**로 전송해 버튼 상호작용 안정화 (`index.ts`, `src/interactions/interactionRouter.ts`에서 중복 라우팅 제거)

### Added
- 피드백 기반 **소프트 보정**: `confidence_calibration`에 `preferred_claim_types` / `preferred_evidence_scopes` / 바이어스 필드 누적(`personaMemoryService.refreshPersonaMemoryFromFeedback` + `claim_feedback`·`analysis_claims` 메타)
- `src/services/feedbackDecisionCalibrationService.ts` — `buildFeedbackDecisionSignal`, CIO 직전 프롬프트 블록, `analysis_generation_trace.memory_snapshot.feedback_adjustment_meta`(CIO 행만)
- 포트폴리오 토론: Ray~Drucker 응답에서 in-memory claim 추출 → 보정 시그널 → CIO `decide` 입력에 힌트만 추가; Discord 결정 요약에 한 줄 부가
- Phase 2 의사결정 엔진(실행 없음): `src/contracts/decisionContract.ts`, `riskPolicyContract.ts`, `src/policies/committeeWeightsPolicy.ts`, `decisionThresholdPolicy.ts`, `src/services/committeeDecisionService.ts`, `riskVetoService.ts`, `decisionEngineService.ts`, `src/application/runDecisionEngineAppService.ts`, `src/repositories/decisionArtifactRepository.ts`
- `claimRepository.listClaimsForChatHistory` — 결정 엔진이 동일 분석의 claim을 참조
- DB append-only SQL: `docs/sql/append_phase2_decision_tables.sql` (`decision_artifacts`, `committee_vote_logs`)
- `npm run check:decision-engine` (`scripts/decision-engine-self-check.ts`)
- **Phase 2 hardening**: `docs/sql/append_phase2_decision_tables_hardening.sql` — `engine_version`/`policy_version`/`veto_rule_ids_json`/`supporting_claim_ids_json`/`original_decision`, idempotency 유니크 인덱스, `committee_vote_logs.decision_artifact_id` FK 및 raw_vote_reason
- `src/policies/decisionEnginePolicy.ts` — 엔진·정책 버전 상수(`DECISION_ENGINE_VERSION` 등)

### Changed
- `runPortfolioDebateAppService`: `runAnalysisPipeline` 후 `runDecisionEngineAppService` best-effort 호출, 반환에 `decisionArtifact` 포함
- `index.runPortfolioDebate`: 결정 요약 추가 브로드캐스트(짧은 텍스트, 주문 없음)
- **Hardening**: `decision_artifacts` 먼저 저장 후 `artifact_saved` / `duplicate_artifact_skipped`, `committee_vote_logs`는 `decision_artifact_id`로 연결·`vote_logs_saved`; `VetoResult`에 `vetoRuleIds`·`originalDecision`/`finalDecision`; `PersonaCommitteeJudgment.rawVoteReason`
- `decisionArtifactRepository`: Postgres `23505` → duplicate 처리, `isPostgresUniqueViolation` export

### Docs
- Phase 2.5 Advisory Execution: `README.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md`, `docs/CHANGELOG.md`
- `SYSTEM_ARCHITECTURE.md`, `SYSTEM_REVIEW.md`, `DATABASE_SCHEMA.md`, `TEST_CHECKLIST.md`, `ROADMAP.md`, `DOCUMENTATION_POLICY.md`, `README.md`, `OPERATIONS_RUNBOOK.md`, `CHANGELOG.md`
- 피드백 버튼 `customId`/Discord 전송 방식(`webhook` vs bot message)·운영 검증 절차: `README.md`, `SYSTEM_ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `OPERATIONS_RUNBOOK.md`, `TEST_CHECKLIST.md`, `SYSTEM_REVIEW.md`

## 2026-03-28

### Added
- 스키마 타입 계약 점검: `npm run check:schema-contract` (`scripts/check-schema-contract.ts`, `src/types/dbSchemaContract.ts`)
- 실운영 DB 스모크: `npm run check:runtime-e2e` (`scripts/runtime-e2e-check.ts` — 분석·claim·trace·피드백·메모리·fallback 로그 검증)
- Phase 1 구조 스모크: `npm run check:phase1-structure` (`scripts/phase1-structure-self-check.ts`, `scripts/setDummySupabaseEnv.cjs` — 모듈 로드 시 Supabase URL 필수 회피)
- `src/interactions/interactionRouter.ts`, `panelInteractionHandler` 확장(메인 패널), `src/repositories/generationTraceRepository.ts`, `personaMemoryRepository.ts`, `chatHistoryRepository.insertChatHistoryWithLegacyFallback`
- `src/application/runPortfolioDebateAppService.ts`, `runTrendAnalysisAppService.ts`, `runOpenTopicDebateAppService.ts`, `src/discord/analysisFormatting.ts`

### Changed
- `llmProviderService.ts`가 `ProviderGenerationResult.generation_meta`로 Gemini 기본 경로와 OpenAI→Gemini fallback을 구분
- `src/contracts/providerPolicy.ts`의 `fallbackApplied`/`fallbackReason`이 위 메타만 해석하도록 수정(의도적 Gemini 사용을 fallback으로 오표시하지 않음); `OpenAiBudgetGuardResult` 타입 명시
- 데이터 센터 실행: `index.ts` → `runDataCenterAppService` → `executeWithProvider` 경유
- 피드백 버튼: `index.ts` → `interactionRouter` → `feedbackInteractionHandler` → `runFeedbackAppService`; `analysis_feedback_history` insert/중복 조회는 `feedbackRepository`
- `analysisPipelineService`: `claimContract.extractClaimsByContract`, `generationTraceRepository`, `fallbackPolicy` 로깅; `claimLedgerService.extractClaimsWithFallbackMeta`로 단일-claim fallback 메타 노출
- `personaMemoryService` load/upsert: `personaMemoryRepository` 사용

### Refactor
- `runAnalysisAppService`가 `runAnalysisPipeline` 직접 호출 + 포트폴리오/트렌드/오픈토픽 서비스 re-export
- `index.ts`: 금융·트렌드·오픈토픽 분석 본문 제거(앱 서비스 위임), `safeInsertChatHistoryAndGetId` 제거 → `insertChatHistoryWithLegacyFallback`
- `index.ts`: 포트폴리오 패널 버튼·계좌 select·매매 모달 제출 → `src/interactions/portfolioInteractionHandler.ts` 위임(동작 동일)

### Docs
- `DATABASE_SCHEMA.md`, `SYSTEM_ARCHITECTURE.md`, `SYSTEM_REVIEW.md`, `DOCUMENTATION_POLICY.md`, `TEST_CHECKLIST.md`, `README.md`, `OPERATIONS_RUNBOOK.md`, `ENVIRONMENT.md`, `.env.example` 갱신(운영 검증 명령·환경변수·MUST/OPTIONAL 구분)

## 2026-03-26

### Added
- 데이터 센터 패널 추가: `panel:main:data_center`, `panel:data:daily_logs`, `panel:data:improvement` (`panelManager.ts`, `index.ts`)
- 데이터센터 실행 경로 추가: Peter Thiel 페르소나 기반 로그 분석/개선안 제안 (`index.ts`)
- 문서 체계 추가: `docs/` 운영 문서 9종 생성
- self-check 추가: `uiux_provider_valuation_self_check.ts`

### Changed
- provider 중앙 정책 확장: `THIEL`, `HOT_TREND`를 OpenAI 우선으로 설정 (`llmProviderService.ts`)
- 핫 트렌드(`전현무`) 응답 경로를 provider 정책 기반으로 변경 (`trendAnalysis.ts`)
- 피드백 버튼 라벨/안내 문구를 직관형으로 변경 (`index.ts`)
- AI 투자 회의 소개 문구에서 JYP 제거 및 실제 참여 구조 반영 (`panelManager.ts`)

### Fixed
- US 종목 fallback 통화 경로 분리로 valuation 과대계산 수정 (`portfolioService.ts`, `quoteService.ts`)
- fallback price source metadata 추가(`live_usd/live_krw/fallback_usd/fallback_krw/snapshot_krw/purchase_basis_krw`)
- 비정상 평가액 guard 및 snapshot sanity guard 추가 (`portfolioService.ts`)

### Refactor
- trend 경로에 provider-aware 함수 추가 (`generateTrendSpecialistResponseWithProvider`)
- quote 결과 타입에 source metadata 확장 (`QuoteResult.priceSource`)

### Docs
- README에 문서 안내 및 문서-코드 동시 갱신 규칙 반영
- 운영/아키텍처/DB/환경/테스트/로드맵/정책 문서 추가

## 다음 변경부터의 필수 체크
- 코드 변경 전: 영향 문서 목록 판단
- 코드 변경 후: `CHANGELOG.md` 포함 문서 동시 수정
- PR/배포 전: CHANGELOG 누락 여부 확인
