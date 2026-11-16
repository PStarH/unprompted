/**
 * Shared wire contract for the standalone Notion broker.
 *
 * This module is intentionally dependency-free apart from Node's crypto
 * primitives. It is the only place that defines protocol strings, exact
 * request shapes, loopback redirect rules and provider response parsing so the
 * broker service and its tests cannot drift from the desktop client contract.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 'unprompted-notion-broker-v1';
export const NOTION_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
export const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
export const NOTION_VERSION = '2026-03-11';
export const NOTION_CALLBACK_PATH = '/v1/notion/callback';

export const PATHS = Object.freeze({
  meta: '/v1/notion/meta',
  session: '/v1/notion/session',
  authorize: '/v1/notion/authorize',
  callback: NOTION_CALLBACK_PATH,
  redeem: '/v1/notion/redeem',
  refresh: '/v1/notion/refresh',
  revoke: '/v1/notion/revoke',
  cancel: '/v1/notion/cancel'
});

export const LIMITS = Object.freeze({
  sessionTtlMs: 5 * 60_000,
  handoffTtlMs: 60_000,
  refreshCacheTtlMs: 2 * 60_000,
  defaultGrantTtlMs: 90 * 24 * 60 * 60_000,
  minGrantTtlMs: 60 * 60_000,
  maxGrantTtlMs: 365 * 24 * 60 * 60_000,
  leaseTtlMs: 15_000,
  leaseRenewMs: 5_000,
  maxSessions: 1024,
  maxGrants: 4096,
  maxRefreshOps: 8192,
  tokenChars: 32_000,
  maxBodyBytes: 40 * 1024,
  sessionBodyBytes: 4 * 1024,
  refreshBodyBytes: 40 * 1024,
  maxUrlBytes: 8 * 1024,
  providerResponseBytes: 64 * 1024,
  providerTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  idleTimeoutMs: 5_000,
  providerConcurrency: 4,
  providerRatePerSecond: 3,
  cookieTtlSeconds: 300,
  globalRequestsPerMinute: 600,
  socketRequestsPerMinute: 120
});

const ID_PATTERN = /^[0-9a-f-]{32,80}$/i;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]{8,512}$/;
const URLSAFE = /^[A-Za-z0-9_-]+$/;
const CLIENT_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_REDIRECT_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/oauth\/notion$/i;

export class BrokerError extends Error {
  constructor(status, code, message, { retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderResponseError extends Error {
  constructor() {
    super('The provider returned an invalid response.');
    this.name = 'ProviderResponseError';
  }
}

export const errors = Object.freeze({
  invalidRequest: () => new BrokerError(400, 'invalid_request', 'The request is invalid.'),
  invalidGrant: () => new BrokerError(401, 'invalid_grant', 'The authorization is not valid.'),
  inProgress: () => new BrokerError(409, 'in_progress', 'This request is already in progress.', { retryAfterSeconds: 2 }),
  reauthorizationRequired: () => new BrokerError(409, 'reauthorization_required', 'Connect the account again.'),
  expired: () => new BrokerError(410, 'expired', 'This authorization has expired.'),
  rateLimited: () => new BrokerError(429, 'rate_limited', 'The broker is busy. Retry shortly.', { retryAfterSeconds: 1 }),
  providerError: () => new BrokerError(502, 'provider_error', 'The provider did not complete the request.'),
  capacity: () => new BrokerError(503, 'capacity', 'The broker is temporarily unavailable.'),
  serverError: () => new BrokerError(500, 'server_error', 'The broker could not complete the request.')
});

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requirePlainObject(value) {
  if (!isPlainObject(value)) throw errors.invalidRequest();
  return value;
}

export function requireExactObject(value, required, optional = []) {
  requirePlainObject(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw errors.invalidRequest();
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw errors.invalidRequest();
  }
  return value;
}

export function validClientId(value) {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}

export function validClientSecret(value) {
  return typeof value === 'string' && CLIENT_SECRET_PATTERN.test(value);
}

export function validOpaqueId(value, { min = 32, max = 128 } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max && URLSAFE.test(value);
}

export function validClientState(value) {
  return typeof value === 'string' && CLIENT_STATE_PATTERN.test(value);
}

export function validVerifier(value) {
  return typeof value === 'string' && VERIFIER_PATTERN.test(value);
}

export function validChallenge(value) {
  return typeof value === 'string' && CHALLENGE_PATTERN.test(value);
}

export function validRefreshProof(value) {
  return typeof value === 'string' && PROOF_PATTERN.test(value);
}

export function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.tokenChars
    && !/[\u0000\r\n]/.test(value);
}

export function validPublicOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  let url;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' || !url.hostname) return null;
  return url.origin;
}

export function validLoopbackRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const match = LOOPBACK_REDIRECT_PATTERN.exec(value);
  if (!match) return null;
  if (Number(match[1]) > 65_535) return null;
  let url;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return null;
  if (url.pathname !== '/oauth/notion' || url.search !== '' || url.hash !== '' || url.username || url.password) return null;
  return value;
}

export function s256Challenge(verifier) {
  if (!validVerifier(verifier)) throw errors.invalidRequest();
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export function refreshProof(verifier, grantId) {
  if (!validVerifier(verifier) || !validOpaqueId(grantId)) throw errors.invalidRequest();
  return createHash('sha256')
    .update('unprompted-notion-refresh-v1\0', 'utf8')
    .update(verifier, 'utf8')
    .update('\0', 'utf8')
    .update(grantId, 'utf8')
    .digest('base64url');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function requireMetaRequest() {
  return undefined;
}

export function requireSessionRequest(body, clientId) {
  requireExactObject(body, ['protocolVersion', 'clientId', 'codeChallenge', 'codeChallengeMethod', 'redirectUri', 'clientState']);
  if (body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== clientId) throw errors.invalidRequest();
  if (!validChallenge(body.codeChallenge) || body.codeChallengeMethod !== 'S256') throw errors.invalidRequest();
  const redirectUri = validLoopbackRedirectUri(body.redirectUri);
  if (!redirectUri) throw errors.invalidRequest();
  if (!validClientState(body.clientState)) throw errors.invalidRequest();
  return { challenge: body.codeChallenge, redirectUri, clientState: body.clientState };
}

export function requireRedeemRequest(body, clientId) {
  requireExactObject(body, ['protocolVersion', 'clientId', 'code', 'verifier']);
  if (body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== clientId) throw errors.invalidRequest();
  if (!validOpaqueId(body.code, { min: 43, max: 43 })) throw errors.invalidRequest();
  if (!validVerifier(body.verifier)) throw errors.invalidRequest();
  return { code: body.code, verifier: body.verifier };
}

export function requireRefreshRequest(body, clientId) {
  requireExactObject(body, ['protocolVersion', 'clientId', 'grantId', 'refreshCapability', 'refreshProof', 'refreshToken']);
  if (body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== clientId) throw errors.invalidRequest();
  if (!validOpaqueId(body.grantId)) throw errors.invalidRequest();
  if (typeof body.refreshCapability !== 'string' || body.refreshCapability.length > 4096) throw errors.invalidRequest();
  if (!validRefreshProof(body.refreshProof)) throw errors.invalidRequest();
  if (!validToken(body.refreshToken)) throw errors.invalidRequest();
  return {
    grantId: body.grantId,
    refreshCapability: body.refreshCapability,
    refreshProof: body.refreshProof,
    refreshToken: body.refreshToken
  };
}

export function requireRevokeRequest(body, clientId) {
  requireExactObject(body, ['protocolVersion', 'clientId', 'grantId', 'refreshCapability', 'refreshProof']);
  if (body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== clientId) throw errors.invalidRequest();
  if (!validOpaqueId(body.grantId)) throw errors.invalidRequest();
  if (typeof body.refreshCapability !== 'string' || body.refreshCapability.length > 4096) throw errors.invalidRequest();
  if (!validRefreshProof(body.refreshProof)) throw errors.invalidRequest();
  return { grantId: body.grantId, refreshCapability: body.refreshCapability, refreshProof: body.refreshProof };
}

export function requireCancelRequest(body, clientId) {
  requireExactObject(body, ['protocolVersion', 'clientId', 'session', 'verifier']);
  if (body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== clientId) throw errors.invalidRequest();
  if (!validOpaqueId(body.session)) throw errors.invalidRequest();
  if (!validVerifier(body.verifier)) throw errors.invalidRequest();
  return { session: body.session, verifier: body.verifier };
}

function cleanLabel(value, limit = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Parses a Notion token response. Identity is mandatory when requireAccount is
 * true; otherwise an omitted identity returns null and the caller keeps the
 * existing account binding. A partially present or malformed identity always
 * fails closed.
 */
export function parseTokenResponse(data, { now, requireAccount = false } = {}) {
  if (!isPlainObject(data)) throw new ProviderResponseError();
  if (!validToken(data.access_token)) throw new ProviderResponseError();
  if (data.refresh_token != null && !validToken(data.refresh_token)) throw new ProviderResponseError();

  let expiresAt = null;
  const expiresIn = typeof data.expires_in === 'string' && /^[0-9]+$/.test(data.expires_in)
    ? Number(data.expires_in) : data.expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn <= 365 * 24 * 3600) {
    expiresAt = iso(Number(now) + Math.trunc(expiresIn) * 1000);
  }

  const identityPresent = Object.hasOwn(data, 'workspace_id') || Object.hasOwn(data, 'owner');
  const account = identityPresent ? parseAccount(data) : null;
  if (identityPresent && !account) throw new ProviderResponseError();
  if (requireAccount && !account) throw new ProviderResponseError();

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresAt,
    account
  };
}

export function parseAccount(data) {
  if (!isPlainObject(data)) return null;
  const workspaceId = typeof data.workspace_id === 'string' ? data.workspace_id : '';
  const userId = isPlainObject(data.owner) && data.owner.type === 'user' && isPlainObject(data.owner.user)
    && typeof data.owner.user.id === 'string' ? data.owner.user.id : '';
  if (!ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(userId)) return null;
  const user = data.owner.user;
  const suppliedName = cleanLabel(user.name) || cleanLabel(user.person?.email);
  const suppliedWorkspace = cleanLabel(data.workspace_name);
  return {
    id: `${workspaceId}:${userId}`,
    userId,
    workspaceId,
    name: suppliedName || `User ${userId.slice(0, 8)}`,
    workspaceName: suppliedWorkspace || `Workspace ${workspaceId.slice(0, 8)}`
  };
}

export function authorizationDTO(clientId, parsed, broker) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientId,
    authorization: {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      account: parsed.account,
      broker
    }
  };
}
