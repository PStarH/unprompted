# Testing and evaluation

[← Documentation](README.md)

[Product direction](PRODUCT_DIRECTION.md) distinguishes reliable engineering
from evidence that a real user values an unrequested discovery.
The separate [participant-case tool](VALUE_VALIDATION.md#offline-participant-case-bookkeeping)
does not turn scripted results into real-user evidence.

Tests use Node's built-in `node:test` runner and synthetic fixtures. No external
account or model key is required. Install dependencies with `npm ci --include=optional`
for the pinned SQLite runtime. The full suite on Node.js 22.19+ includes Pi tests;
Pi-specific tests are skipped on Node.js 20.
Stop unnecessary local servers before running a large suite.

## Connector, activation and harness integration

Run `npm run test:connectors` to include transport, authorization, native sources,
artifact execution and the cross-connector harness matrix. The focused matrix is
`node --test test/connector-harness.test.js`; it uses the actual connector classes,
sync runner, durable jobs, activation rules, Standard/Pi tool loops and execution
ledger with scripted provider responses. It requires no real account writes.

| Source | Context supplied to the harness | Full-chain coverage |
| --- | --- | --- |
| Gmail / Drive / Docs | Source mail and correlated document text | Standard and Pi, destination creation and readback |
| Outlook | Graph mail and correlated Notion evidence | Standard and Pi, destination creation and readback |
| Slack | User direct message and correlated Notion evidence | Standard and Pi, destination creation and readback |
| Notion | Selected page content linked to a mail task | Standard and Pi, destination creation and readback |
| Local files | Explicit to-do and selected file contents | Standard and Pi, destination creation and readback |
| Apple Notes | Explicit to-do and selected note contents | Standard and Pi, destination creation and readback |
| GitHub | Assigned issue, PR review, commit and Actions facts | All four kinds in Standard and Pi, destination creation and readback |

The matrix also checks provider suppression, cached tool revocation, automatic
write refusal under require-review policies, source withdrawal after suppression,
and new destination grants on already prepared tasks without replaying prior
writes. `test/artifact-actions.test.js` separately verifies Gmail/Outlook
drafts, Notion pages and Apple Notes creation, exact account/target binding,
dispatch-time revocation, unknown outcomes and independent readback. Other
connector tests cover pagination, OAuth, account changes and synchronization.
These are implementation checks; provider publication, real-account consent and
macOS Automation still need acceptance after configuring the registered clients.

## v0.3 failure injection

Run `npm run test:durable` for the 30 required scenarios in [the baseline](PRD.md),
plus real engine and HTTP integration. These tests use actual SQLite connections,
worker subprocesses and process crashes, a local HTTP service, deterministic clocks,
and fault injection. No unattended real-account writes are performed.

| Requirements | Executable coverage |
| --- | --- |
| Execution / concurrency 1–10 | `test/durable-execution.test.js`, `test/fixtures/durable-worker.mjs` |
| Learning / attribution 11–18 | `test/durable-learning.test.js` |
| Context / attention 19–24 | `test/durable-context.test.js` |
| Forget / retention 25–30 | `test/durable-privacy.test.js` |
| Engine, MCP, draft revisions, document patches, privacy races and migration | `test/durable-runtime.test.js` |
| Persistent HTTP setup, policy versions, deletion, offline tuning | `test/durable-api.test.js` |
| Bilingual memory/rule/Forget/quiet-hours controls | `npm run test:durable-ui` |

Passing these checks is a local implementation claim, not evidence of provider
availability, user satisfaction or acceptance on every filesystem/browser.

## Browser interaction contract

This opt-in check uses Playwright and Chromium on Node.js 22.19+. The browser
dependency is separate from the Node test runner:

```sh
npm install --no-save --package-lock=false playwright@1.58.2
npx playwright install chromium
npm run test:browser
npm run test:first-run
npm run test:model-onboarding
npm run test:workspace
npm run test:mcp
npm run test:durable-ui
```

The command starts and stops an isolated local simulation with fresh temporary
setup and state, and removes that data afterward. It does not inherit account
configuration. Live updates are scripted in the browser. Send requests receive a scripted
network interruption or review-conflict response before reaching the server.
No real mail is sent.
The unit/API suite separately verifies review-token refusal and valid delivery.

The browser checks cover input, selection and focus during updates, Chinese IME
composition, stable task positions, detail return, navigation, review-token
submission, uncertain-send recovery, file picks, version-bound patch consent
and evidence-panel focus. Four widths, two languages and four views also check
page overflow. Results and screenshots go to `outputs/human-ux-validation/`.
These checks do not measure real-user comprehension or task success.

`test:workspace` exercises the five representations of the same live task:
Field, Index, Lanes, Spotlight and Pulse. It checks draft and selection retention,
persisted pause/resume, requirement changes and undo, explicit scoped memory with
edit/delete/restore, remembered view and appearance choices, keyboard controls,
Chinese IME and caret retention, and mobile navigation visibility. Its screenshots
also cover task source/memory dialogs, focus return, and independent Memory,
Connections and Settings routes. The task screenshots
include controlled concurrent-task fixtures, not real-user work. Results go to
`outputs/workspace-validation/`.

`test:mcp` connects the actual browser to local MCP HTTP and stdio fixtures. It
checks URL/token and JSON setup, secret clearing, per-tool grants, disable/enable,
reload, removal, cross-origin rejection and Chinese/English mobile appearance.
Results go to `outputs/mcp-validation/`. The Node suite additionally verifies
real Standard and Pi model/tool loops, task audit, native follow-up investigation,
revocation, timeouts, process restart and private-file permissions. These are
controlled protocol fixtures, not acceptance claims for third-party servers.

`test:first-run` exercises the actual 15-second demo in fresh English and
Chinese browser contexts, plus the desktop simulation and its persistent setup
screen. It uses the real SSE stream, event engine, approval
endpoint and simulated receipt lookup without stubbing them. It verifies no
task prompt or unsolicited send is required, the ready → reviewed → verified
path works, reload does not resend, replay starts cleanly, decline sends nothing,
and the disposable demo explains how to start persistent account setup. Four
widths are checked; the browser makes no external requests. Screenshots and an
aggregate report go to `outputs/first-run-validation/`.
It also interrupts the initial API connection and verifies a localized retry
recovers into the real story without a page refresh.

`UNPROMPTED_FIRST_RUN_ROOT` can point this check at an exported source snapshot
without `node_modules` to verify the release contents rather than the development
checkout. Install its locked dependencies before testing a persistent workspace.
CI runs browser checks separately from the Node behavioral suite.

`UNPROMPTED_PLAYWRIGHT_MODULE` can name an existing Playwright module, and
`UNPROMPTED_BROWSER_CHANNEL` can select an installed browser channel. An explicit
`UNPROMPTED_BROWSER_BASE_URL` uses an already running **isolated simulation**
instead of starting a server. Never point this fixture runner at a personal workspace.

See [the interaction contract](ARCHITECTURE.md#interface) for the design decisions
and the separate human usability acceptance goals.

## A short first check

`npm run test:connections`, `npm run test:model-onboarding` and `npm run test:google-onboarding` run the
following browser contracts. The model onboarding browser check uses a scripted **local HTTP provider**. It
covers no-model startup, rejected credentials, structured inference, private
key storage, immediate activation, waiting for real context, reload and
disconnection. The Google onboarding check runs the actual OAuth callback,
account switch and connector/engine paths against scripted local HTTP responses.
It verifies first-read evidence, grounded model interpretation, failure recovery,
incremental permissions and pause/reconnect without restarting. It also checks the
form at three widths in English and Chinese. This is protocol and integration
coverage; it does not establish success with an external real model. Real
provider acceptance must use the user's selected model and key.

```sh
npm run test:workflow
npm run check:syntax
```

The workflow suite checks discovery, reassessment, missing evidence, freshness,
approval, verification and recovery. The syntax command is the same local and CI
entry point. Run one relevant file or filter test names while iterating:

```sh
npm test -- --file=test/discovery-precision.test.js
npm test -- --test-name-pattern="deadline"
npm run test:fast -- --test-name-pattern="request"
```

The Node runner selects top-level `test/*.test.js` files in stable filename
order and runs them serially. `--file` may be repeated to select multiple files;
paths are passed as process arguments, so spaces in filenames work on Windows,
macOS, and Linux. Node's `--test-*` options are forwarded. `test:fast` excludes
`api.test.js`, `framework-eval.test.js`, and `generalization.test.js`.
The syntax check uses Git's NUL-delimited list of tracked and unignored files,
skips symlinks, and must be run from a Git working tree; it reports an explicit
error when Git metadata is unavailable. GitHub Actions also runs the tooling
check on Ubuntu, Windows, and macOS; check the latest workflow run for its
current result.

## Full checks

```sh
npm test
npm run eval
npm run eval:framework
npm run eval:resilience
npm run eval:lifecycle
npm run eval:pi # optional Pi packages and Node.js 22.19+ required
npm run eval:value
npm run check:public
npm run check:syntax
```

To install the optional Pi packages from the lockfile before the Pi tests and
evaluation, run `npm ci --include=optional`. Node.js 20 skips Pi-specific tests;
CI installs optional packages and runs the Pi contract evaluation on Node.js 22.

| Command | What it checks |
| --- | --- |
| `npm test` | Behavioral, HTTP, connector, permission, storage, UI, and launcher tests, including Pi tests when available |
| `npm run eval` | Synthetic scenarios against expected discovery, evidence and action outcomes |
| `npm run eval:framework` | Framework correctness, false completions, invalid actions, cost and attention coverage |
| `npm run eval:resilience` | Bounded model-call bursts, plan recovery, context relevance, nested async completion and retained work |
| `npm run eval:pi` | All 27 task contracts through Pi Agent Core with scripted model responses; integration, not model quality |
| `npm run eval:value` | Outcome-derived product metrics; not a real-world value claim |
| `npm run check:public` | Candidate public paths, Markdown links/anchors, internal-document markers and common credential signatures |
| `npm run check:syntax` | Local JavaScript syntax validation for the same working files checked in CI |

The full suite can take several minutes. It runs with file-level concurrency
set to one because HTTP servers and scenario runs can otherwise starve each
other. A passing evaluation is evidence about its fixtures and invariants, not
proof of production reliability, time savings, or an overall false-positive rate.

## Where to add a test

| Change | Start here |
| --- | --- |
| Request detection or noise filtering | `test/discovery-precision.test.js`, `test/match-guard.test.js` |
| Document correlation or end-to-end follow-through | `test/workflow.test.js` |
| Evidence and freshness | `test/evidence.test.js`, `test/contradiction.test.js` |
| Probe planning / optional model | `test/probes.test.js`, `test/reasoning.test.js` |
| Competing sources | `test/verification.test.js` |
| Meaningful task progress and closed-work suggestion isolation | `test/proactive-management.test.js`, `test/stall.test.js`, `test/opportunities.test.js` |
| Commitment revisions, multilingual discovery and bounded recovery | `test/commitment-lifecycle.test.js`, `test/repair-integration.test.js` |
| Document patches, waits, scoped correction and shared decisions | `test/task-services.test.js`, `test/repair-integration.test.js` |
| Private account setup and non-overlapping continuous observation | `test/setup.test.js`, `test/monitoring.test.js`, `test/api.test.js` |
| Permissions / pre-authorization | `test/permissions.test.js`, `test/calibration.test.js`, `test/refusals.test.js` |
| HTTP boundary | `test/api.test.js`, `test/shadow.test.js` |
| Connector behavior | `test/connectors.test.js`, `test/sync.test.js` |
| Restart / locking | `test/store-lock.test.js`, `test/workflow.test.js` |
| Notifications / deadlines / stalls | `test/notifications.test.js`, `test/deadlines.test.js`, `test/stall.test.js` |
| Demo onboarding | `test/demo.test.js` |
| Rendered interface | `test/ui-render.test.js` |

## Add a scenario

Read `eval/scenarios.js` and use an existing scenario as a structural example.
Choose a distinct entity and deliverable, define synthetic incoming events, and
state the expected outcome. Include what must **not** happen: an unrelated
change should create no work; missing evidence should produce no false
completion; a prepared action should not send before authorization.

Run the generalization evaluation and the affected test file. New behavior
should have a meaningful regression test; a documentation correction does not
need an implementation-shaped test.

## Public file checks

`npm run check:public` includes tracked working files and non-ignored new files.
It fails if a linked document is missing, a heading anchor is broken, or known
private paths or credential patterns enter that candidate. It does not print
matched secret values. It is a lightweight pattern check, not a guarantee that
all possible sensitive content is absent, and it does not remove old Git objects.

CI installs from the lockfile, then uses these same local commands for public
file checks, syntax, behavioral tests, and evaluations. Security analysis is
configured separately in CodeQL.

## Connector checks

`test/device-oauth.test.js` covers polling, slow-down, expiration, cancellation,
identity checks and guarded refresh rotation. `test/connectors-multi.test.js`
covers native issue lifecycle, pagination, account-namespaced Outlook delta
reads and delivery isolation. `test/connections-api.test.js` runs the actual
server against scripted local provider HTTP responses. `npm run test:connections`
exercises the browser's provider selection, code copy, authorization, native work,
pause, source disconnect and bilingual responsive layouts. No real account is
used by these contracts. Apple Notes uses injected responses, so a real Notes
account and the signed app's macOS Automation prompt still need manual
acceptance. Publishers also need to accept their registered cloud apps with
real accounts.

Run `npm run test:connectors` for connector and account integration checks.
`test/google-durable-workflow.test.js` drives the actual Google mail and Docs
adapters through SQLite, the dispatch gateway, version-checked patching and
readback; the HTTP provider is controlled and simulates an accepted send whose
response is lost. `test/connector-search-api.test.js` checks account and scope
handling for user search, and `npm run test:google-search` checks search,
pagination, language and mobile layout using scripted Google responses. The
connector suite also checks Gmail `messagesAdded`, malformed baselines, Drive
listing continuation, incomplete search and body timeouts. These fixtures do not
establish compatibility with a real account or provider-side push delivery.

## Tool safety and orchestration regression

Run `npm run test:integration` for the complete connector-to-feedback path.
It uses the actual SQLite-backed runtime, a controlled HTTP provider and child
processes. A connector sync creates a Situation and task; the actual model
harness receives grounded memory and runs a task-owned read tool. It prepares a
supervised candidate, and sends only after explicit review.
The test replays the connector events and interrupts the process after the remote
accepts the send, while feedback is being written, and after feedback commits.
It also makes the provider temporarily unable to confirm the result. Recovery
must perform no second send and must retain exactly one correctly linked result,
supervised-success record and verified-consumption record. Test lease deadlines
are advanced rather than waiting for the production lease to expire.

The model and mail endpoints are scripted local HTTP services. Real accounts and
external model integrations need separate acceptance against their providers.

Run `npm run test:safety` for dispatch-time grant revocation, exact parameter and
provider scope, wrong receipts, accepted-but-unverified writes, interrupted
pre-dispatch jobs, worker recovery reentry, sent-mail identity, MCP schema/grants
and metadata redaction, and Pi read-tool ownership. Authorization/state-machine
cases use an injected in-memory SQLite workspace; the existing durable execution
tests still use real files, subprocess claims and crash-after-send fault injection.
The suite also checks final-boundary pause/read-only enforcement for JSON document
compatibility. No external account credentials are required.

Use a local disk for test fixtures. On macOS, if `TMPDIR` points to a slow mounted
volume, `TMPDIR=/private/tmp npm test` keeps fixture files on the local temporary
filesystem. A sampled failure on a mounted temporary volume blocked the Node
main thread in SQLite WAL `pwrite`, causing HTTP and browser timeouts. Keep
`synchronous=FULL`; do not weaken durability to make that run pass.
