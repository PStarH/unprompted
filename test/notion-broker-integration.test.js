import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalSetupStore } from '../src/setup.js';
import { CodeOAuth } from '../src/code-oauth.js';
import { SavedConnectionAuth } from '../src/device-oauth.js';
import { clientConfigurationStates, publicClientConfiguration } from '../src/connection-catalog.js';
import { distributionClientConfiguration } from '../scripts/distribution-clients.mjs';
import { PATHS, PROTOCOL_VERSION, refreshProof } from '../src/notion-broker-protocol.js';

const CLIENT_ID = 'notion-broker-client-1234';
const BROKER = 'https://notion-broker.example.test';
const OTHER_BROKER = 'https://other-broker.example.test';
const SESSION = 's'.repeat(43);
const HANDOFF = 'h'.repeat(43);
const GRANT = 'GRANTMARKER'.repeat(4);
const CAPABILITY = `v1.${'CAPABILITYMARKER'.repeat(2)}.${'m'.repeat(43)}`;
const VERIFIER = 'v'.repeat(43);
const PROOF = refreshProof(VERIFIER, GRANT);
const USER_ID = 'a'.repeat(32);
const WORKSPACE_ID = 'b'.repeat(32);
const OTHER_USER_ID = 'c'.repeat(32);
const ACCOUNT = Object.freeze({ id: `${WORKSPACE_ID}:${USER_ID}`, userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'Ada', workspaceName: 'Notes' });
const OTHER_ACCOUNT = Object.freeze({ id: `${WORKSPACE_ID}:${OTHER_USER_ID}`, userId: OTHER_USER_ID, workspaceId: WORKSPACE_ID, name: 'Grace', workspaceName: 'Notes' });
const ACCESS_TOKEN = ['PRIVATE', 'ACCESS', 'TOKEN', 'MARKER'].join('-');
const NEXT_ACCESS_TOKEN = ['PRIVATE', 'ACCESS', 'TOKEN', 'MARKER', 'NEXT'].join('-');
const REFRESH_TOKEN = ['PRIVATE', 'REFRESH', 'TOKEN', 'MARKER'].join('-');
const NEXT_REFRESH_TOKEN = ['PRIVATE', 'REFRESH', 'TOKEN', 'MARKER', 'NEXT'].join('-');
const OUTSIDE_TOKEN = ['OUTSIDE', 'ACCESS', 'TOKEN', 'MARKER'].join('-');
const PUBLIC_MARKERS = [ACCESS_TOKEN, REFRESH_TOKEN, NEXT_ACCESS_TOKEN, NEXT_REFRESH_TOKEN, 'CAPABILITYMARKER', 'GRANTMARKER', PROOF];
const OWNER_SECRET = 'ownerNotionSecret123';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' }
});
const s256 = value => createHash('sha256').update(value, 'utf8').digest('base64url');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notion-wiring-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'setup.json'), setup: new LocalSetupStore({ filePath: path.join(directory, 'setup.json') }) };
}

async function until(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Fake broker transport. It never performs network I/O; the only real HTTP in
 * these tests is the desktop's own loopback callback listener. */
function brokerTransport({ account = ACCOUNT, issuer = BROKER, grantId = GRANT } = {}) {
  const state = {
    account: { ...account },
    issuer,
    grantId,
    capability: CAPABILITY,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    calls: { begin: 0, redeem: 0, refresh: 0, revoke: 0, cancel: 0 },
    requests: [],
    challenge: null,
    clientState: null,
    redirectUri: null,
    handoff: HANDOFF,
    beginGate: null,
    refreshGate: null,
    redeemError: null,
    refreshError: null,
    redeemResolved: false,
    revokedAuthorizations: []
  };
  const authorization = () => ({
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    authorization: {
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      expiresAt: state.expiresAt,
      account: { ...state.account },
      broker: { issuer: state.issuer, grantId: state.grantId, refreshCapability: state.capability }
    }
  });
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const body = JSON.parse(options.body);
    state.requests.push({ path: parsed.pathname, body, options });
    if (parsed.origin !== BROKER) throw new Error(`unexpected provider network: ${parsed.origin}`);
    if (parsed.pathname === PATHS.session) {
      state.calls.begin += 1;
      const call = state.calls.begin;
      if (state.beginGate && call === 1) await state.beginGate;
      state.challenge = body.codeChallenge;
      state.clientState = body.clientState;
      state.redirectUri = body.redirectUri;
      return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID,
        authorizeUrl: `${BROKER}${PATHS.authorize}?session=${SESSION}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (parsed.pathname === PATHS.redeem) {
      state.calls.redeem += 1;
      if (state.redeemError) return jsonResponse({ error: state.redeemError }, state.redeemError === 'expired' ? 410 : 401);
      if (body.code !== state.handoff || s256(body.verifier) !== state.challenge) return jsonResponse({ error: 'invalid_grant' }, 401);
      return jsonResponse(authorization());
    }
    if (parsed.pathname === PATHS.refresh) {
      state.calls.refresh += 1;
      if (state.refreshGate) await state.refreshGate;
      if (state.refreshError === 'network') throw new TypeError('fake broker transport failure');
      if (state.refreshError) return jsonResponse({ error: state.refreshError },
        { in_progress: 409, provider_error: 502, rate_limited: 429, capacity: 503,
          reauthorization_required: 409, invalid_grant: 401, expired: 410 }[state.refreshError] || 500);
      return jsonResponse(authorization());
    }
    if (parsed.pathname === PATHS.revoke) {
      state.calls.revoke += 1;
      state.revokedAuthorizations.push(body);
      return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: true, grantId: body.grantId });
    }
    if (parsed.pathname === PATHS.cancel) {
      state.calls.cancel += 1;
      return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, cancelled: true });
    }
    throw new Error(`unexpected fake broker path: ${parsed.pathname}`);
  };
  return { state, fetchImpl };
}

function seedBrokerAuthorization(setup, transport, overrides = {}) {
  const saved = setup.saveConnectionBrokerAuthorization('notion', {
    clientId: CLIENT_ID,
    brokerUrl: BROKER,
    broker: { issuer: BROKER, grantId: transport.state.grantId, refreshCapability: CAPABILITY, refreshProof: PROOF },
    accessToken: transport.state.accessToken,
    refreshToken: transport.state.refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    account: { ...transport.state.account, label: 'Ada · Notes' },
    scopes: [],
    ...overrides
  });
  return saved;
}

const loopback = oauth => `http://localhost:${oauth.server.address().port}/oauth/notion`;
const callbackUrl = (oauth, transport, { state = undefined, code = undefined } = {}) => {
  const url = new URL(loopback(oauth));
  url.searchParams.set('code', code ?? transport.state.handoff);
  url.searchParams.set('state', state ?? transport.state.clientState);
  return url.href;
};

test('public parser and distribution accept a secretless Notion broker descriptor and reject ambiguity', () => {
  const descriptor = { notion: { clientId: CLIENT_ID, brokerUrl: BROKER } };
  assert.deepEqual(publicClientConfiguration(descriptor), descriptor);
  assert.deepEqual(clientConfigurationStates(descriptor), {
    github: 'missing', microsoft: 'missing', slack: 'missing', notion: 'configured'
  });
  const distributed = distributionClientConfiguration(descriptor);
  assert.deepEqual(distributed, descriptor);
  assert.notEqual(distributed.notion, descriptor.notion);
  assert.deepEqual(publicClientConfiguration(distributed), descriptor);

  assert.deepEqual(publicClientConfiguration({ notion: { clientId: CLIENT_ID, clientSecret: OWNER_SECRET } }),
    { notion: { clientId: CLIENT_ID, clientSecret: OWNER_SECRET } });
  assert.throws(() => publicClientConfiguration({ notion: { clientId: CLIENT_ID, clientSecret: OWNER_SECRET, brokerUrl: BROKER } }),
    /either a broker descriptor or a client secret/);
  for (const brokerUrl of ['http://notion-broker.example.test', `${BROKER}/callback`, `${BROKER}/?query=1`, `${BROKER}/#fragment`, `https://user:${['pass', 'word'].join('')}@notion-broker.example.test`, 'not a url']) {
    assert.throws(() => publicClientConfiguration({ notion: { clientId: CLIENT_ID, brokerUrl } }), /HTTPS origin|Client ID/);
    assert.equal(clientConfigurationStates({ notion: { clientId: CLIENT_ID, brokerUrl } }).notion, 'invalid');
  }
  assert.throws(() => publicClientConfiguration({ slack: { clientId: '12345.67890', brokerUrl: BROKER } }), /Only Notion/);
  assert.throws(() => distributionClientConfiguration({ notion: { clientId: CLIENT_ID, clientSecret: OWNER_SECRET, brokerUrl: BROKER } }),
    error => error.code === 'ERR_NOTION_CONFIDENTIAL_CLIENT');
});

test('broker consent uses S256 on the loopback, persists a private authorization, and refreshes through the broker', async t => {
  const { setup, file } = fixture(t);
  const broker = brokerTransport();
  setup.saveConnectionBrokerClient('notion', { clientId: CLIENT_ID, brokerUrl: BROKER });
  const connected = [];
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: broker.fetchImpl,
    notionPublicClient: { clientId: CLIENT_ID, brokerUrl: BROKER },
    onConnected: async (id, options) => { connected.push({ id, options }); } });
  t.after(() => oauth.close());

  const started = await oauth.start('notion', {});
  assert.equal(started.phase, 'authorizing');
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.origin, BROKER);
  assert.equal(authorize.pathname, PATHS.authorize);
  assert.deepEqual([...authorize.searchParams.keys()], ['session']);
  const session = oauth.sessions.get('notion');
  assert.equal(session.verifier.length, 43);
  assert.equal(broker.state.challenge, s256(session.verifier));
  assert.equal(broker.state.clientState, session.state);
  assert.match(broker.state.redirectUri, /^http:\/\/localhost:\d+\/oauth\/notion$/);
  assert.equal(JSON.stringify(started).includes(session.verifier), false);
  assert.equal(started.authorizeUrl.includes(session.verifier), false);
  const staged = setup.getConnection('notion');
  assert.deepEqual(staged, { clientId: CLIENT_ID, brokerUrl: BROKER });

  const approved = await fetch(callbackUrl(oauth, broker));
  assert.equal(approved.status, 200);
  assert.match(await approved.text(), /Connection complete/);
  assert.deepEqual(connected, [{ id: 'notion', options: { observe: true } }]);
  assert.equal(oauth.describe('notion').phase, 'connected');

  const saved = setup.getConnection('notion');
  assert.equal(saved.clientId, CLIENT_ID);
  assert.equal(saved.brokerUrl, BROKER);
  assert.equal(saved.accessToken, ACCESS_TOKEN);
  assert.equal(saved.refreshToken, REFRESH_TOKEN);
  assert.equal(saved.clientSecret, undefined);
  assert.equal(saved.broker.issuer, BROKER);
  assert.equal(saved.broker.grantId, GRANT);
  assert.equal(saved.broker.refreshCapability, CAPABILITY);
  assert.match(saved.broker.refreshProof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.account.id, ACCOUNT.id);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(setup.publicConnection('notion'), { clientId: CLIENT_ID, configured: true, authMode: 'broker' });
  const publicSerialized = `${JSON.stringify(setup.publicConnection('notion'))}${JSON.stringify(oauth.describe('notion'))}${JSON.stringify(setup.publicStatus())}`;
  for (const marker of PUBLIC_MARKERS) assert.equal(publicSerialized.includes(marker), false, `public status leaked ${marker}`);

  // A restart reads the saved descriptor and grant; an expired access token is
  // refreshed through the broker with no direct Notion secret.
  broker.state.accessToken = NEXT_ACCESS_TOKEN;
  broker.state.refreshToken = NEXT_REFRESH_TOKEN;
  setup.saveConnectionBrokerAuthorization('notion', { ...saved, expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const auth = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  assert.equal(await auth.accessToken(), NEXT_ACCESS_TOKEN);
  assert.equal(broker.state.calls.refresh, 1);
  const refreshRequest = broker.state.requests.find(request => request.path === PATHS.refresh);
  assert.equal(refreshRequest.body.grantId, GRANT);
  assert.equal(refreshRequest.body.refreshCapability, CAPABILITY);
  assert.equal(refreshRequest.body.refreshProof, saved.broker.refreshProof);
  assert.equal(refreshRequest.body.refreshToken, REFRESH_TOKEN);
  assert.equal(JSON.stringify(refreshRequest.body).includes('client_secret'), false);
  const refreshed = setup.getConnection('notion');
  assert.equal(refreshed.accessToken, NEXT_ACCESS_TOKEN);
  assert.equal(refreshed.refreshToken, NEXT_REFRESH_TOKEN);
  assert.equal(refreshed.clientSecret, undefined);

  setup.clearConnection('notion');
  assert.deepEqual(setup.getConnection('notion'), { clientId: CLIENT_ID, brokerUrl: BROKER });
});

test('an owner-private Notion secret keeps the direct flow even when a broker descriptor is provisioned', async t => {
  const { setup } = fixture(t);
  setup.saveConnectionCredentials('notion', { clientId: CLIENT_ID, clientSecret: OWNER_SECRET });
  const providerCalls = [];
  const oauth = new CodeOAuth(setup, { port: 0,
    notionPublicClient: { clientId: CLIENT_ID, brokerUrl: BROKER },
    fetchImpl: async (url, options) => {
      providerCalls.push({ url, options });
      assert.equal(url, 'https://api.notion.com/v1/oauth/token');
      const decoded = Buffer.from(options.headers.authorization.slice(6), 'base64').toString();
      assert.equal(decoded, `${CLIENT_ID}:${OWNER_SECRET}`);
      return jsonResponse({ access_token: OUTSIDE_TOKEN, workspace_id: WORKSPACE_ID, workspace_name: 'Notes',
        owner: { type: 'user', user: { id: USER_ID, name: 'Ada' } } });
    } });
  t.after(() => oauth.close());

  const started = await oauth.start('notion', {});
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.origin, 'https://api.notion.com');
  assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorize.searchParams.has('code_challenge'), false);
  assert.equal(oauth.sessions.get('notion').mode, undefined);

  const redirect = new URL(authorize.searchParams.get('redirect_uri'));
  const approved = await fetch(`${redirect.origin}${redirect.pathname}?code=owner-code&state=${authorize.searchParams.get('state')}`);
  assert.equal(approved.status, 200);
  await approved.text();
  assert.equal(providerCalls.length, 1);
  const saved = setup.getConnection('notion');
  assert.equal(saved.accessToken, OUTSIDE_TOKEN);
  assert.equal(saved.clientSecret, OWNER_SECRET);
  assert.equal(saved.broker, undefined);
  assert.equal(saved.brokerUrl, undefined);
});

test('wrong state, wrong code and a foreign broker response never save a grant', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  setup.saveConnectionBrokerClient('notion', { clientId: CLIENT_ID, brokerUrl: BROKER });
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: broker.fetchImpl });
  t.after(() => oauth.close());
  await oauth.start('notion', {});
  assert.equal(oauth.sessions.get('notion').mode, 'broker');

  const wrongState = await fetch(callbackUrl(oauth, broker, { state: 'z'.repeat(64) }));
  assert.equal(wrongState.status, 400);
  await wrongState.text();
  assert.equal(broker.state.calls.redeem, 0);
  assert.equal(setup.getConnection('notion').accessToken, undefined);
  assert.equal(oauth.describe('notion').phase, 'authorizing');

  broker.state.redeemError = 'invalid_grant';
  const wrongCode = await fetch(callbackUrl(oauth, broker, { code: 'c'.repeat(43) }));
  assert.equal(wrongCode.status, 400);
  await wrongCode.text();
  assert.equal(broker.state.calls.redeem, 1);
  assert.equal(setup.getConnection('notion').accessToken, undefined);
  assert.equal(oauth.describe('notion').phase, 'failed');

  broker.state.redeemError = null;
  broker.state.issuer = OTHER_BROKER;
  await oauth.start('notion', {});
  const foreign = await fetch(callbackUrl(oauth, broker));
  assert.equal(foreign.status, 400);
  await foreign.text();
  assert.equal(setup.getConnection('notion').accessToken, undefined);
  assert.equal(setup.getConnection('notion').broker, undefined);
});

test('foreign account, grant and issuer on refresh are rejected without overwriting the saved grant', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: broker.fetchImpl });
  t.after(() => oauth.close());

  seedBrokerAuthorization(setup, broker);
  broker.state.account = { ...OTHER_ACCOUNT };
  const foreignAccount = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(foreignAccount.accessToken(), /Reconnect/);
  assert.equal(setup.getConnection('notion').accessToken, ACCESS_TOKEN);
  assert.equal(setup.getConnection('notion').brokerReauthorizationRequired, true);

  broker.state.account = { ...ACCOUNT };
  seedBrokerAuthorization(setup, broker);
  broker.state.grantId = 'DIFFERENTGRANT'.repeat(3);
  const foreignGrant = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(foreignGrant.accessToken(), /Reconnect/);
  assert.equal(setup.getConnection('notion').broker.grantId, GRANT);

  broker.state.grantId = GRANT;
  seedBrokerAuthorization(setup, broker);
  broker.state.issuer = OTHER_BROKER;
  const foreignIssuer = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(foreignIssuer.accessToken(), /Reconnect/);
  assert.equal(setup.getConnection('notion').accessToken, ACCESS_TOKEN);
});

test('cancel and close during begin never install a late broker flow', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  let release;
  broker.state.beginGate = new Promise(resolve => { release = resolve; });
  setup.saveConnectionBrokerClient('notion', { clientId: CLIENT_ID, brokerUrl: BROKER });
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: broker.fetchImpl });
  t.after(() => oauth.close());

  const pending = oauth.start('notion', {});
  await until(() => broker.state.calls.begin === 1, 'broker begin was not called');
  oauth.cancel('notion');
  release();
  const started = await pending;
  assert.equal(started.phase, 'cancelled');
  assert.equal(started.authorizeUrl, undefined);
  assert.equal(oauth.sessions.size, 0);
  assert.deepEqual(setup.getConnection('notion'), { clientId: CLIENT_ID, brokerUrl: BROKER });

  const second = brokerTransport();
  let secondRelease;
  second.state.beginGate = new Promise(resolve => { secondRelease = resolve; });
  const closing = new CodeOAuth(setup, { port: 0, fetchImpl: second.fetchImpl });
  const closingStart = closing.start('notion', {});
  await until(() => second.state.calls.begin === 1, 'second broker begin was not called');
  closing.close();
  secondRelease();
  const closed = await closingStart;
  assert.equal(closed.phase, 'cancelled');
  assert.equal(closing.sessions.size, 0);
  assert.deepEqual(setup.getConnection('notion'), { clientId: CLIENT_ID, brokerUrl: BROKER });
});

test('a new start during begin replaces the pending flow without a late authorization URL', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  let release;
  broker.state.beginGate = new Promise(resolve => { release = resolve; });
  setup.saveConnectionBrokerClient('notion', { clientId: CLIENT_ID, brokerUrl: BROKER });
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: broker.fetchImpl });
  t.after(() => oauth.close());

  const first = oauth.start('notion', {});
  await until(() => broker.state.calls.begin === 1, 'first broker begin was not called');
  const second = await oauth.start('notion', {});
  assert.equal(second.phase, 'authorizing');
  assert.equal(broker.state.calls.begin, 2);
  release();
  await first;
  // The first attempt was retired; it must not install its own flow.
  assert.equal(oauth.sessions.size, 1);
  assert.equal(oauth.describe('notion').authorizeUrl, second.authorizeUrl);
  assert.equal(broker.state.calls.begin, 2);
});

test('a grant redeemed after cancel is never saved and is revoked with a bounded best-effort call', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  setup.saveConnectionBrokerClient('notion', { clientId: CLIENT_ID, brokerUrl: BROKER });
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: broker.fetchImpl });
  t.after(() => oauth.close());
  await oauth.start('notion', {});
  const session = oauth.sessions.get('notion');
  const originalRedeem = session.client.redeem.bind(session.client);
  let releaseRedeem;
  const redeemGate = new Promise(resolve => { releaseRedeem = resolve; });
  session.client.redeem = async input => {
    const result = await originalRedeem(input);
    broker.state.redeemResolved = true;
    await redeemGate;
    return result;
  };

  const callback = fetch(callbackUrl(oauth, broker));
  await until(() => broker.state.redeemResolved, 'broker redeem did not resolve');
  oauth.cancel('notion');
  releaseRedeem();
  const response = await callback;
  assert.equal(response.status, 409);
  assert.match(await response.text(), /cancelled/);
  await until(() => broker.state.calls.revoke === 1, 'late grant was not revoked');
  const revoked = broker.state.revokedAuthorizations[0];
  assert.equal(revoked.protocolVersion, PROTOCOL_VERSION);
  assert.equal(revoked.clientId, CLIENT_ID);
  assert.equal(revoked.grantId, GRANT);
  assert.equal(revoked.refreshCapability, CAPABILITY);
  assert.equal(revoked.refreshProof, refreshProof(session.verifier, GRANT));
  assert.deepEqual(setup.getConnection('notion'), { clientId: CLIENT_ID, brokerUrl: BROKER });
  assert.equal(oauth.describe('notion').phase, 'cancelled');
});

test('a late account replacement or forget during refresh is not overwritten', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);

  let releaseRefresh;
  broker.state.refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  const replacedAuth = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  const replaced = replacedAuth.accessToken();
  await until(() => broker.state.calls.refresh === 1, 'refresh did not start');
  setup.saveConnectionBrokerAuthorization('notion', {
    clientId: CLIENT_ID, brokerUrl: BROKER,
    broker: { issuer: BROKER, grantId: GRANT, refreshCapability: CAPABILITY, refreshProof: PROOF },
    accessToken: OUTSIDE_TOKEN, refreshToken: NEXT_REFRESH_TOKEN,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    account: { ...OTHER_ACCOUNT, label: 'Grace · Notes' }, scopes: []
  });
  releaseRefresh();
  await assert.rejects(replaced, /changed while refreshing/);
  const afterReplacement = setup.getConnection('notion');
  assert.equal(afterReplacement.account.id, OTHER_ACCOUNT.id);
  assert.equal(afterReplacement.accessToken, OUTSIDE_TOKEN);
  assert.equal(afterReplacement.refreshToken, NEXT_REFRESH_TOKEN);

  seedBrokerAuthorization(setup, broker);
  let releaseForget;
  broker.state.refreshGate = new Promise(resolve => { releaseForget = resolve; });
  const forgottenAuth = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  const forgotten = forgottenAuth.accessToken();
  await until(() => broker.state.calls.refresh === 2, 'second refresh did not start');
  setup.clearConnection('notion');
  releaseForget();
  await assert.rejects(forgotten, /changed while refreshing/);
  assert.deepEqual(setup.getConnection('notion'), { clientId: CLIENT_ID, brokerUrl: BROKER });
});

test('an ambiguous refresh failure requires reconnect and never resends the old token; in_progress does not invalidate', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);
  broker.state.refreshError = 'network';
  const first = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(first.accessToken(), /Reconnect/);
  assert.equal(broker.state.calls.refresh, 1);
  assert.equal(setup.getConnection('notion').brokerReauthorizationRequired, true);
  const second = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(second.accessToken(), /Reconnect/);
  assert.equal(broker.state.calls.refresh, 1, 'the old refresh token was sent again');

  seedBrokerAuthorization(setup, broker);
  broker.state.refreshError = 'in_progress';
  const busy = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(busy.accessToken(), /already refreshing/);
  assert.equal(setup.getConnection('notion').brokerReauthorizationRequired, undefined);
  assert.equal(setup.getConnection('notion').accessToken, ACCESS_TOKEN);
});

test('a refreshed null token is honored and never resurrects the previous refresh token', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);
  broker.state.accessToken = NEXT_ACCESS_TOKEN;
  broker.state.refreshToken = null;
  const auth = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  assert.equal(await auth.accessToken(), NEXT_ACCESS_TOKEN);
  assert.equal(setup.getConnection('notion').refreshToken, null);
  setup.saveConnectionBrokerAuthorization('notion', {
    ...setup.getConnection('notion'), expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const expired = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(expired.accessToken(), /Reconnect/);
  assert.equal(broker.state.calls.refresh, 1);
});

test('saving a direct consent over an active broker grant stages a secret without mixing the active record', t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);
  const saved = setup.getConnection('notion');
  assert.equal(saved.accessToken, ACCESS_TOKEN);
  setup.saveConnectionCredentials('notion', { clientId: CLIENT_ID, clientSecret: OWNER_SECRET });
  const staged = setup.getConnection('notion');
  assert.equal(staged.clientSecret, undefined);
  assert.equal(staged.pendingClientSecret, OWNER_SECRET);
  assert.equal(staged.accessToken, ACCESS_TOKEN);
  assert.equal(staged.broker.grantId, GRANT);
  setup.saveConnectionBrokerClient('notion', { clientId: CLIENT_ID, brokerUrl: BROKER });
  assert.equal(setup.getConnection('notion').pendingClientSecret, undefined);
  assert.equal(setup.getConnection('notion').accessToken, ACCESS_TOKEN);
});

test('a dispatched provider_error persists reconnect across restart and never resends the old token', async t => {
  const { setup, file } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);
  broker.state.refreshError = 'provider_error';
  const first = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(first.accessToken(), /Reconnect/);
  assert.equal(broker.state.calls.refresh, 1);
  assert.equal(setup.getConnection('notion').brokerReauthorizationRequired, true);
  assert.equal(setup.getConnection('notion').accessToken, ACCESS_TOKEN);

  broker.state.refreshError = null;
  const restarted = new LocalSetupStore({ filePath: file });
  const afterRestart = new SavedConnectionAuth(restarted, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(afterRestart.accessToken(), /Reconnect/);
  assert.equal(broker.state.calls.refresh, 1, 'restart resent the old refresh token');
  assert.equal(restarted.getConnection('notion').brokerReauthorizationRequired, true);

  // A pre-dispatch rate limit does not invalidate the grant.
  seedBrokerAuthorization(setup, broker);
  broker.state.refreshError = 'rate_limited';
  const limited = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  await assert.rejects(limited.accessToken(), /Reconnect/);
  assert.equal(setup.getConnection('notion').brokerReauthorizationRequired, undefined);
  assert.equal(setup.getConnection('notion').accessToken, ACCESS_TOKEN);
});

test('a same-grant rebind during refresh is not overwritten by a late success', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);
  let release;
  broker.state.refreshGate = new Promise(resolve => { release = resolve; });
  broker.state.accessToken = NEXT_ACCESS_TOKEN;
  const auth = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  const pending = auth.accessToken();
  await until(() => broker.state.calls.refresh === 1, 'refresh did not start');
  const reboundCapability = `v1.${'REBOUNDCAP'.repeat(3)}.${'n'.repeat(43)}`;
  const reboundProof = refreshProof('w'.repeat(43), GRANT);
  setup.saveConnectionBrokerAuthorization('notion', {
    clientId: CLIENT_ID, brokerUrl: BROKER,
    broker: { issuer: BROKER, grantId: GRANT, refreshCapability: reboundCapability, refreshProof: reboundProof },
    accessToken: OUTSIDE_TOKEN, refreshToken: NEXT_REFRESH_TOKEN,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    account: { ...ACCOUNT, label: 'Ada · Notes' }, scopes: []
  });
  release();
  await assert.rejects(pending, /changed while refreshing/);
  const saved = setup.getConnection('notion');
  assert.equal(saved.accessToken, OUTSIDE_TOKEN);
  assert.equal(saved.refreshToken, NEXT_REFRESH_TOKEN);
  assert.equal(saved.broker.refreshCapability, reboundCapability);
  assert.equal(saved.broker.refreshProof, reboundProof);
});

test('a same-grant rebind during an ambiguous refresh does not receive the reconnect mark', async t => {
  const { setup } = fixture(t);
  const broker = brokerTransport();
  seedBrokerAuthorization(setup, broker);
  let release;
  broker.state.refreshGate = new Promise(resolve => { release = resolve; });
  broker.state.refreshError = 'network';
  const auth = new SavedConnectionAuth(setup, 'notion', { fetchImpl: broker.fetchImpl });
  const pending = auth.accessToken();
  await until(() => broker.state.calls.refresh === 1, 'refresh did not start');
  const reboundCapability = `v1.${'REBOUNDCAP'.repeat(3)}.${'n'.repeat(43)}`;
  const reboundProof = refreshProof('w'.repeat(43), GRANT);
  setup.saveConnectionBrokerAuthorization('notion', {
    clientId: CLIENT_ID, brokerUrl: BROKER,
    broker: { issuer: BROKER, grantId: GRANT, refreshCapability: reboundCapability, refreshProof: reboundProof },
    accessToken: OUTSIDE_TOKEN, refreshToken: NEXT_REFRESH_TOKEN,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    account: { ...ACCOUNT, label: 'Ada · Notes' }, scopes: []
  });
  release();
  await assert.rejects(pending, /Reconnect/);
  const saved = setup.getConnection('notion');
  assert.equal(saved.brokerReauthorizationRequired, undefined);
  assert.equal(saved.accessToken, OUTSIDE_TOKEN);
  assert.equal(saved.broker.refreshCapability, reboundCapability);
  assert.equal(saved.broker.refreshProof, reboundProof);
});

test('malformed local broker account DTOs are rejected without persisting bad state', t => {
  const { setup, file } = fixture(t);
  const base = {
    clientId: CLIENT_ID, brokerUrl: BROKER,
    broker: { issuer: BROKER, grantId: GRANT, refreshCapability: CAPABILITY, refreshProof: PROOF },
    accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), scopes: []
  };
  const validAccount = { ...ACCOUNT, label: 'Ada · Notes' };
  const malformed = [
    { ...validAccount, userId: [USER_ID] },
    { ...validAccount, workspaceId: [WORKSPACE_ID] },
    { ...validAccount, id: [ACCOUNT.id] },
    { ...validAccount, label: 42 },
    { ...validAccount, name: ['Ada'] },
    { ...validAccount, userId: { toString() { return USER_ID; } } }
  ];
  for (const account of malformed) {
    assert.throws(() => setup.saveConnectionBrokerAuthorization('notion', { ...base, account }), /verified provider account/);
    assert.deepEqual(setup.getConnection('notion'), {});
  }
  assert.deepEqual(new LocalSetupStore({ filePath: file }).getConnection('notion'), {});
  setup.saveConnectionBrokerAuthorization('notion', { ...base, account: { ...validAccount, injected: { secret: 'bad' } } });
  const saved = setup.getConnection('notion');
  assert.equal(saved.account.label, 'Ada · Notes');
  assert.equal(saved.account.userId, USER_ID);
  assert.equal(saved.account.workspaceId, WORKSPACE_ID);
  assert.equal(saved.account.injected, undefined);
});
