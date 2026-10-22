import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { computeProductMetrics } from '../src/metrics.js';

/**
 * Product-value metrics.
 *
 * These assert that the metrics are derived from recorded outcomes (so they can
 * be checked) and that they measure product outcomes rather than activity.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-metrics-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = (id = 'm1') => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal.'
  }
});
const doc = () => ({
  id: 'event-doc', type: 'document.modified', payload: {
    id: 'northstar-proposal', kind: 'proposal', title: 'Northstar project proposal',
    content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'
  }
});

test('metrics are derived from recorded outcomes, with a basis for every number', () => {
  const state = {
    tasks: {
      completed: { id: 'completed', status: 'completed', draft: { withheldClaims: [] }, action: { status: 'verified_simulated' }, documentId: 'd1', evidence: { plan: { unverifiable: [] } } },
      unservable: { id: 'unservable', status: 'waiting_for_information', documentId: null, evidence: { plan: { unverifiable: [{ text: 'a signed agreement' }] } } },
      waiting: { id: 'waiting', status: 'waiting_for_information', documentId: 'd2', evidence: { plan: { unverifiable: [] } } }
    },
    history: [{ kind: 'rejection' }, { kind: 'retry' }, { kind: 'reconciliation' }],
    notifications: [{ kind: 'deadline', resolvedAt: null }, { kind: 'blocker', resolvedAt: '2026-10-16T10:00:00.000Z' }],
    calibrations: { one: { key: 'preference:x', correctedAt: '2026-10-16T10:00:00.000Z' } },
    opportunities: { a: { status: 'proposed' }, b: { status: 'dismissed' } }
  };
  const metrics = computeProductMetrics(state, { now: '2026-10-16T00:00:00.000Z' });

  assert.equal(metrics.discovery.discovered, 3);
  assert.equal(metrics.discovery.valuable, 1);
  assert.equal(metrics.discovery.unservable, 1);
  assert.equal(metrics.discovery.waiting, 1);
  assert.equal(metrics.discovery.unservableRate, 0.333);
  assert.equal(metrics.completion.preparedActions, 1);
  assert.equal(metrics.completion.verifiedCompletions, 1);
  assert.equal(metrics.completion.verifiableCompletionRate, 1);
  assert.equal(metrics.attention.interruptions, 2);
  assert.equal(metrics.attention.unresolved, 1);
  assert.equal(metrics.attention.takeovers, 4, 'three overrides plus one correction');
  assert.equal(metrics.value.estimatedManualStepsAvoided, 1);
  assert.ok(metrics.value.basis.length > 0, 'the value estimate carries its own basis like every other block');
  assert.equal(metrics.opportunities.proposed, 1);
  assert.equal(metrics.opportunities.dismissed, 1);
  assert.ok(metrics.discovery.basis.length > 0);
  assert.ok(metrics.attention.basis.length > 0);
});

test('a discovered, prepared and verified task scores as valuable and complete', async () => {
  const { engine } = setup();
  engine.ingest(email());
  engine.ingest(doc());
  await engine.approve('request:m1');
  const metrics = engine.publicState().metrics;
  assert.equal(metrics.discovery.discovered, 1);
  assert.equal(metrics.discovery.valuableRate, 1);
  assert.equal(metrics.discovery.unservableRate, 0);
  assert.equal(metrics.completion.verifiableCompletionRate, 1);
  assert.equal(metrics.attention.interruptions, 0, 'a quiet happy path does not interrupt anyone');
  assert.equal(metrics.attention.takeovers, 0);
});

test('rejecting a draft, and correcting the system, both count as user takeovers', () => {
  const { engine } = setup();
  engine.ingest(email());
  engine.ingest(doc());
  engine.reject('request:m1');
  assert.equal(engine.publicState().metrics.attention.takeovers, 1);

  engine.recordCalibration({ key: 'preference:reply_tone', kind: 'preference', value: 'concise' });
  engine.correctCalibration({ key: 'preference:reply_tone', value: 'formal' });
  assert.equal(engine.publicState().metrics.attention.takeovers, 2);
});

test('a completion that was never verified is never counted as complete', () => {
  const state = {
    tasks: { t: { id: 't', status: 'completed', documentId: 'd', draft: {}, action: { status: 'uncertain' }, evidence: { plan: { unverifiable: [] } } } },
    history: [], notifications: [], calibrations: {}, opportunities: {}
  };
  const metrics = computeProductMetrics(state);
  assert.equal(metrics.completion.verifiedCompletions, 0);
  assert.equal(metrics.completion.unverifiedCompletions, 1);
  assert.equal(metrics.completion.verifiableCompletionRate, 0);
});

test('the verified-completion count is independently derivable from outbox receipts', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  engine.approve('request:m1');
  const metrics = computeProductMetrics(store.state);
  // Cross-source check (D8): the metric must agree with the provider receipts,
  // not merely with its own predicate.
  const receipts = new Set(store.state.outbox.map(item => item.idempotencyKey));
  const receiptBacked = Object.values(store.state.tasks).filter(task =>
    task.status === 'completed' && task.action && receipts.has(task.action.idempotencyKey));
  assert.equal(metrics.completion.verifiedCompletions, 1);
  assert.equal(metrics.completion.verifiedCompletions, receiptBacked.length, 'the metric and the receipts must tell the same story');
});

test('a request the user closed while waiting counts as closed — not noise, not unfinished', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.cancel('request:m1');
  const metrics = computeProductMetrics(store.state);
  assert.equal(metrics.discovery.discovered, 1);
  assert.equal(metrics.discovery.closed, 1);
  assert.equal(metrics.discovery.waiting, 0, 'a closed request is not still waiting');
  assert.equal(metrics.discovery.unservable, 0, 'a closed request is not noise');
  assert.equal(metrics.discovery.valuable, 0);
  assert.ok(metrics.discovery.basis.some(line => /closed =/.test(line)));
});
