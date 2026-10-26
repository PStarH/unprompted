import { ConnectorError } from './connector.js';
import { readTextBounded } from '../bounded.js';

/** Fixed-origin, bounded provider transport. Errors never echo response bodies. */
export async function providerJSON(url, { provider, origin, fetchImpl = globalThis.fetch, method = 'GET',
  headers = {}, form = null, body = null, signal = null, timeoutMs = 20_000, maxChars = 2_000_000,
  allowOAuthError = false } = {}) {
  const target = new URL(url, origin);
  if (target.origin !== origin || target.username || target.password) throw new ConnectorError('Provider continuation URL has an unexpected origin.', { connectorId: provider });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const response = await fetchImpl(target.href, { method, redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/json', ...headers, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : body != null ? { body: JSON.stringify(body) } : {}) });
    const raw = await readTextBounded(response, maxChars, `${provider} response`);
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { throw new ConnectorError(`${provider} returned an invalid response.`, { connectorId: provider }); }
    if (!response.ok && !(allowOAuthError && typeof data?.error === 'string')) {
      const status = response.status;
      const rateLimited = status === 429 || provider === 'github' && status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0';
      const error = new ConnectorError(`${provider} request failed (${status}). ${rateLimited ? 'Rate limited; try again later.' : status === 401 ? 'Reconnect this account.' : status === 403 ? 'Check the app permissions and account access.' : 'Retry when the service is available.'}`,
        { connectorId: provider, status, retryable: rateLimited || status >= 500 });
      error.rateLimited = rateLimited;
      const retry = response.headers?.get?.('retry-after');
      if (retry) error.retryAfter = retry;
      throw error;
    }
    return data;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (/exceeds \d+ characters/.test(error.message)) throw new ConnectorError(`${provider} returned too much content for one bounded read.`, { connectorId: provider });
    throw new ConnectorError(`${provider} could not be reached or the request timed out.`, { connectorId: provider, retryable: true, timeout: controller.signal.aborted });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
