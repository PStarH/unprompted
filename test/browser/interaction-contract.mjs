import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const fixture = process.env.UNPROMPTED_BROWSER_BASE_URL ? null : await startFixtureServer();
const base = process.env.UNPROMPTED_BROWSER_BASE_URL || fixture.base;
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/human-ux-validation';
fs.mkdirSync(output, { recursive: true });
const browser=await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true })
  .catch(async error => { await fixture?.close(); throw error; });
const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
const errors=[], checks=[], posts=[];
page.on('pageerror', error=>errors.push(error.message));
page.on('request', req=>{if(req.method()==='POST') posts.push(req.url());});
await page.addInitScript(()=>{
  window.__streams=[];
  window.EventSource=class { constructor(){ window.__streams.push(this); setTimeout(()=>this.onopen?.(),0); } close(){} };
});
const record=id=>checks.push({id,passed:true});
let state;
async function emit(mutate=()=>{}) {
  mutate(state); state.revision++;
  await page.evaluate(state=>window.__streams.at(-1).onmessage({data:JSON.stringify(state)}),state);
}
try {
 // This contract replaces SSE to control individual live updates. Wait for
 // the isolated server's first task before the one initial HTTP snapshot;
 // otherwise a fast browser can load before the scheduled email arrives.
 if (fixture) {
   const deadline = Date.now() + 10_000;
   let seeded = false;
   while (Date.now() < deadline) {
     const snapshot = await (await fetch(base + '/api/state')).json();
     if (snapshot.tasks.length) { seeded = true; break; }
     await new Promise(resolve => setTimeout(resolve, 100));
   }
   assert.equal(seeded, true, 'The isolated interaction fixture must contain its initial task.');
 }
 await page.goto(base,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>window.__streams.length && document.querySelector('#taskContent [data-task-card]'));
 state=await(await page.request.get(base+'/api/state')).json();
 assert.equal(state.mode, 'simulation', 'Run this fixture check only against an isolated simulation server.');
 const original=structuredClone(state.tasks[0]);
 const make=(id,score)=>{
   const t=structuredClone(original);
   Object.assign(t,{id,subject:`${id} · 项目跟进`,status:'waiting_for_information',action:null,wait:null});
   t.management.priority.score=score;
   t.management.wake={kind:'reply',status:'waiting'};
   t.management.nextAction={kind:'wait',label:'Wait for evidence'};
   return t;
 };
 const a=make('human-a',90), b=make('human-b',50);
 const dependency={id:'dep:human',label:'补充样本量',status:'open',taskIds:[a.id,b.id]};
 a.management.dependencies=[dependency]; b.management.dependencies=[dependency];
 state.tasks=[a,b]; state.notifications=[];
 await emit();
 assert.equal(await page.locator('#taskContent .wait-form').count(),0);
 await page.locator('[data-dependency-answer="dep:human"]').fill('这段答案还没有提交：1200');
 await page.locator('[data-dependency-answer="dep:human"]').evaluate(el=>el.setSelectionRange(3,6));
 await emit(s=>{s.tasks[0].management.dependencies[0].label='补充样本量及来源';});
 assert.equal(await page.locator('[data-dependency-answer="dep:human"]').inputValue(),'这段答案还没有提交：1200');
 assert.deepEqual(await page.locator('[data-dependency-answer="dep:human"]').evaluate(el=>[el.selectionStart,el.selectionEnd,document.activeElement===el]),[3,6,true]);
 record('shared-answer-and-selection-survive-live-update');
 await page.locator('#taskContent [data-open-task="human-a"]').first().click();
 const wait=page.locator('#taskDialog [data-wait-form="human-a"]');
 await wait.locator('select').selectOption('time');
 await wait.locator('input').fill('2026-10-29T15:45');
 await wait.locator('input').focus();
 await emit(s=>{s.tasks[0].management.priority.score=20; s.tasks[0].updatedAt=new Date().toISOString();});
 assert.equal(await wait.locator('select').inputValue(),'time');
 assert.equal(await wait.locator('input').inputValue(),'2026-10-29T15:45');
 assert.equal(await wait.locator('input').isVisible(),true);
 assert.equal(await wait.locator('input').evaluate(el=>document.activeElement===el),true);
 record('wait-draft-and-focus-survive-live-update');
 const detail=page.locator('#taskDialog details[data-preserve^="full-evidence-"]');
 await detail.locator(':scope > summary').click();
 const note=page.locator('#taskDialog [data-reason-for="human-a"]');
 await note.fill('还在输入中文');
 await note.dispatchEvent('compositionstart',{data:'输入'});
 const retained=await note.elementHandle();
 await emit(s=>{s.tasks[0].management.nextAction={kind:'verify',label:'Verify'};});
 assert.equal(await retained.evaluate(el=>el.isConnected),true,'IME composition must not lose its node');
 await note.dispatchEvent('compositionend',{data:'输入'});
 assert.equal(await note.inputValue(),'还在输入中文');
 assert.match(await page.locator('#taskDialog .management-line').innerText(),/核实结果/);
 assert.equal(await detail.evaluate(el=>el.open),true);
 record('chinese-composition-defers-render-and-then-catches-up');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('#taskDialog').open);
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.openTask),'human-a');
 record('closing-refreshed-details-restores-task-focus');
 const order=await page.locator('#taskContent > [data-task-card]').evaluateAll(nodes=>nodes.map(n=>n.dataset.taskCard));
 await emit(s=>{s.tasks[1].management.priority.score=120; s.tasks.push(make('human-new',150));});
 assert.deepEqual(await page.locator('#taskContent > [data-task-card]').evaluateAll(nodes=>nodes.map(n=>n.dataset.taskCard)),[...order,'human-new']);
 record('priority-changes-and-arrivals-do-not-move-existing-tasks');
 const ready=make('human-ready',180);ready.status='ready_for_approval';
 ready.reviewToken='a'.repeat(64);
 ready.draft={to:'review@example.test',subject:'Re: 项目跟进',body:'这是一段待审阅的原始回复。\n保留用户的原文。',documentVersion:original.assessment?.documentVersion||1};
 ready.management.nextAction={kind:'approve'};
 await emit(s=>{s.tasks.push(ready);});
 await page.locator('#agentStatus [data-go="attention"]').click();
 assert.equal(await page.locator('#viewAttention').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H1');
 record('overview-decision-entry-has-a-clear-destination-and-focus');
 await page.route('**/api/state',route=>route.fulfill({json:state}));
 let reviewedToken;
 await page.route('**/api/tasks/human-ready/approve',route=>{ reviewedToken=route.request().postDataJSON().reviewToken; return route.abort('failed'); });
 await page.locator('#decisionDeckCurrent [data-action="approve"]').click();
 await page.locator('#decisionDeckCurrent .action-error').waitFor();
 assert.match(await page.locator('#decisionDeckCurrent .action-error').innerText(),/还没确认这次操作的结果/);
 assert.equal(await page.locator('#decisionDeckCurrent [data-action="approve"]').isDisabled(),true);
 record('interrupted-send-stays-uncertain-and-blocks-blind-repeat');
 assert.equal(reviewedToken, ready.reviewToken);
 record('send-carries-the-rendered-reply-review-token');
 await page.selectOption('#languageSelect','en');
 assert.match(await page.locator('#decisionDeckCurrent .action-error').innerText(),/outcome is not confirmed/);
 assert.match(await page.locator('#decisionDeckCurrent').innerText(),/这是一段待审阅的原始回复/);
 record('language-change-translates-controls-and-preserves-source-text');
 await page.screenshot({path:output+'/decisions-en-1440.png',fullPage:true,animations:'disabled'});
 await page.locator('#decisionDeckCurrent [data-sync-state]').click();
 await page.waitForFunction(()=>!document.querySelector('#decisionDeckCurrent .action-error'));
 assert.equal(await page.locator('#decisionDeckCurrent [data-action="approve"]').isDisabled(),false);
 assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),false);
 record('explicit-state-sync-recovers-controls-without-resending');
 await page.unroute('**/api/tasks/human-ready/approve');
 await page.route('**/api/tasks/human-ready/approve',async route=>{
   assert.equal(route.request().postDataJSON().reviewToken,ready.reviewToken);
   await emit(s=>{const t=s.tasks.find(t=>t.id==='human-ready');t.draft.body+='\n这是新的准备内容。';t.reviewToken='b'.repeat(64);});
   await route.fulfill({status:409,json:{code:'REVIEW_CHANGED',error:'The prepared reply changed. Review the updated reply before sending.'}});
 });
 await page.locator('#decisionDeckCurrent [data-action="approve"]').click();
 await page.waitForFunction(()=>document.querySelector('#decisionDeckCurrent .action-error')?.textContent.includes('Nothing was sent this time.'));
 assert.equal(await page.locator('#decisionDeckCurrent [data-action="approve"]').isDisabled(),false);
 assert.match(await page.locator('#decisionDeckCurrent .draft-excerpt').innerText(),/这是新的准备内容/);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'decisionDeckTitle');
 record('review-conflict-shows-no-send-and-the-updated-reply-without-an-extra-approval');
 await page.locator('[data-view="home"]').click();
 await page.screenshot({path:output+'/after-en-1440.png',fullPage:true,animations:'disabled'});
 await page.selectOption('#languageSelect','zh-CN');
 await page.screenshot({path:output+'/after-zh-1440.png',fullPage:true,animations:'disabled'});
 await page.locator('#taskContent [data-proof="human-a"]').click();
 assert.equal(await page.locator('#evidencePeek').isVisible(),true);
 for(let step=0;step<30 && await page.locator('#evidencePeek').isVisible();step++) await page.keyboard.press('Tab');
 assert.equal(await page.locator('#evidencePeek').isVisible(),false);
 record('evidence-peek-closes-when-keyboard-focus-leaves');
 await page.evaluate(async()=>{
   const {preserveInteraction}=await import('/dom-state.js');
   const root=document.createElement('section');root.id='temporary-contract-root';document.body.append(root);
   const html=context=>`<form data-demo-form="fixture"><input name="clientJson" type="file" accept="application/json"><input type="checkbox" data-patch-confirm="fixture" data-preserve-context="${context}"><button data-patch-apply="fixture" data-patch-id="fixture" disabled>Apply</button></form>`;
   root.innerHTML=html('version:1');
   window.__preserveFixture={root,html,preserveInteraction};
 });
 await page.locator('#temporary-contract-root input[type="file"]').setInputFiles({name:'local-client.json',mimeType:'application/json',buffer:Buffer.from('{"fixture":true}')});
 await page.locator('#temporary-contract-root input[type="checkbox"]').check();
 await page.evaluate(()=>{
   const {root,html,preserveInteraction}=window.__preserveFixture;
   const file=root.querySelector('input[type="file"]');
   preserveInteraction(root,()=>root.innerHTML=html('version:1'));
   if(root.querySelector('input[type="file"]')!==file || file.files[0].name!=='local-client.json') throw new Error('File selection lost');
   if(!root.querySelector('input[type="checkbox"]').checked || root.querySelector('button').disabled) throw new Error('Same-version review lost');
   preserveInteraction(root,()=>root.innerHTML=html('version:2'));
   if(root.querySelector('input[type="checkbox"]').checked || !root.querySelector('button').disabled) throw new Error('Review leaked to a new version');
   root.remove();delete window.__preserveFixture;
 });
 record('local-file-pick-survives-refresh-and-consent-never-crosses-versions');
 const responsive=[];
 for(const width of [390,768,1280,1440]){
  await page.setViewportSize({width,height:900});
  for(const language of ['zh-CN','en']){
   await page.selectOption('#languageSelect',language);
   for(const view of ['home','attention','sources','preferences']){
    await page.locator(`[data-view="${view}"]`).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}/${language}/${view} overflows`);
    responsive.push({width,language,view,passed:true});
   }
  }
 }
 await page.setViewportSize({width:390,height:844});
 await page.selectOption('#languageSelect','zh-CN');
 await page.locator('[data-view="home"]').click();
 await page.screenshot({path:output+'/after-zh-390.png',fullPage:true,animations:'disabled'});
 record('32-responsive-language-view-combinations-have-no-page-overflow');
 assert.equal(posts.length,2,'browsing, editing, language changes and live updates never submit work');
 assert.deepEqual(errors,[]);
 record('no-browser-runtime-errors-or-unintended-submissions');
 fs.writeFileSync(output+'/responsive.json',JSON.stringify(responsive,null,2));
} catch(error){
 checks.push({id:'failure',passed:false,message:error.message,stack:error.stack});
 await page.screenshot({path:output+'/failure.png',fullPage:true,animations:'disabled'});
 process.exitCode=1;
} finally {
 fs.writeFileSync(output+'/browser-contract.json',JSON.stringify({checks,errors,posts},null,2));
 console.log(JSON.stringify({checks,errors,posts},null,2));
 await browser.close();
 await fixture?.close();
}
