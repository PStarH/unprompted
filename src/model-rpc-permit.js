const permits = new WeakMap();
const error = message => Object.assign(new Error(message), { code: 'TOKEN_ACCOUNTING_CONTEXT' });

/** Owns exactly the permit the caller already acquired. Its finally path never
 * releases someone else's slot after a refused/aborted fallback acquisition. */
export function createModelRpcPermit({ budget, requestId, permit, signal = null, maxCalls = budget?.limits?.maxCallsPerRequest } = {}) {
  if (!budget || typeof budget.acquire !== 'function' || typeof budget.release !== 'function' || permit?.ok !== true
    || !Number.isSafeInteger(maxCalls) || maxCalls < 1) throw error('A model RPC controller needs the caller\'s acquired rate permit.');
  let held = true;
  const control = Object.freeze({
    async next() {
      if (!held) throw error('This RPC controller no longer owns a rate permit.');
      budget.release(requestId); held = false;
      const next = await budget.acquire(requestId, { signal, maxCalls });
      if (!next.ok) throw Object.assign(new Error(`Reasoning skipped: ${next.reason}`), { code: 'REASONING_BUDGET', status: 429, retryAfterMs: 60000 });
      held = true;
    },
    release() { if (held) { held = false; budget.release(requestId); } },
    isHeld() { return held; }
  });
  permits.set(control, { budget, requestId, maxCalls });
  return control;
}
export function assertModelRpcPermit(control, reasoner) {
  const record = permits.get(control);
  if (!record || record.budget !== reasoner?.budget || !control.isHeld()) throw error('Fallback requires the current native RPC rate permit.');
  return record;
}
