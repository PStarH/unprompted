import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs, DurableWorker } from '../src/durable/jobs.js';

/**
 * The durable queue must stay bounded even when a handler never returns.
 *
 * These tests cover the worker deadline, the ambiguous rule for in-flight
 * writes, and the recovery escalation that reaches a terminal state.
 */
function fixture(t) {
  let now = Date.parse('2026-11-11T00:00:00.000Z');
  const database = new DurableDatabase(':memory:', { now: () => now });
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 });
  t.after(() => database.close());
  return { database, jobs, advance: ms => { now += ms; }, at: () => iso(now) };
}
const hang = () => new Promise(() => {});

test('a handler that never settles cannot block the queue', async t => {
  const { jobs, advance } = fixture(t);
  // Make the hanging job unambiguously first in availability order.
  const first = jobs.enqueue({ type: 'hang', key: 'first', availableAt: iso(Date.parse('2026-11-11T00:00:00.000Z') - 1000) });
  const second = jobs.enqueue({ type: 'work', key: 'second' });
  let release;
  const stuck = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const worker = new DurableWorker({ jobs, queue: 'tasks', deadlines: { hang: 40, work: 40 },
    handlers: { hang: async () => { calls += 1; await stuck; }, work: async () => { calls += 1; } } });
  const started = Date.now();
  assert.equal(await worker.tick(), true);
  assert.ok(Date.now() - started < 5000, 'the tick returned at the deadline instead of waiting for the handler');
  const timedOut = jobs.get(first.id);
  assert.equal(timedOut.state, 'retry_wait');
  assert.equal(timedOut.last_error_class, 'retryable');
  // The retired attempt is parked until its backoff elapses, so the next job runs.
  assert.ok(timedOut.available_at > timedOut.updated_at);
  assert.equal(await worker.tick(), true);
  assert.equal(jobs.get(second.id).state, 'completed');
  assert.equal(calls, 2);
  release();
  advance(0);
  await worker.close();
});

test('a timeout with an unresolved write is ambiguous, never retried', async t => {
  const { database, jobs } = fixture(t);
  const job = jobs.enqueue({ type: 'external_dispatch', key: 'dispatch' });
  const claimed = jobs.claim('worker');
  database.atomic(() => database.db.prepare(`INSERT INTO tool_executions(id,task_id,task_run_id,job_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES('execution-1',NULL,NULL,?,?,?,?,?,?,?,'intent',1,0,0,0,?,?)`)
    .run(claimed.id, 'fixture', 'send', 'fixture.send', 'resource', 'key', '{}', iso(database.now()), iso(database.now())));
  jobs.claim('other');
  // Hand the job back so the worker claims it itself.
  database.atomic(() => database.db.prepare("UPDATE jobs SET state='queued',lease_owner=NULL,lease_until=NULL WHERE id=?").run(job.id));
  const worker = new DurableWorker({ jobs, queue: 'tasks', deadlines: { external_dispatch: 40 }, handlers: { external_dispatch: hang } });
  await worker.tick();
  const failed = jobs.get(job.id);
  assert.equal(failed.state, 'recovery_required');
  assert.equal(failed.last_error_class, 'ambiguous');
  assert.equal(database.db.prepare("SELECT status FROM tool_executions WHERE id='execution-1'").get().status, 'intent');
});

test('the handler receives an aborted signal carrying the deadline reason', async t => {
  const { jobs } = fixture(t);
  jobs.enqueue({ type: 'hang', key: 'signal' });
  let seen = null;
  const aborted = new Promise(resolve => {
    const worker = new DurableWorker({ jobs, queue: 'tasks', deadlines: { hang: 40 }, handlers: { hang: async (job, { signal }) => {
      signal.addEventListener('abort', () => { seen = { aborted: signal.aborted, code: signal.reason?.code }; resolve(); }, { once: true });
      await hang();
    } } });
    t.after(() => worker.close());
    worker.tick().catch(() => {});
  });
  await aborted;
  assert.deepEqual(seen, { aborted: true, code: 'JOB_TIMEOUT' });
});

test('recovery attempts are bounded and end in a dead letter', async t => {
  const { jobs, advance } = fixture(t);
  const job = jobs.enqueue({ type: 'work', key: 'recovery', maxAttempts: 3 });
  jobs.db.prepare("UPDATE jobs SET state='recovery_required',available_at=? WHERE id=?").run(iso(Date.parse('2026-11-11T00:00:00.000Z') - 1000), job.id);
  const first = jobs.deferRecovery(job.id, 0);
  assert.equal(first.state, 'recovery_required');
  assert.equal(jobs.get(job.id).attempts, 1);
  // A duplicate call in the same cycle is a no-op, not a second attempt.
  assert.equal(jobs.deferRecovery(job.id, 0).state, 'unchanged');
  assert.equal(jobs.get(job.id).attempts, 1);
  advance(5 * 60000);
  assert.equal(jobs.deferRecovery(job.id, 0).state, 'recovery_required');
  assert.equal(jobs.get(job.id).attempts, 2);
  advance(5 * 60000);
  assert.equal(jobs.deferRecovery(job.id, 0).state, 'dead');
  const dead = jobs.get(job.id);
  assert.equal(dead.state, 'dead');
  assert.equal(dead.dead_letter_reason, 'recovery_unresolved');
  assert.equal(dead.lease_until, null);
});

test('a recovery that keeps failing notifies the dead-letter hook once', async t => {
  const { jobs } = fixture(t);
  const job = jobs.enqueue({ type: 'work', key: 'hook', maxAttempts: 1 });
  jobs.db.prepare("UPDATE jobs SET state='recovery_required' WHERE id=?").run(job.id);
  let dead = 0;
  const worker = new DurableWorker({ jobs, queue: 'tasks', recovery: async () => { throw new Error('provider still unknown'); },
    recoveryDeadlineMs: 40, handlers: { work: async () => {} }, onDead: () => { dead += 1; } });
  await worker.tick();
  assert.equal(jobs.get(job.id).state, 'dead');
  assert.equal(jobs.get(job.id).dead_letter_reason, 'recovery_unresolved');
  assert.equal(dead, 1);
  // A second tick has nothing due and must not call the hook again.
  await worker.tick();
  assert.equal(dead, 1);
});

test('a recovery that never returns is deferred instead of blocking the queue', async t => {
  const { jobs } = fixture(t);
  const job = jobs.enqueue({ type: 'work', key: 'stuck-recovery' });
  jobs.db.prepare("UPDATE jobs SET state='recovery_required' WHERE id=?").run(job.id);
  const queued = jobs.enqueue({ type: 'work', key: 'after-recovery' });
  const worker = new DurableWorker({ jobs, queue: 'tasks', recovery: hang, recoveryDeadlineMs: 40, handlers: { work: async () => {} } });
  const started = Date.now();
  assert.equal(await worker.tick(), true);
  assert.ok(Date.now() - started < 5000, 'recovery was bounded');
  assert.equal(jobs.get(job.id).state, 'recovery_required');
  assert.equal(jobs.get(job.id).attempts, 1);
  assert.equal(jobs.get(queued.id).state, 'completed');
});

test('worker deadlines must be positive', t => {
  const { jobs } = fixture(t);
  assert.throws(() => new DurableWorker({ jobs, deadlineMs: 0 }), /positive milliseconds/);
  assert.throws(() => new DurableWorker({ jobs, deadlines: { work: -1 } }), /positive milliseconds/);
});
