import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpManager, McpConfigStore, normalizeMcpConfig, parseMcpImport } from '../src/mcp.js';
import { fixtureTools, reply } from './fixtures/mcp-server.mjs';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const secretOne = 'identity-fixture-one', secretTwo = 'identity-fixture-two';
const stdioConfig = { command: process.execPath, args: [fixturePath, '--stdio'], env: { MCP_FIXTURE_SECRET: secretOne } };
const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digestOf = tool => createHash('sha256').update(stableJson({ name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations })).digest('hex');
const digestOfNamed = name => digestOf(fixtureTools.find(tool => tool.name === name));

function managerFor(t, configs = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-identity-'));
  if (configs) fs.writeFileSync(path.join(directory, 'mcp.json'), JSON.stringify(configs));
  const configStore = new McpConfigStore(directory), manager = new McpManager({ configStore, timeoutMs: 3000 });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, configStore };
}
async function connected(t) {
  const context = managerFor(t);
  await context.manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  assert.equal(context.manager.describe().servers[0].status, 'connected');
  return context;
}
async function declared(t) {
  const context = await connected(t);
  await context.manager.update('local', { writeTools: ['write_item'] });
  await context.manager.update('local', { nonfinancialTools: ['write_item'] });
  assert.equal(context.manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, true);
  return context;
}
async function runtimeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-identity-ledger-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store, { policy: new PermissionPolicy({ shadow: false }) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  engine.ingest({ id: 'email:m1', type: 'email.received', payload: { id: 'm1', threadId: 't1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
  await engine.whenSettled();
  const taskId = 'request:m1';
  assert.ok(runtime.tasks.get(taskId));
  return { runtime, taskId, requests: () => runtime.tasks.get(taskId)?.platformRequests || [] };
}
const reviewRequired = () => { const error = new Error('This platform operation may move money and needs explicit user review.'); error.code = 'TRANSFER_REVIEW_REQUIRED'; error.status = 403; throw error; };
const stubWrite = calls => input => {
  if (input.transfer !== 'nonfinancial') reviewRequired();
  calls.push(input);
  return { state: 'accepted' };
};
const reviewWrite = holder => input => { holder.input = input; reviewRequired(); };
async function httpFixture(t) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); seen.push(message.method);
    const result = await reply(message);
    if (message.id == null) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls: () => seen.filter(method => method === 'tools/call').length };
}
const writeTool = (manager, executeWrite) => manager.tools({ taskId: 'request:m1', isCurrent: () => true, executeWrite }).find(tool => tool.label.endsWith('write_item'));
const expectReviewRequired = (tool, id) => assert.rejects(tool.execute(id, {}), error => error.code === 'TRANSFER_REVIEW_REQUIRED' && error.status === 403);

test('server identity binds transport, credentials and principal without exposing values', async () => {
  const { mcpServerIdentity } = await import('../src/mcp.js');
  assert.equal(typeof mcpServerIdentity, 'function', 'mcpServerIdentity must be exported');
  const http = (url, extra = {}) => normalizeMcpConfig('remote', { type: 'http', url, enabled: false, ...extra });
  const base = http('https://mcp.example.test/a');
  assert.match(mcpServerIdentity(base), /^[a-f0-9]{64}$/);
  assert.equal(mcpServerIdentity(base), mcpServerIdentity(http('https://mcp.example.test/a', { enabled: true })));
  assert.notEqual(mcpServerIdentity(base), mcpServerIdentity(http('https://mcp.example.test/b')));
  assert.notEqual(mcpServerIdentity(base), mcpServerIdentity(http('https://other.example.test/a')));
  assert.notEqual(mcpServerIdentity(base), mcpServerIdentity(http('https://mcp.example.test/a?tenant=two')));
  assert.notEqual(mcpServerIdentity(base), mcpServerIdentity(normalizeMcpConfig('remote', { type: 'sse', url: 'https://mcp.example.test/a', enabled: false })));
  assert.notEqual(mcpServerIdentity(base), mcpServerIdentity(http('https://mcp.example.test/a', { headers: { Authorization: secretTwo } })));
  const stdio = (extra = {}) => normalizeMcpConfig('local', { ...stdioConfig, ...extra });
  const command = stdio();
  assert.equal(mcpServerIdentity(command), mcpServerIdentity(stdio()));
  assert.notEqual(mcpServerIdentity(command), mcpServerIdentity(stdio({ command: '/bin/sh' })));
  assert.notEqual(mcpServerIdentity(command), mcpServerIdentity(stdio({ args: [fixturePath, '--stdio', '--variant'] })));
  assert.notEqual(mcpServerIdentity(command), mcpServerIdentity(stdio({ cwd: os.tmpdir() })));
  assert.notEqual(mcpServerIdentity(command), mcpServerIdentity(stdio({ env: { MCP_FIXTURE_SECRET: secretTwo } })));
  const oauth = (patch = {}) => normalizeMcpConfig('remote', { type: 'http', url: 'https://mcp.example.test/a', enabled: false, oauth: {
    tokens: { access_token: 'token-one' }, clientInformation: { client_id: 'client-one' }, resourceUrl: 'https://resource.example.test/mcp', ...patch } });
  assert.notEqual(mcpServerIdentity(oauth()), mcpServerIdentity(oauth({ tokens: { access_token: 'token-two' } })), 'an access token change may change the authenticated principal');
  assert.notEqual(mcpServerIdentity(oauth()), mcpServerIdentity(oauth({ clientInformation: { client_id: 'client-two' } })));
  assert.notEqual(mcpServerIdentity(oauth()), mcpServerIdentity(oauth({ resourceUrl: 'https://other.example.test/mcp' })));
  assert.ok(!mcpServerIdentity(stdio({ env: { MCP_FIXTURE_SECRET: secretTwo } })).includes(secretTwo));
});

test('a changed stdio environment identity denies the write even though the schema is identical', async t => {
  const { manager, configStore } = await declared(t);
  const { runtime, requests } = await runtimeFixture(t);
  const before = digestOf(manager.connections.get('local').tools.find(tool => tool.name === 'write_item'));
  await manager.import({ mcpServers: { local: { ...stdioConfig, env: { MCP_FIXTURE_SECRET: secretTwo } } } }, { allowDeclaredRead: true });
  assert.equal(manager.describe().servers[0].status, 'connected');
  const after = digestOf(manager.connections.get('local').tools.find(tool => tool.name === 'write_item'));
  assert.equal(after, before, 'the remote tool schema must be identical');
  assert.deepEqual(configStore.get().local.nonfinancialTools, {}, 'a declaration must not survive a server identity change');
  const beforeRequests = requests().length;
  await expectReviewRequired(writeTool(manager, input => runtime.connectorActions.mcpWrite(input)), 'rotated-env');
  assert.equal(requests().length, beforeRequests);
  assert.ok(!JSON.stringify(manager.describe()).includes(secretOne));
  assert.ok(!JSON.stringify(requests()).includes(secretTwo));
});

test('changed stdio arguments deny the write with an identical schema', async t => {
  const { manager, configStore } = await declared(t);
  const before = digestOf(manager.connections.get('local').tools.find(tool => tool.name === 'write_item'));
  await manager.import({ mcpServers: { local: { ...stdioConfig, args: [fixturePath, '--stdio', '--identity-variant'] } } }, { allowDeclaredRead: true });
  assert.equal(manager.describe().servers[0].status, 'connected');
  assert.equal(digestOf(manager.connections.get('local').tools.find(tool => tool.name === 'write_item')), before);
  assert.deepEqual(configStore.get().local.nonfinancialTools, {});
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'rotated-args');
  assert.equal(calls.length, 0);
});

test('changed HTTP endpoint or transport cannot inherit declarations under the same config id', async t => {
  const { mcpServerIdentity } = await import('../src/mcp.js');
  assert.equal(typeof mcpServerIdentity, 'function', 'mcpServerIdentity must be exported');
  const alpha = normalizeMcpConfig('remote', { type: 'http', url: 'https://alpha.example.test/mcp', enabled: false });
  const beta = normalizeMcpConfig('remote', { type: 'http', url: 'https://beta.example.test/mcp', enabled: false });
  assert.notEqual(mcpServerIdentity(alpha), mcpServerIdentity(beta));
  const declarations = { write_item: 'a'.repeat(64) };
  const saved = { ...alpha, nonfinancialTools: declarations, nonfinancialIdentity: mcpServerIdentity(alpha) };
  const changed = managerFor(t, { remote: saved });
  await changed.manager.import({ mcpServers: { remote: { type: 'http', url: 'https://beta.example.test/mcp', enabled: false } } }, { allowDeclaredRead: true });
  assert.deepEqual(changed.configStore.get().remote.nonfinancialTools, {});
  assert.equal(changed.configStore.get().remote.nonfinancialIdentity, undefined);
  const unchanged = managerFor(t, { remote: saved });
  await unchanged.manager.import({ mcpServers: { remote: { type: 'http', url: 'https://alpha.example.test/mcp', enabled: false } } }, { allowDeclaredRead: true });
  assert.deepEqual(unchanged.configStore.get().remote.nonfinancialTools, declarations);
  assert.equal(unchanged.configStore.get().remote.nonfinancialIdentity, mcpServerIdentity(alpha));
});

test('schema-only legacy declarations fail closed without identity provenance', async t => {
  const seeded = normalizeMcpConfig('local', { ...stdioConfig, writeTools: ['write_item'] });
  const { manager } = managerFor(t, { local: { ...seeded, nonfinancialTools: { write_item: digestOfNamed('write_item') } } });
  await manager.start();
  assert.equal(manager.describe().servers[0].status, 'connected');
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, false);
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'legacy-schema-only');
  assert.equal(calls.length, 0);
});

test('imported JSON cannot supply declarations or identity provenance', async t => {
  assert.throws(() => parseMcpImport({ mcpServers: { local: { ...stdioConfig, nonfinancialTools: { write_item: 'b'.repeat(64) } } } }), /cannot be imported/);
  assert.throws(() => parseMcpImport({ mcpServers: { local: { ...stdioConfig, nonfinancialIdentity: 'c'.repeat(64) } } }), /cannot be imported/);
  assert.throws(() => normalizeMcpConfig('local', { ...stdioConfig, nonfinancialIdentity: 'c'.repeat(64) }, { oauth: 'reject' }), /cannot be imported/);
  const { manager, configStore } = managerFor(t);
  await assert.rejects(manager.import({ mcpServers: { local: { ...stdioConfig, nonfinancialIdentity: 'c'.repeat(64) } } }, { allowDeclaredRead: true }), /cannot be imported/);
  assert.deepEqual(configStore.get(), {});
});

test('an unchanged server preserves declarations across import, reconnect and restart', async t => {
  const { manager, configStore } = await declared(t);
  const saved = configStore.get().local.nonfinancialTools;
  assert.match(configStore.get().local.nonfinancialIdentity, /^[a-f0-9]{64}$/);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  assert.deepEqual(configStore.get().local.nonfinancialTools, saved);
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, true);
  await manager.update('local', { reconnect: true });
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, true);
  await manager.close();
  const restarted = new McpManager({ configStore, timeoutMs: 3000 });
  t.after(async () => { await restarted.close(); });
  await restarted.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  assert.equal(restarted.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, true);
});

test('revoking then re-importing the same config does not resurrect declarations', async t => {
  const { manager, configStore } = await declared(t);
  await manager.update('local', { nonfinancialTools: [] });
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  assert.deepEqual(configStore.get().local.nonfinancialTools, {});
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, false);
  const calls = [];
  await expectReviewRequired(writeTool(manager, stubWrite(calls)), 'revoked');
  assert.equal(calls.length, 0);
});

test('MCP recovery is receipt reconciliation only and never re-dispatches or reuses a declaration', async t => {
  const { runtime, taskId } = await runtimeFixture(t);
  let invokes = 0;
  const write = () => runtime.connectorActions.mcpWrite({ taskId, serverId: 'local', tool: 'write_item', args: { note: 'one' },
    isCurrent: () => true, check: () => true, transfer: 'nonfinancial', schemaDigest: 'a'.repeat(64),
    invoke: async (_signal,beforeDispatch) => { beforeDispatch(); invokes++; return { content: [{ type: 'text', text: 'ok' }] }; } });
  const result = await write();
  assert.equal(result.state, 'accepted');
  assert.equal(invokes, 1);
  const execution = runtime.db.prepare("SELECT * FROM tool_executions WHERE action_family='mcp.tool'").get();
  assert.ok(execution);
  assert.equal(runtime.ledger.recoverUnfinished(), 1);
  const recovered = runtime.ledger.get(execution.id);
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.last_error_class, 'process_interrupted');
  assert.ok(runtime.db.prepare("SELECT 1 FROM jobs WHERE queue_name='reconcile' AND job_type='reconcile_execution' AND json_extract(payload_json,'$.executionId')=?").get(execution.id));
  const provider = runtime.providerFor(recovered);
  assert.equal(provider, null, 'MCP recovery has no readback provider and must not invent a dispatch path');
  assert.deepEqual(await runtime.ledger.reconcile(execution.id, provider), { status: 'unknown', manual: true });
  assert.equal(invokes, 1, 'recovery must not make a fresh external call');
  const again = await write();
  assert.equal(again.state, 'unknown');
  assert.equal(again.alreadyDispatched, true);
  assert.equal(invokes, 1, 'an unresolved MCP write cannot be blindly retried');
});

test('recovery after revocation keeps the unknown receipt and never re-invokes captured tools', async t => {
  const { manager, configStore } = await declared(t);
  const { runtime } = await runtimeFixture(t);
  const entry = manager.connections.get('local');
  let invokes = 0;
  const callTool = entry.client.callTool.bind(entry.client);
  entry.client.callTool = async (...args) => { invokes++; return callTool(...args); };
  const oldTool = writeTool(manager, input => runtime.connectorActions.mcpWrite(input));
  const accepted = await oldTool.execute('first', {});
  assert.equal(JSON.parse(accepted.content[0].text).state, 'accepted');
  assert.equal(invokes, 1);
  const execution = runtime.db.prepare("SELECT * FROM tool_executions WHERE action_family='mcp.tool'").get();
  assert.ok(execution);
  await manager.import({ mcpServers: { local: { ...stdioConfig, env: { MCP_FIXTURE_SECRET: secretTwo } } } }, { allowDeclaredRead: true });
  assert.deepEqual(configStore.get().local.nonfinancialTools, {}, 'revocation discards the declaration');
  assert.equal(configStore.get().local.nonfinancialConnection, undefined, 'the revoked attestation is discarded, not kept for retry');
  const newTool = writeTool(manager, input => runtime.connectorActions.mcpWrite(input));
  await assert.rejects(oldTool.execute('old', {}), error => error.status === 409 || error.code === 'MCP_ERROR');
  assert.equal(invokes, 1, 'a captured pre-revocation tool cannot reach the old or new server');
  await expectReviewRequired(newTool, 'post-revocation');
  assert.equal(invokes, 1, 'a captured post-revocation tool has no declaration to invoke under');
  assert.equal(runtime.ledger.recoverUnfinished(), 1);
  const recovered = runtime.ledger.get(execution.id);
  assert.equal(recovered.status, 'unknown');
  assert.equal(recovered.last_error_class, 'process_interrupted');
  const provider = runtime.providerFor(recovered);
  assert.equal(provider, null, 'MCP recovery has no readback provider and must not invent a dispatch path');
  assert.deepEqual(await runtime.ledger.reconcile(execution.id, provider), { status: 'unknown', manual: true });
  assert.equal(runtime.ledger.get(execution.id).status, 'unknown', 'the unknown receipt stays retained for manual reconciliation');
  await assert.rejects(oldTool.execute('old-again', {}), error => error.status === 409 || error.code === 'MCP_ERROR');
  await expectReviewRequired(newTool, 'after-reconcile');
  assert.equal(invokes, 1, 'reconciliation and captured tools never re-invoke the changed server');
  assert.ok(runtime.db.prepare("SELECT 1 FROM jobs WHERE queue_name='reconcile' AND job_type='reconcile_execution' AND json_extract(payload_json,'$.executionId')=?").get(execution.id));
});
