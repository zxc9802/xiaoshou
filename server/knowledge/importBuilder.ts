import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { KnowledgeBusinessCategory, KnowledgeCandidate, KnowledgeSourceFile } from '../../shared/contracts.js';
import type { KnowledgeCandidateAnalysis, KnowledgeFileAnalysis } from './contentAnalyzer.js';

export const BUSINESS_CATEGORIES: KnowledgeBusinessCategory[] = ['产品资料', '客户案例', '竞品口径', '售后承诺', '禁用红线', '销售技巧'];

const categoryRules: Array<{ businessCategory: KnowledgeBusinessCategory; category: string; layer: 'L2' | 'L3'; pattern: RegExp }> = [
  { businessCategory: '产品资料', category: '价格与版本', layer: 'L3', pattern: /价格|报价|费用|收费|折扣|优惠|预算|客单价|采购价|续费/ },
  { businessCategory: '禁用红线' as KnowledgeBusinessCategory, category: '企业红线', layer: 'L3', pattern: /红线|禁用|不得|不能承诺|禁止|合规|虚假|夸大|保本|绝对|百分百|100%/ },
  { businessCategory: '客户案例' as KnowledgeBusinessCategory, category: '客户案例', layer: 'L3', pattern: /案例|客户故事|成功实践|标杆客户|复购|转介绍|落地效果/ },
  { businessCategory: '竞品口径' as KnowledgeBusinessCategory, category: '竞品口径', layer: 'L3', pattern: /竞品|对比|替代|友商|同行|差异|优势|劣势/ },
  { businessCategory: '产品资料', category: '实施交付', layer: 'L3', pattern: /实施|交付|上线|部署|培训|迁移|周期|验收|项目经理/ },
  { businessCategory: '售后承诺' as KnowledgeBusinessCategory, category: '售后承诺', layer: 'L3', pattern: /售后|服务保障|退款|退货|赔付|响应时间|SLA|支持|客服|维护/ },
  { businessCategory: '销售技巧', category: '销售技巧', layer: 'L2', pattern: /异议|话术|跟进|沉默|僵局|推进|成交|逼单|邀约|复盘|需求确认|二选一|沟通策略|销售策略|销售技巧/ },
  { businessCategory: '产品资料' as KnowledgeBusinessCategory, category: '产品资料', layer: 'L3', pattern: /产品|功能|参数|版本|模块|能力|卖点|方案|适用|行业/ },
];

function cleanText(value: string) {
  return value.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function shortText(value: string, max = 220) {
  const text = cleanText(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sourceBaseName(name: string) {
  return basename(name, extname(name)).trim() || name;
}

function normalizeBusinessCategory(value: string): KnowledgeBusinessCategory {
  const matched = BUSINESS_CATEGORIES.find((item) => String(item) === value);
  if (value === '价格政策' || value === '实施交付' || value === '其他资料') return '产品资料';
  if (value === '销售策略') return '销售技巧';
  return matched ?? '产品资料';
}

function chunkByMarkers(text: string) {
  const marker = /(?:^|\n)((?:ppt\/slides\/slide\d+|ppt\/notesSlides\/notesSlide\d+|word\/(?:document|header\d+|footer\d+)|xl\/(?:sharedStrings|worksheets\/sheet\d+))\.xml)\s*/g;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) return undefined;
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1];
    const end = next?.index ?? text.length;
    return { location: match[1], text: cleanText(text.slice(start, end)) };
  }).filter((chunk) => chunk.text.length > 0);
}

function chunkPlainText(text: string): Array<{ location?: string; text: string }> {
  const prepared = cleanText(text)
    .replace(/([。；;])\s*((?:\d+|[一二三四五六七八九十]+)[、.．])/g, '$1\n$2')
    .replace(/([。；;])\s*((?:产品资料|价格政策|客户案例|竞品口径|实施交付|售后承诺|禁用红线|销售策略|销售技巧|企业红线)[:：])/g, '$1\n$2');
  const parts = prepared.split(/\n{2,}|(?=\n?\s*(?:\d+|[一二三四五六七八九十]+)[、.．])|(?=\n?\s*(?:产品资料|价格政策|客户案例|竞品口径|实施交付|售后承诺|禁用红线|销售策略|销售技巧|企业红线)[:：])/).map((part) => cleanText(part)).filter(Boolean);
  if (parts.length > 1) return parts.map((part, index) => ({ location: `分段 ${index + 1}`, text: part }));
  if (prepared.length > 2200) return prepared.match(/[\s\S]{1,1800}/g)?.map((part, index) => ({ location: `分段 ${index + 1}`, text: cleanText(part) })) ?? [{ text: prepared }];
  return [{ text: prepared }];
}

function classifyChunk(text: string, fallbackLayer: 'L2' | 'L3', fallbackCategory: string) {
  if (/^\s*(?:\d+|[一二三四五六七八九十]+)?[、.．]?\s*产品(?:资料|卖点)?[:：]/.test(text)) return { businessCategory: '产品资料' as KnowledgeBusinessCategory, category: '产品资料', layer: 'L3' as const, pattern: /(?:)/ };
  if (/^\s*(?:\d+|[一二三四五六七八九十]+)?[、.．]?\s*价格政策[:：]/.test(text)) return { businessCategory: '产品资料' as KnowledgeBusinessCategory, category: '价格与版本', layer: 'L3' as const, pattern: /(?:)/ };
  if (/^\s*(?:\d+|[一二三四五六七八九十]+)?[、.．]?\s*客户案例[:：]/.test(text)) return { businessCategory: '客户案例' as KnowledgeBusinessCategory, category: '客户案例', layer: 'L3' as const, pattern: /(?:)/ };
  if (/^\s*(?:\d+|[一二三四五六七八九十]+)?[、.．]?\s*(?:禁用红线|企业红线)[:：]/.test(text)) return { businessCategory: '禁用红线' as KnowledgeBusinessCategory, category: '企业红线', layer: 'L3' as const, pattern: /(?:)/ };
  if (/^\s*(?:\d+|[一二三四五六七八九十]+)?[、.．]?\s*(?:销售策略|销售技巧)[:：]/.test(text)) return { businessCategory: '销售技巧' as KnowledgeBusinessCategory, category: '销售技巧', layer: 'L2' as const, pattern: /(?:)/ };
  const matched = categoryRules.find((rule) => rule.pattern.test(text));
  if (matched) return matched;
  const fallbackBusinessCategory = fallbackLayer === 'L2' ? '销售技巧' : BUSINESS_CATEGORIES.includes(fallbackCategory as KnowledgeBusinessCategory) ? fallbackCategory : '产品资料';
  return { businessCategory: fallbackBusinessCategory as KnowledgeBusinessCategory, category: fallbackCategory || fallbackBusinessCategory, layer: fallbackLayer, pattern: /(?:)/ };
}

function candidateFromAnalysis(sourceFile: KnowledgeSourceFile, analysis: KnowledgeFileAnalysis, candidate: KnowledgeCandidateAnalysis, index: number): KnowledgeCandidate {
  const now = new Date().toISOString();
  const content = cleanText(candidate.normalizedContent || candidate.summary);
  const businessCategory = normalizeBusinessCategory(candidate.businessCategory);
  const title = candidate.suggestedTitle.trim() || `${String(businessCategory)}：${sourceBaseName(sourceFile.name)}${index ? ` (${index + 1})` : ''}`;
  return {
    id: randomUUID(),
    layer: candidate.suggestedLayer,
    businessCategory,
    category: candidate.suggestedCategory || String(businessCategory),
    title,
    summary: shortText(candidate.summary || content),
    content,
    version: '1.0',
    confidence: Math.max(0.25, Math.min(0.95, candidate.confidence || analysis.confidence)),
    citations: [{
      sourceFileId: sourceFile.id,
      sourceFileName: sourceFile.name,
      location: candidate.location,
      excerpt: shortText(candidate.sourceExcerpt || content || analysis.summary, 180),
    }],
    sourceFileIds: [sourceFile.id],
    sourceSectionIds: candidate.sourceSectionIds,
    sectionCoverageStatus: candidate.sectionCoverageStatus,
    timeRange: candidate.timeRange,
    analysisWarnings: candidate.warnings,
    privacyFindings: candidate.privacyFindings,
    suggestedProductName: candidate.suggestedProductName,
    suggestedPackageName: candidate.suggestedPackageName,
    reviewStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  };
}

export function buildKnowledgeCandidates(sourceFile: KnowledgeSourceFile, analysis: KnowledgeFileAnalysis): KnowledgeCandidate[] {
  if (analysis.candidates?.length) {
    return analysis.candidates.slice(0, 100).map((candidate, index) => candidateFromAnalysis(sourceFile, analysis, candidate, index));
  }

  const now = new Date().toISOString();
  const text = cleanText(analysis.normalizedContent || analysis.summary);
  const chunks = (chunkByMarkers(text) ?? chunkPlainText(text)).slice(0, 100);

  return (chunks.length ? chunks : [{ text: analysis.summary, location: undefined }]).map((chunk, index) => {
    const classified = classifyChunk(chunk.text, analysis.suggestedLayer, analysis.suggestedCategory);
    const content = cleanText(chunk.text || analysis.summary);
    const businessCategory = classified.businessCategory;
    return {
      id: randomUUID(),
      layer: classified.layer,
      businessCategory,
      category: classified.category,
      title: `${String(businessCategory)}：${sourceBaseName(sourceFile.name)}${chunks.length > 1 ? ` (${index + 1})` : ''}`,
      summary: shortText(content),
      content,
      version: '1.0',
      confidence: Math.max(0.25, Math.min(0.95, analysis.confidence)),
      citations: [{ sourceFileId: sourceFile.id, sourceFileName: sourceFile.name, location: chunk.location, excerpt: shortText(content, 180) }],
      sourceFileIds: [sourceFile.id],
      reviewStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function splitCandidate(candidate: KnowledgeCandidate): KnowledgeCandidate[] {
  const now = new Date().toISOString();
  const parts = cleanText(candidate.content).split(/\n{2,}/).filter(Boolean);
  const midpoint = Math.max(1, Math.ceil(parts.length / 2));
  const first = parts.length > 1 ? parts.slice(0, midpoint).join('\n\n') : candidate.content.slice(0, Math.ceil(candidate.content.length / 2));
  const second = parts.length > 1 ? parts.slice(midpoint).join('\n\n') : candidate.content.slice(Math.ceil(candidate.content.length / 2));
  return [first, second].filter((content) => content.trim()).map((content, index) => ({
    ...candidate,
    id: randomUUID(),
    title: `${candidate.title} ${index + 1}`,
    summary: shortText(content),
    content: cleanText(content),
    confidence: Math.max(0.25, candidate.confidence - 0.05),
    reviewStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  }));
}

export function mergeCandidates(target: KnowledgeCandidate, source: KnowledgeCandidate): KnowledgeCandidate {
  const now = new Date().toISOString();
  const content = cleanText(`${target.content}\n\n${source.content}`);
  return {
    ...target,
    summary: shortText(content),
    content,
    confidence: Math.min(target.confidence, source.confidence),
    citations: [...target.citations, ...source.citations],
    sourceFileIds: [...new Set([...target.sourceFileIds, ...source.sourceFileIds])],
    sourceSectionIds: [...new Set([...(target.sourceSectionIds ?? []), ...(source.sourceSectionIds ?? [])])],
    sectionCoverageStatus: target.sectionCoverageStatus === 'pending_confirmation' || source.sectionCoverageStatus === 'pending_confirmation'
      ? 'pending_confirmation'
      : target.sectionCoverageStatus ?? source.sectionCoverageStatus,
    updatedAt: now,
  };
}
