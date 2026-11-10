import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { iso } from '../src/durable/database.js';
import { decisionQueue, visibleAttentionItems } from '../public/ux-state.js';
import { needsUserAttention, stateGroup, taskState, terminalAttentionClose } from '../public/workspace-model.js';

const group = (task, context) => stateGroup(taskState(task, context));
const attentionIds = (tasks, context = {}) => tasks.filter(task => needsUserAttention(task, context)).map(task => task.id);
const fieldIds = (tasks, context = {}) => tasks.filter(task => group(task, context) === 'attention').map(task => task.id);
const queueIds = (tasks, context = {}) => decisionQueue(tasks, [], context).filter(item => item.kind === 'task').map(item => item.value.id);

function assertSameAdmission(tasks, context = {}) {
  const admitted = attentionIds(tasks, context).sort();
  assert.deepEqual(fieldIds(tasks, context).sort(), admitted);
  assert.deepEqual(queueIds(tasks, context).sort(), admitted);
  for (const task of tasks) {
    const zone = group(task, context);
    if (admitted.includes(task.id)) assert.equal(zone, 'attention', task.id);
    else assert.notEqual(zone, 'attention', task.id);
  }
}

test('in-flight verify and send stay in motion and out of the decision queue', () => {
  const tasks = [
    { id: 'verifying', status: 'verifying' },
    { id: 'executing', status: 'blocked', action: { status: 'executing' } },
    { id: 'accepted', status: 'blocked', action: { status: 'accepted_live' } },
    { id: 'uncertain', status: 'blocked', action: { status: 'uncertain' } }
  ];
  for (const task of tasks) {
    assert.equal(group(task), 'working', task.id);
    assert.equal(needsUserAttention(task), false, task.id);
  }
  assert.deepEqual(queueIds(tasks), []);
  assertSameAdmission(tasks);
});

test('blocked unknown without a terminal close stays in motion, and an explicit close needs the user', () => {
  const open = { id: 'open', status: 'blocked', action: { status: 'unknown' } };
  assert.equal(terminalAttentionClose(open), null);
  assert.equal(group(open), 'working');
  assert.equal(needsUserAttention(open), false);
  const inconclusive = { id: 'cap', status: 'blocked', action: { status: 'unknown', close: 'reconciliation_inconclusive' }, reconciliation_inconclusive: true };
  const attest = { id: 'attest', status: 'blocked', action: { status: 'accepted_live', live: true }, attestationRequest: true };
  for (const task of [inconclusive, attest]) {
    assert.ok(terminalAttentionClose(task), task.id);
    assert.equal(group(task), 'attention', task.id);
    assert.equal(taskState(task), 'needs_user', task.id);
  }
  assertSameAdmission([open, inconclusive, attest]);
});

test('a synthetic wake does not hide user-owned missing information, and a persisted wait does', () => {
  const synthetic = {
    id: 'ask', status: 'waiting_for_information', documentId: 'doc-1',
    management: {
      nextAction: { kind: 'provide_information', owner: 'unknown' },
      wake: { kind: 'document', status: 'waiting', condition: 'When document “doc-1” changes' }
    }
  };
  assert.equal(needsUserAttention(synthetic), true);
  assert.equal(group(synthetic), 'attention');
  const persisted = {
    id: 'watch', status: 'waiting_for_information',
    wait: { id: 'wait-1', status: 'active', kind: 'document', condition: { label: 'a new version of the brief' } },
    management: { nextAction: { kind: 'wait', owner: 'agent' }, wake: { waitId: 'wait-1', status: 'active', kind: 'document' } }
  };
  assert.equal(needsUserAttention(persisted), false);
  assert.equal(group(persisted), 'waiting');
  const interrupted = { id: 'risk', status: 'waiting_for_information', wait: { status: 'interrupted', interruption: { reason: 'deadline' } } };
  assert.equal(needsUserAttention(interrupted), true);
  assert.equal(group(interrupted), 'attention');
  assertSameAdmission([synthetic, persisted, interrupted]);
});

test('source disconnect needs the user only when it blocks ready or in-flight work', () => {
  const connections = { github: { connected: false }, google: { connected: false } };
  const observing = { id: 'issue', kind: 'external_issue', status: 'waiting_for_information', sourceConnectorId: 'github', externalSource: { provider: 'github' } };
  const local = { id: 'todo', kind: 'observed_task', status: 'waiting_for_information', sourceConnectorId: 'github' };
  const ready = { id: 'ready', status: 'ready_for_approval', sourceConnectorId: 'google', draft: { body: 'Ready' } };
  const flight = { id: 'flight', status: 'verifying', action: { status: 'executing' }, sourceConnectorId: 'google' };
  assert.equal(taskState(observing, connections), 'observing');
  assert.equal(group(observing, connections), 'quiet');
  assert.equal(group(local, connections), 'quiet');
  assert.equal(needsUserAttention(ready, connections), true);
  assert.equal(taskState(ready, connections), 'source_disconnected');
  assert.equal(needsUserAttention(flight, connections), true);
  assert.equal(taskState(flight, connections), 'source_disconnected');
  assertSameAdmission([observing, local, ready, flight], { connections });
});

test('a ready draft stays in Needs you until execution has actually started', () => {
  const draft = { id: 'draft', status: 'ready_for_approval', autonomyGrantId: 'lease-1', draft: { body: 'Send this' } };
  const started = { id: 'started', status: 'verifying', autonomyGrantId: 'lease-1', action: { status: 'executing' } };
  const accepted = { id: 'live', status: 'blocked', autonomyGrantId: 'lease-1', action: { status: 'accepted_live' } };
  assert.equal(needsUserAttention(draft), true);
  assert.equal(group(started), 'working');
  assert.equal(group(accepted), 'working');
  assertSameAdmission([draft, started, accepted]);
});

test('an unverifiable ledger write is not Needs you and is not completed as verified', () => {
  const write = {
    id: 'mcp', status: 'blocked',
    action: { status: 'accepted', verified: false, ledgerOnlyUnverified: true, family: 'mcp.tool' },
    platformRequests: [{ family: 'mcp.tool', verification: null, verified: false, ledgerOnlyUnverified: true }]
  };
  assert.equal(needsUserAttention(write), false);
  assert.notEqual(group(write), 'attention');
  assert.notEqual(write.status, 'completed');
  assert.notEqual(taskState(write), 'verified');
  const quiet = { id: 'quiet', status: 'investigating', platformRequests: [{ family: 'connector.request', verification: null, verified: false, ledgerOnlyUnverified: true }] };
  assert.equal(needsUserAttention(quiet), false);
  assert.notEqual(quiet.status, 'completed');
});

test('failed work that cannot be posted again needs the user', () => {
  const failed = { id: 'failed', status: 'blocked', action: { status: 'failed', live: true, dispatched: true } };
  assert.equal(needsUserAttention(failed), true);
  assert.equal(taskState(failed), 'failed');
  assert.equal(group(failed), 'attention');
});

test('an unmapped status never defaults to Needs you', () => {
  const leftover = { id: 'leftover', status: 'not_a_known_status' };
  assert.equal(needsUserAttention(leftover), false);
  assert.equal(taskState(leftover), 'unknown');
  assert.equal(stateGroup('unknown'), 'quiet');
  assert.notEqual(stateGroup(taskState(leftover)), 'attention');
  const owned = { id: 'owned', status: 'not_a_known_status', management: { nextAction: { kind: 'assess', owner: 'agent' } } };
  assert.equal(group(owned), 'working');
  assert.equal(needsUserAttention(owned), false);
  assert.notEqual(stateGroup('result_unverified'), 'attention');
});

test('a shared dependency is one band, not one Needs you row per child', () => {
  const dependency = { id: 'dep:shared', status: 'open', taskIds: ['a', 'b'], label: 'the sample size' };
  const child = id => ({
    id, status: 'waiting_for_information',
    management: { dependencies: [dependency], nextAction: { kind: 'resolve_dependency' } }
  });
  const tasks = [child('a'), child('b')];
  assert.deepEqual(attentionIds(tasks), []);
  assert.deepEqual(queueIds(tasks), []);
  for (const task of tasks) assert.equal(group(task), 'waiting');
  const state = {
    tasks,
    notifications: [
      { id: 'stall-a', kind: 'blocker', dedupeKey: 'stalled:a', taskId: 'a', priority: 'normal' },
      { id: 'stall-b', kind: 'blocker', dedupeKey: 'stalled:b', taskId: 'b', priority: 'normal' },
      { id: 'deadline-a', kind: 'deadline', dedupeKey: 'deadline:a', taskId: 'a', priority: 'high' },
      { id: 'risk-b', kind: 'risk', dedupeKey: 'risk:b', taskId: 'b', priority: 'high' }
    ]
  };
  assert.deepEqual(visibleAttentionItems(state).map(item => item.id), ['deadline-a', 'risk-b']);
  const solo = { id: 'solo', status: 'waiting_for_information', management: { dependencies: [{ id: 'dep:solo', status: 'open', taskIds: ['solo'] }], nextAction: { kind: 'resolve_dependency' } } };
  assert.equal(needsUserAttention(solo), true);
});

test('the decision queue, field zone and J/K state group admit the same tasks', () => {
  const connections = { google: { connected: false } };
  const tasks = [
    { id: 'ready', status: 'ready_for_approval' },
    { id: 'flight', status: 'verifying', action: { status: 'executing' } },
    { id: 'cap', status: 'blocked', reconciliation_inconclusive: true, action: { status: 'unknown', close: 'reconciliation_inconclusive' } },
    { id: 'ask', status: 'waiting_for_information', management: { nextAction: { kind: 'provide_information' }, wake: { kind: 'event', status: 'waiting' } } },
    { id: 'wait', status: 'waiting_for_information', wait: { status: 'active', kind: 'time' } },
    { id: 'watch', kind: 'external_review', status: 'waiting_for_information', sourceConnectorId: 'google' },
    { id: 'down', status: 'ready_for_approval', sourceConnectorId: 'google' },
    { id: 'mystery', status: 'brand_new_status' },
    { id: 'paused', status: 'ready_for_approval', control: { paused: true } },
    { id: 'done', status: 'completed' }
  ];
  assertSameAdmission(tasks, { connections });
  const admittedStates = new Set(tasks.filter(task => needsUserAttention(task, { connections })).map(task => taskState(task, { connections })));
  for (const state of admittedStates) assert.equal(stateGroup(state), 'attention', state);
});

test('a non-durable inconclusive send records reconciliation_inconclusive for the predicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-needs-you-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  store.mutate(state => {
    state.tasks.t = { id: 't', status: 'verifying', subject: 'Check', request: {}, action: { id: 'a', status: 'executing', idempotencyKey: 'k' } };
  });
  const task = engine.uncertain('t', 'The provider cannot confirm whether the message was accepted.');
  assert.equal(task.reconciliation_inconclusive, true);
  assert.equal(task.action.close, 'reconciliation_inconclusive');
  assert.equal(needsUserAttention(task), true);
  assert.equal(store.state.notifications.some(item => item.kind === 'blocker' && !item.resolvedAt), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the fourth inconclusive recovery writes reconciliation_inconclusive onto the task', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-needs-you-cap-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const provider = new SimulatedMailProvider(store);
  const engine = new WorkEngine(store, { provider });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const now = iso(store.database.now());
  store.mutate(state => {
    state.tasks.t = { id: 't', status: 'blocked', subject: 'Check', request: {}, action: { id: 'send:t', status: 'uncertain', idempotencyKey: 'send:t' } };
  });
  const job = runtime.jobs.enqueue({ queue: 'effects', type: 'external_dispatch', key: 'cap:send:t', taskId: 't', payload: { key: 'send:t', recoveryCount: 3 } });
  store.database.atomic(() => {
    store.db.prepare("UPDATE jobs SET state='recovery_required' WHERE id=?").run(job.id);
    store.db.prepare(`INSERT INTO tool_executions(id,task_id,job_id,provider,tool,action_family,resource_id,idempotency_key,effect_signature_json,status,is_write,input_version,run_generation,privacy_epoch,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'unknown',1,0,0,0,?,?)`).run('exec-1', 't', job.id, 'other', 'send', 'email.send', 'thread', 'send:t', '{}', now, now);
  });
  const stored = runtime.jobs.get(job.id);
  await runtime.recover({ ...stored, payload: stored.payload });
  const task = store.state.tasks.t;
  assert.equal(task.reconciliation_inconclusive, true);
  assert.equal(task.action.close, 'reconciliation_inconclusive');
  assert.equal(runtime.ledger.get('exec-1').last_error_class, 'reconciliation_inconclusive');
  assert.equal(needsUserAttention(task), true);
  assert.equal(store.state.notifications.filter(item => item.kind === 'blocker' && item.taskId === 't' && !item.resolvedAt).length, 1);
});
