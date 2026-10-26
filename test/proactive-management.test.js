import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { evaluateOpportunities } from '../src/opportunities.js';

function workspace(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-proactive-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { reasoner: new NullReasoner(), stallAfterMs: 60_000 });
  try { return run(engine, store); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const mail = id => ({ id: `email:${id}`, type: 'email.received', payload: {
  id, from: 'alex@example.test', subject: 'Northstar proposal',
  body: 'Please update the Northstar proposal with the latest experiment results and send it.'
} });
const partial = '# Northstar proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1200\nControl: 8.1% conversion\n';
const complete = `${partial}Treatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n`;
const document = (id, content = partial) => ({ id, type: 'document.modified', payload: {
  id: 'northstar-proposal', title: 'Northstar proposal', kind: 'proposal', content
} });
const openStalls = store => store.state.notifications.filter(item => !item.resolvedAt && item.dedupeKey?.startsWith('stalled:'));

test('formatting churn does not postpone a stalled delivery or withdraw its open decision', () => workspace((engine, store) => {
  engine.ingest(document('initial')); engine.ingest(mail('m1'));
  const task = store.state.tasks['request:m1'];
  const since = new Date(Date.now() - 120_000).toISOString();
  store.mutate(() => { task.progress.at = since; });
  engine.sweepAttention();
  const notice = openStalls(store)[0]; assert.ok(notice);
  engine.ingest(document('format-only', `${partial}\n\n`));
  assert.equal(task.progress.at, since);
  assert.equal(openStalls(store)[0]?.id, notice.id);
  assert.equal(task.assessment.documentVersion, 2, 'evidence still follows the latest document version');
  assert.equal(store.state.outbox.length, 0);
}));

test('a changed satisfied figure does not hide requirements that remain missing', () => workspace((engine, store) => {
  engine.ingest(document('initial')); engine.ingest(mail('m1'));
  const task = store.state.tasks['request:m1'];
  const since = new Date(Date.now() - 120_000).toISOString();
  store.mutate(() => { task.progress.at = since; });
  engine.ingest(document('revised-control', partial.replace('8.1%', '8.2%')));
  assert.equal(task.progress.at, since);
  assert.equal(openStalls(store).length, 1);
}));

test('satisfying a missing requirement restarts the progress window and withdraws the old stall', () => workspace((engine, store) => {
  engine.ingest(document('initial')); engine.ingest(mail('m1'));
  const task = store.state.tasks['request:m1'];
  const since = new Date(Date.now() - 120_000).toISOString();
  store.mutate(() => { task.progress.at = since; });
  engine.sweepAttention(); assert.equal(openStalls(store).length, 1);
  engine.ingest(document('treatment-arrives', `${partial}Treatment: 10.4% conversion\n`));
  assert.notEqual(task.progress.at, since);
  assert.equal(task.status, 'waiting_for_information', 'the missing conclusion still prevents delivery');
  assert.equal(openStalls(store).length, 0);
}));

test('legacy progress timestamps survive reassessment when no delivery condition changed', () => workspace((engine, store) => {
  engine.ingest(document('initial')); engine.ingest(mail('m1'));
  const task = store.state.tasks['request:m1'];
  const since = new Date(Date.now() - 120_000).toISOString();
  store.mutate(() => { task.progress.at = since; delete task.progress.semanticSignature; });
  engine.ingest(document('format-only', `${partial}\n`));
  assert.equal(task.progress.at, since);
  assert.equal(openStalls(store).length, 1);
}));

test('closed and declined work cannot generate any of the built-in opportunity signals', () => {
  const gap = id => ({ id, status: 'waiting_for_information', createdAt: '2026-10-16T09:00:00Z',
    request: { subjectEntity: 'Northstar', deliverable: 'proposal', intent: 'update_and_send' },
    assessment: { freshness: { status: 'unverified' } },
    evidence: {
      unknowns: [{ id: 'freshness_source_of_truth', question: 'Latest?', reason: 'No registry.' }],
      criteria: [{ status: 'blocked', label: 'Sales figures', probe: { provider: 'salesforce' }, note: 'Source unavailable.' }],
      plan: { unverifiable: [{ text: 'custom analysis', reason: 'No probe.' }] }
    }
  });
  const tasks = { a: gap('a'), b: gap('b') };
  assert.equal(evaluateOpportunities({ tasks }).length, 3);
  for (const terminal of [{ status: 'completed' }, { status: 'cancelled' }, { status: 'blocked', userDismissed: true }]) {
    const closed = Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, { ...task, ...terminal }]));
    assert.deepEqual(evaluateOpportunities({ tasks: closed }), [], JSON.stringify(terminal));
  }
});

test('declining a prepared request removes recurrence advice based on that request', () => workspace((engine, store) => {
  engine.ingest(document('ready', complete)); engine.ingest(mail('m1')); engine.ingest(mail('m2'));
  assert.ok(Object.values(store.state.opportunities).some(item => item.status === 'proposed'));
  engine.reject('request:m1');
  assert.equal(Object.values(store.state.opportunities).filter(item => item.status === 'proposed').length, 0);
  assert.equal(store.state.notifications.filter(item => item.kind === 'opportunity' && !item.resolvedAt).length, 0);
  assert.equal(store.state.outbox.length, 0);
}));
