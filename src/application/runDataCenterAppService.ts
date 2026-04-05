import type { ProviderGenerationResult } from '../../analysisTypes';
import { executeWithProvider } from '../contracts/providerPolicy';

export async function runDataCenterAppService(params: {
  discordUserId: string;
  personaName: string;
  prompt: string;
  fallbackToGemini: () => Promise<ProviderGenerationResult>;
}) {
  return executeWithProvider({
    runtime: {
      discordUserId: params.discordUserId,
      personaKey: 'THIEL',
      personaName: params.personaName,
      analysisType: 'data_center_thiel'
    },
    prompt: params.prompt,
    fallbackToGemini: params.fallbackToGemini
  });
}

