/**
 * Discord 모달·폼 입력 파싱 (index와 interaction 라우트 공용).
 */
export function parseNumberStrict(value: string): number | null {
  if (!value) return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

export function normalizeSymbol(value: string): string {
  return (value || '').trim().toUpperCase();
}

export function parsePositiveAmount(value: string): number | null {
  const amount = parseNumberStrict(value);
  if (amount === null || amount <= 0) return null;
  return amount;
}

export function sanitizeDescription(value: string): string {
  return (value || '').trim();
}
