import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Real `server.js` regressions for the GitHub webhook receiver.
 *
 * The service wrapper in github-webhooks.test.js cannot prove the production
 * wiring: only a child server exercises the actual HTTP entry and the actual
 * rebuild paths. No GitHub account, tunnel or remote request is involved.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'github-webhook-server-test-secret';
const ACCOUNT_ID = '4242';
const REPOSITORY = 'acme/widgets';
const PAYLOAD_TITLE = 'SERVER-TRANSPORT-TITLE-MUST-NOT-LEAK';

const sign = body => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-webhook-server-'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(t, directory, port) {
  fs.writeFileSync(path.join(directory, 'setup.json'), `${JSON.stringify({
    version: 1,
    connections: { github: { account: { id: ACCOUNT_ID, label: 'Synthetic GitHub' }, scopes: [] } },
    monitoring: { enabled: false }
  }, null, 2)}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    PORT: String(port),
    UNPROMPTED_SETUP_FILE: path.join(directory, 'setup.json'),
    UNPROMPTED_STATE_FILE: path.join(directory, 'state.json'),
    UNPROMPTED_STORAGE: 'sqlite',
    UNPROMPTED_FORCE_SIMULATION: 'true',
    // Leave the application's own 5 s / 10 s body limits in charge. Node's
    // request timeout would otherwise answer before the receiver can.
    UNPROMPTED_HTTP_REQUEST_TIMEOUT_MS: '30000',
    UNPROMPTED_GITHUB_WEBHOOK_ENABLED: 'true',
    UNPROMPTED_GITHUB_WEBHOOK_SECRET: SECRET,
    UNPROMPTED_GITHUB_WEBHOOK_REPOS: REPOSITORY,
    UNPROMPTED_GITHUB_WEBHOOK_ACCOUNT_ID: ACCOUNT_ID
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets = new Set();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (child.exitCode == null) child.kill('SIGTERM');
    const exit = await new Promise(resolve => child.exitCode != null
      ? resolve({ code: child.exitCode, signal: child.signalCode })
      : child.once('exit', (code, signal) => resolve({ code, signal })));
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(exit.code, 0, `the child server exited uncleanly: ${JSON.stringify(exit)}\n${stderr.slice(-800)}`);
  });
  return { child, sockets, stderr: () => stderr };
}

async function waitReady(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`the child server exited before it was ready (${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) });
      const body = await response.json();
      if (response.ok && body.processId === child.pid) return;
    } catch { /* not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('the child server never became ready.');
}

/**
 * One raw HTTP/1.1 exchange. Duplicate header lines and chunked uploads must
 * reach the server exactly as written, which fetch cannot guarantee.
 */
function rawRequest({ port, sockets, method = 'POST', target = '/api/webhooks/github', headers = [], body = '',
  autoLength = true, chunkedBody = null, dripMs = 0, waitMs = 6000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let parsed = null;
    let closed = false;
    let settled = false;
    let dripTimer = null;
    let closeTimer = null;

    const snapshot = () => {
      const text = buffer.toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      if (split < 0) return { status: 0 };
      const head = text.slice(0, split);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] || 0);
      const responseHeaders = {};
      for (const line of head.split('\r\n').slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      return { status, headers: responseHeaders, body: text.slice(split + 4) };
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      if (dripTimer) clearInterval(dripTimer);
      socket.destroy();
      if (error) return reject(error);
      resolve({ ...(parsed || snapshot()), closed });
    };
    const maybeComplete = () => {
      if (settled) return;
      const current = snapshot();
      if (!current.status) return;
      const lengthHeader = current.headers?.['content-length'];
      const length = Number(lengthHeader);
      const chunked = /chunked/i.test(current.headers?.['transfer-encoding'] || '');
      const complete = Number.isFinite(length) && lengthHeader != null
        ? Buffer.byteLength(current.body, 'latin1') >= length
        : chunked && current.body.endsWith('0\r\n\r\n');
      if (!complete) return;
      parsed = current;
      // The receiver promises to close its own connection on a transport
      // failure, so give the server's FIN a moment to arrive.
      closeTimer = setTimeout(() => finish(), 150);
    };
    const timer = setTimeout(() => finish(new Error(`raw request timed out after ${waitMs}ms`)), waitMs);

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      maybeComplete();
    });
    socket.on('end', () => { closed = true; if (!parsed) parsed = snapshot(); finish(); });
    socket.on('close', () => { closed = true; if (!parsed) parsed = snapshot(); finish(); });
    socket.on('error', error => {
      if (settled) return;
      // A deliberate close can reset the socket while unread request bytes
      // remain. A response already on the wire still counts.
      const current = snapshot();
      if (parsed || current.status) {
        parsed = parsed || current;
        closed = true;
        finish();
        return;
      }
      finish(error);
    });
    socket.on('connect', () => {
      const hasLength = headers.some(line => /^content-length:/i.test(line));
      const lines = [`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1',
        ...headers,
        ...(autoLength && !hasLength ? [`content-length: ${Buffer.byteLength(body)}`] : []), '', ''];
      socket.write(lines.join('\r\n'));
      if (chunkedBody) {
        for (const chunk of chunkedBody) {
          if (settled) break;
          try { socket.write(`${chunk.length.toString(16)}\r\n${chunk.toString('latin1')}\r\n`); }
          catch { /* the server may already have closed */ }
        }
        try { socket.write('0\r\n\r\n'); } catch { /* already gone */ }
        return;
      }
      if (!body) return;
      if (dripMs) {
        let offset = 0;
        dripTimer = setInterval(() => {
          if (settled || offset >= body.length) { clearInterval(dripTimer); dripTimer = null; return; }
          try { socket.write(body[offset]); } catch { /* the server may already have closed */ }
          offset += 1;
        }, dripMs);
        return;
      }
      socket.write(body);
    });
  });
}

function webhookHeaders(extra = []) {
  return ['content-type: application/json', `x-github-delivery: ${randomUUID()}`, 'x-github-event: issues',
    `x-hub-signature-256: ${sign('{}')}`, ...extra];
}

function openDatabase(directory) {
  const database = new Database(path.join(directory, 'state.sqlite'));
  database.pragma('busy_timeout=5000');
  return database;
}

async function waitFor(predicate, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

test('the real server answers webhook transport failures with 400/413/408 and closes', async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const { child } = startServer(t, directory, port);
  await waitReady(port, child);
  const sockets = new Set();
  const request = options => rawRequest({ port, sockets, ...options });
  const responses = [];

  const repeated = await request({
    headers: ['content-type: application/json', `x-hub-signature-256: ${sign('{}')}`,
      `x-hub-signature-256: ${sign('{}')}`, `x-github-delivery: ${randomUUID()}`, 'x-github-event: issues'],
    body: '{}', waitMs: 4000
  });
  assert.equal(repeated.status, 400);
  assert.equal(repeated.headers.connection, 'close');
  responses.push(repeated);

  const badDelivery = await request({ headers: ['content-type: application/json', 'x-github-delivery: not-a-guid',
    'x-github-event: issues', `x-hub-signature-256: ${sign('{}')}`], body: '{}', waitMs: 4000 });
  assert.equal(badDelivery.status, 400);
  assert.equal(badDelivery.headers.connection, 'close');
  responses.push(badDelivery);

  const wrongType = await request({ headers: ['content-type: text/plain', `x-github-delivery: ${randomUUID()}`,
    'x-github-event: issues', `x-hub-signature-256: ${sign('{}')}`], body: '{}', waitMs: 4000 });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.headers.connection, 'close');
  responses.push(wrongType);

  const declaredOversize = await request({ headers: [...webhookHeaders(), 'content-length: 300000'],
    body: '', autoLength: false, waitMs: 4000 });
  assert.equal(declaredOversize.status, 413);
  assert.equal(declaredOversize.headers.connection, 'close');
  responses.push(declaredOversize);

  const streamedOversize = await request({
    headers: ['content-type: application/json', 'transfer-encoding: chunked', `x-github-delivery: ${randomUUID()}`,
      'x-github-event: issues', `x-hub-signature-256: ${sign('{}')}`],
    autoLength: false, chunkedBody: Array.from({ length: 5 }, () => Buffer.alloc(64 * 1024, 0x61)), waitMs: 6000
  });
  assert.equal(streamedOversize.status, 413);
  assert.equal(streamedOversize.headers.connection, 'close');
  responses.push(streamedOversize);

  const idle = await request({
    headers: [...webhookHeaders(), 'content-length: 4096'], body: '{', autoLength: false, waitMs: 9000
  });
  assert.equal(idle.status, 408);
  assert.equal(idle.headers.connection, 'close');
  responses.push(idle);

  const dripBody = `{"title":"${PAYLOAD_TITLE}",${'"x":"'.padEnd(120, 'x')}`;
  const total = await request({
    headers: [...webhookHeaders(), `content-length: ${Buffer.byteLength(dripBody)}`],
    body: dripBody, autoLength: false, dripMs: 700, waitMs: 16_000
  });
  assert.equal(total.status, 408);
  assert.equal(total.headers.connection, 'close');
  responses.push(total);

  for (const response of responses) {
    assert.doesNotMatch(response.body, new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(response.body, new RegExp(PAYLOAD_TITLE));
  }
  const database = openDatabase(directory);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) n FROM github_webhook_receipts').get().n, 0);
    assert.equal(database.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_name='webhooks'").get().n, 0);
  } finally { database.close(); }
  for (const socket of sockets) socket.destroy();
});

test('a completed server rebuild keeps a worker that drains the durable webhook queue', async t => {
  const directory = temporaryDirectory();
  const port = await freePort();
  const { child } = startServer(t, directory, port);
  await waitReady(port, child);

  // A real rebuild: the server stops the old receiver, rebuilds the runtime
  // while workspaceChanging is true, then clears the lifecycle in finally.
  const rebuild = await fetch(`http://127.0.0.1:${port}/api/setup/connections/slack/forget`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000)
  });
  assert.equal(rebuild.status, 200, 'the synthetic rebuild path must succeed');

  // The job below stands in for a receipt accepted by the rebuilt receiver.
  // Monitoring is off, so the worker must settle the receipt without any
  // provider call; the point is that a worker exists at all after the rebuild.
  const database = openDatabase(directory);
  const jobId = randomUUID();
  const receiptId = randomUUID();
  const at = new Date().toISOString();
  try {
    database.prepare(`INSERT INTO jobs
      (id,queue_name,job_type,payload_json,idempotency_key,state,priority,attempts,max_attempts,available_at,lease_token,created_at,updated_at)
      VALUES(?,?,?,?,?,'queued',0,0,12,?,0,?,?)`)
      .run(jobId, 'webhooks', 'github_webhook_pull', JSON.stringify({ accountId: ACCOUNT_ID }),
        `server-test:${jobId}`, at, at, at);
    database.prepare(`INSERT INTO github_webhook_receipts
      (id,account_id,delivery_guid,body_digest,repository,event,action,state,job_id,error_code,received_at,updated_at,completed_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,NULL,?,?,NULL)`)
      .run(receiptId, ACCOUNT_ID, randomUUID(), 'a'.repeat(64), REPOSITORY, 'issues', 'opened', jobId, at, at);
  } finally { database.close(); }

  await waitFor(() => {
    const reader = new Database(path.join(directory, 'state.sqlite'), { readonly: true });
    try {
      const job = reader.prepare('SELECT state FROM jobs WHERE id=?').get(jobId);
      const receipt = reader.prepare('SELECT state,error_code FROM github_webhook_receipts WHERE id=?').get(receiptId);
      return job?.state === 'completed' && receipt?.state === 'paused' && receipt.error_code === 'monitoring_paused';
    } finally { reader.close(); }
  }, 'the rebuilt receiver never drained its durable webhook queue', 8000);
});
