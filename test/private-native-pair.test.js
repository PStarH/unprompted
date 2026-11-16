import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const message = (id, body) => ({ id: `event:${id}`, type: 'email.received', payload: { id, threadId: 'supplier-thread', from: 'supplier@example.test', to: 'reader@example.test', subject: 'Supplier quotation', body } });
function fixture(t, { outcome = 'RELATED_WAIT', malformed = false, hold = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pair-')), store = new SqliteStore(path.join(root, 'state.json'));
  const inputs = [];
  let now = Date.now(), calls = 0, announce, release; store.database.now = () => now;
  const started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'pair-fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_, options) => {
    calls++; const wire = JSON.parse(options.body); assert.match(wire.messages[0].content, /two untrusted work observations/);
    const input = JSON.parse(wire.messages.find(m => m.role === 'user').content); inputs.push(input);
    if (hold) { announce(); await pending; }
    const answer = malformed ? { invalid: true } : outcome === 'UNRELATED' ? { outcome, summary: null, missingEvidence: [], reevaluationCondition: null, evidence: [], confidence: 0.9 }
      : { outcome, summary: 'Waiting for delivery terms.', missingEvidence: ['Delivery date'], reevaluationCondition: 'When delivery terms arrive.', confidence: 0.9,
        evidence: input.events.map(e => ({ eventId: e.id, field: 'body', quote: e.body })) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { release(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, engine, runtime, reasoner, started, release, inputs, calls: () => calls, advance: value => { now = value; },
    ingest: () => { engine.ingest(message('one', 'The quotation includes a price.')); engine.ingest(message('two', 'Delivery terms remain open.')); },
    idle: async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); },
    sessions: () => store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='discovery'").all() };
}
for (const outcome of ['RELATED_WAIT', 'UNRELATED']) test(`native pair ${outcome} commits private ACK with semantic projection`, async t => {
  const f = fixture(t, { outcome }); f.ingest(); await f.idle(); assert.equal(f.calls(), 1);
  assert.equal(f.sessions().length, 1); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.sessions()[0].final_json, null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='pair_association'").get().n, 1);
  assert.equal(f.runtime.tasks.situations.listActive().length, outcome === 'UNRELATED' ? 0 : 1);
  assert.equal(Object.keys(f.store.state.tasks).length, 0);
});
for (const outcome of ['RELATED_WAIT', 'UNRELATED']) test(`native pair ${outcome} final survives actual SQL ACK/projection rollback without another RPC`, async t => {
  const f = fixture(t, { outcome }), commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (context, mutation, options) => commit(context, () => {
    const result = mutation(); if (inject) { inject = false; throw Object.assign(new Error('Injected pair projection rollback'), { code: 'SQLITE_BUSY', status: 503 }); } return result;
  }, options);
  f.ingest(); await f.idle(); assert.equal(inject, false); assert.equal(f.calls(), 1);
  assert.equal(f.sessions()[0].status, 'awaiting_commit'); assert.equal(f.runtime.tasks.situations.listActive().length, 0);
  const job = f.store.jobs.list().find(j => j.job_type === 'situation_pair' && j.state === 'retry_wait'); assert.ok(job, JSON.stringify(f.store.jobs.list()));
  f.advance(Date.parse(job.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.store.jobs.get(job.id).state, 'completed'); assert.equal(f.sessions()[0].status, 'completed');
  assert.equal(f.runtime.tasks.situations.listActive().length, outcome === 'UNRELATED' ? 0 : 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='pair_association'").get().n, 1);
});
test('invalid native pair final cannot be ACKed as successful empty work', async t => {
  const f = fixture(t, { malformed: true }); f.ingest(); await f.idle(); assert.equal(f.calls(), 1);
  assert.equal(f.sessions().length, 1); assert.notEqual(f.sessions()[0].status, 'completed'); assert.equal(f.sessions()[0].final_json, null);
  assert.equal(f.runtime.tasks.situations.listActive().length, 0);
});
test('Forget while native pair is held prevents late association and private ACK', async t => {
  const f = fixture(t, { hold: true }); f.ingest(); await f.started;
  await f.runtime.privacy.forget({ kind: 'event', id: 'event:one' }); f.release(); await f.idle();
  assert.equal(f.runtime.tasks.situations.listActive().length, 0); assert.equal(f.sessions().some(s => s.status === 'completed'), false);
});
test('model change after queue admission prevents native pair fetch', async t => {
  const f = fixture(t), acquire = f.reasoner.budget.acquire.bind(f.reasoner.budget);
  f.reasoner.budget.acquire = async (...args) => { const permit = await acquire(...args); f.runtime.database.set('model_version', 'changed-after-queue'); return permit; };
  f.ingest(); await f.idle(); assert.equal(f.calls(), 0); assert.equal(f.runtime.tasks.situations.listActive().length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 0);
});
test('deleted pair event is checked before field dereference', async t => {
  const f = fixture(t); await f.runtime.runSituationPair({ payload: { eventIds: ['missing-one', 'missing-two'], evaluatorVersion: f.runtime.pairEvaluatorVersion(), privacyEpoch: Number(f.runtime.database.get('privacy_epoch')) } });
  assert.equal(f.calls(), 0);
});

test('native pair crossing a selected memory TTL rebuilds on the same durable job', async t => {
  const f = fixture(t, { hold: true });
  const memory = f.runtime.memory.put({ content: 'Supplier quotation delivery terms require careful review.', scopeType: 'global', scopeKey: '*', validUntil: new Date(f.store.database.now() + 1000).toISOString() });
  f.ingest(); await f.started; assert.ok(f.inputs[0].memoryContext.memories.some(m => m.id === memory.id));
  f.advance(f.store.database.now() + 1500); f.release(); await f.idle();
  assert.equal(f.runtime.tasks.situations.listActive().length, 0);
  const job = f.store.jobs.list().find(j => j.job_type === 'situation_pair' && j.state === 'retry_wait'); assert.ok(job);
  f.advance(Date.parse(job.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(job.id).state, 'completed'); assert.equal(f.calls(), 2);
  assert.equal(f.inputs[1].memoryContext.memories.some(m => m.id === memory.id), false);
  assert.equal(f.runtime.tasks.situations.listActive().length, 1);
});

test('native pair budget deferral preserves private identity and resumes the same job', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.ingest(); await f.idle();
  assert.equal(f.calls(), 0); assert.equal(f.sessions().length, 1); assert.equal(f.sessions()[0].status, 'deferred');
  const id = f.sessions()[0].id, job = f.store.jobs.list().find(j => j.job_type === 'situation_pair' && j.last_error_class === 'budget'); assert.ok(job);
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.sessions().length, 1); assert.equal(f.sessions()[0].id, id); assert.equal(f.sessions()[0].status, 'completed');
  assert.equal(f.store.jobs.get(job.id).state, 'completed');
});
