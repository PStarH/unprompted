import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { seedMemoryExplorerStore, createMemoryExplorerFixture } from './fixtures/memory-explorer.js';
import { rankMemoryResults } from '../src/memory-explorer.js';
import { demoMemorySpace } from '../src/demo-memory-space.js';
import { createDemoMemoryRecords } from '../src/demo-memories.js';
import { buildExplorerGraph } from '../public/memory-space-model.js';

function fixture(t, count) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-explorer-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  seedMemoryExplorerStore(store, count);
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return runtime.memorySpace;
}

for (const count of [100, 250, 500]) test(`search retrieves real memories from ${count} records with reasons and origins`, t => {
  const service = fixture(t, count);
  for (const [query, expected] of [
    ['What is the budget for Cedar?', 'budget-current'],
    ['Find the preference 林晨 expressed several weeks ago', 'old-preference'],
    ['Find the correction from the previous Cedar task', 'budget-current'],
    ['studio blue drawer', 'isolated-key'],
    ['预算 Cedar', 'budget-current'],
    ['我之前给 Cedar 项目的预算是多少', 'budget-current'],
    ['林晨几周前说过的偏好是什么', 'old-preference'],
    ['上次任务里我更正过的 Cedar 预算', 'budget-current'],
    ['How much did we allocate to Cedar?', 'budget-current'],
    ['What spending limit did we agree for Cedar?', 'budget-current'],
  ]) {
    const result = service.browse({ q: query, status: 'remembered' });
    assert.equal(result.records[0]?.id, expected, query);
    assert.ok(result.records[0].match.reasons.length, query);
    assert.ok(result.records[0].match.excerpt, query);
  }
  const sourceMatches = service.browse({ q: 'meeting preparation conversation', status: 'remembered' });
  assert.ok(sourceMatches.records.some(record => record.id === 'old-preference'));
  assert.ok(sourceMatches.records.some(record => record.match.reasons.some(reason => reason.kind === 'source')));
  const project = service.browse({ q: 'Everything relevant to Cedar', status: 'remembered' });
  assert.ok(project.records.some(record => record.id === 'cedar-context'));
  assert.ok(service.browse({ q: 'Cedar项目有哪些相关记忆', status: 'remembered' }).records.some(record => record.id === 'cedar-context'));
  assert.ok(project.records.every(record => record.scopeKey === 'Cedar' || record.relatedMemories?.some(memory => /Cedar/.test(memory.content))));
  assert.equal(service.browse({ q: 'this phrase does not exist XYZ', status: 'remembered' }).records.length, 0);
});

test('the old nine bucket edges are absent; same scope and source do not create semantic links', () => {
  const records = createDemoMemoryRecords(100);
  const state = { taskMemories: Object.fromEntries(records.map(record => [record.id, { ...record, scope: { entity: record.scope.entity, deliverable: record.scope.deliverable } }])) };
  const result = demoMemorySpace(state);
  assert.equal(result.derivedRelations.length, 0);
  assert.ok(result.records.every(record => record.relations.length === 0));
});

test('context distinguishes correction, project, person and source and is independent of search filters', t => {
  const service = fixture(t, 100);
  const detail = service.get('budget-old');
  assert.equal(detail.context.memories.some(memory => memory.id === 'budget-current'), true);
  assert.equal(detail.context.relations.find(edge => edge.kind === 'supersedes').from, 'budget-current');
  assert.equal(detail.context.sources[0].taskId, 'budget-conversation');
  assert.equal(detail.context.entities[0].kind, 'project');
  assert.equal(service.get('old-preference').context.entities[0].kind, 'person');
  assert.equal(service.get('isolated-key').context.relations.length, 0);
  assert.equal(service.get('isolated-key').context.entities.length, 0);
  const direct = service.get('budget-current');
  const expanded = service.get('budget-current', { depth: 2 });
  assert.equal(direct.context.memories.some(memory => memory.id === 'cedar-context'), false);
  assert.equal(expanded.context.memories.some(memory => memory.id === 'cedar-context'), true);
});

test('graph positions depend on explicit center, never the selected Inspector memory', t => {
  const service = fixture(t, 100);
  const detail = service.get('budget-current');
  const first = buildExplorerGraph(detail);
  const second = buildExplorerGraph(detail, { selectedId: 'budget-old' });
  assert.deepEqual(first, second);
  assert.ok(first.nodes.some(node => node.kind === 'project'));
  assert.ok(first.nodes.some(node => node.kind === 'task'));
  assert.ok(first.nodes.some(node => node.kind === 'memory'));
  assert.equal(first.centerId, 'budget-current');
  const isolated = buildExplorerGraph(service.get('isolated-key'));
  assert.equal(isolated.nodes.length, 1);
  assert.equal(isolated.edges.length, 0);
});

test('matching explains a related concept without treating similarity as evidence', () => {
  const { records } = createMemoryExplorerFixture(100);
  assert.equal(rankMemoryResults(records, 'concise meeting preference')[0].id, 'old-preference');
  assert.equal(rankMemoryResults(records, 'quantum banana XYZ').length, 0);
});
