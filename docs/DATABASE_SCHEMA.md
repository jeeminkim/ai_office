# DATABASE SCHEMA

## 목적
- 운영에 중요한 테이블 구조와 관계를 코드 관점으로 정리한다.
- `schema.sql`/migration 파일과 실제 운영 DB가 다를 수 있으므로, 확인 필요 항목을 분리한다.

## 기준 파일
- 기본 스키마: `schema.sql`
- 추가 migration:
  - `openai_budget_migration.sql`
  - `feedback_integrity_migration.sql`
  - Phase 2 append-only: `docs/sql/append_phase2_decision_tables.sql` (`decision_artifacts`, `committee_vote_logs`)
  - Phase 2 hardening(기본 Phase 2 적용 후): `docs/sql/append_phase2_decision_tables_hardening.sql` (컬럼·인덱스·CHECK·FK 추가만)
  - Phase 2.5: `docs/sql/phase2_5_advisory_execution.sql` (`rebalance_plans`, `rebalance_plan_items`, `claim_outcome_audit` 확장 컬럼)
  - Phase 3: `docs/sql/phase3_finance_instrument_integrity.sql` — `expenses` 할부 컬럼, `cashflow.flow_type` 레거시 정규화·CHECK(NOT VALID), `instrument_registration_candidates`, `portfolio`/`trade_history` KR·US 메타 CHECK(NOT VALID)
  - Discord 의사결정 UX: `docs/sql/decision_history.sql` — `decision_snapshots`(버튼 옵션 스냅샷), `decision_history`(사용자 선택 영구 저장, `chat_history_ref` TEXT)

### Discord 의사결정 UX (`docs/sql/decision_history.sql`)
- **`decision_snapshots`**: 브로드캐스트 시점 버튼 옵션 `JSONB`(customId에 UUID만 넣고 라벨은 DB에서 복원).
- **`decision_history`**: 사용자 클릭 `selected_option`, `option_index`, `decision_context`(options·persona·topic·snapshot_id 등). `chat_history_ref` TEXT — integer id 문자열, UUID FK 강제 없음.

## 핵심 테이블(기존)

### `chat_history`
- 용도: 사용자 질의 및 페르소나 응답 저장
- 주요 컬럼:
  - `id` — **운영 DB 기준 `integer`(시퀀스)**. FK·앱 타입은 `number`로 통일한다.
  - `user_id`
  - `user_query`
  - `ray_advice`, `jyp_insight`, `simons_opportunity`, `drucker_decision`, `cio_decision`
  - 확장(일부 DB만): `summary`, `key_risks`, `key_actions` — 레거시로 `debate_type`이 있을 수 있으나 **현재 앱은 insert/select에서 의존하지 않음**(피드백의 `analysis_type`은 customId·`analysis_claims.analysis_type` 기준).
- 주의:
  - 코드·스키마 계약: `src/types/dbSchemaContract.ts`의 `ChatHistoryRowContract.id`는 `number`다.
  - 레포 `schema.sql`에 UUID 정의 흔적이 있어도 **운영 integer가 기준**이다. 점검: `npm run check:schema-contract`

### `analysis_feedback_history`
- 용도: 사용자 피드백 기록
- 주요 컬럼:
  - `discord_user_id`
  - `chat_history_id`
  - `analysis_type`
  - `persona_name`
  - `opinion_summary`, `opinion_text`
  - `feedback_type`, `feedback_note`
- 확장 컬럼(`feedback_integrity_migration.sql`):
  - `mapped_claim_id`
  - `mapping_method`
  - `mapping_score`
- **Discord 버튼 경로(운영)**:
  - 버튼 `customId`: `feedback:save:{chat_history_id}:{analysis_type}:{feedback_type}:{persona_key}` (`index.ts`의 `getFeedbackButtonsRow`).
  - `analysis_type` 저장값은 **customId에서 파싱한 문자열**이며, `chat_history.debate_type`을 읽지 않는다.
  - 클릭 시 `index.ts` → `saveAnalysisFeedbackHistory` → `ingestPersonaFeedback` → (성공 시) `claim_feedback` 반영 시도. `persona_name`은 `analysis_claims`와 맞추기 위해 기존 페르소나 표시명 계열과 동일하게 매핑한다.
  - 동일 사용자·짧은 시간 내 동일 `feedback_type` 연타는 서비스 계층에서 duplicate 처리.

### `user_profile`
- 용도: 개인화 신호 저장
- 주요 컬럼:
  - `discord_user_id` (unique)
  - `risk_tolerance`, `investment_style`
  - `preferred_sectors`, `behavior_tags`, `preferred_personas`, `avoided_personas`
  - `personalization_notes`

### `portfolio`
- 용도: 현재 보유 포지션
- 주요 컬럼:
  - `discord_user_id`, `symbol`, `quantity`, `avg_purchase_price`, `current_price`
  - `market`, `currency`, `display_name`, `quote_symbol`, `exchange`
  - `account_id`
  - `purchase_currency` (중요: 평단 단위)
- 인덱스:
  - `uq_portfolio_user_account_symbol` (user, account, symbol)
- **Phase 3**: `chk_portfolio_kr_us_instrument_meta`(NOT VALID) — `market`·`currency`·`symbol`·`quote_symbol`이 모두 채워진 행에 대해 KR(6자리·`.KS`/`.KQ`) / US(`USD`, `symbol=quote_symbol`) 조합을 강제. 코드 검증은 `src/services/instrumentValidation.ts`의 `validateConfirmedInstrument`.

### `accounts`
- 용도: 사용자 계좌 구분
- 주요 컬럼:
  - `discord_user_id`
  - `account_name` (일반계좌 포함)
  - `account_type` (`TAXABLE`, `RETIREMENT`, `PENSION`, `ISA`, `OTHER`)

### `trade_history`
- 용도: 매매 원장
- 주요 컬럼:
  - `discord_user_id`, `account_id`, `trade_type`
  - `symbol`, `market`, `currency`
  - `quantity`, `price_per_unit`, `total_amount`, `realized_pnl_krw`
  - `purchase_currency`
- **Phase 3**: `chk_trade_history_kr_us_instrument_meta`(NOT VALID) — 위와 동일한 KR/US 메타 규칙(완전히 채워진 행만).

### `cashflow` (표준 유형)
- `flow_type` 텍스트는 Phase 3에서 8종으로 정규화: `SALARY`, `BONUS`, `LOAN_IN`, `LOAN_PRINCIPAL`, `LOAN_INTEREST`, `CONSUMPTION`, `OTHER_IN`, `OTHER_OUT`.
- 레거시 값은 `phase3_finance_instrument_integrity.sql`의 `UPDATE`로 매핑 후 `cashflow_flow_type_allowed` CHECK(NOT VALID) 적용.
- 앱 파서: `src/finance/cashflowCategories.ts` (`parseCashflowFlowType`).

### `expenses` (할부 확장)
- Phase 3 추가(모두 nullable): `is_installment`, `installment_months`, `monthly_recognized_amount`, `installment_start_date`.
- Discord 모달에서 `parseInstallmentLine`(`src/finance/expenseInstallment.ts`)으로 파싱.

### `instrument_registration_candidates`
- 용도: 종목 메타 **확정 전** Discord 후보만 저장. `status` ∈ `PENDING` | `CONFIRMED` | `CANCELLED` | `EXPIRED`.
- `candidate_payload` JSON에 후보 목록; `pending_pick_index`로 다중 후보 선택.
- **확인(`instr:confirm`) 전**에는 `portfolio` / `trade_history`에 쓰지 않음. 확정 시 `validateConfirmedInstrument` + `recordBuyTrade`.
- 참조: `src/repositories/instrumentCandidateRepository.ts`, `src/interactions/instrumentConfirmationHandler.ts`.

### `portfolio_snapshot_history`
- 용도: 일자/계좌별 스냅샷 이력
- 주요 컬럼:
  - `discord_user_id`, `snapshot_date`, `account_id`
  - `total_cost_basis_krw`, `total_market_value_krw`, `total_pnl_krw`, `total_return_pct`

## Phase 1 신규 테이블(코드 기준)

### `persona_memory`
- 용도: 페르소나별 누적 선호/비선호/스타일 bias 저장
- JSON `confidence_calibration`(코드 기준): `preferred_claim_types`, `preferred_evidence_scopes`, `numeric_anchor_bias`, `actionable_bias`, `downside_bias`, `conservatism_floor` 등 — 피드백·`claim_feedback`에서 **소량** 누적(의사결정 게이트 완화용 아님)
- 참조 코드: `personaMemoryService.ts`

### `analysis_claims`
- 용도: 응답 텍스트에서 추출한 claim 단위 기록
- `chat_history_id`: `number | null` (운영 `chat_history.id` integer FK)
- 참조 코드: `claimLedgerService.ts` + insert 경로 `src/repositories/claimRepository.ts`

### `claim_feedback`
- 용도: claim 단위 사용자 피드백
- 무결성:
  - unique index `(discord_user_id, claim_id, feedback_type)` 적용

### `claim_outcome_audit`
- 용도: claim outcome 추적(Phase 1 스켈레톤 + Phase 2.5 감사 필드)
- Phase 2.5 확장(마이그레이션 후): `baseline_price`, `price_after_7d`, `price_after_30d`, 수익률·`direction_hit_*`, `contribution_score`, `linked_symbol` 등 — **과거 시세 리플레이 없이 MVP 스냅샷** (`runClaimOutcomeAuditAppService`)
- 참조 코드: `saveClaimOutcomeAuditSkeleton`, `runClaimOutcomeAuditAppService`

### `rebalance_plans` / `rebalance_plan_items`
- 용도: **그림자** 리밸런싱 실행안(자동 주문 없음). 상태 `pending` → 사용자가 HTS/MTS 체결 후 `리밸런싱 완료` 시 `executed` + `trade_history` 반영(`executeRebalancePlanAppService`).
- 참조: `rebalancePlanRepository.ts`, `buildRebalancePlanAppService.ts`

### `persona_scorecard`
- 용도: 페르소나 품질 점수 집계(코드/운영 설계상 대상)
- 상태: 운영 DB 실물 여부 확인 필요

### `analysis_generation_trace`
- 용도: 생성 컨텍스트/결과 요약/모델 메타 저장
- `memory_snapshot`: 페르소나 메모리 스냅샷; **CIO** 행에는 `feedback_adjustment_meta`가 포함될 수 있음(피드백 소프트 보정 감사용, 스키마 컬럼 추가 없음)
- `chat_history_id`: 운영 DB 기준 `integer` FK → 코드 타입 `number | null` (`src/types/dbSchemaContract.ts`의 `AnalysisGenerationTraceInsertContract`)
- 확장 컬럼:
  - `provider_name`, `model_name`, `estimated_cost_usd` (migration 반영 시)
- 저장 구현: `src/repositories/generationTraceRepository.ts`(확장 insert 실패 시 base 컬럼 insert)

### `api_usage_tracking`
- 용도: OpenAI 월 예산/호출량 관리
- 참조 migration: `openai_budget_migration.sql`

## Phase 2 신규 테이블(의사결정 산출물, 실행/주문 없음)

### `decision_artifacts`
- 용도: 위원회 가중 투표 + 리스크 veto 이후 **최종 구조화 결정** 스냅샷(BUY/ADD/HOLD/…)
- `chat_history_id`: `integer` FK → `chat_history.id` (nullable, `ON DELETE SET NULL`)
- 기본 컬럼(첫 migration): `final_decision`, `confidence_score`, `veto_applied`, `veto_reason`, `weighted_score`, `normalized_score`, `committee_json`, `supporting_claims_json`, `created_at`
- **hardening 추가 컬럼**(`append_phase2_decision_tables_hardening.sql`): `original_decision`, `engine_version`, `policy_version`, `veto_rule_ids_json`, `supporting_claim_ids_json`, `created_by_engine`
- 무결성: `final_decision` / `original_decision` CHECK, idempotency용 **부분 유니크 인덱스** `(chat_history_id, analysis_type, engine_version)` (`chat_history_id IS NOT NULL`)
- 저장: `src/repositories/decisionArtifactRepository.ts`
- SQL: `docs/sql/append_phase2_decision_tables.sql` → 이후 `append_phase2_decision_tables_hardening.sql`

### `committee_vote_logs`
- 용도: 위원(persona)별 judgment / vote / weight / 신뢰도 / 참조 claim id (설명 가능성)
- `chat_history_id`: 동일 계약(`integer`, nullable FK)
- 기본 컬럼: `judgment`, `vote_value`, `weight_value`, `weighted_score`, `reasons_json`, `referenced_claim_ids_json`
- **hardening**: `decision_artifact_id` → `decision_artifacts(id)` FK, `engine_version`, `policy_version`, `raw_vote_reason`; CHECK(`judgment`, `vote_value`, `confidence_score`); 유니크 `(decision_artifact_id, persona_name)` (artifact 비NULL 행)

## 테이블 간 관계(요약)
- `chat_history` 1:N `analysis_feedback_history`
- `chat_history` 1:N `analysis_claims`
- `chat_history` 1:N `decision_artifacts`, 1:N `committee_vote_logs` (Phase 2, migration 적용 시)
- `decision_artifacts` 1:N `committee_vote_logs` (`decision_artifact_id`, hardening 적용 시)
- `analysis_claims` 1:N `claim_feedback`
- `analysis_claims` 1:N `claim_outcome_audit`
- `accounts` 1:N `portfolio`, 1:N `trade_history`
- `accounts` 1:N `portfolio_snapshot_history` (optional)

## 타입 차이 및 주의점
- **`chat_history.id` (단일 계약)**
  - 운영 DB: **integer(시퀀스)** 를 기준으로 한다.
  - 코드: `src/types/dbSchemaContract.ts`의 `ChatHistoryRowContract.id` = `number`
  - 레포 `schema.sql`에 UUID 흔적이 있어도 앱·문서는 위 운영 기준을 따른다.
  - 점검: `npm run check:schema-contract`

## 반영 상태 구분

### 이미 반영됨(코드에서 확인)
- `analysis_claims` 저장/조회 경로
- `claim_feedback` 저장 경로 및 중복 방어
- `persona_memory` refresh/load/upsert 경로
- `analysis_generation_trace` 저장(확장 컬럼 fallback 포함)
- `api_usage_tracking` 사용량 저장/조회

### 반영 예정/강화 필요
- `persona_scorecard` 전용 테이블 materialization(현재는 `claim_outcome_audit` + `analysis_claims` 집계로 점수카드 생성)
- 부분 체결·브로커 API 연동(Phase 2.5는 전량 MVP)
- 스키마 드리프트 정리 문서 자동화

### 확인 필요(운영 DB 기준)
- `chat_history.id` 타입 및 FK 호환성
- `analysis_generation_trace` 확장 컬럼 적용 여부
- legacy 컬럼(`user_id`/`discord_user_id`) 공존 상태

## 문서 동기화 원칙
- 테이블/컬럼/인덱스/관계 변경 시 반드시 다음 갱신:
  - `docs/DATABASE_SCHEMA.md`
  - `docs/CHANGELOG.md`
  - 필요 시 `docs/SYSTEM_ARCHITECTURE.md`
