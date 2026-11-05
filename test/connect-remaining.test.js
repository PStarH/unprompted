import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase } from '../src/durable/database.js';
import { HybridMemory, lexicalEmbedding } from '../src/durable/memory.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { ReasoningBudget } from '../src/reasoning.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { startFixtureServer } from './browser/fixture-server.mjs';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-connect-'));
  const store = new SqliteStore(path.join(directory, 'state.json'), { database: new DurableDatabase(':memory:') });
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, provider, engine, runtime };
}

async function ready(context) {
  context.engine.ingest({ id: 'mail-event', type: 'email.received', payload: { id: 'm1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send it by Friday.' } });
  context.engine.ingest({ id: 'doc-event', type: 'document.modified', payload: { id: 'cedar', title: 'Cedar project proposal', kind: 'proposal', content: 'Cedar project proposal\nExperiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.' } });
  await context.engine.whenSettled();
  assert.equal(context.store.state.tasks['request:m1'].status, 'ready_for_approval');
  return context.engine.publicState().tasks[0];
}

const conflictingExperiences = [{
  experiences: [
    { id: 'format-table', status: 'active', directiveKey: 'quote.output.format', priority: 1, effect: { type: 'draft_format', format: 'table' } },
    { id: 'format-plain', status: 'active', directiveKey: 'quote.output.format', priority: 1, effect: { type: 'draft_format', format: 'plain' } }
  ]
}];

test('a known send releases its coordination claim and an unknown send keeps it', async t => {
  const context = setup(t);
  const task = await ready(context);
  await context.engine.approve(task.id, { reviewToken: task.reviewToken });
  assert.equal(context.runtime.coordination.held().length, 0);
  assert.deepEqual(context.runtime.describe().coordination, []);

  const unknown = setup(t);
  const pendingTask = await ready(unknown);
  await unknown.engine.approve(pendingTask.id, { reviewToken: pendingTask.reviewToken, failureMode: 'timeout_before_accept' });
  const described = unknown.runtime.describe().coordination;
  assert.ok(described.some(row => row.taskId === pendingTask.id && row.kind === 'resource'));
  assert.ok(unknown.runtime.coordination.held().some(row => row.task_id === pendingTask.id));
  await unknown.engine.reconcile(pendingTask.id);
  assert.equal(unknown.runtime.coordination.held().filter(row => row.task_id === pendingTask.id).length, 0);
});

test('recovery confirmed absence releases the coordination claim and an unknown lookup keeps it', async t => {
  const recovered = setup(t);
  const recoveredTask = await ready(recovered);
  await recovered.engine.approve(recoveredTask.id, { reviewToken: recoveredTask.reviewToken, failureMode: 'timeout_before_accept' });
  const recoveryJob = recovered.runtime.jobs.get(recovered.runtime.db.prepare("SELECT id FROM jobs WHERE job_type='external_dispatch' AND state='recovery_required' AND task_id=?").get(recoveredTask.id).id);
  assert.equal(recovered.runtime.coordination.held().some(row => row.task_id === recoveredTask.id), true);
  await recovered.runtime.recover(recoveryJob);
  assert.equal(recovered.runtime.coordination.held().filter(row => row.task_id === recoveredTask.id).length, 0);

  const reconciled = setup(t);
  const reconciledTask = await ready(reconciled);
  await reconciled.engine.approve(reconciledTask.id, { reviewToken: reconciledTask.reviewToken, failureMode: 'timeout_before_accept' });
  const execution = reconciled.runtime.db.prepare("SELECT id FROM tool_executions WHERE task_id=? AND status='unknown'").get(reconciledTask.id);
  await reconciled.runtime.reconcileExecution(execution.id);
  assert.equal(reconciled.runtime.coordination.held().filter(row => row.task_id === reconciledTask.id).length, 0);

  const unknown = setup(t);
  const pendingTask = await ready(unknown);
  await unknown.engine.approve(pendingTask.id, { reviewToken: pendingTask.reviewToken, failureMode: 'timeout_before_accept' });
  unknown.provider.lookupOverride = 'unknown';
  const pendingExecution = unknown.runtime.db.prepare("SELECT id FROM tool_executions WHERE task_id=? AND status='unknown'").get(pendingTask.id);
  await assert.rejects(() => unknown.runtime.reconcileExecution(pendingExecution.id));
  assert.equal(unknown.runtime.coordination.held().some(row => row.task_id === pendingTask.id), true);

  const interrupted = setup(t);
  const interruptedTask = await ready(interrupted);
  const current = interrupted.store.state.tasks[interruptedTask.id];
  const holder = current.situationId || `task:${current.id}`;
  interrupted.runtime.coordination.claim({ kind: 'resource', scopeKey: 'simulated:never-dispatched', situationId: holder, taskId: current.id });
  const enqueued = interrupted.runtime.jobs.enqueue({ queue: 'effects', type: 'external_dispatch', key: 'never-dispatched', taskId: current.id, payload: { taskId: current.id, key: 'never-dispatched' } });
  interrupted.runtime.db.prepare("UPDATE jobs SET state='recovery_required' WHERE id=?").run(enqueued.id);
  const at = new Date().toISOString();
  interrupted.runtime.db.prepare(`INSERT INTO tool_executions(id,task_id,job_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES(?,?,?,'simulated','send','email.send','never-dispatched','never-dispatched','{}','intent',1,?,?,?,?,?)`)
    .run(`exec-${current.id}`, current.id, enqueued.id, current.inputVersion || 1, current.runGeneration || 1, current.privacyEpoch || 0, at, at);
  await interrupted.runtime.recover(interrupted.runtime.jobs.get(enqueued.id));
  assert.equal(interrupted.runtime.db.prepare('SELECT status FROM tool_executions WHERE id=?').get(`exec-${current.id}`).status, 'cancelled');
  assert.equal(interrupted.runtime.coordination.held().filter(row => row.task_id === current.id).length, 0);
});

test('a rolled-back external preparation does not release an earlier hold', async t => {
  const context = setup(t);
  const task = await ready(context);
  const current = context.store.state.tasks[task.id];
  const resourceId = `${current.draft.to}:${current.draft.subject}`;
  const holder = current.situationId || `task:${current.id}`;
  const existing = context.runtime.coordination.claim({ kind: 'resource', scopeKey: `simulated:${resourceId}`, situationId: holder, taskId: current.id });
  context.store.mutate(state => {
    state.tasks[current.id].action = { id: 'bound-operation', idempotencyKey: 'bound-operation', permission: 'user_approved', inputVersion: state.tasks[current.id].inputVersion, status: 'executing' };
  });
  const reviewed = context.store.state.tasks[current.id];
  await assert.rejects(() => context.runtime.external(reviewed, {
    provider: context.provider, tool: 'send', actionFamily: 'email.send', resourceId,
    key: 'bound-operation',
    payload: { idempotencyKey: 'bound-operation', to: reviewed.draft.to, subject: reviewed.draft.subject, body: 'Unreviewed text' },
    effect: { type: 'email_reply', to: reviewed.draft.to, documentId: reviewed.documentId, bodyDigest: 'not-the-reviewed-body' },
    send: async () => ({ id: 'should-not-send' })
  }), { code: 'AUTHORIZATION_REQUIRED' });
  assert.equal(context.runtime.coordination.held().some(row => row.id === existing.claimId), true);
});

test('replay defaults to retrieval and shadow arbitration stays offline', async t => {
  const context = setup(t);
  const memory = context.runtime.memory.put({ content: 'Cedar weekly results and risks.' });
  const retrieval = await context.runtime.replayExperiences({ cases: [{ query: 'Cedar weekly results', relevantIds: [memory.id] }] });
  assert.equal(retrieval.metrics.recall, 1);
  const shadow = await context.runtime.replayExperiences({ kind: 'arbitration_shadow', cases: conflictingExperiences });
  assert.equal(shadow.metrics.cases, 1);
  assert.equal(shadow.metrics.conflicts, 1);
  assert.equal(shadow.metrics.externalActions, 0);
  assert.equal(context.store.state.outbox.length, 0);
  await assert.rejects(() => context.runtime.replayExperiences({ kind: 'provider', cases: [] }), error => error.code === 'INVALID_REPLAY' && error.status === 400);
});

test('the replay route keeps retrieval as the default and runs shadow arbitration', async t => {
  const fixture = await startFixtureServer({ ruleDemo: false });
  t.after(fixture.close);
  const post = async (route, body) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const saved = await post('/api/instructions', { text: 'Cedar weekly results and risks.' });
  const retrieval = await post('/api/experiences/replay', { cases: [{ query: 'Cedar weekly results', relevantIds: [saved.body.memory.id] }] });
  assert.equal(retrieval.status, 200);
  assert.equal(retrieval.body.metrics.recall, 1);
  const shadow = await post('/api/experiences/replay', { kind: 'arbitration_shadow', cases: conflictingExperiences });
  assert.equal(shadow.status, 200);
  assert.equal(shadow.body.metrics.conflicts, 1);
  assert.equal(shadow.body.metrics.externalActions, 0);
  assert.equal((await post('/api/experiences/replay', { kind: 'provider', cases: [] })).status, 400);
});

test('async encoders use putAsync and searchAsync while lexical memory stays synchronous', async t => {
  const database = new DurableDatabase(':memory:');
  t.after(() => database.close());
  const sync = new HybridMemory(database);
  const saved = sync.put({ id: 'sync-fact', content: 'sync lexical fact about Cedar' });
  assert.equal(saved.id, 'sync-fact');
  assert.equal(typeof saved.then, 'undefined');
  assert.equal(Array.isArray(sync.search('lexical')), true);
  const asyncMemory = new HybridMemory(database, { encoder: { id: 'async-test', dimensions: 384, semantic: false, encode: text => Promise.resolve(lexicalEmbedding(text)) } });
  assert.equal(asyncMemory.usesAsyncEncoder(), true);
  database.atomic(() => assert.throws(() => asyncMemory.put({ content: 'inside a transaction' }), error => error.code === 'ASYNC_EMBEDDING'));
  const row = await asyncMemory.put({ content: 'Cedar budget ceiling is 40000' });
  assert.equal(row.content, 'Cedar budget ceiling is 40000');
  const hits = await asyncMemory.search('Cedar budget');
  assert.equal(hits.some(hit => hit.id === row.id), true);

  const context = setup(t);
  context.runtime.memory.encoder = { id: 'async-test', dimensions: 384, semantic: false, encode: text => Promise.resolve(lexicalEmbedding(text)) };
  context.runtime.memory.asyncEncoderKnown = null;
  const created = await context.runtime.memorySpace.create({ content: 'Cedar prefers concise updates.', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar' });
  const edited = await context.runtime.memorySpace.update(created.memory.id, { operation: 'edit', content: 'Cedar prefers concise weekly updates.', expectedVersion: created.memory.version });
  assert.equal(edited.memory.content, 'Cedar prefers concise weekly updates.');
  const listed = await context.runtime.memorySpace.browse({ q: 'concise weekly', status: 'current' });
  assert.equal(listed.records.some(record => record.id === created.memory.id), true);
});

test('prune keeps active reasoning ids and drops finished ones', async t => {
  const budget = new ReasoningBudget({ maxConcurrent: 2, maxCallsPerRequest: 4, maxCallsPerMinute: 100, maxTrackedRequests: 100 });
  assert.equal(budget.tryAcquire('legacy').ok, true);
  budget.release();
  assert.equal(budget.inFlight, 0);
  assert.equal(budget.perRequest.get('legacy'), 1);
  budget.tryAcquire('keep-me');
  budget.release('keep-me');
  budget.tryAcquire('drop-me');
  budget.release('drop-me');
  budget.prune(['keep-me']);
  assert.equal(budget.perRequest.has('keep-me'), true);
  assert.equal(budget.perRequest.has('drop-me'), false);
  budget.tryAcquire('live-one');
  budget.prune([]);
  assert.equal(budget.perRequest.has('live-one'), true);
  budget.release('live-one');
  budget.prune([]);
  assert.equal(budget.perRequest.has('live-one'), false);

  const context = setup(t);
  await ready(context);
  context.store.mutate(state => {
    state.tasks['request:m1'].reasoningWork = { key: 'work-key', status: 'running', attempts: 2, maxAttempts: 3 };
    const event = state.events.find(item => item.payload?.id === 'm1');
    event.reasoning = { status: 'running', attempts: 1, maxAttempts: 2 };
  });
  const engineBudget = context.engine.reasoner.budget;
  for (const id of ['work-key:attempt:2', 'discover:m1', 'finished-request']) {
    assert.equal(engineBudget.tryAcquire(id).ok, true);
    engineBudget.release(id);
  }
  context.engine.retryPendingReasoning();
  assert.equal(engineBudget.perRequest.has('work-key:attempt:2'), true);
  assert.equal(engineBudget.perRequest.has('discover:m1'), true);
  assert.equal(engineBudget.perRequest.has('finished-request'), false);
});
