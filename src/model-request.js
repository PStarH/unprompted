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

const SCOPES = new Set(['workspace', 'task']);

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
    return Object.freeze({ scope: 'workspace', taskId: null });
  }
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw contextError('Task-scoped token accounting requires a trusted non-empty taskId from the caller context.');
  }
  return Object.freeze({ scope: 'task', taskId });
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
export async function requestModelJson({
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
  onDispatch = null
} = {}) {
  const makeHttpError = response => typeof httpError === 'function'
    ? httpError(response?.status, response)
    : defaultHttpError(response?.status);

  // A caller that enabled accounting without a valid explicit context is a
  // wiring error: refuse locally before reserving anything.
  const scope = accounting ? requireAccountingContext(context) : null;

  let attempt = null;
  let settled = false;

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
    response = await fetchImpl(url, { method: 'POST', headers, body, signal });
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
      accounting.settleResponse(attempt, { protocol, body: parsedBody });
      settled = true;
    } catch (error) {
      // A settlement failure keeps the hold conservative and must surface:
      // continuing with the model content would let a ledger failure bypass
      // accounting.
      retainHold(error);
      throw error;
    }
  }

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

export const modelRequestApi = { requireAccountingContext, requestModelJson };
