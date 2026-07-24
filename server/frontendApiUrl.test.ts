import assert from 'node:assert/strict';
import test from 'node:test';

import * as analysisApi from '../src/services/analysisApi.js';

type AnalysisApiModule = typeof analysisApi & {
  buildApiUrl?: (path: string, baseUrl?: string) => string;
};

test('builds frontend API URLs from the configured backend origin', () => {
  const buildApiUrl = (analysisApi as AnalysisApiModule).buildApiUrl;

  assert.equal(typeof buildApiUrl, 'function');
  assert.equal(
    buildApiUrl?.('/api/v1/customers', 'https://api.example.test/'),
    'https://api.example.test/api/v1/customers',
  );
});

test('customer remark updates include the latest analysis id', async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody = '';
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await analysisApi.customerApi.setRemark('stale-profile', '重点客户', 'analysis-1');

  assert.deepEqual(JSON.parse(requestBody), { remark: '重点客户', analysisId: 'analysis-1' });
});
