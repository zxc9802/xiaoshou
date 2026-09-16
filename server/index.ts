import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import type { AnalysisRequestInput, KnowledgeCandidate, KnowledgeImportContext, ParsedConversation } from '../shared/contracts.js';
import { AnalysisService } from './analysisService.js';
import { loadConfig } from './config.js';
import { registerCors } from './cors.js';
import type { ObjectStorage, Repository, RequestActor, StoredAnalysisJob } from './domain.js';
import { MemoryRepository } from './infrastructure/memoryRepository.js';
import { FileRepository } from './infrastructure/fileRepository.js';
import { PostgresRepository } from './infrastructure/postgresRepository.js';
import { FileObjectStorage, MemoryObjectStorage, S3ObjectStorage } from './infrastructure/objectStorage.js';
import { QdrantVectorIndex } from './infrastructure/qdrantVectorIndex.js';
import { DisabledVectorIndex, type KnowledgeVectorIndex } from './infrastructure/vectorIndex.js';
import { KnowledgeIndexService } from './knowledgeIndexService.js';
import { KnowledgeService } from './knowledgeService.js';
import { ProductService } from './productService.js';
import { ReviewService } from './reviewService.js';
import { createConversationParser } from './model/conversationParser.js';
import {
  clearSsoSessionCookie,
  createSsoSessionCookie,
  exchangeMainAppSsoTicket,
  getPublicAppUrl,
  getSsoSessionCookieMaxAge,
  readSsoSessionFromRequest,
  requestActor,
  serializeSsoSessionCookie,
  validateMainAppSession,
} from './sso.js';
import { publicRuntimeConfig } from './runtimeConfig.js';

declare module 'fastify' {
  interface FastifyRequest {
    ssoActor?: RequestActor;
  }
}

const config = loadConfig();
const repository: Repository = config.repositoryDriver === 'postgres'
  ? new PostgresRepository(config.databaseUrl ?? (() => { throw new Error('DATABASE_URL is required for postgres'); })(), config.retentionDays)
  : config.repositoryDriver === 'file' ? new FileRepository(`${config.localDataDir}/repository.json`) : new MemoryRepository();
const storage: ObjectStorage = config.objectStorageDriver === 's3'
  ? new S3ObjectStorage(config.s3)
  : config.objectStorageDriver === 'file' ? new FileObjectStorage(`${config.localDataDir}/objects`) : new MemoryObjectStorage();
const parser = createConversationParser(config);
const vectorIndex: KnowledgeVectorIndex = config.qdrantUrl
  ? new QdrantVectorIndex(config)
  : new DisabledVectorIndex();
const knowledgeIndexer = new KnowledgeIndexService(repository, vectorIndex, config);
let qdrantInitializationError: string | undefined;
try {
  await vectorIndex.initialize();
} catch (error) {
  qdrantInitializationError = error instanceof Error ? error.message : 'Qdrant初始化失败';
}
const analyses = new AnalysisService(repository, storage, parser, config, vectorIndex);
const knowledge = new KnowledgeService(repository, storage, config, knowledgeIndexer);
const products = new ProductService(repository, storage);
const reviews = new ReviewService(repository, config.analysisKnowledgeEnabled);

await knowledge.initializeKnowledge('default-org');
await products.initialize('default-org');
await knowledge.purgeExpiredTrash('default-org');
const knowledgePurgeTimer = setInterval(() => void knowledge.purgeExpiredTrash('default-org'), 24 * 60 * 60 * 1000);
knowledgePurgeTimer.unref();
if (config.workerMode === 'inline') {
  const indexTimer = setInterval(() => {
    void knowledgeIndexer.processPending().catch((error) => {
      console.error('Knowledge index retry failed', error instanceof Error ? error.message : error);
    });
  }, 1000);
  indexTimer.unref();
}

const app = Fastify({ logger: true, bodyLimit: Math.max(90, config.knowledgeImportMaxTotalMb + 10) * 1024 * 1024 });
await registerCors(app, config.corsOrigin);
await app.register(multipart, { limits: { files: 50, fileSize: 25 * 1024 * 1024, parts: 80 } });

function actor(request: FastifyRequest) {
  if (!request.ssoActor) throw new Error('请先登录主站后再访问销转智能体');
  return request.ssoActor;
}
function requireAdmin(request: FastifyRequest) { const current = actor(request); if (current.role !== 'admin') throw new Error('该操作需要企业管理员权限'); return current; }
function publicJob(job: StoredAnalysisJob) { const { organizationId: _organizationId, createdBy: _createdBy, attachments: _attachments, customerAvatarKey: _customerAvatarKey, ...safe } = job; return safe; }

async function readAnalysisInput(request: FastifyRequest) {
  const files: Array<{ name: string; mimeType: string; data: Buffer }> = [];
  const fields: Record<string, string> = {};
  if (request.isMultipart()) {
    const hashes = new Set<string>();
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(part.mimetype)) throw new Error('仅支持 png、jpg、jpeg、webp 图片');
        const data = await part.toBuffer(); const hash = createHash('sha256').update(data).digest('hex');
        if (data.length > 8 * 1024 * 1024) throw new Error('单张截图不能超过8MB');
        if (hashes.has(hash)) throw new Error('检测到重复图片，请删除后重试'); hashes.add(hash);
        files.push({ name: part.filename, mimeType: part.mimetype, data });
      } else fields[part.fieldname] = String(part.value ?? '');
    }
  } else Object.assign(fields, request.body as Record<string, string> ?? {});
  const input: AnalysisRequestInput = { conversation: fields.conversation ?? '', product: fields.product || undefined, customerBackground: fields.customerBackground || undefined, attachmentNames: files.map((file) => file.name) };
  if (!input.conversation.trim() && files.length === 0) throw new Error('请粘贴对话或上传聊天截图');
  return { input, files };
}

function isBlockedKnowledgeFile(name: string) {
  return /\.(exe|dll|msi|bat|cmd|com|scr|ps1|sh|vbs|js|jar)$/i.test(name);
}

function mimeFromName(name: string, fallback: string) {
  const extension = extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
  } as Record<string, string>)[extension] ?? fallback;
}

const knowledgeImportContextSchema = z.object({
  purpose: z.enum(['auto', 'product_media', 'customer_case', 'champion_chat', 'sales_video', 'other']).default('auto'),
  targetProductId: z.string().optional(),
  targetPackageId: z.string().optional(),
  sourceGroupId: z.string().optional(),
  sourceTitle: z.string().max(160).optional(),
});

async function readKnowledgeImportRequest(request: FastifyRequest) {
  if (!request.isMultipart()) throw new Error('请上传资料文件');
  const files: Array<{ name: string; mimeType: string; data: Buffer }> = [];
  let context: KnowledgeImportContext = { purpose: 'auto' };
  let totalSize = 0;
  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      if (part.fieldname === 'context') context = knowledgeImportContextSchema.parse(JSON.parse(String(part.value ?? '{}')));
      continue;
    }
    if (isBlockedKnowledgeFile(part.filename)) throw new Error('不支持上传可执行程序或脚本文件');
    const data = await part.toBuffer();
    totalSize += data.length;
    if (totalSize > config.knowledgeImportMaxTotalMb * 1024 * 1024) throw new Error(`单次导入总大小不能超过${config.knowledgeImportMaxTotalMb}MB`);
    const isZip = /\.zip$/i.test(part.filename) || /zip/.test(part.mimetype);
    if (isZip) {
      const archive = unzipSync(new Uint8Array(data));
      for (const [innerName, bytes] of Object.entries(archive)) {
        if (innerName.endsWith('/')) continue;
        if (isBlockedKnowledgeFile(innerName)) throw new Error(`压缩包中包含不支持的文件：${innerName}`);
        const buffer = Buffer.from(bytes);
        totalSize += buffer.length;
        if (totalSize > config.knowledgeImportMaxTotalMb * 1024 * 1024) throw new Error(`单次导入总大小不能超过${config.knowledgeImportMaxTotalMb}MB`);
        files.push({ name: `${part.filename}/${innerName}`, mimeType: mimeFromName(innerName, 'application/octet-stream'), data: buffer });
      }
    } else files.push({ name: part.filename, mimeType: part.mimetype || mimeFromName(part.filename, 'application/octet-stream'), data });
    if (files.length > 50) throw new Error('单次导入最多支持50个文件');
  }
  if (files.length === 0) throw new Error('请上传资料文件');
  if (context.purpose === 'champion_chat' && files.some((file) => !file.mimeType.startsWith('image/'))) throw new Error('销冠聊天资料组只支持图片截图');
  return { files, context };
}

app.get('/api/health', async () => {
  const qdrant = await vectorIndex.health();
  return {
    ok: qdrant.ok || !config.qdrantUrl,
    repository: config.repositoryDriver,
    objectStorage: config.objectStorageDriver,
    model: config.modelDriver,
    embedding: {
      configured: Boolean(config.embeddingModelName && config.modelApiKey),
      model: config.embeddingModelName,
      dimensions: config.embeddingDimensions ?? 1536,
    },
    qdrant: {
      configured: Boolean(config.qdrantUrl),
      ok: qdrant.ok,
      detail: qdrant.ok ? undefined : qdrantInitializationError ?? qdrant.detail,
    },
    workerMode: config.workerMode,
    retentionDays: config.retentionDays,
  };
});

app.get('/api/sso/callback', async (request, reply) => {
  const ticket = String((request.query as { ticket?: string }).ticket ?? '').trim();
  if (!ticket) return reply.code(400).send({ message: 'SSO ticket is required.' });
  try {
    const { redirectPath, session } = await exchangeMainAppSsoTicket(ticket);
    const cookie = createSsoSessionCookie(session);
    return reply
      .header('Set-Cookie', serializeSsoSessionCookie(cookie.value, getSsoSessionCookieMaxAge(session.expiresAt)))
      .redirect(new URL(redirectPath, getPublicAppUrl()).toString());
  } catch {
    return reply.code(401).send({ message: '主站 SSO 换票失败' });
  }
});

app.get('/api/sso/session', async (request, reply) => {
  const session = readSsoSessionFromRequest(request);
  if (session && await validateMainAppSession(session)) return { success: true, data: { user: session.user } };
  return reply.header('Set-Cookie', clearSsoSessionCookie()).code(401).send({ message: '主站登录状态已失效' });
});

app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/v1/')) return;
  const session = readSsoSessionFromRequest(request);
  if (!session || !await validateMainAppSession(session)) {
    return reply.header('Set-Cookie', clearSsoSessionCookie()).code(401).send({ message: '请先登录主站后再访问销转智能体' });
  }
  request.ssoActor = requestActor(session);
});

app.get('/api/v1/runtime-config', async () => publicRuntimeConfig(config));

const productPackageSchema = z.object({ id: z.string().optional(), name: z.string().min(1).max(100), priceDescription: z.string().max(500).optional(), applicableConditions: z.string().max(1000).optional(), effectiveFrom: z.string().optional(), effectiveTo: z.string().optional() }).transform((item) => ({ ...item, id: item.id ?? randomUUID() }));
const productCoverSchema = z.object({ entryId: z.string().min(1), mediaId: z.string().min(1) });
const productInputSchema = z.object({ name: z.string().min(1).max(120), aliases: z.array(z.string().max(120)).max(20).default([]), positioning: z.string().max(2000).default(''), targetCustomers: z.string().max(2000).default(''), packages: z.array(productPackageSchema).max(30).default([]), tags: z.array(z.string().max(40)).max(30).default([]), status: z.enum(['draft', 'published', 'archived']).optional(), cover: productCoverSchema.optional() });
app.get('/api/v1/products', async (request) => { const current = actor(request); const query = request.query as { status?: string }; const status = ['draft', 'published', 'archived'].includes(query.status ?? '') ? query.status as 'draft' | 'published' | 'archived' : undefined; return products.list(current.organizationId, status); });
app.get('/api/v1/products/:id', async (request) => products.getDetail(actor(request).organizationId, (request.params as { id: string }).id));
app.post('/api/v1/products', async (request, reply) => reply.code(201).send(await products.create(requireAdmin(request), productInputSchema.parse(request.body ?? {}))));
app.patch('/api/v1/products/:id', async (request) => products.update(requireAdmin(request), (request.params as { id: string }).id, productInputSchema.partial().parse(request.body ?? {})));
app.post('/api/v1/products/:id/link-knowledge', async (request) => { const body = z.object({ entryIds: z.array(z.string()).min(1).max(200), packageId: z.string().optional() }).parse(request.body ?? {}); return products.linkKnowledge(requireAdmin(request), (request.params as { id: string }).id, body.entryIds, body.packageId); });
app.post('/api/v1/products/:id/media', async (request, reply) => { const current = requireAdmin(request); if (!request.isMultipart()) throw new Error('请上传图片或视频'); const part = await request.file({ limits: { files: 1, fileSize: 25 * 1024 * 1024 } }); if (!part) throw new Error('请上传图片或视频'); if (!part.mimetype.startsWith('image/') && !part.mimetype.startsWith('video/')) throw new Error('媒体素材仅支持图片或视频'); return reply.code(201).send(await products.addMedia(current, (request.params as { id: string }).id, { name: part.filename, mimeType: part.mimetype, data: await part.toBuffer() })); });
app.delete('/api/v1/products/:id/media/:mediaId', async (request) => { const params = request.params as { id: string; mediaId: string }; return products.removeMedia(requireAdmin(request), params.id, params.mediaId); });

app.post('/api/v1/analyses', async (request, reply) => {
  const { input, files } = await readAnalysisInput(request); const current = actor(request);
  const job = await analyses.create(input, files, current); return reply.code(202).send(publicJob(job));
});
app.get('/api/v1/analyses', async (request) => {
  const current = actor(request); const query = request.query as { limit?: string }; const jobs = await analyses.list(current, Number(query.limit ?? 50));
  return jobs.map((job) => ({ id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status, title: job.request.conversation.split('\n').find(Boolean)?.replace(/^(客户|销售|我)[：:]\s*/, '').slice(0, 36) || job.request.attachmentNames[0] || '图片对话分析', stage: job.result?.stage, riskLevel: job.result?.riskLevel, messageCount: job.transcript?.messages.length ?? 0 }));
});
app.get('/api/v1/analyses/:id', async (request, reply) => { const current = actor(request); const job = await analyses.get((request.params as { id: string }).id, current); return job ? publicJob(job) : reply.code(404).send({ message: '分析记录不存在' }); });
app.get('/api/v1/analyses/:id/attachments/:index', async (request, reply) => { const current = actor(request); const params = request.params as { id: string; index: string }; const { attachment, data } = await analyses.getAttachment(params.id, Number(params.index), current); return reply.type(attachment.mimeType).header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`).send(data); });
app.post('/api/v1/analyses/:id/confirm-transcript', async (request) => { const current = actor(request); const body = request.body as { transcript: ParsedConversation }; return publicJob(await analyses.confirmTranscript((request.params as { id: string }).id, body.transcript, current)); });
app.post('/api/v1/analyses/:id/clarifications', async (request) => { const current = actor(request); const schema = z.object({ answers: z.array(z.object({ id: z.string(), answer: z.string().min(1) })).min(1).max(2) }); const body = schema.parse(request.body); return publicJob(await analyses.answerClarifications((request.params as { id: string }).id, body.answers, current)); });
app.post('/api/v1/analyses/:id/continue', async (request, reply) => {
  const current = actor(request); const previous = await analyses.get((request.params as { id: string }).id, current); if (!previous) return reply.code(404).send({ message: '分析记录不存在' });
  const { input, files } = await readAnalysisInput(request);
  const priorConversation = previous.transcript?.messages.length
    ? previous.transcript.messages.map((message) => `${message.role === 'customer' ? '客户' : message.role === 'sales' ? '销售' : '待确认'}：${message.text}`).join('\n')
    : previous.request.conversation;
  input.conversation = [priorConversation, input.conversation].filter(Boolean).join('\n'); input.product ||= previous.request.product; input.attachmentNames = [...new Set([...previous.request.attachmentNames, ...input.attachmentNames])];
  return reply.code(202).send(publicJob(await analyses.create(input, files, current, { profileId: previous.customerProfileId ?? previous.id, dealStatus: previous.customerDealStatus })));
});
app.post('/api/v1/analyses/:id/feedback', async (request) => { const current = actor(request); const schema = z.object({ outcome: z.enum(['adopted', 'rejected', 'edited_adopted', 'saved_review']), reason: z.string().optional(), editedReply: z.string().optional() }); return analyses.addFeedback((request.params as { id: string }).id, schema.parse(request.body), current); });
app.post('/api/v1/analyses/:id/cancel', async (request) => publicJob(await analyses.cancel((request.params as { id: string }).id, actor(request))));
app.post('/api/v1/analyses/:id/retry', async (request) => publicJob(await analyses.retry((request.params as { id: string }).id, actor(request))));
app.delete('/api/v1/analyses/:id', async (request, reply) => { const current = actor(request); await analyses.remove((request.params as { id: string }).id, current); return reply.code(204).send(); });
app.delete('/api/v1/customer-data', async (request) => {
  const current = requireAdmin(request);
  if ((request.query as { confirm?: string }).confirm !== 'DELETE') throw new Error('请确认清空全部客户数据');
  return analyses.clearCustomerData(current);
});

app.get('/api/v1/customers', async (request) => analyses.listCustomerProfiles(actor(request)));
app.get('/api/v1/customers/reminders/summary', async (request) => analyses.customerReminderSummary(actor(request)));
app.patch('/api/v1/customers/:id/follow-up', async (request) => {
  const body = z.object({ action: z.enum(['completed', 'snooze']) }).parse(request.body ?? {});
  return analyses.updateCustomerFollowUp((request.params as { id: string }).id, body.action, actor(request));
});
app.get('/api/v1/customers/:id/avatar', async (request, reply) => {
  const avatar = await analyses.getCustomerAvatar((request.params as { id: string }).id, actor(request));
  return avatar ? reply.type(avatar.mimeType).header('Cache-Control', 'private, max-age=3600').send(avatar.data) : reply.code(404).send({ message: '客户头像不存在' });
});
app.post('/api/v1/customers/:id/refresh-identity', async (request) => analyses.refreshCustomerIdentity((request.params as { id: string }).id, actor(request)));
app.patch('/api/v1/customers/:id/status', async (request) => {
  const schema = z.object({ status: z.enum(['unwon', 'won']) });
  const body = schema.parse(request.body);
  return analyses.setCustomerDealStatus((request.params as { id: string }).id, body.status, actor(request));
});
app.patch('/api/v1/customers/:id/remark', async (request) => {
  const body = z.object({ remark: z.string().trim().min(1).max(40), analysisId: z.string().min(1).optional() }).parse(request.body ?? {});
  return analyses.setCustomerRemark((request.params as { id: string }).id, body.remark, actor(request), body.analysisId);
});
app.get('/api/v1/knowledge', async (request) => {
  const query = z.object({ scope: z.enum(['active', 'trash']).optional() }).parse(request.query ?? {});
  return knowledge.list(actor(request).organizationId, query.scope ?? 'active');
});
app.get('/api/v1/knowledge/export', async (request, reply) => {
  const current = requireAdmin(request); const query = request.query as { format?: string };
  const format = query.format === 'json' || query.format === 'markdown' ? query.format : 'excel';
  const exported = await knowledge.exportKnowledge(current.organizationId, format);
  return reply.type(exported.contentType).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`).send(exported.content);
});
app.get('/api/v1/knowledge/imports', async (request) => { const current = actor(request); const query = request.query as { limit?: string }; return knowledge.listImports(current, Math.min(Number(query.limit ?? 20), 100)); });
app.post('/api/v1/knowledge/imports', async (request, reply) => {
  const current = actor(request);
  const { files, context } = await readKnowledgeImportRequest(request);
  const job = await knowledge.createImport(current, files, context);
  await repository.addAudit({ id: randomUUID(), organizationId: current.organizationId, userId: current.userId, action: 'knowledge.import.create', targetType: 'knowledge_import', targetId: job.id, metadata: { fileCount: files.length, candidateCount: job.candidates.length, status: job.status }, createdAt: new Date().toISOString() });
  return reply.code(202).send(job);
});
app.post('/api/v1/knowledge/imports/uploads', async (request, reply) => {
  const current = actor(request);
  const body = z.object({ fileName: z.string().min(1).max(240), mimeType: z.string().regex(/^video\//), totalSize: z.number().int().positive().max(500 * 1024 * 1024), chunkSize: z.number().int().min(1024 * 1024).max(10 * 1024 * 1024), totalChunks: z.number().int().positive().max(500), context: knowledgeImportContextSchema.optional() }).parse(request.body ?? {});
  return reply.code(201).send(await knowledge.initializeChunkedImport(current, body));
});
app.post('/api/v1/knowledge/imports/uploads/:id/chunks/:index', async (request) => {
  const current = actor(request);
  if (!request.isMultipart()) throw new Error('请上传视频分片');
  const part = await request.file({ limits: { files: 1, fileSize: 10 * 1024 * 1024 } });
  if (!part) throw new Error('视频分片为空');
  const params = request.params as { id: string; index: string };
  return knowledge.uploadImportChunk(current, params.id, Number(params.index), await part.toBuffer());
});
app.post('/api/v1/knowledge/imports/uploads/:id/complete', async (request) => knowledge.completeChunkedImport(actor(request), (request.params as { id: string }).id));
app.get('/api/v1/knowledge/imports/:id', async (request) => knowledge.getImport(actor(request), (request.params as { id: string }).id));
app.post('/api/v1/knowledge/imports/:id/reparse', async (request) => {
  const current = actor(request);
  const job = await knowledge.reparseImport(current, (request.params as { id: string }).id);
  await repository.addAudit({ id: randomUUID(), organizationId: current.organizationId, userId: current.userId, action: 'knowledge.import.reparse', targetType: 'knowledge_import', targetId: job.id, metadata: { parentImportId: job.parentImportId, revisionNumber: job.revisionNumber }, createdAt: new Date().toISOString() });
  return job;
});
app.get('/api/v1/knowledge/imports/:id/files/:fileId', async (request, reply) => {
  const params = request.params as { id: string; fileId: string };
  const { source, data } = await knowledge.getImportSource(actor(request), params.id, params.fileId);
  return reply.type(source.mimeType).header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(source.name)}`).send(data);
});
const candidateSchema: z.ZodType<KnowledgeCandidate> = z.object({
  id: z.string(),
  layer: z.enum(['L2', 'L3']),
  businessCategory: z.enum(['产品资料', '客户案例', '竞品口径', '售后承诺', '禁用红线', '销售技巧']),
  category: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  summary: z.string().max(1000),
  content: z.string().min(1).max(80_000),
  version: z.string().min(1).max(40),
  confidence: z.number().min(0).max(1),
  citations: z.array(z.object({ sourceFileId: z.string(), sourceFileName: z.string(), location: z.string().optional(), excerpt: z.string() })).max(20),
  sourceFileIds: z.array(z.string()).min(1).max(20),
  sourceSectionIds: z.array(z.string()).max(100).optional(),
  sectionCoverageStatus: z.enum(['covered', 'non_knowledge', 'failed', 'pending_confirmation']).optional(),
  suggestedProductName: z.string().max(100).optional(),
  suggestedProductId: z.string().optional(),
  suggestedPackageName: z.string().max(100).optional(),
  productMatchConfidence: z.number().min(0).max(1).optional(),
  conversationMessages: z.array(z.object({ role: z.enum(['sales', 'customer', 'unknown']), text: z.string().max(3000), sourceFileId: z.string().optional(), sequenceIndex: z.number().int().optional(), confidence: z.number().min(0).max(1) })).max(300).optional(),
  timeRange: z.object({ startSeconds: z.number().min(0), endSeconds: z.number().min(0) }).optional(),
  privacyFindings: z.array(z.string().max(80)).max(30).optional(),
  analysisWarnings: z.array(z.string().max(1000)).max(30).optional(),
  reviewStatus: z.enum(['pending', 'confirmed', 'discarded']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
app.post('/api/v1/knowledge/imports/:id/confirm', async (request) => {
  const current = actor(request); const schema = z.object({ candidates: z.array(candidateSchema).optional() });
  const job = await knowledge.confirmImport(current, (request.params as { id: string }).id, schema.parse(request.body ?? {}).candidates);
  await repository.addAudit({ id: randomUUID(), organizationId: current.organizationId, userId: current.userId, action: 'knowledge.import.confirm', targetType: 'knowledge_import', targetId: job.id, metadata: { publishedEntryIds: job.publishedEntryIds, candidateCount: job.candidates.length }, createdAt: new Date().toISOString() });
  return job;
});
app.post('/api/v1/knowledge/imports/:id/candidates/:candidateId/discard', async (request) => {
  const current = actor(request); const params = request.params as { id: string; candidateId: string };
  return knowledge.discardCandidate(current, params.id, params.candidateId);
});
app.post('/api/v1/knowledge/imports/:id/candidates/:candidateId/split', async (request) => {
  const current = actor(request); const params = request.params as { id: string; candidateId: string };
  return knowledge.splitCandidate(current, params.id, params.candidateId);
});
app.post('/api/v1/knowledge/imports/:id/candidates/:candidateId/merge', async (request) => {
  const current = actor(request); const params = request.params as { id: string; candidateId: string };
  const body = z.object({ sourceCandidateId: z.string().min(1) }).parse(request.body ?? {});
  return knowledge.mergeCandidates(current, params.id, params.candidateId, body.sourceCandidateId);
});
app.post('/api/v1/knowledge', async (request, reply) => { const current = actor(request); const schema = z.object({ layer: z.enum(['L2', 'L3', 'L4']), category: z.string().min(1), title: z.string().min(1), content: z.string().min(1), version: z.string().optional(), structuredData: z.record(z.string(), z.unknown()).optional() }); return reply.code(201).send(await knowledge.create(current.organizationId, schema.parse(request.body))); });
app.post('/api/v1/knowledge/:id/copy', async (request, reply) => reply.code(201).send(await knowledge.copySystemEntry(requireAdmin(request), (request.params as { id: string }).id)));
app.post('/api/v1/knowledge/batch-trash', async (request) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body ?? {});
  return knowledge.trashEntries(requireAdmin(request), body.ids);
});
app.post('/api/v1/knowledge/batch-restore', async (request) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body ?? {});
  return knowledge.restoreEntries(requireAdmin(request), body.ids);
});
app.delete('/api/v1/knowledge/:id', async (request, reply) => {
  await knowledge.permanentlyDelete(requireAdmin(request), (request.params as { id: string }).id);
  return reply.code(204).send();
});
app.post('/api/v1/knowledge/:id/media', async (request, reply) => {
  const current = actor(request);
  if (!request.isMultipart()) throw new Error('请上传图片或视频');
  const part = await request.file({ limits: { files: 1, fileSize: 25 * 1024 * 1024 } });
  if (!part) throw new Error('请上传图片或视频');
  if (!part.mimetype.startsWith('image/') && !part.mimetype.startsWith('video/')) throw new Error('媒体素材仅支持图片或视频');
  return reply.code(201).send(await knowledge.addMedia(current, (request.params as { id: string }).id, { name: part.filename, mimeType: part.mimetype, data: await part.toBuffer() }));
});
app.get('/api/v1/knowledge/:id/media/:mediaId', async (request, reply) => {
  const params = request.params as { id: string; mediaId: string };
  const { asset, data } = await knowledge.getMedia(actor(request), params.id, params.mediaId);
  return reply.type(asset.mimeType).header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`).send(data);
});
app.post('/api/v1/knowledge/upload', async (request, reply) => { const current = actor(request); if (!request.isMultipart()) throw new Error('请上传内容文件'); const part = await request.file({ limits: { files: 1, fileSize: 25 * 1024 * 1024 } }); if (!part) throw new Error('请上传内容文件'); if (/\.(exe|dll|msi|bat|cmd|com|scr|ps1)$/i.test(part.filename)) throw new Error('不支持上传可执行程序或脚本文件'); const data = await part.toBuffer(); const entry = await knowledge.upload(current.organizationId, { name: part.filename, mimeType: part.mimetype || 'application/octet-stream', data }); await repository.addAudit({ id: randomUUID(), organizationId: current.organizationId, userId: current.userId, action: 'knowledge.ingest', targetType: 'knowledge', targetId: entry.id, metadata: { fileName: part.filename, suggestedLayer: entry.layer, suggestedCategory: entry.category }, createdAt: new Date().toISOString() }); return reply.code(201).send(entry); });
app.patch('/api/v1/knowledge/:id', async (request) => { const current = actor(request); return knowledge.update(current.organizationId, (request.params as { id: string }).id, request.body as Record<string, unknown>); });
app.post('/api/v1/knowledge/:id/publish', async (request) => { const current = actor(request); return knowledge.setStatus(current.organizationId, (request.params as { id: string }).id, 'published', current.userId); });
app.post('/api/v1/knowledge/:id/archive', async (request) => { const current = actor(request); return knowledge.setStatus(current.organizationId, (request.params as { id: string }).id, 'archived', current.userId); });
app.post('/api/v1/knowledge/:id/confirm-classification', async (request) => { const current = actor(request); const schema = z.object({ layer: z.enum(['L2', 'L3']), category: z.string().min(1).max(80), title: z.string().min(1).max(160), content: z.string().min(1).max(50_000), version: z.string().min(1).max(40) }); const entry = await knowledge.confirmClassification(current.organizationId, (request.params as { id: string }).id, schema.parse(request.body), current.userId); await repository.addAudit({ id: randomUUID(), organizationId: current.organizationId, userId: current.userId, action: 'knowledge.classification.confirm', targetType: 'knowledge', targetId: entry.id, metadata: { layer: entry.layer, category: entry.category, version: entry.version }, createdAt: new Date().toISOString() }); return entry; });
const styleSchema = z.object({ customerAddressing: z.string().max(20), commonParticles: z.array(z.string().max(10)).max(8), emojis: z.array(z.string().max(8)).max(8), punctuation: z.enum(['简洁', '自然', '正式']), messageSplitting: z.enum(['单条', '分条']), referenceMessages: z.array(z.string().max(500)).max(5) });
app.get('/api/v1/profile/style', async (request) => knowledge.getPersonalStyle(actor(request)));
app.put('/api/v1/profile/style', async (request) => { const current = actor(request); const profile = styleSchema.parse(request.body); const entry = await knowledge.savePersonalStyle(current, profile); await repository.addAudit({ id: randomUUID(), organizationId: current.organizationId, userId: current.userId, action: 'profile.style.update', targetType: 'knowledge', targetId: entry.id, createdAt: new Date().toISOString() }); return profile; });
const reviewOutcomeSchema = z.enum(['progressed', 'unchanged', 'regressed', 'won', 'lost', 'unknown']);
app.get('/api/v1/reviews', async (request) => reviews.list(actor(request)));
app.get('/api/v1/reviews/metrics', async (request) => reviews.metrics(actor(request)));
app.get('/api/v1/reviews/:id', async (request) => reviews.get(actor(request), (request.params as { id: string }).id));
app.patch('/api/v1/reviews/:id/outcome', async (request) => { const body = z.object({ outcome: reviewOutcomeSchema, actualReply: z.string().max(4000).optional() }).parse(request.body); return reviews.confirmOutcome(actor(request), (request.params as { id: string }).id, body.outcome, body.actualReply); });
app.patch('/api/v1/reviews/:id/diagnosis', async (request) => { const body = z.object({ diagnosis: z.array(z.string().min(1).max(80)).max(6), note: z.string().max(4000).optional() }).parse(request.body); return reviews.saveDiagnosis(actor(request), (request.params as { id: string }).id, body.diagnosis, body.note); });
app.post('/api/v1/reviews/:id/promote', async (request) => reviews.promote(actor(request), (request.params as { id: string }).id));
app.get('/api/v1/metrics', async (request) => {
  const current = actor(request);
  const [result, jobs] = await Promise.all([repository.metrics(current.organizationId), repository.listJobs(current.organizationId, 10_000)]);
  const finished = jobs.filter((job) => ['completed', 'blocked', 'handoff', 'failed'].includes(job.status));
  const durations = finished.map((job) => new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime()).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    totalAnalyses: result.total,
    completedAnalyses: result.completed,
    adopted: result.adopted,
    rejected: result.rejected,
    handoffCount: result.handoff,
    tagCoverage: result.tags,
    modelFailures: jobs.filter((job) => job.status === 'failed').length,
    knowledgeMisses: jobs.filter((job) => job.result && job.result.sourceReferences.length === 0).length,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
  };
});
app.get('/api/v1/audit-logs', async (request) => { const current = requireAdmin(request); const query = request.query as { limit?: string }; return repository.listAudit(current.organizationId, Math.min(Number(query.limit ?? 100), 500)); });

app.setErrorHandler((error, _request, reply) => { const normalized = error instanceof Error ? error : new Error('服务器处理失败'); app.log.error(normalized); const status = normalized instanceof z.ZodError ? 400 : /请先登录|用户名或密码/.test(normalized.message) ? 401 : /不存在|not found/i.test(normalized.message) ? 404 : /权限/.test(normalized.message) ? 403 : 400; reply.code(status).send({ message: normalized.message, issues: normalized instanceof z.ZodError ? normalized.issues : undefined }); });

setInterval(() => { void analyses.cleanupExpired(); }, 24 * 60 * 60 * 1000).unref();

await app.listen({ port: config.port, host: config.host });
await analyses.recoverPending();
await knowledge.recoverPendingImports();
