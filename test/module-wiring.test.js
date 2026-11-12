import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { CursorStore } from '../src/connectors/connector.js';

const email = (id, threadId, subject, body, source = 'simulated') => ({
  id: `event:${id}`, type: 'email.received', source, connectorId: source,
  payload: { id, threadId, from: 'alex@example.test', to: 'reader@example.test', subject, body, receivedAt: '2026-10-26T10:00:00Z' }
});

function open(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-wiring-'));
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store);
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime, directory };
}

test('a task run can read stored failure statements without creating work', async t => {
  const { store, engine, runtime } = open(t);
  runtime.suspended = true;
  engine.ingest(email('initial', 'cedar-thread', 'Cedar proposal', 'Please update the Cedar budget proposal with the experiment results and send it by Friday.'));
  engine.ingest(email('failed', 'ci-thread', 'Nightly build failed', 'The nightly build failed after 12 minutes.'));
  engine.ingest(email('outsider', 'other-thread', 'Nightly build failed', 'The nightly build failed after 12 minutes.', 'partner-feed'));
  const task = store.tasks.get('request:initial');
  assert.ok(task);
  const taskIds = Object.keys(store.state.tasks).sort();
  const notices = (store.state.notifications || []).length;
  const queued = runtime.jobs.list().find(job => job.task_id === task.id && ['queued', 'retry_wait'].includes(job.state));
  const job = runtime.jobs.claim('wiring-test', { id: queued.id });
  const run = runtime.tasks.beginRun(job);
  runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: Number(runtime.database.get('context_version')), sources: [], plan: {} });
  runtime.suspended = false;
  await runtime.scope.run({ taskId: task.id, job, run, context: { memories: [], experiences: [], events: [], arbitration: {} } }, async () => {
    const tool = runtime.tools({ taskId: task.id, isCurrent: () => true }).find(item => item.name === 'observe_failures');
    const report = JSON.parse((await tool.execute('observe', {})).content[0].text);
    assert.equal(report.rule, 'failure-report');
    assert.deepEqual(report.observations.map(item => item.eventRef.id), ['event:failed']);
    assert.equal(report.observations[0].evidence[0].marker, 'states-failure');
    const planning = runtime.planningContext(task.id);
    assert.equal(planning.failureObservations[0].eventRef.id, 'event:failed');
    engine.mode = 'live';
    assert.equal(runtime.failureSignals().observations.length, 0);
    engine.mode = 'simulation';
    runtime.tasks.finish(run, job);
    runtime.jobs.complete(job);
    await assert.rejects(tool.execute('stale', {}), { code: 'TASK_CONTEXT_UNAVAILABLE' });
  });
  assert.deepEqual(Object.keys(store.state.tasks).sort(), taskIds);
  assert.equal((store.state.notifications || []).length, notices);
});

test('connector sync reads history once and later polls do not call it again', async t => {
  const { store, engine, runtime } = open(t);
  runtime.suspended = true;
  let calls = 0;
  const connector = {
    id: 'google', live: true,
    async pull() { return { events: [], cursor: { gmail: { historyId: 'h1' } }, hasMore: false }; },
    async listHistoricalEvents() {
      calls += 1;
      return { events: [email('old', 'old-thread', 'Older note', 'Hello from the older window.', 'google')], networkCalls: 1, unavailable: false };
    }
  };
  runtime.connectorFor = id => id === 'google' ? connector : null;
  const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
  const first = await sync.run();
  assert.equal(calls, 1);
  assert.equal(first.results[0].history.historyDiscovery, 'available');
  assert.equal(first.results[0].history.advanced, 1);
  assert.equal(store.state.events.some(event => event.id === 'event:old'), true);
  const second = await sync.run();
  assert.equal(calls, 1);
  assert.equal(second.results[0].history.historyDiscovery, 'already');
  assert.equal(second.results[0].history.networkCalls, 0);
});
