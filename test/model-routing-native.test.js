import { validateModelSettings } from '../src/model-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableReasoningSessions } from '../src/durable/reasoning-sessions.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { ModelCommits } from '../src/durable/model-commits.js';
import { ModelRoutingService, applyModelRequestLimit } from '../src/durable/model-routing.js';
import { OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { piSupported } from '../src/pi-runtime.js';
import { bindReasonerTokenBudget } from '../src/reasoner-scope.js';
import { brandModelStage, directModelRoutingContext, requireAccountingContext, requireSessionAccountingContext } from '../src/model-request.js';

const group = { modelIds: ['base','cheap','strong'], defaultModel: 'base', stages: { interpret: 'cheap', discovery: 'cheap', planning: 'strong', verification: 'strong' }, fallbackModel: 'strong' };
const input = { subject: 'Lobby report', body: 'Please update the Lobby report.' };
const final = { deliverable: 'report', subjectEntity: 'Lobby', requiredContent: [], nextStep: 'Review the evidence.' };
const response = (status = 200, message = { content: JSON.stringify(final) }, usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => ({ choices: [{ message }], ...(usage ? { usage } : {}) }) });
function fixture(t, { respond = () => response(), attempts = 1, cap = 1, routingGroup = group } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-route-')), store = new SqliteStore(path.join(dir, 'state.json'));
  const sessions = new DurableReasoningSessions(store.database), tokens = new TokenBudgetService(store.database), commits = new ModelCommits(store, sessions), wire = [], usage = [];
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'base', tokenBudget: tokens, reasoningSessions: sessions,
    onUsage: value => usage.push(value), limits: { maxCallsPerMinute: 100, maxCallsPerRequest: cap, maxConcurrent: 1 }, fetchImpl: async (url, init) => { const payload = JSON.parse(init.body); wire.push({ url, payload, headers: init.headers }); return respond(payload, wire.length); } });
  bindReasonerTokenBudget(reasoner, tokens);
  const policy = reasoner.modelRouting.configure({ expectedVersion: 0, config: routingGroup, maxRpcAttempts: attempts, requestCallLimit: Math.max(cap, attempts) }); applyModelRequestLimit(reasoner, policy);
  const queued = store.jobs.enqueue({ type: 'discovery', key: 'route-owner', payload: {} }), job = store.jobs.claim('route-worker', { id: queued.id }); let sequence = 0;
  const context = (stage = 'interpret', key = stage) => commits.context({ scope: 'workspace', key, stage, owner: { kind: 'job', job },
    bindings: { authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1 }, isCurrent: () => store.jobs.owns(job) });
  const call = ctx => reasoner.interpretRequest(input, `route:${++sequence}`, ctx);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, sessions, tokens, commits, reasoner, wire, usage, context, call, policy };
}

test('native private semantic stages choose actual wire models without changing declared model', async t => {
  const f = fixture(t);
  for (const [stage, model] of [['interpret','cheap'],['discovery','cheap'],['planning','strong'],['verification','strong'],['general','base']]) {
    const ctx = f.context(stage); await f.call(ctx); assert.equal(f.wire.at(-1).payload.model, model); f.commits.commitSql(ctx, () => {});
  }
  assert.equal(f.reasoner.model, 'base'); assert.equal(f.tokens.describe().workspace.settled, 75);
  assert.equal(f.wire.every(w => w.url === f.wire[0].url), true);
});
test('stage branding survives scope/session normalization and ignores a JSON stage field', async t => {
  const f = fixture(t);
  const ctx = requireSessionAccountingContext(requireAccountingContext(brandModelStage(Object.freeze({ scope: 'workspace' }), 'planning')));
  await f.call(ctx); assert.equal(f.wire.at(-1).payload.model, 'strong');
  await f.call({ scope: 'workspace', stage: 'planning', model: 'strong' }); assert.equal(f.wire.at(-1).payload.model, 'base');
  await f.call(directModelRoutingContext({ scope: 'workspace' })); assert.equal(f.wire.at(-1).payload.model, 'base');
});
test('one native transient fallback obtains fresh Token and money attempts for actual models', async t => {
  const f = fixture(t, { attempts: 2, cap: 2, respond: (_, n) => response(n === 1 ? 503 : 200) }), money = f.reasoner.modelMoney;
  for (const [model, rate] of [['cheap',1000000],['strong',2000000]]) money.configureProfile({ providerId: money.providerId, protocol: 'chat-completions', model, currency: 'USD', revision: 1, rates: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate } });
  money.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000000 });
  const ctx = f.context(); await f.call(ctx); f.commits.commitSql(ctx, () => {});
  assert.deepEqual(f.wire.map(w => w.payload.model), ['cheap','strong']); assert.equal(f.reasoner.model, 'base'); assert.equal(f.tokens.describe().workspace.settled, 30);
  const fees = f.store.db.prepare('SELECT profile_model,state,actual_micros FROM money_budget_reservations ORDER BY rowid').all();
  assert.deepEqual(fees.map(r => [r.profile_model,r.state,r.actual_micros]), [['cheap','settled',15],['strong','settled',30]]);
  assert.deepEqual(f.usage.map(row => [row.model,row.input,row.output]), [['cheap',10,5],['strong',10,5]]);
});
for (const status of [401,403]) test(`provider ${status} never chooses a fallback`, async t => {
  const f = fixture(t, { attempts: 2, cap: 2, respond: () => response(status) }); await assert.rejects(f.call(f.context()), { status }); assert.equal(f.wire.length, 1);
});
test('local budget refusal never dispatches a primary or fallback', async t => {
  const f = fixture(t, { attempts: 2, cap: 2 }); f.tokens.setLimit({ scope: 'workspace', tokens: 0 });
  await assert.rejects(f.call(f.context()), { code: 'TOKEN_BUDGET_EXHAUSTED' }); assert.equal(f.wire.length, 0);
});
test('unknown write result never becomes a fallback', async t => {
  const f = fixture(t, { attempts: 2, cap: 2, respond: () => { throw Object.assign(new Error('uncertain'), { status: 503, writeOutcomeUnknown: true }); } });
  await assert.rejects(f.call(f.context()), { writeOutcomeUnknown: true }); assert.equal(f.wire.length, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM token_budget_reservations').get().state, 'unknown');
});
test('fallback price wait resumes directly on fallback without repeating the paid primary', async t => {
  const f = fixture(t, { attempts: 2, cap: 2, respond: payload => response(payload.model === 'cheap' ? 503 : 200) }), money = f.reasoner.modelMoney;
  const price = model => ({ providerId: money.providerId, protocol: 'chat-completions', model, currency: 'USD', revision: 1, rates: { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 } });
  money.configureProfile(price('cheap')); money.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000000 });
  await assert.rejects(f.call(f.context()), { code: 'MONEY_PROFILE_REQUIRED' }); assert.deepEqual(f.wire.map(w => w.payload.model), ['cheap']);
  money.configureProfile(price('strong')); const resumed = f.context(); await f.call(resumed); f.commits.commitSql(resumed, () => {});
  assert.deepEqual(f.wire.map(w => w.payload.model), ['cheap','strong']);
});
test('refused fallback acquisition does not release another request\'s rate slot', async t => {
  let other;
  const f = fixture(t, { attempts: 2, cap: 2, respond: () => { other = f.reasoner.budget.acquire('other-request'); return response(503); } });
  f.reasoner.budget.limits.maxCallsPerRequest = 1;
  await assert.rejects(f.call(f.context()), { code: 'REASONING_BUDGET', status: 429 }); await other;
  assert.equal(f.wire.length, 1); assert.equal(f.reasoner.budget.inFlight, 1); f.reasoner.budget.release('other-request'); assert.equal(f.reasoner.budget.inFlight, 0);
});
test('routing revision changes private plan identity and refuses the queued old route before reservations', async t => {
  const f = fixture(t), old = f.context();
  const next = f.reasoner.modelRouting.configure({ expectedVersion: f.policy.version, config: { ...group, stages: { interpret: 'strong' } }, maxRpcAttempts: 1, requestCallLimit: 1 }); applyModelRequestLimit(f.reasoner, next);
  await assert.rejects(f.call(old)); assert.equal(f.wire.length, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 0);
  const current = f.context(); await f.call(current); assert.equal(f.wire[0].payload.model, 'strong'); assert.notEqual(current.session.logicalKey, old.session.logicalKey);
});
test('policy disable restores original classic cap without resetting live budget counters', t => {
  const f = fixture(t, { attempts: 2, cap: 1 }); assert.equal(f.reasoner.budget.limits.maxCallsPerRequest, 2);
  const off = f.reasoner.modelRouting.configure({ expectedVersion: f.policy.version, config: null, maxRpcAttempts: 1, requestCallLimit: 1 }); applyModelRequestLimit(f.reasoner, off);
  assert.equal(f.reasoner.budget.limits.maxCallsPerRequest, 1); assert.throws(() => f.reasoner.modelRouting.configure({ expectedVersion: 0, config: group }), { code: 'MODEL_ROUTING_CHANGED' });
});
test('saved group and cap survive a new service and unchanged saves do not invalidate active plans', t => {
  const f = fixture(t, { attempts: 2, cap: 2 }), service = new ModelRoutingService(f.store.database); assert.equal(service.get().requestCallLimit, 2);
  const before = service.get(), after = service.configure({ expectedVersion: before.version, config: group, requestCallLimit: 2, maxRpcAttempts: 2 }); assert.equal(after.version, before.version);
});
const readMessage = id => ({ content: null, tool_calls: [{ id, type: 'function', function: { name: 'lookup', arguments: '{}' } }] });
test('native fallback remains sticky through tools and total four-RPC window requests final early', async t => {
  let reads = 0;
  const f = fixture(t, { attempts: 2, cap: 2, routingGroup: { ...group, stages: { planning: 'cheap' } }, respond: (payload, n) => {
    if (n === 1) return response(503);
    if (n < 4) return response(200, readMessage(`read-${n}`));
    assert.equal(payload.tools, undefined, 'fallback primary consumed one extra RPC slot; fourth request is final-only');
    return response();
  } });
  const context = f.context('planning'), tool = { name: 'lookup', effect: 'read', description: 'Read the supplied fixture', parameters: { type: 'object', properties: {} }, execute: async () => { reads++; return { content: [{ type: 'text', text: 'Fixture evidence.' }] }; } };
  const result = await f.reasoner.investigateTask({ task: { subject: 'Lobby report', request: { text: input.body } }, externalTools: [tool] }, 'native-tool-route', context);
  assert.equal(result, final.nextStep); assert.deepEqual(f.wire.map(w => w.payload.model), ['cheap','strong','strong','strong']); assert.equal(reads, 2);
  assert.equal(f.tokens.describe().workspace.settled, 60); f.commits.commitSql(context, () => {}); assert.equal(f.reasoner.budget.inFlight, 0);
});
test('a provider failure after a real read tool never causes a model fallback', async t => {
  let reads = 0;
  const f = fixture(t, { attempts: 2, cap: 2, routingGroup: { ...group, stages: { planning: 'cheap' } }, respond: (_, n) => n === 1 ? response(200, readMessage('first-read')) : response(503) });
  const context = f.context('planning'), tool = { name: 'lookup', effect: 'read', description: 'Read fixture evidence', parameters: { type: 'object', properties: {} }, execute: async () => { reads++; return { content: [{ type: 'text', text: 'Evidence.' }] }; } };
  await assert.rejects(f.reasoner.investigateTask({ task: { subject: 'Lobby report', request: { text: input.body } }, externalTools: [tool] }, 'native-tool-no-fallback', context), { status: 503 });
  assert.equal(reads, 1); assert.deepEqual(f.wire.map(w => w.payload.model), ['cheap','cheap']); assert.equal(f.reasoner.budget.inFlight, 0);
});
test('fallback retains unknown primary Token and fee holds rather than treating missing usage as free', async t => {
  const f = fixture(t, { attempts: 2, cap: 2, respond: (_, n) => response(n === 1 ? 503 : 200, { content: JSON.stringify(final) }, n === 1 ? null : { prompt_tokens: 10, completion_tokens: 5 }) }), money = f.reasoner.modelMoney;
  for (const model of ['cheap','strong']) money.configureProfile({ providerId: money.providerId, protocol: 'chat-completions', model, currency: 'USD', revision: 1, rates: { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 } });
  money.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000000 });
  const context = f.context(); await f.call(context); f.commits.commitSql(context, () => {});
  assert.deepEqual(f.store.db.prepare('SELECT state FROM token_budget_reservations ORDER BY rowid').all().map(row => row.state), ['unknown','settled']);
  assert.deepEqual(f.store.db.prepare('SELECT state FROM money_budget_reservations ORDER BY rowid').all().map(row => row.state), ['unknown','settled']);
});

test('persisted native stage/model observations match primary/fallback RPCs and local durations', async t => {
  let clock = 0;
  const f = fixture(t, { attempts: 2, cap: 2, respond: (_, n) => { clock += n === 1 ? 12 : 31; return response(n === 1 ? 503 : 200, { content: JSON.stringify(final) }, n === 1 ? null : { prompt_tokens: 10, completion_tokens: 5 }); } });
  f.reasoner.modelRoutingMetrics.clock = () => clock;
  const context = f.context('interpret'); await f.call(context); f.commits.commitSql(context, () => {});
  const metrics = f.reasoner.modelRoutingMetrics.summary(); assert.equal(metrics.totals.attempts, f.wire.length); assert.equal(metrics.totals.attempts, 2); assert.equal(metrics.totals.failures, 1); assert.equal(metrics.totals.successes, 1);
  const primary = metrics.groups.find(g => g.model === 'cheap'), fallback = metrics.groups.find(g => g.model === 'strong');
  assert.equal(primary.stage, 'interpret'); assert.equal(primary.avgDurationMs, 12); assert.equal(primary.knownTokens, null); assert.equal(primary.usageUnknownCalls, 1);
  assert.equal(fallback.avgDurationMs, 31); assert.equal(fallback.knownTokens, 15); assert.equal(fallback.fallbackAttempts, 1);
});
test('disabled routing still observes the native base model and original stage', async t => {
  const f = fixture(t), service = f.reasoner.modelRouting;
  const policy = service.configure({ expectedVersion: f.policy.version, config: null, maxRpcAttempts: 1, requestCallLimit: 1 }); applyModelRequestLimit(f.reasoner, policy);
  const context = f.context('verification'); await f.call(context); const row = f.reasoner.modelRoutingMetrics.summary().groups[0];
  assert.equal(row.model, 'base'); assert.equal(row.stage, 'verification'); assert.equal(row.routingVersion, policy.version); assert.equal(row.routingDigest, null); assert.equal(row.attempts, 1);
});
test('local refusal and native fetch-wrapper precheck failure record no fictitious RPC', async t => {
  const f = fixture(t); f.tokens.setLimit({ scope: 'workspace', tokens: 0 }); await assert.rejects(f.call(f.context()), { code: 'TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(f.reasoner.modelRoutingMetrics.summary().totals.attempts, 0); f.tokens.setLimit({ scope: 'workspace', tokens: null });
  const renew = f.sessions.renewClaim.bind(f.sessions); f.sessions.renewClaim = () => { throw Object.assign(new Error('native prefetch fence'), { code: 'SESSION_OWNER_LOST' }); };
  await assert.rejects(f.call(f.context('interpret','prefetch-fence')), { code: 'SESSION_OWNER_LOST' }); f.sessions.renewClaim = renew;
  assert.equal(f.wire.length, 0); assert.equal(f.reasoner.modelRoutingMetrics.summary().totals.attempts, 0);
});
test('metrics SQL failure cannot lose a successful answer, change billing, or retry a provider RPC', async t => {
  const f = fixture(t), prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => /^INSERT INTO model_route_attempts/.test(sql) ? { run() { throw Object.assign(new Error('advisory metrics unavailable'), { code: 'SQLITE_BUSY' }); } } : prepare(sql);
  const context = f.context(); const answer = await f.call(context); f.commits.commitSql(context, () => {});
  assert.equal(answer.subjectEntity, 'Lobby'); assert.equal(f.wire.length, 1); assert.equal(f.tokens.describe().workspace.settled, 15);
  const metrics = f.reasoner.modelRoutingMetrics.summary(); assert.equal(metrics.totals.attempts, 0); assert.equal(metrics.observationStatus.writeFailures, 1); assert.equal(metrics.observationStatus.lastFailure.code, 'SQLITE_BUSY');
});
test('unexpected metrics callback failure is advisory and observable after a successful RPC', async t => {
  const f = fixture(t); f.reasoner.modelRoutingMetrics.finish = () => { throw new Error('observer failed'); };
  const context = f.context(); await f.call(context); f.commits.commitSql(context, () => {});
  assert.equal(f.wire.length, 1); assert.equal(f.tokens.describe().workspace.settled, 15); assert.equal(f.reasoner.modelRoutingMetrics.status().writeFailures, 1);
});

test('persisted routing group rejects Pi on native bind before changing its accounting or invoking SDK', t => {
  const f = fixture(t); let sdk = 0;
  const pi = new PiReasoner({ baseUrl: 'https://example.test/v1', model: 'base', runtimeOptions: { loadSdk: async () => { sdk++; throw new Error('must not run'); } } });
  const oldAccounting = pi.accounting;
  assert.throws(() => bindReasonerTokenBudget(pi, f.tokens), { code: 'MODEL_ROUTING_UNSUPPORTED_HARNESS', status: 409 });
  assert.equal(pi.accounting, oldAccounting); assert.equal(pi.tokenBudget, null); assert.equal(sdk, 0); assert.equal(f.wire.length, 0);
});
// On an unsupported Node version createReasoner refuses Pi before routing can
// be consulted, so this ordering assertion only applies where Pi can load.
test('saved Standard routing group cannot be bypassed by synthetic Pi model setup', { skip: !piSupported() }, async t => {
  const f = fixture(t); let fetches = 0, sdk = 0;
  await assert.rejects(validateModelSettings({ baseUrl: 'https://example.test/v1', model: 'base', protocol: 'chat-completions', harness: 'pi' }, {
    tokenBudget: f.tokens, fetchImpl: async () => { fetches++; return response(); }, piRuntimeOptions: { loadSdk: async () => { sdk++; throw new Error('must not run'); } }
  }), { code: 'MODEL_ROUTING_UNSUPPORTED_HARNESS', status: 409 });
  assert.equal(fetches, 0); assert.equal(sdk, 0);
});
