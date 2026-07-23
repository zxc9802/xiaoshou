# Fact Evidence Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop false `blocked` results when a reply's concrete price, seat-count, percentage, or delivery facts are supported by published knowledge retrieved for the current analysis.

**Architecture:** Keep retrieval and the public response contract unchanged. Improve `salesAdvisor.ts` so source categories are derived from business meaning before layer fallback, then deterministically ground concrete facts against published entries already present in the current retrieval result. Preserve the existing safety gate by expanding factual-claim detection and leaving unmatched facts blocked.

**Tech Stack:** TypeScript, Node.js test runner, Zod, existing `SalesAnalysisResult` and `KnowledgeEntry` contracts.

---

## File map

- Modify `server/model/salesAdvisor.ts`: semantic source classification, concrete-fact extraction, safe source recovery, and fact-evidence calculation.
- Modify `server/model/salesAdvisor.test.ts`: production regression tests for L2 price sources, omitted citations, and unmatched facts.
- Modify `server/rules/analysisEngine.ts`: recognize concrete commercial values as factual claims that require evidence.
- Modify `server/rules/analysisEngine.test.ts`: regression test for a numeric commercial claim with no evidence.

### Task 1: Classify L2 price and product facts by meaning

**Files:**
- Modify: `server/model/salesAdvisor.test.ts`
- Modify: `server/model/salesAdvisor.ts:70-79`

- [ ] **Step 1: Add a reusable knowledge fixture and the failing L2 price regression test**

Add the contract import:

```ts
import type { KnowledgeEntry } from '../../shared/contracts.js';
```

Add this helper after `advice`:

```ts
function knowledgeSource(input: Pick<KnowledgeEntry, 'id' | 'title' | 'content'> & Partial<KnowledgeEntry>): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    origin: 'manual',
    locked: false,
    layer: 'L3',
    category: '产品资料',
    version: '1.0',
    status: 'published',
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}
```

Add this test:

```ts
test('published L2 price knowledge is treated as factual price evidence before the layer fallback', () => {
  const transcript = parseConversationText('客户：企业版价格是多少？\n销售：我核实一下');
  const source = knowledgeSource({
    id: 'l2-enterprise-price',
    layer: 'L2',
    category: '价格配置',
    title: '星河AI销转助手版本价格与交付标准',
    content: '企业版年费为29,800元，最多80个销售席位，标准交付周期为10个工作日。',
    structuredData: { businessCategory: '产品资料' },
  });
  const knowledge = [...DEFAULT_KNOWLEDGE, source];
  const baseline = analyzeWithRules(transcript, knowledge);
  const result = applyModelAdvice(baseline, {
    ...advice([source.id]),
    recommendedReply: '理解您对价格的关注。企业版价格为29,800元，最多80个销售席位，标准交付周期为10个工作日，您看可以吗？',
  }, transcript, knowledge, 'gemini-test');

  assert.equal(result.sourceReferences[0]?.category, '价格政策');
  assert.equal(result.validationReport.passed, true);
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```powershell
node --import tsx --test --test-name-pattern="published L2 price knowledge" server/model/salesAdvisor.test.ts
```

Expected: FAIL because the source category is currently `销售技巧` and `validationReport.passed` is false.

- [ ] **Step 3: Reorder `sourceCategory` by business meaning**

Replace `sourceCategory` with:

```ts
function sourceCategory(entry: KnowledgeEntry): SourceReference['category'] {
  const businessCategory = String(entry.structuredData?.businessCategory ?? '');
  const semanticLabel = `${entry.category}\n${entry.title}`;
  if (businessCategory === '竞品口径') return '竞品口径';
  if (businessCategory === '售后承诺') return '售后承诺';
  if (businessCategory === '禁用红线' || entry.layer === 'L0') return '禁用红线';
  if (businessCategory === '客户案例' || semanticLabel.includes('案例')) return '客户案例';
  if (/价格|套餐|报价|折扣|优惠|费用|年费/.test(semanticLabel)) return '价格政策';
  if (businessCategory === '产品资料') return '产品资料';
  if (businessCategory === '销售技巧' || entry.layer === 'L1' || entry.layer === 'L2') return '销售技巧';
  return entry.layer === 'L3' ? '产品资料' : '销售规则';
}
```

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run:

```powershell
node --import tsx --test --test-name-pattern="published L2 price knowledge" server/model/salesAdvisor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all sales-advisor tests**

Run:

```powershell
node --import tsx --test server/model/salesAdvisor.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 6: Commit the semantic classification fix**

```powershell
git add -- server/model/salesAdvisor.ts server/model/salesAdvisor.test.ts
git commit -m "Fix factual source category priority"
```

### Task 2: Ground concrete facts and recover omitted citations safely

**Files:**
- Modify: `server/model/salesAdvisor.test.ts`
- Modify: `server/model/salesAdvisor.ts:80-150`
- Modify: `server/rules/analysisEngine.ts:71-78`
- Modify: `server/rules/analysisEngine.test.ts`

- [ ] **Step 1: Add failing tests for citation recovery and mismatched facts**

Add these tests to `server/model/salesAdvisor.test.ts`:

```ts
test('model advice recovers a matching published source from the current retrieval result', () => {
  const transcript = parseConversationText('客户：企业版一年多少钱？\n销售：我查一下');
  const source = knowledgeSource({
    id: 'retrieved-enterprise-price',
    layer: 'L2',
    category: '套餐及价格',
    title: '企业版价格与交付标准',
    content: '企业版年费29,800元，最多80个销售席位，10个工作日标准交付。',
    structuredData: { businessCategory: '产品资料' },
  });
  const knowledge = [...DEFAULT_KNOWLEDGE, source];
  const baseline = analyzeWithRules(transcript, knowledge);
  const result = applyModelAdvice(baseline, {
    ...advice([]),
    recommendedReply: '理解您的预算顾虑。企业版年费为29,800元，最多80个销售席位，标准交付为10个工作日，您看可以吗？',
  }, transcript, knowledge, 'gemini-test');

  assert.equal(result.sourceReferences.some((item) => item.id === source.id), true);
  assert.equal(result.validationReport.passed, true);
});

test('model advice stays blocked when a cited source does not contain every concrete fact', () => {
  const transcript = parseConversationText('客户：企业版一年多少钱？\n销售：我查一下');
  const source = knowledgeSource({
    id: 'approved-enterprise-price',
    layer: 'L2',
    category: '套餐及价格',
    title: '企业版价格与交付标准',
    content: '企业版年费29,800元，最多80个销售席位，10个工作日标准交付。',
    structuredData: { businessCategory: '产品资料' },
  });
  const knowledge = [...DEFAULT_KNOWLEDGE, source];
  const baseline = analyzeWithRules(transcript, knowledge);
  const result = applyModelAdvice(baseline, {
    ...advice([source.id]),
    recommendedReply: '理解您的预算顾虑。企业版年费为39,800元，最多80个销售席位，标准交付为10个工作日，您看可以吗？',
  }, transcript, knowledge, 'gemini-test');

  assert.equal(result.validationReport.passed, false);
  assert.equal(result.validationReport.checks.find((check) => check.name === '事实依据')?.passed, false);
});
```

Add this test to `server/rules/analysisEngine.test.ts`:

```ts
test('numeric commercial claims require published factual evidence', () => {
  const transcript = parseConversationText('客户：请介绍企业版\n销售：我核实一下');
  const report = validateSalesReply('企业版年费39,800元，最多80席位，10个工作日交付，您看可以吗？', transcript, false);
  assert.equal(report.passed, false);
  assert.ok(report.unsupportedFacts.length > 0);
});
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```powershell
node --import tsx --test --test-name-pattern="recovers a matching published source|does not contain every concrete fact|numeric commercial claims" server/model/salesAdvisor.test.ts server/rules/analysisEngine.test.ts
```

Expected:

- citation recovery test FAILS because no source is added when `sourceIds` is empty;
- mismatched fact test FAILS because the current boolean category gate accepts the cited price source;
- numeric claim test FAILS because `年费`, `席位`, and `工作日` are not currently recognized by the local validator.

- [ ] **Step 3: Add deterministic concrete-fact helpers**

Add these helpers after `publishedKnowledge` in `server/model/salesAdvisor.ts`:

```ts
type ConcreteFactKind = 'money' | 'percentage' | 'seats' | 'duration';

interface ConcreteFact {
  key: string;
  kind: ConcreteFactKind;
}

function normalizedNumber(value: string) {
  return String(Number(value.replace(/,/g, '')));
}

function concreteFacts(text: string) {
  const facts = new Map<string, ConcreteFact>();
  const add = (kind: ConcreteFactKind, value: string, unit = '') => {
    const key = `${kind}:${normalizedNumber(value)}:${unit}`;
    facts.set(key, { key, kind });
  };
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(万元|元)/g)) add('money', match[1]!, match[2]!);
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) add('percentage', match[1]!, '%');
  for (const match of text.matchAll(/(\d+)\s*(?:个)?(?:销售)?席位/g)) add('seats', match[1]!, '席位');
  for (const match of text.matchAll(/(\d+)\s*(?:个)?(工作日|天)/g)) add('duration', match[1]!, match[2]!);
  return facts;
}

function isFactualSource(entry: KnowledgeEntry) {
  return ['产品资料', '价格政策', '客户案例'].includes(sourceCategory(entry));
}

function entryFacts(entry: KnowledgeEntry) {
  return concreteFacts(`${entry.title}\n${entry.category}\n${entry.content}`);
}

function selectEvidenceEntries(sourceIds: string[], knowledge: KnowledgeEntry[], reply: string) {
  const published = publishedKnowledge(knowledge);
  const publishedById = new Map(published.map((entry) => [entry.id, entry]));
  const selected = [...new Set(sourceIds)]
    .map((id) => publishedById.get(id))
    .filter((entry): entry is KnowledgeEntry => Boolean(entry));
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const facts = concreteFacts(reply);
  const isCovered = (fact: ConcreteFact) => selected.some((entry) => isFactualSource(entry) && entryFacts(entry).has(fact.key));

  for (const entry of published) {
    if (selected.length >= 12 || selectedIds.has(entry.id) || !isFactualSource(entry)) continue;
    if (![...facts.values()].some((fact) => !isCovered(fact) && entryFacts(entry).has(fact.key))) continue;
    selected.push(entry);
    selectedIds.add(entry.id);
  }

  return {
    entries: selected,
    factsGrounded: [...facts.values()].every(isCovered),
  };
}
```

- [ ] **Step 4: Use grounded entries in `applyModelAdvice`**

Replace the first five statements in `applyModelAdvice` with:

```ts
const recommendedReply = lineLimit(advice.recommendedReply);
const evidence = selectEvidenceEntries(advice.sourceIds, knowledge, recommendedReply);
const selectedSources = evidence.entries.map((entry) => ({
  id: entry.id,
  category: sourceCategory(entry),
  title: entry.title,
  version: entry.version,
  excerpt: entry.content.slice(0, 500),
  verified: true,
}));
const hasPublishedFacts = evidence.factsGrounded
  && evidence.entries.some((entry) => isFactualSource(entry));
const validationReport = validateSalesReply(recommendedReply, transcript, hasPublishedFacts);
```

Remove the old `published` map, old `selectedSources`, old `recommendedReply`, and old category-only `hasPublishedFacts` declarations.

- [ ] **Step 5: Expand local factual-claim detection**

In `server/rules/analysisEngine.ts`, replace `unsupportedFactClaim` with:

```ts
const unsupportedFactClaim = /价格|年费|折扣|优惠|客户案例|实施周期|席位|工作日|\d[\d,]*(?:\.\d+)?\s*(?:万元|元|%)|效果(?:明显|很好|提升|达到|保证)/.test(reply);
```

- [ ] **Step 6: Run the targeted tests and verify GREEN**

Run:

```powershell
node --import tsx --test --test-name-pattern="published L2 price knowledge|recovers a matching published source|does not contain every concrete fact|numeric commercial claims" server/model/salesAdvisor.test.ts server/rules/analysisEngine.test.ts
```

Expected: all matching tests pass.

- [ ] **Step 7: Run both complete test files**

Run:

```powershell
node --import tsx --test server/model/salesAdvisor.test.ts server/rules/analysisEngine.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 8: Commit deterministic grounding**

```powershell
git add -- server/model/salesAdvisor.ts server/model/salesAdvisor.test.ts server/rules/analysisEngine.ts server/rules/analysisEngine.test.ts
git commit -m "Ground sales facts in retrieved knowledge"
```

### Task 3: Full verification and handoff

**Files:**
- Verify only; no additional production files expected.

- [ ] **Step 1: Run the complete server test suite**

Run:

```powershell
npm.cmd test
```

Expected: 84 existing tests plus the new regression tests pass with zero failures.

- [ ] **Step 2: Run TypeScript typechecking**

Run:

```powershell
npm.cmd run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Check the final diff**

Run:

```powershell
git diff origin/main...HEAD --check
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected:

- no whitespace errors;
- clean working tree;
- one design commit, one source-category commit, one deterministic-grounding commit, and the implementation-plan commit.

- [ ] **Step 4: Confirm deployment requirements**

Record in the handoff:

- backend rebuild and redeploy required;
- no frontend redeploy required;
- no Qdrant rebuild or re-embedding required;
- rerun previously blocked analyses after deployment because saved results are immutable snapshots.
