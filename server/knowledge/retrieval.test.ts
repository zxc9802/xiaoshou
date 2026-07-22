import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import type { AppConfig } from '../config.js';
import type { KnowledgeVectorHit, KnowledgeVectorIndex } from '../infrastructure/vectorIndex.js';
import { retrieveKnowledge } from './retrieval.js';

const config: AppConfig = { port: 8787, host: '127.0.0.1', corsOrigin: '*', retentionDays: 365, workerMode: 'inline', repositoryDriver: 'memory', localDataDir: '.data-test', objectStorageDriver: 'memory', modelDriver: 'rule_based', embeddingModelName: 'text-embedding-3-large', knowledgeImportMaxTotalMb: 250, s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true } };

function entry(id: string, layer: KnowledgeEntry['layer'], title: string, content: string, status: KnowledgeEntry['status'] = 'published'): KnowledgeEntry {
  const now = new Date().toISOString();
  return { id, layer, category: layer === 'L3' ? '价格政策' : '销售规则', title, content, summary: content, status, version: '1.0', createdAt: now, updatedAt: now };
}

class RecordingVectorIndex implements KnowledgeVectorIndex {
  readonly searches: Array<{ organizationId: string; vector: number[]; nowEpoch: number; limit: number }> = [];
  constructor(private readonly hits: KnowledgeVectorHit[] = [], private readonly searchError?: Error) {}
  async initialize() {}
  async replaceEntry() {}
  async deleteEntry() {}
  async search(input: { organizationId: string; vector: number[]; nowEpoch: number; limit: number }) {
    this.searches.push(input);
    if (this.searchError) throw this.searchError;
    return this.hits;
  }
  async health() { return { ok: true }; }
}

function embeddingConfig(): AppConfig {
  return {
    ...config,
    modelDriver: 'openai_compatible',
    modelApiStyle: 'gemini_generate_content',
    modelBaseUrl: 'https://yunwu.example',
    modelApiKey: 'test-key',
    embeddingApiStyle: 'openai',
    embeddingBaseUrl: 'https://yunwu.example',
    embeddingApiKey: 'test-key',
    embeddingModelName: 'text-embedding-3-small',
    embeddingDimensions: 1536,
  };
}

function mockEmbedding(t: test.TestContext) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let text = '';
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input?: string };
    text = body.input ?? '';
    return new Response(JSON.stringify({
      model: 'text-embedding-3-small',
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }],
    }), { status: 200 });
  };
  return () => text;
}

test('hybrid retrieval only returns published knowledge and ranks relevant facts first', async () => {
  const entries = [
    entry('l0', 'L0', '安全红线', '不得虚构价格和承诺'),
    entry('price', 'L3', '企业培训价格政策', '企业AI培训标准报价与折扣审批规则'),
    entry('case', 'L3', '客户案例', '制造企业培训后的流程优化案例'),
    entry('draft', 'L3', '未审核价格', '未经审核的超低折扣', 'draft'),
  ];
  const result = await retrieveKnowledge(entries, '客户觉得企业AI培训价格贵，能否打折', config, {
    organizationId: 'org-a', ownerId: 'demo-user', limit: 2,
  });
  assert.equal(result[0]?.id, 'l0');
  assert.equal(result[1]?.id, 'price');
  assert.equal(result.some((item) => item.id === 'draft'), false);
});

test('keyword fallback still retrieves knowledge when embeddings are disabled', async () => {
  const result = await retrieveKnowledge([
    entry('competitor', 'L3', '竞品对比口径', '免费网课与企业定制培训的差异'),
    entry('after-sales', 'L3', '售后说明', '课程结束后提供资料答疑'),
  ], '客户问免费网课和我们有什么区别', config, {
    organizationId: 'org-a', ownerId: 'demo-user', limit: 1,
  });
  assert.equal(result[0]?.id, 'competitor');
});

test('dense retrieval embeds the asymmetric query and scopes Qdrant search to the server organization', async (t) => {
  const embeddedText = mockEmbedding(t);
  const vectorIndex = new RecordingVectorIndex([
    { id: 'point-1', score: 0.9, entryId: 'price', chunkId: 'chunk-1', sequence: 0, content: '价格规则' },
  ]);

  const result = await retrieveKnowledge([
    entry('price', 'L3', '企业版价格', '企业版报价规则'),
  ], '客户觉得太贵', embeddingConfig(), {
    organizationId: 'org-server', ownerId: 'demo-user', vectorIndex,
  });

  assert.equal(embeddedText(), 'task: search result | query: 客户觉得太贵');
  assert.equal(vectorIndex.searches[0]?.organizationId, 'org-server');
  assert.equal(vectorIndex.searches[0]?.limit, 30);
  assert.equal(result[0]?.id, 'price');
});

test('dense retrieval reranks only Qdrant entry IDs and deduplicates multiple chunks', async (t) => {
  mockEmbedding(t);
  const vectorIndex = new RecordingVectorIndex([
    { id: 'point-1', score: 0.91, entryId: 'price', chunkId: 'chunk-1', sequence: 0, content: '价格规则一' },
    { id: 'point-2', score: 0.86, entryId: 'price', chunkId: 'chunk-2', sequence: 1, content: '价格规则二' },
  ]);

  const result = await retrieveKnowledge([
    entry('price', 'L3', '企业版价格', '企业版报价规则'),
    entry('not-returned', 'L2', '价格异议话术', '客户说贵时解释价值'),
  ], '价格贵', embeddingConfig(), {
    organizationId: 'org-a', ownerId: 'demo-user', vectorIndex,
  });

  assert.deepEqual(result.map((item) => item.id), ['price']);
});

test('Qdrant failure falls back to full keyword retrieval', async (t) => {
  mockEmbedding(t);
  const vectorIndex = new RecordingVectorIndex([], new Error('qdrant unavailable'));

  const result = await retrieveKnowledge([
    entry('competitor', 'L3', '竞品对比口径', '免费网课与企业定制培训的差异'),
    entry('after-sales', 'L3', '售后说明', '课程结束后提供资料答疑'),
  ], '客户问免费网课和我们有什么区别', embeddingConfig(), {
    organizationId: 'org-a', ownerId: 'demo-user', limit: 1, vectorIndex,
  });

  assert.deepEqual(result.map((item) => item.id), ['competitor']);
});

test('mandatory knowledge respects owner, deletion, and effective dates independently of Qdrant', async () => {
  const ownStyle = { ...entry('own-style', 'L4', '我的表达风格', '表达简洁'), structuredData: { ownerId: 'demo-user' } };
  const otherStyle = { ...entry('other-style', 'L4', '他人表达风格', '表达活泼'), structuredData: { ownerId: 'other-user' } };
  const deleted = { ...entry('deleted', 'L0', '已删除红线', '不得承诺'), deletedAt: '2026-07-20T00:00:00.000Z' };
  const future = { ...entry('future', 'L1', '未来规则', '未来执行'), effectiveFrom: '2026-08-01T00:00:00.000Z' };
  const expired = { ...entry('expired', 'L1', '过期规则', '已经过期'), effectiveTo: '2026-07-01T00:00:00.000Z' };

  const result = await retrieveKnowledge([
    entry('redline', 'L0', '安全红线', '不得虚构'),
    entry('process', 'L1', '销售流程', '先诊断再建议'),
    ownStyle,
    otherStyle,
    deleted,
    future,
    expired,
  ], '无关查询', config, {
    organizationId: 'org-a', ownerId: 'demo-user', now: new Date('2026-07-22T00:00:00.000Z'),
  });

  assert.deepEqual(result.map((item) => item.id), ['redline', 'process', 'own-style']);
});
