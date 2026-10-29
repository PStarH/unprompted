import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { PiReasoner, ReasoningBudget, createReasoner } from '../src/reasoning.js';
import { piSupported, PI_LIMITS } from '../src/pi-runtime.js';
import { interpretRequest } from '../src/requests.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableDatabase } from '../src/durable/database.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SCENARIOS } from '../eval/scenarios.js';
import { McpManager, McpConfigStore } from '../src/mcp.js';
import { fileURLToPath } from 'node:url';

const piTest = piSupported() ? test : test.skip;
const fixture = SCENARIOS.find(item => item.id === 'model-proposes-valid-probe');
const mail = fixture.events.find(event => event.type === 'email.received');
const doc = fixture.events.find(event => event.type === 'document.modified').payload;
const input = { request: interpretRequest(mail.payload), uncovered: [], providers: ['document_text'], strategies: ['section_body'], documents: [doc] };
const call = (name, args, id = 'call-1') => ({ type: 'toolCall', id, name, arguments: args });

async function scripted(respond) {
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  return async (model, context, options) => {
    const result = await respond(context, options);
    const content = Array.isArray(result) ? result : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }];
    const stream = createAssistantMessageEventStream();
    const message = {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now()
    };
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
    return stream;
  };
}

const reasonerFor = async (respond, options = {}) => new PiReasoner({
  baseUrl: 'https://scripted.invalid/v1', model: 'scripted', ...options,
  runtimeOptions: { streamFn: await scripted(respond) }
});

piTest('Pi calls a real MCP stdio tool and feeds its result back into the model', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pi-mcp-'));
  const manager = new McpManager({ configStore: new McpConfigStore(directory) });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await manager.import({ mcpServers: { local: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '--stdio'] } } }, { allowDeclaredRead: true });
  const records = [], externalTools = manager.tools({ isCurrent: () => true, onCall: result => records.push(result) });
  const lookup = externalTools.find(tool => tool.label.endsWith('lookup'));
  const reasoner = await reasonerFor(context => {
    const result = context.messages.find(message => message.role === 'toolResult');
    if (!result) return [call(lookup.name, { query: 'Draco' })];
    assert.match(JSON.stringify(result.content), /Found context: Draco/);
    return { probes: [] };
  });
  assert.deepEqual(await reasoner.proposeProbes({ ...input, externalTools }, 'pi-mcp'), []);
  assert.equal(records.length, 1);
  assert.equal(reasoner.runSummary('pi-mcp').tools[0].name, lookup.name);
  assert.equal(reasoner.calls, 2);
});

test('Pi selection is explicit and the classic no-install path remains the default', () => {
  const env = { UNPROMPTED_MODEL_BASE_URL: 'https://scripted.invalid', UNPROMPTED_MODEL_NAME: 'scripted' };
  assert.equal(createReasoner(env).id, 'openai-compatible');
  assert.equal(createReasoner({ ...env, UNPROMPTED_AGENT_HARNESS: 'pi' }).id, piSupported() ? 'pi' : 'none');
  assert.equal(createReasoner({ ...env, UNPROMPTED_AGENT_HARNESS: 'unknown' }).available(), false);
  assert.equal(piSupported('22.18.0'), false);
  assert.equal(piSupported('22.19.0'), true);
  assert.equal(piSupported('24.0.0'), true);
});

test('cancelling a queued turn removes the waiter without consuming a call', async () => {
  const budget = new ReasoningBudget({ maxConcurrent: 1 });
  budget.tryAcquire('busy');
  const abort = new AbortController();
  const queued = budget.acquire('cancelled', { signal: abort.signal });
  abort.abort();
  assert.match((await queued).reason, /cancelled/);
  assert.equal(budget.describe().queued, 0);
  assert.equal(budget.describe().callsThisWindow, 1);
  budget.release();
});

piTest('the real Pi loop searches, reads evidence, and returns validated proposals to the engine', async () => {
  let calls = 0;
  const reasoner = await reasonerFor(context => {
    calls++;
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!results.length) return [call('search_documents', { query: 'Draco' })];
    if (results.length === 1) {
      assert.match(results[0].content[0].text, new RegExp(doc.id));
      return [call('read_document', { id: doc.id }, 'call-2')];
    }
    assert.match(results[1].content[0].text, /vendor/i);
    return { probes: fixture.reasoner.probes };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pi-engine-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  try {
    const engine = new WorkEngine(store, { reasoner });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    const task = Object.values(store.state.tasks)[0];
    assert.equal(task.status, 'ready_for_approval');
    assert.equal(calls, 3);
    assert.equal(reasoner.status().budget.callsThisWindow, 3);
    assert.deepEqual(task.reasoning.runtime.tools.map(tool => tool.name), ['search_documents', 'read_document']);
    assert.equal(task.reasoning.runtime.status, 'completed');
    assert.equal(store.state.outbox.length, 0);
    assert.equal(reasoner.status().runtime.active.length, 0);
    assert.equal(reasoner.status().budget.inFlight, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

piTest('read tools reject out-of-scope and unavailable documents and never expose a send tool', async () => {
  let calls = 0;
  const reasoner = await reasonerFor(context => {
    calls++;
    const system = context.messages.find(message => message.role === 'system');
    assert.deepEqual(system.toolsAdded.map(tool => tool.name).sort(), ['read_document', 'search_documents']);
    if (calls === 1) return [call('read_document', { id: 'private-document' })];
    assert.equal(context.messages.find(message => message.role === 'toolResult').isError, true);
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE CONTENT/);
    return { probes: [] };
  });
  await reasoner.proposeProbes({ ...input, documents: [...input.documents, { id: 'private-document', content: 'PRIVATE CONTENT', available: false }] }, 'scoped');
  assert.equal(calls, 2);
});

piTest('a document revoked between search and read is unavailable to the running Pi task', async () => {
  let engine, calls = 0;
  const reasoner = await reasonerFor(context => {
    calls++;
    if (calls === 1) return [call('search_documents', {})];
    if (calls === 2) {
      engine.ingest({ id: 'revoked-in-flight', type: 'document.unavailable', payload: { id: doc.id, reason: 'access_revoked' } });
      return [call('read_document', { id: doc.id }, 'after-revocation')];
    }
    const result = context.messages.filter(message => message.role === 'toolResult').at(-1);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside this task scope or unavailable/);
    return { probes: fixture.reasoner.probes };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pi-revoked-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  try {
    engine = new WorkEngine(store, { reasoner });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    assert.equal(calls, 3);
    assert.equal(Object.values(store.state.tasks)[0].status, 'waiting_for_information');
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

piTest('concurrent Pi runs share the provider ceiling and drain a burst without loss', async () => {
  let active = 0, peak = 0;
  const reasoner = await reasonerFor(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { probes: [] };
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => reasoner.proposeProbes(input, `concurrent-${index}`)));
  assert.equal(results.length, 8);
  assert.equal(peak, 2);
  assert.equal(reasoner.status().calls, 8);
  assert.equal(reasoner.status().budget.queued, 0);
  assert.equal(reasoner.status().runtime.active.length, 0);
});

piTest('a request for an unregistered write tool produces an error result without an external action', async () => {
  let calls = 0;
  const reasoner = await reasonerFor(context => {
    if (++calls === 1) return [call('send_email', { to: 'outside@example.test' })];
    assert.equal(context.messages.find(message => message.role === 'toolResult').isError, true);
    return { probes: [] };
  });
  assert.deepEqual(await reasoner.proposeProbes(input, 'write-attempt'), []);
  assert.equal(reasoner.runSummary('write-attempt').tools[0].status, 'failed');
});

piTest('a looping model stops after the actual provider-call budget and releases its slot', async () => {
  let calls = 0;
  const reasoner = await reasonerFor(() => [call('search_documents', {}, `loop-${++calls}`)]);
  await assert.rejects(reasoner.proposeProbes(input, 'loop'), error => error.code === 'REASONING_BUDGET');
  assert.equal(calls, 4);
  assert.equal(reasoner.status().calls, 4);
  assert.equal(reasoner.status().budget.inFlight, 0);
  assert.equal(reasoner.runSummary('loop').status, 'failed');
});

piTest('tool batches are bounded even when one response requests many reads', async () => {
  const reasoner = await reasonerFor(() => Array.from({ length: 15 }, (_, i) => call('read_document', { id: doc.id }, `read-${i}`)));
  await assert.rejects(reasoner.proposeProbes(input, 'tool-batch'), /tool budget/);
  assert.equal(reasoner.runSummary('tool-batch').tools.length, PI_LIMITS.maxTools);
  assert.equal(reasoner.status().calls, 1);
});

piTest('malformed and oversized answers are failures, with credentials absent from status', async () => {
  const broken = await reasonerFor(() => 'invalid JSON', { apiKey: 'private-test-credential' });
  await assert.rejects(broken.proposeProbes(input, 'invalid'), /JSON/);
  assert.equal(broken.runSummary('invalid').status, 'failed');
  assert.equal(JSON.stringify(broken.status()).includes('private-test-credential'), false);
  const huge = await reasonerFor(() => 'x'.repeat(500), { limits: { maxResponseChars: 100 } });
  await assert.rejects(huge.proposeProbes(input, 'huge'), /exceeds 100/);
});

piTest('timeouts abort the provider and drain queued work', async () => {
  let aborted = false;
  const reasoner = await reasonerFor(async (_context, { signal }) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
  }, { timeoutMs: 25, limits: { maxConcurrent: 1 } });
  const first = reasoner.proposeProbes(input, 'timeout');
  const second = reasoner.proposeProbes(input, 'waiting');
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected'));
  // Let cancellation propagate through the protocol stream and its finally block.
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(reasoner.status().budget.inFlight, 0);
  assert.equal(reasoner.status().budget.queued, 0);
  assert.equal(reasoner.status().runtime.active.length, 0);
});

piTest('Pi uses the configured chat-completions endpoint through its actual streaming provider', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push({ url: req.url, payload, auth: req.headers.authorization });
    const toolResult = payload.messages.some(message => message.role === 'tool');
    const delta = toolResult ? { content: JSON.stringify({ probes: fixture.reasoner.probes }) } : {
      tool_calls: [{ index: 0, id: 'http-read', type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ id: doc.id }) } }]
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of [
      { choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' }] }
    ]) res.write(`data: ${JSON.stringify({ id: 'scripted-completion', object: 'chat.completion.chunk', created: 1, model: 'scripted', ...part })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const reasoner = new PiReasoner({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'scripted', apiKey: 'local-test-key' });
    assert.deepEqual(await reasoner.proposeProbes(input, 'http'), fixture.reasoner.probes);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.url === '/v1/chat/completions' && request.auth === 'Bearer local-test-key'));
    assert.match(requests[1].payload.messages.find(message => message.role === 'tool').content, /vendor/i);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

piTest('native Pi document reads share the durable task guard and execution ledger', async t => {
  const reasoner = await reasonerFor(context => {
    const results = context.messages.filter(message => message.role === 'toolResult');
    if (!results.length) return [call('search_documents', { query: 'Draco' })];
    if (results.length === 1) return [call('read_document', { id: doc.id }, 'owned-read')];
    return { probes: fixture.reasoner.probes };
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-pi-owned-'));
  const store = new SqliteStore(path.join(directory, 'state.json'), { database: new DurableDatabase(':memory:') });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const event of fixture.events) engine.ingest(structuredClone(event));
  await engine.whenSettled();
  const reads = runtime.ledger.list().filter(row => row.provider === 'document_store');
  assert.deepEqual(reads.map(row => row.tool).sort(), ['read_document', 'search_documents']);
  assert.ok(reads.every(row => row.status === 'verified' && row.is_write === 0));
  assert.equal(store.state.outbox.length, 0);
});
