import { createHash } from 'node:crypto';
const nativeContracts = new WeakMap();
const fail = (message,status=400) => Object.assign(new Error(message),{code:'MCP_FINANCIAL_CONTRACT_INVALID',status});
export const validMoneyPointer = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && value.startsWith('/')
  && !/[\u0000]/.test(value) && !/~(?![01])/.test(value) && value.split('/').slice(1).every(part=>!['__proto__','constructor','prototype'].includes(part.replaceAll('~1','/').replaceAll('~0','~')));
const fields=['monetaryGrantId','amountMicrosPointer','currencyPointer'];
export function financialInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!fields.includes(k))
    || typeof value.monetaryGrantId !== 'string' || !value.monetaryGrantId || value.monetaryGrantId.length>200
    || !validMoneyPointer(value.amountMicrosPointer) || !validMoneyPointer(value.currencyPointer) || value.amountMicrosPointer===value.currencyPointer) throw fail('Choose a funds allowance and distinct exact amount-in-micros and currency argument pointers.');
  return Object.fromEntries(fields.map(k=>[k,value[k]]));
}
export function normalizeFinancialTools(value={}) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length>1024) throw fail('Invalid saved MCP financial declarations.');
  return Object.fromEntries(Object.entries(value).map(([name,item])=>{
    if (name && name.length<=4096 && !['__proto__','constructor','prototype'].includes(name) && item===null) return [name,null];
    if (!name || name.length>4096 || ['__proto__','constructor','prototype'].includes(name) || !item || Object.keys(item).some(k=>![...fields,'schemaDigest','configIdentity','connectionIdentity'].includes(k))) throw fail('Invalid saved MCP financial declaration.');
    const input=financialInput(Object.fromEntries(fields.map(k=>[k,item[k]])));
    for(const key of ['schemaDigest','configIdentity','connectionIdentity']) if(typeof item[key]!=='string' || !/^[a-f0-9]{64}$/.test(item[key]))throw fail('Financial declarations require native schema and connection identity.');
    return [name,{...input,schemaDigest:item.schemaDigest,configIdentity:item.configIdentity,connectionIdentity:item.connectionIdentity}];
  }));
}
export function mintMcpFinancialContract(data,isCurrent) {
  if(typeof isCurrent!=='function' || isCurrent()!==true)throw fail('The MCP financial declaration is no longer current.',409);
  const capability=Object.freeze({});nativeContracts.set(capability,{data:Object.freeze({...data}),isCurrent});return capability;
}
export function readMcpFinancialContract(capability,{serverId,tool,schemaDigest}) {
  const native=nativeContracts.get(capability);
  if(!native || native.isCurrent()!==true || native.data.serverId!==serverId || native.data.tool!==tool || native.data.schemaDigest!==schemaDigest) throw fail('An exact current native MCP financial declaration is required.',403);
  return native.data;
}
export const financialContractDigest = value => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])))).digest('hex');
