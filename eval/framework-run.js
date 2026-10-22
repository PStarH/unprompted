#!/usr/bin/env node
/**
 * Framework evaluation runner.
 *
 *   npm run eval:framework            human-readable report
 *   npm run eval:framework -- --json  machine-readable output
 *
 * Exits non-zero when a framework invariant is violated, so it can gate a
 * change the same way `npm run eval` does.
 */

import { evaluateFramework, frameworkInvariants } from './framework.js';

const asJson = process.argv.includes('--json');
const report = await evaluateFramework();
const invariants = frameworkInvariants(report);
const broken = invariants.filter(item => !item.ok);

if (asJson) {
  console.log(JSON.stringify({ ...report, invariants }, null, 2));
} else {
  const pct = value => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
  console.log(`Framework evaluation — ${report.runs.length} runs\n`);

  console.log('Correctness (labels come from each fixture\'s own expectation)');
  console.log(`  labelled outcomes      ${report.correctness.labeled} (accuracy ${pct(report.correctness.accuracy)})`);
  console.log(`  correct completion     ${report.completion.truePositive} true positive, ${report.completion.falseNegative} false negative → ${pct(report.correctness.correctCompletionRate)}`);
  console.log(`  withheld completion    ${report.completion.trueNegative} true negative, ${report.completion.falsePositive} false positive → precision ${pct(report.correctness.completionPrecision)}`);
  console.log(`  discovery              ${report.discovery.found}/${report.discovery.expected} found, ${report.discovery.missed} missed, ${report.discovery.spurious} spurious`);

  console.log('\nExternal actions (无效行动)');
  console.log(`  before approval ${report.actions.takenWithoutApproval} (expected ${report.actions.expected}) → ${report.actions.invalid} invalid, ${report.actions.missed} missed`);
  console.log(`  through approval ${report.actions.approvedAndExecuted} → ${report.actions.approvedAndVerified} verified`);

  console.log('\nAttention (打扰)');
  console.log(`  interruptions ${report.interruptions.total}, takeovers ${report.interruptions.takeovers}, open on finished work ${report.interruptions.openOnFinishedWork}`);
  console.log(`  eligibility: ${report.interruptions.eligibleRuns} run(s) could have warranted a decision, ${report.interruptions.observedRuns} produced one`);
  const kinds = Object.entries(report.interruptions.byKind);
  if (kinds.length) console.log(`  by kind: ${kinds.map(([kind, count]) => `${kind}=${count}`).join(', ')}`);

  console.log('\nResources (资源消耗, summed over all runs)');
  console.log(`  events ${report.resources.events}, documents ${report.resources.documents}, probes ${report.resources.probes}, model calls ${report.resources.modelCalls}, trace entries ${report.resources.traceEntries}`);

  console.log('\nInvariants');
  for (const item of invariants) console.log(`  [${item.ok ? 'ok' : 'BROKEN'}] ${item.name}`);

  if (report.notes.length) {
    console.log('\nCoverage');
    for (const note of report.notes) console.log(`  - ${note}`);
  }

  if (report.defects.length) {
    console.log('\nDefects');
    for (const defect of report.defects) console.log(`  ! ${defect.id}: ${defect.kind} — ${defect.detail}`);
  }
}

process.exitCode = broken.length ? 1 : 0;
