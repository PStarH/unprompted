import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import {
  aggregateTaskDependencies, projectTaskManagement, projectWorkspaceTaskManagement
} from '../src/task-management.js';

const NOW = '2026-10-26T12:00:00.000Z';

function workspaceState() {
  const task = (id, { status = 'waiting_for_information', documentId = 'doc-a', deadline = '2026-11-02', dismissed = false } = {}) => ({
    id,
    status,
    userDismissed: dismissed,
    request: {
      subjectEntity: 'Northstar', deliverable: 'proposal', deadline: { iso: deadline },
      source: { kind: 'email', id: `message-${id}`, threadId: `thread-${id}` }
    },
    sourceEmailId: `message-${id}`,
    documentId,
    createdAt: '2026-10-20T00:00:00.000Z',
    progress: { at: '2026-10-25T00:00:00.000Z' },
    assessment: { missing: ['Sample size'] },
    evidence: { conflicts: [], criteria: [{
      id: 'sample_size', label: 'Sample size', required: true, status: 'not_satisfied',
      evidence: [{ source: { kind: 'document', id: documentId } }]
    }] }
  });
  return {
    tasks: {
      a: task('a'),
      b: task('b'),
      separateDocument: task('separateDocument', { documentId: 'doc-b' }),
      separateDeadline: task('separateDeadline', { deadline: '2026-11-03' }),
      dismissed: task('dismissed', { dismissed: true }),
      completed: task('completed', { status: 'completed' }),
      cancelled: task('cancelled', { status: 'cancelled' }),
      failed: task('failed', { status: 'failed' })
    },
    documents: {
      'doc-a': { id: 'doc-a', title: 'Northstar proposal' },
      'doc-b': { id: 'doc-b', title: 'Northstar archive proposal' }
    },
    taskWaits: {
      b: { id: 'wait-b', taskId: 'b', kind: 'reply', status: 'active', condition: { threadId: 'thread-b' } }
    },
    dependencyDecisions: {}
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

test('workspace batch projections equal the single-task reference and leave frozen state untouched', () => {
  const input = workspaceState();
  const sharedDependency = aggregateTaskDependencies(input, NOW).find(item => item.taskIds.includes('a') && item.taskIds.includes('b'));
  input.dependencyDecisions[sharedDependency.id] = {
    id: sharedDependency.id, decision: 'provided', status: 'answered_needs_recheck',
    taskIds: ['a', 'b'], criterionIds: ['sample_size'], value: 'Run registry R-24'
  };
  const state = deepFreeze(input);
  const tasks = Object.values(state.tasks);
  const before = JSON.stringify(state);
  const expected = new Map(tasks.map(task => [task.id, projectTaskManagement(task, state, NOW)]));
  const actual = projectWorkspaceTaskManagement(tasks, state, NOW);

  assert.equal(actual.size, tasks.length);
  for (const task of tasks) assert.deepEqual(actual.get(task.id), expected.get(task.id), task.id);
  actual.get('a').dependencies[0].source.id = 'view-only-edit';
  actual.get('a').dependencies[0].decision.taskIds.push('view-only-edit');
  assert.equal(JSON.stringify(state), before, 'projection must not write derived fields into the workspace');
});

test('shared dependencies are identical across members and exclude closed, failed and dismissed work', () => {
  const state = workspaceState();
  const tasks = Object.values(state.tasks);
  const projected = projectWorkspaceTaskManagement(tasks, state, NOW);
  const shared = projected.get('a').dependencies.find(item => item.taskIds.includes('b'));

  assert.ok(shared);
  assert.deepEqual(projected.get('b').dependencies.find(item => item.id === shared.id), shared);
  assert.deepEqual(shared.taskIds, ['a', 'b']);
  assert.equal(projected.get('separateDocument').dependencies.some(item => item.id === shared.id), false);
  assert.equal(projected.get('separateDeadline').dependencies.some(item => item.id === shared.id), false);
  for (const id of ['dismissed', 'completed', 'cancelled', 'failed']) {
    assert.deepEqual(projected.get(id).dependencies, [], `${id} must not contribute an active dependency`);
  }
  assert.equal(projected.get('completed').nextAction.kind, 'done');
  assert.equal(projected.get('cancelled').nextAction.kind, 'closed');
  assert.equal(projected.get('failed').nextAction.kind, 'assess');
  assert.equal(projected.get('failed').priority.level, 'normal');
  assert.deepEqual(aggregateTaskDependencies(state, NOW).map(item => item.id).sort(),
    [...new Set(tasks.filter(task => !['completed', 'cancelled', 'failed'].includes(task.status) && !task.userDismissed)
      .flatMap(task => projected.get(task.id).dependencies.map(item => item.id)))].sort());
});

test('publicState keeps its task shape while projecting management for closed records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-workspace-view-'));
  const store = new JsonStore(path.join(root, 'state.json'));
  const state = workspaceState();
  store.mutate(current => {
    current.tasks.completed = state.tasks.completed;
    current.tasks.cancelled = state.tasks.cancelled;
  });
  const engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  try {
    const before = JSON.stringify(store.state);
    const view = engine.publicState();
    assert.deepEqual(view.tasks.map(task => task.id), ['completed', 'cancelled']);
    assert.deepEqual(Object.keys(view.tasks[0].management), ['owner', 'nextAction', 'dependencies', 'wake', 'priority']);
    assert.equal(view.tasks[0].management.nextAction.kind, 'done');
    assert.equal(view.tasks[1].management.nextAction.kind, 'closed');
    assert.equal(JSON.stringify(store.state), before, 'publicState does not persist projection fields');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
