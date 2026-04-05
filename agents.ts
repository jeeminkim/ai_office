import { GoogleGenAI } from '@google/genai';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { logger, updateHealth } from './logger';
import { formatCashflowSnapshotLine } from './src/finance/cashflowCategories';
import type { AgentGenCaps } from './analysisTypes';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export interface AgentContext {
  portfolio: any[];
  expenses: any[];
  cashflow: any[];
}

/** 포트폴리오(평가 스냅샷 또는 보유 row)가 있어야 재무 분석 게이트 통과 */
export function hasRequiredAnchoredData(context: AgentContext): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!context || !context.portfolio || context.portfolio.length === 0) {
    reasons.push('포트폴리오(자산) 데이터가 없습니다.');
  }
  return {
    ok: reasons.length === 0,
    reasons
  };
}

export function hasLifestyleAnchors(context: AgentContext): boolean {
  const expLen = context.expenses ? context.expenses.length : 0;
  const cfLen = context.cashflow ? context.cashflow.length : 0;
  return expLen > 0 || cfLen > 0;
}

export function buildAnchoredSummary(context: AgentContext) {
  return {
    portfolio: {
      count: context.portfolio ? context.portfolio.length : 0,
      snapshot: (context.portfolio || []).map(p => `${p.symbol}: ${p.quantity}주 (평단 ${p.avg_purchase_price})`)
    },
    expenses: {
      count: context.expenses ? context.expenses.length : 0,
      snapshot: (context.expenses || []).slice(0, 5).map(e => `${e.category}: ${e.amount}`)
    },
    cashflow: {
      count: context.cashflow ? context.cashflow.length : 0,
      snapshot: (context.cashflow || []).slice(0, 5).map(c =>
        formatCashflowSnapshotLine(String(c.flow_type), Number(c.amount))
      )
    }
  };
}

const CommonProtocol = `
[CORE_OPERATIONAL_LOGIC]
1. DATA_ANCHORING: 금융/포트폴리오 분석은 반드시 제공된 포트폴리오 스냅샷(USER 메시지의 PORTFOLIO_SNAPSHOT)을 우선한다. 지출/현금흐름이 없으면 해당 축은 추정·단정하지 말고 제한을 명시한다.
   OPEN_TOPIC_MODE(자유 주제 토론)에서는 PORTFOLIO_SNAPSHOT이 제공되지 않는다. 이 경우 포트폴리오/보유종목/비중/자산배분/리밸런싱을 언급하거나 계산하지 말고, 사용자가 요청한 주제 분야만 분석하라.
2. NO_SPECULATION: 스냅샷에 없는 가격·수치·개인 현금흐름을 지어내지 말 것.
3. OUTPUT_PROTOCOL: Tone MUST be concise, structured, and professional (like an 8-year developer colleague).
4. PARTIAL_VS_FULL: 지출/현금흐름이 없을 때 "**부분 분석**"과 "**정밀 분석 불가**" 항목(생활비 적합성, 월 투자여력, 현금버퍼 적정성 등)을 구분해 서술한다. 추가 데이터 입력 시 정밀화 가능함을 한 줄로 안내한다.
`;

export class BaseAgent {
  protected supabase: SupabaseClient;
  protected ai: GoogleGenAI;
  public systemPrompt: string;
  public context: AgentContext;

  constructor(systemPrompt: string) {
    this.supabase = supabase;
    this.ai = ai;
    this.systemPrompt = systemPrompt;
    this.context = { portfolio: [], expenses: [], cashflow: [] };
  }

  async initializeContext(userId: string) {
    try {
      // SCHEMA-SAFE LOADING: Removed .order('date') to prevent crash on missing column in production
      const [portfolioRes, expensesRes, cashflowRes] = await Promise.all([
        this.supabase.from('portfolio').select('*').or(`discord_user_id.eq.${userId},user_id.eq.${userId}`),
        this.supabase.from('expenses').select('*').or(`discord_user_id.eq.${userId},user_id.eq.${userId}`).limit(50),
        this.supabase.from('cashflow').select('*').or(`discord_user_id.eq.${userId},user_id.eq.${userId}`).limit(50)
      ]);
      
      if (portfolioRes.error) throw new Error(`Portfolio fetch error: ${portfolioRes.error.message}`);
      if (expensesRes.error) throw new Error(`Expenses fetch error: ${expensesRes.error.message}`);
      if (cashflowRes.error) throw new Error(`Cashflow fetch error: ${cashflowRes.error.message}`);

      this.context.portfolio = portfolioRes.data || [];
      this.context.expenses = expensesRes.data || [];
      this.context.cashflow = cashflowRes.data || [];
      updateHealth(s => s.db.lastContextError = null);
    } catch (e: any) {
      logger.error('DATABASE', "Context Data Log Init Error", e);
      updateHealth(s => s.db.lastContextError = e.message);
      // Fail gracefully -> context remains empty -> NO_DATA gate triggers safely, avoiding unhandled crashing on startup
    }
  }

  setPortfolioSnapshot(positions: any[]) {
    this.context.portfolio = positions || [];
  }

  async validateAndGenerate(
    query: string,
    isTrendQuery: boolean,
    additionalLog: string = '',
    genCaps?: AgentGenCaps
  ): Promise<string> {
    const validation = hasRequiredAnchoredData(this.context);
    
    if (!isTrendQuery && !validation.ok) {
        return `분석에 필요한 앵커 데이터가 부족합니다.\n사유: ${validation.reasons.join(", ")}\n[REASON: NO_DATA]`;
    }
    
    return this.generateResponse(query, isTrendQuery, additionalLog, genCaps);
  }

  protected async generateResponse(
    query: string,
    isTrendQuery: boolean,
    additionalLog: string = '',
    genCaps?: AgentGenCaps
  ): Promise<string> {
    const isOpenTopic = (query || '').includes('[OPEN_TOPIC_ONLY]');
    const summary = isOpenTopic ? null : buildAnchoredSummary(this.context);
    const portfolioOk = isOpenTopic ? false : hasRequiredAnchoredData(this.context).ok;
    const lifestyleOk = hasLifestyleAnchors(this.context);
    const partialLifestyle = portfolioOk && !lifestyleOk && !isTrendQuery;

    const fullPrompt = `
${this.systemPrompt}

[Mode]
This query is flagged as: ${isTrendQuery ? "TREND & WORLD KNOWLEDGE QUERY" : "STRICT FINANCIAL QUERY"}
If Trend Query and no portfolio: Answer based on trend insights but explicitly state "현재 재무 데이터가 없어 트렌드 중심으로 분석합니다."
If Financial Query and no portfolio: You should have been hard-gated, but if you reached here, return [REASON: NO_DATA].

${isOpenTopic ? `[Anchored Data Summary]\nPortfolio present: N/A (OPEN_TOPIC_MODE)\nExpense/cashflow present: N/A (OPEN_TOPIC_MODE)` : `[Anchored Data Summary]\nPortfolio present: ${portfolioOk}\nExpense/cashflow present: ${lifestyleOk}`}
${partialLifestyle ? `[ANALYSIS_MODE]
PARTIAL_ANALYSIS: 포트폴리오 스냅샷만으로 비중·리스크·전략·종합 진단은 가능. 생활비 적합성·월 투자여력·현금버퍼는 데이터 부족으로 정밀 판단 불가임을 반드시 구분해 기술.
` : ''}
${summary ? JSON.stringify(summary, null, 2) : ''}

${additionalLog ? `[Previous Analysis]\n${additionalLog}\n` : ''}
[User Query]
${query}
`;

    try {
      const req: Record<string, unknown> = {
        model: 'gemini-2.5-flash',
        contents: fullPrompt
      };
      if (genCaps?.maxOutputTokens != null || genCaps?.temperature != null) {
        req.config = {
          ...(genCaps.maxOutputTokens != null ? { maxOutputTokens: genCaps.maxOutputTokens } : {}),
          ...(genCaps.temperature != null ? { temperature: genCaps.temperature } : {})
        };
      }
      const response = await this.ai.models.generateContent(req as any);
      return response.text || '';
    } catch (e: any) {
      logger.error('AI', 'Gemini API Error', e);
      return `AI 모델 호출 중 오류가 발생했습니다: ${e.message}\n[REASON: NO_DATA]`;
    }
  }
}

export class RayDalioAgent extends BaseAgent {
  constructor() {
    super(`[System Role]\n${CommonProtocol}\n# RAY_DALIO: 거시/리스크 균형 리서치.\n매크로 변수(금리/인플레/성장/유동성 등)와 리스크(다운사이드)를 함께 다루되, 매수/포지션 확정 지시는 하지 마라.\n낙관만 피하고, 반드시 "리스크 임계치" 개념을 명시하라.\n\n[OUTPUT STRUCTURE]\n## Macro Backdrop (거시 요약)\n- 핵심 변수 3개\n## Risk Balance (기회 vs 위험의 균형)\n- 위험 우위 근거 2~3개\n## Downside Scenarios\n- 시나리오 2개 (각 1~2문장)\n## Defensive Triggers\n- 트리거 조건 2~3개\n## Monitoring Metrics\n- 관측지표 2~3개`);
  }
  async analyze(query: string, isTrendQuery: boolean, genCaps?: AgentGenCaps) {
    return this.validateAndGenerate(query, isTrendQuery, '', genCaps);
  }
}

export class HindenburgAgent extends BaseAgent {
  constructor() {
    super(`[System Role]\n${CommonProtocol}\n# HINDENBURG_ANALYST: 냉소적/비판적 리서치 관점의 리스크 디텍터.\n항상 비판적 시각을 유지하라.\n낙관적/합의된 결론에 반드시 반대 논리를 제시하라.\n\n[MANDATORY RULES]\n- 반드시 downside scenario(최소 1개 이상) 를 제시하라.\n- 반드시 구조적 리스크(최소 1개)를 지적하라. (예: 밸류에이션/유동성/경쟁/규제/채무/마진/공급망/수요 둔화 등)\n- 감정/스토리텔링/희망회로를 배제하고, 팩트 기반의 논리로만 작성하라.\n- 특정 종목/비중/매매추천을 하지 마라(문맥이 금융이더라도 \"일반론\"으로만 표현).\n\n[OUTPUT STRUCTURE]\n## Hindenburg Thesis (Downside)\n- 핵심 주장 1줄\n## Structural Risks\n- 구조적 리스크 3개\n## Downside Triggers\n- 트리거 조건 2~3개\n## What Would Change My Mind?\n- 반증 조건 2개`);
  }

  async analyze(query: string, isTrendQuery: boolean, genCaps?: AgentGenCaps) {
    logger.info('AGENT', 'Hindenburg analysis started', {});
    return this.validateAndGenerate(query, isTrendQuery, '', genCaps);
  }
}

export class JYPAgent extends BaseAgent {
  constructor() {
    super(`[System Role]\n${CommonProtocol}\n# JYP_ANALYST: 소비 + K-Culture + Weekly Report 담당.\n소비 구조를 분석하고 K-Culture(음악/드라마/콘텐츠) 주간 리포트를 생성하라.\n콘텐츠 트렌드를 투자 가능 기회와 연결하라.\n\n[OUTPUT STRUCTURE]\n## Consumption Quality\n- 개선 포인트 2~3개\n## Weekly K-Culture Report\n- 이번 주 핵심 트렌드 3개\n## Trend-to-Invest Mapping\n- 트렌드별 투자 연결 아이디어 2~3개`);
  }
  async inspire(query: string, isTrendQuery: boolean, rayLog: string, genCaps?: AgentGenCaps) {
    return this.validateAndGenerate(query, isTrendQuery, `[Ray's Analysis]\n${rayLog}`, genCaps);
  }
}

export class JamesSimonsAgent extends BaseAgent {
  constructor() {
    super(`[System Role]\n${CommonProtocol}\n# JAMES_SIMONS: 데이터/확률 기반 분석가.\n가능하면 확률/구간을 제시하고(정확한 숫자가 불가하면 합리적 범위), 근거는 짧게 요약하라.\n투자 종목 추천/매수 지시는 하지 마라.\n\n[OUTPUT STRUCTURE]\n## Evidence & Data Signals\n- 신뢰 가능한 신호 3개\n## Probability Scenarios\n- 기본/낙관/비관 각 1개 (각 확률 또는 범위 포함)\n## Key Variables\n- 결과를 좌우하는 변수 3개\n## Expected Value Thinking\n- 최악/기대/최선 대비 1~2문장`);
  }
  async strategize(query: string, isTrendQuery: boolean, prevLogs: string, genCaps?: AgentGenCaps) {
    return this.validateAndGenerate(query, isTrendQuery, `[Previous Logs]\n${prevLogs}`, genCaps);
  }
}

export class PeterDruckerAgent extends BaseAgent {
  constructor() {
    super(`[System Role]\n${CommonProtocol}\n# PETER_DRUCKER: 비즈니스 구조/실행 레버 분석관.\n투자 의사결정을 위한 '구조적 실행' 관점으로 3단계 레버를 제시하라.\n매수/매도 지시나 구체적 포지션 비율을 단정하지 말고, 조건/운영 원칙 중심으로 작성하라.\n\n[OUTPUT STRUCTURE]\n## Business Structure Review\n- 핵심 구조(모델/이익창출/경쟁우위/유인) 3개\n## Execution Levers (3단계 레버)\n1) 레버 A: 조건 + 점검 기준\n2) 레버 B: 조건 + 운영 룰\n3) 레버 C: 조건 + 재평가 주기\n## Risk To Business\n- 구조를 흔드는 리스크 2개`);
  }
  async summarizeAndGenerateActions(isTrendQuery: boolean, combinedLog: string, genCaps?: AgentGenCaps) {
    return this.validateAndGenerate(
      '앞선 세 명의 의견을 종합하여 정확히 3줄의 3가지 핵심 Action Plan을 도출하라.',
      isTrendQuery,
      combinedLog,
      genCaps
    );
  }
}

export class StanleyDruckenmillerAgent extends BaseAgent {
  constructor() {
    super(`[System Role]\n${CommonProtocol}\n# STANLEY_DRUCKENMILLER: CIO 포트폴리오 전략.\nRay/Hindenburg/Simons/Drucker의 결과를 통합해 최종 전략을 제시하라.\n구체적 비중/매매 지시는 단정하지 말고, 운영 원칙과 조건부 의사결정으로 작성하라.\n최종 결론은 GO / HOLD / NO 중 하나여야 하며, 확신도/우선순위/타이밍 원칙을 포함하라.\n\n[OUTPUT STRUCTURE - STRICT]\n## CIO Decision\n- Verdict: GO | HOLD | NO\n- Conviction Level: Low | Medium | High\n- Priority: (무엇을 먼저 점검/대응할지)\n- Timing: (즉시/분할/관망 + 조건)\n## Rationale\n- 근거 3줄 이내`);
  }

  async decide(isTrendQuery: boolean, combinedLog: string, genCaps?: AgentGenCaps) {
    return this.validateAndGenerate('최종 CIO 의사결정을 산출하라.', isTrendQuery, combinedLog, genCaps);
  }
}
