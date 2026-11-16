import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableDatabase, iso } from '../../src/durable/database.js';
import { DurableJobs } from '../../src/durable/jobs.js';
import { ExperienceService } from '../../src/durable/experience.js';
import { TRIAL_FIXTURE_VERSION } from '../../src/durable/experience-trial-fixtures.js';
import { startFixtureServer } from './fixture-server.mjs';

// Central browser slot only: this flow is written for the single heavy browser
// run approved by the root agent. It is not executed from a worker worktree.
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/experience-trials';
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-experience-browser-'));
const database = new DurableDatabase(path.join(directory, 'state.sqlite'));
const jobs = new DurableJobs(database), experiences = new ExperienceService(database, { jobs });
database.atomic(() => database.db.prepare("INSERT INTO source_records(kind,id,created_at) VALUES('event','browser-source',?)").run(iso(Date.now())));
const notification = experiences.create({
  kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', directiveKey: 'browser.notification.mode',
  effect: { type: 'notification_behavior', mode: 'digest' }, instruction: 'Use a digest for this project.', freshnessClass: 'stable'
}, { sources: [{ kind: 'event', id: 'browser-source' }] });
const advisory = experiences.create({
  kind: 'planning_hint', scopeType: 'project', scopeKey: 'A', instruction: 'Keep the project notes concise.', effect: { type: 'advisory' }, freshnessClass: 'stable'
}, { sources: [{ kind: 'event', id: 'browser-source' }] });
database.close();

const fixture = await startFixtureServer({ ruleDemo: false, directory });
const errors = [], checks = [];
let browser;
try {
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  // Keep SSE from racing explicit stale-revision clicks; HTTP mutations still
  // refresh the panel.
  await page.addInitScript(() => { window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} }; });
  // Evaluation and version controls live in a deliberately folded <details>.
  // Open it through the same summary click a person uses; never force the
  // open property or click a hidden action.
  const evaluationDetails = id => page.locator(`details[data-experience-eval="${id}"]`);
  async function showEvaluation(id) {
    const element = evaluationDetails(id);
    if (!(await element.evaluate(details => Boolean(details.open)))) await element.locator('summary').click();
    await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.open === true, id);
    return element;
  }
  await page.goto(fixture.base + '/#memory');
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#viewMemory .page-focus-nav [role="tab"]').filter({ hasText: 'Rules & experience' }).click();
  const card = page.locator('#experienceContent article').filter({ hasText: 'Use a digest for this project.' });
  await card.waitFor();
  assert.match(await card.innerText(), /Offline evaluation: Not evaluated/);
  assert.match(await card.innerText(), /add an independent behavior case first/);
  checks.push('an unevaluated Experience explicitly asks for an independent behavior case instead of implying a pass');

  await card.locator(`[data-experience-evaluate="${notification.id}"]`).click();
  await page.waitForFunction(id => document.querySelector(`#experienceContent [data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Unknown'), notification.id);
  const details = evaluationDetails(notification.id);
  await details.waitFor();
  await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.open === true, notification.id);
  await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.innerText.includes('no independent behavior case'), notification.id);
  assert.match(await details.innerText(), new RegExp(TRIAL_FIXTURE_VERSION.replaceAll('.', '\\.')));
  checks.push('guards alone evaluate to Unknown with the missing independent behavior case visible');
  await page.screenshot({ path: output + '/unknown-en.png', fullPage: true });

  // A detail fetch failure must keep the form closed and write nothing. The
  // list summary has no cases, so falling back to it would replace the saved
  // set with only the new case.
  await page.reload();
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#viewMemory .page-focus-nav [role="tab"]').filter({ hasText: 'Rules & experience' }).click();
  await card.waitFor();
  const detailRoute = `**/api/experiences/${notification.id}`;
  await page.route(detailRoute, route => route.abort());
  // Count surfaced detail failures so the negative test waits for the
  // open-time load and the Add case load to finish before asserting.
  await page.evaluate(() => {
    const element = document.querySelector('#toast');
    window.__experienceDetailFailures = 0;
    new MutationObserver(() => { if (element.classList.contains('visible')) window.__experienceDetailFailures += 1; })
      .observe(element, { childList: true });
  });
  // Open the real summary first. Its detail request fails, so no detailed
  // case set can be cached when Add case is pressed; nothing is force-opened.
  await showEvaluation(notification.id);
  await page.waitForFunction(() => window.__experienceDetailFailures >= 1);
  const failuresBeforeAdd = await page.evaluate(() => window.__experienceDetailFailures);
  await card.locator(`[data-experience-case-add="${notification.id}"]`).click();
  await page.waitForFunction(count => window.__experienceDetailFailures > count, failuresBeforeAdd);
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('visible'));
  assert.equal(await page.locator('form[data-durable-form="case"]').count(), 0, 'an unloaded detail must not open an append form');
  const zeroWrite = await (await page.request.get(`${fixture.base}/api/experiences/${notification.id}`)).json();
  assert.equal(zeroWrite.experience.caseSet.count, 0, 'a failed detail load writes no empty case set');
  await page.unroute(detailRoute);
  checks.push('a failed detail load keeps the form closed and writes no empty case set');

  await card.locator(`[data-experience-case-add="${notification.id}"]`).click();
  const form = page.locator('form[data-durable-form="case"]');
  await form.waitFor();
  assert.match(await form.innerText(), /0 cases already saved/);
  await form.locator('select[name="scopeType"]').selectOption('project');
  await form.locator('input[name="scopeKey"]').fill('A');
  await form.locator('textarea[name="features"]').fill('event.family=work_request');
  await form.locator('select[name="applies"]').selectOption('true');
  await form.locator('select[name="winner"]').selectOption('candidate');
  await form.locator('select[name="expected_mode"]').selectOption('digest');
  await form.locator('input[name="confirmed"]').check();
  const firstCaseSave = page.waitForResponse(response => response.url() === `${fixture.base}/api/experiences/${notification.id}/cases`
    && response.request().method() === 'POST');
  await form.locator('button[type="submit"]').click();
  assert.equal((await firstCaseSave).status(), 200);
  // Wait for this save's toast text, not any earlier still-visible toast.
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('visible')
    && /Case saved/i.test(document.querySelector('#toast').innerText));
  assert.match(await page.locator('#toast').innerText(), /Case saved/i);
  await showEvaluation(notification.id);
  await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.innerText.includes('v1 (1)'), notification.id);
  assert.match(await details.innerText(), /Saved independent cases · v1 \(1\)/);
  checks.push('the details surface lets a user add one bounded literal scenario without pasting a large JSON document');

  // Adding again appends to the loaded set; the first case is not lost.
  await card.locator(`[data-experience-case-add="${notification.id}"]`).click();
  await form.waitFor();
  assert.match(await form.innerText(), /1 cases already saved/);
  await form.locator('select[name="scopeType"]').selectOption('project');
  await form.locator('input[name="scopeKey"]').fill('A');
  await form.locator('select[name="applies"]').selectOption('true');
  await form.locator('select[name="winner"]').selectOption('candidate');
  await form.locator('select[name="expected_mode"]').selectOption('digest');
  await form.locator('input[name="confirmed"]').check();
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('visible'));
  await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.innerText.includes('v2 (2)'), notification.id);
  assert.match(await details.innerText(), /Saved independent cases · v2 \(2\)/);
  const appended = await (await page.request.get(`${fixture.base}/api/experiences/${notification.id}`)).json();
  assert.equal(appended.experience.caseSet.count, 2);
  assert.equal(appended.experience.caseSet.cases.length, 2);
  checks.push('adding a case appends to the loaded set instead of replacing it');

  await card.locator(`[data-experience-evaluate="${notification.id}"][data-version="1"]`).click();
  await page.waitForFunction(id => document.querySelector(`#experienceContent [data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Passed'), notification.id);
  await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.innerText.includes('No differences.'), notification.id);
  const passedDetail = await details.innerText();
  assert.match(passedDetail, /behavior 2\/2 · positive 2/);
  assert.match(passedDetail, /Case set v2/);
  assert.match(passedDetail, new RegExp(TRIAL_FIXTURE_VERSION.replaceAll('.', '\\.')));
  checks.push('Evaluate uses the saved user case, real predicate and arbiter, and shows behavior counts, case-set version and fixture version');
  await page.screenshot({ path: output + '/evaluated-en.png', fullPage: true });

  await card.locator(`[data-experience-adopt="${notification.id}"][data-version="1"]`).click();
  await page.waitForFunction(id => document.querySelector(`[data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Active'), notification.id);
  assert.match(await details.innerText(), /adopt/);
  checks.push('Adopt is explicit and records an attestation for the new active revision');

  const rollback = page.locator(`[data-experience-rollback="${notification.id}"][data-target="1"]`);
  await showEvaluation(notification.id);
  await rollback.waitFor();
  await rollback.click();
  await page.waitForFunction(id => document.querySelector(`[data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Candidate'), notification.id);
  assert.match(await card.innerText(), /Previous revision; re-evaluate/);
  checks.push('Rollback to an explicitly chosen historical version creates a candidate and marks the old pass stale');

  await page.locator(`[data-experience-evaluate="${notification.id}"][data-version="3"]`).click();
  await page.waitForFunction(id => document.querySelector(`#experienceContent [data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Passed'), notification.id);
  const externalAdoption = await page.request.post(`${fixture.base}/api/experiences/${notification.id}/adopt`, { data: { expectedRevision: 3 } });
  assert.equal(externalAdoption.status(), 200);
  // Bind the stale click to its own 409 and error toast; an earlier toast can
  // still be visible, so visibility alone proves nothing.
  const staleEvaluate = page.waitForResponse(response => response.url() === `${fixture.base}/api/experiences/${notification.id}/evaluate`
    && response.request().method() === 'POST');
  await page.locator(`[data-experience-evaluate="${notification.id}"][data-version="3"]`).click();
  assert.equal((await staleEvaluate).status(), 409, 'a stale evaluation is rejected by the server');
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('visible')
    && /revision has changed/i.test(document.querySelector('#toast').innerText));
  assert.match(await page.locator('#toast').innerText(), /revision has changed/i);
  checks.push('a stale revision action is rejected in the actual UI and surfaces the server error');
  await page.reload();
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#viewMemory .page-focus-nav [role="tab"]').filter({ hasText: 'Rules & experience' }).click();
  await page.waitForFunction(id => document.querySelector(`[data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Active'), notification.id);

  const advisoryCard = page.locator('#experienceContent article').filter({ hasText: 'Keep the project notes concise.' });
  await advisoryCard.locator(`[data-experience-evaluate="${advisory.id}"]`).click();
  await page.waitForFunction(id => document.querySelector(`#experienceContent [data-experience-evaluate="${id}"]`)?.closest('article')?.innerText.includes('Unknown'), advisory.id);
  await page.waitForFunction(id => document.querySelector(`details[data-experience-eval="${id}"]`)?.innerText.includes('advisory_not_mechanically_decidable'), advisory.id);
  checks.push('an advisory Experience stays explicitly Unknown with its reason visible');
  await page.screenshot({ path: output + '/advisory-unknown-en.png', fullPage: true });

  await page.locator('#languageSelect').selectOption('zh-CN');
  await page.locator('#viewMemory .page-focus-nav [role="tab"]').filter({ hasText: '规则与经验' }).click();
  const zhCard = page.locator('#experienceContent article').filter({ hasText: 'Keep the project notes concise.' });
  await zhCard.locator(`[data-experience-evaluate="${advisory.id}"]`).waitFor();
  assert.match(await zhCard.innerText(), /隔离评估|离线评估/);
  checks.push('the existing bilingual details surface renders the evaluation and case controls in Chinese');
  await page.screenshot({ path: output + '/evaluated-zh.png', fullPage: true });

  // A concurrent case-set change must reject the stale form and must not
  // replace the newest saved set. The form stays open with the user's input.
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#viewMemory .page-focus-nav [role="tab"]').filter({ hasText: 'Rules & experience' }).click();
  const conflictCard = page.locator('#experienceContent article').filter({ hasText: 'Use a digest for this project.' });
  await conflictCard.waitFor();
  await showEvaluation(notification.id);
  await conflictCard.locator(`[data-experience-case-add="${notification.id}"]`).click();
  const conflictForm = page.locator('form[data-durable-form="case"]');
  await conflictForm.waitFor();
  const externalCases = [{ id: 'external-v3', scope: [{ type: 'project', key: 'A' }], features: {},
    expected: { applies: true, winner: 'candidate', effect: { type: 'notification_behavior', mode: 'digest' } } }];
  const externalSave = await page.request.post(`${fixture.base}/api/experiences/${notification.id}/cases`,
    { data: { expectedRevision: 4, expectedCaseSetVersion: 2, cases: externalCases } });
  assert.equal(externalSave.status(), 200);
  await conflictForm.locator('select[name="scopeType"]').selectOption('project');
  await conflictForm.locator('input[name="scopeKey"]').fill('A');
  await conflictForm.locator('select[name="applies"]').selectOption('true');
  await conflictForm.locator('select[name="winner"]').selectOption('candidate');
  await conflictForm.locator('select[name="expected_mode"]').selectOption('digest');
  await conflictForm.locator('input[name="confirmed"]').check();
  const staleCaseSave = page.waitForResponse(response => response.url() === `${fixture.base}/api/experiences/${notification.id}/cases`
    && response.request().method() === 'POST');
  await conflictForm.locator('button[type="submit"]').click();
  assert.equal((await staleCaseSave).status(), 409, 'a stale case-set save is rejected by the server');
  // The form failure and toast both carry the new server message; do not let an
  // older toast satisfy the wait.
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('visible')
    && /scenario set has changed/i.test(document.querySelector('#toast').innerText));
  assert.match(await page.locator('#toast').innerText(), /changed/i);
  assert.equal(await conflictForm.isVisible(), true, 'the stale form stays open with the user input');
  assert.equal(await conflictForm.locator('input[name="scopeKey"]').inputValue(), 'A');
  const afterConflict = await (await page.request.get(`${fixture.base}/api/experiences/${notification.id}`)).json();
  assert.equal(afterConflict.experience.caseSet.version, 3);
  assert.equal(afterConflict.experience.caseSet.count, 1);
  assert.equal(afterConflict.experience.caseSet.cases[0].id, 'external-v3');
  checks.push('a concurrent case-set change rejects the stale save and does not overwrite the latest set');
  await conflictForm.locator('button[data-durable-close]').click();

  // The only authority-bearing tables stay empty: a saved scenario and an
  // evaluation never create a grant, permission or external execution.
  const authority = await (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(authority.outbox.length, 0);
  assert.equal((await (await page.request.get(fixture.base + '/api/artifact-grants')).json()).grants.length, 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(output + '/report.json', JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
} finally {
  await browser?.close();
  await fixture.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
