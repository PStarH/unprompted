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
source-backed document-patch adapters. It does not add new write adapters or
grant provider access. Artifact destination grants and read-only MCP tools keep
their existing boundaries. Unknown delivery outcomes still require
reconciliation and are never automatically retried.

## API

Create a workspace lease with `POST /api/autonomy`:

```json
{ "mode": "time", "durationMinutes": 30 }
```

Create a task lease using the same endpoint:

```json
{ "mode": "task", "taskId": "request:m1" }
```

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
