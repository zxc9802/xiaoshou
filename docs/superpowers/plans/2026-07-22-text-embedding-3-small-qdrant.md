# text-embedding-3-small Qdrant Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将知识库文字 embedding 切换为 `text-embedding-3-small` 1536 维，在新的 Qdrant 物理 collection 完成重建并安全切换 alias，同时保持 Gemini 生成和图片文字解析流程不变。

**Architecture:** 生成模型与 embedding 使用独立协议配置；embedding 客户端按 `EMBEDDING_API_STYLE` 请求 OpenAI `/v1/embeddings` 或保留的 Gemini 路径。Qdrant 写操作指向物理 collection，查询指向 alias；重建零失败后才允许显式原子切换 alias。

**Tech Stack:** TypeScript、Node.js test runner、OpenAI-compatible embeddings REST、Qdrant REST API、现有 Repository/KnowledgeIndexService。

**Repository note:** `D:\销转智能体\12` 没有 `.git` 元数据，无法创建 worktree 或 commit；每个任务以 RED/GREEN 测试和范围检查作为检查点。

---

## File Map

- Modify `server/config.ts`: 独立 embedding 协议、地址、密钥和 1536 维默认配置。
- Modify `server/model/embeddings.ts`: 独立协议选择、OpenAI URL 规范化、usage 解析。
- Modify `server/model/embeddings.test.ts`: OpenAI 1536 维、独立密钥、URL 和 Gemini 兼容测试。
- Modify `server/infrastructure/qdrantVectorIndex.ts`: 1536 维默认 collection、物理写入和 alias 原子切换。
- Modify `server/infrastructure/qdrantVectorIndex.test.ts`: 1536/Cosine、物理写入、alias 查询和切换测试。
- Modify `server/scripts/reindexKnowledge.ts`: 新配置校验、重建到物理 collection、`--switch-alias` 门槛。
- Modify `server/knowledgeIndexService.ts`, `server/knowledgeService.ts`, `server/index.ts`: 将未显式配置时的维度元数据默认值改为 1536。
- Modify `server/knowledgeIndexService.test.ts`, `server/knowledge/retrieval.test.ts`: 使用独立 embedding 配置。
- Modify `.env`, `.env.example`: 当前环境和示例切换到新模型与新 collection，不改密钥内容。
- Modify `README.md`, `DEPLOYMENT.md`: 新模型、重建、验证、alias 切换和回退说明。

### Task 1: Decouple Embedding Configuration and Prove the OpenAI Path

**Files:**
- Modify: `server/config.ts`
- Modify: `server/model/embeddings.test.ts`
- Modify: `server/model/embeddings.ts`

- [x] **Step 1: Add RED tests for independent OpenAI embedding configuration**

Extend the test config with explicit embedding fields and add:

```ts
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
```

Change the existing Gemini endpoint test to set:

```ts
embeddingApiStyle: 'gemini_generate_content',
embeddingBaseUrl: 'https://yunwu.example',
embeddingApiKey: 'test-key',
```

Change its wrong-dimension assertion to use an explicit `embeddingDimensions: 3072`, preserving Gemini backward compatibility.

- [x] **Step 2: Run tests to verify RED**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts
```

Expected: FAIL because `AppConfig` and the embedding client do not yet use the new independent fields, and the OpenAI URL is missing `/v1`.

- [x] **Step 3: Add independent embedding fields to `AppConfig`**

Add:

```ts
embeddingApiStyle?: 'openai' | 'gemini_generate_content';
embeddingBaseUrl?: string;
embeddingApiKey?: string;
```

Load them as:

```ts
embeddingApiStyle: enumValue(process.env.EMBEDDING_API_STYLE, ['openai', 'gemini_generate_content'] as const, 'openai'),
embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || process.env.MODEL_BASE_URL,
embeddingApiKey: process.env.EMBEDDING_API_KEY || process.env.MODEL_API_KEY,
embeddingModelName: process.env.EMBEDDING_MODEL_NAME ?? 'text-embedding-3-small',
embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
qdrantCollectionName: process.env.QDRANT_COLLECTION_NAME ?? 'sales_knowledge_text_embedding_3_small_1536_v1',
```

- [x] **Step 4: Implement protocol selection in `server/model/embeddings.ts`**

At the start of `createKnowledgeEmbedding`, resolve only embedding settings:

```ts
const model = config.embeddingModelName;
const expectedDimensions = config.embeddingDimensions ?? 1536;
const baseUrl = (config.embeddingBaseUrl ?? config.modelBaseUrl)?.replace(/\/$/, '');
const apiKey = config.embeddingApiKey ?? config.modelApiKey;
if (!baseUrl || !apiKey || !model) return undefined;
```

Use `config.embeddingApiStyle === 'gemini_generate_content'` for the existing Gemini branch and use `baseUrl`/`apiKey` in both branches.

Add:

```ts
function openAiEmbeddingsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/embeddings`;
}
```

The OpenAI request becomes:

```ts
const response = await fetch(openAiEmbeddingsUrl(baseUrl), {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  signal: AbortSignal.timeout(20_000),
  body: JSON.stringify({ model, input: text }),
});
```

Parse usage without logging the response:

```ts
const body = await response.json() as {
  model?: string;
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};
return {
  model: body.model ?? model,
  inputTokens: body.usage?.prompt_tokens,
  vector: validateVector(body.data?.[0]?.embedding, expectedDimensions),
};
```

- [x] **Step 5: Run GREEN tests and typecheck**

Run:

```powershell
node --import tsx --test server/model/embeddings.test.ts
npm.cmd run typecheck
```

Expected: embedding tests PASS and typecheck exits `0`.

### Task 2: Isolate Qdrant Physical Writes and Add Atomic Alias Switching

**Files:**
- Modify: `server/infrastructure/qdrantVectorIndex.test.ts`
- Modify: `server/infrastructure/qdrantVectorIndex.ts`

- [x] **Step 1: Change Qdrant expectations to 1536 and physical writes**

Change the test config to:

```ts
embeddingDimensions: 1536,
qdrantCollectionName: 'knowledge-1536-v1',
```

Expect collection creation:

```ts
assert.deepEqual(collection?.body, { vectors: { size: 1536, distance: 'Cosine' } });
```

In the replace test assert both calls use the physical collection:

```ts
assert.match(calls[0]!.url, /\/collections\/knowledge-1536-v1\/points\?wait=true$/);
assert.match(calls[1]!.url, /\/collections\/knowledge-1536-v1\/points\/delete\?wait=true$/);
```

In the search test capture the URL and assert:

```ts
assert.match(searchUrl, /\/collections\/knowledge-current\/points\/query$/);
```

Add an alias-switch test:

```ts
test('atomically switches an existing alias to the configured physical collection', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return response({ result: { aliases: [{ alias_name: 'knowledge-current', collection_name: 'knowledge-3072-v1' }] } });
    return response();
  };

  await new QdrantVectorIndex(config()).switchAlias();

  assert.deepEqual(calls.at(-1)?.body, { actions: [
    { delete_alias: { alias_name: 'knowledge-current' } },
    { create_alias: { collection_name: 'knowledge-1536-v1', alias_name: 'knowledge-current' } },
  ] });
});
```

- [x] **Step 2: Run Qdrant tests to verify RED**

Run:

```powershell
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
```

Expected: FAIL because writes still use the alias and `switchAlias()` is missing.

- [x] **Step 3: Change Qdrant defaults and physical write targets**

Use:

```ts
this.collectionName = config.qdrantCollectionName ?? 'sales_knowledge_text_embedding_3_small_1536_v1';
this.dimensions = config.embeddingDimensions ?? 1536;
```

Change only the upsert and stale-point delete URLs from `this.alias` to `this.collectionName`. Keep `search()` and `health()` on the alias.

- [x] **Step 4: Implement explicit atomic alias switching**

Add:

```ts
async switchAlias() {
  const existing = await this.request<{
    result?: { aliases?: Array<{ alias_name?: string; collection_name?: string }> };
  }>('GET', '/aliases');
  const current = existing?.result?.aliases?.find((item) => item.alias_name === this.alias)?.collection_name;
  if (current === this.collectionName) return;
  await this.request('POST', '/collections/aliases', {
    actions: [
      ...(current ? [{ delete_alias: { alias_name: this.alias } }] : []),
      { create_alias: { collection_name: this.collectionName, alias_name: this.alias } },
    ],
  });
}
```

Do not call it from `initialize()` when an alias already exists.

- [x] **Step 5: Run GREEN Qdrant tests and typecheck**

Run:

```powershell
node --import tsx --test server/infrastructure/qdrantVectorIndex.test.ts
npm.cmd run typecheck
```

Expected: PASS.

### Task 3: Switch Application Defaults and Local Configuration

**Files:**
- Modify: `server/knowledgeIndexService.ts`
- Modify: `server/knowledgeService.ts`
- Modify: `server/index.ts`
- Modify: `server/knowledgeIndexService.test.ts`
- Modify: `server/knowledge/retrieval.test.ts`
- Modify: `.env`
- Modify: `.env.example`

- [x] **Step 1: Add a RED metadata assertion**

Add a default-dimension regression test before changing runtime fallbacks:

```ts
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
```

In `server/knowledgeIndexService.test.ts`, change the test config to the independent OpenAI settings and 1536 dimensions:

```ts
embeddingApiStyle: 'openai',
embeddingBaseUrl: 'https://yunwu.example',
embeddingApiKey: 'test-key',
embeddingModelName: 'text-embedding-3-small',
embeddingDimensions: 1536,
```

In the indexed-entry assertion add:

```ts
assert.equal((stored?.structuredData?.embedding as { dimensions?: number })?.dimensions, 1536);
assert.equal((stored?.structuredData?.embedding as { model?: string })?.model, 'text-embedding-3-small');
```

Change `server/knowledge/retrieval.test.ts` embedding config the same way and have its fetch mock return the OpenAI response shape with 1536 values.

- [x] **Step 2: Run service/retrieval tests to verify RED**

Run:

```powershell
node --import tsx --test server/knowledgeIndexService.test.ts server/knowledge/retrieval.test.ts
```

Expected: FAIL because the current metadata fallback is 3072 instead of 1536.

- [x] **Step 3: Replace remaining 3072 fallback metadata values**

Change only embedding/Qdrant fallback values in runtime source:

```ts
config.embeddingDimensions ?? 1536
```

Apply this in `server/knowledgeIndexService.ts`, `server/knowledgeService.ts`, and `server/index.ts`. Do not change historical design documents or explicitly configured Gemini compatibility tests.

- [x] **Step 4: Update current `.env` without touching secret lines**

Add or replace only these keys:

```text
EMBEDDING_API_STYLE=openai
EMBEDDING_BASE_URL=https://yunwu.ai
EMBEDDING_MODEL_NAME=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
QDRANT_COLLECTION_NAME=sales_knowledge_text_embedding_3_small_1536_v1
QDRANT_COLLECTION_ALIAS=sales_knowledge_current
```

Do not add a literal `EMBEDDING_API_KEY`; the current environment deliberately falls back to `MODEL_API_KEY`.

- [x] **Step 5: Update `.env.example`**

Document the independent embedding keys with empty secrets and the same new model, dimensions, collection and alias.

- [x] **Step 6: Run GREEN service tests, config scan and typecheck**

Run:

```powershell
node --import tsx --test server/knowledgeIndexService.test.ts server/knowledge/retrieval.test.ts
rg -n "^(MODEL_API_STYLE|EMBEDDING_|QDRANT_COLLECTION_)" .env .env.example
npm.cmd run typecheck
```

Expected: tests/typecheck PASS; scan shows Gemini generation plus OpenAI embedding and contains no secret value.

### Task 4: Add a Zero-Failure Alias-Switch Gate to Reindexing

**Files:**
- Modify: `server/scripts/reindexKnowledge.ts`
- Modify: `README.md`
- Modify: `DEPLOYMENT.md`

- [x] **Step 1: Capture existing dry-run output before changing the command**

Run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
```

RED observation: output has no `aliasSwitchRequested` or `aliasSwitched` fields.

- [x] **Step 2: Add the explicit switch flag and safe summary fields**

Add:

```ts
const switchAlias = process.argv.includes('--switch-alias');
```

Extend the summary:

```ts
aliasSwitchRequested: switchAlias,
aliasSwitched: false,
```

Update configuration validation to use resolved embedding settings:

```ts
if (!(config.embeddingBaseUrl ?? config.modelBaseUrl)
  || !(config.embeddingApiKey ?? config.modelApiKey)
  || !config.embeddingModelName) {
  throw new Error('Embedding model configuration is required');
}
```

After all entries finish:

```ts
if (switchAlias && summary.failed === 0) {
  await vectorIndex.switchAlias();
  summary.aliasSwitched = true;
}
```

Print the final summary only after this block. If `summary.failed > 0`, do not call `switchAlias()` and retain exit code `1`.

- [x] **Step 3: Update operations documentation**

README must show:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
npm.cmd run knowledge:reindex -- --organization=default-org
npm.cmd run knowledge:reindex -- --organization=default-org --switch-alias
```

DEPLOYMENT must state that the third command is allowed only after the second command reports `failed: 0` and point counts are verified. Document the old 3072 collection as the rollback alias target and prohibit automatic deletion.

- [x] **Step 4: Verify dry-run and docs**

Run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
rg -n "text-embedding-3-small|1536|switch-alias|failed.*0|3072" README.md DEPLOYMENT.md
```

Expected: dry-run reports `aliasSwitchRequested: false` and `aliasSwitched: false`; documentation contains all migration gates.

### Task 5: Full Verification and Local Migration

**Files:**
- Verify all modified files
- No new feature code unless verification exposes a defect

- [x] **Step 1: Run complete automated verification**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run build:api
```

Expected: all commands exit `0` with zero failed tests.

- [x] **Step 2: Repeat the safe live embedding probe through production code**

Run a `tsx -e` call to `loadConfig()` and `createKnowledgeEmbedding('这是上线前连通性测试。', config)`. Print only model, dimensions and input token count.

Expected: model is `text-embedding-3-small`, dimensions are `1536`, and no key/vector is printed.

- [x] **Step 3: Start or inspect local Qdrant**

Run:

```powershell
npm.cmd run qdrant:up
docker compose -f docker-compose.qdrant.yml ps
```

Expected: Qdrant container is running. If Docker is unavailable, report live migration as blocked but keep automated verification evidence.

- [x] **Step 4: Dry-run and build the new physical collection**

Run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
npm.cmd run knowledge:reindex -- --organization=default-org
```

Expected: real summary reports `failed: 0` and `aliasSwitched: false`.

- [x] **Step 5: Verify physical collection before switching**

Query Qdrant collection metadata and point count for:

```text
sales_knowledge_text_embedding_3_small_1536_v1
```

Verify size `1536`, distance `Cosine`, and point count equals dry-run chunk count.

- [x] **Step 6: Switch alias and verify online retrieval**

Only after Step 5 passes, run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --switch-alias
```

Expected: `failed: 0`, `aliasSwitched: true`, and `sales_knowledge_current` points to the new 1536 collection. Run one retrieval test/query and confirm only published L2/L3 entries appear.

- [x] **Step 7: Final security and scope scan**

Run:

```powershell
rg -n "MODEL_API_KEY|EMBEDDING_API_KEY|Authorization|x-goog-api-key|embedding.values|data.*embedding" server README.md DEPLOYMENT.md .env.example
rg -n "sharp|image_vector|vectorName.*image|80/20" server package.json
```

Verify no literal secret, complete vector, image-vector implementation or Sharp dependency was introduced. Confirm the old 3072 collection was not deleted.

---

## Completion Criteria

Execution note (2026-07-22): Docker CLI was unavailable, but the already-running local Qdrant instance was inspected through its REST API. The new collection was green with 18 points, 1536/Cosine configuration, `sales_knowledge_current` resolved to it, and a production-code dense query returned five L2/L3 hits. Alias discovery uses Qdrant's supported `GET /aliases` endpoint.

- Gemini generation continues using `MODEL_API_STYLE=gemini_generate_content`.
- `text-embedding-3-small` uses independent OpenAI `/v1/embeddings` configuration.
- Live production-code probe returns 1536 dimensions.
- New Qdrant collection is 1536/Cosine.
- Reindex writes the physical collection while search reads the alias.
- Alias switches only after a zero-failure rebuild and point-count verification.
- No direct image embedding code or dependency exists.
- Full tests, typecheck and both builds pass.
