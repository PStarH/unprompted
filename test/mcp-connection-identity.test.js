import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpManager, McpConfigStore, parseMcpImport, mcpConnectionIdentity, mcpServerIdentity } from '../src/mcp.js';
import { fixtureTools } from './fixtures/mcp-server.mjs';

const secretOne = 'identity-fixture-one';
const secretTwo = 'identity-fixture-two';
const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digestOf = tool => createHash('sha256').update(stableJson({ name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations })).digest('hex');
const digestOfNamed = name => {
  const tool = fixtureTools.find(item => item.name === name);
  return createHash('sha256').update(stableJson({ name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations })).digest('hex');
};
/** Minimal stand-in for the MCP SDK so connection identity can be varied
 * between connects without real HTTP fixtures or child processes. */
function mockSdk(state) {
  class Client {
    async connect() { await state.onConnect?.(); this.connected = true; }
    getServerCapabilities() { return { tools: {} }; }
    getServerInfo() { return state.serverInfo; }
    getServerVersion() { return state.serverVersion; }
    async listTools() { return { tools: fixtureTools }; }
    async listResources() { return { resources: [] }; }
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }
    async close() {}
  }
  class StdioTransport { constructor(options) { this.options = options; } async start() {} async send() {} async close() {} }
  class RemoteTransport { constructor(url, options) { this.url = url; this.options = options; } async start() {} async send() {} async close() {} }
  return { Client, StdioClientTransport: StdioTransport, StreamableHTTPClientTransport: RemoteTransport, SSEClientTransport: RemoteTransport,
    fromJsonSchema: () => ({ '~standard': { async validate() { return {}; } } }),
    getDefaultEnvironment: () => ({ ...state.defaultEnv }) };
}
function managerFor(t, state) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-connection-'));
  const configStore = new McpConfigStore(directory);
  const manager = new McpManager({ configStore, timeoutMs: 3000, load: async () => mockSdk(state) });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, configStore };
}
const nonfinancial = manager => manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial;
const reviewRequired = () => { const error = new Error('This platform operation may move money and needs explicit user review.'); error.code = 'TRANSFER_REVIEW_REQUIRED'; error.status = 403; throw error; };
const stubWrite = calls => input => { if (input.transfer !== 'nonfinancial') reviewRequired(); calls.push(input); return { state: 'accepted' }; };
const writeTool = (manager, executeWrite) => manager.tools({ taskId: 'request:m1', isCurrent: () => true, executeWrite }).find(tool => tool.label.endsWith('write_item'));
const expectReviewRequired = (tool, id) => assert.rejects(tool.execute(id, {}), error => error.code === 'TRANSFER_REVIEW_REQUIRED' && error.status === 403);
async function declare(manager, id) {
  await manager.update(id, { writeTools: ['write_item'] });
  await manager.update(id, { nonfinancialTools: ['write_item'] });
  assert.equal(nonfinancial(manager), true);
}
const stdioConfig = { command: process.execPath, args: ['server.js'], env: { MCP_FIXTURE_SECRET: secretOne } };

test('changed initialize serverInfo at an identical endpoint and schema revokes the declaration', async t => {
  const state = { serverInfo: { name: 'alpha', version: '1.0.0' }, defaultEnv: {} };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { remote: { type: 'http', url: 'https://mcp.example.test/mcp' } } }, { allowDeclaredRead: true });
  await declare(manager, 'remote');
  const before = digestOf(manager.connections.get('remote').tools.find(tool => tool.name === 'write_item'));
  state.serverInfo = { name: 'beta', version: '1.0.0' };
  await manager.update('remote', { reconnect: true });
  const after = manager.connections.get('remote').tools.find(tool => tool.name === 'write_item');
  assert.equal(digestOf(after), before, 'endpoint and tool schema must be identical');
  assert.equal(nonfinancial(manager), false, 'a different initialize identity must not inherit the declaration');
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'server-info');
  assert.equal(calls.length, 0);
  await manager.update('remote', { reconnect: true });
  assert.equal(nonfinancial(manager), false, 'a repeated changed identity stays revoked');
});

test('effective stdio inherited environment is bound without exposing values', async t => {
  const state = { serverInfo: { name: 'local-fixture', version: '1.0.0' }, defaultEnv: { HOME: '/home/secret-alpha' } };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  await declare(manager, 'local');
  assert.ok(!JSON.stringify(manager.describe()).includes('/home/secret-alpha'), 'inherited identity values must not be exposed');
  await manager.update('local', { reconnect: true });
  assert.equal(nonfinancial(manager), true, 'an unchanged effective launch identity preserves the declaration');
  state.defaultEnv = { HOME: '/home/secret-beta' };
  await manager.update('local', { reconnect: true });
  assert.equal(nonfinancial(manager), false, 'an inherited environment change revokes the declaration');
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'stdio-env');
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(manager.describe()).includes('/home/secret-beta'));
});

test('a live connection is not re-blessed when stored config changes without a reconnect', async t => {
  const state = { serverInfo: { name: 'local-fixture', version: '1.0.0' }, defaultEnv: { HOME: '/home/alpha' } };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  await declare(manager, 'local');
  const calls = [];
  const queued = writeTool(manager, stubWrite(calls));
  // Simulate a config/auth refresh that updates stored state in place while the
  // old connection remains live: the fingerprint must stay tied to the config
  // the connection really used.
  manager.configs = { ...manager.configs, local: { ...manager.configs.local, env: { MCP_FIXTURE_SECRET: secretTwo } } };
  assert.equal(nonfinancial(manager), false, 'a stale connection must not re-bless a declaration');
  await expectReviewRequired(queued, 'stale-config');
  assert.equal(calls.length, 0);
});

test('import rejects supplied connection provenance and legacy provenance fails closed', async t => {
  assert.throws(() => parseMcpImport({ mcpServers: { local: { ...stdioConfig, nonfinancialConnection: 'd'.repeat(64) } } }), /cannot be imported/);
  const state = { serverInfo: { name: 'local-fixture', version: '1.0.0' }, defaultEnv: { HOME: '/home/alpha' } };
  const { manager, configStore } = managerFor(t, state);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  await manager.update('local', { writeTools: ['write_item'] });
  // Legacy provenance: a schema digest and config identity but no connection binding.
  manager.configs = { ...manager.configs, local: { ...manager.configs.local, nonfinancialTools: { write_item: digestOfNamed('write_item') }, nonfinancialIdentity: mcpServerIdentity(manager.configs.local) } };
  assert.equal(nonfinancial(manager), false, 'legacy declarations without connection provenance fail closed');
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'legacy-provenance');
  assert.equal(calls.length, 0);
  assert.equal(configStore.get().local.nonfinancialConnection, undefined);
  assert.match(manager.connections.get('local').connectionIdentity, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(manager.describe()).includes(secretOne), 'attestation state never exposes secrets');
});

test('changed initialize serverInfo under an identical stdio config revokes the declaration', async t => {
  const state = { serverInfo: { name: 'local-fixture', version: '1.0.0' }, defaultEnv: { HOME: '/home/alpha' } };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  await declare(manager, 'local');
  const before = digestOf(manager.connections.get('local').tools.find(tool => tool.name === 'write_item'));
  state.serverInfo = { name: 'local-other', version: '1.0.0' };
  await manager.update('local', { reconnect: true });
  const after = manager.connections.get('local').tools.find(tool => tool.name === 'write_item');
  assert.equal(digestOf(after), before, 'command, environment and tool schema must be identical');
  assert.equal(nonfinancial(manager), false, 'a changed initialize identity must revoke a stdio declaration');
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'stdio-server-info');
  assert.equal(calls.length, 0);
});

test('missing or malformed initialize identity fails closed and never resumes a declaration', async t => {
  const state = { serverInfo: { name: 'local-fixture', version: '1.0.0' }, defaultEnv: {} };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  await declare(manager, 'local');
  assert.equal(mcpConnectionIdentity({ ...stdioConfig, type: 'stdio' }, { serverInfo: { name: 'local-fixture', version: 'v'.repeat(257) } }), null, 'oversized initialize version fails closed');
  for (const malformed of [null, {}, { name: '' }, { name: 7 }, { name: 'local-fixture', version: 'v'.repeat(257) }, 'fixture']) {
    state.serverInfo = malformed;
    await manager.update('local', { reconnect: true });
    assert.equal(nonfinancial(manager), false, `initialize identity ${JSON.stringify(malformed)} must fail closed`);
  }
  state.serverInfo = { name: 'local-fixture', version: '1.0.0' };
  await manager.update('local', { reconnect: true });
  assert.equal(nonfinancial(manager), true, 'the unchanged identity still matches the stored declaration');
});

test('initialize identity falls back to the SDK server version when serverInfo is absent', async t => {
  const state = { serverInfo: null, serverVersion: { name: 'fallback-fixture', version: '2.0.0' }, defaultEnv: {} };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  await declare(manager, 'local');
  state.serverVersion = { name: 'fallback-fixture', version: '2.1.0' };
  await manager.update('local', { reconnect: true });
  assert.equal(nonfinancial(manager), false, 'a changed fallback identity revokes the declaration');
});

test('changing an HTTP endpoint through import revokes the declaration and never invokes', async t => {
  const state = { serverInfo: { name: 'alpha', version: '1.0.0' }, defaultEnv: {} };
  const { manager, configStore } = managerFor(t, state);
  const alpha = { type: 'http', url: 'https://alpha.example.test/mcp' }, beta = { type: 'http', url: 'https://beta.example.test/mcp' };
  await manager.import({ mcpServers: { remote: alpha } }, { allowDeclaredRead: true });
  await declare(manager, 'remote');
  await manager.import({ mcpServers: { remote: alpha } }, { allowDeclaredRead: true });
  assert.equal(nonfinancial(manager), true, 'an unchanged endpoint preserves the declaration');
  const calls = [];
  await manager.import({ mcpServers: { remote: beta } }, { allowDeclaredRead: true });
  assert.equal(manager.describe().servers[0].status, 'connected');
  assert.deepEqual(configStore.get().remote.nonfinancialTools, {});
  assert.equal(configStore.get().remote.nonfinancialIdentity, undefined);
  assert.equal(configStore.get().remote.nonfinancialConnection, undefined);
  assert.equal(nonfinancial(manager), false);
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'changed-endpoint-import');
  assert.equal(calls.length, 0);
});

test('stdio identity is frozen from the actual launch snapshot before connect changes PATH', async t => {
  const originalPath = process.env.PATH;
  const launchedPath = `${originalPath ? `${originalPath}${path.delimiter}` : ''}/unprompted-launch-path-sentinel`;
  const changedPath = '/unprompted-post-connect-path-sentinel';
  const state = { serverInfo: { name: 'path-fixture', version: '1.0.0' }, defaultEnv: { HOME: '/home/alpha' },
    onConnect: () => { process.env.PATH = changedPath; } };
  process.env.PATH = launchedPath;
  try {
    const { manager } = managerFor(t, state);
    await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
    process.env.PATH = launchedPath;
    await manager.update('local', { writeTools: ['write_item'] });
    // Permission updates reconnect; reset the pre-launch input for the final
    // declaration connection so onConnect changes PATH during that same await.
    process.env.PATH = launchedPath;
    await manager.update('local', { nonfinancialTools: ['write_item'] });
    const connection = manager.connections.get('local');
    const launched = { cwd: connection.transport.options.cwd, env: connection.transport.options.env };
    assert.equal(launched.cwd, process.cwd(), 'the transport must receive the frozen cwd');
    assert.ok(launched.env.PATH.includes('/unprompted-launch-path-sentinel'), 'the child receives the pre-connect PATH');
    assert.ok(!launched.env.PATH.includes(changedPath), 'post-connect PATH changes must not reach the child');
    assert.equal(connection.connectionIdentity,
      mcpConnectionIdentity(manager.configs.local, { serverInfo: state.serverInfo, launch: launched }),
      'the stored fingerprint is the actual transported launch snapshot');
    assert.notEqual(connection.connectionIdentity,
      mcpConnectionIdentity(manager.configs.local, { serverInfo: state.serverInfo, defaultEnv: state.defaultEnv }),
      'the post-await process environment must not determine the fingerprint');
    assert.equal(nonfinancial(manager), true, 'the declaration stays bound to the actual launch snapshot');
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
});

test('HTTP transport pins redirects to error and never follows a moved endpoint', async t => {
  const state = { serverInfo: { name: 'alpha', version: '1.0.0' }, defaultEnv: {} };
  const { manager } = managerFor(t, state);
  await manager.import({ mcpServers: { remote: { type: 'http', url: 'https://mcp.example.test/mcp' } } }, { allowDeclaredRead: true });
  const transport = manager.connections.get('remote').transport;
  assert.equal(transport.url.href, 'https://mcp.example.test/mcp');
  const requestFetch = transport.options.fetch;
  const originalFetch = globalThis.fetch;
  const seen = [], forwarded = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), redirect: init?.redirect });
    if (init?.redirect === 'error') {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ERR_INVALID_REDIRECT' };
      throw error;
    }
    forwarded.push('https://attacker.example.test/mcp');
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example.test/mcp' } });
  };
  try {
    await assert.rejects(requestFetch('https://mcp.example.test/mcp', { redirect: 'follow', method: 'POST' }), /fetch failed/);
    await assert.rejects(requestFetch('https://mcp.example.test/mcp', { redirect: 'manual' }), /fetch failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, [
    { url: 'https://mcp.example.test/mcp', redirect: 'error' },
    { url: 'https://mcp.example.test/mcp', redirect: 'error' }
  ]);
  assert.equal(forwarded.length, 0, 'a redirect must not forward the MCP request to another endpoint');
});
