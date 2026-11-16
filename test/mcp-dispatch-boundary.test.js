import test from 'node:test';
import assert from 'node:assert/strict';
import {runMcpToolDispatch,guardedMcpSend,guardedMcpFetch} from '../src/mcp-dispatch-boundary.js';
const rpc=(id,name='charge',args={amountMicros:10})=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
const init=message=>({method:'POST',body:JSON.stringify(message)});
test('HTTP grant revoked during SDK await cannot mark or send an external write',async()=>{
 const entry={};let allowed=true,marked=0,sent=0;
 await assert.rejects(runMcpToolDispatch(entry,{name:'charge',args:{amountMicros:10},write:true,isCurrent:()=>allowed,beforeDispatch:()=>marked++},async()=>{
   const message=rpc(1);await guardedMcpSend(entry,message,async()=>{await Promise.resolve();allowed=false;return guardedMcpFetch(entry,'http://local',init(message),()=>{sent++;});});
 }),{code:'MCP_DISPATCH_FENCED'});
 assert.equal(marked,0);assert.equal(sent,0);
});
test('an SDK write retry crosses only one actual fetch boundary',async()=>{
 const entry={};let marked=0,sent=0;
 await assert.rejects(runMcpToolDispatch(entry,{name:'charge',args:{amountMicros:10},write:true,isCurrent:()=>true,beforeDispatch:()=>marked++},async()=>{
  const message=rpc(1);await guardedMcpSend(entry,message,async()=>{
   await guardedMcpFetch(entry,'http://local',init(message),()=>{sent++;return Promise.resolve({status:401});});
   return guardedMcpFetch(entry,'http://local',init(message),()=>{sent++;});
  });
 }),{code:'MCP_DISPATCH_FENCED'});
 assert.equal(marked,1);assert.equal(sent,1);
});
test('concurrent native task calls retain their own request IDs and arguments',async()=>{
 const entry={},seen=[];
 await Promise.all([1,2].map(id=>runMcpToolDispatch(entry,{name:'charge',args:{amountMicros:id},write:true,isCurrent:()=>true,beforeDispatch:()=>seen.push(`mark${id}`)},async()=>{
  const message=rpc(id,'charge',{amountMicros:id});return guardedMcpSend(entry,message,async()=>{await new Promise(r=>setTimeout(r,id===1?10:1));return guardedMcpFetch(entry,'http://local',init(message),()=>seen.push(`send${id}`));});
 })));
 assert.deepEqual([...seen].sort(),['mark1','mark2','send1','send2']);assert.equal(entry.nativeToolDispatches.size,0);
});
test('wrong arguments, batched calls and expired ownership do not send',async()=>{
 const entry={};let sends=0,saved;
 await runMcpToolDispatch(entry,{name:'charge',args:{amountMicros:10},isCurrent:()=>true},async()=>{
  saved=rpc(1);guardedMcpSend(entry,saved,()=>{});
  assert.throws(()=>guardedMcpFetch(entry,'http://local',init(rpc(1,'charge',{amountMicros:100})),()=>sends++),{code:'MCP_DISPATCH_FENCED'});
  assert.throws(()=>guardedMcpFetch(entry,'http://local',init([saved,rpc(2)]),()=>sends++),{code:'MCP_DISPATCH_FENCED'});
 });
 assert.throws(()=>guardedMcpFetch(entry,'http://local',init(saved),()=>sends++),{code:'MCP_DISPATCH_FENCED'});assert.equal(sends,0);
});
test('stdio final boundary marks synchronously and refuses a second write',async()=>{
 const entry={},events=[];
 await runMcpToolDispatch(entry,{name:'charge',args:{amountMicros:10},write:true,isCurrent:()=>true,beforeDispatch:()=>events.push('mark')},async()=>{
  const message=rpc(1);guardedMcpSend(entry,message,()=>events.push('stdin-write'),{stdio:true});
  assert.throws(()=>guardedMcpSend(entry,message,()=>events.push('second'),{stdio:true}),{code:'MCP_DISPATCH_FENCED'});
 });assert.deepEqual(events,['mark','stdin-write']);
});
