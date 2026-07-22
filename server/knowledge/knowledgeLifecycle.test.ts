import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { MemoryObjectStorage } from '../infrastructure/objectStorage.js';
import { MemoryRepository } from '../infrastructure/memoryRepository.js';
import { KnowledgeService } from '../knowledgeService.js';
import type { KnowledgeIndexScheduler } from '../knowledgeIndexService.js';

const config: AppConfig = { port: 8787, host: '127.0.0.1', corsOrigin: '*', retentionDays: 365, workerMode: 'inline', repositoryDriver: 'memory', localDataDir: '.data-test', objectStorageDriver: 'memory', modelDriver: 'rule_based', embeddingModelName: 'text-embedding-3-large', knowledgeImportMaxTotalMb: 250, s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true } };
const actor = { organizationId: 'org-1', userId: 'admin-1', role: 'admin' };

class RecordingIndexScheduler implements KnowledgeIndexScheduler {
  readonly upserts: Array<{ organizationId: string; entryId: string }> = [];
  readonly deletes: Array<{ organizationId: string; entryId: string }> = [];
  async scheduleUpsert(organizationId: string, entryId: string) { this.upserts.push({ organizationId, entryId }); }
  async scheduleDelete(organizationId: string, entryId: string) { this.deletes.push({ organizationId, entryId }); }
}

test('system baseline is complete, locked, and excludes disabled demo facts', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  await service.initializeKnowledge(actor.organizationId);
  const entries = await service.list(actor.organizationId);
  const systemEntries = entries.filter((entry) => entry.origin === 'system');
  assert.equal(systemEntries.filter((entry) => entry.layer === 'L2').length, 18);
  assert.ok(systemEntries.every((entry) => entry.locked));
  assert.equal(entries.some((entry) => entry.title === '企业版产品说明'), false);
  const strategy = systemEntries.find((entry) => entry.title === '价格异议处理策略');
  assert.ok(strategy);
  await assert.rejects(() => service.update(actor.organizationId, strategy.id, { title: '不能修改' }), /系统通用条目已锁定/);
  await assert.rejects(() => service.trashEntries(actor, [strategy.id]), /系统通用条目不能删除/);
});

test('system entries can be copied and user entries support trash, restore, and purge', async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryObjectStorage();
  const service = new KnowledgeService(repository, storage, config);
  await service.initializeKnowledge(actor.organizationId);
  const systemEntry = (await service.list(actor.organizationId)).find((entry) => entry.title === '客户信任异议处理');
  assert.ok(systemEntry);
  const copy = await service.copySystemEntry(actor, systemEntry.id);
  assert.equal(copy.origin, 'manual');
  assert.equal(copy.locked, false);
  assert.equal(copy.status, 'draft');

  const second = await service.create(actor.organizationId, { layer: 'L3', category: '产品资料', title: '企业自建资料', content: '企业已审核内容。' });
  const trash = await service.trashEntries(actor, [copy.id, second.id]);
  assert.ok(trash.some((entry) => entry.id === copy.id && entry.purgeAt));
  assert.equal((await service.list(actor.organizationId)).some((entry) => entry.id === copy.id), false);

  await service.restoreEntries(actor, [copy.id]);
  assert.ok((await service.list(actor.organizationId)).some((entry) => entry.id === copy.id && !entry.deletedAt));
  await service.permanentlyDelete(actor, second.id);
  assert.equal(await repository.getKnowledge(second.id), undefined);
  const audits = await repository.listAudit(actor.organizationId, 20);
  assert.ok(audits.some((record) => record.action === 'knowledge.trash'));
  assert.ok(audits.some((record) => record.action === 'knowledge.restore'));
  assert.ok(audits.some((record) => record.action === 'knowledge.purge'));
});

test('expired trash is purged automatically while active and system entries remain', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  await service.initializeKnowledge(actor.organizationId);
  const entry = await service.create(actor.organizationId, { layer: 'L3', category: '产品资料', title: '过期资料', content: '等待清理。' });
  await service.trashEntries(actor, [entry.id]);
  const trashed = await repository.getKnowledge(entry.id);
  assert.ok(trashed);
  await repository.updateKnowledge(actor.organizationId, { ...trashed, purgeAt: '2020-01-01T00:00:00.000Z' });
  await service.purgeExpiredTrash(actor.organizationId);
  assert.equal(await repository.getKnowledge(entry.id), undefined);
  assert.ok((await service.list(actor.organizationId)).some((item) => item.origin === 'system'));
});

test('published L2/L3 lifecycle schedules upserts and removals while L4 stays outside Qdrant', async () => {
  const repository = new MemoryRepository();
  const scheduler = new RecordingIndexScheduler();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config, scheduler);
  const knowledge = await service.create(actor.organizationId, {
    layer: 'L3', category: '价格与版本', title: '企业版价格', content: '原价格规则。',
  });

  await service.setStatus(actor.organizationId, knowledge.id, 'published', actor.userId);
  await service.update(actor.organizationId, knowledge.id, {
    title: '企业版审核价格',
    content: '新价格规则。',
    category: '报价规则',
    version: '2.0',
    effectiveFrom: '2026-07-22T00:00:00.000Z',
    effectiveTo: '2027-07-22T00:00:00.000Z',
  });
  await service.setStatus(actor.organizationId, knowledge.id, 'archived', actor.userId);
  await service.setStatus(actor.organizationId, knowledge.id, 'published', actor.userId);
  await service.trashEntries(actor, [knowledge.id]);
  await service.restoreEntries(actor, [knowledge.id]);
  await service.trashEntries(actor, [knowledge.id]);
  await service.permanentlyDelete(actor, knowledge.id);

  assert.deepEqual(scheduler.upserts, Array.from({ length: 4 }, () => ({
    organizationId: actor.organizationId, entryId: knowledge.id,
  })));
  assert.deepEqual(scheduler.deletes, Array.from({ length: 4 }, () => ({
    organizationId: actor.organizationId, entryId: knowledge.id,
  })));

  const personal = await service.create(actor.organizationId, {
    layer: 'L4', category: '个人风格', title: '我的风格', content: '表达简洁。',
  });
  await service.setStatus(actor.organizationId, personal.id, 'published', actor.userId);
  assert.equal(scheduler.upserts.some((item) => item.entryId === personal.id), false);
  assert.equal(scheduler.deletes.some((item) => item.entryId === personal.id), false);
});

test('human confirmation of an uploaded L2/L3 entry schedules indexing', async () => {
  const repository = new MemoryRepository();
  const scheduler = new RecordingIndexScheduler();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config, scheduler);
  const uploaded = await service.upload(actor.organizationId, {
    name: '价格说明.txt', mimeType: 'text/plain', data: Buffer.from('价格政策：折扣必须审批。'),
  });

  await service.confirmClassification(actor.organizationId, uploaded.id, {
    layer: 'L3', category: '价格与版本', title: '价格说明', content: '折扣必须审批。', version: '1.0',
  }, actor.userId);

  assert.deepEqual(scheduler.upserts, [{ organizationId: actor.organizationId, entryId: uploaded.id }]);
});
