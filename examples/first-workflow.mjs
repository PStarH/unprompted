#!/usr/bin/env node
// A complete local workflow. No server, model, account, network or installed packages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { normalizeEvent } from '../src/connectors/events.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--approve')) {
  console.error('Usage: npm run example -- [--approve]');
  process.exit(2);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-example-'));
const store = new JsonStore(path.join(directory, 'state.json'));
const engine = new WorkEngine(store, { provider: new SimulatedMailProvider(store) });
const event = (id, type, payload) => normalizeEvent({ connectorId: 'example-local',
  source: 'simulated', providerEventId: id, type, at: new Date().toISOString(), payload });
const document = content => ({ id: 'cedar-proposal', kind: 'proposal', title: 'Cedar project proposal', content });
const request = event('request', 'email.received', {
  id: 'cedar-request', from: 'alex@example.test', to: 'maya@example.test',
  subject: 'Cedar proposal — experiment results',
  body: 'Please update the Cedar project proposal with the experiment results and send it to me. I need the sample size, control and treatment conversion results, and your conclusion.'
});
const partial = event('partial', 'document.modified', document('# Cedar project proposal\n\n## Experiment results\nRun date: 2026-10-26\nSample size: 1,200\n'));
const complete = event('complete', 'document.modified', document('# Cedar project proposal\n\n## Experiment results\nRun date: 2026-10-26\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n'));
const getTask = () => Object.values(store.state.tasks)[0];

try {
  console.log('Local framework example · invented data · no external effects\n');
  // Input is an environmental event, not a task handed to the agent.
  engine.ingest(request);
  await engine.whenSettled();
  assert.equal(Object.keys(store.state.tasks).length, 1);
  console.log('1. An email arrived → the engine discovered one follow-up.');
  engine.ingest(partial);
  await engine.whenSettled();
  assert.equal(getTask().status, 'waiting_for_information');
  assert.equal(store.state.outbox.length, 0);
  console.log('2. Partial evidence arrived → it kept waiting; nothing was sent.');
  engine.ingest(complete);
  await engine.whenSettled();
  assert.equal(getTask().status, 'ready_for_approval');
  assert.equal(store.state.outbox.length, 0);
  console.log('3. Complete evidence arrived → a source-backed reply is ready.');
  if (args.includes('--approve')) {
    const reviewed = engine.publicState().tasks[0];
    await engine.approve(reviewed.id, { reviewToken: reviewed.reviewToken });
    await engine.whenSettled();
    assert.equal(getTask().status, 'completed');
    assert.equal(getTask().action.status, 'verified_simulated');
    engine.ingest(complete); // Duplicate delivery of an event must not send again.
    await engine.whenSettled();
    assert.equal(store.state.outbox.length, 1);
    console.log('4. Explicit simulated approval → one receipt verified; duplicate event caused no resend.');
  } else console.log('4. No approval supplied → zero sends. Add --approve to try a verified local delivery.');
  console.log('\nEdit the request or evidence above, then rerun. No build step.');
} finally {
  await engine.whenSettled();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
