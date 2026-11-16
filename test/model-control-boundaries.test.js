import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { interpretRequestWithReasoner, recoverRequestCandidateWithReasoner } from '../src/requests.js';
import { normalizeModelSettings, validateModelSettings } from '../src/model-setup.js';

const message = { id: 'synthetic-message', from: 'person@example.test', subject: 'project update',
  body: 'Please update the proposal for northstar with experiment results.' };
const settings = normalizeModelSettings({ baseUrl: 'https://example.test/v1', model: 'fake' });
const context = { scope: 'workspace' };
const paths = [
  ['interpret', interpretRequestWithReasoner, 'interpretRequest'],
  ['discovery', recoverRequestCandidateWithReasoner, 'discoverRequestCandidate']
];

for (const [label, helper, method] of paths) {
  test(`${label} propagates protected control errors unchanged before legacy failure callbacks`, async () => {
    for (const code of ['TOKEN_BUDGET_EXHAUSTED', 'MONEY_BUDGET_EXHAUSTED', 'TOKEN_ACCOUNTING_CONTEXT',
      'INVALID_TOKEN_ACCOUNTING', 'TOKEN_BUDGET_UNSUPPORTED_HARNESS', 'SESSION_OWNER_LOST',
      'SESSION_RECONCILIATION_REQUIRED', 'INVALID_SESSION', 'SQLITE_BUSY', 'STORE_CLOSED', 'CONTEXT_CHANGED', 'PRIVACY_CHANGED', 'LEASE_LOST']) {
      let calls = 0, legacy = 0;
      const error = Object.assign(new Error('controlled local failure'), { code, status: 429 });
      const reasoner = { available: () => true, [method]: async (_input, id, actual) => {
        calls++; assert.equal(id, 'explicit-request'); assert.equal(actual, context); throw error;
      } };
      await assert.rejects(() => helper(message, reasoner, { preferModel: true, reasoningRequestId: 'explicit-request',
        accountingContext: context, onError: () => { legacy++; } }), actual => actual === error);
      assert.equal(calls, 1);
      assert.equal(legacy, 0, 'a protected failure does not first enter the old generic failure path');
    }
  });

  test(`${label} preserves ordinary provider fallback while forwarding explicit trusted context`, async () => {
    for (const status of [429, 503]) {
      let callback = null, calls = 0;
      const error = Object.assign(new Error('provider unavailable'), { status });
      const reasoner = { available: () => true, [method]: async (_input, id, actual) => {
        calls++; assert.equal(id, 'provider-request'); assert.equal(actual, context); throw error;
      } };
      await helper(message, reasoner, { preferModel: true, reasoningRequestId: 'provider-request',
        accountingContext: context, onError: actual => { callback = actual; } });
      assert.equal(calls, 1); assert.equal(callback, error);
    }
  });

  test(`${label} with a real zero-budget service refuses before fake provider fetch`, async t => {
    const database = new DurableDatabase(':memory:'); t.after(() => database.close());
    const budget = new TokenBudgetService(database); budget.setLimit({ scope: 'workspace', tokens: 0 });
    let fetches = 0;
    const reasoner = new OpenAiCompatibleReasoner({ baseUrl: settings.baseUrl, model: settings.model, tokenBudget: budget,
      fetchImpl: async () => { fetches++; throw new Error('must not fetch'); } });
    await assert.rejects(() => helper(message, reasoner, { preferModel: true, accountingContext: context }),
      error => error.code === 'TOKEN_BUDGET_EXHAUSTED');
    assert.equal(fetches, 0);
  });

  test(`${label} keeps a zero task budget isolated and never sends its accounting identity`, async t => {
    const database = new DurableDatabase(':memory:'); t.after(() => database.close());
    const budget = new TokenBudgetService(database);
    budget.setLimit({ scope: 'workspace', tokens: 1000000 });
    budget.setLimit({ scope: 'task', taskId: 'blocked-private-task', tokens: 0 });
    const wires = [];
    const reasoner = new OpenAiCompatibleReasoner({ baseUrl: settings.baseUrl, model: settings.model, tokenBudget: budget,
      fetchImpl: async (_url, init) => {
        wires.push(init.body);
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
          choices: [{ message: { content: JSON.stringify({ deliverable: 'proposal', deliverableQuote: 'proposal',
            subjectEntity: 'northstar', entityQuote: 'northstar', intent: 'update', intentQuote: 'Please update the proposal', requiredContent: [] }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 }
        }) };
      } });
    await assert.rejects(() => helper(message, reasoner, { preferModel: true, reasoningRequestId: 'blocked-task-request',
      accountingContext: { scope: 'task', taskId: 'blocked-private-task' } }), error => error.code === 'TOKEN_BUDGET_EXHAUSTED');
    assert.equal(wires.length, 0);
    await helper(message, reasoner, { preferModel: true, reasoningRequestId: 'allowed-task-request',
      accountingContext: { scope: 'task', taskId: 'allowed-private-task' } });
    assert.equal(wires.length, 1);
    assert.equal(wires[0].includes('allowed-private-task'), false);
    assert.equal(budget.describe({ taskId: 'allowed-private-task' }).task.settled, 14);
    assert.equal(budget.describe({ taskId: 'blocked-private-task' }).task.used, 0);
  });
}

test('unknown outcome, cancellation and secondary accounting faults propagate without a special code', async () => {
  for (const error of [Object.assign(new Error('unknown'), { writeOutcomeUnknown: true }),
    Object.assign(new Error('abort'), { name: 'AbortError' }),
    Object.assign(new Error('provider failure'), { status: 503, accountingFailure: 'SQLITE_BUSY' })]) {
    for (const [_label, helper, method] of paths) {
      let callbacks = 0;
      await assert.rejects(() => helper(message, { available: () => true, [method]: async () => { throw error; } },
        { preferModel: true, onError: () => { callbacks++; } }), actual => actual === error);
      assert.equal(callbacks, 0);
    }
  }
});

test('synthetic settings verification obeys workspace zero then settles known usage after raising budget', async t => {
  const database = new DurableDatabase(':memory:'); t.after(() => database.close());
  const budget = new TokenBudgetService(database); budget.setLimit({ scope: 'workspace', tokens: 0 });
  let fetches = 0, wire = '';
  const options = { tokenBudget: budget, fetchImpl: async (_url, init) => {
    fetches++; wire = init.body;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ deliverable: 'proposal', subjectEntity: 'Cedar',
        requiredContent: [{ text: 'sample size', sourceQuote: 'sample size', sourceField: 'body' }] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }) };
  } };
  await assert.rejects(() => validateModelSettings(settings, options), error => error.code === 'TOKEN_BUDGET_EXHAUSTED');
  assert.equal(fetches, 0);
  budget.setLimit({ scope: 'workspace', tokens: 1000000 });
  const checked = await validateModelSettings(settings, options);
  assert.equal(checked.validation.status, 'verified');
  assert.equal(fetches, 1);
  assert.equal(budget.describe().workspace.settled, 14);
  assert.equal(checked.reasoner.tokenBudget, budget);
  assert.equal(wire.includes('accountingContext'), false);
});

test('synthetic model setup cannot impersonate a task accounting context', async () => {
  let fetches = 0;
  await assert.rejects(() => validateModelSettings(settings, { accountingContext: { scope: 'task', taskId: 'foreign-task' },
    fetchImpl: async () => { fetches++; throw new Error('must not fetch'); } }), error => error.code === 'TOKEN_ACCOUNTING_CONTEXT');
  assert.equal(fetches, 0);
});
