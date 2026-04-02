/**
 * panelManager.ts를 감싼 얇은 어댑터 — 핸들러가 구체 빌더 구현에 직접 묶이지 않게 한다.
 * (이번 단계에서는 panelManager 재export 수준; 추후 교체 가능.)
 */
import {
  getTrendPanel,
  getPortfolioPanel,
  getFinancePanel,
  getAIPanel,
  getDataCenterPanel,
  getSettingsPanel,
  getMainPanel
} from '../../../panelManager';

export type PanelAdapter = {
  getTrendPanel: typeof getTrendPanel;
  getPortfolioPanel: typeof getPortfolioPanel;
  getFinancePanel: typeof getFinancePanel;
  getAIPanel: typeof getAIPanel;
  getDataCenterPanel: typeof getDataCenterPanel;
  getSettingsPanel: typeof getSettingsPanel;
  getMainPanel: typeof getMainPanel;
};

export function createPanelAdapter(): PanelAdapter {
  return {
    getTrendPanel,
    getPortfolioPanel,
    getFinancePanel,
    getAIPanel,
    getDataCenterPanel,
    getSettingsPanel,
    getMainPanel
  };
}
