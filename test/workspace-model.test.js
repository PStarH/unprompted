import test from 'node:test';
import assert from 'node:assert/strict';
import { taskState, taskSteps, recommendedMode, activityEntries, nextQueueId } from '../public/workspace-model.js';

test('local draft acceptance is distinct from provider verification and pending preparation is visible', () => {
  const accepted = { status: 'completed', completion: { kind: 'user_accepted_preparation', external: false } };
  assert.equal(taskState(accepted), 'user_accepted');
  assert.deepEqual(taskSteps(accepted).map(step => step.key), ['source', 'prepare', 'reviewed']);
  assert.deepEqual(taskSteps({ preparedWork: { requiresReview: true } }).at(-1), { key: 'review', status: 'current' });
  assert.equal(taskState({ kind: 'standing_intent', status: 'waiting_for_information', reasoning: { status: 'pending' } }), 'working');
  assert.equal(taskState({ kind: 'standing_intent', status: 'waiting_for_information', reasoning: { status: 'failed' } }), 'failed');
  assert.equal(taskState({ kind: 'standing_intent', status: 'waiting_for_information', activationHold: { policyIds: ['rule'] }, reasoning: { status: 'running' } }), 'paused_by_policy');
});

test('provider uncertainty and a user pause remain distinct from failure and completion', () => {
  assert.equal(taskState({ status: 'blocked', action: { status: 'uncertain' } }), 'result_unverified');
  assert.equal(taskState({ status: 'blocked', action: { status: 'uncertain' }, reasoning: { status: 'failed' } }), 'failed');
  assert.equal(taskState({ status: 'waiting_for_information', control: { paused: true }, reasoning: { status: 'failed' } }), 'paused_by_user');
  assert.equal(taskState({ status: 'waiting_for_information', reasoning: { status: 'failed' } }), 'failed');
  assert.equal(taskState({ status: 'cancelled', kind: 'external_issue' }), 'closed');
  assert.equal(taskState({ status: 'waiting_for_information', sourceConnectorId: 'google' }, { google: { connected: false } }), 'source_disconnected');
});

test('the next queued item stays after the one just handled and wraps only when nothing later remains', () => {
  assert.equal(nextQueueId(['a', 'b', 'c'], ['a', 'c'], 'b'), 'c');
  assert.equal(nextQueueId(['a', 'b', 'c'], ['a', 'b'], 'c'), 'a');
  assert.equal(nextQueueId(['a'], [], 'a'), null);
  assert.equal(nextQueueId(['a', 'b'], ['a', 'b'], 'a'), 'b');
  assert.equal(nextQueueId(['a'], ['b', 'c'], 'missing'), 'b');
  assert.equal(nextQueueId(null, null, 'a'), null);
});

test('a lane suggestion needs both concurrency and a shared dependency', () => {
  const tasks = [1, 2, 3].map(id => ({ id, status: 'investigating' }));
  assert.equal(recommendedMode(tasks), null);
  tasks[0].management = { dependencies: [{ taskIds: [1, 2] }] };
  assert.equal(recommendedMode(tasks), 'lanes');
  tasks[2].control = { paused: true };
  assert.equal(recommendedMode(tasks), null);
});

test('the change feed groups repetitive assessments and retains explicit user decisions', () => {
  const history = [
    { id: 'latest', taskId: 'a', kind: 'assessment', text: 'new evidence' },
    { id: 'paused', taskId: 'a', kind: 'task_paused', text: 'paused' },
    { id: 'older', taskId: 'a', kind: 'assessment', text: 'old evidence' },
    { id: 'resume', taskId: 'a', kind: 'task_resumed', text: 'resumed' },
    { id: 'other-workspace', taskId: 'gone', kind: 'assessment' }
  ];
  assert.deepEqual(activityEntries({ tasks: [{ id: 'a' }], history }).map(entry => entry.id), ['latest', 'paused', 'resume']);
});
