import { randomUUID } from 'crypto';
import { logger } from '../../logger';
import { repoSupabase } from './supabaseClient';

export type TimeoutRetryPayloadV1 = {
  v: 1;
  userId: string;
  userQuery: string;
  route: string;
  triggerCustomId?: string;
  topic?: string;
  analysisType?: string;
  portfolioSnapshot?: {
    positionCount?: number;
    totalMarketValueKrw?: number;
    degradedQuoteMode?: boolean;
    quoteFailureCount?: number;
  } | null;
};

type MemoryRow = {
  payload: TimeoutRetryPayloadV1;
  discordUserId: string;
  expiresAtMs: number;
};

const memorySnapshots = new Map<string, MemoryRow>();

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function saveTimeoutRetrySnapshot(params: {
  discordUserId: string;
  executionId: string;
  analysisType: string;
  payload: TimeoutRetryPayloadV1;
  ttlMs?: number;
}): Promise<{ id: string; source: 'db' | 'memory' }> {
  const id = randomUUID();
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  const insertRow = {
    id,
    discord_user_id: params.discordUserId,
    execution_id: params.executionId,
    analysis_type: params.analysisType,
    payload: params.payload as unknown as Record<string, unknown>,
    expires_at: expiresAt.toISOString()
  };

  try {
    const { error } = await repoSupabase.from('timeout_retry_snapshots').insert(insertRow);
    if (error) throw error;
    logger.info('AI_EXECUTION', 'retrySnapshotSaved', {
      snapshotId: id,
      source: 'db',
      executionId: params.executionId,
      route: params.payload.route
    });
    return { id, source: 'db' };
  } catch (e: unknown) {
    memorySnapshots.set(id, {
      payload: params.payload,
      discordUserId: params.discordUserId,
      expiresAtMs: expiresAt.getTime()
    });
    logger.warn('AI_EXECUTION', 'retrySnapshotSaved', {
      snapshotId: id,
      source: 'memory',
      executionId: params.executionId,
      message: e instanceof Error ? e.message : String(e)
    });
    return { id, source: 'memory' };
  }
}

export async function consumeTimeoutRetrySnapshot(
  id: string,
  discordUserId: string
): Promise<TimeoutRetryPayloadV1 | null> {
  if (isUuid(id)) {
    try {
      const { data: row, error } = await repoSupabase
        .from('timeout_retry_snapshots')
        .select('id, discord_user_id, payload, expires_at')
        .eq('id', id)
        .maybeSingle();

      if (error) throw error;

      if (row) {
        if (row.discord_user_id !== discordUserId) {
          logger.warn('AI_EXECUTION', 'retrySnapshotLoaded', { snapshotId: id, denied: 'user_mismatch' });
          return null;
        }
        if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
          await repoSupabase.from('timeout_retry_snapshots').delete().eq('id', id);
          logger.warn('AI_EXECUTION', 'retrySnapshotLoaded', { snapshotId: id, denied: 'expired' });
          return null;
        }
        await repoSupabase.from('timeout_retry_snapshots').delete().eq('id', id).eq('discord_user_id', discordUserId);
        logger.info('AI_EXECUTION', 'retrySnapshotLoaded', { snapshotId: id, source: 'db' });
        return row.payload as TimeoutRetryPayloadV1;
      }
    } catch (e: unknown) {
      logger.warn('AI_EXECUTION', 'retrySnapshotLoaded', {
        snapshotId: id,
        source: 'db_error',
        message: e instanceof Error ? e.message : String(e)
      });
    }

    const mem = memorySnapshots.get(id);
    if (!mem) return null;
    if (mem.discordUserId !== discordUserId) {
      memorySnapshots.delete(id);
      return null;
    }
    if (Date.now() > mem.expiresAtMs) {
      memorySnapshots.delete(id);
      return null;
    }
    memorySnapshots.delete(id);
    logger.info('AI_EXECUTION', 'retrySnapshotLoaded', { snapshotId: id, source: 'memory' });
    return mem.payload;
  }

  return null;
}

export async function releaseTimeoutRetrySnapshot(id: string, discordUserId: string): Promise<void> {
  if (!isUuid(id)) return;
  try {
    await repoSupabase.from('timeout_retry_snapshots').delete().eq('id', id).eq('discord_user_id', discordUserId);
  } catch {
    /* best-effort */
  }
  memorySnapshots.delete(id);
}

export { isUuid };
