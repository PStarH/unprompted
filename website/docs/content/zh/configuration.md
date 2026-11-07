---
title: 配置
description: 运行模式、存储路径、模型与 Pi 设置、Google 选项、连接器客户端和传输限制。
---

## 选择模式

| 命令 | 工作区 | 凭据 | 外部操作 |
| --- | --- | --- | --- |
| `npm run demo` | 全新的临时模拟 | 忽略 Google 与模型配置 | 仅模拟本地发件箱 |
| `npm start` | 持久本地工作区 | 界面保存的设置或继承的环境变量；不读取 `.env` | 除非单独授权，否则只读 |
| `node --env-file=.env server.js` | 持久或指定的状态文件 | 显式本地 `.env` | 除非明确启用，否则只读 |

正常模式只读取你连接的来源。界面授权立即生效，并开始第一次观察，无需重启。缺少上下文不会启动模拟。

## 加载本地 env 文件

```sh
cp .env.example .env
node --env-file=.env server.js
```

`--env-file` 需要 Node.js 20.6+。`npm start` 不会自动加载 `.env`。也可以在 shell 中导出变量后运行 `npm start`。

## 存储

| 设置 | 默认值 |
| --- | --- |
| `PORT` | `4173`，主机始终为 `127.0.0.1` |
| `UNPROMPTED_STATE_FILE` | 平台配置目录 |
| `UNPROMPTED_CONFIG_DIR` | 平台应用支持目录 |
| `UNPROMPTED_SETUP_FILE` | 配置目录中的 `setup.json` |

macOS 默认配置目录为 `~/Library/Application Support/Unprompted`，Linux 为 `${XDG_CONFIG_HOME:-~/.config}/unprompted`，Windows 为 `%APPDATA%\Unprompted`。POSIX 上目录为 `0700`，设置、模型和 MCP 文件在支持时为 `0600`。这些文件中的令牌和密钥在写入前加密。工作区状态**不加密**。

界面连接的账号会在该目录使用单独的哈希状态文件名。同一时间只能有一个进程写入一个状态文件。

## 常用设置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `UNPROMPTED_SHADOW_MODE` | `true` | 拒绝外部写入，包括模拟发送。只有字面值 `false` 才关闭。 |
| `UNPROMPTED_SYNC_INTERVAL_MS` | `0` | 旧版轮询兼容项。优先使用连接页的持久设置。 |
| `UNPROMPTED_SYNC_TIMEOUT_MS` | 未设置 | 单次连接器拉取的硬上限。 |
| `UNPROMPTED_STALL_AFTER_MS` | `86400000` | 无证据进展多久后，等待中的请求需要决定。 |
| `UNPROMPTED_ATTENTION_SWEEP_MS` | `60000` | 注意力扫描间隔，15 秒到 24 小时。 |
| `UNPROMPTED_DATE_LOCALE` | 未设置 | `MM/DD` 或 `DD/MM`。没有它时，含糊的数字日期保持未知。 |
| `UNPROMPTED_FORCE_SIMULATION` | `false` | 演示/测试提示。不会在实时运行时或包含真实事件的状态中启动模拟。 |

## 模型设置

| 变量 | 含义 |
| --- | --- |
| `UNPROMPTED_MODEL_ROLE` | `primary` 表示模型主解释；否则为旧版辅助模式。 |
| `UNPROMPTED_MODEL_BASE_URL` | 兼容 OpenAI 的 chat-completions 基础 URL。 |
| `UNPROMPTED_MODEL_NAME` | 服务商确切模型 ID。 |
| `UNPROMPTED_MODEL_API_KEY` | 兼容本地模型可省略。 |
| `UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` | 全局调用上限。 |
| `UNPROMPTED_AGENT_HARNESS` | `classic`（默认）或 `pi`。 |

适配器期望兼容 OpenAI 的 chat-completions 端点。界面流程和 classic/Pi 对比见[模型](models.md)。

### Pi harness

在 Node.js 22.19+ 上设置 `UNPROMPTED_AGENT_HARNESS=pi`，并运行 `npm ci --include=optional`。端点必须支持流式 chat completions 与 function tools。每次运行最多四次模型请求、八次工具尝试和 60 秒；每次服务商请求最多 2,048 个输出 token、20 秒，且不进行 SDK 重试。上下文最多 32,000 个序列化字符。超限或格式错误会明确失败，并保留确定性评估。

## Google 设置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 未设置 | 桌面 OAuth 客户端凭据。 |
| `GOOGLE_REFRESH_TOKEN` | 未设置 | 本地保存的刷新令牌。 |
| `GOOGLE_ACCOUNT_EMAIL` | 未设置 | 可选账号标签。 |
| `GOOGLE_READ_GMAIL` / `GOOGLE_READ_DRIVE` | `true` | 分别启用读取范围。 |
| `GOOGLE_GMAIL_QUERY` | 未设置 | 可选初始 Gmail 查询。 |
| `GOOGLE_SEND_ENABLED` | `false` | 明确启用实时发送；仍需范围、批准、关闭影子模式和回读。 |
| `GOOGLE_DRAFTS_ENABLED` | `false` | 草稿适配器；还需要 `gmail.compose` 和已确认的邮箱授权。 |
| `GOOGLE_DOCS_WRITE_ENABLED` | `false` | 单独的 Docs 写入提供方开关。Gmail 发送范围不会授予它。 |
| `GOOGLE_REQUEST_TIMEOUT_MS` | `20000` | 单请求超时。 |
| `GOOGLE_SYNC_BUDGET_MS` | `120000` | 单次连接器拉取总预算。 |
| `GOOGLE_MAX_RETRIES` | `2` | 仅对幂等 GET 的有界重试。 |
| `GOOGLE_RETRY_BASE_MS` | `500` | 重试退避基数。 |
| `GOOGLE_MAX_DOCUMENT_CHARS` | `1000000` | 文档导出的最大字符数。 |

完整设置见[Google Workspace](google.md)。

## 连接器客户端

| 服务商 | 变量 |
| --- | --- |
| GitHub | `UNPROMPTED_GITHUB_CLIENT_ID` |
| Microsoft | `UNPROMPTED_MICROSOFT_CLIENT_ID` |
| Slack | `UNPROMPTED_SLACK_CLIENT_ID`、`UNPROMPTED_SLACK_CLIENT_SECRET` |
| Notion | `UNPROMPTED_NOTION_CLIENT_ID`、`UNPROMPTED_NOTION_CLIENT_SECRET` |

也可以把 `UNPROMPTED_CONNECTOR_CLIENTS_FILE` 指向一个 JSON 文件，包含 `github.clientId`、`microsoft.clientId`，以及 Slack 或 Notion 的 client ID/secret 对。Google 可用 `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE` 或客户端 ID/secret 对提供。这些只提供客户端元数据；用户仍需授权自己的账号。见[连接器](connectors.md)。

## HTTP 传输限制

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `UNPROMPTED_HTTP_MAX_BODY_BYTES` | `1048576` | JSON 请求体上限。 |
| `UNPROMPTED_HTTP_BODY_TIMEOUT_MS` | `30000` | JSON 请求体接收总时限。 |
| `UNPROMPTED_HTTP_BODY_IDLE_TIMEOUT_MS` | `10000` | 请求体分块之间的最长等待。 |
| `UNPROMPTED_HTTP_REQUEST_TIMEOUT_MS` | `35000` | 完整请求接收超时。 |
| `UNPROMPTED_HTTP_MAX_SSE_CLIENTS` | `32` | 同时事件流数量。 |
| `UNPROMPTED_HTTP_SSE_MAX_FRAME_BYTES` | `8388608` | 单个完整状态帧的最大编码大小。 |
| `UNPROMPTED_HTTP_SSE_MAX_CLIENT_BUFFER_BYTES` | `10485760` | 每客户端缓冲预算。 |
| `UNPROMPTED_HTTP_SSE_MAX_TOTAL_BUFFER_BYTES` | `67108864` | 总缓冲预算。 |
| `UNPROMPTED_HTTP_SSE_HEARTBEAT_MS` | `20000` | 心跳间隔。 |

无效值使用默认值。慢客户端只保留一个最新待发快照；超出预算的客户端会被关闭并可重连。这些是传输限制，不是对进程总内存或数据库大小的承诺。

## 本地来源与维护

本地文件夹只限于选择的路径，不请求完全磁盘访问。Apple 备忘录通过宿主应用的自动化权限读取选中文件夹。撤销任一授权都会使证据不可用，但不会完成任务。

`UNPROMPTED_ATTENTION_SWEEP_MS` 控制注意力与到期的只读推理维护。每次自动恢复最多接纳两个任务，遵守持久退避与尝试次数，并共享正常服务商限制。它不会重发不确定的外部操作。

## 重置

按 **Ctrl+C** 停止应用。备份或移动状态文件前先停止正常模式工作区。不要删除活动锁。第二个实例使用另一个端口和状态文件。

本地 HTTP 接口见[本地 API](api.md)。存储与执行设计见[架构](architecture.md)。
