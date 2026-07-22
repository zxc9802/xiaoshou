# text-embedding-3-small 与 Qdrant 1536 维迁移设计

## 1. 目标

将知识库文字向量模型切换为 `text-embedding-3-small`，使用新的 1536 维 Qdrant 物理 collection，并在全量重建验证成功后切换现有 alias。

现有图片处理流程保持不变：图片先由多模态大模型提取、整理文字，经过人工审核发布后，只对审核后的文字进行向量化。本期不直接生成图片向量。

## 2. 已验证事实

已经使用当前云雾密钥完成真实请求：

```text
POST https://yunwu.ai/v1/embeddings
model: text-embedding-3-small
HTTP: 200
dimensions: 1536
prompt_tokens: 12
```

该实测只输出状态、模型、维度和 token 计数，没有输出密钥或完整向量。

## 3. 已确认决策

- 生成模型继续使用当前 Gemini-compatible `generateContent` 协议。
- 文字 embedding 独立使用 OpenAI-compatible `/v1/embeddings` 协议。
- embedding 模型为 `text-embedding-3-small`，固定校验 1536 维。
- Qdrant 继续使用单一 Cosine dense vector，不增加 named vector。
- 新物理 collection 不复用或修改现有 3072 维 collection。
- 新 collection 全量重建并验证后，原子切换 `sales_knowledge_current` alias。
- 旧 3072 维 collection 暂时保留作为回退目标，不自动删除。
- 取消图片直接向量化、Sharp、image vector 和 80/20 双路召回。

## 4. 配置边界

生成模型配置保持现状：

```text
MODEL_API_STYLE=gemini_generate_content
MODEL_BASE_URL=https://yunwu.ai
MODEL_API_KEY=<server secret>
```

新增独立 embedding 配置：

```text
EMBEDDING_API_STYLE=openai
EMBEDDING_BASE_URL=https://yunwu.ai
EMBEDDING_API_KEY=
EMBEDDING_MODEL_NAME=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
QDRANT_COLLECTION_NAME=sales_knowledge_text_embedding_3_small_1536_v1
QDRANT_COLLECTION_ALIAS=sales_knowledge_current
```

`EMBEDDING_API_KEY` 为空时复用 `MODEL_API_KEY`；`EMBEDDING_BASE_URL` 为空时复用 `MODEL_BASE_URL`。密钥只从服务端环境变量读取。

OpenAI embedding 地址规范化规则：

- base URL 以 `/v1` 结尾时，请求 `${baseUrl}/embeddings`；
- 否则请求 `${baseUrl}/v1/embeddings`。

这样当前 `https://yunwu.ai` 和常见的 `https://host/v1` 两种配置都不会出现重复或缺失 `/v1`。

## 5. Embedding 客户端

`createKnowledgeEmbedding` 不再根据生成模型的 `MODEL_API_STYLE` 选择协议，而只读取独立的 `EMBEDDING_API_STYLE`。

### OpenAI 模式

请求：

```json
{
  "model": "text-embedding-3-small",
  "input": "格式化后的知识文字或查询文字"
}
```

鉴权使用：

```text
Authorization: Bearer <embeddingApiKey or modelApiKey>
```

解析 `data[0].embedding`，并校验：

- 必须是数组；
- 所有元素必须是有限数值；
- 长度必须等于 `EMBEDDING_DIMENSIONS=1536`。

返回模型名、可用的 usage token 计数和向量；错误日志不得包含请求正文、密钥或完整响应。

### Gemini 模式

保留已有 Gemini embedding 协议能力，便于以后显式配置使用，但不再和生成模型协议自动绑定。

## 6. 切片与检索

本期不改变已实现的类型自适应切片规则：

- 文档、PDF、表格、聊天、图片解析文字、音视频转写继续按现有规则切片；
- 只有已发布、有效且未删除的 L2/L3 条目进入向量索引；
- 查询和文档仍分别使用现有 `formatRetrievalQuery` 与 `formatRetrievalDocument` 格式；
- Qdrant dense 候选继续与关键词、业务分类和有效期规则结合重排；
- Qdrant 不可用时继续退回关键词检索。

图片本身不发送给 embedding 模型，图片解析得到的审核文字与普通知识文字使用相同的 1536 维向量流程。

## 7. Qdrant collection

新物理 collection：

```text
sales_knowledge_text_embedding_3_small_1536_v1
```

配置：

```json
{
  "vectors": {
    "size": 1536,
    "distance": "Cosine"
  }
}
```

payload、tenant index、发布状态、层级、产品、套餐、业务分类、内容类型和有效期索引保持现状。

## 8. 物理 collection 与 alias 分工

- 索引重建的 upsert/delete 必须写入 `QDRANT_COLLECTION_NAME` 指定的物理 collection。
- 在线检索必须通过 `QDRANT_COLLECTION_ALIAS` 查询。
- 初始化发现 alias 已经指向旧 collection 时不得自动切换。
- 初始化只在 alias 不存在时创建 alias。
- 显式 alias 切换必须在全量重建无失败并完成抽检后执行。

该边界保证新 1536 维索引可以在旧 3072 维索引仍提供服务时完成构建。

## 9. 重建与切换流程

```text
确认 embedding 实请求为 1536 维
  -> 创建 1536 维新物理 collection
  -> dry-run 统计已发布条目、切片和 token
  -> 全量生成 1536 维向量并写入新物理 collection
  -> 核对条目数、切片数、失败数和 point 数
  -> 对固定问题集做影子检索抽检
  -> 原子切换 sales_knowledge_current alias
  -> 验证在线查询
  -> 保留旧 3072 维 collection 作为短期回退
```

alias 切换使用一个 Qdrant alias actions 请求同时删除旧指向并创建新指向。若重建有任何文字 embedding 或 Qdrant 写入失败，不允许切换。

## 10. 失败与回退

- embedding 请求失败：索引任务失败并按现有退避策略重试，知识发布状态不回滚。
- 返回维度不是 1536：视为硬失败，不写入 Qdrant。
- 新 collection 重建失败：alias 保持旧指向，线上继续使用旧索引。
- alias 切换失败：报告失败并保留旧指向；不得删除旧 collection。
- 新索引查询失败：应用继续使用现有关键词降级路径。
- 切换后发现召回异常：将 alias 原子切回旧 3072 维 collection。

## 11. 测试与验收

### 单元测试

- 生成模型为 Gemini 时，embedding 仍请求 OpenAI `/v1/embeddings`。
- `EMBEDDING_BASE_URL=https://yunwu.ai` 生成 `/v1/embeddings` 地址。
- `EMBEDDING_BASE_URL=https://host/v1` 生成 `/v1/embeddings` 地址且不重复 `/v1`。
- embedding 密钥优先使用 `EMBEDDING_API_KEY`，为空时回退 `MODEL_API_KEY`。
- `text-embedding-3-small` 返回 1536 维时成功。
- 返回非数值或非 1536 维时失败。
- Qdrant 创建 1536/Cosine collection。
- Qdrant upsert/delete 写物理 collection，search 读 alias。
- alias 已存在时初始化不切换。
- 显式切换 alias 使用一个原子 actions 请求。

### 集成验证

- 云雾真实 `/v1/embeddings` 请求返回 HTTP 200 和 1536 维。
- dry-run 不调用模型且输出条目数、切片数和估算 token。
- 全量 reindex 的失败数为 0。
- Qdrant point 数等于预期切片数。
- 新 alias 上的查询只返回当前企业已发布 L2/L3 条目。
- Qdrant 不可用时关键词降级仍可返回结果。
- 全量测试、TypeScript 检查、前端构建和 API 构建全部通过。

## 12. 安全要求

- 不在源码、测试、日志、文档或 Qdrant payload 中保存 API key。
- 不打印完整 embedding、请求正文或提供商错误响应正文。
- 不把聊天分析原图或知识原图直接发送给 embedding 接口。
- 不自动删除旧 3072 维 collection。
- 不在重建成功前自动切换线上 alias。

## 13. 被取代的文档

以下文档已废弃，不得执行：

- `docs/superpowers/specs/2026-07-22-qdrant-multimodal-image-fallback-design.md`
- `docs/superpowers/plans/2026-07-22-qdrant-multimodal-image-fallback.md`

原有类型自适应文字切片设计继续有效，但其中模型名和 3072 维 collection 配置由本设计覆盖。
