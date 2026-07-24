import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerCors } from './cors.js';

test('CORS preflight allows credentialed PATCH requests from the configured frontend', async () => {
  const origin = 'https://xiaoshou.qycm.top';
  const app = Fastify();
  await registerCors(app, origin);

  const response = await app.inject({
    method: 'OPTIONS',
    url: '/api/v1/customers/customer-1/remark',
    headers: {
      origin,
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'content-type,x-organization-id,x-user-id,x-user-role',
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.match(response.headers['access-control-allow-methods'] ?? '', /(?:^|,\s*)PATCH(?:,|$)/);

  await app.close();
});
