import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';

/**
 * A request that stops making progress must reach the user exactly once.
 *
 * The failure mode this prevents is silent indefinite waiting — work that
 * "disappears" because no event ever arrives again. The tests pin the whole
 * decision: it is raised only after real stagnation, offered once, withdrawn the
 * moment evidence moves, and it never stacks on top of a stronger decision.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-stall-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  const store = new JsonStore(filename);
  return { filename, store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store), ...options }) };
}

const email = id => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal.'
  }
});
const doc = () => ({
  id: 'event-doc', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  }
});
const deadlineEmail = id => {
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  return {
    id: `event-email-${id}`, type: 'email.received', payload: {
      id, from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
      body: `Please update the Northstar project proposal with the latest experiment results and send the revised proposal by ${date}.`
    }
  };
};
const stallOf = store => store.state.notifications.find(item => String(item.dedupeKey || '').startsWith('stalled:'));
const openBlockers = engine => engine.publicState().notifications.filter(item => item.kind === 'blocker');

test('a request with no movement becomes one user decision, offered once', () => {
  const { engine, store } = setup({ stallAfterMs: 0 });
  engine.ingest(email('m1'));
  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'waiting_for_information');
  assert.ok(task.progress?.at, 'the engine tracks when evidence last moved');

  const stall = stallOf(store);
  assert.ok(stall, 'stagnation is raised as a decision, not left waiting silently');
  assert.equal(stall.kind, 'blocker');
  assert.equal(stall.priority, 'normal');
  assert.equal(stall.taskId, 'request:m1');
  assert.equal(stall.resolvedAt, null);
  assert.deepEqual(stall.options.map(option => option.value), ['close', 'acknowledge']);
  assert.match(stall.what, /has not advanced/);
  assert.ok(stall.evidence.some(item => /not yet satisfied/i.test(item.detail)));
  assert.equal(store.state.outbox.length, 0, 'the decision itself sends nothing');

  assert.equal(engine.sweepAttention(), false, 'an already-raised stall is not raised again');
  assert.equal(store.state.notifications.filter(item => String(item.dedupeKey || '').startsWith('stalled:')).length, 1);
});

test('the stall window is respected, and a periodic sweep is what raises it', () => {
  const { engine, store } = setup({ stallAfterMs: 60_000 });
  engine.ingest(email('m1'));
  assert.equal(engine.sweepAttention(), false, 'not stagnant yet');
  assert.equal(stallOf(store), undefined);

  // Move the clock the way real time would: backdate the progress marker.
  store.mutate(state => { state.tasks['request:m1'].progress.at = new Date(Date.now() - 120_000).toISOString(); });
  assert.equal(engine.sweepAttention(), true, 'a stall due with no new event is raised by the sweep');
  assert.ok(stallOf(store));
});

test('the stall boundary is inclusive, and the decision clock is injectable', () => {
  const { engine, store } = setup({ stallAfterMs: 60_000 });
  engine.ingest(email('m1'));
  const since = Date.parse(store.state.tasks['request:m1'].progress.at);
  assert.ok(Number.isFinite(since), 'progress timestamps are persisted, so tests control the clock through state');
  assert.equal(engine.sweepAttention(new Date(since + 59_999)), false, 'one millisecond before the window nothing is raised');
  assert.equal(engine.sweepAttention(new Date(since + 60_000)), true, 'exactly at the window the stall is due');
  assert.ok(stallOf(store));
});

test('evidence arriving withdraws the decision immediately', () => {
  const { engine, store } = setup({ stallAfterMs: 0 });
  engine.ingest(email('m1'));
  const stall = stallOf(store);
  assert.ok(stall);
  engine.ingest(doc());
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.ok(stall.resolvedAt, 'the decision is withdrawn the moment the evidence moves');
  assert.equal(openBlockers(engine).length, 0);
});

test('a stronger open decision suppresses the weaker interruption', () => {
  const { engine, store } = setup({ stallAfterMs: 0 });
  engine.ingest(deadlineEmail('m1'));
  assert.ok(store.state.notifications.some(item => item.kind === 'deadline' && !item.resolvedAt), 'the deadline decision is open');
  assert.equal(stallOf(store), undefined, 'a second interruption about the same request would be noise');
  assert.equal(engine.sweepAttention(), false, 'the user already has the stronger decision in front of them');
});

test('closing a stalled request is final: nothing sends, and later evidence does not resurrect it', () => {
  const { engine, store } = setup({ stallAfterMs: 0 });
  engine.ingest(email('m1'));
  const closed = engine.cancel('request:m1');
  assert.equal(closed.status, 'cancelled');
  assert.equal(closed.draft, null);
  assert.ok(closed.reason);
  assert.equal(store.state.outbox.length, 0);
  assert.ok(store.state.history.some(item => item.kind === 'cancellation'));
  assert.equal(openBlockers(engine).length, 0, 'closing the request withdraws its decision');

  const result = engine.ingest(doc());
  assert.equal(store.state.tasks['request:m1'].status, 'cancelled', 'a closed request is inert to new evidence');
  assert.deepEqual(result.relations, []);
  assert.equal(result.disposition, 'unrelated_change', 'the closed request is no longer outstanding');
  assert.equal(store.state.outbox.length, 0);
});

test('a closed request stays closed across restart, sweeps and event replay', () => {
  const { engine, store, filename } = setup({ stallAfterMs: 0 });
  engine.ingest(email('m1'));
  engine.cancel('request:m1');

  // Restart: recovery must not reassess, re-raise or otherwise resurrect it.
  const restored = new JsonStore(filename);
  const after = new WorkEngine(restored, { provider: new SimulatedMailProvider(restored), stallAfterMs: 0 });
  assert.equal(restored.state.tasks['request:m1'].status, 'cancelled');
  assert.equal(after.sweepAttention(), false, 'the sweep skips a closed request');
  assert.equal(restored.state.notifications.filter(item => item.kind === 'blocker' && !item.resolvedAt).length, 0);

  // Replay: the original event is a duplicate; new evidence is unrelated to a closed request.
  assert.equal(after.ingest(email('m1')).duplicate, true);
  assert.equal(after.ingest(doc()).disposition, 'unrelated_change');
  assert.equal(restored.state.tasks['request:m1'].status, 'cancelled');
  assert.equal(restored.state.outbox.length, 0);
});

test('illegal transitions are refused rather than guessed', () => {
  const { engine, store } = setup({ stallAfterMs: 0 });
  engine.ingest(email('m1'));
  assert.throws(() => engine.cancel('nope'), /Unknown task/);
  assert.throws(() => engine.approve('request:m1'), /not ready/i, 'a waiting request cannot be approved');

  engine.ingest(doc());
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.throws(() => engine.cancel('request:m1'), /waiting/i, 'a prepared request is decided, not closed');
  engine.reject('request:m1');
  assert.equal(store.state.tasks['request:m1'].status, 'blocked');
  assert.throws(() => engine.cancel('request:m1'), /waiting/i, 'a blocked task is reconciled, not closed');
});
