import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableReasoningSessions } from '../src/durable/reasoning-sessions.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { ModelCommits } from '../src/durable/model-commits.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { completeWithTools } from '../src/tool-loop.js';

const input = { subject: 'Lobby report', body: 'Please update the Lobby report. PRIVATE-COMMIT-BODY' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-commits-'));
  const store = new SqliteStore(path.join(dir, 'state.json'));
  let clock = Date.now(); store.database.now = () => clock;
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sessions = new DurableReasoningSessions(store.database);
  const budget = new TokenBudgetService(store.database);
  const commits = new ModelCommits(store, sessions);
  const made = store.tasks.createOrLoad({ candidateKey: 'model-commit', data: {
    subject: 'Lobby report', request: { text: 'Please update the Lobby report.', subjectEntity: 'Lobby', deliverable: 'report' }
  } });
  const facts = { store, sessions, budget, commits, taskId: made.taskId, fetches: 0, invocations: 0 };
  facts.job = store.jobs.claim('first'); facts.run = store.tasks.beginRun(facts.job);
  store.tasks.checkpoint(facts.run, facts.job, { expectedInputVersion: 0, plan: {} }); store.refresh();
  facts.reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'fake', timeoutMs: 1000,
    tokenBudget: budget, reasoningSessions: sessions, fetchImpl: async (_url, init) => {
      facts.fetches++; facts.lastWire = init.body;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(facts.reply || { deliverable: 'report', subjectEntity: 'Lobby', requiredContent: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }) };
    } });
  facts.context = (key = 'interpret:stable-request') => {
    const job = facts.job, run = facts.run, task = store.tasks.get(facts.taskId);
    return commits.context({ scope: 'task', taskId: facts.taskId, key, stage: 'interpret',
      owner: { kind: 'job', job }, bindings: { authorityVersion: 1, privacyEpoch: task.privacyEpoch,
        inputVersion: task.inputVersion, contextVersion: 0, catalogVersion: 1 }, isCurrent: () => {
        try { store.tasks.preResume(run, job); return true; } catch { return false; }
      } });
  };
  facts.call = context => facts.reasoner.interpretRequest(input, `invocation-${facts.job.lease_token}-${++facts.invocations}`, context);
  facts.restartOwner = () => {
    clock += 30001; store.jobs.expire(); store.jobs.recover(facts.job.id, () => ({ state: 'queued', safeToRepeat: true }));
    facts.job = store.jobs.claim('replacement', { id: facts.job.id }); facts.run = store.tasks.beginRun(facts.job);
    store.tasks.checkpoint(facts.run, facts.job, { expectedInputVersion: store.tasks.get(facts.taskId).inputVersion, plan: {} });
    store.refresh();
  };
  facts.row = () => store.database.db.prepare('SELECT * FROM reasoning_sessions').get();
  return facts;
}


test('native SQL projection advances task input atomically with private ACK and erasure', async t => {
  const f = fixture(t), context = f.context(); await f.call(context);
  const result = f.commits.commitSql(context, () => {
    const task = f.store.tasks.get(f.taskId);
    f.store.tasks.update(f.taskId, task.stateVersion, data => { data.request.text = 'Accepted native SQL request.'; });
    return { accepted: true };
  });
  assert.deepEqual(result, { committed: true, value: { accepted: true } });
  assert.equal(f.store.tasks.get(f.taskId).request.text, 'Accepted native SQL request.'); assert.equal(f.row().status, 'completed');
  assert.equal(f.row().conversation_json, null); assert.equal(f.row().final_json, null);
  assert.throws(() => f.commits.commitSql(context, () => {}), { code: 'INVALID_SESSION_COMMIT' });
});

test('SQL failure rolls back projection and ACK; a replacement invocation consumes cached final without another RPC', async t => {
  const f = fixture(t), first = f.context(); await f.call(first);
  assert.throws(() => f.commits.commitSql(first, () => { f.store.database.set('native-sql-result', 'uncommitted'); throw new Error('Injected SQL projection failure'); }), /Injected SQL projection failure/);
  assert.equal(f.store.database.get('native-sql-result', null), null); assert.equal(f.row().status, 'awaiting_commit');
  const next = f.context(); await f.call(next); assert.equal(f.fetches, 1);
  f.commits.commitSql(next, () => f.store.database.set('native-sql-result', 'accepted'));
  assert.equal(f.row().status, 'completed'); assert.equal(f.store.database.get('native-sql-result'), 'accepted');
});

test('a declined SQL commit keeps the final and captured capability for a later native commit', async t => {
  const f = fixture(t), context = f.context(); await f.call(context); let mutations = 0;
  assert.deepEqual(f.commits.commitSql(context, () => { mutations++; }, { canCommit: () => false }), { committed: false });
  assert.equal(mutations, 0); assert.equal(f.row().status, 'awaiting_commit'); assert.ok(f.row().final_json);
  assert.deepEqual(f.commits.commitSql(context, () => { mutations++; return 'committed'; }, { canCommit: () => true }), { committed: true, value: 'committed' });
  assert.equal(mutations, 1); assert.equal(f.fetches, 1); assert.equal(f.row().status, 'completed');
});

for (const phase of ['predicate', 'mutation']) test(`async SQL ${phase} rolls back native writes without consuming the private final`, async t => {
  const f = fixture(t), context = f.context(); await f.call(context);
  const asynchronous = async () => { f.store.database.set('native-async-marker', 'uncommitted'); return true; };
  assert.throws(() => f.commits.commitSql(context, phase === 'mutation' ? asynchronous : () => {}, phase === 'predicate' ? { canCommit: asynchronous } : {}), /synchronous/);
  assert.equal(f.store.database.get('native-async-marker', null), null); assert.equal(f.row().status, 'awaiting_commit'); assert.ok(f.row().final_json);
});

test('SQL commit rejects forged and stale lease contexts before invoking the projection', async t => {
  const f = fixture(t), old = f.context(); await f.call(old); let mutations = 0;
  assert.throws(() => f.commits.commitSql({ ...old }, () => { mutations++; }), { code: 'INVALID_SESSION_COMMIT' });
  f.restartOwner(); const fresh = f.context(); await f.call(fresh);
  assert.throws(() => f.commits.commitSql(old, () => { mutations++; }), { code: 'SESSION_NOT_CURRENT' });
  assert.equal(mutations, 0); assert.equal(f.row().status, 'awaiting_commit');
  f.commits.commitSql(fresh, () => { mutations++; }); assert.equal(mutations, 1); assert.equal(f.fetches, 1);
});


test('declining rolls back accidental guard writes and requires ownership of the outer transaction', async t => {
  const f = fixture(t), context = f.context(); await f.call(context); let mutations = 0;
  const decline = () => { f.store.database.set('decline-marker', 'must-rollback'); return false; };
  assert.deepEqual(f.commits.commitSql(context, () => { mutations++; }, { canCommit: decline }), { committed: false });
  assert.equal(f.store.database.get('decline-marker', null), null); assert.equal(f.row().status, 'awaiting_commit');
  f.store.database.atomic(() => {
    assert.throws(() => f.commits.commitSql(context, () => { mutations++; }, { canCommit: decline }), { code: 'INVALID_SESSION_COMMIT' });
  });
  assert.equal(mutations, 0); assert.equal(f.store.database.get('decline-marker', null), null);
  f.commits.commitSql(context, () => {}); assert.equal(f.row().status, 'completed');
});
