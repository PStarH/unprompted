import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DurableDatabase } from '../src/durable/database.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { TokenRequestAccounting } from '../src/token-accounting.js';

/**
 * Transport-facing token accounting adapter behaviour.
 *
 * Every test uses the real DurableDatabase and TokenBudgetService. The adapter
 * is exercised through its public methods and the ledger is checked through
 * the core service, so an adapter that merely returns plausible values without
 * reserving, dispatching, settling or marking holds unknown would fail.
 *
 * `prepare` requires an explicit scope in every test: `'workspace'` for work
 * that is not attributable to a task (discovery, connection checks) and
 * `'task'` with a trusted task id for task work.
 */

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const START = Date.parse('2026-11-12T10:00:00.000Z');

function memoryFixture(t, { now = START } = {}) {
  const clock = { value: now };
  const database = new DurableDatabase(':memory:', { now: () => clock.value });
  const budget = new TokenBudgetService(database);
  const accounting = new TokenRequestAccounting(budget);
  t.after(() => database.close());
  return { database, budget, accounting, clock };
}

const chatPayload = (overrides = {}) => ({
  model: 'chat-test',
  temperature: 0,
  messages: [
    { role: 'system', content: '你是一个严谨的助手。' },
    { role: 'user', content: '请总结这个仓库的模块。' }
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'lookup',
      description: '查询仓库内容',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  }],
  ...overrides
});

const responsesPayload = (overrides = {}) => ({
  model: 'responses-test',
  instructions: '你是一个严谨的助手。',
  input: [{ role: 'user', content: [{ type: 'input_text', text: '请总结这个仓库的模块。' }] }],
  tools: [{
    type: 'function',
    name: 'lookup',
    description: '查询仓库内容',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  }],
  ...overrides
});

const messagesPayload = (overrides = {}) => ({
  model: 'messages-test',
  system: '你是一个严谨的助手。',
  messages: [{ role: 'user', content: '请总结这个仓库的模块。' }],
  tools: [{
    name: 'lookup',
    description: '查询仓库内容',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  }],
  ...overrides
});

const payloadFor = protocol => protocol === 'chat-completions'
  ? chatPayload()
  : protocol === 'responses' ? responsesPayload() : messagesPayload();

const byteLength = payload => Buffer.byteLength(JSON.stringify(payload), 'utf8');

function rejected(fn, expected = {}) {
  try {
    fn();
  } catch (error) {
    if (expected.code !== undefined) assert.equal(error.code, expected.code);
    if (expected.status !== undefined) assert.equal(error.status, expected.status);
    return error;
  }
  assert.fail(`expected ${expected.code ?? 'an error'}`);
}

function preparedAndDispatched(accounting, { protocol, payload, scope = 'workspace', taskId = null }) {
  const prepared = accounting.prepare({ protocol, payload, scope, taskId });
  accounting.markDispatched(prepared.attempt);
  return prepared;
}

test('prepare reserves the complete UTF-8 wire payload without mutating the caller object', t => {
  const { budget, accounting } = memoryFixture(t);
  const payload = chatPayload();
  const snapshot = structuredClone(payload);
  const expected = byteLength(payload);
  assert.ok(expected > 0);
  assert.ok(expected > JSON.stringify(payload).length, 'Chinese content is counted in UTF-8 bytes, not code units');

  const prepared = accounting.prepare({ protocol: 'chat-completions', payload, scope: 'workspace' });
  assert.deepEqual(payload, snapshot, 'the caller payload was not modified');
  assert.notEqual(prepared.payload, payload, 'the returned payload is a separate object');
  assert.deepEqual(prepared.payload, payload);
  assert.equal(prepared.attempt.protocol, 'chat-completions');
  assert.equal(prepared.attempt.scope, 'workspace');
  assert.equal(prepared.attempt.taskId, null);
  assert.equal(prepared.attempt.inputTokens, expected);
  assert.equal(prepared.attempt.outputTokens, 2048, 'an uncapped request holds a conservative output estimate');
  assert.equal(prepared.attempt.outputBound, 'estimated');
  assert.deepEqual(Object.keys(prepared.attempt).sort(),
    ['attemptId', 'inputTokens', 'outputBound', 'outputTokens', 'protocol', 'scope', 'taskId']);
  assert.ok(Object.isFrozen(prepared.attempt));

  const second = accounting.prepare({ protocol: 'chat-completions', payload, scope: 'workspace' });
  assert.notEqual(second.attempt.attemptId, prepared.attempt.attemptId, 'every prepare gets a fresh random attempt id');

  const view = budget.describe();
  assert.equal(view.workspace.pending, (expected + 2048) * 2);
  assert.equal(view.workspace.attempts.pending, 2);
  assert.equal(prepared.reservation.reserved.input, expected);
  assert.equal(prepared.reservation.reserved.output, 2048);
});

test('the input estimate includes tools, schemas and tool-loop follow-up results', t => {
  const { accounting } = memoryFixture(t);
  const base = { model: 'tool-test', messages: [{ role: 'user', content: '你好' }] };
  const followUp = {
    model: 'tool-test',
    messages: [
      { role: 'user', content: '你好' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"模块"}' } }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: '工具返回的跟进结果'.repeat(40) }
    ],
    tools: [{
      type: 'function',
      function: { name: 'lookup', description: '查询', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
    }]
  };
  const simple = accounting.prepare({ protocol: 'chat-completions', payload: base, scope: 'workspace' });
  const toolLoop = accounting.prepare({ protocol: 'chat-completions', payload: followUp, scope: 'workspace' });
  assert.equal(simple.attempt.inputTokens, byteLength(base));
  assert.equal(toolLoop.attempt.inputTokens, byteLength(followUp));
  assert.ok(toolLoop.attempt.inputTokens > simple.attempt.inputTokens + 100,
    'tools and follow-up results are part of the estimate');
});

for (const [protocol, make, field] of [
  ['chat-completions', chatPayload, 'max_tokens'],
  ['responses', responsesPayload, 'max_output_tokens'],
  ['messages', messagesPayload, 'max_tokens']
]) {
  test(`a configured workspace limit adds the ${protocol} output cap`, t => {
    const { budget, accounting } = memoryFixture(t);
    budget.setLimit({ scope: 'workspace', tokens: 100000 });
    const payload = make();
    const snapshot = structuredClone(payload);
    assert.equal(Object.hasOwn(snapshot, field), false);

    const prepared = accounting.prepare({ protocol, payload, scope: 'workspace' });
    assert.deepEqual(payload, snapshot, 'the caller payload was not modified');
    assert.equal(prepared.payload[field], 2048);
    assert.equal(prepared.attempt.outputTokens, 2048);
    assert.equal(prepared.attempt.outputBound, 'enforced');
    const expectedInput = byteLength(prepared.payload);
    assert.equal(prepared.attempt.inputTokens, expectedInput);
    assert.equal(prepared.reservation.reserved.input, expectedInput);
    assert.equal(prepared.reservation.reserved.output, 2048);
    assert.equal(budget.describe().workspace.pending, expectedInput + 2048);
  });
}

test('an existing smaller cap is preserved and a larger one is reduced to 2048', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });

  const messages = accounting.prepare({
    protocol: 'messages',
    payload: messagesPayload({ max_tokens: 512 }),
    scope: 'workspace'
  });
  assert.equal(messages.payload.max_tokens, 512);
  assert.equal(messages.attempt.outputTokens, 512);

  const responses = accounting.prepare({
    protocol: 'responses',
    payload: responsesPayload({ max_output_tokens: 4096 }),
    scope: 'workspace'
  });
  assert.equal(responses.payload.max_output_tokens, 2048);
  assert.equal(responses.attempt.outputTokens, 2048);

  const chat = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload({ max_tokens: 4096 }),
    scope: 'workspace'
  });
  assert.equal(chat.payload.max_tokens, 2048);
  assert.equal(chat.attempt.outputTokens, 2048);

  const modernChat = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload({ max_completion_tokens: 1024 }),
    scope: 'workspace'
  });
  assert.equal(modernChat.payload.max_completion_tokens, 1024);
  assert.equal(Object.hasOwn(modernChat.payload, 'max_tokens'), false);
  assert.equal(modernChat.attempt.outputTokens, 1024);
});

for (const [protocol, make, foreignFields] of [
  ['chat-completions', chatPayload, ['max_output_tokens']],
  ['responses', responsesPayload, ['max_tokens', 'max_completion_tokens']],
  ['messages', messagesPayload, ['max_completion_tokens', 'max_output_tokens']]
]) {
  test(`a configured limit rejects foreign ${protocol} cap fields before reserving`, t => {
    const { budget, accounting } = memoryFixture(t);
    budget.setLimit({ scope: 'workspace', tokens: 100000 });
    const before = budget.describe();
    for (const field of foreignFields) {
      for (const value of [999999, 512, '100', -1, null, 1.5]) {
        const error = rejected(
          () => accounting.prepare({ protocol, payload: make({ [field]: value }), scope: 'workspace' }),
          { code: 'INVALID_TOKEN_ACCOUNTING', status: 400 }
        );
        assert.ok(error.message.includes(field), `${field} is named without echoing payload text`);
      }
    }
    const after = budget.describe();
    assert.equal(after.workspace.used, before.workspace.used);
    assert.equal(after.workspace.attempts.pending, 0);
  });
}

test('a configured limit rejects a foreign cap even next to the protocol cap', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  for (const [protocol, payload] of [
    ['responses', responsesPayload({ max_output_tokens: 1024, max_tokens: 999999 })],
    ['messages', messagesPayload({ max_tokens: 1024, max_completion_tokens: 999999 })],
    ['chat-completions', chatPayload({ max_tokens: 1024, max_output_tokens: 999999 })]
  ]) {
    assert.throws(
      () => accounting.prepare({ protocol, payload, scope: 'workspace' }),
      { code: 'INVALID_TOKEN_ACCOUNTING', status: 400 }
    );
  }
  assert.equal(budget.describe().workspace.attempts.pending, 0);
});

test('without a configured limit foreign caps are preserved but never size the output hold', t => {
  const { accounting } = memoryFixture(t);

  const chat = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload({ max_output_tokens: 999999 }),
    scope: 'workspace'
  });
  assert.equal(chat.payload.max_output_tokens, 999999);
  assert.equal(chat.attempt.outputTokens, 2048);
  assert.equal(chat.attempt.outputBound, 'estimated');

  const responses = accounting.prepare({
    protocol: 'responses',
    payload: responsesPayload({ max_tokens: 4096, max_completion_tokens: 'x' }),
    scope: 'workspace'
  });
  assert.equal(responses.payload.max_tokens, 4096);
  assert.equal(responses.payload.max_completion_tokens, 'x');
  assert.equal(responses.attempt.outputTokens, 2048);
  assert.equal(responses.attempt.outputBound, 'estimated');

  const messages = accounting.prepare({
    protocol: 'messages',
    payload: messagesPayload({ max_tokens: 4096, max_completion_tokens: 999999 }),
    scope: 'workspace'
  });
  assert.equal(messages.payload.max_tokens, 4096);
  assert.equal(messages.payload.max_completion_tokens, 999999);
  assert.equal(messages.attempt.outputTokens, 4096, 'the protocol cap is reserved without a forced clamp');
  assert.equal(messages.attempt.outputBound, 'enforced');

  const bothChatCaps = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload({ max_tokens: 1024, max_completion_tokens: 4096 }),
    scope: 'workspace'
  });
  assert.equal(bothChatCaps.payload.max_tokens, 1024);
  assert.equal(bothChatCaps.payload.max_completion_tokens, 4096);
  assert.equal(bothChatCaps.attempt.outputTokens, 4096, 'the larger legal explicit cap is the conservative hold');
  assert.equal(bothChatCaps.attempt.outputBound, 'enforced');
});

test('a task limit alone adds the output cap and scopes the reservation to the task', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'task', taskId: 'task-1', tokens: 100000 });

  const prepared = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload(),
    scope: 'task',
    taskId: 'task-1'
  });
  assert.equal(prepared.payload.max_tokens, 2048);
  assert.equal(prepared.attempt.scope, 'task');
  assert.equal(prepared.attempt.taskId, 'task-1');
  assert.equal(prepared.reservation.taskId, 'task-1');
  const view = budget.describe({ taskId: 'task-1' });
  assert.equal(view.workspace.limit, null);
  assert.equal(view.task.limit, 100000);
  assert.equal(view.task.pending, prepared.reservation.reserved.total);

  const workspaceCall = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(Object.hasOwn(workspaceCall.payload, 'max_tokens'), false, 'a task limit alone does not cap workspace work');
  assert.equal(workspaceCall.attempt.outputTokens, 2048);
  assert.equal(workspaceCall.attempt.outputBound, 'estimated');
  assert.equal(view.task.pending, prepared.reservation.reserved.total, 'workspace work is not charged to the task');
});

test('task scope without a configured limit is admitted, estimated and still task-tagged', t => {
  const { budget, accounting } = memoryFixture(t);
  const prepared = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload(),
    scope: 'task',
    taskId: 'task-plain'
  });
  assert.equal(prepared.attempt.taskId, 'task-plain');
  assert.equal(prepared.attempt.outputTokens, 2048);
  assert.equal(prepared.attempt.outputBound, 'estimated');
  assert.equal(Object.hasOwn(prepared.payload, 'max_tokens'), false);
  assert.equal(prepared.reservation.taskId, 'task-plain');
  assert.equal(budget.describe({ taskId: 'task-plain' }).task.pending, prepared.reservation.reserved.total);

  const permit = accounting.markDispatched(prepared.attempt);
  assert.equal(permit.scope, 'task');
  assert.equal(permit.taskId, 'task-plain');
});

test('without a configured limit payload compatibility is preserved and a legal cap is still held', t => {
  const { budget, accounting } = memoryFixture(t);
  const payload = messagesPayload({ max_tokens: 4096 });
  const prepared = accounting.prepare({ protocol: 'messages', payload, scope: 'workspace' });
  assert.deepEqual(prepared.payload, payload);
  assert.equal(prepared.attempt.outputTokens, 4096, 'an explicit legal cap is reserved without a forced clamp');
  assert.equal(prepared.attempt.outputBound, 'enforced');
  assert.equal(prepared.reservation.reserved.output, 4096);
  assert.equal(prepared.reservation.reserved.input, byteLength(payload));

  accounting.markDispatched(prepared.attempt);
  const result = accounting.settleResponse(prepared.attempt, {
    protocol: 'messages',
    body: { usage: { input_tokens: 700, output_tokens: 80 } }
  });
  assert.equal(result.state, 'settled');
  assert.equal(budget.describe().workspace.settled, 780);
});

test('a zero workspace or task limit fails closed before any reservation', t => {
  const first = memoryFixture(t);
  first.budget.setLimit({ scope: 'workspace', tokens: 0 });
  assert.throws(
    () => first.accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' }),
    { code: 'TOKEN_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.equal(first.budget.describe().workspace.used, 0);
  assert.equal(first.budget.describe().workspace.attempts.pending, 0);

  const second = memoryFixture(t);
  second.budget.setLimit({ scope: 'workspace', tokens: null });
  second.budget.setLimit({ scope: 'task', taskId: 'task-zero', tokens: 0 });
  const error = rejected(
    () => second.accounting.prepare({
      protocol: 'messages',
      payload: messagesPayload(),
      scope: 'task',
      taskId: 'task-zero'
    }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );
  assert.deepEqual(error.detail.blockedScopes, ['task']);
  assert.equal(second.budget.describe({ taskId: 'task-zero' }).task.used, 0);
});

test('without a limit an existing malformed cap is left untouched and only estimated', t => {
  const { accounting } = memoryFixture(t);
  const payload = messagesPayload({ max_tokens: '100' });
  const prepared = accounting.prepare({ protocol: 'messages', payload, scope: 'workspace' });
  assert.deepEqual(prepared.payload, payload);
  assert.equal(prepared.attempt.outputTokens, 2048);
  assert.equal(prepared.attempt.outputBound, 'estimated');
});

for (const [label, cap] of [
  ['zero', 0],
  ['negative', -1],
  ['float', 1.5],
  ['string', '100'],
  ['null', null],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1]
]) {
  test(`an invalid ${label} output cap fails closed when a budget is enabled`, t => {
    const { budget, accounting } = memoryFixture(t);
    budget.setLimit({ scope: 'workspace', tokens: 100000 });
    assert.throws(
      () => accounting.prepare({ protocol: 'messages', payload: messagesPayload({ max_tokens: cap }), scope: 'workspace' }),
      { code: 'INVALID_TOKEN_ACCOUNTING', status: 400 }
    );
    assert.equal(budget.describe().workspace.used, 0);
    assert.equal(budget.describe().workspace.attempts.pending, 0);
  });
}

test('a chat payload with both output cap fields fails closed when a budget is enabled', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  assert.throws(
    () => accounting.prepare({
      protocol: 'chat-completions',
      payload: chatPayload({ max_tokens: 512, max_completion_tokens: 512 }),
      scope: 'workspace'
    }),
    { code: 'INVALID_TOKEN_ACCOUNTING', status: 400 }
  );
  assert.equal(budget.describe().workspace.used, 0);
});

test('scope must be explicit and consistent with taskId before any hold exists', t => {
  const { budget, accounting } = memoryFixture(t);
  const cases = [
    ['missing scope', { protocol: 'chat-completions', payload: chatPayload() }],
    ['unknown scope', { protocol: 'chat-completions', payload: chatPayload(), scope: 'global' }],
    ['task without a taskId', { protocol: 'chat-completions', payload: chatPayload(), scope: 'task' }],
    ['workspace with a taskId', { protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace', taskId: 'task-1' }]
  ];
  for (const [label, options] of cases) {
    const error = rejected(() => accounting.prepare(options), { code: 'INVALID_TOKEN_ACCOUNTING', status: 400 });
    assert.ok(!error.message.includes('请总结'), label);
  }
  assert.equal(budget.describe().workspace.used, 0);
  assert.equal(budget.describe().workspace.attempts.pending, 0);
});

test('an exhausted task A never blocks workspace discovery work or task B', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 0 });
  budget.setLimit({ scope: 'task', taskId: 'task-b', tokens: 100000 });

  const discovery = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(discovery.attempt.taskId, null);
  assert.equal(discovery.payload.max_tokens, 2048, 'the workspace limit still caps the request');
  assert.equal(discovery.attempt.outputBound, 'enforced');

  const taskB = accounting.prepare({
    protocol: 'messages',
    payload: messagesPayload(),
    scope: 'task',
    taskId: 'task-b'
  });
  assert.equal(taskB.attempt.taskId, 'task-b');
  assert.equal(taskB.payload.max_tokens, 2048);

  assert.throws(
    () => accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'task', taskId: 'task-a' }),
    { code: 'TOKEN_BUDGET_EXHAUSTED', status: 429 }
  );
  assert.equal(budget.describe({ taskId: 'task-a' }).task.used, 0);
  assert.equal(budget.describe({ taskId: 'task-b' }).task.pending, taskB.reservation.reserved.total);
});

test('the returned payload and reservation snapshot are deep-frozen while the caller object stays mutable', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  const payload = chatPayload();
  const callerSnapshot = structuredClone(payload);
  const prepared = accounting.prepare({ protocol: 'chat-completions', payload, scope: 'workspace' });

  assert.ok(Object.isFrozen(prepared.payload));
  assert.ok(Object.isFrozen(prepared.payload.messages));
  assert.ok(Object.isFrozen(prepared.payload.messages[0]));
  assert.ok(Object.isFrozen(prepared.payload.tools));
  assert.ok(Object.isFrozen(prepared.payload.tools[0].function));
  assert.ok(Object.isFrozen(prepared.payload.tools[0].function.parameters.properties.query));

  assert.throws(() => { prepared.payload.max_tokens = 8192; }, TypeError);
  assert.throws(() => { prepared.payload.messages.push({ role: 'user', content: 'later' }); }, TypeError);
  assert.throws(() => { prepared.payload.tools[0].function.parameters.properties.query.type = 'number'; }, TypeError);

  assert.equal(prepared.payload.max_tokens, 2048);
  assert.equal(prepared.payload.messages.length, callerSnapshot.messages.length);
  assert.equal(prepared.payload.tools[0].function.parameters.properties.query.type, 'string');
  assert.equal(byteLength(prepared.payload), prepared.attempt.inputTokens,
    'the JSON that would be sent matches the reserved input estimate');
  assert.equal(prepared.reservation.reserved.input, byteLength(prepared.payload));

  assert.ok(Object.isFrozen(prepared.reservation));
  assert.ok(Object.isFrozen(prepared.reservation.reserved));
  assert.throws(() => { prepared.reservation.reserved.input = 0; }, TypeError);
  assert.throws(() => { prepared.reservation.reserved.total = 1; }, TypeError);
  assert.equal(budget.describe().workspace.pending, prepared.reservation.reserved.total,
    'mutating the returned snapshot cannot change the ledger');

  assert.equal(Object.isFrozen(payload), false, 'the caller object is not frozen by the adapter');
  payload.messages.push({ role: 'user', content: 'later' });
  payload.max_tokens = 8192;
  assert.equal(payload.messages.length, callerSnapshot.messages.length + 1);
  assert.equal(prepared.payload.messages.length, callerSnapshot.messages.length);
  assert.equal(prepared.payload.max_tokens, 2048);
  assert.equal(byteLength(prepared.payload), prepared.reservation.reserved.input);
});

test('malformed protocols and payloads fail without leaving holds or echoing content', t => {
  const { budget, accounting } = memoryFixture(t);
  const secret = 'sk-test-not-a-real-key';
  const circular = { model: 'm', messages: [{ role: 'user', content: secret }], max_tokens: secret };
  circular.self = circular;
  const cases = [
    ['unknown protocol', () => accounting.prepare({ protocol: 'grpc', payload: chatPayload(), scope: 'workspace' })],
    ['null payload', () => accounting.prepare({ protocol: 'chat-completions', payload: null, scope: 'workspace' })],
    ['array payload', () => accounting.prepare({ protocol: 'chat-completions', payload: [], scope: 'workspace' })],
    ['circular payload', () => accounting.prepare({ protocol: 'chat-completions', payload: circular, scope: 'workspace' })],
    ['bigint payload', () => accounting.prepare({ protocol: 'chat-completions', payload: { ...chatPayload(), n: 1n }, scope: 'workspace' })],
    ['missing model', () => accounting.prepare({ protocol: 'chat-completions', payload: { messages: [{ role: 'user', content: 'x' }] }, scope: 'workspace' })],
    ['missing messages', () => accounting.prepare({ protocol: 'chat-completions', payload: { model: 'm' }, scope: 'workspace' })],
    ['empty messages', () => accounting.prepare({ protocol: 'messages', payload: { model: 'm', messages: [] }, scope: 'workspace' })],
    ['missing responses input', () => accounting.prepare({ protocol: 'responses', payload: { model: 'm' }, scope: 'workspace' })],
    ['empty responses input', () => accounting.prepare({ protocol: 'responses', payload: { model: 'm', input: [] }, scope: 'workspace' })],
    ['non-string model', () => accounting.prepare({ protocol: 'chat-completions', payload: { model: 42, messages: [{ role: 'user', content: 'x' }] }, scope: 'workspace' })]
  ];
  for (const [label, run] of cases) {
    const error = rejected(run, { code: 'INVALID_TOKEN_ACCOUNTING', status: 400 });
    assert.ok(!error.message.includes(secret), label);
    assert.ok(!JSON.stringify(error.detail ?? {}).includes(secret), label);
  }
  assert.equal(budget.describe().workspace.used, 0);
  assert.equal(budget.describe().workspace.attempts.pending, 0);
});

test('attempt tokens are identity-bound and clones or lookalikes are rejected', t => {
  const { budget, accounting } = memoryFixture(t);
  const secret = 'sk-test-not-a-real-key';
  const { attempt } = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload({ messages: [{ role: 'user', content: secret }] }),
    scope: 'workspace'
  });
  assert.deepEqual(Object.keys(attempt).sort(),
    ['attemptId', 'inputTokens', 'outputBound', 'outputTokens', 'protocol', 'scope', 'taskId']);
  assert.ok(Object.isFrozen(attempt));
  assert.equal(attempt.state, undefined, 'attempt metadata contains no extra state');
  assert.ok(!JSON.stringify(attempt).includes(secret), 'attempt metadata contains no payload text');

  const lookalikes = [
    { ...attempt },
    structuredClone(attempt),
    Object.assign(Object.create(null), attempt),
    attempt.attemptId,
    null,
    undefined,
    () => attempt
  ];
  for (const candidate of lookalikes) {
    assert.throws(() => accounting.markDispatched(candidate), { code: 'INVALID_TOKEN_ACCOUNTING' });
    assert.throws(() => accounting.settleResponse(candidate, { protocol: 'chat-completions', body: {} }), { code: 'INVALID_TOKEN_ACCOUNTING' });
    assert.throws(() => accounting.fail(candidate), { code: 'INVALID_TOKEN_ACCOUNTING' });
  }

  const other = new TokenRequestAccounting(budget);
  assert.throws(() => other.markDispatched(attempt), { code: 'INVALID_TOKEN_ACCOUNTING' });
  assert.equal(budget.describe().pendingReservations[0].state, 'reserved');
  assert.throws(() => { attempt.inputTokens = 0; }, TypeError);
  assert.equal(accounting.markDispatched(attempt).state, 'dispatched');
});

test('one attempt yields one dispatch permit even though the core marker is idempotent', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt } = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  const permit = accounting.markDispatched(attempt);
  assert.equal(permit.attemptId, attempt.attemptId);
  assert.equal(permit.protocol, 'chat-completions');
  assert.equal(permit.scope, 'workspace');
  assert.equal(permit.outputBound, 'estimated');
  assert.equal(permit.day, '2026-11-12');
  assert.equal(permit.state, 'dispatched');
  assert.ok(permit.dispatchedAt);
  assert.deepEqual(permit.reserved, {
    input: attempt.inputTokens,
    output: attempt.outputTokens,
    total: attempt.inputTokens + attempt.outputTokens
  });
  assert.ok(Object.isFrozen(permit));
  assert.ok(Object.isFrozen(permit.reserved));

  assert.throws(() => accounting.markDispatched(attempt), { code: 'TOKEN_ACCOUNTING_CONFLICT', status: 409 });
  assert.equal(budget.describe().pendingReservations[0].state, 'dispatched');
  assert.equal(budget.describe().workspace.attempts.pending, 1);
});

test('a limit change between prepare and dispatch rejects the old permit and keeps the hold', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  const prepared = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(prepared.attempt.outputBound, 'enforced');

  budget.setLimit({ scope: 'workspace', tokens: 90000 });
  const error = rejected(() => accounting.markDispatched(prepared.attempt), {
    code: 'TOKEN_ACCOUNTING_STALE',
    status: 503
  });
  assert.match(error.message, /fail\(\)/, 'the caller is told to cancel and reprepare');
  assert.match(error.message, /prepare a new attempt/);
  assert.equal(budget.describe().pendingReservations[0].state, 'reserved', 'the un-dispatched hold is retained');

  const cancelled = accounting.fail(prepared.attempt);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(budget.describe().workspace.used, 0);

  const reprepared = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(accounting.markDispatched(reprepared.attempt).state, 'dispatched');
});

test('enabling or disabling a limit invalidates a stale uncapped or capped permit', t => {
  const { budget, accounting } = memoryFixture(t);

  const uncapped = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(uncapped.attempt.outputBound, 'estimated');
  assert.equal(Object.hasOwn(uncapped.payload, 'max_tokens'), false);

  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  assert.throws(() => accounting.markDispatched(uncapped.attempt), { code: 'TOKEN_ACCOUNTING_STALE' });
  accounting.fail(uncapped.attempt);

  const capped = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(capped.payload.max_tokens, 2048);
  budget.setLimit({ scope: 'workspace', tokens: null });
  assert.throws(() => accounting.markDispatched(capped.attempt), { code: 'TOKEN_ACCOUNTING_STALE' });
  accounting.fail(capped.attempt);

  const fresh = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  assert.equal(Object.hasOwn(fresh.payload, 'max_tokens'), false);
  assert.equal(fresh.attempt.outputBound, 'estimated');
  assert.equal(accounting.markDispatched(fresh.attempt).state, 'dispatched');
});

test('a task limit change does not invalidate a workspace or another task attempt', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  budget.setLimit({ scope: 'task', taskId: 'task-b', tokens: 100000 });

  const workspaceAttempt = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  const taskBAttempt = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload(),
    scope: 'task',
    taskId: 'task-b'
  });

  budget.setLimit({ scope: 'task', taskId: 'task-a', tokens: 0 });
  assert.equal(accounting.markDispatched(workspaceAttempt.attempt).state, 'dispatched');
  assert.equal(accounting.markDispatched(taskBAttempt.attempt).state, 'dispatched');

  const taskBSecond = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload(),
    scope: 'task',
    taskId: 'task-b'
  });
  budget.setLimit({ scope: 'task', taskId: 'task-b', tokens: 50000 });
  assert.throws(() => accounting.markDispatched(taskBSecond.attempt), { code: 'TOKEN_ACCOUNTING_STALE' });
});

test('a limit change after dispatch cannot retract or alter the dispatched request', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  const prepared = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  accounting.markDispatched(prepared.attempt);

  budget.setLimit({ scope: 'workspace', tokens: 0 });
  const result = accounting.settleResponse(prepared.attempt, {
    protocol: 'chat-completions',
    body: { usage: { prompt_tokens: 10, completion_tokens: 2 } }
  });
  assert.equal(result.state, 'settled');
  assert.equal(budget.describe().workspace.settled, 12);
});

test('a ledger row changed outside the adapter cannot become a fresh dispatch permit', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });

  const dispatched = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  budget.markDispatched(dispatched.attempt.attemptId);
  const error = rejected(() => accounting.markDispatched(dispatched.attempt), {
    code: 'TOKEN_ACCOUNTING_CONFLICT',
    status: 409
  });
  assert.match(error.message, /dispatched/);
  assert.equal(budget.describe().pendingReservations[0].state, 'dispatched');

  const settled = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  budget.settle(settled.attempt.attemptId, { input: 5, output: 5 });
  assert.throws(() => accounting.markDispatched(settled.attempt), { code: 'TOKEN_ACCOUNTING_CONFLICT' });

  const unknown = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  budget.markUnknown(unknown.attempt.attemptId);
  assert.throws(() => accounting.markDispatched(unknown.attempt), { code: 'TOKEN_ACCOUNTING_CONFLICT' });

  const cancelled = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  budget.cancelBeforeDispatch(cancelled.attempt.attemptId);
  assert.throws(() => accounting.markDispatched(cancelled.attempt), { code: 'TOKEN_ACCOUNTING_CONFLICT' });
});

test('settleResponse requires a dispatched attempt and the matching protocol', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt, reservation } = accounting.prepare({
    protocol: 'chat-completions',
    payload: chatPayload(),
    scope: 'workspace'
  });
  assert.throws(
    () => accounting.settleResponse(attempt, { protocol: 'grpc', body: {} }),
    { code: 'INVALID_TOKEN_ACCOUNTING' }
  );
  assert.throws(
    () => accounting.settleResponse(attempt, { protocol: 'chat-completions', body: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }),
    { code: 'TOKEN_ACCOUNTING_CONFLICT' }
  );
  assert.equal(budget.describe().workspace.pending, reservation.reserved.total);

  accounting.markDispatched(attempt);
  assert.throws(
    () => accounting.settleResponse(attempt, { protocol: 'messages', body: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    { code: 'TOKEN_ACCOUNTING_CONFLICT' }
  );
  assert.equal(budget.describe().pendingReservations[0].state, 'dispatched');

  const result = accounting.settleResponse(attempt, {
    protocol: 'chat-completions',
    body: { usage: { prompt_tokens: 10, completion_tokens: 2 } }
  });
  assert.equal(result.state, 'settled');
});

for (const [protocol, usage, expected] of [
  ['chat-completions',
    { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 400 } },
    { input: 600, output: 20, cacheRead: 400, cacheWrite: 0, total: 1020 }],
  ['responses',
    { input_tokens: 900, output_tokens: 30, input_tokens_details: { cached_tokens: 300 } },
    { input: 600, output: 30, cacheRead: 300, cacheWrite: 0, total: 930 }],
  ['messages',
    { input_tokens: 600, output_tokens: 20, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
    { input: 600, output: 20, cacheRead: 400, cacheWrite: 50, total: 1070 }]
]) {
  test(`${protocol} usage is normalized into mutually exclusive canonical components`, t => {
    const { budget, accounting } = memoryFixture(t);
    const { attempt } = preparedAndDispatched(accounting, { protocol, payload: payloadFor(protocol) });
    const result = accounting.settleResponse(attempt, { protocol, body: { usage } });
    assert.equal(result.state, 'settled');
    assert.deepEqual(result.actual, expected);
    assert.equal(result.consumed, expected.total);
    assert.equal(budget.describe().workspace.settled, expected.total);
  });
}

for (const [protocol, usage, expected] of [
  ['chat-completions',
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: null },
    { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 }],
  ['responses',
    { input_tokens: 10, output_tokens: 1, input_tokens_details: null },
    { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 }]
]) {
  test(`${protocol} null cache details settle as zero cache with complete input and output`, t => {
    const { budget, accounting } = memoryFixture(t);
    const { attempt } = preparedAndDispatched(accounting, { protocol, payload: payloadFor(protocol) });
    const result = accounting.settleResponse(attempt, { protocol, body: { usage } });
    assert.equal(result.state, 'settled');
    assert.deepEqual(result.actual, expected);
    assert.equal(budget.describe().workspace.settled, expected.total);
  });
}

test('messages cache reads stay separate and may exceed uncached input', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt } = preparedAndDispatched(accounting, { protocol: 'messages', payload: messagesPayload() });
  const result = accounting.settleResponse(attempt, {
    protocol: 'messages',
    body: { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 } }
  });
  assert.deepEqual(result.actual, { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, total: 1010 });
  assert.equal(budget.describe().workspace.settled, 1010);
});

test('chat usage with all input cached leaves zero uncached input', t => {
  const { accounting } = memoryFixture(t);
  const { attempt } = preparedAndDispatched(accounting, { protocol: 'chat-completions', payload: chatPayload() });
  const result = accounting.settleResponse(attempt, {
    protocol: 'chat-completions',
    body: { usage: { prompt_tokens: 250, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 250 } } }
  });
  assert.deepEqual(result.actual, { input: 0, output: 7, cacheRead: 250, cacheWrite: 0, total: 257 });
});

for (const [protocol, label, body] of [
  ['chat-completions', 'missing body', null],
  ['chat-completions', 'missing usage', {}],
  ['chat-completions', 'empty usage', { usage: {} }],
  ['chat-completions', 'missing completion tokens', { usage: { prompt_tokens: 10 } }],
  ['chat-completions', 'missing prompt tokens', { usage: { completion_tokens: 10 } }],
  ['chat-completions', 'string prompt tokens', { usage: { prompt_tokens: '10', completion_tokens: 1 } }],
  ['chat-completions', 'negative completion tokens', { usage: { prompt_tokens: 10, completion_tokens: -1 } }],
  ['chat-completions', 'float prompt tokens', { usage: { prompt_tokens: 1.5, completion_tokens: 1 } }],
  ['chat-completions', 'unsafe prompt tokens', { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1 } }],
  ['chat-completions', 'cache above input', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } } }],
  ['chat-completions', 'string cached tokens', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: '1' } } }],
  ['chat-completions', 'array token details', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: [] } }],
  ['chat-completions', 'scalar token details', { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: 0 } }],
  ['responses', 'array input details', { usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: [] } }],
  ['chat-completions', 'null usage', { usage: null }],
  ['responses', 'missing input tokens', { usage: { output_tokens: 10 } }],
  ['responses', 'cache above input', { usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 11 } } }],
  ['messages', 'missing input tokens', { usage: { output_tokens: 10 } }],
  ['messages', 'string output tokens', { usage: { input_tokens: 10, output_tokens: '1' } }],
  ['messages', 'negative cache read', { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: -1 } }],
  ['messages', 'null cache write', { usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: null } }]
]) {
  test(`${protocol} ${label} marks the hold unknown instead of trusting zero`, t => {
    const { budget, accounting } = memoryFixture(t);
    const { attempt, reservation } = preparedAndDispatched(accounting, { protocol, payload: payloadFor(protocol) });
    const result = accounting.settleResponse(attempt, { protocol, body });
    assert.equal(result.state, 'unknown');
    assert.equal(result.reserved.total, reservation.reserved.total);
    assert.equal(result.actual, undefined, 'an unknown hold reports no trusted actual usage');

    const view = budget.describe();
    assert.equal(view.workspace.settled, 0);
    assert.equal(view.workspace.pending, 0);
    assert.equal(view.workspace.unknown, reservation.reserved.total);
    assert.deepEqual(accounting.fail(attempt), result, 'the same unknown outcome is idempotent');
    assert.equal(budget.describe().workspace.unknown, reservation.reserved.total);
  });
}

for (const [protocol, usage] of [
  ['chat-completions', { prompt_tokens: 0, completion_tokens: 0 }],
  ['responses', { input_tokens: 0, output_tokens: 0 }],
  ['messages', { input_tokens: 0, output_tokens: 0 }]
]) {
  test(`${protocol} explicit complete zero usage settles as a trusted zero`, t => {
    const { budget, accounting } = memoryFixture(t);
    const { attempt } = preparedAndDispatched(accounting, { protocol, payload: payloadFor(protocol) });
    const result = accounting.settleResponse(attempt, { protocol, body: { usage } });
    assert.equal(result.state, 'settled');
    assert.deepEqual(result.actual, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.equal(result.consumed, 0);
    const view = budget.describe();
    assert.equal(view.workspace.settled, 0);
    assert.equal(view.workspace.unknown, 0);
    assert.equal(view.workspace.attempts.settled, 1);
  });
}

test('a malformed final model body does not lose usage that already arrived', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt } = preparedAndDispatched(accounting, { protocol: 'chat-completions', payload: chatPayload() });
  const result = accounting.settleResponse(attempt, {
    protocol: 'chat-completions',
    body: {
      choices: [{ message: { content: '{not valid json' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 }
    }
  });
  assert.equal(result.state, 'settled');
  assert.deepEqual(result.actual, { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, total: 15 });
  assert.equal(budget.describe().workspace.settled, 15);
});

test('identical settlements are idempotent while conflicting usage and late failures are rejected', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt } = preparedAndDispatched(accounting, { protocol: 'chat-completions', payload: chatPayload() });
  const body = { usage: { prompt_tokens: 10, completion_tokens: 4 } };
  const first = accounting.settleResponse(attempt, { protocol: 'chat-completions', body });
  const second = accounting.settleResponse(attempt, { protocol: 'chat-completions', body });
  assert.equal(second, first);
  assert.equal(budget.describe().workspace.settled, 14);

  assert.throws(
    () => accounting.settleResponse(attempt, { protocol: 'chat-completions', body: { usage: { prompt_tokens: 11, completion_tokens: 4 } } }),
    { code: 'TOKEN_ACCOUNTING_CONFLICT' }
  );
  assert.throws(
    () => accounting.settleResponse(attempt, { protocol: 'chat-completions', body: {} }),
    { code: 'TOKEN_ACCOUNTING_CONFLICT' }
  );
  assert.throws(() => accounting.fail(attempt), { code: 'TOKEN_ACCOUNTING_CONFLICT' });

  const view = budget.describe();
  assert.equal(view.workspace.settled, 14);
  assert.equal(view.workspace.unknown, 0);
  assert.equal(view.workspace.attempts.settled, 1);
});

test('real usage above the reservation is recorded truthfully as overrun', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt, reservation } = preparedAndDispatched(accounting, { protocol: 'chat-completions', payload: chatPayload() });
  const result = accounting.settleResponse(attempt, {
    protocol: 'chat-completions',
    body: { usage: { prompt_tokens: 5000, completion_tokens: 100 } }
  });
  assert.equal(result.state, 'settled');
  assert.deepEqual(result.actual, { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, total: 5100 });
  assert.deepEqual(result.overrun, { tokens: 5100 - reservation.reserved.total, exceeded: true });
  const view = budget.describe();
  assert.equal(view.workspace.used, 5100);
  assert.equal(view.workspace.pending, 0);
});

test('unrepresentable real usage is marked unknown and keeps the hold', t => {
  const { budget, accounting } = memoryFixture(t);
  const { attempt, reservation } = preparedAndDispatched(accounting, { protocol: 'chat-completions', payload: chatPayload() });
  const error = rejected(
    () => accounting.settleResponse(attempt, {
      protocol: 'chat-completions',
      body: { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 } }
    }),
    { code: 'TOKEN_BUDGET_OVERFLOW', status: 409 }
  );
  assert.equal(error.detail.requiresMarkUnknown, true);
  const view = budget.describe();
  assert.equal(view.workspace.unknown, reservation.reserved.total);
  assert.equal(view.workspace.pending, 0);
  assert.equal(view.workspace.used, reservation.reserved.total);
  assert.equal(accounting.fail(attempt).state, 'unknown');
});

test('a settlement that would overflow the day marks unknown and preserves the original error', t => {
  const { budget, accounting } = memoryFixture(t);
  const payload = chatPayload();
  const estimate = byteLength(payload);
  const hold = estimate + 2048;
  budget.reserve({ attemptId: 'base', inputTokens: Number.MAX_SAFE_INTEGER - hold, outputTokens: 0 });
  const { attempt, reservation } = accounting.prepare({ protocol: 'chat-completions', payload, scope: 'workspace' });
  assert.equal(reservation.reserved.total, hold);
  accounting.markDispatched(attempt);

  let original;
  try {
    accounting.settleResponse(attempt, {
      protocol: 'chat-completions',
      body: { usage: { prompt_tokens: estimate + 2049, completion_tokens: 0 } }
    });
    assert.fail('expected an overflow');
  } catch (error) {
    original = error;
    assert.equal(error.code, 'TOKEN_BUDGET_OVERFLOW');
    assert.equal(error.detail.requiresMarkUnknown, true);
    assert.equal(error.detail.attemptId, attempt.attemptId);
    assert.ok(!error.message.includes('请总结'));
    assert.ok(!JSON.stringify(error.detail).includes('请总结'));
  }

  const view = budget.describe();
  assert.equal(view.workspace.unknown, reservation.reserved.total);
  assert.equal(view.workspace.pending, Number.MAX_SAFE_INTEGER - hold);
  assert.equal(view.workspace.used, Number.MAX_SAFE_INTEGER);

  let repeated;
  try {
    accounting.settleResponse(attempt, {
      protocol: 'chat-completions',
      body: { usage: { prompt_tokens: estimate + 2049, completion_tokens: 0 } }
    });
  } catch (error) {
    repeated = error;
  }
  assert.equal(repeated, original, 'the original overflow error is preserved for observation');
  assert.equal(accounting.fail(attempt).state, 'unknown');
});

test('fail cancels only undispatched attempts and keeps holds after dispatch', t => {
  const { budget, accounting } = memoryFixture(t);
  const first = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  const cancelled = accounting.fail(first.attempt);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(budget.describe().workspace.used, 0);
  assert.deepEqual(accounting.fail(first.attempt), cancelled);
  assert.throws(() => accounting.markDispatched(first.attempt), { code: 'TOKEN_ACCOUNTING_CONFLICT' });
  assert.throws(
    () => accounting.settleResponse(first.attempt, {
      protocol: 'chat-completions',
      body: { usage: { prompt_tokens: 1, completion_tokens: 1 } }
    }),
    { code: 'TOKEN_ACCOUNTING_CONFLICT' }
  );

  const second = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  accounting.markDispatched(second.attempt);
  const unknown = accounting.fail(second.attempt);
  assert.equal(unknown.state, 'unknown');
  const view = budget.describe();
  assert.equal(view.workspace.pending, 0);
  assert.equal(view.workspace.unknown, second.reservation.reserved.total);
  assert.deepEqual(accounting.fail(second.attempt), unknown);
  assert.throws(
    () => accounting.settleResponse(second.attempt, {
      protocol: 'chat-completions',
      body: { usage: { prompt_tokens: 1, completion_tokens: 1 } }
    }),
    { code: 'TOKEN_ACCOUNTING_CONFLICT' }
  );
});

test('a reservation from an earlier UTC day cannot be dispatched and is not refunded automatically', t => {
  const { budget, accounting, clock } = memoryFixture(t, { now: Date.parse('2026-11-12T23:50:00.000Z') });
  const { attempt, reservation } = accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'workspace' });
  clock.value = Date.parse('2026-11-13T00:10:00.000Z');

  const error = rejected(() => accounting.markDispatched(attempt), {
    code: 'TOKEN_BUDGET_STALE_RESERVATION',
    status: 409
  });
  assert.deepEqual(error.detail, {
    attemptId: attempt.attemptId,
    reservedDay: '2026-11-12',
    currentDay: '2026-11-13'
  });
  const dayOne = budget.describe({ date: '2026-11-12' });
  assert.equal(dayOne.workspace.pending, reservation.reserved.total);
  assert.equal(dayOne.workspace.used, reservation.reserved.total);
  assert.equal(budget.describe({ date: '2026-11-13' }).workspace.used, 0);

  const cancelled = accounting.fail(attempt);
  assert.equal(cancelled.state, 'cancelled', 'an explicit failure may release a hold that was never dispatched');
  assert.equal(budget.describe({ date: '2026-11-12' }).workspace.used, 0);
});

test('core taskId validation errors pass through unchanged before any hold is created', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 100000 });
  for (const taskId of [42, '', '   ', 'x'.repeat(201)]) {
    const error = rejected(
      () => accounting.prepare({ protocol: 'chat-completions', payload: chatPayload(), scope: 'task', taskId }),
      { code: 'INVALID_TOKEN_BUDGET', status: 400 }
    );
    assert.ok(!error.message.includes('请总结'));
  }
  assert.equal(budget.describe().workspace.used, 0);
  assert.equal(budget.describe().workspace.attempts.pending, 0);
});

test('quota exhaustion errors do not echo payload text', t => {
  const { budget, accounting } = memoryFixture(t);
  budget.setLimit({ scope: 'workspace', tokens: 1 });
  const secret = 'sk-test-not-a-real-key';
  const error = rejected(
    () => accounting.prepare({
      protocol: 'chat-completions',
      payload: chatPayload({ messages: [{ role: 'user', content: secret }] }),
      scope: 'workspace'
    }),
    { code: 'TOKEN_BUDGET_EXHAUSTED' }
  );
  assert.ok(!error.message.includes(secret));
  assert.ok(!JSON.stringify(error.detail ?? {}).includes(secret));
});

test('the adapter requires a token budget service', () => {
  assert.throws(() => new TokenRequestAccounting(), TypeError);
  assert.throws(() => new TokenRequestAccounting({}), TypeError);
});

const DATABASE_URL = new URL('../src/durable/database.js', import.meta.url).href;
const TOKEN_BUDGET_URL = new URL('../src/durable/token-budget.js', import.meta.url).href;
const TOKEN_ACCOUNTING_URL = new URL('../src/token-accounting.js', import.meta.url).href;

function writeRaceWorker(directory) {
  const filename = path.join(directory, 'accounting-race-worker.mjs');
  fs.writeFileSync(filename, `
import fs from 'node:fs';
import { DurableDatabase } from ${JSON.stringify(DATABASE_URL)};
import { TokenBudgetService } from ${JSON.stringify(TOKEN_BUDGET_URL)};
import { TokenRequestAccounting } from ${JSON.stringify(TOKEN_ACCOUNTING_URL)};

const [databasePath, goPath, readyPath, now] = process.argv.slice(2);
const database = new DurableDatabase(databasePath, { now: () => Number(now) });
const accounting = new TokenRequestAccounting(new TokenBudgetService(database));
const payload = { model: 'race-model', messages: [{ role: 'user', content: '并发额度测试' }] };
fs.writeFileSync(readyPath, 'ready');
while (!fs.existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, 2));

// SQLITE_BUSY is retried a finite number of times. BUSY itself is never
// reported as a quota outcome; if retries are exhausted the worker says so and
// the test fails instead of accepting lock contention as quota enforcement.
const MAX_BUSY_RETRIES = 20;
let result;
for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt += 1) {
  try {
    const prepared = accounting.prepare({ protocol: 'chat-completions', payload, scope: 'workspace' });
    result = {
      ok: true,
      attemptId: prepared.attempt.attemptId,
      reserved: prepared.reservation.reserved,
      outputBound: prepared.attempt.outputBound
    };
    break;
  } catch (error) {
    const code = error.code ?? error.name;
    if (!/^SQLITE_BUSY/.test(code)) {
      result = { ok: false, code };
      break;
    }
    if (attempt === MAX_BUSY_RETRIES) {
      result = { ok: false, code: 'SQLITE_BUSY_RETRIES_EXHAUSTED' };
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
database.close();
process.stdout.write(JSON.stringify(result));
`);
  return filename;
}

function collectWorker(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`race worker exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
}

async function waitForFile(filename, timeoutMs = 10000) {
  const started = Date.now();
  while (!fs.existsSync(filename)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function runRace(directory, worker, databasePath, now) {
  const go = path.join(directory, 'go');
  const readyFirst = path.join(directory, 'ready-first');
  const readySecond = path.join(directory, 'ready-second');
  const first = spawn(process.execPath, [worker, databasePath, go, readyFirst, String(now)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const second = spawn(process.execPath, [worker, databasePath, go, readySecond, String(now)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = [collectWorker(first), collectWorker(second)];
  try {
    await Promise.all([waitForFile(readyFirst), waitForFile(readySecond)]);
    fs.writeFileSync(go, 'go');
    return await Promise.all(finished);
  } finally {
    first.kill();
    second.kill();
    await Promise.allSettled(finished);
    for (const filename of [go, readyFirst, readySecond]) fs.rmSync(filename, { force: true });
  }
}

test('two adapters racing for the last quota cannot both reserve', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-token-accounting-race-'));
  roots.push(directory);
  const filename = path.join(directory, 'race.db');
  const now = START;
  const setup = new DurableDatabase(filename, { now: () => now });
  new TokenBudgetService(setup).setLimit({ scope: 'workspace', tokens: 3000 });
  setup.close();

  const worker = writeRaceWorker(directory);
  const results = await runRace(directory, worker, filename, now);
  const winners = results.filter(result => result.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const loser = results.find(result => !result.ok);
  assert.equal(loser.code, 'TOKEN_BUDGET_EXHAUSTED',
    `the loser must be stopped by the quota, not by lock contention: ${JSON.stringify(loser)}`);
  assert.equal(winners[0].outputBound, 'enforced');
  assert.ok(winners[0].reserved.total * 2 > 3000,
    'the workspace limit is what binds: two reservations cannot both fit');
  assert.ok(winners[0].reserved.total <= 3000);

  const verify = new DurableDatabase(filename, { now: () => now });
  const described = new TokenBudgetService(verify).describe();
  verify.close();
  assert.equal(described.workspace.attempts.pending, 1);
  assert.equal(described.workspace.pending, winners[0].reserved.total);
  assert.ok(described.workspace.used <= 3000);
});
