import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getMainAppUrl } from './sso.js';

type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

const billingUserStorage = new AsyncLocalStorage<string>();

export class MainAppBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MainAppBillingError';
  }
}

export function runWithMainAppBillingUser<T>(
  userId: string,
  action: () => T,
): T {
  return billingUserStorage.run(userId, action);
}

function requiredValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new MainAppBillingError(`${name} is not configured.`);
  return value;
}

async function postBilling(userId: string, body: Record<string, unknown>) {
  const response = await fetch(`${getMainAppUrl()}/api/sso/billing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-qycm-sso-client-secret': requiredValue('MAIN_APP_SSO_CLIENT_SECRET'),
    },
    body: JSON.stringify({
      product: 'xiaoshou',
      userId,
      ...body,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as {
      error?: string;
    };
    throw new MainAppBillingError(
      payload.error || `主站积分服务请求失败：${response.status}`,
    );
  }
}

function noopHandle() {
  return {
    settle: async (_usage: TokenUsage) => undefined,
    release: async () => undefined,
  };
}

export async function reserveTextCredits(input: {
  operation: string;
  providerId: string;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}) {
  const userId = billingUserStorage.getStore();
  if (!userId) {
    if (process.env.NODE_TEST_CONTEXT) return noopHandle();
    throw new MainAppBillingError('主站计费账号上下文缺失');
  }
  const requestId = randomUUID();
  const common = {
    requestId,
    operation: input.operation,
    providerId: input.providerId,
    model: input.model,
  };
  await postBilling(userId, {
    action: 'reserve',
    ...common,
    estimatedInputTokens: input.estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });
  let completed = false;
  return {
    async settle(usage: TokenUsage) {
      if (completed) return;
      await postBilling(userId, { action: 'settle', ...common, usage });
      completed = true;
    },
    async release() {
      if (completed) return;
      await postBilling(userId, { action: 'release', ...common });
      completed = true;
    },
  };
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseModelUsage(
  payload: unknown,
  fallback: { inputTokens: number; outputText: string },
): TokenUsage {
  const root = record(payload);
  const usage = record(root.usage);
  const metadata = record(root.usageMetadata);
  const inputTokens = positiveInteger(usage.prompt_tokens ?? usage.input_tokens)
    || positiveInteger(metadata.promptTokenCount)
    || fallback.inputTokens;
  const cachedInputTokens = Math.min(
    inputTokens,
    positiveInteger(record(usage.prompt_tokens_details).cached_tokens)
      || positiveInteger(metadata.cachedContentTokenCount),
  );
  const reasoningTokens = positiveInteger(
    record(usage.completion_tokens_details).reasoning_tokens,
  ) || positiveInteger(metadata.thoughtsTokenCount);
  const outputTokens = positiveInteger(usage.completion_tokens ?? usage.output_tokens)
    || positiveInteger(metadata.candidatesTokenCount) + reasoningTokens
    || Math.max(1, new TextEncoder().encode(fallback.outputText).length);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: positiveInteger(usage.total_tokens)
      || positiveInteger(metadata.totalTokenCount)
      || inputTokens + outputTokens,
  };
}
