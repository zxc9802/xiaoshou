import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeEntry } from '../../shared/contracts.js';
import { isKnowledgeRetrievalEligible } from './eligibility.js';

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = '2026-07-24T00:00:00.000Z';
  return {
    id: 'entry-1',
    layer: 'L3',
    category: '产品资料',
    title: '轻茶产品定位',
    content: '轻茶不是减肥药，是一款低负担日常饮品。',
    version: '1.0',
    status: 'published',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('explicit retrievalEligible false always excludes an entry', () => {
  assert.equal(isKnowledgeRetrievalEligible(entry({
    structuredData: { retrievalEligible: false },
  })), false);
});

test('high-confidence answer keys and AI evaluation instructions are excluded', () => {
  const excluded = [
    entry({ title: '十一、客户隐藏信息', content: '本节不要输入给销转智能体。它用于判断AI分析是否准确。' }),
    entry({ id: 'entry-2', title: '十三、智能体应生成的推荐回复', content: '这里给出本题预期答案。' }),
    entry({ id: 'entry-3', title: '减肥茶销转智能体合规评分标准', content: '按以下维度给智能体回答打分。' }),
    entry({ id: 'entry-4', title: '测试说明', content: '以下内容用于评测 AI 回复是否正确。' }),
    entry({ id: 'entry-5', title: '智能体回答合规、诚实', content: '回答不得夸大产品效果。' }),
  ];

  assert.deepEqual(excluded.map(isKnowledgeRetrievalEligible), [false, false, false, false, false]);
});

test('real compliance, tactics, and product facts remain eligible', () => {
  const eligible = [
    entry({ title: '产品宣传合规要求', content: '不得承诺治疗效果，不得虚构用户案例。' }),
    entry({ id: 'entry-2', layer: 'L2', category: '销售技巧', title: '价格异议处理', content: '先确认预算，再解释产品价值。' }),
    entry({ id: 'entry-3', title: '普通乌龙茶竞品区别', content: '普通乌龙茶强调茶味，轻茶强调低负担饮用体验。' }),
  ];

  assert.deepEqual(eligible.map(isKnowledgeRetrievalEligible), [true, true, true]);
});
