---
title: 开发与测试
description: 第一次改动用的命令、测试套件，以及这个文档站如何构建。
---

中文或英文的议题和拉取请求都可以。Node.js 20+ 可以跑基础测试。Pi 检查需要 Node.js 22.19+。

## 一小段循环

```sh
npm run example
npm run example -- --approve
```

两条命令都使用虚构数据和模拟提供商，不需要账号或模型。反馈、拉取请求和审阅要求见[参与贡献](contributing.md)。

## 检查

```sh
npm test
npm run test:fast
npm run check:syntax
npm run check:public
```

`npm test` 运行行为、HTTP、连接器、权限、存储、界面和启动器测试。`test:fast` 跳过较长的 API、framework-eval 和泛化文件。`check:syntax` 解析 Git 已经跟踪的 JavaScript。`check:public` 检查可发布路径、Markdown 链接，以及看起来像凭据的字符串。

一次只跑一个文件：

```sh
npm test -- --file=test/workflow.test.js
npm run test:workflow
```

浏览器契约包括 `npm run test:model-onboarding`、`npm run test:google-onboarding` 和 `npm run test:connections`。它们使用脚本化的本地服务器。不要把它们指向个人工作区。

可选评估：`npm run eval`、`npm run eval:framework`、`npm run eval:resilience`、`npm run eval:lifecycle`、`npm run eval:pi` 和 `npm run eval:value`。通过只说明夹具符合预期，不是生产结论。Pi 需要可选安装和 Node.js 22.19+。

macOS 包是本地的未签名构建：

```sh
npm run build:macos-app
npm run smoke:macos-app
```

## 这个站点

```sh
node docs-site/build.mjs
node docs-site/check-links.mjs
```

Markdown 在 `docs-site/content/en/` 和 `docs-site/content/zh/`。导航文案在 `docs-site/nav.json`。构建写入 `website/docs/`，也就是 GitHub Pages 上的 `/unprompted/docs/`。

## 从哪里改

| 改动 | 起点 |
| --- | --- |
| 连接器 | `src/connectors/` 和 `docs/CONNECTORS.md` |
| 权限或证据 | `src/permissions.js`、`src/evidence.js` |
| 工作区 | `public/` 和 `test/browser/` |
| MCP | `src/mcp.js`、`src/tool-loop.js` |
| 这些页面 | `docs-site/content/` |

按路径暂存文件。不要在这个检出里使用 `git add -A`。其他代理可能有未提交的改动。
