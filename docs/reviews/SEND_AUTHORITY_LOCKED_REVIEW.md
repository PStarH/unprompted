# Independent review of locked send + Authority design

Reviewer: product coordinator (same bot that locked the design, **not** the
Cursor agents that authored the first drafts). Reviewed artifacts:

- Prior drafts on PR #21: `docs/SEND_VERIFICATION.md`, `docs/AUTHORITY_ENFORCEMENT.md`
- Prior Cursor Gate-2 review: `docs/reviews/SEND_AUTHORITY_SPEC_REVIEW.md`
- Locked superseding doc: `docs/SEND_AUTHORITY_LOCKED.md`
- Code spot-checks on `main` / prior branch: `src/durable/database.js`
  (schemaVersion 7 + ALTER pattern), review claims about
  `verifiedAction` / `normalizeLookup` / uncapped `deferRecovery` /
  model `verification` 404-as-found / forgeable `permission` strings.

## Verdict

**Accept for implementation**, conditional on implementers treating
`docs/SEND_AUTHORITY_LOCKED.md` as the sole behavioral source of truth when it
conflicts with the earlier drafts.

## Why Accept (not Reject)

The first drafts named the right choke points (ledger, WorkEngine.confirm,
ToolSafetyGateway, Autonomy revoke). The Cursor Gate-2 review correctly found
five blockers that would have shipped false safety. The locked doc addresses
each:

| Prior must-fix | Locked resolution |
| --- | --- |
| `verified` not terminal / second send | Immutable verified; stored evidence wins over lag; no new key if prior verified |
| Attestation stuck on claim | Terminal `failed` + `user_attested_absent`; pre-check before claim; refuse reopen after `dispatched_at` |
| Uncapped recovery + 429 → re-POST | Cap `external_dispatch` recoveries; live + dispatched never `confirmed_no_effect` from 429 |
| Model verification / 404-as-found | Model specs cannot promote to verified; delete 404-found |
| Forgeable credential + schema + YOLO coupling | Opaque gate credential; list rewires; schemaVersion 8 + ALTER; document YOLO mail coupling; standing grants per human decision 3 |

Human decisions 2 and 3 intentionally weaken strictness (quiet unverifiable
writes; standing grants count as approval). That is accepted product policy for
this release, not a review veto. Residual risk: standing grants + YOLO time
lease remain broad — called out in the locked doc.

## Remaining should-fix (non-blocking if tracked in implementer uncertainty)

1. Update `public/i18n.js` calibration auto-send copy in the same PR.
2. Disable Retry button for live mail when route returns `RETRY_NOT_SAFE`.
3. Separate verify timeout from send race.
4. Preserve `legacyMessageId` → `unknown`.
5. Pause cancels undispatched intents inside the same store transaction pattern
   as YOLO revoke.
6. `schedulePrepared` / `actor: 'activation'` must not invent user credentials.
7. Redacted `evidence_json` goes through existing privacy redaction helper.

## Gate 3 readiness

Yes. Implement against `SEND_AUTHORITY_LOCKED.md` only. Do not re-open product
decisions 1–5 without a human. After implement: coordinator runs Gate 4–7
(uncertainty review, task diff review, full-branch review, verify, loop/stop).

## Explicit non-delegation note

This review was not produced by a Cursor cloud agent. Earlier Cursor-written
drafts and the Cursor Gate-2 file remain historical context only.
