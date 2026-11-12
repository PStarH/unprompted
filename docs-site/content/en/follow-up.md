---
title: Automatic follow-up
description: When Unprompted may send or apply a prepared change without another click, and what that still cannot skip.
---

The default is still one approval at a time. Automatic follow-up is a lease you start yourself. It removes later clicks. It does not skip evidence, permissions, or a readback.

Shadow mode hides these controls and refuses the request. An explicit `UNPROMPTED_SHADOW_MODE=true` blocks external writes, and the connector still needs its own grant. See [Permissions and privacy](permissions.md).

## Two different switches

**Send & allow future follow-ups** is on a prepared reply. It sends this reply and records a standing agreement for that scope. Settings lists them under **Your standing agreements**. **Ask me each time** ends the agreement. It does not recall a reply already sent.

**Timed automatic follow-up** is separate.

- **Follow this automatically** covers one task until that task is completed, cancelled, or dismissed. Reopening the task does not bring the lease back.
- **Start timed follow-up** covers this workspace, including tasks found while it is on. Enter 1–1440 minutes. The field starts at 30. The deadline you set survives a restart.

An active lease is shown above the workspace. **Stop automatic follow-up** ends it. A write the provider already accepted is not undone.

A model reply cannot create either lease.

## What still has to pass

The lease can send a prepared reply or apply a prepared document patch. It does not open a new destination, and it does not grant a connector write.

A paused task, or a task waiting on another review or a fresh read, does not run on its own. If the provider result is uncertain, the task shows **Automatic action paused** and that attempt is not retried blindly.

## API

`POST /api/autonomy`

```json
{ "mode": "time", "durationMinutes": 30 }
```

```json
{ "mode": "task", "taskId": "TASK_ID" }
```

The response contains `grant` and `state`. A new lease of the same mode and task replaces the previous one. A time lease and a task lease can both be active. `POST /api/autonomy/GRANT_ID/revoke` stops that lease. `GET /api/state` includes `autonomy.enabled` and the active grants.

Invalid input returns **400**. In shadow mode the error text is `YOLO requires write mode.`
