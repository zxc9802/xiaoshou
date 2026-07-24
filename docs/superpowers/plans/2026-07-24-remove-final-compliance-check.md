# Remove Final Compliance Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the post-generation compliance gate, blocked UI, and validation report while preserving knowledge grounding and human handoff.

**Architecture:** The active analysis pipeline will end immediately after generation: high-risk results enter `handoff`, all other results enter `completed`. Validation computation and result fields will be removed from the shared result contract, while legacy job status strings remain accepted so persisted history can still be read or retried.

**Tech Stack:** TypeScript, Node.js test runner, React, React DOM server rendering, Fastify, Vite

---

## File map

- `server/finalComplianceRemoval.test.ts`: end-to-end regression tests for the active workflow and rendered UI.
- `shared/contracts.ts`: remove the validation report type and result field; keep legacy status values.
- `server/rules/analysisEngine.ts`: remove the validator and stop attaching validation output.
- `server/model/salesAdvisor.ts`: remove model-output validation while retaining source references and warnings.
- `server/analysisService.ts`: remove the validating stage and blocked outcome from new analyses.
- `src/services/analysisApi.ts`: expose four progress steps and map legacy statuses to the final step.
- `src/App.tsx`: stop polling the removed validating stage.
- `src/components/SalesCoachResult.tsx`: remove the blocked banner and validation details.
- `src/styles.css`: remove styles used only by the deleted UI.
- Existing tests and fixtures containing `validationReport`: update them to the new result contract.

### Task 1: Add removal regression coverage

**Files:**
- Create: `server/finalComplianceRemoval.test.ts`
- Modify: `server/analysisService.stability.test.ts`

- [ ] **Step 1: Write a failing UI and contract regression test**

Create a test that imports `ANALYSIS_STEPS`, `SalesCoachResult`, `analyzeWithRules`, and `renderToStaticMarkup`. Build a real rule-based result and assert:

```ts
assert.deepEqual(ANALYSIS_STEPS, [
  '正在识别对话',
  '正在判断销售情境',
  '正在检索规则与资料',
  '正在生成销管建议',
]);
assert.equal('validationReport' in result, false);
const html = renderToStaticMarkup(
  <SalesCoachResult result={result} jobStatus="blocked" />,
);
assert.doesNotMatch(html, /普通回复已被阻止|查看生成前校验结果/);
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node --import tsx --test server/finalComplianceRemoval.test.ts
```

Expected: FAIL because the current progress list has five entries, the result contains `validationReport`, and the rendered component contains the deleted UI.

- [ ] **Step 3: Add a failing workflow regression test**

In `server/analysisService.stability.test.ts`, use a small `MemoryRepository` subclass that records every status passed to `updateJob`. Create an external-worker rule-based analysis with a complete two-sided conversation, call `processPending()`, and assert:

```ts
assert.equal((await repository.getJob(created.id))?.status, 'completed');
assert.equal(repository.updatedStatuses.includes('validating'), false);
assert.equal(repository.updatedStatuses.includes('blocked'), false);
```

- [ ] **Step 4: Run the workflow test and verify RED**

Run:

```powershell
node --import tsx --test server/analysisService.stability.test.ts
```

Expected: FAIL because the current service records `validating` before completion.

### Task 2: Remove validation from generated results

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `server/rules/analysisEngine.ts`
- Modify: `server/model/salesAdvisor.ts`
- Modify: `server/rules/analysisEngine.test.ts`
- Modify: `server/model/salesAdvisor.test.ts`
- Modify: `server/customerProfiles.test.ts`

- [ ] **Step 1: Remove the shared validation contract**

Delete `ValidationReport` and remove this field from `SalesAnalysisResult`:

```ts
validationReport: ValidationReport;
```

Keep `validating` and `blocked` in `AnalysisJobStatus` only for persisted-history compatibility.

- [ ] **Step 2: Remove rule-engine validation**

Delete `validateSalesReply`, remove its `ValidationReport` import, remove the local `validationReport` calculation, and omit it from the returned result. Keep the existing missing-knowledge fallback:

```ts
if (!hasPublishedFacts && /价格|折扣|优惠|案例|效果|实施周期/.test(recommendedReply)) {
  recommendedReply = '这个问题需要以已审核资料为准。我先为您核实【待补充：对应产品或价格依据】，确认后给您准确回复，可以吗？';
}
```

- [ ] **Step 3: Remove model-output validation**

Delete the `validateSalesReply` import and all post-generation `checks`, acknowledgement regex, competitor assertion, and `finalValidation`. Preserve `selectedSources`, `recommendedReply`, `noReliableFactsWarning`, human-handoff fields inherited from the baseline, and source-reference assignment.

- [ ] **Step 4: Update focused unit tests**

Remove assertions about `validationReport` and delete the validator-specific tests. Replace the unknown-source test with:

```ts
assert.equal(result.sourceReferences.length, 0);
assert.equal(result.warnings.some((warning) => warning.includes('未引用已审核')), true);
assert.equal('validationReport' in result, false);
```

Keep classification, missing-knowledge fallback, source filtering, and human-handoff tests.

- [ ] **Step 5: Run focused model and rule tests**

Run:

```powershell
node --import tsx --test server/rules/analysisEngine.test.ts server/model/salesAdvisor.test.ts server/customerProfiles.test.ts
```

Expected: PASS.

### Task 3: Remove the active validation stage and UI

**Files:**
- Modify: `server/analysisService.ts`
- Modify: `src/services/analysisApi.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/SalesCoachResult.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Finish analyses directly after generation**

Replace the post-generation branch with:

```ts
job.result = result;
job.error = undefined;
const finalStatus = result.handoffRequired ? 'handoff' : 'completed';
await this.save(
  job,
  finalStatus,
  100,
  finalStatus === 'handoff' ? '建议升级人工处理' : '分析完成',
);
```

Do not write `validating` or new `blocked` statuses. Keep legacy recovery and retry support for stored records.

- [ ] **Step 2: Reduce frontend progress to four steps**

Set:

```ts
export const ANALYSIS_STEPS = [
  '正在识别对话',
  '正在判断销售情境',
  '正在检索规则与资料',
  '正在生成销管建议',
] as const;
```

Remove `validating` from `App.tsx` active polling. Map legacy `validating`, `blocked`, and all terminal statuses to progress index `3`.

- [ ] **Step 3: Remove deleted result UI**

Delete the `blocked` banner and remove the `<details className="validation-details">` block. Keep source references, warnings, and the handoff banner.

- [ ] **Step 4: Remove orphaned styles**

Delete `.result-risk-banner.blocked` and the `.validation-details` style rules. Keep the shared risk-banner and `.high` styles required by human handoff.

- [ ] **Step 5: Run regression tests and verify GREEN**

Run:

```powershell
node --import tsx --test server/finalComplianceRemoval.test.ts server/analysisService.stability.test.ts
```

Expected: PASS.

### Task 4: Verify the complete project

**Files:**
- Modify only files that fail because they still construct the old result contract.

- [ ] **Step 1: Search for active feature remnants**

Run:

```powershell
rg -n -S "validateSalesReply|validationReport|普通回复已被阻止|查看生成前校验结果|正在进行事实和合规校验" server src shared
```

Expected: no matches outside historical design/plan documentation.

- [ ] **Step 2: Run all server tests**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

- [ ] **Step 3: Run type checking**

Run:

```powershell
npm.cmd run typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Build the application**

Run:

```powershell
npm.cmd run build
```

Expected: exit code 0 and a generated Vite production bundle.

- [ ] **Step 5: Review the scoped diff**

Run:

```powershell
git diff --check
git status --short
git diff -- server/analysisService.ts server/model/salesAdvisor.ts server/rules/analysisEngine.ts shared/contracts.ts src/App.tsx src/services/analysisApi.ts src/components/SalesCoachResult.tsx src/styles.css server/finalComplianceRemoval.test.ts server/analysisService.stability.test.ts
```

Expected: every changed line maps to removal of the final compliance check; pre-existing unrelated modifications remain unstaged and untouched.
