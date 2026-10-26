// Whole-work trajectories with local providers. No live model or account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { SimulatedMailProvider, UncertainDeliveryError } from '../src/providers.js';
import { SCENARIOS } from './scenarios.js';

async function workspace(run, { providerFactory = store => new SimulatedMailProvider(store), reasoner = new NullReasoner() } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-lifecycle-eval-'));
  const filename = path.join(directory, 'state.json');
  const engines = [];
  let store = new JsonStore(filename);
  let engine = new WorkEngine(store, { provider: providerFactory(store), reasoner });
  engines.push(engine);
  const context = {
    get engine() { return engine; }, get store() { return store; },
    async restart() {
      await engine.whenSettled();
      store.close(); store = new JsonStore(filename);
      engine = new WorkEngine(store, { reasoner: new NullReasoner() });
      engines.push(engine);
      await engine.whenSettled();
    }
  };
  try { return await run(context); }
  finally { await Promise.all(engines.map(item => item.whenSettled())); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

const mail = { id: 'lifecycle-mail-event', type: 'email.received', payload: {
  id: 'lifecycle-mail', threadId: 'atlas-thread', from: 'alex@example.test', to: 'maya@example.test',
  subject: 'Atlas proposal', body: 'Please update the Atlas proposal with the sample size and send it.',
  receivedAt: '2026-10-25T09:00:00.000Z'
} };
const document = (id, title, content, kind = 'proposal') => ({ id: `event:${id}`, type: 'document.modified', payload: { id, title, content, kind } });
const taskId = 'request:lifecycle-mail';
const reviewed = context => context.engine.publicState().tasks.find(task => task.id === taskId).reviewToken;

function seed(context, { missing = false } = {}) {
  context.engine.ingest(document('atlas-proposal', 'Atlas proposal', `# Atlas proposal\n${missing ? 'Awaiting sample data.' : 'Sample size: 1200'}`));
  context.engine.ingest(structuredClone(mail));
}

async function patchMissing(context) {
  seed(context, { missing: true });
  context.engine.ingest(document('atlas-notes', 'Atlas experiment notes', '# Atlas experiment notes\nSample size: 1200\n', 'notes'));
  assert.equal(context.store.state.tasks[taskId].status, 'waiting_for_information');
  const patch = await context.engine.prepareDocumentPatch(taskId);
  assert.equal(patch.status, 'prepared', patch.blockers.join('; '));
  const applied = await context.engine.applyDocumentPatch(taskId, { patchId: patch.id,
    authorization: { kind: 'explicit', taskId, patchId: patch.id, baseDocumentVersion: patch.baseDocument.version, confirmed: true } });
  assert.equal(applied.patch.status, 'applied');
  assert.equal(applied.patch.result.readbackVerified, true);
  assert.equal(context.store.state.tasks[taskId].status, 'ready_for_approval');
  return applied.patch;
}

export async function evaluateLifecycle() {
  const checks = [];
  const check = async (id, run, options) => {
    try { checks.push({ id, passed: true, observed: await workspace(run, options) }); }
    catch (error) { checks.push({ id, passed: false, failure: error.message }); }
  };

  await check('source-backed-edit-through-verified-delivery', async context => {
    const patch = await patchMissing(context);
    assert.equal(context.store.state.outbox.length, 0);
    const result = await context.engine.approve(taskId, { reviewToken: reviewed(context) });
    assert.equal(result.status, 'completed');
    assert.equal(result.action.status, 'verified_simulated');
    assert.equal(context.store.state.outbox.length, 1);
    assert.equal(context.store.state.outbox[0].to, 'alex@example.test');
    const decisions = context.store.state.history.filter(entry => ['patch_authorized', 'approval'].includes(entry.kind)).length;
    assert.equal(decisions, 2);
    return { patchReadbackVerified: patch.result.readbackVerified, deliveries: 1, explicitDecisions: decisions, simulated: true };
  });

  await check('partial-success-preserved-without-repeating-the-document-write', async context => {
    const patch = await patchMissing(context);
    const version = context.store.state.documents['atlas-proposal'].version;
    context.engine.provider.lookupOverride = 'unknown';
    await context.engine.approve(taskId, { reviewToken: reviewed(context) });
    assert.equal(context.store.state.tasks[taskId].status, 'blocked');
    assert.equal(context.store.state.outbox.length, 0);
    await context.restart();
    assert.equal(context.store.state.documentPatches[patch.id].status, 'applied');
    assert.equal(context.store.state.documents['atlas-proposal'].version, version);
    assert.equal(context.store.state.tasks[taskId].action.status, 'confirmed_absent');
    assert.equal(context.store.state.outbox.length, 0);
    return { documentStillVerified: true, repeatedDocumentWrites: 0, automaticResends: 0, deliveryStillIncomplete: true };
  });

  let sends = 0;
  class LostResponseProvider extends SimulatedMailProvider {
    send(payload) {
      sends++; super.send(payload); this.lookupOverride = 'unknown';
      throw new UncertainDeliveryError('The local provider accepted the message, but the response was lost.');
    }
  }
  await check('accepted-send-recovers-after-restart-with-one-delivery', async context => {
    seed(context);
    await context.engine.approve(taskId, { reviewToken: reviewed(context) });
    assert.equal(context.store.state.tasks[taskId].status, 'blocked');
    assert.equal(context.store.state.outbox.length, 1);
    await context.restart();
    assert.equal(context.store.state.tasks[taskId].status, 'completed');
    assert.equal(context.store.state.outbox.length, 1);
    assert.equal(sends, 1);
    return { interruptedStatus: 'blocked', recoveredStatus: 'completed', sends, receiptVerified: true };
  }, { providerFactory: store => new LostResponseProvider(store) });

  await check('withdrawn-work-stays-stopped-across-restart', async context => {
    seed(context);
    context.engine.ingest({ ...structuredClone(mail), id: 'atlas-withdraw-event', payload: {
      ...mail.payload, id: 'atlas-withdraw', body: 'Please cancel the Atlas proposal request. No need to send it.', receivedAt: '2026-10-25T10:00:00.000Z'
    } });
    await context.restart();
    assert.equal(context.store.state.tasks[taskId].status, 'cancelled');
    assert.equal(context.store.state.outbox.length, 0);
    assert.throws(() => context.engine.approve(taskId), /not ready/);
    return { stopped: true, sends: 0, taskCount: Object.keys(context.store.state.tasks).length };
  });

  const fixture = SCENARIOS.find(item => item.id === 'model-proposes-valid-probe');
  let calls = 0;
  await check('read-recovery-through-reviewed-and-verified-delivery', async context => {
    for (const event of fixture.events) context.engine.ingest(structuredClone(event));
    await context.engine.whenSettled();
    const id = 'request:mp-1';
    const work = context.store.state.tasks[id].reasoningWork;
    assert.equal(work.retryable, true);
    context.engine.retryPendingReasoning(null, { dueOnly: true, now: new Date(work.retryAt) });
    await context.engine.whenSettled();
    assert.equal(calls, 2);
    assert.equal(context.store.state.tasks[id].reasoningWork.status, 'complete');
    const token = context.engine.publicState().tasks.find(task => task.id === id).reviewToken;
    const result = await context.engine.approve(id, { reviewToken: token });
    assert.equal(result.status, 'completed');
    assert.equal(context.store.state.outbox.length, 1);
    return { modelAttempts: calls, groundedProbeAccepted: true, verifiedDeliveries: 1 };
  }, { reasoner: { available: () => true, async interpretRequest() { return null; }, async proposeProbes() {
    if (++calls === 1) throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
    return structuredClone(fixture.reasoner.probes);
  } } });

  return { kind: 'scripted-whole-work-lifecycle', total: checks.length, passed: checks.filter(item => item.passed).length,
    note: 'Local providers and scripted reasoning only; not a real-model or user-value score.', checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await evaluateLifecycle();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed === report.total ? 0 : 1;
}
