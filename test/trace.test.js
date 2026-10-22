import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { traceEntry, appendTrace, explainDecision, summariseDecision, MAX_TRACE_ENTRIES } from '../src/trace.js';
import { validateAll } from '../src/contracts.js';

/**
 * Decision trace.
 *
 * The guarantee under test is that a piece of work can be explained end to end:
 * what arrived, what was checked, what was concluded, what the policy decided,
 * and what the outside world did in response — including a refusal, which is a
 * decision and must be on the record too.
 */

const tempFiles = [];
test.after(() => { for (const dir of tempFiles) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-trace-'));
  tempFiles.push(dir);
  const store = new JsonStore(path.join(dir, 'state.json'));
  return { store, engine: new WorkEngine(store, { provider: new SimulatedMailProvider(store) }) };
}

const email = (id = 'm1', project = 'Northstar') => ({
  id: `event-email-${id}`, type: 'email.received', payload: {
    id, from: 'alex@example.test', subject: `${project} proposal — experiment results`,
    body: `Please update the ${project} project proposal with the latest experiment results and send the revised proposal by Friday.`
  }
});
const doc = (project = 'Northstar', extra = '') => ({
  id: `event-doc-${project}`, type: 'document.modified', payload: {
    id: `${project.toLowerCase()}-proposal`, kind: 'proposal', title: `${project} project proposal`,
    content: `# ${project} project proposal\n\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\n${extra}`
  }
});
const completeExtra = 'Control: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.\n';

test('a trace entry must name a real stage, its input and its outcome', () => {
  assert.throws(() => traceEntry({ stage: 'guessing', input: {}, outcome: {} }), /Unknown trace stage/);
  assert.throws(() => traceEntry({ stage: 'assessment', input: null, outcome: {} }), /requires its input/);
  assert.throws(() => traceEntry({ stage: 'assessment', input: {}, outcome: null }), /requires its outcome/);
  const entry = traceEntry({ stage: 'assessment', taskId: 't', input: { a: 1 }, outcome: { b: 2 } });
  assert.equal(entry.stage, 'assessment');
  assert.ok(entry.id && entry.at);
});

test('the trace is bounded so an audit log cannot become a resource leak', () => {
  const trace = [];
  for (let i = 0; i < MAX_TRACE_ENTRIES + 25; i += 1) {
    appendTrace(trace, traceEntry({ stage: 'assessment', input: { i }, outcome: {} }));
  }
  assert.equal(trace.length, MAX_TRACE_ENTRIES);
  assert.equal(trace.at(-1).input.i, MAX_TRACE_ENTRIES + 24, 'the newest entry is retained');
});

test('explaining a decision returns its stages in order and reports what is missing', () => {
  const trace = [
    traceEntry({ stage: 'execution', taskId: 't', at: '2026-10-16T09:03:00.000Z', input: {}, outcome: {} }),
    traceEntry({ stage: 'discovery', taskId: 't', at: '2026-10-16T09:01:00.000Z', input: {}, outcome: {} })
  ];
  assert.deepEqual(explainDecision(trace, 't').map(entry => entry.stage), ['discovery', 'execution']);
  const summary = summariseDecision(trace, 't');
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.missing.sort(), ['assessment', 'policy']);
  assert.equal(summariseDecision(trace, 'unknown').complete, false);
});

test('a completed run is explainable from arrival to verified result', async () => {
  const { engine, store } = setup();
  engine.ingest(email());
  engine.ingest(doc('Northstar', completeExtra));
  await engine.approve('request:m1');

  const { entries, summary } = engine.decisionTrace('request:m1');
  assert.deepEqual(summary.stages, ['discovery', 'assessment', 'policy', 'execution']);
  assert.equal(summary.complete, true, 'every stage of the decision is on the record');

  const discovery = entries.find(entry => entry.stage === 'discovery');
  assert.equal(discovery.input.messageId, 'm1');
  assert.equal(discovery.reasoning.entity, 'Northstar');

  // A task is assessed once before its document exists and again after, so the
  // concluding assessment is the last one.
  const assessments = entries.filter(entry => entry.stage === 'assessment');
  assert.ok(assessments.length >= 2, 'the task is re-assessed when its document appears');
  assert.equal(assessments[0].input.documentId, null, 'the first assessment had no document to read');
  const assessment = assessments.at(-1);
  assert.equal(assessment.input.documentId, 'northstar-proposal');
  assert.equal(assessment.input.documentVersion, 1);
  assert.ok(assessment.input.evidenceSignature);
  assert.ok(assessment.evidence.satisfied.length > 0);
  assert.equal(assessment.outcome.complete, true);

  const policy = entries.find(entry => entry.stage === 'policy');
  assert.equal(policy.policy.decision, 'allowed');
  assert.equal(policy.policy.permission, 'user_approved');
  assert.ok(policy.input.idempotencyKey);

  const execution = entries.find(entry => entry.stage === 'execution');
  assert.equal(execution.outcome.status, 'verified');
  assert.ok(execution.outcome.receiptId);

  assert.equal(validateAll('trace', store.state.trace).ok, true, 'trace entries satisfy their contract');
});

test('a refused approval is traced with its reason, and nothing is sent', async () => {
  const { engine, store } = setup();
  engine.ingest(email());
  engine.ingest(doc('Northstar', completeExtra));
  const taskId = 'request:m1';
  assert.equal(store.state.tasks[taskId].status, 'ready_for_approval');

  // The document moves on between preparing and approving — the race the guard
  // exists for. A new document version with no re-assessment.
  const preparedVersion = store.state.tasks[taskId].draft.documentVersion;
  store.mutate(state => { state.documents['northstar-proposal'].version = preparedVersion + 1; });

  assert.throws(() => engine.approve(taskId), /must be reviewed again/);
  const { entries } = engine.decisionTrace(taskId);
  const refusal = entries.filter(entry => entry.stage === 'policy' && entry.policy.decision === 'refused');
  assert.ok(refusal.length > 0, 'a refusal is a decision and must be recorded');
  assert.match(refusal[0].policy.reason, /document changed/i);
  assert.equal(refusal[0].outcome.status, 'not_executed');
  assert.equal(store.state.outbox.length, 0, 'a refused approval sends nothing');
});

test('an uncertain external outcome is traced as blocked, not as success', async () => {
  const { engine, store } = setup();
  engine.ingest(email());
  engine.ingest(doc('Northstar', completeExtra));
  engine.provider.lookupOverride = 'unknown';
  await engine.approve('request:m1');

  const { entries } = engine.decisionTrace('request:m1');
  const execution = entries.find(entry => entry.stage === 'execution');
  assert.equal(execution.outcome.status, 'blocked');
  assert.match(execution.outcome.reason, /cannot confirm|timed out/i);
  assert.equal(store.state.tasks['request:m1'].status, 'blocked');
});

test('an autonomous run within a pre-authorisation is traced with the grant that allowed it', async () => {
  const { engine } = setup();
  engine.ingest(email());
  engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: 'Northstar' } });
  engine.ingest(doc('Northstar', completeExtra));
  await engine.whenSettled();

  const { entries, summary } = engine.decisionTrace('request:m1');
  const policy = entries.find(entry => entry.stage === 'policy');
  assert.equal(policy.policy.permission, 'pre_authorized');
  assert.ok(policy.policy.grantId, 'the authorisation that permitted the action is named');
  assert.equal(summary.complete, true);
});
