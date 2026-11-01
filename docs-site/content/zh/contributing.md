---
title: 参与贡献
description: 怎样指出不足并提交改动，从文档修正到连接器，包括要跑的检查和必须守住的保证。
---

界面、小缺陷、这些页面里的错误、新功能，都欢迎。无障碍改进，以及一个可以复现的场景，也同样欢迎。议题和拉取请求用中文或英文都可以。不需要邀请。留一句可以避免和别人做同一件事。小修复和草稿拉取请求不必事先批准。还没有方案时，也可以先提问。

仓库里的原文是 [CONTRIBUTING.md](https://github.com/PStarH/unprompted/blob/main/CONTRIBUTING.md)。

## 交什么

| 你看到的 | 用这个 |
| --- | --- |
| 行为和预期不符 | [问题反馈](https://github.com/PStarH/unprompted/issues/new/choose) |
| 一个具体想法，或不知道从哪改起 | [想法与贡献](https://github.com/PStarH/unprompted/issues/new/choose) |
| 应该接上的来源，以及它能露出的工作 | [新增连接器](https://github.com/PStarH/unprompted/issues/new/choose) |
| 一次发现有用、被漏掉，或只是噪声 | [场景反馈](https://github.com/PStarH/unprompted/issues/new/choose) |
| 安全漏洞 | [安全](security.md)，从那里进入[私下报告](https://github.com/PStarH/unprompted/security/advisories/new)。不要在议题里写利用细节、凭据、邮件或状态文件 |
| 文档错误 | 直接改 `docs-site/content/` 并提交拉取请求；只想描述问题时，开一个议题即可 |

空白议题也可以开。较大的功能请先开议题，写清使用者的处境、来源信号、证据和权限。扩大范围之前，先读[产品方向](https://github.com/PStarH/unprompted/blob/main/docs/PRODUCT_DIRECTION.md)。当前优先的是把已连接的上下文用稳，并诚实检验那些发现是否真有人需要。技术清单本身不能授权更宽的动作。

可以从[适合第一次动手的议题](https://github.com/PStarH/unprompted/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)开始。列表是空的时候，文档、无障碍、虚构场景和回归测试都是合适的起点。

## 先看一遍循环

不需要账号、模型，也不需要安装依赖：

```sh
npm run example
npm run example -- --approve
```

两条命令都使用虚构数据和模拟提供商。第一条准备一封回复，不会发送。第二条批准一次模拟投递，核对回执，并确认重复事件不会再发一次。文件是 [examples/first-workflow.mjs](https://github.com/PStarH/unprompted/blob/main/examples/first-workflow.mjs)。边界写在[第一次工作流](https://github.com/PStarH/unprompted/blob/main/docs/EXTENDING.md)。改一个场景或一页文档之前，不必先读完整份引擎。

## 准备一次改动

Node.js 20+ 和 npm 可以运行应用和基础测试。完整的贡献者检查，包括 Pi，用 Node.js 22.19+。先复刻仓库，再从当前 `main` 开分支：

```sh
git clone https://github.com/YOUR-USERNAME/unprompted.git
cd unprompted
git switch -c fix/describe-your-change
npm ci --include=optional
```

`npm ci --include=optional` 会安装锁定的 SQLite 运行时，以及可选的 Pi 和 MCP 包。没有这些可选包，基础测试仍能跑。Node.js 20 上会跳过 Pi 检查。

```sh
npm run demo
```

演示是一次性的模拟。跑测试之前用 Ctrl+C 停掉它。最短的一次检查：

```sh
npm run test:workflow
npm run check:syntax
```

改动过程中可以只跑一个文件，或只跑一个名称：

```sh
npm test -- --file=test/workflow.test.js
npm test -- --test-name-pattern="deadline"
npm run test:fast
```

`test:fast` 会跳过较长的 API、framework-eval 和泛化文件。运行器按稳定的文件名顺序、一次一个文件地执行。Node 的 `--test-*` 过滤在 Windows、macOS 和 Linux 上都会传进去。

## 从哪里改

| 改动 | 起点 |
| --- | --- |
| 某一步安装或设置让人迷惑 | [安装与首次运行](quickstart.md)、[配置](configuration.md)，以及 `docs/QUICKSTART.md` |
| 这些页面 | `docs-site/content/en/`、`docs-site/content/zh/` 和 `docs-site/nav.json`。用下面的命令构建 |
| 键盘或读屏 | `public/index.html`、`public/app.js`、`public/styles.css` |
| 漏掉的发现，或过多的噪声 | `src/requests.js`、`src/correlation.js`，以及发现相关的测试 |
| 一个虚构工作流 | `eval/scenarios.js` 和[测试说明](https://github.com/PStarH/unprompted/blob/main/docs/TESTING.md) |
| 证据或恢复 | `src/probes/`、`src/verification.js`、`test/workflow.test.js` |
| 连接器 | `src/connectors/` 和[连接器说明](https://github.com/PStarH/unprompted/blob/main/docs/CONNECTORS.md)。用测试里的模拟响应证明，不要用个人账号 |
| 权限或证据规则 | `src/permissions.js`、`src/evidence.js` |
| 工作区 | `public/` 和 `test/browser/` |
| MCP | `src/mcp.js`、`src/tool-loop.js` |

请求识别从 `test/discovery-precision.test.js` 和 `test/match-guard.test.js` 开始。关联和后续处理从 `test/workflow.test.js` 开始。证据和新鲜度从 `test/evidence.test.js` 和 `test/contradiction.test.js` 开始。权限从 `test/permissions.test.js`、`test/calibration.test.js` 和 `test/refusals.test.js` 开始。HTTP 边界是 `test/api.test.js` 和 `test/shadow.test.js`。连接器是 `test/connectors.test.js` 和 `test/sync.test.js`。重启和锁是 `test/store-lock.test.js`。界面渲染是 `test/ui-render.test.js`。完整对照表在[测试该加在哪里](https://github.com/PStarH/unprompted/blob/main/docs/TESTING.md#where-to-add-a-test)。

## 检查

只改文档时，跑 `npm run check:public`，并核对你写下的命令和行为与代码一致。改了这个站点就要重新构建：

```sh
node docs-site/build.mjs
node docs-site/check-links.mjs
```

构建结果写到 `website/docs/`。GitHub Pages 用这个目录提供 `/unprompted/docs/`。

代码改动在请求审阅之前，能跑完就跑完下面这一组。某项较长的检查在本地跑不了，就在拉取请求里写明是哪一项，以及原因。

```sh
npm test
npm run eval
npm run eval:framework
npm run eval:resilience
npm run eval:lifecycle
npm run eval:value
npm run check:public
npm run check:syntax
```

Pi 需要 Node.js 22.19+ 和可选包，然后跑 `npm run eval:pi`。它用脚本化响应检查集成，不评价模型质量。

| 命令 | 通过说明什么 |
| --- | --- |
| `npm test` | 行为、HTTP、连接器、权限、存储、界面和启动器测试 |
| `npm run eval` | 虚构场景里的发现、证据和动作是否符合预期 |
| `npm run eval:framework` | 框架正确性、虚假完成、无效动作、成本和注意力 |
| `npm run eval:resilience` | 有上限的模型调用、计划恢复，以及保留下来的工作 |
| `npm run eval:lifecycle` | CI 中同名任务所覆盖的完整工作生命周期 |
| `npm run eval:pi` | Pi 的任务契约，模型响应是脚本写的 |
| `npm run eval:value` | 从固定样本算出的结果指标。不是对真实世界价值的结论 |
| `npm run check:public` | 可发布路径、Markdown 链接，以及看起来像凭据的字符串 |
| `npm run check:syntax` | Git 已跟踪的 JavaScript 语法 |

评估通过，只说明那组固定样本。它不代表省下了时间，也不代表生产环境可靠。测试使用 `node:test` 和虚构数据，不得依赖真实的 Google 账号、模型或网络。

改动对得上时，还可以跑这些更窄的命令：

```sh
npm run test:connectors
npm run test:durable
npm run test:safety
npm run test:api
npm run test:browser
npm run test:first-run
npm run test:model-onboarding
npm run test:google-onboarding
npm run test:google-search
npm run test:connections
npm run test:workspace
npm run test:mcp
npm run test:durable-ui
npm run test:appearance
npm run test:overview
```

浏览器契约使用脚本化的本地服务器。不要把它们指向个人工作区。`npm run test:connections` 覆盖提供商选择、复制设备码、授权、暂停、断开，以及中英文布局。Apple 备忘录的测试注入的是脚本返回值，不验收真实账号。

拉取请求会跑 CI。Node.js 20 和 22 都按锁文件安装可选包，然后跑语法、公开文件、测试和评估。`eval:pi` 在 Node.js 22 上跑。另一个任务跑首次运行、模型、浏览器交互、工作区、Google 引导、连接、持久化界面和 MCP 的浏览器契约。贡献者工具在 Ubuntu、Windows 和 macOS 上检查。CodeQL 另行配置。

macOS 包是本地未签名构建：`npm run build:macos-app` 和 `npm run smoke:macos-app`。它不是经过公证的下载。

## 要守住的保证

- 正常模式在明确打开写入之前保持只读。批准边界要留着。
- 提供商和模型的输入不可信。模型不能授权、不能批准动作，也不能把工作标成完成。
- 证据来自真实来源，并带有版本。缺证据就保持未知。
- 提供商结果不明时，先核对再决定是否重试。接受一次审阅本身不是完成。
- 一个状态文件同时只有一个进程写入。迁移和恢复行为要保留。
- 议题、拉取请求、日志、测试样本和截图里不要放凭据、邮件、文档或工作区状态。用虚构数据。

行为变了就加回归测试。要覆盖会造成虚假完成、未经授权的动作，或重复发送的失败情况。不要加一个只是复述简单实现的测试。改文档不需要配一个长得像实现的测试。

在 `eval/scenarios.js` 里加场景时，使用不同的实体和交付物，写清虚构事件、预期结果，以及不该发生的事：无关变化不产生工作，缺证据不产生虚假完成，准备好的动作在授权之前不发送。

## 代码和拉取请求

使用 ES 模块、两空格缩进、单引号和分号。函数保持小，数据结构写明确。核心应用使用 Node 内置模块。Pi Agent Core、Pi AI 和 MCP 客户端是可选依赖。新增运行时依赖时，在拉取请求里说明。

拉取请求保持集中。写清问题、改动，以及你如何检查。读过议题的人之外，审阅者也要能看懂。[拉取请求模板](https://github.com/PStarH/unprompted/blob/main/.github/pull_request_template.md)会要求确认：使用了虚构数据、跑过 `npm run check:public`，以及行为改动覆盖了相应的失败或边界。

按路径暂存文件。在共享的检出里，`git add -A` 可能带上别人还没提交的改动。

## 许可

提交贡献即表示你有权提交，并同意以[Apache-2.0](https://github.com/PStarH/unprompted/blob/main/LICENSE)许可它，不附加额外条款。没有单独的贡献者许可协议。第三方代码要在拉取请求里写明来源和兼容的许可证；需要时也写入 [NOTICE](https://github.com/PStarH/unprompted/blob/main/NOTICE)。
