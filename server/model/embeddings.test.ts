import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import {
  createKnowledgeEmbedding,
  formatRetrievalDocument,
  formatRetrievalQuery,
} from './embeddings.js';

function config(): AppConfig {
  return {
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
    modelAuthMode: 'api_key_header',
    modelBaseUrl: 'https://yunwu.example',
    modelApiKey: 'test-key',
    embeddingApiStyle: 'gemini_generate_content',
    embeddingBaseUrl: 'https://yunwu.example',
    embeddingApiKey: 'test-key',
    embeddingModelName: 'gemini-embedding-2-preview',
    embeddingDimensions: 3072,
    knowledgeImportMaxTotalMb: 250,
    s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true },
  };
}

function openAiEmbeddingConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...config(),
    modelApiStyle: 'gemini_generate_content',
    embeddingApiStyle: 'openai',
    embeddingBaseUrl: 'https://yunwu.example',
    embeddingApiKey: 'embedding-test-key',
    embeddingModelName: 'text-embedding-3-small',
    embeddingDimensions: 1536,
    ...overrides,
  };
}

test('formats asymmetric retrieval inputs', () => {
  assert.equal(
    formatRetrievalDocument('产品A > 企业版', '价格为原文审核价'),
    'title: 产品A > 企业版 | text: 价格为原文审核价',
  );
  assert.equal(
    formatRetrievalQuery('客户觉得企业版太贵'),
    'task: search result | query: 客户觉得企业版太贵',
  );
});

test('calls Yunwu Gemini embedding endpoint and parses a 3072-dimensional vector', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = '';
  let capturedHeaders: Headers | undefined;
  let capturedBody: unknown;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      embedding: { values: Array.from({ length: 3072 }, (_, index) => index / 3072) },
      usageMetadata: { promptTokenCount: 5 },
      modelVersion: 'gemini-embedding-2-preview',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await createKnowledgeEmbedding('测试', config());

  assert.equal(capturedUrl, 'https://yunwu.example/v1beta/models/gemini-embedding-2-preview:generateContent');
  assert.equal(capturedHeaders?.get('x-goog-api-key'), 'test-key');
  assert.deepEqual(capturedBody, { content: { parts: [{ text: '测试' }] } });
  assert.equal(result?.vector.length, 3072);
  assert.equal(result?.modelVersion, 'gemini-embedding-2-preview');
  assert.equal(result?.inputTokens, 5);
});

test('rejects a vector with the wrong dimensions', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    embedding: { values: [0.1, 0.2] },
    modelVersion: 'bad-shape',
  }), { status: 200 });

  await assert.rejects(
    createKnowledgeEmbedding('测试', config()),
    /向量维度不匹配：期望 3072，实际 2/,
  );
});

test('uses independent OpenAI embedding settings while generation remains Gemini', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  let capturedBody: unknown;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      model: 'text-embedding-3-small',
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }],
      usage: { prompt_tokens: 12, total_tokens: 12 },
    }), { status: 200 });
  };

  const result = await createKnowledgeEmbedding('测试', openAiEmbeddingConfig());

  assert.equal(capturedUrl, 'https://yunwu.example/v1/embeddings');
  assert.equal(capturedHeaders.get('authorization'), 'Bearer embedding-test-key');
  assert.deepEqual(capturedBody, { model: 'text-embedding-3-small', input: '测试' });
  assert.equal(result?.vector.length, 1536);
  assert.equal(result?.inputTokens, 12);
});

test('does not duplicate v1 in an OpenAI embedding base URL', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let capturedUrl = '';
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] }), { status: 200 });
  };

  await createKnowledgeEmbedding('测试', openAiEmbeddingConfig({ embeddingBaseUrl: 'https://yunwu.example/v1/' }));

  assert.equal(capturedUrl, 'https://yunwu.example/v1/embeddings');
});

test('falls back to model base URL and key when embedding overrides are absent', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let authorization = '';
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }] }), { status: 200 });
  };
  const input = openAiEmbeddingConfig({ embeddingBaseUrl: undefined, embeddingApiKey: undefined });

  await createKnowledgeEmbedding('测试', input);

  assert.equal(authorization, `Bearer ${input.modelApiKey}`);
});
