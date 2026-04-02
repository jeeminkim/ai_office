# SYSTEM ARCHITECTURE

## 목적
- 이 문서는 `README.md`를 대체하지 않고, 실제 운영/개발에서 참조할 시스템 구조 정보를 보완한다.
- 기준 경로는 `C:\ai-office`이며, 현재 코드 기준으로 작성한다.

## 전체 시스템 개요
- 런타임 진입점은 `index.ts` 단일 프로세스 구조다.
- **로컬 운영 패널(MVP)**: `apps/control-panel/server.ts` — Express + 정적 UI(`apps/control-panel/public`). 본체와 별도 프로세스이며 `GET/POST /api/*`로 상태·기동·중지·프로세스·(고급) 로그 tail API를 제공한다. 기본 `127.0.0.1` 바인딩. **UI는 상태판 중심**이며 로그 raw는 기본 표시하지 않고, 경로 안내만 한다.
  - **패널 전용 로그**: `apps/control-panel/controlPanelLog.ts` → `logs/control-panel/control-panel.log_YYYYMMDD` (`CONTROL_PANEL` 이벤트: start/stop/restart/scan/kill/post_stop_verification 등). 본체 `office-ops`·`office-error`와 분리.
  - **보조 모듈**: `stopPipeline.ts`(graceful→다단계 검증→Windows `/F` 자동 fallback), `stopSafety.ts`/`stopErrorNormalize.ts`, `processScan.ts`(`verifyPidState`), 상태 요약 `state/control-panel-state.json`.
  - 로그 경로·헬스는 `loggingPaths.ts` / `logs/office-health.json`과 공유한다.
- **로깅**: `logger.ts` + `loggingPaths.ts` — 일별 `logs/daily/office-{runtime,error,ops,debug}_YYYYMMDD.log`, 카테고리 로그, 중복 억제, 보존 정책(`cleanupOldDailyLogs`).
- 인터페이스 계층은 Discord(버튼/모달/명령)이며, 상태 진입은 `panelManager.ts` 중심으로 제어한다.
- 비즈니스 로직은 포트폴리오/소비/토론/트렌드/데이터센터 흐름으로 분기된다.
- 데이터 저장소는 Supabase(Postgres)이고, 분석 산출물과 피드백 이력은 별도 테이블로 누적된다.
- LLM은 Gemini/OpenAI 혼합 구조이며 `llmProviderService.ts`에서 provider 선택 및 fallback을 중앙 제어한다.

## 계층 구조 (Phase 1 리팩토링)
1. **Interaction** (`src/interactions/` + `src/discord/handlers/interactionCreate/`)
   - **`index.ts` 역할**: env·`Client`/`Supabase`/`Webhook`·`safeDeferReply` 등 공통 유틸 부트스트랩 후, `interactionCreate`는 **`dispatchRoutesInOrder`**로 위임한다. 거대한 `if` 체인은 **`buildInteractionRoutes()`**에 등록된 `InteractionRoute[]`(버튼 / string select / modal 각각)으로 옮겼다. 동작은 기존과 동일하며 **자동 매매(advisory만)** 유지.
   - **`DiscordInteractionContext`** (`src/discord/InteractionContext.ts`): logger·supabase·`interactions.*`(defer/edit)·`panel`( `createPanelAdapter()` → `panelManager` 얇은 래핑)·`runtime`( `runTrendAnalysis` / `runPortfolioDebate` 등 index에 남은 오케스트레이션)·`portfolio` deps·`settings`(load/save user mode).
   - **`interactionRegistry.ts`**: `InteractionRoute` = `{ name, match, handle }` — 등록 **순서가 우선순위**. `match` 후 `handle`이 `true`면 종료; `false`면 다음 route(포트폴리오 `tryHandle` 패턴).
   - `interactionRouter.ts`: 메인 패널(`panel:main:*`) — registry의 `panel:main:early`에서 `routeEarlyButtonInteraction` 호출(`isMainPanelInteraction`으로만 매칭).
   - **decision / feedback / follow-up**: `decisionHandler.ts`, `feedbackHandler.ts`, `followupHandlers.ts` — 로직은 index에서 **이동만**(동작 변경 최소).
   - `instrumentConfirmationHandler.ts`: 종목 추가 모달 → 후보 저장 → `instr:*` (registry에서 호출).
   - `feedbackInteractionHandler.ts`: 레거시 보관.
   - `panelInteractionHandler.ts`: 메인 패널 네비게이션(트렌드 서브패널 포함).
   - **UI 정책 상수**: `src/discord/uiPolicy.ts` — decision > follow-up > feedback > navigation 우선순위 문서화(코드 주석).
   - **domain/ 미도입**: 루트 `*Service.ts`는 그대로 두고, 이번 단계에서는 **entrypoint 분산 + panelAdapter**만 적용(`README`/본 문서 참고).
2. **Application** (`src/application/`)
   - `runPortfolioDebateAppService.ts` / `runTrendAnalysisAppService.ts` / `runOpenTopicDebateAppService.ts`: 금융·트렌드·오픈토픽 분석 오케스트레이션(LLM, `runAnalysisPipeline` 호출); 포트폴리오 토론은 `runDecisionEngineAppService`(Phase 2) 후행
   - `runFeedbackAppService.ts`: 피드백·claim 매핑·이력 저장 조율
   - `runDataCenterAppService.ts`: 데이터 센터(THIEL) 실행
   - `buildRebalancePlanAppService.ts` / `executeRebalancePlanAppService.ts`: Phase 2.5 그림자 리밸런싱
   - `runClaimOutcomeAuditAppService.ts`: claim 사후 감사 배치
   - `runAnalysisAppService.ts`: 파이프라인 직접 호출 + 위 서비스 re-export
3. **Persistence** (`src/repositories/`)
   - Supabase 쿼리만: `chatHistoryRepository`, `claimRepository`, `feedbackRepository`, `personaMemoryRepository`, `generationTraceRepository`, `decisionArtifactRepository`, `supabaseClient.ts`
4. **Policy contracts** (`src/contracts/`)
   - `providerPolicy.ts`: 페르소나별 provider/model, `executeWithProvider`, budget guard 결과 타입(`OpenAiBudgetGuardResult`)
   - `claimContract.ts`: `extractClaimsByContract`, 단일-claim fallback 메타(`ClaimExtractionResult.fallbackUsed`)
   - `fallbackPolicy.ts`: provider/DB persist/quote fallback 결과 객체
   - **Phase 2**: `decisionContract.ts` / `riskPolicyContract.ts` — `DecisionType`, 위원 투표, veto 규칙 식별자(`VetoRuleId`)
5. **Policies** (`src/policies/`)
   - `committeeWeightsPolicy.ts`: 위원 가중치(하드코딩 단일 객체, 추후 설정 이전 가능)
   - `decisionThresholdPolicy.ts`: 가중 raw 점수 → 후보 `DecisionType` 매핑
6. **Decision services** (`src/services/`, Phase 2)
   - `committeeDecisionService.ts`: 페르소나 응답·claim 기반 judgment → 가중 투표(Phase 2.5: 선택적 `weightMultipliers`)
   - `riskVetoService.ts`: `riskPolicyContract` 입력으로 BUY/ADD 등 강등·차단
   - `decisionEngineService.ts`: 파이프라인 이후 claim 로드 → 투표 → veto → `decision_artifacts` / `committee_vote_logs` 저장(best-effort)
   - `personaPerformanceCalibrationService.ts` / `personaScorecardService.ts`: 성과 기반 소폭 투표 보정·데이터 센터 점수카드
7. **스키마 계약** (`src/types/dbSchemaContract.ts`)
   - 운영 DB 기준 `chat_history.id` = `number`(integer), FK 경로 동일 가정

## 핵심 실행 흐름

### 1) Discord 이벤트 수신
- Discord interaction/message는 `index.ts`에서 수신한다.
- 메인 패널 라우팅은 `panel:main:*`, 도메인 패널은 `panel:portfolio:*`, `panel:ai:*`, `panel:trend:*`, `panel:data:*` 패턴을 사용한다.

### 2) 라우팅 및 오케스트레이션
- 경량 라우팅 판단은 `orchestrator.ts` (`decideOrchestratorRoute`)가 수행한다.
- 금융 질의는 포트폴리오 스냅샷 경로, 트렌드 질의는 분리된 트렌드 경로로 진입한다.

### 3) 분석 파이프라인
- 분석 응답 생성 후 `analysisPipelineService.ts`가 후처리를 담당한다.
- 후처리에는 다음이 포함된다.
  - `analysis_generation_trace` 저장(가능 시 provider/model/cost 포함)
  - `analysis_claims` 추출/저장
  - `claim_outcome_audit` 스켈레톤 저장(best-effort)
  - 의사결정 질문 휴리스틱(`decisionPrompt.ts` `isDecisionPrompt`)이면 `DECISION` 로그 `DECISION_PROMPT detected`(persist 시점, `chat_history_id`·`analysis_type`·`persona_name`)

### 3b) Phase 2 — Decision Engine (포트폴리오 금융 토론 경로)
- `runPortfolioDebateAppService`가 `runAnalysisPipeline` 완료 후 `runDecisionEngineAppService`를 **best-effort**로 호출한다.
- 흐름: `analysis_claims`(동일 `chat_history_id`) 로드 → 위원별 judgment/투표(`committeeDecisionService`, `rawVoteReason`) → 가중 점수 → `riskVetoService`(`vetoRuleIds`, 후보→최종) → **`decision_artifacts` 선저장** → `committee_vote_logs`에 `decision_artifact_id`·버전 컬럼으로 연결 저장.
- Idempotency: DB 유니크 `(chat_history_id, analysis_type, engine_version)` 충돌 시 `duplicate_artifact_skipped`, vote log는 삽입하지 않음.
- 버전: `decisionEnginePolicy.ts`의 `DECISION_ENGINE_VERSION` / `DECISION_POLICY_VERSION`이 DB 컬럼과 동기화된다(스키마는 `append_phase2_decision_tables_hardening.sql`).
- 실패 시 분석 응답/기존 저장 경로는 유지되며, 로그에 `DECISION_ENGINE` 스코프로 기록된다.
- Discord: `index.runPortfolioDebate`가 결정 요약 문자열을 추가 브로드캐스트(짧은 섹션, 실행 없음).

### 3c) Phase 2.5 — Advisory Execution (그림자 리밸런싱, 주문 없음)
- **저장**: `buildRebalancePlanAppService`가 일반계좌 `buildPortfolioSnapshot` + 위원회 `DecisionArtifact`로 목표 비중 대비 초과/부족을 **최소 거래 금액·밴드**로 잘라 라인을 만든 뒤 `rebalance_plans` / `rebalance_plan_items`에 기록한다. `NO_ACTION`이면 플랜 생략.
- **Discord**: `postShadowRebalanceFollowUp`가 채널에 본문 + `rebalance:view|complete|hold:{planId}` 버튼. Webhook이 아닌 **봇 메시지**(컴포넌트 필요).
- **실행**: `리밸런싱 완료`만 `recordSellTrade`/`recordBuyTrade` + `portfolio_snapshot_history`(best-effort). **완료 전에는 trade_history를 건드리지 않음.** `이번엔 보류`는 `user_hold` + `USER_HOLD_DECISION`.
- **Claim 감사**: `runClaimOutcomeAuditAppService`가 `claim_outcome_audit`를 7d/30d 필드로 갱신(MVP는 시세 스냅샷; 과거 시세 리플레이 없음).
- **위원 성과 → 투표**: `personaPerformanceCalibrationService`가 감사 집계로 **bounded** 가중 배율을 만들고 `runCommitteeVote({ weightMultipliers })`에 전달. **피드백 calibration과 독립**. RAY/HINDENBURG는 패널티로 가중 하한(1.0) 유지. **veto/NO_DATA/리스크 게이트는 침범하지 않음.**

### 4b) 피드백 → 소프트 보정 (포트폴리오 토론, 제한적)
- **저장 이후**: `analysis_feedback_history` / `claim_feedback` / `refreshPersonaMemoryFromFeedback`가 `persona_memory.confidence_calibration`에 `preferred_claim_types`, `preferred_evidence_scopes`, `numeric_anchor_bias`, `actionable_bias`, `downside_bias`, `conservatism_floor` 등을 **소량(대략 ±0.1 범위)** 누적한다.
- **실행 시(토론)**: Ray~Drucker 응답 텍스트에서 `extractClaimsByContract`로 in-memory claim을 뽑고 `buildFeedbackDecisionSignal`로 점수 블렌드에 소프트 Δ를 적용한다. **RAY/HINDENBURG + downside-focused**인 경우 사용자 비선호로 **원 점수보다 낮아지지 않게** floor를 적용한다.
- **CIO 직전**: 보정 힌트는 **프롬프트 블록**으로만 주입되며, CIO는 Priority / Timing / Conviction / Monitoring 서술에 반영하도록 유도한다. **NO_DATA·valuation·quote 실패·Phase2 veto 경로는 피드백으로 완화하지 않는다**(코드상 별도 게이트 유지).
- **추적**: CIO 페르소나의 `analysis_generation_trace.memory_snapshot`에 `feedback_adjustment_meta`가 붙을 수 있다(스키마 변경 없음).

### 4a) Phase 3 — 현금흐름·지출·종목 메타 정합성
- **현금흐름**: 표준 `flow_type` 8종(`src/finance/cashflowCategories.ts`). 채팅 `!현금흐름추가`·모달 `modal:cashflow:add`·에이전트 스냅샷(`agents.ts`의 `formatCashflowSnapshotLine`)이 동일 계열을 사용.
- **지출 할부**: `expenses` 확장 컬럼 + 모달 필드 → `parseInstallmentLine`. SQL은 `docs/sql/phase3_finance_instrument_integrity.sql`.
- **이중 방어**: 앱에서 확정 시 `validateConfirmedInstrument`; DB에서 `portfolio`/`trade_history`에 NOT VALID CHECK(레거시 행 보존). `cashflow.flow_type`도 CHECK(NOT VALID)로 신규 행만 표준 강제.

### 4) 저장 및 피드백 루프
- **버튼 `customId`**: `feedback:save:{chatHistoryId}:{analysisType}:{feedbackType}:{personaKey}` (`getFeedbackButtonsRow` in `index.ts`).
- **의사결정 버튼 `customId`**: `decision:select|{snapshotUuid}|{optionIndex}` — 브로드캐스트 시 `decision_snapshots`에 옵션 JSON 저장, 클릭 시 `getDecisionSnapshotById`로 복원(본문 재파싱 없음). `broadcastAgentResponse`가 휴리스틱 매칭 시 **피드백 행 위에** 최대 4개 버튼 행을 추가한다.
- **선택 후 실행**: `handleDecisionButtonInteraction` → `insertDecisionHistoryRow`(`DECISION_PERSISTED`) → `executeDecisionAfterSelection`(`decisionExecutionService.ts`) — **자동 매매 없음**. `immediate_sell`/`staged_sell`은 `buildRebalancePlanAppService`에 `advisoryOverride`(EXIT/REDUCE)로 그림자 리밸 텍스트·선택적 `rebalance_plans` 저장, `cio_followup`은 Gemini 요약, `clarify`는 다음 질문 템플릿. 채널에 후속 메시지 필수.
- **Follow-up 질문(의사결정과 분리)**: `isDecisionPrompt`가 **아닐 때** `analyzeFollowupPrompt`가 질문을 감지하면 `followup_snapshots`에 옵션을 저장하고 버튼/스트링 셀렉트/모달을 붙인다(`followupPromptService.ts`, `broadcastAgentResponse`). 클릭·제출은 `followup:select|*` / `followup:menu|*` / `followup:input|*` / `modal:followup:*`로 `interactionCreate`에서 처리하며, 선택 후 **포트폴리오 토론·오픈 토픽·트렌드** 중 하나로 즉시 이어진다(자동 매매 없음, dead-end 없음).
- **페르소나 응답 후처리**: `normalizeProviderOutputForDiscord` → `postProcessPersonaOutputForDiscord`(`src/discord/personaResponsePostProcess.ts`) — 기술 기호가 있으면 **쉬운 설명**을 덧붙이고 `ensureCompleteResponse`로 미완결 문장·placeholder를 정리한다.
- **`analysis_feedback_history` 키**: integer `chat_history.id`는 **`chat_history_ref`(TEXT)** 로 저장하는 경로를 우선하고, UUID FK `chat_history_id`에는 넣지 않는다(레거시 스키마 호환을 위해 insert 실패 시에만 `chat_history_id` 재시도 — `feedbackService.ts`).
- **`analysisType`**: **customId 파싱값이 단일 소스**이다. `chat_history.debate_type` 컬럼을 조회·덮어쓰기에 쓰지 않는다(`findChatHistoryById`는 `id`/`user_id` 검증용 컬럼만). SQL로 `debate_type`을 복구하지 않고 code-side로 정렬.
- **처리 순서**: 버튼 클릭 → `interactionCreate` → `safeDeferReply` → `handleFeedbackSaveButtonInteraction` → `saveAnalysisFeedbackHistory`(`feedbackService.ts`) → `ingestPersonaFeedback`(`feedbackIngestionService.ts`, claim 매핑·`claim_feedback`). `claim_id`가 UUID가 아닌 경우 `claim_feedback` 삽입은 건너뛰고(non-fatal) 피드백 이력은 유지. 동일 `feedbackType` 연타는 서비스 계층 중복 방어 + UX 메시지.
- **Discord 전송**: 분석 응답에 버튼·기타 **MessageComponent**가 붙는 경우 `broadcastAgentResponse`는 **Incoming Webhook이 아니라 봇이 채널에 `channel.send`** 한정으로 붙인다. Webhook 메시지는 interaction 소유권/컴포넌트 안정성 측면에서 불리할 수 있음.
- 저장소 접근은 `src/repositories/*`에서 **Supabase 쿼리만** 수행한다(예: `chatHistoryRepository`, `claimRepository`, `feedbackRepository`).
- `personaMemoryService.ts`가 피드백 이력을 집계해 `persona_memory`를 갱신한다.

## Discord -> Index -> Pipeline -> LLM -> Supabase 흐름
1. Discord 버튼/모달/명령 입력
2. `index.ts`가 `safeDeferReply`/`safeUpdate`로 인터랙션 안정화
3. 사용자 의도별 함수 호출
   - 포트폴리오: `buildPortfolioSnapshot` + `portfolioUx`
   - 금융 토론: `index.runPortfolioDebate` → `runPortfolioDebateAppService`(저장·파이프라인·**Phase2 decision engine**) + `broadcastAgentResponse` + 선택적 결정 요약
   - 트렌드: `runTrendAnalysis` → `runTrendAnalysisAppService` + 브로드캐스트
   - 오픈 토픽: `runOpenTopicDebate` → `runOpenTopicDebateAppService` + 브로드캐스트
   - 데이터센터: `runDataCenterAction`
4. LLM 호출
   - 중앙 정책 대상 페르소나: `generateWithPersonaProvider`
   - 데이터 센터(THIEL): `runDataCenterAppService` → `src/contracts/providerPolicy` (`executeWithProvider`)
   - Gemini 직접 경로: `generateGeminiResponse` (fallback 또는 비대상 페르소나)
5. 결과 메시지 송신
   - 길이 제한 대응: `discordResponseUtils.ts`의 chunking/route 보정
6. 산출물/피드백 저장
   - `chat_history`, `analysis_generation_trace`, `analysis_claims`, `analysis_feedback_history`, `claim_feedback`, `persona_memory`

## 주요 소스 파일 간 관계
- `index.ts`
  - Discord 진입·interaction/message 라우팅·defer/reply 안정화·**`feedback:save:*` 버튼 핸들러**·`broadcastAgentResponse`(분석 본문은 application으로 이전됨)
- `src/interactions/interactionRouter.ts`
  - 메인 패널 등 선 라우팅(피드백 버튼은 `index.ts`에서 처리)
- `src/discord/analysisFormatting.ts`
  - 공통 응답 정규화·분석 타입 추정 등(토론/데이터센터에서 공유)
- `panelManager.ts`
  - 메인/서브 패널 구성과 패널 복구(state 파일 기반)
- `portfolioService.ts`
  - 포지션 평가, 환율 반영, quote fallback, snapshot 빌드, sanity guard
- `quoteService.ts`
  - 짧은 TTL 메모리 캐시 → **Yahoo quote** → **Yahoo chart 1d 최근 종가(EOD)** → **DB/스냅샷 fallback** 순 다단계 조회
  - 종목별 메타: `resolved_quote_symbol`, `price_source_kind`, `price_asof`, `market_state`, `fallback_reason`; 로그 `QUOTE_RESOLUTION`(예: `current_success`, `eod_fallback_used`, `cache_fallback_used`, `symbol_corrected`)
- `instrumentRegistry.ts` 등
  - KR `quote_symbol` 정합(KOSPI `.KS` / KOSDAQ `.KQ`, 6자리) — 조회·정규화 시 보정
- `panelManager.ts` — `getQuickNavigationRows({ highlight })`
  - 주요 응답 직후 메인 메뉴 버튼을 다시 제공(`panel:main:reinstall`, `panel:main:portfolio`, …). Discord 5버튼/행 제한으로 2행 구성
- `index.ts` — `sendPostNavigationReply` → followUp 우선, 실패 시 `channel.send`; 로그 `UI` `post_response_navigation_attached`
- `llmProviderService.ts`
  - persona별 provider/model 정책 + OpenAI budget guard + fallback
  - 응답에 `generation_meta`를 붙여, **Gemini 기본 페르소나**와 **OpenAI 실패 후 Gemini fallback**을 구분한다.
- `src/contracts/providerPolicy.ts`
  - `generateWithPersonaProvider` 래핑; `fallbackApplied`/`fallbackReason`은 위 메타만 해석한다(문서용 타입이 아님).
- `analysisPipelineService.ts`
  - trace(`generationTraceRepository`)/claims(`claimContract` + `claimLedgerService.saveClaims` → `claimRepository`) 저장 오케스트레이션
- `claimLedgerService.ts`
  - claim 추출, 저장, feedback claim 매핑
- `feedbackIngestionService.ts` / `feedbackService.ts`
  - 피드백 저장, 중복 방어, 매핑 메타데이터 저장
- `personaMemoryService.ts`
  - 도메인 규칙(keyword 등); DB read/write는 `personaMemoryRepository` 경유
- `logger.ts`
  - 런타임 로그 + 카테고리 파일 로그(openai/quote/interaction/db/portfolio/boot/llm)

## LLM 혼합 운영 구조
- 중앙 정책 함수: `getPersonaModelConfig()` in `llmProviderService.ts`
- 현재 OpenAI 우선 대상(코드 기준):
  - `HINDENBURG`
  - `SIMONS`
  - `THIEL` (데이터 센터)
  - `HOT_TREND` (전현무)
- 그 외 기본은 Gemini
- OpenAI fallback 조건:
  - API 키 없음
  - 월 호출량/예산 guard 초과
  - OpenAI 호출 오류

## 장애 시 fallback 흐름
- LLM:
  - OpenAI 경로 실패 시 Gemini로 자동 fallback (`OPENAI_FALLBACK_TO_GEMINI=on` 기본)
- Discord:
  - `reply`/`editReply`/`followUp` 라우팅 보정
  - 메시지 2000자 초과 시 chunking
  - interaction route 실패 시 channel send fallback
- Quote (다단계, 종목 단위):
  - 1차 Yahoo **`v7/finance/quote`** (브라우저형 `User-Agent` 등 헤더) → 실패 시 `QUOTE_RESOLUTION`에 `yahoo_v7_http_error`(status·401 등 분리)
  - 2차 **`v8/finance/chart`** 일봉 EOD → 실패 시 `yahoo_chart_http_error`
  - 3차 짧은 **메모리 TTL 캐시** → 4차 포트폴리오 행 **마지막 유효가** — 0/NaN·비정상 가격은 valuation 오염 방지·guard 유지
  - `QuoteResult.request_failure_reason` / `is_stale`, `dominantFailureReason`으로 운영·AI 스냅샷에 지연 시세 명시 가능
  - `price_source_kind` / `QuotePriceSource`로 환산 경로 분리; `degraded_quote_mode`는 “실시간 호가가 아닌 값 혼입” 의미에 맞춤
- Discord 분석 브로드캐스트(`broadcastAgentResponse`):
  - 컴포넌트 행 우선순위: **decision → follow-up → feedback** (최대 5행), 초과 시 `UI_COMPONENT_POLICY` 로그
  - **NO_DATA**는 가능하면 **본문**에 안내(버튼 행 대신)하여 행 절약
- `logs/office-health.json`: `panels.*`(패널 복구·폴백 채널), `ux.*`(follow-up/decision 최근 이벤트 시각)
- **System operator (로컬)**: `logAnalysisService.ts` — `logs/daily/office-{error,ops,runtime}_*`, `logs/quote/quote.log_*`, `logs/interaction/interaction.log_*`, `logs/control-panel/control-panel.log_*`, `office-health.json`을 읽기 전용으로 집계·패턴 매칭. Discord `panel:system:check|detail|actions`로 Peter Thiel 스타일 진단 리포트 출력(LLM 호출 없음, 30초 캐시).
- DB:
  - 일부 insert 확장 컬럼 실패 시 base 컬럼 fallback insert(`analysis_generation_trace`, `generationTraceRepository`)
  - `chat_history` insert 확장 컬럼 실패 시 레거시 컬럼만 재시도(`chatHistoryRepository.insertChatHistoryWithLegacyFallback`)

## 현재/예정 서비스 모듈 관계
- 현재 반영됨(코드 확인):
  - `analysisContextService.ts`
  - `analysisPipelineService.ts`
  - `claimLedgerService.ts`
  - `feedbackIngestionService.ts`
  - `personaMemoryService.ts`
  - `llmProviderService.ts`
  - `usageTrackingService.ts`
- 1단계 리팩토링 확장 포인트(잔여):
  - `index.ts`의 나머지 interaction 분기(포트폴리오 매매 모달·select 등)를 interaction handler로 점진 이전
  - persona별 prompt/response contract를 adapter로 고정
  - DB write best-effort 경로를 공통 transaction boundary/queue로 통합

## 운영 관점 주요 경계
- 동기 처리 경계:
  - Discord interaction 응답은 제한 시간 내 ack/defer 우선
- 비동기 후처리 경계:
  - claim/trace/memory 반영 실패는 사용자 응답 실패로 전파하지 않음(best-effort)
- 상태 파일 경계:
  - 패널 메시지 복구용 `state/discord-panel.json` — 채널 미기록 시 `DISCORD_MAIN_PANEL_CHANNEL_ID` / `DEFAULT_CHANNEL_ID`로 폴백 후 재생성(`PANEL restore *` 로그)

## 확인 필요
- 레포 `schema.sql`의 `chat_history.id` 표기와 운영 DB가 다를 수 있으므로, 배포 DB에서 실제 타입을 주기적으로 확인한다(코드 계약은 `integer`/`number`).
- 운영환경에서 실제 적용된 migration 순서(특히 `chat_history`, `analysis_generation_trace`)는 배포 DB에서 재확인 필요.
