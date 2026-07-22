import { loadEnvFile } from 'node:process';

try { loadEnvFile(); } catch { /* .env is optional for the in-memory local mode. */ }

export interface AppConfig {
  port: number;
  host: string;
  corsOrigin: string;
  retentionDays: number;
  workerMode: 'inline' | 'external';
  repositoryDriver: 'memory' | 'file' | 'postgres';
  localDataDir: string;
  databaseUrl?: string;
  objectStorageDriver: 'memory' | 'file' | 's3';
  modelDriver: 'rule_based' | 'openai_compatible';
  modelApiStyle?: 'openai_chat' | 'gemini_generate_content';
  modelAuthMode?: 'bearer' | 'api_key_header' | 'query';
  modelBaseUrl?: string;
  modelApiKey?: string;
  modelName?: string;
  knowledgeModelName?: string;
  batchModelName?: string;
  embeddingApiStyle?: 'openai' | 'gemini_generate_content';
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModelName?: string;
  embeddingDimensions?: number;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollectionName?: string;
  qdrantCollectionAlias?: string;
  qdrantTimeoutMs?: number;
  knowledgeImportMaxTotalMb: number;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173',
    retentionDays: Number(process.env.RETENTION_DAYS ?? 365),
    workerMode: enumValue(process.env.WORKER_MODE, ['inline', 'external'] as const, 'inline'),
    repositoryDriver: enumValue(process.env.REPOSITORY_DRIVER, ['memory', 'file', 'postgres'] as const, 'file'),
    localDataDir: process.env.LOCAL_DATA_DIR ?? '.data',
    databaseUrl: process.env.DATABASE_URL,
    objectStorageDriver: enumValue(process.env.OBJECT_STORAGE_DRIVER, ['memory', 'file', 's3'] as const, 'file'),
    modelDriver: enumValue(process.env.MODEL_DRIVER, ['rule_based', 'openai_compatible'] as const, 'rule_based'),
    modelApiStyle: enumValue(process.env.MODEL_API_STYLE, ['openai_chat', 'gemini_generate_content'] as const, 'openai_chat'),
    modelAuthMode: enumValue(process.env.MODEL_AUTH_MODE, ['bearer', 'api_key_header', 'query'] as const, process.env.MODEL_API_STYLE === 'gemini_generate_content' ? 'api_key_header' : 'bearer'),
    modelBaseUrl: process.env.MODEL_BASE_URL,
    modelApiKey: process.env.MODEL_API_KEY,
    modelName: process.env.MODEL_NAME,
    knowledgeModelName: process.env.KNOWLEDGE_MODEL_NAME ?? process.env.MODEL_NAME,
    batchModelName: process.env.BATCH_MODEL_NAME ?? process.env.MODEL_NAME,
    embeddingApiStyle: enumValue(process.env.EMBEDDING_API_STYLE, ['openai', 'gemini_generate_content'] as const, 'openai'),
    embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || process.env.MODEL_BASE_URL,
    embeddingApiKey: process.env.EMBEDDING_API_KEY || process.env.MODEL_API_KEY,
    embeddingModelName: process.env.EMBEDDING_MODEL_NAME ?? 'text-embedding-3-small',
    embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
    qdrantUrl: process.env.QDRANT_URL,
    qdrantApiKey: process.env.QDRANT_API_KEY,
    qdrantCollectionName: process.env.QDRANT_COLLECTION_NAME ?? 'sales_knowledge_text_embedding_3_small_1536_v1',
    qdrantCollectionAlias: process.env.QDRANT_COLLECTION_ALIAS ?? 'sales_knowledge_current',
    qdrantTimeoutMs: Number(process.env.QDRANT_TIMEOUT_MS ?? 10_000),
    knowledgeImportMaxTotalMb: Number(process.env.KNOWLEDGE_IMPORT_MAX_TOTAL_MB ?? 500),
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET ?? 'sales-agent-private',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    },
  };
}
