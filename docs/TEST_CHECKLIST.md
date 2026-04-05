# TEST CHECKLIST

## MUST CHECK vs OPTIONAL CHECK

- **MUST CHECK**: 배포·운영 안정화에 직접 필요한 최소 검증 (`build`, 스키마 계약, Phase1 구조 스모크, **실DB 런타임 E2E 스모크**, 아래 Phase1 DB·학습 루프 핵심 항목).
- **OPTIONAL CHECK**: 회귀·품질·주변 도구(self-check 바이너리 전부, quote/valuation 심층, 수동 UX 전 범위 등).

## 0. 자동 점검 (로컬/CI)
- [ ] `npm run build`
- [ ] **Interaction registry 스모크(선택)**: `npm run smoke:interaction` — `routes/*.ts` 기대 파일 존재·`messageCreate.ts` / `discordBroadcastService.ts` 경로 확인·라우트 개수·이름(Supabase dummy env). `npm run smoke:followup-routes`, `npm run smoke:panel-restore`(경로 안내)
- [ ] **Control Panel(선택)**: `npm run control-panel` → 브라우저 `http://127.0.0.1:7788` 에서 **상태판**(실행/heartbeat/`stopPhase`/마지막 중지·force fallback·다단계 검증·검사 요약, 로그 **경로 안내**). 화면에 로그 raw·stderr 원문 대량 출력 없음. `logs/control-panel/control-panel.log_*` 에 `stop_attempt_*`·`stop_force_fallback_*`·`post_stop_verification`(attemptNo 1~3)·`stop_final_status` 확인. Windows: graceful(`child_sigterm`) 후 필요 시 자동 `/F` (안전 식별 시만). 프로세스 검사·kill
- [ ] `npm run check:schema-contract`
- [ ] `npm run check:phase1-structure` (Supabase URL 미설정 시 dummy env로 모듈 로드만 검증)
- [ ] `npm run check:runtime-e2e` (실제 Supabase + 테스트 Discord 사용자 ID; 분석·claim·trace·피드백·메모리·fallback 로그 스모크)
- [ ] `npm run check:decision-engine` (Phase 2 위원회 투표 + veto + unique 위반 처리 스모크; **기본 Phase 2 테이블 적용 후** `docs/sql/append_phase2_decision_tables_hardening.sql` 실행 시 persistence·duplicate 검증까지 가능)

## 1. 기본 기능 테스트
- [ ] `interactionCreate` 경로: 버튼·스트링 셀렉트·모달 제출 시 `INTERACTION` 로그에 `route matched` 가 남는지(배포 후 선택 확인; 라우트 정의는 `handlers/interactionCreate/routes/`)
- [ ] `messageCreate`: `!메뉴`·`!패널재설치`·`!종목추가`·`!토론` 등 기존 텍스트 진입이 `handleMessageCreate` 경로에서 동일 동작하는지(수동)
- [ ] 봇 기동 후 메인 패널 렌더링 (`panel:main:*`)
- [ ] 포트폴리오 보기(일반계좌) 정상 응답
- [ ] 전체 자산 보기 정상 응답
- [ ] 지출/현금흐름 입력 및 조회 정상 동작
- [ ] AI 토론/트렌드 응답 송신 성공
- [ ] 데이터 센터 버튼 및 하위 액션 응답 성공

## 2. Phase 1 테스트 체크리스트
- [ ] 분석 실행 후 `analysis_generation_trace` 저장 확인
- [ ] 분석 실행 후 `analysis_claims` 저장 확인
- [ ] 피드백 버튼 클릭 후 `analysis_feedback_history` 저장 확인
- [ ] claim 매핑 성공 시 `claim_feedback` 저장 확인
- [ ] `persona_memory` refresh 결과 반영 확인
- [ ] 중복 피드백 클릭 시 idempotent 처리 확인

## 3. 분석 1회 실행 시 확인 항목
- [ ] 사용자 메시지 -> 상태 메시지 -> 최종 응답 순서 유지
- [ ] Discord 2000자 제한 초과 시 chunk 전송
- [ ] interaction timeout/unknown interaction 미발생
- [ ] 응답별 피드백 버튼 노출 및 안내 문구 확인

## 4. claim 저장 확인 항목
- [ ] `analysis_claims.claim_order` 순서 정상
- [ ] `claim_type`, `evidence_scope` 채워짐
- [ ] `chat_history_id` 연계 상태 확인 (null 허용 경로 포함)

## 5. feedback 저장 확인 항목
- [ ] 버튼 `customId`가 `feedback:save:{chatHistoryId}:{analysisType}:{feedbackType}:{personaKey}` 형태인지 확인 (`index.ts`)
- [ ] 클릭 시 `interactionCreate` → `FEEDBACK` 로그(`feedback button clicked` → `feedback history saved` → `feedback ingestion result`) 순으로 남는지 확인
- [ ] `analysis_feedback_history`에 persona/analysis_type/opinion 저장 — **`chat_history_ref`(TEXT)** 에 정수 ID 문자열이 들어가고 UUID FK에는 잘못된 캐스팅이 없는지 확인(마이그레이션 `docs/sql/feedback_chat_history_ref.sql`)
- [ ] `mapped_claim_id`, `mapping_method`, `mapping_score` 저장 확인(매핑 성공 시; 비UUID는 컬럼에 넣지 않음)
- [ ] `claim_feedback` unique 제약으로 중복 방어 확인
- [ ] 동일 버튼 연타 시 duplicate UX + `duplicate ignored` 로그
- [ ] 피드백이 붙은 분석 메시지가 **봇 채널 메시지**로 전송됨(webhook만 사용 시 버튼이 동작하지 않을 수 있음 — `src/discord/services/discordBroadcastService.ts` 의 `broadcastAgentResponse` 참고)
- [ ] 피드백 저장 시 `chat_history.debate_type` 오류 없음(`analysis_type`은 customId 기준)
- [ ] 저장 실패 시 사용자에게 과도한 오류 문구 대신 짧은 안내만 노출(`index.ts`)

## 5e. 의사결정 버튼(Decision prompt)
- [ ] “원하시나요” 등 휴리스틱이 포함된 응답에 **선택 버튼** 행이 붙고, 로그에 `DECISION_PROMPT detected`(파이프라인) / `DECISION_OPTIONS extracted`(브로드캐스트)가 남는지 확인
- [ ] `docs/sql/decision_history.sql` 적용 후 `decision_snapshots` / `decision_history` 사용 가능
- [ ] `customId` `decision:select|{snapshotUuid}|{idx}` 클릭 → 채널에 **선택 완료** 표시(ephemeral 아님), `DECISION_SELECTED` → `DECISION_PERSISTED`.
- [ ] 클릭 직후 **후속 채널 메시지**가 반드시 오는지(그림자 리밸 / CIO 요약 / 다음 질문). `DECISION_EXECUTION_STARTED` / `DECISION_EXECUTION_COMPLETED` 로그. **자동 매매·trade_history 미변경** 확인.
- [ ] 선택지 추출 실패 시에도 최소 **예 / 아니오** 버튼이 붙는지 확인(`extractDecisionOptions` fallback)

## 5f. Follow-up 질문(비-decision)
- [ ] `docs/sql/followup_snapshots.sql` 적용 후 `followup_snapshots` insert 가능
- [ ] `isDecisionPrompt`가 **거짓**이고 질문이 감지되면 버튼/스트링 셀렉트/`답변 입력` 중 하나가 붙는지 확인(질문만으로 끝나지 않음)
- [ ] `followup:select|*` / `followup:menu|*` / `modal:followup:*` 클릭·제출 후 **후속 분석**(포트폴리오/오픈 토픽/트렌드)이 실행되는지 확인 — dead-end 없음
- [ ] 로그 `FOLLOWUP_PROMPT_DETECTED`, `FOLLOWUP_SELECTED` 또는 `FOLLOWUP_INPUT_SUBMITTED`, `FOLLOWUP_EXECUTION_COMPLETED`
- [ ] 페르소나 응답에 기술 기호가 있을 때 **쉬운 설명** 보강 및 문장이 **완결** 형태로 끝나는지 확인(`postProcessPersonaOutputForDiscord` / `ensureCompleteResponse`)

## 5i. AI 분석 타임아웃·재시도 (포트폴리오 / 트렌드 / 오픈 토픽)

- [ ] `npm run build` 통과
- [ ] **`docs/sql/timeout_retry_snapshots.sql` 적용 후** 타임아웃 버튼이 **UUID** 스냅샷 기준으로 동작하는지(로그 `retrySnapshotSaved`에 `source: db`); 미적용·insert 실패 시 `source: memory` 폴백 확인
- [ ] **90초 내 첫 유의미 브로드캐스트가 없으면** `timeoutPhase: first_visible` 로그와 조기 중단 UX
- [ ] 첫 응답 후에는 **5분(시작 기준) 초과 시** `timeoutPhase: total` 로 중단되는지
- [ ] 타임아웃 시 **부분 결과가 있으면** 본문에 요약·페르소나 목록이 포함되고 `partialFallbackUsed` 로그가 남는지
- [ ] 장시간 분석(또는 임시 상수 단축 빌드)에서 중단 메시지 + **경량 / 요약 / 메인 메뉴** 버튼
- [ ] `AI_EXECUTION_TIMEOUT`, `firstResponseSentAt`(정상 완료 시), `retrySnapshotSaved` / `retrySnapshotLoaded`, `userVisibleTimeoutMessageSent`, `AI_EXECUTION_RESULT_DISCARDED_AFTER_TIMEOUT`(늦은 전송 시)
- [ ] `timeout:retry:light:*` / `summary:*` 경량·요약 재실행, **봇 재시작 후에도** DB 스냅샷이 있으면 UUID 버튼이 동작하는지

## 5j. AI 성능 경로(압축·병렬·`AI_PERF`)

- [ ] `npm run build` 통과
- [ ] 포트폴리오 전체 위원 실행 시 로그에 `AI_PERF` — `parallel_ray_hindenburg_window_ms` 또는 `persona_parallel_wall_time_ms`, `persona_execution_time`(Ray/Hindenburg에 `parallel_execution_used: true`), `portfolio_pipeline_complete`, **`execution_summary`**에 `total_execution_time_ms`·`prompt_build_time_ms`·`cio_stage_time_ms`·`compressed_prompt_mode`(`standard_compressed` / `aggressive_compressed`)·`retry_mode_used`·`partial_fallback_used`
- [ ] 첫 브로드캐스트 직후 **`first_visible_latency_ms`**가 `AI_PERF`에 남는지(실행 시작 대비)
- [ ] 오픈 토픽에서 페르소나 2명 이상일 때 `open_topic_persona`에 `parallel_execution_used: true`가 찍히는지
- [ ] 조기 브로드캐스트 사용 시 **동일 페르소나 본문이 두 번** 오지 않는지(`index.ts` 스킵); **`FEEDBACK_FOLLOWUP_ATTACH_PENDING` → `ATTACHED`** 후 follow-up 메시지에 피드백 행 1회(중복 `ATTACHED` 없음)
- [ ] `timeout:return:menu:*` 시 스냅샷 해제·메인 패널
- [ ] 동일 사용자 검증·decision/follow-up/feedback과 `customId` 충돌 없음
- [ ] **자동 매매·trade_history 자동 변경 없음**

## 5g. 운영 안정화 (quote / 패널 / 로그 / 컴포넌트)
- [ ] Yahoo 401 시 `yahoo_v7_http_error` / `yahoo_chart_http_error` 구조화 로그 및 종목별 `request_failure_reason`·`is_stale` 메타
- [ ] 포트폴리오 메시지에 종목별 시세 출처·기준시각·stale 한 줄 표시
- [ ] `DISCORD_MAIN_PANEL_CHANNEL_ID` 설정 후 state 비어 있어도 부팅 시 패널 복구·`PANEL restore *` 로그
- [ ] 주간 리포트 스케줄러 idle 구간은 `office-ops`에 과도한 check/skip이 없음(기본 DEBUG)
- [ ] `DECISION_SNAPSHOT_SAVED` / `FOLLOWUP_SNAPSHOT_SAVED` / `UI_COMPONENT_POLICY`(행 초과 시) 로그
- [ ] `logs/office-health.json` `ux`·`panels` 필드 갱신

## 5h. System operator (로그 분석)
- [ ] 데이터 센터 **⚙ 시스템 상태 점검** 클릭 시 Peter Thiel 톤 리포트·`DATA_CENTER` `system_log_analysis` 로그
- [ ] **상세 로그 요약** / **조치 방법** 버튼 동작, 긴 응답 시 follow-up 청크
- [ ] `logAnalysisService`가 시세·패널·UX·ERROR 패턴을 반영한 `HEALTHY`/`DEGRADED`/`CRITICAL` 판정
- [ ] 자동 조치 없음(읽기 전용 + 30초 캐시)

## 5b. 피드백 소프트 보정 (포트폴리오 토론)
- [ ] `FEEDBACK_CALIBRATION` / `applied` 로그 및 `safetyFloorTriggered` 동작(RAY/HINDENBURG downside)
- [ ] `persona_memory.confidence_calibration` 필드 누적(피드백·claim_feedback 반영 후)
- [ ] CIO trace `feedback_adjustment_meta` (best-effort)
- [ ] 결론(GO/HOLD 등)이 아닌 **서술/우선순위 힌트** 수준만 변경되는지(게이트·veto 미완화)

## 5d. Phase 3 — 현금흐름·지출 할부·종목 등록(확인 후 확정)
- [ ] SQL `docs/sql/phase3_finance_instrument_integrity.sql` 적용 후 빌드·기동
- [ ] 현금흐름 모달·`!현금흐름추가`가 표준 `flow_type`만 저장(레거시 별칭 매핑)
- [ ] 지출 모달 할부 필드 → `expenses` 할부 컬럼(마이그레이션 후)
- [ ] 종목 추가: 후보 제출 후 **확인 전** `portfolio`/`trade_history` 미변경, **확인 후**만 반영
- [ ] 다중 후보 시 `instr:pick` 후 `instr:confirm` 필요
- [ ] 로그 `INSTRUMENT_CONFIRMATION` (`candidate_created`, `candidate_confirmed`, `validation_failed`)

## 5c. Phase 2.5 — Advisory Execution (그림자 리밸런싱)
- [ ] SQL `docs/sql/phase2_5_advisory_execution.sql` 적용 후 빌드·기동
- [ ] 포트폴리오 토론 후 리밸 메시지·버튼 노출, `rebalance_plans`=`pending`
- [ ] `리밸런싱 완료` 전에는 `trade_history` 미변경, 완료 후 기록·스냅샷 best-effort
- [ ] `이번엔 보류` → `user_hold` / `USER_HOLD_DECISION`
- [ ] 데이터 센터: 위원 성과 / Claim 감사 / 대기 리밸 조회 동작
- [ ] `PERSONA_PERF`·위원회 raw 점수가 과도하게 흔들리지 않음(표본 부족 시 보정 생략)

## 6. persona_memory load 확인 항목
- [ ] 해당 persona row 미존재 시 empty memory fallback
- [ ] feedback 반영 후 `memory_version` 증가
- [ ] `accepted_patterns`, `rejected_patterns`, `style_bias` 갱신

## 7. fallback 확인 항목

### LLM fallback
- [ ] OpenAI API key 없음 -> Gemini fallback
- [ ] budget/call guard 초과 -> Gemini fallback
- [ ] OpenAI 호출 실패 -> Gemini fallback

### Quote/valuation fallback
- [ ] US live_usd 경로: `fx_rate_to_krw` 적용
- [ ] US fallback_krw/snapshot_krw 경로: `fx_rate_to_krw` 재곱 미적용
- [ ] **다단계**: quote 실패 시 chart **일봉 EOD** → DB/스냅샷 순으로 내려가며, 로그 `QUOTE_RESOLUTION`에 `eod_fallback_used` / `cache_fallback_used` 확인
- [ ] **KR 장 마감 후**: 포트폴리오 조회 시 종가 또는 최근 유효 종가 수준이 안정적으로 표시(본문 가격 기준 힌트·부분 실패 경고)
- [ ] **종목 단위 실패**가 전체 스냅샷 비정상 평가로 확대되지 않음(0/NaN 가드)
- [ ] KR **`.KS`/`.KQ`** 및 6자리 심볼 정합; 필요 시 `symbol_corrected` 또는 `INSTRUMENT` 보정 로그
- [ ] 비정상 valuation guard 경고 로그 확인
- [ ] snapshot sanity guard 로그 확인
- [ ] `degraded_quote_mode` 메시지와 포트폴리오 **가격 기준/부분 경고** 문구가 서로 모순 없이 표시

### Post-response navigation (Discord)
- [ ] 포트폴리오 조회·계좌 선택 성공 후 follow-up에 **메인 메뉴** 버튼 row(메인/포트폴리오/소비/AI/트렌드 + 데이터센터/설정)
- [ ] AI 토론·트렌드·데이터 센터·오픈 토픽 완료 후 동일 패턴으로 메뉴 재노출
- [ ] 로그 `UI` `post_response_navigation_attached`; 실패 시 `post_response_navigation_failed` 없이 정상 동작 확인

## 8. 회귀 테스트 핵심 항목
- [ ] NOW/CONL 등 US quote 실패 시 포트폴리오 비중 왜곡 재발 없음
- [ ] 위원회 소개 문구에 JYP 없음
- [ ] THIEL/HOT_TREND provider 정책(OpenAI 우선 + fallback) 유지
- [ ] 데이터센터 버튼/액션 유지

## 9. 배포 전 체크리스트
- [ ] `npm run build`
- [ ] self-check 실행
  - [ ] `node dist/openai_phase1_self_check.js`
  - [ ] `node dist/discord_response_self_check.js`
  - [ ] `node dist/uiux_stability_self_check.js`
  - [ ] `node dist/quote_logging_self_check.js`
  - [ ] `node dist/logging_self_check.js`
  - [ ] `node dist/uiux_provider_valuation_self_check.js`
- [ ] 문서 갱신(`CHANGELOG.md` 포함) 완료

## 10. 배포 후 smoke test
- [ ] 메인 패널에서 6개 메뉴 버튼 동작 확인
- [ ] 포트폴리오 조회 1회 + AI 토론 1회 + 트렌드 1회 + 데이터센터 1회
- [ ] 위 각 흐름 **직후** 상단 패널로 스크롤하지 않고 **후속 메뉴 버튼**으로 다음 기능 이동 가능
- [ ] (가능 시) 한국장 종료 후 KR 포트폴리오 1회 — 종가/EOD fallback 및 메시지 힌트 확인
- [ ] 오류 로그 급증 여부 확인 (`logs/daily/office-error_YYYYMMDD.log` 또는 ops/runtime)
- [ ] 카테고리 로그 파일 생성 확인

## 11. 확인 필요
- 운영 DB 타입 차이(`chat_history.id`)가 테스트 스크립트와 충돌 없는지 환경별 확인 필요
