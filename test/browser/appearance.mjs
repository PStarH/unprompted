import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startFixtureServer();
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/appearance';
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
const errors = [], checks = [];
const check = id => checks.push({ id, passed: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base);
  await page.locator('#taskContent [data-select-task]').first().waitFor();
  await page.locator('#taskContent [data-select-task]').first().click();
  await page.locator('[data-view="preferences"]').click();
  assert.equal(await page.locator('html').getAttribute('data-style'), 'space');
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'mist');
  await page.locator('[data-interface-style="classic"]').click();
  await page.locator('[data-palette="sage"]').click();
  await page.reload();
  await page.locator('[data-interface-style="classic"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'sage');
  check('interface-style-and-palette-survive-reload');

  await page.locator('.custom-appearance > summary').click();
  const form = page.locator('#customColorsForm');
  await form.locator('[name="canvas"]').fill('#no');
  await form.locator('button[type="submit"]').click();
  assert.equal(await page.locator('#appearanceError').isVisible(), true);
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'sage');
  await form.locator('[name="canvas"]').fill('#F6F7F1');
  const taskId = (await (await page.request.get(fixture.base + '/api/state')).json()).tasks[0].id;
  await form.locator('[name="accent"]').fill('#879E72');
  await form.locator('[name="accent"]').focus();
  const before = await page.request.post(`${fixture.base}/api/tasks/${encodeURIComponent(taskId)}/pause`, { data: {} });
  assert.equal(before.ok(), true);
  await page.waitForFunction(() => document.querySelector('#taskContent [data-state="paused_by_user"]'));
  assert.equal(await form.locator('[name="accent"]').inputValue(), '#879E72');
  assert.equal(await form.locator('[name="accent"]').evaluate(input => document.activeElement === input), true);
  await form.locator('button[type="submit"]').click();
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'custom');
  await page.reload();
  await form.locator('[name="canvas"]').waitFor();
  assert.equal(await form.locator('[name="canvas"]').inputValue(), '#F6F7F1');
  assert.equal(await form.locator('[name="accent"]').inputValue(), '#879E72');
  check('invalid-custom-colors-stay-inline-and-live-updates-preserve-unsaved-input');
  check('custom-colors-survive-reload');

  for (const palette of ['mist', 'sage', 'sand', 'graphite']) {
    await page.locator(`[data-palette="${palette}"]`).click();
    for (const theme of ['light', 'dark']) {
      await page.selectOption('#appearanceSelect', theme);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      await page.screenshot({ path: `${output}/${palette}-${theme}.png`, animations: 'disabled' });
    }
  }
  check('all-four-palettes-work-in-light-and-dark-appearance');
  await page.locator('[data-appearance-reset]').click();
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'mist');
  assert.equal(await page.locator('#appearanceSelect').inputValue(), 'system');
  check('restore-defaults-resets-style-palette-and-appearance');

  let layouts = 0;
  for (const style of ['space', 'classic', 'compact']) {
    await page.locator('[data-view="preferences"]').click();
    await page.locator(`[data-interface-style="${style}"]`).click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const locale of ['en', 'zh-CN']) {
        await page.selectOption('#languageSelect', locale);
        for (const view of ['home', 'memory', 'sources', 'preferences']) {
          await page.locator(`[data-view="${view}"]`).click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${style}/${width}/${locale}/${view} overflow`);
          layouts++;
          if (locale === 'zh-CN' && [390, 1440].includes(width) && ['home', 'preferences'].includes(view)) {
            await page.screenshot({ path: `${output}/${style}-${view}-${width}.png`, animations: 'disabled' });
          }
        }
      }
    }
  }
  check(`${layouts}-responsive-style-language-and-page-combinations`);
  assert.deepEqual(errors, []);
  check('no-browser-runtime-errors');
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} finally {
  await browser.close();
  await fixture.close();
}
