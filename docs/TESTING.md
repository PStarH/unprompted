# Testing and evaluation

[← Documentation](README.md)

[Product direction](PRODUCT_DIRECTION.md) distinguishes reliable engineering
from evidence that a real user values an unrequested discovery.
The separate [participant-case tool](VALUE_VALIDATION.md#offline-participant-case-bookkeeping)
does not turn scripted results into real-user evidence.

Tests use Node's built-in `node:test` runner and synthetic fixtures. No external
account or model key is required. The basic workflow suite needs no package
installation; the full suite on Node.js 22.19+ includes Pi tests and requires
`npm ci --include=optional`. Pi-specific tests are skipped on Node.js 20.
Stop unnecessary local servers before running a large suite.

## Browser interaction contract

This opt-in check uses Playwright and Chromium on Node.js 22.19+. The browser
dependency is separate from the zero-dependency core test runner:

```sh
npm install --no-save --package-lock=false playwright@1.58.2
npx playwright install chromium
npm run test:browser
npm run test:first-run
npm run test:model-onboarding
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
checkout. CI runs both browser checks separately from the core dependency-free
suite.

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
error when Git metadata is unavailable.
GitHub CI has a lightweight Node 22 tooling job for Ubuntu, Windows, and macOS.
This working session has only been verified locally on macOS; results from the
new cross-platform matrix are pending execution by GitHub Actions.

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
used by these contracts; publishers still need actual registered-app acceptance.
