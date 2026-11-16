import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore } from '../src/connectors/connector.js';
import { MonitoringService } from '../src/monitoring.js';
import { LocalSetupStore } from '../src/setup.js';

const at = '2026-11-14T09:00:00.000Z';
const now = () => Date.parse(at);

function makeStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-health-matrix-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  t.after(() => {
    try { store.close(); } catch { /* already closed by a restart test */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, cursors: new CursorStore(store) };
}

function engineFor(ingest = () => ({})) {
  return { ingest, durableRuntime: null };
}

function connectorFor(id, pull) {
  return { id, live: true, pull };
}

function syncFor(connectors, cursors, { engine = engineFor(), timeoutMs = null } = {}) {
  return new ConnectorSync({ connectors, cursors, engine, now, timeoutMs });
}

function monitorFixture(t, { intervalMs = 15_000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-health-monitor-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const cursors = new CursorStore(store);
  t.after(() => { try { store.close(); } catch { /* already closed */ } fs.rmSync(directory, { recursive: true, force: true }); });
  let clock = now();
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  const timers = [];
  const setTimer = (callback, delayMs) => {
    const timer = { callback, delayMs, unref() {} };
    timers.push(timer);
    return timer;
  };
  const clearTimer = timer => {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
  };
  setup.setMonitoring({ enabled: true, userConfigured: true, intervalMs });
  return { store, cursors, setup, timers, setTimer, clearTimer, now: () => clock, advance: ms => { clock += ms; } };
}

test('401 stores a bounded public message and a reconnect repair, never credentials or provider bodies', async t => {
  const f = makeStore(t);
  // Assembled at runtime so the public credential-signature gate does not flag the fixture.
  const secret = ['ya29', 'SECRET_ACCESS_TOKEN_VALUE'].join('.');
  const sync = syncFor([connectorFor('google', async () => {
    throw Object.assign(new Error(
      `401 Unauthorized for https://api.example.test/v1/messages?pageToken=CONTINUATION_TOKEN_1234567890 ` +
      `account 1234567890123456 body {"access_token":"${secret}","error":"invalid_grant"}`
    ), { status: 401 });
  })], f.cursors);

  const outcome = await sync.run();
  const status = f.store.state.connectorStatus.google;
  assert.equal(outcome.results[0].failed, true);
  assert.deepEqual(status.repair, { code: 'SOURCE_RECONNECT', action: 'reauthorize' });
  assert.equal(status.ok, false);
  assert.equal(status.complete, false);
  assert.match(status.lastError, /401/);
  const publicText = JSON.stringify(status);
  for (const forbidden of [secret, 'CONTINUATION_TOKEN_1234567890', 'pageToken=', '1234567890123456', '"error"', 'invalid_grant']) {
    assert.equal(publicText.includes(forbidden), false, `${forbidden} leaked into public status`);
  }
  assert.equal(status.eventsIngested, 0);
});

test('403 revoked scope is classified as reauthorize and a disabled provider fails the pull without advancing the cursor', async t => {
  const f = makeStore(t);
  f.cursors.set('google', { gmail: { historyId: '100' } });
  const sync = syncFor([connectorFor('google', async () => {
    throw Object.assign(new Error('403 insufficientPermissions: revoked or missing scope'), { status: 403 });
  })], f.cursors);
  await sync.run();
  const status = f.store.state.connectorStatus.google;
  assert.deepEqual(status.repair, { code: 'SOURCE_ACCESS_DENIED', action: 'reauthorize' });
  assert.deepEqual(f.cursors.get('google'), { gmail: { historyId: '100' } });

  const disabled = syncFor([{ id: 'google', live: false, pull: async () => assert.fail('must not pull') }], f.cursors);
  const skipped = await disabled.run();
  assert.deepEqual(skipped.results, []);
});

test('a partial 429 keeps the good scope cursor and reaches the scheduler as a rate-limit backoff', async t => {
  const f = makeStore(t);
  f.cursors.set('google', { gmail: { historyId: '100' }, drive: { pageToken: 'drive-1' } });
  const sync = syncFor([connectorFor('google', async () => ({
    events: [],
    hasMore: false,
    partial: true,
    scopes: {
      gmail: { status: 'failed' },
      drive: { status: 'complete', cursor: { pageToken: 'drive-2' } }
    },
    errors: [{ scope: 'gmail', status: 429, retryAfterMs: 45_000, message: '429 rate limit https://api.example.test/?pageToken=SECRET_CONTINUATION' }]
  }))], f.cursors);
  const outcome = await sync.run();

  assert.deepEqual(f.cursors.get('google'), { gmail: { historyId: '100' }, drive: { pageToken: 'drive-2' } },
    'the failed scope keeps its prior cursor and the healthy scope advances');
  const result = outcome.results[0];
  assert.equal(result.partial, true);
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterMs, 45_000);
  assert.deepEqual(result.repair, { code: 'SOURCE_RATE_LIMITED', action: 'wait' });
  const status = f.store.state.connectorStatus.google;
  assert.equal(status.ok, false);
  assert.equal(status.complete, false);
  assert.equal(status.rateLimited, true);
  assert.equal(status.retryAfterMs, 45_000);
  assert.deepEqual(status.repair, { code: 'SOURCE_RATE_LIMITED', action: 'wait' });
  assert.equal(JSON.stringify(status).includes('SECRET_CONTINUATION'), false);
});

test('429 backoff schedules the provider delay, and an identical repeated failure keeps one notice timestamp', async t => {
  const f = monitorFixture(t, { intervalMs: 15_000 });
  let mode = 'rate-limited';
  const connector = connectorFor('google', async () => {
    if (mode === 'healthy') return { events: [], hasMore: false, cursor: { gmail: { historyId: '200' } } };
    throw Object.assign(new Error('429 Too Many Requests'), { status: 429, retryAfterMs: 30_000 });
  });
  const sync = syncFor([connector], f.cursors);
  const monitor = new MonitoringService({ sync, setup: f.setup, connectors: [connector], now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  t.after(() => monitor.stop());

  await monitor.start();
  await monitor.whenIdle();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delayMs, 30_000, 'the provider retry delay wins over the 15s interval');
  const firstFailureAt = f.setup.get().monitoring.lastFailureAt;
  const firstError = f.setup.get().monitoring.lastError;
  assert.match(firstError, /429/);
  assert.equal(firstError.includes('pageToken'), false);

  f.advance(1000);
  await monitor.runNow();
  await monitor.whenIdle();
  assert.equal(f.setup.get().monitoring.lastFailureAt, firstFailureAt, 'a repeated identical failure does not create a new notice');
  assert.equal(f.setup.get().monitoring.lastError, firstError);

  mode = 'healthy';
  f.advance(1000);
  await monitor.runNow();
  await monitor.whenIdle();
  assert.equal(f.setup.get().monitoring.lastError, null, 'a real complete success clears the failure notice');
  assert.equal(f.store.state.connectorStatus.google.repair, null, 'success clears the repair state');
  assert.equal(f.store.state.connectorStatus.google.complete, true);
});

test('offline and timed-out pulls are retryable unreachable failures, not successes', async t => {
  const f = makeStore(t);
  const offline = syncFor([connectorFor('google', async () => { throw new Error('fetch failed: network offline'); })], f.cursors);
  await offline.run();
  assert.deepEqual(f.store.state.connectorStatus.google.repair, { code: 'SOURCE_UNREACHABLE', action: 'retry' });

  const hang = syncFor([connectorFor('google', () => new Promise(() => {}))], f.cursors, { timeoutMs: 25 });
  await hang.run();
  const status = f.store.state.connectorStatus.google;
  assert.equal(status.ok, false);
  assert.match(status.lastError, /timed out/);
  assert.deepEqual(status.repair, { code: 'SOURCE_UNREACHABLE', action: 'retry' });
});

test('an aborted observation restores prior health and observation but keeps the acknowledged page cursor', async t => {
  const f = makeStore(t);
  f.cursors.set('google', { gmail: { historyId: '94' } });
  f.cursors.status('google', { ok: true, complete: true, lastError: null, repair: null,
    lastSuccessAt: '2026-11-13T09:00:00.000Z', eventsIngested: 3, lastSyncAt: '2026-11-13T09:00:00.000Z' });
  f.cursors.observe('google', { complete: true, observedAt: '2026-11-13T09:00:00.000Z', watermark: '94' });
  const healthBefore = structuredClone(f.store.state.connectorStatus.google);
  const observationBefore = structuredClone(f.cursors.observation('google'));

  const controller = new AbortController();
  let pulls = 0;
  const connector = connectorFor('google', async () => {
    pulls += 1;
    return pulls === 1
      ? { events: [{ id: 'event-1' }], cursor: { gmail: { historyId: '95' } }, hasMore: true }
      : { events: [{ id: 'event-2' }], cursor: { gmail: { historyId: '96' } }, hasMore: false };
  });
  const sync = syncFor([connector], f.cursors, { engine: engineFor(event => {
    if (event.id === 'event-2') controller.abort();
    return {};
  }) });
  const result = await sync.runConnector('google', { signal: controller.signal });

  assert.equal(result.aborted, true);
  assert.equal(result.failed, true);
  assert.deepEqual(f.cursors.get('google'), { gmail: { historyId: '95' } }, 'only the acknowledged page advances the cursor');
  assert.deepEqual(f.store.state.connectorStatus.google, healthBefore, 'abort restores the pre-pass health record');
  assert.deepEqual(f.cursors.observation('google'), observationBefore, 'abort restores the pre-pass observation');
});

test('the repair state survives a restart and is cleared only by a complete successful page', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-health-restart-'));
  const file = path.join(directory, 'state.json');
  let store = new SqliteStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } fs.rmSync(directory, { recursive: true, force: true }); });

  let cursors = new CursorStore(store);
  let sync = syncFor([connectorFor('google', async () => {
    throw Object.assign(new Error('401 invalid_grant: token expired or revoked'), { status: 401 });
  })], cursors);
  await sync.run();
  assert.deepEqual(store.state.connectorStatus.google.repair, { code: 'SOURCE_RECONNECT', action: 'reauthorize' });
  store.close();

  store = new SqliteStore(file);
  cursors = new CursorStore(store);
  assert.deepEqual(store.state.connectorStatus.google.repair, { code: 'SOURCE_RECONNECT', action: 'reauthorize' },
    'the repair state is persisted, not held in memory');
  sync = syncFor([connectorFor('google', async () => ({ events: [], hasMore: false, cursor: { gmail: { historyId: '300' } } }))], cursors);
  const outcome = await sync.run();
  assert.equal(outcome.results[0].failed, false);
  const status = store.state.connectorStatus.google;
  assert.equal(status.repair, null);
  assert.equal(status.lastError, null);
  assert.equal(status.complete, true);
  assert.equal(status.ok, true);
  assert.ok(status.lastSuccessAt);
});

test('monitoring status exposed to the public setup surface contains no provider token, query or body', async t => {
  const f = monitorFixture(t);
  const connector = connectorFor('google', async () => {
    throw Object.assign(new Error(
      '401 for https://api.example.test/v1/messages?pageToken=MONITOR_SECRET_CONTINUATION {"refresh_token":"MONITOR_SECRET_REFRESH"}'
    ), { status: 401 });
  });
  const sync = syncFor([connector], f.cursors);
  const monitor = new MonitoringService({ sync, setup: f.setup, connectors: [connector], now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  t.after(() => monitor.stop());
  await monitor.start();
  await monitor.whenIdle();

  const exposed = JSON.stringify({ describe: monitor.describe(), setup: f.setup.get().monitoring, connector: f.store.state.connectorStatus });
  assert.equal(exposed.includes('MONITOR_SECRET_CONTINUATION'), false);
  assert.equal(exposed.includes('MONITOR_SECRET_REFRESH'), false);
  assert.equal(exposed.includes('pageToken='), false);
  assert.equal(exposed.includes('{"refresh_token"'), false);
  assert.match(monitor.describe().lastError, /401/);
});
