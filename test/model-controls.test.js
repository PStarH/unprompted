import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { OpenAiCompatibleReasoner, NullReasoner } from '../src/reasoning.js';
import { ModelControlsService } from '../src/model-controls.js';
import { TokenRequestAccounting } from '../src/token-accounting.js';
import { parseMajor, formatMajor, modelControlsMarkup } from '../public/model-controls.js';
import { startFixtureServer } from './browser/fixture-server.mjs';
function fixture(t, native = false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'controls-')), store=new SqliteStore(path.join(root,'state.json')); let now=Date.now(), calls=0;
  store.database.now=()=>now;
  const reasoner=native ? new OpenAiCompatibleReasoner({baseUrl:'https://example.test/v1',model:'control-model',limits:{maxCallsPerMinute:100},fetchImpl:async(_,options)=>{
    calls++; const request=JSON.parse(options.body), probe=request.messages[0].content.startsWith('You propose evidence probes');
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(probe?{probes:[]}:{deliverable:'proposal',subjectEntity:'Cedar',intent:'update',requiredContent:[{text:'experiment results',sourceQuote:'experiment results',sourceField:'body'}]})}}],usage:{prompt_tokens:10,completion_tokens:5}})};
  }}) : new NullReasoner();
  if(native)reasoner.preferModelInterpretation=true;
  const engine=new WorkEngine(store,{reasoner}),runtime=new DurableRuntime(engine,{tickMs:1000000});const controls=new ModelControlsService(runtime,{get:()=>({model:null})});
  t.after(async()=>{await runtime.close();await engine.whenSettled();store.close();fs.rmSync(root,{recursive:true,force:true})});
  return {store,engine,runtime,reasoner,controls,calls:()=>calls,advance:value=>{now=value},idle:async()=>{await engine.whenSettled();await runtime.whenIdle();await engine.whenSettled()}};
}
const post=async(f,route,body,origin)=>{const r=await fetch(f.base+route,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
test('controls preserve explicit zero and null, reject unknown tasks, and use optimistic money versions',t=>{
  const f=fixture(t);assert.equal(f.controls.describe().token.workspace.limit,null);
  assert.equal(f.controls.configureToken({scope:'workspace',tokens:0}).token.workspace.limit,0);
  assert.equal(f.controls.configureToken({scope:'workspace',tokens:null}).token.workspace.limit,null);
  const view=f.controls.configureMoney({scope:'workspace',currency:'USD',micros:0,expectedVersion:0});assert.equal(view.money.limits.workspace.micros,0);
  assert.throws(()=>f.controls.configureMoney({scope:'workspace',currency:'USD',micros:null,expectedVersion:0}),{code:'MONEY_BUDGET_CONFLICT'});
  assert.equal(f.controls.configureMoney({scope:'workspace',currency:'USD',micros:null,expectedVersion:1}).money.limits.workspace.micros,null);
  assert.throws(()=>f.controls.configureToken({scope:'task',taskId:'missing',tokens:1}),{code:'MODEL_CONTROLS_TASK_MISSING'});
});
test('safe profile configuration before a model exists never activates connection or exposes key/provider identity',t=>{
  const f=fixture(t), connection={baseUrl:'https://example.test/v1',model:'new-model',protocol:'chat-completions',apiKey:'private-controls-key'};
  const input={connection,currency:'USD',revision:1,rates:{input:0,output:0,cacheRead:0,cacheWrite:0},expectedVersion:0,confirmed:true};
  assert.throws(()=>f.controls.configureProfile({...input,confirmed:false}),{code:'MODEL_PRICE_CONFIRMATION_REQUIRED'});
  const saved=f.controls.configureProfile(input);assert.equal(saved.profile.version,1);assert.equal(f.engine.reasoner.available(),false);
  const serialized=JSON.stringify(saved);assert.equal(serialized.includes(connection.apiKey),false);assert.equal(serialized.includes('providerId'),false);
  assert.throws(()=>f.controls.configureProfile({...input,providerId:'forged'}),{code:'MODEL_CONTROLS_INVALID'});
  assert.throws(()=>f.controls.configureProfile({...input,rates:{input:0}}));
  assert.throws(()=>f.controls.configureProfile(input),e=>e.code==='MONEY_BUDGET_CONFLICT'&&e.currentProfile.version===1&&!JSON.stringify(e.currentProfile).includes('providerId'));
});
for(const kind of ['token','money'])test(`real native job ${kind} config race cancels undispatched attempt and resumes same private session`,async t=>{
  const f=fixture(t,true), adapter=f.reasoner.accounting, prepare=adapter.prepare.bind(adapter), mark=adapter.markDispatched.bind(adapter), fail=f.store.jobs.fail.bind(f.store.jobs);let inject=true, firstAttempt, blockedAtFetch=null, deferred=null;
  if(kind==='money')f.reasoner.modelMoney.configureProfile({providerId:f.reasoner.modelMoney.providerId,model:'control-model',protocol:'chat-completions',currency:'USD',revision:1,rates:{input:1000000,output:1000000,cacheRead:1000000,cacheWrite:1000000}});
  adapter.prepare=args=>{const p=prepare(args);if(inject){inject=false;firstAttempt=p.attempt.attemptId;if(kind==='token')f.controls.configureToken({scope:'workspace',tokens:1000000});else f.controls.configureMoney({scope:'workspace',currency:'USD',micros:1000000,expectedVersion:0});}return p};
  adapter.markDispatched=attempt=>{try{return mark(attempt)}catch(error){if(error.code.endsWith('ACCOUNTING_STALE'))blockedAtFetch=f.calls();throw error}};
  f.store.jobs.fail=(job,error,options)=>{const row=fail(job,error,options);if(error?.code?.endsWith('ACCOUNTING_STALE'))deferred={row,session:f.store.db.prepare("SELECT id FROM reasoning_sessions WHERE semantic_stage='interpret'").get().id};return row};
  f.engine.ingest({id:'event:controls-race',type:'email.received',payload:{id:'controls-race',threadId:'controls-thread',from:'person@example.test',subject:'Cedar proposal',body:'Please update the Cedar proposal with experiment results.'}});await f.idle();assert.equal(blockedAtFetch,0);
  assert.ok(deferred);assert.equal(deferred.row.last_error_class,'budget');assert.equal(JSON.parse(deferred.row.budget_metadata_json).reason,'configuration_changed');assert.equal(JSON.parse(deferred.row.budget_metadata_json).kind,kind==='token'?'token':'model');
  assert.equal(f.store.db.prepare('SELECT state FROM token_budget_reservations WHERE attempt_id=?').get(firstAttempt).state,'cancelled');
  if(f.store.jobs.get(deferred.row.id).state!=='completed'){f.advance(Date.parse(deferred.row.available_at)+1);f.runtime.kick();await f.idle()}
  assert.ok(f.calls()>0);assert.equal(f.store.jobs.get(deferred.row.id).state,'completed');assert.equal(f.store.db.prepare('SELECT status FROM reasoning_sessions WHERE id=?').get(deferred.session).status,'completed');
  assert.equal(f.store.jobs.get(deferred.row.id).budget_deferrals,1);
});
test('duplicate permit remains conflict, stale price quote is controlled predispatch, unknown holds persist',t=>{
  const f=fixture(t,true),a=f.reasoner.accounting;f.reasoner.modelMoney.configureProfile({providerId:f.reasoner.modelMoney.providerId,model:'control-model',protocol:'chat-completions',currency:'USD',revision:1,rates:{input:1000000,output:1000000,cacheRead:1000000,cacheWrite:1000000}});
  const input={protocol:'chat-completions',scope:'workspace',payload:{model:'control-model',messages:[{role:'user',content:'hello'}]}};
  const p=a.prepare(input);a.markDispatched(p.attempt);assert.throws(()=>a.markDispatched(p.attempt),{code:'TOKEN_ACCOUNTING_CONFLICT'});a.fail(p.attempt);
  const next=a.prepare(input);f.advance(f.runtime.database.now()+60001);assert.throws(()=>a.markDispatched(next.attempt),{code:'MONEY_ACCOUNTING_STALE'});a.fail(next.attempt);
  assert.equal(f.store.db.prepare('SELECT state FROM money_budget_reservations WHERE attempt_id=?').get(p.attempt.attemptId).state,'unknown');
});
test('major-unit UI parser is exact, zero is distinct from blank, controls are bilingual and escaped',()=>{
  assert.equal(parseMajor('1.234567'),1234567);assert.equal(parseMajor('0'),0);assert.equal(parseMajor('',{optional:true}),null);assert.equal(formatMajor(1234567),'1.234567');assert.throws(()=>parseMajor('0.0000001'));assert.throws(()=>parseMajor('NaN'));
  assert.match(modelControlsMarkup({language:'en',workspaceId:'ui-test'}),/Model budgets and prices/);assert.match(modelControlsMarkup({language:'zh',workspaceId:'ui-test'}),/模型预算与费率/);
});
test('HTTP controls enforce origin/demo/current versions and persist routing before model connection',async t=>{
  const f=await startFixtureServer({ruleDemo:false});t.after(f.close);const get=async route=>(await fetch(f.base+route)).json();
  const initial=await get('/api/model-controls');assert.equal(initial.available,true);
  const stale=await fetch(f.base+'/api/model-controls/token-limit',{method:'POST',headers:{'content-type':'application/json','x-unprompted-model-workspace':'stale-workspace'},body:JSON.stringify({scope:'workspace',tokens:123})});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'MODEL_CONTROLS_WORKSPACE_CHANGED');assert.equal((await post(f,'/api/model-controls/token-limit',{scope:'workspace',tokens:0},'https://foreign.test')).status,403);
  assert.equal((await post(f,'/api/model-controls/token-limit',{scope:'workspace',tokens:0})).body.controls.token.workspace.limit,0);
  const money=await post(f,'/api/model-controls/money-limit',{scope:'workspace',currency:'USD',micros:1000000,expectedVersion:0});assert.equal(money.status,200);
  assert.equal((await post(f,'/api/model-controls/money-limit',{scope:'workspace',currency:'USD',micros:1000000,expectedVersion:0})).status,409);
  const group={modelIds:['base','strong'],defaultModel:'base',stages:{planning:'strong'},fallbackModel:'strong'};
  const routing=await post(f,'/api/model-controls/routing',{expectedVersion:0,config:group,maxRpcAttempts:2,requestCallLimit:2});assert.equal(routing.status,200);assert.equal((await get('/api/model-controls/routing')).config.defaultModel,'base');
  const bad=await post(f,'/api/model-controls/routing',{expectedVersion:routing.body.version,config:group,maxRpcAttempts:2,requestCallLimit:1});assert.equal(bad.status,400);
  const demo=await startFixtureServer({demo:true});t.after(demo.close);assert.equal((await post(demo,'/api/model-controls/token-limit',{scope:'workspace',tokens:0})).status,409);
});
test('HTTP proposed prices unblock synthetic setup without exposing or prematurely saving credentials',async t=>{
  let calls=0;const models=[];const provider=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls++;models.push(JSON.parse(body).model);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({deliverable:'proposal',subjectEntity:'Cedar',requiredContent:[{text:'sample size and conclusion',sourceQuote:'sample size and conclusion',sourceField:'body'}]})}}],usage:{prompt_tokens:10,completion_tokens:5}}))});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const f=await startFixtureServer({ruleDemo:false});t.after(f.close);const connection={baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'setup-priced',protocol:'chat-completions',apiKey:'synthetic-private-key'};
  await post(f,'/api/model-controls/routing',{expectedVersion:0,config:{modelIds:['different-routed-model'],defaultModel:'different-routed-model',stages:{general:'different-routed-model'}},requestCallLimit:1,maxRpcAttempts:1});
  await post(f,'/api/model-controls/money-limit',{scope:'workspace',currency:'USD',micros:1000000,expectedVersion:0});
  const refused=await post(f,'/api/setup/model',connection);assert.equal(refused.body.code,'MONEY_PROFILE_REQUIRED');assert.equal(calls,0);
  const saved=await post(f,'/api/model-controls/price-profile',{connection,currency:'USD',revision:1,rates:{input:0,output:0,cacheRead:0,cacheWrite:0},expectedVersion:0,confirmed:true});assert.equal(saved.status,200);assert.equal(calls,0);assert.equal(JSON.stringify(saved.body).includes(connection.apiKey),false);
  const connected=await post(f,'/api/setup/model',connection);assert.equal(connected.status,200,JSON.stringify(connected.body));assert.ok(calls>=1);assert.equal(models[0],'setup-priced','synthetic validation checks the proposed model, not an enabled routing group');
});

test('unpriced model calls remain explicitly unknown fees instead of a free-cost claim',async t=>{
  const f=fixture(t,true);await f.reasoner.interpretRequest({subject:'Cedar proposal',body:'Please update the Cedar proposal with experiment results.'},'unpriced-control-view',f.runtime.modelAccountingContext());
  const view=f.controls.describe();assert.equal(view.money.unpricedCalls,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM money_budget_reservations').get().n,0);
  assert.equal(view.token.workspace.settled,15);
});
