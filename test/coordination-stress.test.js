import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DurableDatabase, iso } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';

const workerPath = fileURLToPath(new URL('./fixtures/coordination-stress-worker.mjs', import.meta.url));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-coordination-stress-'));
  const filename = path.join(directory, 'workspace.sqlite');
  let now = Date.parse('2026-04-01T00:00:00.000Z');
  const connections = [];
  const open = () => {
    const database = new DurableDatabase(filename, { now: () => now });
    const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 });
    const tasks = new DurableTasks(database, jobs);
    const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: 2000 });
    connections.push(database);
    return { database, jobs, tasks, ledger };
  };
  const context = { ...open(), open, filename, now: () => now, advance: value => { now += value; } };
  t.after(() => {
    for (const database of connections) { try { database.close(); } catch { /* already closed */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return context;
}

function spawnWorker(t, mode, filename, options = {}) {
  const child = fork(workerPath, [mode, filename, JSON.stringify(options)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
  return child;
}
async function nextMessage(child) { const [message] = await once(child, 'message'); return message; }
function sendTo(child, message) { if (child.connected) child.send(message); }
async function waitExit(child) { if (child.exitCode == null && child.signalCode == null) await once(child, 'exit'); }
async function shutdown(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  sendTo(child, { action: 'exit' });
  await exited;
}

async function startProvider(t) {
  const state = { revision: 'rev-1', patches: [], emails: new Map(), requests: 0, accepted: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      state.requests++;
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
      const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/email') {
        const existing = state.emails.get(payload.key);
        if (existing) { reply(200, { receipt: existing }); return; }
        state.accepted++;
        const receipt = { id: `mail-${state.accepted}`, idempotencyKey: payload.key, threadId: payload.threadId || 'thread-email' };
        state.emails.set(payload.key, receipt);
        reply(200, { receipt });
        return;
      }
      if (request.url === '/document') {
        if (payload.requiredRevisionId !== state.revision) { reply(409, { error: 'base version changed', definitiveNoEffect: true }); return; }
        state.patches.push(payload);
        state.revision = `rev-${state.patches.length + 1}`;
        reply(200, { receipt: { id: state.revision, idempotencyKey: payload.key } });
        return;
      }
      if (request.url === '/ambiguous') {
        // Accept the write, then lose the response path. The caller cannot
        // distinguish acceptance from failure, so its claim must stay open.
        state.accepted++;
        request.socket.destroy();
        return;
      }
      reply(404, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { state, endpoint: `http://127.0.0.1:${server.address().port}` };
}

function running(context, key) {
  const created = context.tasks.createOrLoad({ candidateKey: key, data: { subject: key } });
  const queued = context.jobs.enqueue({ type: 'stress_write', key: `stress:${key}`, taskId: created.taskId, payload: {} });
  const job = context.jobs.claim('local-worker', { id: queued.id });
  assert.ok(job, 'the local fixture job must be claimable');
  const run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, job, run };
}
function localIntent(context, current, { key, resourceId }) {
  return context.ledger.intent({ ...current, provider: 'fixture', tool: 'send', actionFamily: 'fixture.send', resourceId, key,
    effect: { type: 'fixture' }, payload: {}, authorize: () => ({ allowed: true }) });
}

test('two real worker processes behind a barrier claim one SQLite job exactly once', async t => {
  const context = fixture(t);
  context.jobs.enqueue({ id: 'contended-job', type: 'stress', key: 'contended' });
  const first = spawnWorker(t, 'hold', context.filename, { now: context.now() });
  const second = spawnWorker(t, 'hold', context.filename, { now: context.now() });
  assert.deepEqual((await Promise.all([nextMessage(first), nextMessage(second)])).map(message => message.stage), ['ready', 'ready']);
  const claims = [nextMessage(first), nextMessage(second)];
  sendTo(first, { action: 'claim', jobId: 'contended-job' });
  sendTo(second, { action: 'claim', jobId: 'contended-job' });
  const results = await Promise.all(claims);
  assert.equal(results.filter(result => result.claimed).length, 1, 'SQLite must grant the lease to exactly one process');
  const row = context.database.db.prepare("SELECT state,lease_owner FROM jobs WHERE id='contended-job'").get();
  assert.equal(row.state, 'running');
  assert.ok(results.some(result => result.owner === row.lease_owner));
  await Promise.all([shutdown(first), shutdown(second)]);
});

test('an expired worker cannot complete the job a replacement process owns', async t => {
  const context = fixture(t);
  context.jobs.enqueue({ id: 'lease-job', type: 'stress', key: 'lease' });
  const stale = spawnWorker(t, 'hold', context.filename, { now: context.now(), leaseMs: 1000 });
  const fresh = spawnWorker(t, 'hold', context.filename, { now: context.now(), leaseMs: 1000 });
  await Promise.all([nextMessage(stale), nextMessage(fresh)]);
  sendTo(stale, { action: 'claim', jobId: 'lease-job' });
  assert.equal((await nextMessage(stale)).claimed, 'lease-job');

  context.advance(2000);
  const advanced = [nextMessage(stale), nextMessage(fresh)];
  sendTo(stale, { action: 'advance', ms: 2000 });
  sendTo(fresh, { action: 'advance', ms: 2000 });
  await Promise.all(advanced);
  context.jobs.expire();
  assert.equal(context.jobs.get('lease-job').state, 'recovery_required');
  context.jobs.recover('lease-job', () => ({ state: 'queued', safeToRepeat: true }));

  sendTo(fresh, { action: 'claim', jobId: 'lease-job' });
  assert.equal((await nextMessage(fresh)).claimed, 'lease-job');
  sendTo(stale, { action: 'complete' });
  const rejected = await nextMessage(stale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LEASE_LOST');
  sendTo(fresh, { action: 'complete' });
  assert.deepEqual(await nextMessage(fresh), { stage: 'complete', ok: true });
  assert.equal(context.jobs.get('lease-job').state, 'completed');
  await Promise.all([shutdown(stale), shutdown(fresh)]);
});

test('an unresolved external outcome survives restart and only confirmed absence frees the resource', async t => {
  const context = fixture(t);
  const provider = await startProvider(t);
  const worker = spawnWorker(t, 'write', context.filename, {
    now: context.now(), endpoint: provider.endpoint, path: '/ambiguous',
    candidateKey: 'ambiguous-task', resourceId: 'thread:shared', key: 'ambiguous-write',
    actionFamily: 'email.send', reviewToken: 'review-current', expectedReviewToken: 'review-current'
  });
  const outcome = await nextMessage(worker);
  assert.equal(outcome.stage, 'dispatch');
  assert.equal(outcome.ambiguous, true);
  assert.equal(outcome.status, 'unknown');
  await waitExit(worker);

  const claimRow = () => context.database.db.prepare("SELECT claim_state,current_execution_id FROM resource_claims WHERE resource_id='thread:shared'").get();
  assert.equal(claimRow().claim_state, 'unresolved');
  const executionId = claimRow().current_execution_id;
  assert.equal(provider.state.accepted, 1);

  // A different resource remains independently writable while the first claim
  // is unresolved.
  const independent = running(context, 'independent-task');
  assert.equal(localIntent(context, independent, { key: 'independent-write', resourceId: 'thread:independent' }).claim.resourceId, 'thread:independent');

  // Restart the service: the queue and the unresolved claim are durable facts.
  context.database.close();
  const reopened = context.open();
  context.database = reopened.database; context.jobs = reopened.jobs; context.tasks = reopened.tasks; context.ledger = reopened.ledger;
  assert.equal(claimRow().claim_state, 'unresolved');
  context.jobs.enqueue({ id: 'after-restart', type: 'stress', key: 'after-restart' });
  const restarted = context.jobs.claim('restarted-worker', { id: 'after-restart' });
  assert.equal(restarted?.id, 'after-restart');
  context.jobs.complete(restarted);

  const fresh = running(context, 'fresh-task');
  assert.throws(() => localIntent(context, fresh, { key: 'fresh-write', resourceId: 'thread:shared' }), error => error.code === 'RESOURCE_UNRESOLVED');
  const notFound = await context.ledger.reconcile(executionId, { lookup: async () => ({ status: 'not_found' }) });
  assert.equal(notFound.status, 'unknown');
  assert.equal(claimRow().claim_state, 'unresolved');
  const wrongReceipt = await context.ledger.reconcile(executionId, { lookup: async () => ({ status: 'found', receipt: { id: 'foreign-receipt', idempotencyKey: 'another-operation' } }) });
  assert.equal(wrongReceipt.status, 'unknown');
  assert.equal(claimRow().claim_state, 'unresolved');
  assert.throws(() => context.ledger.verified(executionId, { id: 'foreign-receipt', idempotencyKey: 'another-operation' }), error => error.code === 'INVALID_RECEIPT');
  assert.equal(claimRow().claim_state, 'unresolved');
  const absent = await context.ledger.reconcile(executionId, { lookup: async () => ({ status: 'not_found' }), reliableAbsence: true });
  assert.deepEqual(absent, { status: 'not_found', safeToRetry: true });
  assert.equal(context.ledger.get(executionId).status, 'failed');
  assert.equal(context.ledger.get(executionId).last_error_class, 'confirmed_absent');
  assert.equal(claimRow().claim_state, 'free');
  assert.equal(localIntent(context, fresh, { key: 'fresh-write', resourceId: 'thread:shared' }).claim.resourceId, 'thread:shared');
});

test('two document patches from one base version apply at most once and a stale review token never dispatches', async t => {
  const context = fixture(t);
  const provider = await startProvider(t);
  const base = {
    now: context.now(), endpoint: provider.endpoint, path: '/document',
    actionFamily: 'document.patch', tool: 'apply_patch',
    request: { requiredRevisionId: 'rev-1', change: 'append' },
    effect: { type: 'document_patch', baseVersion: 'rev-1' },
    reviewToken: 'review-current', expectedReviewToken: 'review-current'
  };
  const first = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'doc-first', resourceId: 'document:cedar', key: 'patch:first' });
  const firstResult = await nextMessage(first);
  assert.equal(firstResult.stage, 'done');
  assert.equal(firstResult.status, 'verified');
  await waitExit(first);
  assert.equal(provider.state.patches.length, 1);

  const denied = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'doc-denied', resourceId: 'document:cedar', key: 'patch:denied', conditionalVersion: 'rev-1', reviewToken: 'review-stale' });
  const deniedResult = await nextMessage(denied);
  assert.equal(deniedResult.stage, 'intent');
  assert.equal(deniedResult.error, 'AUTHORIZATION_REQUIRED');
  await waitExit(denied);
  assert.equal(provider.state.patches.length, 1, 'an unauthorized write must never reach the provider');

  const second = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'doc-second', resourceId: 'document:cedar', key: 'patch:second', conditionalVersion: 'rev-1' });
  const secondResult = await nextMessage(second);
  assert.equal(secondResult.stage, 'dispatch');
  assert.equal(secondResult.status, 'cancelled');
  await waitExit(second);
  assert.equal(provider.state.patches.length, 1, 'the provider applied only the first patch from the shared base version');
  assert.equal(provider.state.revision, 'rev-2');
  const rows = context.database.db.prepare("SELECT status,last_error_class FROM tool_executions WHERE action_family='document.patch'").all();
  assert.deepEqual(rows.map(row => row.status).sort(), ['cancelled', 'verified']);
  assert.equal(rows.find(row => row.status === 'cancelled').last_error_class, 'confirmed_no_effect');
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM resource_claims WHERE claim_state!='free'").get().n, 0);
});

test('the same email idempotency key is accepted by the provider once under process contention', async t => {
  const context = fixture(t);
  const provider = await startProvider(t);
  const base = {
    now: context.now(), endpoint: provider.endpoint, path: '/email', actionFamily: 'email.send', tool: 'send',
    request: { to: 'alex@example.test', subject: 'Status', body: 'Body' }, effect: { type: 'email_reply' },
    reviewToken: 'review-current', expectedReviewToken: 'review-current', barrier: true
  };
  const first = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'mail-first', resourceId: 'thread:mail-first', key: 'email:shared' });
  const second = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'mail-second', resourceId: 'thread:mail-second', key: 'email:shared' });
  const prepared = await Promise.all([nextMessage(first), nextMessage(second)]);
  const preparedMessage = prepared.find(message => message.stage === 'prepared');
  const rejected = prepared.find(message => message.stage !== 'prepared');
  assert.ok(preparedMessage, 'one process must prepare the shared idempotency key');
  assert.equal(rejected?.stage, 'intent');
  assert.equal(rejected?.error, 'IDEMPOTENCY_CONFLICT');
  const preparedWorker = prepared[0].stage === 'prepared' ? first : second;
  const rejectedWorker = preparedWorker === first ? second : first;
  const resultPromise = nextMessage(preparedWorker);
  sendTo(preparedWorker, { go: true });
  const result = await resultPromise;
  assert.equal(result.stage, 'done');
  assert.equal(result.status, 'verified');
  await Promise.all([waitExit(preparedWorker), waitExit(rejectedWorker)]);
  assert.equal(provider.state.accepted, 1, 'the fake provider accepted exactly one message for the key');
  assert.equal(provider.state.requests, 1, 'only one process reached the provider');
  assert.equal(context.database.db.prepare('SELECT status FROM tool_executions WHERE id=?').get(preparedMessage.executionId).status, 'verified');
});

test('two processes competing for one thread resource dispatch at most one write', async t => {
  const context = fixture(t);
  const provider = await startProvider(t);
  const base = {
    now: context.now(), endpoint: provider.endpoint, path: '/email', actionFamily: 'email.send', tool: 'send',
    request: { to: 'alex@example.test', subject: 'Status', body: 'Body' }, effect: { type: 'email_reply' },
    reviewToken: 'review-current', expectedReviewToken: 'review-current', barrier: true, resourceId: 'thread:contended'
  };
  const first = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'claim-first', key: 'claim:first' });
  const second = spawnWorker(t, 'write', context.filename, { ...base, candidateKey: 'claim-second', key: 'claim:second' });
  const prepared = await Promise.all([nextMessage(first), nextMessage(second)]);
  const preparedMessage = prepared.find(message => message.stage === 'prepared');
  const rejected = prepared.find(message => message.stage !== 'prepared');
  assert.ok(preparedMessage, 'one process must acquire the resource claim');
  assert.equal(rejected?.stage, 'intent');
  assert.equal(rejected?.error, 'RESOURCE_UNRESOLVED');
  const preparedWorker = prepared[0].stage === 'prepared' ? first : second;
  const rejectedWorker = preparedWorker === first ? second : first;
  const resultPromise = nextMessage(preparedWorker);
  sendTo(preparedWorker, { go: true });
  assert.equal((await resultPromise).status, 'verified');
  await Promise.all([waitExit(preparedWorker), waitExit(rejectedWorker)]);
  assert.equal(provider.state.accepted, 1);
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM resource_claims WHERE claim_state!='free'").get().n, 0);
});

test('the persistent job queue serves old due work in availability/id order while new work arrives', t => {
  const context = fixture(t);
  for (let index = 0; index < 5; index++) context.jobs.enqueue({ id: `old-${index}`, type: 'stress', key: `old-${index}` });
  context.database.db.prepare("UPDATE jobs SET priority=900 WHERE id='old-0'").run();
  context.jobs.enqueue({ id: 'z-future', type: 'stress', key: 'future', availableAt: iso(context.now() + 60000) });
  const served = [];
  for (let index = 0; index < 25; index++) {
    context.jobs.enqueue({ id: `z-late-${index}`, type: 'stress', key: `late-${index}` });
    const job = context.jobs.claim('drainer');
    assert.ok(job);
    served.push(job.id);
    context.jobs.complete(job);
  }
  assert.deepEqual(served.slice(0, 5), ['old-0', 'old-1', 'old-2', 'old-3', 'old-4'], 'legacy priority and newly inserted work cannot reorder old due jobs');
  assert.ok(!served.includes('z-future'), 'future availability is not claimable early');

  context.database.close();
  const reopened = context.open();
  context.database = reopened.database; context.jobs = reopened.jobs;
  // Ids are compared as text, so the five remaining lexicographically largest
  // suffixes are 5..9; the order must be identical after reconnect.
  assert.equal(context.jobs.claim('after-restart').id, 'z-late-5', 'queued work and stable order survive restart');
  context.advance(60001);
  const remaining = [];
  for (;;) {
    const job = context.jobs.claim('after-restart');
    if (!job) break;
    remaining.push(job.id);
    context.jobs.complete(job);
  }
  assert.deepEqual(remaining, ['z-late-6', 'z-late-7', 'z-late-8', 'z-late-9', 'z-future'], 'availability precedes id and future work waits for its time');
});
