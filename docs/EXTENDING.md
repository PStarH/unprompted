# Your first workflow

[← Documentation](README.md)

You can explore the framework with Node.js 20+ and the source checkout. No
installed packages, server, model, credentials or cloud services are needed.

```sh
npm run example
npm run example -- --approve
```

The example creates a disposable local store, feeds invented environmental
events through the real engine, and removes its workspace when done. It does
not read saved account settings or environment credentials.

## Follow the running code

Open [examples/first-workflow.mjs](../examples/first-workflow.mjs). It has three
inputs you can edit: an incoming request, a partially updated document and a
complete document. Each step asserts what actually happened.

| Step | What you can inspect | Guarantee exercised |
| --- | --- | --- |
| Request arrives | `engine.ingest(request)` | A follow-up is discovered from an event, without an agent task prompt |
| Partial document arrives | `waiting_for_information`, empty outbox | Missing evidence does not become a completion or send |
| Complete document arrives | `ready_for_approval`, empty outbox | Preparation and external execution are separate |
| Optional `--approve` | Current `reviewToken`, simulated receipt | Approval refers to the prepared reply; completion follows verification |
| Same event arrives again | Exactly one outbox record | A duplicate event does not cause a second delivery |

Try deleting the conclusion from the complete document. The example will fail
its readiness assertion: the engine correctly keeps that requirement open.
Restore it and run again. Then run the relevant regression suite:

```sh
npm run test:workflow
```

## Extension boundaries

The source is an early framework implementation, with directly importable
modules. It is not yet a versioned SDK or a stable plugin API. Keep changes
focused and cover the boundary you modify.

| Extend… | Start here | What the engine must retain |
| --- | --- | --- |
| An environmental event source | [Connector contract](../src/connectors/connector.js), [event normalization](../src/connectors/events.js), [connector guide](CONNECTORS.md) | Stable provider event IDs, provenance, explicit failures, incremental cursors |
| A source-backed evidence check | [Probe planning](../src/probes/plan.js), [assessment](../src/probes/assess.js) | Quotes, versions and uncertainty; no invented support |
| Optional interpretation or planning | [Reasoner boundary](../src/reasoning.js), [Pi adapter](../src/pi-runtime.js) | Task-scoped reads, budgets, validated proposals; the engine owns authority |
| A consequential action provider | [Provider contract](../src/providers.js), [permissions](../src/permissions.js) | Idempotency, receipt lookup and readback; unknown outcomes stay unknown |
| A reproducible scenario | [Scenario fixtures](../eval/scenarios.js), [test map](TESTING.md#where-to-add-a-test) | Expected silence, incomplete evidence and failure recovery as well as success |
| An interaction improvement | [Interface](../public/app.js), [browser checks](TESTING.md#browser-interaction-contract) | Preserve drafts, focus and review identity during updates |

[Contracts](../src/contracts.js) describe the artifacts crossing the layers and
provide `validateContract` / `validateAll`. [Architecture](ARCHITECTURE.md)
explains their wiring; [the API reference](API.md) covers HTTP consumers.

The current product priority is reliability and evidence from read-only user
validation. A connector contract is an extension point, not a commitment to add
new integrations before that validation. Start a discussion about larger scope
changes; small fixes and draft PRs are welcome without advance approval.

## A useful first PR

Pick one confusing setup instruction, accessibility gap or synthetic workflow
failure. Show its trigger, expected behavior and observed behavior with invented
data. Add a focused regression when changing behavior, run the relevant checks,
and explain the result. English and Chinese are both welcome.

See [Contributing](../CONTRIBUTING.md) for review and licensing, and
[Security](../SECURITY.md) for private vulnerability reports.
