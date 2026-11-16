import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createNotionBroker } from '../broker/notion/service.mjs';
import { NotionBrokerStore } from '../broker/notion/store.mjs';
import { cliConfiguration, listenNotionBroker } from '../broker/notion/server.mjs';
import {
  BrokerError, LIMITS, PATHS, PROTOCOL_VERSION, refreshProof, s256Challenge
} from '../src/notion-broker-protocol.js';

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const CLIENT_SECRET = 'synthetic-notion-client-secret';
const PUBLIC_ORIGIN = 'https://broker.example.test';
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:51234/oauth/notion';
const WORKSPACE_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_A = 'ffffffff-1111-2222-3333-444444444444';
const WORKSPACE_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const USER_B = '99999999-8888-7777-6666-555555555555';

const ACCESS_1 = 'notion-access-token-alpha';
const REFRESH_1 = 'notion-refresh-token-alpha';
const ACCESS_2 = 'notion-access-token-beta';
const REFRESH_2 = 'notion-refresh-token-beta';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function tokenBody(overrides = {}) {
  return {
    access_token: ACCESS_1,
    refresh_token: REFRESH_1,
    expires_in: 3600,
    workspace_id: WORKSPACE_A,
    workspace_name: 'Alpha Workspace',
    owner: { type: 'user', user: { id: USER_A, name: 'Ada Lovelace' } },
    ...overrides
  };
}

function fakeProvider({ exchange, refresh } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url, options, payload });
    const handler = payload.grant_type === 'refresh_token' ? refresh : exchange;
    const fallback = payload.grant_type === 'refresh_token'
      ? tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 })
      : tokenBody();
    const result = typeof handler === 'function' ? await handler(payload, options) : handler ?? fallback;
    return result instanceof Response ? result : jsonResponse(result);
  };
  return { impl, calls };
}

const refreshCalls = provider => provider.calls.filter(call => call.payload.grant_type === 'refresh_token').length;

async function request(base, pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    location: response.headers.get('location'),
    setCookie: response.headers.get('set-cookie')
  };
}

async function startBroker(t, { provider = fakeProvider(), ...overrides } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notion-broker-'));
  const clock = { value: 1_700_000_000_000 };
  const options = {
    databaseFile: path.join(directory, 'broker.sqlite'),
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    masterKey: randomBytes(32),
    fetchImpl: provider.impl,
    now: () => clock.value,
    maintenanceIntervalMs: 0,
    ...overrides
  };
  const broker = createNotionBroker(options);
  const listener = await listenNotionBroker({ broker, port: 0 });
  const environment = {
    broker,
    listener,
    provider,
    directory,
    clock,
    options,
    databaseFile: options.databaseFile,
    base: `http://127.0.0.1:${listener.address.port}`,
    async advance(milliseconds) {
      let remaining = milliseconds;
      while (remaining > 0) {
        const step = Math.min(5000, remaining);
        clock.value += step;
        remaining -= step;
        const result = await broker.maintenance();
        assert.equal(result.renewed, true, 'the test broker lease must remain renewable');
      }
    }
  };
  environment.request = (pathname, requestOptions) => request(environment.base, pathname, requestOptions);
  t.after(async () => {
    await listener.close().catch(() => {});
    await broker.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return environment;
}

async function openReplacement(t, environment, provider) {
  const broker = createNotionBroker({ ...environment.options, fetchImpl: provider.impl });
  const listener = await listenNotionBroker({ broker, port: 0 });
  const base = `http://127.0.0.1:${listener.address.port}`;
  t.after(async () => {
    await listener.close().catch(() => {});
    await broker.close().catch(() => {});
  });
  return { broker, listener, base, request: (pathname, options) => request(base, pathname, options) };
}

function newFlow(overrides = {}) {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    clientState: randomBytes(24).toString('base64url'),
    redirectUri: LOOPBACK_REDIRECT,
    challenge: s256Challenge(verifier),
    ...overrides
  };
}

function sessionBody(flow, overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    codeChallenge: flow.challenge,
    codeChallengeMethod: 'S256',
    redirectUri: flow.redirectUri,
    clientState: flow.clientState,
    ...overrides
  };
}

async function createSession(environment, flow) {
  const response = await environment.request(PATHS.session, { method: 'POST', body: sessionBody(flow) });
  const session = response.json?.authorizeUrl
    ? new URL(response.json.authorizeUrl).searchParams.get('session')
    : null;
  return { response, session };
}

async function authorize(environment, session, cookie) {
  const response = await environment.request(
    `${PATHS.authorize}?session=${encodeURIComponent(session)}`,
    cookie ? { cookie } : {}
  );
  if (response.status !== 302) return { response };
  const location = new URL(response.location);
  const setCookie = response.setCookie || '';
  return {
    response,
    state: location.searchParams.get('state'),
    cookieValue: setCookie.split(';')[0],
    name: setCookie.split('=')[0]
  };
}

async function callback(environment, { state, cookie, code = 'provider-code-1', error } = {}) {
  const params = new URLSearchParams({ state: state || '' });
  if (error !== undefined) params.set('error', error);
  else params.set('code', code);
  const response = await environment.request(`${PATHS.callback}?${params}`, cookie ? { cookie } : {});
  let handoff = null;
  let clientState = null;
  if (response.location) {
    const location = new URL(response.location);
    handoff = location.searchParams.get('code');
    clientState = location.searchParams.get('state');
  }
  return { response, handoff, clientState };
}

async function redeem(environment, flow, code) {
  return environment.request(PATHS.redeem, {
    method: 'POST',
    body: { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, code, verifier: flow.verifier }
  });
}

async function fullFlow(environment, { flow = newFlow(), code = 'provider-code-1' } = {}) {
  const created = await createSession(environment, flow);
  assert.equal(created.response.status, 200, created.response.text);
  const authorized = await authorize(environment, created.session);
  assert.equal(authorized.response.status, 302, authorized.response.text);
  const completed = await callback(environment, { state: authorized.state, cookie: authorized.cookieValue, code });
  assert.equal(completed.response.status, 303, completed.response.text);
  const redeemed = await redeem(environment, flow, completed.handoff);
  assert.equal(redeemed.status, 200, redeemed.text);
  return { flow, session: created.session, authorized, completed, authorization: redeemed.json.authorization };
}

function refreshRequest(authorization, flow, refreshToken = authorization.refreshToken) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    grantId: authorization.broker.grantId,
    refreshCapability: authorization.broker.refreshCapability,
    refreshProof: refreshProof(flow.verifier, authorization.broker.grantId),
    refreshToken
  };
}

function revokeRequest(authorization, flow) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    grantId: authorization.broker.grantId,
    refreshCapability: authorization.broker.refreshCapability,
    refreshProof: refreshProof(flow.verifier, authorization.broker.grantId)
  };
}

function rawRows(file, sql, ...parameters) {
  const database = new Database(file, { readonly: true });
  try { return database.prepare(sql).all(...parameters); }
  finally { database.close(); }
}

function rawExec(file, sql, ...parameters) {
  const database = new Database(file);
  try { database.prepare(sql).run(...parameters); }
  finally { database.close(); }
}

function storageBytes(file) {
  const directory = path.dirname(file);
  const base = path.basename(file);
  return fs.readdirSync(directory)
    .filter(name => name === base || name.startsWith(`${base}-`))
    .map(name => fs.readFileSync(path.join(directory, name)));
}

function assertNotStored(file, values, label = 'state') {
  const buffers = storageBytes(file);
  for (const value of values) {
    const needle = Buffer.from(value, 'utf8');
    assert.equal(buffers.some(buffer => buffer.includes(needle)), false,
      `${label} contained plaintext ${String(value).slice(0, 24)}`);
  }
}

async function waitFor(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('public metadata and descriptor expose no secret and set fixed headers', async t => {
  const environment = await startBroker(t);
  const meta = await environment.request(PATHS.meta);
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.json, { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, issuer: PUBLIC_ORIGIN });
  assert.equal(meta.text.includes(CLIENT_SECRET), false);
  assert.equal(meta.headers.get('access-control-allow-origin'), null);
  assert.equal(meta.headers.get('cache-control'), 'no-store');
  assert.equal(meta.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(meta.headers.get('x-content-type-options'), 'nosniff');

  const descriptor = environment.broker.publicDescriptor();
  assert.equal(descriptor.protocolVersion, PROTOCOL_VERSION);
  assert.equal(descriptor.clientId, CLIENT_ID);
  assert.equal(descriptor.redirectUri, `${PUBLIC_ORIGIN}${PATHS.callback}`);
  assert.equal(JSON.stringify(descriptor).includes(CLIENT_SECRET), false);
  assert.equal(JSON.stringify(descriptor).includes('masterKey'), false);

  const missing = await environment.request('/v1/notion/not-a-route');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'invalid_request');
  const wrongMethod = await environment.request(PATHS.session);
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get('allow'), /POST/);
});

test('full handoff lifecycle keeps credentials out of URLs, cookies and plaintext storage', async t => {
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 })
  });
  const environment = await startBroker(t, { provider });
  const flow = newFlow();

  const created = await createSession(environment, flow);
  assert.equal(created.response.status, 200, created.response.text);
  assert.equal(created.response.json.protocolVersion, PROTOCOL_VERSION);
  assert.equal(created.response.json.clientId, CLIENT_ID);
  assert.equal(new URL(created.response.json.authorizeUrl).origin, PUBLIC_ORIGIN);
  assert.equal(created.response.json.expiresAt, new Date(environment.clock.value + LIMITS.sessionTtlMs).toISOString());
  assert.ok(!created.response.text.includes(CLIENT_SECRET));

  const authorized = await authorize(environment, created.session);
  assert.equal(authorized.response.status, 302);
  const notion = new URL(authorized.response.location);
  assert.equal(notion.origin, 'https://api.notion.com');
  assert.equal(notion.pathname, '/v1/oauth/authorize');
  assert.equal(notion.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(notion.searchParams.get('response_type'), 'code');
  assert.equal(notion.searchParams.get('owner'), 'user');
  assert.equal(notion.searchParams.get('redirect_uri'), `${PUBLIC_ORIGIN}${PATHS.callback}`);
  assert.match(notion.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  for (const forbidden of ['code_challenge', 'code_challenge_method', 'code_verifier', 'client_secret']) {
    assert.equal(notion.searchParams.has(forbidden), false, forbidden);
  }
  assert.ok(!notion.href.includes(CLIENT_SECRET));
  assert.ok(!notion.href.includes(flow.verifier));
  assert.match(authorized.response.setCookie, /^__Host-unprompted-notion-[A-Za-z0-9_-]+=/);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=300']) {
    assert.ok(authorized.response.setCookie.includes(attribute), attribute);
  }

  const completed = await callback(environment, { state: authorized.state, cookie: authorized.cookieValue });
  assert.equal(completed.response.status, 303, completed.response.text);
  const target = new URL(completed.response.location);
  assert.equal(`${target.origin}${target.pathname}`, LOOPBACK_REDIRECT);
  assert.match(completed.handoff, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(target.searchParams.get('state'), flow.clientState);
  assert.equal(target.searchParams.get('code'), completed.handoff);
  assert.ok(!completed.response.location.includes(ACCESS_1));
  assert.ok(!completed.response.location.includes(REFRESH_1));
  assert.ok(completed.response.setCookie.includes('Max-Age=0'));

  assert.equal(provider.calls.length, 1);
  const exchangeCall = provider.calls[0];
  assert.equal(exchangeCall.url, TOKEN_URL);
  assert.equal(exchangeCall.options.method, 'POST');
  assert.equal(exchangeCall.options.redirect, 'error');
  assert.equal(
    Buffer.from(exchangeCall.options.headers.authorization.slice(6), 'base64').toString('utf8'),
    `${CLIENT_ID}:${CLIENT_SECRET}`
  );
  assert.equal(exchangeCall.options.headers['notion-version'], '2026-03-11');
  assert.deepEqual(exchangeCall.payload, {
    grant_type: 'authorization_code', code: 'provider-code-1', redirect_uri: `${PUBLIC_ORIGIN}${PATHS.callback}`
  });

  const wrongVerifier = await redeem(environment, newFlow(), completed.handoff);
  assert.equal(wrongVerifier.status, 401);
  assert.equal(wrongVerifier.json.error, 'invalid_grant');

  const redeemed = await redeem(environment, flow, completed.handoff);
  assert.equal(redeemed.status, 200, redeemed.text);
  const authorization = redeemed.json.authorization;
  assert.equal(authorization.accessToken, ACCESS_1);
  assert.equal(authorization.refreshToken, REFRESH_1);
  assert.equal(authorization.account.id, `${WORKSPACE_A}:${USER_A}`);
  assert.equal(authorization.account.workspaceName, 'Alpha Workspace');
  assert.equal(authorization.broker.issuer, PUBLIC_ORIGIN);
  assert.match(authorization.broker.grantId, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(authorization.broker.refreshCapability.length > 40);
  assert.ok(!redeemed.text.includes(flow.verifier));
  assert.ok(!redeemed.text.includes(CLIENT_SECRET));

  assertNotStored(environment.databaseFile, [
    CLIENT_SECRET, ACCESS_1, REFRESH_1, flow.verifier, flow.challenge,
    flow.clientState, authorized.state, completed.handoff, 'provider-code-1',
    authorization.broker.refreshCapability
  ]);
  const [grantRow] = rawRows(environment.databaseFile, 'SELECT status, current_refresh_hash FROM broker_grants');
  assert.equal(grantRow.status, 'active');
  assert.ok(grantRow.current_refresh_hash);
  assert.notEqual(grantRow.current_refresh_hash, REFRESH_1);

  await environment.advance(1100);
  const refreshed = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(authorization, flow, REFRESH_1)
  });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(refreshed.json.authorization.accessToken, ACCESS_2);
  assert.equal(refreshed.json.authorization.refreshToken, REFRESH_2);
  assert.equal(refreshed.json.authorization.account.id, `${WORKSPACE_A}:${USER_A}`);
  assert.equal(refreshed.json.authorization.broker.grantId, authorization.broker.grantId);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].payload.grant_type, 'refresh_token');
  assert.equal(provider.calls[1].payload.refresh_token, REFRESH_1);
  assert.equal(provider.calls[1].url, TOKEN_URL);
  assert.match(provider.calls[1].options.headers.authorization, /^Basic /);

  await environment.advance(LIMITS.refreshCacheTtlMs + 1000);
  const stale = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(authorization, flow, REFRESH_1)
  });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.error, 'invalid_grant');
  assert.equal(provider.calls.length, 2);

  assertNotStored(environment.databaseFile, [
    CLIENT_SECRET, ACCESS_2, REFRESH_2, flow.verifier, flow.challenge, completed.handoff,
    authorization.broker.refreshCapability
  ]);

  const revoked = await environment.request(PATHS.revoke, {
    method: 'POST', body: revokeRequest(authorization, flow)
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.revoked, true);
  const afterRevoke = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(authorization, flow, REFRESH_2)
  });
  assert.equal(afterRevoke.status, 401);
  assert.equal(provider.calls.length, 2);
});

test('state, browser cookie, callback and handoff proof are one-use', async t => {
  const provider = fakeProvider();
  const environment = await startBroker(t, { provider });
  const flow = newFlow();
  const created = await createSession(environment, flow);
  assert.equal(created.response.status, 200);
  const authorized = await authorize(environment, created.session);
  assert.equal(authorized.response.status, 302);

  const noCookie = await environment.request(`${PATHS.callback}?state=${encodeURIComponent(authorized.state)}&code=provider-code-1`);
  assert.equal(noCookie.status, 400);
  const wrongCookie = await environment.request(
    `${PATHS.callback}?state=${encodeURIComponent(authorized.state)}&code=provider-code-1`,
    { cookie: `${authorized.name}=wrong-cookie-value` }
  );
  assert.equal(wrongCookie.status, 400);
  const duplicateCookie = await environment.request(
    `${PATHS.callback}?state=${encodeURIComponent(authorized.state)}&code=provider-code-1`,
    { cookie: `${authorized.cookieValue}; ${authorized.name}=other-value` }
  );
  assert.equal(duplicateCookie.status, 400);
  const wrongState = await environment.request(
    `${PATHS.callback}?state=${'a'.repeat(43)}&code=provider-code-1`,
    { cookie: authorized.cookieValue }
  );
  assert.equal(wrongState.status, 400);
  assert.equal(provider.calls.length, 0);

  const completed = await callback(environment, { state: authorized.state, cookie: authorized.cookieValue });
  assert.equal(completed.response.status, 303, completed.response.text);
  assert.equal(provider.calls.length, 1);
  const duplicateCallback = await callback(environment, { state: authorized.state, cookie: authorized.cookieValue });
  assert.ok([400, 409].includes(duplicateCallback.response.status));
  assert.equal(provider.calls.length, 1);

  const wrongVerifier = await redeem(environment, newFlow(), completed.handoff);
  assert.equal(wrongVerifier.status, 401);
  const redeemed = await redeem(environment, flow, completed.handoff);
  assert.equal(redeemed.status, 200, redeemed.text);
  const replay = await redeem(environment, flow, completed.handoff);
  assert.equal(replay.status, 401);
  const callbackAfterRedeem = await callback(environment, { state: authorized.state, cookie: authorized.cookieValue });
  assert.ok([400, 409].includes(callbackAfterRedeem.response.status));
  assert.equal(provider.calls.length, 1);

  const deniedFlow = newFlow();
  const deniedSession = await createSession(environment, deniedFlow);
  const deniedAuthorize = await authorize(environment, deniedSession.session);
  const denied = await callback(environment, {
    state: deniedAuthorize.state, cookie: deniedAuthorize.cookieValue, error: 'access_denied'
  });
  assert.equal(denied.response.status, 303, denied.response.text);
  const deniedTarget = new URL(denied.response.location);
  assert.equal(`${deniedTarget.origin}${deniedTarget.pathname}`, LOOPBACK_REDIRECT);
  assert.equal(deniedTarget.searchParams.get('error'), 'access_denied');
  assert.equal(deniedTarget.searchParams.get('state'), deniedFlow.clientState);
  assert.equal(deniedTarget.searchParams.get('code'), null);
  assert.equal(provider.calls.length, 1);
  const [deniedRow] = rawRows(environment.databaseFile, 'SELECT status FROM broker_sessions WHERE id=?', deniedSession.session);
  assert.equal(deniedRow.status, 'denied');
  const [grantCount] = rawRows(environment.databaseFile, 'SELECT COUNT(*) n FROM broker_grants');
  assert.equal(grantCount.n, 1);
});

test('session validation rejects open redirects, malformed fields, duplicate queries and capacity', async t => {
  const environment = await startBroker(t, { maxSessions: 2 });
  const flow = newFlow();
  const base = sessionBody(flow);
  const badRedirects = [
    'https://127.0.0.1:1234/oauth/notion',
    'http://evil.example:1234/oauth/notion',
    'http://127.0.0.1/oauth/notion',
    'http://127.0.0.1:0/oauth/notion',
    'http://127.0.0.1:1234/oauth/notion/',
    'http://127.0.0.1:1234/oauth/notion?x=1',
    'http://user@127.0.0.1:1234/oauth/notion',
    'http://127.1:1234/oauth/notion',
    'http://localhost:1234/oauth/Notion'
  ];
  for (const redirectUri of badRedirects) {
    const response = await environment.request(PATHS.session, { method: 'POST', body: { ...base, redirectUri } });
    assert.equal(response.status, 400, redirectUri);
  }
  const badBodies = [
    { ...base, codeChallenge: 'short' },
    { ...base, codeChallengeMethod: 'plain' },
    { ...base, clientState: 'short' },
    { ...base, protocolVersion: 'other-protocol' },
    { ...base, clientId: 'some-other-client' },
    { ...base, extra: 'field' }
  ];
  for (const body of badBodies) {
    const response = await environment.request(PATHS.session, { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
  const wrongType = await fetch(`${environment.base}${PATHS.session}`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}'
  });
  assert.equal(wrongType.status, 400);
  const oversized = await fetch(`${environment.base}${PATHS.session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, clientState: 'a'.repeat(5000) })
  });
  assert.equal(oversized.status, 400);

  const first = await createSession(environment, newFlow());
  const second = await createSession(environment, newFlow());
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  const third = await createSession(environment, newFlow());
  assert.equal(third.response.status, 503);
  assert.equal(third.response.json.error, 'capacity');

  const duplicate = await environment.request(
    `${PATHS.authorize}?session=${first.session}&session=${second.session}`
  );
  assert.equal(duplicate.status, 400);
  const unknown = await environment.request(`${PATHS.authorize}?session=${first.session}&extra=1`);
  assert.equal(unknown.status, 400);
});

test('expired sessions, handoffs and refresh capabilities fail without provider retries', async t => {
  const provider = fakeProvider({
    refresh: tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 })
  });
  const environment = await startBroker(t, { provider, grantTtlMs: LIMITS.minGrantTtlMs });

  const flowOne = newFlow();
  const expiredSession = await createSession(environment, flowOne);
  rawExec(environment.databaseFile, 'UPDATE broker_sessions SET expires_at=? WHERE id=?',
    environment.clock.value - 1, expiredSession.session);
  const authorizeExpired = await environment.request(
    `${PATHS.authorize}?session=${encodeURIComponent(expiredSession.session)}`
  );
  assert.equal(authorizeExpired.status, 410);
  // Browser routes never return JSON; expiry is reported by the fixed page.
  assert.match(authorizeExpired.text, /Authorization expired/);
  assert.doesNotMatch(authorizeExpired.text, new RegExp(expiredSession.session));

  const flowTwo = newFlow();
  const callbackSession = await createSession(environment, flowTwo);
  const callbackAuthorize = await authorize(environment, callbackSession.session);
  rawExec(environment.databaseFile, 'UPDATE broker_sessions SET expires_at=? WHERE id=?',
    environment.clock.value - 1, callbackSession.session);
  const callbackExpired = await callback(environment, {
    state: callbackAuthorize.state, cookie: callbackAuthorize.cookieValue
  });
  assert.equal(callbackExpired.response.status, 410);
  assert.equal(provider.calls.length, 0);

  const flowThree = newFlow();
  const handoffSession = await createSession(environment, flowThree);
  const handoffAuthorize = await authorize(environment, handoffSession.session);
  const handoffCallback = await callback(environment, {
    state: handoffAuthorize.state, cookie: handoffAuthorize.cookieValue
  });
  assert.equal(handoffCallback.response.status, 303);
  assert.equal(provider.calls.length, 1);
  rawExec(environment.databaseFile, 'UPDATE broker_handoffs SET expires_at=? WHERE status=?',
    environment.clock.value - 1, 'ready');
  const expiredHandoff = await redeem(environment, flowThree, handoffCallback.handoff);
  assert.equal(expiredHandoff.status, 410);
  assert.equal(expiredHandoff.json.error, 'expired');
  assert.equal(provider.calls.length, 1);

  const flowFour = newFlow();
  const completed = await fullFlow(environment, { flow: flowFour });
  const callsBeforeExpiry = provider.calls.length;
  await environment.advance(LIMITS.minGrantTtlMs + 1000);
  const expiredCapability = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(completed.authorization, flowFour, REFRESH_1)
  });
  assert.equal(expiredCapability.status, 410);
  assert.equal(expiredCapability.json.error, 'expired');
  assert.equal(provider.calls.length, callsBeforeExpiry);
});

test('refresh is exactly-once under concurrency and serves a bounded success cache', async t => {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  let refreshProviderCalls = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: async () => {
      refreshProviderCalls += 1;
      await refreshGate;
      return tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 });
    }
  });
  const environment = await startBroker(t, { provider });
  const completed = await fullFlow(environment);
  await environment.advance(1100);
  const body = refreshRequest(completed.authorization, completed.flow, REFRESH_1);

  const first = environment.request(PATHS.refresh, { method: 'POST', body });
  await waitFor(() => refreshProviderCalls === 1, 'the first provider refresh');
  const second = await environment.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.error, 'in_progress');
  assert.equal(second.headers.get('retry-after'), '2');
  assert.equal(refreshProviderCalls, 1);

  releaseRefresh();
  const firstResult = await first;
  assert.equal(firstResult.status, 200, firstResult.text);
  assert.equal(firstResult.json.authorization.accessToken, ACCESS_2);
  assert.equal(refreshProviderCalls, 1);

  const cached = await environment.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(cached.status, 200, cached.text);
  assert.deepEqual(cached.json, firstResult.json);
  assert.equal(refreshProviderCalls, 1);

  await environment.advance(LIMITS.refreshCacheTtlMs + 1000);
  const afterCache = await environment.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(afterCache.status, 401);
  assert.equal(afterCache.json.error, 'invalid_grant');
  assert.equal(refreshProviderCalls, 1);
});

test('grant capability, proof and token cannot cross-bind, and revoke is isolated', async t => {
  let exchanges = 0;
  const provider = fakeProvider({
    exchange: () => {
      exchanges += 1;
      return tokenBody({
        access_token: `notion-access-token-${exchanges}`,
        refresh_token: `notion-refresh-token-${exchanges}`
      });
    },
    refresh: () => tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 })
  });
  const environment = await startBroker(t, { provider });
  const first = await fullFlow(environment);
  await environment.advance(1100);
  const second = await fullFlow(environment);

  const secondBody = refreshRequest(second.authorization, second.flow, 'notion-refresh-token-2');
  const wrongCapability = await environment.request(PATHS.refresh, {
    method: 'POST', body: { ...secondBody, refreshCapability: first.authorization.broker.refreshCapability }
  });
  assert.equal(wrongCapability.status, 401);
  const wrongProof = await environment.request(PATHS.refresh, {
    method: 'POST', body: { ...secondBody, refreshProof: refreshProof(first.flow.verifier, second.authorization.broker.grantId) }
  });
  assert.equal(wrongProof.status, 401);
  const tamperedCapability = second.authorization.broker.refreshCapability.slice(0, -2)
    + (second.authorization.broker.refreshCapability.endsWith('aa') ? 'bb' : 'aa');
  const tampered = await environment.request(PATHS.refresh, {
    method: 'POST', body: { ...secondBody, refreshCapability: tamperedCapability }
  });
  assert.equal(tampered.status, 401);
  const crossToken = await environment.request(PATHS.refresh, {
    method: 'POST', body: { ...secondBody, refreshToken: first.authorization.refreshToken }
  });
  assert.equal(crossToken.status, 401);
  assert.equal(refreshCalls(provider), 0);

  await environment.advance(1100);
  const secondRefreshed = await environment.request(PATHS.refresh, { method: 'POST', body: secondBody });
  assert.equal(secondRefreshed.status, 200, secondRefreshed.text);
  assert.equal(refreshCalls(provider), 1);

  const wrongRevoke = await environment.request(PATHS.revoke, {
    method: 'POST',
    body: {
      ...revokeRequest(first.authorization, first.flow),
      refreshProof: refreshProof(second.flow.verifier, first.authorization.broker.grantId)
    }
  });
  assert.equal(wrongRevoke.status, 401);
  await environment.advance(1100);
  const firstRefreshed = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(first.authorization, first.flow, first.authorization.refreshToken)
  });
  assert.equal(firstRefreshed.status, 200, firstRefreshed.text);
  assert.equal(refreshCalls(provider), 2);

  const revoked = await environment.request(PATHS.revoke, {
    method: 'POST', body: revokeRequest(first.authorization, first.flow)
  });
  assert.equal(revoked.status, 200, revoked.text);
  const firstAfterRevoke = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(firstRefreshed.json.authorization, first.flow, REFRESH_2)
  });
  assert.equal(firstAfterRevoke.status, 401);

  await environment.advance(1100);
  const secondAgain = await environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(secondRefreshed.json.authorization, second.flow, REFRESH_2)
  });
  assert.equal(secondAgain.status, 200, secondAgain.text);
  assert.equal(refreshCalls(provider), 3);
});

test('refresh identity mismatch and provider failure require reauthorization and never resend', async t => {
  let mode = 'identity';
  let providerRefreshCalls = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: () => {
      providerRefreshCalls += 1;
      if (mode === 'identity') {
        return tokenBody({
          access_token: ACCESS_2, refresh_token: REFRESH_2,
          workspace_id: WORKSPACE_B,
          owner: { type: 'user', user: { id: USER_B, name: 'Grace Hopper' } }
        });
      }
      return jsonResponse({ error: 'invalid_grant', error_description: 'provider detail must not leak' }, 400);
    }
  });
  const environment = await startBroker(t, { provider });
  const first = await fullFlow(environment);
  await environment.advance(1100);
  const firstBody = refreshRequest(first.authorization, first.flow, REFRESH_1);
  const mismatch = await environment.request(PATHS.refresh, { method: 'POST', body: firstBody });
  assert.equal(mismatch.status, 409, mismatch.text);
  assert.equal(mismatch.json.error, 'reauthorization_required');
  assert.equal(providerRefreshCalls, 1);
  const retry = await environment.request(PATHS.refresh, { method: 'POST', body: firstBody });
  assert.equal(retry.status, 409);
  assert.equal(retry.json.error, 'reauthorization_required');
  assert.equal(providerRefreshCalls, 1);
  const [grant] = rawRows(environment.databaseFile, 'SELECT status FROM broker_grants WHERE id=?',
    first.authorization.broker.grantId);
  assert.equal(grant.status, 'reauthorization_required');

  const second = await fullFlow(environment);
  await environment.advance(1100);
  mode = 'error';
  const secondBody = refreshRequest(second.authorization, second.flow, REFRESH_1);
  const failed = await environment.request(PATHS.refresh, { method: 'POST', body: secondBody });
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.json.error, 'provider_error');
  assert.ok(!failed.text.includes('provider detail'));
  assert.equal(providerRefreshCalls, 2);
  const failedRetry = await environment.request(PATHS.refresh, { method: 'POST', body: secondBody });
  assert.equal(failedRetry.status, 409);
  assert.equal(failedRetry.json.error, 'reauthorization_required');
  assert.equal(providerRefreshCalls, 2);
});

test('owner lease fences late results and recovery never repeats a dispatched refresh', async t => {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  let providerRefreshCalls = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: async () => {
      providerRefreshCalls += 1;
      await refreshGate;
      return tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 });
    }
  });
  const environment = await startBroker(t, { provider });
  const completed = await fullFlow(environment);
  await environment.advance(1100);

  const pending = environment.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(completed.authorization, completed.flow, REFRESH_1)
  });
  await waitFor(() => providerRefreshCalls === 1, 'the dispatched provider refresh');
  assert.throws(
    () => createNotionBroker({ ...environment.options }),
    /Another broker process owns this state file/
  );

  environment.clock.value += LIMITS.leaseTtlMs + 1;
  const expiredMaintenance = await environment.broker.maintenance();
  assert.equal(expiredMaintenance.renewed, false, 'an expired lease must never be revived');
  const staleBeforeTakeover = await environment.request(PATHS.meta);
  assert.equal(staleBeforeTakeover.status, 503);
  const replacementProvider = fakeProvider();
  const replacement = await openReplacement(t, environment, replacementProvider);
  const [pendingRow] = rawRows(environment.databaseFile,
    "SELECT status FROM broker_refresh_ops WHERE status='unknown'");
  assert.ok(pendingRow, 'takeover must mark the pending refresh unknown');
  const [grantRow] = rawRows(environment.databaseFile, 'SELECT status FROM broker_grants WHERE id=?',
    completed.authorization.broker.grantId);
  assert.equal(grantRow.status, 'reauthorization_required');

  releaseRefresh();
  const late = await pending;
  assert.ok(late.status >= 400, late.text);
  assert.ok(!late.text.includes(ACCESS_2));
  assert.ok(!late.text.includes(REFRESH_2));

  const oldBody = refreshRequest(completed.authorization, completed.flow, REFRESH_1);
  const recovered = await replacement.request(PATHS.refresh, { method: 'POST', body: oldBody });
  assert.equal(recovered.status, 409, recovered.text);
  assert.equal(recovered.json.error, 'reauthorization_required');
  assert.equal(refreshCalls(replacementProvider), 0);

  const staleOwner = await environment.request(PATHS.meta);
  assert.equal(staleOwner.status, 503);
});

test('wrong master key and swapped ciphertext rows fail closed', async t => {
  let exchanges = 0;
  const provider = fakeProvider({
    exchange: () => {
      exchanges += 1;
      return tokenBody({
        access_token: `notion-access-token-${exchanges}`,
        refresh_token: `notion-refresh-token-${exchanges}`
      });
    }
  });
  const environment = await startBroker(t, { provider });
  const first = await fullFlow(environment);
  await environment.advance(1100);
  const second = await fullFlow(environment);
  await environment.broker.close();

  assert.throws(
    () => createNotionBroker({ ...environment.options, masterKey: randomBytes(32) }),
    /does not match the configured client, origin, or master key/
  );

  const database = new Database(environment.databaseFile);
  try {
    database.prepare('UPDATE broker_grants SET enc_account=(SELECT enc_account FROM broker_grants WHERE id=?) WHERE id=?')
      .run(second.authorization.broker.grantId, first.authorization.broker.grantId);
  } finally {
    database.close();
  }

  const replacementProvider = fakeProvider();
  const replacement = await openReplacement(t, environment, replacementProvider);
  const swapped = await replacement.request(PATHS.refresh, {
    method: 'POST', body: refreshRequest(first.authorization, first.flow, 'synthetic-wrong-token-c7')
  });
  assert.equal(swapped.status, 401, swapped.text);
  assert.equal(swapped.json.error, 'invalid_grant');
  assert.equal(refreshCalls(replacementProvider), 0);
});

test('cancel aborts an in-flight browser exchange and delivers nothing', async t => {
  let exchangeCalls = 0;
  let releaseExchange;
  const exchangeGate = new Promise(resolve => { releaseExchange = resolve; });
  const provider = fakeProvider({
    exchange: async () => {
      exchangeCalls += 1;
      await exchangeGate;
      return tokenBody();
    }
  });
  const environment = await startBroker(t, { provider });
  const flow = newFlow();
  const created = await createSession(environment, flow);
  const authorized = await authorize(environment, created.session);

  const pending = environment.request(
    `${PATHS.callback}?state=${encodeURIComponent(authorized.state)}&code=provider-code-1`,
    { cookie: authorized.cookieValue }
  );
  await waitFor(() => exchangeCalls === 1, 'the in-flight exchange');

  const wrongCancel = await environment.request(PATHS.cancel, {
    method: 'POST',
    body: { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, session: created.session, verifier: randomBytes(32).toString('base64url') }
  });
  assert.equal(wrongCancel.status, 401);
  const cancelled = await environment.request(PATHS.cancel, {
    method: 'POST',
    body: { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, session: created.session, verifier: flow.verifier }
  });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.cancelled, true);

  releaseExchange();
  const late = await pending;
  assert.notEqual(late.status, 303, late.text);
  assert.ok(!late.text.includes(ACCESS_1));
  assert.ok(!late.text.includes(REFRESH_1));
  assert.equal(exchangeCalls, 1);
  const [handoffCount] = rawRows(environment.databaseFile, 'SELECT COUNT(*) n FROM broker_handoffs');
  assert.equal(handoffCount.n, 0);
  const [sessionRow] = rawRows(environment.databaseFile, 'SELECT status FROM broker_sessions WHERE id=?', created.session);
  assert.equal(sessionRow.status, 'cancelled');
  const repeatCancel = await environment.request(PATHS.cancel, {
    method: 'POST',
    body: { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, session: created.session, verifier: flow.verifier }
  });
  assert.equal(repeatCancel.status, 401);
});

test('CLI configuration fails before listen and browser errors never reflect provider text', async t => {
  assert.throws(() => cliConfiguration({}), /NOTION_BROKER_CLIENT_ID/);
  const validEnvironment = {
    NOTION_BROKER_CLIENT_ID: CLIENT_ID,
    NOTION_BROKER_CLIENT_SECRET: CLIENT_SECRET,
    NOTION_BROKER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    NOTION_BROKER_MASTER_KEY: randomBytes(32).toString('base64'),
    NOTION_BROKER_STATE_FILE: path.join(os.tmpdir(), 'unprompted-notion-broker-cli.sqlite')
  };
  const configuration = cliConfiguration(validEnvironment);
  assert.equal(configuration.host, '127.0.0.1');
  assert.equal(configuration.port, 9043);
  assert.throws(() => cliConfiguration({ ...validEnvironment, NOTION_BROKER_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => cliConfiguration({ ...validEnvironment, NOTION_BROKER_PORT: '0' }), /between 1 and 65535/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notion-broker-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseOptions = {
    databaseFile: path.join(directory, 'state.sqlite'),
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    masterKey: randomBytes(32),
    fetchImpl: async () => jsonResponse({}),
    maintenanceIntervalMs: 0
  };
  assert.throws(() => createNotionBroker({ ...baseOptions, publicOrigin: 'http://broker.example.test' }), /HTTPS/);
  assert.throws(() => createNotionBroker({ ...baseOptions, masterKey: 'short' }), /master key/);

  const provider = fakeProvider({
    exchange: () => jsonResponse({
      error: 'invalid_request',
      error_description: '<script>alert(1)</script>',
      state: 'provider-reflected-state'
    }, 400)
  });
  const environment = await startBroker(t, { provider });
  const flow = newFlow();
  const created = await createSession(environment, flow);
  const authorized = await authorize(environment, created.session);
  const failed = await callback(environment, { state: authorized.state, cookie: authorized.cookieValue });
  assert.equal(failed.response.status, 502);
  assert.ok(failed.response.text.includes('Authorization could not be completed'));
  assert.ok(!failed.response.text.includes('<script'));
  assert.ok(!failed.response.text.includes('invalid_request'));
  assert.ok(!failed.response.text.includes(authorized.state));
  assert.equal(failed.response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(failed.response.headers.get('cache-control'), 'no-store');
  assert.equal(failed.response.headers.get('referrer-policy'), 'no-referrer');

  const secondFlow = newFlow();
  const secondSession = await createSession(environment, secondFlow);
  const secondAuthorize = await authorize(environment, secondSession.session);
  const duplicateQuery = await environment.request(
    `${PATHS.callback}?state=${secondAuthorize.state}&state=${secondAuthorize.state}&code=x`,
    { cookie: secondAuthorize.cookieValue }
  );
  assert.equal(duplicateQuery.status, 400);
  const duplicateCookie = await environment.request(
    `${PATHS.callback}?state=${encodeURIComponent(secondAuthorize.state)}&code=x`,
    { cookie: `${secondAuthorize.cookieValue}; ${secondAuthorize.name}=other` }
  );
  assert.equal(duplicateCookie.status, 400);
  const longUrl = await environment.request(`${PATHS.meta}?padding=${'a'.repeat(9000)}`);
  assert.equal(longUrl.status, 400);
  assert.equal(provider.calls.length, 1);
});

test('graceful close marks a dispatched refresh unknown and reopening never resends', async t => {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  let providerRefreshCalls = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: async () => {
      providerRefreshCalls += 1;
      await refreshGate;
      return tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 });
    }
  });
  const environment = await startBroker(t, { provider });
  const completed = await fullFlow(environment);
  await environment.advance(1100);
  const body = refreshRequest(completed.authorization, completed.flow, REFRESH_1);
  const pending = environment.request(PATHS.refresh, { method: 'POST', body });
  await waitFor(() => providerRefreshCalls === 1, 'the dispatched refresh');
  await environment.broker.close();
  releaseRefresh();
  const late = await pending.catch(error => error);
  if (late && late.text !== undefined) {
    assert.ok(late.status >= 400, late.text);
    assert.ok(!late.text.includes(ACCESS_2));
    assert.ok(!late.text.includes(REFRESH_2));
  }
  const [unknown] = rawRows(environment.databaseFile,
    "SELECT status FROM broker_refresh_ops WHERE status='unknown'");
  assert.ok(unknown, 'graceful close must persist an unknown refresh claim');
  const [grant] = rawRows(environment.databaseFile, 'SELECT status FROM broker_grants WHERE id=?',
    completed.authorization.broker.grantId);
  assert.equal(grant.status, 'reauthorization_required');
  const replacementProvider = fakeProvider();
  const replacement = await openReplacement(t, environment, replacementProvider);
  const recovered = await replacement.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(recovered.status, 409, recovered.text);
  assert.equal(recovered.json.error, 'reauthorization_required');
  assert.equal(refreshCalls(replacementProvider), 0);
});

test('revoke during a dispatched refresh prevents late token delivery', async t => {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  let providerRefreshCalls = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: async () => {
      providerRefreshCalls += 1;
      await refreshGate;
      return tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 });
    }
  });
  const environment = await startBroker(t, { provider });
  const completed = await fullFlow(environment);
  await environment.advance(1100);
  const body = refreshRequest(completed.authorization, completed.flow, REFRESH_1);
  const pending = environment.request(PATHS.refresh, { method: 'POST', body });
  await waitFor(() => providerRefreshCalls === 1, 'the dispatched refresh');
  const revoked = await environment.request(PATHS.revoke, {
    method: 'POST', body: revokeRequest(completed.authorization, completed.flow)
  });
  assert.equal(revoked.status, 200, revoked.text);
  releaseRefresh();
  const late = await pending;
  assert.ok(late.status >= 400, late.text);
  assert.ok(!late.text.includes(ACCESS_2));
  assert.ok(!late.text.includes(REFRESH_2));
  assert.equal(providerRefreshCalls, 1);
  const after = await environment.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(after.status, 401);
  assert.equal(refreshCalls(provider), 1);
  const [grant] = rawRows(environment.databaseFile, 'SELECT status FROM broker_grants WHERE id=?',
    completed.authorization.broker.grantId);
  assert.equal(grant.status, 'revoked');
});

test('a handoff is bounded by its parent session and both must be live to redeem', async t => {
  const environment = await startBroker(t);
  const flow = newFlow();
  const created = await createSession(environment, flow);
  assert.equal(created.response.status, 200, created.response.text);
  const parentExpiry = environment.clock.value + 100;
  rawExec(environment.databaseFile, 'UPDATE broker_sessions SET expires_at=? WHERE id=?',
    parentExpiry, created.session);
  const authorized = await authorize(environment, created.session);
  assert.equal(authorized.response.status, 302, authorized.response.text);
  const completed = await callback(environment, {
    state: authorized.state, cookie: authorized.cookieValue
  });
  assert.equal(completed.response.status, 303, completed.response.text);
  const [handoff] = rawRows(environment.databaseFile,
    "SELECT expires_at, status FROM broker_handoffs WHERE status='ready'");
  assert.equal(handoff.expires_at, parentExpiry, 'handoff expiry must not outlive its session');

  environment.clock.value += 101;
  // Force the handoff to look live for longer than its parent. The consume
  // transaction must still reject it because the session has expired.
  rawExec(environment.databaseFile, 'UPDATE broker_handoffs SET expires_at=? WHERE status=?',
    environment.clock.value + LIMITS.handoffTtlMs, 'ready');
  const redeemed = await redeem(environment, flow, completed.handoff);
  assert.equal(redeemed.status, 410, redeemed.text);
  assert.equal(redeemed.json.error, 'expired');
  const [grantCount] = rawRows(environment.databaseFile, 'SELECT COUNT(*) n FROM broker_grants');
  assert.equal(grantCount.n, 0);
  const [handoffRow] = rawRows(environment.databaseFile,
    "SELECT status FROM broker_handoffs WHERE status='ready'");
  assert.ok(handoffRow, 'a rejected redeem must not consume the handoff');
});

test('an omitted refresh token is explicit null and never resurrects the old token', async t => {
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: tokenBody({ access_token: ACCESS_2, refresh_token: undefined })
  });
  const environment = await startBroker(t, { provider });
  const completed = await fullFlow(environment);
  await environment.advance(1100);
  const firstBody = refreshRequest(completed.authorization, completed.flow, REFRESH_1);
  const refreshed = await environment.request(PATHS.refresh, { method: 'POST', body: firstBody });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(Object.hasOwn(refreshed.json.authorization, 'refreshToken'), true);
  assert.equal(refreshed.json.authorization.refreshToken, null);
  const [grant] = rawRows(environment.databaseFile,
    'SELECT status, current_refresh_hash FROM broker_grants WHERE id=?',
    completed.authorization.broker.grantId);
  assert.equal(grant.status, 'active');
  assert.equal(grant.current_refresh_hash, null);
  assert.equal(refreshCalls(provider), 1);

  await environment.advance(LIMITS.refreshCacheTtlMs + 1000);
  // The expired done-operation row still knows the old token, but its cached
  // reply is gone. The old token is rejected without a provider call; it is
  // never treated as current again.
  const retry = await environment.request(PATHS.refresh, { method: 'POST', body: firstBody });
  assert.equal(retry.status, 401, retry.text);
  assert.equal(retry.json.error, 'invalid_grant');
  assert.equal(refreshCalls(provider), 1, 'the old refresh token must not be resent');
  const otherBody = refreshRequest(completed.authorization, completed.flow, 'some-other-refresh-token');
  const other = await environment.request(PATHS.refresh, { method: 'POST', body: otherBody });
  assert.equal(other.status, 409, other.text);
  assert.equal(other.json.error, 'reauthorization_required');
  assert.equal(refreshCalls(provider), 1);
});

test('a provider body that resolves after the deadline cannot publish a callback', async t => {
  let exchangeCalls = 0;
  const provider = {
    impl: async () => {
      exchangeCalls += 1;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => {
          await delay(80);
          return JSON.stringify(tokenBody());
        }
      };
    }
  };
  const environment = await startBroker(t, { provider, providerTimeoutMs: 20 });
  const flow = newFlow();
  const created = await createSession(environment, flow);
  const authorized = await authorize(environment, created.session);
  assert.equal(authorized.response.status, 302, authorized.response.text);
  const completed = await callback(environment, {
    state: authorized.state, cookie: authorized.cookieValue
  });
  assert.equal(completed.response.status, 502, completed.response.text);
  assert.equal(exchangeCalls, 1);
  assert.equal(completed.handoff, null);
  const [sessionRow] = rawRows(environment.databaseFile,
    'SELECT status FROM broker_sessions WHERE id=?', created.session);
  assert.equal(sessionRow.status, 'failed');
  const [handoffs] = rawRows(environment.databaseFile, 'SELECT COUNT(*) n FROM broker_handoffs');
  assert.equal(handoffs.n, 0);
  const [grants] = rawRows(environment.databaseFile, 'SELECT COUNT(*) n FROM broker_grants');
  assert.equal(grants.n, 0);
});

test('a refresh response that resolves after the deadline marks reauthorization without delivery', async t => {
  let refreshDispatches = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: async () => {
      refreshDispatches += 1;
      await delay(80);
      return tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 });
    }
  });
  const environment = await startBroker(t, { provider, providerTimeoutMs: 20 });
  const completed = await fullFlow(environment);
  await environment.advance(1100);
  const body = refreshRequest(completed.authorization, completed.flow, REFRESH_1);
  const timedOut = await environment.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(timedOut.status, 502, timedOut.text);
  assert.equal(timedOut.json.error, 'provider_error');
  assert.equal(timedOut.text.includes(ACCESS_2), false);
  assert.equal(timedOut.text.includes(REFRESH_2), false);
  assert.equal(refreshDispatches, 1);
  const [grant] = rawRows(environment.databaseFile,
    'SELECT status FROM broker_grants WHERE id=?', completed.authorization.broker.grantId);
  assert.equal(grant.status, 'reauthorization_required');
  const retry = await environment.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(retry.status, 409, retry.text);
  assert.equal(retry.json.error, 'reauthorization_required');
  assert.equal(refreshDispatches, 1);
});

test('completeRefresh reports a typed in-progress conflict for a non-pending claim', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notion-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = 1_700_000_000_000;
  const databaseFile = path.join(directory, 'store.sqlite');
  const store = new NotionBrokerStore({
    databaseFile,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    masterKey: randomBytes(32),
    now: () => now
  });
  t.after(() => store.close());
  store.acquireLease(now);
  const grantId = randomBytes(16).toString('base64url');
  rawExec(databaseFile,
    `INSERT INTO broker_grants(id, session_id, proof_hash, initial_refresh_hash,
      current_refresh_hash, enc_account, enc_tokens, status, cap_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?, ?)`,
    grantId, randomBytes(16).toString('base64url'), 'proof-hash', 'old-refresh-hash',
    'old-refresh-hash', now + 60_000, now, now);
  rawExec(databaseFile,
    `INSERT INTO broker_refresh_ops(grant_id, old_token_hash, status, enc_reply,
      created_at, updated_at, expires_at) VALUES (?, ?, 'done', NULL, ?, ?, ?)`,
    grantId, 'old-refresh-hash', now, now, now + 120_000);
  assert.throws(
    () => store.completeRefresh({
      grantId,
      oldTokenHash: 'old-refresh-hash',
      tokens: { accessToken: ACCESS_2, refreshToken: REFRESH_2 },
      currentRefreshHash: 'new-refresh-hash',
      reply: { ok: true },
      cacheExpiresAt: now + 120_000,
      now
    }),
    error => error instanceof BrokerError && error.code === 'in_progress' && error.status === 409
  );
});

test('close after lease expiry leaves no row, and the next acquisition recovers pending claims', async t => {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  let providerRefreshCalls = 0;
  const provider = fakeProvider({
    exchange: tokenBody(),
    refresh: async () => {
      providerRefreshCalls += 1;
      await refreshGate;
      return tokenBody({ access_token: ACCESS_2, refresh_token: REFRESH_2 });
    }
  });
  const environment = await startBroker(t, { provider });
  const completed = await fullFlow(environment);
  await environment.advance(1100);
  const body = refreshRequest(completed.authorization, completed.flow, REFRESH_1);
  const pending = environment.request(PATHS.refresh, { method: 'POST', body });
  await waitFor(() => providerRefreshCalls === 1, 'the dispatched refresh');
  environment.clock.value += LIMITS.leaseTtlMs + 1;
  await environment.broker.close();
  releaseRefresh();
  await pending.catch(() => {});
  const [pendingRow] = rawRows(environment.databaseFile,
    "SELECT status FROM broker_refresh_ops WHERE status='pending'");
  assert.ok(pendingRow, 'a failed settle must leave the claim pending before recovery');
  const [leaseRows] = rawRows(environment.databaseFile, 'SELECT COUNT(*) n FROM broker_lease');
  assert.equal(leaseRows.n, 0, 'close releases its expired lease row');

  const replacementProvider = fakeProvider();
  const replacement = await openReplacement(t, environment, replacementProvider);
  const [recoveredOp] = rawRows(environment.databaseFile,
    "SELECT status FROM broker_refresh_ops WHERE status='unknown'");
  assert.ok(recoveredOp, 'acquisition must recover a pending claim even with no prior lease row');
  const [grant] = rawRows(environment.databaseFile,
    'SELECT status FROM broker_grants WHERE id=?', completed.authorization.broker.grantId);
  assert.equal(grant.status, 'reauthorization_required');
  const retried = await replacement.request(PATHS.refresh, { method: 'POST', body });
  assert.equal(retried.status, 409, retried.text);
  assert.equal(retried.json.error, 'reauthorization_required');
  assert.equal(refreshCalls(replacementProvider), 0, 'recovery must never redispatch');
});

test('an existing shared state directory is refused and never chmodded', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX directory modes are not enforced on Windows');
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notion-modes-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const shared = path.join(parent, 'shared');
  fs.mkdirSync(shared, { mode: 0o755 });
  fs.chmodSync(shared, 0o755);
  const baseOptions = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    masterKey: randomBytes(32),
    fetchImpl: async () => jsonResponse({}),
    maintenanceIntervalMs: 0
  };
  assert.throws(
    () => createNotionBroker({ ...baseOptions, databaseFile: path.join(shared, 'state.sqlite') }),
    /mode 700/
  );
  assert.equal(fs.statSync(shared).mode & 0o777, 0o755,
    'the broker must not chmod an existing shared parent');
  const missing = path.join(parent, 'private', 'nested');
  const broker = createNotionBroker({
    ...baseOptions, databaseFile: path.join(missing, 'state.sqlite')
  });
  t.after(() => broker.close());
  assert.equal(fs.statSync(missing).mode & 0o777, 0o700);
});
