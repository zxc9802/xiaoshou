import type { ClarificationQuestion, DeadlockType, DecisionStage, IntentTemperature, KnowledgeEntry, ParsedConversation, SalesAnalysisResult, SalesStyleProfile, SourceReference } from '../../shared/contracts.js';

const disclaimer = '发送前请结合客户实际情况与贵司政策微调。';
const stageLabels: Record<DecisionStage, string> = { aware: '初步了解', comparing: '有兴趣在比较', hesitating: '犹豫权衡', closing: '接近成交', lost_risk: '流失边缘' };

function fullText(transcript: ParsedConversation) { return transcript.messages.map((message) => message.text).join('\n'); }

export function buildClarifications(transcript: ParsedConversation): ClarificationQuestion[] {
  if (transcript.messages.length === 0) return [{ id: 'q-context', question: '请补充客户最后一句原话或重新上传清晰截图。' }];
  if (transcript.messages.length === 1) return [
    { id: 'q-before', question: '客户在这之前是否问过价格、效果或实施细节？' },
    { id: 'q-time', question: '客户最后一次回复是什么时候？' },
  ];
  return [];
}

export function classifyConversation(transcript: ParsedConversation) {
  const text = fullText(transcript);
  const refusalCount = (text.match(/不需要|不用了|不考虑|别联系|明确拒绝|没兴趣/g) ?? []).length;
  const highRisk = /投诉|退款|合同争议|律师|起诉|报警|情绪激动|大额承诺/.test(text);
  let deadlockType: DeadlockType = 'objection';
  if (/已读不回|没回复|没回|不回消息|沉默/.test(text)) deadlockType = 'silent';
  else if (/^(嗯|哦|看看|再说)|态度模糊|考虑一下/.test(text) || /客户[：:].*(嗯|哦|看看|再说)/.test(text)) deadlockType = 'vague';
  else if (/怎么回答|答不上|不清楚|专业问题|确认后回复/.test(text)) deadlockType = 'stuck';
  const intentTemperature: IntentTemperature = refusalCount >= 1 || /7天|没兴趣/.test(text) ? 'low' : /价格|报价|实施|售后|合同|怎么购买|付款/.test(text) ? 'high' : 'mid';
  const decisionStage: DecisionStage = refusalCount >= 2 ? 'lost_risk' : /付款|签约|最后顾虑|A方案|B方案/.test(text) ? 'closing' : /考虑|犹豫|价格高|太贵|预算/.test(text) ? 'hesitating' : /对比|别家|竞品/.test(text) ? 'comparing' : 'aware';
  const objectionType = /价格|贵|预算|报价/.test(text) ? '价格' : /效果|有用|价值/.test(text) ? '效果' : /信任|案例|资质/.test(text) ? '信任' : /领导|老板|家人|决策人/.test(text) ? '决策人' : /时机|以后|暂时/.test(text) ? '时机' : '其他';
  return { deadlockType, intentTemperature, decisionStage, objectionType, refusalCount, highRisk };
}

function references(knowledge: KnowledgeEntry[], deadlockType: DeadlockType): SourceReference[] {
  const published = knowledge.filter((entry) => entry.status === 'published' && (entry.layer === 'L1' || entry.layer === 'L2' || entry.layer === 'L3')).filter((entry) => entry.layer !== 'L2' || entry.structuredData?.deadlockType === deadlockType || entry.category.includes('价格'));
  return published.slice(0, 5).map((entry) => ({ id: entry.id, category: entry.category.includes('政策') ? '价格政策' : entry.category.includes('案例') ? '客户案例' : entry.layer === 'L3' ? '产品资料' : '销售规则', title: entry.title, version: entry.version, excerpt: entry.content, verified: true }));
}

function generateReply(classification: ReturnType<typeof classifyConversation>) {
  if (classification.highRisk) return { reply: '确实给您带来不便了，这件事我非常重视。我先把情况完整记录并马上请负责人介入，今天会给您一个明确的处理进展，可以吗？', action: '立即暂停销售推进，整理事实并升级给上级或人工流程。' };
  if (classification.refusalCount >= 2) return { reply: '明白，也谢谢您直接告诉我。那我先不打扰您了，后续如果情况有变化或需要了解相关信息，随时联系我就好。', action: '停止追单，进入长周期培育，至少一个月后再以非销售内容轻触达。' };
  if (classification.deadlockType === 'silent') return { reply: '不着急，我补充一份和您当前情况更相关的资料，您有空时看看就好。如果方便，我周四再和您确认一下是否有需要进一步说明的地方？', action: '根据沉默时长提供一次有价值的信息，并约定低压力跟进节点。' };
  if (classification.deadlockType === 'vague') return { reply: '理解，我不继续给您堆信息了。想确认一下，您现在更关心最终效果，还是整体预算？您选一个，我只针对这一点说明。', action: '用二选一降低客户回复成本，避免继续泛讲。' };
  if (classification.deadlockType === 'stuck') return { reply: '这个问题很重要，我不想现场给您一个不准确的答案。我现在去和产品同事确认清楚，今天下午3点前准确回复您，可以吗？', action: '记录专业问题并明确内部确认人和回复时间。' };
  return { reply: '理解，单纯比较采购价格的话，我们确实不一定是最低的。我想先确认一下：您目前觉得贵，主要是预算确实超出了，还是还没有看到足够的价值差异？您告诉我是哪一种，我再针对性说明。', action: '确认价格异议属于预算不足还是价值感知不足，确认前不主动降价。' };
}

function personalStyle(knowledge: KnowledgeEntry[], userId?: string): SalesStyleProfile | undefined {
  if (!userId) return undefined;
  const data = knowledge.find((entry) => entry.layer === 'L4' && entry.status === 'published' && entry.structuredData?.ownerId === userId)?.structuredData;
  if (!data) return undefined;
  return {
    customerAddressing: String(data.customerAddressing ?? ''),
    commonParticles: Array.isArray(data.commonParticles) ? data.commonParticles.map(String) : [],
    emojis: Array.isArray(data.emojis) ? data.emojis.map(String) : [],
    punctuation: data.punctuation === '简洁' || data.punctuation === '正式' ? data.punctuation : '自然',
    messageSplitting: data.messageSplitting === '分条' ? '分条' : '单条',
    referenceMessages: Array.isArray(data.referenceMessages) ? data.referenceMessages.map(String) : [],
  };
}

function applyStyle(reply: string, profile: SalesStyleProfile | undefined, highRisk: boolean) {
  if (highRisk) return reply.replace(/[😀-🙏]/gu, '').replace(/！/g, '。');
  if (!profile) return reply;
  let styled = profile.customerAddressing && !reply.startsWith(profile.customerAddressing) ? `${profile.customerAddressing}，${reply}` : reply;
  if (profile.punctuation === '正式') styled = styled.replace(/[～~]/g, '').replace(/！/g, '。');
  if (profile.punctuation === '简洁') styled = styled.replace(/。/g, '，').replace(/，+$/g, '。');
  if (profile.messageSplitting === '分条') styled = styled.split(/(?<=[。？！])/).filter(Boolean).slice(0, 4).join('\n');
  const emoji = profile.emojis.find((item) => item.trim());
  if (emoji && !styled.includes(emoji)) styled = `${styled}${emoji}`;
  return styled;
}

export function analyzeWithRules(transcript: ParsedConversation, knowledge: KnowledgeEntry[], clarifications: ClarificationQuestion[] = [], userId?: string): SalesAnalysisResult {
  const classification = classifyConversation(transcript);
  const sourceReferences = references(knowledge, classification.deadlockType);
  const hasPublishedFacts = knowledge.some((entry) => entry.layer === 'L3' && entry.status === 'published');
  const salesMessages = transcript.messages.filter((message) => message.role === 'sales');
  const configuredStyle = personalStyle(knowledge, userId);
  const generated = generateReply(classification);
  let recommendedReply = applyStyle(generated.reply, configuredStyle, classification.highRisk);
  if (!hasPublishedFacts && /价格|折扣|优惠|案例|效果|实施周期/.test(recommendedReply)) recommendedReply = '这个问题需要以已审核资料为准。我先为您核实【待补充：对应产品或价格依据】，确认后给您准确回复，可以吗？';
  const stage = stageLabels[classification.decisionStage];
  const styleFallbackUsed = !configuredStyle && salesMessages.length < 2;
  const warnings = [transcript.containsSensitiveData ? `检测到${transcript.sensitiveDataTypes.join('、')}，输出已脱敏。` : '', classification.highRisk ? '该场景需升级人工或上级处理，AI仅提供缓冲话术。' : '', !hasPublishedFacts ? '资料库中未找到已审核依据，请勿直接向客户承诺，建议咨询产品或售前人员。' : '', styleFallbackUsed ? '销售发言少于2条，已使用通用微信口吻。' : '', disclaimer].filter(Boolean);
  return {
    generationMode: 'rules',
    parsedConversation: transcript,
    deadlockType: classification.deadlockType,
    intentTemperature: classification.intentTemperature,
    decisionStage: classification.decisionStage,
    objectionType: classification.objectionType,
    clarificationQuestions: clarifications,
    situationAnalysis: `${stage}，当前主要属于${classification.deadlockType === 'objection' ? `${classification.objectionType}异议` : classification.deadlockType === 'silent' ? '客户沉默' : classification.deadlockType === 'vague' ? '态度模糊' : '专业问题卡点'}。`,
    salesStrategy: classification.highRisk
      ? { name: '风险缓冲与人工升级', reason: '当前场景风险高于成交推进，应先稳定情绪并交由人工处理。', conversionGoal: '获得客户同意由负责人继续处理', techniques: ['情绪承接', '明确升级'] }
      : classification.refusalCount >= 2
        ? { name: '尊重拒绝与长期培育', reason: '客户已经连续明确拒绝，继续追单会破坏信任。', conversionGoal: '得体结束并保留未来联系空间', techniques: ['尊重边界', '低压力收尾'] }
        : { name: classification.objectionType === '价格' ? '异议隔离与价值重构' : '风险承接与低门槛推进', reason: '客户仍在互动，核心不是缺少更多介绍，而是需要降低决策风险。', conversionGoal: '让客户说出最真实的一个顾虑并愿意继续沟通', techniques: ['承接顾虑', '直接回应', '价值重构', '微承诺推进'] },
    followupAction: generated.action,
    riskLevel: classification.highRisk ? 'high' : transcript.containsSensitiveData || classification.refusalCount >= 2 ? 'medium' : 'low',
    handoffRequired: classification.highRisk,
    styleFallbackUsed,
    fixedDisclaimer: disclaimer,
    stage,
    stageEvidence: `根据对话中的${classification.objectionType}信号、客户互动程度和最后推进状态判断。`,
    stageConfidence: transcript.requiresConfirmation ? 65 : 86,
    explicitNeeds: [classification.objectionType === '价格' ? '确认产品投入是否值得，并判断预算是否匹配。' : '获得与当前顾虑直接相关的明确说明。'],
    implicitNeedHypotheses: [{ statement: classification.objectionType === '价格' ? '假设：客户可能并非完全没有预算，而是尚未看到价格差异对应的业务价值。' : '假设：客户需要降低决策风险，而不只是获取更多功能信息。', confidence: 78, evidence: '客户仍在互动或询问细节，但没有进入明确成交动作。', validationQuestion: '您目前更担心实际预算压力，还是还没有看到足够的价值差异？' }],
    salesLoopIssue: { type: classification.deadlockType === 'objection' ? '价值沟通错位' : '推进方式不匹配', problem: '销售当前的表达没有直接回应客户最核心的决策顾虑。', reason: '继续补充功能或重复追问会增加客户沟通成本，无法形成新的决策依据。' },
    replyGoal: generated.action,
    recommendedReply,
    alternativeReplies: [
      { tone: '简洁', content: recommendedReply.replace('我想先确认一下：', '想确认一下：') },
      { tone: '柔和', content: `能理解您的顾虑。${recommendedReply}` },
      { tone: '更有推进感', content: `${recommendedReply} 我们也可以约10分钟，只把这一点确认清楚。` },
    ],
    nextBranches: [
      { customerReply: '客户愿意说明真实顾虑', nextAction: '只围绕该顾虑提供一个有依据的信息。', suggestedLine: '明白，我只针对您最关心的这一点说明。' },
      { customerReply: '客户仍然态度模糊', nextAction: '降低回复成本，约定下一次具体节点。', suggestedLine: '可以，我整理成一页，周四再用十分钟和您确认，方便吗？' },
    ],
    sourceReferences,
    warnings,
  };
}
