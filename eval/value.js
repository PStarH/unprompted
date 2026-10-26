#!/usr/bin/env node
/**
 * Product-value evaluation.
 *
 *   npm run eval:value            aggregate report over every scenario
 *   npm run eval:value -- --json  machine-readable output
 *
 * The generalization suite asks "did the system decide correctly?". This runner
 * reports scripted workflow activity and quality proxies: how much discovered work was
 * valuable, how much was noise, how often a completion was independently
 * verified, how often the user was interrupted, how much follow-through was
 * absorbed, and how often the user had to take over.
 *
 * These fixtures do not establish real-user value. One invariant is enforced, because it
 * is a correctness guarantee rather than a target: a task must never be counted
 * complete without a verified result. The run fails if that is ever violated.
 */

import { SCENARIOS, CATEGORY_COUNT } from './scenarios.js';
import { runFixture } from './harness.js';
import { describeMetrics } from '../src/metrics.js';

const asJson = process.argv.includes('--json');

const perScenario = [];
for (const scenario of SCENARIOS) {
  // `approve: true` drives the whole loop — discovery, preparation, approval and
  // verification — so completion is measured, not assumed. Opportunities are
  // read from the pre-approval snapshot: approving resolves proposals whose
  // condition the completed work removed, which would undercount them (D6).
  const { metrics, metricsBeforeApproval, outcome } = await runFixture({ ...scenario, approve: true });
  perScenario.push({ id: scenario.id, category: scenario.category, metrics, metricsBeforeApproval, outcome });
}

const sum = pick => perScenario.reduce((total, entry) => total + pick(entry.metrics), 0);
const sumEntry = pick => perScenario.reduce((total, entry) => total + pick(entry), 0);
const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 1000) / 1000 : null);

const totals = {
  scenarios: perScenario.length,
  categories: CATEGORY_COUNT,
  discovered: sum(m => m.discovery.discovered),
  valuable: sum(m => m.discovery.valuable),
  unservable: sum(m => m.discovery.unservable),
  waiting: sum(m => m.discovery.waiting),
  closed: sum(m => m.discovery.closed),
  preparedActions: sum(m => m.completion.preparedActions),
  verifiedCompletions: sum(m => m.completion.verifiedCompletions),
  unverifiedCompletions: sum(m => m.completion.unverifiedCompletions),
  withheldClaims: sum(m => m.completion.withheldClaims),
  interruptions: sum(m => m.attention.interruptions),
  unresolved: sum(m => m.attention.unresolved),
  takeovers: sum(m => m.attention.takeovers),
  opportunitiesProposed: sumEntry(m => m.metricsBeforeApproval.opportunities.proposed),
  opportunitiesAccepted: sumEntry(m => m.metricsBeforeApproval.opportunities.accepted),
  opportunitiesParked: sumEntry(m => m.metricsBeforeApproval.opportunities.parked),
  opportunitiesResolvedByApproval: sumEntry(m => Math.max(0, m.metricsBeforeApproval.opportunities.proposed - m.metrics.opportunities.proposed)),
  // The gate is derived independently of src/metrics.js: receipts live in the
  // outbox, so a corrupted metrics predicate cannot silence it (D8).
  verifiedByReceipt: sumEntry(m => m.outcome.verifiedByReceipt),
  unverifiedByReceipt: sumEntry(m => m.outcome.unverifiedByReceipt),
  reviewed: sum(m => m.review.reviewed),
  unreviewed: sum(m => m.review.unreviewed),
  labelledUseful: sum(m => m.review.useful),
  labelledNoise: sum(m => m.review.noise),
  labelledAwaiting: sum(m => m.review.awaitingEvidence),
  realEvents: sum(m => m.events.real),
  syncFailures: sum(m => m.sync.failures)
};
totals.valuableRate = rate(totals.valuable, totals.discovered);
totals.unservableRate = rate(totals.unservable, totals.discovered);
totals.verifiableCompletionRate = rate(totals.verifiedCompletions, totals.preparedActions);

const violated = totals.unverifiedCompletions !== 0
  || totals.unverifiedByReceipt !== 0
  || totals.verifiedCompletions !== totals.verifiedByReceipt;

if (asJson) {
  console.log(JSON.stringify({ kind: 'scripted-workflow-outcomes', evidenceScope: 'synthetic', realUserValue: 'not_measured', totals, scenarios: perScenario }, null, 2));
} else {
  console.log(`Scripted workflow outcome evaluation — ${totals.scenarios} scenarios across ${totals.categories} categories\n`);
  console.log('  evidence scope:         synthetic; real-user value is not measured\n');
  console.log(`  discovered work:        ${totals.discovered}`);
  console.log(`  ├─ prepared/verified activity proxy: ${totals.valuable} (${pct(totals.valuableRate)})`);
  console.log(`  ├─ unservable (automatic proxy, not a user label): ${totals.unservable} (${pct(totals.unservableRate)})`);
  console.log(`  ├─ awaiting evidence:   ${totals.waiting}`);
  console.log(`  └─ closed by user:      ${totals.closed}`);
  console.log(`\n  taxonomy (from src/metrics.js):`);
  console.log(`    legacy valuable   = prepared or verified activity; not user-recognized value`);
  console.log(`    unservable        = automatic proxy: no correlated document and no probe for the requested content`);
  console.log(`    awaiting evidence = a real discovery still missing evidence; filtered, not counted as noise`);
  console.log(`    closed            = the user ended a waiting request; neither noise nor unfinished work`);
  console.log(`    user noise        = a discovery the user labelled noise; missing evidence is not noise`);
  console.log(`  user labels:            reviewed ${totals.reviewed} · unreviewed ${totals.unreviewed} · useful ${totals.labelledUseful} · noise ${totals.labelledNoise} · awaiting evidence ${totals.labelledAwaiting}`);
  console.log(`  real events ingested:   ${totals.realEvents} · sync failures ${totals.syncFailures}`);
  console.log(`  note:                   these fixtures are simulated. User-label counts above are not a live noise rate.`);
  console.log(`  prepared actions:       ${totals.preparedActions}`);
  console.log(`  verified completions:   ${totals.verifiedCompletions} (${pct(totals.verifiableCompletionRate)} of prepared)`);
  console.log(`  unverified completions: ${totals.unverifiedCompletions}${violated ? '  ← VIOLATION' : ''}`);
  console.log(`  receipt-backed gate:    ${totals.verifiedByReceipt}/${totals.verifiedCompletions} matched · ${totals.unverifiedByReceipt} without a receipt`);
  console.log(`  withheld claims:        ${totals.withheldClaims} (unsupported statements never sent)`);
  console.log(`  interruptions:          ${totals.interruptions} (${totals.unresolved} still open)`);
  console.log(`  user takeovers:         ${totals.takeovers}`);
  console.log(`  opportunities:          proposed ${totals.opportunitiesProposed} · accepted ${totals.opportunitiesAccepted} · parked ${totals.opportunitiesParked} · resolved by the approval pass ${totals.opportunitiesResolvedByApproval}`);
  console.log(`\n  worst-case per scenario:`);
  for (const entry of perScenario.filter(item => item.metrics.attention.interruptions > 0 || item.metrics.discovery.unservable > 0)) {
    const proposedBefore = entry.metricsBeforeApproval.opportunities.proposed;
    const note = proposedBefore > entry.metrics.opportunities.proposed
      ? ` · raised before the approval pass: ${proposedBefore}`
      : '';
    console.log(`    ${entry.id}: ${describeMetrics(entry.metrics).join(' · ')}${note}`);
  }
  console.log(violated
    ? '\nFAIL: a completion was counted without a verified, receipt-backed result.'
    : '\nEvery completion was independently verified against outbox receipts. Metrics above are measurements, not targets.');
}

process.exitCode = violated ? 1 : 0;

function pct(value) { return value == null ? 'n/a' : `${Math.round(value * 100)}%`; }
