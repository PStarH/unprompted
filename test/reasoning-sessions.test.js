import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ForgetService } from '../src/durable/privacy.js';
import { DurableReasoningSessions, SESSION_LIMITS, operationContext, runWithOperation } from '../src/durable/reasoning-sessions.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';
import { authorizeForTests } from '../src/authority-credential.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { OpenAiCompatibleReasoner, createReasoner } from '../src/reasoning.js';
import { completeWithTools } from '../src/tool-loop.js';

const START = Date.parse('2026-11-13T09:00:00.000Z');
const bindings = (extra = {}) => ({ authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1, ...extra });
const workspaceOwner = (token = 'owner-token') => ({ kind: 'workspace', ownerId: 'workspace-owner', token });
const current = () => true;

function fixture(t, options = {}) {
  const clock = { value: START };
  const database = new DurableDatabase(':memory:', { now: () => clock.value });
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 });
  const tasks = new DurableTasks(database, jobs);
  const sessions = new DurableReasoningSessions(database, { now: () => clock.value, workspaceLeaseMs: 1000, ...options });
  const budget = new TokenBudgetService(database);
  const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: 200 });
  t.after(() => database.close());
  return { database, jobs, tasks, sessions, budget, ledger, clock, advance: ms => { clock.value += ms; } };
}

function createTask(context, key) {
  const created = context.tasks.createOrLoad({ candidateKey: key, data: { subject: key, request: { subjectEntity: 'project', deliverable: 'report' } } });
  const pending = context.jobs.list({ taskId: created.taskId }).find(job => job.state === 'queued');
  const job = context.jobs.claim('worker', { id: pending.id });
  const run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, job, run };
}

function runningTask(context, key = 'reasoning-task') { return createTask(context, key); }

const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const chat = content => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

test('session DDL is idempotent and safe status never exposes private bodies', t => {
  const { database, sessions } = fixture(t);
  const begun = sessions.begin({ logicalKey: 'k-safe', bindings: bindings(), owner: workspaceOwner(), isCurrent: current,
    conversation: { prompt: 'PRIVATE-PROMPT' }, pending: { text: 'PRIVATE-PENDING' }, sourceRefs: [{ kind: 'connector', id: 'google' }] });
  assert.equal(begun.status, 'active');
  assert.equal(begun.conversation.prompt, 'PRIVATE-PROMPT');
  const again = new DurableReasoningSessions(database);
  assert.equal(again.read({ scope: 'workspace', logicalKey: 'k-safe' }).id, begun.id, 'reopening keeps rows');
  assert.equal(again.read({ scope: 'workspace', logicalKey: 'missing' }), null);
  const safe = sessions.read({ id: begun.id });
  const serialized = JSON.stringify({ safe, description: sessions.describe() });
  assert.equal(serialized.includes('PRIVATE-PROMPT'), false);
  assert.equal(serialized.includes('PRIVATE-PENDING'), false);
  assert.deepEqual(Object.keys(safe).sort(), ['calls', 'createdAt', 'expiresAt', 'hasConversation', 'hasFinal', 'hasPending', 'id', 'logicalKey', 'scope', 'semanticStage', 'sourceRefs', 'status', 'taskId', 'turn', 'updatedAt', 'version']);
});

test('an unreleased draft unique key is rejected without deleting its data', t => {
  const database = new DurableDatabase(':memory:');
  t.after(() => database.close());
  database.db.exec(`CREATE TABLE reasoning_sessions (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT, logical_key TEXT NOT NULL, semantic_stage TEXT NOT NULL,
    fingerprint TEXT NOT NULL, bindings_json TEXT NOT NULL, status TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
    owner_token TEXT NOT NULL, owner_label TEXT, owner_until TEXT, conversation_json TEXT, pending_json TEXT, final_json TEXT,
    final_digest TEXT, deferred_json TEXT, last_error TEXT, rejections INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0, model TEXT, protocol TEXT, privacy_epoch INTEGER NOT NULL DEFAULT 0,
    source_refs_json TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(scope,logical_key))`);
  database.db.prepare("INSERT INTO reasoning_sessions VALUES('kept','workspace',NULL,'k','general','f','{}','active','workspace','o','t',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,NULL,NULL,0,'[]',1,'t','t','t')").run();
  assert.throws(() => new DurableReasoningSessions(database), error => error.code === 'INCOMPATIBLE_SESSION_SCHEMA');
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM reasoning_sessions WHERE id='kept'").get().n, 1, 'no data was deleted');
});

test('stable bindings are scoped to the real task identity and stale content is refused', t => {
  const context = fixture(t);
  const a = context.sessions.begin({ logicalKey: 'k-stable', bindings: bindings(), owner: workspaceOwner(), isCurrent: current, conversation: { turn: 1 } });
  context.sessions.defer({ id: a.id, owner: workspaceOwner(), claimId: a.claimId, isCurrent: current, code: 'test_release' });
  const resumed = context.sessions.begin({ logicalKey: 'k-stable', bindings: bindings(), owner: workspaceOwner(), isCurrent: current, conversation: { turn: 1 } });
  assert.equal(resumed.id, a.id);
  assert.equal(resumed.resumed, true);
  assert.throws(() => context.sessions.begin({ logicalKey: 'k-stable', bindings: bindings({ inputVersion: 1 }), owner: workspaceOwner(), isCurrent: current }),
    error => error.code === 'SESSION_STALE');
  assert.throws(() => context.sessions.begin({ logicalKey: 'k-stable', bindings: {}, owner: workspaceOwner(), isCurrent: current }),
    error => error.code === 'INVALID_SESSION');
  assert.throws(() => context.sessions.begin({ logicalKey: 'k-stable', bindings: bindings(), owner: workspaceOwner() }),
    error => error.code === 'INVALID_SESSION', 'a missing current callback is refused');
  assert.throws(() => context.sessions.begin({ logicalKey: 'k-stable', bindings: bindings(), owner: workspaceOwner(), isCurrent: () => false }),
    error => error.code === 'SESSION_NOT_CURRENT');
});

test('two tasks with the same logical key, prompt, stage and bindings never share a private session', t => {
  const context = fixture(t);
  const a = createTask(context, 'task-a');
  const b = createTask(context, 'task-b');
  const spec = { logicalKey: 'identical-key', semanticStage: 'planning', bindings: bindings(), isCurrent: current };
  const first = context.sessions.begin({ ...spec, scope: 'task', taskId: a.taskId, owner: { kind: 'job', job: a.job },
    conversation: { marker: 'PRIVATE-TASK-A' }, sourceRefs: [{ kind: 'task', id: a.taskId }] });
  const second = context.sessions.begin({ ...spec, scope: 'task', taskId: b.taskId, owner: { kind: 'job', job: b.job },
    conversation: { marker: 'PRIVATE-TASK-B' }, sourceRefs: [{ kind: 'task', id: b.taskId }] });
  assert.notEqual(first.id, second.id);
  assert.equal(first.taskId, a.taskId);
  assert.equal(second.taskId, b.taskId);
  assert.equal(second.conversation.marker, 'PRIVATE-TASK-B');
  assert.equal(JSON.stringify(context.sessions.read({ id: second.id })).includes('PRIVATE-TASK-A'), false);
  assert.deepEqual(context.sessions.read({ id: second.id }).sourceRefs, [{ kind: 'task', id: b.taskId }]);
  assert.throws(() => context.sessions.read({ scope: 'task', logicalKey: 'identical-key' }), error => error.code === 'INVALID_SESSION');
  assert.equal(context.sessions.read({ scope: 'task', taskId: b.taskId, logicalKey: 'identical-key' }).id, second.id);
  const cleared = context.sessions.purgeBy({ taskIds: [a.taskId] });
  assert.equal(cleared.cleared, 1);
  assert.equal(context.sessions.read({ id: first.id }).status, 'invalidated');
  assert.equal(context.sessions.read({ id: second.id }).status, 'active');
  assert.ok(context.database.db.prepare('SELECT conversation_json FROM reasoning_sessions WHERE id=?').get(second.id).conversation_json);
  assert.throws(() => context.sessions.begin({ ...spec, scope: 'task', taskId: a.taskId, owner: { kind: 'job', job: a.job } }),
    error => error.code === 'SESSION_INVALIDATED');
});

test('job owners are bound to the stored task, not to a caller field or a workspace claim', t => {
  const context = fixture(t);
  const a = createTask(context, 'owner-a');
  const b = createTask(context, 'owner-b');
  const base = { logicalKey: 'owner-binding', bindings: bindings(), isCurrent: current };
  assert.throws(() => context.sessions.begin({ ...base, scope: 'task', taskId: b.taskId, owner: { kind: 'workspace', ownerId: 'w', token: 't' } }),
    error => error.code === 'INVALID_SESSION_OWNER');
  assert.throws(() => context.sessions.begin({ ...base, scope: 'task', taskId: b.taskId, owner: { kind: 'job', job: a.job } }),
    error => error.code === 'SESSION_OWNER_LOST');
  assert.throws(() => context.sessions.begin({ ...base, scope: 'task', taskId: b.taskId, owner: { kind: 'job', job: { ...a.job, task_id: b.taskId } } }),
    error => error.code === 'SESSION_OWNER_LOST', 'a tampered caller field cannot override the stored job task');
  assert.throws(() => context.sessions.begin({ ...base, scope: 'workspace', owner: { kind: 'job', job: a.job } }),
    error => error.code === 'SESSION_OWNER_LOST', 'a task job cannot claim a workspace session');
  assert.throws(() => context.sessions.begin({ ...base, scope: 'task', taskId: a.taskId, owner: { kind: 'job', job: { ...a.job, lease_token: a.job.lease_token + 1 } } }),
    error => error.code === 'SESSION_OWNER_LOST', 'an old lease token is refused');
  assert.throws(() => context.sessions.begin({ ...base, scope: 'task', taskId: 'missing-task', owner: { kind: 'job', job: a.job } }),
    error => error.code === 'SESSION_OWNER_LOST');
});

test('an active claim excludes the same owner and every other invocation until it is released', t => {
  const { sessions, advance } = fixture(t);
  const first = sessions.begin({ logicalKey: 'k-lease', bindings: bindings(), owner: workspaceOwner('one'), isCurrent: current });
  assert.throws(() => sessions.begin({ logicalKey: 'k-lease', bindings: bindings(), owner: workspaceOwner('two'), isCurrent: current }),
    error => error.code === 'SESSION_BUSY');
  assert.throws(() => sessions.begin({ logicalKey: 'k-lease', bindings: bindings(), owner: workspaceOwner('one'), isCurrent: current }),
    error => error.code === 'SESSION_BUSY', 'the same live owner also gets one invocation');
  assert.throws(() => sessions.saveConversation({ id: first.id, owner: workspaceOwner('two'), conversation: { stolen: true }, isCurrent: current, claimId: first.claimId }),
    error => error.code === 'SESSION_OWNER_LOST');
  advance(1001);
  const second = sessions.begin({ logicalKey: 'k-lease', bindings: bindings(), owner: workspaceOwner('two'), isCurrent: current });
  assert.equal(second.id, first.id);
  assert.throws(() => sessions.saveConversation({ id: first.id, owner: workspaceOwner('one'), conversation: { late: true }, isCurrent: current, claimId: first.claimId }),
    error => error.code === 'SESSION_OWNER_LOST');
  assert.throws(() => sessions.saveConversation({ id: first.id, owner: workspaceOwner('two'), conversation: { late: true }, isCurrent: current, claimId: first.claimId }),
    error => error.code === 'SESSION_OWNER_LOST', 'the old claim nonce cannot write');
  sessions.saveConversation({ id: first.id, owner: workspaceOwner('two'), conversation: { late: true }, isCurrent: current, claimId: second.claimId });
});

test('a job lease fences every session write and a replacement lease resumes the same private session', t => {
  const { sessions, jobs, tasks, advance } = fixture(t);
  const currentTask = createTask({ jobs, tasks }, 'job-lease-task');
  const begun = sessions.begin({ logicalKey: 'k-job', scope: 'task', taskId: currentTask.taskId, bindings: bindings(),
    owner: { kind: 'job', job: currentTask.job }, isCurrent: current });
  advance(30001);
  jobs.expire();
  jobs.recover(currentTask.job.id, () => ({ state: 'queued', safeToRepeat: true }));
  const next = jobs.claim('replacement', { id: currentTask.job.id });
  assert.throws(() => sessions.saveConversation({ id: begun.id, owner: { kind: 'job', job: currentTask.job }, conversation: { late: true }, isCurrent: current, claimId: begun.claimId }),
    error => error.code === 'SESSION_OWNER_LOST');
  const resumed = sessions.begin({ logicalKey: 'k-job', scope: 'task', taskId: currentTask.taskId, bindings: bindings(),
    owner: { kind: 'job', job: next }, isCurrent: current });
  assert.equal(resumed.id, begun.id);
  assert.notEqual(resumed.claimId, begun.claimId);
  sessions.saveConversation({ id: begun.id, owner: { kind: 'job', job: next }, conversation: { resumed: true }, isCurrent: current, claimId: resumed.claimId });
});

test('bounded conversation, turn and call windows are refused without truncation', t => {
  const { sessions } = fixture(t);
  assert.throws(() => sessions.begin({ logicalKey: 'k-large', bindings: bindings(), owner: workspaceOwner(), isCurrent: current,
    conversation: { text: 'x'.repeat(SESSION_LIMITS.conversationChars + 1) } }), error => error.code === 'SESSION_CONVERSATION_LIMIT');
  const begun = sessions.begin({ logicalKey: 'k-limits', bindings: bindings(), owner: workspaceOwner(), isCurrent: current });
  assert.throws(() => sessions.saveProgress({ id: begun.id, owner: workspaceOwner(), conversation: {}, turn: 5, calls: 0, isCurrent: current, claimId: begun.claimId }),
    error => error.code === 'SESSION_TURN_LIMIT');
  assert.throws(() => sessions.saveProgress({ id: begun.id, owner: workspaceOwner(), conversation: {}, turn: 0, calls: 9, isCurrent: current, claimId: begun.claimId }),
    error => error.code === 'SESSION_CALL_LIMIT');
  assert.throws(() => sessions.toolIntent({ id: begun.id, owner: workspaceOwner(), turn: 0, callIndex: 8, tool: 'x', effect: 'read', args: {}, isCurrent: current, claimId: begun.claimId }),
    error => error.code === 'SESSION_CALL_LIMIT');
});

test('at most 64 sessions can be active', t => {
  const { sessions } = fixture(t);
  for (let index = 0; index < SESSION_LIMITS.maxActive; index++) {
    sessions.begin({ logicalKey: `k-${index}`, bindings: bindings(), owner: workspaceOwner(`owner-${index}`), isCurrent: current });
  }
  assert.throws(() => sessions.begin({ logicalKey: 'k-overflow', bindings: bindings(), owner: workspaceOwner('overflow'), isCurrent: current }),
    error => error.code === 'SESSION_LIMIT');
});

test('session TTL is capped at 24h and never outlives source validity', t => {
  const { sessions, advance } = fixture(t);
  const capped = sessions.begin({ logicalKey: 'k-ttl', bindings: bindings(), owner: workspaceOwner(), isCurrent: current, ttlMs: 7 * 24 * 3600 * 1000 });
  assert.equal(Date.parse(capped.expiresAt) - START, SESSION_LIMITS.ttlMs);
  const validUntil = new Date(START + 5000).toISOString();
  const bounded = sessions.begin({ logicalKey: 'k-source', bindings: bindings(), owner: workspaceOwner('source'), isCurrent: current,
    sourceRefs: [{ kind: 'connector', id: 'google', validUntil }], ttlMs: SESSION_LIMITS.ttlMs });
  assert.equal(bounded.expiresAt, validUntil);
  advance(SESSION_LIMITS.ttlMs + 1);
  assert.equal(sessions.sweep(), 2);
  const safe = sessions.read({ id: capped.id });
  assert.equal(safe.status, 'expired');
  assert.equal(safe.hasConversation, false);
});

test('cached final survives the caller-commit crash window; the current handle acks and erases private bytes', t => {
  const { database, sessions } = fixture(t);
  const begun = sessions.begin({ logicalKey: 'k-final', bindings: bindings(), owner: workspaceOwner(), isCurrent: current, conversation: { turn: 1 } });
  sessions.awaitCommit({ id: begun.id, owner: workspaceOwner(), claimId: begun.claimId, final: { deliverable: 'report' }, turn: 1, calls: 2, conversation: { turn: 1, done: true }, isCurrent: current });
  const resumed = sessions.begin({ logicalKey: 'k-final', bindings: bindings(), owner: workspaceOwner(), isCurrent: current });
  assert.deepEqual(resumed.cachedFinal, { deliverable: 'report' });
  assert.notEqual(resumed.claimId, begun.claimId, 'serving a cached final supersedes the old nonce');
  const row = database.db.prepare('SELECT conversation_json,final_json FROM reasoning_sessions WHERE id=?').get(begun.id);
  assert.ok(row.conversation_json && row.final_json);
  assert.throws(() => sessions.ack({ id: begun.id, owner: workspaceOwner(), isCurrent: current, claimId: begun.claimId }),
    error => error.code === 'SESSION_OWNER_LOST', 'a superseded handle cannot ack');
  const acked = sessions.ack({ id: begun.id, owner: workspaceOwner(), isCurrent: current, claimId: resumed.claimId });
  assert.equal(acked.status, 'completed');
  assert.equal(acked.hasConversation, false);
  assert.equal(acked.hasFinal, false);
  assert.deepEqual(database.db.prepare('SELECT conversation_json,pending_json,final_json,final_digest FROM reasoning_sessions WHERE id=?').get(begun.id),
    { conversation_json: null, pending_json: null, final_json: null, final_digest: null });
  assert.throws(() => sessions.begin({ logicalKey: 'k-final', bindings: bindings(), owner: workspaceOwner(), isCurrent: current }),
    error => error.code === 'SESSION_ACKED');
});

test('rejectFinal clears the cached answer, keeps tool work and is bounded to the current claim', t => {
  const { sessions } = fixture(t);
  const begun = sessions.begin({ logicalKey: 'k-reject', bindings: bindings(), owner: workspaceOwner(), isCurrent: current, conversation: { turn: 1 } });
  sessions.toolIntent({ id: begun.id, owner: workspaceOwner(), turn: 0, callIndex: 0, tool: 'read', effect: 'read', args: { q: 1 }, operationId: 'op-1', isCurrent: current, claimId: begun.claimId });
  sessions.toolResult({ id: begun.id, owner: workspaceOwner(), operationId: 'op-1', text: 'stored result', isCurrent: current, claimId: begun.claimId });
  let claimId = begun.claimId;
  for (let attempt = 0; attempt < SESSION_LIMITS.rejectFinalLimit; attempt++) {
    sessions.awaitCommit({ id: begun.id, owner: workspaceOwner(), claimId, final: { invalid: true }, turn: 0, calls: 1, isCurrent: current });
    // Rejecting clears the invocation claim; the owning caller resumes with a
    // fresh claim over the same session before making its next attempt.
    const rejected = sessions.rejectFinal({ id: begun.id, owner: workspaceOwner(), reason: 'grounding', isCurrent: current, claimId });
    assert.equal(rejected.status, 'active');
    assert.equal(rejected.cachedFinal, null);
    assert.equal(sessions.operation({ id: begun.id, operationId: 'op-1' }).result_json, 'stored result');
    claimId = sessions.begin({ logicalKey: 'k-reject', bindings: bindings(), owner: workspaceOwner(), isCurrent: current }).claimId;
  }
  sessions.awaitCommit({ id: begun.id, owner: workspaceOwner(), claimId, final: { invalid: true }, turn: 0, calls: 1, isCurrent: current });
  assert.throws(() => sessions.rejectFinal({ id: begun.id, owner: workspaceOwner(), reason: 'again', isCurrent: current, claimId }),
    error => error.code === 'SESSION_FINAL_REJECTED');
  assert.equal(sessions.read({ id: begun.id }).status, 'blocked');
});

test('ForgetService clears private session bodies for a forgotten task without an owner callback', async t => {
  const context = fixture(t);
  const task = createTask(context, 'forget-task');
  const begun = context.sessions.begin({ logicalKey: 'k-forget', scope: 'task', taskId: task.taskId, bindings: bindings(),
    owner: { kind: 'job', job: task.job }, isCurrent: current, conversation: { secret: 'FORGET-ME' }, sourceRefs: [{ kind: 'task', id: task.taskId }] });
  context.sessions.awaitCommit({ id: begun.id, owner: { kind: 'job', job: task.job }, claimId: begun.claimId, final: { secret: 'FORGET-FINAL' }, turn: 1, calls: 0, isCurrent: current });
  const privacy = new ForgetService(context.database, { jobs: context.jobs, memory: null, store: null, fileRoot: '/private/tmp/unprompted-tmp' });
  await privacy.forget({ kind: 'task', id: task.taskId });
  const row = context.database.db.prepare('SELECT status,conversation_json,pending_json,final_json,claim_id FROM reasoning_sessions WHERE id=?').get(begun.id);
  assert.equal(row.status, 'invalidated');
  assert.deepEqual([row.conversation_json, row.pending_json, row.final_json, row.claim_id], [null, null, null, null]);
  assert.equal(JSON.stringify(context.sessions.read({ id: begun.id })).includes('FORGET'), false);
  assert.throws(() => context.sessions.begin({ logicalKey: 'k-forget', scope: 'task', taskId: task.taskId, bindings: bindings(),
    owner: { kind: 'job', job: task.job }, isCurrent: current }),
  error => ['SESSION_INVALIDATED', 'SESSION_TASK_INACTIVE', 'SESSION_OWNER_LOST'].includes(error.code));
});

test('connector revocation clears corresponding private sessions but not unrelated scopes', async t => {
  const { database, jobs, sessions } = fixture(t);
  const revoked = sessions.begin({ logicalKey: 'k-revoked', bindings: bindings(), owner: workspaceOwner('a'), isCurrent: current,
    conversation: { secret: 'REVOKED-PROMPT' }, sourceRefs: [{ kind: 'connector', id: 'google' }] });
  sessions.awaitCommit({ id: revoked.id, owner: workspaceOwner('a'), claimId: revoked.claimId, final: { secret: 'REVOKED-FINAL' }, turn: 1, calls: 0, isCurrent: current });
  const unrelated = sessions.begin({ logicalKey: 'k-unrelated', bindings: bindings(), owner: workspaceOwner('b'), isCurrent: current,
    conversation: { keep: 'UNRELATED' }, sourceRefs: [{ kind: 'connector', id: 'notion' }] });
  const privacy = new ForgetService(database, { jobs, memory: null, store: null, fileRoot: '/private/tmp/unprompted-tmp' });
  await privacy.revokePermission({ connectorId: 'google' });
  const revokedRow = database.db.prepare('SELECT status,conversation_json,final_json FROM reasoning_sessions WHERE id=?').get(revoked.id);
  assert.equal(revokedRow.status, 'invalidated');
  assert.deepEqual([revokedRow.conversation_json, revokedRow.final_json], [null, null]);
  const unrelatedRow = database.db.prepare('SELECT status,conversation_json FROM reasoning_sessions WHERE id=?').get(unrelated.id);
  assert.equal(unrelatedRow.status, 'active');
  assert.ok(unrelatedRow.conversation_json);
  assert.equal(sessions.read({ id: revoked.id }).hasConversation, false);
});

test('operation context only correlates a ledger execution and never grants authority', t => {
  const context = fixture(t);
  const task = runningTask(context);
  const session = context.sessions.begin({ logicalKey: 'op-session', bindings: bindings(), owner: workspaceOwner(), isCurrent: current });
  const operation = { sessionId: session.id, operationId: 'op-ledger', turn: 0, callIndex: 0, tool: 'demo', effect: 'write', argsDigest: 'digest' };
  const intent = runWithOperation(operation, () => context.ledger.intent({
    taskId: task.taskId, run: task.run, job: task.job, provider: 'fixture', tool: 'demo', actionFamily: 'fixture.write',
    resourceId: 'resource', key: 'key-1', effect: { type: 'fixture' }, payload: {}, authorize: () => authorizeForTests()
  }));
  assert.equal(operationContext() == null, true);
  const mapped = context.database.db.prepare('SELECT session_id,operation_id,execution_id,status FROM reasoning_session_operations WHERE operation_id=?').get('op-ledger');
  assert.deepEqual(mapped, { session_id: session.id, operation_id: 'op-ledger', execution_id: intent.execution.id, status: 'executing' });
  assert.throws(() => runWithOperation(operation, () => context.ledger.intent({
    taskId: task.taskId, run: task.run, job: task.job, provider: 'fixture', tool: 'demo', actionFamily: 'fixture.write',
    resourceId: 'resource-2', key: 'key-2', effect: { type: 'fixture' }, payload: {}, authorize: () => ({ allowed: false })
  })), error => error.code === 'AUTHORIZATION_REQUIRED');
});

test('the actual classic caller holds one fetch capability per session and a deferred invocation can be resumed', async t => {
  const context = fixture(t);
  let fetches = 0;
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'm-1', reasoningSessions: context.sessions,
    fetchImpl: async () => { fetches += 1; return reply(chat('{"deliverable":"report","subjectEntity":"Lobby","requiredContent":[]}')); } });
  const spec = { logicalKey: 'classic-concurrent', semanticStage: 'general', bindings: bindings(), owner: workspaceOwner(), isCurrent: current };
  const first = context.sessions.classicTurn({ reasoner, requestId: 'first', system: 'synthetic system', user: 'synthetic user', context: { scope: 'workspace', session: spec } });
  assert.throws(() => context.sessions.classicTurn({ reasoner, requestId: 'second', system: 'synthetic system', user: 'synthetic user', context: { scope: 'workspace', session: spec } }),
    error => error.code === 'SESSION_BUSY');
  const result = await context.sessions.runClassic(first, () => context.sessions.sessionFetch(reasoner, 'first')('https://synthetic.invalid', { body: JSON.stringify({ model: 'm-1' }) }));
  assert.equal((await result.json()).choices[0].message.content.includes('deliverable'), true);
  assert.equal(fetches, 1);
  context.sessions.defer({ id: first.id, owner: first.owner, claimId: first.claimId, isCurrent: current, code: 'budget_deferred' });
  const resumed = context.sessions.classicTurn({ reasoner, requestId: 'third', system: 'synthetic system', user: 'synthetic user', context: { scope: 'workspace', session: spec } });
  assert.equal(resumed.id, first.id);
  assert.notEqual(resumed.claimId, first.claimId);
  assert.throws(() => context.sessions.saveConversation({ id: first.id, owner: first.owner, claimId: first.claimId, isCurrent: current, conversation: { late: true } }),
    error => error.code === 'SESSION_OWNER_LOST');
});

test('default reasoning without an explicit session creates no private session rows', async t => {
  const { database, sessions, budget } = fixture(t);
  let fetches = 0;
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: budget, reasoningSessions: sessions,
    fetchImpl: async () => { fetches++; return reply(chat('{"deliverable":"report","subjectEntity":"Lobby","requiredContent":[]}')); } });
  const result = await reasoner.interpretRequest({ subject: 'Lobby', body: 'Please write a report.' }, 'req-default', { scope: 'workspace' });
  assert.equal(result.subjectEntity, 'Lobby');
  assert.equal(fetches, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 0);
  let toolFetches = 0;
  const tools = [{ name: 'read_only', effect: 'read', parameters: { type: 'object' }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }];
  const toolReasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'm-1', reasoningSessions: sessions,
    fetchImpl: async () => { toolFetches++; return reply(chat('{"done":true}')); } });
  const final = await completeWithTools({ reasoner: toolReasoner, requestId: 'tool-default', system: 's', user: 'u', tools });
  assert.deepEqual(final, { done: true });
  assert.equal(toolFetches, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 0);
});

test('createReasoner accepts an injected session service and leaves default construction unchanged', t => {
  const { sessions } = fixture(t);
  const env = { UNPROMPTED_MODEL_BASE_URL: 'https://example.test/v1', UNPROMPTED_MODEL_NAME: 'm-1' };
  const injected = createReasoner(env, { reasoningSessions: sessions, fetchImpl: async () => { throw new Error('not used'); } });
  assert.equal(injected.reasoningSessions, sessions);
  const plain = createReasoner(env, { fetchImpl: async () => { throw new Error('not used'); } });
  assert.equal(plain.reasoningSessions ?? null, null);
});

test('Pi explicitly refuses a persistent session before any SDK call', t => {
  const { sessions } = fixture(t);
  const reasoner = { id: 'pi', runtime: {}, fetchImpl: async () => { throw new Error('must not fetch'); } };
  assert.throws(() => sessions.classicTurn({ reasoner, requestId: 'pi', system: 's', user: 'u',
    context: { scope: 'workspace', session: { logicalKey: 'pi-session', bindings: bindings(), owner: workspaceOwner(), isCurrent: current } } }),
  error => error.code === 'SESSION_UNSUPPORTED_HARNESS');
});
