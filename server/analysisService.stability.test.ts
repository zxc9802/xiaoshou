import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from './config.js';
import { AnalysisService } from './analysisService.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { MemoryObjectStorage } from './infrastructure/objectStorage.js';
import { RuleBasedConversationParser } from './model/conversationParser.js';

const config: AppConfig = { port: 8787, host: '127.0.0.1', corsOrigin: '*', retentionDays: 365, workerMode: 'external', repositoryDriver: 'memory', localDataDir: '.data-test', objectStorageDriver: 'memory', modelDriver: 'rule_based', embeddingModelName: 'text-embedding-3-large', knowledgeImportMaxTotalMb: 250, s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true } };
const actor = { organizationId: 'default-org', userId: 'demo-user', role: 'admin' };

class RecordingMemoryRepository extends MemoryRepository {
  readonly updatedStatuses: string[] = [];

  override async updateJob(job: Parameters<MemoryRepository['updateJob']>[0]) {
    this.updatedStatuses.push(job.status);
    await super.updateJob(job);
  }
}

test('analysis completes without entering the removed validation stage', async () => {
  const repository = new RecordingMemoryRepository();
  const service = new AnalysisService(repository, new MemoryObjectStorage(), new RuleBasedConversationParser(), config);
  const created = await service.create({
    conversation: '客户：课程价格有点高\n销售：您更关心预算还是效果？\n客户：预算有限，但还想了解',
    attachmentNames: [],
  }, [], actor);

  assert.equal(await service.processPending(), true);
  assert.equal((await repository.getJob(created.id))?.status, 'completed');
  assert.equal(repository.updatedStatuses.includes('validating'), false);
  assert.equal(repository.updatedStatuses.includes('blocked'), false);
});

class CountingRepository extends MemoryRepository {
  knowledgeReads = 0;

  override async listKnowledge(organizationId: string) {
    this.knowledgeReads += 1;
    return super.listKnowledge(organizationId);
  }
}

test('an analysis can be canceled and safely requeued', async () => {
  const repository = new MemoryRepository();
  const service = new AnalysisService(repository, new MemoryObjectStorage(), new RuleBasedConversationParser(), config);
  const created = await service.create({ conversation: '客户：价格有点高', attachmentNames: [] }, [], actor);
  const canceled = await service.cancel(created.id, actor);
  assert.equal(canceled.status, 'canceled');
  const retried = await service.retry(created.id, actor);
  assert.equal(retried.status, 'uploaded');
  assert.equal(retried.error, undefined);
});

test('startup recovery blocks tasks that already reached the retry ceiling', async () => {
  const repository = new MemoryRepository();
  const service = new AnalysisService(repository, new MemoryObjectStorage(), new RuleBasedConversationParser(), config);
  const created = await service.create({ conversation: '客户：稍后再说', attachmentNames: [] }, [], actor);
  created.status = 'generating';
  created.executionAttempts = 3;
  await repository.updateJob(created);
  assert.equal(await service.recoverPending(), 1);
  assert.equal((await repository.getJob(created.id))?.status, 'failed');
});

test('follow-up actions reset or snooze one shared customer reminder', async () => {
  const repository = new MemoryRepository();
  const service = new AnalysisService(repository, new MemoryObjectStorage(), new RuleBasedConversationParser(), config);
  const created = await service.create({ conversation: '客户：我再考虑一下', attachmentNames: [] }, [], actor);
  assert.ok(created.lastProgressAt);
  assert.equal(Date.parse(created.nextFollowUpAt!) - Date.parse(created.lastProgressAt!), 72 * 60 * 60 * 1000);

  created.nextFollowUpAt = '2020-01-01T00:00:00.000Z';
  await repository.updateJob(created);
  assert.equal((await service.customerReminderSummary(actor)).dueCount, 1);

  const snoozed = await service.updateCustomerFollowUp(created.customerProfileId!, 'snooze', actor);
  assert.equal(snoozed.followUpDue, false);
  assert.ok(Date.parse(snoozed.nextFollowUpAt) > Date.now());

  const completed = await service.updateCustomerFollowUp(created.customerProfileId!, 'completed', actor);
  assert.equal(completed.followUpDue, false);
  assert.equal(Date.parse(completed.nextFollowUpAt) - Date.parse(completed.lastProgressAt), 72 * 60 * 60 * 1000);
  const audits = await repository.listAudit(actor.organizationId, 20);
  assert.ok(audits.some((entry) => entry.action === 'customer.follow_up_completed'));
  assert.ok(audits.some((entry) => entry.action === 'customer.follow_up_snoozed'));
});

test('editing a customer remark does not reset the follow-up clock', async () => {
  const repository = new MemoryRepository();
  const service = new AnalysisService(repository, new MemoryObjectStorage(), new RuleBasedConversationParser(), config);
  const created = await service.create({ conversation: '客户：稍后联系', attachmentNames: [] }, [], actor);
  const progressAt = created.lastProgressAt;
  const reminderAt = created.nextFollowUpAt;
  await service.setCustomerRemark(created.customerProfileId!, '重点客户', actor);
  const stored = await repository.getJob(created.id);
  assert.equal(stored?.lastProgressAt, progressAt);
  assert.equal(stored?.nextFollowUpAt, reminderAt);
});

test('editing a customer remark follows the latest analysis after a profile merge', async () => {
  const repository = new MemoryRepository();
  const service = new AnalysisService(repository, new MemoryObjectStorage(), new RuleBasedConversationParser(), config);
  const created = await service.create({ conversation: '客户：稍后联系', attachmentNames: [] }, [], actor);
  const staleProfileId = created.customerProfileId!;
  created.customerProfileId = 'merged-profile';
  await repository.updateJob(created);

  const updated = await service.setCustomerRemark(staleProfileId, '合并后的客户', actor, created.id);

  assert.equal(updated.id, 'merged-profile');
  assert.equal((await repository.getJob(created.id))?.customerManualRemark, '合并后的客户');
});

test('disabled analysis completes without reading the knowledge repository', async () => {
  const repository = new CountingRepository();
  const service = new AnalysisService(
    repository,
    new MemoryObjectStorage(),
    new RuleBasedConversationParser(),
    { ...config, analysisKnowledgeEnabled: false },
  );
  const created = await service.create({ conversation: '客户：价格有点高\n销售：您更担心预算还是实际价值？', attachmentNames: [] }, [], actor);

  assert.equal(await service.processPending(), true);
  const completed = await repository.getJob(created.id);
  assert.equal(repository.knowledgeReads, 0);
  assert.equal(completed?.status, 'completed');
  assert.deepEqual(completed?.result?.sourceReferences, []);
});

test('enabled analysis retains knowledge repository retrieval', async () => {
  const repository = new CountingRepository();
  const service = new AnalysisService(
    repository,
    new MemoryObjectStorage(),
    new RuleBasedConversationParser(),
    { ...config, analysisKnowledgeEnabled: true },
  );
  await service.create({ conversation: '客户：价格有点高\n销售：您更担心预算还是实际价值？', attachmentNames: [] }, [], actor);

  assert.equal(await service.processPending(), true);
  assert.equal(repository.knowledgeReads, 1);
});
