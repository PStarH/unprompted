import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSetupStore, GoogleOAuthSetup, defaultSetupDirectory, googleWorkspacePath } from '../src/setup.js';

function tempStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-setup-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new LocalSetupStore({ filePath: path.join(directory, 'setup.json') }) };
}

const desktopClient = JSON.stringify({ installed: {
  client_id: 'test-client.apps.googleusercontent.com',
  client_secret: 'private-desktop-secret',
  auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_uri: 'https://oauth2.googleapis.com/token'
} });

test('local setup stores secrets in a private file and exposes only a redacted status', t => {
  const { directory, store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  store.setGoogleScopes({ readGmail: true, readDrive: false, docsWrite: false, gmailSend: false });
  store.saveAuthorization({ refreshToken: 'private-refresh-token', grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
  const file = path.join(directory, 'setup.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const persisted = fs.readFileSync(file, 'utf8');
  assert.match(persisted, /private-desktop-secret/);
  assert.match(persisted, /private-refresh-token/);
  const publicStatus = JSON.stringify(store.publicStatus());
  assert.doesNotMatch(publicStatus, /private-desktop-secret|private-refresh-token|client_secret|refresh_token/);
  assert.equal(store.publicStatus().google.hasClient, true);
  assert.equal(store.publicStatus().google.hasRefreshToken, true);
  assert.equal(defaultSetupDirectory({ UNPROMPTED_CONFIG_DIR: './private-test' }, 'darwin', '/Users/example'), path.resolve('./private-test'));
});

test('only Google Desktop OAuth JSON is accepted; endpoints cannot be supplied by a file', t => {
  const { store } = tempStore(t);
  assert.throws(() => store.saveDesktopClientJson(JSON.stringify({ web: { client_id: 'web', client_secret: 'secret' } })), /Web OAuth client/);
  assert.throws(() => store.saveDesktopClientJson(JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret', auth_uri: 'https://attacker.invalid', token_uri: 'https://attacker.invalid' } })), /official/);
  assert.throws(() => store.saveDesktopClientJson('{broken'), /valid JSON/);
});

test('runtime scope flags require granted scope and local credentials never overwrite explicit environment values', t => {
  const { store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  store.setGoogleScopes({ readGmail: true, readDrive: true, docsWrite: true, gmailSend: false });
  store.saveAuthorization({ refreshToken: 'saved-refresh-token', grantedScopes: [
    'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly'
  ] });
  const env = store.runtimeEnv({});
  assert.equal(env.GOOGLE_READ_GMAIL, 'true');
  assert.equal(env.GOOGLE_READ_DRIVE, 'true');
  assert.equal(env.GOOGLE_DOCS_WRITE_ENABLED, 'false', 'a requested scope is not treated as granted');
  assert.equal(env.GOOGLE_SEND_ENABLED, 'false');
  assert.equal(env.UNPROMPTED_SHADOW_MODE, 'true');
  assert.equal(store.runtimeEnv({ GOOGLE_CLIENT_SECRET: 'explicit-secret' }).GOOGLE_CLIENT_SECRET, 'explicit-secret');
});

test('Desktop OAuth uses loopback PKCE, stores only requested granted scopes, and is one-use', async t => {
  const { store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  let exchangeCount = 0;
  const oauth = new GoogleOAuthSetup(store, {
    timeoutMs: 10_000,
    fetchImpl: async (url, options) => {
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        assert.equal(options.headers.authorization, 'Bearer oauth-access-token');
        return { ok: true, json: async () => ({ sub: 'verified-google-user', email: 'reader@example.test', email_verified: true }) };
      }
      exchangeCount += 1;
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.method, 'POST');
      const body = new URLSearchParams(options.body);
      assert.ok(body.get('code_verifier'));
      assert.equal(body.get('client_secret'), 'private-desktop-secret');
      assert.equal(body.get('client_secret'), 'private-desktop-secret');
      return { ok: true, json: async () => ({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-secret', scope: 'https://www.googleapis.com/auth/gmail.readonly' }) };
    }
  });
  t.after(() => oauth.cancel());
  const result = await oauth.start({ scopes: { readGmail: true, readDrive: false, docsWrite: false, gmailSend: false } });
  const authorization = new URL(result.authorizeUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('code_challenge'));
  assert.equal(authorization.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.readonly');
  assert.match(authorization.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const callbackUrl = new URL(authorization.searchParams.get('redirect_uri'));
  callbackUrl.searchParams.set('state', authorization.searchParams.get('state'));
  callbackUrl.searchParams.set('code', 'fake-code');
  const callback = await fetch(callbackUrl);
  assert.equal(callback.status, 200);
  assert.equal(exchangeCount, 1);
  assert.equal(store.get().google.refreshToken, 'oauth-refresh-secret');
  assert.equal(store.get().google.accountId, 'verified-google-user');
  assert.equal(store.publicStatus().google.accountEmail, 'reader@example.test');
  assert.equal(oauth.describe().phase, 'authorized_pending_restart');
  assert.doesNotMatch(JSON.stringify(oauth.describe()), /secret|refresh_token/);
  assert.doesNotMatch(JSON.stringify(store.publicStatus()), /oauth-refresh-secret|private-desktop-secret/);
});

test('OAuth rejects state mismatches and a scope response that did not grant the requested access', async t => {
  const { store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  const oauth = new GoogleOAuthSetup(store, {
    timeoutMs: 10_000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ refresh_token: 'should-not-save', scope: '' }) })
  });
  t.after(() => oauth.cancel());
  const result = await oauth.start({ scopes: { readGmail: true, readDrive: false, docsWrite: false, gmailSend: false } });
  const authorization = new URL(result.authorizeUrl);
  const callbackUrl = new URL(authorization.searchParams.get('redirect_uri'));
  callbackUrl.searchParams.set('state', 'wrong-state');
  callbackUrl.searchParams.set('code', 'fake-code');
  assert.equal((await fetch(callbackUrl)).status, 400);
  assert.equal(store.get().google.refreshToken, null);
  callbackUrl.searchParams.set('state', authorization.searchParams.get('state'));
  assert.equal((await fetch(callbackUrl)).status, 400);
  assert.equal(store.get().google.refreshToken, null);
  assert.equal(oauth.describe().phase, 'failed');
});

test('callback state is consumed before token exchange so a parallel replay is rejected', async t => {
  const { store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  let exchangeCount = 0;
  let started;
  const exchangeStarted = new Promise(resolve => { started = resolve; });
  const oauth = new GoogleOAuthSetup(store, {
    timeoutMs: 10_000,
    fetchImpl: (_url, options) => new Promise((_, reject) => {
      exchangeCount += 1;
      started();
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });
  t.after(() => oauth.cancel());
  const result = await oauth.start({ scopes: { readGmail: true, readDrive: false, docsWrite: false, gmailSend: false } });
  const authorization = new URL(result.authorizeUrl);
  const callbackUrl = new URL(authorization.searchParams.get('redirect_uri'));
  callbackUrl.searchParams.set('state', authorization.searchParams.get('state'));
  callbackUrl.searchParams.set('code', 'one-use-code');
  const firstResponse = fetch(callbackUrl);
  await exchangeStarted;
  const replay = await fetch(callbackUrl);
  assert.equal(replay.status, 409);
  assert.equal(exchangeCount, 1);
  oauth.cancel();
  assert.equal((await firstResponse).status, 400);
  assert.equal(store.get().google.refreshToken, null);
});

test('cancelling an in-flight token exchange aborts it and answers the loopback request', async t => {
  const { store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  let signal;
  let started;
  const exchangeStarted = new Promise(resolve => { started = resolve; });
  const oauth = new GoogleOAuthSetup(store, {
    timeoutMs: 10_000,
    fetchImpl: (_url, options) => new Promise((_, reject) => {
      signal = options.signal;
      started();
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });
  t.after(() => oauth.cancel());
  const result = await oauth.start({ scopes: { readGmail: true, readDrive: false, docsWrite: false, gmailSend: false } });
  const authorization = new URL(result.authorizeUrl);
  const callbackUrl = new URL(authorization.searchParams.get('redirect_uri'));
  callbackUrl.searchParams.set('state', authorization.searchParams.get('state'));
  callbackUrl.searchParams.set('code', 'fake-code');
  const callbackPromise = fetch(callbackUrl);
  await exchangeStarted;
  oauth.cancel();
  const response = await callbackPromise;
  assert.equal(response.status, 400);
  assert.equal(signal.aborted, true);
  assert.equal(store.get().google.refreshToken, null);
});

test('launch flags cannot expand a UI-connected account and a changed identity loses write authority', t => {
  const { directory, store } = tempStore(t);
  store.saveDesktopClientJson(desktopClient);
  store.setGoogleScopes({ readGmail: true, readDrive: false, gmailSend: true });
  const grantedScopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
  store.saveAuthorization({ refreshToken: 'account-a-refresh', accountId: 'account-a', grantedScopes });
  store.setExternalWrites(true);
  assert.equal(store.runtimeEnv({}).UNPROMPTED_SHADOW_MODE, 'false');
  assert.equal(store.runtimeEnv({ GOOGLE_READ_DRIVE: 'true', GOOGLE_DOCS_WRITE_ENABLED: 'true' }).GOOGLE_READ_DRIVE, 'false');
  assert.equal(store.runtimeEnv({ GOOGLE_DOCS_WRITE_ENABLED: 'true' }).GOOGLE_DOCS_WRITE_ENABLED, 'false');
  store.saveAuthorization({ refreshToken: 'account-b-refresh', accountId: 'account-b', grantedScopes });
  assert.equal(store.runtimeEnv({ UNPROMPTED_SHADOW_MODE: 'false' }).UNPROMPTED_SHADOW_MODE, 'true');
  assert.notEqual(googleWorkspacePath(directory, 'account-a'), googleWorkspacePath(directory, 'account-b'));
});

test('authorization stays retryable when activation fails and does not claim the workspace connected', async t => {
  const { store } = tempStore(t); store.saveDesktopClientJson(desktopClient);
  const oauth = new GoogleOAuthSetup(store, { onAuthorized: async () => { throw new Error('workspace is locked'); },
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('userinfo')
      ? { sub: 'account-a', email: 'reader@example.test', email_verified: true }
      : { access_token: 'private-access', refresh_token: 'private-refresh', scope: 'https://www.googleapis.com/auth/gmail.readonly' } }) });
  t.after(() => oauth.cancel());
  const { authorizeUrl } = await oauth.start({ scopes: { readGmail: true } });
  const authorization = new URL(authorizeUrl), callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'code');
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(oauth.describe().phase, 'activation_failed');
  assert.equal(store.get().google.refreshToken, 'private-refresh');
  assert.equal(store.publicStatus().google.restartRequired, true);
  assert.doesNotMatch(JSON.stringify(oauth.describe()), /private-access|private-refresh/);
});

test('an environment account never inherits another saved account credentials, scopes or write policy', t => {
  const { store } = tempStore(t); store.saveDesktopClientJson(desktopClient);
  store.setGoogleScopes({ readGmail: true, gmailSend: true });
  store.saveAuthorization({ refreshToken: 'saved-refresh', accountId: 'saved-account', grantedScopes: [
    'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'
  ] });
  store.setExternalWrites(true);
  const env = store.runtimeEnv({ GOOGLE_REFRESH_TOKEN: 'external-refresh' });
  assert.equal(env.GOOGLE_CLIENT_ID, undefined);
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.GOOGLE_SEND_ENABLED, undefined);
  assert.equal(env.UNPROMPTED_SHADOW_MODE, 'true');
});
