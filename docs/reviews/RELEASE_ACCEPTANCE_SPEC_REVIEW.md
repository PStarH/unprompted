# Independent review: release acceptance locked spec

Date: 2026-11-10
Subject: `/workspace/unprompted-specs/docs/RELEASE_ACCEPTANCE_LOCKED.md`
(to be copied unchanged to `docs/RELEASE_ACCEPTANCE_LOCKED.md`)
Verdict: **Accept**

Reviewed against the product owner's module list (happy / failure /
recovery required; personal-product scope; no new infrastructure for the
sake of the gate) and against the already locked
`SEND_AUTHORITY_LOCKED.md` and `NEEDS_YOU_ACCURACY_LOCKED.md`.

## Verdict

The spec is ready to implement. It correctly treats this work as proof,
not a new platform, names the existing stores and tests that already
cover large parts of scenes 4 and 6 plus connector sync, and forbids
weakening the two locked specs or collapsing the Field to three states.

Coordinator amendments before lock, all accepted:

1. Scene 1 must attach the second source to the **existing task**, not
   create a second task and hide it with Field grouping.
2. Scene 2 resume is wait-clear + evidence + existing prepare / ready
   path. It must not invent a quote-comparison product.
3. Scene 6 keeps `test/full-chain-recovery.test.js` as the durable crash
   proof and forbids copying that worker. The release file only adds
   restart-without-resend on the vendor-quote send path.

## Why this is enough

- Out of scope is explicit: no Memory/RSI platform, no metrics warehouse,
  no real-account OAuth claim, no new CI workflow, no new database.
- Connector rows are mapped to tests that already exist on main
  (`sync`, `connector-harness`, Slack/Notion, artifact read-back). The
  only allowed new connector case is a scripted pull 429 if that hole is
  real.
- Scene 4 defers ledger edge cases to locked tests. That avoids a
  divergent second send-authority implementation.
- Fixture clocks must be pinned, which is the lesson from the
  commitment-lifecycle CI failure on 2026-11-10.

## Residual risks (accepted, not blocking)

- Cross-source attach may require a small WorkEngine / Situation change.
  The spec caps it: same entity + deliverable via existing commitment
  machinery; keep the first task id. Implementer uncertainty review must
  flag any broader merge rule.
- Slack's emitted event type must be taken from the connector, not
  assumed to be `email.received`, even if some harness fixtures use that
  label.
- Scene 2 "missing quote" must be represented with evidence the engine
  already understands (required content / wait kind), not a new quote
  object model.
- This gate still does not prove live provider authorization or
  production push. TESTING / README must stay honest, or the PR fails
  review.
- P1 Memory, RSI, and supervision-cost metrics remain unproven after
  this PR. That is intended.

## Must not appear in the implementation

- New SQLite schema or job system "to make acceptance pass."
- A second task id scheme or a Field-only grouping hack for scene 1.
- A vendor-quote comparison module built only for scene 2.
- Changes to Needs you admission or send attestation / YOLO.
- Claims that Google, Outlook, Slack, GitHub, or Notion are
  production-validated on real accounts.
