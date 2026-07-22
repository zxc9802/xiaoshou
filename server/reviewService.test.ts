import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredAnalysisJob } from './domain.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { ReviewService } from './reviewService.js';
import { analyzeWithRules } from './rules/analysisEngine.js';
import { parseConversationText } from './model/conversationParser.js';
import { DEFAULT_KNOWLEDGE } from './knowledge/defaults.js';

const actor = { organizationId: 'default-org', userId: 'seller-1', role: 'admin' };

function job(id: string, createdAt: string, conversation: string, profileId = 'customer-1'): StoredAnalysisJob {
  const transcript = parseConversationText(conversation);
  return {
    id, organizationId: actor.organizationId, createdBy: actor.userId, attachments: [], customerProfileId: profileId,
    status: 'completed', progress: 100, progressLabel: '完成', createdAt, updatedAt: createdAt,
    request: { conversation, attachmentNames: [] }, transcript, clarificationQuestions: [], clarificationCount: 0,
    result: analyzeWithRules(transcript, DEFAULT_KNOWLEDGE),
  };
}

test('follow-up analysis creates one review for the same customer', async () => {
  const repository = new MemoryRepository();
  const service = new ReviewService(repository);
  await repository.createJob(job('analysis-1', '2026-07-20T10:00:00.000Z', '客户：价格有点高，我考虑一下\n销售：您更担心预算还是价值？'));
  await repository.createJob(job('analysis-2', '2026-07-21T10:00:00.000Z', '客户：主要担心落地，你们能演示吗\n销售：可以先确认您的核心流程'));
  const reviews = await service.list(actor);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.beforeAnalysisId, 'analysis-1');
  assert.equal(reviews[0]?.afterAnalysisId, 'analysis-2');
  assert.ok(reviews[0]?.customerResponse);
});

test('human outcome confirmation overrides AI suggestion', async () => {
  const repository = new MemoryRepository();
  const service = new ReviewService(repository);
  await repository.createJob(job('analysis-1', '2026-07-20T10:00:00.000Z', '客户：我考虑一下\n销售：好的'));
  await repository.addFeedback({ id: 'feedback-1', analysisId: 'analysis-1', userId: actor.userId, outcome: 'adopted', createdAt: '2026-07-20T11:00:00.000Z' });
  const [review] = await service.list(actor);
  assert.ok(review);
  const confirmed = await service.confirmOutcome(actor, review.id, 'progressed', '最终实际发送的话术');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmedOutcome, 'progressed');
  assert.equal(confirmed.actualReply, '最终实际发送的话术');
});

test('only effective confirmed reviews can become knowledge candidates', async () => {
  const repository = new MemoryRepository();
  const service = new ReviewService(repository);
  await repository.createJob(job('analysis-1', '2026-07-20T10:00:00.000Z', '客户：我考虑一下\n销售：好的'));
  await repository.addFeedback({ id: 'feedback-1', analysisId: 'analysis-1', userId: actor.userId, outcome: 'adopted', createdAt: '2026-07-20T11:00:00.000Z' });
  const [review] = await service.list(actor);
  assert.ok(review);
  await service.confirmOutcome(actor, review.id, 'progressed');
  const promoted = await service.promote(actor, review.id);
  assert.ok(promoted.knowledgeCandidateId);
  const knowledge = await repository.getKnowledge(promoted.knowledgeCandidateId!);
  assert.equal(knowledge?.status, 'in_review');
  assert.equal(knowledge?.structuredData?.businessCategory, '销售技巧');
});
