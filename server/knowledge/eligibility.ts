import type { KnowledgeEntry } from '../../shared/contracts.js';

const STRUCTURED_TEXT_KEYS = [
  'businessCategory',
  'analysisSummary',
  'sourceFileName',
  'purpose',
  'description',
] as const;

const META_KNOWLEDGE_PATTERNS = [
  /(?:客户)?隐藏(?:信息|资料)/i,
  /(?:不要|不得|禁止).{0,16}(?:输入|提供|展示|返回|写入|泄露).{0,16}(?:AI|人工智能|销转智能体|智能体|模型)/i,
  /(?:标准答案|参考答案|预期答案|答案要点)/i,
  /智能体应(?:当)?生成的?(?:推荐)?回复/i,
  /智能体回答.{0,8}(?:合规|诚实)/i,
  /(?:AI|人工智能|销转智能体|智能体|模型).{0,16}(?:合规)?评分标准/i,
  /(?:合规)?评分标准.{0,16}(?:AI|人工智能|销转智能体|智能体|模型)/i,
  /(?:用于|用来).{0,8}(?:判断|验证|测试|评测).{0,24}(?:AI|人工智能|销转智能体|智能体|模型).{0,16}(?:分析|回答|回复).{0,12}(?:准确|正确|合规)/i,
] as const;

function retrievalText(entry: KnowledgeEntry) {
  const structuredText = STRUCTURED_TEXT_KEYS
    .map((key) => entry.structuredData?.[key])
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return `${entry.title}\n${entry.content}\n${structuredText}`.replace(/\s+/g, ' ').trim();
}

export function isKnowledgeRetrievalEligible(entry: KnowledgeEntry) {
  if (entry.structuredData?.retrievalEligible === false) return false;
  const text = retrievalText(entry);
  return !META_KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(text));
}
