import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NotionBrokerClient, NotionBrokerClientError } from '../src/notion-broker-client.js';
import { LIMITS, PATHS, PROTOCOL_VERSION, refreshProof } from '../src/notion-broker-protocol.js';

const CLIENT_ID = 'desktop-client-1234';
const BROKER = 'https://broker.example.test';
const REDIRECT = 'http://127.0.0.1:53682/oauth/notion';
const STATE = 's'.repeat(43);
const VERIFIER = 'v'.repeat(43);
const CODE = 'c'.repeat(43);
const SESSION = 'q'.repeat(43);
const GRANT = 'g'.repeat(32);
const CAPABILITY = `v1.${'p'.repeat(32)}.${'m'.repeat(43)}`;
const USER_ID = 'a'.repeat(32);
const WORKSPACE_ID = 'b'.repeat(32);
const ACCOUNT_ID = `${WORKSPACE_ID}:${USER_ID}`;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ACCESS_TOKEN = ['access', 'token', 'value'].join('-');
const REFRESH_TOKEN = ['refresh', 'token', 'value'].join('-');
const NEXT_REFRESH_TOKEN = ['next', 'refresh', 'token'].join('-');
const PROOF = refreshProof(VERIFIER, GRANT);

const iso = ms => new Date(ms).toISOString();
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

function queueFetch(...handlers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({
      url,
      options,
      body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
    });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (!handler) throw new Error('unexpected fake transport call');
    return handler(url, options);
  };
  return { calls, fetchImpl };
}

const makeClient = (fetchImpl, overrides = {}) => new NotionBrokerClient({
  clientId: CLIENT_ID,
  brokerUrl: BROKER,
  fetchImpl,
  now: () => NOW,
  ...overrides
});

const accountPayload = (overrides = {}) => ({
  id: ACCOUNT_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  name: 'Ada',
  workspaceName: 'Notes',
  ...overrides
});

const brokerPayload = (overrides = {}) => ({
  issuer: BROKER,
  grantId: GRANT,
  refreshCapability: CAPABILITY,
  ...overrides
});

const authorizationPayload = (overrides = {}) => ({
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresAt: iso(NOW + 3_600_000),
  account: accountPayload(),
  broker: brokerPayload(),
  ...overrides
});

const redeemResponse = (authorizationOverrides = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  clientId: CLIENT_ID,
  authorization: authorizationPayload(authorizationOverrides)
});

const refreshResponse = (authorizationOverrides = {}) => redeemResponse(authorizationOverrides);

const beginResponse = (overrides = {}) => ({
  protocolVersion: PROTOCOL_VERSION,
  clientId: CLIENT_ID,
  authorizeUrl: `${BROKER}${PATHS.authorize}?session=${SESSION}`,
  expiresAt: iso(NOW + 60_000),
  ...overrides
});

const privateAuthorization = () => ({
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresAt: iso(NOW + 3_600_000),
  account: { ...accountPayload(), label: 'Ada · Notes' },
  broker: { ...brokerPayload(), refreshProof: PROOF }
});

const expectedChallenge = verifier => createHash('sha256').update(verifier, 'utf8').digest('base64url');
const expectedProof = (verifier, grantId) => createHash('sha256')
  .update('unprompted-notion-refresh-v1\0', 'utf8')
  .update(verifier, 'utf8')
  .update('\0', 'utf8')
  .update(grantId, 'utf8')
  .digest('base64url');

const isClientError = code => error => {
  assert.ok(error instanceof NotionBrokerClientError);
  assert.equal(error.name, 'NotionBrokerClientError');
  assert.equal(error.code, code);
  return true;
};

test('constructor validates configuration and exposes only the public descriptor', () => {
  const fetchImpl = async () => { throw new Error('never called'); };
  const base = { clientId: CLIENT_ID, brokerUrl: BROKER, fetchImpl, now: () => NOW };
  const invalid = [
    { ...base, clientId: 'short' },
    { ...base, clientId: 'client id with spaces' },
    { ...base, brokerUrl: 'http://broker.example.test' },
    { ...base, brokerUrl: 'https://user:' + ['pass', 'word'].join('') + '@broker.example.test' },
    { ...base, brokerUrl: 'https://broker.example.test/path' },
    { ...base, brokerUrl: 'https://broker.example.test/?query=1' },
    { ...base, brokerUrl: 'https://broker.example.test/#fragment' },
    { ...base, fetchImpl: null },
    { ...base, now: null },
    { ...base, timeoutMs: 0 },
    { ...base, timeoutMs: 60_001 },
    { ...base, timeoutMs: 1.5 }
  ];
  for (const options of invalid) assert.throws(() => new NotionBrokerClient(options), isClientError('invalid_configuration'));
  const client = new NotionBrokerClient({ ...base, brokerUrl: `${BROKER}/` });
  assert.deepEqual(client.descriptor, { clientId: CLIENT_ID, brokerUrl: BROKER });
  assert.deepEqual(Object.keys(client.descriptor), ['clientId', 'brokerUrl']);
  assert.equal(Object.isFrozen(client.descriptor), true);
});

test('begin posts the exact S256 request, keeps the verifier local, and validates the response', async () => {
  const { calls, fetchImpl } = queueFetch(() => jsonResponse(beginResponse()));
  const client = makeClient(fetchImpl);
  const result = await client.begin({ redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER });
  assert.equal(calls.length, 1);
  const { url, options, body } = calls[0];
  assert.equal(url, `${BROKER}${PATHS.session}`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, { accept: 'application/json', 'content-type': 'application/json' });
  assert.equal(options.headers.authorization, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(body, {
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    codeChallenge: expectedChallenge(VERIFIER),
    codeChallengeMethod: 'S256',
    redirectUri: REDIRECT,
    clientState: STATE
  });
  assert.equal(JSON.stringify(body).includes(VERIFIER), false);
  assert.equal(url.includes(VERIFIER), false);
  assert.deepEqual(result, {
    session: SESSION,
    authorizeUrl: `${BROKER}${PATHS.authorize}?session=${SESSION}`,
    expiresAt: iso(NOW + 60_000)
  });
});

test('begin rejects invalid local inputs before any transport call', async () => {
  const { calls, fetchImpl } = queueFetch(() => jsonResponse(beginResponse()));
  const client = makeClient(fetchImpl);
  for (const input of [
    { redirectUri: 'https://relay.example.test/oauth/notion', clientState: STATE, verifier: VERIFIER },
    { redirectUri: REDIRECT, clientState: 'short', verifier: VERIFIER },
    { redirectUri: REDIRECT, clientState: STATE, verifier: 'short' }
  ]) {
    await assert.rejects(client.begin(input), isClientError('invalid_input'));
  }
  assert.equal(calls.length, 0);
});

test('begin rejects malformed or foreign session responses', async () => {
  const cases = [
    beginResponse({ protocolVersion: 'other-protocol' }),
    beginResponse({ clientId: 'other-client-1234' }),
    beginResponse({ authorizeUrl: `https://evil.example.test${PATHS.authorize}?session=${SESSION}` }),
    beginResponse({ authorizeUrl: `http://broker.example.test${PATHS.authorize}?session=${SESSION}` }),
    beginResponse({ authorizeUrl: `${BROKER}${PATHS.authorize}?session=${SESSION}&next=evil` }),
    beginResponse({ authorizeUrl: `${BROKER}${PATHS.authorize}?session=${SESSION}&session=${SESSION}` }),
    beginResponse({ authorizeUrl: `${BROKER}${PATHS.authorize}` }),
    beginResponse({ authorizeUrl: `${BROKER}${PATHS.authorize}?session=short` }),
    beginResponse({ authorizeUrl: `${BROKER}${PATHS.authorize}?session=${SESSION}#fragment` }),
    beginResponse({ expiresAt: iso(NOW - 1) }),
    beginResponse({ expiresAt: iso(NOW + LIMITS.sessionTtlMs + 5_001) }),
    beginResponse({ expiresAt: 'soon' }),
    beginResponse({ extra: true })
  ];
  for (const response of cases) {
    const { calls, fetchImpl } = queueFetch(() => jsonResponse(response));
    await assert.rejects(makeClient(fetchImpl).begin({ redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER }),
      isClientError('invalid_response'));
    assert.equal(calls.length, 1);
  }
});

test('redeem posts the exact request and returns a normalized private authorization with a locally derived proof', async () => {
  const { calls, fetchImpl } = queueFetch(() => jsonResponse(redeemResponse()));
  const client = makeClient(fetchImpl);
  const result = await client.redeem({ code: CODE, verifier: VERIFIER });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BROKER}${PATHS.redeem}`);
  assert.deepEqual(calls[0].body, { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, code: CODE, verifier: VERIFIER });
  assert.equal(calls[0].body.refreshProof, undefined);
  assert.deepEqual(result, {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: iso(NOW + 3_600_000),
    account: { id: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'Ada', workspaceName: 'Notes', label: 'Ada · Notes' },
    broker: { issuer: BROKER, grantId: GRANT, refreshCapability: CAPABILITY, refreshProof: expectedProof(VERIFIER, GRANT) }
  });
  assert.equal(result.broker.refreshProof, PROOF);
});

test('redeem rejects invalid local inputs before any transport call', async () => {
  const { calls, fetchImpl } = queueFetch(() => jsonResponse(redeemResponse()));
  const client = makeClient(fetchImpl);
  await assert.rejects(client.redeem({ code: 'c'.repeat(42), verifier: VERIFIER }), isClientError('invalid_input'));
  await assert.rejects(client.redeem({ code: CODE, verifier: 'short' }), isClientError('invalid_input'));
  assert.equal(calls.length, 0);
});

test('redeem rejects foreign issuers, malformed identities, tokens, capabilities, and extra fields', async () => {
  const cases = [
    redeemResponse({ broker: brokerPayload({ issuer: 'https://evil.example.test' }) }),
    redeemResponse({ broker: brokerPayload({ grantId: 'short' }) }),
    redeemResponse({ broker: brokerPayload({ refreshCapability: 'not-a-capability' }) }),
    redeemResponse({ broker: brokerPayload({ refreshCapability: `${CAPABILITY}.extra` }) }),
    redeemResponse({ account: accountPayload({ id: `${USER_ID}:${WORKSPACE_ID}` }) }),
    redeemResponse({ account: accountPayload({ userId: 'not-hex' }) }),
    redeemResponse({ account: accountPayload({ workspaceId: 'z'.repeat(10) }) }),
    redeemResponse({ account: accountPayload({ name: 'Ada\nInjected' }) }),
    redeemResponse({ account: accountPayload({ workspaceName: '   ' }) }),
    redeemResponse({ account: { ...accountPayload(), label: 'client-supplied' } }),
    redeemResponse({ accessToken: '' }),
    redeemResponse({ accessToken: 'line\nbreak' }),
    redeemResponse({ refreshToken: 42 }),
    redeemResponse({ expiresAt: 'not-a-date' }),
    redeemResponse({ extra: true }),
    { protocolVersion: 'other', clientId: CLIENT_ID, authorization: authorizationPayload() },
    { protocolVersion: PROTOCOL_VERSION, clientId: 'other-client-1234', authorization: authorizationPayload() }
  ];
  for (const response of cases) {
    const { calls, fetchImpl } = queueFetch(() => jsonResponse(response));
    await assert.rejects(makeClient(fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));
    assert.equal(calls.length, 1);
  }
});

test('rejects non-string account identity values without creating an authorization proof', async () => {
  const cases = [
    accountPayload({ userId: [USER_ID] }),
    accountPayload({ workspaceId: [WORKSPACE_ID] }),
    accountPayload({ id: [ACCOUNT_ID] }),
    accountPayload({ userId: { id: USER_ID } })
  ];
  for (const account of cases) {
    const input = { code: CODE, verifier: VERIFIER };
    const before = structuredClone(input);
    const { calls, fetchImpl } = queueFetch(() => jsonResponse(redeemResponse({ account })));
    let failure;
    await assert.rejects(makeClient(fetchImpl).redeem(input), error => {
      failure = error;
      return isClientError('invalid_response')(error);
    });
    assert.equal(failure.message, 'The Notion broker returned an invalid response.');
    assert.deepEqual(input, before);
    assert.equal(calls.length, 1);
  }
});

test('requires an application/json content type before parsing a response', async () => {
  const valid = beginResponse();
  const cases = [
    new Response(JSON.stringify(valid), { status: 200, headers: { 'content-type': 'text/plain' } }),
    new Response(JSON.stringify(valid), { status: 200, headers: { 'content-type': 'application/jsonp' } }),
    new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(valid))); controller.close(); }
    }), { status: 200, headers: {} })
  ];
  for (const response of cases) {
    const { calls, fetchImpl } = queueFetch(() => response);
    await assert.rejects(makeClient(fetchImpl).begin({ redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER }),
      isClientError('invalid_response'));
    assert.equal(calls.length, 1);
  }
});

test('broker error responses surface only allowlisted codes and never echo body text', async () => {
  const marker = 'BODY-MARKER-DO-NOT-ECHO';
  const { calls, fetchImpl } = queueFetch(() => jsonResponse({
    protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, error: 'invalid_grant', detail: marker, token: REFRESH_TOKEN
  }, 401));
  const client = makeClient(fetchImpl);
  let firstError;
  await assert.rejects(client.redeem({ code: CODE, verifier: VERIFIER }), error => {
    firstError = error;
    return isClientError('invalid_grant')(error);
  });
  assert.equal(firstError.outcomeUnknown, false);
  assert.equal(JSON.stringify(firstError).includes(marker), false);
  assert.equal(firstError.message.includes(REFRESH_TOKEN), false);
  assert.equal(calls.length, 1);

  const unknown = queueFetch(() => jsonResponse({ error: marker }, 500));
  await assert.rejects(makeClient(unknown.fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));
  const notJson = queueFetch(() => new Response(marker, { status: 200, headers: { 'content-type': 'text/plain' } }));
  await assert.rejects(makeClient(notJson.fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));
  const arrayBody = queueFetch(() => jsonResponse([marker]));
  await assert.rejects(makeClient(arrayBody.fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));
  for (const fake of [unknown, notJson, arrayBody]) assert.equal(fake.calls.length, 1);
});

test('refresh posts the exact grant context, keeps the original proof, and returns fresh private data', async () => {
  const authorization = privateAuthorization();
  const before = structuredClone(authorization);
  const { calls, fetchImpl } = queueFetch(() => jsonResponse(refreshResponse({ refreshToken: NEXT_REFRESH_TOKEN })));
  const client = makeClient(fetchImpl);
  const result = await client.refresh({ authorization });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BROKER}${PATHS.refresh}`);
  assert.deepEqual(calls[0].body, {
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    grantId: GRANT,
    refreshCapability: CAPABILITY,
    refreshProof: PROOF,
    refreshToken: REFRESH_TOKEN
  });
  assert.equal(calls[0].body.verifier, undefined);
  assert.equal(result.refreshToken, NEXT_REFRESH_TOKEN);
  assert.equal(result.broker.refreshProof, PROOF);
  assert.equal(result.broker.grantId, GRANT);
  assert.equal(result.broker.refreshCapability, CAPABILITY);
  assert.equal(result.broker.issuer, BROKER);
  assert.equal(result.account.id, ACCOUNT_ID);
  assert.deepEqual(authorization, before);
  assert.notEqual(result, authorization);
  assert.notEqual(result.broker, authorization.broker);
  assert.notEqual(result.account, authorization.account);
});

test('refresh rejects missing or foreign local context before any transport call', async () => {
  const { calls, fetchImpl } = queueFetch(() => jsonResponse(refreshResponse()));
  const client = makeClient(fetchImpl);
  const withoutProof = privateAuthorization();
  delete withoutProof.broker.refreshProof;
  const withoutToken = privateAuthorization();
  withoutToken.refreshToken = null;
  const foreignIssuer = privateAuthorization();
  foreignIssuer.broker.issuer = 'https://evil.example.test';
  const badAccount = privateAuthorization();
  badAccount.account.id = `${USER_ID}:${WORKSPACE_ID}`;
  const arrayUser = privateAuthorization();
  arrayUser.account.userId = [USER_ID];
  const arrayWorkspace = privateAuthorization();
  arrayWorkspace.account.workspaceId = [WORKSPACE_ID];
  const arrayId = privateAuthorization();
  arrayId.account.id = [ACCOUNT_ID];
  for (const authorization of [withoutProof, withoutToken, foreignIssuer, badAccount, arrayUser, arrayWorkspace, arrayId]) {
    await assert.rejects(client.refresh({ authorization }), isClientError('invalid_input'));
  }
  assert.equal(calls.length, 0);
});

test('refresh rejects cross-account, grant, capability, issuer, and protocol mutation', async () => {
  const authorization = privateAuthorization();
  const cases = [
    refreshResponse({ broker: brokerPayload({ grantId: 'h'.repeat(32) }) }),
    refreshResponse({ broker: brokerPayload({ refreshCapability: `v1.${'z'.repeat(32)}.${'n'.repeat(43)}` }) }),
    refreshResponse({ broker: brokerPayload({ issuer: 'https://evil.example.test' }) }),
    refreshResponse({ account: accountPayload({ id: `${WORKSPACE_ID}:${'c'.repeat(32)}`, userId: 'c'.repeat(32) }) }),
    refreshResponse({ account: accountPayload({ workspaceId: 'd'.repeat(32), id: `${'d'.repeat(32)}:${USER_ID}` }) }),
    refreshResponse({ accessToken: '' }),
    { protocolVersion: 'other', clientId: CLIENT_ID, authorization: authorizationPayload() },
    { protocolVersion: PROTOCOL_VERSION, clientId: 'other-client-1234', authorization: authorizationPayload() }
  ];
  for (const response of cases) {
    const { calls, fetchImpl } = queueFetch(() => jsonResponse(response));
    await assert.rejects(makeClient(fetchImpl).refresh({ authorization }), isClientError('invalid_response'));
    assert.equal(calls.length, 1);
  }
});

test('refresh with no new token returns null rather than inventing a retained token', async () => {
  const authorization = privateAuthorization();
  const { fetchImpl } = queueFetch(() => jsonResponse(refreshResponse({ refreshToken: null })));
  const result = await makeClient(fetchImpl).refresh({ authorization });
  assert.equal(result.refreshToken, null);
  assert.equal(authorization.refreshToken, REFRESH_TOKEN);
});

test('revoke posts the exact grant context and validates the matching response', async () => {
  const authorization = privateAuthorization();
  delete authorization.refreshToken;
  const { calls, fetchImpl } = queueFetch(() => jsonResponse({
    protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: true, grantId: GRANT
  }));
  const result = await makeClient(fetchImpl).revoke({ authorization });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BROKER}${PATHS.revoke}`);
  assert.deepEqual(calls[0].body, {
    protocolVersion: PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    grantId: GRANT,
    refreshCapability: CAPABILITY,
    refreshProof: PROOF
  });
  assert.deepEqual(result, { revoked: true, grantId: GRANT });

  for (const response of [
    { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: false, grantId: GRANT },
    { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: true, grantId: 'h'.repeat(32) },
    { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: true },
    { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: true, grantId: GRANT, extra: true }
  ]) {
    const fake = queueFetch(() => jsonResponse(response));
    await assert.rejects(makeClient(fake.fetchImpl).revoke({ authorization }), isClientError('invalid_response'));
    assert.equal(fake.calls.length, 1);
  }
});

test('cancel posts the exact session and verifier and validates the matching response', async () => {
  const { calls, fetchImpl } = queueFetch(() => jsonResponse({
    protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, cancelled: true
  }));
  const result = await makeClient(fetchImpl).cancel({ session: SESSION, verifier: VERIFIER });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BROKER}${PATHS.cancel}`);
  assert.deepEqual(calls[0].body, { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, session: SESSION, verifier: VERIFIER });
  assert.deepEqual(result, { cancelled: true });

  const invalidInput = queueFetch(() => jsonResponse({}));
  await assert.rejects(makeClient(invalidInput.fetchImpl).cancel({ session: 'short', verifier: VERIFIER }), isClientError('invalid_input'));
  await assert.rejects(makeClient(invalidInput.fetchImpl).cancel({ session: SESSION, verifier: 'short' }), isClientError('invalid_input'));
  assert.equal(invalidInput.calls.length, 0);

  for (const response of [
    { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, cancelled: false },
    { protocolVersion: PROTOCOL_VERSION, clientId: 'other-client-1234', cancelled: true },
    { protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, cancelled: true, extra: true }
  ]) {
    const fake = queueFetch(() => jsonResponse(response));
    await assert.rejects(makeClient(fake.fetchImpl).cancel({ session: SESSION, verifier: VERIFIER }), isClientError('invalid_response'));
    assert.equal(fake.calls.length, 1);
  }
});

test('bounds response bodies by declared and streamed length and cancels oversized streams', async () => {
  const declared = queueFetch(() => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(LIMITS.providerResponseBytes + 1) }
  }));
  await assert.rejects(makeClient(declared.fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));
  assert.equal(declared.calls.length, 1);

  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(LIMITS.providerResponseBytes + 1)); },
    cancel() { cancelled = true; }
  });
  const streamed = queueFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(makeClient(streamed.fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));
  assert.equal(streamed.calls.length, 1);
  assert.equal(cancelled, true);
});

test('handles a rejecting stream cancel without an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const oversize = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(LIMITS.providerResponseBytes + 1)); },
      cancel() { return Promise.reject(new Error('oversize cancel rejection marker')); }
    });
    await assert.rejects(makeClient(queueFetch(() => new Response(oversize, {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
    })).fetchImpl).redeem({ code: CODE, verifier: VERIFIER }), isClientError('invalid_response'));

    let cancelAttempts = 0;
    const stalled = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"protocolVersion":')); },
      cancel() { cancelAttempts += 1; return Promise.reject(new Error('timeout cancel rejection marker')); }
    });
    await assert.rejects(makeClient(queueFetch(() => new Response(stalled, {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
    })).fetchImpl, { timeoutMs: 20 }).begin({
      redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER
    }), isClientError('timeout'));
    assert.ok(cancelAttempts >= 1);

    let abortCancelAttempts = 0;
    const abortStalled = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { abortCancelAttempts += 1; return Promise.reject(new Error('abort cancel rejection marker')); }
    });
    const abortController = new AbortController();
    const aborted = makeClient(queueFetch(() => new Response(abortStalled, {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }
    })).fetchImpl).begin({
      redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER, signal: abortController.signal
    });
    setTimeout(() => abortController.abort(), 5);
    await assert.rejects(aborted, isClientError('aborted'));
    assert.ok(abortCancelAttempts >= 1);

    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('times out before headers and during the response body without retrying', async () => {
  const never = queueFetch(() => new Promise(() => {}));
  await assert.rejects(makeClient(never.fetchImpl, { timeoutMs: 20 }).begin({
    redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER
  }), error => isClientError('timeout')(error) && error.outcomeUnknown === true);
  assert.equal(never.calls.length, 1);

  let cancelled = false;
  const stalled = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"protocolVersion":')); },
    cancel() { cancelled = true; }
  });
  const bodyTimeout = queueFetch(() => new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(makeClient(bodyTimeout.fetchImpl, { timeoutMs: 20 }).begin({
    redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER
  }), isClientError('timeout'));
  assert.equal(bodyTimeout.calls.length, 1);
  assert.equal(cancelled, true);
});

test('external cancellation wins over late transport success and is not retried', async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const unused = queueFetch(() => jsonResponse(beginResponse()));
  await assert.rejects(makeClient(unused.fetchImpl).begin({
    redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER, signal: preAborted.signal
  }), error => isClientError('aborted')(error) && error.outcomeUnknown === true);
  assert.equal(unused.calls.length, 0);

  const controller = new AbortController();
  const late = queueFetch(() => new Promise(resolve => {
    setTimeout(() => resolve(jsonResponse(beginResponse())), 40);
  }));
  const pending = makeClient(late.fetchImpl).begin({
    redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER, signal: controller.signal
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, isClientError('aborted'));
  assert.equal(late.calls.length, 1);
});

test('transport failures are fixed, do not echo the underlying error, and are attempted once', async () => {
  const marker = 'TRANSPORT-SECRET-MARKER';
  const network = queueFetch(() => { throw new Error(marker); });
  let failure;
  await assert.rejects(makeClient(network.fetchImpl).refresh({ authorization: privateAuthorization() }), error => {
    failure = error;
    return isClientError('network_error')(error);
  });
  assert.equal(failure.outcomeUnknown, true);
  assert.equal(failure.message.includes(marker), false);
  assert.equal(JSON.stringify(failure).includes(marker), false);
  assert.equal(network.calls.length, 1);

  const forged = queueFetch(() => { throw new NotionBrokerClientError('invalid_grant', marker); });
  let forgedFailure;
  await assert.rejects(makeClient(forged.fetchImpl).refresh({ authorization: privateAuthorization() }), error => {
    forgedFailure = error;
    return isClientError('network_error')(error);
  });
  assert.equal(forgedFailure.message.includes(marker), false);
  assert.equal(forged.calls.length, 1);

  for (const code of ['in_progress', 'reauthorization_required']) {
    const fake = queueFetch(() => jsonResponse({ error: code }, 409));
    await assert.rejects(makeClient(fake.fetchImpl).refresh({ authorization: privateAuthorization() }), isClientError(code));
    assert.equal(fake.calls.length, 1);
  }

  const timeout = queueFetch(() => new Promise(() => {}));
  await assert.rejects(makeClient(timeout.fetchImpl, { timeoutMs: 20 }).refresh({ authorization: privateAuthorization() }), isClientError('timeout'));
  assert.equal(timeout.calls.length, 1);
});

test('every request uses the pinned origin and shared path with no credentials', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith(PATHS.session)) return jsonResponse(beginResponse());
    if (url.endsWith(PATHS.redeem)) return jsonResponse(redeemResponse());
    if (url.endsWith(PATHS.refresh)) return jsonResponse(refreshResponse());
    if (url.endsWith(PATHS.revoke)) return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, revoked: true, grantId: GRANT });
    if (url.endsWith(PATHS.cancel)) return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: CLIENT_ID, cancelled: true });
    throw new Error('unexpected path');
  };
  const client = makeClient(fetchImpl);
  await client.begin({ redirectUri: REDIRECT, clientState: STATE, verifier: VERIFIER });
  const issued = await client.redeem({ code: CODE, verifier: VERIFIER });
  await client.refresh({ authorization: issued });
  await client.revoke({ authorization: issued });
  await client.cancel({ session: SESSION, verifier: VERIFIER });
  const expectedPaths = [PATHS.session, PATHS.redeem, PATHS.refresh, PATHS.revoke, PATHS.cancel];
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), expectedPaths);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, BROKER);
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(/secret/i.test(JSON.stringify(call.body)), false);
  }
});
