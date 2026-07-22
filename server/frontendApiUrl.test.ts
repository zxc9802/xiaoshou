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
