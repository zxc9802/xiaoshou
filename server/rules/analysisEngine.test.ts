import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_KNOWLEDGE } from '../knowledge/defaults.js';
import { parseConversationText } from '../model/conversationParser.js';
import { analyzeWithRules, buildClarifications, classifyConversation, validateSalesReply } from './analysisEngine.js';

test('price objection is classified and reply contains a hook', () => {
  const transcript = parseConversationText('客户：你们价格太高了\n销售：我们的功能很全面\n客户：实施需要多久？预算也有限');
  const result = analyzeWithRules(transcript, DEFAULT_KNOWLEDGE);
  assert.equal(result.deadlockType, 'objection');
  assert.equal(result.objectionType, '价格');
  assert.equal(result.intentTemperature, 'high');
  assert.equal(result.validationReport.hookPresent, true);
  assert.equal(result.validationReport.redlineHits.length, 0);
});

test('silent, vague and stuck branches use distinct strategies', () => {
  assert.equal(classifyConversation(parseConversationText('销售：客户已经7天没回消息了')).deadlockType, 'silent');
  assert.equal(classifyConversation(parseConversationText('客户：嗯，看看再说')).deadlockType, 'vague');
  assert.equal(classifyConversation(parseConversationText('销售：这个专业问题我答不上来，怎么回答')).deadlockType, 'stuck');
});

test('two explicit refusals force a polite close-out', () => {
  const result = analyzeWithRules(parseConversationText('客户：不需要\n销售：您再考虑一下\n客户：不用了，别联系了'), DEFAULT_KNOWLEDGE);
  assert.equal(result.decisionStage, 'lost_risk');
  assert.match(result.recommendedReply, /先不打扰/);
  assert.doesNotMatch(result.recommendedReply, /购买|付款|优惠/);
});

test('complaint and refund trigger human handoff', () => {
  const result = analyzeWithRules(parseConversationText('客户：我要投诉并退款，合同条款也有问题\n销售：我来处理'), DEFAULT_KNOWLEDGE);
  assert.equal(result.handoffRequired, true);
  assert.equal(result.riskLevel, 'high');
  assert.match(result.recommendedReply, /负责人介入/);
});

test('sensitive data is detected and masked before display', () => {
  const transcript = parseConversationText('客户：手机号13812345678，微信号 wx_test888\n销售：收到');
  assert.equal(transcript.containsSensitiveData, true);
  assert.doesNotMatch(transcript.messages[0]?.text ?? '', /13812345678/);
});

test('clarifications never exceed two questions', () => {
  const questions = buildClarifications(parseConversationText('客户：有点贵'));
  assert.equal(questions.length, 2);
});

test('missing published L3 facts prevents unsupported factual reply', () => {
  const knowledge = DEFAULT_KNOWLEDGE.filter((entry) => entry.layer !== 'L3');
  const result = analyzeWithRules(parseConversationText('客户：能保证效果吗？\n销售：我确认一下'), knowledge);
  assert.equal(result.sourceReferences.some((source) => source.category === '产品资料'), false);
  assert.equal(result.warnings.some((warning) => warning.includes('未找到已审核依据')), true);
  assert.match(result.recommendedReply, /【待补充：/);
  assert.equal(result.validationReport.unsupportedFacts.length, 0);
});

test('published L4 profile changes expression but keeps strategy hook', () => {
  const now = new Date().toISOString();
  const knowledge = [...DEFAULT_KNOWLEDGE, { id: 'approved-product', origin: 'manual' as const, locked: false, layer: 'L3' as const, category: '产品资料', title: '已审核产品资料', content: '课程提供经审核的学习内容。', version: '1.0', status: 'published' as const, createdAt: now, updatedAt: now }, { id: 'style-1', layer: 'L4' as const, category: '个人表达风格', title: '测试风格', content: '称呼和拆条', version: '1.0', status: 'published' as const, createdAt: now, updatedAt: now, structuredData: { ownerId: 'seller-1', customerAddressing: '王总', punctuation: '自然', messageSplitting: '分条', emojis: ['😊'], commonParticles: [], referenceMessages: [] } }];
  const result = analyzeWithRules(parseConversationText('客户：价格有点高\n销售：您更关注预算还是价值？'), knowledge, [], 'seller-1');
  assert.match(result.recommendedReply, /^王总，/);
  assert.match(result.recommendedReply, /😊$/);
  assert.equal(result.styleFallbackUsed, false);
  assert.equal(result.validationReport.hookPresent, true);
});

test('discussing a customer concern about results is not treated as an unsupported fact claim', () => {
  const transcript = parseConversationText('客户：我担心没有效果\n销售：理解您的顾虑');
  const report = validateSalesReply('理解您的顾虑，我们与其纠结效果，不如先确认您最希望改善的饮用习惯，您看可以吗？', transcript, false);
  assert.equal(report.unsupportedFacts.length, 0);
  assert.equal(report.checks.find((check) => check.name === '事实依据')?.passed, true);
});

test('numeric commercial claims require published factual evidence', () => {
  const transcript = parseConversationText('客户：请介绍企业版\n销售：我核实一下');
  const report = validateSalesReply('企业版年费39,800元，最多80席位，10个工作日交付，您看可以吗？', transcript, false);
  assert.equal(report.passed, false);
  assert.ok(report.unsupportedFacts.length > 0);
});
