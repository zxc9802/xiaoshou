import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}
function add(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

export function providerHostname(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// Report only upstream counts. Cache and reasoning are subsets unless the protocol says otherwise.
export function parseUsage(payload: unknown, embedding = false) {
  const root = record(payload);
  const usage = record(root.usage ?? record(root.response).usage);
  const gemini = record(root.usageMetadata);
  const inputDetails = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const outputDetails = record(usage.completion_tokens_details ?? usage.output_tokens_details);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  let inputTokens = count(usage.prompt_tokens ?? usage.input_tokens ?? gemini.promptTokenCount);
  if (inputTokens !== null && (cacheRead !== null || cacheWriteTokens !== null)) {
    inputTokens += (cacheRead ?? 0) + (cacheWriteTokens ?? 0);
  }
  const reasoningTokens = count(outputDetails.reasoning_tokens ?? gemini.thoughtsTokenCount);
  let outputTokens = count(usage.completion_tokens ?? usage.output_tokens);
  if (outputTokens === null) outputTokens = add(count(gemini.candidatesTokenCount), count(gemini.thoughtsTokenCount));
  if (embedding && inputTokens !== null && outputTokens === null) outputTokens = 0;
  const totalTokens = count(usage.total_tokens ?? gemini.totalTokenCount)
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  let imageInputTokens = count(inputDetails.image_tokens ?? usage.image_input_tokens);
  if (imageInputTokens === null && Array.isArray(gemini.promptTokensDetails)) {
    const images = gemini.promptTokensDetails.map(record).filter(item => String(item.modality).toUpperCase() === 'IMAGE');
    for (const item of images) imageInputTokens = add(imageInputTokens, count(item.tokenCount));
  }
  return {
    tokenBasis: inputTokens !== null || outputTokens !== null || totalTokens !== null ? 'reported' : 'missing',
    inputTokens, outputTokens, totalTokens,
    cachedInputTokens: count(inputDetails.cached_tokens ?? usage.prompt_cache_hit_tokens ?? gemini.cachedContentTokenCount) ?? cacheRead,
    cacheWriteTokens, reasoningTokens, imageInputTokens,
  };
}

type Status = 'pending' | 'completed' | 'failed' | 'interrupted';

export function responseStatus(httpStatus: number, payload: unknown): Status {
  const root = record(payload);
  const data = record(root.data);
  const state = String(root.status ?? data.status ?? '').toLowerCase();
  if (httpStatus >= 400 || root.error || ['failed', 'error', 'cancelled', 'canceled'].includes(state)) return 'failed';
  if (httpStatus === 202 || ['pending', 'queued', 'processing', 'running', 'submitted', 'in_progress'].includes(state)) return 'pending';
  return 'completed';
}
export type UsageOutbox = {
  initialize: () => Promise<void>;
  write: (key: string, body: string) => Promise<void>;
  list: (limit: number) => Promise<Array<{ key: string; body: string }>>;
  remove: (key: string) => Promise<void>;
};

export function fileOutbox(directory: string): UsageOutbox {
  return {
    async initialize() { await mkdir(directory, { recursive: true }); },
    async write(key, body) {
      const path = join(directory, key);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, path);
    },
    async list(limit) {
      const files = (await readdir(directory)).filter(name => name.endsWith('.json')).slice(0, limit);
      return Promise.all(files.map(async key => ({ key, body: await readFile(join(directory, key), 'utf8') })));
    },
    async remove(key) { await unlink(join(directory, key)); },
  };
}

type ReporterOptions = {
  tool: string;
  getMainAppUrl: () => string;
  secret?: () => string | undefined;
  outboxDir?: () => string;
  fetchImpl?: typeof fetch;
  getOutbox?: () => Promise<UsageOutbox>;
};

export function createUsageReporter(options: ReporterOptions) {
  const secret = options.secret ?? (() => process.env.USAGE_MONITOR_INTERNAL_SECRET?.trim());
  const directory = options.outboxDir ?? (() => process.env.USAGE_MONITOR_OUTBOX_DIR?.trim()
    || join(process.cwd(), '.data', 'usage-outbox', options.tool));
  const endpoint = () => process.env.USAGE_MONITOR_URL?.trim()
    || `${options.getMainAppUrl().replace(/\/$/, '')}/api/sso/usage`;
  const enabled = (url: string) => providerHostname(url) === 'api.openlux.ai' && Boolean(secret());
  let draining: Promise<void> | undefined;

  let storage: Promise<UsageOutbox> | undefined;
  async function outbox() {
    if (!storage) storage = (async () => {
      const value = options.getOutbox ? await options.getOutbox() : fileOutbox(directory());
      await value.initialize();
      return value;
    })().catch(error => { storage = undefined; throw error; });
    return storage;
  }

  async function ready(url: string) {
    if (!enabled(url)) return false;
    try { await outbox(); return true; } catch {
      console.warn('[usage] Persistent outbox unavailable; legacy usage remains enabled.');
      return false;
    }
  }

  async function persist(event: RecordValue) {
    await (await outbox()).write(`${event.requestId}.${event.status}.json`, JSON.stringify(event));
  }

  async function drain() {
    if (!secret()) return;
    const store = await outbox();
    const events = await store.list(10);
    // Each run is bounded; deployment operators can run the explicit retry command.
    const deadline = Date.now() + 3_000;
    for (const { key, body } of events) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const response = await (options.fetchImpl ?? fetch)(endpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-usage-tool': options.tool, 'x-usage-secret': secret()! },
          body,
          signal: AbortSignal.timeout(Math.min(1_500, remaining)),
        });
        if (!response.ok) break;
        await store.remove(key);
      } catch { break; }
    }
  }

  async function flush() {
    if (!draining) draining = drain().catch(() => {
      console.warn('[usage] Outbox delivery failed; pending metadata retained.');
    }).finally(() => { draining = undefined; });
    await draining;
  }

  async function begin(input: { url: string; model: string; userId?: string; embedding?: boolean }) {
    if (!input.userId || !await ready(input.url)) return null;
    const requestId = randomUUID();
    const common = { userId: input.userId, requestId, provider: providerHostname(input.url), model: input.model };
    let terminal = false;
    async function save(status: Status, payload?: unknown, upstreamRequestId?: string | null) {
      try {
        await persist({ ...common, status, ...parseUsage(payload, input.embedding),
          ...(upstreamRequestId ? { upstreamRequestId } : {}) });
      } catch {
        console.warn('[usage] Unable to persist usage metadata; check persistent outbox storage.');
      }
      await flush();
    }
    await save('pending');
    return {
      requestId,
      async finish(status: Status, payload?: unknown, upstreamRequestId?: string | null) {
        if (terminal) return;
        terminal = status !== 'pending';
        await save(status, payload, upstreamRequestId);
      },
    };
  }

  return { enabled, ready, begin, flush };
}
