/**
 * interaction registry 라우트 개수·이름 스모크 (Discord 연결 없음).
 * 실행: npx ts-node scripts/interaction-smoke-check.ts
 */
import fs from 'fs';
import path from 'path';
import { buildInteractionRoutes } from '../src/discord/handlers/interactionCreate/buildInteractionRoutes';

const routesDir = path.join(__dirname, '..', 'src', 'discord', 'handlers', 'interactionCreate', 'routes');
const expectedRouteModules = [
  'decisionRoutes.ts',
  'feedbackRoutes.ts',
  'followupRoutes.ts',
  'timeoutRoutes.ts',
  'instrumentRoutes.ts',
  'panelMainRoutes.ts',
  'trendPanelRoutes.ts',
  'dataCenterRoutes.ts',
  'financePanelButtonRoutes.ts',
  'portfolioRoutes.ts',
  'settingsPanelRoutes.ts',
  'modalTrendAiRoutes.ts',
  'modalFinanceSubmitRoutes.ts',
  'selectMenuRoutes.ts'
];
for (const f of expectedRouteModules) {
  const p = path.join(routesDir, f);
  if (!fs.existsSync(p)) {
    throw new Error(`[interaction-smoke-check] missing route module: ${f}`);
  }
}

const root = path.join(__dirname, '..');
for (const rel of [
  'src/discord/handlers/messageCreate.ts',
  'src/discord/services/discordBroadcastService.ts'
]) {
  if (!fs.existsSync(path.join(root, rel))) {
    throw new Error(`[interaction-smoke-check] missing file: ${rel}`);
  }
}

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
console.log('[interaction-smoke-check] OK');
process.exit(0);
