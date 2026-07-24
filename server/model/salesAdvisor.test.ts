import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { DEFAULT_KNOWLEDGE } from '../knowledge/defaults.js';
import { analyzeWithRules } from '../rules/analysisEngine.js';
import { parseConversationText } from './conversationParser.js';
import { applyModelAdvice, parseModelSalesAdvice, type ModelSalesAdvice } from './salesAdvisor.js';
import * as salesAdvisor from './salesAdvisor.js';

function advice(sourceIds: string[]): ModelSalesAdvice {
  return {
    situationAnalysis: '客户仍在了解课程，但当前需要先确认价值顾虑。',
    salesStrategy: { name: '异议隔离与价值重构', reason: '客户仍在互动，但担心投入不值。', conversionGoal: '让客户说出预算或应用价值中的主要顾虑', techniques: ['承接顾虑', '二选一推进'] },
    followupAction: '先确认客户更关心预算还是实际应用价值。',
    stage: '犹豫权衡',
    stageEvidence: '客户表达价格顾虑，但没有明确拒绝。',
    stageConfidence: 82,
    explicitNeeds: ['判断课程是否适合当前企业。'],
    implicitNeedHypotheses: [{ statement: '假设：客户希望降低决策风险。', confidence: 76, evidence: '客户仍在询问并比较。', validationQuestion: '您更担心预算，还是课程能否用于实际业务？' }],
    salesLoopIssue: { type: '价值尚未对齐', problem: '销售尚未确认客户的核心顾虑。', reason: '继续介绍功能会增加信息负担。' },
    replyGoal: '确认客户认为不值得的具体原因。',
    recommendedReply: '理解您的顾虑。\n想先确认一下，您更担心预算压力，还是课程能否真正用于业务？',
    alternativeReplies: [
      { tone: '简洁', content: '您现在更担心预算，还是实际应用价值？' },
      { tone: '柔和', content: '理解，您可以告诉我更担心预算还是实际应用，我只针对这一点说明。' },
      { tone: '更有推进感', content: '我们先用10分钟确认需求，今天下午还是明天上午方便？' },
    ],
    nextBranches: [{ customerReply: '客户说明主要担心预算', nextAction: '确认预算范围，不立即降价。', suggestedLine: '您方便说一下大致预算范围吗？' }],
    sourceIds,
  };
}

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
  assert.equal(result.warnings.some((warning) => warning.includes('未引用已审核')), false);
});

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
  assert.equal(result.warnings.some((warning) => warning.includes('未引用已审核')), false);
});

test('model advice warns when a cited source does not contain every concrete fact', () => {
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

  assert.equal(result.sourceReferences[0]?.id, source.id);
  assert.equal(result.warnings.some((warning) => warning.includes('未引用已审核')), true);
  assert.equal('validationReport' in result, false);
});

test('model advice replaces local reply and records the real generation mode', () => {
  const transcript = parseConversationText('客户：课程价格有点高\n销售：我们内容很多');
  const now = new Date().toISOString();
  const source = { id: 'approved-price-policy', origin: 'manual' as const, locked: false, layer: 'L3' as const, category: '价格政策', title: '已审核价格政策', content: '课程报价以企业已审核价格表为准。', version: '1.0', status: 'published' as const, createdAt: now, updatedAt: now };
  const knowledge = [...DEFAULT_KNOWLEDGE, source];
  const baseline = analyzeWithRules(transcript, knowledge);
  const result = applyModelAdvice(baseline, advice([source.id]), transcript, knowledge, 'gemini-test');
  assert.equal(result.generationMode, 'ai');
  assert.equal(result.generationModel, 'gemini-test');
  assert.match(result.recommendedReply, /课程能否真正用于业务/);
  assert.equal(result.sourceReferences[0]?.id, source.id);
});

test('model advice cannot cite unknown knowledge entries', () => {
  const transcript = parseConversationText('客户：能保证效果吗？\n销售：可以');
  const baseline = analyzeWithRules(transcript, DEFAULT_KNOWLEDGE);
  const result = applyModelAdvice(baseline, { ...advice(['missing-source']), recommendedReply: '这个课程效果很好，您现在报名可以吗？' }, transcript, DEFAULT_KNOWLEDGE, 'gemini-test');
  assert.equal(result.sourceReferences.length, 0);
  assert.equal(result.warnings.some((warning) => warning.includes('未引用已审核')), true);
  assert.equal('validationReport' in result, false);
});

test('model advice is no longer blocked by a final competitor compliance gate', () => {
  const transcript = parseConversationText('客户：网上有很多免费课程\n销售：我了解一下');
  const baseline = analyzeWithRules(transcript, DEFAULT_KNOWLEDGE);
  const result = applyModelAdvice(baseline, { ...advice([]), recommendedReply: '网上免费课程通常都不能落地，您报名我们的课程可以吗？' }, transcript, DEFAULT_KNOWLEDGE, 'gemini-test');
  assert.match(result.recommendedReply, /网上免费课程/);
  assert.equal('validationReport' in result, false);
});

test('empty model loop fields fall back to the local safety analysis', () => {
  const transcript = parseConversationText('客户：我担心效果不明显\n销售：我再给您介绍一下配方');
  const baseline = analyzeWithRules(transcript, DEFAULT_KNOWLEDGE);
  const payload = advice([]);
  payload.salesLoopIssue = { type: '', problem: '', reason: '' };
  const parsed = parseModelSalesAdvice(JSON.stringify(payload), baseline);
  assert.equal(parsed.salesLoopIssue.type, baseline.salesLoopIssue.type);
  assert.equal(parsed.salesLoopIssue.problem, baseline.salesLoopIssue.problem);
  assert.equal(parsed.salesLoopIssue.reason, baseline.salesLoopIssue.reason);
});

test('disabled analysis prompt omits knowledge content and citation instructions', () => {
  const buildSalesAdvicePrompt = (salesAdvisor as { buildSalesAdvicePrompt?: (...args: any[]) => string }).buildSalesAdvicePrompt;
  assert.ok(buildSalesAdvicePrompt, 'buildSalesAdvicePrompt must expose both prompt modes');
  const transcript = parseConversationText('客户：课程能解决什么问题？');
  const baseline = analyzeWithRules(transcript, []);
  const source = { ...DEFAULT_KNOWLEDGE[0]!, id: 'sentinel-source', content: 'SENTINEL_KNOWLEDGE_CONTENT' };
  const prompt = buildSalesAdvicePrompt(baseline, transcript, [source], { conversation: '课程咨询', attachmentNames: [] }, false);

  assert.doesNotMatch(prompt, /SENTINEL_KNOWLEDGE_CONTENT/);
  assert.doesNotMatch(prompt, /已审核知识/);
  assert.doesNotMatch(prompt, /sourceIds/);
});

test('enabled analysis prompt retains knowledge content and citation instructions', () => {
  const buildSalesAdvicePrompt = (salesAdvisor as { buildSalesAdvicePrompt?: (...args: any[]) => string }).buildSalesAdvicePrompt;
  assert.ok(buildSalesAdvicePrompt, 'buildSalesAdvicePrompt must expose both prompt modes');
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
