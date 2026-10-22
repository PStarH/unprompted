import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';

/**
 * Negative-path matrix for permissions and decision notifications.
 *
 * Positive tests show the system can act; these actively construct illegal,
 * unauthorised or out-of-state calls and require each one to be refused with a
 * reason. Every refusal is asserted together with the absence of side effects:
 * a refusal that still changes state is not a refusal.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-refusals-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = (id = 'm1') => ({
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

/** Everything a refusal must leave untouched. */
function invariant(store) {
  return {
    revision: store.state.revision,
    tasks: JSON.stringify(store.state.tasks),
    outbox: store.state.outbox.length,
    events: store.state.events.length,
    notifications: JSON.stringify(store.state.notifications),
    history: store.state.history.length
  };
}

test('unknown ids are refused and change nothing', () => {
  const { engine, store } = setup();
  const before = invariant(store);
  assert.throws(() => engine.approve('request:nope'), /Unknown task/);
  assert.throws(() => engine.reject('request:nope'), /Unknown task/);
  assert.throws(() => engine.retry('request:nope'), /Unknown task/);
  assert.throws(() => engine.reconcile('request:nope'), /Unknown task/);
  assert.throws(() => engine.cancel('request:nope'), /Unknown task/);
  assert.throws(() => engine.acceptOpportunity('opportunity:nope'), /Unknown opportunity/);
  assert.throws(() => engine.dismissOpportunity('opportunity:nope'), /Unknown opportunity/);
  assert.throws(() => engine.answerClarification('clarification:nope', 'allow'), /Unknown clarification/);
  assert.deepEqual(invariant(store), before);
});

test('a waiting request refuses every decision except being answered or closed', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  assert.equal(store.state.tasks['request:m1'].status, 'waiting_for_information');
  const before = invariant(store);
  assert.throws(() => engine.approve('request:m1'), /not ready/i);
  assert.throws(() => engine.reject('request:m1'), /not awaiting approval/i);
  assert.throws(() => engine.retry('request:m1'), /confirmed absence/i);
  assert.throws(() => engine.reconcile('request:m1'), /No approved action/);
  assert.deepEqual(invariant(store), before);
  assert.equal(store.state.outbox.length, 0);
});

test('a prepared request refuses retry, reconcile and cancel until an action is its subject', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  const before = invariant(store);
  assert.throws(() => engine.retry('request:m1'), /confirmed absence/i, 'no approved action exists yet');
  assert.throws(() => engine.reconcile('request:m1'), /No approved action/);
  assert.throws(() => engine.cancel('request:m1'), /waiting/i, 'a prepared request is decided, not closed');
  assert.deepEqual(invariant(store), before);

  engine.approve('request:m1');
  assert.equal(store.state.tasks['request:m1'].status, 'completed');
  const afterCompletion = invariant(store);
  assert.throws(() => engine.approve('request:m1'), /not ready/i, 'a completed request cannot be approved again');
  assert.throws(() => engine.retry('request:m1'), /confirmed absence/i, 'a verified send is not retryable');
  assert.throws(() => engine.cancel('request:m1'), /waiting/i);
  assert.deepEqual(invariant(store), afterCompletion);
  assert.equal(store.state.outbox.length, 1, 'the refusals sent nothing further');
});

test('a cancelled request is inert to every further decision', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.cancel('request:m1');
  const before = invariant(store);
  assert.throws(() => engine.approve('request:m1'), /not ready/i);
  assert.throws(() => engine.reject('request:m1'), /not awaiting approval/i);
  assert.throws(() => engine.retry('request:m1'), /confirmed absence/i);
  assert.throws(() => engine.reconcile('request:m1'), /No approved action/);
  assert.throws(() => engine.cancel('request:m1'), /waiting/i, 'closing is final');
  engine.ingest(doc());
  assert.equal(store.state.tasks['request:m1'].status, 'cancelled');
  const after = invariant(store);
  assert.equal(after.outbox, before.outbox);
  assert.equal(after.tasks, before.tasks, 'evidence arriving changed nothing about the task');
});

test('an answered question cannot be answered twice', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(email('m2'));
  const clarification = engine.publicState().clarifications[0];
  assert.ok(clarification, 'the repeated flow raised exactly one question');
  engine.answerClarification(clarification.id, 'allow');
  assert.throws(() => engine.answerClarification(clarification.id, 'allow'), /no longer open/);
});

test('illegal events are refused before they touch state', () => {
  const { engine, store } = setup();
  const before = invariant(store);
  assert.throws(() => engine.ingest({ id: 'event-nope', type: 'nope', payload: {} }), /Invalid event type/);
  assert.throws(() => engine.ingest({ id: 'event-bad', type: 'document.modified', payload: { id: 'x' } }), /missing/i);
  assert.throws(() => engine.ingest({ id: 'event-bad-2', type: 'email.received', payload: { id: 'm9' } }), /missing/i);
  assert.deepEqual(invariant(store), before);
  assert.equal(store.state.events.length, 0);
});
