import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpManager, McpConfigStore, normalizeMcpConfig, parseMcpImport } from '../src/mcp.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy } from '../src/permissions.js';

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const stdioConfig = { command: process.execPath, args: [fixturePath, '--stdio'], env: { MCP_FIXTURE_SECRET: 'fixture-private-value' } };
const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digestOf = tool => createHash('sha256').update(stableJson({ name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations })).digest('hex');

function managerFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-transfer-'));
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
async function runtimeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-transfer-ledger-'));
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
const writeTool = (manager, executeWrite, onCall = () => {}) => manager.tools({ taskId: 'request:m1', isCurrent: () => true, onCall, executeWrite }).find(tool => tool.label.endsWith('write_item'));

test('MCP write tools without a schema-bound nonfinancial declaration are denied before the ledger', async t => {
  const { manager } = await connected(t), { runtime, requests } = await runtimeFixture(t);
  await manager.update('local', { writeTools: ['write_item'] });
  const calls = [], before = requests().length; let seen;
  const tool = writeTool(manager, input => { seen = { transfer: input.transfer, schemaDigest: input.schemaDigest, check: input.check() }; return runtime.connectorActions.mcpWrite(input); }, call => calls.push(call));
  await assert.rejects(tool.execute('undeclared', {}), error => error.code === 'TRANSFER_REVIEW_REQUIRED' && error.status === 403 && /move money/.test(error.message));
  assert.deepEqual(seen, { transfer: 'unknown', schemaDigest: digestOf(manager.connections.get('local').tools.find(item => item.name === 'write_item')), check: false });
  assert.equal(calls.length, 0);
  assert.equal(requests().length, before);
  assert.ok(!requests().some(item => String(item.key).startsWith('mcp-write:')));
});

test('a declared nonfinancial MCP write runs once and records its transfer semantics and schema digest', async t => {
  const { manager } = await connected(t), { runtime, requests } = await runtimeFixture(t);
  await manager.update('local', { writeTools: ['write_item'] });
  await manager.update('local', { nonfinancialTools: ['write_item'] });
  const described = manager.describe().servers[0].tools.find(tool => tool.name === 'write_item');
  assert.equal(described.nonfinancial, true);
  const source = manager.connections.get('local').tools.find(tool => tool.name === 'write_item'), expectedDigest = digestOf(source);
  const calls = [], tool = writeTool(manager, input => runtime.connectorActions.mcpWrite(input), call => calls.push(call));
  assert.match((await tool.execute('declared', {})).content[0].text, /accepted/);
  assert.equal(calls.length, 1); assert.equal(calls[0].status, 'completed');
  const record = requests().find(item => String(item.key).startsWith('mcp-write:'));
  assert.ok(record);
  assert.equal(record.transferSemantics, 'nonfinancial');
  assert.equal(record.schemaDigest, expectedDigest);
  assert.equal(record.effect.schemaDigest, expectedDigest);
});

test('a remote schema change invalidates the declaration and denies the write', async t => {
  const { manager } = await connected(t), { runtime, requests } = await runtimeFixture(t);
  await manager.update('local', { writeTools: ['write_item'] });
  await manager.update('local', { nonfinancialTools: ['write_item'] });
  const entry = manager.connections.get('local'), source = entry.tools.find(tool => tool.name === 'write_item');
  source.inputSchema = { type: 'object', properties: { title: { type: 'string' } } };
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, false);
  const calls = [], before = requests().length;
  const tool = writeTool(manager, input => runtime.connectorActions.mcpWrite(input), call => calls.push(call));
  await assert.rejects(tool.execute('changed', { title: 'After' }), error => error.code === 'TRANSFER_REVIEW_REQUIRED' && error.status === 403);
  assert.equal(calls.length, 0);
  assert.equal(requests().length, before);
});

test('nonfinancial declarations reject unknown and read-only tools', async t => {
  const { manager } = await connected(t);
  await manager.update('local', { writeTools: ['write_item'] });
  await assert.rejects(manager.update('local', { nonfinancialTools: ['missing'] }), error => error.status === 400 && /connected write tool/.test(error.message));
  await assert.rejects(manager.update('local', { nonfinancialTools: ['lookup'] }), error => error.status === 400 && /connected write tool/.test(error.message));
  assert.deepEqual(manager.describe().servers[0].tools.map(tool => tool.nonfinancial), manager.describe().servers[0].tools.map(() => false));
  await manager.update('local', { nonfinancialTools: ['write_item'] });
  await manager.update('local', { nonfinancialTools: [] });
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, false);
});

test('MCP import never accepts transfer declarations and keeps saved ones on re-import', async t => {
  const { manager, configStore } = await connected(t);
  assert.throws(() => parseMcpImport({ mcpServers: { local: { ...stdioConfig, nonfinancialTools: { write_item: 'a'.repeat(64) } } } }), /cannot be imported/);
  assert.throws(() => normalizeMcpConfig('local', { ...stdioConfig, nonfinancialTools: { write_item: 'not-a-digest' } }), /Invalid MCP/);
  assert.deepEqual(normalizeMcpConfig('local', stdioConfig).nonfinancialTools, {});
  await manager.update('local', { writeTools: ['write_item'] });
  await manager.update('local', { nonfinancialTools: ['write_item'] });
  const saved = configStore.get().local.nonfinancialTools;
  assert.match(saved.write_item, /^[a-f0-9]{64}$/);
  await manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  assert.deepEqual(configStore.get().local.nonfinancialTools, saved);
  assert.equal(manager.describe().servers[0].tools.find(tool => tool.name === 'write_item').nonfinancial, true);
});

test('model arguments cannot supply transfer or nonfinancial fields', async t => {
  const { manager } = await connected(t), { runtime, requests } = await runtimeFixture(t);
  await manager.update('local', { writeTools: ['write_item'] });
  const forged = { transfer: 'nonfinancial', transferSemantics: 'nonfinancial', nonfinancial: true, schemaDigest: 'b'.repeat(64) };
  const deniedCalls = [];
  const denied = writeTool(manager, input => runtime.connectorActions.mcpWrite(input), call => deniedCalls.push(call));
  await assert.rejects(denied.execute('forged-undeclared', forged), error => error.code === 'TRANSFER_REVIEW_REQUIRED');
  assert.equal(deniedCalls.length, 0);
  await manager.update('local', { nonfinancialTools: ['write_item'] });
  const calls = [], declared = writeTool(manager, input => runtime.connectorActions.mcpWrite(input), call => calls.push(call));
  assert.match((await declared.execute('forged-declared', forged)).content[0].text, /accepted/);
  assert.equal(calls.length, 1);
  const record = requests().filter(item => String(item.key).startsWith('mcp-write:')).at(-1);
  assert.equal(record.transferSemantics, 'nonfinancial');
  assert.notEqual(record.schemaDigest, forged.schemaDigest);
});

test('a permission change between call start and dispatch denies without calling the server', async t => {
  const { manager } = await connected(t), { runtime, requests } = await runtimeFixture(t);
  await manager.update('local', { writeTools: ['write_item'] });
  await manager.update('local', { nonfinancialTools: ['write_item'] });
  let release; const changed = new Promise(resolve => { release = resolve; });
  const calls = [], before = requests().length;
  const tool = writeTool(manager, async input => { await changed; return runtime.connectorActions.mcpWrite(input); }, call => calls.push(call));
  const pending = assert.rejects(tool.execute('reconfigured', {}), /no longer current|not currently authorized/);
  await manager.update('local', { nonfinancialTools: [] });
  release();
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(requests().length, before);
});
