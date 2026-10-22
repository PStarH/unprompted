/**
 * Framework evaluation — the acceptance test the framework sets for itself.
 *
 * `eval/run.js` asks "did each fixture behave as its author expected?" That is a
 * scenario suite: it proves the engine handles the cases someone thought to
 * write down. It cannot tell you the *rate* at which the framework is right, nor
 * in which direction it is wrong.
 *
 * This evaluator answers the core framework questions over
 * the same fixtures, using each fixture's own expectation as the label:
 *
 *   正确完成率   of the requests that should complete, how many did
 *   误报         claimed complete when the evidence said it should not
 *   漏报         withheld completion that was actually warranted
 *   无效行动     external actions taken with no approval behind them
 *   资源消耗     events, documents, probes, model calls, trace entries per run
 *   打扰         interruptions, and notifications left open on finished work
 *
 * The point is the *confusion matrix*, not a single score: a framework that
 * never completes anything has no false positives and is still useless, whereas
 * "completed, verified, and it was allowed to" is the property that matters.
 *
 * Labels are not invented here. A fixture contributes to a cell only when it
 * declares the corresponding expectation, and coverage is reported so a high
 * rate over three fixtures cannot masquerade as a high rate over the suite.
 *
 * The fold is a pure function of the run results (`foldRun`), so the detectors
 * themselves can be tested with synthetic runs instead of by finding a fixture
 * that happens to misbehave.
 */

import { SCENARIOS } from './scenarios.js';
import { runFixture } from './harness.js';

/** The expectation that describes a fixture's end state. */
export function finalExpectation(scenario) {
  const phases = scenario.phases || [{ events: scenario.events, expect: scenario.expect }];
  return phases[phases.length - 1].expect || {};
}

const sum = values => values.reduce((total, value) => total + value, 0);
const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 1000) / 1000 : null);

export function emptyAccumulator() {
  return {
    discovery: { expected: 0, found: 0, missed: 0, spurious: 0 },
    completion: { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 },
    actions: { expected: 0, takenWithoutApproval: 0, invalid: 0, missed: 0, approvedAndExecuted: 0, approvedAndVerified: 0 },
    interruptions: { total: 0, openOnFinishedWork: 0, takeovers: 0, byKind: {}, eligibleRuns: 0, observedRuns: 0 },
    resources: { events: 0, documents: 0, probes: 0, modelCalls: 0, notifications: 0, traceEntries: 0 },
    defects: []
  };
}

/**
 * Fold one run into the accumulator. Pure: it reads the run and mutates only the
 * accumulator it was handed.
 */
export function foldRun(acc, run) {
  const { scenario, expect, final, outcome, metrics, resources: cost } = run;
  const defect = (kind, detail) => acc.defects.push({ id: scenario.id, kind, detail });
  const found = outcome.tasks > 0;

  // --- discovery (漏报 / 误报 at the task level) ------------------------
  if (expect.requestFound === true) {
    acc.discovery.expected += 1;
    if (found) acc.discovery.found += 1;
    else { acc.discovery.missed += 1; defect('missed_discovery', 'a request it should have found was not found'); }
  }
  if (expect.requestFound === false && found) {
    acc.discovery.spurious += 1;
    defect('spurious_discovery', `created ${outcome.tasks} task(s) where none was warranted`);
  }

  // --- completion matrix (正确完成率) -----------------------------------
  const claimedComplete = outcome.completed > 0 || final.complete === true;
  if (expect.complete === true) {
    if (claimedComplete) acc.completion.truePositive += 1;
    else { acc.completion.falseNegative += 1; defect('false_negative', `completion was warranted; status stayed ${outcome.statuses.join(',') || 'none'}`); }
  }
  if (expect.complete === false) {
    if (claimedComplete) { acc.completion.falsePositive += 1; defect('false_positive', 'claimed completion on insufficient evidence'); }
    else acc.completion.trueNegative += 1;
  }

  // A completion the engine itself did not verify is a defect regardless of what
  // the fixture expected.
  if (metrics.completion.unverifiedCompletions > 0) {
    defect('unverified_completion', `${metrics.completion.unverifiedCompletions} completion(s) without provider verification`);
  }

  // --- external actions (无效行动) ---------------------------------------
  // `final` is observed *before* the approval pass, so an outbox entry there is
  // an action taken with no approval behind it — the definition of invalid.
  const expectedOutbox = expect.outboxCount;
  if (typeof expectedOutbox === 'number') {
    acc.actions.expected += expectedOutbox;
    acc.actions.takenWithoutApproval += final.outboxCount;
    if (final.outboxCount > expectedOutbox) {
      acc.actions.invalid += final.outboxCount - expectedOutbox;
      defect('invalid_action', `sent ${final.outboxCount} message(s) before any approval; none was expected`);
    }
    if (final.outboxCount < expectedOutbox) acc.actions.missed += expectedOutbox - final.outboxCount;
  }
  // Actions carried through the approval pass are legitimate work, but they are
  // only counted as verified when the provider confirmed them.
  acc.actions.approvedAndExecuted += outcome.executedActions;
  acc.actions.approvedAndVerified += outcome.verifiedComplete;
  if (outcome.completed > outcome.verifiedComplete) {
    defect('unverified_execution', `${outcome.completed - outcome.verifiedComplete} action(s) reached a terminal state without provider verification`);
  }

  // --- interruptions (打扰) ---------------------------------------------
  acc.interruptions.total += metrics.attention.interruptions;
  acc.interruptions.takeovers += metrics.attention.takeovers;
  if (metrics.attention.interruptions > 0) acc.interruptions.observedRuns += 1;
  // A run is eligible to interrupt when something in it could justify a decision.
  // Counting eligibility is what keeps a silent suite from reading as a silent
  // system: zero interruptions over zero eligible runs proves nothing.
  if (outcome.tasks || (final.conflicts || []).length || (final.unsatisfied || []).length) acc.interruptions.eligibleRuns += 1;
  for (const [kind, count] of Object.entries(metrics.attention.byKind || {})) {
    acc.interruptions.byKind[kind] = (acc.interruptions.byKind[kind] || 0) + count;
  }
  // An interruption is unnecessary when the work it refers to has already
  // finished and been verified: there is nothing left for the user to decide.
  if (outcome.verifiedComplete > 0 && metrics.attention.unresolved > 0) {
    acc.interruptions.openOnFinishedWork += metrics.attention.unresolved;
    defect('unnecessary_interruption', `${metrics.attention.unresolved} notification(s) still open on verified-complete work`);
  }

  // --- resources (资源消耗) ----------------------------------------------
  for (const key of Object.keys(acc.resources)) acc.resources[key] += cost[key] || 0;

  return acc;
}

/** Derive the reported rates, coverage and notes from a folded accumulator. */
export function summarise(acc, runs) {
  const { completion, discovery, actions, interruptions, resources } = acc;
  const labeled = completion.truePositive + completion.falsePositive + completion.falseNegative + completion.trueNegative;
  const correctness = {
    labeled,
    correct: completion.truePositive + completion.trueNegative,
    accuracy: rate(completion.truePositive + completion.trueNegative, labeled),
    correctCompletionRate: rate(completion.truePositive, completion.truePositive + completion.falseNegative),
    // Precision over "things the framework decided to finish": the share of
    // completions that were actually warranted.
    completionPrecision: rate(completion.truePositive, completion.truePositive + completion.falsePositive)
  };

  return {
    runs: runs.map(run => ({
      id: run.scenario.id, category: run.scenario.category,
      tasks: run.outcome.tasks, statuses: run.outcome.statuses,
      verifiedComplete: run.outcome.verifiedComplete, executedActions: run.outcome.executedActions,
      cost: run.resources
    })),
    discovery, completion, actions, interruptions, resources, correctness,
    defects: acc.defects,
    coverage: {
      runs: runs.length,
      completionLabels: labeled,
      discoveryLabels: discovery.expected,
      actionLabels: actions.expected,
      interruptionEligibleRuns: interruptions.eligibleRuns,
      interruptionObservedRuns: interruptions.observedRuns
    },
    notes: [
      interruptions.observedRuns === 0
        ? `No run produced an interruption, so the attention dimension is measured but unexercised by these ${runs.length} fixtures. It is covered directly by test/notifications.test.js; a zero here means "nothing was eligible to interrupt", not "the system refused to interrupt".`
        : `${interruptions.observedRuns} of ${runs.length} runs interrupted, over ${interruptions.eligibleRuns} eligible run(s).`,
      actions.approvedAndExecuted === 0
        ? 'No run executed an external action, so the invalid-action dimension is measured but unexercised by these fixtures. It is covered directly by test/workflow.test.js.'
        : `${actions.approvedAndExecuted} action(s) were executed through the approval boundary and ${actions.approvedAndVerified} verified.`
    ],
    basis: [
      'labels come from each fixture\'s own expectation; coverage is reported so a thin label set cannot inflate a rate',
      'a completion counts only when the provider verified it (status starts with "verified")',
      'an invalid action is an external action taken before any approval',
      'an unnecessary interruption is a notification left open on verified-complete work',
      'resources are counted from persisted state, so a number here cannot drift from what happened'
    ]
  };
}

/** Run every fixture and fold the results into a single report. */
export async function evaluateFramework({ scenarios = SCENARIOS } = {}) {
  const runs = [];
  for (const scenario of scenarios) {
    const result = await runFixture({ ...scenario, approve: true });
    runs.push({ scenario, expect: finalExpectation(scenario), ...result });
  }
  const acc = emptyAccumulator();
  for (const run of runs) foldRun(acc, run);
  return summarise(acc, runs);
}

/** Hard invariants. A false value here is a framework defect, not a flaky test. */
export function frameworkInvariants(report) {
  return [
    { name: 'no completion was claimed on insufficient evidence', ok: report.completion.falsePositive === 0 },
    { name: 'no external action was taken before an approval', ok: report.actions.invalid === 0 },
    { name: 'every executed action was verified', ok: report.actions.approvedAndExecuted === report.actions.approvedAndVerified },
    { name: 'no action reached a terminal state unverified', ok: !report.defects.some(defect => defect.kind === 'unverified_execution') },
    { name: 'no notification stayed open on finished work', ok: report.interruptions.openOnFinishedWork === 0 },
    { name: 'no request that should have been found was missed', ok: report.discovery.missed === 0 },
    { name: 'no completion was recorded unverified', ok: !report.defects.some(defect => defect.kind === 'unverified_completion') }
  ];
}
