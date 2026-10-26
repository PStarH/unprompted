# Architecture

[← Documentation](README.md)

Unprompted turns a change in an authorized environment into justified work.
The implementation is a small Node.js application with a local JSON store and a
browser interface. Its deterministic demo requires no installed packages. Pi
Agent Core and its model layer are pinned optional runtime dependencies.

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

One local JSON file stores one user's workspace. Writes are atomic, with an
exclusive process lock and stale-process recovery. Schema migrations preserve
recorded tasks, events, and the outbox; derived assessments and unapproved
legacy drafts may be rebuilt. Pending approved actions are reconciled.

Store mutation callbacks are synchronous transactions. Failed callbacks or writes
restore the in-memory snapshot; closed handles and stale same-process handles
cannot commit. Reopening an old handle is required after `STORE_CONFLICT`.
Rollback replaces `store.state`, so failed-operation callers reread current
objects rather than retaining detached references. See the
[testing guide](TESTING.md) for reproducible checks.

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
| GitHub assigned issues and Microsoft Outlook inbox | Official device OAuth, bounded read-only sync and source-specific task handling |
| Native local sources | Selected Markdown/text folders and macOS Notes bridge; read-only. Real Notes account and signed-app permission acceptance remain outstanding |
| Gmail / Drive / Docs incremental connector | Implemented; read-only setup is available for local testing |
| Gmail send and read-back | Implemented and tested against scripted transports; not a production-validation claim |
| Primary model interpretation and legacy assist mode | Primary blocks readiness until a grounded review; assist retains deterministic fallback |
| Optional Pi read-tool loop | Implemented; Node.js 22.19+, scripted contract and local streaming transport coverage |
| Scoped pre-authorization, correction history, notification dedupe | Implemented |
| Source-backed document patches, waits, task corrections and shared dependencies | Implemented with scripted and local integration coverage |
| Browser OAuth setup, continuous observation and local macOS app builder | Implemented; signing and real-account validation are separate |
| General desktop control, calendar, Slack, unrestricted autonomous document rewriting | Not implemented |
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
