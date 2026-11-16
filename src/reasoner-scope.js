import { ModelRoutingMetrics } from './durable/model-routing-metrics.js';
import { ModelRoutingService, applyModelRequestLimit } from './durable/model-routing.js';
import { NullReasoner, OpenAiCompatibleReasoner, PiReasoner } from './reasoning.js';
import { TokenRequestAccounting } from './token-accounting.js';
import { ModelMoneyService, modelProviderIdentity } from './durable/model-money.js';

const modelMoneyBindings = new WeakMap();

// Preserve only the caller's original observer, never an engine-bound wrapper.
const originalUsage = new WeakMap();
export function rememberReasonerUsage(reasoner) {
  if (!originalUsage.has(reasoner)) originalUsage.set(reasoner, typeof reasoner.onUsage === 'function' ? reasoner.onUsage : null);
}

/** Configuration fork only. The caller supplies the new workspace's ledgers;
 * old accounting/session objects, mutable queues and Pi run history stay put. */
export function forkReasonerConfiguration(source, { tokenBudget = null, reasoningSessions = null } = {}) {
  if (!source || typeof source !== 'object') {
    throw Object.assign(new Error('A native model configuration is required.'), { code: 'MODEL_SCOPE_UNSUPPORTED', status: 409 });
  }
  rememberReasonerUsage(source);
  let fork;
  if (Object.getPrototypeOf(source) === NullReasoner.prototype) {
    fork = new NullReasoner(source.reason);
  } else {
    const isPi = Object.getPrototypeOf(source) === PiReasoner.prototype;
    if (!isPi && (Object.getPrototypeOf(source) !== OpenAiCompatibleReasoner.prototype || source.runtime)) {
      throw Object.assign(new Error('This custom model adapter needs its own workspace factory.'), { code: 'MODEL_SCOPE_UNSUPPORTED', status: 409 });
    }
    const options = { baseUrl: source.baseUrl, apiKey: source.apiKey, model: source.model, protocol: source.protocol,
      fetchImpl: source.fetchImpl, timeoutMs: source.timeoutMs, limits: { ...source.budget.limits },
      id: source.id, onUsage: originalUsage.get(source), tokenBudget, reasoningSessions };
    fork = isPi ? new PiReasoner({ ...options,
      runtimeOptions: { streamFn: source.runtime.streamFn, loadSdk: source.runtime.loadSdk } }) : new OpenAiCompatibleReasoner(options);
  }
  fork.preferModelInterpretation = source.preferModelInterpretation;
  originalUsage.set(fork, originalUsage.get(source));
  return fork;
}

// Bind only native transport implementations. Custom business adapters keep
// their own accounting contract; they are not certified by this boundary.
export function bindReasonerTokenBudget(reasoner, tokenBudget) {
  const prototype = reasoner && Object.getPrototypeOf(reasoner);
  if (![OpenAiCompatibleReasoner.prototype, PiReasoner.prototype].includes(prototype)) return reasoner;
  if ((reasoner.tokenBudget && reasoner.tokenBudget.database !== tokenBudget.database)
    || (reasoner.reasoningSessions && reasoner.reasoningSessions.database !== tokenBudget.database)) {
    throw Object.assign(new Error('The model adapter belongs to another workspace ledger.'), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  }
  const routing = new ModelRoutingService(tokenBudget.database);
  if (prototype === PiReasoner.prototype && routing.get().config) {
    throw Object.assign(new Error('Configured Routing Groups require the Standard harness; disable the group before choosing Pi.'),
      { code: 'MODEL_ROUTING_UNSUPPORTED_HARNESS', status: 409 });
  }
  const providerId = modelProviderIdentity(tokenBudget.database, reasoner);
  const previous = modelMoneyBindings.get(reasoner);
  if (reasoner.tokenBudget !== tokenBudget || previous?.providerId !== providerId || previous?.database !== tokenBudget.database) {
    const money = new ModelMoneyService(tokenBudget.database, { providerId });
    const accounting = new TokenRequestAccounting(tokenBudget, { money });
    reasoner.tokenBudget = tokenBudget;
    reasoner.accounting = accounting;
    reasoner.modelMoney = money;
    reasoner.modelRouting = routing;
    reasoner.modelRoutingMetrics = new ModelRoutingMetrics(tokenBudget.database);
    modelMoneyBindings.set(reasoner, { providerId, database: tokenBudget.database });
  }
  applyModelRequestLimit(reasoner, reasoner.modelRouting.get());
  return reasoner;
}

export function nativeClassicReasoner(reasoner) {
  return Boolean(reasoner && Object.getPrototypeOf(reasoner) === OpenAiCompatibleReasoner.prototype && !reasoner.runtime);
}
export function bindReasonerPrivateSessions(reasoner, sessions) {
  if (!nativeClassicReasoner(reasoner)) return;
  if (reasoner.reasoningSessions && reasoner.reasoningSessions.database !== sessions.database) {
    throw Object.assign(new Error('The private model service belongs to another workspace.'), { code: 'TOKEN_ACCOUNTING_CONTEXT' });
  }
  reasoner.reasoningSessions = sessions;
}
