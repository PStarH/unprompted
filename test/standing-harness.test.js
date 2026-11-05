import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner, OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore } from '../src/connectors/connector.js';
import { LocalFilesConnector } from '../src/connectors/local-files.js';
import { NotionConnector } from '../src/connectors/notion.js';
import { piSupported } from '../src/pi-runtime.js';
import { preparedWorkReviewToken } from '../src/draft-review.js';
import { MonitoringService } from '../src/monitoring.js';
import { LocalSetupStore } from '../src/setup.js';

const quote = 'Keep both emergency exits clear.';
const documentId = 'cccccccc-1111-2222-3333-dddddddddddd';
const parent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function reasoner(harness, respond) {
  if (harness === 'standard') return new OpenAiCompatibleReasoner({ baseUrl: 'https://scripted.invalid/v1', model: 'fixture', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body), reply = respond(request.messages, (request.tools || []).map(tool => tool.function.name), { system: request.messages.find(message => message.role === 'system')?.content });
    return json({ choices: [{ message: reply.tool ? { tool_calls: [{ id: reply.id, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args || {}) } }] } : { content: JSON.stringify(reply) } }] });
  } });
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  return new PiReasoner({ baseUrl: 'https://scripted.invalid/v1', model: 'fixture', runtimeOptions: { streamFn: async (model, context) => {
    const names = context.tools?.map(tool => tool.name) || context.messages.find(message => message.role === 'system')?.toolsAdded?.map(tool => tool.name) || [];
    const reply = respond(context.messages, names, { system: context.systemPrompt || JSON.stringify(context.messages.find(message => message.role === 'system') || {}) }), stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: reply.tool ? [{ type: 'toolCall', id: reply.id, name: reply.tool, arguments: reply.args || {} }] : [{ type: 'text', text: JSON.stringify(reply) }],
      api: model.api, provider: model.provider, model: model.id, usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } }, stopReason: reply.tool ? 'toolUse' : 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
  } } });
}

for (const harness of ['standard', 'pi']) for (const source of ['notion', 'local_files']) {
  test(`${source} alone activates a standing goal, ${harness} reads its source and user accepts one pinned draft`, { skip: harness === 'pi' && !piSupported() }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-standing-harness-'));
    const store = new SqliteStore(path.join(directory, 'state.json'));
    const engine = new WorkEngine(store, { reasoner: new NullReasoner() });
    let writes = 0;
    const notion = new NotionConnector({ auth: { configured: () => true, accessToken: async () => 'fixture-token' }, account: { id: 'notion-account' }, fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (options.method === 'POST' && pathname !== '/v1/search') { writes++; throw new Error('Standing preparation cannot publish to the provider.'); }
      if (pathname === '/v1/search') return json({ results: [{ object: 'page', id: documentId, last_edited_time: new Date().toISOString(), properties: { title: { type: 'title', title: [{ plain_text: 'Lobby procedure' }] } } }], has_more: false });
      if (pathname === `/v1/blocks/${documentId}/children`) return json({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: quote }] } }], has_more: false });
      if (pathname.startsWith('/v1/pages/')) return json({ object: 'page', id: pathname.split('/').at(-1), archived: false });
      throw new Error('Unexpected fixture route.');
    } });
    const folder = path.join(directory, 'documents'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'Lobby.md'), `# Lobby procedure\n${quote}`);
    const local = new LocalFilesConnector({ scopeId: 'local-account', roots: [{ id: 'selected', label: 'Work', path: fs.realpathSync(folder) }] });
    const connector = source === 'notion' ? notion : local;
    const runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === source ? connector : null, artifactConnectionFor: id => id === 'notion' ? { connector: notion, accountId: 'notion-account', scopes: [] } : null });
    let monitor;
    t.after(async () => { monitor?.stop(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    await runtime.artifacts.createGrant({ connectorId: 'notion', targetId: parent }, { confirmed: true });
    runtime.intents.create({ description: 'Review lobby procedure', desiredOutcome: 'Prepare a short safety note', prefilter: { connectorIds: [source], eventTypes: ['document.modified'], roles: ['UNKNOWN', 'DIRECT_ACTOR', 'PASSIVE_OBSERVER', 'SHARED_GROUP'], tokens: ['lobby'] }, autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
    let reads = 0;
    engine.replaceReasoner(await reasoner(harness, (messages, names) => {
      const user = messages.find(message => message.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : user?.content?.[0]?.text;
      const input = JSON.parse(text);
      if (!input.taskId) return { experiences: [] };
      assert.ok(!names.includes('create_work_artifact'));
      const result = messages.filter(message => ['tool', 'toolResult'].includes(message.role)).at(-1);
      if (!result) return { tool: 'read_task_source', id: 'source' };
      const read = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
      assert.match(read.content, /Keep both emergency exits clear/); assert.equal(read.provider, source); assert.ok(read.documentId); reads++;
      return { title: 'Lobby safety note', body: quote, evidenceRefs: [{ eventId: read.eventId, quote }] };
    }));
    const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
    if (source === 'local_files') {
      monitor = new MonitoringService({ sync, connectors: [connector], setup: new LocalSetupStore({ filePath: path.join(directory, 'setup.json') }) });
      await monitor.setSettings({ enabled: true, intervalMs: 60000 }); await monitor.whenIdle();
      assert.equal(monitor.describe().status, 'watching');
    } else { const outcome = await sync.run(); assert.equal(outcome.results[0].failed, false); }
    await engine.whenSettled();
    const task = Object.values(store.state.tasks).find(task => task.kind === 'standing_intent');
    assert.ok(task, JSON.stringify(store.state.events));
    assert.equal(task.preparedWork?.kind, 'draft', JSON.stringify({ reasoning: task.reasoning, jobs: runtime.jobs.list() }));
    assert.equal(task.preparedWork.body, quote); assert.equal(reads, 1);
    runtime.scheduleTask(task.id, 'unchanged-revalidation'); await engine.whenSettled();
    assert.equal(reads, 1, 'unchanged input/context must not spend another model run');
    assert.ok(runtime.ledger.list().some(row => row.provider === 'workspace' && row.tool === 'read_task_source' && row.status === 'verified'));
    const token = preparedWorkReviewToken(task);
    runtime.acceptPreparedWork(task.id, { reviewToken: token });
    runtime.acceptPreparedWork(task.id, { reviewToken: token });
    assert.equal(runtime.tasks.get(task.id).completion.kind, 'user_accepted_preparation');
    assert.equal(runtime.tasks.get(task.id).action, undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM feedback_events WHERE task_id=? AND kind='explicit_acceptance'").get(task.id).n, 1);
    assert.equal(writes, 0);
    assert.equal(runtime.ledger.list().filter(row => row.is_write).length, 0);
  });
}

for (const harness of ['standard', 'pi']) for (const oversized of [false, true]) {
  test(`${harness} can read its source when ${oversized ? 'an oversized schema is in' : 'a large'} MCP catalog is connected`, { skip: harness === 'pi' && !piSupported() }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-full-catalog-'));
    const store = new SqliteStore(path.join(directory, 'state.json'));
    let mcpReads = 0;
    const catalog = Array.from({ length: 24 }, (_, index) => ({ name: `mcp_test_${index}`, description: 'd'.repeat(1000),
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'q'.repeat(600), ...(oversized && index === 23 ? { enum: Array.from({ length: 300 }, (_, i) => `value-${i}-${'x'.repeat(60)}`) } : {}) } }, required: ['query'], additionalProperties: false },
      execute: async (_id, args) => { assert.deepEqual(args, { query: 'chosen' }); mcpReads++; return { content: [{ type: 'text', text: 'Authorized MCP context.' }], details: {} }; } }));
    const engine = new WorkEngine(store, { reasoner: new NullReasoner(), externalTools: () => catalog });
    const folder = path.join(directory, 'documents'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'Lobby.md'), `# Lobby procedure\n${quote}`);
    const connector = new LocalFilesConnector({ scopeId: 'local-account', roots: [{ id: 'selected', label: 'Work', path: fs.realpathSync(folder) }] });
    const runtime = new DurableRuntime(engine, { tickMs: 100000, connectorFor: id => id === 'local_files' ? connector : null });
    t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    runtime.intents.create({ description: 'Review lobby procedure', desiredOutcome: 'Prepare a short safety note', prefilter: { connectorIds: ['local_files'], eventTypes: ['document.modified'], roles: ['UNKNOWN', 'DIRECT_ACTOR', 'PASSIVE_OBSERVER', 'SHARED_GROUP'], tokens: ['lobby'] }, autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
    let sourceReads = 0;
    engine.replaceReasoner(await reasoner(harness, (messages, names, metadata) => {
      const user = messages.find(message => message.role === 'user');
      const input = JSON.parse(typeof user?.content === 'string' ? user.content : user?.content?.[0]?.text || '{}');
      if (!input.taskId) return { experiences: [] };
      assert.ok(names.includes('read_task_source'));
      assert.equal(names.filter(name => name.startsWith('mcp_test_')).length, oversized ? 23 : 24);
      if (oversized) assert.match(metadata.system, /authorized tools were omitted/);
      const results = messages.filter(message => ['tool', 'toolResult'].includes(message.role)), result = results.at(-1);
      if (!result) return { tool: 'mcp_test_0', id: 'mcp', args: { query: 'chosen' } };
      if (results.length === 1) { assert.match(typeof result.content === 'string' ? result.content : result.content[0].text, /Authorized MCP context/); return { tool: 'read_task_source', id: 'source' }; }
      const read = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text);
      assert.match(read.content, /Keep both emergency exits clear/); sourceReads++;
      return { title: 'Lobby safety note', body: quote, evidenceRefs: [{ eventId: read.eventId, quote }] };
    }));
    const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
    const result = await sync.run(); assert.equal(result.results[0].failed, false);
    await engine.whenSettled();
    const task = Object.values(store.state.tasks).find(item => item.kind === 'standing_intent');
    assert.ok(task); assert.equal(task.preparedWork?.kind, 'draft', JSON.stringify(task.reasoning));
    assert.equal(sourceReads, 1); assert.equal(mcpReads, 1);
    assert.equal(catalog[0].description.length, 1000); assert.equal(catalog[0].parameters.properties.query.description.length, 600);
  });
}
