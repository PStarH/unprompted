---
title: Contributing
description: How to report a gap and send a change, from a doc fix to a connector, including the checks and the guarantees to keep.
---

Interface work, small bugs, mistakes in these pages, and new features are welcome. So are accessibility improvements and a scenario that can be reproduced. Issues and pull requests in English or Chinese are both fine. No invitation is needed. A comment helps avoid duplicate work. A small fix or a draft pull request does not need approval first. Questions are welcome before you have a solution.

The repository copy of this guide is [CONTRIBUTING.md](https://github.com/PStarH/unprompted/blob/main/CONTRIBUTING.md).

## What to send

| You noticed | Use |
| --- | --- |
| Something did not behave as expected | [Bug report](https://github.com/PStarH/unprompted/issues/new/choose) |
| A focused idea, or a question about where to start | [Idea or contribution](https://github.com/PStarH/unprompted/issues/new/choose) |
| A source that should be connected, and the work it would surface | [Connector request](https://github.com/PStarH/unprompted/issues/new/choose) |
| A discovery that was useful, missed, or noisy | [Workflow feedback](https://github.com/PStarH/unprompted/issues/new/choose) |
| A vulnerability | [Security](security.md), which uses [private advisory](https://github.com/PStarH/unprompted/security/advisories/new). Do not post exploit details, credentials, mail, or state files |
| A documentation error | A pull request on `docs-site/content/`, or an issue if you would rather describe it |

Blank issues are open. For a larger feature, open an issue first and name the user situation, the source signal, the evidence, and the permission. Read [product direction](https://github.com/PStarH/unprompted/blob/main/docs/PRODUCT_DIRECTION.md) before proposing a wider scope. The current priority is reliable use of connected context, and an honest check of discoveries people actually value. A technical backlog does not by itself authorize a broader action.

[Good first issues](https://github.com/PStarH/unprompted/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are a reasonable place to start. If that list is empty, docs, accessibility, synthetic scenarios, and regression tests are useful.

## Look at the loop first

No account, model, or install is required:

```sh
npm run example
npm run example -- --approve
```

Both use invented data and the simulated provider. The first prepares a reply and sends nothing. The second approves one simulated delivery, checks the receipt, and checks that a duplicate event does not send again. The file is [examples/first-workflow.mjs](https://github.com/PStarH/unprompted/blob/main/examples/first-workflow.mjs). [Your first workflow](https://github.com/PStarH/unprompted/blob/main/docs/EXTENDING.md) walks through the boundaries. You do not need the whole engine before improving a scenario or a page.

## Set up a change

Node.js 20+ and npm run the app and the base tests. Node.js 22.19+ is for the full contributor checks, including Pi. Fork the repository, clone your fork, and branch from current `main`:

```sh
git clone https://github.com/YOUR-USERNAME/unprompted.git
cd unprompted
git switch -c fix/describe-your-change
npm ci --include=optional
```

`npm ci --include=optional` installs the pinned SQLite runtime and the optional Pi and MCP packages. The base suite still runs without them. On Node.js 20 the Pi checks are skipped.

```sh
npm run demo
```

The demo is a disposable simulation. Stop it with Ctrl+C before tests. A short first check:

```sh
npm run test:workflow
npm run check:syntax
```

While iterating, run one file or one name:

```sh
npm test -- --file=test/workflow.test.js
npm test -- --test-name-pattern="deadline"
npm run test:fast
```

`test:fast` skips the long API, framework-eval, and generalization files. The runner lists test files in a stable order and runs them one at a time. Node's `--test-*` filters pass through on Windows, macOS, and Linux.

## Where a change starts

| Change | Start |
| --- | --- |
| A confusing setup step | [Install and first run](quickstart.md), [Configuration](configuration.md), and `docs/QUICKSTART.md` |
| These pages | `docs-site/content/en/` and `docs-site/content/zh/`, plus `docs-site/nav.json`. Build with the commands below |
| Keyboard or screen-reader access | `public/index.html`, `public/app.js`, `public/styles.css` |
| A missed or noisy discovery | `src/requests.js`, `src/correlation.js`, and the discovery tests |
| A synthetic workflow | `eval/scenarios.js` and [Testing](https://github.com/PStarH/unprompted/blob/main/docs/TESTING.md) |
| Evidence or recovery | `src/probes/`, `src/verification.js`, `test/workflow.test.js` |
| A connector | `src/connectors/` and [Connectors](https://github.com/PStarH/unprompted/blob/main/docs/CONNECTORS.md). Prove it with fixtures, not a personal account |
| Permissions or evidence rules | `src/permissions.js`, `src/evidence.js` |
| The workspace | `public/` and `test/browser/` |
| MCP | `src/mcp.js`, `src/tool-loop.js` |

Request detection starts in `test/discovery-precision.test.js` and `test/match-guard.test.js`. Correlation and follow-through start in `test/workflow.test.js`. Evidence and freshness start in `test/evidence.test.js` and `test/contradiction.test.js`. Permissions start in `test/permissions.test.js`, `test/calibration.test.js`, and `test/refusals.test.js`. The HTTP boundary is `test/api.test.js` and `test/shadow.test.js`. Connectors are `test/connectors.test.js` and `test/sync.test.js`. Restart and locking are `test/store-lock.test.js`. The rendered interface is `test/ui-render.test.js`. The full map is [Where to add a test](https://github.com/PStarH/unprompted/blob/main/docs/TESTING.md#where-to-add-a-test).

## Checks

A documentation-only change needs `npm run check:public`, plus a check that the commands and behavior you describe are the ones in the tree. Rebuild this site when you edit it:

```sh
node docs-site/build.mjs
node docs-site/check-links.mjs
```

The build writes `website/docs/`. That directory is what GitHub Pages serves at `/unprompted/docs/`.

Before a code change is ready for review, run the full set when you can. If a long check cannot run locally, say which one, and why, in the pull request.

```sh
npm test
npm run eval
npm run eval:framework
npm run eval:resilience
npm run eval:lifecycle
npm run eval:value
npm run check:public
npm run check:syntax
```

Pi uses Node.js 22.19+ and the optional packages, then `npm run eval:pi`. It checks the integration against scripted responses. It does not score model quality.

| Command | What a pass means |
| --- | --- |
| `npm test` | Behavioral, HTTP, connector, permission, storage, UI, and launcher tests |
| `npm run eval` | Synthetic scenarios against expected discovery, evidence, and action |
| `npm run eval:framework` | Framework correctness, false completions, invalid actions, cost, and attention |
| `npm run eval:resilience` | Bounded model bursts, plan recovery, and retained work |
| `npm run eval:lifecycle` | The whole-work lifecycle in the CI job of that name |
| `npm run eval:pi` | The Pi task contracts, with scripted model responses |
| `npm run eval:value` | Outcome metrics from the fixtures. Not a claim about real-world value |
| `npm run check:public` | Publishable paths, Markdown links, and credential-shaped strings |
| `npm run check:syntax` | JavaScript syntax for the files Git already tracks |

A passing eval is evidence about its fixtures. It is not a measurement of time saved or of production reliability. Tests use `node:test` and synthetic data. They must not need a real Google account, a model, or the network.

Other focused commands, when they match the change:

```sh
npm run test:connectors
npm run test:durable
npm run test:safety
npm run test:api
npm run test:browser
npm run test:first-run
npm run test:model-onboarding
npm run test:google-onboarding
npm run test:google-search
npm run test:connections
npm run test:workspace
npm run test:mcp
npm run test:durable-ui
npm run test:appearance
npm run test:overview
```

Browser contracts use scripted local servers. Do not point them at a personal workspace. `npm run test:connections` covers provider selection, copying a device code, authorization, pause, disconnect, and the bilingual layout. Apple Notes tests inject responses. They do not accept a real Notes account.

CI runs on pull requests. Node.js 20 and 22 both install from the lockfile with optional packages, then run syntax, public-file, test, and eval jobs. `eval:pi` runs on Node.js 22. A separate job runs the first-run, model, browser, workspace, Google onboarding, connections, durable UI, and MCP browser contracts. Contributor tooling is checked on Ubuntu, Windows, and macOS. CodeQL is configured separately.

The macOS bundle is a local unsigned build: `npm run build:macos-app` and `npm run smoke:macos-app`. It is not a notarized download.

## Guarantees to keep

- Normal mode stays read-only until a write is explicitly enabled. Keep the approval boundary.
- Provider and model input is untrusted. A model cannot grant a permission, approve an action, or mark work complete.
- Evidence comes from a real source and a version. Missing evidence stays unknown.
- An uncertain provider result is reconciled before another try. Accepting a review is not itself completion.
- One process writes a state file. Keep migration and recovery behavior.
- Leave credentials, mail, documents, and workspace state out of issues, pull requests, logs, fixtures, and screenshots. Use synthetic data.

Add a regression test when behavior changes. Cover the failure that would create a false completion, an unauthorized action, or a duplicate send. Do not add a test that only repeats a trivial implementation. A documentation correction does not need an implementation-shaped test.

A new scenario in `eval/scenarios.js` needs a distinct entity and deliverable, synthetic events, the expected outcome, and what must not happen: an unrelated change creates no work, missing evidence creates no false completion, and a prepared action does not send before authorization.

## Code and pull requests

Use ES modules, two-space indentation, single quotes, and semicolons. Prefer small functions and explicit data shapes. The core app uses Node built-ins. Pi Agent Core, Pi AI, and the MCP client are optional. Explain a new runtime dependency in the pull request.

Keep the pull request focused. Describe the problem, the change, and how you checked it, including a reviewer who has not read the issue. The [pull request template](https://github.com/PStarH/unprompted/blob/main/.github/pull_request_template.md) asks you to confirm synthetic data, `npm run check:public`, and, for a behavior change, the failure or boundary you covered.

Stage files by path. `git add -A` can pick up another person's uncommitted work in a shared checkout.

## License

By submitting a contribution, you confirm you have the right to submit it and agree to license it under [Apache-2.0](https://github.com/PStarH/unprompted/blob/main/LICENSE), without additional terms. There is no separate contributor license agreement. Name any third-party code, and its compatible license, in the pull request and, where needed, in [NOTICE](https://github.com/PStarH/unprompted/blob/main/NOTICE).
