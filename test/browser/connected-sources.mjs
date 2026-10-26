import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnectedFixture } from '../fixtures/connected-workspace.mjs';
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/connectors-validation';
fs.mkdirSync(output, { recursive: true });
const fixture = await startConnectedFixture();
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(), errors = [], checks = [];
const localFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-browser-local-')));
page.on('pageerror', error => errors.push(error.message));
const record = id => checks.push({ id, passed: true });
for (const [url, id] of [['https://github.com/login/device', 'github'], ['https://microsoft.com/devicelogin', 'microsoft']]) {
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Scripted provider consent</title><p>Scripted consent; no real account is used.</p><form method="post" action="${fixture.endpoint}/grant/${id}"><button id="grant">Confirm selected access</button></form>` }));
}
try {
  await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
  const home = page.locator('#connectionCatalogHome'); await home.waitFor();
  assert.equal(await home.locator('[data-connection-card]').count(), 5);
  const native = (await (await page.request.get(fixture.base + '/api/setup')).json()).localSources;
  if (native.local_files.nativePicker) assert.equal(await home.locator('[data-native-source=local_files]').isEnabled(), true);
  else assert.equal(await home.locator('[data-native-path-form] [name=path]').isVisible(), true);
  assert.equal(await home.locator('[data-native-source=apple_notes]').isEnabled(), native.apple_notes.available);
  assert.equal(await page.locator('#workspaceOnboarding').isVisible(), false, 'Google setup does not block selecting another source');
  const model = page.locator('[data-model-form]');
  await model.locator('[name="baseUrl"]').fill(fixture.endpoint + '/model/v1');
  await model.locator('[name="model"]').fill('scripted-model');
  await model.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#modelOnboarding')?.textContent.includes('Model connected'));
  record('first-use-offers-local-and-cloud-sources-without-forcing-google-setup');
  for (const id of ['github', 'microsoft']) {
    const opened = page.waitForEvent('popup'); await home.locator(`[data-select-connection="${id}"]`).click();
    const popup = await opened; await popup.locator('#grant').waitFor();
    const card = home.locator(`[data-connection-card="${id}"]`);
    await card.locator('[data-copy-device-code]').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id === 'github' ? 'CODE-1234' : 'CODE1234');
    await popup.locator('#grant').click();
    await page.waitForFunction(id => document.querySelector(`#connectionCatalogHome [data-connection-card="${id}"]`)?.textContent.includes('Connected · read-only'), id, { timeout: 15_000 });
    record(`${id}-uses-official-device-authorization-and-activates-without-restart`);
  }
  await page.waitForFunction(() => document.querySelectorAll('#taskContent [data-task-card]').length === 2);
  const issue = page.locator('#taskContent [data-task-card^="issue:"]');
  assert.match(await issue.innerText(), /GitHub.*team\/project/s);
  assert.match(await issue.innerText(), /Following assigned issue/);
  assert.equal(await issue.locator('[data-action="approve"]').count(), 0);
  await issue.locator('[data-open-task]').click();
  assert.match(await page.locator('#taskDialog').innerText(), /This issue is assigned to reader/);
  await page.locator('#taskDialog [data-close-dialog]').click();
  record('assigned-issues-keep-native-provenance-and-never-offer-an-email-send');
  await page.locator('[data-view="sources"]').click();
  const observation = page.locator('#observationContent');
  await observation.locator('[name="enabled"]').uncheck();
  await observation.locator('button[type="submit"]').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await observation.locator('[data-monitor-form]').waitFor();
  assert.equal(await observation.locator('[name="enabled"]').isChecked(), false);
  record('one-observation-control-pauses-all-sources-and-survives-reload');
  fixture.controls.githubClosed = true;
  const synced = page.waitForResponse(response => response.url().endsWith('/api/connectors/sync') && response.request().method() === 'POST');
  await observation.locator('[data-sync-now]').click(); await (await synced).finished();
  const state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.tasks.find(task => task.kind === 'external_issue').status, 'cancelled');
  assert.equal(state.tasks.find(task => task.kind === 'external_issue').action, null);
  record('provider-closure-stops-tracking-without-claiming-agent-completion');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const locale of ['en', 'zh-CN']) {
      await page.selectOption('#languageSelect', locale);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${output}/sources-${locale}-${width}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  record('both-languages-and-three-layout-widths-remain-readable-without-overflow');
  await page.selectOption('#languageSelect', 'en');
  const sources = page.locator('#connectorContent');
  await sources.locator('[data-select-connection="github"]').click();
  await sources.locator('[data-provider-operation="forget"][data-provider="github"]').click();
  await page.waitForFunction(() => document.querySelector('#connectorContent [data-connection-card="github"]')?.textContent.includes('Not connected'));
  const setup = await (await page.request.get(fixture.base + '/api/setup')).json();
  assert.equal(setup.connections.microsoft.connected, true); assert.equal(setup.connections.github.authorized, false);
  assert.equal(setup.monitoring.enabled, false);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(setup), /PRIVATE_|accessToken|refreshToken/);
  assert.equal(fixture.calls.some(call => /\/(?:send|comments)$/.test(call.path)), false);
  record('disconnecting-one-source-retains-the-other-and-no-provider-write-is-issued');
  fs.writeFileSync(path.join(localFolder, 'work.md'), '- [ ] Follow supplier delivery\nSelected local source text');
  const selected = await page.request.post(fixture.base + '/api/setup/local-sources/local_files/select', { data: { path: localFolder } });
  assert.equal(selected.status(), 200);
  await page.locator('[data-view="home"]').click();
  const localTask = page.locator('#taskContent [data-task-card^="observed:"]'); await localTask.waitFor();
  assert.match(await localTask.innerText(), /Follow supplier delivery/); assert.equal(await localTask.locator('[data-action="approve"]').count(), 0);
  const localUrl = await localTask.locator('a').getAttribute('href');
  assert.match(await (await page.request.get(localUrl)).text(), /Selected local source text/);
  record('selected-local-folder-produces-real-source-task-without-email-actions');
  await localTask.locator('[data-action="cancel"]').click();
  await page.waitForFunction(() => !document.querySelector('#taskContent [data-task-card^="observed:"]'));
  record('native-card-stop-without-navigation');
  await page.locator('[data-view="sources"]').click();
  await sources.locator('[data-connection-card="local_files"] [data-native-operation="remove-scope"]').click();
  await page.waitForFunction(() => !document.querySelector('#connectorContent [data-connection-card="local_files"] [data-native-operation="forget"]'));
  assert.equal((await page.request.get(localUrl)).status(), 404);
  record('removing-local-scope-revokes-current-document-access');
  assert.deepEqual(errors, []);
} catch (error) {
  checks.push({ passed: false, error: error.message, stack: error.stack }); process.exitCode = 1;
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true, animations: 'disabled' });
} finally {
  await browser.close(); await fixture.close();
  fs.rmSync(localFolder, { recursive: true, force: true });
  const report = { checks, errors, providerKind: 'scripted-device-oauth-and-provider-http', realAccountsValidated: false };
  fs.writeFileSync(`${output}/connected-sources.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
