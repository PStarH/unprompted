import test from 'node:test';
import assert from 'node:assert/strict';
import { responseUsage } from '../src/model-protocol.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { completeWithTools } from '../src/tool-loop.js';
import { openActivationReplay } from '../src/durable/activation-replay.js';

test('responseUsage normalizes each provider protocol', () => {
  assert.deepEqual(responseUsage('chat-completions', {
    usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } }
  }), { input: 12, output: 7, cacheRead: 3, cacheWrite: 0 });
  assert.deepEqual(responseUsage('responses', {
    usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } }
  }), { input: 10, output: 4, cacheRead: 2, cacheWrite: 0 });
  assert.deepEqual(responseUsage('messages', {
    usage: { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }
  }), { input: 9, output: 5, cacheRead: 4, cacheWrite: 2 });
});

test('responseUsage treats missing or malformed counts as unknown, never negative', () => {
  assert.deepEqual(responseUsage('chat-completions', {}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(responseUsage('messages', {
    usage: { input_tokens: -5, output_tokens: 'many', cache_read_input_tokens: 2.9 }
  }), { input: 0, output: 0, cacheRead: 2, cacheWrite: 0 });
  // An unrecognized protocol falls back to the default wire format.
  assert.deepEqual(responseUsage('unknown', { usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test('the usage ledger records per-call tokens and groups them by provider and model', async t => {
  const env = openActivationReplay();
  t.after(() => env.close());
  const ledger = env.runtime.usage;

  const first = ledger.record({ provider: 'openai-compatible', protocol: 'chat-completions', model: 'm-1', requestId: 'r-1', input: 10, output: 5, cacheRead: 2 });
  assert.ok(first.id);
  assert.equal(first.input, 10);
  assert.equal(first.output, 5);
  // Request identifiers are deliberately not persisted.
  assert.equal(env.runtime.db.prepare('SELECT COUNT(*) n FROM model_usage WHERE request_id IS NOT NULL').get().n, 0);
  // A response without usage fields writes no row.
  assert.equal(ledger.record({ provider: 'openai-compatible', input: 0, output: 0 }), null);
  ledger.record({ provider: 'pi', protocol: 'messages', model: 'm-2', input: 4, output: 1, cacheWrite: 2 });

  const summary = ledger.summary();
  assert.equal(summary.total.calls, 2);
  assert.equal(summary.total.input, 14);
  assert.equal(summary.total.output, 6);
  assert.equal(summary.total.cacheRead, 2);
  assert.equal(summary.total.cacheWrite, 2);
  const pi = summary.byProviderModel.find(row => row.provider === 'pi');
  assert.equal(pi.model, 'm-2');
  assert.equal(pi.calls, 1);
  assert.equal(pi.input, 4);
});

test('the usage summary totals every row even when the grouped list is capped', async t => {
  const env = openActivationReplay();
  t.after(() => env.close());
  for (let i = 0; i < 55; i++) env.runtime.usage.record({ provider: `provider-${i}`, protocol: 'chat-completions', model: 'm', input: 1 });
  const summary = env.runtime.usage.summary();
  assert.equal(summary.total.calls, 55);
  assert.equal(summary.total.input, 55);
  assert.equal(summary.byProviderModel.length, 50);
});

test('the engine binds a reasoner usage sink to the workspace ledger once', async t => {
  const env = openActivationReplay();
  t.after(() => env.close());
  const seen = [];
  const reasoner = {
    onUsage: usage => seen.push(usage),
    reportUsage(usage) { this.onUsage?.(usage); }
  };
  env.engine.bindReasonerUsage(reasoner);
  reasoner.reportUsage({ input: 3, output: 1 });
  assert.deepEqual(seen, [{ input: 3, output: 1 }], 'any existing sink still runs');
  assert.equal(env.runtime.usage.summary().total.input, 3);
  // Re-binding the same reasoner must not double-count.
  env.engine.bindReasonerUsage(reasoner);
  reasoner.reportUsage({ input: 2, output: 1 });
  assert.equal(env.runtime.usage.summary().total.input, 5);
  assert.equal(env.runtime.usage.summary().total.calls, 2);
});

test('a completed model call reports normalized usage to the sink', async () => {
  const seen = [];
  const body = {
    choices: [{ message: { content: JSON.stringify({ deliverable: 'report', subjectEntity: 'Lobby', requiredContent: [] }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } }
  };
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    onUsage: usage => seen.push(usage)
  });
  const result = await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-1');
  assert.equal(result.deliverable, 'report');
  assert.deepEqual(seen, [{
    provider: 'openai-compatible', protocol: 'chat-completions', model: 'm-1', requestId: 'req-1',
    input: 120, output: 30, cacheRead: 20, cacheWrite: 0
  }]);
});

test('tool-loop follow-up responses report usage without affecting the answer', async () => {
  const seen = [];
  const body = {
    choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 10 }
  };
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    onUsage: usage => seen.push(usage)
  });
  const result = await completeWithTools({ reasoner, requestId: 'tools-1', system: 'system', user: 'user', tools: [] });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [{
    provider: 'openai-compatible', protocol: 'chat-completions', model: 'm-1', requestId: 'tools-1',
    input: 50, output: 10, cacheRead: 0, cacheWrite: 0
  }]);
});

test('a broken usage sink is recorded but never fails the model call', async () => {
  const body = {
    choices: [{ message: { content: JSON.stringify({ deliverable: 'report', subjectEntity: 'Lobby', requiredContent: [] }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 }
  };
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    onUsage: () => { throw new Error('sink unavailable'); }
  });
  const result = await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-2');
  assert.equal(result.deliverable, 'report');
  assert.equal(reasoner.lastUsageError, 'sink unavailable');
});
