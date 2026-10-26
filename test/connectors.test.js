import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { GoogleWorkspaceConnector, googleConfigFromEnv, GoogleAuth } from '../src/connectors/google.js';
import { GoogleMailAdapter, UncertainDeliveryError } from '../src/providers.js';
import { buildRuntime } from '../src/connectors/index.js';
import { ConnectorError } from '../src/connectors/connector.js';
import { normalizeEvent, EventValidationError, validateEventPayload } from '../src/connectors/events.js';

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body)
});

/** Compare hosts exactly; a substring match would accept evil-oauth2.googleapis.com. */
const isTokenEndpoint = value => {
  try { return new URL(value).hostname === 'oauth2.googleapis.com'; } catch { return false; }
};
const textResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => JSON.parse(body), text: async () => body
});

/** A scripted fetch that records every call. */
function scriptedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body || null });
    for (const [matcher, responder] of routes) {
      if (typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url)) {
        return typeof responder === 'function' ? responder(url, options) : responder;
      }
    }
    throw new Error(`Unscripted request: ${url}`);
  };
  return { fetchImpl, calls };
}

const CREDENTIALS = { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' };
const tokenRoute = ['oauth2.googleapis.com/token', jsonResponse({ access_token: 'at-1', expires_in: 3600 })];
const encodedDoc = Buffer.from('Hello body', 'utf8').toString('base64url');
const mailMessage = (id, subject = id) => ({
  id,
  threadId: `t-${id}`,
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'alex@example.test' },
      { name: 'To', value: 'maya@example.test' },
      { name: 'Subject', value: subject },
      { name: 'Date', value: 'Thu, 16 Oct 2026 09:00:00 +0000' }
    ],
    body: { data: encodedDoc }
  }
});

function storeIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-conn-'));
  tempFiles.push(dir);
  return new JsonStore(path.join(dir, 'state.json'));
}

// --------------------------------------------------------------- normalization

test('normalized events are namespaced by connector and reject unsupported shapes', () => {
  const event = normalizeEvent({
    connectorId: 'google', source: 'google', providerEventId: 'gmail:abc',
    type: 'email.received', payload: { id: 'abc', from: 'a@b.test', subject: 's', body: 'b' }
  });
  assert.equal(event.id, 'google:gmail:abc');
  assert.equal(event.source, 'google');
  assert.throws(() => normalizeEvent({ connectorId: 'x', providerEventId: '1', type: 'email.deleted', payload: {} }), EventValidationError);
  assert.throws(() => normalizeEvent({ connectorId: 'x', providerEventId: '1', type: 'email.received', payload: {} , source: 'carrier-pigeon' }), EventValidationError);
  assert.equal(validateEventPayload({ type: 'document.unavailable', payload: { id: 'doc-1', reason: 'removed' } }), true);
  assert.throws(() => validateEventPayload({ type: 'document.unavailable', payload: {} }), /id/);
  assert.throws(() => validateEventPayload({ type: 'email.received', payload: { id: 'x' } }), /missing/);
  assert.throws(() => validateEventPayload({ type: 'document.modified', payload: { id: 'x', title: 't', content: 5 } }), /text content/);
});

test('missing Google configuration is reported by name and never faked', () => {
  const config = googleConfigFromEnv({});
  const connector = new GoogleWorkspaceConnector({ config });
  const validation = connector.validate();
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.missing.sort(), ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
  assert.match(validation.detail, /simulation stays active/);
});

test('runtime falls back to the simulated connector and provider without credentials', () => {
  const store = storeIn();
  const runtime = buildRuntime({}, { store });
  assert.equal(runtime.mode, 'simulation');
  assert.equal(runtime.live, false);
  assert.equal(runtime.provider.kind, 'simulated');
  assert.deepEqual(runtime.report.pendingConfiguration.sort(), ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
  assert.equal(runtime.connectors.every(connector => connector.id === 'simulated'), true);
});

test('the default runtime is read-only and names the documented way to watch the loop', () => {
  const store = storeIn();
  const runtime = buildRuntime({}, { store });
  assert.equal(runtime.shadow, true, 'absent means on: the default refuses external writes');
  assert.equal(runtime.provider.kind, 'simulated', 'shadow mode never wires a send-capable provider');
  assert.match(runtime.report.note, /external writes are refused/i);
  assert.match(runtime.report.note, /UNPROMPTED_SHADOW_MODE=false/, 'the default run states how approval and verification can be watched');
  const optedOut = buildRuntime({ UNPROMPTED_SHADOW_MODE: 'false' }, { store });
  assert.equal(optedOut.shadow, false);
  assert.doesNotMatch(optedOut.report.note, /UNPROMPTED_SHADOW_MODE/);
});

test('desktop simulation can complete local actions without persisting authority for a later live runtime', () => {
  const store = storeIn();
  const env = { UNPROMPTED_SHADOW_MODE: 'true' };
  const local = buildRuntime(env, { store, allowSimulatedActions: true });
  assert.equal(local.mode, 'simulation');
  assert.equal(local.shadow, false);
  assert.equal(local.policy.shadow, false);
  assert.equal(local.provider.kind, 'simulated');
  assert.equal(local.report.google.sendEnabled, false);
  assert.equal(env.UNPROMPTED_SHADOW_MODE, 'true');
  assert.equal(buildRuntime(env, { store }).shadow, true);
});

test('desktop simulation convenience never disables live read-only policy', () => {
  const store = storeIn();
  const runtime = buildRuntime({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh', GOOGLE_SEND_ENABLED: 'true' }, { store, allowSimulatedActions: true });
  assert.equal(runtime.mode, 'live');
  assert.equal(runtime.shadow, true);
  assert.equal(runtime.policy.shadow, true);
  assert.equal(runtime.provider.kind, 'gmail');
  assert.equal(runtime.provider.canSend, false);
  assert.equal(runtime.report.google.sendEnabled, false);
});

test('desktop simulation convenience cannot enable writes into a recorded real workspace', () => {
  const store = storeIn();
  store.mutate(state => { state.events.push({ id: 'recorded-real', source: 'google' }); });
  const runtime = buildRuntime({}, { store, allowSimulatedActions: true });
  assert.equal(runtime.shadow, true);
  assert.equal(runtime.policy.shadow, true);
  assert.equal(runtime.provider.kind, 'simulated');
});

test('runtime selects the live Google provider when credentials and send are configured', () => {
  const store = storeIn();
  const runtime = buildRuntime({
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REFRESH_TOKEN: 'rtoken',
    GOOGLE_SEND_ENABLED: 'true', UNPROMPTED_SHADOW_MODE: 'false'
  }, { store });
  assert.equal(runtime.mode, 'live');
  assert.equal(runtime.provider.kind, 'gmail');
  assert.equal(runtime.report.google.sendEnabled, true);
  assert.ok(runtime.connectors.some(connector => connector.id === 'google'));
});

test('live mode is read-only unless send is explicitly enabled', () => {
  const store = storeIn();
  const runtime = buildRuntime({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' }, { store });
  assert.equal(runtime.mode, 'live');
  assert.equal(runtime.provider.kind, 'gmail', 'a read-only live connector retains its real provider identity');
  assert.equal(runtime.provider.canSend, false, 'read-only never enables delivery');
  assert.match(runtime.report.note, /read-only/i);
});

// -------------------------------------------------------------------- auth

test('the access token is refreshed once and reused, and the secret is never exposed', async () => {
  const { fetchImpl, calls } = scriptedFetch([tokenRoute, ['gmail/v1/users/me/profile', jsonResponse({ historyId: 'h1' })]]);
  const auth = new GoogleAuth({ ...CREDENTIALS, fetchImpl, now: () => 1000 });
  await auth.accessToken();
  await auth.accessToken();
  const tokenCalls = calls.filter(call => isTokenEndpoint(call.url));
  assert.equal(tokenCalls.length, 1, 'the token must be cached');
  assert.match(tokenCalls[0].body, /grant_type=refresh_token/);
  assert.match(tokenCalls[0].body, /refresh_token=rtoken/);
});

test('a revoked refresh token surfaces as a clear non-retryable error', async () => {
  const { fetchImpl } = scriptedFetch([['oauth2.googleapis.com/token', jsonResponse({ error: 'invalid_grant' }, 400)]]);
  const auth = new GoogleAuth({ ...CREDENTIALS, fetchImpl });
  await assert.rejects(() => auth.accessToken(), /expired or revoked/);
});

test('an oauth refresh that never returns times out as a retryable error', async () => {
  const auth = new GoogleAuth({
    ...CREDENTIALS, timeoutMs: 20,
    fetchImpl: () => new Promise(() => {})
  });
  await assert.rejects(() => auth.accessToken(), error => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /timed out/i);
    return true;
  });
});

test('a google api request that never returns times out instead of hanging the sync', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', () => new Promise(() => {})]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readDrive: false, timeoutMs: 20 },
    fetchImpl
  });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /timed out/i);
  assert.equal(result.errors[0].retryable, true);
  assert.equal(result.cursor.gmail.historyId, 'h1', 'a timed-out sync must not advance the cursor');
});

test('a rate-limited GET is retried with a bounded backoff', async () => {
  let attempts = 0;
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes/startPageToken', () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ error: 'rate limited' }, 429) : jsonResponse({ startPageToken: 'p-1' });
    }],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: {
      ...CREDENTIALS, readGmail: false, maxRetries: 2, retryBaseMs: 1,
      sleep: async () => {}, random: () => 0
    },
    fetchImpl
  });
  const result = await connector.pull({ cursor: null });
  assert.equal(result.errors.length, 0);
  assert.equal(attempts, 2, 'one retry after a 429');
  assert.equal(result.cursor.drive.pageToken, 'p-1');
});

test('retries stop at the configured budget instead of looping forever', async () => {
  let attempts = 0;
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes/startPageToken', () => {
      attempts += 1;
      return jsonResponse({ error: 'still limited' }, 429);
    }]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: {
      ...CREDENTIALS, readGmail: false, maxRetries: 2, retryBaseMs: 1,
      sleep: async () => {}, random: () => 0
    },
    fetchImpl
  });
  const result = await connector.pull({ cursor: null });
  assert.equal(attempts, 3, 'initial attempt plus two retries');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].retryable, true);
});

test('a failed send POST is never retried automatically', async () => {
  let sends = 0;
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/messages/send', () => {
      sends += 1;
      return jsonResponse({ error: 'backend down' }, 500);
    }]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: {
      ...CREDENTIALS, sendEnabled: true, shadow: false, maxRetries: 3, retryBaseMs: 1,
      sleep: async () => {}, random: () => 0
    },
    fetchImpl
  });
  await assert.rejects(
    () => connector.execute({ to: 'dana@example.test', subject: 'Update', body: 'Body', idempotencyKey: 'k-no-retry' }),
    /500/
  );
  assert.equal(sends, 1, 'a send with an unknown outcome must be reconciled, never retried by transport code');
});

test('a sync that exceeds its time budget stops without advancing the cursor', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return jsonResponse({ history: [], historyId: 'h2' });
    }]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readDrive: false, timeoutMs: 1000, syncBudgetMs: 5 },
    fetchImpl
  });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /time budget/i);
  assert.equal(result.cursor.gmail.historyId, 'h1');
});

test('an oversized document export is refused instead of read without bound', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({ newStartPageToken: 'p-2', changes: [
      { fileId: 'doc-a', file: { id: 'doc-a', name: 'Northstar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-16T09:00:00.000Z', version: '7' } }
    ] })],
    ['drive/v3/files/doc-a/export', textResponse('x'.repeat(200))],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, readGmail: false, maxDocumentChars: 50 },
    fetchImpl
  });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1' } } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /exceeds 50/);
  assert.equal(result.events.length, 0);
  assert.equal(result.cursor.drive.pageToken, 'p-1');
});

// ------------------------------------------------------------------ gmail pull

test('gmail incremental sync uses the stored history cursor and normalizes messages', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', jsonResponse({ history: [{ messages: [{ id: 'm-1' }] }], historyId: 'h2' })],
    ['gmail/v1/users/me/messages/m-1', jsonResponse({
      id: 'm-1', threadId: 't-1', labelIds: ['UNREAD'], snippet: 'snippet',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'alex@example.test' },
          { name: 'To', value: 'maya@example.test' },
          { name: 'Subject', value: 'Northstar proposal — experiment results' },
          { name: 'Date', value: 'Thu, 16 Oct 2026 09:00:00 +0000' },
          { name: 'Message-ID', value: '<abc@example.test>' }
        ],
        parts: [{ mimeType: 'text/plain', body: { data: encodedDoc } }]
      }
    })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });

  assert.ok(calls.some(call => call.url.includes('startHistoryId=h1')), 'must resume from the stored cursor');
  assert.equal(result.errors.length, 0);
  assert.equal(result.cursor.gmail.historyId, 'h2');
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, 'email.received');
  assert.equal(event.source, 'google');
  assert.equal(event.id, 'google:gmail:m-1');
  assert.equal(event.payload.body, 'Hello body');
  assert.equal(event.payload.threadId, 't-1');
  assert.equal(event.payload.subject, 'Northstar proposal — experiment results');
});

test('every gmail history page is consumed before the cursor advances', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    tokenRoute,
    ['pageToken=pg2', jsonResponse({ history: [{ messages: [{ id: 'm-2' }] }], historyId: 'h-mid', nextPageToken: 'pg3' })],
    ['pageToken=pg3', jsonResponse({ history: [{ messages: [{ id: 'm-3' }] }], historyId: 'h-final' })],
    ['gmail/v1/users/me/history', jsonResponse({ history: [{ messages: [{ id: 'm-1' }] }], historyId: 'h-mid', nextPageToken: 'pg2' })],
    ['gmail/v1/users/me/messages/m-1', jsonResponse(mailMessage('m-1', 'One'))],
    ['gmail/v1/users/me/messages/m-2', jsonResponse(mailMessage('m-2', 'Two'))],
    ['gmail/v1/users/me/messages/m-3', jsonResponse(mailMessage('m-3', 'Three'))]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 3, 'messages from every history page must be imported');
  assert.equal(result.cursor.gmail.historyId, 'h-final');
  assert.ok(calls.some(call => call.url.includes('pageToken=pg2')));
  assert.ok(calls.some(call => call.url.includes('pageToken=pg3')));
});

test('more than fifty message ids are all fetched, not silently truncated', async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `m-${index + 1}`);
  const routes = [
    tokenRoute,
    ['gmail/v1/users/me/history', jsonResponse({ history: [{ messages: ids.map(id => ({ id })) }], historyId: 'h-205' })],
    ...ids.map(id => [`gmail/v1/users/me/messages/${id}?format=full`, jsonResponse(mailMessage(id))])
  ];
  const { fetchImpl } = scriptedFetch(routes);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 205, 'every id must be fetched before the cursor moves');
  assert.equal(result.cursor.gmail.historyId, 'h-205');
});

test('a failed history page keeps the previous gmail cursor and imports nothing', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['pageToken=pg2', jsonResponse({ error: 'backend down' }, 500)],
    ['gmail/v1/users/me/history', jsonResponse({ history: [{ messages: [{ id: 'm-1' }] }], historyId: 'h-mid', nextPageToken: 'pg2' })],
    ['gmail/v1/users/me/messages/m-1', jsonResponse(mailMessage('m-1', 'One'))]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, 'gmail');
  assert.equal(result.events.length, 0, 'a partial history must not be reported as imported');
  assert.equal(result.cursor.gmail.historyId, 'h1', 'the cursor must stay before the unread page');
});

test('a failed message fetch keeps the cursor so the sync can be retried', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', jsonResponse({ history: [{ messages: [{ id: 'm-1' }, { id: 'm-2' }] }], historyId: 'h2' })],
    ['gmail/v1/users/me/messages/m-1', jsonResponse(mailMessage('m-1', 'One'))],
    ['gmail/v1/users/me/messages/m-2', jsonResponse({ error: 'backend down' }, 500)]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.errors.length, 1);
  assert.equal(result.events.length, 0);
  assert.equal(result.cursor.gmail.historyId, 'h1');
});

test('the first gmail sync captures its history point before listing, so new mail is not lost', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/profile', jsonResponse({ historyId: 'h-boot' })],
    ['pageToken=list2', jsonResponse({ messages: [{ id: 'm-2' }] })],
    ['gmail/v1/users/me/messages?q=', jsonResponse({ messages: [{ id: 'm-1' }], nextPageToken: 'list2' })],
    ['gmail/v1/users/me/messages/m-1', jsonResponse(mailMessage('m-1', 'One'))],
    ['gmail/v1/users/me/messages/m-2', jsonResponse(mailMessage('m-2', 'Two'))],
    ['startHistoryId=h-boot', jsonResponse({ history: [{ messages: [{ id: 'm-3' }] }], historyId: 'h-later' })],
    ['gmail/v1/users/me/messages/m-3', jsonResponse(mailMessage('m-3', 'Three'))]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const first = await connector.pull({ cursor: null });
  assert.equal(first.errors.length, 0);
  assert.equal(first.events.length, 2, 'listing pagination must be followed');
  assert.equal(first.cursor.gmail.historyId, 'h-boot');
  const profileAt = calls.findIndex(call => call.url.includes('/profile'));
  const listingAt = calls.findIndex(call => call.url.includes('messages?q='));
  assert.ok(profileAt >= 0 && listingAt > profileAt, 'the resume point must be captured before the bounded listing');

  const second = await connector.pull({ cursor: first.cursor });
  assert.equal(second.errors.length, 0);
  assert.equal(second.events.length, 1, 'mail that arrived during the first listing is caught by history');
  assert.equal(second.events[0].payload.subject, 'Three');
  assert.equal(second.cursor.gmail.historyId, 'h-later');
});

test('a message deleted between history and fetch is skipped without blocking the cursor', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', jsonResponse({ history: [{ messages: [{ id: 'm-gone' }, { id: 'm-live' }] }], historyId: 'h3' })],
    ['gmail/v1/users/me/messages/m-gone', jsonResponse({ error: { code: 404 } }, 404)],
    ['gmail/v1/users/me/messages/m-live', jsonResponse(mailMessage('m-live', 'Live'))]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h2' } } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.cursor.gmail.historyId, 'h3');
});

test('an expired gmail history cursor falls back to a bounded query instead of losing mail', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', jsonResponse({ error: { code: 404 } }, 404)],
    ['gmail/v1/users/me/messages?q=', jsonResponse({ messages: [{ id: 'm-9' }] })],
    ['gmail/v1/users/me/profile', jsonResponse({ historyId: 'h-new' })],
    ['gmail/v1/users/me/messages/m-9', jsonResponse({ id: 'm-9', threadId: 't-9', payload: { headers: [{ name: 'From', value: 'a@b.test' }, { name: 'Subject', value: 'Hi' }, { name: 'Date', value: 'Thu, 16 Oct 2026 09:00:00 +0000' }], parts: [{ mimeType: 'text/plain', body: { data: encodedDoc } }] } })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readDrive: false }, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'stale' } } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.cursor.gmail.historyId, 'h-new');
  assert.ok(calls.some(call => call.url.includes('messages?q=')), 'should fall back to a bounded query');
});

// ------------------------------------------------------------------ drive pull

test('the first drive sync captures its baseline before reading existing documents immediately', async () => {
  const { fetchImpl, calls } = scriptedFetch([tokenRoute,
    ['drive/v3/changes/startPageToken', jsonResponse({ startPageToken: 'p-1' })],
    ['drive/v3/files?', jsonResponse({ files: [{ id: 'first-doc', name: 'Current proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-26T08:00:00Z', version: '1' }] })],
    ['drive/v3/files/first-doc/export', textResponse('Sample size: 1200. Conclusion: proceed.')]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: null });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.id, 'first-doc');
  assert.equal(result.cursor.drive.pageToken, 'p-1');
  assert.ok(calls.findIndex(call => call.url.includes('/changes/startPageToken')) < calls.findIndex(call => call.url.includes('/files?')), 'capture the baseline before listing so changes arriving during listing are retained');
});

test('drive change tracking exports google docs into normalized document events', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({
      newStartPageToken: 'p-2',
      changes: [
        { fileId: 'doc-1', file: { id: 'doc-1', name: 'Northstar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-16T09:00:00.000Z', version: '7' } },
        { fileId: 'sheet-1', file: { id: 'sheet-1', name: 'Data', mimeType: 'application/vnd.google-apps.spreadsheet' } },
        { fileId: 'gone', removed: true }
      ]
    })],
    ['drive/v3/files/doc-1/export', textResponse('## Experiment results\nRun date: 2026-10-16\n')],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1' } } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.filter(event => event.type === 'document.modified').length, 1, 'only Google Docs are tracked');
  assert.equal(result.events.filter(event => event.type === 'document.unavailable').length, 1, 'a removed file is invalidated, not ignored');
  const [event] = result.events.filter(item => item.type === 'document.modified');
  assert.equal(event.type, 'document.modified');
  assert.equal(event.payload.externalId, 'doc-1');
  assert.equal(event.payload.title, 'Northstar project proposal');
  assert.match(event.payload.url, /^https:\/\/docs\.google\.com\/document\/d\/doc-1/);
  assert.match(event.payload.content, /Experiment results/);
  assert.equal(result.cursor.drive.pageToken, 'p-2');
});

test('an incremental drive sync lists accessible Google Docs and exports their content', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({ newStartPageToken: 'p-2', changes: [] })],
    ['drive/v3/files?', (url) => {
      if (url.includes('pageToken=list-2')) {
        return jsonResponse({
          files: [{ id: 'doc-b', name: 'Beacon reliability report', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-15T09:00:00.000Z', version: '4' }]
        });
      }
      return jsonResponse({
        nextPageToken: 'list-2',
        files: [
          { id: 'doc-a', name: 'Northstar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-16T09:00:00.000Z', version: '7' },
          { id: 'sheet-1', name: 'Data', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-16T08:00:00.000Z', version: '1' }
        ]
      });
    }],
    ['drive/v3/files/doc-a/export', textResponse('## Experiment results\nSample size: 1,200\n')],
    ['drive/v3/files/doc-b/export', textResponse('Incident count: 4\n')]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1' } } });
  assert.equal(result.partial, false);
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 2);
  const [newer, older] = result.events;
  assert.equal(newer.type, 'document.modified');
  assert.equal(newer.source, 'google');
  assert.equal(newer.payload.externalId, 'doc-a');
  assert.equal(newer.payload.title, 'Northstar project proposal');
  assert.equal(newer.payload.modifiedAt, '2026-10-16T09:00:00.000Z');
  assert.match(newer.payload.url, /docs\.google\.com\/document\/d\/doc-a/);
  assert.match(newer.payload.content, /Experiment results/);
  assert.equal(older.payload.externalId, 'doc-b');
  assert.equal(result.cursor.drive.pageToken, 'p-2');
  assert.equal(result.cursor.drive.filesModifiedAfter, '2026-10-16T09:00:00.000Z');
  assert.equal(result.cursor.drive.filesPageToken, null);
});

test('a repeat drive sync resumes the cursor and does not export documents already listed', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-2', jsonResponse({ newStartPageToken: 'p-2', changes: [] })],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({
    cursor: { drive: { pageToken: 'p-2', filesModifiedAfter: '2026-10-16T09:00:00.000Z' } }
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.partial, false);
  assert.equal(result.cursor.drive.pageToken, 'p-2');
  assert.equal(result.cursor.drive.filesModifiedAfter, '2026-10-16T09:00:00.000Z');
  assert.equal(calls.some(call => call.url.includes('/export')), false);
  assert.equal(calls.some(call => call.url.includes('modifiedTime')), true);
});

test('removed and trashed drive documents produce invalidation events, not silence', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({
      newStartPageToken: 'p-2',
      changes: [
        { fileId: 'doc-gone', removed: true, time: '2026-10-17T09:00:00.000Z', file: { id: 'doc-gone', name: 'Northstar old draft' } },
        { fileId: 'doc-trash', time: '2026-10-17T10:00:00.000Z', file: { id: 'doc-trash', name: 'Beacon trash', mimeType: 'application/vnd.google-apps.document', trashed: true, modifiedTime: '2026-10-17T10:00:00.000Z', version: '3' } },
        { fileId: 'doc-live', time: '2026-10-17T11:00:00.000Z', file: { id: 'doc-live', name: 'Northstar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-17T11:00:00.000Z', version: '8' } }
      ]
    })],
    ['drive/v3/files/doc-live/export', textResponse('## Experiment results\n')],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1' } } });
  assert.equal(result.errors.length, 0);
  const unavailable = result.events.filter(event => event.type === 'document.unavailable');
  assert.deepEqual(unavailable.map(event => event.payload.id).sort(), ['doc-gone', 'doc-trash']);
  assert.equal(unavailable.find(event => event.payload.id === 'doc-gone').payload.reason, 'removed');
  assert.equal(unavailable.find(event => event.payload.id === 'doc-trash').payload.reason, 'trashed');
  assert.equal(calls.some(call => call.url.includes('/doc-trash/export')), false, 'a trashed document is not exported');
  assert.equal(result.events.filter(event => event.type === 'document.modified').length, 1);
});

test('an inaccessible listed document is invalidated without discarding a document that exported', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({ newStartPageToken: 'p-2', changes: [{ fileId: 'gone', removed: true }] })],
    ['drive/v3/files?', jsonResponse({
      files: [
        { id: 'missing', name: 'Gone', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-16T10:00:00.000Z', version: '2' },
        { id: 'doc-a', name: 'Northstar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-16T09:00:00.000Z', version: '7' }
      ]
    })],
    ['drive/v3/files/missing/export', jsonResponse({ error: 'not found' }, 404)],
    ['drive/v3/files/doc-a/export', textResponse('## Experiment results\n')]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1' } } });
  assert.equal(result.partial, false, 'a definitively inaccessible file is handled, not a sync failure');
  assert.equal(result.errors.length, 0);
  assert.equal(result.events.filter(event => event.type === 'document.modified').length, 1);
  const invalidated = result.events.filter(event => event.type === 'document.unavailable');
  assert.deepEqual(invalidated.map(event => event.payload.id).sort(), ['gone', 'missing']);
  assert.equal(invalidated.find(event => event.payload.id === 'missing').payload.reason, 'inaccessible');
  assert.equal(result.cursor.drive.filesModifiedAfter, '2026-10-16T10:00:00.000Z',
    'a handled invalidation does not hold the listing cursor forever');
});

test('a transient export failure does not masquerade as a removal', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({ newStartPageToken: 'p-2', changes: [
      { fileId: 'doc-a', file: { id: 'doc-a', name: 'Northstar project proposal', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-16T09:00:00.000Z', version: '7' } }
    ] })],
    ['drive/v3/files/doc-a/export', jsonResponse({ error: 'backend down' }, 503)],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1' } } });
  assert.equal(result.events.length, 0, 'a temporary failure must not invalidate the document');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].retryable, true);
  assert.equal(result.cursor.drive.pageToken, 'p-1', 'the change cursor must not advance past the failure');
});

test('expired authorization on the document list fails the drive scope instead of reporting success', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['drive/v3/changes?pageToken=p-1', jsonResponse({ newStartPageToken: 'p-2', changes: [] })],
    ['drive/v3/files?', jsonResponse({ error: 'expired' }, 401)]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: { ...CREDENTIALS, readGmail: false }, fetchImpl });
  const result = await connector.pull({ cursor: { drive: { pageToken: 'p-1', filesModifiedAfter: '2026-01-01T00:00:00.000Z' } } });
  assert.equal(result.partial, true);
  assert.equal(result.events.length, 0);
  assert.match(result.errors[0].message, /401/);
  assert.equal(result.cursor.drive.pageToken, 'p-1', 'a failed list must not advance the cursor');
  assert.equal(result.cursor.drive.filesModifiedAfter, '2026-01-01T00:00:00.000Z');
});

test('a replayed drive document is deduplicated by the engine', () => {
  const store = storeIn();
  const engine = new WorkEngine(store);
  const event = {
    id: 'google:drive:doc-a:7',
    connectorId: 'google',
    providerEventId: 'drive:doc-a:7',
    source: 'google',
    type: 'document.modified',
    payload: {
      id: 'doc-a', title: 'Northstar project proposal', kind: 'document',
      content: '# Northstar\n', modifiedAt: '2026-10-16T09:00:00.000Z', externalId: 'doc-a',
      url: 'https://docs.google.com/document/d/doc-a/edit'
    }
  };
  const first = engine.ingest(event);
  const second = engine.ingest(event);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.state.events.length, 1);
  assert.equal(Object.keys(store.state.documents).length, 1);
});

// --------------------------------------------------------------- failure modes

test('a gmail failure is reported and produces no synthetic events', async () => {
  const { fetchImpl } = scriptedFetch([
    tokenRoute,
    ['gmail/v1/users/me/history', jsonResponse({ error: 'unauthorised' }, 401)],
    ['drive/v3/changes/startPageToken', jsonResponse({ startPageToken: 'p-1' })],
    ['drive/v3/files?', jsonResponse({ files: [] })]
  ]);
  const connector = new GoogleWorkspaceConnector({ config: CREDENTIALS, fetchImpl });
  const result = await connector.pull({ cursor: { gmail: { historyId: 'h1' } } });
  assert.equal(result.events.length, 0);
  assert.equal(result.partial, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, 'gmail');
  assert.match(result.errors[0].message, /401/);
  assert.equal(result.cursor.drive.pageToken, 'p-1', 'the healthy scope still advances');
});

test('a connector failure never degrades into a simulated success', async () => {
  const store = storeIn();
  const failing = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async () => { throw new Error('network down'); }
  });
  const provider = new GoogleMailAdapter(failing);
  const engine = new WorkEngine(store, { provider });
  engine.ingest({ id: 'e1', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  } });
  engine.ingest({ id: 'e2', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  const result = await engine.approve('request:m1');
  assert.equal(result.status, 'blocked');
  assert.equal(store.state.outbox.length, 0, 'the simulated outbox must stay empty on a live failure');
  assert.match(result.reason, /could not confirm|network down/i);
});

test('an ambiguous send timeout is not retried blindly', async () => {
  const store = storeIn();
  let sendAttempts = 0;
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async url => {
      if (isTokenEndpoint(url)) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (url.includes('/messages?q=')) return jsonResponse({ messages: [] }); // definitively absent before send
      if (url.includes('/messages/send')) { sendAttempts += 1; throw new Error('socket hang up'); }
      throw new Error(`Unscripted ${url}`);
    }
  });
  const engine = new WorkEngine(store, { provider: new GoogleMailAdapter(connector) });
  engine.ingest({ id: 'e1', type: 'email.received', payload: {
    id: 'm1', from: 'a@b.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  } });
  engine.ingest({ id: 'e2', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  const result = await engine.approve('request:m1');
  assert.equal(result.status, 'blocked');
  assert.equal(sendAttempts, 1, 'the send must be attempted exactly once');
  assert.equal(store.state.outbox.length, 0);
  assert.equal(result.action.status, 'uncertain');
  assert.throws(() => engine.retry('request:m1'), /confirmed absence/);
});

test('a live permission failure blocks before any send is attempted', async () => {
  const store = storeIn();
  let sendAttempts = 0;
  const failing = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async url => {
      if (isTokenEndpoint(url)) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (url.includes('/messages/send')) { sendAttempts += 1; return jsonResponse({ id: 'x' }); }
      return jsonResponse({ error: 'forbidden' }, 403);
    }
  });
  const engine = new WorkEngine(store, { provider: new GoogleMailAdapter(failing) });
  engine.ingest({ id: 'e1', type: 'email.received', payload: {
    id: 'm1', from: 'a@b.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  } });
  engine.ingest({ id: 'e2', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  const result = await engine.approve('request:m1');
  assert.equal(result.status, 'blocked');
  assert.equal(sendAttempts, 0, 'an unverifiable provider state must not be followed by a send');
  assert.equal(store.state.outbox.length, 0);
  assert.match(result.reason, /403|denied/i);
});

test('a CRLF in the recipient is refused before any network call', async () => {
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async () => { throw new Error('the network must not be reached'); }
  });
  await assert.rejects(
    () => connector.execute({
      to: 'dana@example.test\r\nBcc: attacker@example.test',
      subject: 'Update', body: 'Body', idempotencyKey: 'k-crlf-to'
    }),
    /recipient/i
  );
});

test('a CRLF in the subject is refused before any network call', async () => {
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async () => { throw new Error('the network must not be reached'); }
  });
  await assert.rejects(
    () => connector.execute({
      to: 'dana@example.test', subject: 'Update\r\nBcc: attacker@example.test',
      body: 'Body', idempotencyKey: 'k-crlf-subject'
    }),
    /subject/i
  );
});

test('a unicode subject and a multi-line body become one well-formed message', async () => {
  let sent = null;
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async (url, options = {}) => {
      if (isTokenEndpoint(url)) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (url.includes('/messages/send')) { sent = JSON.parse(options.body); return jsonResponse({ id: 'gmail-1' }); }
      throw new Error(`Unscripted ${url}`);
    }
  });
  await connector.execute({
    to: '"Dana Lee" <dana@example.test>', subject: 'Q3 指标 — 更新',
    body: 'Line one.\nLine two.', idempotencyKey: 'k-unicode'
  });
  const raw = Buffer.from(sent.raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: "?Dana Lee"? <dana@example\.test>\r\n/);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, 'a non-ASCII subject must be MIME-encoded, never raw');
  assert.match(raw, /\r\n\r\nLine one\.\r\nLine two\.$/, 'the body keeps its lines after the header block');
  assert.equal(/\r\n(Bcc|Cc):/i.test(raw), false, 'no extra headers may be smuggled in');
});

test('an accepted live send is verified against the provider after it is sent', async () => {
  const store = storeIn();
  const calls = [];
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async url => {
      calls.push(url);
      if (isTokenEndpoint(url)) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (url.includes('/messages?q=')) return jsonResponse({ messages: [] }); // nothing sent before
      if (url.includes('/messages/send')) return jsonResponse({ id: 'gmail-msg-1', threadId: 't-1' });
      if (url.includes('/messages/gmail-msg-1')) return jsonResponse({ id: 'gmail-msg-1', threadId: 't-1' });
      throw new Error(`Unscripted ${url}`);
    }
  });
  const engine = new WorkEngine(store, { provider: new GoogleMailAdapter(connector) });
  engine.ingest({ id: 'e1', type: 'email.received', payload: {
    id: 'm1', from: 'a@b.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  } });
  engine.ingest({ id: 'e2', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  const result = await engine.approve('request:m1');
  assert.equal(result.status, 'completed');
  assert.equal(result.action.status, 'verified_live');
  assert.equal(result.action.receiptId, 'gmail-msg-1');
  assert.equal(store.state.outbox.length, 0, 'a live send must not touch the simulated outbox');
  const sent = calls.findIndex(url => url.includes('/messages/send'));
  const verified = calls.findIndex(url => url.includes('/messages/gmail-msg-1'));
  assert.ok(sent >= 0 && verified > sent, 'the message must be read back from Gmail after it is sent');
});

test('an accepted send that cannot be re-read is blocked, then reconciles to verified', async () => {
  const store = storeIn();
  let messageReads = 0;
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false, maxRetries: 0 },
    fetchImpl: async url => {
      if (isTokenEndpoint(url)) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (url.includes('/messages?q=')) return jsonResponse({ messages: [] });
      if (url.includes('/messages/send')) return jsonResponse({ id: 'gmail-msg-2', threadId: 't-2' });
      if (url.includes('/messages/gmail-msg-2')) {
        messageReads += 1;
        if (messageReads === 1) return jsonResponse({ error: 'backend down' }, 500);
        return jsonResponse({ id: 'gmail-msg-2', threadId: 't-2' });
      }
      throw new Error(`Unscripted ${url}`);
    }
  });
  const engine = new WorkEngine(store, { provider: new GoogleMailAdapter(connector) });
  engine.ingest({ id: 'e1', type: 'email.received', payload: {
    id: 'm1', from: 'a@b.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  } });
  engine.ingest({ id: 'e2', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  const blocked = await engine.approve('request:m1');
  assert.equal(blocked.status, 'blocked', 'an unverified send must never read as completed');
  assert.equal(blocked.action.status, 'accepted_live');
  assert.equal(blocked.action.receiptId, 'gmail-msg-2');
  assert.match(blocked.reason, /verified/i);
  const reconciled = await engine.reconcile('request:m1');
  assert.equal(reconciled.status, 'completed');
  assert.equal(reconciled.action.status, 'verified_live');
});

test('a Gmail response without a message id is never marked verified', async () => {
  const connector = new GoogleWorkspaceConnector({
    config: { ...CREDENTIALS, sendEnabled: true, shadow: false },
    fetchImpl: async url => {
      if (isTokenEndpoint(url)) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (url.includes('/messages/send')) return jsonResponse({ threadId: 't-3' }); // no id
      throw new Error(`Unscripted ${url}`);
    }
  });
  const adapter = new GoogleMailAdapter(connector);
  await assert.rejects(
    () => adapter.send({ idempotencyKey: 'k-no-id', to: 'dana@example.test', subject: 'Hi', body: 'Body' }),
    /message id/i
  );
});

test('an asynchronous provider settles through the promise path and is verified as live', async () => {
  const store = storeIn();
  const calls = [];
  const asyncProvider = {
    kind: 'async-test', live: true,
    async lookup(key) { calls.push(['lookup', key]); return { status: 'not_found' }; },
    async send(payload) { calls.push(['send', payload.idempotencyKey]); return { id: 'async-1', provider: 'async-test', status: 'accepted_live' }; },
    async verifyReceipt(receipt) { calls.push(['verifyReceipt', receipt.id]); return { status: 'found', receipt: { id: receipt.id } }; }
  };
  const engine = new WorkEngine(store, { provider: asyncProvider });
  engine.ingest({ id: 'e1', type: 'email.received', payload: {
    id: 'm1', from: 'a@b.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send it by Friday.'
  } });
  engine.ingest({ id: 'e2', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  const pending = engine.approve('request:m1');
  assert.ok(pending instanceof Promise, 'an asynchronous provider must return a promise');
  const result = await pending;
  await engine.whenSettled();
  assert.equal(result.status, 'completed');
  assert.equal(result.action.status, 'verified_live');
  assert.equal(result.action.live, true);
  assert.equal(store.state.outbox.length, 0, 'a live provider must not write to the simulated outbox');
  // Look up, send, then re-read the receipt from the provider.
  assert.deepEqual(calls.map(call => call[0]), ['lookup', 'send', 'verifyReceipt']);
});

test('cursors and connector status persist across a restart', () => {
  const store = storeIn();
  const runtime = buildRuntime({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' }, { store });
  runtime.cursors.set('google', { gmail: { historyId: 'h9' }, drive: { pageToken: 'p9' } });
  runtime.cursors.status('google', { ok: true, eventsIngested: 3 });
  const restored = new JsonStore(store.filename);
  assert.equal(restored.state.cursors.google.gmail.historyId, 'h9');
  assert.equal(restored.state.connectorStatus.google.eventsIngested, 3);
});

test('connector errors carry retryability so callers can distinguish transient faults', () => {
  const retryable = new ConnectorError('temporary', { status: 503, retryable: true });
  const fatal = new ConnectorError('bad credentials', { status: 401 });
  assert.equal(retryable.retryable, true);
  assert.equal(fatal.retryable, false);
  assert.equal(retryable.status, 503);
});
