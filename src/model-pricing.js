import { createHash } from 'node:crypto';
import { MODEL_PROTOCOLS } from './model-protocol.js';

/**
 * Model/API fee quote core.
 *
 * Rates are user-confirmed integers in micro-currency per 1,000,000 tokens
 * (1 micro = 1e-6 of the currency's major unit). A profile binds one trusted
 * provider connection (`providerId`), one existing wire protocol, one model,
 * one supported currency and one positive revision. All four canonical rate
 * components are required: a missing rate is unknown, never free. This module
 * never fetches market prices and never converts currencies.
 *
 * `knownUsageCost` prices complete, trusted token usage. Missing, partial or
 * malformed usage throws "PRICE_USAGE_UNKNOWN"; a complete explicit zero
 * usage is a known zero cost.
 *
 * `quoteRequestReservation` prices adapter-supplied `inputUpperBound` and
 * `outputCap` tokens. When cache attribution is unknown, every input token is
 * charged at the most expensive of the input, cache-read and cache-write
 * rates. Components are summed and rounded up once. All arithmetic is BigInt;
 * a result outside the safe integer range throws "PRICE_OVERFLOW" instead of
 * rounding, clamping or returning zero.
 *
 * A quote is not payment authorization, not a ledger hold and not a vendor
 * bill. It does not enforce limits, reserve funds, call a transport, persist
 * anything or mutate shared model state. Provider token caps, price changes,
 * cache TTL billing and routing fallbacks can make a real invoice differ; a
 * fallback candidate is never a permission to spend.
 */

export class ModelPricingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelPricingError';
    this.code = code;
  }
}

export const PRICE_CURRENCIES = Object.freeze(['USD', 'CNY', 'EUR']);
export const PRICE_COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);

const RATE_DENOMINATOR = BigInt(1_000_000);
const MAX_SAFE_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const PROFILE_FIELDS = Object.freeze(['providerId', 'protocol', 'model', 'currency', 'revision', 'rates']);
const SNAPSHOT_FIELDS = Object.freeze([...PROFILE_FIELDS, 'digest']);
const DIGEST_DOMAIN = 'unprompted.model-pricing.profile/v1';
const MAX_IDENTIFIER_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const profileInvalid = message => new ModelPricingError('PRICE_PROFILE_INVALID', message);
const estimateInvalid = message => new ModelPricingError('PRICE_ESTIMATE_INVALID', message);
const usageUnknown = message => new ModelPricingError('PRICE_USAGE_UNKNOWN', message);
const amountOverflow = message => new ModelPricingError('PRICE_OVERFLOW', message);

function objectInput(value, field, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(`${field} must be a plain object.`);
  return value;
}

function rejectUnknownKeys(value, allowed, field, error) {
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) throw error(`${field} contains an unsupported field: ${String(key)}.`);
  }
}

function requireOwn(value, field, key, error) {
  if (!Object.hasOwn(value, key)) throw error(`${field}.${key} is required.`);
  return value[key];
}

function identifier(value, field, error) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
    value.length > MAX_IDENTIFIER_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw error(`${field} must be a 1-${MAX_IDENTIFIER_LENGTH} character string without surrounding whitespace or control characters.`);
  }
  return value;
}

function rateValue(value, field, error) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw error(`${field} must be an explicit non-negative safe integer in micro-currency per 1,000,000 tokens.`);
  }
  return value;
}

function readProfileFields(input) {
  const providerId = identifier(requireOwn(input, 'Price profile', 'providerId', profileInvalid), 'providerId', profileInvalid);
  const protocol = requireOwn(input, 'Price profile', 'protocol', profileInvalid);
  if (!MODEL_PROTOCOLS.includes(protocol)) throw profileInvalid(`protocol must be one of ${MODEL_PROTOCOLS.join(', ')}.`);
  const model = identifier(requireOwn(input, 'Price profile', 'model', profileInvalid), 'model', profileInvalid);
  const currency = requireOwn(input, 'Price profile', 'currency', profileInvalid);
  if (!PRICE_CURRENCIES.includes(currency)) throw profileInvalid(`currency must be one of ${PRICE_CURRENCIES.join(', ')}.`);
  const revision = requireOwn(input, 'Price profile', 'revision', profileInvalid);
  if (!Number.isSafeInteger(revision) || revision <= 0) throw profileInvalid('revision must be a positive safe integer.');

  const rawRates = objectInput(requireOwn(input, 'Price profile', 'rates', profileInvalid), 'rates', profileInvalid);
  rejectUnknownKeys(rawRates, PRICE_COMPONENTS, 'rates', profileInvalid);
  const rates = {};
  for (const component of PRICE_COMPONENTS) {
    rates[component] = rateValue(requireOwn(rawRates, 'rates', component, profileInvalid), `rates.${component}`, profileInvalid);
  }
  return { providerId, protocol, model, currency, revision, rates };
}

function digestProfileFields(fields) {
  return createHash('sha256').update(JSON.stringify([
    DIGEST_DOMAIN,
    fields.providerId,
    fields.protocol,
    fields.model,
    fields.currency,
    fields.revision,
    fields.rates.input,
    fields.rates.output,
    fields.rates.cacheRead,
    fields.rates.cacheWrite
  ])).digest('hex');
}

/**
 * Validate one user-confirmed price profile and return a deeply frozen
 * normalized clone carrying its stable SHA-256 digest. The caller's object is
 * never frozen or modified. Passing an existing snapshot back in is allowed
 * when its digest still matches its contents.
 */
export function normalizePriceProfile(input) {
  objectInput(input, 'Price profile', profileInvalid);
  const hasDigest = Object.hasOwn(input, 'digest');
  rejectUnknownKeys(input, hasDigest ? SNAPSHOT_FIELDS : PROFILE_FIELDS, 'Price profile', profileInvalid);
  const fields = readProfileFields(input);
  const digest = digestProfileFields(fields);
  if (hasDigest && input.digest !== digest) throw profileInvalid('Price profile digest does not match its contents.');
  return Object.freeze({ ...fields, rates: Object.freeze(fields.rates), digest });
}

/** Quote functions consume an explicit snapshot, never an unvalidated object. */
function snapshotProfile(value) {
  objectInput(value, 'Price profile', profileInvalid);
  if (!Object.hasOwn(value, 'digest') || typeof value.digest !== 'string') {
    throw profileInvalid('A normalized price profile with a digest is required; call normalizePriceProfile first.');
  }
  return normalizePriceProfile(value);
}

function ceilAmount(totalMicro) {
  const amount = (totalMicro + RATE_DENOMINATOR - 1n) / RATE_DENOMINATOR;
  if (amount > MAX_SAFE_AMOUNT) throw amountOverflow('The quoted fee exceeds the safe integer micro-currency range.');
  return Number(amount);
}

function quoteResult(profile, amountMicro) {
  return Object.freeze({ amountMicro, currency: profile.currency, profileDigest: profile.digest });
}

/**
 * Price complete, trusted usage for one profile.
 *
 * Usage must carry all four components as own, non-negative safe integer token
 * counts. Anything else throws "PRICE_USAGE_UNKNOWN"; it never becomes a
 * trusted zero. Extra usage fields are ignored. The result is a frozen
 * `{ amountMicro, currency, profileDigest }` with one ceiling after summing.
 * Out-of-range results throw "PRICE_OVERFLOW".
 */
export function knownUsageCost(profile, usage) {
  const snapshot = snapshotProfile(profile);
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw usageUnknown('Usage is unknown: explicit input, output, cacheRead and cacheWrite tokens are required.');
  }
  let totalMicro = 0n;
  for (const component of PRICE_COMPONENTS) {
    if (!Object.hasOwn(usage, component)) throw usageUnknown(`Usage is unknown: ${component} tokens are required.`);
    const count = usage[component];
    if (!Number.isSafeInteger(count) || count < 0) throw usageUnknown(`Usage is unknown: ${component} must be a non-negative safe integer.`);
    totalMicro += BigInt(count) * BigInt(snapshot.rates[component]);
  }
  return quoteResult(snapshot, ceilAmount(totalMicro));
}

function estimateCount(estimate, field) {
  if (!Object.hasOwn(estimate, field)) throw estimateInvalid(`estimate.${field} is required from the transport adapter.`);
  const value = estimate[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw estimateInvalid(`estimate.${field} must be an explicit non-negative safe integer token count.`);
  }
  return value;
}

/**
 * Worst-case fee quote for one request reservation.
 *
 * `estimate.inputUpperBound` and `estimate.outputCap` must be explicit,
 * adapter-supplied, non-negative safe integers. Every input token is charged
 * at the maximum of the input, cache-read and cache-write rates (cache types
 * are alternatives, never summed); output tokens use the output rate. The sum
 * is rounded up once. The result is a frozen
 * `{ amountMicro, currency, profileDigest }`; out-of-range results throw
 * "PRICE_OVERFLOW". Whether the estimate is sufficient is the transport's
 * responsibility, not this core's.
 */
export function quoteRequestReservation(profile, estimate) {
  const snapshot = snapshotProfile(profile);
  if (!estimate || typeof estimate !== 'object' || Array.isArray(estimate)) {
    throw estimateInvalid('A reservation estimate with inputUpperBound and outputCap is required.');
  }
  const inputUpperBound = estimateCount(estimate, 'inputUpperBound');
  const outputCap = estimateCount(estimate, 'outputCap');
  const worstInputRate = Math.max(snapshot.rates.input, snapshot.rates.cacheRead, snapshot.rates.cacheWrite);
  const totalMicro = BigInt(worstInputRate) * BigInt(inputUpperBound) + BigInt(snapshot.rates.output) * BigInt(outputCap);
  return quoteResult(snapshot, ceilAmount(totalMicro));
}
