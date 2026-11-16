import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/autonomy';
fs.mkdirSync(output, { recursive: true });
const fixture = await startFixtureServer({ serverEnv:{ UNPROMPTED_STORAGE:'sqlite' } });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base);
  await page.locator('#taskContent [data-select-task]').first().click();
  await page.locator('#taskContent [data-action="approve"]').waitFor();
  const id = await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task');
  // The detail view keeps hidden copies of the follow-up panel for the other
  // focus sections. Scope to the visible overview of the selected task and
  // require the control to be unique instead of masking duplicates.
  const yolo = page.locator(`#taskContent .ws-inspector[data-inspector-task="${id}"] .ws-detail-main details.management-explanation[data-preserve="yolo-${id}"]:visible`);
  assert.equal(await yolo.count(), 1, 'expected exactly one visible YOLO control in the current task overview');
  // Narrow layout: the hidden focus-panel copies stay in the DOM, so the
  // control must remain uniquely reachable and expandable at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await yolo.count(), 1, 'expected exactly one visible YOLO control at narrow width');
  assert.equal(await yolo.locator(':scope > summary').count(), 1, 'expected one directly owned YOLO summary at narrow width');
  await yolo.locator(':scope > summary').click();
  assert.equal(await yolo.locator('[data-yolo-task]').isVisible(), true, 'expected the YOLO button to be visible once expanded at narrow width');
  await yolo.locator(':scope > summary').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await yolo.locator(':scope > summary').click();
  await yolo.locator('[data-yolo-task]').click();
  await page.waitForFunction(async taskId => {
    const state = await (await fetch('/api/state')).json();
    return state.tasks.find(task => task.id === taskId)?.status === 'completed';
  }, id);
  let state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.tasks.find(task => task.id === id).action.permission, 'temporary_yolo');
  assert.equal(state.autonomy.grants.length, 0);

  // Return to the workspace after the task page completes. While a task page is
  // open the global autonomy banner is suppressed by the workspace layout, so a
  // visible-banner assertion only applies after this user-visible back step.
  await page.locator('#taskContent [data-close-inspector]').click();
  await page.locator('[data-view="preferences"]').click();
  // Preferences is split into focus sections; the workspace YOLO controls live
  // in Follow-up & notifications, while Model is selected by default.
  await page.locator('#viewPreferences').getByRole('tab', { name: 'Follow-up & notifications', exact: true }).click();
  await page.locator('#grantContent details > summary').click();
  await page.locator('#grantContent input[name="durationMinutes"]').fill('45');
  await page.locator('#grantContent [data-yolo-time] button').click();
  await page.locator('#autonomyStatus [data-yolo-revoke]').waitFor();
  state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.autonomy.grants[0].mode, 'time');
  assert.ok(Date.parse(state.autonomy.grants[0].expiresAt) - Date.now() > 44 * 60000);
  assert.equal(state.autonomy.grants[0].moneyBudget.capMicros, 0);
  const cumulativeId = state.autonomy.grants[0].moneyBudget.grantId;
  const moneyForm = page.locator('#grantContent [data-yolo-time]');
  await moneyForm.locator('[name="moneyMajor"]').fill('1.25');
  await moneyForm.locator('[name="moneyConfirmed"]').check();
  await moneyForm.locator('[name="moneyCurrency"]').selectOption('CNY');
  assert.equal(await moneyForm.locator('[name="moneyConfirmed"]').isChecked(), false, 'changing monetary inputs invalidates confirmation');
  await moneyForm.locator('[name="moneyCurrency"]').selectOption('USD');
  await moneyForm.locator('[name="moneyMinutes"]').fill('20');
  await moneyForm.locator('[name="moneyConfirmed"]').check();
  assert.equal(await moneyForm.locator('[name="moneyMajor"]').inputValue(),'1.25');
  const savedMoney = page.waitForResponse(response=>response.url().endsWith('/api/autonomy') && response.request().method()==='POST');
  await moneyForm.locator('button[type="submit"]').click();
  const savedResponse = await savedMoney;
  assert.equal(savedResponse.status(),200,await savedResponse.text());
  assert.equal((await savedResponse.json()).grant.moneyBudget.capMicros,1250000);
  await page.waitForFunction(async () => (await (await fetch('/api/state')).json()).autonomy.grants[0]?.moneyBudget?.capMicros === 1250000);
  state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.autonomy.grants[0].moneyBudget.grantId, cumulativeId);
  assert.equal(state.autonomy.grants[0].moneyBudget.remainingMicros, 1250000);
  assert.equal(state.autonomy.grants[0].moneyBudget.unknownMicros, 0);
  await page.setViewportSize({ width:390, height:844 });
  await page.screenshot({ path:`${output}/money-yolo-en-narrow.png`, fullPage:true });
  await page.reload();
  await page.locator('#autonomyStatus [data-yolo-revoke]').waitFor();
  state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.autonomy.grants[0].moneyBudget.capMicros,1250000);
  await page.screenshot({ path: `${output}/time-yolo.png`, fullPage: true });
  await page.evaluate(()=>localStorage.setItem('unprompted:language','zh-CN'));
  await page.reload();
  await page.locator('[data-view="preferences"]').click();
  await page.locator('#viewPreferences').getByRole('tab',{name:'自动跟进与提醒',exact:true}).click();
  const chinese = page.locator('#grantContent details');
  if(!await chinese.evaluate(el=>el.open))await chinese.locator(':scope > summary').click();
  assert.match(await chinese.innerText(),/资金累计上限/);
  await page.screenshot({path:`${output}/money-yolo-zh-narrow.png`,fullPage:true});
  await page.locator('#autonomyStatus [data-yolo-revoke]').click();
  await page.locator('#autonomyStatus').waitFor({ state: 'hidden' });
  state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.autonomy.grants.length, 0);
  assert.deepEqual(errors, []);
  console.log('Passed: narrow-width locator, task YOLO, custom time YOLO, reload persistence, confirmed cumulative money caps, bilingual narrow layout, visible status and revoke.');
} finally {
  await browser?.close();
  await fixture.close();
}
