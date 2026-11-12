import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { TokenRequestAccounting } from '../src/token-accounting.js';
import { OpenAiCompatibleReasoner, PiReasoner, createReasoner } from '../src/reasoning.js';
import { completeWithTools } from '../src/tool-loop.js';
import { requireAccountingContext, requestModelJson } from '../src/model-request.js';
import { piSupported } from '../src/pi-runtime.js';

/**
 * Token accounting at the model transport boundary.
 *
 * Every test uses the real DurableDatabase and the real TokenBudgetService and
 * asserts through the public ledger API, so a transport that merely looks
 * accounted but never reserves, dispatches, settles or holds unknown fails.
 * No test reaches a model account: the transport is a fake that records the
 * exact wire body it was handed.
 */

const START = Date.parse('2026-11-12T10:00:00.000Z');

function fixture(t, { now = START } = {}) {
  const clock = { value: now };
  const database = new DurableDatabase(':memory:', { now: () => clock.value });
  const budget = new TokenBudgetService(database);
  t.after(() => database.close());
  return { database, budget, clock };
}

/** Row states in the ledger, so a test can see a cancelled or settled attempt. */
function rows(database) {
  return database.db.prepare('SELECT attempt_id, task_id, state FROM token_budget_reservations ORDER BY created_at, attempt_id').all();
}

const chatBody = ({ content = '{"deliverable":"report","subjectEntity":"Lobby","requiredContent":[]}', usage = { prompt_tokens: 120, completion_tokens: 30 }, finish = 'stop' } = {}) => ({
  choices: [{ message: { content }, finish_reason: finish }],
  ...(usage === null ? {} : { usage })
});

const responsesBody = ({ text = '{"deliverable":"report","subjectEntity":"Lobby","requiredContent":[]}', usage = { input_tokens: 40, output_tokens: 10 } } = {}) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  ...(usage === null ? {} : { usage })
});

const messagesBody = ({ text = '{"deliverable":"report","subjectEntity":"Lobby","requiredContent":[]}', usage = { input_tokens: 30, output_tokens: 12 } } = {}) => ({
  content: [{ type: 'text', text }],
  ...(usage === null ? {} : { usage })
});

/** A response double that the bounded reader can consume as JSON. */
const reply = (body, { ok = true, status = 200 } = {}) => ({
  ok, status,
  headers: { get: () => null },
  json: async () => body
});

test('a classic call settles the provider usage in the ledger', async t => {
  const { database, budget } = fixture(t);
  const bodies = [];
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async (url, init) => {
      bodies.push({ url, body: JSON.parse(init.body) });
      return reply(chatBody({ usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } }));
    }
  });

  const result = await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-1', { scope: 'workspace' });
  assert.equal(result.subjectEntity, 'Lobby');
  assert.equal(bodies.length, 1, 'exactly one request reached the wire');

  const view = budget.describe();
  assert.equal(view.workspace.used, 150, 'cached input is counted once, separately');
  assert.equal(view.workspace.settled, 150);
  assert.equal(view.workspace.pending, 0);
  assert.equal(view.workspace.unknown, 0);
  const [row] = rows(database);
  assert.equal(row.state, 'settled');
});

test('the same accounting works for the responses and messages protocols', async t => {
  const { budget } = fixture(t);
  const bodies = [];

  const responses = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', protocol: 'responses', tokenBudget: budget,
    fetchImpl: async (url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return reply(responsesBody()); }
  });
  await responses.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-responses', { scope: 'workspace' });
  assert.match(bodies[0].url, /\/responses$/);
  assert.equal(budget.describe().workspace.used, 50);

  const messages = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', protocol: 'messages', tokenBudget: budget,
    fetchImpl: async (url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return reply(messagesBody()); }
  });
  await messages.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-messages', { scope: 'workspace' });
  assert.match(bodies[1].url, /\/messages$/);
  assert.equal(budget.describe().workspace.used, 92, 'both protocols settle into the same ledger');
});

test('an HTTP failure that still reports usage settles that usage instead of refunding it', async t => {
  const { budget } = fixture(t);
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => reply(chatBody({ usage: { prompt_tokens: 60, completion_tokens: 5 } }), { ok: false, status: 500 })
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-500', { scope: 'workspace' }),
    /Model provider returned 500/
  );
  const view = budget.describe();
  assert.equal(view.workspace.settled, 65, 'the provider was paid for the failed request');
  assert.equal(view.workspace.unknown, 0);
  assert.equal(view.workspace.pending, 0);
});

test('a response without usage keeps the whole hold unknown', async t => {
  const { database, budget } = fixture(t);
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => reply(chatBody({ usage: null }))
  });

  const result = await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-nousage', { scope: 'workspace' });
  assert.equal(result.subjectEntity, 'Lobby', 'missing usage never blocks the answer itself');
  const view = budget.describe();
  assert.equal(view.workspace.unknown, view.workspace.used, 'the reservation is held, not released');
  assert.equal(view.workspace.settled, 0, 'missing usage is never mapped to a trusted zero');
  assert.equal(rows(database)[0].state, 'unknown');
});

test('a truncated response still settles the usage it reported', async t => {
  const { budget } = fixture(t);
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => reply(chatBody({ finish: 'length', usage: { prompt_tokens: 80, completion_tokens: 16 } }))
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-truncated', { scope: 'workspace' }),
    /incomplete response/
  );
  const view = budget.describe();
  assert.equal(view.workspace.settled, 96, 'a truncated answer is still billed');
  assert.equal(view.workspace.unknown, 0);
});

test('an invalid model payload does not lose the reported usage', async t => {
  const { budget } = fixture(t);
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => reply(chatBody({ content: 'not json', usage: { prompt_tokens: 44, completion_tokens: 6 } }))
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-badjson', { scope: 'workspace' }),
    /JSON/
  );
  assert.equal(budget.describe().workspace.settled, 50);
});

test('a transport failure keeps the dispatched hold instead of refunding it', async t => {
  const { database, budget } = fixture(t);
  let calls = 0;
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error('socket closed'), { name: 'AbortError' }); }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-timeout', { scope: 'workspace' }),
    /socket closed/
  );
  assert.equal(calls, 1);
  const view = budget.describe();
  assert.equal(view.workspace.unknown, view.workspace.used);
  assert.equal(view.workspace.settled, 0);
  assert.equal(rows(database)[0].state, 'unknown');
});

test('an unreadable response body keeps the hold unknown', async t => {
  const { budget } = fixture(t);
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'not json at all' })
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-unreadable', { scope: 'workspace' }),
    /JSON/
  );
  const view = budget.describe();
  assert.equal(view.workspace.unknown, view.workspace.used);
  assert.equal(view.workspace.settled, 0);
});

test('an exhausted limit stops the request before any network call', async t => {
  const { database, budget } = fixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 10 });
  let calls = 0;
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => { calls += 1; return reply(chatBody()); }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-exhausted', { scope: 'workspace' }),
    error => { assert.equal(error.code, 'TOKEN_BUDGET_EXHAUSTED'); return true; }
  );
  assert.equal(calls, 0, 'an exhausted budget must cost no network call');
  assert.equal(reasoner.calls, 0, 'a locally refused request is not counted as a provider call');
  assert.equal(rows(database).length, 0, 'a refused reservation leaves no hold behind');
});

test('a missing or malformed accounting context is a local error with no network call', async t => {
  const { database, budget } = fixture(t);
  let calls = 0;
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async () => { calls += 1; return reply(chatBody()); }
  });

  for (const context of [null, undefined, {}, { scope: 'elsewhere' }, { scope: 'task' }, { scope: 'workspace', taskId: 'task-1' }]) {
    await assert.rejects(
      () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-context', context),
      error => { assert.equal(error.code, 'TOKEN_ACCOUNTING_CONTEXT'); return true; }
    );
  }
  assert.equal(calls, 0);
  assert.equal(rows(database).length, 0, 'a rejected context reserves nothing');
});

test('an abort before dispatch cancels the attempt and releases the hold', async t => {
  const { database, budget } = fixture(t);
  const accounting = new TokenRequestAccounting(budget);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    () => requestModelJson({
      accounting,
      context: requireAccountingContext({ scope: 'workspace' }),
      protocol: 'chat-completions',
      payload: { model: 'm-1', messages: [{ role: 'user', content: 'hello' }] },
      fetchImpl: async () => { calls += 1; return reply(chatBody()); },
      url: 'https://example.test/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      maxResponseChars: 1000
    }),
    /abort/i
  );
  assert.equal(calls, 0, 'an aborted request never reaches the network');
  assert.deepEqual(rows(database).map(row => row.state), ['cancelled']);
  const view = budget.describe();
  assert.equal(view.workspace.used, 0, 'a cancelled attempt releases its hold');
  assert.equal(view.workspace.pending, 0);
});

test('a local size check rejects the request before any reservation exists', async t => {
  const { database, budget } = fixture(t);
  let calls = 0;
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget, limits: { maxRequestChars: 50 },
    fetchImpl: async () => { calls += 1; return reply(chatBody()); }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-large', { scope: 'workspace' }),
    /exceeds 50 characters/
  );
  assert.equal(calls, 0);
  assert.equal(rows(database).length, 0);
});

test('two concurrent tasks keep their own usage', async t => {
  const { budget } = fixture(t);
  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 100000 });
  budget.setLimit({ scope: 'task', taskId: 'task-b', tokens: 100000 });
  const bodies = [];
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      await new Promise(resolve => setTimeout(resolve, 5));
      return reply(chatBody({ usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    }
  });

  await Promise.all([
    reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-a', { scope: 'task', taskId: 'task-a' }),
    reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-b', { scope: 'task', taskId: 'task-b' })
  ]);

  assert.equal(budget.describe({ taskId: 'task-a' }).task.used, 110);
  assert.equal(budget.describe({ taskId: 'task-b' }).task.used, 110);
  assert.equal(budget.describe().workspace.used, 220, 'the workspace total is the sum, not a shared hold');
});

test('the tool loop accounts for every turn with its own attempt', async t => {
  const { database, budget } = fixture(t);
  const bodies = [];
  const executions = [];
  const tool = {
    name: 'lookup',
    description: 'Look up a document',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute(id, args) {
      executions.push({ id, args });
      return { content: [{ type: 'text', text: 'Found: Draco report' }] };
    }
  };
  let turn = 0;
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      turn += 1;
      if (turn === 1) {
        return reply({
          choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"Draco"}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 40, completion_tokens: 8 }
        });
      }
      return reply(chatBody({ content: '{"probes":[]}', usage: { prompt_tokens: 55, completion_tokens: 9 } }));
    }
  });

  const result = await completeWithTools({
    reasoner,
    requestId: 'tools-1',
    system: 'system',
    user: 'user',
    tools: [tool],
    accounting: reasoner.accounting,
    accountingContext: requireAccountingContext({ scope: 'task', taskId: 'task-1' })
  });
  assert.deepEqual(result, { probes: [] });
  assert.equal(executions.length, 1);
  assert.equal(bodies.length, 2);

  assert.equal(bodies[0].tools[0].function.name, 'lookup', 'the tool schema is on the wire');
  assert.equal(bodies[1].tools[0].function.name, 'lookup', 'the tool schema is on the wire again');
  const followUp = JSON.stringify(bodies[1].messages);
  assert.match(followUp, /Draco/, 'the tool result is part of the second request');
  assert.match(followUp, /Found: Draco report/);

  const ledgerRows = rows(database);
  assert.equal(ledgerRows.length, 2, 'each turn is its own attempt');
  assert.notEqual(ledgerRows[0].attempt_id, ledgerRows[1].attempt_id, 'the same request id never reuses an attempt');
  assert.deepEqual(ledgerRows.map(row => row.state), ['settled', 'settled']);
  assert.equal(budget.describe({ taskId: 'task-1' }).task.used, 112);
});

test('an exhausted budget after a tool stops the loop without replaying the tool', async t => {
  const { database, budget } = fixture(t);
  const executions = [];
  const tool = {
    name: 'lookup',
    description: 'Look up a document',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute(id, args) {
      executions.push({ id, args });
      return { content: [{ type: 'text', text: 'Found: Draco report' }] };
    }
  };

  const scriptedFetch = bodies => {
    let turn = 0;
    return async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      turn += 1;
      if (turn === 1) {
        return reply({
          choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"Draco"}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 40, completion_tokens: 8 }
        });
      }
      return reply(chatBody({ content: '{"probes":[]}' }));
    };
  };

  // Calibrate the exact wire size of the first and the follow-up request with
  // the same payload shape the limited run produces.
  const calibration = fixture(t);
  calibration.budget.setLimit({ scope: 'workspace', tokens: 1000000 });
  const calibrationBodies = [];
  const calibrationReasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: calibration.budget,
    fetchImpl: scriptedFetch(calibrationBodies)
  });
  await completeWithTools({
    reasoner: calibrationReasoner,
    requestId: 'tools-calibration',
    system: 'system',
    user: 'user',
    tools: [tool],
    accounting: calibrationReasoner.accounting,
    accountingContext: requireAccountingContext({ scope: 'workspace' })
  });
  const firstBytes = Buffer.byteLength(JSON.stringify(calibrationBodies[0]), 'utf8');
  const secondBytes = Buffer.byteLength(JSON.stringify(calibrationBodies[1]), 'utf8');
  assert.ok(secondBytes > firstBytes, 'the follow-up request is larger than the first one');
  assert.equal(executions.length, 1, 'the calibration run executed the tool once');
  executions.length = 0;

  budget.setLimit({ scope: 'workspace', tokens: firstBytes + 2048 });
  const bodies = [];
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: scriptedFetch(bodies)
  });

  await assert.rejects(
    () => completeWithTools({
      reasoner,
      requestId: 'tools-2',
      system: 'system',
      user: 'user',
      tools: [tool],
      accounting: reasoner.accounting,
      accountingContext: requireAccountingContext({ scope: 'workspace' })
    }),
    error => { assert.equal(error.code, 'TOKEN_BUDGET_EXHAUSTED'); return true; }
  );

  assert.equal(executions.length, 1, 'the tool that already ran is never replayed');
  assert.equal(bodies.length, 1, 'the exhausted turn costs no network call');
  assert.equal(reasoner.calls, 1, 'only the dispatched turn is counted');
  const ledgerRows = rows(database);
  assert.equal(ledgerRows.length, 1, 'the refused turn reserves nothing');
  assert.equal(ledgerRows[0].state, 'settled');
});

test('the accounting context never enters the prompt or the wire payload', async t => {
  const { budget } = fixture(t);
  const bodies = [];
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return reply(chatBody()); }
  });

  await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-context-leak', { scope: 'task', taskId: 'task-secret-1' });
  const wire = JSON.stringify(bodies[0]);
  assert.equal(wire.includes('task-secret-1'), false, 'a trusted task id is a local control value');
  assert.equal(wire.includes('"scope"'), false);
});

test('the advisory usage sink still runs beside the ledger', async t => {
  const { budget } = fixture(t);
  const seen = [];
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget, onUsage: usage => seen.push(usage),
    fetchImpl: async () => reply(chatBody({ usage: { prompt_tokens: 20, completion_tokens: 4 } }))
  });

  await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-usage', { scope: 'workspace' });
  assert.deepEqual(seen, [{
    provider: 'openai-compatible', protocol: 'chat-completions', model: 'm-1', requestId: 'req-usage',
    input: 20, output: 4, cacheRead: 0, cacheWrite: 0
  }]);
  assert.equal(budget.describe().workspace.used, 24);
});

test('without a budget service every existing call keeps working', async () => {
  const bodies = [];
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return reply(chatBody()); }
  });
  const result = await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' });
  assert.equal(result.subjectEntity, 'Lobby');
  assert.equal(bodies.length, 1);
  assert.equal(reasoner.accounting, null);
});

test('the budget service is injected through the reasoner options and through createReasoner', async t => {
  const { budget } = fixture(t);
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget });
  assert.ok(reasoner.accounting instanceof TokenRequestAccounting);

  const built = createReasoner(
    { UNPROMPTED_MODEL_BASE_URL: 'https://example.test/v1', UNPROMPTED_MODEL_NAME: 'm-1' },
    { tokenBudget: budget }
  );
  assert.ok(built.accounting instanceof TokenRequestAccounting);
  assert.equal(createReasoner({ UNPROMPTED_MODEL_BASE_URL: 'https://example.test/v1', UNPROMPTED_MODEL_NAME: 'm-1' }).accounting, null);

  assert.throws(
    () => new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: {} }),
    /requires a TokenBudgetService/
  );
});

const piTest = piSupported() ? test : test.skip;

piTest('Pi refuses a configured token budget instead of bypassing accounting', async t => {
  const { budget } = fixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  let sdkLoaded = false;
  const reasoner = new PiReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    runtimeOptions: { loadSdk: async () => { sdkLoaded = true; throw new Error('The Pi SDK must not be loaded.'); } }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'pi-1', { scope: 'workspace' }),
    error => { assert.equal(error.code, 'TOKEN_BUDGET_UNSUPPORTED_HARNESS'); return true; }
  );
  assert.equal(sdkLoaded, false, 'the SDK never runs, so no provider call can happen');
});

piTest('a zero limit is still a configured limit and is refused for Pi', async t => {
  const { budget } = fixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 0 });
  const reasoner = new PiReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    runtimeOptions: { loadSdk: async () => { throw new Error('The Pi SDK must not be loaded.'); } }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'pi-zero', { scope: 'workspace' }),
    error => { assert.equal(error.code, 'TOKEN_BUDGET_UNSUPPORTED_HARNESS'); return true; }
  );
});

piTest('an unrelated task limit does not block the Pi workspace path', async t => {
  const { budget } = fixture(t);
  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 100000 });
  let sdkLoaded = false;
  const reasoner = new PiReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    runtimeOptions: { loadSdk: async () => { sdkLoaded = true; throw new Error('The Pi SDK is unavailable in this test.'); } }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'pi-unrelated', { scope: 'workspace' }),
    error => { assert.notEqual(error.code, 'TOKEN_BUDGET_UNSUPPORTED_HARNESS'); return true; }
  );
  assert.equal(sdkLoaded, true, 'the gate let the call through to the existing Pi flow');
});

piTest('Pi rejects a missing accounting context before it enters the harness', async t => {
  const { budget } = fixture(t);
  let sdkLoaded = false;
  const reasoner = new PiReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    runtimeOptions: { loadSdk: async () => { sdkLoaded = true; throw new Error('The Pi SDK must not be loaded.'); } }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'pi-no-context'),
    error => { assert.equal(error.code, 'TOKEN_ACCOUNTING_CONTEXT'); return true; }
  );
  assert.equal(sdkLoaded, false);
});

piTest('a ledger describe failure still refuses the Pi call', async t => {
  const { budget } = fixture(t);
  budget.describe = () => { throw new Error('ledger unavailable'); };
  let sdkLoaded = false;
  const reasoner = new PiReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    runtimeOptions: { loadSdk: async () => { sdkLoaded = true; throw new Error('The Pi SDK must not be loaded.'); } }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'pi-ledger-down', { scope: 'workspace' }),
    /ledger unavailable/
  );
  assert.equal(sdkLoaded, false, 'a ledger that cannot answer refuses the call');
});

piTest('Pi keeps its existing flow when no relevant limit is configured', async t => {
  const { budget } = fixture(t);
  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 100000 });
  let sdkLoaded = false;
  const reasoner = new PiReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget,
    runtimeOptions: { loadSdk: async () => { sdkLoaded = true; throw new Error('The Pi SDK is unavailable in this test.'); } }
  });

  await assert.rejects(
    () => reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'pi-compatible', { scope: 'task', taskId: 'task-b' }),
    error => { assert.notEqual(error.code, 'TOKEN_BUDGET_UNSUPPORTED_HARNESS'); return true; }
  );
  assert.equal(sdkLoaded, true, 'another task\'s limit does not block this task');
});
