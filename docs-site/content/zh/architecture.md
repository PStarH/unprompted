---
title: 架构
description: 一件工作如何穿过本地 Node.js 进程，以及什么还没有实现。
---

Unprompted 是一个 Node.js 进程，使用 SQLite，浏览器界面在 `public/`，HTTP 在 `server.js`。`better-sqlite3` 是必需依赖。Pi Agent Core 和 MCP 客户端是可选的。演示保留 JSON 存储。

## 一件工作

```text
事件 → 规范化 → 请求 → 关联 → 证据
    → 准备 → 检查权限 → 执行 → 核验
```

后来的事件可以重新评估仍打开的请求。无关事件会被记下，但不创建任务。如果更新的证据使草稿失效，草稿会被撤回。完成需要核验过的结果，而不是模型的一句话。

## 模块

| 层 | 职责 | 位置 |
| --- | --- | --- |
| 连接器 | 读取来源并保持游标 | `src/connectors/` |
| 上下文 | 请求、文档、新鲜度 | `src/requests.js`、`src/store.js` |
| 规划 | 解释并选择检查 | `src/reasoning.js`、`src/pi-runtime.js` |
| 权限 | 证据和许可 | `src/evidence.js`、`src/permissions.js` |
| 执行 | 准备并运行被允许的动作 | `src/engine.js` |
| MCP | 可选的读取工具 | `src/mcp.js`、`src/tool-loop.js` |
| 界面 | 本地工作区 | `public/` |

这些层交换的数据结构定义在 `src/contracts.js`。

## 没有实现的部分

通用桌面控制、日历，以及不受限制的文档重写都没有实现。没有托管服务，没有身份验证，也没有多用户租户。

Google 同步靠轮询，不会续订推送通道。测试和场景分数只说明那组固定样本，不代表省下了多少时间，也不代表生产环境的可靠性。

更长的设计记录是 [docs/ARCHITECTURE.md](https://github.com/PStarH/unprompted/blob/main/docs/ARCHITECTURE.md)。v0.3 基线是 [docs/PRD.md](https://github.com/PStarH/unprompted/blob/main/docs/PRD.md)。
