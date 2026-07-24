import type { KnowledgeEntry } from '../../shared/contracts.js';
import type { AppConfig } from '../config.js';
import type { KnowledgeVectorIndex } from '../infrastructure/vectorIndex.js';
import { createKnowledgeEmbedding, formatRetrievalQuery } from '../model/embeddings.js';
import { isKnowledgeRetrievalEligible } from './eligibility.js';

function tokens(value: string) {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set<string>();
  for (const word of value.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/g) ?? []) result.add(word);
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

function categoryBoost(query: string, entry: KnowledgeEntry) {
  const text = `${entry.category}${entry.structuredData?.businessCategory ?? ''}`;
  if (/异议|犹豫|拒绝|成交|推进|顾虑|沉默|价格|效果|信任/.test(query) && /销售技巧/.test(text)) return 0.28;
  if (/价格|贵|预算|报价|费用/.test(query) && /价格|产品/.test(text)) return 0.35;
  if (/案例|同行|效果/.test(query) && /案例/.test(text)) return 0.35;
  if (/竞品|免费|对比/.test(query) && /竞品/.test(text)) return 0.35;
  if (/退款|售后|承诺|投诉/.test(query) && /售后|红线/.test(text)) return 0.35;
  return 0;
}

export interface RetrievalOptions {
  organizationId: string;
  ownerId: string;
  limit?: number;
  vectorIndex?: KnowledgeVectorIndex;
  now?: Date;
}

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
  const published = entries.filter((entry) =>
    entry.status === 'published'
    && !entry.deletedAt
    && effective(entry)
    && isKnowledgeRetrievalEligible(entry),
  );
  const mandatory = published.filter((entry) =>
    entry.layer === 'L0'
    || entry.layer === 'L1'
    || (entry.layer === 'L4' && entry.structuredData?.ownerId === options.ownerId),
  );
  const eligible = published.filter((entry) => entry.layer === 'L2' || entry.layer === 'L3');
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
  const ranked = eligible.map((entry) => {
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
  const tactics = ranked
    .filter((item) => item.entry.layer === 'L2' && item.score > 0)
    .slice(0, Math.min(4, limit))
    .map((item) => item.entry);
  const facts = ranked.filter((item) => item.entry.layer === 'L3' && item.score > 0).slice(0, Math.max(1, limit - tactics.length)).map((item) => item.entry);
  return [...new Map([...mandatory, ...tactics, ...facts].map((entry) => [entry.id, entry])).values()];
}
