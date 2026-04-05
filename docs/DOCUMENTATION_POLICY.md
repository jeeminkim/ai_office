# DOCUMENTATION POLICY

## 목적
- 코드와 문서의 불일치를 운영 리스크로 간주하고, 변경 시 동시 갱신을 강제한다.

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
6. 테이블/컬럼/관계 변경 시 **`docs/DATABASE.md`** 를 반드시 갱신한다. (구명 `DATABASE_SCHEMA.md`는 리다이렉트만 유지.)
7. 실행 흐름/모듈 구조 변경 시 **`docs/ARCHITECTURE.md`** 를 반드시 갱신한다. Discord UX만 바뀌면 **`docs/DISCORD_UX.md`**, 분석 파이프라인만 바뀌면 **`docs/ANALYSIS_PIPELINE.md`** 도 함께 검토한다. (구명 `SYSTEM_ARCHITECTURE.md`는 리다이렉트.)
8. 운영 절차·로그 확인 절차 변경 시 **`docs/OPERATIONS.md`** 를 반드시 갱신한다. 장애 대응 순서·FAQ 성격이면 **`docs/TROUBLESHOOTING.md`** 도 갱신한다. (구명 `OPERATIONS_RUNBOOK.md`는 리다이렉트.)
9. 테스트 절차 변경 시 `docs/TEST_CHECKLIST.md`를 반드시 갱신한다.
10. 로드맵 변경 시 `docs/ROADMAP.md`를 반드시 갱신한다.

## Cursor 작업 원칙
- 앞으로 Cursor는 소스 수정 요청을 받을 경우, 관련 문서 수정 필요 여부를 먼저 판단하고 함께 반영해야 한다.
- 문서 갱신이 필요한데 수행하지 않았다면 작업 완료로 간주하지 않는다.

## 작업 절차 (표준)
1. **코드 변경 전**
   - 변경 범위를 분석하고 영향 문서를 목록화한다.
2. **코드 변경 중**
   - 코드와 문서를 같은 변경 세트로 관리한다.
3. **코드 변경 후**
   - CHANGELOG 포함 문서 업데이트 완료 여부를 체크한다.
4. **배포 전**
   - 문서 누락이 없을 때만 배포 후보로 간주한다.

## Self-check / npm script 동기화
- `package.json`의 `check:*` 스크립트 추가·변경·삭제 시 반드시 함께 갱신한다.
  - `docs/OPERATIONS.md` (배포 전 self-check·`node dist/*_self_check.js` 목록 — 전문)
  - `README.md` (필요 시 한 줄로 “자세한 명령은 OPERATIONS.md”만 보강)
  - `docs/TEST_CHECKLIST.md` (자동 점검 목록)
  - `docs/OPERATIONS.md` (배포 전 필수/확장 구분에 해당하면)
  - `docs/ENVIRONMENT.md` (새 env가 필요하면)
  - `docs/CHANGELOG.md`
  - Phase 2 decision 관련 시: `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/DATABASE.md`(테이블 추가), `docs/ROADMAP.md`
  - Phase 2 **SQL hardening** 추가 시: `docs/sql/append_phase2_decision_tables_hardening.sql`, `docs/DATABASE.md`, `docs/OPERATIONS.md`, `TEST_CHECKLIST.md`

## 최소 문서 갱신 매트릭스
- DB 타입 계약(`src/types/dbSchemaContract.ts`) 또는 스키마 점검 스크립트 변경 -> `docs/DATABASE.md`, `docs/ARCHITECTURE.md`(확인 필요 절), `CHANGELOG.md`, `TEST_CHECKLIST.md`(자동 점검 명령 추가 시)
- Phase 1 구조/self-check 스크립트 추가·변경 -> `docs/ARCHITECTURE.md`, `TEST_CHECKLIST.md`, `CHANGELOG.md`, `docs/OPERATIONS.md`, `README.md`(요약 필요 시만)
- provider 정책 변경 -> `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `ENVIRONMENT.md`, `CHANGELOG.md`
- quote/valuation 변경 -> `docs/ARCHITECTURE.md`, `docs/ANALYSIS_PIPELINE.md`, `docs/OPERATIONS.md`, `docs/TROUBLESHOOTING.md`, `TEST_CHECKLIST.md`, `CHANGELOG.md`
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
