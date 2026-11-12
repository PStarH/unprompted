import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner, OpenAiCompatibleReasoner, PiReasoner } from '../src/reasoning.js';
import { lexicalEmbedding } from '../src/durable/memory.js';

const quote = 'Cedar approved budget is ¥62,000 including tax.';
const corrected = 'Cedar approved budget is ¥65,000 including tax.';
const unpack = result => JSON.parse(result.content[0].text);
function fixture(t, { direction = null, encoder = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-memory-harness-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  runtime.suspended = true;
  engine.ingest({ id: 'event:budget', type: 'email.received', at: new Date().toISOString(), connectorId: 'simulated', source: 'simulated',
    payload: { id: 'budget', threadId: 'thread:budget', from: 'alex@example.test', to: 'reader@example.test', subject: 'Cedar budget', body: quote } });
  const created = runtime.tasks.createOrLoad({ candidateKey: randomUUID(), eventId: 'event:budget', data: {
    subject: 'Cedar budget brief', status: 'waiting_for_information', sourceConnectorId: 'simulated', sender: 'alex@example.test',
    request: { subjectEntity: 'Cedar', deliverable: 'brief', text: 'Prepare a Cedar budget brief.', source: { kind: 'email', id: 'budget', eventId: 'event:budget', connectorId: 'simulated', from: 'alex@example.test' } }
  } });
  const taskId = created.taskId;
  if (direction) store.mutate(state => {
    state.tasks[taskId].guidance = { id: 'direction:budget', text: direction, scope: 'similar', operation: 'replace', at: new Date().toISOString() };
    state.taskDirections ||= {};
    state.taskDirections['direction:budget'] = { ...state.tasks[taskId].guidance, taskId };
  });
  if (encoder) { runtime.memory.encoder = encoder; runtime.memory.asyncEncoderKnown = null; }
  runtime.worker.stopping = true;
  runtime.suspended = false;
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const inRun = async action => {
    const queued = runtime.jobs.enqueue({ queue: 'memory-contract', type: 'memory_contract', taskId, key: randomUUID() });
    const job = runtime.jobs.claim('memory-contract', { queue: 'memory-contract', id: queued.id });
    const run = runtime.tasks.beginRun(job), task = runtime.tasks.get(taskId);
    const context = runtime.loadContext ? await runtime.loadContext(task, run) : runtime.buildContext(task, run);
    runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: context.version, sources: context.sources, plan: {} });
    return runtime.scope.run({ taskId, run, job, context, contextReadOffsets: new Map() }, async () => {
      const fence = runtime.capture(taskId);
      const tools = engine.externalTools({ taskId, isCurrent: () => runtime.isCurrent(taskId, fence) });
      try { return await action(Object.fromEntries(tools.map(tool => [tool.name, tool])), { task, context, run, job, fence }); }
      finally { try { runtime.tasks.finish(run, job); runtime.jobs.complete(job); } catch {} }
    });
  };
  return { runtime, engine, store, taskId, inRun };
}

test('a real task tool call remembers a source quote, commits provenance and write receipt, then requires a fresh plan', async t => {
  const env = fixture(t);
  let id;
  await env.inRun(async (tools, { fence }) => {
    assert.ok(tools.search_memories && tools.read_memory && tools.update_memory);
    const result = unpack(await tools.update_memory.execute('remember', { operation: 'remember', evidenceFrom: 'task_source', quote, text: quote }));
    id = result.memory.id;
    assert.equal(result.requiresReplan, true);
    assert.equal(result.memory.sourceKind, 'event');
    assert.equal(result.memory.sourceId, 'event:budget');
    assert.equal(env.runtime.isCurrent(env.taskId, fence), false);
    assert.equal(env.runtime.memorySpace.get(id).versions[0].changeKind, 'agent_remember');
    const execution = env.runtime.ledger.list().find(row => row.tool === 'update_memory');
    assert.equal(execution.is_write, 1);
    assert.equal(execution.status, 'verified');
    assert.equal(execution.action_family, 'memory.remember');
    await assert.rejects(tools.search_memories.execute('stale', { query: 'budget' }), /no longer current|checkpoint must be rebuilt/g);
  });
  await env.inRun(async (tools, { context }) => {
    assert.ok(context.memories.some(memory => memory.id === id));
    const read = unpack(await tools.read_memory.execute('read', { id }));
    assert.equal(read.content, quote); assert.equal(read.expectedVersion, 1);
    const search = unpack(await tools.search_memories.execute('search', { query: 'Cedar budget' }));
    assert.ok(search.memories.some(memory => memory.id === id));
    const duplicate = unpack(await tools.update_memory.execute('remember-again', { operation: 'remember', evidenceFrom: 'task_source', quote, text: quote }));
    assert.equal(duplicate.memory.id, id);
    assert.equal(duplicate.requiresReplan, false);
  });
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM user_memories WHERE id=?').get(id).n, 1);
  assert.equal(env.store.state.outbox.length, 0);
});

test('the harness applies a current user correction to the same memory store the Explorer reads', async t => {
  const env = fixture(t, { direction: corrected });
  const original = env.runtime.memorySpace.create({ text: quote, scopeType: 'project', scopeKey: 'Cedar' }).memory;
  await env.inRun(async tools => {
    const read = unpack(await tools.read_memory.execute('read', { id: original.id }));
    const result = unpack(await tools.update_memory.execute('correct', { operation: 'supersede', id: original.id, expectedVersion: read.expectedVersion, evidenceFrom: 'user_direction', quote: corrected, text: corrected }));
    assert.ok(result.replacementId);
    assert.equal(env.runtime.memorySpace.get(original.id).memory.lifecycleState, 'superseded');
    assert.equal(env.runtime.memorySpace.get(result.replacementId).memory.content, corrected);
    assert.equal(env.runtime.memorySpace.get(result.replacementId).versions[0].changeKind, 'agent_supersede');
    assert.equal(env.runtime.memorySpace.browse({ q: '65,000' }).records[0].id, result.replacementId);
    assert.equal(env.runtime.memory.eligible([original.id]).size, 0);
  });
});

test('memory tools reject cross-project/global writes, invented evidence, stale versions and unattended changes to user memories', async t => {
  const env = fixture(t);
  const owned = env.runtime.memorySpace.create({ text: quote, scopeType: 'project', scopeKey: 'Cedar' }).memory;
  const unrelated = env.runtime.memorySpace.create({ text: quote, scopeType: 'project', scopeKey: 'Juniper' }).memory;
  const global = env.runtime.memorySpace.create({ text: quote }).memory;
  await env.inRun(async tools => {
    await assert.rejects(tools.read_memory.execute('other', { id: unrelated.id }), /scope/);
    const base = { operation: 'edit', evidenceFrom: 'task_source', text: quote, quote };
    for (const memory of [unrelated, global]) await assert.rejects(tools.update_memory.execute('forbidden', { ...base, id: memory.id, expectedVersion: memory.version }), /global or unrelated/);
    await assert.rejects(tools.update_memory.execute('owned', { ...base, id: owned.id, expectedVersion: owned.version }), /user direction/);
    await assert.rejects(tools.update_memory.execute('invented', { operation: 'remember', evidenceFrom: 'task_source', text: 'Cedar costs zero.', quote: 'Cedar costs zero.' }), /quotation/);
    await assert.rejects(tools.update_memory.execute('preference', { operation: 'remember', evidenceFrom: 'task_source', memoryKind: 'preference', text: quote, quote }), /user preference/);
    env.store.mutate(state => { state.tasks[env.taskId].control = { paused: true }; });
    await assert.rejects(tools.search_memories.execute('paused', { query: 'budget' }), /no longer current|checkpoint must be rebuilt/g);
  });
});

test('UI version changes fence off an old harness before it can overwrite a newer correction', async t => {
  const env = fixture(t, { direction: corrected });
  const memory = env.runtime.memorySpace.create({ text: quote, scopeType: 'project', scopeKey: 'Cedar' }).memory;
  await env.inRun(async tools => {
    env.runtime.memorySpace.update(memory.id, { operation: 'edit', expectedVersion: memory.version, text: 'User saved a newer budget.' });
    await assert.rejects(tools.update_memory.execute('old', { operation: 'edit', id: memory.id, expectedVersion: memory.version, evidenceFrom: 'user_direction', quote: corrected, text: corrected }), /no longer current|checkpoint must be rebuilt/g);
    assert.equal(env.runtime.memorySpace.get(memory.id).memory.content, 'User saved a newer budget.');
  });
});

test('an asynchronous encoder runs outside the transaction and a paused run cannot commit its delayed embedding', async t => {
  let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  const env = fixture(t);
  await env.inRun(async tools => {
    env.runtime.memory.encoder = { id: 'async-contract', dimensions: 384, encode: async text => { assert.equal(env.store.db.inTransaction, false); began(); await gate; return lexicalEmbedding(text); } };
    env.runtime.memory.asyncEncoderKnown = null;
    const pending = tools.update_memory.execute('delayed', { operation: 'remember', evidenceFrom: 'task_source', quote, text: quote });
    await started; env.store.mutate(state => { state.tasks[env.taskId].control = { paused: true }; }); release();
    await assert.rejects(pending, /no longer current|checkpoint must be rebuilt/g);
    assert.equal(env.store.db.prepare("SELECT COUNT(*) n FROM memory_versions WHERE change_kind='agent_remember'").get().n, 0);
  });
});

import { piSupported } from '../src/pi-runtime.js';
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

for (const harness of ['standard', 'pi']) for (const asyncEncoder of [false, true]) test(`${harness} (${asyncEncoder ? 'async' : 'sync'} encoder) uses activation memory and actually writes through the model tool loop before replanning`, { skip: harness === 'pi' && !piSupported() }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-model-memory-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const saved = runtime.memorySpace.create({ text: 'Cedar budget must include tax.' }).memory;
  const preference = runtime.memorySpace.create({ text: '使用简体中文，保留金额单位。', memoryKind: 'preference' }).memory;
  if (asyncEncoder) { runtime.memory.encoder = { id: 'test-async', dimensions: 384, encode: async text => { assert.equal(store.db.inTransaction, false); return lexicalEmbedding(text); } }; runtime.memory.asyncEncoderKnown = null; }
  runtime.intents.create({ description: 'Watch Cedar budget', desiredOutcome: 'Prepare a Cedar budget note', predicate: 'Cedar budget is approved',
    prefilter: { connectorIds: ['simulated'], eventTypes: ['email.received'], roles: ['UNKNOWN', 'DIRECT_ACTOR', 'PASSIVE_OBSERVER', 'SHARED_GROUP'], tokens: ['cedar'] },
    autonomy: { maxAutonomy: 'prepare' }, prohibited: ['external_write'] }, { confirmed: true });
  let activationReads = 0, writes = 0, freshReads = 0;
  engine.replaceReasoner(await reasoner(harness, messages => {
    const user = messages.find(message => message.role === 'user');
    const input = JSON.parse(typeof user?.content === 'string' ? user.content : user?.content?.[0]?.text || '{}');
    if (input.predicate) {
      assert.ok(input.memoryContext.memories.some(memory => memory.id === saved.id));
      assert.ok(input.memoryContext.memories.some(memory => memory.id === preference.id)); activationReads++;
      return { matched: true, confidence: 0.99, quote };
    }
    if (!input.taskId) return { experiences: [] };
    assert.ok(input.planningContext.memory.some(memory => memory.id === preference.id));
    const remembered = input.planningContext.memory.find(memory => memory.text === quote);
    if (!remembered) { writes++; return { tool: 'update_memory', id: 'remember-budget', args: { operation: 'remember', evidenceFrom: 'task_source', quote, text: quote } }; }
    freshReads++;
    return { title: 'Cedar budget', body: quote, evidenceRefs: [{ eventId: input.primarySourceEventId || input.sources[0], quote }] };
  }));
  engine.ingest({ id: 'event:model-budget', type: 'email.received', at: new Date().toISOString(), connectorId: 'simulated', source: 'simulated',
    payload: { id: 'model-budget', threadId: 'thread:model-budget', from: 'alex@example.test', to: 'reader@example.test', subject: 'Cedar budget', body: quote } });
  await engine.whenSettled(); await runtime.whenIdle();
  const task = Object.values(store.state.tasks).find(task => task.kind === 'standing_intent');
  assert.ok(task);
  assert.equal(task.preparedWork?.body, quote, JSON.stringify({ reasoning: task.reasoning, jobs: runtime.jobs.list() }));
  assert.equal(activationReads, 1); assert.ok(writes >= 1); assert.equal(freshReads, 1);
  const execution = runtime.ledger.list().find(row => row.tool === 'update_memory' && row.status === 'verified');
  assert.ok(execution); assert.equal(execution.is_write, 1);
  const memory = runtime.memorySpace.get(store.db.prepare('SELECT resource_id FROM tool_executions WHERE id=?').get(execution.id).resource_id);
  assert.equal(memory.memory.content, quote); assert.equal(memory.versions[0].changeKind, 'agent_remember');
  assert.ok(memory.memory.sourceTasks.some(source => source.id === task.id));
  const provenance = runtime.memorySpace.get(saved.id).provenance;
  assert.ok(provenance.activationUsage.some(use => use.kind === 'standing_intent_match' && use.eventId === 'event:model-budget'));
  assert.ok(provenance.usage.some(use => use.taskId === task.id && use.subject));
  assert.equal(store.state.outbox.length, 0);
});

test('user-directed lifecycle changes are applied by task tools and excluded from activation retrieval', async t => {
  const env = fixture(t, { direction: corrected });
  const original = env.runtime.memorySpace.create({ text: quote, scopeType: 'project', scopeKey: 'Cedar' }).memory;
  for (const [operation, state, consumable] of [['disable', 'disabled', false], ['reactivate', 'active', true], ['archive', 'archived', false], ['restore', 'active', true], ['delete', 'deleted', false], ['restore-delete', 'active', true]]) {
    await env.inRun(async tools => {
      const memory = env.runtime.memorySpace.get(original.id).memory;
      const result = unpack(await tools.update_memory.execute(operation, { operation, id: memory.id, expectedVersion: memory.expectedVersion, evidenceFrom: 'user_direction', quote: corrected }));
      assert.equal(result.memory.lifecycleState, state); assert.equal(result.requiresReplan, true);
    });
    const event = env.store.state.events.find(event => event.id === 'event:budget');
    const context = await env.runtime.activationMemoryContext([event], { intent: { scope: { type: 'project', key: 'Cedar' } } });
    assert.equal(context.memories.some(memory => memory.id === original.id), consumable);
  }
});

for (const asyncEncoder of [false, true]) test(`scoped preferences and legacy version tokens survive ${asyncEncoder ? 'async' : 'sync'} retrieval and model correction`, async t => {
  const env = fixture(t, { direction: corrected });
  env.store.mutate(state => {
    state.taskMemories ||= {};
    state.taskMemories['legacy:contract'] = { id: 'legacy:contract', text: 'Cedar budget note uses approved amounts.', taskId: env.taskId,
      scope: { entity: 'Cedar', deliverable: 'brief' }, createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z',
      memoryKind: 'fact', lifecycleState: 'active', versions: [] };
  });
  const project = env.runtime.memorySpace.create({ text: '请使用短段落，不要使用幻灯片。', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar' }).memory;
  const person = env.runtime.memorySpace.create({ text: '请在上午提交摘要。', memoryKind: 'preference', scopeType: 'entity', scopeKey: 'person:林晨' }).memory;
  const unrelated = env.runtime.memorySpace.create({ text: '请附上照片。', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Juniper' }).memory;
  const disabled = env.runtime.memorySpace.create({ text: '请使用旧版格式。', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar' }).memory;
  env.runtime.memorySpace.update(disabled.id, { operation: 'disable', expectedVersion: disabled.version });
  const expired = env.runtime.memorySpace.create({ text: '临时偏好已经过期。', memoryKind: 'preference', validUntil: '2000-01-01T00:00:00.000Z' }).memory;
  env.store.db.prepare('INSERT INTO canonical_entities VALUES(?,?,?,?,?,1,?)').run('person:alex', 'person', 'simulated', 'alex@example.test', JSON.stringify(['林晨']), new Date().toISOString());
  if (asyncEncoder) { env.runtime.memory.encoder = { id: 'async-context', dimensions: 384, encode: async text => { assert.equal(env.store.db.inTransaction, false); return lexicalEmbedding(text); } }; env.runtime.memory.asyncEncoderKnown = null; }
  await env.inRun(async (tools, { context }) => {
    const ids = new Set(context.memories.map(memory => memory.id));
    for (const memory of [project, person]) assert.ok(ids.has(memory.id));
    for (const memory of [unrelated, disabled, expired]) assert.equal(ids.has(memory.id), false);
    const manifest = env.runtime.planningContext(env.taskId);
    assert.equal(manifest.memory.find(memory => memory.id === 'legacy:contract').expectedVersion, '2026-10-01T09:00:00.000Z');
    const results = unpack(await tools.search_memories.execute('legacy-search', { query: 'Cedar budget note' }));
    assert.equal(results.memories.find(memory => memory.id === 'legacy:contract').expectedVersion, '2026-10-01T09:00:00.000Z');
    const workspace = await env.runtime.recallWorkspace(env.runtime.tasks.get(env.taskId), { query: 'Cedar', kind: 'memory' });
    assert.ok(workspace.records.some(memory => memory.id === 'legacy:contract'));
    const updated = unpack(await tools.update_memory.execute('legacy-correct', { operation: 'edit', id: 'legacy:contract', expectedVersion: '2026-10-01T09:00:00.000Z', evidenceFrom: 'user_direction', quote: corrected, text: corrected }));
    assert.equal(updated.memory.content, corrected);
    assert.equal(env.store.state.taskMemories['legacy:contract'].text, corrected);
  });
  const event = env.store.state.events.find(event => event.id === 'event:budget');
  const activation = await env.runtime.activationMemoryContext([event], { intent: { scope: { type: 'project', key: 'Cedar' } } });
  assert.ok(activation.memories.some(memory => memory.id === project.id));
  assert.ok(activation.memories.some(memory => memory.id === person.id));
  assert.equal(activation.memories.some(memory => [unrelated.id, disabled.id, expired.id].includes(memory.id)), false);
});

test('an async retrieval cannot replace the caller version or publish results after an encoder swap', async t => {
  const env = fixture(t);
  const memory = env.runtime.memorySpace.create({ text: quote }).memory;
  const stale = env.runtime.memory.version() - 1;
  await assert.rejects(env.runtime.memory.searchAsync('budget', { expectedContextVersion: stale }), { code: 'CONTEXT_CHANGED' });
  let release;
  env.runtime.memory.encoder = { id: 'delayed', dimensions: 384, encode: () => new Promise(resolve => { release = () => resolve(lexicalEmbedding('budget')); }) };
  const pending = env.runtime.memory.searchAsync('budget');
  env.runtime.memory.encoder = { id: 'replacement', dimensions: 384, encode: lexicalEmbedding };
  release();
  await assert.rejects(pending, { code: 'CONTEXT_CHANGED' });
  assert.equal(env.runtime.memorySpace.get(memory.id).memory.content, quote);
});

test('a failed legacy write receipt rolls back both the workspace and its memory projection', async t => {
  const env = fixture(t, { direction: corrected });
  env.store.mutate(state => {
    state.taskMemories = { 'legacy:rollback': { id: 'legacy:rollback', text: quote, taskId: env.taskId, scope: { entity: 'Cedar', deliverable: 'brief' }, updatedAt: '2026-10-01T09:00:00.000Z', memoryKind: 'fact', lifecycleState: 'active', versions: [] } };
  });
  env.store.db.exec("CREATE TRIGGER reject_memory_receipt BEFORE INSERT ON tool_executions WHEN NEW.tool='update_memory' BEGIN SELECT RAISE(ABORT, 'receipt contract failure'); END");
  await env.inRun(async tools => {
    await assert.rejects(tools.update_memory.execute('failed-legacy', { operation: 'edit', id: 'legacy:rollback', expectedVersion: '2026-10-01T09:00:00.000Z', evidenceFrom: 'user_direction', quote: corrected, text: corrected }), /receipt contract failure/);
    assert.equal(env.store.state.taskMemories['legacy:rollback'].text, quote);
    assert.equal(env.runtime.memorySpace.get('legacy:rollback').memory.content, quote);
    assert.equal(env.runtime.ledger.list().filter(row => row.tool === 'update_memory').length, 0);
  });
});

test('legacy UI mutations remain usable with an unprobed async encoder', async t => {
  const env = fixture(t);
  env.store.mutate(state => {
    state.taskMemories = { 'legacy:async-ui': { id: 'legacy:async-ui', text: quote, taskId: env.taskId, scope: { entity: 'Cedar', deliverable: 'brief' }, updatedAt: '2026-10-01T09:00:00.000Z', memoryKind: 'fact', lifecycleState: 'active', versions: [] } };
  });
  env.runtime.memory.encoder = { id: 'async-ui', dimensions: 384, encode: async text => { assert.equal(env.store.db.inTransaction, false); return lexicalEmbedding(text); } };
  env.runtime.memory.asyncEncoderKnown = null;
  const changed = env.runtime.memorySpace.update('legacy:async-ui', { operation: 'edit', expectedVersion: '2026-10-01T09:00:00.000Z', text: corrected });
  assert.equal(changed.memory.content, corrected);
  const hits = await env.runtime.memory.search('Cedar', { scopes: [{ type: 'project', key: '["cedar","brief"]' }] });
  assert.ok(hits.some(hit => hit.id === 'legacy:async-ui'));
});

import { openActivationReplay } from '../src/durable/activation-replay.js';
test('asynchronous memories reach both pair assessment and situation delta, with recorded consultation', async t => {
  let pairReads = 0, deltaReads = 0, preferenceId;
  const check = input => {
    assert.ok(input.memoryContext.memories.some(memory => memory.id === preferenceId));
    assert.equal(typeof input.memoryContext.then, 'undefined');
  };
  const env = openActivationReplay({ scripts: {
    pair: input => { check(input); pairReads++; return { outcome: 'RELATED_WAIT', summary: 'Waiting for delivery terms.', missingEvidence: ['Delivery date'], reevaluationCondition: 'When delivery terms arrive.', confidence: 0.9,
      evidence: input.events.map(event => ({ eventId: event.id, field: 'body', quote: event.body })) }; },
    delta: input => { check(input); deltaReads++; return { associated: true, polarity: 'NEUTRAL', confidence: 0.95, evidenceRefs: [{ field: 'body', quote: 'Delivery terms remain open.' }],
      stateDelta: { deadlineUpdates: [], commitments: [], closureConditionUpdates: [], probeTargets: [], missingEvidence: [] } }; }
  } });
  t.after(() => env.close());
  preferenceId = env.runtime.memorySpace.create({ text: '请优先说明不确定的事项。', memoryKind: 'preference' }).memory.id;
  env.runtime.memory.encoder = { id: 'async-activation', dimensions: 384, encode: async text => { assert.equal(env.store.db.inTransaction, false); return lexicalEmbedding(text); } }; env.runtime.memory.asyncEncoderKnown = null;
  const event = (id, body) => ({ id: `event:${id}`, connectorId: 'simulated', source: 'simulated', type: 'email.received', at: env.at(),
    payload: { id, threadId: 'thread:delivery', from: 'alex@example.test', to: 'reader@example.test', subject: 'Supplier quotation', body } });
  env.engine.ingest(event('first', 'The quotation includes a price.'));
  env.engine.ingest(event('second', 'Delivery terms remain open.'));
  await env.settle(); assert.equal(pairReads, 1);
  env.engine.ingest(event('third', 'Delivery terms remain open.'));
  await env.settle(); assert.equal(deltaReads, 1);
  const usage = env.runtime.memorySpace.get(preferenceId).provenance.activationUsage;
  assert.ok(usage.some(item => item.kind === 'situation_pair'));
  assert.ok(usage.some(item => item.kind === 'situation_delta'));
});

test('a memory change while activation embedding is pending is retryable and never reaches a stale classifier', async t => {
  const env = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  env.runtime.memory.encoder = { id: 'delayed-activation', dimensions: 384, encode: text => { if (text === ' ') return Promise.resolve(lexicalEmbedding(text)); entered(); return new Promise(resolve => { release = () => resolve(lexicalEmbedding(text)); }); } };
  env.runtime.memory.asyncEncoderKnown = null;
  const event = env.store.state.events.find(event => event.id === 'event:budget');
  const pending = env.runtime.activationMemoryContext([event]);
  await started;
  env.runtime.database.bump('context_version'); release();
  await assert.rejects(pending, error => error.code === 'CONTEXT_CHANGED' && error.status === 503);
});

test('an async UI correction commits its replacement and old lifecycle atomically, including a concurrent edit', async t => {
  const env = fixture(t);
  const original = env.runtime.memorySpace.create({ text: quote, scopeType: 'project', scopeKey: 'Cedar' }).memory;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  env.runtime.memory.encoder = { id: 'delayed-ui-correction', dimensions: 384, encode: async text => { assert.equal(env.store.db.inTransaction, false); if (text !== ' ' && ++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); } return lexicalEmbedding(text); } };
  env.runtime.memory.asyncEncoderKnown = null;
  const pending = env.runtime.memorySpace.update(original.id, { operation: 'supersede', expectedVersion: original.version, text: corrected });
  await started;
  env.runtime.memory.put({ id: original.id, content: 'A newer user edit.', scopeType: 'project', scopeKey: 'Cedar' }, { vector: lexicalEmbedding('A newer user edit.') });
  release(); await assert.rejects(pending, { code: 'MEMORY_CHANGED' });
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM user_memories').get().n, 1);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM memory_relations').get().n, 0);
  const result = await env.runtime.memorySpace.update(original.id, { operation: 'supersede', expectedVersion: 2, text: corrected });
  assert.equal(result.memory.content, corrected);
  assert.equal(env.runtime.memorySpace.get(original.id).memory.lifecycleState, 'superseded');
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM memory_relations').get().n, 1);
  const another = (await env.runtime.memorySpace.create({ text: 'Another approved amount.' })).memory;
  env.store.db.prepare('CREATE TEMP TABLE blocked_memory(id TEXT)').run();
  env.store.db.prepare('INSERT INTO blocked_memory VALUES(?)').run(another.id);
  env.store.db.exec("CREATE TEMP TRIGGER reject_old_transition BEFORE UPDATE ON user_memories WHEN OLD.id IN (SELECT id FROM blocked_memory) AND NEW.lifecycle_state='superseded' BEGIN SELECT RAISE(ABORT, 'old transition failed'); END");
  await assert.rejects(env.runtime.memorySpace.update(another.id, { operation: 'supersede', expectedVersion: 1, text: 'A replacement that must roll back.' }), /old transition failed/);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM user_memories').get().n, 3);
  assert.equal(env.store.db.prepare('SELECT COUNT(*) n FROM memory_relations').get().n, 1);
  assert.equal(env.runtime.memorySpace.get(another.id).memory.lifecycleState, 'active');
});
