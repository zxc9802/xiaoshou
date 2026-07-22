import type { CustomerDealStatus, CustomerProfile } from '../shared/contracts.js';
import type { StoredAnalysisJob } from './domain.js';

function conversationText(job: StoredAnalysisJob) {
  return job.transcript?.messages.map((message) => message.text).join('\n') || job.request.conversation;
}

function latestMessage(job: StoredAnalysisJob) {
  return job.transcript?.lastMessage || job.request.conversation.split(/\n+/).map((line) => line.trim()).filter(Boolean).at(-1)?.replace(/^(客户|销售|我|我们)[：:]\s*/, '') || '等待补充客户对话';
}

function firstMatch(text: string, pattern: RegExp) {
  return text.match(pattern)?.[1]?.trim();
}

function inferredDealStatus(jobs: StoredAnalysisJob[], latest: StoredAnalysisJob): CustomerDealStatus {
  if (latest.customerDealStatus) return latest.customerDealStatus;
  const text = jobs.map(conversationText).join('\n');
  return /已付款|已经付款|已打款|打款了|签约了|合同已签|已经下单|确认下单|成交了|已成交/.test(text) ? 'won' : 'unwon';
}

function extractDisplayName(text: string) {
  const match = text.match(/([\u4e00-\u9fa5]{1,3})(总|先生|女士|老师)(?=您好|好|[，,。！!\s])/);
  return match ? `${match[1]}${match[2]}` : undefined;
}

function normalizedIdentity(value?: string) {
  return value?.trim().toLowerCase().replace(/[\s·•._-]+/g, '');
}

function identityNames(job: StoredAnalysisJob) {
  const identity = job.customerIdentity ?? job.transcript?.customerIdentity;
  return [job.customerManualRemark, identity?.remarkName, identity?.nickname, identity?.displayName, extractDisplayName(conversationText(job))]
    .map(normalizedIdentity).filter((value): value is string => Boolean(value));
}

function hashesMatch(left: string, right: string) {
  if (left === right) return true;
  if (!left.startsWith('avatar:') || !right.startsWith('avatar:')) return false;
  const a = left.slice(7); const b = right.slice(7);
  if (a.length !== b.length) return false;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const xor = Number.parseInt(a[index]!, 16) ^ Number.parseInt(b[index]!, 16);
    distance += xor.toString(2).replace(/0/g, '').length;
  }
  return distance <= 24;
}

/** Returns a profile only for one unambiguous match. Ambiguous names are left for confirmation. */
export function findMatchingCustomerProfileId(current: StoredAnalysisJob, jobs: StoredAnalysisJob[]) {
  const identity = current.customerIdentity ?? current.transcript?.customerIdentity;
  if (!identity) return { matchStatus: 'new' as const, possibleProfileIds: [] as string[] };
  const existing = jobs.filter((job) => job.id !== current.id);
  const hashes = identity.identityHashes;
  const strong = new Set(existing.filter((job) => (job.customerIdentity ?? job.transcript?.customerIdentity)?.identityHashes.some((hash) => hashes.some((candidate) => hashesMatch(candidate, hash)))).map((job) => job.customerProfileId ?? job.id));
  if (strong.size === 1) return { profileId: [...strong][0], matchStatus: 'matched' as const, possibleProfileIds: [] as string[] };

  const names = new Set(identityNames(current));
  const company = normalizedIdentity(identity.company);
  const nameMatches = new Set(existing.filter((job) => {
    if (!identityNames(job).some((name) => names.has(name))) return false;
    const otherCompany = normalizedIdentity((job.customerIdentity ?? job.transcript?.customerIdentity)?.company);
    return !company || !otherCompany || company === otherCompany;
  }).map((job) => job.customerProfileId ?? job.id));
  if (nameMatches.size === 1) return { profileId: [...nameMatches][0], matchStatus: 'matched' as const, possibleProfileIds: [] as string[] };
  const possibleProfileIds = [...new Set([...strong, ...nameMatches])];
  return { matchStatus: possibleProfileIds.length ? 'needs_confirmation' as const : 'new' as const, possibleProfileIds };
}

export function buildCustomerProfiles(jobs: StoredAnalysisJob[], now = new Date()): CustomerProfile[] {
  const grouped = new Map<string, StoredAnalysisJob[]>();
  for (const job of jobs) {
    const profileId = job.customerProfileId ?? job.id;
    const items = grouped.get(profileId) ?? [];
    items.push(job);
    grouped.set(profileId, items);
  }

  return [...grouped.entries()].map(([id, items]) => {
    items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const latest = items[items.length - 1]!;
    const progressJob = [...items].reverse().find((item) => item.lastProgressAt);
    const reminderJob = [...items].reverse().find((item) => item.nextFollowUpAt);
    const lastProgressAt = progressJob?.lastProgressAt ?? latest.createdAt;
    const nextFollowUpAt = reminderJob?.nextFollowUpAt ?? new Date(Date.parse(lastProgressAt) + 72 * 60 * 60 * 1000).toISOString();
    const dealStatus = inferredDealStatus(items, latest);
    const followUpDue = dealStatus === 'unwon' && Date.parse(nextFollowUpAt) <= now.getTime();
    const followUpOverdueDays = followUpDue ? Math.max(0, Math.floor((now.getTime() - Date.parse(nextFollowUpAt)) / (24 * 60 * 60 * 1000))) : 0;
    const identityJob = [...items].reverse().find((item) => item.customerIdentity || item.transcript?.customerIdentity);
    const identity = identityJob?.customerIdentity ?? identityJob?.transcript?.customerIdentity;
    const avatarJob = [...items].reverse().find((item) => item.customerAvatarKey);
    const manualRemark = [...items].reverse().find((item) => item.customerManualRemark)?.customerManualRemark;
    const text = conversationText(latest);
    const displayName = extractDisplayName(text);
    const rawCompany = firstMatch(text, /([\u4e00-\u9fa5A-Za-z0-9（）()·-]{2,28}(?:公司|企业|工厂|机构|工作室))/);
    const company = identity?.company || (rawCompany && !/^(我们公司|咱们公司|贵司|公司)$/.test(rawCompany) ? rawCompany : undefined);
  const location = firstMatch(text, /(?:我们|我)?(?:在|来自)([\u4e00-\u9fa5]{2,8}?)(?=做|经营|开|，|,)/);
    const industry = firstMatch(text, /(?:做|经营|从事)([\u4e00-\u9fa5A-Za-z0-9]{2,18})(?=，|,|。|\s)/);
    const teamSizeText = firstMatch(text, /(\d{1,5})\s*(?=个人|人|名员工)/);
    const teamSize = teamSizeText ? Number(teamSizeText) : undefined;
    const fallbackName = [location, industry].filter(Boolean).join('') || `客户档案 ${id.slice(0, 6).toUpperCase()}`;
    return {
      id,
      displayName: manualRemark ?? identity?.remarkName ?? identity?.displayName ?? identity?.nickname ?? displayName ?? company ?? fallbackName,
      nickname: identity?.nickname,
      remarkName: identity?.remarkName,
      manualRemark,
      avatarUrl: avatarJob ? `/api/v1/customers/${encodeURIComponent(id)}/avatar?v=${encodeURIComponent(avatarJob.updatedAt)}` : undefined,
      identityConfidence: identity?.confidence,
      company,
      location,
      industry,
      teamSize,
      ownerId: latest.createdBy,
      dealStatus,
      decisionStage: latest.result?.decisionStage ?? 'aware',
      stage: latest.result?.stage ?? '待分析',
      stageConfidence: latest.result?.stageConfidence,
      intentTemperature: latest.result?.intentTemperature,
      summary: latest.result?.situationAnalysis ?? '已收到客户对话，完成分析后将自动补充客户阶段、需求和跟进重点。',
      explicitNeeds: latest.result?.explicitNeeds ?? [],
      latestMessage: latestMessage(latest),
      latestAnalysisId: latest.id,
      conversationCount: items.length,
      lastProgressAt,
      nextFollowUpAt,
      followUpDue,
      followUpOverdueDays,
      tags: [],
      archived: false,
      confirmationStatus: 'confirmed' as const,
      createdAt: items[0]!.createdAt,
      updatedAt: latest.updatedAt,
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
