import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoMemories } from '../src/demo-memories.js';

test('preview memories cannot be seeded into a non-demo workspace', () => {
  const store = { state: {}, mutate() { throw new Error('Production state must not change'); } };
  assert.equal(seedDemoMemories(store, { count: 100 }), 0);
  assert.equal(seedDemoMemories(store, { count: 101, demo: true }), 0);
});

test('100 distinct preview memories use ten scopes and preserve existing and deleted records', () => {
  const saved = { id: 'saved', text: 'Existing preference' };
  const store = { state: { taskMemories: { saved } }, mutate(change) { change(this.state); } };
  assert.equal(seedDemoMemories(store, { count: 100, demo: true }), 100);
  const memories = Object.values(store.state.taskMemories).filter(memory => memory.origin === 'demo_preview');
  assert.equal(memories.length, 100);
  assert.equal(new Set(memories.map(memory => memory.text)).size, 100);
  assert.equal(new Set(memories.map(memory => memory.scope.entity)).size, 10);
  assert.equal(memories.every(memory => memory.taskId === null), true);
  memories[0].deletedAt = new Date().toISOString();
  assert.equal(seedDemoMemories(store, { count: 100, demo: true }), 0);
  assert.ok(memories[0].deletedAt);
  assert.equal(store.state.taskMemories.saved, saved);
});
