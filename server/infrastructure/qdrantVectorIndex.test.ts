import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import type { KnowledgeVectorPoint } from './vectorIndex.js';
import { QdrantVectorIndex } from './qdrantVectorIndex.js';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8787,
    host: '127.0.0.1',
    corsOrigin: '*',
    retentionDays: 365,
    workerMode: 'inline',
    repositoryDriver: 'memory',
    localDataDir: '.data-test',
    objectStorageDriver: 'memory',
    modelDriver: 'rule_based',
    embeddingDimensions: 1536,
    qdrantUrl: 'http://qdrant.test',
    qdrantApiKey: 'secret-test-key',
    qdrantCollectionName: 'knowledge-1536-v1',
    qdrantCollectionAlias: 'knowledge-current',
    knowledgeImportMaxTotalMb: 250,
    s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true },
    ...overrides,
  };
}

function response(body: unknown = { result: true }, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('creates a 1536 Cosine collection and tenant payload index without leaking the API key', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === 'GET' && url.endsWith('/collections/knowledge-1536-v1')) return response({}, 404);
    if (method === 'GET' && url.endsWith('/aliases')) return response({ result: { aliases: [] } });
    return response();
  };

  await new QdrantVectorIndex(config()).initialize();

  const collection = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/collections/knowledge-1536-v1'));
  assert.deepEqual(collection?.body, { vectors: { size: 1536, distance: 'Cosine' } });
  const tenantIndex = calls.find((call) => call.url.includes('/index?wait=true')
    && (call.body as { field_name?: string })?.field_name === 'organizationId');
  assert.deepEqual(tenantIndex?.body, {
    field_name: 'organizationId',
    field_schema: { type: 'keyword', is_tenant: true },
  });
  const aliasCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/collections/aliases'));
  assert.deepEqual(aliasCreate?.body, {
    actions: [{ create_alias: { collection_name: 'knowledge-1536-v1', alias_name: 'knowledge-current' } }],
  });
  assert.ok(calls.every((call) => !call.url.includes('secret-test-key')));
  assert.ok(calls.every((call) => call.headers.get('api-key') === 'secret-test-key'));
});

test('initialize preserves an existing alias that points to another collection', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    if (method === 'GET' && url.endsWith('/collections/knowledge-1536-v1')) return response({
      result: { config: { params: { vectors: { size: 1536, distance: 'Cosine' } } } },
    });
    if (method === 'GET' && url.endsWith('/aliases')) return response({
      result: { aliases: [{ alias_name: 'knowledge-current', collection_name: 'knowledge-3072-v1' }] },
    });
    return response();
  };

  await new QdrantVectorIndex(config()).initialize();

  assert.ok(calls.some((call) => call.method === 'GET' && call.url.endsWith('/aliases')));
  assert.ok(!calls.some((call) => call.method === 'POST' && call.url.endsWith('/collections/aliases')));
});

test('rejects an existing collection with incompatible vector settings', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => response({
    result: { config: { params: { vectors: { size: 3072, distance: 'Cosine' } } } },
  });

  await assert.rejects(
    new QdrantVectorIndex(config()).initialize(),
    /期望 1536\/Cosine/,
  );
});

test('search applies tenant, publication, layer, and effective-time filters', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let searchBody: Record<string, unknown> = {};
  let searchUrl = '';
  globalThis.fetch = async (input, init) => {
    searchUrl = String(input);
    searchBody = JSON.parse(String(init?.body));
    return response({
      result: { points: [{ id: 'point-1', score: 0.91, payload: {
        entryId: 'entry-1', chunkId: 'chunk-1', sequence: 2, content: '价格规则',
      } }] },
    });
  };

  const hits = await new QdrantVectorIndex(config()).search({
    organizationId: 'org-a',
    vector: [0.1, 0.2],
    nowEpoch: 1784678400,
    limit: 30,
  });

  assert.deepEqual(searchBody.filter, {
    must: [
      { key: 'organizationId', match: { value: 'org-a' } },
      { key: 'status', match: { value: 'published' } },
      { key: 'layer', match: { any: ['L2', 'L3'] } },
    ],
    must_not: [
      { key: 'effectiveFromEpoch', range: { gt: 1784678400 } },
      { key: 'effectiveToEpoch', range: { lt: 1784678400 } },
    ],
  });
  assert.match(searchUrl, /\/collections\/knowledge-current\/points\/query$/);
  assert.deepEqual(hits, [{
    id: 'point-1', score: 0.91, entryId: 'entry-1', chunkId: 'chunk-1', sequence: 2, content: '价格规则',
  }]);
});

test('replaceEntry upserts current point IDs before deleting stale point IDs', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return response();
  };
  const point: KnowledgeVectorPoint = {
    id: '11111111-1111-4111-8111-111111111111',
    vector: [0.1, 0.2],
    model: 'gemini-embedding-2-preview',
    modelVersion: 'gemini-embedding-2-preview',
    chunk: {
      id: '11111111-1111-4111-8111-111111111111',
      organizationId: 'org-a',
      entryId: 'entry-1',
      sequence: 0,
      layer: 'L3',
      category: '价格与版本',
      businessCategory: '产品资料',
      title: '企业版价格',
      breadcrumb: '产品A',
      content: '价格规则',
      embeddingText: 'title: 企业版价格 | text: 价格规则',
      contentType: 'document',
      tokenCount: 4,
      contentHash: 'hash',
      sourceFileIds: [],
      sourceSectionIds: [],
    },
  };

  await new QdrantVectorIndex(config()).replaceEntry('org-a', 'entry-1', [point]);

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/collections\/knowledge-1536-v1\/points\?wait=true$/);
  assert.match(calls[1]!.url, /\/collections\/knowledge-1536-v1\/points\/delete\?wait=true$/);
  assert.deepEqual(calls[1]!.body, {
    filter: {
      must: [
        { key: 'organizationId', match: { value: 'org-a' } },
        { key: 'entryId', match: { value: 'entry-1' } },
      ],
      must_not: [{ has_id: [point.id] }],
    },
  });
  const stored = (calls[0]!.body.points as Array<{ payload: Record<string, unknown> }>)[0]!;
  assert.equal(stored.payload.embeddingText, undefined);
});

test('atomically switches an existing alias to the configured physical collection', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return response({
      result: { aliases: [{ alias_name: 'knowledge-current', collection_name: 'knowledge-3072-v1' }] },
    });
    return response();
  };

  await new QdrantVectorIndex(config()).switchAlias();

  assert.equal(calls[0]?.method, 'GET');
  assert.match(calls[0]?.url ?? '', /\/aliases$/);
  assert.deepEqual(calls.at(-1)?.body, { actions: [
    { delete_alias: { alias_name: 'knowledge-current' } },
    { create_alias: { collection_name: 'knowledge-1536-v1', alias_name: 'knowledge-current' } },
  ] });
});
