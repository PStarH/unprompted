import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startFixtureServer({ demo: true, serverEnv: { UNPROMPTED_DEMO_MEMORY_COUNT: '100' } });
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/quiet-overview';
fs.mkdirSync(output, { recursive: true });
const checks = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base);
  await page.locator('#taskContent [data-select-task]').first().waitFor();
  assert.equal(await page.locator('#taskContent').getAttribute('data-mode'), 'field');
  assert.equal(await page.locator('#viewHome [data-workspace-mode]').count(), 0);
  assert.equal(await page.locator('#viewHome [role="tablist"]').count(), 0);
  assert.equal(await page.locator('.navigation [data-view="attention"]').count(), 0);
  assert.equal(await page.locator('#taskStatusFilter').inputValue(), 'all');
  await page.locator('#homeCounts [data-count-filter="working"]').click();
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  await page.locator('#homeCounts [data-count-filter="all"]').click();
  await page.goto(fixture.base + '/#attention');
  await page.waitForFunction(() => document.querySelector('#taskStatusFilter')?.value === 'attention');
  assert.equal(await page.locator('#viewAttention').isVisible(), false);
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  await page.locator('[data-view="memory"]').click();
  await page.keyboard.press('n');
  await page.waitForFunction(() => location.hash === '#home' && document.querySelector('#taskStatusFilter')?.value === 'attention');
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  await page.locator('[data-view="home"]').click();
  assert.equal(await page.locator('#taskStatusFilter').inputValue(), 'all');
  assert.equal(await page.locator('#taskContent .ws-inspector, .ws-workbench-detail').count(), 0);
  const taskId = await page.locator('#taskContent [data-select-task]').first().getAttribute('data-select-task');
  await page.screenshot({ path: `${output}/field-cards-desktop.png`, animations: 'disabled' });
  await page.locator('#taskContent [data-select-task]').first().click();
  await page.locator('.ws-detail-drawer .ws-inspector').waitFor();
  await page.locator('.ws-detail-drawer textarea').fill('还没有提交的方向');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.ws-detail-drawer').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.selectTask), taskId);
  await page.request.post(`${fixture.base}/api/tasks/${encodeURIComponent(taskId)}/pause`, { data: {} });
  await page.waitForFunction(id => document.querySelector(`[data-task-card="${CSS.escape(id)}"]`)?.dataset.state === 'paused_by_user', taskId);
  assert.equal(await page.locator('.ws-detail-drawer').count(), 0);
  await page.locator('#taskContent [data-select-task]').first().click();
  assert.equal(await page.locator('.ws-detail-drawer textarea').inputValue(), '还没有提交的方向');
  await page.keyboard.press('Escape');
  checks.push('task cards open details explicitly; close retains drafts and live updates never reopen them');

  await page.locator('[data-view="memory"]').click();
  assert.equal(await page.locator('.memory-inspector').count(), 0);
  assert.equal(await page.locator('[data-memory-cluster]').count(), 10);
  const state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.taskMemories.length, 100);
  assert.equal(state.taskMemories.every(memory => memory.origin === 'demo_preview'), true);
  assert.equal(await page.locator('.memory-summary .memory-stat strong').first().textContent(), '100');
  assert.equal(await page.locator('.memory-demo-note').isVisible(), true);
  await page.screenshot({ path: `${output}/memory-100-desktop.png`, animations: 'disabled' });
  await page.locator('[data-memory-cluster]').first().click();
  assert.equal(await page.locator('.memory-inspector .ws-memory').count(), 10);
  assert.equal(await page.locator('.memory-inspector [data-open-task]').count(), 0);
  await page.screenshot({ path: `${output}/memory-100-open.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.memory-inspector').count(), 0);
  await page.locator('[data-memory-view="library"]').click();
  assert.equal(await page.locator('.memory-record').count(), 100);
  assert.equal(await page.locator('.memory-record[open]').count(), 0);
  await page.locator('[data-memory-search]').fill('退改');
  assert.equal(await page.locator('.memory-record').count(), 1);
  await page.locator('.memory-record > summary').click();
  await page.locator('.memory-record [data-memory-operation="edit"]').click();
  await page.locator('[data-memory-edit] textarea').fill('出行预订前核对退改规则与最晚取消时间。');
  await page.locator('[data-memory-edit] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.memory-record .ws-memory-content > p')?.textContent.includes('最晚取消时间'));
  assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).taskMemories.length, 100);
  await page.locator('[data-memory-search]').fill('');
  await page.locator('[data-memory-view="space"]').click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('[data-memory-cluster]').count(), 10);
    assert.equal(await page.locator('.memory-inspector').count(), 0);
    if (width === 390) await page.screenshot({ path: `${output}/memory-100-mobile.png`, animations: 'disabled' });
  }
  checks.push('100 labeled demo memories use ten visible groups, searchable collapsed library records and real edit persistence');

  for (const mode of ['field', 'index', 'lanes', 'spotlight', 'pulse']) {
    await page.locator('[data-view="preferences"]').click();
    assert.equal(await page.locator('#workspaceViewOptions option').count(), 5);
    await page.selectOption('#workspaceViewOptions', mode);
    await page.locator('[data-view="home"]').click();
    assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
    await page.locator('#taskContent [data-select-task]').first().click();
    assert.equal(await page.locator('#taskContent .ws-inspector').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#taskContent')?.dataset.mode === 'pulse');
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  checks.push('five views are selected only in settings, remember the preference and never open a task on reload');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} finally {
  await browser.close();
  await fixture.close();
}
