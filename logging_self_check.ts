import fs from 'fs';
import path from 'path';
import { getKstDateKey, logger, resolveLogCategory } from './logger';

function assertCondition(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function selfCheck() {
  const dateKey = getKstDateKey();
  assertCondition(/^\d{8}$/.test(dateKey), 'KST date key format invalid');

  logger.info('OPENAI', 'openai sdk require started (self-check)', {
    cwd: process.cwd(),
    hasApiKey: !!process.env.OPENAI_API_KEY,
    nodePath: process.execPath
  });
  logger.info('OPENAI', 'openai sdk require succeeded (self-check)', {
    cwd: process.cwd(),
    hasApiKey: !!process.env.OPENAI_API_KEY,
    nodePath: process.execPath,
    packageVersion: null
  });
  logger.warn('OPENAI', 'openai sdk require failed (self-check)', {
    cwd: process.cwd(),
    hasApiKey: !!process.env.OPENAI_API_KEY,
    nodePath: process.execPath,
    message: 'simulated'
  });

  logger.info('QUOTE', 'quote request started (self-check)', {
    traceId: 'self-check-trace',
    originalSymbol: 'AAPL'
  });

  const openaiPath = path.join(process.cwd(), 'logs', 'openai', `openai.log_${dateKey}`);
  const quotePath = path.join(process.cwd(), 'logs', 'quote', `quote.log_${dateKey}`);
  assertCondition(exists(openaiPath), `OPENAI log file missing: ${openaiPath}`);
  assertCondition(exists(quotePath), `QUOTE log file missing: ${quotePath}`);

  // file sink failure simulation: invalid scope should still keep process alive
  logger.info('UNKNOWN_SCOPE_FOR_SELF_CHECK', 'file sink failure simulation passthrough', {});

  assertCondition(resolveLogCategory('OPENAI') === 'openai', 'OPENAI category routing failed');
  assertCondition(resolveLogCategory('QUOTE') === 'quote', 'QUOTE category routing failed');

  console.log('logging_self_check: OK');
}

selfCheck();
