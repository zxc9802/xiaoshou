import type { AppConfig } from '../config.js';
import {
  MainAppBillingError,
  parseModelUsage,
  reserveTextCredits,
} from '../mainAppBilling.js';

export interface ModelMediaInput {
  name: string;
  mimeType: string;
  data: Buffer;
  timestampSeconds?: number;
}

export type ModelImageInput = ModelMediaInput;

interface GenerateJsonInput {
  model?: string;
  prompt: string;
  images?: ModelImageInput[];
  media?: ModelMediaInput[];
  timeoutMs?: number;
}

function requireModelConfig(config: AppConfig, model?: string) {
  if (config.modelDriver !== 'openai_compatible' || !config.modelBaseUrl || !config.modelApiKey || !model) {
    throw new Error('Model configuration is incomplete');
  }
}

function stripCodeFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function jsonOnlyPrompt(prompt: string) {
  return `你是一个严格的 JSON API。只能输出一个合法 JSON 对象，不要解释，不要 Markdown，不要代码块，不要在 JSON 前后添加任何文字。\n\n${prompt}`;
}

function normalizeJsonText(value: string) {
  const stripped = stripCodeFence(value);
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = stripped.slice(start, end + 1);
      JSON.parse(candidate);
      return candidate;
    }
    throw new Error('Model did not return a valid JSON object');
  }
}

function appendQueryKey(url: string, key: string) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('key')) parsed.searchParams.set('key', key);
  return parsed.toString();
}

function geminiEndpoint(baseUrl: string, model: string) {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (trimmed.includes(':generateContent')) return trimmed;
  if (trimmed.endsWith('/v1beta')) return `${trimmed}/models/${encodeURIComponent(model)}:generateContent`;
  if (/\/v1beta\/models\/[^/]+$/.test(trimmed)) return `${trimmed}:generateContent`;
  return `${trimmed}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function authHeaders(config: AppConfig): Record<string, string> {
  const mode = config.modelAuthMode ?? (config.modelApiStyle === 'gemini_generate_content' ? 'api_key_header' : 'bearer');
  if (mode === 'query') return {};
  if (mode === 'api_key_header') return { 'x-goog-api-key': config.modelApiKey ?? '' };
  return { Authorization: `Bearer ${config.modelApiKey}` };
}

async function fetchJson(url: string, config: AppConfig, init: RequestInit) {
  const mode = config.modelAuthMode ?? (config.modelApiStyle === 'gemini_generate_content' ? 'api_key_header' : 'bearer');
  const endpoint = mode === 'query' && config.modelApiKey ? appendQueryKey(url, config.modelApiKey) : url;
  const response = await fetch(endpoint, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(config),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Model request failed: ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ''}`);
  }
  return response.json() as Promise<unknown>;
}

async function generateOpenAIJson(config: AppConfig, input: Required<Pick<GenerateJsonInput, 'model' | 'prompt' | 'timeoutMs'>> & { media: ModelMediaInput[] }) {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: jsonOnlyPrompt(input.prompt) }];
  for (const item of input.media) {
    if (item.mimeType.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data.toString('base64')}` } });
    else if (item.mimeType.startsWith('audio/')) content.push({ type: 'input_audio', input_audio: { data: item.data.toString('base64'), format: item.mimeType.includes('wav') ? 'wav' : 'mp3' } });
  }
  const maxOutputTokens = 8_192;
  const estimatedInputTokens = new TextEncoder().encode(input.prompt).length
    + input.media.length * 4_000;
  const billing = await reserveTextCredits({
    operation: 'generate-json',
    providerId: 'openai-compatible',
    model: input.model,
    estimatedInputTokens,
    maxOutputTokens,
  });
  try {
    const body = await fetchJson(`${config.modelBaseUrl!.replace(/\/$/, '')}/chat/completions`, config, {
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs),
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: maxOutputTokens,
        messages: [{ role: 'user', content }],
      }),
    }) as { choices?: Array<{ message?: { content?: string } }> };
    const outputText = body.choices?.[0]?.message?.content ?? '{}';
    await billing.settle(parseModelUsage(body, { inputTokens: estimatedInputTokens, outputText }));
    return normalizeJsonText(outputText);
  } catch (error) {
    if (error instanceof MainAppBillingError) throw error;
    await billing.release();
    throw error;
  }
}

async function generateGeminiJson(config: AppConfig, input: Required<Pick<GenerateJsonInput, 'model' | 'prompt' | 'timeoutMs'>> & { media: ModelMediaInput[] }) {
  const parts: Array<Record<string, unknown>> = [{ text: jsonOnlyPrompt(input.prompt) }];
  for (const item of input.media) {
    parts.push({ inline_data: { mime_type: item.mimeType, data: item.data.toString('base64') } });
    if (item.timestampSeconds != null) parts.push({ text: `上一份关键帧时间点：${item.timestampSeconds}秒` });
  }
  const maxOutputTokens = 8_192;
  const estimatedInputTokens = new TextEncoder().encode(input.prompt).length
    + input.media.length * 4_000;
  const billing = await reserveTextCredits({
    operation: 'generate-json',
    providerId: 'gemini',
    model: input.model,
    estimatedInputTokens,
    maxOutputTokens,
  });
  try {
    const body = await fetchJson(geminiEndpoint(config.modelBaseUrl!, input.model), config, {
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs),
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          maxOutputTokens,
        },
      }),
    }) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const outputText = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '{}';
    await billing.settle(parseModelUsage(body, { inputTokens: estimatedInputTokens, outputText }));
    return normalizeJsonText(outputText);
  } catch (error) {
    if (error instanceof MainAppBillingError) throw error;
    await billing.release();
    throw error;
  }
}

export async function generateJsonText(config: AppConfig, input: GenerateJsonInput) {
  const model = input.model ?? config.modelName;
  requireModelConfig(config, model);
  const normalized = { model: model!, prompt: input.prompt, media: input.media ?? input.images ?? [], timeoutMs: input.timeoutMs ?? 20_000 };
  return config.modelApiStyle === 'gemini_generate_content'
    ? generateGeminiJson(config, normalized)
    : generateOpenAIJson(config, normalized);
}
