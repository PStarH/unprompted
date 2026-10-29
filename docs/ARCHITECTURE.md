# Architecture

[← Documentation](README.md)

Unprompted turns a change in an authorized environment into justified work.
The implementation is a small Node.js application with SQLite, FTS5 and a browser
interface. `better-sqlite3` is a pinned required dependency; Pi Agent Core, its
model layer and the official MCP client are pinned optional dependencies.
The explicit rule-only demo retains its JSON store. See the [v0.3 baseline](PRD.md).

## Follow one piece of work

```text
event → normalize and deduplicate → extract request → correlate context
      → plan evidence checks → assess requirements and freshness
      → prepare action → check authority → execute → verify receipt
```

A later document or run event can reassess an existing request without user
input. An unrelated event is recorded without creating a task. If newer evidence
invalidates a ready draft, the draft is withdrawn. A task becomes complete only
after a verified action result.

## Modules

| Layer | Responsibility | Main files |
| --- | --- | --- |
| Environment | Cloud and native connector input, normalization, incremental sync, provenance | `src/connectors/`, `src/simulation.js` |
| Context | Requests, document identity, state, freshness | `src/requests.js`, `src/correlation.js`, `src/store.js`, `src/freshness.js` |
| Discovery and planning | Interpret requests, select bounded probes, identify narrow opportunities | `src/reasoning.js`, `src/pi-runtime.js`, `src/probes/plan.js`, `src/opportunities.js` |
| Evidence and policy | Assess criteria, preserve uncertainty, enforce authority | `src/evidence.js`, `src/probes/assess.js`, `src/permissions.js`, `src/calibration.js` |
| Execution | Prepare replies, enforce state transitions, execute idempotently | `src/engine.js`, `src/providers.js` |
| Commitment lifecycle | Relate trusted thread messages, retain request revisions, invalidate withdrawn work | `src/commitments.js`, `src/engine.js` |
| Task services | Persist waits, corrections, owned follow-ups and versioned document patches | `src/task-services.js`, `src/task-management.js`, `src/document-delivery.js` |
| Local setup and observation | Private OAuth configuration, continuous sync, process state | `src/setup.js`, `src/monitoring.js` |
| External tools | Private MCP configuration, owned stdio/HTTP/SSE connections, read grants and bounded model/tool loop | `src/mcp.js`, `src/tool-loop.js` |
| Verification and attention | Reconcile results, raise decisions, update metrics | `src/verification.js`, `src/notifications.js`, `src/metrics.js`, `src/trace.js` |

`server.js` provides the HTTP/SSE boundary and runtime wiring. `public/` is the
interface. `src/engine.js` orchestrates the layers; the shapes they exchange are
defined in `src/contracts.js`.

Workspace projection aggregates shared dependencies once and uses one timestamp
for every task and metric in the response. Live snapshots use a bounded SSE hub:
slow clients receive the latest pending state rather than an unbounded queue of
intermediate full snapshots. The transport is isolated in `src/http-transport.js`.

## Real workspace activation

Normal startup uses setup mode until a real connector is configured; simulation
is explicitly opt-in. Browser OAuth resolves a verified Google identity, drains
old operations, switches to that account’s isolated store, and activates the
connector without restarting. Concurrent mutations are held with a retryable
409. The first Drive pull captures a change baseline and reads existing Docs
immediately. A real workspace retains its Gmail adapter even when sending is
disabled, so a missing send permission cannot become a simulated receipt.

## Evidence contracts

Important facts carry source references: provider kind, source ID, version or
timestamp, and the matched content. The system separates observed facts,
inferences, unknowns, and claims supported by evidence.

Completion criteria are derived from the request. Each criterion can be
satisfied, unknown, unsatisfied, blocked, or conflicting. An optional model may
propose interpretation, but its justification must be grounded in the original
request. It cannot assert completion or grant authority.

A `latest` claim needs a corresponding source of truth. Freshness may be
verified, unverified, stale, or contradictory. A document modification timestamp
alone is not proof that its results are current.

## Actions and recovery

Observation and preparation have no external effect. External execution needs
an explicit approval or a previously stated authorization whose scope matches
the action. Normal-mode shadow policy refuses writes even after an approval.

Every send has an idempotency key. An acceptance response is followed by a
read-back verification. A timeout or ambiguous result is blocked and reconciled
before a retry; the system does not guess whether an external action happened.

Thread messages are grouped only within a stable sender/participant/deliverable
boundary. Revision and withdrawal messages retain their sources. Async model
results and pre-send work are checked against the current commitment revision;
an already accepted send remains a reconciliation problem rather than an
invented cancellation.

Document patches use current source quotes and a pinned target version.
Google writes require a separate provider flag, permission and Docs revision
control. Writes are followed by readback; interrupted or uncertain writes are
recorded without blind replay. Preparing a patch has no external effect.

## MCP investigation

MCP is a client integration: external services supply tools to the agent, rather
than exposing an Unprompted MCP server. Both Standard and Pi receive scoped read
adapters. Every invocation rechecks the current task/reasoning attempt,
connection generation, catalog and user grant; changed tasks and revoked
connections discard late results. MCP text is untrusted model context and an
audited task source, separate from verified document evidence. Native issue and
local-to-do investigations can read their source document, suggest a next step
and queue an explicitly authorized work artifact without changing source ownership.

`src/task-tools.js` supplies `read_task_source`, `search_documents` and
`read_document` to both harnesses. Source text comes from the current task's
message, provider assignment or explicit to-do. Documents include the direct
source document and up to eight correlated, available documents, with user
association corrections applied. Every read rechecks the current task lease,
reasoning fence, activation and connector revocation. Reads are recorded in the
execution ledger as workspace context; they do not grant write access or prove
task completion. Pi omits duplicate built-in tools when the shared adapters are
present. Destination grant and policy changes invalidate tool investigation
caches, including tasks that already have a prepared reply.

Native creation uses `create_work_artifact` and a separate durable write job.
It revalidates the task, exact user grant, account, destination, context and
payload at dispatch, then reads the provider to verify the result. A review
policy permits investigation while refusing automatic creation. Provider-native
withdrawals invalidate existing work even when new activation is suppressed.
`test/connector-harness.test.js` exercises the full path through actual connector
normalization, SQLite jobs, both model/tool loops and scripted provider readback.

The Standard MCP loop allows four provider turns and eight tool calls, sharing
the existing rate/concurrency budget; Pi retains its existing limits. At most 24
tools are exposed per run, four MCP calls may execute concurrently, and each
call has a 15-second deadline and a 6,000-character text result. Server catalogs
are bounded to 64 tools and installation config to 12 servers. Enabled services
reconnect in the background on startup. Disable/remove aborts the transport and
closes owned processes. Credentials remain in a separate private `mcp.json`,
excluded from public projections and task exports. Server read annotations are
claims trusted through the user's grant, not sandbox enforcement; known writes
are blocked and arbitrary MCP tool polling is not task discovery.

## Attention

History is an activity record, not a stream of user notifications. Decisions
that reach the user include the situation, why it matters, checks already made,
evidence, uncertainty, and the decision needed. Notifications are deduplicated
and withdrawn when their cause clears.

A waiting request with no evidence progress eventually raises one decision,
controlled by the configured stall threshold. Opportunity discovery is limited
to specific evidence gaps in existing work; accepting an opportunity creates an
owned follow-up with a next action and completion condition. It does not
automatically start an external project or execute a provider action.

The progress clock tracks changed verification conditions and blockers, not
document revision activity. Formatting and changes to an already-satisfied
figure do not postpone a stalled request; a newly satisfied requirement or
changed blocker does. Source versions still govern assessment and execution.
Completed, cancelled and user-declined tasks do not contribute opportunity signals.
See [product direction](PRODUCT_DIRECTION.md) for the distinction between engineering coverage and real user value.

## Storage and process model

Normal workspaces use a private SQLite database per account, with WAL,
foreign keys, a five-second busy timeout, `synchronous=FULL`, core secure deletion
and FTS5 secure deletion. The lockfile pins better-sqlite3 12.11.1 / SQLite 3.53.2;
startup verifies that runtime. All mutations use short coordinated transactions;
async writes retry bounded SQLite contention only after rollback. No model,
connector or file I/O runs inside a transaction.

`src/durable/schema.sql` defines the normalized inbox, tasks, jobs, runs, ledger,
claims, memory, policies, Experiences and lineage. `SqliteStore` retains a versioned
compatibility projection for existing engine modules. Job and task tokens reject
stale workers. New task input invalidates old plans; checkpoints include input,
context and privacy versions. Expired jobs enter recovery before becoming runnable.
The JSON migration commits and verifies SQLite before retiring the original to a
private `.migration-backup`. An uncertain legacy write is imported as `unknown`,
with a resource claim; migration never treats it as a failed operation to resend.

The ledger commits an intent before dispatch, checks authorization again at the
actual provider boundary, and retains unresolved resource claims after timeout or
lease expiry. Google Docs uses required revision preconditions and readback.
Gmail search absence is insufficient to prove a timed-out send never happened;
providers without reliable reconciliation require manual resolution. Local tokens
cannot fence a remote service that does not validate them. The rule-only demo and
framework `JsonStore` remain explicit compatibility paths, outside v0.3 guarantees.

Memory retrieval combines FTS5 trigram search and in-process lexical n-gram vectors
through reciprocal-rank fusion. This default is `semantic:false`; `HybridMemory`
accepts an injected local semantic encoder with an explicit model ID and dimensions.
Caches carry context/privacy versions. Hot Context is a projection of grounded
memories and explicit policies, never a separate editable authority. Unknown or
stale typed features cannot activate a predicate, including under negation.

Working Context requires provider anchors or independent project-specific evidence;
common people and topics cannot merge arbitrary clusters. Default limits are 12
events, three candidate associations and 30-minute bursts. Attention defaults to
three interactive interruptions/hour and ten-minute separation, with digests and
quiet hours. Deferring a question never authorizes its action.

`ExperienceService` keeps source IDs, structured effects and exact plan-step
attribution. Candidate format guidance can prepare an existing draft under review;
only verified, attributable independent work contributes supervised successes.
Silence is neutral; heavy rewrites create override evidence rather than automatic
rejection. Explicit rejection applies deterministic scoped stop-loss immediately.
Low-risk promotion needs three independent successes by default and starts off.
Trigger/omission hints remain advisory; promotion never changes tool permissions.
Offline replay retains aggregate retrieval/arbitration metrics and invokes no tools.

Forget increments privacy/generation fences, cancels dependent tasks and compilation,
removes FTS/vectors/checkpoints/caches/derived records, and deletes registered local
migration backups. It reconciles already dispatched operations, truncates WAL once
readers release their snapshots, and reports pending retention instead of claiming
forensic erasure. Opaque HMAC record identities prevent deleted source reingestion;
no semantic tombstone is retained. Copies already sent to a model or connector,
filesystem snapshots and independent backups follow their own retention policies.

State contains synchronized content and evidence excerpts, so it must stay out
of public bug reports and commits. It is not encrypted. See
[configuration and data handling](CONFIGURATION.md#what-stays-on-your-machine).

Accepted model probes are checkpointed per task and validated again when restored.
Only deterministic plans use the shared plan cache. Brief model concurrency bursts
wait in a bounded queue; rate and per-request budgets still apply. Background work
is released when settled, and settlement waits for nested work as well. See
[testing guide](TESTING.md) for the fault scenarios and optional Pi checks. Pi owns a bounded,
read-only tool loop; the engine supplies live task-scoped document access and
independently validates the returned probes. Every provider turn shares the
reasoning budget. Run summaries are bounded, and accepted plans survive restart;
in-flight model conversations do not. Persisted reasoning jobs can retry bounded
read-only work after restart; this reconstructs a request rather than replaying
an unfinished tool transcript. Unchanged recovery checks do not rewrite state.
Transient read failures also retain a due time and terminal reason. The regular
maintenance sweep admits at most two recovery jobs at a time, with durable attempt
limits and backoff. Both late success and late failure callbacks check their task,
request revision and attempt identity. Malformed provider lookups remain unknown;
they cannot authorize another send or create a verified completion. See the
[product direction](PRODUCT_DIRECTION.md) for the distinction between verified operations and actual useful outcomes.

## Implemented and experimental

| Capability | Current status |
| --- | --- |
| Event engine, correlation, evidence checks, policy, UI, persistence | Implemented with automated coverage |
| Built-in email/document/run scenario and outbox | Simulated; exercises the real engine |
| GitHub issues, pull requests, commits, Actions runs, and Microsoft Outlook inbox | Official device OAuth, bounded read-only sync and source-specific task handling |
| Slack direct messages and Notion pages | Browser authorization code, fixed localhost redirect, bounded read-only sync |
| Native local sources | Selected Markdown/text folders and macOS Notes. Note creation needs a separate folder grant; real Notes account and signed-app permission acceptance remain outstanding |
| Gmail / Drive / Docs incremental connector | Implemented; read-only setup is available for local testing |
| Gmail send and read-back | Implemented and tested against scripted transports; not a production-validation claim |
| Primary model interpretation and legacy assist mode | Primary blocks readiness until a grounded review; assist retains deterministic fallback |
| Optional Pi read-tool loop | Implemented; Node.js 22.19+, scripted contract and local streaming transport coverage |
| Scoped pre-authorization, correction history, notification dedupe | Implemented |
| Source-backed document patches, waits, task corrections and shared dependencies | Implemented with scripted and local integration coverage |
| Browser OAuth setup, continuous observation and local macOS app builder | Implemented; signing and real-account validation are separate |
| General desktop control, calendar, unrestricted autonomous document rewriting | Not implemented |
| Hosted service, authentication, multi-user tenancy | Not implemented |

## Known limitations

- Discovery retains deterministic source/eligibility gates. The main model-backed
  path uses primary interpretation; this remains a bounded request/evidence
  workflow, not unrestricted understanding of all activity in a user's life.
- Google sync uses incremental polling, without push-channel renewal.
- Evidence probes work best on explicit content, figures, labels and conclusions.
  Narrative ambiguity may remain unknown.
- Opportunity signals and calibration rules are narrow. There is no general
  learned personal preference model.
- The stall threshold is a fixed duration, not a learned workflow cadence.
- Single-process, whole-file persistence is intended for a local prototype.
- Tests and scenario evaluations do not establish real-world time savings,
  usefulness, noise rates, or production reliability.

## Start changing the code

Read [Contributing](../CONTRIBUTING.md), [Testing](TESTING.md), and the
[implementation/coverage map](TESTING.md). For a connector, follow
[Google integration testing](LIVE_INTEGRATION.md#live-send-testing-for-contributors)
as an example of the distinction between scripted tests and live verification.

## Interface

Field, Index, Lanes, Spotlight and Pulse share the same task model, selection,
correction composer and controls. Field is the initial overview. Explicit view
and appearance choices are remembered locally; contextual suggestions never
replace a user's view. On narrow screens, Field expands the selected task in
place. Pulse groups repetitive checks and keeps one selected event.

Memory, Connections and Settings are independent pages with direct hash routes.
Task-level source excerpts and memory scope open in a native dialog; closing it
returns focus to the same task without changing the view or losing a correction
draft. Shared memory editing remains on the full Memory page.

`public/workspace-model.js` derives presentation states from recorded execution,
verification, pause and connection state. `src/task-guidance.js` persists user
requirements, pause/resume, undo and exact-scope memory. Corrections invalidate
the reply and patch review identity before evidence is checked again. Task-local
direction takes precedence over similar-task memory and never changes permission.

The browser keeps drafts, file selections, expanded details and keyboard focus
across streamed updates. It supports English and Chinese, reduced motion and
narrow layouts. Connection status separates pending authorization, verified
identity, actual synchronization and failure. Old account responses cannot
replace a newer live workspace. Provider keys and tokens do not enter browser
local storage, public setup status or event streams.

New connectors are read-only. Delivery is selected from the originating task's
connector; an Outlook request cannot use Gmail. GitHub issues use native
`issue.updated` events and retain their provider assignment and URL. Source
closure stops tracking without creating an agent completion receipt.
