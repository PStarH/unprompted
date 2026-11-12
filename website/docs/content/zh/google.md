---
title: Google Workspace
description: 以只读方式连接 Gmail 与 Google Drive，单独启用草稿或发送，并处理授权问题。
---

## 先只读

Google 是可选来源。首次连接只请求 Gmail 与 Google Drive 的读取权限。草稿、Gmail 发送和文档编辑是之后单独添加的权限。连接 Google 绝不会启用写入。

发行版可以包含已注册的桌面 OAuth 客户端，此时 **连接 Google** 会直接打开授权。没有客户端的自托管版本会显示一次性的 Google Cloud 指南，并接受下载的桌面客户端 JSON。

## 自托管设置

### 1. 准备 Google Cloud 项目

1. 创建或选择 Google Cloud 项目。
2. 启用 **Gmail API** 与 **Google Drive API**。
3. 配置 OAuth 同意屏幕。外部应用处于测试状态时，把你的测试账号加入测试用户。
4. 创建应用类型为 **桌面应用** 的 OAuth 客户端，下载 JSON 文件。把它放在仓库之外。

首次运行使用专用测试账号和虚构内容。Gmail 与 Drive 读取范围属于受限范围；公开分发通常需要 Google 审核，除非适用例外。停留在测试状态的应用，其刷新令牌可能在七天后过期。

### 2. 在应用中授权

打开 **连接 → Google**，选择 **连接 Google**，按授权页面操作。弹窗被拦截时，使用可见链接或打印出的备用 URL。授权立即生效，不需要复制令牌或重启。

环境管理安装也可以使用辅助脚本：

```sh
node scripts/google-refresh-token.mjs /path/to/client_secret.json --write-env
```

辅助脚本使用 localhost 回调并请求：

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
```

使用桌面客户端，不要使用 Web 应用客户端。`--write-env` 会把返回的凭据写入 `.env`，不打印其值，并保留其他条目。首次只读设置不要加 `--send`。

### 3. 配置只读运行

```dotenv
GOOGLE_READ_GMAIL=true
GOOGLE_READ_DRIVE=true
GOOGLE_SEND_ENABLED=false
UNPROMPTED_SHADOW_MODE=true
UNPROMPTED_SYNC_INTERVAL_MS=60000
UNPROMPTED_STATE_FILE=./data/google-readonly.json
```

显式加载并启动：

```sh
node --env-file=.env server.js
```

检查 `http://127.0.0.1:4173/api/health` 和 `/api/runtime`。只读实时工作区会报告 `mode: "live"`、`shadow: true` 和 `google.sendEnabled: false`。只读模式仍会把观察到的上下文写入本地状态；不会修改 Google 内容。

## 读取什么

连接器读取授权账号可见的近期 Gmail 和现有 Google 文档，然后跟随增量变化。`UNPROMPTED_SYNC_INTERVAL_MS` 为正数时会自动轮询；为 `0` 时通过 API 或 **立即检查** 请求同步。

Google 文档的读取通过 Drive 完成。仅有文档时间戳不能证明文档中的实验结果是最新的；没有依据的新鲜度声明会被保留。

## 单独的写入权限

这些不属于只读授权：

| 操作 | 额外要求 |
| --- | --- |
| 创建 Gmail 草稿 | `GOOGLE_DRAFTS_ENABLED`、`gmail.compose` 范围、已确认的邮箱目标授权，以及策略允许写入 |
| 发送 Gmail | `gmail.send`、`GOOGLE_SEND_ENABLED=true`、关闭影子模式、批准或常驻授权，以及回读验证 |
| 编辑 Google 文档 | 启用 Docs API、已授予的写入范围、Docs 写入提供方开关，以及明确的操作授权 |

发送还需要读取权限，以便回读已接受的消息。`accepted_live` 或不确定的结果会保持阻断，直到完成对账。不要盲目重试。

## 发行版设置

一次性提供已注册的桌面客户端：

```sh
UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE=/path/to/desktop-client.json npm start
```

macOS 应用包：

```sh
node scripts/build-macos-app.mjs --out outputs/Unprompted-Connected.app --google-client /path/to/desktop-client.json
```

用户之后用自己的账号授权，无需创建 Cloud 项目。这只提供客户端元数据，不会替你完成 Google 注册或验证。

## 断开与撤销

**断开 Google** 会立即停止此进程的读取和外部操作。本地工作记录保留，客户端配置会保留以便重新连接。对于环境管理的账号，如果重启后也应保持断开，还要移除启动凭据。

要撤销服务商授权，请在 Google 账号的已连接应用设置中移除该应用。删除不再需要的本地凭据和状态，包括备份与日志。不要把它们作为反馈提交。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 一直等待工作区 | 完成授权。环境设置要显式加载 `.env` 并提供全部凭据。 |
| 授权被拒绝 | 已启用的 API、同意屏幕测试用户和桌面客户端类型。 |
| 刷新失败 | 令牌可能过期或被撤销。重新授权；测试模式令牌可能七天后过期。 |
| 没有新事件 | 轮询间隔、Gmail 查询、文档访问和连接器状态。增量同步只覆盖当前窗口。 |
| 发送被拒绝 | 阅读和草稿仍可用。检查上面的全部发送要求。 |
| 状态被锁定 | 停止另一个进程，或换一个状态文件。不要删除活动锁。 |

共享隐私边界见[权限与隐私](permissions.md)。HTTP 接口见[本地 API](api.md)。
