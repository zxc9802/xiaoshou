import type { AppConfig } from '../config.js';

export interface EmbeddingResult {
  model: string;
  modelVersion?: string;
  inputTokens?: number;
  vector: number[];
}

export function formatRetrievalDocument(title: string, text: string) {
  return `title: ${title.trim() || 'none'} | text: ${text.trim()}`;
}

export function formatRetrievalQuery(query: string) {
  return `task: search result | query: ${query.trim()}`;
}

function validateVector(vector: unknown, expectedDimensions: number) {
  if (!Array.isArray(vector) || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('向量服务未返回有效数值数组');
  }
  if (vector.length !== expectedDimensions) {
    throw new Error(`向量维度不匹配：期望 ${expectedDimensions}，实际 ${vector.length}`);
  }
  return vector as number[];
}

function openAiEmbeddingsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/embeddings`;
}

export async function createKnowledgeEmbedding(text: string, config: AppConfig): Promise<EmbeddingResult | undefined> {
  const model = config.embeddingModelName;
  const expectedDimensions = config.embeddingDimensions ?? 1536;
  const baseUrl = (config.embeddingBaseUrl ?? config.modelBaseUrl)?.replace(/\/$/, '');
  const apiKey = config.embeddingApiKey ?? config.modelApiKey;
  if (!baseUrl || !apiKey || !model) return undefined;

  if (config.embeddingApiStyle === 'gemini_generate_content') {
    const response = await fetch(
      `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      },
    );
    if (!response.ok) throw new Error(`向量生成失败：${response.status}`);
    const body = await response.json() as {
      embedding?: { values?: number[] };
      usageMetadata?: { promptTokenCount?: number };
      modelVersion?: string;
    };
    return {
      model,
      modelVersion: body.modelVersion,
      inputTokens: body.usageMetadata?.promptTokenCount,
      vector: validateVector(body.embedding?.values, expectedDimensions),
    };
  }

  const response = await fetch(openAiEmbeddingsUrl(baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) throw new Error(`向量生成失败：${response.status}`);
  const body = await response.json() as {
    model?: string;
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  return {
    model: body.model ?? model,
    inputTokens: body.usage?.prompt_tokens,
    vector: validateVector(body.data?.[0]?.embedding, expectedDimensions),
  };
}
