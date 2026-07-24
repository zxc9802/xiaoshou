# Knowledge Retrieval Quality Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent published test/meta knowledge from participating in retrieval while allowing exact product facts outside Qdrant Top 30 to enter the final hybrid ranking.

**Architecture:** Add one pure eligibility predicate shared by runtime retrieval and Qdrant chunk construction. Runtime retrieval will rank every published, effective, eligible L2/L3 entry, using Qdrant scores when present and lexical/category scores for the full candidate set; existing mandatory L0/L1/L4 selection and downstream citation validation remain unchanged.

**Tech Stack:** TypeScript, Node.js test runner, Qdrant-compatible vector index, PostgreSQL-backed knowledge records.

---

## File Structure

- Create `server/knowledge/eligibility.ts`: pure, shared decision for whether a knowledge entry may participate in retrieval/indexing.
- Create `server/knowledge/eligibility.test.ts`: high-confidence exclusion and false-positive regression tests.
- Modify `server/knowledge/chunking.ts`: return no Qdrant chunks for ineligible entries.
- Modify `server/knowledge/chunking.test.ts`: prove explicit and inferred meta exclusions never produce vectors.
- Modify `server/knowledge/retrieval.ts`: filter all layers through the shared predicate and rank the full eligible L2/L3 candidate set.
- Modify `server/knowledge/retrieval.test.ts`: replace the dense-only-candidate expectation and add the exact online light-tea regression.

No database schema, API contract, object-storage code, knowledge record status, or UI file changes are required.

### Task 1: Add the Shared Retrieval Eligibility Predicate

**Files:**
- Create: `server/knowledge/eligibility.ts`
- Create: `server/knowledge/eligibility.test.ts`

- [ ] **Step 1: Write the failing eligibility tests**

Create `server/knowledge/eligibility.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { isKnowledgeRetrievalEligible } from './eligibility.js';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = '2026-07-24T00:00:00.000Z';
  return {
    id: 'entry-1',
    layer: 'L3',
    category: '产品资料',
    title: '轻茶产品定位',
    content: '轻茶不是减肥药，是一款低负担日常饮品。',
    version: '1.0',
    status: 'published',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('explicit retrievalEligible false always excludes an entry', () => {
  assert.equal(isKnowledgeRetrievalEligible(entry({
    structuredData: { retrievalEligible: false },
  })), false);
});

test('high-confidence answer keys and AI evaluation instructions are excluded', () => {
  const excluded = [
    entry({ title: '十一、客户隐藏信息', content: '本节不要输入给销转智能体。它用于判断AI分析是否准确。' }),
    entry({ id: 'entry-2', title: '十三、智能体应生成的推荐回复', content: '这里给出本题预期答案。' }),
    entry({ id: 'entry-3', title: '减肥茶销转智能体合规评分标准', content: '按以下维度给智能体回答打分。' }),
    entry({ id: 'entry-4', title: '测试说明', content: '以下内容用于评测 AI 回复是否正确。' }),
    entry({ id: 'entry-5', title: '智能体回答合规、诚实', content: '回答不得夸大产品效果。' }),
  ];

  assert.deepEqual(excluded.map(isKnowledgeRetrievalEligible), [false, false, false, false, false]);
});

test('real compliance, tactics, and product facts remain eligible', () => {
  const eligible = [
    entry({ title: '产品宣传合规要求', content: '不得承诺治疗效果，不得虚构用户案例。' }),
    entry({ id: 'entry-2', layer: 'L2', category: '销售技巧', title: '价格异议处理', content: '先确认预算，再解释产品价值。' }),
    entry({ id: 'entry-3', title: '普通乌龙茶竞品区别', content: '普通乌龙茶强调茶味，轻茶强调低负担饮用体验。' }),
  ];

  assert.deepEqual(eligible.map(isKnowledgeRetrievalEligible), [true, true, true]);
});
```

- [ ] **Step 2: Run the eligibility test to verify it fails**

Run:

```powershell
node --import tsx --test server/knowledge/eligibility.test.ts
```

Expected: FAIL because `server/knowledge/eligibility.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared predicate**

Create `server/knowledge/eligibility.ts`:

```ts
import type { KnowledgeEntry } from '../../shared/contracts.js';

const STRUCTURED_TEXT_KEYS = [
  'businessCategory',
  'analysisSummary',
  'sourceFileName',
  'purpose',
  'description',
] as const;

const META_KNOWLEDGE_PATTERNS = [
  /(?:客户)?隐藏(?:信息|资料)/i,
  /(?:不要|不得|禁止).{0,16}(?:输入|提供|展示|返回|写入|泄露).{0,16}(?:AI|人工智能|销转智能体|智能体|模型)/i,
  /(?:标准答案|参考答案|预期答案|答案要点)/i,
  /智能体应(?:当)?生成的?(?:推荐)?回复/i,
  /智能体回答.{0,8}(?:合规|诚实)/i,
  /(?:AI|人工智能|销转智能体|智能体|模型).{0,16}(?:合规)?评分标准/i,
  /(?:合规)?评分标准.{0,16}(?:AI|人工智能|销转智能体|智能体|模型)/i,
  /(?:用于|用来).{0,8}(?:判断|验证|测试|评测).{0,24}(?:AI|人工智能|销转智能体|智能体|模型).{0,16}(?:分析|回答|回复).{0,12}(?:准确|正确|合规)/i,
] as const;

function retrievalText(entry: KnowledgeEntry) {
  const structuredText = STRUCTURED_TEXT_KEYS
    .map((key) => entry.structuredData?.[key])
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return `${entry.title}\n${entry.content}\n${structuredText}`.replace(/\s+/g, ' ').trim();
}

export function isKnowledgeRetrievalEligible(entry: KnowledgeEntry) {
  if (entry.structuredData?.retrievalEligible === false) return false;
  const text = retrievalText(entry);
  return !META_KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(text));
}
```

- [ ] **Step 4: Run the eligibility test to verify it passes**

Run:

```powershell
node --import tsx --test server/knowledge/eligibility.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit the shared predicate**

```powershell
git add -- server/knowledge/eligibility.ts server/knowledge/eligibility.test.ts
git diff --cached --check
git commit -m "fix: exclude meta knowledge from retrieval"
```

### Task 2: Keep Ineligible Knowledge Out of Qdrant Chunks

**Files:**
- Modify: `server/knowledge/chunking.ts:1-154`
- Modify: `server/knowledge/chunking.test.ts`

- [ ] **Step 1: Write failing chunking regression tests**

Append to `server/knowledge/chunking.test.ts`:

```ts
test('does not build chunks for explicit or inferred meta knowledge', () => {
  const explicit = entry({
    structuredData: {
      businessCategory: '产品资料',
      retrievalEligible: false,
    },
  });
  const inferred = entry({
    id: '22222222-2222-4222-8222-222222222222',
    title: '十三、智能体应生成的推荐回复',
    content: '这里是测试题的标准答案。',
  });

  assert.deepEqual(buildKnowledgeChunks('org-a', explicit), []);
  assert.deepEqual(buildKnowledgeChunks('org-a', inferred), []);
});
```

- [ ] **Step 2: Run the chunking test to verify it fails**

Run:

```powershell
node --import tsx --test server/knowledge/chunking.test.ts
```

Expected: FAIL because both entries still produce chunks.

- [ ] **Step 3: Apply the shared predicate in chunk construction**

In `server/knowledge/chunking.ts`, add:

```ts
import { isKnowledgeRetrievalEligible } from './eligibility.js';
```

Change the first guard in `buildKnowledgeChunks` to:

```ts
export function buildKnowledgeChunks(organizationId: string, entry: KnowledgeEntry): KnowledgeChunk[] {
  if ((entry.layer !== 'L2' && entry.layer !== 'L3')
    || entry.status !== 'published'
    || entry.deletedAt
    || !isKnowledgeRetrievalEligible(entry)) return [];
```

Leave all chunk format, hashing, content type, and metadata behavior unchanged.

- [ ] **Step 4: Run chunking and indexing service tests**

Run:

```powershell
node --import tsx --test server/knowledge/chunking.test.ts server/knowledgeIndexService.test.ts
```

Expected: all tests pass; normal knowledge still creates points and excluded knowledge creates zero chunks.

- [ ] **Step 5: Commit the indexing filter**

```powershell
git add -- server/knowledge/chunking.ts server/knowledge/chunking.test.ts
git diff --cached --check
git commit -m "fix: skip meta knowledge vector chunks"
```

### Task 3: Rank the Full Eligible Hybrid Candidate Set

**Files:**
- Modify: `server/knowledge/retrieval.ts:1-83`
- Modify: `server/knowledge/retrieval.test.ts`

- [ ] **Step 1: Replace the obsolete dense-only test with a failing full-candidate test**

Replace `dense retrieval reranks only Qdrant entry IDs and deduplicates multiple chunks` in `server/knowledge/retrieval.test.ts` with:

```ts
test('dense retrieval deduplicates chunks and still ranks lexical candidates outside Qdrant hits', async (t) => {
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

  assert.equal(result.filter((item) => item.id === 'price').length, 1);
  assert.equal(result.some((item) => item.id === 'not-returned'), true);
});
```

- [ ] **Step 2: Add the failing online light-tea regression**

Append to `server/knowledge/retrieval.test.ts`:

```ts
test('online light-tea query excludes answer keys and recalls direct facts outside dense hits', async (t) => {
  mockEmbedding(t);
  const vectorIndex = new RecordingVectorIndex([
    { id: 'meta-1-point', score: 0.99, entryId: 'meta-1', chunkId: 'meta-1-chunk', sequence: 0, content: '推荐回复' },
    { id: 'meta-2-point', score: 0.98, entryId: 'meta-2', chunkId: 'meta-2-chunk', sequence: 0, content: '评分标准' },
    { id: 'product-point', score: 0.3, entryId: 'product', chunkId: 'product-chunk', sequence: 0, content: '产品定位' },
  ]);
  const competitor = {
    ...entry('competitor', 'L3', '竞品类型二：普通乌龙茶', '普通乌龙茶强调茶味，轻茶强调低负担日常饮用体验。'),
    category: '竞品对比',
  };
  const price = {
    ...entry('price', 'L3', '轻茶价格政策', '轻茶当前价格为169元，具体优惠以审核报价为准。'),
    category: '价格政策',
  };

  const result = await retrieveKnowledge([
    entry('meta-1', 'L3', '十三、智能体应生成的推荐回复', '本节给出测试题的标准答案。'),
    entry('meta-2', 'L3', '减肥茶销转智能体合规评分标准', '用于判断智能体回答是否合规。'),
    entry('product', 'L3', '一、模拟产品总设定', '轻茶不是减肥药，是一款低负担日常饮品。'),
    competitor,
    price,
    {
      ...entry('after-sales', 'L3', '售后政策', '饮用体验因人而异，不承诺固定效果；售后按已审核规则执行。'),
      category: '售后政策',
    },
  ], [
    '销售：这款轻茶适合日常喝。',
    '客户：和普通乌龙茶有什么区别？',
    '销售：更强调低负担饮用体验。',
    '客户：多少钱？',
    '销售：169元。',
    '客户：如果喝了没效果怎么办？',
    '销售：体验因人而异。',
    '客户：那你建议我怎么选？',
  ].join('\n'), embeddingConfig(), {
    organizationId: 'org-a',
    ownerId: 'demo-user',
    limit: 4,
    vectorIndex,
  });

  const ids = result.map((item) => item.id);
  assert.equal(ids.includes('meta-1'), false);
  assert.equal(ids.includes('meta-2'), false);
  assert.equal(ids.includes('product'), true);
  assert.equal(ids.includes('competitor'), true);
  assert.equal(ids.includes('price'), true);
});
```

- [ ] **Step 3: Run retrieval tests to verify the new expectations fail**

Run:

```powershell
node --import tsx --test server/knowledge/retrieval.test.ts
```

Expected: the dense-candidate test omits `not-returned`, and the online regression either returns meta entries or misses direct facts.

- [ ] **Step 4: Filter retrieval and rank every eligible L2/L3 entry**

In `server/knowledge/retrieval.ts`, add:

```ts
import { isKnowledgeRetrievalEligible } from './eligibility.js';
```

Change published filtering to:

```ts
const published = entries.filter((entry) =>
  entry.status === 'published'
  && !entry.deletedAt
  && effective(entry)
  && isKnowledgeRetrievalEligible(entry),
);
```

Remove:

```ts
const byId = new Map(eligible.map((entry) => [entry.id, entry]));
```

Replace the dense-only candidate selection and ranking start:

```ts
const candidates = denseByEntry.size
  ? [...denseByEntry.keys()].map((id) => byId.get(id)).filter((entry): entry is KnowledgeEntry => Boolean(entry))
  : eligible;
const ranked = candidates.map((entry) => {
```

with:

```ts
const ranked = eligible.map((entry) => {
```

Change tactic selection to exclude zero-score filler:

```ts
const tactics = ranked
  .filter((item) => item.entry.layer === 'L2' && item.score > 0)
  .slice(0, Math.min(4, limit))
  .map((item) => item.entry);
```

Keep dense chunk deduplication and the existing score formula unchanged.

- [ ] **Step 5: Run focused retrieval tests**

Run:

```powershell
node --import tsx --test server/knowledge/eligibility.test.ts server/knowledge/chunking.test.ts server/knowledge/retrieval.test.ts
```

Expected: all eligibility, chunking, fallback, mandatory-layer, dense-search, and online regression tests pass.

- [ ] **Step 6: Commit the hybrid retrieval correction**

```powershell
git add -- server/knowledge/retrieval.ts server/knowledge/retrieval.test.ts
git diff --cached --check
git commit -m "fix: preserve lexical facts in hybrid retrieval"
```

### Task 4: Verify the Complete Change

**Files:**
- Verify only; no new production files.

- [ ] **Step 1: Run the full server test suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass, including the original 84-test baseline plus the new regressions.

- [ ] **Step 2: Run type checking**

Run:

```powershell
npm.cmd run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run production builds**

Run:

```powershell
npm.cmd run build
npm.cmd run build:api
```

Expected: both commands exit 0.

- [ ] **Step 4: Audit the final diff**

Run:

```powershell
git status --short
git diff --check HEAD~3..HEAD
git diff --stat HEAD~3..HEAD
git log --oneline -4
```

Expected: only the six planned knowledge files changed across three implementation commits; no object-storage, UI, API contract, or database-schema files changed.

### Task 5: Publish, Reindex, and Verify Online

**Files:**
- No source changes expected.

- [ ] **Step 1: Push the isolated repair branch**

Run:

```powershell
git push -u origin agent/fix-knowledge-retrieval-quality
```

Expected: GitHub confirms the branch update without including the dirty files from the original worktree.

- [ ] **Step 2: Deploy the exact pushed commit through the existing production deployment**

Record:

```powershell
git rev-parse HEAD
```

Expected: the production API deployment reports this exact commit as successfully built and running before any reindex is started.

- [ ] **Step 3: Confirm production dependencies before reindex**

Request:

```text
GET https://xiaoshou-api.qycm.top/api/health
```

Expected: `ok: true`, repository `postgres`, embedding model `text-embedding-3-small` with 1536 dimensions, and Qdrant `configured: true`, `ok: true`. Object storage may remain `file`; it is not an acceptance gate for this text-retrieval fix.

- [ ] **Step 4: Dry-run the production organization reindex**

Run inside the deployed API environment, using the production organization ID already configured for this tenant:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
```

Expected: the command reports fewer chunks than before because excluded meta entries now create zero chunks; it performs no writes.

- [ ] **Step 5: Rebuild and atomically switch the production alias**

Run:

```powershell
npm.cmd run knowledge:reindex -- --organization=default-org
npm.cmd run knowledge:reindex -- --organization=default-org --switch-alias
```

Expected: both runs report `failed: 0`; the second reports `aliasSwitched: true`. Do not switch the alias if any entry fails.

- [ ] **Step 6: Verify production retrieval with the reproduced dialogue**

In the logged-in production UI, submit the eight-message light-tea dialogue from Task 3 and inspect the generated source references.

Expected:

- no source title contains “隐藏信息”, “标准答案”, “智能体应生成的推荐回复”, or “评分标准”;
- sources include direct product positioning, ordinary-oolong comparison, price, or after-sales facts;
- the analysis completes normally and existing safety validation still applies;
- production knowledge record count and publication statuses are unchanged.

- [ ] **Step 7: Record rollback boundary**

Record the previous deployment commit and current Qdrant alias target before cleanup. If production retrieval regresses, redeploy the previous commit and atomically restore the previous alias; do not modify knowledge record statuses.
