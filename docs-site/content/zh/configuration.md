---
title: 配置
description: 运行模式、设置保存在哪里，以及会改变行为的环境变量。
---

使用应用的人在界面里设置模型和来源。环境变量面向操作者和本地开发。

## 模式

| 命令 | 工作区 | 凭据 | 写入 |
| --- | --- | --- | --- |
| `npm run demo` | 临时模拟 | 忽略已保存的模型和 Google 设置 | 只有模拟的本地发件箱 |
| `npm start` | 持久的本地工作区 | 应用内设置，或你导出的变量 | 在明确启用写入之前保持只读 |
| `node --env-file=.env server.js` | 持久工作区，或 `UNPROMPTED_STATE_FILE` | 你指定的 `.env` | 除非启用写入，否则只读 |

`npm start` 不读取 `.env`。只把需要的项从 `.env.example` 抄出来。该文件被 Git 忽略。

## 文件在哪里

设置是平台配置目录中的 `setup.json`。macOS 上是 `~/Library/Application Support/Unprompted`。Linux 使用 `${XDG_CONFIG_HOME:-~/.config}/unprompted`。Windows 使用 `%APPDATA%\Unprompted`。系统支持时，目录模式为 `0700`，文件模式为 `0600`。

开发时可以用 `UNPROMPTED_CONFIG_DIR` 和 `UNPROMPTED_SETUP_FILE` 改这些路径。MCP 凭据在设置文件旁的 `mcp.json`。以 `*-state.json` 结尾的正常状态路径实际存成 SQLite。进程运行时不要编辑数据库。

## 常用设置

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `4173` | 监听端口。主机始终是 `127.0.0.1` |
| `UNPROMPTED_SHADOW_MODE` | 由本机设置决定 | 显式设为 `true` 强制只读；写入仍需授权 |
| `UNPROMPTED_STATE_FILE` | 平台目录 | 工作区位置 |
| `UNPROMPTED_MODEL_BASE_URL` | 未设置 | 兼容 OpenAI 的接口 |
| `UNPROMPTED_MODEL_NAME` | 未设置 | 模型 ID |
| `UNPROMPTED_MODEL_API_KEY` | 未设置 | 可选密钥 |
| `UNPROMPTED_AGENT_HARNESS` | classic | 设为 `pi` 使用可选的 Pi 循环 |
| `GOOGLE_SEND_ENABLED` | `false` | 选择启用真实发送 |
| `GOOGLE_DOCS_WRITE_ENABLED` | `false` | 选择启用文档修改 |
| `GOOGLE_DRAFTS_ENABLED` | `false` | 选择启用 Gmail 草稿 |

包括 HTTP 限制在内的完整表格，见仓库中的[配置说明](https://github.com/PStarH/unprompted/blob/main/docs/CONFIGURATION.md)。

## 为发行版带上连接器

发行版为每个 OAuth 应用登记一次。使用应用的人再授权自己的账号，不用粘贴访问令牌。构建产物只携带客户端元数据。配置完成之后的用法，见[连接器](connectors.md)。

| 应用 | 构建里包含什么 | 用户怎么做 |
| --- | --- | --- |
| GitHub | 公开 Client ID，设备码流程，以及议题、拉取请求、内容、Actions 和 Metadata 的读取权限。不要申请 `repo` 范围 | **获取授权码** |
| Outlook | 公开 Client ID，浏览器 PKCE 授权；移动和桌面平台的重定向 URI 为 `http://localhost/oauth/microsoft`。委托权限为 `openid`、`profile`、`offline_access`、`User.Read` 和 `Mail.Read`。草稿以后再加 `Mail.ReadWrite` | **连接**，然后登录并同意 |
| Slack | Client ID 和 Client Secret，并启用 PKCE。回调为 `http://localhost:53682/oauth/slack`。用户范围是 `im:read`、`im:history`、`mpim:read`、`mpim:history` 和 `users:read`。不要加机器人或写入范围 | **连接** |
| Notion | Client ID 和 Client Secret。回调为 `http://localhost:53682/oauth/notion`。读取内容和用户信息；用户要创建页面时再开启 **Insert content** | **连接** |
| Google | 桌面客户端文件，其中不能有用户的刷新令牌 | **连接 Google** |

GitHub、Outlook、Slack 和 Notion 可以写在被 Git 忽略的 `connector-clients.json` 里，或写在 `UNPROMPTED_CONNECTOR_CLIENTS_FILE` 指向的文件里。环境变量是 `UNPROMPTED_GITHUB_CLIENT_ID`、`UNPROMPTED_MICROSOFT_CLIENT_ID`、`UNPROMPTED_SLACK_CLIENT_ID`、`UNPROMPTED_SLACK_CLIENT_SECRET`、`UNPROMPTED_NOTION_CLIENT_ID` 和 `UNPROMPTED_NOTION_CLIENT_SECRET`。浏览器登录这一对值必须同时存在才会使用。

Google 使用 `google-oauth-client.json`、`--google-client`，或 `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_ID` 与 `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_SECRET`。macOS 应用构建接受 `--connector-clients` 和 `--google-client`，保留这些元数据，并丢弃账号令牌。Google 应用处于测试状态时，刷新令牌大约七天有效，只有被列入的测试用户可以连接。

Slack 和 Notion 在用户的电脑上交换授权码，因此这些密钥会随构建一起分发，并不是放在保密服务器上的密钥。登记步骤见仓库中的[连接器说明](https://github.com/PStarH/unprompted/blob/main/docs/CONNECTORS.md)。

## 停止和重置

Ctrl+C 停止进程。移动状态文件之前先停掉它。一个状态文件同时只能由一个进程写入。演示可以再跑一次，得到新的模拟。工作区里已有真实事件时，重置演示的操作会被拒绝。
