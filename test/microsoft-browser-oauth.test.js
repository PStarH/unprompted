import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodeOAuth } from '../src/code-oauth.js';
import { LocalSetupStore } from '../src/setup.js';

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fixture(t, fetchImpl, onConnected = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-microsoft-browser-'));
  const setup = new LocalSetupStore({ filePath: path.join(dir, 'setup.json') });
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl, onConnected });
  t.after(() => { oauth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { setup, oauth };
}

test('Microsoft browser authorization uses PKCE, verifies the callback and stores only verified grants', async t => {
  let exchange, activations = 0;
  const { setup, oauth } = fixture(t, async (url, options) => {
    if (url.endsWith('/token')) { exchange = new URLSearchParams(options.body); return json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'User.Read Mail.Read Mail.Send' }); }
    assert.match(url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me/);
    return json({ id: 'verified-account', mail: 'user@example.test' });
  }, async () => { activations++; });
  const started = await oauth.start('microsoft', { clientId: 'registered-client', scopes: ['Mail.Send'] });
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.origin, 'https://login.microsoftonline.com');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('scope'), /Mail\.Send/);
  const redirect = new URL(authorize.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, 'localhost'); assert.equal(redirect.pathname, '/oauth/microsoft');
  const bad = await fetch(`${redirect}?code=bad&state=wrong`);
  assert.equal(bad.status, 400); assert.equal(setup.getConnection('microsoft').accessToken, undefined);
  const ok = await fetch(`${redirect}?code=good&state=${authorize.searchParams.get('state')}`);
  assert.equal(ok.status, 200);
  assert.equal(exchange.get('redirect_uri'), redirect.href);
  assert.equal(exchange.has('client_secret'), false);
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.equal(setup.getConnection('microsoft').account.id, 'verified-account');
  assert.deepEqual(setup.getConnection('microsoft').scopes, ['User.Read', 'Mail.Read', 'Mail.Send']);
  assert.equal(oauth.describe('microsoft').phase, 'connected'); assert.equal(activations, 1);
  assert.doesNotMatch(JSON.stringify(oauth.describe('microsoft')), /private-/);
});

test('Microsoft browser authorization refuses a token without mail access', async t => {
  const { setup, oauth } = fixture(t, async () => json({ access_token: 'private', scope: 'User.Read' }));
  const started = await oauth.start('microsoft', { clientId: 'registered-client' });
  const url = new URL(started.authorizeUrl), redirect = url.searchParams.get('redirect_uri');
  const response = await fetch(`${redirect}?code=good&state=${url.searchParams.get('state')}`);
  assert.equal(response.status, 400); assert.equal(oauth.describe('microsoft').phase, 'failed');
  assert.equal(setup.getConnection('microsoft').accessToken, undefined);
});

test('a cancelled Microsoft browser authorization cannot save a delayed token', async t => {
  let resolveToken;
  const { setup, oauth } = fixture(t, () => new Promise(resolve => { resolveToken = resolve; }));
  const started = await oauth.start('microsoft', { clientId: 'registered-client' });
  const url = new URL(started.authorizeUrl), redirect = url.searchParams.get('redirect_uri');
  const response = fetch(`${redirect}?code=good&state=${url.searchParams.get('state')}`);
  while (!resolveToken) await new Promise(resolve => setImmediate(resolve));
  oauth.cancel('microsoft'); resolveToken(json({ access_token: 'private', scope: 'User.Read Mail.Read' }));
  await response;
  assert.equal(oauth.describe('microsoft').phase, 'cancelled');
  assert.equal(setup.getConnection('microsoft').accessToken, undefined);
});
