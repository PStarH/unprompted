import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { validatePairAssessment } from '../src/durable/pair-evidence.js';

const message = (id, body) => ({ id: `event:${id}`, type: 'email.received', payload: { id, threadId: 'supplier-thread', from: 'supplier@example.test', to: 'reader@example.test', subject: 'Supplier quotation', body } });
function fixture(t, assess) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pairs-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const reasoner = Object.assign(new NullReasoner(), { available: () => true, assessSituationPair: assess });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime };
}
const waitResult = events => ({ outcome: 'RELATED_WAIT', summary: 'Waiting for delivery terms.', missingEvidence: ['Delivery date'],
  reevaluationCondition: 'When delivery terms arrive.', confidence: 0.8,
  evidence: events.map(event => ({ eventId: event.id, field: 'body', quote: event.body })) });
const unrelated = () => ({ outcome: 'UNRELATED', summary: null, missingEvidence: [], reevaluationCondition: null, evidence: [], confidence: 0.9 });

test('related weak events create an observing Situation with grounded evidence and missing information', async t => {
  let calls = 0;
  const { store, engine, runtime } = fixture(t, async ({ events }) => { calls++; return waitResult(events); });
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  assert.equal(calls, 1);
  const situation = runtime.tasks.situations.listActive()[0];
  assert.equal(situation.lifecycle_state, 'OBSERVING');
  assert.deepEqual(situation.closureCondition.missingEvidence, ['Delivery date']);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM event_situation_links WHERE situation_id=?').get(situation.id).n, 2);
  assert.equal(store.db.prepare('SELECT reason_code FROM activation_decisions WHERE situation_id=?').get(situation.id).reason_code, 'missing_evidence');
  assert.equal(Object.keys(store.state.tasks).length, 0);
});

test('an unrelated pair is cached once, while a third event forms new pairs', async t => {
  const calls = [];
  const { store, engine, runtime } = fixture(t, async ({ events }) => { calls.push(events.map(event => event.id)); return unrelated(); });
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  assert.equal(calls.length, 1);
  runtime.scheduleUnattachedPairs('event:two'); await runtime.whenIdle();
  assert.equal(calls.length, 1);
  engine.ingest(message('three', 'The quotation has an attachment.')); await runtime.whenIdle();
  assert.equal(calls.length, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE outcome='UNRELATED'").get().n, 3);
  assert.equal(runtime.tasks.situations.listActive().length, 0);
  await runtime.privacy.forget({ kind: 'event', id: 'event:one' });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM activation_decisions').get().n, 1);
});

test('a pair classifier cannot independently admit actionable work', async t => {
  const { store, engine, runtime } = fixture(t, async ({ events }) => ({ ...waitResult(events), outcome: 'ACTIONABLE' }));
  engine.ingest({ ...message('one', 'The quotation includes a price.'), meta: { principalRole: 'DIRECT_ACTOR' } });
  engine.ingest({ ...message('two', 'Delivery terms remain open.'), meta: { principalRole: 'DIRECT_ACTOR' } });
  await runtime.whenIdle();
  const situation = runtime.tasks.situations.listActive()[0];
  assert.equal(situation.lifecycle_state, 'OBSERVING');
  assert.ok(situation.closureCondition.missingEvidence.includes('A concrete action and responsibility need validation.'));
  assert.equal(Object.keys(store.state.tasks).length, 0);
});

test('a new model version can reconsider a previously unrelated pair', async t => {
  let calls = 0;
  const { store, engine, runtime } = fixture(t, async () => { calls++; return unrelated(); });
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  runtime.modelChanged(); runtime.scheduleUnattachedPairs('event:two'); runtime.kick(); await runtime.whenIdle();
  assert.equal(calls, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 2);
});

test('an unrelated pair remains cached after the workspace restarts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pairs-restart-'));
  const filename = path.join(directory, 'state.json');
  let calls = 0;
  const reasoner = Object.assign(new NullReasoner(), { available: () => true, async assessSituationPair() { calls++; return unrelated(); } });
  let store = new SqliteStore(filename), engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  await runtime.close(); store.close();
  store = new SqliteStore(filename); engine = new WorkEngine(store, { reasoner }); runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.scheduleUnattachedPairs('event:two'); runtime.kick(); await runtime.whenIdle();
  assert.equal(calls, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 1);
});

test('recovery schedules pair evaluation when the Event committed before its inbox job completed', async t => {
  let calls = 0, enabled = false;
  const { store, engine, runtime } = fixture(t, async () => { calls++; return unrelated(); });
  engine.reasoner.available = () => enabled;
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  store.database.atomic(() => store.db.prepare("UPDATE jobs SET state='queued',lease_owner=NULL,lease_until=NULL,attempts=0 WHERE queue_name='inbox' AND idempotency_key=?").run('event:event:two'));
  enabled = true;
  assert.equal(engine.ingest(message('two', 'Delivery terms remain open.')).duplicate, true);
  await runtime.whenIdle();
  assert.equal(calls, 1);
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE queue_name='inbox' AND idempotency_key=?").get('event:event:two').state, 'completed');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 1);
});

test('exhausted semantic budget defers the pair instead of treating it as unrelated', async t => {
  let calls = 0;
  const { store, engine, runtime } = fixture(t, async () => {
    if (++calls === 1) throw Object.assign(new Error('budget unavailable'), { code: 'REASONING_BUDGET' });
    return unrelated();
  });
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  const job = store.db.prepare("SELECT * FROM jobs WHERE job_type='situation_pair'").get();
  assert.equal(job.state, 'retry_wait');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 0);
  store.database.atomic(() => store.db.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), job.id));
  runtime.kick(); await runtime.whenIdle();
  assert.equal(runtime.jobs.get(job.id).state, 'completed');
  assert.equal(calls, 2);
});

test('a model cannot ground a relationship in text that was not in either event', () => {
  const events = [{ id: 'a', payload: { subject: 'Plan', body: 'A source observation.' } }, { id: 'b', payload: { subject: 'Plan', body: 'Another source observation.' } }];
  const invalid = waitResult([{ id: 'a', body: 'Invented evidence' }, { id: 'b', body: 'Another source observation.' }]);
  assert.equal(validatePairAssessment(invalid, events), null);
});

test('an ungrounded pair response creates no Situation and records a bounded reason', async t => {
  const { store, engine, runtime } = fixture(t, async ({ events }) => ({ ...waitResult(events), evidence: [{ eventId: events[0].id, field: 'body', quote: 'Invented evidence' }] }));
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  assert.equal(runtime.tasks.situations.listActive().length, 0);
  assert.equal(store.db.prepare('SELECT reason_code FROM activation_decisions').get().reason_code, 'ungrounded_or_invalid');
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE job_type='situation_pair'").get().state, 'dead');
});

test('a newly suppressed source is not sent to the model as an old pair candidate', async t => {
  let calls = 0;
  const { engine, runtime } = fixture(t, async () => { calls++; return unrelated(); });
  const first = message('one', 'The quotation includes a price.');
  engine.ingest({ ...first, payload: { ...first.payload, from: 'alex@example.test' } });
  runtime.policies.save({ instruction: 'Suppress Alex', predicate: { op: 'eq', feature: 'sender.identity', value: 'alex@example.test' }, effect: { type: 'suppress' }, identities: [{ provider: 'simulated', providerId: 'alex@example.test', confirmedByUser: true }] });
  const second = message('two', 'Delivery terms remain open.');
  engine.ingest({ ...second, payload: { ...second.payload, from: 'bob@example.test' } });
  await runtime.whenIdle();
  assert.equal(calls, 0);
  assert.equal(runtime.tasks.situations.listActive().length, 0);
});

test('expired unattached events are excluded from semantic matching', async t => {
  let calls = 0;
  const { store, engine, runtime } = fixture(t, async () => { calls++; return unrelated(); });
  engine.ingest(message('one', 'The quotation includes a price.'));
  store.database.atomic(() => store.db.prepare('UPDATE durable_inbox SET received_at=? WHERE id=?').run(new Date(Date.now() - 73 * 3600000).toISOString(), 'event:one'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await runtime.whenIdle();
  assert.equal(calls, 0);
});

test('Forget during pair reasoning discards the late result and removes the pair job', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const { store, engine, runtime } = fixture(t, ({ events }) => new Promise(resolve => { release = () => resolve(waitResult(events)); started(); }));
  engine.ingest(message('one', 'The quotation includes a price.'));
  engine.ingest(message('two', 'Delivery terms remain open.'));
  await entered;
  await runtime.privacy.forget({ kind: 'event', id: 'event:one' });
  release(); await runtime.whenIdle();
  assert.equal(runtime.tasks.situations.listActive().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM negative_pair_cache').get().n, 0);
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE job_type='situation_pair'").get().state, 'cancelled');
});
