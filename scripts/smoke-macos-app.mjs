#!/usr/bin/env node
// Verify the unsigned local app bundle and launch its bundled Node runtime
// against an isolated simulation. This never contacts Google or uses user data.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(process.argv[2] || path.join(ROOT, 'outputs', 'Unprompted.app'));
const contents = path.join(appPath, 'Contents');
const resources = path.join(contents, 'Resources');
const appRoot = path.join(resources, 'app');
const nodePath = path.join(resources, 'runtime', 'node');
const verificationPath = path.join(resources, 'runtime', 'verification.json');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout || '';
}

assert.ok(fs.existsSync(path.join(contents, 'Info.plist')), 'Info.plist exists');
assert.ok(fs.existsSync(path.join(contents, 'MacOS', 'Unprompted')), 'launcher exists');
assert.ok(fs.existsSync(path.join(appRoot, 'server.js')), 'server source is included');
assert.ok(fs.existsSync(path.join(appRoot, 'public', 'index.html')), 'web UI is included');
const manifest = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
assert.equal(manifest.runtime, 'Node.js');
assert.equal(manifest.version, run(nodePath, ['--version']).trim());
assert.equal(manifest.bundledBinarySha256, sha256(nodePath), 'bundled runtime hash matches its build manifest');
assert.match(manifest.checksumSource, /^https:\/\/nodejs\.org\//);
assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/);
assert.ok(manifest.linkedLibraries.every(item => item.startsWith('/System/Library/') || item.startsWith('/usr/lib/')), 'runtime links only to system libraries');
assert.equal(manifest.packageLockIncluded, true, 'the lockfile is included in the local app');
if (manifest.sqliteRuntime) {
  const sqlite = JSON.parse(run(nodePath, ['--input-type=module', '-e', "import {DurableDatabase} from './src/durable/database.js';const d=new DurableDatabase(':memory:');console.log(JSON.stringify(d.describe()));d.close();"], { cwd: appRoot }).trim());
  assert.equal(sqlite.sqliteVersion, manifest.sqliteRuntime.sqliteVersion);
  assert.equal(sqlite.synchronous, 'FULL'); assert.equal(sqlite.ftsSecureDelete, true);
}
if (manifest.mcpClient?.available) run(nodePath, ['--input-type=module', '-e', "await Promise.all([import('@modelcontextprotocol/client'),import('@modelcontextprotocol/client/stdio')])"], { cwd: appRoot });
if (manifest.piHarness?.available) {
  assert.ok(fs.existsSync(path.join(appRoot, 'node_modules', '@earendil-works', 'pi-agent-core', 'package.json')));
  assert.ok(fs.existsSync(path.join(appRoot, 'node_modules', '@earendil-works', 'pi-ai', 'package.json')));
  run(nodePath, ['--input-type=module', '-e', "await Promise.all([import('@earendil-works/pi-agent-core'),import('@earendil-works/pi-ai'),import('@earendil-works/pi-ai/api/openai-completions')])"], { cwd: appRoot });
} else {
  assert.doesNotMatch(JSON.stringify(manifest.piHarness), /available.*true/);
}
run('/bin/bash', ['-n', path.join(contents, 'MacOS', 'Unprompted')]);
run('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprompted-app-smoke-'));
let port;
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GOOGLE_|UNPROMPTED_)/i.test(key)));
const child = spawn(path.join(contents, 'MacOS', 'Unprompted'), [], {
  cwd: appRoot,
  env: {
    ...inheritedEnv,
    PORT: '',
    UNPROMPTED_NO_OPEN: '1',
    UNPROMPTED_CONFIG_DIR: path.join(tempDir, 'config'),
    UNPROMPTED_STATE_FILE: path.join(tempDir, 'state.json'),
    UNPROMPTED_FORCE_SIMULATION: 'true',
    UNPROMPTED_ATTENTION_SWEEP_MS: '3600000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', chunk => { log += chunk.toString(); });
child.stderr.on('data', chunk => { log += chunk.toString(); });

try {
  let health = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Bundled server exited early (${child.exitCode}): ${log}`);
    const serverLog = path.join(tempDir, 'config', 'server.log');
    if (fs.existsSync(serverLog)) port = Number(fs.readFileSync(serverLog, 'utf8').match(/Unprompted listening at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* wait for the local listener */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(health, `bundled server did not become ready: ${log}`);
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'simulation');
  assert.equal(health.eventSource, 'simulated');
  assert.equal(health.shadow, false, 'first-run local simulation must allow its simulated approval');
  const [pageResponse, setupResponse, stateResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/api/setup`),
    fetch(`http://127.0.0.1:${port}/api/state`)
  ]);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /setupContent/);
  assert.match(page, /sharedDependencySection/);
  assert.match(page, /followUpContent/);
  const setup = await setupResponse.json();
  const state = await stateResponse.json();
  assert.equal(setup.monitoring.enabled, false);
  assert.equal(setup.google.hasRefreshToken, false);
  assert.equal(setup.google.allowExternalWrites, false);
  assert.equal(state.events.length, 0, 'the actual app launcher waits for its first viewer');
  assert.doesNotMatch(JSON.stringify(setup), /private-desktop-secret|oauth-refresh-secret/);
  assert.doesNotMatch(JSON.stringify(state), /private-desktop-secret|oauth-refresh-secret/);
  const base = `http://127.0.0.1:${port}`;
  const runtime = await (await fetch(base + '/api/runtime')).json();
  assert.equal(runtime.demo.enabled, true);
  assert.equal(runtime.demo.disposable, false);
  const controller = new AbortController();
  const stream = await fetch(base + '/api/stream', { signal: controller.signal });
  await stream.body.getReader().read(); controller.abort();
  let ready;
  const storyDeadline = Date.now() + 25_000;
  while (Date.now() < storyDeadline) {
    ready = await (await fetch(base + '/api/state')).json();
    if (ready.tasks.some(task => task.status === 'ready_for_approval')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const task = ready.tasks.find(task => task.status === 'ready_for_approval');
  assert.ok(task, 'the app prepares a source-backed reply');
  assert.equal(ready.outbox.length, 0);
  const approved = await fetch(`${base}/api/tasks/${encodeURIComponent(task.id)}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewToken: task.reviewToken })
  });
  assert.equal(approved.status, 200);
  const completed = await (await fetch(base + '/api/state')).json();
  assert.equal(completed.tasks[0].action.status, 'verified_simulated');
  assert.equal(completed.outbox.length, 1);
  const afterSetup = await (await fetch(base + '/api/setup')).json();
  assert.equal(afterSetup.google.allowExternalWrites, false, 'a simulated approval must not grant future real writes');
  console.log(`macOS app smoke passed (${manifest.version}, ${manifest.architecture}); actual launcher, automatic port, first-view start and verified simulated delivery passed. No browser opened and no user setup was used.`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode != null) return resolve();
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
}
