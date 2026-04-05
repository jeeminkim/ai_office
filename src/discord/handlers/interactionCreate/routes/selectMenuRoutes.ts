import type { InteractionRoute } from '../../../interactionRegistry';
import { getInstrumentStringSelectRoutes } from './instrumentRoutes';
import { getFollowupStringSelectRoutes } from './followupRoutes';
import { getPortfolioStringSelectRoutes } from './portfolioRoutes';

/** String select 라우트 — instr → follow-up → portfolio 순(기존과 동일). */
export function getStringSelectRoutes(): InteractionRoute[] {
  return [
    ...getInstrumentStringSelectRoutes(),
    ...getFollowupStringSelectRoutes(),
    ...getPortfolioStringSelectRoutes()
  ];
}
