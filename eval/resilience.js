#!/usr/bin/env node
// Scripted operational faults: this measures harness behavior, not LLM quality.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { NullReasoner, OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { interpretRequest } from '../src/requests.js';
import { SCENARIOS } from './scenarios.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = SCENARIOS.find(item => item.id === 'model-proposes-valid-probe');
const message = fixture.events.find(event => event.type === 'email.received');
const document = fixture.events.find(event => event.type === 'document.modified');
const scripted = onCall => ({
  available: () => true,
  async proposeProbes(input) { onCall?.(input); await delay(5); return structuredClone(fixture.reasoner.probes); },
  async interpretRequest() { return null; }
});

async function inWorkspace(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-resilience-'));
  const filename = path.join(dir, 'state.json');
  const stores = [];
  const open = () => { const store = new JsonStore(filename); stores.push(store); return store; };
  try { return await run(open); }
  finally { for (const store of stores) store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function evaluateResilience() {
  const checks = [];
  let active = 0, peak = 0;
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://scripted.invalid/v1', model: 'scripted',
    limits: { maxConcurrent: 2, maxQueued: 16, queueTimeoutMs: 500 },
    fetchImpl: async () => {
      active++; peak = Math.max(peak, active);
      try { await delay(5); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ probes: fixture.reasoner.probes }) } }] }) }; }
      finally { active--; }
    }
  });
  const served = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => reasoner.proposeProbes({ request: { subjectEntity: 'Draco', deliverable: 'report', text: message.payload.body }, uncovered: [], providers: ['document_text'], strategies: ['section_body'] }, `burst:${i}`)));
  const successful = served.filter(result => result.status === 'fulfilled').length;
  checks.push({ id: 'bounded-burst', passed: successful === 8 && peak <= 2, observed: { served: successful, requested: 8, peakConcurrency: peak } });

  checks.push(await inWorkspace(async open => {
    let calls = 0;
    const store = open();
    const engine = new WorkEngine(store, { reasoner: scripted(() => calls++) });
    for (const event of fixture.events) engine.ingest(structuredClone(event));
    await engine.whenSettled();
    const taskId = Object.keys(store.state.tasks)[0];
    const before = store.state.tasks[taskId].evidence.plan.specs.filter(spec => spec.origin === 'model').map(spec => spec.criterionId);
    store.close();
    const restartedStore = open();
    const restarted = new WorkEngine(restartedStore, { reasoner: new NullReasoner() });
    restarted.ingest({ ...structuredClone(document), id: 'restart-document-revision', payload: { ...document.payload, version: 2, content: document.payload.content + '\nReviewed.' } });
    await restarted.whenSettled();
    const after = restartedStore.state.tasks[taskId].evidence.plan.specs.filter(spec => spec.origin === 'model').map(spec => spec.criterionId);
    return { id: 'model-plan-restart', passed: before.length > 0 && JSON.stringify(before) === JSON.stringify(after) && calls === 1 && restartedStore.state.outbox.length === 0, observed: { modelProbesBefore: before.length, modelProbesAfter: after.length, modelCalls: calls, sends: restartedStore.state.outbox.length } };
  }));

  checks.push(await inWorkspace(async open => {
    const store = open(); let hints = [];
    const engine = new WorkEngine(store, { reasoner: scripted(input => { hints = input.contextHints; }) });
    for (let i = 0; i < 8; i++) engine.ingest({ id: `noise-${i}`, type: 'document.modified', payload: { id: `other-${i}`, title: `Operations ${i} report`, kind: 'report', content: `# Operations ${i}\nUnrelated operations notes.` } });
    engine.ingest(structuredClone(document)); engine.ingest(structuredClone(message));
    await engine.whenSettled();
    const relevantIncluded = hints.some(hint => hint.includes(document.payload.id));
    return { id: 'relevant-context', passed: relevantIncluded && hints.length <= 5, observed: { relevantIncluded, hints: hints.length, unrelatedDocuments: 8 } };
  }));

  const asyncWork = await inWorkspace(async open => {
    const store = open();
    class DelayedProvider extends SimulatedMailProvider {
      async lookup(key) { await delay(15); return super.lookup(key); }
      async verifyReceipt(receipt) { await delay(5); return super.verifyReceipt(receipt); }
    }
    const nestedMessage = { id: 'nested-email', type: 'email.received', payload: { id: 'nested-1', from: 'lee@example.test', subject: 'Zephyr report', body: 'Please update the Zephyr report with the details and send it by Friday. The experiment results are in the shared folder.' } };
    const nestedDocument = { id: 'nested-document', type: 'document.modified', payload: { id: 'zephyr-report', kind: 'report', title: 'Zephyr report', content: '# Zephyr report\n## Experiment results\nRun date: 2026-10-15\nSample size: 400\nControl: 5.0% signup\nTreatment: 6.2% signup\nConclusion: Treatment improved signup.' } };
    const nestedReasoner = { available: () => true, async interpretRequest() { await delay(5); return { deliverable: 'report', subjectEntity: 'Zephyr', intent: 'update_and_send', requiredContent: ['experiment results'] }; }, async proposeProbes() { return []; } };
    const engine = new WorkEngine(store, { provider: new DelayedProvider(store), reasoner: nestedReasoner });
    const request = interpretRequest(nestedMessage.payload);
    engine.recordCalibration({ key: 'permission:send_automation', kind: 'permission', value: 'allow', scope: { entity: request.subjectEntity, deliverable: request.deliverable } });
    engine.ingest(nestedDocument); engine.ingest(nestedMessage);
    await engine.whenSettled();
    const atSettled = Object.values(store.state.tasks)[0].status;
    // Give the baseline's incorrectly untracked nested work time to finish before cleanup.
    await delay(50); await engine.whenSettled();
    const retained = engine.pending?.size ?? engine.pending?.length ?? 0;
    return { atSettled, retained, final: Object.values(store.state.tasks)[0].status, sends: store.state.outbox.length };
  });
  checks.push({ id: 'nested-work-drain', passed: asyncWork.atSettled === 'completed' && asyncWork.sends === 1, observed: { statusWhenSettled: asyncWork.atSettled, final: asyncWork.final, sends: asyncWork.sends } });
  checks.push({ id: 'settled-work-retention', passed: asyncWork.retained === 0, observed: { retainedPromises: asyncWork.retained } });
  return { kind: 'scripted-harness-resilience', total: checks.length, passed: checks.filter(check => check.passed).length, checks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await evaluateResilience();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed === report.total ? 0 : 1;
}
