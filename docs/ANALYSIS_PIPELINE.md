# ANALYSIS PIPELINE

페르소나 기반 **포트폴리오 토론·오픈 토픽·트렌드** 분석이 코드에서 어떻게 돌아가는지, LLM·claim·피드백·의사결정·advisory와 어떻게 연결되는지 요약한다. 모듈 경로·레이어 다이어그램은 **docs/ARCHITECTURE.md**를 본다.

## 페르소나·provider

- 중앙 호출: `generateWithPersonaProvider` / `llmProviderService.getModelForTask` 등. OpenAI 우선 페르소나(코드 기준): Hindenburg, Simons, Thiel(데이터센터), Hot Trend 등 — 나머지는 기본 Gemini.
- 예산 초과·오류 시 `OPENAI_FALLBACK_TO_GEMINI` 등으로 Gemini fallback.
- 프롬프트 압축: `promptCompressionPortfolio.ts` — 기본 **`standard_compressed`**, 재시도 경량·짧은 요약·FAST 트렌드 등은 **`aggressive_compressed`**. Ray∥Hindenburg 병렬, 이후 Simons → Drucker → CIO 순서 유지.

## 포트폴리오 토론 흐름

- `runPortfolioDebate` → `runUserVisibleAiExecution` → `runPortfolioDebateAppService`: 스냅샷·LLM·저장·`runAnalysisPipeline`.
- 완료 후 **Phase 2** `runDecisionEngineAppService`(best-effort): claim 로드 → 위원 투표 → risk veto → `decision_artifacts` / `committee_vote_logs`.
- **Phase 2.5**: `buildRebalancePlanAppService`로 그림자 리밸 플랜 저장, Discord 버튼으로 조회·완료·보류. **`리밸런싱 완료` 전에는 `trade_history` 미변경**(MVP 전제).
- 위원 성과 보정(`personaPerformanceCalibrationService`)은 투표 가중에만 소량 반영; veto/NO_DATA 게이트와 피드백 calibration은 별개.

## 오픈 토픽·트렌드

- `runOpenTopicDebate` / `runTrendAnalysis` 각각 `runUserVisibleAiExecution` + 해당 `*AppService` + 브로드캐스트.

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

- `AI_PERF` 스코프: `first_visible_latency_ms`, `persona_execution_time`, `execution_summary`(`total_execution_time_ms`, `prompt_build_time_ms`, `persona_parallel_wall_time_ms`, `cio_stage_time_ms`, `compressed_prompt_mode`, `retry_mode_used`, `partial_fallback_used`) 등. 운영 해석은 **docs/OPERATIONS.md** §3.2.

## Quote(포트폴리오 시세)

- 종목 단위 다단계: Yahoo quote → chart EOD → 캐시 → DB/스냅샷 fallback. 실패해도 전체 스냅샷이 한 번에 무너지지 않도록 설계. 운영 점검·로그는 **docs/TROUBLESHOOTING.md** · **docs/OPERATIONS.md** §6.6.

## Phase 3(현금흐름·지출·종목 후보)

- `flow_type` 8종, 지출 할부 컬럼, `instrument_registration_candidates` 후 확정 — SQL `docs/sql/phase3_finance_instrument_integrity.sql`. 상세는 **docs/DATABASE.md**.

## System operator(로그 분석)

- `logAnalysisService`: `logs/` 읽기 전용 스캔, 데이터센터 **시스템 상태 점검** 버튼. 자동 kill/DB 쓰기 없음, 캐시 약 30초.
