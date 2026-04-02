# OPERATIONS RUNBOOK

## 1. 실행 방법

### 로컬/서버 공통
```bash
npm install
npm run build
npm start
```

### PM2 사용
```bash
pm2 start dist/index.js --name ai-office --interpreter node
pm2 logs ai-office
pm2 restart ai-office
```

## 2. build / start / restart 표준 흐름
1. 환경변수 로딩 확인 (`.env` 존재, 키 누락 여부 점검)
2. `npm run build`
3. 프로세스 시작/재시작 (`npm start` 또는 `pm2 restart ai-office`)
4. 부팅 로그 확인 (`BOOT`, `ENV`, panel restore 로그)
5. Discord 패널 버튼 응답 확인

## 3. 로그 확인 방법

### 기본 런타임 로그
- **일별(권장)**: `logs/daily/office-runtime_YYYYMMDD.log`, `logs/daily/office-error_YYYYMMDD.log`, `logs/daily/office-ops_YYYYMMDD.log` — 단일 `office-runtime.log` 무한 증가 대신 일별 분리 + 보존 정책(`OFFICE_LOG_RETENTION_DAYS`, 기본 14일).
- **운영 요약**: `office-ops_*` — BOOT, Discord 준비/실패, 패널 복구, DB 스키마 이슈, 피드백 실패, 리밸 실행/보류, ERROR 등.
- **상세**: `office-runtime_*` — INFO/WARN/ERROR(INTERACTION 고빈도 INFO는 기본적으로 메인 runtime 파일에서 생략되고 `logs/interaction/` 등 카테고리에만 남음; 필요 시 `LOG_VERBOSE_RUNTIME=1`).
- **디버그 파일**: `LOG_DEBUG=1`일 때만 `logs/daily/office-debug_YYYYMMDD.log`.
- **중복 억제**: 동일 WARN/ERROR 반복 시 full 로그 1회 + `LOGGER duplicate suppressed` 요약.
- `logs/office-health.json` — 하트비트·Discord 상태(기존과 동일).

### 카테고리 로그(KST 일자 파일)
- `logs/openai/openai.log_YYYYMMDD`
- `logs/quote/quote.log_YYYYMMDD`
- `logs/interaction/interaction.log_YYYYMMDD`
- `logs/db/db.log_YYYYMMDD`
- `logs/portfolio/portfolio.log_YYYYMMDD`
- `logs/boot/boot.log_YYYYMMDD`
- `logs/llm/llm.log_YYYYMMDD`

### 빠른 확인 포인트
- LLM fallback: `LLM_PROVIDER` scope
- quote 장애: `QUOTE` scope (`classifiedReason`, `failureBreakdown`, `traceId`)
- quote 해상도(다단계): `QUOTE_RESOLUTION` — `current_success`, `eod_fallback_used`, `cache_fallback_used`, `symbol_corrected` (카테고리는 `quote` 로그에 라우팅)
- 응답 후 메뉴 재노출: `UI` scope `post_response_navigation_attached` / `post_response_navigation_failed`
- interaction 오류: `INTERACTION`/`DISCORD` scope

## 4. 장애 대응 기본 절차
1. 장애 범주 분류
   - Discord 응답 지연/실패
   - Supabase 연결/쿼리 실패
   - LLM(OpenAI/Gemini) 실패
   - Quote 실패/valuation 왜곡
2. 최근 15분 로그 확인
3. fallback 동작 여부 확인
4. 재시작 필요 시 graceful restart
5. 재현 명령 및 영향 범위 기록
6. 임시조치 후 근본원인 분석 티켓 생성

## 5. Supabase 장애 점검 포인트
- 필수 env:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- health check:
  - `index.ts` 초기 DB check 로그 확인
- 증상별 포인트:
  - insert/select 에러 증가 시 권한/스키마 불일치 점검
  - `chat_history.id` 타입 이슈(운영 integer vs schema UUID) 영향 여부 점검

## 6. Discord bot 장애 점검 포인트
- 필수 env:
  - `DISCORD_TOKEN` 또는 `DISCORD_BOT_TOKEN`
- 인터랙션 오류:
  - `Unknown interaction`, `Invalid Form Body` 발생 여부
- 대응:
  - defer/route/chunking 경로 로그 확인
  - panel state(`state/discord-panel.json`) 손상 여부 점검

### 6.1 피드백·의사결정 버튼(분석 응답 하단) 운영 검증
1. 분석 1회 실행 후 응답에 피드백 버튼이 보이는지 확인
2. **의사결정 질문**이 포함된 응답(예: “원하시나요”, “선택”, “vs” 등 — `decisionPrompt.ts`)에는 **선택 버튼 행**이 피드백 행 **위**에 붙는지 확인. 로그: `DECISION` `DECISION_OPTIONS extracted`, 파이프라인에는 `DECISION_PROMPT detected`
3. `decision:select|*` 클릭 시 채널에 **선택 완료** 메시지가 보이는지(ephemeral 아님), 로그에 `DECISION_SELECTED`(`userId`, `chatHistoryId`, `selectedOption`)가 남는지 확인
4. 피드백 버튼 클릭 시 **에페메럴** 응답이 오고, 로그에 `FEEDBACK` / `feedback button clicked` 가 남는지 확인
5. Supabase `analysis_feedback_history`에 새 행 — 가능하면 **`chat_history_ref`** 에 문자열 `chat_history.id`, `chat_history_id` null(마이그레이션 `docs/sql/feedback_chat_history_ref.sql` 적용 후). 레거시만 있으면 integer `chat_history_id` 경로
6. claim 매핑이 된 경우 `claim_feedback`에 반영됐는지 확인(unique `(discord_user_id, claim_id, feedback_type)`). UUID가 아닌 `claim_id`로 인한 insert 스킵 시 `claim_feedback skipped (uuid type mismatch)` 류 WARN만 나고 사용자 피드백은 실패로 보이지 않아야 함
7. **동일 버튼을 짧은 간격으로 연타** → `duplicate ignored` 로그 및 사용자 메시지(이미 저장/이미 반영) 확인
8. 피드백이 붙은 메시지가 **webhook 전용이 아닌** 일반 채널 메시지인지 확인(버튼이 실제로 눌리는지 — `README.md` “Feedback buttons” 절 참고)
9. 로그에 `column chat_history.debate_type does not exist` 가 **더 이상 나오지 않는지** 확인(피드백 경로는 customId의 `analysisType`만 사용).
10. Postgres `invalid input syntax for type uuid` 가 **피드백 버튼 경로**에서 더 이상 반복되지 않는지 확인(integer ID를 UUID 컬럼에 넣지 않음).
11. `docs/sql/decision_history.sql` 적용 후 `decision_snapshots` / `decision_history` 확인. 의사결정 버튼 클릭 시 `DECISION_PERSISTED`, 직후 채널에 **후속 메시지**(그림자 리밸 또는 CIO/다음 질문), 로그 `DECISION_EXECUTION_STARTED` / `DECISION_EXECUTION_COMPLETED`. **자동 매매 없음**(advisory·shadow plan만).
12. `docs/sql/followup_snapshots.sql` 적용 후 `followup_snapshots` 확인. **의사결정 휴리스틱이 아닌** 질문형 응답에 follow-up 버튼/스트링 셀렉트/모달이 붙는지 확인. 로그 `FOLLOWUP_PROMPT_DETECTED` → 선택/입력 시 `FOLLOWUP_SELECTED` 또는 `FOLLOWUP_INPUT_SUBMITTED` → 후속 분석 후 `FOLLOWUP_EXECUTION_COMPLETED`. **자동 매매 없음**.

### 6.2 피드백 소프트 보정(포트폴리오 토론)
1. 포트폴리오 토론 완료 후 로그에 `FEEDBACK_CALIBRATION` / `applied`가 **페르소나당** 남는지 확인(`claimCount`, `avgBaseScore`, `avgAdjustedScore`, `safetyFloorTriggered`).
2. Supabase `persona_memory.confidence_calibration` JSON에 선호 claim_type / evidence_scope 키가 누적되는지(피드백·claim_feedback 반영 후 `refreshPersonaMemoryFromFeedback` 경로).
3. CIO 행 `analysis_generation_trace`에서 `memory_snapshot.feedback_adjustment_meta` 존재 여부(스키마 확장 없이 JSON 내부 필드).
4. **비기능 요구**: NO_DATA로 차단된 세션에서 보정이 게이트를 우회하지 않는지(동일 조건 재현 시 여전히 차단).
5. 위원회 결정 요약 메시지에 **이탤릭 한 줄** 피드백 안내가 붙는지(과도한 문구 없음).

### 6.3 Phase 2.5 — 그림자 리밸런싱 / claim 감사 / 위원 성과
1. Supabase에 `docs/sql/phase2_5_advisory_execution.sql` 적용 후 배포.
2. 포트폴리오 토론 완료 시 채널에 **리밸 실행안** 메시지가 오는지, `rebalance_plans`·`rebalance_plan_items`에 `pending` 행이 생겼는지 확인.
3. **`리밸런싱 완료` 전** `trade_history`가 늘지 않는지 확인; 완료 후에만 매매 행이 생기는지(MVP 전제: 사용자가 플랜대로 체결).
4. `이번엔 보류` 시 `status=user_hold`, `dismiss_reason=USER_HOLD_DECISION`.
5. 데이터 센터 `Claim 감사 실행` 후 로그·`claim_outcome_audit` 갱신 필드 확인.
6. `PERSONA_PERF` / `DECISION_ENGINE` 로그에 성과 보정이 **없거나** 소량만 있는지(표본 부족 시 보정 생략).
7. 향후 **부분 체결**·브로커 API는 별도 설계(문서 `DATABASE_SCHEMA` 참고).

### 6.4 Phase 3 — 현금흐름·할부·종목 등록 후보(확인 후 확정)
1. Supabase에 `docs/sql/phase3_finance_instrument_integrity.sql` 적용 후 배포.
2. **현금흐름**: 패널 모달·`!현금흐름추가`로 `SALARY` 등 표준 유형만 저장되는지 확인; 레거시 영문 입력은 매핑되는지 확인.
3. **지출 할부**: 지출 모달에서 `Y 3 2026-01-01` 형식 시 `expenses`에 할부 컬럼이 채워지는지 확인(컬럼 미적용 시 insert 오류 → 마이그레이션 필요).
4. **종목 추가**: `종목 추가` 모달 제출 후 **후보 메시지**만 오고, 확인 전에는 `portfolio`/`trade_history` 행이 늘지 않는지 확인.
5. **확인** 클릭 후에만 매수 반영·`instrument_registration_candidates.status=CONFIRMED`·로그 `INSTRUMENT_CONFIRMATION candidate_confirmed`.
6. **취소**·만료·잘못된 조합: `validation_failed` 로그 및 사용자 메시지; SQL CHECK는 완전히 채워진 KR/US 행에 대해 잘못된 조합 삽입을 막음(NOT VALID로 레거시 보호).

### 6.5 AI Office Control Panel (로컬 웹 MVP)
1. 레포 루트에서 `npm run build` 후 `npm run control-panel` — 브라우저 `http://127.0.0.1:7788`(기본) 접속.
2. **UI**: **상태판**으로 실행 여부·heartbeat·마지막 중지/kill/프로세스 검사 요약을 본다. **로그 본문은 기본 화면에 출력하지 않는다** — 아래 파일 경로를 편집기/터미널에서 연다.
3. **로그 역할 분리**
   - **패널 조작 분석**: `logs/control-panel/control-panel.log_YYYYMMDD` — `CONTROL_PANEL start_requested`, `stop_attempt_result`, `post_stop_verification`, `kill_result` 등.
   - **본체 운영**: `logs/daily/office-ops_YYYYMMDD.log`
   - **본체 오류**: `logs/daily/office-error_YYYYMMDD.log`
   - **(선택) 상세 런타임**: `logs/daily/office-runtime_YYYYMMDD.log` — 중지/kill 직전후 맥락이 필요할 때만.
   - **스냅샷**: `logs/office-health.json`
   - **패널 자식 stdout**: `logs/daily/control-panel-child_YYYYMMDD.log`
4. **기동**: `office-health.json`에 최근 하트비트가 있는 실행 중 인스턴스가 있으면 **거부**(중복 기동 방지). 패널이 spawn한 자식은 `state/control-panel-child.json`에 PID 기록.
5. **중지(Windows)** — `apps/control-panel/stopPipeline.ts`: **graceful 우선**(`child.kill('SIGTERM')` → 패널이 spawn한 ChildProcess 핸들). 핸들 없으면 `taskkill /PID … /T`(소프트). **1.5s / 4s / 8s** 단계로 `post_stop_verification`(attemptNo 1~3) 기록. 여전히 살아 있고 **안전 식별**(`stopSafety.ts` — tracked·`matchedAiOffice`·`dist/index.js` 명령·health pid 충돌 없음)일 때만 **자동 `taskkill /F /T`**. 즉시 실패로 단정하지 않고 **`stop_final_status`**까지 본다. 상태판 `stopPhase`·`force fallback`·`stopFinalStatus`로 진행 확인.
6. **강제 kill(수동)**: `matchedAiOffice`가 아니면 API가 거부하므로, 반드시 목록·명령줄을 확인한 뒤 `force=1` 경로만 사용.
7. **Windows 진단(중지 안 됨)**: (1) 상태판 **마지막 중지 시도**·**stopPhase**·**다단계 검증** (2) `control-panel.log_*` 에서 `stop_force_fallback_*`·`post_stop_verification`·`stop_final_status` (3) `netstat`/`tasklist`로 잔존 node·child 대비 부모만 종료된 경우 (4) `office-error`·`control-panel-child` 로그. **UI에는 stderr 원문을 넣지 않음** — 정규화 메시지·파일 경로 확인.
8. **고급 API**: `GET /api/logs/{ops|error|runtime}` — 개발·진단용 tail; 일상 운영은 파일 직접 확인 권장.

### 6.6 Quote 다단계 fallback · KR 장 마감 후 · 후속 네비게이션 UX

**Quote**
1. `logs/quote/quote.log_*` 에서 `QUOTE_RESOLUTION` 이벤트로 어떤 단계를 탔는지 확인한다. **401 다발** 시 `yahoo_v7_http_error` / `yahoo_chart_http_error` 와 `status`·`classifiedReason`으로 원인 분리.
2. **한국장 종료 후** KR 종목: `eod_fallback_used` 또는 `current_success`(지연)가 섞일 수 있으나, 사용자 메시지에는 **가격 기준 힌트**(KST·종가/실시간 여부)가 표시된다.
3. 일부 종목만 실패 시: 포트폴리오 전체가 비정상 평가로 붕괴하지 않아야 하며, 본문에 **일부 종목 fallback** 요약이 있을 수 있다. `quote_quality_degraded_summary`(WARN)와 `degraded_quote_mode`로 요약.
4. `symbol_corrected` 가 나오면 저장된 `quote_symbol`과 후보 심볼이 달랐음을 의미한다 — 등록 데이터 오류 가능성 점검.
5. **주간 스케줄러**: “매시간 체크·스킵”은 기본 `DEBUG`로만 남음 — `office-ops`에서 반복 스킵 노이즈를 줄이려면 `LOG_DEBUG=1` 시 `office-debug`에서 확인.

### 6.1.1 메인 패널 복구 · `office-health.json`
1. `DISCORD_MAIN_PANEL_CHANNEL_ID`(또는 `DEFAULT_CHANNEL_ID`) 설정 시 `state/discord-panel.json`에 채널이 없어도 **폴백 채널**로 패널 재생성 시도.
2. 로그: `PANEL restore start` / `PANEL restore fallback_channel_used` / `PANEL restore success` / `PANEL restore recreated` / `PANEL restore failed`.
3. `logs/office-health.json`의 `panels.lastPanelRestoreResult`, `panelRestoreFallbackUsed`, `panelRecreated` 확인.

### 6.1.2 Follow-up / Decision 관측성
1. 브로드캐스트 시 `DECISION_SNAPSHOT_SAVED`, `DECISION_COMPONENT_ATTACHED`, `FOLLOWUP_SNAPSHOT_SAVED`, `FOLLOWUP_COMPONENT_ATTACHED`, 스킵 시 `*_COMPONENT_SKIPPED`(사유), 행 초과 시 `UI_COMPONENT_POLICY`.
2. `healthState.ux`(lastFollowup*, lastDecision*)로 최근 이벤트 시각 요약.

### 6.1.3 System operator — 로그 기반 점검 (Discord)
1. 데이터 센터 패널에서 **⚙ 시스템 상태 점검** — `logAnalysisService`가 최근 로그를 스캔해 상태·조치안을 표시(자동 매매·DB 변경 없음).
2. **상세 로그 요약** / **조치 방법**은 동일 분석 결과의 보기 전환. 민감 정보가 포함될 수 있으면 에페메럴·관리 채널에서만 사용 권장.
3. 코드: `logAnalysisService.ts`, 버튼 `panel:system:check|detail|actions` — `DATA_CENTER` `system_log_analysis` 로그.

### 6.1.4 Interaction registry / entrypoint (리팩토링)
1. `interactionCreate` 분기는 `src/discord/handlers/interactionCreate/buildInteractionRoutes.ts`에 **`InteractionRoute`** 목록으로 등록되어 있으며, `index.ts`는 **`dispatchRoutesInOrder`**만 호출한다.
2. 라우트가 처리되면 로그에 `INTERACTION` `route matched` `{ route: "<name>" }`가 남는다(디버깅용).
3. 배포 후 회귀 시: **의사결정·피드백·follow-up·포트폴리오·모달(지출/현금흐름)** 각각 한 번씩 클릭해 기존과 동일한지 확인한다.
4. 로컬에서 라우트 목록만 보려면: `npm run smoke:interaction`(dummy Supabase env 선로드). Follow-up 라우트 이름: `npm run smoke:followup-routes`.

**Post-response navigation**
1. 포트폴리오 조회/계좌 선택 직후, AI 토론·트렌드·데이터 센터·오픈 토픽 완료 직후 **추가 메시지**에 메인 메뉴 버튼이 보이는지 확인한다.
2. 로그에 `post_response_navigation_attached`(mode: `followUp` 또는 `channel_send`)가 남는지 확인한다. 실패 시 `post_response_navigation_failed`.

## 7. OpenAI/Gemini 장애 및 fallback 점검
- 확인 순서
  1. `OPENAI_API_KEY` 존재
  2. budget guard 값 확인 (`OPENAI_MONTHLY_MAX_CALLS`, `OPENAI_MONTHLY_BUDGET_USD`)
  3. `OPENAI_BUDGET_ENFORCEMENT`, `OPENAI_FALLBACK_TO_GEMINI` 상태 확인
  4. `LLM_PROVIDER` 로그에서 fallback reason 확인
- 현재 OpenAI 우선 페르소나:
  - HINDENBURG, SIMONS, THIEL, HOT_TREND

## 8. 배포 전 체크리스트

### 필수
- `npm run build` 성공
- `npm run check:schema-contract`
- `npm run check:phase1-structure`
- `npm run check:runtime-e2e` (실제 `SUPABASE_*` + `PHASE1_TEST_DISCORD_USER_ID` 또는 `TEST_DISCORD_USER_ID` 필요)
- `docs/TEST_CHECKLIST.md`의 **MUST CHECK** 섹션 확인

### 확장 (회귀·품질)
- Phase 2 결정 엔진 스모크: `npm run check:decision-engine` (기본 Phase 2 DDL 적용 후 hardening SQL `docs/sql/append_phase2_decision_tables_hardening.sql` 반영 권장 — 그렇지 않으면 스키마 캐시 오류로 저장만 실패할 수 있음)
- self-check 실행
  - `node dist/openai_phase1_self_check.js`
  - `node dist/discord_response_self_check.js`
  - `node dist/uiux_stability_self_check.js`
  - `node dist/quote_logging_self_check.js`
  - `node dist/logging_self_check.js`
  - `node dist/uiux_provider_valuation_self_check.js`
- 문서 갱신 확인
  - 최소 `docs/CHANGELOG.md` 갱신

## 9. 배포 후 체크리스트
- 부팅 후 5분 내 오류 로그 급증 여부
- 메인 패널 버튼 응답 테스트(포트폴리오/AI/트렌드/데이터센터)
- 금융 토론 1회, 트렌드 1회, 데이터센터 1회 실행
- quote 실패 종목 존재 시 valuation 경로 로그 확인

## 10. rollback 기본 절차
1. 장애 유발 변경 범위 식별(최근 수정 파일)
2. 직전 안정 커밋으로 복귀 배포
3. PM2 재시작
4. 핵심 기능 smoke test
5. rollback 사유/영향/후속조치 문서화

## 11. 확인 필요
- 운영환경에서 실제 프로세스 관리 표준(PM2 외 systemd/docker 등) 확정 필요
- 운영 DB migration 적용 이력 정합성(특히 chat_history / analysis_generation_trace 계열) 재확인 필요
