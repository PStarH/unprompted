import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, durableError } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';

function fixture(t) {
  const clock = { now: Date.parse('2026-11-13T12:00:00Z') };
  const database = new DurableDatabase(':memory:', { now: () => clock.now });
  const jobs = new DurableJobs(database), budget = new TokenBudgetService(database);
  budget.attachWakeQueue(jobs); t.after(() => database.close());
  return { clock, database, jobs, budget };
}
const reserve = (budget, attemptId, taskId = null) => budget.reserve({ attemptId, taskId, inputTokens: 30, outputTokens: 70 });

test('only a real limit increase creates a scoped capacity fact, including finite to unlimited', t => {
  const { jobs, budget } = fixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 0 });
  assert.equal(jobs.pendingBudgetWakes().length, 0);
  budget.setLimit({ scope: 'workspace', tokens: 100 });
  budget.setLimit({ scope: 'workspace', tokens: 100 });
  budget.setLimit({ scope: 'workspace', tokens: 50 });
  assert.equal(jobs.pendingBudgetWakes().length, 1);
  budget.setLimit({ scope: 'workspace', tokens: null });
  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 0 });
  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 200 });
  const facts = jobs.pendingBudgetWakes();
  assert.equal(facts.length, 3); assert.equal(facts[2].task_id, 'task-a');
  assert.equal(facts[0].task_id, null);
});

test('true settlement and pre-dispatch cancellation release workspace capacity once; unknown and overrun never refund', t => {
  const { jobs, budget } = fixture(t);
  reserve(budget, 'small', 'task-a'); budget.markDispatched('small');
  budget.settle('small', { input: 10, output: 5 }); budget.settle('small', { input: 10, output: 5 });
  reserve(budget, 'cancelled'); budget.cancelBeforeDispatch('cancelled'); budget.cancelBeforeDispatch('cancelled');
  reserve(budget, 'unknown'); budget.markDispatched('unknown'); budget.markUnknown('unknown');
  reserve(budget, 'overrun'); budget.markDispatched('overrun'); budget.settle('overrun', { input: 100, output: 50 });
  const facts = jobs.pendingBudgetWakes();
  assert.equal(facts.length, 2);
  assert.ok(facts.every(row => /^token-capacity:[a-f0-9]{64}$/.test(row.wake_key)));
  assert.notEqual(facts[0].wake_key, facts[1].wake_key);
  assert.ok(facts.every(row => row.task_id === null && row.kind === 'token'));
  assert.equal(budget.describe().workspace.unknown, 100);
});

test('yesterday settlements and cancellations do not wake today jobs', t => {
  const { jobs, budget, clock } = fixture(t);
  reserve(budget, 'old-settle'); budget.markDispatched('old-settle'); reserve(budget, 'old-cancel');
  clock.now += 86400000;
  budget.settle('old-settle', { input: 1, output: 1 }); budget.cancelBeforeDispatch('old-cancel');
  assert.equal(jobs.pendingBudgetWakes().length, 0);
});

test('failure to persist the wake rolls back both policy and accounting release', t => {
  const { database, jobs, budget } = fixture(t);
  reserve(budget, 'rollback-cancel'); reserve(budget, 'rollback-settle'); budget.markDispatched('rollback-settle');
  budget.setLimit({ scope: 'workspace', tokens: 200 });
  database.db.exec("CREATE TRIGGER block_wake BEFORE INSERT ON job_budget_wakes BEGIN SELECT RAISE(ABORT,'wake unavailable'); END");
  assert.throws(() => budget.setLimit({ scope: 'workspace', tokens: 1000 }), /wake unavailable/);
  assert.equal(budget.describe().workspace.limit, 200);
  assert.throws(() => budget.cancelBeforeDispatch('rollback-cancel'), /wake unavailable/);
  assert.throws(() => budget.settle('rollback-settle', { input: 1, output: 1 }), /wake unavailable/);
  const rows = database.db.prepare('SELECT state FROM token_budget_reservations ORDER BY attempt_id').all();
  assert.deepEqual(rows.map(row => row.state), ['reserved', 'dispatched']);
  assert.equal(jobs.pendingBudgetWakes().length, 0);
});

test('a workspace wake cannot be attached to another database', t => {
  const a = fixture(t), b = fixture(t);
  assert.throws(() => a.budget.attachWakeQueue(b.jobs), { code: 'INVALID_TOKEN_BUDGET' });
});

test('bounded pending batches resume across reopen without reawakening previous quota losers', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-wake-restart-'));
  const filename = path.join(directory, 'state.sqlite');
  let database = new DurableDatabase(filename), jobs = new DurableJobs(database);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 55; i++) {
    const job = jobs.enqueue({ type: 'model', key: `waiting-${i}` });
    const claim = jobs.claim('worker', { id: job.id });
    jobs.fail(claim, Object.assign(durableError('TOKEN_BUDGET_EXHAUSTED', 'fixture', 429), { detail: { blockedScopes: ['workspace'] } }));
  }
  const budget = new TokenBudgetService(database); budget.attachWakeQueue(jobs);
  budget.setLimit({ scope: 'workspace', tokens: 0 }); budget.setLimit({ scope: 'workspace', tokens: 1000 });
  const event = jobs.pendingBudgetWakes()[0];
  const first = jobs.wakeBudgetDeferred({ eventId: event.id, limit: 50 });
  assert.equal(first.woken.length, 50); assert.equal(first.hasMore, true);
  const retried = jobs.claim('retry', { id: first.woken[0] });
  jobs.fail(retried, durableError('TOKEN_BUDGET_EXHAUSTED', 'fixture', 429));
  database.close(); database = new DurableDatabase(filename); jobs = new DurableJobs(database);
  assert.equal(jobs.pendingBudgetWakes()[0].id, event.id);
  const second = jobs.wakeBudgetDeferred({ eventId: event.id, limit: 50 });
  assert.equal(second.woken.length, 5); assert.equal(second.hasMore, false);
  assert.ok(!second.woken.includes(retried.id)); assert.equal(jobs.pendingBudgetWakes().length, 0);
});


test('capacity facts accept the full ledger identifier domain without prefix overflow or lossy key collisions', t => {
  const { jobs, budget } = fixture(t);
  for (const id of ['x'.repeat(200), 'identifier\nwith-control']) {
    reserve(budget, id); budget.cancelBeforeDispatch(id);
  }
  assert.equal(new Set(jobs.pendingBudgetWakes({ limit: 10 }).map(row => row.wake_key)).size, 2);
  const taskId = 'task\n' + 'x'.repeat(195);
  budget.setLimit({ scope: 'task', taskId, tokens: 0 }); budget.setLimit({ scope: 'task', taskId, tokens: 1 });
  assert.equal(jobs.pendingBudgetWakes({ limit: 10 }).at(-1).task_id, taskId);
});
