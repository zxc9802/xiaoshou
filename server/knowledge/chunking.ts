import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { formatRetrievalDocument } from '../model/embeddings.js';
import { isKnowledgeRetrievalEligible } from './eligibility.js';

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
  const extensions = sourceNames(entry).map((name) => extname(name).toLowerCase());
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
    if (estimateTokens(sentence) > maxTokens) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let start = 0; start < sentence.length; start += maxTokens) {
        parts.push(sentence.slice(start, start + maxTokens));
      }
    } else if (current && estimateTokens(`${current}${sentence}`) > maxTokens) {
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
  const normalized = units.flatMap((unit) => estimateTokens(unit) > maxTokens ? splitLongUnit(unit, maxTokens) : [unit]);
  for (const raw of normalized) {
    if (current.length && estimateTokens([...current, raw].join('\n\n')) > targetTokens) {
      result.push(clean(current.join('\n\n')));
      const overlap = overlapUnits ? current.slice(-overlapUnits) : [];
      current = estimateTokens([...overlap, raw].join('\n\n')) <= maxTokens ? overlap : [];
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

export function buildKnowledgeChunks(organizationId: string, entry: KnowledgeEntry): KnowledgeChunk[] {
  if ((entry.layer !== 'L2' && entry.layer !== 'L3')
    || entry.status !== 'published'
    || entry.deletedAt
    || !isKnowledgeRetrievalEligible(entry)) return [];
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
    const embeddingContent = breadcrumb ? `context: ${breadcrumb}\n${part}` : part;
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
      embeddingText: formatRetrievalDocument(entry.title, embeddingContent),
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
