/** Local admission, accounting and ownership failures must reach the durable
 * caller. A provider's ordinary HTTP failure may still use legacy fallback.
 * Classification never uses provider prose or model-generated content. */
export function isModelControlFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'AbortError' || error.ambiguous || error.writeOutcomeUnknown || error.accountingFailure != null) return true;
  const code = error.code;
  if (typeof code !== 'string') return false;
  return /^(?:TOKEN_(?:BUDGET|ACCOUNTING)|MONEY_(?:BUDGET|ACCOUNTING|PROFILE|CURRENCY|LEASE)|SESSION|SQLITE|STORE)(?:_|$)/.test(code)
    || /^INVALID_(?:TOKEN|MONEY|SESSION)(?:_|$)/.test(code)
    || /^MODEL_ROUTING(?:_|$)/.test(code)
    || ['LEASE_LOST', 'CONTEXT_CHANGED', 'PRIVACY_CHANGED', 'UNSUPPORTED_STORE', 'UNSUPPORTED_HARNESS'].includes(code);
}

export const isModelBudgetExhausted = error => !error?.ambiguous && !error?.writeOutcomeUnknown
  && ['TOKEN_BUDGET_EXHAUSTED', 'MONEY_BUDGET_EXHAUSTED', 'MONEY_PROFILE_REQUIRED', 'TOKEN_ACCOUNTING_STALE', 'MONEY_ACCOUNTING_STALE'].includes(error?.code);

export const modelFailureDetail = error => ['TOKEN_ACCOUNTING_STALE', 'MONEY_ACCOUNTING_STALE'].includes(error?.code)
  ? 'Model limits or prices changed before dispatch. Work is waiting to retry with current settings; nothing was sent by this attempt.'
  : error?.code === 'MONEY_PROFILE_REQUIRED'
  ? 'Model work is waiting for confirmed prices matching the connection, model, protocol and budget currency.'
  : isModelBudgetExhausted(error)
  ? 'Model budget is exhausted. Work is waiting for budget availability.'
  : String(error?.message || 'Model reasoning failed.').slice(0, 500);
