---
title: 开发与测试
description: 运行示例、测试套件和文档构建，并找到扩展点。
---

## 准备

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm run example
```

`npm run example` 运行确定性场景，打印请求、证据、准备好的回复、批准和验证路径。它不需要凭据，也不调用服务商或模型。

使用 Node.js 20+（建议 22+）；Pi 需要 22.19+。

## 测试命令

| 命令 | 覆盖 |
| --- | --- |
| `npm test` | 主 Node 测试运行器。 |
| `npm run test:fast` | 排除较慢的 API、框架和泛化套件。 |
| `npm run test:workflow` | 端到端工作流行为。 |
| `npm run test:api` | HTTP API 契约。 |
| `npm run test:connectors` | 连接器夹具、OAuth、同步、Google 持久化、验证安全。 |
| `npm run test:durable` | 持久执行、上下文、学习、隐私、运行时、配对、情境、探查。 |
| `npm run test:safety` | 可靠性、发送安全、MCP、Pi、任务服务。 |
| `npm run test:browser` | 浏览器交互契约；需要 Playwright 和本地浏览器。 |
| `npm run test:workspace` | 工作区视图与响应式行为。 |
| `npm run test:appearance` | 对比度与外观契约。 |
| `npm run check:syntax` | 全项目语法检查。 |
| `npm run check:public` | 公共仓库检查：链接、凭据、私有路径。 |
| `npm run eval:pi` | 通过真实 Pi 循环和脚本化模型响应运行 27 个任务契约。 |

先运行最小的相关套件。浏览器测试使用模拟服务商，不能证明真实账号可用；真实服务商验收是单独的人工步骤。

## 仓库结构

| 区域 | 位置 |
| --- | --- |
| HTTP 服务器与路由 | `server.js` |
| 引擎与证据 | `src/` |
| 连接器 | `src/connectors/`、`src/mcp.js` |
| 浏览器工作区 | `public/` |
| 测试 | `test/`、`test/browser/` |
| 文档源 | `docs/`、`website/docs/content/` |
| 公共网站 | `website/` |
| macOS 应用构建 | `scripts/build-macos-app.mjs` |
| 文档站生成器 | `website/docs/build.mjs` |

## 文档站

文档是无依赖的静态 HTML，从 Markdown 生成：

```sh
node website/docs/build.mjs
node website/docs/check-links.mjs
```

源文件在 `website/docs/content/en/` 与 `website/docs/content/zh/`；导航和界面文案在 `website/docs/nav.json`。构建会写出 `website/docs/index.html`、语言页面、`search-en.json`、`search-zh.json` 和 `sitemap.xml`，不需要框架或网络。

添加页面时同时更新三处：

1. 英文 Markdown；
2. 使用相同 slug 的中文 Markdown；
3. 中英文两份 `website/docs/nav.json` 导航。

然后运行构建和链接检查。站内链接使用同目录的 `.md` 文件名，便于 `npm run check:public` 解析；构建时再改写为页面 URL。

## 扩展点

| 目标 | 起点 |
| --- | --- |
| 添加连接器 | `src/connectors/`、连接器夹具测试、`docs/CONNECTORS.md`。 |
| 添加写入适配器 | `src/providers.js`、权限与目标检查、验证/回读测试。 |
| 修改证据或规划 | `src/evidence.js`、`src/reasoning.js`、`src/probes/`、工作流测试。 |
| 修改持久任务 | `src/store.js`、持久运行时测试、迁移与重启覆盖。 |
| 修改工作区 | `public/`、`test/browser/` 中的浏览器契约、外观测试。 |
| 添加 MCP 路径 | `src/mcp.js`、`src/tool-loop.js`、读取授权测试。 |

把确定性权威留在模型之外。新能力需要可见的权限边界、幂等派发路径和验证方案。不要添加仅凭请求被接受就报告成功的写入路径。

## 代码约定

- 项目使用纯 JavaScript ES 模块；没有前端框架构建。
- 测试默认使用 Node 内置测试运行器，浏览器脚本除外。
- 测试使用脚本化传输和夹具，不包含真实来源内容或凭据。
- 生成的文档和公开输出必须通过 `npm run check:public`。
- 不要提交 `.env`、`setup.json`、OAuth 客户端 JSON、工作区状态、日志或含真实内容的截图。

## 参与贡献

- [提交 issue](https://github.com/PStarH/unprompted/issues/new/choose) 时提供最小复现，不带隐私数据。
- 如果 checkout 中存在，阅读 [`CONTRIBUTING.md`](https://github.com/PStarH/unprompted/blob/main/CONTRIBUTING.md)。
- 安全报告不应包含实时凭据或个人内容。
- 项目使用 Apache-2.0 许可证。

## 继续阅读

- [架构](architecture.md)
- [本地 API](api.md)
- [连接器](connectors.md)
- [故障排查](troubleshooting.md)
