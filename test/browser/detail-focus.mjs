import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { SqliteStore } from '../../src/durable/store.js';
import { seedMemoryExplorerStore } from '../fixtures/memory-explorer.js';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/detail-focus';
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-detail-focus-'));
const store = new SqliteStore(path.join(directory, 'state.json'));
seedMemoryExplorerStore(store, 100); store.close();
const fixtures = [];
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || 'chrome', headless: true });
const errors = [];
async function checkTabs(page, host, name, width) {
  const tabs = host.locator('.detail-focus-navigation [role=tab]');
  await tabs.first().waitFor();
  const count = await tabs.count();
  for (let i = 0; i < count; i++) {
    await tabs.nth(i).click();
    assert.equal(await tabs.nth(i).getAttribute('aria-selected'), 'true');
    assert.equal(await host.locator('.detail-focus-navigation [aria-selected=true]').count(), 1);
    const panels = (await tabs.nth(i).getAttribute('aria-controls')).split(' ');
    for (const id of panels) {
      const panel = page.locator(`[id="${id}"]`);
      assert.equal(await panel.isVisible(), true, `${name}: ${id} visible`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: overflow at ${width}`);
    await page.screenshot({ path: `${output}/${name}-${i}-${width}.png`, fullPage: true });
  }
  await tabs.first().click();
  await tabs.first().press('ArrowRight');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  await tabs.nth(1).press('Home');
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
}
try {
  const fixture = await startFixtureServer({ ruleDemo: false, directory }); fixtures.push(fixture);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base + '/#memory');
  await page.locator('[data-memory-search]').fill('What is the budget for Cedar?');
  await page.locator('.memory-search-result[data-memory-id="budget-current"] [data-memory-focus]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-context') && !document.querySelector('.memory-inspector-context [role=status]'));
  const memory = page.locator('.memory-inspector');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await checkTabs(page, memory, 'memory', width);
  }
  // Editing survives tab changes and retains the existing save contract.
  await memory.locator('.memory-actions-menu > summary').click();
  await memory.locator('[data-memory-operation=edit]').click();
  const editor = memory.locator('textarea');
  await editor.fill('Cedar’s approved budget is ¥63,500, including tax.');
  await memory.locator('.detail-focus-navigation [role=tab]').nth(1).click();
  assert.match(await editor.inputValue(), /63,500/);
  await memory.locator('[data-memory-edit] button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('63,500'));
  await memory.locator('.detail-focus-navigation [role=tab]').nth(2).click();
  await memory.locator('.memory-version-row').first().waitFor();
  assert.match(await memory.innerText(), /63,500/);
  await memory.locator('.detail-focus-navigation [role=tab]').nth(1).click();
  await memory.locator('[data-memory-explore]').click();
  await page.locator('.memory-space-link').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.memory-relationship-inspector').waitFor();
  await page.screenshot({ path: `${output}/relationship-390.png`, fullPage: true });
  await page.locator('[data-memory-edge-close]').click();
  await page.locator('[data-memory-close]').click();
  await page.locator('[data-node-kind=project]').first().click();
  await page.locator('.memory-reference-inspector').waitFor();
  await page.screenshot({ path: `${output}/reference-390.png`, fullPage: true });

  const demo = await startFixtureServer({ demo: true }); fixtures.push(demo);
  await page.goto(demo.base);
  await page.locator('#taskContent [data-select-task]:visible').first().click();
  const task = page.locator('.ws-inspector');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await checkTabs(page, task, 'task', width);
  }
  await task.locator('.ws-direction-disclosure > summary').click();
  await task.locator('textarea').fill('Keep this unsent direction while browsing evidence.');
  await task.locator('.detail-focus-navigation [role=tab]').nth(1).click();
  await task.locator('[data-task-context=sources]').click();
  const dialog = page.locator('#taskContextDialog');
  await dialog.waitFor();
  if (await dialog.locator('.detail-focus-navigation').count()) await checkTabs(page, dialog, 'sources-dialog', 390);
  await page.keyboard.press('Escape');
  await task.locator('.detail-focus-navigation [role=tab]').first().click();
  assert.match(await task.locator('textarea').inputValue(), /unsent direction/);
  await page.locator('[data-close-inspector]').click();
  await page.goto(fixture.base + '/#sources');
  await page.locator('[data-inspect-connection=github]').click();
  await page.locator('.connection-inspector:not([hidden])').waitFor();
  await checkTabs(page, page.locator('.connection-inspector:not([hidden])'), 'connection', 390);
  await page.screenshot({ path: `${output}/connection-390.png`, fullPage: true });
  await page.locator('.skip-link').focus();
  assert.equal(await page.locator('.skip-link').evaluate(el => getComputedStyle(el).clipPath), 'none');
  await page.locator('.connection-inspector .detail-focus-navigation [role=tab]').first().focus();
  assert.equal(await page.locator('.skip-link').evaluate(el => getComputedStyle(el).clipPath), 'inset(50%)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${output}/connection-dark-390.png`, fullPage: true });
  await page.evaluate(() => { document.documentElement.lang = 'zh-CN'; });
  await page.waitForFunction(() => document.querySelector('.connection-inspector .detail-focus-navigation [role=tab]')?.textContent === '账号与连接');
  await page.evaluate(() => { document.documentElement.lang = 'en'; });
  await page.waitForFunction(() => document.querySelector('.connection-inspector .detail-focus-navigation [role=tab]')?.textContent === 'Account');
  assert.deepEqual(errors, []);
  console.log('Detail focus passed: task and memory tabs at desktop/mobile, keyboard, drafts, memory edits/history, source dialog, relationships, references and connection inspector.');
} finally {
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
