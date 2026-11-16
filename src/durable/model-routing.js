import { durableError } from './database.js';
import { normalizeRoutingConfig, routeFor } from '../model-routing.js';

const KEY = 'model_routing_policy';
const invalid = message => durableError('INVALID_MODEL_ROUTING', message, 400);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const rawConfig = normalized => normalized && ({ modelIds: [...normalized.modelIds], defaultModel: normalized.defaultModel,
  stages: { ...normalized.stages }, ...(normalized.fallbackModel ? { fallbackModel: normalized.fallbackModel } : {}) });
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

/** One workspace routing policy; group entries cannot carry provider credentials. */
export class ModelRoutingService {
  constructor(database) {
    if (typeof database?.atomic !== 'function' || typeof database.get !== 'function') throw invalid('Routing requires the durable workspace database.');
    this.database = database;
  }
  get() {
    const encoded = this.database.get(KEY, null);
    if (encoded == null) return freeze({ version: 0, config: null, maxRpcAttempts: 1, requestCallLimit: 1, digest: null });
    let stored;
    try { stored = JSON.parse(encoded); } catch { throw invalid('The stored routing policy is invalid.'); }
    if (!plain(stored) || !Number.isSafeInteger(stored.version) || stored.version < 1 || ![1, 2].includes(stored.maxRpcAttempts) || ![1,2].includes(stored.requestCallLimit ?? 1)) throw invalid('The stored routing policy is invalid.');
    let normalized;
    try { normalized = normalizeRoutingConfig(stored.config); } catch { throw invalid('The stored routing group is invalid.'); }
    return freeze({ version: stored.version, config: rawConfig(normalized), maxRpcAttempts: stored.maxRpcAttempts, requestCallLimit: stored.requestCallLimit ?? 1, digest: normalized?.digest || null });
  }
  configure(input = {}) {
    if (!plain(input) || Object.keys(input).some(key => !['expectedVersion', 'config', 'maxRpcAttempts', 'requestCallLimit'].includes(key))
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !Object.hasOwn(input, 'config')) throw invalid('Supply a routing group and its current expectedVersion.');
    if (input.maxRpcAttempts !== undefined && ![1, 2].includes(input.maxRpcAttempts)) throw invalid('maxRpcAttempts must be explicitly 1 or 2.');
    if (input.requestCallLimit !== undefined && ![1,2].includes(input.requestCallLimit)) throw invalid('requestCallLimit must be explicitly 1 or 2.');
    let normalized;
    try { normalized = normalizeRoutingConfig(input.config); } catch (error) { throw invalid(error.message); }
    return this.database.atomic(() => {
      const current = this.get();
      if (current.version !== input.expectedVersion) throw durableError('MODEL_ROUTING_CHANGED', 'The routing group changed; reload before saving.', 409);
      if (current.version >= Number.MAX_SAFE_INTEGER) throw invalid('The routing revision cannot advance safely.');
      const next = { version: current.version + 1, config: rawConfig(normalized), maxRpcAttempts: input.maxRpcAttempts ?? current.maxRpcAttempts,
        requestCallLimit: input.requestCallLimit ?? current.requestCallLimit };
      if (next.maxRpcAttempts > next.requestCallLimit) throw invalid('Fallback needs explicit permission for two classic model calls, including fallback.');
      if (current.digest === (normalized?.digest || null) && current.maxRpcAttempts === next.maxRpcAttempts && current.requestCallLimit === next.requestCallLimit) return current;
      this.database.set(KEY, JSON.stringify(next));
      return this.get();
    });
  }
  snapshot(stage = 'general') {
    const view = this.get();
    return Object.freeze({ ...view, route: routeFor(normalizeRoutingConfig(view.config), stage) });
  }
  isCurrent(snapshot) {
    const current = this.get();
    return current.version === snapshot.version && current.digest === snapshot.digest && current.maxRpcAttempts === snapshot.maxRpcAttempts && current.requestCallLimit === snapshot.requestCallLimit;
  }
}

const originalRequestLimits = new WeakMap();
/** Explicit classic-call policy override. Never resets live counters or queues;
 * disabling the group restores this native budget's original caller limit. */
export function applyModelRequestLimit(reasoner, policy) {
  const budget = reasoner?.budget;
  if (!budget?.limits || !Number.isSafeInteger(budget.limits.maxCallsPerRequest) || budget.limits.maxCallsPerRequest < 1) throw invalid('A native model rate budget is required.');
  if (!originalRequestLimits.has(budget)) originalRequestLimits.set(budget, budget.limits.maxCallsPerRequest);
  if (policy?.config && ![1,2].includes(policy.requestCallLimit)) throw invalid('An explicit classic request-call limit is required.');
  budget.limits.maxCallsPerRequest = policy?.config ? policy.requestCallLimit : originalRequestLimits.get(budget);
  return budget.limits.maxCallsPerRequest;
}
