import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore, migrate, emptyState, SCHEMA_VERSION } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { correlate, rankCandidates } from '../src/correlation.js';
import { resolveRequiredContent, assessAgainstCriteria, PROBES } from '../src/criteria.js';
import { determineFreshness, runRecord, newestRun } from '../src/freshness.js';
import { evidenceSignature, claim, unsupportedClaims, claimTextIsAllowed, evidenceItem, sourceRef } from '../src/evidence.js';
import { interpretRequest } from '../src/requests.js';

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

const northstarRequest = () => interpretRequest({
  id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
  body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
});

const doc = (overrides = {}) => ({
  id: 'northstar-proposal', title: 'Northstar project proposal', kind: 'proposal',
  content: '# Northstar project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n',
  url: '/documents/northstar-proposal', modifiedAt: '2026-10-16T09:00:00.000Z', version: 2,
  ...overrides
});

// ------------------------------------------------------------------ evidence

test('evidence requires a source reference so no claim can cite a source that does not exist', () => {
  assert.throws(() => evidenceItem({ source: null, excerptText: 'x' }), /source reference/);
  assert.throws(() => sourceRef({ kind: 'document' }), /kind and id/);
  const item = evidenceItem({
    source: sourceRef({ kind: 'document', id: 'd1', version: 3, timestamp: '2026-10-16T09:00:00.000Z' }),
    excerptText: 'Treatment: 10.4%'
  });
  assert.equal(item.source.version, 3);
  assert.equal(item.excerpt, 'Treatment: 10.4%');
});

test('the evidence signature changes with document version, run set and probes', () => {
  const base = { documentId: 'd1', version: 1, runs: ['r1'], probes: ['sample_size'], ambiguous: null };
  assert.equal(evidenceSignature(base), evidenceSignature({ ...base }));
  assert.notEqual(evidenceSignature(base), evidenceSignature({ ...base, version: 2 }));
  assert.notEqual(evidenceSignature(base), evidenceSignature({ ...base, runs: ['r1', 'r2'] }));
  assert.notEqual(evidenceSignature(base), evidenceSignature({ ...base, probes: ['sample_size', 'conclusion'] }));
});

test('unsupported claims are identifiable and can be blocked from outbound text', () => {
  const claims = [
    claim({ id: 'a', text: 'The results are the latest.', supported: false, forbiddenPattern: '\\blatest\\b' }),
    claim({ id: 'b', text: 'The document includes a conclusion.', supported: true })
  ];
  assert.deepEqual(unsupportedClaims(claims).map(item => item.id), ['a']);
  assert.equal(claimTextIsAllowed('The results are the latest available.', claims), false);
  assert.equal(claimTextIsAllowed('The document includes a conclusion.', claims), true);
});

// --------------------------------------------------------------- correlation

test('a shared generic noun is never enough to correlate a document', () => {
  const request = northstarRequest();
  const unrelated = correlate(request, { id: 'ops-proposal', title: 'Operations project proposal', kind: 'proposal', content: '# Operations project proposal\n' });
  assert.equal(unrelated.matched, false);
  assert.equal(unrelated.entityEvidence, false);

  const related = correlate(request, doc());
  assert.equal(related.matched, true);
  assert.ok(related.reasons.some(reason => reason.includes('Northstar')));
});

test('an explicit link correlates even when the title differs', () => {
  const request = { ...northstarRequest(), explicitDocumentUrl: '/documents/quarterly-narrative' };
  const match = correlate(request, { id: 'quarterly-narrative', title: 'Q4 narrative', url: '/documents/quarterly-narrative', version: 1, content: '' });
  assert.equal(match.matched, true);
  assert.ok(match.reasons.some(reason => reason.includes('links to this exact document')));
});

test('equal-scoring candidates are reported as ambiguous rather than silently chosen', () => {
  const request = northstarRequest();
  // Neither title appears verbatim in the request, so the two candidates are
  // genuinely indistinguishable and the system must say so.
  const ranked = rankCandidates(request, {
    a: doc({ id: 'northstar-proposal', title: 'Northstar proposal draft' }),
    b: doc({ id: 'northstar-proposal-revision', title: 'Northstar proposal revision' })
  });
  assert.equal(ranked.ambiguous, true);
  assert.equal(ranked.contenders.length, 2);
});

test('a document whose title the request names is preferred over a look-alike', () => {
  const request = northstarRequest();
  // The request says "the Northstar project proposal", which is exactly doc a's
  // title. That is real evidence, so the system should not call this ambiguous.
  const ranked = rankCandidates(request, {
    a: doc({ id: 'northstar-proposal', title: 'Northstar project proposal' }),
    b: doc({ id: 'northstar-proposal-copy', title: 'Northstar project proposal copy' })
  });
  assert.equal(ranked.ambiguous, false);
  assert.equal(ranked.best.document.id, 'northstar-proposal');
  assert.ok(ranked.best.match.identitySignals.some(signal => signal.id === 'title_named'));
});

test('a semantically similar document with no identity signal is rejected and the reason recorded', () => {
  const request = northstarRequest();
  const match = correlate(request, {
    id: 'ops-review', title: 'Operations Reliability Review', kind: 'review',
    content: '# Operations Reliability Review\n\n## Results\nUptime was 99.2% over the period.\n', version: 1
  });
  assert.equal(match.matched, false, 'topical overlap alone must never correlate');
  assert.equal(match.entityEvidence, false);
  assert.ok(match.topicalSignals.length > 0, 'the topical overlap should still be reported');
  assert.ok(match.contradictions.some(item => item.id === 'title_names_other_entity'));
});

// ------------------------------------------------------------------ criteria

test('required content maps to probes through synonyms and reports what cannot be verified', () => {
  assert.deepEqual(resolveRequiredContent([{ text: 'experiment results' }]).probeIds.sort(),
    ['conclusion', 'control_metric', 'run_date', 'sample_size', 'treatment_metric'].sort());
  assert.deepEqual(resolveRequiredContent([{ text: 'the baseline conversion' }]).probeIds, ['control_metric']);
  const unknown = resolveRequiredContent([{ text: 'signed customer testimonials' }]);
  assert.equal(unknown.probeIds.length, 0);
  assert.equal(unknown.unverifiable.length, 1);
});

test('document assessment produces evidence with a document id, version, timestamp and excerpt', () => {
  const { probeIds } = resolveRequiredContent([{ text: 'experiment results' }]);
  const scan = assessAgainstCriteria(doc(), probeIds);
  assert.equal(scan.scope.found, true);
  assert.equal(scan.scope.title, 'Experiment results');
  const treatment = scan.criteria.find(item => item.id === 'treatment_metric');
  assert.equal(treatment.status, 'satisfied');
  const [evidence] = treatment.evidence;
  assert.equal(evidence.source.id, 'northstar-proposal');
  assert.equal(evidence.source.version, 2);
  assert.equal(evidence.source.timestamp, '2026-10-16T09:00:00.000Z');
  assert.match(evidence.excerpt, /10\.4%/);
});

test('a missing results heading is an observation, not a hard requirement', () => {
  const { probeIds } = resolveRequiredContent([{ text: 'sample size' }]);
  const scan = assessAgainstCriteria(doc({ content: 'Sample size: 900\n' }), probeIds);
  assert.equal(scan.scope.found, false);
  assert.ok(scan.observations.some(item => /whole document/.test(item.detail)));
  assert.equal(scan.criteria[0].status, 'satisfied', 'content is still found without a heading');
});

test('every probe can be exercised without throwing on empty or hostile input', () => {
  for (const probe of Object.values(PROBES)) {
    assert.equal(probe.find(''), null);
    assert.equal(probe.find(null), null);
    assert.doesNotThrow(() => probe.find('# Heading\n\n- item\n| a | b |\n'));
  }
});

// ----------------------------------------------------------------- freshness

test('freshness is unverified without a run registry and never claims the latest results', () => {
  const result = determineFreshness({ document: doc(), documentRunDate: '2026-10-16', runRecords: {}, request: northstarRequest() });
  assert.equal(result.status, 'unverified');
  assert.ok(result.unknowns.some(item => item.id === 'freshness_source_of_truth'));
  assert.equal(result.evidence.length, 0);
});

test('a request that does not ask for latest results does not invent an experiment question', () => {
  const request = interpretRequest({
    id: 'm-flyer', from: 'maya@example.test', subject: 'Zephyr flyer update',
    body: 'Please update the Zephyr Course Flyer report by Friday. I need the course code CS498.'
  });
  const result = determineFreshness({ document: doc({ title: 'Zephyr Course Flyer' }), documentRunDate: null, runRecords: {}, request });
  assert.equal(result.status, 'not_required');
  assert.equal(result.unknowns.length, 0);
  assert.equal(/experiment|newest results/i.test(result.reason), false);
});

test('freshness is verified when the document matches the newest registered run', () => {
  const records = { r1: runRecord({ id: 'r1', label: 'Northstar run', subjectEntity: 'Northstar', completedAt: '2026-10-16T09:00:00.000Z', source: { kind: 'run_registry', id: 'reg' } }) };
  const result = determineFreshness({ document: doc(), documentRunDate: '2026-10-16', runRecords: records, request: northstarRequest() });
  assert.equal(result.status, 'verified');
  assert.equal(result.newestRun.id, 'r1');
  assert.ok(result.evidence.every(item => item.source.kind));
});

test('freshness is stale when a newer run exists, and says what would resolve it', () => {
  const records = { r2: runRecord({ id: 'r2', label: 'Newer run', subjectEntity: 'Northstar', completedAt: '2026-10-20T09:00:00.000Z', source: { kind: 'run_registry', id: 'reg' } }) };
  const result = determineFreshness({ document: doc(), documentRunDate: '2026-10-16', runRecords: records, request: northstarRequest() });
  assert.equal(result.status, 'stale');
  assert.match(result.reason, /2026-10-20/);
  assert.ok(result.unknowns.some(item => item.id === 'stale_results' && item.whatWouldResolveIt));
});

test('run records are scoped by entity so another project cannot make a document look stale', () => {
  const records = { r: runRecord({ id: 'r', subjectEntity: 'Aurora', completedAt: '2026-12-01T00:00:00.000Z', source: { kind: 'run_registry', id: 'reg' } }) };
  const result = determineFreshness({ document: doc(), documentRunDate: '2026-10-16', runRecords: records, request: northstarRequest() });
  assert.equal(result.status, 'unverified', 'a run for a different project must not be treated as the newest Northstar run');
  assert.equal(newestRun(records, 'Northstar'), null);
});

test('a document with no run date cannot be compared, so freshness stays unverified', () => {
  const records = { r1: runRecord({ id: 'r1', subjectEntity: 'Northstar', completedAt: '2026-10-16T09:00:00.000Z', source: { kind: 'run_registry', id: 'reg' } }) };
  const result = determineFreshness({ document: doc(), documentRunDate: null, runRecords: records, request: northstarRequest() });
  assert.equal(result.status, 'unverified');
  assert.ok(result.unknowns.some(item => item.id === 'document_run_identity'));
});

// ---------------------------------------------------------------- persistence

test('a v1 state file migrates to v2 without losing tasks, events or outbox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-migrate-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  const legacy = {
    schemaVersion: 1, revision: 7, mode: 'simulation',
    events: [{ id: 'e1', type: 'email.received', at: '2026-10-16T09:00:00.000Z', source: 'simulation', summary: 's', relations: [], disposition: 'discovered_request', payload: { id: 'm1' } }],
    inbox: [{ id: 'm1' }],
    documents: { d1: { id: 'd1', title: 'Doc', version: 1 } },
    tasks: { 'request:m1': { id: 'request:m1', status: 'waiting_for_information', request: { subjectEntity: 'Northstar', deliverable: 'proposal', requiredContent: [], impliedClaims: [], source: { id: 'm1' } }, assessment: { documentId: 'd1', documentVersion: 1 }, draft: null, action: null, evidence: null } },
    outbox: [{ id: 'sim-1', idempotencyKey: 'k1', status: 'accepted_simulation' }],
    history: [], simulation: null
  };
  fs.writeFileSync(filename, JSON.stringify(legacy, null, 2));

  const store = new JsonStore(filename);
  assert.equal(store.state.schemaVersion, SCHEMA_VERSION);
  assert.equal(store.migrated, true);
  assert.equal(store.state.revision, 7);
  assert.equal(store.state.outbox.length, 1);
  assert.equal(store.state.tasks['request:m1'].status, 'waiting_for_information');
  assert.deepEqual(store.state.runRecords, {});
  assert.deepEqual(store.state.cursors, {});

  // The migration is persisted, so a second load does not repeat it.
  const reopened = new JsonStore(filename);
  assert.equal(reopened.migrated, false);
  assert.equal(reopened.state.schemaVersion, SCHEMA_VERSION);
});

test('a legacy task request is rebuilt from its source email and re-derived, not trusted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-repair-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  // Exactly the shape the first prototype wrote: a `project` field, a rule-based
  // assessment, no evidence bundle, and a draft that was never approved.
  const legacy = {
    schemaVersion: 1, revision: 4, mode: 'simulation',
    events: [], history: [], outbox: [], documents: {}, simulation: null,
    inbox: [{
      id: 'mail-northstar-01', from: 'alex@example.test', to: 'maya@example.test',
      subject: 'Northstar proposal — experiment results',
      body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
    }],
    tasks: {
      'request:mail-northstar-01': {
        id: 'request:mail-northstar-01', status: 'ready_for_approval', project: 'Northstar',
        request: { project: 'Northstar', deliverable: 'Revised proposal', deadline: 'Friday (as stated by sender)', requirements: ['run_date', 'sample_size'] },
        sourceEmailId: 'mail-northstar-01', sender: 'alex@example.test', subject: 'Northstar proposal — experiment results',
        assessment: { checkedAt: '2026-10-15T00:00:00.000Z', documentId: 'northstar-proposal', documentVersion: 1, complete: true, missing: [], evidence: [], confidence: 'strong_field_evidence' },
        draft: { to: 'alex@example.test', subject: 'Re: x', body: 'stale draft', documentVersion: 1 },
        action: null, evidence: null
      }
    }
  };
  fs.writeFileSync(filename, JSON.stringify(legacy, null, 2));

  const store = new JsonStore(filename);
  const task = store.state.tasks['request:mail-northstar-01'];
  assert.equal(store.migrated, true);
  assert.equal(task.request.subjectEntity, 'Northstar', 'the entity is recovered from the source email');
  assert.equal(task.request.deliverable, 'proposal');
  assert.equal(task.status, 'newly_discovered', 'the old verdict is not trusted');
  assert.equal(task.assessment, null);
  assert.equal(task.draft, null, 'an unapproved legacy draft is discarded');
  assert.equal(task.evidence, null);

  // Startup then re-derives the evidence model, and nothing was sent.
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  assert.ok(engine);
  const repaired = store.state.tasks['request:mail-northstar-01'];
  assert.ok(repaired.evidence, 'an evidence bundle is derived on startup');
  assert.equal(repaired.assessment.complete, false, 'no document is present, so it cannot be complete');
  assert.equal(repaired.status, 'waiting_for_information');
  assert.equal(store.state.outbox.length, 0);

  // Repair is idempotent: a second load changes nothing further.
  const reopened = new JsonStore(filename);
  assert.equal(reopened.migrated, false);
});

test('an unsupported schema version is rejected instead of silently mangled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-schema-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 99, tasks: {} }));
  assert.throws(() => new JsonStore(filename), /Unsupported state schema/);
  assert.throws(() => migrate({ schemaVersion: 42 }), /Unsupported state schema/);
});

test('empty state carries every collection the engine expects', () => {
  const state = emptyState();
  for (const key of ['events', 'inbox', 'documents', 'runRecords', 'tasks', 'outbox', 'history', 'cursors', 'connectorStatus']) {
    assert.ok(key in state, `${key} should exist`);
  }
});

test('state is written atomically and not world-readable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-perm-state-'));
  tempFiles.push(dir);
  const filename = path.join(dir, 'state.json');
  const store = new JsonStore(filename);
  store.mutate(state => { state.mode = 'simulation'; });
  const mode = fs.statSync(filename).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'state.json.lock'],
    'the state and its lock are the only files; no temporary file is left behind');
});

// ------------------------------------------------- document invalidation

function engineIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-invalidate-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
  return { store, engine };
}

function ingestNorthstar(engine, { modifiedAt = '2026-10-16T09:00:00.000Z' } = {}) {
  engine.ingest({ id: 'e-mail', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  } });
  engine.ingest({ id: 'e-doc', type: 'document.modified', payload: { ...doc(), modifiedAt } });
}

test('a removed document stops being evidence and withdraws the prepared draft', () => {
  const { store, engine } = engineIn();
  ingestNorthstar(engine);
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.ok(store.state.tasks[taskId].draft);

  engine.ingest({ id: 'e-gone', type: 'document.unavailable', payload: {
    id: 'northstar-proposal', title: 'Northstar project proposal', reason: 'removed'
  } });

  const document = store.state.documents['northstar-proposal'];
  assert.equal(document.available, false);
  assert.equal(document.unavailableReason, 'removed');
  assert.match(document.content, /Experiment results/, 'the historical content is kept for audit, but marked unavailable');
  const task = store.state.tasks[taskId];
  assert.equal(task.status, 'waiting_for_information');
  assert.equal(task.draft, null, 'a draft built on withdrawn evidence must not be kept');
  assert.equal(task.assessment.complete, false);
  assert.equal(task.assessment.documentId, null);
  assert.equal(store.state.outbox.length, 0);
  assert.throws(() => engine.approve(taskId), /not ready for approval/);
  assert.ok(store.state.history.some(item => item.kind === 'observation' && /no longer available|unavailable/i.test(item.text || '')));
});

test('approval is refused when the draft document became unavailable after assessment', () => {
  const { store, engine } = engineIn();
  ingestNorthstar(engine);
  const taskId = 'request:m1';
  // The document disappears between the assessment and the click: the stored
  // task still looks ready, so the refusal has to happen at approval time.
  store.mutate(state => { state.documents['northstar-proposal'].available = false; });
  assert.throws(() => engine.approve(taskId), /no longer available/i);
  assert.equal(store.state.outbox.length, 0);
  assert.equal(store.state.tasks[taskId].status, 'waiting_for_information', 'the refusal reassesses with current evidence');
});

test('a document that becomes readable again can support the work once more', () => {
  const { store, engine } = engineIn();
  ingestNorthstar(engine);
  const taskId = 'request:m1';
  engine.ingest({ id: 'e-gone', type: 'document.unavailable', payload: { id: 'northstar-proposal', reason: 'removed' } });
  assert.equal(store.state.tasks[taskId].status, 'waiting_for_information');

  engine.ingest({ id: 'e-doc-2', type: 'document.modified', payload: { ...doc(), modifiedAt: '2026-10-18T09:00:00.000Z' } });
  assert.equal(store.state.documents['northstar-proposal'].available, true);
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0);
});

test('an unavailable runner-up is not checked as a competing source', () => {
  const { store, engine } = engineIn();
  // Two equally plausible documents would trigger enhanced verification; with
  // one of them unavailable the check must not silently use it anyway.
  engine.ingest({ id: 'e-mail', type: 'email.received', payload: {
    id: 'm1', from: 'alex@example.test', subject: 'Northstar proposal — experiment results',
    body: 'Please update the Northstar project proposal with the latest experiment results and send the revised proposal by Friday.'
  } });
  engine.ingest({ id: 'e-doc', type: 'document.modified', payload: { ...doc() } });
  engine.ingest({ id: 'e-alt', type: 'document.modified', payload: {
    ...doc({ id: 'northstar-proposal-alt', title: 'Northstar proposal alt', url: '/documents/northstar-proposal-alt' })
  } });
  store.mutate(state => { state.documents['northstar-proposal-alt'].available = false; });
  store.mutate(state => { state.tasks['request:m1'].assessment = null; });
  engine.assess('request:m1', null, { force: true });
  const task = store.state.tasks['request:m1'];
  assert.deepEqual(task.verification.checkedDocuments, [], 'the unavailable document must not be cross-checked');
});
