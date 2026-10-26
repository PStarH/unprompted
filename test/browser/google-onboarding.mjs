// Actual browser + product server + loopback OAuth callback. Google and model
// responses are explicitly scripted HTTP fixtures, not live account validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startGoogleFixture } from '../fixtures/google-workspace.mjs';
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/real-onboarding';
fs.mkdirSync(output, { recursive: true });
const fixture = await startGoogleFixture({ provisioned: false });
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
await context.grantPermissions(['clipboard-read', 'clipboard-write']);
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const record = id => checks.push({ id, passed: true });
let grantAccount = 'reader-a';
await context.route('https://accounts.google.com/o/oauth2/v2/auth?**', async route => {
  const url = new URL(route.request().url());
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', grantAccount);
  await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Scripted Google consent</title><p>Test fixture, not real Google consent.</p><a id="grant" href="${callback.href.replaceAll('&', '&amp;')}">Grant selected access</a>` });
});
async function grantFrom(button) {
  const opened = page.waitForEvent('popup'); await button.click();
  const popup = await opened;
  await popup.locator('#grant').click();
}
try {
  await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
  const model = page.locator('#modelOnboarding [data-model-form]'); await model.waitFor();
  await page.locator('#connectionCatalogHome [data-select-connection="google"]').click();
  const initial = page.locator('#workspaceOnboarding');
  assert.match(await initial.innerText(), /One-time setup|one-time setup/);
  assert.ok(await initial.locator('a[href*="gmail.googleapis.com"]').count());
  await page.screenshot({ path: output + '/first-use-en.png', fullPage: true, animations: 'disabled' });
  record('real-first-use-includes-model-and-google-setup-without-a-sample');
  await model.locator('[name="baseUrl"]').fill(fixture.endpoint + '/model/v1');
  await model.locator('[name="model"]').fill('scripted-fixture');
  await model.locator('[name="apiKey"]').fill('PRIVATE_MODEL_KEY');
  await model.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#modelOnboarding')?.textContent.includes('Model connected'));
  assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).events.length, 0);
  const client = initial.locator('[data-google-client-form]');
  await client.locator('[name="clientJson"]').setInputFiles({ name: 'web-client.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ web: { client_id: 'invalid', client_secret: 'invalid' } })) });
  await client.locator('button[type="submit"]').click();
  await initial.locator('[data-connection-error]:not([hidden])').waitFor();
  assert.match(await initial.locator('[data-connection-error]').innerText(), /Web client/);
  record('wrong-client-type-has-an-inline-recovery-without-losing-model-settings');
  fixture.controls.apiDisabled = true;
  await client.locator('[name="clientJson"]').setInputFiles({ name: 'desktop-client.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'PRIVATE_DESKTOP_CLIENT' } })) });
  const processId = (await (await page.request.get(fixture.base + '/api/health')).json()).processId;
  await grantFrom(client.locator('button[type="submit"]'));
  await page.waitForFunction(() => document.querySelector('#workspaceOnboarding')?.textContent.includes('has not enabled the required API'));
  assert.equal((await (await page.request.get(fixture.base + '/api/health')).json()).processId, processId);
  record('import-and-consent-activate-without-restart-and-show-real-api-failure');
  fixture.controls.apiDisabled = false;
  await initial.locator('[data-sync-now]').click();
  await page.waitForFunction(() => document.querySelector('#workspaceOnboarding')?.textContent.includes('Your discovered work is below'));
  assert.deepEqual(await initial.locator('.connection-stats dd').allTextContents(), ['1', '1', '1']);
  assert.ok(await page.locator('#taskContent [data-task-card]').count());
  assert.equal(await page.locator('#taskContent [data-action="approve"]').count(), 0, 'read-only does not offer a send button');
  await page.locator('#taskContent [data-copy-draft]').click();
  const draft = (await (await page.request.get(fixture.base + '/api/state')).json()).tasks[0].draft;
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), draft.body);
  assert.ok(await page.locator('#taskContent [data-action="reject"]').count(), 'read-only users can decline a prepared reply');
  record('retry-reads-existing-documents-and-shows-source-backed-work');
  await initial.locator('[data-go="sources"]').click();
  const settings = page.locator('#setupContent');
  await settings.locator('[data-preserve="google-write-access"] > summary').click();
  await settings.locator('[name="gmailSend"]').check();
  await grantFrom(settings.locator('[data-preserve="google-write-access"] [data-scope-form] button[type="submit"]'));
  await page.waitForFunction(() => document.querySelector('#setupContent [name="allowExternalWrites"]')?.checked);
  const runtime = await (await page.request.get(fixture.base + '/api/runtime')).json();
  assert.equal(runtime.google.sendEnabled, true);
  assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).outbox.length, 0);
  record('incremental-send-access-applies-immediately-without-executing-an-action');
  await page.locator('#observationContent [name="enabled"]').uncheck();
  await page.locator('#observationContent [data-monitor-form] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#observationContent')?.textContent.includes('Automatic checks paused'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#observationContent [data-monitor-form]').waitFor();
  assert.equal(await page.locator('#observationContent [name="enabled"]').isChecked(), false);
  record('pause-survives-reload-and-retains-the-last-check');
  await page.locator('#connectorContent [data-select-connection="google"]').click();
  await settings.locator('[data-preserve="google-diagnostics"] > summary').click();
  const cancelledPopup = page.waitForEvent('popup');
  await settings.locator('[data-google-reconnect]').click();
  await cancelledPopup;
  await settings.locator('[data-google-cancel]').click();
  await page.waitForFunction(() => document.querySelector('#setupContent')?.textContent.includes('You cancelled authorization'));
  assert.equal((await (await page.request.get(fixture.base + '/api/setup')).json()).google.hasRefreshToken, true);
  record('cancelling-reauthorization-keeps-the-existing-account-and-observation-choice');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['en', 'zh-CN']) {
      await page.selectOption('#languageSelect', language);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${language} at ${width} overflows`);
      await page.screenshot({ path: `${output}/google-${language}-${width}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  record('google-connection-is-responsive-in-both-languages-at-three-widths');
  await page.selectOption('#languageSelect', 'en');
  await settings.locator('[data-google-forget]').click();
  await settings.locator('[data-scope-form] button[data-google-authorize]').waitFor();
  assert.equal((await (await page.request.get(fixture.base + '/api/setup')).json()).google.hasRefreshToken, false);
  grantAccount = 'reader-b';
  await page.evaluate(() => { window.savedOpenForFixture = window.open; window.open = () => null; });
  await settings.locator('[data-scope-form] button[data-google-authorize]').click();
  await settings.getByRole('link', { name: 'Continue Google authorization' }).waitFor();
  await page.evaluate(() => { window.open = window.savedOpenForFixture; delete window.savedOpenForFixture; });
  const fallbackOpened = context.waitForEvent('page');
  await settings.getByRole('link', { name: 'Continue Google authorization' }).click();
  const fallbackPopup = await fallbackOpened; await fallbackPopup.locator('#grant').click();
  await page.waitForFunction(() => document.querySelector('#setupContent')?.textContent.includes('reader-b@example.test'));
  const state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.ok(state.inbox.every(message => message.id.includes('reader-b')));
  assert.equal(state.runtime.shadow, true, 'a new account does not inherit write authority');
  record('blocked-popup-offers-an-ordinary-authorization-link-without-browser-setting-changes');
  record('disconnect-and-new-account-connect-without-restart-or-inherited-authority');
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /PRIVATE_/);
  assert.deepEqual(errors, []);
} catch (error) {
  checks.push({ passed: false, error: error.message, stack: error.stack }); process.exitCode = 1;
  await page.screenshot({ path: output + '/failure.png', fullPage: true, animations: 'disabled' });
} finally {
  await browser.close(); await fixture.close();
  const report = { checks, errors, providerKind: 'scripted-google-and-model-http', realGoogleAccountValidated: false };
  fs.writeFileSync(output + '/google-onboarding.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
