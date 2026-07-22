import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { KnowledgeCandidate, KnowledgeConversationMessage, KnowledgeDocumentSection, KnowledgeImportContext, KnowledgeSourceFile } from '../../shared/contracts.js';
import type { AppConfig } from '../config.js';
import { generateJsonText, type ModelMediaInput } from '../model/generativeClient.js';
import type { KnowledgeCandidateAnalysis, KnowledgeFileAnalysis } from './contentAnalyzer.js';

const run = promisify(execFile);

export function maskSensitive(value: string) {
  return value
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '手机号***')
    .replace(/(?:微信|wx|wechat|V信)\s*[：:]?\s*[a-zA-Z][-_a-zA-Z0-9]{5,19}/gi, '微信号***')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '身份证号***');
}

export function privacyTypes(value: string) {
  const types: string[] = [];
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(value)) types.push('手机号');
  if (/(?:微信|wx|wechat|V信)\s*[：:]?\s*[a-zA-Z][-_a-zA-Z0-9]{5,19}/i.test(value)) types.push('微信号');
  if (/(?<!\d)\d{17}[\dXx](?!\d)/.test(value)) types.push('身份证号');
  return types;
}

const championSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['sales', 'customer', 'unknown']), text: z.string().max(3000), sourceIndex: z.number().int().min(0), confidence: z.number().min(0).max(1) })).max(300),
  customerStage: z.string().max(80).optional(),
  objectionType: z.string().max(80).optional(),
  summary: z.string().max(1200),
  tactics: z.array(z.object({ title: z.string().max(160), category: z.string().max(80), content: z.string().max(20_000), whyEffective: z.string().max(2000), applicableScenario: z.string().max(2000), misuseBoundary: z.string().max(2000), sourceIndexes: z.array(z.number().int().min(0)).max(20) })).max(20),
});

export async function analyzeChampionChat(files: Array<{ source: KnowledgeSourceFile; data: Buffer }>, config: AppConfig, context: KnowledgeImportContext) {
  const media: ModelMediaInput[] = files.filter((item) => item.source.mimeType.startsWith('image/')).map((item) => ({ name: item.source.name, mimeType: item.source.mimeType, data: item.data }));
  let parsed: z.infer<typeof championSchema> | undefined;
  const warnings: string[] = [];
  if (media.length && config.modelDriver === 'openai_compatible' && config.modelApiKey && config.knowledgeModelName) {
    try {
      const prompt = `按图片顺序解析一组销冠与客户聊天截图。区分销售和客户，去除重复截图中的重复消息。提炼可复用销售方法，但不得把对话里的产品、价格、效果或案例说法当成已审核事实。只返回JSON：{"messages":[{"role":"sales|customer|unknown","text":"","sourceIndex":0,"confidence":0.0}],"customerStage":"","objectionType":"","summary":"","tactics":[{"title":"","category":"开场|需求追问|异议处理|信任建立|推进成交|跟进收口|其他","content":"完整技巧","whyEffective":"","applicableScenario":"","misuseBoundary":"","sourceIndexes":[0]}]}。资料组名称：${context.sourceTitle ?? '销冠对话复盘'}。`;
      parsed = championSchema.parse(JSON.parse(await generateJsonText(config, { model: config.knowledgeModelName, prompt, media, timeoutMs: 90_000 })));
    } catch (error) {
      warnings.push(`销冠对话识别失败，已保留原图供人工补充：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }
  const originalText = parsed?.messages.map((item) => item.text).join('\n') ?? '';
  const findings = privacyTypes(originalText);
  const messages: KnowledgeConversationMessage[] = (parsed?.messages ?? []).map((item) => {
    const matchedFile = files.at(item.sourceIndex);
    return { role: item.role, text: maskSensitive(item.text), sourceFileId: matchedFile?.source.id, sequenceIndex: item.sourceIndex, confidence: item.confidence };
  });
  const now = new Date().toISOString();
  const citationsFor = (indexes: number[]) => [...new Set(indexes)].map((index) => files.at(index)).filter((item): item is { source: KnowledgeSourceFile; data: Buffer } => Boolean(item)).map(({ source }) => ({ sourceFileId: source.id, sourceFileName: source.name, location: `截图 ${Number(source.sequenceIndex ?? 0) + 1}`, excerpt: '原始聊天截图（已脱敏展示）' }));
  const allIndexes = files.map((_, index) => index);
  const transcript = messages.map((message) => `${message.role === 'sales' ? '销售' : message.role === 'customer' ? '客户' : '未知'}：${message.text}`).join('\n');
  const candidates: KnowledgeCandidate[] = [{
    id: randomUUID(), layer: 'L2', businessCategory: '销售技巧', category: '销冠对话复盘',
    title: context.sourceTitle?.trim() || `销冠对话复盘 ${new Date().toLocaleDateString('zh-CN')}`,
    summary: parsed?.summary || '销冠聊天截图已保存，识别内容需人工补充确认。',
    content: transcript || '当前只保留了原始聊天截图，自动识别未完成，请人工补充脱敏后的对话正文。', version: '1.0', confidence: parsed ? 0.86 : 0.35,
    citations: citationsFor(allIndexes), sourceFileIds: files.map((item) => item.source.id), sourceSectionIds: files.map((item) => `${item.source.id}-chat`), sectionCoverageStatus: 'pending_confirmation',
    conversationMessages: messages, privacyFindings: findings, analysisWarnings: warnings, reviewStatus: 'pending', createdAt: now, updatedAt: now,
  }];
  for (const tactic of parsed?.tactics ?? []) {
    candidates.push({
      id: randomUUID(), layer: 'L2', businessCategory: '销售技巧', category: `销冠技巧·${tactic.category}`,
      title: tactic.title, summary: tactic.content.slice(0, 220),
      content: `${tactic.content}\n\n为什么有效：${tactic.whyEffective}\n适用场景：${tactic.applicableScenario}\n不适用边界：${tactic.misuseBoundary}`,
      version: '1.0', confidence: 0.82, citations: citationsFor(tactic.sourceIndexes), sourceFileIds: tactic.sourceIndexes.map((index) => files[index]?.source.id).filter((id): id is string => Boolean(id)),
      sourceSectionIds: tactic.sourceIndexes.map((index) => `${files[index]?.source.id}-chat`).filter(Boolean), sectionCoverageStatus: 'covered', privacyFindings: findings, analysisWarnings: warnings,
      reviewStatus: 'pending', createdAt: now, updatedAt: now,
    });
  }
  const sections: KnowledgeDocumentSection[] = files.map(({ source }, index) => ({ id: `${source.id}-chat`, sourceFileId: source.id, title: `聊天截图 ${index + 1}`, headingLevel: 0, content: messages.filter((message) => message.sourceFileId === source.id).map((message) => message.text).join('\n'), location: `截图 ${index + 1}`, characterCount: messages.filter((message) => message.sourceFileId === source.id).reduce((sum, message) => sum + message.text.length, 0), coverageStatus: parsed ? 'covered' : 'pending_confirmation', candidateIds: candidates.filter((candidate) => candidate.sourceFileIds.includes(source.id)).map((candidate) => candidate.id) }));
  return { candidates, sections, transcript, messages, privacyFindings: findings, warnings };
}

const videoSchema = z.object({
  transcript: z.string().max(120_000),
  chapters: z.array(z.object({ startSeconds: z.number().min(0), endSeconds: z.number().min(0), title: z.string().max(160), summary: z.string().max(1200), content: z.string().max(20_000), category: z.string().max(80) })).max(50),
});

export async function analyzeVideoFile(file: { name: string; mimeType: string; data: Buffer }, config: AppConfig, sourceFileId: string, context?: KnowledgeImportContext): Promise<KnowledgeFileAnalysis> {
  const folder = await mkdtemp(join(tmpdir(), 'sales-media-'));
  const inputPath = join(folder, `input${extname(file.name) || '.mp4'}`);
  const audioPath = join(folder, 'audio.mp3');
  const framePattern = join(folder, 'frame-%02d.jpg');
  const warnings: string[] = [];
  try {
    await writeFile(inputPath, file.data);
    let duration = 0;
    try { const result = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath], { timeout: 30_000 }); duration = Number(result.stdout.trim()) || 0; } catch { warnings.push('未读取到视频时长'); }
    try { await run('ffmpeg', ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audioPath], { timeout: 180_000, maxBuffer: 2_000_000 }); } catch { warnings.push('视频音频提取失败'); }
    try { await run('ffmpeg', ['-y', '-i', inputPath, '-vf', 'fps=1/30,scale=640:-1', '-frames:v', '12', framePattern], { timeout: 180_000, maxBuffer: 2_000_000 }); } catch { warnings.push('视频关键画面提取失败'); }
    const media: ModelMediaInput[] = [];
    try { const audio = await readFile(audioPath); if (audio.length <= 20 * 1024 * 1024) media.push({ name: 'audio.mp3', mimeType: 'audio/mpeg', data: audio }); else warnings.push('音频过长，未发送模型，请人工补充转写'); } catch { /* captured above */ }
    const frameNames = (await readdir(folder)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    for (let index = 0; index < frameNames.length; index += 1) media.push({ name: frameNames[index]!, mimeType: 'image/jpeg', data: await readFile(join(folder, frameNames[index]!)), timestampSeconds: Math.min(duration, index * 30) });
    let parsed: z.infer<typeof videoSchema> | undefined;
    if (media.length && config.modelDriver === 'openai_compatible' && config.modelApiKey && config.knowledgeModelName) {
      try {
        const purpose = context?.purpose === 'customer_case' ? '客户案例' : context?.purpose === 'product_media' ? '产品资料' : '销售技巧';
        const prompt = `解析销售课程或业务视频的音频和按时间顺序提供的关键帧。输出完整转写和章节。候选归档方向为${purpose}；不得从画面推测没有明确出现的产品效果、价格或客户结果。只返回JSON：{"transcript":"","chapters":[{"startSeconds":0,"endSeconds":60,"title":"","summary":"","content":"完整可审核知识","category":"细分类"}]}。视频名：${file.name}，时长约${duration}秒。`;
        parsed = videoSchema.parse(JSON.parse(await generateJsonText(config, { model: config.knowledgeModelName, prompt, media, timeoutMs: 120_000 })));
      } catch (error) { warnings.push(`视频模型解析失败：${error instanceof Error ? error.message : '未知错误'}`); }
    }
    const chapters = parsed?.chapters.length ? parsed.chapters : [{ startSeconds: 0, endSeconds: duration, title: file.name, summary: '原视频已保存，自动解析未完成。', content: '请人工补充视频转写或知识摘要。', category: '待确认资料' }];
    const sections: KnowledgeDocumentSection[] = chapters.map((chapter, index) => ({ id: `${sourceFileId}-video-${index}`, sourceFileId, title: chapter.title, headingLevel: 0, content: chapter.content, location: `${Math.floor(chapter.startSeconds / 60)}:${String(Math.floor(chapter.startSeconds % 60)).padStart(2, '0')}–${Math.floor(chapter.endSeconds / 60)}:${String(Math.floor(chapter.endSeconds % 60)).padStart(2, '0')}`, characterCount: chapter.content.length, coverageStatus: parsed ? 'covered' : 'pending_confirmation', candidateIds: [] }));
    const purposeCategory = context?.purpose === 'customer_case' ? '客户案例' : context?.purpose === 'product_media' ? '产品资料' : '销售技巧';
    const candidates: KnowledgeCandidateAnalysis[] = chapters.map((chapter, index) => ({ suggestedLayer: purposeCategory === '销售技巧' ? 'L2' : 'L3', businessCategory: purposeCategory, suggestedCategory: chapter.category || (purposeCategory === '销售技巧' ? '课程与复盘' : purposeCategory), suggestedTitle: chapter.title, summary: chapter.summary, normalizedContent: chapter.content, sourceExcerpt: chapter.summary, location: sections[index]!.location, timeRange: { startSeconds: chapter.startSeconds, endSeconds: chapter.endSeconds }, confidence: parsed ? 0.8 : 0.3, warnings, sourceSectionIds: [sections[index]!.id], sectionCoverageStatus: parsed ? 'covered' : 'pending_confirmation' }));
    return { suggestedLayer: candidates[0]!.suggestedLayer, suggestedCategory: candidates[0]!.suggestedCategory, suggestedTitle: candidates[0]!.suggestedTitle, summary: candidates[0]!.summary, normalizedContent: candidates.map((item) => item.normalizedContent).join('\n\n'), transcript: parsed?.transcript, keyFrames: frameNames.map((name, index) => ({ timestampSeconds: Math.min(duration, index * 30), label: name })), confidence: parsed ? 0.8 : 0.3, extractionMethod: parsed ? 'ffmpeg-audio-keyframes+model' : 'video-preserved-needs-review', extractedTextLength: parsed?.transcript.length ?? 0, warnings, candidates, sections, coveragePercentage: 100, uncoveredSections: [] };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
