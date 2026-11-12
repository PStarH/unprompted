import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';

/**
 * Token budget core behaviour.
 *
 * These tests use the real DurableDatabase and assert through the public
 * service API plus persisted state after reopening the database. No test
 * reaches into the service's SQL directly, so an implementation that merely
 * looks right in one query but loses state across connections would fail.
 */

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const START = Date.parse('2026-11-12T10:00:00.000Z');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-token-budget-'));
  roots.push(dir);
  return path.join(dir, 'workspace.db');
}

function memoryFixture(t, { now = START } = {}) {
  const clock = { value: now };
  const database = new DurableDatabase(':memory:', { now: () => clock.value });
  const budget = new TokenBudgetService(database);
  t.after(() => database.close());
  return { database, budget, clock };
}

function fileFixture(t, filename, clock) {
  const database = new DurableDatabase(filename, { now: () => clock.value });
  t.after(() => database.close());
  return { database, budget: new TokenBudgetService(database) };
}

const DATABASE_URL = new URL('../src/durable/database.js', import.meta.url).href;
const TOKEN_BUDGET_URL = new URL('../src/durable/token-budget.js', import.meta.url).href;

function writeRaceWorker(directory) {
  const filename = path.join(directory, 'race-worker.mjs');
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import { DurableDatabase } from ${JSON.stringify(DATABASE_URL)};
import { TokenBudgetService } from ${JSON.stringify(TOKEN_BUDGET_URL)};

const [databasePath, goPath, readyPath, attemptId, now] = process.argv.slice(2);
const database = new DurableDatabase(databasePath, { now: () => Number(now) });
const budget = new TokenBudgetService(database);
fs.writeFileSync(readyPath, 'ready');
while (!fs.existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, 2));
let result;
try {
  budget.reserve({ attemptId, inputTokens: 60, outputTokens: 0 });
  result = { ok: true };
} catch (error) {
  result = { ok: false, code: error.code ?? error.name };
}
database.close();
process.stdout.write(JSON.stringify(result));
`);
  return filename;
}

function collectWorker(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`race worker exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
}

async function waitForFile(filename, timeoutMs = 10000) {
  const started = Date.now();
  while (!fs.existsSync(filename)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function runRace(directory, worker, databasePath, now) {
  const go = path.join(directory, 'go');
  const readyFirst = path.join(directory, 'ready-first');
  const readySecond = path.join(directory, 'ready-second');
  const first = spawn(process.execPath, [worker, databasePath, go, readyFirst, 'race-first', String(now)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const second = spawn(process.execPath, [worker, databasePath, go, readySecond, 'race-second', String(now)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = [collectWorker(first), collectWorker(second)];
  try {
    await Promise.all([waitForFile(readyFirst), waitForFile(readySecond)]);
    fs.writeFileSync(go, 'go');
    return await Promise.all(finished);
  } finally {
    first.kill();
    second.kill();
    await Promise.allSettled(finished);
    for (const filename of [go, readyFirst, readySecond]) fs.rmSync(filename, { force: true });
  }
}

const settled = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

function rejected(fn, expected = {}) {
  try {
    fn();
  } catch (error) {
    if (expected.code !== undefined) assert.equal(error.code, expected.code);
    if (expected.status !== undefined) assert.equal(error.status, expected.status);
    return error;
  }
  assert.fail(`expected ${expected.code ?? 'an error'}`);
}

test('without limits reservations are still recorded and settle normally', t => {
  const { budget } = memoryFixture(t);
  const before = budget.describe();
  assert.deepEqual(before.workspace, {
    limit: null, settled: 0, pending: 0, unknown: 0, used: 0,
    available: null, overage: 0, exhausted: false,
    attempts: { settled: 0, pending: 0, unknown: 0 }
  });
  assert.equal(before.task, null);
  assert.deepEqual(before.pendingReservations, []);
  assert.equal(before.date, '2026-11-12');

  const reservation = budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 10, outputTokens: 5 });
  assert.equal(reservation.state, 'reserved');
  assert.deepEqual(reservation.reserved, { input: 10, output: 5, total: 15 });
  assert.equal(reservation.day, '2026-11-12');
  assert.equal(reservation.consumed, 15);

  const pending = budget.describe();
  assert.equal(pending.workspace.used, 15);
  assert.equal(pending.workspace.pending, 15);
  assert.equal(pending.workspace.settled, 0);
  assert.equal(pending.workspace.available, null);
  assert.equal(pending.pendingReservations.length, 1);
  assert.deepEqual(Object.keys(pending.pendingReservations[0]).sort(),
    ['attemptId', 'createdAt', 'dispatchedAt', 'reserved', 'state', 'taskId']);
  assert.equal(pending.pendingReservations[0].attemptId, 'a1');

  const done = budget.settle('a1', settled(9, 4));
  assert.equal(done.state, 'settled');
  assert.equal(done.actual.total, 13);
  assert.deepEqual(done.overrun, { tokens: 0, exceeded: false });
  const after = budget.describe();
  assert.equal(after.workspace.settled, 13);
  assert.equal(after.workspace.pending, 0);
  assert.equal(after.workspace.used, 13);
  assert.deepEqual(after.pendingReservations, []);
});

test('a zero limit forbids new reservations and a null limit restores unlimited use', t => {
  const { budget } = memoryFixture(t);
  assert.equal(budget.setLimit({ scope: 'workspace', tokens: 0 }).limit, 0);
  const zero = budget.describe();
  assert.equal(zero.workspace.available, 0);
  assert.equal(zero.workspace.exhausted, true);

  const error = rejected(
    () => budget.reserve({ attemptId: 'blocked', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.equal(error.message, 'The workspace token budget is exhausted for 2026-11-12.');
  assert.equal(error.retryAt, '2026-11-13T00:00:00.000Z');
  assert.deepEqual(error.detail.blockedScopes, ['workspace']);
  assert.deepEqual(error.detail.workspace, {
    limit: 0, used: 0, available: 0, overage: 0, requested: 1, wouldExceed: true
  });
  assert.equal(budget.describe().workspace.used, 0, 'a rejected reservation leaves no hold behind');

  budget.setLimit({ scope: 'workspace', tokens: null });
  const allowed = budget.reserve({ attemptId: 'blocked', inputTokens: 1, outputTokens: 0 });
  assert.equal(allowed.state, 'reserved');
  const unlimited = budget.describe();
  assert.equal(unlimited.workspace.limit, null);
  assert.equal(unlimited.workspace.available, null);
  assert.equal(unlimited.workspace.used, 1);
});

test('a zero-token reservation is admitted at a zero limit and settles truthfully', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 0 });
  const zero = budget.reserve({ attemptId: 'zero', inputTokens: 0, outputTokens: 0 });
  assert.equal(zero.state, 'reserved');
  assert.equal(zero.reserved.total, 0);

  const reserved = budget.describe();
  assert.equal(reserved.workspace.used, 0);
  assert.equal(reserved.workspace.attempts.pending, 1);
  assert.equal(reserved.workspace.exhausted, true);
  assert.throws(() => budget.reserve({ attemptId: 'positive', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });

  const result = budget.settle('zero', { input: 3, output: 2 });
  assert.deepEqual(result.overrun, { tokens: 5, exceeded: true });
  const settled = budget.describe();
  assert.equal(settled.workspace.used, 5);
  assert.equal(settled.workspace.overage, 5);
});

test('workspace and task limits are checked together without recording failures', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100 });
  budget.setLimit({ scope: 'task', taskId: 'task-1', tokens: 30 });

  budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 20, outputTokens: 0 });
  const taskBlocked = rejected(
    () => budget.reserve({ attemptId: 'a2', taskId: 'task-1', inputTokens: 11, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(taskBlocked.detail.blockedScopes, ['task']);
  assert.deepEqual(taskBlocked.detail.task, {
    taskId: 'task-1', limit: 30, used: 20, available: 10, overage: 0, requested: 11, wouldExceed: true
  });
  assert.equal(taskBlocked.detail.workspace.wouldExceed, false);
  assert.equal(taskBlocked.detail.workspace.available, 80);

  const workspaceBlocked = rejected(
    () => budget.reserve({ attemptId: 'a3', taskId: 'task-2', inputTokens: 90, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(workspaceBlocked.detail.blockedScopes, ['workspace']);
  assert.equal(workspaceBlocked.detail.task.limit, null);
  assert.equal(workspaceBlocked.detail.task.wouldExceed, false);

  const bothBlocked = rejected(
    () => budget.reserve({ attemptId: 'a4', taskId: 'task-1', inputTokens: 90, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(bothBlocked.detail.blockedScopes, ['workspace', 'task']);

  budget.reserve({ attemptId: 'a3', taskId: 'task-2', inputTokens: 80, outputTokens: 0 });
  const all = budget.describe();
  assert.equal(all.workspace.used, 100);
  assert.equal(all.workspace.available, 0);
  assert.equal(all.workspace.pending, 100);
  assert.equal(all.pendingReservations.length, 2);

  const taskView = budget.describe({ taskId: 'task-1' });
  assert.equal(taskView.workspace.used, 100, 'the workspace view stays global');
  assert.deepEqual(taskView.task, {
    taskId: 'task-1', limit: 30, settled: 0, pending: 20, unknown: 0, used: 20,
    available: 10, overage: 0, exhausted: false,
    attempts: { settled: 0, pending: 1, unknown: 0 }
  });
  assert.deepEqual(taskView.pendingReservations.map(row => row.attemptId), ['a1']);

  budget.cancelBeforeDispatch('a3');
  const freed = budget.describe();
  assert.equal(freed.workspace.used, 20);
  assert.equal(freed.workspace.available, 80);
  budget.reserve({ attemptId: 'a5', taskId: 'task-1', inputTokens: 10, outputTokens: 0 });
  assert.equal(budget.describe({ taskId: 'task-1' }).task.used, 30);
});

test('two service instances on separate connections share committed state', t => {
  const filename = tempFile();
  const clock = { value: START };
  const first = fileFixture(t, filename, clock);
  const second = fileFixture(t, filename, clock);
  first.budget.setLimit({ scope: 'workspace', tokens: 100 });

  first.budget.reserve({ attemptId: 'first-1', inputTokens: 60, outputTokens: 0 });
  const blocked = rejected(
    () => second.budget.reserve({ attemptId: 'second-1', inputTokens: 60, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );
  assert.equal(blocked.detail.workspace.used, 60, 'the second connection sees the committed hold');

  second.budget.reserve({ attemptId: 'second-1', inputTokens: 40, outputTokens: 0 });
  assert.equal(first.budget.describe().workspace.used, 100);
  assert.throws(
    () => first.budget.reserve({ attemptId: 'first-2', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );

  first.budget.settle('first-1', settled(55, 0));
  second.budget.settle('second-1', settled(40, 0));
  assert.equal(first.budget.describe().workspace.settled, 95);
  assert.equal(second.budget.describe().workspace.used, 95);
});

test('two real processes racing for the last reservation never overspend', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-token-budget-race-'));
  roots.push(directory);
  const worker = writeRaceWorker(directory);
  for (let iteration = 0; iteration < 4; iteration++) {
    const filename = path.join(directory, `race-${iteration}.db`);
    const now = START;
    const setup = new DurableDatabase(filename, { now: () => now });
    new TokenBudgetService(setup).setLimit({ scope: 'workspace', tokens: 100 });
    setup.close();

    const results = await runRace(directory, worker, filename, now);
    const successes = results.filter(result => result.ok).length;
    assert.equal(successes, 1, `iteration ${iteration}: ${JSON.stringify(results)}`);
    const loser = results.find(result => !result.ok);
    assert.ok(loser.code === 'TOKEN_BUDGET_EXHAUSTED' || /^SQLITE_BUSY/.test(loser.code),
      `iteration ${iteration}: unexpected loser code ${loser.code}`);

    const verify = new DurableDatabase(filename, { now: () => now });
    const described = new TokenBudgetService(verify).describe();
    verify.close();
    assert.equal(described.workspace.used, 60, `iteration ${iteration}: persisted total`);
    assert.equal(described.workspace.pending, 60);
    assert.ok(described.workspace.used <= 100);
  }
});

for (const [label, make] of [
  ['limit values', budget => () => budget.setLimit({ scope: 'workspace', tokens: -1 })],
  ['float limits', budget => () => budget.setLimit({ scope: 'workspace', tokens: 1.5 })],
  ['NaN limits', budget => () => budget.setLimit({ scope: 'workspace', tokens: NaN })],
  ['infinite limits', budget => () => budget.setLimit({ scope: 'workspace', tokens: Infinity })],
  ['unsafe limits', budget => () => budget.setLimit({ scope: 'workspace', tokens: Number.MAX_SAFE_INTEGER + 1 })],
  ['string limits', budget => () => budget.setLimit({ scope: 'workspace', tokens: '10' })],
  ['boolean limits', budget => () => budget.setLimit({ scope: 'workspace', tokens: true })],
  ['unknown scopes', budget => () => budget.setLimit({ scope: 'global', tokens: 10 })],
  ['missing limit values', budget => () => budget.setLimit({ scope: 'workspace' })],
  ['undefined limit values', budget => () => budget.setLimit({ scope: 'workspace', tokens: undefined })],
  ['workspace scopes with task ids', budget => () => budget.setLimit({ scope: 'workspace', taskId: 'task-1', tokens: 10 })],
  ['task scopes without task ids', budget => () => budget.setLimit({ scope: 'task', tokens: 10 })],
  ['missing attempt ids', budget => () => budget.reserve({ inputTokens: 1, outputTokens: 1 })],
  ['blank attempt ids', budget => () => budget.reserve({ attemptId: '   ', inputTokens: 1, outputTokens: 1 })],
  ['numeric attempt ids', budget => () => budget.reserve({ attemptId: 7, inputTokens: 1, outputTokens: 1 })],
  ['negative reservation tokens', budget => () => budget.reserve({ attemptId: 'a1', inputTokens: -1, outputTokens: 0 })],
  ['float reservation tokens', budget => () => budget.reserve({ attemptId: 'a1', inputTokens: 1.5, outputTokens: 0 })],
  ['NaN reservation tokens', budget => () => budget.reserve({ attemptId: 'a1', inputTokens: NaN, outputTokens: 0 })],
  ['string reservation tokens', budget => () => budget.reserve({ attemptId: 'a1', inputTokens: '5', outputTokens: 0 })],
  ['negative settled tokens', budget => () => budget.settle('missing-attempt', { input: -1 })],
  ['float settled tokens', budget => () => budget.settle('missing-attempt', { input: 1.5 })],
  ['NaN settled tokens', budget => () => budget.settle('missing-attempt', { input: NaN })],
  ['non-object settlement usage', budget => () => budget.settle('missing-attempt', null)],
  ['invalid calendar days', budget => () => budget.describe({ date: '2026-02-30' })],
  ['invalid date strings', budget => () => budget.describe({ date: 'not-a-date' })],
  ['invalid date objects', budget => () => budget.describe({ date: new Date(Number.NaN) })]
]) {
  test(`invalid ${label} are rejected`, t => {
    const { budget } = memoryFixture(t);
    assert.throws(make(budget), { code: 'INVALID_TOKEN_BUDGET', status: 400 });
    assert.equal(budget.describe().workspace.used, 0);
  });
}

test('unknown attempt ids are reported consistently', t => {
  const { budget } = memoryFixture(t);
  assert.throws(() => budget.settle('missing', settled(1, 0)), { code: 'TOKEN_BUDGET_NOT_FOUND', status: 404 });
  assert.throws(() => budget.cancelBeforeDispatch('missing'), { code: 'TOKEN_BUDGET_NOT_FOUND', status: 404 });
  assert.throws(() => budget.markUnknown('missing'), { code: 'TOKEN_BUDGET_NOT_FOUND', status: 404 });
  assert.throws(() => budget.markDispatched('missing'), { code: 'TOKEN_BUDGET_NOT_FOUND', status: 404 });
});

test('attempt ids are global idempotency keys and cannot be borrowed across tasks or amounts', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 1000 });
  const original = budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 10, outputTokens: 5 });

  assert.deepEqual(budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 10, outputTokens: 5 }), original);
  assert.equal(budget.describe().workspace.used, 15, 'an identical replay does not reserve twice');
  assert.equal(budget.describe().workspace.attempts.pending, 1);

  assert.throws(() => budget.reserve({ attemptId: 'a1', taskId: 'task-2', inputTokens: 10, outputTokens: 5 }),
    { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.throws(() => budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 11, outputTokens: 5 }),
    { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.throws(() => budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 10, outputTokens: 6 }),
    { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.throws(() => budget.reserve({ attemptId: 'a1', inputTokens: 10, outputTokens: 5 }),
    { code: 'TOKEN_BUDGET_CONFLICT' });

  budget.settle('a1', settled(10, 5));
  const replay = budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 10, outputTokens: 5 });
  assert.equal(replay.state, 'settled');
  assert.equal(budget.describe().workspace.used, 15, 'replay after settlement keeps one consumption record');
});

test('settlement is one-time and idempotent while conflicting settlements are rejected', t => {
  const { budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'a1', inputTokens: 10, outputTokens: 10 });
  const first = budget.settle('a1', settled(8, 6));
  assert.equal(first.state, 'settled');
  assert.deepEqual(first.actual, { input: 8, output: 6, cacheRead: 0, cacheWrite: 0, total: 14 });
  assert.equal(first.settledAt, first.updatedAt);

  assert.deepEqual(budget.settle('a1', settled(8, 6)), first);
  assert.equal(budget.describe().workspace.settled, 14);
  assert.equal(budget.describe().workspace.attempts.settled, 1);

  assert.throws(() => budget.settle('a1', settled(8, 7)), { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.throws(() => budget.settle('a1', settled(8, 6, 1)), { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.equal(budget.describe().workspace.used, 14);

  budget.reserve({ attemptId: 'a2', inputTokens: 5, outputTokens: 0 });
  budget.cancelBeforeDispatch('a2');
  assert.throws(() => budget.settle('a2', settled(5, 0)), { code: 'TOKEN_BUDGET_CONFLICT' });

  budget.reserve({ attemptId: 'a3', inputTokens: 5, outputTokens: 0 });
  budget.markUnknown('a3');
  assert.throws(() => budget.settle('a3', settled(5, 0)), { code: 'TOKEN_BUDGET_CONFLICT' });
});

test('settle requires explicit input and output and leaves the ledger unchanged otherwise', t => {
  const { budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'a', inputTokens: 100, outputTokens: 0 });
  const before = budget.describe();
  const invalidUsages = [
    ['missing usage', undefined],
    ['empty usage', {}],
    ['partial input only', { input: 10 }],
    ['partial output only', { output: 10 }],
    ['undefined output', { input: 10, output: undefined }],
    ['negative output', { input: 10, output: -1 }],
    ['string input', { input: '10', output: 0 }],
    ['float cache', { input: 10, output: 0, cacheRead: 1.5 }],
    ['null cache', { input: 10, output: 0, cacheWrite: null }]
  ];
  for (const [label, usage] of invalidUsages) {
    assert.throws(() => budget.settle('a', usage), { code: 'INVALID_TOKEN_BUDGET' }, label);
    assert.deepEqual(budget.describe(), before, label);
  }
  assert.equal(budget.describe().workspace.pending, 100);

  const zero = budget.settle('a', { input: 0, output: 0 });
  assert.equal(zero.state, 'settled');
  assert.deepEqual(zero.actual, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.equal(zero.consumed, 0);
  assert.equal(budget.describe().workspace.used, 0);
});

test('missing provider usage is retained through markUnknown, never settled as zero', t => {
  const { budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'a', inputTokens: 100, outputTokens: 0 });
  assert.throws(() => budget.settle('a'), { code: 'INVALID_TOKEN_BUDGET' });
  assert.equal(budget.describe().workspace.pending, 100);
  assert.equal(budget.describe().workspace.used, 100);

  const unknown = budget.markUnknown('a');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.consumed, 100);
  assert.equal(budget.describe().workspace.unknown, 100);
  assert.equal(budget.describe().workspace.pending, 0);
});

test('real usage above the reservation is recorded and exposed as overage', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 40 });
  budget.reserve({ attemptId: 'a1', inputTokens: 10, outputTokens: 5 });
  const result = budget.settle('a1', settled(30, 10, 5, 0));
  assert.equal(result.actual.total, 45);
  assert.equal(result.actual.cacheRead, 5);
  assert.deepEqual(result.overrun, { tokens: 30, exceeded: true });
  assert.equal(result.consumed, 45);

  const described = budget.describe();
  assert.equal(described.workspace.limit, 40);
  assert.equal(described.workspace.used, 45);
  assert.equal(described.workspace.available, 0, 'availability is clamped for display');
  assert.equal(described.workspace.overage, 5, 'overage is not hidden by the clamp');
  assert.equal(described.workspace.exhausted, true);
  assert.throws(() => budget.reserve({ attemptId: 'a2', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });

  assert.deepEqual(budget.settle('a1', settled(30, 10, 5, 0)), result);
  assert.equal(budget.describe().workspace.used, 45, 'the idempotent settlement did not double count');
});

test('accumulated usage cannot overflow the safe integer range', t => {
  const { budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'max', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
  assert.throws(() => budget.reserve({ attemptId: 'plus-one', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_OVERFLOW', status: 409 });
  assert.throws(() => budget.reserve({ attemptId: 'split', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }),
    { code: 'TOKEN_BUDGET_OVERFLOW' });

  const described = budget.describe();
  assert.equal(described.workspace.pending, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(described.workspace.pending));
  assert.equal(described.workspace.used, Number.MAX_SAFE_INTEGER);
  assert.equal(described.workspace.attempts.pending, 1);
});

test('a settlement that would overflow the day is rejected and keeps the hold', t => {
  const { budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'base', inputTokens: Number.MAX_SAFE_INTEGER - 10, outputTokens: 0 });
  budget.reserve({ attemptId: 'edge', inputTokens: 10, outputTokens: 0 });
  const before = budget.describe();
  assert.equal(before.workspace.pending, Number.MAX_SAFE_INTEGER);

  const accumulated = rejected(() => budget.settle('edge', { input: 20, output: 0 }),
    { code: 'TOKEN_BUDGET_OVERFLOW', status: 409 });
  assert.equal(accumulated.detail.scope, 'workspace');
  assert.equal(accumulated.detail.attemptId, 'edge');
  assert.equal(accumulated.detail.retainedReservation, true);
  assert.equal(accumulated.detail.requiresMarkUnknown, true);
  assert.deepEqual(budget.describe(), before);

  const unrepresentable = rejected(() => budget.settle('edge', { input: Number.MAX_SAFE_INTEGER, output: 1 }),
    { code: 'TOKEN_BUDGET_OVERFLOW' });
  assert.equal(unrepresentable.detail.attemptId, 'edge');
  assert.equal(unrepresentable.detail.retainedReservation, true);
  assert.equal(unrepresentable.detail.requiresMarkUnknown, true);
  assert.deepEqual(budget.describe(), before, 'unrepresentable actual usage leaves the hold untouched');

  budget.markUnknown('edge');
  const described = budget.describe();
  assert.equal(described.workspace.unknown, 10);
  assert.equal(described.workspace.pending, Number.MAX_SAFE_INTEGER - 10);
  assert.equal(described.workspace.used, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(described.workspace.used));
});

test('markUnknown keeps the full reservation consumed', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 20 });
  budget.reserve({ attemptId: 'a1', inputTokens: 12, outputTokens: 8 });
  const unknown = budget.markUnknown('a1');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.actual, null);
  assert.equal(unknown.consumed, 20);

  const described = budget.describe();
  assert.equal(described.workspace.unknown, 20);
  assert.equal(described.workspace.pending, 0);
  assert.equal(described.workspace.used, 20);
  assert.equal(described.workspace.exhausted, true);
  assert.throws(() => budget.reserve({ attemptId: 'a2', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });

  assert.deepEqual(budget.markUnknown('a1'), unknown);
  assert.throws(() => budget.settle('a1', settled(1, 0)), { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.throws(() => budget.cancelBeforeDispatch('a1'), { code: 'TOKEN_BUDGET_CONFLICT' });
  assert.throws(() => budget.markDispatched('a1'), { code: 'TOKEN_BUDGET_CONFLICT' });

  budget.setLimit({ scope: 'workspace', tokens: 100 });
  budget.reserve({ attemptId: 'a3', inputTokens: 10, outputTokens: 0 });
  assert.equal(budget.describe().workspace.used, 30);
});

test('cancel releases only reservations that were never dispatched', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 30 });
  budget.reserve({ attemptId: 'a1', inputTokens: 20, outputTokens: 0 });
  const cancelled = budget.cancelBeforeDispatch('a1');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.consumed, 0);
  assert.deepEqual(budget.cancelBeforeDispatch('a1'), cancelled);
  assert.equal(budget.describe().workspace.used, 0);
  assert.throws(() => budget.markDispatched('a1'), { code: 'TOKEN_BUDGET_CONFLICT' });

  budget.reserve({ attemptId: 'a2', inputTokens: 30, outputTokens: 0 });
  const marked = budget.markDispatched('a2');
  assert.equal(marked.state, 'dispatched');
  assert.equal(marked.dispatchedAt, marked.updatedAt);
  assert.deepEqual(budget.markDispatched('a2'), marked);

  const refund = rejected(() => budget.cancelBeforeDispatch('a2'),
    { code: 'TOKEN_BUDGET_ALREADY_DISPATCHED', status: 409 });
  assert.equal(refund.attemptId, 'a2');
  assert.equal(refund.state, 'dispatched');
  assert.throws(() => budget.reserve({ attemptId: 'a3', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(budget.describe().workspace.pending, 30, 'a dispatched attempt keeps its hold');

  const settledAfterDispatch = budget.settle('a2', settled(20, 10));
  assert.equal(settledAfterDispatch.state, 'settled');
  assert.equal(budget.describe().workspace.settled, 30);
  assert.throws(() => budget.markDispatched('a1'), { code: 'TOKEN_BUDGET_CONFLICT' });
});

test('pending reservations and limits survive a database restart', t => {
  const filename = tempFile();
  const clock = { value: START };
  const first = fileFixture(t, filename, clock);
  first.budget.setLimit({ scope: 'workspace', tokens: 50 });
  first.budget.reserve({ attemptId: 'pending', inputTokens: 30, outputTokens: 0 });
  first.budget.reserve({ attemptId: 'done', inputTokens: 5, outputTokens: 0 });
  first.budget.settle('done', settled(5, 0));
  first.database.close();

  const second = fileFixture(t, filename, clock);
  const described = second.budget.describe();
  assert.equal(described.workspace.limit, 50);
  assert.equal(described.workspace.used, 35);
  assert.equal(described.workspace.settled, 5);
  assert.equal(described.workspace.pending, 30);
  assert.deepEqual(described.pendingReservations.map(row => row.attemptId), ['pending']);

  second.budget.reserve({ attemptId: 'exact', inputTokens: 15, outputTokens: 0 });
  assert.throws(() => second.budget.reserve({ attemptId: 'over', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });

  second.budget.settle('pending', settled(25, 0));
  const final = second.budget.describe();
  assert.equal(final.workspace.used, 45);
  assert.equal(final.workspace.pending, 15);
  assert.equal(final.workspace.settled, 30);
});

test('a reservation keeps its original UTC day when settled later', t => {
  const { budget, clock } = memoryFixture(t, { now: Date.parse('2026-11-12T23:50:00.000Z') });
  budget.setLimit({ scope: 'workspace', tokens: 50 });
  budget.reserve({ attemptId: 'day-one', inputTokens: 20, outputTokens: 0 });

  clock.value = Date.parse('2026-11-13T00:10:00.000Z');
  const dayOne = budget.describe({ date: '2026-11-12' });
  assert.equal(dayOne.workspace.used, 20);
  assert.equal(dayOne.workspace.pending, 20);
  const dayTwo = budget.describe();
  assert.equal(dayTwo.date, '2026-11-13');
  assert.equal(dayTwo.workspace.used, 0);
  assert.equal(dayTwo.workspace.available, 50);
  assert.deepEqual(dayTwo.pendingReservations, []);

  budget.reserve({ attemptId: 'day-two', inputTokens: 40, outputTokens: 0 });
  budget.settle('day-one', settled(25, 0));
  const settledDayOne = budget.describe({ date: '2026-11-12' });
  assert.equal(settledDayOne.workspace.settled, 25);
  assert.equal(settledDayOne.workspace.used, 25);
  assert.equal(settledDayOne.workspace.pending, 0);
  assert.equal(settledDayOne.workspace.available, 25);
  assert.equal(budget.describe({ date: '2026-11-13' }).workspace.used, 40);
  assert.throws(() => budget.reserve({ attemptId: 'day-two-extra', inputTokens: 11, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });

  clock.value = Date.parse('2026-11-14T00:00:00.000Z');
  assert.equal(budget.describe({ date: '2026-11-13' }).workspace.used, 40);
  assert.equal(budget.describe().workspace.used, 0);
  assert.equal(budget.describe({ date: '2026-11-13T05:00:00.000Z' }).date, '2026-11-13');
});

test('describe accepts only unambiguous UTC dates', t => {
  const { budget } = memoryFixture(t);
  const ambiguous = [
    '2026-11-12T00:00:00',
    '2026-11-12T00:00:00.000',
    '2026-11-12 00:00:00',
    '2026-11-12T00:00:00.000z',
    '10000-01-01',
    '2026-02-30',
    '2026-13-01',
    'not-a-date',
    8640000000000000,
    -8640000000000000,
    Number.NaN
  ];
  for (const date of ambiguous) {
    assert.throws(() => budget.describe({ date }), { code: 'INVALID_TOKEN_BUDGET' }, String(date));
  }

  assert.equal(budget.describe({ date: '2026-11-12' }).date, '2026-11-12');
  assert.equal(budget.describe({ date: '2026-11-12T00:00:00Z' }).date, '2026-11-12');
  assert.equal(budget.describe({ date: '2026-11-12T00:00:00+08:00' }).date, '2026-11-11');
  assert.equal(budget.describe({ date: '2026-11-12T00:00:00-0200' }).date, '2026-11-12');
  assert.equal(budget.describe({ date: Date.parse('2026-11-12T10:00:00Z') }).date, '2026-11-12');
  assert.equal(budget.describe({ date: new Date('2026-11-12T10:00:00Z') }).date, '2026-11-12');

  const edge = budget.describe({ date: '9999-12-31' });
  assert.equal(edge.date, '9999-12-31');
  assert.equal(Number.isNaN(Date.parse(edge.resetsAt)), false);
  assert.equal(new Date(edge.resetsAt).getTime(), Date.parse('9999-12-31T00:00:00.000Z') + 86400000);
});

test('a reservation from an earlier UTC day cannot be dispatched', t => {
  const { budget, clock } = memoryFixture(t, { now: Date.parse('2026-11-12T23:50:00.000Z') });
  budget.reserve({ attemptId: 'old', inputTokens: 10, outputTokens: 0 });
  clock.value = Date.parse('2026-11-13T00:10:00.000Z');

  const error = rejected(() => budget.markDispatched('old'),
    { code: 'TOKEN_BUDGET_STALE_RESERVATION', status: 409 });
  assert.deepEqual(error.detail, { attemptId: 'old', reservedDay: '2026-11-12', currentDay: '2026-11-13' });
  assert.equal(budget.describe({ date: '2026-11-12' }).pendingReservations[0].state, 'reserved');

  const fresh = budget.reserve({ attemptId: 'fresh', inputTokens: 10, outputTokens: 0 });
  assert.equal(fresh.day, '2026-11-13');
  assert.equal(budget.markDispatched('fresh').state, 'dispatched');
  clock.value = Date.parse('2026-11-14T00:10:00.000Z');
  assert.equal(budget.markDispatched('fresh').state, 'dispatched', 'dispatch marking stays idempotent across days');
  budget.settle('fresh', { input: 5, output: 5 });
  assert.equal(budget.describe({ date: '2026-11-13' }).workspace.settled, 10);
  assert.equal(budget.describe({ date: '2026-11-14' }).workspace.used, 0);
});

test('changing a limit never erases consumption and reports overage per scope', t => {
  const { budget } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100 });
  budget.reserve({ attemptId: 'a1', taskId: 'task-1', inputTokens: 60, outputTokens: 0 });
  budget.settle('a1', settled(60, 0));

  budget.setLimit({ scope: 'workspace', tokens: 50 });
  const lowered = budget.describe();
  assert.equal(lowered.workspace.used, 60);
  assert.equal(lowered.workspace.limit, 50);
  assert.equal(lowered.workspace.available, 0);
  assert.equal(lowered.workspace.overage, 10);
  assert.equal(lowered.workspace.exhausted, true);
  assert.throws(() => budget.reserve({ attemptId: 'a2', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });

  budget.setLimit({ scope: 'workspace', tokens: 1000 });
  const raised = budget.describe();
  assert.equal(raised.workspace.used, 60);
  assert.equal(raised.workspace.available, 940);
  assert.equal(raised.workspace.overage, 0);

  budget.reserve({ attemptId: 'a2', taskId: 'task-1', inputTokens: 40, outputTokens: 0 });
  budget.setLimit({ scope: 'workspace', tokens: 10 });
  assert.equal(budget.describe().workspace.used, 100);
  assert.equal(budget.describe().workspace.overage, 90);
  budget.settle('a2', settled(20, 0));
  assert.equal(budget.describe().workspace.used, 80);
  assert.equal(budget.describe().workspace.overage, 70);

  budget.setLimit({ scope: 'task', taskId: 'task-1', tokens: 5 });
  const taskView = budget.describe({ taskId: 'task-1' });
  assert.equal(taskView.task.limit, 5);
  assert.equal(taskView.task.used, 80);
  assert.equal(taskView.task.overage, 75);
  assert.equal(taskView.workspace.used, 80, 'task limits do not rewrite workspace consumption');

  budget.setLimit({ scope: 'workspace', tokens: null });
  const unlimited = budget.describe();
  assert.equal(unlimited.workspace.limit, null);
  assert.equal(unlimited.workspace.available, null);
  assert.equal(unlimited.workspace.overage, 0);
  assert.equal(unlimited.workspace.used, 80);
});

test('a limit set mid-flight accounts for requests that were already running', t => {
  const { budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'running', inputTokens: 25, outputTokens: 0 });
  budget.markDispatched('running');
  assert.equal(budget.describe().workspace.limit, null, 'the service started disabled');

  budget.setLimit({ scope: 'workspace', tokens: 20 });
  const described = budget.describe();
  assert.equal(described.workspace.used, 25);
  assert.equal(described.workspace.overage, 5);
  assert.equal(described.workspace.exhausted, true);
  assert.throws(() => budget.reserve({ attemptId: 'next', inputTokens: 1, outputTokens: 0 }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' });
});

test('construction works inside an existing database transaction', t => {
  const database = new DurableDatabase(':memory:', { now: () => START });
  t.after(() => database.close());
  let budget;
  database.atomic(() => { budget = new TokenBudgetService(database); });
  assert.ok(budget instanceof TokenBudgetService);
  budget.setLimit({ scope: 'workspace', tokens: 10 });
  budget.reserve({ attemptId: 'a1', inputTokens: 4, outputTokens: 0 });
  assert.equal(budget.describe().workspace.used, 4);

  const second = new TokenBudgetService(database);
  assert.deepEqual(second.reserve({ attemptId: 'a1', inputTokens: 4, outputTokens: 0 }),
    budget.reserve({ attemptId: 'a1', inputTokens: 4, outputTokens: 0 }));
});

test('describe reads a snapshot without taking a write lock', t => {
  const filename = tempFile();
  const clock = { value: START };
  const reader = new DurableDatabase(filename, { now: () => clock.value, busyTimeoutMs: 100 });
  t.after(() => reader.close());
  const budget = new TokenBudgetService(reader);
  budget.reserve({ attemptId: 'held', inputTokens: 10, outputTokens: 0 });

  const writer = new DurableDatabase(filename, { now: () => clock.value, busyTimeoutMs: 100 });
  t.after(() => writer.close());
  writer.db.exec('BEGIN IMMEDIATE');
  try {
    const described = budget.describe();
    assert.equal(described.workspace.used, 10);
    assert.deepEqual(described.pendingReservations.map(row => row.attemptId), ['held']);
  } finally {
    writer.db.exec('ROLLBACK');
  }
});

test('describe reuses an active transaction', t => {
  const { database, budget } = memoryFixture(t);
  budget.reserve({ attemptId: 'held', inputTokens: 10, outputTokens: 0 });
  database.atomic(() => {
    assert.equal(budget.describe().workspace.used, 10);
    budget.setLimit({ scope: 'workspace', tokens: 50 });
    assert.equal(budget.describe().workspace.limit, 50);
  });
  assert.equal(budget.describe().workspace.limit, 50);
});
