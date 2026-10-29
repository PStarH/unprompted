import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { effectiveTaskRequest } from '../src/task-guidance.js';
import { requestSignature } from '../src/document-delivery.js';

const content = '# Northstar project proposal\n\nExperiment results\nRun date: 2026-10-16\nSample size: 1200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.';
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-guidance-'));
  const store = new JsonStore(path.join(root, 'state.json'));
  const engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  engine.ingest({ id: 'email-1', type: 'email.received', payload: { id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal', body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.' } });
  engine.ingest({ id: 'doc-1', type: 'document.modified', payload: { id: 'northstar', kind: 'proposal', title: 'Northstar project proposal', content } });
  return { root, store, engine, task: () => store.state.tasks['request:m1'], close: async () => { await engine.whenSettled(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('pause is durable, blocks direct execution, and rechecks newer evidence on resume', async () => {
  const env = setup();
  try {
    const { engine, store, task } = env;
    assert.equal(task().status, 'ready_for_approval');
    engine.setTaskPaused(task().id, true);
    const draft = structuredClone(task().draft);
    engine.ingest({ id: 'doc-2', type: 'document.modified', payload: { id: 'northstar', kind: 'proposal', title: 'Northstar project proposal', content: '# Northstar project proposal\nMissing required results' } });
    assert.deepEqual(task().draft, draft);
    assert.throws(() => engine.approve(task().id), /paused/);
    assert.throws(() => engine.executePreAuthorized(task().id), /paused/);
    assert.throws(() => engine.execute(task().id), /paused/);
    engine.restorePendingWork();
    assert.equal(task().control.paused, true);
    engine.setTaskPaused(task().id, false);
    assert.equal(task().status, 'waiting_for_information');
    assert.equal(task().draft, null);
    assert.equal(store.state.outbox.length, 0);
  } finally { await env.close(); }
});

test('task direction changes the verification plan, invalidates the draft, and undo rechecks without sending', async () => {
  const env = setup();
  try {
    const { engine, store, task } = env;
    const oldToken = engine.publicState().tasks[0].reviewToken;
    const oldPatchSignature = requestSignature(task());
    const direction = engine.directTask(task().id, { text: 'Include a budget breakdown.', scope: 'task' });
    assert.equal(task().status, 'waiting_for_information');
    assert.ok(task().evidence.criteria.some(item => /budget/i.test(item.label)));
    assert.equal(task().draft, null);
    assert.notEqual(requestSignature(task()), oldPatchSignature, 'old document patches cannot survive a direction change');
    assert.equal(engine.publicState().taskMemories.length, 0);
    assert.throws(() => engine.approve(task().id, { reviewToken: oldToken }), /not ready/);
    engine.undoTaskDirection(task().id, direction.id);
    assert.equal(task().status, 'ready_for_approval');
    assert.equal(task().guidance, null);
    assert.equal(store.state.outbox.length, 0);
  } finally { await env.close(); }
});

test('saving scoped memory invalidates existing peer drafts without affecting a different project', async () => {
  const env = setup();
  try {
    const { engine, store, task } = env;
    store.mutate(state => {
      state.tasks.peer = { ...structuredClone(task()), id: 'peer', sourceEmailId: 'peer-source' };
      state.tasks.unrelated = { ...structuredClone(task()), id: 'unrelated', sourceEmailId: 'other-source' };
      state.tasks.unrelated.request.subjectEntity = 'Another project';
    });
    engine.directTask(task().id, { text: 'Include a budget breakdown.', scope: 'similar' });
    assert.equal(store.state.tasks.peer.draft, null);
    assert.equal(store.state.tasks.peer.status, 'waiting_for_information');
    assert.equal(store.state.tasks.peer.guidanceReviewRequired, true);
    assert.ok(store.state.tasks.unrelated.draft);
    assert.equal(store.state.outbox.length, 0);
  } finally { await env.close(); }
});

test('similar-task memory has exact scope and supports versioned edit, delete, and restore', async () => {
  const env = setup();
  try {
    const { engine, store, task } = env;
    const direction = engine.directTask(task().id, { text: 'Include a budget breakdown.', scope: 'similar' });
    let memory = engine.publicState().taskMemories[0];
    assert.equal(memory.id, direction.memoryId);
    const other = structuredClone(task()); other.id = 'other'; other.guidance = null;
    assert.ok(effectiveTaskRequest(other, store.state).requiredContent.some(item => /budget/.test(item.text)));
    other.guidance = { text: 'Include signed customer feedback.' };
    assert.ok(!effectiveTaskRequest(other, store.state).requiredContent.some(item => /budget/.test(item.text)), 'an explicit task direction overrides shared preferences');
    assert.ok(effectiveTaskRequest(other, store.state).requiredContent.some(item => /signed/.test(item.text)));
    other.guidance = null;
    other.request.subjectEntity = 'Different project';
    assert.ok(!effectiveTaskRequest(other, store.state).requiredContent.some(item => /budget/.test(item.text)));
    assert.throws(() => engine.updateTaskMemory(memory.id, { operation: 'delete', version: 'stale' }), /changed/);
    engine.updateTaskMemory(memory.id, { operation: 'edit', text: 'Include signed customer feedback.', version: memory.updatedAt });
    memory = engine.publicState().taskMemories[0];
    assert.match(memory.text, /signed/);
    engine.updateTaskMemory(memory.id, { operation: 'delete', version: memory.updatedAt });
    memory = engine.publicState().taskMemories[0];
    assert.ok(memory.deletedAt);
    engine.updateTaskMemory(memory.id, { operation: 'restore', version: memory.updatedAt });
    assert.equal(engine.publicState().taskMemories[0].deletedAt, null);
    assert.equal(store.state.outbox.length, 0);
  } finally { await env.close(); }
});

test('a changed direction cannot use standing authorization or undo a completed action', async () => {
  const env = setup();
  try {
    const { engine, task, store } = env;
    const direction = engine.directTask(task().id, { text: 'Include experiment results.', scope: 'task' });
    assert.equal(task().status, 'ready_for_approval');
    engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: task().request.subjectEntity, deliverable: task().request.deliverable } });
    assert.throws(() => engine.executePreAuthorized(task().id), /corrected/);
    engine.approve(task().id);
    assert.equal(store.state.outbox.length, 1);
    assert.throws(() => engine.undoTaskDirection(task().id, direction.id), /already started|closed/);
    assert.equal(store.state.outbox.length, 1);
  } finally { await env.close(); }
});
