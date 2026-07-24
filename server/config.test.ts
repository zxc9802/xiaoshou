import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from './config.js';

test('analysis knowledge is disabled unless explicitly set to true', () => {
  const previous = process.env.ANALYSIS_KNOWLEDGE_ENABLED;
  try {
    delete process.env.ANALYSIS_KNOWLEDGE_ENABLED;
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'false';
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'TRUE';
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'invalid';
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'true';
    assert.equal(loadConfig().analysisKnowledgeEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.ANALYSIS_KNOWLEDGE_ENABLED;
    else process.env.ANALYSIS_KNOWLEDGE_ENABLED = previous;
  }
});
