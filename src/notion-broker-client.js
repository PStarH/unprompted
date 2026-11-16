/**
 * Native HTTP client for the standalone Notion broker.
 *
 * The desktop app never sees the Notion publisher secret. This client only
 * speaks the pinned broker origin and the shared wire contract, keeps the
 * local PKCE verifier and refresh proof local, and returns private
 * authorization objects for the existing setup store. Transport is injected
 * so tests never use a real network.
 *
 * Native runtime wiring is deliberately outside this module.
 */

import {
  LIMITS, PATHS, PROTOCOL_VERSION, isPlainObject, refreshProof,
  s256Challenge, validClientId, validClientState, validLoopbackRedirectUri,
  validOpaqueId, validPublicOrigin, validRefreshProof, validToken, validVerifier
} from './notion-broker-protocol.js';

const REDEEM_BODY_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const CLOCK_TOLERANCE_MS = 5_000;
const MAX_LABEL_CHARS = 200;
const MAX_LABEL_TOTAL = 320;
const ACCOUNT_ID_PATTERN = /^[0-9a-f-]{32,80}$/i;
const CAPABILITY_PATTERN = /^v1\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43}$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=[^;]+)?$/i;

const BROKER_CODES = new Set([
  'invalid_request', 'invalid_grant', 'in_progress', 'reauthorization_required',
  'expired', 'rate_limited', 'provider_error', 'capacity', 'server_error'
]);

const BROKER_MESSAGES = Object.freeze({
  invalid_request: 'The Notion broker rejected the request.',
  invalid_grant: 'The Notion authorization is not valid.',
  in_progress: 'The Notion broker is already processing this request.',
  reauthorization_required: 'Connect the Notion account again.',
  expired: 'The Notion authorization has expired.',
  rate_limited: 'The Notion broker is busy.',
  provider_error: 'Notion did not complete the request.',
  capacity: 'The Notion broker is temporarily unavailable.',
  server_error: 'The Notion broker could not complete the request.'
});

const ABORT_SENTINEL = Object.freeze({ aborted: true });
const OWN_ERRORS = new WeakSet();

export class NotionBrokerClientError extends Error {
  constructor(code, message, { outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'NotionBrokerClientError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function clientError(code, message, options) {
  const error = new NotionBrokerClientError(code, message, options);
  OWN_ERRORS.add(error);
  return error;
}

const invalidConfiguration = () => clientError('invalid_configuration', 'The Notion broker client configuration is invalid.');
const invalidInput = () => clientError('invalid_input', 'The Notion broker request is invalid.');
const invalidResponse = () => clientError('invalid_response', 'The Notion broker returned an invalid response.', { outcomeUnknown: true });
const networkError = () => clientError('network_error', 'The Notion broker could not be reached; the outcome is unknown.', { outcomeUnknown: true });
const timeoutError = () => clientError('timeout', 'The Notion broker request timed out; the outcome is unknown.', { outcomeUnknown: true });
const abortedError = () => clientError('aborted', 'The Notion broker request was cancelled.', { outcomeUnknown: true });
const brokerError = code => clientError(code, BROKER_MESSAGES[code]);

function requireExactKeys(value, keys) {
  if (!isPlainObject(value)) throw invalidResponse();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalidResponse();
  return value;
}

function validLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_CHARS
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function validExpiresAt(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validCapability(value) {
  return typeof value === 'string' && value.length <= 4096 && CAPABILITY_PATTERN.test(value);
}

function normalizeAccount(value) {
  requireExactKeys(value, ['id', 'userId', 'workspaceId', 'name', 'workspaceName']);
  if (typeof value.id !== 'string' || typeof value.userId !== 'string' || typeof value.workspaceId !== 'string') throw invalidResponse();
  if (!ACCOUNT_ID_PATTERN.test(value.userId) || !ACCOUNT_ID_PATTERN.test(value.workspaceId)) throw invalidResponse();
  if (value.id !== `${value.workspaceId}:${value.userId}`) throw invalidResponse();
  if (!validLabel(value.name) || !validLabel(value.workspaceName)) throw invalidResponse();
  return {
    id: value.id,
    userId: value.userId,
    workspaceId: value.workspaceId,
    name: value.name,
    workspaceName: value.workspaceName,
    label: `${value.name} · ${value.workspaceName}`.slice(0, MAX_LABEL_TOTAL)
  };
}

function normalizeBroker(value, brokerUrl) {
  requireExactKeys(value, ['issuer', 'grantId', 'refreshCapability']);
  if (value.issuer !== brokerUrl) throw invalidResponse();
  if (!validOpaqueId(value.grantId)) throw invalidResponse();
  if (!validCapability(value.refreshCapability)) throw invalidResponse();
  return { issuer: value.issuer, grantId: value.grantId, refreshCapability: value.refreshCapability };
}

function readDeclaredLength(response) {
  const declared = Number(response?.headers?.get?.('content-length'));
  return Number.isFinite(declared) ? declared : null;
}

async function readResponseText(response, maximum, signal) {
  const declared = readDeclaredLength(response);
  if (declared != null && declared > maximum) throw invalidResponse();
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      try {
        const pendingCancel = reader.cancel();
        if (pendingCancel && typeof pendingCancel.then === 'function') pendingCancel.then(undefined, () => {});
      } catch { /* the stream may already be closed */ }
    };
    const onAbort = () => cancel();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const chunks = [];
      let total = 0;
      for (;;) {
        if (signal?.aborted) throw ABORT_SENTINEL;
        const { done, value } = await reader.read();
        if (signal?.aborted) throw ABORT_SENTINEL;
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maximum) {
          cancel();
          throw invalidResponse();
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      cancel();
      if (signal?.aborted && !(error instanceof NotionBrokerClientError) && error !== ABORT_SENTINEL) throw ABORT_SENTINEL;
      throw error;
    } finally {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
    }
  }
  if (typeof response?.text !== 'function') throw invalidResponse();
  const text = await response.text();
  if (signal?.aborted) throw ABORT_SENTINEL;
  if (Buffer.byteLength(text, 'utf8') > maximum) throw invalidResponse();
  return text;
}

export class NotionBrokerClient {
  #clientId;
  #brokerUrl;
  #fetchImpl;
  #now;
  #timeoutMs;

  constructor({ clientId, brokerUrl, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
    if (!validClientId(clientId)) throw invalidConfiguration();
    const origin = validPublicOrigin(brokerUrl);
    if (!origin) throw invalidConfiguration();
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw invalidConfiguration();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw invalidConfiguration();
    this.#clientId = clientId;
    this.#brokerUrl = origin;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  get descriptor() {
    return Object.freeze({ clientId: this.#clientId, brokerUrl: this.#brokerUrl });
  }

  async begin({ redirectUri, clientState, verifier, signal } = {}) {
    if (!validLoopbackRedirectUri(redirectUri) || !validClientState(clientState) || !validVerifier(verifier)) throw invalidInput();
    const codeChallenge = s256Challenge(verifier);
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.#clientId,
      codeChallenge,
      codeChallengeMethod: 'S256',
      redirectUri,
      clientState
    };
    const json = await this.#post(PATHS.session, body, signal, LIMITS.sessionBodyBytes);
    requireExactKeys(json, ['protocolVersion', 'clientId', 'authorizeUrl', 'expiresAt']);
    if (json.protocolVersion !== PROTOCOL_VERSION || json.clientId !== this.#clientId) throw invalidResponse();
    if (typeof json.authorizeUrl !== 'string' || json.authorizeUrl.length > LIMITS.maxUrlBytes) throw invalidResponse();
    let authorizeUrl;
    try { authorizeUrl = new URL(json.authorizeUrl); }
    catch { throw invalidResponse(); }
    if (authorizeUrl.protocol !== 'https:' || authorizeUrl.username || authorizeUrl.password || authorizeUrl.hash) throw invalidResponse();
    if (authorizeUrl.origin !== this.#brokerUrl || authorizeUrl.pathname !== PATHS.authorize) throw invalidResponse();
    const parameterNames = [...authorizeUrl.searchParams.keys()];
    if (parameterNames.length !== 1 || parameterNames[0] !== 'session') throw invalidResponse();
    const session = authorizeUrl.searchParams.get('session');
    if (!validOpaqueId(session)) throw invalidResponse();
    if (typeof json.expiresAt !== 'string' || json.expiresAt.length > 64) throw invalidResponse();
    const expiresAtMs = Date.parse(json.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw invalidResponse();
    const now = this.#now();
    if (!(expiresAtMs > now) || expiresAtMs > now + LIMITS.sessionTtlMs + CLOCK_TOLERANCE_MS) throw invalidResponse();
    return { session, authorizeUrl: json.authorizeUrl, expiresAt: json.expiresAt };
  }

  async redeem({ code, verifier, signal } = {}) {
    if (!validOpaqueId(code, { min: 43, max: 43 }) || !validVerifier(verifier)) throw invalidInput();
    const body = { protocolVersion: PROTOCOL_VERSION, clientId: this.#clientId, code, verifier };
    const json = await this.#post(PATHS.redeem, body, signal, REDEEM_BODY_BYTES);
    return this.#normalizeAuthorization(json, { verifier });
  }

  async refresh({ authorization, signal } = {}) {
    const context = this.#privateAuthorization(authorization, { requireRefreshToken: true });
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.#clientId,
      grantId: context.grantId,
      refreshCapability: context.refreshCapability,
      refreshProof: context.refreshProof,
      refreshToken: context.refreshToken
    };
    const json = await this.#post(PATHS.refresh, body, signal, LIMITS.refreshBodyBytes);
    return this.#normalizeAuthorization(json, { expected: context });
  }

  async revoke({ authorization, signal } = {}) {
    const context = this.#privateAuthorization(authorization, { requireRefreshToken: false });
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.#clientId,
      grantId: context.grantId,
      refreshCapability: context.refreshCapability,
      refreshProof: context.refreshProof
    };
    const json = await this.#post(PATHS.revoke, body, signal, LIMITS.sessionBodyBytes);
    requireExactKeys(json, ['protocolVersion', 'clientId', 'revoked', 'grantId']);
    if (json.protocolVersion !== PROTOCOL_VERSION || json.clientId !== this.#clientId) throw invalidResponse();
    if (json.revoked !== true || json.grantId !== context.grantId) throw invalidResponse();
    return { revoked: true, grantId: context.grantId };
  }

  async cancel({ session, verifier, signal } = {}) {
    if (!validOpaqueId(session) || !validVerifier(verifier)) throw invalidInput();
    const body = { protocolVersion: PROTOCOL_VERSION, clientId: this.#clientId, session, verifier };
    const json = await this.#post(PATHS.cancel, body, signal, LIMITS.sessionBodyBytes);
    requireExactKeys(json, ['protocolVersion', 'clientId', 'cancelled']);
    if (json.protocolVersion !== PROTOCOL_VERSION || json.clientId !== this.#clientId || json.cancelled !== true) throw invalidResponse();
    return { cancelled: true };
  }

  #normalizeAuthorization(json, { verifier, expected = null } = {}) {
    requireExactKeys(json, ['protocolVersion', 'clientId', 'authorization']);
    if (json.protocolVersion !== PROTOCOL_VERSION || json.clientId !== this.#clientId) throw invalidResponse();
    const authorization = requireExactKeys(json.authorization, ['accessToken', 'refreshToken', 'expiresAt', 'account', 'broker']);
    if (!validToken(authorization.accessToken)) throw invalidResponse();
    if (authorization.refreshToken !== null && !validToken(authorization.refreshToken)) throw invalidResponse();
    if (authorization.expiresAt !== null && !validExpiresAt(authorization.expiresAt)) throw invalidResponse();
    const account = normalizeAccount(authorization.account);
    const broker = normalizeBroker(authorization.broker, this.#brokerUrl);
    let proof;
    if (expected) {
      if (account.id !== expected.accountId || account.userId !== expected.userId || account.workspaceId !== expected.workspaceId) throw invalidResponse();
      if (broker.grantId !== expected.grantId || broker.refreshCapability !== expected.refreshCapability) throw invalidResponse();
      proof = expected.refreshProof;
    } else {
      proof = refreshProof(verifier, broker.grantId);
    }
    return {
      accessToken: authorization.accessToken,
      refreshToken: authorization.refreshToken,
      expiresAt: authorization.expiresAt,
      account,
      broker: { issuer: broker.issuer, grantId: broker.grantId, refreshCapability: broker.refreshCapability, refreshProof: proof }
    };
  }

  #privateAuthorization(authorization, { requireRefreshToken }) {
    if (!isPlainObject(authorization)) throw invalidInput();
    const broker = authorization.broker;
    if (!isPlainObject(broker)) throw invalidInput();
    if (broker.issuer !== this.#brokerUrl || !validOpaqueId(broker.grantId)
      || !validCapability(broker.refreshCapability) || !validRefreshProof(broker.refreshProof)) throw invalidInput();
    const account = authorization.account;
    if (!isPlainObject(account)) throw invalidInput();
    if (typeof account.id !== 'string' || typeof account.userId !== 'string' || typeof account.workspaceId !== 'string') throw invalidInput();
    if (!ACCOUNT_ID_PATTERN.test(account.userId) || !ACCOUNT_ID_PATTERN.test(account.workspaceId)) throw invalidInput();
    if (account.id !== `${account.workspaceId}:${account.userId}`) throw invalidInput();
    if (requireRefreshToken && !validToken(authorization.refreshToken)) throw invalidInput();
    return {
      grantId: broker.grantId,
      refreshCapability: broker.refreshCapability,
      refreshProof: broker.refreshProof,
      refreshToken: authorization.refreshToken,
      accountId: account.id,
      userId: account.userId,
      workspaceId: account.workspaceId
    };
  }

  async #post(path, body, signal, maxRequestBytes) {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload, 'utf8') > maxRequestBytes) throw invalidInput();
    if (signal?.aborted) throw abortedError();
    let timedOut = false;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    let rejectAbort;
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(ABORT_SENTINEL);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
    const assertActive = () => {
      if (timedOut) throw timeoutError();
      if (signal?.aborted) throw abortedError();
      if (controller.signal.aborted) throw abortedError();
    };
    try {
      const fetchPromise = Promise.resolve().then(() => this.#fetchImpl(`${this.#brokerUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: payload
      }));
      const response = await Promise.race([fetchPromise, abortPromise]);
      assertActive();
      if (!response || typeof response !== 'object') throw invalidResponse();
      const contentType = response.headers?.get?.('content-type');
      if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType)) throw invalidResponse();
      const text = await Promise.race([readResponseText(response, LIMITS.providerResponseBytes, controller.signal), abortPromise]);
      assertActive();
      if (response.status !== 200) throw this.#errorFromResponse(text);
      let value;
      try { value = JSON.parse(text); }
      catch { throw invalidResponse(); }
      if (!isPlainObject(value)) throw invalidResponse();
      return value;
    } catch (error) {
      if (OWN_ERRORS.has(error)) throw error;
      if (timedOut) throw timeoutError();
      if (signal?.aborted) throw abortedError();
      if (error === ABORT_SENTINEL || controller.signal.aborted) throw timeoutErrorIfAborted(timedOut);
      throw networkError();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  #errorFromResponse(text) {
    let value;
    try { value = JSON.parse(text); }
    catch { throw invalidResponse(); }
    if (!isPlainObject(value) || typeof value.error !== 'string' || !BROKER_CODES.has(value.error)) throw invalidResponse();
    return brokerError(value.error);
  }
}

function timeoutErrorIfAborted(timedOut) {
  return timedOut ? timeoutError() : abortedError();
}
