import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSetupStore } from '../src/setup.js';
import { MonitoringService } from '../src/monitoring.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-monitor-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-25T00:00:00Z');
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
  return { setup, timers, setTimer, clearTimer, now: () => now, advance: ms => { now += ms; } };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('enabling observation persists the setting, starts immediately, and does not overlap a slow run', async t => {
  const f = fixture(t);
  let release;
  let starts = 0;
  const sync = { run: () => {
    starts += 1;
    if (starts === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ results: [{ connector: 'google', failed: false, partial: false }] });
  } };
  const monitor = new MonitoringService({ sync, setup: f.setup, connectors: [{ live: true }], now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await monitor.setSettings({ enabled: true, intervalMs: 60_000 });
  await waitFor(() => starts === 1, 'the first sync should start immediately');
  assert.equal(monitor.describe().status, 'syncing');
  const overlapping = await monitor.runNow();
  assert.equal(overlapping.skipped, 'A sync is already running.');
  assert.equal(starts, 1);
  release({ results: [{ connector: 'google', failed: false, partial: false }] });
  await monitor.whenIdle();
  assert.equal(f.setup.get().monitoring.enabled, true);
  assert.ok(f.setup.get().monitoring.lastSuccessAt);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delayMs, 60_000);
  assert.equal(monitor.describe().status, 'watching');
  f.timers[0].callback();
  await waitFor(() => starts === 2, 'the next sync should begin after the interval');
  await monitor.whenIdle();
  assert.equal(starts, 2);
  monitor.stop();
});

test('failed syncs record failure without claiming success; disabling preserves run history', async t => {
  const f = fixture(t);
  let next = { results: [{ connector: 'google', failed: true, partial: true, error: 'network unavailable' }] };
  const monitor = new MonitoringService({
    sync: { async run() { return next; } },
    setup: f.setup,
    connectors: [{ live: true }],
    now: f.now,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer
  });
  await monitor.setSettings({ enabled: true });
  await monitor.whenIdle();
  let state = monitor.describe();
  assert.equal(state.status, 'failed');
  assert.equal(state.lastSuccessAt, null);
  assert.ok(state.lastFailureAt);
  assert.match(state.lastError, /network unavailable/);
  next = { results: [{ connector: 'google', failed: false, partial: false }] };
  f.advance(1000);
  await monitor.runNow();
  state = monitor.describe();
  assert.equal(state.status, 'watching');
  assert.ok(state.lastSuccessAt);
  const lastSuccessAt = state.lastSuccessAt;
  await monitor.setSettings({ enabled: false });
  state = monitor.describe();
  assert.equal(state.status, 'off');
  assert.equal(state.lastSuccessAt, lastSuccessAt);
  assert.equal(f.setup.get().monitoring.enabled, false);
  assert.equal(f.timers.length, 0);
});

test('a failure and recovery in the same millisecond use the recorded outcome, not timestamp ordering', async t => {
  const f = fixture(t);
  const outcomes = [
    { results: [{ connector: 'google', failed: false, partial: false }] },
    { results: [{ connector: 'google', failed: true, partial: true, error: 'temporary failure' }] },
    { results: [{ connector: 'google', failed: false, partial: false }] }
  ];
  const monitor = new MonitoringService({
    sync: { async run() { return outcomes.shift(); } },
    setup: f.setup,
    connectors: [{ live: true }],
    now: f.now,
    setTimer: f.setTimer,
    clearTimer: f.clearTimer
  });
  await monitor.setSettings({ enabled: true });
  await monitor.whenIdle();
  assert.equal(monitor.describe().status, 'watching');
  const successAt = monitor.describe().lastSuccessAt;

  await monitor.runNow();
  let state = monitor.describe();
  assert.equal(state.lastFailureAt, successAt, 'the fake clock keeps both outcomes in the same millisecond');
  assert.equal(state.status, 'failed');

  await monitor.runNow();
  state = monitor.describe();
  assert.equal(state.lastSuccessAt, successAt);
  assert.equal(state.status, 'watching', 'a success clears the current failure marker at the same timestamp');
  assert.equal(state.lastError, null);
  monitor.stop();
});

test('restart resumes a persisted enabled setting with an immediate sync; stale state expires honestly', async t => {
  const f = fixture(t);
  f.setup.setMonitoring({ enabled: true, userConfigured: true, intervalMs: 15_000 });
  f.setup.setMonitoring({ lastSuccessAt: new Date(f.now() - 10 * 60_000).toISOString() });
  const outcomes = [];
  const sync = { async run() { outcomes.push('sync'); return { results: [{ connector: 'google', failed: false }] }; } };
  const monitor = new MonitoringService({ sync, setup: f.setup, connectors: [{ live: true }], now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  assert.equal(monitor.describe().status, 'expired');
  assert.ok(f.setup.get().monitoring.lastExpiredAt);
  await monitor.start();
  await monitor.whenIdle();
  assert.deepEqual(outcomes, ['sync']);
  assert.equal(monitor.describe().status, 'watching');
  assert.equal(f.timers.length, 1);
  monitor.stop();
});

test('observation cannot be enabled without a live connector and preserves a closed state on restart', async t => {
  const f = fixture(t);
  const monitor = new MonitoringService({ sync: { async run() { throw new Error('must not run'); } }, setup: f.setup, connectors: [] });
  await assert.rejects(monitor.setSettings({ enabled: true }), /Connect and authorize/);
  assert.equal(f.setup.get().monitoring.enabled, false);
  monitor.stop();
  const restarted = new MonitoringService({ sync: { async run() { throw new Error('must not run'); } }, setup: f.setup, connectors: [{ live: true }] });
  await restarted.start();
  assert.equal(restarted.describe().status, 'off');
  restarted.stop();
});

test('remaining pages receive bounded prompt continuations, while failures and pause stop them', async t => {
  const f = fixture(t);
  let next = { results: [{ connector: 'google', failed: false, partial: false, hasMore: true }] }, calls = 0;
  const monitor = new MonitoringService({ sync: { async run() { calls++; return next; } }, setup: f.setup, connectors: [{ live: true }], now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await monitor.setSettings({ enabled: true, intervalMs: 60000 }); await monitor.whenIdle();
  for (let index = 0; index < 4; index++) {
    assert.equal(f.timers[0].delayMs, 1000);
    f.timers.shift().callback(); await monitor.whenIdle();
  }
  assert.equal(calls, 5); assert.equal(f.timers[0].delayMs, 60000, 'continuous backlog cannot monopolise polling indefinitely');
  next = { results: [{ connector: 'google', failed: true, error: 'rate limited', hasMore: true }] };
  await monitor.runNow();
  assert.equal(f.timers[0].delayMs, 60000, 'a failure never creates a rapid retry');
  await monitor.setSettings({ enabled: false });
  assert.equal(f.timers.length, 0);
  monitor.stop();
});
