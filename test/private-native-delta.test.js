import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { NullReasoner, OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { forkReasonerConfiguration } from '../src/reasoner-scope.js';
const rawDelta = (polarity, quote) => ({ associated: polarity !== 'UNRELATED', polarity: polarity === 'UNRELATED' ? 'UNKNOWN' : polarity,
  confidence: 0.95, evidenceRefs: polarity === 'UNRELATED' ? [] : [{ field: 'body', quote }], stateDelta: {
    deadlineUpdates: polarity === 'ADVANCE' ? [{ field: 'body', quote }] : [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } });
async function fixture(t, { polarity = 'ADVANCE', tasks = 0, hold = false, malformed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-delta-')), filename = path.join(root, 'state.json');
  let now = Date.now(), calls = 0, release, announce;
  const started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; }), inputs = [];
  const env = { root, inputs, started, release: () => release(), calls: () => calls, advance: value => { now = value; } };
  const message = (id, body, at = now) => ({ id: `event:${id}`, type: 'email.received', source: 'google', connectorId: 'google', at: new Date(at).toISOString(),
    meta: { principalRole: 'DIRECT_ACTOR', roleEvidence: { basis: 'sole_to_recipient' } }, payload: { id, threadId: 'delta-thread', from: 'supplier@example.test', to: 'reader@example.test', subject: 'Supplier quotation', body, receivedAt: new Date(at).toISOString() } });
  const body = polarity === 'ADVANCE' ? 'The revised deadline is by 2026-11-18.' : polarity === 'CANCEL' ? tasks > 1 ? 'Please cancel the Cedar proposal.' : 'We will not proceed.' : polarity === 'SUPERSEDE' ? 'The Cedar proposal is superseded by the revised plan.' : 'The terms are being reviewed.';
  const quote = polarity === 'ADVANCE' ? 'by 2026-11-18' : tasks > 1 ? 'Cedar proposal' : body;
  const fetchImpl = async (_, options) => {
    const wire = JSON.parse(options.body);
    if (!wire.messages[0].content.includes('Interpret a new untrusted observation')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"probes":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    calls++;
    inputs.push(JSON.parse(wire.messages.find(item => item.role === 'user').content));
    if (hold) { announce(); await pending; }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(malformed ? { invalid: true } : rawDelta(polarity, quote)) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const open = reasoner => {
    env.store = new SqliteStore(filename); env.store.database.now = () => now;
    env.engine = new WorkEngine(env.store, { reasoner }); env.runtime = new DurableRuntime(env.engine, { tickMs: 1000000 });
  };
  open(new NullReasoner());
  env.engine.ingest(message('seed', 'The quotation is under discussion.', now - 10000)); await env.runtime.whenIdle();
  env.situation = env.runtime.tasks.situations.create({ kind: 'related_observations', summary: 'Supplier quotation', sourceEventIds: ['event:seed'], closureCondition: { kind: 'AWAIT_EVIDENCE', missingEvidence: ['Delivery date'] } });
  env.reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'delta-fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl });
  env.engine.replaceReasoner(env.reasoner);
  env.taskIds = [];
  for (let index = 0; index < tasks; index++) {
    const subject = index ? 'Harbor budget' : 'Cedar proposal';
    const made = env.runtime.tasks.createOrLoad({ candidateKey: `manual-${index}`, situationId: env.situation.id, dedupTaskKey: `manual-${index}`, eventId: 'event:seed', data: {
      status: 'waiting_for_information', subject, threadId: 'delta-thread', sender: 'supplier@example.test', sourceEmailId: 'seed', sourceConnectorId: 'google', request: { text: `Review the ${subject}.`, subjectEntity: index ? 'Harbor' : 'Cedar', deliverable: 'proposal', source: { kind: 'email', from: 'supplier@example.test', connectorId: 'google', id: 'seed', threadId: 'delta-thread' } } } });
    env.taskIds.push(made.taskId);
    const initial = env.store.jobs.claim('fixture-setup'); env.store.jobs.complete(initial);
  }
  env.store.refresh();
  env.idle = async () => { await env.engine.whenSettled(); await env.runtime.whenIdle(); await env.engine.whenSettled(); };
  env.ingest = () => env.engine.ingest(message('update', body));
  env.sessions = () => env.store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='discovery'").all();
  env.receipt = () => env.store.db.prepare("SELECT * FROM situation_delta_results WHERE event_id='event:update'").get();
  env.job = () => env.store.jobs.list().find(job => job.job_type === 'situation_delta');
  env.reopen = async () => {
    const next = forkReasonerConfiguration(env.engine.reasoner); await env.runtime.close(); await env.engine.whenSettled(); env.store.close(); open(next); env.reasoner = next;
  };
  t.after(async () => { release(); await env.runtime.close(); await env.engine.whenSettled(); env.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return env;
}
for (const polarity of ['ADVANCE','CANCEL','UNRELATED']) test(`native delta ${polarity} commits private ACK and grounded semantic receipt`, async t => {
  const f = await fixture(t, { polarity }); f.ingest(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed');
  assert.ok(f.receipt()); assert.equal(f.sessions()[0].final_json, null);
  assert.equal(f.store.db.prepare("SELECT outcome FROM activation_decisions WHERE stage='state_delta'").get().outcome, polarity);
  if (polarity === 'ADVANCE') assert.equal(f.runtime.tasks.situations.get(f.situation.id).closureCondition.deadlineUpdates[0].iso, '2026-11-18');
});
for (const polarity of ['ADVANCE','UNRELATED']) test(`native delta ${polarity} actual SQL ACK rollback retries captured final without RPC`, async t => {
  const f = await fixture(t, { polarity }), commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (context, mutation, options) => commit(context, () => { const value = mutation(); if (inject) { inject = false; throw Object.assign(new Error('Injected delta projection rollback'), { code: 'SQLITE_BUSY', status: 503 }); } return value; }, options);
  f.ingest(); await f.idle(); assert.equal(inject, false); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'awaiting_commit'); assert.equal(f.receipt(), undefined);
  const waiting = f.job(); assert.equal(waiting.state, 'retry_wait'); f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed'); assert.ok(f.receipt()); assert.equal(f.job().state, 'completed');
});
test('native invalid delta rejects final and never ACKs an empty semantic success', async t => {
  const f = await fixture(t, { malformed: true }); f.ingest(); await f.idle(); assert.equal(f.calls(), 1); assert.notEqual(f.sessions()[0].status, 'completed');
  assert.equal(f.sessions()[0].final_json, null); assert.equal(f.receipt(), undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM activation_decisions WHERE stage='state_delta'").get().n, 0);
});
test('native delta resumes same private identity after durable Token quota wake', async t => {
  const f = await fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.ingest(); await f.idle(); assert.equal(f.calls(), 0);
  const id = f.sessions()[0].id, waiting = f.job(); assert.equal(waiting.last_error_class, 'budget');
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].id, id); assert.equal(f.sessions()[0].status, 'completed');
});
test('native final acknowledged before downstream interruption survives a real workspace reopen', async t => {
  const f = await fixture(t, { polarity: 'CANCEL', tasks: 1 }), ingest = f.engine.ingestLegacy.bind(f.engine); let inject = true;
  f.engine.ingestLegacy = (...args) => { if (inject) { inject = false; throw Object.assign(new Error('Injected post-ACK interruption'), { status: 503 }); } return ingest(...args); };
  f.ingest(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.job().state, 'retry_wait', JSON.stringify({ receipt: f.receipt(), decisions: f.store.db.prepare("SELECT * FROM activation_decisions WHERE stage='state_delta'").all(), task: f.runtime.tasks.get(f.taskIds[0]) }));
  const waitingAt = Date.parse(f.job().available_at); await f.reopen(); f.advance(waitingAt + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.runtime.tasks.get(f.taskIds[0]).status, 'cancelled'); assert.equal(f.job().state, 'completed');
});
for (const polarity of ['CANCEL','SUPERSEDE']) test(`scoped native ${polarity} survives interruption after SQL control without targeting survivor`, async t => {
  const f = await fixture(t, { polarity, tasks: 2 }), observe = f.runtime.recordSituationObservation.bind(f.runtime); let inject = true;
  f.runtime.recordSituationObservation = (...args) => { if (inject && args[1] === (polarity === 'CANCEL' ? 'scoped_cancellation' : 'scoped_supersession')) { inject = false; throw Object.assign(new Error('Injected post-control observation interruption'), { status: 503 }); } return observe(...args); };
  f.ingest(); await f.idle(); assert.equal(inject, false); assert.equal(f.receipt().scoped_applied, 1); assert.equal(f.job().state, 'retry_wait');
  const waitingAt = Date.parse(f.job().available_at); await f.reopen(); f.advance(waitingAt + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.runtime.tasks.get(f.taskIds[0]).control.pauseReason, polarity === 'CANCEL' ? 'scoped_cancellation' : 'scoped_supersession');
  assert.notEqual(f.runtime.tasks.get(f.taskIds[1]).status, 'cancelled'); assert.equal(f.job().state, 'completed');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM task_signals WHERE task_id=? AND source_event_id='event:update' AND signal_type=?").get(f.taskIds[0], polarity === 'CANCEL' ? 'CANCELLATION' : 'SUPERSESSION').n, 1);
});
test('changed target scope after semantic ACK cannot receive the old cancellation', async t => {
  const f = await fixture(t, { polarity: 'CANCEL', tasks: 2 }), commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (...args) => { const value = commit(...args); if (inject) { inject = false; throw Object.assign(new Error('Injected after semantic ACK'), { status: 503 }); } return value; };
  f.ingest(); await f.idle(); assert.equal(f.sessions()[0].status, 'completed'); const waiting = f.job(), task = f.runtime.tasks.get(f.taskIds[0]);
  f.runtime.tasks.update(task.id, task.stateVersion, data => { data.subject = 'Birch design'; data.request.subjectEntity = 'Birch'; });
  f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle(); assert.notEqual(f.runtime.tasks.get(task.id).status, 'cancelled');
  assert.notEqual(f.runtime.tasks.get(f.taskIds[1]).status, 'cancelled'); assert.equal(f.calls(), 1);
});
test('Forget during a held native delta prevents late projection and semantic receipt', async t => {
  const f = await fixture(t, { hold: true }); f.ingest(); await f.started; await f.runtime.privacy.forget({ kind: 'event', id: 'event:update' }); f.release(); await f.idle();
  assert.equal(f.receipt(), undefined); assert.equal(f.sessions().some(session => session.status === 'completed'), false);
});
test('selected memory expiry rebuilds delta input on same job before accepting result', async t => {
  const f = await fixture(t, { hold: true }); const memory = f.runtime.memory.put({ content: 'Supplier quotation revised deadline requires careful review.', scopeType: 'global', scopeKey: '*', validUntil: new Date(f.store.database.now() + 1000).toISOString() });
  f.ingest(); await f.started; assert.ok(f.inputs[0].memoryContext.memories.some(row => row.id === memory.id)); f.advance(f.store.database.now() + 1500); f.release(); await f.idle();
  const waiting = f.job(); assert.equal(waiting.state, 'retry_wait'); assert.equal(f.receipt(), undefined); f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 2); assert.equal(f.inputs[1].memoryContext.memories.some(row => row.id === memory.id), false); assert.equal(f.job().state, 'completed');
});
for (const kind of ['event','task','situation','revoke']) test(`delta semantic receipt is cleared on ${kind}`, async t => {
  const f = await fixture(t, { tasks: kind === 'task' ? 1 : 0 }); f.ingest(); await f.idle(); assert.ok(f.receipt());
  if (kind === 'revoke') await f.runtime.privacy.revokePermission({ connectorId: 'google' });
  else await f.runtime.privacy.forget({ kind, id: kind === 'event' ? 'event:update' : kind === 'task' ? f.taskIds[0] : f.situation.id });
  assert.equal(f.receipt(), undefined);
});
for (const change of ['memory TTL', 'source revision', 'scoped flag']) test(`post-ACK ${change} cannot dispatch cached scoped control`, async t => {
  const f = await fixture(t, { polarity: 'CANCEL', tasks: 2 });
  if (change === 'memory TTL') f.runtime.memory.put({ content: 'Supplier quotation Cedar proposal cancellation needs care.', scopeType: 'global', scopeKey: '*', validUntil: new Date(f.store.database.now() + 10000).toISOString() });
  const commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (...args) => { const value = commit(...args); if (inject) { inject = false; throw Object.assign(new Error('Injected after semantic ACK'), { status: 503 }); } return value; };
  f.ingest(); await f.idle(); const waiting = f.job(); assert.equal(waiting.state, 'retry_wait'); assert.equal(f.receipt().scoped_applied, 0);
  if (change === 'memory TTL') {
    assert.ok(JSON.parse(f.receipt().context_json).memories.length); f.advance(f.store.database.now() + 15000);
  } else if (change === 'source revision') {
    const event = JSON.parse(f.store.db.prepare("SELECT event_json FROM durable_inbox WHERE id='event:update'").get().event_json); event.payload.body = 'Please keep the Cedar proposal active.';
    f.runtime.database.atomic(() => f.store.db.prepare("UPDATE durable_inbox SET event_json=? WHERE id='event:update'").run(JSON.stringify(event)));
  } else f.runtime.setFlags({ scopedCancellation: false });
  if (f.store.database.now() <= Date.parse(waiting.available_at)) f.advance(Date.parse(waiting.available_at) + 1);
  f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 1); assert.notEqual(f.runtime.tasks.get(f.taskIds[0]).status, 'cancelled'); assert.notEqual(f.runtime.tasks.get(f.taskIds[1]).status, 'cancelled');
});
test('forgetting selected memory explicitly deletes semantic receipt metadata', async t => {
  const f = await fixture(t); const memory = f.runtime.memory.put({ content: 'Supplier quotation deadline revised careful review.', scopeType: 'global', scopeKey: '*' });
  f.ingest(); await f.idle(); assert.ok(JSON.parse(f.receipt().context_json).memories.some(row => row.id === memory.id));
  await f.runtime.privacy.forget({ kind: 'memory', id: memory.id }); assert.equal(f.receipt(), undefined);
});

test('semantic-commit interruption preserves scoped cancellation across workspace restart', async t => {
  const f = await fixture(t, { polarity: 'CANCEL', tasks: 2 }), assertOwned = f.runtime.jobs.assert.bind(f.runtime.jobs); let inject = true;
  f.runtime.jobs.assert = (...args) => {
    assertOwned(...args);
    if (inject && f.store.db.prepare("SELECT 1 FROM activation_decisions WHERE stage='state_delta' AND event_a='event:update'").get()) {
      inject = false; throw Object.assign(new Error('Injected after semantic decision commit'), { status: 503 });
    }
  };
  f.ingest(); await f.idle(); assert.equal(inject, false); assert.equal(f.job().state, 'retry_wait');
  const waitingAt = Date.parse(f.job().available_at); await f.reopen(); f.advance(waitingAt + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.runtime.tasks.get(f.taskIds[0]).status, 'cancelled');
  assert.notEqual(f.runtime.tasks.get(f.taskIds[1]).status, 'cancelled'); assert.equal(f.job().state, 'completed');
});
test('native delta model change after queue admission reserves nothing and never reaches provider', async t => {
  const f = await fixture(t), acquire = f.reasoner.budget.acquire.bind(f.reasoner.budget);
  f.reasoner.budget.acquire = async (...args) => { const permit = await acquire(...args); f.runtime.database.set('model_version', 'changed-after-admission'); return permit; };
  f.ingest(); await f.idle(); assert.equal(f.calls(), 0); assert.equal(f.receipt(), undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 0);
});

for (const state of ['closed', 'suspended']) test(`post-ACK ${state} workspace parks delta delivery and resumes receipt without another RPC`, async t => {
  const f = await fixture(t, { polarity: 'CANCEL', tasks: 2 });
  const commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let pause = true;
  f.runtime.modelCommits.commitSql = (...args) => { const result = commit(...args); if (pause) { pause = false; f.runtime[state] = true; } return result; };
  f.ingest(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed');
  assert.notEqual(f.runtime.tasks.get(f.taskIds[0]).status, 'cancelled');
  const job = f.job(); assert.equal(job.state, 'retry_wait');
  f.runtime[state] = false; f.advance(Date.parse(job.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.runtime.tasks.get(f.taskIds[0]).status, 'cancelled');
  assert.notEqual(f.runtime.tasks.get(f.taskIds[1]).status, 'cancelled'); assert.equal(f.store.jobs.get(job.id).state, 'completed');
});
