import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startFixtureServer({ demo: true });
const browser = await chromium.launch({ headless: true, channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined });
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/page-focus';
fs.mkdirSync(output, { recursive: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base);
  await page.locator('#taskContent .field-focus-nav').waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const name of ['home', 'activity', 'memory', 'sources', 'preferences']) {
      await page.locator(`.navigation [data-view="${name}"]`).click();
      const view = page.locator(`#view${name[0].toUpperCase()}${name.slice(1)}`);
      const nav = view.locator('.page-focus-nav').first();
      await nav.waitFor();
      const tabs = nav.getByRole('tab');
      const count = await tabs.count();
      for (let i = 0; i < count; i++) {
        await tabs.nth(i).click();
        assert.equal(await nav.locator('[aria-selected=true]').count(), 1);
        for (const panelId of (await tabs.nth(i).getAttribute('aria-controls')).split(' ')) {
          const panel = page.locator(`#${panelId}`);
          assert.equal(await panel.evaluate(el => el.classList.contains('page-focus-inactive')), false);
          if (await panel.evaluate(el => !el.hidden && Boolean(el.textContent.trim()))) assert.equal(await panel.isVisible(), true, `${panelId} should be visible`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} tab ${i} at ${width} overflows`);
      }
      if (name === 'activity') {
        await tabs.nth(1).click();
        assert.equal(await page.locator('[data-activity-filter=history]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#eventContent').isVisible(), true);
      }
      await tabs.first().click();
      await tabs.first().press('ArrowRight');
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
      await tabs.nth(1).press('Home');
      assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
      await view.locator('.page-focus-pager button').last().click();
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
      if (name === 'home') {
        const populated = view.locator('.ws-task-group[data-empty=false]');
        if (await populated.count()) {
          const id = await populated.first().getAttribute('aria-labelledby');
          await page.locator(`#${id}`).click();
        }
      }
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
  }
  // Selection survives a reload, while application-owned hidden states remain intact.
  await page.reload();
  await page.locator('#viewPreferences .page-focus-nav').waitFor();
  assert.equal(await page.locator('#viewPreferences [role=tab]').nth(1).getAttribute('aria-selected'), 'true');
  await page.locator('[data-view=sources]').click();
  await page.locator('#viewSources [role=tab]').nth(2).click();
  const hidden = await page.locator('#googleSearchPanel').getAttribute('hidden');
  await page.locator('#viewSources [role=tab]').first().click();
  await page.locator('#viewSources [role=tab]').nth(2).click();
  assert.equal(await page.locator('#googleSearchPanel').getAttribute('hidden'), hidden);
  await page.locator('[data-view=memory]').click();
  await page.locator('#viewMemory > .page-focus-navigation [role=tab]').first().click();
  await page.locator('.memory-advanced').evaluate(el => { el.open = true; });
  await page.waitForFunction(() => document.querySelector('#viewMemory > .page-focus-navigation [role=tab]:last-child').getAttribute('aria-selected') === 'true');
  await page.evaluate(() => { document.documentElement.lang = 'zh-CN'; });
  await page.waitForFunction(() => document.querySelector('#viewMemory .page-focus-pager button').getAttribute('aria-label') === '上一个分区');
  await page.evaluate(() => { document.documentElement.lang = 'en'; });
  await page.waitForFunction(() => document.querySelector('#viewMemory .page-focus-pager button').getAttribute('aria-label') === 'Previous section');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${output}/memory-dark-390.png`, fullPage: true });
  await page.locator('[data-view=home]').click();
  await page.locator('#taskContent .field-focus-nav [role=tab]').first().click();
  await page.locator('#taskStatusFilter').evaluate(el => { el.value = 'waiting'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#field-panel-waiting-tab')?.getAttribute('aria-selected') === 'true');
  await page.locator('#taskContent [data-select-task]:visible').first().click();
  await page.locator('.ws-task-page').waitFor();
  await page.screenshot({ path: `${output}/task-detail-390.png`, fullPage: true });
  await page.locator('.ws-task-page [data-close-inspector]').click();
  await page.locator('#taskContent .field-focus-nav').waitFor();
  assert.deepEqual(errors, []);
  console.log('Page focus: all five navigation pages, tabs, arrows, keyboard, reload, hidden state, rule links, language and responsive bounds passed.');
} finally {
  await browser.close();
  await fixture.close();
}
