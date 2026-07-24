import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReviewCenterPage } from '../src/components/ReviewCenterPage.js';
import { SalesCoachResult } from '../src/components/SalesCoachResult.js';
import { parseConversationText } from './model/conversationParser.js';
import { analyzeWithRules } from './rules/analysisEngine.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const result = analyzeWithRules(parseConversationText('客户：价格有点高\n销售：我了解一下'), []);

test('disabled analysis UI hides knowledge sources and gap copy', () => {
  const resultHtml = renderToStaticMarkup(createElement(SalesCoachResult as any, {
    result,
    analysisKnowledgeEnabled: false,
  }));
  const reviewHtml = renderToStaticMarkup(createElement(ReviewCenterPage as any, {
    onBack: () => undefined,
    analysisKnowledgeEnabled: false,
  }));

  assert.doesNotMatch(resultHtml, /依据来源和风险提醒|依据企业规则及已审核资料|资料库中未找到/);
  assert.doesNotMatch(reviewHtml, /知识缺口|缺少已审核依据/);
});

test('enabled analysis UI retains knowledge source and gap sections', () => {
  const resultHtml = renderToStaticMarkup(createElement(SalesCoachResult as any, {
    result,
    analysisKnowledgeEnabled: true,
  }));
  const reviewHtml = renderToStaticMarkup(createElement(ReviewCenterPage as any, {
    onBack: () => undefined,
    analysisKnowledgeEnabled: true,
  }));

  assert.match(resultHtml, /依据来源和风险提醒/);
  assert.match(reviewHtml, /知识缺口/);
});
