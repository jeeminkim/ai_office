# ai_office

Discord + Node.js + TypeScript + Supabase based investment office bot.

## Run

1. Set environment variables in `.env`
2. Install dependencies
3. Build and run

```bash
npm install
npm run build
npm start
```

## Discord interaction (entrypoint)

- **`index.ts`**는 환경·클라이언트·Supabase·`safeDeferReply` / `safeEditReply` 등을 초기화한 뒤, `interactionCreate`는 **`buildInteractionRoutes()`** + **`dispatchRoutesInOrder`** 로 버튼·셀렉트·모달을 처리한다. (`src/discord/handlers/interactionCreate/`, `src/discord/interactionRegistry.ts`, `src/discord/InteractionContext.ts`)
- **`createPanelAdapter()`** (`src/discord/adapters/panelAdapter.ts`)는 `panelManager`를 감싼 얇은 레이어로, 핸들러가 패널 빌더 구현에 직접 묶이지 않게 한다.
- **루트 `quoteService` / `portfolioService` 등**은 이번 단계에서 `domain/`으로 옮기지 않았다. 오케스트레이션은 index의 `runtime` 번들로 컨텍스트에 주입한다.
- **운영 스모크(로컬)**: `npm run smoke:interaction` — 라우트 개수·이름만 출력(Supabase dummy env 선로드). `npm run smoke:followup-routes`, `npm run smoke:panel-restore`.

## Logging (일별 + 운영 요약)

- **일별 파일** (`logs/daily/`): `office-runtime_YYYYMMDD.log`(상세·INFO, INTERACTION 등 고빈도는 기본적으로 여기서 제외되고 카테고리 로그에만 기록), `office-error_YYYYMMDD.log`, `office-ops_YYYYMMDD.log`(부팅·연결·패널·스키마·피드백 실패·리밸·ERROR 등 핵심), 필요 시 `office-debug_YYYYMMDD.log`(`LOG_DEBUG=1`).
- **카테고리 로그** (`logs/openai`, `logs/interaction` 등): 기존과 동일하게 일별 파일 유지.
- **중복 억제**: 동일 WARN/ERROR가 짧은 시간 반복되면 full 로그는 한 번만, 이후 `LOGGER duplicate suppressed` 요약(`LOG_SUPPRESS_WINDOW_MS`, 기본 10초).
- **보존**: `logs/daily/office-*.log` 및 동일 폴더의 일별 파일은 약 **14일** 후 자동 삭제(`OFFICE_LOG_RETENTION_DAYS`로 조정).
- **헬스**: `logs/office-health.json` — 기존과 동일.

환경 변수 예: `LOG_DEBUG=1`, `LOG_VERBOSE_RUNTIME=1`(INTERACTION INFO를 메인 runtime 일별에도 기록), `OFFICE_LOG_RETENTION_DAYS=14`.

## AI Office Control Panel (로컬 웹 MVP)

Discord와 무관한 **로컬 전용** 운영 패널입니다. 기본 `127.0.0.1:7788` 에만 바인딩합니다.

```bash
npm run build
npm run control-panel
# 개발: npm run control-panel:dev
```

- **UI 원칙**: 출근 시 기동·퇴근 후 상태 확인에 맞춘 **상태판** 중심이다. **로그 본문은 화면에 대량 표시하지 않는다.** 대신 어떤 파일을 볼지 경로만 안내한다.
- 브라우저에서 실행 여부·PID·heartbeat·마지막 중지/kill/프로세스 검사 요약을 본다. 기동/중지/재기동(패널이 spawn한 `node dist/index.js`), 프로세스 검사, 안전 종료/kill.
- **패널 전용 로그**(start/stop/kill/scan 이벤트, `CONTROL_PANEL` 접두): `logs/control-panel/control-panel.log_YYYYMMDD` — 본체 `office-ops`와 역할이 겹치지 않게 분리.
- **본체 로그**: 핵심 운영 `logs/daily/office-ops_*.log`, 오류 `logs/daily/office-error_*.log`, (선택) 상세 `logs/daily/office-runtime_*.log`. **상태 스냅샷** `logs/office-health.json`. 패널이 띄운 자식 stdout: `logs/daily/control-panel-child_*.log`.
- **상태 캐시**(UI 요약): `state/control-panel-state.json` (마지막 중지 시도·검사 요약 등).
- **중복 기동 방지**: `office-health.json` 기준 하트비트가 살아 있으면 기동 거부.
- **Windows 중지(중요)**: 같은 패널 세션에서 spawn한 프로세스는 **`child.kill('SIGTERM')` 우선** → 약 **1.5s / 4s / 8s** 단계로 `post_stop_verification`(attemptNo 1~3) 기록. 여전히 살아 있고 **ai-office로 안전 식별**(`tracked`·`matchedAiOffice`·명령줄·health pid 정합 등)되면 **자동 `taskkill /F /T`**. 임의 PID에는 자동 `/F` 없음. **`stopPhase`**(`REQUESTED` → `GRACEFUL_SENT` → `VERIFYING` → `FORCE_SENT` → `STOPPED`/`FAILED`)와 **`stop_final_status`**는 `state/control-panel-state.json`·상태판에 요약. **UI에는 Windows stderr 원문을 넣지 않고** 정규화 문구만 표시.
- **중지**는 패널이 추적한 자식 PID 위주(`state/control-panel-child.json`). PM2 등으로 띄운 프로세스는 **프로세스 검사** 후 안전 종료/강제 kill 규칙을 따름.
- 환경: `CONTROL_PANEL_PORT`, `CONTROL_PANEL_HOST`(기본 `127.0.0.1`).

Windows에서는 방화벽·다른 터미널에서 이미 띄운 `node`와 PID가 겹칠 수 있으므로, kill 전에 목록의 `matchedAiOffice`와 `command`를 반드시 확인하세요. 중지가 안 되면 `control-panel.log_*` 의 `post_stop_verification`·`stop_force_fallback_*`·`stop_final_status` 와 `office-error` 를 함께 본다.

## PM2

```bash
pm2 start dist/index.js --name ai-office --interpreter node
pm2 logs ai-office
pm2 restart ai-office
pm2 stop ai-office
```

- **`pm2 stop ai-office`**: 프로세스를 멈춤(목록에는 남음). 다시 띄우려면 `pm2 start ai-office`.
- **`pm2 delete ai-office`**: PM2 목록에서 완전히 제거(필요할 때만).

### Node가 종료되지 않을 때 (Windows)

1. 먼저 **PM2**를 쓰는 경우: `pm2 stop ai-office` 후 `pm2 list`로 상태 확인.
2. 터미널에서 직접 띄운 경우: 해당 창에서 **`Ctrl+C`**.
3. 그래도 남아 있으면 PID 확인 후 **가능하면 정상 종료부터**:
   ```powershell
   Get-Process -Name node -ErrorAction SilentlyContinue
   taskkill /PID <PID>
   ```
4. 응답 없을 때만 **강제 종료** (마지막 수단):
   ```powershell
   taskkill /PID <PID> /F
   ```

## Supabase Schema Apply

1. Open Supabase SQL editor
2. Run `schema.sql`
3. Verify tables: `stocks`, `portfolio`, `expenses`, `cashflow`, `user_settings`, `chat_history`

## Operational Stability Patch Runbook

Apply the additional SQL for usage tracking and feedback integrity before running the latest runtime.

```sql
-- OpenAI usage tracking + trace extension
-- file: openai_budget_migration.sql

-- Feedback integrity (unique + mapping metadata)
-- file: feedback_integrity_migration.sql

-- Phase 2.5 — shadow rebalance plans + claim_outcome_audit extensions
-- file: docs/sql/phase2_5_advisory_execution.sql

-- Phase 3 — 현금흐름 표준 유형, 지출 할부 컬럼, 종목 등록 후보(pending) 테이블, portfolio/trade_history KR·US 메타 CHECK(NOT VALID)
-- file: docs/sql/phase3_finance_instrument_integrity.sql
```

### Phase 2.5 — Advisory Execution (no broker / no auto-orders)

- **그림자 리밸런싱**: 포트폴리오 토론 후 위원회 결정이 있으면 **일반계좌 스냅샷**으로 구체 매매 라인(매도/매수 수량·추정금액)을 계산해 `rebalance_plans`에 저장한다. **증권사 API로 주문하지 않는다.**
- **Discord**: 채널 메시지로 실행안 본문 + `리밸런싱 계획 보기` / `리밸런싱 완료` / `이번엔 보류` 버튼. **`리밸런싱 완료`를 누르기 전까지 `trade_history`는 변경하지 않는다** (사용자가 HTS/MTS에서 체결했다는 MVP 전제로 `recordSellTrade` / `recordBuyTrade` 기록).
- **데이터 센터**: `위원별 성과`, `Claim 감사 실행`, `리밸런싱 계획 보기`(대기 플랜 조회).
- **위원회 가중치**: `claim_outcome_audit` 기반 **소폭** 성과 보정(`personaPerformanceCalibrationService`)이 `committeeDecisionService` 투표 가중에만 반영된다. **피드백 calibration과 별개**이며, **veto·NO_DATA·리스크 게이트는 약화하지 않는다.**

### Phase 3 — 현금흐름·지출·종목 등록 정합성

- **현금흐름** `flow_type`은 표준 8종(`SALARY`, `BONUS`, `LOAN_IN`, `LOAN_PRINCIPAL`, `LOAN_INTEREST`, `CONSUMPTION`, `OTHER_IN`, `OTHER_OUT`)만 저장한다. 레거시 영문 별칭은 `parseCashflowFlowType`(`src/finance/cashflowCategories.ts`)에서 매핑된다. SQL 마이그레이션으로 기존 행을 갱신한 뒤 `CHECK`(NOT VALID)로 신규 행을 제한한다.
- **지출 할부**: `expenses`에 `is_installment`, `installment_months`, `monthly_recognized_amount`, `installment_start_date`가 추가된다(마이그레이션 필수). 모달 한 줄 `Y 3 2026-01-01` 형식 또는 일시불 `N`.
- **종목 추가**: `modal:portfolio:add`는 후보만 저장(`instrument_registration_candidates`)하고, **확인** 버튼(`instr:confirm:*`) 후에만 `stocks`·`recordBuyTrade`가 실행된다. 후보가 1건이어도 자동 확정하지 않는다.

Build and run:

```bash
npm run build
npm start
```

## Self-check Commands

Run these checks after deploy/restart:

```bash
# Operational schema type contract (chat_history.id = number)
npm run check:schema-contract

# Phase 1 layer exports (interaction / application / contracts / repositories smoke)
npm run check:phase1-structure

# Runtime E2E smoke against real Supabase (requires PHASE1_TEST_DISCORD_USER_ID or TEST_DISCORD_USER_ID)
npm run check:runtime-e2e

# Phase 2 decision engine (committee vote + risk veto + idempotency; apply docs/sql/append_phase2_decision_tables.sql then append_phase2_decision_tables_hardening.sql for full persistence)
npm run check:decision-engine

# OpenAI mixed provider + budget/fallback + claim pipeline
node dist/openai_phase1_self_check.js

# Discord response safety (chunking/route/degraded message)
node dist/discord_response_self_check.js

# UI/UX feedback flow stability (duplicate/idempotent/mapping fallback)
node dist/uiux_stability_self_check.js

# Quote error classification and breakdown aggregation checks
node dist/quote_logging_self_check.js

# Logger category sink + KST daily file routing checks
node dist/logging_self_check.js
```

Quick log checks:

```bash
# PM2 runtime
pm2 logs ai-office

# Category file logs (KST daily files)
# logs/openai/openai.log_YYYYMMDD
# logs/quote/quote.log_YYYYMMDD
# logs/interaction/interaction.log_YYYYMMDD
```

## Notes

- Portfolio identity key is `discord_user_id`
- Mode setting is persisted in `user_settings`
- Main panel state file is `state/discord-panel.json`

## Quote resolution (포트폴리오 시세)

시세는 **종목 단위**로 조회되며, 실패해도 전체 스냅샷이 한 번에 무너지지 않도록 설계되어 있다. 계층은 대략 다음과 같다.

1. **1차 — Yahoo quote (current)**  
   기존 실시간/지연 시세 경로. 성공 시 `QUOTE_RESOLUTION` 로그에 `current_success`가 남을 수 있다.
2. **2차 — Yahoo chart 일봉(최근 유효 종가)**  
   quote가 불안정하거나 한국장 종료 후 등 **종가 수준**이 더 신뢰될 때 사용. KR은 세션에 따라 EOD 우선이 되도록 설계. 로그: `eod_fallback_used`.
3. **3차 — DB 스냅샷/포트폴리오 행 기반 fallback**  
   마지막으로 저장된 유효 가격 등. 로그: `cache_fallback_used`.

KR 종목은 조회 시 **`quote_symbol` 보정**(예: KOSPI→`.KS`, KOSDAQ→`.KQ`, 6자리 정합)이 가능하면 적용되며, 잘못 저장된 기호도 가능한 범위에서 바로잡는다. 로그: `symbol_corrected`(또는 `INSTRUMENT` 보정 로그).

포지션·요약에는 `resolved_quote_symbol`, `price_source_kind`(live / delayed / eod / cache / fallback 등), `price_asof`, `market_state`, `fallback_reason` 메타가 붙을 수 있으며, Discord 포트폴리오 메시지에는 **가격 기준 힌트**와 **일부 종목 실패 요약**이 표시된다. `degraded_quote_mode`는 스냅샷 수준 요약으로 유지하고, 세부는 종목·로그로 추적한다.

## Post-response navigation (Discord UX)

포트폴리오 조회·계좌 선택 성공, AI 토론·트렌드·데이터 센터·오픈 토픽 토론 완료 후 **별도 follow-up(또는 채널 전송)** 으로 `getQuickNavigationRows()` 메뉴를 다시 붙인다. `panel:main:*` / `panel:main:reinstall`(메인) customId를 재사용하므로 상단 패널을 스크롤하지 않아도 다음 기능을 고를 수 있다. 운영 확인: 로그 `UI` 스코프 `post_response_navigation_attached` / `post_response_navigation_failed`.

## Feedback buttons (Discord)

- **customId 형식**: `feedback:save:{chatHistoryId}:{analysisType}:{feedbackType}:{personaKey}`  
  (`TRUSTED` | `ADOPTED` | `BOOKMARKED` | `DISLIKED` 등 — `analysisTypes.ts`의 `FeedbackType`과 정합)
- **`analysis_type` 소스**: `analysisType`은 **버튼 customId 파싱값만** 사용한다. `chat_history.debate_type` 컬럼은 조회·저장 신뢰에 사용하지 않는다(운영 DB에 없을 수 있음).
- **`chat_history` 키 저장**: 운영 DB에서 `chat_history.id`는 **integer**이다. `analysis_feedback_history`에는 UUID FK(`chat_history_id`) 대신 **`chat_history_ref`(TEXT)** 에 문자열 ID를 넣는 경로를 우선한다(`feedbackService.ts`, `src/repositories/feedbackRepository.ts`). 스키마 보강은 `docs/sql/feedback_chat_history_ref.sql` — 레거시 DB는 insert 실패 시 `chat_history_id`만으로 재시도한다.
- **처리 흐름**: 버튼 클릭 → `interactionCreate` → `safeDeferReply` → `saveAnalysisFeedbackHistory` → `ingestPersonaFeedback` → (가능 시) `claim_feedback` + `persona_memory` 갱신. 저장 일시 실패 시 서비스 계층 재시도 후에도 실패하면 사용자에게 **과도한 오류 문구 대신** 짧은 안내(`index.ts` `handleFeedbackSaveButtonInteraction`).
- **전송 방식**: 피드백·의사결정 버튼이 붙은 분석 메시지는 **Incoming Webhook이 아니라 봇 채널 메시지**(`channel.send`)로 보낸다. Webhook으로 붙인 컴포넌트는 interaction/소유권 측면에서 실패하거나 불안정할 수 있다.
- **중복**: 동일 조건 연타 시 `analysis_feedback_history` 또는 `claim_feedback` 단계에서 duplicate로 막히고, 사용자에게 구분 메시지가 간다.
- **운영 확인**: `FEEDBACK` 스코프 로그(`feedback button clicked`, `feedback history saved`, `feedback ingestion result`, `duplicate ignored`, `handler failed`) 및 Supabase에서 `analysis_feedback_history` / `claim_feedback` 행 확인 — `docs/OPERATIONS_RUNBOOK.md`, `docs/TEST_CHECKLIST.md` 참고

## Decision prompt buttons (Discord)

- **목적**: LLM이 “원하시나요 / 선택 / vs …” 식으로 선택을 요구할 때 **빈 텍스트만 보내지 않고** 채널에 **선택 버튼**을 붙인다(`decisionPrompt.ts` 휴리스틱 + `extractDecisionOptions`).
- **옵션 스냅샷**: 브로드캐스트 직전 `decision_snapshots` 행에 `options` JSON을 저장하고, 버튼 `customId`는 `decision:select|{snapshotUuid}|{idx}` — 클릭 시 **DB 스냅샷**으로 라벨을 복원한다(본문 재파싱 금지).
- **저장**: 클릭 시 `decision_history`에 `selected_option`, `option_index`, `decision_context`(options·persona·topic 등) 저장. 로그 `DECISION_PERSISTED`.
- **후속(실행)**: `decisionExecutionService.ts` — **자동 매매 없음**. `immediate_sell` / `staged_sell` / `hold` 등 분류 후 **그림자 리밸**(`buildRebalancePlanAppService`, `rebalance_plans` 저장 가능) 또는 **CIO 요약(Gemini)** 또는 **다음 질문 템플릿**. 채널에 “선택 완료” 응답 후 **즉시 후속 메시지**로 전달. 로그: `DECISION_EXECUTION_STARTED` / `DECISION_EXECUTION_COMPLETED`.
- **마이그레이션**: `docs/sql/decision_history.sql` (`decision_snapshots`, `decision_history`).
- **처리**: `interactionCreate`에서 `decision:select|` → `handleDecisionButtonInteraction` — **ephemeral 아님**(선택 완료가 채널에 보임). 로그: `DECISION` 스코프 `DECISION_PROMPT detected`(파이프라인 persist), `DECISION_OPTIONS extracted` / `DECISION_SELECTED`(브로드캐스트·클릭).
- **배치**: `broadcastAgentResponse` 첫 청크에 `[NO_DATA 행] → [의사결정 행] → [피드백 행]` 순으로 합친다.

## Follow-up interaction buttons (Discord)

- **목적**: 응답 본문에 질문이 있으면 반드시 상호작용 컴포넌트를 붙여 “질문만 남는” 상황을 막는다.
- **감지/분류**: `followupPromptService.ts`가 질문을 `CHOICE` / `NEXT_ACTION` / `FREE_INPUT`으로 분류한다.
- **컴포넌트 규칙**: 선택지 3개 이하는 버튼, 4개 이상은 String Select, 자유입력은 `답변 입력` 버튼 후 모달(`modal:followup:{snapshotUuid}`)로 받는다.
- **스냅샷 저장**: 브로드캐스트 시 `followup_snapshots`에 옵션/타입을 저장하고 `customId`는 `followup:select|{snapshotUuid}|{idx}` / `followup:menu|{snapshotUuid}` / `followup:input|{snapshotUuid}`를 사용한다(본문 재파싱 최소화).
- **선택/입력 후 실행**: `handleFollowup*` 경로에서 즉시 후속 분석을 실행한다(포트폴리오 토론/오픈 토픽/트렌드). **dead-end 없음**, **자동 매매 없음**.
- **로그**: `FOLLOWUP_PROMPT_DETECTED` / `FOLLOWUP_SELECTED` / `FOLLOWUP_INPUT_SUBMITTED` / `FOLLOWUP_EXECUTION_COMPLETED`.

## Persona 응답 후처리 규칙

- `analysisFormatting.ts`의 정규화 단계에서 `postProcessPersonaOutputForDiscord`를 적용한다.
- 기술 지표·기호가 감지되면 **전문 분석 유지 + 쉬운 설명(2~3문장) + 의미 요약**을 자동 보강한다.
- `ensureCompleteResponse`로 `마무리(한 줄)` placeholder, `...` 같은 미완결 문장을 정리하고 결론형 문장으로 마감한다.

## Quote fallback & 운영 표시

- **계층**: (1) Yahoo `v7/finance/quote` 실시간·지연 호가 → (2) `v8/finance/chart` 일봉 EOD → (3) 메모리 TTL 캐시(짧음) → (4) 포트폴리오 행에 저장된 **마지막 유효가**(fallback) — `abnormal valuation guard` 유지.
- **401 등 실패**: 브라우저에 가까운 `User-Agent` 등 헤더로 호출; 실패 유형은 `QUOTE_RESOLUTION`의 `yahoo_v7_http_error` / `yahoo_chart_http_error` 및 종목별 `failureBreakdown`으로 구분.
- **표시**: 종목 블록에 시세 출처(`live`/`eod`/`cache`/`fallback`)·기준시각·`stale`·실패 유형 요약. `degraded_quote_mode`는 “실시간 호가가 아닌 값이 섞임”에 가깝게 쓰인다.

## 메인 패널 복구

- `state/discord-panel.json`에 채널이 없으면 환경변수 **`DISCORD_MAIN_PANEL_CHANNEL_ID`** 또는 **`DEFAULT_CHANNEL_ID`** 로 폴백 후 메시지 재생성.
- 로그: `PANEL restore start` / `PANEL restore fallback_channel_used` / `PANEL restore success` / `PANEL restore recreated` / `PANEL restore failed`.
- `logs/office-health.json`의 `panels.lastPanelRestoreResult`, `panelRestoreFallbackUsed`, `panelRecreated` 참고.

## 스케줄러·관측 로그

- 주간 리포트 **매시간 체크·스킵**은 기본적으로 `logger.debug` (조건 미충족) — `office-ops` 노이즈 감소. 실제 생성·오류는 기존 INFO/WARN/ERROR 유지.
- Follow-up / Decision: `DECISION_SNAPSHOT_SAVED`, `DECISION_COMPONENT_ATTACHED`, `FOLLOWUP_SNAPSHOT_SAVED`, `FOLLOWUP_COMPONENT_ATTACHED`, 스킵 시 `*_COMPONENT_SKIPPED`(사유), Discord 행 초과 시 `UI_COMPONENT_POLICY`. `healthState.ux`에 최근 이벤트 시각 요약.

## System operator (Peter Thiel) — 로그 분석

- **`logAnalysisService.ts`**: `logs/` 하위 일별·카테고리 로그와 `office-health.json`을 **읽기 전용**으로 스캔(최근 약 30분 윈도·파일 꼬리). 시세·패널·스케줄러·인터랙션·ERROR 패턴을 분류해 `HEALTHY` / `DEGRADED` / `CRITICAL` 판정.
- **Discord**: 데이터 센터 패널 **`⚙️ 시스템 상태 점검`** (`panel:system:check`) — Peter Thiel 톤의 운영 리포트. **`📋 상세 로그 요약`**, **`🛠 조치 방법`**은 같은 분석 결과의 다른 뷰.
- **자동 조치 없음** (kill·DB 쓰기 금지). 권고·설명만 제공. 결과는 **30초 캐시**로 디스크 부하 완화.

### Feedback → 의사결정 소프트 보정 (포트폴리오 5인 토론)

- **목적**: 저장된 피드백·claim 메타로 **claim 가중(소폭)** 및 CIO 종합 시 **우선순위/모니터링 서술**만 보정. **NO_DATA 게이트·시세/밸류에이션 가드·Phase2 veto·GO/HOLD 결론 자체를 뒤집지 않음.**
- **구현**: `persona_memory.confidence_calibration` 누적 → `buildFeedbackDecisionSignal`이 claim별 Δ를 **최대 +0.07 / 최소 −0.05**로 clamp → RAY/HINDENBURG의 downside-focused claim은 **baseline 이하 하향 금지**(safety floor).
- **관측**: `FEEDBACK_CALIBRATION` 로그 `applied`; CIO `analysis_generation_trace`에 `feedback_adjustment_meta` JSON(best-effort).
- **Discord**: 위원회 결정 요약 아래 **이탤릭 한 줄** 안내(과도한 개인화 문구 없음).

## Docs

- [System Architecture](docs/SYSTEM_ARCHITECTURE.md): 실행 흐름/모듈 구조/LLM fallback 구조
- [System Review](docs/SYSTEM_REVIEW.md): 현재 구조 평가와 리팩토링 필요성
- [Operations Runbook](docs/OPERATIONS_RUNBOOK.md): 운영/장애 대응 표준 절차
- [Environment](docs/ENVIRONMENT.md): 환경변수 기준/민감정보 원칙
- [Database Schema](docs/DATABASE_SCHEMA.md): 주요 테이블/관계/확인 필요 항목
- [Test Checklist](docs/TEST_CHECKLIST.md): 배포 전후 테스트 체크리스트
- [Roadmap](docs/ROADMAP.md): 단계별 목표/완료조건/리스크
- [Changelog](docs/CHANGELOG.md): 변경 이력 기록
- [Documentation Policy](docs/DOCUMENTATION_POLICY.md): 코드-문서 동시 갱신 강제 규칙

## Documentation Rule

- 코드 변경 전후로 관련 문서 영향 범위를 반드시 판단하고 함께 갱신합니다.
- `docs/CHANGELOG.md`는 의미 있는 코드 변경 시 항상 업데이트합니다.
- 문서 갱신 누락 시 작업 완료로 간주하지 않습니다.
