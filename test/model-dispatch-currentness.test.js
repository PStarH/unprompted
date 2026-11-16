import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardModelContext, requireAccountingContext, requestModelJson } from '../src/model-request.js';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { TokenRequestAccounting } from '../src/token-accounting.js';

const reply = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  deliverable: 'proposal', subjectEntity: 'Cedar', requiredContent: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-current-')), store = new SqliteStore(path.join(dir, 'state.json'));
  let now = Date.now(); store.database.now = () => now;
  const state = { fetches: 0 };
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxConcurrent: 1 },
    fetchImpl: async (_url, init) => { state.fetches++; state.wire = init.body; return reply(); } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { reasoner.budget.release('occupied'); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, engine, runtime, reasoner, state, advance: ms => { now += ms; } };
}
const input = { subject: 'Cedar proposal', body: 'Please update the Cedar proposal.' };
for (const change of ['suspended', 'closed', 'model-replaced', 'privacy']) {
  test(`native ${change} while waiting in the real rate queue is refused before any network request`, async t => {
    const f = fixture(t), ctx = f.runtime.modelAccountingContext();
    await f.reasoner.budget.acquire('occupied');
    const result = f.reasoner.interpretRequest(input, 'queued-native', ctx);
    assert.equal(f.reasoner.budget.queue.length, 1);
    if (change === 'suspended') f.runtime.suspended = true;
    if (change === 'closed') await f.runtime.close();
    if (change === 'model-replaced') f.engine.replaceReasoner(new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'other' }));
    if (change === 'privacy') f.store.database.bump('privacy_epoch');
    f.reasoner.budget.release('occupied');
    await assert.rejects(result, { code: 'CONTEXT_CHANGED' });
    assert.equal(f.state.fetches, 0); assert.equal(f.reasoner.calls, 0);
    assert.equal(f.runtime.tokenBudget.describe().workspace.used, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 0);
  });
}

test('a current native context passes normalization and settles a real accounted request without control data on wire', async t => {
  const f = fixture(t), context = requireAccountingContext(requireAccountingContext(f.runtime.modelAccountingContext()));
  await f.reasoner.interpretRequest(input, 'valid-native', context);
  assert.equal(f.state.fetches, 1); assert.equal(f.runtime.tokenBudget.describe().workspace.settled, 15);
  assert.equal(f.state.wire.includes('isCurrent'), false); assert.equal(f.state.wire.includes('nativeCurrent'), false);
});

test('expiry after reservation but before the dispatch marker cancels the real hold', async t => {
  const f = fixture(t), accounting = new TokenRequestAccounting(f.runtime.tokenBudget); let current = true;
  const context = guardModelContext(Object.freeze({ scope: 'workspace' }), () => current);
  const adapter = { prepare: args => { const prepared = accounting.prepare(args); current = false; return prepared; },
    markDispatched: attempt => accounting.markDispatched(attempt), fail: attempt => accounting.fail(attempt), settleResponse: (...args) => accounting.settleResponse(...args) };
  await assert.rejects(requestModelJson({ accounting: adapter, context, protocol: 'chat-completions',
    payload: { model: 'fixture', messages: [{ role: 'user', content: 'Fixture' }], max_tokens: 20 },
    fetchImpl: f.reasoner.fetchImpl, url: 'https://example.test/v1/chat/completions', headers: {}, maxResponseChars: 10000 }), { code: 'CONTEXT_CHANGED' });
  assert.equal(f.state.fetches, 0); assert.equal(f.runtime.tokenBudget.describe().workspace.used, 0);
  assert.equal(f.store.db.prepare('SELECT state FROM token_budget_reservations').get().state, 'cancelled');
});

test('a self-reported JSON isCurrent field is ignored; only the native capability controls admission', async t => {
  const f = fixture(t);
  await f.reasoner.interpretRequest(input, 'untrusted-property', { scope: 'workspace', isCurrent: () => { throw new Error('must not execute model/user field'); } });
  assert.equal(f.state.fetches, 1);
  assert.throws(() => guardModelContext({ scope: 'workspace' }, () => true), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  const context = guardModelContext(Object.freeze({ scope: 'workspace' }), async () => true);
  await assert.rejects(() => f.reasoner.interpretRequest(input, 'async-native-guard', context), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  assert.equal(f.state.fetches, 1);
});

for (const change of ['source-expired', 'owner-lost']) test(`queued native task rejects ${change} using actual SQL ownership and live source facts`, async t => {
  const f = fixture(t), memory = f.runtime.memory.put({ content: 'Keep task guidance current.', validUntil: new Date(f.store.database.now() + 1000).toISOString() });
  const created = f.store.tasks.createOrLoad({ candidateKey: change, data: { request: { subjectEntity: 'Cedar', deliverable: 'proposal' } } });
  f.store.refresh(); f.store.mutate(state => { state.tasks[created.taskId].contextManifest = { selected: [{ kind: 'memory', id: memory.id, version: memory.version }], deferred: [] }; });
  const job = f.store.jobs.claim('native-owner');
  assert.equal(job.task_id, created.taskId);
  const context = f.runtime.modelAccountingContext({ taskId: created.taskId, job });
  await f.reasoner.budget.acquire('occupied');
  const result = f.reasoner.interpretRequest(input, `task-${change}`, context);
  assert.equal(f.reasoner.budget.queue.length, 1);
  if (change === 'source-expired') f.advance(1500);
  else f.store.jobs.complete(job);
  f.reasoner.budget.release('occupied');
  await assert.rejects(result, { code: 'CONTEXT_CHANGED' });
  assert.equal(f.state.fetches, 0); assert.equal(f.runtime.tokenBudget.describe().workspace.used, 0);
});
