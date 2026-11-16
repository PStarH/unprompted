import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {McpManager,McpConfigStore,parseMcpImport} from '../src/mcp.js';
import {SqliteStore} from '../src/durable/store.js';
import {DurableRuntime} from '../src/durable/runtime.js';
import {WorkEngine} from '../src/engine.js';
import {NullReasoner} from '../src/reasoning.js';
import {PermissionPolicy} from '../src/permissions.js';
const tool=name=>({name,description:'Scripted financial operation',inputSchema:{type:'object',properties:{amountMicros:{type:'integer'},currency:{type:'string'}},required:['amountMicros','currency'],additionalProperties:false},annotations:{readOnlyHint:true}});
async function fixture(t,{auth=false}={}) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'unprompted-mcp-money-'));const calls=[],control={drop:false,tools:[tool('charge'),tool('charge_other')]};
 let tokenGate=null,entered;
 const service=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;const message=JSON.parse(raw);
  if(message.id==null){res.writeHead(202);res.end();return;}
  let result;
  if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'financial-fixture',version:'1'}};
  else if(message.method==='tools/list')result={tools:control.tools};
  else if(message.method==='tools/call'){calls.push(message.params);if(control.drop){req.socket.destroy();return;}result={content:[{type:'text',text:'Scripted acceptance'}]};}
  else result={};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });await new Promise(r=>service.listen(0,'127.0.0.1',r));
 const store=new SqliteStore(path.join(directory,'state.json')),engine=new WorkEngine(store,{reasoner:new NullReasoner(),policy:new PermissionPolicy({shadow:false})}),runtime=new DurableRuntime(engine,{tickMs:100000});
 engine.ingest({id:'email:money',type:'email.received',payload:{id:'money',from:'sam@example.test',subject:'Cedar proposal',body:'Please update the Cedar proposal with experiment results.'}});await engine.whenSettled();
 const taskId='request:money';assert.ok(runtime.tasks.get(taskId));
 const grant=engine.autonomy.create({mode:'time',durationMinutes:30,money:{currency:'USD',capMicros:100,durationMinutes:20,confirmed:true}});
 const configStore=new McpConfigStore(path.join(directory,'mcp')),manager=new McpManager({configStore,timeoutMs:1500});
 if(auth)manager.bearerAuth=()=>({token:async()=>{if(tokenGate){entered();await tokenGate;}return 'fixture-token';},onUnauthorized:async()=>{}});
 t.after(async()=>{await manager.close();await runtime.close();await engine.whenSettled();store.close();service.closeAllConnections();await new Promise(r=>service.close(r));fs.rmSync(directory,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${service.address().port}/mcp`;
 await manager.import({mcpServers:{local:{url}}},{allowDeclaredRead:true});
 const declaration={monetaryGrantId:grant.moneyBudget.grantId,amountMicrosPointer:'/amountMicros',currencyPointer:'/currency'};
 await manager.update('local',{writeTools:['charge','charge_other'],financialConfirmed:true,financialTools:{charge:declaration,charge_other:declaration}});

 const exposed=(name='charge',executeWrite=input=>runtime.connectorActions.mcpWrite(input))=>manager.tools({taskId,isCurrent:()=>true,executeWrite}).find(item=>item.label.endsWith(`· ${name}`));
 return {manager,configStore,runtime,engine,store,grant,taskId,calls,control,url,declaration,exposed,gate:()=>{let release;tokenGate=new Promise(r=>{release=r;});return {entered:new Promise(r=>{entered=r;}),release:()=>{tokenGate=null;release();}};}};
}
test('declared financial readOnlyHint tools use the native money and execution ledgers, acceptance stays unknown money',async t=>{
 const c=await fixture(t),value=c.exposed();assert.equal(value.effect,'write');
 assert.match((await value.execute('one',{amountMicros:60,currency:'USD'})).content[0].text,/accepted/);
 assert.equal(c.calls.length,1);assert.equal(c.calls[0].arguments.amountMicros,60);
 const row=c.runtime.ledger.list().find(x=>x.action_family==='mcp.tool');assert.equal(row.status,'accepted');
 const info=c.runtime.transactionMoney.autonomyBudgetInfo(c.grant.moneyBudget.grantId);assert.equal(info.unknownMicros,60);assert.equal(info.remainingMicros,40);
 await value.execute('same',{amountMicros:60,currency:'USD'});assert.equal(c.calls.length,1,'an accepted call is never sent twice');
 await assert.rejects(c.exposed('charge_other').execute('over',{amountMicros:50,currency:'USD'}),{code:'MONEY_BUDGET_EXHAUSTED'});assert.equal(c.calls.length,1);
});
test('currency, missing amount, negative amount and serialized financial contracts cannot authorize a send',async t=>{
 const c=await fixture(t);
 await assert.rejects(c.exposed().execute('currency',{amountMicros:20,currency:'EUR'}),{code:'TRANSFER_CURRENCY_MISMATCH'});
 await assert.rejects(c.exposed().execute('negative',{amountMicros:-1,currency:'USD'}),{code:'TRANSFER_AMOUNT_REQUIRED'});
 await assert.rejects(c.exposed().execute('missing',{currency:'USD'}),/schema/);
 const cloned=c.exposed('charge',input=>c.runtime.connectorActions.mcpWrite({...input,financialContract:JSON.parse(JSON.stringify(input.financialContract))}));
 await assert.rejects(cloned.execute('clone',{amountMicros:10,currency:'USD'}),{code:'MCP_FINANCIAL_CONTRACT_INVALID'});
 assert.equal(c.calls.length,0);
});
test('grant revoked during actual SDK token await cannot cross the HTTP boundary or leave an unknown hold',async t=>{
 const c=await fixture(t,{auth:true}),gate=c.gate();
 const pending=c.exposed().execute('auth-wait',{amountMicros:30,currency:'USD'});const rejected=assert.rejects(pending);
 try {
  const observed=await Promise.race([gate.entered.then(()=>true),pending.then(()=>false,()=>false),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
  assert.equal(observed,true,'actual SDK token wait must be reached');c.engine.autonomy.revoke(c.grant.id);
 }finally{gate.release();}
 await rejected;
 assert.equal(c.calls.length,0);assert.equal(c.runtime.ledger.list()[0].status,'cancelled');
 const usage=c.runtime.transactionMoney.autonomyBudgetInfo(c.grant.moneyBudget.grantId);assert.equal(usage.usedMicros,0);
});
test('removed financial declarations remain unknown writes through reimport and restart',async t=>{
 const c=await fixture(t);await c.manager.update('local',{financialTools:{charge:null,charge_other:null}});
 let exposed=c.exposed();assert.equal(exposed.effect,'write');await assert.rejects(exposed.execute('removed',{amountMicros:10,currency:'USD'}),{code:'TRANSFER_REVIEW_REQUIRED'});
 await c.manager.prepareOAuthServer('local',c.url);
 assert.equal(Object.hasOwn(c.manager.configs.local.financialTools,'charge'),true);
 await c.manager.writeOAuth('local',{clientInformation:{client_id:'fixture-client'}});
 await c.manager.finishOAuth('local');
 assert.equal(c.manager.describe().servers.find(s=>s.id==='local').tools.find(x=>x.name==='charge').writeTool,true);
 assert.equal(c.exposed(),undefined,'fresh sign-in cannot automatically grant a formerly financial read-hint tool');
 await c.manager.update('local',{writeTools:['charge','charge_other']});
 exposed=c.exposed();assert.equal(exposed.effect,'write');await assert.rejects(exposed.execute('signed-in',{amountMicros:10,currency:'USD'}),{code:'TRANSFER_REVIEW_REQUIRED'});
 await c.manager.import({mcpServers:{local:{url:c.url}}},{allowDeclaredRead:true});
 exposed=c.exposed();assert.equal(exposed.effect,'write');await assert.rejects(exposed.execute('imported',{amountMicros:10,currency:'USD'}),{code:'TRANSFER_REVIEW_REQUIRED'});
 const restored=new McpManager({configStore:c.configStore,timeoutMs:1500});t.after(()=>restored.close());await restored.start();
 const info=restored.describe().servers.find(s=>s.id==='local').tools.find(x=>x.name==='charge');assert.equal(info.writeTool,true);assert.equal(info.financial,null);
 assert.throws(()=>parseMcpImport({mcpServers:{new:{url:c.url,financialTools:{charge:c.declaration}}}}),/cannot be imported/);
 assert.equal(c.calls.length,0);
});
test('a changed remote schema invalidates the financial attestation before any provider call',async t=>{
 const c=await fixture(t),entry=c.manager.connections.get('local');entry.tools.find(x=>x.name==='charge').inputSchema={type:'object',properties:{amountMicros:{type:'integer'},currency:{type:'string'},memo:{type:'string'}}};
 assert.equal(c.manager.describe().servers.find(s=>s.id==='local').tools.find(x=>x.name==='charge').financial.current,false);
 await assert.rejects(c.exposed().execute('changed',{amountMicros:10,currency:'USD'}),{code:'TRANSFER_REVIEW_REQUIRED'});assert.equal(c.calls.length,0);
});
test('an accepted response loss holds money and repeating the operation cannot send again',async t=>{
 const c=await fixture(t);c.control.drop=true;
 await assert.rejects(c.exposed().execute('lost',{amountMicros:40,currency:'USD'}));assert.equal(c.calls.length,1);
 assert.equal(c.runtime.transactionMoney.autonomyBudgetInfo(c.grant.moneyBudget.grantId).unknownMicros,40);
 const result=await c.exposed().execute('retry',{amountMicros:40,currency:'USD'});assert.match(result.content[0].text,/unknown/);assert.equal(c.calls.length,1);
});

test('the original model argument object cannot change the approved wire amount during an await',async t=>{
 const c=await fixture(t),args={amountMicros:10,currency:'USD'};
 const pending=c.exposed().execute('snapshot',args);args.amountMicros=99;await pending;
 assert.equal(c.calls[0].arguments.amountMicros,10);assert.equal(c.runtime.transactionMoney.autonomyBudgetInfo(c.grant.moneyBudget.grantId).unknownMicros,10);
});
test('an execution callback cannot mutate the native argument snapshot before billing and send',async t=>{
 const c=await fixture(t),exposed=c.exposed('charge',input=>{input.args.amountMicros=99;return c.runtime.connectorActions.mcpWrite(input);});
 await assert.rejects(exposed.execute('mutate',{amountMicros:10,currency:'USD'}),TypeError);assert.equal(c.calls.length,0);
});

test('financial declarations require explicit confirmation and removal cannot restore read access',async t=>{
 const c=await fixture(t);
 await assert.rejects(c.manager.update('local',{financialTools:{charge:c.declaration}}),error=>error.status===403);
 await c.manager.update('local',{financialTools:{charge:null,charge_other:null},writeTools:[]});
 const tool=c.manager.describe().servers.find(s=>s.id==='local').tools.find(x=>x.name==='charge');assert.equal(tool.writeTool,true);assert.equal(tool.allowed,false);
 assert.ok(!c.manager.tools({taskId:c.taskId,isCurrent:()=>true}).some(x=>x.label.endsWith('· charge')));assert.equal(c.calls.length,0);
});
