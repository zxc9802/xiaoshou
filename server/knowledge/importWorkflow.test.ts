import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { AppConfig } from '../config.js';
import { MemoryObjectStorage } from '../infrastructure/objectStorage.js';
import { MemoryRepository } from '../infrastructure/memoryRepository.js';
import { KnowledgeService } from '../knowledgeService.js';
import type { KnowledgeIndexScheduler } from '../knowledgeIndexService.js';
import { maskSensitive } from './mediaAnalyzer.js';

const config: AppConfig = { port: 8787, host: '127.0.0.1', corsOrigin: '*', retentionDays: 365, workerMode: 'inline', repositoryDriver: 'memory', localDataDir: '.data-test', objectStorageDriver: 'memory', modelDriver: 'rule_based', embeddingModelName: 'text-embedding-3-large', knowledgeImportMaxTotalMb: 250, s3: { region: 'us-east-1', bucket: 'test', forcePathStyle: true } };
const actor = { organizationId: 'org-1', userId: 'admin-1', role: 'admin' };
const anotherUser = { organizationId: 'org-1', userId: 'seller-2', role: 'user' };

class RecordingIndexScheduler implements KnowledgeIndexScheduler {
  readonly upserts: Array<{ organizationId: string; entryId: string }> = [];
  readonly deletes: Array<{ organizationId: string; entryId: string }> = [];
  async scheduleUpsert(organizationId: string, entryId: string) { this.upserts.push({ organizationId, entryId }); }
  async scheduleDelete(organizationId: string, entryId: string) { this.deletes.push({ organizationId, entryId }); }
}

async function waitForImport(service: KnowledgeService, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await service.getImport(actor, id);
    if (['waiting_review', 'published', 'failed'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('导入任务未在测试时间内完成');
}

async function createAndWait(service: KnowledgeService, files: Array<{ name: string; mimeType: string; data: Buffer }>) {
  const created = await service.createImport(actor, files);
  return waitForImport(service, created.id);
}

test('users only see and review their own import jobs', async () => {
  const service = new KnowledgeService(new MemoryRepository(), new MemoryObjectStorage(), config);
  const first = await service.createImport(actor, [{ name: 'first.txt', mimeType: 'text/plain', data: Buffer.from('first import') }]);
  const second = await service.createImport(anotherUser, [{ name: 'second.txt', mimeType: 'text/plain', data: Buffer.from('second import') }]);

  assert.deepEqual((await service.listImports(actor)).map((job) => job.id), [first.id]);
  assert.deepEqual((await service.listImports(anotherUser)).map((job) => job.id), [second.id]);
  await assert.rejects(service.getImport(anotherUser, first.id), /不存在/);
});

test('bulk import creates review candidates without publishing knowledge entries', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  const before = await service.list(actor.organizationId);
  const job = await createAndWait(service, [
    { name: '价格政策.md', mimeType: 'text/markdown', data: Buffer.from('2026年价格政策：折扣必须审批，不得直接承诺最低价。') },
    { name: '客户案例.txt', mimeType: 'text/plain', data: Buffer.from('客户案例：某企业上线后通过标准流程缩短交付周期。') },
  ]);
  const after = await service.list(actor.organizationId);
  assert.equal(job.status, 'waiting_review');
  assert.equal(job.sourceFiles.length, 2);
  assert.ok(job.candidates.length >= 2);
  assert.ok(job.candidates.some((candidate) => candidate.businessCategory === '产品资料' && candidate.category === '价格与版本'));
  assert.ok(job.candidates.some((candidate) => candidate.businessCategory === '客户案例' || (candidate.businessCategory === '产品资料' && candidate.category === '实施交付')));
  assert.equal(after.length, before.length);
});

test('mixed long content is split into multiple semantic knowledge candidates', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  const mixedKnowledge = [
    '\u4ea7\u54c1\u8d44\u6599\uff1a\u4f01\u4e1a\u7248\u652f\u6301\u6743\u9650\u7ba1\u7406\u3001\u5ba1\u6279\u6d41\u3001\u6570\u636e\u770b\u677f\u548c\u4ea4\u4ed8\u57f9\u8bad\u3002',
    '\u4ef7\u683c\u653f\u7b56\uff1a\u6807\u51c6\u62a5\u4ef7\u4ee5\u5df2\u53d1\u5e03\u4ef7\u76ee\u8868\u4e3a\u51c6\uff0c\u6298\u6263\u5fc5\u987b\u8d70\u5ba1\u6279\u3002',
    '\u5ba2\u6237\u6848\u4f8b\uff1a\u67d0\u5236\u9020\u4f01\u4e1a\u4e0a\u7ebf\u540e\uff0c\u9500\u552e\u8ddf\u8fdb\u6548\u7387\u660e\u663e\u63d0\u5347\u3002',
    '\u7981\u7528\u7ea2\u7ebf\uff1a\u4e0d\u5f97\u627f\u8bfa\u767e\u5206\u767e\u6548\u679c\uff0c\u4e0d\u5f97\u627f\u8bfa\u6700\u4f4e\u4ef7\u3002',
    '\u9500\u552e\u7b56\u7565\uff1a\u5ba2\u6237\u8bf4\u8d35\u65f6\uff0c\u5148\u786e\u8ba4\u9884\u7b97\u95ee\u9898\u8fd8\u662f\u4ef7\u503c\u611f\u77e5\u95ee\u9898\u3002',
  ].join('\n\n');
  const job = await createAndWait(service, [{
    name: 'mixed-sales-knowledge.txt',
    mimeType: 'text/plain',
    data: Buffer.from(mixedKnowledge),
  }]);
  const categories = new Set(job.candidates.map((candidate) => String(candidate.businessCategory)));
  assert.equal(job.status, 'waiting_review');
  assert.ok(job.candidates.length >= 5);
  assert.ok(categories.has('产品资料'));
  assert.ok(categories.has('产品资料'));
  assert.ok(categories.has('客户案例'));
  assert.ok(categories.has('禁用红线'));
  assert.ok(categories.has('销售技巧'));
});

test('confirmed import publishes edited candidates with source references', async () => {
  const repository = new MemoryRepository();
  const scheduler = new RecordingIndexScheduler();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config, scheduler);
  const job = await createAndWait(service, [{ name: '产品说明.md', mimeType: 'text/markdown', data: Buffer.from('产品资料：企业版支持权限管理、审批流和交付培训。') }]);
  const edited = job.candidates.map((candidate) => ({ ...candidate, title: '企业版产品说明', content: `${candidate.content}\n\n人工确认：内容已核对。` }));
  const confirmed = await service.confirmImport(actor, job.id, edited);
  const entries = await service.list(actor.organizationId);
  const published = entries.find((entry) => confirmed.publishedEntryIds.includes(entry.id));
  assert.equal(confirmed.status, 'published');
  assert.ok(published);
  assert.equal(published?.title, '企业版产品说明');
  assert.match(published?.content ?? '', /人工确认/);
  assert.equal(published?.structuredData?.requiresHumanConfirmation, false);
  assert.ok(Array.isArray(published?.structuredData?.sourceReferences));
  assert.equal((published?.structuredData?.embedding as { status?: string })?.status, 'pending');
  assert.deepEqual(scheduler.upserts, confirmed.publishedEntryIds.map((entryId) => ({ organizationId: actor.organizationId, entryId })));
});

test('import candidates can be split, merged, and discarded before confirmation', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  let job = await createAndWait(service, [{ name: '混合资料.md', mimeType: 'text/markdown', data: Buffer.from('价格政策：折扣必须审批。\n\n销售策略：客户说贵时先确认预算还是价值。\n\n禁用红线：不得承诺百分百效果。') }]);
  const first = job.candidates[0];
  assert.ok(first);
  job = await service.splitCandidate(actor, job.id, first.id);
  assert.ok(job.candidates.length >= 2);
  const active = job.candidates.filter((candidate) => candidate.reviewStatus !== 'discarded');
  job = await service.mergeCandidates(actor, job.id, active[0].id, active[1].id);
  assert.equal(job.candidates.find((candidate) => candidate.id === active[1].id)?.reviewStatus, 'discarded');
  const remaining = job.candidates.find((candidate) => candidate.reviewStatus !== 'discarded');
  assert.ok(remaining);
  job = await service.discardCandidate(actor, job.id, remaining.id);
  assert.ok(job.candidates.some((candidate) => candidate.id === remaining.id && candidate.reviewStatus === 'discarded'));
});

test('knowledge export supports json, markdown, and excel-readable xml', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  const job = await createAndWait(service, [{ name: '报价.md', mimeType: 'text/markdown', data: Buffer.from('价格政策：标准报价以已发布价格表为准。') }]);
  await service.confirmImport(actor, job.id, job.candidates);
  const json = await service.exportKnowledge(actor.organizationId, 'json');
  const markdown = await service.exportKnowledge(actor.organizationId, 'markdown');
  const excel = await service.exportKnowledge(actor.organizationId, 'excel');
  assert.equal(json.contentType, 'application/json; charset=utf-8');
  assert.match(markdown.content, /价格政策/);
  assert.match(excel.content, /Workbook/);
});

test('structured Word import preserves every second-level chapter and reaches full coverage', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  const paragraph = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const chapters = Array.from({ length: 50 }, (_, index) => `${paragraph(`第${index + 1}章`, 'Heading2')}${paragraph(`这是第${index + 1}章的产品、销售或合规知识正文。`)}${paragraph('核对事项', 'Heading3')}${paragraph('必须经人工审核后才能发布。', 'ListBullet')}`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph('企业资料包', 'Heading1')}${chapters}</w:body></w:document>`;
  const data = Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }));
  const job = await createAndWait(service, [{ name: '完整资料包.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data }]);
  assert.equal(job.revision?.totalSections, 50);
  assert.ok(job.candidates.length >= 50);
  assert.ok((job.coveragePercentage ?? 0) >= 95);
  assert.equal(job.uncoveredSections?.length, 0);

  const reparsed = await service.reparseImport(actor, job.id);
  const revision = await waitForImport(service, reparsed.id);
  assert.notEqual(revision.id, job.id);
  assert.equal(revision.parentImportId, job.id);
  assert.equal(revision.revisionNumber, 2);
  assert.equal((await service.getImport(actor, job.id)).candidates.length, job.candidates.length);
});

test('product and customer-case entries preserve original image and video assets', async () => {
  const repository = new MemoryRepository();
  const storage = new MemoryObjectStorage();
  const service = new KnowledgeService(repository, storage, config);
  const entry = await service.create(actor.organizationId, {
    layer: 'L3',
    category: '产品资料',
    title: '产品 A 详细资料',
    content: '产品 A 的已审核说明。',
    structuredData: { businessCategory: '产品资料', entityName: '产品 A' },
  });
  const updated = await service.addMedia(actor, entry.id, { name: '产品演示.mp4', mimeType: 'video/mp4', data: Buffer.from('video-binary') });
  const assets = updated.structuredData?.mediaAssets as Array<{ id: string; kind: string; name: string }>;
  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.kind, 'video');
  assert.equal(assets[0]?.name, '产品演示.mp4');
  const stored = await service.getMedia(actor, entry.id, assets[0]!.id);
  assert.equal(stored.data.toString(), 'video-binary');
});

test('champion chat screenshots stay grouped as sales tactics and require review', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), config);
  const created = await service.createImport(actor, [
    { name: '聊天-2.png', mimeType: 'image/png', data: Buffer.from('second-screen') },
    { name: '聊天-1.png', mimeType: 'image/png', data: Buffer.from('first-screen') },
  ], { purpose: 'champion_chat', sourceTitle: '价格异议销冠对话', sourceGroupId: 'chat-group-1' });
  const job = await waitForImport(service, created.id);
  assert.equal(job.status, 'waiting_review');
  assert.equal(job.context?.purpose, 'champion_chat');
  assert.equal(job.sourceFiles[0]?.sequenceIndex, 0);
  assert.equal(job.candidates[0]?.businessCategory, '销售技巧');
  assert.equal(job.candidates[0]?.category, '销冠对话复盘');
  assert.equal((await service.list(actor.organizationId)).some((entry) => entry.structuredData?.importJobId === job.id), false);
});

test('privacy masking removes phone, wechat and identity numbers', () => {
  const masked = maskSensitive('电话13800138000，微信：sales_2026，身份证110101199001011234');
  assert.doesNotMatch(masked, /13800138000|sales_2026|110101199001011234/);
  assert.match(masked, /手机号\*\*\*|微信号\*\*\*|身份证号\*\*\*/);
});

test('chunked video upload assembles source and enters human review when media parsing fails', async () => {
  const repository = new MemoryRepository();
  const service = new KnowledgeService(repository, new MemoryObjectStorage(), { ...config, knowledgeImportMaxTotalMb: 500 });
  const chunkSize = 1024 * 1024;
  const file = Buffer.alloc(chunkSize + 17, 7);
  let job = await service.initializeChunkedImport(actor, { fileName: '复盘视频.mp4', mimeType: 'video/mp4', totalSize: file.length, chunkSize, totalChunks: 2, context: { purpose: 'sales_video', sourceTitle: '销售课程复盘' } });
  job = await service.uploadImportChunk(actor, job.id, 0, file.subarray(0, chunkSize));
  assert.deepEqual(job.uploadSession?.receivedChunks, [0]);
  job = await service.uploadImportChunk(actor, job.id, 1, file.subarray(chunkSize));
  await service.completeChunkedImport(actor, job.id);
  const completed = await waitForImport(service, job.id);
  assert.equal(completed.sourceFiles[0]?.size, file.length);
  assert.equal(completed.context?.purpose, 'sales_video');
  assert.equal(completed.status, 'waiting_review');
  assert.ok(completed.candidates.length >= 1);
  assert.equal(completed.candidates[0]?.businessCategory, '销售技巧');
});
