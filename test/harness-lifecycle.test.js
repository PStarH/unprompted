import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SCENARIOS } from '../eval/scenarios.js';

const fixture = SCENARIOS.find(item => item.id === 'model-proposes-valid-probe');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const timeout = () => Object.assign(new Error('Model request timed out.'), { code: 'ETIMEDOUT' });
const reasonerFor = proposeProbes => ({ available: () => true, async interpretRequest() { return null; }, proposeProbes });
const oneTurn = () => new Promise(resolve => setImmediate(resolve));

async function workspace(reasoner, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-harness-lifecycle-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store, { reasoner });
  try {
    for (const event of fixture.events) {
      const input = structuredClone(event);
      if (input.type === 'email.received') input.payload.threadId = 'lifecycle-thread';
      engine.ingest(input);
    }
    return await run({ engine, store, id: 'request:mp-1', directory });
  } finally {
    await engine.whenSettled();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a cancelled task cannot be rewritten by a late model failure', async () => {
  const pending = deferred();
  await workspace(reasonerFor(() => pending.promise), async ({ engine, store, id }) => {
    try {
      await oneTurn();
      engine.ingest({ id: 'withdraw-vendor-event', type: 'email.received', payload: {
        ...fixture.events[0].payload, id: 'withdraw-vendor-message', threadId: 'lifecycle-thread',
        body: 'Please cancel this request. No need to send the report.', receivedAt: '2026-10-16T10:00:00.000Z'
      } });
      assert.equal(store.state.tasks[id].status, 'cancelled');
      const cancelled = JSON.stringify(store.state);
      pending.reject(timeout());
      await engine.whenSettled();
      assert.equal(JSON.stringify(store.state), cancelled);
      assert.equal(store.state.outbox.length, 0);
    } finally { pending.resolve([]); }
  });
});

test('an old probe failure cannot replace the reasoning state of a revised request', async () => {
  const attempts = [];
  await workspace(reasonerFor(() => { const attempt = deferred(); attempts.push(attempt); return attempt.promise; }), async ({ engine, store, id }) => {
    try {
      await oneTurn();
      assert.equal(attempts.length, 1);
      engine.ingest({ id: 'revised-vendor-event', type: 'email.received', payload: {
        ...fixture.events[0].payload, id: 'revised-vendor-message', threadId: 'lifecycle-thread',
        body: 'Please update the Draco vendor report with the vendor reconciliation notes and sample size and send it by Friday.',
        receivedAt: '2026-10-16T10:00:00.000Z'
      } });
      await oneTurn();
      assert.equal(store.state.tasks[id].commitment.revision, 2);
      const expected = structuredClone(store.state.tasks[id].reasoning);
      attempts[0].reject(timeout());
      await oneTurn();
      assert.deepEqual(store.state.tasks[id].reasoning, expected);
    } finally {
      for (const attempt of attempts) attempt.resolve(structuredClone(fixture.reasoner.probes));
    }
  });
});

test('synchronous adapter errors are contained as reasoning failures', async () => {
  let calls = 0;
  await workspace(reasonerFor(() => { calls++; throw timeout(); }), async ({ engine, store, id }) => {
    await engine.whenSettled();
    assert.equal(calls, 1);
    assert.equal(store.state.tasks[id].reasoningWork.status, 'failed');
    assert.equal(store.state.outbox.length, 0);
  });
});

test('a transient read failure retries only when due and then accepts grounded evidence', async () => {
  let calls = 0;
  await workspace(reasonerFor(async () => {
    if (++calls === 1) throw timeout();
    return structuredClone(fixture.reasoner.probes);
  }), async ({ engine, store, id }) => {
    await engine.whenSettled();
    const work = store.state.tasks[id].reasoningWork;
    assert.equal(work.retryable, true);
    assert.ok(Date.parse(work.retryAt) > Date.parse(work.updatedAt));
    const revision = store.state.revision;
    engine.retryPendingReasoning(null, { dueOnly: true, now: new Date(Date.parse(work.retryAt) - 1) });
    assert.equal(calls, 1);
    assert.equal(store.state.revision, revision, 'waiting for a retry is read-only');
    engine.retryPendingReasoning(null, { dueOnly: true, now: new Date(work.retryAt) });
    await engine.whenSettled();
    assert.equal(calls, 2);
    assert.equal(store.state.tasks[id].reasoningWork.status, 'complete');
    assert.equal(store.state.tasks[id].status, 'ready_for_approval');
    assert.equal(store.state.outbox.length, 0, 'a read retry cannot approve or send');
  });
});

test('invalid model output is terminal for automatic recovery', async () => {
  let calls = 0;
  await workspace(reasonerFor(async () => { calls++; throw new SyntaxError('Invalid JSON response'); }), async ({ engine, store, id }) => {
    await engine.whenSettled();
    const work = store.state.tasks[id].reasoningWork;
    assert.equal(work.retryable, false);
    assert.equal(work.retryAt, null);
    const revision = store.state.revision;
    for (let index = 0; index < 4; index++) engine.retryPendingReasoning(null, { dueOnly: true, now: new Date('2099-01-01') });
    await engine.whenSettled();
    assert.equal(calls, 1);
    assert.equal(store.state.revision, revision);
  });
});

test('repeated transient failures exhaust their durable attempt ceiling', async () => {
  let calls = 0;
  await workspace(reasonerFor(async () => { calls++; throw timeout(); }), async ({ engine, store, id }) => {
    await engine.whenSettled();
    engine.retryPendingReasoning(null, { dueOnly: true, now: new Date('2099-01-01') });
    await engine.whenSettled();
    const task = store.state.tasks[id];
    assert.equal(calls, 2);
    assert.equal(task.reasoningWork.terminalReason, 'attempts_exhausted');
    const revision = store.state.revision;
    engine.retryPendingReasoning(null, { dueOnly: true, now: new Date('2099-01-02') });
    await engine.whenSettled();
    assert.equal(calls, 2);
    assert.equal(store.state.revision, revision);
    assert.notEqual(task.status, 'completed');
  });
});

test('restart preserves a saved backoff rather than spending another attempt immediately', async () => {
  let calls = 0;
  const reasoner = reasonerFor(async () => {
    if (++calls === 1) throw timeout();
    return structuredClone(fixture.reasoner.probes);
  });
  await workspace(reasoner, async ({ engine, store, id }) => {
    await engine.whenSettled();
    const retryAt = store.state.tasks[id].reasoningWork.retryAt;
    store.close();
    const restoredStore = new JsonStore(store.filename);
    const restored = new WorkEngine(restoredStore, { reasoner });
    try {
      await restored.whenSettled();
      assert.equal(calls, 1);
      assert.equal(restoredStore.state.tasks[id].reasoningWork.retryAt, retryAt);
      restored.retryPendingReasoning(null, { dueOnly: true, now: new Date(retryAt) });
      await restored.whenSettled();
      assert.equal(calls, 2);
      assert.equal(restoredStore.state.tasks[id].reasoningWork.status, 'complete');
      assert.equal(restoredStore.state.outbox.length, 0);
    } finally { await restored.whenSettled(); restoredStore.close(); }
  });
});

test('automatic maintenance admits at most two saved read jobs and does not overlap active attempts', async () => {
  const held = [];
  let calls = 0, hold = false;
  await workspace(reasonerFor(async () => {
    calls++;
    if (!hold) throw timeout();
    const pending = deferred(); held.push(pending); return pending.promise;
  }), async ({ engine, store }) => {
    try {
      for (let index = 0; index < 4; index++) engine.ingest({
        ...structuredClone(fixture.events[0]), id: `burst-event-${index}`,
        payload: { ...fixture.events[0].payload, id: `burst-message-${index}`, threadId: `burst-thread-${index}` }
      });
      await engine.whenSettled();
      assert.equal(Object.keys(store.state.tasks).length, 5);
      const initialCalls = calls;
      hold = true;
      const started = engine.retryPendingReasoning(null, { dueOnly: true, now: new Date('2099-01-01') });
      await oneTurn();
      assert.equal(started.tasks, 2);
      assert.equal(calls, initialCalls + 2);
      const revision = store.state.revision;
      assert.equal(engine.retryPendingReasoning(null, { dueOnly: true, now: new Date('2099-01-01') }).tasks, 0);
      assert.equal(store.state.revision, revision);
    } finally { for (const pending of held) pending.resolve([]); }
  });
});

test('failed grounded discovery can recover when due without creating a duplicate task', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-discovery-retry-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  let calls = 0;
  const reasoner = { ...reasonerFor(async () => []), async discoverRequestCandidate() {
    if (++calls === 1) throw timeout();
    return { deliverable: 'proposal', deliverableQuote: 'proposal', subjectEntity: 'northstar', entityQuote: 'northstar',
      intent: 'update', intentQuote: 'Please update the proposal', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results' }] };
  } };
  const engine = new WorkEngine(store, { reasoner });
  try {
    engine.ingest({ id: 'rescue-event', type: 'email.received', payload: {
      id: 'rescue-message', threadId: 'rescue-thread', from: 'alex@example.test', subject: 'proposal update',
      body: 'Please update the proposal for northstar with experiment results.'
    } });
    await engine.whenSettled();
    assert.equal(Object.keys(store.state.tasks).length, 0);
    const work = store.state.events.find(event => event.id === 'rescue-event').reasoning;
    assert.equal(work.retryable, true);
    engine.retryPendingReasoning(null, { dueOnly: true, now: new Date(work.retryAt) });
    await engine.whenSettled();
    assert.equal(calls, 2);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    const revision = store.state.revision;
    engine.retryPendingReasoning(null, { dueOnly: true, now: new Date('2099-01-01') });
    await engine.whenSettled();
    assert.equal(calls, 2);
    assert.equal(Object.keys(store.state.tasks).length, 1);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(store.state.revision, revision);
  } finally { await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
