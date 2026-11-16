import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const issue = id => ({ id: `event:${id}`, type: 'issue.updated', connectorId: 'github', source: 'github', payload: {
  id, title: 'Review Cedar budget', body: 'Check the source. PRIVATE-INVESTIGATION-BODY', repository: 'team/work', number: 1,
  assigned: true, state: 'open', updatedAt: '2026-11-14T00:00:00.000Z', url: 'https://github.com/team/work/issues/1', assignee: 'reader', author: 'teammate' } });
function fixture(t, { read = false, malformed = false, holdFirst = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-native-investigation-')), store = new SqliteStore(path.join(dir, 'state.json'));
  let release, announce; const started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; });
  let now = Date.now(), calls = 0; store.database.now = () => now;
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_url, init) => {
    calls++; if (holdFirst && calls === 1) { announce(); await pending; }
    const payload = JSON.parse(init.body), source = payload.messages.find(message => message.role === 'tool');
    const message = read && !source ? { content: null, tool_calls: [{ id: 'source-read', type: 'function', function: { name: 'read_task_source', arguments: '{}' } }] }
      : { content: JSON.stringify(malformed ? { unexpected: true } : { nextStep: 'Check the source budget context.' }) };
    if (read && source) assert.match(source.content, /PRIVATE-INVESTIGATION-BODY/);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { release(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const idle = async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); };
  const rows = () => store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='planning' ORDER BY created_at").all();
  return { engine, runtime, store, rows, idle, started, release, calls: () => calls, advanceTo: value => { now = value; }, task: () => Object.values(store.state.tasks)[0] };
}

test('default native investigation uses the same private session after a quota wake', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.engine.ingest(issue('quota')); await f.idle();
  const waiting = f.store.jobs.list({ taskId: f.task().id }).find(row => row.last_error_class === 'budget'); assert.ok(waiting);
  assert.equal(f.calls(), 0); assert.equal(f.rows().length, 1); const id = f.rows()[0].id; assert.equal(f.rows()[0].status, 'deferred');
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.rows()[0].id, id); assert.equal(f.rows()[0].status, 'completed');
  assert.equal(f.task().mcpInvestigation.nextStep, 'Check the source budget context.'); assert.notEqual(f.task().status, 'completed');
  assert.equal(f.rows()[0].conversation_json, null); assert.equal(f.rows()[0].final_json, null); assert.equal(f.calls(), 1);
});

test('native source read and final resume from cache after actual projection/ACK rollback', async t => {
  const f = fixture(t, { read: true }), mutate = f.store.mutate.bind(f.store); let inject = true;
  f.store.mutate = (change, options) => mutate(change, { ...options, afterSync: () => {
    options?.afterSync?.();
    const rows = f.store.db.prepare('SELECT data_json FROM tasks').all();
    if (inject && rows.some(row => JSON.parse(row.data_json).mcpInvestigation?.nextStep)) {
      inject = false; throw Object.assign(new Error('Injected investigation projection fault'), { code: 'SQLITE_BUSY', status: 503 });
    }
  } });
  f.engine.ingest(issue('rollback')); await f.idle();
  assert.equal(inject, false); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].status, 'awaiting_commit'); assert.equal(f.task().mcpInvestigation, undefined);
  const waiting = f.store.jobs.list({ taskId: f.task().id }).find(row => row.state === 'retry_wait'); assert.ok(waiting); const id = f.rows()[0].id, calls = f.calls(); assert.equal(calls, 2);
  f.advanceTo(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.calls(), calls); assert.equal(f.rows()[0].id, id); assert.equal(f.rows()[0].status, 'completed');
  assert.equal(f.task().mcpInvestigation.nextStep, 'Check the source budget context.'); assert.equal(f.rows()[0].conversation_json, null);
});

test('malformed native investigation cannot become a successful empty suggestion', async t => {
  const f = fixture(t, { malformed: true }); f.engine.ingest(issue('invalid')); await f.idle();
  assert.equal(f.rows().length, 1); assert.notEqual(f.rows()[0].status, 'completed'); assert.equal(f.rows()[0].claim_id, null); assert.equal(f.rows()[0].final_json, null);
  assert.equal(f.task().reasoningWork.status, 'failed'); assert.equal(f.task().mcpInvestigation, undefined);
});


test('cancellation during a native investigation prevents the late private suggestion from being published', async t => {
  const f = fixture(t, { holdFirst: true }); f.engine.ingest(issue('cancelled')); await f.started;
  const id = f.task().id; f.runtime.tasks.applyControl(id, 'CANCELLATION', 'user-cancellation', task => { task.status = 'cancelled'; }); f.store.refresh();
  f.release(); await f.idle();
  assert.equal(f.task().status, 'cancelled'); assert.equal(f.task().mcpInvestigation, undefined);
  assert.equal(f.rows().some(row => row.status === 'completed'), false); assert.equal(f.store.state.outbox.length, 0);
});
