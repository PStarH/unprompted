import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelPricingError,
  PRICE_COMPONENTS,
  PRICE_CURRENCIES,
  knownUsageCost,
  normalizePriceProfile,
  quoteRequestReservation
} from '../src/model-pricing.js';

/**
 * Model pricing core behaviour.
 *
 * Vectors are hand-computed in integer micro-currency (1 micro = 1e-6 of the
 * currency unit). The near-MAX_SAFE_INTEGER vectors are deliberately chosen so
 * a Number/Math.ceil implementation loses the final micro-token unit and
 * returns Number.MAX_SAFE_INTEGER instead of throwing PRICE_OVERFLOW; see
 * "one micro-token unit past the representable boundary overflows".
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const profileInput = (overrides = {}) => ({
  providerId: 'openai-primary',
  protocol: 'chat-completions',
  model: 'model-a',
  currency: 'USD',
  revision: 1,
  rates: { input: 150000, output: 600000, cacheRead: 75000, cacheWrite: 0 },
  ...overrides
});

const zeroRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const priced = (rates, overrides = {}) =>
  normalizePriceProfile(profileInput({ rates: { ...zeroRates, ...rates }, ...overrides }));
const usage = (overrides = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides });

function rejects(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ModelPricingError, `expected ModelPricingError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`Expected ${code} but the call succeeded.`);
}

test('a normalized price profile is a frozen snapshot with a stable digest', () => {
  assert.deepEqual(PRICE_CURRENCIES, ['USD', 'CNY', 'EUR']);
  assert.deepEqual(PRICE_COMPONENTS, ['input', 'output', 'cacheRead', 'cacheWrite']);

  const profile = normalizePriceProfile(profileInput());
  assert.equal(profile.providerId, 'openai-primary');
  assert.equal(profile.protocol, 'chat-completions');
  assert.equal(profile.model, 'model-a');
  assert.equal(profile.currency, 'USD');
  assert.equal(profile.revision, 1);
  assert.deepEqual(profile.rates, { input: 150000, output: 600000, cacheRead: 75000, cacheWrite: 0 });
  assert.match(profile.digest, /^[0-9a-f]{64}$/);
  // Golden SHA-256 of the canonical field array, computed outside this module:
  // ["unprompted.model-pricing.profile/v1","openai-primary","chat-completions","model-a","USD",1,150000,600000,75000,0]
  assert.equal(profile.digest, '0e407e04ed17529173f2bb2896cd45d788809ebd68ce8426f8b494d10d74f156');
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.rates));
  assert.equal(normalizePriceProfile(profileInput()).digest, profile.digest);
  // A snapshot can be normalized again without losing its digest.
  assert.equal(normalizePriceProfile(profile).digest, profile.digest);
});

test('normalization neither freezes nor mutates the caller object', () => {
  const original = profileInput();
  const copy = structuredClone(original);
  const profile = normalizePriceProfile(original);
  const digest = profile.digest;

  assert.deepEqual(original, copy);
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(original.rates), false);

  original.rates.input = 999999999;
  original.revision = 2;
  assert.equal(profile.rates.input, 150000);
  assert.equal(profile.revision, 1);
  assert.equal(profile.digest, digest);
});

test('the digest ignores property order and changes with every bound field', () => {
  const reordered = {
    rates: { cacheWrite: 0, cacheRead: 75000, output: 600000, input: 150000 },
    revision: 1,
    currency: 'USD',
    model: 'model-a',
    protocol: 'chat-completions',
    providerId: 'openai-primary'
  };
  const base = normalizePriceProfile(profileInput());
  assert.equal(normalizePriceProfile(reordered).digest, base.digest);

  const changes = [
    { providerId: 'openai-secondary' },
    { protocol: 'messages' },
    { model: 'model-b' },
    { currency: 'CNY' },
    { revision: 2 },
    { rates: { input: 150001, output: 600000, cacheRead: 75000, cacheWrite: 0 } },
    { rates: { input: 150000, output: 600001, cacheRead: 75000, cacheWrite: 0 } },
    { rates: { input: 150000, output: 600000, cacheRead: 75001, cacheWrite: 0 } },
    { rates: { input: 150000, output: 600000, cacheRead: 75000, cacheWrite: 1 } }
  ];
  const digests = new Set([base.digest]);
  for (const change of changes) digests.add(normalizePriceProfile(profileInput(change)).digest);
  assert.equal(digests.size, changes.length + 1);
});

test('profile validation rejects missing, unknown and malformed fields', () => {
  rejects(() => normalizePriceProfile(), 'PRICE_PROFILE_INVALID');
  rejects(() => normalizePriceProfile(null), 'PRICE_PROFILE_INVALID');
  rejects(() => normalizePriceProfile([]), 'PRICE_PROFILE_INVALID');

  for (const field of ['providerId', 'protocol', 'model', 'currency', 'revision', 'rates']) {
    const missing = profileInput();
    delete missing[field];
    rejects(() => normalizePriceProfile(missing), 'PRICE_PROFILE_INVALID');
  }
  for (const field of ['apiKey', 'baseUrl', 'label', 'anything']) {
    rejects(() => normalizePriceProfile(profileInput({ [field]: 'x' })), 'PRICE_PROFILE_INVALID');
  }
  const symbolic = profileInput();
  symbolic[Symbol('hidden')] = 'x';
  rejects(() => normalizePriceProfile(symbolic), 'PRICE_PROFILE_INVALID');

  for (const component of PRICE_COMPONENTS) {
    const missing = profileInput();
    delete missing.rates[component];
    rejects(() => normalizePriceProfile(missing), 'PRICE_PROFILE_INVALID');

    // A missing component is never defaulted to zero, even when every rate
    // that is present is an explicit zero.
    const zeroPartial = { ...zeroRates };
    delete zeroPartial[component];
    rejects(() => normalizePriceProfile(profileInput({ rates: zeroPartial })), 'PRICE_PROFILE_INVALID');
  }
  rejects(() => normalizePriceProfile(profileInput({ rates: { ...zeroRates, cacheCreation: 1 } })), 'PRICE_PROFILE_INVALID');
  rejects(() => normalizePriceProfile(profileInput({ rates: [] })), 'PRICE_PROFILE_INVALID');
});

test('rates are explicit non-negative safe integers in micro units', () => {
  const zero = normalizePriceProfile(profileInput({ rates: zeroRates }));
  assert.deepEqual(zero.rates, zeroRates);

  const invalid = [-1, 0.5, '0', null, undefined, NaN, Infinity, -Infinity, MAX_SAFE + 1, 1n, true];
  for (const value of invalid) {
    rejects(() => normalizePriceProfile(profileInput({ rates: { ...zeroRates, input: value } })), 'PRICE_PROFILE_INVALID');
  }
  for (const component of PRICE_COMPONENTS) {
    rejects(() => normalizePriceProfile(profileInput({ rates: { ...zeroRates, [component]: -1 } })), 'PRICE_PROFILE_INVALID');
  }
  // Explicit MAX_SAFE_INTEGER is a valid boundary rate.
  assert.equal(normalizePriceProfile(profileInput({ rates: { ...zeroRates, input: MAX_SAFE } })).rates.input, MAX_SAFE);
});

test('only the declared currencies and existing protocols are accepted', () => {
  for (const currency of PRICE_CURRENCIES) {
    assert.equal(normalizePriceProfile(profileInput({ currency })).currency, currency);
  }
  for (const currency of ['GBP', 'JPY', 'usd', 'USD ', '']) {
    rejects(() => normalizePriceProfile(profileInput({ currency })), 'PRICE_PROFILE_INVALID');
  }
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    assert.equal(normalizePriceProfile(profileInput({ protocol })).protocol, protocol);
  }
  for (const protocol of ['openai', 'anthropic', '', null]) {
    rejects(() => normalizePriceProfile(profileInput({ protocol })), 'PRICE_PROFILE_INVALID');
  }
});

test('provider, model and revision validation is strict', () => {
  for (const field of ['providerId', 'model']) {
    for (const value of ['', ' leading', 'trailing ', 'a\nb', 'a\tb', 5, null, 'x'.repeat(201)]) {
      rejects(() => normalizePriceProfile(profileInput({ [field]: value })), 'PRICE_PROFILE_INVALID');
    }
    assert.equal(normalizePriceProfile(profileInput({ [field]: 'valid id' }))[field], 'valid id');
  }
  for (const revision of [0, -1, 1.5, '1', null, MAX_SAFE + 1]) {
    rejects(() => normalizePriceProfile(profileInput({ revision })), 'PRICE_PROFILE_INVALID');
  }
  assert.equal(normalizePriceProfile(profileInput({ revision: 1 })).revision, 1);
  assert.equal(normalizePriceProfile(profileInput({ revision: MAX_SAFE })).revision, MAX_SAFE);
});

test('identifier fields reject C0, DEL and C1 controls but allow normal Unicode', () => {
  // C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F) are all control
  // characters; the error contract says "control characters", not C0 only.
  const controls = ['\u0000', '\u001f', '\u007f', '\u0080', '\u0085', '\u009f'];
  for (const field of ['providerId', 'model']) {
    for (const control of controls) {
      rejects(() => normalizePriceProfile(profileInput({ [field]: `a${control}b` })), 'PRICE_PROFILE_INVALID');
    }
    // Normal Unicode text remains valid; this is not an ASCII-only rule.
    const text = field === 'providerId' ? '提供方·一' : '模型-café-✓-🤖';
    assert.equal(normalizePriceProfile(profileInput({ [field]: text }))[field], text);
  }
});

test('known usage cost sums every component with one ceiling', () => {
  const profile = priced({ input: 150000, output: 600000, cacheRead: 75000, cacheWrite: 300000 });
  const quote = knownUsageCost(profile, {
    input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000
  });
  // 150000*1e6 + 600000*5e5 + 75000*2e5 + 300000*1e5 = 495000000000 micro-token units
  // 495000000000 / 1000000 = 495000 micro exactly.
  assert.deepEqual(quote, { amountMicro: 495000, currency: 'USD', profileDigest: profile.digest });
  assert.ok(Object.isFrozen(quote));
});

test('known usage cost matches exact million-token and decimal boundaries', () => {
  const dollar = priced({ input: 1_000_000 });
  // 1 US dollar per 1,000,000 tokens.
  assert.equal(knownUsageCost(dollar, usage({ input: 1_000_000 })).amountMicro, 1_000_000);
  assert.equal(knownUsageCost(dollar, usage({ input: 999_999 })).amountMicro, 999_999);
  assert.equal(knownUsageCost(dollar, usage({ input: 1 })).amountMicro, 1);

  const fifteenCents = priced({ input: 150000 });
  // 0.15 micro per token is below one micro and rounds up to 1.
  assert.equal(knownUsageCost(fifteenCents, usage({ input: 1 })).amountMicro, 1);
  assert.equal(knownUsageCost(fifteenCents, usage({ input: 6 })).amountMicro, 1); // 0.9 -> 1
  assert.equal(knownUsageCost(fifteenCents, usage({ input: 7 })).amountMicro, 2); // 1.05 -> 2

  // Components are summed before the single ceiling: 2/1e6 micro -> 1, not 2.
  const oneMicroEach = priced({ input: 1, output: 1 });
  assert.equal(knownUsageCost(oneMicroEach, usage({ input: 1, output: 1 })).amountMicro, 1);

  // 999998000001/1000000 = 999998.000001 -> 999999.
  assert.equal(knownUsageCost(priced({ input: 999_999 }), usage({ input: 999_999 })).amountMicro, 999_999);
});

test('explicit zero usage or zero rates are known zero, not unknown', () => {
  const paid = priced({ input: 150000, output: 600000, cacheRead: 75000, cacheWrite: 300000 });
  assert.equal(knownUsageCost(paid, usage()).amountMicro, 0);

  const free = priced({});
  assert.equal(knownUsageCost(free, usage({ input: 123, output: 456, cacheRead: 7, cacheWrite: 8 })).amountMicro, 0);
  assert.equal(quoteRequestReservation(free, { inputUpperBound: 10_000, outputCap: 5_000 }).amountMicro, 0);
});

test('missing or untrusted usage is unknown, never a trusted zero', () => {
  const profile = priced({ input: 1000 });
  const invalid = [
    undefined,
    null,
    {},
    [],
    { input: 1, output: 1, cacheRead: 1 },
    // Partial usage with zero counts is still unknown, not a trusted zero.
    { input: 0, output: 0, cacheRead: 0 },
    { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: '10', output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: null, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: NaN, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: Infinity, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: MAX_SAFE + 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 1n, output: 0, cacheRead: 0, cacheWrite: 0 }
  ];
  for (const value of invalid) rejects(() => knownUsageCost(profile, value), 'PRICE_USAGE_UNKNOWN');

  // Inherited counts are not trusted usage.
  rejects(() => knownUsageCost(profile, Object.create(usage({ input: 10 }))), 'PRICE_USAGE_UNKNOWN');
});

test('extra usage fields are ignored and the four canonical counts still price', () => {
  const profile = priced({ input: 1000 });
  const quote = knownUsageCost(profile, { ...usage({ input: 10 }), requestId: 'r-1', provider: 'openai' });
  assert.equal(quote.amountMicro, 1); // 10*1000/1e6 -> ceil 1
});

test('near-MAX_SAFE products stay exact through BigInt and overflow refuses', () => {
  // 4e9 * 3000000 = 1.2e16 > MAX_SAFE_INTEGER; /1e6 = 12000000000 exactly.
  assert.equal(knownUsageCost(priced({ input: 3_000_000 }), usage({ input: 4_000_000_000 })).amountMicro, 12_000_000_000);

  // MAX_SAFE tokens at exactly 1 currency unit per 1M tokens is representable.
  const edge = priced({ input: 1_000_000 });
  assert.equal(knownUsageCost(edge, usage({ input: MAX_SAFE })).amountMicro, MAX_SAFE);
  assert.equal(quoteRequestReservation(edge, { inputUpperBound: MAX_SAFE, outputCap: 0 }).amountMicro, MAX_SAFE);

  // One more micro of rate pushes the quote past the safe range.
  rejects(() => knownUsageCost(priced({ input: 1_000_001 }), usage({ input: MAX_SAFE })), 'PRICE_OVERFLOW');

  // Component sums that pass MAX_SAFE_INTEGER also refuse.
  rejects(() => knownUsageCost(priced({ input: 600000, output: 600000 }),
    usage({ input: MAX_SAFE, output: MAX_SAFE })), 'PRICE_OVERFLOW');
  rejects(() => quoteRequestReservation(priced({ input: 2_000_000 }),
    { inputUpperBound: MAX_SAFE, outputCap: 0 }), 'PRICE_OVERFLOW');
  rejects(() => quoteRequestReservation(priced({ output: 1_000_001 }),
    { inputUpperBound: 0, outputCap: MAX_SAFE }), 'PRICE_OVERFLOW');

  // MAX_SAFE as a rate with one token still rounds safely: ceil(9007199254740991/1e6).
  assert.equal(knownUsageCost(priced({ input: MAX_SAFE }), usage({ input: 1 })).amountMicro, 9_007_199_255);
});

test('one micro-token unit past the representable boundary overflows', () => {
  // Hand-computed with input 1,000,000 and output 1 micro per 1,000,000
  // tokens: MAX_SAFE input tokens cost MAX_SAFE*1,000,000 micro-token units,
  // which divide exactly to MAX_SAFE micro and stay representable.
  const boundary = priced({ input: 1_000_000, output: 1 });
  assert.equal(knownUsageCost(boundary, usage({ input: MAX_SAFE })).amountMicro, MAX_SAFE);

  // One additional output token adds one micro-token unit to the numerator:
  // MAX_SAFE*1,000,000 + 1 = 9,007,199,254,740,991,000,001, whose final
  // ceiling is MAX_SAFE+1. A Number/Math.ceil implementation loses the +1
  // and returns MAX_SAFE, so this vector requires exact integer arithmetic.
  rejects(() => knownUsageCost(boundary, usage({ input: MAX_SAFE, output: 1 })), 'PRICE_OVERFLOW');

  // The reservation contract has the same boundary: outputCap adds
  // rateOutput*outputCap to the worst-case input term before the one ceiling.
  assert.equal(quoteRequestReservation(boundary, { inputUpperBound: MAX_SAFE, outputCap: 0 }).amountMicro, MAX_SAFE);
  rejects(() => quoteRequestReservation(boundary, { inputUpperBound: MAX_SAFE, outputCap: 1 }), 'PRICE_OVERFLOW');
});

test('the final ceiling applies once to the summed total at the safe boundary', () => {
  // 500,000 micro per 1,000,000 tokens is half a micro per token. MAX_SAFE
  // tokens at each of input and output total 2*MAX_SAFE*500,000 =
  // MAX_SAFE*1,000,000 micro-token units, i.e. exactly MAX_SAFE micro after
  // one ceiling. Ceiling each term separately would give MAX_SAFE+1.
  const halfMicro = priced({ input: 500_000, output: 500_000 });
  const counts = usage({ input: MAX_SAFE, output: MAX_SAFE });
  assert.equal(knownUsageCost(halfMicro, counts).amountMicro, MAX_SAFE);
  assert.equal(quoteRequestReservation(halfMicro,
    { inputUpperBound: MAX_SAFE, outputCap: MAX_SAFE }).amountMicro, MAX_SAFE);
});

test('reservation quotes charge every input token at the worst-case input rate', () => {
  const expensiveCache = priced({ input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 3000 });
  const worst = quoteRequestReservation(expensiveCache, { inputUpperBound: 1000, outputCap: 500 });
  // max(1000, 5000, 3000)*1000 + 2000*500 = 6000000 micro-token units -> 6 micro.
  assert.deepEqual(worst, { amountMicro: 6, currency: 'USD', profileDigest: expensiveCache.digest });

  const cheapCache = priced({ input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(quoteRequestReservation(cheapCache, { inputUpperBound: 1000, outputCap: 500 }).amountMicro, 2);
  assert.ok(worst.amountMicro > quoteRequestReservation(cheapCache, { inputUpperBound: 1000, outputCap: 500 }).amountMicro);

  // Cache components are alternatives, never summed: max is 3e6, not 6e6,
  // and the most expensive cache-write rate sets the input worst case.
  const cacheHeavy = priced({ input: 1_000_000, output: 0, cacheRead: 2_000_000, cacheWrite: 3_000_000 });
  assert.equal(quoteRequestReservation(cacheHeavy, { inputUpperBound: 1, outputCap: 0 }).amountMicro, 3);
  assert.ok(Object.isFrozen(worst));
});

test('reservation quotes round up once after summing both terms', () => {
  const halves = priced({ input: 1, output: 1 });
  // 500000 + 500000 = 1000000 micro-token units -> exactly 1 micro; a per-term
  // ceiling would wrongly return 2.
  assert.equal(quoteRequestReservation(halves, { inputUpperBound: 500_000, outputCap: 500_000 }).amountMicro, 1);
  assert.equal(quoteRequestReservation(halves, { inputUpperBound: 0, outputCap: 0 }).amountMicro, 0);
  assert.equal(quoteRequestReservation(priced({ input: 150000 }), { inputUpperBound: 1, outputCap: 0 }).amountMicro, 1);
});

test('reservation estimates must be explicit non-negative safe integers', () => {
  const profile = priced({ input: 1000 });
  const invalid = [
    undefined,
    null,
    [],
    {},
    { inputUpperBound: 1 },
    { outputCap: 1 },
    { inputUpperBound: -1, outputCap: 0 },
    { inputUpperBound: 0.5, outputCap: 0 },
    { inputUpperBound: 1.5, outputCap: 0 },
    { inputUpperBound: '1', outputCap: 0 },
    { inputUpperBound: null, outputCap: 0 },
    { inputUpperBound: NaN, outputCap: 0 },
    { inputUpperBound: Infinity, outputCap: 0 },
    { inputUpperBound: MAX_SAFE + 1, outputCap: 0 },
    { inputUpperBound: 1, outputCap: -1 }
  ];
  for (const estimate of invalid) rejects(() => quoteRequestReservation(profile, estimate), 'PRICE_ESTIMATE_INVALID');
  rejects(() => quoteRequestReservation(profile, Object.create({ inputUpperBound: 1, outputCap: 1 })), 'PRICE_ESTIMATE_INVALID');
});

test('quotes bind currency and profile digest without currency conversion', () => {
  const usd = normalizePriceProfile(profileInput({ currency: 'USD' }));
  const cny = normalizePriceProfile(profileInput({ currency: 'CNY' }));
  const counts = usage({ input: 1000 });
  const usdQuote = knownUsageCost(usd, counts);
  const cnyQuote = knownUsageCost(cny, counts);

  assert.equal(usdQuote.amountMicro, 150); // 1000*150000/1e6
  assert.equal(cnyQuote.amountMicro, 150);
  assert.equal(usdQuote.currency, 'USD');
  assert.equal(cnyQuote.currency, 'CNY');
  assert.equal(usdQuote.profileDigest, usd.digest);
  assert.equal(cnyQuote.profileDigest, cny.digest);
  assert.notEqual(usdQuote.profileDigest, cnyQuote.profileDigest);
  assert.ok(Object.isFrozen(usdQuote));
  assert.ok(Object.isFrozen(cnyQuote));

  const protocols = new Set(['chat-completions', 'responses', 'messages']
    .map(protocol => normalizePriceProfile(profileInput({ protocol })).digest));
  assert.equal(protocols.size, 3);
});

test('quote functions refuse raw or tampered profiles', () => {
  const raw = profileInput();
  rejects(() => knownUsageCost(raw, usage()), 'PRICE_PROFILE_INVALID');
  rejects(() => quoteRequestReservation(raw, { inputUpperBound: 1, outputCap: 1 }), 'PRICE_PROFILE_INVALID');

  const profile = normalizePriceProfile(profileInput());
  rejects(() => knownUsageCost({ ...profile, rates: { ...profile.rates, input: 1 } }, usage()), 'PRICE_PROFILE_INVALID');
  rejects(() => knownUsageCost({ ...profile, digest: '0'.repeat(64) }, usage()), 'PRICE_PROFILE_INVALID');
  rejects(() => knownUsageCost({ ...profile, apiKey: 'not-allowed' }, usage()), 'PRICE_PROFILE_INVALID');
  rejects(() => normalizePriceProfile({ ...profile, revision: 2 }), 'PRICE_PROFILE_INVALID');
});

test('a persisted snapshot survives JSON round trips while its digest stays binding', () => {
  const profile = normalizePriceProfile(profileInput());
  const restored = JSON.parse(JSON.stringify(profile));
  assert.deepEqual(restored, profile);
  assert.equal(knownUsageCost(restored, usage({ input: 1000 })).amountMicro, 150);
  assert.equal(quoteRequestReservation(restored, { inputUpperBound: 1000, outputCap: 0 }).amountMicro, 150);

  restored.rates.input = 1;
  rejects(() => knownUsageCost(restored, usage({ input: 1000 })), 'PRICE_PROFILE_INVALID');
});
