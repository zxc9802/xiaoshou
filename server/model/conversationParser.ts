import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ParsedConversation, ParsedMessage } from '../../shared/contracts.js';
import type { AppConfig } from '../config.js';
import { generateJsonText } from './generativeClient.js';

export interface ImageInput { name: string; mimeType: string; data: Buffer }

export interface ConversationParser {
  parse(conversation: string, images: ImageInput[]): Promise<ParsedConversation>;
}

const customerIdentitySchema = z.object({
  displayName: z.string().nullish(), nickname: z.string().nullish(), remarkName: z.string().nullish(), company: z.string().nullish(),
  phone: z.string().nullish(), wechatId: z.string().nullish(), avatarSourceAttachment: z.string().nullish(),
  avatarBoundingBox: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() }).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
});

const privacyPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { name: '微信号', pattern: /(?:微信|wx|VX|WeChat)[号：:\s]*[a-zA-Z][-_a-zA-Z0-9]{5,19}/gi },
];

export function detectSensitiveData(text: string) {
  return privacyPatterns.filter(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(text); }).map(({ name }) => name);
}

export function maskSensitiveData(text: string) {
  let masked = text;
  for (const { pattern } of privacyPatterns) { pattern.lastIndex = 0; masked = masked.replace(pattern, (value) => `${value.slice(0, 3)}****${value.slice(-2)}`); }
  return masked;
}

function identityHash(kind: string, value?: string | null) {
  const normalized = value?.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return normalized ? createHash('sha256').update(`${kind}:${normalized}`).digest('hex') : undefined;
}

function textIdentity(conversation: string) {
  const remarkName = conversation.match(/(?:备注|客户昵称|昵称)[：:]\s*([^\n，,；;]{1,24})/)?.[1]?.trim();
  const addressedName = conversation.match(/([\u4e00-\u9fa5]{1,4}(?:总|老师|先生|女士))(?=您好|你好|，|,|！|!)/)?.[1];
  const displayName = remarkName || addressedName;
  return displayName ? { displayName, nickname: remarkName, remarkName, identityHashes: [], confidence: remarkName ? 0.92 : 0.74 } : undefined;
}

export function parseConversationText(conversation: string): ParsedConversation {
  const lines = conversation.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const messages: ParsedMessage[] = lines.map((line, index) => {
    const salesMatch = line.match(/^(销售|我|我们)[：:]\s*(.*)$/);
    const customerMatch = line.match(/^(客户|顾客|对方)[：:]\s*(.*)$/);
    const role = salesMatch ? 'sales' : customerMatch ? 'customer' : index % 2 === 0 ? 'customer' : 'sales';
    const rawText = salesMatch?.[2] ?? customerMatch?.[2] ?? line;
    return { id: randomUUID(), role, text: maskSensitiveData(rawText), confidence: salesMatch || customerMatch ? 0.98 : 0.78 };
  });
  const fullText = lines.join('\n');
  const sensitiveDataTypes = detectSensitiveData(fullText);
  const last = messages.at(-1);
  return {
    messages,
    lastSpeaker: last?.role ?? 'unknown',
    lastMessage: last?.text ?? '',
    silenceHint: /([1-9]\d*)\s*天\s*(?:没回|未回|已读)/.exec(fullText)?.[0],
    containsSensitiveData: sensitiveDataTypes.length > 0,
    sensitiveDataTypes,
    requiresConfirmation: messages.some((message) => message.role === 'unknown' || message.confidence < 0.7),
    customerIdentity: textIdentity(conversation),
  };
}

export class RuleBasedConversationParser implements ConversationParser {
  async parse(conversation: string, images: ImageInput[]) {
    if (conversation.trim()) return parseConversationText(conversation);
    return {
      messages: images.map((image) => ({ id: randomUUID(), role: 'unknown' as const, text: `请确认截图“${image.name}”中的对话文字与角色`, confidence: 0, sourceAttachment: image.name })),
      lastSpeaker: 'unknown' as const,
      lastMessage: '',
      containsSensitiveData: false,
      sensitiveDataTypes: [],
      requiresConfirmation: true,
    };
  }
}

export class OpenAICompatibleConversationParser implements ConversationParser {
  constructor(private readonly config: AppConfig) {}

  async parse(conversation: string, images: ImageInput[]): Promise<ParsedConversation> {
    if (!images.length) return parseConversationText(conversation);
    if (!this.config.modelBaseUrl || !this.config.modelApiKey || !this.config.modelName) throw new Error('Multimodal model configuration is incomplete');

    const prompt = `请解析微信或企业微信聊天截图。区分 sales 和 customer，按真实对话顺序输出消息；不要在消息正文复述完整手机号、微信号或身份证号，敏感字段用 *** 遮盖。
同时识别客户身份：优先读取聊天页顶部可见的备注名、昵称和公司；只有确实可见时才填写。识别客户头像时，优先选择聊天页顶部的客户头像；没有顶部头像时，可选择重复出现的客户侧头像，不能误选销售头像。avatarBoundingBox 使用来源截图中的 0-1 归一化坐标并紧贴头像边缘，avatarSourceAttachment 必须使用输入图片的原文件名。无法确认时留空，不要猜测。
补充文本：${conversation || '无'}。仅返回 JSON：{"messages":[{"role":"sales|customer|unknown","text":"","timestamp":"","confidence":0.0,"sourceAttachment":""}],"customerIdentity":{"displayName":"","nickname":"","remarkName":"","company":"","phone":"","wechatId":"","avatarSourceAttachment":"","avatarBoundingBox":{"x":0,"y":0,"width":0,"height":0},"confidence":0.0},"silenceHint":"","containsSensitiveData":false,"sensitiveDataTypes":[],"requiresConfirmation":false}`;
    const schema = z.object({
      messages: z.array(z.object({
        role: z.enum(['sales', 'customer', 'unknown']),
        text: z.string().min(1),
        timestamp: z.string().optional(),
        confidence: z.number().min(0).max(1),
        sourceAttachment: z.string().optional(),
      })).min(1),
      silenceHint: z.string().optional(),
      containsSensitiveData: z.boolean().optional(),
      sensitiveDataTypes: z.array(z.string()).optional(),
      requiresConfirmation: z.boolean().optional(),
      customerIdentity: customerIdentitySchema.optional(),
    });
    const parsed = schema.parse(JSON.parse(await generateJsonText(this.config, { model: this.config.modelName, prompt, images, timeoutMs: 60_000 })));
    const rawDetectedTypes = detectSensitiveData(parsed.messages.map((message) => message.text).join('\n'));
    const validSources = new Set(images.map((image) => image.name));
    const messages = parsed.messages.map((message) => ({ ...message, id: randomUUID(), text: maskSensitiveData(message.text), sourceAttachment: message.sourceAttachment && validSources.has(message.sourceAttachment) ? message.sourceAttachment : undefined }));
    const last = messages.at(-1);
    const sensitiveDataTypes = [...new Set([...(parsed.sensitiveDataTypes ?? []), ...rawDetectedTypes])];
    let rawIdentity = parsed.customerIdentity;
    const suspiciousHeaderName = /顾问|客服|销售|官方|助手|运营|老师团队/.test(rawIdentity?.displayName ?? rawIdentity?.remarkName ?? '');
    if (!rawIdentity?.avatarBoundingBox || !rawIdentity.avatarSourceAttachment || suspiciousHeaderName) {
      const customerMessages = messages.filter((message) => message.role === 'customer').slice(0, 4).map((message) => message.text).join('；');
      const identityPrompt = `只完成客户身份与头像定位，不要重新总结对话。已识别出的客户消息是：${customerMessages || '暂无'}。
请在聊天截图中找到这些客户消息所在的气泡一侧，再选择紧邻该侧消息、重复出现的同一个客户头像。聊天顶部标题可能是销售账号、客服或顾问名称，不能仅凭标题判断客户；“顾问、客服、销售、官方、助手”等名称默认不是客户。只有截图明确显示客户昵称或备注时才填写姓名，否则留空。
avatarBoundingBox 必须是头像在整张原图中的 0-1 归一化坐标，紧贴头像本身，不要包含聊天气泡。avatarSourceAttachment 必须原样返回图片文件名。仅返回 JSON：{"customerIdentity":{"displayName":"","nickname":"","remarkName":"","company":"","phone":"","wechatId":"","avatarSourceAttachment":"","avatarBoundingBox":{"x":0,"y":0,"width":0,"height":0},"confidence":0.0}}`;
      try {
        const focused = z.object({ customerIdentity: customerIdentitySchema }).parse(JSON.parse(await generateJsonText(this.config, { model: this.config.modelName, prompt: identityPrompt, images, timeoutMs: 60_000 })));
        rawIdentity = { ...rawIdentity, ...focused.customerIdentity };
      } catch {
        // Keep the first-pass identity and apply the conservative WeChat layout fallback below.
      }
      if ((!rawIdentity?.avatarBoundingBox || !rawIdentity.avatarSourceAttachment) && images.length === 1 && customerMessages) {
        // WeChat's first opposite-party avatar is consistently placed below the header on the left.
        // This conservative fallback is only used when the focused visual pass cannot return coordinates.
        rawIdentity = { ...rawIdentity, avatarSourceAttachment: images[0]!.name, avatarBoundingBox: { x: 0.025, y: 0.122, width: 0.1, height: 0.062 }, confidence: Math.min(rawIdentity?.confidence ?? 0.55, 0.55) };
      }
    }
    const identityHashes = [identityHash('phone', rawIdentity?.phone), identityHash('wechat', rawIdentity?.wechatId)].filter((value): value is string => Boolean(value));
    const avatarSourceAttachment = rawIdentity?.avatarBoundingBox && images.length === 1
      ? images[0]!.name
      : rawIdentity?.avatarSourceAttachment && validSources.has(rawIdentity.avatarSourceAttachment) ? rawIdentity.avatarSourceAttachment : undefined;
    const identityName = suspiciousHeaderName && !rawIdentity?.nickname && !rawIdentity?.remarkName ? undefined : rawIdentity?.displayName?.trim();
    const customerIdentity = rawIdentity && (identityName || rawIdentity.nickname || rawIdentity.remarkName || rawIdentity.company || identityHashes.length || avatarSourceAttachment) ? {
      displayName: identityName || rawIdentity.remarkName?.trim() || rawIdentity.nickname?.trim() || undefined,
      nickname: rawIdentity.nickname?.trim() || undefined,
      remarkName: rawIdentity.remarkName?.trim() || undefined,
      company: rawIdentity.company?.trim() || undefined,
      identityHashes,
      avatarSourceAttachment,
      avatarBoundingBox: avatarSourceAttachment ? rawIdentity.avatarBoundingBox ?? undefined : undefined,
      confidence: rawIdentity.confidence ?? 0.7,
    } : textIdentity(conversation);
    return {
      messages,
      lastSpeaker: last?.role ?? 'unknown',
      lastMessage: last?.text ?? '',
      silenceHint: parsed.silenceHint,
      containsSensitiveData: Boolean(parsed.containsSensitiveData) || sensitiveDataTypes.length > 0,
      sensitiveDataTypes,
      requiresConfirmation: Boolean(parsed.requiresConfirmation) || messages.some((message) => message.role === 'unknown' || message.confidence < 0.7),
      customerIdentity,
    };
  }
}

export function createConversationParser(config: AppConfig): ConversationParser {
  return config.modelDriver === 'openai_compatible' ? new OpenAICompatibleConversationParser(config) : new RuleBasedConversationParser();
}
