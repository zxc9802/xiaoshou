import type { KnowledgeEntry, ProductProfile } from '../../shared/contracts.js';
import type { AuditRecord, FeedbackRecord, Repository, StoredAnalysisJob, StoredConversationReview, StoredKnowledgeImportJob, StoredKnowledgeIndexJob } from '../domain.js';
import { DEFAULT_KNOWLEDGE } from '../knowledge/defaults.js';

export class MemoryRepository implements Repository {
  private readonly jobs = new Map<string, StoredAnalysisJob>();
  private readonly imports = new Map<string, StoredKnowledgeImportJob>();
  private readonly knowledgeIndexJobs = new Map<string, StoredKnowledgeIndexJob>();
  private readonly knowledge = new Map(DEFAULT_KNOWLEDGE.map((entry) => [entry.id, structuredClone(entry)]));
  private readonly products = new Map<string, ProductProfile>();
  private readonly feedback: FeedbackRecord[] = [];
  private readonly reviews = new Map<string, StoredConversationReview>();
  private readonly audits: AuditRecord[] = [];

  async createJob(job: StoredAnalysisJob) { this.jobs.set(job.id, structuredClone(job)); }
  async getJob(id: string) { const job = this.jobs.get(id); return job ? structuredClone(job) : undefined; }
  async updateJob(job: StoredAnalysisJob) { this.jobs.set(job.id, structuredClone(job)); }
  async claimNextJob() {
    const job = [...this.jobs.values()].filter((item) => item.status === 'uploaded').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return undefined;
    job.status = 'parsing'; job.progress = 12; job.progressLabel = '正在识别对话与隐私信息'; job.updatedAt = new Date().toISOString(); this.jobs.set(job.id, job);
    return structuredClone(job);
  }
  async deleteJob(id: string) {
    this.jobs.delete(id);
    for (let index = this.feedback.length - 1; index >= 0; index -= 1) if (this.feedback[index]!.analysisId === id) this.feedback.splice(index, 1);
    const reviewIds = [...this.reviews.values()].filter((review) => review.beforeAnalysisId === id || review.afterAnalysisId === id).map((review) => review.id);
    for (const reviewId of reviewIds) this.reviews.delete(reviewId);
    for (let index = this.audits.length - 1; index >= 0; index -= 1) {
      const audit = this.audits[index]!;
      if ((audit.targetType === 'analysis' && audit.targetId === id) || (audit.targetType === 'review' && reviewIds.includes(audit.targetId))) this.audits.splice(index, 1);
    }
  }
  async listJobs(organizationId: string, limit: number) {
    return [...this.jobs.values()].filter((job) => job.organizationId === organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((job) => structuredClone(job));
  }
  async deleteExpiredJobs(before: Date) {
    const deleted: StoredAnalysisJob[] = [];
    for (const [id, job] of this.jobs) {
      if (new Date(job.createdAt) < before) { deleted.push(job); this.jobs.delete(id); }
    }
    return deleted;
  }
  async addFeedback(record: FeedbackRecord) { this.feedback.push(structuredClone(record)); }
  async listFeedback(_organizationId: string) { return this.feedback.map((record) => structuredClone(record)); }
  async listReviews(organizationId: string) { return [...this.reviews.values()].filter((review) => review.organizationId === organizationId).map((review) => structuredClone(review)); }
  async getReview(organizationId: string, id: string) { const review = this.reviews.get(id); return review?.organizationId === organizationId ? structuredClone(review) : undefined; }
  async upsertReview(review: StoredConversationReview) { this.reviews.set(review.id, structuredClone(review)); }
  async clearCustomerData(organizationId: string) {
    const jobIds = new Set([...this.jobs.values()].filter((job) => job.organizationId === organizationId).map((job) => job.id));
    const reviewIds = [...this.reviews.values()].filter((review) => review.organizationId === organizationId).map((review) => review.id);
    const feedbackCount = this.feedback.filter((record) => jobIds.has(record.analysisId)).length;
    for (const id of jobIds) this.jobs.delete(id);
    for (const id of reviewIds) this.reviews.delete(id);
    for (let index = this.feedback.length - 1; index >= 0; index -= 1) if (jobIds.has(this.feedback[index]!.analysisId)) this.feedback.splice(index, 1);
    for (let index = this.audits.length - 1; index >= 0; index -= 1) if (this.audits[index]!.organizationId === organizationId && ['analysis','customer','review'].includes(this.audits[index]!.targetType)) this.audits.splice(index, 1);
    return { analyses: jobIds.size, reviews: reviewIds.length, feedback: feedbackCount };
  }
  async listKnowledge(_organizationId: string) { return [...this.knowledge.values()].map((entry) => structuredClone(entry)); }
  async getKnowledge(id: string) { const entry = this.knowledge.get(id); return entry ? structuredClone(entry) : undefined; }
  async createKnowledge(_organizationId: string, entry: KnowledgeEntry) { this.knowledge.set(entry.id, structuredClone(entry)); }
  async updateKnowledge(_organizationId: string, entry: KnowledgeEntry) { this.knowledge.set(entry.id, structuredClone(entry)); }
  async deleteKnowledge(_organizationId: string, id: string) { this.knowledge.delete(id); }
  async listProducts(_organizationId: string) { return [...this.products.values()].map((product) => structuredClone(product)); }
  async getProduct(id: string) { const product = this.products.get(id); return product ? structuredClone(product) : undefined; }
  async createProduct(_organizationId: string, product: ProductProfile) { this.products.set(product.id, structuredClone(product)); }
  async updateProduct(_organizationId: string, product: ProductProfile) { this.products.set(product.id, structuredClone(product)); }
  async createKnowledgeImport(job: StoredKnowledgeImportJob) { this.imports.set(job.id, structuredClone(job)); }
  async getKnowledgeImport(id: string) { const job = this.imports.get(id); return job ? structuredClone(job) : undefined; }
  async updateKnowledgeImport(job: StoredKnowledgeImportJob) { this.imports.set(job.id, structuredClone(job)); }
  async listKnowledgeImports(organizationId: string, limit: number, createdBy?: string) {
    return [...this.imports.values()].filter((job) => job.organizationId === organizationId && (!createdBy || job.createdBy === createdBy)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((job) => structuredClone(job));
  }
  async createKnowledgeIndexJob(job: StoredKnowledgeIndexJob) { this.knowledgeIndexJobs.set(job.id, structuredClone(job)); }
  async getKnowledgeIndexJob(id: string) { const job = this.knowledgeIndexJobs.get(id); return job ? structuredClone(job) : undefined; }
  async updateKnowledgeIndexJob(job: StoredKnowledgeIndexJob) { this.knowledgeIndexJobs.set(job.id, structuredClone(job)); }
  async claimNextKnowledgeIndexJob() {
    const now = Date.now();
    const claimable = [...this.knowledgeIndexJobs.values()]
      .filter((job) =>
        (job.status === 'queued' || job.status === 'failed')
        && job.attempts < 5
        && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!claimable) return undefined;
    claimable.status = 'processing';
    claimable.attempts += 1;
    claimable.updatedAt = new Date().toISOString();
    this.knowledgeIndexJobs.set(claimable.id, claimable);
    return structuredClone(claimable);
  }
  async listKnowledgeIndexJobs(organizationId: string, limit: number) {
    return [...this.knowledgeIndexJobs.values()]
      .filter((job) => job.organizationId === organizationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }
  async addAudit(record: AuditRecord) { this.audits.push(structuredClone(record)); }
  async listAudit(organizationId: string, limit: number) { return this.audits.filter((item) => item.organizationId === organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((item) => structuredClone(item)); }
  async metrics(organizationId: string) {
    const jobs = [...this.jobs.values()].filter((job) => job.organizationId === organizationId);
    const tags: Record<string, number> = {};
    for (const job of jobs) if (job.result) tags[`${job.result.deadlockType}:${job.result.intentTemperature}:${job.result.decisionStage}`] = (tags[`${job.result.deadlockType}:${job.result.intentTemperature}:${job.result.decisionStage}`] ?? 0) + 1;
    return { total: jobs.length, completed: jobs.filter((job) => job.status === 'completed').length, handoff: jobs.filter((job) => job.status === 'handoff').length, adopted: this.feedback.filter((item) => item.outcome === 'adopted' || item.outcome === 'edited_adopted').length, rejected: this.feedback.filter((item) => item.outcome === 'rejected').length, tags };
  }
}
