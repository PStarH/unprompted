import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { SimulatedMailProvider } from '../src/providers.js';
import { DurableDatabase } from '../src/durable/database.js';

/**
 * A crash between approval persistence and dispatch must not be reported as an
 * unknown external outcome. `execute()` persists `lookup` before it can reach a
 * provider and every adapter commits an intent before dispatch, so an action
 * still at `approved` provably never left the process.
 */
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-not-dispatched-'));
  const store = new SqliteStore(path.join(directory, 'state.json'), { database: new DurableDatabase(':memory:') });
  const provider = new SimulatedMailProvider(store), engine = new WorkEngine(store, { provider });
  const runtime = new DurableRuntime(engine, { tickMs: 100000 });
  t.after(async () => { await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, runtime };
}
async function approved(c) {
  c.engine.ingest({ id: 'mail-event', type: 'email.received', payload: { id: 'm1', from: 'alex@example.test', subject: 'Cedar proposal', body: 'Please update the Cedar project proposal with the latest experiment results and send it by Friday.' } });
  c.engine.ingest({ id: 'doc-event', type: 'document.modified', payload: { id: 'cedar', title: 'Cedar project proposal', kind: 'proposal', content: 'Cedar proposal\nExperiment results\nRun date: 2026-10-16\nSample size: 1,200\nControl: 8.1% conversion\nTreatment: 10.4% conversion\nConclusion: Treatment improved conversion.' } });
  await c.engine.whenSettled();
  return c.engine.publicState().tasks.find(task => task.id === 'request:m1');
}

test('an approved action interrupted before any provider call is confirmed absent', async t => {
  const c = setup(t), task = await approved(c);
  assert.equal(task.status, 'ready_for_approval');
  // Simulate the persisted state left by a crash immediately after `approve()`
  // wrote the action and before `execute()` reached its lookup phase.
  const key = `send:${task.id}:${task.draft.documentVersion}:i${task.inputVersion}`;
  c.store.mutate(state => {
    state.tasks[task.id].status = 'verifying';
    state.tasks[task.id].action = { id: key, idempotencyKey: key, status: 'executing', phase: 'approved', permission: 'user_approved', actionClass: 'execute_external', providerKind: 'simulated', live: false, receiptId: null };
  });
  c.runtime.importUncertainActions();
  const after = c.store.state.tasks[task.id];
  assert.equal(after.action.status, 'confirmed_absent');
  assert.equal(after.action.phase, 'not_dispatched');
  assert.equal(after.status, 'blocked');
  assert.match(after.reason, /Nothing was sent by this attempt/);
  // No ledger row and no resource claim were manufactured for it.
  assert.equal(c.store.database.db.prepare('SELECT COUNT(*) n FROM tool_executions').get().n, 0);
  assert.equal(c.store.database.db.prepare('SELECT COUNT(*) n FROM resource_claims').get().n, 0);
});

test('an action already past approval still imports as unknown with a claim', async t => {
  const c = setup(t), task = await approved(c);
  const key = `send:${task.id}:${task.draft.documentVersion}:i${task.inputVersion}`;
  c.store.mutate(state => {
    state.tasks[task.id].status = 'verifying';
    state.tasks[task.id].action = { id: key, idempotencyKey: key, status: 'executing', phase: 'sending', permission: 'user_approved', actionClass: 'execute_external', providerKind: 'simulated', live: false, receiptId: null };
  });
  c.runtime.importUncertainActions();
  const execution = c.store.database.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key=?').get(key);
  assert.ok(execution, 'a possibly-sent action becomes an unknown execution');
  assert.equal(execution.status, 'unknown');
  assert.equal(execution.last_error_class, 'legacy_interrupted');
  assert.equal(c.store.database.db.prepare('SELECT claim_state FROM resource_claims').get().claim_state, 'unresolved');
  assert.equal(c.store.state.tasks[task.id].status, 'verifying', 'the uncertain path owns the task state');
});
