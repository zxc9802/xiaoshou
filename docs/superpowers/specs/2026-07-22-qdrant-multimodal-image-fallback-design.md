# Qdrant 图片向量辅助召回设计

> **状态：已废弃，不执行。** 用户已于 2026-07-22 取消图片直接向量化，改用纯文字 `text-embedding-3-small` 1536 维方案。现行设计见 `2026-07-22-text-embedding-3-small-qdrant-design.md`。

## 1. 目标

在现有“图片由多模态大模型解析文字，再生成文字向量”的流程之外，为所有已发布 L2/L3 知识图片预生成直接图片向量。

文字向量仍是主召回信号；图片向量用于补召回、视觉相似内容检索和文字提取不完整时的兜底，不替代人工审核后的文字知识。

## 2. 已确认的决策

- 使用 `gemini-embedding-2-preview` 同时生成文字向量和图片向量。
- 所有已发布 L2/L3 条目关联的图片都预生成图片向量，不只处理文字解析失败的图片。
- Qdrant 使用一个新的多模态物理 collection，并配置 `text`、`image` 两个 named vector。
- 文字切片和图片素材使用不同 point，避免把同一图片向量重复写入每个文字切片。
- 检索以文字结果为主，图片结果按 20% 权重参与融合。
- 图片向量生成失败不得阻止已审核文字知识被检索。
- 旧单向量 collection 不原地修改；全量重建新 collection 并验证后切换 alias。

## 3. 不在本期范围内

- 不以图片向量代替视觉大模型的文字提取和人工审核。
- 不把未发布、待审核、已归档或已删除资料写入图片索引。
- 不直接向最终回答模型传递图片向量。
- 不增加独立 OCR 服务。
- 不处理视频整体向量；视频仍按现有转写、关键帧和文字切片流程处理。
- 不增加 sparse embedding 模型。

## 4. 方案比较

### 4.1 采用方案：同一 collection 的 named vectors

新 collection 同时定义：

```json
{
  "vectors": {
    "text": { "size": 3072, "distance": "Cosine" },
    "image": { "size": 3072, "distance": "Cosine" }
  }
}
```

文字切片 point 只携带 `text` 向量，图片素材 point 只携带 `image` 向量。两类 point 共用 organization、entry、发布状态、知识层级和有效期过滤字段。

优点是租户隔离、生命周期和 alias 切换仍由一个索引组件管理，同时可以独立查询两个向量空间。

### 4.2 未采用：两个独立 collection

文本 collection 可以保持不变，但图片 collection 需要独立的初始化、alias、删除、健康检查和迁移流程，增加最终一致性维护成本。

### 4.3 未采用：图片与文字合成单一向量

单向量实现较少，但精确型号、价格和规则召回会被视觉语义干扰，也无法单独调整图片兜底权重。

## 5. 数据来源

图片素材有两种已存在的来源：

1. 导入资料发布产生的素材：`structuredData.mediaAssets` 保存 `importJobId` 和 `sourceFileId`。索引服务通过知识导入任务找到对应 `KnowledgeSourceFile.storageKey`。
2. 条目发布后上传的素材：`structuredData.mediaAssets` 直接保存 `storageKey`。

索引服务只读取 `kind === "image"` 或 `mimeType` 以 `image/` 开头的素材，并按 `mediaId` 去重。找不到源文件、对象存储读取失败或图片无法解码时记录单图失败，不猜测或生成替代内容。

## 6. 图片预处理

- `image/png` 和 `image/jpeg` 直接送入 embedding 接口。
- `image/jpg` 规范化为 `image/jpeg`。
- WebP、GIF、HEIC 等其他已接收图片先解码，并转为静态 JPEG；动画图片只取第一帧。
- 保持原图宽高比，不裁切业务内容。
- 转换后的数据只用于 embedding 请求，不覆盖对象存储中的原始文件。
- 解码失败时保留文字索引并记录图片索引失败。

图片预处理输出统一结构：

```ts
interface EmbeddingImageInput {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: Buffer;
}
```

## 7. Embedding 客户端

保留现有 `createKnowledgeEmbedding(text, config)` 文字接口，新增只接收图片的接口：

```ts
createKnowledgeImageEmbedding(image, config): Promise<EmbeddingResult | undefined>
```

云雾兼容性验证分两步：

1. 使用一张不含业务数据的最小 PNG 请求当前用户指定的 `generateContent` 地址，发送 `inline_data`。
2. 校验响应是否仍为 `embedding.values`、是否是 3072 维有限数值，并记录 HTTP 状态和不含密钥的错误摘要。

图片请求不得把 API key、原始 base64 或响应向量写入日志。如果云雾不接受该请求形态，停止图片代码上线并保留现有文字索引，不根据 Google 官方协议猜测代理兼容性。

## 8. Qdrant point 设计

### 8.1 文字切片 point

```json
{
  "id": "deterministic-text-point-id",
  "vector": { "text": [0.1, 0.2] },
  "payload": {
    "pointKind": "text_chunk",
    "organizationId": "org-a",
    "entryId": "entry-a",
    "chunkId": "chunk-a",
    "sequence": 0,
    "layer": "L3",
    "status": "published",
    "content": "审核后的知识文字"
  }
}
```

### 8.2 图片素材 point

```json
{
  "id": "deterministic-image-point-id",
  "vector": { "image": [0.1, 0.2] },
  "payload": {
    "pointKind": "image_asset",
    "organizationId": "org-a",
    "entryId": "entry-a",
    "mediaId": "media-a",
    "layer": "L3",
    "status": "published",
    "fileName": "产品海报.jpg",
    "content": "条目标题和审核后的简短文字"
  }
}
```

图片 point ID 由 `organizationId + entryId + mediaId + 原图内容哈希 + 模型名` 确定性生成。图片替换或内容变化会生成新 ID，随后删除旧 point。

payload 不保存对象存储密钥、图片 base64、API key 或完整 embedding 输入。

## 9. 索引工作流

发布或更新 L2/L3 条目时沿用持久化索引任务：

```text
读取已发布条目
  -> 生成文字 chunks 和 text embeddings
  -> 解析条目关联的全部图片素材
  -> 从对象存储读取并规范化图片
  -> 生成 image embeddings
  -> 写入新 collection
  -> 删除同 entryId 下已失效的 point
  -> 更新条目索引状态
```

索引触发点必须覆盖：知识条目发布或修改、知识条目上传图片、产品档案上传或移除图片、条目归档、软删除、恢复和永久删除。图片增删后立即调度该条目的 upsert；最后一个素材条目被删除时调度 entry delete，避免残留图片 point。

索引状态增加图片统计信息：

```json
{
  "status": "indexed",
  "textChunkCount": 4,
  "imageCount": 3,
  "imageIndexedCount": 2,
  "imageFailedCount": 1,
  "imageFailures": [
    { "mediaId": "media-c", "reason": "image_decode_failed" }
  ]
}
```

`imageFailures` 只保存稳定错误码，不保存模型响应正文或存储路径。

## 10. 部分失败处理

- 文字 embedding 失败：维持现有行为，索引任务失败并按退避策略重试。
- 单张图片读取、转换或 embedding 失败：其他文字和图片 point 仍然写入；条目标记为图片部分失败。
- Qdrant 整体写入失败：任务失败并重试，业务库中的发布状态不回滚。
- 图片索引部分失败不会使 Qdrant 可用性健康检查整体失败；失败数量保存在条目的索引状态中。
- 后续全量 reindex 或该条目再次更新时，重新尝试失败图片。

## 11. 检索与融合

用户文字问题只生成一次 query embedding。由于模型把文字和图片映射到统一空间，同一个 query vector 分别查询：

- `using: "text"`，取前 30 个文字 point；
- `using: "image"`，取前 20 个图片 point。

应用层按 `entryId` 聚合：每个向量空间只保留该条目的最高分。先在各自结果内归一化，再计算：

```text
vectorScore = 0.8 * normalizedTextScore + 0.2 * normalizedImageScore
```

缺少某一路分数时该项按 0 计算，但满足以下兜底规则：文字候选不足最终 limit 时，按图片分数补足尚未出现的 entry。随后继续沿用现有关键词、业务分类和有效期重排。

图片命中的返回内容仍是审核后的知识条目文字，不直接把图片内容当成可回答事实。

## 12. Collection 迁移

新物理 collection 建议命名：

```text
sales_knowledge_gemini_embedding_2_preview_multimodal_3072_v2
```

迁移顺序：

1. 建立包含 `text`、`image` named vectors 的 v2 collection 和 payload indexes。
2. 对全部已发布 L2/L3 条目执行全量 reindex。
3. 核对文字切片数、图片素材数、成功数、失败数和 Qdrant point 数。
4. 使用固定评测问题比较 v1 和 v2 的文本召回，并加入视觉相关问题验证图片兜底。
5. 验证通过后原子切换 `sales_knowledge_current` alias。
6. 保留 v1 collection 作为短期回退目标，确认稳定后再按运维流程清理。

重建期间的 upsert/delete 始终指向配置的 v2 物理 collection，线上查询始终指向 alias。初始化发现 alias 已指向 v1 时不得自动改指向，只有完成核对后的显式迁移动作才能切换 alias。

## 13. 验收标准

### 单元测试

- 图片 embedding 请求使用 `inline_data`，不泄露 API key。
- 图片 embedding 返回值经过有限数值和 3072 维校验。
- PNG/JPEG 直传，其他图片转为 JPEG，解码失败返回稳定错误码。
- 能分别从直接 `storageKey` 和导入任务 `sourceFileId` 读取图片。
- Qdrant 创建两个 named vector，并按 point 类型写入正确的向量名。
- 文字和图片查询使用正确的 `using` 名称。
- 融合排序符合 80/20 权重，文字候选不足时图片结果能够补位。
- 单张图片失败时文字 point 仍可写入，索引状态记录部分失败。
- 条目归档、删除或移除图片后，对应 point 被清理。

### 集成验证

- 使用非业务测试 PNG 完成一次云雾图片 embedding 实请求。
- 在本地 Qdrant v2 collection 完成创建、写入、双路查询、删除和 alias 切换演练。
- 全量 reindex 的文字条目数与 v1 一致。
- 未发布或非 L2/L3 条目进入图片检索的数量为 0。
- 图片 embedding 不可用时，现有文字检索结果和降级路径保持可用。

## 14. 安全与成本边界

- 图片只在知识管理员确认发布后发送 embedding 服务。
- 不发送未发布聊天截图作为知识索引；聊天分析流程不因本设计扩大数据用途。
- API key 只从服务端环境变量读取。
- 使用原图内容哈希生成稳定 point ID，避免同一次替换产生重复 point；本期不增加独立向量缓存。
- 全量重建输出计数和错误码，不输出图片内容或模型向量。

## 15. 参考资料

- Gemini Embeddings: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini Embedding 2 model: https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2-preview
- Qdrant named vectors: https://qdrant.tech/documentation/manage-data/vectors/
- Qdrant points: https://qdrant.tech/documentation/concepts/points/
- Qdrant hybrid queries: https://qdrant.tech/documentation/search/hybrid-queries
