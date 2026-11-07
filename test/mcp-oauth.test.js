import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { McpManager, McpConfigStore } from '../src/mcp.js';
import { McpOAuthBroker } from '../src/mcp-oauth.js';
import { reply } from './fixtures/mcp-server.mjs';

function managerFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-oauth-'));
  const configStore = new McpConfigStore(directory);
  const manager = new McpManager({ configStore, timeoutMs: 3000 });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, configStore, directory };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function startAuthServer() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const issuer = `${origin}/`;
    const mcpUrl = `${origin}/mcp`;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource')) {
      return json(200, { resource: mcpUrl, authorization_servers: [issuer], scopes_supported: ['read'] });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: false
      });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = JSON.parse(await readBody(req));
      return json(201, {
        client_id: 'oauth-fixture-client',
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        grant_types: body.grant_types,
        response_types: body.response_types,
        token_endpoint_auth_method: 'none'
      });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const params = new URLSearchParams(await readBody(req));
      const access = params.get('grant_type') === 'refresh_token' ? 'oauth-fixture-token-2' : 'oauth-fixture-token';
      return json(200, { access_token: access, refresh_token: 'oauth-fixture-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      if (redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/oauth/mcp') {
        res.writeHead(400); return res.end('bad redirect');
      }
      redirect.searchParams.set('code', 'oauth-fixture-code');
      redirect.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      seen.push(req.headers.authorization || '');
      const message = JSON.parse(await readBody(req));
      const result = await reply(message);
      if (message.id == null) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return { server, seen };
}

function causesOf(causes) {
  return causes.map(error => error?.stack || String(error)).join('\n---\n');
}

test('hosted MCP sign-in exchanges a loopback code, redacts tokens, and refreshes the bearer', { timeout: 20000 }, async t => {
  const { server, seen } = startAuthServer();
  const port = await listen(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { manager, configStore } = managerFor(t);
  const causes = [];
  const broker = new McpOAuthBroker({ manager, port: 0, onError: error => causes.push(error) });
  manager.attachOAuth(broker);
  t.after(() => broker.close());
  const serverUrl = `http://127.0.0.1:${port}/mcp`;

  let started;
  try { started = await broker.begin('notion', { serverUrl }); }
  catch (error) { assert.fail(`${error.message}\n${causesOf(causes)}`); }
  assert.equal(started.phase, 'authorizing');
  assert.match(started.authorizeUrl, /code_challenge=/);
  const duringDisk = fs.readFileSync(configStore.filePath, 'utf8');
  const during = JSON.parse(duringDisk);
  assert.match(during.notion.oauth.codeVerifier, /^unprompted-seal:v1:/);
  const verifier = configStore.get().notion.oauth.codeVerifier;
  assert.equal(typeof verifier, 'string');
  assert.equal(duringDisk.includes(verifier), false);
  assert.ok(!JSON.stringify(manager.describe()).includes(verifier));

  const authorize = await fetch(started.authorizeUrl, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  assert.match(location, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\?/);
  const callback = await fetch(location);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /You can close this window/);
  if (causes.length) assert.fail(causesOf(causes));

  const savedDisk = fs.readFileSync(configStore.filePath, 'utf8');
  const saved = JSON.parse(savedDisk);
  assert.match(saved.notion.oauth.tokens.access_token, /^unprompted-seal:v1:/);
  assert.match(saved.notion.oauth.tokens.refresh_token, /^unprompted-seal:v1:/);
  assert.equal(saved.notion.oauth.codeVerifier, undefined);
  assert.equal(savedDisk.includes('oauth-fixture-token'), false);
  assert.equal(savedDisk.includes('oauth-fixture-refresh'), false);
  assert.equal(savedDisk.includes(verifier), false);
  const stored = configStore.get().notion.oauth;
  assert.equal(stored.tokens.access_token, 'oauth-fixture-token');
  assert.equal(stored.tokens.refresh_token, 'oauth-fixture-refresh');
  assert.equal(stored.codeVerifier, undefined);
  assert.equal(saved.notion.enabled, true);
  const described = JSON.stringify(manager.describe());
  for (const secret of ['oauth-fixture-token', 'oauth-fixture-refresh', 'oauth-fixture-client', verifier]) {
    assert.ok(!described.includes(secret), secret);
  }
  assert.equal(manager.describe().servers[0].status, 'connected', manager.describe().servers[0].lastError || '');
  assert.equal(manager.describe().servers[0].oauthPhase, 'authorized');
  assert.equal(manager.describe().servers[0].signedIn, true);

  const tool = manager.tools({ isCurrent: () => true }).find(item => item.label.endsWith('lookup'));
  assert.match((await tool.execute('oauth-call', { query: 'Notion' })).content[0].text, /Notion/);
  assert.ok(seen.some(header => header === 'Bearer oauth-fixture-token'));
  assert.ok(seen.every(header => header === 'Bearer oauth-fixture-token'));

  assert.equal(await broker.refresh('notion'), true, causesOf(causes));
  const refreshedDisk = fs.readFileSync(configStore.filePath, 'utf8');
  const refreshed = JSON.parse(refreshedDisk);
  assert.match(refreshed.notion.oauth.tokens.access_token, /^unprompted-seal:v1:/);
  assert.equal(refreshedDisk.includes('oauth-fixture-token-2'), false);
  assert.equal(refreshedDisk.includes('oauth-fixture-token'), false);
  assert.equal(configStore.get().notion.oauth.tokens.access_token, 'oauth-fixture-token-2');
  assert.ok(!JSON.stringify(manager.describe()).includes('oauth-fixture-token-2'));
  assert.match((await tool.execute('oauth-refresh', { query: 'refreshed' })).content[0].text, /refreshed/);
  assert.ok(seen.at(-1) === 'Bearer oauth-fixture-token-2');
});

test('cancelling an unfinished MCP sign-in removes the incomplete server', { timeout: 20000 }, async t => {
  const { server } = startAuthServer();
  const port = await listen(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { manager } = managerFor(t);
  const causes = [];
  const broker = new McpOAuthBroker({ manager, port: 0, onError: error => causes.push(error) });
  t.after(() => broker.close());
  const started = await broker.begin('linear', { serverUrl: `http://127.0.0.1:${port}/mcp` });
  assert.equal(started.phase, 'authorizing');
  assert.equal(manager.configs.linear.enabled, false);
  const cancelled = await broker.cancel('linear');
  assert.equal(cancelled.phase, 'idle');
  assert.equal(manager.configs.linear, undefined);
  if (causes.length) assert.fail(causesOf(causes));
});

test('MCP sign-in rejects a non-loopback override, an unknown preset, and a busy callback port', async t => {
  const { manager } = managerFor(t);
  const broker = new McpOAuthBroker({ manager, port: 0 });
  t.after(() => broker.close());
  await assert.rejects(() => broker.begin('notion', { serverUrl: 'https://mcp.notion.com/mcp' }), /loopback/);
  await assert.rejects(() => broker.begin('jira'), (error) => error.status === 404 && /Unknown MCP sign-in/.test(error.message));
  const blocker = http.createServer();
  const port = await listen(blocker);
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const blocked = new McpOAuthBroker({ manager, port });
  t.after(() => blocked.close());
  await assert.rejects(() => blocked.begin('todoist', { serverUrl: 'http://127.0.0.1:9/mcp' }), /already in use/);
});

test('an oversized saved MCP access token is dropped instead of failing the config', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-oauth-size-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new McpConfigStore(directory);
  store.write({
    notes: {
      type: 'http', url: 'http://127.0.0.1:9/mcp', enabled: false, allowDeclaredRead: false, readTools: [], readResources: [],
      oauth: { tokens: { access_token: 'x'.repeat(40000), token_type: 'Bearer' } }
    }
  });
  const loaded = store.get();
  assert.equal(loaded.notes.oauth, undefined);
  assert.equal(loaded.notes.type, 'http');
});
