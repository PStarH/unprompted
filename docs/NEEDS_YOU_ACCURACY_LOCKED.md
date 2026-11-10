# Locked spec: Needs you accuracy

Status: **locked for implementation**. Historical product notes about “Needs you
is still being tuned” are superseded by this document where they conflict.

This is the paid-release bar for attention accuracy: Unprompted may interrupt
the user only when the next useful action is theirs, and it must not hide a
real block. It does not add zones, chat spam, or new animations.

Grounded in `main` at `b3e0340` (send read-back + Authority already landed).
Primary code: `public/workspace-model.js` (`taskState`, `stateGroup`),
`public/ux-state.js` (`decisionQueue`, `visibleAttentionItems`),
`public/workspace.js` (Field zones and `J`/`K`), `src/task-management.js`
(`nextActionFor` / `ownerFor`), `docs/SEND_AUTHORITY_LOCKED.md`.

## Product meaning

Needs you is the Field zone labeled “Needs you” / 「需要你」, plus the same
items in the decision queue, `J`/`K` walk, and non-digest notifications that
point at those items.

A task belongs there if and only if **the next useful action is the user's,
and the agent cannot usefully continue without that action**.

The other Field zones stay:

- **In motion** — the agent is investigating, preparing, sending, or still
  verifying an in-flight attempt.
- **Waiting** — progress depends on an external event, a document change, or
  a persisted wait that has not been interrupted.
- **Watching · paused · done** — observing-only source work, user or policy
  pause, or a finished/closed task.

Copy in every zone must name the actual state in words. Do not say “Needs
you” in Watching or Waiting copy.

## Current defects (must fix)

These are observed in the current classifiers, not hypothetical:

1. **In-flight work is treated as an interruption.** `taskState` maps
   `status === 'verifying'` and `action.status` in `executing` /
   `accepted_live` / `uncertain` to `result_unverified`. `stateGroup` puts
   `result_unverified` in the attention (Needs you) group. Tests in
   `test/ui-render.test.js` currently require `agentPresentation` for a
   verifying task to use tone `needs`. That is a false positive: the agent
   is still working or still reconciling automatically.

2. **Unmapped states default to Needs you.** `taskState` falls through to
   `unknown`, and `unknown` is in the attention group. A new or overlooked
   status therefore interrupts the user.

3. **User-owned waits can hide in Waiting.** `waiting_for_information` always
   becomes `waiting_external`. `nextActionFor` can still assign the next
   action to the user (provide missing information; choose after a deferred
   or failed shared dependency; review an interrupted wait). Those are false
   negatives.

4. **Source disconnect is too broad.** Any task whose connector is
   `connected === false` becomes `source_disconnected` and therefore Needs
   you, including observing-only GitHub / local to-do tasks that should stay
   in Watching with a written status.

5. **Classifiers disagree.** `decisionQueue` only includes
   `ready_for_approval` and `blocked` with an `action`. The Field Needs you
   zone also includes failed, disconnected, in-flight unverified, and
   unknown. `J`/`K` uses the Field set. One definition must drive all of
   them.

6. **Locked send/authority rules are not fully reflected in the zone.**
   Unverifiable platform / MCP writes stay ledger-only and must not become
   Needs you. In-progress automatic reconciliation (up to four inconclusive
   passes) must not become Needs you. After the cap, or when the user must
   attest Sent-absent, the task *must* become Needs you.

## Locked admission predicate

Compute a single boolean `needsUserAttention(task, state)` (name may differ)
and derive presentation from it. Do not keep a second ad-hoc list in the
workspace, the queue, or keyboard navigation.

### Must enter Needs you

| Situation | How to recognize in current records | User action |
| --- | --- | --- |
| Approve a prepared external effect | `ready_for_approval`, or prepared work that `requiresReview`, and no in-scope standing grant / YOLO lease is executing it automatically | Review and approve, edit, or reject |
| Terminal send/execution uncertainty | Do **not** infer this from `action.status === 'unknown'` or `'uncertain'` alone — those values are also used while automatic reconciliation is still running. Terminal Needs you requires an **explicit recorded close**: `reconciliation_inconclusive` (the #22 cap flag after four unsuccessful recoveries of the same attempt), a user attestation request, or an equivalent explicit recorded close already persisted by the send path. Count alone in the UI is not sufficient if the engine has not written the flag. Until that record is set, leave the task in motion even if status is `blocked` + `unknown`/`uncertain`. If the engine today only implies the cap, add the flag so the UI predicate stays honest. | Reconcile, attest absence, or choose the next attempt (new key, fresh approval; YOLO must not auto-send the replacement) |
| Failed work that needs a choice | `reasoning.status === 'failed'` or `action.status === 'failed'`, and a second automatic POST / retry is not safe | Read the failure and choose (retry only when a new attempt is allowed) |
| Source disconnect that blocks work already in progress or ready | Provider disconnected **and** the task is not observing-only (see below) | Reconnect or close / pause the task |
| Evidence conflict that already blocks progress | Only when a recorded `evidence.conflicts` entry already stops the engine from continuing and a human reading is required. Do not invent a new conflict-intake path in this change. Priority scoring of conflicts is not by itself admission to Needs you. | Choose the reading |
| Interrupted wait | `wait.status === 'interrupted'` (deadline or evidence risk) | Choose what happens next |
| Missing information only the user can supply | `nextAction.kind` is `provide_information`, `resolve_dependency`, or `decide` (including deferred-without-wake and failed/dismissed shared dependencies). Do **not** require `owner.id === 'user'`: `ownerFor` often returns `unknown` for `waiting_for_information`. Do **not** treat `wakeFor`'s synthetic document/event wake (`status: 'waiting'` invented when no persisted wait exists) as an active wait. Only a persisted `wait.status === 'active'`, or an equivalent recorded watch the agent is actually polling, keeps the task in Waiting. | Provide the fact, source, or decision |
| Shared dependency needs one human answer | Open, deferred-without-wake, or failed/dismissed unresolved shared dependency | Answer **once** on the shared band; do not also list every child task as a separate Needs you row |

### Must not enter Needs you

| Situation | Zone instead |
| --- | --- |
| Newly discovered, investigating, preparing, reasoning running | In motion |
| In-flight send or verify: `executing`, `accepted_live`, `verifying`, or `uncertain`/`unknown` **while no terminal close flag is recorded** and automatic reconciliation is still allowed | In motion. Presentation may say the result is not confirmed yet; that is not an interruption. |
| Unverifiable platform / MCP write (no read-back spec) | Stay on the current non-attention path; record unverified in the ledger only. Do not open a Needs you card or mark the task completed as if verified. (`docs/SEND_AUTHORITY_LOCKED.md`) |
| Active uninterrupted wait for a source, document, or time | Waiting |
| Observing-only kinds: `external_issue`, `external_review`, `external_change`, `external_check`, `observed_task`, including when their source is disconnected | Watching. If disconnected, write “source disconnected” on the row. Promote to Needs you only if the same item also matches a must-enter row above (for example the user already had a prepared action). |
| User pause or activation policy hold | Watching (paused) |
| Completed, cancelled, user-dismissed, or `blocked` **without** an action | Watching · done / stopped. Existing `isFinished` behavior for `blocked` without an action stays. |
| Ready work that a standing grant or YOLO lease is already executing | In motion only after execution has **actually started** (`action.status` is `executing` or `accepted_live`, or `status === 'verifying'` after dispatch). A draft that is still `ready_for_approval` stays in Needs you, even if a lease *could* take it next. If the lease is paused, revoked, or out of scope, it remains or returns to Needs you. |
| Unmapped / leftover presentation state | **Never** default to Needs you. Classify as In motion if the agent still owns the next step, otherwise Waiting or Watching. Add a test when a new status is introduced. |

### Tie-break

Evaluate in this order:

1. Finished / cancelled / dismissed / `blocked` without an action → not Needs you.
2. User pause (`control.paused`) or activation policy hold → Watching (paused), even if the task would otherwise need the user, until the user resumes.
3. Ledger-only unverifiable writes (no read-back spec) → not Needs you.
4. Observing-only kinds, unless they also carry a must-enter prepared action, terminal unknown, or failed unsafe-to-retry action → Watching. A disconnected observing-only source stays here with written status.
5. Terminal send uncertainty (explicit close flag, cap reached, or attestation request), failed unsafe-to-retry action, or source disconnect that **blocks continuing** ready or in-flight work → Needs you. Disconnect beats “still in flight / In motion”.
6. In-flight send or verify while automatic reconciliation is still allowed → In motion.
7. Other must-enter rows (approval still `ready_for_approval`, user-owned missing information, interrupted wait, shared dependency decision).
8. Unmapped leftover state → never Needs you; In motion if the agent still owns the next step, otherwise Waiting or Watching.

## Presentation and copy

- One definition drives Field zones, List/Lanes/Focus grouping, the decision
  queue, `J`/`K`, and non-digest attention notifications.
- Shared waits remain one band above the zones. Child tasks of that wait do
  not also occupy Needs you.
- Status text must say the reason: “draft ready”, “result still unconfirmed —
  say whether it arrived”, “source disconnected”, “provide X”, not a generic
  “open to review”.
- Do not add notification or chat lines for ledger-only unverifiable writes.
- Do not auto-open a task page. Do not invent a fifth zone.
- Existing quiet visual rules in `docs/UI_DESIGN.md` still apply.

## Engine / Activation

This change is not only CSS. If a recorded status would violate the
predicate (for example the engine leaves a verifying task in `blocked` before
the cap, or puts unverifiable MCP writes in `blocked` with an action so the
UI would have to special-case them), **change the recorded status or a
dedicated flag** so the predicate stays honest.

Keep `docs/SEND_AUTHORITY_LOCKED.md` behavior: no second POST of a dispatched
key; attestation closes the old attempt only; the next send uses a new key
and a fresh approval.

Activation suppress / notification budget must not hide a must-enter Needs
you item from the Field zone. They may still batch or delay **notifications**
(push / digest) as they already do. The zone itself is the source of truth
when the user is looking at Work.

## Tests (minimum)

Replace, do not keep, assertions that a merely `verifying` or in-flight
`executing` / `accepted_live` task presents as Needs you / tone `needs`.

Required cases:

1. `verifying` or `action.status === 'executing'|'accepted_live'` → In motion,
   not in `decisionQueue`, not in `J`/`K`.
2. `blocked` + `action.status === 'unknown'` **without** a terminal close flag
   → In motion. After `reconciliation_inconclusive` / attestation
   request → Needs you; offer reconcile / attest, not approve or a second POST.
2b. `waiting_for_information` with only a synthetic `wakeFor` document/event
    wake, and `nextAction.kind === 'provide_information'` → Needs you, not Waiting.
2c. Source disconnect on an in-flight or `ready_for_approval` task → Needs you;
    observing-only disconnect → Watching.
2d. Still `ready_for_approval` with an in-scope standing grant that has not
    started execution → Needs you.
3. Unverifiable write (no verify predicate) → not in Needs you; task not
   marked completed-as-verified.
4. `waiting_for_information` with no active wait, next action owned by the
   user → Needs you.
5. `waiting_for_information` with an active document/source wait → Waiting.
6. `wait.status === 'interrupted'` → Needs you.
7. Observing-only GitHub (or local to-do) + disconnected source → Watching,
   not Needs you.
8. `ready_for_approval` stays Needs you. Once the same grant has started
    execution (`executing` / `accepted_live` / `verifying`) → In motion.
9. Failed action when a second POST is unsafe → Needs you; no Retry if
   already dispatched.
10. `taskState` / `stateGroup` never map an unspecified fallback to
    attention. Cover at least one deliberate unmapped fixture.
11. Shared open dependency: one band, not N Needs you rows; deadline/risk
    notices still visible (`visibleAttentionItems` already has part of this).
12. Decision queue, Field zone, and `J`/`K` agree on membership.

Update `test/ui-render.test.js`, `test/ux-state.test.js`, and add a focused
`test/needs-you-accuracy.test.js` (or equivalent) around `taskState` /
`stateGroup` / the shared predicate. Browser coverage is welcome but not the
minimum bar.

## Out of scope

- Connector flaky-network / regression stability (separate paid gate).
- Push vs polling, calendar, multi-user, workspace SQLite encryption.
- Changing YOLO or standing-grant *authority* rules (already locked). This
  spec only places those tasks in the correct zone.
- New notification channels.

## Locked product decisions

1. In-flight verify is In motion, even if the result is not yet confirmed.
2. Terminal unknown after the cap is Needs you.
3. Ledger-only unverifiable writes stay off Needs you (already decided).
4. User-only missing information is Needs you; source-watched missing
   evidence is Waiting.
5. Observing-only disconnect is Watching with written status.
6. Unmapped states never default to Needs you.
7. One predicate for every surface.
8. A ready draft stays in Needs you until execution has actually started.
9. Terminal uncertainty is flagged explicitly; `unknown`/`uncertain` alone is not enough.
10. Synthetic `wakeFor` watches are not Waiting.

No further product decision is required to implement this document.
