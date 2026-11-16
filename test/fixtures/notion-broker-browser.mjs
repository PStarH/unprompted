// Synthetic Notion broker for the maintained browser regression. This file is
// also loaded with `node --import` by the actual product server, where it wraps
// globalThis.fetch: only the exact fake broker origin is answered, the one
// initial Notion search read returns an empty page, loopback traffic is passed
// through, and every other external request fails loudly. No real account,
// provider, model or network is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PATHS, PROTOCOL_VERSION, refreshProof, s256Challenge,
  validChallenge, validClientState, validLoopbackRedirectUri, validOpaqueId, validVerifier
} from '../../src/notion-broker-protocol.js';
import { startFixtureServer } from '../browser/fixture-server.mjs';

export const NOTION_BROKER_ORIGIN = 'https://broker.example.test';
export const NOTION_FIXTURE_CLIENT_ID = 'notion-browser-client';
export const NOTION_ACCESS_TOKEN = ['fixture','notion','access','token'].join('-');
export const NOTION_REFRESH_TOKEN = ['fixture','notion','refresh','token'].join('-');

const USER_ID = 'a'.repeat(32);
const WORKSPACE_ID = 'b'.repeat(32);
const ACCOUNT = Object.freeze({
  id: `${WORKSPACE_ID}:${USER_ID}`,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  name: 'Browser Reader',
  workspaceName: 'Fixture Workspace'
});
export const NOTION_ACCOUNT = Object.freeze({
  ...ACCOUNT,
  label: `${ACCOUNT.name} · ${ACCOUNT.workspaceName}`
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const STATE_SCHEMA = 'unprompted-notion-broker-browser-v1';

function emptyState() {
  return {
    schema: STATE_SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    sessions: [],
    requests: [],
    brokerUnexpected: [],
    notionCalls: [],
    blocked: [],
    revokes: [],
    refreshes: []
  };
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback(); throw error; }
}

function readControls(file) {
  return readJson(file, () => ({ shortSession: false }));
}

function mutateState(file, mutation) {
  const state = readJson(file, emptyState);
  mutation(state);
  writeJson(file, state);
  return state;
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function brokerError(code, status) {
  return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: NOTION_FIXTURE_CLIENT_ID, error: code }, status);
}

function capability() {
  return `v1.${randomBytes(18).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

function authorizationFor(session, accessToken) {
  return {
    accessToken,
    refreshToken: session.refreshToken,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    account: { ...ACCOUNT },
    broker: {
      issuer: NOTION_BROKER_ORIGIN,
      grantId: session.grantId,
      refreshCapability: session.capability
    }
  };
}

function handleBroker(statePath, controlsPath, pathname, method, bodyText) {
  const state = readJson(statePath, emptyState);
  state.requests.push({ path: pathname, method, at: new Date().toISOString() });
  const commit = () => writeJson(statePath, state);
  if (method !== 'POST') {
    state.brokerUnexpected.push({ path: pathname, method });
    commit();
    return brokerError('invalid_request', 400);
  }
  let body;
  try { body = JSON.parse(bodyText); }
  catch {
    state.brokerUnexpected.push({ path: pathname, method: 'invalid-json' });
    commit();
    return brokerError('invalid_request', 400);
  }

  if (pathname === PATHS.session) {
    if (!exact(body, ['protocolVersion', 'clientId', 'codeChallenge', 'codeChallengeMethod', 'redirectUri', 'clientState'])
      || body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== NOTION_FIXTURE_CLIENT_ID
      || !validChallenge(body.codeChallenge) || body.codeChallengeMethod !== 'S256'
      || !validLoopbackRedirectUri(body.redirectUri) || !validClientState(body.clientState)) {
      state.brokerUnexpected.push({ path: pathname, method: 'invalid-session-body' });
      commit();
      return brokerError('invalid_request', 400);
    }
    const controls = readControls(controlsPath);
    const now = Date.now();
    const expiresAtMs = now + (controls.shortSession === true ? 5_000 : 4 * 60_000);
    const session = {
      id: randomBytes(32).toString('base64url'),
      clientId: NOTION_FIXTURE_CLIENT_ID,
      redirectUri: body.redirectUri,
      clientState: body.clientState,
      challenge: body.codeChallenge,
      handoffCode: randomBytes(32).toString('base64url'),
      grantId: randomBytes(32).toString('base64url'),
      capability: capability(),
      accessToken: NOTION_ACCESS_TOKEN,
      refreshToken: NOTION_REFRESH_TOKEN,
      status: 'pending',
      createdAt: now,
      expiresAtMs,
      verifier: null,
      proof: null
    };
    state.sessions.push(session);
    commit();
    return jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      clientId: NOTION_FIXTURE_CLIENT_ID,
      authorizeUrl: `${NOTION_BROKER_ORIGIN}${PATHS.authorize}?session=${session.id}`,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  }

  if (pathname === PATHS.redeem) {
    if (!exact(body, ['protocolVersion', 'clientId', 'code', 'verifier'])
      || body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== NOTION_FIXTURE_CLIENT_ID
      || !validOpaqueId(body.code, { min: 43, max: 43 }) || !validVerifier(body.verifier)) {
      state.brokerUnexpected.push({ path: pathname, method: 'invalid-redeem-body' });
      commit();
      return brokerError('invalid_request', 400);
    }
    const session = state.sessions.find(item => item.handoffCode === body.code);
    if (!session || session.status !== 'pending') {
      commit();
      return brokerError('invalid_grant', 401);
    }
    if (Date.now() >= session.expiresAtMs) {
      session.status = 'expired';
      commit();
      return brokerError('expired', 410);
    }
    if (s256Challenge(body.verifier) !== session.challenge) {
      commit();
      return brokerError('invalid_grant', 401);
    }
    session.status = 'redeemed';
    session.verifier = body.verifier;
    session.proof = refreshProof(body.verifier, session.grantId);
    session.redeemedAt = Date.now();
    commit();
    return jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      clientId: NOTION_FIXTURE_CLIENT_ID,
      authorization: authorizationFor(session, session.accessToken)
    });
  }

  if (pathname === PATHS.refresh) {
    if (!exact(body, ['protocolVersion', 'clientId', 'grantId', 'refreshCapability', 'refreshProof', 'refreshToken'])
      || body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== NOTION_FIXTURE_CLIENT_ID
      || typeof body.refreshCapability !== 'string' || typeof body.refreshProof !== 'string'
      || typeof body.refreshToken !== 'string' || !validOpaqueId(body.grantId)) {
      state.brokerUnexpected.push({ path: pathname, method: 'invalid-refresh-body' });
      commit();
      return brokerError('invalid_request', 400);
    }
    const session = state.sessions.find(item => item.grantId === body.grantId
      && (item.status === 'redeemed' || item.status === 'refreshed'));
    if (!session || body.refreshCapability !== session.capability || body.refreshToken !== session.refreshToken
      || body.refreshProof !== session.proof) {
      commit();
      return brokerError('invalid_grant', 401);
    }
    session.status = 'refreshed';
    state.refreshes.push({ grantId: session.grantId, at: new Date().toISOString() });
    commit();
    return jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      clientId: NOTION_FIXTURE_CLIENT_ID,
      authorization: authorizationFor(session, `${session.accessToken}-refreshed`)
    });
  }

  if (pathname === PATHS.revoke) {
    if (!exact(body, ['protocolVersion', 'clientId', 'grantId', 'refreshCapability', 'refreshProof'])
      || body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== NOTION_FIXTURE_CLIENT_ID
      || typeof body.refreshCapability !== 'string' || typeof body.refreshProof !== 'string'
      || !validOpaqueId(body.grantId)) {
      state.brokerUnexpected.push({ path: pathname, method: 'invalid-revoke-body' });
      commit();
      return brokerError('invalid_request', 400);
    }
    const session = state.sessions.find(item => item.grantId === body.grantId
      && (item.status === 'redeemed' || item.status === 'refreshed'));
    if (!session || body.refreshCapability !== session.capability || body.refreshProof !== session.proof) {
      commit();
      return brokerError('invalid_grant', 401);
    }
    session.status = 'revoked';
    state.revokes.push({ grantId: session.grantId, proof: body.refreshProof, at: new Date().toISOString() });
    commit();
    return jsonResponse({
      protocolVersion: PROTOCOL_VERSION,
      clientId: NOTION_FIXTURE_CLIENT_ID,
      revoked: true,
      grantId: session.grantId
    });
  }

  if (pathname === PATHS.cancel) {
    if (!exact(body, ['protocolVersion', 'clientId', 'session', 'verifier'])
      || body.protocolVersion !== PROTOCOL_VERSION || body.clientId !== NOTION_FIXTURE_CLIENT_ID
      || !validOpaqueId(body.session) || !validVerifier(body.verifier)) {
      state.brokerUnexpected.push({ path: pathname, method: 'invalid-cancel-body' });
      commit();
      return brokerError('invalid_request', 400);
    }
    const session = state.sessions.find(item => item.id === body.session);
    if (session && s256Challenge(body.verifier) === session.challenge && session.status === 'pending') session.status = 'cancelled';
    commit();
    return jsonResponse({ protocolVersion: PROTOCOL_VERSION, clientId: NOTION_FIXTURE_CLIENT_ID, cancelled: true });
  }

  state.brokerUnexpected.push({ path: pathname, method });
  commit();
  return brokerError('invalid_request', 400);
}

function recordNotionCall(statePath, call) {
  mutateState(statePath, state => { state.notionCalls.push({ ...call, at: new Date().toISOString() }); });
}

function blockExternal(statePath, url) {
  mutateState(statePath, state => {
    state.blocked.push({ origin: url?.origin || 'invalid', path: url?.pathname || '', at: new Date().toISOString() });
  });
  throw new TypeError('The browser fixture blocked an external request.');
}

function installFakeTransport(statePath, controlsPath) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    let url;
    try {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      url = new URL(raw);
    } catch {
      return Promise.reject(new TypeError('The browser fixture rejected a non-URL request.'));
    }
    const method = String(options.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const headers = new Headers(options.headers || (input && typeof input === 'object' ? input.headers : undefined));
    if (url.origin === NOTION_BROKER_ORIGIN) {
      const body = typeof options.body === 'string' ? options.body : '';
      return Promise.resolve(handleBroker(statePath, controlsPath, url.pathname, method, body));
    }
    if (url.origin === 'https://api.notion.com' && url.pathname === '/v1/search' && method === 'POST') {
      recordNotionCall(statePath, { path: url.pathname, method });
      const authorization = headers.get('authorization');
      if (authorization !== `Bearer ${NOTION_ACCESS_TOKEN}` && authorization !== `Bearer ${NOTION_ACCESS_TOKEN}-refreshed`) {
        return Promise.reject(new TypeError('The browser fixture rejected an unexpected Notion token.'));
      }
      return Promise.resolve(jsonResponse({ object: 'list', results: [], has_more: false, next_cursor: null }));
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      return originalFetch(input, options);
    }
    if (url.protocol === 'data:') return originalFetch(input, options);
    try { blockExternal(statePath, url); }
    catch (error) { return Promise.reject(error); }
  };
}

if (process.env.UNPROMPTED_TEST_NOTION_BROKER_PRELOAD === '1') {
  const statePath = process.env.UNPROMPTED_TEST_NOTION_BROKER_STATE;
  const controlsPath = process.env.UNPROMPTED_TEST_NOTION_BROKER_CONTROLS;
  if (!statePath || !controlsPath) throw new Error('The synthetic Notion broker preload requires its private fixture paths.');
  installFakeTransport(statePath, controlsPath);
}

export async function startNotionBrokerFixture({ directory = null, root = null } = {}) {
  const ownsDirectory = !directory;
  const appDirectory = directory || fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notion-broker-'));
  const statePath = path.join(appDirectory, 'notion-broker-fixture-state.json');
  const controlsPath = path.join(appDirectory, 'notion-broker-fixture-controls.json');
  const clientFile = path.join(appDirectory, 'connector-clients.json');
  const workspaceFile = path.join(appDirectory, 'state.sqlite');
  fs.writeFileSync(clientFile, `${JSON.stringify({ notion: { clientId: NOTION_FIXTURE_CLIENT_ID, brokerUrl: NOTION_BROKER_ORIGIN } })}\n`, { mode: 0o600 });
  writeJson(statePath, emptyState());
  writeJson(controlsPath, { shortSession: false });
  let fixture;
  try {
    fixture = await startFixtureServer({
      ruleDemo: false,
      root,
      directory: appDirectory,
      nodeArgs: ['--import', fileURLToPath(new URL('./notion-broker-browser.mjs', import.meta.url))],
      serverEnv: {
        UNPROMPTED_STORAGE: 'sqlite',
        UNPROMPTED_CONNECTOR_CLIENTS_FILE: clientFile,
        UNPROMPTED_TEST_NOTION_BROKER_PRELOAD: '1',
        UNPROMPTED_TEST_NOTION_BROKER_STATE: statePath,
        UNPROMPTED_TEST_NOTION_BROKER_CONTROLS: controlsPath
      }
    });
  } catch (error) {
    if (ownsDirectory) fs.rmSync(appDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...fixture,
    directory: appDirectory,
    workspaceFile,
    statePath,
    controlsPath,
    clientFile,
    readState: () => readJson(statePath, emptyState),
    setControls: patch => {
      const next = { ...readControls(controlsPath), ...patch };
      writeJson(controlsPath, next);
      return next;
    },
    close: async () => {
      try { await fixture.close(); }
      finally { if (ownsDirectory) fs.rmSync(appDirectory, { recursive: true, force: true }); }
    }
  };
}
