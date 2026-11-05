# 连接器完整配置教程：发行方配置一次，用户直接登录

[← 文档目录](README.md) · [连接器能力与边界](CONNECTORS.zh-CN.md)

适用于当前 Unprompted 桌面版和源码运行版。目标是让普通用户不必注册开发者应用：发行方预置应用身份，用户只授权自己的账号。下列步骤包含读取和行动权限。

“任何人可安装”仍受服务商账号类型、地区、组织管理员和应用审核约束；注册成功、本机连通、获准公开分发是三件不同的事。

## 1. 先选最快的接法

| 来源 | 发行方一次性配置 | 普通用户操作 | 会自动观察来源变化吗 |
| --- | --- | --- | --- |
| 本地文件夹 | 无 | 选择文件夹；非 macOS 可输入路径 | 会，限支持的文本文件 |
| Apple 备忘录 / 提醒事项 | 无；发行包需验证 macOS 自动化授权 | 在 Mac 授权，选择文件夹 / 列表 | 会 |
| Fetch | 无，内置 Node 运行时 | 默认开启 | 不会；由任务调用读取网页 |
| Notion / Linear / Jira、Confluence / Todoist MCP | 使用内置服务预设，无需注册这四家的开发者应用 | 连接 → MCP → 登录并连接；按需选择写工具 | 不会；由任务调用工具 |
| Google 原生 | Google Cloud 项目、Desktop OAuth 客户端、适用验证 | 登录 Google，选择来源和行动权限 | 会 |
| GitHub 原生 | 公共 GitHub App、device flow、仓库权限 | 安装到仓库，再完成设备码授权 | 会 |
| Outlook 原生 | 多租户及个人账号 Entra 应用、浏览器 PKCE | 登录并同意授权 | 会，当前自动观察收件箱 |
| Slack 原生 | Slack PKCE 用户应用及分发配置 | 选择工作区并授权 | 会，限已支持会话及窗口 |
| Notion 原生 | Public connection、能力和页面授权、OAuth 应用身份 | 授权时选择页面 | 会；公开发行另见第 7 节 |
| Todoist 原生 | 无需开发者应用 | 粘贴自己的个人 API token | 会 |
| Brave Search / Firecrawl | 无需在本产品注册 OAuth 应用 | 分别填写自己的 API Key | 不会；由任务调用 |

最快获得工具能力：先连接模型与一个工作来源，再连接托管 MCP。需要自动从 Notion / Todoist 变化发现工作时，再补原生连接；MCP 登录不会自动连接同名原生来源。

Notion 官方也提供托管 MCP：[连接说明](https://developers.notion.com/guides/mcp/get-started-with-mcp)。Todoist 的[开发者首页](https://developer.todoist.com/)同时列出 OAuth MCP 和个人 token 两种入口。

## 2. 发行方先准备什么

准备可公开访问的产品首页、隐私政策、服务条款、支持邮箱、应用图标，以及可用于验收的个人账号和组织账号。各平台若要求域名验证、企业信息或审核材料，使用真实发行主体填写。

需要收集的应用身份：

| 平台 | 保存什么 | 当前授权方式 / 回调 |
| --- | --- | --- |
| Google | 下载的 **Desktop app** 客户端 JSON | PKCE，本机随机端口 loopback；不手填固定 53682 |
| GitHub | **Client ID** | device flow，无需本产品 Web 回调 |
| Microsoft | **Application (client) ID** | 移动和桌面平台回调 `http://localhost/oauth/microsoft`，无需客户端密钥 |
| Slack | **Client ID** | PKCE；`http://localhost:53682/oauth/slack` |
| Notion 原生 | **OAuth client ID + OAuth client secret** | `http://localhost:53682/oauth/notion` |

这些文件只放注册应用身份；不要放你自己的用户 access token、refresh token、Todoist token 或搜索服务 Key。用户令牌在每台设备完成登录后分别产生。

## 3. Google：Gmail、Drive、Docs、Sheets、Slides、Calendar

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建或选择发行项目。
2. 在 **APIs & Services → Library** 启用 Gmail API、Google Drive API、Google Docs API；提供表格、演示文稿和日历操作时，也启用 Google Sheets API、Google Slides API、Google Calendar API。
3. 进入 **Google Auth Platform**，填写 Branding、支持邮箱、产品域名和隐私政策。Audience 面向外部账号时选 External；开发时添加 Test users。
4. 在 Data Access 声明产品需要的 scopes。读取和行动权限见下表。
5. 在 Clients 创建 OAuth client，Application type 选 **Desktop app**。下载 JSON，保存为仓库根目录 `google-oauth-client.json`。文件顶层应为 `installed`，不要下载 Web client 类型。
6. 启动应用，Google 卡片应直接提供登录，无需普通用户创建 Cloud 项目。用户选择来源；需要额外动作时填写「附加 OAuth 权限」并重新完成同意。
7. 面向不认识的普通用户发行前，完成适用的品牌、敏感 / 受限 scope 验证及审核要求。

| 能力 | scope |
| --- | --- |
| 自动读取 Gmail | `https://www.googleapis.com/auth/gmail.readonly` |
| 自动观察 Drive 文档 | `https://www.googleapis.com/auth/drive.readonly` |
| 自动读取主日历 | `https://www.googleapis.com/auth/calendar.events.readonly` |
| 管理草稿 | `https://www.googleapis.com/auth/gmail.compose` |
| 发送邮件 | `https://www.googleapis.com/auth/gmail.send` |
| 修改 Google Docs | `https://www.googleapis.com/auth/documents` |
| 修改 Sheets / Slides | `https://www.googleapis.com/auth/spreadsheets` / `https://www.googleapis.com/auth/presentations` |
| 创建、修改、删除日历事件 | `https://www.googleapis.com/auth/calendar.events` |
| 归档、标为已读、移动到垃圾箱等邮件管理 | `https://www.googleapis.com/auth/gmail.modify` |
| Drive 文件管理，包括已有文件的移动、改名等 | 按所需接口选择 `drive.file` 或 `drive`；`drive.file` 不等于可以访问所有已有文件 |

需要邮件草稿、发送和三种办公文档及日历行动时，把以下**单行**内容粘贴到「附加 OAuth 权限」（用空格分隔，保留所需读取来源）：

```text
https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/calendar.events
```

归档邮件或管理 Drive 文件时再增加对应 scope；通用 API 能使用 token 实际获得的权限。Google 原有专用发送 / Docs 修改流程，还需在其行动设置中勾选对应权限并允许执行；仅填写附加 scope 不会自动打开这些专用开关。

`gmail.compose` 本身也允许发送；`gmail.modify` 不包括绕过垃圾箱的永久删除。具体授权能力以 [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) 和 [Google scope 总表](https://developers.google.com/identity/protocols/oauth2/scopes)为准。

External + Testing 不适合公开发行：有测试用户限制，所用非身份 scopes 的 refresh token 通常在 7 天后过期。切到 Production 也不等于已完成验证。读取 Gmail 涉及受限 scope；内容若经模型服务等第三方服务器处理，必须据实际数据流评估审核与安全评估要求，不能仅凭桌面运行认定豁免。见 [token 过期规则](https://developers.google.com/identity/protocols/oauth2/#expiration)和[受限 scope 验证](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)。

## 4. GitHub：让用户安装一次，再设备码登录

1. 打开 [GitHub Apps](https://github.com/settings/apps) → **New GitHub App**。填写名称、Homepage URL。
2. 开启 **Enable Device Flow**。当前连接器轮询 API，不依赖 webhook，可关闭 Active webhook；device flow 不使用 Web callback。
3. 配置 Repository permissions：

| 权限 | 只观察时 | 需要处理工作时 |
| --- | --- | --- |
| Metadata | Read-only | Read-only |
| Issues | Read-only | Read & write：评论和 issue 管理 |
| Pull requests | Read-only | Read & write：评论、评审及受规则允许的 PR 操作 |
| Contents | Read-only | Read & write：文件修改和提交 |
| Actions | Read-only | Read & write：受平台允许的工作流运行管理 |
| Workflows | 不额外申请 | 要编辑工作流文件时增加 Write |

4. **Where can this GitHub App be installed?** 选择 **Any account**，使其他账号可安装。
5. 保存后复制 **Client ID**，不要复制 App ID 或生成私钥来代替。
6. 记下该 App 的公开安装链接，通常形如 `https://github.com/apps/你的-app-slug/installations/new`，提供给用户。
7. 用户先安装到其个人 / 组织账号并选择仓库，再在 Unprompted 点击 GitHub 连接，输入设备码并授权。

无需把发行方 PAT、私钥或账号交给用户。用户 token 的可用权限还受 App 安装权限和用户自身权限共同限制；增权后旧安装可能需要重新批准。组织仓库若需管理员批准，要由该组织完成。参见 [App 注册](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)、[公共安装](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)和[设备授权](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。

## 5. Microsoft：Outlook 及其他 Graph 动作

1. 打开 [Microsoft Entra](https://entra.microsoft.com/) → **App registrations → New registration**。
2. Supported account types 选择 **Accounts in any organizational directory and personal Microsoft accounts**，同时支持组织账号和 Outlook.com 等个人账号。
3. 注册后复制 **Application (client) ID**。
4. 进入 **Authentication → Add a platform → Mobile and desktop applications**，添加重定向 URI `http://localhost/oauth/microsoft` 并保存。浏览器授权使用 PKCE，不需要 Client Secret。
5. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**，配置实际提供的权限：

```text
User.Read
Mail.Read
Mail.ReadWrite
Mail.Send
offline_access
```

6. 需要日历或文件操作时，再配置 delegated `Calendars.ReadWrite`、`Files.ReadWrite` 等接口所需权限。不要把 Application permissions 当成当前用户登录流程的替代。
7. 用户在 Unprompted Outlook 连接表单的「附加 OAuth 权限」填写：

```text
Mail.ReadWrite Mail.Send
```

8. 点击连接，在 Microsoft 官方页面登录并同意。若还需要日历 / 文件，则在同一个输入框追加对应 scopes 后重新授权。

后台勾选 API permissions 只是声明；实际授权请求也必须包含所需 scopes。`Mail.ReadWrite` 不替代发送授权；发送使用 `Mail.Send`。当前原生自动观察仍是收件箱，增加 Calendar / Files scope 不会自动增加对应轮询器。

账号类型和 public client flow 见 [应用注册](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)及[桌面应用配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)。企业的用户同意策略、发布者验证和管理员审批可能阻止普通用户自行同意，见 [Graph 权限概览](https://learn.microsoft.com/en-us/graph/permissions-overview)。

## 6. Slack：用户 PKCE，不要求用户注册 App

1. 打开 [Slack Apps](https://api.slack.com/apps) → **Create New App**，选择开发工作区。
2. 在 **OAuth & Permissions** 开启 PKCE；这是将应用配置为 public client 的单向设置。
3. 添加准确的 Redirect URL：

```text
http://localhost:53682/oauth/slack
```

4. 配置 **User Token Scopes**。私信读取需要：

```text
im:read
im:history
mpim:read
mpim:history
users:read
```

5. 提供频道与线程观察时再配置：

```text
channels:read
channels:history
groups:read
groups:history
```

6. 提供消息行动时增加 user `chat:write`。其他能力按接口增加 user scopes，例如 reactions 或文件相关权限；确认该 scope 支持 User token。
7. 从 **Basic Information → App Credentials** 复制 **Client ID**。当前 PKCE 流程不需要 Client Secret，也不要把 Bot token 当成用户授权。
8. 用户在 Unprompted Slack 表单按需勾选频道访问，并在「附加 OAuth 权限」填写 `chat:write`，然后连接并选择工作区。
9. 给其他工作区使用前，在发行后台完成分发设置；商业分发按 Slack Marketplace 要求申请。组织可能另需管理员允许安装。

若通过 manifest 配置，以下是私信、频道及发送能力的 OAuth 部分，可合入应用 manifest：

```yaml
oauth_config:
  redirect_urls:
    - http://localhost:53682/oauth/slack
  pkce_enabled: true
  scopes:
    user:
      - im:read
      - im:history
      - mpim:read
      - mpim:history
      - users:read
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - chat:write
```

桌面 PKCE 回调不能申请 Bot scopes；不要在此配置增加 `scopes.bot`。`chat:write` 支持 User token，实际发送 / 编辑 / 删除能力仍受消息归属和会话访问限制。依据：[Slack PKCE](https://docs.slack.dev/authentication/using-pkce/)、[chat:write](https://docs.slack.dev/reference/scopes/chat.write)、[分发说明](https://docs.slack.dev/app-management/distribution/)。

本地回调可用于当前客户端，但它获准登录不等于已获跨工作区公开分发资格。若发布后台要求另一种生产回调，需先与 Slack 确认并实现对应客户端流程；只在后台改为 HTTPS 而不改当前固定 loopback 流程不会解决问题。不要让每个用户重新建 App 来掩盖未完成的发行配置。

## 7. Notion：优先 MCP，需要主动观察时再配原生

**工具读写最快方式：**连接 → MCP → Notion → 登录并连接，选择工作区，随后在工具权限中允许需要的写工具。发行方和用户均无需为此新建原生 Notion OAuth 应用。

**需要自动观察页面变化时，配置原生连接：**

1. 在 [Notion 开发者入口](https://www.notion.so/my-integrations)创建 **Public connection / Public integration**，不要用单工作区 Internal integration 代替。
2. 面向其他用户时，若后台要求 installation scope，选 **Any workspace**。Selected workspaces only 会限制可安装范围。
3. 填写产品信息、隐私政策、服务条款、支持信息和回调：

```text
http://localhost:53682/oauth/notion
```

4. 开启 **Read content、Insert content、Update content**；需读取 / 新建评论时，增加对应 comment capabilities。用户信息能力按实际需求设置；当前身份解析使用 OAuth 返回的 workspace / owner 信息。
5. 保存 **OAuth client ID** 和 **OAuth client secret** 到发行方本机配置，不要使用 Internal integration token 代替。
6. 用户从 Unprompted 连接，在 Notion 授权页选择页面；本机「平台行动权限」另行允许对应账号和 API 路径。只给权限而没选择页面，无法访问那些页面。
7. 修改 capabilities 后重新授权，旧 token 不会因为后台开关改变就自动拥有所有新能力。

配置依据：[公开连接和安装范围](https://developers.notion.com/guides/get-started/public-connections)、[capabilities](https://developers.notion.com/reference/capabilities)。

**当前原生发行边界：**OAuth code exchange 在本机完成。若把 Notion Client Secret 打进 `.app`，任何拿到安装包的人都能提取；这不是服务器保密客户端。当前没有已实现的托管交换服务。面向所有用户发行时，最快可用的工具接入是官方 MCP；若必须让所有用户使用原生主动观察，应先完成正式的保密凭据 / OAuth 交换架构并通过平台要求，再预置原生应用身份。下面 JSON 的 Notion 项展示当前本机原生接法，不代表已解决这个公开发行问题。

## 8. 把应用身份放进发行包

Google 下载的 Desktop JSON 保存为：

```text
google-oauth-client.json
```

另外创建 `connector-clients.json`：

```json
{
  "github": { "clientId": "YOUR_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_MICROSOFT_APPLICATION_CLIENT_ID" },
  "slack": { "clientId": "YOUR_SLACK_CLIENT_ID" },
  "notion": {
    "clientId": "YOUR_NOTION_OAUTH_CLIENT_ID",
    "clientSecret": "YOUR_NOTION_OAUTH_CLIENT_SECRET"
  }
}
```

只发行 Notion MCP 时，删除整个 `notion` 项即可；不必创建原生集成。此时完整五家原生身份检查会报告 Notion 缺失，这是该方案的预期结果。

两个默认文件名已被 Git 忽略。使用其他文件名时也应放在仓库外的私有目录；不要提交真实配置。不要提交个人令牌。

**源码方式验收：**

```sh
npm ci --include=optional
npm run check:connector-clients
npm start
```

检查命令只验证元数据形状，不验证 App 注册真实性、scope、审核或实际登录。

**macOS 发行包：**

```sh
npm run build:macos-app -- \
  --google-client "$PWD/google-oauth-client.json" \
  --connector-clients "$PWD/connector-clients.json" \
  --out "$PWD/outputs/Unprompted.app"
npm run smoke:macos-app
```

构建输出已存在时，保留旧版并换一个 `--out` 路径；不要直接覆盖。上面的 smoke 使用默认 `outputs/Unprompted.app`；其他路径用 `node scripts/smoke-macos-app.mjs /你的路径/Unprompted.app`。

构建器包含运行时和所需依赖，最终用户无需另装 Node、Git、Python 或 uvx。当前构建按运行构建器的 Node 架构生成 arm64 或 x64 包；要覆盖两类 Mac，应分别构建和验收。当前构建器产物是未签名的本地 `.app`；面向普通 Mac 用户分发还需 Developer ID 签名、公证和实际安装验收，构建成功不等于这些已完成。

自托管时也可使用环境变量：Google 使用 `UNPROMPTED_GOOGLE_DESKTOP_CLIENT_FILE`，其他原生连接器使用 `UNPROMPTED_CONNECTOR_CLIENTS_FILE`，分别指向以上 JSON。参见[配置文档](CONFIGURATION.md)。

## 9. 普通用户按这个顺序操作

1. 打开发行方已预置应用身份的 Unprompted。
2. 先连接模型：填写服务地址、模型 ID 和需要的 Key，点击验证。模型须支持工具调用；本地兼容模型可不填 Key。
3. 打开「连接」，选择自己的来源。Google 登录；GitHub 先安装到仓库再输入设备码；Outlook 登录并同意；Slack 选工作区；Notion MCP 直接登录。
4. 若需要主动观察 Todoist，在 Todoist 的 **Settings → Integrations → Developer** 取得自己的 token，填入原生卡片；只需工具能力则选 Todoist MCP 登录。
5. Apple 用户在「系统设置 → 隐私与安全性 → 自动化」允许实际运行宿主访问备忘录 / 提醒事项，再选择文件夹 / 列表；本地文件夹直接选择范围。
6. 需要行动时，先请求并同意前面各家的写 scopes。云端原生卡片中打开「平台行动权限」，填写 API 路径范围，勾选允许并保存。最快完整启用某个账号已获权的接口时填 `/`；这也允许该范围内平台已授权的发送、修改和删除。
7. 若只允许一个目标，使用更窄路径，例如 GitHub `/repos/你的组织/你的仓库`、Slack `/api/chat.postMessage`、Graph `/v1.0/me/messages`。路径限制不等于内容或收件人限制；例如 Graph sendMail 使用另一条路径，Slack 频道 ID 通常在 body 中。
8. MCP 则展开「工具与权限」，选择需要的写工具；它不使用原生 API 路径授权。导入配置不会自动批准写入。
9. 只想保存草稿、Notion 子页面或备忘录成果时，也可用「创建工作成果」里的专门目标授权，配置草稿箱、父页面或文件夹。
10. 使用一项可核对的测试工作确认行动：例如在测试仓库建 issue、在自己可见会话发测试消息、创建测试日历事件或 Notion 页面。核对实际结果和执行记录；只有 accepted 不表示已回读核实。无需为了接通所有来源同时执行所有测试动作。

所有授权属于各自账号。无需共享发行方账号、密码或个人 token。连接成功不表示所有历史数据已导入，也不会自动把所有平台内容变成任务。

## 10. 其他 MCP 与 Key 服务

| 服务 | 用户填写什么 / 去哪里 |
| --- | --- |
| Linear | 连接 → MCP → Linear → 登录并连接，按需允许工具 |
| Jira / Confluence | 连接 → MCP → Jira and Confluence → 登录并连接；企业可能需管理员许可 |
| Notion / Todoist MCP | 同上，使用各自官方登录页 |
| Brave Search | 在 [Brave Search API](https://api.search.brave.com/) 获取自己的 Key，填入预设 |
| Firecrawl | 在 [Firecrawl](https://www.firecrawl.dev/) 获取自己的 Key，填入预设 |
| 其他远程 MCP | 添加服务 URL；需要时填写认证 headers，或使用支持的 OAuth 流程 |
| 本机 MCP | 填写 command、args、必要 env；只安装可信服务，并确认命令已安装 |

共享发行方的付费搜索 Key 会把费用和额度集中到发行方；当前没有配额 / 计费代理。要让用户连这类 Key 也不用填，需要另做带身份、额度和计费控制的服务，不能靠打包明文 Key 实现。

## 11. 常见卡点

| 现象 | 优先检查 |
| --- | --- |
| 用户仍被要求填写 Client ID | 是否用带两份应用身份文件的发行包；不要把开发者的 setup.json 当发行配置 |
| Google 只允许少数人 / 一周后失效 | Audience、Test users、Testing 状态和适用验证；普通用户不应自己建 Cloud 项目 |
| Google JSON 被拒绝 | 是否为 Desktop app，顶层是否为 installed |
| GitHub 连上但仓库为空 / 403 | 是否安装到该账号和仓库、权限增量是否批准、用户是否有权访问 |
| Microsoft 显示需管理员批准 | 多租户和个人账号类型、public client flow、委托权限及所在租户的同意政策 |
| Slack invalid_scope / Bot scopes 错误 | 是否填在 User scopes、scope 是否支持 User token、PKCE 与回调是否准确 |
| Slack 自己工作区可用，别人不能装 | 是否完成分发配置、生产回调资格和组织 / Marketplace 要求 |
| Slack / Notion 回调失败 | 固定端口 53682 是否被其他实例占用；localhost、端口、路径须与注册值一致 |
| Notion 页面找不到 | 是否选对工作区并授予页面；MCP 和原生连接是独立的 |
| 能读但无法写 | 后台已配置 ≠ 当前 token 已获权；重新同意写 scope，再允许本机平台行动 / MCP 写工具 |
| 所有行动都被拒绝 | 是否显式设置 UNPROMPTED_SHADOW_MODE=true；此设置会强制禁止写入 |
| 显示 accepted / unknown | 核对平台实际状态和回读结果，别直接重复触发；accepted 不是已完成 |
| API 大文件 / 特殊上传失败 | 通用 API 请求上限 192 KB、响应 2 MB；特殊预签名上传域名及大文件需专门适配 / 分块 |

## 12. 发行前完成一次真实验收

用未参与开发的账号，在干净用户配置中验证：预置身份可见 → 账号授权 → 首次读取 → 一次获准行动 → 平台回读 → 本机撤权 → 确认不能再执行。GitHub 和 Slack 额外用其他组织 / 工作区安装；Microsoft 同时测个人及组织账号；Mac 用 Finder 启动实际发行 `.app` 测试本地权限和 Fetch。

自动化 fixture、应用元数据检查和 smoke 均不能证明上述真实平台审批已通过。当前 Apple 本地接口保留其已实现操作范围；云端通用 API 和 MCP 写权限不会自动扩展 macOS 自动化接口。
