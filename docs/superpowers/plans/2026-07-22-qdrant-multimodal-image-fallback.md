# Qdrant Multimodal Image Fallback Implementation Plan

> **状态：已废弃，不执行。** 用户已取消图片直接向量化。不得继续本计划中的 Sharp、image named vector 或双路召回工作。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有已发布 L2/L3 知识图片生成 `gemini-embedding-2-preview` 图片向量，并在 Qdrant 中以 `text`/`image` named vectors 实现文字主召回、图片辅助召回。

**Architecture:** 新建 v2 多模态 Qdrant collection，文字切片 point 只写 `text` 向量，图片素材 point 只写 `image` 向量。索引构建器从对象存储解析两类图片来源，图片单项失败只记录部分失败；查询端并行搜索两个 named vector，按 80/20 融合并用图片结果补足文字候选。

**Tech Stack:** TypeScript、Node.js test runner、Gemini-compatible REST、Sharp、Qdrant REST API、现有 Repository/ObjectStorage 抽象。

**Repository note:** `D:\销转智能体\12` 当前没有 `.git` 元数据，因此本计划用聚焦测试和全量验证作为检查点，不包含无法执行的 commit 步骤。

---

## File Map

- Modify `server/model/embeddings.ts`: 图片格式规范化、图片 embedding 请求和共用响应校验。
- Modify `server/model/embeddings.test.ts`: 图片请求、格式转换、失败和维度测试。
- Modify `server/infrastructure/vectorIndex.ts`: text/image point 契约和可选 chunkId。
- Modify `server/infrastructure/qdrantVectorIndex.ts`: named vector collection、异构 point upsert、双路查询和融合。
- Modify `server/infrastructure/qdrantVectorIndex.test.ts`: collection、upsert、过滤、融合和图片补位测试。
- Create `server/knowledge/imageAssets.ts`: 从直接 storageKey 或 import source 解析原始图片。
- Create `server/knowledge/vectorPoints.ts`: 构造文字与图片 point，汇总部分失败状态。
- Modify `server/knowledgeIndexService.ts`: 注入对象存储并调用统一 point builder。
- Modify `server/knowledgeIndexService.test.ts`: 两类图片来源、成功索引、部分失败测试。
- Modify `server/knowledge/chunking.ts`: 导出已有确定性 UUID 工具，供图片 point 复用。
- Modify `server/knowledgeService.ts`: 知识条目上传图片后调度重建。
- Modify `server/productService.ts`: 产品图片增删后调度 upsert/delete。
- Modify `server/productService.test.ts`: 产品媒体调度测试。
- Modify `server/index.ts`: 向索引服务和产品服务传入对象存储与调度器。
- Modify `server/worker.ts`: 向独立 Worker 的索引服务传入对象存储。
- Modify `server/scripts/reindexKnowledge.ts`: 使用统一多模态 point builder，并输出图片统计。
- Modify `server/config.ts`, `.env.example`: v2 collection 默认值。
- Modify `README.md`, `DEPLOYMENT.md`: 双向量说明、重建和 alias 切换步骤。
- Modify `package.json`, `package-lock.json`: 增加 `sharp`。

### Task 1: Establish the Baseline and Probe Yunwu Image Compatibility

**Files:**
- Read: `.env`
- Read: `server/model/embeddings.ts`
- No source edits

- [ ] **Step 1: Run the existing focused and full baselines**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts server/infrastructure/qdrantVectorIndex.test.ts server/knowledgeIndexService.test.ts server/productService.test.ts
npm.cmd run typecheck
```

Expected: both commands exit `0`. If an unrelated baseline failure exists, record its exact test and do not attribute it to this feature.

- [ ] **Step 2: Send a safe one-pixel PNG through the configured Yunwu endpoint**

Run from `D:\销转智能体\12`; this command prints only status, vector length, model version and token count:

```powershell
node --input-type=module -e "import {loadEnvFile} from 'node:process'; loadEnvFile(); const base=(process.env.MODEL_BASE_URL||'https://yunwu.ai').replace(/\/$/,''); const model=process.env.EMBEDDING_MODEL_NAME||'gemini-embedding-2-preview'; const key=process.env.MODEL_API_KEY; if(!key) throw new Error('MODEL_API_KEY missing'); const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='; const response=await fetch(base+'/v1beta/models/'+encodeURIComponent(model)+':generateContent',{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify({content:{parts:[{inline_data:{mime_type:'image/png',data}}]}})}); if(!response.ok) throw new Error('HTTP '+response.status); const body=await response.json(); console.log(JSON.stringify({status:response.status,dimensions:body.embedding?.values?.length,modelVersion:body.modelVersion,inputTokens:body.usageMetadata?.promptTokenCount}));"
```

Expected:

```json
{"status":200,"dimensions":3072,"modelVersion":"gemini-embedding-2-preview","inputTokens":1}
```

`inputTokens` may differ, but `status` must be `200` and `dimensions` must be `3072`.

- [ ] **Step 3: Enforce the compatibility gate**

If the probe returns a non-2xx response or a non-3072 vector, stop before Task 2 and report only the safe status/shape. Do not print the response body, request base64, or API key.

### Task 2: Add Image Embedding and Image Normalization

**Files:**
- Modify: `server/model/embeddings.test.ts`
- Modify: `server/model/embeddings.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the image decoder as test setup**

Run:

```powershell
npm.cmd install sharp
```

Expected: `sharp` appears in `dependencies`; npm exits `0` without changing unrelated dependency versions.

- [ ] **Step 2: Add failing tests for the image API without importing a missing named export**

Change the test import to a namespace and append these tests:

```ts
import sharp from 'sharp';
import * as embeddings from './embeddings.js';

test('sends PNG as Gemini inline_data and parses a 3072-dimensional image vector', async (t) => {
  assert.equal(typeof embeddings.createKnowledgeImageEmbedding, 'function');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let capturedBody: unknown;
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      embedding: { values: Array.from({ length: 3072 }, () => 0.01) },
      modelVersion: 'gemini-embedding-2-preview',
    }), { status: 200 });
  };
  const image = {
    name: 'pixel.png',
    mimeType: 'image/png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  };

  const result = await embeddings.createKnowledgeImageEmbedding!(image, config());

  assert.deepEqual(capturedBody, { content: { parts: [{ inline_data: {
    mime_type: 'image/png', data: image.data.toString('base64'),
  } }] } });
  assert.equal(result?.vector.length, 3072);
});

test('converts WebP to JPEG before requesting an image embedding', async (t) => {
  assert.equal(typeof embeddings.createKnowledgeImageEmbedding, 'function');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let inlineData: { mime_type?: string; data?: string } = {};
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { content: { parts: Array<{ inline_data: typeof inlineData }> } };
    inlineData = body.content.parts[0]!.inline_data;
    return new Response(JSON.stringify({ embedding: { values: Array.from({ length: 3072 }, () => 0.01) } }), { status: 200 });
  };
  const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).webp().toBuffer();

  await embeddings.createKnowledgeImageEmbedding!({ name: 'poster.webp', mimeType: 'image/webp', data: webp }, config());

  assert.equal(inlineData.mime_type, 'image/jpeg');
  assert.ok(Buffer.from(inlineData.data ?? '', 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
});

test('returns a stable decode error without sending an invalid image', async (t) => {
  assert.equal(typeof embeddings.createKnowledgeImageEmbedding, 'function');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response(); };

  await assert.rejects(
    embeddings.createKnowledgeImageEmbedding!({ name: 'bad.gif', mimeType: 'image/gif', data: Buffer.from('not-an-image') }, config()),
    /image_decode_failed/,
  );
  assert.equal(fetchCalls, 0);
});
```

Keep the existing text tests, replacing direct function references with `embeddings.createKnowledgeEmbedding`, `embeddings.formatRetrievalDocument` and `embeddings.formatRetrievalQuery`.

- [ ] **Step 3: Run the tests to verify RED**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts
```

Expected: FAIL because `createKnowledgeImageEmbedding` is not exported.

- [ ] **Step 4: Implement the minimal image client in `server/model/embeddings.ts`**

Add the input type, normalization helper, shared Gemini response parser and image function:

```ts
import sharp from 'sharp';

export interface EmbeddingImageInput {
  name: string;
  mimeType: string;
  data: Buffer;
}

async function normalizeEmbeddingImage(image: EmbeddingImageInput) {
  if (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' || image.mimeType === 'image/jpg') {
    return { mimeType: image.mimeType === 'image/png' ? 'image/png' : 'image/jpeg', data: image.data };
  }
  try {
    return {
      mimeType: 'image/jpeg' as const,
      data: await sharp(image.data, { animated: false, pages: 1 }).rotate().jpeg({ quality: 90 }).toBuffer(),
    };
  } catch {
    throw new Error('image_decode_failed');
  }
}

async function requestGeminiEmbedding(
  parts: Array<Record<string, unknown>>,
  config: AppConfig,
  model: string,
): Promise<EmbeddingResult> {
  const response = await fetch(
    `${config.modelBaseUrl!.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': config.modelApiKey!, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ content: { parts } }),
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
    vector: validateVector(body.embedding?.values, config.embeddingDimensions ?? 3072),
  };
}

export async function createKnowledgeImageEmbedding(
  image: EmbeddingImageInput,
  config: AppConfig,
): Promise<EmbeddingResult | undefined> {
  const model = config.embeddingModelName;
  if (config.modelDriver !== 'openai_compatible' || !config.modelBaseUrl || !config.modelApiKey || !model) return undefined;
  if (config.modelApiStyle !== 'gemini_generate_content') throw new Error('image_embedding_api_unsupported');
  const normalized = await normalizeEmbeddingImage(image);
  return requestGeminiEmbedding([{ inline_data: {
    mime_type: normalized.mimeType,
    data: normalized.data.toString('base64'),
  } }], config, model);
}
```

Refactor the existing Gemini text branch to call:

```ts
return requestGeminiEmbedding([{ text }], config, model);
```

Do not change the OpenAI-compatible text `/embeddings` branch.

- [ ] **Step 5: Run focused tests and typecheck to verify GREEN**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts
npm.cmd run typecheck
```

Expected: PASS; no API key or base64 appears in output.

### Task 3: Convert the Vector Contract and Qdrant Collection to Named Vectors

**Files:**
- Modify: `server/infrastructure/vectorIndex.ts`
- Modify: `server/infrastructure/qdrantVectorIndex.test.ts`
- Modify: `server/infrastructure/qdrantVectorIndex.ts`

- [ ] **Step 1: Rewrite Qdrant expectations first**

Change the collection assertion to:

```ts
assert.deepEqual(collection?.body, {
  vectors: {
    text: { size: 3072, distance: 'Cosine' },
    image: { size: 3072, distance: 'Cosine' },
  },
});
```

Replace the existing point fixture with:

```ts
const point: KnowledgeVectorPoint = {
  id: '11111111-1111-4111-8111-111111111111',
  vectorName: 'text',
  vector: [0.1, 0.2],
  model: 'gemini-embedding-2-preview',
  modelVersion: 'gemini-embedding-2-preview',
  payload: {
    pointKind: 'text_chunk',
    organizationId: 'org-a',
    entryId: 'entry-1',
    chunkId: 'chunk-1',
    sequence: 0,
    layer: 'L3',
    status: 'published',
    content: '价格规则',
  },
};
```

Assert the upsert vector is named:

```ts
const stored = (calls[0]!.body.points as Array<{ vector: unknown; payload: Record<string, unknown> }>)[0]!;
assert.deepEqual(stored.vector, { text: [0.1, 0.2] });
assert.equal(stored.payload.pointKind, 'text_chunk');
assert.match(calls[0]!.url, /\/collections\/knowledge-v1\/points\?wait=true$/);
```

Add a dual-search fusion test:

```ts
test('searches text and image vectors and fuses entries with 80/20 weights', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return response({ result: { points: body.using === 'text'
      ? [{ id: 'text-a', score: 0.9, payload: { entryId: 'a', chunkId: 'c-a', sequence: 0, content: '文字A' } }]
      : [
          { id: 'image-a', score: 0.8, payload: { entryId: 'a', mediaId: 'm-a', sequence: 0, content: '图片A' } },
          { id: 'image-b', score: 0.7, payload: { entryId: 'b', mediaId: 'm-b', sequence: 0, content: '图片B' } },
        ] } });
  };

  const hits = await new QdrantVectorIndex(config()).search({ organizationId: 'org-a', vector: [0.1], nowEpoch: 1, limit: 2 });

  assert.deepEqual(bodies.map((body) => body.using), ['text', 'image']);
  assert.equal(hits[0]?.entryId, 'a');
  assert.equal(hits[0]?.score, 1);
  assert.equal(hits[1]?.entryId, 'b');
  assert.equal(hits[1]?.score, 0.175);
});
```

- [ ] **Step 2: Run the Qdrant tests to verify RED**

Run:

```powershell
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
```

Expected: FAIL because the collection is still unnamed, points have no `vectorName`, and search performs one query.

- [ ] **Step 3: Replace the vector point contract**

In `server/infrastructure/vectorIndex.ts`, replace `KnowledgeVectorPoint` and relax the hit chunk ID:

```ts
export type KnowledgeVectorName = 'text' | 'image';

export interface KnowledgeVectorPayload extends Record<string, unknown> {
  pointKind: 'text_chunk' | 'image_asset';
  organizationId: string;
  entryId: string;
  layer: 'L2' | 'L3';
  status: 'published';
  content: string;
}

export interface KnowledgeVectorPoint {
  id: string;
  vectorName: KnowledgeVectorName;
  vector: number[];
  payload: KnowledgeVectorPayload;
  model: string;
  modelVersion?: string;
}

export interface KnowledgeVectorHit {
  id: string;
  score: number;
  entryId: string;
  chunkId?: string;
  sequence: number;
  content: string;
}
```

Remove the now-unused `KnowledgeChunk` import.

- [ ] **Step 4: Implement named collection validation and named upsert**

Create the collection with:

```ts
vectors: {
  text: { size: this.dimensions, distance: 'Cosine' },
  image: { size: this.dimensions, distance: 'Cosine' },
},
```

For existing collections, validate both `vectors.text` and `vectors.image` have the expected size and `Cosine` distance. Reject the old unnamed v1 shape.

Map points as:

```ts
points: points.map((point) => ({
  id: point.id,
  vector: { [point.vectorName]: point.vector },
  payload: {
    ...point.payload,
    embeddingModel: point.model,
    embeddingModelVersion: point.modelVersion,
    embeddingDimensions: point.vector.length,
  },
})),
```

Write and delete entry points through `this.collectionName`, not the alias:

```ts
`/collections/${encodeURIComponent(this.collectionName)}/points?wait=true`
`/collections/${encodeURIComponent(this.collectionName)}/points/delete?wait=true`
```

Keep searches on `this.alias`. If the alias already exists, initialization must not repoint it automatically; migration switches it only after v2 verification.

- [ ] **Step 5: Implement two searches and deterministic fusion**

Add private helpers equivalent to:

```ts
private parseHits(points: Array<{ id: string; score: number; payload?: Record<string, unknown> }>) {
  return points.flatMap((point): KnowledgeVectorHit[] => {
    const payload = point.payload ?? {};
    if (typeof payload.entryId !== 'string') return [];
    return [{
      id: String(point.id),
      score: point.score,
      entryId: payload.entryId,
      chunkId: typeof payload.chunkId === 'string' ? payload.chunkId : undefined,
      sequence: Number(payload.sequence ?? 0),
      content: String(payload.content ?? ''),
    }];
  });
}

private normalize(hits: KnowledgeVectorHit[]) {
  const best = new Map<string, KnowledgeVectorHit>();
  for (const hit of hits) {
    if (!best.has(hit.entryId) || best.get(hit.entryId)!.score < hit.score) best.set(hit.entryId, hit);
  }
  const max = Math.max(0, ...[...best.values()].map((hit) => hit.score));
  return new Map([...best].map(([entryId, hit]) => [entryId, {
    hit,
    score: max > 0 ? Math.max(0, hit.score) / max : 0,
  }]));
}

private fuse(textHits: KnowledgeVectorHit[], imageHits: KnowledgeVectorHit[], limit: number) {
  const text = this.normalize(textHits);
  const image = this.normalize(imageHits);
  const allowImageOnly = text.size < limit;
  const ids = new Set([...text.keys(), ...(allowImageOnly ? image.keys() : [])]);
  return [...ids].map((entryId) => {
    const textValue = text.get(entryId);
    const imageValue = image.get(entryId);
    const representative = textValue?.hit ?? imageValue!.hit;
    return { ...representative, score: (textValue?.score ?? 0) * 0.8 + (imageValue?.score ?? 0) * 0.2 };
  }).sort((left, right) => right.score - left.score).slice(0, limit);
}
```

Have `search()` make two `/points/query` requests with the same tenant/status/layer/effective-time filter:

```ts
const [text, image] = await Promise.all([
  this.queryVector('text', input.vector, filter, input.limit),
  this.queryVector('image', input.vector, filter, Math.min(20, input.limit)),
]);
return this.fuse(text, image, input.limit);
```

- [ ] **Step 6: Run focused Qdrant tests**

Run:

```powershell
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
```

Expected: Qdrant tests PASS. Task 4 updates all producers before the next full typecheck.

### Task 4: Build Text and Image Points with Partial-Failure Isolation

**Files:**
- Create: `server/knowledge/imageAssets.ts`
- Create: `server/knowledge/vectorPoints.ts`
- Modify: `server/knowledge/chunking.ts`
- Modify: `server/knowledgeIndexService.test.ts`
- Modify: `server/knowledgeIndexService.ts`
- Modify: `server/index.ts`
- Modify: `server/worker.ts`
- Modify: `server/scripts/reindexKnowledge.ts`

- [ ] **Step 1: Add failing service tests for both image sources and partial failure**

Import `MemoryObjectStorage` and update all existing service constructors to the new desired order through a temporary `as any` construction until production code catches up:

```ts
const storage = new MemoryObjectStorage();
const service = new (KnowledgeIndexService as any)(repository, vectorIndex, storage, config, textEmbed, imageEmbed);
```

Add a direct-storage test:

```ts
test('indexes a published direct-storage image beside text chunks', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const storage = new MemoryObjectStorage();
  await storage.put('org-a/knowledge/entry/poster.png', Buffer.from('png'));
  const source = entry({ structuredData: { businessCategory: '产品资料', mediaAssets: [{
    id: 'media-1', name: 'poster.png', mimeType: 'image/png', size: 3, kind: 'image',
    storageKey: 'org-a/knowledge/entry/poster.png', createdAt: '2026-07-22T00:00:00.000Z',
  }] } });
  await repository.createKnowledge('org-a', source);
  const imageInputs: Array<{ name: string; mimeType: string; data: Buffer }> = [];
  const service = new (KnowledgeIndexService as any)(
    repository, vectorIndex, storage, config,
    async () => ({ model: 'gemini-embedding-2-preview', vector: [0.1, 0.2] }),
    async (image: { name: string; mimeType: string; data: Buffer }) => {
      imageInputs.push(image);
      return { model: 'gemini-embedding-2-preview', vector: [0.3, 0.4] };
    },
  );

  await service.scheduleUpsert('org-a', source.id);
  await service.processPending();

  assert.equal(imageInputs.length, 1);
  assert.equal(vectorIndex.replacements[0]?.points.filter((point) => point.vectorName === 'image').length, 1);
  assert.equal((await repository.getKnowledge(source.id))?.structuredData?.embedding
    && ((await repository.getKnowledge(source.id))!.structuredData!.embedding as { imageIndexedCount?: number }).imageIndexedCount, 1);
});
```

Add a partial failure test:

```ts
test('keeps text points when one image embedding fails', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const storage = new MemoryObjectStorage();
  await storage.put('org-a/knowledge/entry/bad.png', Buffer.from('png'));
  const source = entry({ structuredData: { businessCategory: '产品资料', mediaAssets: [{
    id: 'media-bad', name: 'bad.png', mimeType: 'image/png', size: 3, kind: 'image',
    storageKey: 'org-a/knowledge/entry/bad.png', createdAt: '2026-07-22T00:00:00.000Z',
  }] } });
  await repository.createKnowledge('org-a', source);
  const service = new (KnowledgeIndexService as any)(
    repository, vectorIndex, storage, config,
    async () => ({ model: 'gemini-embedding-2-preview', vector: [0.1, 0.2] }),
    async () => { throw new Error('provider unavailable'); },
  );

  await service.scheduleUpsert('org-a', source.id);
  await service.processPending();

  assert.equal(vectorIndex.replacements.length, 1);
  assert.ok(vectorIndex.replacements[0]!.points.every((point) => point.vectorName === 'text'));
  const stored = await repository.getKnowledge(source.id);
  const state = stored?.structuredData?.embedding as { status?: string; imageFailedCount?: number; imageFailures?: unknown[] };
  assert.equal(state.status, 'indexed');
  assert.equal(state.imageFailedCount, 1);
  assert.equal(state.imageFailures?.length, 1);
  assert.equal((await repository.listKnowledgeIndexJobs('org-a', 10))[0]?.status, 'completed');
});
```

Add this imported-source test:

```ts
test('resolves an imported image through importJobId and sourceFileId', async () => {
  const repository = new MemoryRepository();
  const vectorIndex = new RecordingVectorIndex();
  const storage = new MemoryObjectStorage();
  await storage.put('org-a/imports/import-1/source-1.png', Buffer.from('imported-image'));
  await repository.createKnowledgeImport({
    id: 'import-1', organizationId: 'org-a', createdBy: 'admin', status: 'published',
    progress: 100, progressLabel: '已发布', candidates: [], publishedEntryIds: [],
    sourceFiles: [{
      id: 'source-1', name: 'source.png', mimeType: 'image/png', size: 14,
      storageKey: 'org-a/imports/import-1/source-1.png', status: 'extracted', textLength: 0,
      warnings: [], createdAt: '2026-07-22T00:00:00.000Z',
    }],
    createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
  });
  const source = entry({ structuredData: { businessCategory: '产品资料', mediaAssets: [{
    id: 'source-1', name: 'source.png', mimeType: 'image/png', size: 14, kind: 'image',
    importJobId: 'import-1', sourceFileId: 'source-1', createdAt: '2026-07-22T00:00:00.000Z',
  }] } });
  await repository.createKnowledge('org-a', source);
  const received: Buffer[] = [];
  const service = new (KnowledgeIndexService as any)(
    repository, vectorIndex, storage, config,
    async () => ({ model: 'gemini-embedding-2-preview', vector: [0.1, 0.2] }),
    async (image: { data: Buffer }) => {
      received.push(image.data);
      return { model: 'gemini-embedding-2-preview', vector: [0.3, 0.4] };
    },
  );

  await service.scheduleUpsert('org-a', source.id);
  await service.processPending();

  assert.deepEqual(received, [Buffer.from('imported-image')]);
});
```

- [ ] **Step 2: Run service tests to verify RED**

Run:

```powershell
node --import tsx --test server/knowledgeIndexService.test.ts
```

Expected: FAIL because the service does not accept storage/image embedder and produces no image points.

- [ ] **Step 3: Export the existing deterministic UUID helper**

In `server/knowledge/chunking.ts`, change only:

```ts
export function deterministicUuid(seed: string) {
```

Do not alter the UUID algorithm or existing text point IDs.

- [ ] **Step 4: Implement `server/knowledge/imageAssets.ts`**

Create these contracts and resolver:

```ts
import { createHash } from 'node:crypto';
import type { KnowledgeEntry, KnowledgeMediaAsset } from '../../shared/contracts.js';
import type { ObjectStorage, Repository } from '../domain.js';
import type { EmbeddingImageInput } from '../model/embeddings.js';

export interface ResolvedKnowledgeImage extends EmbeddingImageInput {
  mediaId: string;
  contentHash: string;
}

export interface ImageAssetFailure {
  mediaId: string;
  reason: 'image_source_missing' | 'image_read_failed';
}

export async function resolveKnowledgeImages(
  organizationId: string,
  entry: KnowledgeEntry,
  repository: Repository,
  storage: ObjectStorage,
) {
  const assets = Array.isArray(entry.structuredData?.mediaAssets)
    ? entry.structuredData.mediaAssets as KnowledgeMediaAsset[]
    : [];
  const images: ResolvedKnowledgeImage[] = [];
  const failures: ImageAssetFailure[] = [];
  const seen = new Set<string>();
  for (const asset of assets.filter((item) => item.kind === 'image' || item.mimeType.startsWith('image/'))) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    let storageKey = asset.storageKey;
    if (!storageKey && asset.importJobId && asset.sourceFileId) {
      const job = await repository.getKnowledgeImport(asset.importJobId);
      if (job?.organizationId === organizationId) {
        storageKey = job.sourceFiles.find((source) => source.id === asset.sourceFileId)?.storageKey;
      }
    }
    if (!storageKey) {
      failures.push({ mediaId: asset.id, reason: 'image_source_missing' });
      continue;
    }
    try {
      const data = await storage.get(storageKey);
      images.push({
        mediaId: asset.id,
        name: asset.name,
        mimeType: asset.mimeType,
        data,
        contentHash: createHash('sha256').update(data).digest('hex'),
      });
    } catch {
      failures.push({ mediaId: asset.id, reason: 'image_read_failed' });
    }
  }
  return { images, failures };
}
```

- [ ] **Step 5: Implement the shared point builder in `server/knowledge/vectorPoints.ts`**

Create a function with this public contract:

```ts
export interface VectorBuildResult {
  points: KnowledgeVectorPoint[];
  textChunkCount: number;
  imageCount: number;
  imageIndexedCount: number;
  imageFailures: Array<{ mediaId: string; reason: string }>;
  contentHashes: string[];
}

export async function buildKnowledgeVectorPoints(input: {
  organizationId: string;
  entry: KnowledgeEntry;
  repository: Repository;
  storage: ObjectStorage;
  config: AppConfig;
  embedText?: typeof createKnowledgeEmbedding;
  embedImage?: typeof createKnowledgeImageEmbedding;
}): Promise<VectorBuildResult>
```

The implementation must:

1. Build current chunks and fail the whole call if any text embedding fails.
2. Create text points with `vectorName: 'text'` and payload `{ ...chunk, embeddingText: undefined, pointKind: 'text_chunk', chunkId: chunk.id, status: 'published' }`.
3. Resolve every image through `resolveKnowledgeImages`.
4. Catch each image embedding error independently and append only `{ mediaId, reason: 'image_decode_failed' | 'image_embedding_failed' | 'image_embedding_unconfigured' }`.
5. Create successful image points with:

```ts
{
  id: deterministicUuid(`${organizationId}:${entry.id}:${image.mediaId}:${image.contentHash}:${embedding.model}`),
  vectorName: 'image',
  vector: embedding.vector,
  model: embedding.model,
  modelVersion: embedding.modelVersion,
  payload: {
    pointKind: 'image_asset',
    organizationId,
    entryId: entry.id,
    mediaId: image.mediaId,
    layer: entry.layer as 'L2' | 'L3',
    status: 'published',
    category: entry.category,
    businessCategory: String(entry.structuredData?.businessCategory ?? entry.category),
    productId: entry.productId,
    packageId: entry.packageId,
    content: `${entry.title}\n${entry.content.slice(0, 500)}`,
    fileName: image.name,
    contentHash: image.contentHash,
    effectiveFromEpoch: toEpoch(entry.effectiveFrom),
    effectiveToEpoch: toEpoch(entry.effectiveTo),
  },
}
```

Use a local `toEpoch` helper identical in behavior to the current chunking conversion; do not export storage keys.

- [ ] **Step 6: Update `KnowledgeIndexService` to use storage and the builder**

Change the constructor to:

```ts
constructor(
  private readonly repository: Repository,
  private readonly vectorIndex: KnowledgeVectorIndex,
  private readonly storage: ObjectStorage,
  private readonly config: AppConfig,
  private readonly embedText = createKnowledgeEmbedding,
  private readonly embedImage = createKnowledgeImageEmbedding,
) {}
```

Replace the current chunk loop with:

```ts
const built = await buildKnowledgeVectorPoints({
  organizationId: job.organizationId,
  entry,
  repository: this.repository,
  storage: this.storage,
  config: this.config,
  embedText: this.embedText,
  embedImage: this.embedImage,
});
await this.vectorIndex.replaceEntry(job.organizationId, job.entryId, built.points);
```

Persist backward-compatible and new metadata:

```ts
embedding: {
  status: 'indexed',
  model: this.config.embeddingModelName,
  dimensions: this.config.embeddingDimensions ?? 3072,
  chunkCount: built.textChunkCount,
  textChunkCount: built.textChunkCount,
  imageCount: built.imageCount,
  imageIndexedCount: built.imageIndexedCount,
  imageFailedCount: built.imageFailures.length,
  imageFailures: built.imageFailures,
  indexedAt: new Date().toISOString(),
  contentHashes: built.contentHashes,
},
```

Image failures must not throw after `buildKnowledgeVectorPoints` returns.

- [ ] **Step 7: Pass storage through API and Worker construction**

Change both call sites:

```ts
const knowledgeIndexer = new KnowledgeIndexService(repository, vectorIndex, storage, config);
```

- [ ] **Step 8: Migrate the reindex producer to the new point contract**

Before typecheck, update `server/scripts/reindexKnowledge.ts` to construct the same object storage as `server/index.ts` and replace its old `KnowledgeVectorPoint` loop with `buildKnowledgeVectorPoints`. Keep its existing summary fields in this task; Task 6 adds image counts and documentation.

Use:

```ts
const built = await buildKnowledgeVectorPoints({
  organizationId,
  entry,
  repository,
  storage,
  config,
});
await vectorIndex.replaceEntry(organizationId, entry.id, built.points);
```

- [ ] **Step 9: Run service tests, Qdrant tests and typecheck**

Run:

```powershell
node --import tsx --test server/knowledgeIndexService.test.ts server/infrastructure/qdrantVectorIndex.test.ts
npm.cmd run typecheck
```

Expected: PASS with no old point-contract errors.

### Task 5: Reindex When Images Are Added or Removed

**Files:**
- Modify: `server/knowledgeService.ts`
- Modify: `server/knowledge/knowledgeLifecycle.test.ts`
- Modify: `server/productService.ts`
- Modify: `server/productService.test.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Add failing scheduler assertions for knowledge media**

In `server/knowledge/knowledgeLifecycle.test.ts`, create a recording scheduler:

```ts
const scheduled = { upserts: [] as string[], deletes: [] as string[] };
const scheduler: KnowledgeIndexScheduler = {
  async scheduleUpsert(_organizationId, entryId) { scheduled.upserts.push(entryId); },
  async scheduleDelete(_organizationId, entryId) { scheduled.deletes.push(entryId); },
};
```

Create a published L3 entry, call `KnowledgeService.addMedia`, and assert:

```ts
assert.deepEqual(scheduled.upserts, [entry.id]);
```

- [ ] **Step 2: Add failing product media scheduling tests**

Construct `ProductService` with a recording scheduler, upload an image, remove it, and assert:

```ts
assert.equal(scheduled.upserts.length, 1);
assert.equal(scheduled.deletes.length, 1);
```

The delete assertion applies when removing the final media deletes the generated `产品媒体` knowledge entry. Add a second case with remaining media and assert a second upsert instead of delete.

- [ ] **Step 3: Run the two tests to verify RED**

Run:

```powershell
node --import tsx --test server/knowledge/knowledgeLifecycle.test.ts server/productService.test.ts
```

Expected: FAIL because media mutations do not schedule vector work.

- [ ] **Step 4: Schedule from `KnowledgeService.addMedia`**

After updating the repository:

```ts
if (kind === 'image' && this.isVectorEligible(updated)) {
  await this.indexScheduler.scheduleUpsert(actor.organizationId, updated.id);
}
```

- [ ] **Step 5: Inject the scheduler into `ProductService` and schedule mutations**

Add a local no-op scheduler and change the constructor:

```ts
const noIndexScheduler: KnowledgeIndexScheduler = {
  async scheduleUpsert() {},
  async scheduleDelete() {},
};

constructor(
  private readonly repository: Repository,
  private readonly storage?: ObjectStorage,
  private readonly indexScheduler: KnowledgeIndexScheduler = noIndexScheduler,
) {}
```

After image upload, schedule the updated/generated published L3 entry only when `kind === 'image'`:

```ts
if (kind === 'image') await this.indexScheduler.scheduleUpsert(actor.organizationId, entry.id);
```

After media removal:

```ts
if (entry.category === '产品媒体' && entry.origin === 'manual' && remainingAssets.length === 0) {
  await this.indexScheduler.scheduleDelete(actor.organizationId, entry.id);
} else if (asset.kind === 'image') {
  await this.indexScheduler.scheduleUpsert(actor.organizationId, entry.id);
}
```

Do not schedule a video-only addition or the removal of a video while the knowledge entry remains present; this feature does not create video vectors.

- [ ] **Step 6: Pass the real scheduler from `server/index.ts`**

Change:

```ts
const products = new ProductService(repository, storage, knowledgeIndexer);
```

- [ ] **Step 7: Run media lifecycle tests and typecheck**

Run:

```powershell
node --import tsx --test server/knowledge/knowledgeLifecycle.test.ts server/productService.test.ts
npm.cmd run typecheck
```

Expected: PASS.

### Task 6: Update Reindexing, Configuration and Operations Docs

**Files:**
- Modify: `server/scripts/reindexKnowledge.ts`
- Modify: `server/config.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `DEPLOYMENT.md`

- [ ] **Step 1: Capture the failing dry-run expectation before changing the summary**

Run the current end-to-end dry-run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
```

RED condition: the command exits `0`, but the parsed final JSON object has no numeric `images`, `imagesIndexed`, or `imagesFailed` fields.

- [ ] **Step 2: Make reindex use the same storage and point builder**

Instantiate object storage with the same selection as `server/index.ts`, then replace direct text chunk construction with:

```ts
const built = await buildKnowledgeVectorPoints({
  organizationId,
  entry,
  repository,
  storage,
  config,
});
await vectorIndex.replaceEntry(organizationId, entry.id, built.points);
```

Extend `ReindexSummary` and per-entry output with:

```ts
images: number;
imagesIndexed: number;
imagesFailed: number;
```

For `--dry-run`, count image assets from `structuredData.mediaAssets` without reading object storage or calling either embedding API.

- [ ] **Step 3: Change the default physical collection name**

In `server/config.ts` and `.env.example`, use:

```text
sales_knowledge_gemini_embedding_2_preview_multimodal_3072_v2
```

Keep `sales_knowledge_current` as the alias.

- [ ] **Step 4: Update README and deployment instructions**

Document these exact facts:

- all published L2/L3 images receive an auxiliary image vector;
- `text` is the primary vector and `image` is the fallback vector;
- PNG/JPEG pass through and other image formats are converted to JPEG for embedding only;
- the v2 collection must be fully rebuilt and checked before alias switching;
- image failures appear in entry embedding status but do not suppress text retrieval;
- never log API keys, image base64 or vectors.

- [ ] **Step 5: Run dry-run and documentation/config checks**

Run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
rg -n "multimodal_3072_v2|named vector|图片向量|imageFailedCount" README.md DEPLOYMENT.md .env.example server/config.ts
```

Expected: dry-run JSON includes `images`, `imagesIndexed: 0`, `imagesFailed: 0`; all four files name the v2 collection consistently.

### Task 7: Full Verification and Safe Qdrant Migration Exercise

**Files:**
- Verify all modified files
- No new feature code unless a test exposes a defect

- [ ] **Step 1: Run all automated checks**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:api
```

Expected: all commands exit `0`; output contains no secrets, base64 images or full vectors.

- [ ] **Step 2: Start or inspect local Qdrant**

Run:

```powershell
npm.cmd run qdrant:up
docker compose -f docker-compose.qdrant.yml ps
```

Expected: Qdrant is healthy on the configured local port. If Docker is unavailable, report that live Qdrant migration verification is blocked while retaining unit-test evidence.

- [ ] **Step 3: Create and validate the v2 collection without switching production alias**

Temporarily point `QDRANT_COLLECTION_ALIAS` to a test alias and run:

```powershell
$env:QDRANT_COLLECTION_ALIAS='sales_knowledge_multimodal_test'
npm.cmd run knowledge:reindex -- --organization=default-org
Remove-Item Env:QDRANT_COLLECTION_ALIAS
```

Expected summary:

- `failed` equals `0` for text indexing;
- `imagesIndexed + imagesFailed` equals `images`;
- Qdrant point count equals text points plus successful image points.

- [ ] **Step 4: Exercise both named searches**

Run the focused Qdrant integration test with the live-Qdrant test environment enabled if configured; otherwise call `QdrantVectorIndex.search()` from a temporary `tsx -e` expression using one real query embedding. Print only `entryId`, fused `score`, and whether `chunkId` is present. Verify at least one request uses `text`, one uses `image`, all returned entries belong to `default-org`, and each corresponding business record is published L2/L3.

- [ ] **Step 5: Repeat the safe Yunwu probe through production code**

Run a focused call to `createKnowledgeImageEmbedding` with the same one-pixel PNG. Print only `{ dimensions, modelVersion, inputTokens }`.

Expected: `dimensions` is `3072`.

- [ ] **Step 6: Review the final scope**

Run:

```powershell
rg -n "MODEL_API_KEY|x-goog-api-key|inline_data|storageKey|imageFailures" server README.md DEPLOYMENT.md .env.example
```

Verify manually:

- no literal secret was added;
- no payload stores `storageKey` or base64;
- text-only knowledge behavior remains unchanged;
- only the files listed in the File Map changed;
- old v1 collection is not deleted automatically.

---

## Completion Criteria

- Yunwu direct image request returns a validated 3072-dimensional vector.
- Qdrant v2 uses `text` and `image` named vectors.
- Every published L2/L3 image is attempted from either direct storage or import source storage.
- Image failures preserve text indexing and are visible as stable counts/codes.
- Retrieval performs 80/20 fusion and allows image-only supplement when text candidates are insufficient.
- Image add/remove operations schedule correct upsert/delete work.
- Reindex dry-run and real summary include image counts.
- Full tests, typecheck and both builds pass.
