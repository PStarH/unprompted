/**
 * Source health is public: it is rendered in the setup screen and returned by
 * `GET /api/setup`. Provider errors are not. This module turns an arbitrary
 * failure into (a) a bounded message with credentials, continuation tokens,
 * account identifiers and response bodies removed and (b) a fixed repair
 * classification the interface can offer without guessing from prose.
 *
 * The repair object is intentionally a closed vocabulary. Repeated identical
 * failures produce the same `{ code, action }`, so the interface can keep one
 * actionable notice instead of accumulating a new one per poll.
 */

const MAX_PUBLIC_ERROR = 500;

const SECRET_PATTERNS = [
  /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:account_?id|user_?id|tenant_?id|accountEmail)\s*[:=]\s*[^\s,;&]+/gi,
  // OAuth and provider credentials.
  /\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+)/g,
  /\b(?:xox[abprs]-[A-Za-z0-9-]+|ntn_[A-Za-z0-9]+)/g,
  /\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Authorization schemes and form bodies.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:client_secret|refresh_token|access_token|code|assertion)=[^&\s]+/gi,
  // Provider continuation parameters in URLs or prose.
  /\b(?:pageToken|page_token|nextPageToken|nextLink|deltaToken|syncToken|historyId|resumeUrl|since)=[^&\s,;]+/gi,
  // Opaque tokens long enough to be credentials rather than prose.
  /\b[A-Za-z0-9_-]{32,}\b/g,
  // Long numeric account identifiers (keep short HTTP status codes intact).
  /\b\d{12,}\b/g
];

// A URL is reduced to origin + path. Query strings routinely carry page
// tokens and signed continuation state.
function redactUrls(text) {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, raw => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch { return '[provider url]'; }
  });
}

/**
 * A public, bounded failure message. Existing human-readable provider messages
 * survive (tests and the diagnostics panel rely on substrings such as "401"),
 * but credentials, query strings, account identifiers and JSON response bodies
 * do not.
 */
export function publicFailureText(error, { max = MAX_PUBLIC_ERROR } = {}) {
  let text = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  if (!text) return null;
  text = redactUrls(text);
  // A provider body pasted into an error is not a health message.
  text = text.replace(/\{[\s\S]*\}/g, '[provider response omitted]');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function statusOf(value) {
  const status = Number(value?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function retryAfterMsOf(value) {
  const milliseconds = value?.retryAfterMs;
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  const raw = value?.retryAfter;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw * 1000;
  if (typeof raw === 'string' && raw.trim()) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

/**
 * Classify a failure for the repair action. Fixed vocabulary:
 *   reauthorize — the account grant is expired, revoked or missing a scope
 *   wait        — the provider asked us to slow down
 *   retry       — a transient transport or provider failure
 */
export function sourceRepair({ status = null, code = null, message = '', rateLimited = false, retryable = false } = {}) {
  const text = `${code || ''} ${message || ''}`;
  const httpStatus = Number.isFinite(Number(status)) ? Number(status) : null;
  if (httpStatus === 401 || /invalid_grant|expired or revoked|expired_token|re-?authori[sz]e|token refresh failed/i.test(text)) {
    return { code: 'SOURCE_RECONNECT', action: 'reauthorize' };
  }
  if (httpStatus === 403) {
    if (/API_DISABLED|SERVICE_DISABLED|accessNotConfigured/i.test(text)) return { code: 'SOURCE_API_DISABLED', action: 'retry' };
    return { code: 'SOURCE_ACCESS_DENIED', action: 'reauthorize' };
  }
  if (httpStatus === 429 || rateLimited || /rate limit|too many requests/i.test(text)) {
    return { code: 'SOURCE_RATE_LIMITED', action: 'wait' };
  }
  if (httpStatus === 408 || httpStatus === 504 || /timed out|timeout|unreachable|could not be reached|network|offline|fetch failed/i.test(text)) {
    return { code: 'SOURCE_UNREACHABLE', action: 'retry' };
  }
  if (retryable || httpStatus != null && httpStatus >= 500) return { code: 'SOURCE_UNAVAILABLE', action: 'retry' };
  return { code: 'SOURCE_SYNC_FAILED', action: 'retry' };
}

/** Repair classification for one connector failure result (pull or partial scope). */
export function repairForResult(result) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const rateLimited = result?.rateLimited === true || errors.some(error => error?.rateLimited === true || statusOf(error) === 429)
    || statusOf(result) === 429;
  const candidates = errors.map(error => sourceRepair({ status: statusOf(error), code: error?.code, message: error?.message,
    rateLimited: error?.rateLimited, retryable: error?.retryable }));
  candidates.push(sourceRepair({ status: statusOf(result), code: result?.code, message: result?.error,
    rateLimited, retryable: result?.retryable }));
  const rank = repair => repair.action === 'reauthorize' ? 0 : repair.code === 'SOURCE_API_DISABLED' ? 1 : repair.action === 'wait' ? 2 : repair.code === 'SOURCE_SYNC_FAILED' ? 4 : 3;
  return candidates.sort((a, b) => rank(a) - rank(b))[0];
}

/** The largest provider-requested retry delay in a sync outcome, if any. */
export function rateLimitDelay(outcome) {
  let delay = 0;
  for (const result of outcome?.results || []) {
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const limited = result?.rateLimited === true || statusOf(result) === 429 || errors.some(error => error?.rateLimited === true || statusOf(error) === 429);
    if (!limited) continue;
    const candidate = [result, ...errors].map(retryAfterMsOf).filter(value => Number.isFinite(value) && value > 0);
    if (candidate.length) delay = Math.max(delay, ...candidate);
  }
  return delay;
}

export const sourceHealthApi = { publicFailureText, sourceRepair, repairForResult, rateLimitDelay };

const REPAIR_ACTIONS = Object.freeze({ SOURCE_RECONNECT: 'reauthorize', SOURCE_ACCESS_DENIED: 'reauthorize', SOURCE_API_DISABLED: 'retry', SOURCE_RATE_LIMITED: 'wait', SOURCE_UNREACHABLE: 'retry', SOURCE_UNAVAILABLE: 'retry', SOURCE_SYNC_FAILED: 'retry' });
/** Public projection is an allowlist, including for imported legacy state. */
export function publicSourceHealth(record, { connected = false } = {}) {
  const repair = connected && Object.hasOwn(REPAIR_ACTIONS, record?.repair?.code) && REPAIR_ACTIONS[record.repair.code] === record.repair.action
    ? { code: record.repair.code, action: record.repair.action } : null;
  const at = Date.parse(record?.lastSyncAt || '');
  const delay = record?.retryAfterMs;
  const retryAt = repair?.action === 'wait' && Number.isFinite(at) && Number.isFinite(delay) && delay > 0
    ? new Date(at + Math.min(delay, 86400000)).toISOString() : null;
  return { healthy: connected && record ? record.ok === true && record.complete !== false : null,
    repair, retryAt, lastError: connected ? publicFailureText(record?.lastError) || null : null };
}
