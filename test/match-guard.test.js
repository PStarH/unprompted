import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { PermissionPolicy, PermissionDeniedError } from '../src/permissions.js';

/**
 * Weak lexical overlap must not become a relationship or a prepared reply.
 * These cases are the two live false links and the neighbouring ways the same
 * mechanism can fire. Assertions are on task state and the outbox.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function engineWith(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-match-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const calls = [];
  const provider = {
    kind: 'gmail',
    live: true,
    lookup(key) { calls.push(['lookup', key]); return { status: 'not_found' }; },
    send(payload) { calls.push(['send', payload.idempotencyKey]); return { id: 'should-not-send' }; }
  };
  return { store, calls, engine: new WorkEngine(store, { provider, policy }) };
}

function email(id, subject, body) {
  return {
    id: `e-${id}`, type: 'email.received', source: 'google', connectorId: 'google',
    providerEventId: `gmail:${id}`,
    // A person, not a feed: these tests are about correlation, and discovery
    // now (correctly) refuses an automated sender before correlation runs.
    payload: { id, from: 'alex@example.test', to: 'maya@example.test', subject, body, receivedAt: '2026-10-16T08:00:00.000Z' }
  };
}

function document(id, title, content, modifiedAt = '2026-10-16T12:00:00.000Z') {
  return {
    id: `d-${id}`, type: 'document.modified', source: 'google', connectorId: 'google',
    providerEventId: `drive:${id}:1`,
    payload: {
      id, title, kind: 'document', content, modifiedAt, externalId: id,
      url: `https://docs.google.com/document/d/${id}/edit`
    }
  };
}

function taskOf(store) {
  return Object.values(store.state.tasks)[0];
}

function assertNotActionable(task, store) {
  assert.notEqual(task.status, 'ready_for_approval');
  assert.equal(task.draft, null);
  assert.equal(store.state.outbox.length, 0);
}

test('a generic entity word inside an unrelated document does not prepare a reply', () => {
  const { store, engine, calls } = engineWith(new PermissionPolicy({ shadow: true }));
  engine.ingest(email('m-email', 'Hello',
    'Please send the Email review by Friday. I need 34 AI agents https://www.example.test/agents'));
  engine.ingest(document('notes', 'RFQ app team meeting',
    'RFQ app team meeting\n\nEmail the notes to the group.\nSee https://intranet.example.test/34 for parking.\n'));
  const task = taskOf(store);
  assert.equal(task.request.subjectEntity, 'Email');
  assert.equal(task.documentId, null);
  assert.equal(task.assessment.confidence, 'insufficient_evidence');
  assertNotActionable(task, store);
  assert.deepEqual(calls, []);
});

test('title words found only inside other tokens do not link a document', () => {
  const { store, engine } = engineWith();
  engine.ingest(email('m-prop', 'Properties',
    'Please send the Properties doc by Friday. I need opposite needs. mapping qWt6w6n0wXEqrFqt0R5t'));
  engine.ingest(document('meeting', 'rfq app team meeting',
    'Agenda for Thursday. Nothing requested is written here.\n'));
  const task = taskOf(store);
  assert.equal(task.request.subjectEntity, 'Properties');
  assert.equal(task.documentId, null);
  assertNotActionable(task, store);
});

test('common title words without the requested phrase do not link a document', () => {
  const { store, engine } = engineWith();
  engine.ingest(email('m-beacon', 'Beacon',
    'Please send the Beacon report by Friday. I need the incident count. The app update can wait.'));
  engine.ingest(document('app-update', 'App update',
    'App update\n\nThis note covers the office move. Incident count: 4\n'));
  const task = taskOf(store);
  assert.equal(task.request.subjectEntity, 'Beacon');
  assert.equal(task.documentId, null);
  assertNotActionable(task, store);
});

test('a newsletter URL fragment does not satisfy a genuinely named document', () => {
  const { store, engine } = engineWith();
  engine.ingest(email('m-news', 'Northstar',
    'Please update the Northstar proposal by Friday. I need 34 AI agents https://www.example.test/agents'));
  engine.ingest(document('northstar-proposal', 'Northstar project proposal',
    '# Northstar project proposal\n\nSee https://intranet.example.test/34 for the parking rota.\n'));
  const task = taskOf(store);
  assert.equal(task.documentId, 'northstar-proposal', 'the document is named, so the link itself can stand');
  assert.ok((task.evidence?.documents?.[0]?.correlationReasons || []).length > 0);
  assert.notEqual(task.status, 'ready_for_approval');
  assert.equal(task.draft, null);
  assert.equal(store.state.outbox.length, 0);
  const criterion = task.evidence.criteria.find(item => item.status === 'satisfied');
  assert.equal(criterion, undefined);
});

test('a topical lookalike stays unlinked and does not become ready', () => {
  const { store, engine } = engineWith();
  engine.ingest(email('m-look', 'Northstar',
    'Please update the Northstar proposal with the latest experiment results and send it by Friday. I need the sample size.'));
  engine.ingest(document('ops', 'Operations proposal',
    '# Operations proposal\n\n## Experiment results\nSample size: 1,200\n', '2026-10-17T00:00:00.000Z'));
  const task = taskOf(store);
  assert.equal(task.documentId, null);
  assert.equal(task.assessment.confidence, 'insufficient_evidence');
  assertNotActionable(task, store);
});

test('a document that names the request and contains the requested results can be prepared', () => {
  const { store, engine } = engineWith(new PermissionPolicy({ shadow: true }));
  engine.ingest(email('m-ok', 'Northstar',
    'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday. I need the sample size, control and treatment conversion results, and your conclusion.'));
  engine.ingest(document('northstar-proposal', 'Northstar project proposal',
    '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'));
  const task = taskOf(store);
  assert.equal(task.status, 'ready_for_approval');
  assert.ok(task.draft);
  assert.equal(store.state.outbox.length, 0);
  const cited = (task.evidence?.criteria || []).flatMap(item => item.evidence || []);
  assert.ok(cited.some(item => item.source?.id === 'northstar-proposal'));
  assert.ok((task.evidence.documents[0].correlationReasons || []).some(reason => /Northstar/.test(reason)));
});

test('an unrelated document is not recorded as a conflict on a real match', () => {
  const { store, engine } = engineWith();
  engine.ingest(email('m-flyer', 'Zephyr flyer update',
    'Please update the Zephyr Course Flyer report by Friday. The document is https://docs.google.com/document/d/flyer/edit\nI need the course code CS498.'));
  engine.ingest(document('flyer', 'Zephyr Course Flyer',
    'CS498: Machine Learning Research Experience\n', '2025-04-01T23:25:49.954Z'));
  engine.ingest(document('other', 'RFQ app team meeting',
    'Agenda for the team meeting.\n'));
  const task = store.state.tasks['request:m-flyer'];
  assert.equal(task.documentId, 'flyer');
  assert.equal((task.evidence.conflicts || []).some(item => String(item.id).startsWith('rejected_candidate:')), false);
  assert.equal((task.evidence.unknowns || []).some(item => item.id === 'freshness_source_of_truth'), false);
  assert.equal(task.evidence.freshness.status, 'not_required');
});

test('a related document that contradicts itself is not treated as a positive match', () => {
  const { store, engine } = engineWith();
  engine.ingest(email('m-helios', 'Helios',
    'Please update the Helios incident playbook with the latest incident statistics and share it by Friday.'));
  engine.ingest(document('helios-playbook', 'Helios incident playbook',
    '# Helios incident playbook\n\n## Incident statistics\nAs of: 2026-10-12\nIncident count: 9\nMean time to recovery: 31 minutes\nIncident count: 14\n'));
  const task = taskOf(store);
  assert.equal(task.documentId, 'helios-playbook');
  assert.notEqual(task.status, 'ready_for_approval');
  assert.equal(task.draft, null);
  assert.equal(store.state.outbox.length, 0);
  assert.ok((task.evidence?.conflicts || []).length > 0 || (task.evidence?.criteria || []).some(item => item.status === 'conflicting'));
});

test('no weak match can send, and shadow mode still refuses a real ready item', () => {
  const { store, engine, calls } = engineWith(new PermissionPolicy({ shadow: true }));
  engine.ingest(email('m-weak', 'Hello',
    'Please send the Email review by Friday. I need 34 AI agents https://www.example.test/agents'));
  engine.ingest(document('notes', 'Parking notes',
    'Email the notes.\nSee https://intranet.example.test/34 for the map.\n'));
  const weak = taskOf(store);
  assert.throws(() => engine.approve(weak.id), /not ready/);
  assert.equal(store.state.outbox.length, 0);

  engine.ingest(email('m-ok', 'Northstar',
    'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday. I need the sample size, control and treatment conversion results, and your conclusion.'));
  engine.ingest(document('northstar-proposal', 'Northstar project proposal',
    '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n'));
  const ready = store.state.tasks['request:m-ok'];
  assert.equal(ready.status, 'ready_for_approval');
  assert.throws(() => engine.approve(ready.id), PermissionDeniedError);
  assert.equal(ready.status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0);
  assert.deepEqual(calls, []);
});
