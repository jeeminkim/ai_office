/**
 * interaction registry 라우트 개수·이름 스모크 (Discord 연결 없음).
 * 실행: npx ts-node scripts/interaction-smoke-check.ts
 */
import { buildInteractionRoutes } from '../src/discord/handlers/interactionCreate/buildInteractionRoutes';

const { buttonRoutes, stringSelectRoutes, modalRoutes } = buildInteractionRoutes();

console.log('[interaction-smoke-check] route counts', {
  button: buttonRoutes.length,
  stringSelect: stringSelectRoutes.length,
  modal: modalRoutes.length
});
console.log(
  '[interaction-smoke-check] button route names:',
  buttonRoutes.map((r) => r.name).join(', ')
);
