import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer } from './fixture-server.mjs';
const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startFixtureServer();
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/workspace-validation';
fs.mkdirSync(output, { recursive: true });
let browser;
const checks = [], errors = [];
const check = id => checks.push({ id, passed: true });
try {
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await page.request.get(fixture.base + '/artifacts.js')).status(), 200);
  await page.goto(fixture.base);
  await page.locator('#taskContent [data-select-task]').first().waitFor();
  assert.equal(await page.locator('#viewHome [data-workspace-mode]').count(), 0);
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 0);
  await page.locator('#taskContent [data-select-task]').first().click();
  await page.locator('#taskContent .ws-inspector [data-action="approve"]').waitFor();
  assert.equal(await page.locator('#taskContent .ws-task-page').count(), 1);
  assert.equal(await page.locator('#taskContent .ws-task-index').count(), 0);
  assert.equal(await page.locator('#pageCrumb').textContent(), '任务详情');
  assert.equal(await page.locator('#viewHome .ws-workspace-toolbar').isVisible(), false);
  assert.equal(await page.locator('#viewHome #homeAmbient').isVisible(), false);
  check('task-details-are-a-standalone-page-without-dashboard-content-or-a-task-index');
  check('field-is-default-and-task-details-stay-closed-until-a-card-is-selected');
  const id = await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task');
  const input = () => page.locator('#taskContent [data-direction-input]');
  const detailTab = async name => {
    const label = ({ '概览': /概览|Overview/, '来源依据': /来源依据|Evidence/, '跟进设置': /跟进设置|Follow-up/ })[name] || name;
    const tab = page.locator('#taskContent .detail-focus-navigation [role="tab"]').filter({ hasText: label });
    if (await tab.count() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  };
  const openDirection = async () => {
    await detailTab('概览');
    const disclosure = page.locator('#taskContent [data-direction-disclosure]');
    if (await disclosure.count() && !await disclosure.evaluate(node => node.open)) {
      await disclosure.locator('summary').click();
      await input().waitFor();
    }
  };
  const openTaskGroup = async label => {
    const tab = page.locator('#taskContent .field-focus-nav [role="tab"]').filter({ hasText: label });
    if (await tab.count() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  };
  const modes = ['field', 'index', 'lanes', 'spotlight', 'pulse'];
  const openWorkspaceSettings = async () => {
    const tab = page.locator('#viewPreferences .settings-page .page-focus-nav [role="tab"]').filter({ hasText: /工作台|Workspace/ });
    if (await tab.count() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  };
  const switchMode = async mode => {
    await page.locator('[data-view="preferences"]').click();
    await openWorkspaceSettings();
    await page.selectOption('#workspaceViewOptions', mode);
    await page.locator('[data-view="home"]').click();
  };
  const state = async () => (await page.request.get(fixture.base + '/api/state')).json();
  assert.equal(await page.locator('#taskContent').getAttribute('data-mode'), 'field');
  assert.equal(await page.locator('#taskContent .ws-inspector').count(), 1);
  assert.equal(await page.locator('#taskDialog').count(), 0);
  assert.equal(await page.locator('#taskContent [data-open-task]').count(), 0);
  assert.equal(await page.locator('#taskContent [data-proof]').count(), 0);
  assert.equal(await page.locator('#taskContent [data-snooze], #snoozedSummary').count(), 0);
  const followUpSettings = page.locator('#taskContent details[data-preserve^="ws-management-"]');
  assert.equal(await followUpSettings.count(), 1);
  await detailTab('跟进设置');
  assert.equal(await followUpSettings.locator('[data-wait-form]').count(), 1);
  const evidenceDetails = page.locator('#taskContent details[data-preserve^="full-evidence-"]');
  await detailTab('来源依据');
  assert.match(await evidenceDetails.innerText(), /原始请求的要求.*来源中的对应内容/);
  await detailTab('概览');
  check('one-task-page-keeps-evidence-and-follow-up-settings-without-a-duplicate-record-dialog-or-snooze');
  await openDirection();
  await input().fill('这段方向仍未提交：请包含预算明细。');
  for (const mode of modes) {
    await switchMode(mode);
    assert.equal(await page.locator('#taskContent').getAttribute('data-mode'), mode);
    assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), id);
    assert.equal(await input().inputValue(), '这段方向仍未提交：请包含预算明细。');
  }
  assert.equal((await state()).outbox.length, 0);
  check('five-views-share-selection-and-drafts');
  await switchMode('field');
  await detailTab('来源依据');
  await page.locator('#taskContent [data-task-context="sources"]').click();
  await page.locator('#taskContextDialog[open] .ws-source-reference').first().waitFor();
  assert.equal(await page.locator('#taskContent details.ws-sources').count(), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#taskContextDialog').open);
  assert.equal(await input().inputValue(), '这段方向仍未提交：请包含预算明细。');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.taskContext), 'sources');
  await detailTab('概览');
  await page.locator('#taskContent .ws-composer [data-task-context="memory"]').click();
  assert.equal(await page.locator('#taskContextDialog [data-memory-scope="task"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#taskContextDialog [data-memory-scope="task"]').click();
  await page.locator('#taskContextDialog .secondary-button[data-context-close]').click();
  await page.waitForFunction(() => !document.querySelector('#taskContextDialog').open);
  assert.equal(await input().inputValue(), '这段方向仍未提交：请包含预算明细。');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.ws-composer'))), true);
  check('sources-and-memory-open-in-dialogs-and-return-to-the-same-draft-and-focus');
  await page.locator('#taskContent .ws-composer [data-task-context="memory"]').click();
  await page.locator('#taskContextDialog [data-memory-scope="task"]').click();
  await page.locator('#taskContextDialog .secondary-button[data-context-close]').click();
  await page.waitForFunction(() => !document.querySelector('#taskContextDialog').open);
  await input().fill('在任务页继续编辑');
  // The live fixture exposes one task; multi-task stepper behavior is covered
  // against the synthetic six-task snapshot below.
  assert.equal(await page.locator('#taskContent [data-task-step="1"]').isDisabled(), true);
  assert.equal(await page.locator('#taskContent [data-task-step="-1"]').isDisabled(), true);
  assert.equal(await input().inputValue(), '在任务页继续编辑');
  check('single-task-page-disables-the-stepper-without-touching-the-draft');
  await page.locator('#taskContent .ws-inspector [data-task-control="pause"]').click();
  await page.locator('#taskContent .ws-paused-note').waitFor();
  assert.equal((await state()).tasks.find(task => task.id === id).control.paused, true);
  await page.locator('#taskContent .ws-paused-note [data-task-control="resume"]').click();
  await page.waitForFunction(() => !document.querySelector('#taskContent .ws-paused-note'));
  check('pause-and-resume-change-the-persisted-engine-state');
  await input().fill('Include a budget breakdown.');
  await page.locator('#taskContent .ws-composer button[type="submit"]').click();
  await page.locator('#taskContent .ws-direction-receipt').waitFor();
  await page.waitForFunction(() => !document.querySelector('#taskContent textarea').readOnly);
  let current = await state();
  assert.equal(current.taskMemories.length, 0);
  assert.equal(current.tasks.find(task => task.id === id).draft, null);
  assert.ok(current.tasks.find(task => task.id === id).evidence.criteria.some(item => /budget/i.test(item.label)));
  assert.equal(await input().inputValue(), '');
  await page.locator('#taskContent [data-undo-direction]').click();
  await page.waitForFunction(() => !document.querySelector('#taskContent .ws-direction-receipt'));
  check('direction-replans-invalidates-old-draft-and-undo-restores-without-memory');
  await input().fill('Include a budget breakdown.');
  await page.locator('#taskContent .ws-composer [data-task-context="memory"]').click();
  await page.locator('#taskContextDialog [data-memory-scope="similar"]').click();
  await page.locator('#taskContextDialog .secondary-button[data-context-close]').click();
  await page.waitForFunction(() => !document.querySelector('#taskContextDialog').open);
  await page.locator('#taskContent .ws-composer button[type="submit"]').click();
  await page.locator('#taskContent .ws-direction-receipt').waitFor();
  await page.locator('[data-view="memory"]').click();
  const memoryResults = page.locator('.memory-search-result');
  await memoryResults.first().waitFor();
  assert.equal(await page.locator('.memory-inspector').count(), 0);
  assert.equal(await memoryResults.count(), 1);
  const memorySearch = page.locator('[data-memory-search]');
  await memorySearch.evaluate(input => {
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '火星基地';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '火星基地' }));
    if (!input.isConnected || document.activeElement !== input) throw new Error('Memory search interrupted composition');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '火星基地' }));
  });
  assert.equal(await memorySearch.inputValue(), '火星基地');
  await page.waitForFunction(() => document.querySelectorAll('.memory-search-result').length === 0 && document.querySelector('.memory-empty'));
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-memory-search')), true);
  await memorySearch.fill('');
  await page.waitForFunction(() => document.querySelectorAll('.memory-search-result').length === 1);
  check('memory-search-preserves-ime-composition-and-applies-the-final-query');
  await page.locator('.memory-result-open').first().click();
  await page.locator('.memory-inspector').waitFor();
  await page.waitForFunction(() => document.querySelector('.memory-inspector-context') && !document.querySelector('.memory-inspector-context [role="status"]'));
  assert.equal(await page.locator('.memory-result-open').first().getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('.memory-inspector').innerText(), /Include a budget breakdown\./);
  assert.match(await page.locator('.memory-inspector').innerText(), /适用范围/);
  await page.screenshot({ path: `${output}/memory-populated-1440.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/memory-populated-390.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const relatedTab = page.locator('.memory-inspector .detail-focus-navigation [role="tab"]').filter({ hasText: /关联|Related/ });
  if (await relatedTab.count() && await relatedTab.getAttribute('aria-selected') !== 'true') await relatedTab.click();
  const memoryExplore = page.locator('.memory-inspector [data-memory-explore]');
  if (await memoryExplore.count()) {
    await memoryExplore.click();
    await page.locator('.memory-space-graph').waitFor();
    await page.locator('[data-memory-results]').click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-search-result').length === 1);
  }
  const memoryId = await page.locator('.memory-search-result').getAttribute('data-memory-id');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.memory-inspector'));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.memoryFocus), memoryId);
  check('memory-search-results-share-one-filtered-record-and-inspector');
  current = await state();
  assert.equal(current.taskMemories.filter(memory => !memory.deletedAt).length, 1);
  assert.equal(current.outbox.length, 0);
  check('task-direction-memory-appears-in-the-memory-space-without-extra-writes');
  for (const view of ['memory', 'sources', 'preferences']) {
    await page.locator(`[data-view="${view}"]`).click();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(new URL(page.url()).hash, `#${view}`);
    const name = view[0].toUpperCase() + view.slice(1);
    assert.equal(await page.locator(`#view${name}`).isVisible(), true);
  }
  check('memory-connections-and-settings-are-independent-pages-with-direct-urls');
  await page.locator('[data-view="home"]').click();
  const responsive = [];
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const language of ['zh-CN', 'en']) {
      await page.selectOption('#languageSelect', language);
      for (const mode of modes) {
        await switchMode(mode);
        await openDirection();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${language}/${mode} overflows`);
        const control = page.locator('#taskContent .ws-composer button[type="submit"]');
        assert.equal(await control.isVisible(), true, `${width}/${language}/${mode}: composer submit is visible (${await control.count()} matches)`);
        if (width === 390) for (const box of await page.locator('.sidebar [data-view]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))) {
          assert.ok(box.y >= 0 && box.y + box.height <= 901, 'Every mobile navigation item must be on screen.');
        }
        responsive.push({ width, language, mode });
        if (language === 'en' && [390, 1440].includes(width)) await page.screenshot({ path: `${output}/${mode}-${width}.png`, fullPage: true, animations: 'disabled' });
      }
      await detailTab('来源依据');
      await page.locator('#taskContent [data-task-context="sources"]').click();
      const bounds = await page.locator('#taskContextDialog').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.keyboard.press('Escape');
    }
  }
  check('40-responsive-language-view-combinations-preserve-controls-without-page-overflow');
  fs.writeFileSync(`${output}/responsive.json`, JSON.stringify(responsive, null, 2));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await switchMode('lanes');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#taskContent')?.dataset.mode === 'lanes');
  check('explicit-view-choice-survives-reload');
  await page.locator('#themeToggle').click();
  await page.locator('#taskContent [data-select-task]').first().click();
  const darkActionContrast = await page.locator('#taskContent .ws-composer .primary-button').evaluate(button => {
    const style = getComputedStyle(button);
    const luminance = color => {
      const channels = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  assert.ok(darkActionContrast >= 4.5, `Dark-mode decision action contrast is ${darkActionContrast}`);
  await page.screenshot({ path: `${output}/lanes-dark-1440.png`, fullPage: true, animations: 'disabled' });
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  check('appearance-choice-survives-reload');
  // Controlled live updates exercise concurrency and composition without
  // changing the real fixture store or contacting an external provider.
  await page.addInitScript(() => {
    window.__workspaceStreams = [];
    window.EventSource = class { constructor() { window.__workspaceStreams.push(this); setTimeout(() => this.onopen?.(), 0); } close() {} };
  });
  await page.reload();
  await page.waitForFunction(() => window.__workspaceStreams?.at(-1)?.onmessage && document.querySelector('#taskContent [data-select-task]'));
  const snapshot = await state();
  const original = structuredClone(snapshot.tasks[0]);
  const make = (id, subject, status, extra = {}) => ({ ...structuredClone(original), id, subject, status, action: null, guidance: null, control: null, reasoning: null, draft: null, ...extra });
  snapshot.tasks = [
    make('needs', 'Reply to Mei', 'ready_for_approval', { draft: { to: 'mei@example.test', subject: 'Re: update', body: 'A source-backed fixture draft.', canSend: false }, reviewToken: 'a'.repeat(64) }),
    make('working-a', 'Compare renovation quotes', 'investigating'),
    make('working-b', 'Prepare Friday briefing', 'investigating'),
    make('waiting', 'Follow up on the report', 'waiting_for_information'),
    make('paused', 'Review October expenses', 'waiting_for_information', { control: { paused: true } }),
    make('verified', 'Send the revised proposal', 'completed', { action: { status: 'verified_simulated' } })
  ];
  snapshot.notifications = [];
  snapshot.history = snapshot.tasks.map((task, index) => ({ id: `visual-${index}`, taskId: task.id, kind: task.id === 'verified' ? 'completion' : task.id === 'paused' ? 'task_paused' : 'assessment', text: 'Recorded fixture change', at: new Date(Date.now() - index * 60000).toISOString() }));
  const emit = async () => { snapshot.revision++; await page.evaluate(value => window.__workspaceStreams.at(-1).onmessage({ data: JSON.stringify(value) }), snapshot); };
  await emit();
  await switchMode('field');
  await openTaskGroup(/进行中|In motion/);
  await page.locator('[data-select-task="working-a"]').click();
  assert.equal(await page.locator('#viewHome .ws-inspector h1').count(), 1);
  await page.screenshot({ path: `${output}/field-quiet-1440.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar')).flexDirection === 'row');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.topbar').count(), 1);
  await page.screenshot({ path: `${output}/field-quiet-390.png`, fullPage: true, animations: 'disabled' });
  const targetSizes = await page.locator('#taskContent .ws-task-controls .icon-button, #taskContent .ws-task-step').evaluateAll(nodes => nodes.map(node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height]));
  assert.equal(targetSizes.every(([width, height]) => width >= 44 && height >= 44), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDirection();
  await input().waitFor();
  assert.equal(await page.locator('#taskContent [data-satisfied-evidence]').getAttribute('open'), null);
  assert.equal(await page.locator('#taskContent [data-satisfied-evidence] [data-check="met"]').count(), 6);
  assert.equal(await page.locator('#taskContent .ws-checklist > ul > [data-check="missing"]').count(), 1);
  await detailTab('来源依据');
  assert.equal(await page.locator('#taskContent .ws-source-chip').count(), 1);
  await detailTab('概览');
  await input().fill('仍在输入，请保留光标');
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); return !dispatchEvent(event) && event.defaultPrevented; }), true);
  await input().evaluate(node => node.setSelectionRange(2, 5));
  const retained = await input().elementHandle();
  await input().dispatchEvent('compositionstart', { data: '输入' });
  snapshot.tasks[1].updatedAt = new Date().toISOString();
  await emit();
  assert.equal(await retained.evaluate(node => node.isConnected), true);
  await input().dispatchEvent('compositionend', { data: '输入' });
  assert.deepEqual(await input().evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]), ['仍在输入，请保留光标', 2, 5, true]);
  await page.locator('[data-task-step="1"]').click();
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'working-b');
  await openDirection();
  await input().fill('另一件事的独立草稿');
  await page.locator('[data-task-step="-1"]').click();
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'working-a');
  assert.equal(await input().inputValue(), '仍在输入，请保留光标');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'needs');
  assert.equal(await page.locator('[data-task-step="-1"]').isDisabled(), true);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'needs');
  await input().fill('Keyboard input must not change tasks');
  await input().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'needs');
  await page.locator('.ws-detail-drawer').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'working-a');
  assert.equal(await input().inputValue(), '仍在输入，请保留光标');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'working-b');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#taskContent [data-inspector-task]').getAttribute('data-inspector-task'), 'working-a');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#taskContent .ws-task-page').count(), 0);
  assert.equal(await page.locator('#viewHome .ws-workspace-toolbar').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.selectTask), 'working-a');
  await page.locator('[data-select-task="working-a"]').click();
  check('task-steppers-and-arrow-keys-respect-order-bounds-input-focus-and-return-focus');
  check('arrow-keys-move-between-task-pages-and-preserve-drafts');
  check('draft-caret-and-ime-preservation');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of modes) {
      await switchMode(mode);
      await page.evaluate(() => { document.querySelector('#toast').className = 'toast'; window.scrollTo(0, 0); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${output}/${mode}-populated-${width}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await switchMode('field');
  await page.locator('[data-view="preferences"]').click();
  await openWorkspaceSettings();
  await page.selectOption('#workspaceViewOptions', 'index');
  assert.equal(await page.locator('#taskContent').getAttribute('data-mode'), 'index');
  await page.locator('[data-view="home"]').click();
  await page.locator('[data-close-inspector]').click();
  await page.locator('#viewHome h1').focus();
  await page.keyboard.press('Alt+3');
  assert.equal(await page.locator('#taskContent').getAttribute('data-mode'), 'lanes');
  check('view-selection-lives-in-settings-and-retains-alt-number-shortcuts');
  assert.deepEqual(errors, []);
  check('no-browser-runtime-errors');
} catch (error) {
  checks.push({ id: 'failure', passed: false, message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${output}/workspace-contract.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
  await browser?.close(); await fixture.close();
}
