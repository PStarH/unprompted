// Stable, actionable connection states. Never echo provider response bodies,
// credentials or raw OAuth diagnostics into the public setup response.
export function googleConnectionIssue(error) {
  const message = String(error || '');
  if (!message) return null;
  if (/401|invalid_grant|expired or revoked|re-?authori[sz]|token refresh failed with 400/i.test(message)) {
    return { code: 'GOOGLE_RECONNECT', action: 'reauthorize' };
  }
  if (/API_DISABLED|SERVICE_DISABLED|accessNotConfigured/i.test(message)) {
    return { code: 'GOOGLE_API_DISABLED', action: 'enable_api' };
  }
  if (/403|scope|permission/i.test(message)) return { code: 'GOOGLE_ACCESS_DENIED', action: 'review_access' };
  if (/429|rate limit/i.test(message)) return { code: 'GOOGLE_RATE_LIMITED', action: 'retry' };
  if (/timed out|timeout|reach|network|fetch failed|5\d\d/i.test(message)) return { code: 'GOOGLE_UNREACHABLE', action: 'retry' };
  return { code: 'GOOGLE_SYNC_FAILED', action: 'retry' };
}
