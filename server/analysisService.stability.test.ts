import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from './config.js';
import { AnalysisService } from './analysisService.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { MemoryObjectStorage } from './infrastructure/objectStorage.js';
import { RuleBasedConversationParser } from './model/conversationParser.js';

const config: AppConfig = { port: 8787, host: '127.0.0.1', corsOrigin: '*', retentionDays: 365, workerMode: 'external', repositoryDriver: 'memory', localDataDir: '.data-test', objectStorageDriver: 'memory', modelDriver: 'rule_based', embeddingModelName: 'text-embedding-3-large', knowledgeImportMaxTotalMb: 250, s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true } };
const actor = { organizationId: 'default-org', userId: 'demo-user', role: 'admin' };

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
