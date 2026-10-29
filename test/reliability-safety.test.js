import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { DurableWorker } from '../src/durable/jobs.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { DurableDatabase, iso } from '../src/durable/database.js';

const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-safety-'));
  const store = new SqliteStore(path.join(directory, 'state.json'), { database: new DurableDatabase(':memory:') }), provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, provider, engine, runtime, jobs: store.jobs, tasks: store.tasks, ledger: runtime.ledger };
}
async function ready(c) {
  c.engine.ingest({ id: 'mail-event', type: 'email.received', payload: { id: 'm1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send it by Friday.' } });
  c.engine.ingest({ id: 'doc-event', type: 'document.modified', payload: { id: 'cedar', title: 'Cedar project proposal', kind: 'proposal', content: 'Cedar project proposal\nExperiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.' } });
  await c.engine.whenSettled(); assert.equal(c.store.state.tasks['request:m1'].status, 'ready_for_approval');
  return c.engine.publicState().tasks[0];
}
function run(c, key = 'unit') {
  const created = c.tasks.createOrLoad({ candidateKey: key, data: { subject: key, status: 'waiting_for_information' } });
  const job = c.jobs.claim('unit-worker'), executionRun = c.tasks.beginRun(job);
  c.tasks.checkpoint(executionRun, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, run: executionRun, job };
}
function intent(c, current) { return c.ledger.intent({ ...current, provider: 'fixture', resourceId: 'resource', tool: 'send', actionFamily: 'fixture.send', key: 'safe-write', payload: {}, effect: { type: 'fixture' }, authorize: () => ({ allowed: true }) }); }

test('revoking a standing grant during provider authentication prevents the actual send', async t => {
  const c = setup(t), task = await ready(c), entered = latch(), proceed = latch();
  c.engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: 'Cedar', deliverable: 'proposal' } });
  const send = c.provider.send.bind(c.provider);
  c.provider.send = async (...args) => { entered.resolve(); await proceed.promise; return send(...args); };
  const pending = c.engine.executePreAuthorized(task.id);
  let guard;
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Provider did not enter dispatch preparation.')), 5000); })]);
    c.engine.correctCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'never', scope: { entity: 'Cedar', deliverable: 'proposal' } });
  } finally { clearTimeout(guard); proceed.resolve(); }
  await pending;
  assert.equal(c.store.state.outbox.length, 0, 'the cached approval must not survive grant revocation');
  assert.equal(c.store.state.tasks[task.id].status, 'ready_for_approval');
  const reviewed = c.engine.publicState().tasks.find(row => row.id === task.id);
  await c.engine.approve(task.id, { reviewToken: reviewed.reviewToken });
  assert.equal(c.store.state.outbox.length, 1, 'the user can still explicitly send the reviewed draft');
});

test('reconciling an accepted send remains read-only after write permission is revoked', async t => {
  const c = setup(t), task = await ready(c);
  const verify = c.provider.verifyReceipt.bind(c.provider);
  c.provider.verifyReceipt = () => ({ status: 'unknown' });
  await c.engine.approve(task.id, { reviewToken: task.reviewToken });
  assert.equal(c.store.state.outbox.length, 1);
  c.provider.verifyReceipt = verify; c.engine.policy.shadow = true;
  await c.engine.reconcile(task.id);
  assert.equal(c.store.state.tasks[task.id].status, 'completed');
  assert.equal(c.store.state.outbox.length, 1);
});

test('a failed job cannot leave a phantom running run that swallows future task input', t => {
  const c = setup(t), current = run(c);
  c.jobs.fail(current.job, new Error('Permanent planning failure'));
  c.store.database.atomic(() => c.store.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run('new-event', 'fixture', 'new-event', '{}', 'new-context', iso()));
  c.tasks.associate(current.taskId, 'new-event');
  assert.equal(c.store.db.prepare("SELECT COUNT(*) n FROM task_runs WHERE task_id=? AND status='running'").get(current.taskId).n, 0);
  assert.ok(c.jobs.list().some(job => job.job_type === 'task_continue' && job.state === 'queued'));
});

test('malformed provider receipts never release an unresolved resource claim', async t => {
  const c = setup(t), current = run(c), pending = intent(c, current);
  c.ledger.timeoutMs = 15;
  await assert.rejects(c.ledger.dispatch(pending, { ...current, send: () => new Promise(() => {}) }));
  const result = await c.ledger.reconcile(pending.execution.id, { lookup: async () => ({ status: 'found', receipt: { id: 'wrong', idempotencyKey: 'different-operation' } }) });
  assert.equal(result.status, 'unknown'); assert.equal(c.ledger.get(pending.execution.id).status, 'unknown');
  assert.notEqual(c.store.db.prepare('SELECT claim_state FROM resource_claims').get().claim_state, 'free');
});

test('verification errors after acceptance cannot be reclassified as no external effect', async t => {
  const c = setup(t), current = run(c), pending = intent(c, current);
  await assert.rejects(c.ledger.dispatch(pending, { ...current, send: async () => ({ id: 'accepted' }), verify: async () => { throw Object.assign(new Error('Readback version changed'), { stale: true }); } }));
  assert.equal(c.ledger.get(pending.execution.id).status, 'unknown');
});

test('one worker cannot overlap handlers while another tick is awaiting recovery', async t => {
  const c = setup(t), old = c.jobs.enqueue({ queue: 'test', type: 'work', key: 'expired' });
  c.store.database.atomic(() => c.store.db.prepare("UPDATE jobs SET state='recovery_required' WHERE id=?").run(old.id));
  c.jobs.enqueue({ queue: 'test', type: 'work', key: 'first' }); c.jobs.enqueue({ queue: 'test', type: 'work', key: 'second' });
  const recovery = latch(), handlers = latch(); let calls = 0;
  const worker = new DurableWorker({ jobs: c.jobs, queue: 'test', recovery: () => recovery.promise, handlers: { work: async () => { calls++; await handlers.promise; } } });
  const a = worker.tick(), b = worker.tick(); recovery.resolve();
  await new Promise(resolve => setImmediate(resolve)); handlers.resolve(); await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('an already cancelled read does not invoke its tool callback', async t => {
  const c = setup(t), current = run(c);
  const pending = c.ledger.intent({ ...current, provider: 'fixture', resourceId: 'read', tool: 'read', actionFamily: 'context.read', key: 'read-cancel', effect: { type: 'read' }, payload: {}, isWrite: false });
  let calls = 0;
  await assert.rejects(c.ledger.dispatch(pending, { ...current, signal: AbortSignal.abort(), send: async () => { calls++; return {}; } }));
  assert.equal(calls, 0);
});

test('new source input revives real engine planning after an earlier durable job failed', async t => {
  const c = setup(t), original = c.engine.recheckTaskGuidance.bind(c.engine);
  c.engine.recheckTaskGuidance = () => { throw new Error('Injected planning failure'); };
  c.engine.ingest({ id: 'before-failure', type: 'email.received', payload: { id: 'm1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send it by Friday.' } });
  await c.engine.whenSettled(); assert.ok(c.jobs.list().some(job => job.state === 'dead'));
  c.engine.recheckTaskGuidance = original;
  c.engine.ingest({ id: 'after-failure', type: 'document.modified', payload: { id: 'cedar', title: 'Cedar project proposal', kind: 'proposal', content: 'Cedar proposal\nExperiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.' } });
  await c.engine.whenSettled(); const task = c.store.state.tasks['request:m1'];
  assert.equal(task.status, 'ready_for_approval'); assert.equal(task.inputVersion, task.processedInputVersion);
});

test('a wrong receipt from the verification adapter cannot complete a real engine action', async t => {
  const c = setup(t), task = await ready(c);
  c.provider.verifyReceipt = () => ({ status: 'found', receipt: { id: 'other-message', idempotencyKey: 'other-operation' } });
  await c.engine.approve(task.id, { reviewToken: task.reviewToken });
  assert.equal(c.store.state.tasks[task.id].status, 'blocked');
  assert.equal(c.ledger.list()[0].status, 'accepted');
  assert.notEqual(c.store.db.prepare('SELECT claim_state FROM resource_claims').get().claim_state, 'free');
});

test('restart before intent persistence exposes a safe retry and never blindly dispatches the queued write', async t => {
  const c = setup(t), task = await ready(c), key = `send:${task.id}:${task.draft.documentVersion}:i${task.inputVersion}`;
  c.store.mutate(state => {
    state.tasks[task.id].action = { id: 'prepared-send', idempotencyKey: key, version: 1, permission: 'user_approved', inputVersion: task.inputVersion, status: 'executing', live: false };
    state.tasks[task.id].status = 'verifying';
  });
  c.jobs.enqueue({ queue: 'effects', type: 'external_dispatch', taskId: task.id, key: `${key}:attempt:0`, payload: { taskId: task.id, key } });
  c.runtime.start(); await c.engine.whenSettled();
  assert.equal(c.store.state.outbox.length, 0);
  assert.equal(c.store.state.tasks[task.id].action.status, 'confirmed_absent');
  await c.engine.retry(task.id); await c.engine.whenSettled();
  assert.equal(c.store.state.tasks[task.id].status, 'completed');
  assert.equal(c.store.state.outbox.length, 1);
});

test('pausing during authentication stops dispatch; resume reconciles before a user retries', async t => {
  const c = setup(t), task = await ready(c), entered = latch(), proceed = latch();
  const send = c.provider.send.bind(c.provider);
  c.provider.send = async (...args) => { entered.resolve(); await proceed.promise; return send(...args); };
  const pending = c.engine.approve(task.id, { reviewToken: task.reviewToken });
  try { await entered.promise; c.engine.setTaskPaused(task.id, true); } finally { proceed.resolve(); }
  await pending; assert.equal(c.store.state.outbox.length, 0);
  assert.equal(c.store.state.tasks[task.id].control.paused, true);
  c.engine.setTaskPaused(task.id, false); await c.engine.whenSettled();
  assert.equal(c.store.state.tasks[task.id].action.status, 'confirmed_absent');
  await c.engine.retry(task.id); assert.equal(c.store.state.outbox.length, 1);
});

test('pausing an already dispatched operation records unknown and never pretends to undo it', async t => {
  const c = setup(t), task = await ready(c), entered = latch(), proceed = latch();
  const send = c.provider.send.bind(c.provider); let attempts = 0;
  c.provider.send = async (...args) => { attempts++; const result = send(...args); entered.resolve(); await proceed.promise; return result; };
  const pending = c.engine.approve(task.id, { reviewToken: task.reviewToken });
  try { await entered.promise; c.engine.setTaskPaused(task.id, true); } finally { proceed.resolve(); }
  await pending;
  assert.equal(c.store.state.outbox.length, 1); assert.equal(c.ledger.list()[0].status, 'unknown');
  c.engine.setTaskPaused(task.id, false); await c.engine.whenSettled();
  assert.equal(c.store.state.tasks[task.id].status, 'completed'); assert.equal(attempts, 1);
});

test('the gateway rejects changed recipient, subject, body, hidden fields and a substituted provider before dispatch', async t => {
  const c = setup(t); await ready(c);
  const key = 'bound-operation';
  c.store.mutate(state => { state.tasks['request:m1'].action = { id: key, idempotencyKey: key, permission: 'user_approved', inputVersion: state.tasks['request:m1'].inputVersion, status: 'executing' }; state.tasks['request:m1'].status = 'verifying'; });
  const task = c.store.state.tasks['request:m1'], draft = task.draft;
  const payload = { idempotencyKey: key, to: draft.to, subject: draft.subject, body: draft.body, documentUrl: draft.documentUrl, threadId: null };
  const effect = { type: 'email_reply', to: draft.to, documentId: task.documentId, bodyDigest: createHash('sha256').update(draft.body).digest('hex') };
  let calls = 0;
  for (const change of [{ to: 'other@example.test' }, { subject: 'Other subject' }, { body: 'Unreviewed text' }, { bcc: 'hidden@example.test' }]) {
    await assert.rejects(c.runtime.external(task, { provider: c.provider, tool: 'send', actionFamily: 'email.send', resourceId: `${draft.to}:${draft.subject}`, key, payload: { ...payload, ...change }, effect, send: async () => { calls++; return {}; } }), { code: 'AUTHORIZATION_REQUIRED' });
  }
  await assert.rejects(c.runtime.external(task, { provider: new SimulatedMailProvider(c.store), tool: 'send', actionFamily: 'email.send', resourceId: `${draft.to}:${draft.subject}`, key, payload, effect, send: async () => { calls++; return {}; } }), { code: 'AUTHORIZATION_REQUIRED' });
  assert.equal(calls, 0); assert.equal(c.ledger.list().length, 0);
  assert.equal(c.jobs.list().filter(job => job.job_type === 'external_dispatch').length, 0, 'failed preparation rolls back its job and intent together');
});

test('a hanging preflight lookup has a hard deadline, aborts the read and never dispatches', async t => {
  const c = setup(t), task = await ready(c); c.engine.toolGateway.readTimeoutMs = 15;
  let signal, sends = 0;
  c.provider.lookup = (_key, options) => { signal = options.signal; return new Promise(() => {}); };
  c.provider.send = () => { sends++; throw new Error('Unexpected send'); };
  await c.engine.approve(task.id, { reviewToken: task.reviewToken });
  assert.equal(signal.aborted, true); assert.equal(sends, 0);
  assert.equal(c.store.state.tasks[task.id].status, 'blocked');
});

test('input arriving before a run fails still receives a durable continuation', t => {
  const c = setup(t), current = run(c);
  c.store.database.atomic(() => c.store.db.prepare('INSERT INTO durable_inbox(id,provider,provider_event_id,event_json,material_signature,received_at) VALUES(?,?,?,?,?,?)').run('arrived-while-active', 'fixture', 'arrived-while-active', '{}', 'changed-context', iso()));
  c.tasks.associate(current.taskId, 'arrived-while-active');
  assert.equal(c.jobs.list().some(job => job.job_type === 'task_continue'), false);
  c.jobs.fail(current.job, new Error('Failed after input arrived'));
  assert.ok(c.jobs.list().some(job => job.job_type === 'task_continue' && job.state === 'queued'));
});

test('a verified effect is recorded when new input arrives after dispatch, without completing the newer task', async t => {
  const c = setup(t), task = await ready(c), entered = latch(), proceed = latch();
  const send = c.provider.send.bind(c.provider);
  c.provider.send = async (...args) => { const result = send(...args); entered.resolve(); await proceed.promise; return result; };
  const pending = c.engine.approve(task.id, { reviewToken: task.reviewToken });
  try {
    await entered.promise;
    c.engine.ingest({ id: 'new-quote', type: 'document.modified', payload: { id: 'cedar', title: 'Cedar project proposal', kind: 'proposal', content: 'Cedar proposal\nExperiment results\nRun date: 2026-10-16\nSample size: 1,250\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.' } });
  } finally { proceed.resolve(); }
  await pending; await c.engine.whenSettled();
  assert.equal(c.store.state.outbox.length, 1);
  assert.equal(c.ledger.list()[0].status, 'verified');
  assert.notEqual(c.store.state.tasks[task.id].status, 'completed');
  assert.equal(c.store.state.tasks[task.id].inputVersion, c.store.state.tasks[task.id].processedInputVersion);
});

test('durable native and MCP reads enforce the current read policy before invoking the tool', async t => {
  const c = setup(t), current = run(c);
  let calls = 0;
  c.engine.policy.rules.observe = { requiresApproval: true };
  for (const provider of ['document_store', 'mcp']) {
    const [tool] = c.runtime.wrapReadTools([{ name: 'read_authorized_content', execute: async () => { calls++; return { content: [] }; } }], current.taskId, { provider });
    await assert.rejects(c.runtime.scope.run({ ...current }, () => tool.execute(provider, {}, new AbortController().signal)), /approval|authoriz/i);
  }
  assert.equal(calls, 0);
});
