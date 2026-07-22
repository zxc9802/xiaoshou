import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredAnalysisJob } from './domain.js';
import { buildCustomerProfiles, findMatchingCustomerProfileId } from './customerProfiles.js';

function job(overrides: Partial<StoredAnalysisJob>): StoredAnalysisJob {
  return {
    id: 'analysis-1',
    customerProfileId: 'customer-1',
    organizationId: 'default-org',
    createdBy: 'demo-user',
    attachments: [],
    status: 'completed',
    progress: 100,
    progressLabel: '分析完成',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
    request: { conversation: '销售：王总您好\n客户：我们在佛山做工业品贸易，32个人。', attachmentNames: [] },
    clarificationQuestions: [],
    clarificationCount: 0,
    result: {
      parsedConversation: { messages: [], lastSpeaker: 'customer', lastMessage: '我们先看看', containsSensitiveData: false, sensitiveDataTypes: [], requiresConfirmation: false },
      deadlockType: 'objection', intentTemperature: 'mid', decisionStage: 'comparing', objectionType: '价值确认', clarificationQuestions: [],
      situationAnalysis: '客户正在确认培训能否真正落地。', followupAction: '明确交付物。', validationReport: { passed: true, hookPresent: true, lineCount: 2, unsupportedFacts: [], redlineHits: [], privacyMasked: true, checks: [] }, riskLevel: 'low', handoffRequired: false, styleFallbackUsed: false, fixedDisclaimer: '发送前请微调。',
      stage: '有兴趣在比较', stageEvidence: '客户继续询问。', stageConfidence: 85, explicitNeeds: ['确认培训交付物'], implicitNeedHypotheses: [], salesLoopIssue: { type: '回答不当', problem: '回答空泛', reason: '没有回答交付物' }, replyGoal: '确认核心顾虑', recommendedReply: '建议回复', alternativeReplies: [], nextBranches: [], sourceReferences: [], warnings: [],
    },
    ...overrides,
  };
}

test('continued analyses update one customer profile and preserve the latest stage', () => {
  const profiles = buildCustomerProfiles([
    job({ id: 'analysis-1' }),
    job({ id: 'analysis-2', createdAt: '2026-07-20T11:00:00.000Z', updatedAt: '2026-07-20T11:05:00.000Z', result: { ...job({}).result!, stage: '方案确认阶段', stageConfidence: 91 } }),
  ]);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].displayName, '王总');
  assert.equal(profiles[0].location, '佛山');
  assert.equal(profiles[0].industry, '工业品贸易');
  assert.equal(profiles[0].teamSize, 32);
  assert.equal(profiles[0].stage, '方案确认阶段');
  assert.equal(profiles[0].conversationCount, 2);
});

test('clear payment language is conservatively classified as won', () => {
  const profiles = buildCustomerProfiles([job({ request: { conversation: '销售：王总您好\n客户：合同已签，款也已经付款。', attachmentNames: [] } })]);
  assert.equal(profiles[0].dealStatus, 'won');
});

test('manual deal status overrides automatic classification', () => {
  const profiles = buildCustomerProfiles([job({ customerDealStatus: 'unwon', request: { conversation: '客户：合同已签。', attachmentNames: [] } })]);
  assert.equal(profiles[0].dealStatus, 'unwon');
});

test('manual customer remark overrides AI detected names', () => {
  const profiles = buildCustomerProfiles([job({ customerManualRemark: '佛山王总', customerIdentity: { displayName: '王星', nickname: '王星', identityHashes: [], confidence: 0.9 } })]);
  assert.equal(profiles[0].displayName, '佛山王总');
  assert.equal(profiles[0].manualRemark, '佛山王总');
});

test('same customer nickname reuses the existing profile instead of creating a duplicate', () => {
  const existing = job({ id: 'analysis-1', customerProfileId: 'customer-1', customerIdentity: { displayName: '王星', nickname: '王星', identityHashes: [], confidence: 0.96 } });
  const incoming = job({ id: 'analysis-2', customerProfileId: 'customer-random', customerIdentity: { displayName: '王星', nickname: '王星', identityHashes: [], confidence: 0.94 } });
  const match = findMatchingCustomerProfileId(incoming, [existing, incoming]);
  assert.equal(match.profileId, 'customer-1');
  assert.equal(match.matchStatus, 'matched');
});

test('stable contact fingerprint takes priority when the visible nickname changes', () => {
  const fingerprint = 'same-one-way-contact-hash';
  const existing = job({ id: 'analysis-1', customerProfileId: 'customer-1', customerIdentity: { displayName: '王总', remarkName: '王总', identityHashes: [fingerprint], confidence: 0.9 } });
  const incoming = job({ id: 'analysis-2', customerProfileId: 'customer-random', customerIdentity: { displayName: '星海公司王先生', nickname: '星海公司王先生', identityHashes: [fingerprint], confidence: 0.95 } });
  const match = findMatchingCustomerProfileId(incoming, [existing, incoming]);
  assert.equal(match.profileId, 'customer-1');
});

test('visually similar avatar fingerprints reuse the same customer profile', () => {
  const existing = job({ id: 'analysis-1', customerProfileId: 'customer-1', customerIdentity: { displayName: '客户A', identityHashes: [`avatar:${'f'.repeat(64)}`], confidence: 0.9 } });
  const incoming = job({ id: 'analysis-2', customerProfileId: 'customer-random', customerIdentity: { displayName: '待识别客户', identityHashes: [`avatar:${'e'.repeat(8)}${'f'.repeat(56)}`], confidence: 0.8 } });
  const match = findMatchingCustomerProfileId(incoming, [existing, incoming]);
  assert.equal(match.profileId, 'customer-1');
});

test('ambiguous duplicate names are not merged automatically', () => {
  const first = job({ id: 'analysis-1', customerProfileId: 'customer-1', customerIdentity: { displayName: '王总', remarkName: '王总', identityHashes: [], confidence: 0.9 } });
  const second = job({ id: 'analysis-2', customerProfileId: 'customer-2', customerIdentity: { displayName: '王总', remarkName: '王总', identityHashes: [], confidence: 0.9 } });
  const incoming = job({ id: 'analysis-3', customerProfileId: 'customer-random', customerIdentity: { displayName: '王总', remarkName: '王总', identityHashes: [], confidence: 0.9 } });
  const match = findMatchingCustomerProfileId(incoming, [first, second, incoming]);
  assert.equal(match.profileId, undefined);
  assert.equal(match.matchStatus, 'needs_confirmation');
  assert.deepEqual(new Set(match.possibleProfileIds), new Set(['customer-1', 'customer-2']));
});

test('legacy customers become due 72 hours after their latest analysis', () => {
  const profiles = buildCustomerProfiles([
    job({ createdAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T10:00:00.000Z' }),
  ], new Date('2026-07-23T10:00:00.001Z'));
  assert.equal(profiles[0].lastProgressAt, '2026-07-20T10:00:00.000Z');
  assert.equal(profiles[0].nextFollowUpAt, '2026-07-23T10:00:00.000Z');
  assert.equal(profiles[0].followUpDue, true);
});

test('won customers never appear as due even when the reminder time has passed', () => {
  const profiles = buildCustomerProfiles([
    job({ customerDealStatus: 'won', lastProgressAt: '2026-07-18T10:00:00.000Z', nextFollowUpAt: '2026-07-21T10:00:00.000Z' }),
  ], new Date('2026-07-25T10:00:00.000Z'));
  assert.equal(profiles[0].followUpDue, false);
});

test('multiple analyses for one customer produce one shared reminder', () => {
  const profiles = buildCustomerProfiles([
    job({ id: 'analysis-1', lastProgressAt: '2026-07-18T10:00:00.000Z', nextFollowUpAt: '2026-07-21T10:00:00.000Z' }),
    job({ id: 'analysis-2', createdAt: '2026-07-22T10:00:00.000Z', updatedAt: '2026-07-22T10:00:00.000Z', lastProgressAt: '2026-07-22T10:00:00.000Z', nextFollowUpAt: '2026-07-25T10:00:00.000Z' }),
  ], new Date('2026-07-23T10:00:00.000Z'));
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].followUpDue, false);
  assert.equal(profiles[0].lastProgressAt, '2026-07-22T10:00:00.000Z');
});
