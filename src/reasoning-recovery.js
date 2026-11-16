import { isModelBudgetExhausted } from './model-control.js';

// Recovery applies only to bounded reasoning admission, never provider writes.
export const REASONING_RECOVERY = Object.freeze({ baseDelayMs: 30_000, maxDelayMs: 120_000, maxProviderDelayMs: 86_400_000, maxStartsPerSweep: 2 });

export function effectiveReasoningAttempts(work = {}) {
  const attempts = Number(work.attempts || 0), deferrals = Number(work.budgetDeferrals || 0);
  return Number.isSafeInteger(attempts) && Number.isSafeInteger(deferrals) && attempts >= 0 && deferrals >= 0 && deferrals <= attempts
    ? attempts - deferrals : Infinity;
}

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - Number(now)) : null;
}

export function reasoningFailure(error, work, now = Date.now()) {
  const budgetDeferrals = Number(work.budgetDeferrals || 0);
  if (error?.ambiguous || error?.writeOutcomeUnknown || error?.code === 'SESSION_RECONCILIATION_REQUIRED') {
    return { failureKind: 'unknown_outcome', retryable: false, retryAt: null,
      terminalReason: 'reconciliation_required', budgetDeferrals, budget: null };
  }
  if (isModelBudgetExhausted(error)) {
    const blockedScopes = Array.isArray(error.detail?.blockedScopes)
      ? [...new Set(error.detail.blockedScopes.filter(value => ['workspace', 'task', 'lease'].includes(value)))] : [];
    const candidate = error.retryAt;
    const timed = !blockedScopes.includes('lease') && typeof candidate === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
      && Number.isFinite(Date.parse(candidate)) && Date.parse(candidate) > Number(now)
      && new Date(Date.parse(candidate)).toISOString() === candidate;
    return { status: 'budget_deferred', failureKind: 'budget', retryable: true, retryAt: timed ? candidate : null,
      terminalReason: null, budgetDeferrals: Math.min(Number(work.attempts), budgetDeferrals + 1),
      budget: { code: error.code, blockedScopes, resetsAt: timed ? candidate : null } };
  }
  const message = String(error?.message || 'Reasoning failed.');
  const status = Number(error?.status || error?.statusCode || message.match(/provider returned (\d{3})/i)?.[1]);
  let failureKind = 'permanent';
  if (error?.name === 'SyntaxError' || status >= 400 && status < 500 && ![408, 425, 429].includes(status)) failureKind = 'permanent';
  else if (status === 429 || (error?.code === 'REASONING_BUDGET' && /rate limit/i.test(message))) failureKind = 'rate_limit';
  else if (/^SQLITE_(BUSY|LOCKED)/.test(error?.code || '')) failureKind = 'store_transient';
  else if ([408, 425].includes(status) || status >= 500 && status <= 599) failureKind = 'provider_transient';
  else if (['AbortError', 'TimeoutError'].includes(error?.name) || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/.test(error?.code || '') || /timed?\s*out|timeout|fetch failed|network (?:error|failure)/i.test(message)) failureKind = 'transport';
  else if (error?.code === 'REASONING_BUDGET' && /queue|concurrency|admission limit/i.test(message)) failureKind = 'capacity';
  const retryable = failureKind !== 'permanent';
  const exhausted = effectiveReasoningAttempts(work) >= Math.min(3, Number(work.maxAttempts) || 2);
  const baseDelay = failureKind === 'rate_limit' ? 60_000
    : Math.min(REASONING_RECOVERY.maxDelayMs, REASONING_RECOVERY.baseDelayMs * 2 ** Math.max(0, effectiveReasoningAttempts(work) - 1));
  const providerDelay = Number(error?.retryAfterMs);
  const delay = Math.max(baseDelay, Number.isFinite(providerDelay) && providerDelay >= 0 ? providerDelay : 0);
  const exceedsWindow = delay > REASONING_RECOVERY.maxProviderDelayMs;
  return {
    failureKind, retryable, budgetDeferrals, budget: null,
    retryAt: retryable && !exhausted && !exceedsWindow ? new Date(Number(now) + delay).toISOString() : null,
    terminalReason: exhausted ? 'attempts_exhausted' : !retryable ? 'non_retryable' : exceedsWindow ? 'provider_delay_exceeds_window' : null
  };
}

export function reasoningMayResume(work, now = Date.now(), { automatic = false, budgetWake = false } = {}) {
  if (!work || !['not_started', 'pending', 'running', 'failed', 'budget_deferred'].includes(work.status)) return false;
  if (effectiveReasoningAttempts(work) >= Math.min(3, Number(work.maxAttempts) || 2)) return false;
  if (work.status === 'budget_deferred') {
    if (budgetWake) return true;
    return work.retryAt != null && Number.isFinite(Date.parse(work.retryAt)) && Date.parse(work.retryAt) <= Number(now);
  }
  if (work.status !== 'failed') return true;
  if (work.retryable === false || work.terminalReason) return false;
  if (work.retryAt != null) return Number.isFinite(Date.parse(work.retryAt)) && Date.parse(work.retryAt) <= Number(now);
  // Old checkpoints without a retry policy retain bounded startup/manual recovery.
  return !automatic;
}
