import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createSsoSessionCookie,
  readSsoSessionCookie,
  safeRedirectPath,
} from './sso.js';

test('encrypts the main token inside the Fastify session cookie', () => {
  process.env.APP_SESSION_SECRET = 'xiaoshou-test-session-secret';
  const expiresAt = Date.now() + 60_000;
  const cookie = createSsoSessionCookie({
    token: 'main-token',
    user: { id: 'user-1', account: 'member@example.com', nickname: '成员', role: 'member' },
    expiresAt,
  });

  assert.doesNotMatch(cookie.value, /main-token/);
  assert.deepEqual(readSsoSessionCookie(cookie.value), {
    token: 'main-token',
    user: { id: 'user-1', account: 'member@example.com', nickname: '成员', role: 'member' },
    expiresAt,
  });
  assert.equal(readSsoSessionCookie('invalid'), null);
  assert.equal(safeRedirectPath('/dashboard'), '/dashboard');
  assert.equal(safeRedirectPath('//outside.example'), '/');
});

test('Fastify protects v1 routes with a validated SSO actor', async () => {
  const [server, api] = await Promise.all([
    readFile(path.join(process.cwd(), 'server/index.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'src/services/analysisApi.ts'), 'utf8'),
  ]);

  assert.match(server, /app\.get\('\/api\/sso\/callback'/);
  assert.match(server, /request\.ssoActor/);
  assert.match(server, /validateMainAppSession/);
  assert.doesNotMatch(server, /x-organization-id/);
  assert.doesNotMatch(api, /x-organization-id/);
  assert.match(api, /credentials:\s*'include'/);
});
