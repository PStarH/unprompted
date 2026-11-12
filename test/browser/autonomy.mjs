import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/autonomy';
fs.mkdirSync(output, { recursive: true });
const fixture = await startFixtureServer();
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
  const controls = page.locator('#taskContent details').filter({ has: page.locator('[data-yolo-task]') });
  await controls.locator('summary').click();
  await controls.locator('[data-yolo-task]').click();
  await page.waitForFunction(async taskId => {
    const state = await (await fetch('/api/state')).json();
    return state.tasks.find(task => task.id === taskId)?.status === 'completed';
  }, id);
  let state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.tasks.find(task => task.id === id).action.permission, 'temporary_yolo');
  assert.equal(state.autonomy.grants.length, 0);

  await page.locator('[data-view="preferences"]').click();
  await page.locator('#grantContent details summary').click();
  await page.locator('#grantContent input[name="durationMinutes"]').fill('45');
  await page.locator('#grantContent [data-yolo-time] button').click();
  await page.locator('#autonomyStatus [data-yolo-revoke]').waitFor();
  state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.autonomy.grants[0].mode, 'time');
  assert.ok(Date.parse(state.autonomy.grants[0].expiresAt) - Date.now() > 44 * 60000);
  await page.reload();
  await page.locator('#autonomyStatus [data-yolo-revoke]').waitFor();
  await page.screenshot({ path: `${output}/time-yolo.png`, fullPage: true });
  await page.locator('#autonomyStatus [data-yolo-revoke]').click();
  await page.locator('#autonomyStatus').waitFor({ state: 'hidden' });
  state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.autonomy.grants.length, 0);
  assert.deepEqual(errors, []);
  console.log('Passed: task YOLO, custom time YOLO, reload persistence, visible status and revoke.');
} finally {
  await browser?.close();
  await fixture.close();
}
