import type { AnalysisHistoryItem, AnalysisJob, ConversationReview, CustomerDealStatus, CustomerProfile, CustomerReminderSummary, DashboardMetrics, KnowledgeCandidate, KnowledgeEntry, KnowledgeImportContext, KnowledgeImportJob, ParsedConversation, ProductProfile, ProductProfileDetail, ProductProfileView, ProductStatus, ReviewMetrics, ReviewOutcome, SalesStyleProfile } from '../types/analysis';
import type { AnalysisRequest } from '../types/analysis';

const headers = {};

export function buildApiUrl(path: string, baseUrl = '') {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

const apiBaseUrl = import.meta.env?.VITE_API_BASE_URL ?? '';

function fetch(path: string, init?: RequestInit) {
  return globalThis.fetch(buildApiUrl(path, apiBaseUrl), { credentials: 'include', ...init });
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      window.location.assign('https://www.qycm.top/home2?externalSso=xiaoshou');
    }
    const body = await response.json().catch(() => ({ message: '请求失败' })) as { message?: string };
    throw new Error(body.message ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function exportedFileName(response: Response, fallback: string) {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  return encoded ? decodeURIComponent(encoded) : fallback;
}

function formData(request: AnalysisRequest) {
  const data = new FormData();
  data.set('conversation', request.conversation);
  if (request.product) data.set('product', request.product);
  if (request.customerBackground) data.set('customerBackground', request.customerBackground);
  request.attachmentFiles?.forEach((file) => data.append('images', file, file.name));
  return data;
}

export const analysisApi = {
  create: (request: AnalysisRequest) => fetch('/api/v1/analyses', { method: 'POST', headers, body: formData(request) }).then(parseResponse<AnalysisJob>),
  continue: (id: string, request: AnalysisRequest) => fetch(`/api/v1/analyses/${id}/continue`, { method: 'POST', headers, body: formData(request) }).then(parseResponse<AnalysisJob>),
  get: (id: string) => fetch(`/api/v1/analyses/${id}`, { headers }).then(parseResponse<AnalysisJob>),
  list: () => fetch('/api/v1/analyses?limit=50', { headers }).then(parseResponse<AnalysisHistoryItem[]>),
  confirmTranscript: (id: string, transcript: ParsedConversation) => fetch(`/api/v1/analyses/${id}/confirm-transcript`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript }) }).then(parseResponse<AnalysisJob>),
  clarify: (id: string, answers: Array<{ id: string; answer: string }>) => fetch(`/api/v1/analyses/${id}/clarifications`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) }).then(parseResponse<AnalysisJob>),
  cancel: (id: string) => fetch(`/api/v1/analyses/${id}/cancel`, { method: 'POST', headers }).then(parseResponse<AnalysisJob>),
  retry: (id: string) => fetch(`/api/v1/analyses/${id}/retry`, { method: 'POST', headers }).then(parseResponse<AnalysisJob>),
  feedback: (id: string, outcome: 'adopted' | 'rejected' | 'edited_adopted' | 'saved_review', reason?: string) => fetch(`/api/v1/analyses/${id}/feedback`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome, reason }) }).then(parseResponse<unknown>),
  metrics: () => fetch('/api/v1/metrics', { headers }).then(parseResponse<DashboardMetrics>),
  remove: (id: string) => fetch(`/api/v1/analyses/${id}`, { method: 'DELETE', headers }).then(parseResponse<void>),
};

export const customerApi = {
  list: () => fetch('/api/v1/customers', { headers }).then(parseResponse<CustomerProfile[]>),
  reminderSummary: () => fetch('/api/v1/customers/reminders/summary', { headers }).then(parseResponse<CustomerReminderSummary>),
  updateFollowUp: (id: string, action: 'completed' | 'snooze') => fetch(`/api/v1/customers/${id}/follow-up`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).then(parseResponse<CustomerProfile>),
  setStatus: (id: string, status: CustomerDealStatus) => fetch(`/api/v1/customers/${id}/status`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then(parseResponse<CustomerProfile>),
  setRemark: (id: string, remark: string, analysisId: string) => fetch(`/api/v1/customers/${id}/remark`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ remark, analysisId }) }).then(parseResponse<CustomerProfile>),
};

export const reviewApi = {
  list: () => fetch('/api/v1/reviews', { headers }).then(parseResponse<ConversationReview[]>),
  get: (id: string) => fetch(`/api/v1/reviews/${id}`, { headers }).then(parseResponse<ConversationReview>),
  metrics: () => fetch('/api/v1/reviews/metrics', { headers }).then(parseResponse<ReviewMetrics>),
  confirmOutcome: (id: string, outcome: ReviewOutcome, actualReply?: string) => fetch(`/api/v1/reviews/${id}/outcome`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome, actualReply }) }).then(parseResponse<ConversationReview>),
  saveDiagnosis: (id: string, diagnosis: string[], note?: string) => fetch(`/api/v1/reviews/${id}/diagnosis`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ diagnosis, note }) }).then(parseResponse<ConversationReview>),
  promote: (id: string) => fetch(`/api/v1/reviews/${id}/promote`, { method: 'POST', headers }).then(parseResponse<ConversationReview>),
};

export const productApi = {
  list: (status?: ProductStatus) => fetch(`/api/v1/products${status ? `?status=${status}` : ''}`, { headers }).then(parseResponse<ProductProfileView[]>),
  get: (id: string) => fetch(`/api/v1/products/${id}`, { headers }).then(parseResponse<ProductProfileDetail>),
  create: (input: Pick<ProductProfile, 'name' | 'aliases' | 'positioning' | 'targetCustomers' | 'packages' | 'tags'> & { status?: ProductStatus }) => fetch('/api/v1/products', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(parseResponse<ProductProfileView>),
  update: (id: string, input: Partial<Pick<ProductProfile, 'name' | 'aliases' | 'positioning' | 'targetCustomers' | 'packages' | 'tags' | 'status' | 'cover'>>) => fetch(`/api/v1/products/${id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(parseResponse<ProductProfileView>),
  linkKnowledge: (id: string, entryIds: string[], packageId?: string) => fetch(`/api/v1/products/${id}/link-knowledge`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ entryIds, packageId }) }).then(parseResponse<ProductProfileDetail>),
  uploadMedia: (id: string, file: File) => { const data = new FormData(); data.append('file', file, file.name); return fetch(`/api/v1/products/${id}/media`, { method: 'POST', headers, body: data }).then(parseResponse<ProductProfileDetail>); },
  deleteMedia: (id: string, mediaId: string) => fetch(`/api/v1/products/${id}/media/${mediaId}`, { method: 'DELETE', headers }).then(parseResponse<ProductProfileDetail>),
};

export const knowledgeApi = {
    list: (scope: 'active' | 'trash' = 'active') => fetch(`/api/v1/knowledge?scope=${scope}`, { headers }).then(parseResponse<KnowledgeEntry[]>),
  create: (entry: Pick<KnowledgeEntry, 'layer' | 'category' | 'title' | 'content' | 'version'> & { structuredData?: Record<string, unknown> }) => fetch('/api/v1/knowledge', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }).then(parseResponse<KnowledgeEntry>),
  uploadMedia: (id: string, file: File) => { const data = new FormData(); data.append('file', file, file.name); return fetch(`/api/v1/knowledge/${id}/media`, { method: 'POST', headers, body: data }).then(parseResponse<KnowledgeEntry>); },
  mediaUrl: (id: string, mediaId: string) => buildApiUrl(`/api/v1/knowledge/${id}/media/${mediaId}`, apiBaseUrl),
  importSourceUrl: (importId: string, fileId: string) => buildApiUrl(`/api/v1/knowledge/imports/${importId}/files/${fileId}`, apiBaseUrl),
    update: (id: string, input: Partial<Pick<KnowledgeEntry, 'category' | 'title' | 'content' | 'version' | 'structuredData'>>) => fetch(`/api/v1/knowledge/${id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(parseResponse<KnowledgeEntry>),
    copySystem: (id: string) => fetch(`/api/v1/knowledge/${id}/copy`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeEntry>),
    trash: (ids: string[]) => fetch('/api/v1/knowledge/batch-trash', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(parseResponse<KnowledgeEntry[]>),
    restore: (ids: string[]) => fetch('/api/v1/knowledge/batch-restore', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(parseResponse<KnowledgeEntry[]>),
    purge: (id: string) => fetch(`/api/v1/knowledge/${id}`, { method: 'DELETE', headers }).then(parseResponse<void>),
  upload: (file: File) => { const data = new FormData(); data.append('file', file); return fetch('/api/v1/knowledge/upload', { method: 'POST', headers, body: data }).then(parseResponse<KnowledgeEntry>); },
  createImport: (files: File[], context: KnowledgeImportContext = { purpose: 'auto' }) => { const data = new FormData(); data.set('context', JSON.stringify(context)); files.forEach((file) => data.append('files', file, file.name)); return fetch('/api/v1/knowledge/imports', { method: 'POST', headers, body: data }).then(parseResponse<KnowledgeImportJob>); },
  initializeChunkedImport: (file: File, context: KnowledgeImportContext, chunkSize = 5 * 1024 * 1024) => fetch('/api/v1/knowledge/imports/uploads', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'video/mp4', totalSize: file.size, chunkSize, totalChunks: Math.ceil(file.size / chunkSize), context }) }).then(parseResponse<KnowledgeImportJob>),
  uploadImportChunk: (id: string, index: number, chunk: Blob) => { const data = new FormData(); data.append('chunk', chunk, `chunk-${index}`); return fetch(`/api/v1/knowledge/imports/uploads/${id}/chunks/${index}`, { method: 'POST', headers, body: data }).then(parseResponse<KnowledgeImportJob>); },
  completeChunkedImport: (id: string) => fetch(`/api/v1/knowledge/imports/uploads/${id}/complete`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeImportJob>),
  listImports: () => fetch('/api/v1/knowledge/imports?limit=20', { headers }).then(parseResponse<KnowledgeImportJob[]>),
    getImport: (id: string) => fetch(`/api/v1/knowledge/imports/${id}`, { headers }).then(parseResponse<KnowledgeImportJob>),
    reparseImport: (id: string) => fetch(`/api/v1/knowledge/imports/${id}/reparse`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeImportJob>),
  confirmImport: (id: string, candidates: KnowledgeCandidate[]) => fetch(`/api/v1/knowledge/imports/${id}/confirm`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates }) }).then(parseResponse<KnowledgeImportJob>),
  splitCandidate: (importId: string, candidateId: string) => fetch(`/api/v1/knowledge/imports/${importId}/candidates/${candidateId}/split`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeImportJob>),
  mergeCandidate: (importId: string, targetCandidateId: string, sourceCandidateId: string) => fetch(`/api/v1/knowledge/imports/${importId}/candidates/${targetCandidateId}/merge`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceCandidateId }) }).then(parseResponse<KnowledgeImportJob>),
  discardCandidate: (importId: string, candidateId: string) => fetch(`/api/v1/knowledge/imports/${importId}/candidates/${candidateId}/discard`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeImportJob>),
  exportFile: async (format: 'excel' | 'json' | 'markdown') => {
    const response = await fetch(`/api/v1/knowledge/export?format=${format}`, { headers });
    if (!response.ok) { const body = await response.json().catch(() => ({ message: '导出失败' })) as { message?: string }; throw new Error(body.message ?? `导出失败：${response.status}`); }
    return { fileName: exportedFileName(response, `knowledge-export.${format === 'excel' ? 'xls' : format === 'markdown' ? 'md' : 'json'}`), blob: await response.blob() };
  },
  publish: (id: string) => fetch(`/api/v1/knowledge/${id}/publish`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeEntry>),
  confirmClassification: (id: string, input: Pick<KnowledgeEntry, 'layer' | 'category' | 'title' | 'content' | 'version'>) => fetch(`/api/v1/knowledge/${id}/confirm-classification`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }).then(parseResponse<KnowledgeEntry>),
  archive: (id: string) => fetch(`/api/v1/knowledge/${id}/archive`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(parseResponse<KnowledgeEntry>),
};

export const profileApi = {
  getStyle: () => fetch('/api/v1/profile/style', { headers }).then(parseResponse<SalesStyleProfile>),
  saveStyle: (profile: SalesStyleProfile) => fetch('/api/v1/profile/style', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(profile) }).then(parseResponse<SalesStyleProfile>),
};

export const ANALYSIS_STEPS = ['正在识别对话', '正在判断销售情境', '正在检索规则与资料', '正在生成销管建议', '正在进行事实和合规校验'] as const;

export function progressIndex(job?: AnalysisJob | null) {
  if (!job) return 0;
  return ({ uploaded: 0, parsing: 0, needs_confirmation: 1, classifying: 1, retrieving: 2, generating: 3, validating: 4, completed: 4, blocked: 4, handoff: 4, canceled: 0, failed: 0 } as const)[job.status];
}
