import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { bindReasonerTokenBudget, forkReasonerConfiguration } from '../src/reasoner-scope.js';
import { modelProviderIdentity } from '../src/durable/model-money.js';
import { validateModelSettings } from '../src/model-setup.js';
import { piSupported } from '../src/pi-runtime.js';
const settings = { baseUrl: 'https://example.test/v1', model: 'money-native', protocol: 'chat-completions', apiKey: 'synthetic-private-credential' };
const profile = (id, model = settings.model) => ({ providerId: id, model, protocol: settings.protocol, currency: 'USD', revision: 1,
  rates: { input: 1000000, output: 2000000, cacheRead: 1000000, cacheWrite: 1000000 } });
function fixture(t) {
  const db = new DurableDatabase(':memory:'); t.after(() => db.close()); const budget = new TokenBudgetService(db); let fetches = 0;
  const reasoner = new OpenAiCompatibleReasoner({ ...settings, limits: { maxCallsPerMinute: 100 }, fetchImpl: async () => {
    fetches++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"deliverable":"report","subjectEntity":"Lobby","requiredContent":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
  } });
  bindReasonerTokenBudget(reasoner, budget);
  return { db, budget, reasoner, calls: () => fetches };
}
let nextCall = 0;
const call = reasoner => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, `native-money:${++nextCall}`, { scope: 'workspace' });
test('native binding accounts real classic calls and rejects exhausted money before fetch', async t => {
  const f = fixture(t), money = f.reasoner.modelMoney; money.configureProfile(profile(money.providerId));
  money.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100000 });
  await call(f.reasoner); assert.equal(f.calls(), 1);
  assert.equal(f.db.db.prepare('SELECT actual_micros FROM money_budget_reservations').get().actual_micros, 14);
  money.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 0 });
  await assert.rejects(call(f.reasoner), { code: 'MONEY_BUDGET_EXHAUSTED' }); assert.equal(f.calls(), 1);
});
test('repeat native binding preserves live opaque permits', t => {
  const f = fixture(t), adapter = f.reasoner.accounting;
  const p = adapter.prepare({ protocol: settings.protocol, scope: 'workspace', payload: { model: settings.model, messages: [{ role: 'user', content: 'hello' }] } });
  bindReasonerTokenBudget(f.reasoner, f.budget); assert.equal(f.reasoner.accounting, adapter);
  f.reasoner.accounting.markDispatched(p.attempt); f.reasoner.accounting.fail(p.attempt);
});
test('identity is stable per trusted connection, private, and isolated by workspace and credential', t => {
  const f = fixture(t), other = fixture(t), identity = f.reasoner.modelMoney.providerId;
  assert.equal(modelProviderIdentity(f.db, settings), identity);
  assert.notEqual(modelProviderIdentity(f.db, { ...settings, apiKey: 'another-key' }), identity);
  assert.notEqual(other.reasoner.modelMoney.providerId, identity);
  const rows = JSON.stringify(f.db.db.prepare('SELECT * FROM model_provider_identities').all());
  assert.equal(rows.includes(settings.apiKey), false); assert.equal(rows.includes(settings.baseUrl), false);
});
test('credential change cannot reuse confirmed prices or reset workspace money policy', async t => {
  const f = fixture(t), original = f.reasoner.modelMoney;
  original.configureProfile(profile(original.providerId)); original.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100000 });
  const replacement = forkReasonerConfiguration(f.reasoner); replacement.apiKey = 'another-key';
  bindReasonerTokenBudget(replacement, f.budget);
  await assert.rejects(call(replacement), { code: 'MONEY_PROFILE_REQUIRED' }); assert.equal(f.calls(), 0);
});
test('foreign ledger refusal does not mutate active native adapter', t => {
  const a = fixture(t), b = fixture(t), before = a.reasoner.accounting;
  const count = b.db.db.prepare('SELECT COUNT(*) n FROM model_provider_identities').get().n;
  assert.throws(() => bindReasonerTokenBudget(a.reasoner, b.budget), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  assert.equal(a.reasoner.accounting, before); assert.equal(b.db.db.prepare('SELECT COUNT(*) n FROM model_provider_identities').get().n, count);
});
test('synthetic setup validation cannot bypass a configured money limit on a new connection', async t => {
  const f = fixture(t); f.reasoner.modelMoney.budget.configureLimit({ scope: 'workspace', currency: 'USD', micros: 100000 });
  await assert.rejects(validateModelSettings({ ...settings, apiKey: 'new-config-key' }, { tokenBudget: f.budget, fetchImpl: f.reasoner.fetchImpl }), { code: 'MONEY_PROFILE_REQUIRED' });
  assert.equal(f.calls(), 0);
});
test('Pi refuses configured money accounting before SDK execution', { skip: !piSupported() }, async t => {
  const f = fixture(t); let sdk = 0;
  const reasoner = new PiReasoner({ ...settings, runtimeOptions: { loadSdk: async () => { sdk++; throw new Error('must not load'); } } });
  bindReasonerTokenBudget(reasoner, f.budget); reasoner.modelMoney.configureProfile(profile(reasoner.modelMoney.providerId));
  await assert.rejects(call(reasoner), { code: 'MONEY_BUDGET_UNSUPPORTED_HARNESS' }); assert.equal(sdk, 0);
});

async function runtimeFixture(t) {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { SqliteStore } = await import('../src/durable/store.js'); const { WorkEngine } = await import('../src/engine.js');
  const { DurableRuntime } = await import('../src/durable/runtime.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-money-runtime-')); const store = new SqliteStore(path.join(root, 'state.json')); let fetches = 0;
  const reasoner = new OpenAiCompatibleReasoner({ ...settings, limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_, options) => {
    fetches++; const wire = JSON.parse(options.body); const probe = wire.messages?.[0]?.content?.startsWith('You propose evidence probes');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(probe ? { probes: [] } : {
      deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results', sourceField: 'body' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) };
  } });
  reasoner.preferModelInterpretation = true; const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, reasoner, engine, runtime, calls: () => fetches,
    idle: async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); } };
}
for (const missingPrice of [true, false]) test(`native durable work resumes same parked job after ${missingPrice ? 'confirmed price' : 'money limit increase'}`, async t => {
  const f = await runtimeFixture(t), money = f.reasoner.modelMoney;
  if (!missingPrice) money.configureProfile(profile(money.providerId));
  money.configureLimit({ scope: 'workspace', currency: 'USD', micros: missingPrice ? 1000000 : 0 });
  f.engine.ingest({ id: 'event:money-one', type: 'email.received', payload: { id: 'money-one', threadId: 'money-thread', from: 'person@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar proposal with experiment results.' } });
  await f.idle(); assert.equal(f.calls(), 0);
  const taskId = 'request:money-one', job = f.store.jobs.list({ taskId }).find(j => j.last_error_class === 'budget');
  assert.ok(job); assert.equal(job.state, 'retry_wait'); assert.equal(f.store.state.tasks[taskId].reasoningWork.status, 'budget_deferred');
  const metadata = JSON.parse(job.budget_metadata_json); assert.equal(metadata.kind, 'model');
  assert.equal(metadata.reason, missingPrice ? 'configuration_required' : 'exhausted');
  if (missingPrice) money.configureProfile(profile(money.providerId));
  else money.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000000 });
  f.runtime.kick(); await f.idle(); assert.ok(f.calls() > 0); assert.equal(f.store.jobs.get(job.id).state, 'completed');
  assert.equal(f.store.state.tasks[taskId].modelReview.status, 'verified');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM money_budget_reservations WHERE state='settled'").get().n, f.calls());
});
