import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(child, output, base) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output()}`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* poll until ready */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output()}`);
}

function rawRequest(port, { requestLine = null, headers, body = '' }) {
  const line = requestLine || 'POST /api/misses HTTP/1.1';
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for the HTTP error response.'));
    }, 3000);
    socket.on('data', chunk => { response += chunk.toString('latin1'); });
    socket.once('error', error => {
      clearTimeout(timer);
      if (response) resolve(response);
      else reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
    socket.once('connect', () => {
      socket.write(`${line}\r\nHost: 127.0.0.1:${port}\r\n${line.startsWith('POST ') ? 'Content-Type: application/json\r\n' : ''}${headers}\r\n${body}`);
    });
  });
}

function beginPartialRequest(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let response = '';
    socket.on('data', chunk => { response += chunk.toString('latin1'); });
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.write(`POST /api/misses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
      resolve({ socket, response: () => response });
    });
  });
}

test('HTTP server bounds request bodies, keeps the event stream compatible, and drains on shutdown', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-http-transport-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...inherited,
      PORT: String(port),
      UNPROMPTED_CONFIG_DIR: path.join(directory, 'config'),
      UNPROMPTED_STATE_FILE: path.join(directory, 'state.json'),
      UNPROMPTED_ATTENTION_SWEEP_MS: '3600000',
      UNPROMPTED_HTTP_MAX_BODY_BYTES: '1024',
      UNPROMPTED_HTTP_BODY_TIMEOUT_MS: '2000',
      UNPROMPTED_HTTP_BODY_IDLE_TIMEOUT_MS: '500',
      UNPROMPTED_HTTP_SSE_HEARTBEAT_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
  });

  await waitForServer(child, () => logs, base);
  const state = await fetch(`${base}/api/state`).then(response => response.json());
  const stream = await fetch(`${base}/api/stream`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  const firstText = new TextDecoder().decode(first.value);
  const initialState = JSON.parse(firstText.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(typeof initialState.revision, 'number');
  assert.ok(Array.isArray(initialState.tasks));
  assert.ok(initialState.revision >= state.revision, 'the initial stream snapshot matches current public state');

  const tooLarge = await rawRequest(port, { headers: 'Content-Length: 2048\r\nConnection: keep-alive\r\n' });
  assert.match(tooLarge, /^HTTP\/1\.1 413/m);

  const idleBody = await rawRequest(port, {
    headers: 'Content-Length: 100\r\nConnection: keep-alive\r\n',
    body: '{'
  });
  assert.match(idleBody, /^HTTP\/1\.1 408/m);

  const malformedTarget = await rawRequest(port, {
    requestLine: 'GET http://[ HTTP/1.1',
    headers: 'Connection: close\r\n'
  });
  assert.match(malformedTarget, /^HTTP\/1\.1 400/m);
  assert.match(malformedTarget, /Invalid request target/);
  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'a malformed target does not leave the handler rejected or damage the server');

  const partialRequest = await beginPartialRequest(port);
  await new Promise(resolve => setTimeout(resolve, 50));
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  let exitTimer;
  const exitResult = await Promise.race([
    exit,
    new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error(`Server did not finish draining. Logs: ${logs}`)), 5000); })
  ]).finally(() => clearTimeout(exitTimer));
  assert.equal(exitResult.code, 0, `unexpected exit (${exitResult.signal}): ${logs}`);
  assert.match(partialRequest.response(), /^HTTP\/1\.1 408/m, 'shutdown waits for bounded body parsing to reject the stalled request');
  await reader.cancel().catch(() => {});
  partialRequest.socket.destroy();
});
