import type { AppConfig } from '../config.js';
import type {
  KnowledgeVectorHit,
  KnowledgeVectorIndex,
  KnowledgeVectorPoint,
} from './vectorIndex.js';

export class QdrantVectorIndex implements KnowledgeVectorIndex {
  private initialized = false;
  private readonly baseUrl: string;
  private readonly collectionName: string;
  private readonly alias: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly dimensions: number;

  constructor(config: AppConfig) {
    if (!config.qdrantUrl) throw new Error('QDRANT_URL is required');
    this.baseUrl = config.qdrantUrl.replace(/\/$/, '');
    this.collectionName = config.qdrantCollectionName ?? 'sales_knowledge_text_embedding_3_small_1536_v1';
    this.alias = config.qdrantCollectionAlias ?? 'sales_knowledge_current';
    this.apiKey = config.qdrantApiKey;
    this.timeoutMs = config.qdrantTimeoutMs ?? 10_000;
    this.dimensions = config.embeddingDimensions ?? 1536;
  }

  private async request<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | undefined> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Qdrant请求失败：${method} ${path} -> ${response.status}`);
    return response.status === 204 ? undefined : await response.json() as T;
  }

  private async currentAliasCollection() {
    const response = await this.request<{
      result?: { aliases?: Array<{ alias_name?: string; collection_name?: string }> };
    }>('GET', '/aliases');
    return response?.result?.aliases?.find((item) => item.alias_name === this.alias)?.collection_name;
  }

  async initialize() {
    if (this.initialized) return;
    const collectionPath = `/collections/${encodeURIComponent(this.collectionName)}`;
    const existing = await this.request('GET', collectionPath, undefined, true);
    if (!existing) {
      await this.request('PUT', collectionPath, {
        vectors: { size: this.dimensions, distance: 'Cosine' },
      });
    } else {
      const collection = existing as {
        result?: { config?: { params?: { vectors?: { size?: number; distance?: string } } } };
      };
      const vectorConfig = collection.result?.config?.params?.vectors;
      if (vectorConfig?.size !== this.dimensions || vectorConfig?.distance !== 'Cosine') {
        throw new Error(`Qdrant collection配置不匹配：期望 ${this.dimensions}/Cosine`);
      }
    }

    const indexes: Array<[string, unknown]> = [
      ['organizationId', { type: 'keyword', is_tenant: true }],
      ['entryId', 'keyword'],
      ['layer', 'keyword'],
      ['status', 'keyword'],
      ['productId', 'keyword'],
      ['packageId', 'keyword'],
      ['businessCategory', 'keyword'],
      ['category', 'keyword'],
      ['contentType', 'keyword'],
      ['effectiveFromEpoch', 'integer'],
      ['effectiveToEpoch', 'integer'],
    ];
    for (const [field_name, field_schema] of indexes) {
      await this.request('PUT', `/collections/${encodeURIComponent(this.collectionName)}/index?wait=true`, {
        field_name,
        field_schema,
      });
    }

    const aliasCollection = await this.currentAliasCollection();
    if (!aliasCollection) {
      await this.request('POST', '/collections/aliases', {
        actions: [{ create_alias: { collection_name: this.collectionName, alias_name: this.alias } }],
      });
    }
    this.initialized = true;
  }

  async replaceEntry(organizationId: string, entryId: string, points: KnowledgeVectorPoint[]) {
    if (points.length) {
      await this.request('PUT', `/collections/${encodeURIComponent(this.collectionName)}/points?wait=true`, {
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: {
            ...point.chunk,
            chunkId: point.chunk.id,
            status: 'published',
            embeddingModel: point.model,
            embeddingModelVersion: point.modelVersion,
            embeddingDimensions: point.vector.length,
            embeddingText: undefined,
          },
        })),
      });
    }
    const must = [
      { key: 'organizationId', match: { value: organizationId } },
      { key: 'entryId', match: { value: entryId } },
    ];
    await this.request('POST', `/collections/${encodeURIComponent(this.collectionName)}/points/delete?wait=true`, {
      filter: points.length
        ? { must, must_not: [{ has_id: points.map((point) => point.id) }] }
        : { must },
    });
  }

  async deleteEntry(organizationId: string, entryId: string) {
    await this.replaceEntry(organizationId, entryId, []);
  }

  async search(input: { organizationId: string; vector: number[]; nowEpoch: number; limit: number }) {
    const response = await this.request<{
      result?: { points?: Array<{ id: string; score: number; payload?: Record<string, unknown> }> };
    }>('POST', `/collections/${encodeURIComponent(this.alias)}/points/query`, {
      query: input.vector,
      filter: {
        must: [
          { key: 'organizationId', match: { value: input.organizationId } },
          { key: 'status', match: { value: 'published' } },
          { key: 'layer', match: { any: ['L2', 'L3'] } },
        ],
        must_not: [
          { key: 'effectiveFromEpoch', range: { gt: input.nowEpoch } },
          { key: 'effectiveToEpoch', range: { lt: input.nowEpoch } },
        ],
      },
      limit: input.limit,
      with_payload: true,
    });
    return (response?.result?.points ?? []).flatMap((point): KnowledgeVectorHit[] => {
      const payload = point.payload ?? {};
      return typeof payload.entryId === 'string' && typeof payload.chunkId === 'string'
        ? [{
            id: String(point.id),
            score: point.score,
            entryId: payload.entryId,
            chunkId: payload.chunkId,
            sequence: Number(payload.sequence ?? 0),
            content: String(payload.content ?? ''),
          }]
        : [];
    });
  }

  async switchAlias() {
    const current = await this.currentAliasCollection();
    if (current === this.collectionName) return;
    await this.request('POST', '/collections/aliases', {
      actions: [
        ...(current ? [{ delete_alias: { alias_name: this.alias } }] : []),
        { create_alias: { collection_name: this.collectionName, alias_name: this.alias } },
      ],
    });
  }

  async health() {
    try {
      await this.request('GET', `/collections/${encodeURIComponent(this.alias)}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Qdrant不可用' };
    }
  }
}
