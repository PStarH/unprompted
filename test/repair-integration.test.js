import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { SimulatedMailProvider } from '../src/providers.js';

const T0 = '2026-10-25T09:00:00.000Z';
function mail(id, { body = 'Please update the Northstar proposal with the experiment results and send it by 2026-11-10.', threadId = 'northstar-thread', from = 'Alex <alex@example.test>', to = 'maya@example.test', subject = 'Northstar proposal', receivedAt = T0 } = {}) {
  return { id: `event:${id}`, type: 'email.received', at: receivedAt, payload: { id, threadId, from, to, subject, body, receivedAt } };
}
const results = '## Experiment results\nRun date: 2026-10-24\nSample size: 1200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.';
function doc(id = 'northstar-proposal', content = `# Northstar proposal\n${results}`) {
  return { id: `document:${id}`, type: 'document.modified', payload: { id, title: 'Northstar proposal', kind: 'proposal', content } };
}

async function inWorkspace(run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-repair-journey-'));
  const filename = path.join(dir, 'state.json');
  let store = new JsonStore(filename);
  const engine = new WorkEngine(store, { reasoner: new NullReasoner(), ...options });
  const reopen = () => { store.close(); store = new JsonStore(filename); return new WorkEngine(store, { reasoner: new NullReasoner(), ...options }); };
  try { return await run(engine, store, reopen); }
  finally { await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('one commitment stays one task across reminders, rescheduling, withdrawal, restart and later evidence', () => inWorkspace(async (engine, store, reopen) => {
  engine.ingest(doc()); engine.ingest(mail('request'));
  engine.ingest(mail('reminder', { from: 'ALEX@example.test', receivedAt: '2026-10-25T10:00:00.000Z' }));
  assert.equal(Object.keys(store.state.tasks).length, 1);
  const id = Object.keys(store.state.tasks)[0];
  engine.ingest(mail('new-deadline', { body: 'The Northstar proposal deadline is now 2026-11-12.', receivedAt: '2026-10-25T11:00:00.000Z' }));
  assert.equal(Object.keys(store.state.tasks).length, 1);
  assert.equal(store.state.tasks[id].request.deadline.iso, '2026-11-12');
  engine.ingest(mail('withdrawal', { body: 'Please cancel the Northstar proposal request. No need to send it.', receivedAt: '2026-10-25T12:00:00.000Z' }));
  assert.equal(store.state.tasks[id].status, 'cancelled');
  assert.equal(store.state.tasks[id].draft, null);
  assert.equal(store.state.outbox.length, 0);
  const restarted = reopen();
  restarted.ingest({ ...doc(), id: 'later-revision' });
  await restarted.whenSettled();
  assert.equal(restarted.publicState().tasks.find(task => task.id === id).status, 'cancelled');
  assert.throws(() => restarted.approve(id), /not ready|cancel|withdraw/i);
}));

test('a late old message cannot resurrect a withdrawn commitment', () => inWorkspace(async (engine, store) => {
  engine.ingest(mail('request'));
  const id = Object.keys(store.state.tasks)[0];
  engine.ingest(mail('withdrawal', { body: 'Please cancel the Northstar proposal request.', receivedAt: '2026-10-25T12:00:00.000Z' }));
  engine.ingest(mail('old-reminder', { receivedAt: '2026-10-25T10:00:00.000Z' }));
  await engine.whenSettled();
  assert.equal(Object.keys(store.state.tasks).length, 1);
  assert.equal(store.state.tasks[id].status, 'cancelled');
  assert.equal(store.state.outbox.length, 0);
}));

test('different conversation participants remain distinct even in one provider thread', () => inWorkspace((engine, store) => {
  engine.ingest(mail('first'));
  engine.ingest(mail('another-participant', { from: 'pat@example.test' }));
  assert.equal(Object.keys(store.state.tasks).length, 2);
}));

test('negated or quoted withdrawal language does not cancel current work', () => inWorkspace((engine, store) => {
  engine.ingest(mail('request'));
  const id = Object.keys(store.state.tasks)[0];
  engine.ingest(mail('negative', { body: 'Do not cancel the Northstar proposal. Keep working on it.', receivedAt: '2026-10-25T10:00:00.000Z' }));
  assert.notEqual(store.state.tasks[id].status, 'cancelled');
  engine.ingest(mail('quoted-history', { body: 'The Northstar proposal is still needed.\n\n> Please cancel the Northstar proposal request.', receivedAt: '2026-10-25T11:00:00.000Z' }));
  assert.notEqual(store.state.tasks[id].status, 'cancelled');
  assert.equal(store.state.outbox.length, 0);
}));

test('English and Chinese requests both reach a managed task with an explainable next step', () => inWorkspace((engine, store) => {
  engine.ingest(mail('english'));
  engine.ingest(mail('chinese', { threadId: 'chinese-thread', subject: 'Northstar 提案', body: '请更新 Northstar 提案，补充最新实验结果，并在周五发给我。' }));
  const tasks = engine.publicState().tasks;
  assert.equal(tasks.length, 2);
  assert.ok(tasks.some(task => task.sourceEmailId === 'chinese'));
  for (const task of tasks) {
    assert.ok(task.management?.owner?.id);
    assert.ok(task.management?.nextAction?.kind);
    assert.ok(Array.isArray(task.management.dependencies));
    assert.ok(Array.isArray(task.management.priority.reasons));
  }
  assert.equal(store.state.outbox.length, 0);
}));

test('withdrawal while the delivery lookup is pending prevents the subsequent send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-repair-send-race-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  let release, sends = 0;
  class PausedProvider extends SimulatedMailProvider {
    lookup() { return new Promise(resolve => { release = () => resolve({ status: 'not_found' }); }); }
    send(payload, options) { sends++; return super.send(payload, options); }
  }
  const engine = new WorkEngine(store, { provider: new PausedProvider(store), reasoner: new NullReasoner() });
  try {
    engine.ingest(doc()); engine.ingest(mail('request'));
    const id = Object.keys(store.state.tasks)[0];
    const sending = Promise.resolve(engine.approve(id)).catch(error => error);
    assert.ok(release, 'approval reached the pre-send lookup');
    engine.ingest(mail('withdrawal', { body: 'Please cancel the Northstar proposal request.', receivedAt: '2026-10-25T12:00:00.000Z' }));
    release(); await sending; await engine.whenSettled();
    assert.equal(sends, 0);
    assert.equal(store.state.outbox.length, 0);
    assert.notEqual(store.state.tasks[id].status, 'completed');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a document wait survives restart, ignores unrelated and cosmetic changes, and wakes on a delivery condition', () => inWorkspace(async (engine, _store, reopen) => {
  engine.ingest(doc('northstar-proposal', '# Northstar proposal\n## Experiment results\nControl: 8.1% conversion\n'));
  engine.ingest(mail('request', { body: 'Please update the Northstar proposal with the experiment results and send it.' }));
  const id = 'request:request';
  engine.waitForTask(id, { kind: 'document', dependsOn: { documentId: 'northstar-proposal' } });
  const restarted = reopen();
  assert.equal(restarted.store.state.taskWaits[id].status, 'active');
  restarted.ingest({ id: 'unrelated', type: 'document.modified', payload: { id: 'orion-roadmap', title: 'Orion roadmap', kind: 'roadmap', content: '# Orion roadmap\nPlan for next quarter.' } });
  assert.equal(restarted.store.state.taskWaits[id].status, 'active');
  restarted.ingest({ ...doc('northstar-proposal', '# Northstar proposal\n## Experiment results\nControl: 8.1% conversion\n\n'), id: 'format-only' });
  assert.equal(restarted.store.state.taskWaits[id].status, 'active');
  restarted.ingest({ ...doc(), id: 'required-results-arrive' });
  await restarted.whenSettled();
  assert.equal(restarted.store.state.taskWaits[id].status, 'resolved');
  assert.equal(restarted.store.state.outbox.length, 0);
}));

test('scoped ownership correction suppresses matching future work and undo restores discovery', () => inWorkspace(async (engine, store) => {
  engine.ingest(mail('request'));
  const feedback = engine.recordTaskFeedback('request:request', {
    label: 'not_mine', scope: { sender: 'alex@example.test', subjectEntity: 'Northstar' }
  });
  engine.ingest(mail('same-scope', { threadId: 'second-thread', from: 'ALEX@example.test' }));
  assert.equal(Object.keys(store.state.tasks).length, 1);
  engine.ingest(mail('different-entity', { threadId: 'orion-thread', subject: 'Orion proposal', body: 'Please update the Orion proposal with the experiment results and send it.' }));
  assert.equal(Object.keys(store.state.tasks).length, 2);
  engine.undoTaskFeedback(feedback.id);
  engine.ingest(mail('after-undo', { threadId: 'third-thread' }));
  await engine.whenSettled();
  assert.equal(Object.keys(store.state.tasks).length, 3);
  assert.equal(store.state.outbox.length, 0);
}));

test('a grounded document patch prepared before withdrawal cannot be applied afterwards', () => inWorkspace(async (engine, store) => {
  const url = 'https://docs.example.test/northstar';
  const initial = '# Northstar proposal\n';
  engine.ingest({ ...doc('northstar-proposal', initial), payload: { ...doc('northstar-proposal', initial).payload, url } });
  engine.ingest({ id: 'supporting-evidence', type: 'document.modified', payload: { id: 'experiment-notes', title: 'Northstar experiment notes', kind: 'notes', content: results } });
  engine.ingest(mail('request', { body: `Please update the Northstar proposal with the experiment results and send it. Use ${url}` }));
  const id = 'request:request';
  const patch = await engine.prepareDocumentPatch(id, { provider: 'local', changes: [{
    type: 'append', text: results, source: { kind: 'document', id: 'experiment-notes', version: 1, quote: results }
  }] });
  assert.equal(patch.status, 'prepared');
  assert.equal(store.state.documents['northstar-proposal'].content, initial);
  engine.ingest(mail('withdrawal', { body: 'Please cancel the Northstar proposal request.', receivedAt: '2026-10-25T12:00:00.000Z' }));
  await assert.rejects(() => engine.applyDocumentPatch(id, { patchId: patch.id, authorization: {
    kind: 'explicit', taskId: id, patchId: patch.id, baseDocumentVersion: patch.baseDocument.version, confirmed: true
  } }), /cancel|closed|stale|withdraw|changed/i);
  assert.equal(store.state.documents['northstar-proposal'].content, initial);
  assert.equal(store.state.outbox.length, 0);
}));
