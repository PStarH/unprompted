---
title: 连接器
description: 本地文件夹、Apple 备忘录、Google、GitHub、Outlook、Slack、Notion 与外部 MCP 工具。
---

## 先连接一个来源

来源提供工作与上下文。先连接模型，再在首页选择一个来源。授权后无需重启即可生效。你可以连接多个来源、暂停观察、重试失败的读取，并在保留其他账号的情况下断开某一个账号。

| 来源 | 登录方式 | 观察内容 | 外部操作 |
| --- | --- | --- | --- |
| 本地文件夹 | macOS 文件夹选择器；其他平台绝对路径 | 选中文件夹中的 Markdown 与 UTF-8 文本，包括显式文本待办 | 只读 |
| Apple 备忘录 | macOS 自动化权限，然后选择文件夹 | 选中文件夹中的纯文本；锁定备忘录与附件不读取 | 在明确授权的文件夹中新建备忘录；真实账号验收待完成 |
| Google Workspace | 带 PKCE 的桌面 OAuth | Gmail、Google 文档与 Drive 变化 | 单独授权后创建草稿；Gmail 发送与文档编辑各有独立授权 |
| GitHub | 官方设备 OAuth | 分配给你的 issue、审阅请求、近期提交与 Actions 运行 | 只读 |
| Microsoft Outlook | 官方设备 OAuth | 收件箱邮件，初始为最近三天，之后使用 Graph 增量更新 | 单独授权后创建未发送草稿 |
| Notion | 公共集成浏览器 OAuth | 授权时选择的页面 | 在明确授权的父页面下创建子页面 |
| Slack | 带 PKCE 的用户浏览器 OAuth | 已授权的私聊与群聊消息 | 只读 |

来源从只读开始。连接账号绝不会授予写入权限。草稿、新 Notion 页面或新 Apple 备忘录都需要单独的目标授权。见[权限与隐私](permissions.md)。

## 本地文件夹

选择 **本地文件夹**，然后选择目录。macOS 会打开原生选择器；其他系统需要输入绝对路径。Unprompted 只读取选中文件夹，跳过隐藏文件和符号链接，不请求完全磁盘访问权限。

支持 `.md`、`.markdown` 和 `.txt`。一次扫描最多 500 个文件、单文件 512 KiB、变更文本共 4 MiB。每个受支持文档只跟踪前 100 个显式文本待办。识别 `- [ ]`、`TODO:` 和 `☐`；普通正文只作为上下文。

本地文档链接只在这台电脑上有效，不要把它当作可分享链接。移除文件夹会使当前证据失效并停止来源任务；历史记录仍保留在私有工作区。

## Apple 备忘录

Apple 备忘录仅支持 macOS。应用会识别当前系统，其他系统不推荐备忘录。已经连接的备忘录仍会显示，方便断开。运行 `npm start` 的宿主应用（例如 Terminal）会请求自动化权限。选择要观察的备忘录文件夹。锁定备忘录和附件不会读取。除非单独授权某个文件夹用于创建备忘录，否则连接器只读。

备忘录桥接使用 Apple 公开的脚本接口，而不是私有 Notes 数据库。自动化测试使用注入响应；真实备忘录账号和签名应用的权限提示仍需人工验收。备忘录原生复选框不是完成信号。

## Google Workspace

Google 使用桌面 OAuth 客户端与 PKCE。发行版可以提供已注册客户端；没有客户端的自托管版本会引导你完成一次性的 Google Cloud 设置。第一批范围对 Gmail 与 Google Drive/文档只读。

授权后连接立即生效，首次读取最近的邮件和现有文档，页面显示实际数量。Gmail 草稿、发送和文档编辑需要单独授权。Gmail 发送还需要读取权限，以便回读已发送邮件进行验证。

完整设置、环境变量和恢复路径见[Google Workspace](google.md)。

## GitHub

GitHub 使用官方设备流程。选择 **连接**，复制短代码，并在 GitHub 页面确认。连接器读取分配给你的 issue、等待你审阅或回复的拉取请求、最近三天的提交，以及该时间窗口内的 Actions 运行。它只读：不会评论、审阅、编辑、合并或重跑工作流。

GitHub 需要注册 GitHub App，启用设备流程，并具有 Issues、Pull requests、Contents、Actions 与 Metadata 的读取权限。经典 OAuth 应用只要账号范围覆盖同样的读取也可以工作。不会保存文件补丁和文件正文。

## Microsoft Outlook

Outlook 使用官方设备流程与委托权限 `User.Read`、`Mail.Read` 和 `offline_access`。组织可能要求管理员批准。连接器读取收件箱邮件，初始为最近三天，之后跟随 Graph 增量更新。

如果增量检查点过期，Unprompted 会重新枚举收件箱，不再受初始三天限制，并对已知消息 ID 去重。该恢复路径有测试夹具覆盖，但尚未在真实 Microsoft 账号上验证。Outlook 草稿需要委托权限 `Mail.ReadWrite` 与单独的目标授权；不会请求 `Mail.Send`。

## Slack 与 Notion

Slack 和 Notion 使用浏览器授权码与固定回环重定向：

```text
http://localhost:53682/oauth/slack
http://localhost:53682/oauth/notion
```

Slack 需要 PKCE，只请求私聊和群聊消息的用户令牌范围。它读取最近三天的消息，跳过你自己的消息，并且只读。其他工作区需要公开分发和单独的目录审核。

Notion 使用公共集成。用户在授权时选择 Unprompted 可以读取的页面。创建子页面需要 **Read content** 与 **Insert content**、对所选父页面的访问权，以及单独授权。更改能力后，已有的只读安装需要重新授权。不支持数据库条目。

## 观察与游标

来源变化通过轮询观察。`/api/stream` 在观察被处理时发布工作区快照；它不是服务商 webhook，也不是可重放的逐事件流。未启用服务商推送。

一次观察每个连接器最多处理五页。开启自动观察时，剩余页面可以安排最多四次短续传，然后恢复正常间隔。一次性检查最多处理五页，把剩余游标留给下一次。

空读取是有效结果。来源关闭只会停止跟踪，不会创建已验证的完成。暂停观察会保留连接和本地历史。

## 外部 MCP 工具

MCP 是客户端集成：外部服务向 Agent 提供工具。它不是 Unprompted 服务器，也不会通过轮询任意工具来发现新任务。

安装可选客户端后重启：

```sh
npm ci --include=optional
```

在 **连接 → MCP** 中，**Fetch** 不需要账号，并且默认启用。**Notion**、**Linear**、**Jira 与 Confluence** 和 **Todoist** 使用**登录并连接**，在服务商页面登录，不需要 Client Secret 或 API Token。**Brave Search** 和 **Firecrawl** 仍然需要 API Key。也可以选择 **添加服务器**，输入 Streamable HTTP URL、stdio 命令或粘贴 `mcpServers` 对象。远程服务器使用 HTTPS；localhost 允许 HTTP。登录后可以使用服务声明为只读的工具。其余工具在允许之前保持关闭。可写或破坏性工具保持阻断。MCP prompts 尚未实现，这些服务也不会发现新任务。导入的配置不能包含 OAuth 令牌。以前用 API Token 添加的 Linear 或 Jira 会留到你删除为止。登录会替换已保存的 Linear 配置。

```json
{
  "mcpServers": {
    "work-context": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

如果模型支持 function calling，Standard 与 Pi 都可以使用已授权工具。服务器声明的读取注解只是声明，不是安全沙箱。请逐个审阅工具；没有注解的工具需要显式读取授权。声明为可写或破坏性的工具保持阻断。禁用或移除服务器会撤销已捕获的适配器，并关闭其进程或传输。

支持仅有资源的服务器。在 **资源与访问** 中逐个选择 Agent 可以读取的资源；默认不启用任何资源。只使用文本。暂不支持资源模板、订阅和自动变化观察。

凭据和登录令牌保存在本地设置旁的私有 `mcp.json`，支持时使用 `0600` 权限。API 不会返回命令、参数、环境值、请求头或令牌。文件未加密。调用记录有上限，并保留在任务工作区。

## 为发行版提供客户端

应用注册由发布者一次性完成，用户仍需授权自己的账号。通过启动环境或 gitignore 的 `connector-clients.json` 提供客户端元数据：

```json
{
  "github": { "clientId": "YOUR_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_MICROSOFT_APPLICATION_ID" },
  "slack": { "clientId": "YOUR_SLACK_CLIENT_ID", "clientSecret": "YOUR_SLACK_CLIENT_SECRET" },
  "notion": { "clientId": "YOUR_NOTION_CLIENT_ID", "clientSecret": "YOUR_NOTION_CLIENT_SECRET" }
}
```

环境变量名为 `UNPROMPTED_GITHUB_CLIENT_ID`、`UNPROMPTED_MICROSOFT_CLIENT_ID`、`UNPROMPTED_SLACK_CLIENT_ID`、`UNPROMPTED_SLACK_CLIENT_SECRET`、`UNPROMPTED_NOTION_CLIENT_ID` 和 `UNPROMPTED_NOTION_CLIENT_SECRET`。只有两个值都存在时才使用授权码流程。Google 使用另一套桌面客户端，见[Google Workspace](google.md)。

当前 Slack 与 Notion 的交换在本地完成，因此提供的客户端密钥会到达本地安装，不是服务端机密。如果发行版需要机密客户端，请使用托管的 OAuth 交换。

## 限制与验收

仓库不附带公共客户端 ID。云来源需要已注册应用或包含客户端的发行版。自动化覆盖使用脚本化服务商；真实账号授权、服务商发布审核和 macOS 自动化仍需人工验收。Google、Outlook、Slack 与 Notion 不作为已完成生产验证的集成来呈现。

开发者视角见[架构](architecture.md)与[开发与测试](development.md)。本地 HTTP 接口见[本地 API](api.md)。
