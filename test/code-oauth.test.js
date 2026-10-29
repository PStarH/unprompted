import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSetupStore } from '../src/setup.js';
import { CodeOAuth } from '../src/code-oauth.js';
import { SavedConnectionAuth } from '../src/device-oauth.js';
import { publicClientConfiguration, validClientSecret, validPublicClientId } from '../src/connection-catalog.js';

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const slackId = '1234567890.1234567890';
const slackSecret = 'slackSecretValue1';
const notionId = '12345678-1234-1234-1234-123456789abc';
const notionSecret = 'secret_notionvalue';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-code-oauth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
}

test('Slack code flow uses PKCE on localhost, rejects a mismatched state, and keeps the secret out of the browser status', async t => {
  const setup = fixture(t);
  const calls = [];
  const oauth = new CodeOAuth(setup, { port: 0, fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body, headers: options.headers, method: options.method });
    if (url === 'https://slack.com/api/oauth.v2.access') return json({ ok: true, authed_user: { access_token: 'xoxp-user-token-value', scope: 'im:read,im:history,mpim:read,mpim:history,users:read' } });
    if (url === 'https://slack.com/api/auth.test') return json({ ok: true, user: 'ada', user_id: 'U123ABC', team: 'Work', team_id: 'T123ABC' });
    throw new Error(`Unexpected ${url}`);
  } });
  t.after(() => oauth.close());
  const started = await oauth.start('slack', { clientId: slackId, clientSecret: slackSecret });
  assert.equal(started.phase, 'authorizing');
  assert.doesNotMatch(JSON.stringify(started), /slackSecretValue1|code_verifier|xoxp-/);
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.origin, 'https://slack.com');
  assert.equal(authorize.searchParams.get('user_scope'), 'im:read,im:history,mpim:read,mpim:history,users:read');
  assert.equal(authorize.searchParams.has('scope'), false);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const redirect = new URL(authorize.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, 'localhost');
  assert.equal(redirect.pathname, '/oauth/slack');
  const mismatched = await fetch(`${redirect.origin}/oauth/slack?code=nope&state=${'a'.repeat(64)}`);
  assert.equal(mismatched.status, 400);
  assert.equal(setup.getConnection('slack').accessToken, undefined);
  const approved = await fetch(`${redirect.origin}/oauth/slack?code=good-code&state=${authorize.searchParams.get('state')}`);
  assert.equal(approved.status, 200);
  assert.doesNotMatch(await approved.text(), /good-code|slackSecretValue1|xoxp-/);
  const exchange = calls.find(call => call.url.endsWith('/oauth.v2.access'));
  assert.match(exchange.body, /code=good-code/);
  assert.match(exchange.body, /code_verifier=/);
  assert.doesNotMatch(exchange.body, /client_secret/);
  const saved = setup.getConnection('slack');
  assert.equal(saved.account.label, 'ada · Work');
  assert.equal(saved.account.id, 'T123ABC:U123ABC');
  assert.equal(saved.clientSecret, slackSecret);
  assert.equal(oauth.describe('slack').phase, 'connected');
  assert.equal(oauth.describe('slack').authorizeUrl, undefined);
  setup.clearConnection('slack');
  assert.equal(setup.getConnection('slack').clientSecret, slackSecret);
  assert.equal(setup.getConnection('slack').accessToken, undefined);
});

test('Notion code flow sends the client secret only to Notion and a second listener cannot take the same port', async t => {
  const setup = fixture(t);
  const oauth = new CodeOAuth(setup, { port: 0, onConnected: async () => { throw new Error('activation'); }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.notion.com/v1/oauth/token');
    assert.match(options.headers.authorization, /^Basic /);
    assert.equal(options.headers['content-type'], 'application/json');
    const decoded = Buffer.from(options.headers.authorization.slice(6), 'base64').toString();
    assert.equal(decoded, `${notionId}:${notionSecret}`);
    assert.equal(JSON.parse(options.body).grant_type, 'authorization_code');
    return json({ access_token: 'ntn_user_token_value', workspace_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', workspace_name: 'Notes', owner: { type: 'user', user: { id: 'ffffffff-1111-2222-3333-444444444444', name: 'Ada' } } });
  } });
  t.after(() => oauth.close());
  const started = await oauth.start('notion', { clientId: notionId, clientSecret: notionSecret });
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.searchParams.get('owner'), 'user');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  const redirect = new URL(authorize.searchParams.get('redirect_uri'));
  const blocked = new CodeOAuth(fixture(t), { port: Number(redirect.port), fetchImpl: async () => json({}) });
  t.after(() => blocked.close());
  await assert.rejects(blocked.start('notion', { clientId: notionId, clientSecret: notionSecret }), /already in use/);
  const approved = await fetch(`${redirect.origin}/oauth/notion?code=notion-code&state=${authorize.searchParams.get('state')}`);
  assert.equal(approved.status, 200);
  assert.doesNotMatch(await approved.text(), /notion-code|secret_notionvalue|ntn_user_token_value/);
  assert.equal(setup.getConnection('notion').account.label, 'Ada · Notes');
  assert.equal(oauth.describe('notion').phase, 'activation_failed');
});

test('distributed client metadata keeps a code-flow secret, strips account tokens, and still strips a device-flow secret', () => {
  const metadata = publicClientConfiguration({
    github: { clientId: 'registered-app', clientSecret: 'PRIVATE_SECRET', accessToken: 'PRIVATE_ACCESS' },
    slack: { clientId: slackId, clientSecret: slackSecret, accessToken: 'PRIVATE_SLACK', refreshToken: 'PRIVATE_REFRESH' },
    notion: { clientId: notionId, clientSecret: notionSecret }
  });
  assert.deepEqual(metadata, { github: { clientId: 'registered-app' }, slack: { clientId: slackId, clientSecret: slackSecret }, notion: { clientId: notionId, clientSecret: notionSecret } });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_/);
  assert.equal(validPublicClientId('1234567890.1234567890'), true);
  assert.equal(validClientSecret('secret_notionvalue'), true);
  assert.equal(validClientSecret('xoxp-user-token-value'), false);
  assert.equal(validClientSecret('ntn_user_token_value'), false);
});

test('Slack refresh does not send the client secret and GitHub refresh stays a public client', async t => {
  const setup = fixture(t);
  setup.saveConnectionCredentials('slack', { clientId: slackId, clientSecret: slackSecret });
  setup.saveConnectionAuthorization('slack', { clientId: slackId, clientSecret: slackSecret, accessToken: 'old', refreshToken: 'refresh-1', expiresAt: '2020-01-01T00:00:00.000Z', account: { id: 'T123ABC:U123ABC', label: 'ada · Work', userId: 'U123ABC', teamId: 'T123ABC' }, scopes: ['im:history'] });
  let slackBody = '';
  const slack = new SavedConnectionAuth(setup, 'slack', { fetchImpl: async (url, options) => { slackBody = options.body; return json({ ok: true, access_token: 'xoxp-new-token', expires_in: 3600, token_type: 'user' }); } });
  assert.equal(await slack.accessToken(), 'xoxp-new-token');
  assert.match(slackBody, /grant_type=refresh_token/);
  assert.doesNotMatch(slackBody, /client_secret|slackSecretValue1/);
  setup.saveConnectionAuthorization('github', { clientId: 'registered-app', clientSecret: 'PRIVATE_SECRET', accessToken: 'old', refreshToken: 'refresh-github', expiresAt: '2020-01-01T00:00:00.000Z', account: { id: '123', label: 'reader', login: 'reader' } });
  assert.equal(setup.getConnection('github').clientSecret, undefined);
  let githubBody = '';
  const github = new SavedConnectionAuth(setup, 'github', { fetchImpl: async (url, options) => { githubBody = options.body; return json({ access_token: 'new-github', expires_in: 3600 }); } });
  assert.equal(await github.accessToken(), 'new-github');
  assert.doesNotMatch(githubBody, /client_secret/);
});
