# 连接器

[← 文档目录](README.md) · [English](CONNECTORS.md)

先连接模型，再选择一个或多个工作来源。来源授权后立即生效，无需重启。
所有来源默认只读；断开一个来源不会影响其他来源。你可以随时暂停自动观察。

## 可用来源

| 来源 | 接入方式 | 读取内容 | 对外操作 |
| --- | --- | --- | --- |
| 本地文件夹 | macOS 文件夹选择器；其他系统输入路径 | 选定文件夹中的 Markdown 和 UTF-8 文本，可识别明确写出的待办 | 只读 |
| Apple 备忘录 | macOS 自动化权限，然后选择备忘录文件夹 | 所选文件夹中的纯文本；不读取锁定的备忘录和附件 | 单独授权后可在指定文件夹新建备忘录；真实账号和签名应用仍待人工验收 |
| Google Workspace | 桌面应用 OAuth 授权 | Gmail、Google Docs 和 Drive 变更 | 单独授权后可保存 Gmail 草稿；发送邮件和修改 Docs 使用独立授权 |
| GitHub | 官方设备授权 | 分配给当前用户的 issue、需要该用户评审或处理评审意见的 pull request、最近三天的提交，以及同一窗口内的 Actions 运行 | 只读；不会评论、提交评审、修改文件、合并或重跑工作流 |
| Microsoft Outlook | 官方设备授权 | 最近 3 天收件箱邮件，之后读取 Graph 增量变化 | 单独授权后可新建未发送草稿 |
| Notion | 公开集成浏览器授权 | 用户选择的页面 | 单独授权后可在指定父页面下新建子页面 |
| Slack | 用户浏览器授权 | 授权范围内的私信和群组私信 | 只读 |

没有云账号也可以从本地文件夹开始。Apple 备忘录仅支持 macOS。

连接 Google 后，可在**连接 → 搜索 Google**中搜索 Gmail 或按名称搜索 Google
Docs，并通过“加载更多”翻页。搜索遵循当前账号的读取范围，结果不会自动创建任务，
也不会自动发送给模型。发送 Gmail 还需要读取 Gmail 的权限，以便独立核实已发送邮件。

来源变化目前通过轮询观察；本地 `/api/stream` 可订阅更新后的工作区快照。
它不是服务商 webhook，也不是逐事件可重放的消息流。目前不支持服务商推送订阅。

Outlook 的增量检查点过期时，应用会重新分页读取收件箱，不再使用首次连接时的
三天限制，以覆盖长时间离线期间的邮件。已经读取的邮件会按 ID 去重；未曾读取的
旧邮件可能进入工作流。每轮最多处理五页；启用自动观察时，仍有后续页会安排最多
四次短间隔继续读取，遇到失败则停止快速续读。单次手动检查会保留剩余游标供下次
继续。大收件箱可能需要多轮观察才能恢复。该恢复流程已通过模拟
服务测试，尚未使用真实 Microsoft 账号验证。

## 外部 MCP 工具

运行 `npm ci --include=optional` 安装客户端依赖，重启应用，然后在
**连接 → MCP → 添加服务**输入远程地址与可选访问令牌。也可以选择**粘贴配置**，
导入常见的 `{"mcpServers":{"服务名":{...}}}` 格式。

- 远程 Streamable HTTP：`url`，可选 `headers`。远程地址使用 HTTPS，本机允许 HTTP。
- 本机 stdio：`command`、`args` 数组，可选 `env` 与绝对路径 `cwd`。
- 旧版 SSE：粘贴配置中增加 `"type":"sse"` 与 `url`。

本机命令会以你的用户权限运行，请只连接可信服务。支持令牌、请求头和环境变量
认证；尚未实现 MCP 交互式 OAuth 和 prompts。

Standard 和 Pi 都能在调查任务时使用授权工具，模型需要支持工具调用。
连接时可一次授权服务声明的只读工具；这些声明来自服务方，并非安全沙箱。
展开**工具与权限**即可逐个调整。未声明只读的工具需要你确认读取授权；明确声明
可写或破坏性的工具保持禁用。停用或移除服务会撤销访问并关闭进程，重启会恢复
已启用的连接与授权。

支持只提供资源的服务。在**资源与权限**中逐项选择允许 Agent 读取的资源；
默认不授权。资源文本可能发送给配置的模型并保存在任务记录中。取消选择后，
此前取得的读取入口也会失效。资源模板、订阅和自动观察资源变化尚未支持；
服务未通知目录变化时，可重新连接以刷新资源列表。

MCP 用于补充邮件任务、分配给自己的 GitHub issue 与本地明确待办的调查上下文。
它不会通过任意工具自动轮询、创建任务；仍需连接工作来源。工具调用和有长度上限
的文本结果保留在任务的**来源**弹窗中。建议与工具返回内容不会直接成为完成证据，
也不会绕过既有对外操作授权。返回文本可能发送给你配置的模型，并保存在本地任务记录。

凭据保存在本地设置旁的私有 `mcp.json` 中，文件权限为 `0600`，未加密。
API 不返回命令、参数、环境变量值或请求头。替换配置时使用同一个服务名即可。

## 本地文件与备忘录

在“连接”页面选择**本地文件夹**或**Apple 备忘录**。两者都不需要 OAuth
客户端、访问令牌或“完全磁盘访问”权限。macOS 可能会询问运行 Unprompted
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

GitHub 和 Outlook 使用官方设备授权：点击连接、复制短码，并在服务商页面确认。
应用会核实登录身份后开始只读同步，不需要手工粘贴访问令牌。

Slack 和 Notion 使用浏览器授权码。回调地址必须分别是
`http://localhost:53682/oauth/slack` 和 `http://localhost:53682/oauth/notion`。
Slack 需要开启 PKCE，并且只申请用户私信读取权限，不申请 Bot 或发送权限。
Notion 使用公开集成；每个用户在授权时自己选择可访问的页面。

首次发布前，项目维护者注册一次应用身份。GitHub 需要启用 device flow，并把
Issues、Pull requests、Contents、Actions 和 Metadata 设为只读。Contents 只用来
列出提交和变更路径，不保存补丁或文件正文。Outlook 需要 delegated `User.Read`、`Mail.Read` 和
`offline_access`。Slack 与 Notion 还需要 Client Secret。这些值放在被 git 忽略的
`connector-clients.json` 里。用户随后用自己的账号授权，令牌只留在那台电脑上。
组织策略可能要求管理员批准。

Google 使用桌面 OAuth。发行方可以预置已注册客户端，让用户直接授权；自行部署且
没有预置客户端时，需要按页面指引配置一次 Google Cloud，并导入桌面客户端 JSON。
账户授权后会立即读取所选范围。Gmail 发送和 Google Docs 修改权限分开申请；读取
权限不会自动允许写入。

## 为所有用户配置可执行的原生连接器

应用注册由发行方完成一次，每个用户仍需用自己的账号授权。应用身份配置不会把
你的账号、令牌、页面或备忘录文件夹分享给其他用户；创建权限保存在各自的持久工作区。

1. **Google**：在 Google Cloud 启用 Gmail、Drive、Docs API，配置面向目标用户的
   OAuth consent screen，并创建 Desktop app 客户端。预置客户端的方式见
   [配置说明](CONFIGURATION.md)。要创建 Gmail 草稿，登记 `gmail.readonly` 和
   `gmail.compose`；读取文档增加 `drive.readonly`。不要为这个功能增加
   `gmail.modify`、完整邮箱权限或 Docs 修改权限。正式面向外部用户发布前需完成
   适用的 OAuth 验证，不能把 Testing 测试用户名单当作公开发布。
   `gmail.compose` 本身允许管理草稿和发送邮件；Google 没有此调用可用的纯草稿权限。
   产品通过独立发送授权限制调用。见
   [Gmail 权限定义](https://developers.google.com/workspace/gmail/api/auth/scopes)和
   [创建草稿](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create)。
2. **Outlook**：在 Microsoft Entra 注册支持目标组织和个人账号的应用，启用
   public client/device flow。配置 delegated `User.Read`、`Mail.Read`、
   `Mail.ReadWrite` 和 `offline_access`。用户点击草稿授权时才追加
   `Mail.ReadWrite`；不申请 application 邮箱权限或 `Mail.Send`。组织管理员可能
   需要批准。此写权限包含修改、删除能力，产品仅开放新建草稿。见
   [Graph 创建草稿](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0)。
3. **Notion**：创建 Public integration，回调登记为
   `http://localhost:53682/oauth/notion`。开启 **Read content**、**Insert content**
   和读取用户身份；保持 **Update content** 关闭。用户授权时选择一个有创建权限的
   父页面，再在应用里明确指定该父页面。仅有读取能力的旧集成需先修改能力并重新
   授权。这里支持页面下新建子页面，尚不支持数据库属性写入。见
   [Notion 集成能力](https://www.notion.com/help/create-integrations-with-the-notion-api)。
4. **Apple 备忘录**：无需云端应用注册；每个用户在 macOS 授予自动化访问并选择
   文件夹。然后额外授权其中一个文件夹用于新建备忘录。macOS 自动化权限本身
   比创建功能更广，产品不会因此开放删除或修改已有备忘录。
5. **GitHub／Slack**：按上文注册读取权限，作为任务和调查上下文来源。本轮不开放
   评论、发消息、提交代码、合并或删除。它们的任务可由 harness 在另外授权的
   Notion 页面或备忘录文件夹中形成成果。

注册值配置示例（文件不提交 Git）：

```json
{
  "github": { "clientId": "YOUR_GITHUB_APP_CLIENT_ID" },
  "microsoft": { "clientId": "YOUR_MICROSOFT_APPLICATION_ID" },
  "slack": { "clientId": "YOUR_SLACK_CLIENT_ID", "clientSecret": "YOUR_SLACK_CLIENT_SECRET" },
  "notion": { "clientId": "YOUR_NOTION_CLIENT_ID", "clientSecret": "YOUR_NOTION_CLIENT_SECRET" }
}
```

保存为仓库根目录的 `connector-clients.json`，或使用
`UNPROMPTED_CONNECTOR_CLIENTS_FILE` 指向该文件。构建发行版时可传入
`--connector-clients /path/to/connector-clients.json`。Google Desktop 客户端另外配置。
当前 Slack／Notion 授权交换在本机完成，Client Secret 会随预置配置进入本机，
不能视为服务器端保密凭据；需要保密客户端的发行方案应采用托管 OAuth 交换。

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
