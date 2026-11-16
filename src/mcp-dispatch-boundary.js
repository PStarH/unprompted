import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
const context=new AsyncLocalStorage();
const denied=message=>Object.assign(new Error(message),{code:'MCP_DISPATCH_FENCED',status:409});
function current(scope,message) {
  if(!scope || scope.closed || scope.isCurrent()!==true || message?.method!=='tools/call' || message.params?.name!==scope.name || !isDeepStrictEqual(message.params?.arguments || {},scope.args)) throw denied('MCP task, tool arguments or authorization changed before transport dispatch.');
}
function cross(scope,message) {
  current(scope,message);
  if(scope.write) {
    if(scope.used || typeof scope.beforeDispatch!=='function')throw denied('A single native write dispatch permit is required.');
    scope.beforeDispatch();scope.used=true;
  }
}
/** SDK awaits retain native ownership; detached or timed-out callbacks lose it. */
export async function runMcpToolDispatch(entry,{name,args,isCurrent,beforeDispatch=null,write=false},invoke) {
  const scope={entry,name,args,isCurrent,beforeDispatch,write,used:false,closed:false,ids:new Set()};
  try{return await context.run(scope,invoke);}finally{
    scope.closed=true;for(const id of scope.ids)if(entry.nativeToolDispatches?.get(id)===scope)entry.nativeToolDispatches.delete(id);
  }
}
/** Pinned stdio2.4 send writes stdin synchronously; HTTP waits until fetch. */
export function guardedMcpSend(entry,message,send,{stdio=false}={}) {
  if(message?.method==='tools/call') {
    const scope=context.getStore();current(scope,message);
    if(scope.entry!==entry || message.id==null)throw denied('MCP request ownership is missing.');
    entry.nativeToolDispatches ||= new Map();const existing=entry.nativeToolDispatches.get(message.id);
    if(existing && existing!==scope)throw denied('Another task owns this MCP request ID.');
    entry.nativeToolDispatches.set(message.id,scope);scope.ids.add(message.id);
    if(stdio)cross(scope,message);
  }
  return send(message);
}
/** Called immediately before actual fetch, after SDK token/transport awaits. */
export function guardedMcpFetch(entry,input,init,fetchImpl) {
  let parsed;
  try{if(typeof init?.body==='string')parsed=JSON.parse(init.body);}catch{
    if(context.getStore()?.write)throw denied('An inspectable MCP tool request is required before a write.');
  }
  const messages=Array.isArray(parsed)?parsed:[parsed],calls=messages.filter(m=>m?.method==='tools/call');
  if(calls.length) {
    if(calls.length!==1)throw denied('A write permit cannot cover batched MCP tool calls.');
    const message=calls[0],scope=entry.nativeToolDispatches?.get(message.id);
    if(!scope || scope.entry!==entry)throw denied('MCP request ownership expired before fetch.');
    init?.signal?.throwIfAborted();cross(scope,message);
  } else if(context.getStore()?.write && String(init?.method || 'GET').toUpperCase()==='POST' && !parsed) {
    throw denied('An inspectable MCP tool request is required before a write.');
  }
  return fetchImpl(input,init);
}
