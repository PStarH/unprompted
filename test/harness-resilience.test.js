import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateResilience } from '../eval/resilience.js';
import { ReasoningBudget, createReasoner } from '../src/reasoning.js';
import { buildDeterministicPlan, applyModelProposals, checkpointPlan, restorePlan } from '../src/probes/plan.js';
import { assessPlan, completionFromCriteria } from '../src/probes/assess.js';
import { interpretRequest } from '../src/requests.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SCENARIOS } from '../eval/scenarios.js';

let report;
test.before(async () => { report = await evaluateResilience(); });
for (const id of ['bounded-burst', 'model-plan-restart', 'relevant-context', 'nested-work-drain', 'settled-work-retention']) {
  test(`operational harness: ${id}`, () => {
    const result = report.checks.find(check => check.id === id);
    assert.ok(result?.passed, JSON.stringify(result));
  });
}

test('queued reasoning stays bounded, times out and releases all waiters', async () => {
  const budget = new ReasoningBudget({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 10 });
  assert.equal(budget.tryAcquire('active').ok, true);
  const waiting = budget.acquire('waiting');
  assert.equal(budget.describe().queued, 1);
  assert.match((await budget.acquire('overflow')).reason, /queue is full/);
  assert.match((await waiting).reason, /timed out/);
  assert.equal(budget.describe().queued, 0);
  budget.release();
  assert.equal(budget.describe().inFlight, 0);
});

test('queue admission never bypasses per-request or rate budgets', async () => {
  const budget = new ReasoningBudget({ maxConcurrent: 1, maxCallsPerMinute: 1, queueTimeoutMs: 100 });
  assert.equal(budget.tryAcquire('one').ok, true);
  const waiting = budget.acquire('two');
  budget.release();
  assert.match((await waiting).reason, /rate limit/);
  assert.match((await budget.acquire('one')).reason, /budget exhausted/);
  assert.equal(budget.describe().queued, 0);
});

const fixture = SCENARIOS.find(item => item.id === 'model-proposes-valid-probe');
const mail = fixture.events.find(event => event.type === 'email.received');

test('a restored model plan revalidates providers and source quotations', () => {
  const request = interpretRequest(mail.payload);
  const baseline = buildDeterministicPlan(request);
  const checkpoint = checkpointPlan(applyModelProposals(baseline, fixture.reasoner.probes, request));
  const restored = restorePlan(baseline, checkpoint, request);
  assert.ok(restored.specs.some(spec => spec.origin === 'model'));
  const unsafe = structuredClone(checkpoint);
  unsafe.proposals[0].provider = 'run_shell';
  const refused = restorePlan(baseline, unsafe, request);
  assert.equal(refused.specs.some(spec => spec.origin === 'model'), false);
  assert.ok(refused.rejected.some(item => /not registered/.test(item.reason)));
  const assessment = assessPlan(refused, {});
  assert.equal(assessment.criteria[0].status, 'blocked');
  assert.equal(completionFromCriteria(assessment.criteria).complete, false);
  const invented = structuredClone(checkpoint);
  invented.proposals[0].justification = 'an invented request quotation';
  assert.equal(restorePlan(baseline, invented, request).specs.some(spec => spec.origin === 'model'), false);
  assert.equal(restorePlan(baseline, { ...checkpoint, signature: 'another-request' }, request), baseline);
});

test('accepted model probes do not bleed into another task through the shared plan cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-plan-scope-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  let calls = 0;
  const reasoner = { available: () => true, async proposeProbes() { return ++calls === 1 ? fixture.reasoner.probes : []; }, async interpretRequest() { return null; } };
  try {
    const engine = new WorkEngine(store, { reasoner });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    const first = Object.values(store.state.tasks)[0];
    assert.ok(first.evidence.plan.specs.some(spec => spec.origin === 'model'));
    engine.ingest({ ...structuredClone(mail), id: 'second-independent-email', payload: { ...mail.payload, id: 'second-independent-mail' } });
    await engine.whenSettled();
    const second = store.state.tasks['request:second-independent-mail'];
    assert.equal(calls, 2);
    assert.equal(second.evidence.plan.specs.some(spec => spec.origin === 'model'), false);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy evidence projections restore validated model probes without another model call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-plan-legacy-'));
  let store = new JsonStore(path.join(dir, 'state.json'));
  try {
    const engine = new WorkEngine(store, { reasoner: { available: () => true, async proposeProbes() { return fixture.reasoner.probes; }, async interpretRequest() { return null; } } });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    const id = Object.keys(store.state.tasks)[0];
    store.mutate(state => { delete state.tasks[id].reasoningPlan; });
    store.close();
    store = new JsonStore(path.join(dir, 'state.json'));
    const resumed = new WorkEngine(store, { reasoner: { available: () => false } });
    resumed.assess(id, null, { force: true });
    assert.ok(store.state.tasks[id].evidence.plan.specs.some(spec => spec.origin === 'model'));
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalidated plan with zero verifiable criteria cannot execute an old ready draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-plan-invalid-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  try {
    const engine = new WorkEngine(store, { reasoner: { available: () => true, async proposeProbes() { return fixture.reasoner.probes; }, async interpretRequest() { return null; } } });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    const task = Object.values(store.state.tasks)[0];
    assert.equal(task.status, 'ready_for_approval');
    store.mutate(() => { task.request.requiredContent = [{ text: 'details' }]; });
    assert.throws(() => engine.approve(task.id), /reviewed again/);
    assert.equal(store.state.outbox.length, 0);
    assert.equal(task.status, 'waiting_for_information');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('queue settings are configurable and invalid queue limits retain bounded defaults', () => {
  const reasoner = createReasoner({ UNPROMPTED_MODEL_BASE_URL: 'https://scripted.invalid', UNPROMPTED_MODEL_NAME: 'scripted', UNPROMPTED_MODEL_MAX_QUEUED: '0', UNPROMPTED_MODEL_QUEUE_TIMEOUT_MS: '50' });
  assert.equal(reasoner.budget.describe().limits.maxQueued, 0);
  assert.equal(reasoner.budget.describe().limits.queueTimeoutMs, 50);
  const invalid = new ReasoningBudget({ maxQueued: NaN, queueTimeoutMs: Infinity });
  assert.equal(invalid.limits.maxQueued, 32);
  assert.equal(invalid.limits.queueTimeoutMs, 20000);
});

test('a saved probe that no longer validates cannot silently weaken a ready task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-plan-revalidation-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  try {
    const engine = new WorkEngine(store, { reasoner: { available: () => true, async proposeProbes() { return fixture.reasoner.probes; }, async interpretRequest() { return null; } } });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    const task = Object.values(store.state.tasks)[0];
    assert.equal(task.status, 'ready_for_approval');
    store.mutate(() => { task.reasoningPlan.proposals[0].provider = 'unregistered_provider'; });
    assert.throws(() => engine.approve(task.id), /reviewed again/);
    assert.equal(task.status, 'waiting_for_information');
    assert.equal(task.assessment.criteria.find(item => item.id === 'model_plan_revalidation').status, 'blocked');
    assert.equal(store.state.outbox.length, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
