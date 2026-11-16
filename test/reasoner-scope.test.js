import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forkReasonerConfiguration } from '../src/reasoner-scope.js';
import { OpenAiCompatibleReasoner, NullReasoner, PiReasoner } from '../src/reasoning.js';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { DurableReasoningSessions } from '../src/durable/reasoning-sessions.js';
import { JsonStore } from '../src/store.js';
import { WorkEngine } from '../src/engine.js';
import { piSupported } from '../src/pi-runtime.js';

const input = { subject: 'Lobby report', body: 'Please update the Lobby report.' };
const final = { deliverable: 'report', subjectEntity: 'Lobby', requiredContent: [] };
const reply = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({
  choices: [{ message: { content: JSON.stringify(final) } }], usage: { prompt_tokens: 10, completion_tokens: 5 }
}) });
function ledger(t) {
  const database = new DurableDatabase(':memory:'); t.after(() => database.close());
  return { budget: new TokenBudgetService(database), sessions: new DurableReasoningSessions(database) };
}

test('two workspace forks keep independent ledgers and a denied workspace cannot consume another budget', async t => {
  const a = ledger(t), b = ledger(t); a.budget.setLimit({ scope: 'workspace', tokens: 0 });
  let fetches = 0;
  const source = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'same-model', apiKey: 'fixture-key',
    tokenBudget: a.budget, reasoningSessions: a.sessions, fetchImpl: async () => { fetches++; return reply(); } });
  source.preferModelInterpretation = true;
  const first = forkReasonerConfiguration(source, { tokenBudget: a.budget, reasoningSessions: a.sessions });
  const second = forkReasonerConfiguration(source, { tokenBudget: b.budget, reasoningSessions: b.sessions });
  await assert.rejects(() => first.interpretRequest(input, 'workspace-a', { scope: 'workspace' }), { code: 'TOKEN_BUDGET_EXHAUSTED' });
  assert.equal(fetches, 0);
  await second.interpretRequest(input, 'workspace-b', { scope: 'workspace' });
  assert.equal(fetches, 1); assert.equal(a.budget.describe().workspace.used, 0); assert.equal(b.budget.describe().workspace.settled, 15);
  assert.equal(source.calls, 0); assert.equal(source.tokenBudget, a.budget); assert.equal(source.reasoningSessions, a.sessions);
  assert.notEqual(first.accounting, second.accounting); assert.equal(second.preferModelInterpretation, true);
  const configOnly = forkReasonerConfiguration(source);
  assert.equal(configOnly.tokenBudget, null); assert.equal(configOnly.reasoningSessions, null);
});

test('fresh forks preserve configuration but do not copy errors, active queues or request counters', async () => {
  const source = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'same-model', id: 'custom-native-id',
    timeoutMs: 3333, limits: { maxCallsPerMinute: 3, maxQueued: 2, queueTimeoutMs: 4444 } });
  source.lastError = 'old private diagnostics';
  await source.budget.acquire('old-request'); source.budget.release('old-request');
  const fork = forkReasonerConfiguration(source);
  assert.notEqual(fork.budget, source.budget); assert.equal(fork.lastError, null);
  assert.equal(fork.budget.describe().callsThisWindow, 0); assert.equal(source.budget.describe().callsThisWindow, 1);
  assert.deepEqual(fork.budget.limits, source.budget.limits); assert.equal(fork.timeoutMs, 3333); assert.equal(fork.id, 'custom-native-id');
});

test('workspace usage goes to the new engine once and never through the old engine wrapper', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoner-scope-'));
  const oldStore = new JsonStore(path.join(dir, 'old.json')), newStore = new JsonStore(path.join(dir, 'new.json'));
  t.after(() => { oldStore.close(); newStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let original = 0, oldRecords = 0, newRecords = 0;
  const source = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fake', onUsage: () => { original++; }, fetchImpl: async () => reply() });
  const oldEngine = new WorkEngine(oldStore, { reasoner: source });
  oldEngine.durableRuntime = { usage: { record: () => { oldRecords++; } } };
  const next = forkReasonerConfiguration(oldEngine.reasoner);
  const newEngine = new WorkEngine(newStore, { reasoner: next });
  newEngine.durableRuntime = { usage: { record: () => { newRecords++; } } };
  await next.interpretRequest(input, 'new-workspace');
  assert.equal(original, 1); assert.equal(oldRecords, 0); assert.equal(newRecords, 1);
  assert.equal(source.calls, 0); assert.equal(next.calls, 1);
});

test('each protocol retains its model, endpoint and header semantics after a configuration fork', async () => {
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    let request;
    const source = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'forked-model', apiKey: 'fixture-key', protocol,
      fetchImpl: async (url, init) => {
        request = { url, ...init };
        const body = protocol === 'responses' ? { status: 'completed', output_text: JSON.stringify(final) }
          : protocol === 'messages' ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(final) }] }
            : { choices: [{ message: { content: JSON.stringify(final) } }] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      } });
    await forkReasonerConfiguration(source).interpretRequest(input, protocol);
    assert.equal(JSON.parse(request.body).model, 'forked-model');
    assert.equal(request.url, 'https://example.test/v1/' + (protocol === 'chat-completions' ? 'chat/completions' : protocol));
    assert.equal(protocol === 'messages' ? request.headers['x-api-key'] : request.headers.authorization,
      protocol === 'messages' ? 'fixture-key' : 'Bearer fixture-key');
  }
});

test('Pi forks have separate run history, refuse hard budgets before SDK, and retain unlimited SDK admission', { skip: !piSupported() }, async t => {
  const { budget } = ledger(t); let loads = 0;
  const source = new PiReasoner({ baseUrl: 'https://example.test/v1', model: 'same-model',
    runtimeOptions: { loadSdk: async () => { loads++; throw new Error('synthetic SDK admission'); } } });
  source.runtime.runs.set('old-private-run', { privateText: 'old workspace' });
  const fork = forkReasonerConfiguration(source, { tokenBudget: budget });
  assert.notEqual(fork.runtime, source.runtime); assert.equal(fork.runtime.runs.size, 0);
  assert.notEqual(fork.runtime.active, source.runtime.active);
  budget.setLimit({ scope: 'workspace', tokens: 0 });
  await assert.rejects(() => fork.interpretRequest(input, 'denied-sdk', { scope: 'workspace' }), { code: 'TOKEN_BUDGET_UNSUPPORTED_HARNESS' });
  assert.equal(loads, 0);
  budget.setLimit({ scope: 'workspace', tokens: null });
  await assert.rejects(() => fork.interpretRequest(input, 'allowed-sdk', { scope: 'workspace' }), /synthetic SDK admission/);
  assert.equal(loads, 1); assert.equal(source.runtime.runs.size, 1); assert.equal(source.calls, 0);
});

test('unconfigured primary mode survives a fresh fork and unknown subclasses are not silently downgraded', () => {
  const source = new NullReasoner('source unavailable'); source.preferModelInterpretation = true;
  const fork = forkReasonerConfiguration(source);
  assert.notEqual(fork, source); assert.equal(fork.available(), false); assert.equal(fork.preferModelInterpretation, true);
  assert.equal(fork.status().detail, 'source unavailable');
  class Custom extends OpenAiCompatibleReasoner {}
  assert.throws(() => forkReasonerConfiguration(new Custom({})), { code: 'MODEL_SCOPE_UNSUPPORTED' });
});
