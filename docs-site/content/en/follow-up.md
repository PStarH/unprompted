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

## Optional funds limit

A time or task lease can include a finite transaction allowance for work that may move money. It is off by default: the cap is zero. In the optional funds controls, confirm one currency, a cumulative amount and an independent finite expiry. UI amounts use currency units; the API uses integer micros (1,000,000 micros = one currency unit). A time allowance's money expiry cannot outlast its time lease. Task allowances also need a finite money expiry, defaulting to 60 minutes within 1–1440. Renewing or revoking a lease, or restarting, does not reset consumed spending or unknown holds.

The allowance does not grant a provider, destination or tool, and it does not supply a price. A paid platform or MCP action needs a separate confirmed contract that maps the exact amount and currency fields to the allowance. Missing or mismatched fields and unsupported currencies are rejected, and there is no automatic currency conversion. An accepted response without independent financial readback keeps the amount held as unknown; it is not a refund and the action is not retried blindly.

Model token and fee limits are separate. They are configured in model settings by workspace or task, with daily UTC windows and prices you confirm. Missing prices or usage are not treated as zero cost. See [Models](models.md).

## What still has to pass

The lease can send a prepared reply or apply a prepared document patch. It does not open a new destination, and it does not grant a connector write. With a transaction allowance, it can also bound a separately authorized paid platform or MCP action.

A paused task, or a task waiting on another review or a fresh read, does not run on its own. If the provider result is uncertain, the task shows **Automatic action paused** and that attempt is not retried blindly.

## API

`POST /api/autonomy`

```json
{ "mode": "time", "durationMinutes": 30 }
```

```json
{ "mode": "task", "taskId": "TASK_ID" }
```

```json
{
  "mode": "time",
  "durationMinutes": 30,
  "money": {
    "currency": "USD",
    "capMicros": 1000000,
    "durationMinutes": 20,
    "confirmed": true
  }
}
```

This configures an allowance; it does not send a payment or grant tool access. The response contains `grant` and `state`. A new lease of the same mode and task replaces the previous one. Repeated grants for the same scope and currency share cumulative accounting; renewal, expiry and restart do not reset spending or unknown holds. A time lease and a task lease can both be active. `POST /api/autonomy/GRANT_ID/revoke` stops that lease. `GET /api/state` includes `autonomy.enabled` and the active grants.

Invalid input returns **400**. In shadow mode the error text is `YOLO requires write mode.`
