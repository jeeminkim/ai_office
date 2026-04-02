/**
 * follow-up 관련 interaction 라우트 등록 여부 스모크.
 * 실행: npx ts-node scripts/followup-route-smoke.ts
 */
import { buildInteractionRoutes } from '../src/discord/handlers/interactionCreate/buildInteractionRoutes';

const { buttonRoutes, stringSelectRoutes, modalRoutes } = buildInteractionRoutes();
const all = [...buttonRoutes, ...stringSelectRoutes, ...modalRoutes];
const follow = all.filter((r) => /followup|follow-up/i.test(r.name) || r.name.includes('followup'));
console.log('[followup-route-smoke] follow-up related routes:', follow.map((r) => r.name));
