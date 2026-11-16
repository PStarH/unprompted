# Synthetic soak testing

[← Documentation](README.md)

The soak runner measures the durable runtime under repetition. One SQLite
workspace stays open across many cycles, the runner injects the failures that
the recovery paths exist for, and the report records what the engine actually
did. Providers, connectors and the reasoner are synthetic fixtures in the same
process: nothing is sent, no account is contacted and no model is called.

It is a measurement, not a target and not a value claim. It does not prove that
a real account works, that a real provider accepts a message, or that a real
user values the work. Those need a separate acceptance run.

## Run it

```sh
npm run eval:soak                                  # 30 second smoke
npm run eval:soak -- --duration-ms=60000           # one minute
npm run eval:soak -- --duration-ms=3600000 --max-cycles=10000 \
  --output=outputs/soak/hour.json                  # one hour
npm run eval:soak -- --seed=7                      # replay a fault plan
```

Node.js 22 is the verified runtime; the pinned SQLite module must match the
Node ABI. Keep the workspace on the internal disk, for example
`TMPDIR=/private/tmp/unprompted-tmp`, because each SQLite commit is synchronous.

| Option | Range | Default |
| --- | --- | --- |
| `--duration-ms` | 1000–86400000 | 30000 |
| `--max-cycles` | 1–10000 | 1000 |
| `--seed` | any integer | 20261112 |
| `--output` | path | `outputs/soak/report.json` |
| `--help` | — | — |

The duration budget is checked between cycles, so a cycle is never cut in
half by the budget. Instead every cycle is capped at 60 s, cleanup after the
run is capped at 5 s, and the whole run is bounded by
`durationMs + 60 s + 5 s`. One slow cycle cannot stretch that bound.

SIGINT or SIGTERM wakes the wait that is currently running, stops scheduling
new cycles, releases the in-process fixture hangs, closes the runner's own
runtime and database inside the cleanup budget, writes the report with
`interrupted: true` and a failed verdict, and exits non-zero. Other processes are
not touched. The library never calls `process.exit`; only the CLI sets its own
final exit code.

Pending jobs are sampled at cycle and settle boundaries; `maxPendingJobs`
records the observed peak at those boundaries. 512 is the admission/abort guard
applied there. A transient in-cycle enqueue between samples can exceed the
guard without being observed, so the metric is not an instantaneous peak and
the runner cannot claim the queue was never above the limit at every moment.
The guard is not a drain criterion; see `final-queue-drained` below.

## What one cycle does

The first eight cycles are pinned to the full matrix so a run that lasts long
enough always reaches every scenario; later cycles repeat the matrix in a
seeded order.

| Cycle | Injected behaviour | What must hold |
| --- | --- | --- |
| Normal | One source event and one correlated document | Prepared, explicitly approved by the fixture user, executed, verified against the provider receipt and completed — four separate checks |
| Duplicate delivery | The same provider event delivered repeatedly | The task keeps exactly one external effect and its receipt-backed verified result |
| Burst | Three distinct items plus repeats of two of them | Each of the three distinct items is verified individually; repeats create no new effects |
| Network timeout | The provider times out before confirming acceptance | The task is blocked with a recorded reason, not treated as "no work"; it is reconciled, only a confirmed absence is retried, and the retry adds no duplicate |
| Rate limit | The provider answers 429 before accepting | Same as above, with the rate-limit error on the record |
| OAuth expiry | The source rejects a pull with 401 | A healthy failure with an actionable `reauthorize` next step and no ingested event; a revoked permission is not pulled at all; the fixture user re-authorises explicitly and the next pull continues from the persisted cursor |
| Restart with unfinished work | The provider accepts and never answers, then the workspace is abandoned with the write dispatched | The same database reopens, the interrupted write is recovered, no second copy is sent and no durable fact is lost |
| Write outcome unknown | The provider accepts and the response is lost | Reconciled through the provider, verified only through that lookup, never resent, never counted as complete before verification |

Approval is always the fixture user's explicit decision. The model and the
engine never approve, retry or re-authorise on their own.

The OAuth scenario uses one append-only synthetic event log for the whole
workspace. The connector's cursor is persisted in the store and moves forward as
events are ingested, so a run can interleave OAuth failures, a workspace reopen
and later OAuth cycles without restarting the log or rewinding the cursor.

## The crash is synthetic

The restart cycle is an in-process simulation, not an OS process kill: the
runtime is frozen and the SQLite file is closed underneath a write that has
already been dispatched. The only state that survives is the database and the
synthetic remote's receipt file. Because that file persists beside the
workspace, the recovery still has a real remote record to verify.

A real process would also have to wait out the interrupted job's lease. The
runner moves that lease into the past, exactly as the shipped recovery fixtures
do. The report declares this under `restarts.simulated.leaseExpiries` and does
not present the resulting delay as production recovery latency.

The crash branch also waits for the abandoned approval to settle. That wait is
raced against the same step and cycle deadline as every other wait, so an
approval that never settles is rejected by the bound and the run fails; it is
not left as an unbounded microtask await. SIGINT wakes it the same way.

## Reading the report

| Section | Meaning |
| --- | --- |
| `events` | Source events attempted, accepted and deduplicated |
| `tasks` | Per-task audit: `byStatus`, `completed`, `verified`, `completedWithoutVerifiedAction`, `awaitingUser.oauthRecovery` |
| `verification` | The receipt-backed audit behind the verdict (the action, durable execution and remote receipt must name the same non-empty ids), plus unresolved write executions |
| `provider` | `sendAttempts`, `accepted`, `failedBeforeAccept`, `acceptedResponseLost`, `duplicateAfterAccept`, `effects`, `keysObserved`, `keysWithMoreThanOneEffect`, per-scenario sends |
| `faults` | `planned`, `attempted`, `injected` and `observed`, counted separately |
| `scenarios` | Per-scenario tasks, reconciliations and retries; `tasks.prepared` is observed immediately before approval, never inferred from the final status |
| `recoveries` | Faults injected versus recoveries actually observed, plus `consistent` |
| `restarts` | Crashes, unfinished work observed, recovered writes, lost facts, simulated lease expiries |
| `normal`, `duplicate`, `burst`, `timeout`, `rateLimit`, `unknownWrite`, `oauth` | The per-scenario facts those checks read; `oauth.cursorOffsets` is the cursor history |
| `identities` | Unique generated entities, their correlation to their own documents, capacity and collision bound |
| `drain`, `pendingJobsAtEnd` | Whether the bounded final recovery phase ran (`attempted`), whether it passed (`passed`), the final audited queue count and `queueEmptyAtEnd` |
| `cleanup` | Whether closing the runtime fit inside the 5 s budget |
| `latency` | Approval and cycle latency, min/mean/p50/p95/max |
| `notifications` | Interactive, digest, informational and critical counts |
| `model`, `tokenUsage` | Synthetic model calls and token totals, or `unknown` |
| `memory` | Resident memory at baseline, peak and end |
| `coverage`, `checks`, `success` | Which scenarios were observed, every check's result and the verdict |

### Attempts are not effects

The synthetic remote is natively idempotent: a repeated idempotency key returns
the receipt that already exists. That is a property of the fixture and proves
nothing about the engine by itself. So the report separates the two facts:

- `provider.sendAttempts` counts every entry into `send`, including calls that
  fail before acceptance and calls that repeat an accepted key.
- `provider.effects` counts receipts the remote holds.
- `provider.duplicateAfterAccept` counts attempts for a key the remote had
  already accepted. It is observed at the send entrance, before any injected
  timeout/429/401 branch can throw and reclassify the attempt as a harmless
  failure. The `no-blind-resend` check fails when it is non-zero, even though
  the effect count would still look clean.
- `provider.keysWithMoreThanOneEffect` is computed from the remote's own
  accepted-effect records, one per key, not written as a literal. `effects` is
  the number of those records and `keysObserved` the number of distinct keys.

A timeout or 429 that failed before acceptance is not a blind resend. The
runner may reconcile it, prove the write absent and retry once; that is a
legitimate retry and the scenario checks require it to recover without a
duplicate. A send for an already-accepted key has no such proof and is counted
against the gate. Detecting that resend is a read of the remote receipt map, not
an extra accept call, so it never creates a second effect.

### Injections and recoveries are counted apart

`faults.injected` counts a fixture fault that actually fired; `faults.observed`
counts a scenario whose required action and outcome were both seen.
`recoveries.injected` and `recoveries.recovered` are counted separately, and
the aggregate recovered numbers equal the per-scenario facts the checks read
(`timeout.recovered`, `rateLimit.recovered`, `restarts.recovered`,
`unknownWrite.recovered`). A recovery without an injection is therefore
visible, and `recoveries-do-not-exceed-injections` fails it.

### `unknown` is not zero

The synthetic reasoner reports usage only when it has numbers. If a call
reports nothing, `tokenUsage.known` stays `null`, `unknown` is `true` and
`unknownCalls` counts those calls. The report never writes a zero-token success
for an unreported call, and the soak never treats an unknown write outcome as a
verified completion: such a task stays open until the provider lookup finds the
receipt.

### Coverage comes from the trigger

`coverage.required` lists the eight scenarios. `covered` and `uncovered` are
computed from `faults.observed`, which only increments after the required action
and its outcome were actually observed — for example the OAuth 401 is counted
in the connector branch where it fired, not when the scenario was planned. A
planned but skipped injection stays uncovered. `complete` is false when any
scenario is missing, the corresponding check fails, and the run cannot be a
success.

### The final queue must reach zero

After the last cycle the runner performs a bounded final recovery phase: a real
drain of the real runtime, up to 45 s, inside the overall wall bound. Queued,
retry-waiting, running and recovery-required jobs must all reach zero, and the
report records the final audited count. The runner never marks a job complete,
deletes a job record or weakens the runtime to get there. If the queue cannot
reach zero inside the bound, `final-queue-drained` fails and the run is not a
success.

The report separates three facts: `drain.attempted` says whether the phase ran,
`drain.pendingAtEnd` is the refreshed count from the final audit (not a stale
pre-audit sample), and `drain.passed` is true only when the phase ran and ended
at zero. When an interrupt or an earlier failure skips the phase,
`drain.attempted` and `drain.passed` are false and `final-queue-drained` fails
with a detail that says the phase was not attempted; `drain.queueEmptyAtEnd`
may still be true if the audited queue happened to be empty. An empty queue is
never presented as a completed drain.

### Entities do not collide

Each work item gets an entity label of the form `Zx` + a four-letter base-26
ordinal + ` Ledger` (for example `ZxAaaa Ledger`). The shipped matcher keeps the
capitalised run before the deliverable noun, so these labels stay
matcher-readable. The encoding is injective for ordinals `0..456975`. The bound
is stated over generated work items, not cycles: a burst cycle creates three
items, so the largest supported plan can generate 30,000 items (10,000 cycles
times three), well below the label capacity. The `identities` section reports
the capacity, the plan's item bound and the number actually generated, and the
`entity-identities-are-unique` and `work-correlates-to-its-own-document` checks
read the actual tasks. An ordinal outside the range fails with
`SOAK_IDENTITY_RANGE` instead of wrapping or silently reusing a label.

### No private data in a report

Success, failure and negative-control reports contain no message bodies,
addresses, raw idempotency keys or task/source ids. Duplicates appear as
counts, and identity evidence carries only the generated ordinal and label. The
last check scans the serialised report for real private shapes and for the exact
content generated during the run; a leak fails the run. The failure path is
covered too: a cycle that throws an error containing an address, subject or body
still writes a scrubbed report.

### The caller's directory is not ours

With no `workspaceDirectory`, the runner creates its own temporary directory and
removes it at the end unless `keepWorkspace` is set. A caller-supplied directory
is never recursively deleted. An empty one is used and left in place; a non-empty
one is refused before anything is written, with `WORKSPACE_NOT_EMPTY`, so
existing user data is never treated as a test fixture.

### Test-only negative controls

The library accepts a small validated `testHooks` object so the regression suite
can prove the gates catch real defects: breaking normal preparation, forging a
completed task without verification or with matching undefined proof keys,
re-sending an accepted key (with and without an active provider fault), hanging
the crash-branch approval so the step deadline must reject it, skipping an
injected fault, suppressing usage and throwing a private error. Each hook drives
the same report acceptance non-green, or in the crash-approval case the bounded
timeout failure. The hooks are not exposed on the command line and are not
reachable from a model turn.

### Exit codes

`0` only when every named check passed, the matrix was observed, the final queue
is empty, no accepted key was sent again, every completed task carries a
receipt-backed verified action, and the run was not interrupted. `1` for a
failed run, an uncovered matrix, an undrained queue or an interrupt. `2` for
invalid arguments.

## What it measures, and what it cannot

Measured runs on this machine with Node 22 and `TMPDIR=/private/tmp`, all
against the source in this repository:

| Run | Result |
| --- | --- |
| 8 cycles, explicit 120 s budget | exit 0, 11.2 s, 38/38 checks, pending 0 |
| default 30 s | exit 0, 16 cycles, 31.0 s, 38/38 checks, pending 0 |
| explicit 60 s | exit 0, 32 cycles, 62.6 s, 38/38 checks, pending 0 |
| explicit 32 cycles, 600 s budget | exit 0, 32 cycles, 94.3 s, 38/38 checks, pending 0 |
| test suite (includes one 32-cycle continuous run) | 16/16 tests, 59.4 s total |

Those are measurements, not guarantees. The first four rows were measured on an
earlier revision of this runner; the latest metrics/reporting fixes do not
change the scenario matrix or the 38-check set, and the test-suite row is from
the current revision. The cycle count a budget reaches varies with host load:
two default-budget runs of the same source finished 16 cycles and 29 cycles in
31 s, and the same 32-cycle plan took 32 s in one run and 94 s in another. The 30-second default is a smoke: a short run may reach only
part of the matrix, and when it does the run reports the uncovered scenarios
and exits non-zero instead of pretending to be complete. Extending the budget
later does not retroactively prove that an earlier short run passed; each
report is only about the cycles it actually ran.

The soak does not prove that a real account, provider or model works, does not
measure provider latency or cost, and does not exercise multi-process
contention, network partitions, real rate-limit headers or an OS-level process
kill. The crash is an in-process abandon and the lease expiry is simulated. Its
token numbers are synthetic. It is evidence about repetition, recovery,
verification and duplicate attempts in one process, and nothing wider.

## Tests

`node --test test/soak.test.js` runs the real runner, including one continuous
32-cycle run. Its wall time varies with the machine and with where the
temporary workspace lives: every SQLite commit is synchronous, so an external
or slow disk can multiply the duration. Read the duration that `node --test`
reports for your run rather than assuming a fixed time; keep `TMPDIR` on the
internal disk. The suite covers the report schema and that an incomplete run
cannot be green, the seed-reproducible plan, the full normal chain, duplicate
delivery, a crash with a write in flight, a never-settling crash approval
rejected by the step deadline, controlled interrupts inside a cycle and between
cycles, a real child process that receives SIGINT, every negative control, the
receipt proof ids, the remote's accepted-effect records, the privacy detector,
caller-directory ownership, and the one continuous run across the 24-item
boundary with a drained queue.
