import test from 'node:test';
import assert from 'node:assert/strict';
import { isSnoozed, taskFingerprint, workspaceSnapshot, changesSince, sortTasks, stableTaskOrder, matchesTask, readLocal, evidenceFacts, evidenceDelta, decisionQueue, decisionCursor, visibleAttentionItems } from '../public/ux-state.js';
import { copy, ui, setLocale } from '../public/i18n.js';

test('snoozing expires and fresh evidence brings a decision back immediately', () => {
  const task = { id: 'task:1', status: 'ready_for_approval', updatedAt: '2026-10-25T01:00:00Z', draft: { documentVersion: 3 } };
  const entries = { [task.id]: { until: 2000, fingerprint: taskFingerprint(task) } };
  assert.equal(isSnoozed(task, entries, 1000), true);
  assert.equal(isSnoozed(task, entries, 2000), false);
  assert.equal(isSnoozed({ ...task, updatedAt: '2026-10-25T01:05:00Z' }, entries, 1000), false);
  assert.equal(isSnoozed({ ...task, draft: { documentVersion: 4 } }, entries, 1000), false);
  assert.equal(isSnoozed(task, { [task.id]: { until: 'tomorrow' } }, 1000), false);
});

test('the return digest counts actual new work and completions without inventing saved time', () => {
  const previous = workspaceSnapshot({ tasks: [{ id: 'a', status: 'waiting_for_information' }, { id: 'b', status: 'completed' }] }, 1000);
  const changes = changesSince({ tasks: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'ready_for_approval' }] }, previous);
  assert.deepEqual(changes, { discovered: 1, completed: 1, ready: 1 });
  assert.equal(changesSince({ tasks: [] }, null), null);
  assert.deepEqual(Object.keys(previous).sort(), ['at', 'facts', 'tasks']);
});

test('a task changing state or update time does not move the other tasks', () => {
  const tasks = [{ id: 'a', createdAt: '2026-10-25T01:00:00Z', status: 'waiting_for_information' }, { id: 'b', createdAt: '2026-10-25T02:00:00Z', status: 'ready_for_approval' }];
  const before = sortTasks(tasks).map(task => task.id);
  tasks[0].status = 'ready_for_approval';
  tasks[1].updatedAt = '2026-10-25T03:00:00Z';
  assert.deepEqual(sortTasks(tasks).map(task => task.id), before);
  assert.equal(matchesTask({ sender: 'maya@example.test' }, ' MAYA '), true);
  assert.equal(matchesTask({ request: { subjectEntity: '北极星' } }, '北极星'), true);
  assert.equal(matchesTask({ subject: 'Proposal' }, 'unrelated'), false);
});

test('both languages translate authored copy while preserving interpolated source evidence', () => {
  setLocale('en');
  assert.equal(copy('工作台'), 'Overview');
  const original = '需要你 / 原始邮件内容 / Verified complete';
  assert.equal(ui`<p>需要你 ${original}</p>`, `<p>Needs you ${original}</p>`);
  setLocale('zh-CN');
  assert.equal(ui`<p>Verified complete ${original}</p>`, `<p>已核验完成 ${original}</p>`);
  assert.equal(copy('not a supported translation'), 'not a supported translation');
  assert.equal(setLocale('fr'), false);
  setLocale('en');
});

test('unavailable browser storage falls back without breaking the workspace', () => {
  assert.deepEqual(readLocal('missing', { fallback: true }), { fallback: true });
});

test('live priority changes keep familiar positions; new arrivals append without taking a reading target', () => {
  const task = (id, score) => ({ id, management: { priority: { score } } });
  const initial = stableTaskOrder([task('routine', 20), task('important', 90)]);
  assert.deepEqual(initial.map(item => item.id), ['important', 'routine']);
  const revised = stableTaskOrder([task('routine', 100), task('new', 120), task('important', 10)], initial.map(item => item.id));
  assert.deepEqual(revised.map(item => item.id), ['important', 'routine', 'new']);
  assert.equal(revised[1].management.priority.score, 100, 'positions stay familiar while their actual state updates');
  assert.deepEqual(stableTaskOrder([task('new', 120)], revised.map(item => item.id)).map(item => item.id), ['new']);
  assert.deepEqual(stableTaskOrder([task('routine', 100), task('important', 10)]).map(item => item.id), ['routine', 'important'], 'a new session starts with current priorities');
});

test('evidence changes distinguish new support from evidence that stopped satisfying a requirement', () => {
  const before = { assessment: { documentVersion: 1 }, evidence: { freshness: { status: 'verified' }, criteria: [{ id: 'a', status: 'unknown' }, { id: 'b', status: 'satisfied' }] } };
  const after = { assessment: { documentVersion: 2 }, evidence: { freshness: { status: 'stale' }, criteria: [{ id: 'a', status: 'satisfied' }, { id: 'b', status: 'unknown' }] } };
  const delta = evidenceDelta(after, evidenceFacts(before));
  assert.deepEqual(delta.gained, ['a']);
  assert.deepEqual(delta.lost, ['b']);
  assert.equal(delta.versionChanged, true);
  assert.equal(delta.freshnessChanged, true);
  assert.equal(delta.fromVersion, 1);
  assert.equal(delta.toVersion, 2);
});

test('a version-only update is not described as newly satisfied requirements', () => {
  const task = { assessment: { documentVersion: 1 }, evidence: { criteria: [{ id: 'a', status: 'satisfied' }] } };
  const before = evidenceFacts(task);
  assert.equal(evidenceDelta(task, before).hasChanges, false);
  task.assessment.documentVersion = 2;
  const delta = evidenceDelta(task, before);
  assert.equal(delta.versionChanged, true);
  assert.deepEqual(delta.changed, []);
  assert.deepEqual(delta.gained, []);
  assert.equal(evidenceDelta(task, null), null, 'a first visit never invents an evidence comparison');
});

test('review snapshots omit original excerpts and personal message content', () => {
  const task = { id: 'a', subject: 'Private subject', sender: 'private@example.test', status: 'ready_for_approval', assessment: { documentVersion: 7 }, evidence: { criteria: [{ id: 'sample_size', status: 'satisfied', evidence: [{ excerpt: 'Private original text' }] }] } };
  const serialized = JSON.stringify(workspaceSnapshot({ tasks: [task] }));
  assert.doesNotMatch(serialized, /Private|private@|excerpt|subject|sender/);
  assert.match(serialized, /sample_size/);
});

test('the decision relay retains the selected item when new work arrives', () => {
  const a = { id: 'a', status: 'ready_for_approval' };
  const b = { id: 'b', status: 'ready_for_approval' };
  const queue = decisionQueue([a, b], [{ id: 'risk', priority: 'high' }]);
  assert.equal(queue[0].key, 'notice:risk', 'urgent decisions appear before routine replies');
  assert.equal(decisionCursor(queue, 'task:b', 1), 'task:b');
  assert.equal(decisionCursor(decisionQueue([a]), 'task:b', 1), 'task:a');
  assert.equal(decisionCursor([], 'task:b', 1), null);
});

test('task order follows the explainable priority score while the selected decision stays stable', () => {
  const routine = { id: 'routine', status: 'ready_for_approval', createdAt: '2026-10-25T01:00:00Z', management: { priority: { score: 35 } } };
  const urgent = { id: 'urgent', status: 'ready_for_approval', createdAt: '2026-10-25T02:00:00Z', management: { priority: { score: 90 } } };
  assert.deepEqual(sortTasks([routine, urgent]).map(task => task.id), ['urgent', 'routine']);
  const before = decisionQueue([routine, urgent]);
  assert.equal(before[0].key, 'task:urgent');
  const after = decisionQueue([routine, urgent, { id: 'new', status: 'ready_for_approval', management: { priority: { score: 100 } } }]);
  assert.equal(decisionCursor(after, 'task:routine', 0), 'task:routine', 'the current item remains selected after a higher priority item arrives');
});

test('completed, closed and still-waiting tasks never become actionable relay cards', () => {
  const queue = decisionQueue([{ id: 'a', status: 'completed' }, { id: 'b', status: 'cancelled' }, { id: 'c', status: 'waiting_for_information' }, { id: 'd', status: 'blocked' }, { id: 'e', status: 'blocked', action: { status: 'unknown' } }]);
  assert.deepEqual(queue.map(item => item.key), ['task:e']);
});

test('a shared open dependency replaces duplicate stalled prompts without hiding risk or deadline notices', () => {
  const dependency = { id: 'dep:1', status: 'open', taskIds: ['a', 'b'] };
  const state = {
    tasks: [
      { id: 'a', status: 'waiting_for_information', management: { dependencies: [dependency] } },
      { id: 'b', status: 'waiting_for_information', management: { dependencies: [dependency] } }
    ],
    notifications: [
      { id: 'stall-a', kind: 'blocker', dedupeKey: 'stalled:a', taskId: 'a', priority: 'normal' },
      { id: 'stall-b', kind: 'blocker', dedupeKey: 'stalled:b', taskId: 'b', priority: 'normal' },
      { id: 'deadline-a', kind: 'deadline', dedupeKey: 'deadline:a', taskId: 'a', priority: 'high' },
      { id: 'risk-b', kind: 'risk', dedupeKey: 'risk:b', taskId: 'b', priority: 'high' }
    ]
  };
  assert.deepEqual(visibleAttentionItems(state).map(item => item.id), ['deadline-a', 'risk-b']);
  assert.equal(decisionQueue([], visibleAttentionItems(state)).length, 2, 'the relay sees the same de-duplicated projection');
});
