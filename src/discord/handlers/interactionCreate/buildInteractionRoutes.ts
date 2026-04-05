import type { InteractionRoute } from '../../interactionRegistry';
import { getDecisionButtonRoutes } from './routes/decisionRoutes';
import { getFollowupButtonRoutes, getFollowupModalRoutes, getFollowupStringSelectRoutes } from './routes/followupRoutes';
import { getTimeoutButtonRoutes } from './routes/timeoutRoutes';
import { getFeedbackButtonRoutes } from './routes/feedbackRoutes';
import { getInstrumentButtonRoutes, getInstrumentStringSelectRoutes } from './routes/instrumentRoutes';
import { getPanelMainButtonRoutes } from './routes/panelMainRoutes';
import { getTrendPanelButtonRoutes } from './routes/trendPanelRoutes';
import { getDataCenterButtonRoutes } from './routes/dataCenterRoutes';
import { getFinancePanelButtonRoutes } from './routes/financePanelButtonRoutes';
import { getPortfolioButtonRoutes, getPortfolioModalSubmitRoutes, getPortfolioStringSelectRoutes } from './routes/portfolioRoutes';
import { getSettingsPanelButtonRoutes } from './routes/settingsPanelRoutes';
import { getModalTrendAiRoutes } from './routes/modalTrendAiRoutes';
import { getModalFinanceSubmitRoutes } from './routes/modalFinanceSubmitRoutes';
import { getStringSelectRoutes } from './routes/selectMenuRoutes';

/**
 * interactionCreate 분기 — 등록 순서가 우선순위다 (기존 index.ts if 체인과 동일).
 * route 정의는 routes/*.ts 도메인 파일에 두고, 이 파일은 조립만 담당한다.
 */
export function buildInteractionRoutes(): {
  buttonRoutes: InteractionRoute[];
  stringSelectRoutes: InteractionRoute[];
  modalRoutes: InteractionRoute[];
} {
  const buttonRoutes: InteractionRoute[] = [
    ...getDecisionButtonRoutes(),
    ...getFollowupButtonRoutes(),
    ...getTimeoutButtonRoutes(),
    ...getFeedbackButtonRoutes(),
    ...getInstrumentButtonRoutes(),
    ...getPanelMainButtonRoutes(),
    ...getTrendPanelButtonRoutes(),
    ...getDataCenterButtonRoutes(),
    ...getFinancePanelButtonRoutes(),
    ...getPortfolioButtonRoutes(),
    ...getSettingsPanelButtonRoutes()
  ];

  const stringSelectRoutes: InteractionRoute[] = getStringSelectRoutes();

  const modalRoutes: InteractionRoute[] = [
    ...getFollowupModalRoutes(),
    ...getModalTrendAiRoutes(),
    ...getPortfolioModalSubmitRoutes(),
    ...getModalFinanceSubmitRoutes()
  ];

  return { buttonRoutes, stringSelectRoutes, modalRoutes };
}
