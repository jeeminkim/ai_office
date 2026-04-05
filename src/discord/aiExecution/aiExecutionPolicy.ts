/** 전체 분석 상한(시작 시각 기준) */
export const AI_RESPONSE_TIMEOUT_MS = 300_000;

/** 첫 유의미 브로드캐스트(페르소나 본문 등) 없을 때 조기 중단 */
export const FIRST_VISIBLE_TIMEOUT_MS = 90_000;

/** 주기적 진행 힌트(선택). Discord 메시지 편집 간격 */
export const HEARTBEAT_PROGRESS_MS = 30_000;

/** “길어지고 있습니다” 소프트 안내 시각 */
export const SOFT_PROGRESS_NOTICE_MS = 75_000;

export type AiExecutionRoute = 'portfolio' | 'trend' | 'open_topic' | 'followup' | 'unknown';

/** timeout 후 재시도 버튼에서 사용 */
export type AiTimeoutRetryKind = 'light' | 'summary' | 'menu';

export type PendingTimeoutRetryPayload = {
  userId: string;
  userQuery: string;
  route: AiExecutionRoute;
  /** portfolio / modal 트리거 복원 */
  triggerCustomId?: string;
  /** trend 전용 */
  topic?: import('../../../trendAnalysis').TrendTopicKind | 'free';
  createdAt: number;
};

const PENDING_TTL_MS = 60 * 60 * 1000;

const pending = new Map<string, PendingTimeoutRetryPayload>();

export function registerPendingTimeoutRetry(executionId: string, payload: Omit<PendingTimeoutRetryPayload, 'createdAt'>): void {
  pending.set(executionId, { ...payload, createdAt: Date.now() });
}

export function takePendingTimeoutRetry(executionId: string): PendingTimeoutRetryPayload | null {
  const row = pending.get(executionId);
  if (!row) return null;
  if (Date.now() - row.createdAt > PENDING_TTL_MS) {
    pending.delete(executionId);
    return null;
  }
  pending.delete(executionId);
  return row;
}

export function peekPendingTimeoutRetry(executionId: string): PendingTimeoutRetryPayload | null {
  const row = pending.get(executionId);
  if (!row) return null;
  if (Date.now() - row.createdAt > PENDING_TTL_MS) {
    pending.delete(executionId);
    return null;
  }
  return row;
}
