import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeCandidate, KnowledgeEntry } from '../shared/contracts.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { MemoryObjectStorage } from './infrastructure/objectStorage.js';
import { ProductService } from './productService.js';

const actor = { organizationId: 'default-org', userId: 'tester', role: 'admin' };

function knowledge(id: string, title: string, content: string, importJobId: string): KnowledgeEntry {
  const now = new Date().toISOString();
  return { id, origin: 'import', layer: 'L3', category: '产品资料', title, content, version: '1.0', status: 'published', createdAt: now, updatedAt: now, structuredData: { businessCategory: '产品资料', importJobId, mediaAssets: [] } };
}

test('existing fragments from one product become one product profile without losing entries', async () => {
  const repository = new MemoryRepository();
  await repository.createKnowledge(actor.organizationId, knowledge('product-basic', '企业AI训练营产品规格', '产品名称：企业AI训练营；规格：2天线下课；价格：9800元/期。', 'import-a'));
  await repository.createKnowledge(actor.organizationId, knowledge('product-value', '产品价值主张', '帮助管理团队建立可复用的AI工作流程。', 'import-a'));
  await repository.createKnowledge(actor.organizationId, knowledge('customer-note', '客户画像信息', '客户是一家贸易公司。', 'import-a'));
  const service = new ProductService(repository, new MemoryObjectStorage());
  await service.initialize(actor.organizationId);
  const products = await service.list(actor.organizationId);
  assert.equal(products.length, 1);
  assert.equal(products[0]?.name, '企业AI训练营');
  assert.equal(products[0]?.knowledgeCount, 2);
  assert.equal((await repository.getKnowledge('customer-note'))?.productId, undefined);
});

test('product detail supports packages, linked knowledge, media, and archive status', async () => {
  const repository = new MemoryRepository();
  const service = new ProductService(repository, new MemoryObjectStorage());
  const product = await service.create(actor, { name: '2天企业AI培训', aliases: ['AI训练营'], positioning: '帮助企业建立AI落地流程', targetCustomers: '企业老板与管理团队', packages: [{ id: 'enterprise', name: '企业班', priceDescription: '按期报价' }], tags: ['培训'], status: 'published' });
  await repository.createKnowledge(actor.organizationId, knowledge('linked-entry', '课程交付清单', '提供操作手册与流程模板。', 'import-b'));
  await service.linkKnowledge(actor, product.id, ['linked-entry'], 'enterprise');
  const withMedia = await service.addMedia(actor, product.id, { name: 'course.png', mimeType: 'image/png', data: Buffer.from('image') });
  assert.equal(withMedia.product.knowledgeCount, 2);
  assert.equal(withMedia.product.mediaCount, 1);
  assert.equal(withMedia.entries.find((entry) => entry.id === 'linked-entry')?.packageId, 'enterprise');
  const uploadedAsset = withMedia.media[0]!;
  await service.update(actor, product.id, { cover: { entryId: uploadedAsset.entryId, mediaId: uploadedAsset.id } });
  const afterDelete = await service.removeMedia(actor, product.id, uploadedAsset.id);
  assert.equal(afterDelete.product.mediaCount, 0);
  assert.equal(afterDelete.product.cover, undefined);
  assert.equal(afterDelete.product.knowledgeCount, 1);
  const archived = await service.update(actor, product.id, { status: 'archived' });
  assert.equal(archived.status, 'archived');
  assert.equal((await service.list(actor.organizationId, 'published')).length, 0);
});

test('AI candidate only suggests a matching product and never creates one automatically', async () => {
  const repository = new MemoryRepository();
  const service = new ProductService(repository);
  const product = await service.create(actor, { name: '企业AI训练营', aliases: [], positioning: '', targetCustomers: '', packages: [], tags: [], status: 'published' });
  const now = new Date().toISOString();
  const candidate: KnowledgeCandidate = { id: 'candidate', layer: 'L3', businessCategory: '产品资料', category: '产品资料', title: '企业AI训练营课程说明', summary: '说明', content: '企业AI训练营适合管理团队。', version: '1.0', confidence: 0.9, citations: [], sourceFileIds: ['source'], reviewStatus: 'pending', createdAt: now, updatedAt: now, suggestedProductName: '企业AI训练营' };
  const enriched = await service.enrichCandidate(actor.organizationId, candidate);
  assert.equal(enriched.suggestedProductId, product.id);
  assert.equal(enriched.productMatchConfidence, 0.95);
  const unknown = await service.enrichCandidate(actor.organizationId, { ...candidate, suggestedProductName: '不存在的新产品' });
  assert.equal(unknown.suggestedProductId, undefined);
  assert.equal((await service.list(actor.organizationId)).length, 1);
});
