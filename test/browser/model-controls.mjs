import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { SqliteStore } from '../../src/durable/store.js';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/model-controls';
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-controls-browser-'));
const store = new SqliteStore(path.join(directory, 'state.json'));
store.mutate(state => {
  for (const id of ['scope-a', 'scope-b']) state.tasks[id] = { id, subject: `Budget ${id}`, status: 'observing', kind: 'external_issue', externalSource: { provider: 'github', repository: 'team/project', number: 7 } };
});
store.close();
const fixture = await startFixtureServer({ ruleDemo: false, directory });
const checks = [], errors = [];
let browser;
try {
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base + '/#preferences');
  await page.locator('#languageSelect').selectOption('en');
  const panel = page.locator('.model-budget-controls');
  await panel.locator(':scope > summary').click();
  await page.locator('[data-model-token-form]').waitFor();
  const get = async suffix => (await page.request.get(fixture.base + suffix)).json();
  async function save(selector, endpoint) {
    const response = page.waitForResponse(r => r.url().endsWith(endpoint) && r.request().method() === 'POST');
    await page.locator(selector).locator('[type=submit]').click();
    const saved = await response;
    assert.equal(saved.status(), 200, await saved.text());
    return saved.json();
  }
  const token = page.locator('[data-model-token-form]');
  await token.locator('[name=tokens]').fill('0');
  await save('[data-model-token-form]', '/api/model-controls/token-limit');
  assert.equal((await get('/api/model-controls')).token.workspace.limit, 0);
  await token.locator('[name=tokens]').fill('');
  await save('[data-model-token-form]', '/api/model-controls/token-limit');
  assert.equal((await get('/api/model-controls')).token.workspace.limit, null);
  checks.push('explicit zero and unlimited Token budgets persist as distinct native values');
  const money = page.locator('[data-model-money-form]');
  await money.locator('[name=moneyMajor]').fill('1.234567');
  await save('[data-model-money-form]', '/api/model-controls/money-limit');
  assert.equal((await get('/api/model-controls')).money.limits.workspace.micros, 1234567);
  await money.locator('[name=moneyCurrency]').selectOption('EUR');
  assert.equal(await money.locator('[name=moneyMajor]').inputValue(), '');
  await money.locator('[name=moneyMajor]').fill('0');
  await save('[data-model-money-form]', '/api/model-controls/money-limit');
  let controls = await get('/api/model-controls');
  assert.equal(controls.money.limits.workspace.currency, 'EUR');
  assert.equal(controls.money.limits.workspace.micros, 0);
  checks.push('model-fee cap uses exact micros and changing currency requires a new amount');

  let releaseScope;
  const gate = new Promise(resolve => { releaseScope = resolve; });
  await page.route('**/api/model-controls?taskId=scope-a', async route => { await gate; await route.continue(); }, { times: 1 });
  await page.locator('[data-model-budget-task]').selectOption('scope-a');
  await page.locator('[data-model-token-form]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-model-money-form]').count(), 0);
  releaseScope();
  await token.waitFor();
  await token.locator('[name=tokens]').fill('17');
  await save('[data-model-token-form]', '/api/model-controls/token-limit');
  assert.equal((await get('/api/model-controls?taskId=scope-a')).token.task.limit, 17);
  assert.equal((await get('/api/model-controls')).token.workspace.limit, null);
  await page.locator('[data-model-budget-task]').selectOption('scope-b');
  await page.waitForFunction(() => document.querySelector('[data-model-budget-task]')?.value === 'scope-b' && document.querySelector('[data-model-token-form] [name=tokens]')?.value === '');
  await page.locator('[data-model-budget-task]').selectOption('');
  await page.waitForFunction(() => document.querySelector('[data-model-budget-task]')?.value === '');
  checks.push('loading task scope removes stale forms and task limits never change workspace limits');

  const connection = page.locator('[data-model-form]');
  await connection.locator('[name=baseUrl]').fill('https://provider.example.test/v1');
  await connection.locator('[name=model]').fill('small-model');
  await page.locator('details[data-preserve=model-prices] > summary').click();
  const price = page.locator('[data-model-price-form]');
  await price.locator('[name=priceCurrency]').selectOption('USD');
  for (const rate of ['input', 'output', 'cacheRead', 'cacheWrite']) await price.locator(`[name=price_${rate}]`).fill('0');
  await price.locator('[name=priceConfirmed]').check();
  await connection.locator('[name=model]').fill('large-model');
  assert.equal(await price.locator('[name=priceConfirmed]').isChecked(), false);
  await price.locator('[name=priceConfirmed]').check();
  await price.locator('[name=price_input]').fill('1');
  assert.equal(await price.locator('[name=priceConfirmed]').isChecked(), false, 'changing any confirmed price requires reconfirmation');
  await price.locator('[name=price_input]').fill('0');
  await price.locator('[name=priceConfirmed]').check();
  const priced = await save('[data-model-price-form]', '/api/model-controls/price-profile');
  assert.deepEqual(priced.profile.rates, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal((await get('/api/setup')).model.active, false);
  checks.push('explicit four-rate free pricing is confirmed independently and never activates a model');
  const currentControls = await get('/api/model-controls');
  const concurrent = await page.request.post(fixture.base + '/api/model-controls/price-profile', { headers: { 'x-unprompted-model-workspace': currentControls.workspaceToken }, data: {
    connection: { baseUrl: 'https://provider.example.test/v1', model: 'large-model', protocol: 'chat-completions' }, currency: 'USD', revision: 2, rates: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }, expectedVersion: priced.profile.version, confirmed: true
  } });
  assert.equal(concurrent.status(), 200, await concurrent.text());
  const conflictResponse = page.waitForResponse(r => r.url().endsWith('/api/model-controls/price-profile') && r.request().method() === 'POST');
  await price.locator('[type=submit]').click();
  assert.equal((await conflictResponse).status(), 409);
  await price.locator('[data-controls-error]:not([hidden])').waitFor();
  assert.match(await price.locator('[data-controls-error]').innerText(), /Current saved rates/);
  checks.push('a concurrent price revision produces a visible conflict and never overwrites the new rates');

  await page.locator('details[data-preserve=model-routing] > summary').click();
  const routing = page.locator('[data-model-routing-form]');
  await routing.locator('[name=routingEnabled]').check();
  await routing.locator('[name=routingModels]').fill('small-model, large-model');
  await routing.locator('[name=routingDefault]').fill('small-model');
  await routing.locator('[name=routingFallback]').fill('large-model');
  await routing.locator('[name=route_planning]').fill('large-model');
  await routing.locator('[name=routingAllowSecond]').check();
  await save('[data-model-routing-form]', '/api/model-controls/routing');
  const policy = await get('/api/model-controls/routing');
  assert.equal(policy.config.stages.planning, 'large-model');
  assert.equal(policy.requestCallLimit, 2);
  assert.equal(policy.maxRpcAttempts, 2);
  await page.reload();
  await panel.locator(':scope > summary').click();
  await routing.waitFor({ state: 'attached' });
  if (!await routing.isVisible()) await page.locator('details[data-preserve=model-routing] > summary').click();
  assert.equal(await routing.locator('[name=routingDefault]').inputValue(), 'small-model');
  checks.push('stage routing and explicit fallback opt-in survive a browser reload');
  for (const language of ['en', 'zh-CN']) {
    await page.locator('#languageSelect').selectOption(language);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: `${output}/controls-${language}-390.png` });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await fixture.close(); fs.rmSync(directory, { recursive: true, force: true });
  fs.writeFileSync(`${output}/contract.json`, JSON.stringify({ checks, errors, realProviderBilling: false }, null, 2));
}
console.log(`Model controls browser passed: ${checks.length} checks.`);
