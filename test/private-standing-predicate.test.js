import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const body = 'Delivery terms remain open.';
const spec = { description: 'Watch supplier delivery terms', desiredOutcome: 'Keep the delivery terms under review',
  predicate: 'The delivery terms remain unresolved', prefilter: { connectorIds: ['google'], eventTypes: ['email.received'], roles: ['UNKNOWN','DIRECT_ACTOR','PASSIVE_OBSERVER','SHARED_GROUP'] },
  autonomy: { maxAutonomy: 'observe' }, prohibited: ['external_write'] };
function fixture(t, { matched = true, malformed = false, hold = false, budget = null, prepare = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-standing-predicate-')), store = new SqliteStore(path.join(root, 'state.json'));
  let now = Date.now(), calls = 0, announce, release; store.database.now = () => now;
  const inputs = [], started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'intent-fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_, options) => {
    calls++; const wire = JSON.parse(options.body); assert.match(wire.messages[0].content, /user-authored predicate/);
    const input = JSON.parse(wire.messages.find(m => m.role === 'user').content); inputs.push(input);
    if (hold) { announce(); await pending; }
    if (prepare && calls === 1) runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
    const answer = malformed === 'quote' ? { matched: true, quote: 'Invented phrase absent from source', confidence: 0.9 } : malformed ? { invalid: true } : { matched, quote: matched ? body : null, confidence: 0.9 };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  const intent = runtime.intents.create({ ...spec, ...(prepare ? { autonomy: { maxAutonomy: 'prepare' } } : {}), ...(budget ? { budget } : {}) }, { confirmed: true });
  t.after(async () => { release(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, engine, runtime, reasoner, intent, inputs, started, release, calls: () => calls, advance: value => { now = value; },
    ingest: () => engine.ingest({ id: 'event:standing-one', type: 'email.received', source: 'google', connectorId: 'google', payload: { id: 'standing-one', threadId: 'supplier-thread', from: 'supplier@example.test', to: 'reader@example.test', subject: 'Supplier quotation', body } }),
    idle: async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); },
    sessions: () => store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='discovery'").all(),
    jobs: () => store.jobs.list().filter(j => j.job_type === 'standing_intent_match') };
}
for (const matched of [true, false]) test(`native standing ${matched} ACK and semantic decision commit together`, async t => {
  const f = fixture(t, { matched }); f.ingest(); await f.idle(); assert.equal(f.calls(), 1);
  assert.equal(f.sessions().length, 1); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.sessions()[0].final_json, null);
  assert.equal(f.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='standing_intent'").get().outcome, matched ? 'MATCHED' : 'UNRELATED');
  assert.equal(f.runtime.tasks.situations.listActive().length, matched ? 1 : 0); assert.equal(Object.keys(f.store.state.tasks).length, 0);
});
for (const matched of [true, false]) test(`native standing ${matched} projection rollback reuses cached final without another RPC`, async t => {
  const f = fixture(t, { matched }), commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (context, mutation, options) => commit(context, () => {
    const result = mutation(); if (inject) { inject = false; throw Object.assign(new Error('Injected standing commit fault'), { code: 'SQLITE_BUSY', status: 503 }); } return result;
  }, options);
  f.ingest(); await f.idle(); assert.equal(inject, false); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'awaiting_commit');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='standing_intent'").get().n, 0);
  const waiting = f.jobs().find(j => j.state === 'retry_wait'); assert.ok(waiting);
  f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.sessions()[0].status, 'completed');
});
for (const malformed of [true, 'quote']) test(`malformed native standing ${malformed} cannot be accepted as unrelated`, async t => {
  const f = fixture(t, { malformed }); f.ingest(); await f.idle(); assert.equal(f.calls(), 1);
  assert.equal(f.sessions().length, 1); assert.notEqual(f.sessions()[0].status, 'completed'); assert.equal(f.sessions()[0].final_json, null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='standing_intent' AND outcome='UNRELATED'").get().n, 0);
});
test('native standing Token quota wake resumes the same private session/job', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.ingest(); await f.idle();
  assert.equal(f.calls(), 0); const id = f.sessions()[0].id, job = f.jobs().find(j => j.last_error_class === 'budget'); assert.ok(job);
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].id, id); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.store.jobs.get(job.id).state, 'completed');
});
for (const invalidation of ['Forget', 'intent edit', 'intent disabled']) test(`${invalidation} during native standing call prevents late activation`, async t => {
  const f = fixture(t, { hold: true }); f.ingest(); await f.started;
  if (invalidation === 'Forget') await f.runtime.privacy.forget({ kind: 'event', id: 'event:standing-one' });
  else if (invalidation === 'intent disabled') f.runtime.intents.transition(f.intent.id, f.intent.version, 'disabled');
  else f.runtime.intents.update(f.intent.id, f.intent.version, { ...spec, predicate: 'Only activate when delivery has been confirmed' });
  f.release(); await f.idle(); assert.equal(f.runtime.tasks.situations.listActive().length, 0); assert.equal(f.sessions().some(s => s.status === 'completed'), false);
});
for (const matched of [true, false]) test(`standing ${matched} completed replay spends no RPC even with closed admission budget`, async t => {
  const f = fixture(t, { matched, budget: { maxMatches: 1, windowMs: 60000 } }); f.ingest(); await f.idle(); const original = f.jobs()[0];
  assert.equal(f.calls(), 1); assert.equal(f.runtime.intents.budgetOpen(f.runtime.intents.get(f.intent.id)), false);
  const replay = f.store.jobs.enqueue({ type: 'standing_intent_match', key: 'replay-committed-standing', payload: original.payload });
  f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.store.jobs.get(replay.id).state, 'completed');
  assert.equal(f.jobs().filter(j => ['queued','retry_wait'].includes(j.state)).length, 0);
});
for (const matched of [true, false]) test(`standing ${matched} last-slot race defers and reuses final under the follow-up job`, async t => {
  const f = fixture(t, { matched, hold: true, budget: { maxMatches: 1, windowMs: 60000 } }); f.ingest(); await f.started;
  f.engine.ingest({ id: 'event:competing-evaluation', type: 'email.received', source: 'google', connectorId: 'google', meta: { originClass: 'AUTOMATION' },
    payload: { id: 'competing-evaluation', threadId: 'another-thread', from: 'noreply@example.test', subject: 'Automatic status', body: 'Routine status update.' } });
  f.runtime.database.atomic(() => f.runtime.intents.record(f.intent.id, 'event:competing-evaluation', 'UNRELATED', 'semantic_unrelated'));
  f.release(); await f.idle(); assert.equal(f.sessions()[0].status, 'awaiting_commit'); assert.equal(f.runtime.tasks.situations.listActive().length, 0);
  const deferred = f.jobs().find(j => j.state === 'queued'); assert.ok(deferred);
  f.advance(Date.parse(deferred.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.store.jobs.get(deferred.id).state, 'completed'); assert.equal(f.sessions()[0].status, 'completed');
});
test('standing selected memory expires in flight and same job rebuilds before accepting answer', async t => {
  const f = fixture(t, { hold: true }); const memory = f.runtime.memory.put({ content: 'Supplier quotation delivery terms require review.', scopeType: 'global', scopeKey: '*', validUntil: new Date(f.store.database.now() + 1000).toISOString() });
  f.ingest(); await f.started; assert.ok(f.inputs[0].memoryContext.memories.some(m => m.id === memory.id));
  f.advance(f.store.database.now() + 1500); f.release(); await f.idle(); assert.equal(f.runtime.tasks.situations.listActive().length, 0);
  const waiting = f.jobs().find(j => j.state === 'retry_wait'); assert.ok(waiting);
  f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 2);
  assert.equal(f.inputs[1].memoryContext.memories.some(m => m.id === memory.id), false); assert.equal(f.store.jobs.get(waiting.id).state, 'completed');
});
for (const matched of [true, false]) test(`standing ${matched} budget loss at SQL admission does not ACK a no-op`, async t => {
  const f = fixture(t, { matched, budget: { maxMatches: 1, windowMs: 60000 } });
  const commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (context, mutation, options) => {
    if (inject) {
      inject = false;
      f.engine.ingest({ id: 'event:sql-race', type: 'email.received', source: 'google', connectorId: 'google', meta: { originClass: 'AUTOMATION' },
        payload: { id: 'sql-race', threadId: 'sql-other-thread', from: 'noreply@example.test', subject: 'Automatic status', body: 'Routine status update.' } });
      f.runtime.database.atomic(() => f.runtime.intents.record(f.intent.id, 'event:sql-race', 'UNRELATED', 'semantic_unrelated'));
    }
    return commit(context, mutation, options);
  };
  f.ingest(); await f.idle(); assert.equal(inject, false); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'awaiting_commit');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='standing_intent' AND event_a='event:standing-one' AND outcome IN ('MATCHED','UNRELATED')").get().n, 0);
  const deferred = f.jobs().find(j => j.state === 'queued'); assert.ok(deferred);
  f.advance(Date.parse(deferred.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.store.jobs.get(deferred.id).state, 'completed');
});
for (const rollback of [false, true]) test(`native predicate prepare task and ACK are atomic, rollback=${rollback}`, async t => {
  const f = fixture(t, { prepare: true }), commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = rollback;
  f.runtime.modelCommits.commitSql = (context, mutation, options) => commit(context, () => {
    const result = mutation(); if (inject) { inject = false; throw Object.assign(new Error('Injected predicate task rollback'), { code: 'SQLITE_BUSY', status: 503 }); } return result;
  }, options);
  f.ingest(); await f.idle();
  if (rollback) {
    assert.equal(Object.keys(f.store.state.tasks).length, 0); assert.equal(f.sessions()[0].status, 'awaiting_commit');
    const waiting = f.jobs().find(j => j.state === 'retry_wait'); assert.ok(waiting);
    f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle(); assert.equal(f.store.jobs.get(waiting.id).state, 'completed');
  }
  assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed');
  const tasks = Object.values(f.store.state.tasks); assert.equal(tasks.length, 1); assert.equal(tasks[0].kind, 'standing_intent');
  assert.equal(tasks[0].standingIntentId, f.intent.id); assert.equal(tasks[0].intentVersion, f.intent.version); assert.equal(tasks[0].request.text, spec.desiredOutcome);
});

test('edited intent version evaluates afresh instead of using an old matched decision', async t => {
  const f = fixture(t); f.ingest(); await f.idle(); const original = f.jobs()[0]; assert.equal(f.calls(), 1);
  const revised = f.runtime.intents.update(f.intent.id, f.intent.version, { ...spec, predicate: 'Look for unresolved delivery terms' });
  const job = f.store.jobs.enqueue({ type: 'standing_intent_match', key: 'revised-standing-version', payload: { ...original.payload, intentVersion: revised.version } });
  f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 2); assert.equal(f.store.jobs.get(job.id).state, 'completed');
  assert.equal(f.sessions().filter(s => s.status === 'completed').length, 2); assert.equal(f.runtime.tasks.situations.listActive().length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='standing_intent' AND outcome='MATCHED'").get().n, 2);
});
test('standing budget closes after native queue admission: no RPC and follow-up resumes private identity', async t => {
  const f = fixture(t, { budget: { maxMatches: 1, windowMs: 60000 } }), acquire = f.reasoner.budget.acquire.bind(f.reasoner.budget); let inject = true;
  f.reasoner.budget.acquire = async (...args) => {
    const permit = await acquire(...args);
    if (inject) { inject = false; f.runtime.database.atomic(() => f.runtime.intents.record(f.intent.id, 'event:standing-one', 'UNRELATED', 'semantic_unrelated')); }
    return permit;
  };
  f.ingest(); await f.idle(); assert.equal(f.calls(), 0); assert.equal(f.sessions().length, 1); assert.equal(f.sessions()[0].status, 'deferred');
  const id = f.sessions()[0].id, followup = f.jobs().find(j => j.state === 'queued'); assert.ok(followup);
  f.advance(Date.parse(followup.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].id, id); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.store.jobs.get(followup.id).state, 'completed');
});
