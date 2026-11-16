import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { ModelMoneyService } from '../src/durable/model-money.js';
import { TokenRequestAccounting } from '../src/token-accounting.js';
const profile = { providerId: 'connection-one', protocol: 'chat-completions', model: 'test-model', currency: 'USD', revision: 1,
  rates: { input: 1000000, output: 2000000, cacheRead: 3000000, cacheWrite: 4000000 } };
function fixture(t, { price = true, limit = 100000 } = {}) {
  const clock = { now: Date.parse('2026-11-14T05:00:00Z') };
  const database = new DurableDatabase(':memory:', { now: () => clock.now }); t.after(() => database.close());
  const token = new TokenBudgetService(database), money = new ModelMoneyService(database, { providerId: profile.providerId });
  if (price) money.configureProfile(profile);
  if (limit !== null) money.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: limit });
  const accounting = new TokenRequestAccounting(token, { money });
  const prepare = () => accounting.prepare({ protocol: profile.protocol, scope: 'workspace', payload: { model: profile.model, messages: [{ role: 'user', content: 'hello' }] } });
  const rows = attempt => ({ token: database.db.prepare('SELECT state FROM token_budget_reservations WHERE attempt_id=?').get(attempt.attemptId)?.state,
    money: database.db.prepare('SELECT state,actual_micros FROM money_budget_reservations WHERE attempt_id=?').get(attempt.attemptId) });
  return { database, token, money, accounting, prepare, rows, clock };
}
const usage = { protocol: profile.protocol, body: { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } } };
test('actual seam reserves, dispatches and settles both ledgers with cache pricing', t => {
  const f = fixture(t), p = f.prepare(); assert.equal(p.payload.max_tokens, 2048);
  assert.equal(f.rows(p.attempt).token, 'reserved'); assert.equal(f.rows(p.attempt).money.state, 'reserved');
  f.accounting.markDispatched(p.attempt); const settled = f.accounting.settleResponse(p.attempt, usage);
  assert.equal(settled.state, 'settled'); assert.equal(f.rows(p.attempt).money.actual_micros, 20);
  assert.equal(f.accounting.settleResponse(p.attempt, usage), settled); assert.throws(() => f.accounting.markDispatched(p.attempt));
});
test('missing prices fail closed without a token reservation', t => {
  const f = fixture(t, { price: false }); assert.throws(f.prepare, { code: 'MONEY_PROFILE_REQUIRED' });
  assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 0);
});
test('exhausted money rolls token reservation back', t => {
  const f = fixture(t, { limit: 0 }); assert.throws(f.prepare, { code: 'MONEY_BUDGET_EXHAUSTED' });
  assert.equal(f.database.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 0);
});
test('price replacement and quote expiry refuse dispatch and remain cancellable', t => {
  const f = fixture(t), p = f.prepare(); f.money.configureProfile({ ...profile, revision: 2 }, { expectedVersion: 1 });
  assert.throws(() => f.accounting.markDispatched(p.attempt), { code: 'MONEY_ACCOUNTING_STALE' }); f.accounting.fail(p.attempt);
  assert.equal(f.rows(p.attempt).money.state, 'cancelled'); const next = f.prepare(); f.clock.now += 60001;
  assert.throws(() => f.accounting.markDispatched(next.attempt)); assert.equal(f.rows(next.attempt).token, 'reserved');
  f.accounting.fail(next.attempt); assert.equal(f.rows(next.attempt).money.state, 'cancelled');
});
test('missing usage and post-dispatch failure preserve both unknown holds', t => {
  const f = fixture(t); for (const settle of [true, false]) {
    const p = f.prepare(); f.accounting.markDispatched(p.attempt);
    if (settle) f.accounting.settleResponse(p.attempt, { protocol: profile.protocol, body: {} }); else f.accounting.fail(p.attempt);
    assert.equal(f.rows(p.attempt).token, 'unknown'); assert.equal(f.rows(p.attempt).money.state, 'unknown');
  }
});
test('complete zero is known free', t => {
  const f = fixture(t), p = f.prepare(); f.accounting.markDispatched(p.attempt);
  f.accounting.settleResponse(p.attempt, { protocol: profile.protocol, body: { usage: { prompt_tokens: 0, completion_tokens: 0 } } });
  assert.equal(f.rows(p.attempt).money.state, 'settled'); assert.equal(f.rows(p.attempt).money.actual_micros, 0);
});
test('failed commit restores opaque permit after dispatch and settlement mutations', t => {
  const f = fixture(t), p = f.prepare(), original = f.database.atomic.bind(f.database);
  const fault = operation => { let outer = true; f.database.atomic = fn => {
    if (!outer) return original(fn); outer = false;
    try { return original(() => { fn(); throw new Error('injected commit failure'); }); } finally { outer = true; }
  }; assert.throws(operation, /injected commit failure/); f.database.atomic = original; };
  fault(() => f.accounting.markDispatched(p.attempt)); assert.equal(f.rows(p.attempt).token, 'reserved'); assert.equal(f.rows(p.attempt).money.state, 'reserved');
  f.accounting.markDispatched(p.attempt); fault(() => f.accounting.settleResponse(p.attempt, usage));
  assert.equal(f.rows(p.attempt).token, 'dispatched'); assert.equal(f.rows(p.attempt).money.state, 'dispatched');
  f.accounting.settleResponse(p.attempt, usage); assert.equal(f.rows(p.attempt).money.state, 'settled');
});
test('foreign DB and caller-owned transaction are rejected', t => {
  const a = fixture(t), b = fixture(t); assert.throws(() => new TokenRequestAccounting(a.token, { money: b.money }));
  assert.throws(() => a.database.atomic(() => a.prepare()), { code: 'TOKEN_ACCOUNTING_CONFLICT' });
});
test('profile persistence and optimistic concurrency', t => {
  const f = fixture(t), reloaded = new ModelMoneyService(f.database, { providerId: profile.providerId });
  assert.deepEqual(reloaded.snapshot({ model: profile.model, protocol: profile.protocol }).profile.rates, profile.rates);
  assert.throws(() => reloaded.configureProfile({ ...profile, revision: 2 }), { code: 'MONEY_BUDGET_CONFLICT' });
});
test('enabling money after unpriced prepare invalidates old permit', t => {
  const f = fixture(t, { price: false, limit: null }), p = f.prepare();
  f.money.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100000 });
  assert.throws(() => f.accounting.markDispatched(p.attempt), { code: 'MONEY_PROFILE_REQUIRED' }); f.accounting.fail(p.attempt);
  assert.equal(f.rows(p.attempt).token, 'cancelled');
});

test('overflow rolls partial settlement back before retaining both unknown holds', t => {
  const f = fixture(t), p = f.prepare(); f.accounting.markDispatched(p.attempt);
  const huge = { protocol: profile.protocol, body: { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 } } };
  assert.throws(() => f.accounting.settleResponse(p.attempt, huge));
  assert.equal(f.rows(p.attempt).token, 'unknown'); assert.equal(f.rows(p.attempt).money.state, 'unknown');
  assert.throws(() => f.accounting.settleResponse(p.attempt, huge));
});
test('one-sided externally marked dispatch cannot release the other hold during fail', t => {
  const f = fixture(t), p = f.prepare(); f.token.markDispatched(p.attempt.attemptId);
  f.accounting.fail(p.attempt);
  assert.equal(f.rows(p.attempt).token, 'unknown'); assert.equal(f.rows(p.attempt).money.state, 'unknown');
});
test('currency mismatch and stale money limit refuse new dispatch', t => {
  const f = fixture(t), p = f.prepare();
  f.money.budget.configureLimit({ scope: 'workspace', currency: 'EUR', micros: 100000 });
  assert.throws(() => f.accounting.markDispatched(p.attempt), { code: 'MONEY_PROFILE_REQUIRED' });
  f.accounting.fail(p.attempt); assert.equal(f.rows(p.attempt).money.state, 'cancelled');
});
test('real requestModelJson boundary enforces the money limit before fake network and records usage', async t => {
  const { requestModelJson } = await import('../src/model-request.js');
  const f = fixture(t); let fetches = 0;
  const request = () => requestModelJson({ accounting: f.accounting, context: { scope: 'workspace' }, protocol: profile.protocol,
    payload: { model: profile.model, messages: [{ role: 'user', content: 'hello' }] }, url: 'https://example.invalid', maxResponseChars: 10000,
    fetchImpl: async (_, options) => { fetches++; assert.equal(JSON.parse(options.body).max_tokens, 2048); return new Response(JSON.stringify({ ...usage.body, choices: [] })); } });
  await request(); assert.equal(fetches, 1);
  assert.equal(f.database.db.prepare("SELECT actual_micros FROM money_budget_reservations WHERE state='settled'").get().actual_micros, 20);
  f.money.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 0 });
  await assert.rejects(request(), { code: 'MONEY_BUDGET_EXHAUSTED' }); assert.equal(fetches, 1);
});
test('both non-chat wire protocols enforce output cap and settle trusted usage', t => {
  for (const protocol of ['responses', 'messages']) {
    const f = fixture(t, { price: false }); f.money.configureProfile({ ...profile, protocol });
    const p = f.accounting.prepare({ protocol, scope: 'workspace', payload: { model: profile.model,
      ...(protocol === 'responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }) } });
    assert.equal(p.payload[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens'], 2048);
    f.accounting.markDispatched(p.attempt);
    const counts = protocol === 'responses' ? { input_tokens: 10, output_tokens: 2 } : { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    f.accounting.settleResponse(p.attempt, { protocol, body: { usage: counts } });
    assert.equal(f.rows(p.attempt).money.actual_micros, 14);
  }
});

test('price snapshot and conservative dispatched holds survive an actual database reopen', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-model-money-')); const file = path.join(root, 'state.sqlite');
  let database = new DurableDatabase(file);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let money = new ModelMoneyService(database, { providerId: profile.providerId }); money.configureProfile(profile);
  let accounting = new TokenRequestAccounting(new TokenBudgetService(database), { money });
  const p = accounting.prepare({ protocol: profile.protocol, scope: 'workspace', payload: { model: profile.model, messages: [{ role: 'user', content: 'hello' }] } });
  accounting.markDispatched(p.attempt); database.close(); database = new DurableDatabase(file);
  money = new ModelMoneyService(database, { providerId: profile.providerId });
  assert.equal(money.snapshot({ model: profile.model, protocol: profile.protocol }).profile.digest.length, 64);
  assert.equal(database.db.prepare('SELECT state FROM money_budget_reservations WHERE attempt_id=?').get(p.attempt.attemptId).state, 'dispatched');
  assert.equal(database.db.prepare('SELECT state FROM token_budget_reservations WHERE attempt_id=?').get(p.attempt.attemptId).state, 'dispatched');
  const otherConnection = new ModelMoneyService(database, { providerId: 'connection-two' });
  otherConnection.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100000 });
  assert.throws(() => otherConnection.snapshot({ model: profile.model, protocol: profile.protocol }), { code: 'MONEY_PROFILE_REQUIRED' });
  assert.throws(() => otherConnection.configureProfile(profile), { code: 'MONEY_PROFILE_REQUIRED' });
});

test('idempotent core money marker is never accepted as another dispatch permit', t => {
  const f = fixture(t), p = f.prepare(); f.money.budget.markDispatched(p.attempt.attemptId);
  assert.throws(() => f.accounting.markDispatched(p.attempt), { code: 'MONEY_ACCOUNTING_CONFLICT' });
  assert.equal(f.rows(p.attempt).token, 'reserved');
  f.accounting.fail(p.attempt);
  assert.equal(f.rows(p.attempt).token, 'unknown'); assert.equal(f.rows(p.attempt).money.state, 'unknown');
});
