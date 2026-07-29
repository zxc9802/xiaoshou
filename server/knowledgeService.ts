import { randomUUID } from 'node:crypto';
import { runWithMainAppBillingUser } from './mainAppBilling.js';
import type { KnowledgeCandidate, KnowledgeEntry, KnowledgeImportContext, KnowledgeImportJob, KnowledgeLayer, KnowledgeMediaAsset, KnowledgeStatus, KnowledgeSourceFile, SalesStyleProfile } from '../shared/contracts.js';
import type { ObjectStorage, Repository, RequestActor, StoredKnowledgeImportJob } from './domain.js';
import type { AppConfig } from './config.js';
import { analyzeKnowledgeFile } from './knowledge/contentAnalyzer.js';
import { analyzeChampionChat } from './knowledge/mediaAnalyzer.js';
import { buildKnowledgeCandidates, mergeCandidates, splitCandidate } from './knowledge/importBuilder.js';
import type { KnowledgeIndexScheduler } from './knowledgeIndexService.js';
import { ProductService } from './productService.js';

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function publicImport(job: StoredKnowledgeImportJob): KnowledgeImportJob {
  const { organizationId: _organizationId, createdBy: _createdBy, ...safe } = job;
  return safe;
}

function isSystemLocked(entry: KnowledgeEntry) {
  return entry.origin === 'system' || entry.locked === true;
}

const noIndexScheduler: KnowledgeIndexScheduler = {
  async scheduleUpsert() {},
  async scheduleDelete() {},
};

export class KnowledgeService {
  private readonly processingImports = new Set<string>();
  private readonly products: ProductService;
  constructor(
    private readonly repository: Repository,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfig,
    private readonly indexScheduler: KnowledgeIndexScheduler = noIndexScheduler,
  ) { this.products = new ProductService(repository); }
  async initializeKnowledge(organizationId = 'default-org') {
    const existing = await this.repository.listKnowledge(organizationId);
    for (const entry of existing) {
      if (isSystemLocked(entry)) {
        await this.repository.deleteKnowledge(organizationId, entry.id);
        if (entry.layer === 'L2' || entry.layer === 'L3') await this.indexScheduler.scheduleDelete(organizationId, entry.id);
      }
    }
  }

  async list(organizationId: string, scope: 'active' | 'trash' = 'active') {
    const entries = await this.repository.listKnowledge(organizationId);
    return entries.filter((entry) => !entry.structuredData?.demoDisabled && (scope === 'trash' ? Boolean(entry.deletedAt) : !entry.deletedAt));
  }
  async create(organizationId: string, input: { layer: KnowledgeLayer; category: string; title: string; content: string; version?: string; structuredData?: Record<string, unknown> }) {
    if (input.layer === 'L0' || input.layer === 'L1') throw new Error('L0/L1由系统锁定，不允许用户创建');
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = { id: randomUUID(), origin: 'manual', locked: false, ...input, version: input.version ?? '1.0', status: 'draft', createdAt: now, updatedAt: now };
    await this.repository.createKnowledge(organizationId, entry); return entry;
  }
  async upload(organizationId: string, file: { name: string; mimeType: string; data: Buffer }) {
    const id = randomUUID(); const now = new Date().toISOString(); const key = `${organizationId}/knowledge/${id}/${safeFileName(file.name)}`;
    await this.storage.put(key, file.data, file.mimeType);
    const analysis = await analyzeKnowledgeFile(file, this.config);
    const entry: KnowledgeEntry = { id, origin: 'import', locked: false, layer: analysis.suggestedLayer, category: analysis.suggestedCategory, title: analysis.suggestedTitle, content: analysis.normalizedContent || analysis.summary, structuredData: { storageKey: key, sourceFileName: file.name, mimeType: file.mimeType, size: file.data.length, ingestionStatus: 'analyzed', requiresHumanConfirmation: true, analysisSummary: analysis.summary, classificationConfidence: analysis.confidence, extractionMethod: analysis.extractionMethod, analysisWarnings: analysis.warnings }, version: '1.0', status: 'in_review', createdAt: now, updatedAt: now };
    await this.repository.createKnowledge(organizationId, entry); return entry;
  }

  async createImport(actor: RequestActor, files: Array<{ name: string; mimeType: string; data: Buffer }>, context: KnowledgeImportContext = { purpose: 'auto' }) {
    if (files.length === 0) throw new Error('请至少选择一个资料文件');
    const totalSize = files.reduce((sum, file) => sum + file.data.length, 0);
    if (totalSize > this.config.knowledgeImportMaxTotalMb * 1024 * 1024) throw new Error(`单次导入总大小不能超过 ${this.config.knowledgeImportMaxTotalMb}MB`);
    const now = new Date().toISOString();
    const job: StoredKnowledgeImportJob = {
      id: randomUUID(), organizationId: actor.organizationId, createdBy: actor.userId,
      status: 'importing', progress: 8, progressLabel: '正在保存资料包', sourceFiles: [], candidates: [], publishedEntryIds: [],
      context,
      documentSections: [], coveragePercentage: 0, uncoveredSections: [], revisionNumber: 1,
      revision: { id: randomUUID(), revisionNumber: 1, totalSections: 0, coveredSections: 0, pendingSections: 0, failedSections: 0, coveragePercentage: 0, createdAt: now },
      createdAt: now, updatedAt: now,
    };
    await this.repository.createKnowledgeImport(job);
    try {
      for (let index = 0; index < files.length; index += 1) {
        job.sourceFiles.push(await this.ingestSourceFile(job, files[index]!, index));
        await this.repository.updateKnowledgeImport(job);
      }
      job.status = 'extracting'; job.progress = 15; job.progressLabel = '正在提取文档章节'; job.updatedAt = new Date().toISOString();
      await this.repository.updateKnowledgeImport(job);
      void this.processImport(job.id);
      return publicImport(job);
    } catch (error) {
      job.status = 'failed'; job.progressLabel = '资料导入失败'; job.error = { message: error instanceof Error ? error.message : '未知错误', recoverable: true }; job.updatedAt = new Date().toISOString();
      await this.repository.updateKnowledgeImport(job);
      return publicImport(job);
    }
  }

  async initializeChunkedImport(actor: RequestActor, input: { fileName: string; mimeType: string; totalSize: number; chunkSize: number; totalChunks: number; context?: KnowledgeImportContext }) {
    if (!input.mimeType.startsWith('video/')) throw new Error('分片上传当前仅用于视频资料');
    if (input.totalSize <= 0 || input.totalSize > 500 * 1024 * 1024) throw new Error('视频文件不能超过500MB');
    if (input.chunkSize < 1024 * 1024 || input.chunkSize > 10 * 1024 * 1024) throw new Error('分片大小应为1MB至10MB');
    if (input.totalChunks !== Math.ceil(input.totalSize / input.chunkSize)) throw new Error('视频分片数量不正确');
    const now = new Date().toISOString();
    const job: StoredKnowledgeImportJob = {
      id: randomUUID(), organizationId: actor.organizationId, createdBy: actor.userId,
      status: 'importing', progress: 1, progressLabel: '等待上传视频分片', sourceFiles: [], candidates: [], publishedEntryIds: [],
      context: input.context ?? { purpose: 'sales_video' },
      uploadSession: { fileName: input.fileName, mimeType: input.mimeType, totalSize: input.totalSize, chunkSize: input.chunkSize, totalChunks: input.totalChunks, receivedChunks: [] },
      documentSections: [], coveragePercentage: 0, uncoveredSections: [], revisionNumber: 1,
      revision: { id: randomUUID(), revisionNumber: 1, totalSections: 0, coveredSections: 0, pendingSections: 0, failedSections: 0, coveragePercentage: 0, createdAt: now },
      createdAt: now, updatedAt: now,
    };
    await this.repository.createKnowledgeImport(job);
    return publicImport(job);
  }

  async uploadImportChunk(actor: RequestActor, importId: string, index: number, data: Buffer) {
    const job = await this.requireImport(actor, importId);
    const session = job.uploadSession;
    if (!session || job.status !== 'importing') throw new Error('该任务不能继续上传分片');
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) throw new Error('分片序号不正确');
    const expected = index === session.totalChunks - 1 ? session.totalSize - session.chunkSize * index : session.chunkSize;
    if (data.length !== expected) throw new Error('分片大小与上传任务不一致');
    await this.storage.put(`${job.organizationId}/knowledge-imports/${job.id}/chunks/${index}`, data, 'application/octet-stream');
    session.receivedChunks = [...new Set([...session.receivedChunks, index])].sort((a, b) => a - b);
    job.progress = Math.max(2, Math.round((session.receivedChunks.length / session.totalChunks) * 12));
    job.progressLabel = `正在上传视频 ${session.receivedChunks.length}/${session.totalChunks} 片`;
    job.updatedAt = new Date().toISOString();
    await this.repository.updateKnowledgeImport(job);
    return publicImport(job);
  }

  async completeChunkedImport(actor: RequestActor, importId: string) {
    const job = await this.requireImport(actor, importId);
    const session = job.uploadSession;
    if (!session || session.receivedChunks.length !== session.totalChunks) throw new Error('视频分片尚未上传完整');
    const chunks: Buffer[] = [];
    for (let index = 0; index < session.totalChunks; index += 1) chunks.push(await this.storage.get(`${job.organizationId}/knowledge-imports/${job.id}/chunks/${index}`));
    const data = Buffer.concat(chunks);
    if (data.length !== session.totalSize) throw new Error('视频合并后的大小校验失败');
    job.sourceFiles.push(await this.ingestSourceFile(job, { name: session.fileName, mimeType: session.mimeType, data }, 0));
    for (let index = 0; index < session.totalChunks; index += 1) await this.storage.delete(`${job.organizationId}/knowledge-imports/${job.id}/chunks/${index}`);
    job.status = 'extracting'; job.progress = 15; job.progressLabel = '视频上传完成，正在提取音频和关键画面'; job.updatedAt = new Date().toISOString();
    await this.repository.updateKnowledgeImport(job);
    void this.processImport(job.id);
    return publicImport(job);
  }

  private async createImportLegacy(actor: RequestActor, files: Array<{ name: string; mimeType: string; data: Buffer }>) {
    if (files.length === 0) throw new Error('请至少选择一个资料文件');
    const totalSize = files.reduce((sum, file) => sum + file.data.length, 0);
    if (totalSize > this.config.knowledgeImportMaxTotalMb * 1024 * 1024) throw new Error(`单次导入总大小不能超过${this.config.knowledgeImportMaxTotalMb}MB`);
    const now = new Date().toISOString();
    const job: StoredKnowledgeImportJob = { id: randomUUID(), organizationId: actor.organizationId, createdBy: actor.userId, status: 'importing', progress: 8, progressLabel: '正在保存资料包', sourceFiles: [], candidates: [], publishedEntryIds: [], createdAt: now, updatedAt: now };
    await this.repository.createKnowledgeImport(job);
    try {
      job.status = 'extracting'; job.progress = 24; job.progressLabel = '正在提取文件正文'; job.updatedAt = new Date().toISOString(); await this.repository.updateKnowledgeImport(job);
      for (const file of files) {
        const sourceFile = await this.ingestSourceFile(job, file);
        job.sourceFiles.push(sourceFile);
        await this.repository.updateKnowledgeImport(job);
      }
      job.status = 'analyzing'; job.progress = 58; job.progressLabel = '正在分析资料类型与业务分类'; job.updatedAt = new Date().toISOString(); await this.repository.updateKnowledgeImport(job);
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const sourceFile = job.sourceFiles[index];
        if (!file || !sourceFile || sourceFile.status === 'failed') continue;
        const analysis = await runWithMainAppBillingUser(
          job.createdBy,
          () => analyzeKnowledgeFile(file, this.config),
        );
        sourceFile.status = 'extracted'; sourceFile.extractionMethod = analysis.extractionMethod; sourceFile.textLength = (analysis.normalizedContent || analysis.summary).length; sourceFile.warnings = analysis.warnings; sourceFile.createdAt ||= new Date().toISOString();
        job.candidates.push(...buildKnowledgeCandidates(sourceFile, analysis));
        await this.repository.updateKnowledgeImport(job);
      }
      job.status = 'grouping'; job.progress = 82; job.progressLabel = '正在整理候选条目'; job.updatedAt = new Date().toISOString(); await this.repository.updateKnowledgeImport(job);
      job.status = 'waiting_review'; job.progress = 100; job.progressLabel = job.candidates.length ? '等待人工审核归类' : '未提取到可发布条目，请人工补充'; job.updatedAt = new Date().toISOString();
      await this.repository.updateKnowledgeImport(job);
      return publicImport(job);
    } catch (error) {
      job.status = 'failed'; job.progressLabel = '资料导入失败'; job.error = { message: error instanceof Error ? error.message : '未知错误', recoverable: true }; job.updatedAt = new Date().toISOString();
      await this.repository.updateKnowledgeImport(job);
      return publicImport(job);
    }
  }

  private async processImport(importId: string) {
    if (this.processingImports.has(importId)) return;
    this.processingImports.add(importId);
    try {
      const job = await this.repository.getKnowledgeImport(importId);
      if (!job || job.status === 'published') return;
      job.candidates = []; job.documentSections = []; job.uncoveredSections = []; job.error = undefined;
      job.status = 'analyzing'; job.progress = 20; job.progressLabel = '正在分析文档结构';
      await this.repository.updateKnowledgeImport(job);
      if (job.context?.purpose === 'champion_chat') {
        const ordered = [...job.sourceFiles].sort((a, b) => Number(a.sequenceIndex ?? 0) - Number(b.sequenceIndex ?? 0));
        const sources = await Promise.all(ordered.map(async (source) => ({ source, data: await this.storage.get(source.storageKey) })));
        for (const source of ordered) source.analysisStatus = 'processing';
        job.progress = 45; job.progressLabel = '正在识别销冠对话、角色与隐私信息'; await this.repository.updateKnowledgeImport(job);
        const result = await runWithMainAppBillingUser(
          job.createdBy,
          () => analyzeChampionChat(sources, this.config, job.context!),
        );
        job.candidates = result.candidates;
        job.documentSections = result.sections;
        job.transcript = result.transcript;
        job.conversationMessages = result.messages;
        job.privacyFindings = result.privacyFindings;
        job.analysisWarnings = result.warnings;
        for (const source of ordered) {
          source.status = 'extracted'; source.analysisStatus = result.messages.length ? 'completed' : 'needs_review';
          source.transcript = result.messages.filter((message) => message.sourceFileId === source.id).map((message) => message.text).join('\n');
          source.privacyFindings = result.privacyFindings; source.warnings = result.warnings;
        }
      } else {
      for (let fileIndex = 0; fileIndex < job.sourceFiles.length; fileIndex += 1) {
        const sourceFile = job.sourceFiles[fileIndex]!;
        try {
          const data = await this.storage.get(sourceFile.storageKey);
          const analysis = await runWithMainAppBillingUser(
            job.createdBy,
            () => analyzeKnowledgeFile({ name: sourceFile.name, mimeType: sourceFile.mimeType, data }, this.config, {
              sourceFileId: sourceFile.id,
              context: job.context,
              onProgress: async (current, total, label) => {
                const completedFiles = fileIndex / Math.max(1, job.sourceFiles.length);
                const currentFile = (current / Math.max(1, total)) / Math.max(1, job.sourceFiles.length);
                job.progress = Math.min(88, Math.round(20 + (completedFiles + currentFile) * 68));
                job.progressLabel = label; job.updatedAt = new Date().toISOString();
                await this.repository.updateKnowledgeImport(job);
              },
            }),
          );
          sourceFile.status = 'extracted'; sourceFile.analysisStatus = analysis.warnings.length ? 'needs_review' : 'completed'; sourceFile.extractionMethod = analysis.extractionMethod;
          sourceFile.transcript = analysis.transcript;
          sourceFile.keyFrames = analysis.keyFrames;
          sourceFile.textLength = analysis.extractedTextLength; sourceFile.warnings = analysis.warnings;
          const targetProduct = job.context?.targetProductId ? await this.repository.getProduct(job.context.targetProductId) : undefined;
          const targetPackageName = targetProduct?.packages.find((item) => item.id === job.context?.targetPackageId)?.name;
          const built = await Promise.all(buildKnowledgeCandidates(sourceFile, analysis).map(async (candidate) => {
            const contextual = { ...candidate, suggestedProductId: targetProduct?.id ?? candidate.suggestedProductId, suggestedProductName: targetProduct?.name ?? candidate.suggestedProductName, suggestedPackageName: targetPackageName ?? candidate.suggestedPackageName, productMatchConfidence: targetProduct ? 1 : candidate.productMatchConfidence };
            return this.products.enrichCandidate(job.organizationId, contextual);
          }));
          job.candidates.push(...built);
          for (const section of analysis.sections) section.candidateIds = built.filter((candidate) => candidate.sourceSectionIds?.includes(section.id)).map((candidate) => candidate.id);
          job.documentSections.push(...analysis.sections);
          job.uncoveredSections.push(...analysis.uncoveredSections);
        } catch (error) {
          sourceFile.status = 'failed'; sourceFile.analysisStatus = 'failed'; sourceFile.warnings = [error instanceof Error ? error.message : '未知解析错误'];
        }
        job.updatedAt = new Date().toISOString(); await this.repository.updateKnowledgeImport(job);
      }
      }
      job.status = 'grouping'; job.progress = 92; job.progressLabel = '正在校验章节覆盖率';
      const sections = job.documentSections ?? [];
      const totalChars = sections.reduce((sum, section) => sum + section.characterCount, 0);
      const handledChars = sections.filter((section) => section.coverageStatus !== 'failed').reduce((sum, section) => sum + section.characterCount, 0);
      job.coveragePercentage = totalChars === 0 ? 100 : Math.round((handledChars / totalChars) * 1000) / 10;
      const coveredSections = sections.filter((section) => section.coverageStatus === 'covered').length;
      const pendingSections = sections.filter((section) => section.coverageStatus === 'pending_confirmation').length;
      const failedSections = sections.filter((section) => section.coverageStatus === 'failed').length;
      job.revision = { id: job.revision?.id ?? randomUUID(), revisionNumber: job.revisionNumber ?? 1, parentImportId: job.parentImportId, totalSections: sections.length, coveredSections, pendingSections, failedSections, coveragePercentage: job.coveragePercentage, createdAt: job.revision?.createdAt ?? new Date().toISOString() };
      job.status = 'waiting_review'; job.progress = 100;
      job.progressLabel = job.coveragePercentage >= 95 ? '等待人工审核归类' : `覆盖率 ${job.coveragePercentage}%，存在遗漏章节，请重新完整解析`;
      job.updatedAt = new Date().toISOString(); await this.repository.updateKnowledgeImport(job);
    } catch (error) {
      const job = await this.repository.getKnowledgeImport(importId);
      if (job) {
        job.status = 'failed'; job.progressLabel = '资料解析失败'; job.error = { message: error instanceof Error ? error.message : '未知错误', recoverable: true }; job.updatedAt = new Date().toISOString();
        await this.repository.updateKnowledgeImport(job);
      }
    } finally { this.processingImports.delete(importId); }
  }

  async reparseImport(actor: RequestActor, importId: string) {
    const original = await this.requireImport(actor, importId);
    const now = new Date().toISOString(); const revisionNumber = (original.revisionNumber ?? 1) + 1;
    const rootImportId = original.parentImportId ?? original.id;
    const job: StoredKnowledgeImportJob = {
      id: randomUUID(), organizationId: original.organizationId, createdBy: actor.userId,
      status: 'extracting', progress: 15, progressLabel: '正在准备完整重解析',
      sourceFiles: original.sourceFiles.map((source) => ({ ...source, status: 'stored', textLength: 0, warnings: [] })),
      candidates: [], publishedEntryIds: [], documentSections: [], coveragePercentage: 0, uncoveredSections: [],
      context: original.context,
      parentImportId: rootImportId, revisionNumber,
      revision: { id: randomUUID(), revisionNumber, parentImportId: rootImportId, totalSections: 0, coveredSections: 0, pendingSections: 0, failedSections: 0, coveragePercentage: 0, createdAt: now },
      createdAt: now, updatedAt: now,
    };
    await this.repository.createKnowledgeImport(job); void this.processImport(job.id); return publicImport(job);
  }

  async recoverPendingImports() {
    const jobs = await this.repository.listKnowledgeImports('default-org', 100);
    for (const job of jobs.filter((item) => ['importing', 'extracting', 'analyzing', 'grouping'].includes(item.status))) void this.processImport(job.id);
  }

  async listImports(actor: RequestActor, limit = 20) {
    return (await this.repository.listKnowledgeImports(actor.organizationId, limit, actor.userId)).map(publicImport);
  }

  async getImport(actor: RequestActor, id: string) {
    const job = await this.requireImport(actor, id);
    return publicImport(job);
  }

  async getImportSource(actor: RequestActor, importId: string, sourceFileId: string) {
    const job = await this.requireImport(actor, importId);
    const source = job.sourceFiles.find((item) => item.id === sourceFileId);
    if (!source) throw new Error('来源文件不存在');
    return { source, data: await this.storage.get(source.storageKey) };
  }

  async addMedia(actor: RequestActor, entryId: string, file: { name: string; mimeType: string; data: Buffer }) {
    const entry = await this.repository.getKnowledge(entryId);
    if (!entry) throw new Error('资料条目不存在');
    if (isSystemLocked(entry)) throw new Error('系统通用条目不允许添加媒体素材');
    const kind = file.mimeType.startsWith('image/') ? 'image' : file.mimeType.startsWith('video/') ? 'video' : undefined;
    if (!kind) throw new Error('媒体素材仅支持图片或视频');
    const id = randomUUID();
    const storageKey = `${actor.organizationId}/knowledge/${entryId}/media/${id}/${safeFileName(file.name)}`;
    await this.storage.put(storageKey, file.data, file.mimeType);
    const asset: KnowledgeMediaAsset = { id, name: file.name, mimeType: file.mimeType, size: file.data.length, kind, storageKey, createdAt: new Date().toISOString() };
    const existingAssets = Array.isArray(entry.structuredData?.mediaAssets) ? entry.structuredData.mediaAssets as KnowledgeMediaAsset[] : [];
    const updated: KnowledgeEntry = { ...entry, structuredData: { ...entry.structuredData, mediaAssets: [...existingAssets, asset] }, updatedAt: new Date().toISOString() };
    await this.repository.updateKnowledge(actor.organizationId, updated);
    return updated;
  }

  async getMedia(actor: RequestActor, entryId: string, mediaId: string) {
    const entry = await this.repository.getKnowledge(entryId);
    if (!entry) throw new Error('资料条目不存在');
    const assets = Array.isArray(entry.structuredData?.mediaAssets) ? entry.structuredData.mediaAssets as KnowledgeMediaAsset[] : [];
    const asset = assets.find((item) => item.id === mediaId);
    if (!asset?.storageKey) throw new Error('媒体素材不存在');
    return { asset, data: await this.storage.get(asset.storageKey) };
  }

  async discardCandidate(actor: RequestActor, importId: string, candidateId: string) {
    const job = await this.requireEditableImport(actor, importId);
    job.candidates = job.candidates.map((candidate) => candidate.id === candidateId ? { ...candidate, reviewStatus: 'discarded', updatedAt: new Date().toISOString() } : candidate);
    job.updatedAt = new Date().toISOString();
    await this.repository.updateKnowledgeImport(job);
    return publicImport(job);
  }

  async splitCandidate(actor: RequestActor, importId: string, candidateId: string) {
    const job = await this.requireEditableImport(actor, importId);
    const index = job.candidates.findIndex((candidate) => candidate.id === candidateId);
    if (index < 0) throw new Error('候选条目不存在');
    const candidate = job.candidates[index];
    if (!candidate) throw new Error('候选条目不存在');
    if (candidate.reviewStatus === 'discarded') throw new Error('已丢弃的条目不能拆分');
    const replacements = splitCandidate(candidate);
    job.candidates.splice(index, 1, ...replacements);
    job.updatedAt = new Date().toISOString();
    await this.repository.updateKnowledgeImport(job);
    return publicImport(job);
  }

  async mergeCandidates(actor: RequestActor, importId: string, targetCandidateId: string, sourceCandidateId: string) {
    if (targetCandidateId === sourceCandidateId) throw new Error('请选择两个不同的候选条目');
    const job = await this.requireEditableImport(actor, importId);
    const target = job.candidates.find((candidate) => candidate.id === targetCandidateId);
    const source = job.candidates.find((candidate) => candidate.id === sourceCandidateId);
    if (!target || !source) throw new Error('候选条目不存在');
    if (target.reviewStatus === 'discarded' || source.reviewStatus === 'discarded') throw new Error('已丢弃的条目不能合并');
    job.candidates = job.candidates.map((candidate) => candidate.id === targetCandidateId ? mergeCandidates(target, source) : candidate.id === sourceCandidateId ? { ...candidate, reviewStatus: 'discarded', updatedAt: new Date().toISOString() } : candidate);
    job.updatedAt = new Date().toISOString();
    await this.repository.updateKnowledgeImport(job);
    return publicImport(job);
  }

  async confirmImport(actor: RequestActor, importId: string, candidates?: KnowledgeCandidate[]) {
    const job = await this.requireEditableImport(actor, importId);
    if (candidates?.length) job.candidates = candidates;
    const approved = job.candidates.filter((candidate) => candidate.reviewStatus !== 'discarded');
    if (approved.length === 0) throw new Error('没有可发布的候选条目');
    const now = new Date().toISOString();
    const publishedIds: string[] = [];
    for (const candidate of approved) {
      const suggestedProduct = candidate.suggestedProductId ? await this.repository.getProduct(candidate.suggestedProductId) : undefined;
      const suggestedPackage = suggestedProduct?.packages.find((item) => item.name === candidate.suggestedPackageName);
      const entry: KnowledgeEntry = {
        id: randomUUID(),
        productId: suggestedProduct?.id,
        packageId: suggestedPackage?.id,
        origin: 'import',
        locked: false,
        layer: candidate.layer,
        category: candidate.category,
        title: candidate.title,
        content: candidate.content,
        version: candidate.version || '1.0',
        status: 'published',
        reviewer: actor.userId,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
        structuredData: {
          businessCategory: candidate.businessCategory,
          importJobId: job.id,
          candidateId: candidate.id,
          sourceReferences: candidate.citations,
          sourceSectionIds: candidate.sourceSectionIds ?? [],
          extractionRevision: job.revision,
          mediaAssets: job.sourceFiles.filter((source) => candidate.sourceFileIds.includes(source.id) && /^(image|video)\//.test(source.mimeType)).map((source) => ({ id: source.id, name: source.name, mimeType: source.mimeType, size: source.size, kind: source.mimeType.startsWith('video/') ? 'video' : 'image', importJobId: job.id, sourceFileId: source.id, createdAt: source.createdAt })),
          importPurpose: job.context?.purpose,
          sourceGroupId: job.context?.sourceGroupId,
          transcript: candidate.category === '销冠对话复盘' ? candidate.content : undefined,
          conversationMessages: candidate.conversationMessages,
          timeRange: candidate.timeRange,
          privacyFindings: candidate.privacyFindings,
          analysisWarnings: candidate.analysisWarnings,
          classificationConfidence: candidate.confidence,
          requiresHumanConfirmation: false,
          embedding: {
            status: 'pending',
            model: this.config.embeddingModelName,
            dimensions: this.config.embeddingDimensions ?? 1536,
          },
        },
      };
      await this.repository.createKnowledge(actor.organizationId, entry);
      await this.indexScheduler.scheduleUpsert(actor.organizationId, entry.id);
      publishedIds.push(entry.id);
    }
    job.status = 'published'; job.progress = 100; job.progressLabel = '已确认发布到资料库'; job.publishedEntryIds = publishedIds;
    job.candidates = job.candidates.map((candidate) => approved.some((item) => item.id === candidate.id) ? { ...candidate, reviewStatus: 'confirmed', updatedAt: now } : { ...candidate, reviewStatus: 'discarded', updatedAt: now });
    job.updatedAt = now;
    await this.repository.updateKnowledgeImport(job);
    return publicImport(job);
  }

  async copySystemEntry(actor: RequestActor, id: string) {
    const existing = await this.repository.getKnowledge(id);
    if (!existing || !isSystemLocked(existing) || existing.structuredData?.demoDisabled) throw new Error('系统通用条目不存在');
    const now = new Date().toISOString();
    const { systemManaged: _systemManaged, demoDisabled: _demoDisabled, ...structuredData } = existing.structuredData ?? {};
    const copy: KnowledgeEntry = {
      ...existing,
      id: randomUUID(),
      origin: 'manual',
      systemKey: undefined,
      locked: false,
      title: `${existing.title}（企业副本）`,
      status: 'draft',
      reviewer: undefined,
      publishedAt: undefined,
      structuredData: { ...structuredData, copiedFromSystemKey: existing.systemKey },
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createKnowledge(actor.organizationId, copy);
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action: 'knowledge.system.copy', targetType: 'knowledge', targetId: copy.id, metadata: { sourceId: existing.id, systemKey: existing.systemKey }, createdAt: now });
    return copy;
  }

  async trashEntries(actor: RequestActor, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new Error('请至少选择一条资料');
    if (uniqueIds.length > 200) throw new Error('单次最多处理200条资料');
    const entries = await Promise.all(uniqueIds.map((id) => this.repository.getKnowledge(id)));
    if (entries.some((entry) => !entry)) throw new Error('部分资料不存在，请刷新后重试');
    if (entries.some((entry) => entry && isSystemLocked(entry))) throw new Error('系统通用条目不能删除');
    const now = new Date();
    const purgeAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const entry of entries as KnowledgeEntry[]) {
      if (entry.deletedAt) continue;
      await this.repository.updateKnowledge(actor.organizationId, { ...entry, deletedAt: now.toISOString(), purgeAt, deletedFromStatus: entry.status, status: 'archived', updatedAt: now.toISOString() });
      if (entry.layer === 'L2' || entry.layer === 'L3') await this.indexScheduler.scheduleDelete(actor.organizationId, entry.id);
    }
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action: 'knowledge.trash', targetType: 'knowledge', targetId: uniqueIds.join(','), metadata: { ids: uniqueIds, purgeAt }, createdAt: now.toISOString() });
    return this.list(actor.organizationId, 'trash');
  }

  async restoreEntries(actor: RequestActor, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new Error('请至少选择一条资料');
    const entries = await Promise.all(uniqueIds.map((id) => this.repository.getKnowledge(id)));
    if (entries.some((entry) => !entry?.deletedAt)) throw new Error('部分资料不在回收站中');
    const now = new Date().toISOString();
    for (const entry of entries as KnowledgeEntry[]) {
      const restored: KnowledgeEntry = { ...entry, status: entry.deletedFromStatus ?? 'draft', deletedAt: undefined, purgeAt: undefined, deletedFromStatus: undefined, updatedAt: now };
      await this.repository.updateKnowledge(actor.organizationId, restored);
      if (this.isVectorEligible(restored)) await this.indexScheduler.scheduleUpsert(actor.organizationId, entry.id);
    }
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action: 'knowledge.restore', targetType: 'knowledge', targetId: uniqueIds.join(','), metadata: { ids: uniqueIds }, createdAt: now });
    return this.list(actor.organizationId, 'active');
  }

  async permanentlyDelete(actor: RequestActor, id: string, automatic = false) {
    const entry = await this.repository.getKnowledge(id);
    if (!entry?.deletedAt) throw new Error('只有回收站中的资料才能彻底删除');
    if (isSystemLocked(entry)) throw new Error('系统通用条目不能删除');
    const assets = Array.isArray(entry.structuredData?.mediaAssets) ? entry.structuredData.mediaAssets as KnowledgeMediaAsset[] : [];
    for (const asset of assets) if (asset.storageKey && !asset.importJobId) await this.storage.delete(asset.storageKey);
    await this.repository.deleteKnowledge(actor.organizationId, id);
    if (entry.layer === 'L2' || entry.layer === 'L3') await this.indexScheduler.scheduleDelete(actor.organizationId, id);
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: automatic ? 'system' : actor.userId, action: automatic ? 'knowledge.purge.auto' : 'knowledge.purge', targetType: 'knowledge', targetId: id, metadata: { title: entry.title }, createdAt: new Date().toISOString() });
  }

  async purgeExpiredTrash(organizationId = 'default-org') {
    const now = Date.now();
    const entries = await this.repository.listKnowledge(organizationId);
    for (const entry of entries.filter((item) => item.deletedAt && item.purgeAt && Date.parse(item.purgeAt) <= now && !isSystemLocked(item))) {
      await this.permanentlyDelete({ organizationId, userId: 'system', role: 'admin' }, entry.id, true);
    }
  }

  async exportKnowledge(organizationId: string, format: 'json' | 'markdown' | 'excel') {
    const rows = (await this.repository.listKnowledge(organizationId)).filter((entry) => entry.status === 'published' && !entry.deletedAt && !entry.structuredData?.demoDisabled);
    if (format === 'json') return { fileName: `knowledge-export-${new Date().toISOString().slice(0, 10)}.json`, contentType: 'application/json; charset=utf-8', content: JSON.stringify(rows, null, 2) };
    if (format === 'markdown') return { fileName: `knowledge-export-${new Date().toISOString().slice(0, 10)}.md`, contentType: 'text/markdown; charset=utf-8', content: rows.map((entry) => `## ${entry.layer} ${entry.title}\n\n- 分类：${entry.category}\n- 业务归档：${String(entry.structuredData?.businessCategory ?? '未标注')}\n- 版本：${entry.version}\n- 审核人：${entry.reviewer ?? '未记录'}\n- 发布时间：${entry.publishedAt ?? '未记录'}\n\n${entry.content}`).join('\n\n---\n\n') };
    return { fileName: `knowledge-export-${new Date().toISOString().slice(0, 10)}.xls`, contentType: 'application/vnd.ms-excel; charset=utf-8', content: this.excelXml(rows) };
  }
  async update(organizationId: string, id: string, input: Partial<Pick<KnowledgeEntry, 'category' | 'title' | 'content' | 'structuredData' | 'version' | 'effectiveFrom' | 'effectiveTo' | 'status'>>) {
    const existing = await this.repository.getKnowledge(id); if (!existing) throw new Error('Knowledge entry not found');
    if (isSystemLocked(existing)) throw new Error('系统通用条目已锁定，不允许修改');
    const entry = { ...existing, ...input, id: existing.id, layer: existing.layer, updatedAt: new Date().toISOString() };
    await this.repository.updateKnowledge(organizationId, entry);
    if (this.isVectorEligible(entry) && this.indexFingerprint(existing) !== this.indexFingerprint(entry)) {
      await this.indexScheduler.scheduleUpsert(organizationId, entry.id);
    } else if (this.isVectorEligible(existing) && !this.isVectorEligible(entry)) {
      await this.indexScheduler.scheduleDelete(organizationId, entry.id);
    }
    return entry;
  }
  async setStatus(organizationId: string, id: string, status: KnowledgeStatus, reviewer: string) {
    const existing = await this.repository.getKnowledge(id); if (!existing) throw new Error('Knowledge entry not found');
    if (isSystemLocked(existing)) throw new Error('系统通用条目已锁定');
    if (status === 'published' && existing.structuredData?.requiresHumanConfirmation) throw new Error('自动分析的内容必须先完成人工审核归类');
    const now = new Date().toISOString(); const entry = { ...existing, status, reviewer, publishedAt: status === 'published' ? now : existing.publishedAt, updatedAt: now };
    await this.repository.updateKnowledge(organizationId, entry);
    if (entry.layer === 'L2' || entry.layer === 'L3') {
      if (this.isVectorEligible(entry)) await this.indexScheduler.scheduleUpsert(organizationId, entry.id);
      else await this.indexScheduler.scheduleDelete(organizationId, entry.id);
    }
    return entry;
  }

  async confirmClassification(organizationId: string, id: string, input: { layer: 'L2' | 'L3'; category: string; title: string; content: string; version: string }, reviewer: string) {
    const existing = await this.repository.getKnowledge(id); if (!existing) throw new Error('Knowledge entry not found');
    if (existing.status !== 'in_review' || !existing.structuredData?.requiresHumanConfirmation) throw new Error('该条目不处于待人工审核状态');
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = { ...existing, ...input, structuredData: { ...existing.structuredData, requiresHumanConfirmation: false, classificationConfirmedAt: now, classificationConfirmedBy: reviewer }, status: 'published', reviewer, publishedAt: now, updatedAt: now };
    await this.repository.updateKnowledge(organizationId, entry);
    await this.indexScheduler.scheduleUpsert(organizationId, entry.id);
    return entry;
  }

  private async ingestSourceFile(job: StoredKnowledgeImportJob, file: { name: string; mimeType: string; data: Buffer }, sequenceIndex = job.sourceFiles.length): Promise<KnowledgeSourceFile> {
    const sourceFileId = randomUUID();
    const key = `${job.organizationId}/knowledge-imports/${job.id}/${sourceFileId}/${safeFileName(file.name)}`;
    await this.storage.put(key, file.data, file.mimeType);
    return { id: sourceFileId, name: file.name, mimeType: file.mimeType, size: file.data.length, storageKey: key, status: 'stored', textLength: 0, warnings: [], sequenceIndex, sourceGroupId: job.context?.sourceGroupId, analysisStatus: 'pending', createdAt: new Date().toISOString() };
  }

  private async requireImport(actor: RequestActor, id: string) {
    const job = await this.repository.getKnowledgeImport(id);
    if (!job || job.organizationId !== actor.organizationId || job.createdBy !== actor.userId) throw new Error('导入任务不存在');
    return job;
  }

  private async requireEditableImport(actor: RequestActor, id: string) {
    const job = await this.requireImport(actor, id);
    if (job.status !== 'waiting_review') throw new Error('该导入任务当前不能编辑');
    return job;
  }

  private isVectorEligible(entry: KnowledgeEntry) {
    return entry.status === 'published'
      && !entry.deletedAt
      && (entry.layer === 'L2' || entry.layer === 'L3');
  }

  private indexFingerprint(entry: KnowledgeEntry) {
    return JSON.stringify([
      entry.layer,
      entry.category,
      entry.title,
      entry.content,
      entry.version,
      entry.effectiveFrom,
      entry.effectiveTo,
      entry.productId,
      entry.packageId,
      entry.structuredData?.businessCategory,
      entry.structuredData?.sourceReferences,
      entry.structuredData?.timeRange,
    ]);
  }

  private excelXml(entries: KnowledgeEntry[]) {
    const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = entries.map((entry) => [entry.layer, entry.title, entry.category, entry.structuredData?.businessCategory ?? '', entry.version, entry.status, entry.reviewer ?? '', entry.publishedAt ?? '', entry.content.replace(/\s+/g, ' ')]
      .map((cell) => `<Cell><Data ss:Type="String">${escape(cell)}</Data></Cell>`).join(''));
    const header = ['层级', '标题', '分类', '业务归档', '版本', '状态', '审核人', '发布时间', '正文'].map((cell) => `<Cell><Data ss:Type="String">${cell}</Data></Cell>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="资料库"><Table><Row>${header}</Row>${rows.map((row) => `<Row>${row}</Row>`).join('')}</Table></Worksheet></Workbook>`;
  }

  async getPersonalStyle(actor: RequestActor): Promise<SalesStyleProfile> {
    const entries = await this.repository.listKnowledge(actor.organizationId);
    const entry = entries.find((item) => item.layer === 'L4' && item.status === 'published' && item.structuredData?.ownerId === actor.userId);
    const data = entry?.structuredData ?? {};
    return {
      customerAddressing: String(data.customerAddressing ?? ''),
      commonParticles: Array.isArray(data.commonParticles) ? data.commonParticles.map(String) : [],
      emojis: Array.isArray(data.emojis) ? data.emojis.map(String) : [],
      punctuation: data.punctuation === '简洁' || data.punctuation === '正式' ? data.punctuation : '自然',
      messageSplitting: data.messageSplitting === '分条' ? '分条' : '单条',
      referenceMessages: Array.isArray(data.referenceMessages) ? data.referenceMessages.map(String) : [],
    };
  }

  async savePersonalStyle(actor: RequestActor, profile: SalesStyleProfile) {
    const entries = await this.repository.listKnowledge(actor.organizationId);
    const existing = entries.find((item) => item.layer === 'L4' && item.structuredData?.ownerId === actor.userId);
    const now = new Date().toISOString();
    const structuredData = { ...profile, ownerId: actor.userId };
    const content = `称呼：${profile.customerAddressing || '未设置'}；标点：${profile.punctuation}；消息习惯：${profile.messageSplitting}`;
    if (existing) {
      const entry: KnowledgeEntry = { ...existing, content, structuredData, status: 'published', reviewer: actor.userId, publishedAt: now, updatedAt: now };
      await this.repository.updateKnowledge(actor.organizationId, entry); return entry;
    }
    const entry: KnowledgeEntry = { id: randomUUID(), layer: 'L4', category: '个人表达风格', title: '我的销售表达风格', content, structuredData, version: '1.0', status: 'published', reviewer: actor.userId, publishedAt: now, createdAt: now, updatedAt: now };
    await this.repository.createKnowledge(actor.organizationId, entry); return entry;
  }
}
