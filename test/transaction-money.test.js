import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase } from '../src/durable/database.js';
import { MoneyBudgetService } from '../src/durable/money-budget.js';
import { TransactionMoneyService } from '../src/durable/transaction-money.js';

/**
 * Native transaction quote and hold behaviour.
 *
 * Every test uses the real DurableDatabase and the real transaction
 * MoneyBudgetService as the authoritative ledger. The suite covers the opaque
 * exact-instance brand, clones and foreign services, full context binding,
 * the mandatory authority-current callback, grant version/revocation/expiry,
 * quote reuse, one-quote/one-attempt uniqueness, rollback-safe retry, unknown
 * holds across revocation and restart, trusted settlement and the existing
 * core cap/day limits. It does not test a provider, transport, grant UI or
 * any endpoint; this service authorizes money reservation only.
 */

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const START = Date.parse('2026-11-12T10:00:00.000Z');
const QUOTE_EXPIRY = '2026-11-12T10:20:00.000Z';
const LEASE_EXPIRY = '2026-11-13T00:00:00.000Z';
const USD = 'USD';

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-transaction-money-'));
  roots.push(directory);
  return path.join(directory, 'workspace.db');
}

function memoryClock(now = START) {
  return { value: now };
}

function leaseInput(overrides = {}) {
  return {
    grantId: 'grant-1',
    scope: 'workspace',
    currency: USD,
    capMicros: 1000,
    expiresAt: LEASE_EXPIRY,
    expectedVersion: 0,
    ...overrides
  };
}

function fixture(t, { filename = null, clock = memoryClock(), lease = {} } = {}) {
  const database = new DurableDatabase(filename ?? ':memory:', { now: () => clock.value });
  const budget = new MoneyBudgetService(database, { kind: 'transaction' });
  budget.configureLease(leaseInput(lease));
  const money = new TransactionMoneyService(database);
  t.after(() => database.close());
  return { database, budget, money, clock };
}

function quoteSpec(overrides = {}) {
  return {
    provider: 'provider-a',
    tool: 'tool-pay',
    actionFamily: 'purchase',
    grantId: 'grant-1',
    taskId: null,
    currency: USD,
    amountMicros: 100,
    resourceId: 'resource-1',
    inputVersion: 1,
    privacyEpoch: '1',
    payload: { merchant: 'merchant-1', amount: 1 },
    effect: { kind: 'charge', merchant: 'merchant-1' },
    quoteExpiresAt: QUOTE_EXPIRY,
    ...overrides
  };
}

function binding(overrides = {}) {
  return {
    provider: 'provider-a',
    tool: 'tool-pay',
    actionFamily: 'purchase',
    taskId: null,
    inputVersion: 1,
    privacyEpoch: '1',
    resourceId: 'resource-1',
    payload: { merchant: 'merchant-1', amount: 1 },
    effect: { kind: 'charge', merchant: 'merchant-1' },
    ...overrides
  };
}

const allow = Object.freeze({ isCurrent: () => true });

function rejected(fn, expected = {}) {
  try {
    fn();
  } catch (error) {
    if (expected.code !== undefined) assert.equal(error.code, expected.code, error.message);
    if (expected.reason !== undefined) assert.equal(error.reason, expected.reason, error.message);
    return error;
  }
  assert.fail(`expected ${expected.code ?? 'an error'}`);
}

function usdBucket(description) {
  const bucket = description.currencies.find(entry => entry.currency === USD);
  assert.ok(bucket, 'USD bucket is present');
  assert.equal(bucket.workspace.currency, USD);
  return bucket.workspace;
}

function issue(money, overrides = {}) {
  return money.issueQuote(quoteSpec(overrides), allow);
}

test('the exact opaque quote validates, reserves, dispatches and settles through the core ledger', t => {
  const { money, budget } = fixture(t);
  const quote = issue(money);

  assert.ok(Object.isFrozen(quote));
  assert.equal(quote.amountMicros, 100);
  assert.equal(quote.grantVersion, 1);
  assert.equal(quote.currency, USD);
  assert.equal(quote.expiresAt, QUOTE_EXPIRY);
  assert.match(quote.quoteDigest, /^[0-9a-f]{64}$/);
  assert.match(quote.payloadDigest, /^[0-9a-f]{64}$/);

  const validation = money.validate(quote, binding());
  assert.equal(validation.valid, true);
  assert.equal(validation.state, 'issued');
  assert.equal(validation.attemptId, null);

  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  assert.ok(Object.isFrozen(hold));
  assert.equal(hold.state, 'reserved');
  assert.equal(hold.attemptId, 'attempt-1');
  assert.equal(hold.amountMicros, 100);
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 100);

  const dispatched = money.markDispatched(hold, binding());
  assert.equal(dispatched.state, 'dispatched');
  assert.equal(dispatched.attemptId, 'attempt-1');

  const settled = money.settle(dispatched, { actualMicros: 90, receiptRef: 'receipt-1' });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.actualMicros, 90);
  assert.equal(settled.receiptRef, 'receipt-1');
  const bucket = usdBucket(budget.describe({ currency: USD }));
  assert.equal(bucket.consumedMicros, 90);
  assert.equal(bucket.reservedMicros, 0);
});

test('clones, JSON round-trips, forgeries, foreign services and forged holds grant nothing', t => {
  const { database, money } = fixture(t);
  const quote = issue(money);
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  const foreign = new TransactionMoneyService(database);

  rejected(() => money.validate({ ...quote }, binding()), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => money.validate(JSON.parse(JSON.stringify(quote)), binding()), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => money.validate(Object.create(quote), binding()), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => money.validate({ ...quote, quoteId: quote.quoteId }, binding()), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => foreign.validate(quote, binding()), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => foreign.reserve(quote, { attemptId: 'attempt-2', binding: binding() }), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => money.markDispatched({ ...hold }, binding()), { code: 'TRANSACTION_HOLD_UNTRUSTED' });
  rejected(() => foreign.markDispatched(hold, binding()), { code: 'TRANSACTION_HOLD_UNTRUSTED' });
  rejected(() => money.cancelBeforeDispatch({ attemptId: hold.attemptId }), { code: 'TRANSACTION_HOLD_UNTRUSTED' });
  rejected(() => money.settle({ ...hold }, { actualMicros: 1, receiptRef: 'r' }), { code: 'TRANSACTION_HOLD_UNTRUSTED' });
});

test('every bound context field must match at validate, reserve and dispatch', t => {
  const { money } = fixture(t);
  const quote = issue(money);
  const mutations = [
    ['provider', { provider: 'provider-b' }],
    ['tool', { tool: 'tool-other' }],
    ['actionFamily', { actionFamily: 'refund' }],
    ['taskId', { taskId: 'task-9' }],
    ['inputVersion', { inputVersion: 2 }],
    ['privacyEpoch', { privacyEpoch: '2' }],
    ['resourceId', { resourceId: 'resource-2' }],
    ['payload', { payload: { merchant: 'merchant-2', amount: 1 } }],
    ['effect', { effect: { kind: 'refund' } }],
    ['mcpSchemaId', { mcpSchemaId: 'schema-1' }],
    ['mcpConnectionId', { mcpConnectionId: 'connection-1' }]
  ];
  for (const [, patch] of mutations) {
    rejected(() => money.validate(quote, binding(patch)), { code: 'TRANSACTION_QUOTE_MISMATCH', reason: 'binding_mismatch' });
  }

  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  rejected(() => money.markDispatched(hold, binding({ provider: 'provider-b' })), { code: 'TRANSACTION_QUOTE_MISMATCH' });
  rejected(() => money.markDispatched(hold, binding({ payload: { merchant: 'merchant-2' } })), { code: 'TRANSACTION_QUOTE_MISMATCH' });
});

test('optional MCP schema and connection identity bind exactly', t => {
  const { money } = fixture(t);
  const quote = issue(money, { mcpSchemaId: 'schema-1', mcpConnectionId: 'connection-1' });
  assert.equal(quote.mcpSchemaId, 'schema-1');
  assert.equal(money.validate(quote, binding({ mcpSchemaId: 'schema-1', mcpConnectionId: 'connection-1' })).valid, true);
  rejected(() => money.validate(quote, binding()), { code: 'TRANSACTION_QUOTE_MISMATCH' });
  rejected(() => money.validate(quote, binding({ mcpSchemaId: 'schema-2', mcpConnectionId: 'connection-1' })), { code: 'TRANSACTION_QUOTE_MISMATCH' });
});

test('amount, currency, expiry, grant and callback are mandatory and never default', t => {
  const { money } = fixture(t);
  for (const bad of [undefined, null, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    rejected(() => money.issueQuote(quoteSpec({ amountMicros: bad }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  }
  rejected(() => money.issueQuote(quoteSpec({ currency: 'GBP' }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ currency: undefined }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ provider: undefined }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ taskId: undefined }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ payload: undefined }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ effect: undefined }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ quoteExpiresAt: 'not-a-time' }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ quoteExpiresAt: '2026-11-13T00:00:00.001Z' }), allow), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.issueQuote(quoteSpec({ grantId: 'missing-grant' }), allow), { code: 'TRANSACTION_QUOTE_GRANT_NOT_FOUND' });

  rejected(() => money.issueQuote(quoteSpec(), {}), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED', reason: 'callback_required' });
  rejected(() => money.issueQuote(quoteSpec(), { isCurrent: true }), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED' });
  rejected(() => money.issueQuote(quoteSpec(), { isCurrent: () => 1 }), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED', reason: 'callback_denied' });
  rejected(() => money.issueQuote(quoteSpec(), { isCurrent: () => false }), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED' });
  rejected(() => money.issueQuote(quoteSpec(), { isCurrent: async () => true }), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED', reason: 'callback_async' });
  rejected(() => money.issueQuote(quoteSpec(), { isCurrent: () => { throw new Error('secret'); } }), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED', reason: 'callback_threw' });

  const zero = issue(money, { amountMicros: 0 });
  const hold = money.reserve(zero, { attemptId: 'zero-attempt', binding: binding() });
  assert.equal(hold.amountMicros, 0);
});

test('the authority-current callback is rechecked at validate, reserve and dispatch', t => {
  const { money } = fixture(t);
  let current = true;
  const authority = { isCurrent: () => current };
  const quote = money.issueQuote(quoteSpec(), authority);
  assert.equal(money.validate(quote, binding()).valid, true);

  current = false;
  rejected(() => money.validate(quote, binding()), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED' });
  rejected(() => money.reserve(quote, { attemptId: 'attempt-1', binding: binding() }), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED' });

  current = true;
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  current = false;
  rejected(() => money.markDispatched(hold, binding()), { code: 'TRANSACTION_QUOTE_UNAUTHORIZED' });
});

test('grant version, revocation and quote expiry invalidate an issued quote', t => {
  const versioned = fixture(t);
  const quote = issue(versioned.money);
  versioned.budget.configureLease({
    grantId: 'grant-1', scope: 'workspace', currency: USD, capMicros: 2000,
    expiresAt: LEASE_EXPIRY, expectedVersion: 1
  });
  rejected(() => versioned.money.validate(quote, binding()), { code: 'TRANSACTION_QUOTE_STALE', reason: 'grant_version_changed' });
  rejected(() => versioned.money.reserve(quote, { attemptId: 'attempt-1', binding: binding() }), { code: 'TRANSACTION_QUOTE_STALE' });

  const revoked = fixture(t);
  const revokedQuote = issue(revoked.money);
  revoked.budget.revokeLease({ grantId: 'grant-1', expectedVersion: 1 });
  rejected(() => revoked.money.validate(revokedQuote, binding()), { code: 'TRANSACTION_QUOTE_STALE', reason: 'grant_revoked' });

  const expired = fixture(t);
  const expiringQuote = issue(expired.money);
  expired.clock.value = Date.parse(QUOTE_EXPIRY);
  rejected(() => expired.money.validate(expiringQuote, binding()), { code: 'TRANSACTION_QUOTE_EXPIRED' });
  rejected(() => expired.money.reserve(expiringQuote, { attemptId: 'attempt-1', binding: binding() }), { code: 'TRANSACTION_QUOTE_EXPIRED' });
  expired.clock.value = START;
  assert.equal(expired.money.validate(expiringQuote, binding()).valid, true);

  const late = fixture(t);
  const lateQuote = issue(late.money);
  const lateHold = late.money.reserve(lateQuote, { attemptId: 'attempt-1', binding: binding() });
  late.clock.value = Date.parse(QUOTE_EXPIRY);
  rejected(() => late.money.markDispatched(lateHold, binding()), { code: 'TRANSACTION_QUOTE_EXPIRED' });
});

test('one quote binds to one attempt and an identical replay does not double reserve', t => {
  const { money, budget } = fixture(t);
  const quote = issue(money);
  const first = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  assert.equal(first.state, 'reserved');

  const replay = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  assert.equal(replay.state, 'reserved');
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 100);

  rejected(() => money.reserve(quote, { attemptId: 'attempt-2', binding: binding() }), { code: 'TRANSACTION_QUOTE_REUSED', reason: 'quote_bound_to_other_attempt' });

  const secondQuote = issue(money);
  rejected(() => money.reserve(secondQuote, { attemptId: 'attempt-1', binding: binding() }), { code: 'TRANSACTION_QUOTE_REUSED', reason: 'attempt_bound_to_other_quote' });
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 100);
});

test('a failed core admission rolls back the quote claim and permits a correct retry', t => {
  const { money, budget } = fixture(t);
  budget.configureLimit({ scope: 'workspace', currency: USD, micros: 0 });
  const quote = issue(money);

  rejected(() => money.reserve(quote, { attemptId: 'attempt-1', binding: binding() }), { code: 'MONEY_BUDGET_EXHAUSTED' });
  assert.equal(money.validate(quote, binding()).state, 'issued');
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 0);

  budget.configureLimit({ scope: 'workspace', currency: USD, micros: 1000 });
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  assert.equal(hold.state, 'reserved');
  const bucket = usdBucket(budget.describe({ currency: USD }));
  assert.equal(bucket.usedMicros, 100);
  assert.equal(bucket.attempts.reserved, 1);
});

test('the existing core cumulative cap blocks reservation and leaves the quote unused', t => {
  const { money, budget } = fixture(t, { lease: { capMicros: 50 } });
  const quote = issue(money);
  rejected(() => money.reserve(quote, { attemptId: 'attempt-1', binding: binding() }), { code: 'MONEY_BUDGET_EXHAUSTED' });
  assert.equal(money.validate(quote, binding()).state, 'issued');
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 0);
});

test('a task-scoped grant requires the exact task id and reserves in that scope', t => {
  const { money, budget } = fixture(t, { lease: { scope: 'task', taskId: 'task-1' } });
  rejected(() => issue(money, { taskId: 'task-2' }), { code: 'TRANSACTION_QUOTE_STALE', reason: 'grant_task_changed' });
  rejected(() => issue(money), { code: 'TRANSACTION_QUOTE_STALE' });

  const quote = issue(money, { taskId: 'task-1' });
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding({ taskId: 'task-1' }) });
  assert.equal(hold.state, 'reserved');
  const reservation = budget.describe({ scope: 'task', taskId: 'task-1', currency: USD }).currencies[0].task;
  assert.equal(reservation.usedMicros, 100);
});

test('cancel is predispatch-only and permanently consumes the quote', t => {
  const { money, budget } = fixture(t);
  const quote = issue(money);
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });

  const cancelled = money.cancelBeforeDispatch(hold);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(money.cancelBeforeDispatch(cancelled).state, 'cancelled');
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 0);

  rejected(() => money.reserve(quote, { attemptId: 'attempt-2', binding: binding() }), { code: 'TRANSACTION_QUOTE_REUSED' });
  rejected(() => money.markDispatched(cancelled, binding()), { code: 'TRANSACTION_HOLD_CONFLICT' });
  rejected(() => money.markUnknown(cancelled), { code: 'TRANSACTION_HOLD_CONFLICT' });
  rejected(() => money.settle(cancelled, { actualMicros: 1, receiptRef: 'receipt-1' }), { code: 'TRANSACTION_HOLD_CONFLICT' });
});

test('a dispatched attempt cannot be marked dispatched a second time', t => {
  const { money } = fixture(t);
  const quote = issue(money);
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  money.markDispatched(hold, binding());
  rejected(() => money.markDispatched(hold, binding()), { code: 'TRANSACTION_HOLD_CONFLICT', reason: 'already_dispatched' });
  rejected(() => money.cancelBeforeDispatch(hold), { code: 'TRANSACTION_HOLD_CONFLICT' });
});

test('an unknown hold is retained across revocation and a later trusted settle records the truth', t => {
  const { money, budget } = fixture(t);
  const quote = issue(money);
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  const dispatched = money.markDispatched(hold, binding());
  const unknown = money.markUnknown(dispatched);
  assert.equal(unknown.state, 'unknown');
  assert.equal(money.markUnknown(unknown).state, 'unknown');
  assert.equal(usdBucket(budget.describe({ currency: USD })).unknownMicros, 100);

  budget.revokeLease({ grantId: 'grant-1', expectedVersion: 1 });
  assert.equal(usdBucket(budget.describe({ currency: USD })).unknownMicros, 100);

  const settled = money.settle(unknown, { actualMicros: 120, receiptRef: 'receipt-proof-1' });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.overrunMicros, 20);
  const bucket = usdBucket(budget.describe({ currency: USD }));
  assert.equal(bucket.consumedMicros, 120);
  assert.equal(bucket.unknownMicros, 0);
});

test('an unknown hold survives a database restart and never becomes a refund', t => {
  const clock = memoryClock();
  const filename = tempFile();
  let database = new DurableDatabase(filename, { now: () => clock.value });
  t.after(() => { try { database.close(); } catch { /* already closed */ } });
  const budget = new MoneyBudgetService(database, { kind: 'transaction' });
  budget.configureLease(leaseInput());
  const money = new TransactionMoneyService(database);
  const quote = money.issueQuote(quoteSpec(), allow);
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });
  money.markUnknown(money.markDispatched(hold, binding()));

  database.close();
  database = new DurableDatabase(filename, { now: () => clock.value });
  const reopened = new MoneyBudgetService(database, { kind: 'transaction' });
  const bucket = usdBucket(reopened.describe({ currency: USD }));
  assert.equal(bucket.unknownMicros, 100);
  assert.equal(bucket.usedMicros, 100);
  assert.equal(bucket.attempts.unknown, 1);
});

test('settlement requires explicit trusted evidence and is idempotent only for identical evidence', t => {
  const { money } = fixture(t);
  const quote = issue(money);
  const hold = money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });

  rejected(() => money.settle(hold, {}), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.settle(hold, { actualMicros: null, receiptRef: 'receipt-1' }), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.settle(hold, { actualMicros: 1.5, receiptRef: 'receipt-1' }), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.settle(hold, { actualMicros: 10 }), { code: 'INVALID_TRANSACTION_QUOTE' });
  rejected(() => money.settle(hold, { actualMicros: 10, receiptRef: '' }), { code: 'INVALID_TRANSACTION_QUOTE' });

  const settled = money.settle(hold, { actualMicros: 10, receiptRef: 'receipt-1' });
  assert.equal(settled.state, 'settled');
  assert.equal(money.settle(settled, { actualMicros: 10, receiptRef: 'receipt-1' }).state, 'settled');
  rejected(() => money.settle(settled, { actualMicros: 11, receiptRef: 'receipt-1' }), { code: 'MONEY_BUDGET_CONFLICT' });
  rejected(() => money.markDispatched(settled, binding()), { code: 'TRANSACTION_HOLD_CONFLICT' });
});

test('the quote stores a deep payload snapshot, not a live reference', t => {
  const { money } = fixture(t);
  const payload = { merchant: 'merchant-1', amount: 1 };
  const quote = money.issueQuote(quoteSpec({ payload }), allow);
  payload.merchant = 'merchant-2';
  payload.amount = 999;

  assert.equal(money.validate(quote, binding({ payload: { merchant: 'merchant-1', amount: 1 } })).valid, true);
  assert.equal(money.validate(quote, binding({ payload: { amount: 1, merchant: 'merchant-1' } })).valid, true);
  rejected(() => money.validate(quote, binding({ payload })), { code: 'TRANSACTION_QUOTE_MISMATCH' });
});

test('tampering with a persisted quote row is detected as untrusted', t => {
  const { database, money } = fixture(t);
  const quote = issue(money);
  database.db.prepare('UPDATE transaction_money_quotes SET amount_micros=99 WHERE quote_id=?').run(quote.quoteId);
  rejected(() => money.validate(quote, binding()), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
  rejected(() => money.reserve(quote, { attemptId: 'attempt-1', binding: binding() }), { code: 'TRANSACTION_QUOTE_UNTRUSTED' });
});

test('quote reuse uniqueness is persisted per attempt across service instances', t => {
  const { database, money, budget } = fixture(t);
  const quote = issue(money);
  money.reserve(quote, { attemptId: 'attempt-1', binding: binding() });

  const other = new TransactionMoneyService(database);
  const otherQuote = other.issueQuote(quoteSpec({ payload: { merchant: 'merchant-2' } }), allow);
  rejected(
    () => other.reserve(otherQuote, { attemptId: 'attempt-1', binding: binding({ payload: { merchant: 'merchant-2' } }) }),
    { code: 'TRANSACTION_QUOTE_REUSED' }
  );
  assert.equal(usdBucket(budget.describe({ currency: USD })).usedMicros, 100);
});
