import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from './config.js';
import { publicRuntimeConfig } from './runtimeConfig.js';

const config = {
  analysisKnowledgeEnabled: false,
  modelApiKey: 'secret',
  databaseUrl: 'postgres://secret',
} as AppConfig;

test('public runtime config exposes the analysis knowledge switch without secrets', () => {
  const result = publicRuntimeConfig(config);
  assert.deepEqual(result, { analysisKnowledgeEnabled: false });
  assert.equal('modelApiKey' in result, false);
  assert.equal('databaseUrl' in result, false);
});
