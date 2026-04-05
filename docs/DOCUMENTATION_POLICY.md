# DOCUMENTATION POLICY

## 목적
- 코드와 문서의 불일치를 운영 리스크로 간주하고, 변경 시 동시 갱신을 강제한다.

## 문서 정본 (canonical)

### 1) 정본 목록 — 기능/구조/운영/DB 변경 시 이 세트만 본문으로 유지·갱신한다

| 구분 | 경로 |
|------|------|
| 입구 | `README.md` |
| 구조·진입점·모듈 | `docs/ARCHITECTURE.md` |
| 운영·로그·배포 점검 | `docs/OPERATIONS.md` |
| 테이블·마이그레이션 | `docs/DATABASE.md` |
| Discord UX | `docs/DISCORD_UX.md` |
| 분석 파이프라인·LLM 경로 요약 | `docs/ANALYSIS_PIPELINE.md` |
| 장애 점검 순서 | `docs/TROUBLESHOOTING.md` |
| 환경 변수 | `docs/ENVIRONMENT.md` |
| 테스트 체크리스트 | `docs/TEST_CHECKLIST.md` |
| 본 정책 문서 | `docs/DOCUMENTATION_POLICY.md` |
| 변경 이력 | `docs/CHANGELOG.md` |
| (참고) 로드맵 | `docs/ROADMAP.md` |
| (참고) 구조 리뷰 메모 | `docs/SYSTEM_REVIEW.md` |

### 2) 구 문서명 — 리다이렉트 스텁 전용 (정본 아님)

- `docs/SYSTEM_ARCHITECTURE.md` → 정본은 **`docs/ARCHITECTURE.md`**
- `docs/OPERATIONS_RUNBOOK.md` → 정본은 **`docs/OPERATIONS.md`**
- `docs/DATABASE_SCHEMA.md` → 정본은 **`docs/DATABASE.md`**

**원칙:** 위 세 파일에는 **설명·정책·기능 본문을 추가하지 않는다.** 링크 호환용 짧은 안내만 둔다. 내용 수정이 필요하면 **항상 정본 파일**을 연다.

### 3) README

- **입구 문서**로 유지한다. 상세 설계·운영 런북·스키마 장문은 정본 `docs/`에만 둔다.

### 4) Cursor / AI 프롬프트

- 문서 갱신을 요청할 때 **수정 대상으로 정본 경로만** 지정한다.
- **`docs/SYSTEM_ARCHITECTURE.md`**, **`docs/OPERATIONS_RUNBOOK.md`**, **`docs/DATABASE_SCHEMA.md`** 를 “업데이트할 문서” 목록에 넣지 않는다. (필요 시 “정본: ARCHITECTURE.md” 등으로만 지시한다.)

### 5) 변경 유형별 정본 갱신 (요약)

- **페르소나 그룹·위원 구성·오픈 토픽 분류** → `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/OPERATIONS.md`, `docs/DISCORD_UX.md`, `docs/TROUBLESHOOTING.md`, `CHANGELOG.md`(코드: `personaRoutePolicy.ts`, `personaWeightService.ts`, `committeeCompositionService.ts`, `personaSelectionPolicy.ts`).
- **DB 스키마·테이블** → `docs/DATABASE.md`, `CHANGELOG.md`
- **모듈 구조·Discord 진입점** → `docs/ARCHITECTURE.md`, 필요 시 `DISCORD_UX.md` / `ANALYSIS_PIPELINE.md`, `CHANGELOG.md`
- **운영 절차·로그·self-check** → `docs/OPERATIONS.md`, 필요 시 `TROUBLESHOOTING.md`, `CHANGELOG.md`
- **Discord 버튼·피드백·follow-up** → `docs/DISCORD_UX.md`, `CHANGELOG.md`
- **환경 변수** → `docs/ENVIRONMENT.md`, `CHANGELOG.md`
- **테스트 절차** → `docs/TEST_CHECKLIST.md`, `CHANGELOG.md`

---

## 강제 원칙 (필수)
1. 기능 추가/수정/삭제/리팩토링 시 관련 문서를 반드시 함께 갱신한다.
2. 코드 변경만 하고 문서를 수정하지 않는 작업은 **불완전한 작업**으로 간주한다.
3. 아래 항목 중 하나라도 변경되면 문서 갱신이 필요하다.
   - 아키텍처 변경
   - 서비스 모듈 추가/삭제
   - DB 스키마 변경
   - 환경 변수 변경
   - 실행/운영 방법 변경
   - 테스트 방법 변경
   - LLM provider/model 전략 변경
4. `docs/CHANGELOG.md`는 코드 변경 시 **항상** 갱신한다.
5. 환경변수 변경 시 `docs/ENVIRONMENT.md`를 반드시 갱신한다.
6. 테이블/컬럼/관계 변경 시 **`docs/DATABASE.md`** 를 반드시 갱신한다. 구 `DATABASE_SCHEMA.md`는 **스텁만** — 본문 수정 금지(상단 § 문서 정본).
7. 실행 흐름/모듈 구조 변경 시 **`docs/ARCHITECTURE.md`** 를 반드시 갱신한다. Discord UX만 바뀌면 **`docs/DISCORD_UX.md`**, 분석 파이프라인만 바뀌면 **`docs/ANALYSIS_PIPELINE.md`** 도 함께 검토한다. 구 `SYSTEM_ARCHITECTURE.md`는 스텁만 — 본문 수정 금지.
8. 운영 절차·로그 확인 절차 변경 시 **`docs/OPERATIONS.md`** 를 반드시 갱신한다. 장애 대응 순서·FAQ 성격이면 **`docs/TROUBLESHOOTING.md`** 도 갱신한다. 구 `OPERATIONS_RUNBOOK.md`는 스텁만 — 본문 수정 금지.
9. 테스트 절차 변경 시 `docs/TEST_CHECKLIST.md`를 반드시 갱신한다.
10. 로드맵 변경 시 `docs/ROADMAP.md`를 반드시 갱신한다.

## Cursor 작업 원칙
- 소스 수정 요청 시 관련 **정본** 문서 갱신 필요 여부를 먼저 판단하고 함께 반영한다.
- 문서 갱신이 필요한데 수행하지 않았다면 작업 완료로 간주하지 않는다.
- 문서 경로를 지정할 때는 **§ 문서 정본 (canonical)** 목록만 사용한다. `SYSTEM_ARCHITECTURE.md` / `OPERATIONS_RUNBOOK.md` / `DATABASE_SCHEMA.md` 는 수정 대상에 넣지 않는다.

## 작업 절차 (표준)
1. **코드 변경 전**
   - 변경 범위를 분석하고 영향 문서를 목록화한다.
2. **코드 변경 중**
   - 코드와 문서를 같은 변경 세트로 관리한다.
3. **코드 변경 후**
   - CHANGELOG 포함 문서 업데이트 완료 여부를 체크한다.
4. **배포 전**
   - 문서 누락이 없을 때만 배포 후보로 간주한다.

## 문서 린트 (`docs:check`)

- **실행**: `npm run docs:check` (`scripts/docs-check.ts`)
- **PR 또는 문서/구조 관련 변경 시** 실행을 **권장**한다. (로컬·CI에서 가볍게 통과 여부 확인.)
- **역할 요약**
  - `README.md`에 입구로 부적절한 장문 키워드 누적이 없는지 경고.
  - 구명 스텁 3종(`SYSTEM_ARCHITECTURE` / `OPERATIONS_RUNBOOK` / `DATABASE_SCHEMA`)이 **10줄 미만**이고 **`정본은` 문구**를 포함하는지 검사 — 위반 시 **실패(exit 1)**.
  - `docs/` 안(이력·정책 문서 제외)에서 구 문서 `.md`를 **마크다운 링크 대상**으로 쓰면 **경고**.
- **정본 외 수정**: 스텁에 본문을 늘리면 위 규칙으로 **실패**한다. 정본이 아닌 파일을 “설명 정본”처럼 키우는 것은 이 스크립트 기준으로도 허용되지 않는다.

## Self-check / npm script 동기화
- `package.json`의 `check:*` 스크립트 추가·변경·삭제 시 반드시 함께 갱신한다.
  - `docs/OPERATIONS.md` — self-check·`node dist/*_self_check.js` 목록·배포 전 필수/확장 구분
  - `README.md` — 필요 시 한 줄로 “자세한 명령은 OPERATIONS.md”만 보강
  - `docs/TEST_CHECKLIST.md` — 자동 점검 목록
  - `docs/ENVIRONMENT.md` — 새 env가 필요하면
  - `docs/CHANGELOG.md`
  - 문서 구조·스텁·README 입구 규칙 변경 시: `scripts/docs-check.ts` 및 `npm run docs:check` 동작 확인
  - Phase 2 decision 관련 시: `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/DATABASE.md`(테이블 추가), `docs/ROADMAP.md`
  - Phase 2 **SQL hardening** 추가 시: `docs/sql/append_phase2_decision_tables_hardening.sql`, `docs/DATABASE.md`, `docs/OPERATIONS.md`, `docs/TEST_CHECKLIST.md`

## 최소 문서 갱신 매트릭스
- DB 타입 계약(`src/types/dbSchemaContract.ts`) 또는 스키마 점검 스크립트 변경 -> `docs/DATABASE.md`, `docs/ARCHITECTURE.md`(확인 필요 절), `CHANGELOG.md`, `docs/TEST_CHECKLIST.md`(자동 점검 명령 추가 시)
- Phase 1 구조/self-check 스크립트 추가·변경 -> `docs/ARCHITECTURE.md`, `docs/TEST_CHECKLIST.md`, `CHANGELOG.md`, `docs/OPERATIONS.md`, `README.md`(요약 필요 시만)
- provider 정책 변경 -> `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `ENVIRONMENT.md`, `CHANGELOG.md`
- quote/valuation 변경 -> `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/OPERATIONS.md`, `docs/TROUBLESHOOTING.md`, `docs/TEST_CHECKLIST.md`, `CHANGELOG.md`
- 신규 테이블/컬럼 -> `docs/DATABASE.md`, `CHANGELOG.md`
- 운영 명령/절차 변경 -> `docs/OPERATIONS.md`, `README.md`(한 줄 요약 필요 시만), `CHANGELOG.md`
- Discord 버튼·피드백·follow-up UX만 변경 -> `docs/DISCORD_UX.md`, `CHANGELOG.md`

## 리뷰/승인 기준
- 리뷰어는 코드 변경과 문서 변경의 일치 여부를 함께 확인한다.
- 문서 누락 PR/작업은 수정 요청 상태로 유지한다.

## 예외 정책
- 긴급 장애 대응(핫픽스)으로 즉시 반영이 필요한 경우에도,
  - 최소 `CHANGELOG.md`는 당일 갱신
  - 나머지 문서는 24시간 내 보완

## 확인 필요
- 향후 CI에서 문서 갱신 체크(예: 변경 파일 패턴 기반)를 자동화할지 결정 필요
