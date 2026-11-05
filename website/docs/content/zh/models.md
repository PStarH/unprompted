---
title: 模型
description: 连接兼容 OpenAI 的模型，选择 classic 或 Pi harness，并了解边界。
---

## 模型做什么

Unprompted 使用已配置的模型理解请求、关联已授权的上下文并准备工作。模型是解释者和规划者，不是权威：

- 它不能批准操作、授予权限或宣布完成。
- 主解释模式启用时，即使请求可被规则识别，仍会调用模型。
- 失败或缺乏依据的模型解读不能变成可用的回复。
- 连接模型不会获得任何外部写入权限。

classic 适配器通常只发起一次服务商调用；启用 MCP 工具时除外。可选的 Pi harness 增加一个有边界的只读工具循环。

## 在界面中连接

运行 `npm start` 并打开打印的地址。输入端点、模型 ID 和可选密钥，然后选择 **验证并连接模型**。

| 设置 | 说明 |
| --- | --- |
| API 端点 | 兼容 OpenAI 的 chat-completions 基础 URL。 |
| 模型 ID | 服务商的确切模型名称。 |
| API 密钥 | 提供时保存在私有本地设置文件中；API 和 SSE 永远不会返回。 |
| Harness | 默认 `classic`；安装可选包后可设为 `pi`。 |

验证会用虚构内容执行一次真实结构化请求。只有成功的请求会被保存；失败时保留原连接。可用连接会立即生效，无需重启。

## 用环境变量管理

由 shell 或部署管理的模型：

```sh
UNPROMPTED_MODEL_ROLE=primary
UNPROMPTED_MODEL_BASE_URL=https://api.openai.com/v1
UNPROMPTED_MODEL_NAME=your-model-id
UNPROMPTED_MODEL_API_KEY=your-key
```

`UNPROMPTED_MODEL_ROLE=primary` 让模型解释成为主路径。不需要密钥的兼容本地模型可以省略密钥。`UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` 限制调用次数。

`npm start` 不会自动读取 `.env`。可以导出变量，或运行：

```sh
node --env-file=.env server.js
```

## classic 还是 Pi

| | classic | Pi |
| --- | --- | --- |
| 默认 | 是 | 否 |
| 服务商调用 | 一次；启用 MCP 工具时除外 | 有边界的只读任务工具循环 |
| 安装 | 已包含 | `npm ci --include=optional`，Node.js 22.19+ |
| 模型要求 | chat completions | 流式 chat completions 与 function tools |
| 适合 | 最低配置、可预测的单轮解释 | 在明确预算内查看关联文档 |

启用 Pi：

```sh
UNPROMPTED_AGENT_HARNESS=pi
```

Pi 最多搜索并读取八份与当前任务关联的文档。每次读取都会重新检查可用性与任务范围；每个片段最多 4,000 个字符。文档摘录可能发送给已配置的模型。

每次运行最多四次实际模型请求、八次工具尝试和 60 秒。每次服务商请求最多 2,048 个输出 token、20 秒，且不进行 SDK 重试。上下文最多 32,000 个序列化字符。超限或格式错误会明确失败，并保留确定性评估结果。

Pi 内置工具不包含发送、shell、文件系统或权限操作。单独授权的 MCP 工具遵循其服务器范围。见[连接器](connectors.md)中的 MCP 部分。

## 失败行为

没有可用模型时，正常产品模式会阻止操作进入可执行状态。推理失败不会静默退回为仅靠规则的可用回复。模型请求正忙时，设置返回 `MODEL_BUSY`；环境管理的配置返回 `MODEL_ENV_CONFIGURED`，并继续由该环境控制。

## 数据边界

提示词和选中的来源上下文会发送到你配置的端点，适用该服务商的保留与训练政策。本地状态可能保存模型输出和证据摘录。请把工作区当作个人数据。连接敏感来源前阅读[权限与隐私](permissions.md)。

完整环境变量表见[配置](configuration.md)，HTTP 边界见[本地 API](api.md)。
