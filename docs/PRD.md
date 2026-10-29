# Unprompted v0.3

## Durable Execution, Bounded Adaptation, and Proactive Context

**Status:** Accepted implementation baseline, 2026-10-27.  
**Deployment:** Single host, single user.  
**Storage:** SQLite + FTS5 + in-process vector retrieval.  
**Goal:** Proactive usefulness and repeatable execution without unnecessary infrastructure or uncontrolled self-modification.

This is the normative implementation baseline supplied by the product owner.
The [executable schema](../src/durable/schema.sql) defines the SQL contracts.
Existing product goals in [Product direction](PRODUCT_DIRECTION.md) continue to
apply: work begins from authorized context, real use comes before demonstrations,
and a useful quiet agent takes priority over frequent interruptions.

## 1. Non-negotiable architecture invariants

1. No model-generated Experience may grant tool permissions.
2. No model-generated Experience may override an explicit user policy or a safety restriction.
3. Missing or stale features must never satisfy an activation predicate.
4. Silence is neutral; verified consumption is adoption evidence, not proof of satisfaction.
5. A candidate Experience may be tested under supervision but cannot independently authorize a high-impact action.
6. Every external write has a durable intent record before dispatch.
7. An ambiguous external result is reconciled before retrying.
8. A lease expiration does not prove that a previous external request stopped executing.
9. User corrections can stop an unsafe pattern immediately without waiting for the Experience Compiler.
10. Forgetting data cancels dependent learning and execution; it must not create a hidden semantic memory of the forgotten content.
11. All durable task transitions are version-checked.
12. Online self-adaptation is restricted to structured, inspectable Experience records. It cannot rewrite runtime code, authorization rules, or the FeatureRegistry.

## 2. Consolidated architecture

```text
Connector Events / Timers / User Instructions
  → Durable Inbox → Normalization + FeatureRegistry
  → Hot Context + Entity Index → Working Context Index
  → Activation Engine → Notification Budget / Dedup
  → Durable Task + Checkpoint → Pre-resume State Revalidation
  → Hybrid Memory Retrieval → Planner + Plan-step Trace
  → Policy Engine → Tool Execution Ledger
  → External Action + Verification → Outcome / Adoption / Feedback
  → Fast Stop-Loss / Slow Compiler → Candidate Experience
  → Supervised Evaluation → Bounded Experience Promotion
```

Memory stores grounded context. Activation Policy controls when and how the
agent may act. Experience stores learned execution/planning guidance. These
remain separate. Hot Context and Working Context are derived, rebuildable
indexes, never independent sources of truth.

## 3. Durable jobs and worker state machine

`jobs` is the queue; no Redis or message broker. Required states: `queued`,
`running`, `retry_wait`, `recovery_required`, `completed`, `dead`, `cancelled`.
Uniqueness is `(queue_name,idempotency_key)`. Preserve priority, attempts,
availability, lease owner/token/deadline/heartbeat, failure class and dead reason.

Claim in a short `BEGIN IMMEDIATE`: select eligible work, set running, increment
the token, assign owner/deadline/heartbeat, commit, return the new row. Every
worker commit checks state, owner and token. A zero-row update loses ownership.
An expired running job first enters `recovery_required`; never blindly replay it.
Inspect TaskRun and Tool Execution Ledger. Requeue only after explicit safe
recovery, or reconcile an unresolved external action.

Retry with bounded exponential backoff and jitter, honor Retry-After, classify
retryable/permanent/ambiguous failures. Roll back database failures before retry.
Side-effecting timeouts do not prove failure.

## 4. Task input versioning and concurrent events

Tasks carry `input_version`, `processed_input_version`, `run_generation`,
`privacy_epoch` and a checked state version. Material associated events increment
input version. `create_or_load_task` returns task ID, created-new and input version.
Create a task and its unique initial job in one transaction. Existing tasks get
an association, never another initial run. Waiting tasks get a continuation keyed
by input version; active tasks become dirty; paused tasks preserve events and wait.

Before a plan segment or side effect, compare current and processed input,
reload new events, rebuild context, revalidate pending actions and persist a fresh
checkpoint. Supplier quotes, user edits and calendar changes cannot be silently
omitted from an active run.

## 5. Experience schema and lifecycle

Kinds: execution/planning hints, omission guards and trigger hints. Statuses:
candidate, active, cooldown, needs revalidation, retired. Scopes: global, task
family, project, entity, resource. Each record includes a typed predicate,
structured effect signature, instruction, directive key, action family, priority,
specificity, verified/positive/negative counts, freshness class and validity,
revision/schema versions, verification/negative/cooldown timestamps.

Normalized lineage identifies source episodes, outcomes and artifact evidence
without duplicating raw content. Forget deletes or invalidates descendants.
Unstructured effects remain advisory and cannot resolve execution conflicts.
Unsafe schemas/provenance are rejected or retired; credible negative feedback
cools down; changed/stale context requires revalidation. Candidates may inform
proposals but cannot authorize writes or bypass policy.

## 6. Plan-step attribution and omission learning

Persist meaningful proposed, approved, executing, completed, skipped, rejected
and cancelled steps, their logical ID/plan version, expected effect, omission
reason and observed result linkage. Record relevant Experiences separately from
declared influence. Attribution relations: planner declared, predicate matched,
user confirmed. Only credible relevant influence earns credit or penalties.
An uncalled tool does not prove an Experience caused an omission. Rejecting a
plan missing legal review targets that step, not every retrieved Experience.
Task-level rejection may affect multiple credibly associated steps.

## 7. Adoption, rejection and deterministic stop-loss

Explicit acceptance is strong positive evidence. Verified downstream consumption
is adoption evidence; similar-content use is moderate evidence. High-divergence
rewrites create override evidence, not automatic rejection. Silence is neutral.

Track generated artifact ID/version, user-visible version, edit/replace/delete/
send/share/discard lifecycle, normalized edit ratio, optional redacted diff
reference and originating plan-step influence. Do not retain raw diffs by default.

One large edit creates `implicit_override`; do not penalize all associated
Experiences. Repeated independent overrides in the same narrow scope may cause
cooldown/revalidation. A large rewrite followed by sending does not reward the
original wording/style; narrower workflow usefulness needs separate evidence.
The initial 0.7 edit-ratio heuristic is configurable and versioned, not a
scientifically established threshold.

Rejection/Undo immediately resolves the exact step or execution, suppresses an
equivalent action in the current context, cools down only credibly implicated
Experiences, records feedback and queues slow analysis. It never waits for an LLM.

## 8. Supervision and bounded promotion

Candidate → proposed exact plan/draft → user approval → independent policy
authorization → execution → verified attributed outcome. This proves usefulness
under supervision, not permission to remove confirmation.

Explicit user policies belong to Activation Policy, not learned Experience.
Initially three independent verified supervised successes may promote narrowly
scoped, low-risk mechanical execution hints, with no unresolved strong negatives.
Thresholds are conservative, versioned configurable heuristics. High-impact
actions always need separate authorization. Trigger and omission hints stay
advisory unless incorporated into an explicit user-approved Activation Policy.
One success cannot generalize to unrelated scopes. P0 works with promotion off.

## 9. Deterministic arbitration

Authority order: system safety/tool permissions; current user instruction;
persisted explicit Activation Policy; approved workflow/rule; active Experience;
candidate advisory; generic defaults. Scope specificity never beats authority.
Within a level, exact resource/entity precedes project, task family, global;
explicit user priorities resolve compatible equal-level rules.

Structured guidance exposes a normalized directive key and effect signature
(e.g. `email.archive.destination`, `email.notify.behavior`, quote output/review
requirements). Incompatible equal-authority effects use explicit priority; use
specificity only when otherwise compatible. Remaining conflicts suppress
autonomous execution for the affected directive and ask for clarification.
Recency alone is not a tie-breaker. Free text remains advisory.

## 10. Staleness and revalidation

Stable guidance has no universal time decay. Operational guidance is periodically
revalidated against recent outcomes. Time-sensitive guidance needs an explicit
validity window and refreshed underlying facts. Staleness reduces eligibility or
requires revalidation, never erases historical counts. Advisory freshness ranking
must not overwrite evidence. Evaluate through history, replay or shadow comparison;
never unsafe online counterfactual experiments.

## 11. Working Context and entity salience

Strong anchors: native thread/resource ID, explicit project/task/meeting reference,
user-confirmed canonical entity mapping. Require task-family compatibility.
Names, generic topics, broad labels, frequent addresses/organizations are weak;
they never independently merge candidates.

For non-sensitive normalized entity keys, bounded-window IDF is
`ln((1+N)/(1+df(e)))`. It ranks candidates, never proves identity. Use generic
entity stop lists. Without a strong anchor, require two independent compatible
evidence dimensions including a project-specific entity or resource reference.
Apply time windows and thresholds; no unrestricted transitive union-find.

Initial configurable limits: 12 events/candidate, 3 associations/event, 30-minute
ordinary aggregation window. Explicit deadlines/future commitments are separate.
Overflow splits or retains an event independently, or requests clarification.
Tune using false-merge and missed-correlation telemetry.

## 12. Attention budget

Classes: explicitly configured critical, interactive, informational, digest.
Defaults start at three non-critical interactive interruptions/hour and ten
minutes between non-critical interruptions, with candidate deduplication, short
digest windows, quiet hours/exceptions and cross-task unresolved-issue cooldown.
These are product defaults to validate, not universal optimal values.

Exhaustion merges informational results into digests, defers lower-priority
questions, keeps candidates accumulating/notification-pending, and preserves
deadlines/task state. It changes delivery timing, never authorization.

## 13. Instructions, Hot Context and policy consistency

`user_memories` stores grounded facts/preferences; `activation_policies` stores
explicit behavior/activation instructions; `hot_context_items` is a derived
materialized projection. Persistent instruction ingestion proposes fact/policy,
resolves identities/aliases, validates schema/permissions, asks only when ambiguous
or high impact, then transactionally persists authority, projection and context
version. Deferred projection work needs a job/outbox in the same transaction;
Activation must not use an unrefreshed projection. Reject stale caches.
“Prioritize emails from Li” must resolve the exact sender first. Priority hints
cannot authorize writes.

## 14. Resource claims and external fencing

Claims retain user/provider/resource, owning run, lease owner/token/deadline,
current execution and state. Token increments are durable and never reset on
release. Renew during operations; configure HTTP hard timeouts and leases. Lost
owners initiate no new actions and cannot commit stale local transitions.

Local fencing cannot stop a delayed remote request unless the provider checks a
token or equivalent conditional version. Use native idempotency, ETags/version
preconditions and keep unresolved claims. Ambiguous timeouts enter unknown and
reconcile. Without reliable reconciliation or conditional execution, potentially
destructive actions are not automatically retried; manual reconciliation may be
the only safe result. [Fencing analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).

## 15. SQLite policy

Verify WAL at startup. Every connection enables foreign keys, busy timeout 5000,
`synchronous=FULL`, and core secure delete. Use one in-process write coordinator,
short transactions, separate reads as needed, bounded busy backoff with jitter,
rollback before retry and no network/model/filesystem work inside a transaction.
Use immediate transactions for critical read/modify/write sections.

Pin and test the deployed SQLite runtime at 3.51.3 or a verified fixed branch or
later. Include concurrent-connection/crash tests for WAL. Do not weaken FULL
durability without performance measurements and revised guarantees.
[SQLite WAL and the WAL-reset fix](https://www.sqlite.org/wal.html).

## 16. Forget and deletion

Forget removes information and its derived data. “Don't do this again” creates
an explicit manageable suppression policy; never retain forgotten semantic text
in a tombstone.

Resolve lineage; increment privacy/invalidation generations; cancel dependent
tasks/compiler jobs; stop new actions; fence stale plans/checkpoints; reconcile
in-flight effects; remove Experiences, embeddings, FTS entries, caches,
checkpoints, artifacts, external payloads and owned backups under retention policy.
A running/waiting task cannot resume from a forgotten checkpoint. Cancel and
invalidate it rather than editing a live checkpoint in place.

Enable FTS5 secure-delete and core secure_delete, delete index entries, checkpoint
and truncate WAL after readers release snapshots, and apply compaction/backup
policy. Report actual remaining retention; do not claim forensic erasure from
filesystems/devices/backups/providers that cannot be verified.
[FTS5 secure deletion](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option).

## 17. Required verification and failure injection

Before unattended writes are enabled, verify:

1. Two workers claiming one job.
2. Lease expiration while the old worker is paused.
3. An old worker returning after takeover.
4. External success followed by crash before local result persistence.
5. An ambiguous write timeout.
6. New input arriving during a TaskRun.
7. A duplicate candidate associating with a waiting task.
8. Two tasks modifying one resource.
9. SQLITE_BUSY during inbox/checkpoint writes.
10. Crash immediately after commit.
11. Required-step omission without tool execution.
12. Plan rejection before the first write.
13. Heavy rewrite followed by sending.
14. Candidate influence on an approved verified outcome.
15. Conflicting structured active Experiences.
16. Stale operational guidance.
17. Correction cooling only relevant scope/influence.
18. Weak Experience matches cannot suppress high-priority activation.
19. Common entities do not merge unrelated work.
20. Independent strong anchors associate cross-connector context.
21. Candidate size overflow.
22. Notification exhaustion produces digests.
23. New policy updates Hot Context before Activation uses it.
24. Outdated context-cache versions are rejected.
25. Forget cancels dependent compiler jobs.
26. Privacy-invalidated workers cannot commit.
27. FTS secure deletion removes entries.
28. Forgotten checkpoints cannot resume.
29. Backup/external payload retention follows declared policy.
30. Forget leaves no semantic tombstone reproducing content.

## 18. Implementation order

- **P0:** Durable jobs/recovery, input versions, execution ledger, resource claims,
  conditional writes, checkpoints/revalidation, verified SQLite configuration and
  coordinator, Forget cancellation and stale-worker rejection.
- **P1:** Immutable FeatureRegistry/typed predicates, transactional Hot Context,
  Working Context, clustering limits, attention budget, cross-source reconciliation.
- **P2:** Experiences/lineage, step attribution, structured effects/arbitration,
  explicit/implicit evidence, supervision/promotion, staleness, privacy-safe compiler.
- **P3:** Retrieval ranking, tunable aggregation/attention, verified-outcome and
  override analysis, offline replay/shadow comparison. Workflow compilation only
  when repeated verified evidence justifies it.

## 19. Final decision

Remain lightweight and single-host: no Graph DB, separate Vector DB, broker or
online reinforcement-learning system. Adaptation is structured, traceable,
bounded, reversible where possible and grounded in verified evidence.

**Observe → Correlate → Activate → Validate → Plan → Execute → Verify → Learn → Revalidate.**
