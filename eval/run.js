#!/usr/bin/env node
/**
 * Generalization evaluation runner.
 *
 *   npm run eval            all scenarios
 *   npm run eval -- --json  machine-readable output
 *
 * Exits non-zero when any expectation is not met, so it can gate a change.
 */

import { SCENARIOS, CATEGORY_COUNT } from './scenarios.js';
import { runFixture, checkExpectation } from './harness.js';

const asJson = process.argv.includes('--json');
const verbose = process.argv.includes('--verbose');

const results = [];
for (const scenario of SCENARIOS) {
  const { observations, outcome } = await runFixture(scenario);
  const failures = [];
  for (const phase of observations) {
    for (const failure of checkExpectation(phase.expect, phase.observed)) {
      failures.push(phase.label ? `[${phase.label}] ${failure}` : failure);
    }
  }
  // An approval fixture measures what happened *after* the approval boundary,
  // which no phase observation can see. Checked with the same comparison.
  for (const failure of checkExpectation(scenario.outcomeExpect || {}, outcome)) {
    failures.push(`[approval] ${failure}`);
  }
  const final = observations[observations.length - 1].observed;
  results.push({ scenario, failures, final, observations });
}

const passed = results.filter(result => !result.failures.length).length;
const failed = results.length - passed;

if (asJson) {
  console.log(JSON.stringify({
    total: results.length,
    passed,
    failed,
    categories: CATEGORY_COUNT,
    results: results.map(result => ({
      id: result.scenario.id,
      category: result.scenario.category,
      ok: result.failures.length === 0,
      failures: result.failures,
      observed: {
        entity: result.final.entity,
        deliverable: result.final.deliverable,
        criteria: result.final.criteria,
        complete: result.final.complete,
        status: result.final.status,
        freshness: result.final.freshness,
        withheldClaims: result.final.withheldClaims,
        outboxCount: result.final.outboxCount
      }
    }))
  }, null, 2));
} else {
  console.log(`Generalization evaluation — ${results.length} scenarios across ${CATEGORY_COUNT} categories\n`);
  let currentCategory = null;
  for (const { scenario, failures, final } of results) {
    if (scenario.category !== currentCategory) {
      currentCategory = scenario.category;
      console.log(`\n${currentCategory}`);
    }
    const mark = failures.length ? 'FAIL' : 'pass';
    const criteria = final.criteria.map(item => `${item.id}:${item.status}`).join(', ') || '(no criteria)';
    console.log(`  [${mark}] ${scenario.id}`);
    console.log(`         entity=${final.entity ?? '-'} deliverable=${final.deliverable ?? '-'} complete=${final.complete} status=${final.status ?? '-'} freshness=${final.freshness ?? '-'} outbox=${final.outboxCount}`);
    console.log(`         criteria: ${criteria}`);
    if (verbose || failures.length) console.log(`         why: ${scenario.why}`);
    for (const failure of failures) console.log(`         ! ${failure}`);
  }
  console.log(`\n${passed}/${results.length} scenarios met every expectation.`);
  if (failed) console.log(`${failed} scenario(s) did not.`);
}

process.exitCode = failed ? 1 : 0;
