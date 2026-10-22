# Architecture

[← Documentation](README.md)

Unprompted turns a change in an authorized environment into justified work.
The implementation is a small Node.js application with no runtime dependencies,
a local JSON store, and a browser interface.

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
| Environment | Connector input, normalization, incremental sync, provenance | `src/connectors/`, `src/simulation.js` |
| Context | Requests, document identity, state, freshness | `src/requests.js`, `src/correlation.js`, `src/store.js`, `src/freshness.js` |
| Discovery and planning | Interpret requests, select bounded probes, identify narrow opportunities | `src/reasoning.js`, `src/probes/plan.js`, `src/opportunities.js` |
| Evidence and policy | Assess criteria, preserve uncertainty, enforce authority | `src/evidence.js`, `src/probes/assess.js`, `src/permissions.js`, `src/calibration.js` |
| Execution | Prepare replies, enforce state transitions, execute idempotently | `src/engine.js`, `src/providers.js` |
| Verification and attention | Reconcile results, raise decisions, update metrics | `src/verification.js`, `src/notifications.js`, `src/metrics.js`, `src/trace.js` |

`server.js` provides the HTTP/SSE boundary and runtime wiring. `public/` is the
interface. `src/engine.js` orchestrates the layers; the shapes they exchange are
defined in `src/contracts.js`.

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

## Attention

History is an activity record, not a stream of user notifications. Decisions
that reach the user include the situation, why it matters, checks already made,
evidence, uncertainty, and the decision needed. Notifications are deduplicated
and withdrawn when their cause clears.

A waiting request with no evidence progress eventually raises one decision,
controlled by the configured stall threshold. Opportunity discovery is limited
to specific evidence gaps in existing work; accepting an opportunity records a
decision and does not start a new project.

## Storage and process model

One local JSON file stores one user's workspace. Writes are atomic, with an
exclusive process lock and stale-process recovery. Schema migrations preserve
recorded tasks, events, and the outbox; derived assessments and unapproved
legacy drafts may be rebuilt. Pending approved actions are reconciled.

State contains synchronized content and evidence excerpts, so it must stay out
of public bug reports and commits. It is not encrypted. See
[configuration and data handling](CONFIGURATION.md#what-stays-on-your-machine).

## Implemented and experimental

| Capability | Current status |
| --- | --- |
| Event engine, correlation, evidence checks, policy, UI, persistence | Implemented with automated coverage |
| Built-in email/document/run scenario and outbox | Simulated; exercises the real engine |
| Gmail / Drive / Docs incremental connector | Implemented; read-only setup is available for local testing |
| Gmail send and read-back | Implemented and tested against scripted transports; not a production-validation claim |
| Optional model interpretation | Implemented, with deterministic fallback |
| Scoped pre-authorization, correction history, notification dedupe | Implemented |
| General desktop control, calendar, Slack, autonomous document editing | Not implemented |
| Hosted service, authentication, multi-user tenancy | Not implemented |

## Known limitations

- Discovery uses deterministic request and entity rules with optional model help.
  It is not an unrestricted understanding of all activity in a user's life.
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
[implementation/coverage map](FRAMEWORK_GAP_MATRIX.md). For a connector, follow
[Google integration testing](LIVE_INTEGRATION.md#live-send-testing-for-contributors)
as an example of the distinction between scripted tests and live verification.
