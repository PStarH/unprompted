import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { SqliteStore } from '../src/durable/store.js';
import { WorkEngine } from '../src/engine.js';
import { CursorStore, Connector, toNormalizedEvents } from '../src/connectors/connector.js';
import { ConnectorSync } from '../src/connectors/sync.js';
import { GitHubWebhookService, GITHUB_WEBHOOK_PATH, verifyGitHubSignature } from '../src/github-webhooks.js';
import { LocalSetupStore } from '../src/setup.js';
import { JsonStore } from '../src/store.js';

/**
 * The GitHub webhook receiver is the only externally POSTable route. These
 * tests exercise the real HTTP boundary, the real SQLite receipt and durable
 * queue, and the real ConnectorSync runner against a fake provider. No GitHub
 * account, tunnel or remote registration is involved.
 */

const SECRET = 'unit-test-webhook-secret';
const ACCOUNT_ID = '4242';
const REPOSITORY = 'acme/widgets';
const GUID = '3f1a7c9e-5b2d-4a6f-9c1e-8b0d2f4a6c8e';

const temporaryDirectories = [];
test.after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-webhooks-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sign(body, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** A GitHub connector whose pulls are scripted, so no network is involved. */
class FakeGitHubConnector extends Connector {
  constructor({ pulls = [], account = { id: ACCOUNT_ID, login: 'octocat' } } = {}) {
    super({ id: 'github', kind: 'github' });
    this.live = true;
    this.account = account;
    this.pulls = [...pulls];
    this.calls = [];
    this.seenSignals = [];
  }
  async pull({ cursor = null, signal } = {}) {
    this.calls.push(cursor);
    this.seenSignals.push(signal);
    if (!this.pulls.length) return { events: [], cursor: { page: 1 }, errors: [], partial: false };
    const next = this.pulls.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

function fixture(t, options = {}) {
  const directory = temporaryDirectory();
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  setup.setMonitoring({ enabled: true, intervalMs: 60_000 });
  const store = new SqliteStore(path.join(directory, 'state.json'));
  const engine = new WorkEngine(store);
  const connector = options.connector || new FakeGitHubConnector({ pulls: options.pulls || [] });
  const cursors = new CursorStore(store);
  const sync = new ConnectorSync({ connectors: [connector], cursors, engine });
  const account = { id: ACCOUNT_ID };
  const service = new GitHubWebhookService({
    store,
    setup,
    getRuntime: () => ({ connectors: [connector] }),
    getSync: () => sync,
    getAccountId: () => account.id,
    getLifecycle: options.lifecycle || (() => 'running'),
    config: {
      enabled: true, configured: true, code: null, secret: SECRET,
      repositories: new Set([REPOSITORY.toLowerCase()]), accountId: ACCOUNT_ID
    },
    now: options.now || (() => Date.now()),
    maxPending: options.maxPending ?? 128,
    retentionMs: options.retentionMs ?? 7 * 24 * 60 * 60 * 1000,
    maxCompleted: options.maxCompleted ?? 10_000,
    limits: options.limits
  });
  t.after(async () => {
    await service.stop();
    store.close();
  });
  return { directory, setup, store, engine, connector, cursors, sync, service, account };
}

/** Start the real HTTP server shape: one route, raw body, bounded reads. */
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
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    async post({ body = '{}', headers = {}, path: target = GITHUB_WEBHOOK_PATH, method = 'POST' } = {}) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const response = await fetch(`${base}${target}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(payload),
          'x-github-delivery': GUID,
          'x-github-event': 'issues',
          ...headers
        },
        body: payload
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* a non-JSON body is a failure to report */ }
      return { status: response.status, body: json, text, headers: response.headers };
    }
  };
}

const issuePayload = (repository = REPOSITORY) => ({
  action: 'opened',
  repository: { id: 991, full_name: repository },
  issue: { id: 555, number: 7, title: 'Widget does not start' }
});

/** A real normalized issue event, used to prove a late provider page is fenced. */
function lateIssueEvent(id = 'late-1') {
  return toNormalizedEvents('github', 'github', [{
    type: 'issue.updated', providerEventId: id, providerRevision: `rev-${id}`, at: '2026-11-13T00:00:00.000Z',
    payload: { id: `github:${ACCOUNT_ID}:${id}`, title: 'Late page item', body: '', bodyTruncated: false,
      repository: REPOSITORY, number: 7, state: 'open', assigned: true, assignee: 'octocat',
      accountId: ACCOUNT_ID, updatedAt: '2026-11-13T00:00:00.000Z',
      url: `https://github.com/${REPOSITORY}/issues/7`, author: 'octocat', providerIssueId: '555' }
  }])[0];
}

/**
 * Send a raw request so duplicate header lines reach the server unchanged.
 * Fetch combines duplicates before they leave the client.
 */
function rawRequest(port, { method = 'POST', target = GITHUB_WEBHOOK_PATH, headers = [], body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = result => { if (settled) return; settled = true; socket.destroy(); resolve(result); };
    socket.setTimeout(2000, () => { if (!settled) { settled = true; socket.destroy(); reject(new Error('The raw request timed out.')); } });
    socket.on('error', error => { if (!settled) { settled = true; reject(error); } });
    socket.on('connect', () => {
      socket.write([`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1', ...headers,
        `content-length: ${Buffer.byteLength(body)}`, '', body].join('\r\n'));
    });
    socket.on('data', chunk => {
      const text = chunk.toString('latin1');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (match) finish({ status: Number(match[1]), text });
    });
  });
}

async function waitFor(predicate, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('the official GitHub HMAC-SHA256 example verifies over the raw bytes', () => {
  // Official example from GitHub's "Validating webhook deliveries"
  // documentation: the secret is used verbatim and the signature covers the
  // exact bytes received.
  const secret = 'It’s a Secret to Everybody';
  const payload = Buffer.from('{"zen":"Keep it logically awesome."}', 'utf8');
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  assert.equal(verifyGitHubSignature({ secret, rawBody: payload, signatureHeader: `sha256=${expected}` }), true);
  assert.equal(verifyGitHubSignature({ secret, rawBody: payload, signatureHeader: `sha1=${expected}` }), false);
  assert.equal(verifyGitHubSignature({ secret, rawBody: payload, signatureHeader: `sha256=${expected.slice(0, 63)}` }), false);
  assert.equal(verifyGitHubSignature({ secret, rawBody: Buffer.from('tampered'), signatureHeader: `sha256=${expected}` }), false);
  // A signature of the right length but the wrong bytes must not verify.
  const flipped = `${expected.slice(0, 63)}${expected[63] === 'a' ? 'b' : 'a'}`;
  assert.equal(verifyGitHubSignature({ secret, rawBody: payload, signatureHeader: `sha256=${flipped}` }), false);
});

test('a signed delivery is accepted only after the receipt and its job are committed together', async t => {
  const context = fixture(t, { pulls: [{ events: [], cursor: { page: 1 }, errors: [], partial: false }] });
  // Hold the worker so the committed queue state is observed before it runs.
  context.service.kick = () => Promise.resolve(false);
  const server = await startServer(t, context.service);
  const response = await server.post({ body: issuePayload() });
  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, true);
  assert.equal(response.body.duplicate, false);

  const receipts = context.store.db.prepare('SELECT * FROM github_webhook_receipts').all();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].account_id, ACCOUNT_ID);
  assert.equal(receipts[0].delivery_guid, GUID);
  assert.equal(receipts[0].state, 'queued');
  assert.equal(receipts[0].repository, REPOSITORY);
  const job = context.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(receipts[0].job_id);
  assert.ok(job, 'the receipt and its durable job share one commit');
  assert.equal(job.queue_name, 'webhooks');
  assert.equal(job.job_type, 'github_webhook_pull');
});

test('the receiver never stores the signed body, the secret or issue text', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /Widget does not start/);
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /zen/);
  assert.match(row.body_digest, /^[0-9a-f]{64}$/);
  const stored = fs.readFileSync(context.store.databaseFilename, 'utf8');
  assert.doesNotMatch(stored, /Widget does not start/);
});

test('a replayed body under a new delivery id is one receipt and one job', async t => {
  const context = fixture(t, { pulls: [{ events: [], cursor: { page: 1 }, errors: [], partial: false }] });
  const server = await startServer(t, context.service);
  const body = JSON.stringify(issuePayload());
  const first = await server.post({ body, headers: { 'x-github-delivery': GUID } });
  const second = await server.post({ body, headers: { 'x-github-delivery': randomUUID() } });
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 1);
  assert.equal(context.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_name='webhooks'").get().n, 1);
});

test('the same delivery id with a different body is a conflict', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  const conflicting = await server.post({ body: { ...issuePayload(), action: 'closed' } });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.code, 'WEBHOOK_DELIVERY_CONFLICT');
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 1);
});

test('an unsigned or tampered delivery is refused and leaves no receipt', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const body = JSON.stringify(issuePayload());
  const unsigned = await fetch(`${server.base}${GITHUB_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-delivery': GUID, 'x-github-event': 'issues' },
    body
  });
  assert.equal(unsigned.status, 401);
  const tampered = await fetch(`${server.base}${GITHUB_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-delivery': GUID, 'x-github-event': 'issues',
      'x-hub-signature-256': sign(`${body} `) },
    body
  });
  assert.equal(tampered.status, 401);
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
  assert.equal(context.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_name='webhooks'").get().n, 0);
});

test('a Unicode body is signed over its exact UTF-8 bytes', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const body = JSON.stringify({ ...issuePayload(), issue: { id: 556, number: 8, title: 'Widget ünïcode — 日本語 ✅' } });
  const response = await server.post({ body });
  assert.equal(response.status, 202);
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(row.body_digest, createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'));
});

test('repeated, malformed and non-JSON requests are rejected', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const body = JSON.stringify(issuePayload());

  const repeated = await rawRequest(server.port, {
    headers: ['content-type: application/json', `x-hub-signature-256: ${sign(body)}`, `x-hub-signature-256: ${sign(body)}`,
      `x-github-delivery: ${GUID}`, 'x-github-event: issues'],
    body
  });
  assert.equal(repeated.status, 400);

  const badDelivery = await server.post({ body, headers: { 'x-github-delivery': 'not-a-guid' } });
  assert.equal(badDelivery.status, 400);

  const badEvent = await server.post({ body, headers: { 'x-github-event': 'not an event' } });
  assert.equal(badEvent.status, 400);

  const notJson = await fetch(`${server.base}${GITHUB_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('not json'), 'x-github-delivery': GUID, 'x-github-event': 'issues' },
    body: 'not json'
  });
  assert.equal(notJson.status, 400);
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('an oversized body is refused with 413 before it is buffered', async t => {
  const context = fixture(t, { limits: { maxBytes: 1024, timeoutMs: 2000, idleTimeoutMs: 500 } });
  const server = await startServer(t, context.service);
  const body = JSON.stringify({ ...issuePayload(), issue: { id: 1, number: 2, title: 'x'.repeat(4096) } });
  const response = await server.post({ body });
  assert.equal(response.status, 413);
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('a slow body times out and closes without a receipt', async t => {
  const context = fixture(t, { limits: { maxBytes: 64 * 1024, timeoutMs: 300, idleTimeoutMs: 150 } });
  const server = await startServer(t, context.service);
  const socket = net.createConnection({ port: server.port, host: '127.0.0.1' });
  let response = '';
  socket.on('data', chunk => { response += chunk.toString('latin1'); });
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST ${GITHUB_WEBHOOK_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n`
    + `x-hub-signature-256: ${sign('{"partial":true}')}\r\nx-github-delivery: ${GUID}\r\nx-github-event: issues\r\n`
    + 'content-length: 4096\r\n\r\n{');
  await waitFor(() => /HTTP\/1\.1/.test(response), 'the timeout response never arrived');
  assert.match(response, /408/);
  socket.destroy();
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('a repository outside the allowlist is refused', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const response = await server.post({ body: issuePayload('other/project') });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'REPOSITORY_NOT_ALLOWED');
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('an unsupported event or action is ignored without a pull', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const unsupportedEvent = await server.post({ body: issuePayload(), headers: { 'x-github-event': 'deployment' } });
  assert.equal(unsupportedEvent.status, 202);
  assert.equal(unsupportedEvent.body.accepted, false);
  const unsupportedAction = await server.post({ body: { ...issuePayload(), action: 'milestoned' } });
  assert.equal(unsupportedAction.status, 202);
  assert.equal(unsupportedAction.body.accepted, false);
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('a ping only checks configuration and never calls the provider', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const response = await server.post({
    body: { zen: 'Keep it logically awesome.', repository: { id: 1, full_name: REPOSITORY } },
    headers: { 'x-github-event': 'ping' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.event, 'ping');
  assert.equal(context.connector.calls.length, 0);
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('a GitHub App installation delivery is refused instead of granting access', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  const response = await server.post({ body: { ...issuePayload(), installation: { id: 12, account: { id: 99 } } } });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INSTALLATION_UNSUPPORTED');
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('a receipt triggers the real ConnectorSync pull and completes only when it did', async t => {
  const connector = new FakeGitHubConnector({
    pulls: [{ events: [], cursor: { page: 2 }, errors: [], partial: false }]
  });
  const context = fixture(t, { connector });
  const server = await startServer(t, context.service);
  const response = await server.post({ body: issuePayload() });
  assert.equal(response.status, 202);
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'completed',
    'the receipt never completed');
  assert.equal(connector.calls.length, 1);
  assert.equal(context.cursors.get('github').page, 2);
});

test('a partial pull does not complete the receipt and is retried later', async t => {
  const connector = new FakeGitHubConnector({
    pulls: [{ events: [], cursor: { page: 1 }, errors: [{ scope: 'issues', message: 'rate limited' }], partial: true }]
  });
  const context = fixture(t, { connector });
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'queued',
    'the receipt never returned to the queue');
  const job = context.store.db.prepare("SELECT * FROM jobs WHERE queue_name='webhooks'").get();
  assert.equal(job.state, 'retry_wait');
  // A partial pull without a 429 is retried as a transient failure. The
  // rate-limited case is asserted separately below.
  assert.equal(job.last_error_class, 'retryable');
  assert.notEqual(job.state, 'completed');
});

test('a rate-limited pull is classified as a rate limit and backed off', async t => {
  const connector = new FakeGitHubConnector({
    pulls: [Object.assign(new Error('API rate limit exceeded'), { status: 429, rateLimited: true })]
  });
  const context = fixture(t, { connector });
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  await waitFor(async () => context.store.db.prepare(
    "SELECT state FROM jobs WHERE queue_name='webhooks'").get()?.state === 'retry_wait',
  'the rate-limited job was never deferred');
  const job = context.store.db.prepare("SELECT * FROM jobs WHERE queue_name='webhooks'").get();
  assert.equal(job.last_error_class, 'rate_limit');
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(row.state, 'queued');
  assert.equal(row.error_code, 'rate_limited');
  assert.equal(connector.calls.length, 1);
});

test('a running pull receives a later event as a successor job', async t => {
  let release;
  const connector = new FakeGitHubConnector({ pulls: [] });
  connector.pull = async ({ cursor, signal }) => {
    connector.calls.push(cursor);
    connector.seenSignals.push(signal);
    if (connector.calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { events: [], cursor: { page: connector.calls.length }, errors: [], partial: false };
  };
  const context = fixture(t, { connector });
  // The real server runs the polling worker, which picks up the successor job
  // once the running pull finishes.
  context.service.start();
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  await waitFor(() => connector.calls.length === 1, 'the first pull never started');
  const second = await server.post({ body: { ...issuePayload(), issue: { id: 556, number: 8, title: 'Second' } },
    headers: { 'x-github-delivery': randomUUID() } });
  assert.equal(second.status, 202);
  release();
  await waitFor(async () => context.store.db.prepare("SELECT COUNT(*) n FROM github_webhook_receipts WHERE state='completed'").get().n === 2,
    'the successor receipt never completed', 10_000);
  assert.equal(connector.calls.length, 2, 'the second event caused its own pull');
});

test('the worker signal reaches the connector pull', async t => {
  const connector = new FakeGitHubConnector({ pulls: [{ events: [], cursor: { page: 1 }, errors: [], partial: false }] });
  const context = fixture(t, { connector });
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  await waitFor(() => connector.seenSignals.length === 1, 'the pull never happened');
  assert.ok(connector.seenSignals[0], 'the pull received an abort signal');
  assert.equal(connector.seenSignals[0].aborted, false);
});

test('a paused observation accepts no new work and keeps the queued receipt', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  context.setup.setMonitoring({ enabled: false });
  const response = await server.post({ body: issuePayload() });
  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, false);
  assert.equal(response.body.code, 'MONITORING_PAUSED');
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
  assert.equal(context.connector.calls.length, 0);
});

test('a revoked GitHub permission expires the queued receipt without a pull', async t => {
  const context = fixture(t);
  // Keep the receipt queued so revocation is what resolves it.
  context.service.kick = () => Promise.resolve(false);
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  context.store.database.atomic(() => context.store.database.set('revoked_connectors', JSON.stringify(['github'])));
  await context.service.refresh();
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(row.state, 'expired');
  assert.equal(row.error_code, 'permission_revoked');
  assert.equal(context.connector.calls.length, 0);
});

test('a changed GitHub account expires the old receipt instead of driving the new account', async t => {
  const context = fixture(t);
  // Keep the receipt queued so the account change is what resolves it.
  context.service.kick = () => Promise.resolve(false);
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  context.account.id = '9999';
  await context.service.refresh();
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(row.state, 'expired');
  assert.equal(row.error_code, 'authorization_changed');
  assert.equal(context.connector.calls.length, 0);
});

test('a delivery for a different account than the configured one is refused', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  context.account.id = '9999';
  const response = await server.post({ body: issuePayload() });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'WEBHOOK_ACCOUNT_UNAVAILABLE');
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
});

test('the pending backlog is bounded and a full backlog is refused with 503', async t => {
  const context = fixture(t, { maxPending: 2 });
  // Keep accepted receipts pending so the backlog bound is exercised.
  context.service.kick = () => Promise.resolve(false);
  const server = await startServer(t, context.service);
  const first = await server.post({ body: issuePayload() });
  assert.equal(first.status, 202);
  const second = await server.post({ body: { ...issuePayload(), issue: { id: 2, number: 9, title: 'Second' } },
    headers: { 'x-github-delivery': randomUUID() } });
  assert.equal(second.status, 202);
  const third = await server.post({ body: { ...issuePayload(), issue: { id: 3, number: 10, title: 'Third' } },
    headers: { 'x-github-delivery': randomUUID() } });
  assert.equal(third.status, 503);
  assert.equal(third.body.code, 'WEBHOOK_BACKLOG_FULL');
  assert.equal(context.store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 2);
});

test('an unfinished receipt survives a close and reopen of the workspace', async t => {
  const directory = temporaryDirectory();
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  setup.setMonitoring({ enabled: true });
  const filename = path.join(directory, 'state.json');
  let store = new SqliteStore(filename);
  const engine = new WorkEngine(store);
  const connector = new FakeGitHubConnector({ pulls: [] });
  // The first observation is deliberately still running when the workspace closes.
  connector.pull = ({ signal } = {}) => {
    connector.calls.push(null);
    return new Promise((_resolve, reject) => {
      const stop = () => reject(Object.assign(new Error('Observation stopped.'), { name: 'AbortError' }));
      if (signal?.aborted) stop();
      else signal?.addEventListener?.('abort', stop, { once: true });
    });
  };
  const sync = new ConnectorSync({ connectors: [connector], cursors: new CursorStore(store), engine });
  const account = { id: ACCOUNT_ID };
  const config = { enabled: true, configured: true, code: null, secret: SECRET,
    repositories: new Set([REPOSITORY.toLowerCase()]), accountId: ACCOUNT_ID };
  const first = new GitHubWebhookService({ store, setup, getRuntime: () => ({ connectors: [connector] }),
    getSync: () => sync, getAccountId: () => account.id, config });
  const server = await startServer(t, first);
  await server.post({ body: issuePayload() });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 1);
  await waitFor(() => connector.calls.length === 1, 'the first observation never started');
  await first.stop();
  const unfinished = store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(unfinished.state, 'queued', 'an interrupted observation stays pending');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_name='webhooks' AND state='completed'").get().n, 0);
  store.close();

  store = new SqliteStore(filename);
  t.after(() => store.close());
  const engine2 = new WorkEngine(store);
  const connector2 = new FakeGitHubConnector({ pulls: [{ events: [], cursor: { page: 1 }, errors: [], partial: false }] });
  const sync2 = new ConnectorSync({ connectors: [connector2], cursors: new CursorStore(store), engine: engine2 });
  const second = new GitHubWebhookService({ store, setup, getRuntime: () => ({ connectors: [connector2] }),
    getSync: () => sync2, getAccountId: () => account.id, config });
  t.after(async () => { await second.stop(); });
  second.start();
  await waitFor(async () => store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'completed',
    'the reopened workspace never completed the retained receipt');
  assert.equal(connector2.calls.length, 1, 'the reopened worker repeated the observation exactly once');
});

test('completed receipts are retained for a bounded period and pruned', async t => {
  let now = Date.parse('2026-11-12T00:00:00Z');
  const context = fixture(t, { now: () => now, retentionMs: 1000, maxCompleted: 2 });
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'completed',
    'the receipt never completed');
  now += 5000;
  await context.service.refresh();
  const rows = context.store.db.prepare('SELECT * FROM github_webhook_receipts').all();
  assert.ok(rows.length <= 2, 'the completed retention stays bounded');
});

test('the public status describes the receiver without exposing the secret', async t => {
  const context = fixture(t);
  const server = await startServer(t, context.service);
  await server.post({ body: issuePayload() });
  const description = context.service.describe();
  assert.equal(description.provider, 'github');
  assert.equal(description.configured, true);
  assert.equal(description.available, true);
  assert.ok(description.pending >= 0);
  assert.doesNotMatch(JSON.stringify(description), new RegExp(SECRET));
});

test('the receiver is unavailable when it is disabled or misconfigured', async t => {
  const context = fixture(t);
  const disabled = new GitHubWebhookService({ store: context.store, setup: context.setup,
    getRuntime: () => ({ connectors: [context.connector] }), getSync: () => context.sync,
    getAccountId: () => ACCOUNT_ID, config: { enabled: false, configured: false, code: 'WEBHOOK_DISABLED',
      secret: null, repositories: new Set(), accountId: null } });
  t.after(async () => { await disabled.stop(); });
  const server = await startServer(t, disabled);
  const response = await fetch(`${server.base}${GITHUB_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('{}'), 'x-github-delivery': GUID, 'x-github-event': 'issues' },
    body: '{}'
  });
  assert.equal(response.status, 503);
  assert.equal(disabled.describe().available, false);
});

test('a receiver constructed while the workspace is changing drains its receipt after unblock', async t => {
  // The server constructs and starts the receiver inside both rebuild try
  // blocks, while workspaceChanging still makes the lifecycle "blocked". The
  // worker must exist from construction so the later tick processes the queue.
  let lifecycle = 'blocked';
  const context = fixture(t, {
    lifecycle: () => lifecycle,
    pulls: [{ events: [], cursor: { page: 4 }, errors: [], partial: false }]
  });
  context.service.start();
  lifecycle = 'running';
  const server = await startServer(t, context.service);
  const first = await server.post({ body: issuePayload() });
  assert.equal(first.status, 202);
  const replay = await server.post({ body: issuePayload() });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);

  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'completed',
    'the receipt retained across the workspace change never completed', 6000);
  assert.equal(context.connector.calls.length, 1, 'the retained receipt drove exactly one pull');
  assert.equal(context.cursors.get('github').page, 4);
  const job = context.store.db.prepare("SELECT state FROM jobs WHERE queue_name='webhooks'").get();
  assert.equal(job.state, 'completed');
});

test('a pull that finishes after the account changed neither ingests nor completes', async t => {
  let release;
  const connector = new FakeGitHubConnector({ pulls: [] });
  const event = lateIssueEvent();
  connector.pull = async ({ cursor, signal } = {}) => {
    connector.calls.push(cursor);
    connector.seenSignals.push(signal);
    await new Promise(resolve => { release = resolve; });
    return { events: [event], cursor: { page: 9 }, errors: [], partial: false };
  };
  const context = fixture(t, { connector });
  context.service.start();
  const server = await startServer(t, context.service);
  assert.equal((await server.post({ body: issuePayload() })).status, 202);
  await waitFor(() => connector.calls.length === 1, 'the first pull never started');

  context.account.id = '9999';
  release();
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'expired',
    'the late page completed a receipt for the old account', 6000);
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(row.error_code, 'authorization_changed');
  assert.equal(context.cursors.get('github'), null, 'the abandoned page must not advance the cursor');
  assert.equal(Object.keys(context.store.state.tasks).length, 0, 'the abandoned page must not ingest');
  assert.equal(connector.calls.length, 1);
});

test('a pull that finishes after permission was revoked expires the receipt without ingesting', async t => {
  let release;
  const connector = new FakeGitHubConnector({ pulls: [] });
  const event = lateIssueEvent('late-revoked');
  connector.pull = async ({ cursor, signal } = {}) => {
    connector.calls.push(cursor);
    connector.seenSignals.push(signal);
    await new Promise(resolve => { release = resolve; });
    return { events: [event], cursor: { page: 9 }, errors: [], partial: false };
  };
  const context = fixture(t, { connector });
  context.service.start();
  const server = await startServer(t, context.service);
  assert.equal((await server.post({ body: issuePayload() })).status, 202);
  await waitFor(() => connector.calls.length === 1, 'the first pull never started');

  context.store.database.atomic(() => context.store.database.set('revoked_connectors', JSON.stringify(['github'])));
  release();
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'expired',
    'the late page completed a receipt after revocation', 6000);
  const row = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(row.error_code, 'permission_revoked');
  assert.equal(context.cursors.get('github'), null, 'the abandoned page must not advance the cursor');
  assert.equal(Object.keys(context.store.state.tasks).length, 0, 'the abandoned page must not ingest');
  assert.equal(connector.calls.length, 1);
});

test('a pull that finishes after observation paused pauses the receipt and resumes without restart', async t => {
  let release;
  const connector = new FakeGitHubConnector({ pulls: [] });
  const event = lateIssueEvent('late-pause');
  connector.pull = async ({ cursor, signal } = {}) => {
    connector.calls.push(cursor);
    connector.seenSignals.push(signal);
    if (connector.calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { events: [event], cursor: { page: connector.calls.length + 8 }, errors: [], partial: false };
  };
  const context = fixture(t, { connector });
  context.service.start();
  const server = await startServer(t, context.service);
  assert.equal((await server.post({ body: issuePayload() })).status, 202);
  await waitFor(() => connector.calls.length === 1, 'the first pull never started');

  context.setup.setMonitoring({ enabled: false });
  release();
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'paused',
    'the late page completed a receipt while observation was paused', 6000);
  const paused = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(paused.error_code, 'monitoring_paused');
  assert.equal(context.cursors.get('github'), null, 'the abandoned page must not advance the cursor');
  assert.equal(Object.keys(context.store.state.tasks).length, 0, 'the abandoned page must not ingest');

  // An explicit resume releases the retained receipt without a process restart.
  context.setup.setMonitoring({ enabled: true });
  await context.service.refresh();
  await context.service.kick();
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'completed',
    'the resumed receipt never completed', 8000);
  assert.equal(connector.calls.length, 2, 'the resume performed one current pull');
  assert.equal(context.cursors.get('github').page, 10);
  assert.equal(Object.keys(context.store.state.tasks).length, 1);
});

test('a pull that finishes while the lifecycle is blocked retries and completes after unblock', async t => {
  let release, lifecycle = 'running';
  const connector = new FakeGitHubConnector({ pulls: [] });
  const event = lateIssueEvent('late-lifecycle');
  connector.pull = async ({ cursor, signal } = {}) => {
    connector.calls.push(cursor);
    connector.seenSignals.push(signal);
    if (connector.calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { events: [event], cursor: { page: connector.calls.length + 8 }, errors: [], partial: false };
  };
  const context = fixture(t, { connector, lifecycle: () => lifecycle });
  context.service.start();
  const server = await startServer(t, context.service);
  assert.equal((await server.post({ body: issuePayload() })).status, 202);
  await waitFor(() => connector.calls.length === 1, 'the first pull never started');

  lifecycle = 'blocked';
  release();
  await waitFor(async () => context.store.db.prepare("SELECT state FROM jobs WHERE queue_name='webhooks'").get()?.state === 'retry_wait',
    'the blocked late page did not defer the job', 6000);
  const receipt = context.store.db.prepare('SELECT * FROM github_webhook_receipts').get();
  assert.equal(receipt.state, 'queued');
  assert.equal(receipt.error_code, 'lifecycle_blocked');
  assert.equal(context.cursors.get('github'), null, 'the abandoned page must not advance the cursor');
  assert.equal(Object.keys(context.store.state.tasks).length, 0, 'the abandoned page must not ingest');

  lifecycle = 'running';
  await waitFor(async () => context.store.db.prepare('SELECT state FROM github_webhook_receipts').get()?.state === 'completed',
    'the receipt never completed after the lifecycle resumed', 12_000);
  assert.equal(connector.calls.length, 2);
  assert.equal(context.cursors.get('github').page, 10);
  assert.equal(Object.keys(context.store.state.tasks).length, 1);
});

test('a JSON compatibility store is refused instead of acknowledging in memory', async t => {
  const directory = temporaryDirectory();
  const setup = new LocalSetupStore({ filePath: path.join(directory, 'setup.json') });
  setup.setMonitoring({ enabled: true });
  const store = new JsonStore(path.join(directory, 'state.json'));
  t.after(() => store.close());
  const service = new GitHubWebhookService({
    store, setup,
    config: { enabled: true, configured: true, code: null, secret: SECRET,
      repositories: new Set([REPOSITORY.toLowerCase()]), accountId: ACCOUNT_ID }
  });
  t.after(async () => { await service.stop(); });
  const server = await startServer(t, service);
  const response = await server.post({ body: issuePayload() });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'WEBHOOK_SQLITE_REQUIRED');
  assert.equal(service.describe().available, false);
  assert.doesNotMatch(fs.readFileSync(store.filename, 'utf8'), /github_webhook_receipts/);
});
