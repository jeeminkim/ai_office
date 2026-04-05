# ai_office

Discord·Node.js·TypeScript·Supabase 기반 투자·포트폴리오 보조 봇. **자동 매매는 하지 않으며**, advisory·그림자 리밸 계획 등은 사용자 확인을 전제로 한다. **금융 위원회**(Ray·Hindenburg·Simons·Drucker·CIO)와 **트렌드·K-culture**(JYP 등) 페르소나는 코드 정책으로 경로가 분리된다(`docs/ARCHITECTURE.md`). 포트폴리오 경량·타임아웃 재시도도 동일 가중치·위원 구성 엔진을 쓰고, 모호한 오픈 토픽은 follow-up으로 관점을 고른다.

## 핵심 기능

- Discord 메인 패널에서 포트폴리오 조회, AI 위원회 토론, 트렌드·오픈 토픽 분석, 데이터 센터 진입
- Gemini / OpenAI 혼합 LLM, 페르소나별 라우팅·예산 가드
- 분석 결과의 claim 추출·저장, 사용자 피드백 및 Phase 2 위원회 의사결정 산출물
- 조기 브로드캐스트 본문과 분리된 **피드백 버튼 follow-up**(동일 `feedback:save:*` 패턴, 봇 메시지)
- 운영 로그 **`AI_PERF`**: 첫 응답까지 `first_visible_latency_ms`, 완료 시 `execution_summary`(실행 시간·프롬프트 조립·병렬·CIO 구간, `standard_compressed` / `aggressive_compressed` 등)
- Phase 2.5 그림자 리밸 실행안(증권사 주문 API 없음; 체결은 사용자 전제)
- 로컬 Control Panel(실행 상태·기동/중지)과 일별 운영 로그

## 기술 스택

- Node.js, TypeScript, Discord.js  
- Supabase(Postgres)  
- Google Gemini, OpenAI(일부 페르소나·작업)

## 빠른 실행

```bash
npm install
npm run build
npm start
```

환경 변수는 루트 `.env`에 두고, 전체 목록은 **[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)** 및 `.env.example`을 본다.

## 필수 환경 변수(요약)

| 변수 | 용도 |
|------|------|
| `DISCORD_TOKEN` **또는** `DISCORD_BOT_TOKEN` | Discord 봇 인증 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | DB 접속 |
| `GEMINI_API_KEY` | Gemini 호출 |

## 운영 시작(한 줄씩)

- 로컬: `npm run build` → `npm start`
- PM2: `pm2 start dist/index.js --name ai-office --interpreter node` — 로그는 `pm2 logs ai-office`
- Control Panel: `npm run build` 후 `npm run control-panel` — 기본 `http://127.0.0.1:7788`
- 배포 전후 점검·로그 경로·장애 대응은 **[docs/OPERATIONS.md](docs/OPERATIONS.md)** · **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**

## 주요 문서

| 문서 | 내용 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 구성, Discord 진입점, 앱·리포지토리·파이프라인, provider, 로깅·헬스 개념, Control Panel 위치 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | PM2, Control Panel, 로그·헬스 파일, self-check, 스케줄러·운영 관점 |
| [docs/DATABASE.md](docs/DATABASE.md) | 테이블 역할, 필수 SQL, 적용 순서, 피드백·ref 매핑 개요 |
| [docs/DISCORD_UX.md](docs/DISCORD_UX.md) | 메인 패널, 피드백·의사결정·follow-up, post-nav, NO_DATA 등 UX |
| [docs/ANALYSIS_PIPELINE.md](docs/ANALYSIS_PIPELINE.md) | 페르소나·포트폴리오/트렌드/오픈토픽 흐름, LLM, claim·피드백, advisory 개요 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | env·Discord·DB·quote·PM2·패널 등 점검 순서 |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | 환경 변수 상세 |
| [docs/TEST_CHECKLIST.md](docs/TEST_CHECKLIST.md) | 배포 전후 테스트 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 변경 이력 |
| [docs/DOCUMENTATION_POLICY.md](docs/DOCUMENTATION_POLICY.md) | 문서 갱신 정책 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 로드맵 |
| [docs/SYSTEM_REVIEW.md](docs/SYSTEM_REVIEW.md) | 구조 리뷰 메모 |

## 문서 정책(요약)

기능·스키마·운영 절차를 바꾸면 **정본(canonical) 문서**와 `docs/CHANGELOG.md`를 갱신한다. 어떤 파일이 정본인지·구 파일명(`SYSTEM_ARCHITECTURE.md` 등)을 수정하지 않는 이유는 **[docs/DOCUMENTATION_POLICY.md](docs/DOCUMENTATION_POLICY.md)** § 문서 정본(canonical)을 본다.

---

상세 설계·운영 절차는 **docs/**를 기준 문서로 하며, README는 빠른 이해와 실행에 집중한다.
