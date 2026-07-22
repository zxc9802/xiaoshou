import type { AnalysisJob, ConversationReview, KnowledgeEntry, KnowledgeImportJob, ProductProfile } from '../shared/contracts.js';

export interface StoredAttachment {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface StoredAnalysisJob extends AnalysisJob {
  organizationId: string;
  createdBy: string;
  attachments: StoredAttachment[];
  customerAvatarKey?: string;
}

export interface StoredKnowledgeImportJob extends KnowledgeImportJob {
  organizationId: string;
  createdBy: string;
}

export interface StoredKnowledgeIndexJob {
  id: string;
  organizationId: string;
  entryId: string;
  action: 'upsert' | 'delete';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackRecord {
  id: string;
  analysisId: string;
  userId: string;
  outcome: 'adopted' | 'rejected' | 'edited_adopted' | 'saved_review';
  reason?: string;
  editedReply?: string;
  createdAt: string;
}

export interface StoredConversationReview extends ConversationReview {
  organizationId: string;
  createdBy: string;
}

export interface AuditRecord {
  id: string;
  organizationId: string;
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RequestActor {
  organizationId: string;
  userId: string;
  role?: string;
}

export interface Repository {
  createJob(job: StoredAnalysisJob): Promise<void>;
  getJob(id: string): Promise<StoredAnalysisJob | undefined>;
  updateJob(job: StoredAnalysisJob): Promise<void>;
  claimNextJob(): Promise<StoredAnalysisJob | undefined>;
  deleteJob(id: string): Promise<void>;
  listJobs(organizationId: string, limit: number): Promise<StoredAnalysisJob[]>;
  deleteExpiredJobs(before: Date): Promise<StoredAnalysisJob[]>;
  addFeedback(record: FeedbackRecord): Promise<void>;
  listFeedback(organizationId: string): Promise<FeedbackRecord[]>;
  listReviews(organizationId: string): Promise<StoredConversationReview[]>;
  getReview(organizationId: string, id: string): Promise<StoredConversationReview | undefined>;
  upsertReview(review: StoredConversationReview): Promise<void>;
  clearCustomerData(organizationId: string): Promise<{ analyses: number; reviews: number; feedback: number }>;
  listKnowledge(organizationId: string): Promise<KnowledgeEntry[]>;
  getKnowledge(id: string): Promise<KnowledgeEntry | undefined>;
  createKnowledge(organizationId: string, entry: KnowledgeEntry): Promise<void>;
  updateKnowledge(organizationId: string, entry: KnowledgeEntry): Promise<void>;
  deleteKnowledge(organizationId: string, id: string): Promise<void>;
  listProducts(organizationId: string): Promise<ProductProfile[]>;
  getProduct(id: string): Promise<ProductProfile | undefined>;
  createProduct(organizationId: string, product: ProductProfile): Promise<void>;
  updateProduct(organizationId: string, product: ProductProfile): Promise<void>;
  createKnowledgeImport(job: StoredKnowledgeImportJob): Promise<void>;
  getKnowledgeImport(id: string): Promise<StoredKnowledgeImportJob | undefined>;
  updateKnowledgeImport(job: StoredKnowledgeImportJob): Promise<void>;
  listKnowledgeImports(organizationId: string, limit: number): Promise<StoredKnowledgeImportJob[]>;
  createKnowledgeIndexJob(job: StoredKnowledgeIndexJob): Promise<void>;
  getKnowledgeIndexJob(id: string): Promise<StoredKnowledgeIndexJob | undefined>;
  updateKnowledgeIndexJob(job: StoredKnowledgeIndexJob): Promise<void>;
  claimNextKnowledgeIndexJob(): Promise<StoredKnowledgeIndexJob | undefined>;
  listKnowledgeIndexJobs(organizationId: string, limit: number): Promise<StoredKnowledgeIndexJob[]>;
  addAudit(record: AuditRecord): Promise<void>;
  listAudit(organizationId: string, limit: number): Promise<AuditRecord[]>;
  metrics(organizationId: string): Promise<{ total: number; completed: number; handoff: number; adopted: number; rejected: number; tags: Record<string, number> }>;
}

export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
