import { ConnectorError } from './connector.js';

export const PLATFORM_APIS = Object.freeze({
  github: { origin: 'https://api.github.com', prefix: '/', authorization: 'GitHub App installation permissions and user access' },
  microsoft: { origin: 'https://graph.microsoft.com', prefix: '/', authorization: 'Granted Microsoft Graph delegated scopes' },
  slack: { origin: 'https://slack.com', prefix: '/api/', authorization: 'Granted Slack user scopes' },
  notion: { origin: 'https://api.notion.com', prefix: '/v1/', authorization: 'Notion connection capabilities and selected pages' },
  todoist: { origin: 'https://api.todoist.com', prefix: '/api/', authorization: 'Rights of the connected Todoist token' },
  google: { origin: 'https://www.googleapis.com', prefix: '/', authorization: 'Granted Google OAuth scopes; official googleapis.com API origins' },
  apple_reminders: { origin: 'native:apple_reminders', prefix: '/', authorization: 'Selected macOS Reminders lists and explicit local action grant' }
});
export const API_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => Object.assign(new ConnectorError(message), { code: 'INVALID_PLATFORM_REQUEST', status: 400, definitiveNoEffect: true });
const reservedHeaders = /^(authorization|proxy-authorization|cookie|host|connection|content-length|transfer-encoding|upgrade|forwarded|x-forwarded-.*)$/i;

export function platformRequest(connectorId, input) {
  const api = PLATFORM_APIS[connectorId];
  if (!api || !object(input) || Object.keys(input).some(key => !['method', 'path', 'origin', 'query', 'headers', 'body', 'bodyEncoding', 'responseType'].includes(key))) throw fail('Choose a connected platform API and supported request fields.');
  const method = String(input.method || 'GET').toUpperCase();
  if (!API_METHODS.includes(method) || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//') || input.path.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(input.path)) throw fail('Use a valid API method and absolute API path.');
  if (connectorId === 'apple_reminders') {
    if (input.origin != null || input.query != null || input.headers != null || input.bodyEncoding != null || input.responseType != null
      || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)
      || !/^\/lists(?:\/[a-f0-9]{64}\/reminders(?:\/[A-Za-z0-9_-]+)?)?$/.test(input.path)
      || method === 'GET' && input.body != null || method !== 'GET' && !object(input.body)) throw fail('Use a supported selected-list Reminders operation.');
    if (input.body != null && Buffer.byteLength(JSON.stringify(input.body)) > 192000) throw fail('The native action exceeds the dispatch limit.');
    return { connectorId, method, path: input.path, url: `native:apple_reminders${input.path}`, body: input.body, responseType: 'json', write: method !== 'GET' };
  }
  let origin;
  try { origin = new URL(input.origin || api.origin); } catch { throw fail('Invalid platform API origin.'); }
  const google = connectorId === 'google' && origin.protocol === 'https:' && /^(?:[a-z0-9-]+\.)googleapis\.com$/.test(origin.hostname) && !origin.port;
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !(origin.origin === api.origin || google)) throw fail('Requests must stay on the connected platform API origin.');
  const url = new URL(input.path, origin.origin);
  if (url.origin !== origin.origin || url.hash || !url.pathname.startsWith(api.prefix)) throw fail('The path is outside the connected platform API.');
  if (input.query != null) {
    if (!object(input.query) || Object.keys(input.query).length > 100) throw fail('Invalid API query.');
    for (const [key, value] of Object.entries(input.query)) for (const item of Array.isArray(value) ? value : [value]) {
      if (!['string', 'number', 'boolean'].includes(typeof item) || key.length > 200 || String(item).length > 8192) throw fail('Invalid API query value.');
      url.searchParams.append(key, String(item));
    }
  }
  const headers = {};
  if (input.headers != null) {
    if (!object(input.headers) || Object.keys(input.headers).length > 32) throw fail('Invalid API headers.');
    for (const [key, value] of Object.entries(input.headers)) {
      if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(key) || reservedHeaders.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw fail('API credentials and routing headers are managed by the connector.');
      headers[key.toLowerCase()] = value;
    }
  }
  const encoding = input.bodyEncoding || 'json', responseType = input.responseType || 'json';
  if (!['json', 'text', 'form', 'base64'].includes(encoding) || !['json', 'text', 'base64'].includes(responseType)) throw fail('Unsupported API body format.');
  if (input.body != null && ['GET', 'HEAD', 'OPTIONS'].includes(method)) throw fail('This HTTP method cannot contain a request body.');
  let body;
  if (input.body != null) {
    if (encoding === 'json') { body = JSON.stringify(input.body); headers['content-type'] ||= 'application/json'; }
    else if (encoding === 'form') {
      if (!object(input.body) || Object.values(input.body).some(value => !['string', 'number', 'boolean'].includes(typeof value))) throw fail('A form body must contain simple values.');
      body = new URLSearchParams(input.body).toString(); headers['content-type'] ||= 'application/x-www-form-urlencoded';
    } else {
      if (typeof input.body !== 'string' || encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.body)) throw fail('Invalid text or base64 API body.');
      body = encoding === 'base64' ? Buffer.from(input.body, 'base64') : input.body;
    }
    if (Buffer.byteLength(body) > 192000) throw fail('The API request exceeds the 192 KB dispatch limit.');
  }
  if (url.href.length > 16000) throw fail('The API URL exceeds the supported size.');
  // Slack permits some mutations through GET. Only known read method suffixes
  // are treated as reads; unknown methods remain available through write grants.
  const slackRead = /\.(?:info|list|history|replies|lookupByEmail|test)$/.test(url.pathname) || /^\/api\/search\.(?:all|messages|files)$/.test(url.pathname);
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method) || connectorId === 'slack' && !slackRead;
  return { connectorId, method, url: url.href, path: url.pathname, headers, body, responseType, write };
}

async function boundedResponse(response, responseType) {
  const chunks = []; let bytes = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 2_000_000) throw new Error('Platform API response exceeds 2 MB.');
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  } else {
    const data = Buffer.from(await response.text()); if (data.length > 2_000_000) throw new Error('Platform API response exceeds 2 MB.'); chunks.push(data);
  }
  const data = Buffer.concat(chunks);
  if (responseType === 'base64') return data.toString('base64');
  const text = data.toString('utf8');
  if (!text || responseType === 'text') return text || null;
  try { return JSON.parse(text); } catch { throw new Error('Platform API did not return JSON. Select a text or binary response.'); }
}

/** General authenticated API surface. Provider scopes, not a local endpoint
 * allowlist, decide what the connected account can do. Never follows redirects. */
export async function performPlatformRequest(connector, input, { signal, beforeDispatch = () => {}, timeoutMs = 20000 } = {}) {
  const request = platformRequest(connector.id, input);
  if (!connector.live || connector.auth?.disabled) throw fail('This platform account is disconnected.');
  const controller = new AbortController(); let timer;
  const work = async () => {
    const authorization = typeof connector.auth?.headers === 'function' ? await connector.auth.headers() : { authorization: `Bearer ${await connector.auth.accessToken()}` };
    if (!connector.live || connector.auth?.disabled) throw fail('This platform account is disconnected.');
    const defaults = connector.id === 'github' ? { 'user-agent': 'Unprompted', 'x-github-api-version': '2022-11-28' }
      : connector.id === 'notion' ? { 'notion-version': '2022-06-28' } : {};
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    combined.throwIfAborted(); beforeDispatch();
    const response = await connector.fetchImpl(request.url, { method: request.method, headers: { ...defaults, ...request.headers, ...authorization }, ...(request.body != null ? { body: request.body } : {}), redirect: 'error', signal: combined });
    if (!response.ok) {
      const error = new ConnectorError(`${connector.id} API rejected the request (${response.status}).`, { connectorId: connector.id, status: response.status, retryable: response.status === 429 || response.status >= 500 });
      if ([401, 403, 405, 413, 415, 429].includes(response.status)) error.definitiveNoEffect = true;
      throw error;
    }
    const body = await boundedResponse(response, request.responseType);
    if (connector.id === 'slack' && body?.ok === false) {
      throw new ConnectorError('Slack rejected the API operation; reconcile any partial effects before retrying.', { connectorId: connector.id, status: 400 });
    }
    return { status: response.status, body, responseType: request.responseType, etag: response.headers?.get?.('etag') || null };
  };
  try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ConnectorError('Platform API timed out; a dispatched write may have acted.', { connectorId: connector.id, timeout: true })); }, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
