# 员工用量上报

服务端读取已验证的 SSO 员工身份（后台任务使用任务所属员工），将模型调用用量发送到主站 `POST /api/sso/usage`。不发送提示词、回答、图片或供应商密钥，也不修改现有积分扣费。

## 部署配置

```dotenv
MAIN_APP_URL=https://www.gzjiamei.online
USAGE_TOOL=xiaoshou
USAGE_REPORT_SECRET=<该工具独立的服务端上报密钥>
USAGE_OUTBOX_DIR=/data/usage-outbox
```

主站 `SSO_USAGE_SECRETS` JSON 中的 `xiaoshou` 密钥必须与这里相同。不要使用 NEXT_PUBLIC_/VITE_ 前缀，不要提交真实密钥。

先合并部署主站用量监控 PR（wb-dianshangjiqiren #3），再合并本工具修改到 Zeabur 当前部署分支并重新部署。配置已有的环境变量不会自动加入上报代码。旧 SSO 登录和积分扣费接口及其密钥仍须正常工作。

在 Zeabur 挂载持久硬盘到 `/data`，并设置上述 `USAGE_OUTBOX_DIR`；如果 `/data` 已有硬盘，复用它。不要替换已有数据盘。未配置时默认 DATA_DIR 或工作目录下的 `.usage-outbox`，这种默认目录若无持久盘，重新部署可能丢失待上报记录。

## 统计口径与重试

- 每次实际模型请求使用独立 requestId；上报重试保留同一 ID，主站负责幂等。
- OpenAI/Responses、Gemini、Anthropic 原始用量归一化；缓存和推理 Token 不重复加入总量。供应商未返回用量时保留 null，不按 0 或字符数伪造。
- 未获得实际账单金额时由主站管理员配置的模型费率估算；费率的 provider 值使用记录中的供应商域名。未配置费率会显示金额未知。
- 网络失败和流式中断记录对应状态。上报失败落盘，每 30 秒重试（Node 失败有退避）。进程意外停止留下的请求在 24 小时后按中断、未知用量恢复，不伪造实际消耗。
- 若所有三个必需变量没有配齐，上报关闭；启用后缺少可信员工身份或不能写入待上报目录时，在模型调用前拒绝，以免产生无法归属的费用。
- 旧记录不会自动补回；金额为估算时应与供应商账单对账。

## 验证

运行 `node --test tests/usage-reporting.test.mjs`（Node 22.13+）。
测试使用模拟供应商与主站，覆盖身份隔离、原始 Token、内容脱敏、失败、持久队列和同 ID 重试。

上线后用一个员工从主站进入工具，完成一次生成，再在主站管理员用量页面确认员工、来源、模型、Token 和计价依据；刷新/重试上报不能增加同一记录。合并部署前不应认为线上监控已经生效。
