# Locked spec: release acceptance proof (six scenes + connector paths)

Status: **locked for implementation** (2026-11-10). Coordinator-owned. Do not
edit this file in the implementation PR except to copy it unchanged into
`docs/RELEASE_ACCEPTANCE_LOCKED.md` and to list it from `docs/README.md` /
`docs/TESTING.md`.

This change is a **proof** change, not a platform change. The product owner
required: an item does not pass because the feature exists; it passes only
when the happy path, failure path, and recovery path are demonstrated. Do
not add substantial new infrastructure to make the checks pass. Use the
existing WorkEngine, SQLite durable store, state machines, execution ledger,
ConnectorSync, notifications, and `node:test` fixtures.

This spec does **not** reopen or weaken:

- `docs/SEND_AUTHORITY_LOCKED.md`
- `docs/NEEDS_YOU_ACCURACY_LOCKED.md`

The four Field zones stay Needs you, In motion, Waiting, and Watching
(plus paused / done in the Watching group). Activity remains a quiet
record, not a fifth zone. Do not collapse the Field into three states.

## Goal

After this change, CI on scripted fixtures can repeatedly prove:

1. The six end-to-end release scenes below (happy, failure, recovery).
2. The main connector happy / failure / recovery paths that can be proved
   without a real third-party account.

The three product questions this gate is in service of:

1. Can the agent discover and advance work itself?
2. Can it complete that work reliably?
3. Can the user almost not manage it?

This PR is not a claim that those three questions are fully answered in
production, or that live Google / Outlook / Slack / GitHub / Notion
authorization has been accepted on real accounts.

## Out of scope (must not grow this PR)

- Memory and Experience / RSI quality work (P1). Undo in scene 5 must still
  take effect immediately; do not build a new learning platform.
- A metrics warehouse, new attention-budget service, or new event bus.
  Existing notification quiet / merge / deadline tests stay the gate for
  those rules. The vendor-quote story must not emit progress notifications.
- Real-account OAuth, provider push delivery, or macOS Automation.
  Keep Known-limits wording honest: these checks are scripted HTTP /
  simulated providers. Do not write README or TESTING claims that live
  connectors are production-validated.
- Changing the Needs you admission predicate, send attestation / YOLO
  rules, or default Harness.
- New databases, job systems, checkpoint formats, or public APIs beyond
  what is required to close a documented behavior gap with existing
  tables and state machines.
- Landing the full product-contract essay unless a one-line pointer from
  TESTING / README is useful. Do not rewrite product strategy docs.

## Proof method

Add one focused suite, `test/release-acceptance.test.js`, that tells the
six scenes as stories against the real engine and stores. Use
`SqliteStore` / `DurableRuntime` when the scene involves connectors,
jobs, or crash recovery; `WorkEngine` + the existing JSON or SQLite store
is enough for engine-only slices. Scripted local HTTP and the existing
simulated mail / document providers are required. No live credentials.

Do **not** copy the entire send-authority, sync, full-chain-recovery, or
Needs you suites into this file. Those tests already run in `npm test`
and remain mandatory companions. The new file must contain the
**missing cross-module stories** and, where a companion already proves a
scene path, a short scene-level test or an explicit comment plus
assertion that the companion file is the proof (see the mapping table).
Prefer a real thin story over a comment-only pointer when the story is
not already end-to-end in one existing test.

Do not add a new CI workflow. The file must be picked up by the existing
`npm test` Node runner (`test/*.test.js`).

If a scene cannot pass without a behavior change, make the **smallest**
engine / situation / wait / patch change that uses existing persistence
(`tasks`, `taskWaits`, `event_situation_links` or the JSON-store
equivalents, the tool execution ledger, document patches, notifications).
Do not invent a parallel correlation store.

## Scene contracts

Each scene below has a happy path, a failure path, and a recovery path.
All three must be asserted. Times in fixtures must be pinned (do not use
“today” as a deadline). Use a distinctive entity (for example `Cedar`
vendor quotes), not a hard-coded Northstar-only path.

Field membership, when asserted, must use the same
`needsUserAttention` / zone mapping as `docs/NEEDS_YOU_ACCURACY_LOCKED.md`
(shared `admissionContext`, including `taskWaits`). While waiting for a
vendor reply with an active external wait, the work belongs in Waiting,
not Needs you, unless a locked must-enter condition is also true.

### Scene 1 — New mail + Slack, one commitment

**Happy.** A Gmail (or engine `email.received` from the Google connector
shape) and a Slack direct message (the event type the Slack connector
actually emits) both state the same commitment — same subject entity and
deliverable, e.g. collect vendor quotes for Cedar. After both are
ingested, there is **one** open Situation and **one** task for that
commitment, with both source events linked to it. The Field shows that
one task, not two sibling rows. The agent does not send.

**Failure.** An unrelated Slack message (lunch, a different entity) does
not merge into that Situation and does not create a second task for
Cedar. A non-request email remains context-only, as today.

**Recovery.** Replaying the same provider event from either source
(duplicate webhook or poll) is a duplicate: no second Situation, no
second task, no extra notification. A process restart and a second sync
pass do not recreate the work.

**Allowed implementation.** When the second source event matches an
already open commitment (same subject entity and deliverable, using the
existing request-signature / commitment machinery), attach it to that
Situation **and that existing task**. Do not create a second task and
hide it with Field grouping. Do not merge two lives that only share a
generic noun (“quotes”, “proposal”). If today’s task id is
`request:<sourceMessageId>`, keep the first stable id; do not invent a
new global id scheme. The later event is a linked source on the same
task, not a replacement key.

### Scene 2 — Wait for the vendor, then resume

This is the vendor-quote follow-through slice.

**Happy.** The Situation is open; at least one quote is still missing.
The task enters a persisted external wait (`WAITING_EXTERNAL` /
`waiting_for_information` with an **active** `taskWaits` or
`waitForTask` record). It does not close, does not send, and does not
enter Needs you solely because it is waiting. A later vendor reply (mail
or the scripted connector event) with the missing quote resumes the
**same** Situation and the **same** task: the wait is cleared, evidence
records that the quote arrived, and the task may move to prepare or
`ready_for_approval` when the locked evidence rules say the work is
complete enough. Still do not send. Do **not** build a new quote-comparison
product feature to pass this scene; recording the resumed evidence and
continuing the existing prepare path is enough.

A scheduled or time-based check may **prepare** a nudge. It must not
send the nudge without the locked approval path.

**Failure.** Unrelated mail or a different vendor does not satisfy the
wait. Incomplete evidence does not become a verified close. An unknown
send/verify outcome does not count as the quote having arrived.

**Recovery.** Restart while the wait is active must preserve the wait
without rewriting an unchanged state (same rule as the existing
commitment-lifecycle recovery test). After restart, the vendor reply
still resumes the same Situation.

### Scene 3 — User edits the external file; do not overwrite

**Happy.** A document patch or connector-backed write is prepared
against a known base version. The remote (or local persisted) document
then changes in a user-visible way (new text, new version). Applying the
prepared write is refused. The user’s text remains. Nothing is sent that
would overwrite that revision.

**Failure.** A revision mismatch or read-back mismatch is stale or
uncertain, never “verified.” UNKNOWN / uncertain must not trigger a
second write. A formatting-only revision may be ignored by an existing
document wait; a semantic user edit must not be overwritten.

**Recovery.** The existing interrupted-apply path remains: after a crash
while applying, the patch is uncertain and cannot be replayed after
restart. The release suite may cite `test/task-services.test.js` for this
recovery if the happy/failure story is asserted in the new file against
the same `applyDocumentPatch` / Google Docs writeControl machinery.

Do not weaken: “the Google Docs writer refuses a revision mismatch
before sending a write” and “an interrupted applying patch recovers as
uncertain.”

### Scene 4 — User approves a send; read-back; no second send

**Happy.** After approval bound to the reviewed action, the provider
accepts, read-back verifies, the task may close only when verification
succeeds, and the outbox / ledger shows one send.

**Failure.** Timeout or unknown lookup stays uncertain / blocked; retry
is refused until absence is confirmed; a changed review token is
rejected; YOLO / standing grants must not auto-send a replacement after
attestation — all as already locked.

**Recovery.** Restart or reconcile after acceptance must not dispatch a
second external send.

The new file should include a thin scene on the vendor-quote Situation
(approve → verify → single send). Detailed ledger, attestation, 429, and
hung-POST cases stay in `test/send-authority-locked.test.js`,
`test/workflow.test.js`, and `test/full-chain-recovery.test.js`. Do not
reimplement or relax them.

### Scene 5 — User Undo stops the mistake immediately

**Happy.** The user records a correction (wrong association, not-mine,
or an explicit undo of that feedback). The correction is persisted
immediately. The next related event must **not** repeat the same
mistake: an excluded document stays excluded; a not-mine sender does not
re-enter as new work in that scope; a suppressed or dismissed send is
not sent.

**Failure.** Undo of work already accepted by the provider does not
unsend, and does not send again. The existing
“withdrawal after provider acceptance preserves the action and reports
it was not undone” behavior stays.

**Recovery.** Restart after undo keeps the correction; the mistake does
not come back from old events or from Experience / RSI. This scene must
not grant Experience any authority. If no Experience row is involved,
asserting engine feedback + restart is enough; do not add an RSI
subsystem to pass the test.

### Scene 6 — Process crash and restart; no repeated side effects

**Happy / recovery.** After a crash following remote acceptance, and
after crashes during or after local feedback, recovery completes the
task without a second send, with one verified write in the ledger.

**Failure.** An unknown lookup during recovery must not enable a second
send.

`test/full-chain-recovery.test.js` is the primary proof for the durable
runtime crash path and **must remain green**. Do not copy that worker
into the release file. The release suite must still assert
restart-without-resend on the vendor-quote approve/send path (scene 4
recovery), using the existing WorkEngine restart style in
`test/workflow.test.js` or by opening the same store after close.

Existing WorkEngine restart tests in `test/workflow.test.js` stay.

## Connector happy / failure / recovery

Do not rebuild the connector test matrix. Complete the mapping below in
the locked review and in `docs/TESTING.md` (a short “release acceptance”
row). Add a new connector test **only** when a row has no existing proof.

| Requirement | Existing proof (main, as of this lock) | New work |
| --- | --- | --- |
| Scripted authorize + read for Google, Outlook, Slack, GitHub, Notion | `test/connector-harness.test.js`, `test/connectors-slack-notion.test.js`, Google / Outlook fixtures | None unless a source cannot read in the harness |
| Incremental sync, pagination, checkpoint, disconnect recovery | `test/sync.test.js` (cursors survive restart; pages commit only after ingest; revoked connector is not pulled) | None if those tests stay green |
| Duplicate webhook / poll does not duplicate events | `test/sync.test.js` replayed provider event; scene 1 recovery | Scene 1 must cover cross-source replay |
| Multi-source sync does not block siblings | `test/sync.test.js` timeout remains fenced while others proceed; malformed pull does not stop other connectors | None |
| OAuth expiry, revoke, rate limit, network timeout | device-oauth / permission-refresh / send-authority 429 and hung Gmail POST; sync revocation | If 429 on a **connector pull** is untested, add one scripted case in `test/sync.test.js` or the release file: do not advance the cursor, do not mark simulated success, other connectors proceed |
| External write then remote read-back | artifact-actions, task-services Google Docs read-back, send-authority | None |
| Disconnect stops access; credentials not leaked in public status | sync revoked connector; `public sync status does not disclose provider continuation tokens` | None |
| Sync time / health visible without secrets | same public sync status test | None |

Real-account acceptance stays a Known limit, not a CI gate.

## Notifications and metrics (this PR only)

Do not add new metric tables or jobs. In the vendor-quote scenes:

- Discovering, waiting, and preparing emit no notification (existing
  default-quiet rule).
- The same Situation does not raise a second identical decision.
- A true Needs you approval still appears when the user must approve a
  send, per the locked predicate.

Miss / false-interrupt / verified-completion **recording** may be
asserted only with existing APIs (`recordMiss`, notification resolve,
verified action / ledger status, existing outcomes helpers in
task-services). If a counter does not exist, do not invent a metrics
pipeline in this PR; leave it as a documented P1 gap in TESTING.

## Implementation constraints

1. Smallest change that makes the scene contracts true.
2. No new infrastructure “for the tests.”
3. Do not change production deadline-risk or Needs you rules to make a
   fixture pass; pin fixture clocks and deadlines instead.
4. Do not default unmapped states into Needs you.
5. Standard remains the default Harness; Pi stays optional and untested
   in this file unless a scene already runs through DurableRuntime.
6. Update `docs/TESTING.md` with a “Release acceptance” section that
   names the six scenes, this locked doc, and the companion files.
7. Copy this locked file into the repo unchanged. Copy the independent
   spec review when the coordinator provides it.
8. English for code, tests, and this document. User-facing Field labels
   already in i18n stay as they are.
9. Do not merge without an explicit product-owner ask.

## Acceptance of this PR

CI on the branch is green, including `test/release-acceptance.test.js`
and the companion files named above. A reviewer can run the six scenes
and see happy, failure, and recovery assertions for each. README /
TESTING do not claim live connector production validation. Locked send
and Needs you tests still pass without weakening.
