# Spec review: send read-back and authority enforcement

Independent Gate 2 review of [Send read-back verification](../SEND_VERIFICATION.md) and [Authority enforcement](../AUTHORITY_ENFORCEMENT.md) on `cursor/send-verify-authority-design-558b` (design commit `d12a57b`). The reviewer did not write those designs. This document does not change runtime behavior.

Reviewed against the code on this branch: `WorkEngine` (`src/engine.js`), `ToolExecutionLedger` (`src/durable/execution.js`), `DurableRuntime` (`src/durable/runtime.js`), `GoogleMailAdapter` (`src/providers.js`), `GoogleWorkspaceConnector` (`src/connectors/google.js`), `ToolSafetyGateway` (`src/tool-gateway.js`), `PermissionPolicy` (`src/permissions.js`), `Autonomy` (`src/autonomy.js`), `ConnectorActions` (`src/durable/connector-actions.js`), `ArtifactActions` (`src/durable/artifact-actions.js`), `TaskServices.applyDocumentPatch` (`src/task-services.js`), and the effects worker in `DurableJobs` (`src/durable/jobs.js`).

## Verdict

**Accept with changes.**

The choke points are the right ones. Mail completion already goes through `WorkEngine.confirm`, live Gmail acceptance is already separate from read-back, and `ToolExecutionLedger.intent` already refuses a write that has no `authorize` function. Shipping the designs as written would still miss the paid-release goals: a verified row can be downgraded into a second send, an attested replacement cannot acquire the resource claim, timeout handling already retries forever on a path the spec does not name, a model-supplied read-back can mark a platform write `verified`, and the authority credential is not specified tightly enough to stop a permission string.

Do not start Gate 3 until the must-fix items below are in the spec and a human has answered the five open decisions. Several must-fix items change shape depending on those answers.

## Must-fix before implement

### 1. A `verified` ledger row is not terminal, so a later miss can send again

The spec says `verified` is terminal, `WorkEngine.confirm` is the only mail completion path, and `confirm` must require a ledger row that the predicate already verified. The current functions do the opposite, and the spec never says to change them:

- `DurableRuntime.verifiedAction` (`src/durable/runtime.js`) calls `ToolExecutionLedger.verified`, which writes `status='verified'` from the receipt object the caller passes in. It does not require the row to already be `verified`.
- `ToolExecutionLedger.reconcile` returns the stored receipt immediately when `status === 'verified'` and does not read the provider again.
- `DurableRuntime.normalizeLookup` upgrades a search miss to `unknown` only when the row is `dispatched`, `accepted`, or `unknown`. A `verified` row is excluded, so a miss stays `not_found`.
- `WorkEngine.reconcile` does its own lookup. `confirmed_absent` is `not_found` plus no `receiptId` plus the action not in flight. A crash after the ledger is `verified` and before `task.action.receiptId` is stored can therefore mark the task absent.
- `WorkEngine.retry` then sends the same key. `DurableRuntime.external` returns a stored result when that same key is already `verified`, so the same key is safe. The spec's new key (`:a{n+1}`) is not. Its pre-send lookup is specified as a fresh provider predicate. A Sent-index lag misses. The new POST proceeds while the old row is already `verified`.

`confirm` of "the old receipt" during the new attempt is also unbound. `verifiedAction` loads `task.action.idempotencyKey` and `validReceipt` rejects a receipt whose `idempotencyKey` is a different key (`src/tool-gateway.js`). The old message cannot be confirmed onto the new row, and stamping the new key onto the old receipt would verify the wrong attempt.

Required spec change: a row in `verified` completes the task and forbids attestation, retry, and any later send for that draft. `normalizeLookup`, `WorkEngine.reconcile`, and the new-attempt pre-check must treat stored `verified` evidence as `found` even when a fresh search misses. `verifiedAction` must stop being the writer that promotes `accepted` to `verified`. `confirm` of a prior attempt must target that attempt's execution id.

### 2. Attestation cannot start the replacement send it describes

`ResourceClaims.release` throws `RESOURCE_UNRESOLVED` while status is `intent`, `dispatched`, `accepted`, or `unknown` (`src/durable/execution.js`). Claims are keyed by provider resource (thread, or `to:subject`), not by idempotency key. `acquire` refuses a second execution when the claim is unresolved.

The spec leaves the row on `unknown`, sets `last_error_class` to `user_attested_absent`, and releases the claim only when the status is already off the unresolved list. The replacement `approve` then inserts a new key and `intent` fails with `RESOURCE_UNRESOLVED` before the prior-key lookup. The user-facing promise ("approve the draft if you still want it sent") does not hold.

The same section also says a key that reached `dispatched` is never POSTed again. `ToolExecutionLedger.intent` today reopens a key that is `cancelled` with `last_error_class = 'confirmed_no_effect'` even when `dispatched_at` is set (`src/durable/execution.js`):

```js
const safe = !existing.privacy_redacted && (existing.status === 'cancelled' && (!existing.dispatched_at || existing.last_error_class === 'confirmed_no_effect') || existing.status === 'failed' && existing.last_error_class === 'confirmed_absent');
if (!safe) throw durableError('RECONCILIATION_REQUIRED', 'The existing intent must be reconciled before another dispatch.');
```

Required spec change, after the human attestation decision: name the terminal status an attestation writes. It has to be off the unresolved list so the claim can release, and it must not satisfy the reuse predicate above. State that the pre-send check runs before `intent` acquires the claim. If the human choice is "never mint a second key", delete the attestation transition instead of leaving this sequence in the spec.

### 3. Timeout reconciliation already runs, and it is unbounded; some dispatched failures are treated as safe to POST again

The spec says nothing enqueues `reconcile_execution` until restart or an explicit reconcile, then adds a 4-attempt job. For a live durable send that is the wrong description of this branch:

- `ToolExecutionLedger.dispatch` sets `error.ambiguous` when a write is not `cancelled`.
- `DurableRuntime.external` calls `DurableJobs.fail` with that error.
- `classifyFailure` maps `error.ambiguous` and `OUTCOME_UNKNOWN` to `ambiguous`, and `DurableJobs.fail` parks the `external_dispatch` job in `recovery_required` (`src/durable/jobs.js`).
- The effects worker is constructed with `recovery: job => this.recover(job)` (`src/durable/runtime.js`). `recover` calls `ledger.reconcile` directly. On `unknown` it `deferRecovery`s for 30 seconds and returns. That loop has no attempt cap.
- `kick` / `kickServices` drains the effects worker on an interval, so this happens without a process restart.

A new 4-attempt `reconcile_execution` job does not bound that loop. `reconcileExecution` also throws a generic `Error` with `status: 503` when the lookup stays `unknown`. `classifyFailure` treats `status >= 500` as `retryable`, then `dead` at `max_attempts`. The spec's "complete the job, no dead-letter" rule has to name this throw and the `external_dispatch` recovery loop, or the bound is fiction.

Separate hole in the same catch path: `knownNoEffect` is true when status is already `dispatched` and `error.definitiveNoEffect === true`. The row becomes `cancelled` / `confirmed_no_effect`, the claim is released, and `intent` will dispatch that key again. `performPlatformRequest` sets `definitiveNoEffect` on **429** as well as 401, 403, 405, 413, and 415 (`src/connectors/platform-api.js`), after `beforeDispatch()`. The spec says "do not POST again on 429" only for Gmail. Gmail itself does not set `definitiveNoEffect` on 429 (`src/connectors/google.js`); platform writes do, and they share this ledger.

Required spec change: one owner for ambiguous retries. Cap or retire `deferRecovery` on `external_dispatch`. A `definitiveNoEffect` flag after `dispatched_at` is set must not become `confirmed_no_effect` for `provider.live === true`, including platform 429. List the Gmail status codes that are allowed to mean "no message created". "Documented as no message created" is not a list, and Gmail's send method does not document one in this repo.

### 4. The model can supply the read-back that promotes a write to `verified`

The mail predicate is fixed and is the right bar. The spec then says connector and MCP writes become `verified` by "supplying the existing `ConnectorActions.verification` GET assertions". Those assertions are a tool argument on `platform_api` (`src/durable/connector-actions.js`). `verification()` accepts status 404 and 204 with no `matches`. `lookup` treats a verification request that 404s as `found` and returns a receipt with `status: 'verified'` and the execution key (`src/durable/connector-actions.js`):

```js
catch (error) { if (spec.status === 404 && error.status === 404) return { status: 'found', receipt: { id: receiptId || record.key, status: 'verified', idempotencyKey: record.key } }; throw error; }
if (read.status !== (spec.status || 200) || (spec.matches || []).some(match => !equal(pointer(read.body, match.pointer), match.value))) return { status: 'unknown' };
return { status: 'found', receipt: { id: receiptId || record.key, status: 'verified', idempotencyKey: record.key } };
```

`ToolExecutionLedger.dispatch` marks the row `verified` when `verify` returns `found` and `validReceipt` matches. A model that passes `verification: { request: { path: '/does-not-exist' }, status: 404 }` satisfies that. A GET whose `matches` were already true before the write also satisfies it. Omission staying unverified does not matter if supplying a tautology is the success path.

This breaks "a model sentence is never success" for every non-mail write. The tool result's `verified: true` is the success signal. `WorkEngine.confirm` is not on this path, so "the task is not completed" is true and insufficient.

Required spec change: a model-authored verification spec must not be able to move a row to `verified`. Either those writes stay `accepted` / `verified: false` until a fixed per-family predicate runs, or the user approves the exact read-back with the one-shot credential. Delete the 404-as-found promotion, or explicitly keep it out of `verified`. The quiet-versus-blocker decision (open decision 2) is not meaningful until this is closed: the model can avoid the blocker by "verifying" the write.

### 5. The authority credential, the schema migration, and the strict YOLO rule are not implementable as specified

**Credential.** The spec says `PermissionPolicy.authorize` allows `execute_external` only when `AuthorityGate.decide` has attached a credential loaded from storage, and a bare permission string is a deny. It does not say what "attached" is. A boolean on the approval object can be set by the same callers that today pass `{ permission: 'user_approved' }`. Direct `policy.authorize` call sites that never go through the gateway include `WorkEngine.approve`, `WorkEngine.#executeAction`, `WorkEngine.executePreAuthorized`, and `ArtifactActions.undo`. `ArtifactActions.undo` defaults `actor` to `'user'` and then calls the policy with a synthetic approval (`src/durable/artifact-actions.js`). The HTTP route passes `actor: 'user'`, but so does every other caller that omits the argument. Tests already call `undo` without an actor.

`decide` has to be the only function that can return `allowed: true` for `execute_external`, and the policy must not accept a credential marker that other modules can construct. Tool arguments named `permission`, `grantId`, or `approved` are ignored today only if every allow path loads `Autonomy` or `task.action` itself. The spec should list the call sites above as mandatory rewires, including `#executeAction`'s second `policy.authorize(task.action)` after the action object is already stored.

**Revoke transaction.** YOLO grants live in the workspace snapshot. `Autonomy.revoke` updates them inside `store.mutate`, which already opens `database.atomic` (`src/durable/store.js`). A follow-up `atomic` after `revoke` returns is a second transaction: `SqliteStore.#assert` throws `STORE_TRANSACTION_ACTIVE` if `mutate` is entered while a transaction is open, so the cancel cannot wrap `revoke` from the outside. The cancel SQL has to run inside the `mutate` callback. Connector and artifact grants already use `database.atomic` and can share it. MCP `writeTools` are written by `McpManager.update` through `configStore.write` (`src/mcp.js`), which is not that SQLite transaction. "In the same transaction" is false for MCP. The spec should say the `mcpChecks` closure is the race control for MCP, and intent cancellation for MCP is best-effort after the config write.

**Schema.** `schema.sql` is applied with `CREATE TABLE IF NOT EXISTS`. Existing workspaces gain columns only through the `user_version` branch in `DurableDatabase` (`src/durable/database.js`, `schemaVersion` 7), which already has to `ALTER TABLE` for columns added after the table existed. Adding `evidence_json` and `authority_json` only to `schema.sql` leaves them absent on current databases, and `intent` "refusing to commit without `authority_json`" would then fail open or fail every write. The spec must bump `SQLITE_RUNTIME.schemaVersion` and add both columns with the same existence check the current migrator uses. The upgrade runs `schema.sql` first (`CREATE TABLE IF NOT EXISTS` does not alter an existing table) and then `ALTER TABLE` only when `table_info` lacks the column. A bare `ALTER` after a fresh `schema.sql` that already has the column fails the open.

**Strict scope has no replacement one-shot for MCP and platform calls.** Today `Autonomy.runReady` only calls `approve` or `applyDocumentPatch`. `docs/AUTONOMY.md` says YOLO does not add write adapters. The spec keeps `runReady` on mail and patches, and separately allows model-queued `platform_api`, `create_work_artifact`, and MCP writes whenever a YOLO lease is valid. There is no per-call confirm UI for those tools. The model path sets `explicit: false` (`ConnectorActions.mcpWrite`, `ArtifactActions.request` with `actor: 'activation'` via `schedulePrepared`). Under the strict rule the practical credential is a time lease. A time lease also auto-sends every ready mail draft and applies prepared document patches (`src/autonomy.js`). Users who turn YOLO on to restore Slack, GitHub, or MCP writes get a broader mail sender than the standing grant they had. The spec should state that coupling in the decision, not only in the migration paragraph.

`Calibration.allow` is described as still suppressing a repeated question. Under the strict rule a send still needs a one-shot approval or YOLO. YOLO does not consult `allow`. The question is the approval itself. The current settings copy is "Later replies send automatically once the evidence is complete" (`public/i18n.js`, rendered from `renderGrants` in `public/app.js`). The spec defers an `AUTONOMY.md` edit to the implementation change and does not mention this string. Shipping the policy change while that sentence remains is a false control.

## Should-fix

- Preserve `legacyMessageId` in `GoogleWorkspaceConnector.verify`. A legacy hit is `unknown` and does not authorize retry. The new predicate does not mention it. Dropping it, or treating a legacy hit as `found`, both break in-flight rows.
- `GoogleMailAdapter.verifyReceipt` copies `idempotencyKey` from the input receipt onto a `format=minimal` read that never saw `Message-ID`. `validReceipt` allows a missing key (`receipt.idempotencyKey == null`). Requiring the key on the receipt is tautological until the adapter stops stamping it and the direct read uses `format=metadata` with the header actually compared. The spec says both things separately; it should say the stamp is not evidence.
- The ledger timeout is one `Promise.race` deadline for `send` and, if added, `verify` (`ToolExecutionLedger.dispatch`). A slow send leaves the read-back no time and records `unknown` after Gmail accepted the message. Give the predicate its own bound, and still enqueue reconcile.
- The retry button is still rendered for every `confirmed_absent` action (`public/app.js`, and the Chinese string in the same file). `RETRY_NOT_SAFE` on the route leaves a control that always fails for live mail. The browser note in the spec covers attestation and omits this button.
- `schedulePrepared` queues artifact creates with `actor: 'activation'` and no YOLO grant. The spec's artifact row implies this stops, and no test names `schedulePrepared`.
- Idempotency keys should not be parsed for the attempt number. Task ids are values like `request:m1`. The spec already adds `action.sendAttempt`. Make that integer the authority for `n`, and treat the `:a{n}` suffix as a display of it.
- `WorkEngine.#sendFailure` returns `{}` for `error.ambiguous`, not only for `UncertainDeliveryError`. A Gmail body with no `receiptId` throws a plain `Error` inside `GoogleMailAdapter.send`; the ledger has already set `ambiguous`. The user text is the later lookup detail, or "Delivery timed out…", which is acceptable. The "Delivery failed:" prefix is the non-ambiguous branch. The spec should say which branch is which so a 4xx that was actually dispatched is not copied as a clean failure.
- Pause is `pauseTask` in `src/task-guidance.js`. It flips `control.paused` and does not touch `tool_executions`. The spec's cancel-on-pause rule needs the same in-callback SQL constraint as YOLO revoke.
- Redacted executions: `ToolExecutionLedger.verified` already replaces the result with id, provider, and status when `privacy_redacted` is set. `evidence_json` has to follow that helper. The spec says so; name the helper so a second writer does not store headers or snippets.
- `call_connected_tool` is catalogued as `effect: 'write'` (`src/mcp.js`) and then dispatches to the inner tool. Reads stay reads. A future change that trusts the dispatcher effect would wrap reads as writes or skip `isWrite`. Out of scope, worth one sentence so Gate 3 does not "fix" it.
- `McpManager.isWrite` forces the git preset's named read tools to read even when `readOnlyHint` is missing (`src/mcp-presets.js`, `GIT_READ_TOOLS`). The spec's residual risk covers a lying `readOnlyHint`. It should also say a name allowlist is an authority bypass if a later preset copies it for tools that mutate.

## Gaps versus the stated goals

| Goal | Holds on this branch | Gap the spec still has |
| --- | --- | --- |
| Timeout reconcile | A hung durable send becomes `unknown` and the `external_dispatch` job is recovered by `DurableRuntime.recover` until the lookup changes. Restart also runs `importUncertainActions`, `recoverUnfinished`, and `WorkEngine.restorePendingWork`. | The spec describes a missing enqueue. The live path is an uncapped `deferRecovery` loop. A 4-attempt job stacked on it does not create the bound. No durable runtime still has no job; `LEDGER_REQUIRED` is what closes that, and it has to refuse before `provider.send`. |
| Explainable failure | `WorkEngine.uncertain` sets `task.reason`, records history, and emits one `blocker:{taskId}` notification. `taskState` maps `verifying`, `executing`, `uncertain`, and `accepted_live` to `result_unverified`. | Codes are new and fine. `uncertain` is still fed by `#sendFailure`, which collapses several causes into `{}` or a "Delivery failed" string. Credential 401/403 during `verifyMessage` are rethrown and then wrapped as unknown by `#verifyReceiptSafely`, which matches the spec's "if the POST might have happened, use `SEND_UNCERTAIN`". The spec should say the wrapper must keep `error.status`, because today's detail is only `error.message`. |
| Idempotency | Gmail `provider_idempotent` is 0 because `external` sets it from `provider.live === false \|\| provider.nativeIdempotency === true`. `GoogleMailAdapter` sets neither `nativeIdempotency` nor `reliableAbsence`. Search-miss absence is refused for that provider inside `ledger.reconcile`. | Engine `confirmed_absent` and ledger `confirmed_absent` are different writes. `WorkEngine.reconcile` can set the task flag without updating the ledger. `retry` then calls `external`, which throws `RECONCILIATION_REQUIRED` while the ledger row is still `unknown`. The spec's `RETRY_NOT_SAFE` is the right live-mail response, and it is not what the route does today. The dangerous reuse is `cancelled` + `confirmed_no_effect` after a dispatched `definitiveNoEffect`, not the Gmail search miss. |
| "Model said sent" is never success | The only `task.status = 'completed'` write for a mail reply is `WorkEngine.confirm`. Harness text in `src/tool-loop.js` forbids claiming completion. `acceptPreparedWork` completes a standing-intent preparation with `external: false` and is not a send. | Platform and MCP results report `verified` from the ledger. A model-supplied verification spec can set that bit (must-fix 4). The model can still say "sent" in prose; the spec is right that the task and the tool payload must disagree, and wrong that the existing verification object is how they become allowed to agree. |
| Authority is one choke point | `ToolSafetyGateway.authorize` re-reads the draft, the patch, or the connector request, then calls `PermissionPolicy`. `beforeDispatch` calls `authorize` again. Shadow rejects `execute_external` in the policy even when an approval object is present. | `PermissionPolicy.authorize` returns allow for `user_approved` when the object says so and the task id matches, and for `pre_authorized` when `source === 'user_stated'` and `scope.entity` is set (`src/permissions.js`). `ConnectorActions.authorize` returns that `pre_authorized` object for a non-explicit request. `WorkEngine.#runPreAuthorized` sends from `grantFor` (`src/calibration.js` + `src/engine.js` `assess`). Those descriptions in the spec match the code. The proposed gate does not, until the credential is unforgeable and the direct `policy.authorize` sites are in the change list. |
| Revocation works | `Autonomy.revoke` sets `status: 'revoked'`. The next `Autonomy.authorize` fails `valid`. `ConnectorActions.revoke` and `ArtifactActions.revoke` bump `version`, and later `authorize` checks it. `ResourceClaims` does not drop an unresolved claim on lease expiry. | Intent rows are not cancelled. That part of the spec is the right addition. It is not one transaction for MCP, and it does nothing for a row whose `authority_json` was never written. In-flight rows at upgrade have no `authority_json`; the migration section reconciles `executing` and `uncertain` and does not say what an `intent` row with a null credential does. `intent` must refuse the new write, and startup must cancel or block leftover `intent` rows instead of dispatching them. |
| The model cannot self-grant | No tool schema exposes `Autonomy.create`. `ExperienceService` rejects `authority` and `permissions` (`src/durable/experience.js`, `UNSAFE_EXPERIENCE`). `ConnectorActions.createGrant` requires `actor === 'user'` and `confirmed === true`. The bundled fetch tool refuses private addresses (`src/mcp-fetch-server.js`). | Ignoring tool arguments is not sufficient. Any local caller can `POST /api/autonomy` and `POST /api/tasks/:id/approve`. `server.js` checks `Origin` and does not authenticate. The spec accepts the local process as the user boundary. Say explicitly that a user-enabled MCP write tool which can reach that origin is outside the gate, because the tool calls the route rather than passing `grantId`. `ArtifactActions.undo`'s default `actor = 'user'` is an in-process version of the same pattern. |

## Incorrect assumptions about current code

These are places the spec describes this branch wrongly. The surrounding requirement can still be right.

- "Nothing enqueues reconciliation until restart or an explicit reconcile." `reconcile_execution` is enqueued from `importUncertainActions`, `recoverPreparedDispatch`, privacy, and artifact uncertainty. Independently, an in-process ambiguous `external_dispatch` is reconciled by `DurableRuntime.recover` without that job type. See must-fix 3.
- "`WorkEngine.retry` reuses the same idempotency key after `confirmed_absent`" as if that reuse reaches Gmail. `retry` does set the action back to `executing` and calls `execute` with the same key (`src/engine.js`). On the durable path, `external` refuses a key that is not `failed` or `cancelled`. Live Gmail does not set `provider_idempotent`, so `ledger.reconcile` does not mark `confirmed_absent` on a search miss. The duplicate POST on the durable Gmail path is the `definitiveNoEffect` reuse in must-fix 3, plus any send with `durableRuntime` absent. The spec's `LEDGER_REQUIRED` rule is what closes the second one. `SimulatedMailProvider.send` already returns the existing outbox row for the same key, so a same-key simulated retry does not duplicate locally.
- "Both direct read and search use one predicate" as a description of today. Search in `GoogleWorkspaceConnector.verify` checks `Message-ID`, `SENT`, and a single hit, using `format=metadata`. `verifyMessage` uses `format=minimal` and checks id plus `SENT` only. The spec is right about the gap and wrong if an implementer thinks `verifyMessage` already receives the header. `GoogleMailAdapter.lookup` prefers `verifyMessage` whenever `receiptId` is present, so the weak path is the one reconciliation hits after acceptance.
- "`validReceipt` for live `email.send` requires the key" as a description of today. The current helper allows a null key. The spec is a change. Good. It is not a description of `src/tool-gateway.js`.
- "Cancelling `intent` rows is what makes revoke hold even if a caller forgot the second check." `beforeDispatch` in `ToolExecutionLedger.dispatch` already re-invokes `intent.authorize`, and the mail closure calls `ToolSafetyGateway.authorize`, which re-reads calibration or the YOLO callback. A captured `{ allowed: true }` would be a new bug. The cancel is still worth doing. The spec should not describe the current mail hook as a stale closure.
- "The ledger can stay `accepted` until a later engine read-back" for `email.send`. That part is accurate: `DurableRuntime.external` defaults `verify` to null, and the comment above the `waiting` task-run update says acceptance still needs the engine read-back. `confirm` then calls `verifiedAction`, which writes `verified`. The hole is the weak predicate and the crash window, not a missing read-back on the happy path. `#executeAction` does call `#verifyReceiptSafely` before `confirm`.
- Document patches. `GoogleDocsWriteProvider.apply` already reads the document back and sets `readbackVerified` only after the content matches (`src/document-delivery.js`). The ledger callback in `applyDocumentPatch` trusts that flag and can mark the execution `verified` before the later ingest comparison. If those disagree, the patch is set `uncertain` while the ledger stays `verified`. The next `reconcileExecution` sees `found` from the stored row and sets the patch back to `applied`. The spec's "do not trust the flag" rule is right. Add that a `verified` patch row must not be written before the independent `provider.read` comparison, or the short-circuit in `ledger.reconcile` will undo the uncertain state.

Assumptions that match the code and should stay:

- `gmailMessageId` is `<unprompted-{sha256(key)}@unprompted.local>` (`src/connectors/google.js`).
- `#request` retries only when `retry` is true, and the default is `method === 'GET'`. `execute` does not pass `retry: true`.
- `provider.live === true` with no durable runtime calls `provider.send` from `#sendSafely`.
- `mcpWrite` passes `verify = null`.
- Mail idempotency keys are `send:{taskId}:{document.version}` plus optional `:r{revision}` when the commitment revision is greater than 1 and `:i{inputVersion}` when a durable runtime exists. There is no attempt counter.
- `Autonomy.create` forces `source: 'user'` and has no version field. Missing version as 1 is a compatible default.
- One-shot approval skips `requiresReview` and inactive activation. YOLO and `pre_authorized` do not (`src/tool-gateway.js`, `DurableRuntime.external`).
- Shadow wins over approval in `PermissionPolicy.authorize` and again in `GoogleMailAdapter.send` / `GoogleWorkspaceConnector.execute`.

## Missing failure modes

- **Verified then search lag, then a new key.** Covered in must-fix 1. This is the duplicate the attestation flow introduces.
- **Two reconcilers.** `engine.reconcile` from the button, `recover` on the dispatch job, and a new `reconcile_execution` job can run together. Reads are safe. Downgrades are not. A `not_found` from one path must not overwrite `verified` or clear `receiptId`.
- **`INSERT OR IGNORE` on jobs.** `DurableJobs.enqueue` keeps the first row for `(queue, idempotency key)`. A completed or dead reconcile job with a stable key will not run again. Manual Reconcile goes through `WorkEngine.reconcile`, so the button still works. A second automatic enqueue with the same key does not. Specify the key, and specify that a user Reconcile either calls the engine directly or uses a new key.
- **Shared abort.** Ledger abort and `GoogleWorkspaceConnector.#request`'s own timeout both abort the same POST. The POST is single-shot today. The spec's regression test is still warranted. Add the case where `beforeDispatch` has committed and the abort fires during `fetch`: status `unknown`, one POST, claim unresolved.
- **Gmail 400 versus platform 400.** Gmail 4xx other than the thrown 401/403 paths become `unknown` because they are not `definitiveNoEffect`. Platform 429 becomes `cancelled` and reusable. One taxonomy has to cover both families. Slack `ok: false` is already non-definitive (`performPlatformRequest`). Keep that.
- **Header stripped or rewritten.** The spec accepts a permanent `unknown`. Good. Attestation is then the only exit. That makes open decision 1 load-bearing for ordinary mailbox rules, not only for a lost response.
- **Direct read 404.** `verifyMessage` returns `not_found` on 404. After `dispatched`, `normalizeLookup` upgrades that to `unknown` only for the statuses it lists. A caller of `verifyMessage` that skips the helper can still treat 404 as absence. The spec says a caller that skips `normalizeLookup` can `retry`. Put the upgrade inside `verify` / `verifyMessage` when `dispatched_at` is set, so the helper is not the safety boundary.
- **Document patch flag versus ledger.** Covered above. A second `provider.read` that runs inside `apply` and again inside `verify` can also race a concurrent user edit and stick the patch at `unknown` forever. The spec should say a mismatch is `unknown` and is not a new `batchUpdate`.
- **`user_attested_absent` plus YOLO.** The spec forbids `runReady` from approving that draft. `runReady` currently keys off `ready_for_approval`, a draft, and `!task.action`. After attestation clears `task.action`, the draft matches `runReady` unless a new flag is checked. Name the flag `runReady` reads. `guidanceReviewRequired` is set on the denied-before-dispatch path in `#executeAction` and would work if attestation sets it. The spec mentions it for revoke, not for attestation.
- **Spent approval.** The spec says `beforeDispatch` spends the one-shot. `task.action` still holds `permission: 'user_approved'` after dispatch. A second `execute` on a `cancelled` / `confirmed_no_effect` key reuses that object. Spending has to be a stored bit that `decide` reads, or the second POST is still the same approval.
- **Self-grant through the local API.** Residual, accepted by the spec's single-user boundary. Do not claim tool-argument filtering closes it.
- **Needs-you budget.** One blocker per unverified platform or MCP write competes with the mail blocker that this release is about. `dedupeKey` is `blocker:{taskId}` in the spec, so a platform write and a mail failure on the same task replace each other's copy. That hides the mail failure. Dedupe per execution id, as the spec also says "one blocker per execution id", contradicts `blocker:{taskId}`. Pick one. Per execution id is the one that does not erase the mail card. It is also the one that stacks cards if decision 2 stays loud.

## Test plan gaps

The listed files are the right suites. These cases are missing, and they are the ones that fail if the must-fix items are implemented carelessly:

| Case | Why |
| --- | --- |
| Ledger `verified`, then a search miss, then `reconcile` and a new attempt key | Must not POST and must complete from the stored receipt. |
| Attestation on an `unknown` row, then `approve` | Claim is acquirable, no POST of the old key, prior `verified` row skips the POST. |
| `dispatched` plus `definitiveNoEffect` (platform 429 and a Gmail 400) | Live providers do not return to `intent` on that key. Fetch count stays 1. |
| In-process timeout with the effects worker running | `deferRecovery` stops at the stated bound. No second `external_dispatch`. The job does not end `dead` solely because reconcile threw 503. |
| `platform_api` verification `{ status: 404 }` and a `matches` entry that was true before the write | Ledger stays unverified. |
| Existing SQLite file at `user_version` 7 opened after the change | `evidence_json` and `authority_json` exist and are null. Writes still run. |
| `Autonomy.revoke` inside one `store.mutate` | The `intent` update commits or rolls back with the grant. A second connection's `beforeDispatch` cannot observe revoked-grant plus `intent`. |
| MCP `writeTools` removal | The in-flight `check` closure fails `beforeDispatch`. Document that this is not the SQL transaction. |
| `schedulePrepared` with an automatic artifact grant and no YOLO lease | No `artifact_publish` job. |
| `ArtifactActions.undo()` called with no actor argument | Refuses, and does not call `provider.remove`. The HTTP route still undoes. |
| `PermissionPolicy.authorize({ permission: 'user_approved' })` and the same object passed through `#executeAction` | Both refuse unless `decide` loaded a stored approval. |
| Browser: live `confirmed_absent` does not offer Retry; attest does not show a sent receipt | Extends `test/browser/autonomy.mjs`. The current retry button is the regression. |
| Settings copy and `renderGrants` | After the strict rule, the screen does not say later replies send automatically, unless the human keeps that behavior. |

Scripted transports remain the right bar. Do not add a live Gmail account.

## The five open decisions

These are evaluations of coherence. They are not a choice.

### 1. Attestation, versus never minting a second key

The spec recommends a user attestation that closes an inconclusive live attempt without sending, then a fresh approval on a new key, with YOLO forbidden for that replacement.

The recommendation is the only exit the rest of the spec leaves for a dispatched attempt that Gmail did not index, a 429, or a mailbox rule that strips `Message-ID`. The alternative (stay blocked until a read-back returns `found`) matches the invariant "a key that reached `dispatched` is never POSTed" and avoids a wrong attestation. It can strand a draft. The spec already accepts that stranding as a remaining risk for a stripped header, then adds attestation anyway.

The recommendation is not coherent with the current claim and `confirm` machinery until must-fix 1 and 2 are rewritten. Implemented as the sequence is written, the replacement cannot acquire the resource, and a lagged search on a new key can duplicate a message the ledger already verified. The alternative is coherent with the code that exists. It is harsh on 429s that almost certainly created nothing, because the spec also refuses to treat 429 as `confirmed_no_effect`.

Gate 3 needs the human answer first. The state machine, the claim release, and the 429 taxonomy are different programs under the two answers.

### 2. A Needs-you card for every unverified platform or MCP write, versus keeping it off the workspace card

The spec recommends one blocker using `SEND_ACCEPTED_UNVERIFIED`.

That recommendation fights the product's own noise problem. `platform_api` and MCP writes are how exploratory calls happen. A card per execution will sit next to, or replace, the mail card (`blocker:{taskId}` versus "one blocker per execution id" — the spec says both). The quiet alternative leaves the result in the execution list and the tool payload. That matches "the task must not complete" only if something the user actually sees still says unverified. A tool payload the model reads is how "the model said sent" gets repeated back.

Neither alternative is coherent while must-fix 4 stands. A model that can pass a 404 verification never raises the card and does get `verified: true`. Decide the card only after model-supplied specs cannot verify a write.

### 3. Standing scope does not authorize a mutation, versus treating those records as the approval

The spec recommends the strict reading: connector grants, artifact grants, calibration `allow`, and MCP `writeTools` narrow a mutation and do not allow it. YOLO or a one-shot approval is also required.

The strict reading matches the invariant in the problem statement. It does not match the product this branch ships. `assess` calls `#runPreAuthorized` from `grantFor`. The settings row says later replies send automatically. `docs/AUTONOMY.md` limits YOLO to prepared mail and document patches. MCP writes and `platform_api` already run on their own grants with `pre_authorized`.

The strict rule is internally inconsistent on calibration. It says `allow` records that the user did not ask to be prompted, and also that a send still needs an approval or YOLO. Those cannot both be true. `never` and `ask_each_time` blocking YOLO is coherent with today's activation exception. `allow` becoming a no-op is a silent removal of a control the UI still advertises.

The practical failure mode is substitution. There is no one-shot confirm for an MCP or platform call in this spec. Restoring today's MCP behavior means turning on a time lease, and `runReady` will then send ready mail and apply prepared patches across the workspace. Strict is safer only if people do not do that. The alternative (standing records remain the approval) is weaker than the invariant and is what the code does now. It keeps mail auto-send scoped to the entity the user named, which is narrower than a workspace time lease.

This is the decision that most changes the meaning of YOLO. It should be answered before implementation, with the UI strings in the same change as the policy. A spec that defers the copy to a later `AUTONOMY.md` edit will ship a lie in `renderGrants`.

### 4. No grandfathering of calibration auto-send, versus keeping it until the user edits that calibration

The spec recommends stopping auto-send on existing installs immediately.

That is coherent with decision 3 and with the revoke story: a hidden grandfather is hard to explain after the user hits Revoke. It is incoherent with decision 3's alternative. If standing `allow` remains an approval, there is nothing to grandfather. If strict wins, immediate cutoff is the coherent default only together with a visible change to the agreement row. "Drafts stay prepared. No migration job sends them" is the right safety property. Users who relied on the agreement will see ready drafts and the old sentence until the copy changes. That is a trust failure, not a duplicate-send failure.

Answer this with decision 3. Do not implement a third behavior in which old rows send and new rows do not unless the human asks for it. Two policies for one `allow` value is the outcome the spec correctly calls hard to explain.

### 5. A direct approval still bypasses `requiresReview`, versus `requiresReview` also blocking that approval

The spec recommends keeping today's rule.

That recommendation matches the code. `ToolSafetyGateway.authorize` and `DurableRuntime.external` skip the activation block when `permission === 'user_approved'`. The Approve button is that one-shot. The alternative makes `requiresReview` a second control and changes what Approve means. The spec is right that this is a product change, not a bugfix.

The risk the spec names is real and is the reason the exception is sharp: any bug that stores `user_approved` without a user handler becomes a self-grant, and activation will not catch it. The recommendation stays coherent if must-fix 5 lands (approvals are created only by the HTTP handlers, `decide` reloads them, `#executeAction` cannot bless a string). It is not coherent if `user_approved` remains an object any caller can pass into `PermissionPolicy`. The alternative is coherent with a stronger reading of `requiresReview` and incoherent with the current Approve button. Either can be implemented. The recommended default does not need to change unless the human wants a second click. It does need the unforgeable credential, or the exception is the bypass.

## Gate 3

Wait. The five decisions are not polish. Decision 1 selects the state machine for every inconclusive live send. Decision 3 selects what `AuthorityGate.decide` is allowed to load, and it changes YOLO from a mail and patch sweep into the credential for MCP and platform writes. Decision 4 is the migration form of decision 3. Decisions 2 and 5 can be answered in the same pass; decision 2 is blocked on the verification-spec hole anyway.

The must-fix items are spec repairs, not implementation notes. An implementation that starts from the documents as they stand will mark tautological platform reads as verified, will fail to release claims on attestation, and will leave the existing recovery loop uncapped under a new job that claims to be the bound.
