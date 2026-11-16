/**
 * Notion broker service.
 *
 * The service owns the OAuth state machine. It never exposes the Notion
 * publisher secret to a desktop client: the browser completes the provider
 * authorization against this server, receives a one-time handoff code bound to
 * the original loopback redirect, and the desktop redeems that code with its
 * S256 verifier. A Notion refresh capability is created only after a valid
 * redeem.
 */

import { randomBytes } from 'node:crypto';
import {
  LIMITS, NOTION_AUTHORIZE_URL, NOTION_CALLBACK_PATH, NOTION_VERSION, PATHS,
  PROTOCOL_VERSION, ProviderResponseError, errors, isPlainObject, parseTokenResponse,
  refreshProof, requireCancelRequest, requireRedeemRequest, requireRefreshRequest,
  requireRevokeRequest, requireSessionRequest, s256Challenge, safeEqual, validChallenge,
  validClientId, validClientSecret, validClientState, validLoopbackRedirectUri,
  validOpaqueId, validPublicOrigin, validToken, authorizationDTO
} from '../../src/notion-broker-protocol.js';
import { NotionBrokerStore } from './store.mjs';
import { createRequestHandler } from './server.mjs';

class ProviderGate {
  constructor({ concurrency, ratePerSecond, now }) {
    this.concurrency = concurrency;
    this.ratePerSecond = ratePerSecond;
    this.now = now;
    this.active = 0;
    this.starts = [];
  }

  acquire() {
    const now = this.now();
    this.starts = this.starts.filter(started => now - started < 1000);
    if (this.active >= this.concurrency || this.starts.length >= this.ratePerSecond) {
      throw errors.rateLimited();
    }
    this.active += 1;
    this.starts.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

function masterKeyBytes(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new Error('The broker master key must be exactly 32 bytes.');
    return Buffer.from(value);
  }
  if (typeof value !== 'string') throw new Error('The broker master key must be 32 random bytes encoded as Base64.');
  const standard = /^[A-Za-z0-9+/]{43}=$/.test(value);
  const urlsafe = /^[A-Za-z0-9_-]{43}$/.test(value);
  if (!standard && !urlsafe) throw new Error('The broker master key must be 32 random bytes encoded as Base64.');
  const key = Buffer.from(value, standard ? 'base64' : 'base64url');
  if (key.length !== 32) throw new Error('The broker master key must be exactly 32 bytes.');
  return key;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside the supported range.`);
  return value;
}

function normalizeConfiguration(options) {
  if (!isPlainObject(options)) throw new Error('The broker configuration is missing.');
  const { databaseFile, clientId, clientSecret, publicOrigin, masterKey, fetchImpl = globalThis.fetch, now = Date.now } = options;
  if (typeof databaseFile !== 'string' || databaseFile.length === 0) throw new Error('A broker state file is required.');
  if (!validClientId(clientId)) throw new Error('The broker client identifier is invalid.');
  if (!validClientSecret(clientSecret)) throw new Error('The broker client secret is invalid.');
  const origin = validPublicOrigin(publicOrigin);
  if (!origin) throw new Error('The broker public origin must be an HTTPS origin without a path, query, fragment, or user information.');
  if (typeof fetchImpl !== 'function') throw new Error('A provider fetch implementation is required.');
  if (typeof now !== 'function') throw new Error('A clock is required.');
  const grantTtlMs = boundedInteger(options.grantTtlMs, LIMITS.defaultGrantTtlMs,
    LIMITS.minGrantTtlMs, LIMITS.maxGrantTtlMs, 'grantTtlMs');
  const maintenanceIntervalMs = boundedInteger(options.maintenanceIntervalMs, LIMITS.leaseRenewMs, 0, 60_000, 'maintenanceIntervalMs');
  const providerConcurrency = boundedInteger(options.providerConcurrency, LIMITS.providerConcurrency, 1, LIMITS.providerConcurrency, 'providerConcurrency');
  const providerRatePerSecond = boundedInteger(options.providerRatePerSecond, LIMITS.providerRatePerSecond, 1, LIMITS.providerRatePerSecond, 'providerRatePerSecond');
  const maxSessions = boundedInteger(options.maxSessions, LIMITS.maxSessions, 1, 100_000, 'maxSessions');
  const maxGrants = boundedInteger(options.maxGrants, LIMITS.maxGrants, 1, 100_000, 'maxGrants');
  const maxRefreshOps = boundedInteger(options.maxRefreshOps, LIMITS.maxRefreshOps, 16, 100_000, 'maxRefreshOps');
  const providerTimeoutMs = boundedInteger(options.providerTimeoutMs, LIMITS.providerTimeoutMs, 10, 60_000, 'providerTimeoutMs');
  return {
    databaseFile, clientId, clientSecret, publicOrigin: origin, masterKey: masterKeyBytes(masterKey),
    fetchImpl, now, grantTtlMs, maintenanceIntervalMs, providerConcurrency, providerRatePerSecond,
    maxSessions, maxGrants, maxRefreshOps, providerTimeoutMs,
    redirectUri: `${origin}${NOTION_CALLBACK_PATH}`
  };
}

function cookieName(flowKey) {
  return `__Host-unprompted-notion-${flowKey}`;
}

function cookieHeader(flowKey, value) {
  return `${cookieName(flowKey)}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${LIMITS.cookieTtlSeconds}`;
}

function clearCookieHeader(flowKey) {
  return `${cookieName(flowKey)}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function parseCookies(header) {
  const cookies = new Map();
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!name || cookies.has(name)) throw errors.invalidRequest();
    cookies.set(name, value);
  }
  return cookies;
}

function loopbackRedirect(flow, values, flowKey) {
  if (!validLoopbackRedirectUri(flow.redirectUri) || !validClientState(flow.clientState)) throw errors.invalidGrant();
  const target = new URL(flow.redirectUri);
  target.searchParams.set('state', flow.clientState);
  for (const [name, value] of Object.entries(values)) target.searchParams.set(name, value);
  return { status: 303, redirect: target.href, headers: { 'set-cookie': clearCookieHeader(flowKey) } };
}

async function boundedBody(response, maximum) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new ProviderResponseError();
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximum) {
        try { await reader.cancel(); } catch {}
        throw new ProviderResponseError();
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new ProviderResponseError();
  return text;
}

export class NotionBroker {
  constructor(options) {
    this.config = normalizeConfiguration(options);
    this.store = new NotionBrokerStore({
      databaseFile: this.config.databaseFile,
      clientId: this.config.clientId,
      publicOrigin: this.config.publicOrigin,
      masterKey: this.config.masterKey,
      now: this.config.now,
      maxSessions: this.config.maxSessions,
      maxGrants: this.config.maxGrants,
      maxRefreshOps: this.config.maxRefreshOps
    });
    this.gate = new ProviderGate({
      concurrency: this.config.providerConcurrency,
      ratePerSecond: this.config.providerRatePerSecond,
      now: this.config.now
    });
    this.inflight = new Map();
    this.closing = false;
    this.closed = false;
    this.closePromise = null;
    this.timer = null;
    try {
      this.store.acquireLease(this.now());
    } catch (error) {
      this.store.close();
      throw error;
    }
    if (this.config.maintenanceIntervalMs > 0) {
      this.timer = setInterval(() => { void this.maintenance(); }, this.config.maintenanceIntervalMs);
      this.timer.unref?.();
    }
  }

  now() {
    return this.config.now();
  }

  #ensureServing() {
    if (this.closing || this.closed || this.store.leaseLost || !this.store.isOwner(this.now())) {
      this.store.leaseLost = true;
      throw errors.capacity();
    }
  }

  publicDescriptor() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.config.clientId,
      issuer: this.config.publicOrigin,
      redirectUri: this.config.redirectUri,
      endpoints: { ...PATHS },
      limits: {
        sessionTtlMs: LIMITS.sessionTtlMs,
        handoffTtlMs: LIMITS.handoffTtlMs,
        refreshCacheTtlMs: LIMITS.refreshCacheTtlMs,
        grantTtlMs: this.config.grantTtlMs,
        maxSessions: this.config.maxSessions,
        maxGrants: this.config.maxGrants,
        providerConcurrency: this.config.providerConcurrency,
        providerRatePerSecond: this.config.providerRatePerSecond
      }
    };
  }

  async meta() {
    this.#ensureServing();
    return {
      status: 200,
      json: {
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.config.clientId,
        issuer: this.config.publicOrigin
      }
    };
  }

  async session(body) {
    this.#ensureServing();
    const values = requireSessionRequest(body, this.config.clientId);
    const now = this.now();
    const flowKey = randomBytes(16).toString('base64url');
    const expiresAt = now + LIMITS.sessionTtlMs;
    const { id } = this.store.createSession({ ...values, flowKey, expiresAt, now });
    return {
      status: 200,
      json: {
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.config.clientId,
        authorizeUrl: `${this.config.publicOrigin}${PATHS.authorize}?session=${encodeURIComponent(id)}`,
        expiresAt: new Date(expiresAt).toISOString()
      }
    };
  }

  async authorize({ session, cookieHeader: header }) {
    this.#ensureServing();
    if (!validOpaqueId(session)) throw errors.invalidRequest();
    let row = this.store.getSession(session);
    if (!row) throw errors.invalidRequest();
    let now = this.now();
    if (row.expires_at <= now) throw errors.expired();

    if (row.status === 'pending') {
      const cookieValue = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const claimed = this.store.claimPendingAuthorize({
        id: session,
        oauthStateHash: this.store.hash('oauth-state', state),
        cookieHash: this.store.hash('flow-cookie', cookieValue),
        now
      });
      if (claimed) return this.#authorizeRedirect(row.flow_key, state, cookieValue);
      row = this.store.getSession(session);
    }

    now = this.now();
    if (!row || row.expires_at <= now) throw errors.expired();
    if (row.status !== 'authorizing' || !row.cookie_hash) throw errors.invalidRequest();
    const cookies = parseCookies(header);
    const name = cookieName(row.flow_key);
    const presented = cookies.get(name);
    if (!presented || !safeEqual(this.store.hash('flow-cookie', presented), row.cookie_hash)) {
      throw errors.invalidRequest();
    }
    const state = randomBytes(32).toString('base64url');
    const refreshed = this.store.refreshAuthorizeState({
      id: session,
      oauthStateHash: this.store.hash('oauth-state', state),
      now
    });
    if (!refreshed) throw errors.invalidRequest();
    return this.#authorizeRedirect(row.flow_key, state, presented);
  }

  #authorizeRedirect(flowKey, state, cookieValue) {
    const url = new URL(NOTION_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('owner', 'user');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', state);
    return {
      status: 302,
      redirect: url.href,
      headers: { 'set-cookie': cookieHeader(flowKey, cookieValue) }
    };
  }

  async callback({ query, cookieHeader: header }) {
    this.#ensureServing();
    const now = this.now();
    const state = query.get('state') || '';
    if (!validOpaqueId(state, { min: 43, max: 43 })) throw errors.invalidRequest();
    const row = this.store.getSessionByState(this.store.hash('oauth-state', state));
    if (!row) throw errors.invalidRequest();
    if (row.expires_at <= now) throw errors.expired();
    if (row.status !== 'authorizing') {
      if (row.status === 'exchanging' || row.status === 'ready' || row.status === 'redeemed') throw errors.inProgress();
      throw errors.invalidRequest();
    }

    const cookies = parseCookies(header);
    const name = cookieName(row.flow_key);
    const presented = cookies.get(name);
    if (!presented || !row.cookie_hash || !safeEqual(this.store.hash('flow-cookie', presented), row.cookie_hash)) {
      throw errors.invalidRequest();
    }

    const flow = this.store.sessionFlow(row);
    if (!validLoopbackRedirectUri(flow.redirectUri) || !validClientState(flow.clientState) || !validChallenge(flow.challenge)) {
      throw errors.invalidGrant();
    }

    const hasError = query.has('error');
    const hasCode = query.has('code');
    if (hasError === hasCode) throw errors.invalidRequest();

    if (hasError) {
      const denied = this.store.denySession({ id: row.id, now });
      if (!denied) throw errors.invalidRequest();
      return loopbackRedirect(flow, { error: 'access_denied' }, row.flow_key);
    }

    const code = query.get('code') || '';
    if (!validToken(code) || code.length > 4096) throw errors.invalidRequest();

    const release = this.gate.acquire();
    try {
      if (!this.store.claimCallback({ id: row.id, now })) throw errors.inProgress();
      const controller = new AbortController();
      const key = `session:${row.id}`;
      const promise = this.#exchangeCallback({ row, flow, code, controller });
      this.#track(key, controller, promise);
      try { return await promise; }
      finally { this.#untrack(key); }
    } finally {
      release();
    }
  }

  async #exchangeCallback({ row, flow, code, controller }) {
    let data;
    try {
      data = await this.#providerJSON({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri
      }, controller.signal);
    } catch {
      this.#safeFailSession(row.id);
      throw errors.providerError();
    }

    const now = this.now();
    if (this.closing || this.closed || this.store.leaseLost) throw errors.capacity();
    let parsed;
    try {
      this.store.assertOwner(now);
      parsed = parseTokenResponse(data, { now, requireAccount: true });
    } catch (error) {
      this.#safeFailSession(row.id);
      throw error instanceof ProviderResponseError ? errors.providerError() : error;
    }

    const grantId = randomBytes(24).toString('base64url');
    const handoffId = randomBytes(24).toString('base64url');
    const handoffCode = randomBytes(32).toString('base64url');
    try {
      this.store.completeCallback({
        sessionId: row.id,
        grantId,
        handoffId,
        codeHash: this.store.hash('handoff-code', handoffCode),
        reply: {
          tokens: { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt },
          account: parsed.account
        },
        expiresAt: Math.min(now + LIMITS.handoffTtlMs, row.expires_at),
        now
      });
    } catch (error) {
      if (error instanceof ProviderResponseError) throw errors.providerError();
      throw error;
    }
    return loopbackRedirect(flow, { code: handoffCode }, row.flow_key);
  }

  #safeFailSession(id) {
    try { this.store.failCallback({ id, status: 'failed', now: this.now() }); } catch {}
  }

  async redeem(body) {
    this.#ensureServing();
    const input = requireRedeemRequest(body, this.config.clientId);
    const now = this.now();
    const handoff = this.store.getHandoff(this.store.hash('handoff-code', input.code));
    if (!handoff) throw errors.invalidGrant();
    if (handoff.status !== 'ready') throw errors.invalidGrant();
    if (handoff.expires_at <= now) {
      try { this.store.expireHandoff(handoff.id, now); } catch {}
      throw errors.expired();
    }
    const row = this.store.getSession(handoff.session_id);
    if (!row || row.status !== 'ready') throw errors.invalidGrant();
    const flow = this.store.sessionFlow(row);
    if (!validChallenge(flow.challenge)) throw errors.invalidGrant();
    if (!safeEqual(s256Challenge(input.verifier), flow.challenge)) throw errors.invalidGrant();

    const grantId = handoff.grant_id;
    const proof = refreshProof(input.verifier, grantId);
    const capExpiresAt = now + this.config.grantTtlMs;
    const capability = this.store.signCapability(grantId, capExpiresAt);
    const { tokens, account } = this.store.consumeHandoff({
      handoffId: handoff.id,
      sessionId: row.id,
      grantId,
      proofHash: this.store.hash('refresh-proof', proof),
      capExpiresAt,
      now
    });
    const authorization = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: tokens.expiresAt ?? null,
      account,
      broker: { issuer: this.config.publicOrigin, grantId, refreshCapability: capability }
    };
    return {
      status: 200,
      json: { protocolVersion: PROTOCOL_VERSION, clientId: this.config.clientId, authorization }
    };
  }

  async refresh(body) {
    this.#ensureServing();
    const input = requireRefreshRequest(body, this.config.clientId);
    const now = this.now();
    const capability = this.store.verifyCapability(input.refreshCapability, now);
    if (capability.grantId !== input.grantId) throw errors.invalidGrant();
    const grant = this.store.getGrant(input.grantId);
    if (!grant) throw errors.invalidGrant();
    if (grant.status === 'revoked') throw errors.invalidGrant();
    if (grant.status !== 'active') throw errors.reauthorizationRequired();
    const proofHash = this.store.hash('refresh-proof', input.refreshProof);
    if (!safeEqual(proofHash, grant.proof_hash)) throw errors.invalidGrant();
    if (grant.cap_expires_at <= now) throw errors.expired();

    const oldTokenHash = this.store.hash('refresh-token', input.refreshToken);
    const cached = this.#refreshFromKnownOperation({
      grant, oldTokenHash, now
    });
    if (cached) return cached;
    if (grant.current_refresh_hash == null) throw errors.reauthorizationRequired();
    if (!safeEqual(oldTokenHash, grant.current_refresh_hash)) throw errors.invalidGrant();

    const account = this.store.grantAccount(grant);
    const release = this.gate.acquire();
    try {
      const claim = this.store.claimRefresh({ grantId: grant.id, oldTokenHash, now });
      if (!claim.claimed) {
        const known = this.#refreshFromKnownOperation({ grant, oldTokenHash, now, op: claim.op });
        if (known) return known;
        throw errors.inProgress();
      }
      const controller = new AbortController();
      const key = `refresh:${grant.id}:${oldTokenHash}`;
      const promise = this.#exchangeRefresh({ grant, account, oldTokenHash, refreshToken: input.refreshToken, controller });
      this.#track(key, controller, promise);
      try { return await promise; }
      finally { this.#untrack(key); }
    } finally {
      release();
    }
  }

  #refreshFromKnownOperation({ grant, oldTokenHash, now, op = this.store.getRefreshOp(grant.id, oldTokenHash) }) {
    if (!op) return null;
    if (op.status === 'pending') throw errors.inProgress();
    if (op.status === 'unknown') throw errors.reauthorizationRequired();
    if (op.status === 'done') {
      if (op.expires_at <= now) throw errors.invalidGrant();
      const cached = this.store.cachedRefreshReply({ grantId: grant.id, oldTokenHash, now });
      if (!cached) throw errors.invalidGrant();
      return { status: 200, json: cached };
    }
    throw errors.invalidGrant();
  }

  async #exchangeRefresh({ grant, account, oldTokenHash, refreshToken, controller }) {
    let data;
    try {
      data = await this.#providerJSON({ grant_type: 'refresh_token', refresh_token: refreshToken }, controller.signal);
    } catch {
      this.#safeMarkRefreshUnknown(grant.id, oldTokenHash);
      throw errors.providerError();
    }

    const now = this.now();
    try {
      if (this.closing || this.closed || this.store.leaseLost) throw errors.capacity();
      this.store.assertOwner(now);
      const current = this.store.getGrant(grant.id);
      if (!current || current.status !== 'active' || current.cap_expires_at <= now) throw errors.invalidGrant();
      const op = this.store.getRefreshOp(grant.id, oldTokenHash);
      if (!op || op.status !== 'pending') throw errors.inProgress();

      let parsed;
      try { parsed = parseTokenResponse(data, { now, requireAccount: false }); }
      catch { throw errors.providerError(); }
      if (parsed.account && parsed.account.id !== account.id) throw errors.reauthorizationRequired();

      const newRefreshToken = parsed.refreshToken;
      const newRefreshHash = newRefreshToken == null ? null : this.store.hash('refresh-token', newRefreshToken);
      const tokens = {
        accessToken: parsed.accessToken,
        refreshToken: newRefreshToken,
        expiresAt: parsed.expiresAt
      };
      const capability = this.store.signCapability(grant.id, current.cap_expires_at);
      const reply = authorizationDTO(this.config.clientId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        account
      }, {
        issuer: this.config.publicOrigin,
        grantId: grant.id,
        refreshCapability: capability
      });
      this.store.completeRefresh({
        grantId: grant.id,
        oldTokenHash,
        tokens,
        currentRefreshHash: newRefreshHash,
        reply,
        cacheExpiresAt: now + LIMITS.refreshCacheTtlMs,
        now
      });
      return { status: 200, json: reply };
    } catch (error) {
      this.#safeMarkRefreshUnknown(grant.id, oldTokenHash);
      throw error instanceof ProviderResponseError ? errors.providerError() : error;
    }
  }

  #safeMarkRefreshUnknown(grantId, oldTokenHash) {
    try { this.store.markRefreshUnknown({ grantId, oldTokenHash, now: this.now() }); }
    catch {}
  }

  async revoke(body) {
    this.#ensureServing();
    const input = requireRevokeRequest(body, this.config.clientId);
    const now = this.now();
    const capability = this.store.verifyCapability(input.refreshCapability, now);
    if (capability.grantId !== input.grantId) throw errors.invalidGrant();
    const grant = this.store.getGrant(input.grantId);
    if (!grant) throw errors.invalidGrant();
    const proofHash = this.store.hash('refresh-proof', input.refreshProof);
    if (!safeEqual(proofHash, grant.proof_hash)) throw errors.invalidGrant();
    if (grant.status !== 'revoked') {
      this.store.revokeGrant({ grantId: grant.id, now });
    }
    return {
      status: 200,
      json: { protocolVersion: PROTOCOL_VERSION, clientId: this.config.clientId, revoked: true, grantId: grant.id }
    };
  }

  async cancel(body) {
    this.#ensureServing();
    const input = requireCancelRequest(body, this.config.clientId);
    const now = this.now();
    const row = this.store.getSession(input.session);
    if (!row) throw errors.invalidGrant();
    if (!['pending', 'authorizing', 'exchanging', 'ready'].includes(row.status)) throw errors.invalidGrant();
    const flow = this.store.sessionFlow(row);
    if (!validChallenge(flow.challenge) || !safeEqual(s256Challenge(input.verifier), flow.challenge)) {
      throw errors.invalidGrant();
    }
    const outcome = this.store.cancelSession({ id: row.id, now });
    if (!outcome.cancelled) throw errors.invalidGrant();
    this.#abort(`session:${row.id}`);
    return {
      status: 200,
      json: { protocolVersion: PROTOCOL_VERSION, clientId: this.config.clientId, cancelled: true }
    };
  }

  async #providerJSON(payload, signal) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.config.providerTimeoutMs);
    timer.unref?.();
    const combined = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeout.signal, signal].filter(Boolean))
      : timeout.signal;
    try {
      const response = await this.config.fetchImpl('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, 'utf8').toString('base64')}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'notion-version': NOTION_VERSION
        },
        body: JSON.stringify(payload)
      });
      // A transport is allowed to resolve after cancellation or the deadline.
      // Never parse or publish that result.
      if (combined.aborted) throw new ProviderResponseError();
      if (!response || typeof response !== 'object') throw new ProviderResponseError();
      const text = await boundedBody(response, LIMITS.providerResponseBytes);
      if (combined.aborted) throw new ProviderResponseError();
      if (!(response.status >= 200 && response.status <= 299)) throw new ProviderResponseError();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new ProviderResponseError(); }
      if (!isPlainObject(data)) throw new ProviderResponseError();
      if (combined.aborted) throw new ProviderResponseError();
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  #track(key, controller, promise) {
    const entry = { controller, promise };
    this.inflight.set(key, entry);
    promise.finally(() => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    }).catch(() => {});
  }

  #untrack(key) {
    const entry = this.inflight.get(key);
    if (entry && entry.controller.signal.aborted) this.inflight.delete(key);
  }

  #abort(key) {
    const entry = this.inflight.get(key);
    if (entry) entry.controller.abort();
  }

  #abortAll() {
    for (const entry of this.inflight.values()) {
      try { entry.controller.abort(); } catch {}
    }
  }

  async maintenance() {
    if (this.closing || this.closed) return { renewed: false };
    const now = this.now();
    if (!this.store.renewLease(now)) {
      this.store.leaseLost = true;
      this.#abortAll();
      return { renewed: false };
    }
    try { this.store.purgeExpired(now); }
    catch { return { renewed: true, pruned: false }; }
    return { renewed: true };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closing = true;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      const pending = [...this.inflight.values()].map(entry => entry.promise);
      this.#abortAll();
      await Promise.race([
        Promise.allSettled(pending),
        new Promise(resolve => { const timer = setTimeout(resolve, 250); timer.unref?.(); })
      ]);
      try { this.store.settleOwnPending(this.now()); } catch {}
      this.store.close();
      this.closed = true;
      this.closing = false;
    })();
    return this.closePromise;
  }
}

export function createNotionBroker(options) {
  const broker = new NotionBroker(options);
  return {
    handler: createRequestHandler(broker),
    close: () => broker.close(),
    maintenance: () => broker.maintenance(),
    publicDescriptor: () => broker.publicDescriptor()
  };
}
