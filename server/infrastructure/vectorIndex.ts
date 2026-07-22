import type { KnowledgeChunk } from '../knowledge/chunking.js';

export interface KnowledgeVectorPoint {
  id: string;
  vector: number[];
  chunk: KnowledgeChunk;
  model: string;
  modelVersion?: string;
}

export interface KnowledgeVectorHit {
  id: string;
  score: number;
  entryId: string;
  chunkId: string;
  sequence: number;
  content: string;
}

export interface KnowledgeVectorIndex {
  initialize(): Promise<void>;
  replaceEntry(organizationId: string, entryId: string, points: KnowledgeVectorPoint[]): Promise<void>;
  deleteEntry(organizationId: string, entryId: string): Promise<void>;
  search(input: {
    organizationId: string;
    vector: number[];
    nowEpoch: number;
    limit: number;
  }): Promise<KnowledgeVectorHit[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class DisabledVectorIndex implements KnowledgeVectorIndex {
  async initialize() {}
  async replaceEntry() {}
  async deleteEntry() {}
  async search() { return []; }
  async health() { return { ok: false, detail: 'Qdrant未配置' }; }
}
