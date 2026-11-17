# Gate 4 — Implementer uncertainty review (coordinator)

Reviewed against: PR https://github.com/PStarH/unprompted/pull/22 @ `1a1ab04`,
locked spec `docs/SEND_AUTHORITY_LOCKED.md`, implementer deviation list in the
PR body, and spot checks of `src/authority-credential.js`,
`test/send-authority-locked.test.js`, and patches to ledger / connector /
database / permissions.

Author of this review: product coordinator (not the implementing Cursor agent).

## Verdict

**Accept with residual risks documented.** No blocking uncertainty that requires
another product decision. Proceed to task-diff and full-branch review.

## Implementer deviations — disposition

| # | Deviation | Disposition |
| --- | --- | --- |
| 1 | `issueCredential` is importable in-process | **Accepted residual.** WeakSet seal blocks clones/strings; same-process malice already has the DB. Prefer not exporting from a public package surface later; not a paid-release blocker for local-first single user. |
| 2 | Attempt 1 keeps legacy key; `:a{n}` only for n>1 | **Accept.** Matches locked “sendAttempt is authority”. |
| 3 | Live without ledger refused before lookup | **Accept.** Matches `LEDGER_REQUIRED`. |
| 4 | Model verification cannot promote; user HTTP verification may (non-404) | **Accept.** Locked rule targets model-authored specs. User HTTP is a one-shot path. 404-as-found removed — verified in connector patch. |
| 5 | Live 403 after dispatch stays `unknown` | **Accept.** Safer than re-POST; may leave Needs-you longer. |
| 6 | Recovery attempt count on job payload + `reconciliationClosed` | **Accept** if tests cover cap=4; treat as the single owner for ambiguous recoveries. |
| 7 | Calibration `allow` still sends via `decide` standing grant | **Accept.** Explicit human decision 3. |
| 8 | Pause returns draft to ready | **Accept.** |
| 9 | Legacy Message-ID alone → `unknown` | **Accept.** Matches should-fix. |

## Uncertainties still open (non-blocking)

1. **Separate verify timeout** (locked should-fix): send+verify may still share one race. Residual: slow send starves read-back → `unknown` + reconcile. Acceptable for this PR; track if false Needs-you appears in dogfood.
2. **`issueCredential` export** (above).
3. **YOLO time-lease still drives mail when used for MCP** — product coupling called out in lock; no change this PR.
4. **PR stack:** implementation PR was opened against the design branch, not `main`. Coordinator must retarget/merge so `main` receives both docs and code.

## Required before merge (process, not code uncertainty)

- CI green on the head that will land on `main`.
- Base branch is `main` (or design PR merged first, then this).
