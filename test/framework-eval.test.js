/**
 * Framework evaluation — the evaluator must be able to fail.
 *
 * A measurement that cannot report a defect is decoration. These tests check
 * both directions: the real fixtures satisfy every framework invariant, and each
 * detector fires when handed the run it exists to catch. The detectors are
 * exercised through the pure fold, so they cannot be "verified" by hunting for a
 * fixture that happens to misbehave.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFramework, frameworkInvariants, foldRun, emptyAccumulator, summarise } from '../eval/framework.js';

/** A run shaped exactly like `runFixture` output, with overridable parts. */
function syntheticRun({ id = 'synthetic', expect = {}, observed = {}, outcome = {}, attention = {}, completion = {}, cost = {} } = {}) {
  return {
    scenario: { id, category: 'synthetic', why: 'unit' },
    expect,
    final: { complete: false, outboxCount: 0, conflicts: [], unsatisfied: [], ...observed },
    outcome: { tasks: 1, statuses: ['waiting_for_information'], completed: 0, verifiedComplete: 0, executedActions: 0, ...outcome },
    metrics: {
      attention: { interruptions: 0, unresolved: 0, takeovers: 0, byKind: {}, ...attention },
      completion: { unverifiedCompletions: 0, ...completion }
    },
    resources: { events: 1, documents: 1, probes: 1, modelCalls: 0, notifications: 0, traceEntries: 1, ...cost }
  };
}

function fold(runs) {
  const acc = emptyAccumulator();
  for (const run of runs) foldRun(acc, run);
  return summarise(acc, runs);
}

const kinds = report => report.defects.map(defect => defect.kind);

test('a spurious task is reported as a defect', () => {
  const report = fold([syntheticRun({ expect: { requestFound: false } })]);
  assert.deepEqual(kinds(report), ['spurious_discovery']);
  assert.equal(report.discovery.spurious, 1);
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('missed')).ok, true);
});

test('a request that should have been found but was not is reported', () => {
  const report = fold([syntheticRun({ expect: { requestFound: true }, outcome: { tasks: 0, statuses: [] } })]);
  assert.deepEqual(kinds(report), ['missed_discovery']);
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('missed')).ok, false);
});

test('completion claimed when the label says otherwise is a false positive', () => {
  const report = fold([syntheticRun({ expect: { complete: false }, outcome: { completed: 1, verifiedComplete: 1, statuses: ['completed'] } })]);
  assert.deepEqual(kinds(report), ['false_positive']);
  assert.equal(report.correctness.completionPrecision, 0);
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('insufficient evidence')).ok, false);
});

test('a warranted completion that was withheld is a false negative', () => {
  const report = fold([syntheticRun({ expect: { complete: true } })]);
  assert.deepEqual(kinds(report), ['false_negative']);
  assert.equal(report.correctness.correctCompletionRate, 0);
});

test('an external action before any approval is an invalid action', () => {
  const report = fold([syntheticRun({ expect: { outboxCount: 0 }, observed: { outboxCount: 2 } })]);
  assert.ok(kinds(report).includes('invalid_action'));
  assert.equal(report.actions.invalid, 2);
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('before an approval')).ok, false);
});

test('a terminal action without verification is reported', () => {
  const report = fold([syntheticRun({ expect: { complete: true }, outcome: { completed: 1, verifiedComplete: 0, executedActions: 1, statuses: ['completed'] } })]);
  assert.ok(kinds(report).includes('unverified_execution'));
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('terminal state')).ok, false);
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('every executed action')).ok, false);
});

test('a completion the engine did not verify is reported', () => {
  const report = fold([syntheticRun({ completion: { unverifiedCompletions: 3 } })]);
  assert.ok(kinds(report).includes('unverified_completion'));
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('recorded unverified')).ok, false);
});

test('an interruption still open on verified-complete work is unnecessary', () => {
  const report = fold([syntheticRun({
    expect: { complete: true },
    outcome: { completed: 1, verifiedComplete: 1, statuses: ['completed'] },
    attention: { interruptions: 2, unresolved: 1, byKind: { deadline: 2 } }
  })]);
  assert.ok(kinds(report).includes('unnecessary_interruption'));
  assert.equal(report.interruptions.total, 2);
  assert.equal(report.interruptions.openOnFinishedWork, 1);
  assert.equal(frameworkInvariants(report).find(i => i.name.includes('open on finished work')).ok, false);
});

test('a quiet run is still counted as eligible to interrupt', () => {
  const report = fold([syntheticRun()]);
  assert.equal(report.interruptions.observedRuns, 0);
  assert.equal(report.interruptions.eligibleRuns, 1);
  assert.match(report.notes.join(' '), /unexercised/);
});

test('the framework meets its own invariants on the real fixture suite', async () => {
  const report = await evaluateFramework();
  const broken = frameworkInvariants(report).filter(item => !item.ok);
  assert.deepEqual(broken, [], `invariants broken: ${broken.map(item => item.name).join('; ')}`);

  // The report must rest on real labels, not on an empty set.
  assert.ok(report.coverage.completionLabels >= 15, 'expected the completion matrix to be labelled');
  assert.ok(report.completion.truePositive >= 9, 'expected the suite to exercise completion');
  assert.ok(report.completion.trueNegative >= 5, 'expected the suite to exercise withholding');
  assert.equal(report.defects.length, 0);

  // Every dimension must say how much evidence it rests on.
  assert.ok(report.basis.length >= 4);
  assert.ok(report.notes.length >= 1);
});
