# 连接器

[← 文档目录](README.md) · [English](CONNECTORS.md) · [完整配置教程：发行方与用户](CONNECTOR_SETUP.zh-CN.md)

先连接模型，再选择一个或多个工作来源。来源授权后立即生效，无需重启。
所有来源默认只读；断开一个来源不会影响其他来源。你可以随时暂停自动观察。

## 可用来源

| 来源 | 接入方式 | 读取内容 | 对外操作 |
| --- | --- | --- | --- |
| 本地文件夹 | macOS 文件夹选择器；其他系统输入路径 | 选定文件夹中的 Markdown 和 UTF-8 文本，可识别明确写出的待办 | 只读 |
| Apple 备忘录 | 仅 macOS。自动化权限，然后选择备忘录文件夹。只在 Mac 上推荐；其他系统若已连接才会显示，以便断开 | 所选文件夹中的纯文本；不读取锁定的备忘录和附件 | 单独授权后可在指定文件夹新建备忘录；真实账号和签名应用仍待人工验收 |
| Apple 提醒事项 | macOS 自动化授权，选择列表 | 所选列表的明确提醒事项、完成状态和到期时间 | 只读 |
| Todoist 原生 | 个人 API token；不需要开发者应用 | 分页读取待办，完整扫描后停止跟进已移除项目 | 单独允许平台行动后，可使用 token 授予的 API 权限 |
| Google Workspace | 桌面应用 OAuth 授权 | Gmail、Docs、Sheets、Slides；可选主日历 | 单独授权后可保存 Gmail 草稿；发送邮件和修改 Docs 使用独立授权 |
| GitHub | 官方设备授权 | 分配给当前用户的 issue、提及你的 issue 标题与正文、需要该用户评审或处理评审意见的 pull request、最近三天的提交，以及同一窗口内的 Actions 运行 | 单独允许平台行动后，可使用安装和用户实际授予的 API 权限，包括获准的评论、修改和其他操作 |
| Microsoft Outlook | 浏览器 PKCE 授权 | 最近 3 天收件箱邮件，之后读取 Graph 增量变化 | 草稿目标授权；通用 Graph 动作另需对应 scopes 和本机行动授权 |
| Notion | 公开集成浏览器授权 | 用户选择的页面 | 子页面目标授权；通用 API 可用平台授予的读取、插入、更新等能力 |
| Slack | PKCE 用户授权 | 私信和群组私信；可选已加入的频道及线程 | 申请相应 user scopes 并允许平台行动后，可调用获准的消息等 API |

没有云账号也可以从本地文件夹开始。Apple 备忘录仅支持 macOS。

连接 Google 后，可在**连接 → 搜索 Google**中搜索 Gmail 或按名称搜索 Google
Docs，并通过“加载更多”翻页。搜索遵循当前账号的读取范围，结果不会自动创建任务，
也不会自动发送给模型。发送 Gmail 还需要读取 Gmail 的权限，以便独立核实已发送邮件。

来源变化目前通过轮询观察；本地 `/api/stream` 可订阅更新后的工作区快照。
它不是服务商 webhook，也不是逐事件可重放的消息流。目前不支持服务商推送订阅。

Outlook 的增量检查点过期时，应用会重新分页读取收件箱，不再使用首次连接时的
三天限制，以覆盖长时间离线期间的邮件。相同邮件版本会去重，新 etag 或修改时间会更新本机邮件；未曾读取的
旧邮件可能进入工作流。每轮最多处理五页；启用自动观察时，仍有后续页会安排最多
四次短间隔继续读取，遇到失败则停止快速续读。单次手动检查会保留剩余游标供下次
继续。大收件箱可能需要多轮观察才能恢复。该恢复流程已通过模拟
服务测试，尚未使用真实 Microsoft 账号验证。

## 外部 MCP 工具

运行 `npm ci --include=optional` 安装客户端依赖，重启应用，然后打开
**连接 → MCP**。

**Fetch** 不需要账号，并且默认开启，使用随应用附带的 Node，不再需要安装 `uvx` 或 Python。它读取有大小上限的公开网页文本，不执行网页 JavaScript，不访问本地／私网地址。**Notion**、**Linear**、**Jira 与 Confluence**（Atlassian）和 **Todoist** 使用服务商登录页：选择**登录并连接**。不需要粘贴 Client Secret 或 API Token。**Brave Search** 和 **Firecrawl** 仍然需要 API Key。也可以填写 HTTPS 地址，或粘贴 `mcpServers` 配置。

- 远程 Streamable HTTP：`url`，可选 `headers`。远程地址使用 HTTPS，本机允许 HTTP。
- 本机 stdio：`command`、`args` 数组，可选 `env` 与绝对路径 `cwd`。
- 旧版 SSE：粘贴配置中增加 `"type":"sse"` 与 `url`。

本机命令会以你的用户权限运行，请只连接可信服务。支持令牌、请求头和环境变量
认证。内置托管服务通过浏览器完成 OAuth 2.1 登录。MCP prompts 尚未实现。
导入的配置不能包含 OAuth 令牌。以前用 API Token 添加的 Linear 或 Jira
会留在服务列表里，直到你删除。登录会替换已保存的 Linear 配置。

Standard 和 Pi 都能在调查任务时使用授权工具，模型需要支持工具调用。
连接时可一次授权服务声明的只读工具；这些声明来自服务方，并非安全沙箱。
展开**工具与权限**即可逐个调整。可写、破坏性以及没有只读声明的工具按行动处理，可逐项允许；导入配置不授予写权限。写入通过持久执行记录处理。停用或移除服务会撤销访问并关闭进程，重启会恢复
已启用的连接与授权。

支持只提供资源的服务。在**资源与权限**中逐项选择允许 Agent 读取的资源；
默认不授权。资源文本可能发送给配置的模型并保存在任务记录中。取消选择后，
此前取得的读取入口也会失效。资源模板、订阅和自动观察资源变化尚未支持；
服务未通知目录变化时，可重新连接以刷新资源列表。

MCP 用于补充邮件任务、分配给自己的 GitHub issue 与本地明确待办的调查上下文。
它不会通过任意工具自动轮询、创建任务；仍需连接工作来源。工具调用和有长度上限
的文本结果保留在任务的**来源**弹窗中。建议与工具返回内容不会直接成为完成证据，
也不会绕过既有对外操作授权。返回文本可能发送给你配置的模型，并保存在本地任务记录。

凭据和登录令牌保存在本地设置旁的私有 `mcp.json` 中，文件权限为 `0600`，未加密。
API 不返回命令、参数、环境变量值、请求头或令牌。替换配置时使用同一个服务名即可。

## 本地文件与备忘录

每台电脑都会推荐**本地文件夹**，不需要账号。**Apple 备忘录**只在 macOS 上推荐。
其他系统不显示这张卡片。如果备忘录已经连接，卡片会保留，方便断开。两者都不需要
OAuth 客户端、访问令牌或“完全磁盘访问”权限。macOS 可能会询问运行 Unprompted
的宿主应用是否可以自动化访问备忘录；例如，从终端运行时授权对象是终端。
可在“系统设置 → 隐私与安全性 → 自动化”中调整权限。

Unprompted 只观察你选定的文件夹。支持 `.md`、`.markdown` 和 `.txt`；隐藏文件、
符号链接和二进制文件会被跳过。每次最多读取 500 个文本文件、每个文件 512 KiB，
每轮最多处理 4 MiB 的变更文本。备忘录读取上限为 500 条、每条 512 Ki 字符。
范围过大或无法访问时会显示部分读取错误，可缩小所选范围后重试。

本地文本文件中明确标记的前 100 条待办会参与跟踪，支持 `- [ ]`、`TODO:` 和
`☐`。普通描述不会被当成待办。备忘录接口无法可靠判断原生勾选框的完成状态，
因此不会把它们当作完成信号。来源待办被勾选或删除，也不会被视为 Agent 已完成。

选中的本地内容与云端内容一样，可能会发送给你配置的模型。引用本地文件的链接
只在当前电脑可用；Agent 不会把本机地址作为对外文档链接发送。断开或移除范围后，
对应证据会失效，历史工作记录仍保留在本机工作区。

## 连接云端来源

GitHub 使用设备授权：复制短码并在服务商页面确认。Outlook 直接打开微软登录页面，选择账号并同意。
应用会核实登录身份后开始只读同步，不需要手工粘贴访问令牌。

Slack 和 Notion 使用浏览器授权码。回调地址必须分别是
`http://localhost:53682/oauth/slack` 和 `http://localhost:53682/oauth/notion`。
Slack 需要开启 PKCE，默认只申请用户私信读取权限，不申请 Bot 或发送权限。连接时可勾选频道访问，额外申请 `channels:read`、`channels:history`、`groups:read`、`groups:history`，已有账号可在管理连接中重新授权。
Notion 使用公开集成；每个用户在授权时自己选择可访问的页面。

首次发布前，项目维护者注册一次应用身份。GitHub 需要启用 device flow；只观察时配置 Issues、Pull requests、Contents、Actions 和 Metadata 读取权限，需要行动时为相应仓库能力配置写权限。Contents 只用来
列出提交和变更路径，不保存补丁或文件正文。Outlook 需要注册移动和桌面平台回调 `http://localhost/oauth/microsoft`，以及 delegated `User.Read`、`Mail.Read` 和
`offline_access`。Slack PKCE 只需要 Client ID；Notion 原生 OAuth 还需要 Client Secret。这些值放在被 git 忽略的
`connector-clients.json` 里。用户随后用自己的账号授权，令牌只留在那台电脑上。
组织策略可能要求管理员批准。

Google 使用桌面 OAuth。发行方可以预置已注册客户端，让用户直接授权；自行部署且
没有预置客户端时，需要按页面指引配置一次 Google Cloud，并导入桌面客户端 JSON。
账户授权后会立即读取所选范围。Gmail 发送和 Google Docs 修改权限分开申请；读取
权限不会自动允许写入。

## 为所有用户配置可执行的原生连接器

完整的开发者后台操作、scope 清单、可复制配置、打包命令、普通用户步骤和排错表见
[连接器完整配置教程](CONNECTOR_SETUP.zh-CN.md)。发行方注册一次应用并预置身份，用户随后授权自己的账号。

Google、Microsoft、Slack 可在连接表单填写附加 OAuth scopes。GitHub 的能力由 App 安装权限和用户权限共同决定；Notion 由 capabilities 和页面选择决定。完成服务商同意后，在「平台行动权限」允许账号和 API 路径；MCP 则逐项允许写工具。原生 API 及 MCP 写入均通过持久执行记录，接受响应不等于独立核实。

Notion、Linear、Jira / Confluence、Todoist 工具能力可通过内置 MCP 登录获得，不必为这些托管 MCP 注册开发者应用。但 MCP 不会自动轮询来源，原生自动观察仍需各自连接。

Slack PKCE 仅需 Client ID；Google 用独立 Desktop JSON；GitHub / Microsoft 仅需各自 Client ID。Notion 原生还使用 Client Secret，当前本机交换不能视为保密服务端部署。面向所有用户公开发行的边界及替代方案见完整教程。

用户操作：进入 **连接 → 创建工作成果**，先为 Gmail／Outlook 点击草稿权限授权，
然后选择草稿箱、Notion 父页面或备忘录文件夹；可限定项目，勾选自动创建并保存。
仅连接账号不会开启创建。Notion 找不到父页面时可输入其 32 位 ID（可带连字符）。
重连其他账号、移除文件夹或撤销授权后，旧权限不能用于新账号或其他位置。
启动环境显式设定 `UNPROMPTED_SHADOW_MODE=true` 时，所有写入保持关闭。

Standard 和 Pi 使用同一受限创建工具；activation layer 在任务回复准备好后可自动
保存邮件草稿。模型不能授予权限。每次写入都会检查当前任务、激活策略、账号、
目标和内容版本，经过执行账本并回读核验，任务中显示保存状态。
要求单次审核的策略会阻止自动创建；明确抑制的任务不会写入。超时或回读不匹配
显示待核对，不盲目重复创建。保存草稿或页面不等于完成原任务，也不会自动发送邮件。

当前自动化验证使用模拟服务和真实 harness／执行账本；配置完成后仍需分别用真实
账号验收 OAuth、一次草稿创建、页面／备忘录创建、撤销和重新连接。Google 公共
发布验证、组织审批和 macOS 签名应用授权无法由本地测试替代。

所有原生来源均接入统一的任务来源和文档读取工具，Standard 与 Pi 使用相同的
任务范围、激活规则和撤销检查。Gmail／Drive、Outlook、Slack、Notion、本地文件、
备忘录及 GitHub 四类工作均有从真实连接器事件解析到成果创建与核验的集成测试。
来源暂停激活时不创建新工作，需审核策略允许调查但阻止自动写入，撤销访问后
已取得的工具入口也不能继续读取。运行 `npm run test:connectors` 可验证这条链路；
覆盖明细见[测试说明](TESTING.md#connector-activation-and-harness-integration)。

## 开发连接器

扩展方式、模块职责、故障与权限契约见英文[连接器开发指南](CONNECTORS.md)。
新增来源应保持来源身份、增量游标、明确失败和只读默认值。Slack 私信走现有邮件
观察路径，界面会标成 Slack。Notion 页面走文档路径。不要把日历事件伪装成邮件。

## 版本、游标与覆盖范围

记录 ID 标识对象；事件 ID 标识对象的一次版本。`providerRevision`／`providerEtag`
可为不透明字符串，只用于相等比较，不用于排序。重复版本不重跑；消息编辑会替换
本机正文并修订相关请求。GitHub PR 使用仓库＋PR 编号作为稳定 ID，避免搜索返回的
issue ID 与 pulls API 的 PR ID 不一致。

游标只确认已经完成摄取的页。摄取失败保留旧游标；partial 允许确认成功子范围，
失败子范围保留原位；`hasMore` 不算完整观察。过期后先取新基线，再重新枚举；恢复
失败继续保留原检查点。Outlook 的 `recovering` 会跨页保留，恢复时不套用首次三天
限制；Notion 正文失败不跳过该搜索页，400/410 分页失效时重试同一水位；Slack 保存
冻结的时间窗口和未完成分页，不会每次重读第一页后跳过旧消息。

Drive changes token 遇到 400/410 会重新枚举当前可读文件，不承诺补齐离线期间的
所有删除事件。`GOOGLE_DOCUMENT_LIST_LIMIT` 可设置每轮列举目标数 1–500（默认 20），
不会在拿到下一页 token 后丢弃当前页剩余项目。Sheets 导出首个工作表的 CSV，不能
声称读取整个工作簿；Slides 导出文本，不含图片。`GOOGLE_GMAIL_QUERY` 同时影响初始
和增量读取；默认 `newer_than:3d -in:chats -in:sent`，新工作跳过 Sent、Trash 和 Draft。
Gmail history 过期后的补读仍受该查询范围限制，不承诺找回任意久远邮件。

Slack 会跟进已观察到的最多 100 个线程（包括旧根消息的新回复），并轮换复查最近
跟踪的 200 条消息以发现编辑／删除。它不提供完整历史、未加入频道、所有旧编辑或
从未观察到根消息的线程。工作区保留策略和限流仍会限制覆盖。商业分发要满足
[Slack Marketplace 要求](https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq)，
本机 localhost PKCE 能用不代表跨工作区公开分发已获准，需核实生产回调配置。

Calendar 默认关闭；在“调整读取来源”中勾选后申请 `calendar.events.readonly` 并
重新同意。当前只读主日历，从过去 30 天起初始化，随后分页增量；保留重复日程规则，
不展开全部实例。400/410 会恢复，取消日程会使证据失效，不会冒充 Agent 完成了任务。
Apple 提醒事项通过公开脚本接口读取所选列表，单轮最多 500 条；部分读取不推断
缺失项目已完成。Todoist 原生使用个人 token，分页上限 10,000 个活跃待办；完整扫描
后的缺失只代表停止跟进。两者都不提供写入，真实账号和签名应用权限仍需人工验收。

## 让用户以最小成本连接：发行方还需配置什么

| 来源 | 发行方一次性配置 | 用户操作 | 发行前仍需解决 |
| --- | --- | --- | --- |
| Google | 启用 Gmail／Drive；如提供修改或日历，再启用 Docs／Calendar；预置 Desktop client | 选账号与读取范围 | 面向 External 的 Production 同意页、域名／隐私政策、对应敏感／受限权限验证 |
| GitHub | 公开 GitHub App、device flow、只读 Issues／PRs／Contents／Actions／Metadata、Client ID | 安装到所选仓库并授权 | 组织管理员可能需要批准安装 |
| Outlook | Entra 多租户＋个人账号、public client/浏览器 PKCE、delegated User.Read／Mail.Read／offline_access、Client ID | 登录授权 | 发布者验证与租户管理员策略；草稿另申请 Mail.ReadWrite |
| Slack | 开启 PKCE、Client ID、用户私信和可选频道 scopes、注册生产回调 | 选择工作区授权 | 跨工作区分发／Marketplace、管理员策略及生产 redirect 可用性 |
| Notion 原生 | Public integration、Any workspace、Read content／user info；要创建页面再加 Insert content；ID＋Secret | 选择页面 | 当前本机交换不能保密发行方 Secret；保密的生产方案仍需托管交换服务 |
| 本地文件／备忘录／提醒事项 | 打包并签名 Mac 应用；无需云端注册 | 选文件夹／列表，确认系统权限 | 实际签名应用权限验收 |
| Notion／Linear／Atlassian／Todoist MCP | 客户端无需注册私有应用 | 官方登录页授权 | 服务商可用性、组织管理员策略；不替代原生后台观察 |
| Todoist 原生 | 无需应用注册 | 粘贴一次个人 token | token 在服务商处权限较广，应用仅调用读取 |
| Brave／Firecrawl | 客户端无需 OAuth 应用，内置 Node 读取工具 | 提供各自 API Key | 用户额度与付费；若要免 Key，需你提供有鉴权、限额、计费的服务端代理 |

Google 仍在 Testing 时，这些权限的外部账号 refresh token 通常七天到期；改为
Production 并不自动完成验证。Gmail／Drive 内容可能交给云端模型，不能只凭
“token 存本机”就断言免安全评估。参见
[Google 受限权限验证](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)、
[授权有效期](https://developers.google.com/identity/protocols/oauth2#expiration)、
[Microsoft 发布者验证](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)。

注册完四家的真实应用信息后打包：

```sh
node scripts/build-macos-app.mjs --out outputs/Unprompted.app \
  --google-client /private/path/google-desktop-client.json \
  --connector-clients /private/path/connector-clients.json
```

预置应用身份不能替用户授权，也不能跳过服务商审核。不要分发个人访问令牌或共享
用户账号。若只需要 Notion 查询，优先使用官方 Notion MCP，可免去自建 OAuth 应用；
需要持续后台发现才使用原生连接器。

运行 `npm run check:connector-clients` 可检查本机发行配置是否齐全，不输出凭据；它只检查文件形状，不代表服务商审核通过。

## 使用平台授予的行动权限

Google、Microsoft Graph、GitHub、Slack、Notion、Todoist 均提供通用 `platform_api` 任务工具，支持 GET、HEAD、OPTIONS、POST、PUT、PATCH、DELETE。平台账号的实际 token 权限决定接口能否执行，不再受本地固定动作清单限制。token 留在连接器内，请求限制在平台官方 API 域名，禁止跟随重定向。

在连接设置中填写 Google、Microsoft、Slack 的「附加 OAuth 权限」，重新完成同意。GitHub App 的权限在开发者后台配置，由安装方批准；Notion 的能力和页面访问也在平台配置并重新批准。本地允许行动不会扩张平台权限。

连接后，在「平台行动权限」填写 API 路径范围并允许行动。`/` 覆盖该平台；例如 `/repos/acme/project` 只覆盖一个仓库。该授权绑定账号，可随时撤销；API 还支持按 HTTP 方法、任务和项目限制。授权范围内可使用平台授予的发送、创建、修改和删除能力。

请求支持 JSON、表单、文本、base64 二进制，以及非凭据自定义 headers；响应支持 JSON、文本、base64。单请求上限 192 KB、响应上限 2 MB，大文件需分块或使用相应 MCP 工具。Apple 原生接口和本地文件接口保留现有支持的操作；此 HTTP 通道不扩展操作系统自动化 API。

写入有持久执行记录和重复调用去重。发送后连接中断会保留未知状态，不自动重发。平台接受只记为 accepted；需要独立 GET/HEAD 回读和字段断言才能记为 verified，也不会直接把整个任务标记为完成。

MCP 的写工具现在可以逐项开启，缺少只读声明也按行动处理。已授权的大型工具目录可通过 `find_connected_tools` 搜索，再用 `call_connected_tool` 调用，不再只暴露前 24 个能力。撤权或断开会使已捕获的工具立即失效。任意 MCP 工具没有统一回读协议，其成功只记为已接受。

接口字段和示例见 [英文连接器文档](CONNECTORS.md#using-platform-permissions-for-actions)。
