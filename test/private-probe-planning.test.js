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
const reply = output => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
function fixture(t, { park = false, read = false, malformed = false, proposed = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-probe-')); const store = new SqliteStore(path.join(dir, 'state.json'));
  let now = Date.now(); store.database.now = () => now; let fetches = 0, interpretations = 0, plans = 0;
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 },
    fetchImpl: async (_url, init) => {
      fetches++; const payload = JSON.parse(init.body);
      if (payload.messages[0].content.startsWith('You extract structured facts from a work email.')) {
        interpretations++; if (park) runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 15 });
        return reply(valid);
      }
      plans++;
      if (read && !payload.messages.some(message => message.role === 'tool')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: null,
        tool_calls: [{ id: 'native-read', type: 'function', function: { name: 'read_task_source', arguments: '{}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
      return reply(malformed ? { unexpected: true } : { probes: proposed ? [{ concept: 'Cedar experiment breakdown', criterionLabel: 'Experiment results',
        provider: 'document_text', strategies: ['section_body'], keywords: ['experiment', 'results'], justification: 'experiment results',
        expectedEvidence: 'The experiment results.', constraints: { freshness: false } }] : [] });
    } });
  reasoner.preferModelInterpretation = true; const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const rows = () => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reasoning_sessions'").get()
    ? store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='planning' ORDER BY created_at").all() : [];
  const idle = async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); };
  return { store, engine, runtime, rows, idle, fetches: () => fetches, interpretations: () => interpretations, plans: () => plans, advanceTo: value => { now = value; } };
}


test('default native probe planning resumes the same private session after a quota wake', async t => {
  const f = fixture(t, { park: true }); f.engine.ingest(input('plan-quota')); await f.idle();
  const waiting = f.store.jobs.list({ taskId: 'request:plan-quota' }).find(row => row.last_error_class === 'budget');
  assert.ok(waiting); assert.equal(f.plans(), 0); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].status, 'deferred');
  const id = f.rows()[0].id;
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.rows()[0].id, id); assert.equal(f.rows()[0].status, 'completed');
  assert.equal(f.rows()[0].conversation_json, null); assert.equal(f.rows()[0].final_json, null);
  assert.equal(f.store.state.tasks['request:plan-quota'].reasoning.status, 'no_proposal'); assert.equal(f.plans(), 1);
});

for (const proposed of [false, true]) test(`actual probe tool turn and cached ${proposed ? 'accepted' : 'empty'} plan survive projection rollback without another planning RPC`, async t => {
  const f = fixture(t, { read: true, proposed }), mutate = f.store.mutate.bind(f.store); let inject = true;
  f.store.mutate = (change, options) => mutate(change, { ...options, afterSync: () => {
    options?.afterSync?.();
    const row = f.store.db.prepare("SELECT data_json FROM tasks WHERE id='request:plan-rollback'").get(), task = row && JSON.parse(row.data_json);
    if (inject && task?.reasoningWork?.kind === 'probes' && task.reasoningWork.status === 'complete') {
      inject = false; throw Object.assign(new Error('Injected planning projection fault'), { code: 'SQLITE_BUSY', status: 503 });
    }
  } });
  f.engine.ingest(input('plan-rollback')); await f.idle();
  assert.equal(inject, false); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].status, 'awaiting_commit');
  assert.equal(f.store.state.tasks['request:plan-rollback'].reasoningWork.status, 'failed');
  const waiting = f.store.jobs.list({ taskId: 'request:plan-rollback' }).find(row => row.state === 'retry_wait'); assert.ok(waiting);
  const count = f.plans(), id = f.rows()[0].id; assert.equal(count, 2);
  f.advanceTo(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.plans(), count); assert.equal(f.rows()[0].id, id); assert.equal(f.rows()[0].status, 'completed');
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed');
  const task = f.store.state.tasks['request:plan-rollback'];
  assert.equal(task.reasoning.status, proposed ? 'ok' : 'no_proposal');
  if (proposed) { assert.equal(task.reasoning.accepted, 1); assert.equal(task.reasoningPlan.proposals.length, 1); }
  assert.equal(f.rows()[0].conversation_json, null); assert.equal(f.rows()[0].final_json, null);
});

test('malformed native probe final cannot be acknowledged as a completed plan', async t => {
  const f = fixture(t, { malformed: true }); f.engine.ingest(input('plan-invalid')); await f.idle();
  assert.equal(f.rows().length, 1); assert.notEqual(f.rows()[0].status, 'completed'); assert.equal(f.rows()[0].claim_id, null); assert.equal(f.rows()[0].final_json, null);
  assert.equal(f.store.state.tasks['request:plan-invalid'].reasoningWork.status, 'failed');
});
