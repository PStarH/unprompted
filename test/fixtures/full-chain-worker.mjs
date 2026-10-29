import assert from 'node:assert/strict';
import { SqliteStore } from '../../src/durable/store.js';
import { DurableRuntime } from '../../src/durable/runtime.js';
import { WorkEngine } from '../../src/engine.js';
import { NullReasoner, OpenAiCompatibleReasoner } from '../../src/reasoning.js';
import { CursorStore } from '../../src/connectors/connector.js';
import { ConnectorSync } from '../../src/connectors/sync.js';

const [phase, filename, endpoint] = process.argv.slice(2);
const store = new SqliteStore(filename);
const provider = {
  kind: 'fixture-mail', live: true, canSend: true, dispatchGuard: true,
  async lookup(key) {
    const response = await fetch(`${endpoint}/receipt?key=${encodeURIComponent(key)}`);
    return response.json();
  },
  async verifyReceipt(receipt) { return this.lookup(receipt.idempotencyKey); },
  async send(payload, _mode, { beforeDispatch, signal }) {
    beforeDispatch();
    const response = await fetch(`${endpoint}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
    assert.equal(response.status, 200);
    await response.json();
    if (phase === 'crash-after-remote') process.exit(23);
    throw new Error('Unexpected second dispatch.');
  }
};
const reasoner = phase === 'crash-after-remote'
  ? new OpenAiCompatibleReasoner({ baseUrl: `${endpoint}/model/v1`, model: 'scripted' }) : new NullReasoner();
const externalTools = phase === 'crash-after-remote' ? scope => [{
  name: 'fixture_lookup', description: 'Read the task source.', parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => { assert.ok(scope.isCurrent()); return { content: [{ type: 'text', text: 'Source context is available.' }] }; }
}] : null;
const engine = new WorkEngine(store, { provider, reasoner, externalTools });
const runtime = new DurableRuntime(engine, { tickMs: 100000 });
if (phase === 'crash-after-feedback') {
  const verified = runtime.verifiedAction.bind(runtime);
  runtime.verifiedAction = (...args) => { verified(...args); process.exit(24); };
}
if (phase === 'crash-during-feedback') {
  const feedback = runtime.experiences.feedback.bind(runtime.experiences);
  runtime.experiences.feedback = input => {
    if (input.kind === 'verified_consumption') process.exit(25);
    return feedback(input);
  };
}
try {
  if (phase === 'crash-after-remote') {
    runtime.memory.put({ id: 'cedar-preference', content: 'Cedar proposal: lead with the experiment results.', scopeType: 'project', scopeKey: 'Cedar' });
    const connector = { id: 'simulated', live: true, async pull() { return { cursor: { offset: 1 }, events: [
      { id: 'email:m1', providerEventId: 'mail:m1', connectorId: 'simulated', source: 'simulated', type: 'email.received', payload: { id: 'm1', threadId: 'thread:m1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send the revised proposal by Friday.' } },
      { id: 'doc:1', providerEventId: 'doc:1', connectorId: 'simulated', source: 'simulated', type: 'document.modified', payload: { id: 'cedar-proposal', kind: 'proposal', title: 'Cedar project proposal', content: '# Cedar project proposal\n## Experiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion; recommend a monitored rollout.\n' } }
    ] }; } };
    const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
    const first = await sync.run();
    assert.equal(first.results[0].ingested, 2);
    await engine.whenSettled();
    const replay = await sync.run();
    assert.equal(replay.results[0].duplicates, 2);
    const task = engine.publicState().tasks.find(item => item.id === 'request:m1');
    assert.equal(task.status, 'ready_for_approval');
    assert.ok(task.situationId);
    const memoryRead = store.db.prepare("SELECT 1 FROM lineage l JOIN task_runs r ON r.id=l.derived_id WHERE l.source_kind='memory' AND l.source_id='cedar-preference' AND l.derived_kind='task_run' AND r.task_id=?").get(task.id);
    assert.ok(memoryRead, 'the task checkpoint must trace the retrieved memory');
    const candidate = runtime.experiences.create({ kind: 'execution_hint', scopeType: 'project', scopeKey: 'Cedar', instruction: 'Use Markdown for Cedar replies.', directiveKey: 'email.draft.format', effect: { type: 'draft_format', format: 'markdown' } }, { sources: [{ kind: 'event', id: 'email:m1' }] });
    await runtime.trial(candidate.id, { taskId: task.id, reviewToken: task.reviewToken });
    const reviewed = engine.publicState().tasks.find(item => item.id === task.id);
    assert.match(reviewed.draft.body, /^## /);
    assert.throws(() => engine.execute(task.id), /approval/i, 'a candidate cannot grant permission to send');
    await engine.approve(task.id, { reviewToken: reviewed.reviewToken });
    throw new Error('Expected process to stop immediately after the remote accepted the write.');
  }
  runtime.start();
  await runtime.whenIdle();
  await engine.whenSettled();
  if (phase === 'recover-unknown') {
    assert.equal(store.tasks.get('request:m1').status, 'blocked');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM feedback_events').get().n, 0);
  } else if (phase === 'crash-after-feedback' || phase === 'crash-during-feedback') {
    // Explicit reconciliation is also available when an earlier provider read
    // remained unknown and its startup job has already finished.
    await engine.reconcile('request:m1');
    throw new Error('Expected process to stop after feedback was recorded.');
  } else {
  assert.equal(store.tasks.get('request:m1').status, 'completed');
  }
} finally {
  await runtime.close();
  await engine.whenSettled();
  store.close();
}
