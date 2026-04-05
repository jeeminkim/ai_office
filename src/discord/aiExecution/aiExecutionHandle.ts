import { randomBytes } from 'crypto';
import { logger } from '../../../logger';
import type { PersonaKey } from '../../../analysisTypes';
import type { AiExecutionRoute } from './aiExecutionPolicy';
import { AI_RESPONSE_TIMEOUT_MS } from './aiExecutionPolicy';
import { tryCancelOpenAiResponses } from './openAiResponseCancel';

export type AiTimeoutPhase = 'first_visible' | 'total';

export class AiExecutionHandle {
  readonly executionId: string;
  readonly userId: string;
  readonly route: AiExecutionRoute;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly abortController: AbortController;

  timedOut = false;
  /** 타임아웃 단계 (로그·UX 문구) */
  timeoutPhase: AiTimeoutPhase | null = null;
  /** 첫 유의미 브로드캐스트 이후 first-visible 타이머 해제 */
  firstResponseSent = false;
  firstResponseAt: number | null = null;
  /** 타임아웃 확정 후 만료 플래그(관측·shouldDiscard 강화) */
  expired = false;
  /** 부분 요약을 타임아웃 메시지에 포함한 경우 */
  partialFallbackDelivered = false;

  finalResponseCompleted = false;
  progressNotified = false;
  userVisibleTimeoutMessageSent = false;
  segmentsBroadcast = 0;

  readonly partialSegments: Array<{ persona: string; excerpt: string }> = [];
  private partialByPersona = new Map<string, string>();
  retryPayloadAugment: Record<string, unknown> = {};

  private openAiResponseIds = new Set<string>();
  cancelAttempted = 0;
  cancelSucceeded = 0;
  cancelFailed = 0;

  /** 조기 브로드캐스트(피드백 없음) 후 chat_history 확정 시 별도 follow-up 부착 대기 */
  private pendingFeedbackFollowupKeys = new Set<PersonaKey>();
  /** 피드백 follow-up 전송 완료 또는 스킵(중복 방지) */
  private feedbackFollowupTerminalKeys = new Set<PersonaKey>();

  /** `runPortfolioDebateAppService` 등에서 병합하는 AI_PERF 확장 필드 */
  perfMetrics: Record<string, unknown> = {};

  /**
   * 앱 서비스 진입 후 analysisType이 다른 추론 경로로 덮어쓰이지 않도록 고정한다.
   * (예: 포트폴리오 토론 중 `guessAnalysisTypeFromTrigger` → `open_topic` 차단)
   */
  executionContext?: { routeLocked: boolean; initialRoute: string };

  private clearFirstVisibleTimer: (() => void) | null = null;

  constructor(userId: string, route: AiExecutionRoute) {
    this.executionId = randomBytes(12).toString('hex');
    this.userId = userId;
    this.route = route;
    this.startedAt = Date.now();
    this.deadlineAt = this.startedAt + AI_RESPONSE_TIMEOUT_MS;
    this.abortController = new AbortController();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }

  registerClearFirstVisibleTimer(fn: () => void): void {
    this.clearFirstVisibleTimer = fn;
  }

  recordPartialSegment(personaLabel: string, rawContent: string): void {
    const excerpt = rawContent.trim().slice(0, 1200);
    if (!excerpt) return;
    if (this.partialByPersona.has(personaLabel)) return;
    this.partialByPersona.set(personaLabel, excerpt);
    this.partialSegments.push({ persona: personaLabel, excerpt });
  }

  augmentRetryPayload(data: Record<string, unknown>): void {
    Object.assign(this.retryPayloadAugment, data);
  }

  markFirstResponseSent(): void {
    if (this.firstResponseSent) return;
    this.firstResponseSent = true;
    this.firstResponseAt = Date.now();
    const first_visible_latency_ms = this.firstResponseAt - this.startedAt;
    try {
      this.clearFirstVisibleTimer?.();
    } catch {
      /* ignore */
    }
    this.clearFirstVisibleTimer = null;
    logger.info('AI_EXECUTION', 'firstResponseSentAt', {
      executionId: this.executionId,
      route: this.route,
      firstResponseAt: new Date(this.firstResponseAt).toISOString()
    });
    logger.info('AI_PERF', 'first_visible_latency_ms', {
      executionId: this.executionId,
      route: this.route,
      first_visible_latency_ms,
      partial_fallback_used: this.partialFallbackDelivered
    });
  }

  setPerfMetrics(partial: Record<string, unknown>): void {
    Object.assign(this.perfMetrics, partial);
  }

  /** 최초 한 번만 락을 설정하고 `ROUTE_LOCKED` 로그를 남긴다. */
  lockAnalysisRoute(initialRoute: string): void {
    if (this.executionContext?.routeLocked) return;
    this.executionContext = { routeLocked: true, initialRoute };
    logger.info('ROUTE', 'ROUTE_LOCKED', {
      executionId: this.executionId,
      aiRoute: this.route,
      initialRoute
    });
  }

  /**
   * 락이 걸린 경우 금융 ↔ 오픈토픽 등 교차 덮어쓰기를 막고 `ROUTE_OVERRIDE_BLOCKED`를 남긴다.
   */
  coerceAnalysisRoute(candidate: string): string {
    if (!this.executionContext?.routeLocked) return candidate;
    const init = this.executionContext.initialRoute;
    if (candidate === init) return candidate;

    const portfolioLocked = init.startsWith('portfolio_');
    const openLocked = init.startsWith('open_topic');
    const trendLocked = init.startsWith('trend_');

    if (portfolioLocked && (candidate.startsWith('open_topic') || candidate.startsWith('trend_'))) {
      logger.warn('ROUTE', 'ROUTE_OVERRIDE_BLOCKED', {
        executionId: this.executionId,
        from: init,
        to: candidate
      });
      return init;
    }
    if (openLocked && (candidate.startsWith('portfolio_') || candidate.startsWith('trend_'))) {
      logger.warn('ROUTE', 'ROUTE_OVERRIDE_BLOCKED', {
        executionId: this.executionId,
        from: init,
        to: candidate
      });
      return init;
    }
    if (
      openLocked &&
      init.includes('open_topic_') &&
      candidate.startsWith('open_topic_') &&
      candidate !== init
    ) {
      logger.warn('ROUTE', 'ROUTE_OVERRIDE_BLOCKED', {
        executionId: this.executionId,
        from: init,
        to: candidate
      });
      return init;
    }
    if (trendLocked && (candidate.startsWith('portfolio_') || candidate.startsWith('open_topic'))) {
      logger.warn('ROUTE', 'ROUTE_OVERRIDE_BLOCKED', {
        executionId: this.executionId,
        from: init,
        to: candidate
      });
      return init;
    }
    if (openLocked && candidate === 'open_topic') {
      return init;
    }
    return candidate;
  }

  /** 조기 전송 직후: chat_history 확정 후 피드백 행을 별도 메시지로 붙일 후보 */
  registerPendingFeedbackFollowup(personaKey: PersonaKey): void {
    if (this.feedbackFollowupTerminalKeys.has(personaKey)) return;
    if (this.pendingFeedbackFollowupKeys.has(personaKey)) return;
    this.pendingFeedbackFollowupKeys.add(personaKey);
    logger.info('FEEDBACK', 'FEEDBACK_FOLLOWUP_ATTACH_PENDING', {
      executionId: this.executionId,
      route: this.route,
      personaKey
    });
  }

  getPendingFeedbackFollowupKeys(): PersonaKey[] {
    return [...this.pendingFeedbackFollowupKeys];
  }

  markFeedbackFollowupAttached(personaKey: PersonaKey): void {
    this.pendingFeedbackFollowupKeys.delete(personaKey);
    this.feedbackFollowupTerminalKeys.add(personaKey);
    logger.info('FEEDBACK', 'FEEDBACK_FOLLOWUP_ATTACHED', {
      executionId: this.executionId,
      route: this.route,
      personaKey
    });
  }

  markFeedbackFollowupSkipped(personaKey: PersonaKey, reason: string): void {
    this.pendingFeedbackFollowupKeys.delete(personaKey);
    this.feedbackFollowupTerminalKeys.add(personaKey);
    logger.info('FEEDBACK', 'FEEDBACK_FOLLOWUP_SKIPPED', {
      executionId: this.executionId,
      route: this.route,
      personaKey,
      reason
    });
  }

  /** 게이트/중단 시 대기 중인 피드백 follow-up 일괄 정리 */
  clearAllPendingFeedbackFollowup(reason: string): void {
    for (const pk of [...this.pendingFeedbackFollowupKeys]) {
      this.markFeedbackFollowupSkipped(pk, reason);
    }
  }

  logExecutionPerfSummary(extra?: Record<string, unknown>): void {
    const now = Date.now();
    logger.info('AI_PERF', 'execution_summary', {
      executionId: this.executionId,
      route: this.route,
      total_execution_time_ms: now - this.startedAt,
      first_visible_latency_ms: this.firstResponseAt != null ? this.firstResponseAt - this.startedAt : null,
      partial_fallback_used: this.partialFallbackDelivered,
      ...this.perfMetrics,
      ...extra
    });
  }

  markPartialFallbackUsed(meta: { partialResultCount: number; timeoutPhase: AiTimeoutPhase }): void {
    this.partialFallbackDelivered = true;
    logger.info('AI_EXECUTION', 'partialFallbackUsed', {
      executionId: this.executionId,
      route: this.route,
      partialResultCount: meta.partialResultCount,
      timeoutPhase: meta.timeoutPhase
    });
  }

  shouldDiscardOutgoing(): boolean {
    return this.timedOut || this.expired || this.signal.aborted;
  }

  registerOpenAiResponseId(id: string | undefined | null): void {
    if (id && typeof id === 'string') this.openAiResponseIds.add(id);
  }

  markTimedOut(phase: AiTimeoutPhase): void {
    if (this.timedOut) return;
    this.timeoutPhase = phase;
    this.timedOut = true;
    this.expired = true;
    try {
      this.clearFirstVisibleTimer?.();
    } catch {
      /* ignore */
    }
    this.clearFirstVisibleTimer = null;
    try {
      this.abortController.abort();
    } catch {
      // ignore
    }
    logger.warn('AI_EXECUTION', 'AI_EXECUTION_TIMEOUT', {
      executionId: this.executionId,
      userId: this.userId,
      route: this.route,
      timeoutPhase: phase,
      firstVisibleTimeoutTriggered: phase === 'first_visible',
      startedAt: new Date(this.startedAt).toISOString(),
      timeoutAt: new Date(this.deadlineAt).toISOString(),
      segmentsBroadcast: this.segmentsBroadcast,
      openAiResponseCount: this.openAiResponseIds.size,
      partialResultCount: this.partialSegments.length,
      firstResponseSent: this.firstResponseSent
    });
  }

  markProgressNotified(): void {
    this.progressNotified = true;
  }

  markSegmentBroadcast(): void {
    this.segmentsBroadcast += 1;
  }

  markFinalPipelineComplete(): void {
    this.finalResponseCompleted = true;
  }

  async attemptProviderCancels(): Promise<void> {
    const ids = [...this.openAiResponseIds];
    if (!ids.length) {
      logger.info('AI_EXECUTION', 'AI_EXECUTION_CANCEL_ATTEMPTED', {
        executionId: this.executionId,
        route: this.route,
        cancelSupported: false,
        reason: 'no_openai_response_ids'
      });
      return;
    }
    for (const id of ids) {
      this.cancelAttempted += 1;
      logger.info('AI_EXECUTION', 'AI_EXECUTION_CANCEL_ATTEMPTED', {
        executionId: this.executionId,
        route: this.route,
        cancelSupported: true,
        responseId: id
      });
      const r = await tryCancelOpenAiResponses(id);
      if (r === 'ok') {
        this.cancelSucceeded += 1;
        logger.info('AI_EXECUTION', 'openai_response_cancel_ok', { executionId: this.executionId, responseId: id });
      } else if (r === 'unavailable') {
        logger.warn('AI_EXECUTION', 'AI_EXECUTION_CANCEL_FAILED', {
          executionId: this.executionId,
          responseId: id,
          reason: 'cancel_unavailable_or_no_sdk'
        });
        this.cancelFailed += 1;
      } else {
        logger.warn('AI_EXECUTION', 'AI_EXECUTION_CANCEL_FAILED', {
          executionId: this.executionId,
          responseId: id,
          reason: 'cancel_api_error'
        });
        this.cancelFailed += 1;
      }
    }
  }

  logResultDiscarded(reason: string, meta?: Record<string, unknown>): void {
    logger.warn('AI_EXECUTION', 'AI_EXECUTION_RESULT_DISCARDED_AFTER_TIMEOUT', {
      executionId: this.executionId,
      userId: this.userId,
      route: this.route,
      reason,
      timedOut: this.timedOut,
      expired: this.expired,
      aborted: this.signal.aborted,
      partialFallbackDelivered: this.partialFallbackDelivered,
      ...meta
    });
  }
}

export function createAiExecutionHandle(userId: string, route: AiExecutionRoute): AiExecutionHandle {
  return new AiExecutionHandle(userId, route);
}
