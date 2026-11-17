# Independent review: Needs you accuracy locked spec

Reviewer: coordinator (same bot, separate pass from the authoring pass).
Subject: `docs/NEEDS_YOU_ACCURACY_LOCKED.md` as revised after the must-fixes
below were written back into the document.
Base: `main` at `b3e0340`, plus `docs/SEND_AUTHORITY_LOCKED.md`.
Date: 2026-11-10.

Verdict: **Accept**. Implementation may start against the revised locked
document. Do not implement from the first draft.

## Scope of this review

This is a product/engineering lock review, not a code review. It checks
whether the admission predicate is implementable without hidden product
decisions, whether it conflicts with already-locked send/authority rules,
and whether tests would catch the known false positives and false negatives.

## What the first draft got right

- One admission predicate driving Field, decision queue, and `J`/`K` is the
  right fix for classifier disagreement.
- Moving in-flight `verifying` / `executing` / `accepted_live` out of Needs
  you matches the product meaning and is the largest current false positive
  (including the existing `test/ui-render.test.js` tone `needs` assertion).
- Ledger-only unverifiable writes stay off Needs you; terminal uncertainty
  after the cap stays on it. That is consistent with
  `docs/SEND_AUTHORITY_LOCKED.md` A3 (`reconciliation_inconclusive` → one
  Needs-you mail, zero extra POSTs).
- No fifth zone, no chat spam, no change to YOLO *authority* rules.

## Must-fixes (now incorporated in the locked spec)

These would have produced new false negatives or unimplementable branches if
left as first drafted. They are locked now; implementers must follow the
revised text, not the first draft.

1. **Ready + standing grant / YOLO.** “About to start” would hide a
   `ready_for_approval` draft that a lease never actually takes. The lock is:
   still `ready_for_approval` → Needs you; In motion only after execution has
   actually started.

2. **`unknown` / `uncertain` is overloaded.** Current engine and tests use
   `blocked` + `action.status === 'unknown'` both during automatic
   reconciliation and after the cap. Inferring terminal Needs you from that
   pair alone would keep the original false positive. The lock is: Needs you
   only when `reconciliation_inconclusive`, an attestation request, or an
   equivalent explicit close is recorded. If #22 implies the cap without
   writing that flag, the engine must write it.

3. **Tie-break vs disconnect.** Evaluating “in-flight → In motion” before
   source disconnect would leave a dead in-flight send in In motion after the
   connector drops. Disconnect that blocks continuing ready or in-flight work
   now beats In motion. Observing-only disconnect stays Watching. Pause still
   beats Needs you.

4. **Synthetic waits.** `wakeFor` invents a document/event wake with
   `status: 'waiting'` for many `waiting_for_information` tasks that have no
   persisted `wait`. Treating that as an “active source wait” would leave
   user-owned missing-info tasks in Waiting (the existing false negative).
   Only `wait.status === 'active'` (or an equivalent recorded watch) is
   Waiting. Admission uses `nextAction.kind` (`provide_information`,
   `resolve_dependency`, `decide`), not `owner.id === 'user'` (`ownerFor`
   often returns `unknown`).

5. **Evidence conflicts.** The first draft could be read as a new
   conflict-intake feature. The lock is: only already-blocking recorded
   conflicts; no new path; priority scoring is not admission.

## Remaining risks (accepted, not blockers)

- Existing copy in observing PR / GitHub rows that says “needs you” must be
  edited where it appears, but the spec already forbids that wording outside
  the Needs you zone. Implementer should grep i18n and presentation strings.
- `decisionQueue` today is narrower than the Field set; widening it to the
  single predicate will change keyboard and queue membership. That is
  intended. Watch for tests that assumed blocked-without-action or
  in-flight items were / were not queued.
- Notification *delivery* may still be batched; the Field zone must still
  show every must-enter item. No change to Activation policy objects is
  required beyond not filtering the zone.
- Connector flakiness is out of scope, as stated.

## Tests

The revised minimum set (including 2 / 2b / 2c / 2d and the unmapped
fallback) is sufficient to lock the review findings. Replace, do not keep,
assertions that a merely verifying task uses tone `needs`.

## Decision

**Accept** the revised `docs/NEEDS_YOU_ACCURACY_LOCKED.md`. Implementation
may proceed. Spec and review remain coordinator-owned; a cloud agent may only
apply code against this lock. Do not merge until the remaining pipeline gates
pass and the user asks.
