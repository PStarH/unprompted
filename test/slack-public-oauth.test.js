import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { LocalSetupStore } from '../src/setup.js';
import { CodeOAuth } from '../src/code-oauth.js';
import { publicClientConfiguration } from '../src/connection-catalog.js';

const clientId = '1234567890.1234567890';
const redirectUri = 'https://pstarh.github.io/unprompted/oauth/slack/';
const reply = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const script = fs.readFileSync(new URL('../website/oauth/slack/callback.js', import.meta.url), 'utf8');
function relay(search) {
  const link = {}, message = {}, result = { changed: null, scrubbed: null };
  const location = { search, pathname: '/unprompted/oauth/slack/', replace: url => { result.changed = url; } };
  const history = { replaceState: (_state, _title, url) => { result.scrubbed = url; } };
  const document = { querySelector: id => id === '#continue' ? link : message };
  vm.runInNewContext(script, { URL, URLSearchParams, location, history, document });
  return { ...result, link, message };
}

test('public Slack relay forwards only a bounded code and state to the fixed local callback', () => {
  const state = 'a'.repeat(64), response = relay(`?code=demo%2Bcode&state=${state}&unexpected=ignored`);
  const local = new URL(response.changed);
  assert.equal(local.origin, 'http://localhost:53682'); assert.equal(local.pathname, '/oauth/slack');
  assert.equal(local.searchParams.get('code'), 'demo+code'); assert.equal(local.searchParams.get('state'), state);
  assert.equal(local.searchParams.has('unexpected'), false); assert.equal(response.scrubbed, '/unprompted/oauth/slack/');
  assert.equal(response.link.hidden, false);
  for (const query of ['?code=x', `?code=x&state=${state}&state=${state}`, `?code=x&error=access_denied&state=${state}`, `?code=${'a'.repeat(4097)}&state=${state}`]) assert.equal(relay(query).changed, null);
  assert.equal(new URL(relay(`?error=access_denied&state=${state}`).changed).searchParams.get('error'), 'access_denied');
});

test('public Slack OAuth exchanges the original HTTPS redirect while preserving local state validation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-slack-public-'));
  const setup = new LocalSetupStore({ filePath: path.join(dir, 'setup.json') });
  let tokenExchange;
  const oauth = new CodeOAuth(setup, { port: 0, slackPublicClient: { clientId, redirectUri }, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth.v2.access')) { tokenExchange = new URLSearchParams(options.body); return reply({ ok: true, authed_user: { access_token: 'xoxp-fixture', scope: 'im:history' } }); }
    if (url.endsWith('/auth.test')) return reply({ ok: true, user: 'ada', user_id: 'U123ABC', team: 'Work', team_id: 'T123ABC' });
    throw new Error('Unexpected request');
  } });
  t.after(() => { oauth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const started = await oauth.start('slack', { clientId });
  const authorize = new URL(started.authorizeUrl), state = authorize.searchParams.get('state');
  assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri);
  const callback = `http://127.0.0.1:${oauth.server.address().port}/oauth/slack`;
  assert.equal((await fetch(`${callback}?code=bad&state=${'b'.repeat(64)}`)).status, 400);
  assert.equal(tokenExchange, undefined);
  assert.equal((await fetch(`${callback}?code=good&state=${state}`)).status, 200);
  assert.equal(tokenExchange.get('redirect_uri'), redirectUri); assert.ok(tokenExchange.get('code_verifier'));
  assert.equal(setup.getConnection('slack').account.id, 'T123ABC:U123ABC');
});

test('public redirect metadata stays attached to its Slack client and must use public HTTPS', () => {
  assert.deepEqual(publicClientConfiguration({ slack: { clientId, redirectUri } }), { slack: { clientId, redirectUri } });
  for (const bad of ['http://evil.test/callback', 'https://localhost/callback', 'https://example.test/callback?next=evil', 'https://user:pass@example.test/']) assert.throws(() => publicClientConfiguration({ slack: { clientId, redirectUri: bad } }), /HTTPS/);
});
