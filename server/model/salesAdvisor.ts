import { z } from 'zod';
import type { AnalysisRequestInput, KnowledgeEntry, ParsedConversation, SalesAnalysisResult, SourceReference } from '../../shared/contracts.js';
import type { AppConfig } from '../config.js';
import { validateSalesReply } from '../rules/analysisEngine.js';
import { generateJsonText } from './generativeClient.js';

const percentageSchema = z.preprocess((value) => typeof value === 'number' && value >= 0 && value <= 1 ? value * 100 : value, z.number().min(0).max(100));
const stageSchema = z.preprocess((value) => ({ aware: '初步了解', comparing: '有兴趣在比较', hesitating: '犹豫权衡', closing: '接近成交', lost_risk: '流失边缘' } as Record<string, string>)[String(value)] ?? value, z.enum(['初步了解', '有兴趣在比较', '犹豫权衡', '接近成交', '流失边缘']));

const adviceSchema = z.object({
  situationAnalysis: z.string().min(1).max(800),
  salesStrategy: z.object({
    name: z.string().min(1).max(100),
    reason: z.string().min(1).max(400),
    conversionGoal: z.string().min(1).max(300),
    techniques: z.array(z.string().min(1).max(100)).min(1).max(5),
  }),
  followupAction: z.string().min(1).max(500),
  stage: stageSchema,
  stageEvidence: z.string().min(1).max(800),
  stageConfidence: percentageSchema,
  explicitNeeds: z.array(z.string().min(1).max(300)).min(1).max(5),
  implicitNeedHypotheses: z.array(z.object({
    statement: z.string().min(1).max(400),
    confidence: percentageSchema,
    evidence: z.string().min(1).max(500),
    validationQuestion: z.string().min(1).max(300),
  })).min(1).max(3),
  salesLoopIssue: z.object({
    type: z.string().min(1).max(100),
    problem: z.string().min(1).max(500),
    reason: z.string().min(1).max(500),
  }),
  replyGoal: z.string().min(1).max(300),
  recommendedReply: z.string().min(1).max(1200),
  alternativeReplies: z.array(z.object({
    tone: z.enum(['简洁', '柔和', '更有推进感']),
    content: z.string().min(1).max(1200),
  })).length(3),
  nextBranches: z.array(z.object({
    customerReply: z.string().min(1).max(400),
    nextAction: z.string().min(1).max(400),
    suggestedLine: z.string().max(500).optional(),
  })).min(1).max(4),
  sourceIds: z.array(z.string()).max(12),
});

export type ModelSalesAdvice = z.infer<typeof adviceSchema>;

function nonEmptyModelText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function parseModelSalesAdvice(raw: string, baseline: SalesAnalysisResult): ModelSalesAdvice {
  const decoded = JSON.parse(raw) as Record<string, unknown>;
  const loopIssue = decoded.salesLoopIssue && typeof decoded.salesLoopIssue === 'object'
    ? decoded.salesLoopIssue as Record<string, unknown>
    : {};
  return adviceSchema.parse({
    ...decoded,
    salesLoopIssue: {
      ...loopIssue,
      type: nonEmptyModelText(loopIssue.type, baseline.salesLoopIssue.type),
      problem: nonEmptyModelText(loopIssue.problem, baseline.salesLoopIssue.problem),
      reason: nonEmptyModelText(loopIssue.reason, baseline.salesLoopIssue.reason),
    },
  });
}

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

function publishedKnowledge(entries: KnowledgeEntry[]) {
  return entries
    .filter((entry) => entry.status === 'published' && ['L0', 'L1', 'L2', 'L3'].includes(entry.layer))
    .slice(0, 40);
}

function transcriptText(transcript: ParsedConversation) {
  return transcript.messages.map((message) => `${message.role === 'customer' ? '客户' : message.role === 'sales' ? '销售' : '待确认'}：${message.text}`).join('\n');
}

function lineLimit(value: string) {
  return value.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 4).join('\n');
}

function buildPrompt(baseline: SalesAnalysisResult, transcript: ParsedConversation, knowledge: KnowledgeEntry[], request: AnalysisRequestInput) {
  const facts = publishedKnowledge(knowledge).map((entry) => ({ id: entry.id, layer: entry.layer, category: entry.category, title: entry.title, version: entry.version, content: entry.content.slice(0, 2500) }));
  return `你是以合规成交为目标的企业AI销管教练，不是被动客服。请基于完整客户对话、规则判断和已审核知识，帮助销售恢复信任、化解异议并推进一个客户愿意接受的下一步。你不能自动发送消息。所有必填字符串字段都必须填写有意义的内容，不得返回空字符串。

必须遵守：
1. 企业事实只能来自“已审核知识”；没有依据时明确说需要核实，使用【待补充：具体事项】，不得编造价格、优惠、课程内容、效果、案例或服务承诺。
2. 推荐回复不超过4行，一次只推进一个主要目标，必须包含提问、二选一或明确时间约定。
3. 深层需求只能作为假设，必须给出置信度、依据和验证问题。
4. 客户连续明确拒绝至少2次时，只允许得体收尾，不再推课；投诉、退款、合同争议或大额承诺时，只允许缓冲并升级人工。
5. 不攻击竞品，不制造稀缺，不保证效果，不复述隐私信息。没有竞品口径来源时，不得断言免费课程、其他机构或其他产品“通常、多为、都是、只能、不能”等特征；应改为询问客户已经看过什么以及最关心什么。
6. sourceIds只能填写下方已审核知识中确实支持本次建议的id；没有引用则返回空数组。
7. 不得承诺发送、提供或展示资料库中不存在的案例、方案、报告、清单或其他材料；避免使用“确保落地、保证落地、一定有效”等结果承诺。
8. 每轮必须先选择一个主要销售策略，并说明选择原因。除连续明确拒绝或高风险场景外，推荐回复按“承接真实顾虑→直接回应问题→基于已审核事实重构价值→降低决策压力→推进一个低门槛动作”组织，但表达要自然，不能像话术模板。
9. 以成交为长期目标，但本轮只推进一个微承诺，例如说出真实顾虑、确认使用场景、查看一项证据、接受演示或约定复聊时间；不得一上来逼付款或反复询问客户已经回答过的问题。
10. 对价格、效果、信任异议，先回应客户“怕不值、怕无效、怕踩坑”的决策风险，再介绍事实；可以使用反向筛选和“先不急着买”降低防备，但不能虚构试用、退款或保障政策。

关联产品：${request.product ?? '未指定'}
补充背景：${request.customerBackground ?? '无'}
本地安全分类：${JSON.stringify({ deadlockType: baseline.deadlockType, intentTemperature: baseline.intentTemperature, decisionStage: baseline.decisionStage, objectionType: baseline.objectionType, riskLevel: baseline.riskLevel, handoffRequired: baseline.handoffRequired })}
完整对话：
${transcriptText(transcript)}

已审核知识：
${JSON.stringify(facts)}

stage只能填写：初步了解、有兴趣在比较、犹豫权衡、接近成交、流失边缘。置信度统一填写0到100的整数。
只返回JSON：{"situationAnalysis":"","salesStrategy":{"name":"主要策略名称","reason":"为什么适合当前客户","conversionGoal":"本轮要推动的一个微承诺","techniques":["承接顾虑","价值重构"]},"followupAction":"","stage":"初步了解","stageEvidence":"","stageConfidence":80,"explicitNeeds":[""],"implicitNeedHypotheses":[{"statement":"假设：...","confidence":70,"evidence":"","validationQuestion":""}],"salesLoopIssue":{"type":"","problem":"","reason":""},"replyGoal":"","recommendedReply":"最多4行","alternativeReplies":[{"tone":"简洁","content":""},{"tone":"柔和","content":""},{"tone":"更有推进感","content":""}],"nextBranches":[{"customerReply":"","nextAction":"","suggestedLine":""}],"sourceIds":[""]}`;
}

export function applyModelAdvice(baseline: SalesAnalysisResult, advice: ModelSalesAdvice, transcript: ParsedConversation, knowledge: KnowledgeEntry[], modelName: string): SalesAnalysisResult {
  const published = new Map(publishedKnowledge(knowledge).map((entry) => [entry.id, entry]));
  const selectedSources = [...new Set(advice.sourceIds)].map((id) => published.get(id)).filter((entry): entry is KnowledgeEntry => Boolean(entry)).map((entry) => ({ id: entry.id, category: sourceCategory(entry), title: entry.title, version: entry.version, excerpt: entry.content.slice(0, 500), verified: true }));
  const recommendedReply = lineLimit(advice.recommendedReply);
  const hasPublishedFacts = selectedSources.some((source) => source.category === '产品资料' || source.category === '价格政策' || source.category === '客户案例');
  const validationReport = validateSalesReply(recommendedReply, transcript, hasPublishedFacts);
  const checks = [...validationReport.checks];
  const needsConversionTechnique = !baseline.handoffRequired && baseline.decisionStage !== 'lost_risk';
  const concernAcknowledged = /理解|确实|您担心|您顾虑|怕|先不急|您说得对|这个问题很关键/.test(recommendedReply);
  if (needsConversionTechnique) checks.push({ name: '销售承接', passed: concernAcknowledged, detail: concernAcknowledged ? '先承接客户真实顾虑，再推进下一步' : '回复没有先承接客户的决策顾虑' });
  if (needsConversionTechnique) checks.push({ name: '策略运用', passed: advice.salesStrategy.techniques.length > 0, detail: `本轮采用：${advice.salesStrategy.techniques.join('、')}` });
  if (baseline.handoffRequired) checks.push({ name: '人工升级', passed: /人工|负责人|升级|记录|核实/.test(recommendedReply), detail: '高风险场景必须明确升级人工或负责人' });
  if (baseline.decisionStage === 'lost_risk') checks.push({ name: '拒绝收尾', passed: !/购买|付款|优惠|名额|报名/.test(recommendedReply), detail: '客户连续拒绝后不得继续推进成交' });
  const competitorClaim = /(?:网上|免费|其他机构|竞品|同行).{0,24}(?:通常|多为|都是|只能|不能|没有|缺乏|更差)/.test(recommendedReply);
  checks.push({ name: '竞品事实', passed: !competitorClaim || selectedSources.some((source) => source.category === '竞品口径'), detail: competitorClaim ? '竞品比较必须引用已审核竞品口径' : '未使用无依据的竞品断言' });
  const finalValidation = { ...validationReport, passed: checks.every((check) => check.passed), checks };
  const noReliableFactsWarning = hasPublishedFacts ? [] : ['本次AI回复未引用已审核的产品、价格或案例事实，请勿对客户作确定承诺。'];
  return {
    ...baseline,
    ...advice,
    generationMode: 'ai',
    generationModel: modelName,
    recommendedReply,
    salesLoopIssue: advice.salesLoopIssue.type.toLowerCase() === 'none' ? { ...advice.salesLoopIssue, type: '暂无明显死循环' } : advice.salesLoopIssue,
    alternativeReplies: advice.alternativeReplies.map((reply) => ({ ...reply, content: lineLimit(reply.content) })),
    sourceReferences: selectedSources,
    validationReport: finalValidation,
    warnings: [...new Set([...baseline.warnings, ...noReliableFactsWarning])],
  };
}

export async function generateSalesAdvice(config: AppConfig, baseline: SalesAnalysisResult, transcript: ParsedConversation, knowledge: KnowledgeEntry[], request: AnalysisRequestInput) {
  if (config.modelDriver !== 'openai_compatible' || !config.modelName) throw new Error('真实AI销售建议未配置可用模型');
  const raw = await generateJsonText(config, { model: config.modelName, prompt: buildPrompt(baseline, transcript, knowledge, request), timeoutMs: 45_000 });
  const advice = parseModelSalesAdvice(raw, baseline);
  return applyModelAdvice(baseline, advice, transcript, knowledge, config.modelName);
}
