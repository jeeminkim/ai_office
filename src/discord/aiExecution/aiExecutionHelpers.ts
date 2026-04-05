import type { AiExecutionHandle } from './aiExecutionHandle';

export function collectPartialResult(
  handle: AiExecutionHandle | null | undefined,
  personaLabel: string,
  content: string | null | undefined
): void {
  if (!handle || !content?.trim()) return;
  handle.recordPartialSegment(personaLabel, content.trim());
}

/** 타임아웃 시 채널에 붙일 부분 요약 본문 (Discord 길이 상한 고려) */
export function formatPartialFallbackDiscordBody(
  entries: ReadonlyArray<{ persona: string; excerpt: string }>,
  timeoutPhase: 'first_visible' | 'total'
): string {
  if (!entries.length) {
    const emptyHeader =
      timeoutPhase === 'first_visible'
        ? '⚠️ **아직 유의미한 결과를 생성하지 못했습니다.** 이번 분석을 중단합니다.\n'
        : '⚠️ **분석 시간이 초과되어 일부 결과만 제공합니다.**\n';
    return `${emptyHeader}\n_완료된 위원/모델 응답이 아직 없습니다. CIO 종합·후속 단계는 생략되었을 수 있습니다._\n\n아래에서 다음 동작을 선택해 주세요.`;
  }

  const header =
    timeoutPhase === 'first_visible'
      ? '⚠️ **첫 분석 본문이 채널에 도달하기 전에 조기 한도(첫 응답)에 도달했습니다.**\n아래는 아직 브로드캐스트되기 전에 수집된 일부 출력입니다.\n'
      : '⚠️ **분석 시간이 초과되어 일부 결과만 제공합니다.**\n';

  const personaLine = entries.map(e => e.persona).join(', ');
  const maxEach = 450;
  const bullets = entries
    .map(e => {
      const t = e.excerpt.length > maxEach ? `${e.excerpt.slice(0, maxEach)}…` : e.excerpt;
      return `**${e.persona}**\n${t}`;
    })
    .join('\n\n');

  const core =
    `**현재까지 수집된 의견 (${entries.length})** — ${personaLine}\n\n` +
    `${bullets}\n\n` +
    `_위원 전체·CIO 최종 종합이 없을 수 있습니다. 경량/요약 재시도로 이어가실 수 있습니다._`;

  let body = `${header}\n${core}\n\n아래에서 다음 동작을 선택해 주세요.`;
  if (body.length > 1900) {
    body = body.slice(0, 1890) + '…\n\n_(일부 생략)_\n\n아래에서 다음 동작을 선택해 주세요.';
  }
  return body;
}
