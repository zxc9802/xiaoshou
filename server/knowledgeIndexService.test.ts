import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../shared/contracts.js';
import type { AppConfig } from './config.js';
import type { KnowledgeVectorIndex, KnowledgeVectorPoint } from './infrastructure/vectorIndex.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { KnowledgeIndexService } from './knowledgeIndexService.js';

const config: AppConfig = {
  port: 8787,
  host: '127.0.0.1',
  corsOrigin: '*',
  retentionDays: 365,
  workerMode: 'inline',
  repositoryDriver: 'memory',
  localDataDir: '.data-test',
  objectStorageDriver: 'memory',
  modelDriver: 'openai_compatible',
  modelApiStyle: 'gemini_generate_content',
    modelBaseUrl: 'https://yunwu.example',
    modelApiKey: 'test-key',
    embeddingApiStyle: 'openai',
    embeddingBaseUrl: 'https://yunwu.example',
    embeddingApiKey: 'test-key',
    embeddingModelName: 'text-embedding-3-small',
    embeddingDimensions: 1536,
  knowledgeImportMaxTotalMb: 250,
  s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true },
};

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = '2026-07-22T00:00:00.000Z';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    layer: 'L3',
    category: '价格与版本',
    title: '产品A企业版价格',
    content: '企业版价格以审核报价单为准。',
    version: '1.0',
    status: 'published',
    createdAt: now,
    updatedAt: now,
    structuredData: { businessCategory: '产品资料' },
    ...overrides,
  };
}

class RecordingVectorIndex implements KnowledgeVectorIndex {
  initializeCalls = 0;
  replacements: Array<{ organizationId: string; entryId: string; points: KnowledgeVectorPoint[] }> = [];
  deletions: Array<{ organizationId: string; entryId: string }> = [];
  async initialize() { this.initializeCalls += 1; }
  async replaceEntry(organizationId: string, entryId: string, points: KnowledgeVectorPoint[]) {
    this.replacements.push({ organizationId, entryId, points });
  }
  async deleteEntry(organizationId: string, entryId: string) {
    this.deletions.push({ organizationId, entryId });
  }
  async search() { return []; }
  async health() { return { ok: true }; }
}

test('scheduleUpsert durably queues work and marks the entry pending without indexing inline', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  await repository.createKnowledge('org-a', entry());
  const service = new KnowledgeIndexService(repository, vectorIndex, config);

  await service.scheduleUpsert('org-a', entry().id);

  const jobs = await repository.listKnowledgeIndexJobs('org-a', 10);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, 'queued');
  assert.equal((await repository.getKnowledge(entry().id))?.structuredData?.embedding &&
    ((await repository.getKnowledge(entry().id))?.structuredData?.embedding as { status?: string }).status, 'pending');
  assert.equal(vectorIndex.replacements.length, 0);
});

test('uses 1536 as the default embedding metadata dimension', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const source = entry();
  await repository.createKnowledge('org-a', source);
  const service = new KnowledgeIndexService(repository, vectorIndex, { ...config, embeddingDimensions: undefined });

  await service.scheduleUpsert('org-a', source.id);

  const stored = await repository.getKnowledge(source.id);
  assert.equal((stored?.structuredData?.embedding as { dimensions?: number })?.dimensions, 1536);
});

test('processPending embeds every current chunk and replaces the entry points', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const rows = ['套餐,价格,条件', ...Array.from({ length: 70 }, (_, index) => `套餐${index + 1},${index + 1}00,需审批`)];
  const source = entry({
    content: rows.join('\n'),
    structuredData: { businessCategory: '产品资料', sourceReferences: [{ sourceFileName: '报价.csv' }] },
  });
  await repository.createKnowledge('org-a', source);
  const embeddedTexts: string[] = [];
  const service = new KnowledgeIndexService(repository, vectorIndex, config, async (text) => {
    embeddedTexts.push(text);
    return { model: 'gemini-embedding-2-preview', modelVersion: 'preview-1', vector: [0.1, 0.2] };
  });
  await service.scheduleUpsert('org-a', source.id);

  assert.equal(await service.processPending(), true);

  assert.equal(vectorIndex.initializeCalls, 1);
  assert.equal(vectorIndex.replacements.length, 1);
  assert.equal(vectorIndex.replacements[0]?.points.length, 3);
  assert.equal(embeddedTexts.length, 3);
  const stored = await repository.getKnowledge(source.id);
  assert.equal((stored?.structuredData?.embedding as { status?: string })?.status, 'indexed');
  assert.equal((stored?.structuredData?.embedding as { chunkCount?: number })?.chunkCount, 3);
  assert.equal((stored?.structuredData?.embedding as { dimensions?: number })?.dimensions, 1536);
  assert.equal((stored?.structuredData?.embedding as { model?: string })?.model, 'text-embedding-3-small');
  assert.equal((await repository.listKnowledgeIndexJobs('org-a', 10))[0]?.status, 'completed');
});

test('processPending deletes points even after the source entry is gone', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const service = new KnowledgeIndexService(repository, vectorIndex, config);
  await service.scheduleDelete('org-a', '22222222-2222-4222-8222-222222222222');

  assert.equal(await service.processPending(), true);

  assert.deepEqual(vectorIndex.deletions, [{
    organizationId: 'org-a', entryId: '22222222-2222-4222-8222-222222222222',
  }]);
  assert.equal((await repository.listKnowledgeIndexJobs('org-a', 10))[0]?.status, 'completed');
});

test('embedding failure schedules exponential retry and keeps the source published', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const source = entry();
  await repository.createKnowledge('org-a', source);
  const service = new KnowledgeIndexService(repository, vectorIndex, config, async () => {
    throw new Error('embedding unavailable');
  });
  await service.scheduleUpsert('org-a', source.id);
  const before = Date.now();

  assert.equal(await service.processPending(), true);

  const job = (await repository.listKnowledgeIndexJobs('org-a', 10))[0]!;
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 1);
  assert.match(job.lastError ?? '', /embedding unavailable/);
  assert.ok(Date.parse(job.nextAttemptAt ?? '') >= before + 900);
  const stored = await repository.getKnowledge(source.id);
  assert.equal(stored?.status, 'published');
  assert.equal((stored?.structuredData?.embedding as { status?: string })?.status, 'failed');
});
