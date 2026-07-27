import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('background model work keeps the owning SSO account for credit billing', async () => {
  const client = await readFile(new URL('./model/generativeClient.ts', import.meta.url), 'utf8');
  const analyses = await readFile(new URL('./analysisService.ts', import.meta.url), 'utf8');
  const knowledge = await readFile(new URL('./knowledgeService.ts', import.meta.url), 'utf8');
  const billing = await readFile(new URL('./mainAppBilling.ts', import.meta.url), 'utf8');

  assert.match(client, /reserveTextCredits\(/);
  assert.match(client, /billing\.settle\(parseModelUsage/);
  assert.match(client, /billing\.release\(\)/);
  assert.match(client, /instanceof MainAppBillingError/);
  assert.match(analyses, /runWithMainAppBillingUser\(\s*job\.createdBy/s);
  assert.match(knowledge, /runWithMainAppBillingUser\(\s*job\.createdBy/s);
  assert.match(billing, /product:\s*'xiaoshou'/);
  assert.match(billing, /x-qycm-sso-client-secret/);
  assert.match(billing, /class MainAppBillingError extends Error/);
});
