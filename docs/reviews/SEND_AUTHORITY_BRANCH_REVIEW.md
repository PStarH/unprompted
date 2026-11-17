# Gate 6 — Full branch review (coordinator)

Branch: `cursor/send-authority-locked-528e` (includes design parent
`cursor/send-verify-authority-design-558b`). Target for landing: **`main`**.

## Verdict

**Accept to merge into `main` after CI green**, once base is `main` (or stacked
merge order: design docs then implementation — preferably one PR vs `main`).

## Security / correctness

- Choke points match lock: ledger verify, AuthorityGate + sealed WeakSet
  credentials, no model 404-verify, no live re-POST after dispatch.
- Residual: in-process `issueCredential` import — acceptable for this product
  boundary (local process = user).
- Calibration standing send is intentional (decision 3), not a bypass of the gate.

## Ops / migration

- `schemaVersion` 8 with `table_info` guard — correct pattern vs prior v7.
- Existing installs lose silent forged `pre_authorized` path; standing grants
  still work through `decide`.

## Docs

- Locked spec is authoritative; historical drafts retained with supersession.
- Gate 2 Cursor review retained as history; coordinator locked review is the
  accept gate for implement.

## Merge plan

1. Ensure PR #22 base = `main` (includes design+impl commits).
2. Close or supersede PR #21 so docs are not double-merged conflictingly.
3. Squash or merge when Checks are green.
4. Do not merge on coordinator ask alone if Tests and evaluations fail.

## Terminate?

Yes after Gate 7 CI verification succeeds. No further product loop unless CI
fails or a locked must-fix is disproven by a failing test.
