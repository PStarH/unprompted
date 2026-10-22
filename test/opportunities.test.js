import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { OPPORTUNITY_SIGNALS, decideOpportunity, evaluateOpportunities, mergeOpportunities } from '../src/opportunities.js';

/**
 * Evidence-backed opportunity discovery.
 *
 * The point of these tests is that the system does *not* act on good ideas: it
 * explores cheaply, stops when the evidence does not support the cost, and can
 * only ever put a suggestion in front of the user.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-opportunity-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = id => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  }
});
const doc = () => ({
  id: 'event-doc', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  }
});
const run = () => ({
  id: 'event-run', type: 'experiment.run.completed', payload: {
    id: 'northstar-run-2026-10-16', label: 'Northstar run 2026-10-16', subjectEntity: 'Northstar',
    completedAt: '2026-10-16T12:00:00.000Z', source: { kind: 'run_registry', id: 'test-registry' }
  }
});

const gapTask = (id, entity) => ({
  id, status: 'waiting_for_information', createdAt: '2026-10-16T09:00:00.000Z', documentId: 'd1',
  request: { subjectEntity: entity, deliverable: 'report', intent: 'update_and_send' },
  assessment: { freshness: { status: 'unverified' } },
  evidence: { unknowns: [{ id: 'freshness_source_of_truth', question: 'Are these the latest?', reason: 'No registry.' }], plan: { unverifiable: [] } }
});

test('the decision rule weighs benefit, cost and risk together', () => {
  const base = { benefit: 'medium', verificationCost: 'low', risk: 'low', exploration: { verdict: 'supported', basis: [] } };
  assert.equal(decideOpportunity(base).status, 'proposed');
  assert.equal(decideOpportunity({ ...base, exploration: { verdict: 'resolved' } }).status, 'resolved');
  assert.equal(decideOpportunity({ ...base, exploration: { verdict: 'inconclusive' } }).status, 'parked');
  assert.equal(decideOpportunity({ ...base, benefit: 'low', verificationCost: 'medium' }).status, 'parked', 'a weak benefit that costs more to verify is parked');
  // A high-risk next step is never suggested, however good the ratio looks.
  const risky = decideOpportunity({ ...base, benefit: 'high', verificationCost: 'low', risk: 'high' });
  assert.equal(risky.status, 'parked');
  assert.match(risky.reason, /risk/i);
  assert.equal(decideOpportunity({ ...base, risk: 'medium' }).status, 'proposed', 'a moderate risk with a supported exploration may still be suggested');
});

test('a gap must recur before it becomes an opportunity', () => {
  const single = evaluateOpportunities({ tasks: { a: gapTask('a', 'Northstar') }, documents: {} });
  assert.equal(single.length, 0, 'one affected request is not yet worth widening anything');

  const repeated = evaluateOpportunities({
    tasks: { a: gapTask('a', 'Northstar'), b: gapTask('b', 'Northstar') }, documents: {}
  });
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].kind, 'verify_freshness');
  assert.equal(repeated[0].status, 'proposed');
});

test('only a run record for the affected entity resolves a freshness gap', () => {
  const tasks = { a: gapTask('a', 'Northstar'), b: gapTask('b', 'Northstar') };
  const unrelated = evaluateOpportunities({
    tasks, documents: {},
    runRecords: { r1: { id: 'r1', subjectEntity: 'Helios', completedAt: '2026-10-16T12:00:00.000Z' } }
  });
  assert.equal(unrelated[0].status, 'proposed', 'an unrelated run elsewhere is not a Northstar source of truth');

  const relevant = evaluateOpportunities({
    tasks, documents: {},
    runRecords: { r1: { id: 'r1', subjectEntity: 'Northstar', completedAt: '2026-10-16T12:00:00.000Z' } }
  });
  assert.equal(relevant[0].status, 'resolved', 'a run for the entity closes the gap');
});

test('a blocking gap may be judged on a single occurrence, unlike a degrading one', () => {
  const blockedTask = {
    id: 'a', status: 'waiting_for_information', createdAt: '2026-10-16T09:00:00.000Z',
    request: { subjectEntity: 'Northstar', deliverable: 'proposal', intent: 'update_and_send' },
    assessment: {},
    evidence: {
      criteria: [{ label: 'sales figures', status: 'blocked', probe: { provider: 'salesforce' }, note: 'The "salesforce" provider is registered but not reachable.' }],
      unknowns: [], plan: { unverifiable: [] }
    }
  };
  const decided = evaluateOpportunities({ tasks: { a: blockedTask }, documents: {} });
  assert.equal(decided.length, 1);
  assert.equal(decided[0].kind, 'connect_evidence_source');
  assert.equal(decided[0].status, 'proposed', 'an unavailable registered provider blocks work now, so one occurrence is a decision due now');
  assert.equal(decided[0].risk, 'low');
});

test('signals are declarative and new ones reuse the same gate unchanged', () => {
  for (const signal of OPPORTUNITY_SIGNALS) {
    assert.ok(signal.id && signal.kind && signal.rationale, 'every signal explains itself');
    assert.ok(signal.minOccurrences >= 1);
    assert.equal(typeof signal.collect, 'function');
    if (!signal.blocking) assert.ok(signal.minOccurrences >= 2, 'a non-blocking gap must recur before it is judged');
  }
  const candidate = now => ({
    id: 'opportunity:auto_triage:inbox', kind: 'auto_triage', statement: 'Triage the shared inbox automatically.',
    evidence: [], exploration: { verdict: 'supported', basis: [] }, firstSeenAt: now, updatedAt: now
  });
  const custom = {
    id: 'auto_triage', kind: 'auto_triage', blocking: true, minOccurrences: 1, rationale: 'test signal',
    collect: (state, now) => [{ ...candidate(now), benefit: 'high', verificationCost: 'low', risk: 'high' }]
  };
  const [parked] = evaluateOpportunities({ tasks: {} }, { signals: [custom] });
  assert.equal(parked.status, 'parked', 'the shared gate applies to any signal, including its risk dimension');
  const safe = { ...custom, collect: (state, now) => [{ ...candidate(now), benefit: 'high', verificationCost: 'low', risk: 'low' }] };
  const [proposed] = evaluateOpportunities({ tasks: {} }, { signals: [safe] });
  assert.equal(proposed.status, 'proposed');
});

test('a user decision is preserved and a vanished opportunity is resolved', () => {
  const stored = { 'opportunity:x': { id: 'opportunity:x', status: 'dismissed', decidedAt: '2026-10-16T10:00:00.000Z', firstSeenAt: '2026-10-16T09:00:00.000Z' } };
  const evaluated = [{ id: 'opportunity:x', status: 'proposed', benefit: 'high', verificationCost: 'low', exploration: { verdict: 'supported', basis: [] } }];
  const merged = mergeOpportunities(stored, evaluated);
  assert.equal(merged['opportunity:x'].status, 'dismissed', 'the scanner never resurrects a dismissed suggestion');

  const stale = mergeOpportunities({ 'opportunity:y': { id: 'opportunity:y', status: 'proposed' } }, []);
  assert.equal(stale['opportunity:y'].status, 'resolved');
});

test('a recurring withheld claim becomes one evidence-backed suggestion, and nothing is sent', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  engine.ingest(email('m2'));

  const opportunity = Object.values(store.state.opportunities).find(item => item.kind === 'verify_freshness');
  assert.ok(opportunity, 'the repeated gap produces an opportunity');
  assert.equal(opportunity.status, 'proposed');
  assert.ok(opportunity.evidence.length >= 2, 'the suggestion cites the requests it came from');
  assert.ok(opportunity.exploration.basis.length > 0, 'the exploration measured something before proposing');
  const notification = engine.publicState().notifications.find(item => item.kind === 'opportunity');
  assert.ok(notification, 'a proposed opportunity reaches the user as a decision');
  assert.match(notification.nextStep || '', /Connect the Northstar run registry/, 'the decision card carries the actual next step');
  assert.equal(store.state.outbox.length, 0);
});

test('accepting a suggestion records a decision and starts no work', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  engine.ingest(email('m2'));
  const id = 'opportunity:verify_freshness:Northstar';
  assert.equal(store.state.opportunities[id].status, 'proposed');

  const tasksBefore = Object.keys(store.state.tasks).length;
  engine.acceptOpportunity(id);
  assert.equal(store.state.opportunities[id].status, 'accepted');
  assert.ok(store.state.opportunities[id].decidedAt);
  assert.equal(Object.keys(store.state.tasks).length, tasksBefore, 'an opportunity is never a stealth project');
  assert.equal(store.state.outbox.length, 0, 'an opportunity never sends anything');
  assert.ok(store.state.history.some(item => item.kind === 'opportunity_accepted'));
});

test('dismissing a suggestion is recorded and not re-raised while the gap remains', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  engine.ingest(email('m2'));
  const id = 'opportunity:verify_freshness:Northstar';
  engine.dismissOpportunity(id, 'not worth it');
  assert.equal(store.state.opportunities[id].status, 'dismissed');
  assert.equal(store.state.opportunities[id].decisionNote, 'not worth it');
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'opportunity').length, 0, 'a dismissed suggestion stops being raised');
});

test('new evidence that closes the gap resolves the opportunity', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  engine.ingest(email('m2'));
  const id = 'opportunity:verify_freshness:Northstar';
  assert.equal(store.state.opportunities[id].status, 'proposed');
  engine.ingest(run());
  assert.equal(store.state.tasks['request:m1'].assessment.freshness.status, 'verified');
  assert.equal(store.state.opportunities[id].status, 'resolved', 'the condition that produced it is gone');
});
