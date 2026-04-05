# ENVIRONMENT

## 원칙
- `.env`는 커밋하지 않는다.
- `.env.example`를 기준으로 배포 환경별 실제 값을 주입한다.
- 환경변수 추가/변경/삭제 시 `ENVIRONMENT.md`와 `CHANGELOG.md`를 함께 갱신한다.

## 필수 환경변수
- `DISCORD_TOKEN` 또는 `DISCORD_BOT_TOKEN`
  - Discord 봇 인증 토큰 (둘 중 하나는 반드시 필요)
- `SUPABASE_URL`
  - Supabase 프로젝트 URL
- `SUPABASE_SERVICE_ROLE_KEY`
  - 서버 권한 키 (민감정보)
- `GEMINI_API_KEY`
  - Gemini 호출 키 (Gemini 기본/대체 경로에 필요)

## 선택 환경변수
- `OPENAI_API_KEY`
  - OpenAI 호출 키 (없으면 대상 페르소나는 Gemini fallback)
- `OPENAI_MODEL_HINDENBURG` (default: `gpt-5-mini`)
- `OPENAI_MODEL_SIMONS` (default: `gpt-5-mini`)
- `OPENAI_MODEL_PERSONA_ANALYSIS` (optional: Hindenburg/Simons 등 **페르소나 분석** 작업에 공통 지정 시 위보다 우선)
- `OPENAI_MODEL_CIO_DECISION` / `OPENAI_MODEL_CIO` (optional: OpenAI 기반 CIO 경로 확장 시; 현재 CIO follow-up 일부는 Gemini `SUMMARY`)
- `GEMINI_MODEL_SUMMARY` (optional: 트렌드·요약·저비용 Gemini 기본 모델 문자열, default: 코드 내 `gemini-2.5-flash`)
- `GEMINI_MODEL_RETRY_LIGHT` (optional: timeout 재시도·짧은 요약 경로)
- `OPENAI_MODEL_THIEL` (코드에서 참조, `.env.example` 반영 필요)
- `OPENAI_MODEL_HOT_TREND` (코드에서 참조, `.env.example` 반영 필요)
- `OPENAI_MONTHLY_MAX_CALLS` (default: `120`)
- `OPENAI_MONTHLY_BUDGET_USD` (default: `10`)
- `OPENAI_BUDGET_ENFORCEMENT` (`on/off`, default: `on`)
- `OPENAI_FALLBACK_TO_GEMINI` (`on/off`, default: `on`)
- `DISCORD_WEBHOOK_URL`
  - 웹훅 전송 경로 사용 시 필요
- `PHASE1_TEST_DISCORD_USER_ID` / `TEST_DISCORD_USER_ID`
  - self-check 스크립트 테스트 대상 사용자 ID

## .env 예시
```dotenv
# Discord
DISCORD_TOKEN=
# DISCORD_BOT_TOKEN=
DISCORD_WEBHOOK_URL=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Gemini
GEMINI_API_KEY=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL_HINDENBURG=gpt-5-mini
OPENAI_MODEL_SIMONS=gpt-5-mini
# OPENAI_MODEL_PERSONA_ANALYSIS=
# OPENAI_MODEL_CIO_DECISION=
# GEMINI_MODEL_SUMMARY=gemini-2.5-flash
# GEMINI_MODEL_RETRY_LIGHT=gemini-2.5-flash
OPENAI_MODEL_THIEL=gpt-5-mini
OPENAI_MODEL_HOT_TREND=gpt-5-mini
OPENAI_MONTHLY_MAX_CALLS=120
OPENAI_MONTHLY_BUDGET_USD=10
OPENAI_BUDGET_ENFORCEMENT=on
OPENAI_FALLBACK_TO_GEMINI=on

# Self-check (optional)
PHASE1_TEST_DISCORD_USER_ID=
TEST_DISCORD_USER_ID=
```

## 민감정보 취급 원칙
- 토큰/키는 평문 로그에 출력하지 않는다.
- 운영 로그에는 키 존재 여부(boolean)만 기록한다.
- 키 교체 시점에는 롤링 재시작 후 인증 상태를 확인한다.

## LLM provider 운영 정책 관련 변수
- OpenAI 우선 페르소나는 `llmProviderService.ts` 정책을 따른다.
- OpenAI 사용 불가 조건(키 누락/예산초과/호출오류)에서는 Gemini로 자동 전환된다.

## 변경 시 필수 문서 동기화
- 환경변수 추가/삭제/기본값 변경 시:
  - `docs/ENVIRONMENT.md`
  - `docs/CHANGELOG.md`
  - `.env.example`
  - 필요 시 `README.md`
