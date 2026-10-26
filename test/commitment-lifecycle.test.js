import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { explainRequest } from '../src/requests.js';
import { buildDeterministicPlan } from '../src/probes/plan.js';

const results = [
  '## Experiment results',
  'Run date: 2026-10-24',
  'Sample size: 1200',
  'Control: 8.1% conversion',
  'Treatment: 10.4% conversion',
  'Conclusion: Treatment improved conversion.'
].join('\n');

const requestMail = (id, overrides = {}) => ({
  id: `event:${id}`,
  type: 'email.received',
  at: overrides.receivedAt || '2026-10-25T09:00:00.000Z',
  payload: {
    id,
    threadId: overrides.threadId || 'northstar-thread',
    from: overrides.from || 'Alex <alex@example.test>',
    to: overrides.to || 'maya@example.test',
    subject: overrides.subject || 'Northstar proposal',
    body: overrides.body || 'Please update the Northstar proposal with the experiment results and send it by 2026-11-10.',
    receivedAt: overrides.receivedAt || '2026-10-25T09:00:00.000Z'
  }
});

const resultDocument = (id = 'northstar-proposal', content = `# Northstar proposal\n${results}`) => ({
  id: `document:${id}`,
  type: 'document.modified',
  payload: { id, title: 'Northstar proposal', kind: 'proposal', content }
});

async function workspace(run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-lifecycle-'));
  const filename = path.join(dir, 'state.json');
  const store = new JsonStore(filename);
  const engine = new WorkEngine(store, { reasoner: new NullReasoner(), ...options });
  try {
    return await run({ dir, filename, store, engine });
  } finally {
    if (engine.pending?.size) await engine.whenSettled();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function availableReasoner(overrides = {}) {
  return Object.assign(new NullReasoner(), { available: () => true, ...overrides });
}

test('Chinese requests keep a grounded deliverable and weekday deadline, while negation stays noise', () => {
  const message = {
    id: 'cn-request', from: 'Alex <alex@example.test>', subject: 'Northstar 提案',
    body: '请更新 Northstar 提案，补充最新实验结果，并在周五发给我。',
    receivedAt: '2026-10-25T09:00:00.000Z'
  };
  const parsed = explainRequest(message, { now: message.receivedAt });
  assert.equal(parsed.request?.subjectEntity, 'Northstar');
  assert.equal(parsed.request?.deliverable, 'proposal');
  assert.equal(parsed.request?.intent, 'update_and_send');
  assert.equal(parsed.request?.deadline.iso, '2026-10-30');
  assert.ok(parsed.request?.requiredContent.some(item => /experiment results/i.test(item.text)));

  const negative = explainRequest({ ...message, body: '请不要更新 Northstar 提案，也不用周五发送。' }, { now: message.receivedAt });
  assert.equal(negative.request, null);
  assert.equal(negative.rejection.code, 'no_request_form');

  const englishNegative = explainRequest({
    id: 'english-negative', from: 'alex@example.test', subject: 'Northstar proposal update',
    body: 'Please do not update or send the Northstar proposal by Friday.'
  });
  assert.equal(englishNegative.request, null);
  assert.equal(englishNegative.rejection.code, 'no_request_form');
});

test('wrong-association feedback excludes a document from assessment until the correction is undone', async () => workspace(({ engine, store }) => {
  engine.ingest(resultDocument());
  engine.ingest(requestMail('association-request'));
  const taskId = 'request:association-request';
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');

  const feedback = engine.recordTaskFeedback(taskId, {
    label: 'wrong_association',
    scope: { sender: 'alex@example.test', threadId: 'northstar-thread', subjectEntity: 'Northstar', deliverable: 'proposal', documentId: 'northstar-proposal' }
  });
  assert.equal(store.state.tasks[taskId].status, 'waiting_for_information');
  assert.equal(store.state.tasks[taskId].documentId, null);
  assert.ok(store.state.tasks[taskId].evidence.observations.some(item => item.id === 'feedback_excluded_document:northstar-proposal'));

  const changed = engine.ingest({
    ...resultDocument('northstar-proposal', `# Northstar proposal\n${results}\nAdditional note.`),
    id: 'feedback-corrected-document'
  });
  assert.deepEqual(changed.relations, []);
  assert.equal(changed.disposition, 'unrelated_change');

  engine.undoTaskFeedback(feedback.id);
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(store.state.tasks[taskId].documentId, 'northstar-proposal');
  assert.equal(store.state.outbox.length, 0);
}));

test('grounded discovery can rescue an unrecognized request but cannot accept an unanchored or negative one', async () => workspace(async ({ engine, store }) => {
  let calls = 0;
  const reasoner = availableReasoner({
    async discoverRequestCandidate() {
      calls += 1;
      return {
        deliverable: 'proposal', deliverableQuote: 'proposal',
        subjectEntity: 'northstar', entityQuote: 'northstar',
        intent: 'update', intentQuote: 'Please update the proposal',
        requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results' }]
      };
    },
    async interpretRequest() { return null; },
    async proposeProbes() { return []; }
  });
  const recoveredEngine = new WorkEngine(store, { reasoner });
  const candidate = {
    id: 'lowercase-project', from: 'alex@example.test', to: 'maya@example.test',
    threadId: 'lowercase-thread', subject: 'proposal update',
    body: 'Please update the proposal for northstar with experiment results.',
    receivedAt: '2026-10-25T09:00:00.000Z'
  };
  recoveredEngine.ingest({ id: 'candidate-event', type: 'email.received', payload: candidate });
  await recoveredEngine.whenSettled();
  assert.equal(store.state.tasks['request:lowercase-project']?.request.subjectEntity, 'northstar');
  assert.equal(store.state.events.find(event => event.payload?.id === candidate.id)?.reasoning.status, 'accepted');
  assert.equal(calls, 1);

  recoveredEngine.ingest({ id: 'negative-event', type: 'email.received', payload: {
    ...candidate, id: 'negative-message', threadId: 'negative-thread',
    body: 'Please do not update the proposal for northstar with experiment results.'
  } });
  await recoveredEngine.whenSettled();
  assert.equal(calls, 1, 'a negated request must not reach model discovery');
  assert.equal(store.state.tasks['request:negative-message'], undefined);

  const unanchoredReasoner = availableReasoner({
    async discoverRequestCandidate() {
      return {
        deliverable: 'proposal', deliverableQuote: 'proposal',
        subjectEntity: 'Atlantis', entityQuote: 'Atlantis',
        intent: 'update', intentQuote: 'Please update the proposal', requiredContent: []
      };
    },
    async interpretRequest() { return null; },
    async proposeProbes() { return []; }
  });
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-unanchored-'));
  const secondStore = new JsonStore(path.join(secondDir, 'state.json'));
  const secondEngine = new WorkEngine(secondStore, { reasoner: unanchoredReasoner });
  try {
    secondEngine.ingest({ id: 'unanchored-event', type: 'email.received', payload: { ...candidate, id: 'unanchored-message' } });
    await secondEngine.whenSettled();
    assert.equal(Object.keys(secondStore.state.tasks).length, 0);
    assert.equal(secondStore.state.events.find(event => event.payload?.id === 'unanchored-message')?.reasoning.status, 'no_candidate');
    assert.equal(secondStore.state.outbox.length, 0);
  } finally {
    await secondEngine.whenSettled();
    secondStore.close();
    fs.rmSync(secondDir, { recursive: true, force: true });
  }
}));

test('an older asynchronous discovery result is discarded after a newer thread message arrives', async () => workspace(async ({ store }) => {
  let release;
  const reasoner = availableReasoner({
    discoverRequestCandidate() {
      return new Promise(resolve => { release = () => resolve({
        deliverable: 'proposal', deliverableQuote: 'proposal',
        subjectEntity: 'northstar', entityQuote: 'northstar',
        intent: 'update', intentQuote: 'Please update the proposal', requiredContent: []
      }); });
    },
    async interpretRequest() { return null; },
    async proposeProbes() { return []; }
  });
  const engine = new WorkEngine(store, { reasoner });
  engine.ingest({ id: 'old-event', type: 'email.received', payload: {
    id: 'old-request', threadId: 'shared-thread', from: 'alex@example.test', to: 'maya@example.test',
    subject: 'proposal update', body: 'Please update the proposal for northstar with experiment results.',
    receivedAt: '2026-10-25T09:00:00.000Z'
  } });
  assert.equal(store.state.events.find(event => event.payload?.id === 'old-request')?.reasoning.status, 'running');

  engine.ingest(requestMail('new-request', {
    threadId: 'shared-thread', receivedAt: '2026-10-25T10:00:00.000Z',
    body: 'Please update the Northstar proposal with experiment results and send it.'
  }));
  release();
  await engine.whenSettled();

  assert.deepEqual(Object.keys(store.state.tasks), ['request:new-request']);
  assert.equal(store.state.events.find(event => event.payload?.id === 'old-request')?.reasoning.status, 'superseded');
  assert.equal(store.state.outbox.length, 0);
}));

test('a persisted running reasoning job resumes after restart once within its two-attempt bound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-reasoning-recovery-'));
  const filename = path.join(dir, 'state.json');
  let store = new JsonStore(filename);
  let engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  engine.ingest({ id: 'vague-event', type: 'email.received', payload: {
    id: 'vague-request', from: 'lee@example.test', subject: 'Zephyr report',
    body: 'Please update the Zephyr report with the details and send it by Friday.',
    receivedAt: '2026-10-25T09:00:00.000Z'
  } });
  const task = store.state.tasks['request:vague-request'];
  const plan = buildDeterministicPlan(task.request);
  const key = `${task.id}:1:interpret:${plan.signature}`;
  store.mutate(state => {
    state.tasks[task.id].reasoningWork = {
      key, kind: 'interpret', signature: plan.signature, requestVersion: 1,
      status: 'running', attempts: 1, maxAttempts: 2, updatedAt: '2026-10-25T09:01:00.000Z'
    };
    state.tasks[task.id].reasoning = { status: 'pending', kind: 'interpret', attempts: 1, maxAttempts: 2 };
  });
  store.close();

  let calls = 0;
  const reasoner = availableReasoner({
    async interpretRequest() { calls += 1; return null; },
    async discoverRequestCandidate() { return null; },
    async proposeProbes() { return []; }
  });
  store = new JsonStore(filename);
  engine = new WorkEngine(store, { reasoner });
  try {
    await engine.whenSettled();
    assert.equal(calls, 1);
    assert.equal(store.state.tasks[task.id].reasoningWork.attempts, 2);
    assert.equal(store.state.tasks[task.id].reasoningWork.status, 'complete');
    assert.equal(store.state.outbox.length, 0);
    assert.notEqual(store.state.tasks[task.id].status, 'completed');
    store.close();

    store = new JsonStore(filename);
    const neverAgain = availableReasoner({
      async interpretRequest() { throw new Error('a completed bounded job must not run again'); },
      async discoverRequestCandidate() { return null; },
      async proposeProbes() { return []; }
    });
    engine = new WorkEngine(store, { reasoner: neverAgain });
    await engine.whenSettled();
    assert.equal(store.state.tasks[task.id].reasoningWork.attempts, 2);
    assert.equal(store.state.tasks[task.id].reasoningWork.status, 'complete');
  } finally {
    if (engine.pending?.size) await engine.whenSettled();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery checks unfinished work without rewriting an unchanged state or active wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-stable-recovery-'));
  const filename = path.join(dir, 'state.json');
  let store = new JsonStore(filename);
  let engine = new WorkEngine(store, { reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
  engine.ingest(requestMail('stable-request'));
  engine.waitForTask('request:stable-request', { kind: 'time', until: '2099-01-01T00:00:00.000Z' });
  const before = fs.readFileSync(filename, 'utf8');
  const revision = store.state.revision;
  const waitEvaluatedAt = store.state.taskWaits['request:stable-request'].lastEvaluatedAt;
  store.close();

  store = new JsonStore(filename);
  engine = new WorkEngine(store, { reasoner: new NullReasoner(), stallAfterMs: 86_400_000 });
  try {
    assert.equal(store.state.revision, revision);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
    assert.equal(store.state.taskWaits['request:stable-request'].status, 'active');
    assert.equal(store.state.taskWaits['request:stable-request'].lastEvaluatedAt, waitEvaluatedAt);
  } finally {
    await engine.whenSettled();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery signatures include changed run dates even when a registry record keeps the same ID', async () => workspace(({ engine, store }) => {
  engine.ingest(resultDocument());
  engine.ingest(requestMail('same-run-id', {
    body: 'Please update the Northstar proposal with the latest experiment results and send it.'
  }));
  const taskId = 'request:same-run-id';
  const run = (eventId, completedAt) => engine.ingest({
    id: eventId, type: 'experiment.run.completed', payload: {
      id: 'northstar-latest-run', label: 'Northstar latest run', subjectEntity: 'Northstar',
      completedAt, source: { kind: 'test_registry', id: 'northstar-runs' }
    }
  });
  run('run-record-v1', '2026-10-24T12:00:00.000Z');
  assert.equal(store.state.tasks[taskId].evidence.freshness.status, 'verified');

  run('run-record-v2', '2026-10-26T12:00:00.000Z');
  assert.equal(store.state.tasks[taskId].evidence.freshness.status, 'stale');
  assert.notEqual(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(store.state.tasks[taskId].draft, null);
}));

test('withdrawal after provider acceptance preserves the action and reports it was not undone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-accepted-withdrawal-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  let releaseVerification;
  class PausedVerifyProvider extends SimulatedMailProvider {
    verifyReceipt(receipt) {
      const verified = super.verifyReceipt(receipt);
      return new Promise(resolve => { releaseVerification = () => resolve(verified); });
    }
  }
  const provider = new PausedVerifyProvider(store);
  const engine = new WorkEngine(store, { provider, reasoner: new NullReasoner() });
  try {
    engine.ingest(resultDocument());
    engine.ingest(requestMail('accepted-request'));
    const task = store.state.tasks['request:accepted-request'];
    assert.equal(task.status, 'ready_for_approval');
    const sending = Promise.resolve(engine.approve(task.id));
    assert.equal(store.state.outbox.length, 1, 'the provider accepted the action before read-back completed');
    assert.equal(store.state.tasks[task.id].action.status, 'executing');

    engine.ingest(requestMail('accepted-withdrawal', {
      receivedAt: '2026-10-25T12:00:00.000Z',
      body: 'Please cancel the Northstar proposal request.'
    }));
    assert.equal(store.state.tasks[task.id].status, 'verifying');
    assert.equal(store.state.tasks[task.id].commitment.status, 'withdrawn_pending_reconciliation');

    releaseVerification();
    await sending;
    await engine.whenSettled();
    const resolved = store.state.tasks[task.id];
    assert.equal(resolved.status, 'cancelled');
    assert.equal(resolved.commitment.status, 'withdrawn_after_delivery');
    assert.equal(resolved.action, null);
    assert.equal(resolved.actionHistory.at(-1).status, 'verified_simulated');
    assert.match(resolved.reason, /not undone/i);
    assert.equal(store.state.outbox.length, 1);
  } finally {
    releaseVerification?.();
    await engine.whenSettled();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a same-thread request revision makes an already prepared document patch stale', async () => workspace(async ({ engine, store }) => {
  const url = 'https://docs.example.test/northstar';
  const targetContent = '# Northstar proposal\n';
  engine.ingest({ ...resultDocument('northstar-proposal', targetContent), payload: {
    ...resultDocument('northstar-proposal', targetContent).payload, url
  } });
  engine.ingest({ id: 'source-results', type: 'document.modified', payload: {
    id: 'experiment-notes', title: 'Northstar experiment notes', kind: 'notes', content: results
  } });
  engine.ingest(requestMail('patch-request', {
    body: `Please update the Northstar proposal with the experiment results and send it. Use ${url}`
  }));
  const taskId = 'request:patch-request';
  const patch = await engine.prepareDocumentPatch(taskId, { provider: 'local', changes: [{
    type: 'append', text: results,
    source: { kind: 'document', id: 'experiment-notes', version: 1, quote: results }
  }] });
  assert.equal(patch.status, 'prepared');

  engine.ingest(requestMail('patch-revision', {
    receivedAt: '2026-10-25T11:00:00.000Z',
    body: 'The Northstar proposal deadline is now 2026-11-12.'
  }));
  const before = store.state.documents['northstar-proposal'].content;
  await assert.rejects(() => engine.applyDocumentPatch(taskId, {
    patchId: patch.id,
    authorization: {
      kind: 'explicit', taskId, patchId: patch.id,
      baseDocumentVersion: patch.baseDocument.version, confirmed: true
    }
  }), /request changed/i);
  assert.equal(store.state.documentPatches[patch.id].status, 'stale');
  assert.equal(store.state.documents['northstar-proposal'].content, before);
  assert.equal(store.state.outbox.length, 0);
}));
