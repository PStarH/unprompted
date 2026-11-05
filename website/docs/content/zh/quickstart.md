---
title: 安装与首次运行
description: 环境要求、真实的 npm start 路径、模型连接与第一个来源。
---

## 环境要求

- **Node.js 20+** 与 npm。建议 **22+**；可选的 Pi harness 需要 **22.19+**。
- 用于克隆仓库的 Git。下载源码 ZIP 也可以。
- 一个浏览器。
- 模型端点、模型 ID 与 API 密钥。兼容的本地模型可以不要密钥。
- 只有使用云来源时才需要相应账号。本地文件夹不需要账号；Apple 备忘录需要 macOS。

安装前先检查 Node：

```sh
node --version
npm --version
```

## 安装并启动

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start
```

`npm ci --include=optional` 安装固定版本的 SQLite 运行时，以及可选的 Pi 与 MCP 包。没有前端构建步骤。

`npm start` 启动持久化的本地应用。出现 **Ready** 后会打印地址，例如：

```text
Ready → http://127.0.0.1:4173/
```

打开打印出来的确切地址。服务器只绑定本机，没有登录。如果 4173 端口被占用，启动器会选择另一个端口并打印出来。要指定端口：

```sh
npm start -- --port 4180
```

使用 `--no-open` 可以阻止启动器自动打开浏览器。按 `Ctrl+C` 停止。

> [!NOTE]
> `npm start` 不会自动读取 `.env`。需要本地 env 文件时，使用 `node --env-file=.env server.js`，或在运行 `npm start` 前在 shell 中导出变量。

## 连接模型

首次界面会要求：

| 字段 | 含义 |
| --- | --- |
| API 端点 | 兼容 OpenAI 的 chat-completions 基础 URL，例如 `https://api.openai.com/v1`。 |
| 模型 ID | 服务商使用的确切模型名称。 |
| API 密钥 | 兼容的本地模型可省略；多数托管服务需要。 |

选择 **验证并连接模型**。Unprompted 会用虚构内容发送一次真实的结构化请求。请求失败时保留原连接不变；成功后会私密保存连接、清空密钥输入框，并在不重启的情况下应用。

模型负责理解请求、准备工作。它不能批准操作、授予权限或宣布任务完成。classic 与 Pi harness 的差别见[模型](models.md)。

## 选择第一个来源

一个来源就足够开始。首页提供：

- **本地文件夹** — 选择 Markdown 或文本文件。macOS 使用文件夹选择器；其他平台输入绝对路径。不需要 OAuth 客户端或完全磁盘访问权限。
- **Apple 备忘录**（macOS）— 允许运行 Unprompted 的应用使用自动化权限，然后选择备忘录文件夹。
- **Google** — Gmail 与 Google 文档，先使用只读范围。
- **GitHub** — 分配给你的 issue、拉取请求、提交与 Actions 运行；只读。
- **Outlook** — 通过 Microsoft Graph 读取收件箱；除非单独授权草稿，否则只读。
- **Slack** — 已授权的私聊与群聊消息；只读。
- **Notion** — 授权时选择的页面；新建子页面需要单独的父页面授权。

授权后会立即开始第一次观察。页面显示实际读取数量和发现的工作。空结果也是有效结果：正常启动绝不会插入示例任务。

本地限制、登录细节与 MCP 见[连接器](connectors.md)。Google Cloud 设置见[Google Workspace](google.md)。

## 接下来会发生什么

打开[工作区](workspace.md)审阅任务。准备好的回复或文档会连同来源和已满足的要求一起显示。你可以批准、拒绝、调整方向、等待，或让 Agent 再检查一次。外部操作需要权限；未确认的结果绝不会显示为完成。

如果想先看一个可丢弃的演示：

```sh
npm run demo
```

演示是本地模拟，不读取已保存账号、不调用模型，也不联系外部服务。

## 启动失败时

| 现象 | 先检查 |
| --- | --- |
| 找不到 `node` 或 `npm` | 安装 Node.js，重开终端，运行 `node --version`。 |
| 找不到 `package.json` | 进入克隆或解压后的项目目录。 |
| 端口被占用 | 启动器会选择其他端口；显式指定 `--port` 时会给出重试提示。 |
| 页面没有内容 | 确认模型与至少一个来源已连接，然后在“连接”页选择 **立即检查**。零发现可能是有效结果。 |
| `.env` 不生效 | 用 `node --env-file=.env server.js` 显式加载。 |

更多内容见[故障排查](troubleshooting.md)。
