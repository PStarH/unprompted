import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseDemoPort } from '../scripts/demo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'scripts/demo.mjs');
const reserve = async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  return listener;
};

test('demo finds another default port and gives an actionable error for an occupied explicit port', async () => {
  const listener = await reserve();
  try {
    const preferred = listener.address().port;
    if (preferred < 65535) assert.ok(await chooseDemoPort(preferred) > preferred);
    await assert.rejects(chooseDemoPort(preferred, { strict: true }), /Try: npm run demo -- --port/);
    const result = spawnSync(process.execPath, [launcher, '--port', String(preferred), '--no-open'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unavailable/);
    assert.doesNotMatch(result.stderr, /at .*\.mjs:/);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('demo help and invalid options need no server or installed packages', () => {
  const help = spawnSync(process.execPath, [launcher, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /Starts when you open/);
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port'], ['--unknown']]) {
    const result = spawnSync(process.execPath, [launcher, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
  }
});

test('the real demo launcher ignores inherited accounts, waits for a viewer, and stops cleanly', { timeout: 20_000 }, async () => {
  const listener = await reserve();
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [launcher, '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, GOOGLE_CLIENT_ID: 'invented-client', GOOGLE_CLIENT_SECRET: 'invented-secret',
      GOOGLE_REFRESH_TOKEN: 'invented-token', GOOGLE_SEND_ENABLED: 'true', UNPROMPTED_SHADOW_MODE: 'true',
      UNPROMPTED_FORCE_SIMULATION: 'false' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 12_000;
    while (!output.includes('Ready →') && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /Ready →/, output);
    const base = `http://127.0.0.1:${port}`;
    const runtime = await (await fetch(base + '/api/runtime')).json();
    assert.equal(runtime.demo.enabled, true); assert.equal(runtime.mode, 'simulation');
    assert.equal(runtime.mailProvider, 'simulated'); assert.equal(runtime.shadow, false);
    await new Promise(resolve => setTimeout(resolve, 2600));
    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.events.length, 0, 'Reading the terminal or probing health must not consume the demo.');
    assert.equal(state.tasks.length, 0);
    const controller = new AbortController();
    const stream = await fetch(base + '/api/stream', { signal: controller.signal });
    const reader = stream.body.getReader(); await reader.read(); controller.abort();
    await new Promise(resolve => setTimeout(resolve, 2600));
    const observed = await (await fetch(base + '/api/state')).json();
    assert.equal(observed.tasks.length, 1); assert.equal(observed.outbox.length, 0);
    assert.ok(observed.events.every(item => item.source === 'simulated'));
  } finally {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    const result = await exited; clearTimeout(timeout);
    assert.equal(result.code, 0, output);
  }
});

test('the contributor example withholds action by default and verifies one approved simulated action', () => {
  for (const args of [[], ['--approve']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'examples/first-workflow.mjs'), ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Partial evidence arrived → it kept waiting/);
    assert.match(result.stdout, args.length ? /one receipt verified; duplicate event caused no resend/ : /zero sends/);
  }
});
