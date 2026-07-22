import { randomUUID } from 'node:crypto';
import type { KnowledgeCandidate, KnowledgeEntry, KnowledgeMediaAsset, ProductPackage, ProductProfile, ProductProfileDetail, ProductProfileView, ProductStatus } from '../shared/contracts.js';
import type { ObjectStorage, Repository, RequestActor } from './domain.js';

function businessCategory(entry: KnowledgeEntry) {
  return String(entry.structuredData?.businessCategory ?? '');
}

function mediaAssets(entry: KnowledgeEntry) {
  return Array.isArray(entry.structuredData?.mediaAssets) ? entry.structuredData.mediaAssets as KnowledgeMediaAsset[] : [];
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s·・_-]+/g, '');
}

function inferProductName(entry: KnowledgeEntry) {
  const explicit = String(entry.structuredData?.entityName ?? '').trim();
  if (explicit) return explicit;
  const contentMatch = entry.content.match(/产品名称\s*[：:]\s*([^，,；;。\n]+)/);
  if (contentMatch?.[1]) return contentMatch[1].trim();
  const titleMatch = entry.title.match(/^(.{2,40}?)(?:产品规格|产品说明|产品资料|产品价值|基本参数)/);
  return titleMatch?.[1]?.trim() ?? '';
}

function isProductKnowledge(entry: KnowledgeEntry) {
  if (businessCategory(entry) !== '产品资料') return false;
  return !/(客户画像|客户需求|显性需求|案例|资料索引|法规|参考链接)/.test(`${entry.title}\n${entry.category}`);
}

function inferredPackage(entry: KnowledgeEntry): ProductPackage | undefined {
  const price = entry.content.match(/(?:建议零售价|价格|售价)\s*[：:]\s*([^；;。\n]+)/)?.[1]?.trim();
  const specification = entry.content.match(/(?:规格|套餐)\s*[：:]\s*([^；;。\n]+)/)?.[1]?.trim();
  if (!price && !specification) return undefined;
  return { id: randomUUID(), name: specification || '标准方案', priceDescription: price, applicableConditions: specification };
}

function completeness(product: ProductProfile, entries: KnowledgeEntry[]) {
  const text = entries.map((entry) => `${entry.category}\n${entry.title}\n${entry.content}`).join('\n');
  const checks = [
    Boolean(product.positioning.trim()),
    Boolean(product.targetCustomers.trim()),
    product.packages.length > 0,
    /参数|规格|功能|基础信息|产品名称/.test(text),
    /价值|卖点|优势|定位/.test(text),
    /问题|回答|话术|FAQ|使用|饮用/.test(text),
    /服务|售后|承诺|禁用|红线|边界/.test(text),
    entries.some((entry) => mediaAssets(entry).length > 0),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export class ProductService {
  constructor(private readonly repository: Repository, private readonly storage?: ObjectStorage) {}

  async initialize(organizationId = 'default-org') {
    const [products, entries] = await Promise.all([this.repository.listProducts(organizationId), this.repository.listKnowledge(organizationId)]);
    const activeProductEntries = entries.filter((entry) => !entry.deletedAt && isProductKnowledge(entry));
    const groups = new Map<string, KnowledgeEntry[]>();
    for (const entry of activeProductEntries.filter((item) => !item.productId)) {
      const groupKey = String(entry.structuredData?.importJobId ?? entry.structuredData?.sourceFileName ?? entry.id);
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), entry]);
    }
    for (const groupedEntries of groups.values()) {
      const inferredName = groupedEntries.map(inferProductName).find(Boolean);
      if (!inferredName) continue;
      let product = products.find((item) => [item.name, ...item.aliases].some((name) => normalize(name) === normalize(inferredName)));
      if (!product) {
        const now = new Date().toISOString();
        const packageEntry = groupedEntries.find((entry) => inferredPackage(entry));
        product = {
          id: randomUUID(), name: inferredName, aliases: [],
          positioning: groupedEntries.find((entry) => /定位|价值主张/.test(`${entry.title}${entry.category}`))?.content.slice(0, 180) ?? '',
          targetCustomers: '', packages: packageEntry ? [inferredPackage(packageEntry)!] : [], tags: [], status: 'published',
          createdAt: now, updatedAt: now,
        };
        await this.repository.createProduct(organizationId, product);
        products.push(product);
      }
      for (const entry of groupedEntries) {
        await this.repository.updateKnowledge(organizationId, { ...entry, productId: product.id, updatedAt: new Date().toISOString() });
      }
    }
  }

  private async view(organizationId: string, product: ProductProfile): Promise<ProductProfileView> {
    const entries = (await this.repository.listKnowledge(organizationId)).filter((entry) => entry.productId === product.id && !entry.deletedAt);
    return { ...product, knowledgeCount: entries.length, mediaCount: entries.reduce((sum, entry) => sum + mediaAssets(entry).length, 0), completeness: completeness(product, entries) };
  }

  async list(organizationId: string, status?: ProductStatus) {
    const products = (await this.repository.listProducts(organizationId)).filter((product) => !status || product.status === status);
    return Promise.all(products.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((product) => this.view(organizationId, product)));
  }

  async getDetail(organizationId: string, id: string): Promise<ProductProfileDetail> {
    const product = await this.repository.getProduct(id);
    if (!product) throw new Error('产品档案不存在');
    const entries = (await this.repository.listKnowledge(organizationId)).filter((entry) => entry.productId === id && !entry.deletedAt);
    return {
      product: await this.view(organizationId, product), entries,
      media: entries.flatMap((entry) => mediaAssets(entry).map((asset) => ({ ...asset, entryId: entry.id }))),
    };
  }

  async create(actor: RequestActor, input: Pick<ProductProfile, 'name' | 'aliases' | 'positioning' | 'targetCustomers' | 'packages' | 'tags'> & { status?: ProductStatus }) {
    const existing = await this.repository.listProducts(actor.organizationId);
    if (existing.some((product) => normalize(product.name) === normalize(input.name))) throw new Error('已存在同名产品档案');
    const now = new Date().toISOString();
    const product: ProductProfile = { id: randomUUID(), ...input, status: input.status ?? 'draft', createdAt: now, updatedAt: now };
    await this.repository.createProduct(actor.organizationId, product);
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action: 'product.create', targetType: 'product', targetId: product.id, createdAt: now });
    return this.view(actor.organizationId, product);
  }

  async update(actor: RequestActor, id: string, input: Partial<Pick<ProductProfile, 'name' | 'aliases' | 'positioning' | 'targetCustomers' | 'packages' | 'tags' | 'status' | 'cover'>>) {
    const product = await this.repository.getProduct(id);
    if (!product) throw new Error('产品档案不存在');
    if (input.cover) {
      const entry = await this.repository.getKnowledge(input.cover.entryId);
      const asset = entry && entry.productId === id && !entry.deletedAt
        ? mediaAssets(entry).find((item) => item.id === input.cover!.mediaId)
        : undefined;
      if (!asset || asset.kind !== 'image') throw new Error('只能将当前产品中的有效图片设为封面');
    }
    const updated: ProductProfile = { ...product, ...input, id: product.id, updatedAt: new Date().toISOString() };
    await this.repository.updateProduct(actor.organizationId, updated);
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action: 'product.update', targetType: 'product', targetId: id, metadata: { status: updated.status }, createdAt: updated.updatedAt });
    return this.view(actor.organizationId, updated);
  }

  async linkKnowledge(actor: RequestActor, productId: string, entryIds: string[], packageId?: string) {
    const product = await this.repository.getProduct(productId);
    if (!product) throw new Error('产品档案不存在');
    for (const id of entryIds) {
      const entry = await this.repository.getKnowledge(id);
      if (!entry || entry.deletedAt) continue;
      await this.repository.updateKnowledge(actor.organizationId, { ...entry, productId, packageId, updatedAt: new Date().toISOString() });
    }
    return this.getDetail(actor.organizationId, productId);
  }

  async addMedia(actor: RequestActor, productId: string, file: { name: string; mimeType: string; data: Buffer }) {
    if (!this.storage) throw new Error('媒体存储服务未配置');
    const product = await this.repository.getProduct(productId);
    if (!product) throw new Error('产品档案不存在');
    const kind = file.mimeType.startsWith('image/') ? 'image' : file.mimeType.startsWith('video/') ? 'video' : undefined;
    if (!kind) throw new Error('媒体素材仅支持图片或视频');
    const now = new Date().toISOString();
    const entries = await this.repository.listKnowledge(actor.organizationId);
    let entry = entries.find((item) => item.productId === productId && item.category === '产品媒体' && !item.deletedAt);
    if (!entry) {
      entry = { id: randomUUID(), productId, origin: 'manual', locked: false, layer: 'L3', category: '产品媒体', title: `${product.name}图片与视频`, content: '该条目用于保存产品原始图片、视频和宣传素材。', version: '1.0', status: 'published', reviewer: actor.userId, publishedAt: now, structuredData: { businessCategory: '产品资料', mediaAssets: [] }, createdAt: now, updatedAt: now };
      await this.repository.createKnowledge(actor.organizationId, entry);
    }
    const assetId = randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `${actor.organizationId}/products/${productId}/media/${assetId}/${safeName}`;
    await this.storage.put(storageKey, file.data, file.mimeType);
    const asset: KnowledgeMediaAsset = { id: assetId, name: file.name, mimeType: file.mimeType, size: file.data.length, kind, storageKey, createdAt: now };
    await this.repository.updateKnowledge(actor.organizationId, { ...entry, structuredData: { ...entry.structuredData, mediaAssets: [...mediaAssets(entry), asset] }, updatedAt: now });
    return this.getDetail(actor.organizationId, productId);
  }

  async removeMedia(actor: RequestActor, productId: string, mediaId: string) {
    if (!this.storage) throw new Error('媒体存储服务未配置');
    const product = await this.repository.getProduct(productId);
    if (!product) throw new Error('产品档案不存在');
    const entries = (await this.repository.listKnowledge(actor.organizationId)).filter((entry) => entry.productId === productId && !entry.deletedAt);
    const entry = entries.find((item) => mediaAssets(item).some((asset) => asset.id === mediaId));
    if (!entry) throw new Error('媒体素材不存在');
    const asset = mediaAssets(entry).find((item) => item.id === mediaId)!;
    if (asset.storageKey && !asset.importJobId) await this.storage.delete(asset.storageKey);
    const remainingAssets = mediaAssets(entry).filter((item) => item.id !== mediaId);
    if (entry.category === '产品媒体' && entry.origin === 'manual' && remainingAssets.length === 0) {
      await this.repository.deleteKnowledge(actor.organizationId, entry.id);
    } else {
      await this.repository.updateKnowledge(actor.organizationId, { ...entry, structuredData: { ...entry.structuredData, mediaAssets: remainingAssets }, updatedAt: new Date().toISOString() });
    }
    if (product.cover?.entryId === entry.id && product.cover.mediaId === mediaId) {
      await this.repository.updateProduct(actor.organizationId, { ...product, cover: undefined, updatedAt: new Date().toISOString() });
    }
    await this.repository.addAudit({ id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, action: 'product.media.delete', targetType: 'product', targetId: productId, metadata: { mediaId, entryId: entry.id, name: asset.name }, createdAt: new Date().toISOString() });
    return this.getDetail(actor.organizationId, productId);
  }

  async enrichCandidate(organizationId: string, candidate: KnowledgeCandidate) {
    const products = await this.repository.listProducts(organizationId);
    const inferred = candidate.suggestedProductName?.trim() || inferProductName({ title: candidate.title, content: candidate.content, category: candidate.category, structuredData: {}, id: '', layer: candidate.layer, version: candidate.version, status: 'draft', createdAt: '', updatedAt: '' });
    if (!inferred) return candidate;
    const exact = products.find((product) => [product.name, ...product.aliases].some((name) => normalize(name) === normalize(inferred)));
    const similar = exact ?? products.find((product) => normalize(product.name).includes(normalize(inferred)) || normalize(inferred).includes(normalize(product.name)));
    return { ...candidate, suggestedProductName: inferred, suggestedProductId: similar?.id, productMatchConfidence: exact ? 0.95 : similar ? 0.72 : 0.45 };
  }
}
