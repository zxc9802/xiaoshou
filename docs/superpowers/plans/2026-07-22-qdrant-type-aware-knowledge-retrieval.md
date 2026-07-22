# Qdrant Type-Aware Knowledge Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved pipeline that turns reviewed type-aware knowledge chunks into 3072-dimensional Gemini embeddings stored and searched in Qdrant, with durable indexing jobs and keyword fallback.

**Architecture:** Keep the current repository as the source of truth and introduce Qdrant as a rebuildable retrieval index. Published L2/L3 knowledge is converted into deterministic retrieval chunks, embedded through the confirmed Yunwu Gemini endpoint, and indexed by a durable worker; retrieval queries Qdrant first and reranks a small candidate set with the existing lexical/category logic.

**Tech Stack:** Node.js 24, TypeScript, Fastify, built-in `fetch`, PostgreSQL/file/memory repositories, Qdrant REST API, Gemini-compatible Yunwu API, Node test runner.

---

## Workspace constraint

`D:\销转智能体` and `D:\销转智能体\12` are not Git repositories. Do not initialize Git, create a worktree, or invent commit history without user authorization. Every task therefore ends with a verification checkpoint instead of a commit. If the user later places the project under Git, convert each checkpoint into a focused commit containing only the listed files.

## Scope check

This is one vertical feature, not several independent products. Chunking, embedding, durable indexing, Qdrant storage, lifecycle synchronization, and retrieval must ship together to produce working software. OCR model replacement and sparse-vector hybrid retrieval remain out of scope.

## File map

### Create

- `server/knowledge/chunking.ts` — detect source type and build deterministic retrieval chunks.
- `server/knowledge/chunking.test.ts` — type-aware chunking tests.
- `server/model/embeddings.test.ts` — confirmed Yunwu request/response contract tests.
- `server/infrastructure/vectorIndex.ts` — vector-index interfaces, payload types, and disabled implementation.
- `server/infrastructure/qdrantVectorIndex.ts` — Qdrant REST adapter.
- `server/infrastructure/qdrantVectorIndex.test.ts` — Qdrant request-shape and response parsing tests.
- `server/knowledgeIndexService.ts` — durable scheduling, embedding, Qdrant replacement, retries, and status writeback.
- `server/knowledgeIndexService.test.ts` — indexing workflow tests with fakes.
- `server/scripts/reindexKnowledge.ts` — explicit full-reindex command.
- `docker-compose.qdrant.yml` — pinned local Qdrant service with persistent storage.

### Modify

- `server/config.ts` — embedding dimension and Qdrant configuration.
- `server/model/embeddings.ts` — Gemini generateContent embedding protocol and retrieval prefixes.
- `server/domain.ts` — durable knowledge-index job and repository methods.
- `server/infrastructure/memoryRepository.ts` — in-memory index-job queue.
- `server/infrastructure/fileRepository.ts` — persisted index-job queue with backward-compatible snapshot loading.
- `server/infrastructure/postgresRepository.ts` — transactional index-job claim/update.
- `server/infrastructure/filePersistence.test.ts` — index-job persistence coverage.
- `server/db/schema.sql` — `knowledge_index_jobs` table and claim indexes.
- `server/knowledgeService.ts` — schedule upsert/delete on every L2/L3 lifecycle path and stop storing vectors inline.
- `server/knowledge/importWorkflow.test.ts` — import publication indexing coverage.
- `server/knowledge/knowledgeLifecycle.test.ts` — publish/update/archive/trash/restore/delete scheduling coverage.
- `server/knowledge/retrieval.ts` — Qdrant candidate retrieval, reranking, dedupe, and fallback.
- `server/knowledge/retrieval.test.ts` — vector and fallback retrieval tests.
- `server/analysisService.ts` — pass organization-scoped vector index into retrieval.
- `server/analysisService.stability.test.ts` — preserve external worker behavior.
- `server/index.ts` — create services, initialize Qdrant, inline index loop, and health state.
- `server/worker.ts` — process analysis jobs and knowledge-index jobs.
- `package.json` — reindex and Qdrant convenience scripts.
- `.env.example` — safe configuration examples.
- `README.md` — local startup, reindex, health, and recovery instructions.
- `DEPLOYMENT.md` — production Qdrant security, snapshots/rebuild, and rollout.

### Local-only configuration

- `.env` — set the model name and local Qdrant URL without printing or replacing the existing secret. This file must not be copied into documentation or command output.

## Task 1: Implement the confirmed Gemini embedding protocol

**Files:**
- Create: `server/model/embeddings.test.ts`
- Modify: `server/model/embeddings.ts`
- Modify: `server/config.ts`

- [ ] **Step 1: Write the failing Gemini contract test**

Create `server/model/embeddings.test.ts` with the actual request and response shape already confirmed against Yunwu:

```typescript
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
    embeddingModelName: 'gemini-embedding-2-preview',
    embeddingDimensions: 3072,
    knowledgeImportMaxTotalMb: 250,
    s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true },
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
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts
```

Expected: FAIL because `formatRetrievalDocument`, `formatRetrievalQuery`, `embeddingDimensions`, and the Gemini response parser do not exist.

- [ ] **Step 3: Add embedding configuration**

Add this optional-compatible field to `AppConfig` so existing test literals continue compiling:

```typescript
embeddingDimensions?: number;
qdrantUrl?: string;
qdrantApiKey?: string;
qdrantCollectionName?: string;
qdrantCollectionAlias?: string;
qdrantTimeoutMs?: number;
```

Add these values to `loadConfig()`:

```typescript
embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 3072),
qdrantUrl: process.env.QDRANT_URL,
qdrantApiKey: process.env.QDRANT_API_KEY,
qdrantCollectionName: process.env.QDRANT_COLLECTION_NAME ?? 'sales_knowledge_gemini_embedding_2_preview_3072_v1',
qdrantCollectionAlias: process.env.QDRANT_COLLECTION_ALIAS ?? 'sales_knowledge_current',
qdrantTimeoutMs: Number(process.env.QDRANT_TIMEOUT_MS ?? 10_000),
```

- [ ] **Step 4: Replace the embedding adapter with both supported protocols**

Keep OpenAI-compatible `/embeddings` support, but route `gemini_generate_content` through the confirmed endpoint:

```typescript
import type { AppConfig } from '../config.js';

export interface EmbeddingResult {
  model: string;
  modelVersion?: string;
  inputTokens?: number;
  vector: number[];
}

export function formatRetrievalDocument(title: string, text: string) {
  return `title: ${title.trim() || 'none'} | text: ${text.trim()}`;
}

export function formatRetrievalQuery(query: string) {
  return `task: search result | query: ${query.trim()}`;
}

function validateVector(vector: unknown, expectedDimensions: number) {
  if (!Array.isArray(vector) || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('向量服务未返回有效数值数组');
  }
  if (vector.length !== expectedDimensions) {
    throw new Error(`向量维度不匹配：期望 ${expectedDimensions}，实际 ${vector.length}`);
  }
  return vector as number[];
}

export async function createKnowledgeEmbedding(text: string, config: AppConfig): Promise<EmbeddingResult | undefined> {
  const model = config.embeddingModelName;
  const expectedDimensions = config.embeddingDimensions ?? 3072;
  if (config.modelDriver !== 'openai_compatible' || !config.modelBaseUrl || !config.modelApiKey || !model) return undefined;
  const baseUrl = config.modelBaseUrl.replace(/\/$/, '');

  if (config.modelApiStyle === 'gemini_generate_content') {
    const response = await fetch(
      `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': config.modelApiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      },
    );
    if (!response.ok) throw new Error(`向量生成失败：${response.status}`);
    const body = await response.json() as {
      embedding?: { values?: number[] };
      usageMetadata?: { promptTokenCount?: number };
      modelVersion?: string;
    };
    return {
      model,
      modelVersion: body.modelVersion,
      inputTokens: body.usageMetadata?.promptTokenCount,
      vector: validateVector(body.embedding?.values, expectedDimensions),
    };
  }

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.modelApiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) throw new Error(`向量生成失败：${response.status}`);
  const body = await response.json() as { data?: Array<{ embedding?: number[] }> };
  return { model, vector: validateVector(body.data?.[0]?.embedding, expectedDimensions) };
}
```

- [ ] **Step 5: Run embedding tests**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Verification checkpoint**

Run:

```powershell
npm.cmd run typecheck
```

Expected: PASS. Do not commit because the workspace has no Git repository.

## Task 2: Build deterministic type-aware retrieval chunks

**Files:**
- Create: `server/knowledge/chunking.ts`
- Create: `server/knowledge/chunking.test.ts`

- [ ] **Step 1: Write failing tests for the non-negotiable boundaries**

Create tests covering short atomic facts, document paragraphs, chat turns, tables, and video ranges:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { buildKnowledgeChunks, estimateTokens } from './chunking.js';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = '2026-07-22T00:00:00.000Z';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    layer: 'L3',
    category: '价格与版本',
    title: '产品A企业版价格',
    content: '企业版价格为审核价，折扣必须审批，有效期以报价单为准。',
    version: '1.0',
    status: 'published',
    createdAt: now,
    updatedAt: now,
    structuredData: {
      businessCategory: '产品资料',
      sourceReferences: [{ sourceFileName: '产品A报价.docx', location: '价格政策' }],
    },
    ...overrides,
  };
}

test('keeps a short price rule atomic and adds retrieval context', () => {
  const chunks = buildKnowledgeChunks('org-a', entry());
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.embeddingText, /^title: 产品A企业版价格 \| text:/);
  assert.match(chunks[0]!.content, /折扣必须审批/);
});

test('splits a long document only on paragraph boundaries', () => {
  const paragraph = '这是一个完整章节段落，包含产品能力、使用条件和审核说明。'.repeat(20);
  const chunks = buildKnowledgeChunks('org-a', entry({
    content: [paragraph, paragraph, paragraph].join('\n\n'),
  }));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => estimateTokens(chunk.content) <= 1000));
  assert.ok(chunks.every((chunk) => !chunk.content.startsWith('，')));
});

test('preserves chat turns and overlaps exactly two complete turns', () => {
  const messages = Array.from({ length: 20 }, (_, index) =>
    `${index % 2 ? '销售' : '客户'}：第${index + 1}轮完整消息，围绕价格异议继续沟通。`,
  );
  const chunks = buildKnowledgeChunks('org-a', entry({
    layer: 'L2',
    category: '价格异议',
    content: messages.join('\n'),
    structuredData: {
      businessCategory: '销售技巧',
      sourceReferences: [{ sourceFileName: '聊天截图.png', location: '截图 1-4' }],
    },
  }));
  assert.ok(chunks.length >= 2);
  const previousTail = chunks[0]!.content.split('\n').slice(-2);
  const nextHead = chunks[1]!.content.split('\n').slice(0, 2);
  assert.deepEqual(nextHead, previousTail);
});

test('repeats table headers and never splits a row', () => {
  const rows = ['套餐,价格,条件'];
  for (let index = 1; index <= 70; index += 1) rows.push(`套餐${index},${index * 100},需审批`);
  const chunks = buildKnowledgeChunks('org-a', entry({
    content: rows.join('\n'),
    structuredData: {
      businessCategory: '产品资料',
      sourceReferences: [{ sourceFileName: '报价.csv', location: 'Sheet1' }],
    },
  }));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.startsWith('套餐,价格,条件')));
  assert.equal(chunks.flatMap((chunk) => chunk.content.split('\n').slice(1)).length, 70);
});

test('uses stable IDs and preserves video time metadata', () => {
  const input = entry({
    layer: 'L2',
    content: '完整视频章节知识。',
    structuredData: {
      businessCategory: '销售技巧',
      timeRange: { startSeconds: 45, endSeconds: 96 },
      mediaAssets: [{ id: 'video-1', name: '复盘.mp4', mimeType: 'video/mp4', size: 10, kind: 'video', createdAt: '2026-07-22T00:00:00.000Z' }],
    },
  });
  const first = buildKnowledgeChunks('org-a', input)[0]!;
  const second = buildKnowledgeChunks('org-a', input)[0]!;
  assert.equal(first.id, second.id);
  assert.deepEqual(first.timeRange, { startSeconds: 45, endSeconds: 96 });
  assert.equal(first.contentType, 'video');
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --import tsx --test server/knowledge/chunking.test.ts
```

Expected: FAIL because `chunking.ts` does not exist.

- [ ] **Step 3: Define the complete chunk contract**

Create `server/knowledge/chunking.ts` with these exported types:

```typescript
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { formatRetrievalDocument } from '../model/embeddings.js';

export type KnowledgeContentType =
  | 'document'
  | 'pdf'
  | 'presentation'
  | 'table'
  | 'json'
  | 'chat'
  | 'image'
  | 'video'
  | 'audio'
  | 'text';

export interface KnowledgeChunk {
  id: string;
  organizationId: string;
  entryId: string;
  sequence: number;
  layer: 'L2' | 'L3';
  category: string;
  businessCategory: string;
  title: string;
  breadcrumb: string;
  content: string;
  embeddingText: string;
  contentType: KnowledgeContentType;
  tokenCount: number;
  contentHash: string;
  productId?: string;
  packageId?: string;
  sourceFileIds: string[];
  sourceSectionIds: string[];
  effectiveFromEpoch?: number;
  effectiveToEpoch?: number;
  timeRange?: { startSeconds: number; endSeconds: number };
}
```

- [ ] **Step 4: Implement the deterministic helpers**

Implement these exact rules in the same file:

```typescript
export function estimateTokens(value: string) {
  const chinese = value.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const other = value.replace(/[\u3400-\u9fff]/g, '').length;
  return chinese + Math.ceil(other / 4);
}

function clean(value: string) {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(seed: string) {
  const hex = sha256(seed).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function epoch(value?: string) {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function sourceNames(entry: KnowledgeEntry) {
  const references = Array.isArray(entry.structuredData?.sourceReferences)
    ? entry.structuredData.sourceReferences as Array<{ sourceFileName?: string }>
    : [];
  const media = Array.isArray(entry.structuredData?.mediaAssets)
    ? entry.structuredData.mediaAssets as Array<{ name?: string; mimeType?: string }>
    : [];
  return [...references.map((item) => item.sourceFileName ?? ''), ...media.map((item) => item.name ?? '')].filter(Boolean);
}

function detectContentType(entry: KnowledgeEntry): KnowledgeContentType {
  const names = sourceNames(entry);
  const extensions = names.map((name) => extname(name).toLowerCase());
  if (entry.structuredData?.timeRange) return 'video';
  if (extensions.some((value) => ['.csv', '.xlsx', '.xls'].includes(value))) return 'table';
  if (extensions.includes('.pdf')) return 'pdf';
  if (extensions.includes('.pptx')) return 'presentation';
  if (extensions.includes('.json')) return 'json';
  if (extensions.some((value) => ['.png', '.jpg', '.jpeg', '.webp'].includes(value))) {
    return /(?:销售|客户|sales|customer)[：:]/i.test(entry.content) ? 'chat' : 'image';
  }
  if (extensions.some((value) => ['.mp4', '.mov', '.mkv'].includes(value))) return 'video';
  if (extensions.some((value) => ['.mp3', '.wav', '.m4a'].includes(value))) return 'audio';
  if (extensions.some((value) => ['.docx', '.doc', '.md', '.html', '.htm'].includes(value))) return 'document';
  return 'text';
}

function splitLongUnit(value: string, maxTokens = 1000) {
  const sentences = clean(value).split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && estimateTokens(`${current}${sentence}`) > maxTokens) {
      parts.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [clean(value)];
}

function pack(units: string[], targetTokens: number, maxTokens: number, overlapUnits = 0) {
  const result: string[] = [];
  let current: string[] = [];
  for (const raw of units.flatMap((unit) => estimateTokens(unit) > maxTokens ? splitLongUnit(unit, maxTokens) : [unit])) {
    if (current.length && estimateTokens([...current, raw].join('\n\n')) > targetTokens) {
      result.push(clean(current.join('\n\n')));
      current = overlapUnits ? current.slice(-overlapUnits) : [];
    }
    current.push(raw);
  }
  if (current.length) result.push(clean(current.join('\n\n')));
  return result.filter(Boolean);
}

function splitTable(content: string) {
  const lines = clean(content).split('\n').filter(Boolean);
  if (lines.length <= 1) return [clean(content)];
  const header = lines[0]!;
  return Array.from({ length: Math.ceil((lines.length - 1) / 30) }, (_, index) =>
    [header, ...lines.slice(1 + index * 30, 1 + (index + 1) * 30)].join('\n'),
  );
}

function splitChat(content: string) {
  const turns = clean(content).split('\n').filter(Boolean);
  if (turns.length <= 16) return [turns.join('\n')];
  const chunks: string[] = [];
  for (let index = 0; index < turns.length; index += 14) {
    const start = index === 0 ? 0 : Math.max(0, index - 2);
    chunks.push(turns.slice(start, Math.min(turns.length, index + 14)).join('\n'));
  }
  return chunks;
}
```

- [ ] **Step 5: Implement `buildKnowledgeChunks`**

Use the source type to choose the boundary strategy, then create stable chunks:

```typescript
export function buildKnowledgeChunks(organizationId: string, entry: KnowledgeEntry): KnowledgeChunk[] {
  if ((entry.layer !== 'L2' && entry.layer !== 'L3') || entry.status !== 'published' || entry.deletedAt) return [];
  const contentType = detectContentType(entry);
  const content = clean(entry.content);
  const parts = contentType === 'table'
    ? splitTable(content)
    : contentType === 'chat'
      ? splitChat(content)
      : estimateTokens(content) <= 1000
        ? [content]
        : pack(content.split(/\n{2,}/).filter(Boolean), 700, 1000, 1);
  const businessCategory = String(entry.structuredData?.businessCategory ?? entry.category);
  const productName = String(entry.structuredData?.suggestedProductName ?? '').trim();
  const packageName = String(entry.structuredData?.suggestedPackageName ?? '').trim();
  const breadcrumb = [productName, packageName, businessCategory, entry.category].filter(Boolean).join(' > ');
  const sourceFileIds = Array.isArray(entry.structuredData?.sourceFileIds)
    ? entry.structuredData.sourceFileIds.map(String)
    : [];
  const sourceSectionIds = Array.isArray(entry.structuredData?.sourceSectionIds)
    ? entry.structuredData.sourceSectionIds.map(String)
    : [];
  const timeRange = entry.structuredData?.timeRange as { startSeconds: number; endSeconds: number } | undefined;
  return parts.map((part, sequence) => {
    const contentHash = sha256([entry.id, entry.version, entry.title, part, sequence].join('\n'));
    const title = breadcrumb ? `${breadcrumb} > ${entry.title}` : entry.title;
    return {
      id: deterministicUuid(`${organizationId}:${entry.id}:${contentHash}:${sequence}`),
      organizationId,
      entryId: entry.id,
      sequence,
      layer: entry.layer as 'L2' | 'L3',
      category: entry.category,
      businessCategory,
      title: entry.title,
      breadcrumb,
      content: part,
      embeddingText: formatRetrievalDocument(title, part),
      contentType,
      tokenCount: estimateTokens(part),
      contentHash,
      productId: entry.productId,
      packageId: entry.packageId,
      sourceFileIds,
      sourceSectionIds,
      effectiveFromEpoch: epoch(entry.effectiveFrom),
      effectiveToEpoch: epoch(entry.effectiveTo),
      timeRange,
    };
  });
}
```

- [ ] **Step 6: Run chunking tests**

Run:

```powershell
node --import tsx --test server/knowledge/chunking.test.ts
```

Expected: all tests PASS. If a long single sentence still exceeds 1000 estimated tokens, extend `splitLongUnit` with a final conservative character window that cuts only after punctuation where possible.

- [ ] **Step 7: Verification checkpoint**

Run:

```powershell
npm.cmd run typecheck
```

Expected: PASS.

## Task 3: Add the Qdrant vector-index boundary and REST adapter

**Files:**
- Create: `server/infrastructure/vectorIndex.ts`
- Create: `server/infrastructure/qdrantVectorIndex.ts`
- Create: `server/infrastructure/qdrantVectorIndex.test.ts`

- [ ] **Step 1: Write the vector-index interface**

Create `server/infrastructure/vectorIndex.ts`:

```typescript
import type { KnowledgeChunk } from '../knowledge/chunking.js';

export interface KnowledgeVectorPoint {
  id: string;
  vector: number[];
  chunk: KnowledgeChunk;
  model: string;
  modelVersion?: string;
}

export interface KnowledgeVectorHit {
  id: string;
  score: number;
  entryId: string;
  chunkId: string;
  sequence: number;
  content: string;
}

export interface KnowledgeVectorIndex {
  initialize(): Promise<void>;
  replaceEntry(organizationId: string, entryId: string, points: KnowledgeVectorPoint[]): Promise<void>;
  deleteEntry(organizationId: string, entryId: string): Promise<void>;
  search(input: {
    organizationId: string;
    vector: number[];
    nowEpoch: number;
    limit: number;
  }): Promise<KnowledgeVectorHit[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class DisabledVectorIndex implements KnowledgeVectorIndex {
  async initialize() {}
  async replaceEntry() {}
  async deleteEntry() {}
  async search() { return []; }
  async health() { return { ok: false, detail: 'Qdrant未配置' }; }
}
```

- [ ] **Step 2: Write failing Qdrant request tests**

The tests must mock `fetch` and assert:

1. Collection creation uses size 3072 and Cosine, and an existing incompatible collection is rejected.
2. `organizationId` gets a keyword tenant index.
3. Search always filters organization, published, L2/L3, future-effective, and expired content.
4. `replaceEntry` upserts new IDs before deleting stale IDs.
5. API key is sent as `api-key` and never appears in the URL.

Use this search assertion:

```typescript
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
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```powershell
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
```

Expected: FAIL because `QdrantVectorIndex` does not exist.

- [ ] **Step 4: Implement the minimal REST adapter**

Create `server/infrastructure/qdrantVectorIndex.ts` with one private request method and these public operations:

```typescript
import type { AppConfig } from '../config.js';
import type {
  KnowledgeVectorHit,
  KnowledgeVectorIndex,
  KnowledgeVectorPoint,
} from './vectorIndex.js';

export class QdrantVectorIndex implements KnowledgeVectorIndex {
  private initialized = false;
  private readonly baseUrl: string;
  private readonly collectionName: string;
  private readonly alias: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly dimensions: number;

  constructor(config: AppConfig) {
    if (!config.qdrantUrl) throw new Error('QDRANT_URL is required');
    this.baseUrl = config.qdrantUrl.replace(/\/$/, '');
    this.collectionName = config.qdrantCollectionName ?? 'sales_knowledge_gemini_embedding_2_preview_3072_v1';
    this.alias = config.qdrantCollectionAlias ?? 'sales_knowledge_current';
    this.apiKey = config.qdrantApiKey;
    this.timeoutMs = config.qdrantTimeoutMs ?? 10_000;
    this.dimensions = config.embeddingDimensions ?? 3072;
  }

  private async request<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | undefined> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Qdrant请求失败：${method} ${path} -> ${response.status}`);
    return response.status === 204 ? undefined : await response.json() as T;
  }

  async initialize() {
    if (this.initialized) return;
    const existing = await this.request('GET', `/collections/${encodeURIComponent(this.collectionName)}`, undefined, true);
    if (!existing) {
      await this.request('PUT', `/collections/${encodeURIComponent(this.collectionName)}`, {
        vectors: { size: this.dimensions, distance: 'Cosine' },
      });
    } else {
      const collection = existing as {
        result?: { config?: { params?: { vectors?: { size?: number; distance?: string } } } };
      };
      const vectorConfig = collection.result?.config?.params?.vectors;
      if (vectorConfig?.size !== this.dimensions || vectorConfig?.distance !== 'Cosine') {
        throw new Error(`Qdrant collection配置不匹配：期望 ${this.dimensions}/Cosine`);
      }
    }
    const indexes: Array<[string, unknown]> = [
      ['organizationId', { type: 'keyword', is_tenant: true }],
      ['entryId', 'keyword'],
      ['layer', 'keyword'],
      ['status', 'keyword'],
      ['productId', 'keyword'],
      ['packageId', 'keyword'],
      ['businessCategory', 'keyword'],
      ['category', 'keyword'],
      ['contentType', 'keyword'],
      ['effectiveFromEpoch', 'integer'],
      ['effectiveToEpoch', 'integer'],
    ];
    for (const [field_name, field_schema] of indexes) {
      await this.request('PUT', `/collections/${encodeURIComponent(this.collectionName)}/index?wait=true`, {
        field_name,
        field_schema,
      });
    }
    const alias = await this.request('GET', `/aliases/${encodeURIComponent(this.alias)}`, undefined, true);
    if (!alias) {
      await this.request('POST', '/collections/aliases', {
        actions: [{ create_alias: { collection_name: this.collectionName, alias_name: this.alias } }],
      });
    }
    this.initialized = true;
  }

  async replaceEntry(organizationId: string, entryId: string, points: KnowledgeVectorPoint[]) {
    if (points.length) {
      await this.request('PUT', `/collections/${encodeURIComponent(this.alias)}/points?wait=true`, {
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: {
            ...point.chunk,
            chunkId: point.chunk.id,
            status: 'published',
            embeddingModel: point.model,
            embeddingModelVersion: point.modelVersion,
            embeddingDimensions: point.vector.length,
            embeddingText: undefined,
          },
        })),
      });
    }
    const must = [
      { key: 'organizationId', match: { value: organizationId } },
      { key: 'entryId', match: { value: entryId } },
    ];
    await this.request('POST', `/collections/${encodeURIComponent(this.alias)}/points/delete?wait=true`, {
      filter: points.length
        ? { must, must_not: [{ has_id: points.map((point) => point.id) }] }
        : { must },
    });
  }

  async deleteEntry(organizationId: string, entryId: string) {
    await this.replaceEntry(organizationId, entryId, []);
  }

  async search(input: { organizationId: string; vector: number[]; nowEpoch: number; limit: number }) {
    const response = await this.request<{
      result?: { points?: Array<{ id: string; score: number; payload?: Record<string, unknown> }> };
    }>('POST', `/collections/${encodeURIComponent(this.alias)}/points/query`, {
      query: input.vector,
      filter: {
        must: [
          { key: 'organizationId', match: { value: input.organizationId } },
          { key: 'status', match: { value: 'published' } },
          { key: 'layer', match: { any: ['L2', 'L3'] } },
        ],
        must_not: [
          { key: 'effectiveFromEpoch', range: { gt: input.nowEpoch } },
          { key: 'effectiveToEpoch', range: { lt: input.nowEpoch } },
        ],
      },
      limit: input.limit,
      with_payload: true,
    });
    return (response?.result?.points ?? []).flatMap((point): KnowledgeVectorHit[] => {
      const payload = point.payload ?? {};
      return typeof payload.entryId === 'string' && typeof payload.chunkId === 'string'
        ? [{
            id: String(point.id),
            score: point.score,
            entryId: payload.entryId,
            chunkId: payload.chunkId,
            sequence: Number(payload.sequence ?? 0),
            content: String(payload.content ?? ''),
          }]
        : [];
    });
  }

  async health() {
    try {
      await this.request('GET', `/collections/${encodeURIComponent(this.alias)}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Qdrant不可用' };
    }
  }
}
```

- [ ] **Step 5: Run Qdrant adapter tests**

Run:

```powershell
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
```

Expected: all request contract tests PASS.

- [ ] **Step 6: Verification checkpoint**

Run `npm.cmd run typecheck`. Expected: PASS.

## Task 4: Add durable knowledge-index jobs to every repository

**Files:**
- Modify: `server/domain.ts`
- Modify: `server/infrastructure/memoryRepository.ts`
- Modify: `server/infrastructure/fileRepository.ts`
- Modify: `server/infrastructure/postgresRepository.ts`
- Modify: `server/infrastructure/filePersistence.test.ts`
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Define the durable job**

Add to `server/domain.ts`:

```typescript
export interface StoredKnowledgeIndexJob {
  id: string;
  organizationId: string;
  entryId: string;
  action: 'upsert' | 'delete';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
```

Add to `Repository`:

```typescript
createKnowledgeIndexJob(job: StoredKnowledgeIndexJob): Promise<void>;
getKnowledgeIndexJob(id: string): Promise<StoredKnowledgeIndexJob | undefined>;
updateKnowledgeIndexJob(job: StoredKnowledgeIndexJob): Promise<void>;
claimNextKnowledgeIndexJob(): Promise<StoredKnowledgeIndexJob | undefined>;
listKnowledgeIndexJobs(organizationId: string, limit: number): Promise<StoredKnowledgeIndexJob[]>;
```

- [ ] **Step 2: Write the failing file-persistence test**

Extend `server/infrastructure/filePersistence.test.ts`:

```typescript
test('knowledge index jobs survive file repository restart and can be claimed once', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'sales-index-jobs-'));
  const file = join(folder, 'repository.json');
  const now = new Date().toISOString();
  const first = new FileRepository(file);
  await first.createKnowledgeIndexJob({
    id: 'index-job-1',
    organizationId: 'org-a',
    entryId: 'entry-1',
    action: 'upsert',
    status: 'queued',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  const second = new FileRepository(file);
  const claimed = await second.claimNextKnowledgeIndexJob();
  assert.equal(claimed?.id, 'index-job-1');
  assert.equal(claimed?.status, 'processing');
  assert.equal(await second.claimNextKnowledgeIndexJob(), undefined);
  await rm(folder, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run:

```powershell
node --import tsx --test server/infrastructure/filePersistence.test.ts
```

Expected: FAIL because repository methods do not exist.

- [ ] **Step 4: Implement memory and file queues**

For both repositories:

- Store jobs in `Map<string, StoredKnowledgeIndexJob>`.
- A claimable job is `queued`, or `failed` with `nextAttemptAt <= now` and fewer than 5 attempts.
- Claim updates status to `processing`, increments attempts, and updates the timestamp.
- File snapshots accept versions 1, 2, and 3, read missing `knowledgeIndexJobs` as an empty array, and persist version 3.

The claim predicate must be:

```typescript
const now = Date.now();
const claimable = [...this.knowledgeIndexJobs.values()]
  .filter((job) =>
    (job.status === 'queued' || job.status === 'failed')
    && job.attempts < 5
    && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now),
  )
  .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
```

- [ ] **Step 5: Add the PostgreSQL table**

Append to `server/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS knowledge_index_jobs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  entry_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('upsert','delete')),
  status text NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_index_jobs_claim_idx
  ON knowledge_index_jobs (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS knowledge_index_jobs_entry_idx
  ON knowledge_index_jobs (organization_id, entry_id, created_at DESC);
```

- [ ] **Step 6: Implement transactional PostgreSQL claim**

Use `FOR UPDATE SKIP LOCKED` inside a transaction:

```sql
SELECT payload
FROM knowledge_index_jobs
WHERE status IN ('queued','failed')
  AND attempts < 5
  AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1
```

Update the selected payload to `processing`, increment attempts, persist it, then commit. Implement create/get/update/list with parameterized SQL and organization filtering.

- [ ] **Step 7: Run repository tests**

Run:

```powershell
node --import tsx --test server/infrastructure/filePersistence.test.ts
npm.cmd run typecheck
```

Expected: PASS.

## Task 5: Implement the durable indexing service

**Files:**
- Create: `server/knowledgeIndexService.ts`
- Create: `server/knowledgeIndexService.test.ts`

- [ ] **Step 1: Write fakes and failing workflow tests**

The tests must prove:

- Scheduling an upsert persists a queued job and marks the entry pending.
- Processing an upsert chunks the current published entry, embeds every chunk, and replaces Qdrant points.
- Processing a delete removes all points even when the business entry is already gone.
- Embedding or Qdrant failure marks the job failed with exponential retry and leaves the entry published.
- Scheduling always returns after durable queue persistence; inline and external workers both process through `processPending()`.

Use dependency injection:

```typescript
type EmbeddingFunction = (
  text: string,
  config: AppConfig,
) => Promise<EmbeddingResult | undefined>;
```

The fake vector index should record `replaceEntry` and `deleteEntry` calls rather than starting Qdrant.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
node --import tsx --test server/knowledgeIndexService.test.ts
```

Expected: FAIL because `KnowledgeIndexService` does not exist.

- [ ] **Step 3: Implement scheduling**

Create `KnowledgeIndexScheduler` and `KnowledgeIndexService`:

```typescript
export interface KnowledgeIndexScheduler {
  scheduleUpsert(organizationId: string, entryId: string): Promise<void>;
  scheduleDelete(organizationId: string, entryId: string): Promise<void>;
}

export class KnowledgeIndexService implements KnowledgeIndexScheduler {
  constructor(
    private readonly repository: Repository,
    private readonly vectorIndex: KnowledgeVectorIndex,
    private readonly config: AppConfig,
    private readonly embed: EmbeddingFunction = createKnowledgeEmbedding,
  ) {}

  async scheduleUpsert(organizationId: string, entryId: string) {
    await this.schedule(organizationId, entryId, 'upsert');
  }

  async scheduleDelete(organizationId: string, entryId: string) {
    await this.schedule(organizationId, entryId, 'delete');
  }

  private async schedule(organizationId: string, entryId: string, action: 'upsert' | 'delete') {
    const now = new Date().toISOString();
    const job: StoredKnowledgeIndexJob = {
      id: randomUUID(),
      organizationId,
      entryId,
      action,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createKnowledgeIndexJob(job);
  }
}
```

- [ ] **Step 4: Implement processing and status writeback**

Processing rules:

```typescript
async processPending() {
  await this.vectorIndex.initialize();
  const job = await this.repository.claimNextKnowledgeIndexJob();
  if (!job) return false;
  await this.processJob(job);
  return true;
}

private async processJob(job: StoredKnowledgeIndexJob) {
  try {
    const entry = await this.repository.getKnowledge(job.entryId);
    if (job.action === 'delete' || !entry || entry.status !== 'published' || (entry.layer !== 'L2' && entry.layer !== 'L3') || entry.deletedAt) {
      await this.vectorIndex.deleteEntry(job.organizationId, job.entryId);
    } else {
      const chunks = buildKnowledgeChunks(job.organizationId, entry);
      const points: KnowledgeVectorPoint[] = [];
      for (const chunk of chunks) {
        const embedding = await this.embed(chunk.embeddingText, this.config);
        if (!embedding) throw new Error('向量模型未配置');
        points.push({
          id: chunk.id,
          vector: embedding.vector,
          chunk,
          model: embedding.model,
          modelVersion: embedding.modelVersion,
        });
      }
      await this.vectorIndex.replaceEntry(job.organizationId, job.entryId, points);
      const latest = await this.repository.getKnowledge(job.entryId);
      if (latest) {
        await this.repository.updateKnowledge(job.organizationId, {
          ...latest,
          structuredData: {
            ...latest.structuredData,
            embedding: {
              status: 'indexed',
              model: this.config.embeddingModelName,
              dimensions: this.config.embeddingDimensions ?? 3072,
              chunkCount: points.length,
              indexedAt: new Date().toISOString(),
              contentHashes: points.map((point) => point.chunk.contentHash),
            },
          },
          updatedAt: new Date().toISOString(),
        });
      }
    }
    job.status = 'completed';
    job.lastError = undefined;
    job.nextAttemptAt = undefined;
  } catch (error) {
    job.status = 'failed';
    job.lastError = error instanceof Error ? error.message : '未知索引错误';
    const delayMs = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
    job.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    const failedEntry = await this.repository.getKnowledge(job.entryId);
    if (failedEntry) {
      await this.repository.updateKnowledge(job.organizationId, {
        ...failedEntry,
        structuredData: {
          ...failedEntry.structuredData,
          embedding: {
            status: 'failed',
            model: this.config.embeddingModelName,
            dimensions: this.config.embeddingDimensions ?? 3072,
            reason: job.lastError,
            attempts: job.attempts,
            lastAttemptAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      });
    }
  }
  job.updatedAt = new Date().toISOString();
  await this.repository.updateKnowledgeIndexJob(job);
}
```

When scheduling upsert, update an existing entry's embedding metadata to `pending` before creating the job. Catch metadata-update races by re-reading the latest entry.

- [ ] **Step 5: Run indexing-service tests**

Run:

```powershell
node --import tsx --test server/knowledgeIndexService.test.ts
```

Expected: all workflow tests PASS.

- [ ] **Step 6: Verification checkpoint**

Run `npm.cmd run typecheck`. Expected: PASS.

## Task 6: Wire every knowledge lifecycle path to the index queue

**Files:**
- Modify: `server/knowledgeService.ts`
- Modify: `server/knowledge/importWorkflow.test.ts`
- Modify: `server/knowledge/knowledgeLifecycle.test.ts`

- [ ] **Step 1: Write lifecycle tests with a recording scheduler**

Add a fake:

```typescript
class RecordingIndexScheduler implements KnowledgeIndexScheduler {
  readonly upserts: Array<{ organizationId: string; entryId: string }> = [];
  readonly deletes: Array<{ organizationId: string; entryId: string }> = [];
  async scheduleUpsert(organizationId: string, entryId: string) {
    this.upserts.push({ organizationId, entryId });
  }
  async scheduleDelete(organizationId: string, entryId: string) {
    this.deletes.push({ organizationId, entryId });
  }
}
```

Tests must assert:

- Confirming an import creates published entries with pending metadata and schedules each entry once.
- Publishing a reviewed manual/uploaded L2/L3 entry schedules upsert.
- Updating title/content/category/version/effective dates on a published L2/L3 entry schedules upsert.
- Archiving, trashing, and permanently deleting schedules delete.
- Restoring an entry to a previously published state schedules upsert.
- L0/L1/L4 never schedule Qdrant indexing.

- [ ] **Step 2: Run focused lifecycle tests and confirm failure**

Run:

```powershell
node --import tsx --test server/knowledge/importWorkflow.test.ts server/knowledge/knowledgeLifecycle.test.ts
```

Expected: FAIL because `KnowledgeService` does not accept or invoke a scheduler.

- [ ] **Step 3: Inject the scheduler without breaking current tests**

Add a no-op default:

```typescript
const noIndexScheduler: KnowledgeIndexScheduler = {
  async scheduleUpsert() {},
  async scheduleDelete() {},
};

constructor(
  private readonly repository: Repository,
  private readonly storage: ObjectStorage,
  private readonly config: AppConfig,
  private readonly indexScheduler: KnowledgeIndexScheduler = noIndexScheduler,
) {
  this.products = new ProductService(repository);
}
```

- [ ] **Step 4: Replace inline vector storage in `confirmImport`**

Remove `embeddingMetadata()` and the full `vector` in `structuredData.embedding`. New published entries start with:

```typescript
embedding: {
  status: 'pending',
  model: this.config.embeddingModelName,
  dimensions: this.config.embeddingDimensions ?? 3072,
}
```

After `repository.createKnowledge` succeeds:

```typescript
await this.indexScheduler.scheduleUpsert(actor.organizationId, entry.id);
```

- [ ] **Step 5: Schedule all other lifecycle transitions**

Use these exact rules:

```typescript
private isVectorEligible(entry: KnowledgeEntry) {
  return entry.status === 'published'
    && !entry.deletedAt
    && (entry.layer === 'L2' || entry.layer === 'L3');
}
```

- `update`: compare index-relevant fields before and after; schedule upsert only when eligible and changed.
- `setStatus`: schedule upsert for eligible result, otherwise delete.
- `confirmClassification`: schedule upsert after persistence.
- `trashEntries` and `permanentlyDelete`: schedule delete after source persistence.
- `restoreEntries`: schedule upsert only if restored state is published L2/L3.

Index-relevant comparison must include:

```typescript
JSON.stringify([
  entry.layer,
  entry.category,
  entry.title,
  entry.content,
  entry.version,
  entry.effectiveFrom,
  entry.effectiveTo,
  entry.productId,
  entry.packageId,
  entry.structuredData?.businessCategory,
  entry.structuredData?.sourceReferences,
  entry.structuredData?.timeRange,
])
```

- [ ] **Step 6: Run lifecycle tests**

Run:

```powershell
node --import tsx --test server/knowledge/importWorkflow.test.ts server/knowledge/knowledgeLifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verification checkpoint**

Run `npm.cmd run typecheck`. Expected: PASS.

## Task 7: Switch retrieval to Qdrant candidates with lexical reranking and fallback

**Files:**
- Modify: `server/knowledge/retrieval.ts`
- Modify: `server/knowledge/retrieval.test.ts`
- Modify: `server/analysisService.ts`
- Modify: `server/analysisService.stability.test.ts`

- [ ] **Step 1: Write failing retrieval tests**

Add tests proving:

1. Query text uses `task: search result | query:`.
2. Qdrant search receives the server-side organization ID.
3. Only entry IDs returned by Qdrant are reranked in the dense path.
4. Two chunks from one entry produce one final knowledge entry.
5. Qdrant failure returns the same keyword fallback result as the current implementation.
6. Mandatory published L0/L1 and the current user's L4 are included independently of Qdrant.

Use a fake `KnowledgeVectorIndex` whose `search` returns controlled hits.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
node --import tsx --test server/knowledge/retrieval.test.ts
```

Expected: FAIL because retrieval does not accept an organization-scoped vector index.

- [ ] **Step 3: Extend the retrieval signature**

Use one options object to avoid positional-argument drift:

```typescript
export interface RetrievalOptions {
  organizationId: string;
  ownerId: string;
  limit?: number;
  vectorIndex?: KnowledgeVectorIndex;
  now?: Date;
}
```

- [ ] **Step 4: Implement Qdrant-first candidate selection**

Preserve `tokens` and `categoryBoost`; remove the old inline-vector cosine path. Implement the complete Qdrant-first function:

```typescript
export async function retrieveKnowledge(
  entries: KnowledgeEntry[],
  query: string,
  config: AppConfig,
  options: RetrievalOptions,
) {
  const limit = options.limit ?? 12;
  const now = options.now ?? new Date();
  const effective = (entry: KnowledgeEntry) =>
    (!entry.effectiveFrom || new Date(entry.effectiveFrom) <= now)
    && (!entry.effectiveTo || new Date(entry.effectiveTo) >= now);
  const published = entries.filter((entry) => entry.status === 'published' && !entry.deletedAt && effective(entry));
  const mandatory = published.filter((entry) =>
    entry.layer === 'L0'
    || entry.layer === 'L1'
    || (entry.layer === 'L4' && entry.structuredData?.ownerId === options.ownerId),
  );
  const eligible = published.filter((entry) => entry.layer === 'L2' || entry.layer === 'L3');
  const byId = new Map(eligible.map((entry) => [entry.id, entry]));
  const queryTokens = tokens(query);
  let denseHits: Awaited<ReturnType<KnowledgeVectorIndex['search']>> | undefined;

  if (options.vectorIndex) {
    try {
      const embedding = await createKnowledgeEmbedding(formatRetrievalQuery(query), config);
      if (embedding) {
        denseHits = await options.vectorIndex.search({
          organizationId: options.organizationId,
          vector: embedding.vector,
          nowEpoch: Math.floor(now.getTime() / 1000),
          limit: 30,
        });
      }
    } catch {
      denseHits = undefined;
    }
  }

  const denseByEntry = new Map<string, number>();
  for (const hit of denseHits ?? []) {
    denseByEntry.set(hit.entryId, Math.max(denseByEntry.get(hit.entryId) ?? 0, hit.score));
  }
  const candidates = denseByEntry.size
    ? [...denseByEntry.keys()].map((id) => byId.get(id)).filter((entry): entry is KnowledgeEntry => Boolean(entry))
    : eligible;
  const ranked = candidates.map((entry) => {
    const entryTokens = tokens(`${entry.title}\n${entry.category}\n${entry.content}`);
    const matches = [...queryTokens].filter((token) => entryTokens.has(token)).length;
    const lexical = queryTokens.size ? matches / Math.sqrt(queryTokens.size * Math.max(1, entryTokens.size)) : 0;
    const dense = denseByEntry.get(entry.id);
    return {
      entry,
      score: dense === undefined
        ? lexical + categoryBoost(query, entry)
        : dense * 0.7 + lexical * 0.3 + categoryBoost(query, entry),
    };
  }).sort((left, right) => right.score - left.score);
  const tactics = ranked.filter((item) => item.entry.layer === 'L2')
    .slice(0, Math.min(4, limit)).map((item) => item.entry);
  const facts = ranked.filter((item) => item.entry.layer === 'L3' && item.score > 0)
    .slice(0, Math.max(1, limit - tactics.length)).map((item) => item.entry);
  return [...new Map([...mandatory, ...tactics, ...facts].map((entry) => [entry.id, entry])).values()];
}
```

If Qdrant is absent, returns no hits, or throws, execute the existing full keyword fallback. Continue returning at most four L2 tactics plus positive-scoring L3 facts, then prepend mandatory entries and dedupe by entry ID.

- [ ] **Step 5: Inject the vector index into `AnalysisService`**

Constructor:

```typescript
constructor(
  private readonly repository: Repository,
  private readonly storage: ObjectStorage,
  private readonly parser: ConversationParser,
  private readonly config: AppConfig,
  private readonly vectorIndex?: KnowledgeVectorIndex,
) {}
```

Call:

```typescript
const knowledge = await retrieveKnowledge(allKnowledge, query, this.config, {
  organizationId: job.organizationId,
  ownerId: job.createdBy,
  vectorIndex: this.vectorIndex,
});
```

- [ ] **Step 6: Run retrieval and stability tests**

Run:

```powershell
node --import tsx --test server/knowledge/retrieval.test.ts server/analysisService.stability.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verification checkpoint**

Run `npm.cmd run typecheck`. Expected: PASS.

## Task 8: Wire API startup, worker processing, and health

**Files:**
- Modify: `server/index.ts`
- Modify: `server/worker.ts`

- [ ] **Step 1: Create the vector index at startup**

In both entry points:

```typescript
const vectorIndex: KnowledgeVectorIndex = config.qdrantUrl
  ? new QdrantVectorIndex(config)
  : new DisabledVectorIndex();
const knowledgeIndexer = new KnowledgeIndexService(repository, vectorIndex, config);
```

Attempt initialization without crashing the API:

```typescript
let qdrantInitializationError: string | undefined;
try {
  await vectorIndex.initialize();
} catch (error) {
  qdrantInitializationError = error instanceof Error ? error.message : 'Qdrant初始化失败';
}
```

Pass `vectorIndex` to `AnalysisService` and `knowledgeIndexer` to `KnowledgeService`.

- [ ] **Step 2: Add inline retry processing**

Only in API `inline` mode:

```typescript
if (config.workerMode === 'inline') {
  const indexTimer = setInterval(() => {
    void knowledgeIndexer.processPending().catch((error) => {
      console.error('Knowledge index retry failed', error instanceof Error ? error.message : error);
    });
  }, 1000);
  indexTimer.unref();
}
```

Do not log request bodies, vectors, source content, or API keys.

- [ ] **Step 3: Let the external worker process both queues**

Replace the worker loop body with:

```typescript
while (true) {
  const analysisProcessed = await service.processPending();
  const indexProcessed = await knowledgeIndexer.processPending();
  if (!analysisProcessed && !indexProcessed) await wait(500);
}
```

- [ ] **Step 4: Report health without exposing secrets**

Change `/api/health` to return:

```typescript
app.get('/api/health', async () => {
  const qdrant = await vectorIndex.health();
  return {
    ok: qdrant.ok || !config.qdrantUrl,
    repository: config.repositoryDriver,
    objectStorage: config.objectStorageDriver,
    model: config.modelDriver,
    embedding: {
      configured: Boolean(config.embeddingModelName && config.modelApiKey),
      model: config.embeddingModelName,
      dimensions: config.embeddingDimensions ?? 3072,
    },
    qdrant: {
      configured: Boolean(config.qdrantUrl),
      ok: qdrant.ok,
      detail: qdrant.ok ? undefined : qdrantInitializationError ?? qdrant.detail,
    },
    workerMode: config.workerMode,
    retentionDays: config.retentionDays,
  };
});
```

- [ ] **Step 5: Run typecheck and API build**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run build:api
```

Expected: both PASS.

## Task 9: Add an explicit full-reindex command

**Files:**
- Create: `server/scripts/reindexKnowledge.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement argument parsing and dry run**

The script accepts:

```text
--organization=default-org
--dry-run
```

It must:

1. Load config and the configured repository.
2. Require `QDRANT_URL` and a configured embedding model unless `--dry-run`.
3. List only active published L2/L3 entries.
4. Print counts only: entries, chunks, and estimated tokens; never print content, vectors, or keys.
5. In live mode initialize Qdrant, index entries one at a time, and print progress IDs only.
6. Exit nonzero if any entry fails.

Use this dry-run summary type:

```typescript
interface ReindexSummary {
  organizationId: string;
  entries: number;
  chunks: number;
  estimatedTokens: number;
  indexed: number;
  failed: number;
}
```

- [ ] **Step 2: Add the package script**

Add:

```json
"knowledge:reindex": "tsx server/scripts/reindexKnowledge.ts"
```

- [ ] **Step 3: Run dry run**

Run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
```

Expected: exit 0 with numeric counts and no knowledge text or secret.

- [ ] **Step 4: Verification checkpoint**

Run `npm.cmd run typecheck`. Expected: PASS.

## Task 10: Add local Qdrant deployment and safe configuration

**Files:**
- Create: `docker-compose.qdrant.yml`
- Modify: `.env.example`
- Modify: `.env` locally
- Modify: `README.md`
- Modify: `DEPLOYMENT.md`
- Modify: `package.json`

- [ ] **Step 1: Create the pinned local Qdrant service**

Create:

```yaml
services:
  qdrant:
    image: qdrant/qdrant:v1.18.1
    restart: unless-stopped
    ports:
      - "127.0.0.1:6333:6333"
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  qdrant_data:
```

- [ ] **Step 2: Add safe example variables**

Add to `.env.example`:

```dotenv
EMBEDDING_MODEL_NAME=gemini-embedding-2-preview
EMBEDDING_DIMENSIONS=3072
QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=
QDRANT_COLLECTION_NAME=sales_knowledge_gemini_embedding_2_preview_3072_v1
QDRANT_COLLECTION_ALIAS=sales_knowledge_current
QDRANT_TIMEOUT_MS=10000
```

Update local `.env` only by setting the model name, dimensions, and local Qdrant URL. Preserve the existing model key without printing or replacing it.

- [ ] **Step 3: Add convenience scripts**

Add:

```json
"qdrant:up": "docker compose -f docker-compose.qdrant.yml up -d",
"qdrant:down": "docker compose -f docker-compose.qdrant.yml down",
"qdrant:logs": "docker compose -f docker-compose.qdrant.yml logs --tail=100 qdrant"
```

- [ ] **Step 4: Document operations**

README must contain:

- `npm.cmd run qdrant:up` before `npm.cmd run dev:all`.
- `npm.cmd run knowledge:reindex -- --organization=default-org --dry-run`.
- Live reindex command.
- Health endpoint interpretation.
- Keyword fallback behavior.

DEPLOYMENT must contain:

- Qdrant API key and private network requirement.
- Persistent volume.
- Collection alias migration.
- Qdrant can be rebuilt from the source repository.
- Snapshot/recovery test recommendation.
- No keys in source, logs, screenshots, or documentation.

- [ ] **Step 5: Validate compose syntax**

Run:

```powershell
docker compose -f docker-compose.qdrant.yml config
```

Expected: exit 0 and normalized compose output.

## Task 11: Run complete automated verification

**Files:** all files changed above.

- [ ] **Step 1: Run focused new tests**

```powershell
node --import tsx --test server/model/embeddings.test.ts
node --import tsx --test server/knowledge/chunking.test.ts
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
node --import tsx --test server/knowledgeIndexService.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run affected regression tests**

```powershell
node --import tsx --test server/knowledge/retrieval.test.ts
node --import tsx --test server/knowledge/importWorkflow.test.ts
node --import tsx --test server/knowledge/knowledgeLifecycle.test.ts
node --import tsx --test server/infrastructure/filePersistence.test.ts
node --import tsx --test server/analysisService.stability.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run the full verification suite**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run build:api
```

Expected: all commands exit 0.

## Task 12: Perform the bounded live smoke test and migration

**Files:** local runtime data only.

- [ ] **Step 1: Start Qdrant**

Run:

```powershell
npm.cmd run qdrant:up
```

Expected: Qdrant container is running and `http://127.0.0.1:6333/healthz` returns success.

- [ ] **Step 2: Start the application and inspect health**

Run the app using its normal `npm.cmd run dev:all` command. Request:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' | ConvertTo-Json -Depth 6
```

Expected:

- `embedding.configured=true`
- model `gemini-embedding-2-preview`
- dimensions 3072
- `qdrant.configured=true`
- `qdrant.ok=true`

- [ ] **Step 3: Run dry-run migration first**

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
```

Record entry/chunk/token counts. Confirm no source content, vector, or secret is printed.

- [ ] **Step 4: Run one real embedding smoke request**

Use one short synthetic input through `createKnowledgeEmbedding` or a dedicated test entry. Expected:

- HTTP success.
- exactly 3072 finite values.
- returned model version recorded.

Do not print the vector or key.

- [ ] **Step 5: Reindex current published L2/L3 knowledge**

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org
```

Expected: every reported entry indexed, failed count 0.

- [ ] **Step 6: Verify tenant-filtered retrieval**

Submit one known product/price query through the existing analysis API and verify:

- Qdrant receives `organizationId=default-org`.
- The result cites the correct published entry.
- No archived, deleted, future-effective, expired, or unreviewed entry appears.
- Repeating reindex does not increase point count.

- [ ] **Step 7: Verify failure fallback**

Stop only Qdrant:

```powershell
npm.cmd run qdrant:down
```

Run the same query. Expected: API remains available and returns keyword-based knowledge with Qdrant shown unhealthy. Restart Qdrant and verify vector retrieval recovers.

- [ ] **Step 8: Final evidence report**

Report separately:

- Code tests and builds.
- Actual Yunwu embedding smoke result.
- Actual Qdrant point count and health.
- Actual reindex result.
- Actual retrieval/fallback behavior.
- Any remaining unverified production-only item.

Do not claim live success unless Tasks 12.1–12.7 were actually run.
