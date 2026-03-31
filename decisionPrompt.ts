import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from './logger';

const DECISION_HINTS =
  /원하시나요|선택해|선택|어느 방식|하시겠습니까|원하시면|어떤 방식|선택하시|고르시|어떤 쪽|원하시는지|결정해|선택하실/i;

/** LLM 응답이 사용자 선택을 요구하는지(휴리스틱) */
export function isDecisionPrompt(text: string): boolean {
  return DECISION_HINTS.test(String(text || ''));
}

function uniqShort(labels: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const s = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (s.length < 2) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 선택지 추출 — vs / / 또는 / 한 줄 패턴 위주. 실패 시 [예, 아니오].
 */
export function extractDecisionOptions(text: string): string[] {
  const t = String(text || '');
  const candidates: string[] = [];

  for (const line of t.split(/\n/)) {
    const L = line.trim();
    if (!L) continue;
    if (/\bvs\.?\b/i.test(L) || /\svs\s/i.test(L)) {
      const parts = L.split(/\s+vs\.?\s+/i);
      for (const p of parts) {
        const s = p
          .replace(/^[•\-*0-9.)]+\s*/, '')
          .replace(/[。．.!?:;]+$/, '')
          .trim();
        if (s.length >= 2) candidates.push(s);
      }
    }
  }
  if (candidates.length >= 2) {
    const u = uniqShort(candidates, 4);
    if (u.length >= 2) return u;
  }

  for (const line of t.split(/\n/)) {
    const L = line.trim();
    if (L.includes('/') && !L.includes('//') && !L.includes('http')) {
      const parts = L.split('/').map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 80);
      if (parts.length >= 2) return uniqShort(parts, 4);
    }
  }

  for (const line of t.split(/\n/)) {
    const L = line.trim();
    if (L.includes(' 또는 ')) {
      const parts = L.split(/\s+또는\s+/).map(s => s.replace(/^[•\-*0-9.)]+\s*/, '').trim());
      if (parts.length >= 2) return uniqShort(parts, 4);
    }
  }

  return ['예', '아니오'];
}

/**
 * customId: decision:select|{snapshotUuid}|{idx} — 라벨은 DB `decision_snapshots.options` 스냅샷으로 복원 (본문 재파싱 불필요).
 * Discord customId ≤100자: UUID(36) + 접두/인덱스로 여유 있음.
 */
export function buildDecisionButtonsRow(snapshotId: string, options: string[]): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const cleaned = options.map(o => String(o || '').trim()).filter(s => s.length >= 1);
  const use = cleaned.length >= 2 ? cleaned.slice(0, 4) : ['예', '아니오'];
  const n = Math.min(4, use.length);
  for (let i = 0; i < n; i++) {
    const label = use[i].slice(0, 80);
    const cid = `decision:select|${snapshotId}|${i}`;
    row.addComponents(
      new ButtonBuilder().setCustomId(cid).setLabel(label).setStyle(ButtonStyle.Primary)
    );
  }
  return row;
}

/** Discord 전송 직전(버튼 부착 시) — 옵션 추출 결과만 로깅. `DECISION_PROMPT detected`는 `analysisPipelineService` persist 시점. */
export function logDecisionPromptDetected(chatHistoryId: number | null, analysisType: string, options: string[]): void {
  logger.info('DECISION', 'DECISION_OPTIONS extracted', {
    chatHistoryId,
    analysisType,
    options: options.slice(0, 4),
    optionCount: options.length
  });
}
