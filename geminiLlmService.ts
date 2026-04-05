import { GoogleGenAI } from '@google/genai';
import { logger } from './logger';
import type { ProviderGenerationResult } from './analysisTypes';

const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';

let ai: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }
  return ai;
}

export async function generateGeminiResponse(params: {
  prompt: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<ProviderGenerationResult> {
  const model = params.model || GEMINI_MODEL_DEFAULT;
  const req: Record<string, unknown> = {
    model,
    contents: params.prompt
  };
  if (params.maxOutputTokens != null || params.temperature != null) {
    req.config = {
      ...(params.maxOutputTokens != null ? { maxOutputTokens: params.maxOutputTokens } : {}),
      ...(params.temperature != null ? { temperature: params.temperature } : {})
    };
  }
  const response = await getGeminiClient().models.generateContent(req as any);
  const text = String((response as any).text || '');
  if (!text.trim()) {
    logger.warn('GEMINI', 'empty response text', { model });
  }
  return {
    text,
    provider: 'gemini',
    model,
    usage: undefined
  };
}
