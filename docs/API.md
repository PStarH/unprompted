# Local API

[← Documentation](README.md)

Base URL: `http://127.0.0.1:4173`. The API has no authentication and is intended
for local use only. POST bodies must be JSON with `Content-Type:
application/json`. A browser's cross-origin write is refused. The engine still
checks permissions and current evidence on every action.

## Inspect the workspace

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Mode, shadow policy, provider and schema status |
| GET | `/api/runtime` | Connector state, missing configuration and simulation availability |
| GET | `/api/state` | Events, tasks, evidence, documents, outbox and history |
| GET | `/api/stream` | Server-sent state updates |
| GET | `/api/metrics` | Metrics derived from recorded outcomes |
| GET | `/api/trace?taskId=TASK_ID` | One task's decision chain; omit `taskId` for recent entries |
| GET | `/documents/DOCUMENT_ID` | Built-in simulated document view |

Read `/api/state` for real IDs and response shapes. Don't post its output from a
connected real workspace into an issue: it may contain personal content.

## Replay the simulation

```sh
curl -X POST http://127.0.0.1:4173/api/demo/restart -H "Content-Type: application/json" -d "{}"
```

A JSON body with `"scenario": "beacon"` selects the alternative reliability-report
scenario; `northstar` is the default. Replay resets the simulated workspace.
Replay and `POST /api/simulation/events` are refused when simulation is disabled
or the state holds recorded real events.

Synthetic event injection accepts the event shape used in
`src/connectors/simulated.js`; the API stamps the simulated source itself.

## Sync connectors

```sh
curl -X POST http://127.0.0.1:4173/api/connectors/sync -H "Content-Type: application/json" -d "{}"
```

Use this for a one-off live pull when automatic polling is disabled. Review
connector status and errors; a failure must not be interpreted as a simulated
success. [Google setup →](LIVE_INTEGRATION.md)

## Actions and feedback

Use an ID from `/api/state` in place of `TASK_ID`; URL-encode it when constructing
a URL in code.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/tasks/TASK_ID/approve` | Recheck evidence/policy and execute a prepared action if permitted |
| POST | `/api/tasks/TASK_ID/reject` | Reject a prepared action |
| POST | `/api/tasks/TASK_ID/reconcile` | Check what happened to an uncertain action |
| POST | `/api/tasks/TASK_ID/retry` | Retry only when confirmed absence permits it |
| POST | `/api/tasks/TASK_ID/cancel` | Close a waiting request |
| POST | `/api/tasks/TASK_ID/feedback` | Record `label` and optional `reason` |
| POST | `/api/misses` | Record `note` and optional `sourceHint` without creating work |

Feedback labels include `useful`, `not_useful`, `wrong_association`, `noise`, and
`awaiting_evidence`. Direct API approval cannot bypass shadow mode, invalid task
states, stale evidence, or authorization checks.

## Context and decisions

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/calibrations` | `key`, `value`, optional `kind`, `scope`, `instruction` (`correct` for a correction) |
| POST | `/api/clarifications/ID/answer` | `value` |
| POST | `/api/opportunities/ID/accept` | `{}`; records a decision, starts no work |
| POST | `/api/opportunities/ID/dismiss` | Optional `note` |
| POST | `/api/notifications/read` | Optional `ids`; omitted to mark current notifications |

See `server.js` for request validation and `test/api.test.js` for concrete
success/refusal examples. This prototype's API may evolve before 1.0.
