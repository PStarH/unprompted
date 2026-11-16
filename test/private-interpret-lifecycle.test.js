import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const input = id => ({ id: `private-event-${id}`, type: 'email.received', payload: { id, threadId: `thread-${id}`, from: 'person@example.test',
  subject: 'Cedar proposal', body: 'Please update the Cedar proposal with experiment results. PRIVATE-INTERPRET-BODY' } });
const valid = { deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results', sourceField: 'body' }] };
function fixture(t, output = valid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-interpret-')); const store = new SqliteStore(path.join(dir, 'state.json'));
  let now = Date.now(); store.database.now = () => now; let fetches = 0, interpretations = 0;
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 },
    fetchImpl: async (_url, init) => { fetches++;
      const interpreting = JSON.parse(init.body).messages?.[0]?.content?.startsWith('You extract structured facts from a work email.');
      if (interpreting) interpretations++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(interpreting ? output : { probes: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }; } });
  reasoner.preferModelInterpretation = true; const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const rows = () => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reasoning_sessions'").get()
    ? store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='interpret' ORDER BY created_at").all() : [];
  const idle = async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); };
  return { store, engine, runtime, rows, idle, fetches: () => fetches, interpretations: () => interpretations, advanceTo: value => { now = value; } };
}

test('default native interpreter resumes the same private session after quota wake and acknowledges the actual modelReview', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  f.engine.ingest(input('quota')); await f.idle();
  const taskId = 'request:quota', waiting = f.store.jobs.list({ taskId }).find(row => row.last_error_class === 'budget');
  assert.ok(waiting); assert.equal(f.fetches(), 0); assert.equal(f.rows().length, 1);
  const id = f.rows()[0].id; assert.equal(f.rows()[0].status, 'deferred');
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].id, id);
  assert.equal(f.rows()[0].status, 'completed'); assert.equal(f.rows()[0].conversation_json, null); assert.equal(f.rows()[0].final_json, null);
  assert.equal(f.store.state.tasks[taskId].modelReview.status, 'verified');
  assert.equal(JSON.stringify(f.store.state.tasks[taskId].reasoningWork).includes('PRIVATE-INTERPRET-BODY'), false);
});

test('real afterSync failure rolls back private ACK and projection; a replacement claim reuses cached interpretation without another interpretation RPC', async t => {
  const f = fixture(t), mutate = f.store.mutate.bind(f.store); let inject = true;
  f.store.mutate = (change, options) => mutate(change, { ...options, afterSync: () => {
    options?.afterSync?.();
    const task = f.store.db.prepare("SELECT data_json FROM tasks WHERE id='request:rollback'").get();
    if (inject && task && JSON.parse(task.data_json).modelReview?.status === 'verified') {
      inject = false; throw Object.assign(new Error('Injected semantic projection fault'), { code: 'SQLITE_BUSY', status: 503 });
    }
  } });
  f.engine.ingest(input('rollback')); await f.idle();
  assert.equal(inject, false); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].status, 'awaiting_commit');
  assert.notEqual(f.store.state.tasks['request:rollback'].modelReview?.status, 'verified');
  const waiting = f.store.jobs.list({ taskId: 'request:rollback' }).find(row => row.state === 'retry_wait'); assert.ok(waiting);
  const calls = f.interpretations(), sessionId = f.rows()[0].id;
  const retryAt = Date.parse(f.store.state.tasks['request:rollback'].reasoningWork.retryAt);
  assert.ok(Date.parse(waiting.available_at) >= retryAt, 'durable retry cannot precede its reasoning checkpoint');
  f.advanceTo(retryAt - 1); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(waiting.id).state, 'retry_wait'); assert.equal(f.interpretations(), calls);
  f.advanceTo(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.interpretations(), calls);
  assert.equal(f.rows()[0].id, sessionId); assert.equal(f.rows()[0].status, 'completed');
  assert.equal(f.store.state.tasks['request:rollback'].modelReview.status, 'verified');
});

for (const [label, result] of [['null', null], ['ungrounded', { deliverable: 'proposal', subjectEntity: 'Invented', requiredContent: [] }]]) {
  test(`default native ${label} output is not verified and releases its private final/claim`, async t => {
    const f = fixture(t, result); f.engine.ingest(input(label)); await f.idle();
    assert.notEqual(f.store.state.tasks[`request:${label}`].modelReview?.status, 'verified');
    assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].claim_id, null); assert.equal(f.rows()[0].final_json, null);
    assert.notEqual(f.rows()[0].status, 'completed');
  });
}


test('two deferred native interpretations retain separate task sessions through a shared quota wake', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  f.engine.ingest(input('separate-a')); f.engine.ingest(input('separate-b')); await f.idle();
  assert.equal(f.rows().length, 2); assert.equal(new Set(f.rows().map(row => row.task_id)).size, 2);
  assert.equal(f.interpretations(), 0);
  const ids = f.rows().map(row => row.id).sort();
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.deepEqual(f.rows().map(row => row.id).sort(), ids);
  for (const row of f.rows()) {
    assert.equal(row.status, 'completed'); assert.equal(row.final_json, null); assert.equal(row.conversation_json, null);
    assert.equal(f.store.state.tasks[row.task_id].modelReview.status, 'verified');
  }
  assert.equal(f.interpretations(), 2);
});

test('the maintenance tick expires a deferred private reasoning session after its TTL', async t => {
  const f = fixture(t); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  f.engine.ingest(input('expire')); await f.idle();
  const row = f.rows()[0];
  assert.ok(row); assert.equal(row.status, 'deferred');
  // Cancel rather than park: a budget wake ignores available_at, and a retry
  // that reached begin() would sweep the row before the assertion (false green).
  const parked = f.store.db.prepare("UPDATE jobs SET state='cancelled',available_at='9999-12-31T23:59:59.999Z' WHERE task_id=? AND state NOT IN ('completed','cancelled')").run(row.task_id);
  assert.ok(parked.changes > 0);
  f.advanceTo(Date.parse(row.expires_at) + 1);
  f.runtime.kick(); await f.idle();
  const expired = f.rows()[0];
  assert.equal(expired.status, 'expired');
  for (const column of ['conversation_json', 'pending_json', 'final_json', 'final_digest', 'deferred_json', 'claim_id', 'claim_until']) {
    assert.equal(expired[column], null, column);
  }
});
