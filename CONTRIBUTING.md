# Contributing to Unprompted

Welcome. You can contribute with a small fix, a clearer explanation, an
accessibility improvement, or a reproducible scenario. Issues and PRs in
**English or Chinese** are welcome. No invitation is needed.

## Make a first contribution

1. [Try the demo](docs/QUICKSTART.md) so you have seen the event → evidence →
   action loop.
2. Look at [good first issues](https://github.com/PStarH/unprompted/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22),
   or open an issue describing a focused improvement. If the list is empty,
   docs, accessibility, synthetic scenarios, and regression tests are good starts.
   If you want to work on an issue, leave a comment first so we can confirm the
   scope and avoid duplicate effort. Questions are welcome before you have a
   solution. 想认领 issue 的话，先留言确认范围；还没想好实现方案也可以先提问。
3. Fork the repository and create a branch for your change.
4. Run the relevant checks, then open a PR describing the problem, the change,
   and how you verified it. A draft PR is welcome if you'd like early feedback;
   mention which checks you ran or could not run.

For larger features or a new connector, open an issue before implementation so
we can agree on a useful scenario, evidence, permissions, and scope.

## Local setup

Node.js **20+** and npm are enough; **22+** is recommended. There are no runtime
or test dependencies to install.
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
```

Use the [test map](docs/TESTING.md#where-to-add-a-test) to choose an individual
suite while iterating. For example:

```sh
node --test test/discovery-precision.test.js
```

## Choose useful work

| Contribution | A good starting point |
| --- | --- |
| Explain a confusing setup step | [First-run guide](docs/QUICKSTART.md), [configuration](docs/CONFIGURATION.md) |
| Improve keyboard or screen-reader access | `public/index.html`, `public/app.js`, `public/styles.css` |
| Fix a missed or noisy discovery | `src/requests.js`, `src/correlation.js`, discovery tests |
| Add a synthetic workflow | `eval/scenarios.js`, [testing guide](docs/TESTING.md) |
| Strengthen evidence or recovery | `src/probes/`, `src/verification.js`, `test/workflow.test.js` |
| Explore a connector | [Architecture](docs/ARCHITECTURE.md), then an issue with the proposed scenario |

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
npm run eval:value
npm run check:public
```

The complete suite can take several minutes. [Testing](docs/TESTING.md) explains
what each evaluation proves. Tests use `node:test` and synthetic data; they must
not require real Google credentials, a model, or internet access. CI runs the
suite serially to avoid competing server processes.

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
the PR; the application currently has none.

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
