# Send read-back verification

[← Documentation](README.md)

Design for review. This document does not change runtime behavior. It specifies
how outbound send must be verified before a later change may claim success.
Authority rules for the same executions are in
[Authority enforcement](AUTHORITY_ENFORCEMENT.md).

The product already refuses to treat a model sentence as delivery. The gap is
that a live send can still be recorded as accepted before an independent
read-back, a hang does not always schedule reconciliation, and a later retry
can reuse an identity the provider will not deduplicate. Paid use requires
those cases to end in a verified receipt or a single explainable blocked
state.

## Problem

Completing a send must mean the product read the outbound effect back from the
system that received it. These are not success:

- The model says the message was sent.
- A tool result says `accepted`, `ok`, or returns an HTTP 200.
- Gmail `users.messages.send` returns a message id.
- A search of Sent finds nothing, which is then treated as proof that nothing
  was sent.
- A timeout handler guesses either success or a safe retry.

`src/evidence.js` and `src/verification.js` judge request criteria and
cross-source readings. They do not prove that an outbound message exists.
Send proof lives on the execution path: `WorkEngine`, the provider adapter,
and `ToolExecutionLedger`.

## Failure modes

| Mode | What can go wrong today | Required outcome |
| --- | --- | --- |
| Model assertion | Harness prompts tell the model not to claim completion. Nothing in the prompt stops a UI or caller from treating that text as done. | Task completion ignores model and tool prose. |
| Acceptance without read-back | `GoogleMailAdapter.send` returns `accepted_live` from the send response. `DurableRuntime.external` for `email.send` does not pass `verify`, so the ledger can stay `accepted` until a later engine read-back. | Ledger reaches `verified` only after the read-back predicate passes. |
| Weak direct read-back | `GoogleWorkspaceConnector.verifyMessage` checks the provider id and the `SENT` label. It does not require the Message-ID derived from the idempotency key. The search path in `verify` does require that header. | Both paths use one predicate. |
| Hang or ambiguous success | The ledger marks a timed-out write `unknown`. `WorkEngine.#sendFailure` turns `UncertainDeliveryError` into a follow-up lookup. Nothing enqueues `reconcile_execution` until restart or an explicit reconcile. | Bounded automatic reconciliation, then one Needs-you state. No second POST. |
| Search miss as absence | `verify` returns `not_found` when Sent search is empty, while its own detail says a miss is not proof. `DurableRuntime.normalizeLookup` upgrades that to `unknown` only for some live statuses. A caller that skips the helper can still `retry()`. | After any dispatch, a search miss is `unknown`. Live Gmail never becomes `confirmed_absent` from search. |
| Duplicate send | Gmail does not dedupe `users.messages.send` on Message-ID. `WorkEngine.retry` reuses the same idempotency key after `confirmed_absent`. The ledger allows that reuse once the row is `failed` / `confirmed_absent`. | A key that reached `dispatched` is never POSTed again. A new attempt is a new key, and only after the previous attempt is closed without an automatic send. |
| Provider retry | `GoogleWorkspaceConnector.#request` retries only when `retry` is true, and the default is true for `GET` only. A future send call that opts into retry would duplicate. | Send POSTs are single-shot. Tests lock the default. |
| Other outbound writes | Document-patch ledger `verify` trusts `result.readbackVerified` from the write result. `ConnectorActions` and MCP writes may omit `verify` and return `accepted` to the model. | Built-in families verify by a separate read. Writes without a read-back stay unverified and visible. |
| Live send without a ledger | `WorkEngine.#sendSafely` can call `provider.send` directly when `durableRuntime` is absent. | `provider.live === true` refuses to send without the ledger. |

## Current behavior

Follow one approved mail reply:

1. `WorkEngine.approve` or `#runPreAuthorized` re-checks the draft, document
   version, freshness, and `PermissionPolicy`, then stores `task.action` with
   `idempotencyKey` `send:{taskId}:{documentVersion}` plus revision and input
   suffixes. Status becomes `verifying`.
2. `WorkEngine.#executeAction` looks up that key before any send. `found`
   confirms. `unknown` blocks. Only `not_found` continues.
3. `WorkEngine.#sendSafely` calls `DurableRuntime.external` when a durable
   runtime exists. The call passes `send` and no `verify`.
4. `ToolExecutionLedger.intent` inserts `tool_executions.status = intent` and
   takes a resource claim. `dispatch` runs `beforeDispatch`, which requires
   the guarded provider hook, re-checks authority, and moves the row to
   `dispatched` before the socket write.
5. `GoogleMailAdapter.send` calls `GoogleWorkspaceConnector.execute`, which
   sets `Message-ID` to `gmailMessageId(idempotencyKey)` and POSTs once.
   `gmailMessageId` is
   `<unprompted-{sha256(key)}@unprompted.local>`.
6. A returned receipt moves the ledger row to `accepted`. The engine then
   calls `#verifyReceiptSafely`. `found` plus `validReceipt` calls
   `WorkEngine.confirm`, which sets `verified_live` or `verified_simulated`
   and completes the task. Anything else calls `uncertain` and leaves the
   task `blocked`.
7. `confirm` also calls `DurableRuntime.verifiedAction`, which moves the
   ledger row to `verified`.
8. Restart runs `importUncertainActions`, `recoverUnfinished` (open
   `dispatched` and `accepted` writes become `unknown`), and
   `WorkEngine.restorePendingWork`, which reconciles `executing`,
   `uncertain`, and `accepted_live` actions.

Document patches in `TaskServices.applyDocumentPatch` already pass a `verify`
callback and compare ingested content with the expected text. The callback
currently treats `readbackVerified` or `simulated` on the write result as
`found`. Connector and MCP writes go through `ConnectorActions.dispatch`.
Verification is optional. `mcpWrite` passes `verify = null`.

Simulated mail in `SimulatedMailProvider` writes a local outbox and reads it
back. `live` is false. That outbox is the source of truth for the rule-only
demo, not for Gmail.

The workspace already separates presentation from the raw status.
`public/workspace-model.js` maps `verifying`, `executing`, `uncertain`, and
`accepted_live` to `result_unverified`, and a blocked task that still has an
action toward Needs you. `WorkEngine.uncertain` emits one deduped blocker
notification. Keep that surface. Do not add a chat message for each attempt.

## Proposed architecture

Keep the current choke points. Do not add a second outbox or a model-facing
verification tool.

| Concern | Owner | Change |
| --- | --- | --- |
| When a send may start | `ToolSafetyGateway` and `PermissionPolicy` | Specified in the authority design. Send code calls them; it does not invent a second check. |
| Intent, claim, timeout, attempt row | `ToolExecutionLedger` | Record the read-back on the execution. Do not return a verified result from `send` alone. |
| Gmail predicate | `GoogleWorkspaceConnector.verify` and `verifyMessage` | One Message-ID predicate for direct read and search. |
| Adapter contract | `GoogleMailAdapter` and `SimulatedMailProvider` | Unchanged method names: `send`, `lookup`, `verifyReceipt`. |
| Task completion | `WorkEngine.confirm` | Still the only transition to `completed` for a mail reply. It requires a ledger row already `verified` by the predicate. |
| Reconciliation jobs | Existing `effects` queue, job type `reconcile_execution` | Enqueue on ambiguous outcomes, not only after process recovery. |
| User copy | Existing blocker notification and `task.reason` | Stable codes below. English and Chinese strings land with the implementation. |

`provider.live === true` and a missing durable runtime is `LEDGER_REQUIRED`.
No POST is attempted. The rule-only JSON demo keeps `SimulatedMailProvider`
because `live` is false.

### Read-back predicate

For live Gmail, evidence is `found` only when all of these hold:

- The message id is non-empty.
- `labelIds` includes `SENT`.
- The `Message-ID` header equals `gmailMessageId(idempotencyKey)`.
- The read saw exactly one such message.

Direct read uses `format=metadata` and requests the `Message-ID` header.
`format=minimal` is not enough, because it cannot bind the header. A header
mismatch is `unknown`, never `not_found`: the id exists, but it is not this
attempt, so a retry could create a second message.

Search uses the existing query `in:sent rfc822msgid:{messageId}`. Zero hits
after `dispatched_at` is set are `unknown`. Zero hits while the row is still
`intent` and `dispatched_at` is null are `not_found`. More than one hit is
`unknown`.

`validReceipt` for live `email.send` requires `receipt.idempotencyKey` equal
to the execution key. A receipt that omits the key is not live evidence.
Simulated receipts may still match on id plus key, as they do now.

### Mandatory verify inside the ledger

`WorkEngine.#sendSafely` passes `verify` into `DurableRuntime.external`:

- The callback calls `provider.verifyReceipt` for the accepted receipt, then
  `provider.lookup` if the direct read is not `found`.
- `ToolExecutionLedger.dispatch` already refuses to mark `verified` unless
  that callback returns `found` and `validReceipt` matches the key. Keep that
  check.
- `WorkEngine.confirm` runs only after the ledger row is `verified`. If the
  process dies between `accepted` and `verified`, restart reconciliation is
  the only completion path. `confirm` must not invent `verified` from the
  in-memory send return.

Document patch `verify` must call `provider.read` (or the local equivalent)
and compare `expectedContentDigest`. It must not treat a flag on the write
result as the read-back. The existing content comparison in
`TaskServices.applyDocumentPatch` stays. If the independent read and the
ingested content disagree, the patch stays `uncertain` and the ledger stays
`unknown`.

`email.draft`, Notion page create, Notes create, and Reminders create already
pass provider `lookup` as `verify` from `ArtifactActions`. Leave that path.
Do not call those creations a sent email. Sent mail is not undone by artifact
undo.

`connector.request` and `mcp.tool` may still omit a verification spec, because
arbitrary APIs do not share one read-back shape. Omission cannot reach
`verified`. The tool result keeps `verified: false`. One blocker per
execution id uses the `SEND_ACCEPTED_UNVERIFIED` copy. The task is not
completed. Supplying the existing `ConnectorActions.verification` GET
assertions is how those writes become `verified`.

### Timeout and ambiguous results

`ToolExecutionLedger.dispatch` already aborts a write at `timeoutMs` (default
20 seconds) and records `OUTCOME_UNKNOWN` when the row might have left the
process. Keep the split:

| Dispatch progress | Record | Task |
| --- | --- | --- |
| Still `intent`, `beforeDispatch` did not commit | `cancelled`, `last_error_class = confirmed_no_effect` | Back to `ready_for_approval`. Nothing was sent. |
| `dispatched` or `accepted`, or the error is `UncertainDeliveryError` / `ambiguous` / retryable network / HTTP 429 or 5xx | `unknown`, claim `unresolved` | `blocked`, action `uncertain` or `accepted_live` if a receipt id exists |

On the second row, enqueue `reconcile_execution` on the `effects` queue with
`max_attempts` 4 and the existing job backoff. `DurableRuntime.reconcileExecution`
already looks up through `providerFor`. While the result stays `unknown`, the
job may retry. After the last attempt, complete the job without dead-letter
spam and set `last_error_class` to `reconciliation_inconclusive`. The task
stays blocked with one notification.

A received Gmail 4xx that `GoogleMailAdapter` treats as a definite rejection,
with no receipt id and `definitiveNoEffect`, may become `failed` /
`confirmed_absent` only if `dispatched_at` is set and the status is documented
as "no message created". 401 and 403 are credential failures: `unknown` is
wrong for them if the body was never sent; if it was sent, keep `unknown`
until read-back, and surface the credential error in the detail. Do not POST
again on 429.

`GoogleWorkspaceConnector.execute` must keep a single POST (`retry` false).
Add a regression that a hung `fetch` does not call `fetch` a second time.

### Idempotency and a second attempt

Gmail `provider_idempotent` stays 0. `nativeIdempotency` stays unset.
`normalizeLookup` therefore continues to refuse search-miss absence for live
providers.

Reuse of an idempotency key for another POST is allowed only when every prior
attempt on that key is one of:

- `cancelled` and `confirmed_no_effect` (never dispatched), or
- `failed` and `confirmed_absent` and (`provider.live === false` or
  `provider.reliableAbsence === true`).

Live Gmail matches neither of the second clause. `WorkEngine.retry` must
refuse a live mail action even if `task.action.status` is
`confirmed_absent`.

Closing an inconclusive live attempt is a separate user action, not `retry`
and not YOLO:

1. The user attests, from the existing task control, that they inspected the
   mailbox and this attempt is absent.
2. The attestation does not call `send`. It appends the old action to
   `actionHistory`, sets the execution `last_error_class` to
   `user_attested_absent`, releases the claim only if the status is no longer
   unresolved, and returns the draft to `ready_for_approval`.
3. The next `approve` mints a new key:
   `send:{taskId}:{documentVersion}:r{revision}:i{inputVersion}:a{n}`
   with `n` increased. Historical keys without `:a` stay attempt 1 and are
   not rewritten.
4. Before the new POST, lookup every prior send key for that task and draft
   digest. If any predicate matches, `confirm` that receipt and do not send.
5. `Autonomy.runReady` must not approve a draft whose previous live attempt
   ended in `user_attested_absent`. The replacement send needs a one-shot
   approval. An active YOLO lease is not sufficient for that replacement,
   because a wrong attestation plus an automatic send is a duplicate.

Simulated mail may keep same-key retry after the outbox lookup returns
`not_found`. The outbox is local and is the provider.

## State machine

Ledger status for a write stays the existing check constraint: `intent`,
`dispatched`, `accepted`, `verified`, `failed`, `unknown`, `cancelled`.

```text
                 approve / YOLO starts execute
                            |
                            v
                        intent
                       /      \
          never dispatched     beforeDispatch committed
                    /            \
                   v              v
             cancelled         dispatched
     confirmed_no_effect           |
                    \              | send returns receipt id
                     \             v
                      \        accepted
                       \        /    \
                        \      /      \ read-back predicate matches
                         \    /        v
                          \  /      verified ----> WorkEngine.confirm
                           \/
                        unknown  <--- timeout, ambiguous, search miss,
                           |          header mismatch, missing verify
                           |
                           +--> reconcile job (bounded)
                                   |        \
                                   |         \ still unknown
                                   v          v
                               verified    inconclusive
                               or failed   Needs you
                               (simulated
                                absence only)
```

`verified` is terminal. A later request withdrawal does not unsend. Existing
`confirm` behavior stands: the task records
`withdrawn_after_delivery` or asks for a fresh assessment, and the receipt
stays verified.

Task action status, which the UI already understands:

| Ledger | `task.action.status` | Workspace state |
| --- | --- | --- |
| `intent` or `dispatched` while the call is running | `executing` | `result_unverified` |
| `accepted`, predicate not yet passed | `accepted_live` | `result_unverified` |
| `unknown` | `uncertain` or `accepted_live` if a receipt id is stored | `result_unverified`, then Needs you when automatic reconcile finishes inconclusive |
| `verified` and `provider.live` | `verified_live` | `verified` |
| `verified` and not live | `verified_simulated` | `verified` |
| `cancelled` / `confirmed_no_effect` | action cleared | `needs_user` if the draft remains |
| `failed` / `confirmed_absent` on simulated mail | `confirmed_absent` | `needs_user` |
| User attested absence | action cleared, history kept | `needs_user` |

## Sequences

### Verified Gmail send

1. Gate allows the exact draft digest.
2. Ledger inserts `intent` and the resource claim.
3. Pre-send lookup is `not_found` because this key was never dispatched.
4. `beforeDispatch` sets `dispatched` and re-checks the gate.
5. One Gmail POST returns a message id. Ledger sets `accepted` and stores
   `provider_receipt_id`.
6. `verifyMessage` reads that id, checks `SENT` and `Message-ID`.
7. Ledger sets `verified` and stores `evidence_json`.
8. `confirm` completes the task and records `receipt_read_back`.

### Timeout after the POST may have left

1. Steps 1–4 above.
2. The client timer aborts. No send response is read.
3. Ledger sets `unknown` / `OUTCOME_UNKNOWN` and leaves the claim unresolved.
4. The effects job reconciles. Search miss stays `unknown`. A later direct
   hit that matches the predicate verifies.
5. If all four attempts stay inconclusive, one blocker remains. No second
   POST. YOLO does not start another send while `task.action` is present
   (`Autonomy.runReady` already requires `!task.action`).

### Ambiguous success

The send throws `UncertainDeliveryError`, or Gmail returns a body without a
message id, or the HTTP status is 429 or 5xx. Treat it as the timeout branch.
Copy must not say "delivery failed" when the body may have been accepted.
Use `SEND_UNCERTAIN` or `SEND_ACCEPTED_UNVERIFIED`.

### Duplicate retry

1. A previous key is `unknown` or `accepted`.
2. `POST /api/tasks/:id/retry` returns 409 `RETRY_NOT_SAFE` for live mail.
3. A second `approve` of the same key returns `RECONCILIATION_REQUIRED`.
4. Only attestation plus a new approval mints `:a{n+1}`.
5. The new attempt looks up the old key first. A match confirms the old
   receipt and skips the POST.

### Crash between accept and verify

1. Startup `recoverUnfinished` moves `accepted` writes to `unknown`.
2. `restorePendingWork` or the reconcile job runs the predicate.
3. Match completes the task. Miss stays blocked. Neither path sends.

## Data model

No new database. Extend `tool_executions` in `src/durable/schema.sql` with
nullable columns so existing rows stay valid:

| Column | Purpose |
| --- | --- |
| `evidence_json` | `{ status, via, messageId, receiptId, checkedAt, detail }` for the last read-back. Redacted executions store only ids and status, matching `ToolExecutionLedger.verified`. |
| `authority_json` | `{ kind, id, version }` copied from the gate at intent time. Revocation uses it. The authority design owns the credential rules. |

`last_error_class` stores the codes below. `execution_attempts` remains the
attempt log for a single key. A new send identity is a new
`idempotency_key`, not a recycled row.

`provider_idempotent` stays 0 for Gmail. Do not set it from a successful
read-back.

The compatibility task projection keeps `action.idempotencyKey`,
`action.receiptId`, `action.verificationVia`, and `actionHistory`. Add
`action.sendAttempt` as the integer `n` in the key. Do not store message
bodies in `evidence_json`.

## Error taxonomy

Codes are stable. `task.reason` and the blocker `what` field use the user
text. The notification `dedupeKey` stays `blocker:{taskId}` so a new attempt
replaces the old copy instead of stacking cards. No chat transcript entry.

| Code | User-facing explanation | What the user can do |
| --- | --- | --- |
| `LEDGER_REQUIRED` | This live send needs the local workspace database before anything is sent. | Restart into the normal workspace. Nothing was sent. |
| `SEND_NOT_DISPATCHED` | Nothing was sent. The attempt stopped before the provider was contacted. | Review the draft and approve again if it is still current. |
| `SEND_DENIED` | Nothing was sent. Approval or YOLO is no longer active. | Review the draft. See the authority design. |
| `SEND_FAILED_DEFINITE` | The provider rejected the message before accepting it. Nothing was sent. | Fix the stated cause, then approve a fresh attempt. |
| `SEND_UNCERTAIN` | The provider may have sent this message. It could not be found by its Message-ID. It was not sent again. | Use Reconcile, or check Sent and attest only if that message is absent. |
| `SEND_ACCEPTED_UNVERIFIED` | The provider accepted a send, but the message was not read back with the expected Message-ID. It was not sent again. | Reconcile. Do not approve a second send until this attempt is closed. |
| `RECONCILE_INCONCLUSIVE` | Automatic checks still cannot tell whether this message was sent. | Leave it blocked, or attest after checking Sent. |
| `SEND_ABSENT` | The simulated provider has no copy of this attempt. | Retry is a separate action. Live Gmail does not use this code. |
| `SEND_VERIFIED` | The message is in Sent and its Message-ID matches this attempt. | No prompt. The task completes. |
| `RETRY_NOT_SAFE` | A live attempt that already started cannot be sent again under the same identity. | Reconcile or attest. |
| `IDEMPOTENCY_CONFLICT` | This send identity was already used for a different recipient, body, or task. | Leave it blocked. |
| `USER_ATTESTED_ABSENT` | You confirmed this attempt is not in Sent. Nothing was sent by that confirmation. | Approve the draft if you still want it sent. YOLO will not send it for you. |

Credential failures (401/403) keep the provider sentence in `detail` and use
`SEND_DENIED` only when the POST did not happen. If the POST might have
happened, use `SEND_UNCERTAIN` and include the credential sentence so the
user knows to reconnect before reconciling.

## Test plan

Extend the current suites. Do not add a live Gmail account to CI. Scripted
transports remain the contract, as in `docs/TESTING.md` and
`docs/LIVE_INTEGRATION.md`.

| Case | Where |
| --- | --- |
| Send response without read-back does not complete the task or set ledger `verified` | `test/gmail-verification-safety.test.js`, `test/durable-execution.test.js` |
| Direct read requires Message-ID equality, `SENT`, and a single message | `test/gmail-verification-safety.test.js` |
| Search miss after `dispatched` stays `unknown` even if a caller skips `normalizeLookup` | `test/durable-execution.test.js` |
| Header mismatch does not enable `retry` | `test/gmail-verification-safety.test.js` |
| Hung fetch performs one POST; ledger is `unknown`; a reconcile job is queued | `test/durable-execution.test.js` |
| 5xx and `UncertainDeliveryError` follow the same path and the user text does not say the send failed cleanly | `test/reliability-safety.test.js` |
| Four inconclusive reconciles leave one blocker and zero extra POSTs | `test/durable-execution.test.js` |
| `POST /retry` on live mail returns `RETRY_NOT_SAFE` | `test/contracts.test.js` or the engine send tests |
| Attestation does not send; YOLO does not approve the replacement; a later approve sends a new key only after prior keys miss | `test/autonomy.test.js`, `test/gmail-verification-safety.test.js` |
| Prior key verifies during the new attempt's pre-check, so the new POST is skipped | `test/durable-execution.test.js` |
| Crash after `accepted` and before `confirm` verifies or stays blocked, and does not send | `test/fixtures/durable-worker.mjs` |
| Live adapter without `durableRuntime` returns `LEDGER_REQUIRED` and does not call `fetch` | `test/gmail-verification-safety.test.js` |
| Simulated outbox still verifies by local read and may retry after a true miss | existing simulation tests |
| Document patch `verify` fails when the write result claims read-back but `provider.read` does not match the digest | `test/durable-runtime.test.js` |
| MCP and platform writes without a verification spec stay `accepted`, `verified: false`, and do not complete the task | `test/connector-harness.test.js` |
| One blocker notification, not a series, across reconcile attempts | `test/notifications.test.js` or the workspace model test |

Browser coverage, if the attestation control is added: one task moves from
`result_unverified` to Needs you, Reconcile does not duplicate, and attest
returns the draft without a sent state. Follow `test/browser/autonomy.mjs`
as the pattern. Do not require it for the scripted contract above.

## Non-goals

- Proving that a recipient's mail server displayed or accepted the message.
  Evidence stops at the sender's Sent mailbox.
- Unsending a verified message. Withdrawal after verification stays a record,
  not a recall.
- Provider-side idempotency that Gmail does not offer.
- Treating `src/evidence.js` criteria, probe hits, or model JSON as a receipt.
- Verifying every possible MCP side effect automatically. Unspecified writes
  stay explicitly unverified.
- A new notification channel, toast stack, or chat narration of each probe.
- Live-account certification. Scripted tests are the implementation bar.
  A maintainer can still run the manual send notes in `docs/LIVE_INTEGRATION.md`.

## Remaining risks

- A user attestation can be wrong. The replacement key and the pre-send
  lookup of old keys reduce duplicates; they do not remove the risk if Sent
  search is lagging and the user attests anyway. That is why YOLO cannot
  fire the replacement.
- Message-ID is set by this client. A mailbox rule that strips it would leave
  the attempt `unknown` forever. That is safer than a false verification.
- `users.messages.send` can theoretically store a message and fail the
  response. Reconciliation depends on Gmail indexing that Message-ID. Until
  it shows up, the task stays blocked.
- Platform writes without a verification spec remain a visible unknown. A
  model can still describe them as done in its own text. The task and the
  tool payload must not agree.
- Clock skew does not affect the predicate. Lease expiry still must not clear
  an unresolved claim. `ResourceClaims` already keeps timed-out claims.

## Migration and rollout

- Additive SQLite columns only. Null `evidence_json` means "not yet recorded".
- Do not rewrite historical idempotency keys. Do not mark old `completed`
  tasks unverified.
- On startup, existing `dispatched`, `accepted`, and `unknown` mail rows
  reconcile under the new predicate. A row that previously would have been
  confirmed by id plus `SENT` alone stays `unknown` until the Message-ID
  matches. The user sees one blocker, not a resend.
- Ship the ledger `verify` path and the retry refusal in the same change as
  the predicate. Shipping the stricter predicate without retry refusal would
  turn old `not_found` handling into a duplicate window if any caller still
  treats it as absence.
- The rule-only demo does not migrate. Its outbox verification stays local.
- Update `docs/ARCHITECTURE.md` and `docs/AUTONOMY.md` in the implementation
  change so they describe the new retry and attestation rules. This design
  document stays the specification until that behavior exists.

## Decisions to confirm before implementation

1. **Attestation.** The proposal adds a user control that closes an
   inconclusive live attempt without sending, and requires a fresh approval
   for a new key. Alternative: never mint a second key; the attempt stays
   blocked until Gmail read-back returns `found`. The alternative avoids a
   wrong attestation entirely and can strand a draft if Gmail never indexes
   the id.
2. **Quiet unverified platform writes.** The proposal raises one Needs-you
   blocker when a connector or MCP write has no read-back. Alternative: keep
   the result only in the execution list and the tool payload, with no
   workspace card, so exploratory API calls do not compete with mail.
