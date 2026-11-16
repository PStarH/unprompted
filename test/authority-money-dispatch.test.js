import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connector } from '../src/connectors/connector.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';
import { TransactionMoneyService } from '../src/durable/transaction-money.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';

/**
 * Native authority + transaction money dispatch.
 *
 * Unlike the standalone transaction-money suite, every test here crosses the
 * real ToolSafetyGateway, ToolExecutionLedger and a fake provider (or the
 * actual connector action path). Quotes and caps are user-issued; model JSON
 * never contains either.
 */

const FUTURE = () => new Date(Date.now() + 7200000).toISOString();
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

function connector(fetchImpl) {
  const c = new Connector({ id: 'github', kind: 'code', fetchImpl });
  c.live = true; c.account = { id: 'account-1' }; c.auth = { accessToken: async () => 'private-token' };
  return c;
}

async function fixture(t, fetchImpl = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-money-'));
  const store = new SqliteStore(path.join(dir, 'state.json'));
  const writes = [];
  let record = { id: 42, title: 'Before' };
  const c = connector(fetchImpl || (async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer private-token');
    if (options.method !== 'GET') { writes.push(options); record = { ...record, ...JSON.parse(options.body || '{}') }; }
    return response(record);
  }));
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: false }) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === c.id ? c : null });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  engine.ingest({ id: 'email:authority', type: 'email.received', payload: { id: 'authority', threadId: 't1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
  await engine.whenSettled();
  const taskId = 'request:authority';
  assert.ok(runtime.tasks.get(taskId));
  return { runtime, engine, store, c, writes, taskId, database: runtime.database };
}

function scope(runtime, taskId) {
  const task = runtime.tasks.get(taskId);
  const jobKey = `test:${randomUUID()}`;
  const enqueued = runtime.jobs.enqueue({ queue: 'effects', type: 'external_dispatch', key: jobKey, taskId, payload: { taskId, key: jobKey } });
  const job = runtime.jobs.claim('worker', { queue: 'effects', id: enqueued.id });
  const run = runtime.tasks.beginRun(job);
  runtime.tasks.checkpoint(run, job, { expectedInputVersion: runtime.tasks.get(taskId).inputVersion, plan: {} });
  return { taskId, run, job, task: runtime.tasks.get(taskId) };
}

function writeIntent(runtime, current, key, { authorize, effect = { type: 'write', key }, payload = { key } } = {}) {
  return runtime.ledger.intent({ taskId: current.taskId, run: current.run, job: current.job, provider: 'fixture', tool: 'write',
    actionFamily: 'fixture.write', resourceId: `resource:${key}`, key, effect, payload, authorize });
}

function paidGrant(runtime, taskId, overrides = {}) {
  runtime.transactionMoney.configureLease({ grantId: 'money-1', scope: 'workspace', currency: 'USD', capMicros: 5000, expiresAt: FUTURE(), expectedVersion: 0 });
  return runtime.connectorActions.createGrant({ connectorId: 'github', transfer: 'paid', financialConfirmed:true, currencyPointer:'/request/body/currency', monetaryGrantId: 'money-1',
    amountMicrosPointer: '/request/body/amountMicros', confirmed: true, ...overrides });
}

function paidAction(context, amountMicros, operationId, issue = 42) {
  return { connectorId: 'github', request: { method: 'PATCH', path: `/repos/owner/repo/issues/${issue}`, body: { amountMicros, currency:'USD', title: 'After' } },
    operationId, confirmed: true, inputVersion: context.runtime.tasks.get(context.taskId).inputVersion };
}

test('permits reject spreads, structured clones and foreign ledgers before any send', async t => {
  const c = await fixture(t);
  const current = scope(c.runtime, c.taskId);
  let sends = 0;
  const permit = writeIntent(c.runtime, current, 'clone-key', { authorize: () => ({ allowed: true }) });
  const send = async (_signal, beforeDispatch) => { sends++; beforeDispatch(); return { id: 'receipt-clone', idempotencyKey: 'clone-key' }; };
  await assert.rejects(c.runtime.ledger.dispatch({ ...permit }, { ...current, send }), { code: 'PERMIT_INVALID' });
  await assert.rejects(c.runtime.ledger.dispatch(structuredClone(permit), { ...current, send }), { code: 'PERMIT_INVALID' });
  const foreign = new ToolExecutionLedger(c.database, { tasks: c.runtime.tasks, jobs: c.runtime.jobs, experiences: c.runtime.experiences, transfers: c.runtime.transactionMoney });
  await assert.rejects(foreign.dispatch(permit, { ...current, send }), { code: 'PERMIT_INVALID' });
  assert.equal(sends, 0);
});

test('exposed permit snapshots are frozen and a persisted is_write change cannot bypass verification', async t => {
  const c = await fixture(t);
  const current = scope(c.runtime, c.taskId);
  const permit = writeIntent(c.runtime, current, 'frozen-key', { authorize: () => ({ allowed: true }) });
  assert.ok(Object.isFrozen(permit.execution));
  assert.throws(() => { permit.execution.is_write = 0; }, TypeError);
  assert.equal(permit.execution.is_write, 1);
  c.database.db.prepare("UPDATE tool_executions SET is_write=0 WHERE idempotency_key='frozen-key'").run();
  let sends = 0;
  await assert.rejects(c.runtime.ledger.dispatch(permit, { ...current, send: async (_s, beforeDispatch) => { sends++; beforeDispatch(); return { id: 'x' }; } }), { code: 'PERMIT_INVALID' });
  assert.equal(sends, 0);
});

test('a repeated beforeDispatch callback never re-authorizes and SQL rollback leaves no consumed marker', async t => {
  const c = await fixture(t);
  const current = scope(c.runtime, c.taskId);
  let authorizations = 0, sends = 0;
  const permit = writeIntent(c.runtime, current, 'repeat-key', { authorize: () => { authorizations++; return { allowed: true }; } });
  await assert.rejects(c.runtime.ledger.dispatch(permit, { ...current, deferDispatch: true, send: async (_signal, beforeDispatch) => {
    beforeDispatch(); sends++; beforeDispatch(); sends++;
    return { id: 'receipt-repeat', idempotencyKey: 'repeat-key' };
  } }), { code: 'PERMIT_CONSUMED' });
  assert.equal(c.runtime.ledger.get(permit.execution.id).status, 'unknown');
  assert.equal(authorizations, 2, 'intent and the single committed boundary only');
  assert.equal(sends, 1);
  await assert.rejects(c.runtime.ledger.dispatch(permit, { ...current, send: async () => ({ id: 'again' }) }),
    error => ['PERMIT_CONSUMED', 'RECONCILIATION_REQUIRED'].includes(error.code));

  const rollback = scope(c.runtime, c.taskId);
  let rollbackSends = 0;
  const failed = writeIntent(c.runtime, rollback, 'rollback-key', { authorize: () => ({ allowed: true }) });
  c.database.db.exec(`CREATE TRIGGER reject_dispatch BEFORE UPDATE OF status ON tool_executions WHEN NEW.status='dispatched' AND NEW.id='${failed.execution.id}' BEGIN SELECT RAISE(ABORT,'forced rollback'); END`);
  await assert.rejects(c.runtime.ledger.dispatch(failed, { ...rollback, send: async (_s, beforeDispatch) => { rollbackSends++; beforeDispatch(); return { id: 'never' }; } }));
  c.database.db.exec('DROP TRIGGER reject_dispatch');
  assert.equal(rollbackSends, 0);
  assert.equal(c.runtime.ledger.get(failed.execution.id).status, 'cancelled');
  await assert.rejects(c.runtime.ledger.dispatch(failed, { ...rollback, send: async () => ({ id: 'never' }) }), error => error.code !== 'PERMIT_CONSUMED');
});

test('async authorization decisions are denied and never reach the provider', async t => {
  const c = await fixture(t);
  const current = scope(c.runtime, c.taskId);
  assert.throws(() => writeIntent(c.runtime, current, 'async-intent', { authorize: async () => ({ allowed: true }) }), { code: 'AUTHORIZATION_REQUIRED' });
  let calls = 0;
  const permit = writeIntent(c.runtime, current, 'async-dispatch', { authorize: () => ++calls === 1 ? { allowed: true } : Promise.resolve({ allowed: true }) });
  let sends = 0;
  await assert.rejects(c.runtime.ledger.dispatch(permit, { ...current, send: async (_s, beforeDispatch) => { sends++; beforeDispatch(); return { id: 'x' }; } }),
    error => ['AUTHORIZATION_REQUIRED', 'PERMIT_CONSUMED'].includes(error.code));
  assert.equal(sends, 0);
  assert.equal(c.runtime.ledger.get(permit.execution.id).status, 'cancelled');
});

test('native transaction money reserves, marks dispatch and settles only from trusted readback', async t => {
  const c = await fixture(t);
  const current = scope(c.runtime, c.taskId);
  const effect = { type: 'charge', key: 'money-key' }, payload = { amountMicros: 100 };
  const resourceId = 'resource:money-key';
  c.runtime.transactionMoney.configureLease({ grantId: 'money-1', scope: 'workspace', currency: 'USD', capMicros: 5000, expiresAt: FUTURE(), expectedVersion: 0 });
  const quote = c.runtime.transactionMoney.issueQuote({ provider: 'fixture', tool: 'write', actionFamily: 'fixture.write', grantId: 'money-1',
    taskId: c.taskId, currency: 'USD', amountMicros: 100, resourceId, inputVersion: current.task.inputVersion, privacyEpoch: current.task.privacyEpoch,
    payload, effect, quoteExpiresAt: new Date(Date.now() + 3600000).toISOString() }, { isCurrent: () => true });
  let sends = 0;
  const permit = c.runtime.ledger.intent({ taskId: c.taskId, run: current.run, job: current.job, provider: 'fixture', tool: 'write',
    actionFamily: 'fixture.write', resourceId, key: 'money-key', effect, payload, authorize: () => ({ allowed: true, transfer: quote }) });
  const result = await c.runtime.ledger.dispatch(permit, { ...current, deferDispatch: true, send: async (_signal, beforeDispatch) => { beforeDispatch(); sends++; return { id: 'money-receipt', idempotencyKey: 'money-key' }; } });
  assert.equal(result.id, 'money-receipt'); assert.equal(sends, 1);
  const binding = c.database.db.prepare('SELECT * FROM execution_money_bindings WHERE execution_id=?').get(permit.execution.id);
  assert.ok(binding);
  assert.equal(c.runtime.transactionMoney.attemptInfo(binding.money_attempt_id).state, 'dispatched');
  // A plain copy or a quote from another service instance is not native.
  const cloned = { ...quote };
  const other = new TransactionMoneyService(c.database);
  const foreign = other.issueQuote({ provider: 'fixture', tool: 'write', actionFamily: 'fixture.write', grantId: 'money-1', taskId: c.taskId,
    currency: 'USD', amountMicros: 100, resourceId, inputVersion: current.task.inputVersion, privacyEpoch: current.task.privacyEpoch,
    payload, effect, quoteExpiresAt: new Date(Date.now() + 3600000).toISOString() }, { isCurrent: () => true });
  const otherScope = scope(c.runtime, c.taskId);
  assert.throws(() => c.runtime.ledger.intent({ taskId: c.taskId, run: otherScope.run, job: otherScope.job, provider: 'fixture', tool: 'write',
    actionFamily: 'fixture.write', resourceId, key: 'money-clone', effect, payload, authorize: () => ({ allowed: true, transfer: cloned }) }), { code: 'TRANSFER_QUOTE_UNTRUSTED' });
  assert.throws(() => c.runtime.ledger.intent({ taskId: c.taskId, run: otherScope.run, job: otherScope.job, provider: 'fixture', tool: 'write',
    actionFamily: 'fixture.write', resourceId, key: 'money-foreign', effect, payload, authorize: () => ({ allowed: true, transfer: foreign }) }), { code: 'TRANSFER_QUOTE_UNTRUSTED' });
  const reconciled = await c.runtime.ledger.reconcile(permit.execution.id, { lookup: async () => ({ status: 'found', actualMicros: 100, receiptRef: 'charge:money-key', receipt: { id: 'money-receipt', idempotencyKey: 'money-key' } }) });
  assert.equal(reconciled.status, 'found');
  assert.equal(c.runtime.ledger.get(permit.execution.id).status, 'verified');
  assert.equal(c.runtime.transactionMoney.attemptInfo(binding.money_attempt_id).state, 'settled');
});

test('a user-issued paid connector contract reserves through the gateway and blocks over-cap sends', async t => {
  const c = await fixture(t);
  paidGrant(c.runtime, c.taskId);
  const wrongCurrency=paidAction(c,30,'currency-mismatch');wrongCurrency.request.body.currency='EUR';
  await assert.rejects(c.runtime.connectorActions.request(c.taskId,wrongCurrency,{actor:'user'}),{code:'TRANSFER_CURRENCY_MISMATCH'});assert.equal(c.writes.length,0);
  const first = await c.runtime.connectorActions.request(c.taskId, paidAction(c, 1000, 'paid-1'), { actor: 'user' });
  assert.ok(['accepted', 'verified'].includes(first.state));
  assert.equal(c.writes.length, 1);
  const binding = c.database.db.prepare('SELECT * FROM execution_money_bindings WHERE execution_id=?').get(first.executionId);
  assert.ok(binding, 'gateway -> ledger retained a money attempt');
  assert.equal(c.runtime.transactionMoney.attemptInfo(binding.money_attempt_id).state, 'unknown');
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, paidAction(c, 4500, 'paid-2', 43), { actor: 'user' }),
    error => ['MONEY_BUDGET_EXHAUSTED', 'TRANSFER_QUOTE_MISMATCH'].includes(error.code));
  assert.equal(c.writes.length, 1, 'over-cap operation never reached the provider');
});

test('revoked monetary authority and unknown provider outcomes stop blind retry', async t => {
  const c = await fixture(t);
  paidGrant(c.runtime, c.taskId);
  c.runtime.transactionMoney.revokeLease({ grantId: 'money-1', expectedVersion: 1 });
  await assert.rejects(c.runtime.connectorActions.request(c.taskId, paidAction(c, 500, 'revoked-1'), { actor: 'user' }),
    error => ['MONEY_LEASE_UNAVAILABLE', 'MONEY_BUDGET_STALE', 'TRANSACTION_QUOTE_STALE'].includes(error.code));
  assert.equal(c.writes.length, 0);

  const unknown = await fixture(t, async (_url, options) => {
    if (options.method !== 'GET') { unknownWrites++; throw new Error('connection lost after remote acceptance'); }
    return response({});
  });
  let unknownWrites = 0;
  paidGrant(unknown.runtime, unknown.taskId);
  await assert.rejects(unknown.runtime.connectorActions.request(unknown.taskId, paidAction(unknown, 700, 'unknown-1'), { actor: 'user' }), /connection lost/);
  assert.equal(unknownWrites, 1);
  const retry = await unknown.runtime.connectorActions.request(unknown.taskId, paidAction(unknown, 700, 'unknown-1'), { actor: 'user' });
  assert.equal(retry.state, 'unknown'); assert.equal(retry.alreadyDispatched, true);
  assert.equal(unknownWrites, 1, 'an unknown transfer is never retried blindly');
  const execution = unknown.database.db.prepare("SELECT id FROM tool_executions WHERE action_family='connector.request' ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(execution);
  const binding = unknown.database.db.prepare('SELECT * FROM execution_money_bindings WHERE execution_id=?').get(execution.id);
  assert.equal(unknown.runtime.transactionMoney.attemptInfo(binding.money_attempt_id).state, 'unknown');
});
