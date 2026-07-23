# Fact Evidence Validation Design

## Problem

The sales-advice pipeline can retrieve and cite a published price document, yet still mark the reply as `blocked`. The current source mapping treats every L1/L2 entry as `销售技巧` before checking whether its category or title represents price or product facts. `hasPublishedFacts` then rejects the cited source even when it contains the exact price, seat count, and delivery period used by the reply.

The observed production case cited `星河AI销转助手版本价格与交付标准`, but the source was mapped to `销售技巧`, so the `事实依据` check failed.

## Goals

- Recognize published price, product, and customer-case sources by business meaning before using the knowledge layer as a fallback.
- Verify concrete factual claims against the contents of published sources returned by the current retrieval request.
- Recover safely when the model omits a supporting `sourceId`, but only from published entries already present in the current retrieval result.
- Keep unsupported or hallucinated concrete claims blocked.
- Preserve the existing API contract, Qdrant collection, embeddings, and stored knowledge.

## Non-goals

- Rebuild or migrate Qdrant data.
- Reclassify every stored knowledge entry.
- Add a second LLM call for fact checking.
- Change the frontend or the analysis workflow.
- Treat a broad sales technique as sufficient evidence for a concrete price or delivery claim.

## Approaches Considered

### 1. Reorder `sourceCategory` only

Move price and product checks before the L1/L2 fallback. This fixes the observed false positive with the smallest diff, but it still depends completely on model-provided `sourceIds`. A correct retrieval result can still be blocked if the model omits an ID, and a cited source can be accepted without confirming that it contains the numbers used in the reply.

### 2. Deterministic grounding over retrieved published sources

First classify sources by business meaning, then extract concrete fact tokens from the reply and verify that the cited or automatically recovered sources contain those tokens. Automatic recovery searches only the published knowledge entries already returned by the current retrieval call. This fixes the current defect and prevents unsupported numeric claims from passing.

This is the recommended approach because it is deterministic, inexpensive, testable, and does not expand retrieval scope.

### 3. Additional LLM fact-checking call

Ask another model to judge whether the reply is entailed by the sources. This can handle paraphrases, but adds latency, cost, nondeterminism, and another failure mode. It is unnecessary for the current price, seat-count, percentage, and delivery-period claims.

## Design

### Source classification

`sourceCategory` will use semantic priority:

1. Explicit business categories for competitor claims, after-sales commitments, prohibited language, customer cases, and product facts.
2. Price/package keywords in the entry category or title.
3. Customer-case keywords.
4. Product-fact semantics.
5. L0/L1/L2 layer fallbacks for rules and sales techniques.
6. L3 fallback for product facts.

An L2 entry is therefore not automatically a sales technique when its title, category, or structured business category clearly describes price or product facts.

### Concrete fact extraction

The server will extract normalized concrete tokens from the recommended reply for:

- currency amounts;
- percentages;
- seat counts;
- working-day or day-based delivery periods.

Normalization removes separators and insignificant whitespace so `29,800 元` matches `29800` in a source. The extractor remains deliberately narrow; it does not attempt general natural-language entailment.

### Evidence selection

The server starts with valid model-provided `sourceIds` that point to published entries in the current retrieval result.

When the reply contains concrete tokens, the server may add published entries from that same retrieval result when their content covers one or more missing tokens. It will not query the global knowledge set, accept unpublished entries, or invent a source ID. The final source set remains deduplicated and capped at the existing source limit.

Concrete factual validation passes only when every extracted token is covered by the final source set and at least one source has a factual category (`产品资料`, `价格政策`, or `客户案例`). If a factual reply has no concrete token, the existing factual-category gate remains in effect.

### Failure behavior

- A hallucinated amount, seat count, percentage, or delivery period that is absent from the retrieved published sources remains blocked.
- An unrelated L2 sales technique does not become a factual source merely because of its layer.
- Existing competitor, privacy, redline, length, and sales-strategy checks remain unchanged.
- The UI continues to show the existing blocked banner and validation details when evidence is insufficient.

## Testing

Regression tests will cover:

1. A cited published L2 price document is classified as `价格政策` and permits a reply whose concrete facts are present in the document.
2. A model response that omits `sourceIds` is grounded automatically when the current retrieved published source contains every concrete fact.
3. A reply containing a concrete value absent from all retrieved published sources remains blocked.
4. A generic L2 sales technique is still classified as `销售技巧` and cannot support a price claim.

The targeted sales-advisor tests, complete server test suite, and TypeScript typecheck must pass before integration.

## Deployment

Only the backend needs to be rebuilt and redeployed. Existing Qdrant vectors and knowledge records remain valid. Existing blocked analyses retain their saved result; users must rerun the analysis to receive the corrected validation outcome.
