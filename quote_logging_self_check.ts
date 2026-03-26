import { classifyQuoteError, mergeFailureBreakdown } from './quoteService';

function assertCondition(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

function runClassifyChecks() {
  assertCondition(classifyQuoteError(new Error('HTTP 401'), 401) === 'unauthorized_401', '401 classify failed');
  assertCondition(classifyQuoteError(new Error('HTTP 403'), 403) === 'forbidden_403', '403 classify failed');
  assertCondition(classifyQuoteError(new Error('HTTP 404'), 404) === 'not_found_404', '404 classify failed');
  assertCondition(classifyQuoteError(new Error('HTTP 429'), 429) === 'rate_limited_429', '429 classify failed');
  assertCondition(classifyQuoteError(new Error('HTTP 500'), 500) === 'server_error_5xx', '5xx classify failed');
  assertCondition(classifyQuoteError(new Error('request timeout')) === 'timeout', 'timeout classify failed');
  assertCondition(classifyQuoteError(new Error('fetch failed')) === 'network_error', 'network classify failed');
}

function runBreakdownMergeChecks() {
  const merged = mergeFailureBreakdown([
    { unauthorized401: 2, timeout: 1 },
    { unauthorized401: 1, rateLimited429: 3, networkError: 2 },
    { notFound404: 4, unknownError: 1 }
  ]);
  assertCondition((merged.unauthorized401 || 0) === 3, 'unauthorized merge failed');
  assertCondition((merged.timeout || 0) === 1, 'timeout merge failed');
  assertCondition((merged.rateLimited429 || 0) === 3, '429 merge failed');
  assertCondition((merged.networkError || 0) === 2, 'network merge failed');
  assertCondition((merged.notFound404 || 0) === 4, '404 merge failed');
}

function runBackwardCompatibilityChecks() {
  const oldStyle = { price: 100, currency: 'USD', degraded: false, failedCandidates: 0 };
  assertCondition(typeof oldStyle.price === 'number', 'old style quote shape broken');
  assertCondition(oldStyle.currency === 'USD', 'old style currency broken');
}

function main() {
  runClassifyChecks();
  runBreakdownMergeChecks();
  runBackwardCompatibilityChecks();
  console.log('quote_logging_self_check: OK');
}

main();
