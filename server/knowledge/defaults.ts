import type { KnowledgeEntry } from '../../shared/contracts.js';

// 企业资料库不再预置销售策略或回复约束；仅检索企业自行维护的资料。
export const DEFAULT_KNOWLEDGE: KnowledgeEntry[] = [];
export const ACTIVE_SYSTEM_KNOWLEDGE: KnowledgeEntry[] = [];
export const SYSTEM_KNOWLEDGE_TITLES = new Set<string>();
export const RETIRED_SYSTEM_KNOWLEDGE_KEYS = new Set<string>();
