import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, CATEGORY_COUNT } from '../eval/scenarios.js';
import { runFixture, checkExpectation } from '../eval/harness.js';

/**
 * The generalization evaluation suite, run as part of `npm test`.
 *
 * Each scenario is a request the reasoning code has never seen. Nothing about
 * these requests is special-cased in the engine — they exercise the same
 * derivation, correlation and assessment paths as production input.
 */

const REQUIRED_CATEGORIES = [
  'Different wording for familiar task types',
  'New deliverable types not explicitly hard-coded',
  'Requests involving different project or entity names',
  'Related documents with different terminology',
  'Similar documents belonging to the wrong project',
  'Requests with multiple acceptance criteria',
  'Requests containing the qualifier "latest"',
  'Missing or inaccessible authoritative evidence',
  'Contradictory evidence or stale results',
  'Ambiguous candidate documents',
  'Repeated and out-of-order environmental events',
  'A temporarily unavailable reasoning model'
];

test('the evaluation suite covers every required category', () => {
  assert.ok(CATEGORY_COUNT >= REQUIRED_CATEGORIES.length,
    `expected at least ${REQUIRED_CATEGORIES.length} categories, found ${CATEGORY_COUNT}`);
  const covered = new Set(SCENARIOS.map(scenario => scenario.category));
  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(covered.has(category), `no scenario covers: ${category}`);
  }
  assert.ok(SCENARIOS.length >= 12, 'the suite should be a representative variety, not a single case');
});

for (const scenario of SCENARIOS) {
  test(`${scenario.category} — ${scenario.id}`, async () => {
    const { observations, outcome } = await runFixture(scenario);
    const failures = [];
    for (const phase of observations) {
      for (const failure of checkExpectation(phase.expect, phase.observed)) {
        failures.push(phase.label ? `[${phase.label}] ${failure}` : failure);
      }
    }
    // Approval fixtures assert what happened after the approval boundary too.
    for (const failure of checkExpectation(scenario.outcomeExpect || {}, outcome)) {
      failures.push(`[approval] ${failure}`);
    }
    assert.deepEqual(failures, [], `${scenario.why}\n${failures.join('\n')}`);
  });
}

test('no probe in any scenario is justified by text that is not in the request', async () => {
  for (const scenario of SCENARIOS) {
    const { final } = await runFixture(scenario);
    assert.equal(final.justificationsVerbatim, true, `${scenario.id} produced an unjustified probe`);
  }
});

test('no scenario sends an external action', async () => {
  for (const scenario of SCENARIOS) {
    const { final } = await runFixture(scenario);
    assert.equal(final.outboxCount, 0, `${scenario.id} sent something without approval`);
  }
});

test('every scenario that reaches a prepared draft rests on direct evidence', async () => {
  for (const scenario of SCENARIOS) {
    const { final } = await runFixture(scenario);
    if (!final.draftPresent) continue;
    const satisfied = final.criteria.filter(item => item.status === 'satisfied');
    assert.ok(satisfied.length > 0, `${scenario.id} prepared a draft with no satisfied criterion`);
    assert.ok(satisfied.every(item => item.strength === 'direct'),
      `${scenario.id} prepared a draft on indicative evidence`);
  }
});

test('no scenario declares completion while a required criterion is unsatisfied', async () => {
  for (const scenario of SCENARIOS) {
    const { final } = await runFixture(scenario);
    if (!final.complete) continue;
    assert.equal(final.unsatisfied.length, 0, `${scenario.id} completed with unsatisfied criteria`);
  }
});

test('an approved request is executed exactly once and verified from the outbox receipt', async () => {
  const scenario = SCENARIOS.find(item => item.approve);
  assert.ok(scenario, 'expected at least one fixture carried through the approval boundary');
  const { outcome } = await runFixture(scenario);
  assert.deepEqual(outcome.statuses, ['completed'], `${scenario.id} did not finish after approval`);
  assert.equal(outcome.completed, 1);
  assert.equal(outcome.executedActions, 1);
  assert.equal(outcome.verifiedByReceipt, 1);
  assert.equal(outcome.unverifiedByReceipt, 0);
});
