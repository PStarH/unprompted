import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner } from '../src/reasoning.js';
const candidate = scope => ({ kind: 'planning_hint', scopeType: scope.type, scopeKey: scope.key, predicate: { op: 'always' }, effect: { type: 'advisory' }, instruction: 'Check the stated requirements before preparing a draft.', freshnessClass: 'operational' });
function fixture(t, { task = false, empty = false, malformed = false, unsafe = false, wrongScope = false, hold = false, failFirst = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-compilation-')), store = new SqliteStore(path.join(root, 'state.json'));
  let now = Date.now(), calls = 0, announce, release; store.database.now = () => now;
  const inputs = [], started = new Promise(resolve => { announce = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const reasoner = new OpenAiCompatibleReasoner({ baseUrl: 'https://example.test/v1', model: 'compile-fixture', limits: { maxCallsPerMinute: 100 }, fetchImpl: async (_, options) => {
    calls++; const wire = JSON.parse(options.body); assert.match(wire.messages[0].content, /Experience candidates/);
    const input = JSON.parse(wire.messages.find(m => m.role === 'user').content); inputs.push(input);
    if (hold) { announce(); await pending; }
    if (failFirst && calls === 1) return { ok: false, status: 503, json: async () => ({ error: 'temporary', usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    const proposed = candidate(input.scope);
    if (unsafe) proposed.permissions = { external_write: true };
    if (wrongScope) { proposed.scopeType = 'global'; proposed.scopeKey = '*'; }
    const result = malformed ? { invalid: true } : { experiences: empty ? [] : [proposed] };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  const engine = new WorkEngine(store, { reasoner }), runtime = new DurableRuntime(engine, { tickMs: 1000000 });
  let taskId = null;
  if (task) {
    taskId = runtime.tasks.createOrLoad({ candidateKey: 'completed-feedback-task', data: { request: { subjectEntity: 'Cedar', deliverable: 'report' } } }).taskId;
    const initial = store.jobs.claim('fixture-setup'); store.jobs.complete(initial);
    const original = runtime.tasks.get(taskId); runtime.tasks.update(taskId, original.stateVersion, entry => { entry.status = 'completed'; }); store.refresh();
  }
  t.after(async () => { release(); await runtime.close(); await engine.whenSettled(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, engine, runtime, reasoner, taskId, inputs, started, release, calls: () => calls, advance: value => { now = value; },
    feedback: () => runtime.experiences.feedback({ kind: 'explicit_acceptance', taskId }),
    idle: async () => { runtime.kick(); await engine.whenSettled(); await runtime.whenIdle(); await engine.whenSettled(); },
    sessions: () => store.db.prepare("SELECT * FROM reasoning_sessions WHERE semantic_stage='discovery'").all(),
    jobs: () => store.jobs.list().filter(j => j.job_type === 'compile_experience') };
}
for (const task of [false, true]) for (const empty of [false, true]) test(`native compiler task=${task} empty=${empty} atomically ACKs bounded candidates`, async t => {
  const f = fixture(t, { task, empty }); f.feedback(); await f.idle(); assert.equal(f.calls(), 1);
  assert.equal(f.sessions().length, 1); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.sessions()[0].final_json, null);
  const experiences = f.runtime.experiences.list(); assert.equal(experiences.length, empty ? 0 : 1); if (!empty) assert.equal(experiences[0].status, 'candidate');
  const reservation = f.store.db.prepare('SELECT task_id,state FROM token_budget_reservations').get(); assert.equal(reservation.task_id, f.taskId); assert.equal(reservation.state, 'settled');
  if (task) assert.equal(f.runtime.tasks.get(f.taskId).status, 'completed');
});
for (const empty of [false, true]) test(`native compiler empty=${empty} SQL rollback retains final without repeating RPC`, async t => {
  const f = fixture(t, { task: true, empty }), commit = f.runtime.modelCommits.commitSql.bind(f.runtime.modelCommits); let inject = true;
  f.runtime.modelCommits.commitSql = (context, mutation, options) => commit(context, () => {
    const result = mutation(); if (inject) { inject = false; throw Object.assign(new Error('Injected compiler commit fault'), { code: 'SQLITE_BUSY', status: 503 }); } return result;
  }, options);
  f.feedback(); await f.idle(); assert.equal(inject, false); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'awaiting_commit'); assert.equal(f.runtime.experiences.list().length, 0);
  const waiting = f.jobs().find(j => j.state === 'retry_wait'); assert.ok(waiting);
  f.advance(Date.parse(waiting.available_at) + 1); f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed');
  assert.equal(f.store.jobs.get(waiting.id).state, 'completed'); assert.equal(f.runtime.experiences.list().length, empty ? 0 : 1);
});
for (const type of ['malformed','unsafe','wrongScope']) test(`native compiler ${type} does not ACK or create candidates`, async t => {
  const f = fixture(t, { task: true, [type]: true }); f.feedback(); await f.idle(); assert.equal(f.calls(), 1);
  assert.equal(f.sessions().length, 1); assert.notEqual(f.sessions()[0].status, 'completed'); assert.equal(f.sessions()[0].final_json, null);
  assert.equal(f.runtime.experiences.list().length, 0); assert.equal(f.jobs()[0].state, 'dead');
});
for (const scope of ['workspace','task']) test(`completed task feedback resumes same native session/job after ${scope} Token wake`, async t => {
  const f = fixture(t, { task: true }); f.runtime.tokenBudget.setLimit({ scope, ...(scope === 'task' ? { taskId: f.taskId } : {}), tokens: 0 });
  f.feedback(); await f.idle(); assert.equal(f.calls(), 0); const id = f.sessions()[0].id, job = f.jobs()[0]; assert.equal(job.last_error_class, 'budget');
  f.runtime.tokenBudget.setLimit({ scope, ...(scope === 'task' ? { taskId: f.taskId } : {}), tokens: 1000000 }); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].id, id); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.store.jobs.get(job.id).state, 'completed');
  assert.equal(f.runtime.tasks.get(f.taskId).status, 'completed');
});
test('completed task missing-price deferral resumes after trusted matching price without reopening task', async t => {
  const f = fixture(t, { task: true }), money = f.reasoner.modelMoney;
  money.configureLimit({ scope: 'workspace', currency: 'USD', micros: 1000000 }); f.feedback(); await f.idle();
  assert.equal(f.calls(), 0); const id = f.sessions()[0].id, job = f.jobs()[0]; assert.equal(job.last_error_class, 'budget');
  money.configureProfile({ providerId: money.providerId, protocol: 'chat-completions', model: 'compile-fixture', currency: 'USD', revision: 1,
    rates: { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 } });
  f.runtime.kick(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].id, id); assert.equal(f.store.jobs.get(job.id).state, 'completed');
  assert.equal(f.runtime.tasks.get(f.taskId).status, 'completed');
});
test('Forget feedback while native compiler is held prevents late candidates', async t => {
  const f = fixture(t, { task: true, hold: true }), feedback = f.feedback(); f.runtime.kick(); await f.started;
  await f.runtime.privacy.forget({ kind: 'feedback', id: feedback.id }); f.release(); await f.idle();
  assert.equal(f.runtime.experiences.list().length, 0); assert.equal(f.sessions().some(s => s.status === 'completed'), false);
});
test('ordinary terminal task job cannot borrow the learning exception with forged purpose bindings', async t => {
  const f = fixture(t, { task: true }), feedback = f.feedback();
  const queued = f.store.jobs.enqueue({ type: 'task_continue', taskId: f.taskId, key: 'forged-learning-purpose', payload: { taskId: f.taskId } });
  const job = f.store.jobs.claim('ordinary-owner', { id: queued.id });
  const context = f.runtime.modelCommits.context({ scope: 'task', taskId: f.taskId, stage: 'discovery', key: 'forged-closed-learning', owner: { kind: 'job', job },
    bindings: { authorityVersion: 'test', contextVersion: 'test', inputVersion: 'test', purpose: 'experience_compile', compilationSourceId: feedback.id, catalogVersion: 'experience-compile/no-tools/v1', privacyEpoch: f.runtime.tasks.get(f.taskId).privacyEpoch }, isCurrent: () => true });
  await assert.rejects(f.reasoner.compileExperiences({ scope: { type: 'project', key: 'Cedar' } }, 'forged-learning', context), { code: 'SESSION_TASK_INACTIVE' }); assert.equal(f.calls(), 0);
  f.store.jobs.complete(job);
});
test('ordinary closed task budget job stays parked on a workspace wake', t => {
  const f = fixture(t, { task: true });
  const queued = f.store.jobs.enqueue({ type: 'task_continue', taskId: f.taskId, key: 'ordinary-closed-budget', payload: { taskId: f.taskId } });
  const job = f.store.jobs.claim('ordinary-owner', { id: queued.id }); f.store.jobs.fail(job, { code: 'TOKEN_BUDGET_EXHAUSTED' });
  const wake = f.store.jobs.startBudgetWake({ key: 'closed-ordinary-wake', kind: 'token' }); f.store.jobs.wakeBudgetDeferred({ eventId: wake.id });
  assert.equal(f.store.jobs.get(job.id).available_at, '9999-12-31T23:59:59.999Z');
});
test('native compiler retries a provider failure under a new RPC attempt while retaining semantic identity', async t => {
  const f = fixture(t, { task: true, failFirst: true }); f.feedback(); await f.idle(); assert.equal(f.calls(), 1);
  const job = f.jobs()[0], id = f.sessions()[0].id; assert.equal(job.state, 'retry_wait'); f.advance(Date.parse(job.available_at) + 1); f.runtime.kick(); await f.idle();
  assert.equal(f.calls(), 2); assert.equal(f.sessions()[0].id, id); assert.equal(f.store.jobs.get(job.id).state, 'completed');
});

test('real learning job capability cannot enable a tool loop on the terminal task', async t => {
  const f = fixture(t, { task: true }); f.feedback(); const queued = f.jobs()[0];
  const job = f.store.jobs.claim('learning-owner', { queue: 'learning', id: queued.id });
  const summary = f.runtime.experiences.compilationInput(job).summary, context = f.runtime.compilationModelContext(job, summary);
  let tools = 0;
  await assert.rejects(f.reasoner.investigateTask({ task: f.runtime.tasks.get(f.taskId), externalTools: [{ name: 'forbidden_compiler_tool', description: 'Not available to learning', parameters: { type: 'object', properties: {} }, handler: async () => { tools++; } }] }, 'compile-tools-forbidden', context), { code: 'SESSION_UNSUPPORTED_HARNESS' });
  assert.equal(f.calls(), 0); assert.equal(tools, 0); f.store.jobs.complete(job);
});
test('paused completed task learning stays parked despite Token capacity release', async t => {
  const f = fixture(t, { task: true }); f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 }); f.feedback(); await f.idle();
  const job = f.jobs()[0], current = f.runtime.tasks.get(f.taskId); f.runtime.tasks.update(f.taskId, current.stateVersion, entry => { entry.control = { ...entry.control, paused: true }; });
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 1000000 }); await f.idle(); assert.equal(f.calls(), 0); assert.equal(f.store.jobs.get(job.id).state, 'retry_wait');
});
test('changed feedback task scope is refused before model call rather than teaching a new project', async t => {
  const f = fixture(t, { task: true }); f.feedback(); const current = f.runtime.tasks.get(f.taskId);
  f.runtime.tasks.update(f.taskId, current.stateVersion, entry => { entry.request.subjectEntity = 'Birch'; });
  await f.idle(); assert.equal(f.calls(), 0); assert.equal(f.runtime.experiences.list().length, 0); assert.equal(f.jobs()[0].state, 'dead');
});
test('legacy native feedback job missing original summary digest does not invent verified scope', async t => {
  const f = fixture(t, { task: true }); f.feedback(); const job = f.jobs()[0], payload = { ...job.payload }; delete payload.compilationInputDigest;
  f.runtime.database.atomic(() => f.store.db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(JSON.stringify(payload), job.id));
  await f.idle(); assert.equal(f.calls(), 0); assert.equal(f.runtime.experiences.list().length, 0); assert.equal(f.store.jobs.get(job.id).state, 'dead');
});
test('unrelated memory version change does not repeat or discard structured feedback compilation', async t => {
  const f = fixture(t, { task: true, hold: true }); f.feedback(); f.runtime.kick(); await f.started;
  await f.runtime.ingestInstruction({ text: 'An unrelated team prefers concise meeting agendas.', kind: 'fact' });
  f.release(); await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.sessions()[0].status, 'completed'); assert.equal(f.runtime.experiences.list().length, 1);
});
test('unrelated privacy change rebuilds unchanged feedback under same job without losing completed-task scope', async t => {
  const f = fixture(t, { task: true, hold: true }); const memory = f.runtime.memory.put({ content: 'An unrelated temporary note.', scopeType: 'global', scopeKey: '*' });
  f.feedback(); f.runtime.kick(); await f.started; await f.runtime.privacy.forget({ kind: 'memory', id: memory.id }); f.release(); await f.idle();
  assert.equal(f.runtime.experiences.list().length, 0); const job = f.jobs()[0]; assert.equal(job.state, 'retry_wait');
  f.advance(Date.parse(job.available_at) + 1); await f.idle(); assert.equal(f.calls(), 2); assert.equal(f.store.jobs.get(job.id).state, 'completed');
  assert.equal(f.runtime.experiences.list().length, 1); assert.equal(f.runtime.tasks.get(f.taskId).status, 'completed');
});

test('completed compiler job replay creates no extra candidate or RPC even after Token budget closes', async t => {
  const f = fixture(t, { task: true }); f.feedback(); await f.idle(); const original = f.jobs()[0]; assert.equal(f.calls(), 1);
  f.runtime.tokenBudget.setLimit({ scope: 'workspace', tokens: 0 });
  const replay = f.store.jobs.enqueue({ queue: 'learning', type: 'compile_experience', key: 'compile-completed-replay', taskId: f.taskId, payload: original.payload });
  await f.idle(); assert.equal(f.calls(), 1); assert.equal(f.runtime.experiences.list().length, 1); assert.equal(f.store.jobs.get(replay.id).state, 'completed');
  assert.equal(f.runtime.tasks.get(f.taskId).status, 'completed');
});
