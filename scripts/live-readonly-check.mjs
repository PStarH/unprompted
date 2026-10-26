#!/usr/bin/env node
// Explicitly invoked live-read check. Never load saved accounts or model settings.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readonlyValidationEnv, snapshotSource, sourceUnchanged, isReadonlyValidationRuntime } from '../src/readonly-validation.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runLiveReadonlyCheck({ root = repository, source = path.join(root, 'data', 'shadow-state.json'),
  serverPath = path.join(root, 'server.js'), env = process.env, startupTimeoutMs = 15_000 } = {}) {
  if (!fs.existsSync(source)) return { status: 'skipped', reason: 'No recorded state was supplied; no service was contacted.' };
  if (!['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].every(key => typeof env[key] === 'string' && env[key].trim())) {
    return { status: 'skipped', reason: 'Explicit read credentials are missing; no saved account was accessed.' };
  }
  const before = snapshotSource(source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-readonly-check-'));
  const stateFile = path.join(directory, 'state.json');
  let child, spawnError, report;
  try {
    fs.writeFileSync(stateFile, before.bytes, { mode: 0o600, flag: 'wx' });
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, [serverPath], { cwd: root, env: readonlyValidationEnv(env, {
      port, stateFile, setupDirectory: path.join(directory, 'setup')
    }), stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { spawnError = error; });
    // Consume diagnostics without printing account details, API responses or source content.
    child.stdout.resume(); child.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    const get = async route => {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('API_UNAVAILABLE');
      return response.json();
    };
    let health;
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('STARTUP_FAILED');
      try { health = await get('/api/health'); break; } catch { /* listener not ready */ }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    if (!health) throw new Error('STARTUP_TIMEOUT');
    const runtime = await get('/api/runtime');
    if (!isReadonlyValidationRuntime(health, runtime)) throw new Error('READONLY_RUNTIME_MISMATCH');
    const stateBefore = await get('/api/state');
    const response = await fetch(base + '/api/connectors/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(180_000)
    });
    const sync = await response.json();
    const stateAfter = await get('/api/state');
    const outboxUnchanged = JSON.stringify(stateBefore.outbox || []) === JSON.stringify(stateAfter.outbox || []);
    const results = Array.isArray(sync.results) ? sync.results : [];
    const syncPassed = response.ok && !sync.skipped && results.length > 0 && results.every(item =>
      typeof item.connector === 'string' && item.failed === false && item.partial === false);
    report = {
      status: syncPassed && outboxUnchanged ? 'passed' : 'failed', mode: 'live_read_only_copy',
      protocol: { shadow: true, automaticObservation: false, remoteReasoning: false, localOutboxUnchanged: outboxUnchanged },
      sync: { ok: syncPassed, connectors: results.length, failed: results.filter(item => item.failed).length, partial: results.filter(item => item.partial).length },
      observed: { eventsBefore: (stateBefore.events || []).length, eventsAfter: (stateAfter.events || []).length,
        tasksBefore: Object.keys(stateBefore.tasks || {}).length, tasksAfter: Object.keys(stateAfter.tasks || {}).length },
      realUserValue: 'not_measured'
    };
  } catch (error) {
    const known = new Set(['STARTUP_FAILED', 'STARTUP_TIMEOUT', 'READONLY_RUNTIME_MISMATCH', 'API_UNAVAILABLE']);
    report = { status: 'failed', reason: known.has(error.message) ? error.message : 'READONLY_CHECK_FAILED', realUserValue: 'not_measured' };
  } finally {
    if (child && !spawnError && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  report.originalFileUntouched = sourceUnchanged(source, before);
  if (!report.originalFileUntouched) { report.status = 'failed'; report.reason = 'SOURCE_CHANGED'; }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--state')) {
    console.error('Usage: node scripts/live-readonly-check.mjs [--state PRIVATE_STATE.json]');
    process.exitCode = 2;
  } else {
    try {
      const report = await runLiveReadonlyCheck(args.length ? { source: path.resolve(args[1]) } : {});
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === 'failed' ? 1 : 0;
    } catch { console.error('Read-only check could not start. No source content is printed.'); process.exitCode = 1; }
  }
}
