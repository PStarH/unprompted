import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpManager, McpConfigStore, normalizeMcpConfig, parseMcpImport } from '../src/mcp.js';
import { OpenAiCompatibleReasoner, NullReasoner } from '../src/reasoning.js';
import { WorkEngine } from '../src/engine.js';
import { JsonStore } from '../src/store.js';
import { SCENARIOS } from '../eval/scenarios.js';
import { reply } from './fixtures/mcp-server.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const stdioConfig = { command: process.execPath, args: [fixturePath, '--stdio'], env: { MCP_FIXTURE_SECRET: 'fixture-private-value' } };
const planInput = { request: { text: 'Draco report with budget breakdown', subjectEntity: 'Draco', deliverable: 'report', qualifiers: [] }, uncovered: ['budget breakdown'], providers: ['document_text'], strategies: ['section_body'] };

function managerFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-mcp-'));
  const configStore = new McpConfigStore(directory), manager = new McpManager({ configStore, timeoutMs: 3000 });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, configStore, directory };
}
async function connected(t) {
  const context = managerFor(t);
  await context.manager.import({ mcpServers: { local: stdioConfig } }, { allowDeclaredRead: true });
  assert.equal(context.manager.describe().servers[0].status, 'connected');
  return context;
}

test('MCP import validates transports, local execution arguments and credentials without evaluating commands', () => {
  assert.equal(normalizeMcpConfig('notes', { url: 'https://example.test/mcp', type: 'streamable-http' }).type, 'http');
  assert.equal(normalizeMcpConfig('项目工具 GitHub', { url: 'https://example.test/mcp' }).type, 'http');
  assert.equal(normalizeMcpConfig('notes', { url: 'http://127.0.0.1:9999/mcp' }).type, 'http');
  for (const value of [{ url: 'http://example.test/mcp' }, { url: 'https://user:pass@example.test' }, { url: 'file:///tmp/mcp' }, { command: 'node', args: 'shell-string' }, { command: 'node', env: { bad: 1 } }, { command: 'node', enabled: 'false' }]) assert.throws(() => normalizeMcpConfig('notes', value), /Invalid|requires/);
  assert.throws(() => parseMcpImport('{bad'), /JSON/);
  assert.throws(() => parseMcpImport({ mcpServers: { constructor: stdioConfig } }), /Invalid/);
  assert.equal(parseMcpImport({ mcpServers: { notes: stdioConfig } }).notes.allowDeclaredRead, false);
});

test('real MCP stdio initializes, discovers tools, enforces read permissions and redacts persisted results', async t => {
  const { manager, configStore } = await connected(t);
  assert.equal(fs.statSync(configStore.filePath).mode & 0o777, 0o600);
  assert.equal(configStore.get().local.env.MCP_FIXTURE_SECRET, 'fixture-private-value');
  const publicStatus = JSON.stringify(manager.describe());
  assert.ok(!publicStatus.includes('fixture-private-value'));
  assert.ok(!publicStatus.includes(fixturePath));
  const calls = [], tools = manager.tools({ isCurrent: () => true, onCall: call => calls.push(call) });
  assert.equal(tools.length, 3);
  assert.ok(!tools.some(tool => tool.label.includes('write_item')));
  const result = await tools.find(tool => tool.label.includes('lookup')).execute('read-1', { query: 'Draco' });
  assert.match(result.content[0].text, /Draco/);
  assert.ok(!JSON.stringify(calls).includes('fixture-private-value'));
  assert.equal(calls[0].status, 'completed');
  await assert.rejects(tools.find(tool => tool.label.endsWith('fail')).execute('failed', {}), /reported an error/);
  assert.equal(calls.at(-1).status, 'failed');
  assert.ok(!JSON.stringify(calls).includes('private remote error'));
});

test('MCP rejects arguments that do not match the advertised schema before dispatch', async t => {
  const { manager } = await connected(t);
  const calls = [];
  const tool = manager.tools({ isCurrent: () => true, onCall: call => calls.push(call) }).find(item => item.label.endsWith('lookup'));
  await assert.rejects(tool.execute('invalid', { query: 42 }), /advertised schema/);
  assert.equal(calls.length, 0);
  assert.match((await tool.execute('valid', { query: 'Draco' })).content[0].text, /Draco/);
});

test('resource-only MCP servers require per-resource consent and revoke captured access', async t => {
  const { manager, configStore } = managerFor(t);
  await manager.import({ mcpServers: { knowledge: { ...stdioConfig, env: { ...stdioConfig.env, MCP_RESOURCES_ONLY: 'yes' } } } });
  const server = manager.describe().servers[0];
  assert.equal(server.status, 'connected');
  assert.equal(server.tools.length, 0);
  assert.equal(server.resources.length, 1);
  assert.equal(server.resources[0].allowed, false);
  assert.equal(manager.tools({ isCurrent: () => true }).length, 0);
  await manager.update('knowledge', { readResources: [server.resources[0].id] });
  const calls = [], tool = manager.tools({ isCurrent: () => true, onCall: call => calls.push(call) })[0];
  const result = await tool.execute('resource-read', {});
  assert.match(result.content[0].text, /Resource context/);
  assert.doesNotMatch(JSON.stringify({ result, calls, status: manager.describe() }), /fixture-private-value|fixture:\/\/private/);
  assert.deepEqual(configStore.get().knowledge.readResources, [server.resources[0].id]);
  await assert.rejects(tool.execute('bad', { uri: 'fixture://other' }), /arguments/);
  await manager.update('knowledge', { readResources: [] });
  await assert.rejects(tool.execute('revoked', {}), /no longer current/);
});

test('MCP permission changes invalidate captured tools, and disabled processes are closed', async t => {
  const { manager } = await connected(t);
  const adapter = manager.tools({ isCurrent: () => true }).find(tool => tool.label.includes('lookup'));
  await manager.update('local', { allowDeclaredRead: false, readTools: ['unannotated', 'write_item'] });
  await assert.rejects(adapter.execute('revoked', { query: 'Draco' }), /no longer current/);
  assert.equal(manager.tools({ isCurrent: () => true }).length, 1);
  await manager.update('local', { enabled: false });
  assert.equal(manager.connections.size, 0);
  assert.equal(manager.tools({ isCurrent: () => true }).length, 0);
  assert.equal(manager.describe().servers[0].enabled, false);
});

test('MCP timeouts and task changes discard late results and record a failure', async t => {
  const { manager } = await connected(t);
  const calls = [];
  let current = true;
  const slow = manager.tools({ isCurrent: () => current, onCall: call => calls.push(call) }).find(tool => tool.label.endsWith('slow'));
  const pending = slow.execute('stale', {}); current = false;
  await assert.rejects(pending, /no longer current|changed during/);
  assert.equal(calls.length, 0, 'a stale task is rejected before dispatch');
  current = true; manager.timeoutMs = 40;
  await assert.rejects(slow.execute('timeout', {}), /timed out/);
  assert.equal(calls.at(-1).status, 'failed');
});

test('Streamable HTTP initializes and calls actual MCP tools with an authorization header', async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); seen.push({ method: message.method, auth: req.headers.authorization });
    const result = await reply(message);
    if (message.id == null) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { manager } = managerFor(t);
  await manager.import({ mcpServers: { remote: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer fixture-http-token' } } } }, { allowDeclaredRead: true });
  assert.equal(manager.describe().servers[0].status, 'connected');
  const result = await manager.tools({ isCurrent: () => true }).find(tool => tool.label.endsWith('lookup')).execute('http-call', { query: 'remote' });
  assert.match(result.content[0].text, /remote/);
  assert.ok(seen.some(item => item.method === 'tools/call'));
  assert.ok(seen.every(item => item.auth === 'Bearer fixture-http-token'));
  assert.ok(!JSON.stringify(manager.describe()).includes('fixture-http-token'));
});

test('legacy SSE authenticates the stream and POST requests and calls a real tool', async t => {
  const seen = []; let stream;
  const server = http.createServer(async (req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer fixture-sse-token') { res.writeHead(401); return res.end(); }
    if (req.method === 'GET') {
      stream = res; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); res.writeHead(202); res.end();
    const result = await reply(message);
    if (message.id != null && result) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { manager } = managerFor(t);
  t.after(async () => { await manager.close(); stream?.end(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  await manager.import({ mcpServers: { legacy: { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse`, headers: { Authorization: 'Bearer fixture-sse-token' } } } }, { allowDeclaredRead: true });
  assert.equal(manager.describe().servers[0].status, 'connected');
  const result = await manager.tools({ isCurrent: () => true }).find(tool => tool.label.endsWith('lookup')).execute('sse-call', { query: 'SSE' });
  assert.match(result.content[0].text, /SSE/);
  assert.ok(seen.length >= 4 && seen.every(header => header === 'Bearer fixture-sse-token'));
});

function modelWithTools(tools, requests) {
  return async (_url, init) => {
    const payload = JSON.parse(init.body); requests.push(payload);
    const results = payload.messages.filter(message => message.role === 'tool');
    return { ok: true, json: async () => ({ choices: [{ message: results.length ? { content: '{"probes":[]}' } : { content: null, tool_calls: [{ type: 'function', id: 'lookup-call', function: { name: tools.find(tool => tool.label.endsWith('lookup')).name, arguments: '{"query":"Draco"}' } }] } }] }) };
  };
}

test('Standard harness completes a model → real MCP → model loop and charges each provider turn', async t => {
  const { manager } = await connected(t), requests = [], calls = [];
  const tools = manager.tools({ isCurrent: () => true, onCall: call => calls.push(call) });
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://model.test/v1', model: 'fixture', fetchImpl: modelWithTools(tools, requests) });
  assert.deepEqual(await reasoner.proposeProbes({ ...planInput, externalTools: tools }, 'mcp-plan'), []);
  assert.equal(requests.length, 2); assert.equal(reasoner.calls, 2);
  assert.equal(reasoner.budget.describe().inFlight, 0);
  assert.equal(reasoner.budget.describe().callsThisWindow, 2);
  assert.equal(calls.length, 1);
  assert.match(requests[1].messages.find(message => message.role === 'tool').content, /Found context: Draco/);
  assert.match(requests[0].messages[0].content, /untrusted/);
});

test('engine stores task-scoped MCP audit context, keeps completion evidence separate and avoids repeated runs', async t => {
  const { manager, directory } = await connected(t), requests = [];
  const tools = manager.tools({ isCurrent: () => true });
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://model.test/v1', model: 'fixture', fetchImpl: modelWithTools(tools, requests) });
  const store = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => store.close());
  const engine = new WorkEngine(store, { reasoner, externalTools: scope => manager.tools(scope) });
  const scenario = SCENARIOS.find(item => item.id === 'model-proposes-valid-probe');
  for (const event of scenario.events) engine.ingest(structuredClone(event));
  await engine.whenSettled();
  const task = Object.values(store.state.tasks)[0];
  assert.equal(task.mcpCalls?.length, 1);
  assert.match(task.mcpCalls[0].text, /Draco/);
  assert.ok(!store.state.documents[task.mcpCalls[0].id]);
  assert.notEqual(task.status, 'completed'); assert.equal(store.state.outbox.length, 0);
  const count = requests.length;
  engine.investigateWithTools(); await engine.whenSettled();
  assert.equal(requests.length, count);
  assert.ok(store.state.history.some(item => item.kind === 'mcp_tool' && item.taskId === task.id));
});

test('failed connection retains private configuration and reports an actionable error without secrets', async t => {
  const { manager, configStore } = managerFor(t);
  await manager.import({ mcpServers: { missing: { command: 'unprompted-missing-fixture-command', args: ['private-argument'] } } });
  assert.equal(manager.describe().servers[0].status, 'failed');
  assert.match(manager.describe().servers[0].lastError, /not found/);
  assert.ok(!JSON.stringify(manager.describe()).includes('private-argument'));
  assert.ok(configStore.get().missing);
  await manager.update('missing', { remove: true });
  assert.deepEqual(configStore.get(), {});
});

test('native assigned work also investigates through MCP without changing the source or claiming completion', async t => {
  const { manager, directory } = await connected(t);
  const requests = [], tools = manager.tools({ isCurrent: () => true });
  const respond = modelWithTools(tools, requests);
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://model.test/v1', model: 'fixture', fetchImpl: async (url, init) => {
    const response = await respond(url, init);
    const body = await response.json();
    if (body.choices[0].message.content) body.choices[0].message.content = '{"nextStep":"Review the budget context before replying."}';
    return { ok: true, json: async () => body };
  } });
  const store = new JsonStore(path.join(directory, 'native.json')); t.after(() => store.close());
  store.mutate(state => { state.taskMemories = { readScope: { id: 'readScope', scope: { entity: 'team/work', deliverable: 'issue' }, text: 'Investigate only the audit log.' } }; });
  const engine = new WorkEngine(store, { reasoner: new NullReasoner(), externalTools: scope => manager.tools(scope) });
  engine.ingest({ id: 'assigned-mcp-context', type: 'issue.updated', connectorId: 'github', source: 'github', payload: {
    id: 'assigned-one', title: 'Review Draco budget', body: 'Check the budget before replying.', repository: 'team/work', number: 1,
    assigned: true, state: 'open', updatedAt: '2026-10-27T12:00:00.000Z', url: 'https://github.com/team/work/issues/1', assignee: 'reader', author: 'teammate'
  } });
  assert.equal(Object.values(store.state.tasks)[0].mcpCalls, undefined);
  reasoner.preferModelInterpretation = true;
  engine.replaceReasoner(reasoner);
  await engine.whenSettled();
  const task = Object.values(store.state.tasks)[0];
  assert.equal(task.kind, 'external_issue');
  assert.equal(task.mcpCalls.length, 1);
  assert.equal(task.mcpInvestigation.nextStep, 'Review the budget context before replying.');
  assert.equal(JSON.parse(requests[0].messages[1].content).userDirections, 'Investigate only the audit log.');
  assert.equal(task.status, 'waiting_for_information'); assert.equal(task.externalSource.state, 'open');
  assert.equal(task.action, null); assert.equal(store.state.outbox.length, 0);
  engine.investigateWithTools(); await engine.whenSettled();
  assert.equal(requests.length, 2);
});

test('known MCP credentials are redacted from catalog and model-facing metadata, including escaped values', async t => {
  const { manager } = await connected(t), entry = manager.connections.get('local');
  const secret = 'catalog-private-"token\\value';
  manager.configs.local.env.CATALOG_TOKEN = secret;
  entry.tools[0].description = `Debug authorization: ${secret}`;
  entry.tools[0].inputSchema = { type: 'object', properties: { query: { type: 'string', description: secret } } };
  assert.ok(!JSON.stringify(manager.describe()).includes(JSON.stringify(secret).slice(1, -1)));
  assert.equal(manager.tools({ isCurrent: () => true })[0].parameters.properties.query.description, '[redacted]');
});
