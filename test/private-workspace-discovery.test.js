import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const event = { id: 'private-discovery-event', type: 'email.received', payload: { id: 'private-discovery-message', from: 'alex@example.test', to: 'maya@example.test',
  threadId: 'private-discovery-thread', subject: 'proposal update', body: 'Please update the proposal for northstar with experiment results.', receivedAt: '2026-11-14T00:00:00.000Z' } };
const candidate = { deliverable: 'proposal', deliverableQuote: 'proposal', subjectEntity: 'northstar', entityQuote: 'northstar', intent: 'update',
  intentQuote: 'Please update the proposal', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results' }] };
function fixture(t, { output = candidate, hold = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-discovery-')), store = new SqliteStore(path.join(dir, 'state.json'));
  let release, announce; const started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; });
  let now = Date.now(), calls = 0; store.database.now = () => now;
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_url, init) => {
    const payload = JSON.parse(init.body), discovery = payload.messages[0].content.startsWith('You identify a direct request');
    if (discovery) { calls++; if (hold) { announce(); await pending; } }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(discovery ? output : { probes: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { release(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const idle = async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); };
  return { store, engine, runtime, idle, started, release, calls: () => calls, advanceTo: value => { now = value; },
    row: () => store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='discovery'").get(),
    source: () => store.state.events.find(item => item.id === event.id) };
}

test('default grounded discovery resumes one workspace private session after quota wake', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.engine.ingest(event); await f.idle();
  const waiting = f.store.jobs.list().find(row => row.job_type === 'discovery' && row.last_error_class === 'budget'); assert.ok(waiting);
  assert.equal(f.calls(), 0); assert.ok(f.row()); assert.equal(f.row().scope, 'workspace'); assert.equal(f.row().task_id, null); assert.equal(f.row().status, 'deferred'); const id = f.row().id;
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.row().id, id); assert.equal(f.row().status, 'completed'); assert.equal(f.row().conversation_json, null); assert.equal(f.calls(), 1);
  assert.equal(f.source().reasoning.status, 'accepted'); assert.equal(f.store.state.tasks['request:private-discovery-message'].request.subjectEntity, 'northstar');
});

test('accepted discovery task and private ACK roll back together then reuse the cached candidate', async t => {
  const f = fixture(t), mutate = f.store.mutate.bind(f.store); let inject = true;
  f.store.mutate = (change, options) => mutate(change, { ...options, afterSync: () => {
    options?.afterSync?.();
    // Work state is already SQL-synced, while the final workspace snapshot is still uncommitted.
    const task = f.store.db.prepare("SELECT id FROM tasks WHERE id='request:private-discovery-message'").get();
    if (inject && task) { inject = false; throw Object.assign(new Error('Injected discovery projection fault'), { code: 'SQLITE_BUSY', status: 503 }); }
  } });
  f.engine.ingest(event); await f.idle();
  assert.equal(inject, false); assert.ok(f.row()); assert.equal(f.row().status, 'awaiting_commit'); assert.equal(f.store.state.tasks['request:private-discovery-message'], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id='request:private-discovery-message'").get().n, 0);
  const waiting = f.store.jobs.list().find(row => row.job_type === 'discovery' && row.state === 'retry_wait'); assert.ok(waiting);
  const retryAt = Date.parse(f.source().reasoning.retryAt); assert.ok(Date.parse(waiting.available_at) >= retryAt);
  const calls = f.calls(), id = f.row().id; f.advanceTo(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), calls); assert.equal(f.row().id, id); assert.equal(f.row().status, 'completed'); assert.equal(f.source().reasoning.status, 'accepted');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id='request:private-discovery-message'").get().n, 1);
});

for (const [label, output] of [['unanchored', { ...candidate, subjectEntity: 'invented', entityQuote: 'invented' }], ['null', null]]) test(`native ${label} discovery cannot create a task or retain a claim/final`, async t => {
  const f = fixture(t, { output }); f.engine.ingest(event); await f.idle();
  assert.equal(Object.keys(f.store.state.tasks).length, 0); assert.ok(f.row()); assert.notEqual(f.row().status, 'completed');
  assert.equal(f.row().claim_id, null); assert.equal(f.row().final_json, null); assert.equal(f.source().reasoning.status, 'no_candidate');
});


test('Forget during actual discovery prevents a late candidate from restoring the source or creating a task', async t => {
  const f = fixture(t, { hold: true }); f.engine.ingest(event); await f.started;
  await f.runtime.privacy.forget({ kind: 'event', id: event.id }); f.release(); await f.idle();
  assert.equal(Object.keys(f.store.state.tasks).length, 0); assert.equal(f.source(), undefined);
  assert.equal(f.row()?.status === 'completed', false); assert.equal(f.row()?.final_json ?? null, null);
  assert.equal(JSON.stringify(f.store.state).includes('Please update the proposal for northstar'), false);
});
