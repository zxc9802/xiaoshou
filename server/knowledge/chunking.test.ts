import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { buildKnowledgeChunks, estimateTokens } from './chunking.js';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = '2026-07-22T00:00:00.000Z';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    layer: 'L3',
    category: '价格与版本',
    title: '产品A企业版价格',
    content: '企业版价格为审核价，折扣必须审批，有效期以报价单为准。',
    version: '1.0',
    status: 'published',
    createdAt: now,
    updatedAt: now,
    structuredData: {
      businessCategory: '产品资料',
      sourceReferences: [{ sourceFileName: '产品A报价.docx', location: '价格政策' }],
    },
    ...overrides,
  };
}

test('keeps a short price rule atomic and adds retrieval context', () => {
  const chunks = buildKnowledgeChunks('org-a', entry());
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.embeddingText, /^title: 产品A企业版价格 \| text:/);
  assert.match(chunks[0]!.content, /折扣必须审批/);
});

test('splits a long document only on paragraph boundaries', () => {
  const paragraph = '这是一个完整章节段落，包含产品能力、使用条件和审核说明。'.repeat(20);
  const chunks = buildKnowledgeChunks('org-a', entry({
    content: [paragraph, paragraph, paragraph].join('\n\n'),
  }));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => estimateTokens(chunk.content) <= 1000));
  assert.ok(chunks.every((chunk) => !chunk.content.startsWith('，')));
});

test('preserves chat turns and overlaps exactly two complete turns', () => {
  const messages = Array.from({ length: 20 }, (_, index) =>
    `${index % 2 ? '销售' : '客户'}：第${index + 1}轮完整消息，围绕价格异议继续沟通。`,
  );
  const chunks = buildKnowledgeChunks('org-a', entry({
    layer: 'L2',
    category: '价格异议',
    content: messages.join('\n'),
    structuredData: {
      businessCategory: '销售技巧',
      sourceReferences: [{ sourceFileName: '聊天截图.png', location: '截图 1-4' }],
    },
  }));
  assert.ok(chunks.length >= 2);
  const previousTail = chunks[0]!.content.split('\n').slice(-2);
  const nextHead = chunks[1]!.content.split('\n').slice(0, 2);
  assert.deepEqual(nextHead, previousTail);
});

test('repeats table headers and never splits a row', () => {
  const rows = ['套餐,价格,条件'];
  for (let index = 1; index <= 70; index += 1) rows.push(`套餐${index},${index * 100},需审批`);
  const chunks = buildKnowledgeChunks('org-a', entry({
    content: rows.join('\n'),
    structuredData: {
      businessCategory: '产品资料',
      sourceReferences: [{ sourceFileName: '报价.csv', location: 'Sheet1' }],
    },
  }));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.startsWith('套餐,价格,条件')));
  assert.equal(chunks.flatMap((chunk) => chunk.content.split('\n').slice(1)).length, 70);
});

test('uses stable IDs and preserves video time metadata', () => {
  const input = entry({
    layer: 'L2',
    content: '完整视频章节知识。',
    structuredData: {
      businessCategory: '销售技巧',
      timeRange: { startSeconds: 45, endSeconds: 96 },
      mediaAssets: [{ id: 'video-1', name: '复盘.mp4', mimeType: 'video/mp4', size: 10, kind: 'video', createdAt: '2026-07-22T00:00:00.000Z' }],
    },
  });
  const first = buildKnowledgeChunks('org-a', input)[0]!;
  const second = buildKnowledgeChunks('org-a', input)[0]!;
  assert.equal(first.id, second.id);
  assert.deepEqual(first.timeRange, { startSeconds: 45, endSeconds: 96 });
  assert.equal(first.contentType, 'video');
});

test('does not build chunks for explicit or inferred meta knowledge', () => {
  const explicit = entry({
    structuredData: {
      businessCategory: '产品资料',
      retrievalEligible: false,
    },
  });
  const inferred = entry({
    id: '22222222-2222-4222-8222-222222222222',
    title: '十三、智能体应生成的推荐回复',
    content: '这里是测试题的标准答案。',
  });

  assert.deepEqual(buildKnowledgeChunks('org-a', explicit), []);
  assert.deepEqual(buildKnowledgeChunks('org-a', inferred), []);
});
