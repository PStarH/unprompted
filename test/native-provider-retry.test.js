import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const input = mode => mode === 'investigation' ? { id: 'provider-issue', type: 'issue.updated', connectorId: 'github', source: 'github', payload: {
  id: 'provider-issue', title: 'Review Cedar budget', body: 'Check the source.', repository: 'team/work', number: 1, assigned: true, state: 'open',
  updatedAt: '2026-11-14T00:00:00.000Z', url: 'https://github.com/team/work/issues/1', assignee: 'reader', author: 'teammate' } }
  : { id: 'provider-event', type: 'email.received', payload: { id: 'provider-message', threadId: 'provider-thread', from: 'person@example.test', to: 'reader@example.test',
    subject: mode === 'discovery' ? 'proposal update' : 'Cedar proposal', body: mode === 'discovery'
      ? 'Please update the proposal for northstar with experiment results.' : 'Please update the Cedar proposal with experiment results.', receivedAt: '2026-11-14T00:00:00.000Z' } };
const interpretation = { deliverable: 'proposal', subjectEntity: 'Cedar', intent: 'update', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results', sourceField: 'body' }] };
const discovery = { deliverable: 'proposal', deliverableQuote: 'proposal', subjectEntity: 'northstar', entityQuote: 'northstar', intent: 'update', intentQuote: 'Please update the proposal', requiredContent: [{ text: 'experiment results', sourceQuote: 'experiment results' }] };
for (const mode of ['interpret', 'probes', 'investigation', 'discovery']) for (const eventualSuccess of [true, false]) test(`native ${mode} provider503 ${eventualSuccess ? 'recovers' : 'exhausts its attempts'} through durable retry`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provider-retry-')), store = new SqliteStore(path.join(dir, 'state.json')); let now = Date.now(), targetCalls = 0; store.database.now = () => now;
  const prefix = { interpret: 'You extract structured facts', probes: 'You propose evidence probes', investigation: 'Investigate the existing task', discovery: 'You identify a direct request' };
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_url, init) => {
    const system = JSON.parse(init.body).messages[0].content, target = system.startsWith(prefix[mode]); if (target) targetCalls++;
    const failed = target && (targetCalls === 1 || !eventualSuccess);
    const output = system.startsWith(prefix.interpret) ? interpretation : system.startsWith(prefix.discovery) ? discovery : system.startsWith(prefix.investigation) ? { nextStep: 'Check source budget.' } : { probes: [] };
    return { ok: !failed, status: failed ? 503 : 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  reasoner.preferModelInterpretation = ['interpret', 'probes'].includes(mode);
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const idle = async () => { await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); };
  engine.ingest(input(mode)); await idle(); assert.equal(targetCalls, 1);
  const waiting = store.jobs.list().find(row => row.state === 'retry_wait' && row.last_error_class !== 'budget');
  assert.ok(waiting, 'a failed native reasoning checkpoint must retain a durable retry');
  const work = mode === 'discovery' ? store.state.events.find(event => event.id === 'provider-event').reasoning : Object.values(store.state.tasks)[0].reasoningWork;
  assert.equal(work.status, 'failed'); assert.equal(work.failureKind, 'provider_transient'); assert.ok(Date.parse(waiting.available_at) >= Date.parse(work.retryAt));
  now = Date.parse(waiting.available_at) - 1; runtime.kick(); await idle(); assert.equal(targetCalls, 1);
  now += 2; runtime.kick(); await idle(); assert.equal(targetCalls, 2);
  if (!eventualSuccess) {
    assert.equal(store.jobs.get(waiting.id).state, 'dead');
    const terminal = mode === 'discovery' ? store.state.events.find(event => event.id === 'provider-event').reasoning : Object.values(store.state.tasks)[0].reasoningWork;
    assert.equal(terminal.terminalReason, 'attempts_exhausted'); assert.equal(terminal.status, 'failed');
    now += 3600000; runtime.kick(); await idle(); assert.equal(targetCalls, 2); return;
  }
  assert.equal(store.jobs.get(waiting.id).state, 'completed');
  if (mode === 'discovery') assert.equal(store.state.events.find(event => event.id === 'provider-event').reasoning.status, 'accepted');
  else assert.equal(Object.values(store.state.tasks)[0].reasoningWork.status, 'complete');
});
