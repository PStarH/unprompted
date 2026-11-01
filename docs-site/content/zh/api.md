---
title: 本地 API
description: 用于查看工作区、连接模型和审阅工作的本机 HTTP API。
---

基址是启动时打印的地址，通常是 `http://127.0.0.1:4173`。没有身份验证。POST 正文是 JSON，并带 `Content-Type: application/json`。浏览器的跨源写入会被拒绝。不要把端口暴露出去。

下面是日常路由。请求正文和其余持久化接口写在 [docs/API.md](https://github.com/PStarH/unprompted/blob/main/docs/API.md)。

## 查看

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| GET | `/api/health` | 运行模式、影子策略、提供商和数据模式 |
| GET | `/api/runtime` | 连接器、缺失的配置和模拟状态 |
| GET | `/api/setup` | 已脱敏的模型和来源状态。没有秘密 |
| GET | `/api/state` | 事件、任务、证据、文档和历史 |
| GET | `/api/stream` | 服务器推送的工作区快照 |
| GET | `/api/trace?taskId=TASK_ID` | 一项任务的决策链 |

真实工作区的 `/api/state` 可能含有个人内容。不要把它贴进议题。

## 模型

`POST /api/setup/model` 接受 `baseUrl`、`model`、可选的 `apiKey`，以及 `harness`（`classic` 或 `pi`）。它和表单做同一次真实验证。失败不会保存这次候选。`POST /api/setup/model/forget` 移除已保存的连接。请求仍在进行时返回 `MODEL_BUSY`。由启动环境配置时返回 `MODEL_ENV_CONFIGURED`，并继续由该环境控制。

## 审阅

带有准备草稿的任务会暴露 `reviewToken`。批准时在正文里送出这个精确令牌。草稿或输入变了，响应是 **409**，旧令牌不会被接受。重复一个已经接受的令牌是幂等的。接受记录的是本地决定，它本身不是对提供商的写入。

`POST /api/privacy/preview` 统计一次删除会牵涉什么。`POST /api/privacy/forget` 带上 `kind` 和 `id`，删除本地派生数据，并报告仍然保留的部分。它不会擦除提供商的副本。

## 自动跟进

`POST /api/autonomy` 接受 `{ "mode": "time", "durationMinutes": 30 }` 或 `{ "mode": "task", "taskId": "TASK_ID" }`。响应包含 `grant` 和 `state`。同一模式、同一任务的新授权会替换上一条。时间授权和任务授权可以同时存在。`POST /api/autonomy/GRANT_ID/revoke` 停止该授权。`GET /api/state` 包含 `autonomy.enabled` 和当前有效的授权。无效输入返回 **400**。影子模式会拒绝，错误文本是 `YOLO requires write mode.` 行为见[自动跟进](follow-up.md)。

`POST /api/tasks/TASK_ID/feedback` 的 `label` 为 `useful`、`not_useful`、`not_mine`、`duplicate`、`already_handled` 或 `wrong_association`。标成重复时还要带 `relatedTaskId`。`POST /api/feedback/FEEDBACK_ID/undo` 撤回一条纠正。这些都不会发信。`POST /api/misses` 带上 `note`，记下你看到而应用没有发现的事。它不创建任务。空的说明会被拒绝。

## 来源

本地文件夹和备忘录的选择、移除和忘记在 `/api/setup/local-sources/` 下。取消选择器不会改变已保存的授权。`GET /api/local-sources/documents/:id` 返回最新文本，或一次明确的失败。

连接器同步和 OAuth 路由使用同样的权限检查。排队的路由返回 **202** 和一个任务。这不是已核验的写入。JSON 演示期间，持久化工作区的这些操作返回 **409** `DURABLE_WORKSPACE_REQUIRED`。

长期目标、经验、策略和产物授权在仓库的 API 文档里。创建目标或目的地授权需要 `confirmed: true`。它们本身都不会授予连接器写入。
