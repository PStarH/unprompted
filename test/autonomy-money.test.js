import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { WorkEngine } from '../src/engine.js';
import { NullReasoner } from '../src/reasoning.js';
import { PermissionPolicy } from '../src/permissions.js';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unprompted-yolo-money-'));
 let store=new SqliteStore(path.join(dir,'state.json'));
 let engine=new WorkEngine(store,{reasoner:new NullReasoner(),policy:new PermissionPolicy({shadow:false})});
 let runtime=new DurableRuntime(engine,{tickMs:100000});runtime.worker.stopping=true;
 let now=Date.now();store.database.now=()=>now;engine.autonomy.now=()=>now;
 const taskId=runtime.tasks.createOrLoad({candidateKey:'money-task',data:{subject:'Money test',request:{subjectEntity:'Cedar',deliverable:'report'}}}).taskId;
 t.after(async()=>{await runtime.close();await engine.whenSettled();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {get store(){return store;},get engine(){return engine;},get runtime(){return runtime;},taskId,advance:ms=>{now+=ms;},
   restart:async()=>{await runtime.close();await engine.whenSettled();store.close();store=new SqliteStore(path.join(dir,'state.json'));store.database.now=()=>now;engine=new WorkEngine(store,{reasoner:new NullReasoner(),policy:new PermissionPolicy({shadow:false})});engine.autonomy.now=()=>now;runtime=new DurableRuntime(engine,{tickMs:100000});runtime.worker.stopping=true;}};
}
const options=(cap=100)=>({mode:'time',durationMinutes:30,money:{currency:'USD',capMicros:cap,durationMinutes:20,confirmed:true}});
function quote(c,grant,amount=60,taskId=c.taskId) {
 const task=c.runtime.tasks.get(taskId);
 const binding={provider:'fixture',tool:'charge',actionFamily:'fixture.charge',taskId,inputVersion:task.inputVersion,privacyEpoch:String(task.privacyEpoch),resourceId:'resource',payload:{amount},effect:{type:'charge',amount},mcpSchemaId:null,mcpConnectionId:null};
 const q=c.runtime.transactionMoney.issueQuote({...binding,grantId:grant.moneyBudget.grantId,currency:'USD',amountMicros:amount,quoteExpiresAt:new Date(c.store.database.now()+60000).toISOString()},{isCurrent:()=>true});
 return {q,binding};
}
test('default zero has no paid allowance; positive caps require confirmation and bounded money expiry',t=>{
 const c=fixture(t),g=c.engine.autonomy.create({mode:'time',durationMinutes:30});
 const {q,binding}=quote(c,g,1);
 assert.throws(()=>c.runtime.transactionMoney.reserve(q,{attemptId:'zero',binding}),{code:'MONEY_BUDGET_EXHAUSTED'});
 assert.throws(()=>c.engine.autonomy.create({...options(),money:{...options().money,confirmed:false}}),{code:'INVALID_AUTONOMY'});
 assert.throws(()=>c.engine.autonomy.create({...options(),money:{...options().money,durationMinutes:31}}),{code:'INVALID_AUTONOMY'});
 assert.throws(()=>c.engine.autonomy.create({...options(),money:{...options().money,capMicros:1.1}}),{code:'INVALID_AUTONOMY'});
});
test('renewal, explicit stop and reauthorization retain cumulative unknown holds',t=>{
 const c=fixture(t),money=c.runtime.transactionMoney,g=c.engine.autonomy.create(options());
 const {q,binding}=quote(c,g);const hold=money.reserve(q,{attemptId:'first',binding});money.markDispatched(hold,binding);money.markUnknownAttempt('first');
 const unbound=quote(c,g,30);
 const renewed=c.engine.autonomy.create(options());assert.equal(renewed.moneyBudget.grantId,g.moneyBudget.grantId);
 assert.equal(c.engine.autonomy.describe().grants.find(x=>x.id===renewed.id).moneyBudget.unknownMicros,60);
 assert.throws(()=>money.reserve(unbound.q,{attemptId:'stale',binding:unbound.binding}),{code:'TRANSACTION_QUOTE_STALE'});
 assert.throws(()=>money.reserve(q,{attemptId:'reused',binding}),{code:'TRANSACTION_QUOTE_REUSED'});
 const next=quote(c,renewed,50);assert.throws(()=>money.reserve(next.q,{attemptId:'too-much',binding:next.binding}),{code:'MONEY_BUDGET_EXHAUSTED'});
 const revokedQuote=quote(c,renewed,30);c.engine.autonomy.revoke(renewed.id);
 assert.throws(()=>money.reserve(revokedQuote.q,{attemptId:'revoked',binding:revokedQuote.binding}),{code:'TRANSACTION_QUOTE_STALE'});
 assert.equal(money.attemptInfo('first').state,'unknown');
 const restored=c.engine.autonomy.create(options());assert.equal(restored.moneyBudget.grantId,g.moneyBudget.grantId);
 assert.equal(money.autonomyBudgetInfo(restored.moneyBudget.grantId).remainingMicros,40);
});
test('money expiry, task closure, pause and foreign task deny linked native quotes',t=>{
 const c=fixture(t),money=c.runtime.transactionMoney;
 let grant=c.engine.autonomy.create({mode:'task',taskId:c.taskId,money:{currency:'USD',capMicros:100,durationMinutes:1,confirmed:true}});
 const pending=quote(c,grant,20);
 c.store.mutate(state=>{state.tasks[c.taskId].control={paused:true};});
 assert.throws(()=>money.reserve(pending.q,{attemptId:'paused',binding:pending.binding}),{code:'TRANSACTION_QUOTE_STALE'});
 c.store.mutate(state=>{state.tasks[c.taskId].control={paused:false};});
 const other=c.runtime.tasks.createOrLoad({candidateKey:'other',data:{subject:'Other'}}).taskId;
 assert.throws(()=>quote(c,grant,20,other),{code:'TRANSACTION_QUOTE_STALE'});
 c.advance(61000);assert.throws(()=>quote(c,grant,20),{code:'TRANSACTION_QUOTE_STALE'});
 grant=c.engine.autonomy.create(options());c.store.mutate(state=>{state.tasks[c.taskId].status='cancelled';});
 assert.throws(()=>quote(c,grant,20),{code:'TRANSACTION_QUOTE_STALE'});
});
test('a SQLite commit failure cannot publish a partial formal or monetary grant',t=>{
 const c=fixture(t),db=c.store.database.db;
 db.exec("CREATE TRIGGER reject_autonomy_commit BEFORE UPDATE ON workspace_state BEGIN SELECT RAISE(ABORT,'synthetic grant rollback'); END");
 assert.throws(()=>c.engine.autonomy.create(options()),/synthetic grant rollback/);db.exec('DROP TRIGGER reject_autonomy_commit');
 assert.equal(c.engine.autonomy.grants().length,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM money_budget_leases WHERE grant_id LIKE 'autonomy:%'").get().n,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM metadata WHERE key LIKE 'autonomy_money_authority:%'").get().n,0);
});

test('persisted spending and unknown holds survive a closed runtime and reopened workspace',async t=>{
 const c=fixture(t),g=c.engine.autonomy.create(options());const {q,binding}=quote(c,g);
 const money=c.runtime.transactionMoney,h=money.reserve(q,{attemptId:'restart-held',binding});money.markDispatched(h,binding);money.markUnknownAttempt('restart-held');
 await c.restart();
 const next=c.engine.autonomy.create(options());assert.equal(next.moneyBudget.grantId,g.moneyBudget.grantId);
 const info=c.runtime.transactionMoney.autonomyBudgetInfo(next.moneyBudget.grantId);assert.equal(info.unknownMicros,60);assert.equal(info.remainingMicros,40);
 const tooMuch=quote(c,next,50);assert.throws(()=>c.runtime.transactionMoney.reserve(tooMuch.q,{attemptId:'restart-over',binding:tooMuch.binding}),{code:'MONEY_BUDGET_EXHAUSTED'});
});
test('revocation at the native dispatch boundary keeps reserved money until proven cancellation',t=>{
 const c=fixture(t),g=c.engine.autonomy.create(options()),money=c.runtime.transactionMoney,{q,binding}=quote(c,g,30);
 const h=money.reserve(q,{attemptId:'before-revoke',binding});c.engine.autonomy.revoke(g.id);
 assert.throws(()=>money.markDispatched(h,binding),{code:'TRANSACTION_QUOTE_STALE'});
 assert.equal(money.attemptInfo('before-revoke').state,'reserved');assert.equal(money.autonomyBudgetInfo(g.moneyBudget.grantId).reservedMicros,30);
 money.cancelAttempt('before-revoke');assert.equal(money.attemptInfo('before-revoke').state,'cancelled');
});
