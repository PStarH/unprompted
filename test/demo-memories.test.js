import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDemoMemoryRecords,
  DEMO_MEMORY_COUNTS,
  DEMO_MEMORY_EPOCH,
  DEMO_MEMORY_LIMIT,
  DEMO_MEMORY_ORIGIN,
  DEMO_MEMORY_PREFIX,
  seedDemoMemories
} from '../src/demo-memories.js';
import {
  createMemorySpaceFixture,
  createSeededMemoryStore,
  EXPERIENCE_ID_PREFIX,
  MEMORY_DESCRIPTORS,
  MEMORY_ID_PREFIX,
  MEMORY_RELATION_TYPES,
  MEMORY_SPACE_COUNTS,
  MEMORY_SPACE_NOW,
  MEMORY_STATES,
  POLICY_ID_PREFIX
} from './fixtures/memory-space.js';
import { DEMO_USAGE, parseDemoArgs } from '../scripts/demo.mjs';

const at = hours => new Date(Date.parse(DEMO_MEMORY_EPOCH) - hours * 3_600_000).toISOString();

test('preview memories never seed a non-demo workspace or an invalid count', () => {
  const store = { state: {}, mutate() { throw new Error('Production state must not change'); } };
  assert.equal(seedDemoMemories(store, { count: 100 }), 0);
  assert.equal(seedDemoMemories(store, { count: 0, demo: true }), 0);
  assert.equal(seedDemoMemories(store, { count: -1, demo: true }), 0);
  assert.equal(seedDemoMemories(store, { count: 1.5, demo: true }), 0);
  assert.equal(seedDemoMemories(store, { count: DEMO_MEMORY_LIMIT + 1, demo: true }), 0);
});

test('the original 100 records keep their ids, texts, scopes and demo markers', () => {
  const { store, seeded, memories } = createSeededMemoryStore(100);
  assert.equal(seeded, 100);
  assert.equal(memories.length, 100);
  assert.deepEqual(DEMO_MEMORY_COUNTS, [100, 250, 500]);
  assert.equal(memories[0].id, 'demo-memory-001');
  assert.equal(memories[0].text, '先写结论，再补充支持结论的依据。');
  assert.equal(memories.at(-1).id, 'demo-memory-100');
  assert.equal(memories.at(-1).text, '无法确认结果时保留待核实状态。');
  assert.equal(new Set(memories.map(memory => memory.text)).size, 100);
  assert.equal(new Set(memories.map(memory => memory.scope.entity)).size, 10);
  assert.deepEqual(memories[0].scope, { entity: '写作与沟通', deliverable: '邮件与文稿' });
  assert.equal(memories.every(memory => memory.origin === DEMO_MEMORY_ORIGIN), true);
  assert.equal(memories.every(memory => memory.taskId === null), true);
  assert.equal(memories.every(memory => memory.deletedAt === null), true);
  assert.equal(store.state.taskMemories['demo-memory-001'].createdAt, DEMO_MEMORY_EPOCH);
  assert.equal(store.state.taskMemories['demo-memory-100'].updatedAt, at(99));
});

test('250 and 500 extend the catalog deterministically without rewriting the first 100', () => {
  const hundred = createSeededMemoryStore(100).store.state.taskMemories;
  const store = { state: { taskMemories: structuredClone(hundred) }, mutate(change) { change(this.state); } };
  assert.equal(seedDemoMemories(store, { count: 500, demo: true }), 400);
  const memories = Object.values(store.state.taskMemories);
  assert.equal(memories.length, 500);
  assert.equal(new Set(memories.map(memory => memory.id)).size, 500);
  assert.equal(memories.every(memory => memory.id.startsWith(DEMO_MEMORY_PREFIX)), true);
  assert.equal(memories.every(memory => memory.taskId === null), true);
  assert.equal(memories.every(memory => memory.origin === DEMO_MEMORY_ORIGIN), true);
  for (const memory of Object.values(hundred)) assert.deepEqual(store.state.taskMemories[memory.id], memory);

  const again = createSeededMemoryStore(250).store.state.taskMemories;
  assert.equal(Object.keys(again).length, 250);
  assert.deepEqual(Object.values(again)[100].id, 'demo-memory-101');
  assert.equal(Object.values(again).at(-1).id, 'demo-memory-250');
  assert.deepEqual(createDemoMemoryRecords(500), createDemoMemoryRecords(500));
  assert.deepEqual(createDemoMemoryRecords(250), createDemoMemoryRecords(500).slice(0, 250));
  assert.throws(() => createDemoMemoryRecords(501), RangeError);
  assert.throws(() => createDemoMemoryRecords(-1), RangeError);
  assert.throws(() => createDemoMemoryRecords(1.5), RangeError);
});

test('seeding is idempotent and preserves deleted and user records', () => {
  const { store, memories } = createSeededMemoryStore(250);
  const deletedSample = store.state.taskMemories['demo-memory-116'];
  assert.ok(deletedSample.deletedAt);
  const snapshot = structuredClone(store.state.taskMemories);
  assert.equal(seedDemoMemories(store, { count: 250, demo: true }), 0);
  assert.deepEqual(store.state.taskMemories, snapshot);

  const userDeletedAt = at(120);
  store.mutate(state => { state.taskMemories['demo-memory-001'].deletedAt = userDeletedAt; });
  store.state.taskMemories.saved = { id: 'saved', text: 'Existing preference' };
  assert.equal(seedDemoMemories(store, { count: 250, demo: true }), 0);
  assert.equal(store.state.taskMemories['demo-memory-001'].deletedAt, userDeletedAt);
  assert.equal(store.state.taskMemories.saved.text, 'Existing preference');
  assert.equal(store.state.taskMemories['demo-memory-116'].deletedAt, deletedSample.deletedAt);
  assert.equal(memories.length, 250);
});

test('the fixture accepts exactly 100, 250 and 500', () => {
  assert.deepEqual(MEMORY_SPACE_COUNTS, [100, 250, 500]);
  for (const count of MEMORY_SPACE_COUNTS) {
    const fixture = createMemorySpaceFixture(count);
    assert.equal(fixture.count, count);
    assert.equal(fixture.now, MEMORY_SPACE_NOW);
    assert.equal(fixture.memories.length, count);
    assert.equal(fixture.memories[0].id, `${MEMORY_ID_PREFIX}001`);
    assert.equal(fixture.memories.at(-1).id, `${MEMORY_ID_PREFIX}${String(count).padStart(3, '0')}`);
    assert.equal(new Set(fixture.memories.map(memory => memory.id)).size, count);
    assert.equal(fixture.experiences.length, Math.max(2, Math.round(count / 50)));
    assert.equal(fixture.policies.length, Math.max(2, Math.round(count / 50)));
    assert.equal(fixture.memories.every(memory => memory.id.startsWith(MEMORY_ID_PREFIX)), true);
    assert.equal(fixture.experiences.every(experience => experience.id.startsWith(EXPERIENCE_ID_PREFIX)), true);
    assert.equal(fixture.policies.every(policy => policy.id.startsWith(POLICY_ID_PREFIX)), true);
  }
  for (const invalid of [0, 99, 101, 249, 250.5, 499, 501, '100', null, undefined]) {
    assert.throws(() => createMemorySpaceFixture(invalid), RangeError, String(invalid));
  }
});

test('fixture ids, timestamps and content are deterministic and fixed-clock', () => {
  assert.deepEqual(createMemorySpaceFixture(500), createMemorySpaceFixture(500));
  const hundred = createMemorySpaceFixture(100);
  const fiveHundred = createMemorySpaceFixture(500);
  assert.deepEqual(hundred.memories, fiveHundred.memories.slice(0, 100));
  assert.equal(fiveHundred.memories[0].createdAt, DEMO_MEMORY_EPOCH);
  assert.equal(fiveHundred.memories[99].updatedAt, at(99));
  assert.equal(fiveHundred.indexes.memoryById['mem-101'].text, '团队默认先确认目标，再开始整理材料。');
  assert.equal(fiveHundred.indexes.memoryById['mem-102'].createdAt, '2022-03-15T08:30:00.000Z');
  assert.equal(fiveHundred.indexes.memoryById['mem-141'].text, '先确认负责人和截止时间，再开始处理（接口设计）。');
  assert.equal(fiveHundred.memories.every(memory => Number.isFinite(Date.parse(memory.createdAt))), true);
  assert.equal(fiveHundred.memories.every(memory => memory.taskId === null), true);
  assert.equal(fiveHundred.memories.every(memory => memory.origin === DEMO_MEMORY_ORIGIN), true);

  // Even the compatibility baseline carries representative descriptors,
  // contexts and an explicit relation without changing the original texts.
  assert.deepEqual(new Set(hundred.memories.map(memory => memory.descriptor)), new Set(MEMORY_DESCRIPTORS));
  assert.equal(hundred.memories.some(memory => memory.memoryType === 'fact' && memory.descriptor === 'direct'), true);
  assert.equal(hundred.memories.some(memory => memory.memoryType === 'preference' && memory.descriptor === 'direct'), true);
  assert.equal(hundred.memories.some(memory => memory.descriptor === 'legacy_scoped'), true);
  assert.deepEqual(new Set(hundred.memories.flatMap(memory => memory.contexts.map(context => context.type))), new Set(['project', 'entity', 'global']));
  assert.ok(hundred.memories.some(memory => memory.contexts.length > 1));
  assert.ok(hundred.memories.some(memory => memory.relations.length > 0));
  for (const memory of hundred.memories) {
    for (const relation of memory.relations) assert.ok(hundred.indexes.memoryById[relation.targetId], `${memory.id} relation target`);
    if (memory.supersededBy) assert.ok(hundred.indexes.memoryById[memory.supersededBy]);
    for (const id of memory.supersedes) assert.ok(hundred.indexes.memoryById[id]);
  }
  const hundredContexts = {};
  for (const memory of hundred.memories) for (const context of memory.contexts) hundredContexts[context.key] = (hundredContexts[context.key] || 0) + 1;
  assert.ok(Object.values(hundredContexts).some(total => total > 1), 'overlapping contexts');
});

test('the fixture represents descriptors, scopes, relations and lifecycle states', () => {
  const fixture = createMemorySpaceFixture(250);
  const memories = fixture.memories;
  const byId = fixture.indexes.memoryById;

  assert.deepEqual(new Set(memories.map(memory => memory.descriptor)), new Set(MEMORY_DESCRIPTORS));
  assert.equal(memories.some(memory => memory.memoryType === 'fact'), true);
  assert.equal(memories.some(memory => memory.memoryType === 'preference'), true);
  assert.equal(memories.some(memory => memory.descriptor === 'legacy_scoped' && memory.legacy), true);
  assert.deepEqual(new Set(memories.map(memory => memory.status)), new Set(MEMORY_STATES));
  for (const state of ['disabled', 'archived', 'deleted', 'expired', 'superseded']) {
    assert.equal(memories.some(memory => memory.status === state), true, state);
  }

  assert.equal(memories.some(memory => memory.scope.type === 'project'), true);
  assert.equal(memories.some(memory => memory.scope.type === 'entity'), true);
  assert.equal(memories.some(memory => memory.scope.type === 'global'), true);
  const contextTypes = new Set(memories.flatMap(memory => memory.contexts.map(context => context.type)));
  assert.deepEqual(contextTypes, new Set(['project', 'entity', 'global']));
  assert.ok(memories.filter(memory => memory.contexts.length > 1).length > 0);
  const contextCounts = {};
  for (const memory of memories) for (const context of memory.contexts) contextCounts[context.key] = (contextCounts[context.key] || 0) + 1;
  assert.ok(Object.values(contextCounts).some(total => total > 1), 'overlapping contexts');

  const relationTypes = new Set(memories.flatMap(memory => memory.relations.map(relation => relation.type)));
  assert.deepEqual(relationTypes, new Set(MEMORY_RELATION_TYPES));
  for (const memory of memories) {
    for (const relation of memory.relations) {
      assert.ok(byId[relation.targetId], `${memory.id} relation target`);
      assert.notEqual(relation.targetId, memory.id);
    }
  }

  const old = byId['mem-109'], middle = byId['mem-110'], current = byId['mem-111'];
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, middle.id);
  assert.equal(middle.status, 'superseded');
  assert.equal(middle.supersededBy, current.id);
  assert.equal(current.status, 'active');
  assert.deepEqual(current.supersedes, [middle.id]);
  assert.deepEqual(middle.supersedes, [old.id]);

  const sourceGroups = {};
  for (const memory of memories) if (memory.source) (sourceGroups[memory.source.id] ||= []).push(memory);
  assert.ok(sourceGroups['fixture-shared-source'].length >= 2);
  assert.ok(sourceGroups['fixture-shared-task'].length >= 2);
  assert.equal(sourceGroups['fixture-shared-task'].every(memory => memory.source.kind === 'task'), true);
  assert.equal(memories.filter(memory => memory.lineage?.verified === true).length >= 2, true);
  assert.equal(memories.some(memory => memory.lineage?.verifiedAt), true);

  assert.equal(memories.some(memory => memory.validUntil && Date.parse(memory.validUntil) < Date.parse(MEMORY_SPACE_NOW)), true);
  assert.equal(memories.some(memory => memory.validUntil && Date.parse(memory.validUntil) > Date.parse(MEMORY_SPACE_NOW)), true);
  assert.equal(memories.some(memory => memory.status === 'active' && memory.memoryType === 'preference' && Date.parse(memory.createdAt) < Date.parse('2024-01-01T00:00:00.000Z')), true);
  assert.equal(memories.some(memory => memory.relations.length === 0 && !memory.source && !memory.lineage && !memory.supersedes.length && !memory.supersededBy), true);

  const textGroups = {};
  for (const memory of memories) (textGroups[memory.text] ||= []).push(memory);
  const duplicateGroups = Object.values(textGroups).filter(group => group.length > 1);
  assert.ok(duplicateGroups.length >= 2);
  for (const group of duplicateGroups) {
    for (const left of group) for (const right of group) {
      if (left === right) continue;
      assert.equal(left.relations.some(relation => relation.targetId === right.id), false, `${left.id} -> ${right.id} must stay implicit`);
      assert.notEqual(left.supersededBy, right.id);
      assert.equal(left.supersedes.includes(right.id), false);
    }
  }
});

test('Experience and Policy descriptors stay separate from memories', () => {
  const fixture = createMemorySpaceFixture(500);
  const memoryIds = new Set(fixture.memories.map(memory => memory.id));
  const experienceIds = new Set(fixture.experiences.map(experience => experience.id));
  const policyIds = new Set(fixture.policies.map(policy => policy.id));
  assert.equal(experienceIds.size, fixture.experiences.length);
  assert.equal(policyIds.size, fixture.policies.length);
  assert.equal(fixture.experiences.every(experience => experience.kind === 'experience'), true);
  assert.equal(fixture.policies.every(policy => policy.kind === 'policy'), true);
  for (const id of experienceIds) assert.equal(memoryIds.has(id), false);
  for (const id of policyIds) assert.equal(memoryIds.has(id), false);
  assert.equal(fixture.memories.every(memory => !['experience', 'policy'].includes(memory.kind)), true);
  assert.equal(fixture.experiences.some(experience => experience.status === 'retired'), true);
  assert.equal(fixture.policies.some(policy => policy.status === 'disabled'), true);
  assert.deepEqual(fixture.summary.statuses, { active: 490, superseded: 3, expired: 1, disabled: 2, archived: 2, deleted: 2 });
  assert.equal(fixture.summary.memories, 500);
  assert.equal(fixture.summary.experiences, 10);
  assert.equal(fixture.summary.policies, 10);
  assert.equal(fixture.summary.duplicateTextGroups, 3);
  assert.equal(fixture.summary.relationTypes.contradicts, 3);
  assert.equal(fixture.summary.relationTypes.related_to, 3);
});

test('the demo CLI accepts 0..500 and rejects larger or malformed counts', () => {
  assert.match(DEMO_USAGE, /--memories 0\.\.500/);
  assert.doesNotMatch(DEMO_USAGE, /0\.\.100/);
  assert.equal(parseDemoArgs([], { env: {}, isTTY: false }).memoryCount, 0);
  assert.equal(parseDemoArgs(['--memories', '0'], { env: {}, isTTY: false }).memoryCount, 0);
  assert.equal(parseDemoArgs(['--memories', '250'], { env: {}, isTTY: false }).memoryCount, 250);
  assert.equal(parseDemoArgs(['--memories', '500'], { env: {}, isTTY: false }).memoryCount, 500);
  for (const invalid of ['501', '-1', '1.5', '250.0', 'abc', '']) {
    assert.throws(() => parseDemoArgs(['--memories', invalid], { env: {}, isTTY: false }), /Usage:/, invalid);
  }
  assert.throws(() => parseDemoArgs(['--memories'], { env: {}, isTTY: false }), /Usage:/);
  const help = parseDemoArgs(['--help'], { env: {}, isTTY: false });
  assert.equal(help.help, true);
  const fromEnv = parseDemoArgs([], { env: { PORT: '5123' }, isTTY: false });
  assert.equal(fromEnv.requested, '5123');
  assert.equal(fromEnv.strict, true);
  assert.throws(() => parseDemoArgs([], { env: { PORT: '70000' }, isTTY: false }), /between 1 and 65535/);
});
