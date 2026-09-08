import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { emptyUsage, mergeUsage, parseTokenUsage, type TokenUsage } from './usage-values.js';

export type UsageReport = TokenUsage & {
  userId: string;
  requestId: string;
  provider: string;
  model: string;
  status: 'completed' | 'failed' | 'interrupted';
  tokenBasis: 'reported' | 'estimated' | 'missing';
  upstreamRequestId?: string | null;
  amount?: number | null;
  currency?: 'USD' | 'CNY' | null;
  costBasis?: 'actual' | 'estimated' | 'missing';
};

const users = new AsyncLocalStorage<string>();
export function runWithUsageUser<T>(userId: string, action: () => T): T { return users.run(userId, action); }
export function isUsageReportingEnabled() { return Boolean(process.env.USAGE_TOOL && process.env.USAGE_REPORT_SECRET && process.env.MAIN_APP_URL); }
function directory() { return process.env.USAGE_OUTBOX_DIR || path.join(process.env.DATA_DIR || process.cwd(), '.usage-outbox'); }
function filename(id: string) { return createHash('sha256').update(`${process.env.USAGE_TOOL}:${id}`).digest('hex'); }
let flushing: Promise<void> | null = null;
let retryAt = 0;
let failures = 0;
let timer: ReturnType<typeof setInterval> | undefined;

async function save(event: UsageReport, extension: string) {
  const dir = directory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, filename(event.requestId) + extension);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(event), { mode: 0o600 });
  await rename(temp, target);
}

function startWorker() {
  if (timer) return;
  timer = setInterval(() => { void flushUsageReports(); }, 30_000);
  timer.unref();
}

/** Queue first; network outages never cause regeneration or change wallet settlement. */
export async function queueUsageReport(event: UsageReport): Promise<void> {
  if (!isUsageReportingEnabled()) return;
  if (!event.userId || !event.requestId) throw new Error('Usage report requires server-authenticated identity and request id');
  await save(event, '.json');
  await unlink(path.join(directory(), filename(event.requestId) + '.pending')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  startWorker();
  void flushUsageReports();
}

/** A bounded persistent outbox. Keep 4xx as well as 5xx for configuration fixes. */
export async function flushUsageReports(): Promise<void> {
  if (!isUsageReportingEnabled() || Date.now() < retryAt) return;
  if (flushing) return flushing;
  flushing = (async () => {
    const dir = directory();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const names = await readdir(dir);
    // Requests interrupted by process termination are retained as unknown usage, not zero.
    for (const name of names.filter(n => n.endsWith('.pending')).slice(0, 50)) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info || Date.now() - info.mtimeMs < 24 * 3600_000) continue;
      const terminal = file.replace(/\.pending$/, '.json');
      if (!await stat(terminal).catch(() => null)) {
        const event = JSON.parse(await readFile(file, 'utf8')) as UsageReport;
        await save({ ...event, status: 'interrupted' }, '.json');
      }
      await unlink(file).catch(() => undefined);
    }
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 50)) {
      const file = path.join(dir, name);
      const body = await readFile(file, 'utf8');
      const base = new URL(process.env.MAIN_APP_URL!);
      if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid main application URL');
      const response = await fetch(new URL('/api/sso/usage', base), {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'x-usage-tool': process.env.USAGE_TOOL!, 'x-usage-secret': process.env.USAGE_REPORT_SECRET! },
        body,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success !== true) throw new Error(`Usage report HTTP ${response.status}`);
      // Do not delete a newer queued version while this request was in flight.
      if (await readFile(file, 'utf8').catch(() => '') === body) await unlink(file).catch(() => undefined);
    }
    failures = 0;
    retryAt = 0;
  })().catch(error => {
    failures += 1;
    retryAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(failures, 8));
    console.error('[usage-report] Pending events retained for retry:', error instanceof Error ? error.message : 'outbox failure');
  }).finally(() => { flushing = null; });
  return flushing;
}

async function beginUsage(userId: string, url: URL, init?: RequestInit) {
  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { /* Not a JSON request. */ } }
  const formModel = init?.body instanceof FormData ? init.body.get('model') : null;
  const event: UsageReport = {
    ...emptyUsage(), userId, requestId: randomUUID(), provider: url.hostname,
    model: String(body.model || formModel || decodeURIComponent(url.pathname.match(/\/models\/([^/:]+)/)?.[1] || 'unknown')),
    status: 'interrupted', tokenBasis: 'missing',
  };
  // If storage is unavailable, fail before making a billable request.
  await save(event, '.pending');
  startWorker();
  return { event, body };
}

/** Pass only an identity obtained from the server's verified SSO session/job owner. */
export async function meteredFetch(input: string | URL | Request, init?: RequestInit, explicitUserId?: string, transport: typeof fetch = fetch): Promise<Response> {
  const userId = explicitUserId ?? users.getStore();
  if (!isUsageReportingEnabled()) return transport(input, init);
  if (!userId) throw new Error('Usage reporting requires an authenticated employee');
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const { event, body } = await beginUsage(userId, url, init);
  if (body.stream === true && url.pathname.endsWith('/chat/completions')) {
    init = { ...init, body: JSON.stringify({ ...body, stream_options: { ...(body.stream_options as object ?? {}), include_usage: true } }) };
  }
  let response: Response;
  try { response = await transport(input, init); }
  catch (error) { await finish({ ...event, status: 'failed' }); throw error; }
  event.upstreamRequestId = response.headers.get('x-request-id');
  let failed = !response.ok;
  let terminal = false;
  function observe(value: unknown) {
    if (Array.isArray(value)) { value.forEach(observe); return; }
    if (value && typeof value === 'object') {
      const type = 'type' in value ? String(value.type) : '';
      if (['message_stop', 'response.completed', 'response.failed', 'response.incomplete'].includes(type)) terminal = true;
      if (['error', 'response.failed', 'response.incomplete'].includes(type) || ('error' in value && Boolean(value.error))) failed = true;
    }
    Object.assign(event, mergeUsage(event, parseTokenUsage(value)));
    if (url.pathname.endsWith('/embeddings') && event.inputTokens !== null) { event.outputTokens = 0; event.totalTokens = event.inputTokens; }
    event.tokenBasis = [event.inputTokens, event.outputTokens, event.totalTokens].some(n => n !== null) ? 'reported' : 'missing';
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    let bytes: ArrayBuffer;
    try { bytes = await response.arrayBuffer(); }
    catch (error) { await finish(event); throw error; }
    try { observe(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* Preserve missing usage. */ }
    await finish({ ...event, status: failed ? 'failed' : 'completed' });
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let finished = false;
  async function complete(status: UsageReport['status']) {
    if (finished) return;
    await finish({ ...event, status });
    finished = true;
  }
  function consume(text: string) {
    pending += text;
    const lines = pending.split('\n'); pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') terminal = true;
      else { try { observe(JSON.parse(data)); } catch { /* Ignore non-JSON SSE data. */ } }
    }
    if (pending.length > 2_000_000) pending = '';
  }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { consume(decoder.decode() + '\n'); await complete(failed ? 'failed' : terminal ? 'completed' : 'interrupted'); controller.close(); }
        else { consume(decoder.decode(part.value, { stream: true })); if (terminal) await complete(failed ? 'failed' : 'completed'); controller.enqueue(part.value); }
      } catch (error) { await complete('interrupted'); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { await complete('interrupted'); } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function finish(event: UsageReport) {
  if (event.inputTokens !== null && event.outputTokens !== null) event.totalTokens = event.inputTokens + event.outputTokens;
  try { await queueUsageReport(event); }
  catch { console.error('[usage-report] Unable to save final usage; pending request retained for reconciliation.'); }
}

if (isUsageReportingEnabled()) { startWorker(); void flushUsageReports(); }
