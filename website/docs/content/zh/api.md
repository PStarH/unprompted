---
title: 本地 API
description: 检查状态、连接模型、同步来源、批准工作，并调用本地 HTTP 接口。
---

## 边界

基础 URL：启动器打印的地址，通常是 `http://127.0.0.1:4173`。

- API **没有身份验证**，仅供本地使用。
- POST 请求体必须是 JSON，并带 `Content-Type: application/json`。
- 浏览器跨源写入会被拒绝。来源检查不是登录。
- 引擎仍会在每次操作时检查权限、当前证据和审阅版本。
- API 可能在 1.0 前变化。确切校验以 `server.js` 和 `test/api.test.js` 为准。

不要把端口暴露到网络，也不要把真实工作区的 `/api/state` 输出粘贴到 issue。

## 检查

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| GET | `/api/health` | 模式、影子策略、服务商与 schema 状态 |
| GET | `/api/runtime` | 连接器状态、缺失配置、模拟可用性 |
| GET | `/api/setup` | 脱敏的模型/来源状态、本地范围、OAuth 会话、观察设置 |
| GET | `/api/state` | 事件、任务、证据、文档、发件箱与历史 |
| GET | `/api/stream` | 服务端发送的完整状态快照 |
| GET | `/api/metrics` | 根据已记录结果计算的指标 |
| GET | `/api/trace?taskId=TASK_ID` | 单个任务的决策链，或最近条目 |
| GET | `/api/durable` | SQLite 配置与有界任务元数据 |
| GET | `/api/artifact-grants` | 已授权的创建目标 |

示例：

```sh
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/runtime
```

## 模型连接

`POST /api/setup/model` 接受：

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "model": "your-model-id",
  "apiKey": "your-key",
  "harness": "classic"
}
```

它会用虚构内容执行一次真实结构化请求。失败不会保存候选；成功会立即启用主解释，无需重启。省略密钥时，只有端点未变才保留已保存的密钥。

`POST /api/setup/model/forget` 删除本地连接。运行中的请求返回 `MODEL_BUSY`；环境管理的配置返回 `MODEL_ENV_CONFIGURED`，继续由环境控制。`GET /api/setup` 只暴露 `hasApiKey`，绝不返回密钥。

## 同步与搜索

```sh
curl -X POST http://127.0.0.1:4173/api/connectors/sync \
  -H "Content-Type: application/json" -d "{}"
```

自动轮询关闭时，用它执行一次实时拉取。检查连接器状态；失败不是模拟成功。

Google 搜索是显式且只读的：

```sh
curl -X POST http://127.0.0.1:4173/api/connectors/google/search \
  -H "Content-Type: application/json" \
  -d '{"source":"gmail","query":"subject:proposal","limit":20}'
```

`"source":"drive"` 搜索文档名称。`limit` 为 1–25；把返回的 `nextPageToken` 作为 `pageToken` 继续。Gmail 文本最多 16,000 字符。结果是不受信任内容，不会自动摄取，也不是不受限制的模型工具。

## 审阅与操作

使用 `/api/state` 中的真实任务 ID；在代码中对 ID 做 URL 编码。

```sh
curl -X POST http://127.0.0.1:4173/api/tasks/TASK_ID/approve \
  -H "Content-Type: application/json" \
  -d '{"reviewToken":"COPY_THE_CURRENT_TASK_REVIEW_TOKEN"}'
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/tasks/TASK_ID/approve` | 重新检查并执行准备好的操作（若允许） |
| POST | `/api/tasks/TASK_ID/reject` | 拒绝准备好的操作 |
| POST | `/api/tasks/TASK_ID/reconcile` | 检查不确定的外部结果 |
| POST | `/api/tasks/TASK_ID/retry` | 仅在确认不存在结果时重试 |
| POST | `/api/tasks/TASK_ID/cancel` | 关闭等待中的请求 |
| POST | `/api/tasks/TASK_ID/reopen` | 恢复已拒绝或关闭的请求并重新检查证据 |
| POST | `/api/tasks/TASK_ID/pause`、`/resume` | 保存或清除用户暂停 |
| POST | `/api/tasks/TASK_ID/direction` | 添加或替换任务方向，然后重新检查 |
| POST | `/api/tasks/TASK_ID/wait` | 保存文档、回复或时间等待 |
| POST | `/api/tasks/TASK_ID/feedback` | 记录标签和可选原因 |
| POST | `/api/tasks/TASK_ID/patch/prepare` | 准备带版本的文档补丁 |
| POST | `/api/tasks/TASK_ID/patch/apply` | 应用已审阅补丁，然后回读 |

如果来源、指导或目标变化，批准会在任何发送前返回 **409**，`code: "REVIEW_CHANGED"`。获取当前状态并重新审阅。审阅令牌不授予权限，也不替代证据或投递验证。

工作区转换期间的变更返回 **409 `WORKSPACE_CONNECTING`**。仅持久工作区可用的路由在临时演示中返回 **409 `DURABLE_WORKSPACE_REQUIRED`**。

## 常驻目标与交付物

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/standing-intents` | 已保存的常驻目标及版本 |
| POST | `/api/standing-intents` | 创建目标；需要 `confirmed:true` 和有界范围 |
| POST | `/api/standing-intents/:id` | 带 `expectedVersion` 更新；使准备好的工作失效 |
| POST | `/api/standing-intents/:id/pause`、`/resume`、`/disable` | 带 `expectedVersion` 的生命周期操作 |
| POST | `/api/tasks/:id/prepared-work/accept` | 接受本地准备好的草稿；不执行服务商写入 |
| POST | `/api/tasks/:id/prepared-work/retry` | 重试进行中的准备；暂停或过期返回 409 |
| POST | `/api/artifact-grants` | 用 `confirmed:true` 授权确切创建目标 |
| POST | `/api/tasks/:id/artifacts` | 在授权下排队创建交付物；返回 202，不是已验证 |

常驻目标支持观察和准备。即使存在无关的目标授权，也禁止外部写入。接受记录 `completion.external:false`，并让目标继续用于未来事件。

## 自动批准

```sh
curl -X POST http://127.0.0.1:4173/api/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode":"time","durationMinutes":30}'
```

任务租约使用 `{"mode":"task","taskId":"TASK_ID"}`。响应包含 `{grant,state}`。撤销使用 `POST /api/autonomy/:id/revoke`。时间和任务租约可以共存。无效范围或时长返回 400。YOLO 仍不能绕过影子模式、过期证据、暂停或目标授权。

## MCP

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/mcp` | 脱敏的服务器状态、工具和读取授权 |
| POST | `/api/mcp/import` | 保存并连接 `mcpServers` 对象 |
| POST | `/api/mcp/servers/:id` | 更新启用状态、读取工具、重连或移除 |

密钥永远不会被回显。临时演示拒绝这些路由。失败的连接会带着脱敏错误保存，便于修正。

## 隐私

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/privacy/preview` | 删除前查看依赖数量 |
| POST | `/api/privacy/forget` | 删除受支持的本地根及其派生工作 |
| GET | `/api/privacy/requests/:id` | 删除、WAL、备份和外部保留状态 |
| POST | `/api/privacy/requests/:id/retry` | 重新检查剩余保留，不重新导入内容 |

支持的根包括 event、situation、task、memory、task_memory、task_direction、experience、artifact、policy、feedback 和 outcome。Forget 不会擦除独立服务商副本。

## 流与错误

`/api/stream` 发送完整快照。背压时，中间待发快照可能被最新状态替换；消费者应使用当前快照与历史。连接或大小限制可能返回 503；重连是安全的，不会重新执行工作。

常见状态：

| 状态 | 含义 |
| --- | --- |
| 400 | 无效 JSON、目标或请求体结构 |
| 202 | 已排队的任务，不是已完成的外部写入 |
| 409 | 冲突，例如 `REVIEW_CHANGED`、`WORKSPACE_CONNECTING`、`STATE_LOCKED` 或 `DURABLE_WORKSPACE_REQUIRED` |
| 413 | 请求体超过传输限制 |
| 408 | 请求体接收超时 |
| 503 | 流或服务达到限制；重连可能安全 |

完整路由见 [`docs/API.md`](https://github.com/PStarH/unprompted/blob/main/docs/API.md) 与 `server.js`。执行设计见[架构](architecture.md)。
