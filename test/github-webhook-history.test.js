import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { DurableRuntime } from '../src/durable/runtime.js';
import { CursorStore, Connector, toNormalizedEvents } from '../src/connectors/connector.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { GitHubWebhookService, GITHUB_WEBHOOK_PATH } from '../src/github-webhooks.js';
import { LocalSetupStore } from '../src/setup.js';

/**
 * History discovery is a second provider entry point inside the same
 * `runConnector` call as the normal webhook pull. These tests use the real
 * SQLite store, the real DurableRuntime, the real ConnectorSync and the real
 * webhook receiver, with a controlled history promise, so a late page after an
 * authorization change is observed at the real ingest boundary. No GitHub
 * account, network or provider traffic is involved.
 */

const SECRET = '{{SECRET_h1s70ryf3nc3}}';
const ACCOUNT_ID = '4242';
const REPOSITORY = 'acme/widgets';

const temporaryDirectories = [];
test.after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-webhook-history-'));
  temporaryDirectories.push(directory);
  return directory;
}

const sign = body => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

function historyEvent() {
  return toNormalizedEvents('github', 'github', [{
    type: 'issue.updated', providerEventId: 'history-late', providerRevision: 'rev-history-late', at: '2026-11-13T00:00:00.000Z',
    payload: { id: `github:${ACCOUNT_ID}:history-late`, title: 'History discovery item', body: '', bodyTruncated: false,
      repository: REPOSITORY, number: 7, state: 'open', assigned: true, assignee: 'octocat',
      accountId: ACCOUNT_ID, updatedAt: '2026-11-13T00:00:00.000Z',
      url: `https://github.com/${REPOSITORY}/issues/7`, author: 'octocat', providerIssueId: '555' }
  }])[0];
}

/**
 * A live GitHub connector whose normal pull succeeds immediately and whose
 * history discovery can be held open. `holdNextHistory` gates exactly one
 * history call, so a retry after recovery performs a fresh, unblocked pull.
 */
class HistoryConnector extends Connector {
  constructor() {
    super({ id: 'github', kind: 'github' });
    this.live = true;
    this.account = { id: ACCOUNT_ID, login: 'octocat' };
    this.pullCalls = [];
    this.historyCalls = 0;
    this.holdNextHistory = false;
    this.releaseHistory = null;
    this.lastHistorySignal = null;
  }
  async pull({ cursor = null } = {}) {
    this.pullCalls.push(cursor);
    return { events: [], cursor: { page: this.pullCalls.length }, errors: [], partial: false, hasMore: false };
  }
  async listHistoricalEvents({ signal = null } = {}) {
    this.historyCalls += 1;
    this.lastHistorySignal = signal;
    if (this.holdNextHistory) {
      this.holdNextHistory = false;
      await new Promise(resolve => { this.releaseHistory = resolve; });
    }
    return { events: [historyEvent()], networkCalls: 1, unavailable: false };
  }
  release() {
    const release = this.releaseHistory;
    this.releaseHistory = null;
    release?.();
  }
}

function fixture(t, options = {}) {
  const directory = temporaryDirectory();
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  setup.setMonitoring({ enabled: true, intervalMs: 60_000 });
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store);
  const connector = options.connector || new HistoryConnector();
  const runtime = new DurableRuntime(engine, {
    connectorFor: id => id === 'github' ? connector : null,
    artifactConnectionFor: () => null,
    tickMs: 100_000
  });
  const cursors = new CursorStore(store);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });
  const account = { id: ACCOUNT_ID };
  const lifecycle = options.lifecycle || (() => 'running');
  const serviceOptions = () => ({
    store,
    setup,
    getRuntime: () => ({ connectors: [connector] }),
    getSync: () => sync,
    getAccountId: () => account.id,
    getLifecycle: lifecycle,
    config: {
      enabled: true, configured: true, code: null, secret: SECRET,
      repositories: new Set([REPOSITORY.toLowerCase()]), accountId: ACCOUNT_ID
    }
  });
  const service = new GitHubWebhookService(serviceOptions());
  t.after(async () => {
    // A failed assertion may leave a controlled history promise held. Release
    // it first so the worker close below cannot wait forever.
    connector.release();
    await service.stop();
    if (!runtime.closed) await runtime.close();
    store.close();
  });
  return { directory, setup, store, engine, connector, runtime, cursors, sync, service, serviceOptions, account };
}

async function startServer(t, service) {
  const server = http.createServer((req, res) => {
    service.handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request failed.', code: error.code || 'REQUEST_FAILED' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  return {
    async post(body) {
      const payload = JSON.stringify(body);
      const response = await fetch(`http://127.0.0.1:${port}${GITHUB_WEBHOOK_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(payload),
          'x-github-delivery': randomUUID(),
          'x-github-event': 'issues'
        },
        body: payload
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }
  };
}

const issuePayload = (marker = '') => ({
  action: 'opened',
  repository: { id: 991, full_name: REPOSITORY },
  issue: { id: 555, number: 7, title: `${marker}Synthetic issue` }
});

async function waitFor(predicate, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

const receiptOf = context => context.store.db.prepare(
  'SELECT state,error_code FROM github_webhook_receipts ORDER BY rowid DESC LIMIT 1').get();
const completedReceipts = context => context.store.db.prepare(
  "SELECT COUNT(*) n FROM github_webhook_receipts WHERE state='completed'").get().n;
const githubEvents = context => context.store.state.events.filter(event => event.connectorId === 'github');
const githubEventIds = context => githubEvents(context).map(event => event.providerEventId);
const taskCount = context => context.store.db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
const backfillSeenKeys = context => context.store.db.prepare(
  "SELECT key FROM metadata WHERE key LIKE 'backfill-seen:%'").all().map(row => row.key);

test('a controlled history page completes through the real runtime and ingests once', async t => {
  const context = fixture(t);
  context.service.start();
  const server = await startServer(t, context.service);
  context.connector.holdNextHistory = true;

  assert.equal((await server.post(issuePayload())).status, 202);
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');

  // The normal page was authorized when it arrived and commits before history.
  assert.equal(context.cursors.get('github').page, 1);
  assert.ok(context.connector.lastHistorySignal instanceof AbortSignal,
    'the trusted stop signal must reach history discovery');

  context.connector.release();
  await waitFor(() => receiptOf(context)?.state === 'completed', 'the receipt never completed');
  assert.deepEqual(githubEventIds(context), ['history-late']);
  assert.equal(taskCount(context), 1);
  assert.equal(backfillSeenKeys(context).length, 1);
  assert.equal(context.cursors.get('github').page, 1);
});

test('a history page that finishes after the account changed neither ingests nor completes', async t => {
  const context = fixture(t);
  context.service.start();
  const server = await startServer(t, context.service);
  context.connector.holdNextHistory = true;

  assert.equal((await server.post(issuePayload())).status, 202);
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  context.account.id = '9999';
  context.connector.release();

  await waitFor(() => receiptOf(context)?.state === 'expired', 'the late history page completed for the old account');
  assert.equal(receiptOf(context).error_code, 'authorization_changed');
  assert.deepEqual(githubEventIds(context), [], 'the abandoned history page must not be ingested');
  assert.equal(taskCount(context), 0, 'the abandoned history page must not create work');
  assert.equal(backfillSeenKeys(context).length, 0, 'an abandoned history page must not mark itself seen');
  assert.equal(context.cursors.get('github').page, 1, 'the already committed normal page must not be rolled back');
  assert.equal(context.connector.historyCalls, 1);
});

test('a history page that finishes after observation paused is discarded and resumes once', async t => {
  const context = fixture(t);
  context.service.start();
  const server = await startServer(t, context.service);
  context.connector.holdNextHistory = true;

  assert.equal((await server.post(issuePayload())).status, 202);
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  context.setup.setMonitoring({ enabled: false });
  context.connector.release();

  await waitFor(() => receiptOf(context)?.state === 'paused', 'the late history page completed while paused');
  assert.equal(receiptOf(context).error_code, 'monitoring_paused');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1);

  // An explicit resume retries the retained receipt and discovers history once.
  context.setup.setMonitoring({ enabled: true });
  await context.service.refresh();
  await context.service.kick();
  await waitFor(() => receiptOf(context)?.state === 'completed', 'the resumed receipt never completed', 10_000);
  assert.equal(context.connector.historyCalls, 2, 'the resume performs exactly one fresh history discovery');
  assert.deepEqual(githubEventIds(context), ['history-late']);
  assert.equal(taskCount(context), 1);
  assert.equal(backfillSeenKeys(context).length, 1);

  // The per-epoch once marker prevents a later delivery from repeating history.
  assert.equal((await server.post(issuePayload('later-'))).status, 202);
  await waitFor(() => completedReceipts(context) === 2, 'the later delivery never completed', 10_000);
  assert.equal(context.connector.historyCalls, 2, 'history discovery must not repeat in the same privacy epoch');
  assert.deepEqual(githubEventIds(context), ['history-late']);
  assert.equal(taskCount(context), 1);
});

test('a history page that finishes while the lifecycle is blocked retries and completes after unblock', async t => {
  let lifecycle = 'running';
  const context = fixture(t, { lifecycle: () => lifecycle });
  context.service.start();
  const server = await startServer(t, context.service);
  context.connector.holdNextHistory = true;

  assert.equal((await server.post(issuePayload())).status, 202);
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  lifecycle = 'blocked';
  context.connector.release();

  await waitFor(() => context.store.db.prepare("SELECT state FROM jobs WHERE queue_name='webhooks'").get()?.state === 'retry_wait',
    'the blocked history page did not defer the job');
  assert.equal(receiptOf(context).state, 'queued');
  assert.equal(receiptOf(context).error_code, 'lifecycle_blocked');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1);

  lifecycle = 'running';
  await waitFor(() => receiptOf(context)?.state === 'completed', 'the receipt never completed after the lifecycle resumed', 12_000);
  assert.equal(context.connector.historyCalls, 2, 'the retry performs exactly one fresh history discovery');
  assert.deepEqual(githubEventIds(context), ['history-late']);
  assert.equal(taskCount(context), 1);
  assert.equal(backfillSeenKeys(context).length, 1);
});

test('a history page that finishes after permission was revoked neither ingests nor completes', async t => {
  const context = fixture(t);
  context.service.start();
  const server = await startServer(t, context.service);
  context.connector.holdNextHistory = true;

  assert.equal((await server.post(issuePayload())).status, 202);
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  await context.runtime.privacy.revokePermission({ connectorId: 'github', purgeLocal: false });
  context.connector.release();

  await waitFor(() => receiptOf(context)?.state === 'expired', 'the late history page completed after revocation');
  assert.equal(receiptOf(context).error_code, 'permission_revoked');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1);
});

test('a privacy epoch change discards a late history page without reviving it', async t => {
  const context = fixture(t);
  context.connector.holdNextHistory = true;
  const controller = new AbortController();

  const running = context.sync.runConnector('github', { signal: controller.signal, isCurrent: () => true });
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  context.store.database.atomic(() => context.store.database.bump('privacy_epoch'));
  context.connector.release();

  const result = await running;
  assert.equal(result.aborted, true, 'a late page from the old privacy epoch is not a success');
  assert.equal(result.history?.aborted, true);
  assert.equal(result.history?.reason, 'privacy_changed');
  assert.deepEqual(githubEventIds(context), [], 'the old-epoch page must not be ingested');
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0, 'the old-epoch page must not mark itself seen');
  assert.equal(context.cursors.get('github').page, 1, 'the committed normal page stays');
});

test('a suspended runtime discards a late history page and later discovers it once', async t => {
  const context = fixture(t);
  context.connector.holdNextHistory = true;

  const controller = new AbortController();
  const running = context.sync.runConnector('github', { signal: controller.signal, isCurrent: () => true });
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  context.runtime.suspended = true;
  context.connector.release();

  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.history?.reason, 'runtime_unavailable');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1);

  context.runtime.suspended = false;
  const resumed = await context.sync.runConnector('github', { signal: new AbortController().signal, isCurrent: () => true });
  assert.equal(resumed.aborted, undefined);
  assert.equal(resumed.history?.historyDiscovery, 'available');
  assert.equal(resumed.history?.advanced, 1);
  assert.deepEqual(githubEventIds(context), ['history-late']);
  assert.equal(taskCount(context), 1);
  assert.equal(backfillSeenKeys(context).length, 1);
  assert.equal(context.cursors.get('github').page, 2);
});

test('a closed runtime discards a late history page', async t => {
  const context = fixture(t);
  context.connector.holdNextHistory = true;

  const running = context.sync.runConnector('github', {});
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  await context.runtime.close();
  context.connector.release();

  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.history?.reason, 'runtime_unavailable');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
});

test('an abort signal discards a late history page', async t => {
  const context = fixture(t);
  context.connector.holdNextHistory = true;
  const controller = new AbortController();

  const running = context.sync.runConnector('github', { signal: controller.signal, isCurrent: () => true });
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');
  controller.abort(new Error('stop'));
  context.connector.release();

  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.history?.reason, 'aborted');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1);
});

test('a throwing trusted callback fails closed before history discovery', async t => {
  const context = fixture(t);
  const result = await context.runtime.backfill('github', {
    once: true,
    isCurrent: () => { throw new Error('authorization unavailable'); }
  });

  assert.equal(result.blocked, true);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'authorization_changed');
  assert.equal(result.networkCalls, 0);
  assert.equal(context.connector.historyCalls, 0, 'the provider must not be called after a failed fence');
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(backfillSeenKeys(context).length, 0);
});

test('ordinary polling keeps its unfenced history discovery behaviour', async t => {
  const context = fixture(t);
  const outcome = await context.sync.run();

  assert.equal(outcome.results[0].failed, false);
  assert.equal(outcome.results[0].history?.historyDiscovery, 'available');
  assert.equal(outcome.results[0].history?.advanced, 1);
  assert.deepEqual(githubEventIds(context), ['history-late']);
  assert.equal(taskCount(context), 1);
  assert.equal(backfillSeenKeys(context).length, 1);
  assert.equal(context.cursors.get('github').page, 1);
});

test('an ordinary provider history failure keeps its previous non-fatal behaviour', async t => {
  const context = fixture(t);
  context.connector.listHistoricalEvents = async () => { throw new Error('history endpoint unavailable'); };
  const outcome = await context.sync.run();

  assert.equal(outcome.results[0].failed, false, 'a provider history failure is not an authorization failure');
  assert.match(outcome.results[0].historyError, /history endpoint unavailable/);
  assert.deepEqual(githubEventIds(context), []);
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1, 'the normal page still commits');
  assert.equal(context.store.state.connectorStatus.github.ok, true, 'the source is not reported unhealthy');
});

test('a service stop during history discovery discards the late page and a restart completes once', async t => {
  const context = fixture(t);
  context.service.start();
  const server = await startServer(t, context.service);
  context.connector.holdNextHistory = true;

  assert.equal((await server.post(issuePayload())).status, 202);
  await waitFor(() => context.connector.historyCalls === 1, 'history discovery never started');

  const stopping = context.service.stop();
  context.connector.release();
  await stopping;
  await waitFor(() => receiptOf(context)?.state === 'queued' && receiptOf(context)?.error_code === 'pull_aborted',
    'the stopped history page did not requeue its receipt');
  assert.deepEqual(githubEventIds(context), [], 'a stopped service must not ingest the late history page');
  assert.equal(taskCount(context), 0);
  assert.equal(backfillSeenKeys(context).length, 0);
  assert.equal(context.cursors.get('github').page, 1, 'the committed normal page stays');

  const replacement = new GitHubWebhookService(context.serviceOptions());
  try {
    replacement.start();
    await waitFor(() => receiptOf(context)?.state === 'completed',
      'the retained receipt never completed after the restart', 12_000);
    assert.equal(context.connector.historyCalls, 2);
    assert.deepEqual(githubEventIds(context), ['history-late']);
    assert.equal(taskCount(context), 1);
    assert.equal(backfillSeenKeys(context).length, 1);
    assert.equal(context.cursors.get('github').page, 2);
  } finally {
    await replacement.stop();
  }
});
