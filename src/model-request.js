import { invokeModelFetch } from './model-fetch-boundary.js';
/**
 * One accounting-aware boundary for a real model request.
 *
 * Both the classic single-call path and every turn of the tool loop use this
 * helper so a request cannot drift into a second, unaccounted transport path.
 *
 * Scope and task id are explicit, trusted per-call values supplied by the
 * caller. They are local control parameters: they never enter the wire payload
 * or the prompt, and this module never infers them from a request id, model
 * output or shared mutable state.
 *
 * Sequence for one request:
 *
 *   prepare (one adapter attempt, complete wire payload)
 *   local cancellation checks
 *   markDispatched (the single network permit)
 *   fetch (no await between the marker and the call)
 *   bounded read and JSON parse
 *   settle usage before any model content is used
 *
 * A failure before dispatch cancels the attempt; any failure after dispatch
 * keeps the hold by marking it unknown. A settled attempt is never failed
 * afterwards, so a content or protocol error cannot overwrite a real
 * settlement. Settlement failures surface as accounting errors instead of
 * being swallowed and allowing the model content to be used.
 */

import { readTextBounded } from './bounded.js';
import { responseUsage } from './model-protocol.js';
import { fallbackCandidate } from './model-routing.js';
import { isModelControlFailure } from './model-control.js';
import { assertModelRpcPermit } from './model-rpc-permit.js';
export { createModelRpcPermit } from './model-rpc-permit.js';

const SCOPES = new Set(['workspace', 'task']);
const nativeCurrentChecks = new WeakMap();
const nativeRouting = new WeakMap();

/** Stage/route state is a native capability, never a JSON context property. */
export function brandModelStage(context, stage = 'general', routing = null) {
  if (!Object.isFrozen(context) || !['interpret','discovery','planning','verification','general'].includes(stage)) throw contextError('A native model stage is required.');
  nativeRouting.set(context, { stage, snapshot: routing, state: { model: null, fallbackUsed: false } });
  return context;
}
/** Connection validation tests the proposed model, independent of an older group. */
export function directModelRoutingContext(context) {
  const normalized = requireSessionAccountingContext(context);
  if (normalized.scope !== 'workspace' || normalized.session) throw contextError('Direct connection checks require plain workspace scope.');
  nativeRouting.set(normalized, { stage: 'verification', direct: true, snapshot: null, state: { model: null, fallbackUsed: false } });
  return normalized;
}
export function modelRoutingState(reasoner, context) {
  let metadata = context && nativeRouting.get(context);
  if (!metadata) {
    metadata = { stage: 'general', snapshot: null, state: { model: null, fallbackUsed: false } };
    if (context && Object.isFrozen(context)) nativeRouting.set(context, metadata);
  }
  if (!metadata.direct && !metadata.snapshot && reasoner?.modelRouting) metadata.snapshot = reasoner.modelRouting.snapshot(metadata.stage);
  const route = metadata.snapshot?.route;
  const active = reasoner?.reasoningSessions?.classicTurnHandle?.();
  const selection = active?.session?.conversation?.routingSelection;
  const selectedFallback = Boolean(selection && route && selection.version === metadata.snapshot?.version && selection.digest === route.digest
    && selection.model === route.fallbackModel);
  const storedModel = selectedFallback ? selection.model : active ? reasoner.reasoningSessions.read({ id: active.id })?.model : null;
  if (route && storedModel === route.fallbackModel && storedModel !== route.model) {
    metadata.state.model = storedModel; metadata.state.fallbackUsed = true;
  }
  if (!metadata.state.model && route) metadata.state.model = route.model;
  return metadata;
}


/** Native local capability: never inferred from a user/model object field. */
export function guardModelContext(context, isCurrent) {
  if (!context || typeof context !== 'object' || !Object.isFrozen(context) || typeof isCurrent !== 'function') {
    throw contextError('A native model guard requires frozen context and a synchronous current check.');
  }
  nativeCurrentChecks.set(context, isCurrent);
  return context;
}
function inheritCurrentCheck(original, normalized) {
  const routing = nativeRouting.get(original);
  if (routing) nativeRouting.set(normalized, routing);
  const check = nativeCurrentChecks.get(original);
  if (check) nativeCurrentChecks.set(normalized, check);
  return normalized;
}
function assertModelCurrent(context) {
  const check = context && nativeCurrentChecks.get(context);
  if (!check) return;
  const current = check();
  if (current && typeof current.then === 'function') {
    Promise.resolve(current).catch(() => {});
    throw contextError('Native model current checks must be synchronous.');
  }
  if (current !== true) throw Object.assign(new Error('The model invocation context is no longer current.'),
    { code: 'CONTEXT_CHANGED', status: 503, definitiveNoEffect: true });
}

function contextError(message) {
  const error = new Error(message);
  error.code = 'TOKEN_ACCOUNTING_CONTEXT';
  return error;
}

/**
 * Validate the explicit per-call accounting context. Every semantic method
 * takes this as its own argument when a TokenBudgetService is injected; a
 * missing or malformed value is a local wiring error, never an implicit scope.
 */
export function requireAccountingContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw contextError("Token accounting is enabled, so this call requires an explicit context { scope: 'workspace' } or { scope: 'task', taskId }.");
  }
  const { scope, taskId } = context;
  if (!SCOPES.has(scope)) {
    throw contextError("Token accounting context.scope must be 'workspace' or 'task'.");
  }
  if (scope === 'workspace') {
    if (taskId !== undefined && taskId !== null) {
      throw contextError('Workspace-scoped token accounting does not accept a taskId.');
    }
    return inheritCurrentCheck(context, Object.freeze({ scope: 'workspace', taskId: null }));
  }
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw contextError('Task-scoped token accounting requires a trusted non-empty taskId from the caller context.');
  }
  return inheritCurrentCheck(context, Object.freeze({ scope: 'task', taskId }));
}

/** Keep the private session while preserving the native dispatch guard across
 * normalization. A plain spread loses WeakMap capabilities. */
export function requireSessionAccountingContext(context) {
  const normalized = requireAccountingContext(context);
  return context?.session ? inheritCurrentCheck(normalized, Object.freeze({ ...normalized, session: context.session })) : normalized;
}

function defaultHttpError(status) {
  return Object.assign(new Error(`Model provider returned ${status}`), { status });
}

/**
 * Perform one accounted request and return the parsed JSON body.
 *
 * `accounting` is a TokenRequestAccounting or null. When null the helper keeps
 * the previous transport behaviour: an HTTP error is thrown before its body is
 * read. When accounting is active an error response body is still read in a
 * bounded way so a provider-reported usage is settled instead of discarded.
 */
async function requestModelJsonOnce({
  accounting = null,
  context = null,
  protocol,
  payload,
  fetchImpl,
  url,
  headers,
  signal = null,
  maxResponseChars,
  label = 'Reasoning response',
  httpError = null,
  onDispatch = null,
  onAttemptResponse = null,
  onProviderFetch = null
} = {}) {
  const makeHttpError = response => typeof httpError === 'function'
    ? httpError(response?.status, response)
    : defaultHttpError(response?.status);

  // A caller that enabled accounting without a valid explicit context is a
  // wiring error: refuse locally before reserving anything.
  const scope = accounting ? requireAccountingContext(context) : null;

  let attempt = null;
  let settled = false, accountingOutcome = null;

  // Keep the hold whenever an attempt exists and has not reached a terminal
  // settled outcome. `fail` cancels a prepared attempt and marks a dispatched
  // one unknown, which is the conservative choice for every failure below.
  const retainHold = error => {
    if (!accounting || attempt === null || settled) return error;
    try {
      accounting.fail(attempt);
    } catch (failure) {
      try {
        if (error !== null && typeof error === 'object') {
          error.accountingFailure = failure?.code ?? failure?.message ?? 'UNKNOWN';
        }
      } catch { /* a frozen error still propagates unchanged */ }
    }
    return error;
  };

  assertModelCurrent(context);
  let body;
  if (accounting) {
    // A failed prepare throws inside its own transaction, so no reservation is
    // left behind. The caller's payload is never modified; the returned clone
    // is what goes on the wire.
    const prepared = accounting.prepare({
      protocol,
      payload,
      scope: scope.scope,
      taskId: scope.taskId
    });
    attempt = prepared.attempt;
    try {
      body = JSON.stringify(prepared.payload);
    } catch (error) {
      throw retainHold(error);
    }
  } else {
    body = JSON.stringify(payload);
  }

  // Local cancellation checks run after prepare but before the network permit.
  // An attempt that never reached the network is cancelled rather than held.
  try {
    signal?.throwIfAborted();
    assertModelCurrent(context);
  } catch (error) {
    throw retainHold(error);
  }

  if (accounting) {
    try {
      accounting.markDispatched(attempt);
    } catch (error) {
      throw retainHold(error);
    }
  }

  // The call counter observes only requests that received the network permit,
  // not ones refused locally by a budget or a wiring check.
  try {
    onDispatch?.();
  } catch (error) {
    throw retainHold(error);
  }

  // No await between the dispatch marker and the fetch invocation: the permit
  // belongs to this call only and cannot be reused by a later request.

  let response;
  try {
    response = await invokeModelFetch(fetchImpl, url, { method: 'POST', headers, body, signal }, onProviderFetch);
  } catch (error) {
    throw retainHold(error);
  }

  const ok = Boolean(response && response.ok);
  if (!ok && !accounting) throw makeHttpError(response);

  let parsedBody = null;
  let readError = null;
  try {
    const readable = typeof response?.text === 'function'
      || typeof response?.body?.getReader === 'function';
    parsedBody = readable
      ? JSON.parse(await readTextBounded(response, maxResponseChars, label))
      : await response.json();
  } catch (error) {
    readError = error;
  }

  // Settle before returning the body: callers use the model content only after
  // the usage decision has been made. Missing or untrusted usage marks the
  // whole hold unknown; it is never mapped to a trusted zero.
  if (accounting && !settled) {
    try {
      accountingOutcome = accounting.settleResponse(attempt, { protocol, body: parsedBody });
      settled = true;
    } catch (error) {
      // A settlement failure keeps the hold conservative and must surface:
      // continuing with the model content would let a ledger failure bypass
      // accounting.
      retainHold(error);
      throw error;
    }
  }

  // Observations follow authoritative settlement and include failed provider
  // responses. Unknown usage is never emitted as a trusted zero.
  try { onAttemptResponse?.({ body: parsedBody, accountingOutcome, ok, status: response?.status }); } catch { /* observation cannot change a settled request */ }

  if (!ok) {
    const error = makeHttpError(response);
    if (readError !== null) {
      try { error.readError = readError?.code ?? readError?.message ?? 'UNREADABLE'; }
      catch { /* the HTTP error still propagates */ }
    }
    throw error;
  }
  if (readError !== null) throw readError;
  return parsedBody;
}

function classifyRoutingFailure(error) {
  if (!error) return null;
  if (error?.name === 'AbortError') return 'cancelled';
  if (/^(TOKEN|MONEY)_/.test(error?.code || '')) return 'accounting';
  if (/^(SESSION|CONTEXT|LEASE|PRIVACY)/.test(error?.code || '')) return 'context';
  if ([401,402,403,407,511].includes(Number(error?.status))) return 'auth';
  if (Number(error?.status) === 429) return 'rate_limit';
  if (Number(error?.status) >= 400) return 'provider';
  if (['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH'].includes(error?.code)) return 'transport';
  if (error instanceof SyntaxError) return 'response';
  return 'other';
}

function fallbackFailure(error, dispatched, signal, toolsStarted) {
  if (!dispatched || isModelControlFailure(error) || signal?.aborted || error?.name === 'AbortError'
    || error?.ambiguous || error?.writeOutcomeUnknown || error?.accountingFailure != null) return null;
  const status = Number(error?.status), code = typeof error?.code === 'string' ? error.code : undefined;
  let failureKind = null;
  if ([408,425,429,500,502,503,504].includes(status)) failureKind = 'provider_transient';
  else if ([501].includes(status) || ['CAPABILITY_UNSUPPORTED','UNSUPPORTED_CAPABILITY','MODEL_UNSUPPORTED','UNSUPPORTED_MODEL','FUNCTION_CALLING_UNSUPPORTED'].includes(code)) failureKind = 'capability_unsupported';
  else if (['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH'].includes(code)
    || error?.name === 'TypeError' && error.message === 'fetch failed') failureKind = 'transport';
  if (!failureKind) return null;
  return { failureKind, ...(Number.isInteger(status) && status >= 100 ? { status } : {}), ...(code ? { code } : {}), attempts: 1, toolsStarted, signal };
}

/** One route and, only when explicitly enabled, one separately metered fallback.
 * The caller keeps ownership of its initial permit; fallback swaps it through
 * the same controller and the caller's finally releases only what it owns. */
export async function requestModelJson(options = {}) {
  const { reasoner = null, rpcPermit = null, toolsStarted = 0 } = options;
  const metadata = modelRoutingState(reasoner, options.context), snapshot = metadata.snapshot, route = snapshot?.route;
  const ensureRoute = () => {
    if (snapshot && reasoner?.modelRouting && !reasoner.modelRouting.isCurrent(snapshot)) {
      throw Object.assign(new Error('The model routing group changed before dispatch.'), { code: 'CONTEXT_CHANGED', status: 503, definitiveNoEffect: true });
    }
  };
  const send = async model => {
    let dispatched = false, start = null, attemptOutcome = null, caught = null;
    const metrics = reasoner?.modelRoutingMetrics;
    try {
      ensureRoute();
      return await requestModelJsonOnce({ ...options, payload: model ? { ...options.payload, model } : options.payload,
        onDispatch: () => { dispatched = true; metadata.state.model = model; options.onDispatch?.(); },
        onProviderFetch: () => { if (metrics) { try { start = metrics.start(); } catch (error) { try { metrics.noteFailure?.(error); } catch { /* advisory only */ } } } },
        onAttemptResponse: ({ body, accountingOutcome, ok, status }) => {
          attemptOutcome = { ok, status, usage: accountingOutcome?.state === 'settled' ? accountingOutcome.actual : null };
          const known = options.accounting ? accountingOutcome?.state === 'settled' : Boolean(body?.usage);
          if (known) reasoner?.reportUsage?.({ ...responseUsage(options.protocol, body), model }, options.requestId);
        } });
    } catch (error) { caught = error; return Promise.reject({ error, dispatched }); }
    finally {
      if (start) {
        try { metrics.finish(start, { stage: metadata.stage, routingVersion: snapshot?.version || 0, routingDigest: snapshot?.digest || null,
          model, protocol: options.protocol, fallback: metadata.state.fallbackUsed && model === route?.fallbackModel,
          success: !caught, failureClass: classifyRoutingFailure(caught), httpStatus: attemptOutcome?.status ?? caught?.status,
          usage: attemptOutcome?.usage || null }); }
        catch (error) { try { metrics.noteFailure?.(error); } catch { /* advisory only */ } }
      }
    }
  };
  const initialModel = metadata.state.model || route?.model || options.payload?.model;
  try { return await send(initialModel); }
  catch (failed) {
    const failure = fallbackFailure(failed.error, failed.dispatched, options.signal, toolsStarted);
    const fallback = snapshot?.maxRpcAttempts === 2 && !metadata.state.fallbackUsed && failure ? fallbackCandidate(route, failure) : null;
    if (!fallback || !rpcPermit) throw failed.error;
    assertModelRpcPermit(rpcPermit, reasoner);
    metadata.state.fallbackUsed = true;
    metadata.state.model = fallback.model;
    const active = reasoner?.reasoningSessions?.classicTurnHandle?.();
    const conversation = metadata.state.conversation || active?.session?.conversation;
    if (active && conversation) {
      conversation.routingSelection = { version: snapshot.version, digest: route.digest, model: fallback.model };
      reasoner.reasoningSessions.saveConversation({ id: active.id, owner: active.owner, claimId: active.claimId, isCurrent: active.isCurrent,
        conversation, turn: active.session.turn, calls: active.session.calls });
    }
    await rpcPermit.next();
    ensureRoute();
    try { return await send(fallback.model); } catch (second) { throw second.error; }
  }
}

export const modelRequestApi = { requireAccountingContext, requestModelJson };
