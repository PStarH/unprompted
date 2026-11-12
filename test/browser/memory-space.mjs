import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { SqliteStore } from '../../src/durable/store.js';
import { seedMemoryExplorerStore } from '../fixtures/memory-explorer.js';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/memory-explorer';
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-explorer-browser-'));
const store = new SqliteStore(path.join(directory, 'state.json'));
seedMemoryExplorerStore(store, 500); store.close();
const checks = [], errors = [], tasks = [];
const check = id => checks.push({ id, passed: true });
let browser, fixture, demo;
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label);
try {
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || 'chrome', headless: true });
  fixture = await startFixtureServer({ ruleDemo: false, directory });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base + '/#memory');
  await page.locator('.memory-search-result').first().waitFor();
  assert.equal(await page.locator('.memory-search-result').count(), 5);
  assert.equal(await page.locator('.memory-space-graph').count(), 0);
  assert.equal(await page.locator('.memory-inspector').count(), 0);
  await page.screenshot({ path: `${output}/desktop-find.png`, fullPage: true });
  check('default-screen-is-search-and-recent-results-without-a-graph-or-category-grid');

  async function find(query, expected, task) {
    const started = performance.now();
    await page.locator('[data-memory-search]').fill(query);
    await page.waitForFunction(id => document.querySelector('.memory-search-result')?.dataset.memoryId === id, expected);
    assert.ok(await page.locator('.memory-search-result').first().locator('.memory-match-reasons').innerText());
    assert.ok(await page.locator('.memory-search-result').first().locator('.memory-result-source').innerText());
    const latencyMs = Math.round(performance.now() - started);
    await page.locator(`.memory-search-result[data-memory-id="${expected}"] [data-memory-focus]`).click();
    await page.locator('.memory-inspector-context').waitFor();
    await page.waitForFunction(() => !document.querySelector('.memory-inspector-context [role=status]'));
    tasks.push({ task, query, expected, rank: 1, queries: 1, openActions: 1, graphNavigation: 0, latencyMs });
  }
  await find('What is the budget for Cedar?', 'budget-current', 'Find a previously stated budget');
  assert.match(await page.locator('.memory-inspector').innerText(), /62,000/);
  assert.match(await page.locator('.memory-human-context').innerText(), /Cedar review/);
  await page.screenshot({ path: `${output}/desktop-budget-context.png`, fullPage: true });
  await find('Find the preference 林晨 expressed several weeks ago', 'old-preference', 'Find a preference expressed several weeks ago');
  assert.match(await page.locator('.memory-search-result').first().innerText(), /9\/18\/2026/);
  await find('Find the correction from the previous Cedar task', 'budget-current', 'Find a correction made during a previous task');
  assert.match(await page.locator('.memory-inspector-context').innerText(), /replaces|Replaces/);

  const startProject = performance.now();
  await page.locator('[data-memory-search]').fill('Everything relevant to Cedar');
  await page.waitForResponse(response => response.url().includes('/api/memory-space?') && new URL(response.url()).searchParams.get('q') === 'Everything relevant to Cedar');
  await page.waitForFunction(() => document.querySelector('.memory-results-heading')?.textContent.includes('results') && document.querySelectorAll('.memory-search-result').length >= 4);
  assert.ok((await page.locator('.memory-result-content').allTextContents()).every(text => text.includes('Cedar')));
  tasks.push({ task: 'Find everything relevant to a project', query: 'Everything relevant to Cedar', queries: 1, graphNavigation: 0, latencyMs: Math.round(performance.now() - startProject) });
  await find('studio blue drawer', 'isolated-key', 'Find a memory with no graph relationships');
  assert.match(await page.locator('.memory-inspector-context').innerText(), /No evidenced connections/);
  assert.equal(await page.locator('.memory-space-graph').count(), 0);
  check('budget-old-preference-project-correction-and-isolated-memory-are-found-through-search');

  await find('What is the budget for Cedar?', 'budget-current', 'Determine which newer memory supersedes an older one');
  await page.locator('.memory-inspector-context [data-memory-focus="budget-old"]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('48,000'));
  await page.locator('.memory-inspector-context [data-memory-focus="budget-current"]').waitFor();
  assert.match(await page.locator('.memory-inspector-context').innerText(), /Replaced by.*62,000/s);
  tasks.push({ task: 'Understand why memories are connected', selected: 'budget-old', explanation: 'Explicit user correction', extraContextActions: 1, graphNavigation: 0 });
  await page.locator('.memory-inspector-context [data-memory-focus="budget-current"]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('62,000'));
  await page.locator('[data-memory-explore="budget-current"]').click();
  await page.waitForFunction(() => document.querySelector('[data-memory-center]')?.dataset.memoryCenter === 'budget-current');
  assert.ok(await page.locator('[data-node-kind="project"]').count());
  assert.ok(await page.locator('[data-node-kind="task"]').count());
  const positions = await page.locator('.memory-space-node').evaluateAll(nodes => nodes.map(node => [node.dataset.memoryFocus || node.dataset.memoryReference, node.getAttribute('style')]));
  await page.locator('.memory-space-node[data-memory-focus="budget-old"]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('48,000'));
  assert.equal(await page.locator('[data-memory-center]').getAttribute('data-memory-center'), 'budget-current');
  assert.deepEqual(await page.locator('.memory-space-node').evaluateAll(nodes => nodes.map(node => [node.dataset.memoryFocus || node.dataset.memoryReference, node.getAttribute('style')])), positions);
  check('selecting-a-peripheral-node-updates-inspector-without-changing-center-or-positions');

  await page.locator('.memory-space-link[aria-label*="Replaces older memory"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('.memory-relationship-inspector').waitFor();
  assert.match(await page.locator('.memory-relationship-inspector').innerText(), /explicitly corrected/);
  assert.equal(await page.locator('[data-memory-center]').getAttribute('data-memory-center'), 'budget-current');
  await page.locator('[data-memory-edge-close]').click();
  await page.locator('[data-memory-explore="budget-old"]').click();
  await page.waitForFunction(() => document.querySelector('[data-memory-center]')?.dataset.memoryCenter === 'budget-old');
  assert.equal(await page.locator('[data-memory-back]').isDisabled(), false);
  await page.locator('[data-memory-back]').click();
  await page.waitForFunction(() => document.querySelector('[data-memory-center]')?.dataset.memoryCenter === 'budget-current');
  await page.locator('[data-memory-expand]').click();
  await page.locator('.memory-space-node[data-memory-focus="cedar-context"]').waitFor();
  check('edge-inspection-explicit-explore-from-here-history-and-one-level-expansion-are-distinct');

  await page.locator('[data-node-kind="project"]').click();
  await page.locator('.memory-reference-inspector').waitFor();
  assert.match(await page.locator('.memory-reference-inspector').innerText(), /Project/);
  assert.equal(await page.locator('[data-memory-center]').getAttribute('data-memory-center'), 'budget-current');
  await page.locator('.memory-space-node[data-memory-focus="budget-current"]').click();
  await page.locator('.memory-inspector-content').waitFor();
  await page.screenshot({ path: `${output}/desktop-optional-explore.png`, fullPage: true });
  await page.locator('[data-memory-results]').click();
  assert.equal(await page.locator('[data-memory-search]').inputValue(), 'What is the budget for Cedar?');
  assert.equal(await page.locator('.memory-space-graph').count(), 0);
  check('typed-project-reference-inspection-and-return-to-search-preserve-query');

  // Write real corrections and lifecycle changes through the persistent API.
  async function action(operation) {
    const menu = page.locator('.memory-actions-menu');
    if (!(await menu.evaluate(element => element.open))) await menu.locator('summary').click();
    await page.locator(`.memory-inspector [data-memory-operation="${operation}"]`).click();
  }
  await action('edit');
  await page.locator('[data-memory-edit] textarea').fill('Cedar’s approved budget is ¥63,500, including tax.');
  await page.locator('[data-memory-edit] button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('63,500'));
  let detail = await (await page.request.get(fixture.base + '/api/memory-space/budget-current')).json();
  assert.equal(detail.memory.content, 'Cedar’s approved budget is ¥63,500, including tax.');
  tasks.push({ task: 'Correct an inaccurate memory', memoryId: 'budget-current', operation: 'edit', persisted: true });
  await action('disable');
  await page.waitForFunction(() => document.querySelector('.memory-human-context')?.textContent.includes('Disabled'));
  await page.locator('[data-memory-undo]').click();
  await page.waitForFunction(() => !document.querySelector('.memory-human-context')?.textContent.includes('Disabled'));
  await action('archive');
  await page.waitForFunction(() => document.querySelector('.memory-human-context')?.textContent.includes('Archived'));
  await action('restore');
  await page.waitForFunction(() => !document.querySelector('.memory-human-context')?.textContent.includes('Archived'));
  await action('delete');
  await page.waitForFunction(() => document.querySelector('.memory-human-context')?.textContent.includes('Deleted'));
  await action('restore-delete');
  await page.waitForFunction(() => !document.querySelector('.memory-human-context')?.textContent.includes('Deleted'));
  await action('supersede');
  await page.locator('[data-memory-space-form=supersede] textarea').fill('Cedar’s corrected budget is ¥65,200, including tax.');
  await page.locator('[data-memory-space-form=supersede] button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('65,200'));
  detail = await (await page.request.get(fixture.base + '/api/memory-space/budget-current')).json();
  assert.equal(detail.memory.lifecycleState, 'superseded');
  assert.ok(detail.context.relations.some(edge => edge.kind === 'supersedes' && edge.to === 'budget-current'));
  check('edit-disable-undo-archive-restore-delete-and-correction-remain-real-and-recoverable');

  // Search entry and Inspector are usable in narrow, touch-sized viewports.
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page, `${width}px Inspector overflow`);
    if (width === 390) await page.screenshot({ path: `${output}/mobile-inspector.png`, fullPage: false });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-memory-close]').click();
  await page.screenshot({ path: `${output}/mobile-find.png`, fullPage: false });
  await page.selectOption('#languageSelect', 'zh-CN');
  await noOverflow(page, 'Chinese phone search overflow');
  assert.equal(await page.locator('#viewMemory h1').innerText(), '记忆探索');
  check('desktop-tablet-and-phone-inspector-and-search-fit-both-languages');

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await touch.newPage();
  await phone.goto(fixture.base + '/#memory');
  await phone.locator('.memory-search-result').first().waitFor();
  await phone.locator('.memory-result-open').first().tap();
  await phone.locator('.memory-inspector').waitFor();
  const panelBox = await phone.locator('.memory-inspector').boundingBox();
  const navBox = await phone.locator('.sidebar').boundingBox();
  assert.ok(panelBox.y + panelBox.height <= navBox.y + 1);
  await phone.locator('[data-memory-close]').tap();
  await touch.close();
  check('touch-opens-and-closes-details-above-navigation');

  // IME, rapid queries and recoverable transport errors must keep retrieval usable.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.selectOption('#languageSelect', 'en');
  const search = page.locator('[data-memory-search]');
  await search.evaluate(input => {
    input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '林晨'; input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    if (document.activeElement !== input || !input.isConnected) throw new Error('IME composition lost focus');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '林晨' }));
  });
  await page.waitForFunction(() => document.querySelector('.memory-result-content')?.textContent.includes('林晨'));
  assert.equal(await search.inputValue(), '林晨');
  assert.equal(await search.evaluate(input => document.activeElement === input), true);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/memory-space?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'nonexistent-delay') { started(); await gate; }
    await route.continue();
  });
  await search.fill('nonexistent-delay'); await requested;
  await search.fill('studio blue drawer'); release();
  await page.waitForFunction(() => document.querySelector('.memory-search-result')?.dataset.memoryId === 'isolated-key');
  await page.unroute('**/api/memory-space?**');
  let failed = 0;
  await page.route('**/api/memory-space?**', route => { failed++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Memory search is temporarily unavailable.' }) }); });
  await search.fill('retry-this-query');
  await page.locator('.memory-load-error').waitFor();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(failed, 1);
  await page.unroute('**/api/memory-space?**');
  await page.locator('[data-memory-retry]').click();
  await page.waitForFunction(() => !document.querySelector('.memory-load-error'));
  assert.equal(await search.inputValue(), 'retry-this-query');
  check('ime-latest-query-wins-and-failed-search-retries-without-a-request-loop');

  await find('studio blue drawer', 'isolated-key', 'Retrieve an isolated memory before permanent Forget');
  const forgotten = await page.request.post(fixture.base + '/api/privacy/forget', { data: { kind: 'memory', id: 'isolated-key' } });
  assert.equal(forgotten.status(), 200, await forgotten.text());
  await page.waitForFunction(() => !document.querySelector('.memory-inspector'));
  assert.equal(await page.locator('.memory-space-node').count(), 0);
  check('permanent-forget-removes-selected-memory-and-cached-exploration-content');

  // Old demo metadata no longer produces the nine artificial connections.
  demo = await startFixtureServer({ demo: true, serverEnv: { UNPROMPTED_DEMO_MEMORY_COUNT: '100' } });
  const demoPage = await browser.newPage();
  demoPage.on('pageerror', error => errors.push(error.message));
  await demoPage.goto(demo.base + '/#memory');
  await demoPage.locator('.memory-result-open').first().click();
  await demoPage.waitForFunction(() => !document.querySelector('.memory-inspector-context [role=status]'));
  assert.equal(await demoPage.locator('[data-memory-explore]').count(), 0);
  assert.equal(await demoPage.locator('.memory-space-node').count(), 0);
  assert.equal(await demoPage.locator('.memory-space-link').count(), 0);
  check('the-nine-shared-bucket-edges-are-removed-from-the-actual-demo');

  assert.deepEqual(errors, []);
} catch (error) {
  checks.push({ id: 'failure', passed: false, message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${output}/browser-verification.json`, JSON.stringify({ collection: 500, measurement: 'Automated scripted tasks, not a human usability study', checks, tasks, errors }, null, 2));
  console.log(JSON.stringify({ checks, tasks, errors }, null, 2));
  await browser?.close(); await fixture?.close(); await demo?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
