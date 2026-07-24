import { randomUUID } from 'node:crypto';
import type { ClarificationQuestion, CustomerDealStatus, CustomerProfile, ParsedConversation } from '../shared/contracts.js';
import type { AnalysisRequestInput } from '../shared/contracts.js';
import type { AppConfig } from './config.js';
import type { FeedbackRecord, ObjectStorage, Repository, RequestActor, StoredAnalysisJob, StoredAttachment } from './domain.js';
import type { ConversationParser, ImageInput } from './model/conversationParser.js';
import type { KnowledgeVectorIndex } from './infrastructure/vectorIndex.js';
import { buildCustomerProfiles, findMatchingCustomerProfileId } from './customerProfiles.js';
import { cropCustomerAvatar } from './customerAvatar.js';
import { retrieveKnowledge } from './knowledge/retrieval.js';
import { generateSalesAdvice } from './model/salesAdvisor.js';
import { analyzeWithRules, buildClarifications } from './rules/analysisEngine.js';

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const FOLLOW_UP_INTERVAL_MS = 72 * 60 * 60 * 1000;
const SNOOZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function analysisErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return '分析失败，请重新尝试';
  if (error.name === 'ZodError' || error.message.includes('"code":"too_small"')) return 'AI已识别对话，但本次返回内容不完整，系统将自动重试；如仍失败请点击重新分析。';
  return error.message;
}

export class AnalysisService {
  constructor(
    private readonly repository: Repository,
    private readonly storage: ObjectStorage,
    private readonly parser: ConversationParser,
    private readonly config: AppConfig,
    private readonly vectorIndex?: KnowledgeVectorIndex,
  ) {}

  async create(input: AnalysisRequestInput, files: Array<{ name: string; mimeType: string; data: Buffer }>, actor: RequestActor, customer?: { profileId?: string; dealStatus?: CustomerDealStatus }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const attachments: StoredAttachment[] = [];
    for (const file of files.slice(0, 10)) {
      const key = `${actor.organizationId}/${actor.userId}/${id}/${randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await this.storage.put(key, file.data, file.mimeType);
      attachments.push({ key, name: file.name, mimeType: file.mimeType, size: file.data.length });
    }
    const job: StoredAnalysisJob = { id, customerProfileId: customer?.profileId ?? randomUUID(), customerProfileMatchSource: customer?.profileId ? 'explicit' : 'new', customerDealStatus: customer?.dealStatus, organizationId: actor.organizationId, createdBy: actor.userId, attachments, status: 'uploaded', progress: 5, progressLabel: '已接收对话', createdAt: now, updatedAt: now, lastProgressAt: now, nextFollowUpAt: new Date(Date.parse(now) + FOLLOW_UP_INTERVAL_MS).toISOString(), request: { ...input, attachmentNames: [...new Set([...input.attachmentNames, ...attachments.map((item) => item.name)])] }, clarificationQuestions: [], clarificationCount: 0, executionAttempts: 0, executionHistory: [], modelVersion: this.config.modelName };
    await this.repository.createJob(job);
    await this.audit(actor, 'analysis.create', 'analysis', id, { attachmentCount: attachments.length });
    if (this.config.workerMode === 'inline') void this.process(id);
    return job;
  }

  async processPending() {
    const job = await this.repository.claimNextJob();
    if (!job) return false;
    await this.process(job.id, true);
    return true;
  }

  async get(id: string, actor: RequestActor) {
    const job = await this.repository.getJob(id);
    if (!job || job.organizationId !== actor.organizationId || (actor.role !== 'admin' && job.createdBy !== actor.userId)) return undefined;
    return job;
  }

  async list(actor: RequestActor, limit = 50) {
    const jobs = await this.repository.listJobs(actor.organizationId, 100);
    return jobs.filter((job) => actor.role === 'admin' || job.createdBy === actor.userId).slice(0, Math.min(limit, 100));
  }

  async listCustomerProfiles(actor: RequestActor): Promise<CustomerProfile[]> {
    const jobs = await this.repository.listJobs(actor.organizationId, 1000);
    const visible = jobs.filter((job) => actor.role === 'admin' || job.createdBy === actor.userId);
    return buildCustomerProfiles(visible);
  }

  async customerReminderSummary(actor: RequestActor) {
    const profiles = await this.listCustomerProfiles(actor);
    return { dueCount: profiles.filter((profile) => profile.dealStatus === 'unwon' && profile.followUpDue).length };
  }

  async updateCustomerFollowUp(profileId: string, action: 'completed' | 'snooze', actor: RequestActor) {
    const jobs = await this.repository.listJobs(actor.organizationId, 1000);
    const matched = jobs.filter((job) => (job.customerProfileId ?? job.id) === profileId && (actor.role === 'admin' || job.createdBy === actor.userId));
    if (!matched.length) throw new Error('客户档案不存在');
    const latest = matched.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]!;
    const now = new Date();
    if (action === 'completed') {
      latest.lastProgressAt = now.toISOString();
      latest.nextFollowUpAt = new Date(now.getTime() + FOLLOW_UP_INTERVAL_MS).toISOString();
      latest.updatedAt = now.toISOString();
    } else {
      latest.nextFollowUpAt = new Date(now.getTime() + SNOOZE_INTERVAL_MS).toISOString();
    }
    await this.repository.updateJob(latest);
    await this.audit(actor, action === 'completed' ? 'customer.follow_up_completed' : 'customer.follow_up_snoozed', 'customer', profileId, { nextFollowUpAt: latest.nextFollowUpAt });
    const refreshed = buildCustomerProfiles(await this.repository.listJobs(actor.organizationId, 1000)).find((profile) => profile.id === profileId);
    if (!refreshed) throw new Error('客户档案更新失败');
    return refreshed;
  }

  async setCustomerDealStatus(profileId: string, status: CustomerDealStatus, actor: RequestActor) {
    const jobs = await this.repository.listJobs(actor.organizationId, 1000);
    const matched = jobs.filter((job) => (job.customerProfileId ?? job.id) === profileId && (actor.role === 'admin' || job.createdBy === actor.userId));
    if (!matched.length) throw new Error('客户档案不存在');
    for (const job of matched) {
      job.customerDealStatus = status;
      await this.repository.updateJob(job);
    }
    await this.audit(actor, 'customer.status_update', 'customer', profileId, { status });
    return buildCustomerProfiles(matched)[0];
  }

  async setCustomerRemark(profileId: string, remark: string, actor: RequestActor, analysisId?: string) {
    const normalized = remark.trim();
    if (!normalized || normalized.length > 40) throw new Error('客户备注应为1至40个字符');
    const jobs = await this.repository.listJobs(actor.organizationId, 1000);
    const visible = jobs.filter((job) => actor.role === 'admin' || job.createdBy === actor.userId);
    const anchor = analysisId ? visible.find((job) => job.id === analysisId) : undefined;
    const resolvedProfileId = anchor?.customerProfileId ?? anchor?.id ?? profileId;
    const matched = visible.filter((job) => (job.customerProfileId ?? job.id) === resolvedProfileId);
    if (!matched.length) throw new Error('客户档案不存在');
    const now = new Date().toISOString();
    for (const job of matched) {
      job.customerManualRemark = normalized;
      job.updatedAt = now;
      await this.repository.updateJob(job);
    }
    await this.audit(actor, 'customer.remark_update', 'customer', resolvedProfileId, { remark: normalized });
    return buildCustomerProfiles(matched)[0];
  }

  async getCustomerAvatar(profileId: string, actor: RequestActor) {
    const jobs = await this.repository.listJobs(actor.organizationId, 1000);
    const job = jobs.filter((item) => (item.customerProfileId ?? item.id) === profileId && item.customerAvatarKey && (actor.role === 'admin' || item.createdBy === actor.userId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!job?.customerAvatarKey) return undefined;
    return { data: await this.storage.get(job.customerAvatarKey), mimeType: 'image/png' };
  }

  async refreshCustomerIdentity(profileId: string, actor: RequestActor) {
    const jobs = await this.repository.listJobs(actor.organizationId, 1000);
    const job = jobs.filter((item) => (item.customerProfileId ?? item.id) === profileId && item.attachments.some((attachment) => attachment.mimeType.startsWith('image/')) && (actor.role === 'admin' || item.createdBy === actor.userId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!job) throw new Error('该客户没有可重新识别的聊天截图');
    const images: ImageInput[] = [];
    for (const attachment of job.attachments.filter((item) => item.mimeType.startsWith('image/'))) images.push({ name: attachment.name, mimeType: attachment.mimeType, data: await this.storage.get(attachment.key) });
    const parsed = await this.parser.parse(job.request.conversation, images);
    if (!parsed.customerIdentity) throw new Error('截图中没有识别到可靠的客户身份或头像');
    job.transcript = job.transcript ? { ...job.transcript, customerIdentity: parsed.customerIdentity } : parsed;
    job.customerAvatarKey = undefined;
    await this.syncCustomerIdentity(job, images);
    await this.audit(actor, 'customer.identity_refresh', 'customer', profileId, { analysisId: job.id, hasAvatar: Boolean(job.customerAvatarKey) });
    const refreshed = buildCustomerProfiles(await this.repository.listJobs(actor.organizationId, 1000)).find((profile) => profile.id === (job.customerProfileId ?? job.id));
    if (!refreshed) throw new Error('客户档案刷新失败');
    return refreshed;
  }

  async recoverPending() {
    const active = new Set(['uploaded', 'parsing', 'classifying', 'retrieving', 'generating', 'validating']);
    const jobs = (await this.repository.listJobs('default-org', 10_000)).filter((job) => active.has(job.status));
    for (const job of jobs) {
      if ((job.executionAttempts ?? 0) >= 3) {
        job.status = 'failed'; job.progressLabel = '任务恢复次数已达上限，请人工重试'; job.updatedAt = new Date().toISOString(); await this.repository.updateJob(job); continue;
      }
      job.status = 'uploaded'; job.progress = 5; job.progressLabel = '服务恢复后重新排队'; job.updatedAt = new Date().toISOString();
      await this.repository.updateJob(job);
      if (this.config.workerMode === 'inline') void this.process(job.id);
    }
    return jobs.length;
  }

  async cancel(id: string, actor: RequestActor) {
    const job = await this.requireJob(id, actor);
    if (['completed', 'handoff'].includes(job.status)) throw new Error('已完成任务不能取消');
    job.status = 'canceled'; job.progressLabel = '已由用户取消'; job.updatedAt = new Date().toISOString();
    const running = [...(job.executionHistory ?? [])].reverse().find((record) => record.outcome === 'running');
    if (running) { running.outcome = 'canceled'; running.finishedAt = job.updatedAt; }
    await this.repository.updateJob(job); return job;
  }

  async retry(id: string, actor: RequestActor) {
    const job = await this.requireJob(id, actor);
    if (!['failed', 'blocked', 'canceled'].includes(job.status)) throw new Error('当前任务状态不支持重试');
    job.status = 'uploaded'; job.progress = 5; job.progressLabel = '已重新排队'; job.error = undefined; job.updatedAt = new Date().toISOString();
    await this.repository.updateJob(job); if (this.config.workerMode === 'inline') void this.process(job.id); return job;
  }

  async getAttachment(id: string, index: number, actor: RequestActor) {
    const job = await this.requireJob(id, actor);
    const attachment = job.attachments[index];
    if (!attachment) throw new Error('附件不存在');
    const data = await this.storage.get(attachment.key);
    await this.audit(actor, 'analysis.attachment.read', 'analysis', id, { index, name: attachment.name });
    return { attachment, data };
  }

  async confirmTranscript(id: string, transcript: ParsedConversation, actor: RequestActor) {
    const job = await this.requireJob(id, actor);
    job.transcript = { ...transcript, requiresConfirmation: false };
    await this.syncCustomerIdentity(job);
    job.clarificationQuestions = [];
    await this.save(job, 'classifying', 42, '已确认对话，正在判断情境');
    await this.audit(actor, 'analysis.confirm_transcript', 'analysis', id);
    void this.completeFromTranscript(id);
    return job;
  }

  async answerClarifications(id: string, answers: Array<{ id: string; answer: string }>, actor: RequestActor) {
    const job = await this.requireJob(id, actor);
    if (job.clarificationCount >= 2) throw new Error('Clarification limit reached');
    const answerMap = new Map(answers.map((item) => [item.id, item.answer]));
    job.clarificationQuestions = job.clarificationQuestions.map((question) => ({ ...question, answer: answerMap.get(question.id) ?? question.answer }));
    job.clarificationCount += 1;
    await this.save(job, 'classifying', 42, '已补充信息，正在判断情境');
    await this.audit(actor, 'analysis.clarify', 'analysis', id, { clarificationCount: job.clarificationCount });
    void this.completeFromTranscript(id);
    return job;
  }

  async addFeedback(id: string, input: Omit<FeedbackRecord, 'id' | 'analysisId' | 'userId' | 'createdAt'>, actor: RequestActor) {
    await this.requireJob(id, actor);
    const record: FeedbackRecord = { id: randomUUID(), analysisId: id, userId: actor.userId, createdAt: new Date().toISOString(), ...input };
    await this.repository.addFeedback(record);
    await this.audit(actor, 'analysis.feedback', 'analysis', id, { outcome: input.outcome });
    return record;
  }

  async remove(id: string, actor: RequestActor) {
    const job = await this.requireJob(id, actor);
    for (const attachment of job.attachments) await this.storage.delete(attachment.key);
    if (job.customerAvatarKey) await this.storage.delete(job.customerAvatarKey);
    await this.repository.deleteJob(id);
    await this.audit(actor, 'analysis.delete', 'analysis', id);
  }

  async clearCustomerData(actor: RequestActor) {
    const jobs = await this.repository.listJobs(actor.organizationId, 10_000);
    for (const job of jobs) {
      for (const attachment of job.attachments) await this.storage.delete(attachment.key);
      if (job.customerAvatarKey) await this.storage.delete(job.customerAvatarKey);
    }
    return this.repository.clearCustomerData(actor.organizationId);
  }

  async cleanupExpired() {
    const cutoff = new Date(Date.now() - this.config.retentionDays * 86400000);
    const jobs = await this.repository.deleteExpiredJobs(cutoff);
    for (const job of jobs) {
      for (const attachment of job.attachments) await this.storage.delete(attachment.key);
      if (job.customerAvatarKey) await this.storage.delete(job.customerAvatarKey);
      await this.repository.addAudit({ id: randomUUID(), organizationId: job.organizationId, userId: 'retention-system', action: 'analysis.retention_delete', targetType: 'analysis', targetId: job.id, metadata: { retentionDays: this.config.retentionDays }, createdAt: new Date().toISOString() });
    }
    return jobs.length;
  }

  private async process(id: string, alreadyClaimed = false) {
    try {
      const job = await this.requireAnyJob(id);
      if (job.status === 'canceled') return;
      job.executionAttempts = (job.executionAttempts ?? 0) + 1;
      job.executionHistory = [...(job.executionHistory ?? []), { attempt: job.executionAttempts, startedAt: new Date().toISOString(), outcome: 'running' }];
      await this.repository.updateJob(job);
      // OCR is expensive and can time out. A retry should reuse a transcript that was
      // already parsed successfully instead of sending the same screenshot again.
      if (job.transcript && !job.transcript.requiresConfirmation) {
        await this.completeFromTranscript(id);
        return;
      }
      if (!alreadyClaimed) await this.save(job, 'parsing', 18, '正在识别对话与隐私信息');
      const images: ImageInput[] = [];
      for (const attachment of job.attachments) images.push({ name: attachment.name, mimeType: attachment.mimeType, data: await this.storage.get(attachment.key) });
      const transcript = await this.parser.parse(job.request.conversation, images);
      job.transcript = transcript;
      await this.syncCustomerIdentity(job, images);
      const clarificationQuestions = buildClarifications(transcript);
      if (transcript.requiresConfirmation || clarificationQuestions.length) {
        job.clarificationQuestions = transcript.requiresConfirmation ? [{ id: 'confirm-transcript', question: '部分消息角色或文字识别置信度较低，请确认左侧对话记录。' }] : clarificationQuestions.slice(0, 2);
        await this.save(job, 'needs_confirmation', 32, transcript.requiresConfirmation ? '等待确认识别结果' : '需要补充少量信息');
        return;
      }
      job.updatedAt = new Date().toISOString();
      await this.repository.updateJob(job);
      await this.completeFromTranscript(id);
    } catch (error) { await this.fail(id, error); }
  }

  private async completeFromTranscript(id: string) {
    try {
      const job = await this.requireAnyJob(id);
      if (!job.transcript) throw new Error('Transcript is missing');
      await this.save(job, 'classifying', 46, '正在判断僵局、意向与阶段'); await pause(120);
      await this.save(job, 'retrieving', 62, '正在按L0-L4检索规则与资料');
      const allKnowledge = await this.repository.listKnowledge(job.organizationId);
      const localClassification = analyzeWithRules(job.transcript, [], job.clarificationQuestions, job.createdBy);
      const knowledge = await retrieveKnowledge(allKnowledge, `${job.request.product ?? ''}\n${job.request.conversation}\n${job.transcript.lastMessage}\n销售情境：${localClassification.deadlockType}；异议：${localClassification.objectionType}；阶段：${localClassification.decisionStage}；目标：成交推进`, this.config, {
        organizationId: job.organizationId,
        ownerId: job.createdBy,
        vectorIndex: this.vectorIndex,
      }); await pause(120);
      await this.save(job, 'generating', 78, '正在生成回复与后续动作');
      const baseline = analyzeWithRules(job.transcript, knowledge, job.clarificationQuestions, job.createdBy);
      const result = this.config.modelDriver === 'openai_compatible'
        ? await generateSalesAdvice(this.config, baseline, job.transcript, knowledge, job.request)
        : baseline;
      await pause(120);
      await this.save(job, 'validating', 92, '正在进行事实、隐私与合规校验'); await pause(120);
      job.result = result;
      job.error = undefined;
      const finalStatus = result.handoffRequired ? 'handoff' : result.validationReport.passed ? 'completed' : 'blocked';
      await this.save(job, finalStatus, 100, finalStatus === 'handoff' ? '建议升级人工处理' : finalStatus === 'blocked' ? '校验未通过，已阻止普通回复' : '分析完成');
      const running = [...(job.executionHistory ?? [])].reverse().find((record) => record.outcome === 'running');
      if (running) { running.outcome = 'completed'; running.finishedAt = new Date().toISOString(); await this.repository.updateJob(job); }
    } catch (error) { await this.fail(id, error); }
  }

  private async save(job: StoredAnalysisJob, status: StoredAnalysisJob['status'], progress: number, progressLabel: string) {
    const latest = await this.repository.getJob(job.id);
    if (latest?.status === 'canceled' && status !== 'canceled') throw new Error('ANALYSIS_CANCELED');
    job.status = status; job.progress = progress; job.progressLabel = progressLabel; job.updatedAt = new Date().toISOString(); await this.repository.updateJob(job); return job;
  }
  private async syncCustomerIdentity(job: StoredAnalysisJob, loadedImages?: ImageInput[]) {
    const identity = job.transcript?.customerIdentity;
    if (!identity) return;
    job.customerIdentity = identity;
    if (!job.customerAvatarKey && identity.avatarSourceAttachment && identity.avatarBoundingBox) {
      const attachment = job.attachments.find((item) => item.name === identity.avatarSourceAttachment);
      if (attachment?.mimeType.startsWith('image/')) {
        const source = loadedImages?.find((item) => item.name === attachment.name)?.data ?? await this.storage.get(attachment.key);
        const avatar = await cropCustomerAvatar(source, identity.avatarBoundingBox);
        if (avatar) {
          job.customerAvatarKey = `${job.organizationId}/${job.createdBy}/${job.id}/customer-avatar.png`;
          await this.storage.put(job.customerAvatarKey, avatar.data, 'image/png');
          if (avatar.fingerprint) identity.identityHashes = [...new Set([...identity.identityHashes, `avatar:${avatar.fingerprint}`])];
        }
      }
    }
    if (job.customerProfileMatchSource !== 'explicit') {
      const jobs = await this.repository.listJobs(job.organizationId, 1000);
      const match = findMatchingCustomerProfileId(job, jobs);
      identity.matchStatus = match.matchStatus;
      identity.possibleProfileIds = match.possibleProfileIds;
      if (match.profileId) {
        job.customerProfileId = match.profileId;
        job.customerProfileMatchSource = 'identity';
      } else job.customerProfileMatchSource = 'new';
    }
    job.updatedAt = new Date().toISOString();
    await this.repository.updateJob(job);
  }
  private async fail(id: string, error: unknown) {
    const job = await this.repository.getJob(id); if (!job) return;
    if (job.status === 'canceled' || (error instanceof Error && error.message === 'ANALYSIS_CANCELED')) return;
    const running = [...(job.executionHistory ?? [])].reverse().find((record) => record.outcome === 'running');
    const message = analysisErrorMessage(error);
    if (running) { running.outcome = 'failed'; running.finishedAt = new Date().toISOString(); running.error = message; }
    job.error = { code: 'ANALYSIS_FAILED', message, recoverable: true };
    if ((job.executionAttempts ?? 0) < 3) {
      job.status = 'uploaded'; job.progressLabel = `分析失败，${2 ** (job.executionAttempts ?? 1)}秒后自动重试`; job.updatedAt = new Date().toISOString(); await this.repository.updateJob(job);
      setTimeout(() => void this.process(id), 2 ** (job.executionAttempts ?? 1) * 1000);
    } else await this.save(job, 'failed', job.progress, '分析失败，请人工重试');
  }
  private async requireAnyJob(id: string) { const job = await this.repository.getJob(id); if (!job) throw new Error('Analysis not found'); return job; }
  private async requireJob(id: string, actor: RequestActor) { const job = await this.requireAnyJob(id); if (job.organizationId !== actor.organizationId || (actor.role !== 'admin' && job.createdBy !== actor.userId)) throw new Error('Analysis not found'); return job; }
  private async audit(actor: RequestActor, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) { await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action, targetType, targetId, metadata, createdAt: new Date().toISOString() }); }
}
