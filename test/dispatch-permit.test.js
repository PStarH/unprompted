import { TransactionMoneyService } from '../src/durable/transaction-money.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase } from '../src/durable/database.js';
import { DurableJobs } from '../src/durable/jobs.js';
import { DurableTasks } from '../src/durable/tasks.js';
import { ToolExecutionLedger } from '../src/durable/execution.js';
import { authorizeForTests } from '../src/authority-credential.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-permit-'));
  let now = Date.now();
  const database = new DurableDatabase(path.join(directory, 'workspace.sqlite'), { now: () => now });
  const jobs = new DurableJobs(database, { leaseMs: 30000, random: () => 0.5 }), tasks = new DurableTasks(database, jobs);
  const ledger = new ToolExecutionLedger(database, { jobs, tasks, timeoutMs: 500 });
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { database, jobs, tasks, ledger, advance: value => { now += value; } };
}
function running(context, key = 'work') {
  const created = context.tasks.createOrLoad({ candidateKey: key, data: { subject: key, request: { subjectEntity: 'project', deliverable: 'report' } } });
  const job = context.jobs.claim('worker'), run = context.tasks.beginRun(job);
  context.tasks.checkpoint(run, job, { expectedInputVersion: 0, plan: {} });
  return { taskId: created.taskId, job, run };
}
function writeIntent(context, current, key, resourceId, authorize = () => authorizeForTests()) {
  return context.ledger.intent({ ...current, provider: 'fixture', tool: 'send', actionFamily: 'fixture.send', resourceId, key, effect: { type: 'fixture' }, payload: {}, authorize });
}
function readIntent(context, current, key) {
  return context.ledger.intent({ ...current, provider: 'fixture', tool: 'read', actionFamily: 'fixture.read', resourceId: 'read-resource', key, effect: { type: 'read' }, payload: {}, isWrite: false });
}

test('dispatch permit: valid write dispatch and opaque frozen surface', async t => {
  const context = fixture(t), current = running(context), permit = writeIntent(context, current, 'write', 'main-resource');
  assert.ok(Object.isFrozen(permit));
  assert.deepEqual(Object.keys(permit).sort(), ['claim', 'duplicate', 'execution']);
  assert.equal(permit.authorize, undefined);
  assert.equal(permit.duplicate, false);
  assert.equal(permit.execution.idempotency_key, 'write');
  assert.equal(permit.claim.resourceId, 'main-resource');
  assert.equal(Reflect.set(permit, 'authorize', () => ({ allowed: false })), false);
  const execution = permit.execution;
  permit.execution = { id: 'replaced' };
  assert.equal(permit.execution, execution);
  assert.equal(Reflect.deleteProperty(permit, 'execution'), false);
  assert.equal(permit.execution, execution);
  let calls = 0;
  const result = await context.ledger.dispatch(permit, { ...current, send: async () => { calls++; return { id: 'receipt-1' }; } });
  assert.equal(result.id, 'receipt-1');
  assert.equal(calls, 1);
  const row = context.ledger.get(permit.execution.id);
  assert.equal(row.status, 'accepted');
  assert.equal(row.provider_receipt_id, 'receipt-1');
  assert.ok(row.dispatched_at);
});

test('dispatch permit: clones, round-trips, spreads and foreign-ledger permits are rejected', async t => {
  const context = fixture(t), current = running(context), permit = writeIntent(context, current, 'write', 'main-resource');
  const other = new ToolExecutionLedger(context.database, { jobs: context.jobs, tasks: context.tasks, timeoutMs: 500 });
  const foreign = writeIntent({ ledger: other }, current, 'foreign-write', 'foreign-resource');
  const variants = [['spread', { ...permit }], ['json', JSON.parse(JSON.stringify(permit))], ['clone', structuredClone(permit)], ['foreign', foreign]];
  let calls = 0;
  for (const [name, variant] of variants) {
    await assert.rejects(context.ledger.dispatch(variant, { ...current, send: async () => { calls++; return { id: name }; } }), error => {
      assert.equal(error.code, 'PERMIT_INVALID', name); assert.equal(error.status, 403, name); return true;
    });
    const row = context.ledger.get(permit.execution.id);
    assert.equal(row.status, 'intent', name); assert.equal(row.dispatched_at, null, name);
  }
  assert.equal(calls, 0);
  const result = await context.ledger.dispatch(permit, { ...current, send: async () => ({ id: 'receipt-1' }) });
  assert.equal(result.id, 'receipt-1');
});

test('dispatch permit: second and concurrent dispatch are rejected with exactly one provider call', async t => {
  const context = fixture(t), current = running(context), permit = writeIntent(context, current, 'write', 'main-resource');
  let calls = 0;
  const send = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 25)); return { id: 'receipt-1' }; };
  const first = context.ledger.dispatch(permit, { ...current, send });
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send }), error => error.code === 'PERMIT_CONSUMED' && error.status === 409);
  assert.equal((await first).id, 'receipt-1');
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send }), error => error.code === 'PERMIT_CONSUMED' && error.status === 409);
  assert.equal(calls, 1);
  assert.equal(context.ledger.get(permit.execution.id).status, 'accepted');
});

test('dispatch permit: authorize is private and a changed decision before dispatch is denied', async t => {
  const context = fixture(t), current = running(context);
  let allowed = true;
  const permit = writeIntent(context, current, 'auth-write', 'auth-resource', () => allowed ? authorizeForTests() : { allowed: false });
  assert.equal(permit.authorize, undefined);
  assert.equal(Reflect.set(permit, 'authorize', () => ({ allowed: false })), false);
  allowed = false;
  let calls = 0;
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send: async () => { calls++; return { id: 'x' }; } }), error => error.code === 'AUTHORIZATION_REQUIRED' && error.status === 403);
  assert.equal(calls, 0);
  const row = context.ledger.get(permit.execution.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.dispatched_at, null);
  // A rolled-back authorization does not consume the permit; the retry fails on
  // its released claim, not with PERMIT_CONSUMED.
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send: async () => { calls++; return { id: 'x' }; } }), error => error.code !== 'PERMIT_CONSUMED');
  assert.equal(calls, 0);
});

test('dispatch permit: a failed marker transaction leaves no marker and an unused permit', async t => {
  const context = fixture(t), current = running(context), permit = writeIntent(context, current, 'write', 'main-resource');
  const atomic = context.database.atomic.bind(context.database);
  let fail = true;
  context.database.atomic = callback => { if (fail) { fail = false; throw new Error('sqlite synthetic failure'); } return atomic(callback); };
  let calls = 0;
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send: async () => { calls++; return { id: 'x' }; } }), /synthetic failure/);
  assert.equal(calls, 0);
  const row = context.ledger.get(permit.execution.id);
  assert.equal(row.dispatched_at, null);
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE execution_id=? AND state='dispatched'").get(permit.execution.id).n, 0);
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send: async () => { calls++; return { id: 'x' }; } }), error => error.code !== 'PERMIT_CONSUMED');
  assert.equal(calls, 0);
});

test('dispatch permit: verified duplicate reads remain repeatable and are never consumed', async t => {
  const context = fixture(t), current = running(context);
  let calls = 0;
  const first = readIntent(context, current, 'read-key');
  assert.equal(first.duplicate, false);
  const result = await context.ledger.dispatch(first, { ...current, send: async () => { calls++; return { id: 'read-1' }; } });
  assert.deepEqual(result, { id: 'read-1' });
  assert.equal(context.ledger.get(first.execution.id).status, 'verified');
  const duplicate = readIntent(context, current, 'read-key');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.claim, null);
  const again = await context.ledger.dispatch(duplicate, { ...current, send: async () => { calls++; return { id: 'read-2' }; } });
  const third = await context.ledger.dispatch(duplicate, { ...current, send: async () => { calls++; return { id: 'read-3' }; } });
  assert.deepEqual(again, { id: 'read-1' });
  assert.deepEqual(third, { id: 'read-1' });
  assert.equal(calls, 1);
});

test('dispatch permit: repeated provider guard refuses a second effect and retains unknown', async t => {
  const context = fixture(t), current = running(context), permit = writeIntent(context, current, 'write', 'main-resource');
  let calls = 0;
  await assert.rejects(context.ledger.dispatch(permit, {
    ...current, deferDispatch: true,
    send: async (_signal, beforeDispatch) => { beforeDispatch(); calls++; beforeDispatch(); calls++; return { id: 'receipt-1' }; },
  }), error => error.code === 'PERMIT_CONSUMED');
  assert.equal(calls, 1);
  const row = context.ledger.get(permit.execution.id);
  assert.equal(row.status, 'unknown');
  assert.ok(row.dispatched_at);
  assert.equal(context.database.db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE execution_id=? AND state='unknown'").get(permit.execution.id).n, 1);
  await assert.rejects(context.ledger.dispatch(permit, { ...current, send: async () => ({ id: 'x' }) }), error => error.code === 'PERMIT_CONSUMED');
});

test('dispatch permit: a permit cannot be carried into another run or job (central 124 F1)', async t => {
  const context = fixture(t), current = running(context, 'first'), permit = writeIntent(context, current, 'bound-write', 'bound-resource');
  const other = running(context, 'second');
  let calls = 0;
  await assert.rejects(context.ledger.dispatch(permit, { ...other, send: async () => { calls++; return { id: 'x' }; } }), error => error.code === 'PERMIT_INVALID');
  await assert.rejects(context.ledger.dispatch(permit, { run: current.run, job: other.job, send: async () => { calls++; return { id: 'x' }; } }), error => error.code === 'PERMIT_INVALID');
  assert.equal(calls, 0);
  assert.equal(context.ledger.get(permit.execution.id).dispatched_at, null);
  const result = await context.ledger.dispatch(permit, { ...current, send: async () => { calls++; return { id: 'bound-receipt' }; } });
  assert.equal(result.id, 'bound-receipt');
  assert.equal(calls, 1);
});

test('dispatch authority: public execution mutation cannot classify a write as verified read', async t => {
 const c=fixture(t), cur=running(c), permit=writeIntent(c,cur,'audit-mutate','audit-resource'); let writes=0;
 assert.throws(() => { permit.execution.is_write=0; }, TypeError);
 await c.ledger.dispatch(permit,{...cur,send:async()=>{writes++;return{id:'audit-receipt'};}});
 assert.equal(writes,1); assert.equal(c.ledger.get(permit.execution.id).status,'accepted');
});
test('dispatch authority: revocation before adapter call must prevent provider call', async t => {
 const c=fixture(t),cur=running(c);let allowed=true,writes=0;
 const permit=writeIntent(c,cur,'audit-gap','audit-gap-resource',()=>allowed?authorizeForTests():{allowed:false});
 const pending=c.ledger.dispatch(permit,{...cur,send:async()=>{writes++;return{id:'audit-gap-receipt'};}});allowed=false;
 try{await pending;}catch{}
 assert.equal(writes,0);
});
test('dispatch authority: repeated deferred guard must not authorize a second effect',async t=>{
 const c=fixture(t),cur=running(c),permit=writeIntent(c,cur,'audit-double','audit-double-resource');let writes=0;
 try{await c.ledger.dispatch(permit,{...cur,deferDispatch:true,send:async(_signal,before)=>{before();writes++;before();writes++;return{id:'audit-double-receipt'};}});}catch{}
 assert.equal(writes,1);
});
test('dispatch authority: a newly asynchronous authority decision is refused',async t=>{
 const c=fixture(t),cur=running(c);let checks=0,writes=0;
 const permit=writeIntent(c,cur,'audit-async','audit-async-resource',()=>{checks++;if(checks===1)return authorizeForTests();const p=Promise.resolve({allowed:false});p.allowed=true;return p;});
 try{await c.ledger.dispatch(permit,{...cur,send:async()=>{writes++;return{id:'audit-async-receipt'};}});}catch{}
 assert.equal(writes,0);
});
test('dispatch authority: matching run id cannot borrow another task run fields',async t=>{
 const c=fixture(t),cur=running(c,'original'),permit=writeIntent(c,cur,'audit-run','audit-run-resource'),other=running(c,'other');let writes=0;
 c.tasks.applyControl(cur.taskId,'YIELD','audit-pause',task=>{task.control={paused:true};});
 const forged={...other.run,id:cur.run.id};
 try{await c.ledger.dispatch(permit,{run:forged,job:cur.job,send:async()=>{writes++;return{id:'audit-run-receipt'};}});}catch{}
 assert.equal(writes,0);
});

test('task run assertions refuse borrowed persisted task/job fields before checkpoint or resume', t => {
  const c = fixture(t), original = running(c, 'run-original'), other = running(c, 'run-other');
  const forged = { ...other.run, id: original.run.id };
  assert.throws(() => c.tasks.assertRun(forged, { job: original.job }), { code: 'RUN_INVALIDATED' });
  assert.throws(() => c.tasks.checkpoint(forged, original.job, { expectedInputVersion: 0, plan: {} }), { code: 'RUN_INVALIDATED' });
  assert.equal(c.tasks.assertRun(original.run, { job: original.job }).id, original.taskId);
});

test('transaction participants reject a foreign workspace and structural lookalikes', t => {
  const c = fixture(t), other = fixture(t);
  assert.throws(() => new ToolExecutionLedger(c.database, { tasks:c.tasks, jobs:c.jobs, transfers:new TransactionMoneyService(other.database) }), { code:'TRANSACTION_PARTICIPANT_INVALID', status:409 });
  assert.throws(() => new ToolExecutionLedger(c.database, { tasks:c.tasks, jobs:c.jobs, transfers:{ database:c.database, db:c.database.db, isNativeQuote:()=>true } }), { code:'TRANSACTION_PARTICIPANT_INVALID', status:409 });
  assert.doesNotThrow(() => new ToolExecutionLedger(c.database, { tasks:c.tasks, jobs:c.jobs, transfers:new TransactionMoneyService(c.database) }));
});
