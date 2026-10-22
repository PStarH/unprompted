#!/usr/bin/env node
/**
 * Narrow live read-only check.
 *
 * Runs the real server against a COPY of the shadow state, with the real Google
 * credentials from .env, and performs exactly one incremental connector sync.
 * It never writes to data/shadow-state.json and never sends anything.
 *
 * Prints: mode, eventSource, mailProvider, sync result, outbox count.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'data', 'shadow-state.json');
if (!fs.existsSync(source)) {
  console.log(JSON.stringify({ skipped: 'no shadow state to copy' }));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-live-'));
const stateFile = path.join(dir, 'shadow-copy.json');
fs.copyFileSync(source, stateFile);
const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const port = 25123;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), UNPROMPTED_STATE_FILE: stateFile, UNPROMPTED_SYNC_INTERVAL_MS: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

const base = `http://127.0.0.1:${port}`;
const get = async p => (await fetch(base + p)).json();
const post = async (p, body = {}) => {
  const response = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try { ready = (await fetch(base + '/api/health')).ok; } catch { /* not yet */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error('server did not start');

  const health = await get('/api/health');
  const runtime = await get('/api/runtime');
  const stateBefore = await get('/api/state');

  const started = Date.now();
  const sync = await post('/api/connectors/sync');
  const syncMs = Date.now() - started;

  const stateAfter = await get('/api/state');

  console.log(JSON.stringify({
    health: { mode: health.mode, mailProvider: health.mailProvider, schemaVersion: health.schemaVersion },
    runtime: {
      mode: runtime.mode,
      eventSource: runtime.eventSource ?? null,
      mailProvider: runtime.mailProvider,
      google: runtime.google?.ok ?? null,
      sendEnabled: runtime.google?.sendEnabled ?? null,
      pendingConfiguration: runtime.pendingConfiguration ?? [],
      simulationRunning: runtime.simulationRunning
    },
    sync: { ms: syncMs, status: sync.status, results: sync.body?.results ?? sync.body, skipped: sync.body?.skipped ?? null },
    events: { before: stateBefore.events.length, after: stateAfter.events.length },
    tasks: { before: stateBefore.tasks.length, after: stateAfter.tasks.length },
    outbox: stateAfter.outbox.length,
    originalFileUntouched: fs.readFileSync(source, 'utf8') === JSON.stringify(before, null, 2) + '\n'
      || fs.statSync(source).mtimeMs === fs.statSync(source).mtimeMs
  }, null, 2));
  console.log('server said:', output.split('\n').filter(Boolean).slice(0, 5).join(' | '));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, serverOutput: output.split('\n').slice(0, 8) }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
}
