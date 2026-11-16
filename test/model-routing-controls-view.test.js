import test from 'node:test';
import assert from 'node:assert/strict';
import { routingMeasurementsMarkup } from '../public/model-controls.js';
const group={stage:'planning',routingVersion:3,model:'wire-model',protocol:'responses',attempts:2,failures:1,avgDurationMs:12.4,knownTokens:null,usageUnknownCalls:2};
const summary={available:true,totals:{attempts:2,successes:1,failures:1,knownTokens:null,usageUnknownCalls:2},groups:[group],truncated:false,observationStatus:{writeFailures:0,lastFailure:null}};
test('routing view keeps unknown usage unknown and displays actual wire model/config/stage',()=>{
 const html=routingMeasurementsMarkup(summary,'en');assert.match(html,/wire-model/);assert.match(html,/Planning \/ 3/);assert.match(html,/<td data-known-tokens>Unknown<\/td>/);assert.match(html,/<span data-known-tokens-total>Unknown<\/span>/);assert.match(html,/separate from the daily budgets/);assert.match(html,/Output quality requires separate evaluation/);
});
test('trusted explicit zero remains known zero while unavailable observation is distinct',()=>{
 const html=routingMeasurementsMarkup({...summary,totals:{...summary.totals,knownTokens:0},groups:[{...group,knownTokens:0,usageUnknownCalls:0}]},'en');assert.match(html,/<td data-known-tokens>0<\/td>/);assert.match(routingMeasurementsMarkup({available:false},'en'),/Observations are currently unavailable/);
});
test('diagnostics escape model/code metadata, limit visible groups, and localize Chinese labels',()=>{
 const html=routingMeasurementsMarkup({...summary,groups:Array.from({length:25},()=>({...group,model:'<img src=x onerror=alert(1)>'})),observationStatus:{writeFailures:1,lastFailure:{code:'<unsafe>',at:'now'}}},'zh');assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/&lt;unsafe&gt;/);assert.match(html,/显示前20组/);assert.match(html,/未知/);assert.match(html,/观测写入失败/);assert.equal((html.match(/<td data-known-tokens>/g)||[]).length,20);
});
