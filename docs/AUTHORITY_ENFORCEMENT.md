# Authority enforcement

[← Documentation](README.md)

> **Superseded where it conflicts.** Runtime behavior is defined by
> [Send authority locked](SEND_AUTHORITY_LOCKED.md). This file is the earlier
> draft. Standing connector, artifact, MCP `writeTools`, and calibration
> `allow` records count as in-scope approval credentials at `AuthorityGate.decide`
> (locked decision 3). They must not bypass that gate. Where this draft says
> those records cannot authorize a mutation by themselves, follow the locked
> document. The independent lock review is
> [SEND_AUTHORITY_LOCKED_REVIEW.md](reviews/SEND_AUTHORITY_LOCKED_REVIEW.md).

Historical draft. It specifies the execution-layer check for outbound
mutations. Read-back and retry rules for those mutations are in
[Send read-back verification](SEND_VERIFICATION.md), also superseded where it
conflicts with the locked document.

Observation and preparation stay quiet. An external mutation needs a
persisted user credential that the execution layer reads again at dispatch.
A model response, a tool argument, or a button that only hides a control is
not that credential. Revoking a grant stops the next side effect immediately.
It does not recall an effect the provider already accepted.

## Problem

The engine already says external writes need approval, and YOLO leases are
stored on the workspace rather than taken from the model. Several paths still
treat a permission string assembled by the caller as the credential:

- `PermissionPolicy.authorize` returns allow for `user_approved` when the
  object says so and the task id matches. It does not read a stored approval.
- `ArtifactActions.undo` calls that method with a synthetic
  `{ permission: 'user_approved', taskId }`.
- `ConnectorActions.authorize` returns `pre_authorized` for a model-queued
  platform or MCP write. For MCP, the scope entity is the server id. The
  policy then allows it because `source` is `user_stated` and `scope.entity`
  is set. The real user choice, if any, is the MCP `writeTools` list or a
  connector grant, which the policy object does not carry.
- `WorkEngine.#runPreAuthorized` sends mail when `grantFor` finds a
  calibration `allow`. That is a standing user answer, not a YOLO lease and
  not a fresh approval of this draft.
- `Autonomy.revoke` flips the lease to `revoked`. The next
  `beforeDispatch` fails the lease check. A row already in `intent` is not
  cancelled, so a slow worker depends entirely on remembering to call the
  gate again.

Paid use needs one gate. If there is no one-shot approval and no active YOLO
grant, the gate refuses the mutation even when a standing scope exists.

## Threat and failure modes

| Threat | Current hole | Required outcome |
| --- | --- | --- |
| Model self-grant | Prompts in `src/tool-loop.js` and `src/pi-runtime.js` forbid it. Experience records already reject authority fields. No tool creates a lease. The policy still trusts a permission string if some other code passes one. | The gate loads credentials from persistence. Tool arguments named `permission`, `grantId`, or `approved` are ignored. |
| UI-only revoke | The Revoke control calls `POST /api/autonomy/:id/revoke`, which updates `autonomyGrants`. Dispatch re-reads the lease. Intent rows are not cancelled. | Revoke cancels undispatched intents for that grant before the handler returns. |
| Stale YOLO | `Autonomy.authorize` checks `status`, expiry, task identity, and `source === 'user'`. `ToolExecutionLedger.dispatch` calls `authorize()` inside `beforeDispatch`. | Keep that re-check. Add the intent cancellation above so a worker cannot dispatch a captured closure that skipped the hook. |
| Standing scope used as a send | Calibration `allow`, connector path grants, artifact destination grants, and MCP `writeTools` each allow a class of writes without a per-action click and without YOLO. | Those records remain necessary scopes. They do not, by themselves, authorize a mutation. |
| Shadow bypass | `PermissionPolicy` and the Gmail adapter refuse writes in shadow mode. | Unchanged. Shadow wins over approval and YOLO. |
| Prepare mistaken for send | `observe` and `prepare` do not require approval. Drafts, patch preparation, and reads are local. | Unchanged. No new prompt for those classes. |
| Late revoke | A POST that has passed `beforeDispatch` cannot be pulled back. The workspace already says a paused task does not unsend a request that left. | Unchanged. The outcome goes to read-back reconciliation, not to a second write. |

## Current behavior

Action classes live in `src/permissions.js`. `observe` and `prepare` do not
require approval. `execute_external` does. Shadow mode rejects
`execute_external` even when an approval object is present.

The practical choke points are:

| Step | Where | What it trusts |
| --- | --- | --- |
| Policy | `PermissionPolicy.authorize` | The `approval` argument for `user_approved` and `pre_authorized`. The `temporaryAuthorization` callback for YOLO, which `WorkEngine` wires to `Autonomy.authorize`. |
| Adapter boundary | `ToolSafetyGateway.authorize` | For `email.send`, the stored draft, `task.action`, and a fresh `grantFor` lookup when the action is `pre_authorized`. For patches, `patch.authorization`. For artifacts and connector writes, the matching service `authorize`. Then the policy. |
| Ledger | `ToolExecutionLedger.intent` and `dispatch` `beforeDispatch` | A caller-supplied `authorize` function. Writes without one are refused. The function runs at intent and again before the provider call. |
| Mail entry | `WorkEngine.approve`, `#runPreAuthorized`, `retry` | `approve` builds `user_approved` or `temporary_yolo` from the HTTP/YOLO caller. `#runPreAuthorized` builds `pre_authorized` from calibration state. |
| Patch entry | `TaskServices.applyDocumentPatch` | Explicit consent fields or `autonomyGrantId`. The durable path reaches the gateway through `beforeWrite`. |
| YOLO sweep | `Autonomy.runReady` | Active lease, then `approve` or `applyDocumentPatch` with that grant id. It skips paused tasks, guidance review, and tasks that already have an action. |
| Platform and MCP | `ConnectorActions.request` and `mcpWrite` | A covering connector grant, or the MCP `check` closure, then a synthetic policy approval. |
| Activation | `DurableRuntime.external` and the gateway | `requiresReview` and inactive activation block non-`user_approved` actions. A one-shot approval can still proceed. |
| Harness | `src/tool-loop.js`, `src/pi-runtime.js`, `src/durable/runtime.js` `tools` | The model may call read tools and `create_work_artifact` / `platform_api` only inside those adapters. It has no autonomy or grant-creation tool. |

`Autonomy.create` rejects shadow mode, validates time versus task scope, and
revokes the previous lease of the same mode and task. `source` is always
`user`. Time leases store `expiresAt`. Restart does not extend them.
`GET /api/state` exposes `autonomy.enabled` and active grants. The local HTTP
routes are the user boundary on a single-user machine. Model tools are not
those routes.

Calibration `grantFor` in `src/calibration.js` returns a user-stated `allow`
scoped to an entity. `permissionAnswerFor` finds `never` and `ask_each_time`
so the engine can stop asking. Inferred calibrations cannot authorize a
permission key. `ExperienceService` rejects records that try to set
`permissions` or `authority`.

Artifact and connector grants are created only when `actor` is `user` and
`confirmed` is true. `revoke` increments `version`. Later `authorize` fails
the version check. That part is already a real revoke for the next dispatch
that goes through those methods.

## Proposed architecture

One decision function, `AuthorityGate.decide`, is the only way to allow
`execute_external`. Implement it on `ToolSafetyGateway`, not as a new
service. `PermissionPolicy.authorize` becomes the shadow and action-class
check. It allows a write only when `decide` has attached a credential loaded
from storage. A bare `permission` string is a deny.

`ToolExecutionLedger.intent` keeps requiring `authorize`. That function must
be `AuthorityGate.decide`. `beforeDispatch` calls it again and also checks
that `authority_json.version` still matches the stored credential. A missing
`dispatchGuard` remains `DISPATCH_GUARD_REQUIRED`.

### Credentials that can allow a mutation

Both of these are loaded from the workspace store or the durable database.
The model cannot insert them.

| Kind | Stored today | Allows a mutation when |
| --- | --- | --- |
| One-shot approval | `task.action` after `WorkEngine.approve` without a grant id; `patch.authorization.kind === 'explicit'`; connector or artifact request with `explicit: true` created by a user HTTP handler; a user undo request created by that handler | The effect digest, task id, input version, and review token still match the stored approval. |
| YOLO grant | `state.autonomyGrants` via `Autonomy` | `Autonomy.valid` is true for this task, the id matches, and `source` is `user`. |

`decide` returns deny when neither row is live. It does not accept
`pre_authorized` as a third allowing kind.

### Scopes that cannot allow a mutation by themselves

These stay in place. They narrow what an approval or a YOLO lease may do.
If the scope does not cover the effect, the answer is deny even when YOLO
is active.

| Scope | Store | Effect |
| --- | --- | --- |
| Calibration `never` or `ask_each_time` | `calibrations` | Deny automatic and YOLO mail for that entity and deliverable. A one-shot approval of this draft may still proceed, matching today's activation exception for `user_approved`. |
| Calibration `allow` | `calibrations` | No longer starts `#runPreAuthorized` by itself. It does not expand YOLO. It only records that the user did not ask to be prompted again for that scope. |
| Connector action grant | `connector_action_grants` | The method and path must be inside the grant. The grant's existence is not enough. |
| Artifact destination grant | `artifact_grants` | The target account and family must match. `automatic: true` may queue a request only while YOLO is active. |
| MCP `writeTools` | MCP config | The tool must be in the current list. Membership is not enough. |
| Activation `requiresReview` or inactive activation | durable activation policy | Blocks YOLO. A one-shot approval of this effect may proceed, as it does now. |
| Shadow | `PermissionPolicy.shadow` | Blocks every external write. |

`Autonomy.runReady` therefore runs only while a lease is valid, and only for
the mail send and document patch it already drives. `#runPreAuthorized` no
longer sends. Standing calibration can still suppress a repeated question.

Model-queued `platform_api`, `create_work_artifact`, and MCP writes call
`decide` and pass only when a YOLO lease is valid and the scope matches.
A user HTTP call with `actor: 'user'` and `confirmed: true` is a one-shot
approval and does not need YOLO. Undo uses that same user-handler approval.
It must stop calling `policy.authorize` with a synthetic object.

### Revocation

Revoke and expiry are stored transitions, then a synchronous cancel of work
that has not reached the provider.

`Autonomy.revoke`, lease replacement inside `Autonomy.create`, calibration
changes that remove a YOLO-relevant allow, connector `revoke`, artifact
`revoke`, and removal of an MCP write tool all do this before they return:

1. Persist `revoked` or the new version. Time expiry is the same transition
   with status `expired`, using the existing `Autonomy.expire` check against
   `expiresAt`.
2. In the same transaction, select `tool_executions` whose `authority_json`
   references that credential and whose status is `intent` with
   `dispatched_at` null.
3. Set those rows to `cancelled` / `confirmed_no_effect`, release their
   claims, and record `SEND_DENIED` on the task if it was about to send.
   The draft returns to `ready_for_approval` with `guidanceReviewRequired`
   when the effect was a reviewed reply or patch. Do not clear a draft the
   user had not asked to discard.
4. Do not modify `dispatched`, `accepted`, `unknown`, or `verified`. Those
   follow read-back reconciliation. Revoke is not an undo of a sent message.

The next `beforeDispatch` on any other worker reads the new status and
refuses. Cancelling `intent` rows is what makes revoke hold even if a caller
forgot the second check. The second check stays anyway.

Pause already denies in the gateway. Keep it. Pause is not a grant revoke.
It stops this task's later effects the same way: cancel its undispatched
intents, reconcile anything already dispatched.

### What stays silent

`observe` and `prepare` stay `requiresApproval: false`. Reading mail,
drafting a reply, preparing a patch, and shadow review do not raise a
permission card. A refused mutation uses the existing Needs-you / blocked
task state and one blocker notification, with `SEND_DENIED` or the more
specific code from the send design. It is not a chat message and not a new
settings surface.

YOLO's existing status line and Revoke button stay. This design does not add
a second autonomy mode.

## State machine

```text
credential stored
(approval row or YOLO grant, source=user, status=active)
        |
        v
AuthorityGate.decide at intent
        | allow                         | deny
        v                               v
tool_executions.intent            no provider call
authority_json saved              task stays ready or blocked
        |
        | revoke / expire / pause / scope changed
        v
cancelled + confirmed_no_effect
(only if dispatched_at is null)
        |
        | still active at beforeDispatch
        v
dispatched --> provider
        |
        +--> read-back (send design)
             revoke does not move this row
```

YOLO grant states remain `active`, `revoked`, and `expired`. A task lease
also stops being valid when the task is completed, cancelled, dismissed, or
privacy-invalidated, which `Autonomy.valid` already encodes. Replacing a
lease revokes the previous id. Reopening a task does not revive a task
lease.

One-shot approval states:

| State | Meaning |
| --- | --- |
| `stored` | User handler wrote the approval bound to this effect. |
| `spent` | `beforeDispatch` committed. The approval cannot start a second POST. |
| `withdrawn` | User rejected, paused, or the draft/review token changed before dispatch. |

A spent approval is not a standing grant. The next send needs a new approval
or a still-valid YOLO lease, subject to the replacement-attempt rule in the
send design.

## Sequences

### No credential

1. A tool calls `platform_api`, `create_work_artifact`, or an MCP write.
2. No one-shot approval exists. `Autonomy.forTask` returns null.
3. `decide` throws `AUTHORIZATION_REQUIRED` with `definitiveNoEffect`.
4. The ledger does not insert a write intent. No fetch runs.
5. The tool result is a refusal. The task is not completed. If the model was
   about to send a reviewed reply, the draft stays `ready_for_approval`.

### One-shot mail approval

1. `POST /api/tasks/:id/approve` runs in the user HTTP handler. The body
   cannot set `permission` or `grantId`. Today it may pass `reviewToken`
   only. Keep that.
2. `approve` re-checks freshness and calls `decide`, which finds the
   approval it is about to store, or stores the approval and then calls
   `decide` before any provider I/O.
3. Intent and `beforeDispatch` call `decide` again.
4. After `dispatched`, the approval is `spent`.
5. Read-back follows the send design.

### YOLO, then revoke before dispatch

1. `POST /api/autonomy` with `mode: time` or `mode: task` creates the grant.
   The handler is the user route, not a tool.
2. `runReady` calls `approve` or `applyDocumentPatch` with `autonomyGrantId`.
3. Intent stores `authority_json` for that grant id and version.
4. The user revokes. The handler sets `revoked` and cancels the `intent` row
   in that transaction.
5. `beforeDispatch` is not reached. `fetch` is not called.
6. A second task discovered during a time lease also stops, because
   `forTask` no longer returns the grant.

### Revoke after dispatch

1. `beforeDispatch` has set `dispatched`.
2. Revoke does not cancel that row and does not POST a countermand.
3. The send design reconciles. The user-facing copy says the request may
   already have left.
4. A later effect on the same grant is refused.

### Standing grant without YOLO

1. A connector grant covers `POST /api/chat.postMessage`, or a calibration
   `allow` covers this sender, or an MCP tool is listed in `writeTools`.
2. The model calls the tool, or `#runPreAuthorized` would have run.
3. `decide` denies with `AUTHORIZATION_REQUIRED`. The scope match is recorded
   in the error detail so the user can tell "not included in the grant" from
   "grant exists but automatic send is off".
4. The same effect succeeds later if the user approves that call or turns
   YOLO on, and the scope still matches.

### Model attempts to grant itself

1. Tool arguments include `permission: user_approved` or a `grantId`.
2. `decide` ignores those fields and loads storage.
3. No tool schema exposes `Autonomy.create`, `createGrant`, or calibration
   writes that set a permission to `allow`.
4. An Experience payload with `authority` or `permissions` keeps the existing
   `UNSAFE_EXPERIENCE` refusal.

## Data model

Do not add a parallel grant table. YOLO stays in `autonomyGrants`. One-shot
mail approvals stay on `task.action`. Patch consent stays on
`patch.authorization`. Connector and artifact grants stay in their JSON
settings rows. MCP write allow-lists stay in the MCP config.

Add the nullable `authority_json` column on `tool_executions` described in
the send design. Shape:

```json
{ "kind": "approval", "id": "send:task:version:a1", "version": 1 }
```

or:

```json
{ "kind": "yolo", "id": "<grant uuid>", "version": 1 }
```

YOLO grants gain a numeric `version`, starting at 1. Revoke and replacement
increment it. Existing grants without a version are treated as version 1.
`Autonomy.create` already replaces the previous lease; it must also run the
intent-cancel step for the old id.

One-shot approvals store `effectDigest` (the same digest the gateway already
computes for the body or patch), `reviewToken` when the draft has one, and
`inputVersion`. `WorkEngine.approve` already copies most of this onto
`task.action`. The implementation fills any missing digest rather than
trusting the client to send one.

`authority_json` for a redacted privacy execution keeps kind and id only.

## Error taxonomy

Reuse the notification and `task.reason` path from the send design. These
codes are the authority subset. `definitiveNoEffect` is set when no POST
started, so the ledger can cancel instead of reconciling.

| Code | User-facing explanation | Next step |
| --- | --- | --- |
| `AUTHORIZATION_REQUIRED` | This would change an external system, and there is no approval or active YOLO for it. | Approve this action, or turn YOLO on for the task or a time window. |
| `GRANT_INACTIVE` | YOLO expired or was revoked before the action was sent. Nothing was sent. | Review the draft. |
| `GRANT_SCOPE` | YOLO is on, but this account, path, or tool is outside the grant you gave. Nothing was sent. | Adjust the connection grant, or approve a different action. |
| `EFFECT_MISMATCH` | The action no longer matches the reply or patch you reviewed. Nothing was sent. | Review the updated draft. |
| `REVIEW_REQUIRED` | A policy on this work asks for a direct approval. YOLO will not send it. | Approve this one. |
| `SHADOW_READ_ONLY` | Shadow mode is read-only. Nothing was sent. | Leave shadow before a real send. |
| `SEND_DENIED` | The same as `GRANT_INACTIVE` when a send had already been approved and the credential changed. | Review the draft. |

`AUTHORIZATION_REQUIRED` is the code for the invariant "no approval and no
YOLO". Do not describe that refusal as a provider failure.

## Test plan

| Case | Where |
| --- | --- |
| `PermissionPolicy.authorize({ permission: 'user_approved' })` without a stored approval throws | `test/permissions.test.js` |
| Synthetic approval in `ArtifactActions.undo` does not write; a user undo route does | `test/artifact-actions.test.js` |
| Model `platform_api` and MCP write with a covering scope and no YOLO and no one-shot do not call `fetch` | `test/connector-harness.test.js` |
| The same MCP write succeeds when a time lease is active and `writeTools` still contains the tool, and fails if the tool is removed before dispatch | `test/mcp.test.js`, `test/autonomy.test.js` |
| Calibration `allow` does not call send by itself; `never` blocks even with YOLO; a one-shot approval still sends | `test/autonomy.test.js` and the engine pre-authorization tests |
| `Autonomy.revoke` cancels an `intent` row and the provider double is not invoked | `test/autonomy.test.js`, `test/durable-execution.test.js` |
| Revoke after `dispatched` does not cancel the row and does not send a second request | `test/durable-execution.test.js` |
| Expired time lease is refused at `beforeDispatch` even if the intent was created earlier | `test/autonomy.test.js` |
| Tool arguments cannot create a grant; Experience authority fields still throw | `test/durable-learning.test.js`, a tool-loop unit test |
| Shadow refuses YOLO and approval | existing shadow tests |
| Observe and prepare still run with no notification | `test/permissions.test.js` |
| Browser: Revoke during a prepared send leaves the draft in Needs you and does not show a sent receipt | `test/browser/autonomy.mjs` |

Scripted providers only. No live account.

## Non-goals

- A new permission system, role table, or multi-user session. The local
  process remains the user boundary.
- Letting YOLO skip freshness, review-token, shadow, privacy, or read-back
  checks.
- Recalling a message or patch that already reached `dispatched`.
- Turning standing connector, artifact, or MCP configuration into a silent
  send. Those screens stay the place the user bounds scope.
- Prompt-only enforcement. The harness sentences stay as a backstop and are
  not the control.
- Hiding revoked work. A refused send stays on the task as Needs you.

## Remaining risks

- Code that calls `provider.send`, `provider.apply`, or `requestApi` without
  `DurableRuntime.external` bypasses the gate. The implementation must make
  live writes unreachable except through the ledger. The send design's
  `LEDGER_REQUIRED` check is part of that closure. Review any new connector
  method the same way.
- `user_approved` inside `DurableRuntime.external` still skips
  `requiresReview`. That preserves an explicit click. A bug that stores an
  approval without a user handler would become a self-grant. Tests must
  construct approvals only through the HTTP handlers.
- Cancelling `intent` rows is only as strong as `authority_json`. A write
  that forgets to store it will not be found by revoke. `intent` must refuse
  to commit a write without `authority_json`.
- MCP `readOnlyHint` is an untrusted claim. `McpManager.isWrite` already
  treats missing `readOnlyHint` as a write. Keep that. A server can still
  mis-label a write as read-only. That residual risk is not fixed by YOLO.
- Time-lease expiry during the few milliseconds after a successful
  `beforeDispatch` check is the same as revoke-after-dispatch: the provider
  may have the message. Reconciliation covers it.

## Migration and rollout

- Existing active YOLO grants remain valid. Missing `version` means 1.
- Existing `task.action` rows in `executing` or `uncertain` are reconciled,
  not re-authorized, and not resent.
- After this change, workspaces that auto-sent from calibration `allow`
  stop auto-sending until the user approves the draft or starts YOLO.
  Drafts stay prepared. No migration job sends them.
- Connector grants, artifact grants, and MCP `writeTools` remain stored.
  Model-queued calls that used them without YOLO start failing with
  `AUTHORIZATION_REQUIRED`. User-confirmed HTTP actions keep working.
- Ship the policy change, the intent cancel, and the `#runPreAuthorized`
  stop in one change. A revoke cancel without the policy change would leave
  the standing-grant hole. A policy change without the intent cancel would
  leave a race on undispatched rows.
- Update `docs/AUTONOMY.md` in the implementation change: YOLO still does
  not undo a dispatched call; standing calibration no longer sends by
  itself; revoke cancels undispatched intents. Leave this design document
  as the specification until then.

## Decisions to confirm before implementation

1. **Standing scope versus YOLO.** The proposal is strict. Connector grants,
   artifact grants, calibration `allow`, and MCP `writeTools` do not
   authorize a mutation. YOLO or a one-shot approval is also required, and
   the scope must still match. Alternative: treat each of those user-created
   records as an approval of its scope, which is closer to the current
   product and weaker than the invariant above. Confirm the strict reading
   before implementation, especially for MCP writes, which would then run
   only under YOLO or an explicit confirm.
2. **Grandfathering.** The proposal does not keep calibration auto-send for
   existing installs. Alternative: keep auto-send until the user edits that
   calibration. Strict is the paid-release default because a silent
   grandfather is hard to explain after a revoke.
3. **One-shot versus activation review.** The proposal keeps today's rule
   that a direct approval can proceed when activation `requiresReview` is
   set, and YOLO cannot. Alternative: `requiresReview` also blocks the
   one-shot path until a second control. That would change the meaning of
   Approve.
