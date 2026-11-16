import { createHash } from 'node:crypto';

/**
 * Model routing policy core.
 *
 * This module validates a routing group and describes which model a caller
 * should use for a stage. It is a pure policy boundary: it does not read
 * environment variables or a model catalogue, does not call a provider, and
 * does not reserve budget, grant permission, mutate a shared reasoner or choose
 * models by inferred quality or price. Provider, base URL, protocol and
 * credentials belong to the later connection layer; a routing group cannot
 * switch accounts or endpoints.
 *
 * A fallback result is only candidate eligibility. The call layer must still
 * perform fresh accounting and dispatch for the second model; nothing here
 * authorises a network request. A configured `verification` mapping does not
 * mean a real verification model call exists: that wiring is A3.2 work.
 */

export const ROUTING_CONFIG_VERSION = 1;
export const ROUTING_STAGES = Object.freeze(['interpret', 'discovery', 'planning', 'verification', 'general']);
export const FALLBACK_FAILURE_KINDS = Object.freeze(['provider_transient', 'transport', 'capability_unsupported']);

const ROUTING_CONFIG_FIELDS = new Set(['modelIds', 'defaultModel', 'stages', 'fallbackModel']);
const NORMALIZED_FIELDS = new Set(['version', 'digest', 'modelIds', 'defaultModel', 'stages', 'fallbackModel']);
const FAILURE_FIELDS = new Set(['failureKind', 'status', 'code', 'attempts', 'toolsStarted', 'signal', 'aborted',
  'ambiguous', 'writeOutcomeUnknown', 'externalResultUnknown', 'outcomeUnknown']);
const MAX_MODEL_IDS = 8;
const MAX_MODEL_ID_LENGTH = 200;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const AUTH_STATUSES = new Set([401, 402, 403, 407, 511]);
// Error codes only narrow trusted classifications. A finite allowlist keeps
// new fee, authority, store or cancellation codes from being washed by a 503.
const FALLBACK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'SERVICE_UNAVAILABLE', 'RATE_LIMIT_EXCEEDED', 'UPSTREAM_ERROR', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT',
  'CAPABILITY_UNSUPPORTED', 'UNSUPPORTED_CAPABILITY', 'MODEL_UNSUPPORTED', 'UNSUPPORTED_MODEL',
  'TOOL_UNSUPPORTED', 'UNSUPPORTED_TOOL', 'FUNCTION_CALLING_UNSUPPORTED',
  '408', '425', '429', '500', '501', '502', '503', '504',
  'HTTP_408', 'HTTP_425', 'HTTP_429', 'HTTP_500', 'HTTP_501', 'HTTP_502', 'HTTP_503', 'HTTP_504'
]);

/** Snapshots issued by routeFor; fallbackCandidate may only consume these. */
const ISSUED_SNAPSHOTS = new WeakSet();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Own keys must be enumerable, string-named data properties: plain JSON only. */
function dataKeys(object, label) {
  const keys = [];
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') invalid(`${label} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor)) invalid(`${label} must contain only data properties`);
    if (!descriptor.enumerable) invalid(`${label} must contain only enumerable properties`);
    keys.push(key);
  }
  return keys;
}

function hasUnsafeControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1F || code >= 0x7F && code <= 0x9F || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function assertModelId(id, label) {
  if (typeof id !== 'string') invalid(`${label} must be a string model ID`);
  if (!id || id !== id.trim()) invalid(`${label} must be a non-empty, trimmed model ID`);
  if (id.length > MAX_MODEL_ID_LENGTH) invalid(`${label} must be at most ${MAX_MODEL_ID_LENGTH} characters`);
  if (hasUnsafeControl(id)) invalid(`${label} must not contain line breaks, NUL or control characters`);
}

function normalizeModelIds(value) {
  if (!Array.isArray(value)) invalid('modelIds must be an array');
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid('modelIds must be a plain array');
  if (value.length < 1 || value.length > MAX_MODEL_IDS) invalid(`modelIds must contain 1-${MAX_MODEL_IDS} model IDs`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) invalid('modelIds must be a dense array without extra properties');
  }
  const ids = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid('modelIds must be a dense array without extra properties');
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid('modelIds must contain enumerable data elements');
    const id = descriptor.value;
    assertModelId(id, `modelIds[${index}]`);
    if (seen.has(id)) invalid('modelIds must not contain duplicate model IDs');
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeStages(value, ids) {
  if (!isPlainObject(value)) invalid('stages must be a plain object');
  const stages = {};
  for (const stage of dataKeys(value, 'stages')) {
    if (!ROUTING_STAGES.includes(stage)) invalid('stages contains a stage outside the routing whitelist');
    const id = value[stage];
    assertModelId(id, 'stages entry');
    if (!ids.has(id)) invalid('stages entries must reference a model ID in modelIds');
    stages[stage] = id;
  }
  return stages;
}

function routingDigest(routing) {
  const stages = {};
  for (const stage of Object.keys(routing.stages).sort()) stages[stage] = routing.stages[stage];
  const canonical = JSON.stringify({
    version: routing.version,
    modelIds: routing.modelIds,
    defaultModel: routing.defaultModel,
    stages,
    fallbackModel: routing.fallbackModel
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Validate and clone a routing config.
 *
 * `null` (or an absent config) disables routing so the caller keeps its
 * existing single-model path. A configured group is cloned and deep-frozen;
 * the caller's object stays mutable and can never leak into routing state.
 * The digest identifies this normalized policy, not request payloads or
 * credentials, which are rejected as unknown fields.
 */
export function normalizeRoutingConfig(config) {
  if (config === null || config === undefined) return null;
  if (!isPlainObject(config)) invalid('Routing config must be a plain JSON object');
  for (const key of dataKeys(config, 'Routing config')) {
    if (!ROUTING_CONFIG_FIELDS.has(key)) invalid('Routing config contains an unsupported field');
  }
  if (!Object.hasOwn(config, 'modelIds')) invalid('Routing config requires modelIds');
  if (!Object.hasOwn(config, 'defaultModel')) invalid('Routing config requires defaultModel');
  const ids = normalizeModelIds(config.modelIds);
  const idSet = new Set(ids);
  if (typeof config.defaultModel !== 'string' || !idSet.has(config.defaultModel)) {
    invalid('defaultModel must reference a model ID in modelIds');
  }
  const stages = Object.hasOwn(config, 'stages') ? normalizeStages(config.stages, idSet) : {};
  let fallbackModel = null;
  if (Object.hasOwn(config, 'fallbackModel')) {
    if (typeof config.fallbackModel !== 'string' || !idSet.has(config.fallbackModel)) {
      invalid('fallbackModel must reference a model ID in modelIds');
    }
    fallbackModel = config.fallbackModel;
  }
  const modelIds = Object.freeze(ids);
  const frozenStages = Object.freeze(stages);
  const digest = routingDigest({ version: ROUTING_CONFIG_VERSION, modelIds, defaultModel: config.defaultModel, stages: frozenStages, fallbackModel });
  return Object.freeze({
    version: ROUTING_CONFIG_VERSION,
    digest,
    modelIds,
    defaultModel: config.defaultModel,
    stages: frozenStages,
    fallbackModel
  });
}

/**
 * Read a normalized config back without trusting a caller-built object.
 *
 * Re-normalizing and comparing the digest keeps routeFor on the validated
 * policy boundary; a raw config or a mutated/forged normalized object is a
 * programming error, not something to route around silently.
 */
function normalizedRouting(value) {
  if (!isPlainObject(value)) invalid('routeFor requires a normalized routing config');
  for (const key of dataKeys(value, 'Normalized routing config')) {
    if (!NORMALIZED_FIELDS.has(key)) invalid('Normalized routing config contains an unsupported field');
  }
  if (value.version !== ROUTING_CONFIG_VERSION) invalid('Unsupported routing config version');
  if (typeof value.digest !== 'string' || !DIGEST_PATTERN.test(value.digest)) invalid('Normalized routing config requires a valid digest');
  const config = { modelIds: value.modelIds, defaultModel: value.defaultModel, stages: value.stages };
  if (value.fallbackModel !== null) config.fallbackModel = value.fallbackModel;
  const recomputed = normalizeRoutingConfig(config);
  if (recomputed.digest !== value.digest) invalid('Normalized routing config digest does not match its contents');
  return recomputed;
}

/**
 * Return the immutable routing snapshot for one stage.
 *
 * Only exact whitelist stage names route to a stage mapping. Any other value —
 * an unknown stage, a request ID or model output passed by mistake — uses
 * `defaultModel`; it is never remapped through `general`. A whitelisted stage
 * without an explicit mapping also uses `defaultModel` while the snapshot
 * still records that normalized stage. A disabled config returns null so the
 * caller keeps its original model path.
 *
 * The module never reads or writes a shared reasoner: each call returns its
 * own frozen snapshot, so concurrent callers cannot select models through
 * shared mutable state.
 */
export function routeFor(routing, stage) {
  if (routing === null || routing === undefined) return null;
  const normalized = normalizedRouting(routing);
  const selectedStage = typeof stage === 'string' && ROUTING_STAGES.includes(stage) ? stage : 'default';
  const model = selectedStage !== 'default' && Object.hasOwn(normalized.stages, selectedStage)
    ? normalized.stages[selectedStage]
    : normalized.defaultModel;
  const snapshot = Object.freeze({
    version: normalized.version,
    digest: normalized.digest,
    stage: selectedStage,
    model,
    fallbackModel: normalized.fallbackModel
  });
  ISSUED_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function isRouteSnapshot(route) {
  return typeof route === 'object' && route !== null && ISSUED_SNAPSHOTS.has(route);
}

function deniedCode(code) {
  return !FALLBACK_CODES.has(String(code).toUpperCase());
}

/**
 * Copy only the trusted failure fields. Unknown string fields are ignored so
 * a raw error wrapper cannot smuggle values into routing state, while accessor
 * or symbol-keyed input is refused rather than executed.
 */
function failureRecord(failure) {
  const values = {};
  for (const key of dataKeys(failure, 'failure record')) {
    if (FAILURE_FIELDS.has(key)) values[key] = failure[key];
  }
  return values;
}

/**
 * Conservative fallback eligibility.
 *
 * `attempts` is the trusted count of model fetches already made for this work;
 * exactly one is required, which both proves the first model actually failed
 * and enforces at most one fallback (so the fallback model cannot have been
 * attempted already). `toolsStarted` must be explicitly zero: missing or
 * unknown tool state is refused, and reads count as tools. Only a trusted
 * failure classification can qualify; status/code can only narrow eligibility,
 * never upgrade a budget, accounting, authority, store, config or
 * authentication failure, even when it arrives as 429 or 503. An aborted
 * cancellation or timeout signal refuses fallback, and an unclassified or
 * malformed failure defaults to no fallback.
 */
function fallbackEligible(route, failure) {
  try {
    if (!isPlainObject(failure)) return false;
    const fields = failureRecord(failure);
    if (!FALLBACK_FAILURE_KINDS.includes(fields.failureKind)) return false;
    if (fields.attempts !== 1) return false;
    if (fields.toolsStarted !== 0) return false;
    if (fields.aborted !== undefined && fields.aborted !== false) return false;
    for (const key of ['ambiguous', 'writeOutcomeUnknown', 'externalResultUnknown', 'outcomeUnknown']) {
      if (Object.hasOwn(fields, key) && fields[key] !== false) return false;
    }
    const signal = fields.signal;
    if (signal !== undefined && signal !== null) {
      if (typeof signal !== 'object' || typeof signal.aborted !== 'boolean' || signal.aborted) return false;
    }
    if (fields.status !== undefined && fields.status !== null) {
      if (!Number.isInteger(fields.status) || fields.status < 100 || fields.status > 599) return false;
      if (AUTH_STATUSES.has(fields.status)) return false;
    }
    if (fields.code !== undefined && fields.code !== null) {
      const { code } = fields;
      if (!(typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code)))) return false;
      if (deniedCode(code)) return false;
    }
    return route.fallbackModel !== route.model;
  } catch {
    return false;
  }
}

/**
 * Return a fallback candidate snapshot, or null when no fallback is eligible.
 *
 * The candidate carries `requiresFreshAccounting: true`: it is not a permit,
 * not a budget reservation and not a retry instruction. The A3.2 call layer
 * must prepare, reserve and dispatch a new request for this model, and must
 * not reuse the failed attempt or skip its own budget checks. Raw errors,
 * messages and model output are never copied into the candidate, and a
 * candidate is not itself a route snapshot, so fallback cannot chain.
 */
export function fallbackCandidate(route, failure) {
  if (!isRouteSnapshot(route) || typeof route.fallbackModel !== 'string') return null;
  if (!fallbackEligible(route, failure)) return null;
  return Object.freeze({
    version: route.version,
    digest: route.digest,
    stage: route.stage,
    model: route.fallbackModel,
    requiresFreshAccounting: true
  });
}
