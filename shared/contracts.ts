export type AnalysisJobStatus =
  | 'uploaded'
  | 'parsing'
  | 'needs_confirmation'
  | 'classifying'
  | 'retrieving'
  | 'generating'
  | 'validating'
  | 'completed'
  | 'blocked'
  | 'handoff'
  | 'canceled'
  | 'failed';

export type DeadlockType = 'objection' | 'silent' | 'vague' | 'stuck';
export type IntentTemperature = 'high' | 'mid' | 'low';
export type DecisionStage = 'aware' | 'comparing' | 'hesitating' | 'closing' | 'lost_risk';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CustomerDealStatus = 'unwon' | 'won';
export interface AnalysisExecutionRecord {
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  outcome: 'running' | 'completed' | 'failed' | 'canceled';
  error?: string;
}

export interface ParsedMessage {
  id: string;
  role: 'sales' | 'customer' | 'unknown';
  text: string;
  timestamp?: string;
  confidence: number;
  sourceAttachment?: string;
}

export interface CustomerIdentity {
  /** Name shown in the chat header or on the customer side. */
  displayName?: string;
  nickname?: string;
  remarkName?: string;
  company?: string;
  /** One-way hashes only. Raw phone/WeChat identifiers are never persisted here. */
  identityHashes: string[];
  avatarSourceAttachment?: string;
  /** Normalized coordinates (0-1) in the source screenshot. */
  avatarBoundingBox?: { x: number; y: number; width: number; height: number };
  confidence: number;
  matchStatus?: 'matched' | 'new' | 'needs_confirmation';
  possibleProfileIds?: string[];
}

export interface ParsedConversation {
  messages: ParsedMessage[];
  lastSpeaker: 'sales' | 'customer' | 'unknown';
  lastMessage: string;
  silenceHint?: string;
  containsSensitiveData: boolean;
  sensitiveDataTypes: string[];
  requiresConfirmation: boolean;
  customerIdentity?: CustomerIdentity;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  answer?: string;
}

export interface ImplicitNeedHypothesis {
  statement: string;
  confidence: number;
  evidence: string;
  validationQuestion: string;
}

export interface AlternativeReply {
  tone: '简洁' | '柔和' | '更有推进感';
  content: string;
}

export interface NextBranch {
  customerReply: string;
  nextAction: string;
  suggestedLine?: string;
}

export interface SourceReference {
  id?: string;
  category: '销售规则' | '销售技巧' | '产品资料' | '价格政策' | '客户案例' | '竞品口径' | '售后承诺' | '禁用红线';
  title: string;
  version: string;
  excerpt: string;
  verified: boolean;
}

export interface SalesAnalysisResult {
  generationMode?: 'ai' | 'rules';
  generationModel?: string;
  parsedConversation: ParsedConversation;
  deadlockType: DeadlockType;
  intentTemperature: IntentTemperature;
  decisionStage: DecisionStage;
  objectionType: string;
  clarificationQuestions: ClarificationQuestion[];
  situationAnalysis: string;
  salesStrategy?: {
    name: string;
    reason: string;
    conversionGoal: string;
    techniques: string[];
  };
  followupAction: string;
  riskLevel: RiskLevel;
  handoffRequired: boolean;
  styleFallbackUsed: boolean;
  fixedDisclaimer: string;
  stage: string;
  stageEvidence: string;
  stageConfidence: number;
  explicitNeeds: string[];
  implicitNeedHypotheses: ImplicitNeedHypothesis[];
  salesLoopIssue: { type: string; problem: string; reason: string };
  replyGoal: string;
  recommendedReply: string;
  alternativeReplies: AlternativeReply[];
  nextBranches: NextBranch[];
  sourceReferences: SourceReference[];
  warnings: string[];
}

export interface AnalysisRequestInput {
  conversation: string;
  product?: string;
  customerBackground?: string;
  attachmentNames: string[];
}

export interface AnalysisJob {
  id: string;
  customerProfileId?: string;
  customerDealStatus?: CustomerDealStatus;
  customerProfileMatchSource?: 'explicit' | 'identity' | 'new';
  customerIdentity?: CustomerIdentity;
  customerManualRemark?: string;
  lastProgressAt?: string;
  nextFollowUpAt?: string;
  executionAttempts?: number;
  executionHistory?: AnalysisExecutionRecord[];
  modelVersion?: string;
  status: AnalysisJobStatus;
  progress: number;
  progressLabel: string;
  createdAt: string;
  updatedAt: string;
  request: AnalysisRequestInput;
  transcript?: ParsedConversation;
  clarificationQuestions: ClarificationQuestion[];
  clarificationCount: number;
  result?: SalesAnalysisResult;
  error?: { code: string; message: string; recoverable: boolean };
}

export interface AnalysisHistoryItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AnalysisJobStatus;
  title: string;
  stage?: string;
  riskLevel?: RiskLevel;
  messageCount: number;
}

export interface CustomerProfile {
  id: string;
  displayName: string;
  nickname?: string;
  remarkName?: string;
  manualRemark?: string;
  avatarUrl?: string;
  identityConfidence?: number;
  company?: string;
  location?: string;
  industry?: string;
  teamSize?: number;
  dealStatus: CustomerDealStatus;
  stage: string;
  stageConfidence?: number;
  intentTemperature?: IntentTemperature;
  summary: string;
  explicitNeeds: string[];
  latestMessage: string;
  latestAnalysisId: string;
  conversationCount: number;
  lastProgressAt: string;
  nextFollowUpAt: string;
  followUpDue: boolean;
  followUpOverdueDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerReminderSummary {
  dueCount: number;
}

export type KnowledgeLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type KnowledgeStatus = 'draft' | 'in_review' | 'published' | 'archived';
export type KnowledgeOrigin = 'system' | 'manual' | 'import';
export type KnowledgeBusinessCategory = '产品资料' | '客户案例' | '竞品口径' | '售后承诺' | '禁用红线' | '销售技巧';
export type KnowledgeImportStatus = 'importing' | 'extracting' | 'analyzing' | 'grouping' | 'waiting_review' | 'published' | 'failed';
export type KnowledgeImportPurpose = 'auto' | 'product_media' | 'customer_case' | 'champion_chat' | 'sales_video' | 'other';
export type KnowledgeSourceFileStatus = 'stored' | 'extracted' | 'failed';
export type KnowledgeCandidateReviewStatus = 'pending' | 'confirmed' | 'discarded';
export type KnowledgeSectionCoverageStatus = 'covered' | 'non_knowledge' | 'failed' | 'pending_confirmation';

export interface KnowledgeDocumentSection {
  id: string;
  sourceFileId: string;
  parentTitle?: string;
  title: string;
  headingLevel: 0 | 1 | 2 | 3;
  content: string;
  location: string;
  characterCount: number;
  coverageStatus: KnowledgeSectionCoverageStatus;
  candidateIds: string[];
}

export interface KnowledgeExtractionRevision {
  id: string;
  revisionNumber: number;
  parentImportId?: string;
  totalSections: number;
  coveredSections: number;
  pendingSections: number;
  failedSections: number;
  coveragePercentage: number;
  createdAt: string;
}

export interface KnowledgeEntry {
  id: string;
  productId?: string;
  packageId?: string;
  origin?: KnowledgeOrigin;
  systemKey?: string;
  locked?: boolean;
  layer: KnowledgeLayer;
  category: string;
  title: string;
  content: string;
  structuredData?: Record<string, unknown>;
  version: string;
  status: KnowledgeStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
  reviewer?: string;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  purgeAt?: string;
  deletedFromStatus?: KnowledgeStatus;
}

export interface KnowledgeCitation {
  sourceFileId: string;
  sourceFileName: string;
  location?: string;
  excerpt: string;
}

export interface KnowledgeMediaAsset {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video';
  storageKey?: string;
  importJobId?: string;
  sourceFileId?: string;
  createdAt: string;
}

export interface KnowledgeSourceFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  status: KnowledgeSourceFileStatus;
  extractionMethod?: string;
  textLength: number;
  warnings: string[];
  sequenceIndex?: number;
  sourceGroupId?: string;
  analysisStatus?: 'pending' | 'processing' | 'completed' | 'needs_review' | 'failed';
  transcript?: string;
  privacyFindings?: string[];
  keyFrames?: Array<{ timestampSeconds: number; label: string }>;
  createdAt: string;
}

export interface KnowledgeImportContext {
  purpose: KnowledgeImportPurpose;
  targetProductId?: string;
  targetPackageId?: string;
  sourceGroupId?: string;
  sourceTitle?: string;
}

export interface KnowledgeConversationMessage {
  role: 'sales' | 'customer' | 'unknown';
  text: string;
  sourceFileId?: string;
  sequenceIndex?: number;
  confidence: number;
}

export interface KnowledgeCandidate {
  id: string;
  layer: Extract<KnowledgeLayer, 'L2' | 'L3'>;
  businessCategory: KnowledgeBusinessCategory;
  category: string;
  title: string;
  summary: string;
  content: string;
  version: string;
  confidence: number;
  citations: KnowledgeCitation[];
  sourceFileIds: string[];
  sourceSectionIds?: string[];
  sectionCoverageStatus?: KnowledgeSectionCoverageStatus;
  suggestedProductName?: string;
  suggestedProductId?: string;
  suggestedPackageName?: string;
  productMatchConfidence?: number;
  conversationMessages?: KnowledgeConversationMessage[];
  timeRange?: { startSeconds: number; endSeconds: number };
  privacyFindings?: string[];
  analysisWarnings?: string[];
  reviewStatus: KnowledgeCandidateReviewStatus;
  createdAt: string;
  updatedAt: string;
}

export type ProductStatus = 'draft' | 'published' | 'archived';

export interface ProductPackage {
  id: string;
  name: string;
  priceDescription?: string;
  applicableConditions?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export interface ProductMediaReference {
  entryId: string;
  mediaId: string;
}

export interface ProductProfile {
  id: string;
  name: string;
  aliases: string[];
  positioning: string;
  targetCustomers: string;
  packages: ProductPackage[];
  tags: string[];
  status: ProductStatus;
  cover?: ProductMediaReference;
  createdAt: string;
  updatedAt: string;
}

export interface ProductProfileView extends ProductProfile {
  knowledgeCount: number;
  mediaCount: number;
  completeness: number;
}

export interface ProductProfileDetail {
  product: ProductProfileView;
  entries: KnowledgeEntry[];
  media: Array<KnowledgeMediaAsset & { entryId: string; url?: string }>;
}

export interface KnowledgeImportJob {
  id: string;
  status: KnowledgeImportStatus;
  progress: number;
  progressLabel: string;
  sourceFiles: KnowledgeSourceFile[];
  candidates: KnowledgeCandidate[];
  publishedEntryIds: string[];
  context?: KnowledgeImportContext;
  transcript?: string;
  conversationMessages?: KnowledgeConversationMessage[];
  privacyFindings?: string[];
  analysisWarnings?: string[];
  derivedKnowledgeIds?: string[];
  uploadSession?: {
    fileName: string;
    mimeType: string;
    totalSize: number;
    chunkSize: number;
    totalChunks: number;
    receivedChunks: number[];
  };
  documentSections?: KnowledgeDocumentSection[];
  coveragePercentage?: number;
  uncoveredSections?: string[];
  parentImportId?: string;
  revisionNumber?: number;
  revision?: KnowledgeExtractionRevision;
  error?: { message: string; recoverable: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface DashboardMetrics {
  totalAnalyses: number;
  completedAnalyses: number;
  adopted: number;
  rejected: number;
  handoffCount: number;
  tagCoverage: Record<string, number>;
  modelFailures?: number;
  knowledgeMisses?: number;
  averageDurationMs?: number;
}

export type ReviewOutcome = 'progressed' | 'unchanged' | 'regressed' | 'won' | 'lost' | 'unknown';
export type ReviewStatus = 'pending' | 'confirmed' | 'archived';
export type ReviewAdoption = 'adopted' | 'edited_adopted' | 'rejected' | 'saved_review' | 'unreported';

export interface ConversationReview {
  id: string;
  customerProfileId: string;
  customerName: string;
  beforeAnalysisId: string;
  afterAnalysisId?: string;
  status: ReviewStatus;
  aiOutcome: ReviewOutcome;
  confirmedOutcome?: ReviewOutcome;
  adoption: ReviewAdoption;
  stageBefore: string;
  stageAfter?: string;
  problem: string;
  strategyName: string;
  strategyReason: string;
  techniques: string[];
  recommendedReply: string;
  actualReply?: string;
  customerResponse?: string;
  product?: string;
  deadlockType: DeadlockType;
  objectionType: string;
  diagnosis: string[];
  note?: string;
  riskLevel: RiskLevel;
  knowledgeGap: boolean;
  knowledgeCandidateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMetrics {
  pendingCount: number;
  effectiveProgressRate: number;
  rescuedCustomers: number;
  adoptionRate: number;
  knowledgeGapCount: number;
  totalReviews: number;
}

export interface SalesStyleProfile {
  customerAddressing: string;
  commonParticles: string[];
  emojis: string[];
  punctuation: '简洁' | '自然' | '正式';
  messageSplitting: '单条' | '分条';
  referenceMessages: string[];
}
