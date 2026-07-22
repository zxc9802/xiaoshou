import type { KnowledgeEntry } from '../../shared/contracts.js';
import { loadConfig } from '../config.js';
import type { Repository } from '../domain.js';
import { FileRepository } from '../infrastructure/fileRepository.js';
import { MemoryRepository } from '../infrastructure/memoryRepository.js';
import { PostgresRepository } from '../infrastructure/postgresRepository.js';
import { QdrantVectorIndex } from '../infrastructure/qdrantVectorIndex.js';
import type { KnowledgeVectorPoint } from '../infrastructure/vectorIndex.js';
import { buildKnowledgeChunks } from '../knowledge/chunking.js';
import { createKnowledgeEmbedding } from '../model/embeddings.js';

interface ReindexSummary {
  organizationId: string;
  entries: number;
  chunks: number;
  estimatedTokens: number;
  indexed: number;
  failed: number;
  aliasSwitchRequested: boolean;
  aliasSwitched: boolean;
}

const config = loadConfig();
const dryRun = process.argv.includes('--dry-run');
const switchAlias = process.argv.includes('--switch-alias');
const organizationId = process.argv.find((argument) => argument.startsWith('--organization='))?.slice('--organization='.length) || 'default-org';
const repository: Repository = config.repositoryDriver === 'postgres'
  ? new PostgresRepository(config.databaseUrl ?? (() => { throw new Error('DATABASE_URL is required for postgres'); })(), config.retentionDays)
  : config.repositoryDriver === 'file'
    ? new FileRepository(`${config.localDataDir}/repository.json`)
    : new MemoryRepository();

const entries = (await repository.listKnowledge(organizationId)).filter((entry) =>
  entry.status === 'published'
  && !entry.deletedAt
  && (entry.layer === 'L2' || entry.layer === 'L3'),
);
const chunksByEntry = new Map(entries.map((entry) => [entry.id, buildKnowledgeChunks(organizationId, entry)]));
const allChunks = [...chunksByEntry.values()].flat();
const summary: ReindexSummary = {
  organizationId,
  entries: entries.length,
  chunks: allChunks.length,
  estimatedTokens: allChunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
  indexed: 0,
  failed: 0,
  aliasSwitchRequested: switchAlias,
  aliasSwitched: false,
};

if (dryRun) {
  console.log(JSON.stringify(summary));
  process.exit(0);
}

if (!config.qdrantUrl) throw new Error('QDRANT_URL is required');
if (!(config.embeddingBaseUrl ?? config.modelBaseUrl)
  || !(config.embeddingApiKey ?? config.modelApiKey)
  || !config.embeddingModelName) {
  throw new Error('Embedding model configuration is required');
}

const vectorIndex = new QdrantVectorIndex(config);
await vectorIndex.initialize();

async function indexEntry(entry: KnowledgeEntry) {
  const chunks = chunksByEntry.get(entry.id) ?? [];
  const points: KnowledgeVectorPoint[] = [];
  for (const chunk of chunks) {
    const embedding = await createKnowledgeEmbedding(chunk.embeddingText, config);
    if (!embedding) throw new Error('向量模型未配置');
    points.push({
      id: chunk.id,
      vector: embedding.vector,
      chunk,
      model: embedding.model,
      modelVersion: embedding.modelVersion,
    });
  }
  await vectorIndex.replaceEntry(organizationId, entry.id, points);
  const latest = await repository.getKnowledge(entry.id);
  if (latest) {
    await repository.updateKnowledge(organizationId, {
      ...latest,
      structuredData: {
        ...latest.structuredData,
        embedding: {
          status: 'indexed',
          model: config.embeddingModelName,
          dimensions: config.embeddingDimensions ?? 1536,
          chunkCount: points.length,
          indexedAt: new Date().toISOString(),
          contentHashes: points.map((point) => point.chunk.contentHash),
        },
      },
      updatedAt: new Date().toISOString(),
    });
  }
}

for (const entry of entries) {
  try {
    await indexEntry(entry);
    summary.indexed += 1;
    console.log(JSON.stringify({ entryId: entry.id, status: 'indexed' }));
  } catch {
    summary.failed += 1;
    console.log(JSON.stringify({ entryId: entry.id, status: 'failed' }));
  }
}

if (switchAlias && summary.failed === 0) {
  await vectorIndex.switchAlias();
  summary.aliasSwitched = true;
}

console.log(JSON.stringify(summary));
if (summary.failed > 0) process.exitCode = 1;
