import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/redesign-shell';
fs.mkdirSync(output, { recursive: true });
const fixture = await startFixtureServer();
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
  await page.locator('#taskContent [data-select-task]').first().waitFor();
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  const views = ['home', 'activity', 'memory', 'sources', 'preferences'];
  for (const language of ['en', 'zh-CN']) {
    await page.selectOption('#languageSelect', language);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of views) {
        await page.locator(`[data-view="${view}"]`).click();
        const visible = page.locator(`#view${view[0].toUpperCase() + view.slice(1)}`);
        assert.equal(await visible.isVisible(), true, `${language} ${width} ${view}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language} ${width} ${view} overflow`);
        if (width <= 390) {
          assert.deepEqual(await page.locator('.navigation').evaluate(nav => [...nav.querySelectorAll('.nav-item')].filter(link => {
            const text = [...link.querySelectorAll('[data-copy]')].find(label => getComputedStyle(label).display !== 'none');
            const bounds = link.getBoundingClientRect(), label = text.getBoundingClientRect();
            return label.left < bounds.left - 1 || label.right > bounds.right + 1;
          }).map(link => link.dataset.view)), [], `${language} ${width} navigation labels`);
        }
        if (language === 'en' && [390, 1440].includes(width)) {
          await page.screenshot({ path: `${output}/${view}-${width}.png`, animations: 'disabled' });
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: 40, errors, screenshots: output }));
} finally {
  await browser?.close();
  await fixture.close();
}
