# ANALYSIS PIPELINE

페르소나 기반 **포트폴리오 토론·오픈 토픽·트렌드** 분석이 코드에서 어떻게 돌아가는지, LLM·claim·피드백·의사결정·advisory와 어떻게 연결되는지 요약한다. 모듈 경로·레이어 다이어그램은 **docs/ARCHITECTURE.md**를 본다.

## 페르소나·provider

- 중앙 호출: `generateWithPersonaProvider` / `llmProviderService.getModelForTask` 등. OpenAI 우선 페르소나(코드 기준): Hindenburg, Simons, Thiel(데이터센터), Hot Trend 등 — 나머지는 기본 Gemini.
- **OpenAI 파라미터 capability**: `openAiModelCapabilities.ts` — 예: `gpt-5-mini`는 Responses API에서 **temperature 미지원**이 일반적이므로 **전송 전 제외**(`OPENAI_CAPABILITY_APPLIED`, `OPENAI_UNSUPPORTED_PARAM_REMOVED`). 여전히 400·unsupported parameter면 **1회 compat 재시도**(temperature·max_output_tokens 제거한 최소 body) 후, 그다음 **`LLM_PROVIDER` Gemini fallback**(`OPENAI_COMPAT_RETRY_*` 로그). 포트폴리오·트렌드(`trend_*`)·오픈 토픽·데이터 센터 호출 모두 동일 `generateOpenAiResponse` 경로.
- 예산 초과·오류 시 `OPENAI_FALLBACK_TO_GEMINI` 등으로 Gemini fallback.
- 프롬프트 압축: `promptCompressionPortfolio.ts` — 기본 **`standard_compressed`**, 재시도 경량·짧은 요약·FAST 트렌드 등은 **`aggressive_compressed`**.
- **그룹 분리**: `personaRoutePolicy.ts` — 금융 위원회(FINANCIAL) vs 트렌드·K-culture(TREND). 교차 경로에서 페르소나 선택은 하드 차단.
- **포트폴리오 위원 구성**: `personaWeightService` + `personaSignalsRepository` + `committeeCompositionService` — 가중치·회피·메모리·**최근 피드백/클레임 피드백(얇은 클램프)** 반영. `runMode`별로 **`full`** / 경량 **`light`** / 타임아웃 재시도 **`retry_summary`** / CIO만 **`short`**. 생략 위원 플레이스홀더는 **압축·trace용**; claim 추출·저장 및 피드백 매핑에서는 스킵. 로그: `PERSONA_WEIGHT_APPLIED`, `COMMITTEE_COMPOSITION_BUILT`, `CLAIM_EXTRACTION_PLACEHOLDER_SKIPPED`, `FEEDBACK_MAPPING_PLACEHOLDER_SKIPPED`.
- **포트폴리오 위원 응답 품질( full = fast 동일 원칙 )**: `src/application/portfolioPersonaQualityGuard.ts` — Ray·Hindenburg·Simons·Drucker·CIO에 대해 **최소 문장·근거·판단**(CIO는 GO/HOLD/REDUCE/EXIT 등 verdict) 미달 시 **동일 프롬프트에 `[QUALITY_RETRY_n]` 부가 후 최대 3회** 재호출(`runPortfolioPersonaWithQualityRetry`). full 경로 프롬프트는 fast와 맞추기 위해 **역할별 `[REASONING_STRUCTURE]` 번들**(`buildPortfolioFastPersonaPromptBundle` 등)을 사용한다. 운영 로그는 **`QUALITY`** scope(**`logs/llm/llm.log_*`**에 라우팅) — **docs/OPERATIONS.md** §3.3.

## 포트폴리오 토론 흐름

- `runPortfolioDebate` → `runUserVisibleAiExecution` → `runPortfolioDebateAppService`: 스냅샷·LLM·저장·`runAnalysisPipeline`.
- 완료 후 **Phase 2** `runDecisionEngineAppService`(best-effort): claim 로드 → 위원 투표 → risk veto → `decision_artifacts` / `committee_vote_logs`.
- **Phase 2.5**: `buildRebalancePlanAppService`로 그림자 리밸 플랜 저장, Discord 버튼으로 조회·완료·보류. **`리밸런싱 완료` 전에는 `trade_history` 미변경**(MVP 전제).
- 위원 성과 보정(`personaPerformanceCalibrationService`)은 투표 가중에만 소량 반영; veto/NO_DATA 게이트와 피드백 calibration은 별개.

## 오픈 토픽·트렌드

- `runOpenTopicDebate` / `runTrendAnalysis` 각각 `runUserVisibleAiExecution` + 해당 `*AppService` + 브로드캐스트.
- 오픈 토픽: 질의 분류(`OPEN_TOPIC_CLASSIFIED`) 후 `open_topic_financial`·`open_topic_trend`·`open_topic_general` — 그룹에 맞는 페르소나만 LLM에 태운다. **모호·일반(ambiguous)** 이면 `OPEN_TOPIC_AMBIGUOUS_DETECTED` 후 **follow-up 스냅샷**(`open_topic_ambiguous_view`)으로 관점 버튼 → `OPEN_TOPIC_VIEW_SELECTED`·`forcedOpenTopicView`로 재실행(JYP 기본 폴백 없음).
- 트렌드: `trend_*` 라우트 락, 포트폴리오 스냅샷 미사용, 단일(또는 주제별) 트렌드 에이전트만.

## 분석 후처리·저장

- `analysisPipelineService`: `analysis_generation_trace`, `analysis_claims` 추출/저장, `claim_outcome_audit` 스켈레톤 등(best-effort).
- 의사결정 질문이면 파이프라인에서 `DECISION_PROMPT detected` 등 로그.

## 피드백 ingestion

- 버튼 경로: `feedbackService` / `feedbackIngestionService` / `claim_feedback` / `persona_memory` 갱신. 상세 UX는 **docs/DISCORD_UX.md**, 컬럼은 **docs/DATABASE.md**.

## AI 실행 타임아웃·재시도

- **2단계**: `FIRST_VISIBLE_TIMEOUT_MS`(90s) 첫 유의미 브로드캐스트, 이후 `AI_RESPONSE_TIMEOUT_MS`(300s, 시작 기준). 상수: `aiExecutionPolicy.ts`.
- 부분 결과: `collectPartialResult` → 타임아웃 메시지에 요약 + 재시도 버튼. 스냅샷: `docs/sql/timeout_retry_snapshots.sql`.
- OpenAI Responses cancel best-effort, 늦은 전송은 `shouldDiscardOutgoing`으로 폐기. 로그 키는 **docs/OPERATIONS.md** §3.1.

## AI_PERF(체감·비용 관측)

- **`first_visible_latency_ms`**: `AiExecutionHandle.startedAt`(사용자에게 보이는 분석 실행 시작)부터 **`markFirstResponseSent`**가 호출될 때까지의 시간. 실제로 `broadcastAgentResponse`가 **첫 유의미 본문** 전송을 마친 뒤 기록된다(“분석 중” 안내만 있는 전송은 제외하는 쪽으로 설계됨).
- **`execution_summary`**: 파이프라인 종료 직전 `logExecutionPerfSummary` 한 줄 — `total_execution_time_ms`, 위 `first_visible_latency_ms` 재출력, 앱 서비스가 `setPerfMetrics`로 넣은 `prompt_build_time_ms`, `persona_parallel_wall_time_ms`, `cio_stage_time_ms`, `compressed_prompt_mode`, `retry_mode_used`, 핸들의 `partial_fallback_used` 등이 병합된다.
- 그 외 `persona_execution_time`, `portfolio_pipeline_complete` 등 기존 키 유지. 운영 해석은 **docs/OPERATIONS.md** §3.2.

## Quote(포트폴리오 시세)

- 종목 단위 다단계: Yahoo quote → chart EOD → 캐시 → DB/스냅샷 fallback. 실패해도 전체 스냅샷이 한 번에 무너지지 않도록 설계. 운영 점검·로그는 **docs/TROUBLESHOOTING.md** · **docs/OPERATIONS.md** §6.6.

## Phase 3(현금흐름·지출·종목 후보)

- `flow_type` 8종, 지출 할부 컬럼, `instrument_registration_candidates` 후 확정 — SQL `docs/sql/phase3_finance_instrument_integrity.sql`. 상세는 **docs/DATABASE.md**.

## System operator(로그 분석)

- `logAnalysisService`: `logs/` 읽기 전용 스캔, 데이터센터 **시스템 상태 점검** 버튼. 자동 kill/DB 쓰기 없음, 캐시 약 30초.
