import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const quote = 'Keep both emergency exits clear.';
const event = { id: 'standing-source-event', type: 'document.modified', connectorId: 'local_files', source: 'local_files', payload: {
  id: 'standing-source', title: 'Lobby procedure', content: quote, available: true, updatedAt: '2026-11-14T00:00:00.000Z', source: 'local_files' } };
function fixture(t, { invalid = false, hold = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-standing-')), store = new SqliteStore(path.join(dir, 'state.json'));
  let now = Date.now(), calls = 0, release, announce; store.database.now = () => now;
  const started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_url, init) => {
    const payload = JSON.parse(init.body), input = JSON.parse(payload.messages.find(message => message.role === 'user').content);
    if (!payload.messages[0].content.startsWith('Prepare a local draft')) return reply({ experiences: [] });
    calls++; if (hold) { announce(); await pending; }
    return reply({ title: 'Lobby safety note', body: quote, evidenceRefs: [{ eventId: input.primarySourceEventId, quote: invalid ? 'Invented quotation.' : quote }] });
  } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000,
    connectorFor: id => id === 'local_files' ? { id, live: true, kind: 'local_files' } : null });
  const intent = runtime.intents.create({ description: 'Review lobby procedure', desiredOutcome: 'Prepare a short safety note',
    prefilter: { connectorIds: ['local_files'], eventTypes: ['document.modified'], roles: ['UNKNOWN', 'DIRECT_ACTOR', 'PASSIVE_OBSERVER', 'SHARED_GROUP'], tokens: ['lobby'] },
    autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
  t.after(async () => { release(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const idle = async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); };
  return { store, engine, runtime, idle, started, release, intent, calls: () => calls, advanceTo: value => { now = value; },
    task: () => Object.values(store.state.tasks).find(task => task.kind === 'standing_intent'),
    rows: () => store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='planning'").all() };
}
function reply(output) { return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }; }

test('default standing preparation resumes its private draft after quota wake and still requires review', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.engine.ingest(event); await f.idle();
  assert.ok(f.task()); const waiting = f.store.jobs.list({ taskId: f.task().id }).find(row => row.last_error_class === 'budget'); assert.ok(waiting);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].status, 'deferred'); const id = f.rows()[0].id; assert.equal(f.calls(), 0);
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.rows()[0].id, id); assert.equal(f.rows()[0].status, 'completed'); assert.equal(f.rows()[0].final_json, null);
  assert.equal(f.task().preparedWork.body, quote); assert.equal(f.task().preparedWork.requiresReview, true); assert.equal(f.task().status, 'ready_for_approval'); assert.equal(f.calls(), 1);
});

test('standing draft, artifact and private ACK roll back together and resume without another model request', async t => {
  const f = fixture(t), mutate = f.store.mutate.bind(f.store); let inject = true;
  // Both store mutation entry points funnel through this transaction hook.
  const wrap = method => (change, options) => method(change, { ...options, afterSync: () => {
    options?.afterSync?.();
    const row = f.store.db.prepare("SELECT data_json FROM tasks WHERE json_extract(data_json,'$.kind')='standing_intent'").get();
    if (inject && row && JSON.parse(row.data_json).preparedWork) { inject = false; throw Object.assign(new Error('Injected standing projection fault'), { code: 'SQLITE_BUSY', status: 503 }); }
  } });
  f.store.mutate = wrap(mutate); f.store.mutateIfChanged = wrap(f.store.mutateIfChanged.bind(f.store));
  f.engine.ingest(event); await f.idle();
  assert.equal(inject, false); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].status, 'awaiting_commit'); assert.equal(f.task().preparedWork, undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE task_id=?").get(f.task().id).n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM plan_steps s JOIN task_runs r ON r.id=s.task_run_id WHERE r.task_id=? AND s.step_kind='source_brief'").get(f.task().id).n, 0);
  const waiting = f.store.jobs.list({ taskId: f.task().id }).find(row => row.state === 'retry_wait'); assert.ok(waiting); const calls = f.calls();
  f.advanceTo(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), calls); assert.equal(f.rows()[0].status, 'completed'); assert.equal(f.task().preparedWork.body, quote);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE task_id=?').get(f.task().id).n, 1);
});

test('invalid preparation quotation cannot become a reviewed draft or retain a cached final', async t => {
  const f = fixture(t, { invalid: true }); f.engine.ingest(event); await f.idle();
  assert.ok(f.task()); assert.equal(f.task().preparedWork, undefined); assert.notEqual(f.task().status, 'ready_for_approval');
  assert.equal(f.rows().length, 1); assert.notEqual(f.rows()[0].status, 'completed'); assert.equal(f.rows()[0].final_json, null); assert.equal(f.rows()[0].claim_id, null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE task_id=?').get(f.task().id).n, 0);
});


test('disabling the standing intent during preparation cannot publish a late draft', async t => {
  const f = fixture(t, { hold: true }); f.engine.ingest(event); await f.started;
  const disabled = f.runtime.intents.transition(f.intent.id, f.intent.version, 'disabled'); f.runtime.syncStandingIntent(disabled);
  f.release(); await f.idle();
  assert.equal(f.task().preparedWork, undefined); assert.notEqual(f.task().status, 'ready_for_approval');
  assert.equal(f.rows().some(row => row.status === 'completed'), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM artifacts WHERE task_id=?').get(f.task().id).n, 0);
});
