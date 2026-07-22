import { basename, extname } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';
import type {
  KnowledgeDocumentSection,
  KnowledgeImportContext,
  KnowledgeLayer,
  KnowledgeSectionCoverageStatus,
} from '../../shared/contracts.js';
import type { AppConfig } from '../config.js';
import { generateJsonText } from '../model/generativeClient.js';
import { analyzeVideoFile, maskSensitive, privacyTypes } from './mediaAnalyzer.js';

export interface KnowledgeCandidateAnalysis {
  suggestedLayer: Extract<KnowledgeLayer, 'L2' | 'L3'>;
  businessCategory: string;
  suggestedCategory: string;
  suggestedTitle: string;
  summary: string;
  normalizedContent: string;
  sourceExcerpt?: string;
  location?: string;
  confidence: number;
  warnings: string[];
  sourceSectionIds: string[];
  sectionCoverageStatus: KnowledgeSectionCoverageStatus;
  suggestedProductName?: string;
  suggestedPackageName?: string;
  timeRange?: { startSeconds: number; endSeconds: number };
  privacyFindings?: string[];
}

export interface KnowledgeFileAnalysis {
  suggestedLayer: Extract<KnowledgeLayer, 'L2' | 'L3'>;
  suggestedCategory: string;
  suggestedTitle: string;
  summary: string;
  normalizedContent: string;
  confidence: number;
  extractionMethod: string;
  extractedTextLength: number;
  warnings: string[];
  candidates: KnowledgeCandidateAnalysis[];
  sections: KnowledgeDocumentSection[];
  coveragePercentage: number;
  uncoveredSections: string[];
  transcript?: string;
  keyFrames?: Array<{ timestampSeconds: number; label: string }>;
}

interface AnalyzerOptions {
  sourceFileId?: string;
  context?: KnowledgeImportContext;
  onProgress?: (current: number, total: number, label: string) => void | Promise<void>;
}

interface ExtractedDocument {
  text: string;
  method: string;
  sections: KnowledgeDocumentSection[];
}

const textExtensions = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml', '.log', '.rtf']);
const maxCandidates = 100;
const modelBatchSize = 6;

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function cleanText(value: string) {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function xmlText(value: string) {
  return cleanText(decodeEntities(value
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<(?:w:br|a:br)[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ' ')));
}

function shortText(value: string, max = 360) {
  const text = cleanText(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sectionId(sourceFileId: string, index: number) {
  return `${sourceFileId}:section:${index + 1}`;
}

function isNonKnowledgeTitle(title: string) {
  return /^(封面|目录|目次|版权页|前言)$/i.test(title.trim());
}

function makeSection(
  sourceFileId: string,
  index: number,
  title: string,
  content: string,
  headingLevel: 0 | 1 | 2 | 3,
  parentTitle?: string,
): KnowledgeDocumentSection {
  const normalized = cleanText(content);
  return {
    id: sectionId(sourceFileId, index),
    sourceFileId,
    parentTitle,
    title: cleanText(title) || `未命名章节 ${index + 1}`,
    headingLevel,
    content: normalized,
    location: `章节 ${index + 1}`,
    characterCount: normalized.length,
    coverageStatus: isNonKnowledgeTitle(title) ? 'non_knowledge' : 'pending_confirmation',
    candidateIds: [],
  };
}

function docxSections(data: Buffer, sourceFileId: string) {
  const archive = unzipSync(new Uint8Array(data));
  const document = archive['word/document.xml'];
  if (!document) return [];
  const xml = strFromU8(document);
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  const parsed = paragraphs.map((paragraph) => {
    const text = xmlText(paragraph);
    const style = paragraph.match(/<w:pStyle[^>]*w:val="([^"]+)"/i)?.[1] ?? '';
    const level = /(?:heading|标题)\s*1$/i.test(style) ? 1
      : /(?:heading|标题)\s*2$/i.test(style) ? 2
        : /(?:heading|标题)\s*3$/i.test(style) ? 3 : 0;
    const list = /(?:list|bullet|number)/i.test(style) || /<w:numPr[\s>]/i.test(paragraph);
    return { text, level: level as 0 | 1 | 2 | 3, list };
  }).filter((item) => item.text);

  const raw: Array<{ title: string; parentTitle?: string; level: 0 | 1 | 2 | 3; lines: string[] }> = [];
  let parentTitle: string | undefined;
  let current: (typeof raw)[number] | undefined;
  let preface: string[] = [];
  const flush = () => {
    if (current) raw.push(current);
    current = undefined;
  };
  const flushPreface = () => {
    const content = cleanText(preface.join('\n'));
    if (content.length >= 30) raw.push({ title: parentTitle || '文档说明', parentTitle, level: parentTitle ? 1 : 0, lines: preface });
    preface = [];
  };

  for (const paragraph of parsed) {
    if (paragraph.level === 1) {
      flush();
      flushPreface();
      parentTitle = paragraph.text;
      continue;
    }
    if (paragraph.level === 2) {
      flush();
      flushPreface();
      current = { title: paragraph.text, parentTitle, level: 2, lines: [] };
      continue;
    }
    const line = paragraph.level === 3
      ? `### ${paragraph.text}`
      : paragraph.list ? `- ${paragraph.text}` : paragraph.text;
    if (current) current.lines.push(line);
    else preface.push(line);
  }
  flush();
  flushPreface();

  return raw
    .map((item, index) => makeSection(sourceFileId, index, item.title, item.lines.join('\n'), item.level, item.parentTitle))
    .filter((section) => section.content || section.coverageStatus === 'non_knowledge');
}

function officeText(data: Buffer, extension: string) {
  const archive = unzipSync(new Uint8Array(data));
  const entries = Object.entries(archive).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const selected = entries.filter(([name]) => extension === '.pptx'
    ? /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name)
    : /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name));
  return selected.map(([name, bytes]) => `${name}\n${xmlText(strFromU8(bytes))}`).join('\n\n').trim();
}

function semanticChunks(text: string) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const byHeadings = normalized.split(/\n(?=(?:#{1,3}\s+|\d+[.、]\s*|[一二三四五六七八九十]+、))/).map(cleanText).filter(Boolean);
  if (byHeadings.length > 1) return byHeadings;
  const paragraphs = normalized.split(/\n{2,}/).map(cleanText).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  return normalized.match(/[\s\S]{1,1800}/g)?.map(cleanText).filter(Boolean) ?? [normalized];
}

function genericSections(text: string, sourceFileId: string) {
  return semanticChunks(text).slice(0, maxCandidates).map((content, index) => {
    const title = content.match(/^(?:#{1,3}\s+)?([^\n：:]{2,80})/)?.[1] ?? `内容片段 ${index + 1}`;
    return makeSection(sourceFileId, index, title, content, 0);
  });
}

async function extractDocument(file: { name: string; mimeType: string; data: Buffer }, sourceFileId: string): Promise<ExtractedDocument> {
  const extension = extname(file.name).toLowerCase();
  if (extension === '.docx') {
    const sections = docxSections(file.data, sourceFileId);
    return { text: sections.map((section) => `${section.title}\n${section.content}`).join('\n\n'), method: 'docx-structured-xml', sections };
  }
  let text = '';
  let method = 'metadata-only';
  if (extension === '.pdf' || file.mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: new Uint8Array(file.data) });
    try { text = (await parser.getText()).text.trim(); method = 'pdf-text'; } finally { await parser.destroy(); }
  } else if (['.pptx', '.xlsx'].includes(extension)) {
    text = officeText(file.data, extension);
    method = `${extension.slice(1)}-xml`;
  } else if (textExtensions.has(extension) || /^(text\/|application\/(json|xml))/.test(file.mimeType)) {
    text = file.data.toString('utf8').replace(/\u0000/g, '').trim();
    method = 'plain-text';
  }
  let sections = genericSections(text, sourceFileId);
  if (sections.length === 0 && /^image\//.test(file.mimeType)) {
    sections = [makeSection(sourceFileId, 0, basename(file.name, extension), '', 0)];
  }
  return { text, method, sections };
}

function classifyText(text: string): Pick<KnowledgeCandidateAnalysis, 'suggestedLayer' | 'businessCategory' | 'suggestedCategory'> {
  if (/^\s*(?:销售技巧|销售策略|沟通策略|销转策略)(?:\s|[：:])/.test(text)) return { suggestedLayer: 'L2', businessCategory: '销售技巧', suggestedCategory: '销售技巧' };
  if (/价格|报价|折扣|优惠|预算|收费/.test(text)) return { suggestedLayer: 'L3', businessCategory: '产品资料', suggestedCategory: '价格与版本' };
  if (/客户案例|成功案例|案例复盘|客户故事/.test(text)) return { suggestedLayer: 'L3', businessCategory: '客户案例', suggestedCategory: '客户案例' };
  if (/竞品|对比|替代方案|友商/.test(text)) return { suggestedLayer: 'L3', businessCategory: '竞品口径', suggestedCategory: '竞品口径' };
  if (/售后|退换|退款|质量问题|服务保障/.test(text)) return { suggestedLayer: 'L3', businessCategory: '售后承诺', suggestedCategory: '售后承诺' };
  if (/禁用|红线|禁止|不得|不能承诺|合规风险/.test(text)) return { suggestedLayer: 'L3', businessCategory: '禁用红线', suggestedCategory: '禁用红线' };
  if (/销售技巧|销售策略|话术|跟进|异议|成交|邀约|沟通策略|销转/.test(text)) return { suggestedLayer: 'L2', businessCategory: '销售技巧', suggestedCategory: '销售技巧' };
  return { suggestedLayer: 'L3', businessCategory: '产品资料', suggestedCategory: '产品资料' };
}

function localCandidate(fileName: string, section: KnowledgeDocumentSection, warning?: string): KnowledgeCandidateAnalysis {
  const classified = classifyText(`${section.parentTitle ?? ''}\n${section.title}\n${section.content}`);
  const content = section.content || `来源文件：${fileName}。该章节未能自动提取正文，请人工补充。`;
  return {
    ...classified,
    suggestedTitle: section.title || basename(fileName, extname(fileName)),
    summary: shortText(content, 220),
    normalizedContent: content.slice(0, 20_000),
    sourceExcerpt: shortText(content, 220),
    location: section.location,
    confidence: warning ? 0.45 : 0.72,
    warnings: warning ? [warning] : [],
    sourceSectionIds: [section.id],
    sectionCoverageStatus: 'pending_confirmation',
  };
}

const modelCandidateSchema = z.object({
  suggestedLayer: z.enum(['L2', 'L3']),
  businessCategory: z.string().min(1).max(40),
  suggestedCategory: z.string().min(1).max(80),
  suggestedTitle: z.string().min(1).max(160),
  summary: z.string().min(1).max(1000),
  normalizedContent: z.string().min(1).max(20_000),
  sourceExcerpt: z.string().max(600).optional(),
  location: z.string().max(160).optional(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).max(10).optional(),
  sourceSectionIds: z.array(z.string()).min(1).max(12),
  suggestedProductName: z.string().max(100).optional(),
  suggestedPackageName: z.string().max(100).optional(),
});

async function classifyBatch(
  file: { name: string; mimeType: string; data: Buffer },
  sections: KnowledgeDocumentSection[],
  config: AppConfig,
  context?: KnowledgeImportContext,
) {
  const model = config.knowledgeModelName ?? config.modelName;
  if (config.modelDriver !== 'openai_compatible' || !config.modelBaseUrl || !config.modelApiKey || !model) return undefined;
  const sectionPayload = sections.map((section) => ({
    sectionId: section.id,
    parentTitle: section.parentTitle,
    title: section.title,
    content: section.content.slice(0, 7000),
  }));
  const purposeRule = context?.purpose === 'product_media' ? '本批资料用途已选为产品图片/视频，优先归入产品资料；只有画面明确出现的文字可成为产品事实，场景图不得推测效果或参数。'
    : context?.purpose === 'customer_case' ? '本批资料用途已选为客户案例，优先归入客户案例；没有证据的效果数据必须标记待确认。'
      : context?.purpose === 'sales_video' ? '本批资料用途已选为销售课程或复盘视频，优先归入销售技巧。'
        : context?.purpose === 'other' ? '本批资料用途为其他销售资料，必须依据原文内容判断归类。' : '';
  const prompt = `你是企业知识库拆条助手。逐一处理下面每个原文章节，不能挑选、概括后丢弃。每个有知识内容的章节至少返回一条候选；同一章节包含不同业务含义时可拆成多条。只能归入：产品资料、客户案例、竞品口径、售后承诺、禁用红线、销售技巧。无法判断也要生成“待确认资料”。${purposeRule}客户案例或聊天中的真实姓名改为“客户A”等代称，手机号、微信号、身份证号必须脱敏。如果内容属于具体产品，提取原文中明确出现的产品名称 suggestedProductName；如果出现套餐、版本或规格名称，再提取 suggestedPackageName，不得猜测。每条必须原样返回对应 sourceSectionIds。封面、目录等无知识内容放入 nonKnowledgeSectionIds。只返回 JSON：{"candidates":[{"suggestedLayer":"L2或L3","businessCategory":"六类之一","suggestedCategory":"细分类","suggestedTitle":"标题","summary":"摘要","normalizedContent":"完整可审核正文","sourceExcerpt":"原文引用","location":"章节标题","confidence":0.0,"warnings":[],"sourceSectionIds":["章节ID"],"suggestedProductName":"可选","suggestedPackageName":"可选"}],"nonKnowledgeSectionIds":[]}。资料组：${context?.sourceTitle ?? '未命名'}。文件名：${file.name}。章节：${JSON.stringify(sectionPayload)}`;
  const images = /^image\/(png|jpeg|jpg|webp)$/.test(file.mimeType)
    ? [{ name: file.name, mimeType: file.mimeType === 'image/jpg' ? 'image/jpeg' : file.mimeType, data: file.data }]
    : [];
  const schema = z.object({
    candidates: z.array(modelCandidateSchema).max(Math.min(30, sections.length * 4)),
    nonKnowledgeSectionIds: z.array(z.string()).max(sections.length).optional(),
  });
  return schema.parse(JSON.parse(await generateJsonText(config, { model, prompt, images, timeoutMs: 45_000 })));
}

function clampBusinessCategory(value: string) {
  return ['产品资料', '客户案例', '竞品口径', '售后承诺', '禁用红线', '销售技巧'].includes(value) ? value : '产品资料';
}

export async function analyzeKnowledgeFile(
  file: { name: string; mimeType: string; data: Buffer },
  config: AppConfig,
  options: AnalyzerOptions = {},
): Promise<KnowledgeFileAnalysis> {
  const sourceFileId = options.sourceFileId ?? 'source';
  if (file.mimeType.startsWith('video/')) return analyzeVideoFile(file, config, sourceFileId, options.context);
  const warnings: string[] = [];
  let extracted: ExtractedDocument = { text: '', method: 'metadata-only', sections: [] };
  try {
    extracted = await extractDocument(file, sourceFileId);
  } catch (error) {
    warnings.push(`本地正文提取失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
  if (extracted.sections.length === 0) {
    extracted.sections = [makeSection(sourceFileId, 0, basename(file.name, extname(file.name)), '', 0)];
  }

  if (extracted.method === 'metadata-only' && !/^image\//.test(file.mimeType)) {
    const section = extracted.sections[0]!;
    const candidate = { ...localCandidate(file.name, section, '未能从文件中可靠提取正文，请人工补充内容。'), confidence: 0.3 };
    return {
      suggestedLayer: candidate.suggestedLayer,
      suggestedCategory: candidate.suggestedCategory,
      suggestedTitle: candidate.suggestedTitle,
      summary: candidate.summary,
      normalizedContent: candidate.normalizedContent,
      confidence: 0.3,
      extractionMethod: extracted.method,
      extractedTextLength: 0,
      warnings: candidate.warnings,
      candidates: [candidate],
      sections: extracted.sections,
      coveragePercentage: 100,
      uncoveredSections: [],
    };
  }

  const candidates: KnowledgeCandidateAnalysis[] = [];
  const sections = extracted.sections.slice(0, maxCandidates);
  const relevant = sections.filter((section) => section.coverageStatus !== 'non_knowledge');
  const batches: KnowledgeDocumentSection[][] = [];
  for (let index = 0; index < relevant.length; index += modelBatchSize) batches.push(relevant.slice(index, index + modelBatchSize));

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex]!;
    await options.onProgress?.(Math.min((batchIndex + 1) * modelBatchSize, relevant.length), relevant.length, `正在解析第 ${Math.min((batchIndex + 1) * modelBatchSize, relevant.length)}/${relevant.length} 个章节`);
    const validIds = new Set(batch.map((section) => section.id));
    let modeled: Awaited<ReturnType<typeof classifyBatch>>;
    try {
      modeled = await classifyBatch(file, batch, config, options.context);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      warnings.push(`章节批次 ${batchIndex + 1} 模型解析失败，已生成待确认资料：${message}`);
      modeled = undefined;
    }
    const nonKnowledge = new Set((modeled?.nonKnowledgeSectionIds ?? []).filter((id) => validIds.has(id)));
    for (const id of nonKnowledge) {
      const section = batch.find((item) => item.id === id);
      if (section) section.coverageStatus = 'non_knowledge';
    }
    for (const candidate of modeled?.candidates ?? []) {
      const sourceSectionIds = candidate.sourceSectionIds.filter((id) => validIds.has(id) && !nonKnowledge.has(id));
      if (sourceSectionIds.length === 0 || candidates.length >= maxCandidates) continue;
      candidates.push({
        ...candidate,
        summary: maskSensitive(candidate.summary),
        normalizedContent: maskSensitive(candidate.normalizedContent),
        sourceExcerpt: candidate.sourceExcerpt ? maskSensitive(candidate.sourceExcerpt) : undefined,
        privacyFindings: privacyTypes(`${candidate.summary}\n${candidate.normalizedContent}\n${candidate.sourceExcerpt ?? ''}`),
        businessCategory: clampBusinessCategory(candidate.businessCategory),
        warnings: candidate.warnings ?? [],
        sourceSectionIds,
        sectionCoverageStatus: 'covered',
      });
      for (const id of sourceSectionIds) {
        const section = batch.find((item) => item.id === id);
        if (section) section.coverageStatus = 'covered';
      }
    }
    for (const section of batch) {
      if (section.coverageStatus === 'pending_confirmation' && candidates.length < maxCandidates) {
        const fallbackWarning = modeled
          ? '模型未返回该章节，已自动生成待确认资料。'
          : config.modelDriver === 'rule_based' ? undefined : '模型不可用，已按章节生成待确认资料。';
        candidates.push(localCandidate(file.name, section, fallbackWarning));
      }
    }
  }

  const processedChars = sections
    .filter((section) => section.coverageStatus !== 'failed')
    .reduce((total, section) => total + section.characterCount, 0);
  const totalChars = sections.reduce((total, section) => total + section.characterCount, 0);
  const coveragePercentage = totalChars === 0 ? 100 : Math.round((processedChars / totalChars) * 1000) / 10;
  const uncoveredSections = sections.filter((section) => section.coverageStatus === 'failed').map((section) => section.id);
  const first = candidates[0] ?? localCandidate(file.name, sections[0]!, '未提取到可靠正文，请人工补充。');
  if (candidates.length === 0) candidates.push(first);

  return {
    suggestedLayer: first.suggestedLayer,
    suggestedCategory: first.suggestedCategory,
    suggestedTitle: first.suggestedTitle,
    summary: first.summary,
    normalizedContent: candidates.map((candidate) => candidate.normalizedContent).join('\n\n').slice(0, 20_000),
    confidence: Math.max(...candidates.map((candidate) => candidate.confidence)),
    extractionMethod: batches.length > 0 ? `${extracted.method}+section-batches` : extracted.method,
    extractedTextLength: extracted.text.length,
    warnings,
    candidates: candidates.slice(0, maxCandidates),
    sections,
    coveragePercentage,
    uncoveredSections,
  };
}
