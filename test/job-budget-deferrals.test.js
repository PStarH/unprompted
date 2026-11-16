import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, durableError, iso } from '../src/durable/database.js';
import { DurableJobs, DurableWorker } from '../src/durable/jobs.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';

const start = Date.parse('2026-11-13T12:00:00.000Z');
const reset = '2026-11-14T00:00:00.000Z';
const quota = (money = false, lease = false) => Object.assign(durableError(
  money ? 'MONEY_BUDGET_EXHAUSTED' : 'TOKEN_BUDGET_EXHAUSTED',
  'PRIVATE prompt must not be persisted', 429
), { retryAt: reset, detail: {
  kind: money ? 'transaction' : undefined,
  day: '2026-11-13', blockedScopes: lease ? ['workspace', 'lease'] : ['workspace'],
  resetsAt: lease ? null : reset, dayResetsAt: reset, prompt: 'PRIVATE nested data'
} });

function fixture(t) {
  let now = start;
  const database = new DurableDatabase(':memory:', { now: () => now });
  const jobs = new DurableJobs(database, { random: () => 0.5 });
  t.after(() => database.close());
  return { database, jobs, advance: ms => { now += ms; }, set: value => { now = value; } };
}

function wake(jobs, id) {
  // Models a trusted future wake service; production epoch wake is phase60.
  jobs.db.prepare('UPDATE jobs SET available_at=? WHERE id=?').run(iso(jobs.database.now()), id);
}

test('quota deferrals preserve monotonic attempts, without spending ordinary failure retries', t => {
  const { jobs, advance } = fixture(t);
  const job = jobs.enqueue({ type: 'work', key: 'budget', maxAttempts: 2 });
  let previousToken = 0;
  for (let n = 1; n <= 5; n++) {
    const current = jobs.claim('worker');
    assert.ok(current, 'quota waits may exceed maxAttempts');
    assert.equal(current.attempts, n);
    assert.ok(current.lease_token > previousToken);
    previousToken = current.lease_token;
    const deferred = jobs.fail(current, quota());
    assert.equal(deferred.state, 'retry_wait');
    assert.equal(deferred.last_error_class, 'budget');
    assert.equal(deferred.budget_deferrals, n);
    assert.equal(deferred.dead_letter_reason, null);
    assert.equal(jobs.claim('early'), null);
    assert.throws(() => jobs.fail(current, quota()), { code: 'LEASE_LOST' });
    assert.equal(jobs.get(job.id).budget_deferrals, n);
    wake(jobs, job.id);
  }
  let running = jobs.claim('worker');
  // The stored row, not altered caller counters, governs retry admission.
  const first = jobs.fail({ ...running, attempts: 999, budget_deferrals: 0 }, { status: 503 });
  assert.equal(first.state, 'retry_wait');
  assert.equal(Date.parse(first.available_at) - jobs.database.now(), 1000);
  advance(1000);
  running = jobs.claim('worker');
  assert.equal(jobs.fail(running, { status: 503 }).state, 'dead');
  assert.equal(jobs.get(job.id).dead_letter_reason, 'attempts_exhausted');
});

test('real worker parks quota, runs another job, and resumes the same job after UTC reset', async t => {
  const { jobs, set } = fixture(t);
  const waiting = jobs.enqueue({ id: 'a', type: 'model', key: 'model', maxAttempts: 1 });
  const other = jobs.enqueue({ id: 'b', type: 'work', key: 'other' });
  let blocked = true, calls = 0;
  const worker = new DurableWorker({ jobs, handlers: {
    model: async () => { calls++; if (blocked) throw quota(); }, work: async () => {}
  } });
  t.after(() => worker.close());
  await worker.tick();
  assert.equal(jobs.get(waiting.id).state, 'retry_wait');
  await worker.tick();
  assert.equal(jobs.get(other.id).state, 'completed');
  assert.equal(await worker.tick(), false);
  blocked = false;
  set(Date.parse(reset));
  await worker.tick();
  assert.equal(jobs.get(waiting.id).state, 'completed');
  assert.equal(jobs.get(waiting.id).budget_metadata_json, null);
  assert.equal(jobs.get(waiting.id).last_error_class, null);
  assert.equal(jobs.get(waiting.id).attempts, 2);
  assert.equal(calls, 2);
});

test('an actual zero-budget ledger error defers before provider work and completes after reset', async t => {
  const { database, jobs, set } = fixture(t);
  const budget = new TokenBudgetService(database);
  budget.setLimit({ scope: 'workspace', tokens: 0 });
  const job = jobs.enqueue({ type: 'model', key: 'real-ledger', maxAttempts: 1 });
  let providerCalls = 0;
  const worker = new DurableWorker({ jobs, handlers: { model: async current => {
    budget.reserve({ attemptId: `actual:${current.lease_token}`, inputTokens: 1, outputTokens: 1 });
    providerCalls++;
  } } });
  t.after(() => worker.close());
  await worker.tick();
  assert.equal(providerCalls, 0);
  assert.equal(jobs.get(job.id).available_at, reset);
  assert.deepEqual(JSON.parse(jobs.get(job.id).budget_metadata_json).blockedScopes, ['workspace']);
  budget.setLimit({ scope: 'workspace', tokens: 2 });
  set(Date.parse(reset));
  await worker.tick();
  assert.equal(providerCalls, 1);
  assert.equal(jobs.get(job.id).state, 'completed');
});

test('mixed cumulative lease exhaustion never uses partial day reset or unsafe metadata', t => {
  const { jobs, set } = fixture(t);
  const job = jobs.enqueue({ type: 'work', key: 'lease' });
  const deferred = jobs.fail(jobs.claim('worker'), quota(true, true));
  assert.equal(deferred.state, 'retry_wait');
  assert.equal(deferred.available_at, '9999-12-31T23:59:59.999Z');
  assert.equal(JSON.parse(deferred.budget_metadata_json).resetsAt, null);
  assert.equal(deferred.budget_metadata_json.includes('PRIVATE'), false);
  assert.equal(JSON.parse(deferred.budget_metadata_json).kind, 'transaction');
  set(Date.parse(reset));
  assert.equal(jobs.claim('worker'), null);
  assert.equal(jobs.get(job.id).attempts, 1);
});

test('missing, past or malformed reset parks; provider429 and store errors remain ordinary failures', t => {
  const { jobs } = fixture(t);
  for (const retryAt of [undefined, 'bad', iso(start - 1)]) {
    const job = jobs.enqueue({ type: 'work', key: String(retryAt) });
    const error = quota(); error.retryAt = retryAt; error.detail.resetsAt = retryAt;
    assert.equal(jobs.fail(jobs.claim('worker'), error).available_at, '9999-12-31T23:59:59.999Z');
    assert.equal(jobs.get(job.id).budget_deferrals, 1);
  }
  for (const error of [{ status: 429 }, { code: 'SQLITE_BUSY' }, { code: 'INVALID_CONTEXT' }]) {
    const job = jobs.enqueue({ type: 'work', key: error.code || 'provider', maxAttempts: 1 });
    assert.equal(jobs.fail(jobs.claim('worker'), error).state, 'dead');
    assert.equal(jobs.get(job.id).budget_deferrals, 0);
  }
});

test('old lease cannot defer, and an unresolved external write keeps recovery precedence', t => {
  const { jobs, advance } = fixture(t);
  const original = jobs.enqueue({ type: 'work', key: 'old' });
  const old = jobs.claim('old');
  advance(30001); jobs.expire();
  jobs.recover(original.id, () => ({ state: 'queued', safeToRepeat: true }));
  const current = jobs.claim('new');
  assert.throws(() => jobs.fail(old, quota()), { code: 'LEASE_LOST' });
  jobs.db.prepare(`INSERT INTO tool_executions(id,job_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES('write',?,'fixture','send','send','resource','write','{}','unknown',1,0,0,0,?,?)`)
    .run(current.id, iso(jobs.database.now()), iso(jobs.database.now()));
  const failed = jobs.fail(current, quota());
  assert.equal(failed.state, 'recovery_required');
  assert.equal(failed.last_error_class, 'ambiguous');
  assert.equal(failed.budget_deferrals, 0);
});

test('recovery and its backoff count real failures after many budget deferrals', t => {
  const { jobs, advance } = fixture(t);
  const job = jobs.enqueue({ type: 'work', key: 'recover', maxAttempts: 4 });
  for (let i = 0; i < 6; i++) { jobs.fail(jobs.claim('worker'), quota()); wake(jobs, job.id); }
  jobs.claim('expired'); advance(30001); jobs.expire();
  assert.equal(jobs.recover(job.id, () => ({ state: 'queued', safeToRepeat: true })).state, 'queued');
  jobs.claim('expired-again'); advance(30001); jobs.expire();
  const deferred = jobs.deferRecovery(job.id, jobs.get(job.id).lease_token);
  assert.equal(deferred.state, 'recovery_required');
  assert.equal(Date.parse(deferred.job.available_at) - jobs.database.now(), 120000);
  advance(120000);
  assert.equal(jobs.deferRecovery(job.id, deferred.job.lease_token).state, 'dead');
});

test('task-run-only unresolved write is fenced, while a safe quota wait leaves the new run waiting', t => {
  const { database, jobs } = fixture(t);
  const at = iso(database.now());
  jobs.db.prepare("INSERT INTO tasks(id,data_json,status,created_at,updated_at) VALUES('task','{}','active',?,?)").run(at, at);
  const job = jobs.enqueue({ type: 'work', key: 'task-run', taskId: 'task' });
  let current = jobs.claim('worker');
  const addRun = id => jobs.db.prepare(`INSERT INTO task_runs(id,task_id,job_id,job_lease_token,input_version,run_generation,privacy_epoch,status,created_at,updated_at)
    VALUES(?,'task',?,?,0,1,0,'running',?,?)`).run(id, current.id, current.lease_token, at, at);
  addRun('run1');
  jobs.db.prepare(`INSERT INTO tool_executions(id,task_run_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES('run-write','run1','fixture','send','send','resource','run-write','{}','unknown',1,0,1,0,?,?)`).run(at, at);
  assert.equal(jobs.fail(current, quota()).state, 'recovery_required');
  assert.equal(jobs.db.prepare("SELECT status FROM task_runs WHERE id='run1'").get().status, 'recovery_required');
  jobs.db.prepare("UPDATE tool_executions SET status='verified' WHERE id='run-write'").run();
  jobs.recover(job.id, () => ({ state: 'queued', safeToRepeat: true }));
  current = jobs.claim('next');
  addRun('run2');
  assert.equal(jobs.fail(current, quota()).state, 'retry_wait');
  assert.equal(jobs.db.prepare("SELECT status FROM task_runs WHERE id='run2'").get().status, 'waiting');
  assert.equal(jobs.get(job.id).budget_deferrals, 1);
});

test('additive old-database upgrade and repeated service creation preserve all job counters', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-budget-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workspace.sqlite');
  let database = new DurableDatabase(file, { now: () => start });
  const schemaVersion = database.db.pragma('user_version', { simple: true });
  let jobs = new DurableJobs(database);
  const job = jobs.enqueue({ type: 'work', key: 'retained' });
  jobs.claim('worker');
  // The baseline columns are the genuine old schema; strip only additive draft columns.
  database.db.exec('ALTER TABLE jobs DROP COLUMN budget_metadata_json');
  database.db.exec('ALTER TABLE jobs DROP COLUMN budget_deferrals');
  database.db.exec('ALTER TABLE jobs DROP COLUMN budget_wake_epoch');
  database.db.exec('ALTER TABLE jobs DROP COLUMN budget_claim_epoch');
  database.db.exec('DROP TABLE job_budget_wakes');
  database.close();
  database = new DurableDatabase(file, { now: () => start });
  t.after(() => database.close());
  jobs = new DurableJobs(database);
  assert.equal(jobs.get(job.id).attempts, 1);
  assert.equal(jobs.get(job.id).lease_token, 1);
  assert.equal(jobs.get(job.id).budget_deferrals, 0);
  jobs.fail(jobs.get(job.id), quota());
  jobs = new DurableJobs(database);
  assert.equal(jobs.get(job.id).budget_deferrals, 1);
  assert.equal(database.db.pragma('user_version', { simple: true }), schemaVersion, 'additive budget storage must preserve the formal workspace schema version');
});


test('native terminal reasoning does not trust a provider flag and preserves unresolved-write recovery', t => {
  const { jobs } = fixture(t);
  const ordinary = jobs.enqueue({ type: 'work', key: 'provider-terminal-spoof' });
  const providerError = Object.assign(new Error('Provider unavailable'), { status: 503, reasoningTerminal: true });
  assert.equal(jobs.fail(jobs.claim('worker', { id: ordinary.id }), providerError).state, 'retry_wait');
  const unknown = jobs.enqueue({ type: 'work', key: 'terminal-unknown' }), owner = jobs.claim('worker', { id: unknown.id });
  const at = iso(jobs.database.now());
  jobs.db.prepare(`INSERT INTO tool_executions(id,job_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
    VALUES('terminal-write',?,'fixture','send','send','resource','terminal-write','{}','unknown',1,0,0,0,?,?)`).run(owner.id, at, at);
  const failed = jobs.fail(owner, providerError, { reasoningTerminal: true });
  assert.equal(failed.state, 'recovery_required'); assert.equal(failed.last_error_class, 'ambiguous'); assert.equal(failed.budget_deferrals, 0);
});
