import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { durableError, iso } from '../src/durable/database.js';
import { reasoningFailure, reasoningMayResume } from '../src/reasoning-recovery.js';

const error = () => Object.assign(durableError('TOKEN_BUDGET_EXHAUSTED', 'PRIVATE budget detail', 429), {
  retryAt: iso(Date.now() + 3600000), detail: { blockedScopes: ['workspace'] }
});
const email = { id: 'budget-email', type: 'email.received', payload: {
  id: 'budget-message', threadId: 'budget-thread', from: 'person@example.test', subject: 'Cedar proposal',
  body: 'Please update the Cedar proposal with experiment results.'
} };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-budget-'));
  const store = new SqliteStore(path.join(dir, 'state.json'));
  const flags = { blocked: true, calls: 0 };
  const reasoner = { id: 'synthetic', available: () => true, preferModelInterpretation: true,
    async interpretRequest() {
      flags.calls++;
      if (flags.blocked) throw error();
      return { deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update',
        requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results', sourceField: 'body' }] };
    }, async proposeProbes() { return []; } };
  const engine = new WorkEngine(store, { reasoner });
  const runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, engine, runtime, flags, beforeCleanup: cleanup => cleanups.push(cleanup) };
}

test('real engine and worker persist quota waits on the same job beyond ordinary retry limits', async t => {
  const { store, engine, runtime, flags } = fixture(t);
  engine.ingest(email); await engine.whenSettled(); await runtime.whenIdle();
  const taskId = 'request:budget-message';
  let task = store.state.tasks[taskId];
  assert.equal(task.reasoningWork.status, 'budget_deferred');
  let job = store.jobs.list({ taskId }).find(item => item.last_error_class === 'budget');
  assert.ok(job, 'the worker must persist a budget wait instead of completing the job');
  assert.equal(job.state, 'retry_wait');
  const id = job.id, key = task.reasoningWork.key;
  store.database.db.prepare('UPDATE jobs SET max_attempts=2 WHERE id=?').run(id);
  for (let expected = 2; expected <= 5; expected++) {
    assert.equal(engine.retryPendingReasoning(taskId).tasks, 0, 'manual retry without a real wake cannot bypass the wait');
    const wake = store.jobs.startBudgetWake({ key: `quota-adjustment:${expected}`, kind: 'token', taskId });
    store.jobs.wakeBudgetDeferred({ eventId: wake.id });
    runtime.kick(); await runtime.whenIdle(); await engine.whenSettled();
    job = store.jobs.get(id); task = store.state.tasks[taskId];
    assert.equal(job.state, 'retry_wait');
    assert.equal(job.budget_deferrals, expected);
    assert.equal(job.attempts, expected);
    assert.equal(task.reasoningWork.key, key);
    assert.equal(task.reasoningWork.attempts, expected);
    assert.equal(task.reasoningWork.budgetDeferrals, expected);
    assert.equal(task.reasoningWork.status, 'budget_deferred');
    assert.notEqual(task.status, 'completed');
    assert.notEqual(task.status, 'ready_for_approval');
  }
  assert.equal(flags.calls, 5);
  assert.equal(store.state.outbox.length, 0);
  assert.equal(JSON.stringify(task.reasoningWork).includes('PRIVATE'), false);
  flags.blocked = false;
  const wake = store.jobs.startBudgetWake({ key: 'quota-repaired', kind: 'token', taskId });
  store.jobs.wakeBudgetDeferred({ eventId: wake.id });
  runtime.kick(); await runtime.whenIdle(); await engine.whenSettled();
  assert.equal(store.jobs.get(id).state, 'completed');
  assert.equal(store.state.tasks[taskId].modelReview.status, 'verified');
  assert.equal(flags.calls, 6);
});

test('old-owner quota checkpoint rolls back its task projection and cannot defer the replacement job', async t => {
  const { store, runtime } = fixture(t);
  const made = store.jobs.enqueue({ type: 'synthetic', key: 'old-budget-owner' });
  const old = store.jobs.claim('old', { id: made.id });
  store.database.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(iso(Date.now() - 1), old.id);
  store.jobs.expire();
  store.jobs.recover(old.id, () => ({ state: 'queued', safeToRepeat: true }));
  const fresh = store.jobs.claim('fresh', { id: old.id });
  assert.throws(() => runtime.scope.run({ job: old }, () => store.mutate(state => {
    state.budgetRollbackMarker = true;
  }, runtime.reasoningFailureCommitOptions(error()))), { code: 'LEASE_LOST' });
  assert.equal(store.state.budgetRollbackMarker, undefined);
  assert.equal(store.jobs.get(fresh.id).state, 'running');
  assert.equal(store.jobs.get(fresh.id).budget_deferrals, 0);
});

test('ordinary provider failures retain the original engine ceiling after repeated budget waits', async t => {
  const { store, engine, runtime } = fixture(t);
  const taskId = 'request:budget-message';
  engine.ingest(email); await engine.whenSettled(); await runtime.whenIdle();
  const extraWait = store.jobs.startBudgetWake({ key: 'second-wait', kind: 'token', taskId });
  store.jobs.wakeBudgetDeferred({ eventId: extraWait.id });
  runtime.kick(); await runtime.whenIdle(); await engine.whenSettled();
  assert.equal(store.state.tasks[taskId].reasoningWork.budgetDeferrals, 2);
  let providerFailures = 0;
  engine.reasoner.interpretRequest = async () => { providerFailures++; throw Object.assign(new Error('provider unavailable'), { status: 503 }); };
  const wake = store.jobs.startBudgetWake({ key: 'admission-now-possible', kind: 'token', taskId });
  store.jobs.wakeBudgetDeferred({ eventId: wake.id });
  runtime.kick(); await runtime.whenIdle(); await engine.whenSettled();
  assert.equal(providerFailures, 1);
  assert.equal(store.state.tasks[taskId].reasoningWork.terminalReason, null);
  // Advance the persisted retry deadline, without spending real time in this test.
  store.mutate(state => { state.tasks[taskId].reasoningWork.retryAt = iso(Date.now() - 1); });
  engine.retryPendingReasoning(taskId); await engine.whenSettled(); await runtime.whenIdle();
  assert.equal(providerFailures, 2);
  assert.equal(store.state.tasks[taskId].reasoningWork.terminalReason, 'attempts_exhausted');
  assert.equal(store.state.tasks[taskId].reasoningWork.budgetDeferrals, 2);
  assert.equal(engine.retryPendingReasoning(taskId).tasks, 0);
});

test('a failed atomic handoff stays a real worker failure and cannot become a completed model job', async t => {
  const { store, engine, runtime } = fixture(t);
  const original = store.jobs.fail.bind(store.jobs);
  let injected = false;
  store.jobs.fail = (job, failure) => {
    if (!injected && failure.code === 'TOKEN_BUDGET_EXHAUSTED') {
      injected = true;
      throw Object.assign(new Error('synthetic checkpoint failure'), { code: 'SQLITE_BUSY' });
    }
    return original(job, failure);
  };
  engine.ingest(email); await engine.whenSettled(); await runtime.whenIdle();
  assert.equal(injected, true);
  const job = store.jobs.list({ taskId: 'request:budget-message' }).find(item => item.last_error_class === 'retryable');
  assert.ok(job, 'the captured transaction failure must reach DurableWorker');
  assert.equal(job.state, 'retry_wait');
  assert.equal(job.budget_deferrals, 0, 'the rolled-back handoff cannot leave a partial budget credit');
  assert.notEqual(store.state.tasks['request:budget-message'].status, 'completed');
  assert.equal(store.state.outbox.length, 0);
});

test('optional probe reasoning also checkpoints its budget wait atomically', async t => {
  const { store, engine, runtime } = fixture(t);
  engine.reasoner.preferModelInterpretation = false;
  engine.reasoner.proposeProbes = async () => { throw error(); };
  engine.externalTools = () => [{ name: 'synthetic_read', effect: 'read', parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: 'synthetic' }] }) }];
  engine.ingest(email); await engine.whenSettled(); await runtime.whenIdle();
  const task = store.state.tasks['request:budget-message'];
  assert.equal(task.reasoningWork.kind, 'probes');
  assert.equal(task.reasoningWork.status, 'budget_deferred');
  assert.equal(task.reasoning.status, 'budget_deferred');
  assert.ok(store.jobs.list({ taskId: task.id }).some(job => job.state === 'retry_wait' && job.last_error_class === 'budget'));
  assert.notEqual(task.status, 'ready_for_approval');
});

test('grounded discovery budget waits do not turn into no-candidate or completed jobs', async t => {
  const { store, engine, runtime } = fixture(t);
  engine.reasoner.discoverRequestCandidate = async () => { throw error(); };
  engine.ingest({ ...email, id: 'discovery-budget-event', payload: { ...email.payload, subject: 'project update',
    body: 'Please update the proposal for northstar with experiment results.' } });
  await engine.whenSettled(); await runtime.whenIdle();
  const event = store.state.events.find(item => item.id === 'discovery-budget-event');
  assert.equal(event.reasoning.status, 'budget_deferred');
  assert.equal(Object.keys(store.state.tasks).length, 0);
  const job = store.jobs.list().find(item => item.job_type === 'discovery');
  assert.equal(job.state, 'retry_wait');
  assert.equal(job.last_error_class, 'budget');
  assert.equal(job.budget_deferrals, 1);
});

test('a persisted engine budget wait resumes the same job after closing and reopening SQLite', async t => {
  const { store, engine, runtime, flags, beforeCleanup } = fixture(t);
  engine.ingest(email); await engine.whenSettled(); await runtime.whenIdle();
  const taskId = 'request:budget-message';
  const saved = store.jobs.list({ taskId }).find(job => job.last_error_class === 'budget');
  assert.ok(saved);
  const key = store.state.tasks[taskId].reasoningWork.key;
  const filename = store.filename;
  await runtime.close(); store.close();
  const reopened = new SqliteStore(filename);
  const resumedEngine = new WorkEngine(reopened, { reasoner: { ...engine.reasoner, onUsage: null } });
  const resumedRuntime = new DurableRuntime(resumedEngine, { tickMs: 1000000 });
  beforeCleanup(async () => { await resumedRuntime.close(); await resumedEngine.whenSettled(); reopened.close(); });
  assert.equal(reopened.jobs.get(saved.id).state, 'retry_wait');
  assert.equal(reopened.state.tasks[taskId].reasoningWork.key, key);
  assert.equal(resumedEngine.retryPendingReasoning(taskId).tasks, 0);
  flags.blocked = false;
  const wake = reopened.jobs.startBudgetWake({ key: 'after-restart-repair', kind: 'token', taskId });
  reopened.jobs.wakeBudgetDeferred({ eventId: wake.id });
  resumedRuntime.kick(); await resumedRuntime.whenIdle(); await resumedEngine.whenSettled();
  assert.equal(reopened.jobs.get(saved.id).state, 'completed');
  assert.equal(reopened.jobs.get(saved.id).attempts, saved.attempts + 1);
  assert.equal(reopened.state.tasks[taskId].modelReview.status, 'verified');
});

test('an unrelated current job cannot receive another invocation’s budget failure', t => {
  const { store, runtime } = fixture(t);
  const first = store.jobs.enqueue({ type: 'synthetic', key: 'first-owner' });
  const second = store.jobs.enqueue({ type: 'synthetic', key: 'second-owner' });
  const a = store.jobs.claim('a', { id: first.id });
  const b = store.jobs.claim('b', { id: second.id });
  assert.throws(() => runtime.scope.run({ job: b }, () => store.mutate(state => {
    state.wrongOwnerMarker = true;
  }, runtime.reasoningFailureCommitOptions(error(), { jobId: a.id, leaseToken: a.lease_token }))), { code: 'LEASE_LOST' });
  assert.equal(store.state.wrongOwnerMarker, undefined);
  assert.equal(store.jobs.get(a.id).state, 'running');
  assert.equal(store.jobs.get(b.id).state, 'running');
});

test('budget retry policy retains ordinary failures and never invents a cumulative lease reset', () => {
  const original = { attempts: 8, budgetDeferrals: 7, maxAttempts: 2 };
  const firstFailure = reasoningFailure({ status: 503 }, original, 1000);
  assert.equal(firstFailure.terminalReason, null);
  assert.equal(Date.parse(firstFailure.retryAt), 31000);
  const exhausted = reasoningFailure({ status: 503 }, { ...original, attempts: 9 }, 1000);
  assert.equal(exhausted.terminalReason, 'attempts_exhausted');
  const lease = Object.assign(error(), { code: 'MONEY_BUDGET_EXHAUSTED', detail: { blockedScopes: ['workspace', 'lease'] } });
  const wait = reasoningFailure(lease, { attempts: 1, maxAttempts: 2 }, 1000);
  assert.equal(wait.status, 'budget_deferred');
  assert.equal(wait.retryAt, null);
  assert.equal(reasoningMayResume({ attempts: 1, maxAttempts: 2, ...wait }, Date.now()), false);
  assert.equal(reasoningMayResume({ attempts: 1, maxAttempts: 2, ...wait }, Date.now(), { budgetWake: true }), true);
});
