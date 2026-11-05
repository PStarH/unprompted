import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/durable/store.js';
import { DurableRuntime } from '../../src/durable/runtime.js';
import { WorkEngine } from '../../src/engine.js';
import { NullReasoner } from '../../src/reasoning.js';
import { startFixtureServer } from './fixture-server.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/memory-harness/browser-integration';
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-memory-ui-harness-'));
const filename = path.join(directory, 'state.json');
const quote = 'Cedar approved budget is ¥62,000 including tax.';
const correction = 'Cedar approved budget is ¥65,000 including tax.';
const eventId = 'event:ui-harness';
const taskTitle = 'Cedar budget source brief';
const errors = [], checks = [];
let store, runtime, engine, browser, fixture, memoryId, taskId;
async function openRuntime() {
  store = new SqliteStore(filename);
  engine = new WorkEngine(store, { reasoner: new NullReasoner() });
  runtime = new DurableRuntime(engine, { tickMs: 100000 });
  runtime.worker.stopping = true;
}
async function closeRuntime() {
  if (runtime) { await runtime.close(); await engine.whenSettled(); store.close(); runtime = null; }
}
async function runTools(action) {
  const queued = runtime.jobs.enqueue({ queue: 'browser-contract', type: 'memory_contract', key: String(Date.now()), taskId });
  const job = runtime.jobs.claim('browser-memory', { queue: 'browser-contract', id: queued.id });
  const run = runtime.tasks.beginRun(job), task = runtime.tasks.get(taskId), context = await runtime.loadContext(task, run);
  runtime.tasks.checkpoint(run, job, { expectedInputVersion: task.inputVersion, contextVersion: context.version, sources: context.sources, plan: {} });
  await runtime.scope.run({ taskId, run, job, context }, async () => {
    const fence = runtime.capture(taskId);
    const tools = Object.fromEntries(engine.externalTools({ taskId, isCurrent: () => runtime.isCurrent(taskId, fence) }).map(tool => [tool.name, tool]));
    await action(tools, context);
    try { runtime.tasks.finish(run, job); runtime.jobs.complete(job); } catch {}
  });
}
try {
  await openRuntime(); runtime.suspended = true;
  engine.ingest({ id: eventId, connectorId: 'simulated', source: 'simulated', type: 'email.received', at: new Date().toISOString(),
    payload: { id: 'ui-harness', threadId: 'thread:ui-harness', from: 'alex@example.test', to: 'reader@example.test', subject: 'Cedar approved budget', body: quote } });
  taskId = runtime.tasks.createOrLoad({ candidateKey: 'browser-memory', eventId, data: { subject: taskTitle, status: 'waiting_for_information', sourceConnectorId: 'simulated',
    request: { subjectEntity: 'Cedar', deliverable: 'brief', text: 'Prepare the Cedar budget brief.', source: { id: 'ui-harness', connectorId: 'simulated', eventId } } } }).taskId;
  runtime.suspended = false;
  await runTools(async tools => {
    const result = JSON.parse((await tools.update_memory.execute('browser-remember', { operation: 'remember', evidenceFrom: 'task_source', quote, text: quote })).content[0].text);
    memoryId = result.memory.id; assert.equal(result.requiresReplan, true);
  });
  await closeRuntime();
  fixture = await startFixtureServer({ ruleDemo: false, directory });
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.base + '/#memory');
  await page.locator('[data-memory-search]').fill('Cedar approved budget');
  await page.locator(`.memory-search-result[data-memory-id="${memoryId}"] [data-memory-focus]`).click();
  await page.waitForFunction(() => document.querySelector('.memory-human-context')?.textContent.includes('Cedar budget source brief'));
  assert.match(await page.locator('.memory-human-context').innerText(), /Agent saved this quotation/);
  await page.locator('[data-preserve^="memory-versions-"] summary').click();
  assert.match(await page.locator('.memory-version-row').first().innerText(), /Agent update · Remembered/);
  assert.equal((await page.locator('.memory-inspector').innerText()).includes('agent_remember'), false);
  const usage = page.locator('.memory-inspector-context').filter({ hasText: 'Recorded use in work' });
  assert.equal(await usage.locator('[data-open-task]').count(), 1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}/desktop-agent-memory.png`, fullPage: true });
  checks.push('a real harness write is searchable, shows its task source and readable Agent history in the Inspector');
  await page.locator('.memory-actions-menu summary').click();
  await page.locator('[data-memory-operation=edit]').click();
  await page.locator('[data-memory-edit] textarea').fill(correction);
  await page.locator('[data-memory-edit] button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-content')?.textContent.includes('65,000'));
  await page.waitForFunction(() => document.querySelector('.memory-human-context')?.textContent.includes('you have since corrected it'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/mobile-user-correction.png`, fullPage: false });
  await browser.close(); browser = null;
  await fixture.close(); fixture = null;
  await openRuntime();
  await runTools(async (tools, context) => {
    assert.ok(context.memories.some(memory => memory.id === memoryId && memory.content === correction));
    const read = JSON.parse((await tools.read_memory.execute('read-ui-correction', { id: memoryId })).content[0].text);
    assert.equal(read.content, correction); assert.equal(read.expectedVersion, 2);
  });
  checks.push('a correction saved in the real UI survives restart and is consumed by the next harness context and read tool');
  assert.deepEqual(errors, []);
  fs.writeFileSync(`${output}/verification.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser?.close(); await fixture?.close(); await closeRuntime();
  fs.rmSync(directory, { recursive: true, force: true });
}
