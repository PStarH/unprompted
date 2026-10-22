import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import {
  recordCalibration, inferCalibration, correctCalibration, usableCalibration, findCalibration,
  needsCalibration, grantFor, scopeCovers, CONFIDENCE, PERMISSION_KEYS
} from '../src/calibration.js';

/**
 * User calibration.
 *
 * These tests pin two guarantees that are easy to get wrong: a single observed
 * behaviour must never become a permanent rule, and a fact stated by the user must
 * always outrank an inference.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-calibration-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = (id, project = 'Northstar') => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: `${project} proposal — experiment results`,
    body: `Please update the ${project} project proposal with the latest experiment results and send the revised proposal by Friday.`
  }
});
const complete = project => ({
  id: `event-doc-${project}`, type: 'document.modified', payload: {
    id: `${project.toLowerCase()}-proposal`, kind: 'proposal', title: `${project} project proposal`,
    content: `# ${project} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n`
  }
});

test('a single inferred observation is never treated as a rule', () => {
  const calibrations = {};
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  const entry = usableCalibration(calibrations, 'preference:reply_tone', { entity: 'Northstar' });
  assert.equal(entry, null, 'one observation must not govern a decision');
  assert.equal(findCalibration(calibrations, 'preference:reply_tone', { entity: 'Northstar' }).confidence, CONFIDENCE.SINGLE_OBSERVATION);
});

test('consistent repetition promotes an inference to a working assumption', () => {
  const calibrations = {};
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  const entry = usableCalibration(calibrations, 'preference:reply_tone', { entity: 'Northstar' });
  assert.ok(entry, 'a repeated, consistent observation may be relied on');
  assert.equal(entry.confidence, CONFIDENCE.WORKING_ASSUMPTION);
  assert.equal(entry.source, 'inferred');
});

test('a conflicting observation drops an inference back to a single observation', () => {
  const calibrations = {};
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'detailed', scope: { entity: 'Northstar' } });
  assert.equal(usableCalibration(calibrations, 'preference:reply_tone', { entity: 'Northstar' }), null);
});

test('a stated fact outranks an inference and is never overwritten by behaviour', () => {
  const calibrations = {};
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  recordCalibration(calibrations, { key: 'preference:reply_tone', value: 'formal', scope: { entity: 'Northstar' } });
  inferCalibration(calibrations, { key: 'preference:reply_tone', value: 'casual', scope: { entity: 'Northstar' } });
  const entry = usableCalibration(calibrations, 'preference:reply_tone', { entity: 'Northstar' });
  assert.equal(entry.value, 'formal');
  assert.equal(entry.source, 'user_stated');
  assert.equal(entry.confidence, CONFIDENCE.STATED);
});

test('a permission is never inferred from behaviour, only stated by the user', () => {
  const calibrations = {};
  inferCalibration(calibrations, { key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  inferCalibration(calibrations, { key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  assert.equal(usableCalibration(calibrations, PERMISSION_KEYS.SEND_AUTOMATION, { entity: 'Northstar' }), null);
  assert.equal(grantFor(calibrations, { entity: 'Northstar' }), null);
});

test('a correction keeps its source, time and the value it replaced', () => {
  const calibrations = {};
  recordCalibration(calibrations, { key: 'preference:reply_tone', value: 'concise', scope: { entity: 'Northstar' } });
  const corrected = correctCalibration(calibrations, {
    key: 'preference:reply_tone', value: 'formal', scope: { entity: 'Northstar' }, at: '2026-10-16T10:00:00.000Z'
  });
  assert.equal(corrected.value, 'formal');
  assert.equal(corrected.previousValue, 'concise');
  assert.equal(corrected.correctedAt, '2026-10-16T10:00:00.000Z');
});

test('something learned for one scope does not govern another', () => {
  const calibrations = {};
  recordCalibration(calibrations, { key: 'preference:reply_tone', value: 'formal', scope: { entity: 'Northstar' } });
  assert.equal(findCalibration(calibrations, 'preference:reply_tone', { entity: 'Helios' }), null);
  assert.equal(scopeCovers({ entity: 'Northstar' }, { entity: 'Helios' }), false);
  assert.equal(scopeCovers({}, { entity: 'Helios' }), true, 'a wildcard scope covers everything');
  assert.equal(needsCalibration(calibrations, 'preference:reply_tone', { entity: 'Helios' }), true);
});

test('a grant requires a stated, allowed, named scope; anything less falls back to asking', () => {
  const calibrations = {};
  recordCalibration(calibrations, { key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: {} });
  assert.equal(grantFor(calibrations, { entity: 'Northstar' }), null, 'an unnamed scope is not a grant');
  recordCalibration(calibrations, { key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'ask_each_time', scope: { entity: 'Northstar' } });
  assert.equal(grantFor(calibrations, { entity: 'Northstar' }), null, 'a non-allow value is not a grant');
  recordCalibration(calibrations, { key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  assert.ok(grantFor(calibrations, { entity: 'Northstar' }));
});

test('the engine asks once, only when a flow actually repeats', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  assert.equal(store.state.clarifications.length, 0, 'one request is not a repeated flow');

  engine.ingest(email('m2'));
  const open = engine.publicState().clarifications;
  assert.equal(open.length, 1, 'a repeated flow raises exactly one calibration question');
  assert.equal(open[0].key, PERMISSION_KEYS.SEND_AUTOMATION);
  assert.equal(open[0].scope.entity, 'Northstar');
  assert.ok(engine.publicState().notifications.some(item => item.kind === 'permission'));
});

test('answering the question closes it and enables a scoped pre-authorisation', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(email('m2'));
  const clarification = engine.publicState().clarifications[0];
  const entry = engine.answerClarification(clarification.id, 'allow');
  assert.equal(entry.value, 'allow');
  assert.equal(engine.publicState().clarifications.length, 0, 'the question is closed once answered');
  assert.ok(grantFor(store.state.calibrations, { entity: 'Northstar' }));
  assert.equal(engine.publicState().notifications.filter(item => item.kind === 'permission').length, 0, 'a resolved question stops asking');
});

test('the engine corrects its understanding of the user without losing the correction', () => {
  const { engine, store } = setup();
  engine.recordCalibration({ key: 'preference:reply_tone', kind: 'preference', value: 'concise', scope: { entity: 'Northstar' } });
  engine.correctCalibration({ key: 'preference:reply_tone', value: 'formal', scope: { entity: 'Northstar' } });
  const entry = findCalibration(store.state.calibrations, 'preference:reply_tone', { entity: 'Northstar' });
  assert.equal(entry.value, 'formal');
  assert.equal(entry.previousValue, 'concise');
  assert.ok(entry.correctedAt);
});

test('revoking a pre-authorisation stops automatic execution but leaves explicit approval intact', async () => {
  const { engine, store } = setup();
  // A stated, scoped grant: repeated Northstar follow-through may run without a fresh click.
  engine.recordCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  engine.ingest(email('m1'));
  engine.ingest(complete('Northstar'));
  assert.equal(store.state.tasks['request:m1'].status, 'completed', 'the pre-authorised flow ran without a fresh click');
  assert.equal(store.state.outbox.length, 1);

  // A revocation is a correction, and it takes effect at once.
  engine.correctCalibration({ key: PERMISSION_KEYS.SEND_AUTOMATION, kind: 'permission', value: 'never', scope: { entity: 'Northstar' } });
  assert.equal(grantFor(store.state.calibrations, { entity: 'Northstar' }), null);

  engine.ingest(email('m2'));
  assert.equal(store.state.tasks['request:m2'].status, 'ready_for_approval', 'nothing runs automatically after revocation');
  assert.equal(store.state.outbox.length, 1, 'the revoked scope sent nothing further');

  await engine.approve('request:m2');
  assert.equal(store.state.tasks['request:m2'].status, 'completed', 'revocation removes the automation, not the capability');
  assert.equal(store.state.outbox.length, 2);
});
