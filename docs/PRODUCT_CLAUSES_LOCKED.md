# Locked spec: product-clause proof + connector regression

Status: **locked for implementation** (2026-11-10). Coordinator-owned. Do not
edit this file in the implementation PR except to copy it unchanged into
`docs/PRODUCT_CLAUSES_LOCKED.md` and to list it from `docs/README.md` /
`docs/TESTING.md`.

This change is a **proof and smallest-gap** change, not a platform change.
The accepted product contract in `docs/PRODUCT_CONTRACT.md` (four clauses:
Follow Through, Bounded Autonomy, Selective Attention, Intelligent
Activation) is the acceptance bar. An item does not pass because a module
exists; it passes when the happy path, failure path, and recovery path are
demonstrated on the existing WorkEngine lifecycle.

Do not add substantial new infrastructure. Use the existing WorkEngine,
SQLite durable store, `activation_decisions`, AttentionBudget
(`src/durable/attention.js`), notification helpers, ConnectorSync, CursorStore,
execution ledger, and `node:test` fixtures.

This spec does **not** reopen or weaken:

- `docs/SEND_AUTHORITY_LOCKED.md`
- `docs/NEEDS_YOU_ACCURACY_LOCKED.md`
- `docs/RELEASE_ACCEPTANCE_LOCKED.md` (the six scenes stay proven as they
  landed in main; do not rewrite those tests except to hook a clause
  assertion that does not change their contracts)

The four Field zones stay Needs you, In motion, Waiting, and Watching
(plus paused / done in the Watching group). Activity remains a quiet
record, not a fifth zone. Do not collapse the Field into three states.

The four clauses must be decided by one WorkEngine lifecycle. Modules must
not each mint a private policy for admission, authority, closure, or
notification. The model must not independently decide those things.

## Goal

After this change, CI on scripted fixtures can repeatedly prove:

1. **Follow Through** — after work is found, the agent stays responsible
   until a Closure Condition is truly satisfied, or until it can honestly
   say why it cannot continue. An action or a draft is not completion.
2. **Bounded Autonomy** — each turn advances only to the farthest point
   that current evidence, authority, and risk allow. Permission is never
   enlarged because a model “thinks it should continue.”
3. **Selective Attention** — the user is interrupted only when they are
   irreplaceable. Ordinary progress stays quiet. AttentionBudget may delay
   a notification; it must not hide a locked must-enter Needs you row.
4. **Intelligent Activation** — work starts or resumes only on a meaningful
   event, time, or dependency change, after a deterministic filter, not on
   every signal and not on an empty scheduled check.
5. **Connector regression** — every shipped first-party connector has a
   scripted happy, failure, and recovery path for sync (and for writes
   where that connector already supports destination creation).

This PR is not a claim that live Google / Outlook / Slack / GitHub /
Notion / Apple authorization has been accepted on real accounts, that
provider push delivery exists, or that the six labeled product metrics
(Verified Completion Rate and the rest) have a warehouse. Existing
`activationMetrics` may stay; do not invent labeled rates.

## Out of scope (must not grow this PR)

- Memory and Experience / RSI quality work (P1).
- A metrics warehouse, new attention-budget service, new event bus, or
  new digest product. `AttentionBudget` and `notification_deliveries`
  already exist; use them. Do not replace them.
- A named L0–L4 status field that replaces task status or Field zones.
  The ceiling is a **turn decision** recorded beside the existing status,
  not a second lifecycle.
- A quote-comparison or vendor-recommendation product. After the last
  quote is recorded, continue the existing prepare / ask / verify path.
- Real-account OAuth, provider push delivery, or macOS Automation.
  Keep TESTING.md honest: these checks are scripted HTTP / simulated
  providers / injected native responses.
- Context-prefetch when the user “opens a related project.” There is no
  reliable in-product hook for that signal today. Leave it as an accepted
  residual; do not fake a context trigger.
- Changing the Needs you admission predicate, send attestation / YOLO
  rules, or default Harness.
- New databases, job systems, checkpoint formats, or public APIs beyond
  a small field or helper on existing tables and modules.
- Activation precision as a research program (P1). This PR proves the
  basic event / time / dependency paths and the hard limits below, not
  a new ranking model.

## Proof method

Add two focused suites, picked up by the existing `npm test` runner
(`test/*.test.js`). Do not add a new CI workflow.

1. `test/product-clauses.test.js` — the four clauses as stories against
   the real engine and stores. Use `SqliteStore` / `DurableRuntime` when
   the story involves connectors, jobs, AttentionBudget, or
   `activation_decisions`. `WorkEngine` plus the existing JSON or SQLite
   store is enough for engine-only slices. Scripted local HTTP and the
   existing simulated mail / document providers are required. No live
   credentials. Times in fixtures must be pinned.

2. `test/connector-regression.test.js` — the connector matrix in the
   Connector regression section. It may call shared helpers and assert
   against existing connector classes. It must not copy the entire
   harness, OAuth, artifact-actions, or sync suites. Where a required
   row is already proved in a companion file, a thin story in this file
   or an explicit assertion that imports / invokes the same helper is
   enough; a comment-only pointer is not enough unless the companion
   test is invoked from this file.

Do **not** copy send-authority, Needs you, release-acceptance, full-chain
recovery, or connector-harness into these files. Those tests already run
in `npm test` (and `npm run test:connectors`) and remain mandatory
companions.

If a clause cannot pass without a behavior change, make the **smallest**
engine / wait / authority / notification / sync change that uses existing
persistence. Prefer a function the engine and the tests both call over a
test-only stub.

List both new files, this lock, and its independent review from
`docs/TESTING.md` and `docs/README.md`. Copy `docs/PRODUCT_CONTRACT.md` into the repository if it is not already
there. The only allowed edit is honesty in the locked-spec list: the
Needs you document is no longer “under implementation,” and this file
may be listed as the implementation lock for the four clauses. Do not
rewrite the contract essay.

## Shared decision record

After each engine turn that assesses, prepares, executes, waits, asks, or
closes a task, WorkEngine must record one follow-through decision the
tests can read:

- `continue` — more agent work is still required and allowed
- `wait` — progress depends on an external event, document, or persisted
  watch; the Situation stays open
- `ask` — the next useful action is the user’s (approval or another
  locked must-enter Needs you reason)
- `close` — the Closure Condition is satisfied, the user already finished
  the work, or the user cancelled; only then may the work become a
  verified or user-closed completion
- `blocked` — the agent cannot continue; a reason is recorded; the work
  is **not** marked complete or verified

Record it on the existing task or Situation whenever ingest, assess,
approve, verify, timer evaluation, or wait resolution changes that
task's next step. A single field is enough. If the durable runtime
already writes `activation_decisions` for this kind of turn, keep that
row consistent with the field; do not add a parallel store, and do not
open a new write path into `activation_decisions` unless it is already
the engine's log for that turn.

The recorded ceiling for that same turn (see Bounded Autonomy) must be
the actual cap the engine obeyed.

## 1. Follow Through

A Situation has a stated goal and a Closure Condition. Do not add a
new closure table. Map the Closure Condition to the existing completion
criteria and verification path (`completionFromCriteria` / verified
ledger status, or an explicit user-finished / cancelled close). A step
finishing is only a reason to ask whether more work is still required.
The user must not be the reminder that the agent should continue.

### Stories (each needs happy, failure, and recovery)

**FT1 — Decision after a step.** After a request is found and evidence is
still missing, the decision is `wait` or `continue` (investigate /
prepare), never `close`. After a draft is prepared and send is not
authorized, the decision is `ask`, never `close`, and nothing is sent.
After a reviewed send is read-back verified and the Closure Condition is
met, the decision is `close` and the work is verified. Failure: marking a
task complete because a draft exists, or because a send was accepted but
not verified, must not yield `close` / verified. Recovery: an unknown
lookup after a provider-accepted send stays unverified and does not
enable a second send (`SEND_AUTHORITY` remains the companion proof).

**FT2 — Wait keeps responsibility.** The Cedar vendor-quote wait already
proved in `test/release-acceptance.test.js` stays: an active external
wait is Waiting, not closed. This file may assert the new decision field
(`wait`) on that same shape without changing the scene contract.

**FT3 — User already finished.** Conservative, explicit signals only:
the user marks the work complete, or an inbound/outbound message in the
same thread is authored by the user (not a ledgered agent send) and
clearly completes the requested deliverable (for example the user already
replied to the vendor). The agent stops, does not send, and records
`close` as user-finished, not as agent-verified send. A ledgered agent
send that later appears as mail is self-echo (IA1), not user-finished.
Failure: a vague “I’m on it,” an unrelated message, or an ambiguous
note does not close the work. Recovery: if the user reopens or a later
explicit request shows the work is still required, the agent may resume
the same Situation or attach per the existing commitment rules, and must
not repeat a previously verified send.

**FT4 — Cannot continue.** When a required source is withdrawn, a
document is unavailable, or evidence is contradictory and the agent
cannot honestly proceed, the decision is `blocked`, a reason is visible
on the task, and status is not completed or verified. This spec does not
add a `blocked` reason to Needs you; Field membership stays exactly
`docs/NEEDS_YOU_ACCURACY_LOCKED.md`. Failure: inventing evidence to force
a close is forbidden. Recovery: when the source or document returns, or
the contradiction is resolved by a later event, the same task can
continue without a second Situation.

**FT5 — Timer due prepares, does not send.** On a pinned `timer.due` for
an open Situation with a promised check (vendor quote still missing),
the engine reevaluates after the schedule, prepares a nudge draft on the
existing prepare path when a nudge is the next useful agent step, and
does not send. The Field stays Waiting unless a locked must-enter
condition is also true (for example the nudge is ready and needs
approval — then `ask`). Failure: a `timer.due` with no state change and
no promised check is an empty scheduled check: no model call, no new
notification, no send, no new task. Recovery: a later matching vendor
reply still clears the wait and continues prepare without sending.

**FT6 — Quiet follow-through.** Through discover, wait, and prepare on
the vendor-quote story, no progress notification is emitted. Completing
a verified send is recorded in history / Activity. By default it does
not interrupt (default quiet). Do not add a new completion-toast
product. `SEND_AUTHORITY` and `test/notifications.test.js` remain
companions for attestation and default quiet.

## 2. Bounded Autonomy — farthest safe step

Autonomy is a ceiling for the current evidence, grant, and risk, not a
fixed stop level. Implement one deterministic function, used by
WorkEngine and by the tests, that returns a ceiling and a reason:

| Level | The agent may | User needed? |
| --- | --- | --- |
| L0 Observe | Watch, link, record | No |
| L1 Investigate | Search, read, analyze, check | No |
| L2 Prepare | Drafts, plans, internal artifacts | No |
| L3 Execute | In-scope, already authorized, bounded operations | Per the grant |
| L4 Consequential Action | Send, publish, buy, delete, or other consequential external effects | Approve by default |

Gates, in this order: **Evidence**, **Authority**, **Risk**
(reversibility and impact). A standing grant or YOLO lease may move a
*narrow* L4 action without a fresh click only when
`docs/SEND_AUTHORITY_LOCKED.md` already allows it. Ask-first /
`requiresReview` still beats auto-allow. Attestation releases a failed
send and never lets YOLO auto-send the replacement.

The function must not be a test-only double. Engine execute / approve /
apply-patch / send paths must refuse work above the recorded ceiling.
Do not let Harness or the model mint a higher ceiling.

### Stories

**BA1 — Evidence first.** With a request but missing required evidence,
the agent does not execute and does not send (ceiling below L3 / L4).
Investigation is L1. If the next useful agent step is a draft or a
promised nudge, L2 prepare is allowed; that is how FT5 can prepare a
nudge while a quote is still missing. Failure: a model proposal to
“just send a reminder now” does not raise the ceiling to L3 or L4.
Recovery: when the evidence arrives, the ceiling may rise on the next
turn and prepare or ask may continue.

**BA2 — Authority caps execution.** With enough evidence to draft, but
no user approval and no valid YOLO grant, the ceiling is L2: a draft may
exist, nothing is sent, decision is `ask`. Failure: a forged or
planner-created grant is rejected (`test/autonomy.test.js` remains the
companion for lease validation). Recovery: after an explicit approval or
a valid user-issued grant, a narrow in-scope action may proceed under
the locked send rules.

**BA3 — Risk caps L4.** A consequential external send, publish, or
delete stays L4 even when evidence is complete. It needs approval, or a
lock-allowed narrow grant. A reversible internal draft is L2 and must
not be treated as L4. Failure: `requiresReview` or an explicit user
policy that requires review blocks automatic write even if a grant
exists. Recovery: after review, the already prepared action can proceed
once; a changed draft or input version needs a new review.

**BA4 — Grant end stops work.** Expiry, revoke, pause, or completion of
a task-scoped lease stops further automatic execution immediately and
cancels undispatched YOLO work, as today. Failure: a cancelled lease
must not revive because the task was reopened. Recovery: a new
user-issued grant is required. Companion: `test/autonomy.test.js`.

## 3. Selective Attention — interrupt only when irreplaceable

Needs you membership remains exactly
`docs/NEEDS_YOU_ACCURACY_LOCKED.md`. This spec does not add rows.

Notification and Pacer rules use the existing `notification()` helper
and, in durable workspaces, `AttentionBudget`:

- Ordinary progress (observed, correlated, prepared, verified): no
  notification. Already the default in `src/notifications.js`; prove it
  on the clause stories.
- Low-priority completion: history / Activity only.
- Important completion: default quiet unless an existing kind already
  applies (deadline, risk, permission, blocker). Do not invent a new
  kind or a preference product in this PR.
- Waiting on an external reply: watch quietly.
- Approval or other locked must-enter: Needs you, with what happened,
  why now, and what the user must do (not a bare “needs your
  attention”). If the surface is a notification, it must already satisfy
  the `what` / `why` / `checked` / `decision` constructor. If the surface
  is a Field row, the same three facts must be visible on that row.
- Important block with a tight deadline: existing deadline risk
  (calendar day, not invented from bare text; default window stays the
  existing `deadlineRisk` helper) may interrupt.
- Low-confidence, low-value finds: no interrupt and no Needs you.
- The same problem recurring: merge via existing `dedupeKey` /
  `issue_key`; do not emit a second open notification.
- No new information on the same Situation: do not remind again. A
  resolved notification revives only when the condition genuinely
  recurs, as today.
- Low-priority notices may be deferred with the existing
  AttentionBudget digest / pending path (hourly cap, min interval,
  issue cooldown, quiet hours). That path must not remove or hide a
  must-enter Needs you row from the Field.
- Do not build a new digest scheduler.

### Stories

**SA1 — Quiet progress, interrupt for a real decision.** Vendor-quote
discover / wait / prepare emits no notification. A close, unambiguous
deadline on incomplete work may emit a deadline notification and, if
the locked predicate says so, Needs you. A distant deadline stays
quiet. Recovery: when the work is verified or the deadline is removed,
the deadline notification resolves and does not linger as unread work.

**SA2 — Merge and no empty remind.** Two evaluations of the same
unresolved decision reuse one notification identity. A second
evaluation with no new information does not create a second
interruption. Failure: a notification that cannot state what / why /
decision is refused at construction (companion:
`test/notifications.test.js`). Recovery: after resolve, a genuine
recurrence may revive the same identity as unread.

**SA3 — Budget may delay a notice, not the Field.** With AttentionBudget
at an interactive cap, in quiet hours, or inside the min interval, a
non-critical notification may be `pending` or `digest`. A locked
must-enter Needs you row for that task still appears in the Field.
Failure: dropping the Field row because the notification was deferred
is a defect. Recovery: `releaseDue` may later deliver the notice
without creating a duplicate Needs you row.

## 4. Intelligent Activation — event, time, dependency; not every signal

Do not claim push delivery. Polling may remain the transport. Activation
*policy* is: start or resume only on a meaningful change.

Trigger classes in this PR:

- **Event** — new mail, a Slack reply, a file change: update evidence
  and decide whether to advance.
- **Time** — a promise comes due, a deadline nears: reevaluate (FT5).
- **Dependency** — approval, a tool result, restored permission: resume
  waiting work.

Pipeline: new event / timer / dependency → deterministic filter
(dedupe, self-echo, irrelevance) → Situation match → semantic or model
evaluation only when the state change or uncertainty warrants it →
continue / wait / ask / close / blocked.

Hard limits:

- A Situation / task has a recorded last-evaluation time. An empty
  scheduled check (no new evidence, no due promise, no permission
  change) must not call the model and must not emit a notification.
- Failed triggers back off using existing job / sync retry behavior;
  do not add a new backoff service if one already exists.
- Several events in the same ingest or sync pass may be folded into one
  evaluation of the same task.
- User edits or cancels must stop related work promptly (companions:
  release-acceptance scenes 3 and 5).
- The agent’s own sent mail, or another self-echo of an agent write,
  must not start a new Situation or reopen a verified send.

### Stories

**IA1 — Filter before advance.** A duplicate provider event is a
duplicate (no second Situation, no second evaluation that creates
work). An email the agent just sent, appearing as an inbound or sent
item, does not start new work (Gmail’s existing sent-exclusion is not
enough by itself if another connector can echo the send). An unrelated
lunch message does not attach to Cedar and does not call a model to
“see if it matters.” Recovery: a later real Cedar reply still matches
and resumes.

**IA2 — Time and dependency wakes.** `timer.due` for a promised check
reevaluates the same Situation (FT5). Approving a prepared draft, or
restoring a withdrawn permission that was blocking the task, resumes
the existing task and does not create a sibling. Failure: a timer for
a completed or cancelled Situation is a no-op. Recovery: after
permission is restored, the next evaluation continues from saved
evidence without repeating a verified write.

**IA3 — Fold and empty check.** Two source events about the same open
Cedar commitment in one ingest / sync pass produce one evaluation and
at most one decision record for that turn, not two competing drafts.
If the same task is evaluated again later, it must still have at most
one open draft and one ready action.
An empty `timer.due` with no change produces no model call, no
notification, and no new draft. Recovery: a later real state change
still evaluates once.

## 5. Connector regression

“Complete” here means: every shipped first-party connector below has
scripted proof of the sync contract, and every write-capable connector
already in the harness / artifact-actions matrix stays covered. It does
**not** mean live-account acceptance.

### Connectors in the matrix

| Connector | Sync in this matrix | Writes |
| --- | --- | --- |
| Google Gmail | Required | Send / draft: companions `test/artifact-actions.test.js`, `test/google-durable-workflow.test.js`, `test/send-authority-locked.test.js` |
| Google Drive / Docs | Required | Document patch: companions already in release-acceptance and task-services |
| Google Calendar (selected calendars) | Required | None in this PR |
| Microsoft Outlook | Required | Draft / send companions as today |
| Slack | Required | Read-only in current product; no new write path |
| Notion | Required | Page creation companion in artifact-actions / harness |
| GitHub | Required (issue, PR, commit / Actions as already ingested) | No new write path |
| Local files | Required | No overwrite of user edits (scene 3 stays the proof) |
| Apple Notes | Required, injected responses only | Creation companion in artifact-actions |
| Apple Reminders | Required, selected lists, injected responses | No new write path |
| Apple Mail, Calendar, Contacts | Required, injected / scripted only | No new write path |
| Todoist | Required, token flow, paginated snapshots | No new write path |
| Simulated | Already the engine default; do not treat it as a live provider | Simulated send remains labeled simulated |

MCP presets, bundled Fetch, and device / code OAuth protocol fixtures
stay in their companion files (`test/device-oauth.test.js`,
`test/code-oauth.test.js`, `test/connector-contracts.test.js`). This
matrix does not re-litigate OAuth protocol, but a **revoked or expired
token during sync** must appear as a failure/recovery row for each
cloud connector that uses a token.

### Sync contract (happy, failure, recovery) for each required connector

**Happy.** A scripted pull of new items ingest events of the type that
connector actually emits, advances the cursor or watermark only after
successful ingestion, and marks that connector healthy. Sibling
connectors are unaffected.

**Failure.** Each of the following, where the transport can produce it,
must not advance the cursor as if the pull succeeded, must not mark the
connector healthy, must not invent events, and must not execute
external writes:

- 401 / revoked or expired token
- 429 rate limit
- Transient 5xx or timeout
- Malformed or partial page (checkpoint for that scope is retained;
  other scopes are not withdrawn)
- Missing or withdrawn scope / disconnect mid-sync

A failure on one connector must let a sibling connector proceed.
Companion already covers a generic pull 429 in `test/sync.test.js`;
this matrix must show that the same contract holds for each required
cloud connector, not only one fixture.

**Recovery.** A later successful pull after 401 (following a scripted
token refresh or reconnect), 429, or 5xx / timeout ingests the missed
items without creating duplicate Situations or duplicate events for the
same provider identity. Replaying the same provider event is
idempotent across a process restart. After disconnect, withdrawn
source content is excluded from new task context (harness companion
for Notion suppression may be reused). After reconnect, work resumes
on the existing Situation when the event matches; a verified write is
not repeated.

Apple and native sources use injected responses. TESTING.md must stay
explicit that a real Notes / Mail / Automation prompt still needs
manual acceptance.

If a row is already fully asserted in `test/connector-contracts.test.js`,
`test/connector-harness.test.js`, `test/connectors.test.js`,
`test/connectors-multi.test.js`, `test/connectors-slack-notion.test.js`,
`test/zero-config-connectors.test.js`, `test/native-sources.test.js`, or
`test/sync.test.js`, the regression file should still name the
connector and exercise the missing failure or recovery, or invoke a
shared helper so the matrix is complete in one place.

## Honest documentation

`docs/TESTING.md` must describe this proof and keep the existing honesty
about scripted HTTP, simulated providers, and the lack of live-account
and push validation. Do not claim the four clauses are production-
validated with real users. Do not claim the six product metrics are
instrumented beyond what `activationMetrics` already reports.

## Allowed residuals (not must-fix in this PR)

- Context-prefetch when the user opens a related project.
- Labeled metric rates that `activationMetrics` already marks unknown.
- Substring quote / entity matching and other residuals already accepted
  in the release-acceptance lock.
- Live provider push, real OAuth, and macOS Automation.
- #22 residuals (in-process `issueCredential` export, shared send+verify
  timeout) and plaintext workspace SQLite.
- Memory / RSI.

## Acceptance

The implementation PR is ready for coordinator review when:

- The locked files in this document are copied unchanged.
- `test/product-clauses.test.js` covers FT1–FT6, BA1–BA4, SA1–SA3, and
  IA1–IA3, each with happy, failure, and recovery assertions.
- `test/connector-regression.test.js` covers the matrix above.
- Existing locks still pass: send-authority, Needs you, release-
  acceptance, autonomy lease tests, notification constructor tests,
  connector harness.
- `npm test`, `npm run check:public`, and `npm run check:syntax` pass
  locally. CI of the PR must be green before merge.
- Do not merge until the owner explicitly asks.
