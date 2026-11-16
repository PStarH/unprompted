import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { DurableReasoningSessions } from '../src/durable/reasoning-sessions.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { completeWithTools } from '../src/tool-loop.js';

function setup(t, { effect = 'write', managedOperation = false, error = null, malformedFirst = false } = {}) {
  const database = new DurableDatabase(':memory:');
  const sessions = new DurableReasoningSessions(database);
  t.after(() => database.close());
  const counts = { fetches: 0, effects: 0 };
  const tool = { name: 'synthetic_tool', effect, managedOperation,
    description: 'Synthetic local effect counter, no network.', parameters: { type: 'object', properties: {} },
    async execute() { counts.effects++; if (error) throw error; return { content: [{ type: 'text', text: '{"ok":true}' }] }; } };
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fake', timeoutMs: 1000,
    reasoningSessions: sessions, fetchImpl: async () => {
      counts.fetches++;
      const call = counts.fetches === 1 || effect === 'write' && error && counts.fetches === 2 || malformedFirst && counts.fetches === 2;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: call
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${counts.fetches}`, type: 'function',
          function: { name: tool.name, arguments: malformedFirst && counts.fetches === 1 ? '{invalid' : '{}' } }] }
        : { role: 'assistant', content: '{"done":true}' } }] }) };
    } });
  const run = () => completeWithTools({ reasoner, requestId: 'unknown-effects', system: 'Synthetic system', user: 'Synthetic user', tools: [tool],
    accountingContext: { scope: 'workspace', session: { logicalKey: 'unknown-effects',
      bindings: { authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1 },
      owner: { kind: 'workspace', ownerId: 'synthetic-owner', token: 'synthetic-token' }, isCurrent: () => true } } });
  return { database, sessions, counts, run };
}

for (const [label, error, managedOperation] of [
  ['explicit unknown write', Object.assign(new Error('effect occurred'), { code: 'ECONNRESET', writeOutcomeUnknown: true }), false],
  ['unmanaged generic error', new Error('effect might have occurred'), false],
  ['managed writer explicitly unknown', Object.assign(new Error('unknown despite managed label'), { ambiguous: true }), true]
]) {
  test(`${label} blocks before a second model turn or write and stays blocked on resume`, async t => {
    const context = setup(t, { error, managedOperation });
    await assert.rejects(context.run, { code: 'SESSION_RECONCILIATION_REQUIRED' });
    assert.deepEqual(context.counts, { effects: 1, fetches: 1 });
    assert.equal(context.sessions.read({ scope: 'workspace', logicalKey: 'unknown-effects' }).status, 'blocked');
    assert.equal(context.database.db.prepare('SELECT status FROM reasoning_session_operations').get().status, 'reconciliation_required');
    await assert.rejects(context.run, { code: 'SESSION_RECONCILIATION_REQUIRED' });
    assert.deepEqual(context.counts, { effects: 1, fetches: 1 });
  });
}

test('a read error may continue to a final without inventing a successful read', async t => {
  const context = setup(t, { effect: 'read', error: new Error('read failed') });
  assert.deepEqual(await context.run(), { done: true });
  assert.deepEqual(context.counts, { effects: 1, fetches: 2 });
  assert.equal(context.database.db.prepare('SELECT status FROM reasoning_session_operations').get().status, 'failed');
});

test('malformed arguments before execute can be corrected and perform one successful write', async t => {
  const context = setup(t, { malformedFirst: true });
  assert.deepEqual(await context.run(), { done: true });
  assert.deepEqual(context.counts, { effects: 1, fetches: 3 });
  assert.deepEqual(context.database.db.prepare('SELECT status FROM reasoning_session_operations ORDER BY turn').all().map(row => row.status), ['failed', 'completed']);
});

test('a successful unmanaged write remains usable', async t => {
  const context = setup(t);
  assert.deepEqual(await context.run(), { done: true });
  assert.deepEqual(context.counts, { effects: 1, fetches: 2 });
});
