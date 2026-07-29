import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('knowledge submission, review, and publishing routes do not require an admin role', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const route = (method: string, path: string) => {
    const start = source.indexOf(`app.${method}('${path}'`);
    assert.notEqual(start, -1, `${method.toUpperCase()} ${path} route is registered`);
    const end = source.indexOf('\napp.', start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  };

  for (const [method, path] of [
    ['get', '/api/v1/knowledge/imports'],
    ['post', '/api/v1/knowledge/imports'],
    ['post', '/api/v1/knowledge/imports/uploads'],
    ['post', '/api/v1/knowledge/imports/uploads/:id/chunks/:index'],
    ['post', '/api/v1/knowledge/imports/uploads/:id/complete'],
    ['get', '/api/v1/knowledge/imports/:id'],
    ['post', '/api/v1/knowledge/imports/:id/reparse'],
    ['post', '/api/v1/knowledge/imports/:id/confirm'],
    ['post', '/api/v1/knowledge/imports/:id/candidates/:candidateId/discard'],
    ['post', '/api/v1/knowledge/imports/:id/candidates/:candidateId/split'],
    ['post', '/api/v1/knowledge/imports/:id/candidates/:candidateId/merge'],
    ['post', '/api/v1/knowledge'],
    ['post', '/api/v1/knowledge/:id/media'],
    ['post', '/api/v1/knowledge/upload'],
    ['patch', '/api/v1/knowledge/:id'],
    ['post', '/api/v1/knowledge/:id/publish'],
    ['post', '/api/v1/knowledge/:id/archive'],
    ['post', '/api/v1/knowledge/:id/confirm-classification'],
  ]) assert.doesNotMatch(route(method, path), /requireAdmin\(request\)/);
});
