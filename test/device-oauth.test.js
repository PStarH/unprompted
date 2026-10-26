import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSetupStore } from '../src/setup.js';
import { DeviceOAuth, SavedConnectionAuth } from '../src/device-oauth.js';
import { publicClientConfiguration, validPublicClientId } from '../src/connection-catalog.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-device-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
}
function clock() {
  let now = 0;
  const timers = [];
  return { now: () => now, timers, setTimer(callback, ms) { const item = { callback, ms }; timers.push(item); return item; },
    clearTimer(item) { const index = timers.indexOf(item); if (index >= 0) timers.splice(index, 1); },
    async tick() { const item = timers.shift(); assert.ok(item); now += item.ms; item.callback();
      for (let index = 0; index < 15; index++) await new Promise(resolve => setImmediate(resolve)); return item.ms; } };
}

test('GitHub device OAuth respects pending and slow_down, verifies identity and keeps tokens private', async t => {
  const setup = fixture(t), time = clock(); let polls = 0, activated = 0;
  const oauth = new DeviceOAuth(setup, { ...time, onConnected: async () => { activated++; }, fetchImpl: async (url, options) => {
    if (url.endsWith('/login/device/code')) {
      assert.doesNotMatch(options.body, /client_secret|repo/);
      return json({ device_code: 'PRIVATE_DEVICE_CODE', user_code: 'CODE-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (url.endsWith('/login/oauth/access_token')) {
      polls++; if (polls === 1) return json({ error: 'authorization_pending' });
      if (polls === 2) return json({ error: 'slow_down', interval: 10 });
      return json({ access_token: 'PRIVATE_ACCESS_TOKEN', refresh_token: 'PRIVATE_REFRESH_TOKEN', expires_in: 28800 });
    }
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(options.headers.authorization, 'Bearer PRIVATE_ACCESS_TOKEN');
    return json({ id: 123, login: 'reader' });
  } });
  t.after(() => oauth.close());
  await oauth.start('github', { clientId: 'registered-app' });
  assert.equal(time.timers[0].ms, 5000);
  await time.tick(); assert.equal(oauth.describe('github').phase, 'authorizing');
  await time.tick(); assert.equal(time.timers[0].ms, 10000);
  await time.tick(); assert.equal(oauth.describe('github').phase, 'connected');
  assert.equal(activated, 1); assert.equal(setup.getConnection('github').account.label, 'reader');
  assert.doesNotMatch(JSON.stringify(oauth.describe('github')), /PRIVATE_|CODE-1234/);
});

test('a cancelled device flow cannot save a late authorization or reactivate an account', async t => {
  const setup = fixture(t), time = clock(); let resolveToken, activated = false;
  const oauth = new DeviceOAuth(setup, { ...time, onConnected: async () => { activated = true; }, fetchImpl: async url => {
    if (url.endsWith('/login/device/code')) return json({ device_code: 'private', user_code: 'CODE-1234', verification_uri: 'https://github.com/login/device', expires_in: 900 });
    return new Promise(resolve => { resolveToken = resolve; });
  } });
  await oauth.start('github', { clientId: 'registered-app' });
  await time.tick(); oauth.cancel('github'); resolveToken(json({ access_token: 'late-private-token' }));
  for (let index = 0; index < 15; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(oauth.describe('github').phase, 'cancelled');
  assert.equal(setup.getConnection('github').accessToken, undefined); assert.equal(activated, false);
});

test('device authorization rejects untrusted verification URLs and expires without polling past the deadline', async t => {
  const setup = fixture(t), time = clock(); let requests = 0;
  const bad = new DeviceOAuth(setup, { ...time, fetchImpl: async () => json({ device_code: 'private', user_code: 'CODE-1234', verification_uri: 'https://github.com.evil.test/device', expires_in: 1 }) });
  await assert.rejects(bad.start('github', { clientId: 'registered-app' }));
  const good = new DeviceOAuth(setup, { ...time, fetchImpl: async () => { requests++; return json({ device_code: 'private', user_code: 'CODE-1234', verification_uri: 'https://github.com/login/device', expires_in: 1 }); } });
  await good.start('github', { clientId: 'registered-app' }); await time.tick();
  assert.equal(good.describe('github').phase, 'expired'); assert.equal(requests, 1);
});

test('Microsoft must grant Mail.Read before a verified account can be saved', async t => {
  const setup = fixture(t), time = clock();
  const oauth = new DeviceOAuth(setup, { ...time, fetchImpl: async url => url.endsWith('/devicecode')
    ? json({ device_code: 'private', user_code: 'CODE1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 })
    : json({ access_token: 'private-access', scope: 'User.Read' }) });
  await oauth.start('microsoft', { clientId: 'registered-microsoft-client' }); await time.tick();
  assert.equal(oauth.describe('microsoft').phase, 'failed'); assert.equal(setup.getConnection('microsoft').accessToken, undefined);
});

test('refresh rotation is persisted atomically and a disconnected account cannot be restored by a late refresh', async t => {
  const setup = fixture(t);
  setup.saveConnectionAuthorization('microsoft', { clientId: 'client', accessToken: 'old-private', refreshToken: 'old-refresh', expiresAt: '2020-01-01T00:00:00Z', account: { id: 'user-a', label: 'user@example.test' } });
  const auth = new SavedConnectionAuth(setup, 'microsoft', { fetchImpl: async () => json({ access_token: 'new-private', refresh_token: 'rotated-refresh', expires_in: 3600 }) });
  assert.equal(await auth.accessToken(), 'new-private'); assert.equal(setup.getConnection('microsoft').refreshToken, 'rotated-refresh');
  setup.saveConnectionAuthorization('microsoft', { ...setup.getConnection('microsoft'), expiresAt: '2020-01-01T00:00:00Z' });
  let resolve;
  const late = new SavedConnectionAuth(setup, 'microsoft', { fetchImpl: () => new Promise(done => { resolve = done; }) });
  const pending = late.accessToken(); await new Promise(done => setImmediate(done));
  setup.clearConnection('microsoft'); resolve(json({ access_token: 'late-private', refresh_token: 'late-refresh', expires_in: 3600 }));
  await assert.rejects(pending, /changed/); assert.equal(setup.getConnection('microsoft').accessToken, undefined);
});

test('starting a different client does not change the client bound to an existing token', t => {
  const setup = fixture(t);
  setup.saveConnectionAuthorization('github', { clientId: 'old-client', accessToken: 'private-old', account: { id: 'reader', label: 'reader' } });
  setup.saveConnectionClient('github', 'new-client');
  assert.equal(setup.getConnection('github').clientId, 'old-client');
  assert.equal(setup.getConnection('github').pendingClientId, 'new-client');
});

test('distributed client metadata strips account secrets and rejects a token pasted as a public ID', () => {
  const metadata = publicClientConfiguration({ github: { clientId: 'registered-app', accessToken: 'PRIVATE_ACCESS', clientSecret: 'PRIVATE_SECRET' }, refreshToken: 'PRIVATE_REFRESH' });
  assert.deepEqual(metadata, { github: { clientId: 'registered-app' } });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_/);
  assert.equal(validPublicClientId('github_pat_inventedCredential'), false);
});
