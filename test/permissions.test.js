import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { PermissionPolicy, PermissionDeniedError } from '../src/permissions.js';
import { PERMISSION_KEYS } from '../src/calibration.js';

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-perm-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider });
  engine.ingest({ id: 'e-email', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  } });
  engine.ingest({ id: 'e-doc', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  } });
  return { store, provider, engine };
}

test('the default policy requires approval for consequential actions only', () => {
  const policy = new PermissionPolicy();
  assert.equal(policy.requiresApproval('observe'), false);
  assert.equal(policy.requiresApproval('prepare'), false);
  assert.equal(policy.requiresApproval('execute_external'), true);
  const described = policy.describe();
  assert.equal(described.find(item => item.actionClass === 'execute_external').reversible, false);
});

test('the policy rejects an unknown action class rather than defaulting to allow', () => {
  const policy = new PermissionPolicy();
  assert.throws(() => policy.authorize({ actionClass: 'delete_everything' }), PermissionDeniedError);
});

test('executing an approved action directly without approval is refused', () => {
  const { engine, store } = setup();
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  // Simulate a caller trying to skip the approval step entirely.
  assert.throws(() => engine.execute(taskId), /has no approval/);
  assert.equal(store.state.outbox.length, 0);
});

test('an action marked as self-authorised cannot execute', () => {
  const { engine, store } = setup();
  const taskId = 'request:m1';
  store.mutate(state => {
    state.tasks[taskId].status = 'verifying';
    state.tasks[taskId].action = {
      id: 'send:bypass:1', idempotencyKey: 'send:bypass:1',
      actionClass: 'execute_external', permission: 'auto', status: 'executing'
    };
  });
  assert.throws(() => engine.execute(taskId), /requires explicit user approval/);
  assert.equal(store.state.outbox.length, 0);
});

test('an approval granted for a different task cannot be reused', () => {
  const { engine, store } = setup();
  const taskId = 'request:m1';
  store.mutate(state => {
    state.tasks[taskId].status = 'verifying';
    state.tasks[taskId].action = {
      id: 'send:other:1', idempotencyKey: 'send:other:1',
      actionClass: 'execute_external', permission: 'user_approved', taskId: 'request:other', status: 'executing'
    };
  });
  assert.throws(() => engine.execute(taskId), /different task/);
  assert.equal(store.state.outbox.length, 0);
});

test('rejecting a draft leaves the task blocked and unsendable', () => {
  const { engine, store } = setup();
  engine.reject('request:m1');
  assert.equal(store.state.tasks['request:m1'].status, 'blocked');
  assert.throws(() => engine.approve('request:m1'), /not ready/);
  assert.equal(store.state.outbox.length, 0);
});

test('a prepared draft is never sent by the act of preparing it', () => {
  const { store } = setup();
  assert.equal(store.state.outbox.length, 0);
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.ok(store.state.tasks['request:m1'].draft.body.length > 0);
});

// ------------------------------------------------------------------ scoped authorization
// A previously authorised, clearly scoped repeated process may run without a
// fresh click. Without that authorisation nothing changes, and the authorisation
// itself is enforced in the execution path, not in the interface.

function scopedSetup(entity = 'Northstar') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-perm-scope-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider });
  engine.ingest({ id: 'e-email', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: `${entity} proposal — experiment results`,
    body: `Please update the ${entity} project proposal with the latest experiment results and send the revised proposal by Friday.`
  } });
  return { store, provider, engine, entity };
}
const scopedDoc = entity => ({ id: 'e-doc', type: 'document.modified', payload: {
  id: `${entity.toLowerCase()}-proposal`, kind: 'proposal', title: `${entity} project proposal`,
  content: `# ${entity} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n`
} });

test('a stated, scoped authorisation lets the repeated flow run, and the result is still verified', async () => {
  const { store, engine, entity } = scopedSetup();
  engine.recordCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity } });
  engine.ingest(scopedDoc(entity));
  await engine.whenSettled();

  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'completed');
  assert.equal(task.action.permission, 'pre_authorized');
  assert.equal(task.action.status, 'verified_simulated', 'an autonomous action is verified like any other');
  assert.equal(store.state.outbox.length, 1);
  assert.ok(store.state.history.some(item => item.kind === 'pre_authorized'));
});

test('without an authorisation, nothing is sent autonomously', () => {
  const { store, engine, entity } = scopedSetup();
  engine.ingest(scopedDoc(entity));
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0, 'a prepared draft still waits for the user');
  assert.throws(() => engine.executePreAuthorized('request:m1'), /No pre-authorisation covers/);
});

test('an authorisation for one scope does not cover a different entity', () => {
  const { store, engine } = scopedSetup('Helios');
  engine.recordCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  engine.ingest(scopedDoc('Helios'));
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  assert.throws(() => engine.executePreAuthorized('request:m1'), /No pre-authorisation covers/);
  assert.equal(store.state.outbox.length, 0);
});

test('the policy refuses a pre-authorisation that was not stated or left unnamed', () => {
  const policy = new PermissionPolicy();
  assert.throws(() => policy.authorize({
    actionClass: 'execute_external', approval: { permission: 'pre_authorized', source: 'inferred', scope: { entity: 'X' } }, taskId: 't'
  }), /stated by the user/);
  assert.throws(() => policy.authorize({
    actionClass: 'execute_external', approval: { permission: 'pre_authorized', source: 'user_stated', scope: {} }, taskId: 't'
  }), /named target/);
  const allowed = policy.authorize({
    actionClass: 'execute_external', approval: { permission: 'pre_authorized', source: 'user_stated', scope: { entity: 'X' } }, taskId: 't'
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.preAuthorized, true);
});

// ------------------------------------------- permission question lifecycle

function repeatedFlowSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-perm-stop-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider });
  engine.ingest({ id: 'e-email-a', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  } });
  engine.ingest({ id: 'e-email-b', type: 'email.received', payload: {
    id: 'm2', from: 'alex@example.test', subject: 'Northstar report — experiment results',
    body: 'Please update the Northstar report with the latest experiment results and send it by Friday.'
  } });
  return { store, engine };
}

test('declining the standing question stops it being asked again', () => {
  const { store, engine } = repeatedFlowSetup();
  const clarification = (store.state.clarifications || []).find(item => item.kind === 'permission');
  assert.ok(clarification, 'two repeated requests for one entity raise the standing question once');
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'permission').length, 1);

  engine.answerClarification(clarification.id, 'never');
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'permission').length, 0,
    'an answered scope is not raised again');

  // A later request for the same entity must not reopen the settled question.
  engine.ingest({ id: 'e-email-c', type: 'email.received', payload: {
    id: 'm3', from: 'alex@example.test', subject: 'Northstar deck — experiment results',
    body: 'Please update the Northstar deck with the latest experiment results and send it by Friday.'
  } });
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'permission').length, 0);
  const after = (store.state.clarifications || []).find(item => item.id === clarification.id);
  assert.equal(after.status, 'answered', 'the answered question is not reopened');
});

test('“ask me each time” settles the standing question and still denies autonomy', () => {
  const { store, engine } = repeatedFlowSetup();
  const clarification = (store.state.clarifications || []).find(item => item.kind === 'permission');
  engine.answerClarification(clarification.id, 'ask_each_time');
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'permission').length, 0,
    'the question the user answered is not asked again');

  // The evidence arrives: the flow must ask per action, not run autonomously.
  engine.ingest(scopedDoc('Northstar'));
  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0, 'only an explicit allow pre-authorises execution');
});
