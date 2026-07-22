import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StoredAnalysisJob } from '../domain.js';
import { FileObjectStorage } from './objectStorage.js';
import { FileRepository } from './fileRepository.js';

function analysisJob(): StoredAnalysisJob {
  return {
    id: 'analysis-persistent-1',
    customerProfileId: 'customer-persistent-1',
    organizationId: 'default-org',
    createdBy: 'demo-user',
    attachments: [{ key: 'default-org/demo-user/analysis-persistent-1/chat.png', name: 'chat.png', mimeType: 'image/png', size: 4 }],
    status: 'completed',
    progress: 100,
    progressLabel: '分析完成',
    createdAt: '2026-07-21T08:00:00.000Z',
    updatedAt: '2026-07-21T08:01:00.000Z',
    request: { conversation: '客户：想了解企业AI培训。', attachmentNames: ['chat.png'] },
    clarificationQuestions: [],
    clarificationCount: 0,
  };
}

test('file repository restores analyses after a new repository instance starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sales-agent-repository-'));
  try {
    const filePath = join(directory, 'repository.json');
    const firstInstance = new FileRepository(filePath);
    await firstInstance.createJob(analysisJob());

    const restartedInstance = new FileRepository(filePath);
    const restored = await restartedInstance.getJob('analysis-persistent-1');
    assert.equal(restored?.request.conversation, '客户：想了解企业AI培训。');
    assert.equal((await restartedInstance.listJobs('default-org', 10)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file object storage restores attachments after a new instance starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sales-agent-objects-'));
  try {
    const key = 'default-org/demo-user/analysis-persistent-1/chat.png';
    const firstInstance = new FileObjectStorage(directory);
    await firstInstance.put(key, Buffer.from([1, 2, 3, 4]), 'image/png');

    const restartedInstance = new FileObjectStorage(directory);
    assert.deepEqual(await restartedInstance.get(key), Buffer.from([1, 2, 3, 4]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('knowledge index jobs survive file repository restart and can be claimed once', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'sales-index-jobs-'));
  try {
    const file = join(folder, 'repository.json');
    const now = new Date().toISOString();
    const first = new FileRepository(file);
    await first.createKnowledgeIndexJob({
      id: 'index-job-1',
      organizationId: 'org-a',
      entryId: 'entry-1',
      action: 'upsert',
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    const second = new FileRepository(file);
    const claimed = await second.claimNextKnowledgeIndexJob();
    assert.equal(claimed?.id, 'index-job-1');
    assert.equal(claimed?.status, 'processing');
    assert.equal(claimed?.attempts, 1);
    assert.equal(await second.claimNextKnowledgeIndexJob(), undefined);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
