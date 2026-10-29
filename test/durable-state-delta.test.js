import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';

const message = (id, body, from = 'supplier@example.test') => ({ id: `event:${id}`, type: 'email.received', at: '2026-10-26T10:00:00.000Z', payload: { id, threadId: 'quote-thread', from, to: 'reader@example.test', subject: 'Supplier quotation', body } });
const result = (polarity, quote, patch = {}) => ({ associated: true, polarity, confidence: 0.95, evidenceRefs: [{ field: 'body', quote }], stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [], ...patch } });
async function fixture(t, extract) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-delta-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const reasoner = Object.assign(new NullReasoner(), { available: () => true, extractSituationDelta: extract });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  engine.ingest(message('seed', 'The quotation is under discussion.')); await engine.whenSettled();
  const situation = store.tasks.situations.create({ kind: 'related_observations', summary: 'Supplier quotation', sourceEventIds: ['event:seed'], closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: ['Delivery date'] } });
  return { store, engine, runtime, situation };
}

async function taskFixture(t, extract) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-task-delta-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const reasoner = Object.assign(new NullReasoner(), { available: () => true, extractSituationDelta: extract });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  engine.ingest(message('request', 'Please update the Cedar proposal and send it by Friday.')); await engine.whenSettled();
  const task = store.tasks.get('request:request');
  assert.ok(task?.situationId);
  return { store, engine, runtime, task };
}

test('a same-thread update runs grounded extraction before changing its Situation', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = await fixture(t, () => new Promise(resolve => { release = () => resolve(result('ADVANCE', 'by 2026-11-18', { deadlineUpdates: [{ field: 'body', quote: 'by 2026-11-18' }] })); started(); }));
  assert.equal(env.engine.ingest(message('reply', 'The revised deadline is by 2026-11-18.')).disposition, 'state_delta_pending');
  await entered;
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).closureCondition.deadlineUpdates, undefined);
  assert.equal(Object.keys(env.store.state.tasks).length, 0);
  release(); await env.runtime.whenIdle();
  const situation = env.runtime.tasks.situations.get(env.situation.id);
  assert.equal(situation.closureCondition.deadlineUpdates[0].iso, '2026-11-18');
  assert.equal(env.store.db.prepare('SELECT outcome FROM activation_decisions WHERE stage=?').get('state_delta').outcome, 'ADVANCE');
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
});

test('a grounded trusted cancellation closes the Situation before forward activation', async t => {
  const env = await fixture(t, async () => result('CANCEL', 'We will not proceed.'));
  env.engine.ingest(message('cancel', 'We will not proceed.')); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).lifecycle_state, 'CANCELLED');
  assert.equal(Object.keys(env.store.state.tasks).length, 0);
});

test('a grounded cancellation reaches the existing task after association and before forward work', async t => {
  const env = await taskFixture(t, async () => result('CANCEL', 'We will not proceed.'));
  env.runtime.policies.save({ instruction: 'Suppress new work', predicate: { op: 'always' }, effect: { type: 'suppress' } });
  assert.equal(env.engine.ingest(message('cancel', 'We will not proceed.')).disposition, 'state_delta_pending');
  await env.runtime.whenIdle();
  assert.equal(env.store.tasks.get(env.task.id).status, 'cancelled');
  assert.equal(env.runtime.tasks.situations.get(env.task.situationId).lifecycle_state, 'CANCELLED');
  assert.equal(env.store.state.events.find(event => event.id === 'event:cancel').disposition, 'request_withdrawn');
  assert.equal(env.store.state.outbox.length, 0);
});

test('new evidence fences approvals while state interpretation is in flight', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = await taskFixture(t, () => new Promise(resolve => { release = () => resolve(result('CANCEL', 'We will not proceed.')); started(); }));
  const originalVersion = env.store.tasks.get(env.task.id).inputVersion;
  env.engine.ingest(message('pending', 'We will not proceed.')); await entered;
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), true);
  assert.ok(env.store.tasks.get(env.task.id).inputVersion > originalVersion);
  assert.throws(() => env.engine.approve(env.task.id), { code: 'REVIEW_REQUIRED' });
  assert.throws(() => env.engine.executePreAuthorized(env.task.id), { code: 'REVIEW_REQUIRED' });
  release(); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), false);
  assert.equal(env.store.tasks.get(env.task.id).status, 'cancelled');
});

test('recovery applies a committed interpretation before releasing its task fence', async t => {
  let calls = 0;
  const env = await taskFixture(t, async () => { calls++; return result('CANCEL', 'We will not proceed.'); });
  const ingest = env.engine.ingestLegacy.bind(env.engine); let fail = true;
  env.engine.ingestLegacy = (...args) => { if (fail) { fail = false; throw Object.assign(new Error('interrupted'), { status: 503 }); } return ingest(...args); };
  env.engine.ingest(message('retry', 'We will not proceed.')); await env.runtime.whenIdle();
  const job = env.store.db.prepare("SELECT * FROM jobs WHERE job_type='situation_delta'").get();
  assert.equal(job.state, 'retry_wait');
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), true);
  assert.equal(env.store.state.events.some(event => event.id === 'event:retry'), false);
  env.store.database.atomic(() => env.store.db.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), job.id));
  env.runtime.kick(); await env.runtime.whenIdle();
  assert.equal(calls, 1);
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), false);
  assert.equal(env.store.tasks.get(env.task.id).status, 'cancelled');
});

test('a Situation change during interpretation discards the stale result and keeps the task fenced', async t => {
  let release, started, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const env = await taskFixture(t, () => {
    if (++calls === 1) return new Promise(resolve => { release = () => resolve(result('NEUTRAL', 'The terms are being reviewed.')); started(); });
    return Promise.resolve(result('NEUTRAL', 'The terms are being reviewed.'));
  });
  env.engine.ingest(message('changed', 'The terms are being reviewed.')); await entered;
  env.store.database.atomic(() => env.runtime.tasks.situations.bump(env.task.situationId));
  release(); await env.runtime.whenIdle();
  const job = env.store.db.prepare("SELECT * FROM jobs WHERE job_type='situation_delta'").get();
  assert.equal(job.state, 'retry_wait');
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), true);
  assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='state_delta'").get().n, 0);
  env.store.database.atomic(() => env.store.db.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), job.id));
  env.runtime.kick(); await env.runtime.whenIdle();
  assert.equal(calls, 2);
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), false);
  assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'NEUTRAL');
});

test('a same-thread deadline change is extracted and then applied to the existing task', async t => {
  const quote = 'deadline moved to 2026-11-18';
  const env = await taskFixture(t, async () => result('ADVANCE', quote, { deadlineUpdates: [{ field: 'body', quote }] }));
  env.engine.ingest(message('deadline', 'The deadline moved to 2026-11-18.')); await env.runtime.whenIdle();
  assert.equal(env.store.tasks.get(env.task.id).request.deadline.iso, '2026-11-18');
  assert.equal(env.runtime.tasks.situations.get(env.task.situationId).closureCondition.deadlineUpdates[0].iso, '2026-11-18');
  assert.equal(Object.keys(env.store.state.tasks).length, 1);
});

test('an uncertain state change holds the affected task and invalidates its draft', async t => {
  const env = await taskFixture(t, async () => result('UNKNOWN', 'The scope may have changed.'));
  env.engine.ingest(message('uncertain', 'The scope may have changed.')); await env.runtime.whenIdle();
  const task = env.store.tasks.get(env.task.id);
  assert.equal(task.control.paused, true);
  assert.equal(task.guidanceReviewRequired, true);
  assert.equal(task.draft, null);
  assert.ok(env.store.db.prepare("SELECT 1 FROM task_signals WHERE task_id=? AND source_event_id=?").get(task.id, 'event:uncertain'));
});

test('a same-thread update affecting multiple active tasks is held without guessing a target', async t => {
  let calls = 0;
  const env = await taskFixture(t, async () => { calls++; return result('CANCEL', 'We will not proceed.'); });
  const other = env.store.tasks.createOrLoad({ candidateKey: 'second', situationId: env.task.situationId, dedupTaskKey: 'independent', data: { status: 'waiting_for_information' } });
  const outcome = env.engine.ingest(message('ambiguous', 'We will not proceed.'));
  await env.runtime.whenIdle();
  assert.equal(outcome.disposition, 'context_only'); assert.equal(calls, 0);
  assert.equal(env.store.tasks.get(env.task.id).control.paused, true);
  assert.equal(env.store.tasks.get(other.taskId).control.paused, true);
  assert.equal(env.runtime.tasks.situations.get(env.task.situationId).lifecycle_state, 'OPEN');
});

test('negated or untrusted cancellation is retained as uncertain', async t => {
  const env = await fixture(t, async () => result('CANCEL', 'Please do not cancel the quotation.'));
  env.engine.ingest(message('not-cancel', 'Please do not cancel the quotation.')); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).lifecycle_state, 'OBSERVING');
  assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'UNKNOWN');
});

test('conditional cancellation language cannot be promoted by the model', async t => {
  const env = await fixture(t, async () => result('CANCEL', 'will not proceed'));
  env.engine.ingest(message('conditional', 'I do not think we will not proceed.')); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).lifecycle_state, 'OBSERVING');
  assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'UNKNOWN');
});

test('an unrelated sender cannot cancel a Situation solely by sharing its thread', async t => {
  const env = await fixture(t, async () => result('CANCEL', 'We will not proceed.'));
  env.engine.ingest(message('other-sender', 'We will not proceed.', 'other@example.test')); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).lifecycle_state, 'OBSERVING');
  assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'UNKNOWN');
});

test('an older cancellation does not override a newer Situation observation', async t => {
  const env = await fixture(t, async () => result('CANCEL', 'We will not proceed.'));
  env.engine.ingest({ ...message('old-cancel', 'We will not proceed.'), at: '2026-10-25T10:00:00.000Z' }); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).lifecycle_state, 'OBSERVING');
  assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'UNKNOWN');
});

test('a later neutral update preserves an earlier grounded deadline and its source', async t => {
  const env = await fixture(t, async ({ event }) => event.body.includes('2026-11-18')
    ? result('ADVANCE', 'by 2026-11-18', { deadlineUpdates: [{ field: 'body', quote: 'by 2026-11-18' }] })
    : result('NEUTRAL', 'The terms are being reviewed.'));
  env.engine.ingest(message('deadline', 'The revised deadline is by 2026-11-18.')); await env.runtime.whenIdle();
  env.engine.ingest(message('neutral', 'The terms are being reviewed.')); await env.runtime.whenIdle();
  const deadline = env.runtime.tasks.situations.get(env.situation.id).closureCondition.deadlineUpdates[0];
  assert.equal(deadline.iso, '2026-11-18'); assert.equal(deadline.eventId, 'event:deadline');
});

test('an ungrounded deadline cannot change the Situation or create work', async t => {
  const env = await fixture(t, async () => result('ADVANCE', 'invented date', { deadlineUpdates: [{ field: 'body', quote: 'invented date' }] }));
  env.engine.ingest(message('invalid', 'The delivery terms remain open.')); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id).closureCondition.deadlineUpdates, undefined);
  assert.equal(env.store.state.events.find(event => event.id === 'event:invalid').rejection.code, 'invalid_state_delta');
  assert.equal(Object.keys(env.store.state.tasks).length, 0);
});

test('a permanent interpretation failure records the observation without activating work', async t => {
  const env = await fixture(t, async () => { throw Object.assign(new Error('provider unavailable'), { status: 403 }); });
  env.engine.ingest(message('failed', 'The delivery terms remain open.')); await env.runtime.whenIdle();
  assert.equal(env.store.state.events.find(event => event.id === 'event:failed').rejection.code, 'state_delta_failed');
  assert.equal(env.store.db.prepare("SELECT state FROM jobs WHERE job_type='situation_delta'").get().state, 'dead');
  assert.equal(Object.keys(env.store.state.tasks).length, 0);
});

test('a missing primary model holds existing work instead of interpreting a thread update as a new action', async t => {
  const env = await taskFixture(t, async () => result('NEUTRAL', 'The terms are being reviewed.'));
  env.engine.reasoner.available = () => false;
  env.engine.reasoner.preferModelInterpretation = true;
  const observation = env.engine.ingest(message('offline', 'The terms are being reviewed.'));
  assert.equal(observation.disposition, 'context_only');
  assert.equal(env.store.tasks.get(env.task.id).control.paused, true);
  assert.equal(env.store.state.events.find(event => event.id === 'event:offline').rejection.code, 'state_delta_unavailable');
});

test('superseding evidence is attached without cancelling the whole Situation', async t => {
  const env = await fixture(t, async () => result('SUPERSEDE', 'The revised quote replaces the earlier version.', { closureConditionUpdates: [{ field: 'body', quote: 'The revised quote replaces the earlier version.' }] }));
  env.engine.ingest(message('revision', 'The revised quote replaces the earlier version.')); await env.runtime.whenIdle();
  const situation = env.runtime.tasks.situations.get(env.situation.id);
  assert.equal(situation.lifecycle_state, 'OBSERVING');
  assert.equal(situation.closureCondition.closureConditionUpdates[0].eventId, 'event:revision');
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
});

test('an unrelated update returns to ordinary discovery', async t => {
  const env = await fixture(t, async () => ({ associated: false, polarity: 'UNKNOWN', confidence: 0.9, evidenceRefs: [], stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } }));
  env.engine.ingest(message('different', 'Please update the Cedar proposal and send it by Friday.')); await env.runtime.whenIdle();
  assert.ok(env.store.tasks.get('request:different'));
  assert.equal(env.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, 'UNRELATED');
});

test('forgetting an unrelated update does not erase the original task', async t => {
  const unrelated = { associated: false, polarity: 'UNKNOWN', confidence: 0.9, evidenceRefs: [], stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } };
  const env = await taskFixture(t, async () => unrelated);
  env.engine.ingest(message('different', 'The Orion report is complete.')); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.hasPendingSemantic(env.task.id), false);
  assert.equal(env.store.db.prepare("SELECT 1 FROM lineage WHERE source_kind='event' AND source_id=? AND derived_kind='task' AND derived_id=?").get('event:different', env.task.id), undefined);
  await env.runtime.privacy.forget({ kind: 'event', id: 'event:different' });
  assert.notEqual(env.store.tasks.get(env.task.id).privacyInvalidated, true);
  assert.equal(env.store.db.prepare("SELECT 1 FROM task_signals WHERE source_event_id=?").get('event:different'), undefined);
});

test('Forget during state interpretation discards its result and recovers the independent incoming Event', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = await fixture(t, () => new Promise(resolve => { release = () => resolve(result('CANCEL', 'We will not proceed.')); started(); }));
  env.engine.ingest(message('incoming', 'We will not proceed.')); await entered;
  await env.runtime.privacy.forget({ kind: 'event', id: 'event:seed' });
  release(); await env.runtime.whenIdle(); env.runtime.kick(); await env.runtime.whenIdle();
  assert.equal(env.runtime.tasks.situations.get(env.situation.id), undefined);
  assert.ok(env.store.state.events.some(event => event.id === 'event:incoming'));
  assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='state_delta'").get().n, 0);
});

test('an invalid model response cannot restore an incoming Event forgotten in flight', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const env = await fixture(t, () => new Promise(resolve => { release = () => resolve({ invalid: 'invented' }); started(); }));
  env.engine.ingest(message('incoming', 'The delivery terms remain open.')); await entered;
  await env.runtime.privacy.forget({ kind: 'event', id: 'event:incoming' });
  release(); await env.runtime.whenIdle();
  assert.equal(env.store.state.events.some(event => event.id === 'event:incoming'), false);
  assert.equal(env.store.db.prepare('SELECT 1 FROM durable_inbox WHERE id=?').get('event:incoming'), undefined);
});
