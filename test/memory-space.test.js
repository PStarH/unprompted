import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { emptyState } from '../src/store.js';
import { matchingTaskMemories } from '../src/task-guidance.js';
import { startFixtureServer } from './browser/fixture-server.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-memory-space-'));
  const seed = emptyState();
  seed.taskMemories = {};
  seed.tasks['task:cedar'] = { id: 'task:cedar', subject: 'Cedar proposal', status: 'waiting_for_information',
    request: { subjectEntity: 'Cedar', deliverable: 'proposal', text: 'Prepare the Cedar proposal.' } };
  seed.taskMemories['legacy:cedar'] = { id: 'legacy:cedar', text: 'Lead with experiment results.', taskId: 'task:cedar',
    scope: { entity: 'Cedar', deliverable: 'proposal' }, createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
    deletedAt: null, memoryKind: 'fact', lifecycleState: 'active', validUntil: null, supersededBy: null,
    versions: [{ version: 1, text: 'Lead with experiment results.', lifecycleState: 'active', validUntil: null, changeKind: 'created', createdAt: '2026-11-01T09:00:00.000Z' }] };
  const filename = path.join(directory, 'state.json');
  fs.writeFileSync(filename, JSON.stringify(seed));
  const store = new SqliteStore(filename), provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider }), runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime, service: runtime.memorySpace };
}

async function post(fixture, route, body) {
  const response = await fetch(fixture.base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function get(fixture, route) {
  const response = await fetch(fixture.base + route);
  return { status: response.status, body: await response.json() };
}

test('direct memory lifecycle preserves versions, concurrency, exact scope and relationship evidence', async t => {
  const { runtime, service } = fixture(t);
  const created = service.create({ content: 'Cedar prefers concise updates.', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar' });
  const id = created.memory.id;
  assert.equal(created.memory.version, 1);
  assert.equal(created.versions.length, 1);
  assert.throws(() => service.update(id, { operation: 'edit', content: 'Stale write.', expectedVersion: 0 }), { code: 'MEMORY_CHANGED' });
  assert.throws(() => service.update(id, { operation: 'edit', content: 'Missing concurrency token.' }), { code: 'MEMORY_CHANGED' });
  const edited = service.update(id, { operation: 'edit', content: 'Cedar prefers concise weekly updates.', expectedVersion: 1 });
  assert.equal(edited.memory.version, 2);
  assert.equal(service.get(id).versions.length, 2);
  const peer = service.create({ content: 'Cedar meetings use an agenda.' }).memory;
  service.changeRelation(id, { operation: 'add', targetId: peer.id, kind: 'related_to', expectedVersion: 2, evidenceKind: 'user_confirmed', evidenceRef: 'review:1' });
  const detail = service.get(id);
  assert.equal(detail.relations.length, 1);
  assert.deepEqual([detail.relations[0].from, detail.relations[0].to].sort(), [id, peer.id].sort());
  assert.equal(detail.relations[0].evidenceRef, 'review:1');
  assert.throws(() => service.changeRelation(id, { operation: 'add', targetId: peer.id, kind: 'supersedes', expectedVersion: 2 }), { code: 'INVALID_RELATION' });
  assert.equal(runtime.memory.search('concise', { scopes: [{ type: 'project', key: 'Cedar' }] }).some(memory => memory.id === id), true);
  assert.equal(runtime.memory.search('concise', { scopes: [{ type: 'project', key: 'Other' }] }).some(memory => memory.id === id), false);
  assert.equal(service.update(id, { operation: 'disable', expectedVersion: 2 }).memory.lifecycleState, 'disabled');
  assert.equal(runtime.memory.search('concise', { scopes: [{ type: 'project', key: 'Cedar' }] }).some(memory => memory.id === id), false);
  service.update(id, { operation: 'reactivate', expectedVersion: 3 });
  service.update(id, { operation: 'archive', expectedVersion: 4 });
  assert.equal(service.update(id, { operation: 'restore', expectedVersion: 5 }).memory.lifecycleState, 'active');
  service.update(id, { operation: 'delete', expectedVersion: 6 });
  assert.equal(service.browse({ status: 'current' }).records.some(memory => memory.id === id), false);
  assert.equal(service.update(id, { operation: 'restore-delete', expectedVersion: 7 }).memory.lifecycleState, 'active');
  const restored = service.update(id, { operation: 'restore-version', content: 'Cedar prefers concise updates.', expectedVersion: 8 });
  assert.equal(restored.memory.content, 'Cedar prefers concise updates.');
  assert.equal(service.get(id).versions[0].changeKind, 'restore-version');
});

test('direct supersession keeps history, blocks resurrection and never broadens applicability', async t => {
  const { runtime, service } = fixture(t);
  const original = service.create({ content: 'Cedar proposal is due Friday.', scopeType: 'project', scopeKey: 'Cedar' }).memory;
  const result = service.update(original.id, { operation: 'supersede', expectedVersion: original.version, content: 'Cedar proposal is due Monday.' });
  assert.ok(result.replacementId);
  assert.equal(service.get(original.id).memory.lifecycleState, 'superseded');
  assert.equal(service.get(original.id).memory.consumable, false);
  assert.equal(service.get(original.id).relations[0].kind, 'supersedes');
  assert.equal(service.get(result.replacementId).memory.scopeKey, 'Cedar');
  assert.equal(runtime.memory.search('Monday', { scopes: [{ type: 'project', key: 'Cedar' }] }).some(memory => memory.id === result.replacementId), true);
  assert.equal(service.browse().records.some(memory => memory.id === result.replacementId), true);
  assert.equal(runtime.memory.eligible([original.id, result.replacementId]).has(original.id), false);
  assert.equal(runtime.memory.search('Monday', { scopes: [{ type: 'project', key: 'Other' }] }).some(memory => memory.id === result.replacementId), false);
  assert.throws(() => service.update(original.id, { operation: 'delete', expectedVersion: 2 }), { code: 'INVALID_MEMORY_OPERATION' });
});

test('legacy mutations retain task ownership, exact matching and recoverable lifecycle', async t => {
  const { store, service, runtime } = fixture(t);
  assert.equal(service.get('legacy:cedar').memory.sourceTasks[0].id, 'task:cedar');
  const disabled = service.update('legacy:cedar', { operation: 'disable', expectedVersion: '2026-11-01T09:00:00.000Z' });
  assert.equal(disabled.memory.lifecycleState, 'disabled');
  assert.equal(matchingTaskMemories(store.state.tasks['task:cedar'], store.state).length, 0);
  service.update('legacy:cedar', { operation: 'reactivate', expectedVersion: disabled.memory.expectedVersion });
  assert.equal(matchingTaskMemories(store.state.tasks['task:cedar'], store.state).length, 1);
  const deleted = service.update('legacy:cedar', { operation: 'delete', expectedVersion: service.get('legacy:cedar').memory.expectedVersion });
  assert.equal(deleted.memory.lifecycleState, 'deleted');
  const restored = service.update('legacy:cedar', { operation: 'restore-delete', expectedVersion: deleted.memory.expectedVersion });
  assert.equal(restored.memory.lifecycleState, 'active');
  const superseded = service.update('legacy:cedar', { operation: 'supersede', expectedVersion: restored.memory.expectedVersion, content: 'Lead with validated experiment results.' });
  assert.ok(superseded.replacementId);
  assert.equal(store.state.taskMemories[superseded.replacementId].taskId, 'task:cedar');
  assert.equal(store.state.taskMemories['legacy:cedar'].lifecycleState, 'superseded');
  assert.equal(service.get('legacy:cedar').relations.some(relation => relation.kind === 'supersedes' && relation.from === superseded.replacementId), true);
  assert.equal(matchingTaskMemories(store.state.tasks['task:cedar'], store.state).map(memory => memory.id).join(','), superseded.replacementId);
  assert.equal(runtime.memory.eligible([superseded.replacementId]).has(superseded.replacementId), true);
});

test('browse uses evidence-backed bounded associations without duplicate-text edges', async t => {
  const { service } = fixture(t);
  const left = service.create({ content: 'Identical text', scopeType: 'entity', scopeKey: 'left' }).memory;
  const right = service.create({ content: 'Identical text', scopeType: 'entity', scopeKey: 'right' }).memory;
  const browse = service.browse({ status: 'all', focus: left.id });
  assert.equal(browse.focusId, left.id);
  assert.equal(browse.relations.some(edge => [edge.from, edge.to].includes(right.id)), false);
  assert.equal(browse.derivedRelations.some(edge => [edge.from, edge.to].includes(right.id)), false);
  assert.equal(service.browse({ query: 'no such memory', focus: left.id }).focusId, null);
  assert.equal(service.browse({ query: 'no such memory', focus: left.id }).records.length, 0);
});

test('Memory Space HTTP serves every frontend asset with the correct MIME type', async t => {
  const fixture = await startFixtureServer({ ruleDemo: true });
  t.after(fixture.close);
  for (const [file, type] of [['memory-space.js', 'text/javascript'], ['memory-space-model.js', 'text/javascript'], ['memory-space.css', 'text/css']]) {
    const response = await fetch(`${fixture.base}/${file}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(`^${type.replace('/', '\\/')}`));
  }
});

test('Memory Space HTTP API exercises real writes and conflict responses', async t => {
  const fixture = await startFixtureServer({ ruleDemo: false });
  t.after(fixture.close);
  let response = await post(fixture, '/api/memory-space', { content: 'Cedar prefers concise updates.', memoryKind: 'preference', scopeType: 'project', scopeKey: 'Cedar' });
  assert.equal(response.status, 200, response.body.error);
  const memory = response.body.memory;
  assert.equal(memory.version, 1);
  response = await post(fixture, `/api/memory-space/${memory.id}`, { operation: 'edit', content: 'Cedar prefers concise weekly updates.', expectedVersion: 1 });
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.memory.version, 2);
  response = await post(fixture, `/api/memory-space/${memory.id}`, { operation: 'edit', content: 'Stale update.', expectedVersion: 1 });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'MEMORY_CHANGED');
  response = await get(fixture, `/api/memory-space/${memory.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.versions.length, 2);
  response = await post(fixture, `/api/memory-space/${memory.id}`, { operation: 'delete', expectedVersion: 2 });
  assert.equal(response.status, 200);
  assert.equal(response.body.memory.lifecycleState, 'deleted');
  response = await get(fixture, '/api/memory-space?status=deleted');
  assert.equal(response.body.records.some(record => record.id === memory.id), true);
  response = await post(fixture, `/api/memory-space/${memory.id}`, { operation: 'restore-delete', expectedVersion: 3 });
  assert.equal(response.status, 200);
  assert.equal(response.body.memory.lifecycleState, 'active');
  response = await post(fixture, `/api/memory-space/${memory.id}`, { operation: 'supersede', expectedVersion: 4, content: 'Cedar prefers concise monthly updates.' });
  assert.equal(response.status, 200, response.body.error);
  assert.ok(response.body.replacementId);
  response = await get(fixture, `/api/memory-space/${memory.id}`);
  assert.equal(response.body.relations.some(relation => relation.kind === 'supersedes'), true);
  response = await post(fixture, '/api/memory-space', { content: 'Meetings need an agenda.' });
  const peer = response.body.memory;
  response = await post(fixture, `/api/memory-space/${peer.id}/relations`, { operation: 'add', targetId: memory.id, kind: 'related_to', expectedVersion: peer.version });
  assert.equal(response.status, 200);
});


test('search finds older memories beyond the recent 1,000 and reports response truncation', t => {
  const { service, runtime } = fixture(t);
  const at = '2025-01-01T00:00:00.000Z';
  const insert = runtime.db.prepare(`INSERT INTO user_memories
    (id,scope_type,scope_key,content,source_kind,source_id,created_at,updated_at)
    VALUES(?,'project','Archive',?,'user_instruction',?,?,?)`);
  runtime.database.atomic(() => {
    for (let index = 0; index < 1002; index++) {
      const id = `archive-${String(index).padStart(4, '0')}`;
      runtime.db.prepare("INSERT INTO source_records(kind,id,active,created_at) VALUES('user_instruction',?,1,?)").run(id, at);
      insert.run(id, index === 1001 ? 'The rare archived reference: kestrel.' : `Archive fact ${index}`, id, at, at);
    }
  });
  assert.equal(service.browse({ q: 'kestrel' }).records[0].id, 'archive-1001');
  const result = service.browse({ scope: 'Archive' });
  assert.equal(result.total, 1002);
  assert.equal(result.records.length, 500);
  assert.equal(result.truncated, true);
});

test('an incoming directed relation can be removed without changing its neighbors', t => {
  const { service } = fixture(t);
  const first = service.create({ content: 'First recorded fact.' }).memory;
  const second = service.create({ content: 'A derived fact.' }).memory;
  service.changeRelation(second.id, { operation: 'add', targetId: first.id, kind: 'derived_from', expectedVersion: second.version });
  assert.equal(service.get(first.id).relations.length, 1);
  service.changeRelation(first.id, { operation: 'remove', targetId: second.id, kind: 'derived_from', expectedVersion: first.version });
  assert.equal(service.get(second.id).relations.length, 0);
  assert.equal(service.get(second.id).memory.content, second.content);
});

test('task applicability lineage is not presented as a source or actual task-run usage', t => {
  const { service, runtime } = fixture(t);
  const memory = service.create({ content: 'Use a short Cedar summary.', scopeType: 'project', scopeKey: 'Cedar' }).memory;
  runtime.database.atomic(() => runtime.database.lineage('memory', memory.id, 'task', 'task:cedar'));
  const detail = service.get(memory.id);
  assert.equal(detail.memory.sourceTasks.length, 0);
  assert.equal(detail.provenance.usage.length, 0);
  assert.equal(detail.provenance.lineage.length > 0, true);
});


test('expiry never hides an archived, disabled or superseded memory from its lifecycle filter', t => {
  const { service } = fixture(t);
  const memory = service.create({ content: 'A dated fact.', validUntil: '2020-01-01T00:00:00.000Z' }).memory;
  assert.equal(memory.status, 'expired');
  const archived = service.update(memory.id, { operation: 'archive', expectedVersion: memory.version }).memory;
  assert.equal(archived.status, 'archived');
  assert.equal(service.browse({ status: 'archived' }).records.some(record => record.id === memory.id), true);
});
