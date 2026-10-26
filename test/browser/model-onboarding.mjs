// Real browser/API/model-client integration against an explicitly scripted local HTTP provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startFixtureServer } from './fixture-server.mjs';
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/byok-validation';
fs.mkdirSync(output, { recursive: true });
let rejectKey = true;
let rejectTask = true;
const requests = [];
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push({ path: req.url, authorization: req.headers.authorization, body });
  res.setHeader('content-type', 'application/json');
  if (rejectKey) { res.writeHead(401); res.end(JSON.stringify({ error: 'invented provider rejection' })); return; }
  const entity = body.messages.at(-1).content.includes('Northstar') ? 'Northstar' : 'Cedar';
  if (entity === 'Northstar' && rejectTask) { res.writeHead(503); res.end(JSON.stringify({ error: 'invented task-time failure' })); return; }
  const content = { deliverable: 'proposal', subjectEntity: entity, intent: 'update_and_send', requiredContent: [
    { text: 'sample size', sourceQuote: 'sample size', sourceField: 'body' },
    { text: 'conclusion', sourceQuote: 'conclusion', sourceField: 'body' }
  ] };
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
const fixture = await startFixtureServer({ desktop: false, ruleDemo: false, root: process.env.UNPROMPTED_MODEL_TEST_ROOT });
const browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const record = id => checks.push({ id, passed: true });
try {
  await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
  const form = page.locator('#modelOnboarding [data-model-form]');
  await form.waitFor();
  await page.screenshot({ path: `${output}/connect-model-en.png`, fullPage: true, animations: 'disabled' });
  assert.match(await page.locator('#modelOnboarding').innerText(), /Connect your model to start the agent/);
  await page.waitForTimeout(2700);
  assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).events.length, 0);
  assert.equal(requests.length, 0);
  record('unconfigured-first-run-does-not-call-a-provider-or-play-a-rule-story');
  await form.locator('[name="baseUrl"]').fill(endpoint);
  await form.locator('[name="model"]').fill('scripted-fixture-model');
  await form.locator('[name="apiKey"]').fill('PRIVATE_SCRIPTED_MODEL_KEY');
  await form.locator('button[type="submit"]').click();
  await form.locator('[data-model-error]:not([hidden])').waitFor();
  assert.match(await form.locator('[data-model-error]').innerText(), /rejected the key/);
  let setup = await (await page.request.get(fixture.base + '/api/setup')).json();
  assert.equal(setup.model.hasApiKey, false);
  assert.equal(setup.model.active, false);
  record('failed-provider-request-never-saves-the-key-or-claims-connected');
  rejectKey = false;
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#modelOnboarding')?.textContent.includes('Real request verified'));
  setup = await (await page.request.get(fixture.base + '/api/setup')).json();
  assert.equal(setup.model.active, true);
  assert.equal(setup.model.runtime.role, 'primary');
  assert.equal(setup.model.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(setup), /PRIVATE_SCRIPTED_MODEL_KEY/);
  assert.equal(await form.locator('[name="apiKey"]').inputValue(), '');
  record('successful-structured-request-saves-locally-and-applies-without-restart');
  await page.waitForTimeout(2100);
  const state = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(state.events.length, 0);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.outbox.length, 0);
  assert.equal((await (await page.request.get(fixture.base + '/api/runtime')).json()).simulationRunning, false);
  assert.ok(await page.locator('#connectionCatalogHome').isVisible());
  record('model-connection-waits-for-real-context-without-inventing-work');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#modelOnboarding')?.textContent.includes('Model connected'));
  assert.equal((await (await page.request.get(fixture.base + '/api/state')).json()).events.length, 0);
  record('connection-persists-without-starting-a-sample-on-reload');
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /PRIVATE_SCRIPTED_MODEL_KEY/);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['en', 'zh-CN']) {
      await page.selectOption('#languageSelect', language);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${output}/connected-${language}-${width}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await page.selectOption('#languageSelect', 'en');
  await page.locator('#modelOnboarding > details > summary').click();
  await page.locator('[data-model-forget]').click();
  await page.waitForFunction(() => document.querySelector('#modelOnboarding')?.textContent.includes('Connect your model to start the agent'));
  setup = await (await page.request.get(fixture.base + '/api/setup')).json();
  assert.equal(setup.model.hasApiKey, false);
  assert.equal(setup.model.active, false);
  assert.equal(setup.google.allowExternalWrites, false);
  record('disconnect-removes-the-key-and-never-grants-real-write-authority');
  assert.deepEqual(errors, []);
} catch (error) {
  checks.push({ passed: false, error: error.message, stack: error.stack }); process.exitCode = 1;
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true, animations: 'disabled' });
} finally {
  await browser.close(); await fixture.close();
  await new Promise(resolve => provider.close(resolve));
  const report = { checks, errors, modelRequests: requests.length, providerKind: 'scripted-local-http', externalRealModelVerified: false };
  fs.writeFileSync(output + '/model-onboarding.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
