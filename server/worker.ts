import { setTimeout as wait } from 'node:timers/promises';
import { AnalysisService } from './analysisService.js';
import { loadConfig } from './config.js';
import type { ObjectStorage, Repository } from './domain.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { MemoryObjectStorage, S3ObjectStorage } from './infrastructure/objectStorage.js';
import { PostgresRepository } from './infrastructure/postgresRepository.js';
import { QdrantVectorIndex } from './infrastructure/qdrantVectorIndex.js';
import { DisabledVectorIndex, type KnowledgeVectorIndex } from './infrastructure/vectorIndex.js';
import { KnowledgeIndexService } from './knowledgeIndexService.js';
import { createConversationParser } from './model/conversationParser.js';

const config = loadConfig();
if (config.workerMode !== 'external') throw new Error('独立 Worker 需要设置 WORKER_MODE=external');
if (config.repositoryDriver !== 'postgres' || config.objectStorageDriver !== 's3') throw new Error('独立 Worker 需要 PostgreSQL 与 S3 兼容对象存储，以便和 API 共享任务与附件');

const repository: Repository = config.repositoryDriver === 'postgres'
  ? new PostgresRepository(config.databaseUrl ?? (() => { throw new Error('DATABASE_URL is required'); })(), config.retentionDays)
  : new MemoryRepository();
const storage: ObjectStorage = config.objectStorageDriver === 's3' ? new S3ObjectStorage(config.s3) : new MemoryObjectStorage();
const vectorIndex: KnowledgeVectorIndex = config.qdrantUrl
  ? new QdrantVectorIndex(config)
  : new DisabledVectorIndex();
const knowledgeIndexer = new KnowledgeIndexService(repository, vectorIndex, config);
try {
  await vectorIndex.initialize();
} catch (error) {
  console.error('Qdrant initialization failed', error instanceof Error ? error.message : error);
}
const service = new AnalysisService(repository, storage, createConversationParser(config), config, vectorIndex);

console.log('Analysis worker started');
while (true) {
  const analysisProcessed = await service.processPending();
  const indexProcessed = await knowledgeIndexer.processPending();
  if (!analysisProcessed && !indexProcessed) await wait(500);
}
