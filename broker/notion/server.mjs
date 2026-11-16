/**
 * HTTP boundary for the Notion broker.
 *
 * The listener is intended to sit behind an operator-managed TLS reverse
 * proxy. It binds loopback only, accepts strict JSON API requests, never
 * enables CORS or ambient cookie auth for API calls, and emits fixed HTML for
 * browser redirects. No untrusted provider text reaches a response.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  BrokerError, LIMITS, PATHS, errors, isPlainObject
} from '../../src/notion-broker-protocol.js';

const JSON_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/i;
const ROUTES = new Map([
  [`GET ${PATHS.meta}`, { kind: 'meta' }],
  [`POST ${PATHS.session}`, { kind: 'session', limit: LIMITS.sessionBodyBytes }],
  [`GET ${PATHS.authorize}`, { kind: 'authorize', browser: true }],
  [`GET ${PATHS.callback}`, { kind: 'callback', browser: true }],
  [`POST ${PATHS.redeem}`, { kind: 'redeem', limit: 8 * 1024 }],
  [`POST ${PATHS.refresh}`, { kind: 'refresh', limit: LIMITS.refreshBodyBytes }],
  [`POST ${PATHS.revoke}`, { kind: 'revoke', limit: LIMITS.sessionBodyBytes }],
  [`POST ${PATHS.cancel}`, { kind: 'cancel', limit: LIMITS.sessionBodyBytes }]
]);
const METHOD_PATHS = new Map();
for (const [route, definition] of ROUTES) {
  const [method, pathname] = route.split(' ');
  if (!METHOD_PATHS.has(pathname)) METHOD_PATHS.set(pathname, new Set());
  METHOD_PATHS.get(pathname).add(method);
  definition.method = method;
  definition.pathname = pathname;
}

const PAGES = Object.freeze({
  received: page('Authorization received', 'Return to Unprompted to finish connecting.'),
  denied: page('Authorization not completed', 'Return to Unprompted to try again.'),
  expired: page('Authorization expired', 'Return to Unprompted and start again.'),
  failed: page('Authorization could not be completed', 'Return to Unprompted to try again.'),
  busy: page('Connection service is busy', 'Return to Unprompted and try again shortly.'),
  invalid: page('This authorization link is not valid', 'Return to Unprompted and start again.')
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function page(title, detail) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
}

function htmlHeaders() {
  return {
    ...securityHeaders(),
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  };
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  const headers = {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendHtml(res, status, pageBody, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const headers = { ...htmlHeaders(), 'content-length': String(Buffer.byteLength(pageBody)), ...extraHeaders };
  res.writeHead(status, headers);
  res.end(pageBody);
}

function sendRedirect(res, status, location, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const headers = { ...securityHeaders(), location, 'content-length': '0', ...extraHeaders };
  res.writeHead(status, headers);
  res.end();
}

function errorPayload(descriptor, error) {
  return {
    ...(descriptor?.protocolVersion ? { protocolVersion: descriptor.protocolVersion } : {}),
    ...(descriptor?.clientId ? { clientId: descriptor.clientId } : {}),
    error: error.code
  };
}

function errorHeaders(error) {
  return error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {};
}

function htmlForError(error) {
  if (error.status === 429) return { page: PAGES.busy, status: 429 };
  if (error.status === 502) return { page: PAGES.failed, status: 502 };
  if (error.status === 410) return { page: PAGES.expired, status: 410 };
  if (error.status === 409) return { page: PAGES.denied, status: 409 };
  if (error.status >= 500) return { page: PAGES.failed, status: error.status };
  return { page: PAGES.invalid, status: error.status };
}

function renderResult(res, result) {
  if (!result || typeof result !== 'object') {
    sendJson(res, 500, { error: 'server_error' });
    return;
  }
  if (result.redirect) {
    sendRedirect(res, result.status || 303, result.redirect, result.headers);
    return;
  }
  if (result.html !== undefined) {
    sendHtml(res, result.status || 200, result.html, result.headers);
    return;
  }
  sendJson(res, result.status || 200, result.json ?? { error: 'server_error' }, result.headers);
}

function renderError(res, error, browser) {
  if (browser) {
    const { page: pageBody, status } = htmlForError(error);
    sendHtml(res, status, pageBody, errorHeaders(error));
    return;
  }
  sendJson(res, error.status, errorPayload(descriptorFor(res), error), errorHeaders(error));
}

// The descriptor is attached to the request context by the handler so error
// JSON can include the public protocol/client identifiers without re-reading
// configuration. It never contains secrets.
function descriptorFor(res) {
  return res.__notionBrokerDescriptor || null;
}

const globalRate = { start: 0, count: 0 };

function checkRate(req) {
  const now = Date.now();
  if (now - globalRate.start >= 60_000) {
    globalRate.start = now;
    globalRate.count = 0;
  }
  globalRate.count += 1;
  if (globalRate.count > LIMITS.globalRequestsPerMinute) {
    throw new BrokerError(429, 'rate_limited', 'The broker is busy. Retry shortly.', { retryAfterSeconds: 60 });
  }
  const socket = req.socket;
  const key = socket && typeof socket === 'object' ? socket : null;
  if (!key) return;
  const state = key.__notionBrokerRate || { start: now, count: 0 };
  if (now - state.start >= 60_000) {
    state.start = now;
    state.count = 0;
  }
  state.count += 1;
  key.__notionBrokerRate = state;
  if (state.count > LIMITS.socketRequestsPerMinute) {
    throw new BrokerError(429, 'rate_limited', 'The broker is busy. Retry shortly.', { retryAfterSeconds: 60 });
  }
}

function queryFor(url, allowed) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw errors.invalidRequest();
  }
  for (const key of allowed) {
    if (params.getAll(key).length > 1) throw errors.invalidRequest();
  }
  return params;
}

async function readJson(req, maxBytes) {
  const type = req.headers['content-type'];
  if (!type || !JSON_TYPE.test(String(type))) throw errors.invalidRequest();
  const declared = req.headers['content-length'];
  if (declared != null) {
    if (!/^[0-9]+$/.test(String(declared)) || Number(declared) > maxBytes) throw errors.invalidRequest();
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw errors.invalidRequest();
    chunks.push(chunk);
  }
  if (total === 0) throw errors.invalidRequest();
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw errors.invalidRequest(); }
  if (!isPlainObject(value)) throw errors.invalidRequest();
  return value;
}

async function handle(broker, req, res) {
  const descriptor = (() => {
    try { return broker.publicDescriptor(); }
    catch { return null; }
  })();
  res.__notionBrokerDescriptor = descriptor;

  res.setTimeout(LIMITS.requestTimeoutMs, () => {
    if (!res.writableEnded) sendJson(res, 503, errorPayload(descriptor, errors.capacity()), { connection: 'close' });
  });

  try {
    checkRate(req);
    const rawUrl = req.url || '';
    if (Buffer.byteLength(rawUrl, 'utf8') > LIMITS.maxUrlBytes) throw errors.invalidRequest();
    let url;
    try { url = new URL(rawUrl, 'http://broker.invalid'); }
    catch { throw errors.invalidRequest(); }
    if (url.origin !== 'http://broker.invalid') throw errors.invalidRequest();

    const methods = METHOD_PATHS.get(url.pathname);
    if (!methods) throw Object.assign(errors.invalidRequest(), { status: 404, code: 'invalid_request', notFound: true });
    if (!methods.has(req.method)) {
      const error = errors.invalidRequest();
      error.status = 405;
      error.allow = [...methods].join(', ');
      throw error;
    }

    const route = ROUTES.get(`${req.method} ${url.pathname}`);
    let result;
    switch (route.kind) {
      case 'meta':
        queryFor(url, []);
        result = await broker.meta();
        break;
      case 'session':
        queryFor(url, []);
        result = await broker.session(await readJson(req, route.limit));
        break;
      case 'authorize':
        result = await broker.authorize({
          session: queryFor(url, ['session']).get('session') || '',
          cookieHeader: req.headers.cookie || ''
        });
        break;
      case 'callback':
        result = await broker.callback({
          query: queryFor(url, ['state', 'code', 'error']),
          cookieHeader: req.headers.cookie || ''
        });
        break;
      case 'redeem':
        queryFor(url, []);
        result = await broker.redeem(await readJson(req, route.limit));
        break;
      case 'refresh':
        queryFor(url, []);
        result = await broker.refresh(await readJson(req, route.limit));
        break;
      case 'revoke':
        queryFor(url, []);
        result = await broker.revoke(await readJson(req, route.limit));
        break;
      case 'cancel':
        queryFor(url, []);
        result = await broker.cancel(await readJson(req, route.limit));
        break;
      default:
        throw errors.invalidRequest();
    }
    renderResult(res, result);
  } catch (error) {
    const brokerError = error instanceof BrokerError ? error : errors.serverError();
    const route = METHOD_PATHS.has(safePathname(req.url))
      ? ROUTES.get(`${req.method} ${safePathname(req.url)}`) : null;
    if (error?.notFound) {
      sendJson(res, 404, errorPayload(descriptor, brokerError), { connection: 'close' });
      return;
    }
    if (error?.allow) {
      sendJson(res, error.status, errorPayload(descriptor, brokerError), { allow: error.allow, connection: 'close' });
      return;
    }
    renderError(res, brokerError, route?.browser === true);
  }
}

function safePathname(rawUrl) {
  try { return new URL(String(rawUrl || ''), 'http://broker.invalid').pathname; }
  catch { return ''; }
}

export function createRequestHandler(broker) {
  return function notionBrokerHandler(req, res) {
    return handle(broker, req, res);
  };
}

export async function listenNotionBroker({ broker, host = '127.0.0.1', port = 9043 }) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('The broker must listen on a loopback address.');
  const handler = typeof broker?.handler === 'function' ? broker.handler : createRequestHandler(broker);
  const server = createServer(handler);
  server.requestTimeout = LIMITS.requestTimeoutMs;
  server.headersTimeout = LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = LIMITS.idleTimeoutMs;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 256;
  await new Promise((resolve, reject) => {
    const fail = error => {
      server.off('listening', ok);
      reject(error);
    };
    const ok = () => {
      server.off('error', fail);
      resolve();
    };
    server.once('error', fail);
    server.once('listening', ok);
    server.listen(port, host);
  });
  return {
    server,
    address: server.address(),
    close: async () => {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections?.();
      await closed;
      server.closeAllConnections?.();
    }
  };
}

const REQUIRED_ENVIRONMENT = Object.freeze([
  'NOTION_BROKER_CLIENT_ID',
  'NOTION_BROKER_CLIENT_SECRET',
  'NOTION_BROKER_PUBLIC_ORIGIN',
  'NOTION_BROKER_MASTER_KEY',
  'NOTION_BROKER_STATE_FILE'
]);

export function cliConfiguration(environment = process.env) {
  for (const name of REQUIRED_ENVIRONMENT) {
    if (typeof environment[name] !== 'string' || environment[name].length === 0) {
      throw new Error(`Set ${name} before starting the Notion broker.`);
    }
  }
  const host = environment.NOTION_BROKER_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('NOTION_BROKER_HOST must be a loopback address.');
  }
  const port = Number(environment.NOTION_BROKER_PORT || '9043');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('NOTION_BROKER_PORT must be between 1 and 65535.');
  const options = {
    databaseFile: environment.NOTION_BROKER_STATE_FILE,
    clientId: environment.NOTION_BROKER_CLIENT_ID,
    clientSecret: environment.NOTION_BROKER_CLIENT_SECRET,
    publicOrigin: environment.NOTION_BROKER_PUBLIC_ORIGIN,
    masterKey: environment.NOTION_BROKER_MASTER_KEY,
    host,
    port
  };
  if (environment.NOTION_BROKER_GRANT_TTL_MS != null) {
    options.grantTtlMs = Number(environment.NOTION_BROKER_GRANT_TTL_MS);
  }
  return options;
}

async function main() {
  const options = cliConfiguration(process.env);
  const { createNotionBroker } = await import('./service.mjs');
  const broker = createNotionBroker(options);
  let listener;
  try {
    listener = await listenNotionBroker({ broker, host: options.host, port: options.port });
  } catch (error) {
    await broker.close();
    throw error;
  }
  const descriptor = broker.publicDescriptor();
  process.stdout.write(`${JSON.stringify({ listening: `http://${options.host}:${listener.address.port}`, ...descriptor })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await listener.close();
    await broker.close();
  };
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`Notion broker failed to start: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
