import { createUsageReporter, responseStatus } from './openlux-usage.js';
import { currentBillingUserId } from './mainAppBilling.js';
import { getMainAppUrl } from './sso.js';

export const usageReporter = createUsageReporter({ tool: 'xiaoshou', getMainAppUrl });

export async function fetchWithUsage(url: string, init: RequestInit, embedding = false) {
  const body = typeof init.body === 'string' ? JSON.parse(init.body) as { model?: string } : {};
  const urlModel = new URL(url).pathname.match(/\/models\/([^/:]+):/);
  const model = urlModel ? decodeURIComponent(urlModel[1]!) : body.model;
  const call = model ? await usageReporter.begin({ url, model, userId: currentBillingUserId(), embedding }) : null;
  try {
    const response = await fetch(url, init);
    if (call) {
      const payload = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined;
      await call.finish(responseStatus(response.status, payload), payload, response.headers.get('x-request-id'));
    }
    return response;
  } catch (error) {
    await call?.finish('failed');
    throw error;
  }
}
