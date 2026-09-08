import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

// Resolve the same server module used by this repository's provider clients.
const source = 'server/main-usage.ts';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-report-test-'));
let modulePath = path.resolve(source);
if (source.endsWith('.ts')) {
  const { stripTypeScriptTypes } = await import('node:module');
  for (const name of ['main-usage', 'usage-values']) {
    const text = (await fs.readFile(path.join(path.dirname(source), name + '.ts'), 'utf8'))
      .replace(/['"]\.\/usage-values(?:\.ts|\.js)?['"]/g, "'./usage-values.mjs'");
    await fs.writeFile(path.join(temporary, name + '.mjs'), stripTypeScriptTypes(text));
  }
  modulePath = path.join(temporary, 'main-usage.mjs');
}
const api = await import(pathToFileURL(modulePath));

test('authenticated usage, concurrent employees, SSE, missing counts, retry and privacy', async () => {
  const received = [];
  let reject = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    assert.equal(req.url, '/api/sso/usage');
    assert.equal(req.headers['x-usage-secret'], 'test-secret-not-a-provider-key');
    received.push(JSON.parse(body));
    res.writeHead(reject ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: !reject }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { MAIN_APP_URL: `http://127.0.0.1:${server.address().port}`,
    USAGE_TOOL: 'test-tool', USAGE_REPORT_SECRET: 'test-secret-not-a-provider-key', USAGE_OUTBOX_DIR: path.join(temporary, 'outbox') });
  const drain = async () => {
    for (let i = 0; i < 5; i++) { await api.flushUsageReports(); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    let called = false;
    await assert.rejects(api.meteredFetch('https://provider.test/v1/chat/completions', {}, undefined,
      async () => { called = true; return new Response('{}'); }), /authenticated employee/);
    assert.equal(called, false);
    await Promise.all(['employee-a', 'employee-b'].map(user => api.runWithUsageUser(user, async () => {
      const response = await api.meteredFetch('https://provider.test/v1/chat/completions', {
        method: 'POST', body: JSON.stringify({ model: 'test-model', messages: [{ content: 'PRIVATE PROMPT' }] }),
      }, undefined, async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5,
        total_tokens: 25, prompt_tokens_details: { cached_tokens: 4 } } }), { headers: { 'content-type': 'application/json' } }));
      assert.equal((await response.json()).usage.total_tokens, 25);
    })));
    await drain();
    assert.deepEqual(received.map(x => x.userId).sort(), ['employee-a', 'employee-b']);
    assert.equal(new Set(received.map(x => x.requestId)).size, 2);
    assert.equal(received[0].inputTokens, 20);
    assert.equal(received[0].cachedInputTokens, 4);
    assert.ok(!JSON.stringify(received).includes('PRIVATE PROMPT'));
    assert.ok(!('amount' in received[0]));
    const stream = await api.meteredFetch('https://provider.test/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'test-model', stream: true }),
    }, 'employee-a', async (_, init) => {
      assert.equal(JSON.parse(init.body).stream_options.include_usage, true);
      return new Response('data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    });
    assert.ok((await stream.text()).includes('[DONE]'));
    await drain();
    assert.equal(received.at(-1).totalTokens, 5);
    assert.equal(received.at(-1).status, 'completed');
    const broken = await api.meteredFetch('https://provider.test/v1/chat/completions', {}, 'employee-b', async () =>
      new Response('data: {"choices":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await broken.text(); await drain();
    assert.equal(received.at(-1).status, 'interrupted');
    assert.equal(received.at(-1).inputTokens, null);
    await api.meteredFetch('https://provider.test/v1/images/generations', {body:'{"model":"image"}'}, 'employee-b',
      async () => new Response('{"error":{"message":"denied"}}', {status:429}));
    await drain();
    assert.equal(received.at(-1).status, 'failed');
    assert.equal(received.at(-1).tokenBasis, 'missing');
    await api.meteredFetch('https://provider.test/v1beta/models/gemini-test:generateContent', {}, 'employee-a', async () =>
      new Response(JSON.stringify({usageMetadata:{promptTokenCount:20,candidatesTokenCount:4,thoughtsTokenCount:3,totalTokenCount:27}})));
    await drain();
    assert.equal(received.at(-1).model, 'gemini-test');
    assert.equal(received.at(-1).outputTokens, 7);
    await api.meteredFetch('https://provider.test/v1/messages', {}, 'employee-a', async () =>
      new Response(JSON.stringify({usage:{input_tokens:10,cache_read_input_tokens:5,cache_creation_input_tokens:2,output_tokens:3}})));
    await drain();
    assert.equal(received.at(-1).inputTokens, 17);
    assert.equal(received.at(-1).totalTokens, 20);
    const cancelled = await api.meteredFetch('https://provider.test/v1/chat/completions', {}, 'employee-b', async () =>
      new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')); }}),
        {headers:{'content-type':'text/event-stream'}}));
    await cancelled.body.cancel(); await drain();
    assert.equal(received.at(-1).status, 'interrupted');
    // A persisted request left by a stopped process is recoverable without its prompt/body.
    const abandoned = {...received.at(-1), requestId:'process-stopped-request', status:'interrupted'};
    const pendingFile = path.join(process.env.USAGE_OUTBOX_DIR, 'abandoned.pending');
    await fs.writeFile(pendingFile, JSON.stringify(abandoned));
    const old = new Date(Date.now() - 25 * 3600000);
    await fs.utimes(pendingFile, old, old);
    await drain();
    assert.ok(received.some(e => e.requestId === abandoned.requestId && e.status === 'interrupted'));
    reject = true;
    await api.meteredFetch('https://provider.test/v1/chat/completions', {}, 'employee-a', async () => new Response('{}'));
    await drain();
    const queued = (await fs.readdir(process.env.USAGE_OUTBOX_DIR)).filter(x => x.endsWith('.json'));
    assert.equal(queued.length, 1);
    const retryId = received.at(-1).requestId;
    reject = false;
    await new Promise(resolve => setTimeout(resolve, 2100));
    await drain();
    assert.equal(received.at(-1).requestId, retryId);
    assert.equal((await fs.readdir(process.env.USAGE_OUTBOX_DIR)).filter(x => x.endsWith('.json')).length, 0);
  } finally {
    delete process.env.USAGE_REPORT_SECRET;
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
