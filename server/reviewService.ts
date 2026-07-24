import { randomUUID } from 'node:crypto';
import type { ConversationReview, KnowledgeEntry, ReviewMetrics, ReviewOutcome } from '../shared/contracts.js';
import type { FeedbackRecord, Repository, RequestActor, StoredAnalysisJob, StoredConversationReview } from './domain.js';

const stageRank: Record<string, number> = { aware: 1, comparing: 2, hesitating: 3, closing: 4, lost_risk: 0 };
const intentRank: Record<string, number> = { low: 0, mid: 1, high: 2 };

function customerName(job: StoredAnalysisJob) {
  return job.customerManualRemark || job.customerIdentity?.remarkName || job.customerIdentity?.displayName || job.customerIdentity?.nickname || `客户 ${String(job.customerProfileId ?? job.id).slice(0, 6).toUpperCase()}`;
}

function latestCustomerReply(job?: StoredAnalysisJob) {
  return [...(job?.transcript?.messages ?? [])].reverse().find((message) => message.role === 'customer')?.text;
}

function outcome(before: StoredAnalysisJob, after?: StoredAnalysisJob): ReviewOutcome {
  if (after?.customerDealStatus === 'won' || before.customerDealStatus === 'won') return 'won';
  if (!after?.result || !before.result) return 'unknown';
  if (after.result.decisionStage === 'lost_risk' && before.result.decisionStage !== 'lost_risk') return 'regressed';
  const stageDelta = (stageRank[after.result.decisionStage] ?? 0) - (stageRank[before.result.decisionStage] ?? 0);
  const intentDelta = (intentRank[after.result.intentTemperature] ?? 0) - (intentRank[before.result.intentTemperature] ?? 0);
  if (stageDelta > 0 || intentDelta > 0) return 'progressed';
  if (stageDelta < 0 || intentDelta < 0) return 'regressed';
  return 'unchanged';
}

function latestFeedback(records: FeedbackRecord[], analysisId: string) {
  return records.filter((record) => record.analysisId === analysisId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export class ReviewService {
  constructor(
    private readonly repository: Repository,
    private readonly analysisKnowledgeEnabled = false,
  ) {}

  private async synchronize(actor: RequestActor) {
    const [jobs, feedback, existing] = await Promise.all([
      this.repository.listJobs(actor.organizationId, 10_000),
      this.repository.listFeedback(actor.organizationId),
      this.repository.listReviews(actor.organizationId),
    ]);
    const existingById = new Map(existing.map((review) => [review.id, review]));
    const grouped = new Map<string, StoredAnalysisJob[]>();
    for (const job of jobs.filter((item) => item.result)) {
      const profileId = job.customerProfileId ?? job.id;
      grouped.set(profileId, [...(grouped.get(profileId) ?? []), job]);
    }
    for (const [profileId, profileJobs] of grouped) {
      profileJobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (let index = 0; index < profileJobs.length; index += 1) {
        const before = profileJobs[index]!;
        const after = profileJobs[index + 1];
        const feedbackRecord = latestFeedback(feedback, before.id);
        const important = Boolean(after || feedbackRecord || before.status === 'handoff' || before.result?.riskLevel === 'high' || before.customerDealStatus === 'won');
        if (!important || !before.result) continue;
        const id = `review-${before.id}`;
        const current = existingById.get(id);
        const now = new Date().toISOString();
        const next: StoredConversationReview = {
          id,
          organizationId: actor.organizationId,
          createdBy: before.createdBy,
          customerProfileId: profileId,
          customerName: customerName(after ?? before),
          beforeAnalysisId: before.id,
          afterAnalysisId: after?.id,
          status: current?.status ?? 'pending',
          aiOutcome: outcome(before, after),
          confirmedOutcome: current?.confirmedOutcome,
          adoption: feedbackRecord?.outcome ?? current?.adoption ?? 'unreported',
          stageBefore: before.result.stage,
          stageAfter: after?.result?.stage,
          problem: before.result.situationAnalysis,
          strategyName: before.result.salesStrategy?.name ?? before.result.salesLoopIssue.type,
          strategyReason: before.result.salesStrategy?.reason ?? before.result.replyGoal,
          techniques: before.result.salesStrategy?.techniques ?? [],
          recommendedReply: before.result.recommendedReply,
          actualReply: feedbackRecord?.editedReply ?? current?.actualReply,
          customerResponse: latestCustomerReply(after) ?? current?.customerResponse,
          product: before.request.product,
          deadlockType: before.result.deadlockType,
          objectionType: before.result.objectionType,
          diagnosis: current?.diagnosis ?? [],
          note: current?.note,
          riskLevel: before.result.riskLevel,
          knowledgeGap: this.analysisKnowledgeEnabled
            ? before.result.sourceReferences.filter((source) => source.verified).length === 0
            : current?.knowledgeGap ?? false,
          knowledgeCandidateId: current?.knowledgeCandidateId,
          createdAt: current?.createdAt ?? before.createdAt,
          updatedAt: now,
        };
        if (!current || JSON.stringify(current) !== JSON.stringify(next)) await this.repository.upsertReview(next);
        existingById.set(id, next);
      }
    }
    return [...existingById.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async list(actor: RequestActor) { return this.synchronize(actor); }

  async get(actor: RequestActor, id: string) {
    await this.synchronize(actor);
    const review = await this.repository.getReview(actor.organizationId, id);
    if (!review) throw new Error('复盘记录不存在');
    return review;
  }

  async confirmOutcome(actor: RequestActor, id: string, confirmedOutcome: ReviewOutcome, actualReply?: string) {
    const review = await this.get(actor, id);
    const updated = { ...review, confirmedOutcome, actualReply: actualReply?.trim() || review.actualReply, status: 'confirmed' as const, updatedAt: new Date().toISOString() };
    await this.repository.upsertReview(updated);
    return updated;
  }

  async saveDiagnosis(actor: RequestActor, id: string, diagnosis: string[], note?: string) {
    const review = await this.get(actor, id);
    const updated = { ...review, diagnosis: [...new Set(diagnosis)].slice(0, 6), note: note?.trim(), updatedAt: new Date().toISOString() };
    await this.repository.upsertReview(updated);
    return updated;
  }

  async promote(actor: RequestActor, id: string) {
    const review = await this.get(actor, id);
    if (review.knowledgeCandidateId) return review;
    const now = new Date().toISOString();
    const effectiveOutcome = review.confirmedOutcome ?? review.aiOutcome;
    if (!['progressed', 'won'].includes(effectiveOutcome)) throw new Error('只有确认有效推进或成交的复盘才能沉淀为技巧');
    const knowledge: KnowledgeEntry = {
      id: randomUUID(), origin: 'manual', locked: false, layer: 'L2', category: '复盘沉淀',
      title: review.strategyName || `${review.customerName}沟通推进技巧`,
      content: [`适用情境：${review.problem}`, `关键策略：${review.strategyReason}`, `可复用动作：${review.techniques.join('、') || '结合客户真实顾虑推进一个低门槛下一步'}`, `有效话术：${review.actualReply || review.recommendedReply}`, '使用边界：必须结合客户实际情况与已审核企业资料，不得虚构事实或承诺。'].join('\n'),
      version: '1.0', status: 'in_review', reviewer: actor.userId,
      structuredData: { businessCategory: '销售技巧', sourceReviewId: review.id, requiresHumanConfirmation: true, reviewOutcome: effectiveOutcome },
      createdAt: now, updatedAt: now,
    };
    await this.repository.createKnowledge(actor.organizationId, knowledge);
    const updated = { ...review, knowledgeCandidateId: knowledge.id, updatedAt: now };
    await this.repository.upsertReview(updated);
    return updated;
  }

  async metrics(actor: RequestActor): Promise<ReviewMetrics> {
    const reviews = await this.synchronize(actor);
    const confirmed = reviews.filter((review) => (review.confirmedOutcome ?? review.aiOutcome) !== 'unknown');
    const effective = confirmed.filter((review) => ['progressed', 'won'].includes(review.confirmedOutcome ?? review.aiOutcome));
    const adopted = reviews.filter((review) => review.adoption === 'adopted' || review.adoption === 'edited_adopted');
    const feedback = reviews.filter((review) => review.adoption !== 'unreported' && review.adoption !== 'saved_review');
    const rescued = new Set(effective.filter((review) => /犹豫|流失|沉默/.test(review.stageBefore)).map((review) => review.customerProfileId));
    return {
      pendingCount: reviews.filter((review) => review.status === 'pending').length,
      effectiveProgressRate: confirmed.length ? Math.round(effective.length / confirmed.length * 100) : 0,
      rescuedCustomers: rescued.size,
      adoptionRate: feedback.length ? Math.round(adopted.length / feedback.length * 100) : 0,
      knowledgeGapCount: this.analysisKnowledgeEnabled ? reviews.filter((review) => review.knowledgeGap).length : 0,
      totalReviews: reviews.length,
    };
  }
}
