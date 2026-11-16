import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ForgetService } from '../src/durable/privacy.js';
import { DurableReasoningSessions } from '../src/durable/reasoning-sessions.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';
import { TokenBudgetService } from '../src/durable/token-budget.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
import { completeWithTools } from '../src/tool-loop.js';

/**
 * Real classic and tool-loop continuation.
 *
 * Every case uses the real SQLite database, the real token/execution ledgers
 * and a fake provider that records the exact wire calls. A resumed run must
 * reuse the durable model turn and tool receipts: re-fetching a completed
 * model turn or replaying an executed write fails these tests.
 */

const START = Date.parse('2026-11-13T10:00:00.000Z');
const bindings = (extra = {}) => ({ authorityVersion: 1, privacyEpoch: 0, contextVersion: 0, inputVersion: 0, catalogVersion: 1, ...extra });
const workspaceOwner = (token = 'owner-token') => ({ kind: 'workspace', ownerId: 'workspace-owner', token });

function fixture(t) {
  const clock = { value: START };
  const database = new DurableDatabase(':memory:', { now: () => clock.value });
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 });
  const tasks = new DurableTasks(database, jobs);
  const sessions = new DurableReasoningSessions(database, { now: () => clock.value, workspaceLeaseMs: 1000 });
  const budget = new TokenBudgetService(database);
  const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: 200 });
  t.after(() => database.close());
  return { database, jobs, tasks, sessions, budget, ledger, clock, advance: ms => { clock.value += ms; } };
}

function runningTask(context, key = 'resume-task') {
  const created = context.tasks.createOrLoad({ candidateKey: key, data: { subject: key, request: { subjectEntity: 'project', deliverable: 'report' } } });
  const job = context.jobs.claim('worker');
  const run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, job, run };
}

function restart(context, current) {
  context.advance(30001);
  context.jobs.expire();
  context.jobs.recover(current.job.id, () => ({ state: 'queued', safeToRepeat: true }));
  const job = context.jobs.claim('replacement');
  const run = context.tasks.beginRun(job);
  return { ...current, job, run };
}

const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const chat = (content, { calls = [] } = {}) => ({
  choices: [{ message: { role: 'assistant', content, tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }
});
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const finalBody = { deliverable: 'report', subjectEntity: 'Lobby', requiredContent: [] };

function classicReasoner(context, fetchImpl) {
  return new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget,
    reasoningSessions: context.sessions, fetchImpl
  });
}

function sessionSpec(owner, extra = {}) {
  return { logicalKey: 'classic-session', bindings: bindings(), owner, isCurrent: () => true, ...extra };
}

test('a classic session deferred by budget resumes once with a new owner and request id, then serves its cached final', async t => {
  const context = fixture(t);
  context.budget.setLimit({ scope: 'workspace', tokens: 10 });
  let fetches = 0;
  const provider = async () => { fetches += 1; return reply(chat(JSON.stringify(finalBody))); };
  const first = classicReasoner(context, provider);

  await assert.rejects(() => first.interpretRequest({ subject: 'Lobby', body: 'PRIVATE-CLASSIC-BODY' }, 'classic-1',
    { scope: 'workspace', session: sessionSpec(workspaceOwner('owner-a')) }), error => error.code === 'TOKEN_BUDGET_EXHAUSTED');
  assert.equal(fetches, 0, 'an exhausted budget spends no fetch');
  const deferred = context.sessions.read({ scope: 'workspace', logicalKey: 'classic-session' });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.hasConversation, true);

  context.advance(1001);
  context.budget.setLimit({ scope: 'workspace', tokens: 1000000 });
  const resumed = classicReasoner(context, provider);
  const result = await resumed.interpretRequest({ subject: 'Lobby', body: 'PRIVATE-CLASSIC-BODY' }, 'classic-2',
    { scope: 'workspace', session: sessionSpec(workspaceOwner('owner-b')) });
  assert.equal(result.subjectEntity, 'Lobby');
  assert.equal(result.deliverable, 'report');
  assert.equal(fetches, 1, 'the resumed turn is fetched once, not from the first turn');
  const committed = context.sessions.read({ scope: 'workspace', logicalKey: 'classic-session' });
  assert.equal(committed.status, 'awaiting_commit');
  assert.equal(committed.hasFinal, true);

  const cached = await classicReasoner(context, provider).interpretRequest({ subject: 'Lobby', body: 'PRIVATE-CLASSIC-BODY' }, 'classic-3',
    { scope: 'workspace', session: sessionSpec(workspaceOwner('owner-b')) });
  assert.deepEqual(cached, result);
  assert.equal(fetches, 1, 'a caller crash before commit returns the cached final without another fetch');
  const safe = JSON.stringify({ read: context.sessions.read({ id: committed.id }), describe: context.sessions.describe() });
  assert.equal(safe.includes('PRIVATE-CLASSIC-BODY'), false);

  const ackClaim = context.database.db.prepare('SELECT claim_id FROM reasoning_sessions WHERE id=?').get(committed.id).claim_id;
  context.sessions.ack({ id: committed.id, owner: workspaceOwner('owner-b'), isCurrent: () => true, claimId: ackClaim });
  const erased = context.database.db.prepare('SELECT status,conversation_json,pending_json,final_json,final_digest FROM reasoning_sessions WHERE id=?').get(committed.id);
  assert.deepEqual(erased, { status: 'completed', conversation_json: null, pending_json: null, final_json: null, final_digest: null });
});

test('a rejected classic final is cleared and retried from the model turn without replaying the stale JSON', async t => {
  const context = fixture(t);
  let fetches = 0;
  const provider = async () => {
    fetches += 1;
    return reply(chat(fetches === 1 ? JSON.stringify({ ...finalBody, deliverable: 'draft' }) : JSON.stringify(finalBody)));
  };
  const spec = sessionSpec(workspaceOwner());
  const first = await classicReasoner(context, provider).interpretRequest({ subject: 'Lobby', body: 'Body' }, 'reject-1',
    { scope: 'workspace', session: spec });
  assert.equal(first.deliverable, 'draft');
  const id = context.sessions.read({ scope: 'workspace', logicalKey: 'classic-session' }).id;
  assert.equal(context.sessions.read({ id }).hasFinal, true);

  const claim = context.database.db.prepare('SELECT claim_id FROM reasoning_sessions WHERE id=?').get(id).claim_id;
  const rejected = context.sessions.rejectFinal({ id, owner: workspaceOwner(), reason: 'grounding', isCurrent: () => true, claimId: claim });
  assert.equal(rejected.status, 'active');
  assert.equal(rejected.cachedFinal, null);
  assert.equal(context.sessions.read({ id }).hasFinal, false);

  const second = await classicReasoner(context, provider).interpretRequest({ subject: 'Lobby', body: 'Body' }, 'reject-2',
    { scope: 'workspace', session: spec });
  assert.equal(second.deliverable, 'report');
  assert.equal(fetches, 2, 'the rejected cached JSON is fetched again, not returned');
  assert.equal(context.sessions.read({ id }).status, 'awaiting_commit');
});

test('an invalid explicit session context fails locally without a fetch or a session row', async t => {
  const context = fixture(t);
  let fetches = 0;
  const reasoner = classicReasoner(context, async () => { fetches += 1; return reply(chat(JSON.stringify(finalBody))); });
  await assert.rejects(() => reasoner.interpretRequest({ subject: 'S', body: 'B' }, 'bad-context',
    { scope: 'workspace', session: {} }), error => error.code === 'INVALID_SESSION');
  assert.equal(fetches, 0);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 0);
});

test('a tool-loop turn deferred by budget resumes after a new lease with the write executed exactly once', async t => {
  const context = fixture(t);
  const current = runningTask(context, 'tools-budget');
  context.budget.setLimit({ scope: 'workspace', tokens: 1000000 });

  let executes = 0, fetches = 0;
  const tool = writeTool(context, current, () => { executes += 1; });
  const first = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async (_url, init) => {
      fetches += 1;
      if (fetches === 1) {
        // The first attempt is already dispatched. Cap the remaining budget at
        // exactly its wire size plus the output hold, so the next turn cannot
        // fit once the tool result enlarges the request.
        context.budget.setLimit({ scope: 'workspace', tokens: Buffer.byteLength(init.body, 'utf8') + 2048 });
      }
      return reply(chat(null, { calls: [toolCall('call-1', tool.name, { note: 'once' })] }));
    }
  });
  const spec = { logicalKey: 'tool-budget-session', semanticStage: 'general', bindings: bindings(),
    owner: { kind: 'job', job: current.job }, isCurrent: () => true, sourceRefs: [{ kind: 'task', id: current.taskId }] };
  const run = (reasoner, requestId, owner) => completeWithTools({
    reasoner, requestId, system: 'system', user: 'user', tools: [tool],
    accounting: reasoner.accounting, accountingContext: { scope: 'task', taskId: current.taskId, session: { ...spec, owner } }
  });

  await assert.rejects(() => run(first, 'tools-1', { kind: 'job', job: current.job }),
    error => error.code === 'TOKEN_BUDGET_EXHAUSTED');
  assert.equal(fetches, 1, 'only the first model turn reached the wire');
  assert.equal(executes, 1, 'the write executed before the deferred turn');
  const deferred = context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-budget-session' });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.turn, 1);
  assert.equal(deferred.calls, 1);
  assert.equal(deferred.sourceRefs.some(reference => reference.kind === 'task' && reference.id === current.taskId), true);

  context.budget.setLimit({ scope: 'workspace', tokens: 1000000 });
  const restarted = restart(context, current);
  let resumedFetches = 0;
  const second = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { resumedFetches += 1; return reply(chat(JSON.stringify({ done: true }))); }
  });
  const result = await run(second, 'tools-2', { kind: 'job', job: restarted.job });
  assert.deepEqual(result, { done: true });
  assert.equal(resumedFetches, 1, 'the resumed model turn is fetched once');
  assert.equal(executes, 1, 'the completed write is never executed a second time');
  assert.equal(fetches, 1);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM token_budget_reservations').get().n, 2,
    'each actual fetch used its own accounting attempt; the refused turn reserved nothing');
  assert.equal(context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-budget-session' }).status, 'awaiting_commit');
});

test('a crash after a verified write but before its result checkpoint recovers the ledger result without re-executing', async t => {
  const context = fixture(t);
  const current = runningTask(context, 'tools-crash');
  let executes = 0, fetches = 0;
  const tool = writeTool(context, current, () => { executes += 1; });
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { fetches += 1; return reply(chat(null, { calls: [toolCall('call-crash', tool.name, { note: 'once' })] })); }
  });
  const spec = { logicalKey: 'tool-crash-session', semanticStage: 'general', bindings: bindings(),
    owner: { kind: 'job', job: current.job }, isCurrent: () => true };
  const run = (target, requestId, owner) => completeWithTools({
    reasoner: target, requestId, system: 'system', user: 'user', tools: [tool],
    accounting: target.accounting, accountingContext: { scope: 'task', taskId: current.taskId, session: { ...spec, owner } }
  });

  // Simulate abrupt process loss after the write committed but before the
  // private result checkpoint: the ledger and intent correlation are already
  // durable, so the crash is thrown from the checkpoint boundary itself.
  const original = context.sessions.toolResult.bind(context.sessions);
  let crash = true;
  context.sessions.toolResult = args => {
    if (crash) { crash = false; throw Object.assign(new Error('simulated process loss'), { code: 'SESSION_RECONCILIATION_REQUIRED' }); }
    return original(args);
  };
  try {
    await assert.rejects(() => run(reasoner, 'crash-1', { kind: 'job', job: current.job }),
      error => error.code === 'SESSION_RECONCILIATION_REQUIRED');
  } finally { context.sessions.toolResult = original; }
  assert.equal(executes, 1);
  assert.equal(fetches, 1);
  const operation = context.database.db.prepare('SELECT operation_id,status,execution_id,result_json FROM reasoning_session_operations').get();
  assert.equal(operation.status, 'completed');
  assert.ok(operation.execution_id);
  assert.equal(operation.result_json, null, 'the private result checkpoint never committed');
  assert.equal(context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-crash-session' }).status, 'active');
  assert.equal(context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-crash-session' }).hasPending, true);

  const restarted = restart(context, current);
  let resumedFetches = 0;
  const resumed = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { resumedFetches += 1; return reply(chat(JSON.stringify({ done: true }))); }
  });
  const result = await run(resumed, 'crash-2', { kind: 'job', job: restarted.job });
  assert.deepEqual(result, { done: true });
  assert.equal(executes, 1, 'the verified write is recovered from the ledger, never re-executed');
  assert.equal(resumedFetches, 1, 'the pending model turn is recovered, then the next turn is fetched once');
  assert.equal(fetches, 1);
  const recovered = context.database.db.prepare('SELECT status,execution_id,result_json FROM reasoning_session_operations').get();
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.execution_id, operation.execution_id);
  assert.ok(recovered.result_json, 'the real bounded ledger result is checkpointed');
});

test('a pending turn with a verified write and an unstarted read resumes both exactly once and keeps the call count at two', async t => {
  const context = fixture(t);
  const current = runningTask(context, 'tools-multi');
  let writes = 0, reads = 0, fetches = 0;
  const write = writeTool(context, current, () => { writes += 1; });
  const read = {
    name: 'read_source', label: 'Read source', effect: 'read',
    description: 'Read the task source.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    async execute(_callId, args) {
      reads += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, text: 'fresh read' }) }], details: {} };
    }
  };
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => {
      fetches += 1;
      return reply(chat(null, { calls: [
        toolCall('write-1', write.name, { note: 'once' }),
        toolCall('read-1', read.name, { id: 'source-1' })
      ] }));
    }
  });
  const spec = { logicalKey: 'tool-multi-session', semanticStage: 'general', bindings: bindings(), owner: { kind: 'job', job: current.job }, isCurrent: () => true };
  const run = (target, requestId, owner) => completeWithTools({
    reasoner: target, requestId, system: 'system', user: 'user', tools: [write, read],
    accounting: target.accounting, accountingContext: { scope: 'task', taskId: current.taskId, session: { ...spec, owner } }
  });

  const original = context.sessions.toolResult.bind(context.sessions);
  let crash = true;
  context.sessions.toolResult = args => {
    if (crash) { crash = false; throw Object.assign(new Error('simulated process loss'), { code: 'SESSION_RECONCILIATION_REQUIRED' }); }
    return original(args);
  };
  try {
    await assert.rejects(() => run(reasoner, 'multi-1', { kind: 'job', job: current.job }),
      error => error.code === 'SESSION_RECONCILIATION_REQUIRED');
  } finally { context.sessions.toolResult = original; }
  assert.equal(writes, 1);
  assert.equal(reads, 0, 'the second call was never started');
  assert.equal(fetches, 1);
  const pending = context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-multi-session' });
  assert.equal(pending.hasPending, true);
  assert.equal(pending.calls, 0);

  const restarted = restart(context, current);
  let resumedFetches = 0;
  const resumed = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { resumedFetches += 1; return reply(chat(JSON.stringify({ done: true }))); }
  });
  const result = await run(resumed, 'multi-2', { kind: 'job', job: restarted.job });
  assert.deepEqual(result, { done: true });
  assert.equal(writes, 1, 'the verified write is recovered once, never repeated');
  assert.equal(reads, 1, 'the unstarted read executes once on resume');
  assert.equal(resumedFetches, 1);
  const finished = context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-multi-session' });
  assert.equal(finished.status, 'awaiting_commit');
  assert.equal(finished.turn, 1);
  assert.equal(finished.calls, 2, 'two distinct pending calls count once each, not again after recovery');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_session_operations').get().n, 2);
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM reasoning_session_operations WHERE status='completed'").get().n, 2);
});

test('an unknown write outcome is not resent and blocks further model and tool work', async t => {
  const context = fixture(t);
  const current = runningTask(context, 'tools-unknown');
  let executes = 0, sends = 0, fetches = 0;
  const tool = {
    name: 'send_report', label: 'Send report', effect: 'write', managedOperation: true,
    description: 'Send the prepared report once.', parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
    async execute(_callId, args) {
      executes += 1;
      const intent = context.ledger.intent({ taskId: current.taskId, run: current.run, job: current.job,
        provider: 'fixture', tool: 'send_report', actionFamily: 'fixture.send_report', resourceId: 'remote-report',
        key: 'unknown-report-write', effect: { type: 'report' }, payload: args, authorize: () => ({ allowed: true }) });
      return context.ledger.dispatch(intent, { ...current, send: async (_signal, beforeDispatch) => {
        sends += 1; beforeDispatch(); throw Object.assign(new Error('provider failed after dispatch'), { code: 'PROVIDER_FAILED' });
      } });
    }
  };
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { fetches += 1; return reply(chat(null, { calls: [toolCall('call-unknown', tool.name, { note: 'once' })] })); }
  });
  const spec = { logicalKey: 'tool-unknown-session', semanticStage: 'general', bindings: bindings(), owner: { kind: 'job', job: current.job }, isCurrent: () => true };
  const run = target => completeWithTools({ reasoner: target, requestId: 'unknown-1', system: 'system', user: 'user', tools: [tool],
    accounting: target.accounting, accountingContext: { scope: 'task', taskId: current.taskId, session: spec } });

  await assert.rejects(() => run(reasoner), error => error.code === 'SESSION_RECONCILIATION_REQUIRED');
  assert.equal(executes, 1);
  assert.equal(sends, 1, 'the ambiguous send is attempted exactly once');
  assert.equal(fetches, 1);
  assert.equal(context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'tool-unknown-session' }).status, 'blocked');
  assert.equal(context.database.db.prepare('SELECT status FROM reasoning_session_operations').get().status, 'reconciliation_required');

  // The unresolved write keeps its original job in recovery_required. A fresh
  // worker lease on the same task must still be refused by the blocked session.
  context.advance(30001);
  const inspection = context.jobs.enqueue({ queue: 'tasks', type: 'inspection', taskId: current.taskId, key: 'unknown-inspection' });
  const replacement = context.jobs.claim('replacement', { id: inspection.id });
  assert.ok(replacement);
  const resumed = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { throw new Error('an unknown write must not reach the model'); }
  });
  await assert.rejects(() => completeWithTools({ reasoner: resumed, requestId: 'unknown-2', system: 'system', user: 'user', tools: [tool],
    accounting: resumed.accounting, accountingContext: { scope: 'task', taskId: current.taskId, session: { ...spec, owner: { kind: 'job', job: replacement } } } }),
  error => error.code === 'SESSION_RECONCILIATION_REQUIRED');
  assert.equal(executes, 1);
  assert.equal(sends, 1);
  assert.equal(fetches, 1);
});

test('a read interrupted before its result checkpoint re-checks current permission and re-reads', async t => {
  const context = fixture(t);
  const current = runningTask(context, 'tools-read');
  let reads = 0, permissionChecks = 0, executes = 0, fetches = 0;
  const tool = {
    name: 'read_source', label: 'Read source', effect: 'read', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    description: 'Read a source after checking the current permission.', async execute(_callId, args) {
      executes += 1;
      permissionChecks += 1;
      reads += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, text: 'fresh read' }) }], details: {} };
    }
  };
  const reasoner = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { fetches += 1; return reply(chat(null, { calls: [toolCall('call-read', tool.name, { id: 'source-1' })] })); }
  });
  const spec = { logicalKey: 'tool-read-session', semanticStage: 'general', bindings: bindings(), owner: { kind: 'job', job: current.job }, isCurrent: () => true };
  const run = (target, requestId, owner) => completeWithTools({ reasoner: target, requestId, system: 'system', user: 'user', tools: [tool],
    accounting: target.accounting, accountingContext: { scope: 'task', taskId: current.taskId, session: { ...spec, owner } } });

  const original = context.sessions.toolResult.bind(context.sessions);
  let crash = true;
  context.sessions.toolResult = args => {
    if (crash) { crash = false; throw Object.assign(new Error('simulated process loss'), { code: 'SESSION_RECONCILIATION_REQUIRED' }); }
    return original(args);
  };
  try {
    await assert.rejects(() => run(reasoner, 'read-crash', { kind: 'job', job: current.job }),
      error => error.code === 'SESSION_RECONCILIATION_REQUIRED');
  } finally { context.sessions.toolResult = original; }
  assert.equal(executes, 1);
  assert.equal(reads, 1);
  assert.equal(context.database.db.prepare('SELECT status,execution_id FROM reasoning_session_operations').get().status, 'intent');

  const restarted = restart(context, current);
  let resumedFetches = 0;
  const resumed = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { resumedFetches += 1; return reply(chat(JSON.stringify({ done: true }))); }
  });
  const result = await run(resumed, 'read-resume', { kind: 'job', job: restarted.job });
  assert.deepEqual(result, { done: true });
  assert.equal(permissionChecks, 2, 'the resumed read checks the current permission again');
  assert.equal(reads, 2, 'an unproven read may be repeated after re-verification');
  assert.equal(resumedFetches, 1);
  assert.equal(fetches, 1);
});

test('two service instances and an old owner cannot both execute one session', t => {
  const context = fixture(t);
  const other = new DurableReasoningSessions(context.database, { now: () => context.clock.value, workspaceLeaseMs: 1000 });
  const begun = context.sessions.begin({ logicalKey: 'two-instances', bindings: bindings(), owner: workspaceOwner('a'), isCurrent: () => true });
  assert.throws(() => other.begin({ logicalKey: 'two-instances', bindings: bindings(), owner: workspaceOwner('b'), isCurrent: () => true }),
    error => error.code === 'SESSION_BUSY');
  context.advance(1001);
  const takeover = other.begin({ logicalKey: 'two-instances', bindings: bindings(), owner: workspaceOwner('b'), isCurrent: () => true });
  assert.equal(takeover.id, begun.id);
  assert.throws(() => context.sessions.toolIntent({ id: begun.id, owner: workspaceOwner('a'), turn: 0, callIndex: 0,
    tool: 'write', effect: 'write', args: {}, operationId: 'stale-op', isCurrent: () => true, claimId: begun.claimId }), error => error.code === 'SESSION_OWNER_LOST');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_session_operations').get().n, 0);
  other.toolIntent({ id: begun.id, owner: workspaceOwner('b'), turn: 0, callIndex: 0, tool: 'write', effect: 'write', args: {}, operationId: 'fresh-op', isCurrent: () => true, claimId: takeover.claimId });
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_session_operations').get().n, 1);
});

test('forgetting a bound task clears private classic bodies and refuses a late write', async t => {
  const context = fixture(t);
  const current = runningTask(context, 'tools-privacy');
  let fetches = 0;
  const reasoner = classicReasoner(context, async () => { fetches += 1; return reply(chat(JSON.stringify(finalBody))); });
  const spec = { logicalKey: 'privacy-session', semanticStage: 'general', bindings: bindings(),
    owner: { kind: 'job', job: current.job }, isCurrent: () => true, sourceRefs: [{ kind: 'task', id: current.taskId }] };
  await reasoner.interpretRequest({ subject: 'Lobby', body: 'FORGET-PRIVATE-BODY' }, 'privacy-1',
    { scope: 'task', taskId: current.taskId, session: spec });
  assert.equal(fetches, 1);
  const id = context.sessions.read({ scope: 'task', taskId: current.taskId, logicalKey: 'privacy-session' }).id;
  assert.equal(context.sessions.read({ id }).hasFinal, true);

  const privacy = new ForgetService(context.database, { jobs: context.jobs, memory: null, store: null, fileRoot: '/private/tmp/unprompted-tmp' });
  await privacy.forget({ kind: 'task', id: current.taskId });
  const row = context.database.db.prepare('SELECT status,conversation_json,pending_json,final_json FROM reasoning_sessions WHERE id=?').get(id);
  assert.equal(row.status, 'invalidated');
  assert.deepEqual([row.conversation_json, row.pending_json, row.final_json], [null, null, null]);
  assert.throws(() => context.sessions.saveConversation({ id, owner: { kind: 'job', job: current.job }, conversation: { late: 'FORGET-PRIVATE-BODY' }, isCurrent: () => true }),
    error => ['SESSION_INVALIDATED', 'SESSION_OWNER_LOST'].includes(error.code));
  assert.throws(() => context.sessions.awaitCommit({ id, owner: { kind: 'job', job: current.job }, final: { late: true }, turn: 1, calls: 0, isCurrent: () => true }),
    error => ['SESSION_INVALIDATED', 'SESSION_OWNER_LOST'].includes(error.code));
  const serialized = JSON.stringify(context.sessions.read({ id }));
  assert.equal(serialized.includes('FORGET-PRIVATE-BODY'), false);
});

test('Pi and a missing session service refuse explicit persistent sessions before any fetch', async t => {
  const context = fixture(t);
  const spec = { logicalKey: 'pi-session', bindings: bindings(), owner: workspaceOwner() };
  const pi = { id: 'pi', runtime: {}, model: 'pi', protocol: 'chat-completions', timeoutMs: 1000,
    fetchImpl: async () => { throw new Error('must not fetch'); } };
  await assert.rejects(() => completeWithTools({ reasoner: pi, requestId: 'pi', system: 's', user: 'u', tools: [],
    reasoningSessions: context.sessions, accountingContext: { scope: 'workspace', session: spec } }),
  error => error.code === 'SESSION_UNSUPPORTED_HARNESS');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 0);

  const plain = { id: 'classic', model: 'm-1', protocol: 'chat-completions', timeoutMs: 1000,
    budget: { acquire: async () => ({ ok: true }), release: () => {} }, fetchImpl: async () => { throw new Error('must not fetch'); } };
  await assert.rejects(() => completeWithTools({ reasoner: plain, requestId: 'plain', system: 's', user: 'u', tools: [],
    accountingContext: { scope: 'workspace', session: spec } }),
  error => error.code === 'INVALID_SESSION');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 0);
});

function writeTool(context, current, onExecute) {
  return {
    name: 'send_report', label: 'Send report', effect: 'write', managedOperation: true,
    sources: [{ kind: 'connector', id: 'notion' }],
    description: 'Send the prepared report once.',
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
    async execute(_callId, args) {
      onExecute();
      const intent = context.ledger.intent({ taskId: current.taskId, run: current.run, job: current.job,
        provider: 'fixture', tool: 'send_report', actionFamily: 'fixture.send_report', resourceId: 'remote-report',
        key: 'session-report-write', effect: { type: 'report' }, payload: args, authorize: () => ({ allowed: true }) });
      const result = await context.ledger.dispatch(intent, { ...current,
        send: async () => ({ id: 'remote-report' }),
        verify: async () => ({ status: 'found', receipt: { id: 'remote-report' } }) });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    }
  };
}

test('the real investigateTask externalTools caller persists a private session, defers, and resumes without replaying its write', async t => {
  const context = fixture(t);
  const task = runningTask(context, 'actual-caller');
  context.budget.setLimit({ scope: 'task', taskId: task.taskId, tokens: 1000000 });
  let executes = 0, fetches = 0;
  const tool = writeTool(context, task, () => { executes += 1; });
  const wire = [];
  const first = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async (_url, init) => {
      fetches += 1;
      wire.push(init.body);
      if (fetches === 1) {
        context.budget.setLimit({ scope: 'task', taskId: task.taskId, tokens: Buffer.byteLength(init.body, 'utf8') + 2048 });
        return reply(chat(null, { calls: [toolCall('actual-1', tool.name, { note: 'once' })] }));
      }
      return reply(chat(JSON.stringify({ done: true })));
    }
  });
  const session = { logicalKey: 'actual-caller-session', semanticStage: 'general', bindings: bindings(),
    owner: { kind: 'job', job: task.job }, isCurrent: () => true, sourceRefs: [{ kind: 'task', id: task.taskId }] };
  const accountingContext = { scope: 'task', taskId: task.taskId, session };
  const investigate = (reasoner, requestId, owner) => reasoner.investigateTask({
    task: { id: task.taskId, subject: 'Synthetic actual caller', request: { text: 'Investigate the synthetic source.' }, inputVersion: 0 },
    externalTools: [tool], directions: [], planningContext: null
  }, requestId, { ...accountingContext, session: { ...session, owner } });

  await assert.rejects(() => investigate(first, 'actual-caller-1', { kind: 'job', job: task.job }),
    error => error.code === 'TOKEN_BUDGET_EXHAUSTED');
  assert.equal(fetches, 1);
  assert.equal(executes, 1, 'the managed write ran once before the deferred turn');
  const deferred = context.sessions.read({ scope: 'task', taskId: task.taskId, logicalKey: 'actual-caller-session' });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.turn, 1);
  assert.equal(deferred.calls, 1);
  assert.equal(deferred.hasConversation, true);
  assert.equal(deferred.hasPending, false, 'the completed tool turn was checkpointed before the deferred fetch');
  const operation = context.database.db.prepare('SELECT session_id,operation_id,status,execution_id FROM reasoning_session_operations').get();
  assert.equal(operation.session_id, deferred.id);
  assert.equal(operation.status, 'completed');
  assert.ok(operation.execution_id);
  for (const body of wire) {
    assert.equal(body.includes('actual-caller-session'), false, 'the logical key never enters the wire payload');
    assert.equal(body.includes('owner-token'), false, 'provider control never enters the wire payload');
  }

  context.budget.setLimit({ scope: 'task', taskId: task.taskId, tokens: 1000000 });
  const restarted = restart(context, task);
  let resumedFetches = 0;
  const second = new OpenAiCompatibleReasoner({
    baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { resumedFetches += 1; return reply(chat(JSON.stringify({ nextStep: 'Synthetic next step' }))); }
  });
  const result = await investigate(second, 'actual-caller-2', { kind: 'job', job: restarted.job });
  assert.ok(result && (typeof result === 'string' ? result.length > 0 : true), 'the actual caller returned its bounded next step');
  assert.equal(resumedFetches, 1, 'the pending turn is recovered, then the next turn is fetched once');
  assert.equal(fetches, 1);
  assert.equal(executes, 1, 'the verified managed write is never repeated');
  const finished = context.sessions.read({ scope: 'task', taskId: task.taskId, logicalKey: 'actual-caller-session' });
  assert.equal(finished.id, deferred.id, 'the same task/session identity survives the job change');
  assert.equal(finished.status, 'awaiting_commit');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_session_operations').get().n, 1);
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_session_operations WHERE status=\'completed\'').get().n, 1);
});

test('prepareTask with external tools forwards the same trusted session context', async t => {
  const context = fixture(t);
  const task = runningTask(context, 'prepare-caller');
  let fetches = 0;
  const tool = {
    name: 'read_source', effect: 'read', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    description: 'Read a source.', async execute(_id, args) { return { content: [{ type: 'text', text: JSON.stringify({ id: args.id }) }], details: {} }; }
  };
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'm-1', tokenBudget: context.budget, reasoningSessions: context.sessions,
    fetchImpl: async () => { fetches += 1; return reply(chat(JSON.stringify({ title: 'Synthetic', body: 'Synthetic body', evidenceRefs: [] }))); } });
  const session = { logicalKey: 'prepare-caller-session', semanticStage: 'general', bindings: bindings(),
    owner: { kind: 'job', job: task.job }, isCurrent: () => true };
  const result = await reasoner.prepareTask({ task: { id: task.taskId, request: { text: 'Prepare.' } }, externalTools: [tool], planningContext: null },
    'prepare-1', { scope: 'task', taskId: task.taskId, session });
  assert.equal(result.title, 'Synthetic');
  assert.equal(fetches, 1);
  const stored = context.sessions.read({ scope: 'task', taskId: task.taskId, logicalKey: 'prepare-caller-session' });
  assert.ok(stored);
  assert.equal(stored.status, 'awaiting_commit');
  assert.equal(context.database.db.prepare('SELECT COUNT(*) n FROM reasoning_sessions').get().n, 1);
});
