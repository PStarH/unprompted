---
title: Local API
description: The localhost HTTP API for inspecting the workspace, connecting a model, and reviewing work.
---

Base URL is the address printed at startup, usually `http://127.0.0.1:4173`. There is no authentication. POST bodies are JSON with `Content-Type: application/json`. A browser cross-origin write is refused. Do not expose the port.

The lists below are the everyday routes. Request bodies and the rest of the durable surface are specified in [docs/API.md](https://github.com/PStarH/unprompted/blob/main/docs/API.md).

## Inspect

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Mode, shadow policy, provider, and schema |
| GET | `/api/runtime` | Connectors, missing configuration, and simulation state |
| GET | `/api/setup` | Redacted model and source status. No secrets |
| GET | `/api/state` | Events, tasks, evidence, documents, and history |
| GET | `/api/stream` | Server-sent workspace snapshots |
| GET | `/api/trace?taskId=TASK_ID` | One task's decision chain |

`/api/state` from a real workspace can contain personal content. Do not paste it into an issue.

## Model

`POST /api/setup/model` accepts `baseUrl`, `model`, an optional `apiKey`, and `harness` (`classic` or `pi`). It performs the same real verification as the form. A failure does not save the candidate. `POST /api/setup/model/forget` removes the saved connection. A running request returns `MODEL_BUSY`. A launch-environment configuration returns `MODEL_ENV_CONFIGURED` and stays under that environment.

## Model controls

`GET /api/model-controls?taskId=TASK_ID` returns UTC-day token limits and settled/reserved/unknown usage, model-fee limits and per-currency usage, current price versions, and `money.unpricedCalls`. Omit `taskId` for the workspace. Unpriced calls have unknown fees; they are not reported as free, and unknown outcomes retain their original ledger holds.

Persistent workspaces accept these same-origin JSON POST routes:

- `POST /api/model-controls/token-limit`: `{scope, taskId?, tokens}`. An explicit `null` disables a limit; `0` blocks new spending.
- `POST /api/model-controls/money-limit`: `{scope, taskId?, currency, micros, expectedVersion}`. Amounts are safe integer micro-currency units; `null` disables a limit. Active workspace and task limits require matching currencies.
- `POST /api/model-controls/price-profile`: `{connection?, currency, revision, rates:{input,output,cacheRead,cacheWrite}, expectedVersion, confirmed:true}`. Rates are explicit safe integers in micro-currency per million tokens. A stale version returns a safe `currentProfile` for review.
- `POST /api/model-controls/routing`: `{expectedVersion, config, requestCallLimit, maxRpcAttempts}`. `config` contains `modelIds`, `defaultModel`, a `stages` map (`interpret`, `discovery`, `planning`, `verification`, `general`) and optional `fallbackModel`; `config:null` disables the group.
- `GET /api/model-controls/routing` returns the saved group, version and classic call cap.

These are local settings. A routing group is bounded dispatch configuration, not a quality evaluation; confirmed prices are estimates, not a promise of savings.

## Review

Tasks with a prepared draft expose a `reviewToken`. The approval body sends that exact token. If the draft or its input changed, the response is **409** and the old token is not accepted. Repeating an already accepted token is idempotent. Acceptance records a local decision. It is not itself a provider write.

`POST /api/privacy/preview` counts what a deletion would touch. `POST /api/privacy/forget` with `kind` and `id` removes the local derived data and reports anything still retained. It does not erase the provider's copy.

## Automatic follow-up

`POST /api/autonomy` accepts `{ "mode": "time", "durationMinutes": 30 }` or `{ "mode": "task", "taskId": "TASK_ID" }`, with optional `money: { "currency": "USD", "capMicros": 1000000, "durationMinutes": 20, "confirmed": true }`. The default funds cap is zero. Positive caps need `confirmed: true` and a persistent workspace; amounts are integer micros in an explicit USD/CNY/EUR currency, with no conversion. Money permission cannot outlast a time lease, and repeated grants for the same scope and currency share cumulative accounting: renewal, expiry and restart do not reset spending or unknown holds. A funds cap grants no tool, account or target permission and supplies no price. Model and API fees use the separate model controls above. The response contains `grant` and `state`. A new lease of the same mode and task replaces the previous one. Time and task leases can both be active. `POST /api/autonomy/GRANT_ID/revoke` stops that lease. `GET /api/state` includes `autonomy.enabled` and the active grants. Invalid input returns **400**. Shadow mode rejects the call with `YOLO requires write mode.` The behavior is on [Automatic follow-up](follow-up.md).

`POST /api/tasks/TASK_ID/feedback` takes `label`: `useful`, `not_useful`, `not_mine`, `duplicate`, `already_handled`, or `wrong_association`. A duplicate also needs `relatedTaskId`. `POST /api/feedback/FEEDBACK_ID/undo` withdraws a correction. None of these send mail. `POST /api/misses` with a `note` records work you saw and the app did not. It does not create a task. An empty note is refused.

## Sources

Local folder and Notes selection, removal, and forget are under `/api/setup/local-sources/`. Picker cancellation does not change a saved grant. `GET /api/local-sources/documents/:id` returns fresh text or an explicit failure.

Connector sync and OAuth routes follow the same permission checks. A route that queues work returns **202** with a job. It is not a verified write. The durable workspace returns **409** `DURABLE_WORKSPACE_REQUIRED` for those operations during the JSON demo.

Standing goals, experiences, policies, and artifact grants are in the repository API document. Creating a goal or a destination grant requires `confirmed: true`. None of them grants a connector write by itself.
