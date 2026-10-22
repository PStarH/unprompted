import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';

/**
 * Ordering guarantees for synchronised context.
 *
 * A cursor-based sync normally delivers changes in order, but a retry, a second
 * connector or a provider outage can deliver an older revision after a newer one
 * has already been applied. The rule under test: newer state is never regressed
 * by an older arrival, and nothing is silently dropped — the out-of-order event
 * is recorded and attributed.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-ordering-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = id => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  }
});
const document = (id, content, modifiedAt) => ({
  id: `event-doc-${id}`, type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal', content, modifiedAt
  }
});
const COMPLETE = '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n';
const INCOMPLETE = '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\n';

test('an older revision arriving late never overwrites newer state', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  const newer = engine.ingest(document('v2', COMPLETE, '2026-10-16T12:00:00.000Z'));
  assert.equal(newer.disposition, 'related_change');
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');

  const late = engine.ingest(document('v1', INCOMPLETE, '2026-10-16T09:00:00.000Z'));
  assert.equal(late.disposition, 'stale_change', 'the stale revision is attributed, not silently dropped');
  assert.deepEqual(late.relations, []);
  assert.equal(store.state.documents['northstar-proposal'].version, 1, 'the stored version did not move');
  assert.match(store.state.documents['northstar-proposal'].content, /Treatment improved conversion/);
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval', 'verified work was not regressed');
});

test('a genuinely newer revision is applied and the work is reassessed', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(document('v1', COMPLETE, '2026-10-16T09:00:00.000Z'));
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');

  const newer = engine.ingest(document('v2', INCOMPLETE, '2026-10-16T12:00:00.000Z'));
  assert.equal(newer.disposition, 'related_change');
  assert.equal(store.state.documents['northstar-proposal'].version, 2);
  assert.equal(store.state.tasks['request:m1'].status, 'waiting_for_information', 'losing evidence is discovered, not hidden');
});

test('a late-arriving older run record does not disturb a verified freshness claim', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(document('v1', COMPLETE, '2026-10-16T09:00:00.000Z'));
  engine.ingest({
    id: 'event-run-current', type: 'experiment.run.completed', payload: {
      id: 'northstar-run-2026-10-16', label: 'Northstar run 2026-10-16', subjectEntity: 'Northstar',
      completedAt: '2026-10-16T12:00:00.000Z', source: { kind: 'run_registry', id: 'test-registry' }
    }
  });
  assert.equal(store.state.tasks['request:m1'].assessment.freshness.status, 'verified');

  engine.ingest({
    id: 'event-run-late', type: 'experiment.run.completed', payload: {
      id: 'northstar-run-2026-10-10', label: 'Northstar run 2026-10-10', subjectEntity: 'Northstar',
      completedAt: '2026-10-10T12:00:00.000Z', source: { kind: 'run_registry', id: 'test-registry' }
    }
  });
  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'ready_for_approval', 'newest-known-run ordering is by date, not arrival');
  assert.equal(task.assessment.freshness.newestRun, 'northstar-run-2026-10-16');
  assert.equal(Object.keys(store.state.runRecords).length, 2, 'the late record is kept as context, not discarded');
});

test('a newer run record is applied and makes the verified claim stale', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(document('v1', COMPLETE, '2026-10-16T09:00:00.000Z'));
  engine.ingest({
    id: 'event-run-current', type: 'experiment.run.completed', payload: {
      id: 'northstar-run-2026-10-16', label: 'Northstar run 2026-10-16', subjectEntity: 'Northstar',
      completedAt: '2026-10-16T12:00:00.000Z', source: { kind: 'run_registry', id: 'test-registry' }
    }
  });
  assert.equal(store.state.tasks['request:m1'].status, 'ready_for_approval');

  engine.ingest({
    id: 'event-run-newer', type: 'experiment.run.completed', payload: {
      id: 'northstar-run-2026-10-17', label: 'Northstar run 2026-10-17', subjectEntity: 'Northstar',
      completedAt: '2026-10-17T12:00:00.000Z', source: { kind: 'run_registry', id: 'test-registry' }
    }
  });
  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'waiting_for_information', 'the document no longer shows the latest evidence');
  assert.equal(task.assessment.freshness.status, 'stale');
  assert.equal(store.state.outbox.length, 0, 'staleness is never resolved by sending anyway');
});
