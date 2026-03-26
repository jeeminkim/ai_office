export function splitDiscordMessage(content: string, maxLen = 1800): string[] {
  const text = String(content || '');
  if (!text) return [''];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) {
      cut = maxLen;
    }
    const part = rest.slice(0, cut).trimEnd();
    chunks.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks.filter((x) => x.length > 0);
}

export function chooseInteractionRoute(interaction: any): 'reply' | 'editReply' | 'followUp' {
  if (interaction?.deferred) return 'editReply';
  if (interaction?.replied) return 'followUp';
  return 'reply';
}
