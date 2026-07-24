import type { RuntimeConfig } from '../shared/contracts.js';
import type { AppConfig } from './config.js';

export function publicRuntimeConfig(config: AppConfig): RuntimeConfig {
  return { analysisKnowledgeEnabled: config.analysisKnowledgeEnabled };
}
