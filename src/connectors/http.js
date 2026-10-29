import { ConnectorError } from './connector.js';
import { readTextBounded } from '../bounded.js';

/** Fixed-origin, bounded provider transport. Errors never echo response bodies. */
export async function providerJSON(url, { provider, origin, fetchImpl = globalThis.fetch, method = 'GET',
  headers = {}, form = null, body = null, signal = null, timeoutMs = 20_000, maxChars = 2_000_000,
  allowOAuthError = false, beforeRequest = null } = {}) {
  const target = new URL(url, origin);
  if (target.origin !== origin || target.username || target.password) throw new ConnectorError('Provider continuation URL has an unexpected origin.', { connectorId: provider });
  const controller = new AbortController();
  let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const cancel = () => { controller.abort(); rejectStop(new ConnectorError(`${provider} request was cancelled.`, { connectorId: provider, retryable: true })); };
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { controller.abort(); rejectStop(new ConnectorError(`${provider} request timed out.`, { connectorId: provider, retryable: true, timeout: true })); }, timeoutMs);
  const work = async () => {
    if (controller.signal.aborted) throw new ConnectorError(`${provider} request was cancelled.`, { connectorId: provider, retryable: true });
    const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type');
    beforeRequest?.();
    const response = await fetchImpl(target.href, { method, redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/json', ...headers, ...(!hasContentType && form ? { 'content-type': 'application/x-www-form-urlencoded' }
        : !hasContentType && body != null ? { 'content-type': 'application/json' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : body != null ? { body: JSON.stringify(body) } : {}) });
    const raw = await readTextBounded(response, maxChars, `${provider} response`);
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch {
      if (response.ok) throw new ConnectorError(`${provider} returned an invalid response.`, { connectorId: provider });
      data = null; // Error pages need not be JSON; preserve HTTP classification below.
    }
    if (!response.ok && !(allowOAuthError && typeof data?.error === 'string')) {
      const status = response.status;
      const rateLimited = status === 429 || provider === 'github' && status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0';
      const error = new ConnectorError(`${provider} request failed (${status}). ${rateLimited ? 'Rate limited; try again later.' : status === 401 ? 'Reconnect this account.' : status === 403 ? 'Check the app permissions and account access.' : 'Retry when the service is available.'}`,
        { connectorId: provider, status, retryable: rateLimited || status >= 500 });
      error.rateLimited = rateLimited;
      // Only expose recognized machine codes, never provider-controlled text.
      if (provider === 'microsoft' && data?.error?.code === 'syncStateNotFound') error.providerCode = 'syncStateNotFound';
      const retry = response.headers?.get?.('retry-after');
      if (retry) error.retryAfter = retry;
      throw error;
    }
    return data;
  };
  try {
    return await Promise.race([work(), stopped]);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (/exceeds \d+ characters/.test(error.message)) throw new ConnectorError(`${provider} returned too much content for one bounded read.`, { connectorId: provider });
    throw new ConnectorError(`${provider} could not be reached or the request timed out.`, { connectorId: provider, retryable: true, timeout: controller.signal.aborted });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
