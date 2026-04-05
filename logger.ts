import fs from 'fs';
import path from 'path';
import { DAILY_DIR, HEALTH_FILE, LOG_DIR, dailyLogPath, ensureLogDirs, getKstDateKey } from './loggingPaths';

export { getKstDateKey, LOG_DIR, DAILY_DIR, dailyLogPath, HEALTH_FILE } from './loggingPaths';

/** 일별 파일 + 보존 기간(일). env: OFFICE_LOG_RETENTION_DAYS */
export const LOG_RETENTION_DAYS = Math.min(
  90,
  Math.max(1, parseInt(process.env.OFFICE_LOG_RETENTION_DAYS || '14', 10) || 14)
);

const LOG_DEBUG_ENABLED = process.env.LOG_DEBUG === '1' || process.env.LOG_DEBUG === 'true';

/** INTERACTION / UX 등 고빈도 INFO는 메인 runtime 일별 파일에 쓰지 않음(카테고리 로그만). env LOG_VERBOSE_RUNTIME=1 이면 쓰기 */
const VERBOSE_MAIN_RUNTIME =
  process.env.LOG_VERBOSE_RUNTIME === '1' || process.env.LOG_VERBOSE_RUNTIME === 'true';

const SUPPRESS_MS = Math.min(120_000, Math.max(1000, parseInt(process.env.LOG_SUPPRESS_WINDOW_MS || '10000', 10) || 10000));

ensureLogDirs();

export function resolveLogCategory(scope: string): string {
  const s = String(scope || '').toUpperCase();
  if (s === 'OPENAI' || s === 'OPENAI_BUDGET') return 'openai';
  if (s === 'QUOTE' || s === 'QUOTE_RESOLUTION' || s === 'FX') return 'quote';
  if (s === 'INTERACTION' || s === 'DISCORD' || s === 'UX') return 'interaction';
  if (s === 'DB' || s === 'SNAPSHOT' || s === 'CLAIMS' || s === 'MEMORY' || s === 'TRACE') return 'db';
  if (s === 'PORTFOLIO' || s === 'ACCOUNT') return 'portfolio';
  if (s === 'BOOT' || s === 'ENV') return 'boot';
  if (s === 'LLM_PROVIDER' || s === 'GEMINI' || s === 'QUALITY') return 'llm';
  return 'runtime';
}

function appendCategoryFileLog(level: string, scope: string, logLine: string): void {
  try {
    const category = resolveLogCategory(scope);
    const dateKey = getKstDateKey();
    const dir = path.join(LOG_DIR, category);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${category}.log_${dateKey}`);
    fs.appendFileSync(file, logLine);
  } catch (e: any) {
    try {
      const fallbackLine = `[${new Date().toISOString()}] [WARN] [LOGGER] category sink failed | ${JSON.stringify({
        level,
        scope,
        message: e?.message || String(e)
      })}\n`;
      fs.appendFileSync(dailyLogPath('office-runtime', getKstDateKey()), fallbackLine);
    } catch {
      // ignore
    }
  }
}

/** 운영자용 얇은 요약: BOOT, 연결, 패널, 스키마, 피드백 실패, 리밸, 치명적 오류 등 */
export function isOpsEvent(scope: string, message: string, level: string): boolean {
  const s = String(scope || '').toUpperCase();
  const m = String(message || '');
  if (level === 'ERROR') return true;
  if (s === 'BOOT' || s === 'ENV') return true;
  if (s === 'DISCORD' && /ready|login failure|login|online/i.test(m)) return true;
  if (s === 'PANEL' && /restore|boot|panel/i.test(m)) return true;
  if (s === 'FEEDBACK' && /failure|failed|handler failed/i.test(m)) return true;
  if (s === 'DB' && /schema|mismatch|check failed|failed/i.test(m)) return true;
  if (/REBALANCE|REBAL/i.test(s) && /executed|hold|complete|user_hold|리밸/i.test(m)) return true;
  if (s === 'GLOBAL' || s === 'CRITICAL') return level === 'WARN' || level === 'ERROR';
  if (s === 'SCHEDULER') return level === 'ERROR';
  if (s === 'QUOTE' && /guard|degraded|critical/i.test(m)) return true;
  return false;
}

function shouldMirrorInfoToMainRuntime(scope: string): boolean {
  if (VERBOSE_MAIN_RUNTIME) return true;
  const s = String(scope || '').toUpperCase();
  if (s === 'INTERACTION' || s === 'UX') return false;
  return true;
}

type SupEntry = { first: number; suppressed: number; scope: string; message: string; level: string; timer: NodeJS.Timeout | null };
const suppression = new Map<string, SupEntry>();

function suppressionKey(level: string, scope: string, message: string, meta?: unknown): string {
  const metaStr =
    meta && typeof meta === 'object'
      ? JSON.stringify(meta).slice(0, 400)
      : meta !== undefined
        ? String(meta).slice(0, 200)
        : '';
  return `${level}|${scope}|${message}|${metaStr}`;
}

function flushSuppression(key: string): void {
  const e = suppression.get(key);
  if (!e || e.suppressed <= 0) {
    if (e?.timer) clearTimeout(e.timer);
    suppression.delete(key);
    return;
  }
  const summary = `[${new Date().toISOString()}] [INFO] [LOGGER] duplicate log suppressed | ${JSON.stringify({
    scope: e.scope,
    message: e.message.slice(0, 200),
    level: e.level,
    suppressedCount: e.suppressed,
    windowMs: SUPPRESS_MS
  })}\n`;
  try {
    fs.appendFileSync(dailyLogPath('office-runtime', getKstDateKey()), summary);
    appendCategoryFileLog('INFO', 'LOGGER', summary);
  } catch {
    // ignore
  }
  if (e.timer) clearTimeout(e.timer);
  suppression.delete(key);
}

function trySuppress(level: string, scope: string, message: string, meta?: unknown): boolean {
  if (level !== 'ERROR' && level !== 'WARN') return false;
  const key = suppressionKey(level, scope, message, meta);
  const now = Date.now();
  const prev = suppression.get(key);
  if (!prev) {
    const timer = setTimeout(() => flushSuppression(key), SUPPRESS_MS);
    suppression.set(key, { first: now, suppressed: 0, scope, message, level, timer });
    return false;
  }
  prev.suppressed += 1;
  if (prev.timer) clearTimeout(prev.timer);
  prev.timer = setTimeout(() => flushSuppression(key), SUPPRESS_MS);
  return true;
}

/** 오래된 daily/*.log 삭제 (office-*, 카테고리 하위 일별는 별도 패턴이라 여기서는 daily만) */
export function cleanupOldDailyLogs(): { removed: string[]; keptRetentionDays: number } {
  const removed: string[] = [];
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    if (!fs.existsSync(DAILY_DIR)) return { removed, keptRetentionDays: LOG_RETENTION_DAYS };
    for (const name of fs.readdirSync(DAILY_DIR)) {
      const fp = path.join(DAILY_DIR, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed.push(name);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { removed, keptRetentionDays: LOG_RETENTION_DAYS };
}

let cleanupScheduled = false;
function scheduleLogCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  setInterval(() => {
    cleanupOldDailyLogs();
  }, 6 * 60 * 60 * 1000);
  setTimeout(() => cleanupOldDailyLogs(), 5000);
}

export const healthState = {
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
  cwd: process.cwd(),
  pid: process.pid,
  bunVersion: process.versions?.bun || 'node-' + process.version,
  env: {
    DISCORD_TOKEN: !!(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN),
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY
  },
  discord: { loginAttempted: false, ready: false, botTag: null as string | null, guildCount: 0, targetChannelResolved: false, lastError: null as string | null },
  panels: {
    restoreAttempted: false,
    restoreSucceeded: false,
    mainPanelMessageId: null as string | null,
    lastPanelAction: null as string | null,
    panelErrorReason: null as string | null,
    lastPanelRestoreResult: null as 'success' | 'failed' | null,
    panelRestoreFallbackUsed: false,
    panelRecreated: false,
    lastPanelRestoreAt: null as string | null
  },
  interactions: { lastInteractionAt: null as string | null, lastInteractionType: null as string | null, lastCustomId: null as string | null },
  ai: { lastRoute: null as string | null, lastNoDataTriggered: false },
  db: { lastContextError: null as string | null },
  ux: {
    lastFollowupDetectedAt: null as string | null,
    lastFollowupType: null as string | null,
    lastFollowupAttached: null as boolean | null,
    lastFollowupSelectedAt: null as string | null,
    lastDecisionSnapshotSavedAt: null as string | null,
    lastDecisionAttached: null as boolean | null,
    lastDecisionSelectedAt: null as string | null,
    lastUiComponentPolicy: null as string | null
  }
};

export function updateHealth(patchFn: (state: typeof healthState) => void) {
  try {
    patchFn(healthState);
    healthState.lastHeartbeatAt = new Date().toISOString();
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(healthState, null, 2));
  } catch (e: any) {
    console.error('Health update failed', e.message);
  }
}

export function startHeartbeat() {
  setInterval(() => {
    updateHealth(() => {});
  }, 30000);
}

function appendFileSafe(filePath: string, line: string): void {
  try {
    fs.appendFileSync(filePath, line);
  } catch {
    // ignore
  }
}

function writeLog(
  level: string,
  scope: string,
  message: string,
  meta?: unknown,
  opts?: { skipSuppression?: boolean; forceMainRuntime?: boolean }
): void {
  const dateKey = getKstDateKey();
  const runtimeFile = dailyLogPath('office-runtime', dateKey);
  const errorFile = dailyLogPath('office-error', dateKey);
  const opsFile = dailyLogPath('office-ops', dateKey);

  if (!opts?.skipSuppression && (level === 'ERROR' || level === 'WARN')) {
    if (trySuppress(level, scope, message, meta)) {
      return;
    }
  }

  const metaStr = meta !== undefined ? ` | ${JSON.stringify(meta)}` : '';
  const logLine = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${metaStr}\n`;

  if (level === 'ERROR') console.error(logLine.trim());
  else if (level === 'WARN') console.warn(logLine.trim());
  else if (level === 'DEBUG' && !LOG_DEBUG_ENABLED) {
    /* console quiet for debug by default */
  } else console.log(logLine.trim());

  if (level === 'DEBUG') {
    if (LOG_DEBUG_ENABLED) {
      appendFileSafe(dailyLogPath('office-debug', dateKey), logLine);
    }
    appendCategoryFileLog(level, scope, logLine);
    return;
  }

  if (level === 'ERROR') {
    appendFileSafe(errorFile, logLine);
    if (shouldMirrorInfoToMainRuntime(scope) || opts?.forceMainRuntime) {
      appendFileSafe(runtimeFile, logLine);
    }
  } else if (level === 'WARN') {
    if (shouldMirrorInfoToMainRuntime(scope) || opts?.forceMainRuntime) {
      appendFileSafe(runtimeFile, logLine);
    }
  } else if (level === 'INFO') {
    if (shouldMirrorInfoToMainRuntime(scope) || opts?.forceMainRuntime) {
      appendFileSafe(runtimeFile, logLine);
    }
  }

  appendCategoryFileLog(level, scope, logLine);

  if (isOpsEvent(scope, message, level)) {
    appendFileSafe(opsFile, logLine);
  }
}

scheduleLogCleanup();

export const logger = {
  debug: (scope: string, message: string, meta?: unknown) => writeLog('DEBUG', scope, message, meta),
  info: (scope: string, message: string, meta?: unknown) => writeLog('INFO', scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => writeLog('WARN', scope, message, meta),
  error: (scope: string, message: string, errorOrMeta?: unknown) => {
    const errMeta = errorOrMeta instanceof Error ? { stack: errorOrMeta.stack, message: errorOrMeta.message } : errorOrMeta;
    writeLog('ERROR', scope, message, errMeta);
  },
  /** 명시적 운영 요약(필요 시 코드에서 직접 ops 파일에 한 줄) */
  ops: (scope: string, message: string, meta?: unknown) => {
    const logLine = `[${new Date().toISOString()}] [OPS] [${scope}] ${message}${meta !== undefined ? ` | ${JSON.stringify(meta)}` : ''}\n`;
    try {
      fs.appendFileSync(dailyLogPath('office-ops', getKstDateKey()), logLine);
    } catch {
      // ignore
    }
    console.log(logLine.trim());
  }
};

process.on('uncaughtException', err => {
  logger.error('GLOBAL', 'uncaughtException', err);
  updateHealth(s => (s.discord.lastError = err.message));
});
process.on('unhandledRejection', reason => {
  logger.error('GLOBAL', 'unhandledRejection', reason);
  updateHealth(s => (s.discord.lastError = String(reason)));
});

logger.info('BOOT', `Starting jimin-ai-office`, { cwd: healthState.cwd, pid: healthState.pid, bun: healthState.bunVersion });
logger.info('ENV', 'Environment variables loaded', healthState.env);
logger.info('LOGGER', 'log sinks: daily/*, ops/error/runtime/debug; retention days', { days: LOG_RETENTION_DAYS });
updateHealth(() => {});
