# Gate 5 — Task diff review (coordinator)

Scope: does the PR #22 diff deliver the locked task (send read-back + Authority
enforcement) without unrelated churn?

## Verdict

**Accept.**

## Coverage vs locked matrix

Present in code/tests:

- Terminal `verified`; caller stamp cannot promote (`send-authority-locked.test.js`)
- Dispatched key not reopened; attestation → `failed`/`user_attested_absent` + claim release
- Live 429 → `unknown` not `confirmed_no_effect`
- Hung Gmail one POST
- Schema v8 ALTER for `evidence_json` / `authority_json`
- Forgeable permission string denied by `PermissionPolicy`
- 404 verification ≠ found; model verification stripped unless `actor === 'user'`
- Startup `cancelMissingAuthority`
- Standing credentials via `issueCredential` in connector path
- Revoke cancels undispatched intents
- UI: calibration copy + Retry hide for live unsafe retry
- Docs: locked + locked review landed; drafts supersession banners

## Out-of-scope / noise

- Touching activation replay fixtures and memory lifecycle tests looks like
  test harness adaptation to sealed credentials / schema — acceptable.
- No unrelated feature work spotted in the 42-file set.

## Gaps vs locked should-fix (non-blocking)

- Dedicated verify timeout not clearly split.
- Full browser attestation control coverage not required by locked minimum scripted bar.

## Conclusion

Diff matches the assigned task. No loop for missing locked must-fix items.
