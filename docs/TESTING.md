# Testing and evaluation

[← Documentation](README.md)

Tests use Node's built-in `node:test` runner and synthetic fixtures. No external
account, model key or package installation is required. Stop unnecessary local
servers before running a large suite.

## A short first check

```sh
npm run test:workflow
```

This checks discovery, reassessment, missing evidence, freshness, approval,
verification and recovery. Run one relevant test file while iterating:

```sh
node --test test/discovery-precision.test.js
```

## Full checks

```sh
npm test
npm run eval
npm run eval:framework
npm run eval:value
npm run check:public
```

| Command | What it checks |
| --- | --- |
| `npm test` | Behavioral, HTTP, connector, permission, storage, UI, and launcher tests |
| `npm run eval` | Synthetic scenarios against expected discovery, evidence and action outcomes |
| `npm run eval:framework` | Framework correctness, false completions, invalid actions, cost and attention coverage |
| `npm run eval:value` | Outcome-derived product metrics; not a real-world value claim |
| `npm run check:public` | Candidate public paths, Markdown links/anchors, internal-document markers and common credential signatures |

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

CI runs these public-file checks as well as syntax checks, behavioral tests and
all three evaluations. Security analysis is configured separately in CodeQL.
