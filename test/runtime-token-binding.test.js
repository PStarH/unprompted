import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { forkReasonerConfiguration } from '../src/reasoner-scope.js';
import { validateModelSettings } from '../src/model-setup.js';
import http from 'node:http';
import { startFixtureServer } from './browser/fixture-server.mjs';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { LocalSetupStore } from '../src/setup.js';

const email = id => ({ id: `event:${id}`, type: 'email.received', payload: {
  id, threadId: `thread:${id}`, from: 'person@example.test', subject: 'Cedar proposal',
  body: 'Please update the Cedar proposal with experiment results.'
} });
const interpretation = { deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update',
  requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results', sourceField: 'body' }] };
function fixture(t, source = null, runtimeOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-token-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const wire = [], observedKeys = [];
  const reasoner = source || new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'native-fixture',
    limits: { maxCallsPerMinute: 100 }, fetchImpl: async (url, init) => {
      wire.push(JSON.parse(init.body));
      observedKeys.push(engine.store.state.tasks['request:native-budget']?.reasoningWork?.key);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(wire.at(-1).messages?.[0]?.content?.startsWith('You propose evidence probes') ? { probes: [] } : interpretation) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    } });
  reasoner.preferModelInterpretation = true;
  const engine = new WorkEngine(store, { reasoner });
  const runtime = new DurableRuntime(engine, { tickMs: 1000000, ...runtimeOptions });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime, reasoner, wire, observedKeys };
}
async function idle({ runtime, engine }) { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); }

for (const scope of ['workspace', 'task']) test(`native engine enforces ${scope} zero before fetch and resumes the same budget-deferred job`, async t => {
  const f = fixture(t), taskId = 'request:native-budget';
  f.runtime.tokenBudget.setLimit({ scope, ...(scope === 'task' ? { taskId } : {}), tokens: 0 });
  f.engine.ingest(email('native-budget')); await idle(f);
  assert.equal(f.wire.length, 0);
  const job = f.store.jobs.list({ taskId }).find(item => item.last_error_class === 'budget');
  assert.ok(job); assert.equal(job.state, 'retry_wait');
  assert.equal(f.store.state.tasks[taskId].reasoningWork.status, 'budget_deferred');
  const semanticKey = f.store.state.tasks[taskId].reasoningWork.key;
  f.runtime.tokenBudget.setLimit({ scope, ...(scope === 'task' ? { taskId } : {}), tokens: 1000000 });
  const wake = f.store.jobs.startBudgetWake({ key: `explicit-limit-change:${scope}`, kind: 'token', taskId: scope === 'task' ? taskId : null });
  f.store.jobs.wakeBudgetDeferred({ eventId: wake.id }); f.runtime.kick(); await idle(f);
  assert.equal(f.store.jobs.get(job.id).state, 'completed');
  assert.equal(f.observedKeys[0], semanticKey, 'the first resumed RPC belongs to the original interpretation');
  assert.equal(f.store.state.tasks[taskId].modelReview.status, 'verified');
  assert.ok(f.wire.length > 0);
  const view = f.runtime.tokenBudget.describe({ taskId });
  assert.equal(view.workspace.settled, f.wire.length * 15);
  assert.equal(view.task.settled, view.workspace.settled);
  for (const payload of f.wire) {
    assert.equal(Object.hasOwn(payload, 'accountingContext'), false);
    assert.equal(Object.hasOwn(payload, 'scope'), false);
    assert.equal(Object.hasOwn(payload, 'taskId'), false);
  }
});

test('replacement model is bound before publication and a foreign ledger is refused without replacing the active model', async t => {
  const first = fixture(t), second = fixture(t);
  first.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  const replacement = forkReasonerConfiguration(first.reasoner);
  first.engine.replaceReasoner(replacement);
  assert.equal(replacement.tokenBudget, first.runtime.tokenBudget);
  await assert.rejects(() => replacement.interpretRequest({ subject: 'Cedar proposal', body: 'Please update the Cedar proposal.' },
    'replacement', first.runtime.modelAccountingContext()), { code: 'TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(first.wire.length, 0);
  assert.throws(() => first.engine.replaceReasoner(second.reasoner), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  assert.equal(first.engine.reasoner, replacement);
  assert.equal(second.reasoner.tokenBudget, second.runtime.tokenBudget);
});

test('two real runtimes account independently and synthetic connection validation uses workspace limits', async t => {
  const first = fixture(t), second = fixture(t, forkReasonerConfiguration(first.reasoner));
  first.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  await assert.rejects(() => validateModelSettings({ baseUrl: 'https://example.test/v1', model: 'fixture' }, {
    tokenBudget: first.runtime.tokenBudget, fetchImpl: first.reasoner.fetchImpl
  }), { code: 'TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(first.wire.length, 0);
  await second.reasoner.interpretRequest({ subject: 'Cedar proposal', body: 'Please update the Cedar proposal.' },
    'second-runtime', second.runtime.modelAccountingContext());
  assert.equal(first.runtime.tokenBudget.describe().workspace.settled, 0);
  assert.equal(second.runtime.tokenBudget.describe().workspace.settled, 15);
});

test('trusted context rejects lost leases, unknown task ids and mismatched job ownership', t => {
  const f = fixture(t);
  assert.throws(() => f.runtime.modelAccountingContext({ taskId: 'missing' }), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  const job = f.store.jobs.enqueue({ type: 'discovery', key: 'context-check', payload: {} });
  const claimed = f.store.jobs.claim('fixture-worker');
  assert.equal(claimed.id, job.id);
  assert.deepEqual(f.runtime.modelAccountingContext({ job: claimed }), { scope: 'workspace' });
  assert.throws(() => f.runtime.modelAccountingContext({ job: claimed, taskId: 'mismatch' }), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  f.store.jobs.complete(claimed);
  assert.throws(() => f.runtime.modelAccountingContext({ job: claimed }), { code: 'LEASE_LOST' });
});


test('real setup HTTP route returns the local budget failure without contacting or saving the candidate provider', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-token-api-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  new TokenBudgetService(store.database).setLimit({ scope: 'workspace', tokens: 0 });
  store.close();
  let requests = 0, fixture;
  const provider = http.createServer((request, response) => { requests++; response.writeHead(500).end(); });
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    fixture = await startFixtureServer({ directory, ruleDemo: false });
    const response = await fetch(fixture.base + '/api/setup/model', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.base },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'budget-candidate' }) });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, 'TOKEN_BUDGET_EXHAUSTED');
    assert.equal(requests, 0);
    const setup = new LocalSetupStore({ filePath: path.join(directory, 'config', 'setup.json') });
    assert.notEqual(setup.get().model?.model, 'budget-candidate');
  } finally {
    await fixture?.close();
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('runtime interval automatically resumes a native budget wait after a committed limit increase', async t => {
  const f = fixture(t, null, { tickMs: 20 }), taskId = 'request:auto-budget';
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  f.engine.ingest(email('auto-budget')); await idle(f);
  const waiting = f.store.jobs.list({ taskId }).find(item => item.last_error_class === 'budget');
  assert.ok(waiting); assert.equal(f.wire.length, 0);
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 });
  // No manual wake, kick or retry follows the policy change.
  const deadline = Date.now() + 3000;
  while (f.store.jobs.get(waiting.id).state !== 'completed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed');
  assert.ok(f.wire.length > 0); assert.equal(f.store.state.tasks[taskId].modelReview.status, 'verified');
});
