---
title: Local API
description: Inspect state, connect a model, sync sources, approve work, and call the local HTTP surface.
---

## Boundary

Base URL: the address printed by the launcher, normally `http://127.0.0.1:4173`.

- The API has **no authentication** and is for local use only.
- POST bodies must be JSON with `Content-Type: application/json`.
- Cross-origin browser writes are refused. Origin checks are not a login.
- The engine still checks permissions, current evidence, and review versions on every action.
- The API may evolve before 1.0. Read `server.js` and `test/api.test.js` for exact validation.

Never expose the port to a network or paste `/api/state` output from a real workspace into an issue.

## Inspect

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Mode, shadow policy, provider and schema status |
| GET | `/api/runtime` | Connector state, missing configuration, simulation availability |
| GET | `/api/setup` | Redacted model/source status, local scopes, OAuth sessions, observation settings |
| GET | `/api/state` | Events, tasks, evidence, documents, outbox, history |
| GET | `/api/stream` | Server-sent full-state snapshots |
| GET | `/api/metrics` | Metrics derived from recorded outcomes |
| GET | `/api/trace?taskId=TASK_ID` | One task's decision chain, or recent entries |
| GET | `/api/durable` | SQLite configuration and bounded job metadata |
| GET | `/api/artifact-grants` | Authorized creation destinations |

Example:

```sh
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/runtime
```

## Model connection

`POST /api/setup/model` accepts:

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "model": "your-model-id",
  "apiKey": "your-key",
  "harness": "classic"
}
```

It makes a real structured request with invented content. A failure does not save a candidate. A success activates primary interpretation without restart. Leaving the key absent preserves a saved key only when the endpoint is unchanged.

`POST /api/setup/model/forget` removes the local connection. A running request returns `MODEL_BUSY`; environment-managed configuration returns `MODEL_ENV_CONFIGURED` and stays under environment control. `GET /api/setup` exposes `hasApiKey` but never the key.

## Sync and search

```sh
curl -X POST http://127.0.0.1:4173/api/connectors/sync \
  -H "Content-Type: application/json" -d "{}"
```

Use this for a one-off live pull when automatic polling is off. Review connector status; a failure is not a simulated success.

Google search is explicit and read-only:

```sh
curl -X POST http://127.0.0.1:4173/api/connectors/google/search \
  -H "Content-Type: application/json" \
  -d '{"source":"gmail","query":"subject:proposal","limit":20}'
```

Use `"source":"drive"` for Doc names. `limit` is 1–25; pass the returned `nextPageToken` as `pageToken`. Gmail text is capped at 16,000 characters. Results are untrusted, are not automatically ingested, and are not unrestricted model tools.

## Review and actions

Use a real task ID from `/api/state`; URL-encode IDs in code.

```sh
curl -X POST http://127.0.0.1:4173/api/tasks/TASK_ID/approve \
  -H "Content-Type: application/json" \
  -d '{"reviewToken":"COPY_THE_CURRENT_TASK_REVIEW_TOKEN"}'
```

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/tasks/TASK_ID/approve` | Recheck and execute a prepared action if permitted |
| POST | `/api/tasks/TASK_ID/reject` | Reject a prepared action |
| POST | `/api/tasks/TASK_ID/reconcile` | Check an uncertain external outcome |
| POST | `/api/tasks/TASK_ID/retry` | Retry only when confirmed absence permits it |
| POST | `/api/tasks/TASK_ID/cancel` | Close a waiting request |
| POST | `/api/tasks/TASK_ID/reopen` | Restore a declined or closed request and recheck evidence |
| POST | `/api/tasks/TASK_ID/pause`, `/resume` | Persist or clear a user pause |
| POST | `/api/tasks/TASK_ID/direction` | Add or replace a task direction, then recheck |
| POST | `/api/tasks/TASK_ID/wait` | Persist a document, reply, or time wait |
| POST | `/api/tasks/TASK_ID/feedback` | Record a label and optional reason |
| POST | `/api/tasks/TASK_ID/patch/prepare` | Prepare a versioned document patch |
| POST | `/api/tasks/TASK_ID/patch/apply` | Apply a reviewed patch, then read back |

If the source, guidance, or destination changed, approval returns **409** with `code: "REVIEW_CHANGED"` before any send. Fetch current state and review again. The review token grants no permission and does not replace evidence or delivery verification.

Mutation during a workspace transition returns **409 `WORKSPACE_CONNECTING`**. Durable-only routes return **409 `DURABLE_WORKSPACE_REQUIRED`** in the transient demo.

## Standing goals and artifacts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/standing-intents` | Saved standing goals and versions |
| POST | `/api/standing-intents` | Create a goal; `confirmed:true` and a bounded scope required |
| POST | `/api/standing-intents/:id` | Update with `expectedVersion`; invalidates prepared work |
| POST | `/api/standing-intents/:id/pause`, `/resume`, `/disable` | Lifecycle with `expectedVersion` |
| POST | `/api/tasks/:id/prepared-work/accept` | Accept a prepared local draft; performs no provider write |
| POST | `/api/tasks/:id/prepared-work/retry` | Retry active preparation; paused or stale work returns 409 |
| POST | `/api/artifact-grants` | Authorize an exact creation destination with `confirmed:true` |
| POST | `/api/tasks/:id/artifacts` | Queue artifact creation under a grant; 202, not verified |

Standing goals support observe and prepare. They prohibit external writes even when an unrelated destination grant exists. Acceptance records `completion.external:false` and keeps the goal active for future events.

## Autonomy

```sh
curl -X POST http://127.0.0.1:4173/api/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode":"time","durationMinutes":30}'
```

Create a task lease with `{"mode":"task","taskId":"TASK_ID"}`. The response contains `{grant,state}`. Revoke with `POST /api/autonomy/:id/revoke`. Time and task leases can coexist. Invalid scopes or durations return 400. YOLO still cannot bypass shadow mode, stale evidence, pauses, or destination grants.

## MCP

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mcp` | Redacted server status, tools, and read grants |
| POST | `/api/mcp/import` | Save and connect an `mcpServers` object |
| POST | `/api/mcp/servers/:id` | Update enabled state, read tools, reconnect, or remove |

Secrets are never echoed. Routes are refused in the disposable demo. A failed connection is saved with a sanitized error so it can be corrected.

## Privacy

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/privacy/preview` | Dependency counts before deletion |
| POST | `/api/privacy/forget` | Remove a supported local root and dependent work |
| GET | `/api/privacy/requests/:id` | Deletion, WAL, backup, and external-retention state |
| POST | `/api/privacy/requests/:id/retry` | Recheck remaining retention without reimporting content |

Supported roots include event, situation, task, memory, task_memory, task_direction, experience, artifact, policy, feedback, and outcome. Forget does not erase independent provider copies.

## Stream and errors

`/api/stream` carries full snapshots. Under backpressure, intermediate pending snapshots may be replaced by the latest; consumers should use the current snapshot and history. Connection or size limits can return 503; reconnecting is safe and does not re-execute work.

Common statuses:

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON, target, or body shape |
| 202 | A queued job, not a completed external write |
| 409 | Conflict such as `REVIEW_CHANGED`, `WORKSPACE_CONNECTING`, `STATE_LOCKED`, or `DURABLE_WORKSPACE_REQUIRED` |
| 413 | Body over the transport limit |
| 408 | Body receive timed out |
| 503 | Stream or service limit reached; reconnect may be safe |

For the full route surface, read [`docs/API.md`](https://github.com/PStarH/unprompted/blob/main/docs/API.md) and `server.js`. For execution design, read [Architecture](architecture.md).
