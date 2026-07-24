import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createSsoSessionCookie,
  exchangeMainAppSsoTicket,
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
  const [server, api, env] = await Promise.all([
    readFile(path.join(process.cwd(), 'server/index.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'src/services/analysisApi.ts'), 'utf8'),
    readFile(path.join(process.cwd(), '.env.example'), 'utf8'),
  ]);

  assert.match(server, /app\.get\('\/api\/sso\/callback'/);
  assert.match(server, /getPublicAppUrl/);
  assert.match(server, /new URL\(redirectPath,\s*getPublicAppUrl\(\)\)/);
  assert.match(server, /request\.ssoActor/);
  assert.match(server, /validateMainAppSession/);
  assert.doesNotMatch(server, /x-organization-id/);
  assert.doesNotMatch(api, /x-organization-id/);
  assert.match(api, /credentials:\s*'include'/);
  assert.match(env, /CORS_ORIGIN=https:\/\/xiaoshou\.qycm\.top/);
  assert.match(env, /PUBLIC_APP_URL=https:\/\/xiaoshou\.qycm\.top/);
  assert.match(env, /VITE_API_BASE_URL=https:\/\/xiaoshou-api\.qycm\.top/);
});

test('keeps the child session until the main-issued token expires', async (t) => {
  process.env.APP_SESSION_SECRET = 'xiaoshou-test-session-secret';
  process.env.MAIN_APP_SSO_CLIENT_SECRET = 'xiaoshou-client-secret';
  const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    data: {
      token: 'main-token',
      redirectPath: '/dashboard',
      expiresAt,
      user: { id: 'user-1', account: 'member@example.com', nickname: '成员', role: 'member' },
    },
  }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const { session } = await exchangeMainAppSsoTicket('ticket-1');
  const server = await readFile(path.join(process.cwd(), 'server/index.ts'), 'utf8');

  assert.equal(session.expiresAt, expiresAt);
  assert.match(server, /serializeSsoSessionCookie\(cookie\.value, getSsoSessionCookieMaxAge\(session\.expiresAt\)\)/);
});
