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

test('actual model output is acknowledged atomically with a semantic input change and private bodies are erased', async t => {
  const f = fixture(t), context = f.context();
  await f.call(context);
  const before = f.row(); assert.equal(before.status, 'awaiting_commit');
  assert.equal(JSON.stringify(context).includes(before.claim_id), false);
  assert.equal(f.lastWire.includes(before.claim_id), false);
  assert.equal(JSON.stringify(f.store.state).includes('PRIVATE-COMMIT-BODY'), false);
  f.commits.commit(context, state => { state.tasks[f.taskId].request.text = 'Accepted revised semantic request.'; });
  const after = f.row();
  assert.equal(after.status, 'completed');
  assert.equal(after.conversation_json, null); assert.equal(after.final_json, null);
  assert.equal(f.store.state.tasks[f.taskId].request.text, 'Accepted revised semantic request.');
  let repeated = 0;
  assert.throws(() => f.commits.commit(context, () => repeated++), { code: 'INVALID_SESSION_COMMIT' });
  assert.equal(repeated, 0);
});

test('semantic rollback retains cached final; a new invocation commits without another fetch and old handle is refused', async t => {
  const f = fixture(t), first = f.context(); await f.call(first);
  assert.throws(() => f.commits.commit(first, state => { state.rollbackMarker = true; throw new Error('rollback'); }), /rollback/);
  assert.equal(f.store.state.rollbackMarker, undefined);
  assert.equal(f.row().status, 'awaiting_commit'); assert.ok(f.row().final_json);
  const replacement = f.context(); await f.call(replacement);
  assert.equal(f.fetches, 1);
  assert.throws(() => f.commits.commit(first, state => { state.staleMarker = true; }), { code: 'SESSION_OWNER_LOST' });
  assert.equal(f.store.state.staleMarker, undefined);
  f.commits.commit(replacement, state => { state.acceptedMarker = true; });
  assert.equal(f.store.state.acceptedMarker, true);
});

test('zero budget defers without a final, then a new real job owner resumes the same session after budget increase', async t => {
  const f = fixture(t); f.budget.setLimit({ scope: 'workspace', tokens: 0 });
  const first = f.context();
  await assert.rejects(() => f.call(first), { code: 'TOKEN_BUDGET_EXHAUSTED' });
  const id = f.row().id;
  assert.equal(f.fetches, 0);
  assert.throws(() => f.commits.commit(first, () => {}), error => ['SESSION_NO_FINAL', 'SESSION_OWNER_LOST'].includes(error.code));
  f.restartOwner(); f.budget.setLimit({ scope: 'workspace', tokens: 1000000 });
  const resumed = f.context(); await f.call(resumed);
  assert.equal(f.row().id, id); assert.equal(f.fetches, 1);
  f.commits.commit(resumed, state => { state.resumedMarker = true; });
  assert.equal(f.row().status, 'completed');
});

test('semantic rejection clears only final and allows a bounded new model turn', async t => {
  const f = fixture(t), rejected = f.context(); await f.call(rejected);
  f.commits.reject(rejected, 'grounding_failed');
  assert.equal(f.row().rejections, 1); assert.equal(f.row().final_json, null);
  const retry = f.context(); await f.call(retry);
  assert.equal(f.fetches, 2);
  f.commits.commit(retry, state => { state.validatedMarker = true; });
  assert.equal(f.row().status, 'completed');
});

test('lookalikes, reused invocation contexts and stale owners cannot run semantic callbacks', async t => {
  const f = fixture(t), context = f.context(); await f.call(context);
  let mutations = 0;
  assert.throws(() => f.commits.commit({ ...context }, () => mutations++), { code: 'INVALID_SESSION_COMMIT' });
  await assert.rejects(() => f.call(context), { code: 'INVALID_SESSION' });
  f.restartOwner();
  assert.throws(() => f.commits.commit(context, () => mutations++), error => ['SESSION_NOT_CURRENT', 'SESSION_OWNER_LOST'].includes(error.code));
  assert.equal(mutations, 0); assert.equal(f.fetches, 1);
});

test('the bridge rejects non-durable stores and session services from another workspace', t => {
  const f = fixture(t);
  assert.throws(() => new ModelCommits({ mutate() {} }, f.sessions), { code: 'UNSUPPORTED_STORE' });
  assert.throws(() => new ModelCommits(f.store, { database: {} }), { code: 'INVALID_SESSION' });
});

test('a real SQL projection failure rolls back private ACK and the cached final remains reusable', async t => {
  const f = fixture(t), first = f.context(); await f.call(first);
  f.store.database.db.exec(`CREATE TRIGGER reject_semantic_projection BEFORE UPDATE ON tasks
    WHEN json_extract(NEW.data_json,'$.commitBreak')=1 BEGIN SELECT RAISE(ABORT,'synthetic sync failure'); END`);
  assert.throws(() => f.commits.commit(first, state => { state.tasks[f.taskId].commitBreak = true; }), /synthetic sync failure/);
  assert.equal(f.row().status, 'awaiting_commit'); assert.ok(f.row().final_json);
  assert.equal(f.store.state.tasks[f.taskId].commitBreak, undefined);
  f.store.database.db.exec('DROP TRIGGER reject_semantic_projection');
  const retry = f.context(); await f.call(retry);
  assert.equal(f.fetches, 1);
  f.commits.commit(retry, state => { state.recoveredSqlCommit = true; });
  assert.equal(f.row().status, 'completed');
});

test('a store facade without a real transaction cannot erase a private final', async t => {
  const f = fixture(t);
  const facade = { database: f.store.database, mutate: callback => callback(f.store.state) };
  const bridge = new ModelCommits(facade, f.sessions);
  const task = f.store.tasks.get(f.taskId);
  const context = bridge.context({ scope: 'task', taskId: f.taskId, key: 'facade-case', owner: { kind: 'job', job: f.job },
    bindings: { authorityVersion: 1, privacyEpoch: task.privacyEpoch, inputVersion: task.inputVersion, contextVersion: 0, catalogVersion: 1 },
    isCurrent: () => f.store.jobs.owns(f.job) });
  await f.call(context);
  assert.throws(() => bridge.commit(context, state => { state.facadeMarker = true; }), { code: 'INVALID_SESSION_COMMIT' });
  assert.equal(f.store.state.facadeMarker, undefined);
  assert.equal(f.row().status, 'awaiting_commit');
});

test('standalone and actual classic external-tool entry points capture the original commit handle', async t => {
  const f = fixture(t), first = f.context('standalone');
  const call = context => completeWithTools({ reasoner: f.reasoner, requestId: `standalone-${++f.invocations}`,
    system: 'Synthetic system', user: 'Synthetic user', tools: [], accounting: f.reasoner.accounting, accountingContext: context });
  await call(first);
  assert.throws(() => f.commits.commit(first, () => { throw new Error('retry semantic commit'); }), /retry semantic commit/);
  const cached = f.context('standalone'); await call(cached);
  assert.equal(f.fetches, 1);
  f.commits.commit(cached, state => { state.standaloneAccepted = true; });
  const external = f.context('external-tools'); f.reply = { nextStep: 'Inspect source evidence.' };
  const nextStep = await f.reasoner.investigateTask({ task: { id: f.taskId, request: { text: 'Inspect the report.' } }, directions: [],
    externalTools: [{ name: 'synthetic_read', effect: 'read', description: 'Synthetic', parameters: { type: 'object' },
      execute: async () => ({ content: [{ type: 'text', text: 'read' }] }) }] }, 'actual-external', external);
  assert.equal(nextStep, 'Inspect source evidence.');
  f.commits.commit(external, state => { state.externalAccepted = nextStep; });
  assert.equal(f.fetches, 2);
  assert.equal(f.store.state.standaloneAccepted, true);
});


test('native post-sync artifact hooks share projection/ACK rollback and cannot be asynchronous', async t => {
  const f = fixture(t), context = f.context(); await f.call(context);
  assert.throws(() => f.commits.commit(context, state => { state.tasks[f.taskId].reason = 'Accepted suggestion'; }, { afterSync: async () => {
    f.store.database.set('atomic-artifact-marker', 'uncommitted');
  } }), /commit hooks must be synchronous/);
  assert.equal(f.store.database.get('atomic-artifact-marker', null), null);
  assert.notEqual(f.store.tasks.get(f.taskId).reason, 'Accepted suggestion'); assert.equal(f.row().status, 'awaiting_commit');
  const replacement = f.context(); await f.call(replacement); assert.equal(f.fetches, 1);
  f.commits.commit(replacement, state => { state.tasks[f.taskId].reason = 'Accepted suggestion'; }, { afterSync: () => {
    assert.equal(f.store.db.inTransaction, true); assert.equal(f.store.tasks.get(f.taskId).reason, 'Accepted suggestion');
    f.store.database.set('atomic-artifact-marker', 'committed');
  } });
  assert.equal(f.row().status, 'completed'); assert.equal(f.store.database.get('atomic-artifact-marker'), 'committed');
});
