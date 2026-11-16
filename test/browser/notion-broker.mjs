// Maintained browser regression for the provisioned Notion broker path.
// The product server, Setup store, CodeOAuth loopback callback, private
// authorization save and public UI all run for real. Only the broker and the
// initial Notion search are synthetic; nothing here validates a real account
// or network. Root runs this after the writer modules settle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../src/notion-broker-protocol.js';
import {
  NOTION_ACCESS_TOKEN, NOTION_ACCOUNT, NOTION_BROKER_ORIGIN, NOTION_FIXTURE_CLIENT_ID,
  NOTION_REFRESH_TOKEN, startNotionBrokerFixture
} from '../fixtures/notion-broker-browser.mjs';

const { chromium } = await import(process.env.UNPROMPTED_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.UNPROMPTED_BROWSER_OUTPUT || 'outputs/notion-broker-189';
fs.mkdirSync(output, { recursive: true });

const checks = [], pageErrors = [], externalAttempts = [], brokerUnexpectedBrowser = [], routeFailures = [];
const authorizationRequests = [], consentRequests = [];
let fixture, browser, context, page, failure = null;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const attribute = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const record = id => checks.push({ id, passed: true });

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(75);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readSetup() {
  const response = await page.request.get(`${fixture.base}/api/setup`);
  assert.equal(response.status(), 200, 'setup status is readable');
  return response.json();
}

async function waitForPhase(phase, timeoutMs = 20_000) {
  return waitFor(async () => {
    const setup = await readSetup();
    return setup.connections?.notion?.oauth?.phase === phase ? setup : null;
  }, `the Notion OAuth phase ${phase}`, timeoutMs);
}

function assertNoPrivate(text, where, extraValues = []) {
  const value = String(text);
  for (const key of ['clientSecret', 'refreshToken', 'accessToken', 'refreshCapability', 'refreshProof']) {
    assert.ok(!value.includes(key), `${where} exposed a private field name`);
  }
  assert.ok(!value.includes(NOTION_ACCESS_TOKEN), `${where} exposed the synthetic access token`);
  assert.ok(!value.includes(NOTION_REFRESH_TOKEN), `${where} exposed the synthetic refresh token`);
  extraValues.filter(Boolean).forEach((extra, index) => {
    assert.ok(!value.includes(extra), `${where} exposed private fixture value ${index + 1}`);
  });
}

async function openNotion() {
  await page.locator('[data-view="sources"]').click();
  const card = page.locator('#connectorContent [data-connection-card="notion"][data-selected="true"]');
  const row = page.locator('#connectorContent [data-inspect-connection="notion"]');
  // At narrow widths the intended responsive focus view hides the source list
  // while the selected Notion detail stays open. Use that visible card or the
  // real row interaction; never click a hidden node.
  await page.waitForFunction(() => {
    const node = selector => document.querySelector(selector);
    const selectedCard = node('#connectorContent [data-connection-card="notion"][data-selected="true"]');
    const listRow = node('#connectorContent [data-inspect-connection="notion"]');
    const visible = element => Boolean(element && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden');
    return visible(selectedCard) || visible(listRow);
  }, null, { timeout: 20_000 });
  if (await card.isVisible()) return card;
  await row.click();
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  return card;
}

async function startNotionConnect() {
  const card = await openNotion();
  const submit = card.locator('form[data-connection-form="notion"] button[type="submit"]');
  await submit.waitFor();
  const popupPromise = page.waitForEvent('popup');
  await submit.click();
  const popup = await popupPromise;
  await popup.locator('#grant-form').waitFor({ timeout: 15_000 });
  return { card, popup };
}

async function returnToParent(popup) {
  try {
    if (popup && !popup.isClosed()) await popup.close();
  } catch { /* the app may already have closed the completed popup */ }
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 5_000, polling: 100 });
}

const NOTICE_TEXT = {
  failed: {
    en: 'Authorization did not finish. You can connect again.',
    zh: '授权没有完成，可以重新连接。'
  },
  expired: {
    en: 'The code expired. Connect again to get a new one.',
    zh: '授权码已过期，重新连接会生成新的授权码。'
  }
};

async function waitForCardWithoutCredentials(phase, description) {
  // The visible setup fallback poll runs every 15 s. The detail-focus layer
  // rewrites a card child's role to tabpanel, so the stable user-facing
  // contract is the exact visible localized notice text, not its ARIA role.
  const language = await page.evaluate(() => document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const expected = NOTICE_TEXT[phase][language];
  await page.waitForFunction(text => {
    const card = document.querySelector('#connectorContent [data-connection-card="notion"]');
    return Boolean(card && card.innerText.includes(text)
      && !card.querySelector('input[name="clientId"]') && !card.querySelector('input[name="clientSecret"]'));
  }, expected, { timeout: 25_000, polling: 100 });
  const card = page.locator('#connectorContent [data-connection-card="notion"]');
  assert.equal(await card.locator('input[name="clientId"]').count(), 0, `${description}: no Client ID field`);
  assert.equal(await card.locator('input[name="clientSecret"]').count(), 0, `${description}: no Client Secret field`);
  assert.equal(await card.locator('form[data-connection-form="notion"] button[type="submit"]').isEnabled(), true,
    `${description}: retry remains available`);
  return card;
}

async function collectSseOnce() {
  return page.evaluate(() => new Promise(resolve => {
    const frames = [];
    const source = new EventSource('/api/stream');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { source.close(); } catch { /* already closed */ }
      resolve(frames.join('\n'));
    };
    const timer = setTimeout(finish, 4_000);
    source.onmessage = event => {
      frames.push(event.data);
      clearTimeout(timer);
      setTimeout(finish, 100);
    };
    source.onerror = () => { clearTimeout(timer); finish(); };
  }));
}

function browserConsentPage(session) {
  const form = (id, code, label) => `<form id="${id}-form" method="get" action="${attribute(session.redirectUri)}">`
    + `<input type="hidden" name="state" value="${attribute(session.clientState)}">`
    + `<input type="hidden" name="code" value="${attribute(code)}">`
    + `<button id="${id}" type="submit">${label}</button></form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic Notion broker consent</title>`
    + '<link rel="icon" href="data:,"></head><body>'
    + '<p>Test fixture only. No real Notion account or consent is used.</p>'
    + form('grant', session.handoffCode, 'Grant synthetic access')
    + form('fail', 'x'.repeat(43), 'Simulate a failed handoff')
    + '</body></html>';
}

try {
  fixture = await startNotionBrokerFixture({ root: process.env.UNPROMPTED_NOTION_BROWSER_ROOT });
  browser = await chromium.launch({ channel: process.env.UNPROMPTED_BROWSER_CHANNEL || undefined, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/setup/connections/notion/authorize') {
      try { authorizationRequests.push(request.postDataJSON()); }
      catch { authorizationRequests.push({}); }
    }
  });

  await context.route(/^https?:\/\//, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === fixture.base || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase())) {
      return route.continue();
    }
    if (url.origin === NOTION_BROKER_ORIGIN) {
      if (url.pathname === PATHS.authorize) {
        const state = fixture.readState();
        const session = state.sessions.find(item => item.id === url.searchParams.get('session'));
        if (!session) {
          routeFailures.push('the synthetic broker authorize URL did not match a private fixture session');
          return route.fulfill({ status: 500, contentType: 'text/plain; charset=utf-8', body: 'Missing synthetic broker session.' });
        }
        consentRequests.push(`${url.origin}${url.pathname}`);
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: browserConsentPage(session) });
      }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      brokerUnexpectedBrowser.push({ path: url.pathname });
      return route.abort('blockedbyclient');
    }
    externalAttempts.push(url.origin);
    return route.abort('blockedbyclient');
  });

  await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
  await page.locator('#languageSelect').selectOption('en');

  const initial = await readSetup();
  const initialNotion = initial.connections.notion;
  assert.equal(initialNotion.configured, true);
  assert.equal(initialNotion.authMode, 'broker');
  assert.equal(initialNotion.clientId, NOTION_FIXTURE_CLIENT_ID);
  assert.equal(initialNotion.authorized, false);
  assert.equal(initialNotion.connected, false);
  assert.equal(Object.hasOwn(initialNotion, 'clientSecret'), false);
  assertNoPrivate(JSON.stringify(initial), '/api/setup initial');
  const initialCard = await openNotion();
  assert.equal(await initialCard.locator('input[name="clientId"]').count(), 0);
  assert.equal(await initialCard.locator('input[name="clientSecret"]').count(), 0);
  assert.equal(await initialCard.locator('[data-mcp-oauth="notion"]').count(), 0);
  record('provisioned-broker-is-public-configured-and-never-asks-for-publisher-credentials');

  const failedAttempt = await startNotionConnect();
  await failedAttempt.popup.locator('#fail').click();
  const failedSetup = await waitForPhase('failed');
  await returnToParent(failedAttempt.popup);
  assert.equal(failedSetup.connections.notion.configured, true);
  assert.equal(failedSetup.connections.notion.authMode, 'broker');
  assertNoPrivate(JSON.stringify(failedSetup), '/api/setup after failed broker phase');
  await waitForCardWithoutCredentials('failed', 'failed broker authorization');
  record('failed-broker-phase-keeps-retry-without-publisher-credential-fields');

  fixture.setControls({ shortSession: true });
  const expiredAttempt = await startNotionConnect();
  await expiredAttempt.popup.locator('#grant-form').waitFor({ timeout: 10_000 });
  const expiredSetup = await waitForPhase('expired', 20_000);
  fixture.setControls({ shortSession: false });
  await returnToParent(expiredAttempt.popup);
  assert.equal(expiredSetup.connections.notion.configured, true);
  assert.equal(expiredSetup.connections.notion.authMode, 'broker');
  assertNoPrivate(JSON.stringify(expiredSetup), '/api/setup after expired broker phase');
  await waitForCardWithoutCredentials('expired', 'expired broker authorization');
  record('expired-broker-phase-keeps-retry-without-publisher-credential-fields');

  const successfulAttempt = await startNotionConnect();
  await successfulAttempt.popup.locator('#grant').click();
  const connectedSetup = await waitForPhase('connected', 25_000);
  await returnToParent(successfulAttempt.popup);
  const connectedNotion = connectedSetup.connections.notion;
  assert.equal(connectedNotion.connected, true);
  assert.equal(connectedNotion.authorized, true);
  assert.equal(connectedNotion.authMode, 'broker');
  assert.equal(connectedNotion.account?.label, NOTION_ACCOUNT.label);
  assert.equal(connectedNotion.capabilities?.observation, 'poll');
  assert.ok(connectedNotion.capabilities?.read?.includes('notion.pages'));
  await page.waitForFunction(label => document.querySelector('#connectorContent [data-connection-card="notion"]')?.textContent.includes(label),
    NOTION_ACCOUNT.label, { timeout: 25_000, polling: 100 });
  const connectedCard = page.locator('#connectorContent [data-connection-card="notion"]');
  assert.equal(await connectedCard.getAttribute('data-state'), 'connected');
  assert.equal(await connectedCard.locator('[name="observe"]').isChecked(), true);
  assert.equal(await connectedCard.locator('[data-mcp-oauth="notion"]').count(), 0);
  assert.equal(await connectedCard.locator('input[name="clientId"]').count(), 0);
  assert.equal(await connectedCard.locator('input[name="clientSecret"]').count(), 0);
  assert.ok(!(await connectedCard.innerText()).includes('does not automatically observe page changes'));

  const stateResponse = await page.request.get(`${fixture.base}/api/state`);
  assert.equal(stateResponse.status(), 200);
  const publicState = await stateResponse.json();
  const dom = await page.content();
  const sse = await collectSseOnce();
  assert.ok(sse.length > 0, 'the existing SSE stream is available');
  const brokerState = fixture.readState();
  const redeemed = brokerState.sessions.find(item => item.status === 'redeemed' || item.status === 'refreshed');
  assert.ok(redeemed, 'the synthetic broker redeemed exactly the actual loopback callback');
  const privateValues = [redeemed.grantId, redeemed.capability, redeemed.proof, redeemed.handoffCode];
  assertNoPrivate(JSON.stringify(connectedSetup), '/api/setup after connection', privateValues);
  assertNoPrivate(JSON.stringify(publicState), '/api/state after connection', privateValues);
  assertNoPrivate(dom, 'DOM after connection', privateValues);
  assertNoPrivate(sse, 'SSE after connection', privateValues);
  for (const [name, surface] of [['/api/setup', JSON.stringify(connectedSetup)], ['/api/state', JSON.stringify(publicState)],
    ['DOM', dom], ['SSE', sse]]) {
    assert.ok(!surface.includes(NOTION_BROKER_ORIGIN), `${name} did not expose broker diagnostics`);
  }
  for (const body of authorizationRequests) {
    assert.equal(Object.hasOwn(body, 'clientId'), false, 'the UI never submits a Client ID in broker mode');
    assert.equal(Object.hasOwn(body, 'clientSecret'), false, 'the UI never submits a Client Secret in broker mode');
  }
  assert.equal(brokerState.brokerUnexpected.length, 0);
  assert.equal(brokerState.blocked.length, 0);
  assert.ok(brokerState.notionCalls.length >= 1);
  assert.ok(brokerState.notionCalls.every(call => call.path === '/v1/search'));
  record('actual-code-oauth-loopback-redeem-saves-broker-account-with-native-observe-and-no-private-material');

  const sqliteHeader = fs.readFileSync(fixture.workspaceFile).subarray(0, 16);
  assert.deepEqual(sqliteHeader, Buffer.from('SQLite format 3\0'));
  record('browser-path-runs-on-the-persistent-sqlite-workspace');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#languageSelect').selectOption('en');
  const reloadedCard = await openNotion();
  await page.waitForFunction(label => document.querySelector('#connectorContent [data-connection-card="notion"]')?.textContent.includes(label),
    NOTION_ACCOUNT.label, { timeout: 20_000 });
  assert.equal((await readSetup()).connections.notion.connected, true);
  assert.equal(await reloadedCard.locator('[data-mcp-oauth="notion"]').count(), 0);
  record('broker-connection-survives-a-page-reload');

  const forgetCard = await openNotion();
  await forgetCard.locator('[data-provider-operation="forget"]').click();
  await waitFor(async () => {
    const setup = await readSetup();
    return setup.connections.notion.authorized === false && setup.connections.notion.connected === false ? setup : null;
  }, 'the connection to be forgotten');
  await waitFor(() => fixture.readState().revokes.length >= 1, 'the best-effort broker revoke');
  const forgottenSetup = await readSetup();
  assert.equal(forgottenSetup.connections.notion.configured, true);
  assert.equal(forgottenSetup.connections.notion.authMode, 'broker');
  assert.equal(forgottenSetup.connections.notion.account, null);
  assertNoPrivate(JSON.stringify(forgottenSetup), '/api/setup after forget');
  const savedSetup = JSON.parse(fs.readFileSync(path.join(fixture.directory, 'config', 'setup.json'), 'utf8'));
  assert.deepEqual(savedSetup.connections.notion, { clientId: NOTION_FIXTURE_CLIENT_ID, brokerUrl: NOTION_BROKER_ORIGIN });
  assertNoPrivate(JSON.stringify(savedSetup.connections.notion), 'private setup after forget');
  await page.waitForFunction(() => {
    const card = document.querySelector('#connectorContent [data-connection-card="notion"]');
    return Boolean(card && !card.querySelector('[data-provider-operation="forget"]')
      && card.querySelector('form[data-connection-form="notion"] button[type="submit"]')
      && !card.querySelector('input[name="clientId"]') && !card.querySelector('input[name="clientSecret"]'));
  }, null, { timeout: 10_000 });
  record('forget-clears-private-authorization-immediately-and-retains-only-the-public-descriptor');

  const reconnectAttempt = await startNotionConnect();
  await reconnectAttempt.popup.locator('#grant').click();
  const reconnectedSetup = await waitForPhase('connected', 25_000);
  await returnToParent(reconnectAttempt.popup);
  assert.equal(reconnectedSetup.connections.notion.account?.label, NOTION_ACCOUNT.label);
  assert.equal(reconnectedSetup.connections.notion.authMode, 'broker');
  const reconnectedBroker = fixture.readState();
  const oldGrant = reconnectedBroker.sessions.find(item => item.grantId === redeemed.grantId);
  assert.equal(oldGrant?.status, 'revoked', 'forget revokes the previous broker grant');
  assert.ok(reconnectedBroker.revokes.some(item => item.grantId === redeemed.grantId), 'the revoke names the previous grant');
  const activeReconnectedGrants = reconnectedBroker.sessions.filter(item => item.status === 'redeemed' || item.status === 'refreshed');
  assert.equal(activeReconnectedGrants.length, 1, 'reconnect leaves exactly one active broker grant');
  assert.notEqual(activeReconnectedGrants[0].grantId, redeemed.grantId, 'reconnect binds a new distinct broker grant');
  assertNoPrivate(JSON.stringify(reconnectedSetup), '/api/setup after reconnect');
  assert.equal(authorizationRequests.length, 4);
  for (const body of authorizationRequests) {
    assert.equal(Object.hasOwn(body, 'clientId'), false);
    assert.equal(Object.hasOwn(body, 'clientSecret'), false);
  }
  record('native-reconnect-after-forget-uses-the-provisioned-broker-without-credential-fields');

  for (const language of ['en', 'zh-CN']) {
    await page.locator('#languageSelect').selectOption(language);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const card = await openNotion();
      await page.waitForFunction(label => document.querySelector('#connectorContent [data-connection-card="notion"]')?.textContent.includes(label),
        NOTION_ACCOUNT.label, { timeout: 10_000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
        `${language}/${width} has no horizontal overflow`);
      assert.equal(await card.locator('input[name="clientId"]').count(), 0);
      assert.equal(await card.locator('input[name="clientSecret"]').count(), 0);
      assert.equal(await card.locator('[name="observe"]').isChecked(), true);
      assert.equal(await card.locator('[data-mcp-oauth="notion"]').count(), 0);
      assertNoPrivate(await page.content(), `DOM ${language}/${width}`);
      await page.screenshot({ path: `${output}/notion-broker-${language === 'zh-CN' ? 'zh' : 'en'}-${width}.png`,
        fullPage: width === 1440, animations: 'disabled' });
    }
  }
  record('english-chinese-desktop-and-narrow-layouts-keep-the-native-observe-path');

  assert.deepEqual(errorsForReport(), []);
  assert.deepEqual(externalAttempts, []);
  assert.deepEqual(brokerUnexpectedBrowser, []);
  assert.deepEqual(routeFailures, []);
  assert.equal(consentRequests.length >= 4, true);
} catch (error) {
  failure = error;
  process.exitCode = 1;
  try {
    if (page) await page.screenshot({ path: `${output}/notion-broker-failure.png`, fullPage: true, animations: 'disabled' });
  } catch { /* preserve the original failure */ }
} finally {
  let brokerState = null;
  try { brokerState = fixture?.readState() || null; } catch { /* preserve cleanup */ }
  try { await context?.close(); } catch { /* cleanup remains best effort */ }
  try { await browser?.close(); } catch { /* cleanup remains best effort */ }
  try { await fixture?.close(); } catch { /* cleanup remains best effort */ }
  const summary = {
    task: '#189 Notion broker connection UI and maintained browser regression',
    evidenceScope: 'synthetic broker and Notion search fixture; actual product server, CodeOAuth loopback, setup save and UI',
    realNetwork: false,
    browser: 'headless Chromium',
    checks,
    failure: failure ? { message: failure.message, stack: failure.stack } : null,
    pageErrors: errorsForReport(),
    externalAttempts,
    brokerUnexpectedBrowser,
    routeFailures,
    brokerConsents: consentRequests.length,
    authorizationRequests: authorizationRequests.map(body => ({
      keys: Object.keys(body).sort(),
      hasClientId: Object.hasOwn(body, 'clientId'),
      hasClientSecret: Object.hasOwn(body, 'clientSecret'),
      observe: body.observe === true
    })),
    fixture: brokerState ? {
      requests: brokerState.requests,
      brokerUnexpected: brokerState.brokerUnexpected,
      notionCalls: brokerState.notionCalls,
      blocked: brokerState.blocked,
      revokes: brokerState.revokes.length,
      refreshes: brokerState.refreshes.length,
      sessionStatuses: brokerState.sessions.map(session => session.status)
    } : null
  };
  fs.writeFileSync(path.join(output, 'notion-broker-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

function errorsForReport() {
  return pageErrors;
}
