import pg from 'pg';
import type { KnowledgeEntry, ProductProfile } from '../../shared/contracts.js';
import type { AuditRecord, FeedbackRecord, Repository, StoredAnalysisJob, StoredConversationReview, StoredKnowledgeImportJob, StoredKnowledgeIndexJob } from '../domain.js';

const { Pool } = pg;

export class PostgresRepository implements Repository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string, private readonly retentionDays = 365) { this.pool = new Pool({ connectionString }); }

  async createJob(job: StoredAnalysisJob) {
    await this.pool.query('INSERT INTO analysis_jobs (id, organization_id, created_by, status, progress, progress_label, payload, created_at, updated_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [job.id, job.organizationId, job.createdBy, job.status, job.progress, job.progressLabel, job, job.createdAt, job.updatedAt, new Date(Date.now() + this.retentionDays * 86400000)]);
  }
  async getJob(id: string) { const { rows } = await this.pool.query<{ payload: StoredAnalysisJob }>('SELECT payload FROM analysis_jobs WHERE id=$1', [id]); return rows[0]?.payload; }
  async updateJob(job: StoredAnalysisJob) { await this.pool.query('UPDATE analysis_jobs SET status=$2, progress=$3, progress_label=$4, payload=$5, updated_at=$6 WHERE id=$1', [job.id, job.status, job.progress, job.progressLabel, job, job.updatedAt]); }
  async claimNextJob() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ payload: StoredAnalysisJob }>("SELECT payload FROM analysis_jobs WHERE status='uploaded' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
      const job = rows[0]?.payload;
      if (!job) { await client.query('COMMIT'); return undefined; }
      job.status = 'parsing'; job.progress = 12; job.progressLabel = '正在识别对话与隐私信息'; job.updatedAt = new Date().toISOString();
      await client.query('UPDATE analysis_jobs SET status=$2, progress=$3, progress_label=$4, payload=$5, updated_at=$6 WHERE id=$1', [job.id, job.status, job.progress, job.progressLabel, job, job.updatedAt]);
      await client.query('COMMIT'); return job;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async deleteJob(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>("SELECT id FROM conversation_reviews WHERE payload->>'beforeAnalysisId'=$1 OR payload->>'afterAnalysisId'=$1", [id]);
      const reviewIds = rows.map((row) => row.id);
      await client.query("DELETE FROM conversation_reviews WHERE payload->>'beforeAnalysisId'=$1 OR payload->>'afterAnalysisId'=$1", [id]);
      await client.query("DELETE FROM audit_logs WHERE (target_type='analysis' AND target_id=$1) OR (target_type='review' AND target_id=ANY($2::text[]))", [id, reviewIds]);
      await client.query('DELETE FROM analysis_jobs WHERE id=$1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listJobs(organizationId: string, limit: number) { const { rows } = await this.pool.query<{ payload: StoredAnalysisJob }>('SELECT payload FROM analysis_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2', [organizationId, limit]); return rows.map((row) => row.payload); }
  async deleteExpiredJobs(before: Date) {
    const { rows } = await this.pool.query<{ payload: StoredAnalysisJob }>('DELETE FROM analysis_jobs WHERE created_at < $1 RETURNING payload', [before]);
    return rows.map((row) => row.payload);
  }
  async addFeedback(record: FeedbackRecord) { await this.pool.query('INSERT INTO analysis_feedback (id, analysis_id, user_id, outcome, reason, edited_reply, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [record.id, record.analysisId, record.userId, record.outcome, record.reason, record.editedReply, record.createdAt]); }
  async listFeedback(organizationId: string) { const { rows } = await this.pool.query<FeedbackRecord>('SELECT f.id, f.analysis_id AS "analysisId", f.user_id AS "userId", f.outcome, f.reason, f.edited_reply AS "editedReply", f.created_at AS "createdAt" FROM analysis_feedback f JOIN analysis_jobs j ON j.id=f.analysis_id WHERE j.organization_id=$1 ORDER BY f.created_at', [organizationId]); return rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })); }
  async listReviews(organizationId: string) { const { rows } = await this.pool.query<{ payload: StoredConversationReview }>('SELECT payload FROM conversation_reviews WHERE organization_id=$1 ORDER BY updated_at DESC', [organizationId]); return rows.map((row) => row.payload); }
  async getReview(organizationId: string, id: string) { const { rows } = await this.pool.query<{ payload: StoredConversationReview }>('SELECT payload FROM conversation_reviews WHERE organization_id=$1 AND id=$2', [organizationId, id]); return rows[0]?.payload; }
  async upsertReview(review: StoredConversationReview) { await this.pool.query('INSERT INTO conversation_reviews (id, organization_id, created_by, status, outcome, payload, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, outcome=EXCLUDED.outcome, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at', [review.id, review.organizationId, review.createdBy, review.status, review.confirmedOutcome ?? review.aiOutcome, review, review.createdAt, review.updatedAt]); }
  async clearCustomerData(organizationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const analyses = Number((await client.query('SELECT COUNT(*)::int AS count FROM analysis_jobs WHERE organization_id=$1', [organizationId])).rows[0]?.count ?? 0);
      const reviews = Number((await client.query('SELECT COUNT(*)::int AS count FROM conversation_reviews WHERE organization_id=$1', [organizationId])).rows[0]?.count ?? 0);
      const feedback = Number((await client.query('SELECT COUNT(*)::int AS count FROM analysis_feedback f JOIN analysis_jobs j ON j.id=f.analysis_id WHERE j.organization_id=$1', [organizationId])).rows[0]?.count ?? 0);
      await client.query('DELETE FROM conversation_reviews WHERE organization_id=$1', [organizationId]);
      await client.query("DELETE FROM audit_logs WHERE organization_id=$1 AND target_type IN ('analysis','customer','review')", [organizationId]);
      await client.query('DELETE FROM analysis_jobs WHERE organization_id=$1', [organizationId]);
      await client.query('COMMIT');
      return { analyses, reviews, feedback };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async listKnowledge(organizationId: string) { const { rows } = await this.pool.query<{ payload: KnowledgeEntry }>('SELECT payload FROM knowledge_entries WHERE organization_id=$1 OR organization_id IS NULL ORDER BY layer, updated_at DESC', [organizationId]); return rows.map((row) => row.payload); }
  async getKnowledge(id: string) { const { rows } = await this.pool.query<{ payload: KnowledgeEntry }>('SELECT payload FROM knowledge_entries WHERE id=$1', [id]); return rows[0]?.payload; }
  async createKnowledge(organizationId: string, entry: KnowledgeEntry) { await this.pool.query('INSERT INTO knowledge_entries (id, organization_id, layer, category, title, status, version, payload, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [entry.id, organizationId, entry.layer, entry.category, entry.title, entry.status, entry.version, entry, entry.createdAt, entry.updatedAt]); }
  async updateKnowledge(organizationId: string, entry: KnowledgeEntry) { await this.pool.query('UPDATE knowledge_entries SET layer=$3, category=$4, title=$5, status=$6, version=$7, payload=$8, updated_at=$9 WHERE id=$1 AND organization_id=$2', [entry.id, organizationId, entry.layer, entry.category, entry.title, entry.status, entry.version, entry, entry.updatedAt]); }
  async deleteKnowledge(organizationId: string, id: string) { await this.pool.query('DELETE FROM knowledge_entries WHERE id=$1 AND organization_id=$2', [id, organizationId]); }
  async listProducts(organizationId: string) { const { rows } = await this.pool.query<{ payload: ProductProfile }>('SELECT payload FROM product_profiles WHERE organization_id=$1 ORDER BY updated_at DESC', [organizationId]); return rows.map((row) => row.payload); }
  async getProduct(id: string) { const { rows } = await this.pool.query<{ payload: ProductProfile }>('SELECT payload FROM product_profiles WHERE id=$1', [id]); return rows[0]?.payload; }
  async createProduct(organizationId: string, product: ProductProfile) { await this.pool.query('INSERT INTO product_profiles (id, organization_id, name, status, payload, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [product.id, organizationId, product.name, product.status, product, product.createdAt, product.updatedAt]); }
  async updateProduct(organizationId: string, product: ProductProfile) { await this.pool.query('UPDATE product_profiles SET name=$3, status=$4, payload=$5, updated_at=$6 WHERE id=$1 AND organization_id=$2', [product.id, organizationId, product.name, product.status, product, product.updatedAt]); }
  async createKnowledgeImport(job: StoredKnowledgeImportJob) {
    await this.pool.query('INSERT INTO knowledge_import_jobs (id, organization_id, created_by, status, progress, progress_label, payload, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [job.id, job.organizationId, job.createdBy, job.status, job.progress, job.progressLabel, job, job.createdAt, job.updatedAt]);
  }
  async getKnowledgeImport(id: string) {
    const { rows } = await this.pool.query<{ payload: StoredKnowledgeImportJob }>('SELECT payload FROM knowledge_import_jobs WHERE id=$1', [id]);
    return rows[0]?.payload;
  }
  async updateKnowledgeImport(job: StoredKnowledgeImportJob) {
    await this.pool.query('UPDATE knowledge_import_jobs SET status=$2, progress=$3, progress_label=$4, payload=$5, updated_at=$6 WHERE id=$1 AND organization_id=$7', [job.id, job.status, job.progress, job.progressLabel, job, job.updatedAt, job.organizationId]);
  }
  async listKnowledgeImports(organizationId: string, limit: number, createdBy?: string) {
    const { rows } = createdBy
      ? await this.pool.query<{ payload: StoredKnowledgeImportJob }>('SELECT payload FROM knowledge_import_jobs WHERE organization_id=$1 AND created_by=$2 ORDER BY created_at DESC LIMIT $3', [organizationId, createdBy, limit])
      : await this.pool.query<{ payload: StoredKnowledgeImportJob }>('SELECT payload FROM knowledge_import_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2', [organizationId, limit]);
    return rows.map((row) => row.payload);
  }
  async createKnowledgeIndexJob(job: StoredKnowledgeIndexJob) {
    await this.pool.query(
      'INSERT INTO knowledge_index_jobs (id, organization_id, entry_id, action, status, attempts, next_attempt_at, payload, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [job.id, job.organizationId, job.entryId, job.action, job.status, job.attempts, job.nextAttemptAt, job, job.createdAt, job.updatedAt],
    );
  }
  async getKnowledgeIndexJob(id: string) {
    const { rows } = await this.pool.query<{ payload: StoredKnowledgeIndexJob }>('SELECT payload FROM knowledge_index_jobs WHERE id=$1', [id]);
    return rows[0]?.payload;
  }
  async updateKnowledgeIndexJob(job: StoredKnowledgeIndexJob) {
    await this.pool.query(
      'UPDATE knowledge_index_jobs SET action=$3, status=$4, attempts=$5, next_attempt_at=$6, payload=$7, updated_at=$8 WHERE id=$1 AND organization_id=$2',
      [job.id, job.organizationId, job.action, job.status, job.attempts, job.nextAttemptAt, job, job.updatedAt],
    );
  }
  async claimNextKnowledgeIndexJob() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ payload: StoredKnowledgeIndexJob }>(
        `SELECT payload
         FROM knowledge_index_jobs
         WHERE status IN ('queued','failed')
           AND attempts < 5
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const job = rows[0]?.payload;
      if (!job) {
        await client.query('COMMIT');
        return undefined;
      }
      job.status = 'processing';
      job.attempts += 1;
      job.updatedAt = new Date().toISOString();
      await client.query(
        'UPDATE knowledge_index_jobs SET status=$2, attempts=$3, payload=$4, updated_at=$5 WHERE id=$1',
        [job.id, job.status, job.attempts, job, job.updatedAt],
      );
      await client.query('COMMIT');
      return job;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listKnowledgeIndexJobs(organizationId: string, limit: number) {
    const { rows } = await this.pool.query<{ payload: StoredKnowledgeIndexJob }>(
      'SELECT payload FROM knowledge_index_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2',
      [organizationId, limit],
    );
    return rows.map((row) => row.payload);
  }
  async addAudit(record: AuditRecord) { await this.pool.query('INSERT INTO audit_logs (id, organization_id, user_id, action, target_type, target_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [record.id, record.organizationId, record.userId, record.action, record.targetType, record.targetId, record.metadata ?? {}, record.createdAt]); }
  async listAudit(organizationId: string, limit: number) { const { rows } = await this.pool.query<AuditRecord>('SELECT id, organization_id AS "organizationId", user_id AS "userId", action, target_type AS "targetType", target_id AS "targetId", metadata, created_at AS "createdAt" FROM audit_logs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2', [organizationId, limit]); return rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })); }
  async metrics(organizationId: string) {
    const jobs = await this.listJobs(organizationId, 10000);
    const { rows } = await this.pool.query<{ outcome: string; count: string }>('SELECT outcome, COUNT(*)::text AS count FROM analysis_feedback f JOIN analysis_jobs j ON j.id=f.analysis_id WHERE j.organization_id=$1 GROUP BY outcome', [organizationId]);
    const counts = Object.fromEntries(rows.map((row) => [row.outcome, Number(row.count)]));
    const tags: Record<string, number> = {};
    for (const job of jobs) if (job.result) tags[`${job.result.deadlockType}:${job.result.intentTemperature}:${job.result.decisionStage}`] = (tags[`${job.result.deadlockType}:${job.result.intentTemperature}:${job.result.decisionStage}`] ?? 0) + 1;
    return { total: jobs.length, completed: jobs.filter((job) => job.status === 'completed').length, handoff: jobs.filter((job) => job.status === 'handoff').length, adopted: (counts.adopted ?? 0) + (counts.edited_adopted ?? 0), rejected: counts.rejected ?? 0, tags };
  }
}
