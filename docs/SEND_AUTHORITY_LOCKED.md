# Locked design: send read-back + Authority enforcement

Status: **LOCKED for implementation.** This document supersedes open decisions in
`docs/SEND_VERIFICATION.md` and `docs/AUTHORITY_ENFORCEMENT.md` and incorporates
must-fix items from `docs/reviews/SEND_AUTHORITY_SPEC_REVIEW.md`.

Owner of this lock: product coordinator (not a Cursor cloud design agent).
Implementers must follow this document when it conflicts with the earlier drafts.

## Human decisions (locked)

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Inconclusive reconcile / attestation | Allow user to **attest Sent-absent**. That closes the old attempt without sending. Next send uses a **new attempt key** and requires a **fresh one-shot approval**. YOLO must **not** auto-send the replacement. |
| 2 | Unverifiable platform / MCP writes | **Ledger only, no Needs you card.** Record `accepted` / `verified: false` (or equivalent). Do **not** complete the task as verified. Do **not** raise a workspace blocker for omission alone. |
| 3 | Standing user authorizations | **Count as approval credentials** at the gate when they cover the effect: connector path grants, artifact destination grants, MCP `writeTools` membership, and calibration `allow`. Still require the effect to be in scope. Model-supplied `permission` / `grantId` / `approved` strings are **never** credentials. |
| 4 | Calibration auto-send grandfathering | **No grandfathering.** Existing installs stop silent `#runPreAuthorized` sends. Calibration `allow` may authorize through the gate as a standing authorization (decision 3) only when the effect is evaluated at `AuthorityGate.decide` — it must not bypass the choke point, and copy in UI that claims "Later replies send automatically…" must be updated to match. |
| 5 | `requiresReview` | **Unchanged:** blocks YOLO; does **not** block direct one-shot approval. |

## Non-negotiable goals

1. Outbound success ≠ model prose, tool `accepted`, or raw provider send response.
2. Live Gmail success = independent read-back predicate (SENT + Message-ID from idempotency key + single hit).
3. Ambiguous / timeout → `unknown` + **bounded** reconcile; explainable codes; **no second POST** for a key that reached `dispatched`.
4. Authority: every `execute_external` goes through one unforgeable gate; revoke cancels undispatched intents; model cannot self-grant.
5. Attention: no chat spam; mail Needs-you only for mail/reconcile; unverifiable MCP/platform stays quiet in the ledger.

---

## A. Send read-back (locked deltas)

Base: keep choke points in `WorkEngine`, `ToolExecutionLedger`, `GoogleMailAdapter` /
`GoogleWorkspaceConnector`, `DurableRuntime`. Do not invent a second outbox.

### A1. `verified` is terminal

- Once `tool_executions.status = verified`, the row is **immutable** for status
  demotion. No reconcile, search miss, or attestation may move it to
  `unknown` / `failed` / `confirmed_absent`.
- `DurableRuntime.verifiedAction` / `ToolExecutionLedger.verified` must **not**
  be a caller-supplied receipt stamp that promotes `accepted` → `verified`
  without the predicate already having returned `found` on that execution.
  Promotion to `verified` happens only inside the ledger when the trusted
  `verify` callback returns `found` and `validReceipt` matches **this** key.
- `normalizeLookup` and `WorkEngine.reconcile` must treat a stored `verified`
  row (and its `evidence_json`) as `found` even if a fresh Sent search misses
  (index lag). Never mint a replacement key for a draft whose prior attempt
  is already `verified`; instead `confirm` that prior execution and complete.
- Confirming a prior attempt targets **that** execution id / key. Do not stamp
  a new key onto an old receipt.

### A2. Attestation → replacement send

Terminal attestation status (must leave unresolved claim list):

- Set ledger to `failed` with `last_error_class = user_attested_absent`
  (not `confirmed_absent`, not `confirmed_no_effect`).
- Release the resource claim after that status write.
- Append to `actionHistory`; clear current `task.action`; draft →
  `ready_for_approval` with `USER_ATTESTED_ABSENT` reason.
- `ToolExecutionLedger.intent` must **refuse** to reopen a key that ever had
  `dispatched_at` set, even if status is `cancelled` with
  `confirmed_no_effect`. Reuse only when never dispatched
  (`dispatched_at` null and `cancelled` / `confirmed_no_effect`).
- Pre-send check of **all prior keys** for this task+draft digest runs
  **before** `intent` acquires the claim. If any prior key is `verified` or
  fresh predicate `found`, complete that attempt; do not POST.
- New key uses `action.sendAttempt` integer `n` (authority), suffix `:a{n}`
  is display only. YOLO / `Autonomy.runReady` must refuse drafts whose last
  live attempt ended in `user_attested_absent`.

### A3. One bounded reconcile owner

- Live durable ambiguous path today recovers via `external_dispatch` →
  `DurableJobs.fail` → `DurableRuntime.recover` → `deferRecovery` (**uncapped**).
  Cap that loop (e.g. max 4 recoveries / same attempt budget as
  `reconcile_execution`). After budget: stop deferring; set
  `reconciliation_inconclusive`; leave one mail Needs-you; **zero** extra POSTs.
- Do not stack an unbounded second job family without retiring the first.
- After `dispatched_at` is set, `definitiveNoEffect` (including platform HTTP
  **429**) must **not** become `cancelled` / `confirmed_no_effect` for
  `provider.live === true`. Stay `unknown` and reconcile. List Gmail codes
  that may mean "no message created" only when `dispatched_at` is set and the
  adapter documents them; otherwise unknown.
- Gmail send POST remains single-shot (`retry: false`). Hung fetch → one POST.

### A4. Model cannot supply verification

- `ConnectorActions.verification` as a **model tool argument** must not move a
  row to `verified`. Ignore model-authored verification specs for ledger
  promotion, or keep those writes forever `accepted` / `verified: false`.
- Delete 404-as-`found` promotion for verification lookups.
- Fixed per-family predicates (Gmail Message-ID, document patch independent
  `provider.read` + digest) are the only auto-`verified` paths in this change.
- Unverifiable writes (decision 2): ledger records unverified; **no** Needs-you
  solely for missing verification spec; task not completed as verified.

### A5. Other send rules (from draft, still in force)

- Live send without durable ledger → `LEDGER_REQUIRED`, no POST.
- Direct and search Gmail paths share one Message-ID predicate; search miss
  after dispatch is `unknown`, never absence for live Gmail.
- Adapter must not stamp `idempotencyKey` onto a `format=minimal` read and
  treat that stamp as evidence; direct read uses metadata + real header compare.
- Preserve `legacyMessageId` behavior as `unknown` (no retry authorization).
- Separate timeout budget for verify vs send when both share one race.
- Hide or disable Retry UI for live mail when `RETRY_NOT_SAFE`.
- Schema: bump `SQLITE_RUNTIME.schemaVersion` (7 → 8); add
  `evidence_json` and `authority_json` via migrator `table_info` + `ALTER`
  (same pattern as situation columns). Fresh `schema.sql` includes columns;
  migrator must not double-ALTER.

---

## B. Authority enforcement (locked deltas)

### B1. Unforgeable gate

- `AuthorityGate.decide` (on `ToolSafetyGateway`) is the **only** function that
  may return allow for `execute_external`.
- `PermissionPolicy.authorize` performs shadow + action-class checks and allows
  a write **only** when `decide` attached a credential loaded from persistence
  that other modules **cannot construct** (e.g. opaque handle / sealed object
  from the gate, not a boolean or permission string on a plain object).
- Mandatory rewires that today call `policy.authorize` with forgeable objects:
  `WorkEngine.approve`, `WorkEngine.#executeAction`,
  `WorkEngine.executePreAuthorized` / `#runPreAuthorized`,
  `ArtifactActions.undo`, `ConnectorActions.authorize` synthetic
  `pre_authorized` path. All go through `decide`.
- Tool args `permission`, `grantId`, `approved` ignored.

### B2. Credentials that allow (decision 3)

Loaded from storage only:

| Kind | Source | Notes |
| --- | --- | --- |
| One-shot approval | User HTTP approve / explicit user-confirmed artifact or connector request | Bound to effect digest, task, versions, review token. Spent at `beforeDispatch`. |
| YOLO grant | `Autonomy` lease, `source=user`, valid | Re-checked at intent and `beforeDispatch`. |
| Standing user authorization | Connector grant / artifact grant / MCP `writeTools` / calibration `allow` | Must **cover** the effect. Counts as approval for that scoped effect. Does **not** expand beyond scope. Calibration `never` / `ask_each_time` still deny auto paths; one-shot may still send (decision 5 / existing activation exception). |

Shadow still denies all external writes.

### B3. `#runPreAuthorized` / YOLO coupling

- Silent send that bypassed the gate via calibration alone is removed.
- If calibration `allow` is used, it must still pass `AuthorityGate.decide` as a
  standing authorization credential (B2), with effect digest checks.
- YOLO time lease that allows MCP/platform also continues to drive
  `Autonomy.runReady` mail/patches — document this coupling; do not pretend
  MCP-only YOLO exists without mail side effects unless product adds a
  narrower lease later (out of scope).

### B4. Revoke

- On revoke / expire / replace lease / connector or artifact revoke / MCP
  writeTools removal / pause: cancel `tool_executions` in `intent` with
  `dispatched_at` null whose `authority_json` references that credential;
  release claims; set `SEND_DENIED` / return draft to ready when appropriate.
- YOLO cancel SQL runs **inside** the same `store.mutate` / `atomic` callback
  as the grant status write (cannot nest a second mutate).
- MCP config writes are not in that SQLite transaction: after config write,
  best-effort cancel intents; race control remains `mcpChecks` closure.
- Do not cancel `dispatched` / `accepted` / `unknown` / `verified`.
- Startup: leftover `intent` rows with null `authority_json` must be cancelled
  or blocked — never dispatched.

### B5. Intent requires `authority_json`

- `ToolExecutionLedger.intent` refuses writes without `authority_json` from
  `decide`. Version must match at `beforeDispatch`.

---

## Test matrix (minimum)

Send: verified terminal; no demote; no second POST after dispatch; hung fetch
one POST; capped reconcile; attestation releases claim and blocks YOLO
replacement; prior verified completes new attempt without POST; model
verification cannot verify; 404 verification not found; live without ledger
refused; schema v8 columns on existing DB.

Authority: forgeable permission string denied; standing grants allow in-scope
only; out-of-scope denied; revoke cancels intent inside same transaction;
revoke after dispatch does not unsend; MCP writeTools removal best-effort
cancel; shadow deny; requiresReview blocks YOLO not one-shot; UI copy for
calibration auto-send updated.

---

## Out of scope this change

Recipient-side delivery proof; recalling verified sends; multi-user auth;
Needs-you for every unverifiable MCP write (explicitly declined); inventing
MCP-only YOLO mode.
