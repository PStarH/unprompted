# Temporary YOLO authorization

YOLO lets a user authorize automatic approval for a task or a limited period.
The default remains individual approval. The controls appear in a prepared
reply, task follow-up settings, and Settings under standing agreements.

- **Task YOLO** covers one task until it completes, is cancelled, is declined,
  or becomes unavailable. Reopening a closed task does not restore its lease.
- **Time YOLO** covers the current workspace, including tasks discovered during
  that period. Choose 1–1440 minutes; the default in the interface is 30 minutes.
  The original deadline survives a server restart.

An active authorization appears above the workspace with a Revoke button.
Revocation stops operations that have not yet been dispatched; it cannot undo
an operation already accepted by a provider. Revoke, expiry, and replacement
cancel undispatched `intent` rows for that lease in the same stored update.
Expiration is checked again at dispatch.

A standing send agreement for a named scope is a credential only when
`AuthorityGate.decide` loads it and the effect is in that scope. It does not
bypass the execution gate. A time lease also approves prepared mail and
source-backed document patches, not only MCP or platform writes. After you
attest that a live attempt is absent from Sent, YOLO will not send the
replacement; that draft needs a direct approval.

The execution layer checks the stored user authorization. A model response or
tool argument cannot create a lease. Actions retain their existing source,
payload, version, privacy, connection, and verification checks. Paused tasks and
tasks requiring review of changed guidance do not automatically proceed.
Shadow mode refuses YOLO writes.

Automatic approval currently drives the existing prepared mail-send and
source-backed document-patch adapters. A transaction allowance can also constrain
a separately authorized paid platform or MCP tool. It does not add new write adapters or
grant provider access. Artifact destination grants and read-only MCP tools keep
their existing boundaries. Unknown delivery outcomes still require
reconciliation and are never automatically retried.

## Funds limits

Remote transaction allowances are separate from model/API fees. Their default
cap is zero. In the optional funds controls, confirm a currency, a cumulative
amount and a finite expiry. UI amounts use currency units; API amounts use
integer micros (1,000,000 micros = one currency unit). Positive caps require the
native durable workspace and explicit confirmation; a model, Memory or Experience
cannot issue one.

A time allowance's money expiry cannot outlast its time lease. Task allowances
also have finite money expiry: the default is 60 minutes, configurable within
1–1440 minutes. Completing or cancelling the task still ends its authority.
Renewing or revoking a lease, or restarting, does not reset consumed funds or
unknown holds. The interface reports remaining and unknown amounts. Revocation
or expiry blocks new dispatch; it cannot reverse an already dispatched effect.

A funds cap alone does not grant a provider, destination or tool. Paid platform
and MCP actions require a separate confirmed contract mapping the exact amount
in micros and currency fields to the allowance; MCP contracts also bind the
current schema and connection identity. Missing or mismatched fields are rejected.
There is no automatic currency conversion. An accepted response without independent
financial readback retains an unknown hold and never authorizes blind retry.

Model Token and fee limits are configured separately in model settings, by
workspace or task, with daily UTC windows. Their optional limits, confirmed prices
and unknown usage do not change a transaction allowance. Missing prices or usage
are not treated as zero cost.

## API

Create a workspace lease with `POST /api/autonomy`:

```json
{ "mode": "time", "durationMinutes": 30 }
```

Create a task lease using the same endpoint:

```json
{ "mode": "task", "taskId": "request:m1" }
```

For a confirmed USD 1 cumulative transaction cap lasting 20 minutes within a
30-minute time lease:

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

This configures an allowance; it does not send a payment or grant tool access.

The response contains `{ "grant": { ... }, "state": { ... } }`. Creating a
replacement for the same mode and task revokes the old lease, including queued
operations bound to its ID. Time and task leases can coexist.

Revoke a lease with `POST /api/autonomy/:id/revoke`. The response contains the
updated state. `GET /api/state` includes `autonomy.enabled` and the currently
active `autonomy.grants`. Invalid scopes and durations return HTTP 400.

## Validation

Run `node --test test/autonomy.test.js` for scope, expiration, revocation,
restart persistence, and JSON/SQLite execution coverage. The browser flow in
`test/browser/autonomy.mjs` verifies the task action, a custom duration, reload,
the persistent status indicator, and revocation.
