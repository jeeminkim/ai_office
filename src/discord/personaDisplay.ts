import type { PersonaKey } from '../../analysisTypes';

/** `analysis_claims.persona_name` / `analysisFormatting` 계열과 맞춤 (claim 매핑 정합성). */
export function personaKeyToDisplayNameForFeedback(personaKey: string): string {
  const k = personaKey as PersonaKey;
  switch (k) {
    case 'RAY':
      return 'Ray Dalio (PB)';
    case 'HINDENBURG':
      return 'HINDENBURG_ANALYST';
    case 'JYP':
      return 'JYP (Analyst)';
    case 'SIMONS':
      return 'James Simons (Quant)';
    case 'DRUCKER':
      return 'Peter Drucker (COO)';
    case 'CIO':
      return 'Stanley Druckenmiller (CIO)';
    case 'TREND':
      return 'Trend Analyst';
    case 'OPEN_TOPIC':
      return 'Open Topic Analyst';
    case 'THIEL':
      return 'Peter Thiel (Data Center)';
    case 'HOT_TREND':
      return '전현무 · 핫 트렌드 분석';
    default:
      return personaKey || 'Unknown';
  }
}
