# Local API

[← Documentation](README.md)

These local-source endpoints manage read access; they do not modify source
content:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/setup/local-sources/{local_files,apple_notes}/select` | Open the macOS picker; optional `locale` and `observe` (default true). Local files also accept an absolute `path` for other platforms. |
| POST | `/api/setup/local-sources/{local_files,apple_notes}/remove-scope` | Remove the selected folder by `id` from the current public setup response; invalidate its evidence. |
| POST | `/api/setup/local-sources/{local_files,apple_notes}/forget` | Disconnect this local source and invalidate its evidence. |
| GET | `/api/local-sources/documents/:id` | Revalidate scope and return fresh source text as `text/plain`; unavailable or revoked documents fail explicitly. |

`GET /api/setup` includes `localSources`: platform availability, selected folder
labels, connection health and document/task counts. Absolute folder paths and
Notes account identifiers stay in the private setup store. Picker cancellation
does not change saved grants. Notes has no write operation. Its native macOS
permission flow still requires real-account acceptance.

Base URL: the address printed by the launcher, normally `http://127.0.0.1:4173`.
The API has no authentication and is intended
for local use only. POST bodies must be JSON with `Content-Type:
application/json`. A browser's cross-origin write is refused. The engine still
checks permissions and current evidence on every action.

## Inspect the workspace

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Mode, shadow policy, provider and schema status |
| GET | `/api/runtime` | Connector state, missing configuration and simulation availability |
| GET | `/api/setup` | Redacted model/source status, selected local scopes, OAuth sessions and observation settings |
| GET | `/api/state` | Events, tasks, evidence, documents, outbox and history |
| GET | `/api/stream` | Server-sent state updates |
| GET | `/api/metrics` | Metrics derived from recorded outcomes |
| GET | `/api/trace?taskId=TASK_ID` | One task's decision chain; omit `taskId` for recent entries |
| GET | `/documents/DOCUMENT_ID` | Built-in simulated document view |

## Durable workspace (v0.3)

These operations require the persistent SQLite workspace (409
`DURABLE_WORKSPACE_REQUIRED` in the explicit JSON demonstration). All write
operations use the same origin checks as task actions. None grants connector
permissions.

| Method | Path | Purpose / body |
| --- | --- | --- |
| GET | `/api/durable` | Actual SQLite configuration, bounded job metadata, retrieval/context/attention/learning settings |
| GET | `/api/artifact-grants` | Authorized creation destinations, account availability and existing grants |
| POST | `/api/artifact-grants` | `connectorId` (`google`, `microsoft`, `notion`, `apple_notes`), exact `targetId`, `confirmed:true`, optional `project`, `taskId`, `automatic` (default true); authorizes creation in that account and destination |
| POST | `/api/artifact-grants/:id/revoke` | Stop future creation under that grant; dispatched outcomes still require reconciliation |
| POST | `/api/tasks/:id/artifacts` | `grantId`, exact `reviewToken`, plus `title` and `body` for pages/notes; mail uses the task's prepared reply. Returns 202 and a queued request, not a verified write |
| GET | `/api/situations` | Bounded list of active evidence-backed Situations; tasks expose their `situationId` when linked |
| POST | `/api/situations/:id/probe` | Schedule a scoped Gmail reply check with `sourceEventId` and `scheduledAt`. The source must already be linked to the Situation; existing connector permissions and fresh sync coverage still apply. |
| GET | `/api/policies` | Explicit rules, status and optimistic `version` |
| POST | `/api/policies` | `instruction`, typed `predicate`, structured `effect`, optional scope/identities. Updates require `id` and `expectedVersion`. Unresolved identities remain draft. |
| POST | `/api/policies/:id/disable` | `expectedVersion`; invalidate Hot Context atomically |
| POST | `/api/instructions` | `text`, `kind:"fact"` (default) or `"policy"`, scope. A policy can supply `policy:{predicate,effect}` and confirmed `identities`. Ambiguity returns `needs_clarification`. |
| GET | `/api/experiences` | Structured Experiences, provenance-based status and evidence counts |
| POST | `/api/experiences/:id/trial` | Existing `taskId`, exact `reviewToken`; prepare a scoped format trial for review, without sending |
| POST | `/api/experiences/:id/promote` | `expectedRevision`; still requires narrow low-risk eligibility and independent verified successes |
| POST | `/api/experiences/:id/retire` | `expectedRevision`; stop retrieving this Experience |
| POST | `/api/experiences/policy` | `expectedVersion` plus bounded learning thresholds or `autoPromote` (default false) |
| POST | `/api/experiences/attention-policy` | Bounded interruption limits and `quietHours:{startHour,endHour,timeZone}` (or null) |
| POST | `/api/experiences/context-policy` | Bounded clustering windows, event and association limits |
| POST | `/api/experiences/retrieval-policy` | `expectedVersion` and bounded retrieval ranking weights |
| POST | `/api/experiences/replay` | Up to 100 labeled `cases:[{query,relevantIds,scopes?}]`, optional options; retain aggregate offline metrics, execute no tools |
| POST | `/api/tasks/:id/draft` | `body`, exact `reviewToken`; capture a minimal artifact revision and invalidate old review tokens |
| POST | `/api/executions/:id/reconcile` | Read the provider to resolve a prior intent; an inconclusive result never enables a write |
| POST | `/api/privacy/preview` | `kind`, `id`; return dependency counts before deletion |
| POST | `/api/privacy/forget` | `kind`, `id`; cancel dependent work and remove derived local data, return `{deletion,state}` |
| POST | `/api/privacy/requests/:id/retry` | Recheck remaining backup/WAL/external retention without reintroducing deleted content |
| GET | `/api/privacy/requests/:id` | Actual deletion state and remaining retention/reconciliation |

Supported Forget roots are event, situation, task, memory, task_memory, task_direction,
experience, artifact, policy, feedback and outcome. The request reports local
cleanup, WAL reader delays, registered backup deletion and pending external
operations. It does not erase independent connector/model-provider copies.
“Do not do this again” belongs in an explicit suppression policy, separately
from Forget. See [the requirements](PRD.md) and [storage boundaries](ARCHITECTURE.md#storage-and-process-model).

## External MCP client

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mcp` | Redacted server status, discovered tools and read grants |
| POST | `/api/mcp/import` | Save and connect `config` (`mcpServers` object or JSON string); optional `allowDeclaredRead` grants server-declared read tools |
| POST | `/api/mcp/servers/:id` | Update `enabled`, `allowDeclaredRead`, `readTools` (array), `reconnect:true` or `remove:true` |

`GET /api/setup` also includes `mcp`. Import/update returns `{mcp, setup}`.
A failed connection is saved with `status:"failed"` and a sanitized `lastError`,
so the user can correct or reconnect it. Invalid config fails with 400; concurrent
MCP updates fail with 409. Secrets are never echoed. These routes are refused in
the disposable demo. Configuration is private to the local installation, while
call records (`task.mcpCalls`, at most 20) belong to the task's workspace.
Native follow-up tasks may also retain a bounded `mcpInvestigation` suggestion;
it is not verified completion or an external action. Known write tools are blocked.

## Model connection

`POST /api/setup/model` accepts `baseUrl`, `model`, optional `apiKey`, and
`harness` (`classic` or `pi`). It makes a real structured request with invented
content. Provider/authentication/structure failures do not save a candidate.
A successful check stores it in private local setup and activates primary
interpretation without a service restart. Leaving the key absent preserves a
saved key only when the endpoint is unchanged. A changed endpoint never inherits
another provider's key.

`POST /api/setup/model/forget` removes the locally saved model connection. A
running model request returns `MODEL_BUSY`; launch-environment configuration
returns `MODEL_ENV_CONFIGURED` and remains controlled by that environment.
`GET /api/setup` exposes redacted model settings, a `hasApiKey` boolean and
verification/runtime status. Neither it nor workspace/SSE responses returns keys.

Primary interpretation records a source-grounded model review before readiness.
An original verifiable requirement cannot be removed by the model. Model setup
does not grant real-world write permissions or start sample events. Connect at
least one [source](CONNECTORS.md) to supply actual workspace context.

Normal product mode with no model blocks action readiness. Explicit
`UNPROMPTED_RULE_ONLY=true` is available for rule-only API/engine fixtures;
`npm run demo` remains the separate disposable rule example.

## Review and recovery

Read `/api/state` for real IDs and response shapes. Don't post its output from a
connected real workspace into an issue: it may contain personal content.

Tasks with a prepared draft expose a `reviewToken`. The web interface sends it
in the JSON body when approving, including the send-and-allow-future flow:

```json
{ "reviewToken": "COPY_THE_CURRENT_TASK_REVIEW_TOKEN" }
```

If the prepared reply or its request version changed, approval returns **409**
with `code: "REVIEW_CHANGED"` before any send. Fetch the current state and review
the updated reply. Unrelated workspace changes do not invalidate the token.
Existing clients may omit it to retain the original approval behavior; they do
not receive this additional review protection. The token grants no permission
and does not replace evidence, policy or delivery verification.

Tasks may include a persisted `reasoningWork` record. Failed read-only jobs now
report `failureKind`, `retryable`, `retryAt` and `terminalReason` alongside their
request version and attempt ceiling. Grounded-discovery jobs expose the same
recovery fields on the originating event's `reasoning` record. A due time is
eligibility for a bounded maintenance pass, not a promised completion time.
This policy does not retry external writes. See the
[whole-work harness design](ARCHITECTURE.md#storage-and-process-model) for lifecycle and recovery boundaries.

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
success. [Connector setup →](CONNECTORS.md)

`POST /api/connectors/google/search` performs an explicit, read-only search in
the currently connected Google account. For example:

```sh
curl -X POST http://127.0.0.1:4173/api/connectors/google/search \
  -H "Content-Type: application/json" \
  -d '{"source":"gmail","query":"subject:proposal","limit":20}'
```

Use `source: "drive"` to search Google Doc names. `limit` is 1–25; provide the
returned `nextPageToken` as `pageToken` to continue the same search. Gmail
results contain message text capped at 16,000 characters; Docs results contain
metadata and an official Docs link. Results are untrusted content, are not
automatically ingested, and are not available as unrestricted model tools.
Search is refused if the source is disconnected, its read scope is disabled, or
authorization changes while the request is being prepared.

## Actions and feedback

Use an ID from `/api/state` in place of `TASK_ID`; URL-encode it when constructing
a URL in code.

`/api/stream` carries full snapshots. Under backpressure the server may replace
intermediate pending snapshots with the latest state. Consumers should use the
current snapshot/history rather than assume delivery of every revision. Stream
connection or size limits can return 503; reconnecting is safe and does not
re-execute a task. Invalid JSON targets/bodies return 400, oversized bodies 413
and receive-timeout failures 408. See [transport limits](CONFIGURATION.md#http-transport-limits).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/tasks/TASK_ID/approve` | Recheck evidence/policy and execute a prepared action if permitted |
| POST | `/api/tasks/TASK_ID/reject` | Reject a prepared action |
| POST | `/api/tasks/TASK_ID/reconcile` | Check what happened to an uncertain action |
| POST | `/api/tasks/TASK_ID/retry` | Retry only when confirmed absence permits it |
| POST | `/api/tasks/TASK_ID/cancel` | Close a waiting request |
| POST | `/api/tasks/TASK_ID/reopen` | Restore a declined or closed request and recheck current evidence, without sending |
| POST | `/api/tasks/TASK_ID/pause` | Persist a user pause; stop task assessment and new external execution |
| POST | `/api/tasks/TASK_ID/resume` | Resume and recheck current sources without sending |
| POST | `/api/tasks/TASK_ID/direction` | Add user requirements with `{text,scope}`; scope is `task` (default) or `similar` |
| POST | `/api/tasks/TASK_ID/undo-direction` | Undo the current direction with `{id}` and recheck current evidence |
| POST | `/api/memories/MEMORY_ID` | Edit, delete or restore scoped memory with `{operation,text?,version}`; version is its `updatedAt` |
| POST | `/api/tasks/TASK_ID/feedback` | Record `label` and optional `reason` |
| POST | `/api/tasks/TASK_ID/wait` | Persist `kind` (`document`, `reply`, `time`), optional `dependsOn`, `until`, `interruptOnRisk` |
| POST | `/api/tasks/TASK_ID/patch/prepare` | Prepare source-backed changes; `{}` selects current evidence automatically |
| POST | `/api/tasks/TASK_ID/patch/apply` | Apply a reviewed patch with version-bound `authorization`, then read back |
| POST | `/api/feedback/FEEDBACK_ID/undo` | Remove one correction rule's future matching effect |
| POST | `/api/dependencies/DEPENDENCY_ID/resolve` | Record `decision`/`value` and reassess affected tasks |
| POST | `/api/misses` | Record `note` and optional `sourceHint` without creating work |

Feedback labels include `useful`, `not_useful`, `wrong_association`, `noise`, and
`awaiting_evidence`. Direct API approval cannot bypass shadow mode, invalid task
states, stale evidence, or authorization checks.

Task directions are persisted user requirements, not permission grants. They
invalidate the prepared reply and saved verification plan, then recheck evidence.
They supplement the original content requirements; they do not silently replace
the sender, recipient, source identity or original requirements. Unsupported
requirements stay unresolved. Corrected tasks require review before a subsequent
send, including when a standing authorization exists. Tasks with actions already
started cannot be paused or rewritten; verify their result first.

`similar` explicitly saves memory for the exact project and deliverable. Task-only
directions do not create memory. An explicit task direction takes precedence over
shared memory for that task. Deleting memory removes its future matching effect;
the originating task keeps its explicit task-local direction. `/api/state` exposes
these entries as `taskMemories`. Memory writes require the current version.

Scoped corrections use the same feedback route with `label` set to `not_mine`,
`duplicate`, `already_handled`, or `wrong_association`, plus an exact-match
`scope` and optional `relatedTaskId`. Scope selectors are `sender`, `threadId`,
`subjectEntity`, `deliverable` and `documentId`. Ownership corrections require a
thread or multiple selectors; a duplicate requires a compatible existing task.
These corrections do not authorize an external action or assert completion.

Patch preparation returns `{patch,state}`. Optional explicit `changes` contain
`type` (`append`/`insert_after`), `anchor`, `text`, and a versioned `source` quote.
Application takes `{patchId,authorization}`; authorization binds `kind`
(`explicit` or `shadow_read_only`), `taskId`, `patchId`, `baseDocumentVersion`
and `confirmed`. Shadow checking does not change the document. Stale and
uncertain writes cannot be replayed as a fresh application.

A deliberate rejection stays dismissed when evidence changes, including when
a standing send agreement exists. Reopening requires a declined or closed task
without an action record. Completed tasks and uncertain deliveries cannot be
reopened; uncertain delivery must use reconciliation. Reopening reconstructs the
draft from current evidence and suppresses automatic sending for that assessment.

## Context and decisions

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/calibrations` | `key`, `value`, optional `kind`, `scope`, `instruction` (`correct` for a correction) |
| POST | `/api/clarifications/ID/answer` | `value` |
| POST | `/api/opportunities/ID/accept` | `{}`; records the decision and an idempotent owned follow-up, without external execution |
| POST | `/api/opportunities/ID/dismiss` | Optional `note` |
| POST | `/api/notifications/read` | Optional `ids`; omitted to mark current notifications |

See `server.js` for request validation and `test/api.test.js` for concrete
success/refusal examples. This prototype's API may evolve before 1.0.

## Connection setup

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/api/setup/google/client` | `clientJson`; accepts a Desktop OAuth client file |
| POST | `/api/setup/google/authorize` | Requested `scopes`, optional `observe` (default true), `locale`, `allowExternalWrites` (default false); returns Google authorization URL |
| POST | `/api/setup/google/permissions` | Explicit `allowExternalWrites`; saves and immediately applies local write policy |
| POST | `/api/setup/google/validate` | Validate saved authorization using a bounded token refresh |
| POST | `/api/setup/google/forget` | Remove saved account authorization and stop reading/writing; retain the Desktop client for reconnection |
| POST | `/api/setup/monitoring` | `enabled`, optional `intervalMs`; starts immediately when enabled |
| POST | `/api/setup/google/cancel` | Cancel a pending browser authorization |
| POST | `/api/setup/google/activate` | Retry applying saved authorization; optional `observe`, no restart |
| POST | `/api/reasoning/retry` | Retry recoverable model readings of existing work |
| POST | `/api/setup/restart` | Legacy desktop service restart; not needed for Google setup |

These routes return redacted status; saved client secrets and refresh tokens are
never returned. Verified Google identity selects an account-specific store.
Authorization starts observation immediately; the public `workspace` status
includes actual read/discovery counts, pending reasoning and observation outcome.
Mutations during a workspace transition return `WORKSPACE_CONNECTING` (409).
A full environment-managed Google connection cannot be replaced by the setup API.
Read [the connection guide](ONBOARDING.md) for account setup and recovery.

## Additional source connections

`GET /api/setup` includes `connections.github` and `connections.microsoft` with
public Client ID, verified account label, connected/authorized booleans, OAuth
phase, counts and last sync outcome. Access/refresh tokens and the private
device code are never returned. The short user code and trusted verification
URL are exposed only during an active authorization.

| Method | Path | Body / behavior |
| --- | --- | --- |
| POST | `/api/setup/connections/PROVIDER/authorize` | Optional public `clientId`, `observe` (default true); starts official device authorization |
| POST | `/api/setup/connections/PROVIDER/cancel` | Cancels pending authorization without removing an existing connection |
| POST | `/api/setup/connections/PROVIDER/activate` | Applies saved verified credentials without restarting |
| POST | `/api/setup/connections/PROVIDER/forget` | Cancels pending auth, clears tokens and retires that source's active work; other sources remain connected |

`PROVIDER` is `github` or `microsoft`. Poll `GET /api/setup` for `authorizing`,
`verifying`, `connected`, `cancelled`, `expired`, `failed` or `activation_failed`.
The server owns provider polling intervals and refresh-token rotation.

GitHub uses native `issue.updated`, `pull_request.updated`, `content.changed`
and `workflow.updated` events. Tasks keep the repository and source state.
Closing or withdrawing the source stops tracking; it never creates an agent
action receipt. Commits keep changed paths and omit file patches. Outlook uses
account-namespaced email events and cannot select Gmail as its delivery adapter.
