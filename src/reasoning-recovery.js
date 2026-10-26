// Recovery applies only to bounded read-only reasoning, never provider writes.
export const REASONING_RECOVERY = Object.freeze({ baseDelayMs: 30_000, maxDelayMs: 120_000, maxProviderDelayMs: 86_400_000, maxStartsPerSweep: 2 });

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - Number(now)) : null;
}

export function reasoningFailure(error, work, now = Date.now()) {
  const message = String(error?.message || 'Reasoning failed.');
  const status = Number(error?.status || error?.statusCode || message.match(/provider returned (\d{3})/i)?.[1]);
  let failureKind = 'permanent';
  if (error?.name === 'SyntaxError' || status >= 400 && status < 500 && ![408, 425, 429].includes(status)) failureKind = 'permanent';
  else if (status === 429 || (error?.code === 'REASONING_BUDGET' && /rate limit/i.test(message))) failureKind = 'rate_limit';
  else if ([408, 425].includes(status) || status >= 500 && status <= 599) failureKind = 'provider_transient';
  else if (['AbortError', 'TimeoutError'].includes(error?.name) || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/.test(error?.code || '') || /timed?\s*out|timeout|fetch failed|network (?:error|failure)/i.test(message)) failureKind = 'transport';
  else if (error?.code === 'REASONING_BUDGET' && /queue|concurrency|admission limit/i.test(message)) failureKind = 'capacity';
  const retryable = failureKind !== 'permanent';
  const exhausted = Number(work.attempts) >= Math.min(3, Number(work.maxAttempts) || 2);
  const baseDelay = failureKind === 'rate_limit' ? 60_000
    : Math.min(REASONING_RECOVERY.maxDelayMs, REASONING_RECOVERY.baseDelayMs * 2 ** Math.max(0, Number(work.attempts || 1) - 1));
  const providerDelay = Number(error?.retryAfterMs);
  const delay = Math.max(baseDelay, Number.isFinite(providerDelay) && providerDelay >= 0 ? providerDelay : 0);
  const exceedsWindow = delay > REASONING_RECOVERY.maxProviderDelayMs;
  return {
    failureKind, retryable,
    retryAt: retryable && !exhausted && !exceedsWindow ? new Date(Number(now) + delay).toISOString() : null,
    terminalReason: exhausted ? 'attempts_exhausted' : !retryable ? 'non_retryable' : exceedsWindow ? 'provider_delay_exceeds_window' : null
  };
}

export function reasoningMayResume(work, now = Date.now(), { automatic = false } = {}) {
  if (!work || !['not_started', 'pending', 'running', 'failed'].includes(work.status)) return false;
  if (Number(work.attempts || 0) >= Math.min(3, Number(work.maxAttempts) || 2)) return false;
  if (work.status !== 'failed') return true;
  if (work.retryable === false || work.terminalReason) return false;
  if (work.retryAt != null) return Number.isFinite(Date.parse(work.retryAt)) && Date.parse(work.retryAt) <= Number(now);
  // Old checkpoints without a retry policy retain bounded startup/manual recovery.
  return !automatic;
}
