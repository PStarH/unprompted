import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FALLBACK_FAILURE_KINDS,
  ROUTING_CONFIG_VERSION,
  ROUTING_STAGES,
  fallbackCandidate,
  normalizeRoutingConfig,
  routeFor
} from '../src/model-routing.js';

const base = () => ({
  modelIds: ['model-alpha', 'model-beta', 'model-gamma'],
  defaultModel: 'model-alpha',
  stages: { planning: 'model-beta', verification: 'model-gamma' }
});
const configure = overrides => normalizeRoutingConfig({ ...base(), ...overrides });
const fallbackRoute = () => routeFor(configure({ fallbackModel: 'model-gamma' }), 'planning');
const failed = (overrides = {}) => ({
  failureKind: 'provider_transient',
  status: 503,
  code: 'service_unavailable',
  attempts: 1,
  toolsStarted: 0,
  ...overrides
});

test('model array accessors are never executed, hidden elements and C1 controls are rejected', () => {
  let reads = 0;
  const accessor = ['alpha', 'beta'];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return 'alpha'; } });
  assert.throws(() => normalizeRoutingConfig({ modelIds: accessor, defaultModel: 'alpha' }));
  assert.equal(reads, 0);
  const hidden = ['alpha', 'beta'];
  Object.defineProperty(hidden, '0', { enumerable: false, value: 'alpha' });
  assert.throws(() => normalizeRoutingConfig({ modelIds: hidden, defaultModel: 'alpha' }));
  for (const char of ['\u0085', '\u0080', '\u009f']) {
    assert.throws(() => normalizeRoutingConfig({ modelIds: [`a${char}b`], defaultModel: `a${char}b` }));
  }
  assert.equal(normalizeRoutingConfig({ modelIds: ['模型α'], defaultModel: '模型α' }).defaultModel, '模型α');
});

test('spoofed transient kinds never override denied or unrecognized codes, including auth proxy statuses', () => {
  const route = fallbackRoute();
  for (const code of ['fee_exceeded', 'cost_limit', 'overdraft', 'invalid_api_key', 'token_expired',
    'EPERM', 'EACCES', 'ENOSPC', 'EIO', 'EROFS', 'EDQUOT', 'ECANCELED', 'ABORT_ERR',
    'ERR_REQUEST_ABORTED', 'not_allowed', 'arbitrary_new_unknown_code']) {
    for (const status of [429, 503]) assert.equal(fallbackCandidate(route, failed({ code, status })), null, code);
  }
  for (const status of [407, 511]) assert.equal(fallbackCandidate(route, failed({ status, code: 'upstream_error' })), null);
});

test('explicit unknown external outcome cannot qualify as transport or provider fallback', () => {
  const route = fallbackRoute();
  for (const field of ['ambiguous', 'writeOutcomeUnknown', 'externalResultUnknown', 'outcomeUnknown']) {
    for (const value of [true, null, 'false', 1]) {
      assert.equal(fallbackCandidate(route, failed({ [field]: value })), null, field);
    }
    assert.equal(fallbackCandidate(route, failed({ [field]: false })).model, 'model-gamma');
  }
});

test('an absent routing config keeps the original single-model path', () => {
  assert.equal(normalizeRoutingConfig(null), null);
  assert.equal(normalizeRoutingConfig(undefined), null);
  assert.equal(routeFor(null, 'planning'), null);
  assert.equal(routeFor(undefined, 'planning'), null);
  assert.equal(fallbackCandidate(null, failed()), null);
});

test('normalization returns a versioned, digested, deep-frozen clone', () => {
  const input = base();
  const config = normalizeRoutingConfig(input);
  assert.equal(config.version, ROUTING_CONFIG_VERSION);
  assert.match(config.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(config.modelIds, ['model-alpha', 'model-beta', 'model-gamma']);
  assert.equal(config.defaultModel, 'model-alpha');
  assert.deepEqual({ ...config.stages }, { planning: 'model-beta', verification: 'model-gamma' });
  assert.equal(config.fallbackModel, null);
  for (const value of [config, config.modelIds, config.stages]) {
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isExtensible(value), false);
  }
  for (const value of [input, input.modelIds, input.stages]) assert.equal(Object.isFrozen(value), false);
  assert.throws(() => { config.modelIds[0] = 'changed'; }, TypeError);
  assert.throws(() => { config.stages.planning = 'changed'; }, TypeError);
  assert.throws(() => { config.defaultModel = 'changed'; }, TypeError);
  assert.throws(() => { config.extra = true; }, TypeError);
});

test('later caller mutations cannot change an issued policy', () => {
  const input = { ...base(), fallbackModel: 'model-gamma' };
  const config = normalizeRoutingConfig(input);
  const before = routeFor(config, 'planning');
  input.modelIds[0] = 'mutated-alpha';
  input.modelIds.push('mutated-extra');
  input.defaultModel = 'mutated-alpha';
  input.stages.planning = 'mutated-alpha';
  delete input.stages.verification;
  input.fallbackModel = 'mutated-alpha';
  input.unknown = 'added';
  const after = routeFor(config, 'planning');
  assert.deepEqual(after, before);
  assert.deepEqual(config.modelIds, ['model-alpha', 'model-beta', 'model-gamma']);
  assert.equal(config.defaultModel, 'model-alpha');
  assert.equal(config.stages.planning, 'model-beta');
  assert.equal(config.fallbackModel, 'model-gamma');
  assert.equal(Object.hasOwn(config, 'unknown'), false);
});

test('the policy digest is stable across equivalent JSON and changes with policy content', () => {
  const first = normalizeRoutingConfig({ modelIds: ['alpha', 'beta'], defaultModel: 'alpha', stages: { general: 'beta', planning: 'beta' } });
  const reordered = normalizeRoutingConfig({ stages: { planning: 'beta', general: 'beta' }, defaultModel: 'alpha', modelIds: ['alpha', 'beta'] });
  assert.equal(first.digest, reordered.digest);
  assert.equal(first.digest, normalizeRoutingConfig({ modelIds: ['alpha', 'beta'], defaultModel: 'alpha', stages: { general: 'beta', planning: 'beta' } }).digest);
  const baseline = configure().digest;
  const variants = [
    configure({ defaultModel: 'model-beta' }),
    configure({ stages: { planning: 'model-alpha', verification: 'model-gamma' } }),
    configure({ fallbackModel: 'model-gamma' }),
    configure({ modelIds: ['model-beta', 'model-alpha', 'model-gamma'] })
  ];
  for (const variant of variants) assert.notEqual(variant.digest, baseline);
  assert.equal(new Set(variants.map(variant => variant.digest)).size, variants.length);
});

test('routing config accepts only the strict plain JSON shape', () => {
  for (const field of ['provider', 'providerId', 'baseUrl', 'apiKey', 'api_key', 'headers', 'credential', 'secret', 'unknown']) {
    assert.throws(() => normalizeRoutingConfig({ ...base(), [field]: 'value' }), /unsupported field/);
  }
  for (const value of [[], 'config', 42, true, new Date(), new Map(), Object.create({ inherited: true })]) {
    assert.throws(() => normalizeRoutingConfig(value), /plain JSON object/);
  }
  assert.throws(() => normalizeRoutingConfig({ ...base(), [Symbol('extra')]: 'value' }), /symbol keys/);
  const accessor = base();
  Object.defineProperty(accessor, 'stages', { enumerable: true, get: () => ({ planning: 'model-beta' }) });
  assert.throws(() => normalizeRoutingConfig(accessor), /data properties/);
  const hidden = base();
  Object.defineProperty(hidden, 'defaultModel', { enumerable: false, value: 'model-alpha' });
  assert.throws(() => normalizeRoutingConfig(hidden), /enumerable/);
  const nullPrototype = Object.assign(Object.create(null), base());
  assert.equal(normalizeRoutingConfig(nullPrototype).defaultModel, 'model-alpha');
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['model-alpha'] }), /requires defaultModel/);
  assert.throws(() => normalizeRoutingConfig({ defaultModel: 'model-alpha' }), /requires modelIds/);
});

test('model IDs are 1-8 unique, trimmed, single-line strings of at most 200 characters', () => {
  const withIds = values => normalizeRoutingConfig({ modelIds: values, defaultModel: values[0] });
  assert.equal(withIds(['a']).modelIds.length, 1);
  assert.equal(withIds(['a'.repeat(200)]).modelIds[0].length, 200);
  assert.equal(withIds(Array.from({ length: 8 }, (_, index) => `m${index}`)).modelIds.length, 8);
  for (const [values, pattern] of [
    [[], /1-8 model IDs/],
    [Array.from({ length: 9 }, (_, index) => `m${index}`), /1-8 model IDs/],
    [['a', 'a'], /duplicate/],
    [[''], /non-empty, trimmed/],
    [[' leading'], /non-empty, trimmed/],
    [['trailing '], /non-empty, trimmed/],
    [['line\nbreak'], /control/],
    [['carriage\rreturn'], /control/],
    [['nul\0byte'], /control/],
    [['a'.repeat(201)], /at most 200/],
    [['a', 7], /string model ID/],
    ['a', /must be an array/]
  ]) assert.throws(() => withIds(values), pattern);
  const sparse = new Array(2);
  sparse[0] = 'a';
  assert.throws(() => normalizeRoutingConfig({ modelIds: sparse, defaultModel: 'a' }), /dense array/);
  const extra = ['a', 'b'];
  extra.extra = true;
  assert.throws(() => normalizeRoutingConfig({ modelIds: extra, defaultModel: 'a' }), /dense array/);
  const indexed = ['a', 'b'];
  indexed['01'] = 'c';
  assert.throws(() => normalizeRoutingConfig({ modelIds: indexed, defaultModel: 'a' }), /dense array/);
  class Ids extends Array {}
  assert.throws(() => normalizeRoutingConfig({ modelIds: Ids.from(['a', 'b']), defaultModel: 'a' }), /plain array/);
});

test('default, stage and fallback references must stay inside the group and stage keys are whitelisted', () => {
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'b' }), /defaultModel/);
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', fallbackModel: 'b' }), /fallbackModel/);
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', fallbackModel: null }), /fallbackModel/);
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', stages: { planning: 'b' } }), /stages entries/);
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', stages: { planning: 1 } }), /string model ID/);
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', stages: [] }), /plain object/);
  assert.throws(() => normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', stages: { summary: 'a' } }), /whitelist/);
  const polluted = { modelIds: ['a'], defaultModel: 'a', stages: JSON.parse('{"__proto__":"a"}') };
  assert.throws(() => normalizeRoutingConfig(polluted), /whitelist/);
  assert.deepEqual({ ...normalizeRoutingConfig({ modelIds: ['a'], defaultModel: 'a', stages: {} }).stages }, {});
});

test('every whitelisted stage routes to its mapping and unconfigured stages use defaultModel', () => {
  const config = normalizeRoutingConfig({
    modelIds: ['alpha', 'beta', 'gamma'],
    defaultModel: 'alpha',
    stages: { interpret: 'beta', discovery: 'gamma', planning: 'beta', verification: 'gamma', general: 'gamma' }
  });
  const expected = { interpret: 'beta', discovery: 'gamma', planning: 'beta', verification: 'gamma', general: 'gamma' };
  for (const stage of ROUTING_STAGES) {
    const route = routeFor(config, stage);
    assert.equal(route.stage, stage);
    assert.equal(route.model, expected[stage]);
  }
  const partial = normalizeRoutingConfig({ modelIds: ['alpha', 'beta'], defaultModel: 'alpha', stages: { planning: 'beta' } });
  const unmapped = routeFor(partial, 'verification');
  assert.equal(unmapped.stage, 'verification');
  assert.equal(unmapped.model, 'alpha');
});

test('an unknown stage uses defaultModel and is never remapped through general', () => {
  const config = normalizeRoutingConfig({ modelIds: ['alpha', 'beta', 'gamma'], defaultModel: 'alpha', stages: { general: 'beta' } });
  assert.equal(routeFor(config, 'general').model, 'beta');
  for (const stage of ['summary', '', 'general ', 'Planning', 'request-01', 'beta', '{"stage":"general"}', 42, null, undefined, {}, ['planning']]) {
    const route = routeFor(config, stage);
    assert.equal(route.stage, 'default');
    assert.equal(route.model, 'alpha');
  }
});

test('route snapshots are frozen, carry policy identity, and never leak caller state', () => {
  const config = configure({ fallbackModel: 'model-gamma' });
  const route = routeFor(config, 'planning');
  assert.deepEqual(Object.keys(route).sort(), ['digest', 'fallbackModel', 'model', 'stage', 'version']);
  assert.equal(route.version, ROUTING_CONFIG_VERSION);
  assert.equal(route.digest, config.digest);
  assert.equal(route.stage, 'planning');
  assert.equal(route.model, 'model-beta');
  assert.equal(route.fallbackModel, 'model-gamma');
  assert.equal(Object.isFrozen(route), true);
  assert.throws(() => { route.model = 'mutated'; }, TypeError);
  assert.equal(JSON.stringify(route).includes('apiKey'), false);
  assert.equal(JSON.stringify(route).includes('prompt'), false);
});

test('concurrent routing snapshots do not share models or mutate a shared reasoner', async () => {
  const left = normalizeRoutingConfig({ modelIds: ['left-a', 'left-b'], defaultModel: 'left-a', stages: { planning: 'left-b' } });
  const right = normalizeRoutingConfig({ modelIds: ['right-a', 'right-b'], defaultModel: 'right-a', stages: { planning: 'right-b' } });
  const reasoner = Object.freeze({ model: 'shared-primary' });
  const routes = await Promise.all([
    Promise.resolve().then(() => routeFor(left, 'planning')),
    Promise.resolve().then(() => routeFor(right, 'planning')),
    Promise.resolve().then(() => routeFor(left, 'verification')),
    Promise.resolve().then(() => routeFor(right, 'verification'))
  ]);
  assert.deepEqual(routes.map(route => route.model), ['left-b', 'right-b', 'left-a', 'right-a']);
  assert.deepEqual(routes.map(route => route.stage), ['planning', 'planning', 'verification', 'verification']);
  assert.equal(routes[0].digest, left.digest);
  assert.equal(routes[1].digest, right.digest);
  assert.notEqual(routes[0].digest, routes[1].digest);
  assert.equal(reasoner.model, 'shared-primary');
});

test('routeFor rejects raw, stale, forged or mutated normalized configs', () => {
  assert.throws(() => routeFor(base(), 'planning'), /Unsupported routing config version/);
  const config = normalizeRoutingConfig(base());
  assert.throws(() => routeFor({ ...config, version: 2 }, 'planning'), /version/);
  assert.throws(() => routeFor({ ...config, extra: true }, 'planning'), /unsupported field/);
  assert.throws(() => routeFor({ ...config, digest: `sha256:${'0'.repeat(64)}` }, 'planning'), /digest/);
  assert.throws(() => routeFor({ ...config, digest: 'not-a-digest' }, 'planning'), /digest/);
  assert.throws(() => routeFor({ ...config, stages: { ...config.stages, planning: 'model-alpha' } }, 'planning'), /digest/);
  assert.throws(() => routeFor({ ...config, modelIds: ['other'] }, 'planning'), /defaultModel/);
  assert.equal(routeFor(Object.freeze({ ...config }), 'planning').model, 'model-beta');
});

test('a trusted provider transient yields one immutable candidate with fresh accounting required', () => {
  const config = configure({ fallbackModel: 'model-gamma' });
  const route = routeFor(config, 'planning');
  const candidate = fallbackCandidate(route, failed());
  assert.deepEqual(Object.keys(candidate).sort(), ['digest', 'model', 'requiresFreshAccounting', 'stage', 'version']);
  assert.equal(candidate.version, ROUTING_CONFIG_VERSION);
  assert.equal(candidate.digest, config.digest);
  assert.equal(candidate.stage, 'planning');
  assert.equal(candidate.model, 'model-gamma');
  assert.equal(candidate.requiresFreshAccounting, true);
  assert.equal(Object.isFrozen(candidate), true);
  assert.throws(() => { candidate.model = 'mutated'; }, TypeError);
  assert.equal(Object.hasOwn(candidate, 'fallbackModel'), false);
  assert.equal(fallbackCandidate(candidate, failed()), null);
});

test('fallback is limited to a configured, different model after exactly one failed attempt', () => {
  assert.equal(fallbackCandidate(routeFor(configure(), 'planning'), failed()), null);

  const same = normalizeRoutingConfig({ modelIds: ['alpha', 'beta'], defaultModel: 'alpha', fallbackModel: 'alpha' });
  assert.equal(fallbackCandidate(routeFor(same, 'verification'), failed()), null);
  const mapped = normalizeRoutingConfig({ modelIds: ['alpha', 'beta'], defaultModel: 'alpha', fallbackModel: 'alpha', stages: { planning: 'beta' } });
  assert.equal(fallbackCandidate(routeFor(mapped, 'planning'), failed()).model, 'alpha');

  const route = fallbackRoute();
  for (const attempts of [0, 2, 3, '1', null, undefined, 1.5, NaN]) {
    assert.equal(fallbackCandidate(route, failed({ attempts })), null);
  }
});

test('any started tool, or unknown tool state, refuses fallback', () => {
  const route = fallbackRoute();
  assert.equal(fallbackCandidate(route, failed({ toolsStarted: 0 })).model, 'model-gamma');
  for (const toolsStarted of [1, 2, -1, '0', null, undefined, false, 0.5]) {
    assert.equal(fallbackCandidate(route, failed({ toolsStarted })), null);
  }
});

test('only trusted transient, transport and unsupported-capability kinds qualify', () => {
  const route = fallbackRoute();
  for (const failureKind of FALLBACK_FAILURE_KINDS) {
    assert.equal(fallbackCandidate(route, { failureKind, attempts: 1, toolsStarted: 0 }).model, 'model-gamma');
  }
  for (const failureKind of ['unknown', 'budget', 'authentication', 'quota', 'provider', 'transient', '', null, undefined, 42]) {
    assert.equal(fallbackCandidate(route, failed({ failureKind })), null);
  }
  assert.equal(fallbackCandidate(route, new Error('provider_transient')), null);
  assert.equal(fallbackCandidate(route, 'provider_transient'), null);
  assert.equal(fallbackCandidate(route, null), null);
  assert.equal(fallbackCandidate(route, []), null);
});

test('authentication, payment and malformed statuses never qualify', () => {
  const route = fallbackRoute();
  for (const status of [401, 402, 403]) assert.equal(fallbackCandidate(route, failed({ status })), null);
  for (const status of [400, 408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(fallbackCandidate(route, failed({ status })).model, 'model-gamma');
  }
  for (const status of [99, 600, 503.5, '503', NaN, Infinity]) {
    assert.equal(fallbackCandidate(route, failed({ status })), null);
  }
  assert.equal(fallbackCandidate(route, failed({ status: null })).model, 'model-gamma');
});

test('known budget, authority, store and configuration codes cannot be upgraded by 429/503', () => {
  const route = fallbackRoute();
  const denied = [
    'budget_exceeded', 'insufficient_quota', 'rate_limit_quota', 'accounting_error',
    'payment_required', 'insufficient_funds', 'credit_exhausted', 'balance_empty',
    'permission_denied', 'access_denied', 'unauthorized', 'forbidden', 'authority_revoked',
    'sqlite_busy', 'SQLITE_CONSTRAINT', 'store_unavailable', 'database_locked',
    'config_invalid', 'configuration_error', 'policy_denied', 'auth_expired'
  ];
  for (const code of denied) {
    for (const status of [429, 503]) assert.equal(fallbackCandidate(route, failed({ status, code })), null);
  }
  for (const code of [401, 402, 403, '401', 'HTTP_403']) {
    assert.equal(fallbackCandidate(route, failed({ status: 503, code })), null);
  }
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'service_unavailable', 'rate_limit_exceeded', 'upstream_error', 429]) {
    assert.equal(fallbackCandidate(route, failed({ status: 503, code })).model, 'model-gamma');
  }
  for (const code of [1n, {}, [], NaN, Infinity, true]) {
    assert.equal(fallbackCandidate(route, failed({ code })), null);
  }
  assert.equal(fallbackCandidate(route, failed({ code: null })).model, 'model-gamma');
});

test('aborted cancellation and timeout signals never fall back', () => {
  const route = fallbackRoute();
  assert.equal(fallbackCandidate(route, failed({ aborted: true })), null);
  assert.equal(fallbackCandidate(route, failed({ aborted: false })).model, 'model-gamma');
  for (const aborted of [1, 'false', null, {}]) assert.equal(fallbackCandidate(route, failed({ aborted })), null);
  assert.equal(fallbackCandidate(route, failed({ signal: { aborted: true } })), null);
  assert.equal(fallbackCandidate(route, failed({ signal: { aborted: false } })).model, 'model-gamma');
  const controller = new AbortController();
  controller.abort();
  assert.equal(fallbackCandidate(route, failed({ signal: controller.signal })), null);
  const live = new AbortController();
  assert.equal(fallbackCandidate(route, failed({ signal: live.signal })).model, 'model-gamma');
  for (const signal of [{}, { aborted: 'yes' }, 'signal', 1]) {
    assert.equal(fallbackCandidate(route, failed({ signal })), null);
  }
  assert.equal(fallbackCandidate(route, failed({ signal: null })).model, 'model-gamma');
});

test('malformed failures and forged route snapshots default to no fallback', () => {
  const route = fallbackRoute();
  for (const failure of [
    undefined, null, 'failure', new Error('transport'), [], new Map(),
    { failureKind: 'transport' },
    { failureKind: 'transport', attempts: 1 },
    { failureKind: 'transport', attempts: 1, toolsStarted: '0' }
  ]) assert.equal(fallbackCandidate(route, failure), null);
  assert.equal(fallbackCandidate({ ...route }, failed()), null);
  assert.equal(fallbackCandidate(JSON.parse(JSON.stringify(route)), failed()), null);
  const forged = { version: 1, digest: `sha256:${'a'.repeat(64)}`, stage: 'planning', model: 'model-beta', fallbackModel: 'model-gamma' };
  assert.equal(fallbackCandidate(forged, failed()), null);
  assert.equal(fallbackCandidate(normalizeRoutingConfig(base()), failed()), null);
  const accessor = {};
  Object.defineProperty(accessor, 'failureKind', { enumerable: true, get: () => 'transport' });
  assert.equal(fallbackCandidate(route, accessor), null);
  const throwing = {};
  Object.defineProperty(throwing, 'failureKind', { enumerable: true, get: () => { throw new Error('boom'); } });
  assert.equal(fallbackCandidate(route, throwing), null);
});

test('raw failures, credentials and model output never enter routing results or errors', () => {
  const secret = 'fixture-value-that-is-not-a-credential';
  const route = fallbackRoute();
  const candidate = fallbackCandidate(route, failed({
    message: `provider said ${secret}`,
    response: { text: secret },
    requestId: 'request-123'
  }));
  assert.equal(candidate.requiresFreshAccounting, true);
  assert.equal(JSON.stringify(candidate).includes(secret), false);
  assert.equal(JSON.stringify(candidate).includes('request-123'), false);
  assert.equal(Object.hasOwn(candidate, 'message'), false);
  assert.equal(Object.hasOwn(candidate, 'requestId'), false);
  assert.throws(() => normalizeRoutingConfig({ ...base(), apiKey: secret }), error => {
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.throws(() => normalizeRoutingConfig({ modelIds: [`bad\n${secret}`], defaultModel: `bad\n${secret}` }), error => {
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('the routing whitelist, version and failure kinds are fixed policy data', () => {
  assert.equal(ROUTING_CONFIG_VERSION, 1);
  assert.deepEqual([...ROUTING_STAGES], ['interpret', 'discovery', 'planning', 'verification', 'general']);
  assert.deepEqual([...FALLBACK_FAILURE_KINDS], ['provider_transient', 'transport', 'capability_unsupported']);
  assert.equal(Object.isFrozen(ROUTING_STAGES), true);
  assert.equal(Object.isFrozen(FALLBACK_FAILURE_KINDS), true);
});

test('the policy module contains no network, process or provider dispatch surface', () => {
  const source = fs.readFileSync(new URL('../src/model-routing.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /node:(?:https?|net|tls|dgram|child_process)/u);
  assert.doesNotMatch(source, /\bprocess\.env\b/u);
  assert.match(source, /from 'node:crypto'/u);
});
