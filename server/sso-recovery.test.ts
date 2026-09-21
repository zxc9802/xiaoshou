import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createSsoSessionCookie } from './sso.js';

test('live HTTP routes preserve SSO cookies during an outage and still reject invalid sessions', async (t) => {
  let upstreamStatus: number | 'network' = 200;
  const main = createServer((_request, response) => {
    if (upstreamStatus === 'network') { response.destroy(); return; }
    response.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  main.listen(0, '127.0.0.1');
  await once(main, 'listening');
  t.after(() => { main.closeAllConnections(); main.close(); });
  const mainUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}`;
  const secret = 'local-sso-regression-secret';
  const oldSecret = process.env.APP_SESSION_SECRET;
  process.env.APP_SESSION_SECRET = secret;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.APP_SESSION_SECRET;
    else process.env.APP_SESSION_SECRET = oldSecret;
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MAIN_APP_URL: mainUrl, APP_SESSION_SECRET: secret,
      REPOSITORY_DRIVER: 'memory', OBJECT_STORAGE_DRIVER: 'memory', MODEL_DRIVER: 'rule_based',
      WORKER_MODE: 'external', QDRANT_URL: '', DATABASE_URL: '', MODEL_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test API did not start')), 15_000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`test API exited: ${code}`)); });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  const session = { token: 'synthetic-token', user: { id: 'test-user', account: 'test', nickname: 'Test', role: 'member' }, expiresAt: Date.now() + 7 * 86_400_000 };
  const cookie = createSsoSessionCookie(session);
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  for (const status of [429, 500, 502, 503, 'network'] as const) {
    await t.test(`temporary ${status} keeps the cookie and recovers without login`, async () => {
      upstreamStatus = status;
      for (const path of ['/api/sso/session', '/api/v1/runtime-config']) {
        const response = await fetch(baseUrl + path, { headers });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('retry-after'), '5');
        assert.match((await response.json()).message, /稍后.*重试/);
      }
      upstreamStatus = 200;
      assert.equal((await fetch(baseUrl + '/api/sso/session', { headers })).status, 200);
      assert.equal((await fetch(baseUrl + '/api/v1/runtime-config', { headers })).status, 200);
    });
  }
  for (const status of [401, 403]) {
    await t.test(`access rejection ${status} still clears the cookie`, async () => {
      upstreamStatus = status;
      for (const path of ['/api/sso/session', '/api/v1/runtime-config']) {
        const response = await fetch(baseUrl + path, { headers });
        assert.equal(response.status, 401);
        assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
      }
    });
  }
  upstreamStatus = 503;
  const expired = createSsoSessionCookie({ ...session, expiresAt: Date.now() - 1 });
  assert.equal((await fetch(baseUrl + '/api/v1/runtime-config', { headers: { cookie: `${expired.name}=${expired.value}` } })).status, 401);
});
