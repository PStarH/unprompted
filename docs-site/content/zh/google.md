---
title: Google Workspace
description: 连接 Gmail、Google 文档和日历，按需允许行动。
---

在**连接 → Google**选择要观察的 Gmail、Google Docs / Sheets / Slides 和主日历，在 Google 的页面选择自己的账号并同意。初次启用日历或增加权限需要重新授权。最近观察和数量显示在连接卡片上。

## 允许行动

在连接表单的**附加 OAuth 权限**输入需要的权限，多个权限用空格分隔；完成 Google 授权后，在连接卡片的**平台行动权限**选择 API 路径并确认。

| 要做什么 | 附加权限 |
| --- | --- |
| 管理 Gmail 草稿 | `https://www.googleapis.com/auth/gmail.compose` |
| 发送邮件 | `https://www.googleapis.com/auth/gmail.send` |
| 编辑 Google Docs | `https://www.googleapis.com/auth/documents` |
| 编辑 Google Sheets | `https://www.googleapis.com/auth/spreadsheets` |
| 编辑 Google Slides | `https://www.googleapis.com/auth/presentations` |
| 管理日历事件 | `https://www.googleapis.com/auth/calendar.events` |
| 归档邮件或修改标签 | `https://www.googleapis.com/auth/gmail.modify` |

`gmail.compose` 在 Google 侧也允许发送；平台行动权限覆盖的路径决定 Unprompted 可以调用哪些接口。选择 `/` 会覆盖所有 Google API 路径。原有专用 Gmail 发送和 Docs 修改流程还需要各自的行动设置。只保存草稿可以另在**创建工作成果**中授权草稿箱。

发行方必须先在 Google 配置并申请适用的权限；工作账号还可能受管理员策略约束。如果授权页没有需要的权限或提示应用未获批准，请联系发行方或组织管理员。

## 搜索和断开

**搜索 Google**可以搜索 Gmail，或按名称搜索文档；结果不会自动创建任务。**断开连接**停止新的观察并保留本机历史；**断开并清除本机副本**还会删除本地副本，不删除 Google 原件。

其他来源的步骤见[连接器](connectors.md)。环境明确设置 `UNPROMPTED_SHADOW_MODE=true` 时，对外写入仍被禁止。
