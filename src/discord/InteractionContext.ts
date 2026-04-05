import type { Client, WebhookClient } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger, updateHealth } from '../../logger';
import type { PanelAdapter } from './adapters/panelAdapter';
import type { PortfolioInteractionDeps, PortfolioModalDeps } from '../interactions/portfolioInteractionHandler';
import type { TrendTopicKind } from '../../trendAnalysis';

export type OfficeLogger = typeof logger;
export type UpdateHealthFn = typeof updateHealth;

export type UserRiskMode = 'SAFE' | 'BALANCED' | 'AGGRESSIVE';

export type PortfolioDebateFastMode = 'none' | 'light_summary' | 'short_summary' | 'retry_summary';
export type OpenTopicDebateFastMode = 'none' | 'light_summary' | 'short_summary';
export type TrendAnalysisFastMode = 'none' | 'short';

/** runPortfolioDebate / runOpenTopic / runTrend 등 index에 남은 오케스트레이션 (자동 주문 없음). */
export type InteractionRuntimeBundle = {
  runTrendAnalysis: (
    userId: string,
    userQuery: string,
    sourceInteraction: any,
    topic: TrendTopicKind | 'free',
    triggerCustomId?: string,
    opts?: { fastMode?: TrendAnalysisFastMode }
  ) => Promise<void>;
  runPortfolioDebate: (
    userId: string,
    userQuery: string,
    sourceInteraction: any,
    opts?: { fastMode?: PortfolioDebateFastMode }
  ) => Promise<void>;
  runOpenTopicDebate: (
    userId: string,
    userQuery: string,
    sourceInteraction: any,
    opts?: { fastMode?: OpenTopicDebateFastMode; forcedOpenTopicView?: 'financial' | 'trend' | 'general' }
  ) => Promise<void>;
  runDataCenterAction: (
    userId: string,
    action: 'daily_log_analysis' | 'system_improvement_suggestion',
    sourceInteraction?: any
  ) => Promise<void>;
};

/**
 * interaction 핸들러에 공통으로 넘기는 최소 컨텍스트.
 * index 전역을 무분별하게 옮기지 않고, defer/edit·클라이언트·런처만 노출한다.
 */
export type DiscordInteractionContext = {
  logger: OfficeLogger;
  supabase: SupabaseClient;
  client: Client;
  webhook: WebhookClient;
  updateHealth: UpdateHealthFn;
  getDiscordUserId: (user: { id: string }) => string;
  interactions: {
    safeDeferReply: (interaction: any, options?: Record<string, unknown>) => Promise<boolean>;
    safeEditReply: (interaction: any, content: string, context: string) => Promise<void>;
    safeReplyOrFollowUp: (interaction: any, payload: Record<string, unknown>, context: string) => Promise<void>;
    safeUpdate: (interaction: any, payload: Record<string, unknown>, context: string) => Promise<void>;
    safeEditReplyPayload: (interaction: any, payload: Record<string, unknown>, context: string) => Promise<void>;
    safeDeferUpdate: (interaction: any) => Promise<boolean>;
    ensureInteractionDeferred: (interaction: any, mode: 'reply' | 'update') => Promise<boolean>;
    safeSendChunkedInteractionContent: (interaction: any, payload: Record<string, unknown>, context: string) => Promise<void>;
  };
  panel: PanelAdapter;
  runtime: InteractionRuntimeBundle;
  portfolio: {
    interactionDeps: PortfolioInteractionDeps;
    modalDeps: PortfolioModalDeps;
  };
  settings: {
    loadUserMode: (discordUserId: string) => Promise<UserRiskMode>;
    saveUserMode: (discordUserId: string, mode: UserRiskMode) => Promise<void>;
  };
};
