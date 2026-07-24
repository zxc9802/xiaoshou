import assert from 'node:assert/strict';
import test from 'node:test';

import type { KnowledgeImportJob } from '../src/types/analysis.js';
import { buildReviewImportOptions } from '../src/components/knowledgeReviewQueue.js';

function importJob(
  id: string,
  status: KnowledgeImportJob['status'],
  fileNames: string[],
  reviewStatuses: Array<'pending' | 'confirmed' | 'discarded'>,
) {
  return {
    id,
    status,
    sourceFiles: fileNames.map((name, index) => ({ id: `${id}-file-${index}`, name })),
    candidates: reviewStatuses.map((reviewStatus, index) => ({ id: `${id}-candidate-${index}`, reviewStatus })),
  } as KnowledgeImportJob;
}

test('lists every pending import batch so the aggregate review count is accessible', () => {
  const options = buildReviewImportOptions([
    importJob('latest', 'waiting_review', ['产品手册.pdf', '价格表.xlsx'], ['pending', 'pending', 'discarded']),
    importJob('published', 'published', ['已发布.docx'], ['confirmed']),
    importJob('older', 'waiting_review', ['客户案例.docx'], ['pending']),
  ]);

  assert.deepEqual(options, [
    { id: 'latest', label: '产品手册.pdf 等 2 个文件 · 2 条待确认' },
    { id: 'older', label: '客户案例.docx · 1 条待确认' },
  ]);
});
