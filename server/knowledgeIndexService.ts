import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Repository, StoredKnowledgeIndexJob } from './domain.js';
import type { KnowledgeVectorIndex, KnowledgeVectorPoint } from './infrastructure/vectorIndex.js';
import { buildKnowledgeChunks } from './knowledge/chunking.js';
import { createKnowledgeEmbedding, type EmbeddingResult } from './model/embeddings.js';

type EmbeddingFunction = (
  text: string,
  config: AppConfig,
) => Promise<EmbeddingResult | undefined>;

export interface KnowledgeIndexScheduler {
  scheduleUpsert(organizationId: string, entryId: string): Promise<void>;
  scheduleDelete(organizationId: string, entryId: string): Promise<void>;
}

export class KnowledgeIndexService implements KnowledgeIndexScheduler {
  constructor(
    private readonly repository: Repository,
    private readonly vectorIndex: KnowledgeVectorIndex,
    private readonly config: AppConfig,
    private readonly embed: EmbeddingFunction = createKnowledgeEmbedding,
  ) {}

  async scheduleUpsert(organizationId: string, entryId: string) {
    const entry = await this.repository.getKnowledge(entryId);
    if (entry) {
      await this.repository.updateKnowledge(organizationId, {
        ...entry,
        structuredData: {
          ...entry.structuredData,
          embedding: {
            status: 'pending',
            model: this.config.embeddingModelName,
            dimensions: this.config.embeddingDimensions ?? 1536,
          },
        },
        updatedAt: new Date().toISOString(),
      });
    }
    await this.schedule(organizationId, entryId, 'upsert');
  }

  async scheduleDelete(organizationId: string, entryId: string) {
    await this.schedule(organizationId, entryId, 'delete');
  }

  private async schedule(organizationId: string, entryId: string, action: 'upsert' | 'delete') {
    const now = new Date().toISOString();
    const job: StoredKnowledgeIndexJob = {
      id: randomUUID(),
      organizationId,
      entryId,
      action,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createKnowledgeIndexJob(job);
  }

  async processPending() {
    await this.vectorIndex.initialize();
    const job = await this.repository.claimNextKnowledgeIndexJob();
    if (!job) return false;
    await this.processJob(job);
    return true;
  }

  private async processJob(job: StoredKnowledgeIndexJob) {
    try {
      const entry = await this.repository.getKnowledge(job.entryId);
      if (job.action === 'delete' || !entry || entry.status !== 'published'
        || (entry.layer !== 'L2' && entry.layer !== 'L3') || entry.deletedAt) {
        await this.vectorIndex.deleteEntry(job.organizationId, job.entryId);
      } else {
        const chunks = buildKnowledgeChunks(job.organizationId, entry);
        const points: KnowledgeVectorPoint[] = [];
        for (const chunk of chunks) {
          const embedding = await this.embed(chunk.embeddingText, this.config);
          if (!embedding) throw new Error('向量模型未配置');
          points.push({
            id: chunk.id,
            vector: embedding.vector,
            chunk,
            model: embedding.model,
            modelVersion: embedding.modelVersion,
          });
        }
        await this.vectorIndex.replaceEntry(job.organizationId, job.entryId, points);
        const latest = await this.repository.getKnowledge(job.entryId);
        if (latest) {
          await this.repository.updateKnowledge(job.organizationId, {
            ...latest,
            structuredData: {
              ...latest.structuredData,
              embedding: {
                status: 'indexed',
                model: this.config.embeddingModelName,
                dimensions: this.config.embeddingDimensions ?? 1536,
                chunkCount: points.length,
                indexedAt: new Date().toISOString(),
                contentHashes: points.map((point) => point.chunk.contentHash),
              },
            },
            updatedAt: new Date().toISOString(),
          });
        }
      }
      job.status = 'completed';
      job.lastError = undefined;
      job.nextAttemptAt = undefined;
    } catch (error) {
      job.status = 'failed';
      job.lastError = error instanceof Error ? error.message : '未知索引错误';
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
      job.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      const failedEntry = await this.repository.getKnowledge(job.entryId);
      if (failedEntry) {
        await this.repository.updateKnowledge(job.organizationId, {
          ...failedEntry,
          structuredData: {
            ...failedEntry.structuredData,
            embedding: {
              status: 'failed',
              model: this.config.embeddingModelName,
              dimensions: this.config.embeddingDimensions ?? 1536,
              reason: job.lastError,
              attempts: job.attempts,
              lastAttemptAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date().toISOString(),
        });
      }
    }
    job.updatedAt = new Date().toISOString();
    await this.repository.updateKnowledgeIndexJob(job);
  }
}
