# Qdrant 类型自适应知识切片设计

日期：2026-07-22

状态：已确认设计，待用户审阅书面规格

## 1. 目标

为销转智能体建立可审核、可追溯、可扩展的知识检索链路：

1. 图片和聊天截图先由视觉大模型解析为文字及结构化内容。
2. 文档、表格、对话、图片、音视频按照各自语义结构切片。
3. 审核发布后的切片由 `gemini-embedding-2-preview` 生成向量。
4. 向量和检索 payload 存入 Qdrant。
5. 业务数据库仍是知识内容的唯一真实来源，Qdrant 是可重建的检索索引。
6. 检索结果保留企业、产品、套餐、版本、来源和时间范围，避免串线。

## 2. 已确认的外部接口

Embedding 请求地址：

```text
POST https://yunwu.ai/v1beta/models/gemini-embedding-2-preview:generateContent
```

鉴权密钥只从服务端环境变量读取，不写入代码、文档、日志或前端。

已通过无业务数据的最小请求确认：

- 请求体使用单数 `content.parts`，不是 Gemini 生成接口常见的 `contents`。
- 返回顶层字段包含 `embedding`、`usageMetadata` 和 `modelVersion`。
- 向量位于 `embedding.values`。
- 默认向量维度为 3072。

文本检索采用 Gemini Embedding 2 的非对称格式：

```text
文档：title: {title} | text: {content}
查询：task: search result | query: {query}
```

## 3. 范围与非目标

### 本期范围

- 已发布的 L2 销售技巧和 L3 企业事实进入 Qdrant。
- L0、L1 和用户自己的 L4 仍由现有业务库强制注入，不依赖向量命中。
- 支持文档、表格、聊天、图片、扫描 PDF、音频和视频的类型自适应切片。
- 保留现有关键词与业务分类加权，用于 Qdrant 候选结果的应用层重排。
- Qdrant 故障时退回现有关键词检索。

### 非目标

- 本期不引入第二套 sparse embedding 模型。
- 本期不直接把原始图片、PDF、音频或视频二进制送入 embedding 模型。
- 本期不让 Qdrant 成为知识正文的唯一存储。
- 本期不改变人工审核后才发布企业知识的业务约束。

## 4. 总体架构

```text
原始资料
  -> 类型识别与正文提取
  -> 图片/扫描件/音视频由大模型识别或转写
  -> 结构化章节
  -> AI 语义拆条
  -> 脱敏与人工审核
  -> 发布知识条目（业务库）
  -> 类型自适应 retrieval chunks
  -> Embedding Client
  -> Qdrant Index
```

读取链路：

```text
用户问题
  -> 查询向量
  -> Qdrant tenant/status/layer/有效期过滤
  -> dense top 30
  -> 应用层关键词、分类和有效期重排
  -> entryId 去重并按需补相邻块
  -> 返回前 12 条及来源
```

## 5. 组件边界

### 5.1 内容提取器

负责把原始文件转换为带来源位置的结构化章节，不负责向量化。

- DOCX：标题层级、段落、列表、表格。
- PDF：文本层、页码；扫描件进入视觉识别。
- PPTX：幻灯片标题、正文、备注和页码。
- XLSX/CSV：工作表、表头、行范围和单元格值。
- 图片：识别为聊天截图、产品/价格资料或普通图片。
- 音视频：带时间戳转写、话题章节和关键帧来源。

### 5.2 视觉文字分析器

沿用当前 Gemini 多模态生成模型，输出可审核文字和结构化 JSON。

- 聊天截图输出消息顺序、销售/客户角色、来源截图和置信度。
- 产品图片、海报和价格图片只提取画面明确出现的文字。
- 不能从场景图猜测效果、参数、价格或客户成果。
- 识别失败、低置信或无文字时保留原图并进入人工确认。

### 5.3 类型自适应切片器

输入已发布知识条目和来源结构，输出稳定的 retrieval chunks。知识条目是审核单位，chunk 是检索单位，两者不再混用。

### 5.4 Embedding Client

只负责：

- 生成文档或查询的 embedding 输入格式。
- 调用云雾 embedding 地址。
- 解析 `embedding.values`。
- 校验 3072 维、数值合法性和超时。
- 返回模型版本、用量和向量。

### 5.5 Vector Index

以 Qdrant 实现，负责 collection 初始化、point upsert/delete/query、payload filter、健康检查和别名切换。

### 5.6 索引工作流

负责业务库与 Qdrant 的最终一致性。Qdrant 写入失败不能回滚已经完成的知识审核发布。

## 6. 全局切片规则

- 默认目标：400–800 tokens。
- 单块正文默认最大值：1000 tokens。
- 加上标题和检索上下文后，embedding 输入不超过 1200 tokens。
- 切分必须落在标题、段落、列表项、句子、对话轮次、表格行或时间章节边界。
- 只有连续长正文使用 overlap。
- 独立价格、红线、售后规则、FAQ 和表格实体不做 overlap。
- 短原子事实可以低于 120 tokens，不为凑长度合并不同产品、版本、分类或有效期。
- 每个 chunk 重复必要的标题面包屑，但不重复无关正文。
- embedding 前完成隐私脱敏。

如果暂时无法准确预估 token，使用保守估算：中文字符按约 1 token，连续英文和数字按约 4 字符 1 token；实际调用后的 `usageMetadata` 用于监控偏差。

## 7. 按资料类型的切片策略

| 类型 | 原子边界 | 目标大小 | 重叠 |
| --- | --- | --- | --- |
| Word/Markdown/HTML/TXT | 标题、完整段落、列表 | 400–800 tokens | 同一长章节 60–100 tokens |
| 可复制 PDF | 标题、段落、页面位置 | 450–800 tokens | 跨页连续正文约 80 tokens |
| 扫描 PDF | OCR 阅读块、标题、页码 | 350–700 tokens | 仅连续正文重叠 |
| PPT | 同主题连续 1–3 页 | 300–700 tokens | 普通页不重叠，长备注约 60 tokens |
| Excel/CSV/表格 JSON | 表头加同类实体行 | 10–30 行或 400–800 tokens | 不重叠 |
| 普通 JSON | 一个业务对象或同类对象组 | 300–800 tokens | 不跨对象重叠 |
| 聊天记录/聊天截图 | 完整对话轮次和销售事件 | 8–16 轮或 350–700 tokens | 2 个完整轮次 |
| 产品/价格图片 | 一张图片的一组审核事实 | 通常单块 | 不重叠 |
| 长截图 | 视觉区块、段落或消息气泡 | 300–700 tokens | 连续聊天保留 2 个气泡 |
| 视频/音频 | 话题章节、说话人变化、自然停顿 | 45–120 秒或 400–800 tokens | 10–15 秒或 1–2 句话 |

### 7.1 文档

- 标题形成 `产品 > 套餐 > 章节` 面包屑。
- 章节不超限时保持完整。
- 超长章节依次按小标题、段落、列表项和句子拆分。
- 文档内表格转交表格策略，不按字符切断。

### 7.2 表格和报价单

- 每块重复表名、工作表名和表头。
- 一个产品、套餐、SKU、规格或价格行保持完整。
- 不同产品、币种、版本或有效期不得进入同一块。
- 金额必须和折扣权限、适用条件、有效期一起保存。
- 超宽表格根据 token 数减少每块行数。
- payload 保存工作表名和起止行号。

### 7.3 聊天记录和聊天截图

- 先恢复按时间顺序排列的消息和角色。
- 不拆开单条消息。
- 按需求确认、价格异议、效果质疑、竞品比较、推进成交、跟进收口或售后投诉等完整销售事件切片。
- 每块包含客户问题、销售回应和必要上下文。
- payload 保存会话 ID、轮次范围、异议类型、客户阶段和来源截图。

### 7.4 图片

- 聊天截图走聊天策略。
- 产品海报、价格图片先识别文字，再形成产品、规格、价格和限制条件单元。
- 普通产品照片只保存人工确认的说明，不从画面推测业务事实。
- 图片识别结果未确认前不得进入 Qdrant。

### 7.5 视频和音频

- 先获得带时间戳的转写。
- 根据话题、说话人和自然停顿形成章节，不按固定 30 秒机械切片。
- 超长章节再按完整句子拆分。
- payload 保存开始和结束秒数、章节标题和媒体来源。
- 关键帧作为引用证据，不单独产生未经审核的事实。

## 8. 业务语义边界

- 价格：产品、套餐、金额、币种、有效期和折扣条件必须在同一块。
- 红线：禁止事项、触发条件、例外和后果必须在同一块，不重叠。
- 售后：服务范围、响应时间、退款条件和限制不得拆开。
- 客户案例：可拆为背景、方案、结果和适用条件，但结果数据必须与限制条件绑定。
- 销售技巧：客户原话、销售回应、为什么有效和误用边界尽量同块。
- 竞品：一个竞品或一个对比维度一个块，不能混淆归属。
- FAQ：问题与答案作为一个原子块。

## 9. Qdrant 设计

### 9.1 Collection

物理 collection：

```text
sales_knowledge_gemini_embedding_2_preview_3072_v1
```

业务别名：

```text
sales_knowledge_current
```

配置：

- vector size：3072
- distance：Cosine
- 一个 embedding 模型和维度组合对应一个物理 collection。
- 不同 embedding 模型生成的向量绝不放入同一向量空间。

模型升级时创建新 collection，全量重建、验证后原子切换 alias。旧 collection 在确认稳定后再单独清理。

### 9.2 Point

每个 retrieval chunk 对应一个 point。point ID 由 `organizationId + entryId + contentHash + sequence` 稳定生成，保证重复索引幂等。

```json
{
  "id": "deterministic-uuid",
  "vector": ["3072 dimensions"],
  "payload": {
    "organizationId": "default-org",
    "entryId": "knowledge-entry-id",
    "chunkId": "chunk-id",
    "layer": "L2",
    "status": "published",
    "productId": "optional",
    "packageId": "optional",
    "businessCategory": "销售技巧",
    "category": "价格异议",
    "contentType": "chat",
    "title": "企业版价格异议处理",
    "breadcrumb": "产品A > 企业版 > 销售技巧",
    "content": "可审核切片正文",
    "sequence": 1,
    "tokenCount": 530,
    "sourceFileIds": [],
    "sourceSectionIds": [],
    "version": "1.0",
    "effectiveFromEpoch": 1784678400,
    "effectiveToEpoch": 1816214400,
    "contentHash": "sha256",
    "embeddingModel": "gemini-embedding-2-preview",
    "embeddingModelVersion": "provider-returned-version",
    "embeddingDimensions": 3072
  }
}
```

### 9.3 Payload 索引

第一版建立以下 payload 索引：

- `organizationId`：keyword，tenant 字段。
- `entryId`：keyword。
- `layer`：keyword。
- `status`：keyword。
- `productId`：keyword。
- `packageId`：keyword。
- `businessCategory`：keyword。
- `category`：keyword。
- `contentType`：keyword。
- `effectiveFromEpoch`：integer，可选。
- `effectiveToEpoch`：integer，可选。

所有查询必须包含 `organizationId` 和 `status=published`，并限制 `layer` 为 L2/L3。有效期使用可选的 epoch 秒字段：排除 `effectiveFromEpoch > now` 的未生效内容，也排除 `effectiveToEpoch < now` 的已过期内容；没有对应字段表示该方向不设边界。不得接受浏览器传入的 organizationId 作为唯一信任来源，必须使用服务端认证上下文。

## 10. 写入和同步

### 发布

1. 业务库保存已审核知识条目。
2. 写入 `vectorStatus=pending`。
3. 生成 chunks 和 embeddings。
4. upsert Qdrant points。
5. 成功后写入 `vectorStatus=indexed`、模型、维度、时间和 contentHash。
6. 失败写入 `vectorStatus=failed` 和可审计错误，后台重试。

业务库不再保存完整 vector，只保存索引状态元数据。

### 更新

1. 生成新版本 chunks 和稳定 IDs。
2. 先 upsert 新 points。
3. 成功后删除同一 entryId 下不再存在的旧 points。
4. 更新业务库索引状态。

### 归档和删除

- 根据服务端 organizationId 和 entryId 删除对应 points。
- Qdrant 删除失败时记录待清理任务并重试。
- 业务查询继续以业务库状态为准，已归档内容不得因索引延迟被返回。

### 全量重建

提供可重复执行的重建流程：读取所有已发布 L2/L3 条目，重新切片、生成向量并写入新物理 collection。验证后切换 alias。

## 11. 检索与重排

1. 对用户问题添加 query task 前缀并生成 3072 维向量。
2. Qdrant 按 organizationId、published、L2/L3 和有效期过滤，dense search 取前 30。
3. 应用层只对这 30 条计算现有关键词分和业务分类加权。
4. 按 entryId 去重，同一父条目最多保留两个 chunks。
5. 命中长文中间块时，可补同一 entryId 的前后相邻块。
6. 合并强制注入的 L0、L1 和当前用户 L4。
7. 返回最终前 12 条及来源。

第一版不建立 sparse vector。若离线评测证明专有名词、型号或精确价格召回不足，再新增 sparse 向量并使用 Qdrant RRF；不在没有证据时提前增加复杂度。

## 12. 故障和降级

- Qdrant 不可用：知识发布成功但标记 pending/failed，后台重试。
- Qdrant 查询失败：退回现有关键词检索并记录降级指标。
- Embedding 超时或 429：指数退避重试，设置最大次数，不阻塞 HTTP 请求无限等待。
- 向量不是 3072 维、含非有限数值或为空：拒绝写入。
- collection、模型或维度不一致：停止索引并报告配置错误。
- 视觉识别失败：保留原文件，进入人工确认，不生成向量。
- Qdrant 返回的 entryId 在业务库中不存在或已归档：丢弃该结果并安排索引清理。

## 13. 配置与安全

服务端配置项：

```text
QDRANT_URL
QDRANT_API_KEY
QDRANT_COLLECTION_ALIAS=sales_knowledge_current
QDRANT_TIMEOUT_MS
EMBEDDING_MODEL_NAME=gemini-embedding-2-preview
EMBEDDING_DIMENSIONS=3072
```

- 本地开发默认使用 Docker Qdrant 和持久化 volume。
- 正式环境可以接自建 Qdrant 或 Qdrant Cloud，代码只依赖 URL/API key。
- Qdrant 和模型密钥不得返回前端、写入日志或提交仓库。
- 正式环境必须启用鉴权和网络访问控制。
- 健康检查区分业务数据库、对象存储、生成模型、embedding 和 Qdrant。

## 14. 验证标准

### 单元测试

- 每种资料类型的边界、长度、重叠和元数据。
- 价格、红线、售后条件不被拆散。
- 图片识别未确认时不生成 chunk。
- embedding 请求和响应解析、3072 维校验。
- point ID 幂等和 payload tenant 字段。
- 更新时删除过期 chunks。

### 集成测试

- 创建测试 collection、payload indexes 和 alias。
- 发布、更新、归档、删除与重建。
- organizationId 隔离。
- Qdrant 不可用时发布不丢失、查询正确降级。
- embedding 失败后重试成功。

### 检索评测

使用至少 60 条真实问题，覆盖价格、案例、竞品、售后、红线、销售技巧及各种文件类型：

- Recall@5 >= 90%。
- 第一条结果命中率 >= 75%。
- 正确来源进入前 5 名 >= 90%。
- 不同产品、套餐和版本串线率 < 2%。
- Top 10 重复内容比例 < 20%。
- 未审核资料进入结果数为 0。

## 15. 迁移与上线原则

- 先建立 Qdrant 索引并在后台做影子查询，不立即删除关键词降级路径。
- 对现有所有已发布 L2/L3 知识执行一次全量切片和向量化。
- 对比现有关键词结果与 Qdrant 结果，完成上述评测后再切换主检索。
- 切换后继续记录降级率、索引失败数、查询延迟、空结果率和跨产品错误。
- Qdrant 是可重建索引；业务库和原始文件的备份策略保持不变。

## 16. 参考资料

- Gemini Embeddings：https://ai.google.dev/gemini-api/docs/embeddings
- Qdrant Collections：https://qdrant.tech/documentation/manage-data/collections/
- Qdrant Multitenancy：https://qdrant.tech/documentation/manage-data/multitenancy/
- Qdrant Hybrid Queries：https://qdrant.tech/documentation/search/hybrid-queries
- Qdrant TypeScript client：https://github.com/qdrant/qdrant-js
