import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { MemoryObjectStorage } from '../infrastructure/objectStorage.js';
import { MemoryRepository } from '../infrastructure/memoryRepository.js';
import { KnowledgeService } from '../knowledgeService.js';
import { analyzeKnowledgeFile } from './contentAnalyzer.js';

const config: AppConfig = { port: 8787, host: '127.0.0.1', corsOrigin: '*', retentionDays: 365, workerMode: 'inline', repositoryDriver: 'memory', localDataDir: '.data-test', objectStorageDriver: 'memory', modelDriver: 'rule_based', embeddingModelName: 'text-embedding-3-large', knowledgeImportMaxTotalMb: 250, s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true } };

test('text content is extracted and receives an automatic classification suggestion', async () => {
  const result = await analyzeKnowledgeFile({ name: 'price-policy.md', mimeType: 'text/markdown', data: Buffer.from('2026年价格政策：所有折扣必须完成审批，不得直接向客户承诺。') }, config);
  assert.equal(result.suggestedLayer, 'L3');
  assert.equal(result.suggestedCategory, '价格与版本');
  assert.equal(result.candidates?.[0]?.businessCategory, '产品资料');
  assert.match(result.normalizedContent, /折扣必须完成审批/);
  assert.ok(result.confidence > 0.5);
});

test('uploaded content cannot publish until a human confirms classification', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  const entry = await service.upload('org-1', { name: 'objection.txt', mimeType: 'text/plain', data: Buffer.from('价格异议销售策略：先确认预算还是价值，再决定下一步话术。') });
  assert.equal(entry.status, 'in_review');
  assert.equal(entry.structuredData?.requiresHumanConfirmation, true);
  await assert.rejects(() => service.setStatus('org-1', entry.id, 'published', 'admin-1'), /人工审核归类/);
  const confirmed = await service.confirmClassification('org-1', entry.id, { layer: 'L2', category: '价格异议', title: '价格异议策略', content: entry.content, version: '1.0' }, 'admin-1');
  assert.equal(confirmed.status, 'published');
  assert.equal(confirmed.structuredData?.requiresHumanConfirmation, false);
});

test('unknown binary content stays reviewable instead of pretending extraction succeeded', async () => {
  const result = await analyzeKnowledgeFile({ name: 'recording.bin', mimeType: 'application/octet-stream', data: Buffer.from([0, 1, 2, 3]) }, config);
  assert.equal(result.extractionMethod, 'metadata-only');
  assert.equal(result.confidence, 0.3);
  assert.ok(result.warnings.length > 0);
});
