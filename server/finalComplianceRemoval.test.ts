import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SalesCoachResult } from '../src/components/SalesCoachResult.js';
import { ANALYSIS_STEPS } from '../src/services/analysisApi.js';
import { DEFAULT_KNOWLEDGE } from './knowledge/defaults.js';
import { parseConversationText } from './model/conversationParser.js';
import { analyzeWithRules } from './rules/analysisEngine.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function result() {
  return analyzeWithRules(
    parseConversationText('客户：这个价格有点高\n销售：您更关心预算还是价值？'),
    DEFAULT_KNOWLEDGE,
  );
}

test('analysis progress ends after advice generation', () => {
  assert.deepEqual(ANALYSIS_STEPS, [
    '正在识别对话',
    '正在判断销售情境',
    '正在检索规则与资料',
    '正在生成销管建议',
  ]);
});

test('new analysis results do not contain a validation report', () => {
  assert.equal('validationReport' in result(), false);
});

test('legacy blocked history does not render the removed compliance UI', () => {
  const html = renderToStaticMarkup(createElement(SalesCoachResult, {
    result: result(),
    jobStatus: 'blocked',
  }));
  assert.doesNotMatch(html, /普通回复已被阻止|查看生成前校验结果/);
});
