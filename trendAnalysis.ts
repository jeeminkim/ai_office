import * as dotenv from 'dotenv';
import { logger } from './logger';
import { generateGeminiResponse } from './geminiLlmService';

dotenv.config();

export type TrendTopicKind = 'kpop' | 'drama' | 'sports' | 'hot' | 'free';

const TREND_ISOLATION = `
[TREND_ONLY — 반드시 준수]
- 사용자 포트폴리오·보유종목·비중·자산배분·손익·리밸런싱·개인 투자 실행을 언급하거나 가정하지 마라.
- 이번 답변에는 앵커된 개인 재무 데이터가 없으며, 오직 아래 질문의 **주제 분야**만 분석한다.
- 산업·콘텐츠·플랫폼·소비자 반응·성장성·이슈·리스크 중심으로 서술한다.
- 필요 시 응답 **말미**에 "## 투자 관점 시사점"을 짧게 추가할 수 있다(테마·구조 일반론만). 특정 종목·ETF·비중·매매 지시는 금지.

[OUTPUT]
- 간결한 마크다운, 소제목 활용.
`;

export type TrendPersonaConfig = {
  personaKey: string;
  agentLabel: string;
  avatarUrl: string;
  systemPrompt: string;
};

const JYP_AVATAR = 'https://upload.wikimedia.org/wikipedia/commons/4/44/Park_Jin-young_at_WCG_2020.png';
const MEDIA_AVATAR = 'https://upload.wikimedia.org/wikipedia/commons/6/6d/Video-Icon-cropped.svg';
const SPORTS_AVATAR = 'https://upload.wikimedia.org/wikipedia/commons/0/0e/Sport_balls.svg';
const TREND_AVATAR = 'https://upload.wikimedia.org/wikipedia/commons/e/ef/System_Preferences_icon_Apple.png';

export const TREND_TOPIC_CONFIG: Record<TrendTopicKind, TrendPersonaConfig> = {
  kpop: {
    personaKey: 'JYP',
    agentLabel: 'JYP (K-Pop · K-Culture)',
    avatarUrl: JYP_AVATAR,
    systemPrompt: `${TREND_ISOLATION}
# 역할: K-pop · K-culture 산업 분석가
음원·공연·팬덤·글로벌 확산·라이선스·IP, 주요 레이블/플랫폼 이슈를 전문적으로 다룬다.
소비 트렌드와 콘텐츠 사이클을 데이터 없이도 업계 상식과 구조적 논리로 분석한다.`
  },
  drama: {
    personaKey: 'KIM_EUNHEE',
    agentLabel: '김은희 · 드라마/OTT 리서처',
    avatarUrl: MEDIA_AVATAR,
    systemPrompt: `${TREND_ISOLATION}
# 역할: 김은희 스타일의 드라마/OTT 산업 리서처
플랫폼 경쟁, 제작·유통, 시청 행태, 글로벌 확산, 수익 모델, 규제·이슈를 중심으로 구조적으로 분석한다.`
  },
  sports: {
    personaKey: 'SON_HEUNGMIN',
    agentLabel: '손흥민 · 스포츠 비즈니스 분석',
    avatarUrl: SPORTS_AVATAR,
    systemPrompt: `${TREND_ISOLATION}
# 역할: 손흥민 시각의 스포츠 비즈니스 분석가
리그·미디어 권리·스폰서·팬 경제·글로벌 스포츠 시장 구조·수익원·최근 이슈를 중심으로 분석한다.
개인의 스포츠 베팅·종목 추천은 하지 않는다.`
  },
  hot: {
    personaKey: 'JEON_HYEONGMU',
    agentLabel: '전현무 · 핫 트렌드 분석',
    avatarUrl: TREND_AVATAR,
    systemPrompt: `${TREND_ISOLATION}
# 역할: 전현무 시각의 광의 핫 트렌드/소비 트렌드 분석가
지금 떠오르는 현상의 배경, 미디어·SNS·소비자 심리, 산업 간 파급, 지속 가능성을 중심으로 분석한다.`
  },
  free: {
    personaKey: 'TREND_ANALYST',
    agentLabel: '트렌드 · 주제 분석가',
    avatarUrl: TREND_AVATAR,
    systemPrompt: `${TREND_ISOLATION}
# 역할: 사용자가 제시한 주제에 맞춘 트렌드/산업 분석가
질문 범위를 벗어난 개인 자산 조언은 하지 않는다.`
  }
};

export function trendTopicFromCustomId(customId: string): TrendTopicKind | null {
  const map: Record<string, TrendTopicKind> = {
    'panel:trend:kpop': 'kpop',
    'panel:trend:drama': 'drama',
    'panel:trend:sports': 'sports',
    'panel:trend:hot': 'hot',
    'modal:trend:free': 'free'
  };
  return map[customId] ?? null;
}

export async function generateTrendSpecialistResponse(topic: TrendTopicKind, userQuery: string): Promise<string> {
  const cfg = TREND_TOPIC_CONFIG[topic];
  const contents = `${cfg.systemPrompt}\n\n[질문/요청]\n${userQuery}`;

  try {
    const response = await generateGeminiResponse({
      model: 'gemini-2.5-flash',
      prompt: contents
    });
    return response.text || '';
  } catch (e: any) {
    logger.error('TREND', 'trend Gemini API error', { message: e?.message });
    throw e;
  }
}
