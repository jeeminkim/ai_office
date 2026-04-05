# TROUBLESHOOTING

자주 발생하는 문제에 대한 **확인 순서**를 짧게 정리한다. 표준 운영 절차·로그 위치는 **docs/OPERATIONS.md**를 본다.

## 1. 환경 변수 누락·오타

1. `.env` 존재 및 루트에서 로드되는지 확인.
2. 필수: `DISCORD_TOKEN` 또는 `DISCORD_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` — **docs/ENVIRONMENT.md** 대조.
3. 부팅 로그 `BOOT` / `ENV`에서 누락 힌트 확인.

## 2. Discord interaction 실패

1. `Unknown interaction`, `Invalid Form Body` — defer 타이밍·페이로드 크기·모달 필드.
2. `INTERACTION` / `DISCORD` 스코프, `route matched` 로그로 어떤 route가 잡혔는지 확인.
3. 버튼이 동작하지 않으면 메시지가 **webhook 전용** 아닌지 확인 — **docs/DISCORD_UX.md** Feedback 절.

## 3. Supabase 스키마 불일치

1. `index.ts` 초기 DB check, insert/select 에러 로그.
2. `chat_history.id`는 운영 기준 **integer** — `npm run check:schema-contract`.
3. 필수·권장 migration 목록·순서: **docs/DATABASE.md** “기준 파일”.
4. 피드백 경로에서 `invalid input syntax for type uuid` 반복 시 integer ID를 UUID 컬럼에 넣지 않았는지, `feedback_chat_history_ref.sql` 적용 여부 확인.

## 4. Quote / 시세·valuation

1. `logs/quote/quote.log_*` 에서 `QUOTE_RESOLUTION`, `yahoo_v7_http_error` / `yahoo_chart_http_error`, `eod_fallback_used`, `cache_fallback_used`, `symbol_corrected`.
2. 401 다발 시 User-Agent·레이트·네트워크 점검.
3. 포트폴리오 메시지의 출처·stale 안내와 로그 교차 확인 — **docs/OPERATIONS.md** §6.6.

## 5. LLM 실패·fallback

1. `OPENAI_API_KEY`, `OPENAI_MONTHLY_MAX_CALLS`, `OPENAI_MONTHLY_BUDGET_USD`, `OPENAI_FALLBACK_TO_GEMINI`.
2. `LLM_PROVIDER` 로그의 fallback reason.
3. **OpenAI 400·unsupported parameter**: `logs/openai/openai.log_*`에서 `OPENAI_UNSUPPORTED_PARAM_REMOVED`(이미 사전 제거됐는지) → `OPENAI_RETRY_WITH_COMPAT_PAYLOAD`·`OPENAI_COMPAT_RETRY_*` → 그다음에만 `fallback to gemini`. 모델 테이블은 `openAiModelCapabilities.ts`(예: `gpt-5*` temperature 미전송).
4. **포트폴리오 응답이 짧거나 구조만 비는 경우**: `logs/llm/llm.log_*`의 `QUALITY_*` — 어느 `personaKey`·`runMode`에서 재생성이 소진됐는지 확인(**docs/OPERATIONS.md** §3.3).

## 5b. “왜 JYP/금융 위원이 나왔는가” (페르소나 그룹)

1. `PERSONA_GROUP_SELECTED`, `ROUTE_FAMILY_LOCKED`, `OPEN_TOPIC_CLASSIFIED`로 **의도한 라우트 패밀리** 확인.
2. 포트폴리오 경로: `COMMITTEE_COMPOSITION_BUILT`(`runMode`)·`PERSONA_WEIGHT_APPLIED`로 Ray/Hind/Simons 생략·경량 모드 확인; K-culture가 끼었다면 `PERSONA_HARD_EXCLUDED`·`ROUTE_OVERRIDE_BLOCKED` 유무 확인. 이상한 claim/피드백이 쌓이면 `CLAIM_EXTRACTION_PLACEHOLDER_SKIPPED`·`FEEDBACK_MAPPING_PLACEHOLDER_SKIPPED`로 위원 생략 플레이스홀더가 필터됐는지 확인.
3. 트렌드 경로: `trend_*` 잠금 후 금융 위원이 보이면 상위 라우팅(오케스트레이터)부터 추적.

## 6. PM2 / 프로세스가 안 멈출 때 (Windows)

1. `pm2 stop ai-office` 후 `pm2 list`.
2. 터미널 직접 실행이면 `Ctrl+C`.
3. `Get-Process -Name node` 후 `taskkill /PID <pid>`, 최후에만 `/F`.
4. Control Panel이 띄운 프로세스는 패널의 중지·검증 단계와 `control-panel.log_*` 참고 — **docs/OPERATIONS.md** §6.5.

## 7. Control Panel / 중복 기동

1. `office-health.json` 하트비트로 이미 실행 중이면 기동 거부될 수 있음.
2. 중지 실패 시 `post_stop_verification`, `stop_final_status`, `stop_force_fallback_*` — **docs/OPERATIONS.md** §6.5.

## 8. 메인 패널 복구 실패

1. `DISCORD_MAIN_PANEL_CHANNEL_ID` 또는 `DEFAULT_CHANNEL_ID` 설정.
2. `state/discord-panel.json` 손상 여부.
3. 로그 `PANEL restore *`, `office-health.json`의 `panels.*`.

## 9. AI 분석 타임아웃만 반복

1. `AI_EXECUTION_TIMEOUT`의 `timeoutPhase`(`first_visible` vs `total`).
2. `timeout_retry_snapshots` 적용 여부(`retrySnapshotSaved.source`: db vs memory).
3. **docs/OPERATIONS.md** §3.1, **docs/ANALYSIS_PIPELINE.md**.

## 10. 일반 장애 대응 흐름

1. 장애 범주 분류(Discord / Supabase / LLM / quote).
2. 최근 15분 `office-error`·`office-ops` 확인.
3. fallback 동작 여부 확인 후 필요 시 재시작 — 상세는 **docs/OPERATIONS.md** §4.
