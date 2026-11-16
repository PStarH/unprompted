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

## Memory Space

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/memory-space` | Filter by `q`, `kind`, `scope`, `status`; optional `focus` and `limit` (maximum 500). Returns records, total/truncation and recorded relationships. Each search result includes `match:{reasons,excerpt,score,query}`. Search covers the collection before limiting the response. `status=remembered` includes historical/disabled content but excludes recoverable deletes. |
| GET | `/api/memory-space/:id` | Content, lifecycle, versions, origin, recorded usage and `context:{memories,entities,sources,relations,centerId}`. Optional `depth=1` (default) or `2` reads a bounded local neighborhood, independent of current search filters. |
| POST | `/api/memory-space` | Save `text`/`content`, `memoryKind` (`fact` or `preference`), `scopeType`, `scopeKey` and optional `validUntil`. Requires the persistent workspace. |
| POST | `/api/memory-space/:id` | Version-checked `edit`, `disable`, `reactivate`, `archive`, `restore`, `delete`, `restore-delete`, `supersede`, `restore-version` or `validity`. |
| POST | `/api/memory-space/:id/relations` | `operation: add/remove`, `targetId`, supported `kind`, `expectedVersion`; optional evidence and `status`. Supersession is created only by the correction operation. |

Direct memories use numeric `expectedVersion`. Legacy task-memory mutations use
`expectedVersion`/`version` from the returned record; relationship mutations use
the numeric `version`. Stale writes return 409 `MEMORY_CHANGED`. Deleted and
archived records stay traceable and recoverable. Permanent removal uses the
existing privacy preview/Forget endpoints. Associations never change retrieval
scope or authorize external actions. The disposable demonstration is read-only.

Both Standard and Pi expose task-scoped `search_memories`, `read_memory` and
`update_memory` tools against this same store. Updates require a current task
lease, a version token, and an exact quotation from its recorded source or
current user direction. Changing user-owned memories or lifecycle requires the
user direction; global and unrelated writes and permanent Forget are unavailable
to the model. A successful change returns `requiresReplan:true` and invalidates
the previous context before work continues. Source provenance, version history
and a verified local write receipt are retained together.

Memory detail includes `provenance.usage` for recorded task reads and
`provenance.activationUsage` for context supplied to semantic activation jobs.
These records show consultation, not proof that the memory caused a decision.
Applicable active preferences enter planning independently of keyword overlap.
Activation uses bounded saved context alongside independently grounded current
source evidence; memories do not override explicit policies or grant permission.

## Durable workspace (v0.3)

These operations require the persistent SQLite workspace (409
`DURABLE_WORKSPACE_REQUIRED` in the explicit JSON demonstration). All write
operations use the same origin checks as task actions. None grants connector
permissions.

| Method | Path | Purpose / body |
| --- | --- | --- |
| GET | `/api/durable` | Actual SQLite configuration, bounded job metadata, retrieval/context/attention/learning settings |
| GET | `/api/model-usage` | Record-only token totals for the last 30 days, grouped by provider, protocol and model. This ledger does not influence routing, budgets or completions |
| GET | `/api/artifact-grants` | Authorized creation destinations, account availability and existing grants |
| POST | `/api/artifact-grants` | `connectorId` (`google`, `microsoft`, `notion`, `apple_notes`), exact `targetId`, `confirmed:true`, optional `project`, `taskId`, `automatic` (default true); authorizes creation in that account and destination |
| POST | `/api/artifact-grants/:id/revoke` | Stop future creation under that grant; dispatched outcomes still require reconciliation |
| POST | `/api/tasks/:id/artifacts` | `grantId`, exact `reviewToken`, plus `title` and `body` for pages/notes; mail uses the task's prepared reply. Returns 202 and a queued request, not a verified write |
| POST | `/api/tasks/:id/prepared-work/accept` | Exact `preparedWorkReviewToken` as `reviewToken`; accept the current local standing-goal draft/brief and finish this follow-up. Records one explicit acceptance; performs no provider write |
| POST | `/api/tasks/:id/prepared-work/retry` | Current `inputVersion`; retry an active standing-goal preparation. Returns 202 with `jobId` and `state`; paused, stale or closed work returns 409 |
| GET | `/api/situations` | Bounded list of active evidence-backed Situations; tasks expose their `situationId` when linked |
| GET | `/api/standing-intents` | Saved standing goals and their versions |
| POST | `/api/standing-intents` | `confirmed:true`, `description`, `desiredOutcome`, bounded `prefilter`, optional `predicate`, `scope`, `autonomy`, `budget`, `expiresAt`; external writes remain prohibited |
| POST | `/api/standing-intents/:id` | Complete updated goal plus `expectedVersion`; invalidates prepared work for that goal |
| POST | `/api/standing-intents/:id/pause`, `/resume`, `/disable` | `expectedVersion`; preserves independent user pauses and already dispatched actions |
| POST | `/api/activation/flags` | Known boolean feature switches; queued and in-flight forward work rechecks the relevant generation |
| POST | `/api/activation/rsi/evaluate` | `parameter`, `value`, `datasetVersion`, labeled `cases`; returns a local policy comparison, with no external actions |
| POST | `/api/activation/rsi/propose` | `parameter`, `value`, nonempty `evidence`, exact improving comparison `replayId`; only global scope is supported |
| POST | `/api/activation/rsi/:id/apply`, `/rollback` | `expectedVersion`; rejects stale configurations and rollbacks that would overwrite later settings |
| POST | `/api/situations/:id/probe` | Schedule a scoped Gmail reply check with `sourceEventId` and `scheduledAt`. The source must already be linked to the Situation; existing connector permissions and fresh sync coverage still apply. |
| GET | `/api/policies` | Explicit rules, status and optimistic `version` |
| POST | `/api/policies` | `instruction`, typed `predicate`, structured `effect`, optional scope/identities. Updates require `id` and `expectedVersion`. Unresolved identities remain draft. |
| POST | `/api/policies/:id/disable` | `expectedVersion`; invalidate Hot Context atomically |
| POST | `/api/instructions` | `text`, `kind:"fact"` (default) or `"policy"`, scope. A policy can supply `policy:{predicate,effect}` and confirmed `identities`. Ambiguity returns `needs_clarification`. |
| GET | `/api/experiences` | Structured Experiences with evidence counts, the latest trial summary with its effective (not merely stored) state, case-set summary, read-only archive authorization and immutable content-version summaries. Also returns the current fixture/policy version metadata |
| GET | `/api/experiences/:id` | One Experience with its safe trial summaries, bounded case differences, saved declarative cases, content-version history, read-only archive authorization and evaluation metadata |
| POST | `/api/experiences/:id/cases` | `expectedRevision`, `expectedCaseSetVersion`, bounded `cases`. An explicit user confirmation saves literal scenarios, never client-supplied results. Each case has a unique id, known scope/features and a literal `applies`/`winner`/`effect` expectation; an optional source must already be an active source of this Experience. Returns the new case-set version and digest |
| POST | `/api/experiences/:id/evaluate` | `expectedRevision` only. Runs the fixed offline fixture against the actual predicate and arbitration paths with a bounded deadline. A pass needs at least one actually scope+predicate matched case whose literal expectation is `applies:true`, `winner:"candidate"` and an independent structured `effect`, and whose candidate selection actually equals that effect. User-precedence (`winner:"user"`) and negative cases remain supporting checks but never substitute for it. Returns `passed`, `failed` or `unknown`; advisory guidance, no applicable positive candidate case (`no_applicable_positive_candidate_case`), cancellation, an exception or the deadline is `unknown`. The policy version is `experience-trial-policy-2026-11-13.2`; earlier-policy passes and attestations are superseded. A pass expires after at most seven days, never later than the Experience validity window |
| POST | `/api/experiences/:id/adopt` | `expectedRevision` only. Explicit user adoption of a supported non-format, non-global candidate with a current pass, available provenance and no negative evidence. Changes planning eligibility only; it never grants a tool or provider permission |
| POST | `/api/experiences/:id/rollback` | `expectedRevision`, `targetRevision`. Explicitly restore one historical immutable content version as a new candidate revision. Clears evidence and any trial admission; never lowers the revision or restores active status |
| POST | `/api/experiences/:id/trial` | Existing `taskId`, exact `reviewToken`; prepare a scoped format trial for review, without sending |
| POST | `/api/experiences/:id/promote` | `expectedRevision`; still requires narrow low-risk eligibility and independent verified successes |
| POST | `/api/experiences/:id/revalidate` | `expectedRevision`; explicit user confirmation returns a `needs_revalidation` Experience to `candidate` with a clean evidence slate. `retired` stays terminal |
| POST | `/api/experiences/:id/retire` | `expectedRevision`; stop retrieving this Experience |
| POST | `/api/experiences/policy` | `expectedVersion` plus bounded learning thresholds or `autoPromote` (default false) |
| POST | `/api/experiences/attention-policy` | Bounded interruption limits and `quietHours:{startHour,endHour,timeZone}` (or null) |
| POST | `/api/experiences/context-policy` | Bounded clustering windows, event and association limits |
| POST | `/api/experiences/retrieval-policy` | `expectedVersion` and bounded retrieval ranking weights |
| POST | `/api/experiences/replay` | Default kind `retrieval`: up to 100 labeled `cases:[{query,relevantIds,scopes?}]`, optional options. Kind `arbitration_shadow` replays experience cases through the local arbiter. Retain aggregate offline metrics; execute no tools |
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

Automatic planning only receives an active Experience whose exact current
revision, content digest, scope, fixture version, fixture digest and policy
digest have a current pass. Candidates remain visible for explicit inspection
and the existing supervised format trial, but an unverified candidate is never
an automatic planning instruction. Trial passes add no `verified_success`
evidence. Adopting or rolling back guidance does not authorize any tool,
archive destination, payment, or review bypass; the dispatcher still validates
those independently. JSON-store mode returns `409 DURABLE_WORKSPACE_REQUIRED`
rather than pretending to persist an evaluation.

Saved cases are declarative test data, not trusted outcomes or authority. The
server evaluates every scope and typed predicate itself and compares the
result with the user's literal expectation; a client field such as `passed`,
`userRequested` or a fabricated case result is rejected. Applicability and
positive candidate evidence are counted separately: only a passing case that
matched the real scope and predicate, expected the candidate, and matched the
literal structured effect satisfies the readiness gate. User-precedence and
negative cases prove isolation and user authority but cannot replace that
assertion. Because a pass is bound to the case-set version, digest and policy
digest, saving a different set or running an older policy immediately expires
earlier passes and attestations for that Experience. A stored `expired` row
with no retained cause reports the generic `stored_expired` reason. Archive
guidance is evaluated against the current archive grants read-only: the check
can observe existing user authorization, but evaluation never creates, widens
or consumes a grant. Stored trial rows keep their original state; list and
detail responses also expose `effectiveState` (`expired` or `superseded` when
the pass, fixture, policy, case set, positive evidence or revision no longer
applies). Promotion carries an attestation only after the same current
provenance, authorization, content, case-set, TTL and parent-chain checks as
`currentTrialPass`. A supervised draft that was prepared from a candidate trial
additionally records the revision, content digest, pass expiry, case set and
authorization it used; an in-flight send is rejected with
`EXPERIENCE_TRIAL_STALE` if any of those changed.
“Do not do this again” belongs in an explicit suppression policy, separately
from Forget. See [the requirements](PRD.md) and [storage boundaries](ARCHITECTURE.md#storage-and-process-model).

Standing goals support `observe` and `prepare`. With a configured model,
preparation uses the Standard or Pi harness to read the actual source and prepare
a local draft with checked source quotations. Without a model, it prepares a
source brief. Both require review and prohibit external writes, including when
an unrelated destination grant exists. The Memory page provides goal creation,
editing and lifecycle controls; the workspace shows preparation, retry and review.

Reviewable tasks expose `preparedWorkReviewToken`. Send that value as `reviewToken`
to the acceptance endpoint. Changed inputs, directions, paused goals, unavailable
sources or stale artifacts return 409. Repeating the accepted token is idempotent.
Acceptance records `completion.kind:"user_accepted_preparation"` and
`completion.external:false`; the UI displays “Accepted by you”. The standing goal
remains active for future events. Updates to the same active source/thread reuse
the follow-up; unchanged input/context/model versions reuse the preparation.
An explicit suppression rule holds existing preparation visibly in the workspace.
Updating or disabling the rule revalidates it before review resumes.

Tasks expose `contextManifest`: complete selected memory/experience entries,
deferred items, overridden guidance, conflicts and input/context/privacy versions.
Both harnesses receive the same selection. `read_context_item` reads oversized
entries in chunks under the current task lease; unread deferred context prevents
automatic actions. Task-local directions take precedence. `search_workspace` and
`read_workspace_record` use that same lease to read eligible memories, other
observed documents and messages, and other tasks already stored from connected
sources. `observe_failures` uses that lease to reread failure statements in
authorized mail already stored locally. These reads do not contact a provider,
create a task or notification, or authorize a write.

RSI currently tunes `pairWindowMs`, `maxPairCandidates`,
`maxInteractivePerHour` and `minIntervalMs`. Pair eligibility cases have
`{rank,ageMs,expected}`; pacing cases have chronological `{at,expected}` entries
with millisecond timestamps. Reports compare the current and candidate settings
against a versioned label set. They measure bounded policy eligibility/pacing,
not overall task usefulness. Unrelated activation replays cannot qualify a
proposal. The Settings page shows evaluated proposals and guarded apply/rollback
controls; intervening user edits invalidate old proposals.

## External MCP client

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/mcp` | Redacted server status, built-in presets, discovered tools and read grants |
| POST | `/api/mcp/import` | Save and connect `config` (`mcpServers` object or JSON string); optional `allowDeclaredRead` grants server-declared read tools. OAuth state cannot be imported |
| POST | `/api/mcp/servers/:id` | Update `enabled`, `allowDeclaredRead`, `readTools` (array), `reconnect:true` or `remove:true` |
| POST | `/api/mcp/oauth/:id` | Start sign-in for a built-in hosted preset (`notion`, `linear`, `atlassian`, `todoist`). Send `{}` to start, or `{"cancel":true}` to cancel. The body cannot choose a server URL |

`GET /api/setup` also includes `mcp`. Import, update, and sign-in return `{mcp, setup}`.
Sign-in also returns `oauth`. `authorizeUrl` is included only while sign-in is in
progress. An unknown preset is 404. A body that contains `serverUrl` is 400.
A failed connection is saved with `status:"failed"` and a sanitized `lastError`,
so the user can correct or reconnect it. Invalid config fails with 400; concurrent
MCP updates fail with 409. Commands, arguments, environment values, headers, and
tokens are never echoed. These routes are refused in the disposable demo
(`409`, `DISPOSABLE_DEMO`). Configuration is private to the local installation, while
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
| POST | `/api/tasks/TASK_ID/direction` | `{text,scope,operation?}`; scope is `task` (default) or `similar`. `operation:"append"` is default; `"replace"` replaces this task's content requirements and is restricted to task scope |
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

### Model budgets and confirmed prices

`GET /api/model-controls?taskId=<existing task>` returns UTC-day Token limits and
settled/reserved/unknown usage, model-fee limits and per-currency usage, current
price versions, and `money.unpricedCalls`. Unpriced calls have unknown fees;
they are not reported as free. Omit `taskId` for the workspace. Unknown outcomes
retain their original ledger holds.

Persistent workspaces support these same-origin JSON POST routes:

- `/api/model-controls/token-limit`: `{scope, taskId?, tokens}`. An explicit
  `null` disables a limit; `0` blocks new spending.
- `/api/model-controls/money-limit`: `{scope, taskId?, currency, micros,
  expectedVersion}`. Amounts are safe integer micro-currency units; `null`
  disables a limit. Active workspace/task limits require matching currencies.
- `/api/model-controls/price-profile`: `{connection?, currency, revision,
  rates:{input,output,cacheRead,cacheWrite}, expectedVersion, confirmed:true}`.
  Rates are explicit safe integers in micro-currency per million tokens. A
  proposed `connection` uses the model setup fields and allows confirming
  prices before the synthetic connection test. The server derives the provider
  identity. Saving prices does not activate a connection or save its credentials.
  A stale price version returns a safe `currentProfile` for review.
- `/api/model-controls/routing`: `{expectedVersion, config, requestCallLimit,
  maxRpcAttempts}`. The config contains `modelIds`, `defaultModel`, a `stages`
  map (interpret/discovery/planning/verification/general), and optional
  `fallbackModel`. An explicit second-call choice
  raises the classic single-call cap to 2; it does not reset counters or increase
  the existing four-turn tool-loop ceiling. `config:null` disables the group.

`GET /api/model-controls/routing` returns the saved group/version and the current
classic call cap. Settings are local and do not convert currencies or grant
external-write permission. A configuration change before dispatch produces a
controlled `configuration_changed` deferral, with no request sent by that
attempt; duplicate dispatch permits remain errors.


### Timed/task autonomy and cumulative funds limits

`POST /api/autonomy` accepts `{mode:"time",durationMinutes}` or
`{mode:"task",taskId}`, with optional
`money:{currency,capMicros,durationMinutes,confirmed}`. The default funds cap
is zero. Positive caps require `confirmed:true` and a persistent workspace.
Money permission expires after 1–1440 minutes and cannot outlast timed
autonomy. Task autonomy still ends on task closure. Amounts are integer
micros in an explicit USD/CNY/EUR currency; no conversion is performed.

Repeated grants for the same scope and currency share cumulative accounting:
renewal, expiry, stopping and restarting do not reset spending or unknown
holds. The returned `moneyBudget` identifies that accounting container. Every
new quote and dispatch also requires its exact current, active autonomy
authority and task. A funds cap grants no tool/account/target permission and
does not supply an untrusted price. Model/API fees use the separate model
budgets and confirmed prices. `POST /api/autonomy/:id/revoke` stops new
actions without claiming to reverse an accepted operation or refund a hold.


### Financial tool contracts

A funds allowance never enables a tool by itself. For a connected MCP tool,
`POST /api/mcp/:id` accepts a per-tool patch:
`{financialConfirmed:true, writeTools:[...], financialTools:{toolName:{monetaryGrantId, amountMicrosPointer, currencyPointer}}}`.
Pointers address arguments directly, for example `/amountMicros` and
`/currency`. Amounts must be nonnegative integer micros and currency must
exactly match the selected allowance. The server binds the declaration to
the connected schema, configured account/endpoint and discovered server
identity. Imported configuration cannot create financial declarations.
Set one entry to `null` to revoke it; omitted entries are unchanged. A removed
financial declaration remains an unknown action, even if the remote server
labels the tool read-only.

`POST /api/connector-grants` uses `transfer:"paid"`, `financialConfirmed:true`,
`monetaryGrantId`, `amountMicrosPointer`, and `currencyPointer`. These pointers
address the entire request payload, for example `/request/body/amountMicros`
and `/request/body/currency`. Task-scoped allowances require the matching
`taskId`. Endpoint, account, path and method permissions still apply.

Every dispatch rechecks the native quote and authority at the actual transport
boundary. Generic MCP/API acceptance without independent monetary readback
keeps the funds held as unknown; it is neither a verified payment nor a refund,
and the same operation is not automatically sent again.
