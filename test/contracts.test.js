import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import {
  CONTRACTS, CONTRACT_VERSION, validateContract, validateAll, describeContracts,
  requestQuotationTexts, citationForms, isRequestQuotation, justifyRequestContent
} from '../src/contracts.js';

/**
 * Core data contracts.
 *
 * The important thing here is that the contracts describe artefacts the system
 * really produces. A schema that only its own fixture satisfies proves nothing,
 * so the integration test drives a real engine and validates everything it
 * emitted — events, request, criteria, plan specs, action, notification,
 * opportunity and calibration.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-contracts-'));
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
const doc = (project = 'Northstar') => ({
  id: `event-doc-${project}`, type: 'document.modified', payload: {
    id: `${project.toLowerCase()}-proposal`, kind: 'proposal', title: `${project} project proposal`,
    content: `# ${project} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n`
  }
});

// ---------------------------------------------------------------- validator

test('the validator accepts a well-formed artefact and names every defect it finds', () => {
  assert.equal(validateContract('notification', {
    id: 'n-1', kind: 'deadline', priority: 'normal', what: 'w', why: 'y', decision: 'd',
    checked: ['c'], at: '2026-10-16T09:00:00.000Z'
  }).ok, true);

  const missing = validateContract('notification', { id: 'n-1' });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some(problem => /kind is required/.test(problem)));
  assert.ok(missing.problems.some(problem => /checked is required/.test(problem)));

  const wrongEnum = validateContract('event', {
    id: 'e', type: 'not.a.real.event', at: 't', source: 's', connectorId: 'c', payload: {}, disposition: 'd'
  });
  assert.equal(wrongEnum.ok, false);
  assert.ok(wrongEnum.problems.some(problem => /type must be one of/.test(problem)));

  const emptyText = validateContract('request', { id: 'r', intent: 'update', deliverable: 'd', subjectEntity: 'e', text: '   ', source: { kind: 'email', id: 'm' }, interpretedBy: 'deterministic' });
  assert.ok(emptyText.problems.some(problem => /text must not be empty/.test(problem)));

  assert.equal(validateContract('nope', {}).ok, false);
  assert.equal(describeContracts().length, Object.keys(CONTRACTS).length);
  assert.equal(CONTRACT_VERSION, 1);
});

// -------------------------------------------------------- citation contract

test('a citation is matched against the request text and its declared content', () => {
  const request = {
    text: 'Please update the Zephyr report with the latest incident statistics and share it by Friday.',
    requiredContent: [{ text: 'vendor reconciliation notes' }]
  };
  assert.deepEqual(requestQuotationTexts(request), [
    'Please update the Zephyr report with the latest incident statistics and share it by Friday.',
    'vendor reconciliation notes'
  ]);
  // A direct quotation of the email.
  assert.equal(isRequestQuotation(request, 'the latest incident statistics'), true);
  // A quotation of the interpreted ask, with the article the extractor strips.
  assert.equal(isRequestQuotation(request, 'the vendor reconciliation notes'), true);
  assert.equal(isRequestQuotation(request, 'vendor reconciliation notes'), true);
  // An invention matches nothing.
  assert.equal(isRequestQuotation(request, 'a quote that is not in the request'), false);
  assert.equal(isRequestQuotation(request, ''), false);
});

test('a citation records which part of the request it came from', () => {
  const request = {
    text: 'Please update the Zephyr report with the latest incident statistics and share it by Friday.',
    requiredContent: [{ text: 'vendor reconciliation notes' }]
  };
  assert.equal(justifyRequestContent(request, 'incident statistics').source, 'request_text');
  assert.equal(justifyRequestContent(request, 'the vendor reconciliation notes').source, 'declared_content');
  assert.equal(justifyRequestContent(request, 'unrelated content').span, null);
  assert.deepEqual(citationForms('a quote that is not in the request'),
    ['a quote that is not in the request', 'quote that is not in the request']);
  assert.deepEqual(citationForms('incident statistics'), ['incident statistics']);
});

// ------------------------------------------------- real artefacts conform

test('every artefact a real run produces satisfies its contract', async () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  engine.ingest(email('m2')); // a repeated flow: raises a permission question
  const task = store.state.tasks['request:m1'];
  assert.equal(task.status, 'ready_for_approval');

  const failure = (name, result) => assert.fail(`${name} violated its contract: ${JSON.stringify(result.failures, null, 2)}`);

  const events = validateAll('event', store.state.events);
  if (!events.ok) failure('event', events);

  for (const candidate of Object.values(store.state.tasks)) {
    const request = validateContract('request', candidate.request);
    if (!request.ok) failure(`request (${candidate.id})`, { failures: request.problems.map(problem => ({ problems: [problem] })) });

    if (candidate.evidence) {
      const criteria = validateAll('criterion', candidate.evidence.criteria);
      if (!criteria.ok) failure('criterion', criteria);
      const items = candidate.evidence.criteria.flatMap(criterion => criterion.evidence);
      const evidence = validateAll('evidenceItem', items);
      if (!evidence.ok) failure('evidenceItem', evidence);
      const specs = validateAll('planSpec', candidate.evidence.plan.specs);
      if (!specs.ok) failure('planSpec', specs);
    }
    if (candidate.action) {
      const action = validateContract('action', candidate.action);
      if (!action.ok) failure('action', { failures: action.problems.map(problem => ({ problems: [problem] })) });
    }
    if (candidate.verification) {
      const verification = validateContract('verification', candidate.verification);
      if (!verification.ok) failure(`verification (${candidate.id})`, { failures: verification.problems.map(problem => ({ problems: [problem] })) });
    }
  }

  engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  await engine.approve('request:m1');

  const notifications = validateAll('notification', store.state.notifications);
  if (!notifications.ok) failure('notification', notifications);
  const opportunities = validateAll('opportunity', Object.values(store.state.opportunities));
  if (!opportunities.ok) failure('opportunity', opportunities);
  const calibrations = validateAll('calibration', Object.values(store.state.calibrations));
  if (!calibrations.ok) failure('calibration', calibrations);

  // The run must actually have exercised the shapes it claims to validate.
  assert.ok(store.state.events.length >= 3);
  assert.ok(Object.values(store.state.tasks).some(candidate => candidate.verification), 'the run produced a verification record to validate');
  assert.ok(store.state.notifications.some(item => item.kind === 'permission') || store.state.notifications.some(item => item.kind === 'opportunity'));
  assert.ok(store.state.calibrations && Object.keys(store.state.calibrations).length === 1);
  assert.equal(store.state.tasks['request:m1'].status, 'completed');
});

test('a planned probe always cites the request, whichever part it came from', () => {
  const { engine, store } = setup();
  engine.ingest(email('m1'));
  engine.ingest(doc());
  const specs = store.state.tasks['request:m1'].evidence.plan.specs;
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    assert.ok(spec.justification, `${spec.criterionId} must cite the request`);
    assert.ok(['request_text', 'declared_content', 'model_quote'].includes(spec.justificationSource), `${spec.criterionId} must record its source`);
    assert.equal(spec.justified, true);
  }
});
