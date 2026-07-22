import type { KnowledgeEntry, KnowledgeStatus } from '../../shared/contracts.js';

const systemTimestamp = '2026-01-01T00:00:00.000Z';

function systemEntry(
  systemKey: string,
  layer: KnowledgeEntry['layer'],
  category: string,
  title: string,
  content: string,
  version: string,
  structuredData: Record<string, unknown> = {},
  status: KnowledgeStatus = 'published',
): KnowledgeEntry {
  return {
    id: `system-${systemKey}`,
    origin: 'system',
    systemKey,
    locked: true,
    layer,
    category,
    title,
    content,
    version,
    status,
    reviewer: '系统内置',
    publishedAt: status === 'published' ? systemTimestamp : undefined,
    createdAt: systemTimestamp,
    updatedAt: systemTimestamp,
    structuredData: { ...structuredData, systemManaged: true },
  };
}

const salesSkill = { businessCategory: '销售技巧' };

export const DEFAULT_KNOWLEDGE: KnowledgeEntry[] = [
  systemEntry('l0-fact-commitment', 'L0', '安全红线', '事实与承诺红线', '不得编造价格、优惠、效果、资质、案例数据；不得贬低竞品、虚假承诺、压迫逼单或伪造稀缺。', '1.0'),
  systemEntry('l1-wechat-output', 'L1', '输出规则', '微信销售回复格式', '局面分析1至2句；建议回复不超过4行、口语化且一次只说一件事；必须包含提问、二选一或明确约定。', '1.0', salesSkill),

  systemEntry('l2-price-objection', 'L2', '价格异议', '价格异议处理策略', '先判断客户关注的是预算限制、价格比较还是价值不足。高意向强调投入产出，中意向补齐价值证据，低意向用“预算还是需求”的二选一降低回复成本；没有企业价格依据时不得承诺折扣。', '2.2', { ...salesSkill, deadlockType: 'objection', objectionType: '价格' }),
  systemEntry('l2-silent-reactivation', 'L2', '已读不回', '沉默客户激活策略', '1至3天提供与客户问题直接相关的新价值；3至7天用简短案例、清单或新问题重启；7天以上得体收尾并进入长周期培育，不连续催促。', '1.1', { ...salesSkill, deadlockType: 'silent' }),
  systemEntry('l2-vague-choice', 'L2', '态度模糊', '低成本二选一策略', '客户只回复“嗯、哦、看看”时，不继续堆信息；围绕客户当前最可能关心的两个方向给出二选一问题，缩小话题并降低回复成本。', '1.1', { ...salesSkill, deadlockType: 'vague' }),
  systemEntry('l2-expert-buffer', 'L2', '专业问题', '缓冲与确认策略', '销售被专业问题问住时，先确认问题和重要性，明确自己将向谁核实以及准确回复时间；不得现场猜测，不用模糊承诺掩盖信息不足。', '1.1', { ...salesSkill, deadlockType: 'stuck' }),

  systemEntry('l2-first-contact-permission', 'L2', '初次沟通', '初次沟通与客户许可', '首次沟通先说明联系缘由和可能价值，再用一个低压力问题确认客户是否愿意继续；不要一上来长篇介绍产品，也不要连续追问。', '1.0', salesSkill),
  systemEntry('l2-situation-problem-impact-goal', 'L2', '需求挖掘', '客户现状、问题、影响和目标提问', '按“现在怎么做—哪里不顺—造成什么影响—希望变成什么样”逐层提问。每轮只问一个关键问题，并复述客户原话确认理解。', '1.0', salesSkill),
  systemEntry('l2-explicit-implicit-validation', 'L2', '需求验证', '显性需求与深层需求验证', '客户明确表达的是显性需求；对预算、风险、效率或决策压力的判断只能标记为假设，并用中性问题验证，不能把推测当成客户事实。', '1.0', salesSkill),
  systemEntry('l2-decision-process', 'L2', '决策链', '决策人、影响人和决策流程确认', '确认谁使用、谁评估、谁审批以及决策所需材料和时间点。避免直接追问“谁说了算”，可询问“通常还需要哪些同事一起评估”。', '1.0', salesSkill),
  systemEntry('l2-qualification-window', 'L2', '客户判断', '预算、优先级和时间窗口判断', '通过业务优先级、计划启动时间和预算方式判断机会成熟度。信息不足时先问时间和优先级，不把“暂时没预算”等同于永远没有需求。', '1.0', salesSkill),
  systemEntry('l2-value-mapping', 'L2', '价值表达', '产品能力与客户价值映射', '只介绍与客户已确认问题直接相关的能力，使用“客户问题—能力—可验证结果”的结构；没有审核依据时只说明解决思路，不承诺具体效果。', '1.0', salesSkill),
  systemEntry('l2-evidence-credibility', 'L2', '信任建立', '证据、案例和可信度表达', '优先使用已审核的产品资料、案例和实施证据。说明案例适用条件和差异，不把个别案例结果泛化为所有客户都能获得的结果。', '1.0', salesSkill),
  systemEntry('l2-neutral-competitor', 'L2', '竞品比较', '中立竞品比较方法', '先确认客户比较维度，再基于已审核资料说明适用场景和差异；不得贬低竞品、猜测竞品能力或虚构对比结论。资料不足时邀请客户提供其关注标准。', '1.0', salesSkill),
  systemEntry('l2-trust-objection', 'L2', '信任异议', '客户信任异议处理', '遇到“你们靠谱吗、能不能落地”等问题，先承认客户需要验证，再询问信任顾虑来自资质、经验、交付还是效果，并提供对应的已审核证据。', '1.0', salesSkill),
  systemEntry('l2-consider-followup', 'L2', '拖延异议', '“我再考虑一下”跟进策略', '不立即逼单，先确认客户还需要考虑的是价值、风险、内部意见还是时机；约定一个明确但低压力的下一步和时间，避免无期限等待。', '1.0', salesSkill),
  systemEntry('l2-send-material', 'L2', '资料请求', '“先发资料看看”推进策略', '先确认客户最想了解的一个问题，再发送最相关且已审核的资料；同时约定查看后的反馈方式或下次沟通时间，避免只发一堆文件后失联。', '1.0', salesSkill),
  systemEntry('l2-low-urgency', 'L2', '优先级异议', '缺少紧迫性的处理方法', '客户认可价值但不着急时，确认不推进的真实原因和等待成本；只使用客户认可的数据讨论优先级，不制造虚假稀缺或恐惧。', '1.0', salesSkill),
  systemEntry('l2-internal-report', 'L2', '内部推动', '帮助客户进行内部汇报', '把客户已确认的问题、目标、选择依据、风险和下一步整理成简短材料，帮助联系人向内部沟通；不得替客户虚构预算、领导意见或审批结果。', '1.0', salesSkill),
  systemEntry('l2-next-step-close', 'L2', '推进收口', '下一步承诺与沟通收口', '每轮沟通只推动一个可执行动作，例如确认需求、补充资料、安排演示或约定复聊时间。结束前明确双方动作、负责人和时间，避免以“有需要再联系”收尾。', '1.0', salesSkill),

  systemEntry('demo-enterprise-product', 'L3', '产品资料', '企业版产品说明', '企业版支持分阶段实施，可结合客户组织规模制定上线节奏。', '3.2', { product: '企业版', facts: ['支持分阶段实施'], demoDisabled: true }, 'archived'),
  systemEntry('demo-price-policy', 'L3', '价格政策', '2026年标准价格政策', '报价须遵循标准版本配置；折扣或特殊方案需按权限完成审批。', '2026.1', { requiresApproval: true, demoDisabled: true }, 'archived'),
  systemEntry('demo-sales-commitment', 'L3', '企业红线', '企业销售承诺规范', '未完成审批不得承诺折扣、最终价格、确定效果和实施周期。', '1.0', { demoDisabled: true }, 'archived'),
];

export const ACTIVE_SYSTEM_KNOWLEDGE = DEFAULT_KNOWLEDGE.filter((entry) => !entry.structuredData?.demoDisabled);
export const SYSTEM_KNOWLEDGE_TITLES = new Set(DEFAULT_KNOWLEDGE.map((entry) => entry.title));
export const RETIRED_SYSTEM_KNOWLEDGE_KEYS = new Set(['l0-refusal-risk']);
