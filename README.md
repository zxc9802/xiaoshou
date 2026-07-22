# 销转智能体内部试点

这是一个单企业内部试点版本：前端采用 React + TypeScript + Vite，后端采用 Node.js + TypeScript + Fastify。系统已实现任务状态机、对话确认、最多两次补充提问、L0–L4 知识检索、生成后校验、历史记录、反馈、资料审核发布与审计入口。

智能体只生成建议，不会代替销售发送客户消息。

## 本地快速启动

```bash
npm install
npm.cmd run qdrant:up
npm.cmd run dev:all
```

- 工作台：http://127.0.0.1:5173/
- API 健康检查：http://127.0.0.1:8787/api/health
- 资料库：http://127.0.0.1:5173/materials

默认使用本地文件数据库与文件附件存储。配置多模态模型后，图片先由大模型提取和整理文字，再经人工确认；确认发布的 L2/L3 内容会按类型切片、向量化并写入 Qdrant。

## Qdrant 与知识索引

本地开发先运行 `npm.cmd run qdrant:up`，再运行 `npm.cmd run dev:all`。Qdrant 数据保存在 Docker volume `qdrant_data` 中，当前文字向量模型为 `text-embedding-3-small`（1536 维），物理 collection 为 `sales_knowledge_text_embedding_3_small_1536_v1`，应用通过别名 `sales_knowledge_current` 查询。图片仍先由多模态大模型解析为审核文字，不直接生成图片向量。

首次启用或需要重建索引时，先只统计，不调用模型：

```bash
npm.cmd run knowledge:reindex -- --organization=default-org --dry-run
```

确认条目数、切片数和估算 token 数后再执行真实重建：

```bash
npm.cmd run knowledge:reindex -- --organization=default-org
```

真实重建输出 `failed: 0`，并核对新物理 collection 的 1536/Cosine 配置和 point 数等于切片数后，才允许显式切换 alias：

```bash
npm.cmd run knowledge:reindex -- --organization=default-org --switch-alias
```

`--switch-alias` 会再次完成一轮重建，只有本轮仍为零失败时才原子切换 `sales_knowledge_current`。旧 3072 维 collection 不会自动删除，可作为短期回退目标。

`GET http://127.0.0.1:8787/api/health` 中，`embedding.configured` 表示向量模型参数是否完整，`qdrant.configured` 表示是否设置了服务地址，`qdrant.ok` 表示当前 collection/别名能否访问。Qdrant 暂时不可用时，分析 API 仍会使用关键词检索；待服务恢复后，持久化索引任务会自动重试。

停止或查看本地 Qdrant：

```bash
npm.cmd run qdrant:logs
npm.cmd run qdrant:down
```

## 接入真实试点基础设施

1. 复制 `.env.example` 为 `.env`。
2. 执行 `server/db/schema.sql` 初始化 PostgreSQL。
3. 设置 `REPOSITORY_DRIVER=postgres` 和 `DATABASE_URL`。
4. 设置 `OBJECT_STORAGE_DRIVER=s3` 及 S3 兼容对象存储参数。
5. 生成模型保持自身协议配置；另设置 `EMBEDDING_API_STYLE=openai`、`EMBEDDING_MODEL_NAME=text-embedding-3-small`、`EMBEDDING_DIMENSIONS=1536`。embedding 地址/密钥未单独设置时复用模型地址/密钥。
6. 设置 Qdrant 地址、密钥（如启用鉴权）、物理 collection 与 alias。
7. 通过资料库批量导入资料包或创建知识，人工确认后发布；只有已发布且有效的 L2/L3 条目进入向量索引，L0/L1/L4 仍按固定规则加载。

正式试点建议设置 `WORKER_MODE=external`，分别启动 `npm run start:api` 与 `npm run start:worker`。Worker 使用 PostgreSQL 的行级锁领取任务；本地默认 `inline`，无需额外进程。

默认保存期限为 365 天，可通过 `RETENTION_DAYS` 调整。对象存储使用服务端加密；正式部署还应在网关层接入企业身份认证，并定时调用到期清理任务。

## API

- `POST /api/v1/analyses`：提交文本和最多 10 张截图
- `GET /api/v1/analyses/:id`：读取进度、识别结果、追问和分析结果
- `POST /api/v1/analyses/:id/confirm-transcript`：修正确认识别结果
- `POST /api/v1/analyses/:id/clarifications`：回答补充问题
- `POST /api/v1/analyses/:id/continue`：追加客户回复
- `POST /api/v1/analyses/:id/feedback`：提交采用/不适用/修改后采用/复盘反馈
- `GET /api/v1/analyses`：历史对话
- `GET /api/v1/analyses/:id/attachments/:index`：本人或企业管理员读取原图，并写入审计日志
- `/api/v1/knowledge`：知识条目创建、上传、审核发布和归档
- `POST /api/v1/knowledge/imports`：一键导入多文件或zip资料包，支持图片、PDF、Word、PPT、Excel、文本、Markdown、CSV、JSON等，单文件不超过25MB
- `GET /api/v1/knowledge/imports/:id`：查看资料导入进度、来源文件和AI整理出的候选条目
- `POST /api/v1/knowledge/imports/:id/candidates/:candidateId/split|merge|discard`：人工审核时拆分、合并或丢弃候选条目
- `POST /api/v1/knowledge/imports/:id/confirm`：人工确认候选条目后批量发布，确认前不会参与智能体检索
- `GET /api/v1/knowledge/export?format=excel|json|markdown`：导出已发布资料库，包含层级、业务归档、来源、版本、审核人与发布时间
- `POST /api/v1/knowledge/upload`：保留单文件上传兼容入口，自动提取正文并生成L2/L3归类建议
- `POST /api/v1/knowledge/:id/confirm-classification`：人工修正并确认单文件自动归类，确认后才发布
- `GET/PUT /api/v1/profile/style`：销售个人 L4 表达风格
- `GET /api/v1/metrics`：复盘中心试点指标与标签覆盖
- `GET /api/v1/audit-logs`：企业管理员查看审计记录

请求默认使用 `x-organization-id` 与 `x-user-id` 标识内部用户；正式部署应由认证网关注入，不能直接信任浏览器传值。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run build:api
```

规则测试覆盖价格异议、沉默、模糊、卡住、连续拒绝、投诉升级、隐私脱敏、追问上限和缺少 L3 来源等关键路径。

## 目录

- `src/`：工作台、资料库及前端 API 客户端
- `server/`：API、任务编排、模型适配层、规则引擎、存储与数据库实现
- `shared/`：前后端共用类型
- `server/knowledge/pilot-enterprise.example.json`：企业首批知识录入模板

资料库支持批量导入PDF、DOCX、PPTX、XLSX、CSV、JSON、TXT、Markdown、HTML、图片、zip资料包及其他非可执行内容文件。系统会先自动提取、拆分、建议归档，再由管理员确认发布。无法可靠提取正文的格式会保留原文件、给出低置信度建议，并停在人工审核状态。
