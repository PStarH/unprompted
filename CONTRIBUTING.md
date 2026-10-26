# Contributing to Unprompted

Welcome. You can contribute with a small fix, a clearer explanation, an
accessibility improvement, or a reproducible scenario. Issues and PRs in
**English or Chinese** are welcome. No invitation is needed.

## Make a first contribution

You can inspect and edit a complete workflow in a few minutes with no account,
model or dependency install:

```sh
npm run example
npm run example -- --approve
```

Both commands use invented data and the simulated provider. Start with
[your first workflow](docs/EXTENDING.md), then pick a small change below. There
is no need to understand the full engine before improving a scenario or a doc.

1. [Try the demo](docs/QUICKSTART.md) so you have seen the event → evidence →
   action loop.
2. Look at [good first issues](https://github.com/PStarH/unprompted/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22),
   or open an issue describing a focused improvement. If the list is empty,
   docs, accessibility, synthetic scenarios, and regression tests are good starts.
   A comment helps avoid duplicate effort, but small fixes and draft PRs do not
   need advance approval. Questions are welcome before you have a solution.
   小修复和草稿 PR 无需事先审批；留言可以帮助避免重复工作。
3. Fork the repository and create a branch for your change.
4. Run the relevant checks, then open a PR describing the problem, the change,
   and how you verified it. A draft PR is welcome if you'd like early feedback;
   mention which checks you ran or could not run.

For a larger feature, link an issue that explains the user situation, source
signal, evidence and permissions. A small fix or draft PR needs no advance approval.

The current priority is reliable use of real connected context and honest
evaluation of unrequested discoveries that users value. Technical backlogs
do not override that validation gate or authorize broader execution. Read
[product direction](docs/PRODUCT_DIRECTION.md) before proposing scope changes.

## Local setup

Node.js **20+** and npm are enough for the core app and base test suite;
**22.19+** is recommended for the complete contributor checks. Pi Agent Core and
Pi AI are optional runtime packages used by the Pi integration tests and runtime.
Install them from the lockfile when running those checks:

```sh
npm ci --include=optional
```

The base suite still runs without those optional packages. On Node.js 20 the Pi
integration tests are skipped.
Fork the repository on GitHub first, then replace `YOUR-USERNAME` below with
the account that owns your fork.

```sh
git clone https://github.com/YOUR-USERNAME/unprompted.git
cd unprompted
git switch -c fix/describe-your-change
npm run demo
```

Stop the demo with Ctrl+C before running tests on a busy machine. For a short
first check:

```sh
npm run test:workflow
npm run check:syntax
```

Use the [test map](docs/TESTING.md#where-to-add-a-test) to choose an individual
suite while iterating. For example:

```sh
npm test -- --file=test/discovery-precision.test.js
npm test -- --test-name-pattern="deadline"
npm run test:fast
```

`test:fast` excludes the HTTP API, framework evaluation, and generalisation
files. The runner selects test files in stable name order, runs them serially,
and passes Node's `--test-*` filters through on Windows, macOS, and Linux.

## Choose useful work

These starter tasks include code entry points, scope and acceptance checks:

- [Remember the selected connection panel · #6](https://github.com/PStarH/unprompted/issues/6)
- [Show the next observation time · #7](https://github.com/PStarH/unprompted/issues/7)
- [Write the Chinese connector setup guide · #8](https://github.com/PStarH/unprompted/issues/8)

Start from the current `main` branch. Larger connector tasks are
[GitHub repository selection · #9](https://github.com/PStarH/unprompted/issues/9),
[Notion · #10](https://github.com/PStarH/unprompted/issues/10), and
[Slack · #11](https://github.com/PStarH/unprompted/issues/11).

| Contribution | A good starting point |
| --- | --- |
| Explain a confusing setup step | [First-run guide](docs/QUICKSTART.md), [configuration](docs/CONFIGURATION.md) |
| Improve keyboard or screen-reader access | `public/index.html`, `public/app.js`, `public/styles.css` |
| Fix a missed or noisy discovery | `src/requests.js`, `src/correlation.js`, discovery tests |
| Add a synthetic workflow | `eval/scenarios.js`, [testing guide](docs/TESTING.md) |
| Strengthen evidence or recovery | `src/probes/`, `src/verification.js`, `test/workflow.test.js` |
| Build a connector | [Connector guide](docs/CONNECTORS.md), with a fixture-only example |

## Checks before review

For a documentation-only change, run `npm run check:public` and verify the
commands or behavior you describe. While iterating on code, run the smallest
relevant test from the [test map](docs/TESTING.md#where-to-add-a-test). Before
marking a code PR ready, run the full checks below if you can; if a longer check
is unavailable locally, say so in the PR. CI runs these checks on pull requests.

```sh
npm test
npm run eval
npm run eval:framework
npm run eval:resilience
npm run eval:value
npm run check:public
npm run check:syntax
```

For the Pi integration suite, use Node.js 22.19+ with the optional packages
installed, then run `npm run eval:pi`. CI installs optional packages from the
lockfile and runs that evaluation on Node.js 22.

The complete suite can take several minutes. [Testing](docs/TESTING.md) explains
what each evaluation proves. Tests use `node:test` and synthetic data; they must
not require real Google credentials, a model, or internet access. CI and the
local test runner use the same serial test selection and syntax-check commands.

## Preserve the product's guarantees

- Keep normal mode read-only by default and preserve the approval boundary.
- Treat provider/model input as untrusted. A model cannot grant permission,
  approve an action, or claim completion.
- Ground evidence in a real source and version; missing evidence stays unknown.
- Reconcile uncertain outcomes before retrying. Acceptance alone is not completion.
- Keep one writer per state file and retain the migration and recovery behavior.
- Keep sensitive data out of issues, PRs, logs and fixtures. Local workspace state
  can contain real email and document content; never commit or upload it.

Add a regression test when changing behavior. Cover the relevant failure or
boundary case, especially anything that could create a false completion,
unauthorized action, or duplicate send. Don't add tests that merely repeat a
trivial implementation.

## Code and pull requests

Use ES modules, two-space indentation, single quotes, and semicolons. Prefer
small functions and explicit data shapes. Explain new runtime dependencies in
the PR. The core app uses Node built-ins; Pi Agent Core and Pi AI are optional
runtime dependencies.

Keep a PR focused. Its description should make the behavior and validation clear
to a reviewer who hasn't read the issue discussion. Screenshots should use
synthetic data. The [PR template](.github/pull_request_template.md) lists the
useful review details.

## Reporting problems and security issues

Use [issue templates](https://github.com/PStarH/unprompted/issues/new/choose)
for ordinary bugs and ideas. Use the [feedback guide](docs/VALUE_VALIDATION.md)
for discoveries that were useful, noisy, or missed. Follow [SECURITY.md](SECURITY.md)
for vulnerabilities, rather than posting exploit details publicly.

## License

By submitting a contribution, you confirm you have the right to submit it and
agree to license it under the project's [Apache-2.0 license](LICENSE), without
additional terms. No separate contributor license agreement is required. Record
any third-party code's origin and compatible license in the PR and, where needed,
[NOTICE](NOTICE).
