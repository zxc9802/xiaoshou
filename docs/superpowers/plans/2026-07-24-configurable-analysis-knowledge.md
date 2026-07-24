# Configurable Analysis Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off `ANALYSIS_KNOWLEDGE_ENABLED` switch so ChatGPT analysis can run without reading or citing the knowledge base while the knowledge base remains fully usable.

**Architecture:** Parse the switch once in `AppConfig`, expose the effective value through a read-only runtime-config endpoint, and branch only at analysis/review/UI integration points. Keep retrieval, storage, contracts, and historical fields intact; disabled mode supplies no knowledge to the model, creates no knowledge gaps, and hides knowledge-specific UI.

**Tech Stack:** TypeScript, Fastify, React, Node test runner, `tsx`, `react-dom/server`, Vite.

---

## File map

- Modify `.env.example`: document the default-off environment variable.
- Modify `server/config.ts`: parse and expose `analysisKnowledgeEnabled`.
- Create `server/config.test.ts`: prove strict boolean parsing.
- Create `server/runtimeConfig.ts`: map private server configuration to the public runtime feature contract.
- Create `server/runtimeConfig.test.ts`: prove only the safe feature flag is exposed.
- Modify `shared/contracts.ts`: add `RuntimeConfig`.
- Modify `server/index.ts`: expose `/api/v1/runtime-config` and pass the flag to `ReviewService`.
- Modify `src/services/analysisApi.ts`: fetch runtime configuration and derive knowledge-aware progress labels.
- Modify `server/model/salesAdvisor.ts`: build enabled/disabled prompts and suppress knowledge-only validation in disabled mode.
- Modify `server/model/salesAdvisor.test.ts`: cover prompt separation, empty citations, and enabled-mode compatibility.
- Modify `server/analysisService.ts`: skip repository and vector retrieval when disabled.
- Modify `server/analysisService.stability.test.ts`: prove disabled mode does not touch knowledge retrieval and enabled mode still does.
- Modify `server/reviewService.ts`: create no new knowledge gaps and report zero gaps when disabled.
- Modify `server/reviewService.test.ts`: cover disabled and enabled review behavior.
- Modify `src/App.tsx`: load the runtime flag and distribute it to analysis and review screens.
- Modify `src/components/AnalysisWorkspace.tsx`: pass the flag into the result renderer.
- Modify `src/components/SalesCoachResult.tsx`: hide knowledge sources and knowledge-specific messages when disabled.
- Modify `src/components/ReviewCenterPage.tsx`: hide knowledge-gap metrics and detail prompts when disabled.
- Create `server/analysisKnowledgeUi.test.ts`: server-render both feature states and assert the visible copy.

### Task 1: Configuration and public runtime feature state

**Files:**
- Modify: `.env.example`
- Modify: `server/config.ts`
- Create: `server/config.test.ts`
- Create: `server/runtimeConfig.ts`
- Create: `server/runtimeConfig.test.ts`
- Modify: `shared/contracts.ts`
- Modify: `server/index.ts`
- Modify: `src/services/analysisApi.ts`

- [ ] **Step 1: Write failing configuration tests**

Create `server/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';

test('analysis knowledge is disabled unless explicitly set to true', () => {
  const previous = process.env.ANALYSIS_KNOWLEDGE_ENABLED;
  try {
    delete process.env.ANALYSIS_KNOWLEDGE_ENABLED;
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'false';
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'TRUE';
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'invalid';
    assert.equal(loadConfig().analysisKnowledgeEnabled, false);
    process.env.ANALYSIS_KNOWLEDGE_ENABLED = 'true';
    assert.equal(loadConfig().analysisKnowledgeEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.ANALYSIS_KNOWLEDGE_ENABLED;
    else process.env.ANALYSIS_KNOWLEDGE_ENABLED = previous;
  }
});
```

Create `server/runtimeConfig.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from './config.js';
import { publicRuntimeConfig } from './runtimeConfig.js';

const config = {
  analysisKnowledgeEnabled: false,
  modelApiKey: 'secret',
  databaseUrl: 'postgres://secret',
} as AppConfig;

test('public runtime config exposes the analysis knowledge switch without secrets', () => {
  const result = publicRuntimeConfig(config);
  assert.deepEqual(result, { analysisKnowledgeEnabled: false });
  assert.equal('modelApiKey' in result, false);
  assert.equal('databaseUrl' in result, false);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
node --import tsx --test server/config.test.ts server/runtimeConfig.test.ts
```

Expected: FAIL because `analysisKnowledgeEnabled`, `publicRuntimeConfig`, and `RuntimeConfig` do not exist.

- [ ] **Step 3: Add the minimal configuration and runtime contract**

In `server/config.ts`, add to `AppConfig`:

```ts
analysisKnowledgeEnabled: boolean;
```

Add to `loadConfig()` next to the model settings:

```ts
analysisKnowledgeEnabled: process.env.ANALYSIS_KNOWLEDGE_ENABLED === 'true',
```

Add to `shared/contracts.ts`:

```ts
export interface RuntimeConfig {
  analysisKnowledgeEnabled: boolean;
}
```

Create `server/runtimeConfig.ts`:

```ts
import type { RuntimeConfig } from '../shared/contracts.js';
import type { AppConfig } from './config.js';

export function publicRuntimeConfig(config: AppConfig): RuntimeConfig {
  return { analysisKnowledgeEnabled: config.analysisKnowledgeEnabled };
}
```

Update the `AppConfig` literals in these test files with:

- `server/analysisService.stability.test.ts`
- `server/knowledgeIndexService.test.ts`
- `server/model/embeddings.test.ts`
- `server/knowledge/contentAnalyzer.test.ts`
- `server/knowledge/importWorkflow.test.ts`
- `server/infrastructure/qdrantVectorIndex.test.ts`
- `server/knowledge/knowledgeLifecycle.test.ts`
- `server/knowledge/retrieval.test.ts`

```ts
analysisKnowledgeEnabled: false,
```

In `server/index.ts`, import `publicRuntimeConfig` and register:

```ts
app.get('/api/v1/runtime-config', async () => publicRuntimeConfig(config));
```

In `src/services/analysisApi.ts`, import `RuntimeConfig` and add:

```ts
export const runtimeConfigApi = {
  get: () => fetch('/api/v1/runtime-config').then(parseResponse<RuntimeConfig>),
};

export function analysisSteps(analysisKnowledgeEnabled: boolean) {
  return analysisKnowledgeEnabled
    ? ['正在识别对话', '正在判断销售情境', '正在检索规则与资料', '正在生成销管建议', '正在进行事实和合规校验'] as const
    : ['正在识别对话', '正在判断销售情境', '正在生成销管建议', '正在进行安全校验'] as const;
}

export function progressIndex(job: AnalysisJob | null | undefined, analysisKnowledgeEnabled = false) {
  if (!job) return 0;
  if (analysisKnowledgeEnabled) {
    return ({ uploaded: 0, parsing: 0, needs_confirmation: 1, classifying: 1, retrieving: 2, generating: 3, validating: 4, completed: 4, blocked: 4, handoff: 4, canceled: 0, failed: 0 } as const)[job.status];
  }
  return ({ uploaded: 0, parsing: 0, needs_confirmation: 1, classifying: 1, retrieving: 2, generating: 2, validating: 3, completed: 3, blocked: 3, handoff: 3, canceled: 0, failed: 0 } as const)[job.status];
}
```

Remove the fixed `ANALYSIS_STEPS` export after its consumers move to `analysisSteps`.

Document in `.env.example` directly below the model driver:

```dotenv
# Only the exact value true lets analysis retrieve and cite the knowledge base.
ANALYSIS_KNOWLEDGE_ENABLED=false
```

- [ ] **Step 4: Run focused tests and type checking**

Run:

```powershell
node --import tsx --test server/config.test.ts server/runtimeConfig.test.ts
npm.cmd run typecheck
```

Expected: both tests PASS and type checking exits 0.

- [ ] **Step 5: Commit the configuration boundary**

```powershell
git add -- .env.example server/config.ts server/config.test.ts server/runtimeConfig.ts server/runtimeConfig.test.ts shared/contracts.ts server/index.ts src/services/analysisApi.ts server/analysisService.stability.test.ts server/knowledgeIndexService.test.ts server/model/embeddings.test.ts server/knowledge/contentAnalyzer.test.ts server/knowledge/importWorkflow.test.ts server/infrastructure/qdrantVectorIndex.test.ts server/knowledge/knowledgeLifecycle.test.ts server/knowledge/retrieval.test.ts
git commit -m "feat: add analysis knowledge feature flag"
```

### Task 2: Knowledge-free ChatGPT prompt and result behavior

**Files:**
- Modify: `server/model/salesAdvisor.ts`
- Modify: `server/model/salesAdvisor.test.ts`

- [ ] **Step 1: Write failing model-mode tests**

Extend `server/model/salesAdvisor.test.ts` imports with `buildSalesAdvicePrompt`, then add:

```ts
test('disabled analysis prompt omits knowledge content and citation instructions', () => {
  const transcript = parseConversationText('客户：课程能解决什么问题？');
  const baseline = analyzeWithRules(transcript, []);
  const source = { ...DEFAULT_KNOWLEDGE[0]!, id: 'sentinel-source', content: 'SENTINEL_KNOWLEDGE_CONTENT' };
  const prompt = buildSalesAdvicePrompt(baseline, transcript, [source], { conversation: '课程咨询', attachmentNames: [] }, false);

  assert.doesNotMatch(prompt, /SENTINEL_KNOWLEDGE_CONTENT/);
  assert.doesNotMatch(prompt, /已审核知识/);
  assert.doesNotMatch(prompt, /sourceIds/);
});

test('enabled analysis prompt retains knowledge content and citation instructions', () => {
  const transcript = parseConversationText('客户：课程能解决什么问题？');
  const baseline = analyzeWithRules(transcript, []);
  const source = { ...DEFAULT_KNOWLEDGE[0]!, id: 'sentinel-source', content: 'SENTINEL_KNOWLEDGE_CONTENT' };
  const prompt = buildSalesAdvicePrompt(baseline, transcript, [source], { conversation: '课程咨询', attachmentNames: [] }, true);

  assert.match(prompt, /SENTINEL_KNOWLEDGE_CONTENT/);
  assert.match(prompt, /已审核知识/);
  assert.match(prompt, /sourceIds/);
});

test('disabled analysis ignores model source ids and knowledge-only warnings', () => {
  const transcript = parseConversationText('客户：网上免费课程是不是都没用？');
  const baseline = analyzeWithRules(transcript, []);
  const result = applyModelAdvice(
    baseline,
    { ...advice(['missing-source']), recommendedReply: '可以先说说您最希望解决的业务问题吗？' },
    transcript,
    DEFAULT_KNOWLEDGE,
    'gpt-test',
    false,
  );

  assert.deepEqual(result.sourceReferences, []);
  assert.equal(result.warnings.some((warning) => /已审核|资料库|知识/.test(warning)), false);
  assert.equal(result.validationReport.checks.some((check) => check.name === '竞品事实' && !check.passed), false);
});
```

- [ ] **Step 2: Run the focused model tests and verify RED**

Run:

```powershell
node --import tsx --test server/model/salesAdvisor.test.ts
```

Expected: FAIL because the prompt builder is not exported and `applyModelAdvice` has no feature-mode parameter.

- [ ] **Step 3: Implement the two prompt modes**

In `server/model/salesAdvisor.ts`:

1. Change the schema so disabled-mode model output can omit citations:

```ts
sourceIds: z.array(z.string()).max(12).default([]),
```

2. Rename and export the prompt builder:

```ts
export function buildSalesAdvicePrompt(
  baseline: SalesAnalysisResult,
  transcript: ParsedConversation,
  knowledge: KnowledgeEntry[],
  request: AnalysisRequestInput,
  analysisKnowledgeEnabled: boolean,
) {
```

3. Build knowledge-only prompt fragments conditionally:

```ts
const facts = analysisKnowledgeEnabled
  ? publishedKnowledge(knowledge).map((entry) => ({
      id: entry.id,
      layer: entry.layer,
      category: entry.category,
      title: entry.title,
      version: entry.version,
      content: entry.content.slice(0, 2500),
    }))
  : [];
const knowledgeRules = analysisKnowledgeEnabled
  ? `企业事实只能来自“已审核知识”；sourceIds只能填写下方已审核知识中确实支持建议的id，没有引用则返回空数组。`
  : `不要假装掌握未提供的企业价格、优惠、案例、效果或服务承诺；需要具体企业事实时，建议销售向负责人核实。`;
const knowledgeBlock = analysisKnowledgeEnabled
  ? `\n已审核知识：\n${JSON.stringify(facts)}\n`
  : '';
const sourceField = analysisKnowledgeEnabled ? ',"sourceIds":[]' : '';
```

Interpolate `knowledgeRules`, `knowledgeBlock`, and `sourceField` into the existing prompt. Remove unconditional “已审核知识” rules, facts JSON, and `"sourceIds":[""]` from the shared prompt body. Keep all non-knowledge sales, privacy, refusal, handoff, and JSON-shape instructions unchanged.

4. Extend `applyModelAdvice`:

```ts
export function applyModelAdvice(
  baseline: SalesAnalysisResult,
  advice: ModelSalesAdvice,
  transcript: ParsedConversation,
  knowledge: KnowledgeEntry[],
  modelName: string,
  analysisKnowledgeEnabled = true,
): SalesAnalysisResult {
  const published = new Map(publishedKnowledge(analysisKnowledgeEnabled ? knowledge : []).map((entry) => [entry.id, entry]));
```

Use:

```ts
const validationReport = validateSalesReply(
  recommendedReply,
  transcript,
  !analysisKnowledgeEnabled || hasPublishedFacts,
);
```

Only append the competitor-source check and missing-reliable-facts warning when `analysisKnowledgeEnabled` is true:

```ts
if (analysisKnowledgeEnabled) {
  checks.push({
    name: '竞品事实',
    passed: !competitorClaim || selectedSources.some((source) => source.category === '竞品口径'),
    detail: competitorClaim ? '竞品比较必须引用已审核竞品口径' : '未使用无依据的竞品断言',
  });
}
const noReliableFactsWarning = analysisKnowledgeEnabled && !hasPublishedFacts
  ? ['本次AI回复未引用已审核的产品、价格或案例事实，请勿对客户作确定承诺。']
  : [];
```

5. Update `generateSalesAdvice`:

```ts
const raw = await generateJsonText(config, {
  model: config.modelName,
  prompt: buildSalesAdvicePrompt(baseline, transcript, knowledge, request, config.analysisKnowledgeEnabled),
  timeoutMs: 45_000,
});
const advice = parseModelSalesAdvice(raw, baseline);
return applyModelAdvice(baseline, advice, transcript, knowledge, config.modelName, config.analysisKnowledgeEnabled);
```

- [ ] **Step 4: Run focused and related tests**

Run:

```powershell
node --import tsx --test server/model/salesAdvisor.test.ts server/rules/analysisEngine.test.ts
```

Expected: all tests PASS; existing enabled-mode citation and competitor checks remain green.

- [ ] **Step 5: Commit the model boundary**

```powershell
git add -- server/model/salesAdvisor.ts server/model/salesAdvisor.test.ts
git commit -m "feat: generate analysis without knowledge context"
```

### Task 3: Skip retrieval and disable review knowledge gaps

**Files:**
- Modify: `server/analysisService.ts`
- Modify: `server/analysisService.stability.test.ts`
- Modify: `server/reviewService.ts`
- Modify: `server/reviewService.test.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Write failing service tests**

In `server/analysisService.stability.test.ts`, add:

```ts
class CountingRepository extends MemoryRepository {
  knowledgeReads = 0;
  override async listKnowledge(organizationId: string) {
    this.knowledgeReads += 1;
    return super.listKnowledge(organizationId);
  }
}

test('disabled analysis completes without reading the knowledge repository', async () => {
  const repository = new CountingRepository();
  const service = new AnalysisService(
    repository,
    new MemoryObjectStorage(),
    new RuleBasedConversationParser(),
    { ...config, analysisKnowledgeEnabled: false },
  );
  const created = await service.create({ conversation: '客户：价格有点高', attachmentNames: [] }, [], actor);

  assert.equal(await service.processPending(), true);
  const completed = await repository.getJob(created.id);
  assert.equal(repository.knowledgeReads, 0);
  assert.equal(completed?.status, 'completed');
  assert.deepEqual(completed?.result?.sourceReferences, []);
});

test('enabled analysis retains knowledge repository retrieval', async () => {
  const repository = new CountingRepository();
  const service = new AnalysisService(
    repository,
    new MemoryObjectStorage(),
    new RuleBasedConversationParser(),
    { ...config, analysisKnowledgeEnabled: true },
  );
  await service.create({ conversation: '客户：价格有点高', attachmentNames: [] }, [], actor);

  assert.equal(await service.processPending(), true);
  assert.equal(repository.knowledgeReads, 1);
});
```

In `server/reviewService.test.ts`, add:

```ts
test('disabled analysis creates no knowledge gap and reports zero gap metrics', async () => {
  const repository = new MemoryRepository();
  const first = job('analysis-1', '2026-07-20T10:00:00.000Z', '客户：价格有点高\n销售：我了解一下');
  first.result!.sourceReferences = [];
  await repository.createJob(first);
  await repository.addFeedback({ id: 'feedback-gap', analysisId: first.id, userId: actor.userId, outcome: 'adopted', createdAt: '2026-07-20T11:00:00.000Z' });
  const service = new ReviewService(repository, false);

  const [review] = await service.list(actor);
  assert.equal(review?.knowledgeGap, false);
  assert.equal((await service.metrics(actor)).knowledgeGapCount, 0);
});
```

- [ ] **Step 2: Run service tests and verify RED**

Run:

```powershell
node --import tsx --test server/analysisService.stability.test.ts server/reviewService.test.ts
```

Expected: FAIL because disabled analysis still calls `listKnowledge`, and `ReviewService` does not accept or honor the feature flag.

- [ ] **Step 3: Gate analysis retrieval**

In `AnalysisService.completeFromTranscript`, replace the unconditional retrieval block with:

```ts
const localClassification = analyzeWithRules(job.transcript, [], job.clarificationQuestions, job.createdBy);
let knowledge = [];
if (this.config.analysisKnowledgeEnabled) {
  await this.save(job, 'retrieving', 62, '正在按L0-L4检索规则与资料');
  const allKnowledge = await this.repository.listKnowledge(job.organizationId);
  knowledge = await retrieveKnowledge(
    allKnowledge,
    `${job.request.product ?? ''}\n${job.request.conversation}\n${job.transcript.lastMessage}\n销售情境：${localClassification.deadlockType}；异议：${localClassification.objectionType}；阶段：${localClassification.decisionStage}；目标：成交推进`,
    this.config,
    { organizationId: job.organizationId, ownerId: job.createdBy, vectorIndex: this.vectorIndex },
  );
  await pause(120);
}
await this.save(job, 'generating', 78, this.config.analysisKnowledgeEnabled ? '正在生成销管建议' : '正在使用AI生成销管建议');
```

Keep:

```ts
const baseline = analyzeWithRules(job.transcript, knowledge, job.clarificationQuestions, job.createdBy);
```

`generateSalesAdvice` already reads the feature flag from `config`, so no second branch is needed.

- [ ] **Step 4: Gate review knowledge gaps**

Change `ReviewService` construction:

```ts
constructor(
  private readonly repository: Repository,
  private readonly analysisKnowledgeEnabled = false,
) {}
```

When synchronizing a review:

```ts
knowledgeGap: this.analysisKnowledgeEnabled
  ? before.result.sourceReferences.filter((source) => source.verified).length === 0
  : current?.knowledgeGap ?? false,
```

When returning metrics:

```ts
knowledgeGapCount: this.analysisKnowledgeEnabled
  ? reviews.filter((review) => review.knowledgeGap).length
  : 0,
```

In `server/index.ts`:

```ts
const reviews = new ReviewService(repository, config.analysisKnowledgeEnabled);
```

- [ ] **Step 5: Run service tests and full server tests**

Run:

```powershell
node --import tsx --test server/analysisService.stability.test.ts server/reviewService.test.ts
npm.cmd test
```

Expected: focused tests PASS and the full Node test suite reports zero failures.

- [ ] **Step 6: Commit the service branch**

```powershell
git add -- server/analysisService.ts server/analysisService.stability.test.ts server/reviewService.ts server/reviewService.test.ts server/index.ts
git commit -m "feat: bypass knowledge retrieval for direct analysis"
```

### Task 4: Hide knowledge-only interface elements

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/AnalysisWorkspace.tsx`
- Modify: `src/components/SalesCoachResult.tsx`
- Modify: `src/components/ReviewCenterPage.tsx`
- Modify: `src/services/analysisApi.ts`
- Create: `server/analysisKnowledgeUi.test.ts`

- [ ] **Step 1: Write the failing server-rendered UI test**

Create `server/analysisKnowledgeUi.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewCenterPage } from '../src/components/ReviewCenterPage.js';
import { SalesCoachResult } from '../src/components/SalesCoachResult.js';
import { parseConversationText } from './model/conversationParser.js';
import { analyzeWithRules } from './rules/analysisEngine.js';

const result = analyzeWithRules(parseConversationText('客户：价格有点高\n销售：我了解一下'), []);

test('disabled analysis UI hides knowledge sources and gap copy', () => {
  const resultHtml = renderToStaticMarkup(createElement(SalesCoachResult as any, {
    result,
    analysisKnowledgeEnabled: false,
  }));
  const reviewHtml = renderToStaticMarkup(createElement(ReviewCenterPage as any, {
    onBack: () => undefined,
    analysisKnowledgeEnabled: false,
  }));

  assert.doesNotMatch(resultHtml, /依据来源和风险提醒|依据企业规则及已审核资料|资料库中未找到/);
  assert.doesNotMatch(reviewHtml, /知识缺口|缺少已审核依据/);
});

test('enabled analysis UI retains knowledge source and gap sections', () => {
  const resultHtml = renderToStaticMarkup(createElement(SalesCoachResult as any, {
    result,
    analysisKnowledgeEnabled: true,
  }));
  const reviewHtml = renderToStaticMarkup(createElement(ReviewCenterPage as any, {
    onBack: () => undefined,
    analysisKnowledgeEnabled: true,
  }));

  assert.match(resultHtml, /依据来源和风险提醒/);
  assert.match(reviewHtml, /知识缺口/);
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```powershell
node --import tsx --test server/analysisKnowledgeUi.test.ts
```

Expected: the disabled-mode test FAILS because current components always render knowledge copy.

- [ ] **Step 3: Load and distribute runtime configuration**

In `src/App.tsx`:

```ts
import { analysisSteps, analysisApi, customerApi, progressIndex, runtimeConfigApi } from './services/analysisApi';
```

Add state and startup loading:

```ts
const [analysisKnowledgeEnabled, setAnalysisKnowledgeEnabled] = useState(false);

useEffect(() => {
  void runtimeConfigApi.get()
    .then((runtime) => setAnalysisKnowledgeEnabled(runtime.analysisKnowledgeEnabled))
    .catch(() => setAnalysisKnowledgeEnabled(false));
}, []);
```

Derive:

```ts
const currentProgress = useMemo(
  () => progressIndex(job, analysisKnowledgeEnabled),
  [job, analysisKnowledgeEnabled],
);
const currentAnalysisSteps = useMemo(
  () => analysisSteps(analysisKnowledgeEnabled),
  [analysisKnowledgeEnabled],
);
```

Pass `analysisKnowledgeEnabled` and `currentAnalysisSteps` into `AnalysisWorkspace`, and pass `analysisKnowledgeEnabled` into `ReviewCenterPage`.

- [ ] **Step 4: Hide knowledge-specific analysis result UI**

Add `analysisKnowledgeEnabled: boolean` to `AnalysisWorkspace` props and pass it to `SalesCoachResult`.

Add an optional prop to `SalesCoachResult`:

```ts
analysisKnowledgeEnabled = false
```

Use:

```tsx
{jobStatus === 'blocked' && (
  <div className="result-risk-banner blocked">
    <strong>普通回复已被阻止</strong>
    <span>{analysisKnowledgeEnabled ? '事实或合规校验未通过，请补充已审核资料后重试。' : '安全校验未通过，请重新分析或升级人工处理。'}</span>
  </div>
)}
```

Change the detail caption:

```tsx
<span>{analysisKnowledgeEnabled ? '依据企业规则及已审核资料生成' : '依据客户对话与销售判断生成'}</span>
```

Render step 07 only when enabled:

```tsx
{analysisKnowledgeEnabled && (
  <TextFlowStep number="07" title="依据来源和风险提醒" last>
    <SourceReferenceList sources={result.sourceReferences} warnings={result.warnings} />
    <details className="validation-details">
      <summary>查看生成前校验结果</summary>
      {result.validationReport.checks.map((check) => (
        <div key={check.name}>
          <strong>{check.passed ? '✓' : '×'} {check.name}</strong>
          <span>{check.detail}</span>
        </div>
      ))}
    </details>
  </TextFlowStep>
)}
```

When disabled, make step 06 the last visible flow step.

- [ ] **Step 5: Hide knowledge-gap review UI**

Add `analysisKnowledgeEnabled = false` to `ReviewCenterPage` props.

Wrap the metric:

```tsx
{analysisKnowledgeEnabled && (
  <Metric label="知识缺口" value={metrics ? displayMetrics.knowledgeGapCount : undefined} note="缺少已审核依据的复盘" warning />
)}
```

Pass the flag to `ReviewDetail`, extend its prop type, and render the detail warning only when both conditions are true:

```tsx
{analysisKnowledgeEnabled && review.knowledgeGap && (
  <p className="review-gap">本次回复缺少可靠的已审核资料，可在资料库补充产品、价格、案例或销售依据。</p>
)}
```

- [ ] **Step 6: Run UI, type, and production-build checks**

Run:

```powershell
node --import tsx --test server/analysisKnowledgeUi.test.ts server/frontendApiUrl.test.ts
npm.cmd run typecheck
npm.cmd run build
```

Expected: both tests PASS, type checking exits 0, and Vite completes a production build.

- [ ] **Step 7: Commit the interface behavior**

```powershell
git add -- src/App.tsx src/components/AnalysisWorkspace.tsx src/components/SalesCoachResult.tsx src/components/ReviewCenterPage.tsx src/services/analysisApi.ts server/analysisKnowledgeUi.test.ts
git commit -m "feat: hide knowledge cues when analysis knowledge is off"
```

### Task 5: Full verification and scope audit

**Files:**
- Verify only; modify no production files unless a failing check identifies an in-scope defect.

- [ ] **Step 1: Run the full automated suite**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Expected: zero test failures, type checking exits 0, and the production build succeeds.

- [ ] **Step 2: Verify formatting and exact changed scope**

```powershell
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
```

Expected: no whitespace errors; only files named in this plan are changed.

- [ ] **Step 3: Audit disabled-mode knowledge coupling**

```powershell
rg -n "listKnowledge|retrieveKnowledge" server/analysisService.ts
rg -n "已审核知识|sourceIds|knowledgeBlock|analysisKnowledgeEnabled" server/model/salesAdvisor.ts
rg -n "知识缺口|依据来源和风险提醒|已审核资料" src/components
```

Expected:

- `listKnowledge` and `retrieveKnowledge` occur only inside the `analysisKnowledgeEnabled` branch.
- knowledge prompt fragments occur only in the enabled prompt branch.
- knowledge UI copy occurs only under `analysisKnowledgeEnabled` conditions.

- [ ] **Step 4: Verify both configuration modes with focused tests**

```powershell
node --import tsx --test server/config.test.ts server/runtimeConfig.test.ts server/model/salesAdvisor.test.ts server/analysisService.stability.test.ts server/reviewService.test.ts server/analysisKnowledgeUi.test.ts
```

Expected: all focused tests PASS and explicitly cover both `false` and `true`.

- [ ] **Step 5: Close verification**

If verification required no fixes, do not create an empty commit. If a check fails, return to the task that owns that file, add a regression test before its production fix, rerun that task's focused checks, and then rerun all of Task 5.
