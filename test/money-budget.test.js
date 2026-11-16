import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DurableDatabase } from '../src/durable/database.js';
import { MoneyBudgetService } from '../src/durable/money-budget.js';

/**
 * Money budget core behaviour.
 *
 * Every test uses the real DurableDatabase and asserts through the public
 * service API, including after reopening a file database. The suite covers the
 * two isolated kinds (model API fees and transaction grant leases), the shared
 * UTC-day workspace/task accounting, currency separation, real SQLite
 * concurrency, restarts, unknown holds, settlement overruns and safe-integer
 * boundaries. It does not test any transport, authority grant or payment.
 */

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const START = Date.parse('2026-11-12T10:00:00.000Z');
const MAX = Number.MAX_SAFE_INTEGER;
const QUOTE_EXPIRY = '2026-11-12T10:30:00.000Z';
const PROFILE = Object.freeze({
  providerId: 'provider-a',
  model: 'model-a',
  protocol: 'messages',
  profileDigest: 'a'.repeat(64),
  revision: 1
});

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-money-budget-'));
  roots.push(directory);
  return path.join(directory, 'workspace.db');
}

function memoryClock(now = START) {
  return { value: now };
}

function fixture(t, kind, { filename = null, clock = memoryClock() } = {}) {
  const database = new DurableDatabase(filename ?? ':memory:', { now: () => clock.value });
  const budget = new MoneyBudgetService(database, { kind });
  t.after(() => database.close());
  return { database, budget, clock };
}

function modelFixture(t, options = {}) {
  const state = fixture(t, 'model', options);
  state.budget.configureProfile({ ...PROFILE, currency: 'USD' });
  return state;
}

function transactionFixture(t, { lease = {}, ...options } = {}) {
  const state = fixture(t, 'transaction', options);
  state.budget.configureLease(leaseInput(lease));
  return state;
}

function leaseInput(overrides = {}) {
  return {
    grantId: 'grant-1',
    scope: 'workspace',
    currency: 'USD',
    capMicros: 1000,
    expiresAt: '2026-11-13T00:00:00.000Z',
    expectedVersion: 0,
    ...overrides
  };
}

function quoteFields(overrides = {}) {
  const { profileSnapshot, grantId, ...rest } = overrides;
  return {
    attemptId: 'a1',
    scope: 'workspace',
    currency: 'USD',
    quotedMicros: 50,
    quoteId: 'quote-1',
    quoteDigest: 'b'.repeat(64),
    quoteExpiresAt: QUOTE_EXPIRY,
    ...rest
  };
}

function modelQuote(overrides = {}) {
  return {
    ...quoteFields(overrides),
    profileSnapshot: { ...PROFILE, ...(overrides.profileSnapshot ?? {}) }
  };
}

function txQuote(overrides = {}) {
  const quote = { ...quoteFields(overrides), grantId: 'grant-1' };
  if (Object.hasOwn(overrides, 'grantId')) quote.grantId = overrides.grantId;
  return quote;
}

function rejected(fn, expected = {}) {
  try {
    fn();
  } catch (error) {
    if (expected.code !== undefined) assert.equal(error.code, expected.code, error.message);
    if (expected.status !== undefined) assert.equal(error.status, expected.status, error.message);
    return error;
  }
  assert.fail(`expected ${expected.code ?? 'an error'}`);
}

function usdBucket(description) {
  const bucket = description.currencies.find(entry => entry.currency === 'USD');
  assert.ok(bucket, 'USD bucket is present');
  return bucket;
}

const settled = (attemptId, actualMicros, receiptRef = `receipt:${attemptId}`) => ({ attemptId, actualMicros, receiptRef });

test('a model quote is reserved, dispatched, settled and described as one snapshot', t => {
  const { budget } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000 });

  const reservation = budget.reserve(modelQuote({ attemptId: 'model-1', quotedMicros: 250 }));
  assert.equal(reservation.state, 'reserved');
  assert.equal(reservation.kind, 'model');
  assert.equal(reservation.quotedMicros, 250);
  assert.equal(reservation.consumedMicros, 250);
  assert.equal(reservation.day, '2026-11-12');
  assert.equal(reservation.quote.expiresAt, '2026-11-12T10:30:00.000Z');
  assert.deepEqual(reservation.profile, { ...PROFILE, version: 1 });
  assert.deepEqual(reservation.grant, null);
  assert.deepEqual(reservation.limits, { workspaceVersion: 1, taskVersion: 0 });

  const reserved = budget.describe({ currency: 'USD' });
  assert.equal(reserved.window, 'utc_day');
  assert.equal(reserved.day, '2026-11-12');
  assert.equal(reserved.nextReset, '2026-11-13T00:00:00.000Z');
  assert.equal(reserved.currencies.length, 1);
  assert.equal(budget.describe({ scope: 'workspace', currency: 'USD' }).currencies[0].task, null);
  assert.throws(() => budget.describe({ scope: 'task', currency: 'USD' }), { code: 'INVALID_MONEY_BUDGET' });
  assert.throws(
    () => budget.describe({ scope: 'workspace', taskId: 'task-1', currency: 'USD' }),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  const workspace = usdBucket(reserved).workspace;
  assert.equal(workspace.limit, 1000);
  assert.equal(workspace.limitConfigured, true);
  assert.equal(workspace.enabled, true);
  assert.equal(workspace.consumedMicros, 0);
  assert.equal(workspace.reservedMicros, 250);
  assert.equal(workspace.unknownMicros, 0);
  assert.equal(workspace.usedMicros, 250);
  assert.equal(workspace.remainingMicros, 750);
  assert.equal(workspace.overrunMicros, 0);
  assert.equal(reserved.pendingReservations.length, 1);
  assert.deepEqual(Object.keys(reserved.pendingReservations[0]).sort(), [
    'actualMicros', 'attemptId', 'createdAt', 'currency', 'day', 'dispatchedAt', 'grantId',
    'overrunMicros', 'quoteExpiresAt', 'quotedMicros', 'scope', 'settledAt', 'state', 'taskId'
  ]);

  const dispatched = budget.markDispatched('model-1');
  assert.equal(dispatched.state, 'dispatched');
  assert.equal(dispatched.dispatchedAt, '2026-11-12T10:00:00.000Z');
  assert.deepEqual(budget.markDispatched('model-1'), dispatched);

  const done = budget.settle(settled('model-1', 240));
  assert.equal(done.state, 'settled');
  assert.equal(done.actualMicros, 240);
  assert.equal(done.overrunMicros, 0);
  assert.equal(done.receiptRef, 'receipt:model-1');
  assert.deepEqual(budget.settle(settled('model-1', 240)), done);

  const after = budget.describe({ currency: 'USD' });
  const afterWorkspace = usdBucket(after).workspace;
  assert.equal(afterWorkspace.consumedMicros, 240);
  assert.equal(afterWorkspace.reservedMicros, 0);
  assert.equal(afterWorkspace.usedMicros, 240);
  assert.equal(afterWorkspace.remainingMicros, 760);
  assert.equal(afterWorkspace.attempts.settled, 1);
  assert.deepEqual(after.pendingReservations, []);
});

test('invalid configuration, incomplete quotes and missing settlement evidence are rejected', t => {
  const { budget } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000 });
  budget.reserve(modelQuote({ attemptId: 'held' }));
  const before = budget.describe();
  const transaction = transactionFixture(t);

  const invalidLimits = [
    ['unknown fields', { scope: 'workspace', currency: 'USD', micros: 1, surprise: true }],
    ['missing scope', { currency: 'USD', micros: 1 }],
    ['unknown scope', { scope: 'global', currency: 'USD', micros: 1 }],
    ['workspace with task', { scope: 'workspace', taskId: 'task-1', currency: 'USD', micros: 1 }],
    ['task without task', { scope: 'task', currency: 'USD', micros: 1 }],
    ['missing currency', { scope: 'workspace', micros: 1 }],
    ['lowercase currency', { scope: 'workspace', currency: 'usd', micros: 1 }],
    ['unsupported currency', { scope: 'workspace', currency: 'GBP', micros: 1 }],
    ['missing micros', { scope: 'workspace', currency: 'USD' }],
    ['undefined micros', { scope: 'workspace', currency: 'USD', micros: undefined }],
    ['negative micros', { scope: 'workspace', currency: 'USD', micros: -1 }],
    ['float micros', { scope: 'workspace', currency: 'USD', micros: 1.5 }],
    ['NaN micros', { scope: 'workspace', currency: 'USD', micros: Number.NaN }],
    ['infinite micros', { scope: 'workspace', currency: 'USD', micros: Infinity }],
    ['string micros', { scope: 'workspace', currency: 'USD', micros: '10' }],
    ['unsafe micros', { scope: 'workspace', currency: 'USD', micros: MAX + 1 }],
    ['negative expected version', { scope: 'workspace', currency: 'USD', micros: 1, expectedVersion: -1 }],
    ['float expected version', { scope: 'workspace', currency: 'USD', micros: 1, expectedVersion: 1.5 }]
  ];
  for (const [label, input] of invalidLimits) {
    assert.throws(() => budget.configureLimit(input), { code: 'INVALID_MONEY_BUDGET', status: 400 }, label);
  }

  const invalidProfiles = [
    ['unknown fields', { ...PROFILE, currency: 'USD', surprise: true }],
    ['missing revision', { ...PROFILE, currency: 'USD', revision: undefined }],
    ['zero revision', { ...PROFILE, currency: 'USD', revision: 0 }],
    ['float revision', { ...PROFILE, currency: 'USD', revision: 1.5 }],
    ['missing digest', { ...PROFILE, currency: 'USD', profileDigest: undefined }],
    ['bad currency', { ...PROFILE, currency: 'GBP' }]
  ];
  for (const [label, input] of invalidProfiles) {
    assert.throws(() => budget.configureProfile(input), { code: 'INVALID_MONEY_BUDGET', status: 400 }, label);
  }

  const incompleteQuotes = [
    ['missing amount', modelQuote({ attemptId: 'q1', quotedMicros: undefined })],
    ['null amount', modelQuote({ attemptId: 'q1', quotedMicros: null })],
    ['missing quote id', modelQuote({ attemptId: 'q1', quoteId: undefined })],
    ['missing quote digest', modelQuote({ attemptId: 'q1', quoteDigest: undefined })],
    ['missing quote expiry', modelQuote({ attemptId: 'q1', quoteExpiresAt: undefined })],
    ['missing profile snapshot', { ...quoteFields({ attemptId: 'q1' }) }]
  ];
  for (const [label, input] of incompleteQuotes) {
    assert.throws(() => budget.reserve(input), { code: 'MONEY_QUOTE_REQUIRED', status: 400 }, label);
  }
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'q1', quotedMicros: 1.5 })),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'q1', surprise: true })),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => budget.reserve({ ...modelQuote({ attemptId: 'q1' }), grantId: 'grant-1' }),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'q1', profileSnapshot: { surprise: true } })),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => budget.reserve(txQuote({ attemptId: 'q1', grantId: undefined })),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => transaction.budget.reserve({ ...txQuote({ attemptId: 'q1' }), profileSnapshot: { ...PROFILE } }),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => transaction.budget.reserve(txQuote({ attemptId: 'q1', grantId: undefined })),
    { code: 'MONEY_LEASE_REQUIRED' }
  );
  assert.throws(
    () => transaction.budget.reserve(txQuote({ attemptId: 'q1', scope: 'task' })),
    { code: 'INVALID_MONEY_BUDGET' }
  );

  const malformedEvidence = [
    ['float actual', { attemptId: 'held', actualMicros: 1.5, receiptRef: 'receipt' }],
    ['negative actual', { attemptId: 'held', actualMicros: -1, receiptRef: 'receipt' }],
    ['string actual', { attemptId: 'held', actualMicros: '1', receiptRef: 'receipt' }],
    ['unknown field', { attemptId: 'held', actualMicros: 1, receiptRef: 'receipt', note: 'x' }]
  ];
  for (const [label, input] of malformedEvidence) {
    assert.throws(() => budget.settle(input), { code: 'INVALID_MONEY_BUDGET' }, label);
  }
  for (const input of [{ attemptId: 'held', receiptRef: 'receipt' }, { attemptId: 'held', actualMicros: null, receiptRef: 'receipt' }]) {
    assert.throws(() => budget.settle(input), { code: 'MONEY_USAGE_REQUIRED', status: 400 });
  }
  for (const input of [
    { attemptId: 'held', actualMicros: 1 },
    { attemptId: 'held', actualMicros: 1, receiptRef: null },
    { attemptId: 'held', actualMicros: 1, receiptRef: undefined }
  ]) {
    assert.throws(() => budget.settle(input), { code: 'MONEY_USAGE_REQUIRED', status: 400 });
  }

  assert.deepEqual(budget.describe(), before, 'rejected calls leave the ledger untouched');
});

test('an explicit zero quote is a known zero while a missing quote is never zero', t => {
  const { budget } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 0 });

  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'missing', quotedMicros: undefined })),
    { code: 'MONEY_QUOTE_REQUIRED' }
  );
  const expiredQuote = rejected(
    () => budget.reserve(modelQuote({ attemptId: 'expired-quote', quotedMicros: 0, quoteExpiresAt: '2026-11-12T09:59:59.000Z' })),
    { code: 'MONEY_BUDGET_STALE', status: 409 }
  );
  assert.equal(expiredQuote.reason, 'quote_expired');
  const zero = budget.reserve(modelQuote({ attemptId: 'zero', quotedMicros: 0 }));
  assert.equal(zero.state, 'reserved');
  assert.equal(zero.quotedMicros, 0);
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'positive', quotedMicros: 1, quoteId: 'quote-2' })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );

  const described = budget.describe({ currency: 'USD' });
  const workspace = usdBucket(described).workspace;
  assert.equal(workspace.limit, 0);
  assert.equal(workspace.usedMicros, 0);
  assert.equal(workspace.remainingMicros, 0);
  assert.equal(workspace.exhausted, true);
  assert.equal(workspace.attempts.reserved, 1);

  budget.markDispatched('zero');
  const done = budget.settle(settled('zero', 0));
  assert.equal(done.state, 'settled');
  assert.equal(done.actualMicros, 0);
  assert.equal(done.consumedMicros, 0);
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.consumedMicros, 0);
});

test('null and zero limits are distinct and configuration changes never clear consumption', t => {
  const { budget } = modelFixture(t);
  assert.equal(budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 }).version, 1);
  budget.reserve(modelQuote({ attemptId: 'spent', quotedMicros: 60 }));
  budget.settle(settled('spent', 60));

  const disabled = budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: null, expectedVersion: 1 });
  assert.equal(disabled.version, 2);
  const described = usdBucket(budget.describe({ currency: 'USD' })).workspace;
  assert.equal(described.limitConfigured, true);
  assert.equal(described.enabled, false);
  assert.equal(described.limit, null);
  assert.equal(described.consumedMicros, 60);
  assert.equal(described.remainingMicros, null);
  assert.equal(described.overrunMicros, 0);
  budget.reserve(modelQuote({ attemptId: 'while-unlimited', quotedMicros: 500, quoteId: 'quote-2' }));
  budget.cancelBeforeDispatch('while-unlimited');

  assert.throws(
    () => budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 10, expectedVersion: 1 }),
    { code: 'MONEY_BUDGET_CONFLICT', status: 409 }
  );
  const lowered = budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 50, expectedVersion: 2 });
  assert.equal(lowered.version, 3);
  const over = usdBucket(budget.describe({ currency: 'USD' })).workspace;
  assert.equal(over.enabled, true);
  assert.equal(over.limit, 50);
  assert.equal(over.consumedMicros, 60);
  assert.equal(over.usedMicros, 60);
  assert.equal(over.remainingMicros, 0);
  assert.equal(over.overrunMicros, 10);
  assert.equal(over.exhausted, true);
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'blocked', quotedMicros: 1, quoteId: 'quote-3' })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );

  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000 });
  assert.equal(usdBucket(budget.describe({ currency: 'USD' })).workspace.consumedMicros, 60, 'raising the limit keeps history');
  budget.reserve(modelQuote({ attemptId: 'after-raise', quotedMicros: 100, quoteId: 'quote-4' }));
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.attempts.settled, 1);
});

test('enabled budgets reject other currencies instead of converting or becoming unlimited', t => {
  const { budget } = modelFixture(t);
  budget.configureProfile({ ...PROFILE, currency: 'CNY', profileDigest: 'c'.repeat(64) });
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  budget.reserve(modelQuote({ attemptId: 'usd-pending', quotedMicros: 30 }));

  const mismatch = rejected(
    () => budget.reserve(modelQuote({ attemptId: 'cny-blocked', currency: 'CNY', quotedMicros: 1, quoteId: 'quote-cny', profileSnapshot: { profileDigest: 'c'.repeat(64) } })),
    { code: 'MONEY_CURRENCY_MISMATCH', status: 409 }
  );
  assert.equal(mismatch.detail.configuredCurrency, 'USD');
  assert.equal(mismatch.detail.requestCurrency, 'CNY');

  budget.configureLimit({ scope: 'task', taskId: 'task-2', currency: 'CNY', micros: 100 });
  const taskMismatch = rejected(
    () => budget.reserve(modelQuote({
      attemptId: 'task-currency-mismatch', scope: 'task', taskId: 'task-2',
      quotedMicros: 1, quoteId: 'quote-task-currency'
    })),
    { code: 'MONEY_CURRENCY_MISMATCH' }
  );
  assert.equal(taskMismatch.detail.scope, 'task');
  assert.equal(taskMismatch.detail.configuredCurrency, 'CNY');

  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: null });
  const cny = budget.reserve(modelQuote({
    attemptId: 'cny-allowed', currency: 'CNY', quotedMicros: 20, quoteId: 'quote-cny',
    profileSnapshot: { profileDigest: 'c'.repeat(64) }
  }));
  assert.equal(cny.state, 'reserved');
  assert.equal(cny.currency, 'CNY');
  assert.equal(budget.markDispatched('cny-allowed').state, 'dispatched', 'a disabled limit in another currency does not block dispatch');
  budget.settle(settled('cny-allowed', 20));

  const switched = budget.configureLimit({ scope: 'workspace', currency: 'CNY', micros: 100 });
  assert.equal(switched.currency, 'CNY');
  assert.throws(
    () => budget.markDispatched('usd-pending'),
    { code: 'MONEY_BUDGET_STALE', status: 409 }
  );

  const both = budget.describe();
  const usd = usdBucket(both).workspace;
  const cnyBucket = both.currencies.find(entry => entry.currency === 'CNY');
  assert.ok(cnyBucket);
  assert.equal(usd.reservedMicros, 30, 'the old USD hold is retained');
  assert.equal(usd.configCurrency, 'CNY');
  assert.equal(usd.limitConfigured, false, 'the USD config is no longer the enabled budget');
  assert.equal(usd.remainingMicros, null);
  assert.equal(cnyBucket.workspace.consumedMicros, 20);
  assert.equal(cnyBucket.workspace.limit, 100);
  assert.equal(cnyBucket.workspace.limitConfigured, true);

  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'usd-after-switch', quotedMicros: 1, quoteId: 'quote-usd-2' })),
    { code: 'MONEY_CURRENCY_MISMATCH' }
  );
  const freshCny = budget.reserve(modelQuote({
    attemptId: 'cny-fresh', currency: 'CNY', quotedMicros: 10, quoteId: 'quote-cny-2',
    profileSnapshot: { profileDigest: 'c'.repeat(64) }
  }));
  assert.equal(budget.markDispatched('cny-fresh').state, 'dispatched');
  assert.equal(freshCny.currency, 'CNY');

  const filtered = budget.describe({ currency: 'CNY' });
  assert.deepEqual(filtered.currencies.map(entry => entry.currency), ['CNY']);
  assert.equal(filtered.currency, 'CNY');
});

test('model and transaction kinds cannot borrow limits, leases, attempts or permits', t => {
  const database = new DurableDatabase(':memory:', { now: () => START });
  t.after(() => database.close());
  const model = new MoneyBudgetService(database, { kind: 'model' });
  const transaction = new MoneyBudgetService(database, { kind: 'transaction' });
  model.configureProfile({ ...PROFILE, currency: 'USD' });
  model.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  transaction.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  transaction.configureLease(leaseInput());

  assert.equal(model.reserve(modelQuote({ attemptId: 'model-own', quotedMicros: 40 })).state, 'reserved');
  assert.equal(transaction.reserve(txQuote({ attemptId: 'tx-own', quotedMicros: 30 })).state, 'reserved');

  assert.equal(model.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 40);
  assert.equal(transaction.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 30);
  assert.equal(transaction.describe({ grantId: 'grant-1' }).lease.usedMicros, 30, 'model spend never touches a lease');

  assert.throws(() => model.configureLease(leaseInput({ grantId: 'model-grant' })), { code: 'INVALID_MONEY_BUDGET' });
  assert.throws(() => transaction.configureProfile({ ...PROFILE, currency: 'USD' }), { code: 'INVALID_MONEY_BUDGET' });
  assert.throws(
    () => model.reserve({ ...modelQuote({ attemptId: 'model-with-grant' }), grantId: 'grant-1' }),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => transaction.reserve({ ...txQuote({ attemptId: 'tx-with-profile' }), profileSnapshot: { ...PROFILE } }),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.throws(
    () => transaction.reserve(txQuote({ attemptId: 'tx-no-grant', grantId: undefined })),
    { code: 'MONEY_LEASE_REQUIRED' }
  );

  assert.equal(model.reserve(modelQuote({ attemptId: 'shared-id', quotedMicros: 1, quoteId: 'quote-shared' })).state, 'reserved');
  const collision = rejected(
    () => transaction.reserve(txQuote({ attemptId: 'shared-id', quotedMicros: 1, quoteId: 'quote-shared' })),
    { code: 'MONEY_BUDGET_CONFLICT' }
  );
  assert.equal(collision.detail.existingKind, 'model');
  assert.throws(() => transaction.settle(settled('shared-id', 1)), { code: 'MONEY_BUDGET_NOT_FOUND' });
  assert.throws(() => transaction.markDispatched('model-own'), { code: 'MONEY_BUDGET_NOT_FOUND' });
  assert.throws(() => model.describe({ grantId: 'grant-1' }), { code: 'INVALID_MONEY_BUDGET' });
});

test('a transaction lease caps cumulative lifetime spend across UTC days', t => {
  const { budget, clock } = transactionFixture(t, {
    lease: { capMicros: 100, expiresAt: '2026-11-15T00:00:00.000Z' }
  });
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });

  budget.reserve(txQuote({ attemptId: 'day-one', quotedMicros: 60 }));
  budget.settle(settled('day-one', 60));

  clock.value = Date.parse('2026-11-13T10:00:00.000Z');
  budget.reserve(txQuote({ attemptId: 'day-two', quotedMicros: 40, quoteExpiresAt: '2026-11-13T10:30:00.000Z' }));
  const blocked = rejected(
    () => budget.reserve(txQuote({ attemptId: 'day-two-extra', quotedMicros: 1, quoteId: 'quote-extra', quoteExpiresAt: '2026-11-13T10:30:00.000Z' })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(blocked.detail.blockedScopes, ['lease']);
  assert.equal(blocked.detail.lease.usedMicros, 100);
  assert.equal(blocked.detail.lease.capMicros, 100);
  assert.equal(blocked.detail.lease.remainingMicros, 0);
  assert.equal(blocked.detail.workspace.usedMicros, 40, 'the daily workspace window reset');
  assert.equal(blocked.detail.workspace.remainingMicros, 60);

  const renewed = budget.configureLease(leaseInput({
    capMicros: 100,
    expiresAt: '2026-11-14T00:00:00.000Z',
    expectedVersion: 1
  }));
  assert.equal(renewed.version, 2);
  assert.equal(renewed.capMicros, 100);
  assert.equal(budget.describe({ grantId: 'grant-1' }).lease.usedMicros, 100, 'renewal does not reset spend or holds');
  assert.throws(
    () => budget.reserve(txQuote({ attemptId: 'after-renewal', quotedMicros: 1, quoteId: 'quote-renewal', quoteExpiresAt: '2026-11-13T10:30:00.000Z' })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );
  assert.throws(
    () => budget.markDispatched('day-two'),
    { code: 'MONEY_BUDGET_STALE' }
  );

  budget.cancelBeforeDispatch('day-two');
  const afterCancel = budget.describe({ grantId: 'grant-1' }).lease;
  assert.equal(afterCancel.usedMicros, 60);
  assert.equal(afterCancel.remainingMicros, 40);
  const replacement = budget.reserve(txQuote({
    attemptId: 'replacement', quotedMicros: 40, quoteId: 'quote-replacement',
    quoteExpiresAt: '2026-11-13T10:30:00.000Z'
  }));
  assert.equal(replacement.state, 'reserved');
  assert.equal(replacement.grant.version, 2);
  assert.equal(budget.markDispatched('replacement').state, 'dispatched');
});

test('lease-only exhaustion never advertises a UTC-day reset or retry', t => {
  const { budget, clock } = transactionFixture(t, {
    lease: { capMicros: 100, expiresAt: '2026-11-15T00:00:00.000Z' }
  });
  budget.reserve(txQuote({ attemptId: 'lease-spend', quotedMicros: 100 }));

  const blocked = rejected(
    () => budget.reserve(txQuote({ attemptId: 'lease-next', quotedMicros: 1, quoteId: 'quote-lease-next' })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(blocked.detail.blockedScopes, ['lease']);
  assert.equal(blocked.detail.resetsAt, null, 'a cumulative lease has no timed reset');
  assert.equal(blocked.detail.dayResetsAt, null, 'no day window is part of this block');
  assert.equal(Object.hasOwn(blocked, 'retryAt'), false, 'no automatic wake-up is promised');
  assert.equal(blocked.detail.lease.usedMicros, 100);
  assert.equal(blocked.detail.lease.capMicros, 100);
  assert.equal(blocked.detail.lease.remainingMicros, 0);
  assert.doesNotMatch(blocked.message, /exhausted for USD on 2026-11-12/);
  assert.match(blocked.message, /cumulative/);
  assert.match(blocked.message, /no timed reset/);

  clock.value = Date.parse('2026-11-13T10:00:00.000Z');
  const acrossMidnight = rejected(
    () => budget.reserve(txQuote({
      attemptId: 'lease-next-day', quotedMicros: 1, quoteId: 'quote-lease-day-two',
      quoteExpiresAt: '2026-11-13T10:30:00.000Z'
    })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(acrossMidnight.detail.blockedScopes, ['lease'], 'the original lease hold still blocks across midnight');
  assert.equal(acrossMidnight.detail.day, '2026-11-13');
  assert.equal(acrossMidnight.detail.resetsAt, null);
  assert.equal(Object.hasOwn(acrossMidnight, 'retryAt'), false);

  clock.value = Date.parse('2026-11-16T00:00:00.000Z');
  const expired = rejected(
    () => budget.reserve(txQuote({
      attemptId: 'lease-expired', quotedMicros: 1, quoteId: 'quote-lease-expired',
      quoteExpiresAt: '2026-11-16T10:30:00.000Z'
    })),
    { code: 'MONEY_LEASE_UNAVAILABLE', status: 409 }
  );
  assert.equal(expired.reason, 'expired', 'lease expiry blocks the grant; it does not restore quota');
});

test('mixed daily-and-lease exhaustion only reports a day-window reset and stays blocked after midnight', t => {
  const { budget, clock } = transactionFixture(t, {
    lease: { capMicros: 100, expiresAt: '2026-11-15T00:00:00.000Z' }
  });
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  budget.reserve(txQuote({ attemptId: 'mixed-spend', quotedMicros: 100 }));

  const blocked = rejected(
    () => budget.reserve(txQuote({ attemptId: 'mixed-next', quotedMicros: 1, quoteId: 'quote-mixed-next' })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(blocked.detail.blockedScopes, ['workspace', 'lease']);
  assert.equal(blocked.detail.resetsAt, null, 'the lease cannot recover on a timer, so there is no overall reset');
  assert.equal(blocked.detail.dayResetsAt, '2026-11-13T00:00:00.000Z', 'the day dimension has its own reset');
  assert.equal(Object.hasOwn(blocked, 'retryAt'), false, 'no automatic retry into a still-exhausted lease');
  assert.equal(blocked.detail.workspace.remainingMicros, 0);
  assert.equal(blocked.detail.lease.remainingMicros, 0);
  assert.match(blocked.message, /day windows? reset/i);
  assert.match(blocked.message, /cumulative lease cap has no timed reset/);
  assert.ok(!blocked.message.includes('exhausted for USD on'), 'the cumulative lease is not described as a daily limit');

  clock.value = Date.parse('2026-11-13T00:00:00.000Z');
  const afterMidnight = rejected(
    () => budget.reserve(txQuote({
      attemptId: 'mixed-after-midnight', quotedMicros: 1, quoteId: 'quote-mixed-midnight',
      quoteExpiresAt: '2026-11-13T00:30:00.000Z'
    })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(afterMidnight.detail.blockedScopes, ['lease'], 'the day window reset but the cumulative lease did not');
  assert.equal(afterMidnight.detail.workspace.usedMicros, 0);
  assert.equal(afterMidnight.detail.workspace.remainingMicros, 100);
  assert.equal(afterMidnight.detail.resetsAt, null);
  assert.equal(afterMidnight.detail.dayResetsAt, null);
  assert.equal(Object.hasOwn(afterMidnight, 'retryAt'), false);
});

test('daily-only exhaustion keeps a credible next-UTC-day recovery', t => {
  const { budget, clock } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  budget.reserve(modelQuote({ attemptId: 'day-spend', quotedMicros: 100 }));

  const blocked = rejected(
    () => budget.reserve(modelQuote({ attemptId: 'day-next', quotedMicros: 1, quoteId: 'quote-day-next' })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(blocked.detail.blockedScopes, ['workspace']);
  assert.equal(blocked.detail.resetsAt, '2026-11-13T00:00:00.000Z');
  assert.equal(blocked.detail.dayResetsAt, '2026-11-13T00:00:00.000Z');
  assert.equal(blocked.retryAt, '2026-11-13T00:00:00.000Z');
  assert.match(blocked.message, /exhausted for USD on 2026-11-12/);

  clock.value = Date.parse('2026-11-13T00:00:00.000Z');
  const recovered = budget.reserve(modelQuote({
    attemptId: 'day-recovered', quotedMicros: 100, quoteId: 'quote-day-recovered',
    quoteExpiresAt: '2026-11-13T00:30:00.000Z'
  }));
  assert.equal(recovered.day, '2026-11-13');
  assert.equal(recovered.state, 'reserved');
  assert.equal(recovered.quotedMicros, 100);

  const taskOnly = modelFixture(t);
  taskOnly.budget.configureLimit({ scope: 'task', taskId: 'task-1', currency: 'USD', micros: 50 });
  taskOnly.budget.reserve(modelQuote({
    attemptId: 'task-spend', scope: 'task', taskId: 'task-1', quotedMicros: 50
  }));
  const taskBlocked = rejected(
    () => taskOnly.budget.reserve(modelQuote({
      attemptId: 'task-next', scope: 'task', taskId: 'task-1', quotedMicros: 1, quoteId: 'quote-task-next'
    })),
    { code: 'MONEY_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.deepEqual(taskBlocked.detail.blockedScopes, ['task']);
  assert.equal(taskBlocked.detail.resetsAt, '2026-11-13T00:00:00.000Z');
  assert.equal(taskBlocked.retryAt, taskBlocked.detail.resetsAt);

  taskOnly.clock.value = Date.parse('2026-11-13T00:00:00.000Z');
  const taskRecovered = taskOnly.budget.reserve(modelQuote({
    attemptId: 'task-recovered', scope: 'task', taskId: 'task-1', quotedMicros: 50,
    quoteId: 'quote-task-recovered', quoteExpiresAt: '2026-11-13T00:30:00.000Z'
  }));
  assert.equal(taskRecovered.day, '2026-11-13');
  assert.equal(taskRecovered.state, 'reserved');
});

test('transaction leases require a live, matching grant and revocation never refunds', t => {
  const { budget, clock } = transactionFixture(t, {
    lease: { scope: 'task', taskId: 'task-1', capMicros: 100, expiresAt: '2026-11-12T12:00:00.000Z' }
  });

  assert.throws(() => budget.reserve(txQuote({ attemptId: 'workspace-spend' })), { code: 'MONEY_LEASE_UNAVAILABLE' });
  assert.throws(
    () => budget.reserve(txQuote({ attemptId: 'other-task', scope: 'task', taskId: 'task-2' })),
    { code: 'MONEY_LEASE_UNAVAILABLE' }
  );
  assert.throws(
    () => budget.reserve(txQuote({ attemptId: 'no-grant', grantId: 'missing' })),
    { code: 'MONEY_LEASE_NOT_FOUND', status: 404 }
  );
  assert.throws(
    () => budget.reserve(txQuote({ attemptId: 'cny', scope: 'task', taskId: 'task-1', currency: 'CNY' })),
    { code: 'MONEY_CURRENCY_MISMATCH' }
  );

  budget.reserve(txQuote({ attemptId: 'sent', scope: 'task', taskId: 'task-1', quotedMicros: 40 }));
  budget.markDispatched('sent');
  budget.reserve(txQuote({ attemptId: 'waiting', scope: 'task', taskId: 'task-1', quotedMicros: 20, quoteId: 'quote-waiting' }));
  assert.throws(
    () => budget.configureLease(leaseInput({ scope: 'workspace', expectedVersion: 1 })),
    { code: 'MONEY_BUDGET_CONFLICT' }
  );

  assert.throws(
    () => budget.revokeLease({ grantId: 'grant-1', expectedVersion: 7 }),
    { code: 'MONEY_BUDGET_CONFLICT' }
  );
  const revoked = budget.revokeLease({ grantId: 'grant-1', expectedVersion: 1 });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.version, 2);
  assert.deepEqual(budget.revokeLease({ grantId: 'grant-1', expectedVersion: 2 }), revoked);
  assert.throws(
    () => budget.configureLease(leaseInput({ scope: 'task', taskId: 'task-1', expectedVersion: 2 })),
    { code: 'MONEY_BUDGET_CONFLICT' }
  );

  assert.throws(() => budget.reserve(txQuote({ attemptId: 'after-revoke', scope: 'task', taskId: 'task-1' })), { code: 'MONEY_LEASE_UNAVAILABLE' });
  assert.throws(() => budget.markDispatched('waiting'), { code: 'MONEY_BUDGET_STALE' });
  const cancelled = budget.cancelBeforeDispatch('waiting');
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(budget.cancelBeforeDispatch('waiting'), cancelled);
  assert.equal(budget.describe({ grantId: 'grant-1' }).lease.usedMicros, 40, 'revocation keeps the dispatched hold');

  const late = budget.settle(settled('sent', 55));
  assert.equal(late.state, 'settled');
  assert.equal(late.actualMicros, 55);
  assert.equal(late.overrunMicros, 15);
  const lease = budget.describe({ grantId: 'grant-1' }).lease;
  assert.equal(lease.revoked, true);
  assert.equal(lease.consumedMicros, 55);
  assert.equal(lease.settledOverrunMicros, 15);
  assert.equal(lease.usedMicros, 55);
  assert.equal(lease.remainingMicros, 45);

  clock.value = Date.parse('2026-11-12T12:00:00.000Z');
  const expired = transactionFixture(t, {
    lease: { grantId: 'grant-expired', capMicros: 50, expiresAt: '2026-11-12T11:00:00.000Z' }
  });
  expired.clock.value = Date.parse('2026-11-12T11:00:01.000Z');
  assert.throws(
    () => expired.budget.reserve(txQuote({
      attemptId: 'expired-direct', grantId: 'grant-expired',
      quoteExpiresAt: '2026-11-12T11:30:00.000Z'
    })),
    { code: 'MONEY_LEASE_UNAVAILABLE' }
  );
  expired.clock.value = Date.parse('2026-11-12T10:30:00.000Z');
  expired.budget.configureLease(leaseInput({ grantId: 'grant-expiring', capMicros: 50, expiresAt: '2026-11-12T11:00:00.000Z' }));
  expired.budget.reserve(txQuote({
    attemptId: 'before-expiry', grantId: 'grant-expiring', quotedMicros: 10,
    quoteExpiresAt: '2026-11-12T11:30:00.000Z'
  }));
  expired.budget.markDispatched('before-expiry');
  expired.budget.reserve(txQuote({
    attemptId: 'reserved-before-expiry', grantId: 'grant-expiring', quotedMicros: 10, quoteId: 'quote-2',
    quoteExpiresAt: '2026-11-12T11:30:00.000Z'
  }));
  expired.clock.value = Date.parse('2026-11-12T11:00:01.000Z');
  assert.throws(() => expired.budget.reserve(txQuote({
    attemptId: 'after-expiry', grantId: 'grant-expiring',
    quoteExpiresAt: '2026-11-12T11:30:00.000Z'
  })), { code: 'MONEY_LEASE_UNAVAILABLE' });
  assert.throws(() => expired.budget.markDispatched('reserved-before-expiry'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(expired.budget.cancelBeforeDispatch('reserved-before-expiry').state, 'cancelled', 'expired leases can be cancelled before dispatch');
  assert.equal(expired.budget.settle(settled('before-expiry', 12)).state, 'settled', 'expired leases accept late real settlements');
});

test('dispatch rechecks the day, quote, config, profile and current balances', t => {
  const { budget, clock } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });

  budget.reserve(modelQuote({ attemptId: 'stale-day', quotedMicros: 10 }));
  clock.value = Date.parse('2026-11-13T00:10:00.000Z');
  const staleDay = rejected(() => budget.markDispatched('stale-day'), { code: 'MONEY_BUDGET_STALE', status: 409 });
  assert.equal(staleDay.reason, 'stale_day');
  assert.deepEqual(staleDay.detail, { attemptId: 'stale-day', reason: 'stale_day', reservedDay: '2026-11-12', currentDay: '2026-11-13' });

  budget.reserve(modelQuote({
    attemptId: 'expiring',
    quotedMicros: 10,
    quoteId: 'quote-expiring',
    quoteExpiresAt: '2026-11-13T00:20:00.000Z'
  }));
  clock.value = Date.parse('2026-11-13T00:21:00.000Z');
  const expired = rejected(() => budget.markDispatched('expiring'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(expired.reason, 'quote_expired');
  budget.cancelBeforeDispatch('expiring');

  clock.value = Date.parse('2026-11-13T00:25:00.000Z');
  budget.reserve(modelQuote({
    attemptId: 'config-change',
    quotedMicros: 10,
    quoteId: 'quote-config',
    quoteExpiresAt: '2026-11-13T01:00:00.000Z'
  }));
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  const changed = rejected(() => budget.markDispatched('config-change'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(changed.reason, 'workspace_config_changed');
  budget.cancelBeforeDispatch('config-change');

  budget.reserve(modelQuote({
    attemptId: 'profile-change',
    quotedMicros: 10,
    quoteId: 'quote-profile',
    quoteExpiresAt: '2026-11-13T01:00:00.000Z'
  }));
  budget.configureProfile({ ...PROFILE, currency: 'USD' });
  const profileChanged = rejected(() => budget.markDispatched('profile-change'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(profileChanged.reason, 'profile_changed');
  budget.cancelBeforeDispatch('profile-change');

  budget.reserve(modelQuote({
    attemptId: 'first',
    quotedMicros: 40,
    quoteId: 'quote-first',
    quoteExpiresAt: '2026-11-13T01:00:00.000Z'
  }));
  budget.reserve(modelQuote({
    attemptId: 'second',
    quotedMicros: 60,
    quoteId: 'quote-second',
    quoteExpiresAt: '2026-11-13T01:00:00.000Z'
  }));
  assert.equal(budget.markDispatched('first').state, 'dispatched');
  budget.settle(settled('first', 130));
  const balanceBlocked = rejected(() => budget.markDispatched('second'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(balanceBlocked.reason, 'workspace_limit_exceeded');
  assert.equal(balanceBlocked.detail.usedMicros, 190);
  assert.equal(balanceBlocked.detail.overrunMicros, 90);

  clock.value = Date.parse('2026-11-14T00:05:00.000Z');
  const fresh = budget.reserve(modelQuote({
    attemptId: 'fresh',
    quotedMicros: 10,
    quoteId: 'quote-fresh',
    quoteExpiresAt: '2026-11-14T01:00:00.000Z'
  }));
  assert.equal(fresh.day, '2026-11-14');
  assert.equal(budget.markDispatched('fresh').state, 'dispatched');
  assert.equal(budget.markDispatched('fresh').state, 'dispatched');
  const refund = rejected(() => budget.cancelBeforeDispatch('fresh'), { code: 'MONEY_BUDGET_ALREADY_DISPATCHED', status: 409 });
  assert.equal(refund.attemptId, 'fresh');
  assert.equal(refund.state, 'dispatched');
});

test('transaction dispatch rechecks the lease version, revocation, expiry and capacity', t => {
  const { budget, clock } = transactionFixture(t, { lease: { capMicros: 100 } });
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  budget.reserve(txQuote({ attemptId: 'a', quotedMicros: 40 }));
  budget.reserve(txQuote({ attemptId: 'b', quotedMicros: 60, quoteId: 'quote-b' }));
  budget.markDispatched('a');
  budget.settle(settled('a', 80));
  const blocked = rejected(() => budget.markDispatched('b'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(blocked.reason, 'lease_limit_exceeded');
  assert.equal(blocked.detail.usedMicros, 140);
  assert.equal(blocked.detail.overrunMicros, 40);
  budget.cancelBeforeDispatch('b');

  budget.reserve(txQuote({ attemptId: 'renewed', quotedMicros: 5, quoteId: 'quote-renewed' }));
  budget.configureLease(leaseInput({ capMicros: 200, expiresAt: '2026-11-13T00:00:00.000Z', expectedVersion: 1 }));
  const leaseChanged = rejected(() => budget.markDispatched('renewed'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(leaseChanged.reason, 'lease_changed');

  budget.configureLease(leaseInput({ capMicros: 200, expiresAt: '2026-11-13T00:00:00.000Z', expectedVersion: 2 }));
  budget.reserve(txQuote({ attemptId: 'revocable', quotedMicros: 5, quoteId: 'quote-revocable' }));
  budget.revokeLease({ grantId: 'grant-1', expectedVersion: 3 });
  const revoked = rejected(() => budget.markDispatched('revocable'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(revoked.reason, 'lease_revoked');

  clock.value = Date.parse('2026-11-12T10:30:00.000Z');
  budget.configureLease(leaseInput({ grantId: 'grant-time', capMicros: 100, expiresAt: '2026-11-12T11:00:00.000Z' }));
  budget.reserve(txQuote({
    attemptId: 'expires', grantId: 'grant-time', quotedMicros: 5,
    quoteExpiresAt: '2026-11-12T11:30:00.000Z'
  }));
  clock.value = Date.parse('2026-11-12T11:00:01.000Z');
  const expired = rejected(() => budget.markDispatched('expires'), { code: 'MONEY_BUDGET_STALE' });
  assert.equal(expired.reason, 'lease_expired');
});

test('unknown holds survive restarts and later trusted settlement, never auto-refund', t => {
  const filename = tempFile();
  const clock = memoryClock();
  const first = modelFixture(t, { filename, clock });
  first.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  first.budget.reserve(modelQuote({ attemptId: 'unknown-model', quotedMicros: 70 }));
  first.budget.markDispatched('unknown-model');
  const unknown = first.budget.markUnknown('unknown-model');
  assert.deepEqual(first.budget.markUnknown('unknown-model'), unknown);
  first.database.close();

  const second = modelFixture(t, { filename, clock });
  const described = second.budget.describe({ currency: 'USD' }).currencies[0].workspace;
  assert.equal(described.unknownMicros, 70);
  assert.equal(described.reservedMicros, 0);
  assert.equal(described.usedMicros, 70);
  assert.equal(second.budget.describe({ currency: 'USD' }).pendingReservations[0].state, 'unknown');
  assert.throws(() => second.budget.cancelBeforeDispatch('unknown-model'), { code: 'MONEY_BUDGET_CONFLICT' });
  assert.throws(() => second.budget.markDispatched('unknown-model'), { code: 'MONEY_BUDGET_CONFLICT' });
  assert.throws(() => second.budget.reserve(modelQuote({ attemptId: 'new', quotedMicros: 31, quoteId: 'quote-new' })), { code: 'MONEY_BUDGET_EXHAUSTED' });

  const resolved = second.budget.settle(settled('unknown-model', 90));
  assert.equal(resolved.state, 'settled');
  assert.equal(resolved.actualMicros, 90);
  assert.equal(resolved.overrunMicros, 20);
  const final = second.budget.describe({ currency: 'USD' }).currencies[0].workspace;
  assert.equal(final.consumedMicros, 90);
  assert.equal(final.unknownMicros, 0);
  assert.equal(final.settledOverrunMicros, 20);
  second.database.close();

  const filenameTx = tempFile();
  const txClock = memoryClock();
  const txFirst = transactionFixture(t, { filename: filenameTx, clock: txClock, lease: { capMicros: 100 } });
  txFirst.budget.reserve(txQuote({ attemptId: 'unknown-tx', quotedMicros: 60 }));
  txFirst.budget.markDispatched('unknown-tx');
  txFirst.budget.markUnknown('unknown-tx');
  txFirst.budget.revokeLease({ grantId: 'grant-1', expectedVersion: 1 });
  txFirst.database.close();

  const txSecond = fixture(t, 'transaction', { filename: filenameTx, clock: txClock });
  const lease = txSecond.budget.describe({ grantId: 'grant-1' }).lease;
  assert.equal(lease.unknownMicros, 60);
  assert.equal(lease.usedMicros, 60);
  assert.equal(lease.revoked, true);
  const settledLate = txSecond.budget.settle(settled('unknown-tx', 120));
  assert.equal(settledLate.state, 'settled');
  assert.equal(settledLate.overrunMicros, 60);
  const afterTx = txSecond.budget.describe({ grantId: 'grant-1' }).lease;
  assert.equal(afterTx.consumedMicros, 120);
  assert.equal(afterTx.overrunMicros, 20);
  assert.equal(afterTx.settledOverrunMicros, 60);
  assert.equal(afterTx.exhausted, true);
});

test('actual usage above the quote is recorded truthfully as debt, not truncated', t => {
  const { budget } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  budget.reserve(modelQuote({ attemptId: 'over', quotedMicros: 50 }));
  const result = budget.settle(settled('over', 130));
  assert.equal(result.actualMicros, 130);
  assert.equal(result.overrunMicros, 80);
  assert.equal(result.consumedMicros, 130);
  const workspace = budget.describe({ currency: 'USD' }).currencies[0].workspace;
  assert.equal(workspace.consumedMicros, 130);
  assert.equal(workspace.usedMicros, 130);
  assert.equal(workspace.limit, 100);
  assert.equal(workspace.overrunMicros, 30);
  assert.equal(workspace.settledOverrunMicros, 80);
  assert.equal(workspace.exhausted, true);
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'next', quotedMicros: 1, quoteId: 'quote-next' })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );

  const transaction = transactionFixture(t, { lease: { capMicros: 50 } });
  transaction.budget.reserve(txQuote({ attemptId: 'tx-over', quotedMicros: 30 }));
  transaction.budget.settle(settled('tx-over', 80));
  const lease = transaction.budget.describe({ grantId: 'grant-1' }).lease;
  assert.equal(lease.consumedMicros, 80);
  assert.equal(lease.usedMicros, 80);
  assert.equal(lease.capMicros, 50);
  assert.equal(lease.overrunMicros, 30);
  assert.equal(lease.settledOverrunMicros, 50);
  assert.throws(
    () => transaction.budget.reserve(txQuote({ attemptId: 'tx-next', quotedMicros: 1, quoteId: 'quote-tx-next' })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );
});

test('attempt ids are idempotent keys and conflicting payloads are explicit', t => {
  const { budget } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000 });
  const original = modelQuote({ attemptId: 'idem', quotedMicros: 25 });
  const first = budget.reserve(original);
  assert.deepEqual(budget.reserve(original), first);
  assert.deepEqual(
    budget.reserve({ ...original, quoteExpiresAt: Date.parse(QUOTE_EXPIRY) }),
    first,
    'an equivalent instant is the same quote payload'
  );
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 25);

  const conflicts = [
    ['amount', modelQuote({ attemptId: 'idem', quotedMicros: 26 })],
    ['quote id', modelQuote({ attemptId: 'idem', quotedMicros: 25, quoteId: 'quote-other' })],
    ['quote digest', modelQuote({ attemptId: 'idem', quotedMicros: 25, quoteDigest: 'c'.repeat(64) })],
    ['quote expiry', modelQuote({ attemptId: 'idem', quotedMicros: 25, quoteExpiresAt: '2026-11-12T10:31:00.000Z' })],
    ['currency', modelQuote({ attemptId: 'idem', quotedMicros: 25, currency: 'CNY' })],
    ['profile digest', modelQuote({ attemptId: 'idem', quotedMicros: 25, profileSnapshot: { profileDigest: 'd'.repeat(64) } })],
    ['profile revision', modelQuote({ attemptId: 'idem', quotedMicros: 25, profileSnapshot: { revision: 2 } })],
    ['scope', modelQuote({ attemptId: 'idem', quotedMicros: 25, scope: 'task', taskId: 'task-1' })]
  ];
  for (const [label, input] of conflicts) {
    const error = rejected(() => budget.reserve(input), { code: 'MONEY_BUDGET_CONFLICT', status: 409 });
    assert.ok(error.detail.differingFields.length > 0, label);
  }
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 25);

  budget.markDispatched('idem');
  assert.equal(budget.reserve(original).state, 'dispatched');
  budget.markUnknown('idem');
  assert.equal(budget.reserve(original).state, 'unknown');
  budget.settle(settled('idem', 20));
  const settledReplay = budget.reserve(original);
  assert.equal(settledReplay.state, 'settled');
  assert.equal(settledReplay.actualMicros, 20);
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 20);

  const transaction = transactionFixture(t);
  const txOriginal = txQuote({ attemptId: 'tx-idem', quotedMicros: 10 });
  transaction.budget.reserve(txOriginal);
  assert.throws(
    () => transaction.budget.reserve(txQuote({ attemptId: 'tx-idem', quotedMicros: 10, grantId: 'other-grant' })),
    { code: 'MONEY_BUDGET_CONFLICT' }
  );

  const filename = tempFile();
  const clock = memoryClock();
  const firstInstance = modelFixture(t, { filename, clock });
  const secondInstance = modelFixture(t, { filename, clock });
  const payload = modelQuote({ attemptId: 'cross-instance', quotedMicros: 30, quoteId: 'quote-cross' });
  const stored = firstInstance.budget.reserve(payload);
  assert.deepEqual(secondInstance.budget.reserve(payload), stored);
  assert.throws(
    () => secondInstance.budget.reserve({ ...payload, quotedMicros: 31 }),
    { code: 'MONEY_BUDGET_CONFLICT' }
  );
  assert.equal(secondInstance.budget.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 30);
  assert.equal(secondInstance.budget.describe({ currency: 'USD' }).pendingReservations.length, 1);
});

test('transaction daily workspace and task budgets intersect with the lease', t => {
  const { budget } = transactionFixture(t, { lease: { capMicros: 1000 } });
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 30 });
  budget.configureLimit({ scope: 'task', taskId: 'task-1', currency: 'USD', micros: 20 });

  budget.reserve(txQuote({ attemptId: 'base', scope: 'task', taskId: 'task-1', quotedMicros: 15 }));
  const taskBlocked = rejected(
    () => budget.reserve(txQuote({ attemptId: 'task-blocked', scope: 'task', taskId: 'task-1', quotedMicros: 10, quoteId: 'quote-task-blocked' })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(taskBlocked.detail.blockedScopes, ['task']);
  assert.equal(taskBlocked.detail.task.usedMicros, 15);
  assert.equal(taskBlocked.detail.task.limit, 20);
  assert.equal(taskBlocked.detail.workspace.blocked, false);
  assert.equal(taskBlocked.detail.lease.blocked, false);

  const workspaceBlocked = rejected(
    () => budget.reserve(txQuote({ attemptId: 'workspace-blocked', scope: 'workspace', quotedMicros: 16, quoteId: 'quote-workspace-blocked' })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(workspaceBlocked.detail.blockedScopes, ['workspace']);
  assert.equal(workspaceBlocked.detail.workspace.usedMicros, 15);
  assert.equal(workspaceBlocked.detail.workspace.limit, 30);

  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000 });
  budget.configureLimit({ scope: 'task', taskId: 'task-1', currency: 'USD', micros: 1000 });
  budget.cancelBeforeDispatch('base');
  budget.configureLease(leaseInput({ grantId: 'grant-small', capMicros: 10 }));
  const blocked = rejected(
    () => budget.reserve(txQuote({ attemptId: 'lease-blocked', grantId: 'grant-small', quotedMicros: 11 })),
    { code: 'MONEY_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(blocked.detail.blockedScopes, ['lease']);
  assert.equal(blocked.detail.lease.capMicros, 10);
  assert.equal(blocked.detail.lease.usedMicros, 0);
  assert.equal(budget.describe({ grantId: 'grant-small' }).lease.capMicros, 10);
});

test('settlements keep the original UTC day and grant when they arrive late', t => {
  const { budget, clock } = modelFixture(t);
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  budget.reserve(modelQuote({ attemptId: 'late-model', quotedMicros: 40 }));
  budget.markDispatched('late-model');

  clock.value = Date.parse('2026-11-13T09:00:00.000Z');
  const late = budget.settle(settled('late-model', 45));
  assert.equal(late.state, 'settled');
  assert.equal(late.day, '2026-11-12');
  assert.equal(budget.describe({ date: '2026-11-12', currency: 'USD' }).currencies[0].workspace.consumedMicros, 45);
  assert.equal(budget.describe({ date: '2026-11-13', currency: 'USD' }).currencies[0].workspace.consumedMicros, 0);

  const transaction = transactionFixture(t);
  transaction.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  transaction.budget.reserve(txQuote({ attemptId: 'late-tx', quotedMicros: 30 }));
  transaction.budget.revokeLease({ grantId: 'grant-1', expectedVersion: 1 });
  transaction.clock.value = Date.parse('2026-11-13T09:00:00.000Z');
  transaction.budget.settle(settled('late-tx', 35));
  assert.equal(transaction.budget.describe({ date: '2026-11-12', currency: 'USD' }).currencies[0].workspace.consumedMicros, 35);
  assert.equal(transaction.budget.describe({ date: '2026-11-13', currency: 'USD' }).currencies[0].workspace.consumedMicros, 0);
  assert.equal(transaction.budget.describe({ grantId: 'grant-1' }).lease.consumedMicros, 35);
});

test('safe integer boundaries and aggregate overflow fail closed', t => {
  const { budget } = modelFixture(t);
  budget.reserve(modelQuote({ attemptId: 'max', quotedMicros: MAX }));
  const overflow = rejected(
    () => budget.reserve(modelQuote({ attemptId: 'plus-one', quotedMicros: 1, quoteId: 'quote-plus-one' })),
    { code: 'MONEY_BUDGET_OVERFLOW', status: 409 }
  );
  assert.equal(overflow.detail.usedMicros, MAX);
  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'split', quotedMicros: MAX, quoteId: 'quote-split' })),
    { code: 'MONEY_BUDGET_OVERFLOW' }
  );
  const maxed = budget.describe({ currency: 'USD' }).currencies[0].workspace;
  assert.equal(maxed.usedMicros, MAX);
  assert.equal(Number.isSafeInteger(maxed.usedMicros), true);
  assert.equal(maxed.attempts.reserved, 1);

  const held = modelFixture(t);
  held.budget.reserve(modelQuote({ attemptId: 'base', quotedMicros: MAX - 10 }));
  held.budget.reserve(modelQuote({ attemptId: 'edge', quotedMicros: 10, quoteId: 'quote-edge' }));
  const before = held.budget.describe();
  const settleOverflow = rejected(() => held.budget.settle(settled('edge', 20)), { code: 'MONEY_BUDGET_OVERFLOW' });
  assert.equal(settleOverflow.detail.retainedReservation, true);
  assert.equal(settleOverflow.detail.requiresMarkUnknown, true);
  assert.equal(settleOverflow.detail.scope, 'workspace');
  assert.deepEqual(held.budget.describe(), before, 'the hold is retained after an unrepresentable settlement');
  assert.equal(held.budget.markUnknown('edge').state, 'unknown');
  const afterUnknown = held.budget.describe({ currency: 'USD' }).currencies[0].workspace;
  assert.equal(afterUnknown.unknownMicros, 10);
  assert.equal(afterUnknown.reservedMicros, MAX - 10);
  assert.equal(afterUnknown.usedMicros, MAX);

  assert.throws(
    () => held.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: MAX + 1 }),
    { code: 'INVALID_MONEY_BUDGET' }
  );
  assert.equal(held.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: MAX }).micros, MAX);
  assert.throws(
    () => held.budget.reserve(modelQuote({ attemptId: 'limit-over', quotedMicros: 1, quoteId: 'quote-limit-over' })),
    { code: 'MONEY_BUDGET_OVERFLOW' }
  );

  const transaction = transactionFixture(t, { lease: { capMicros: MAX } });
  transaction.budget.reserve(txQuote({ attemptId: 'lease-max', quotedMicros: MAX }));
  assert.throws(
    () => transaction.budget.reserve(txQuote({ attemptId: 'lease-plus', quotedMicros: 1, quoteId: 'quote-lease-plus' })),
    { code: 'MONEY_BUDGET_OVERFLOW' }
  );
  const lease = transaction.budget.describe({ grantId: 'grant-1' }).lease;
  assert.equal(lease.usedMicros, MAX);
  assert.equal(lease.remainingMicros, 0);
});

test('describe is one bounded read snapshot and reuses an active transaction', t => {
  const { budget } = modelFixture(t);
  for (let index = 0; index < 201; index++) {
    budget.reserve(modelQuote({
      attemptId: `pending-${String(index).padStart(3, '0')}`,
      quotedMicros: 0,
      quoteId: 'quote-bounded'
    }));
  }
  const described = budget.describe({ currency: 'USD' });
  assert.equal(described.pendingReservations.length, 200);
  assert.equal(described.pendingTruncated, true);

  const { database, budget: reused } = modelFixture(t);
  reused.configureLimit({ scope: 'workspace', currency: 'USD', micros: 50 });
  reused.reserve(modelQuote({ attemptId: 'in-tx', quotedMicros: 10 }));
  database.atomic(() => {
    reused.configureLimit({ scope: 'workspace', currency: 'USD', micros: 60 });
    assert.equal(reused.describe({ currency: 'USD' }).currencies[0].workspace.limit, 60);
    reused.reserve(modelQuote({ attemptId: 'in-tx-2', quotedMicros: 5, quoteId: 'quote-in-tx-2' }));
    assert.equal(reused.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 15);
  });
  assert.equal(reused.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 15);

  let constructed;
  database.atomic(() => { constructed = new MoneyBudgetService(database, { kind: 'transaction' }); });
  assert.ok(constructed instanceof MoneyBudgetService);
  constructed.configureLease(leaseInput({ grantId: 'inside-tx' }));
  assert.equal(constructed.describe({ grantId: 'inside-tx' }).lease.grantId, 'inside-tx');
});

test('describe reads a snapshot without taking a write lock', t => {
  const filename = tempFile();
  const clock = memoryClock();
  const reader = modelFixture(t, { filename, clock });
  reader.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  reader.budget.reserve(modelQuote({ attemptId: 'held', quotedMicros: 10 }));

  const writer = new DurableDatabase(filename, { now: () => clock.value, busyTimeoutMs: 100 });
  t.after(() => writer.close());
  writer.db.exec('BEGIN IMMEDIATE');
  try {
    const described = reader.budget.describe({ currency: 'USD' });
    assert.equal(described.currencies[0].workspace.usedMicros, 10);
    assert.deepEqual(described.pendingReservations.map(row => row.attemptId), ['held']);
  } finally {
    writer.db.exec('ROLLBACK');
  }
});

test('describe accepts only unambiguous UTC dates', t => {
  const { budget } = modelFixture(t);
  const invalidDates = [
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
  for (const date of invalidDates) {
    assert.throws(() => budget.describe({ date }), { code: 'INVALID_MONEY_BUDGET' }, String(date));
  }
  assert.equal(budget.describe({ date: '2026-11-12' }).day, '2026-11-12');
  assert.equal(budget.describe({ date: '2026-11-12T00:00:00Z' }).day, '2026-11-12');
  assert.equal(budget.describe({ date: '2026-11-12T00:00:00+08:00' }).day, '2026-11-11');
  assert.equal(budget.describe({ date: '2026-11-12T00:00:00-0200' }).day, '2026-11-12');
  assert.equal(budget.describe({ date: Date.parse('2026-11-12T10:00:00Z') }).day, '2026-11-12');
  assert.equal(budget.describe({ date: new Date('2026-11-12T10:00:00Z') }).day, '2026-11-12');
  const edge = budget.describe({ date: '9999-12-31' });
  assert.equal(edge.day, '9999-12-31');
  assert.equal(Number.isNaN(Date.parse(edge.nextReset)), false);
  assert.equal(new Date(edge.nextReset).getTime(), Date.parse('9999-12-31T00:00:00.000Z') + 86400000);
});

test('detaching a forgotten task keeps workspace and lease occupancy without deleting the account', t => {
  const database = new DurableDatabase(':memory:', { now: () => START });
  t.after(() => database.close());
  const model = new MoneyBudgetService(database, { kind: 'model' });
  const transaction = new MoneyBudgetService(database, { kind: 'transaction' });
  model.configureProfile({ ...PROFILE, currency: 'USD' });
  model.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  model.configureLimit({ scope: 'task', taskId: 'task-1', currency: 'USD', micros: 80 });
  transaction.configureLease(leaseInput());
  transaction.configureLimit({ scope: 'task', taskId: 'task-1', currency: 'USD', micros: 80 });

  model.reserve(modelQuote({ attemptId: 'model-task', scope: 'task', taskId: 'task-1', quotedMicros: 30 }));
  model.reserve(modelQuote({ attemptId: 'model-task-settled', scope: 'task', taskId: 'task-1', quotedMicros: 20, quoteId: 'quote-settled' }));
  model.settle(settled('model-task-settled', 20));
  transaction.reserve(txQuote({ attemptId: 'tx-task', scope: 'task', taskId: 'task-1', quotedMicros: 40 }));

  const before = model.describe({ taskId: 'task-1', currency: 'USD' });
  assert.equal(before.currencies[0].workspace.usedMicros, 50);
  assert.equal(before.currencies[0].task.usedMicros, 50);
  const taskScoped = model.describe({ scope: 'task', taskId: 'task-1', currency: 'USD' });
  assert.equal(taskScoped.scope, 'task');
  assert.equal(taskScoped.currencies[0].task.taskId, 'task-1');

  const detached = model.detachTask({ taskId: 'task-1' });
  assert.equal(detached.detached, 2);
  assert.deepEqual(detached, { kind: 'model', taskId: 'task-1', detached: 2, updatedAt: '2026-11-12T10:00:00.000Z' });
  assert.equal(model.detachTask({ taskId: 'task-1' }).detached, 0);

  const after = model.describe({ taskId: 'task-1', currency: 'USD' });
  assert.equal(after.currencies[0].workspace.usedMicros, 50, 'workspace occupancy is retained');
  assert.equal(after.currencies[0].task.usedMicros, 0, 'the task association is detached');
  const pending = model.describe({ currency: 'USD' }).pendingReservations;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].taskId, null);
  assert.equal(pending[0].scope, 'workspace');
  assert.equal(model.markDispatched('model-task').state, 'dispatched', 'detaching is not a budget reset or cancellation');

  const txBefore = transaction.describe({ grantId: 'grant-1' }).lease.usedMicros;
  assert.equal(txBefore, 40);
  transaction.detachTask({ taskId: 'task-1' });
  assert.equal(transaction.describe({ grantId: 'grant-1' }).lease.usedMicros, 40, 'lease occupancy is retained');
  assert.equal(transaction.describe({ taskId: 'task-1', currency: 'USD' }).currencies[0].task.usedMicros, 0);
  assert.equal(model.describe({ taskId: 'task-1', currency: 'USD' }).currencies[0].task.usedMicros, 0, 'the other kind keeps its own rows');
});

test('model quotes bind the current pricing profile revision and digest', t => {
  const database = new DurableDatabase(':memory:', { now: () => START });
  t.after(() => database.close());
  const budget = new MoneyBudgetService(database, { kind: 'model' });

  assert.throws(
    () => budget.reserve(modelQuote({ attemptId: 'unregistered' })),
    { code: 'MONEY_PROFILE_MISMATCH', status: 409 }
  );
  budget.configureProfile({ ...PROFILE, currency: 'USD', revision: 2 });
  const revision = rejected(
    () => budget.reserve(modelQuote({ attemptId: 'old-revision' })),
    { code: 'MONEY_PROFILE_MISMATCH' }
  );
  assert.equal(revision.detail.reason, 'revision');
  const digest = rejected(
    () => budget.reserve(modelQuote({ attemptId: 'old-digest', profileSnapshot: { revision: 2, profileDigest: 'd'.repeat(64) } })),
    { code: 'MONEY_PROFILE_MISMATCH' }
  );
  assert.equal(digest.detail.reason, 'digest');

  const accepted = budget.reserve(modelQuote({ attemptId: 'current', profileSnapshot: { revision: 2 } }));
  assert.equal(accepted.profile.revision, 2);
  assert.equal(accepted.profile.version, 1);
  budget.configureProfile({ ...PROFILE, currency: 'USD', revision: 3 });
  assert.throws(() => budget.markDispatched('current'), { code: 'MONEY_BUDGET_STALE' });
});

test('rollback and store errors leave no partial ledger', t => {
  const { database, budget } = modelFixture(t);
  assert.throws(
    () => database.atomic(() => {
      budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 10 });
      budget.reserve(modelQuote({ attemptId: 'rolled-back', quotedMicros: 5 }));
      throw new Error('simulated store failure');
    }),
    /simulated store failure/
  );
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 0);
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.limitConfigured, false);
  assert.equal(budget.describe().pendingReservations.length, 0);

  const filename = tempFile();
  const clock = memoryClock();
  const first = modelFixture(t, { filename, clock });
  first.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  const secondDatabase = new DurableDatabase(filename, { now: () => clock.value, busyTimeoutMs: 100 });
  t.after(() => secondDatabase.close());
  const second = new MoneyBudgetService(secondDatabase, { kind: 'model' });
  first.database.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(
      () => second.configureLimit({ scope: 'workspace', currency: 'USD', micros: 50 }),
      error => /^SQLITE_(BUSY|LOCKED)/.test(error.code)
    );
    assert.throws(
      () => second.reserve(modelQuote({ attemptId: 'busy', quotedMicros: 5 })),
      error => /^SQLITE_(BUSY|LOCKED)/.test(error.code)
    );
  } finally {
    first.database.db.exec('ROLLBACK');
  }
  assert.equal(second.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 0);
  assert.equal(second.describe({ currency: 'USD' }).currencies[0].workspace.limit, 100);
});

test('terminal state conflicts and schema constraints stay permanent and fail closed', t => {
  const { database, budget } = modelFixture(t);
  budget.reserve(modelQuote({ attemptId: 'state', quotedMicros: 10 }));
  budget.markUnknown('state');
  const cancelUnknown = rejected(() => budget.cancelBeforeDispatch('state'), { code: 'MONEY_BUDGET_CONFLICT', status: 409 });
  assert.equal(cancelUnknown.reason, 'state');
  assert.equal(cancelUnknown.detail.state, 'unknown');

  budget.settle(settled('state', 10));
  const unknownSettled = rejected(() => budget.markUnknown('state'), { code: 'MONEY_BUDGET_CONFLICT' });
  assert.equal(unknownSettled.reason, 'state');
  assert.equal(unknownSettled.detail.state, 'settled');
  const cancelSettled = rejected(() => budget.cancelBeforeDispatch('state'), { code: 'MONEY_BUDGET_CONFLICT' });
  assert.equal(cancelSettled.reason, 'state');
  const changedEvidence = rejected(() => budget.settle(settled('state', 11)), { code: 'MONEY_BUDGET_CONFLICT' });
  assert.equal(changedEvidence.reason, 'settlement_conflict');

  const rawInsert = database.db.prepare(`INSERT INTO money_budget_reservations
    (attempt_id,kind,scope,task_id,currency,state,day,quoted_micros,actual_micros,overrun_micros,receipt_ref,
     quote_id,quote_digest,quote_expires_at,profile_provider_id,profile_model,profile_protocol,profile_digest,
     profile_revision,profile_version,grant_id,grant_version,workspace_limit_version,task_limit_version,
     created_at,updated_at,dispatched_at,settled_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const settledWithoutReceipt = [
    'raw-settled', 'model', 'workspace', null, 'USD', 'settled', '2026-11-12', 10, 10, 0, null,
    'quote-raw', 'digest-raw', '2026-11-12T10:30:00.000Z',
    'provider-a', 'model-a', 'messages', 'a'.repeat(64), 1, 1, null, 0, 0, 0,
    '2026-11-12T10:00:00.000Z', '2026-11-12T10:00:00.000Z', null, '2026-11-12T10:00:00.000Z'
  ];
  assert.throws(
    () => rawInsert.run(...settledWithoutReceipt),
    error => /^SQLITE_CONSTRAINT/.test(error.code),
    'a settled row without a receipt is rejected by the schema'
  );
  assert.equal(budget.describe().pendingReservations.length, 0, 'the rejected raw row did not persist');
  assert.equal(budget.describe({ currency: 'USD' }).currencies[0].workspace.usedMicros, 10);
});

test('two real processes cannot double-spend the last reservation', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-money-budget-race-'));
  roots.push(directory);
  const worker = writeRaceWorker(directory);

  for (let iteration = 0; iteration < 3; iteration++) {
    const filename = path.join(directory, `race-${iteration}.db`);
    const now = START;
    setupRaceDatabase(filename, now);
    const results = await runRace(directory, worker, filename, now, `attempt-${iteration}`, `attempt-${iteration}-other`);
    assert.equal(results.filter(result => result.ok).length, 1, `iteration ${iteration}: ${JSON.stringify(results)}`);
    const loser = results.find(result => !result.ok);
    assert.ok(
      loser.code === 'MONEY_BUDGET_EXHAUSTED' || /^SQLITE_BUSY/.test(loser.code),
      `iteration ${iteration}: unexpected loser code ${loser.code}`
    );
    verifyRaceDatabase(filename, now, 1);
  }

  for (let iteration = 0; iteration < 2; iteration++) {
    const filename = path.join(directory, `same-${iteration}.db`);
    const now = START;
    setupRaceDatabase(filename, now);
    const results = await runRace(directory, worker, filename, now, 'same-attempt', 'same-attempt');
    assert.ok(results.some(result => result.ok), `same attempt iteration ${iteration}: ${JSON.stringify(results)}`);
    for (const result of results) {
      if (!result.ok) assert.match(result.code, /^SQLITE_BUSY/);
    }
    verifyRaceDatabase(filename, now, 1);
  }
});

const DATABASE_URL = new URL('../src/durable/database.js', import.meta.url).href;
const MONEY_BUDGET_URL = new URL('../src/durable/money-budget.js', import.meta.url).href;

function writeRaceWorker(directory) {
  const filename = path.join(directory, 'race-worker.mjs');
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import { DurableDatabase } from ${JSON.stringify(DATABASE_URL)};
import { MoneyBudgetService } from ${JSON.stringify(MONEY_BUDGET_URL)};

const [databasePath, goPath, readyPath, attemptId, now] = process.argv.slice(2);
const database = new DurableDatabase(databasePath, { now: () => Number(now) });
const budget = new MoneyBudgetService(database, { kind: 'model' });
fs.writeFileSync(readyPath, 'ready');
while (!fs.existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, 2));
let result;
try {
  const reservation = budget.reserve({
    attemptId,
    scope: 'workspace',
    currency: 'USD',
    quotedMicros: 60,
    quoteId: 'race-quote',
    quoteDigest: 'race-digest',
    quoteExpiresAt: '2026-11-12T10:30:00.000Z',
    profileSnapshot: {
      providerId: 'provider-a',
      model: 'model-a',
      protocol: 'messages',
      profileDigest: '${'a'.repeat(64)}',
      revision: 1
    }
  });
  result = { ok: true, attemptId: reservation.attemptId, state: reservation.state };
} catch (error) {
  result = { ok: false, code: error.code ?? error.name, message: error.message };
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

async function runRace(directory, worker, databasePath, now, firstAttempt, secondAttempt) {
  const go = path.join(directory, 'go');
  const readyFirst = path.join(directory, 'ready-first');
  const readySecond = path.join(directory, 'ready-second');
  const spawnWorker = (attemptId, readyPath) => spawn(
    process.execPath,
    ['--max-old-space-size=512', worker, databasePath, go, readyPath, attemptId, String(now)],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const first = spawnWorker(firstAttempt, readyFirst);
  const second = spawnWorker(secondAttempt, readySecond);
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

function setupRaceDatabase(filename, now) {
  const database = new DurableDatabase(filename, { now: () => now });
  const budget = new MoneyBudgetService(database, { kind: 'model' });
  budget.configureProfile({
    providerId: 'provider-a',
    model: 'model-a',
    protocol: 'messages',
    currency: 'USD',
    profileDigest: 'a'.repeat(64),
    revision: 1
  });
  budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100 });
  database.close();
}

function verifyRaceDatabase(filename, now, attempts) {
  const database = new DurableDatabase(filename, { now: () => now });
  const budget = new MoneyBudgetService(database, { kind: 'model' });
  const described = budget.describe({ currency: 'USD' });
  database.close();
  assert.equal(described.currencies[0].workspace.usedMicros, 60);
  assert.equal(described.currencies[0].workspace.reservedMicros, 60);
  assert.equal(described.pendingReservations.length, attempts);
}
