import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import type { AuditRecord, FeedbackRecord, StoredAnalysisJob, StoredKnowledgeImportJob, StoredKnowledgeIndexJob } from '../domain.js';
import { loadConfig } from '../config.js';
import { FileObjectStorage, S3ObjectStorage } from '../infrastructure/objectStorage.js';

interface Snapshot {
  version: 1 | 2 | 3;
  jobs: StoredAnalysisJob[];
  imports: StoredKnowledgeImportJob[];
  knowledgeIndexJobs?: StoredKnowledgeIndexJob[];
  knowledge: KnowledgeEntry[];
  feedback: FeedbackRecord[];
  audits: AuditRecord[];
}

const config = loadConfig();
const dryRun = process.argv.includes('--dry-run');
const dataRoot = resolve(config.localDataDir);
const snapshot = JSON.parse(await readFile(resolve(dataRoot, 'repository.json'), 'utf8')) as Snapshot;
if (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3) throw new Error(`Unsupported local repository version: ${String(snapshot.version)}`);

const storageKeys = new Map<string, string>();
for (const job of snapshot.jobs) for (const attachment of job.attachments) storageKeys.set(attachment.key, attachment.mimeType);
for (const job of snapshot.imports) for (const file of job.sourceFiles) storageKeys.set(file.storageKey, file.mimeType);
for (const entry of snapshot.knowledge) {
  const assets = entry.structuredData?.mediaAssets;
  if (!Array.isArray(assets)) continue;
  for (const asset of assets) if (asset && typeof asset === 'object' && 'storageKey' in asset && 'mimeType' in asset && typeof asset.storageKey === 'string' && typeof asset.mimeType === 'string') storageKeys.set(asset.storageKey, asset.mimeType);
}

console.log(JSON.stringify({ dryRun, jobs: snapshot.jobs.length, imports: snapshot.imports.length, knowledgeIndexJobs: snapshot.knowledgeIndexJobs?.length ?? 0, knowledge: snapshot.knowledge.length, feedback: snapshot.feedback.length, audits: snapshot.audits.length, objects: storageKeys.size }, null, 2));
if (dryRun) process.exit(0);
if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.s3.bucket) throw new Error('S3_BUCKET is required');

const { Pool } = pg;
const pool = new Pool({ connectionString: config.databaseUrl });
const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
await pool.query(schema);
const expiresAt = (createdAt: string) => new Date(new Date(createdAt).getTime() + config.retentionDays * 86_400_000);

for (const job of snapshot.jobs) await pool.query(
  `INSERT INTO analysis_jobs (id, organization_id, created_by, status, progress, progress_label, payload, created_at, updated_at, expires_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, progress=EXCLUDED.progress, progress_label=EXCLUDED.progress_label, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
  [job.id, job.organizationId, job.createdBy, job.status, job.progress, job.progressLabel, job, job.createdAt, job.updatedAt, expiresAt(job.createdAt)],
);
for (const job of snapshot.imports) await pool.query(
  `INSERT INTO knowledge_import_jobs (id, organization_id, created_by, status, progress, progress_label, payload, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
   ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, progress=EXCLUDED.progress, progress_label=EXCLUDED.progress_label, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
  [job.id, job.organizationId, job.createdBy, job.status, job.progress, job.progressLabel, job, job.createdAt, job.updatedAt],
);
for (const job of snapshot.knowledgeIndexJobs ?? []) await pool.query(
  `INSERT INTO knowledge_index_jobs (id, organization_id, entry_id, action, status, attempts, next_attempt_at, payload, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT (id) DO UPDATE SET action=EXCLUDED.action, status=EXCLUDED.status, attempts=EXCLUDED.attempts, next_attempt_at=EXCLUDED.next_attempt_at, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
  [job.id, job.organizationId, job.entryId, job.action, job.status, job.attempts, job.nextAttemptAt, job, job.createdAt, job.updatedAt],
);
for (const entry of snapshot.knowledge) await pool.query(
  `INSERT INTO knowledge_entries (id, organization_id, layer, category, title, status, version, payload, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT (id) DO UPDATE SET layer=EXCLUDED.layer, category=EXCLUDED.category, title=EXCLUDED.title, status=EXCLUDED.status, version=EXCLUDED.version, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
  [entry.id, 'default-org', entry.layer, entry.category, entry.title, entry.status, entry.version, entry, entry.createdAt, entry.updatedAt],
);
for (const record of snapshot.feedback) await pool.query(
  `INSERT INTO analysis_feedback (id, analysis_id, user_id, outcome, reason, edited_reply, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
  [record.id, record.analysisId, record.userId, record.outcome, record.reason, record.editedReply, record.createdAt],
);
for (const record of snapshot.audits) await pool.query(
  `INSERT INTO audit_logs (id, organization_id, user_id, action, target_type, target_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
  [record.id, record.organizationId, record.userId, record.action, record.targetType, record.targetId, record.metadata ?? {}, record.createdAt],
);

const localStorage = new FileObjectStorage(resolve(dataRoot, 'objects'));
const cloudStorage = new S3ObjectStorage(config.s3);
for (const [key, mimeType] of storageKeys) await cloudStorage.put(key, await localStorage.get(key), mimeType);
await pool.end();
console.log('Local data migration completed.');
