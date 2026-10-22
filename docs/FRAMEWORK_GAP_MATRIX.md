# Implementation and coverage

[← Documentation](README.md)

Use this map to find the implementation and the behavioral tests for a change.
A scripted provider verifies code behavior; it does not establish live-service
or real-user outcomes. Run the commands in [Testing](TESTING.md) for current results.

| Guarantee | Implementation | Useful tests |
| --- | --- | --- |
| Discover from an event without an agent prompt | `src/requests.js`, `src/engine.js` | `test/workflow.test.js`, `test/discovery-precision.test.js` |
| Ignore automated noise and unrelated changes | `src/requests.js`, `src/correlation.js` | `test/discovery-precision.test.js`, `test/match-guard.test.js` |
| Normalize, deduplicate and sync incrementally | `src/connectors/`, `src/engine.js` | `test/sync.test.js`, `test/connectors.test.js` |
| Preserve newer evidence when events arrive out of order | `src/engine.js`, `src/freshness.js` | `test/ordering.test.js` |
| Probe requirements and retain unknowns | `src/probes/`, `src/criteria.js` | `test/probes.test.js`, `test/evidence.test.js` |
| Ground model proposals in the request | `src/reasoning.js`, `src/probes/plan.js` | `test/reasoning.test.js`, `test/contracts.test.js` |
| Withhold unsupported freshness claims | `src/freshness.js` | `test/workflow.test.js`, `test/evidence.test.js` |
| Recheck competing sources and contradictions | `src/verification.js` | `test/verification.test.js`, `test/contradiction.test.js` |
| Enforce read-only and approval boundaries | `src/permissions.js`, `src/engine.js`, `server.js` | `test/shadow.test.js`, `test/refusals.test.js`, `test/permissions.test.js`, `test/api.test.js` |
| Scope and revoke stated authorization | `src/calibration.js`, `src/permissions.js` | `test/calibration.test.js` |
| Reconcile before retry; verify receipts | `src/providers.js`, `src/engine.js` | `test/workflow.test.js`, `test/connectors.test.js` |
| Preserve state and reject a second writer | `src/store.js` | `test/store-lock.test.js`, `test/workflow.test.js` |
| Deduplicate and withdraw decision notifications | `src/notifications.js` | `test/notifications.test.js`, `test/deadlines.test.js` |
| Surface stalled requests and allow closure | `src/engine.js` | `test/stall.test.js` |
| Keep narrow opportunity proposals evidence-backed | `src/opportunities.js` | `test/opportunities.test.js` |
| Keep a bounded, inspectable decision trace | `src/trace.js`, `src/contracts.js` | `test/trace.test.js`, `test/contracts.test.js` |
| Derive metrics from recorded outcomes | `src/metrics.js` | `test/metrics.test.js`, `test/framework-eval.test.js` |
| Isolate the one-command demo from existing credentials/state | `scripts/demo.mjs` | `test/demo.test.js` |

## Gaps that remain

General desktop control, calendar and Slack connectors, autonomous document
editing, authentication, and multi-user storage are outside the current
implementation. Google push notifications and broad narrative understanding are
not implemented. Live sending has scripted coverage but is not presented as
production-validated. Real-world usefulness and error rates require feedback.

See [Architecture](ARCHITECTURE.md#known-limitations) for the consequences of
these limits and [Contributing](../CONTRIBUTING.md) to propose focused work.
