---
title: Architecture
description: The event-to-verification pipeline, module boundaries, storage, evidence, execution, and known limits.
---

## One piece of work

```text
authorized event
  → normalized context
  → request or commitment
  → evidence and policy assessment
  → bounded reasoning / probes
  → prepared action
  → user decision or scoped lease
  → idempotent dispatch
  → provider readback
  → verified outcome or reconciliation
```

The model interprets and plans within a task lease. Deterministic code owns source identity, correlation, evidence requirements, permissions, review tokens, dispatch, and verification.

## Modules

| Layer | Responsibility | Main files |
| --- | --- | --- |
| Environment | Cloud and native input, normalization, incremental sync, provenance | `src/connectors/`, `src/simulation.js` |
| Context | Requests, document identity, state, freshness | `src/requests.js`, `src/correlation.js`, `src/store.js`, `src/freshness.js` |
| Discovery and planning | Interpretation, bounded probes, narrow opportunities | `src/reasoning.js`, `src/pi-runtime.js`, `src/probes/plan.js`, `src/opportunities.js` |
| Evidence and policy | Criteria assessment, uncertainty, authority | `src/evidence.js`, `src/probes/assess.js`, `src/permissions.js`, `src/calibration.js` |
| Execution | Prepare replies, enforce transitions, execute idempotently | `src/engine.js`, `src/providers.js` |
| Commitment lifecycle | Trusted revisions, withdrawals | `src/commitments.js`, `src/engine.js` |
| Task services | Waits, corrections, owned follow-ups, versioned document patches | `src/task-services.js`, `src/task-management.js`, `src/document-delivery.js` |
| Setup and observation | Private OAuth configuration, continuous sync, process state | `src/setup.js`, `src/monitoring.js` |
| External tools | MCP connections, read grants, bounded model/tool loop | `src/mcp.js`, `src/tool-loop.js` |
| Verification and attention | Reconcile results, raise decisions, metrics, traces | `src/verification.js`, `src/notifications.js`, `src/metrics.js`, `src/trace.js` |

## Evidence before action

An action becomes ready only when its content requirements are satisfied by verifiable evidence. Missing or stale evidence keeps work open. A newer source result can withdraw a prepared draft. A model's confidence is not evidence, and a recognized request still invokes the model when primary interpretation is active.

Readiness is recorded as a source-grounded review. The original verifiable requirements cannot be removed by the model. Failed or ungrounded model reasoning retains the deterministic assessment and does not become a rule-only ready reply.

## Storage and process model

Normal mode uses one local SQLite workspace with WAL and FTS5. A process lock prevents two processes from writing the same state file. State is written atomically with restrictive permissions where the operating system supports them. It is not encrypted.

The workspace can contain source content, requests, evidence excerpts, drafts, action history, and bounded model/MCP call records. Treat it as personal data. UI-connected cloud accounts use separate hashed state files in the same configuration directory.

The demo is a separate temporary workspace. It never inherits real Google credentials and never inserts sample records into normal startup.

## Execution and recovery

External actions are idempotent and bound to the reviewed source, payload, version, destination grant, and privacy state. Shadow mode refuses writes. Dispatch checks authorization again. A provider-accepted action is not complete until readback confirms it; an uncertain result stays blocked from retry until reconciliation.

Waits persist across restarts. A task pause stops assessment and new external execution. A correction invalidates prepared work and saved verification plans, then rechecks evidence. Reopening a closed task reconstructs a draft without sending.

## Reasoning budgets

The classic adapter makes one provider turn unless MCP tools are enabled. Pi adds a read-only tool loop with explicit budgets:

- at most four model requests, eight tool attempts, and 60 seconds per run;
- 2,048 output tokens, 20 seconds, and no SDK retries per provider request;
- 32,000 serialized context characters;
- at most eight correlated documents, 4,000 characters per chunk.

Oversized or malformed output fails explicitly. Completed probe plans checkpoint per task. In-flight conversations do not resume after a process restart; bounded persisted jobs can be reconstructed without replaying a partial conversation.

## Interfaces

- The browser workspace is served by `server.js` from `public/`.
- The local API is unauthenticated, localhost-only in normal use, and enforces origin checks for writes.
- SSE carries full snapshots with bounded buffering and heartbeats.
- MCP is a client integration. Server read annotations are claims, not a sandbox; unannotated tools need an explicit grant, and writable or destructive tools stay blocked.

## Implemented and experimental

Implemented with automated coverage: event engine, correlation, evidence checks, policy, persistence, and the workspace UI. Scripted coverage includes Gmail send and readback, document patches, waits, corrections, and autonomy.

Implemented but not production-validated here: Google, GitHub, Outlook, Slack, and Notion live accounts; Apple Notes real-account automation; the signed macOS app. Cloud integrations require a registered OAuth client, and some provider approvals remain manual. Google send and Docs writes are explicitly gated and tested against scripted transports.

Not implemented: calendar, general desktop control, unrestricted autonomous document rewriting, hosted service, authentication, and multi-user tenancy.

## Known limitations

- The database, tokens, and keys are not encrypted.
- There is no built-in authentication or multi-user isolation.
- Provider push is not enabled; observation uses polling and bounded continuation passes.
- An uncertain external result cannot be retried until reconciliation.
- Model and provider behavior can change; a working local test is not a guarantee about a remote service.
- The API may change before 1.0.

## Start reading the code

- [Local API](api.md) — HTTP surface and status codes.
- [Development & testing](development.md) — run the tests, example flow, and extension points.
- [Permissions & privacy](permissions.md) — operational data boundary.
- [`docs/ARCHITECTURE.md`](https://github.com/PStarH/unprompted/blob/main/docs/ARCHITECTURE.md) — the repository's longer design record.
