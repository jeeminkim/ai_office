import type { DiscordInteractionContext } from './InteractionContext';

/** discord.js Interaction 유니온은 customId/defer 등이 분기마다 달라 any로 수신(기존 index.ts 관행). */
export type InteractionRoute = {
  name: string;
  match: (interaction: any) => boolean;
  handle: (interaction: any, ctx: DiscordInteractionContext) => Promise<boolean>;
};

/**
 * 등록 순서가 우선순위다. match가 true인 첫 route만 handle한다.
 * handle이 false를 반환하면 다음 route로 진행한다(tryHandle 패턴용).
 */
export async function dispatchRoutesInOrder(
  routes: InteractionRoute[],
  interaction: any,
  ctx: DiscordInteractionContext,
  options?: { onMatch?: (name: string) => void }
): Promise<boolean> {
  for (const r of routes) {
    if (r.match(interaction)) {
      options?.onMatch?.(r.name);
      const handled = await r.handle(interaction, ctx);
      if (handled) return true;
    }
  }
  return false;
}
