import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { observeFailureSignals, FAILURE_RULE } from '../src/observation.js';

/**
 * Phase 0 failure observation.
 *
 * The guarantee worth pinning: an authorized event's content decides whether a
 * failure is observed — nothing else does. A single event is observable;
 * recurrence is an analysis count, never a gate; and signatures fingerprint the
 * evidence instead of claiming that two events share a root cause.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

const AUTHORIZED = ['google', 'simulated'];
const at = '2026-10-18T09:00:00.000Z';

const emailEvent = (name, { subject, body, source = 'google' } = {}) => ({
  id: `event-email-${name}`,
  type: 'email.received',
  at,
  source,
  connectorId: source,
  providerEventId: `provider-${name}`,
  summary: '',
  relations: [],
  disposition: '',
  payload: { id: `mail-${name}`, from: 'ci@example.test', subject, body }
});

const stateWith = (...events) => ({ events });
const observe = events => observeFailureSignals(stateWith(...events), { authorizedSources: AUTHORIZED });

test('a single clear failure is observed once, with provenance, evidence and a stable signature', () => {
  const event = emailEvent('bench', {
    subject: 'Bench crashed on the postgres-runtime build',
    body: "Error: Cannot find module '@praetor/postgres-runtime'\nProcess completed with exit code 1."
  });
  const report = observe([event]);
  assert.equal(report.rule, 'failure-report');
  assert.equal(report.ruleVersion, FAILURE_RULE.version);
  assert.equal(report.observations.length, 1, 'one event is enough; recurrence is not a prerequisite');
  assert.deepEqual(report.counts, { unauthorized: 0, notEmail: 0, unreadable: 0, nonFailure: 0 });
  const [observation] = report.observations;
  assert.equal(observation.family, 'failure-report');
  assert.equal(observation.eventRef.id, event.id);
  assert.equal(observation.eventRef.at, at);
  assert.equal(observation.eventRef.source, 'google');
  assert.deepEqual(observation.discriminators.markers, ['states-crash', 'error-detail', 'exit-code', 'missing-module']);
  assert.ok(observation.evidence.some(item => item.marker === 'missing-module' && item.captured === '@praetor/postgres-runtime'));
  assert.ok(observation.evidence.some(item => item.marker === 'exit-code' && item.captured === '1'));
  assert.ok(observation.evidence.every(item => item.basis && item.excerpt));
  assert.match(observation.signature, /^[0-9a-f]{64}$/);
});

test('messages that merely talk about errors, or report success, are not observations', () => {
  const report = observe([
    emailEvent('digest', {
      subject: 'Weekly digest: the ten most common errors in CI',
      body: 'A round-up of recurring failure patterns and how to avoid them next quarter.'
    }),
    emailEvent('success', {
      subject: 'Baseline PR passed',
      body: 'All 120 checks passed, 0 failed. No action needed.'
    }),
    emailEvent('question', {
      subject: 'Beacon incident report — review?',
      body: 'Could you take a look at the Beacon reliability report this week?'
    })
  ]);
  assert.equal(report.observations.length, 0);
  assert.equal(report.counts.nonFailure, 3);
});

test('only events from authorized sources are read, and authorization decides by source alone', () => {
  const known = emailEvent('known', { subject: 'Nightly build failed', body: 'The nightly build failed after 12 minutes.' });
  const outsider = emailEvent('outsider', {
    subject: 'Nightly build failed', body: 'The nightly build failed after 12 minutes.', source: 'partner-feed'
  });
  const report = observe([known, outsider]);
  assert.equal(report.observations.length, 1, 'the same sender and wording do not authorize an unlisted source');
  assert.equal(report.observations[0].eventRef.id, known.id);
  assert.equal(report.counts.unauthorized, 1);
  const failClosed = observeFailureSignals(stateWith(known), {});
  assert.equal(failClosed.observations.length, 0, 'no authorized sources means nothing is read');
  assert.equal(failClosed.counts.unauthorized, 1);
});

test('identical input and rule version derive identical observations, and observation writes nothing', () => {
  const event = emailEvent('run-a', {
    subject: 'Open baseline PR failed',
    body: 'git push declined: remote returned 400 (exit code 128).'
  });
  const state = stateWith(event);
  const snapshot = JSON.stringify(state);
  const first = observeFailureSignals(state, { authorizedSources: AUTHORIZED });
  assert.equal(JSON.stringify(state), snapshot, 'observation must not write into the state it reads');
  const again = observeFailureSignals(state, { authorizedSources: AUTHORIZED });
  assert.deepEqual(first, again, 'same input and rule version, same report');

  const twin = emailEvent('run-b', {
    subject: 'Open baseline PR failed',
    body: 'git push declined: remote returned 400 (exit code 128).'
  });
  const pair = observe([event, twin]);
  assert.equal(pair.observations.length, 2);
  const signature = pair.observations[0].signature;
  assert.equal(pair.observations[1].signature, signature, 'equal evidence yields the same signature');
  assert.equal(pair.signatureCounts[signature], 2, 'recurrence is reported as an analysis count only');
});

test('same-looking failures with different underlying evidence keep different signatures', () => {
  const permission = emailEvent('perm', {
    subject: 'Open baseline PR failed',
    body: 'git push failed: permission denied (exit code 1).'
  });
  const missing = emailEvent('mod', {
    subject: 'Open baseline PR failed',
    body: "bench crashed: Error: Cannot find module '@praetor/postgres-runtime'"
  });
  const report = observe([permission, missing]);
  assert.equal(report.observations.length, 2, 'nothing is merged into one root-cause claim');
  const [first, second] = report.observations;
  assert.notEqual(first.signature, second.signature, 'the discriminators decide the signature, not the shared wording');
  assert.ok(first.discriminators.markers.includes('permission-denied'));
  assert.ok(second.discriminators.markers.includes('missing-module'));
  assert.equal(report.signatureCounts[first.signature], 1);
  assert.equal(report.signatureCounts[second.signature], 1);
});

test('an authorized email the rule cannot read is counted, not observed and not crashed on', () => {
  const broken = {
    id: 'event-email-broken', type: 'email.received', at, source: 'google', connectorId: 'google',
    providerEventId: null, summary: '', relations: [], disposition: '', payload: {}
  };
  const document = { id: 'doc-1', type: 'document.modified', at, source: 'google', payload: { title: 'proposal' } };
  const report = observe([broken, document]);
  assert.equal(report.observations.length, 0);
  assert.equal(report.counts.unreadable, 1);
  assert.equal(report.counts.notEmail, 1);
});

test('observation derives from the event representation the engine actually writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-observe-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  const event = emailEvent('live', {
    subject: 'Open baseline PR failed',
    body: 'Process completed with exit code 128 (git 400).'
  });
  engine.ingest(event);
  const report = observeFailureSignals(store.state, { authorizedSources: ['google'] });
  assert.equal(report.observations.length, 1);
  assert.equal(report.observations[0].eventRef.id, event.id);
  assert.equal(report.observations[0].eventRef.at, at);
  assert.ok(report.observations[0].evidence.some(item => item.marker === 'exit-code' && item.captured === '128'));
});
