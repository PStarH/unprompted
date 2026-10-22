import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import {
  notification, emitNotification, resolveNotifications, markRead, openNotifications, summarise, deadlineRisk
} from '../src/notifications.js';

/**
 * Decision notifications.
 *
 * The two guarantees worth pinning: a notification that cannot explain itself is
 * refused, and nothing is sent unless a decision is genuinely needed.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-notify-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = (id, project = 'Northstar', deadline = 'Friday') => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: `${project} proposal — experiment results`,
    body: `Please update the ${project} project proposal with the latest experiment results and send the revised proposal by ${deadline}.`
  }
});
const doc = (id, project, content) => ({
  id, type: 'document.modified', payload: {
    id: `${project.toLowerCase()}-proposal`, kind: 'proposal', title: `${project} project proposal`, content
  }
});
const complete = project => `# ${project} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n`;
const partial = project => `# ${project} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\n`;

test('a notification that cannot explain itself is refused', () => {
  assert.throws(() => notification({ kind: 'opportunity', what: 'Something', why: 'Because', checked: ['x'], decision: '' }), /must state decision/);
  assert.throws(() => notification({ kind: 'opportunity', what: 'Something', why: 'Because', checked: [], decision: 'Decide' }), /already checked/);
  assert.throws(() => notification({ kind: 'nonsense', what: 'a', why: 'b', checked: ['x'], decision: 'c' }), /Unknown notification kind/);
});

test('a notification always carries what, why, checked, evidence, uncertainty and a decision', () => {
  const item = notification({
    kind: 'risk', what: 'Evidence contradicts itself.', why: 'Acting could be wrong.', checked: ['Compared values.'],
    evidence: [{ detail: '8.1% and 9.0%' }], uncertainty: ['Which is right.'], decision: 'Which value is correct?'
  });
  for (const field of ['what', 'why', 'checked', 'evidence', 'uncertainty', 'decision']) assert.ok(field in item, `${field} present`);
  assert.equal(item.readAt, null);
  assert.equal(item.resolvedAt, null);
});

test('the same decision is never sent twice, and a resolved one can revive', () => {
  const list = [];
  const make = () => notification({ kind: 'deadline', what: 'Due soon', why: 'Close', checked: ['Checked.'], decision: 'Prioritise?', dedupeKey: 'd:1' });
  emitNotification(list, make());
  emitNotification(list, make());
  assert.equal(list.length, 1, 'duplicates are suppressed by dedupe key');
  resolveNotifications(list, item => item.dedupeKey === 'd:1', '2026-10-16T10:00:00.000Z');
  assert.equal(openNotifications(list).length, 0);
  emitNotification(list, make());
  assert.equal(list.length, 1);
  assert.equal(openNotifications(list).length, 1, 'the same condition recurring revives one notification');
});

test('a revived notification is unread again and keeps its identity', () => {
  const list = [];
  const make = at => notification({
    kind: 'deadline', what: 'Due soon', why: 'Close', checked: ['Checked.'], decision: 'Prioritise?', dedupeKey: 'r:1', at
  });
  const first = emitNotification(list, make('2026-10-16T09:00:00.000Z'));
  markRead(list, [first.id], '2026-10-16T09:05:00.000Z');
  // A text refresh while the condition still holds must not re-open a decided item.
  emitNotification(list, make('2026-10-16T09:10:00.000Z'));
  assert.equal(list[0].readAt, '2026-10-16T09:05:00.000Z', 'a still-open notification stays read while its text refreshes');
  resolveNotifications(list, item => item.dedupeKey === 'r:1', '2026-10-16T10:00:00.000Z');
  const revived = emitNotification(list, make('2026-10-17T09:00:00.000Z'));
  assert.equal(revived.id, first.id, 'the revived decision keeps its record identity');
  assert.equal(list.length, 1, 'no duplicate is created');
  assert.equal(revived.resolvedAt, null);
  assert.equal(revived.readAt, null, 'a revived decision is unread again');
  assert.equal(revived.at, '2026-10-17T09:00:00.000Z');
});

test('marking notifications read and summarising counts only what is open', () => {
  const list = [
    notification({ kind: 'deadline', what: 'a', why: 'b', checked: ['c'], decision: 'd', dedupeKey: 'k1' }),
    notification({ kind: 'blocker', what: 'e', why: 'f', checked: ['g'], decision: 'h', dedupeKey: 'k2' })
  ];
  resolveNotifications(list, item => item.dedupeKey === 'k1');
  assert.deepEqual(summarise(list), { total: 2, open: 1, unread: 1, byKind: { blocker: 1 } });
  assert.equal(markRead(list), 1);
  assert.equal(summarise(list).unread, 0);
});

test('deadline risk needs a calendar day and cannot invent one from bare text', () => {
  const now = new Date('2026-10-16T09:00:00.000Z');
  assert.ok(deadlineRisk({ deadline: { iso: '2026-10-17', text: '2026-10-17' }, now, withinDays: 3 }));
  assert.ok(deadlineRisk({ deadline: { iso: '2026-10-10', text: '2026-10-10' }, now, withinDays: 3 }).overdue);
  assert.equal(deadlineRisk({ deadline: { iso: '2026-11-30', text: '2026-11-30' }, now, withinDays: 3 }), null);
  assert.equal(deadlineRisk({ deadline: { text: 'Friday', iso: null }, now }), null);
  assert.equal(deadlineRisk({ deadline: null, now }), null);
});

test('default quiet: discovering, preparing and verifying work produces no notification', async () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc('e-doc', 'Northstar', complete('Northstar')));
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');
  await engine.approve('request:m1');
  assert.equal(store.state.tasks['request:m1'].status, 'completed');
  assert.equal(engine.publicState().notifications.length, 0, 'a completed, verified task is not worth interrupting anyone for');
});

test('a deadline close enough to matter, while the work is incomplete, does interrupt', () => {
  const { engine, store } = setup();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  engine.ingest(email('m1', 'Vega', tomorrow));
  engine.ingest(doc('e-doc', 'Vega', partial('Vega')));
  assert.equal(store.state.tasks['request:m1'].status, 'waiting_for_information');
  const item = engine.publicState().notifications.find(entry => entry.kind === 'deadline');
  assert.ok(item, 'a near deadline on incomplete work is a decision the user can still act on');
  assert.ok(item.checked.length > 0);
  assert.ok(item.decision.length > 0);
});

test('a distant deadline stays quiet', () => {
  const { engine } = setup();
  const far = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  engine.ingest(email('m1', 'Vega', far));
  engine.ingest(doc('e-doc', 'Vega', partial('Vega')));
  assert.equal(engine.publicState().notifications.filter(entry => entry.kind === 'deadline').length, 0);
});

test('an unknown external outcome raises a blocker notification that clears on verification', async () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc('e-doc', 'Northstar', complete('Northstar')));
  const taskId = 'request:m1';

  engine.provider.lookupOverride = 'unknown';
  await engine.approve(taskId);
  assert.equal(store.state.tasks[taskId].status, 'blocked');
  const blocker = engine.publicState().notifications.find(entry => entry.kind === 'blocker');
  assert.ok(blocker, 'an unconfirmed send is exactly what the user must decide');
  assert.match(blocker.what, /cannot confirm|timed out/i);

  // The message turns out to have been accepted after all.
  engine.provider.lookupOverride = null;
  store.mutate(state => {
    state.outbox.push({
      id: 'sim-reconciled', idempotencyKey: `send:${taskId}:1`, to: 'alex@example.test',
      subject: 'Re: Northstar', body: 'x', provider: 'simulated-mail', status: 'accepted_simulation',
      acceptedAt: new Date().toISOString()
    });
  });
  await engine.reconcile(taskId);
  assert.equal(store.state.tasks[taskId].status, 'completed');
  assert.equal(engine.publicState().notifications.filter(entry => entry.kind === 'blocker').length, 0, 'a resolved blocker stops asking');
});

test('contradictory evidence in the workspace raises a risk notification with its evidence', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  store.mutate(state => {
    state.tasks['request:m1'].evidence.conflicts = [
      { id: 'conflicting:control_metric', detail: 'Control is reported as both 8.1% and 9.0%.' }
    ];
  });
  engine.recordCalibration({ key: 'preference:noop', value: 'noop' });
  const risk = engine.publicState().notifications.find(entry => entry.kind === 'risk');
  assert.ok(risk);
  assert.match(risk.what, /8\.1%/);
  assert.ok(risk.evidence.length > 0);
});
