<p align="center"><img src="docs/assets/banner.svg" alt="Unprompted — Work without the prompt." width="100%"></p>

# Unprompted

**一个主动发现值得处理的事，并推动它向前发展的 AI Agent。**

Unprompted 关注你授权的工作与生活环境中的变化，关联已有工作、核对证据、准备下一步行动。
你只在真正需要决策时参与，不必为每件事重新下达指令。

这是给一个人、一台电脑、一个进程使用的本地初版。邮件和文档是最先接上的来源，产品仍是通用的工作伙伴。[产品方向](docs/PRODUCT_DIRECTION.md)

[English](README.md) · [立即体验](#开始使用-agent) · [文档](docs/README.md) · [参与贡献](CONTRIBUTING.md) · [反馈问题](https://github.com/PStarH/unprompted/issues/new/choose)

## 开始使用 Agent

**macOS 应用（Apple 芯片）：** 从 [Releases](https://github.com/PStarH/unprompted/releases)
下载 `Unprompted-0.3.0-macos-arm64.zip`，用
`shasum -a 256 -c Unprompted-0.3.0-macos-arm64.zip.sha256` 校验，解压后把
`Unprompted.app` 移到 `/Applications`。应用为 ad-hoc 自签名，未经 Apple 公证：
首次打开请右键选择**打开**，或运行
`xattr -dr com.apple.quarantine /Applications/Unprompted.app`。请在 APFS 磁盘上运行；
从 exFAT 外接盘启动可能卡住。数据保存在 `~/Library/Application Support/Unprompted`，
删除应用不会删除数据。

**从源码运行（任意平台）：** 需要 **Node.js 20+**，以及模型提供方的接口地址、模型 ID 和 API Key。
本地兼容模型可以不填 Key。首次安装锁定依赖，无需构建前端。

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start
```

打开终端 **Ready** 后显示的网址；交互式终端也会自动打开浏览器。
填写接口地址、模型 ID 和 Key，点击 **验证并连接模型**。
应用会用虚构内容发送一次真实的结构化推理请求；验证成功才保存并立即生效，无需重启。
Key 只保存在本机，不会由 API 回传。

接着在同一页选择一个来源。**本地文件夹**无需云账号，选一个包含 Markdown 或文本文件的文件夹即可。**Apple 备忘录**仅支持 macOS，需要允许自动化访问；真实账号授权流程仍待人工验收。

GitHub 和 Outlook 使用设备授权：复制短码并在官方页面确认，无需粘贴访问令牌。来源可分别暂停或断开。[连接器配置](docs/CONNECTORS.zh-CN.md) · [开发指南](docs/CONNECTORS.md)。

外部 MCP 工具可在运行 `npm ci --include=optional` 并重启后，从**连接 → MCP**接入。
输入远程地址或粘贴 `mcpServers` 配置，支持 HTTP、stdio 与旧版 SSE。
两套 harness 都能用授权读取工具调查已有任务。[MCP 配置与范围](docs/CONNECTORS.zh-CN.md#外部-mcp-工具)

Google 接入方面，预置了已注册桌面 OAuth 客户端的发行版可直接打开 Google 授权；
自行部署且没有预置客户端时，页面会引导完成一次性的 Google Cloud 设置，并接收下载的 JSON。
无需复制 refresh token，也无需重启服务。

Google 授权后会切换到该账号独立的真实工作区，并立即读取近期邮件和现有 Google Docs。
选择本地文件夹或备忘录后，只读取你选定的范围。已连接的模型会处理实际读取的内容；页面显示读取量和发现的工作，没有发现时如实说明。

**正常启动不会播放样例或生成虚构任务。**

首次只申请读取，可以随时暂停观察。发送邮件与修改文档另行开启；每项操作仍需匹配你的批准或已有授权。
模型失败时任务不会退回规则逻辑并显示可发送。

界面支持中英文。默认端口被占用时会自动选择可用端口；也可运行 `npm start -- --port 4180` 指定。
不使用 Git 时，可[下载源码 ZIP](https://github.com/PStarH/unprompted/archive/refs/heads/main.zip) 后运行相同命令。

## v0.3：可靠执行与受限学习

[实现需求](docs/PRD.md)涵盖持久作业、任务版本与检查点、对外写入意图、资源占用和故障核验。
进程重启或请求超时后，先核验外部结果，再决定是否重试。
记忆、明确规则、学习经验分开管理；经验不能授予工具权限，自动晋升默认关闭。
在**记忆**中管理事实、规则和经验，在**设置**中调整提醒预算与免打扰时段。
**忘记**会清理关联本地数据并取消依赖它的任务，同时如实报告外部操作和备份保留状态。

正常工作区使用 SQLite WAL + FTS5。默认检索结合全文搜索与进程内词法向量，框架可接入本地语义编码器；
默认实现不宣称神经语义检索。旧 JSON 首次打开时迁移，并保留私有备份，执行“忘记”时一并清理。
[持久化与恢复边界](docs/ARCHITECTURE.md#storage-and-process-model)。

## 主动性体现在哪里？

推动工作的是上下文中的变化：

```text
邮件到达 → 发现承诺 → 证据更新 → 准备回复 → 由你批准 → 核验结果
```

- **主动发现**：从授权环境的事件中识别已有工作，不必再向 Agent 交办一次。
- **持续核对**：缺少或过期的证据会让工作保持未完成；新结果出现时，旧草稿可以自动撤回。
- **主动准备**：回复、文档链接、来源和已核对的要求一起备好，供你审阅。
- **适时询问**：对外动作需要批准，或你事先明确授予、范围匹配的权限；结果未知时先核实，再决定是否重试。

## 当前能做什么？

这是**本地初版**：一个人、一台电脑、一个进程。先连接你的模型，再连接一个来源。本地文件夹不需要云账号，连接后立即开始读取。发送和修改文档默认关闭，直到你另行开启。没有结果就显示为空。模型失败时，这项工作保持未就绪。

macOS 安装包为 ad-hoc 自签名，未经 Apple 公证。其他平台需要 Node.js 20 或更高版本，执行 `npm ci --include=optional` 和 `npm start`，然后打开本机地址。Google、GitHub、Outlook、Slack 和 Notion 需要注册 OAuth 客户端，或使用已经带上客户端的发行版。这个仓库不附带公开的 Client ID。真实账号使用仍需验收，这里不把它说成已经完成生产验证。

| 模块 | 当前范围 |
| --- | --- |
| 上下文 | 邮件请求、原生 GitHub issue、文档变更、运行记录 |
| 本机来源 | 指定的 Markdown / 文本文件夹；macOS 备忘录可在另行授权的文件夹新建内容，真实账号验收待完成 |
| GitHub | 官方设备 OAuth、分配给自己的 issue、更新及改派跟进；只读 |
| Microsoft Outlook | 官方设备 OAuth、收件箱增量同步；另行授权后可新建草稿 |
| Slack | 浏览器 OAuth，读取个人和群组私信 |
| Notion | 浏览器 OAuth，读取所选页面；另行授权后可新建子页面 |
| Google Workspace | Gmail / Drive / Docs；创建草稿、发送和文档修改分别授权 |
| MCP 工具 | 接入外部 HTTP / stdio / SSE 服务，逐个工具授权读取，保留任务调查与调用记录 |
| 真实发送 | 已实现并有脚本测试覆盖，需显式开启；不宣称已完成生产环境验证 |
| 主动管理 | 同一承诺修订/撤回、持久化等待、可撤销纠正与共同依赖决策 |
| 文档补丁 | 根据缺项准备有来源的原文补丁，绑定版本授权，应用后读回核验 |
| 本地应用 | 浏览器 OAuth 接入、持续观察控制与未签名 macOS 应用构建器 |
| 存储 | 单用户、单进程、SQLite WAL + FTS5。本机数据库、令牌和模型密钥不加密 |

尚未实现内置日历连接器、通用桌面控制、开放式自主重写或托管多用户服务。
真实场景的价值与误报率还需要大家反馈。[架构与局限 →](docs/ARCHITECTURE.md)

## 接入自己的工作环境

`npm start` 打开持久化模型与来源设置，用于处理**自己的真实工作**。可以选择本地文件夹、macOS 备忘录、Google、GitHub 或 Outlook，来源**默认只读**。
首次连接、首轮观察、增量权限、暂停、重试和断开均可在界面完成，无需重启；不同 Google 账号使用独立工作区：

- [连接器配置](docs/CONNECTORS.zh-CN.md) · [连接器开发指南（English）](docs/CONNECTORS.md)
- [桌面应用与 OAuth 进阶配置（English）](docs/ONBOARDING.md)
- [Google Workspace 详细接入（English）](docs/LIVE_INTEGRATION.md)
- [本机数据与隐私说明（English）](docs/CONFIGURATION.md)

服务仅绑定 `127.0.0.1`，没有登录鉴权，只适合在自己的电脑运行。
邮件、文档和任务内容会发送给你选择的模型。本机数据库和密钥不加密。
断开连接会停止读取，并保留已保存的记录。**断开并清除**会删除这个来源在本机的收件、任务、快照和衍生内容。显式运行的规则示例不调用模型。

## 一起参与

不启动网页、不配置账号或模型，也能直接运行框架的完整工作流：

```sh
npm run example
npm run example -- --approve
```

第一条命令演示主动发现、等待证据和准备回复，发送数量保持为零。
第二条明确授权一次**模拟发送**，核验回执，并检查重复事件不会重复发送。
修改[示例代码](examples/first-workflow.mjs)即可更换请求与证据；
[扩展指南](docs/EXTENDING.md)说明实际模块边界、契约和测试入口。

开发者可运行 `npm run demo` 查看本地规则模拟；它不调用模型、不读取保存的账号，也不会访问外部服务。

可选 [Pi 内核](docs/CONFIGURATION.md#pi-tool-loop) 提供有预算的文档读取工具循环，
需要 Node.js 22.19+ 和可选依赖。基础演示和示例都不需要。

欢迎试用后指出应该发现却没有发现的事，也欢迎提交小而具体的改进。

- 第一次参与：从[贡献指南](CONTRIBUTING.md)和
  [good first issues](https://github.com/PStarH/unprompted/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) 开始。
- 遇到问题：用[问题模板](https://github.com/PStarH/unprompted/issues/new/choose)提供模拟数据和复现步骤。
- 分享场景：说明什么变化应该触发发现、什么证据足以支持行动。
- 修改代码：先运行 `npm run test:workflow`，再参照[测试指南](docs/TESTING.md)完成对应检查。

文档、无障碍体验、可复现场景和回归测试都欢迎。不需要单独签署贡献者协议。

## 许可证

[Apache-2.0](LICENSE)。署名见 [NOTICE](NOTICE)，安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
