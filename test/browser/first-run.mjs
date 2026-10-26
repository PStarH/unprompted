// Exercise the actual demo story, SSE, approval and receipt without API stubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/first-run-validation';
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
const checks = [];
try {
  for (const { locale, desktop } of [{ locale: 'en-US', desktop: false }, { locale: 'zh-CN', desktop: false }, { locale: 'en-US', desktop: true }]) {
    const kind = desktop ? 'desktop' : 'disposable';
    const label = `${kind}-${locale}`;
    const fixture = await startFixtureServer({ demo: true, desktop, root: process.env.UNPROMPTED_FIRST_RUN_ROOT });
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], posts = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      if (!request.url().startsWith(fixture.base) && !request.url().startsWith('data:')) remote.push(request.url());
    });
    try {
      const before = await (await page.request.get(fixture.base + '/api/state')).json();
      assert.equal(before.events.length, 0);
      // First load can lose the server too. A clear, localized retry must lead
      // back into the same real story without a full page refresh.
      await page.route('**/api/**', route => route.abort('failed'));
      await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
      await page.locator('#agentStatus [data-sync-state]').waitFor();
      assert.match(await page.locator('#agentStatus').innerText(), locale === 'zh-CN' ? /暂时无法连接工作空间/ : /Can't connect to the workspace yet/);
      await page.unroute('**/api/**');
      await page.locator('#agentStatus [data-sync-state]').click();
      await page.waitForFunction(() => ['watching', 'checking'].includes(document.querySelector('#demoJourney')?.dataset.phase));
      assert.equal(await page.locator('#languageSelect').inputValue(), locale === 'zh-CN' ? 'zh-CN' : 'en');
      await page.screenshot({ path: `${output}/start-${label}.png`, fullPage: true, animations: 'disabled' });
      await page.waitForFunction(() => document.querySelector('#demoJourney')?.dataset.phase === 'checking');
      assert.equal(posts.length, 0, 'The environment must advance without a task prompt or analysis button.');
      assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).outbox.length, 0);
      await page.waitForFunction(() => document.querySelector('#demoJourney')?.dataset.phase === 'ready', null, { timeout: 25_000 });
      await page.screenshot({ path: `${output}/ready-${label}.png`, fullPage: true, animations: 'disabled' });
      await page.locator('#demoJourney [data-go="attention"]').click();
      assert.equal(await page.locator('#viewAttention').isVisible(), true);
      await page.locator('#decisionDeckCurrent [data-action="approve"]').click();
      await page.waitForFunction(() => document.querySelector('#demoJourney')?.dataset.phase === 'verified');
      const complete = await (await page.request.get(fixture.base + '/api/state')).json();
      assert.equal(complete.tasks[0].status, 'completed');
      assert.equal(complete.tasks[0].action.status, 'verified_simulated');
      assert.equal(complete.outbox.length, 1);
      assert.deepEqual(posts, [`/api/tasks/${encodeURIComponent(complete.tasks[0].id)}/approve`]);
      await page.locator('[data-view="home"]').click();
      await page.locator('#demoJourney [data-open-task]').click();
      assert.match(await page.locator('#taskDialogContent > .task-action .receipt').innerText(), /sim-1/);
      await page.keyboard.press('Escape');
      await page.locator('#demoJourney [data-go="sources"]').click();
      if (desktop) {
        await page.locator('#setupContent input[type="file"]').waitFor();
        const setup = await (await page.request.get(fixture.base + '/api/setup')).json();
        assert.equal(setup.google.allowExternalWrites, false);
        assert.equal(setup.google.hasRefreshToken, false);
      } else {
        assert.match(await page.locator('#setupContent').innerText(), /npm start/);
        assert.equal(await page.locator('#setupContent input[type="file"]').count(), 0, 'A disposable demo must not invite account setup that will be discarded.');
      }
      await page.locator('[data-view="home"]').click();
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale}/${width} overflow`);
        if (width === 390 || width === 1440) await page.screenshot({ path: `${output}/verified-${label}-${width}.png`, fullPage: true, animations: 'disabled' });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#demoJourney')?.dataset.phase === 'verified');
      assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).outbox.length, 1, 'Reload must not replay or resend.');
      await page.locator('#demoJourney [data-demo-replay]').click();
      await page.waitForFunction(() => document.querySelector('#demoJourney')?.dataset.phase === 'ready', null, { timeout: 25_000 });
      await page.locator('#taskContent [data-action="reject"]').click();
      await page.waitForFunction(() => document.querySelector('#demoJourney')?.dataset.phase === 'stopped');
      assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).outbox.length, 0);
      assert.deepEqual(errors, []); assert.deepEqual(remote, []);
      checks.push({ kind, locale, passed: true, initialConnectionRecovery: true, realSse: true, externalRequests: 0, verifiedSimulatedDeliveries: 1, responsiveWidths: [390, 768, 1280, 1440], replayAndDecline: true });
    } finally { await context.close(); await fixture.close(); }
  }
} catch (error) { checks.push({ passed: false, error: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  await browser.close();
  fs.writeFileSync(output + '/first-run-report.json', JSON.stringify({ checks, evidenceScope: 'synthetic' }, null, 2) + '\n');
  console.log(JSON.stringify(checks, null, 2));
}
