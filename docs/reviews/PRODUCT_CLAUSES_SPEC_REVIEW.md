# Independent review: product-clause proof + connector regression

Status: **Accept** (2026-11-10). Coordinator-owned independent review of
`docs/PRODUCT_CLAUSES_LOCKED.md` (511 lines, 26653 bytes), after
amendments listed below were folded into the lock. Implement against the
amended lock only.

Reviewed against the accepted product contract
(`docs/PRODUCT_CONTRACT.md`), `docs/SEND_AUTHORITY_LOCKED.md`,
`docs/NEEDS_YOU_ACCURACY_LOCKED.md`, `docs/RELEASE_ACCEPTANCE_LOCKED.md`,
and the current main modules (WorkEngine, AttentionBudget,
`notification()`, Autonomy leases, connector contracts / harness / sync).

## Verdict

Accept. The lock is a proof-and-smallest-gap change, not a new platform.
It keeps the four clauses on one WorkEngine lifecycle, forbids weakening
the send and Needs you locks, keeps the four Field zones, refuses a
metrics warehouse and a live-OAuth claim, and asks for happy / failure /
recovery stories plus a complete scripted connector matrix.

## Amendments already applied to the lock (not outstanding)

These were must-fix findings on the first draft and are now in the locked
file:

1. **BA1 vs FT5.** Missing required evidence must cap execution and send
   (below L3 / L4), but L2 prepare of a promised nudge remains allowed.
   The first draft’s “at most L1” would have forbidden FT5.
2. **Closure Condition.** No new closure table. Map to existing
   completion criteria and verification (or explicit user-finished /
   cancelled close).
3. **Decision log.** A field on the existing task / Situation is enough.
   Do not require a new `activation_decisions` write path unless that
   table is already the engine’s log for the turn.
4. **FT3 signals.** User-finished is conservative and explicit; a
   ledgered agent send that reappears as mail is self-echo (IA1), not
   user-finished. Vague language does not close work.
5. **FT4 vs Needs you.** `blocked` does not add a Needs you admission
   row.
6. **IA3.** Later evaluations of the same task still have at most one
   open draft and one ready action.
7. **Matrix.** Google Calendar, Apple Mail, Calendar, and Contacts are
   required scripted / injected rows, not optional “if shipped.”
8. **Contract essay.** The only allowed edit is honesty in the locked-
   spec list; do not rewrite the essay.

## Must-fix

None outstanding.

## Should-fix / residuals (accepted, not merge blockers)

- Context-prefetch when the user opens a related project remains out of
  scope; there is no in-product hook.
- Labeled product-metric rates stay unknown where `activationMetrics`
  already says so.
- Live OAuth, provider push, and macOS Automation remain manual
  acceptance, and TESTING.md must stay honest.
- Quote / entity substring matching and other release-acceptance
  residuals are unchanged.
- `#22` residuals and plaintext workspace SQLite are unchanged.
- “Important completion may notify, subject to user preference” is
  deliberately implemented as default quiet in this PR, because no
  preference product is in scope. That matches `src/notifications.js`.

## Conflicts checked

- Send authority: YOLO, attestation, unverifiable writes, and no second
  send stay in the companion lock. This file only requires the clause
  stories to obey them.
- Needs you: admission predicate is not extended; SA3 only forbids
  hiding a must-enter Field row when AttentionBudget defers a notice.
- Release acceptance: six scenes are not to be rewritten; FT2 may hook
  the new decision field onto the existing wait shape.
- AttentionBudget and notification constructor already exist; the lock
  correctly forbids a replacement digest product.
- L0–L4 is a turn ceiling, not a second lifecycle or a Field collapse.

## Implementation review focus (later gates)

- Confirm the ceiling function is the one WorkEngine actually obeys, not
  a test-only double.
- Confirm empty `timer.due` does not call a model and does not prepare a
  draft, while a promised-check `timer.due` can prepare a nudge and still
  does not send.
- Confirm the connector matrix names every required connector and that
  401 / 429 / 5xx / partial / disconnect / replay rows are actually
  exercised or invoked, not comment-only pointers.
- Do not merge until CI is green and the owner explicitly asks.
