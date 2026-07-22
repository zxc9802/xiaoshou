# 内部试点部署

正式试点使用 PostgreSQL 保存分析、资料、反馈、审计和索引任务，S3 兼容对象存储保存聊天截图及资料媒体，Qdrant 保存可重建的知识向量索引。本地 `.data` 仅用于开发。

## 上线前

1. 在服务器环境变量中配置 `REPOSITORY_DRIVER=postgres`、`DATABASE_URL`、`OBJECT_STORAGE_DRIVER=s3` 及 S3 连接信息。
2. 模型密钥只配置在服务器，不提交到仓库。聊天中曾暴露过的密钥必须先轮换。
3. 先执行 `npm run migrate:cloud -- --dry-run` 核对本地数据数量，再执行 `npm run migrate:cloud`。该命令可重复运行，不会重复插入同 ID 数据。
4. 对比迁移前后的分析、资料、导入任务、反馈、审计和对象数量，再切换正式服务。

## Qdrant 部署与迁移

- Qdrant 必须部署在私有网络，生产环境启用 API key；API key 只放服务器密钥管理或环境变量，不得写入源码、日志、截图或文档。
- `/qdrant/storage` 必须使用持久卷。Qdrant 是检索索引而不是事实源，所有点都可以从 PostgreSQL 或本地文件仓库中的已发布 L2/L3 知识重建。
- 一个 embedding 模型和维度对应一个物理 collection。本版本使用 `text-embedding-3-small` 的 1536 维 Cosine collection `sales_knowledge_text_embedding_3_small_1536_v1`，通过 `sales_knowledge_current` alias 对外查询。
- 更换 embedding 模型时创建新 collection，完成全量 reindex 和抽检后原子切换 alias；不要直接修改旧 collection 的维度。
- 生成模型协议和 embedding 协议必须分开配置：生成模型可继续使用 Gemini `generateContent`，embedding 使用 OpenAI-compatible `/v1/embeddings`。
- 上线前先执行 `npm.cmd run knowledge:reindex -- --organization=default-org --dry-run`，再执行不带切换参数的真实 reindex，并核对条目数、切片数、`failed: 0` 和 Qdrant point 数。
- 只有新 collection 为 1536/Cosine、point 数等于切片数且真实重建 `failed: 0` 后，才执行 `npm.cmd run knowledge:reindex -- --organization=default-org --switch-alias`。该命令再次重建，并只在本轮零失败时原子切换 alias。
- 旧 3072 维 collection 作为短期回退目标保留，不得自动删除；若新索引召回异常，将 alias 原子切回旧 collection。
- 对 Qdrant 定期创建 snapshot，并至少每月演练一次“从 snapshot 恢复”和“从源仓库全量重建”两条恢复路径。

## 备份与保留

- PostgreSQL 每日全量备份并保留 30 天，每月至少做一次恢复演练。
- 对象存储开启版本控制、服务端加密和 30 天备份保留策略。
- Qdrant 持久卷纳入备份或 snapshot 计划，但恢复失败时以源仓库重新生成索引。
- 原始客户对话与截图默认保留 365 天，由服务定期清理。
- 只有已发布资料可以参与销售建议检索；迁移后抽检资料状态和引用位置。

## 运行检查

- `GET /api/health` 返回 PostgreSQL、S3、embedding 与 Qdrant 状态，不返回任何密钥。
- 强制中断一次分析并重启 API，确认任务可恢复且最终只有一份结果。
- 测试“取消分析”和“重新分析”，并确认执行次数和错误原因被保留。
- 上传未发布资料时不得命中；人工发布后应能出现在来源引用中。
